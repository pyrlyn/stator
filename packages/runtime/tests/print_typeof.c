/* print_typeof.c — prints `typeof` for one value of every shape the runtime has.
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_typeof.ts asks the same
 * questions in the same order and prints the answers with console.log; `just runtime-test` diffs
 * the two byte-for-byte. Keep the two corpora in the same order or the diff means nothing.
 *
 * `typeof` is where the runtime's tags and the language's answers disagree twice, and both are
 * pinned here by consequence rather than by assertion. `typeof null` is "object" — the 1995 bug
 * that became normative, and the one answer no structural route to the tag would give. And a
 * closure answers "function" even though jsrt_is_object says it IS an object, which is the single
 * place in this runtime where callable is a category of its own.
 *
 * The numeric cases exist because NaN-boxing makes "is this a number" a two-tag question: a value
 * is a number if it is an unboxed double OR carries the int32 tag, and a real NaN reaches the tag
 * switch as a double rather than as one of the tagged values living in the quiet-NaN space.
 */

#include "corpus.h"

#include <stdio.h>

static jsrt_value identity(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  (void)env;
  return argc > 0 ? argv[0] : JSRT_UNDEFINED;
}

static const char *const p_fields[] = {"x"};
static const JSRTClass P = {"P", 1, p_fields, NULL, 0, NULL, NULL, NULL, NULL};

static void show(jsrt_value v) {
  jsrt_print(jsrt_typeof(v));
}

int main(void) {
  jsrt_init();

  /* Primitives, including the three numbers that are easy to get wrong. */
  show(num(0));
  show(num(-0.0));
  show(num(1.5));
  show(num(0.0 / 0.0));
  show(num(1.0 / 0.0));
  /* Boxed with the int32 tag directly: nothing in the compiler emits one yet (plan.md rung 1b is
   * deferred to Task 6.3), but jsrt_type_name has a case for it and an untested case is a case
   * that will be wrong the day the refinement lands. */
  show(JSRT_BOX(JSRT_TAG_INT32, 7));
  show(str(""));
  show(str("abc"));
  show(JSRT_TRUE);
  show(JSRT_FALSE);
  show(JSRT_UNDEFINED);
  show(JSRT_NULL);

  /* Objects, and the one that is not: a closure is callable, so it is "function". */
  show(jsrt_object_new(&P));
  show(jsrt_array_new(0, NULL));
  show(jsrt_map_new());
  show(jsrt_set_new());
  show(jsrt_closure_new(identity, 1, "identity", NULL, false));

  /* The answer is itself a string, so asking twice always ends at "string". */
  show(jsrt_typeof(num(1)));
  show(jsrt_typeof(JSRT_NULL));

  return 0;
}
