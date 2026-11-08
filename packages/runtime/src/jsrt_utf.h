/* UTF-16 to UTF-8, shared by every runtime path that turns a JS string into bytes: printing,
 * JSON, FFI CStrings, regexp patterns, shape keys, the code-point walks of the Unicode methods.
 * An internal header, not part of the codegen↔runtime contract in jsrt_value.h. */
#ifndef JSRT_UTF_H
#define JSRT_UTF_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The code point at `units[*i]` of `len`: a valid surrogate pair combines into one and moves `*i`
 * onto its trail unit; any other unit, a lone surrogate included, is answered as itself. */
static inline uint32_t jsrt_utf16_code_point(const uint16_t *units, uint32_t len, uint32_t *i) {
  const uint32_t lead = units[*i];
  if (lead >= 0xD800u && lead <= 0xDBFFu && *i + 1 < len) {
    const uint32_t trail = units[*i + 1];
    if (trail >= 0xDC00u && trail <= 0xDFFFu) {
      *i += 1;
      return 0x10000u + ((lead - 0xD800u) << 10) + (trail - 0xDC00u);
    }
  }
  return lead;
}

/* Well-formed UTF-8 has no encoding for a surrogate code point: the paths that must emit it (FFI,
 * printing) substitute U+FFFD, the replacement character. */
static inline uint32_t jsrt_utf16_scalar(uint32_t cp) {
  return cp >= 0xD800u && cp <= 0xDFFFu ? 0xFFFDu : cp;
}

/* `cp` as one to four UTF-8 bytes at `out`; answers how many. */
static inline size_t jsrt_utf8_encode(uint32_t cp, char *out) {
  if (cp < 0x80u) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800u) {
    out[0] = (char)(0xC0u | (cp >> 6));
    out[1] = (char)(0x80u | (cp & 0x3Fu));
    return 2;
  }
  if (cp < 0x10000u) {
    out[0] = (char)(0xE0u | (cp >> 12));
    out[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[2] = (char)(0x80u | (cp & 0x3Fu));
    return 3;
  }
  out[0] = (char)(0xF0u | (cp >> 18));
  out[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
  out[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
  out[3] = (char)(0x80u | (cp & 0x3Fu));
  return 4;
}

/* `units` as a NUL-terminated C string of at most buflen bytes, one byte per unit: only for text
 * known to be ASCII, such as ToString of a number or a boolean in an error message. */
static inline void jsrt_utf16_to_ascii(const uint16_t *units, uint32_t len, char *buf,
                                       size_t buflen) {
  size_t i = 0;
  for (; i < len && i + 1 < buflen; i++) {
    buf[i] = (char)units[i];
  }
  buf[i] = '\0';
}

/* `units` as NUL-terminated UTF-8 at `out`, stopping before the first U+0000, which a C string
 * cannot hold; answers whether it stopped there. Three bytes a unit plus the NUL is always room:
 * a pair takes four bytes for two units. `scalar` writes U+FFFD for a lone surrogate, which
 * well-formed UTF-8 cannot encode; otherwise it is encoded as itself. */
static inline bool jsrt_utf16_to_cstr(const uint16_t *units, uint32_t len, bool scalar, char *out) {
  size_t n = 0;
  bool stopped = false;
  for (uint32_t i = 0; i < len; i++) {
    const uint32_t cp = jsrt_utf16_code_point(units, len, &i);
    if (cp == 0) {
      stopped = true;
      break;
    }
    n += jsrt_utf8_encode(scalar ? jsrt_utf16_scalar(cp) : cp, out + n);
  }
  out[n] = '\0';
  return stopped;
}

#endif
