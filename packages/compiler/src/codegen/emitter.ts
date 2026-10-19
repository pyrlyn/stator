/* Emitter state and the `emit` driver. Family logic lives in the sibling modules.
 * `emit` calls those functions with `this`; they call each other with `self`.
 * Fields are visible to those modules: a `private` field is not reachable from
 * another file, and the modules are the implementation of this class.
 */

import type {
  ArrayLength,
  ArrayLiteral,
  AwaitExpr,
  BinaryOp,
  ClassDeclaration,
  ConditionalExpr,
  DeleteProp,
  DynFieldAccess,
  DynFieldAssignment,
  EnvCapture,
  FieldAssignment,
  ForOfStatement,
  FunctionExpr,
  GetIterator,
  IndexAccess,
  IndexAssignment,
  LogicalOp,
  Module,
  OptionalChain,
  Statement,
  SwitchStatement,
  TemplateLiteral,
  TryStatement,
  UnaryOp,
  UpdateExpr,
  YieldExpr,
} from '../hir/nodes.ts';
import {
  cNameLiteral,
  closureMeta,
  descriptorName,
  type CallSlotted,
  type FunctionUnit,
  type TryFinallyScope,
} from './support.ts';
import type { LibraryEmit } from './library.ts';

import * as cgClass from './classes.ts';
import * as cgClosure from './closures.ts';
import * as cgDriver from './module.ts';
import * as cgLibrary from './library.ts';
import * as cgSeq from './sequence.ts';

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

  emit(module: Module, library?: LibraryEmit): string {
    this.fileName = module.fileName;
    this.slotMap = new Map();
    this.tempSlots.clear();
    this.binarySlots.clear();
    this.templateSlots.clear();
    this.switchSlots.clear();
    this.callSlots.clear();
    this.classes = [];
    this.classIds.clear();
    this.classHiddenMethods.clear();
    this.slotCount = 0;
    this.globalMap = new Map();
    this.globalCount = 0;
    this.inFunction = false;
    this.moduleAsync = false;
    this.envMap = new Map();
    this.captureMap = new Map();
    this.returnSlot = 0;
    this.functions = [];
    this.functionIds.clear();
    this.externDecls.clear();
    this.externErrno = false;
    this.externStdlib = false;
    this.externHeaders = [];
    this.externHeaderCovered.clear();
    this.enclosing = [];
    this.loopCount = 0;
    this.spreadOrderCount = 0;
    this.externSiteCount = 0;
    this.usedLabels.clear();
    this.padStack = [];
    this.unwindUsed = false;
    this.tryFinallyStack = [];
    this.tryCount = 0;
    this.trySlots.clear();
    this.lines = [];
    this.indent = 0;

    // Seeded BEFORE counting, because `bindSlot` skips a name that already has an environment
    // home: a per-iteration top-level binding must not also get a global slot, or the loop would
    // update one copy while every closure read the other.
    this.envMap = new Map(module.envVars.map((name, index) => [name, index]));
    // The module's own bindings are counted first and become the globals; counting also assigns
    // every function its id, which the closure references below depend on.
    cgSeq.countBindings(this, module.statements);
    this.globalMap = this.slotMap;
    this.globalCount = this.slotCount;
    // A library build roots one scratch global past the module's own bindings (steps 3–5):
    // the init error stash and every `jsrt_value`-returning stub's last result share it —
    // init runs once before any stub, so the two uses never overlap. It starts UNDEFINED,
    // a valid non-pointer value, so the collector never reads garbage through it.
    const exportScratch = library === undefined ? 0 : this.globalCount;
    // A zero-length array is not valid C11, and a program with no module-level binding is.
    const globalSlots = Math.max(this.globalCount + (library === undefined ? 0 : 1), 1);

    const functionLines = cgClosure.emitFunctionUnits(this);
    const mainLines =
      library === undefined
        ? cgDriver.emitMain(this, module, globalSlots)
        : cgLibrary.emitLibrary(this, module, library, globalSlots, exportScratch);

    const out: string[] = ['#include "jsrt_value.h"'];
    // The extern prologue, if the module called out (docs/FFI.md §§1, 9): `<errno.h>` only for
    // the convention that reads it, `<stdlib.h>` only for the borrow the emitter frees, then
    // the binding headers step 7's pragma names — runtime headers FIRST, so a binding header
    // can rely on the standard types — and one forward declaration per C symbol without one.
    // A symbol WITH a header gets no declaration here: the header's real prototype governs the
    // call, and a second, `void *`-based spelling next to it would be a conflicting-types
    // error rather than a declaration.
    if (this.externErrno) {
      out.push('#include <errno.h>');
    }
    // `<stdlib.h>` for the borrow the emitter frees — and always in a library build, where
    // the error cell is freed; `<stdbool.h>` for the init guard a library build always emits.
    // An executable build includes each only for the extern call that needs it, so its
    // prologue stays byte-identical when no externs are in play.
    if (this.externStdlib || library !== undefined) {
      out.push('#include <stdlib.h>');
    }
    if (library !== undefined) {
      out.push('#include <stdbool.h>');
    }
    for (const header of this.externHeaders) {
      out.push(`#include ${header}`);
    }
    out.push('', `JSRT_GLOBALS(${globalSlots});`, '');
    // Forward declarations ahead of every definition, so a function can call itself, or one
    // declared further down the file.
    for (const unit of this.functions) {
      out.push(
        `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);`,
      );
      // Not `const`: an ordinary function's `prototype` and own properties are written into its
      // closure on first use (plan-notes 310), and writing a `const` object is undefined behavior.
      out.push(
        `static JSRTClosure _jsrt_closure_${unit.id} = {_jsrt_fn_${unit.id}, ` +
          `${closureMeta(unit.fn).arity}, ${cNameLiteral(unit.name)}, NULL, ${closureMeta(unit.fn).hasReceiver ? 'true' : 'false'}, NULL, ${unit.fn.constructible === true ? 'true' : 'false'}};`,
      );
    }
    if (this.functions.length > 0) {
      out.push('');
    }
    // One descriptor per class, shared by every instance: the name printed by console.log, the
    // slot count, the field names in slot order, the base's descriptor, and the method table.
    // `const` and file-scope, so it costs nothing per object and `instanceof` is a pointer
    // comparison. It follows the closure constants because a method table names them.
    //
    // A descriptor takes the ADDRESS of its base's, so the base's must already be declared. It
    // always is, and not by luck: `this.classes` is in source order, and a base whose declaration
    // followed its subclass would be a temporal-dead-zone error the frontend never accepts. The
    // lookup below asserts that rather than assuming it.
    for (const [id, cls] of this.classes.entries()) {
      // A zero-length array is not valid C11, and a class with no fields is valid TypeScript. The
      // count is what readers use, so the unread placeholder is harmless.
      const names =
        cls.fields.length === 0 ? '""' : cls.fields.map((f) => cNameLiteral(f.name)).join(', ');
      out.push(`static const char *const _jsrt_fields_${id}[] = {${names}};`);
      if (cls.vtable.length > 0) {
        const entries = cls.vtable.map((entry) => {
          const id = cgClass.methodIdOrNull(this, entry);
          return id === null ? 'NULL' : `&_jsrt_closure_${id}`;
        });
        out.push(
          `static const JSRTClosure *const _jsrt_methods_${id}[] = {${entries.join(', ')}};`,
        );
        const methodNames = cls.vtable.map((entry) => cNameLiteral(entry.name)).join(', ');
        out.push(`static const char *const _jsrt_method_names_${id}[] = {${methodNames}};`);
      }
      const table =
        cls.vtable.length === 0
          ? '0, NULL, NULL'
          : `${cls.vtable.length}, _jsrt_methods_${id}, _jsrt_method_names_${id}`;
      // Absent unless the literal's key order differs from its layout: a class declaration lays
      // its fields out in the order it writes them, so identity is the overwhelming case.
      const keyOrder = this.classKeyOrders.get(id);
      if (keyOrder !== undefined) {
        out.push(
          `static const uint32_t _jsrt_keys_${id}[] = {${keyOrder.map(String).join(', ')}};`,
        );
      }
      out.push(
        `static const JSRTClass _jsrt_class_${id} = {${cNameLiteral(descriptorName(cls.name))}, ` +
          `${cls.fields.length}, _jsrt_fields_${id}, ${cgClass.baseDescriptor(this, cls, id)}, ${table}, ` +
          `${keyOrder === undefined ? 'NULL' : `_jsrt_keys_${id}`}, NULL};`,
      );
      // The class OBJECT (docs/VALUE.md §4.17): the closure-shaped value a class evaluates
      // to. Its `fn` is the constructor (NULL when the class declares none), reachable only
      // through `jsrt_construct`; its `klass` is this descriptor, which is how the runtime
      // answers `.name`/`.length`/`typeof`, statics, and value dispatch. A capturing ctor
      // has no file-static `_jsrt_closure_N` — but the gate refuses class values for classes
      // whose evaluation can repeat, which is exactly the surface that could capture here.
      out.push(
        `static const JSRTClosure _jsrt_class_object_${id} = {${cls.ctor === undefined ? 'NULL' : `_jsrt_fn_${String(cgClosure.functionId(this, cls.ctor.fn))}`}, ` +
          `${cls.ctor === undefined ? 0 : String(closureMeta(cls.ctor.fn).arity)}, ${cNameLiteral(cls.name)}, NULL, false, &_jsrt_class_${id}};`,
      );
    }
    if (this.classes.length > 0) {
      out.push('');
    }
    // One static cache per dynamic property site, zero-initialized: a NULL shape is the empty
    // cache, so no runtime setup is needed and the first access at each site fills it.
    for (let i = 0; i < this.icCount; i++) {
      out.push(`static JSRTIC _jsrt_ic_${String(i)};`);
    }
    if (this.icCount > 0) {
      out.push('');
    }
    // One forward declaration per extern C symbol the module calls, derived from the kinds the
    // counting pass recorded — argument C types left to right, `(void)` for an empty list. A
    // duplicate C name keeps its first declaration: two inconsistent declarations of one symbol
    // would already have failed the gate, so what survives here agrees.
    for (const decl of this.externDecls.values()) {
      out.push(decl);
    }
    if (this.externDecls.size > 0) {
      out.push('');
    }
    // Appended one line at a time, never spread: `functionLines` is the whole program's emitted
    // code, and `push(...arr)` passes every element as an argument — which blows the engine's
    // argument limit (RangeError) somewhere around a 100k-line input, in the emitter, on a program
    // the front end accepted. Same reason as the loop in `emitFunctionUnits`.
    for (const line of functionLines) {
      out.push(line);
    }
    for (const line of mainLines) {
      out.push(line);
    }

    return `${out.join('\n')}\n`;
  }
}
