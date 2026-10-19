/* Pure C-rendering helpers for the emitter. No emitter state. */

import {
  SET_OPS,
  isAccessorEntry,
  isComputedEntry,
  type ArrayOp,
  type BinaryOp,
  type CallExpr,
  type CollectionOp,
  type CollectionOperation,
  type ConsoleLogCall,
  type DateComponents,
  type DateNew,
  type DateOp,
  type DateStaticCall,
  type DynEntry,
  type DynMethodCall,
  type DynObjectLiteral,
  type ErrorNew,
  type Expression,
  type ExternCall,
  type FieldCall,
  type FunctionExpr,
  type GlobalCall,
  type InstanceOfValue,
  type IteratorNext,
  type JsonParse,
  type JsonStringify,
  type MathCall,
  type MethodCall,
  type MethodCopy,
  type NewExpr,
  type NewValue,
  type NumberOp,
  type ObjectLiteral,
  type ObjectStaticCall,
  type PromiseConstruct,
  type PromiseMethodCall,
  type PromiseStaticCall,
  type RegExpLiteral,
  type RegExpOp,
  type Span,
  type StringOp,
  type StringStaticCall,
  type SuperCall,
  type TypedOp,
  type UnaryOp,
  type UpdateExpr,
} from '../hir/nodes.ts';
import { hTypeConversionRunsUserCode, type HField, type HType } from '../hir/types.ts';
import { RECEIVER_NAME } from '../lower/captures.ts';
import { shadowSource } from '../lower/scope.ts';

/** C fragment for each binary operator, given already-emitted operand expressions.
 *
 * Note what is NOT here: `jsrt_to_double`, which is a bit reinterpretation and not a conversion.
 * Applying it to a boxed boolean or string reads the payload as an IEEE double and produces
 * garbage. Every numeric context goes through `jsrt_to_number` (ToNumber, docs/NUMERIC.md §6.3). */
export const BINARY_EMITTERS: Readonly<
  Record<BinaryOp['operator'], (l: string, r: string) => string>
> = {
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

/** The operators that apply ToNumeric to both operands (§13.15.3 steps 3-4). */
export const NUMERIC_BINARY_OPERATORS: readonly BinaryOp['operator'][] = [
  '-',
  '*',
  '/',
  '%',
  '**',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '>>>',
];

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
export const CHECK_FUNCTIONS: Readonly<Record<string, string | undefined>> = {
  number: 'jsrt_check_number',
  string: 'jsrt_check_string',
  boolean: 'jsrt_check_boolean',
  uint8array: 'jsrt_check_uint8array',
};

export const UNARY_EMITTERS: Readonly<Record<UnaryOp['operator'], (operand: string) => string>> = {
  '-': (x) => `jsrt_number(-jsrt_to_number(${x}))`,
  '+': (x) => `jsrt_number(jsrt_to_number(${x}))`,
  '!': (x) => `jsrt_bool(!jsrt_truthy(${x}))`,
  '~': (x) => `jsrt_op_bitnot(${x})`,
  void: (x) => `(${x}, JSRT_UNDEFINED)`,
};

/** Whether a unary operator applies ToNumeric to an operand that may run the program's
 * `valueOf` (§13.5.4-6). `!` and `void` take the operand as it is. */
export function unaryConverts(expr: UnaryOp): boolean {
  return (
    (expr.operator === '+' || expr.operator === '-' || expr.operator === '~') &&
    hTypeConversionRunsUserCode(expr.operand.type)
  );
}

/** Whether a compound assignment applies ToNumeric to an operand that may run the program's
 * `valueOf` (§13.15.2). `+=` converts inside `jsrt_op_add`, in order, and needs no help. */
export function compoundConverts(expr: UpdateExpr): boolean {
  const value = expr.value;
  return (
    value !== undefined &&
    expr.operator !== '=' &&
    expr.operator !== '++' &&
    expr.operator !== '--' &&
    expr.operator !== '&&' &&
    expr.operator !== '||' &&
    expr.operator !== '??' &&
    NUMERIC_BINARY_OPERATORS.includes(expr.operator) &&
    (hTypeConversionRunsUserCode(expr.target.type) || hTypeConversionRunsUserCode(value.type))
  );
}

/** Whether a runtime call's ToString/ToNumber of its arguments may run the program's own
 * `toString`/`valueOf` -- and so throw. */
export function argsConvert(args: readonly Expression[]): boolean {
  return args.some((arg) => hTypeConversionRunsUserCode(arg.type));
}

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
export function cDoubleLiteral(value: number): string {
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
export function cNameLiteral(name: string): string {
  return `"${escapeCString(name)}"`;
}

/** A C string literal's body for everything that is not a byte string: a field or property
 * name, a file name in a `#line`, a `file:line` location, a reference error's name, a function's
 * own name. Spelled once so the sites cannot drift: the value travels as WTF-8 octal escapes
 * (the `wtf8Bytes` transport `escapeBytes` prints), so a lone surrogate in a key reaches the
 * runtime as its three-byte form instead of coming back as U+FFFD (plan.md §8 step 30 A9) -- the
 * same loss `wtf8Bytes` already closed for string values. C0 controls and DEL go out
 * octal-escaped, with `\n`/`\t`/`\r` short (defense in depth, plan.md §8 step 17): a raw NUL
 * truncates the C string at the first byte (`-Wnull-character`), so no name reaching a literal
 * may carry one. The display name is what restores the printed spelling; this only keeps the
 * emitter warning-free. `?` is escaped for the trigraph reason `escapeBytes` documents. */
export function escapeCString(text: string): string {
  return escapeBytes(wtf8Bytes(text));
}

/* One emitted C function. Each HIR function becomes a `_jsrt_fn_N` with a frame of its own, plus a
 * file-static `_jsrt_closure_N` describing it -- constant because rung 4a has no captures; 4b makes
 * the closure heap-allocated and gives it an environment pointer. */
export interface FunctionUnit {
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
export interface TryFinallyScope {
  readonly compVar: string;
  /** A try's completion code lives in a counted slot, boxed as a number, so it survives a
   * suspension between the route and the dispatch; the Map/Set for-of cleanup's comp is a raw
   * C int, which is safe only because that loop never suspends (the suspendable units box the
   * walk into a heap iterator instead). The boxed-iterator cleanup below is that boxed walk,
   * so its comp is a counted slot too. */
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
export function declaredArity(fn: {
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

export function closureMeta(fn: {
  readonly params: readonly {
    readonly name: string;
    readonly rest?: true;
    readonly default?: unknown;
  }[];
}): { readonly arity: number; readonly hasReceiver: boolean } {
  const hasReceiver = fn.params[0]?.name === RECEIVER_NAME;
  const params = hasReceiver ? fn.params.slice(1) : fn.params;
  return { arity: declaredArity({ params }), hasReceiver };
}

export function snakeCase(member: string): string {
  return member.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function descriptorName(name: string): string {
  if (name.startsWith('{')) {
    return '';
  }
  // A shadowed class prints under its source name: Node shows `C`, not the HIR spelling the
  // descriptor is keyed by (plan.md §8 step 23 -- the class twin of step 17's function rule).
  const unshadowed = shadowSource(name) ?? name;
  // A specialization prints under its source name: Node shows `Box`, not `Box<number>`, and the
  // mangled tuple is a compile-time key no identifier can spell, so stripping it cannot collide.
  const generic = unshadowed.indexOf('<');
  return generic < 0 ? unshadowed : unshadowed.slice(0, generic);
}

/** The structural name of a literal's shape, which is also its descriptor's identity. */
export function shapeNameOf(expr: ObjectLiteral): string {
  if (expr.type.kind !== 'object') {
    throw new Error('object literal has no shape');
  }
  return expr.type.name;
}

/** The literal's LAYOUT: the type's fields, which is what every later read resolves against. */
export function shapeFieldsOf(expr: ObjectLiteral): readonly HField[] {
  if (expr.type.kind !== 'object') {
    throw new Error('object literal has no shape');
  }
  return expr.type.fields;
}

/** Slot indices in the order the literal wrote its keys, or `undefined` when that IS slot order.
 * A duplicate key keeps its first position and its single slot, which is what §13.2.5.5 does. */
export function keyOrderOf(expr: ObjectLiteral, layout: readonly HField[]): number[] | undefined {
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

/** The descriptor field name for an object literal's bound-method slot (plan.md §8 step 36).
 * `#`-prefixed, so every reflective walk (`jsrt_fixed_key_order`, which print and
 * keys/values/entries share, `hasOwn`, the spread-order walks) already filters it: a bound
 * method is storage, not a property, exactly like a `#private` field. */
export function hiddenMethodField(method: string): string {
  return `#method:${method}`;
}

/** Slots a dynamic literal reserves before any spread scratch: the object itself, plus the
 * value scratch (and a second one for a get/set pair or a computed key) — but only the
 * scratches the emission actually writes. A literal of spreads alone (`{ ...o }` into a
 * dynamic result, plan.md §8 step 12c S-C) copies whole fragments via `jsrt_dynobj_spread`
 * and never stores through the value scratch, so reserving it roots a slot nothing writes
 * (frames.test.ts holds the gap against the counter). Counting starts the spread scratches
 * after these, and emission reads them back from the same base, so the two agree exactly. */
export function dynLiteralBaseSlots(expr: DynObjectLiteral): number {
  if (expr.entries.length === 0) {
    return 1;
  }
  const pair = expr.entries.some(
    (entry) => isAccessorEntry(entry) && entry.get !== undefined && entry.set !== undefined,
  );
  const hasComputed = expr.entries.some((entry) => isComputedEntry(entry));
  if (pair || hasComputed) {
    return 3;
  }
  const storesValue = expr.entries.some(
    (entry) => isAccessorEntry(entry) || (!isComputedEntry(entry) && entry.spread !== true),
  );
  return storesValue ? 2 : 1;
}

/** The grouping key for one spread's expanded reads: the spread's own source range.
 *
 * The lowering expands `{ ...src }` into one field read per field of src's shape, all stamped
 * with the SpreadAssignment's own span (plan.md §8 step 12 family c). HIR is a tree, so the N
 * reads share one source subtree -- and the passes rebuild shared subtrees into
 * structurally-equal copies (`rewrite.ts` keeps `===` only when nothing changed; const-fold and
 * inline specialize per occurrence). Node identity therefore does not survive optimization, but
 * the span does: no pass synthesizes spans for rebuilt parents, so the same source range stays
 * the same evaluation however many copies the reads became. */
export function spreadScratchKey(span: Span): string {
  return `${span.file ?? ''}:${span.start}:${span.length}`;
}

/** One rooted scratch slot per spread fragment with a non-trivial source: every maximal group of
 * spread-marked reads sharing a spread span, in first-occurrence order.
 *
 * The source evaluates ONCE at the fragment's position into the scratch, however many fields
 * read it -- a call, a member access, a literal would run its effect once per field without
 * this. An identifier source stays inline: reading a binding N times is side-effect-free, and it
 * is also CORRECT when an entry assigns that binding (`{ ...b, y: (b = c) }` must re-read `c` for
 * the later fields). A lone read still needs its scratch: since step 21a the order repair reads
 * the source too, so "evaluates exactly once" is a two-reader promise, not a one-reader
 * optimization. Only `spread`-marked entries group: an own value reading the same shape never
 * shares the spread's span, so it can never join a fragment by accident. Spread method copies
 * join their fragment's group through the same span, so a methods-only fragment still runs its
 * source once. Counting and emission both call this, so the reserved slots and the written ones
 * agree exactly (frames.test.ts holds any gap against the counter). */
export function spreadScratches(
  entries: readonly DynEntry[],
  copies: readonly MethodCopy[] = [],
): readonly {
  readonly key: string;
  readonly target: Expression;
}[] {
  const groups = new Map<string, { readonly target: Expression }>();
  const order: string[] = [];
  const consider = (value: Expression): void => {
    if (value.kind !== 'field-access' && value.kind !== 'method-value') {
      return;
    }
    if (value.target.kind === 'identifier') {
      return;
    }
    const key = spreadScratchKey(value.span);
    if (!groups.has(key)) {
      groups.set(key, { target: value.target });
      order.push(key);
    }
  };
  for (const entry of entries) {
    if (isAccessorEntry(entry) || isComputedEntry(entry)) {
      continue;
    }
    if (entry.spread !== true) {
      continue;
    }
    consider(entry.value);
  }
  for (const copy of copies) {
    consider(copy.value);
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error('spread scratch group vanished during collection');
    }
    return { key, target: group.target };
  });
}

/** The identifier-source spread fragments, in first-occurrence order: the value walk reads an
 * identifier source inline per field -- evaluating it once per field is side-effect-free, and
 * re-reading is what keeps `{ ...b, y: (b = c) }` correct -- but the order repair runs after
 * every value, where a suspension may have intervened and a later entry may have reassigned
 * the binding. Each source is therefore snapshotted at its own fragment's position into a
 * rooted slot; counting reserves them past the scratch slots, and emission writes and reads
 * them back from the same base, so the two agree exactly. */
export function spreadSnapshots(entries: readonly DynEntry[]): readonly {
  readonly key: string;
  readonly target: Expression;
}[] {
  const seen = new Set<string>();
  const out: { readonly key: string; readonly target: Expression }[] = [];
  for (const entry of entries) {
    if (isAccessorEntry(entry) || isComputedEntry(entry)) {
      continue;
    }
    if (entry.spread !== true) {
      continue;
    }
    if (entry.value.kind !== 'field-access' || entry.value.target.kind !== 'identifier') {
      continue;
    }
    const key = spreadScratchKey(entry.value.span);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ key, target: entry.value.target });
    }
  }
  return out;
}

/* A JS string is a sequence of UTF-16 CODE UNITS, and a lone surrogate is a legal one. UTF-8
 * cannot represent it, so `"\ud800"` written straight into the .c file comes back as U+FFFD --
 * `charCodeAt(0)` answered 65533 where Node answers 55296 (plan-notes 178, found by the fuzzer).
 * WTF-8 is UTF-8 plus the three-byte encodings of unpaired surrogates, which is exactly what
 * `utf8_decode` in runtime/src/jsrt_string.c already accepts, so the transport needs no runtime
 * change -- only an emitter that stops losing the bytes. */
export function wtf8Bytes(value: string): number[] {
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
export function escapeBytes(bytes: readonly number[]): string {
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

/** Every node that claims a contiguous run of rooted call slots (see `callSlots`). */
export type CallSlotted =
  | ArrayOp
  | InstanceOfValue
  | NewValue
  | CallExpr
  | ConsoleLogCall
  | JsonParse
  | JsonStringify
  | CollectionOp
  | DateComponents
  | DateNew
  | DateOp
  | NumberOp
  | DateStaticCall
  | GlobalCall
  | DynMethodCall
  | DynObjectLiteral
  | FieldCall
  | ErrorNew
  | ExternCall
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
  | StringStaticCall
  | SuperCall
  | TypedOp
  | IteratorNext;

/** The C call one Map or Set operation becomes, given its already-sequenced operands.
 *
 * A Set shares the Map's functions rather than having its own: the structure IS the same one, and
 * `add` differs from `set` only in passing no value. The two that return a C `bool` are boxed here,
 * and `clear`, which returns nothing, yields `undefined` -- the value JavaScript gives it. */
/** The `JSRT_ITER_*` kinds (runtime/include/jsrt_value.h), numbered here because generated C
 * spells them as numbers: three per source, array then map then set; `matchAll` sits at 9 and
 * the string code-point walk at 10. */
export const ITER_KINDS = {
  array: { keys: 0, values: 1, entries: 2 },
  map: { keys: 3, values: 4, entries: 5 },
  set: { keys: 6, values: 7, entries: 8 },
  matchAll: 9,
  string: 10,
} as const;

/** `t[i]` on a target of type `t`: the dynamic read for an Unknown target, the typed-array read
 * for a Uint8Array (ToUint8 storage, `undefined` out of range), the array read otherwise. The static
 * forms degrade to the dynamic one for a receiver that arrives as something else (STA2008). */
export function indexGetCall(target: HType, object: string, index: string): string {
  switch (target.kind) {
    case 'unknown':
      return `jsrt_dyn_index_get(${object}, ${index}, NULL)`;
    case 'uint8array':
      return `jsrt_uint8array_get(${object}, ${index})`;
    default:
      return `jsrt_array_get(${object}, ${index})`;
  }
}

/** The write half of {@link indexGetCall}. */
export function indexSetCall(target: HType, object: string, index: string, value: string): string {
  switch (target.kind) {
    case 'unknown':
      return `jsrt_dyn_index_set(${object}, ${index}, ${value}, NULL)`;
    case 'uint8array':
      return `jsrt_uint8array_put(${object}, ${index}, ${value})`;
    case 'array':
      // Only an array whose element is Unknown may be made sparse: a typed element has no value
      // that could stand for a hole, so its write past the end stays STA2002 (docs/VALUE.md §4.4).
      return target.element.kind === 'unknown'
        ? `jsrt_array_set_sparse(${object}, ${index}, ${value})`
        : `jsrt_array_set(${object}, ${index}, ${value})`;
    default:
      return `jsrt_array_set(${object}, ${index}, ${value})`;
  }
}

/** Whether a `set`/`add` may meet a weak collection and a key it refuses (docs/VALUE.md §4.22).
 * A WeakMap is typed as a Map, so the KEY type decides: a primitive key means a non-weak Map,
 * and an object-typed key is always accepted, which leaves the open ones. */
export function mayRefuseWeakKey(expr: CollectionOp): boolean {
  if (expr.op !== 'set' && expr.op !== 'add') {
    return false;
  }
  const type = expr.target.type;
  const key = type.kind === 'map' ? type.key : type.kind === 'set' ? type.element : undefined;
  return key === undefined || key.kind === 'unknown' || key.kind === 'type-param';
}

export function iteratorBoxCall(
  expr: ArrayOp | CollectionOp,
  operands: string,
): string | undefined {
  if (expr.op !== 'keys' && expr.op !== 'values' && expr.op !== 'entries') {
    return undefined;
  }
  const source: 'array' | 'map' | 'set' =
    expr.kind === 'array-op' ? 'array' : expr.collection === 'set' ? 'set' : 'map';
  return `jsrt_iterator_new(${operands}, ${String(ITER_KINDS[source][expr.op])})`;
}

export function collectionCall(
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
