/* corpus.h — the two constructors every print corpus writes literals with.
 *
 * Each `print_*.c` builds a fixed list of values and prints them, and each one needs a number and a
 * string from a C literal. They live here rather than three times over so that "what a corpus value
 * is" has one definition: a corpus is only ground truth while the C side and the `.ts` side build
 * the SAME values, and a helper that drifted in one file would break that quietly.
 */

#ifndef JSRT_TESTS_CORPUS_H
#define JSRT_TESTS_CORPUS_H

#include "jsrt_value.h"

#include <string.h>

static inline jsrt_value num(double d) {
  return jsrt_number(d);
}

static inline jsrt_value str(const char *s) {
  return jsrt_string_from_utf8(s, strlen(s));
}

#endif /* JSRT_TESTS_CORPUS_H */
