/* jsrt_numeric.c — numeric conversions and comparisons.
 *
 * Implements NUMERIC.md §4 (ToInt32/ToUint32), §5 (NaN/−0/Object.is),
 * §6 (comparison and equality), and the StringNumericLiteral grammar (§6.3).
 *
 * See docs/NUMERIC.md for the complete specification.
 */

#include "jsrt_value.h"

#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================================
 * ToInt32 and ToUint32 — NUMERIC.md §4.1
 * ============================================================================ */

/* ToInt32: convert a double to a signed 32-bit integer using the spec algorithm.
 * This is NOT a C cast (which would be undefined behaviour out of range).
 *
 * Algorithm (NUMERIC.md §4.1):
 *   if x is NaN, +0, -0, +Infinity, or -Infinity  ->  +0
 *   let i = sign(x) * floor(abs(x))          # truncate toward zero
 *   let n = i modulo 2^32                    # mathematical modulo, always non-negative
 *   if n >= 2^31, return n - 2^32
 *   return n */
int32_t jsrt_to_int32(double d) {
  /* NaN and infinities -> 0 */
  if (!isfinite(d)) {
    return 0;
  }

  /* Truncate toward zero: sign(x) * floor(abs(x)) */
  double truncated = d < 0.0 ? -floor(-d) : floor(d);

  /* Mathematical modulo 2^32 (always non-negative).
   * fmod gives a result with the sign of the dividend, so negative truncated
   * values need adjustment. */
  double mod = fmod(truncated, 4294967296.0); /* 2^32 */
  if (mod < 0.0) {
    mod += 4294967296.0;
  }

  /* If >= 2^31, subtract 2^32 to get a negative result */
  if (mod >= 2147483648.0) { /* 2^31 */
    return (int32_t)(mod - 4294967296.0);
  }
  return (int32_t)mod;
}

/* ToUint32: convert a double to an unsigned 32-bit integer.
 * Same algorithm, but return the non-negative modulo directly. */
uint32_t jsrt_to_uint32(double d) {
  if (!isfinite(d)) {
    return 0;
  }

  double truncated = d < 0.0 ? -floor(-d) : floor(d);
  double mod = fmod(truncated, 4294967296.0);
  if (mod < 0.0) {
    mod += 4294967296.0;
  }

  return (uint32_t)mod;
}

/* ============================================================================
 * ToNumber — NUMERIC.md §6.3
 * ============================================================================ */

/* Convert a jsrt_value primitive to a number.
 *
 * - double: return as-is
 * - boolean: true -> 1, false -> 0
 * - null: 0
 * - undefined: NaN
 * - string: StringNumericLiteral grammar
 * - object: ToPrimitive first, then the rules above -- so `Number([5])` is 5, not NaN. */
double jsrt_to_number(jsrt_value v) {
  if (jsrt_is_object(v)) {
    /* The program's `valueOf` may throw: NaN stands in until the caller's pending check. */
    v = jsrt_to_primitive(v, JSRT_HINT_NUMBER);
    if (jsrt_pending()) {
      return 0.0 / 0.0;
    }
  }

  if (jsrt_is_double(v)) {
    return jsrt_to_double(v);
  }

  if (jsrt_is(v, JSRT_TAG_BOOL)) {
    return jsrt_as_bool(v) ? 1.0 : 0.0;
  }

  if (jsrt_is(v, JSRT_TAG_NULL)) {
    return 0.0;
  }

  if (jsrt_is(v, JSRT_TAG_UNDEFINED)) {
    return 0.0 / 0.0; /* NaN */
  }

  if (jsrt_is(v, JSRT_TAG_STRING)) {
    return jsrt_string_to_number(v);
  }

  if (jsrt_is(v, JSRT_TAG_INT32)) {
    return (double)jsrt_as_int32(v);
  }

  /* Objects and other types -> NaN (Phase 3 rung 6 when objects land) */
  return 0.0 / 0.0; /* NaN */
}

/* ============================================================================
 * StringNumericLiteral grammar — NUMERIC.md §6.3
 * ============================================================================ */

/* StrWhiteSpaceChar (WhiteSpace + LineTerminator): the trim set for
 * StringNumericLiteral. This is NOT C isspace: the 0x09-0x0D range covers VT
 * (0x0B), which an ASCII-blank set misses, and NBSP/ZWNBSP/the Zs block are
 * trimmable here while interior ones still reject below. */
static bool is_str_white_space(uint16_t ch) {
  if (ch >= 0x0009 && ch <= 0x000D) {
    return true; /* TAB LF VT FF CR */
  }
  if (ch >= 0x2000 && ch <= 0x200A) {
    return true;
  }
  switch (ch) {
    case 0x0020: /* SPACE */
    case 0x00A0: /* NBSP */
    case 0x1680:
    case 0x2028: /* LS */
    case 0x2029: /* PS */
    case 0x202F:
    case 0x205F:
    case 0x3000:
    case 0xFEFF: /* ZWNBSP */
      return true;
    default:
      return false;
  }
}

static bool is_hex_digit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/* Accumulate base-2/8 digits: exact in uint64 while it fits, then double.
 * Hex takes the validated-strtod path below instead, which rounds correctly
 * for huge integers. */
static double parse_small_radix(const char *p, size_t n, unsigned base) {
  uint64_t acc = 0;
  size_t i = 0;
  uint64_t limit = (UINT64_MAX - (uint64_t)(base - 1u)) / (uint64_t)base;
  while (i < n && acc <= limit) {
    acc = acc * (uint64_t)base + (uint64_t)(p[i] - '0');
    i++;
  }
  if (i == n) {
    return (double)acc;
  }
  double d = (double)acc;
  while (i < n) {
    d = d * (double)base + (double)(p[i] - '0');
    i++;
  }
  return d;
}

/* The trimmed ASCII spelling, NUL-terminated with its length. Every branch
 * returns; the caller owns nothing. */
static double parse_numeric_literal(const char *buf, size_t n) {
  const double nan = 0.0 / 0.0;

  /* "Infinity" with an optional sign is the only valid spelling starting with
   * a letter; strtod would also take inf/Inf/INFINITY/nan in any case. */
  if (n == 8 && strncmp(buf, "Infinity", 8) == 0) {
    return INFINITY;
  }
  if (n == 9 && strncmp(buf, "+Infinity", 9) == 0) {
    return INFINITY;
  }
  if (n == 9 && strncmp(buf, "-Infinity", 9) == 0) {
    return -INFINITY;
  }

  /* Unsigned non-decimal forms: no sign allowed, at least one digit, digits
   * only. strtod reads hex itself (including hex floats like 0x1p4, which the
   * grammar rejects), so hex is validated here and only CONVERTED by strtod;
   * binary/octal have no strtod form and accumulate above. */
  if (n >= 2 && buf[0] == '0' &&
      (buf[1] == 'x' || buf[1] == 'X' || buf[1] == 'b' || buf[1] == 'B' ||
       buf[1] == 'o' || buf[1] == 'O')) {
    if (n == 2) {
      return nan; /* "0x", "0b", "0o" with no digits */
    }
    if (buf[1] == 'x' || buf[1] == 'X') {
      for (size_t k = 2; k < n; k++) {
        if (!is_hex_digit(buf[k])) {
          return nan;
        }
      }
      char *endptr = NULL;
      double val = strtod(buf, &endptr);
      if (endptr != buf + n) {
        return nan; /* defensive: validation consumed the whole span */
      }
      return val;
    }
    unsigned base = (buf[1] == 'b' || buf[1] == 'B') ? 2u : 8u;
    for (size_t k = 2; k < n; k++) {
      if (buf[k] < '0' || buf[k] >= (char)('0' + base)) {
        return nan;
      }
    }
    return parse_small_radix(buf + 2, n - 2, base);
  }

  /* A sign does not rescue a non-decimal form ("-0x10" is NaN), and strtod
   * would read signed hex itself; likewise any other inf/nan-case spelling. */
  size_t q = 0;
  if (q < n && (buf[q] == '+' || buf[q] == '-')) {
    q++;
  }
  if (q < n && (buf[q] == 'i' || buf[q] == 'I' || buf[q] == 'n' || buf[q] == 'N')) {
    return nan;
  }
  if (q + 1 < n && buf[q] == '0' &&
      (buf[q + 1] == 'x' || buf[q + 1] == 'X' || buf[q + 1] == 'b' ||
       buf[q + 1] == 'B' || buf[q + 1] == 'o' || buf[q + 1] == 'O')) {
    return nan;
  }

  /* Decimal: strtod, which must consume the entire trimmed span — it accepts
   * no trailing garbage the way the grammar forbids, and consumes nothing for
   * spellings like "" or "e5", both NaN. Embedded NULs end the conversion
   * early and fail the same full-span check. */
  char *endptr = NULL;
  double result = strtod(buf, &endptr);
  if (endptr == buf || endptr != buf + n) {
    return nan;
  }
  return result;
}

/* Parse a string as a number using the spec's StringNumericLiteral grammar,
 * NOT strtod. Key differences:
 *   - strtod accepts trailing garbage; spec does not
 *   - strtod("") returns 0 with no characters consumed; we must check fully
 *   - "0x10" is hex (16); strtod treats it as hex but we must be specific
 *   - "Infinity" parses; strtod may not (depending on implementation)
 *   - StrWhiteSpaceChar trims at both edges; any other non-ASCII unit -> NaN */
double jsrt_string_to_number(jsrt_value s) {
  /* Verify this is a string */
  if (!jsrt_is(s, JSRT_TAG_STRING)) {
    return 0.0 / 0.0; /* NaN */
  }

  uint32_t len = jsrt_string_length(s);

  /* Trim StrWhiteSpaceChar at both ends, then require ASCII in what survives:
   * the grammars below are ASCII-only, so an interior NBSP (or any other
   * non-ASCII unit) is NaN while an edge one was already trimmed. */
  uint32_t pos = 0;
  while (pos < len && is_str_white_space(jsrt_string_char(s, pos))) {
    pos++;
  }
  if (pos >= len) {
    return 0.0; /* empty or all-whitespace */
  }
  uint32_t end = len;
  while (end > pos && is_str_white_space(jsrt_string_char(s, end - 1))) {
    end--;
  }
  for (uint32_t i = pos; i < end; i++) {
    if (jsrt_string_char(s, i) > 127) {
      return 0.0 / 0.0; /* NaN */
    }
  }

  /* Numeric text of any length converts (a 300-digit decimal is 1e300, not
   * NaN), so the spelling is copied to a heap buffer rather than a fixed
   * stack one. The length guard keeps (size_t)len + 1 from wrapping malloc's
   * argument; the NULL check is the OOM answer. */
  if (len == UINT32_MAX) {
    return 0.0 / 0.0; /* NaN */
  }
  size_t n = (size_t)(end - pos);
  char *buf = (char *)malloc(n + 1);
  if (buf == NULL) {
    return 0.0 / 0.0; /* NaN */
  }
  for (uint32_t i = 0; i < (uint32_t)n; i++) {
    buf[i] = (char)jsrt_string_char(s, pos + i);
  }
  buf[n] = '\0';

  double result = parse_numeric_literal(buf, n);
  free(buf);
  return result;
}

/* ============================================================================
 * ToBoolean — NUMERIC.md (derived)
 * ============================================================================ */

/* Truthy/falsy values. False for: false, +0, -0, NaN, undefined, null, empty string.
 * True for everything else (including "0" and "false" as strings). */
bool jsrt_truthy(jsrt_value v) {
  if (jsrt_is(v, JSRT_TAG_BOOL)) {
    return jsrt_as_bool(v);
  }

  if (jsrt_is_double(v)) {
    double d = jsrt_to_double(v);
    /* Falsy: +0, -0, NaN */
    return d != 0.0 && !isnan(d);
  }

  if (jsrt_is(v, JSRT_TAG_INT32)) {
    return jsrt_as_int32(v) != 0;
  }

  if (jsrt_is(v, JSRT_TAG_NULL) || jsrt_is(v, JSRT_TAG_UNDEFINED)) {
    return false;
  }

  if (jsrt_is(v, JSRT_TAG_STRING)) {
    /* Empty string is falsy */
    return jsrt_string_length(v) != 0;
  }

  /* Objects, closures, arrays -> true */
  return true;
}

/* ============================================================================
 * Loose equality (==) — NUMERIC.md §6.3
 * ============================================================================ */

/* Loose equality according to NUMERIC.md §6.3's table.
 *
 * Key insight: null == undefined is true, and null/undefined are equal to
 * nothing else (not even 0). Must short-circuit before any conversion. */
bool jsrt_loose_equals(jsrt_value a, jsrt_value b) {
  /* null == undefined (and undefined == null) */
  if ((jsrt_is(a, JSRT_TAG_NULL) && jsrt_is(b, JSRT_TAG_UNDEFINED)) ||
      (jsrt_is(a, JSRT_TAG_UNDEFINED) && jsrt_is(b, JSRT_TAG_NULL))) {
    return true;
  }

  /* null == null, undefined == undefined */
  if (jsrt_is(a, JSRT_TAG_NULL) && jsrt_is(b, JSRT_TAG_NULL)) {
    return true;
  }
  if (jsrt_is(a, JSRT_TAG_UNDEFINED) && jsrt_is(b, JSRT_TAG_UNDEFINED)) {
    return true;
  }

  /* null and undefined are equal to nothing else */
  if (jsrt_is(a, JSRT_TAG_NULL) || jsrt_is(a, JSRT_TAG_UNDEFINED)) {
    return false;
  }
  if (jsrt_is(b, JSRT_TAG_NULL) || jsrt_is(b, JSRT_TAG_UNDEFINED)) {
    return false;
  }

  /* number OP number -> === */
  if ((jsrt_is_double(a) || jsrt_is(a, JSRT_TAG_INT32)) &&
      (jsrt_is_double(b) || jsrt_is(b, JSRT_TAG_INT32))) {
    return jsrt_strict_equals(a, b);
  }

  /* string OP string -> === */
  if (jsrt_is(a, JSRT_TAG_STRING) && jsrt_is(b, JSRT_TAG_STRING)) {
    return jsrt_strict_equals(a, b);
  }

  /* boolean OP boolean -> === */
  if (jsrt_is(a, JSRT_TAG_BOOL) && jsrt_is(b, JSRT_TAG_BOOL)) {
    return jsrt_strict_equals(a, b);
  }

  /* number OP boolean -> ToNumber(boolean), then === */
  if ((jsrt_is_double(a) || jsrt_is(a, JSRT_TAG_INT32)) && jsrt_is(b, JSRT_TAG_BOOL)) {
    return jsrt_loose_equals(a, jsrt_number(jsrt_to_number(b)));
  }
  if (jsrt_is(a, JSRT_TAG_BOOL) && (jsrt_is_double(b) || jsrt_is(b, JSRT_TAG_INT32))) {
    return jsrt_loose_equals(jsrt_number(jsrt_to_number(a)), b);
  }

  /* string OP boolean -> ToNumber(boolean), then compare */
  if (jsrt_is(a, JSRT_TAG_STRING) && jsrt_is(b, JSRT_TAG_BOOL)) {
    return jsrt_loose_equals(a, jsrt_number(jsrt_to_number(b)));
  }
  if (jsrt_is(a, JSRT_TAG_BOOL) && jsrt_is(b, JSRT_TAG_STRING)) {
    return jsrt_loose_equals(jsrt_number(jsrt_to_number(a)), b);
  }

  /* number OP string -> ToNumber(string), then === */
  if ((jsrt_is_double(a) || jsrt_is(a, JSRT_TAG_INT32)) && jsrt_is(b, JSRT_TAG_STRING)) {
    return jsrt_loose_equals(a, jsrt_number(jsrt_to_number(b)));
  }
  if (jsrt_is(a, JSRT_TAG_STRING) && (jsrt_is_double(b) || jsrt_is(b, JSRT_TAG_INT32))) {
    return jsrt_loose_equals(jsrt_number(jsrt_to_number(a)), b);
  }

  /* object OP object -> reference identity, with NO conversion. Two distinct objects that
   * stringify alike are still unequal, and -- the case whose absence made `a == a` answer false --
   * an object is loosely equal to itself. */
  if (jsrt_is_object(a) && jsrt_is_object(b)) {
    return jsrt_strict_equals(a, b);
  }

  /* object OP primitive -> ToPrimitive the object side (no hint: `default`, §7.2.14 steps 11-12)
   * and ask again. The recursion terminates because ToPrimitive answers a primitive, which no
   * branch here sends back to an object -- or throws, which ends the comparison. */
  if (jsrt_is_object(a) || jsrt_is_object(b)) {
    /* ToPrimitive allocates the primitive (an object's toString builds a string). That string
     * is not the caller's operand, so it has to sit in a slot across the recursive call, which
     * converts the other side and can allocate again. The other operand is parked beside it:
     * it is a parameter, and a parameter is not a root. */
    const bool left = jsrt_is_object(a);
    JSRT_FRAME(2);
    JSRT_LOCAL(0) = a;
    JSRT_LOCAL(1) = b;
    const jsrt_value primitive =
        jsrt_to_primitive(left ? JSRT_LOCAL(0) : JSRT_LOCAL(1), JSRT_HINT_DEFAULT);
    if (jsrt_pending()) {
      JSRT_FRAME_POP();
      return false;
    }
    if (left) {
      JSRT_LOCAL(0) = primitive;
    } else {
      JSRT_LOCAL(1) = primitive;
    }
    const bool eq = jsrt_loose_equals(JSRT_LOCAL(0), JSRT_LOCAL(1));
    JSRT_FRAME_POP();
    return eq;
  }

  /* Unreachable: the eight tags are exhausted above. Here so the function has one exit for a
   * ninth, rather than the answer depending on which branch a new tag happens to fall past. */
  return false;
}

/* ============================================================================
 * SameValue (Object.is) — NUMERIC.md §5.2
 * ============================================================================ */

/* Object.is (SameValue): like === but NaN === NaN is true, and -0 !== +0.
 * These are the exact two cases where it differs from ===, and it differs in
 * opposite directions. Do not define this in terms of === with patches. */
bool jsrt_same_value(jsrt_value a, jsrt_value b) {
  /* Differs from === on exactly two inputs, in OPPOSITE directions: NaN matches itself here and
   * does not under ===, while -0 and +0 match under === and do not here. Written independently
   * rather than as "=== with two patches", so neither rule can drift into the other. */
  if (jsrt_is_number(a) && jsrt_is_number(b)) {
    double da = jsrt_number_value(a);
    double db = jsrt_number_value(b);
    if (isnan(da) || isnan(db)) {
      return isnan(da) && isnan(db);
    }
    if (da == 0.0 && db == 0.0) {
      return signbit(da) == signbit(db);
    }
    return da == db;
  }

  /* Everything else: bit equality */
  return a == b;
}

/* ------------------------------------------------------ bitwise operators */

/* uint32 -> int32 without relying on the implementation-defined out-of-range signed conversion.
 * The subtraction is done in uint32 (well-defined, modular), and only a value that already fits
 * int32 is ever cast. */
static int32_t u32_to_i32(uint32_t u) {
  if (u < UINT32_C(0x80000000)) {
    return (int32_t)u;
  }
  return (int32_t)(u - UINT32_C(0x80000000)) - INT32_MAX - 1;
}

/* ToUint32 of the right operand, masked to 5 bits: JavaScript shifts by count % 32, so
 * `1 << 32` is `1`, not 0 (docs/NUMERIC.md §4.3). The mask also makes the C shift legal, since
 * a shift count >= the operand width would be undefined behaviour. */
static uint32_t shift_count(jsrt_value b) {
  return jsrt_to_uint32(jsrt_to_number(b)) & 31u;
}

static uint32_t to_u32(jsrt_value v) { return jsrt_to_uint32(jsrt_to_number(v)); }

jsrt_value jsrt_op_bitand(jsrt_value a, jsrt_value b) {
  return jsrt_number((double)u32_to_i32(to_u32(a) & to_u32(b)));
}

jsrt_value jsrt_op_bitor(jsrt_value a, jsrt_value b) {
  return jsrt_number((double)u32_to_i32(to_u32(a) | to_u32(b)));
}

jsrt_value jsrt_op_bitxor(jsrt_value a, jsrt_value b) {
  return jsrt_number((double)u32_to_i32(to_u32(a) ^ to_u32(b)));
}

jsrt_value jsrt_op_bitnot(jsrt_value a) {
  return jsrt_number((double)u32_to_i32(~to_u32(a)));
}

/* Shifting is done on the UNSIGNED value even for `<<`, whose operand is conceptually signed:
 * `-1 << 1` is a left shift of a negative number, which is undefined behaviour in C but
 * perfectly defined in JavaScript as a bit operation. */
jsrt_value jsrt_op_shl(jsrt_value a, jsrt_value b) {
  return jsrt_number((double)u32_to_i32(to_u32(a) << shift_count(b)));
}

/* Arithmetic (sign-propagating) right shift, done by hand: C's `>>` on a negative signed value
 * is implementation-defined, so the sign bits are OR'd back in explicitly. At a shift of 0 the
 * mask is `~0xFFFFFFFF == 0`, which correctly leaves the value alone. */
jsrt_value jsrt_op_shr(jsrt_value a, jsrt_value b) {
  uint32_t bits = to_u32(a);
  uint32_t count = shift_count(b);
  uint32_t result = bits >> count;
  if ((bits & UINT32_C(0x80000000)) != 0) {
    result |= (uint32_t)~(UINT32_C(0xFFFFFFFF) >> count);
  }
  return jsrt_number((double)u32_to_i32(result));
}

/* The one bitwise operator whose result is NOT an int32: `-1 >>> 0` is 4294967295. */
jsrt_value jsrt_op_ushr(jsrt_value a, jsrt_value b) {
  return jsrt_number((double)(to_u32(a) >> shift_count(b)));
}

/* The global number functions -- parseInt, parseFloat, isNaN, isFinite (§19.2). */

/* ToString of the argument, its leading StrWhiteSpaceChar skipped. Both parsers start here, and
 * both read code units straight off the string: a non-ASCII unit after the trim ends the prefix,
 * which is the spec's answer too (no digit and no sign is outside ASCII). The string comes back
 * unrooted, so a caller does nothing that allocates on the GC heap while it holds it. */
static jsrt_value trimmed_start(jsrt_value v, uint32_t *pos) {
  jsrt_value s = jsrt_is(v, JSRT_TAG_STRING) ? v : jsrt_to_string(v);
  uint32_t len = jsrt_string_length(s);
  uint32_t i = 0;
  while (i < len && is_str_white_space(jsrt_string_char(s, i))) {
    i++;
  }
  *pos = i;
  return s;
}

/* The value of one code unit as a digit, or 36 for "not a digit in any radix". */
static unsigned digit_value(uint16_t ch) {
  if (ch >= '0' && ch <= '9') {
    return (unsigned)(ch - '0');
  }
  if (ch >= 'a' && ch <= 'z') {
    return (unsigned)(ch - 'a') + 10u;
  }
  if (ch >= 'A' && ch <= 'Z') {
    return (unsigned)(ch - 'A') + 10u;
  }
  return 36u;
}

/* Radix 2, 4, 8, 16 or 32: §19.2.5 step 11 makes the value exact, so it is rounded once, to
 * nearest-even, the way V8's InternalStringToIntDouble does: bits accumulate in a uint64 until
 * the value needs more than 53, the bits shifted out below the mantissa are kept for rounding,
 * and every later digit only raises the exponent (and clears `zero_tail` when nonzero). */
static double parse_power_of_two(jsrt_value s, uint32_t start, uint32_t end, unsigned radix) {
  unsigned bits = 0;
  while ((1u << bits) < radix) {
    bits++;
  }
  const uint64_t limit = (uint64_t)1 << 53;
  uint64_t number = 0;
  uint32_t i = start;
  for (; i < end; i++) {
    number = (number << bits) + digit_value(jsrt_string_char(s, i));
    if (number >= limit) {
      i++;
      break;
    }
  }
  if (number < limit) {
    return (double)number;
  }
  int exponent = 0;
  unsigned overflow_bits = 1;
  while ((number >> overflow_bits) >= limit) {
    overflow_bits++;
  }
  uint64_t dropped = number & (((uint64_t)1 << overflow_bits) - 1u);
  number >>= overflow_bits;
  exponent = (int)overflow_bits;
  bool zero_tail = true;
  for (; i < end; i++) {
    if (digit_value(jsrt_string_char(s, i)) != 0) {
      zero_tail = false;
    }
    exponent += (int)bits;
  }
  uint64_t middle = (uint64_t)1 << (overflow_bits - 1u);
  if (dropped > middle || (dropped == middle && ((number & 1u) != 0 || !zero_tail))) {
    number++;
    if (number == limit) {
      number >>= 1;
      exponent++;
    }
  }
  return ldexp((double)number, exponent);
}

/* Any other radix but 10: the spec allows an approximation past 20 significant digits, and Node's
 * is V8's -- multiply-add in 32-bit chunks, folded into a double one chunk at a time. Matching the
 * chunking is what keeps a large result byte-identical with Node rather than merely close. */
static double parse_generic_radix(jsrt_value s, uint32_t start, uint32_t end, unsigned radix) {
  const uint32_t max_multiplier = 0xFFFFFFFFu / 36u;
  double result = 0.0;
  uint32_t i = start;
  while (i < end) {
    uint32_t part = 0;
    uint32_t multiplier = 1;
    while (i < end) {
      uint32_t next = multiplier * radix;
      if (next > max_multiplier) {
        break;
      }
      part = part * radix + digit_value(jsrt_string_char(s, i));
      multiplier = next;
      i++;
    }
    result = result * (double)multiplier + (double)part;
  }
  return result;
}

/* The code units [start, end) as a NUL-terminated copy on the C heap, for a parser that wants
 * a C string. Every caller has already proved the span ASCII (a unit past 127 truncates), and a
 * NULL answer is OOM, which each one turns into NaN. */
static char *ascii_copy(jsrt_value s, uint32_t start, uint32_t end) {
  size_t n = (size_t)(end - start);
  char *buf = (char *)malloc(n + 1);
  if (buf == NULL) {
    return NULL;
  }
  for (size_t k = 0; k < n; k++) {
    buf[k] = (char)jsrt_string_char(s, start + (uint32_t)k);
  }
  buf[n] = '\0';
  return buf;
}

/* Decimal digits [start, end), leading zeros already skipped by the caller: strtod over a pure
 * digit run is correctly rounded and has no locale-dependent character to trip on. */
static double parse_decimal_digits(jsrt_value s, uint32_t start, uint32_t end) {
  if (start == end) {
    return 0.0;
  }
  char *buf = ascii_copy(s, start, end);
  if (buf == NULL) {
    return 0.0 / 0.0; /* NaN: the OOM answer, as in jsrt_string_to_number */
  }
  double value = strtod(buf, NULL);
  free(buf);
  return value;
}

static jsrt_value parse_int_text(jsrt_value string, jsrt_value radix);

/* `parseInt(string, radix)` (§19.2.5). ToString(string) runs before ToInt32(radix), and either
 * may call the program's own method, so the order is observable: the text is taken first and
 * kept rooted while the radix converts. */
jsrt_value jsrt_global_parse_int(jsrt_value string, jsrt_value radix) {
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_to_string(string);
  const jsrt_value out =
      jsrt_pending() ? jsrt_number(0.0 / 0.0) : parse_int_text(JSRT_LOCAL(0), radix);
  JSRT_FRAME_POP();
  return out;
}

/* `string` is already a string, rooted by the caller. */
static jsrt_value parse_int_text(jsrt_value string, jsrt_value radix) {
  int32_t r = jsrt_to_int32(jsrt_to_number(radix));
  if (jsrt_pending()) {
    return jsrt_number(0.0 / 0.0);
  }
  uint32_t pos = 0;
  jsrt_value s = trimmed_start(string, &pos);
  uint32_t len = jsrt_string_length(s);
  bool negative = false;
  if (pos < len && (jsrt_string_char(s, pos) == '-' || jsrt_string_char(s, pos) == '+')) {
    negative = jsrt_string_char(s, pos) == '-';
    pos++;
  }
  bool strip_prefix = true;
  if (r != 0) {
    if (r < 2 || r > 36) {
      return jsrt_number(0.0 / 0.0);
    }
    strip_prefix = r == 16;
  } else {
    r = 10;
  }
  if (strip_prefix && pos + 1 < len && jsrt_string_char(s, pos) == '0' &&
      (jsrt_string_char(s, pos + 1) == 'x' || jsrt_string_char(s, pos + 1) == 'X')) {
    pos += 2;
    r = 16;
  }
  unsigned base = (unsigned)r;
  uint32_t end = pos;
  while (end < len && digit_value(jsrt_string_char(s, end)) < base) {
    end++;
  }
  if (end == pos) {
    return jsrt_number(0.0 / 0.0);
  }
  /* Leading zeros add nothing in any radix, and skipping them keeps the power-of-two path's
   * 53-bit window on significant digits. */
  while (pos < end && jsrt_string_char(s, pos) == '0') {
    pos++;
  }
  double magnitude;
  if (base == 10) {
    magnitude = parse_decimal_digits(s, pos, end);
  } else if ((base & (base - 1u)) == 0) {
    magnitude = parse_power_of_two(s, pos, end, base);
  } else {
    magnitude = parse_generic_radix(s, pos, end, base);
  }
  /* Step 15: a zero result keeps the sign, so `parseInt("-0")` is -0. */
  return jsrt_number(negative ? -magnitude : magnitude);
}

/* `parseFloat(string)` (§19.2.4): the longest prefix that is a StrDecimalLiteral, converted by the
 * same literal parser `Number(s)` uses -- the prefix is validated here, so it accepts it whole. */
jsrt_value jsrt_global_parse_float(jsrt_value string) {
  uint32_t pos = 0;
  jsrt_value s = trimmed_start(string, &pos);
  uint32_t len = jsrt_string_length(s);
  uint32_t i = pos;
  if (i < len && (jsrt_string_char(s, i) == '+' || jsrt_string_char(s, i) == '-')) {
    i++;
  }
  static const char infinity[] = "Infinity";
  uint32_t k = 0;
  while (k < 8 && i + k < len && jsrt_string_char(s, i + k) == (uint16_t)infinity[k]) {
    k++;
  }
  if (k == 8) {
    return jsrt_number(jsrt_string_char(s, pos) == '-' ? -INFINITY : INFINITY);
  }
  uint32_t digits = 0;
  while (i < len && digit_value(jsrt_string_char(s, i)) < 10u) {
    i++;
    digits++;
  }
  if (i < len && jsrt_string_char(s, i) == '.') {
    uint32_t after = i + 1;
    uint32_t fraction = 0;
    while (after < len && digit_value(jsrt_string_char(s, after)) < 10u) {
      after++;
      fraction++;
    }
    /* "5." is a literal and "." is not: the point joins the prefix only beside a digit. */
    if (digits > 0 || fraction > 0) {
      i = after;
      digits += fraction;
    }
  }
  if (digits == 0) {
    return jsrt_number(0.0 / 0.0);
  }
  if (i < len && (jsrt_string_char(s, i) == 'e' || jsrt_string_char(s, i) == 'E')) {
    uint32_t e = i + 1;
    if (e < len && (jsrt_string_char(s, e) == '+' || jsrt_string_char(s, e) == '-')) {
      e++;
    }
    uint32_t exponent_start = e;
    while (e < len && digit_value(jsrt_string_char(s, e)) < 10u) {
      e++;
    }
    if (e > exponent_start) {
      i = e;
    }
  }
  char *buf = ascii_copy(s, pos, i);
  if (buf == NULL) {
    return jsrt_number(0.0 / 0.0);
  }
  double value = parse_numeric_literal(buf, (size_t)(i - pos));
  free(buf);
  return jsrt_number(value);
}

/* `isNaN(x)` and `isFinite(x)` (§19.2.2-3): ToNumber first, unlike their Number.* namesakes. */
jsrt_value jsrt_global_is_nan(jsrt_value v) { return jsrt_bool(isnan(jsrt_to_number(v))); }

jsrt_value jsrt_global_is_finite(jsrt_value v) { return jsrt_bool(isfinite(jsrt_to_number(v))); }

/* `Number.isFinite(x)` and `Number.isNaN(x)` (§21.1.2.2, §21.1.2.4): no ToNumber -- a non-Number
 * operand answers false. */
jsrt_value jsrt_number_is_finite(jsrt_value v) {
  return jsrt_bool(jsrt_is_number(v) && isfinite(jsrt_to_number(v)));
}

jsrt_value jsrt_number_is_nan(jsrt_value v) { return jsrt_bool(jsrt_is_number(v) && isnan(jsrt_to_number(v))); }
