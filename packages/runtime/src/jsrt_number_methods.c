/* jsrt_number_methods.c — Number.prototype.toString(radix) and toFixed(digits) (§21.1.3.3,
 * §21.1.3.6; plan.md §11c T11.4, plan-notes 310).
 *
 * The receiver is a number the generated code passes as a value; each argument is any value,
 * JSRT_UNDEFINED when omitted. Pure computation over a stack buffer: no heap value is held
 * across the one allocation each entry point makes, the result string.
 */

#include "jsrt_value.h"

#include "jsrt.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static double integer_or_infinity(jsrt_value v) {
  double d = jsrt_to_number(v);
  return isnan(d) ? 0.0 : trunc(d);
}

/* V8's DoubleToRadixCString, so non-decimal digits print as Node prints them: fraction digits
 * stop once they fall below half an ulp of the input (round-half-even on the last one, with
 * carry), and integer digits past 2^53 print as zeros. `value` is finite and nonzero. */
static size_t double_to_radix(double value, int radix, char *out) {
  static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  enum { size = 2200, mid = size / 2 };
  char buffer[size];
  int integer_cursor = mid;
  int fraction_cursor = mid;
  bool negative = value < 0;
  if (negative) {
    value = -value;
  }
  double integer = floor(value);
  double fraction = value - integer;
  double delta = 0.5 * (nextafter(value, INFINITY) - value);
  delta = fmax(nextafter(0.0, 1.0), delta);
  if (fraction >= delta) {
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = chars[digit];
      fraction -= digit;
      if ((fraction > 0.5 || (fraction == 0.5 && (digit & 1))) && fraction + delta > 1) {
        /* Carry back through the digits already written; past the point it lands in the
         * integer part and the point itself is dropped. */
        for (;;) {
          fraction_cursor--;
          if (fraction_cursor == mid) {
            integer += 1;
            break;
          }
          char c = buffer[fraction_cursor];
          int prior = c > '9' ? c - 'a' + 10 : c - '0';
          if (prior + 1 < radix) {
            buffer[fraction_cursor++] = chars[prior + 1];
            break;
          }
        }
        break;
      }
    } while (fraction >= delta);
  }
  while (integer / radix >= 9007199254740992.0) { /* Double::Exponent() > 0 */
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = chars[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) {
    buffer[--integer_cursor] = '-';
  }
  size_t len = (size_t)(fraction_cursor - integer_cursor);
  memcpy(out, buffer + integer_cursor, len);
  return len;
}

jsrt_value jsrt_number_to_string_radix(jsrt_value number, jsrt_value radix) {
  double r = jsrt_is(radix, JSRT_TAG_UNDEFINED) ? 10.0 : integer_or_infinity(radix);
  if (r < 2.0 || r > 36.0) {
    jsrt_throw_error(&jsrt_class_range_error, "toString() radix argument must be between 2 and 36");
    return JSRT_UNDEFINED;
  }
  double x = jsrt_number_value(number);
  if (r == 10.0 || !isfinite(x) || x == 0.0) {
    return jsrt_to_string(jsrt_number(x));
  }
  char out[2200];
  return jsrt_string_from_utf8(out, double_to_radix(x, (int)r, out));
}

/* toFixed rounds the EXACT value half-up (§21.1.3.3 step 10 picks the larger n on a tie), so
 * the digits come from the exact decimal expansion, which "%.1100f" prints in full: a double
 * below 1e21 has at most 1074 fraction digits. printf's own rounding is half-even. */
jsrt_value jsrt_number_to_fixed(jsrt_value number, jsrt_value digits) {
  double f = integer_or_infinity(digits);
  if (f < 0.0 || f > 100.0) {
    jsrt_throw_error(&jsrt_class_range_error, "toFixed() digits argument must be between 0 and 100");
    return JSRT_UNDEFINED;
  }
  double x = jsrt_number_value(number);
  if (!isfinite(x) || fabs(x) >= 1e21) {
    return jsrt_to_string(jsrt_number(x));
  }
  static char exact[1200];
  char out[136];
  size_t n = 0;
  if (x < 0) {
    out[n++] = '-';
    x = -x;
  }
  x = x + 0.0; /* -0 prints as "0": step 8 tests x < 0, which -0 is not */
  int written = snprintf(exact, sizeof exact, "%.1100f", x);
  if (written < 0 || (size_t)written >= sizeof exact) {
    jsrt_panic("toFixed: exact expansion overflowed its buffer");
  }
  size_t point = strcspn(exact, ".");
  size_t keep = point + 1 + (size_t)f; /* through the last kept fraction digit */
  bool up = exact[keep] >= '5';
  size_t start = n;
  memcpy(out + n, exact, keep);
  n += keep;
  if (f == 0.0) {
    n--; /* no fraction digits: drop the point */
  }
  for (size_t i = n; up && i > start; i--) {
    char *c = &out[i - 1];
    if (*c == '.') {
      continue;
    }
    if (*c == '9') {
      *c = '0';
    } else {
      (*c)++;
      up = false;
    }
  }
  if (up) {
    memmove(out + start + 1, out + start, n - start);
    out[start] = '1';
    n++;
  }
  return jsrt_string_from_utf8(out, n);
}

/* Number.prototype read as a value from a number the compiler only knows as Unknown: the
 * `jsrt_string_method` contract (jsrt_string_methods.c). Slot 1 of the environment says which
 * of the three landed methods the closure is. `valueOf` answers the primitive itself (§21.1.3.7)
 * and takes no argument. */
static jsrt_value number_method_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const jsrt_value argument = jsrt_arg(argc, argv, 0);
  const double row = jsrt_to_number(env->slots[1]);
  if (row == 2.0) {
    return env->slots[0];
  }
  return row == 0.0 ? jsrt_number_to_string_radix(env->slots[0], argument)
                     : jsrt_number_to_fixed(env->slots[0], argument);
}

bool jsrt_number_method(jsrt_value number, const char *key, jsrt_value *out) {
  if (!jsrt_is_number(number)) {
    return false;
  }
  uint32_t row = 0;
  uint32_t length = 1;
  const char *name = NULL;
  if (strcmp(key, "toString") == 0) {
    row = 0;
    name = "toString";
  } else if (strcmp(key, "toFixed") == 0) {
    row = 1;
    name = "toFixed";
  } else if (strcmp(key, "valueOf") == 0) {
    row = 2;
    length = 0;
    name = "valueOf";
  } else {
    return false;
  }
  *out = jsrt_bound_method(number, row, number_method_call, length, name);
  return true;
}
