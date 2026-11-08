/* jsrt_unicode.c -- the bridge to the vendored libunicode tables.
 *
 * `runtime/vendor/quickjs-ng` arrived with libregexp (Task 4.3), and libunicode came with it: the
 * engine needs case folding and character classes, and those are the same tables `toUpperCase`,
 * `toLowerCase` and `normalize` need. Until this file existed, case mapping above ASCII aborted
 * loudly rather than answer wrongly (the STA2005 pattern) -- an honest placeholder for legal
 * source, and one this file retires.
 *
 * Everything here works in CODE POINTS, not code units: case mapping is defined on code points,
 * one of them can map to three, and normalization reorders and composes them. A lone surrogate is
 * a legal JS string and passes through untouched, which is what keeps the round trip total. */

#include "jsrt.h"
#include "jsrt_value.h"
#include "jsrt_utf.h"

#include "libunicode.h"

#include <stdlib.h>
#include <string.h>

/* libregexp's allocator, which libunicode's normalizer takes the same way the compiler does.
 * Declared here rather than included: libregexp.h is the regexp engine's header, and this file
 * has no business with the rest of it. */
void *lre_realloc(void *opaque, void *ptr, size_t size);

/* One code point per element. A surrogate PAIR becomes one; a LONE surrogate stays as it is,
 * because a JS string may legally hold one and neither operation below is entitled to drop it. */
static uint32_t *to_code_points(const JSString *s, uint32_t *out_len) {
  uint32_t *cps = (uint32_t *)malloc((size_t)(s->length == 0 ? 1 : s->length) * sizeof(uint32_t));
  if (cps == NULL) {
    jsrt_panic("out of memory: unicode");
  }
  uint32_t n = 0;
  for (uint32_t i = 0; i < s->length; i++) {
    cps[n++] = jsrt_utf16_code_point(s->data, s->length, &i);
  }
  *out_len = n;
  return cps;
}

/* One code point back into UTF-16, answering how many units it took. */
static uint32_t put_code_point(uint16_t *dst, uint32_t at, uint32_t cp) {
  if (cp < 0x10000u) {
    dst[at] = (uint16_t)cp;
    return at + 1;
  }
  const uint32_t rest = cp - 0x10000u;
  dst[at] = (uint16_t)(0xD800u + (rest >> 10));
  dst[at + 1] = (uint16_t)(0xDC00u + (rest & 0x3FFu));
  return at + 2;
}

static jsrt_value units_to_string(const uint16_t *units, uint32_t len) {
  return jsrt_string_from_units(units, len);
}

/* --- Case mapping (§22.1.3.28, §22.1.3.30) --- */

/* Unicode SpecialCasing's Final_Sigma condition, the one context-dependent rule ECMA-262 keeps
 * (§22.1.3.28 defers to the Unicode Default Case Conversion, which includes it): a capital sigma
 * lowercases to the FINAL form when a cased character precedes it and none follows, in both
 * directions skipping case-ignorable characters. `Σ` at the end of a word is `ς`; in the middle it
 * is `σ`. libunicode answers both predicates, which is the only reason they are exported. */
static bool final_sigma(const uint32_t *cps, uint32_t len, uint32_t at) {
  uint32_t i = at;
  bool before = false;
  while (i > 0) {
    i--;
    if (lre_is_case_ignorable(cps[i])) {
      continue;
    }
    before = lre_is_cased(cps[i]);
    break;
  }
  if (!before) {
    return false;
  }
  for (uint32_t k = at + 1; k < len; k++) {
    if (lre_is_case_ignorable(cps[k])) {
      continue;
    }
    return !lre_is_cased(cps[k]);
  }
  return true;
}

#define GREEK_CAPITAL_SIGMA 0x03A3u
#define GREEK_FINAL_SIGMA 0x03C2u

jsrt_value jsrt_unicode_case(jsrt_value s, bool upper) {
  const JSString *str = (const JSString *)jsrt_ptr(s);
  uint32_t len = 0;
  uint32_t *cps = to_code_points(str, &len);
  /* Worst case: LRE_CC_RES_LEN_MAX code points out per code point in, two UTF-16 units each. The
   * buffer is sized for it once rather than grown, because the bound is small and exact. */
  const size_t room = (size_t)(len == 0 ? 1 : len) * LRE_CC_RES_LEN_MAX * 2;
  uint16_t *out = (uint16_t *)malloc(room * sizeof(uint16_t));
  if (out == NULL) {
    jsrt_panic("out of memory: unicode case mapping");
  }
  uint32_t at = 0;
  for (uint32_t i = 0; i < len; i++) {
    if (!upper && cps[i] == GREEK_CAPITAL_SIGMA && final_sigma(cps, len, i)) {
      at = put_code_point(out, at, GREEK_FINAL_SIGMA);
      continue;
    }
    uint32_t mapped[LRE_CC_RES_LEN_MAX];
    const int count = lre_case_conv(mapped, cps[i], upper ? 0 : 1);
    for (int k = 0; k < count; k++) {
      at = put_code_point(out, at, mapped[k]);
    }
  }
  free(cps);
  jsrt_value result = units_to_string(out, at);
  free(out);
  return result;
}

/* --- Normalization (§22.1.3.15) --- */

static UnicodeNormalizationEnum form_of(jsrt_value form) {
  /* An absent form is NFC. The lowering pads the omitted argument with `undefined`, which the spec
   * treats as absent here -- the same equivalence every other padded string op rests on. */
  if (form == JSRT_UNDEFINED) {
    return UNICODE_NFC;
  }
  if (!jsrt_is(form, JSRT_TAG_STRING)) {
    jsrt_panic("STA2005: normalize with a form that is not a string is not yet supported");
  }
  static const struct {
    const char *name;
    UnicodeNormalizationEnum value;
  } FORMS[] = {
      {"NFC", UNICODE_NFC},
      {"NFD", UNICODE_NFD},
      {"NFKC", UNICODE_NFKC},
      {"NFKD", UNICODE_NFKD},
  };
  const uint32_t len = jsrt_string_length(form);
  for (size_t f = 0; f < sizeof FORMS / sizeof FORMS[0]; f++) {
    const size_t want = strlen(FORMS[f].name);
    if (len != want) {
      continue;
    }
    bool same = true;
    for (uint32_t i = 0; i < len && same; i++) {
      same = jsrt_string_char(form, i) == (uint16_t)FORMS[f].name[i];
    }
    if (same) {
      return FORMS[f].value;
    }
  }
  /* §22.1.3.15 step 4 throws RangeError for anything else; builtins cannot raise yet, so this
   * aborts loudly rather than normalizing to a form the program did not ask for. */
  jsrt_panic("STA2005: normalize must be given NFC, NFD, NFKC or NFKD; the spec throws RangeError, "
             "which builtins cannot raise yet");
}

jsrt_value jsrt_unicode_normalize(jsrt_value s, jsrt_value form) {
  const UnicodeNormalizationEnum kind = form_of(form);
  const JSString *str = (const JSString *)jsrt_ptr(s);
  uint32_t len = 0;
  uint32_t *cps = to_code_points(str, &len);
  uint32_t *dst = NULL;
  const int out_len = unicode_normalize(&dst, cps, (int)len, kind, NULL, lre_realloc);
  free(cps);
  if (out_len < 0) {
    jsrt_panic("out of memory: normalize");
  }
  /* Two UTF-16 units per code point is the exact worst case, and NFC never produces more code
   * points than NFD does -- but the normalizer's own answer is what is sized against, not the
   * input, because a decomposition is longer than what it came from. */
  uint16_t *out = (uint16_t *)malloc((size_t)(out_len == 0 ? 1 : out_len) * 2 * sizeof(uint16_t));
  if (out == NULL) {
    jsrt_panic("out of memory: normalize");
  }
  uint32_t at = 0;
  for (int i = 0; i < out_len; i++) {
    at = put_code_point(out, at, dst[i]);
  }
  lre_realloc(NULL, dst, 0);
  jsrt_value result = units_to_string(out, at);
  free(out);
  return result;
}
