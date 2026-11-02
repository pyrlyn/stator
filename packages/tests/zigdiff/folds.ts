// A hand-built module that puts every operator the const-folder knows over the corners of its
// domain, for the two compilers to fold and be compared on, plus the trees the inliner must refuse
// and the lowering never builds. The values are the ones JavaScript's
// conversions treat specially; the seeded doubles are for what no list of corners reaches, the
// rounding of `**`, `%` and of printing and parsing a number.
import type {
  BinaryOp,
  Expression,
  FunctionExpr,
  Module,
  Statement,
} from '../../compiler/src/hir/nodes.ts';
import {
  hFunction,
  H_BOOLEAN,
  H_NULL,
  H_NUMBER,
  H_STRING,
  H_UNDEFINED,
  type HType,
} from '../../compiler/src/hir/types.ts';

type Value = number | string | boolean | null | undefined;

const span = { start: 0, length: 0, line: 1 };

const NUMBERS: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.5,
  -0.5,
  1.5,
  -1.5,
  2,
  -2,
  3,
  7,
  -7,
  10,
  31,
  32,
  33,
  255,
  2147483647,
  2147483648,
  -2147483648,
  4294967295,
  4294967296,
  9007199254740992,
  9007199254740994,
  1e21,
  1e-6,
  1e-7,
  123456789012345680000,
  1.7976931348623157e308,
  5e-324,
  2.2250738585072014e-308,
  Number.NaN,
  Infinity,
  -Infinity,
];

const STRINGS: readonly string[] = [
  '',
  '0',
  '-0',
  ' 1 ',
  '1.5',
  '.5',
  '5.',
  '.',
  'abc',
  '0x10',
  '0X1f',
  '0b11',
  '0o7',
  '-0x10',
  '1e3',
  '1E-2',
  'Infinity',
  '-Infinity',
  '+Infinity',
  'infinity',
  '+5',
  ' 1﻿',
  '\t\n12\r',
  '\u{1f600}',
  '\ud83d',
  '\ude00',
  '١',
  'a\u{1f600}b',
  '1_000',
  '1n',
  '￿',
];

const VALUES: readonly Value[] = [...NUMBERS, ...STRINGS, true, false, null, undefined];

const ARITHMETIC = ['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'] as const;
const PREDICATES = ['<', '>', '<=', '>=', '===', '!==', '==', '!='] as const;

/** Numbers drawn from the 64 bits of a fixed sequence, so every run asks the same questions. */
function seededDoubles(count: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  let state = 0x9e3779b97f4a7c15n;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    state ^= (state << 13n) & 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= (state << 17n) & 0xffffffffffffffffn;
    view.setBigUint64(0, state);
    out.push(view.getFloat64(0));
  }
  return out;
}

function typeOf(value: Value): HType {
  if (value === null) return H_NULL;
  switch (typeof value) {
    case 'number':
      return H_NUMBER;
    case 'string':
      return H_STRING;
    case 'boolean':
      return H_BOOLEAN;
    default:
      return H_UNDEFINED;
  }
}

function literal(value: Value): Expression {
  if (value === null) return { kind: 'null-literal', type: H_NULL, span };
  switch (typeof value) {
    case 'number':
      return { kind: 'number-literal', type: H_NUMBER, span, value };
    case 'string':
      return { kind: 'string-literal', type: H_STRING, span, value };
    case 'boolean':
      return { kind: 'boolean-literal', type: H_BOOLEAN, span, value };
    default:
      return { kind: 'undefined-literal', type: H_UNDEFINED, span };
  }
}

function binary(
  operator: BinaryOp['operator'],
  type: HType,
  left: Value,
  right: Value,
): Expression {
  return { kind: 'binary-op', type, span, operator, left: literal(left), right: literal(right) };
}

function add(left: Value, right: Value): Expression {
  const concatenates = typeof left === 'string' || typeof right === 'string';
  return binary('+', concatenates ? H_STRING : H_NUMBER, left, right);
}

function pairs(left: Value, right: Value): Expression[] {
  return [
    add(left, right),
    ...ARITHMETIC.map((operator) => binary(operator, H_NUMBER, left, right)),
    ...PREDICATES.map((operator) => binary(operator, H_BOOLEAN, left, right)),
    binary(',', typeOf(right), left, right),
    binary('in', H_BOOLEAN, left, right),
    {
      kind: 'logical-op',
      type: typeOf(left),
      span,
      operator: '&&',
      left: literal(left),
      right: literal(right),
    },
    {
      kind: 'logical-op',
      type: typeOf(right),
      span,
      operator: '||',
      left: literal(left),
      right: literal(right),
    },
    {
      kind: 'logical-op',
      type: typeOf(right),
      span,
      operator: '??',
      left: literal(left),
      right: literal(right),
    },
    {
      kind: 'template-literal',
      type: H_STRING,
      span,
      quasis: ['<', '|', '>'],
      expressions: [literal(left), literal(right)],
    },
  ];
}

function singles(value: Value): Expression[] {
  const operand = literal(value);
  const out: Expression[] = [
    { kind: 'unary-op', type: H_NUMBER, span, operator: '-', operand },
    { kind: 'unary-op', type: H_NUMBER, span, operator: '+', operand },
    { kind: 'unary-op', type: H_NUMBER, span, operator: '~', operand },
    { kind: 'unary-op', type: H_BOOLEAN, span, operator: '!', operand },
    { kind: 'unary-op', type: H_UNDEFINED, span, operator: 'void', operand },
    { kind: 'typeof', type: H_STRING, span, operand },
    add('', value),
  ];
  if (typeof value === 'string') {
    out.push({ kind: 'string-length', type: H_NUMBER, span, operand });
  }
  return out;
}

/** Each number as text in the spellings that stress parsing: the shortest, its exact digits, and a
 * spelling past what a double holds, whose last digit only a correctly rounded reader notices. */
function spellings(value: number): readonly string[] {
  if (!Number.isFinite(value)) return [String(value)];
  const [mantissa = '', exponent = ''] = value.toExponential(20).split('e');
  const digits = BigInt(Math.trunc(value)).toString();
  return [
    String(value),
    digits,
    `${mantissa}e${exponent}`,
    `${mantissa}${'0'.repeat(40)}1e${exponent}`,
  ];
}

function functionOf(
  params: readonly string[],
  body: readonly Statement[],
  ret: HType,
): FunctionExpr {
  return {
    kind: 'function',
    type: hFunction(
      params.map(() => H_NUMBER),
      ret,
    ),
    span,
    params: params.map((name) => ({ name, type: H_NUMBER, span })),
    body: { kind: 'block', type: H_UNDEFINED, span, statements: body },
    envVars: [],
    captures: [],
    needsEnv: false,
    isAsync: false,
    isGenerator: false,
    provenance: 'typed',
  };
}

/** `function name(a) { return result; } name(1);` The call is what makes it an inlining candidate. */
function candidateAndCall(name: string, result: FunctionExpr): Statement[] {
  const value = functionOf(
    ['a'],
    [{ kind: 'return-statement', type: result.type, span, value: result }],
    result.type,
  );
  const callee: Expression = { kind: 'identifier', type: value.type, span, name };
  const expression: Expression = {
    kind: 'call',
    type: result.type,
    span,
    callee,
    args: [literal(1)],
  };
  return [
    { kind: 'function-declaration', type: H_UNDEFINED, span, name, fn: value },
    { kind: 'expression-statement', type: result.type, span, expression },
  ];
}

/** Bodies that rebind the parameter they would be inlined over. The lowering renames every shadowing
 * binding, so no source program reaches this rule and only a tree built by hand can. */
function rebindings(): Statement[] {
  const a: Expression = { kind: 'identifier', type: H_NUMBER, span, name: 'a' };
  const returnsA: Statement = { kind: 'return-statement', type: H_NUMBER, span, value: a };
  const redeclares: Statement = {
    kind: 'declaration',
    type: H_NUMBER,
    span,
    name: 'a',
    declKind: 'const',
    value: literal(7),
  };
  return [
    ...candidateAndCall('rebindsAsParameter', functionOf(['a'], [returnsA], H_NUMBER)),
    ...candidateAndCall('rebindsAsLocal', functionOf([], [redeclares, returnsA], H_NUMBER)),
  ];
}

export function foldProbe(): Module {
  const expressions: Expression[] = [];
  for (const left of VALUES) {
    expressions.push(...singles(left));
    for (const right of VALUES) expressions.push(...pairs(left, right));
  }
  const doubles = seededDoubles(4000);
  doubles.forEach((value, i) => {
    const other = doubles[(i * 7 + 1) % doubles.length] ?? 0;
    expressions.push(...singles(value));
    for (const text of spellings(value)) expressions.push(...singles(text));
    expressions.push(...pairs(value, other));
    // Ordinary magnitudes: a random double is usually so large or small that `**` and `%`
    // saturate, and the interesting results never appear.
    const small = (value % 16) + 1 / 3;
    const smallOther = (other % 8) + 1 / 7;
    expressions.push(...pairs(small, smallOther), ...pairs(small, Math.trunc(smallOther)));
  });
  // V8 answers these two exponents exactly where libc can be a unit off, on about one input in 1500
  // and only at exactly 2 and 0.5, which the sampling above seldom lands on.
  for (const value of seededDoubles(40000)) {
    expressions.push(
      binary('**', H_NUMBER, value % 1000, 2),
      binary('**', H_NUMBER, value, 2),
      binary('**', H_NUMBER, Math.abs(value), 0.5),
    );
  }
  const statements = expressions.map((expression): Statement => ({
    kind: 'expression-statement',
    type: expression.type,
    span,
    expression,
  }));
  return {
    kind: 'module',
    type: H_UNDEFINED,
    span,
    fileName: 'synthetic/folds',
    statements: [...statements, ...rebindings()],
    isAsync: false,
    envVars: [],
  };
}
