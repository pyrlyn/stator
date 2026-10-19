/* print_ffi_strings.c — the FFI string conversions, both directions (docs/FFI.md §3).
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_ffi_strings.ts
 * prints the same lines and `just runtime-test` diffs the two byte-for-byte. Keep the two
 * corpora in the same order or the diff means nothing.
 *
 * OUT (`jsrt_string_from_cstr`) is pinned against `Buffer.toString('utf8')`: well-formed
 * input copies through, and every ill-formed maximal subsequence is one U+FFFD — overlongs,
 * surrogate-range bytes, past-U+10FFFF and truncations alike. IN (`jsrt_string_to_cstr`)
 * is pinned the same way: the C side prints the bytes it produced with printf, and the
 * `.mjs` side logs the text those bytes encode. An embedded U+0000 truncates, and a lone
 * surrogate encodes as U+FFFD (UTF-8 at the boundary, never WTF-8).
 *
 * Every `to_cstr` buffer is freed after printing: the borrow half of the contract, where
 * the copy lives for the call and no longer. (`CStringOwned` is the same bytes with no
 * free — a call-site decision, so there is nothing else here to pin.)
 */

#include "corpus.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void show_out(const char *bytes) {
  jsrt_print(jsrt_string_from_cstr(bytes));
}

static void show_out_bytes(const unsigned char *bytes) {
  jsrt_print(jsrt_string_from_cstr((const char *)bytes));
}

static void show_in(jsrt_value v) {
  char *cstr = jsrt_string_to_cstr(v);
  printf("%s\n", cstr);
  free(cstr);
}

int main(void) {
  jsrt_init();

  /* OUT: well-formed copies, including the empty string and astral text. */
  show_out("hello");
  show_out("");
  show_out("h\xc3\xa9llo \xe2\x86\x92 \xe2\x9c\x93 \xf0\x9f\x98\x80");

  /* OUT: ill-formed bytes decode per maximal subsequence, Node's Buffer rule. */
  static const unsigned char split_seq[] = {0xE1, 0x80, 0xE1, 0x80, 0x80, 0x00};
  static const unsigned char overlong[] = {0xC0, 0xAF, 0x00};
  static const unsigned char surrogate[] = {0xED, 0xA0, 0x80, 0x00};
  static const unsigned char truncated[] = {0xF0, 0x90, 0x80, 0x00};
  static const unsigned char lone_cont[] = {0x80, 0x00};
  static const unsigned char past_max[] = {0xF4, 0x90, 0x80, 0x80, 0x00};
  static const unsigned char overlong_nul[] = {0xE0, 0x80, 0x80, 0x00};
  static const unsigned char truncated_tail[] = {0xE1, 0x80, 0x00};
  show_out_bytes(split_seq);
  show_out_bytes(overlong);
  show_out_bytes(surrogate);
  show_out_bytes(truncated);
  show_out_bytes(lone_cont);
  show_out_bytes(past_max);
  show_out_bytes(overlong_nul);
  show_out_bytes(truncated_tail);

  /* IN: the bytes a JS string encodes to. */
  show_in(str("hello"));
  show_in(str(""));
  show_in(str("h\xc3\xa9llo \xe2\x86\x92 \xe2\x9c\x93 \xf0\x9f\x98\x80"));
  static const uint16_t astral[] = {0x41, 0xD83D, 0xDE00, 0x42};
  show_in(jsrt_string_from_units(astral, 4));

  /* IN: an embedded U+0000 truncates, and lone surrogates become U+FFFD. */
  static const uint16_t embedded_nul[] = {0x68, 0x00, 0x69};
  static const uint16_t lone_lead[] = {0xD800};
  static const uint16_t lone_trail[] = {0xDC00};
  show_in(jsrt_string_from_units(embedded_nul, 3));
  show_in(jsrt_string_from_units(lone_lead, 1));
  show_in(jsrt_string_from_units(lone_trail, 1));

  /* Round-trip through both directions is the identity on well-formed text. */
  show_in(jsrt_string_from_cstr("caf\xc3\xa9 \xe2\x86\x92 \xe2\x9c\x93"));

  return 0;
}
