/* print_maps.c — prints a fixed corpus of Maps and Sets through jsrt_print.
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_maps.mjs builds the SAME
 * collections in the same order and prints them with console.log; `just runtime-test` diffs the
 * two byte-for-byte. Keep the two corpora in the same order or the diff means nothing.
 *
 * Beyond "it prints the entries", this pins the three things a Map is easy to get wrong: the
 * `Map(n)` prefix counts toward the 80-column budget the way a class name does, entries print in
 * INSERTION order (with a re-set key keeping its place and a deleted key vacating it), and there is
 * no column grouping, so eight numbers in a Set are eight lines where eight in an array are a grid.
 *
 * The key rules are checked by CONSEQUENCE rather than by asserting on the table: a NaN key that
 * did not hash to itself, or a -0 that did not find +0, changes what this program prints.
 */

#include "corpus.h"

#include <stdio.h>

static const char *const p_fields[] = {"x"};
static const JSRTClass P = {"P", 1, p_fields, NULL, 0, NULL, NULL, NULL};

static jsrt_value point(jsrt_value x) {
  jsrt_value o = jsrt_object_new(&P);
  jsrt_object_set(o, 0, x);
  return o;
}

int main(void) {
  jsrt_init();

  /* Empty, and the ordinary case. */
  jsrt_print(jsrt_map_new());
  jsrt_print(jsrt_set_new());

  {
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, str("a"), num(1));
    jsrt_map_set(m, str("b"), num(2));
    jsrt_print(m);
    printf("%s\n", jsrt_map_has(m, str("a")) ? "true" : "false");
    printf("%s\n", jsrt_map_has(m, str("z")) ? "true" : "false");
  }

  {
    jsrt_value s = jsrt_set_new();
    jsrt_set_add(s, num(1));
    jsrt_set_add(s, num(2));
    jsrt_set_add(s, num(1)); /* already present: no second entry, no move */
    jsrt_print(s);
  }

  /* Keys are inspected exactly as array elements are: quoted strings, every scalar spelling. */
  {
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, str("it's"), str("quoted"));
    jsrt_map_set(m, jsrt_bool(true), JSRT_NULL);
    jsrt_map_set(m, JSRT_UNDEFINED, num(-0.0));
    jsrt_map_set(m, num(1.0 / 0.0), num(0.0 / 0.0));
    jsrt_print(m);
  }

  /* SameValueZero: NaN is its own key (=== says otherwise) and -0 is the key +0 is (Object.is says
   * otherwise). Both are one entry, and the SECOND write updates the first's value. */
  {
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, num(0.0 / 0.0), str("first"));
    jsrt_map_set(m, num(-(0.0 / 0.0)), str("second"));
    jsrt_map_set(m, num(0.0), str("zero"));
    jsrt_map_set(m, num(-0.0), str("negative zero"));
    jsrt_print(m);
  }

  /* Objects are keyed by IDENTITY: two structurally identical points are two entries, and only the
   * one that was stored is found. */
  {
    jsrt_value a = point(num(1));
    jsrt_value b = point(num(1));
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, a, str("a"));
    jsrt_map_set(m, b, str("b"));
    jsrt_print(m);
    printf("%s\n", jsrt_map_has(m, a) ? "true" : "false");
    printf("%s\n", jsrt_map_has(m, point(num(1))) ? "true" : "false");
  }

  /* Insertion order survives an update and a deletion: `a` keeps its place when re-set, and `b`
   * leaves a gap that the next insert does NOT fill. */
  {
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, str("a"), num(1));
    jsrt_map_set(m, str("b"), num(2));
    jsrt_map_set(m, str("c"), num(3));
    jsrt_map_set(m, str("a"), num(9));
    printf("%s\n", jsrt_map_delete(m, str("b")) ? "true" : "false");
    printf("%s\n", jsrt_map_delete(m, str("b")) ? "true" : "false");
    jsrt_map_set(m, str("d"), num(4));
    jsrt_print(m);
    jsrt_print(jsrt_map_size(m));
    jsrt_map_clear(m);
    jsrt_print(m);
    jsrt_map_set(m, str("e"), num(5));
    jsrt_print(m);
  }

  /* Nesting, in both directions, and the depth cap: past it a Map prints as `[Map]`. */
  {
    jsrt_value inner = jsrt_map_new();
    jsrt_map_set(inner, str("k"), num(1));
    jsrt_value outer = jsrt_map_new();
    jsrt_map_set(outer, str("m"), inner);
    jsrt_map_set(outer, str("p"), point(num(2)));
    jsrt_print(outer);

    jsrt_value elements[2] = {inner, jsrt_set_new()};
    jsrt_print(jsrt_array_new(2, elements));

    jsrt_value d1 = jsrt_map_new();
    jsrt_map_set(d1, num(1), num(1));
    jsrt_value d2 = jsrt_map_new();
    jsrt_map_set(d2, num(2), d1);
    jsrt_value d3 = jsrt_map_new();
    jsrt_map_set(d3, num(3), d2);
    jsrt_value d4 = jsrt_map_new();
    jsrt_map_set(d4, num(4), d3);
    jsrt_print(d4);
  }

  /* The prefix is inside the line budget: the same eight entries break differently under `Map(8)`
   * than the same values do in an array, and a Set of eight numbers is eight lines, not a grid. */
  {
    jsrt_value s = jsrt_set_new();
    for (int i = 0; i < 8; i++) {
      jsrt_set_add(s, num(i));
    }
    jsrt_print(s);
  }
  {
    jsrt_value m = jsrt_map_new();
    jsrt_map_set(m, str("averyveryverylongkeyname"), str("a value long enough to matter"));
    jsrt_map_set(m, str("another"), str("and another value"));
    jsrt_print(m);
  }

  /* Growth past the initial capacity, with deletions mixed in so the compaction path runs: the
   * printed order is still the order the survivors were inserted in. */
  {
    jsrt_value m = jsrt_map_new();
    for (int i = 0; i < 40; i++) {
      jsrt_map_set(m, num(i), num(i * 2));
    }
    for (int i = 0; i < 40; i += 2) {
      jsrt_map_delete(m, num(i));
    }
    for (int i = 40; i < 60; i++) {
      jsrt_map_set(m, num(i), num(i * 2));
    }
    jsrt_print(jsrt_map_size(m));
    jsrt_print(jsrt_map_get(m, num(39)));
    jsrt_print(jsrt_map_get(m, num(38)));
    jsrt_print(m);
  }

  /* More entries than inspect shows: the tail becomes `... N more items`. */
  {
    jsrt_value s = jsrt_set_new();
    for (int i = 0; i < 102; i++) {
      jsrt_set_add(s, num(i));
    }
    jsrt_print(s);
  }

  return 0;
}
