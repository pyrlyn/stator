/* print_numbers.ts — the ground truth for runtime/tests/print_numbers.c.
 *
 * Same corpus, same order, console.log. `just runtime-test` diffs this against the C
 * program's stdout byte-for-byte. Edit both files together or the diff is meaningless.
 */

const corpus = [
  0.0, 1.0, 7.0, 100.0, 12345.0, 1e15, 1e20,
  1e21, 1e22,
  1.5, 0.5, 3.14159, 1234.5678, 123456789.123,
  0.1, 0.001, 0.000001, 1e-7, 1.5e-7,
  0.1 + 0.2, 1.0 / 3.0,
  -1.0, -0.5, -1e21, -1e-7,
  5e-324, 1.7976931348623157e308, 2.2250738585072014e-308,
  2147483647.0, -2147483648.0, 4294967295.0,
  9007199254740991.0, 9007199254740992.0,
];

for (const d of corpus) {
  console.log(d);
}

console.log(-0.0);
console.log(0.0 / 0.0);
console.log(1.0 / 0.0);
console.log(-1.0 / 0.0);

console.log(true);
console.log(false);
console.log(null);
console.log(undefined);

console.log('hello');
console.log('héllo wörld');
console.log('日本語');
console.log('emoji: 🐉');

// Numeric helper tests: ToInt32 edge cases (NUMERIC.md §4.1)
console.log(1e21 | 0);
console.log(1e10 | 0);
console.log((1.0 / 3.0) | 0);
console.log(2147483648 | 0);
console.log(4294967296 | 0);
console.log(NaN | 0);
console.log(Infinity | 0);
console.log((-1) >>> 0);

// ToNumber conversions
console.log(Number(true));
console.log(Number(false));
console.log(Number(null));
console.log(Number(undefined));

// StringNumericLiteral tests
console.log(Number(''));
console.log(Number('0'));
console.log(Number('10'));
console.log(Number('0x10'));
console.log(Number('Infinity'));
console.log(Number('+Infinity'));
console.log(Number('-Infinity'));
console.log(Number('  42  '));
console.log(Number('12abc'));

// Truthy/falsy tests
console.log(Boolean(false));
console.log(Boolean(0));
console.log(Boolean(-0));
console.log(Boolean(NaN));
console.log(Boolean(undefined));
console.log(Boolean(null));
console.log(Boolean(''));
console.log(Boolean(true));
console.log(Boolean(1));
console.log(Boolean('0'));

// Loose equality tests (NUMERIC.md §6.3)
console.log(null == undefined);
console.log(undefined == null);
console.log(null == 0);
console.log('' == 0);
console.log('0x10' == 16);

// SameValue (Object.is) tests (NUMERIC.md §5.2)
console.log(Object.is(NaN, NaN));
console.log(Object.is(-0, 0));

// String equality and comparison tests (Phase 3 rung 2 — strings)
console.log('ab' === 'ab'); // identical content, different allocations
console.log('a' === 'b'); // different
console.log('ab' < 'b'); // "ab" < "b" lexicographically
console.log('b' < 'ab'); // "b" < "ab" is false
console.log('10' < '9'); // "10" < "9" is true (string compare: '1' < '9')

// + operator tests (ECMA-262: if either is a string, ToString both and concatenate)
console.log(1 + '2'); // 1 + "2" -> "12"
console.log('a' + 1); // "a" + 1 -> "a1"
console.log(true + 'x'); // true + "x" -> "truex"
console.log(null + 'x'); // null + "x" -> "nullx"
console.log(undefined + 'x'); // undefined + "x" -> "undefinedx"
console.log(1 + 2); // 1 + 2 -> 3 (numeric)
console.log('a' + 'b'); // "a" + "b" -> "ab" (string)

// Relational comparison with mixed types (must convert to number, not string)
console.log('10' < 9); // "10" < 9 is false (numeric: 10 < 9)
console.log(10 < '9'); // 10 < "9" is false (numeric: 10 < 9)

// NaN relational behavior: all four operators return false for NaN
console.log(NaN < 1); // NaN < 1 is false
console.log(NaN > 1); // NaN > 1 is false
console.log(NaN <= 1); // NaN <= 1 is false
console.log(NaN >= 1); // NaN >= 1 is false
