/* jsrt_print.c — number->string conversion and console.log output.
 *
 * Two functions with deliberately different behaviour (docs/VALUE.md §3.3):
 *   jsrt_print     — console.log semantics, prints -0 as "-0" (Node's util.inspect rule)
 *   jsrt_to_string — ECMA-262 ToString, where -0 is "0"
 *
 * Printing an ARRAY is a third thing again, and not derivable from either: `console.log([1,'a'])`
 * is `[ 1, 'a' ]` — the string is quoted inside an array and bare at the top level, and the layout
 * (single line, wrapped, or column-aligned) follows Node's util.inspect rather than any clause of
 * ECMA-262. Golden tests compare stdout byte-for-byte, so that algorithm is reproduced here
 * exactly, constants included; §4.4 of docs/VALUE.md records where each constant came from.
 *
 * Number formatting implements ECMA-262 Number::toString(x, 10) literally, because the
 * surrounding FORMAT is where the traps are, not the digits (docs/VALUE.md §3.2):
 *   - the decimal/exponential threshold is 1e21, far above any C library's
 *   - negative exponents are written "1e-7" with NO zero padding
 *   - "%g" is unusable: it switches to exponential on its own criteria, so it prints
 *     100 as "1e+02" and 1e20 as "1e+20" where JS prints "100" and "100000000000000000000"
 */

#include "jsrt_value.h"

#include "jsrt.h"

#include "jsrt_mem.h"

#include "ryu/ryu.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ============================================================================
 * Shortest round-trip digits
 * ============================================================================ */

/* Decompose a finite, strictly positive double into ECMA-262 step 5's (s, k, n):
 *   digits — the decimal digits of s, NUL-terminated, no sign and no point
 *   *k     — how many digits there are
 *   *n     — position of the decimal point, i.e. value == 0.digits * 10^n
 *
 * The digits come from vendored Ryū (`vendor/ryu/`, docs/VALUE.md §3.1) — one call to
 * `d2s_buffered` instead of the round-trip search over "%.*e" this used to run (up to 18
 * snprintf+strtod pairs per number). Ryū answers `D[.DDD]E±X` (no plus on a non-negative
 * exponent, no decimal point when there is one digit); this parses that shape into the same
 * (k, n) the search produced, so every caller below is unchanged. Sign, NaN, Infinity and ±0
 * never reach here — `format_double` peels them off first. */
static void shortest_digits(double d, char *digits, size_t digits_len, int *k, int *n) {
  char temp[32];
  d2s_buffered(d, temp);

  size_t out = 0;
  const char *c = temp;
  for (; *c != '\0' && *c != 'E'; c++) {
    if (*c >= '0' && *c <= '9' && out + 1 < digits_len) {
      digits[out++] = *c;
    }
  }
  digits[out] = '\0';

  int exponent = 0;
  if (*c == 'E') {
    exponent = (int)strtol(c + 1, NULL, 10);
  }

  *k = (int)out;
  *n = exponent + 1; /* "D[.DDD]E±X" has its point after 1 digit, so n = X + 1 */
}

/* Write ECMA-262 Number::toString(d) for a finite, strictly positive d. */
static void format_positive(double d, char *buf, size_t buflen) {
  char digits[32];
  int k = 0;
  int n = 0;
  shortest_digits(d, digits, sizeof digits, &k, &n);

  static const char ZEROS[22] = "000000000000000000000"; /* n <= 21 bounds every run below */

  if (k <= n && n <= 21) {
    /* Step 6: all digits, then n-k zeros. This is the case "%g" gets wrong: it would give
     * 1e20 as "1e+20" where JS wants the twenty-one digits. */
    snprintf(buf, buflen, "%s%.*s", digits, n - k, ZEROS);
  } else if (0 < n && n <= 21) {
    /* Step 7: point inside the digits. */
    snprintf(buf, buflen, "%.*s.%s", n, digits, digits + n);
  } else if (-6 < n && n <= 0) {
    /* Step 8: "0." then -n zeros then the digits. */
    snprintf(buf, buflen, "0.%.*s%s", -n, ZEROS, digits);
  } else if (k == 1) {
    /* Step 9, single digit: "1e+21", "1e-7". The sign is always present and the exponent is
     * NEVER zero-padded -- "1e-07" would be a C habit, not JS. */
    snprintf(buf, buflen, "%se%c%d", digits, (n > 0) ? '+' : '-', abs(n - 1));
  } else {
    /* Step 10, multiple digits: "1.5e+21". */
    snprintf(buf, buflen, "%c.%se%c%d", digits[0], digits + 1, (n > 0) ? '+' : '-', abs(n - 1));
  }
}

/* negative_zero_visible distinguishes the two callers: console.log shows -0, ToString does not
 * (docs/VALUE.md §3.3). Everything else about the two is identical. */
static void format_double(double d, char *buf, size_t buflen, bool negative_zero_visible) {
  if (isnan(d)) {
    snprintf(buf, buflen, "NaN");
    return;
  }
  if (isinf(d)) {
    snprintf(buf, buflen, d < 0 ? "-Infinity" : "Infinity");
    return;
  }
  if (d == 0.0) {
    snprintf(buf, buflen, (negative_zero_visible && signbit(d)) ? "-0" : "0");
    return;
  }
  if (d < 0.0) {
    char rest[64];
    format_positive(-d, rest, sizeof rest);
    snprintf(buf, buflen, "-%s", rest);
    return;
  }
  format_positive(d, buf, buflen);
}

/* ============================================================================
 * Output buffer
 * ============================================================================ */

/* Output is built up in a JSRTBuf (jsrt_mem.h) rather than streamed: array layout cannot be
 * decided until every element has been rendered and measured. */

/* ============================================================================
 * UTF-16 -> UTF-8 output
 * ============================================================================ */

/* UTF-8 encoding of one resolved code point, shared by append_string (whose surrogate
 * fixup runs first) and json_quote (whose escapes run first): the four arms are one rule,
 * not two. */
static void append_utf8(JSRTBuf *out, uint32_t cp) {
  if (cp < 0x80u) {
    jsrt_buf_putc(out, (char)cp);
  } else if (cp < 0x800u) {
    jsrt_buf_putc(out, (char)(0xC0u | (cp >> 6)));
    jsrt_buf_putc(out, (char)(0x80u | (cp & 0x3Fu)));
  } else if (cp < 0x10000u) {
    jsrt_buf_putc(out, (char)(0xE0u | (cp >> 12)));
    jsrt_buf_putc(out, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
    jsrt_buf_putc(out, (char)(0x80u | (cp & 0x3Fu)));
  } else {
    jsrt_buf_putc(out, (char)(0xF0u | (cp >> 18)));
    jsrt_buf_putc(out, (char)(0x80u | ((cp >> 12) & 0x3Fu)));
    jsrt_buf_putc(out, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
    jsrt_buf_putc(out, (char)(0x80u | (cp & 0x3Fu)));
  }
}

static void append_units(JSRTBuf *out, const JSString *str, uint32_t from, uint32_t to);

static void append_string(JSRTBuf *out, const JSString *str) {
  append_units(out, str, 0, str->length);
}

/* Appends code units [from, to) of a JSString as UTF-8. Unpaired surrogates become U+FFFD: they
 * cannot be represented in well-formed UTF-8, and a JS string is allowed to contain them. A
 * util.format slice ends at a `%`, so it never splits a pair. */
static void append_units(JSRTBuf *out, const JSString *str, uint32_t from, uint32_t to) {
  for (uint32_t i = from; i < to; i++) {
    uint32_t cp = str->data[i];

    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < to) {
      uint32_t low = str->data[i + 1];
      if (low >= 0xDC00u && low <= 0xDFFFu) {
        cp = 0x10000u + ((cp - 0xD800u) << 10) + (low - 0xDC00u);
        i++;
      }
    }
    if (cp >= 0xD800u && cp <= 0xDFFFu) {
      cp = 0xFFFDu; /* lone surrogate */
    }

    append_utf8(out, cp);
  }
}

/* ============================================================================
 * util.inspect — the form a value takes INSIDE an array
 * ============================================================================ */

/* Node's defaults for console.log, each confirmed against the pinned Node rather than assumed:
 * an array breaks across lines past 80 columns, stops recursing below depth 2 ("[Array]"), and
 * shows at most 100 elements before "... n more items". */
#define INSPECT_BREAK_LENGTH 80
#define INSPECT_MAX_DEPTH 2
#define INSPECT_MAX_ARRAY 100
/* `compact: 3`, used only as `compact * 4` when capping columns. The other use of `compact` --
 * whether a nested value may share one line -- cannot fail while the depth cap is 2, because the
 * height of any surviving subtree is then at most 2, which is already below 3. */
#define INSPECT_COMPACT 3
#define SEPARATOR_SPACE 2 /* ", " between two entries */

static void inspect_value(JSRTBuf *out, jsrt_value v, int recurse, size_t indent);
static void append_key(JSRTBuf *out, const char *key);

/* Node's quote choice, shared by append_quoted (UTF-16 string contents) and append_key
 * (NUL-terminated key bytes): single quotes, unless the text contains one and no double
 * quote, and backticks only when it contains both. The scans stay at the call sites --
 * they walk different element types -- and only the selection is shared. */
static char choose_quote(bool has_single, bool has_double, bool has_backtick) {
  if (!has_single) {
    return '\'';
  }
  if (!has_double) {
    return '"';
  }
  if (!has_backtick) {
    return '`';
  }
  return '\'';
}

/* The control-escape tail shared by append_quoted (string values) and append_key (quoted
 * keys): Node escapes both identically -- short escapes, "\x0B" for VT (never "\v"), "\xXX"
 * uppercase for every other C0 control and DEL. Quote/backslash handling stays at the call
 * sites because the chosen quote differs per string. */
static void append_control_escape(JSRTBuf *out, uint32_t cp) {
  switch (cp) {
    case '\n':
      jsrt_buf_puts(out, "\\n");
      break;
    case '\t':
      jsrt_buf_puts(out, "\\t");
      break;
    case '\r':
      jsrt_buf_puts(out, "\\r");
      break;
    case '\b':
      jsrt_buf_puts(out, "\\b");
      break;
    case '\f':
      jsrt_buf_puts(out, "\\f");
      break;
    case 0x0B:
      jsrt_buf_puts(out, "\\x0B");
      break;
    default: {
      char hex[8];
      snprintf(hex, sizeof hex, "\\x%02X", cp);
      jsrt_buf_puts(out, hex);
    }
  }
}

/* Quote/backslash, then the control-escape tail. Shared by the UTF-16 and UTF-8 quoted writers;
 * surrogate / multi-byte handling stays at the call sites. Answers true when the unit was escaped. */
static bool append_quoted_escape(JSRTBuf *out, uint32_t cp, char quote) {
  if (cp == (uint32_t)(unsigned char)quote || cp == '\\') {
    jsrt_buf_putc(out, '\\');
    jsrt_buf_putc(out, (char)cp);
    return true;
  }
  if (cp < 0x20 || cp == 0x7F) {
    append_control_escape(out, cp);
    return true;
  }
  return false;
}

/* Quoting follows Node: single quotes, unless the string contains one and no double quote, and
 * backticks only when it contains both. The quote actually chosen is then the only quote that
 * needs escaping inside. */
static void append_quoted(JSRTBuf *out, const JSString *str) {
  bool has_single = false;
  bool has_double = false;
  bool has_backtick = false;
  for (uint32_t i = 0; i < str->length; i++) {
    has_single = has_single || str->data[i] == '\'';
    has_double = has_double || str->data[i] == '"';
    has_backtick = has_backtick || str->data[i] == '`';
  }
  const char quote = choose_quote(has_single, has_double, has_backtick);

  jsrt_buf_putc(out, quote);
  for (uint32_t i = 0; i < str->length; i++) {
    uint16_t c = str->data[i];
    if (append_quoted_escape(out, c, quote)) {
      continue;
    }
    if (c >= 0xD800u && c <= 0xDFFFu &&
        !(c <= 0xDBFFu && i + 1 < str->length && str->data[i + 1] >= 0xDC00u &&
          str->data[i + 1] <= 0xDFFFu)) {
      /* A LONE surrogate: Node escapes it ("\ud800", lowercase hex), where the unquoted path
       * substitutes U+FFFD (append_string) and JSON escapes it per well-formed stringify. */
      char esc[8];
      snprintf(esc, sizeof esc, "\\u%04x", c);
      jsrt_buf_puts(out, esc);
    } else {
      /* Hand the code unit -- with its partner, when it starts a surrogate pair -- to the same
       * UTF-8 writer the unquoted path uses, so a pair still comes out as one code point. The
       * stand-in is a view of those units in place. */
      const bool pair = c >= 0xD800u && c <= 0xDBFFu && i + 1 < str->length &&
                        str->data[i + 1] >= 0xDC00u && str->data[i + 1] <= 0xDFFFu;
      const JSString piece = {pair ? 2u : 1u, 0u, &str->data[i], NULL};
      append_string(out, &piece);
      if (pair) {
        i++;
      }
    }
  }
  jsrt_buf_putc(out, quote);
}

/* Everything that is not an array renders the same inside an array as it does at the top level,
 * except a string, which is quoted here and bare there. */
static void inspect_scalar(JSRTBuf *out, jsrt_value v, bool quote_strings) {
  char buf[64];

  if (jsrt_is_double(v)) {
    format_double(jsrt_to_double(v), buf, sizeof buf, true);
    jsrt_buf_puts(out, buf);
  } else if (jsrt_is(v, JSRT_TAG_STRING)) {
    const JSString *str = (const JSString *)jsrt_ptr(v);
    if (quote_strings) {
      append_quoted(out, str);
    } else {
      append_string(out, str);
    }
  } else if (jsrt_is(v, JSRT_TAG_BOOL)) {
    jsrt_buf_puts(out, jsrt_as_bool(v) ? "true" : "false");
  } else if (jsrt_is(v, JSRT_TAG_NULL)) {
    jsrt_buf_puts(out, "null");
  } else if (jsrt_is(v, JSRT_TAG_UNDEFINED)) {
    jsrt_buf_puts(out, "undefined");
  } else if (jsrt_is(v, JSRT_TAG_INT32)) {
    snprintf(buf, sizeof buf, "%d", jsrt_as_int32(v));
    jsrt_buf_puts(out, buf);
  } else if (jsrt_is(v, JSRT_TAG_CLOSURE)) {
    const char *name = jsrt_as_closure(v)->name;
    if (name[0] == '\0') {
      jsrt_buf_puts(out, "[Function (anonymous)]");
    } else {
      snprintf(buf, sizeof buf, "[Function: %s]", name);
      jsrt_buf_puts(out, buf);
    }
  } else {
    jsrt_buf_puts(out, "[object Object]");
  }
}

/* Zeroed entry buffers for the inspect layouts below (array, object, map, grouped rows):
 * every layout allocates the same way and aborts the same way, so the check lives once. */
static JSRTBuf *alloc_entries(size_t count) {
  JSRTBuf *entries = (JSRTBuf *)calloc(count, sizeof(JSRTBuf));
  if (entries == NULL) {
    jsrt_panic("out of memory: print buffer");
  }
  return entries;
}

/* Release entry buffers and the vector itself. emit_braced consumes its entries; inspect_array
 * frees both the entries and, when grouping fired, the rows. */
static void free_entries(JSRTBuf *entries, size_t count) {
  for (size_t i = 0; i < count; i++) {
    jsrt_buf_free(&entries[i]);
  }
  free(entries);
}

/* Node's groupArrayElements: above six entries, short ones are laid out in aligned columns rather
 * than one per line. Returns the number of rows written into `rows`, or 0 when the shape does not
 * qualify and the caller should keep the entries as they are.
 *
 * `count` counts the entries that hold elements; a trailing "... n more items" is excluded from
 * the grouping and appended afterwards, which is why it is passed separately as `total`. */
static size_t group_entries(const JSRTBuf *entries, size_t count, size_t total, size_t indent,
                            bool all_numbers, JSRTBuf *rows) {
  size_t total_length = 0;
  size_t max_length = 0;
  for (size_t i = 0; i < count; i++) {
    total_length += entries[i].len + SEPARATOR_SPACE;
    if (entries[i].len > max_length) {
      max_length = entries[i].len;
    }
  }

  const size_t actual_max = max_length + SEPARATOR_SPACE;
  /* Group only when at least three entries fit side by side, and only when the entries are of
   * comparable size -- otherwise one long entry would stretch every column to its width. */
  if (!(actual_max * 3 + indent < INSPECT_BREAK_LENGTH &&
        ((double)total_length / (double)actual_max > 5.0 || max_length <= 6))) {
    return 0;
  }

  const double approx_char_heights = 2.5;
  const double average_bias = sqrt((double)actual_max - (double)total_length / (double)total);
  const double biased_max = fmax((double)actual_max - 3.0 - average_bias, 1.0);

  /* Aim for a square block: the sqrt is the side of a square holding `count` cells that are
   * about 2.5 times taller than wide. The other three terms are hard caps. */
  double ideal = round(sqrt(approx_char_heights * biased_max * (double)count) / biased_max);
  size_t columns = (size_t)ideal;
  const size_t fits = (INSPECT_BREAK_LENGTH - indent) / actual_max;
  if (columns > fits) {
    columns = fits;
  }
  if (columns > INSPECT_COMPACT * 4) {
    columns = INSPECT_COMPACT * 4;
  }
  if (columns > 15) {
    columns = 15;
  }
  if (columns <= 1) {
    return 0;
  }

  /* Every column is as wide as its widest member, so the commas line up down the block. */
  size_t *column_width = (size_t *)calloc(columns, sizeof(size_t));
  if (column_width == NULL) {
    jsrt_panic("out of memory: print buffer");
  }
  for (size_t i = 0; i < columns; i++) {
    size_t width = 0;
    for (size_t j = i; j < count; j += columns) {
      if (entries[j].len > width) {
        width = entries[j].len;
      }
    }
    column_width[i] = width + SEPARATOR_SPACE;
  }

  /* Numbers are right-aligned so their digits line up; anything else is left-aligned. */
  size_t rows_written = 0;
  for (size_t i = 0; i < count; i += columns) {
    const size_t max = (i + columns < count) ? i + columns : count;
    JSRTBuf *row = &rows[rows_written++];
    jsrt_buf_init(row);
    size_t j = i;
    for (; j + 1 < max; j++) {
      const size_t padding = column_width[j - i];
      const size_t written = entries[j].len + SEPARATOR_SPACE;
      if (all_numbers && padding > written) {
        jsrt_buf_repeat(row, ' ', padding - written);
      }
      jsrt_buf_append(row, entries[j].data, entries[j].len);
      jsrt_buf_puts(row, ", ");
      if (!all_numbers && padding > written) {
        jsrt_buf_repeat(row, ' ', padding - written);
      }
    }
    /* The last entry on a row carries no separator, so its column is two narrower. */
    if (all_numbers) {
      const size_t padding = column_width[j - i] - SEPARATOR_SPACE;
      if (padding > entries[j].len) {
        jsrt_buf_repeat(row, ' ', padding - entries[j].len);
      }
    }
    jsrt_buf_append(row, entries[j].data, entries[j].len);
  }

  free(column_width);
  return rows_written;
}

/* True when laying the entries out on one line stays inside the break length. Mirrors Node's
 * isBelowBreakLength, including the constant 10 it adds to leave room for whatever surrounds the
 * value, and the separate check that the separators alone do not overflow. */
/* `prefix` is Node's `braces[0].length + base.length`: one for the bracket or brace, plus the class
 * name a class instance prints in front of it. A longer name really does make the same fields break
 * onto separate lines, so it has to be in the budget. */
static bool fits_one_line(const JSRTBuf *entries, size_t count, size_t indent, size_t prefix) {
  const size_t start = count + indent + prefix + 10;
  size_t total = count + start;
  if (total + count > INSPECT_BREAK_LENGTH) {
    return false;
  }
  for (size_t i = 0; i < count; i++) {
    if (entries[i].len > 0 && memchr(entries[i].data, '\n', entries[i].len) != NULL) {
      return false;
    }
    total += entries[i].len;
    if (total > INSPECT_BREAK_LENGTH) {
      return false;
    }
  }
  return true;
}

/* The brace layout objects and Map/Set share: entries joined one-line inside `{ }` when the line
 * budget holds, one entry per line at indent+2 otherwise. Consumes (frees) the entry buffers. */

/* The two joins are shared by emit_braced (`{ }`) and inspect_array (`[ ]`): same separators,
 * same indentation, only the brackets differ, which is why they arrive as parameters. */
static void join_one_line(JSRTBuf *out, const char *open, const char *close, const JSRTBuf *entries,
                           size_t count) {
  jsrt_buf_puts(out, open);
  for (size_t i = 0; i < count; i++) {
    if (i > 0) {
      jsrt_buf_puts(out, ", ");
    }
    jsrt_buf_append(out, entries[i].data, entries[i].len);
  }
  jsrt_buf_puts(out, close);
}

static void join_multi_line(JSRTBuf *out, const char *open_line, char close, const JSRTBuf *entries,
                             size_t count, size_t indent) {
  jsrt_buf_puts(out, open_line);
  for (size_t i = 0; i < count; i++) {
    if (i > 0) {
      jsrt_buf_puts(out, ",\n");
    }
    jsrt_buf_repeat(out, ' ', indent + 2);
    jsrt_buf_append(out, entries[i].data, entries[i].len);
  }
  jsrt_buf_putc(out, '\n');
  jsrt_buf_repeat(out, ' ', indent);
  jsrt_buf_putc(out, close);
}

static void emit_braced(JSRTBuf *out, JSRTBuf *entries, size_t count, size_t indent, size_t prefix) {
  if (fits_one_line(entries, count, indent, prefix)) {
    join_one_line(out, "{ ", " }", entries, count);
  } else {
    join_multi_line(out, "{\n", '}', entries, count, indent);
  }

  free_entries(entries, count);
}


/* The "... N more items" tail shared by inspect_array and inspect_map: same 64-byte scratch,
 * same singular/plural rule, written into the already-counted trailing entry. */
static void init_more_entry(JSRTBuf *entry, uint32_t remaining) {
  char more[64];
  snprintf(more, sizeof more, "... %u more item%s", remaining, remaining == 1 ? "" : "s");
  jsrt_buf_init(entry);
  jsrt_buf_puts(entry, more);
}

/* An array's element `i`, and a Uint8Array's: the two lists inspect_list prints. */
static jsrt_value array_element(jsrt_value v, uint32_t i) { return jsrt_as_array(v)->elements[i]; }

static jsrt_value uint8array_element(jsrt_value v, uint32_t i) {
  return jsrt_uint8array_get(v, jsrt_number((double)i));
}

/* `[ 1, 2 ]` and `Uint8Array(2) [ 1, 2 ]`: one layout, which is Node's own -- formatList is
 * reached for every array-like, with `label` (empty for an array) in front of the bracket and
 * counted in the line budget the way braces[0] is. `abbrev` is what prints past the depth cap. */
static void inspect_list(JSRTBuf *out, jsrt_value v, uint32_t length,
                         jsrt_value (*element)(jsrt_value, uint32_t), const char *label,
                         const char *abbrev, int recurse, size_t indent) {
  const JSRTArray *a = jsrt_is(v, JSRT_TAG_ARRAY) ? jsrt_as_array(v) : NULL;
  const size_t shown = length > INSPECT_MAX_ARRAY ? INSPECT_MAX_ARRAY : length;
  /* A RegExp match is an array with NAMED properties, and Node prints them after the elements:
   * `[ 'a', index: 0, input: 'a', groups: undefined ]`. Every other array has none, so this is
   * zero and nothing below it changes. */
  const size_t props = a != NULL ? jsrt_shape_property_count(a->shape) : 0;

  /* Emptiness first: Node prints an empty container in full past the depth cap
   * (`[[[[]]]]` is `[ [ [ [] ] ] ]`), abbreviating only the non-empty ones. */
  if (length + props == 0 || recurse > INSPECT_MAX_DEPTH) {
    jsrt_buf_puts(out, length + props == 0 ? label : abbrev);
    if (length + props == 0) {
      jsrt_buf_puts(out, "[]");
    }
    return;
  }

  /* Node's formatArray, and formatSpecialArray once a hole is met: at most `shown` entries, where
   * a run of holes between two elements is ONE entry (`<2 empty items>`), a trailing run is one
   * more when there is room, and whatever the budget did not reach is "... n more items". */
  JSRTBuf *entries = alloc_entries(shown + 1 + props);
  size_t count = 0;
  uint32_t index = 0;
  char hole_text[64];
  while (index < length && count < shown) {
    if (a != NULL && a->elements[index] == JSRT_HOLE) {
      uint32_t next = index;
      while (next < length && a->elements[next] == JSRT_HOLE) {
        next++;
      }
      if (next == length) {
        break;
      }
      snprintf(hole_text, sizeof hole_text, "<%u empty item%s>", next - index,
               next - index > 1 ? "s" : "");
      jsrt_buf_init(&entries[count]);
      jsrt_buf_puts(&entries[count++], hole_text);
      index = next;
      if (count == shown) {
        break;
      }
    }
    jsrt_buf_init(&entries[count]);
    /* Elements are rendered two columns deeper: that indent is what a multi-line layout uses,
     * and it also shortens the budget a nested array has before it breaks. */
    inspect_value(&entries[count++], element(v, index), recurse + 1, indent + 2);
    index++;
  }
  const uint32_t remaining = length - index;
  bool truncated = false;
  if (count != shown) {
    if (remaining > 0) {
      snprintf(hole_text, sizeof hole_text, "<%u empty item%s>", remaining,
               remaining > 1 ? "s" : "");
      jsrt_buf_init(&entries[count]);
      jsrt_buf_puts(&entries[count++], hole_text);
    }
  } else if (remaining > 0) {
    init_more_entry(&entries[count++], remaining);
    truncated = true;
  }
  const size_t listed = truncated ? count - 1 : count;
  if (props > 0) {
    const JSRTShape **links = jsrt_shape_property_order(a->shape, (uint32_t)props);
    for (size_t i = 0; i < props; i++) {
      JSRTBuf *entry = &entries[count++];
      jsrt_buf_init(entry);
      append_key(entry, links[i]->key);
      jsrt_buf_puts(entry, ": ");
      inspect_value(entry, a->slots[links[i]->offset], recurse + 1, indent + 2);
    }
    free(links);
  }

  /* Grouping is attempted first, because whether it fired decides the layout below: if it changed
   * the number of lines, the single-line form is not even considered. Node right-aligns only when
   * `value[i]` is a number for every i below the entry count -- read by INDEX, so a hole (or an
   * index past the end) is not a number and left-aligns the whole block. */
  JSRTBuf *rows = NULL;
  size_t row_count = 0;
  if (count > 6 && props == 0) {
    bool all_numbers = true;
    for (size_t i = 0; i < count && all_numbers; i++) {
      all_numbers = i < length && (a == NULL || a->elements[i] != JSRT_HOLE) &&
                    jsrt_is_number(element(v, (uint32_t)i));
    }
    rows = alloc_entries(count);
    row_count = group_entries(entries, listed, count, indent, all_numbers, rows);
    if (row_count > 0 && truncated) {
      jsrt_buf_init(&rows[row_count]);
      jsrt_buf_append(&rows[row_count], entries[listed].data, entries[listed].len);
      row_count++;
    }
  }

  const JSRTBuf *lines = row_count > 0 ? rows : entries;
  const size_t line_count = row_count > 0 ? row_count : count;

  jsrt_buf_puts(out, label);
  if (row_count == 0 && fits_one_line(entries, count, indent, strlen(label) + 1 /* "[" */)) {
    join_one_line(out, "[ ", " ]", entries, count);
  } else {
    join_multi_line(out, "[\n", ']', lines, line_count, indent);
  }

  free_entries(entries, count);
  if (rows != NULL) {
    free_entries(rows, row_count);
  }
}

static void inspect_array(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  inspect_list(out, v, jsrt_as_array(v)->length, array_element, "", "[Array]", recurse, indent);
}

static void inspect_uint8array(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const uint32_t length = (uint32_t)jsrt_number_value(jsrt_uint8array_length(v));
  char label[48];
  snprintf(label, sizeof label, "Uint8Array(%u) ", length);
  inspect_list(out, v, length, uint8array_element, label, "[Uint8Array]", recurse, indent);
}

/* `ArrayBuffer { [Uint8Contents]: <00 ff>, [byteLength]: 2 }` -- Node's formatArrayBuffer: the
 * first INSPECT_MAX_ARRAY bytes as two-digit lowercase hex, then `... N more byte(s)`. Past the
 * depth cap it is `[ArrayBuffer]` even when empty: the abbreviation is decided before the bytes
 * are looked at, unlike an array's. */
static void inspect_arraybuffer(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  if (recurse > INSPECT_MAX_DEPTH) {
    jsrt_buf_puts(out, "[ArrayBuffer]");
    return;
  }
  const JSRTArrayBuffer *b = (const JSRTArrayBuffer *)jsrt_ptr(v);
  const size_t shown = b->byte_length > INSPECT_MAX_ARRAY ? INSPECT_MAX_ARRAY : b->byte_length;
  JSRTBuf *entries = alloc_entries(2);
  jsrt_buf_init(&entries[0]);
  jsrt_buf_puts(&entries[0], "[Uint8Contents]: <");
  for (size_t i = 0; i < shown; i++) {
    char hex[4];
    snprintf(hex, sizeof hex, i == 0 ? "%02x" : " %02x", b->data[i]);
    jsrt_buf_puts(&entries[0], hex);
  }
  if (b->byte_length > shown) {
    char more[64];
    const size_t remaining = b->byte_length - shown;
    snprintf(more, sizeof more, " ... %zu more byte%s", remaining, remaining == 1 ? "" : "s");
    jsrt_buf_puts(&entries[0], more);
  }
  jsrt_buf_putc(&entries[0], '>');
  jsrt_buf_init(&entries[1]);
  jsrt_buf_puts(&entries[1], "[byteLength]: ");
  inspect_value(&entries[1], jsrt_number((double)b->byte_length), recurse + 1, indent + 2);
  jsrt_buf_puts(out, "ArrayBuffer ");
  emit_braced(out, entries, 2, indent, strlen("ArrayBuffer") + 1 /* the space */ + 1 /* "{" */);
}

/* `Name { field: value, … }`.
 *
 * Structurally this is inspect_array with three differences, each of them a real rule rather than a
 * cosmetic one: the class name prints in front and counts toward the line budget; entries are
 * `name: value` rather than bare values; and there is NO grouping -- Node's groupArrayElements is
 * reached only for array-like output, so eight fields print as eight lines where eight numbers
 * would print as a grid.
 *
 * Field names are emitted bare. Node quotes a key that is not a valid identifier (`{ 'a-b': 1 }`),
 * but a class field's name is an identifier by construction, so the case cannot arise here; it
 * arrives with object literals, which can spell any key. */
/* A dynamic object's key prints bare only when it is a valid identifier; Node quotes the rest
 * (`{ 'a-b': 1 }`), choosing the quote by the same rule strings use. Class fields never take this
 * path -- their names are identifiers by construction. */
static bool key_is_identifier(const char *key) {
  if (key[0] == '\0') {
    return false;
  }
  for (size_t i = 0; key[i] != '\0'; i++) {
    const char c = key[i];
    const bool alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$';
    if (!alpha && (i == 0 || c < '0' || c > '9')) {
      return false;
    }
  }
  return true;
}

static void append_key(JSRTBuf *out, const char *key) {
  if (key_is_identifier(key)) {
    jsrt_buf_puts(out, key);
    return;
  }
  bool has_single = false;
  bool has_double = false;
  bool has_backtick = false;
  for (size_t i = 0; key[i] != '\0'; i++) {
    has_single = has_single || key[i] == '\'';
    has_double = has_double || key[i] == '"';
    has_backtick = has_backtick || key[i] == '`';
  }
  const char quote = choose_quote(has_single, has_double, has_backtick);
  jsrt_buf_putc(out, quote);
  /* Keys arrive as NUL-terminated bytes (WTF-8: a lone surrogate is its 3-byte ED A0-BF 80-BF
   * form), so this walk decodes where append_quoted reads code units. The escape set is the
   * same one -- short escapes, "\x0B" for VT, "\xXX" for the other controls, "\uXXXX" for a
   * lone surrogate -- because Node quotes keys exactly the way it quotes strings. */
  for (size_t i = 0; key[i] != '\0';) {
    const unsigned char b = (unsigned char)key[i];
    if (b == 0xED && (unsigned char)key[i + 1] >= 0xA0 && (unsigned char)key[i + 1] <= 0xBF &&
        ((unsigned char)key[i + 2] & 0xC0) == 0x80) {
      const unsigned int cp = ((unsigned int)(b & 0x0F) << 12) |
                              ((unsigned int)((unsigned char)key[i + 1] & 0x3F) << 6) |
                              (unsigned int)((unsigned char)key[i + 2] & 0x3F);
      char esc[8];
      snprintf(esc, sizeof esc, "\\u%04x", cp);
      jsrt_buf_puts(out, esc);
      i += 3;
      continue;
    }
    if (append_quoted_escape(out, b, quote)) {
      i++;
      continue;
    }
    jsrt_buf_putc(out, (char)b);
    i++;
  }
  jsrt_buf_putc(out, quote);
}

/* Whether `v` is an instance of the function `ctor` for the printer: `jsrt_instanceof_ctor`'s
 * answer without its TypeError, which Node's own printer swallows the same way (an arrow found as
 * a `constructor` simply does not name the object). */
static bool printer_instanceof(jsrt_value v, jsrt_value ctor) {
  const JSRTClosure *c = jsrt_as_closure(ctor);
  if (c->klass != NULL) {
    return jsrt_instanceof(v, c->klass);
  }
  const jsrt_value proto = jsrt_function_prototype(ctor);
  if (!jsrt_is_object(proto)) {
    return false;
  }
  for (jsrt_value p = v; jsrt_is_dynobj(p);) {
    p = ((const JSRTDynObject *)jsrt_ptr(p))->proto;
    if (p == proto) {
      return true;
    }
  }
  return false;
}

/* The constructor name Node prints in front of a dynamic object (util.inspect's
 * getConstructorName, plan-notes 310): the first object on the chain -- the value itself first --
 * whose own `constructor` is a named function the value is an instance of. `new F()` prints
 * `F { x: 1 }`; a literal, and `F.prototype` itself (which is not an instance of F), reach
 * %Object.prototype% and print bare, which NULL means. A class instance on the chain names its
 * class, exactly as its own `constructor` would. */
static const char *dynobj_constructor_name(jsrt_value v) {
  for (jsrt_value p = v; p != 0;) {
    if (!jsrt_is_dynobj(p)) {
      if (jsrt_is(p, JSRT_TAG_OBJECT) && jsrt_as_object(p)->cls->name[0] != '\0') {
        return jsrt_as_object(p)->cls->name;
      }
      return NULL;
    }
    const JSRTDynObject *o = (const JSRTDynObject *)jsrt_ptr(p);
    jsrt_value ctor = o->ctor;
    if (ctor == 0) {
      const JSRTShape *hit = jsrt_shape_find(o->shape, "constructor");
      ctor = hit == NULL ? 0 : o->slots[hit->offset];
    }
    if (jsrt_is(ctor, JSRT_TAG_CLOSURE) && jsrt_as_closure(ctor)->name[0] != '\0' &&
        printer_instanceof(v, ctor)) {
      return jsrt_as_closure(ctor)->name;
    }
    p = o->proto;
  }
  return NULL;
}

/* One `key: value` entry per own property of a dynamic object, in OrdinaryOwnPropertyKeys order
 * (integer indices first, then insertion order). Shared by plain objects and by a function's own
 * properties, which Node lays out the same way. */
/* A shape table's `count` properties, in insertion order, into `entries[0..count)`: a dynamic
 * object's whole body, and a fixed object's overflow table after its declared fields. */
static void fill_dyn_entries(JSRTBuf *entries, const JSRTDynObject *dyn, size_t count, int recurse,
                             size_t indent) {
  const JSRTShape **links = jsrt_shape_property_order(dyn->shape, (uint32_t)count);
  for (size_t i = 0; i < count; i++) {
    JSRTBuf *entry = &entries[i];
    jsrt_buf_init(entry);
    append_key(entry, links[i]->key);
    jsrt_buf_puts(entry, ": ");
    inspect_value(entry, dyn->slots[links[i]->offset], recurse + 1, indent + 2);
  }
  free(links);
}

static JSRTBuf *dyn_entries(const JSRTDynObject *dyn, size_t count, int recurse, size_t indent) {
  JSRTBuf *entries = alloc_entries(count);
  fill_dyn_entries(entries, dyn, count, recurse, indent);
  return entries;
}

static void inspect_object(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const JSRTObject *o = jsrt_as_object(v);
  const JSRTClass *cls = o->cls;

  /* A boxed iterator is a cursor, not a record: Node prints the matchAll iterator's tag rather
   * than its class (`Object [RegExp String Iterator] {}`, plan.md §8 step 30 A15). The other
   * iterator kinds keep `Iterator {}`; their remaining-contents form is not this step. */
  if (cls == &jsrt_class_iterator) {
    const JSRTIterator *it = (const JSRTIterator *)o;
    jsrt_buf_puts(out, it->kind == JSRT_ITER_MATCH_ALL ? "Object [RegExp String Iterator] {}"
                                                  : "Iterator {}");
    return;
  }

  /* A DYNAMIC object's layout lives in its shape, not its class: keys come from the shape chain,
   * values from the out-of-line slots, and insertion order is the chain reversed. Everything
   * below the collection step -- entries, budget, line breaking -- is shared with fixed-shape
   * objects, which is the point: the two print identically because Node cannot tell them apart. */
  const JSRTDynObject *dyn = jsrt_is_dynobj(v) ? (const JSRTDynObject *)o : NULL;

  /* An object LITERAL has no constructor name, and Node prints none: `{ x: 1 }`, not `Object
   * { x: 1 }`. Its descriptor carries the empty name, which is unambiguous -- no class may be
   * called "" -- and every place the name would print becomes a place it does not. A dynamic
   * object is a plain object and prints namelessly for the same reason. */
  /* The null-prototype object §22.2.7.2 builds for `groups` prints Node's marker where a class name
   * would go -- `[Object: null prototype] { w: 'a' }` -- and it counts toward the line budget the
   * same way. Every other nameless object (a literal, a plain dynamic object) still prints bare. */
  const char *const name = cls == &jsrt_class_null_proto  ? "[Object: null prototype]"
                           : cls->name[0] != '\0'         ? cls->name
                           : dyn != NULL                  ? dynobj_constructor_name(v)
                                                          : NULL;
  const bool named = name != NULL;

  /* A `#private` field HAS a slot -- it is on the instance like any other field -- but
   * `util.inspect` does not show it, so neither does this. The '#' filter lives in
   * jsrt_fixed_key_order, which print and reflection share; what the walk below reads is already
   * the visible slots, in enumeration order. */
  size_t count = 0;
  /* The fixed walk partitions the descriptor the same way Object.keys does (integer indices
   * first, then insertion order -- plan.md §8 step 28), so console.log and the keys walk cannot
   * disagree. `#private` slots never enter either order. */
  uint32_t *fixed_order = NULL;
  /* A fixed object's undeclared properties print after its declared ones (docs/VALUE.md §4.24). */
  const JSRTDynObject *extras = dyn != NULL ? NULL : jsrt_fixed_extras(v);
  const size_t extras_count = extras != NULL ? jsrt_shape_property_count(extras->shape) : 0;
  if (dyn != NULL) {
    count = jsrt_shape_property_count(dyn->shape);
  } else {
    uint32_t fixed_count = 0;
    fixed_order = jsrt_fixed_key_order(cls, &fixed_count);
    count = fixed_count + extras_count;
  }

  /* Emptiness first, like inspect_array: Node prints `{}` and `C {}` in full past the depth cap
   * (plan.md §8 step 30 A11), abbreviating only the non-empty ones below. */
  if (count == 0) {
    free(fixed_order);
    if (named) {
      jsrt_buf_puts(out, name);
      jsrt_buf_putc(out, ' ');
    }
    jsrt_buf_puts(out, "{}");
    return;
  }

  if (recurse > INSPECT_MAX_DEPTH) {
    /* `[Deep]`, not `[Object]`: past the cap Node still names the constructor it stopped at --
     * and for a literal, which has no constructor, that name IS `Object`. */
    free(fixed_order);
    jsrt_buf_putc(out, '[');
    jsrt_buf_puts(out, named ? name : "Object");
    jsrt_buf_putc(out, ']');
    return;
  }

  JSRTBuf *entries = NULL;
  if (dyn != NULL) {
    entries = dyn_entries(dyn, count, recurse, indent);
  } else {
    entries = alloc_entries(count);
    size_t next = 0;
    /* fixed_order holds exactly the visible slots in enumeration order, so this loop runs once per
     * declared key with no skips, and the overflow table fills the rest -- `next` plus the
     * table's count and `count` agree at emit_braced. */
    for (size_t i = 0; i < count - extras_count; i++) {
      /* Enumeration order, not slot order: integer indices first, then the insertion sequence
       * the layout's key_order records (jsrt_value.h, JSRTClass::key_order). */
      const uint32_t slot = fixed_order[i];
      JSRTBuf *entry = &entries[next++];
      jsrt_buf_init(entry);
      /* A class field's name is an identifier by construction, but an object literal's is only a
       * key: `{ "a-b": 1 }` has a fixed layout and a name no identifier could spell, and
       * `util.inspect` quotes exactly that. Same helper the dynamic path uses, so one rule
       * decides quoting for both. */
      append_key(entry, cls->fields[slot]);
      jsrt_buf_puts(entry, ": ");
      inspect_value(entry, o->fields[slot], recurse + 1, indent + 2);
    }
    if (extras != NULL) {
      fill_dyn_entries(&entries[next], extras, extras_count, recurse, indent);
    }
    free(fixed_order);
  }

  /* The name and the space after it are part of the prefix Node measures, along with the `{`. A
   * literal contributes neither, so its budget is one character wider. */
  const size_t prefix = named ? strlen(name) + 1 /* the space */ + 1 : 1 /* "{" */;
  if (named) {
    jsrt_buf_puts(out, name);
    jsrt_buf_putc(out, ' ');
  }
  emit_braced(out, entries, count, indent, prefix);
}

/* `Map(2) { 'a' => 1, 'b' => 2 }` and `Set(2) { 1, 2 }`.
 *
 * Laid out like an object, not like an array: the size goes in front and counts toward the line
 * budget the way a class name does, and there is NO grouping, because Node reaches
 * groupArrayElements only for array-like output. A Set of eight numbers therefore prints as eight
 * lines where an ARRAY of eight numbers prints as a grid — the one place the two look different for
 * the same contents.
 *
 * Entries print in insertion order because that is what the structure stores; the dead ones a
 * deletion left behind are skipped here exactly as they are skipped by a lookup. */
static void inspect_map(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const JSRTMap *m = jsrt_as_map(v);
  /* Node's formatWeakCollection: a weak collection's entries are never shown, so neither is a
   * count -- `WeakMap { <items unknown> }`, or `[WeakMap]` past the depth cap. */
  if (m->cls == &jsrt_class_weakmap || m->cls == &jsrt_class_weakset) {
    jsrt_buf_puts(out, recurse > INSPECT_MAX_DEPTH ? "[" : "");
    jsrt_buf_puts(out, m->cls->name);
    jsrt_buf_puts(out, recurse > INSPECT_MAX_DEPTH ? "]" : " { <items unknown> }");
    return;
  }
  const bool is_map = m->cls == &jsrt_class_map;

  char base[32];
  snprintf(base, sizeof base, "%s(%u)", m->cls->name, m->size);

  /* Emptiness first, like inspect_array: Node prints `Map(0) {}` in full past the depth cap
   * (plan.md §8 step 30 A11), abbreviating only the non-empty ones below. */
  if (m->size == 0) {
    jsrt_buf_puts(out, base);
    jsrt_buf_putc(out, ' ');
    jsrt_buf_puts(out, "{}");
    return;
  }

  if (recurse > INSPECT_MAX_DEPTH) {
    jsrt_buf_puts(out, is_map ? "[Map]" : "[Set]");
    return;
  }

  jsrt_buf_puts(out, base);
  jsrt_buf_putc(out, ' ');

  const size_t shown = m->size > INSPECT_MAX_ARRAY ? INSPECT_MAX_ARRAY : m->size;
  const bool truncated = m->size > shown;
  const size_t count = shown + (truncated ? 1 : 0);

  JSRTBuf *entries = alloc_entries(count);
  size_t next = 0;
  for (uint32_t i = 0; i < m->used && next < shown; i++) {
    if (!m->entries[i].live) {
      continue;
    }
    JSRTBuf *entry = &entries[next++];
    jsrt_buf_init(entry);
    inspect_value(entry, m->entries[i].key, recurse + 1, indent + 2);
    if (is_map) {
      jsrt_buf_puts(entry, " => ");
      inspect_value(entry, m->entries[i].value, recurse + 1, indent + 2);
    }
  }
  if (truncated) {
    init_more_entry(&entries[shown], m->size - (uint32_t)shown);
  }

  /* The `Map(2)` and the space in front of it are Node's `base`, measured with the brace. */
  const size_t prefix = strlen(base) + 1 + 1;
  emit_braced(out, entries, count, indent, prefix);
}

/* `/source/flags` -- the literal a program would have written, which is what Node prints both at
 * the top level and inside a structure, and without quotes in either place. The source is already
 * in its escaped form: `jsrt_regexp_new` stores what it was given, and the one value that has no
 * spelling as a literal -- the empty pattern -- is normalized to `(?:)` there. */
static void inspect_regexp(JSRTBuf *out, jsrt_value v) {
  const JSRTRegExp *re = jsrt_as_regexp(v);
  jsrt_buf_putc(out, '/');
  append_string(out, (const JSString *)jsrt_ptr(re->source));
  jsrt_buf_putc(out, '/');
  append_string(out, (const JSString *)jsrt_ptr(re->flags));
}

static void inspect_value(JSRTBuf *out, jsrt_value v, int recurse, size_t indent);

/* `Promise { 42 }`, `Promise { <pending> }`, `Promise { <rejected> 'boom' }`. The settled value
 * is inspected, not printed bare -- a fulfilled string shows its quotes, exactly as it does inside
 * an array -- and the two angle-bracket forms are Node's own markers, not values. */
static void inspect_promise(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const JSRTPromise *p = jsrt_as_promise(v);
  jsrt_buf_puts(out, "Promise { ");
  if (p->state == JSRT_PROMISE_PENDING) {
    jsrt_buf_puts(out, "<pending>");
  } else {
    if (p->state == JSRT_PROMISE_REJECTED) {
      jsrt_buf_puts(out, "<rejected> ");
    }
    inspect_value(out, p->value, recurse + 1, indent);
  }
  jsrt_buf_puts(out, " }");
}

/* Node prints a Date as its ISO string with NO quotes, at top level and nested alike --
 * `console.log(d)` is `2024-02-29T13:45:06.789Z` and `console.log([d])` is
 * `[ 2024-02-29T13:45:06.789Z ]`. An Invalid Date prints `Invalid Date`, which is why this cannot
 * simply call `jsrt_date_to_iso_string` (that one panics, per the spec's RangeError). */
static void inspect_date(JSRTBuf *out, jsrt_value v) {
  const jsrt_value text = jsrt_date_to_json(v);
  if (text == JSRT_NULL) {
    jsrt_buf_puts(out, "Invalid Date");
    return;
  }
  append_string(out, (const JSString *)jsrt_ptr(text));
}

/* `label { entries }` for a class object's statics and a function's own properties. The label and
 * the space after it are part of the prefix Node measures, along with the `{` -- the same
 * accounting a named instance's class name gets. */
static void emit_labeled(JSRTBuf *out, const char *label, JSRTBuf *entries, size_t count,
                         size_t indent) {
  jsrt_buf_puts(out, label);
  jsrt_buf_putc(out, ' ');
  emit_braced(out, entries, count, indent, strlen(label) + 1 /* the space */ + 1 /* "{" */);
}

/* `[class Point] { count: 0 }` -- a class object (docs/VALUE.md §4.17).
 *
 * The label names the class and, past a base, what it extends; Node then shows the class's OWN
 * data statics (never inherited ones, never a method or accessor) as `name: value` entries in
 * declaration order, breaking onto one entry per line exactly like an object when the line
 * budget does not hold. A class with no data statics prints its label alone -- no braces at
 * all, which is where Node's empty-object rules stop applying here. */
static void inspect_class(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const JSRTClosure *c = jsrt_as_closure(v);
  const char *name = c->name[0] != '\0' ? c->name : "(anonymous)";
  char label[256];
  const JSRTClass *base = c->klass == NULL ? NULL : c->klass->parent;
  if (base != NULL && base->name[0] != '\0') {
    snprintf(label, sizeof label, "[class %s extends %s]", name, base->name);
  } else {
    snprintf(label, sizeof label, "[class %s]", name);
  }

  size_t count = 0;
  if (c->klass != NULL && c->klass->statics != NULL) {
    for (const JSRTStaticEntry *e = c->klass->statics; e->name != NULL; e++) {
      if (e->kind == JSRT_STATIC_FIELD) {
        count++;
      }
    }
  }
  if (count == 0) {
    jsrt_buf_puts(out, label);
    return;
  }
  if (recurse > INSPECT_MAX_DEPTH) {
    jsrt_buf_puts(out, label);
    return;
  }

  JSRTBuf *entries = alloc_entries(count);
  size_t next = 0;
  for (const JSRTStaticEntry *e = c->klass->statics; e->name != NULL; e++) {
    if (e->kind != JSRT_STATIC_FIELD) {
      continue;
    }
    JSRTBuf *entry = &entries[next++];
    jsrt_buf_init(entry);
    append_key(entry, e->name);
    jsrt_buf_puts(entry, ": ");
    inspect_value(entry, *e->slot, recurse + 1, indent + 2);
  }
  emit_labeled(out, label, entries, count, indent);
}

/* Whether `v` is an ordinary function carrying own properties, which print after its label. */
static bool has_own_props(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_CLOSURE) && jsrt_as_closure(v)->props != NULL &&
         jsrt_shape_property_count(jsrt_as_closure(v)->props->shape) > 0;
}

/* A function with own properties (plan-notes 310): `[Function: f] { count: 1 }`, laid out like a
 * class object's statics -- the label and its space count toward the line budget with the `{`.
 * Past the depth cap Node names only what it is, `[Function]`. A function with none prints its
 * label alone through inspect_scalar. */
static void inspect_function(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  const JSRTClosure *c = jsrt_as_closure(v);
  const size_t count = jsrt_shape_property_count(c->props->shape);
  if (recurse > INSPECT_MAX_DEPTH) {
    jsrt_buf_puts(out, "[Function]");
    return;
  }
  char label[256];
  if (c->name[0] == '\0') {
    snprintf(label, sizeof label, "[Function (anonymous)]");
  } else {
    snprintf(label, sizeof label, "[Function: %s]", c->name);
  }
  emit_labeled(out, label, dyn_entries(c->props, count, recurse, indent), count, indent);
}

/* Every heap value with a printer of its own, in the order the tests must run (a builtin object
 * before the generic TAG_OBJECT walk). False for a scalar or a closure, which the callers print
 * differently: inspect_value quotes a string, console.log's top level does not. */
static bool inspect_heap(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  /* The typed-array classes first: like every class below they are TAG_OBJECT pointers, and the
   * classes are disjoint, so only the generic object walk has to come after them. */
  if (jsrt_is_uint8array(v) || jsrt_is_arraybuffer(v)) {
    (jsrt_is_uint8array(v) ? inspect_uint8array : inspect_arraybuffer)(out, v, recurse, indent);
    return true;
  }
  if (jsrt_is_date(v)) {
    inspect_date(out, v);
  } else if (jsrt_is_regexp(v)) {
    inspect_regexp(out, v);
  } else if (jsrt_is_promise(v)) {
    inspect_promise(out, v, recurse, indent);
  } else if (jsrt_is_map_or_set(v)) {
    inspect_map(out, v, recurse, indent);
  } else if (jsrt_is(v, JSRT_TAG_OBJECT)) {
    inspect_object(out, v, recurse, indent);
  } else if (jsrt_is(v, JSRT_TAG_ARRAY)) {
    inspect_array(out, v, recurse, indent);
  } else {
    return false;
  }
  return true;
}

static void inspect_value(JSRTBuf *out, jsrt_value v, int recurse, size_t indent) {
  /* An accessor cell is a SLOT value, never a value the language can hold, so this is the one
   * place it can surface -- and util.inspect never calls a getter to print it. Node writes what
   * the descriptor has, not what it would return. */
  if (jsrt_is_accessor_cell(v)) {
    const JSRTAccessorCell *cell = (const JSRTAccessorCell *)jsrt_ptr(v);
    const bool has_get = cell->get != JSRT_UNDEFINED;
    jsrt_buf_puts(out, has_get ? (cell->set != JSRT_UNDEFINED ? "[Getter/Setter]" : "[Getter]")
                          : "[Setter]");
    return;
  }
  /* A class object prints `[class …]`, not the `[Function: …]` every other closure gets. */
  if (jsrt_is(v, JSRT_TAG_CLOSURE) && jsrt_as_closure(v)->klass != NULL) {
    inspect_class(out, v, recurse, indent);
    return;
  }
  if (has_own_props(v)) {
    inspect_function(out, v, recurse, indent);
    return;
  }
  if (!inspect_heap(out, v, recurse, indent)) {
    inspect_scalar(out, v, true);
  }
}

/* ============================================================================
 * Public
 * ============================================================================ */

/* console.group's indentation, in GROUPS -- Node writes two spaces per level in front of every
 * line of every console write, including each line of a multi-line inspect. One counter for the
 * whole program: console has one output state, and the subset has no second console. */
static size_t group_depth = 0;

/* Write `text` with the group indent in front of every line. The text always ends in the newline
 * its writer appended, and Node does NOT indent past that final newline -- a blank line stays
 * blank -- so the prefix goes before each line that has content. */
static void write_grouped(const char *text, size_t len, FILE *stream) {
  if (group_depth == 0) {
    fwrite(text, 1, len, stream);
    return;
  }
  size_t line = 0;
  for (size_t i = 0; i < len; i++) {
    if (text[i] != '\n') {
      continue;
    }
    for (size_t g = 0; g < group_depth; g++) {
      fwrite("  ", 1, 2, stream);
    }
    fwrite(text + line, 1, i + 1 - line, stream);
    line = i + 1;
  }
  if (line < len) {
    for (size_t g = 0; g < group_depth; g++) {
      fwrite("  ", 1, 2, stream);
    }
    fwrite(text + line, 1, len - line, stream);
  }
}

/* `bare` is console.log's one exception to inspect form: a top-level string prints WITHOUT
 * quotes, so `console.log("a")` is `a` while `console.log(["a"])` is `[ 'a' ]`. console.dir has
 * no such exception -- it inspects whatever it is given, which is the whole difference between
 * the two entry points. */
static void print_one(JSRTBuf *out, jsrt_value v, bool bare) {
  if (has_own_props(v)) {
    inspect_function(out, v, 0, 0);
  } else if (!inspect_heap(out, v, 0, 0)) {
    inspect_scalar(out, v, !bare);
  }
}

static void print_to(jsrt_value v, FILE *stream, bool bare) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  print_one(&out, v, bare);
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stream);
  jsrt_buf_free(&out);
}

void jsrt_print(jsrt_value v) { print_to(v, stdout, true); }

/* console.error / console.warn: the same inspect form, on stderr -- Node's own split, which is
 * why the golden runner compares BOTH streams byte-for-byte. */
void jsrt_eprint(jsrt_value v) { print_to(v, stderr, true); }

/* ============================================================================
 * util.format -- console.log's placeholders (plan.md §9 Task 6.24)
 *
 * Node's console methods run every call through `formatWithOptionsInternal`
 * (lib/internal/util/inspect.js, v26.7.0; plan-notes 337). When the first of two or more
 * arguments is a string, `%s %d %i %f %j %o %O %c` each consume the next argument and `%%` is a
 * literal `%`. The loop below is that function's loop, statement for statement, because its edge
 * cases ARE the semantics: a `%` in the last position is literal, an exhausted argument list
 * leaves every placeholder but `%%` as written, and an unknown letter after `%` is skipped.
 * ============================================================================ */

static void json_format(JSRTBuf *out, jsrt_value v);

/* `builtInObjects` as the pinned Node records it when inspect.js is evaluated into the startup
 * snapshot: the capitalized own properties of `globalThis` at that moment, so the web globals
 * installed later (`Event`, `URL`, `Buffer`, ...) are NOT in it. Measured on v26.7.0 by asking
 * util.format('%s') of a class named after each global (plan-notes 345); `to-primitive.test.ts`
 * re-measures it. A binary built without the snapshot (the official win-arm64 package is
 * cross-compiled, so `node_use_node_snapshot` is false) evaluates inspect.js later and treats
 * seven more names as builtins. Those are not this list: the oracle is the snapshot set
 * (plan-notes 354). */
static const char *const BUILTIN_CONSTRUCTOR_NAMES[] = {
    "AggregateError", "Array",          "ArrayBuffer",    "Atomics",
    "BigInt",         "BigInt64Array",  "BigUint64Array", "Boolean",
    "DataView",       "Date",           "Error",          "EvalError",
    "FinalizationRegistry",             "Float32Array",   "Float64Array",
    "Function",       "Infinity",       "Int16Array",     "Int32Array",
    "Int8Array",      "Intl",           "Iterator",       "JSON",
    "Map",            "Math",           "NaN",            "Number",
    "Object",         "Promise",        "Proxy",          "RangeError",
    "ReferenceError", "Reflect",        "RegExp",         "Set",
    "String",         "Symbol",         "SyntaxError",    "TypeError",
    "URIError",       "Uint16Array",    "Uint32Array",    "Uint8Array",
    "Uint8ClampedArray",                "WeakMap",        "WeakRef",
    "WeakSet",
};

bool jsrt_is_builtin_constructor_name(const char *name) {
  for (size_t i = 0; i < sizeof BUILTIN_CONSTRUCTOR_NAMES / sizeof BUILTIN_CONSTRUCTOR_NAMES[0];
       i++) {
    if (strcmp(BUILTIN_CONSTRUCTOR_NAMES[i], name) == 0) {
      return true;
    }
  }
  return false;
}

static _Noreturn void format_refused(const char *what);

/* Node's `hasBuiltInToString` (inspect.js line 2707): an object whose `toString` is not callable
 * counts as builtin, an OWN one does not, and an inherited one is builtin exactly when the
 * prototype holding it has a `constructor` named in `builtInObjects`. A miss on everything the
 * program wrote leaves %Object.prototype%'s (or another builtin prototype's) method, which is
 * builtin. No object here can carry `Symbol.toPrimitive` (STA1212), so that half is absent. A
 * getter on `toString` that throws leaves the exception pending and answers true; the caller
 * checks before printing. */
static bool has_builtin_to_string(jsrt_value v) {
  jsrt_value method = JSRT_UNDEFINED;
  const char *holder = NULL;
  bool exact = true;
  if (!jsrt_user_get(v, "toString", &method, &holder, &exact) || jsrt_pending() ||
      !jsrt_is(method, JSRT_TAG_CLOSURE)) {
    return true;
  }
  if (holder == NULL) {
    return false;
  }
  const bool builtin = jsrt_is_builtin_constructor_name(holder);
  if (builtin && !exact) {
    format_refused("%s of an object whose toString may belong to a class named like a builtin");
  }
  return builtin;
}

static _Noreturn void format_refused(const char *what) {
  char message[192];
  snprintf(message, sizeof message,
           "STA2005: console.log %s is not yet supported; Node's util.format would print what "
           "this binary cannot reproduce",
           what);
  jsrt_panic(message);
}

/* `formatNumberNoColor`: the number's own string, with -0 kept visible. */
static void format_number(JSRTBuf *out, double d) {
  char buf[64];
  format_double(d, buf, sizeof buf, true);
  jsrt_buf_puts(out, buf);
}

/* One placeholder applied to one argument. The comments name Node's arm for each. */
static void format_one(JSRTBuf *out, uint16_t spec, jsrt_value v) {
  switch (spec) {
  case 's':
    /* number: formatNumber. A function: String(fn), its SOURCE TEXT, which no binary carries
     * (jsrt_to_string's known ceiling). Another primitive: String(v). An object whose toString is
     * a builtin: inspect at depth 0 -- here, the inspect walk entered at the depth cap. Any other
     * object: String(v), which runs the program's toString and may throw. */
    if (jsrt_is_number(v)) {
      format_number(out, jsrt_number_value(v));
    } else if (jsrt_is(v, JSRT_TAG_CLOSURE)) {
      format_refused("%s of a function");
    } else if (!jsrt_is_object(v)) {
      inspect_scalar(out, v, false);
    } else if (!has_builtin_to_string(v)) {
      const jsrt_value text = jsrt_to_string(v);
      if (!jsrt_pending()) {
        append_string(out, (const JSString *)jsrt_ptr(text));
      }
    } else if (!jsrt_pending()) {
      inspect_value(out, v, INSPECT_MAX_DEPTH, 0);
    }
    return;
  case 'd':
  case 'i':
  case 'f':
    /* Number(v), parseInt(v), parseFloat(v): ToPrimitive runs the program's own valueOf or
     * toString on an object (hint number for `%d`, string for the other two), and may throw;
     * the caller checks before anything is written. */
    format_number(out, spec == 'd'   ? jsrt_to_number(v)
                       : spec == 'i' ? jsrt_number_value(jsrt_global_parse_int(v, JSRT_UNDEFINED))
                                     : jsrt_number_value(jsrt_global_parse_float(v)));
    return;
  case 'j':
    json_format(out, v);
    return;
  case 'O':
    inspect_value(out, v, 0, 0);
    return;
  case 'o':
    /* `{ showHidden: true, depth: 4 }`: identical to `%O` for a primitive, and different for
     * nearly every object (`[length]` on arrays, a function's own properties, the compact rule
     * once depth passes 2). The printer models neither option, so objects are refused. */
    if (jsrt_is_object(v)) {
      format_refused("%o of an object");
    }
    inspect_scalar(out, v, true);
    return;
  default: /* 'c': CSS is consumed and prints nothing */
    return;
  }
}

/* Writes the format string's expansion and answers the index of the first argument it did not
 * consume -- or 0 when nothing in it was a placeholder, in which case the string prints as an
 * ordinary first argument and nothing has been written. */
static uint32_t format_into(JSRTBuf *out, uint32_t count, const jsrt_value *args) {
  const JSString *first = (const JSString *)jsrt_ptr(args[0]);
  uint32_t a = 0;
  uint32_t last = 0;
  for (uint32_t i = 0; i + 1 < first->length; i++) {
    if (first->data[i] != '%') {
      continue;
    }
    const uint16_t next = first->data[++i];
    if (a + 1 != count) {
      switch (next) {
      case 's':
      case 'j':
      case 'd':
      case 'O':
      case 'o':
      case 'i':
      case 'f':
      case 'c':
        append_units(out, first, last, i - 1);
        format_one(out, next, args[++a]);
        if (jsrt_pending()) {
          return 0;
        }
        last = i + 1;
        break;
      case '%':
        append_units(out, first, last, i);
        last = i + 1;
        break;
      default:
        break;
      }
    } else if (next == '%') {
      append_units(out, first, last, i);
      last = i + 1;
    }
  }
  if (last == 0) {
    return 0;
  }
  append_units(out, first, last, first->length);
  return a + 1;
}

/* The variadic console form (plan.md §8 step 18): Node inspects every argument -- each one with
 * the bare-string exception -- and joins the forms with one space. No arguments prints the bare
 * newline, which is what `console.log()` is. One buffer for the whole line, so a multi-line
 * inspect still passes through `write_grouped` once and the group indent lands per line. */
static void print_many_to(uint32_t count, const jsrt_value *args, FILE *stream) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  uint32_t from = 0;
  if (count >= 2 && jsrt_is(args[0], JSRT_TAG_STRING)) {
    from = format_into(&out, count, args);
    /* A `%j` getter threw: Node's console.log throws before writing, so nothing is written. */
    if (jsrt_pending()) {
      jsrt_buf_free(&out);
      return;
    }
  }
  for (uint32_t i = from; i < count; i++) {
    if (i > 0) {
      jsrt_buf_putc(&out, ' ');
    }
    print_one(&out, args[i], true);
  }
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stream);
  jsrt_buf_free(&out);
}

void jsrt_print_many(uint32_t count, const jsrt_value *args) {
  print_many_to(count, args, stdout);
}

void jsrt_eprint_many(uint32_t count, const jsrt_value *args) {
  print_many_to(count, args, stderr);
}

/* console.dir: inspect form with no bare-string exception. */
void jsrt_console_dir(jsrt_value v) { print_to(v, stdout, false); }

/* console.group(label) prints the label at the CURRENT indent and then indents; the label-less
 * form prints nothing and only indents. console.groupEnd() outdents, and bottoms out at zero --
 * an unmatched groupEnd is a no-op in Node, not an error. */
void jsrt_console_group(jsrt_value label) {
  /* The label is PRINTED, undefined included: `console.group(undefined)` writes "undefined" where
   * `console.group()` writes nothing, so the two forms are two entry points rather than one with
   * a sentinel. */
  jsrt_print(label);
  group_depth++;
}

void jsrt_console_group_bare(void) { group_depth++; }

void jsrt_console_group_end(void) {
  if (group_depth > 0) {
    group_depth--;
  }
}

/* console.count's per-label tallies. A linked list rather than a hash: the labels a program
 * counts are a handful of literals, and a list keeps the keys immortal for free -- the same
 * lifetime rule shape keys follow, and for the same reason (the table only grows). */
typedef struct CountEntry {
  const char *label;
  uint32_t count;
  struct CountEntry *next;
} CountEntry;

static CountEntry *counts = NULL;

/* Pointer-or-content label comparison, shared by the count and timer table walks: labels are
 * immortal shape keys, so the pointer test usually hits and strcmp is the fallback. */
static bool labels_equal(const char *a, const char *b) {
  return a == b || strcmp(a, b) == 0;
}

/* The label as a C string. `console.count()` with no argument counts under "default", which is
 * the literal Node prints, not a placeholder. */
static const char *count_label(jsrt_value label) {
  return label == JSRT_UNDEFINED ? "default" : jsrt_shape_key(label);
}

static CountEntry *count_entry(const char *label) {
  for (CountEntry *e = counts; e != NULL; e = e->next) {
    if (labels_equal(e->label, label)) {
      return e;
    }
  }
  CountEntry *fresh = (CountEntry *)malloc(sizeof(CountEntry));
  if (fresh == NULL) {
    jsrt_panic("out of memory: console.count");
  }
  fresh->label = label;
  fresh->count = 0;
  fresh->next = counts;
  counts = fresh;
  return fresh;
}

/* Both entry points answer `undefined` -- console methods are void, and the emitter needs a
 * value-shaped result for the expression position a call sits in. */
static void count_print(const char *label, uint32_t count) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, label);
  jsrt_buf_puts(&out, ": ");
  char digits[16];
  snprintf(digits, sizeof digits, "%u", count);
  jsrt_buf_puts(&out, digits);
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stdout);
  jsrt_buf_free(&out);
}

jsrt_value jsrt_console_count(jsrt_value label) {
  const char *name = count_label(label);
  CountEntry *entry = count_entry(name);
  entry->count++;
  count_print(name, entry->count);
  return JSRT_UNDEFINED;
}

/* countReset zeroes the tally and prints nothing, which is Node's behaviour for a label that
 * exists; a label that does not exist warns in Node, and warning is a diagnostic this runtime
 * has no channel for -- so an unknown label simply starts at zero, which is what the next
 * `count` on it would have done anyway. */
jsrt_value jsrt_console_count_reset(jsrt_value label) {
  count_entry(count_label(label))->count = 0;
  return JSRT_UNDEFINED;
}

/* console.time / console.timeEnd / console.trace -- the three console members under the
 * DETERMINISM CARVE-OUT (plan.md §7 Task 4.2, plan-notes 116/124). Every other builtin is proved
 * by a golden test that diffs stdout against the pinned Node byte-for-byte. These three cannot be:
 * a duration is a measurement of THIS machine on THIS run, and a stack is frames this runtime does
 * not have. "Matches Node" is not a property they HAVE, so they land with a shape assertion
 * (tests/unit/console-carveout.test.ts) instead, and the dashboard marks them nondeterministic.
 *
 * What IS pinned, and what the proof asserts: the label is echoed, a duration follows it, the unit
 * is `ms` below a second, and a timer that was never started prints nothing at all. */

/* Per-label start times. The same linked list `console.count` uses, for the same reason: the
 * labels a program times are a handful of literals, and the list keeps the keys immortal. */
typedef struct TimerEntry {
  const char *label;
  double started_ms;
  bool running;
  struct TimerEntry *next;
} TimerEntry;

static TimerEntry *timers = NULL;

/* A MONOTONIC clock, not a wall clock: `console.time` measures elapsed time, and a wall clock can
 * step backwards under NTP, which would print a negative duration for a program that did nothing
 * wrong. CLOCK_MONOTONIC is POSIX and present on both platforms the runtime builds for. */
static double monotonic_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1.0e6;
}

static TimerEntry *timer_entry(const char *label, bool create) {
  for (TimerEntry *e = timers; e != NULL; e = e->next) {
    if (labels_equal(e->label, label)) {
      return e;
    }
  }
  if (!create) {
    return NULL;
  }
  TimerEntry *fresh = (TimerEntry *)malloc(sizeof(TimerEntry));
  if (fresh == NULL) {
    jsrt_panic("out of memory: console.time");
  }
  fresh->label = label;
  fresh->started_ms = 0.0;
  fresh->running = false;
  fresh->next = timers;
  timers = fresh;
  return fresh;
}

/* Node's own unit ladder (`lib/internal/console/constructor.js`, `formatTime`): milliseconds below
 * a second, seconds below a minute, and `m:ss.mmm` with the format spelled out after it above one.
 * Reproduced rather than simplified to `ms` -- the VALUE cannot match Node, but the shape can, and
 * a ten-minute build printing `600000.000ms` would differ from Node in a way that is not the
 * measurement's fault. */
static void format_time(JSRTBuf *out, double ms) {
  char text[64];
  if (ms < 1000.0) {
    snprintf(text, sizeof text, "%.3fms", ms);
    jsrt_buf_puts(out, text);
    return;
  }
  if (ms < 60000.0) {
    snprintf(text, sizeof text, "%.3fs", ms / 1000.0);
    jsrt_buf_puts(out, text);
    return;
  }
  const bool hours = ms >= 3600000.0;
  const int h = (int)(ms / 3600000.0);
  const double after_hours = ms - (double)h * 3600000.0;
  const int m = (int)(after_hours / 60000.0);
  const double seconds = (after_hours - (double)m * 60000.0) / 1000.0;
  if (hours) {
    snprintf(text, sizeof text, "%d:%02d:%06.3f (h:mm:ss.mmm)", h, m, seconds);
  } else {
    snprintf(text, sizeof text, "%d:%06.3f (m:ss.mmm)", m, seconds);
  }
  jsrt_buf_puts(out, text);
}

jsrt_value jsrt_console_time(jsrt_value label) {
  TimerEntry *entry = timer_entry(count_label(label), true);
  /* Node warns and KEEPS the original start when a label is timed twice, so a re-`time` on a
   * running label must not restart it. */
  if (!entry->running) {
    entry->started_ms = monotonic_ms();
    entry->running = true;
  }
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_console_time_end(jsrt_value label) {
  const double now = monotonic_ms();
  const char *name = count_label(label);
  TimerEntry *entry = timer_entry(name, false);
  /* A label that was never started warns in Node and prints no duration. Warning is a channel this
   * runtime does not have (the `countReset` rule), so it prints nothing -- which is exactly what
   * Node writes to stdout for this case. */
  if (entry == NULL || !entry->running) {
    return JSRT_UNDEFINED;
  }
  entry->running = false;
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, name);
  jsrt_buf_puts(&out, ": ");
  format_time(&out, now - entry->started_ms);
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stdout);
  jsrt_buf_free(&out);
  return JSRT_UNDEFINED;
}

/* console.trace: `Trace: <message>` on STDERR, or bare `Trace` without one. Node follows it with
 * stack frames; this runtime has no unwinder and does not fabricate any -- the same decision
 * `jsrt_uncaught` already made and for the same reason, that inventing frames would be worse than
 * omitting them. The observable contract kept here is the stream and the prefix. */
void jsrt_console_trace(jsrt_value message) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, "Trace: ");
  inspect_scalar(&out, message, false);
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stderr);
  jsrt_buf_free(&out);
}

void jsrt_console_trace_bare(void) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, "Trace\n");
  write_grouped(out.data, out.len, stderr);
  jsrt_buf_free(&out);
}

/* console.assert: nothing at all when the condition holds, `Assertion failed` on STDERR when it
 * does not -- with `: message` appended only when a message was passed. */
/* Node's two separators: a STRING message joins with ": ", anything else with a space and its
 * inspect form -- `Assertion failed: why` against `Assertion failed 42`. An explicitly passed
 * `undefined` is "anything else", which is why the message-less form is its own entry point
 * instead of a JSRT_UNDEFINED sentinel here. */
static void assert_failed(jsrt_value message, bool has_message) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, "Assertion failed");
  if (has_message) {
    if (jsrt_is(message, JSRT_TAG_STRING)) {
      jsrt_buf_puts(&out, ": ");
      append_string(&out, (const JSString *)jsrt_ptr(message));
    } else {
      jsrt_buf_putc(&out, ' ');
      inspect_scalar(&out, message, true);
    }
  }
  jsrt_buf_putc(&out, '\n');
  write_grouped(out.data, out.len, stderr);
  jsrt_buf_free(&out);
}

void jsrt_console_assert(jsrt_value condition, jsrt_value message) {
  if (!jsrt_truthy(condition)) {
    assert_failed(message, true);
  }
}

void jsrt_console_assert_bare(jsrt_value condition) {
  if (!jsrt_truthy(condition)) {
    assert_failed(JSRT_UNDEFINED, false);
  }
}

/* ============================================================================
 * console.table
 * ============================================================================
 *
 * The layout Node draws (WHATWG console "table", as Node implements it in `lib/internal/cli_table`)
 * is a box-drawn grid: a leading `(index)` column, one column per key seen across the rows, and a
 * trailing `Values` column for rows that are not objects. Every cell is one space, the content
 * left-aligned, then padding to the column's width, then one more space -- so a divider segment is
 * always the column width plus two.
 *
 * Cells are rendered with `inspect_value`, which is why a string cell is QUOTED (`'x'`) while the
 * index label is not: the label is a key, not a value. Missing keys leave the cell empty rather
 * than printing `undefined`, and a row that is not an object contributes to `Values` instead of to
 * any key column.
 *
 * Deferred by name: the Map/Set form, which Node draws with an `(iteration index)` column and, for
 * a Map, a separate `Key` column -- a different table, not a wider one. The gate refuses it
 * (`STA1214`) rather than this drawing something Node does not. */

/* Column names and one row's rendered cells are JSRTStrVecs (jsrt_mem.h): owned strings. */

/* One value rendered the way a table CELL renders it: inspect form, strings quoted. */
static char *cell_of(jsrt_value v) {
  JSRTBuf b;
  jsrt_buf_init(&b);
  inspect_value(&b, v, 1, 0);
  return jsrt_buf_take(&b);
}

/* Node pads by DISPLAY width, not byte count: a column holding `'日本'` is as wide as one holding
 * six ASCII characters. Continuation bytes never count, combining marks count zero, and the
 * East-Asian Wide and Fullwidth blocks count two -- which is `getStringWidth`'s rule for every
 * code point a table cell in this subset can hold. The full Unicode width table it consults for
 * the rarer blocks is not reproduced here: a cell containing one would be padded one column
 * narrow, which misaligns the row rather than corrupting it. */
static size_t cell_width(const char *s) {
  size_t width = 0;
  for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; p++) {
    if ((*p & 0xC0) == 0x80) {
      continue; /* a continuation byte is part of the code point already counted */
    }
    uint32_t cp = *p;
    if (cp >= 0xF0) {
      cp = ((cp & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) | ((uint32_t)(p[2] & 0x3F) << 6) |
           (uint32_t)(p[3] & 0x3F);
    } else if (cp >= 0xE0) {
      cp = ((cp & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (uint32_t)(p[2] & 0x3F);
    } else if (cp >= 0xC0) {
      cp = ((cp & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3F);
    }
    const bool combining = (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x200B && cp <= 0x200F) ||
                           (cp >= 0xFE00 && cp <= 0xFE0F);
    const bool wide = (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) ||
                      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
                      (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
                      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1F64F) ||
                      (cp >= 0x20000 && cp <= 0x3FFFD);
    width += combining ? 0 : (wide ? 2 : 1);
  }
  return width;
}

/* Whether a row's value contributes KEY COLUMNS (an object or an array) rather than a `Values`
 * cell. Maps, sets, regexps and promises are values here, not rows: `console.table([/a/])` puts
 * `/a/` under `Values`, which is what Node does with anything whose own properties it will not
 * enumerate. */
static bool tabular_row(jsrt_value v) {
  return (jsrt_is(v, JSRT_TAG_ARRAY) || jsrt_is(v, JSRT_TAG_OBJECT)) && !jsrt_is_map_or_set(v) &&
         !jsrt_is_regexp(v) && !jsrt_is_promise(v) && !jsrt_is_date(v);
}

/* `n` copies of `s`, for the horizontal rules. The existing `jsrt_buf_repeat` takes a CHAR, and a box
 * rule is drawn with U+2500, which is three bytes. */
static void buf_repeat_utf8(JSRTBuf *b, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    jsrt_buf_puts(b, s);
  }
}

/* One cell: a space, the content, padding to `width`, a space. */
static void buf_cell(JSRTBuf *b, const char *text, size_t width) {
  jsrt_buf_putc(b, ' ');
  jsrt_buf_puts(b, text);
  for (size_t pad = cell_width(text); pad < width; pad++) {
    jsrt_buf_putc(b, ' ');
  }
  jsrt_buf_putc(b, ' ');
}

static void buf_rule(JSRTBuf *b, const char *left, const char *mid, const char *right,
                     const size_t *widths, size_t count) {
  jsrt_buf_puts(b, left);
  for (size_t c = 0; c < count; c++) {
    buf_repeat_utf8(b, "─", widths[c] + 2);
    jsrt_buf_puts(b, c + 1 == count ? right : mid);
  }
  jsrt_buf_putc(b, '\n');
}

void jsrt_console_table(jsrt_value v) {
  /* Node falls back to console.log for anything that is not a collection of rows, and that
   * fallback is REACHABLE here: the gate accepts `console.table` on an Unknown receiver, so a
   * scalar can arrive at run time. */
  if (!tabular_row(v)) {
    jsrt_print(v);
    return;
  }

  /* Snapshot keys, not getter results: read each row only when it is about to be processed. */
  JSRTStrVec labels;
  jsrt_strvec_init(&labels);
  JSRTStrVec row_values; /* the `Values` cell, or an empty string when the row has key columns */
  jsrt_strvec_init(&row_values);
  JSRTStrVec columns;
  jsrt_strvec_init(&columns);
  /* cells[row * columns.len + col] once the column set is known -- built after the walk, because
   * a column discovered by the last row still needs an empty cell in the first. */
  JSRTStrVec keys_flat; /* every row's keys, run-length delimited by `key_counts` */
  jsrt_strvec_init(&keys_flat);
  JSRTStrVec vals_flat;
  jsrt_strvec_init(&vals_flat);
  size_t *key_counts = NULL;
  size_t row_count = 0;
  bool any_values = false;

  const bool from_array = jsrt_is(v, JSRT_TAG_ARRAY);
  const jsrt_value rows = from_array ? v : jsrt_object_keys(v);
  if (jsrt_pending()) {
    goto cleanup;
  }
  const JSRTArray *row_list = jsrt_as_array(rows);
  row_count = row_list->length;
  key_counts = (size_t *)calloc(row_count == 0 ? 1 : row_count, sizeof(size_t));
  if (key_counts == NULL) {
    jsrt_panic("out of memory building a console.table");
  }

  for (uint32_t i = 0; i < row_count; i++) {
    jsrt_value value;
    if (from_array) {
      JSRTBuf label;
      jsrt_buf_init(&label);
      inspect_scalar(&label, jsrt_number((double)i), false);
      jsrt_strvec_push(&labels, jsrt_buf_take(&label));
      value = jsrt_unhole(row_list->elements[i]);
    } else {
      const jsrt_value key = row_list->elements[i];
      value = jsrt_get_prop_value(v, key, NULL);
      if (jsrt_pending()) {
        goto cleanup;
      }
      JSRTBuf label;
      jsrt_buf_init(&label);
      inspect_scalar(&label, key, false); /* a key prints unquoted */
      jsrt_strvec_push(&labels, jsrt_buf_take(&label));
    }

    if (!tabular_row(value)) {
      jsrt_strvec_push(&row_values, cell_of(value));
      any_values = true;
      continue;
    }
    jsrt_strvec_push(&row_values, strdup(""));
    /* An ARRAY row's keys are its indices, which is why `[[1,2]]` tables as columns `0` and `1`. */
    if (jsrt_is(value, JSRT_TAG_ARRAY)) {
      const JSRTArray *inner = jsrt_as_array(value);
      for (uint32_t k = 0; k < inner->length; k++) {
        JSRTBuf name;
        jsrt_buf_init(&name);
        inspect_scalar(&name, jsrt_number((double)k), false);
        jsrt_strvec_push(&keys_flat, jsrt_buf_take(&name));
        jsrt_strvec_push(&vals_flat, cell_of(jsrt_unhole(inner->elements[k])));
        key_counts[i]++;
      }
      continue;
    }
    const jsrt_value row_entries = jsrt_object_entries(value);
    if (jsrt_pending()) {
      goto cleanup;
    }
    const JSRTArray *entries = jsrt_as_array(row_entries);
    for (uint32_t k = 0; k < entries->length; k++) {
      const JSRTArray *pair = jsrt_as_array(entries->elements[k]);
      JSRTBuf name;
      jsrt_buf_init(&name);
      inspect_scalar(&name, pair->elements[0], false);
      jsrt_strvec_push(&keys_flat, jsrt_buf_take(&name));
      jsrt_strvec_push(&vals_flat, cell_of(pair->elements[1]));
      key_counts[i]++;
    }
  }

  /* Column order is FIRST-SEEN across rows, with `Values` last if any row needed it. */
  for (size_t k = 0; k < keys_flat.len; k++) {
    if (jsrt_strvec_find(&columns, keys_flat.items[k]) == SIZE_MAX) {
      jsrt_strvec_push(&columns, strdup(keys_flat.items[k]));
    }
  }
  const size_t values_col = any_values ? columns.len : SIZE_MAX;
  if (any_values) {
    jsrt_strvec_push(&columns, strdup("Values"));
  }

  /* Widths: the index column plus one per data column, each the widest of its header and cells. */
  const size_t total = columns.len + 1;
  size_t *widths = (size_t *)calloc(total, sizeof(size_t));
  char **grid = (char **)calloc(row_count * columns.len + 1, sizeof(char *));
  if (widths == NULL || grid == NULL) {
    jsrt_panic("out of memory building a console.table");
  }
  widths[0] = cell_width("(index)");
  for (size_t c = 0; c < columns.len; c++) {
    widths[c + 1] = cell_width(columns.items[c]);
  }
  size_t flat = 0;
  for (size_t i = 0; i < row_count; i++) {
    widths[0] = widths[0] > cell_width(labels.items[i]) ? widths[0] : cell_width(labels.items[i]);
    for (size_t k = 0; k < key_counts[i]; k++, flat++) {
      const size_t c = jsrt_strvec_find(&columns, keys_flat.items[flat]);
      grid[i * columns.len + c] = vals_flat.items[flat];
    }
    if (values_col != SIZE_MAX && row_values.items[i][0] != '\0') {
      grid[i * columns.len + values_col] = row_values.items[i];
    }
    for (size_t c = 0; c < columns.len; c++) {
      const char *cell = grid[i * columns.len + c];
      const size_t w = cell == NULL ? 0 : cell_width(cell);
      widths[c + 1] = widths[c + 1] > w ? widths[c + 1] : w;
    }
  }

  JSRTBuf out;
  jsrt_buf_init(&out);
  buf_rule(&out, "┌", "┬", "┐", widths, total);
  jsrt_buf_puts(&out, "│");
  buf_cell(&out, "(index)", widths[0]);
  for (size_t c = 0; c < columns.len; c++) {
    jsrt_buf_puts(&out, "│");
    buf_cell(&out, columns.items[c], widths[c + 1]);
  }
  jsrt_buf_puts(&out, "│\n");
  buf_rule(&out, "├", "┼", "┤", widths, total);
  for (size_t i = 0; i < row_count; i++) {
    jsrt_buf_puts(&out, "│");
    buf_cell(&out, labels.items[i], widths[0]);
    for (size_t c = 0; c < columns.len; c++) {
      const char *cell = grid[i * columns.len + c];
      jsrt_buf_puts(&out, "│");
      buf_cell(&out, cell == NULL ? "" : cell, widths[c + 1]);
    }
    jsrt_buf_puts(&out, "│\n");
  }
  buf_rule(&out, "└", "┴", "┘", widths, total);
  write_grouped(out.data, out.len, stdout);

  jsrt_buf_free(&out);
  free(grid);
  free(widths);
cleanup:
  free(key_counts);
  jsrt_strvec_free(&labels);
  jsrt_strvec_free(&row_values);
  jsrt_strvec_free(&columns);
  jsrt_strvec_free(&keys_flat);
  jsrt_strvec_free(&vals_flat);
}

_Noreturn void jsrt_uncaught(void) {
  /* Same inspect form console.log uses, so `throw {x: 1}` reads as `{ x: 1 }` -- but on STDERR,
   * because stdout is the program's output and an uncaught exception is not part of it. The text
   * intentionally does not chase Node's (which prints source excerpts and stack frames this
   * runtime does not have); the OBSERVABLE contract is stderr + exit 1. */
  JSRTBuf out;
  jsrt_buf_init(&out);
  jsrt_buf_puts(&out, "Uncaught ");
  inspect_value(&out, jsrt_take_exception(), 0, 0);
  jsrt_buf_putc(&out, '\n');
  fwrite(out.data, 1, out.len, stderr);
  jsrt_buf_free(&out);
  exit(1);
}

/* Array.prototype.join (§23.1.3.16), which is also Array#toString: `undefined` separator means
 * ",", and `null`/`undefined` ELEMENTS join as empty text, not as their names. Lives here rather
 * than with the other array builtins because joining IS stringification — it needs JSRTBuf and the
 * recursive ToString below. */
jsrt_value jsrt_array_join(jsrt_value array, jsrt_value separator) {
  const JSRTArray *a = jsrt_require_array(array, "join");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  JSRTBuf joined;
  jsrt_buf_init(&joined);
  /* The length is read ONCE (§23.1.3.18 step 2): an element's own `toString` may grow or shrink
   * the array, and an index past its new end reads `undefined`, which joins as empty. */
  const uint32_t length = a->length;
  for (uint32_t i = 0; i < length; i++) {
    if (i > 0) {
      if (jsrt_is(separator, JSRT_TAG_UNDEFINED)) {
        jsrt_buf_putc(&joined, ',');
      } else {
        append_string(&joined, (const JSString *)jsrt_ptr(separator));
      }
    }
    /* A hole joins as the empty string, as undefined does (§23.1.3.18 step 7.c). */
    const jsrt_value element = i < a->length ? jsrt_unhole(a->elements[i]) : JSRT_UNDEFINED;
    if (jsrt_is(element, JSRT_TAG_NULL) || jsrt_is(element, JSRT_TAG_UNDEFINED)) {
      continue;
    }
    const jsrt_value text = jsrt_to_string(element);
    if (jsrt_pending()) {
      jsrt_buf_free(&joined);
      return JSRT_UNDEFINED;
    }
    append_string(&joined, (const JSString *)jsrt_ptr(text));
  }
  const jsrt_value result = jsrt_string_from_utf8(joined.data == NULL ? "" : joined.data,
                                                  joined.len);
  jsrt_buf_free(&joined);
  return result;
}

/* ============================================================================
 * JSON.stringify (§25.5.2) — SerializeJSONProperty over the value graph
 * ============================================================================
 *
 * Lives here for jsrt_array_join's reason: serialization IS stringification, and it needs JSRTBuf,
 * format_double and the UTF-16 walk. Two departures from the inspect code above are the whole
 * point: numbers hide the minus of `-0` ("0", where inspect shows "-0"), and strings are QUOTED
 * per §25.5.2.2 — `"` and `\\` escaped, controls as their short escapes or \u00XX, and a LONE
 * surrogate as \udXXX (well-formed JSON.stringify, ES2019), where the inspect walk substitutes
 * U+FFFD.
 *
 * Two spec behaviours cannot be produced yet and abort loudly instead (the STA2005 pattern):
 * a CYCLE (the spec throws TypeError, and builtins cannot throw), and `undefined` at the TOP
 * level (the spec returns undefined where this node's type promises a string; the gate refuses
 * argument types that admit it, so reaching it means an Unknown leaked). Inside a structure,
 * `undefined` and closures follow the spec: skipped in objects, `null` in arrays. */

typedef struct JSONAncestor {
  const void *ptr;
  const struct JSONAncestor *parent;
} JSONAncestor;

static bool json_unserializable(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_UNDEFINED) || jsrt_is(v, JSRT_TAG_CLOSURE);
}

static void json_quote(JSRTBuf *out, const JSString *str) {
  jsrt_buf_putc(out, '"');
  for (uint32_t i = 0; i < str->length; i++) {
    uint32_t cp = str->data[i];
    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < str->length && str->data[i + 1] >= 0xDC00u &&
        str->data[i + 1] <= 0xDFFFu) {
      /* A paired surrogate passes through as its code point, encoded UTF-8 below. */
      cp = 0x10000u + ((cp - 0xD800u) << 10) + (str->data[i + 1] - 0xDC00u);
      i++;
    }
    if (cp == '"' || cp == '\\') {
      jsrt_buf_putc(out, '\\');
      jsrt_buf_putc(out, (char)cp);
    } else if (cp == '\b') {
      jsrt_buf_puts(out, "\\b");
    } else if (cp == '\f') {
      jsrt_buf_puts(out, "\\f");
    } else if (cp == '\n') {
      jsrt_buf_puts(out, "\\n");
    } else if (cp == '\r') {
      jsrt_buf_puts(out, "\\r");
    } else if (cp == '\t') {
      jsrt_buf_puts(out, "\\t");
    } else if (cp < 0x20u || (cp >= 0xD800u && cp <= 0xDFFFu)) {
      /* Controls without a short escape, and LONE surrogates (well-formed JSON.stringify). */
      char esc[8];
      snprintf(esc, sizeof esc, "\\u%04x", cp);
      jsrt_buf_puts(out, esc);
    } else {
      append_utf8(out, cp);
    }
  }
  jsrt_buf_putc(out, '"');
}

/* `cyclic` is NULL for JSON.stringify itself, which cannot throw its TypeError yet and aborts.
 * util.format's `%j` passes a flag instead: Node's tryStringify catches exactly that TypeError and
 * prints `[Circular]`, so the cycle is an answer there, not an error. */
static bool json_cycle(const void *ptr, const JSONAncestor *chain, bool *cyclic) {
  for (; chain != NULL; chain = chain->parent) {
    if (chain->ptr == ptr) {
      if (cyclic != NULL) {
        *cyclic = true;
        return true;
      }
      jsrt_panic("STA2005: JSON.stringify of a cyclic structure is not yet supported; the spec "
                 "throws TypeError, which builtins cannot raise yet");
    }
  }
  return false;
}

/* A nested serialization stopped: it threw, or `%j` met a cycle. Either way nothing more is
 * written, and the caller unwinds. */
static bool json_stopped(const bool *cyclic) {
  return jsrt_pending() || (cyclic != NULL && *cyclic);
}

static void json_value(JSRTBuf *out, jsrt_value v, const JSONAncestor *chain, bool *cyclic) {
  /* §25.5.2.2 step 2: SerializeJSONProperty calls the value's own `toJSON` before doing anything
   * else, and `Date.prototype.toJSON` is the only one the subset has. It answers a STRING, or
   * `null` for an Invalid Date -- which is why `JSON.stringify(new Date(NaN))` is "null" and not
   * an abort, unlike `toISOString`. Serializing the ANSWER, not the Date, is what keeps this one
   * arm from needing a cycle check or a shape walk. */
  if (jsrt_is_date(v)) {
    json_value(out, jsrt_date_to_json(v), chain, cyclic);
    return;
  }
  if (jsrt_is(v, JSRT_TAG_NULL)) {
    jsrt_buf_puts(out, "null");
    return;
  }
  if (jsrt_is(v, JSRT_TAG_BOOL)) {
    jsrt_buf_puts(out, v == JSRT_TRUE ? "true" : "false");
    return;
  }
  if (jsrt_is_double(v)) {
    double d = jsrt_to_double(v);
    if (isnan(d) || isinf(d)) {
      jsrt_buf_puts(out, "null"); /* §25.5.2.2: non-finite serializes as null */
      return;
    }
    char num[64];
    format_double(d, num, sizeof num, false); /* false: JSON spells -0 as "0" */
    jsrt_buf_puts(out, num);
    return;
  }
  if (jsrt_is(v, JSRT_TAG_STRING)) {
    json_quote(out, (const JSString *)jsrt_ptr(v));
    return;
  }
  if (jsrt_is(v, JSRT_TAG_ARRAY)) {
    const JSRTArray *a = jsrt_as_array(v);
    if (json_cycle(a, chain, cyclic)) {
      return;
    }
    const JSONAncestor here = {a, chain};
    jsrt_buf_putc(out, '[');
    for (uint32_t i = 0; i < a->length; i++) {
      if (i > 0) {
        jsrt_buf_putc(out, ',');
      }
      /* An unserializable ELEMENT is null, not skipped -- indices must keep their meaning. */
      /* A hole serializes as `undefined` does: Get answers undefined (§25.5.2.6 step 8.a). */
      const jsrt_value element = jsrt_unhole(a->elements[i]);
      if (json_unserializable(element)) {
        jsrt_buf_puts(out, "null");
      } else {
        json_value(out, element, &here, cyclic);
        if (json_stopped(cyclic)) {
          return;
        }
      }
    }
    jsrt_buf_putc(out, ']');
    return;
  }
  if (jsrt_is(v, JSRT_TAG_OBJECT)) {
    if (jsrt_is_map_or_set(v) || jsrt_is_regexp(v) || jsrt_is_promise(v) ||
        jsrt_is_arraybuffer(v)) {
      jsrt_buf_puts(out, "{}"); /* no enumerable own properties, Node's own answer */
      return;
    }
    if (jsrt_is_uint8array(v)) {
      /* A view is an ordinary object to JSON: its own enumerable keys are the indices, so
       * `{"0":5,"1":6}`. Its elements are numbers, so no cycle and no throw can arise. */
      const uint32_t length = (uint32_t)jsrt_number_value(jsrt_uint8array_length(v));
      jsrt_buf_putc(out, '{');
      for (uint32_t i = 0; i < length; i++) {
        char item[32];
        snprintf(item, sizeof item, "%s\"%u\":%u", i > 0 ? "," : "", i,
                 (unsigned)jsrt_number_value(jsrt_uint8array_get(v, jsrt_number((double)i))));
        jsrt_buf_puts(out, item);
      }
      jsrt_buf_putc(out, '}');
      return;
    }
    if (json_cycle(jsrt_ptr(v), chain, cyclic)) {
      return;
    }
    const JSONAncestor here = {jsrt_ptr(v), chain};
    /* A nested value may throw during serialization. Later getters must not run before it. */
    const JSRTArray *keys = jsrt_as_array(jsrt_object_keys(v));
    jsrt_buf_putc(out, '{');
    bool first = true;
    for (uint32_t i = 0; i < keys->length; i++) {
      const jsrt_value key = keys->elements[i];
      const jsrt_value value = jsrt_get_prop_value(v, key, NULL);
      if (jsrt_pending()) {
        return;
      }
      if (json_unserializable(value)) {
        continue; /* an unserializable VALUE drops its key */
      }
      if (!first) {
        jsrt_buf_putc(out, ',');
      }
      first = false;
      json_quote(out, (const JSString *)jsrt_ptr(key));
      jsrt_buf_putc(out, ':');
      json_value(out, value, &here, cyclic);
      if (json_stopped(cyclic)) {
        return;
      }
    }
    jsrt_buf_putc(out, '}');
    return;
  }
  jsrt_panic("STA2005: JSON.stringify of undefined at the top level is not yet supported; the "
             "spec returns undefined where this call's type promises a string");
}

/* `%j`: Node's tryStringify -- JSON.stringify, `undefined` where it answers undefined, and
 * `[Circular]` for the one TypeError it catches. A cycle is found before anything after it is
 * written, but the partial text is discarded all the same: the answer replaces it. */
static void json_format(JSRTBuf *out, jsrt_value v) {
  if (json_unserializable(v)) {
    jsrt_buf_puts(out, "undefined");
    return;
  }
  JSRTBuf text;
  jsrt_buf_init(&text);
  bool cyclic = false;
  json_value(&text, v, NULL, &cyclic);
  if (cyclic) {
    jsrt_buf_puts(out, "[Circular]");
  } else if (!jsrt_pending()) {
    jsrt_buf_append(out, text.data, text.len);
  }
  jsrt_buf_free(&text);
}

jsrt_value jsrt_json_stringify(jsrt_value v) {
  JSRTBuf out;
  jsrt_buf_init(&out);
  json_value(&out, v, NULL, NULL);
  if (jsrt_pending()) {
    jsrt_buf_free(&out);
    return JSRT_UNDEFINED;
  }
  const jsrt_value result = jsrt_string_from_utf8(out.data == NULL ? "" : out.data, out.len);
  jsrt_buf_free(&out);
  return result;
}

jsrt_value jsrt_to_string(jsrt_value v) {
  if (!jsrt_is_object(v)) {
    return jsrt_builtin_to_string(v);
  }
  /* §7.1.17 step 10: ToPrimitive(argument, string), then ToString of what it answered -- a
   * primitive, so the builtin form below is the whole rest of the algorithm. */
  const jsrt_value primitive = jsrt_to_primitive(v, JSRT_HINT_STRING);
  if (jsrt_pending()) {
    return jsrt_string_from_utf8("", 0);
  }
  return jsrt_builtin_to_string(primitive);
}

jsrt_value jsrt_builtin_to_string(jsrt_value v) {
  char buf[64];

  /* Array.prototype.toString is join(","), which is a different algorithm from the inspect form
   * above and produces different text for the same array: `String([1,[2,3]])` is "1,2,3" where
   * console.log shows `[ 1, [ 2, 3 ] ]`. `null` and `undefined` join as empty, not as their
   * names -- ECMA-262 §23.1.3.18.
   *
   * KNOWN CEILING: no cycle guard. ECMA-262 has join() return "" for an array reachable from
   * itself; this would recurse until the stack ran out. Building the cycle needs `a[0] = a`, which
   * the checker rejects for every array type the ts subset can spell, so the case is unreachable
   * until js mode's dynamic arrays land -- and the guard belongs there, with the seen-set that
   * inspect will need at the same time. (inspect_array is already safe: its depth cap stops it.) */
  if (jsrt_is(v, JSRT_TAG_ARRAY)) {
    /* An element's own `toString` may throw; the answer stays a string either way. */
    const jsrt_value joined = jsrt_array_join(v, JSRT_UNDEFINED);
    return jsrt_pending() ? jsrt_string_from_utf8("", 0) : joined;
  }

  if (jsrt_is_double(v)) {
    format_double(jsrt_to_double(v), buf, sizeof buf, false);
  } else if (jsrt_is(v, JSRT_TAG_STRING)) {
    return v; /* already a string */
  } else if (jsrt_is(v, JSRT_TAG_BOOL)) {
    snprintf(buf, sizeof buf, "%s", jsrt_as_bool(v) ? "true" : "false");
  } else if (jsrt_is(v, JSRT_TAG_NULL)) {
    snprintf(buf, sizeof buf, "null");
  } else if (jsrt_is(v, JSRT_TAG_UNDEFINED)) {
    snprintf(buf, sizeof buf, "undefined");
  } else if (jsrt_is(v, JSRT_TAG_INT32)) {
    snprintf(buf, sizeof buf, "%d", jsrt_as_int32(v));
  } else if (jsrt_is(v, JSRT_TAG_CLOSURE)) {
    /* KNOWN CEILING: ToString of a function is its SOURCE TEXT in ECMA-262, which needs the
     * original span carried into the binary. Until then this is deliberately shaped like a
     * function rather than "[object Object]", and differs from Node. */
    snprintf(buf, sizeof buf, "function %s() { [native code] }", jsrt_as_closure(v)->name);
  } else if (jsrt_is_map_or_set(v)) {
    /* `Symbol.toStringTag` is the class name ("Map", "WeakSet", ...), so
     * `Object.prototype.toString` -- which is what ToString reaches through ToPrimitive here --
     * answers `[object Map]` (plan.md §8 step 29). */
    snprintf(buf, sizeof buf, "[object %s]", jsrt_as_object(v)->cls->name);
  } else if (jsrt_is_regexp(v)) {
    /* `RegExp.prototype.toString`: `/source/flags` off the normalized strings (§22.2.6.13). */
    return jsrt_regexp_to_string(v);
  } else if (jsrt_is_date(v)) {
    /* `Date.prototype.toString` form (§21.4.4.41); "Invalid Date" for a non-finite time value. */
    return jsrt_date_to_string(v);
  } else if (jsrt_is_error(v)) {
    /* `Error.prototype.toString`: `name: message` with the empty-side rules (§20.5.3.4). */
    return jsrt_error_to_string(v);
  } else if (jsrt_is_promise(v)) {
    snprintf(buf, sizeof buf, "[object Promise]");
  } else if (jsrt_is_uint8array(v)) {
    /* `%TypedArray%.prototype.toString` IS `Array.prototype.toString`: the elements joined. */
    return jsrt_uint8array_text(v);
  } else if (jsrt_is_arraybuffer(v)) {
    snprintf(buf, sizeof buf, "[object ArrayBuffer]");
  } else {
    snprintf(buf, sizeof buf, "[object Object]");
  }

  return jsrt_string_from_utf8(buf, strlen(buf));
}
