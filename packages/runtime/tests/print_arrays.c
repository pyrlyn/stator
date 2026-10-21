/* print_arrays.c — prints a fixed corpus of arrays through jsrt_print.
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_arrays.ts builds the SAME
 * arrays in the same order and prints them with console.log; `just runtime-test` diffs the two
 * byte-for-byte. Keep the two corpora in the same order or the diff means nothing.
 *
 * Array output is util.inspect, not ToString, and its layout rules are the whole reason this file
 * exists: the single-line form, the 80-column break, the column-aligned grouping above six
 * entries, the depth cap, and the 100-element truncation each have a boundary here.
 */

#include "corpus.h"

#include <stdio.h>

/* Builds an array of `n` copies of `fill`, used for the grouping and truncation boundaries. */
static jsrt_value repeated(uint32_t n, jsrt_value fill) {
  jsrt_value array = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; i < n; i++) {
    jsrt_array_set(array, jsrt_number((double)i), fill);
  }
  return array;
}

/* Builds [0, 1, ..., n-1]. */
static jsrt_value counted(uint32_t n) {
  jsrt_value array = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; i < n; i++) {
    jsrt_array_set(array, jsrt_number((double)i), jsrt_number((double)i));
  }
  return array;
}

int main(void) {
  jsrt_init();

  /* Empty, and the single-line form. */
  jsrt_print(jsrt_array_new(0, NULL));
  {
    jsrt_value one[] = {num(1.0)};
    jsrt_print(jsrt_array_new(1, one));
  }
  {
    jsrt_value three[] = {num(1.0), num(2.0), num(3.0)};
    jsrt_print(jsrt_array_new(3, three));
  }

  /* Six entries stay on one line; seven trip grouping. Both sides of the boundary. */
  jsrt_print(counted(6));
  jsrt_print(counted(7));
  jsrt_print(counted(10));
  jsrt_print(counted(27));

  /* Grouping is skipped when entries differ wildly in length: one long entry would stretch every
   * column to its width. */
  {
    jsrt_value mixed[] = {num(1.0),  num(2.0), num(3.0),
                          num(4.0),  num(5.0), num(6.0),
                          str("a string long enough to dominate every column in the block")};
    jsrt_print(jsrt_array_new(7, mixed));
  }

  /* Non-numbers are left-aligned where numbers are right-aligned, so the padding differs. */
  {
    jsrt_value words[] = {str("a"), str("bb"),   str("ccc"), str("dddd"),
                          str("e"), str("ffff"), str("g"),   str("hh")};
    jsrt_print(jsrt_array_new(8, words));
  }

  /* Every scalar as an element: strings gain quotes here, where console.log of the string alone
   * would not. -0 stays visible, as it does at the top level. */
  {
    jsrt_value scalars[] = {JSRT_TRUE, JSRT_FALSE, JSRT_NULL, JSRT_UNDEFINED};
    jsrt_print(jsrt_array_new(4, scalars));
  }
  {
    jsrt_value numbers[] = {num(-0.0), num(0.0 / 0.0), num(1.0 / 0.0), num(1e21), num(1e-7)};
    jsrt_print(jsrt_array_new(5, numbers));
  }

  /* Quote selection: single by default, double when the text holds a single quote, backtick when
   * it holds both. Escapes for the control characters that have names, and \xHH for the rest. */
  {
    jsrt_value quotes[] = {str("plain"), str("has'single"), str("has\"double")};
    jsrt_print(jsrt_array_new(3, quotes));
  }
  {
    jsrt_value quotes[] = {str("has'both\"quotes"), str("back\\slash")};
    jsrt_print(jsrt_array_new(2, quotes));
  }
  {
    jsrt_value escapes[] = {str("tab\there"), str("nl\nhere"), str("\x01" "ctl")};
    jsrt_print(jsrt_array_new(3, escapes));
  }
  {
    /* Non-ASCII passes through as UTF-8 rather than being escaped. */
    /* Split literals: a hex escape swallows every following hex digit, so "\xa9accent" would be
     * one enormous character rather than é followed by "accent". */
    jsrt_value wide[] = {str("\xc3\xa9" "accent"), str("\xe2\x9c\x93" "check")};
    jsrt_print(jsrt_array_new(2, wide));
  }

  /* Nesting, and the depth cap that replaces the fourth level with [Array]. */
  {
    jsrt_value inner_a[] = {num(1.0), num(2.0)};
    jsrt_value inner_b[] = {num(3.0), num(4.0)};
    jsrt_value pair[] = {jsrt_array_new(2, inner_a), jsrt_array_new(2, inner_b)};
    jsrt_print(jsrt_array_new(2, pair));
  }
  {
    jsrt_value l3[] = {num(1.0)};
    jsrt_value l2[] = {jsrt_array_new(1, l3)};
    jsrt_value l1[] = {jsrt_array_new(1, l2)};
    jsrt_print(jsrt_array_new(1, l1));
  }
  {
    jsrt_value l4[] = {num(1.0)};
    jsrt_value l3[] = {jsrt_array_new(1, l4)};
    jsrt_value l2[] = {jsrt_array_new(1, l3)};
    jsrt_value l1[] = {jsrt_array_new(1, l2)};
    jsrt_print(jsrt_array_new(1, l1));
  }
  {
    jsrt_value empty[] = {jsrt_array_new(0, NULL)};
    jsrt_print(jsrt_array_new(1, empty));
  }

  /* The 80-column break: four entries of twenty characters do not fit on one line. */
  {
    jsrt_value wide[] = {str("aaaaaaaaaaaaaaaaaaaa"), str("bbbbbbbbbbbbbbbbbbbb"),
                         str("cccccccccccccccccccc"), str("dddddddddddddddddddd")};
    jsrt_print(jsrt_array_new(4, wide));
  }
  /* Two entries either side of the break: 32 characters fit, 33 do not. */
  {
    jsrt_value fits[] = {str("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), str("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")};
    jsrt_print(jsrt_array_new(2, fits));
  }
  {
    jsrt_value over[] = {str("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), str("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")};
    jsrt_print(jsrt_array_new(2, over));
  }

  /* A nested array that must break carries its parent's indentation. */
  {
    jsrt_value inner[] = {str("aaaaaaaaaaaaaaaaaaaa"), str("bbbbbbbbbbbbbbbbbbbb"),
                          str("cccccccccccccccccccc"), str("dddddddddddddddddddd")};
    jsrt_value outer[] = {num(1.0), jsrt_array_new(4, inner)};
    jsrt_print(jsrt_array_new(2, outer));
  }

  /* Truncation: exactly 100 shows everything, 101 and 102 show the tail note in both its
   * singular and plural spelling. */
  jsrt_print(repeated(100, num(0.0)));
  jsrt_print(repeated(101, num(0.0)));
  jsrt_print(repeated(102, num(0.0)));

  /* ToString of an array is join(","), a different algorithm from the inspect form above --
   * printed through concatenation so it takes the string path, not the array path. */
  {
    jsrt_value items[] = {num(1.0), num(2.0), num(3.0)};
    jsrt_print(jsrt_op_add(str(""), jsrt_array_new(3, items)));
  }
  {
    jsrt_value nested[] = {num(2.0), num(3.0)};
    jsrt_value items[] = {num(1.0), jsrt_array_new(2, nested)};
    jsrt_print(jsrt_op_add(str(""), jsrt_array_new(2, items)));
  }
  {
    jsrt_value holes[] = {num(1.0), JSRT_NULL, JSRT_UNDEFINED, num(2.0)};
    jsrt_print(jsrt_op_add(str(""), jsrt_array_new(4, holes)));
  }
  jsrt_print(jsrt_op_add(str(""), jsrt_array_new(0, NULL)));

  /* Element read and write, including the out-of-range cases that are `undefined` rather than
   * errors, and the write past the end that extends the array. */
  {
    jsrt_value items[] = {num(10.0), num(20.0), num(30.0)};
    jsrt_value array = jsrt_array_new(3, items);
    jsrt_print(jsrt_array_get(array, num(0.0)));
    jsrt_print(jsrt_array_get(array, num(2.0)));
    jsrt_print(jsrt_array_get(array, num(3.0)));
    jsrt_print(jsrt_array_get(array, num(-1.0)));
    jsrt_print(jsrt_array_get(array, num(1.5)));
    jsrt_print(jsrt_array_get(array, num(0.0 / 0.0)));
    jsrt_print(jsrt_array_length(array));

    jsrt_array_set(array, num(1.0), num(99.0));
    jsrt_print(array);
    /* Appending at exactly `length` is the growth case that stays dense. Writing FURTHER past the
     * end would leave real holes in ECMA-262 (`<2 empty items>`) where this array leaves
     * `undefined`, which is the ceiling recorded on JSRTArray -- so it is deliberately not in a
     * corpus that demands byte-for-byte agreement. */
    jsrt_array_set(array, num(3.0), num(40.0));
    jsrt_print(array);
    jsrt_print(jsrt_array_length(array));
  }

  return 0;
}
