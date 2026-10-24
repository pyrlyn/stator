/* Math builtins (plan.md §7 Task 4.2) — number -> number, ECMA-262 §21.3.2 exactly.
 *
 * Three groups live here, and which group a member is in decides where its answer comes from:
 *
 * 1. IEEE-defined (floor/ceil/trunc/abs/sqrt): the host libm is REQUIRED to be correct, so it is
 *    called directly. round, sign, min, max and pow's special cases are where ECMA and C89's libm
 *    disagree, and each wrapper below exists for a named disagreement.
 * 2. Approximated transcendentals (sin, log, exp, cbrt, …): the host libm is ALLOWED to differ in
 *    the last ulp, and measurably does — up to 41% of random inputs disagree with Node (plan-notes
 *    117). They go to the vendored fdlibm, which is the same code V8 runs, so agreement with Node
 *    is structural rather than lucky. This is what `vendor/fdlibm/` exists for.
 * 3. Not in fdlibm at all (hypot, random): V8 implements these itself, so we mirror V8's own
 *    algorithm — see each function's comment.
 *
 * Everything here takes and returns boxed values, canonicalized by jsrt_number like every other
 * producer — arguments are typed `number` by the frontend, and inside checked code annotations
 * are trusted fully (golden rule 4 is about boundaries, and there is none here). */

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "fdlibm.h"
#include "jsrt_value.h"

/* Math functions apply ECMAScript ToNumber to every argument before their numeric work. */
static double arg(jsrt_value v) { return jsrt_to_number(v); }

jsrt_value jsrt_math_abs(jsrt_value x) { return jsrt_number(fabs(arg(x))); }

jsrt_value jsrt_math_ceil(jsrt_value x) { return jsrt_number(ceil(arg(x))); }

jsrt_value jsrt_math_floor(jsrt_value x) { return jsrt_number(floor(arg(x))); }

jsrt_value jsrt_math_sqrt(jsrt_value x) { return jsrt_number(sqrt(arg(x))); }

jsrt_value jsrt_math_trunc(jsrt_value x) { return jsrt_number(trunc(arg(x))); }

/* NOT C round(), twice over: C rounds ties AWAY from zero (round(-2.5) is -3, ECMA says -2 — ties
 * go toward +∞), and the naive floor(x + 0.5) breaks at 0.49999999999999994, where the addition
 * itself rounds up to 1.0. Comparing x - floor(x) against 0.5 never adds, so it never rounds. */
jsrt_value jsrt_math_round(jsrt_value v) {
  double x = arg(v);
  if (!isfinite(x) || x == 0.0) {
    return jsrt_number(x); /* NaN, ±Infinity and ±0 pass through, sign included */
  }
  if (x > 0.0 && x < 0.5) {
    return jsrt_number(0.0);
  }
  if (x < 0.0 && x >= -0.5) {
    return jsrt_number(-0.0); /* §21.3.2.28 step 4: -0.5 ≤ x < 0 answers NEGATIVE zero */
  }
  double f = floor(x);
  return jsrt_number(x - f >= 0.5 ? f + 1.0 : f);
}

jsrt_value jsrt_math_sign(jsrt_value v) {
  double x = arg(v);
  if (isnan(x) || x == 0.0) {
    return jsrt_number(x); /* NaN and ±0 pass through — sign(-0) is -0, not -1 */
  }
  return jsrt_number(x < 0.0 ? -1.0 : 1.0);
}

/* Number::exponentiate, which is NOT C pow() on two points: pow(±1, ±Infinity) is 1 in C and NaN
 * in ECMA, and pow(1, NaN) is 1 in C and NaN in ECMA. Both stem from the same rule — an exponent
 * of NaN or an |base|==1 with infinite exponent has no principled answer, and ECMA says so while
 * C89 guesses. Every other case of C pow matches §6.1.6.1.3, including pow(anything, ±0) == 1. */
jsrt_value jsrt_math_pow(jsrt_value b, jsrt_value e) {
  double base = arg(b);
  double exp = arg(e);
  if (isnan(exp)) {
    return jsrt_number(NAN);
  }
  if ((base == 1.0 || base == -1.0) && isinf(exp)) {
    return jsrt_number(NAN);
  }
  return jsrt_number(pow(base, exp));
}

/* fmin/fmax are close but wrong on both counts that matter: they SKIP a NaN operand (ECMA
 * propagates it), and they answer either zero for min(+0, -0) (ECMA orders -0 below +0). */
static jsrt_value min_max(jsrt_value a, jsrt_value b, bool want_max) {
  double x = arg(a);
  double y = arg(b);
  if (isnan(x) || isnan(y)) {
    return jsrt_number(NAN);
  }
  if (x == 0.0 && y == 0.0) {
    /* min prefers the negative zero, max the positive one. */
    return jsrt_number((signbit(x) != want_max) ? x : y);
  }
  return jsrt_number((want_max ? x > y : x < y) ? x : y);
}

jsrt_value jsrt_math_min(jsrt_value a, jsrt_value b) { return min_max(a, b, false); }

jsrt_value jsrt_math_max(jsrt_value a, jsrt_value b) { return min_max(a, b, true); }

/* The three bit-EXACT members outside the plain-libm set: no approximation anywhere, so no
 * fdlibm question arises (§21.3.2.11, .17, .19). */

/* Count of leading zero bits of ToUint32; 32 for zero. */
jsrt_value jsrt_math_clz32(jsrt_value v) {
  const uint32_t x = jsrt_to_uint32(arg(v));
  if (x == 0) {
    return jsrt_number(32.0);
  }
  uint32_t n = 0;
  for (uint32_t probe = 0x80000000u; (x & probe) == 0; probe >>= 1) {
    n++;
  }
  return jsrt_number((double)n);
}

/* ToInt32 multiply with int32 wrap-around; unsigned arithmetic keeps the overflow defined. */
jsrt_value jsrt_math_imul(jsrt_value a, jsrt_value b) {
  const uint32_t prod = (uint32_t)jsrt_to_int32(arg(a)) * (uint32_t)jsrt_to_int32(arg(b));
  return jsrt_number((double)(int32_t)prod);
}

/* Round-trip through IEEE single precision -- the double nearest to the float nearest to x. */
jsrt_value jsrt_math_fround(jsrt_value v) { return jsrt_number((double)(float)arg(v)); }

/* ---- Group 2: the transcendentals, through the vendored fdlibm (plan-notes 117) ----
 *
 * Each is a one-line hand-off. The wrapper exists at all only so the boxing convention is the same
 * as every other member here; the arithmetic is entirely V8's. Do NOT "simplify" any of these to
 * the libm call of the same name -- that is precisely the bug the vendoring fixed, and it is
 * invisible until a golden test disagrees with Node in the seventeenth digit. */
#define JSRT_MATH_FDLIBM_1(name)                     \
  jsrt_value jsrt_math_##name(jsrt_value x) {        \
    return jsrt_number(fdlibm_##name(arg(x)));       \
  }
JSRT_MATH_FDLIBM_1(acos)
JSRT_MATH_FDLIBM_1(acosh)
JSRT_MATH_FDLIBM_1(asin)
JSRT_MATH_FDLIBM_1(asinh)
JSRT_MATH_FDLIBM_1(atan)
JSRT_MATH_FDLIBM_1(atanh)
JSRT_MATH_FDLIBM_1(cbrt)
JSRT_MATH_FDLIBM_1(cos)
JSRT_MATH_FDLIBM_1(cosh)
JSRT_MATH_FDLIBM_1(exp)
JSRT_MATH_FDLIBM_1(expm1)
JSRT_MATH_FDLIBM_1(log)
JSRT_MATH_FDLIBM_1(log10)
JSRT_MATH_FDLIBM_1(log1p)
JSRT_MATH_FDLIBM_1(log2)
JSRT_MATH_FDLIBM_1(sin)
JSRT_MATH_FDLIBM_1(sinh)
JSRT_MATH_FDLIBM_1(tan)
JSRT_MATH_FDLIBM_1(tanh)
#undef JSRT_MATH_FDLIBM_1

jsrt_value jsrt_math_atan2(jsrt_value y, jsrt_value x) {
  return jsrt_number(fdlibm_atan2(arg(y), arg(x)));
}

/* ---- Group 3: members V8 implements outside ieee754.cc ---- */

/* Math.hypot, BINARY form (§21.3.2.18). Mirrors V8's FastMathHypot two-argument path exactly
 * (src/builtins/math.tq): scale both operands by the larger before squaring, so a^2 + b^2 cannot
 * overflow when the true result is finite. The order of operations is load-bearing -- computing
 * sqrt(a*a + b*b) instead agrees with V8 on most inputs and disagrees on the interesting ones.
 *
 * BINARY only, like min/max: the frontend folds those variadic forms into nested binary calls, but
 * hypot is NOT associative, so hypot(a, b, c) is a separate computation V8 does with a Kahan
 * compensation term. That form is gated, not approximated. */
jsrt_value jsrt_math_hypot(jsrt_value va, jsrt_value vb) {
  const double a = fabs(arg(va));
  const double b = fabs(arg(vb));
  if (a == INFINITY || b == INFINITY) {
    return jsrt_number(INFINITY); /* before the NaN check: hypot(Inf, NaN) is Inf, not NaN */
  }
  const double max = a > b ? a : b;
  if (isnan(max)) {
    return jsrt_number((double)NAN);
  }
  if (max == 0.0) {
    return jsrt_number(0.0);
  }
  return jsrt_number(sqrt((a / max) * (a / max) + (b / max) * (b / max)) * max);
}

/* Math.random (§21.3.2.27) -- xorshift128+, the generator V8 uses.
 *
 * This is the one member that CANNOT be pinned to Node by a golden test, by construction: the spec
 * requires an implementation-chosen value, so "matches Node byte-for-byte" is not a property it can
 * have. It lands under plan.md's determinism carve-out instead, proved by the range and
 * distribution assertions in tests/unit/ rather than by the golden suite.
 *
 * The seed is fixed rather than drawn from the OS. That is a deliberate v0 choice, not an
 * oversight: a reproducible program is worth more than an unpredictable one while the compiler is
 * being differentially tested, and nothing here is security-bearing. It must NOT be used for
 * anything that needs unpredictability. */
static _Thread_local uint64_t rng_state0 = 0x853c49e6748fea9bULL;
static _Thread_local uint64_t rng_state1 = 0xda3e39cb94b95bdbULL;

jsrt_value jsrt_math_random(void) {
  uint64_t s1 = rng_state0;
  const uint64_t s0 = rng_state1;
  rng_state0 = s0;
  s1 ^= s1 << 23;
  s1 ^= s1 >> 17;
  s1 ^= s0;
  s1 ^= s0 >> 26;
  rng_state1 = s1;
  /* Top 52 bits into the mantissa of 1.0, then subtract 1 -- the standard construction for a
   * uniform double in [0, 1) that never rounds up to 1.0. */
  const uint64_t bits = ((rng_state0 + rng_state1) >> 12) | 0x3FF0000000000000ULL;
  double d;
  memcpy(&d, &bits, sizeof d);
  return jsrt_number(d - 1.0);
}
