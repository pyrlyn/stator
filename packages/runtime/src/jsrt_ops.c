/* jsrt_ops.c — arithmetic and relational operators.
 *
 * Implements the `+` operator and relational comparisons (<, >, <=, >=)
 * according to ECMA-262.
 *
 * Key insight for `+`: if EITHER operand is a string, ToString both and
 * concatenate; otherwise ToNumber both and add. This is NOT symmetric with
 * other operators.
 *
 * Relational comparisons are symmetric: both strings -> lexicographic;
 * at least one non-string -> numeric.
 */

#include "jsrt_value.h"

#include <math.h>
#include <stdbool.h>

/* --- ToPrimitive — ECMA-262 §7.1.1, docs/NUMERIC.md §7 --- */

/* Every operator below is defined on primitives; an object reaches one only through here.
 *
 * §7.1.1.1 OrdinaryToPrimitive, rung by rung (ECMA-262 2025, plan-notes 345). Each rung asks for
 * the method the program wrote (jsrt_user_get); a miss is the builtin prototype's method, modelled
 * here: every builtin `toString` answers a string (jsrt_builtin_to_string), and every builtin
 * `valueOf` answers the object itself -- not a primitive, so the next rung runs -- except
 * Date.prototype.valueOf, the time value. */
jsrt_value jsrt_to_primitive(jsrt_value v, jsrt_hint hint) {
  if (!jsrt_is_object(v)) {
    return v;
  }
  /* A runtime function that converts several values in a row (Math.max, String.fromCharCode, a
   * sort's keys) stops at the first throw in JavaScript; here it reaches the next conversion with
   * the exception still pending, and no further user method may run. Its caller checks. */
  if (jsrt_pending()) {
    return JSRT_UNDEFINED;
  }
  /* §21.4.4.45 Date.prototype[@@toPrimitive]: `default` means `string`. */
  const bool string_first =
      hint == JSRT_HINT_STRING || (hint == JSRT_HINT_DEFAULT && jsrt_is_date(v));
  const char *const order[2] = {string_first ? "toString" : "valueOf",
                                string_first ? "valueOf" : "toString"};
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = v;
  for (int rung = 0; rung < 2; rung++) {
    const bool to_string = order[rung][0] == 't';
    jsrt_value method = JSRT_UNDEFINED;
    if (!jsrt_user_get(JSRT_LOCAL(0), order[rung], &method, NULL, NULL)) {
      const jsrt_value builtin = to_string                  ? jsrt_builtin_to_string(JSRT_LOCAL(0))
                                 : jsrt_is_date(JSRT_LOCAL(0)) ? jsrt_number(jsrt_date_value(JSRT_LOCAL(0)))
                                                               : JSRT_LOCAL(0);
      if (jsrt_pending() || !jsrt_is_object(builtin)) {
        JSRT_FRAME_POP();
        return jsrt_pending() ? JSRT_UNDEFINED : builtin;
      }
      continue;
    }
    if (jsrt_pending()) { /* a getter on the name threw */
      JSRT_FRAME_POP();
      return JSRT_UNDEFINED;
    }
    /* IsCallable: anything else is skipped, not called (step 2.b). */
    if (!jsrt_is(method, JSRT_TAG_CLOSURE)) {
      continue;
    }
    JSRT_LOCAL(1) = method;
    const jsrt_value result = jsrt_call_with_this(JSRT_LOCAL(1), JSRT_LOCAL(0), 0, NULL);
    if (jsrt_pending() || !jsrt_is_object(result)) {
      JSRT_FRAME_POP();
      return jsrt_pending() ? JSRT_UNDEFINED : result;
    }
  }
  JSRT_FRAME_POP();
  /* Step 3: neither method answered a primitive. Node's message, word for word. */
  jsrt_throw_error(&jsrt_class_type_error, "Cannot convert object to primitive value");
  return JSRT_UNDEFINED; /* never read: the exception is pending */
}

/* --- Addition operator (+) — ECMA-262 §12.8.3 --- */

jsrt_value jsrt_op_add(jsrt_value a, jsrt_value b) {
  /* ToPrimitive BOTH, THEN ask about strings. The order is the whole operator: `[1] + [2]` is
   * "12" because the arrays become strings before the test, not after -- test first and both
   * become NaN instead. NUMERIC.md §7 names this as the easy thing to get backwards.
   *
   * Every ToPrimitive here can ALLOCATE (an object's ToString builds a string), and a NaN-boxed
   * local is invisible to the collector, so each primitive that has to survive another call sits
   * in a rooted slot. Without this, `(v + [])` inside a loop lost whole iterations: the string
   * `pa` was collected while `pb` was being built and jsrt_string_concat read a reclaimed block
   * (measured: 999685 of 1000000). `a` and `b` are parameters and already roots. */
  JSRT_FRAME(4);
  /* Each ToPrimitive may run the program's `valueOf` and throw; the right operand's must not
   * run after the left one's threw (§13.15.3 ApplyStringOrNumericBinaryOperator steps 1.a-b). */
  JSRT_LOCAL(0) = jsrt_to_primitive(a, JSRT_HINT_DEFAULT);
  if (jsrt_pending()) {
    JSRT_FRAME_POP();
    return JSRT_UNDEFINED;
  }
  JSRT_LOCAL(1) = jsrt_to_primitive(b, JSRT_HINT_DEFAULT);
  if (jsrt_pending()) {
    JSRT_FRAME_POP();
    return JSRT_UNDEFINED;
  }

  /* If EITHER operand is a string, ToString both and concatenate. */
  if (jsrt_is(JSRT_LOCAL(0), JSRT_TAG_STRING) || jsrt_is(JSRT_LOCAL(1), JSRT_TAG_STRING)) {
    JSRT_LOCAL(2) = jsrt_to_string(JSRT_LOCAL(0));
    JSRT_LOCAL(3) = jsrt_to_string(JSRT_LOCAL(1));
    const jsrt_value out = jsrt_string_concat(JSRT_LOCAL(2), JSRT_LOCAL(3));
    JSRT_FRAME_POP();
    return out;
  }

  /* Otherwise, ToNumber both and add. */
  const double da = jsrt_to_number(JSRT_LOCAL(0));
  const double db = jsrt_to_number(JSRT_LOCAL(1));
  JSRT_FRAME_POP();
  return jsrt_number(da + db);
}

/* --- Relational comparison operators — ECMA-262 §12.10 --- */

/* Abstract Relational Comparison answers less-than, greater-than, equal, or UNDEFINED, and each
 * of the four operators maps undefined to false. Modelling that fourth outcome explicitly is what
 * keeps the NaN rule honest: `a <= b` is NOT `!(a > b)`, because NaN makes both false at once.
 * Written once here so the four operators cannot drift apart. */
typedef enum {
  JSRT_ORDER_LT,
  JSRT_ORDER_EQ,
  JSRT_ORDER_GT,
  JSRT_ORDER_UNORDERED /* at least one operand is NaN */
} jsrt_order;

static jsrt_order jsrt_compare(jsrt_value a, jsrt_value b) {
  /* ToPrimitive first, for the same reason as `+`: the both-strings test has to see what the
   * operands BECOME, so `["10"] < ["9"]` compares text and answers true.
   * Hint `number` (§7.2.13 IsLessThan steps 1-2). Each primitive stays in a slot until the
   * comparison has read it: the right operand's `valueOf` allocates, and ToNumber of a string
   * allocates too, and a NaN-boxed local is not a root. A throw stops the comparison. */
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_to_primitive(a, JSRT_HINT_NUMBER);
  if (!jsrt_pending()) {
    JSRT_LOCAL(1) = jsrt_to_primitive(b, JSRT_HINT_NUMBER);
  }
  if (jsrt_pending()) {
    JSRT_FRAME_POP();
    return JSRT_ORDER_UNORDERED;
  }

  /* Text order applies only when BOTH operands are strings. One non-string operand sends both
   * through ToNumber -- which is why `"10" < "9"` is true but `"10" < 9` is false. */
  jsrt_order order;
  if (jsrt_is(JSRT_LOCAL(0), JSRT_TAG_STRING) && jsrt_is(JSRT_LOCAL(1), JSRT_TAG_STRING)) {
    int c = jsrt_string_compare(JSRT_LOCAL(0), JSRT_LOCAL(1));
    if (c < 0) {
      order = JSRT_ORDER_LT;
    } else {
      order = c > 0 ? JSRT_ORDER_GT : JSRT_ORDER_EQ;
    }
  } else {
    double da = jsrt_to_number(JSRT_LOCAL(0));
    double db = jsrt_to_number(JSRT_LOCAL(1));
    if (isnan(da) || isnan(db)) {
      order = JSRT_ORDER_UNORDERED;
    } else if (da < db) {
      order = JSRT_ORDER_LT;
    } else {
      order = da > db ? JSRT_ORDER_GT : JSRT_ORDER_EQ;
    }
  }
  JSRT_FRAME_POP();
  return order;
}

bool jsrt_op_lt(jsrt_value a, jsrt_value b) { return jsrt_compare(a, b) == JSRT_ORDER_LT; }

bool jsrt_op_gt(jsrt_value a, jsrt_value b) { return jsrt_compare(a, b) == JSRT_ORDER_GT; }

/* <= and >= answer `strict` or equal -- never "not the other way", which an unordered (NaN)
 * comparison would satisfy. */
static bool ordered_or_equal(jsrt_value a, jsrt_value b, jsrt_order strict) {
  const jsrt_order o = jsrt_compare(a, b);
  return o == strict || o == JSRT_ORDER_EQ;
}

bool jsrt_op_le(jsrt_value a, jsrt_value b) { return ordered_or_equal(a, b, JSRT_ORDER_LT); }

bool jsrt_op_ge(jsrt_value a, jsrt_value b) { return ordered_or_equal(a, b, JSRT_ORDER_GT); }
