/* print_objects.c — prints a fixed corpus of class instances through jsrt_print.
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_objects.mjs builds the SAME
 * objects in the same order and prints them with console.log; `just runtime-test` diffs the two
 * byte-for-byte. Keep the two corpora in the same order or the diff means nothing.
 *
 * What this file has to pin, beyond "it prints the fields": the class NAME prints in front and
 * counts toward the 80-column budget, so the same fields under a longer name break onto separate
 * lines; there is no column grouping (eight fields are eight lines where eight array elements
 * would be a grid); and past the depth cap an object prints as `[ClassName]`, not `[Object]`.
 */

#include "corpus.h"

#include <stdio.h>

/* The class descriptors a compiled program would emit: one `static const` per class, shared by
 * every instance of it. */
static const char *const empty_fields[] = {""};
static const JSRTClass EMPTY = {"Empty", 0, empty_fields, NULL, 0, NULL, NULL, NULL};

static const char *const p_fields[] = {"x", "y"};
static const JSRTClass P = {"P", 2, p_fields, NULL, 0, NULL, NULL, NULL};

static const char *const one_field[] = {"v"};
static const JSRTClass DEEP = {"Deep", 1, one_field, NULL, 0, NULL, NULL, NULL};

/* Same shape as Deep, different name: the pair is what shows the name is inside the line budget
 * and not merely printed in front of it. */
static const JSRTClass SHORT = {"S", 1, one_field, NULL, 0, NULL, NULL, NULL};
static const JSRTClass LONG = {"AVeryLongClassNameIndeed", 1, one_field, NULL, 0, NULL, NULL, NULL};

static const char *const wide_fields[] = {"field0", "field1", "field2", "field3",
                                          "field4", "field5", "field6", "field7"};
static const JSRTClass WIDE = {"Wide", 8, wide_fields, NULL, 0, NULL, NULL, NULL};

static const char *const two_long[] = {"averyveryverylongfieldname", "another"};
static const JSRTClass LONGFIELDS = {"Long", 2, two_long, NULL, 0, NULL, NULL, NULL};

static const char *const mixed_fields[] = {"arr", "o"};
static const JSRTClass N = {"N", 2, mixed_fields, NULL, 0, NULL, NULL, NULL};

/* A `#private` field HAS a slot -- the layout is the same as any other field's -- and is not
 * printed. The leading '#' in the name is the whole signal, so these descriptors are what a
 * compiled program emits for `class Priv { #hidden; shown; }` with nothing special added. */
static const char *const priv_fields[] = {"#hidden", "shown"};
static const JSRTClass PRIV = {"Priv", 2, priv_fields, NULL, 0, NULL, NULL, NULL};

static const char *const all_priv_fields[] = {"#a", "#b"};
static const JSRTClass ALLPRIV = {"AllPriv", 2, all_priv_fields, NULL, 0, NULL, NULL, NULL};

static jsrt_value object(const JSRTClass *cls) {
  return jsrt_object_new(cls);
}

static jsrt_value with1(const JSRTClass *cls, jsrt_value a) {
  jsrt_value o = jsrt_object_new(cls);
  jsrt_object_set(o, 0, a);
  return o;
}

static jsrt_value with2(const JSRTClass *cls, jsrt_value a, jsrt_value b) {
  jsrt_value o = jsrt_object_new(cls);
  jsrt_object_set(o, 0, a);
  jsrt_object_set(o, 1, b);
  return o;
}

int main(void) {
  jsrt_init();

  /* A class with no fields, and the ordinary two-field case. */
  jsrt_print(object(&EMPTY));
  jsrt_print(with2(&P, num(1), num(2)));

  /* Field values are inspected, not stringified: strings are quoted, and the quote character is
   * chosen the same way it is inside an array. */
  jsrt_print(with2(&P, str("a"), str("it's")));

  /* Every scalar spelling, so a change to inspect_scalar cannot pass by only breaking objects. */
  jsrt_print(with2(&P, jsrt_bool(true), JSRT_NULL));
  jsrt_print(with2(&P, JSRT_UNDEFINED, num(-0.0)));
  jsrt_print(with2(&P, num(0.0 / 0.0), num(1.0 / 0.0)));

  /* Nesting, in both directions: an object inside an array and an array inside an object. */
  {
    jsrt_value one = with2(&P, num(1), num(2));
    jsrt_print(jsrt_array_new(1, &one));
  }
  {
    jsrt_value elements[3] = {num(1), num(2), num(3)};
    jsrt_print(with2(&N, jsrt_array_new(3, elements), with2(&P, num(1), num(2))));
  }
  {
    jsrt_value inner = with2(&P, num(1), num(2));
    jsrt_value middle = jsrt_array_new(1, &inner);
    jsrt_print(jsrt_array_new(1, &middle));
  }

  /* The depth cap: three levels print, the fourth is `[Deep]`. */
  jsrt_print(with1(&DEEP, with1(&DEEP, with1(&DEEP, with1(&DEEP, num(1))))));

  /* No grouping: eight fields are eight lines, where eight array elements would be a grid. */
  {
    jsrt_value wide = jsrt_object_new(&WIDE);
    for (uint32_t i = 0; i < 8; i++) {
      jsrt_object_set(wide, i, num((double)i));
    }
    jsrt_print(wide);
  }

  /* Two long fields, over the budget together. */
  jsrt_print(with2(&LONGFIELDS, str("a string value here"), str("and another long one")));

  /* The name is inside the budget. These two hold the SAME field, and only the class name differs;
   * the long one must break where the short one does not. */
  {
    jsrt_value payload = str("0123456789012345678901234567890123456789012345678901234567");
    jsrt_print(with1(&SHORT, payload));
    jsrt_print(with1(&LONG, payload));
  }

  /* An unassigned slot reads as `undefined`, which is what a declared-but-unset field is. */
  jsrt_print(object(&P));

  /* A `#private` field occupies a slot and never prints. An object whose fields are ALL private
   * prints as `{}` -- the same as a class with no fields, which is what Node does. */
  jsrt_print(with2(&PRIV, num(1), num(2)));
  jsrt_print(with2(&ALLPRIV, num(1), num(2)));

  /* ToString of an object is not its inspect form. */
  {
    jsrt_value s = jsrt_to_string(with2(&P, num(1), num(2)));
    jsrt_print(s);
    jsrt_value elements[2] = {with2(&P, num(1), num(2)), num(3)};
    jsrt_print(jsrt_to_string(jsrt_array_new(2, elements)));
  }

  return 0;
}
