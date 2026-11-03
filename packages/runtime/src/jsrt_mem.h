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

/* ------------------------------------------------------------ the collector (jsrt_gc.zig) */

/* The Boehm object kind every runtime copy in the process allocates from, plus one; 0 until the
 * first copy registers it. Weak and defined in jsrt_value.c because Zig 0.16 emits a weak data
 * export as a non-external symbol on Mach-O, and the copies only coalesce on an external one
 * (plan-notes 342). */
extern unsigned jsrt_gc_shared_kind_p48;

/* ------------------------------------------------------ allocation helpers (jsrt_alloc.zig) */

/* Grows `a`'s element buffer so `index` is below its capacity; new elements read `undefined`. */
void jsrt_array_grow(JSRTArray *a, uint32_t index);

#endif /* JSRT_MEM_H */
