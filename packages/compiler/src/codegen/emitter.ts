/* C emitter core state. Methods live in the family modules and are installed on the
 * prototype by `install.ts` before the first `emit()` (T24 split). */

import type {
  ArrayLength,
  ArrayLiteral,
  ArrayOp,
  AwaitExpr,
  BinaryOp,
  Block,
  ClassDeclaration,
  ClassMethod,
  ConditionalExpr,
  ConsoleLogCall,
  DeleteProp,
  DynFieldAccess,
  DynFieldAssignment,
  EnvCapture,
  Expression,
  ExternAbiKind,
  ExternCall,
  FieldAssignment,
  ForOfStatement,
  FunctionExpr,
  GetIterator,
  IndexAccess,
  IndexAssignment,
  LogicalOp,
  MethodCall,
  MethodValue,
  Module,
  ObjectLiteral,
  OptionalChain,
  Span,
  Statement,
  SwitchStatement,
  TemplateLiteral,
  TryStatement,
  UnaryOp,
  UpdateExpr,
  VtableEntry,
  YieldExpr,
} from '../hir/nodes.ts';
import type { HType } from '../hir/types.ts';
import type { ExportedFunction } from '../frontend/export.ts';
import type { CallSlotted, FunctionUnit, LibraryEmit, TryFinallyScope } from './types.ts';

export class Emitter {
  lines: string[] = [];
  indent: number = 0;
  slotMap: Map<string, number> = new Map();
  /** Frame slot holding each short-circuit operator's left operand. Keyed by node identity, since
   * two `&&`s in one expression must not share a slot: the outer one's value stays live while the
   * inner one is being evaluated. */
  tempSlots: Map<
    | ArrayLength
    | AwaitExpr
    | LogicalOp
    | YieldExpr
    | ConditionalExpr
    | UpdateExpr
    | DynFieldAccess
    | GetIterator
    | OptionalChain
    | UnaryOp,
    number
  > = new Map();
  /* The guarded base each open `optional-chain` holds in its frame temp, innermost last. An
   * `optional-base` leaf resolves to the top: emission of a consequent always runs inside its
   * chain's push, so a leaf names the temp whose nullish test admitted this branch. Pushed and
   * popped synchronously around the consequent's capture, like `capture`'s own line buffer. */
  optionalBaseStack: string[] = [];
  /* C does not specify which operand of an operator or function call it evaluates first. Every
   * BinaryOp therefore gets two rooted slots: emitting `left` into the first before `right` into
   * the second makes the JavaScript left-to-right rule explicit, and preserves the left value if
   * evaluating the right allocates. */
  binarySlots: Map<BinaryOp, number> = new Map();
  /* A template evaluates and stringifies substitutions from left to right too. Its parts occupy a
   * contiguous run; slot zero is reused for each concatenation result so that intermediate strings
   * remain rooted across the next allocation. */
  templateSlots: Map<TemplateLiteral, { readonly base: number; readonly count: number }> =
    new Map();
  /* The switch discriminant's slot: evaluated once, then compared against every clause. */
  switchSlots: Map<SwitchStatement, number> = new Map();
  /* Frame slot holding a call's callee and its arguments: 1 + argc CONTIGUOUS slots, so `argv` can
   * point at the first argument and every already-evaluated operand stays rooted while the rest are
   * evaluated. Keyed by node identity, like the other temporaries. */
  callSlots = new Map<CallSlotted, number>();

  /* Every class declared anywhere in the file, in the order counting reached them. The index is
   * the descriptor's C identity (`_jsrt_class_N`), and the name is how NewExpr and MethodCall --
   * which carry a class NAME, not a pointer -- find their way back to it. */
  /** Inline-cache sites allocated so far -- one static JSRTIC per dynamic property SITE
   * (docs/VALUE.md §4.10), declared at file scope with the class descriptors. Reset per emit. */
  icCount = 0;

  /* Extern C declarations the module calls (docs/FFI.md §1, plan.md §10 Task 7.1 step 5): one
   * forward declaration per C symbol, derived from the node's own kinds at counting time — so
   * the emitted prototype cannot drift from the call it serves. Step 7 (headers, link flags)
   * owns the day a symbol needs more than a prototype; until then a declaration is exact and
   * needs nothing else. `externErrno`/`externStdlib` pull in `<errno.h>`/`<stdlib.h>` only when
   * a call in the module needs them, so an extern-free program's prologue is byte-identical. */
  externDecls: Map<string, string> = new Map();
  externErrno: boolean = false;
  externStdlib: boolean = false;
  /* `#include` headers the module's extern calls compile under (docs/FFI.md §9), in
   * first-seen call order, deduplicated. Recorded per NODE at counting time like the errno
   * flag, so the prologue — emitted before any unit — already knows every one. */
  externHeaders: string[] = [];
  /* C symbols a binding header declares (docs/FFI.md §9): no forward declaration is emitted
   * for these, however the headerless and header-carrying calls interleave at counting time. */
  externHeaderCovered: Set<string> = new Set();

  classes: ClassDeclaration[] = [];
  classIds: Map<string, number> = new Map();
  /** Class id -> enumeration order, present only for a literal whose keys are not in slot order. */
  classKeyOrders: Map<number, number[]> = new Map();
  /** Shape name -> (method name -> hidden instance slot) for object literals with methods
   * (plan.md §8 step 36). A literal's methods ride in hidden trailing slots, bound per evaluation,
   * so a direct call loads the instance's closure instead of rebuilding one over the caller's
   * environment. Keyed by shape name rather than descriptor: every literal of one shape lays the
   * same methods out in the same order, so the indices agree however many descriptors (key orders)
   * the shape has. Classes never appear here -- their instances carry no per-evaluation state. */
  classHiddenMethods: Map<string, ReadonlyMap<string, number>> = new Map();
  /* An array literal's elements occupy a contiguous run, for the same reason a call's arguments do:
   * `jsrt_array_new` takes a pointer to the first, and every element already evaluated must stay
   * rooted while the rest are evaluated -- the allocation inside `jsrt_array_new` itself can
   * collect. */
  arraySlots: Map<ArrayLiteral, number> = new Map();
  /* Two slots for a read (`target`, `index`), three for a write (`target`, `index`, `value`).
   * Same unspecified-order argument as binarySlots: `jsrt_array_get(a(), i())` would let C run
   * `i()` first, and a collection during `i()` could free the array `a()` just produced. */
  indexSlots: Map<
    DeleteProp | DynFieldAssignment | FieldAssignment | IndexAccess | IndexAssignment | UpdateExpr,
    number
  > = new Map();
  /* The for-of iterable's slot. Evaluated ONCE -- `for (const x of f())` calls `f` once -- and the
   * array has to stay rooted for the whole loop, since the body can allocate on every iteration. */
  forOfSlots: Map<ForOfStatement, number> = new Map();
  /* A boxed for-of's cleanup triple (plan.md §8 step 34): the iterator copy the fin closes,
   * the stashed exception the throw path waits in while the close runs, and the completion
   * code as a boxed number. All three must outlive a suspension -- a yield/await in the body
   * pops the C frame, and the resume's goto jumps over whatever initializer a local would
   * have had -- so they are counted slots, never C locals. */
  forOfCloseSlots: Map<ForOfStatement, number> = new Map();
  slotCount: number = 0;

  /* Module-level bindings, which are NOT in any function's frame: a function body may read one, and
   * main's stack frame does not outlive the call. They live in the file-static globals array, so
   * `slotMap`/`slotCount` above always describe the unit being emitted and these describe the
   * module. While the module itself is being emitted the two are the same map. */
  globalMap: Map<string, number> = new Map();
  globalCount: number = 0;
  inFunction: boolean = false;

  /* Captured-variable state for the unit being emitted (docs/VALUE.md §4.3). `envMap` holds this
   * function's OWN captured bindings, which live in its heap environment instead of its frame --
   * so a name in here must never also get a frame slot. `captureMap` holds the ones it reads from
   * enclosing environments, already resolved to (levels, index) by capture analysis. */
  envMap: Map<string, number> = new Map();
  captureMap: Map<string, EnvCapture> = new Map();
  /* Where `return e;` parks its value: the expression is evaluated into a rooted slot while the
   * frame is still live, and only then is the frame popped. One slot per function is enough --
   * returns do not nest. */
  returnSlot: number = 0;
  /* Set while counting, read once counting is done: whether this unit has a `return <expr>` at
   * all, and therefore whether `returnSlot` is a slot or a number nothing reads. */
  returnsValue: boolean = false;
  /* Async/generator state for the unit being emitted. `inAsync`/`inGenerator` switch `slotAt`
   * over to the heap environment: locals must survive a suspension, and a suspension pops the
   * C frame. `awaitStates` numbers each suspension point (await or yield), assigned while COUNTING
   * because the resume function's dispatch switch is emitted before the body whose labels it
   * jumps to. The two flags are mutually exclusive in this landing. */
  inAsync: boolean = false;
  /** The module body is an async unit: named bindings stay in `globalMap`, temps go to the
   * heap environment. Distinct from `inAsync` on a function, which puts names in the env too. */
  moduleAsync: boolean = false;
  inGenerator: boolean = false;
  awaitStates: Map<AwaitExpr | YieldExpr, number> = new Map();
  /* Whether anything in the module suspended or promised. `main` drains the microtask queue only
   * then -- a program that never promises should not link the driver in at all. */
  usedAsync: boolean = false;
  /* Every function reachable from the module, in emission order. It GROWS while it is walked: a
   * nested function is only discovered when its parent's body is counted. */
  functions: FunctionUnit[] = [];
  functionIds: Map<FunctionExpr, number> = new Map();

  fileName: string = '';

  /* Loops and switches currently open, innermost last -- the emitter's mirror of the verifier's
   * Enclosing stack, carrying the id that names this construct's C labels. */
  enclosing: { id: number; label?: string; isLoop: boolean; iterEnv?: boolean }[] = [];

  /* A per-iteration loop's SUSPENSION STATE, as two frame slots claimed while counting (plan-notes
   * 226): the environment the loop clones from and the clone the current iteration holds. They used
   * to be C locals declared inside the loop body, which an `await`/`yield` inside that body cannot
   * survive -- the frame is popped at the suspension and the resume `goto` jumps PAST the
   * initializers, leaving both indeterminate (measured: `brk #1` from clang at -O2, plan.md §8
   * step 15). A slot is storage the unit already keeps alive across a suspension: for an
   * async/generator unit `slotAt` resolves to the heap environment, for a sync one to the frame,
   * and the same code serves both. The slot holds a RAW `JSRTEnv *`, which is deliberate and safe:
   * the collector's mark procedure masks every word and marks what it finds, so a pointer in a slot
   * is traced; only a NaN-boxed VALUE would be invisible.
   *
   * Keyed by the loop statement while counting and by the loop id while emitting, because the id is
   * minted at emission time and the slots have to exist before it. */
  iterEnvSlots = new Map<Statement, number>();
  iterEnvBase = new Map<number, number>();
  loopCount: number = 0;
  /* Spread-order C locals (`_jsrt_order_N`) minted while emitting, reset per module with the
   * rest of the emission state: the declaration opens lazily inside the literal's own
   * statements, so the number only has to be unique within one emission. */
  spreadOrderCount: number = 0;
  /* Extern-call sites minted while emitting: the suffix of each site's C temporaries
   * (`_jsrt_exr_N`, `_jsrt_exc_N_i`, `_jsrt_exe_N`). Not the slot base — an inlined body emits
   * the same node, hence the same base, once per call site in one C scope. */
  externSiteCount: number = 0;
  /* Labels a `goto` actually targets. C warns on a label nothing jumps to, and the runtime builds
   * with -Wall -Wextra -Werror, so an unconditional `brk_N:` after every loop would turn a plain
   * `while` into a build failure. Every jump is emitted before its target line, so consulting this
   * at emission time is enough -- no second pass over the output. */
  usedLabels: Set<string> = new Set();

  /* Where a pending exception unwinds to, innermost try's landing pad last. Empty means the
   * unit's own `_jsrt_unwind` tail: pop the frame and return (functions) or report the exception
   * as uncaught and exit (main). */
  padStack: string[] = [];
  unwindUsed = false;
  /* Open try/finally constructs, innermost last -- see TryFinallyScope. */
  tryFinallyStack: TryFinallyScope[] = [];
  tryCount = 0;
  /* The rooted slot a try-with-finally stashes a caught exception in: the pending cell empties
   * before the finally body runs (the body may itself throw, and its exception must overwrite,
   * not collide), so the taken value needs a frame slot the GC can see until the dispatch
   * rethrows it. */
  trySlots: Map<TryStatement, number> = new Map();

  declare emit: (module: Module, library?: LibraryEmit) => string;
  declare emitModuleEnv: (module: Module) => void;
  declare emitSyncTopLevelStatements: (module: Module) => void;
  declare emitMicrotaskDrain: (module: Module) => void;
  declare emitMain: (module: Module, globalSlots: number) => string[];
  declare emitMainEntry: (module: Module, globalSlots: number) => void;
  declare emitAsyncModule: (module: Module, globalSlots: number) => void;
  declare countAsyncModule: (module: Module) => number;
  declare emitModuleDoneMain: () => void;
  declare emitAsyncModuleForward: () => void;
  declare emitAsyncModuleBody: (module: Module) => void;
  declare emitLibrary: (
    module: Module,
    library: LibraryEmit,
    globalSlots: number,
    scratch: number,
  ) => string[];
  declare emitExportConstDefs: (library: LibraryEmit) => void;
  declare emitErrorCell: (library: LibraryEmit) => void;
  declare emitExportConstStores: (library: LibraryEmit, span: Span) => void;
  declare exportSlot: (kind: string, name: string) => number;
  declare emitInitOpen: (unit: string, span: Span, globalSlots: number) => void;
  declare emitLibraryInitSync: (
    module: Module,
    library: LibraryEmit,
    globalSlots: number,
    scratch: number,
  ) => void;
  declare emitInitDone: (scratch: number) => void;
  declare emitAsyncModuleRun: (module: Module, envSlots: number, onDone: string) => void;
  declare emitLibraryInitAsync: (
    module: Module,
    library: LibraryEmit,
    globalSlots: number,
    envSlots: number,
    scratch: number,
  ) => void;
  declare emitExportStub: (
    library: LibraryEmit,
    fn: ExportedFunction,
    scratch: number,
    span: Span,
  ) => void;
  declare exportArg: (cType: string, name: string) => string;
  declare exportRet: (cType: string, slot: number, scratch: number) => string;
  declare exportSentinel: (cType: string) => string;
  declare emitFunctionUnits: () => string[];
  declare emitFunctionUnit: (unit: FunctionUnit) => string[];
  declare emitScope: (statements: readonly Statement[]) => void;
  declare emitNamedFunctionSelfBinding: (fn: FunctionExpr) => void;
  declare emitHoistedFunctions: (statements: readonly Statement[]) => void;
  declare registerFunction: (fn: FunctionExpr, name: string) => number;
  declare functionId: (fn: FunctionExpr) => number;
  declare bindSlot: (name: string) => void;
  declare countBindings: (statements: readonly Statement[]) => void;
  declare spreadSource: (
    parts: string[],
    key: string,
    scratchAt: ReadonlyMap<string, number>,
    scratchTarget: ReadonlyMap<string, Expression>,
    scratchDone: Set<string>,
    span: Span,
    flushed: boolean,
  ) => { readonly slot: string | null; readonly flushed: boolean };
  declare countEntryValue: (
    value: Expression,
    spreadKeys: ReadonlySet<string>,
    countedSpread: Set<string>,
  ) => void;
  declare countRooted: (
    expr: CallSlotted,
    lead: Expression | undefined,
    args: readonly Expression[],
  ) => void;
  declare countExpression: (expr: Expression) => void;
  declare emitStatement: (stmt: Statement) => void;
  declare emitMapSetForOf: (stmt: ForOfStatement, iterable: string, id: number) => void;
  declare emitArrayForOfYield: (stmt: ForOfStatement, iterable: string, cursor: string) => void;
  declare emitMapSetForOfYield: (stmt: ForOfStatement, key: string, val: string) => void;
  declare forOfIsBoxed: (stmt: ForOfStatement) => boolean;
  declare emitBoxedIteratorForOf: (stmt: ForOfStatement, iterable: string, id: number) => void;
  declare enterLoop: (stmt: { label?: string; perIterationEnv?: true }) => number;
  declare countIterEnvSlots: (stmt: Statement) => void;
  declare enterBreakable: (label: string) => number;
  declare iterEnvOf: (id: number) => boolean;
  declare frameEnvLine: (env: string) => string;
  declare iterEnvState: (id: number) => { saved: string; iter: string };
  declare emitIterEnvOpen: (id: number, span: Span) => void;
  declare emitIterEnvEnter: (id: number, span: Span) => void;
  declare emitIterEnvCommit: (id: number, span: Span) => void;
  declare emitIterEnvClose: (_id: number, _span: Span) => void;
  declare commitIterEnvs: (fromIndexInclusive: number, span: Span) => void;
  declare emitJumpTarget: (name: string, span: Span) => void;
  declare currentPad: () => string;
  declare emitFieldWrite: (
    stmt: FieldAssignment | DynFieldAssignment,
    write: (target: string, value: string) => string,
    missing: string,
  ) => void;
  declare emitPendingCheck: (span: Span) => void;
  declare capture: (f: () => string) => { readonly lines: string[]; readonly value: string };
  declare sequencePart: (
    parts: string[],
    operand: Expression,
    span: Span,
    use: (value: string) => string,
  ) => boolean;
  declare flushParts: (parts: string[], span: Span) => void;
  declare arrayOpCall: (expr: ArrayOp, base: number) => string;
  declare sequenceArgs: (
    parts: string[],
    args: readonly Expression[],
    span: Span,
    base: number,
    start: number,
  ) => boolean;
  declare finishSequenced: (
    parts: string[],
    result: string,
    span: Span,
    flushed: boolean,
  ) => string;
  declare beginCall: (
    parts: string[],
    first: Expression,
    args: readonly Expression[],
    span: Span,
    base: number,
  ) => void;
  declare finishOp: (
    parts: string[],
    base: number,
    opCall: string,
    span: Span,
    flushed: boolean,
    canThrow: boolean,
  ) => string;
  declare finishStatement: (
    parts: string[],
    assignment: string,
    result: string,
    span: Span,
  ) => string;
  declare emitExternCall: (expr: ExternCall, base: number) => string;
  declare emitLoopJump: (name: string, targetIndex: number, span: Span) => void;
  declare emitReturnJump: (span: Span) => void;
  declare routeJump: (scope: TryFinallyScope, key: string, span: Span, action: () => void) => void;
  declare emitTry: (stmt: TryStatement) => void;
  declare emitTryCatch: (stmt: TryStatement, id: number) => void;
  declare emitTryFinally: (stmt: TryStatement, finallyBlock: Block, id: number) => void;
  declare emitCatchEntry: (stmt: TryStatement) => void;
  declare emitSwitch: (stmt: SwitchStatement) => void;
  declare consoleSlots: (expr: ConsoleLogCall) => number;
  declare consoleCall: (expr: ConsoleLogCall) => string;
  declare emitExpression: (expr: Expression) => string;
  declare emitSyncUnit: (unit: FunctionUnit) => void;
  declare emitAsyncUnit: (unit: FunctionUnit) => void;
  declare emitGeneratorUnit: (unit: FunctionUnit) => void;
  declare emitSuspendEntry: (unit: FunctionUnit, produce: string) => void;
  declare emitResumeOpen: (span: Span, unusedWhenEmpty: readonly string[]) => void;
  declare emitResumeBody: (fn: FunctionExpr) => void;
  declare suspendSlot: (expr: AwaitExpr | YieldExpr) => string;
  declare emitPark: (expr: AwaitExpr | YieldExpr, parkCall: string) => string;
  declare emitAsyncSettle: (fn: string, value: string, span: Span) => void;
  declare emitGeneratorSettle: (value: string, span: Span) => void;
  declare emitParameterPrologue: (fn: FunctionExpr) => void;
  declare icSite: () => string;
  declare callLocation: (span: Span) => string;
  declare externCType: (kind: ExternAbiKind) => string;
  declare externCReturnType: (kind: ExternAbiKind) => string;
  declare recordExternDecl: (expr: ExternCall) => void;
  declare registerShape: (expr: ObjectLiteral) => void;
  declare methodOf: (expr: MethodCall | MethodValue) => ClassMethod;
  declare methodCallee: (expr: MethodCall, receiver: string) => string;
  declare methodIdOrNull: (entry: VtableEntry) => number | null;
  declare baseDescriptor: (cls: ClassDeclaration, id: number) => string;
  declare classAt: (name: string) => ClassDeclaration;
  declare emitTemplateLiteral: (expr: TemplateLiteral) => string;
  declare emitToNumber: (slot: string, type: HType, span: Span) => void;
  declare emitBinaryOp: (expr: BinaryOp) => string;
  declare emitStringLiteral: (value: string) => string;
  declare emitLogicalOp: (expr: LogicalOp) => string;
  declare emitConditional: (expr: ConditionalExpr) => string;
  declare emitOptionalChain: (expr: OptionalChain) => string;
  declare emitOptionalBase: () => string;
  declare emitUpdate: (expr: UpdateExpr) => string;
  declare slotAt: (slot: number) => string;
  declare slotRef: (name: string) => string;
  declare currentEnv: () => string;
  declare closureValue: (fn: FunctionExpr) => string;
  declare appendLine: (line: string, span?: Span) => void;
  declare escapeCString: (text: string) => string;
}
