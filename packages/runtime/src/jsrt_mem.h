/* jsrt_mem.h — the runtime's memory core, implemented in Zig (src/jsrt_*.zig) behind a C ABI.
 *
 * Internal to the runtime: generated code never includes it, and the codegen<->runtime contract is
 * still jsrt_value.h. The Zig side translates this header (and jsrt_value.h), so every layout here is
 * the one definition both languages compile against -- there is no mirrored copy to drift. */
#ifndef JSRT_MEM_H
#define JSRT_MEM_H

#include "jsrt_value.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ------------------------------------------------------------ growable buffers (jsrt_buf.zig) */

/* A growable byte buffer. Output whose layout depends on every element (an array that may fit on
 * one line) is built up rather than streamed. `data` stays NUL-terminated once anything has been
 * appended. Plain malloc: it holds bytes, never jsrt_values, so the collector need not see it. */
typedef struct {
  char *data;
  size_t len;
  size_t cap;
} JSRTBuf;

void jsrt_buf_init(JSRTBuf *b);
void jsrt_buf_free(JSRTBuf *b);
void jsrt_buf_append(JSRTBuf *b, const char *bytes, size_t n);
void jsrt_buf_puts(JSRTBuf *b, const char *s);
void jsrt_buf_putc(JSRTBuf *b, char c);
void jsrt_buf_repeat(JSRTBuf *b, char c, size_t n);
/* Appends a NUL and hands `data` to the caller, who frees it. */
char *jsrt_buf_take(JSRTBuf *b);

/* A growable list of owned (malloc'd) strings -- console.table's column names and cells. */
typedef struct {
  char **items;
  size_t len;
  size_t cap;
} JSRTStrVec;

void jsrt_strvec_init(JSRTStrVec *v);
void jsrt_strvec_push(JSRTStrVec *v, char *owned);
/* Frees every item and the list; the list is not reset. */
void jsrt_strvec_free(JSRTStrVec *v);
/* The index of `name`, or SIZE_MAX. */
size_t jsrt_strvec_find(const JSRTStrVec *v, const char *name);

/* A growable UTF-16 unit buffer (JSON.parse string contents). The caller frees `units`. */
typedef struct {
  uint16_t *units;
  uint32_t len;
  uint32_t cap;
} JSRTUnitBuf;

void jsrt_units_push(JSRTUnitBuf *b, uint16_t unit);

/* ---------------------------------------------------- the shape table (jsrt_shape.zig, §4.10) */

/* The one shape with no key: every dynamic object starts here, and an array's first named property
 * transitions from it. Static, so "has no properties" needs no allocation and compares by address. */
extern JSRTShape jsrt_shape_root;

/* The link on `shape`'s chain that added `key`, or NULL. */
const JSRTShape *jsrt_shape_find(const JSRTShape *shape, const char *key);
/* The child of `from` that adds `key`, reusing an existing one before allocating. */
JSRTShape *jsrt_shape_transition(JSRTShape *from, const char *key);
/* Takes ownership of a malloc'd NUL-terminated UTF-8 key and returns a pointer that lives as
 * long as the process — the same lifetime the shape table already gives every stored key. A
 * second intern of the same bytes returns the first pointer and frees the duplicate. */
const char *jsrt_shape_intern(char *key);
/* Grows a property table's slot storage so `offset` is writable. */
void jsrt_shape_reserve(jsrt_value **slots, uint32_t *capacity, uint32_t offset);
/* Removes `hit` from `*shape`: replays the chain without it and compacts `slots` to match. */
void jsrt_shape_remove(JSRTShape **shape, jsrt_value *slots, const JSRTShape *hit);

/* The canonical-array-index test these walks share is `jsrt_key_is_array_index` (jsrt_value.h):
 * fixed-shape enumeration answers it too, so the one spelling lives in C, and the Zig ordering
 * calls through to it rather than carrying a second copy. */

/* -------------------------------------- allocation in compiled code (jsrt_gc.zig, VALUE.md §4.12) */

/* The open run of the collector's young region, as code that takes no lock may use it. A block
 * of `total` bytes fits while `bump + total <= limit`; it is then at `bump`, which moves past
 * it. `limit` is zero while another thread may allocate: the run then belongs to the heap lock,
 * and nothing fits. Both are zero or current at every instruction, so a JIT reads them where it
 * allocates. */
typedef struct JSRTYoungRun {
  uintptr_t bump;
  uintptr_t limit;
} JSRTYoungRun;

/* A line of the region, whose blocks one word of the index records. */
#define JSRT_GC_LINE_SHIFT 9

/* What a JIT needs to allocate one kind and size of block in `run` without a call. After the
 * bump it sets the block's bit in the index (`off` being the block's offset from `base`: bit
 * `(off >> 3) & 63` of `bits[off >> JSRT_GC_LINE_SHIFT]`), stores `word` and `meta` as the
 * block's first two words, and initializes every byte of the object, which starts
 * JSRT_GC_HEADER_BYTES into the block: the run is not zeroed. Such a block is dirty, as every
 * block is until its first collection. */
typedef struct JSRTYoungSite {
  JSRTYoungRun *run;
  uintptr_t base;
  uint64_t *bits;
  uint64_t word;
  uint64_t meta;
  uint32_t total;
} JSRTYoungSite;

/* The site of a dynamic object with `capacity` slots of its own (jsrt_dynobj_new_sized). False
 * when no such object is born in the region: there is none (the sanitized flavor), or the
 * object is too large for it. */
bool jsrt_dynobj_young_site(uint32_t capacity, JSRTYoungSite *site);

/* ------------------------------------------------------ allocation helpers (jsrt_alloc.zig) */

/* Grows `a`'s element buffer so `index` is below its capacity; new elements read `undefined`. */
void jsrt_array_grow(JSRTArray *a, uint32_t index);

#endif /* JSRT_MEM_H */
