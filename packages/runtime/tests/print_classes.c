/* print_classes.c — the class object of docs/VALUE.md §4.18, printed and called.
 *
 * Ground truth is Node: print_classes.ts declares the SAME classes and prints them in the same
 * order; `just runtime-test` diffs the two byte-for-byte.
 *
 * What this pins: a class prints as `[class S]` with its own static DATA fields as braces and
 * nothing for methods or accessors; `extends` names the parent object; the base and the `{` count
 * toward the line budget but the space between them does not (the width pair below sits on that
 * boundary); past the depth cap a class with statics prints `[Function]` and one without still
 * prints its base; `typeof` is "function"; calling a class is Node's TypeError; and the statics are
 * the binding CELLS, so a write by name shows through the value.
 */

#include "corpus.h"

#include <assert.h>
#include <stdio.h>

/* The statics live where a compiled program keeps module-scope statics: in the globals array,
 * rooted by its frame, at addresses a static initializer can take. */
enum { S_V, T_V, F_A, F_B, F_C, L_A, L_B, L_C, W_A, W_B, N_A, N_B, GLOBAL_COUNT };
JSRT_GLOBALS(GLOBAL_COUNT);

#define CLASS(name, parent, count, names, cells)                                                   \
  {{jsrt_class_invoke, 0, name, NULL, false}, NULL, NULL, parent, count, names, cells}

static const char *const v_names[] = {"v"};
static jsrt_value *const s_cells[] = {&JSRT_GLOBAL(S_V)};
static jsrt_value *const t_cells[] = {&JSRT_GLOBAL(T_V)};
static const JSRTClassObject S = CLASS("S", NULL, 1, v_names, s_cells);
static const JSRTClassObject T = CLASS("T", &S, 1, v_names, t_cells);
static const JSRTClassObject U = CLASS("U", &T, 0, NULL, NULL);
static const JSRTClassObject E = CLASS("E", NULL, 0, NULL, NULL);

static const char *const f_names[] = {"a", "b", "c"};
static jsrt_value *const f_cells[] = {&JSRT_GLOBAL(F_A), &JSRT_GLOBAL(F_B), &JSRT_GLOBAL(F_C)};
static const JSRTClassObject F = CLASS("F", &E, 3, f_names, f_cells);

static const char *const l_names[] = {"aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccc"};
static jsrt_value *const l_cells[] = {&JSRT_GLOBAL(L_A), &JSRT_GLOBAL(L_B), &JSRT_GLOBAL(L_C)};
static const JSRTClassObject LONG = CLASS("Long", NULL, 3, l_names, l_cells);

/* The width pair: one class whose single-line form fits, and one a character longer that breaks. */
static const char *const w_names[] = {"alpha", "beta"};
static jsrt_value *const w_cells[] = {&JSRT_GLOBAL(W_A), &JSRT_GLOBAL(W_B)};
static jsrt_value *const n_cells[] = {&JSRT_GLOBAL(N_A), &JSRT_GLOBAL(N_B)};
static const JSRTClassObject WIDE = CLASS("Wide", NULL, 2, w_names, w_cells);
static const JSRTClassObject NARROW = CLASS("Narrow", NULL, 2, w_names, n_cells);

/* An instance holding a class in its one field -- the nesting for the depth cases. */
static const char *const k_field[] = {"k"};
static const JSRTClass H = {"H", 1, k_field, NULL, 0, NULL, NULL, NULL};

static jsrt_value holder(jsrt_value k) {
  jsrt_value o = jsrt_object_new(&H);
  jsrt_object_set(o, 0, k);
  return o;
}

int main(void) {
  jsrt_init();
  JSRT_GLOBALS_ENTER(GLOBAL_COUNT);
  JSRT_FRAME(1);

  JSRT_GLOBAL(S_V) = num(5);
  JSRT_GLOBAL(T_V) = num(10);
  JSRT_GLOBAL(F_A) = num(1);
  JSRT_GLOBAL(F_B) = str("x");
  {
    const jsrt_value items[] = {num(1), num(2)};
    JSRT_GLOBAL(F_C) = jsrt_array_new(2, items);
  }
  JSRT_GLOBAL(L_A) = str("aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  JSRT_GLOBAL(L_B) = str("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  JSRT_GLOBAL(L_C) = num(3);
  JSRT_GLOBAL(W_A) = str("aaaaaaaaaaaaaaaaaaaa");
  JSRT_GLOBAL(W_B) = str("bbbbbbbbbbbbbbbb");
  JSRT_GLOBAL(N_A) = str("aaaaaaaaaaaaaaaaaaaa");
  JSRT_GLOBAL(N_B) = str("bbbbbbbbbbbbbbbb");

  const jsrt_value s = jsrt_class_value(&S);
  const jsrt_value t = jsrt_class_value(&T);
  const jsrt_value e = jsrt_class_value(&E);

  jsrt_print(s);
  jsrt_print(t);
  jsrt_print(jsrt_class_value(&U));
  jsrt_print(e);
  jsrt_print(jsrt_class_value(&F));
  jsrt_print(jsrt_class_value(&LONG));
  jsrt_print(jsrt_class_value(&WIDE));
  jsrt_print(jsrt_class_value(&NARROW));

  {
    const jsrt_value pair[] = {s, t};
    jsrt_print(jsrt_array_new(2, pair));
    jsrt_print(jsrt_array_new(1, &e));
  }
  jsrt_print(holder(s));
  jsrt_print(holder(holder(holder(s))));
  jsrt_print(holder(holder(holder(e))));

  jsrt_print(jsrt_typeof(s));
  /* A class is its own identity: the same pointer every time it is named. */
  jsrt_print(s == jsrt_class_value(&S) ? JSRT_TRUE : JSRT_FALSE);

  /* Calling a class without `new`. */
  JSRT_LOCAL(0) = jsrt_call(t, 0, NULL);
  assert(jsrt_pending());
  const jsrt_value error = jsrt_take_exception();
  assert(jsrt_instanceof(error, &jsrt_class_type_error));
  jsrt_print(jsrt_get_prop(error, "message", NULL));

  /* `S.v = 6` by name writes the cell the class object prints from. */
  JSRT_GLOBAL(S_V) = num(6);
  jsrt_print(s);

  JSRT_FRAME_POP();
  return 0;
}
