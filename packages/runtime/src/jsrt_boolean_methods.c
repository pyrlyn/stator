/* jsrt_boolean_methods.c — Boolean.prototype read as a value from a boolean the compiler only
 * knows as Unknown (plan.md §8 step 20, plan-notes 372).
 *
 * A typed receiver never comes here: the lowering gives `b.toString()` a direct call. An Unknown
 * receiver goes through `jsrt_get_prop` and then the call protocol, and a boolean has no shape
 * table, so the read fell through to `undefined` and the call aborted STA2006 where Node runs.
 * `jsrt_boolean_method` answers a closure bound to the receiver through `jsrt_bound_method`, the
 * contract `jsrt_string_method` and `jsrt_number_method` share (plan-notes 310).
 */

#include "jsrt_value.h"

#include <string.h>

/* Boolean.prototype has three own methods (§20.3.3): `toString` and `toLocaleString` answer
 * "true"/"false", `valueOf` answers the primitive. `toLocaleString` is specified as the same
 * value as `toString`, so one row covers both. */
enum { BOOLEAN_TO_STRING = 0, BOOLEAN_VALUE_OF = 1 };

static jsrt_value boolean_method_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  const jsrt_value receiver = env->slots[0];
  return jsrt_to_number(env->slots[1]) == 0.0 ? jsrt_builtin_to_string(receiver) : receiver;
}

bool jsrt_boolean_method(jsrt_value boolean, const char *key, jsrt_value *out) {
  if (!jsrt_is(boolean, JSRT_TAG_BOOL)) {
    return false;
  }
  uint32_t row = 0;
  const char *name = NULL;
  if (strcmp(key, "toString") == 0 || strcmp(key, "toLocaleString") == 0) {
    row = BOOLEAN_TO_STRING;
    name = strcmp(key, "toString") == 0 ? "toString" : "toLocaleString";
  } else if (strcmp(key, "valueOf") == 0) {
    row = BOOLEAN_VALUE_OF;
    name = "valueOf";
  } else {
    return false;
  }
  /* ECMA-262 §20.3.3: every Boolean.prototype method takes zero parameters. */
  *out = jsrt_bound_method(boolean, row, boolean_method_call, 0, name);
  return true;
}
