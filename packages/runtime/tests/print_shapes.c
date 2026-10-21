/* print_shapes.c — dynamic objects (shape table + inline caches) through jsrt_print.
 *
 * Ground truth is Node: print_shapes.ts builds the SAME objects with plain object literals and
 * property assignment, in the same order; `just runtime-test` diffs the two byte-for-byte.
 *
 * Beyond "properties print in insertion order", this pins: a dynamic object prints exactly like
 * an object literal (no constructor name — Node cannot tell them apart); a missing property reads
 * `undefined`; an overwrite changes the value without changing the order; a non-identifier key
 * prints quoted; and reads through one shared inline cache stay correct across a shape-sharing
 * hit, a transition (the cached shape goes stale), and an unrelated shape.
 * Intern identity is an assert, not a print: two `jsrt_shape_key` conversions of the same
 * bytes must share one immortal pointer (plan-notes 353).
 */

#include "corpus.h"

#include <stdio.h>
#include <string.h>

static JSRTIC ic_a; /* static, exactly as generated C would emit a property site's cache */

int main(void) {
  jsrt_init();
  JSRT_FRAME(6);

  /* Intern identity: a stored key is immortal and shared. A compare-only lookup of a
   * fresh key must not enter that table (T16) — the miss used to keep 3·len+1 bytes
   * per call. Not a print: the corpus still diffs stdout against Node byte-for-byte. */
  {
    const char *once = jsrt_shape_key(str("intern-me"));
    const char *twice = jsrt_shape_key(str("intern-me"));
    if (once != twice || strcmp(once, "intern-me") != 0) {
      fprintf(stderr, "jsrt_shape_key intern identity failed\n");
      JSRT_FRAME_POP();
      return 1;
    }
    const size_t before = jsrt_shape_intern_count();
    jsrt_value obj = jsrt_dynobj_new();
    JSRT_LOCAL(0) = obj;
    for (int i = 0; i < 32; i++) {
      char buf[32];
      snprintf(buf, sizeof buf, "miss-%d", i);
      const jsrt_value key = str(buf);
      if (jsrt_dyn_index_get(obj, key, NULL) != JSRT_UNDEFINED || jsrt_in(key, obj) ||
          !jsrt_delete(obj, key)) {
        fprintf(stderr, "compare-only miss did not answer the spec\n");
        JSRT_FRAME_POP();
        return 1;
      }
    }
    if (jsrt_shape_intern_count() != before) {
      fprintf(stderr, "compare-only key lookup interned %zu keys\n",
              jsrt_shape_intern_count() - before);
      JSRT_FRAME_POP();
      return 1;
    }
    jsrt_dyn_index_set(obj, str("stored-once"), num(1), NULL);
    jsrt_dyn_index_set(obj, str("stored-once"), num(2), NULL);
    if (jsrt_shape_intern_count() != before + 1) {
      fprintf(stderr, "a stored key was not interned exactly once\n");
      JSRT_FRAME_POP();
      return 1;
    }
  }

  /* Empty prints as {}. */
  jsrt_value empty = jsrt_dynobj_new();
  JSRT_LOCAL(0) = empty;
  jsrt_print(empty);

  /* Insertion order, growth past the initial capacity, and a nested dynamic object. */
  jsrt_value box = jsrt_dynobj_new();
  JSRT_LOCAL(1) = box;
  jsrt_set_prop(box, "a", num(1), NULL);
  jsrt_set_prop(box, "b", str("two"), NULL);
  jsrt_set_prop(box, "c", jsrt_bool(true), NULL);
  jsrt_set_prop(box, "d", JSRT_NULL, NULL);
  jsrt_set_prop(box, "e", num(2.5), NULL);
  jsrt_value inner = jsrt_dynobj_new();
  JSRT_LOCAL(2) = inner;
  jsrt_set_prop(inner, "deep", str("in"), NULL);
  jsrt_set_prop(box, "f", inner, NULL);
  jsrt_print(box);

  /* Overwrite: value changes, position does not. */
  jsrt_set_prop(box, "b", num(22), NULL);
  jsrt_print(box);

  /* Missing property is undefined; present property reads back. */
  jsrt_print(jsrt_get_prop(box, "nope", NULL));
  jsrt_print(jsrt_get_prop(box, "a", NULL));

  /* Shape sharing: same keys in the same order land on the same shape, so one inline cache
   * filled by the first object HITS on the second. The print only shows the values; what the
   * shared cache pins is that the hit reads the RIGHT slot on a different object. */
  jsrt_value first = jsrt_dynobj_new();
  JSRT_LOCAL(3) = first;
  jsrt_set_prop(first, "x", num(10), NULL);
  jsrt_set_prop(first, "y", num(20), NULL);
  jsrt_value second = jsrt_dynobj_new();
  JSRT_LOCAL(4) = second;
  jsrt_set_prop(second, "x", num(30), NULL);
  jsrt_set_prop(second, "y", num(40), NULL);
  jsrt_print(jsrt_get_prop(first, "x", &ic_a));  /* fills the cache */
  jsrt_print(jsrt_get_prop(second, "x", &ic_a)); /* hits it — same shape */
  /* Transition: `second` gains a key, its shape moves, the cache goes stale and must MISS into
   * the slow path rather than serve the old offset. */
  jsrt_set_prop(second, "z", num(50), NULL);
  jsrt_print(jsrt_get_prop(second, "x", &ic_a));
  jsrt_print(second);

  /* Divergent histories are different shapes; both keep working through the same entry points. */
  jsrt_value other = jsrt_dynobj_new();
  JSRT_LOCAL(5) = other;
  jsrt_set_prop(other, "y", num(9), NULL); /* y FIRST: not the shape of `first` */
  jsrt_set_prop(other, "x", num(8), NULL);
  jsrt_print(other);

  /* Non-identifier keys print quoted, identifier keys bare. */
  jsrt_value quoted = jsrt_dynobj_new();
  /* Reuses LOCAL(0): `empty` is done. */
  JSRT_LOCAL(0) = quoted;
  jsrt_set_prop(quoted, "a-b", num(1), NULL);
  jsrt_set_prop(quoted, "ok", num(2), NULL);
  jsrt_set_prop(quoted, "1x", num(3), NULL);
  jsrt_print(quoted);

  JSRT_FRAME_POP();
  return 0;
}
