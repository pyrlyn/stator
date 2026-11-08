/* jsrt.h — public entry header for the Stator C11 runtime.
 *
 * The value representation (jsrt_value, JSString, JSRT_FRAME/JSRT_LOCAL) lands in
 * jsrt_value.h alongside docs/VALUE.md — plan.md §5 Task 2.1, before any C emission.
 */
#ifndef JSRT_H
#define JSRT_H

#include <stddef.h>

/* Bumped whenever the codegen<->runtime contract changes; generated C asserts it. */
#define JSRT_ABI_VERSION 0

int jsrt_abi_version(void);

/* Fatal error handler: prints message and stack-frame count, then aborts.
 *
 * `_Noreturn` is part of the contract, not decoration: a caller that ends in a panic -- a failed
 * boundary check, say -- has no value to return and must not be made to invent one. Without it,
 * every such caller needs an unreachable `return`, which reads as a path the code can take. */
_Noreturn void jsrt_panic(const char *msg);

/* ------------------------------------------------------------ the collector (jsrt_gc.zig)
 *
 * pyrlyn/gc as coalesced deferred reference counting (docs/VALUE.md §4.12). Every collected
 * object has a kind: how to find the objects it references and what to release when it dies. */

/* Reports one referenced runtime pointer (the payload of a boxed value, a `JSRTEnv *`). Anything
 * that is not a collected object -- NULL, a static object, malloc'd memory -- is ignored. */
typedef void (*jsrt_gc_visit_fn)(void *child);

/* The vtable pyrlyn/gc's kxgc.h defines, first in every kind so the collector reads it in place.
 * Every kind fills it from JSRT_GC_KIND; only the cyclic flag differs. */
typedef struct JSRTGcVTab {
  void (*rel)(void *block);
  void (*trav)(void *block, jsrt_gc_visit_fn visit);
  void (*relo)(void *block);
  void (*freemem)(void *block);
  void *cyclic;
} JSRTGcVTab;

typedef struct JSRTGcKind {
  JSRTGcVTab vtab;
  /* Names the allocation in the out-of-memory panic and in the verifier's reports. */
  const char *name;
  /* Visits every reference the object holds now; NULL: it holds none. Must not allocate. */
  void (*trace)(void *obj, jsrt_gc_visit_fn visit);
  /* Releases what the object owns outright (its buffers, malloc'd memory); NULL: nothing. Runs
   * once, when the collector frees the object. Must not allocate or touch other objects. */
  void (*finalize)(void *obj);
  /* Generated code writes these objects' references directly, without `jsrt_gc_write`, so every
   * collection reconciles them (closure environments, async and generator frames). */
  int always_dirty;
  /* Offsets of jsrt_value fields the collector visits itself, before `trace`: a kind whose
   * references are only such fields needs no trace function (JSRT_GC_VALUE_KIND). */
  unsigned char value_count;
  unsigned short value_offsets[4];
} JSRTGcKind;

void jsrt_gc_vt_rel(void *block);
void jsrt_gc_vt_trav(void *block, jsrt_gc_visit_fn visit);
void jsrt_gc_vt_freemem(void *block);

/* Whether an object of the kind can be part of a cycle: only those are trial-deletion candidates.
 * A kind that can only reference strings and other acyclic kinds is JSRT_GC_ACYCLIC. */
#define JSRT_GC_CYCLIC ((void *)1)
#define JSRT_GC_ACYCLIC ((void *)0)

#define JSRT_GC_KIND(name, trace, finalize, cyclic, always_dirty)                                  \
  {{jsrt_gc_vt_rel, jsrt_gc_vt_trav, NULL, jsrt_gc_vt_freemem, (cyclic)}, (name), (trace),         \
   (finalize), (always_dirty), 0, {0}}

/* A kind whose references are exactly the jsrt_value fields at the given `offsetof`s (up to 4). */
#define JSRT_GC_VALUE_KIND(name, cyclic, ...)                                                      \
  {{jsrt_gc_vt_rel, jsrt_gc_vt_trav, NULL, jsrt_gc_vt_freemem, (cyclic)}, (name), NULL, NULL, 0,     \
   sizeof((unsigned short[]){__VA_ARGS__}) / sizeof(unsigned short), {__VA_ARGS__}}

/* Opens the definition of `fn`, a kind's trace, whose body (in braces after it) sees the object as
 * `const Type *self` and the visitor as `visit`. */
#define JSRT_GC_TRACE(fn, Type, self)                                                              \
  static void fn##_typed(const Type *self, jsrt_gc_visit_fn visit);                                \
  static void fn(void *obj, jsrt_gc_visit_fn visit) { fn##_typed((const Type *)obj, visit); }      \
  static void fn##_typed(const Type *self, jsrt_gc_visit_fn visit)

/* The runtime's one collected allocation: zeroed, never NULL (out of memory panics). Everything
 * that can hold a jsrt_value lives in a block from here or in a buffer such a block owns; a value
 * stored anywhere else is seen only if a root covers it. */
void *jsrt_gc_alloc(size_t bytes, const JSRTGcKind *kind);

/* A zeroed `Type` of the given kind. */
#define JSRT_GC_NEW(Type, kind) ((Type *)jsrt_gc_alloc(sizeof(Type), (kind)))

/* Called BEFORE a runtime function changes the references inside an existing collected object --
 * a store of a boxed value or pointer into it, or a buffer swap. A new object needs no call until
 * a collection has run since it was allocated, but making it anyway is always correct. Cheap
 * after the first call per object per collection. */
void jsrt_gc_write(const void *obj);

/* Storage `owner` holds outright -- elements, entries, slots -- zeroed, never counted. The owner's
 * kind traces what is in it and frees it from its finalizer. `owner` may be NULL and named later
 * with jsrt_gc_buffer_adopt; a buffer without an owner is not kept alive by roots inside it. */
void *jsrt_gc_buffer(const void *owner, size_t bytes, const char *what);
void jsrt_gc_buffer_adopt(const void *buffer, const void *owner);
/* From the owner's finalizer, or for a scratch buffer once its values are elsewhere. */
void jsrt_gc_buffer_free(const void *buffer);
/* Temporary storage for values built before there is an object to hold them: every word in it is
 * a root while a root points into it. Freed with jsrt_gc_buffer_free. */
void *jsrt_gc_scratch(size_t bytes, const char *what);
/* A buffer the living owner stopped using; freed once no root word points into it. */
void jsrt_gc_buffer_retire(const void *buffer);
/* A fresh buffer of `bytes` holding the start of `buffer` (NULL: none), the rest zeroed; the old
 * one is retired. The caller calls jsrt_gc_write(owner) first if the old one held references. */
void *jsrt_gc_buffer_resize(const void *owner, const void *buffer, size_t bytes, const char *what);

/* Test hook. When `on` is non-zero, every collected allocation runs a full collection first, so a
 * NaN-boxed value that is not in a root dies at the next allocation. Off unless a test turns it
 * on, or `JSRT_GC_STRESS=1` in the environment at init. Generated code does not call it. */
void jsrt_gc_stress(int on);

/* Test hook beside `jsrt_gc_stress`. After `jsrt_gc_watch(obj)`, a collection that frees `obj`
 * makes `jsrt_gc_watched` return non-zero until `jsrt_gc_watched_reset`. Generated code does not
 * call these. */
void jsrt_gc_watch(void *obj);
void jsrt_gc_watched_reset(void);
int jsrt_gc_watched(void);

/* Called by jsrt_init once the pointer-width assumption holds. Idempotent. */
void jsrt_gc_init(void);

/* Called by jsrt_init after jsrt_gc_init: measures this thread's stack for JSRT_STACK_CHECK and
 * installs the stack-overflow fault handler (jsrt_stack.zig). */
void jsrt_stack_init(void);

#endif /* JSRT_H */
