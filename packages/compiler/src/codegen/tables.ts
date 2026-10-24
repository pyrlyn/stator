/** Operator and check tables for the C emitter (T24 split). */

import type { BinaryOp, UnaryOp } from '../hir/nodes.ts';

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
