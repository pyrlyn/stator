/* roots.c — T18. A NaN-boxed jsrt_value is not a root. These calls allocate while holding one,
 * with a collection forced on every allocation (`jsrt_gc_stress`). The answers are the spec's;
 * before the slots, the held value was collected and the result was wrong or a crash.
 *
 * Not a Node corpus: Node has no stress switch, and the check is the exit status.
 */

#include "jsrt.h"
#include "jsrt_value.h"
#include "../src/jsrt_mem.h"

#include <stdio.h>
#include <string.h>

enum { N = 8 };
enum { USER_N = 16 };

static int fail(const char *msg) {
  fprintf(stderr, "roots: %s\n", msg);
  return 1;
}

static jsrt_value prim_left(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  (void)env;
  (void)jsrt_string_from_utf8("pad-left-pad-left", 18);
  return jsrt_string_from_utf8("10", 2);
}

static jsrt_value prim_right(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  (void)env;
  (void)jsrt_string_from_utf8("pad-right-pad-right", 20);
  return jsrt_string_from_utf8("9", 1);
}

static jsrt_value loose_value_of(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)argc;
  (void)argv;
  (void)env;
  (void)jsrt_string_from_utf8("pad-loose-pad-loose", 20);
  return jsrt_string_from_utf8("zz", 2);
}

/* Allocating here is the window `sort_compare` has to survive: both operands and the
 * comparator are NaN-boxed arguments. */
static jsrt_value num_cmp(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)env;
  (void)jsrt_string_from_utf8("cmp-pad-cmp-pad", 15);
  const double x = jsrt_number_value(argc > 0 ? argv[0] : JSRT_UNDEFINED);
  const double y = jsrt_number_value(argc > 1 ? argv[1] : JSRT_UNDEFINED);
  if (x < y) {
    return jsrt_number(-1.0);
  }
  if (x > y) {
    return jsrt_number(1.0);
  }
  return jsrt_number(0.0);
}

static int check_ascending(jsrt_value array, uint32_t n, const char *what) {
  JSRTArray *a = jsrt_as_array(array);
  if (a->length != n) {
    return fail(what);
  }
  for (uint32_t i = 0; i < n; i++) {
    if (jsrt_number_value(a->elements[i]) != (double)i) {
      fprintf(stderr, "roots: %s at %u got %g\n", what, i, jsrt_number_value(a->elements[i]));
      return 1;
    }
  }
  return 0;
}

static int test_compare(void) {
  JSRT_FRAME(4);
  JSRT_LOCAL(0) = jsrt_dynobj_new();
  JSRT_LOCAL(1) = jsrt_dynobj_new();
  JSRT_LOCAL(2) = jsrt_closure_new(prim_left, 0, "valueOf", NULL, false);
  JSRT_LOCAL(3) = jsrt_closure_new(prim_right, 0, "valueOf", NULL, false);
  jsrt_set_prop(JSRT_LOCAL(0), "valueOf", JSRT_LOCAL(2), NULL);
  jsrt_set_prop(JSRT_LOCAL(1), "valueOf", JSRT_LOCAL(3), NULL);
  jsrt_gc_stress(1);
  const bool less = jsrt_op_lt(JSRT_LOCAL(0), JSRT_LOCAL(1));
  const bool pending = jsrt_pending();
  jsrt_gc_stress(0);
  JSRT_FRAME_POP();
  if (pending) {
    return fail("compare pending");
  }
  /* "10" < "9" is text order. */
  if (!less) {
    return fail("compare");
  }
  return 0;
}

static int test_loose(void) {
  JSRT_FRAME(3);
  JSRT_LOCAL(0) = jsrt_dynobj_new();
  JSRT_LOCAL(1) = jsrt_closure_new(loose_value_of, 0, "valueOf", NULL, false);
  jsrt_set_prop(JSRT_LOCAL(0), "valueOf", JSRT_LOCAL(1), NULL);
  JSRT_LOCAL(2) = jsrt_string_from_utf8("zz", 2);
  jsrt_gc_stress(1);
  const bool eq = jsrt_loose_equals(JSRT_LOCAL(0), JSRT_LOCAL(2));
  const bool pending = jsrt_pending();
  jsrt_gc_stress(0);
  JSRT_FRAME_POP();
  if (pending) {
    return fail("loose pending");
  }
  if (!eq) {
    return fail("loose");
  }
  return 0;
}

static jsrt_value descending(uint32_t n) {
  jsrt_value items[USER_N];
  for (uint32_t i = 0; i < n; i++) {
    items[i] = jsrt_number((double)(n - 1U - i));
  }
  return jsrt_array_new(n, items);
}

static int test_sort_default(void) {
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = descending((uint32_t)N);
  jsrt_gc_stress(1);
  const jsrt_value sorted = jsrt_array_sort(JSRT_LOCAL(0), JSRT_UNDEFINED);
  jsrt_gc_stress(0);
  const int bad = check_ascending(sorted, (uint32_t)N, "default sort");
  JSRT_FRAME_POP();
  return bad;
}

static int test_sort_user(void) {
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = descending((uint32_t)USER_N);
  JSRT_LOCAL(1) = jsrt_closure_new(num_cmp, 2, "cmp", NULL, false);
  jsrt_gc_stress(1);
  const jsrt_value sorted = jsrt_array_sort(JSRT_LOCAL(0), JSRT_LOCAL(1));
  jsrt_gc_stress(0);
  const int bad = check_ascending(sorted, (uint32_t)USER_N, "user sort");
  JSRT_FRAME_POP();
  return bad;
}

static int test_adopt(void) {
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_promise_resolve(jsrt_number(42.0));
  JSRT_LOCAL(1) = jsrt_promise_new();
  jsrt_gc_watched_reset();
  jsrt_gc_watch(jsrt_ptr(JSRT_LOCAL(0)));
  const jsrt_value inner = JSRT_LOCAL(0);
  const jsrt_value outer = JSRT_LOCAL(1);
  JSRT_FRAME_POP();
  /* The only references are these parameters. settle has to park them across enqueue.
   * The finalizer fires inside that collection when the inner promise is not a root;
   * reading the freed object afterwards still sees the old bytes. */
  jsrt_gc_stress(1);
  jsrt_promise_settle(outer, inner, false);
  const int died = jsrt_gc_watched();
  jsrt_gc_stress(0);
  if (died != 0) {
    return fail("inner promise collected");
  }
  jsrt_run_microtasks();
  const JSRTPromise *p = jsrt_as_promise(outer);
  if (p->state != JSRT_PROMISE_FULFILLED || jsrt_number_value(p->value) != 42.0) {
    return fail("adopt");
  }
  return 0;
}

/* Growth must preserve children across collection and keep static slot tables rooted
 * even though their owning field is outside the collected heap. */
static int test_shape_growth(void) {
  static jsrt_value *static_slots;
  static uint32_t static_capacity;
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_dynobj_new();
  jsrt_gc_stress(1);
  for (uint32_t i = 0; i < 40; i++) {
    char key[24];
    snprintf(key, sizeof key, "field%u", i);
    const char *interned = jsrt_shape_key(jsrt_string_from_utf8(key, (uint32_t)strlen(key)));
    JSRT_LOCAL(1) = jsrt_dynobj_new();
    jsrt_set_prop(JSRT_LOCAL(1), "value", jsrt_number((double)i), NULL);
    jsrt_set_prop(JSRT_LOCAL(0), interned, JSRT_LOCAL(1), NULL);
    JSRT_LOCAL(1) = JSRT_UNDEFINED;
    /* Every capacity boundary is reached with a previously collected owner. */
    jsrt_gc_collect();
  }
  for (uint32_t i = 0; i < 40; i++) {
    char key[24];
    snprintf(key, sizeof key, "field%u", i);
    const jsrt_value child = jsrt_get_prop(JSRT_LOCAL(0), key, NULL);
    if (jsrt_get_prop(child, "value", NULL) != jsrt_number((double)i)) {
      return fail("grown object lost a child");
    }
  }
  jsrt_shape_reserve(&static_slots, &static_capacity, 0);
  static_slots[0] = jsrt_string_from_utf8("static slots", 12);
  jsrt_shape_reserve(&static_slots, &static_capacity, 32);
  jsrt_gc_collect();
  const bool retained = jsrt_strict_equals(static_slots[0], jsrt_string_from_utf8("static slots", 12));
  jsrt_gc_buffer_free(static_slots);
  static_slots = NULL;
  static_capacity = 0;
  jsrt_gc_stress(0);
  JSRT_FRAME_POP();
  return retained ? 0 : fail("grown static slots lost a child");
}

int main(void) {
  jsrt_init();
  if (test_compare() != 0 || test_loose() != 0 || test_sort_default() != 0 || test_sort_user() != 0 ||
      test_adopt() != 0 || test_shape_growth() != 0) {
    return 1;
  }
  printf("roots ok\n");
  return 0;
}
