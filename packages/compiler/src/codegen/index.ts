/* C emitter: #line source maps, JSRT_FRAME/JSRT_LOCAL rooting discipline from the first
 * emitted line, landing-pad error propagation. Generated C is never hand-edited. */

import type {
  ArrayLiteral,
  ArrayOp,
  AwaitExpr,
  BinaryOp,
  Block,
  CallExpr,
  ClassDeclaration,
  ClassMethod,
  CollectionOp,
  CollectionOperation,
  ConditionalExpr,
  ConsoleLogCall,
  DateComponents,
  DateNew,
  DateOp,
  DateStaticCall,
  DeleteProp,
  GetIterator,
  DynFieldAccess,
  DynFieldAssignment,
  DynObjectLiteral,
  EnvCapture,
  ErrorNew,
  Expression,
  FieldAssignment,
  ForOfStatement,
  FunctionExpr,
  IndexAccess,
  IndexAssignment,
  IteratorNext,
  JsonParse,
  JsonStringify,
  LogicalOp,
  MathCall,
  MethodCall,
  Module,
  NewExpr,
  ObjectLiteral,
  ObjectStaticCall,
  PromiseConstruct,
  PromiseMethodCall,
  PromiseStaticCall,
  RegExpLiteral,
  RegExpOp,
  Span,
  Statement,
  StringOp,
  SuperCall,
  SwitchStatement,
  TemplateLiteral,
  TryStatement,
  UnaryOp,
  UpdateExpr,
  VtableEntry,
  YieldExpr,
} from '../hir/nodes.ts';
import { ITERATOR_METHOD_NAME } from '../frontend/types.ts';
import {
  arrayOpCallsBack,
  consoleEntryPoint,
  DATE_OPS,
  DATE_STATICS,
  errorDescriptor,
  isAccessorEntry,
  REGEXP_FIELDS,
  REGEXP_OPS,
  SET_OPS,
  stringOpCanThrow,
} from '../hir/nodes.ts';
import type { HField } from '../hir/types.ts';

/** C fragment for each binary operator, given already-emitted operand expressions.
 *
 * Note what is NOT here: `jsrt_to_double`, which is a bit reinterpretation and not a conversion.
 * Applying it to a boxed boolean or string reads the payload as an IEEE double and produces
 * garbage. Every numeric context goes through `jsrt_to_number` (ToNumber, docs/NUMERIC.md §6.3). */
const BINARY_EMITTERS: Readonly<Record<BinaryOp['operator'], (l: string, r: string) => string>> = {
  // `+` is the one arithmetic operator that is not arithmetic. If EITHER operand is a string it
  // concatenates instead of adding, so the dispatch is a runtime decision and lives in the
  // runtime: `1 + "2"` is `"12"`, not `3`.
  '+': (l, r) => `jsrt_op_add(${l}, ${r})`,
  '-': (l, r) => `jsrt_number(jsrt_to_number(${l}) - jsrt_to_number(${r}))`,
  '*': (l, r) => `jsrt_number(jsrt_to_number(${l}) * jsrt_to_number(${r}))`,
  // Always f64 division: there is no integer `/` in JavaScript, so 1/2 is 0.5 and 1/0 is
  // Infinity rather than a trap (docs/NUMERIC.md §3.1).
  '/': (l, r) => `jsrt_number(jsrt_to_number(${l}) / jsrt_to_number(${r}))`,
  // `fmod`, not C's `%`: the operands are doubles, and C's `%` is integer-only.
  '%': (l, r) => `jsrt_number(fmod(jsrt_to_number(${l}), jsrt_to_number(${r})))`,
  // Relational comparison is string-vs-numeric at RUNTIME, and the two disagree: `"10" < "9"` is
  // true (code-unit order) while `"10" < 9` is false (numeric). Only when BOTH operands are
  // strings does it compare as text -- which is why this cannot be decided by the emitter.
  //
  // Note also that these are four independent operators, not two plus negation: all four are
  // false when an operand is NaN, so `!(a < b)` is not `a >= b` (docs/NUMERIC.md §9).
  '<': (l, r) => `jsrt_bool(jsrt_op_lt(${l}, ${r}))`,
  '>': (l, r) => `jsrt_bool(jsrt_op_gt(${l}, ${r}))`,
  '<=': (l, r) => `jsrt_bool(jsrt_op_le(${l}, ${r}))`,
  '>=': (l, r) => `jsrt_bool(jsrt_op_ge(${l}, ${r}))`,
  '===': (l, r) => `jsrt_bool(jsrt_strict_equals(${l}, ${r}))`,
  '!==': (l, r) => `jsrt_bool(!jsrt_strict_equals(${l}, ${r}))`,
  '==': (l, r) => `jsrt_bool(jsrt_loose_equals(${l}, ${r}))`,
  '!=': (l, r) => `jsrt_bool(!jsrt_loose_equals(${l}, ${r}))`,
  '&': (l, r) => `jsrt_op_bitand(${l}, ${r})`,
  '|': (l, r) => `jsrt_op_bitor(${l}, ${r})`,
  '^': (l, r) => `jsrt_op_bitxor(${l}, ${r})`,
  '<<': (l, r) => `jsrt_op_shl(${l}, ${r})`,
  '>>': (l, r) => `jsrt_op_shr(${l}, ${r})`,
  '>>>': (l, r) => `jsrt_op_ushr(${l}, ${r})`,
  '**': (l, r) => `jsrt_math_pow(${l}, ${r})`,
  ',': (_l, r) => r,
  in: (l, r) => `jsrt_bool(jsrt_in(${l}, ${r}))`,
};

/** C fragment for each unary operator.
 *
 * `-` is a real negation, not a constant fold: `-x` where x is `+0` must yield `-0`, which is why
 * the emitter negates the double rather than subtracting from zero. */
/** The runtime check for each HType kind a boundary may narrow TO.
 *
 * Deliberately partial. A kind absent here is one the runtime cannot test for in constant time from
 * the value alone -- an object's shape, a function's signature, an array's element type -- and the
 * gate refuses those narrowings rather than letting the emitter invent a check that only looks at
 * the tag. A missing entry reaching here is therefore a gate/emitter disagreement, and throws. */
const CHECK_FUNCTIONS: Readonly<Record<string, string | undefined>> = {
  number: 'jsrt_check_number',
  string: 'jsrt_check_string',
  boolean: 'jsrt_check_boolean',
};

const UNARY_EMITTERS: Readonly<Record<UnaryOp['operator'], (operand: string) => string>> = {
  '-': (x) => `jsrt_number(-jsrt_to_number(${x}))`,
  '+': (x) => `jsrt_number(jsrt_to_number(${x}))`,
  '!': (x) => `jsrt_bool(!jsrt_truthy(${x}))`,
  '~': (x) => `jsrt_op_bitnot(${x})`,
  void: (x) => `(${x}, JSRT_UNDEFINED)`,
};

/** Render a JS number as a C literal that parses back to the SAME double.
 *
 * `String(n)` is not enough on its own. Three ways it produces C that is wrong or will not
 * compile at all:
 *   1e20   -> "100000000000000000000", which C reads as an INTEGER literal too large for any
 *             integer type. clang rejects the file outright.
 *   7      -> "7", an int literal. It converts to 7.0 here, but the emitted C then documents a
 *             type the compiler does not actually use, and the habit breaks at the int64 range.
 *   -0     -> "0". The sign is lost, and with it Object.is(-0, 0) === false and 1/-0 === -Infinity
 *             (docs/VALUE.md §1.3).
 * What DOES carry over is that `String(n)` is already the shortest round-tripping decimal, so
 * appending a decimal point is enough to make it exact and legal at once. */
function cDoubleLiteral(value: number): string {
  if (Number.isNaN(value)) {
    return '(0.0 / 0.0)'; // canonicalized by jsrt_number; see docs/VALUE.md §1.2
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '(1.0 / 0.0)';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '(-1.0 / 0.0)';
  }
  if (Object.is(value, -0)) {
    return '-0.0';
  }
  const text = String(value);
  // "1e+21" and "0.5" are already floating literals to C; bare digits are not.
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** A C string literal, used for the function name `jsrt_print` reports as `[Function: name]`.
 * `?` is escaped for the trigraph reason `escapeBytes` documents. */
function cNameLiteral(name: string): string {
  return `"${escapeCString(name)}"`;
}

/** A C string literal's body for everything that is not a byte string: a file name in a `#line`,
 * a `file:line` location, a reference error's name, a function's own name. Same escaping rules as
 * `escapeBytes`, and the same trigraph rule, spelled once so the two cannot drift. */
function escapeCString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\?/g, '\\?');
}

/* One emitted C function. Each HIR function becomes a `_jsrt_fn_N` with a frame of its own, plus a
 * file-static `_jsrt_closure_N` describing it -- constant because rung 4a has no captures; 4b makes
 * the closure heap-allocated and gives it an environment pointer. */
interface FunctionUnit {
  readonly id: number;
  readonly fn: FunctionExpr;
  readonly name: string;
}

/* One open try-with-finally during emission. A jump (return/break/continue) out of the protected
 * code cannot simply `goto` its target -- the finally body must run first -- so it records WHICH
 * jump in the completion variable and gotos the finally instead; `routes` maps each distinct jump
 * (keyed by its goto label, or 'return') to the completion code that selects it in the dispatch
 * and the emitter action that re-performs it there. The action runs with this scope already
 * popped, so a jump crossing two finallys routes through both, innermost first. */
interface TryFinallyScope {
  readonly compVar: string;
  /** A try's completion code lives in a counted slot, boxed as a number, so it survives a
   * suspension between the route and the dispatch; the Map/Set for-of cleanup's comp is a raw
   * C int, which is safe only because that loop never suspends (the suspendable units box the
   * walk into a heap iterator instead). */
  readonly compBoxed: boolean;
  readonly finLabel: string;
  /** `this.enclosing.length` when the try opened: a break/continue leaves the try exactly when
   * its target construct's index in `enclosing` is below this depth. */
  readonly enclosingDepth: number;
  readonly routes: Map<string, { readonly code: number; readonly action: () => void }>;
}

/** The descriptor name a class prints. A SHAPE prints none: `console.log({x: 1})` shows
 * `{ x: 1 }`, with no constructor name in front, and the leading brace of the shape's structural
 * name is what says so -- no class may be called that. */
/** The runtime's C naming rule for a JS member: camelCase becomes snake_case, so `charCodeAt`
 * is `char_code_at` and `getOwnPropertyNames` is `get_own_property_names`. Mechanical on purpose
 * -- a runtime function's name is derivable from the member it serves, with no table to drift. */
function declaredArity(fn: {
  readonly params: readonly { readonly rest?: true; readonly default?: unknown }[];
}): number {
  let n = 0;
  for (const param of fn.params) {
    if (param.rest === true || param.default !== undefined) {
      break;
    }
    n++;
  }
  return n;
}

function snakeCase(member: string): string {
  return member.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function descriptorName(name: string): string {
  return name.startsWith('{') ? '' : name;
}

/** The structural name of a literal's shape, which is also its descriptor's identity. */
function shapeNameOf(expr: ObjectLiteral): string {
  if (expr.type.kind !== 'object') {
    throw new Error('object literal has no shape');
  }
  return expr.type.name;
}

/** The literal's LAYOUT: the type's fields, which is what every later read resolves against. */
function shapeFieldsOf(expr: ObjectLiteral): readonly HField[] {
  if (expr.type.kind !== 'object') {
    throw new Error('object literal has no shape');
  }
  return expr.type.fields;
}

/** Slot indices in the order the literal wrote its keys, or `undefined` when that IS slot order.
 * A duplicate key keeps its first position and its single slot, which is what §13.2.5.5 does. */
function keyOrderOf(expr: ObjectLiteral, layout: readonly HField[]): number[] | undefined {
  const order: number[] = [];
  for (const entry of expr.entries) {
    const slot = layout.findIndex((field) => field.name === entry.name);
    if (slot >= 0 && !order.includes(slot)) {
      order.push(slot);
    }
  }
  // A literal that does not cover its own layout cannot describe an enumeration order for it;
  // that shape is unreachable (a partial literal is a dynamic one), so identity is the safe answer.
  const identity = order.every((slot, i) => slot === i);
  return order.length !== layout.length || identity ? undefined : order;
}

/* A JS string is a sequence of UTF-16 CODE UNITS, and a lone surrogate is a legal one. UTF-8
 * cannot represent it, so `"\ud800"` written straight into the .c file comes back as U+FFFD --
 * `charCodeAt(0)` answered 65533 where Node answers 55296 (plan-notes 178, found by the fuzzer).
 * WTF-8 is UTF-8 plus the three-byte encodings of unpaired surrogates, which is exactly what
 * `utf8_decode` in runtime/src/jsrt_string.c already accepts, so the transport needs no runtime
 * change -- only an emitter that stops losing the bytes. */
function wtf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      i += 1;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/* Octal, never `\x`: a C hex escape consumes as many hex digits as follow it, so `"\xEDa"` is one
 * out-of-range character rather than two. Three octal digits are always exactly three.
 *
 * `?` is escaped even though it is printable, because C11 still has TRIGRAPHS: `??!` inside a
 * string literal is the single character `|`, and `??/` is a backslash that eats the closing quote.
 * `console.log("a??!b")` printed `a|b` and `"x??/"` did not compile at all until this (plan-notes
 * 217). `\?` is a plain escape for the same character, and `-std=c11` is the dialect the build
 * pins, so the literal has to survive it. */
function escapeBytes(bytes: readonly number[]): string {
  let result = '';
  for (const byte of bytes) {
    if (byte === 0x0a) result += '\\n';
    else if (byte === 0x09) result += '\\t';
    else if (byte === 0x0d) result += '\\r';
    else if (byte === 0x5c) result += '\\\\';
    else if (byte === 0x22) result += '\\"';
    else if (byte === 0x3f) result += '\\?';
    else if (byte >= 0x20 && byte < 0x7f) result += String.fromCharCode(byte);
    else result += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return result;
}

class Emitter {
  private lines: string[] = [];
  private indent: number = 0;
  private slotMap: Map<string, number> = new Map();
  /** Frame slot holding each short-circuit operator's left operand. Keyed by node identity, since
   * two `&&`s in one expression must not share a slot: the outer one's value stays live while the
   * inner one is being evaluated. */
  private tempSlots: Map<
    AwaitExpr | LogicalOp | YieldExpr | ConditionalExpr | UpdateExpr | DynFieldAccess | GetIterator,
    number
  > = new Map();
  /* C does not specify which operand of an operator or function call it evaluates first. Every
   * BinaryOp therefore gets two rooted slots: emitting `left` into the first before `right` into
   * the second makes the JavaScript left-to-right rule explicit, and preserves the left value if
   * evaluating the right allocates. */
  private binarySlots: Map<BinaryOp, number> = new Map();
  /* A template evaluates and stringifies substitutions from left to right too. Its parts occupy a
   * contiguous run; slot zero is reused for each concatenation result so that intermediate strings
   * remain rooted across the next allocation. */
  private templateSlots: Map<TemplateLiteral, { readonly base: number; readonly count: number }> =
    new Map();
  /* The switch discriminant's slot: evaluated once, then compared against every clause. */
  private switchSlots: Map<SwitchStatement, number> = new Map();
  /* Frame slot holding a call's callee and its arguments: 1 + argc CONTIGUOUS slots, so `argv` can
   * point at the first argument and every already-evaluated operand stays rooted while the rest are
   * evaluated. Keyed by node identity, like the other temporaries. */
  private callSlots: Map<
    | ArrayOp
    | CallExpr
    | ConsoleLogCall
    | JsonParse
    | JsonStringify
    | CollectionOp
    | DateComponents
    | DateNew
    | DateOp
    | DateStaticCall
    | DynObjectLiteral
    | ErrorNew
    | MathCall
    | MethodCall
    | NewExpr
    | ObjectLiteral
    | ObjectStaticCall
    | PromiseConstruct
    | PromiseMethodCall
    | PromiseStaticCall
    | RegExpLiteral
    | RegExpOp
    | StringOp
    | SuperCall
    | IteratorNext,
    number
  > = new Map();

  /* Every class declared anywhere in the file, in the order counting reached them. The index is
   * the descriptor's C identity (`_jsrt_class_N`), and the name is how NewExpr and MethodCall --
   * which carry a class NAME, not a pointer -- find their way back to it. */
  /** Inline-cache sites allocated so far -- one static JSRTIC per dynamic property SITE
   * (docs/VALUE.md §4.10), declared at file scope with the class descriptors. Reset per emit. */
  private icCount = 0;

  private classes: ClassDeclaration[] = [];
  private classIds: Map<string, number> = new Map();
  /** Class id -> enumeration order, present only for a literal whose keys are not in slot order. */
  private classKeyOrders: Map<number, number[]> = new Map();
  /* An array literal's elements occupy a contiguous run, for the same reason a call's arguments do:
   * `jsrt_array_new` takes a pointer to the first, and every element already evaluated must stay
   * rooted while the rest are evaluated -- the allocation inside `jsrt_array_new` itself can
   * collect. */
  private arraySlots: Map<ArrayLiteral, number> = new Map();
  /* Two slots for a read (`target`, `index`), three for a write (`target`, `index`, `value`).
   * Same unspecified-order argument as binarySlots: `jsrt_array_get(a(), i())` would let C run
   * `i()` first, and a collection during `i()` could free the array `a()` just produced. */
  private indexSlots: Map<
    DeleteProp | DynFieldAssignment | FieldAssignment | IndexAccess | IndexAssignment | UpdateExpr,
    number
  > = new Map();
  /* The for-of iterable's slot. Evaluated ONCE -- `for (const x of f())` calls `f` once -- and the
   * array has to stay rooted for the whole loop, since the body can allocate on every iteration. */
  private forOfSlots: Map<ForOfStatement, number> = new Map();
  private slotCount: number = 0;

  /* Module-level bindings, which are NOT in any function's frame: a function body may read one, and
   * main's stack frame does not outlive the call. They live in the file-static globals array, so
   * `slotMap`/`slotCount` above always describe the unit being emitted and these describe the
   * module. While the module itself is being emitted the two are the same map. */
  private globalMap: Map<string, number> = new Map();
  private globalCount: number = 0;
  private inFunction: boolean = false;

  /* Captured-variable state for the unit being emitted (docs/VALUE.md §4.3). `envMap` holds this
   * function's OWN captured bindings, which live in its heap environment instead of its frame --
   * so a name in here must never also get a frame slot. `captureMap` holds the ones it reads from
   * enclosing environments, already resolved to (levels, index) by capture analysis. */
  private envMap: Map<string, number> = new Map();
  private captureMap: Map<string, EnvCapture> = new Map();
  /* Where `return e;` parks its value: the expression is evaluated into a rooted slot while the
   * frame is still live, and only then is the frame popped. One slot per function is enough --
   * returns do not nest. */
  private returnSlot: number = 0;
  /* Set while counting, read once counting is done: whether this unit has a `return <expr>` at
   * all, and therefore whether `returnSlot` is a slot or a number nothing reads. */
  private returnsValue: boolean = false;
  /* Async/generator state for the unit being emitted. `inAsync`/`inGenerator` switch `slotAt`
   * over to the heap environment: locals must survive a suspension, and a suspension pops the
   * C frame. `awaitStates` numbers each suspension point (await or yield), assigned while COUNTING
   * because the resume function's dispatch switch is emitted before the body whose labels it
   * jumps to. The two flags are mutually exclusive in this landing. */
  private inAsync: boolean = false;
  /** The module body is an async unit: named bindings stay in `globalMap`, temps go to the
   * heap environment. Distinct from `inAsync` on a function, which puts names in the env too. */
  private moduleAsync: boolean = false;
  private inGenerator: boolean = false;
  private awaitStates: Map<AwaitExpr | YieldExpr, number> = new Map();
  /* Whether anything in the module suspended or promised. `main` drains the microtask queue only
   * then -- a program that never promises should not link the driver in at all. */
  private usedAsync: boolean = false;
  /* Every function reachable from the module, in emission order. It GROWS while it is walked: a
   * nested function is only discovered when its parent's body is counted. */
  private functions: FunctionUnit[] = [];
  private functionIds: Map<FunctionExpr, number> = new Map();

  private fileName: string = '';

  /* Loops and switches currently open, innermost last -- the emitter's mirror of the verifier's
   * Enclosing stack, carrying the id that names this construct's C labels. */
  private enclosing: { id: number; label?: string; isLoop: boolean; iterEnv?: boolean }[] = [];

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
  private iterEnvSlots = new Map<Statement, number>();
  private iterEnvBase = new Map<number, number>();
  private loopCount: number = 0;
  /* Labels a `goto` actually targets. C warns on a label nothing jumps to, and the runtime builds
   * with -Wall -Wextra -Werror, so an unconditional `brk_N:` after every loop would turn a plain
   * `while` into a build failure. Every jump is emitted before its target line, so consulting this
   * at emission time is enough -- no second pass over the output. */
  private usedLabels: Set<string> = new Set();

  /* Where a pending exception unwinds to, innermost try's landing pad last. Empty means the
   * unit's own `_jsrt_unwind` tail: pop the frame and return (functions) or report the exception
   * as uncaught and exit (main). */
  private padStack: string[] = [];
  private unwindUsed = false;
  /* Open try/finally constructs, innermost last -- see TryFinallyScope. */
  private tryFinallyStack: TryFinallyScope[] = [];
  private tryCount = 0;
  /* The rooted slot a try-with-finally stashes a caught exception in: the pending cell empties
   * before the finally body runs (the body may itself throw, and its exception must overwrite,
   * not collide), so the taken value needs a frame slot the GC can see until the dispatch
   * rethrows it. */
  private trySlots: Map<TryStatement, number> = new Map();

  emit(module: Module): string {
    this.fileName = module.fileName;
    this.slotMap = new Map();
    this.tempSlots.clear();
    this.binarySlots.clear();
    this.templateSlots.clear();
    this.switchSlots.clear();
    this.callSlots.clear();
    this.classes = [];
    this.classIds.clear();
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
    this.enclosing = [];
    this.loopCount = 0;
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
    this.countBindings(module.statements);
    this.globalMap = this.slotMap;
    this.globalCount = this.slotCount;
    // A zero-length array is not valid C11, and a program with no module-level binding is.
    const globalSlots = Math.max(this.globalCount, 1);

    const functionLines = this.emitFunctionUnits();
    const mainLines = this.emitMain(module, globalSlots);

    const out: string[] = ['#include "jsrt_value.h"', '', `JSRT_GLOBALS(${globalSlots});`, ''];
    // Forward declarations ahead of every definition, so a function can call itself, or one
    // declared further down the file.
    for (const unit of this.functions) {
      out.push(
        `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);`,
      );
      out.push(
        `static const JSRTClosure _jsrt_closure_${unit.id} = {_jsrt_fn_${unit.id}, ` +
          `${declaredArity(unit.fn)}, ${cNameLiteral(unit.name)}, NULL};`,
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
        const entries = cls.vtable.map((entry) => `&_jsrt_closure_${this.methodId(entry)}`);
        out.push(
          `static const JSRTClosure *const _jsrt_methods_${id}[] = {${entries.join(', ')}};`,
        );
      }
      const table =
        cls.vtable.length === 0 ? '0, NULL' : `${cls.vtable.length}, _jsrt_methods_${id}`;
      // Absent unless the literal's key order differs from its layout: a class declaration lays
      // its fields out in the order it writes them, so identity is the overwhelming case.
      const iterMethod = cls.methods.find((m) => m.name === ITERATOR_METHOD_NAME);
      const iterClosure =
        iterMethod === undefined ? 'NULL' : `&_jsrt_closure_${this.functionId(iterMethod.fn)}`;
      const keyOrder = this.classKeyOrders.get(id);
      if (keyOrder !== undefined) {
        out.push(
          `static const uint32_t _jsrt_keys_${id}[] = {${keyOrder.map(String).join(', ')}};`,
        );
      }
      out.push(
        `static const JSRTClass _jsrt_class_${id} = {${cNameLiteral(descriptorName(cls.name))}, ` +
          `${cls.fields.length}, _jsrt_fields_${id}, ${this.baseDescriptor(cls, id)}, ${table}, ` +
          `${keyOrder === undefined ? 'NULL' : `_jsrt_keys_${id}`}, ${iterClosure}};`,
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

  private emitMain(module: Module, globalSlots: number): string[] {
    const produced: string[] = [];
    this.lines = produced;
    this.indent = 0;
    this.inFunction = false;
    this.slotMap = this.globalMap;
    this.slotCount = this.globalCount;
    this.padStack = [];
    this.unwindUsed = false;
    this.tryFinallyStack = [];
    this.tryCount = 0;

    if (module.isAsync) {
      this.emitAsyncModule(module, globalSlots);
      return produced;
    }

    this.appendLine('int main(void) {');
    this.indent++;
    this.appendLine('jsrt_init();', module.span);
    this.appendLine(`JSRT_GLOBALS_ENTER(${globalSlots});`, module.span);
    // Rooted through the globals frame, which is pushed once and never popped -- the module
    // environment has to outlive main's locals for the same reason the globals array does.
    if (module.envVars.length > 0) {
      this.appendLine(
        `JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(module.envVars.length)});`,
        module.span,
      );
      this.appendLine('JSRT_GLOBALS_ENV(_jsrt_env);', module.span);
    }
    this.emitHoistedFunctions(module.statements);
    for (const stmt of module.statements) {
      this.emitStatement(stmt);
    }
    // Everything a promise queued runs before the program exits -- that is the whole of the job
    // queue's observable behaviour for a program with no other event source. Emitted only when
    // the module actually promised, so a program that never did does not link the driver in.
    if (this.usedAsync) {
      this.appendLine('jsrt_run_microtasks();', module.span);
    }
    // No pop: the globals frame is pushed once and lives as long as the program does.
    this.appendLine('return 0;', module.span);
    if (this.unwindUsed) {
      // An exception no try caught: report on stderr and exit(1), which is what Node does.
      this.appendLine('_jsrt_unwind: ;', module.span);
      this.appendLine('jsrt_uncaught();', module.span);
    }
    this.indent--;
    this.appendLine('}');

    return produced;
  }

  /* A module with a top-level await is an async unit (Phase 5 step 9). Named bindings stay in
   * the globals array so the rest of the program still reads JSRT_GLOBAL; temps and await state
   * live in a heap environment because a suspension pops main's C frame. Init runs in Task 3.11's
   * topological order — Stator does not interleave sibling subgraphs the way Node does. */
  private emitAsyncModule(module: Module, globalSlots: number): void {
    this.usedAsync = true;
    this.moduleAsync = true;
    this.inAsync = true;
    this.inFunction = true;
    this.slotMap = new Map();
    // Same layout an async FUNCTION uses (see emitFunctionUnit): the module's captured
    // per-iteration bindings own env indices 0..envVars.length-1, and the suspension-surviving
    // locals are numbered past them into the same environment. One env, two tenants -- which is
    // why the per-iteration clone works here unchanged.
    this.envMap = new Map(module.envVars.map((name, index) => [name, index]));
    this.slotCount = module.envVars.length;
    this.captureMap = new Map();
    this.awaitStates = new Map();
    this.returnsValue = true;
    this.countBindings(module.statements);
    this.returnSlot = this.slotCount;
    this.slotCount++;
    const envSlots = Math.max(1, this.slotCount);

    this.appendLine(
      'static void _jsrt_module_done(void *state, jsrt_value value, bool rejected) {',
    );
    this.indent++;
    this.appendLine('(void)state;');
    this.appendLine('if (rejected) {');
    this.indent++;
    this.appendLine('jsrt_throw(value);');
    this.appendLine('jsrt_uncaught();');
    this.indent--;
    this.appendLine('}');
    this.indent--;
    this.appendLine('}');
    this.appendLine('');
    this.appendLine(
      'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);',
    );
    this.appendLine('');

    this.appendLine('int main(void) {');
    this.indent++;
    this.appendLine('jsrt_init();', module.span);
    this.appendLine(`JSRT_GLOBALS_ENTER(${globalSlots});`, module.span);
    this.emitHoistedFunctions(module.statements);
    this.appendLine('JSRT_FRAME(1);', module.span);
    this.appendLine(`JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(envSlots)});`, module.span);
    this.appendLine('JSRT_FRAME_ENV(_jsrt_env);', module.span);
    this.appendLine(
      'JSRT_LOCAL(0) = jsrt_async_start(_jsrt_env, _jsrt_async_module);',
      module.span,
    );
    this.appendLine('jsrt_promise_subscribe(JSRT_LOCAL(0), _jsrt_module_done, NULL);', module.span);
    this.appendLine('jsrt_run_microtasks();', module.span);
    this.appendLine('JSRT_FRAME_POP();', module.span);
    this.appendLine('return 0;', module.span);
    this.indent--;
    this.appendLine('}');
    this.appendLine('');

    this.appendLine(
      'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {',
    );
    this.indent++;
    this.emitResumeOpen(module.span, ['_jsrt_v', '_jsrt_err']);
    for (const stmt of module.statements) {
      this.emitStatement(stmt);
    }
    this.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', module.span);
    if (this.unwindUsed) {
      this.appendLine('_jsrt_unwind: ;', module.span);
      this.appendLine(`${this.slotAt(this.returnSlot)} = jsrt_take_exception();`, module.span);
      this.emitAsyncSettle('jsrt_async_throw', this.slotAt(this.returnSlot), module.span);
    }
    this.indent--;
    this.appendLine('}');
  }

  /* Emits every function unit, counting each body immediately before emitting it. The list grows
   * while it is walked, so this is an index loop rather than a `for..of` over a snapshot. */
  private emitFunctionUnits(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.functions.length; i++) {
      const unit = this.functions[i];
      if (unit === undefined) {
        continue;
      }
      for (const line of this.emitFunctionUnit(unit)) {
        out.push(line);
      }
    }
    return out;
  }

  private emitFunctionUnit(unit: FunctionUnit): string[] {
    const savedLines = this.lines;
    const savedIndent = this.indent;
    const savedSlotMap = this.slotMap;
    const savedSlotCount = this.slotCount;
    const savedInFunction = this.inFunction;
    const savedEnclosing = this.enclosing;
    const savedLabels = this.usedLabels;
    const savedReturnSlot = this.returnSlot;
    const savedReturnsValue = this.returnsValue;
    const savedEnvMap = this.envMap;
    const savedCaptureMap = this.captureMap;
    const savedPadStack = this.padStack;
    const savedUnwindUsed = this.unwindUsed;
    const savedTryFinallyStack = this.tryFinallyStack;
    const savedTryCount = this.tryCount;
    const savedInAsync = this.inAsync;
    const savedInGenerator = this.inGenerator;
    const savedAwaitStates = this.awaitStates;

    const produced: string[] = [];
    this.lines = produced;
    this.indent = 0;
    this.slotMap = new Map();
    this.inFunction = true;
    this.enclosing = [];
    this.usedLabels = new Set();
    this.padStack = [];
    this.unwindUsed = false;
    this.tryFinallyStack = [];
    this.tryCount = 0;

    const { fn } = unit;
    this.envMap = new Map(fn.envVars.map((name, index) => [name, index]));
    this.captureMap = new Map(fn.captures.map((c) => [c.name, c]));
    this.inAsync = fn.isAsync;
    this.inGenerator = fn.isGenerator;
    this.awaitStates = new Map();
    if (fn.isAsync && fn.isGenerator) {
      throw new Error('async generators are not in this landing');
    }
    // An async or generator unit's locals live in the SAME environment array as its captured
    // bindings, which already own indices 0..envVars.length-1 -- so numbering starts past them.
    // One array, one allocation, and `slotRef`'s existing precedence keeps a captured name out of
    // the local run.
    this.slotCount = fn.isAsync || fn.isGenerator ? fn.envVars.length : 0;

    for (const param of fn.params) {
      // `function f(a, a)` is legal in sloppy JavaScript and the later parameter wins; reusing the
      // slot rather than allocating a second one is exactly that rule, and `bindSlot` is where it
      // lives along with the captured-binding rule.
      this.bindSlot(param.name);
    }
    for (const param of fn.params) {
      if (param.default !== undefined) {
        this.countExpression(param.default);
      }
    }
    // The return slot is claimed AFTER counting, and only if the body actually returns a value:
    // it holds the result across JSRT_FRAME_POP(), and a function that never produces one would
    // otherwise root a slot nothing ever writes.
    this.returnsValue = false;
    this.countBindings(fn.body.statements);
    // An async unit always parks its result: every exit settles the promise, and the value has to
    // be in a rooted slot while `jsrt_async_return` allocates the microtask that delivers it. A
    // generator parks the same way: `jsrt_generator_return` writes the completion into the object.
    if (fn.isAsync || fn.isGenerator) {
      this.returnsValue = true;
    }
    if (this.returnsValue) {
      this.returnSlot = this.slotCount;
      this.slotCount++;
    }

    if (fn.isAsync) {
      this.emitAsyncUnit(unit);
    } else if (fn.isGenerator) {
      this.emitGeneratorUnit(unit);
    } else {
      this.emitSyncUnit(unit);
    }

    this.lines = savedLines;
    this.indent = savedIndent;
    this.slotMap = savedSlotMap;
    this.slotCount = savedSlotCount;
    this.inFunction = savedInFunction;
    this.enclosing = savedEnclosing;
    this.usedLabels = savedLabels;
    this.returnSlot = savedReturnSlot;
    this.returnsValue = savedReturnsValue;
    this.envMap = savedEnvMap;
    this.captureMap = savedCaptureMap;
    this.padStack = savedPadStack;
    this.unwindUsed = savedUnwindUsed;
    this.inAsync = savedInAsync;
    this.inGenerator = savedInGenerator;
    this.awaitStates = savedAwaitStates;
    this.tryFinallyStack = savedTryFinallyStack;
    this.tryCount = savedTryCount;

    return produced;
  }

  /* Every place a list of statements is a SCOPE: hoist its function declarations, then run it.
   *
   * A module is always strict, so a function declared in a block belongs to that block and is
   * initialized when the block is entered -- not when the enclosing function was (plan.md §8
   * step 12(e)). Routing every block, branch, loop body and clause list through here is what makes
   * `{ f(); function f() {} }` resolve instead of calling `undefined`, and re-running it per
   * iteration is what gives a loop body's declaration the iteration's own captures. */
  private emitScope(statements: readonly Statement[]): void {
    this.emitHoistedFunctions(statements);
    for (const stmt of statements) {
      this.emitStatement(stmt);
    }
  }

  /* Function declarations bind at the top of their unit, not where they are written, so `f();
   * function f() {}` works. The binding is what hoists; the body is emitted once, elsewhere. */
  private emitHoistedFunctions(statements: readonly Statement[]): void {
    for (const stmt of statements) {
      if (stmt.kind !== 'function-declaration') {
        continue;
      }
      this.appendLine(`${this.slotRef(stmt.name)} = ${this.closureValue(stmt.fn)};`, stmt.span);
    }
  }

  /* Gives a function its id the first time it is counted, and hands back the same id afterwards.
   * The id is what ties `jsrt_closure(&_jsrt_closure_N)` to the definition of `_jsrt_fn_N`. */
  private registerFunction(fn: FunctionExpr, name: string): number {
    const existing = this.functionIds.get(fn);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.functions.length;
    this.functionIds.set(fn, id);
    this.functions.push({ id, fn, name });
    return id;
  }

  private functionId(fn: FunctionExpr): number {
    const id = this.functionIds.get(fn);
    if (id === undefined) {
      throw new Error('function was not registered during counting');
    }
    return id;
  }

  /* Storage for one named binding, at most once. A binding this function CAPTURES already has a
   * home -- its heap environment -- and `slotRef` reads that one, so a frame slot of the same name
   * would be a slot the frame roots and nothing ever reads. One variable, one home; the frame-vs-
   * locals audit in tests/unit/frames.test.ts is what holds this to exactly that. */
  private bindSlot(name: string): void {
    if (this.envMap.has(name) || this.slotMap.has(name)) {
      return;
    }
    // A top-level name already lives in the globals array; the async module body must not grow a
    // second home for it in the heap environment (temps still bind, they have no global name).
    if (this.moduleAsync && this.globalMap.has(name)) {
      return;
    }
    this.slotMap.set(name, this.slotCount);
    this.slotCount++;
  }

  /* Assigns every frame slot before a single line of body is emitted, because JSRT_FRAME(n) is
   * written once at the top and n has to be final by then. Named bindings and short-circuit
   * temporaries share one counter and one frame: both hold jsrt_values the GC must see. */
  private countBindings(statements: readonly Statement[]): void {
    for (const stmt of statements) {
      switch (stmt.kind) {
        case 'declaration':
          this.bindSlot(stmt.name);
          if (stmt.value !== undefined && stmt.value.kind === 'function') {
            // Node names a function after the binding it is assigned to: `const mul = () => {}`
            // prints as `[Function: mul]`, not `[Function (anonymous)]`.
            this.registerFunction(stmt.value, stmt.name);
          } else if (stmt.value !== undefined) {
            this.countExpression(stmt.value);
          }
          break;
        case 'assignment':
          this.countExpression(stmt.value);
          break;
        case 'expression-statement':
          this.countExpression(stmt.expression);
          break;
        case 'block':
          this.countBindings(stmt.statements);
          break;
        case 'if-statement':
          this.countExpression(stmt.condition);
          this.countBindings(stmt.consequent.statements);
          if (stmt.alternate) {
            this.countBindings(stmt.alternate.statements);
          }
          break;
        case 'while-statement':
        case 'do-while-statement':
          this.countIterEnvSlots(stmt);
          this.countExpression(stmt.condition);
          this.countBindings(stmt.body.statements);
          break;
        case 'for-statement':
          this.countIterEnvSlots(stmt);
          if (stmt.init) {
            this.countBindings([stmt.init]);
          }
          if (stmt.condition) {
            this.countExpression(stmt.condition);
          }
          if (stmt.update) {
            this.countBindings([stmt.update]);
          }
          this.countBindings(stmt.body.statements);
          break;
        case 'switch-statement': {
          // The discriminant needs a slot of its own: it is evaluated ONCE and then compared
          // against every clause, so it has to survive as a rooted value across those tests.
          this.switchSlots.set(stmt, this.slotCount);
          this.slotCount++;
          this.countExpression(stmt.discriminant);
          for (const clause of stmt.clauses) {
            if (clause.test) {
              this.countExpression(clause.test);
            }
            this.countBindings(clause.statements);
          }
          break;
        }
        case 'function-declaration':
          this.bindSlot(stmt.name);
          // The FUNCTION's own name, falling back to the declaration's. They differ for exactly one
          // thing: a monomorphized specialization is bound as `box<number>` but is still the `box`
          // the user wrote, and `[Function: box]` is what Node prints for it.
          this.registerFunction(stmt.fn, stmt.fn.name ?? stmt.name);
          break;
        case 'return-statement':
          if (stmt.value) {
            this.returnsValue = true;
            this.countExpression(stmt.value);
          }
          break;
        case 'index-assignment':
          this.indexSlots.set(stmt, this.slotCount);
          this.slotCount += 3;
          this.countExpression(stmt.target);
          this.countExpression(stmt.index);
          this.countExpression(stmt.value);
          break;
        case 'for-of-statement':
          this.countIterEnvSlots(stmt);
          this.forOfSlots.set(stmt, this.slotCount);
          this.slotCount++;
          this.countExpression(stmt.iterable);
          this.bindSlot(stmt.binding);
          this.countBindings(stmt.body.statements);
          break;
        case 'field-assignment':
        // The dynamic variant needs the same two slots for a stronger reason: jsrt_set_prop can
        // GROW the object's slot storage, which allocates, so both operands must be rooted
        // across the call itself, not only across each other's evaluation.
        case 'dyn-field-assignment':
          // Target and value each get a rooted slot: C does not fix the order in which it
          // evaluates the arguments to jsrt_object_set, and the target has to stay reachable
          // while the value -- which may allocate -- is computed.
          this.indexSlots.set(stmt, this.slotCount);
          this.slotCount += 2;
          this.countExpression(stmt.target);
          this.countExpression(stmt.value);
          break;
        case 'super-call':
          // The same contiguous, rooted argv every call uses: receiver in slot zero, then the
          // base constructor's arguments. It is a CALL, so every operand must be reachable across
          // the allocations the later ones may perform.
          this.callSlots.set(stmt, this.slotCount);
          this.slotCount += 1 + stmt.args.length;
          this.countExpression(stmt.receiver);
          for (const arg of stmt.args) {
            this.countExpression(arg);
          }
          break;
        case 'class-declaration':
          // A class occupies no frame slot: it is not a value in this subset. What counting does
          // here is claim the descriptor's identity and register the member functions, which are
          // emitted as ordinary units with the receiver as parameter zero.
          if (!this.classIds.has(stmt.name)) {
            this.classIds.set(stmt.name, this.classes.length);
            this.classes.push(stmt);
          }
          if (stmt.ctor !== undefined) {
            this.registerFunction(stmt.ctor.fn, stmt.name);
          }
          for (const method of stmt.methods) {
            this.registerFunction(method.fn, method.name);
          }
          // A static is a binding in the ENCLOSING scope, so it takes a slot there exactly as a
          // `let` would -- which is what makes `C.count` an ordinary slot read downstream.
          this.countBindings(stmt.statics);
          break;
        case 'break-statement':
        case 'continue-statement':
          break;
        case 'throw-statement':
          this.countExpression(stmt.value);
          break;
        case 'try-statement':
          // A try with a finally claims TWO slots of its own: where the dispatch stashes a
          // caught exception while the finally body (which may allocate) runs, and the
          // completion code as a boxed number. Both must outlive a suspension: a yield/await
          // inside the try or the finally pops the C frame, and the resume's goto jumps over
          // whatever initializer a local would have had (plan-notes 153).
          if (stmt.catchBinding !== undefined) {
            this.bindSlot(stmt.catchBinding);
          }
          if (stmt.finallyBlock !== undefined) {
            this.trySlots.set(stmt, this.slotCount);
            this.slotCount += 2;
          }
          this.countBindings(stmt.tryBlock.statements);
          if (stmt.catchBlock !== undefined) {
            this.countBindings(stmt.catchBlock.statements);
          }
          if (stmt.finallyBlock !== undefined) {
            this.countBindings(stmt.finallyBlock.statements);
          }
          break;
        default: {
          const _exhaustive: never = stmt;
          throw new Error(
            `Unknown statement kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
          );
        }
      }
    }
  }

  private countExpression(expr: Expression): void {
    switch (expr.kind) {
      case 'logical-op':
        this.tempSlots.set(expr, this.slotCount);
        this.slotCount++;
        this.countExpression(expr.left);
        this.countExpression(expr.right);
        break;
      case 'binary-op':
        this.binarySlots.set(expr, this.slotCount);
        this.slotCount += 2;
        this.countExpression(expr.left);
        this.countExpression(expr.right);
        break;
      case 'unary-op':
      case 'typeof':
      case 'string-length':
      case 'array-length':
        this.countExpression(expr.operand);
        break;
      case 'conditional':
        this.tempSlots.set(expr, this.slotCount);
        this.slotCount++;
        this.countExpression(expr.condition);
        this.countExpression(expr.consequent);
        this.countExpression(expr.alternate);
        break;
      case 'update':
        this.tempSlots.set(expr, this.slotCount);
        this.slotCount++;
        if (expr.target.kind === 'index-access') {
          this.indexSlots.set(expr, this.slotCount);
          this.slotCount += 2;
          this.countExpression(expr.target.target);
          this.countExpression(expr.target.index);
        } else if (expr.target.kind === 'field-access' || expr.target.kind === 'dyn-field-access') {
          this.indexSlots.set(expr, this.slotCount);
          this.slotCount++;
          this.countExpression(expr.target.target);
        }
        if (expr.value !== undefined) {
          this.countExpression(expr.value);
        }
        break;
      // A check allocates nothing on the passing path and does not return on the failing one, so
      // the value it guards needs no slot beyond whatever building it already claimed.
      case 'boundary-check':
        this.countExpression(expr.value);
        break;
      case 'array-literal':
        this.arraySlots.set(expr, this.slotCount);
        this.slotCount += expr.elements.length;
        for (const element of expr.elements) {
          this.countExpression(element);
        }
        break;
      case 'index-access':
        this.indexSlots.set(expr, this.slotCount);
        this.slotCount += 2;
        this.countExpression(expr.target);
        this.countExpression(expr.index);
        break;
      // Two rooted slots for the same reason an index access takes two: `jsrt_delete` allocates
      // (it replays the receiver's shape chain) and can throw, so both operands must be visible to
      // the collector across the call rather than live in C temporaries.
      case 'get-iterator':
        this.tempSlots.set(expr, this.slotCount);
        this.slotCount++;
        this.countExpression(expr.operand);
        break;
      case 'delete-prop':
        this.indexSlots.set(expr, this.slotCount);
        this.slotCount += 2;
        this.countExpression(expr.target);
        this.countExpression(expr.key);
        break;
      case 'template-literal':
        {
          const count =
            expr.expressions.length + expr.quasis.filter((quasi) => quasi !== '').length;
          // TemplateExpression always has a substitution, so count cannot be zero; keep the
          // guard to make a hand-built invalid HIR fail in the emitter rather than emit slot -1.
          if (count === 0) {
            throw new Error('template literal has no parts; verifier should have caught it');
          }
          this.templateSlots.set(expr, { base: this.slotCount, count });
          this.slotCount += count;
        }
        for (const part of expr.expressions) {
          this.countExpression(part);
        }
        break;
      case 'console-log':
        // TWO OR MORE arguments get one contiguous rooted slot each, for the same reason a call
        // takes them: C's argument order is unspecified, so each has to be evaluated -- in source
        // order -- into a slot that outlives the next one's evaluation. Fewer than two take no
        // slot: there is no order to fix, nothing can run between the evaluation and the call, and
        // claiming one anyway was a frame slot nothing wrote.
        if (expr.args.length >= 2) {
          this.callSlots.set(expr, this.slotCount);
          this.slotCount += expr.args.length;
        }
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      case 'function':
        // Registered, not descended into: the body's slots belong to its own frame and are counted
        // when its unit is emitted.
        this.registerFunction(expr, expr.name ?? '');
        break;
      case 'call':
        // 1 + argc CONTIGUOUS slots -- the callee, then each argument -- so `argv` can point at the
        // first argument slot and every operand already evaluated stays rooted while the rest run.
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1 + expr.args.length;
        this.countExpression(expr.callee);
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      // `new` and a method call share the call layout: the RECEIVER occupies the slot a plain
      // call gives the callee, so `argv` still points at one contiguous run and the callee's
      // parameter zero is the object. For `new` that slot is also the result.
      case 'new':
      case 'method-call':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1 + expr.args.length;
        if (expr.kind === 'method-call') {
          this.countExpression(expr.target);
        }
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      // One rooted slot for the object itself, claimed BEFORE any entry is evaluated: an entry may
      // allocate, and the half-built object has to survive that. The shape's descriptor is
      // registered here for the same reason a class's is -- emission only ever looks one up.
      case 'object-literal':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        this.registerShape(expr);
        for (const entry of expr.entries) {
          this.countExpression(entry.value);
        }
        break;
      // The object slot plus ONE value scratch slot, reused entry by entry: jsrt_set_prop may
      // grow the slot storage, which allocates, so the value being stored must be rooted across
      // the call -- unlike jsrt_object_set, which only writes. `{}` has no entry to store and
      // therefore no scratch: a slot the emitter never writes is one the frame roots for nothing.
      case 'dyn-object-literal': {
        this.callSlots.set(expr, this.slotCount);
        // A get/set PAIR needs two scratch slots, not one: both closures are live when
        // jsrt_define_accessor is called, and building the second may allocate. One half alone
        // needs no more than an ordinary value does -- and the frame must be exactly as large as
        // what it roots, so a slot nothing writes is a test failure, not slack.
        const pair = expr.entries.some(
          (entry) => isAccessorEntry(entry) && entry.get !== undefined && entry.set !== undefined,
        );
        this.slotCount += expr.entries.length === 0 ? 1 : pair ? 3 : 2;
        for (const entry of expr.entries) {
          if (isAccessorEntry(entry)) {
            if (entry.get !== undefined) {
              this.countExpression(entry.get);
            }
            if (entry.set !== undefined) {
              this.countExpression(entry.set);
            }
            continue;
          }
          this.countExpression(entry.value);
        }
        break;
      }
      // Target first, then each argument, each in its own rooted slot. The runtime functions take
      // positional C arguments rather than an argv, so the run does not have to be contiguous --
      // but the SEQUENCING does have to exist: C leaves argument evaluation order unspecified, and
      // `m.set(f(), g())` must run f before g (plan-notes 55).
      // One rooted slot for the argument: the runtime walk allocates its result while the
      // argument must stay reachable, and a slot is the frame discipline's way to promise that.
      // `new Date(x)` is the same shape: the argument (a string, or another Date) must stay
      // reachable across the JSRTDate allocation.
      case 'date-new':
      case 'error-new':
      case 'json-parse':
      case 'json-stringify':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        this.countExpression(expr.arg);
        break;
      // One rooted slot for the awaited value: it has to survive the subscribe allocation on the
      // way out, and it holds the resumed result on the way back in. The state number is assigned
      // here too, because the dispatch switch is emitted ahead of the labels it jumps to.
      case 'await':
      case 'yield':
        this.tempSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        this.awaitStates.set(expr, this.awaitStates.size + 1);
        this.countExpression(expr.value);
        break;
      // The same one-slot promise json-parse makes: jsrt_promise_* allocates its result while the
      // argument must stay reachable.
      case 'promise-static':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        this.countExpression(expr.arg);
        break;
      case 'promise-construct':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        this.countExpression(expr.executor);
        break;
      case 'promise-method':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1 + expr.args.length;
        this.countExpression(expr.target);
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      // The same reachability promise, one slot per argument: an Object walk allocates its
      // result, and `Object.hasOwn(o, k)` must hold BOTH operands across the call.
      // `Date.UTC(y, m, ...)` sequences for the same reason, even though every operand is an
      // immediate: C would otherwise pick the order of the calls that produce them.
      case 'date-components':
      case 'date-static':
      case 'object-static':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += expr.args.length;
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      // Same discipline for a string or array op: the receiver and every argument stay rooted
      // while the rest are evaluated, and evaluation order is pinned against C's unspecified
      // argument order.
      // A regexp op is the same shape: `re.test(s)` holds the compiled pattern rooted while the
      // subject is evaluated, and the subject rooted while the engine allocates.
      // A date op is the same shape again: `d.setUTCHours(f(), g())` must run f before g, and
      // the receiver stays rooted while a string-producing op (toISOString) allocates.
      case 'array-op':
      case 'collection-op':
      case 'date-op':
      case 'regexp-op':
      case 'string-op':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1 + expr.args.length;
        this.countExpression(expr.target);
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      case 'iterator-next':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 2;
        this.countExpression(expr.target);
        this.countExpression(expr.sent);
        break;
      // Numbers are immediates -- nothing to root -- so the slots exist for SEQUENCING alone:
      // `Math.pow(f(), g())` must run f before g, and C leaves argument order unspecified. A
      // single argument has no order to fix and takes no slot at all.
      case 'math-call':
        if (expr.args.length > 1) {
          this.callSlots.set(expr, this.slotCount);
          this.slotCount += expr.args.length;
        }
        for (const arg of expr.args) {
          this.countExpression(arg);
        }
        break;
      // No slot: the read is a dereference with nothing allocated between evaluating the target
      // and using it, so there is no window in which the object could go unrooted.
      case 'field-access':
      // A match read is a property load or a header read -- same story, nothing allocated. So is
      // a regexp read: a struct field or a bit test.
      case 'match-read':
      case 'regexp-read':
      // Same as a field read: the test is a pointer comparison against a static descriptor, with
      // nothing allocated between evaluating the target and using it.
      case 'instanceof':
        this.countExpression(expr.target);
        break;
      case 'dyn-field-access':
        this.tempSlots.set(expr, this.slotCount++);
        this.countExpression(expr.target);
        break;
      // One allocator call with no operands: nothing is evaluated between the allocation and the
      // use of its result, so there is no window to root against.
      // One rooted slot for the pattern text, claimed before the FLAG string is allocated: the
      // two are two allocations, and the first has to survive the second.
      case 'regexp-literal':
        this.callSlots.set(expr, this.slotCount);
        this.slotCount += 1;
        break;
      case 'collection-new':
      case 'number-literal':
      case 'string-literal':
      case 'boolean-literal':
      case 'null-literal':
      case 'undefined-literal':
      case 'identifier':
      // No slot: the name is a C string literal in the emitted call, not a rooted value.
      case 'reference-error':
        break;
      default: {
        const _exhaustive: never = expr;
        throw new Error(
          `Unknown expression kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
        );
      }
    }
  }

  private emitStatement(stmt: Statement): void {
    switch (stmt.kind) {
      case 'declaration': {
        if (stmt.value !== undefined) {
          const value = this.emitExpression(stmt.value);
          this.appendLine(`${this.slotRef(stmt.name)} = ${value};`, stmt.span);
        }
        break;
      }

      case 'assignment': {
        const value = this.emitExpression(stmt.value);
        this.appendLine(`${this.slotRef(stmt.target)} = ${value};`, stmt.span);
        break;
      }

      case 'expression-statement': {
        // The console call's own statement form: bare, without the `undefined` that value position
        // has to append. See the `console-log` case in emitExpression for why the two differ.
        if (stmt.expression.kind === 'console-log') {
          this.appendLine(`${this.consoleCall(stmt.expression)};`, stmt.span);
          if (stmt.expression.method === 'table') {
            this.emitPendingCheck(stmt.span);
          }
          break;
        }
        const expr = this.emitExpression(stmt.expression);
        // A call already ran as its own statements; what came back is only the slot its result
        // sits in, and a bare `JSRT_LOCAL(3);` line would be a no-op -- one clang warns about.
        // An async unit spells its slots as environment reads, so both forms are matched.
        if (!/^(?:JSRT_(?:LOCAL|GLOBAL)\(\d+\)|_jsrt_env->slots\[\d+\])$/.test(expr)) {
          this.appendLine(`${expr};`, stmt.span);
        }
        break;
      }

      case 'if-statement': {
        const cond = this.emitExpression(stmt.condition);
        // ToBoolean, not the bool payload: `jsrt_as_bool` reads bit 0, which for a boxed double
        // is a mantissa bit. `if (1)` took the else branch until this was `jsrt_truthy`.
        this.appendLine(`if (jsrt_truthy(${cond})) {`, stmt.span);
        this.indent++;
        this.emitScope(stmt.consequent.statements);
        this.indent--;
        if (stmt.alternate) {
          this.appendLine('} else {', stmt.span);
          this.indent++;
          this.emitScope(stmt.alternate.statements);
          this.indent--;
        }
        this.appendLine('}', stmt.span);
        break;
      }

      case 'while-statement': {
        const id = this.enterLoop(stmt);
        this.emitIterEnvOpen(id, stmt.span);
        // The condition is captured, not emitted in place: it re-runs every iteration, so any
        // statements it needs (a call and its pending check) must land INSIDE the loop, and a
        // statement cannot sit inside `while (...)`. With none, the compact form survives.
        this.indent++;
        const cond = this.capture(() => this.emitExpression(stmt.condition));
        this.indent--;
        if (cond.lines.length === 0) {
          this.appendLine(`while (jsrt_truthy(${cond.value})) {`, stmt.span);
          this.indent++;
        } else {
          this.appendLine('while (1) {', stmt.span);
          this.indent++;
          this.lines.push(...cond.lines);
          this.usedLabels.add(`brk_${id}`);
          this.appendLine(`if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
        }
        this.emitIterEnvEnter(id, stmt.span);
        this.emitScope(stmt.body.statements);
        this.emitJumpTarget(`cont_${id}`, stmt.span);
        this.emitIterEnvCommit(id, stmt.span);
        this.indent--;
        this.appendLine('}', stmt.span);
        this.emitJumpTarget(`brk_${id}`, stmt.span);
        this.emitIterEnvClose(id, stmt.span);
        this.enclosing.pop();
        break;
      }

      case 'do-while-statement': {
        const id = this.enterLoop(stmt);
        this.emitIterEnvOpen(id, stmt.span);
        this.appendLine('do {', stmt.span);
        this.indent++;
        this.emitIterEnvEnter(id, stmt.span);
        this.emitScope(stmt.body.statements);
        // `continue` in a do/while jumps to the TEST, not past it -- the loop still gets to decide
        // whether to run again. Placing the target at the end of the body is what achieves that.
        this.emitJumpTarget(`cont_${id}`, stmt.span);
        this.emitIterEnvCommit(id, stmt.span);
        const cond = this.capture(() => this.emitExpression(stmt.condition));
        if (cond.lines.length === 0) {
          this.indent--;
          this.appendLine(`} while (jsrt_truthy(${cond.value}));`, stmt.span);
        } else {
          // The condition needed statements of its own, and `} while (...)` cannot hold them:
          // the test moves into the body's tail, still after the continue target.
          this.lines.push(...cond.lines);
          this.usedLabels.add(`brk_${id}`);
          this.appendLine(`if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
          this.indent--;
          this.appendLine('} while (1);', stmt.span);
        }
        this.emitJumpTarget(`brk_${id}`, stmt.span);
        this.emitIterEnvClose(id, stmt.span);
        this.enclosing.pop();
        break;
      }

      case 'for-statement': {
        if (stmt.init) {
          this.emitStatement(stmt.init);
        }
        const id = this.enterLoop(stmt);
        this.emitIterEnvOpen(id, stmt.span);
        // An absent condition is an infinite loop, not a false one. `while (1)` rather than
        // synthesising a `true` literal, so nothing downstream has to evaluate a fake node. A
        // present one is captured like while's: its statements must re-run every iteration.
        this.indent++;
        const condition = stmt.condition;
        const cond =
          condition === undefined ? undefined : this.capture(() => this.emitExpression(condition));
        this.indent--;
        if (cond === undefined || cond.lines.length === 0) {
          this.appendLine(
            `while (${cond === undefined ? '1' : `jsrt_truthy(${cond.value})`}) {`,
            stmt.span,
          );
          this.indent++;
        } else {
          this.appendLine('while (1) {', stmt.span);
          this.indent++;
          this.lines.push(...cond.lines);
          this.usedLabels.add(`brk_${id}`);
          this.appendLine(`if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
        }
        this.emitIterEnvEnter(id, stmt.span);
        this.emitScope(stmt.body.statements);
        // The continue target sits BEFORE the update, which is the one thing a `for` gets wrong if
        // it is lowered naively: `continue` skips the rest of the body but must still run `i++`,
        // or the loop never terminates.
        this.emitJumpTarget(`cont_${id}`, stmt.span);
        // Commit before the update so `i++` mutates the CONTROL env, not the clone the body
        // captured — otherwise `() => i` would see the post-increment value (1, 2, 3).
        this.emitIterEnvCommit(id, stmt.span);
        if (stmt.update) {
          this.emitStatement(stmt.update);
        }
        this.indent--;
        this.appendLine('}', stmt.span);
        this.emitJumpTarget(`brk_${id}`, stmt.span);
        this.emitIterEnvClose(id, stmt.span);
        this.enclosing.pop();
        break;
      }

      case 'switch-statement': {
        this.emitSwitch(stmt);
        break;
      }

      case 'break-statement':
      case 'continue-statement': {
        const wantsLoop = stmt.kind === 'continue-statement';
        const target = [...this.enclosing]
          .reverse()
          .find(
            (e) =>
              (wantsLoop ? e.isLoop : true) && (stmt.label === undefined || e.label === stmt.label),
          );
        if (target === undefined) {
          // The verifier rejects this as STA4029, so reaching it means the verifier was skipped.
          // Emitting a goto to a label that does not exist would fail in clang instead, against
          // generated C the user never wrote.
          throw new Error(`${stmt.kind} has no enclosing target; verifier should have caught it`);
        }
        const name = `${wantsLoop ? 'cont' : 'brk'}_${target.id}`;
        this.emitLoopJump(name, this.enclosing.indexOf(target), stmt.span);
        break;
      }

      case 'block': {
        if (stmt.label !== undefined) {
          const id = this.enterBreakable(stmt.label);
          this.emitScope(stmt.statements);
          this.emitJumpTarget(`brk_${id}`, stmt.span);
          this.enclosing.pop();
          break;
        }
        this.emitScope(stmt.statements);
        break;
      }

      case 'function-declaration':
        // Nothing here: the binding was emitted at the top of the unit (see emitHoistedFunctions)
        // and the body is a separate C function.
        break;

      case 'index-assignment': {
        const base = this.indexSlots.get(stmt);
        if (base === undefined) {
          throw new Error('index assignment was not registered during counting');
        }
        const target = this.slotAt(base);
        const index = this.slotAt(base + 1);
        const value = this.slotAt(base + 2);
        // Target, index, value -- the order the language evaluates them, spelled out so C cannot
        // choose another, and each landing in a rooted slot before the next one runs.
        this.appendLine(`${target} = ${this.emitExpression(stmt.target)};`, stmt.span);
        this.appendLine(`${index} = ${this.emitExpression(stmt.index)};`, stmt.span);
        this.appendLine(`${value} = ${this.emitExpression(stmt.value)};`, stmt.span);
        const set =
          stmt.target.type.kind === 'unknown'
            ? `jsrt_dyn_index_set(${target}, ${index}, ${value}, NULL)`
            : `jsrt_array_set(${target}, ${index}, ${value})`;
        this.appendLine(`${set};`, stmt.span);
        if (stmt.target.type.kind === 'unknown') {
          this.emitPendingCheck(stmt.span);
        }
        break;
      }

      case 'for-of-statement': {
        const slot = this.forOfSlots.get(stmt);
        if (slot === undefined) {
          throw new Error('for-of has no iterable slot; countBindings missed a node');
        }
        const iterable = this.slotAt(slot);
        this.appendLine(`${iterable} = ${this.emitExpression(stmt.iterable)};`, stmt.span);
        const id = this.enterLoop(stmt);
        this.emitIterEnvOpen(id, stmt.span);
        if (stmt.iterable.type.kind === 'iterator') {
          this.emitBoxedIteratorForOf(stmt, iterable, id);
          break;
        }
        // A suspendable unit cannot hold loop state in its C frame: a yield/await in the body
        // pops the frame and the resume's goto jumps over the initializer, so a C-local cursor
        // reads back as garbage. Box the walk instead — the cursor then lives in the heap
        // iterator, the same object a stored `arr.values()` already drives (plan-notes 153).
        if (this.inAsync || this.inGenerator) {
          const kind = stmt.iterable.type.kind;
          if (kind === 'map' || kind === 'set' || kind === 'array' || kind === 'string') {
            const box =
              kind === 'map'
                ? ITER_KINDS.map.entries
                : kind === 'set'
                  ? ITER_KINDS.set.values
                  : kind === 'string'
                    ? ITER_KINDS.string
                    : ITER_KINDS.array.values;
            this.appendLine(
              `${iterable} = jsrt_iterator_new(${iterable}, ${String(box)});`,
              stmt.span,
            );
            this.emitBoxedIteratorForOf(stmt, iterable, id);
            break;
          }
        }
        if (stmt.iterable.type.kind === 'map' || stmt.iterable.type.kind === 'set') {
          this.emitMapSetForOf(stmt, iterable, id);
          break;
        }
        const cursor = `jsrt_iter_${id}`;
        if (stmt.iterable.type.kind === 'string') {
          // Strings are immutable, so bounding on length is safe. The cursor advances 1 or 2
          // units per step — one code point, matching String.prototype[@@iterator].
          this.appendLine(
            `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_string_length(${iterable}); ) {`,
            stmt.span,
          );
          this.indent++;
          this.appendLine(
            `${this.slotRef(stmt.binding)} = jsrt_string_iter_next(${iterable}, &${cursor});`,
            stmt.span,
          );
        } else {
          // The length is re-read every iteration, not hoisted: the array iterator compares the
          // cursor against the CURRENT length on each step, so a body that shortens the array must
          // stop early. Hoisting it would walk off the end of a shrunk array.
          this.appendLine(
            `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_as_array(${iterable})->length; ${cursor}++) {`,
            stmt.span,
          );
          this.indent++;
          this.emitArrayForOfYield(stmt, iterable, cursor);
        }
        this.emitIterEnvEnter(id, stmt.span);
        this.emitScope(stmt.body.statements);
        this.emitJumpTarget(`cont_${id}`, stmt.span);
        this.emitIterEnvCommit(id, stmt.span);
        this.indent--;
        this.appendLine('}', stmt.span);
        this.emitJumpTarget(`brk_${id}`, stmt.span);
        this.emitIterEnvClose(id, stmt.span);
        this.enclosing.pop();
        break;
      }

      case 'return-statement': {
        if (!this.inFunction) {
          throw new Error('return outside a function; verifier should have caught it');
        }
        const slot = this.slotAt(this.returnSlot);
        if (stmt.value === undefined) {
          if (this.tryFinallyStack.length === 0) {
            if (this.inAsync) {
              this.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', stmt.span);
              break;
            }
            if (this.inGenerator) {
              this.emitGeneratorSettle('JSRT_UNDEFINED', stmt.span);
              break;
            }
            this.appendLine('JSRT_FRAME_POP();', stmt.span);
            this.appendLine('return JSRT_UNDEFINED;', stmt.span);
            break;
          }
          // An enclosing finally must run first: park the value, route only the jump.
          this.appendLine(`${slot} = JSRT_UNDEFINED;`, stmt.span);
          this.emitReturnJump(stmt.span);
          break;
        }
        const value = this.emitExpression(stmt.value);
        if (this.tryFinallyStack.length !== 0) {
          this.appendLine(`${slot} = ${value};`, stmt.span);
          this.emitReturnJump(stmt.span);
          break;
        }
        // Evaluate into a rooted slot FIRST, pop SECOND, read THIRD. Popping before evaluating
        // would run the expression -- and any allocation in it -- with this frame's locals
        // invisible to the collector. An async return settles instead of returning, and settling
        // allocates, so it sits inside the same window.
        if (this.inAsync) {
          this.appendLine(`${slot} = ${value};`, stmt.span);
          this.emitAsyncSettle('jsrt_async_return', slot, stmt.span);
          break;
        }
        if (this.inGenerator) {
          this.appendLine(`${slot} = ${value};`, stmt.span);
          this.emitGeneratorSettle(slot, stmt.span);
          break;
        }
        this.appendLine(`return (${slot} = ${value}, JSRT_FRAME_POP(), ${slot});`, stmt.span);
        break;
      }

      case 'field-assignment': {
        this.emitFieldWrite(
          stmt,
          (target, value) => `jsrt_object_set(${target}, ${stmt.slot}, ${value})`,
          'field assignment was not registered during counting',
        );
        break;
      }

      // Same shape as field-assignment; the differences are the slow-path entry point, the KEY
      // (a string, not a slot -- the shape table resolves it), and the per-site cache. A frozen
      // object throws, so a pending check follows.
      case 'dyn-field-assignment': {
        this.emitFieldWrite(
          stmt,
          (target, value) =>
            `jsrt_set_prop(${target}, ${cNameLiteral(stmt.field)}, ${value}, &${this.icSite()})`,
          'dynamic field assignment was not registered during counting',
        );
        break;
      }

      case 'super-call': {
        const base = this.callSlots.get(stmt);
        if (base === undefined) {
          throw new Error('super call was not registered during counting');
        }
        const ctor = this.classAt(stmt.className).ctor;
        // A base with nothing to run emits nothing. It can take no arguments either -- the checker
        // rejects arguments to a constructor that does not exist -- so no side effect is skipped.
        if (ctor === undefined) {
          break;
        }
        const parts: string[] = [];
        this.sequencePart(parts, stmt.receiver, stmt.span, (v) => `${this.slotAt(base)} = ${v}`);
        stmt.args.forEach((arg, index) => {
          this.sequencePart(
            parts,
            arg,
            stmt.span,
            (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
          );
        });
        parts.push(
          `jsrt_call(${this.closureValue(ctor.fn)}, ${1 + stmt.args.length}, &${this.slotAt(base)})`,
        );
        this.flushParts(parts, stmt.span);
        this.emitPendingCheck(stmt.span);
        break;
      }

      // Nothing runs here. A class's descriptor and its member functions are file-scope, and the
      // name is not a binding -- so the declaration's whole effect happened at compile time.
      case 'class-declaration':
        // The class itself emits nothing -- its descriptor is file-scope and its members are
        // function units. Its statics DO emit, here, which is what puts their initializers in
        // source order: a static is live from the class declaration onward, not before.
        for (const decl of stmt.statics) {
          this.emitStatement(decl);
        }
        break;

      case 'throw-statement': {
        const value = this.emitExpression(stmt.value);
        // Overwrite-on-throw is the pending cell's contract (runtime/src/jsrt_throw.c): a throw
        // inside a finally REPLACES whatever completion was pending, which is the language rule.
        this.appendLine(`jsrt_throw(${value});`, stmt.span);
        this.appendLine(`goto ${this.currentPad()};`, stmt.span);
        break;
      }

      case 'try-statement': {
        this.emitTry(stmt);
        break;
      }

      default: {
        const _exhaustive: never = stmt;
        throw new Error(
          `Unknown statement kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
        );
      }
    }
  }

  /* Map/Set for-of holds `iterating` for the walk so compaction cannot renumber the cursor.
   * Return, throw, and a break out of THIS loop must drop that count; continue must not.
   *
   * The cleanup is a try/finally with no catch: throw jumps to a pad that ends the walk and
   * re-enters the enclosing pad with the exception still pending, and return/outer-break route
   * through `fin` the way a real finally does. `enclosingDepth` is the parent of this loop, so
   * continue (and a break that lands on `brk` just before `fin`) stay inside. */
  private emitMapSetForOf(stmt: ForOfStatement, iterable: string, id: number): void {
    const span = stmt.span;
    const cursor = `jsrt_iter_${id}`;
    const key = `_jsrt_k_${id}`;
    const val = `_jsrt_v_${id}`;
    const coll = `_jsrt_coll_${id}`;
    // A bare `return` through this cleanup parks `undefined` in `returnSlot`, which is slot 0 when
    // the function never returns a value — the same index as the iterable. Hold the collection in
    // a C local so `iter_end` cannot decrement through that overwrite.
    this.appendLine(`jsrt_value ${coll} = ${iterable};`, span);
    this.appendLine(`jsrt_map_iter_begin(${coll});`, span);

    const tryId = this.tryCount++;
    const comp = `_jsrt_mapcomp_${tryId}`;
    const fin = `_jsrt_mapfin_${tryId}`;
    const finThr = `_jsrt_mapfinthr_${tryId}`;
    this.appendLine('{', span);
    this.indent++;
    this.appendLine(`int ${comp} = 0;`, span);
    const scope: TryFinallyScope = {
      compVar: comp,
      compBoxed: false,
      finLabel: fin,
      enclosingDepth: this.enclosing.length - 1,
      routes: new Map(),
    };
    this.tryFinallyStack.push(scope);
    this.padStack.push(finThr);

    this.appendLine(`jsrt_value ${key};`, span);
    this.appendLine(`jsrt_value ${val};`, span);
    this.appendLine(
      `for (uint32_t ${cursor} = 0; jsrt_map_iter_step(${coll}, &${cursor}, &${key}, &${val}); ) {`,
      span,
    );
    this.indent++;
    this.emitMapSetForOfYield(stmt, key, val);
    this.emitIterEnvEnter(id, span);
    this.emitScope(stmt.body.statements);
    this.emitJumpTarget(`cont_${id}`, span);
    this.emitIterEnvCommit(id, span);
    this.indent--;
    this.appendLine('}', span);

    this.padStack.pop();
    this.usedLabels.add(fin);
    this.appendLine(`goto ${fin};`, span);
    if (this.usedLabels.has(finThr)) {
      this.appendLine(`${finThr}: ;`, span);
      this.appendLine(`jsrt_map_iter_end(${coll});`, span);
      this.appendLine(`goto ${this.currentPad()};`, span);
    }
    this.emitJumpTarget(`brk_${id}`, span);
    this.tryFinallyStack.pop();
    this.appendLine(`${fin}: ;`, span);
    this.appendLine(`jsrt_map_iter_end(${coll});`, span);
    for (const route of scope.routes.values()) {
      this.appendLine(`if (${comp} == ${route.code}) {`, span);
      this.indent++;
      route.action();
      this.indent--;
      this.appendLine('}', span);
    }
    this.indent--;
    this.appendLine('}', span);
    this.emitIterEnvClose(id, span);
    this.enclosing.pop();
  }

  private emitArrayForOfYield(stmt: ForOfStatement, iterable: string, cursor: string): void {
    const bind = this.slotRef(stmt.binding);
    if (stmt.view === 'keys') {
      this.appendLine(`${bind} = jsrt_number((double)${cursor});`, stmt.span);
      return;
    }
    const element = `jsrt_as_array(${iterable})->elements[${cursor}]`;
    if (stmt.view === 'entries') {
      const pair = `_jsrt_pair_${cursor}`;
      this.appendLine(
        `jsrt_value ${pair}[2] = { jsrt_number((double)${cursor}), ${element} };`,
        stmt.span,
      );
      this.appendLine(`${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
      return;
    }
    this.appendLine(`${bind} = ${element};`, stmt.span);
  }

  private emitMapSetForOfYield(stmt: ForOfStatement, key: string, val: string): void {
    const bind = this.slotRef(stmt.binding);
    const map = stmt.iterable.type.kind === 'map';
    if (stmt.view === 'keys' || (!map && stmt.view !== 'entries')) {
      this.appendLine(`${bind} = ${key};`, stmt.span);
      return;
    }
    if (stmt.view === 'values' && map) {
      this.appendLine(`${bind} = ${val};`, stmt.span);
      return;
    }
    const pair = `_jsrt_pair_${key}`;
    const second = map ? val : key;
    this.appendLine(`jsrt_value ${pair}[2] = { ${key}, ${second} };`, stmt.span);
    this.appendLine(`${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
  }

  private emitBoxedIteratorForOf(stmt: ForOfStatement, iterable: string, id: number): void {
    const span = stmt.span;
    const item = `_jsrt_item_${id}`;
    this.appendLine(`jsrt_value ${item};`, span);
    this.appendLine(`for (;;) {`, span);
    this.indent++;
    this.appendLine(`if (!jsrt_iterator_step(${iterable}, &${item})) {`, span);
    this.indent++;
    // A generator's step can throw: false then means "stop AND unwind", not "exhausted".
    this.appendLine(`if (jsrt_pending()) { goto ${this.currentPad()}; }`, span);
    this.appendLine('break;', span);
    this.indent--;
    this.appendLine('}', span);
    this.appendLine(`${this.slotRef(stmt.binding)} = ${item};`, span);
    this.emitIterEnvEnter(id, span);
    this.emitScope(stmt.body.statements);
    this.emitJumpTarget(`cont_${id}`, span);
    this.emitIterEnvCommit(id, span);
    this.indent--;
    this.appendLine('}', span);
    this.emitJumpTarget(`brk_${id}`, span);
    this.emitIterEnvClose(id, span);
    this.enclosing.pop();
  }

  /** Opens a loop's jump scope. `stmt` is what ties the loop to the two suspension slots counted
   * for it (`iterEnvSlots`): the id is minted here, at emission time, and the slots had to exist
   * before it, so the statement is the only key both passes share. */
  private enterLoop(stmt: { label?: string; perIterationEnv?: true }): number {
    const id = this.loopCount++;
    const iterEnv = stmt.perIterationEnv === true && this.envMap.size > 0;
    if (iterEnv) {
      const base = this.iterEnvSlots.get(stmt as unknown as Statement);
      if (base === undefined) {
        throw new Error('per-iteration loop was not counted; countBindings missed a node');
      }
      this.iterEnvBase.set(id, base);
    }
    this.enclosing.push({
      id,
      isLoop: true,
      ...(stmt.label !== undefined && { label: stmt.label }),
      ...(iterEnv && { iterEnv: true }),
    });
    return id;
  }

  /** Claims the two slots a per-iteration loop needs when it can be suspended across: nothing when
   * the loop has no environment to clone, so an ordinary `for` pays no slot. */
  private countIterEnvSlots(stmt: Statement): void {
    if (!('perIterationEnv' in stmt) || !stmt.perIterationEnv) {
      return;
    }
    if (this.envMap.size === 0) {
      return;
    }
    this.iterEnvSlots.set(stmt, this.slotCount);
    this.slotCount += 2;
  }

  private enterBreakable(label: string): number {
    const id = this.loopCount++;
    this.enclosing.push({ id, isLoop: false, label });
    return id;
  }

  private iterEnvOf(id: number): boolean {
    return this.enclosing.some((e) => e.id === id && e.iterEnv === true);
  }

  /* Re-roots the live frame at a new environment. Which frame that IS depends on scope: inside a
   * function it is the `JSRT_FRAME(n)` the unit opened, and at module top level it is the globals
   * frame, which is the only one a sync `main` has. Both spellings assign the same field. */
  private frameEnvLine(env: string): string {
    return this.inFunction ? `JSRT_FRAME_ENV(${env});` : `JSRT_GLOBALS_ENV(${env});`;
  }

  /** The two slots a per-iteration loop keeps its environment state in, as lvalues. */
  private iterEnvState(id: number): { saved: string; iter: string } {
    const base = this.iterEnvBase.get(id);
    if (base === undefined) {
      throw new Error('per-iteration loop has no suspension slots; countBindings missed a node');
    }
    return { saved: this.slotAt(base), iter: this.slotAt(base + 1) };
  }

  /* Opening, entering, committing and closing a loop that clones its environment per iteration.
   *
   * The state lives in two SLOTS rather than two C locals -- see `iterEnvSlots` for why, and note
   * what that buys: the same four emitters serve a sync unit (frame slots) and an async or
   * generator unit (environment slots, which survive a suspension), so a loop body can `await`
   * without a second code path. The slots hold raw `JSRTEnv *` bit-cast into `jsrt_value`; nothing
   * reads them as values, and the collector's mark procedure traces the pointer. */

  private emitIterEnvOpen(id: number, span: Span): void {
    if (!this.iterEnvOf(id)) {
      return;
    }
    const { saved, iter } = this.iterEnvState(id);
    this.appendLine(`${saved} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
    this.appendLine(`${iter} = (jsrt_value)0;`, span);
  }

  private emitIterEnvEnter(id: number, span: Span): void {
    if (!this.iterEnvOf(id)) {
      return;
    }
    const { saved, iter } = this.iterEnvState(id);
    this.appendLine(`if (${saved} != (jsrt_value)0) {`, span);
    this.indent++;
    this.appendLine(`_jsrt_env = jsrt_env_clone((JSRTEnv *)(uintptr_t)${saved});`, span);
    this.appendLine(`${iter} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
    this.appendLine(this.frameEnvLine('_jsrt_env'), span);
    this.indent--;
    this.appendLine('}', span);
  }

  private emitIterEnvCommit(id: number, span: Span): void {
    if (!this.iterEnvOf(id)) {
      return;
    }
    const { saved, iter } = this.iterEnvState(id);
    this.appendLine(`if (${iter} != (jsrt_value)0) {`, span);
    this.indent++;
    this.appendLine(
      `jsrt_env_copy_slots((JSRTEnv *)(uintptr_t)${saved}, (JSRTEnv *)(uintptr_t)${iter});`,
      span,
    );
    this.appendLine(`_jsrt_env = (JSRTEnv *)(uintptr_t)${saved};`, span);
    this.appendLine(this.frameEnvLine('_jsrt_env'), span);
    this.indent--;
    this.appendLine('}', span);
  }

  private emitIterEnvClose(_id: number, _span: Span): void {
    // Nothing to close: the state is slots, not a C block's locals. The method stays because its
    // call sites sit beside `emitJumpTarget('brk_…')` and read as the pair they are.
  }

  private commitIterEnvs(fromIndexInclusive: number, span: Span): void {
    for (let i = this.enclosing.length - 1; i >= fromIndexInclusive; i--) {
      const e = this.enclosing[i];
      if (e !== undefined && e.iterEnv === true) {
        this.emitIterEnvCommit(e.id, span);
      }
    }
  }

  /* A `label: ;` line, written only if something jumps to it. The trailing `;` is not cosmetic:
   * before C23 a label must be followed by a statement, and a label at the end of a block is not. */
  private emitJumpTarget(name: string, span: Span): void {
    if (this.usedLabels.has(name)) {
      this.appendLine(`${name}: ;`, span);
    }
  }

  /* Where control goes when an exception is pending: the innermost try's landing pad, or the
   * unit's own unwind tail when no try is open. Asking marks the pad used, which is what decides
   * whether the tail -- or a catch that nothing in its try body can reach -- is emitted at all. */
  private currentPad(): string {
    const pad = this.padStack.at(-1);
    if (pad === undefined) {
      this.unwindUsed = true;
      return '_jsrt_unwind';
    }
    this.usedLabels.add(pad);
    return pad;
  }

  /* The check after every operation that can throw. Throwing operations are emitted as their own
   * STATEMENTS -- never inside a consumer's expression -- precisely so this line can sit between
   * the operation and whatever consumes its result: a callee that threw left `undefined` behind,
   * and nothing may observe it. */
  private emitFieldWrite(
    stmt: FieldAssignment | DynFieldAssignment,
    write: (target: string, value: string) => string,
    missing: string,
  ): void {
    const base = this.indexSlots.get(stmt);
    if (base === undefined) {
      throw new Error(missing);
    }
    const target = this.slotAt(base);
    const value = this.slotAt(base + 1);
    const parts: string[] = [];
    this.sequencePart(parts, stmt.target, stmt.span, (v) => `${target} = ${v}`);
    this.sequencePart(parts, stmt.value, stmt.span, (v) => `${value} = ${v}`);
    parts.push(write(target, value));
    this.flushParts(parts, stmt.span);
    this.emitPendingCheck(stmt.span);
  }

  private emitPendingCheck(span: Span): void {
    this.appendLine(`if (jsrt_pending()) { goto ${this.currentPad()}; }`, span);
  }

  /* Runs `f` against a private buffer and hands back what it appended plus its value. Loop
   * conditions and short-circuit right operands need this: they are re-evaluated somewhere other
   * than where the emitter is currently appending, so any statements the operand needs (a call
   * and its pending check) must be captured and replayed at the evaluation point. */
  private capture(f: () => string): { readonly lines: string[]; readonly value: string } {
    const saved = this.lines;
    const buffer: string[] = [];
    this.lines = buffer;
    const value = f();
    this.lines = saved;
    return { lines: buffer, value };
  }

  /* Evaluates one operand of a comma sequence under construction. A call-free operand joins the
   * sequence via `use` and keeps the compact single-line shape. One that produced statements of
   * its own (a call and its pending check) forces the sequence so far out as a statement FIRST:
   * the language already evaluated those operands, so their values must be sitting in their
   * rooted slots before this operand's calls run -- and then lands its own `use` line after its
   * statements. Returns whether it flushed, which tells the caller the compact shape is gone. */
  private sequencePart(
    parts: string[],
    operand: Expression,
    span: Span,
    use: (value: string) => string,
  ): boolean {
    const captured = this.capture(() => this.emitExpression(operand));
    if (captured.lines.length === 0) {
      parts.push(use(captured.value));
      return false;
    }
    this.flushParts(parts, span);
    this.lines.push(...captured.lines);
    this.appendLine(`${use(captured.value)};`, span);
    return true;
  }

  private flushParts(parts: string[], span: Span): void {
    if (parts.length > 0) {
      this.appendLine(`${parts.join(', ')};`, span);
      parts.length = 0;
    }
  }

  /* `goto` to a loop/switch label, routed through any finally standing between here and the
   * target. The innermost try decides: if the target construct opened BEFORE the try did, the
   * jump leaves the protected code and the finally must run first. The dispatch re-invokes this
   * with that scope popped, which chains the jump through the next finally outward in turn. */
  private emitLoopJump(name: string, targetIndex: number, span: Span): void {
    const scope = this.tryFinallyStack.at(-1);
    if (scope !== undefined && scope.enclosingDepth > targetIndex) {
      this.routeJump(scope, name, span, () => this.emitLoopJump(name, targetIndex, span));
      return;
    }
    const continuing = name.startsWith('cont_');
    this.commitIterEnvs(continuing ? targetIndex + 1 : targetIndex, span);
    this.usedLabels.add(name);
    this.appendLine(`goto ${name};`, span);
  }

  /* A `return` whose enclosing finally bodies must run first. The value already sits in the
   * (rooted) return slot; only the JUMP routes, and the same chaining as emitLoopJump applies. */
  private emitReturnJump(span: Span): void {
    const scope = this.tryFinallyStack.at(-1);
    if (scope === undefined) {
      this.commitIterEnvs(0, span);
      const slot = this.slotAt(this.returnSlot);
      if (this.inAsync) {
        this.emitAsyncSettle('jsrt_async_return', slot, span);
        return;
      }
      if (this.inGenerator) {
        this.emitGeneratorSettle(slot, span);
        return;
      }
      this.appendLine(`return (JSRT_FRAME_POP(), ${slot});`, span);
      return;
    }
    this.routeJump(scope, 'return', span, () => this.emitReturnJump(span));
  }

  /* Records the jump in the completion variable and enters the finally. One code per DISTINCT
   * jump, allocated on first use: two `break`s to the same loop share a code and a dispatch arm,
   * a `break` and a `return` do not. Codes 0 (normal) and 1 (throw) are reserved. */
  private routeJump(scope: TryFinallyScope, key: string, span: Span, action: () => void): void {
    let route = scope.routes.get(key);
    if (route === undefined) {
      route = { code: 2 + scope.routes.size, action };
      scope.routes.set(key, route);
    }
    this.appendLine(
      scope.compBoxed
        ? `${scope.compVar} = jsrt_number(${String(route.code)});`
        : `${scope.compVar} = ${String(route.code)};`,
      span,
    );
    this.appendLine(`goto ${scope.finLabel};`, span);
  }

  /* Landing-pad lowering, the shape plan.md Task 3.10 and docs/VALUE.md §6 prescribe: no setjmp,
   * no unwinder -- a throwing call is followed by `if (jsrt_pending()) goto pad;`, and this emits
   * the pads those checks target. */
  private emitTry(stmt: TryStatement): void {
    const id = this.tryCount++;
    if (stmt.finallyBlock === undefined) {
      this.emitTryCatch(stmt, id);
    } else {
      this.emitTryFinally(stmt, stmt.finallyBlock, id);
    }
  }

  private emitTryCatch(stmt: TryStatement, id: number): void {
    const catchPad = `_jsrt_cat_${id}`;
    this.padStack.push(catchPad);
    this.emitStatement(stmt.tryBlock);
    this.padStack.pop();
    if (!this.usedLabels.has(catchPad)) {
      // No operation in the try body jumped to the pad, so the catch is unreachable and emitting it
      // would put dead C behind an unconditional goto. That is an OPTIMIZATION resting on an
      // invariant: every runtime call that can leave a pending exception is followed by a
      // `emitPendingCheck`, and that check is what both reports the failure and keeps this pad
      // alive. A throwing operation without the check does not merely lose its own diagnostic --
      // it takes the whole catch block with it, which is how `"length" in "abc"` came to print
      // `false` instead of a caught TypeError (plan-notes 220).
      return;
    }
    const end = `_jsrt_try_end_${id}`;
    this.usedLabels.add(end);
    this.appendLine(`goto ${end};`, stmt.span);
    this.appendLine(`${catchPad}: ;`, stmt.span);
    this.emitCatchEntry(stmt);
    if (stmt.catchBlock !== undefined) {
      this.emitStatement(stmt.catchBlock);
    }
    this.appendLine(`${end}: ;`, stmt.span);
  }

  /* The completion-code protocol: 0 falls through the dispatch (normal completion), 1 rethrows
   * the stashed exception, 2+ re-perform a recorded jump. The dispatch sits AFTER the finally
   * body, so a finally that itself throws or jumps never reaches it -- which is the language
   * rule: the finally's own completion replaces the one on the way through. */
  private emitTryFinally(stmt: TryStatement, finallyBlock: Block, id: number): void {
    const finThr = `_jsrt_finthr_${id}`;
    const fin = `_jsrt_fin_${id}`;
    const excIndex = this.trySlots.get(stmt);
    if (excIndex === undefined) {
      throw new Error('try/finally has no exception slot; countBindings missed a node');
    }
    const exc = this.slotAt(excIndex);
    // The completion code is a counted slot, boxed as a number: a suspension between the route
    // and the dispatch pops the C frame, and only a slot survives that (countBindings claims the
    // pair -- exc, then comp -- so they sit adjacently).
    const comp = this.slotAt(excIndex + 1);
    this.appendLine('{', stmt.span);
    this.indent++;
    this.appendLine(`${comp} = jsrt_number(0);`, stmt.span);
    const scope: TryFinallyScope = {
      compVar: comp,
      compBoxed: true,
      finLabel: fin,
      enclosingDepth: this.enclosing.length,
      routes: new Map(),
    };
    this.tryFinallyStack.push(scope);
    const catchPad = stmt.catchBlock === undefined ? finThr : `_jsrt_cat_${id}`;
    this.padStack.push(catchPad);
    this.emitStatement(stmt.tryBlock);
    this.padStack.pop();
    this.usedLabels.add(fin);
    this.appendLine(`goto ${fin};`, stmt.span);
    if (stmt.catchBlock !== undefined && this.usedLabels.has(catchPad)) {
      this.appendLine(`${catchPad}: ;`, stmt.span);
      this.emitCatchEntry(stmt);
      this.padStack.push(finThr);
      this.emitStatement(stmt.catchBlock);
      this.padStack.pop();
      this.appendLine(`goto ${fin};`, stmt.span);
    }
    // The scope pops HERE: a return/break/throw inside the finally body itself does not route
    // through this finally again -- it replaces the pending completion, which is exactly what
    // leaving comp undispatched does.
    this.tryFinallyStack.pop();
    if (this.usedLabels.has(finThr)) {
      this.appendLine(`${finThr}: ;`, stmt.span);
      this.appendLine(`${comp} = jsrt_number(1);`, stmt.span);
      // Take BEFORE the finally body runs: the body may itself throw, and its exception must
      // find the cell empty to overwrite, while this one waits in a rooted slot.
      this.appendLine(`${exc} = jsrt_take_exception();`, stmt.span);
    }
    this.appendLine(`${fin}: ;`, stmt.span);
    this.emitStatement(finallyBlock);
    if (this.usedLabels.has(finThr)) {
      this.appendLine(
        `if (jsrt_number_value(${comp}) == 1) { jsrt_throw(${exc}); goto ${this.currentPad()}; }`,
        stmt.span,
      );
    }
    for (const route of scope.routes.values()) {
      this.appendLine(`if (jsrt_number_value(${comp}) == ${String(route.code)}) {`, stmt.span);
      this.indent++;
      route.action();
      this.indent--;
      this.appendLine('}', stmt.span);
    }
    this.indent--;
    this.appendLine('}', stmt.span);
  }

  /* Taking the exception is what re-arms the cell for the next throw; a binding-less catch still
   * takes, it just has nowhere to put the value. */
  private emitCatchEntry(stmt: TryStatement): void {
    if (stmt.catchBinding !== undefined) {
      this.appendLine(`${this.slotRef(stmt.catchBinding)} = jsrt_take_exception();`, stmt.span);
    } else {
      this.appendLine('(void)jsrt_take_exception();', stmt.span);
    }
  }

  /* A JavaScript switch is not a C switch and cannot be emitted as one. C requires integer
   * constant cases; JS compares with STRICT EQUALITY against arbitrary expressions, so
   * `case 'x'` and `case n + 1` are both legal. JS also tries `default` LAST no matter where it
   * appears, while still falling through from whatever clause precedes it textually.
   *
   * All three fall out of one shape: run every case test in source order, jump to the matching
   * clause, and lay the clause bodies out in source order so fall-through is simply not jumping. */
  private emitSwitch(stmt: SwitchStatement): void {
    const id = this.loopCount++;
    // A switch is breakable but not continuable: `continue` inside one belongs to the enclosing
    // loop, which is why this pushes isLoop: false rather than reusing enterLoop.
    this.enclosing.push({
      id,
      isLoop: false,
      ...(stmt.label !== undefined && { label: stmt.label }),
    });

    const slot = this.switchSlots.get(stmt);
    if (slot === undefined) {
      throw new Error('switch has no discriminant slot; countBindings missed a node');
    }
    const disc = this.slotAt(slot);
    this.appendLine(`${disc} = ${this.emitExpression(stmt.discriminant)};`, stmt.span);

    // The clause list is ONE block scope, not one per clause (docs on SwitchClause say so), so the
    // function declarations of every clause hoist together and ahead of the dispatch. Hoisting
    // per clause instead would leave a declaration uninitialized whenever the jump lands past it.
    for (const clause of stmt.clauses) {
      this.emitHoistedFunctions(clause.statements);
    }

    let defaultIndex: number | undefined;
    stmt.clauses.forEach((clause, i) => {
      if (clause.test === undefined) {
        defaultIndex = i;
        return;
      }
      const test = this.emitExpression(clause.test);
      this.appendLine(`if (jsrt_strict_equals(${disc}, ${test})) goto case_${id}_${i};`, stmt.span);
    });

    // Every test failed. `default` is the fallback wherever it was written; with no default at
    // all, the whole statement is skipped.
    if (defaultIndex === undefined) {
      this.usedLabels.add(`brk_${id}`);
      this.appendLine(`goto brk_${id};`, stmt.span);
    } else {
      this.appendLine(`goto case_${id}_${defaultIndex};`, stmt.span);
    }

    stmt.clauses.forEach((clause, i) => {
      // Unconditional: every clause label is the target of either its own test or the default
      // jump above, so none of them can be unused.
      this.appendLine(`case_${id}_${i}: ;`, stmt.span);
      this.indent++;
      for (const s of clause.statements) {
        this.emitStatement(s);
      }
      this.indent--;
    });

    this.emitJumpTarget(`brk_${id}`, stmt.span);
    this.enclosing.pop();
  }

  /** The bare C call behind a console node — no value appended.
   *
   * The operand list is positional; the WIDTH picks the entry point, which is the only thing the
   * two short forms need from it. Both call sites (value position and statement position) go
   * through here so the width-to-entry-point rule is stated once.
   *
   * With TWO OR MORE arguments each one is evaluated into its own rooted slot, in source order,
   * BEFORE the call: C evaluates function arguments in an unspecified order, so
   * `console.assert(a[0] === 1, f(a))` ran `f` first and then read the array it had just mutated
   * -- the assertion reported a failure Node never sees (plan-notes 221). The slots also keep
   * every argument alive across the next one's evaluation. One argument needs neither: there is no
   * order to fix and nothing can run between its evaluation and the call. */
  private consoleCall(expr: ConsoleLogCall): string {
    const fn = consoleEntryPoint(expr.method, expr.args.length);
    if (fn === null) {
      throw new Error(
        `console.${expr.method} has no entry point for ${String(expr.args.length)} arguments`,
      );
    }
    if (expr.args.length < 2) {
      const operands = expr.args.map((arg) => this.emitExpression(arg)).join(', ');
      return `${fn}(${operands})`;
    }
    const base = this.callSlots.get(expr);
    if (base === undefined) {
      throw new Error('console arguments were not registered during counting');
    }
    const parts: string[] = [];
    expr.args.forEach((arg, index) => {
      this.sequencePart(parts, arg, expr.span, (v) => `${this.slotAt(base + index)} = ${v}`);
    });
    this.flushParts(parts, expr.span);
    const operands = expr.args.map((_, index) => this.slotAt(base + index)).join(', ');
    return `${fn}(${operands})`;
  }

  private emitExpression(expr: Expression): string {
    switch (expr.kind) {
      case 'number-literal': {
        return `jsrt_number(${cDoubleLiteral(expr.value)})`;
      }

      case 'string-literal': {
        return this.emitStringLiteral(expr.value);
      }

      case 'boolean-literal': {
        return `jsrt_bool(${expr.value ? 'true' : 'false'})`;
      }

      case 'null-literal': {
        return 'JSRT_NULL';
      }

      case 'undefined-literal': {
        return 'JSRT_UNDEFINED';
      }

      case 'identifier': {
        return this.slotRef(expr.name);
      }

      case 'binary-op': {
        return this.emitBinaryOp(expr);
      }

      case 'unary-op': {
        return UNARY_EMITTERS[expr.operator](this.emitExpression(expr.operand));
      }

      case 'typeof': {
        return `jsrt_typeof(${this.emitExpression(expr.operand)})`;
      }

      // The one expression whose value never reaches its consumer. The call always throws, so the
      // pending check on the very next line always jumps to the landing pad; `JSRT_UNDEFINED` is
      // emitted only because C needs the expression to HAVE a value, and nothing ever reads it.
      // Appending lines here is what makes it correct inside a larger expression: `sequencePart`
      // sees a non-empty buffer and flushes the operands evaluated so far out as a statement first,
      // which keeps the language's evaluation order across the throw.
      case 'reference-error': {
        this.appendLine(`jsrt_reference_error("${this.escapeCString(expr.name)}");`, expr.span);
        this.emitPendingCheck(expr.span);
        return 'JSRT_UNDEFINED';
      }

      // The location is a string literal in the emitted C rather than something reconstructed at
      // failure time: the emitter is the only party that still knows where this value came from,
      // and a check that could not say where it failed would be nearly useless in a compiled
      // binary with no source map at runtime.
      case 'boundary-check': {
        const check = CHECK_FUNCTIONS[expr.type.kind];
        if (check === undefined) {
          throw new Error(`no boundary check for type kind: ${expr.type.kind}`);
        }
        return `${check}(${this.emitExpression(expr.value)}, "${this.escapeCString(expr.where)}")`;
      }

      case 'logical-op': {
        return this.emitLogicalOp(expr);
      }

      case 'conditional': {
        return this.emitConditional(expr);
      }

      case 'update': {
        return this.emitUpdate(expr);
      }

      case 'template-literal': {
        return this.emitTemplateLiteral(expr);
      }

      case 'string-length': {
        return `jsrt_number((double)jsrt_string_length(${this.emitExpression(expr.operand)}))`;
      }

      // Every console entry point returns `void` in C, but the call's JS value is `undefined` --
      // the verifier pins the HIR type to it. In VALUE position that gap is a hard error, not a
      // style question: `const r = console.log(x)` emitted `JSRT_LOCAL(0) = jsrt_print(...)` and
      // clang refused the file. The comma supplies the value the type promised. Statement position
      // takes `consoleCall` bare instead, because `(jsrt_print(x), JSRT_UNDEFINED);` is a
      // -Wunused-value warning on every console.log in the program.
      case 'console-log': {
        if (expr.method === 'table') {
          this.appendLine(`${this.consoleCall(expr)};`, expr.span);
          this.emitPendingCheck(expr.span);
          return 'JSRT_UNDEFINED';
        }
        return `(${this.consoleCall(expr)}, JSRT_UNDEFINED)`;
      }

      case 'function': {
        return this.closureValue(expr);
      }

      case 'array-length':
        return `jsrt_array_length(${this.emitExpression(expr.operand)})`;

      case 'array-literal': {
        const base = this.arraySlots.get(expr);
        if (base === undefined) {
          throw new Error('array literal was not registered during counting');
        }
        if (expr.elements.length === 0) {
          return 'jsrt_array_new(0, NULL)';
        }
        const parts: string[] = [];
        let flushed = false;
        expr.elements.forEach((element, i) => {
          flushed =
            this.sequencePart(
              parts,
              element,
              expr.span,
              (v) => `${this.slotAt(base + i)} = ${v}`,
            ) || flushed;
        });
        const alloc = `jsrt_array_new(${expr.elements.length}, &${this.slotAt(base)})`;
        if (!flushed) {
          parts.push(alloc);
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return alloc;
      }

      case 'index-access': {
        const base = this.indexSlots.get(expr);
        if (base === undefined) {
          throw new Error('index access was not registered during counting');
        }
        const target = this.slotAt(base);
        const index = this.slotAt(base + 1);
        const parts: string[] = [];
        this.sequencePart(parts, expr.target, expr.span, (v) => `${target} = ${v}`);
        this.sequencePart(parts, expr.index, expr.span, (v) => `${index} = ${v}`);
        const read =
          expr.target.type.kind === 'unknown'
            ? `jsrt_dyn_index_get(${target}, ${index}, NULL)`
            : `jsrt_array_get(${target}, ${index})`;
        if (expr.target.type.kind === 'unknown') {
          this.flushParts(parts, expr.span);
          this.appendLine(`${target} = ${read};`, expr.span);
          this.emitPendingCheck(expr.span);
          return target;
        }
        if (parts.length === 2) {
          return `(${parts.join(', ')}, ${read})`;
        }
        this.flushParts(parts, expr.span);
        return read;
      }

      case 'get-iterator': {
        const giSlot = this.tempSlots.get(expr);
        if (giSlot === undefined) {
          throw new Error('get-iterator was not registered during counting');
        }
        const giOperand = this.emitExpression(expr.operand);
        this.appendLine(`${this.slotAt(giSlot)} = jsrt_get_iterator(${giOperand});`, expr.span);
        this.emitPendingCheck(expr.span);
        return this.slotAt(giSlot);
      }

      case 'delete-prop': {
        const base = this.indexSlots.get(expr);
        if (base === undefined) {
          throw new Error('delete was not registered during counting');
        }
        const target = this.slotAt(base);
        const key = this.slotAt(base + 1);
        const parts: string[] = [];
        this.sequencePart(parts, expr.target, expr.span, (v) => `${target} = ${v}`);
        this.sequencePart(parts, expr.key, expr.span, (v) => `${key} = ${v}`);
        this.flushParts(parts, expr.span);
        // The answer lands in the receiver's slot before the pending check, so a delete that threw
        // (a frozen object, a nullish receiver) jumps to the landing pad with nothing half-read.
        this.appendLine(`${target} = jsrt_bool(jsrt_delete(${target}, ${key}));`, expr.span);
        this.emitPendingCheck(expr.span);
        return target;
      }

      case 'call': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('call was not registered during counting');
        }
        // Callee first, then arguments left to right -- the evaluation order the language
        // specifies, each landing in its rooted slot before the next runs. The call itself lands
        // as a STATEMENT, never inside the consumer's expression, so the pending-check can sit
        // between it and whatever consumes the result -- which waits in the callee's slot.
        const parts: string[] = [];
        this.sequencePart(parts, expr.callee, expr.span, (v) => `${this.slotAt(base)} = ${v}`);
        expr.args.forEach((arg, index) => {
          this.sequencePart(
            parts,
            arg,
            expr.span,
            (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
          );
        });
        const argv = expr.args.length === 0 ? 'NULL' : `&${this.slotAt(base + 1)}`;
        const loc = this.callLocation(expr.span);
        parts.push(
          `${this.slotAt(base)} = jsrt_call_at(${this.slotAt(base)}, ${expr.args.length}, ${argv}, ${loc})`,
        );
        this.flushParts(parts, expr.span);
        this.emitPendingCheck(expr.span);
        return this.slotAt(base);
      }

      case 'field-access': {
        // A module namespace field is the export's own global slot (docs/VALUE.md §4.14).
        if (expr.target.type.kind === 'object' && expr.target.type.namespace === true) {
          this.emitExpression(expr.target);
          return this.slotRef(expr.field);
        }
        return `jsrt_object_get(${this.emitExpression(expr.target)}, ${expr.slot})`;
      }

      case 'iterator-next': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('iterator-next was not registered during counting');
        }
        const parts: string[] = [];
        this.sequencePart(parts, expr.target, expr.span, (v) => `${this.slotAt(base)} = ${v}`);
        this.sequencePart(parts, expr.sent, expr.span, (v) => `${this.slotAt(base + 1)} = ${v}`);
        this.flushParts(parts, expr.span);
        // A generator's next() can throw: the resume left the exception pending. Specialized
        // iterators never do, and the same check is then a no-op. `return`/`throw` reach only a
        // generator (the gate refuses them on a boxed specialized iterator), and their uncaught
        // throw takes the same pending path.
        const step =
          expr.op === 'next'
            ? 'jsrt_iterator_next'
            : expr.op === 'return'
              ? 'jsrt_generator_close'
              : 'jsrt_generator_throw';
        this.appendLine(
          `${this.slotAt(base)} = ${step}(${this.slotAt(base)}, ${this.slotAt(base + 1)});`,
          expr.span,
        );
        this.emitPendingCheck(expr.span);
        return this.slotAt(base);
      }

      // The site's cache is a static JSRTIC: a hit is one pointer compare and one load, a miss
      // walks the shape chain and refills it (docs/VALUE.md §4.10). A getter or nullish receiver
      // can throw: root the result and unwind before any consumer or later operand executes.
      case 'dyn-field-access': {
        const slot = this.tempSlots.get(expr);
        if (slot === undefined) {
          throw new Error('dynamic property read was not registered during counting');
        }
        const result = this.slotAt(slot);
        this.appendLine(`${result} = ${this.emitExpression(expr.target)};`, expr.span);
        this.appendLine(
          `${result} = jsrt_get_prop(${result}, ${cNameLiteral(expr.field)}, &${this.icSite()});`,
          expr.span,
        );
        this.emitPendingCheck(expr.span);
        return result;
      }

      // `index`, `input` and `groups` are PROPERTIES of the match array, so they read through the
      // same shape chain and the same per-site cache any dynamic property does. `length` is not:
      // it is the array header's own field, and reading it through the table would answer
      // `undefined`. A receiver that is not a match panics inside the runtime either way.
      case 'match-read': {
        const target = this.emitExpression(expr.target);
        return expr.field === 'length'
          ? `jsrt_array_length(${target})`
          : `jsrt_get_prop(${target}, ${cNameLiteral(expr.field)}, &${this.icSite()})`;
      }

      // Eleven reads off the compiled struct, none of them allocating and none of them a property
      // in the shape-table sense: `source` and `flags` are the strings the runtime normalized at
      // construction, `lastIndex` is a header field, and the eight predicates are one bit test
      // each -- passed the flag's LETTER, because the LRE_FLAG_* constants belong to the vendored
      // engine's header and generated C does not include it.
      case 'regexp-read': {
        const target = this.emitExpression(expr.target);
        const spec = REGEXP_FIELDS[expr.field];
        return 'flag' in spec
          ? `jsrt_bool(jsrt_regexp_flag(${target}, '${spec.flag}'))`
          : `jsrt_regexp_${snakeCase(expr.field)}(${target})`;
      }

      case 'new': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('new was not registered during counting');
        }
        const cls = this.classAt(expr.className);
        const object = this.slotAt(base);
        // The object is created first and lands in the slot the constructor will receive as
        // argument zero, so it is rooted before any argument -- which may allocate -- is
        // evaluated. The whole expression yields that slot, not the constructor's return value:
        // `new` in JavaScript ignores what a constructor returns unless it returns an object,
        // and this subset's constructors cannot return one.
        const parts = [
          `${object} = jsrt_object_new(&_jsrt_class_${String(this.classIds.get(expr.className))})`,
        ];
        expr.args.forEach((arg, index) => {
          this.sequencePart(
            parts,
            arg,
            expr.span,
            (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
          );
        });
        if (cls.ctor === undefined) {
          this.flushParts(parts, expr.span);
          return object;
        }
        parts.push(
          `jsrt_call(${this.closureValue(cls.ctor.fn)}, ${1 + expr.args.length}, &${object})`,
        );
        this.flushParts(parts, expr.span);
        this.emitPendingCheck(expr.span);
        return object;
      }

      case 'method-call': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('method call was not registered during counting');
        }
        // Receiver first, then arguments left to right -- the same order and the same contiguous
        // argv as a plain call, with the receiver where the callee slot would be.
        const parts: string[] = [];
        this.sequencePart(parts, expr.target, expr.span, (v) => `${this.slotAt(base)} = ${v}`);
        expr.args.forEach((arg, index) => {
          this.sequencePart(
            parts,
            arg,
            expr.span,
            (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
          );
        });
        // A direct call names the function; a virtual one loads the entry the RECEIVER's own class
        // holds at this slot. The receiver is already in its slot, so the load reads the value the
        // call is about to pass, not a second evaluation of the target expression.
        const callee =
          expr.dispatch === 'virtual'
            ? `jsrt_method(${this.slotAt(base)}, ${expr.slot})`
            : this.closureValue(this.methodOf(expr).fn);
        parts.push(
          `${this.slotAt(base)} = jsrt_call(${callee}, ${1 + expr.args.length}, &${this.slotAt(base)})`,
        );
        this.flushParts(parts, expr.span);
        this.emitPendingCheck(expr.span);
        return this.slotAt(base);
      }

      // Allocate, then fill left to right. The object is in its own rooted slot first, so an entry
      // that allocates cannot collect the object it is being stored into.
      case 'object-literal': {
        const slot = this.callSlots.get(expr);
        if (slot === undefined) {
          throw new Error('object literal was not registered during counting');
        }
        const layout = shapeFieldsOf(expr);
        const order = keyOrderOf(expr, layout);
        const name = `${shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
        const id = String(this.classIds.get(name));
        const parts = [`${this.slotAt(slot)} = jsrt_object_new(&_jsrt_class_${id})`];
        let flushed = false;
        // Source order is the EVALUATION order (§13.2.5.5 runs the initializers left to right);
        // the slot each value lands in comes from the layout, which need not agree.
        expr.entries.forEach((entry) => {
          const target = layout.findIndex((field) => field.name === entry.name);
          if (target < 0) {
            throw new Error(`object literal key ${entry.name} is not in its own shape`);
          }
          flushed =
            this.sequencePart(
              parts,
              entry.value,
              expr.span,
              (v) => `jsrt_object_set(${this.slotAt(slot)}, ${String(target)}, ${v})`,
            ) || flushed;
        });
        if (!flushed) {
          parts.push(this.slotAt(slot));
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return this.slotAt(slot);
      }

      // Allocate, then fill left to right through the rooted scratch slot. No inline cache on
      // construction: each entry is a fresh key on a fresh object, so every store transitions --
      // exactly the case the cache deliberately does not serve (docs/VALUE.md §4.10).
      case 'dyn-object-literal': {
        const slot = this.callSlots.get(expr);
        if (slot === undefined) {
          throw new Error('dynamic object literal was not registered during counting');
        }
        const scratch = this.slotAt(slot + 1);
        const parts = [`${this.slotAt(slot)} = jsrt_dynobj_new()`];
        let flushed = false;
        for (const entry of expr.entries) {
          // An accessor installs the pair instead of storing a value, and it must not go through
          // jsrt_set_prop: on a key that already holds an accessor that would CALL the setter
          // rather than replace it (docs/VALUE.md §4.15). A missing half is JSRT_UNDEFINED, which
          // is what makes a get-only property read-only and a set-only one read `undefined`.
          if (isAccessorEntry(entry)) {
            // Scratches are handed out per HALF and restart at each entry, so a one-sided accessor
            // uses the same slot an ordinary value would and the second is reserved only for the
            // literal that actually writes a pair.
            let next = slot + 1;
            const half = (fn: Expression | undefined): string => {
              if (fn === undefined) {
                return 'JSRT_UNDEFINED';
              }
              const into = this.slotAt(next);
              next += 1;
              flushed = this.sequencePart(parts, fn, expr.span, (v) => `${into} = ${v}`) || flushed;
              return into;
            };
            const get = half(entry.get);
            const set = half(entry.set);
            parts.push(
              `jsrt_define_accessor(${this.slotAt(slot)}, ${cNameLiteral(entry.name)}, ${get}, ${set})`,
            );
            continue;
          }
          flushed =
            this.sequencePart(parts, entry.value, expr.span, (v) => `${scratch} = ${v}`) || flushed;
          parts.push(
            `jsrt_set_prop(${this.slotAt(slot)}, ${cNameLiteral(entry.name)}, ${scratch}, NULL)`,
          );
        }
        if (!flushed) {
          parts.push(this.slotAt(slot));
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return this.slotAt(slot);
      }

      case 'collection-new':
        return expr.collection === 'map' ? 'jsrt_map_new()' : 'jsrt_set_new()';

      // Compiled at EVERY evaluation, never hoisted: §22.2.4.1 makes each evaluation a fresh
      // object, and it has to be, because `lastIndex` is mutable state on it. The pattern rides in
      // its slot so it survives the flag string's allocation.
      case 'regexp-literal': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('regexp literal was not registered during counting');
        }
        const source = `${this.slotAt(base)} = ${this.emitStringLiteral(expr.source)}`;
        return `(${source}, jsrt_regexp_new(${this.slotAt(base)}, ${this.emitStringLiteral(expr.flags)}))`;
      }

      // A single-operand runtime walk: the argument rides in its rooted slot across the call.
      case 'date-new':
      case 'error-new':
      case 'json-parse':
      case 'json-stringify':
      case 'promise-static': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error(`${expr.kind} call was not registered during counting`);
        }
        const parts: string[] = [];
        const flushed = this.sequencePart(
          parts,
          expr.arg,
          expr.span,
          (v) => `${this.slotAt(base)} = ${v}`,
        );
        if (expr.kind === 'promise-static') {
          this.usedAsync = true;
        }
        // One C function covers all three `new Date(x)` argument forms -- number, string and
        // Date -- because the discrimination is a tag test the runtime already has to make.
        const runtimeCall =
          expr.kind === 'promise-static'
            ? `jsrt_promise_${expr.method}`
            : expr.kind === 'date-new'
              ? 'jsrt_date_from_value'
              : expr.kind === 'error-new'
                ? 'jsrt_error_new'
                : `jsrt_json_${expr.kind === 'json-parse' ? 'parse' : 'stringify'}`;
        // The only one of these that names a DESCRIPTOR as well as its operand: the error class is
        // a runtime constant, not an emitted one, so it rides in front of the rooted slot.
        const leading = expr.kind === 'error-new' ? `&${errorDescriptor(expr.ctor)}, ` : '';
        const opCall = `${runtimeCall}(${leading}${this.slotAt(base)})`;
        if (expr.kind === 'json-stringify') {
          parts.push(`${this.slotAt(base)} = ${opCall}`);
          this.flushParts(parts, expr.span);
          this.emitPendingCheck(expr.span);
          return this.slotAt(base);
        }
        if (!flushed) {
          parts.push(opCall);
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return opCall;
      }

      case 'promise-construct': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('promise-construct was not registered during counting');
        }
        this.usedAsync = true;
        const parts: string[] = [];
        this.sequencePart(parts, expr.executor, expr.span, (v) => `${this.slotAt(base)} = ${v}`);
        parts.push(`${this.slotAt(base)} = jsrt_promise_construct(${this.slotAt(base)})`);
        this.flushParts(parts, expr.span);
        this.emitPendingCheck(expr.span);
        return this.slotAt(base);
      }

      case 'promise-method': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error('promise-method was not registered during counting');
        }
        this.usedAsync = true;
        const parts: string[] = [];
        this.sequencePart(parts, expr.target, expr.span, (v) => `${this.slotAt(base)} = ${v}`);
        expr.args.forEach((arg, index) => {
          this.sequencePart(
            parts,
            arg,
            expr.span,
            (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
          );
        });
        const fn =
          expr.method === 'then'
            ? 'jsrt_promise_then'
            : expr.method === 'catch'
              ? 'jsrt_promise_catch'
              : 'jsrt_promise_finally';
        const operands = [
          this.slotAt(base),
          ...expr.args.map((_, index) => this.slotAt(base + 1 + index)),
        ].join(', ');
        parts.push(`${this.slotAt(base)} = ${fn}(${operands})`);
        this.flushParts(parts, expr.span);
        return this.slotAt(base);
      }

      // One runtime function per operation, receiver and arguments riding in rooted slots. The
      // collection ops name their C function through a table (there is no descriptor to index --
      // these calls are direct in a way even a non-overridden method is not); string and array
      // ops derive it mechanically, camelCase op to snake_case suffix (charCodeAt ->
      // jsrt_string_char_code_at, indexOf -> jsrt_array_index_of).
      case 'collection-op':
      case 'array-op':
      case 'date-op':
      case 'regexp-op':
      case 'string-op': {
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error(`${expr.kind} was not registered during counting`);
        }
        const parts: string[] = [];
        let flushed = this.sequencePart(
          parts,
          expr.target,
          expr.span,
          (v) => `${this.slotAt(base)} = ${v}`,
        );
        expr.args.forEach((arg, index) => {
          flushed =
            this.sequencePart(
              parts,
              arg,
              expr.span,
              (v) => `${this.slotAt(base + 1 + index)} = ${v}`,
            ) || flushed;
        });
        // `concat` is the receiver-plus-argument form of `+`, and its argument is an arbitrary
        // value: `''.concat(42)` is "42" because §22.1.3.4 runs ToString on each argument, while
        // `jsrt_string_concat` is the PRIMITIVE and asserts both sides are strings -- so the
        // conversion belongs here, exactly as it does for a template literal's holes. Without it
        // the assertion fired on `''.concat(true)` and on every other non-string argument
        // (plan-notes 222). One argument, so one coercion; the receiver of a method call is
        // already a string.
        const coercingConcat = expr.kind === 'string-op' && expr.op === 'concat';
        const operands = [
          this.slotAt(base),
          ...expr.args.map((_, index) =>
            coercingConcat
              ? `jsrt_to_string(${this.slotAt(base + 1 + index)})`
              : this.slotAt(base + 1 + index),
          ),
        ].join(', ');
        // A date op names its C function from the table rather than deriving it: snakeCase would
        // turn `getUTCFullYear` into `get_u_t_c_full_year`.
        const boxed =
          expr.kind === 'array-op' || expr.kind === 'collection-op'
            ? iteratorBoxCall(expr, operands)
            : undefined;
        const opCall =
          boxed !== undefined
            ? boxed
            : expr.kind === 'collection-op'
              ? collectionCall(expr.op, expr.collection, operands)
              : expr.kind === 'date-op'
                ? `${DATE_OPS[expr.op].fn}(${operands})`
                : expr.kind === 'regexp-op'
                  ? // `test` is the one op that answers a C bool rather than a jsrt_value -- the engine
                    // has no notion of our values, so the boxing is the bridge's job (jsrt_regexp.c).
                    // `exec` already answers a value: the match array, or null.
                    REGEXP_OPS[expr.op].result === 'boolean'
                    ? `jsrt_bool(jsrt_regexp_${snakeCase(expr.op)}(${operands}))`
                    : `jsrt_regexp_${snakeCase(expr.op)}(${operands})`
                  : `jsrt_${expr.kind === 'array-op' ? 'array' : 'string'}_${snakeCase(expr.op)}(${operands})`;
        // An op that calls back into compiled code can throw, so it gets its own STATEMENT and a
        // pending check -- the same discipline `call` follows, and for the same reason: the check
        // has to sit between the op and whatever consumes its result, which a comma expression
        // gives it nowhere to stand. The receiver's slot takes the answer; it is dead by then.
        const callsBack =
          expr.kind === 'array-op'
            ? arrayOpCallsBack(expr.op)
            : expr.kind === 'collection-op' && expr.op === 'forEach';
        const canThrow =
          callsBack ||
          (expr.kind === 'date-op' && expr.op === 'toISOString') ||
          (expr.kind === 'string-op' && stringOpCanThrow(expr.op));
        if (canThrow) {
          parts.push(`${this.slotAt(base)} = ${opCall}`);
          this.flushParts(parts, expr.span);
          this.emitPendingCheck(expr.span);
          return this.slotAt(base);
        }
        if (!flushed) {
          parts.push(opCall);
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return opCall;
      }

      // One runtime function per method, number -> number. The single-argument form nests
      // directly; the binary form sequences its arguments through slots because C would otherwise
      // pick the order (`Math.pow(f(), g())` must run f first).
      case 'date-components':
      case 'date-static':
      case 'math-call':
      case 'object-static': {
        const name =
          expr.kind === 'math-call'
            ? `jsrt_math_${expr.method}`
            : expr.kind === 'date-components'
              ? 'jsrt_date_from_components'
              : expr.kind === 'date-static'
                ? DATE_STATICS[expr.method].fn
                : `jsrt_object_${snakeCase(expr.method)}`;
        // Math takes immediates, so a lone argument has neither an order to fix nor anything to
        // keep rooted and nests directly. An Object walk always uses its slots (see counting).
        if (expr.kind === 'math-call' && expr.args.length <= 1) {
          const operands = expr.args.map((arg) => this.emitExpression(arg)).join(', ');
          return `${name}(${operands})`;
        }
        const base = this.callSlots.get(expr);
        if (base === undefined) {
          throw new Error(`${expr.kind} was not registered during counting`);
        }
        const parts: string[] = [];
        let flushed = false;
        expr.args.forEach((arg, index) => {
          flushed =
            this.sequencePart(
              parts,
              arg,
              expr.span,
              (v) => `${this.slotAt(base + index)} = ${v}`,
            ) || flushed;
        });
        const operands = expr.args.map((_, index) => this.slotAt(base + index)).join(', ');
        const opCall = `${name}(${operands})`;
        if (expr.kind === 'object-static') {
          parts.push(`${this.slotAt(base)} = ${opCall}`);
          this.flushParts(parts, expr.span);
          this.emitPendingCheck(expr.span);
          return this.slotAt(base);
        }
        if (!flushed) {
          parts.push(opCall);
          return `(${parts.join(', ')})`;
        }
        this.flushParts(parts, expr.span);
        return opCall;
      }

      // A suspension point, emitted where the expression sits: park the resume state, subscribe,
      // pop the frame and leave. The `goto` that comes back lands in the middle of whatever loop
      // or try block this sits inside, which is legal C here specifically because no state lives
      // in the C frame -- every local is in the environment the reaction holds.
      case 'await': {
        if (!this.inAsync) {
          throw new Error('await outside an async function; the gate should have caught it');
        }
        const at = this.emitPark(expr, `jsrt_await(_jsrt_self, ${this.suspendSlot(expr)});`);
        // A rejected awaited promise resumes with its reason: put it back in the pending cell so
        // an enclosing try -- or this unit's own pad -- treats it exactly like a `throw`.
        this.appendLine(
          `if (_jsrt_err) { jsrt_throw(_jsrt_v); goto ${this.currentPad()}; }`,
          expr.span,
        );
        this.appendLine(`${at} = _jsrt_v;`, expr.span);
        return at;
      }

      // Same suspension as await, answering the caller rather than the scheduler: park the
      // resume state, write the yielded value, pop the frame and leave. The next `next(v)`
      // re-enters at the label and the yield expression becomes `v`.
      //
      // A closing `gen.return(v)` / `gen.throw(e)` resumes the SAME label with an injection
      // instead of a value. THROW rethrows at the yield's own landing pad — the enclosing
      // catch/finally sees it exactly as if the yield threw. RETURN parks the value in the
      // return slot and runs emitReturnJump, which routes through every enclosing finally the
      // way a real `return` statement at this point would — so a finally that yields suspends
      // again, and the later resume finds the injection already cleared and just continues.
      case 'yield': {
        if (!this.inGenerator) {
          throw new Error('yield outside a generator; the gate should have caught it');
        }
        const at = this.emitPark(
          expr,
          `jsrt_generator_yield(_jsrt_self, ${this.suspendSlot(expr)});`,
        );
        this.appendLine(`if (_jsrt_self->inject == JSRT_GEN_INJECT_THROW) {`, expr.span);
        this.indent++;
        this.appendLine('_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
        this.appendLine('jsrt_throw(_jsrt_v);', expr.span);
        this.appendLine(`goto ${this.currentPad()};`, expr.span);
        this.indent--;
        this.appendLine('}', expr.span);
        this.appendLine(`if (_jsrt_self->inject == JSRT_GEN_INJECT_RETURN) {`, expr.span);
        this.indent++;
        this.appendLine('_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
        this.appendLine(`${this.slotAt(this.returnSlot)} = _jsrt_v;`, expr.span);
        this.emitReturnJump(expr.span);
        this.indent--;
        this.appendLine('}', expr.span);
        this.appendLine(`${at} = _jsrt_v;`, expr.span);
        return at;
      }

      // One descriptor exists per class in the whole program, so class identity IS descriptor
      // identity and the test is a pointer comparison. `classAt` is called for its check alone:
      // it throws if counting and emission disagree about which classes exist.
      case 'instanceof': {
        if (expr.builtin === true) {
          return `jsrt_bool(jsrt_instanceof_builtin(${this.emitExpression(expr.target)}, ${cNameLiteral(expr.className)}))`;
        }
        this.classAt(expr.className);
        const id = String(this.classIds.get(expr.className));
        return `jsrt_bool(jsrt_instanceof(${this.emitExpression(expr.target)}, &_jsrt_class_${id}))`;
      }

      default: {
        const _exhaustive: never = expr;
        throw new Error(
          `Unknown expression kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
        );
      }
    }
  }

  /* The ordinary function unit: one C function, one stack frame, one exit protocol. */
  private emitSyncUnit(unit: FunctionUnit): void {
    const { fn } = unit;
    this.appendLine(
      `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
    );
    this.indent++;
    // A zero-length array is not valid C11 and a function that roots nothing is valid TypeScript,
    // so the frame has a floor of one slot -- the same rule JSRT_GLOBALS(n) follows.
    this.appendLine(`JSRT_FRAME(${Math.max(1, this.slotCount)});`, fn.span);
    if (fn.envVars.length > 0) {
      // Rooted through the frame, not through a closure: nothing points at this environment until
      // a closure is built from it, and the function reads its own captured locals before then
      // and after every such closure has died (docs/VALUE.md §4.3).
      this.appendLine(`JSRTEnv *_jsrt_env = jsrt_env_new(env, ${fn.envVars.length});`, fn.span);
      this.appendLine('JSRT_FRAME_ENV(_jsrt_env);', fn.span);
    } else if (fn.captures.length === 0) {
      // Nothing reads the incoming environment here. The ABI passes one regardless so `jsrt_call`
      // need not know which kind of closure it holds, so silence it for -Werror.
      this.appendLine('(void)env;', fn.span);
    }
    this.emitParameterPrologue(fn);
    this.emitHoistedFunctions(fn.body.statements);
    for (const stmt of fn.body.statements) {
      this.emitStatement(stmt);
    }
    // Falling off the end of a JavaScript function returns `undefined` -- and still has to pop.
    this.appendLine('JSRT_FRAME_POP();', fn.span);
    this.appendLine('return JSRT_UNDEFINED;', fn.span);
    if (this.unwindUsed) {
      // The landing pad when no try encloses a throw point: the frame still pops -- the rooting
      // discipline demands it on EVERY exit path -- and the exception stays pending for the
      // caller's own check after jsrt_call to observe.
      this.appendLine('_jsrt_unwind: ;', fn.span);
      this.appendLine('JSRT_FRAME_POP();', fn.span);
      this.appendLine('return JSRT_UNDEFINED;', fn.span);
    }
    this.indent--;
    this.appendLine('}');
    this.appendLine('');
  }

  /* An async unit is TWO C functions. The entry point keeps the closure ABI: it builds the heap
   * environment that will outlive every suspension, stores the arguments there, and hands both to
   * `jsrt_async_start`, which runs the body's prefix synchronously (as the spec requires) and
   * answers the promise. The resume function holds the body itself, so each `await` can pop the
   * frame and return, and each resumption re-enters from the top -- rebuilding the frame, then
   * jumping to the suspension point. Nothing lives in the C frame across a suspension, which is
   * exactly what makes a `goto` into the middle of a loop or a try block correct here. */
  private emitAsyncUnit(unit: FunctionUnit): void {
    const { fn } = unit;
    const resume = `_jsrt_async_${unit.id}`;
    this.usedAsync = true;
    this.appendLine(
      `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);`,
    );
    this.appendLine('');
    // One frame slot, used for nothing but carrying the environment: JSRT_FRAME_ENV is what roots
    // it while `jsrt_async_start` allocates the promise and the frame that holds it.
    this.emitSuspendEntry(unit, `jsrt_async_start(_jsrt_env, ${resume})`);
    this.appendLine(
      `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {`,
    );
    this.indent++;
    // Enclosing environments are reached through the parent link rather than a parameter: the
    // scheduler calls this function, and it has no environment to pass. `(void)` unconditionally
    // -- a body that captures nothing still declares it, and -Werror would object.
    // The dispatch sits AFTER the prologue so it never jumps over a declaration, and before the
    // body so every `_jsrt_res_N:` it names is defined further down. State 0 is the first entry,
    // which falls through into the body's prefix.
    this.emitResumeOpen(fn.span, ['_jsrt_v', '_jsrt_err']);
    this.emitResumeBody(fn);
    this.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', fn.span);
    if (this.unwindUsed) {
      // An exception that reached the top of an async body REJECTS the promise rather than
      // staying pending: the caller observes it through `.then`/`await`, not through the mailbox.
      this.appendLine('_jsrt_unwind: ;', fn.span);
      this.appendLine(`${this.slotAt(this.returnSlot)} = jsrt_take_exception();`, fn.span);
      this.emitAsyncSettle('jsrt_async_throw', this.slotAt(this.returnSlot), fn.span);
    }
    this.indent--;
    this.appendLine('}');
    this.appendLine('');
  }

  /* A generator unit is TWO C functions, like an async unit, with three differences: the entry
   * point ALLOCATES and returns without running the body (the first `next()` is what starts it);
   * resume is synchronous on `next()`'s stack rather than a microtask; and an uncaught throw
   * stays pending for the call site of `next()` instead of rejecting a promise. Locals still live
   * in the heap environment because a `yield` pops the C frame. */
  private emitGeneratorUnit(unit: FunctionUnit): void {
    const { fn } = unit;
    const resume = `_jsrt_gen_${unit.id}`;
    this.appendLine(`static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v);`);
    this.appendLine('');
    this.emitSuspendEntry(unit, `jsrt_generator_new(_jsrt_env, ${resume})`);
    this.appendLine(`static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v) {`);
    this.indent++;
    this.emitResumeOpen(fn.span, ['_jsrt_v']);
    this.emitResumeBody(fn);
    this.emitGeneratorSettle('JSRT_UNDEFINED', fn.span);
    if (this.unwindUsed) {
      // Leave the exception pending: `next()`'s call site observes it. Mark done so a later
      // `next()` after the throw answers `{ value: undefined, done: true }` rather than re-entering.
      this.appendLine('_jsrt_unwind: ;', fn.span);
      this.appendLine('_jsrt_self->done = true;', fn.span);
      this.appendLine('JSRT_FRAME_POP();', fn.span);
      this.appendLine('return;', fn.span);
    }
    this.indent--;
    this.appendLine('}');
    this.appendLine('');
  }

  /* Entry point shared by async and generator units: allocate the heap environment, store the
   * arguments, produce the promise or generator object, pop, return. The body lives in resume. */
  private emitSuspendEntry(unit: FunctionUnit, produce: string): void {
    const { fn } = unit;
    this.appendLine(
      `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
    );
    this.indent++;
    this.appendLine('JSRT_FRAME(1);', fn.span);
    this.appendLine(
      `JSRTEnv *_jsrt_env = jsrt_env_new(env, ${Math.max(1, this.slotCount)});`,
      fn.span,
    );
    this.appendLine('JSRT_FRAME_ENV(_jsrt_env);', fn.span);
    this.emitParameterPrologue(fn);
    this.appendLine(`jsrt_value _jsrt_r = ${produce};`, fn.span);
    this.appendLine('JSRT_FRAME_POP();', fn.span);
    this.appendLine('return _jsrt_r;', fn.span);
    this.indent--;
    this.appendLine('}');
    this.appendLine('');
  }

  private emitResumeOpen(span: Span, unusedWhenEmpty: readonly string[]): void {
    this.appendLine('JSRT_FRAME(1);', span);
    this.appendLine('JSRTEnv *_jsrt_env = _jsrt_self->env;', span);
    this.appendLine('JSRT_FRAME_ENV(_jsrt_env);', span);
    this.appendLine('JSRTEnv *env = _jsrt_env->parent;', span);
    this.appendLine('(void)env;', span);
    if (this.awaitStates.size > 0) {
      this.appendLine('switch (_jsrt_self->state) {', span);
      this.indent++;
      for (const state of this.awaitStates.values()) {
        this.appendLine(`case ${state}: goto _jsrt_res_${state};`, span);
      }
      this.appendLine('default: break;');
      this.indent--;
      this.appendLine('}', span);
      return;
    }
    for (const name of unusedWhenEmpty) {
      this.appendLine(`(void)${name};`, span);
    }
  }

  private emitResumeBody(fn: FunctionExpr): void {
    this.emitHoistedFunctions(fn.body.statements);
    for (const stmt of fn.body.statements) {
      this.emitStatement(stmt);
    }
  }

  /* Slot holding a suspension's operand / resume value. Shared by await and yield so the park
   * sequence is one function rather than two copies of the same six lines. */
  private suspendSlot(expr: AwaitExpr | YieldExpr): string {
    const slot = this.tempSlots.get(expr);
    if (slot === undefined) {
      throw new Error(`${expr.kind} was not registered during counting`);
    }
    return this.slotAt(slot);
  }

  private emitPark(expr: AwaitExpr | YieldExpr, parkCall: string): string {
    const state = this.awaitStates.get(expr);
    if (state === undefined) {
      throw new Error(`${expr.kind} was not registered during counting`);
    }
    const at = this.suspendSlot(expr);
    this.appendLine(`${at} = ${this.emitExpression(expr.value)};`, expr.span);
    this.appendLine(`_jsrt_self->state = ${state};`, expr.span);
    // The resume prologue re-reads `_jsrt_self->env`, so the CURRENT environment has to be parked
    // there before the frame disappears -- otherwise a resume inside a per-iteration loop would
    // come back on the loop's base environment while the body's remaining code reads and writes
    // the iteration's clone (measured: `i` stuck at its last value and the loop never exiting,
    // plan-notes 226). For a unit whose env never changes this stores the same pointer it already
    // holds, which is why nothing observed it before.
    this.appendLine('_jsrt_self->env = _jsrt_env;', expr.span);
    this.appendLine(parkCall, expr.span);
    this.appendLine('JSRT_FRAME_POP();', expr.span);
    this.appendLine('return;', expr.span);
    this.appendLine(`_jsrt_res_${state}: ;`, expr.span);
    return at;
  }

  /* Settle THEN pop: settling enqueues a microtask, which allocates, and the value being settled
   * with must still be rooted while it does. */
  private emitAsyncSettle(fn: string, value: string, span: Span): void {
    this.appendLine(`${fn}(_jsrt_self, ${value});`, span);
    this.appendLine('JSRT_FRAME_POP();', span);
    this.appendLine('return;', span);
  }

  private emitGeneratorSettle(value: string, span: Span): void {
    this.appendLine(`jsrt_generator_return(_jsrt_self, ${value});`, span);
    this.appendLine('JSRT_FRAME_POP();', span);
    this.appendLine('return;', span);
  }

  private emitParameterPrologue(fn: FunctionExpr): void {
    if (fn.params.length === 0) {
      this.appendLine('(void)argc;');
      this.appendLine('(void)argv;');
    }
    fn.params.forEach((param, index) => {
      // A call site may pass fewer or more arguments than the function declares. `jsrt_arg` makes
      // both a value -- `undefined` and "dropped" -- rather than a read past the end of `argv`.
      // A rest parameter packs the extras the call already passed.
      // A default runs when the argument is undefined, including an explicit `undefined`.
      this.appendLine(
        param.rest === true
          ? `${this.slotRef(param.name)} = jsrt_args_rest(argc, argv, ${index});`
          : `${this.slotRef(param.name)} = jsrt_arg(argc, argv, ${index});`,
        param.span,
      );
      if (param.default !== undefined) {
        const slot = this.slotRef(param.name);
        this.appendLine(`if (jsrt_is(${slot}, JSRT_TAG_UNDEFINED)) {`, param.span);
        this.indent++;
        const value = this.emitExpression(param.default);
        this.appendLine(`${slot} = ${value};`, param.span);
        this.indent--;
        this.appendLine('}', param.span);
      }
    });
  }

  /** A literal's shape becomes a class with no constructor, no methods and no table -- which is
   * all a descriptor needs. Two literals of the same shape share the name, so they share the
   * descriptor, which is what makes them one type rather than two. */
  /** Claims the next inline-cache site and returns its C name. Every dynamic property site gets
   * its own -- sharing one between two sites would make them evict each other on every
   * alternation, which is the pathology caches exist to avoid. */
  private icSite(): string {
    const name = `_jsrt_ic_${String(this.icCount)}`;
    this.icCount += 1;
    return name;
  }

  /** `file:line` baked into `jsrt_call_at` so a non-function callee names the site (STA2006).
   * Column is not on `Span` by design (docs/HIR.md BoundaryCheck): the emitter has no source
   * text, and growing every node for one human-facing trap is the trade the IR already refused. */
  private callLocation(span: Span): string {
    const file = this.escapeCString(span.file ?? this.fileName);
    return `"${file}:${String(span.line)}"`;
  }

  /** The layout is the TYPE's field order, because that is what a later `o.x` resolves against
   * (`slotOf` in the lowering indexes `type.fields`). The literal's own key order is a second,
   * independent fact -- enumeration order -- and the two differ whenever the annotation or a
   * spread listed the keys in another order, so the descriptor carries both (plan-notes 181). */
  private registerShape(expr: ObjectLiteral): void {
    const layout = shapeFieldsOf(expr);
    const order = keyOrderOf(expr, layout);
    // Two literals of the same TYPE can still have different insertion orders, so the descriptor
    // is keyed by both -- one shape name would otherwise print the second literal in the first's
    // order.
    const name = `${shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
    if (this.classIds.has(name)) {
      return;
    }
    this.classIds.set(name, this.classes.length);
    if (order !== undefined) {
      this.classKeyOrders.set(this.classes.length, order);
    }
    this.classes.push({
      kind: 'class-declaration',
      type: expr.type,
      span: expr.span,
      name,
      fields: layout.map((field) => ({ name: field.name, type: field.type, span: expr.span })),
      methods: [],
      statics: [],
      vtable: [],
    });
  }

  /** The one function a direct call names: the class the lowering resolved, and that class's own
   * body. `classAt` is what turns a disagreement between counting and emission into a throw. */
  private methodOf(expr: MethodCall): ClassMethod {
    const method = this.classAt(expr.className).methods.find((m) => m.name === expr.method);
    if (method === undefined) {
      throw new Error(`class ${expr.className} has no method ${expr.method}`);
    }
    return method;
  }

  /** The closure constant a method-table entry names: the implementing class's own function.
   *
   * A table entry must be a file-scope constant, so a method that captures cannot appear in one.
   * The gate guarantees it by refusing to override in a class that is not at module scope, and a
   * class at module scope has nothing to capture. This throws rather than emitting a wrong table
   * if that guarantee is ever broken -- an internal error is the honest failure there. */
  private methodId(entry: VtableEntry): number {
    const method = this.classAt(entry.className).methods.find((m) => m.name === entry.name);
    if (method === undefined) {
      throw new Error(`class ${entry.className} has no method ${entry.name}`);
    }
    if (method.fn.needsEnv) {
      throw new Error(`method ${entry.className}.${entry.name} captures and cannot be in a table`);
    }
    return this.functionId(method.fn);
  }

  /** `&_jsrt_class_N` for the base class, or `NULL` at the root of a chain. Throws when the base
   * has no descriptor yet, which would mean classes were emitted out of declaration order. */
  private baseDescriptor(cls: ClassDeclaration, id: number): string {
    if (cls.base === undefined) {
      return 'NULL';
    }
    const baseId = this.classIds.get(cls.base);
    if (baseId === undefined || baseId >= id) {
      throw new Error(`class ${cls.name} is emitted before its base ${cls.base}`);
    }
    return `&_jsrt_class_${baseId}`;
  }

  /* The declaration a class name refers to. A miss means counting and emission disagree about
   * which classes exist, which is an emitter bug rather than anything the program did. */
  private classAt(name: string): ClassDeclaration {
    const id = this.classIds.get(name);
    const cls = id === undefined ? undefined : this.classes[id];
    if (cls === undefined) {
      throw new Error(`class ${name} was not registered during counting`);
    }
    return cls;
  }

  /* `a && b` is `let t = a; t ? b : t` -- the result is an OPERAND, not a boolean, and the right
   * side runs only sometimes. Both facts force a temporary: the left operand is tested and then
   * possibly returned, and evaluating it twice would duplicate its side effects.
   *
   * The temporary is a frame slot rather than a C local because C has no expression-level
   * declaration, and because a value the GC cannot see is a value it can collect. The comma
   * operator sequences the store before the test, so evaluation order is left-then-branch. */
  /* Folds to a left-nested chain of `jsrt_string_concat`. Each hole goes through `jsrt_to_string`
   * explicitly rather than through `+`: template substitution is defined as ToString, whereas `+`
   * would run ToPrimitive with hint default and consult `valueOf` first once objects exist.
   *
   * Empty literal chunks are dropped -- `` `${a}${b}` `` has three of them and concatenating with
   * "" is a no-op -- except when that would leave nothing at all, since `` `` `` is the empty
   * string and still has to produce a value. */
  private emitTemplateLiteral(expr: TemplateLiteral): string {
    const slots = this.templateSlots.get(expr);
    if (slots === undefined) {
      throw new Error('template literal has no frame slots; countExpression missed a node');
    }

    const sequence: string[] = [];
    let flushed = false;
    let partIndex = 0;
    expr.quasis.forEach((quasi, i) => {
      if (quasi !== '') {
        sequence.push(`${this.slotAt(slots.base + partIndex)} = ${this.emitStringLiteral(quasi)}`);
        partIndex++;
      }
      const hole = expr.expressions[i];
      if (hole !== undefined) {
        const holeSlot = this.slotAt(slots.base + partIndex);
        flushed =
          this.sequencePart(
            sequence,
            hole,
            expr.span,
            (v) => `${holeSlot} = jsrt_to_string(${v})`,
          ) || flushed;
        partIndex++;
      }
    });

    if (partIndex !== slots.count) {
      throw new Error('template literal part count disagrees with its frame-slot count');
    }
    const first = this.slotAt(slots.base);
    for (let index = 1; index < partIndex; index++) {
      sequence.push(`${first} = jsrt_string_concat(${first}, ${this.slotAt(slots.base + index)})`);
    }
    if (!flushed) {
      sequence.push(first);
      return `(${sequence.join(', ')})`;
    }
    this.flushParts(sequence, expr.span);
    return first;
  }

  private emitBinaryOp(expr: BinaryOp): string {
    const base = this.binarySlots.get(expr);
    if (base === undefined) {
      throw new Error('binary operator has no frame slots; countExpression missed a node');
    }
    const left = this.slotAt(base);
    const right = this.slotAt(base + 1);
    // The comma operator sequences the assignments. Calling jsrt_op_* directly with the emitted
    // child expressions would revive C's unspecified argument order and could collect a temporary
    // from the left while evaluating the right.
    const parts: string[] = [];
    this.sequencePart(parts, expr.left, expr.span, (v) => `${left} = ${v}`);
    this.sequencePart(parts, expr.right, expr.span, (v) => `${right} = ${v}`);
    // `in` is the one binary operator whose runtime raises: the right operand must be an object
    // (§13.10.1 step 6), so `"length" in "abc"` is a TypeError. The answer lands in the left slot
    // before the check, exactly as `delete` does it, so a throw reaches the landing pad with the
    // operands already sequenced and nothing half-read. Without this line the exception was set
    // and never observed -- and `emitTryCatch` DROPPED the catch block, because nothing had jumped
    // to its pad (plan-notes 220).
    if (expr.operator === 'in') {
      this.flushParts(parts, expr.span);
      this.appendLine(`${left} = jsrt_bool(jsrt_in(${left}, ${right}));`, expr.span);
      this.emitPendingCheck(expr.span);
      return left;
    }
    const result = BINARY_EMITTERS[expr.operator](left, right);
    if (parts.length === 2) {
      return `(${parts.join(', ')}, ${result})`;
    }
    // An operand carried statements of its own (a call and its pending check): everything is
    // already sequenced into the slots, so only the operation remains for the consumer.
    this.flushParts(parts, expr.span);
    return result;
  }

  private emitStringLiteral(value: string): string {
    const bytes = wtf8Bytes(value);
    return `jsrt_string_from_utf8("${escapeBytes(bytes)}", ${String(bytes.length)})`;
  }

  private emitLogicalOp(expr: LogicalOp): string {
    const slot = this.tempSlots.get(expr);
    if (slot === undefined) {
      throw new Error('short-circuit operator has no frame slot; countExpression missed a node');
    }
    const temp = this.slotAt(slot);
    const left = this.emitExpression(expr.left);
    this.indent++;
    const captured = this.capture(() => this.emitExpression(expr.right));
    this.indent--;

    if (captured.lines.length === 0) {
      const right = captured.value;
      // `??` tests nullish, NOT falsy: `0 ?? 1` is 0 while `0 || 1` is 1.
      // `||` is the odd one out: it is the only operator here whose test passing means "keep the
      // left operand". `&&` and `??` both mean "the left operand was unsatisfying, take the right".
      const test = expr.operator === '??' ? `jsrt_is_nullish(${temp})` : `jsrt_truthy(${temp})`;
      const whenTrue = expr.operator === '||' ? temp : right;
      const whenFalse = expr.operator === '||' ? right : temp;
      return `(${temp} = ${left}, ${test} ? (${whenTrue}) : (${whenFalse}))`;
    }

    // The right operand needed statements of its own (a call and its pending check), and it only
    // runs when the operator says so -- so its statements sit inside a branch, and the node's
    // value is whatever `temp` holds afterwards.
    this.appendLine(`${temp} = ${left};`, expr.span);
    const enter =
      expr.operator === '&&'
        ? `jsrt_truthy(${temp})`
        : expr.operator === '||'
          ? `!jsrt_truthy(${temp})`
          : `jsrt_is_nullish(${temp})`;
    this.appendLine(`if (${enter}) {`, expr.span);
    this.indent++;
    this.lines.push(...captured.lines);
    this.appendLine(`${temp} = ${captured.value};`, expr.span);
    this.indent--;
    this.appendLine('}', expr.span);
    return temp;
  }

  private emitConditional(expr: ConditionalExpr): string {
    const slot = this.tempSlots.get(expr);
    if (slot === undefined) {
      throw new Error('conditional has no frame slot; countExpression missed a node');
    }
    const temp = this.slotAt(slot);
    const cond = this.emitExpression(expr.condition);
    this.indent++;
    const thenCap = this.capture(() => this.emitExpression(expr.consequent));
    const elseCap = this.capture(() => this.emitExpression(expr.alternate));
    this.indent--;
    if (thenCap.lines.length === 0 && elseCap.lines.length === 0) {
      this.appendLine(
        `${temp} = jsrt_truthy(${cond}) ? (${thenCap.value}) : (${elseCap.value});`,
        expr.span,
      );
      return temp;
    }
    this.appendLine(`if (jsrt_truthy(${cond})) {`, expr.span);
    this.indent++;
    this.lines.push(...thenCap.lines);
    this.appendLine(`${temp} = ${thenCap.value};`, expr.span);
    this.indent--;
    this.appendLine('} else {', expr.span);
    this.indent++;
    this.lines.push(...elseCap.lines);
    this.appendLine(`${temp} = ${elseCap.value};`, expr.span);
    this.indent--;
    this.appendLine('}', expr.span);
    return temp;
  }

  private emitUpdate(expr: UpdateExpr): string {
    const slot = this.tempSlots.get(expr);
    if (slot === undefined) {
      throw new Error('update has no frame slot; countExpression missed a node');
    }
    const result = this.slotAt(slot);
    const place = expr.target;
    let read: string;
    let write: (value: string) => string;
    switch (place.kind) {
      case 'identifier': {
        const ref = this.slotRef(place.name);
        read = ref;
        write = (value: string) => `${ref} = ${value}`;
        break;
      }
      case 'index-access': {
        const base = this.indexSlots.get(expr);
        if (base === undefined) {
          throw new Error('update index place was not registered during counting');
        }
        const target = this.slotAt(base);
        const index = this.slotAt(base + 1);
        this.appendLine(`${target} = ${this.emitExpression(place.target)};`, expr.span);
        this.appendLine(`${index} = ${this.emitExpression(place.index)};`, expr.span);
        const dyn = place.target.type.kind === 'unknown';
        read = dyn
          ? `jsrt_dyn_index_get(${target}, ${index}, NULL)`
          : `jsrt_array_get(${target}, ${index})`;
        write = (value: string) =>
          dyn
            ? `jsrt_dyn_index_set(${target}, ${index}, ${value}, NULL)`
            : `jsrt_array_set(${target}, ${index}, ${value})`;
        break;
      }
      case 'field-access': {
        const base = this.indexSlots.get(expr);
        if (base === undefined) {
          throw new Error('update field place was not registered during counting');
        }
        const target = this.slotAt(base);
        this.appendLine(`${target} = ${this.emitExpression(place.target)};`, expr.span);
        read = `jsrt_object_get(${target}, ${place.slot})`;
        write = (value: string) => `jsrt_object_set(${target}, ${place.slot}, ${value})`;
        break;
      }
      case 'dyn-field-access': {
        const base = this.indexSlots.get(expr);
        if (base === undefined) {
          throw new Error('update dynamic field place was not registered during counting');
        }
        const target = this.slotAt(base);
        this.appendLine(`${target} = ${this.emitExpression(place.target)};`, expr.span);
        const ic = this.icSite();
        read = `jsrt_get_prop(${target}, ${cNameLiteral(place.field)}, &${ic})`;
        write = (value: string) =>
          `jsrt_set_prop(${target}, ${cNameLiteral(place.field)}, ${value}, &${ic})`;
        break;
      }
    }
    const op = expr.operator;
    if (op === '=') {
      const value = expr.value;
      if (value === undefined) {
        throw new Error('assignment update is missing its right-hand side');
      }
      const rhs = this.emitExpression(value);
      this.appendLine(`${result} = ${rhs};`, expr.span);
      this.appendLine(`${write(result)};`, expr.span);
    } else {
      this.appendLine(`${result} = ${read};`, expr.span);
      if (
        place.kind === 'dyn-field-access' ||
        (place.kind === 'index-access' && place.target.type.kind === 'unknown')
      ) {
        this.emitPendingCheck(expr.span);
      }
      if (op === '++' || op === '--') {
        const next = `jsrt_number(jsrt_to_number(${result}) ${op === '++' ? '+' : '-'} 1.0)`;
        if (expr.prefix) {
          this.appendLine(`${result} = ${next};`, expr.span);
          this.appendLine(`${write(result)};`, expr.span);
        } else {
          this.appendLine(`${write(next)};`, expr.span);
        }
      } else if (op === '&&' || op === '||' || op === '??') {
        const value = expr.value;
        if (value === undefined) {
          throw new Error('logical update is missing its right-hand side');
        }
        const takeRight =
          op === '||'
            ? `!jsrt_truthy(${result})`
            : op === '&&'
              ? `jsrt_truthy(${result})`
              : `jsrt_is_nullish(${result})`;
        this.appendLine(`if (${takeRight}) {`, expr.span);
        this.indent++;
        const rhs = this.emitExpression(value);
        this.appendLine(`${result} = ${rhs};`, expr.span);
        this.appendLine(`${write(result)};`, expr.span);
        this.indent--;
        this.appendLine('}', expr.span);
      } else {
        const value = expr.value;
        if (value === undefined) {
          throw new Error('compound update is missing its right-hand side');
        }
        const rhs = this.emitExpression(value);
        this.appendLine(`${result} = ${BINARY_EMITTERS[op](result, rhs)};`, expr.span);
        this.appendLine(`${write(result)};`, expr.span);
      }
    }
    if (place.kind !== 'identifier') {
      this.emitPendingCheck(expr.span);
    }
    return result;
  }

  /* The C lvalue for a slot of the unit being emitted. Same slot number, different array: a
   * function's slots are its stack frame, the module's are the file-static globals. */
  private slotAt(slot: number): string {
    // An async or generator unit keeps every local in its heap environment instead: the frame it
    // would otherwise sit in is popped at each suspension and rebuilt on each resume, so a C frame
    // slot would not survive a single `await` or `yield`.
    if (this.inAsync || this.inGenerator) {
      return `_jsrt_env->slots[${slot}]`;
    }
    return this.inFunction ? `JSRT_LOCAL(${slot})` : `JSRT_GLOBAL(${slot})`;
  }

  /* Where a name lives, in the order storage is assigned to it: this function's own environment,
   * an enclosing environment, this function's frame, or the module's globals. The environment
   * cases come FIRST -- a captured binding was deliberately kept out of the frame, so a frame slot
   * of the same name would be a second, silently divergent copy of one variable. */
  private slotRef(name: string): string {
    const owned = this.envMap.get(name);
    if (owned !== undefined) {
      return `_jsrt_env->slots[${owned}]`;
    }
    const captured = this.captureMap.get(name);
    if (captured !== undefined) {
      return `JSRT_ENV_AT(env, ${captured.levels}, ${captured.index})`;
    }
    const own = this.slotMap.get(name);
    if (own !== undefined) {
      return this.slotAt(own);
    }
    const global = this.globalMap.get(name);
    if (global === undefined) {
      throw new Error(`Undefined identifier: ${name}`);
    }
    return `JSRT_GLOBAL(${global})`;
  }

  /* The environment a closure created HERE should capture: this function's own if it has one,
   * otherwise the one it was handed. NULL at module level, where bindings are globals already. */
  private currentEnv(): string {
    if (this.envMap.size > 0) {
      return '_jsrt_env';
    }
    return this.inFunction ? 'env' : 'NULL';
  }

  /* A function that captures nothing stays rung 4a's file-static constant -- no allocation. One
   * that does is built per evaluation, which is what makes two evaluations of the same function
   * expression close over different variables. */
  private closureValue(fn: FunctionExpr): string {
    const id = this.functionId(fn);
    if (!fn.needsEnv) {
      return `jsrt_closure(&_jsrt_closure_${id})`;
    }
    const name = cNameLiteral(fn.name ?? '');
    return `jsrt_closure_new(_jsrt_fn_${id}, ${declaredArity(fn)}, ${name}, ${this.currentEnv()})`;
  }

  private appendLine(line: string, span?: Span): void {
    const indentStr = '  '.repeat(this.indent);
    let fullLine = indentStr + line;

    // Add #line directive before statements (but not for braces/empty lines)
    if (span && line && !line.startsWith('}')) {
      const escapedFile = this.escapeCString(span.file ?? this.fileName);
      fullLine = `#line ${span.line} "${escapedFile}"\n${fullLine}`;
    }

    this.lines.push(fullLine);
  }

  /** Escapes for a C string literal. Named for the job, not for its first caller: file paths
   * and the identifier a `reference-error` carries both go through it. */
  /** The free function of the same name: kept as a method so the emitter's many call sites read
   * the same as they always did. */
  private escapeCString(text: string): string {
    return escapeCString(text);
  }
}

export function emitC(module: Module): string {
  const emitter = new Emitter();
  return emitter.emit(module);
}

/** The C call one Map or Set operation becomes, given its already-sequenced operands.
 *
 * A Set shares the Map's functions rather than having its own: the structure IS the same one, and
 * `add` differs from `set` only in passing no value. The two that return a C `bool` are boxed here,
 * and `clear`, which returns nothing, yields `undefined` -- the value JavaScript gives it. */
/** The `JSRT_ITER_*` kinds (runtime/include/jsrt_value.h), numbered here because generated C
 * spells them as numbers: three per source, array then map then set; `matchAll` sits at 9 and
 * the string code-point walk at 10. */
const ITER_KINDS = {
  array: { keys: 0, values: 1, entries: 2 },
  map: { keys: 3, values: 4, entries: 5 },
  set: { keys: 6, values: 7, entries: 8 },
  matchAll: 9,
  string: 10,
} as const;

function iteratorBoxCall(expr: ArrayOp | CollectionOp, operands: string): string | undefined {
  if (expr.op !== 'keys' && expr.op !== 'values' && expr.op !== 'entries') {
    return undefined;
  }
  const source: 'array' | 'map' | 'set' =
    expr.kind === 'array-op' ? 'array' : expr.collection === 'set' ? 'set' : 'map';
  return `jsrt_iterator_new(${operands}, ${String(ITER_KINDS[source][expr.op])})`;
}

function collectionCall(
  op: CollectionOperation,
  collection: 'map' | 'set',
  operands: string,
): string {
  switch (op) {
    case 'get':
      return `jsrt_map_get(${operands})`;
    case 'set':
      return `jsrt_map_set(${operands})`;
    case 'add':
      return `jsrt_set_add(${operands})`;
    case 'has':
      return `jsrt_bool(jsrt_map_has(${operands}))`;
    case 'delete':
      return `jsrt_bool(jsrt_map_delete(${operands}))`;
    case 'clear':
      return `jsrt_map_clear(${operands})`;
    case 'size':
      return `jsrt_map_size(${operands})`;
    case 'forEach':
      // The one collection op that runs user code, hence the only one the emitter follows with a
      // pending check. A Set hands the element to the callback twice, which is the whole of the
      // Map/Set difference and lives in the runtime, not here.
      return `jsrt_${collection}_for_each(${operands})`;
    case 'keys':
    case 'values':
    case 'entries':
      return (
        iteratorBoxCall({ kind: 'collection-op', collection, op } as CollectionOp, operands) ??
        `jsrt_iterator_new(${operands}, 0)`
      );
    default: {
      // The ES2025 set operations, whose C names are their method names in snake_case. The four
      // combining forms answer a new Set; the three predicates answer a C bool, boxed here exactly
      // as `has` and `delete` are.
      const call = `jsrt_set_${snakeCase(op)}(${operands})`;
      return SET_OPS[op] === 'boolean' ? `jsrt_bool(${call})` : call;
    }
  }
}
