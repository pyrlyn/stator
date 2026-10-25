/* print_numbers.c — prints a fixed corpus of doubles through jsrt_print.
 *
 * Ground truth is Node, not a table hand-written here: runtime/tests/print_numbers.ts prints
 * the SAME corpus with console.log, and `just runtime-test` diffs the two byte-for-byte.
 * Hand-written expectations would only encode whatever this file already believes.
 *
 * Keep the two corpora in the same order. Each entry is a case that the obvious "%g"
 * implementation gets wrong (docs/VALUE.md §3.2) or a boundary of an ECMA-262 step.
 */

#include "jsrt_value.h"

int main(void) {
  jsrt_init();

  static const double corpus[] = {
      /* step 6: integers, where %g switches to exponential on its own */
      0.0, 1.0, 7.0, 100.0, 12345.0, 1e15, 1e20,
      /* 1e21 is the decimal/exponential boundary: 1e20 spells out, 1e21 does not */
      1e21, 1e22,
      /* step 7: point inside the digits */
      1.5, 0.5, 3.14159, 1234.5678, 123456789.123,
      /* step 8: leading zeros, down to the -6 boundary */
      0.1, 0.001, 0.000001, 1e-7, 1.5e-7,
      /* step 5: shortest round-trip, not 17 digits */
      0.1 + 0.2, 1.0 / 3.0,
      /* signs and specials */
      -1.0, -0.5, -1e21, -1e-7,
      /* extremes */
      5e-324, 1.7976931348623157e308, 2.2250738585072014e-308,
      /* int32 boundaries -- these become the Int32 tag in Phase 3 and must not change */
      2147483647.0, -2147483648.0, 4294967295.0,
      /* exactly representable but long */
      9007199254740991.0, 9007199254740992.0,
  };

  for (size_t i = 0; i < sizeof corpus / sizeof corpus[0]; i++) {
    jsrt_print(jsrt_number(corpus[i]));
  }

  /* -0 and the non-finites are not in the array: -0.0 as an initializer is preserved, but
   * keeping them here makes the console.log-specific rules (docs/VALUE.md §3.3) explicit. */
  jsrt_print(jsrt_number(-0.0));  /* "-0" -- console.log shows the sign; ToString would not */
  jsrt_print(jsrt_number(0.0 / 0.0));
  jsrt_print(jsrt_number(1.0 / 0.0));
  jsrt_print(jsrt_number(-1.0 / 0.0));

  jsrt_print(JSRT_TRUE);
  jsrt_print(JSRT_FALSE);
  jsrt_print(JSRT_NULL);
  jsrt_print(JSRT_UNDEFINED);

  /* Non-ASCII must survive as UTF-8, not become '?'. Astral plane exercises the
   * surrogate-pair path; the lone surrogate cannot be spelled in a UTF-8 source literal and is
   * covered by the unit assertions instead. */
  jsrt_print(jsrt_string_from_utf8("hello", 5));
  jsrt_print(jsrt_string_from_utf8("héllo wörld", 13));
  jsrt_print(jsrt_string_from_utf8("日本語", 9));
  jsrt_print(jsrt_string_from_utf8("emoji: \xF0\x9F\x90\x89", 11));

  /* Numeric helper tests: ToInt32 edge cases (NUMERIC.md §4.1) */
  jsrt_print(jsrt_number((double)jsrt_to_int32(1e21)));
  jsrt_print(jsrt_number((double)jsrt_to_int32(1e10)));
  jsrt_print(jsrt_number((double)jsrt_to_int32(1.0 / 3.0)));
  jsrt_print(jsrt_number((double)jsrt_to_int32(2147483648.0)));
  jsrt_print(jsrt_number((double)jsrt_to_int32(4294967296.0)));
  jsrt_print(jsrt_number((double)jsrt_to_int32(0.0 / 0.0))); /* NaN */
  jsrt_print(jsrt_number((double)jsrt_to_int32(INFINITY)));
  jsrt_print(jsrt_number((double)jsrt_to_uint32(-1.0))); /* (-1) >>> 0 */

  /* ToNumber conversions */
  jsrt_print(jsrt_number(jsrt_to_number(JSRT_TRUE)));
  jsrt_print(jsrt_number(jsrt_to_number(JSRT_FALSE)));
  jsrt_print(jsrt_number(jsrt_to_number(JSRT_NULL)));
  jsrt_print(jsrt_number(jsrt_to_number(JSRT_UNDEFINED)));

  /* StringNumericLiteral tests */
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("", 0))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("0", 1))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("10", 2))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("0x10", 4))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("Infinity", 8))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("+Infinity", 9))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("-Infinity", 9))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("  42  ", 6))));
  jsrt_print(jsrt_number(jsrt_string_to_number(jsrt_string_from_utf8("12abc", 5)))); /* trailing garbage -> NaN */

  /* Truthy/falsy tests */
  jsrt_print(jsrt_bool(jsrt_truthy(JSRT_FALSE)));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_number(0.0))));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_number(-0.0))));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_number(0.0 / 0.0)))); /* NaN */
  jsrt_print(jsrt_bool(jsrt_truthy(JSRT_UNDEFINED)));
  jsrt_print(jsrt_bool(jsrt_truthy(JSRT_NULL)));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_string_from_utf8("", 0)))); /* empty string */
  jsrt_print(jsrt_bool(jsrt_truthy(JSRT_TRUE)));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_number(1.0))));
  jsrt_print(jsrt_bool(jsrt_truthy(jsrt_string_from_utf8("0", 1)))); /* non-empty string */

  /* Loose equality tests (NUMERIC.md §6.3) */
  jsrt_print(jsrt_bool(jsrt_loose_equals(JSRT_NULL, JSRT_UNDEFINED)));
  jsrt_print(jsrt_bool(jsrt_loose_equals(JSRT_UNDEFINED, JSRT_NULL)));
  jsrt_print(jsrt_bool(jsrt_loose_equals(JSRT_NULL, jsrt_number(0.0))));
  jsrt_print(jsrt_bool(jsrt_loose_equals(jsrt_string_from_utf8("", 0), jsrt_number(0.0))));
  jsrt_print(jsrt_bool(jsrt_loose_equals(jsrt_string_from_utf8("0x10", 4), jsrt_number(16.0))));

  /* SameValue (Object.is) tests (NUMERIC.md §5.2) */
  jsrt_print(jsrt_bool(jsrt_same_value(jsrt_number(0.0 / 0.0), jsrt_number(0.0 / 0.0)))); /* NaN, NaN */
  jsrt_print(jsrt_bool(jsrt_same_value(jsrt_number(-0.0), jsrt_number(0.0))));

  /* String equality and comparison tests (Phase 3 rung 2 — strings) */
  jsrt_print(jsrt_bool(jsrt_strict_equals(jsrt_string_from_utf8("ab", 2), jsrt_string_from_utf8("ab", 2)))); /* identical content, different allocations */
  jsrt_print(jsrt_bool(jsrt_strict_equals(jsrt_string_from_utf8("a", 1), jsrt_string_from_utf8("b", 1)))); /* different */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_string_from_utf8("ab", 2), jsrt_string_from_utf8("b", 1)))); /* "ab" < "b" lexicographically */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_string_from_utf8("b", 1), jsrt_string_from_utf8("ab", 2)))); /* "b" < "ab" is false */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_string_from_utf8("10", 2), jsrt_string_from_utf8("9", 1)))); /* "10" < "9" is true (string compare: '1' < '9') */

  /* jsrt_op_add tests (ECMA-262: if either is a string, ToString both and concatenate) */
  jsrt_print(jsrt_op_add(jsrt_number(1.0), jsrt_string_from_utf8("2", 1))); /* 1 + "2" -> "12" */
  jsrt_print(jsrt_op_add(jsrt_string_from_utf8("a", 1), jsrt_number(1.0))); /* "a" + 1 -> "a1" */
  jsrt_print(jsrt_op_add(JSRT_TRUE, jsrt_string_from_utf8("x", 1))); /* true + "x" -> "truex" */
  jsrt_print(jsrt_op_add(JSRT_NULL, jsrt_string_from_utf8("x", 1))); /* null + "x" -> "nullx" */
  jsrt_print(jsrt_op_add(JSRT_UNDEFINED, jsrt_string_from_utf8("x", 1))); /* undefined + "x" -> "undefinedx" */
  jsrt_print(jsrt_op_add(jsrt_number(1.0), jsrt_number(2.0))); /* 1 + 2 -> 3 (numeric) */
  jsrt_print(jsrt_op_add(jsrt_string_from_utf8("a", 1), jsrt_string_from_utf8("b", 1))); /* "a" + "b" -> "ab" (string) */

  /* Relational comparison with mixed types (must convert to number, not string) */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_string_from_utf8("10", 2), jsrt_number(9.0)))); /* "10" < 9 is false (numeric: 10 < 9) */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_number(10.0), jsrt_string_from_utf8("9", 1)))); /* 10 < "9" is false (numeric: 10 < 9) */

  /* NaN relational behavior: all four operators return false for NaN */
  jsrt_print(jsrt_bool(jsrt_op_lt(jsrt_number(0.0 / 0.0), jsrt_number(1.0)))); /* NaN < 1 is false */
  jsrt_print(jsrt_bool(jsrt_op_gt(jsrt_number(0.0 / 0.0), jsrt_number(1.0)))); /* NaN > 1 is false */
  jsrt_print(jsrt_bool(jsrt_op_le(jsrt_number(0.0 / 0.0), jsrt_number(1.0)))); /* NaN <= 1 is false */
  jsrt_print(jsrt_bool(jsrt_op_ge(jsrt_number(0.0 / 0.0), jsrt_number(1.0)))); /* NaN >= 1 is false */

  return 0;
}
