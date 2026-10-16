/* print_accessors.c — accessor properties on dynamic objects (docs/VALUE.md §4.15).
 *
 * Ground truth is Node: print_accessors.mjs builds the SAME objects with object-literal get/set
 * members and the same reads and writes, in the same order; `just runtime-test` diffs the two
 * byte-for-byte.
 *
 * What this pins, beyond "a getter runs on read": util.inspect does NOT call the getter, it prints
 * the descriptor (`[Getter]`, `[Setter]`, `[Getter/Setter]`); Object.keys does not call it either,
 * while Object.values and Object.entries do; a write goes to the setter instead of the slot, so a
 * later read still runs the getter; and the whole pair rides in the object's SLOT, so two objects
 * built from one literal with DIFFERENT captured values share a shape and keep separate getters --
 * the defect that put the pair here instead of on the shape.
 */

#include "corpus.h"

#include <assert.h>
#include <stdio.h>

/* An accessor body is an ordinary function unit with the receiver as parameter zero (docs/VALUE.md
 * §4.5), so its closure declares one (`has_receiver`, arity without it): the runtime calls it
 * through jsrt_call_method_at, which passes the receiver only to a closure that declares it
 * (plan-notes 319). */
static jsrt_value get_double(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)env;
  const jsrt_value self = jsrt_arg(argc, argv, 0);
  return num(jsrt_number_value(jsrt_get_prop(self, "val", NULL)) * 2);
}

static jsrt_value set_double(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)env;
  const jsrt_value self = jsrt_arg(argc, argv, 0);
  const jsrt_value v = jsrt_arg(argc, argv, 1);
  jsrt_set_prop(self, "val", num(jsrt_number_value(v) / 2), NULL);
  return JSRT_UNDEFINED;
}

/* A getter that CAPTURES: the one case a shape-borne pair could not represent. */
static jsrt_value get_captured(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  return env->slots[0];
}

static jsrt_value fail_access(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  (void)env;
  jsrt_throw_error(&jsrt_class_type_error, "access failed");
  return JSRT_UNDEFINED;
}

static void check_access_error(void) {
  assert(jsrt_pending());
  const jsrt_value error = jsrt_take_exception();
  assert(jsrt_instanceof(error, &jsrt_class_type_error));
  jsrt_print(jsrt_get_prop(error, "message", NULL));
}

int main(void) {
  jsrt_init();
  JSRT_FRAME(4);

  /* A get/set pair beside an ordinary data property. */
  jsrt_value obj = jsrt_dynobj_new();
  JSRT_LOCAL(0) = obj;
  jsrt_set_prop(obj, "val", num(21), NULL);
  jsrt_define_accessor(obj, "double", jsrt_closure_new(get_double, 0, "double", NULL, true),
                       jsrt_closure_new(set_double, 1, "double", NULL, true));
  jsrt_print(jsrt_get_prop(obj, "double", NULL)); /* 42 — the getter ran */
  jsrt_print(obj);                                /* [Getter/Setter] — it did NOT */
  jsrt_set_prop(obj, "double", num(100), NULL);   /* the setter ran, not a slot store */
  jsrt_print(jsrt_get_prop(obj, "val", NULL));    /* 50 */
  jsrt_print(jsrt_get_prop(obj, "double", NULL)); /* 100 — still an accessor */
  jsrt_print(jsrt_object_keys(obj));
  jsrt_print(jsrt_object_values(obj));
  jsrt_print(jsrt_object_entries(obj));

  /* Get-only and set-only halves print as Node's two other markers. */
  jsrt_value halves = jsrt_dynobj_new();
  JSRT_LOCAL(1) = halves;
  jsrt_define_accessor(halves, "g", jsrt_closure_new(get_double, 0, "g", NULL, true), JSRT_UNDEFINED);
  jsrt_define_accessor(halves, "s", JSRT_UNDEFINED, jsrt_closure_new(set_double, 1, "s", NULL, true));
  jsrt_set_prop(halves, "val", num(3), NULL);
  jsrt_print(halves);
  jsrt_print(jsrt_get_prop(halves, "s", NULL)); /* undefined: no getter */

  /* Two objects, one shape, two captured getters. */
  jsrt_value pair[2];
  for (int i = 0; i < 2; i++) {
    JSRTEnv *env = jsrt_env_new(NULL, 1);
    env->slots[0] = num(i + 7);
    pair[i] = jsrt_dynobj_new();
    JSRT_LOCAL(2 + (uint32_t)i) = pair[i];
    jsrt_define_accessor(pair[i], "x", jsrt_closure_new(get_captured, 1, "x", env, false),
                         JSRT_UNDEFINED);
  }
  jsrt_print(jsrt_get_prop(pair[0], "x", NULL));
  jsrt_print(jsrt_get_prop(pair[1], "x", NULL));

  jsrt_define_accessor(obj, "bad", jsrt_closure_new(fail_access, 1, "bad", NULL, false),
                       JSRT_UNDEFINED);
  assert(jsrt_object_values(obj) == JSRT_UNDEFINED);
  check_access_error();
  assert(jsrt_object_entries(obj) == JSRT_UNDEFINED);
  check_access_error();
  assert(jsrt_object_assign(halves, obj) == JSRT_UNDEFINED);
  check_access_error();
  jsrt_print(jsrt_get_prop(halves, "val", NULL)); /* Earlier properties were already copied. */
  assert(jsrt_json_stringify(obj) == JSRT_UNDEFINED);
  check_access_error();
  jsrt_console_table(obj);
  check_access_error();
  JSRT_LOCAL(2) = jsrt_array_new(1, &obj);
  jsrt_console_table(JSRT_LOCAL(2));
  check_access_error();

  JSRT_FRAME_POP();
  return 0;
}
