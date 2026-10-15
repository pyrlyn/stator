/* jsrt_regexp.c — the bridge between Stator's values and quickjs-ng's libregexp.
 *
 * The engine is vendored, not written (plan.md golden rule 5): `runtime/vendor/quickjs-ng`, see
 * its VENDOR.md. It asks its embedder for exactly three functions — an allocator, a stack-depth
 * question and a timeout question — and everything else here is translation: a pattern from our
 * UTF-16 strings into the UTF-8 the compiler reads, and a subject string straight into the
 * executor, which takes UTF-16 code units natively and therefore needs no copy at all.
 *
 * What the engine does NOT get is a notion of our values: `lre_exec` writes byte pointers into a
 * capture array, and turning those into indices, strings or arrays is this file's job. */

#include "jsrt.h"
#include "jsrt_mem.h"
#include "jsrt_value.h"

#include "libregexp.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const JSRTClass jsrt_class_regexp __attribute__((used)) = {"RegExp", 0, NULL, NULL, 0, NULL,
                                                       NULL, NULL, NULL};

/* ============================================================================
 * The three functions libregexp.h says "must be provided by the user"
 * ============================================================================ */

/* The engine's only allocator. Its convention is realloc's, with size 0 meaning free.
 *
 * Deliberately NOT the collected heap even when Boehm is present: this memory holds bytecode and
 * scratch buffers, never a `jsrt_value`, so nothing in it needs scanning — and the collector would
 * have to scan it, because it cannot know that. The regexp object owns the bytecode for as long as
 * it lives, and a regexp that dies takes the allocation with it only once the collector can run
 * finalizers; until then this is the same leak every other malloc'd table in the runtime has. */
void *lre_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  if (size == 0) {
    free(ptr);
    return NULL;
  }
  void *grown = realloc(ptr, size);
  if (grown == NULL) {
    jsrt_panic("out of memory: regexp engine");
  }
  return grown;
}

/* The engine recurses — while compiling a nested pattern and while backtracking — and asks before
 * each step whether the C stack can take another frame. Answering "never overflowing" would turn a
 * pathological pattern into a segfault, so this measures instead: the first call records an address
 * on the stack and every call after it compares the current depth against a budget that sits well
 * inside the smallest stack this runtime plausibly runs on (512 KB is a typical non-main pthread
 * default; the main thread has 8 MB on macOS). The runtime is single-threaded, so a plain static
 * is the right amount of machinery for the base. */
#define LRE_STACK_BUDGET ((size_t)192 * 1024)

static const char *lre_stack_base;

bool lre_check_stack_overflow(void *opaque, size_t alloca_size) {
  (void)opaque;
  const char here = 0;
  if (lre_stack_base == NULL) {
    lre_stack_base = &here;
  }
  /* Stacks grow down on every target Stator supports; a negative depth would mean this call is
   * SHALLOWER than the first one, which is not an overflow. */
  const ptrdiff_t used = lre_stack_base - &here;
  return used > 0 && (size_t)used + alloca_size > LRE_STACK_BUDGET;
}

/* No interruption: a compiled program has no watchdog to ask, and a regexp that runs forever is a
 * program that runs forever, which is a thing JavaScript lets you write. */
int lre_check_timeout(void *opaque) {
  (void)opaque;
  return 0;
}

/* ============================================================================
 * Patterns
 * ============================================================================ */

/* The compiler reads the pattern as UTF-8 — or as CESU-8 when the pattern is not a unicode one,
 * which is the same rule quickjs applies: a LONE surrogate has no UTF-8 encoding, and a
 * non-unicode pattern may legally contain one, so there each UTF-16 unit is encoded on its own.
 * The result is NUL-terminated for convenience; the length is what the engine is given, because a
 * pattern may legitimately contain U+0000. */
static char *pattern_utf8(jsrt_value source, bool unicode, size_t *out_len) {
  const JSString *str = (const JSString *)jsrt_ptr(source);
  /* Four bytes per unit is the worst case for both encodings, and a surrogate PAIR only ever
   * shrinks against it (two units, four bytes). */
  char *out = (char *)malloc((size_t)str->length * 4 + 1);
  if (out == NULL) {
    jsrt_panic("out of memory: regexp pattern");
  }
  size_t n = 0;
  for (uint32_t i = 0; i < str->length; i++) {
    uint32_t cp = str->data[i];
    if (unicode && cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < str->length &&
        str->data[i + 1] >= 0xDC00u && str->data[i + 1] <= 0xDFFFu) {
      cp = 0x10000u + ((cp - 0xD800u) << 10) + (str->data[i + 1] - 0xDC00u);
      i++;
    }
    if (cp < 0x80u) {
      out[n++] = (char)cp;
    } else if (cp < 0x800u) {
      out[n++] = (char)(0xC0u | (cp >> 6));
      out[n++] = (char)(0x80u | (cp & 0x3Fu));
    } else if (cp < 0x10000u) {
      out[n++] = (char)(0xE0u | (cp >> 12));
      out[n++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
      out[n++] = (char)(0x80u | (cp & 0x3Fu));
    } else {
      out[n++] = (char)(0xF0u | (cp >> 18));
      out[n++] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
      out[n++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
      out[n++] = (char)(0x80u | (cp & 0x3Fu));
    }
  }
  out[n] = '\0';
  *out_len = n;
  return out;
}

/* The flag string, in any order, as the LRE_FLAG_* set -- or -1 for one §22.2.3.1 refuses: a
 * letter the engine does not know, a letter written twice, or `u` with `v`. A literal's flags were
 * checked at compile time, so only `new RegExp(p, flags)` can meet the -1 with data. */
static int flags_to_lre(jsrt_value flags) {
  const JSString *str = (const JSString *)jsrt_ptr(flags);
  int out = 0;
  for (uint32_t i = 0; i < str->length; i++) {
    int bit;
    switch (str->data[i]) {
      case 'd': bit = LRE_FLAG_INDICES; break;
      case 'g': bit = LRE_FLAG_GLOBAL; break;
      case 'i': bit = LRE_FLAG_IGNORECASE; break;
      case 'm': bit = LRE_FLAG_MULTILINE; break;
      case 's': bit = LRE_FLAG_DOTALL; break;
      case 'u': bit = LRE_FLAG_UNICODE; break;
      case 'v': bit = LRE_FLAG_UNICODE_SETS; break;
      case 'y': bit = LRE_FLAG_STICKY; break;
      default: return -1;
    }
    if ((out & bit) != 0) {
      return -1;
    }
    out |= bit;
  }
  if ((out & LRE_FLAG_UNICODE) != 0 && (out & LRE_FLAG_UNICODE_SETS) != 0) {
    return -1;
  }
  return out;
}

/* The flag set back as a STRING, in §22.2.6.4's order -- `d g i m s u v y` -- which is not the
 * order the program wrote them in. Node normalizes: `/a/ig` has `.flags === "gi"` and PRINTS as
 * `/a/gi`. Normalizing here rather than at each reader is what keeps `re.flags`, `re.toString()`
 * and `console.log(re)` from ever disagreeing. */
static jsrt_value canonical_flags(int lre_flags) {
  static const struct {
    int bit;
    char letter;
  } order[] = {
      {LRE_FLAG_INDICES, 'd'},      {LRE_FLAG_GLOBAL, 'g'},  {LRE_FLAG_IGNORECASE, 'i'},
      {LRE_FLAG_MULTILINE, 'm'},    {LRE_FLAG_DOTALL, 's'},  {LRE_FLAG_UNICODE, 'u'},
      {LRE_FLAG_UNICODE_SETS, 'v'}, {LRE_FLAG_STICKY, 'y'},
  };
  char out[sizeof order / sizeof order[0]];
  size_t n = 0;
  for (size_t i = 0; i < sizeof order / sizeof order[0]; i++) {
    if ((lre_flags & order[i].bit) != 0) {
      out[n++] = order[i].letter;
    }
  }
  return jsrt_string_from_utf8(out, n);
}

/* The letter -> bit map `canonical_flags` walks, read the other way. Anything but one of the eight
 * letters is the emitter having invented a property, which is a compiler bug, not bad data. */
bool jsrt_regexp_flag(jsrt_value re_value, int letter) {
  const JSRTRegExp *re = jsrt_as_regexp(re_value);
  int bit;
  switch (letter) {
    case 'd': bit = LRE_FLAG_INDICES; break;
    case 'g': bit = LRE_FLAG_GLOBAL; break;
    case 'i': bit = LRE_FLAG_IGNORECASE; break;
    case 'm': bit = LRE_FLAG_MULTILINE; break;
    case 's': bit = LRE_FLAG_DOTALL; break;
    case 'u': bit = LRE_FLAG_UNICODE; break;
    case 'v': bit = LRE_FLAG_UNICODE_SETS; break;
    case 'y': bit = LRE_FLAG_STICKY; break;
    default: jsrt_panic("STA4091: a RegExp flag property the runtime does not know");
  }
  return (re->lre_flags & bit) != 0;
}

jsrt_value jsrt_regexp_to_string(jsrt_value re_value) {
  const JSRTRegExp *re = jsrt_as_regexp(re_value);
  /* Each concat allocates and the next one reads what it produced, so the partial result is rooted
   * while the following call runs (plan-notes 222). */
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_string_concat(jsrt_string_from_utf8("/", 1), re->source);
  JSRT_LOCAL(0) = jsrt_string_concat(JSRT_LOCAL(0), jsrt_string_from_utf8("/", 1));
  JSRT_LOCAL(0) = jsrt_string_concat(JSRT_LOCAL(0), re->flags);
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

/* RegExp.prototype read as a value from a regexp the compiler only knows as Unknown (plan-notes
 * 314, 310): narrowing an `unknown` with `instanceof RegExp`, or a `string | RegExp` with
 * `typeof`, leaves an Unknown receiver, and a regexp has no shape table, so `x.test(s)` read
 * `undefined` and the call aborted STA2006 where Node runs. The `jsrt_string_method` contract
 * (jsrt_string_methods.c) for the three methods, and the derived data properties of §22.2.6. */
static const char *const REGEXP_METHODS[] = {"test", "exec", "toString"};

static jsrt_value regexp_method_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const jsrt_value re = env->slots[0];
  const jsrt_value str = jsrt_to_string(jsrt_arg(argc, argv, 0));
  switch ((int)jsrt_to_number(env->slots[1])) {
    case 0: return jsrt_bool(jsrt_regexp_test(re, str));
    case 1: return jsrt_regexp_exec(re, str);
    default: return jsrt_regexp_to_string(re);
  }
}

static const struct {
  const char *name;
  char letter;
} REGEXP_FLAG_PROPERTIES[] = {
    {"hasIndices", 'd'}, {"global", 'g'},  {"ignoreCase", 'i'},  {"multiline", 'm'},
    {"dotAll", 's'},     {"unicode", 'u'}, {"unicodeSets", 'v'}, {"sticky", 'y'},
};

bool jsrt_regexp_property(jsrt_value re, const char *key, jsrt_value *out) {
  if (!jsrt_is_regexp(re)) {
    return false;
  }
  if (strcmp(key, "source") == 0 || strcmp(key, "flags") == 0) {
    *out = key[0] == 's' ? jsrt_regexp_source(re) : jsrt_regexp_flags(re);
    return true;
  }
  if (strcmp(key, "lastIndex") == 0) {
    *out = jsrt_regexp_last_index(re);
    return true;
  }
  for (size_t i = 0; i < sizeof REGEXP_FLAG_PROPERTIES / sizeof REGEXP_FLAG_PROPERTIES[0]; i++) {
    if (strcmp(REGEXP_FLAG_PROPERTIES[i].name, key) == 0) {
      *out = jsrt_bool(jsrt_regexp_flag(re, REGEXP_FLAG_PROPERTIES[i].letter));
      return true;
    }
  }
  for (uint32_t i = 0; i < sizeof REGEXP_METHODS / sizeof REGEXP_METHODS[0]; i++) {
    if (strcmp(REGEXP_METHODS[i], key) == 0) {
      *out = jsrt_bound_method(re, i, regexp_method_call, i == 2 ? 0 : 1, REGEXP_METHODS[i]);
      return true;
    }
  }
  return false;
}

/* Compiles `source` under `lre_flags` into a regexp, or answers false with the engine's reason in
 * `error` and allocates nothing. `source` is what `.source` will read, so the caller has already
 * escaped it (§22.2.6.13.1); an escaped `/` or line terminator compiles to the same pattern. */
static bool regexp_build(jsrt_value source, int lre_flags, char *error, size_t error_len,
                         jsrt_value *out) {
  size_t pattern_len = 0;
  char *pattern =
      pattern_utf8(source, (lre_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0,
                   &pattern_len);
  int bytecode_len = 0;
  uint8_t *bytecode = lre_compile(&bytecode_len, error, (int)error_len, pattern, pattern_len,
                                  lre_flags, NULL);
  free(pattern);
  if (bytecode == NULL) {
    return false;
  }

  JSRTRegExp *re = (JSRTRegExp *)jsrt_gc_alloc(sizeof(JSRTRegExp), "regexp");
  re->cls = &jsrt_class_regexp;
  /* §22.2.6.10: the `source` of an empty pattern is `(?:)`, not the empty string -- so that
   * `/source/flags` is always a spelling that parses back. Normalized once, here, because every
   * reader of `source` (printing today, the `.source` property later) wants the same answer. */
  re->source = jsrt_string_length(source) == 0 ? jsrt_string_from_utf8("(?:)", 4) : source;
  /* Not the string the program wrote: §22.2.6.4 orders the flags, and every reader wants that
   * one answer. */
  re->flags = canonical_flags(lre_flags);
  re->lre_flags = lre_flags;
  re->last_index = 0;
  re->bytecode = bytecode;
  re->bytecode_len = bytecode_len;
  *out = JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)re);
  return true;
}

jsrt_value jsrt_regexp_new(jsrt_value source, jsrt_value flags) {
  /* The spec throws SyntaxError for either refusal. Every literal had its pattern and flags checked
   * at compile time, so this is a program that cannot work rather than data that happened to be
   * bad. */
  const int lre_flags = flags_to_lre(flags);
  if (lre_flags < 0) {
    jsrt_panic("STA2005: invalid regular expression flags");
  }
  char error[128];
  jsrt_value out = JSRT_UNDEFINED;
  if (!regexp_build(source, lre_flags, error, sizeof error, &out)) {
    char msg[224];
    snprintf(msg, sizeof msg, "STA2005: invalid regular expression: %s", error);
    jsrt_panic(msg);
  }
  return out;
}

/* The line terminators §22.2.6.13.1 makes EscapeRegExpPattern spell as escapes, by the letter that
 * follows the backslash: `\n`, `\r`, `\u2028`, `\u2029`. NULL for any other unit. */
static const char *line_terminator_escape(uint16_t unit) {
  switch (unit) {
    case 0x0A: return "n";
    case 0x0D: return "r";
    case 0x2028: return "u2028";
    case 0x2029: return "u2029";
    default: return NULL;
  }
}

/* EscapeRegExpPattern (§22.2.6.13.1) as V8 spells it, which is what the pinned Node prints: a `/`
 * outside a character class becomes `\/`, and a line terminator becomes its escape -- after a
 * backslash, the backslash is reused (`"\\\n"` reads back as `\n`). Everything else is copied, so
 * the result compiles to the pattern the program passed. */
static jsrt_value escape_pattern(jsrt_value pattern) {
  const JSString *str = (const JSString *)jsrt_ptr(pattern);
  /* `\u2028` is the longest spelling: six units for one. */
  uint16_t *out = (uint16_t *)malloc(((size_t)str->length * 6 + 1) * sizeof(uint16_t));
  if (out == NULL) {
    jsrt_panic("out of memory: regexp source");
  }
  uint32_t n = 0;
  bool in_class = false;
  for (uint32_t i = 0; i < str->length; i++) {
    const uint16_t unit = str->data[i];
    const char *escape = line_terminator_escape(unit);
    if (escape != NULL) {
      out[n++] = '\\';
      for (const char *c = escape; *c != '\0'; c++) {
        out[n++] = (uint16_t)*c;
      }
      continue;
    }
    if (unit == '\\' && i + 1 < str->length) {
      out[n++] = unit;
      const uint16_t next = str->data[i + 1];
      const char *escaped = line_terminator_escape(next);
      if (escaped != NULL) {
        for (const char *c = escaped; *c != '\0'; c++) {
          out[n++] = (uint16_t)*c;
        }
      } else {
        out[n++] = next;
      }
      i++;
      continue;
    }
    if (unit == '[') {
      in_class = true;
    } else if (unit == ']') {
      in_class = false;
    } else if (unit == '/' && !in_class) {
      out[n++] = '\\';
    }
    out[n++] = unit;
  }
  const jsrt_value escaped = jsrt_string_from_units(out, n);
  free(out);
  return escaped;
}

/* libregexp's reasons that name exactly one V8 reason, in V8's words (checked against the pinned
 * Node). A reason with more than one V8 counterpart (`unexpected end` is both `Unterminated
 * character class` and `\ at end of pattern`) keeps libregexp's wording; docs/VALUE.md §4.21. */
static const char *v8_reason(const char *reason) {
  static const char *const table[][2] = {
      {"expecting ')'", "Unterminated group"},
      {"extraneous characters at the end", "Unmatched ')'"},
      {"nothing to repeat", "Nothing to repeat"},
      {"invalid repetition count", "numbers out of order in {} quantifier"},
      {"duplicate group name", "Duplicate capture group name"},
      {"invalid group name", "Invalid capture group name"},
      {"invalid group", "Invalid group"},
      {"unknown unicode property name", "Invalid property name"},
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) {
    if (strcmp(reason, table[i][0]) == 0) {
      return table[i][1];
    }
  }
  return reason;
}

/* Throws `SyntaxError: <head><detail>` and answers undefined for the caller to return. */
static jsrt_value regexp_syntax_error(jsrt_value head, jsrt_value detail) {
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_string_concat(head, detail);
  jsrt_throw(jsrt_error_new(&jsrt_class_syntax_error, JSRT_LOCAL(0)));
  JSRT_FRAME_POP();
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_regexp_construct(jsrt_value pattern, jsrt_value flags) {
  JSRT_FRAME(3);
  /* §22.2.4.1 steps 4-5: a RegExp argument lends its source, and its flags when none are given. */
  if (jsrt_is_regexp(pattern)) {
    JSRT_LOCAL(1) = flags == JSRT_UNDEFINED ? jsrt_regexp_flags(pattern) : jsrt_to_string(flags);
    JSRT_LOCAL(0) = jsrt_regexp_source(pattern);
  } else {
    JSRT_LOCAL(0) = pattern == JSRT_UNDEFINED ? jsrt_string_from_utf8("", 0)
                                                : jsrt_to_string(pattern);
    JSRT_LOCAL(1) = flags == JSRT_UNDEFINED ? jsrt_string_from_utf8("", 0) : jsrt_to_string(flags);
  }
  jsrt_value out = JSRT_UNDEFINED;
  if (jsrt_pending()) {
    JSRT_FRAME_POP();
    return out;
  }
  const int lre_flags = flags_to_lre(JSRT_LOCAL(1));
  if (lre_flags < 0) {
    JSRT_LOCAL(2) = jsrt_string_concat(JSRT_LOCAL(1), jsrt_string_from_utf8("'", 1));
    regexp_syntax_error(jsrt_string_from_cstr("Invalid flags supplied to RegExp constructor '"),
                        JSRT_LOCAL(2));
    JSRT_FRAME_POP();
    return out;
  }
  JSRT_LOCAL(0) = escape_pattern(JSRT_LOCAL(0));
  char error[128];
  const bool built = regexp_build(JSRT_LOCAL(0), lre_flags, error, sizeof error, &out);
  if (!built) {
    /* V8's head, `/source/flags: `, then the reason, in V8's words where one maps to it. */
    JSRT_LOCAL(2) = jsrt_string_concat(jsrt_string_from_cstr("Invalid regular expression: /"),
                                       JSRT_LOCAL(0));
    JSRT_LOCAL(2) = jsrt_string_concat(JSRT_LOCAL(2), jsrt_string_from_cstr("/"));
    JSRT_LOCAL(2) = jsrt_string_concat(JSRT_LOCAL(2), canonical_flags(lre_flags));
    JSRT_LOCAL(2) = jsrt_string_concat(JSRT_LOCAL(2), jsrt_string_from_cstr(": "));
    regexp_syntax_error(JSRT_LOCAL(2), jsrt_string_from_cstr(v8_reason(error)));
  }
  JSRT_FRAME_POP();
  return built ? out : JSRT_UNDEFINED;
}

/* ============================================================================
 * Matching
 * ============================================================================ */

/* One match attempt at `start`, with the capture array the caller owns.
 *
 * `capture` must hold `lre_get_alloc_count` pointers, NOT twice the capture count: the executor
 * spills its own registers into the same array, and sizing it by the group count overruns the heap
 * on any pattern that uses one (upstream says so in a comment, having fixed exactly that bug).
 * A NULL buffer is a miss, not a crash: `lre_exec` writes `capture[i]` before it reads the
 * subject, and `capture_buffer` returns NULL when the header claims no captures and no registers.
 * `test` used to pass that pointer through while `search` refused it; both come through here.
 *
 * The subject needs no conversion: our strings ARE UTF-16 code units, which is what `cbuf_type` 1
 * means to the engine. It promotes that to 2 (pair surrogates) by itself for a unicode pattern. */
static bool exec_at(const JSRTRegExp *re, const JSString *subject, uint32_t start,
                    uint8_t **capture) {
  if (start > subject->length || capture == NULL) {
    return false;
  }
  const int rc = lre_exec(capture, re->bytecode, (const uint8_t *)subject->data, (int)start,
                          (int)subject->length, 1, NULL);
  if (rc < 0) {
    jsrt_panic(rc == LRE_RET_MEMORY_ERROR ? "out of memory: regexp match"
                                          : "STA2005: the regular expression engine gave up");
  }
  return rc == 1;
}

/* RegExp's empty-match advance is AdvanceStringIndex, not simply `index + 1`: a unicode pattern
 * must skip a surrogate pair as one code point.  Calling lre_exec at the low surrogate would make
 * the engine rewind to the pair's high surrogate and report the same empty match forever. */
static uint32_t advance_string_index(const JSString *s, uint32_t index, bool unicode) {
  if (unicode && index < s->length && s->length - index > 1) {
    const uint16_t first = s->data[index];
    const uint16_t second = s->data[index + 1];
    if (first >= 0xD800u && first <= 0xDBFFu && second >= 0xDC00u && second <= 0xDFFFu) {
      return index + 2;
    }
  }
  return index + 1;
}

/* The capture array the executor writes into, sized the way it demands. Freed by the caller. */
static uint8_t **capture_buffer(const JSRTRegExp *re) {
  const int count = lre_get_alloc_count(re->bytecode);
  if (count <= 0) {
    return NULL;
  }
  uint8_t **capture = (uint8_t **)malloc(sizeof(uint8_t *) * (size_t)count);
  if (capture == NULL) {
    jsrt_panic("out of memory: regexp captures");
  }
  return capture;
}

bool jsrt_regexp_test(jsrt_value re_value, jsrt_value str) {
  /* The gate accepts an UNTYPED subject -- in js mode that is the norm -- so the string tag is
   * settled here, jsrt_json_parse's rule: ToString of anything else is a conversion this bridge
   * does not perform, and reading a non-string as UTF-16 units would fault or answer nonsense. */
  if (!jsrt_is(str, JSRT_TAG_STRING)) {
    jsrt_panic("STA2005: RegExp.prototype.test of a value that is not a string is not yet supported");
  }
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  const JSString *subject = (const JSString *)jsrt_ptr(str);
  /* `lastIndex` is read only by a /g or /y pattern, and written back by one whatever the outcome:
   * a failed match resets it to 0, which is what makes `while (re.test(s))` terminate. */
  const bool stateful = (re->lre_flags & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
  const uint32_t start = stateful ? re->last_index : 0;

  uint8_t **capture = capture_buffer(re);
  const bool matched = exec_at(re, subject, start, capture);
  if (stateful) {
    re->last_index =
        matched && capture != NULL
            ? (uint32_t)((const uint16_t *)capture[1] - subject->data)
            : 0;
  }
  free(capture);
  return matched;
}

/* ============================================================================
 * Scanning — the one engine under search, split and replace
 * ============================================================================ */

/* A capture group that did not participate. Distinguishable from index 0, which is a real
 * position; the spec's own answer for one is `undefined`. */
#define NO_GROUP UINT32_MAX

/* Every match of a pattern in a subject, flattened: `ncap` groups per match with two offsets each,
 * group 0 being the whole match. Plain data -- no jsrt_value ever lands here -- so it is malloc'd
 * and a collector need never see it. */
typedef struct {
  uint32_t *bounds;
  uint32_t count;
  uint32_t cap;
  uint32_t ncap;
} Matches;

static const uint32_t *match_of(const Matches *m, uint32_t i) {
  return m->bounds + (size_t)i * 2 * (size_t)m->ncap;
}

static void matches_push(Matches *m, const JSString *s, uint8_t *const *capture) {
  if (m->count == m->cap) {
    m->cap = m->cap == 0 ? 8 : m->cap * 2;
    uint32_t *grown =
        (uint32_t *)realloc(m->bounds, (size_t)m->cap * 2 * (size_t)m->ncap * sizeof(uint32_t));
    if (grown == NULL) {
      jsrt_panic("out of memory: regexp matches");
    }
    m->bounds = grown;
  }
  uint32_t *slot = m->bounds + (size_t)m->count * 2 * (size_t)m->ncap;
  for (uint32_t g = 0; g < m->ncap; g++) {
    const uint16_t *begin = (const uint16_t *)capture[2 * g];
    const uint16_t *end = (const uint16_t *)capture[2 * g + 1];
    slot[2 * g] = begin == NULL ? NO_GROUP : (uint32_t)(begin - s->data);
    slot[2 * g + 1] = end == NULL ? NO_GROUP : (uint32_t)(end - s->data);
  }
  m->count++;
}

/* Left-to-right, non-overlapping matches from `from`, at most `limit` of them.
 *
 * An EMPTY match advances the scan by one code unit -- §22.2.5.8's AdvanceStringIndex -- which is
 * also the only thing that stops the scan from standing still. `walk` is the difference between
 * the two loops the spec actually writes: a failed attempt ends the scan for RegExpExec (a
 * forward search has already looked at every later position), but `@@split` retries at the next
 * position, because its splitter is STICKY and an attempt therefore only looked where it stood.
 * A user pattern that is already sticky needs the same retry for the same reason. */
static Matches scan(const JSRTRegExp *re, const JSString *s, uint32_t from, uint32_t limit,
                    bool walk) {
  const bool sticky = (re->lre_flags & LRE_FLAG_STICKY) != 0;
  const bool unicode = (re->lre_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  Matches out = {NULL, 0, 0, (uint32_t)lre_get_capture_count(re->bytecode)};
  uint8_t **capture = capture_buffer(re);
  uint32_t at = from;
  while (out.count < limit && at <= s->length && capture != NULL) {
    if (!exec_at(re, s, at, capture)) {
      if (!(walk && sticky)) {
        break;
      }
      at = advance_string_index(s, at, unicode);
      continue;
    }
    matches_push(&out, s, capture);
    const uint32_t *m = match_of(&out, out.count - 1);
    at = m[1] > m[0] ? m[1] : advance_string_index(s, m[0], unicode);
  }
  free(capture);
  return out;
}

static void matches_free(Matches *m) { free(m->bounds); }

/* The gate accepts an UNTYPED subject -- in js mode that is the norm -- so the string tag is
 * settled here, jsrt_json_parse's rule: ToString of anything else is a conversion this bridge does
 * not perform, and reading a non-string as UTF-16 units would fault or answer nonsense. */
static const JSString *subject_of(jsrt_value str, const char *method) {
  if (!jsrt_is(str, JSRT_TAG_STRING)) {
    char msg[128];
    snprintf(msg, sizeof msg,
             "STA2005: String.prototype.%s of a value that is not a string is not yet supported",
             method);
    jsrt_panic(msg);
  }
  return (const JSString *)jsrt_ptr(str);
}

/* ============================================================================
 * The regexp-taking String.prototype methods (§22.2.5)
 * ============================================================================ */

jsrt_value jsrt_regexp_search(jsrt_value re_value, jsrt_value str) {
  const JSString *s = subject_of(str, "search");
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  /* §22.2.5.9: `lastIndex` is saved, forced to 0 for the attempt, and put back. `search` answers a
   * position, never a cursor -- so unlike `test`, it leaves no state behind. */
  const uint32_t saved = re->last_index;
  re->last_index = 0;
  uint8_t **capture = capture_buffer(re);
  /* NULL is a miss inside `exec_at` (it is the only caller of `lre_exec`), same as `test`. */
  const bool hit = exec_at(re, s, 0, capture);
  const double at = hit ? (double)((const uint16_t *)capture[0] - s->data) : -1;
  free(capture);
  re->last_index = saved;
  return jsrt_number(at);
}

/* One capture group as a value: the substring it covers, or `undefined` where it did not
 * participate -- which is what `'ab'.split(/(x)?b/)` puts in the middle of its answer. */
static jsrt_value group_value(const JSString *s, const uint32_t *m, uint32_t g) {
  return m[2 * g] == NO_GROUP ? JSRT_UNDEFINED
                              : jsrt_string_from_units(s->data + m[2 * g], m[2 * g + 1] - m[2 * g]);
}

/* The `groups` object of a match: the named capture groups, or `undefined` when the pattern has
 * none -- §22.2.7.2 step 29 makes it `undefined` in exactly that case, and Node prints it.
 *
 * `lre_get_groupnames` answers one entry PER CAPTURE GROUP from group 1 up, each a NUL-terminated
 * name (empty where the group is unnamed) followed by a scope byte -- `LRE_GROUP_NAME_TRAILER_LEN`
 * is 2, not 1, and striding by one lands mid-entry and loses every name after the first. It is NULL
 * unless the pattern declared at least one name, which is the condition step 29 itself tests. */
static jsrt_value match_groups(const JSRTRegExp *re, const JSString *s, const uint32_t *m,
                               uint32_t ncap) {
  const char *names = lre_get_groupnames(re->bytecode);
  if (names == NULL) {
    return JSRT_UNDEFINED;
  }
  /* `group_value` builds strings below, so the object being filled must be rooted. */
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_null_proto_new();
  for (uint32_t g = 1; g < ncap; g++) {
    if (names[0] != '\0') {
      /* The name is stored on the groups object's shape. Intern it: a second match of the
       * same pattern builds a fresh object whose transition REUSES the existing child, and
       * a raw malloc there would leak (T16). The bytecode's copy stays the engine's. */
      const size_t n = strlen(names);
      char *key = (char *)malloc(n + 1);
      if (key == NULL) {
        jsrt_panic("out of memory: group name");
      }
      memcpy(key, names, n + 1);
      jsrt_set_prop(JSRT_LOCAL(0), jsrt_shape_intern(key), group_value(s, m, g), NULL);
    }
    names += strlen(names) + LRE_GROUP_NAME_TRAILER_LEN;
  }
  const jsrt_value groups = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return groups;
}

/* The match array §22.2.7.2 builds: element 0 the whole match, element g each group (or
 * `undefined` where it did not participate), carrying `index`, `input` and `groups` as PROPERTIES.
 * That last part is the whole reason a jsrt array has a property table at all. */
static jsrt_value match_array(const JSRTRegExp *re, const JSString *s, jsrt_value str,
                              const uint32_t *m, uint32_t ncap) {
  /* The half-built array is reachable from NOTHING: it is a local, and a NaN-boxed local is
   * invisible to the collector (docs/VALUE.md §4.1, jsrt_gc.zig's own header). Every call below --
   * jsrt_array_push, jsrt_string_new for a group, match_groups and jsrt_set_prop -- can allocate
   * and collect, so the array has to sit in a rooted slot for as long as it is being built.
   * `str` is a parameter, so it is already a root. Without this, `s.match(re)` in a loop returned
   * an array whose `length` was whatever the allocator later wrote there (measured: 49314864). */
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_array_new(0, NULL);
  for (uint32_t g = 0; g < ncap; g++) {
    jsrt_array_push(JSRT_LOCAL(0), group_value(s, m, g));
  }
  /* Insertion order is the spec's own creation order, and it is what console.log prints. */
  jsrt_set_prop(JSRT_LOCAL(0), "index", jsrt_number((double)m[0]), NULL);
  jsrt_set_prop(JSRT_LOCAL(0), "input", str, NULL);
  jsrt_set_prop(JSRT_LOCAL(0), "groups", match_groups(re, s, m, ncap), NULL);
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

jsrt_value jsrt_regexp_exec(jsrt_value re_value, jsrt_value str) {
  const JSString *s = subject_of(str, "exec");
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  /* Identical `lastIndex` handling to `test`, because RegExpBuiltinExec is what test runs too: a
   * /g or /y pattern resumes from the cursor and resets it to 0 on a failure. */
  const bool stateful = (re->lre_flags & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
  Matches m = scan(re, s, stateful ? re->last_index : 0, 1, false);
  if (m.count == 0) {
    matches_free(&m);
    if (stateful) {
      re->last_index = 0;
    }
    return JSRT_NULL;
  }
  const uint32_t *hit = match_of(&m, 0);
  if (stateful) {
    re->last_index = hit[1];
  }
  const jsrt_value out = match_array(re, s, str, hit, m.ncap);
  matches_free(&m);
  return out;
}

jsrt_value jsrt_regexp_match(jsrt_value re_value, jsrt_value str) {
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  if ((re->lre_flags & LRE_FLAG_GLOBAL) == 0) {
    return jsrt_regexp_exec(re_value, str); /* §22.2.5.6 step 5: without /g, match IS exec */
  }
  const JSString *s = subject_of(str, "match");
  /* With /g the cursor is reset FIRST and left at 0, and the answer is built by CreateArrayFromList
   * -- a plain array of whole-match strings, with no `index`/`input`/`groups` on it. */
  re->last_index = 0;
  Matches m = scan(re, s, 0, UINT32_MAX, false);
  if (m.count == 0) {
    matches_free(&m);
    return JSRT_NULL;
  }
  /* Rooted while the loop builds it: group_value allocates per match. */
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; i < m.count; i++) {
    jsrt_array_push(JSRT_LOCAL(0), group_value(s, match_of(&m, i), 0));
  }
  matches_free(&m);
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

jsrt_value jsrt_regexp_match_all(jsrt_value re_value, jsrt_value str) {
  /* Tag-check the subject the same way exec/match do, before cloning anything. */
  (void)subject_of(str, "matchAll");
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  if ((re->lre_flags & LRE_FLAG_GLOBAL) == 0) {
    jsrt_panic("STA2005: String.prototype.matchAll requires a global regular expression; the spec "
               "throws TypeError, which builtins cannot raise yet");
  }
  /* @@matchAll clones the matcher so walking the iterator cannot mutate the original lastIndex. */
  jsrt_value clone = jsrt_regexp_new(re->source, re->flags);
  jsrt_as_regexp(clone)->last_index = re->last_index;
  return jsrt_iterator_match_all_new(str, clone);
}

bool jsrt_regexp_match_all_step(jsrt_value re_value, jsrt_value str, jsrt_value *out) {
  jsrt_value hit = jsrt_regexp_exec(re_value, str);
  if (hit == JSRT_NULL) {
    return false;
  }
  /* Spec: an empty match still yields, then AdvanceStringIndex so the next exec cannot spin. */
  const JSRTArray *a = jsrt_as_array(hit);
  const jsrt_value whole = a->length > 0 ? a->elements[0] : JSRT_UNDEFINED;
  if (jsrt_is(whole, JSRT_TAG_STRING) && jsrt_string_length(whole) == 0) {
    JSRTRegExp *re = jsrt_as_regexp(re_value);
    const JSString *s = (const JSString *)jsrt_ptr(str);
    const bool unicode = (re->lre_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
    re->last_index = advance_string_index(s, re->last_index, unicode);
  }
  *out = hit;
  return true;
}

jsrt_value jsrt_regexp_split(jsrt_value re_value, jsrt_value str) {
  const JSString *s = subject_of(str, "split");
  const JSRTRegExp *re = jsrt_as_regexp(re_value);
  /* Every push below builds a string first, so the array being filled is rooted for the whole
   * algorithm -- including the two early returns, which pop the frame. */
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_array_new(0, NULL);

  /* §22.2.5.14 step 14: the empty subject answers [] when the pattern matches it and [""] when it
   * does not. It is the one asymmetry in the algorithm, and it falls out of nothing below. */
  if (s->length == 0) {
    Matches probe = scan(re, s, 0, 1, true);
    if (probe.count == 0) {
      jsrt_array_push(JSRT_LOCAL(0), str);
    }
    matches_free(&probe);
    const jsrt_value empty = JSRT_LOCAL(0);
    JSRT_FRAME_POP();
    return empty;
  }

  Matches m = scan(re, s, 0, UINT32_MAX, true);
  uint32_t p = 0;
  for (uint32_t i = 0; i < m.count; i++) {
    const uint32_t *g = match_of(&m, i);
    /* The spec's loop is `while q < size`, so a match starting AT the end is never attempted --
     * which is the whole reason `'abc'.split(/(?:)/)` is three elements and not four. The scan
     * finds it because a match at the end is a real match; split alone must not see it. */
    if (g[0] >= s->length) {
      break;
    }
    /* A match ending exactly where the last segment ended contributes nothing: the spec steps past
     * it rather than emitting an empty piece, which is what keeps a pattern that can match the
     * empty string from filling the answer with empty strings. */
    if (g[1] == p) {
      continue;
    }
    jsrt_array_push(JSRT_LOCAL(0), jsrt_string_from_units(s->data + p, g[0] - p));
    /* Capture groups are part of the ANSWER here, not just of the match: `'a1b'.split(/(\d)/)`
     * is ['a', '1', 'b']. */
    for (uint32_t k = 1; k < m.ncap; k++) {
      jsrt_array_push(JSRT_LOCAL(0), group_value(s, g, k));
    }
    p = g[1];
  }
  matches_free(&m);
  jsrt_array_push(JSRT_LOCAL(0), jsrt_string_from_units(s->data + p, s->length - p));
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

/* ---------------------------------------------------------------- replace */

/* A growable UTF-16 buffer for the replacement's output. Plain malloc: it holds no jsrt_value, so
 * the collector never needs to see it, and it is freed before the result string is boxed. */
typedef struct {
  uint16_t *units;
  uint32_t len;
  uint32_t cap;
} Out;

static void out_units(Out *o, const uint16_t *src, uint32_t n) {
  /* Appending NOTHING is a real case -- an empty replacement, a `$&` for a zero-length match, the
   * tail after a match that ended at the last unit -- and it has to return before the arithmetic
   * below. Until the first grow, `o->units` is NULL, and both `NULL + 0` and a zero-length memcpy
   * with a null argument are undefined (C11 §7.24.1p2), which UBSan reports as "applying zero
   * offset to null pointer". It fires only where the sanitizer looks, so it cost a green local run
   * and a red macOS CI job to find. */
  if (n == 0) {
    return;
  }
  if (o->len + n > o->cap) {
    uint32_t want = o->cap == 0 ? 32 : o->cap;
    while (want < o->len + n) {
      want *= 2;
    }
    uint16_t *grown = (uint16_t *)realloc(o->units, (size_t)want * sizeof(uint16_t));
    if (grown == NULL) {
      jsrt_panic("out of memory: regexp replace");
    }
    o->units = grown;
    o->cap = want;
  }
  memcpy(o->units + o->len, src, (size_t)n * sizeof(uint16_t));
  o->len += n;
}

/* Decode one UTF-8 sequence of a group NAME into a code point. Names arrive in the
 * encoding the pattern was compiled from -- CESU-8 for a non-unicode pattern, plain UTF-8
 * otherwise -- so a surrogate half decodes as itself, exactly the unit the replacement slice
 * below carries, and the two sides meet without a conversion allocation. */
static bool name_step(const char **p, const char *end, uint32_t *cp) {
  const unsigned char b0 = (unsigned char)**p;
  if (b0 < 0x80u) {
    *cp = b0;
    (*p)++;
    return true;
  }
  uint32_t out = 0;
  uint32_t want = 0;
  if ((b0 & 0xE0u) == 0xC0u) {
    out = b0 & 0x1Fu;
    want = 1;
  } else if ((b0 & 0xF0u) == 0xE0u) {
    out = b0 & 0x0Fu;
    want = 2;
  } else if ((b0 & 0xF8u) == 0xF0u) {
    out = b0 & 0x07u;
    want = 3;
  } else {
    return false;
  }
  if ((size_t)(end - *p) < (size_t)(want + 1)) {
    return false;
  }
  for (uint32_t i = 0; i < want; i++) {
    const unsigned char b = (unsigned char)(*p)[1 + i];
    if ((b & 0xC0u) != 0x80u) {
      return false;
    }
    out = (out << 6) | (b & 0x3Fu);
  }
  *p += want + 1;
  *cp = out;
  return true;
}

/* Decode one replacement-slice unit into a code point, pairing surrogates the way the
 * language pairs them. A lone half is itself, which is what meets a CESU-8 name above. */
static bool slice_step(const uint16_t **p, const uint16_t *end, uint32_t *cp) {
  const uint16_t first = **p;
  if (first >= 0xD800u && first <= 0xDBFFu && *p + 1 < end) {
    const uint16_t second = (*p)[1];
    if (second >= 0xDC00u && second <= 0xDFFFu) {
      *cp = 0x10000u + ((uint32_t)(first - 0xD800u) << 10) + (uint32_t)(second - 0xDC00u);
      *p += 2;
      return true;
    }
  }
  *cp = first;
  (*p)++;
  return true;
}

/* Whether a NUL-terminated group name spells the replacement slice `$<...>` named, compared as
 * code points so an astral name meets its pair and a CESU-8 half meets its lone unit. */
static bool group_name_matches(const char *name, const uint16_t *units, uint32_t n) {
  const char *p = name;
  const char *end = name + strlen(name);
  const uint16_t *q = units;
  const uint16_t *qend = units + n;
  for (;;) {
    if (p == end) {
      return q == qend;
    }
    if (q == qend) {
      return false;
    }
    uint32_t a = 0;
    uint32_t b = 0;
    if (!name_step(&p, end, &a) || !slice_step(&q, qend, &b) || a != b) {
      return false;
    }
  }
}

/* §22.1.3.19 GetSubstitution over ONE match. `$$` `$&` `` $` `` `$'` are the string forms the
 * plain-pattern replace already implements; `$n`/`$nn` are the ones only a pattern with groups
 * can answer, and a number above the group count stays LITERAL, which is what makes `$1` in a
 * groupless pattern print as `$1`. */
static void substitute(Out *o, const JSRTRegExp *re, const JSString *rep, const JSString *s, const Matches *m,
                       const uint32_t *g) {
  for (uint32_t k = 0; k < rep->length; k++) {
    if (rep->data[k] != '$' || k + 1 >= rep->length) {
      out_units(o, rep->data + k, 1);
      continue;
    }
    const uint16_t next = rep->data[k + 1];
    if (next == '$') {
      out_units(o, rep->data + k, 1);
      k++;
    } else if (next == '<') {
      /* `$<name>`: the name runs to the FIRST `>` whatever it holds -- `$<x-y>` and `$<>`
       * substitute-or-empty exactly like `$<xx>` (measured on the pinned Node, plan.md §8
       * step 21c). With no `>` at all, or a pattern declaring no named groups, the `$` is
       * literal and scanning resumes after it, which is what keeps `$<x>` whole in a
       * groupless pattern. An unknown or unmatched name is EMPTY, not literal. */
      uint32_t close = k + 2;
      while (close < rep->length && rep->data[close] != '>') {
        close++;
      }
      /* NULL unless the pattern declared at least one name -- the same condition
       * `match_groups` tests for the `groups` object. */
      const char *names = lre_get_groupnames(re->bytecode);
      if (close >= rep->length || names == NULL) {
        out_units(o, rep->data + k, 1);
        continue;
      }
      /* Duplicate names live on disjoint alternatives, so at most one same-named group took
       * part in this match: the participating one wins, and a name none took part under --
       * known or not -- appends nothing. */
      for (uint32_t grp = 1; grp < m->ncap; grp++) {
        if (names[0] != '\0' &&
            group_name_matches(names, rep->data + k + 2, close - (k + 2)) &&
            g[2 * grp] != NO_GROUP) {
          out_units(o, s->data + g[2 * grp], g[2 * grp + 1] - g[2 * grp]);
          break;
        }
        names += strlen(names) + LRE_GROUP_NAME_TRAILER_LEN;
      }
      k = close;
    } else if (next == '&') {
      out_units(o, s->data + g[0], g[1] - g[0]);
      k++;
    } else if (next == '`') {
      out_units(o, s->data, g[0]);
      k++;
    } else if (next == '\'') {
      out_units(o, s->data + g[1], s->length - g[1]);
      k++;
    } else if (next >= '0' && next <= '9') {
      /* Two digits win over one where both name a real group -- `$12` is group 12 when the
       * pattern has twelve, and group 1 followed by a '2' when it does not. */
      uint32_t group = (uint32_t)(next - '0');
      uint32_t width = 1;
      if (k + 2 < rep->length && rep->data[k + 2] >= '0' && rep->data[k + 2] <= '9') {
        const uint32_t two = group * 10 + (uint32_t)(rep->data[k + 2] - '0');
        if (two > 0 && two < m->ncap) {
          group = two;
          width = 2;
        }
      }
      if (group == 0 || group >= m->ncap) {
        out_units(o, rep->data + k, 1);
        continue;
      }
      if (g[2 * group] != NO_GROUP) {
        out_units(o, s->data + g[2 * group], g[2 * group + 1] - g[2 * group]);
      }
      k += width;
    } else {
      out_units(o, rep->data + k, 1);
    }
  }
}

jsrt_value jsrt_regexp_replace(jsrt_value re_value, jsrt_value str, jsrt_value replacement,
                               bool all) {
  const JSString *s = subject_of(str, all ? "replaceAll" : "replace");
  JSRTRegExp *re = jsrt_as_regexp(re_value);
  const JSString *rep = subject_of(replacement, all ? "replaceAll" : "replace");
  const bool global = (re->lre_flags & LRE_FLAG_GLOBAL) != 0;
  const bool sticky = (re->lre_flags & LRE_FLAG_STICKY) != 0;

  /* §22.1.3.20 step 2: replaceAll demands a /g pattern. The spec throws TypeError; builtins cannot
   * raise yet, so this aborts loudly rather than quietly behaving like `replace`. */
  if (all && !global) {
    jsrt_panic("STA2005: replaceAll with a non-global regular expression; the spec throws "
               "TypeError, which builtins cannot raise yet");
  }
  /* §22.2.5.11 step 6: a global pattern restarts at 0 and ends at 0. A non-global one reads and
   * writes `lastIndex` only when it is sticky -- that is RegExpBuiltinExec's rule, not @@replace's,
   * which is why a plain /re/ ignores the cursor entirely. */
  if (global) {
    re->last_index = 0;
  }
  const uint32_t from = (global || sticky) ? re->last_index : 0;
  Matches m = scan(re, s, from, global ? UINT32_MAX : 1, false);
  if (global) {
    re->last_index = 0;
  } else if (sticky) {
    re->last_index = m.count > 0 ? match_of(&m, 0)[1] : 0;
  }

  if (m.count == 0) {
    matches_free(&m);
    return str;
  }
  Out o = {NULL, 0, 0};
  uint32_t tail = 0;
  for (uint32_t i = 0; i < m.count; i++) {
    const uint32_t *g = match_of(&m, i);
    out_units(&o, s->data + tail, g[0] - tail);
    substitute(&o, re, rep, s, &m, g);
    tail = g[1];
  }
  out_units(&o, s->data + tail, s->length - tail);
  matches_free(&m);
  jsrt_value result = jsrt_string_from_units(o.units, o.len);
  free(o.units);
  return result;
}
