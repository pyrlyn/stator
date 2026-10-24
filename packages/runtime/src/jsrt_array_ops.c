/* Array.prototype builtins (plan.md §7 Task 4.2) — the non-callback surface, ECMA-262 §23.1.3.
 *
 * Everything here is EXACT over the dense representation: index arithmetic, strict-equality
 * search (`includes` uses SameValueZero, which finds NaN where `indexOf` cannot), and in-place
 * mutation returning the receiver. The methods that take a FUNCTION call back into compiled code
 * through `jsrt_call` — the same closure ABI compiled callers dispatch through, so the runtime
 * needs no protocol of its own. Each caches `length` at entry (the spec's ToLength step): an
 * element the callback appends is not visited, one it mutates is seen as current.
 *
 * Optional arguments arrive as JSRT_UNDEFINED — the lowering pads missing ones, and for every
 * method HERE the spec gives explicit `undefined` the meaning of an absent argument. The one
 * method where that is false, `lastIndexOf` (absent `fromIndex` means `length - 1`, explicit
 * `undefined` means `0`), lands without its position argument for exactly that reason. */

#include <stdarg.h>
#include <string.h>

#include "jsrt.h"
#include "jsrt_index_util.h"
#include "jsrt_mem.h"
#include "jsrt_value.h"

static JSRTArray *arr(jsrt_value v) { return jsrt_as_array(v); }

/* Collect `n` C varargs into a stack VLA. Shared by every variadic array mutator (push, unshift,
 * concat, splice): one idea, one loop, and a copy that drifted would reorder a user's arguments. */
static void collect_varargs(uint32_t n, jsrt_value *items, va_list *ap) {
  for (uint32_t i = 0; i < n; i++) {
    items[i] = va_arg(*ap, jsrt_value);
  }
}

/* Append one element through the public write path, which owns growth; `length` is the one index
 * a write may extend through, so no hole can appear. */
static void append(jsrt_value array, jsrt_value element) {
  jsrt_array_set(array, jsrt_number((double)arr(array)->length), element);
}

/* `len` holes: what `Array(n)` builds and what `map` writes its answers into (§23.1.3.21 step 5's
 * ArraySpeciesCreate). */
static jsrt_value holes(uint32_t len) {
  jsrt_value out = jsrt_array_new(0, NULL);
  if (len > 0) {
    JSRTArray *a = arr(out);
    jsrt_array_grow(a, len - 1);
    for (uint32_t i = 0; i < len; i++) {
      a->elements[i] = JSRT_HOLE;
    }
    a->length = len;
  }
  return out;
}

jsrt_value jsrt_array_construct(jsrt_value arg) {
  if (!jsrt_is_number(arg)) {
    return jsrt_array_new(1, &arg);
  }
  /* §23.1.1.1 step 6: the length must survive ToUint32 unchanged. */
  const double requested = jsrt_number_value(arg);
  const uint32_t len = jsrt_to_uint32(requested);
  if ((double)len != requested) {
    jsrt_throw_error(&jsrt_class_range_error, "Invalid array length");
    return JSRT_UNDEFINED;
  }
  return holes(len);
}

jsrt_value jsrt_array_push(jsrt_value array, jsrt_value element) {
  if (jsrt_require_array(array, "push") == NULL) {
    return JSRT_UNDEFINED;
  }
  append(array, element);
  return jsrt_array_length(array);
}

/* The variadic form (plan.md §8 step 19): `push(a, b, c)` appends in order and answers the new
 * length, so it is `n` appends through the same public path — not a bulk copy, which would
 * duplicate the growth discipline `append` owns. Zero arguments append nothing and answer the
 * length unchanged (§23.1.3.20: the call still returns). The argv-array core the varargs entry
 * and the dynamic `push` (plan.md §8 step 20) share, so one idea lives in one place whether the
 * arguments arrived as C varargs or as a call vector. */
static jsrt_value push_items(jsrt_value array, uint32_t n, const jsrt_value *items) {
  for (uint32_t i = 0; i < n; i++) {
    append(array, items[i]);
  }
  return jsrt_array_length(array);
}

jsrt_value jsrt_array_push_many(jsrt_value array, uint32_t n, ...) {
  if (jsrt_require_array(array, "push") == NULL) {
    return JSRT_UNDEFINED;
  }
  /* VLA on the C stack, the `jsrt_call_at` shifted-argv precedent: the items stay reachable to a
   * conservative collector across the allocating appends below. */
  jsrt_value items[n > 0 ? n : 1];
  va_list ap;
  va_start(ap, n);
  collect_varargs(n, items, &ap);
  va_end(ap);
  return push_items(array, n, items);
}

/* Shared pop/shift core: take one element off either end, clearing the vacated slot (a
 * conservative collector keeps scanning up to `capacity`, and a stale value would pin a dead
 * object). False when empty, in which case both callers answer `undefined`. */
static bool array_take(JSRTArray *a, bool from_front, jsrt_value *out) {
  if (a->length == 0) {
    return false;
  }
  *out = from_front ? a->elements[0] : a->elements[a->length - 1];
  if (from_front) {
    memmove(a->elements, a->elements + 1, (size_t)(a->length - 1) * sizeof(jsrt_value));
  }
  a->elements[a->length - 1] = JSRT_UNDEFINED;
  a->length -= 1;
  return true;
}

jsrt_value jsrt_array_pop(jsrt_value array) {
  jsrt_value out = JSRT_UNDEFINED;
  if (jsrt_require_array(array, "pop") == NULL) {
    return JSRT_UNDEFINED;
  }
  if (!array_take(arr(array), false, &out)) {
    return JSRT_UNDEFINED;
  }
  return jsrt_unhole(out);
}

jsrt_value jsrt_array_shift(jsrt_value array) {
  jsrt_value out = JSRT_UNDEFINED;
  if (jsrt_require_array(array, "shift") == NULL) {
    return JSRT_UNDEFINED;
  }
  if (!array_take(arr(array), true, &out)) {
    return JSRT_UNDEFINED;
  }
  return jsrt_unhole(out);
}

jsrt_value jsrt_array_unshift(jsrt_value array, jsrt_value element) {
  if (jsrt_require_array(array, "unshift") == NULL) {
    return JSRT_UNDEFINED;
  }
  /* Grow by appending (the public path owns capacity), then rotate the new slot to the front. */
  append(array, element);
  JSRTArray *a = arr(array);
  memmove(a->elements + 1, a->elements, (size_t)(a->length - 1) * sizeof(jsrt_value));
  a->elements[0] = element;
  return jsrt_array_length(array);
}

/* The variadic form (plan.md §8 step 19): `unshift(a, b, c)` inserts the whole run at the front
 * IN ORDER, so it is one growth plus one rotation — not `n` single unshifts, which would reverse
 * the run (`unshift(0)` then `unshift(1)` answers `[1, 0, ...]` where the spec answers
 * `[0, 1, ...]`). Zero arguments answer the length unchanged. The argv-array core the varargs
 * entry and the dynamic `unshift` (plan.md §8 step 20) share. */
static jsrt_value unshift_items(jsrt_value array, uint32_t n, const jsrt_value *items) {
  if (n == 0) {
    return jsrt_array_length(array);
  }
  const uint32_t len = arr(array)->length;
  for (uint32_t i = 0; i < n; i++) {
    append(array, JSRT_UNDEFINED);
  }
  /* `append` may have reallocated the buffer, so the header is re-read, not reused. */
  JSRTArray *a = arr(array);
  memmove(a->elements + n, a->elements, (size_t)len * sizeof(jsrt_value));
  for (uint32_t i = 0; i < n; i++) {
    a->elements[i] = items[i];
  }
  return jsrt_array_length(array);
}

jsrt_value jsrt_array_unshift_many(jsrt_value array, uint32_t n, ...) {
  if (jsrt_require_array(array, "unshift") == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value items[n > 0 ? n : 1];
  va_list ap;
  va_start(ap, n);
  collect_varargs(n, items, &ap);
  va_end(ap);
  return unshift_items(array, n, items);
}

jsrt_value jsrt_array_at(jsrt_value array, jsrt_value index) {
  const JSRTArray *a = jsrt_require_array(array, "at");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  double k = jsrt_int_or_inf(index, 0.0);
  if (k < 0.0) {
    k += (double)a->length;
  }
  if (k < 0.0 || k >= (double)a->length) {
    return JSRT_UNDEFINED;
  }
  return jsrt_unhole(a->elements[(uint32_t)k]);
}

/* SameValueZero: strict equality plus NaN finding NaN (§7.2.9). `includes` searches with it;
 * `indexOf` keeps strict equality and therefore never finds NaN — the spec's own asymmetry. */
static bool same_value_zero(jsrt_value a, jsrt_value b) {
  if (jsrt_strict_equals(a, b)) {
    return true;
  }
  return jsrt_is_double(a) && jsrt_is_double(b) && isnan(jsrt_to_double(a)) &&
         isnan(jsrt_to_double(b));
}

/* The shared fromIndex step of indexOf/includes (§23.1.3.14 steps 4–8): clamp a relative start
 * into [0, len], where len itself means "search nothing". */
static uint32_t search_start(jsrt_value from, uint32_t len) {
  return jsrt_relative_index(jsrt_int_or_inf(from, 0.0), len);
}

/* Forward search from `from`: the matching index, or -1. `same_value_z` selects SameValueZero
 * (`includes`, which finds NaN) over strict equality (`indexOf`, which cannot). */
static int64_t array_search_forward(const JSRTArray *a, jsrt_value search, jsrt_value from,
                                    bool same_value_z) {
  for (uint32_t i = search_start(from, a->length); i < a->length; i++) {
    const bool hit = same_value_z ? same_value_zero(jsrt_unhole(a->elements[i]), search)
                                  : jsrt_strict_equals(a->elements[i], search);
    if (hit) {
      return (int64_t)i;
    }
  }
  return -1;
}

/* A half-open [from, to) range from optional start/end, defaulting to [0, length) — the shared
 * slice/fill step (§23.1.3.23, §23.1.3.8). `to` may be below `from`; callers treat that as empty. */
static void array_half_open_range(const JSRTArray *a, jsrt_value start, jsrt_value end,
                                  uint32_t *from, uint32_t *to) {
  *from = jsrt_relative_index(jsrt_int_or_inf(start, 0.0), a->length);
  *to = jsrt_relative_index(jsrt_int_or_inf(end, (double)a->length), a->length);
}

jsrt_value jsrt_array_index_of(jsrt_value array, jsrt_value search, jsrt_value from) {
  const JSRTArray *a = jsrt_require_array(array, "indexOf");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  return jsrt_number((double)array_search_forward(a, search, from, false));
}

jsrt_value jsrt_array_last_index_of(jsrt_value array, jsrt_value search) {
  const JSRTArray *a = jsrt_require_array(array, "lastIndexOf");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  for (uint32_t i = a->length; i > 0; i--) {
    if (jsrt_strict_equals(a->elements[i - 1], search)) {
      return jsrt_number((double)(i - 1));
    }
  }
  return jsrt_number(-1.0);
}

/* The two-argument form (plan.md §8 step 19): `lastIndexOf(x, from)` searches backwards from
 * `from` (§23.1.3.16). The index is relative — a negative counts from the end — and clamped
 * into the array: at or past the end means `length - 1`, before the start means no search
 * (`-1`). An explicit `undefined` position truncates to `0` (only index 0 is examined), which
 * is why absence and `undefined` cannot share one entry point. */
jsrt_value jsrt_array_last_index_of_from(jsrt_value array, jsrt_value search, jsrt_value from) {
  const JSRTArray *a = jsrt_require_array(array, "lastIndexOf");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  if (a->length == 0) {
    return jsrt_number(-1.0);
  }
  double n = jsrt_int_or_inf(from, 0.0);
  double k = n >= 0.0 ? n : (double)a->length + n;
  if (k < 0.0) {
    return jsrt_number(-1.0);
  }
  uint32_t i = k >= (double)a->length ? a->length : (uint32_t)k + 1;
  while (i > 0) {
    i--;
    if (jsrt_strict_equals(a->elements[i], search)) {
      return jsrt_number((double)i);
    }
  }
  return jsrt_number(-1.0);
}

jsrt_value jsrt_array_includes(jsrt_value array, jsrt_value search, jsrt_value from) {
  const JSRTArray *a = jsrt_require_array(array, "includes");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  return array_search_forward(a, search, from, true) >= 0 ? JSRT_TRUE : JSRT_FALSE;
}

jsrt_value jsrt_array_slice(jsrt_value array, jsrt_value start, jsrt_value end) {
  const JSRTArray *a = jsrt_require_array(array, "slice");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  uint32_t from;
  uint32_t to;
  array_half_open_range(a, start, end, &from, &to);
  uint32_t count = to > from ? to - from : 0;
  return jsrt_array_new(count, count > 0 ? a->elements + from : NULL);
}

/* One array argument, spread — `[1].concat([2, 3])` is `[1, 2, 3]` (§23.1.3.1; the gate admits
 * exactly this shape). Neither receiver is mutated. A non-array `other` is APPENDED as a single
 * element rather than refused (§23.1.3.1 step 5 spreads only spreadable values): `[1].concat(5)`
 * is `[1, 5]` on every path, static or dynamic. */
jsrt_value jsrt_array_concat(jsrt_value array, jsrt_value other) {
  const JSRTArray *a = jsrt_require_array(array, "concat");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value out = jsrt_array_new(a->length, a->length > 0 ? a->elements : NULL);
  if (!jsrt_is(other, JSRT_TAG_ARRAY)) {
    append(out, other);
    return out;
  }
  const JSRTArray *b = arr(other);
  for (uint32_t i = 0; i < b->length; i++) {
    append(out, b->elements[i]);
  }
  return out;
}

/* The variadic form (plan.md §8 step 19): `concat(b, c, v)` spreads each array argument and
 * appends each non-array one as a single element (§23.1.3.1 steps 5–7, modulo
 * `Symbol.isConcatSpreadable`, which no value here carries). Zero arguments answer a shallow
 * copy — mutating the copy leaves the receiver alone. Neither the receiver nor any argument is
 * mutated. The argv-array core the varargs entry and the dynamic `concat` (plan.md §8 step 20)
 * share. */
static jsrt_value concat_items(jsrt_value array, uint32_t n, const jsrt_value *items) {
  const JSRTArray *a = arr(array);
  jsrt_value out = jsrt_array_new(a->length, a->length > 0 ? a->elements : NULL);
  for (uint32_t i = 0; i < n; i++) {
    jsrt_value item = items[i];
    if (jsrt_is(item, JSRT_TAG_ARRAY)) {
      const JSRTArray *b = arr(item);
      for (uint32_t k = 0; k < b->length; k++) {
        append(out, b->elements[k]);
      }
    } else {
      append(out, item);
    }
  }
  return out;
}

jsrt_value jsrt_array_concat_many(jsrt_value array, uint32_t n, ...) {
  if (jsrt_require_array(array, "concat") == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value items[n > 0 ? n : 1];
  va_list ap;
  va_start(ap, n);
  collect_varargs(n, items, &ap);
  va_end(ap);
  return concat_items(array, n, items);
}

jsrt_value jsrt_array_reverse(jsrt_value array) {
  JSRTArray *a = jsrt_require_array(array, "reverse");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  for (uint32_t i = 0, j = a->length; i + 1 < j; i++, j--) {
    jsrt_value tmp = a->elements[i];
    a->elements[i] = a->elements[j - 1];
    a->elements[j - 1] = tmp;
  }
  return array;
}

jsrt_value jsrt_array_fill(jsrt_value array, jsrt_value value, jsrt_value start, jsrt_value end) {
  JSRTArray *a = jsrt_require_array(array, "fill");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  uint32_t from;
  uint32_t to;
  array_half_open_range(a, start, end, &from, &to);
  for (uint32_t i = from; i < to; i++) {
    a->elements[i] = value;
  }
  return array;
}

jsrt_value jsrt_array_copy_within(jsrt_value array, jsrt_value target, jsrt_value start,
                                  jsrt_value end) {
  JSRTArray *a = jsrt_require_array(array, "copyWithin");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t to = jsrt_relative_index(jsrt_int_or_inf(target, 0.0), a->length);
  const uint32_t from = jsrt_relative_index(jsrt_int_or_inf(start, 0.0), a->length);
  const uint32_t last = jsrt_relative_index(jsrt_int_or_inf(end, (double)a->length), a->length);
  const uint32_t span = last > from ? last - from : 0;
  const uint32_t room = a->length - to;
  const uint32_t count = span < room ? span : room;
  memmove(a->elements + to, a->elements + from, (size_t)count * sizeof(jsrt_value));
  return array;
}

/* The (start, deleteCount) span both splice forms share: a relative start clamped into the
 * array, and a delete count clamped into what remains (§23.1.3.29 steps 5–7). */
static void splice_span(jsrt_value array, jsrt_value start, jsrt_value delete_count,
                        uint32_t *from_out, uint32_t *count_out) {
  const JSRTArray *a = arr(array);
  const uint32_t from = jsrt_relative_index(jsrt_int_or_inf(start, 0.0), a->length);
  const double want = jsrt_int_or_inf(delete_count, 0.0);
  const uint32_t room = a->length - from;
  *from_out = from;
  *count_out = want <= 0.0 ? 0 : (want >= (double)room ? room : (uint32_t)want);
}

/* The two-argument form: removes the span and returns it. `splice(start)` (one argument) and
 * the insertion form ride their own entry points — an absent deleteCount deletes to the END
 * while an explicit undefined deletes NOTHING (the lastIndexOf rule) — but all three share
 * `splice_span` above. Returns the removed run. */
jsrt_value jsrt_array_splice(jsrt_value array, jsrt_value start, jsrt_value delete_count) {
  JSRTArray *a = jsrt_require_array(array, "splice");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  uint32_t from = 0;
  uint32_t count = 0;
  splice_span(array, start, delete_count, &from, &count);
  jsrt_value removed = jsrt_array_new(count, count > 0 ? a->elements + from : NULL);
  memmove(a->elements + from, a->elements + from + count,
          (size_t)(a->length - from - count) * sizeof(jsrt_value));
  for (uint32_t i = a->length - count; i < a->length; i++) {
    a->elements[i] = JSRT_UNDEFINED; /* conservative scan runs to capacity */
  }
  a->length -= count;
  return removed;
}

/* The one-argument form (plan.md §8 step 19): `splice(start)` removes from `start` to the END
 * (§23.1.3.29 step 8: an absent deleteCount means `length - start`). Implemented as the
 * two-argument form over that count, so the removal below is one copy of the code, not two. */
jsrt_value jsrt_array_splice_from(jsrt_value array, jsrt_value start) {
  const JSRTArray *a = jsrt_require_array(array, "splice");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t from = jsrt_relative_index(jsrt_int_or_inf(start, 0.0), a->length);
  return jsrt_array_splice(array, start, jsrt_number((double)(a->length - from)));
}

/* The insertion form (plan.md §8 step 19): `splice(start, deleteCount, ...items)` removes the
 * span and inserts the items at `from` (§23.1.3.29 steps 9–10), answering the removed run. The
 * tail moves once: the array first grows through the public path (which owns capacity), then
 * the tail slides from `from + count` to `from + n` — `memmove`, because the two ranges
 * overlap whenever the run grows or shrinks — and the items land in the gap. A shrink clears
 * the vacated tail so the conservative scan never reads a stale value. The argv-array core the
 * insertion entry and the dynamic `splice` (plan.md §8 step 20) share, so the form is one idea
 * in one place whether the items arrived as C varargs or as a call vector. */
static jsrt_value splice_insert_items(jsrt_value array, jsrt_value start, jsrt_value delete_count,
                                      uint32_t n, const jsrt_value *items) {
  JSRTArray *a = arr(array);
  uint32_t from = 0;
  uint32_t count = 0;
  splice_span(array, start, delete_count, &from, &count);
  const uint32_t len = a->length;
  jsrt_value removed = jsrt_array_new(count, count > 0 ? a->elements + from : NULL);
  const uint32_t newlen = len - count + n;
  for (uint32_t i = len; i < newlen; i++) {
    append(array, JSRT_UNDEFINED);
  }
  /* `append` may have reallocated the buffer, so the header is re-read, not reused. */
  a = arr(array);
  memmove(a->elements + from + n, a->elements + from + count,
          (size_t)(len - from - count) * sizeof(jsrt_value));
  for (uint32_t i = 0; i < n; i++) {
    a->elements[from + i] = items[i];
  }
  for (uint32_t i = newlen; i < len; i++) {
    a->elements[i] = JSRT_UNDEFINED;
  }
  a->length = newlen;
  return removed;
}

jsrt_value jsrt_array_splice_insert(jsrt_value array, jsrt_value start, jsrt_value delete_count,
                                    uint32_t n, ...) {
  if (jsrt_require_array(array, "splice") == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value items[n > 0 ? n : 1];
  va_list ap;
  va_start(ap, n);
  collect_varargs(n, items, &ap);
  va_end(ap);
  return splice_insert_items(array, start, delete_count, n, items);
}

/* Depth-limited recursive flatten; `depth` already went through ToIntegerOrInfinity, so a plain
 * double comparison carries Infinity for free. */
static void flatten_into(jsrt_value out, jsrt_value v, double depth) {
  JSRTArray *a = arr(v);
  const uint32_t len = a->length;
  for (uint32_t i = 0; i < len && i < arr(v)->length; i++) {
    jsrt_value elem = arr(v)->elements[i];
    if (elem == JSRT_HOLE) {
      continue; /* §7.3.35 FlattenIntoArray step 3.c: an absent index is skipped */
    }
    if (depth >= 1.0 && jsrt_is(elem, JSRT_TAG_ARRAY)) {
      flatten_into(out, elem, depth - 1.0);
    } else {
      append(out, elem);
    }
  }
}

jsrt_value jsrt_array_flat(jsrt_value array, jsrt_value depth) {
  if (jsrt_require_array(array, "flat") == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value out = jsrt_array_new(0, NULL);
  flatten_into(out, array, jsrt_int_or_inf(depth, 1.0));
  return out;
}

/* ---------------------------------------------------------------- callback methods */

/* One callback invocation, the spec's argument triple: (element, index, the array itself). A
 * compiled callee declared with fewer parameters reads the missing ones as `undefined` through
 * jsrt_arg, so passing all three is always right. */
static jsrt_value call_cb(jsrt_value cb, jsrt_value array, uint32_t i) {
  jsrt_value args[3] = {jsrt_unhole(arr(array)->elements[i]), jsrt_number((double)i), array};
  return jsrt_call(cb, 3, args);
}

/* The guard every upward callback walk shares: still inside the length read at ENTRY, still inside
 * the array a callback may since have shortened, and no exception pending. The last conjunct is
 * not an optimization -- a callback that threw has unwound, and calling it again would run user
 * code after the throw and overwrite the pending value with the next call's. Generated C checks
 * `jsrt_pending()` the moment one of these returns, so a partial answer is never observed. */
static bool walking(jsrt_value array, uint32_t i, uint32_t len) {
  return i < len && i < arr(array)->length && !jsrt_pending();
}

/* The spec's HasProperty step, checked at visit time: an index the array no longer has, or a
 * HOLE, is SKIPPED, never terminal. Every walk that skips absent indices asks it -- forEach, map,
 * filter, some, every, flatMap and both reduces -- while find and its siblings visit a hole as
 * `undefined` (§23.1.3.9 reads with Get), so they ask only the length half. */
static bool index_present(jsrt_value array, uint32_t i) {
  return i < arr(array)->length && arr(array)->elements[i] != JSRT_HOLE;
}

/* One predicate step shared by the upward and downward find walks: snapshot the element BEFORE
 * the callback (the callback may mutate the slot; the answer is the snapshot), then report a
 * hit with the snapshot and/or the index. */
static bool find_test(jsrt_value array, jsrt_value cb, uint32_t i, uint32_t *index_out,
                       jsrt_value *elem_out) {
  jsrt_value elem = jsrt_unhole(arr(array)->elements[i]);
  if (!jsrt_truthy(call_cb(cb, array, i))) {
    return false;
  }
  if (index_out != NULL) {
    *index_out = i;
  }
  if (elem_out != NULL) {
    *elem_out = elem;
  }
  return true;
}

/* The shared find/findIndex walks, upward and downward: same entry-length + existence discipline
 * as every other callback walk. A NULL out parameter is not written, so findIndex leaves the
 * element behind and find leaves the index. */
static bool array_find_upward(jsrt_value array, jsrt_value cb, uint32_t *index_out,
                              jsrt_value *elem_out) {
  const uint32_t len = arr(array)->length;
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (find_test(array, cb, i, index_out, elem_out)) {
      return true;
    }
  }
  return false;
}

static bool array_find_downward(jsrt_value array, jsrt_value cb, uint32_t *index_out,
                                jsrt_value *elem_out) {
  const uint32_t len = arr(array)->length;
  for (uint32_t i = len; i-- > 0 && !jsrt_pending();) {
    if (i >= arr(array)->length) {
      continue;
    }
    if (find_test(array, cb, i, index_out, elem_out)) {
      return true;
    }
  }
  return false;
}

/* The public find/findIndex/findLast/findLastIndex answer: one walk direction, and either the
 * matching element (`want_index` false, missing → `undefined`) or its index (`want_index` true,
 * missing → `-1`). One helper so the four entry points cannot drift on the no-match answers. */
static jsrt_value find_result(jsrt_value array, jsrt_value cb, bool upward, bool want_index) {
  uint32_t index = 0;
  jsrt_value elem = JSRT_UNDEFINED;
  const bool found = upward ? array_find_upward(array, cb, want_index ? &index : NULL,
                                                want_index ? NULL : &elem)
                            : array_find_downward(array, cb, want_index ? &index : NULL,
                                                  want_index ? NULL : &elem);
  if (!found) {
    return want_index ? jsrt_number(-1.0) : JSRT_UNDEFINED;
  }
  return want_index ? jsrt_number((double)index) : elem;
}

jsrt_value jsrt_array_for_each(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "forEach") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (index_present(array, i)) {
      call_cb(cb, array, i);
    }
  }
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_array_map(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "map") == NULL) {
    return JSRT_UNDEFINED;
  }
  /* §23.1.3.21: the answer has the receiver's length at entry, and an index the walk skips -- a
   * hole, or one the callback cut off -- stays a hole in it. */
  const uint32_t len = arr(array)->length;
  jsrt_value out = holes(len);
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (index_present(array, i)) {
      const jsrt_value mapped = call_cb(cb, array, i);
      arr(out)->elements[i] = mapped;
    }
  }
  return out;
}

jsrt_value jsrt_array_filter(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "filter") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  jsrt_value out = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; walking(array, i, len); i++) {
    /* Capture kValue before the callback. The callback receives this snapshot, and the selected
     * value pushed into the result is that same snapshot even when the callback mutates the
     * receiver's slot (ECMA-262 §23.1.3.8 steps 6.a–6.c). */
    if (!index_present(array, i)) {
      continue;
    }
    const jsrt_value element = arr(array)->elements[i];
    if (jsrt_truthy(call_cb(cb, array, i))) {
      append(out, element);
    }
  }
  return out;
}

jsrt_value jsrt_array_some(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "some") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (index_present(array, i) && jsrt_truthy(call_cb(cb, array, i))) {
      return JSRT_TRUE;
    }
  }
  return JSRT_FALSE;
}

jsrt_value jsrt_array_every(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "every") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (index_present(array, i) && !jsrt_truthy(call_cb(cb, array, i))) {
      return JSRT_FALSE;
    }
  }
  return JSRT_TRUE;
}

jsrt_value jsrt_array_find(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "find") == NULL) {
    return JSRT_UNDEFINED;
  }
  return find_result(array, cb, true, false);
}

/* map, then a depth-1 flatten of each answer -- one pass, no intermediate array. */
jsrt_value jsrt_array_flat_map(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "flatMap") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  jsrt_value out = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (!index_present(array, i)) {
      continue;
    }
    jsrt_value mapped = call_cb(cb, array, i);
    if (jsrt_is(mapped, JSRT_TAG_ARRAY)) {
      flatten_into(out, mapped, 0.0);
    } else {
      append(out, mapped);
    }
  }
  return out;
}

jsrt_value jsrt_array_find_index(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "findIndex") == NULL) {
    return JSRT_UNDEFINED;
  }
  return find_result(array, cb, true, true);
}

/* reduce/reduceRight, WITH-initial form only: the zero-initial form gives the first element a
 * different role (it becomes the seed and the loop starts at 1), and an EXPLICIT `undefined`
 * initial is an initial — so the two forms cannot share an undefined-padded signature. The
 * callback triple grows the accumulator in front: (acc, element, index, array). */
/* One accumulator step, shared by the upward and downward loops: same argument quadruple, same
 * call, whichever direction visits the index. */
static jsrt_value reduce_call(jsrt_value cb, jsrt_value acc, jsrt_value array, uint32_t i) {
  jsrt_value args[4] = {acc, arr(array)->elements[i], jsrt_number((double)i), array};
  return jsrt_call(cb, 4, args);
}

jsrt_value jsrt_array_reduce(jsrt_value array, jsrt_value cb, jsrt_value initial) {
  if (jsrt_require_array(array, "reduce") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  jsrt_value acc = initial;
  for (uint32_t i = 0; walking(array, i, len); i++) {
    if (index_present(array, i)) {
      acc = reduce_call(cb, acc, array, i);
    }
  }
  return acc;
}

jsrt_value jsrt_array_reduce_right(jsrt_value array, jsrt_value cb, jsrt_value initial) {
  if (jsrt_require_array(array, "reduceRight") == NULL) {
    return JSRT_UNDEFINED;
  }
  const uint32_t len = arr(array)->length;
  jsrt_value acc = initial;
  for (uint32_t i = len; i-- > 0 && !jsrt_pending();) {
    if (!index_present(array, i)) {
      continue;
    }
    acc = reduce_call(cb, acc, array, i);
  }
  return acc;
}

/* Array.prototype.sort, ECMA-262 §23.1.3.30. Stability is normative, so this is a merge sort,
 * not qsort. The scratch is a real jsrt array rather than raw malloc: during a merge an element's
 * ONLY reference is the scratch copy, and a collector must be able to see it there.
 *
 * SortCompare's undefined rule runs BEFORE the comparator: undefined elements sink to the end
 * without the comparator ever seeing one. The comparator's answer coerces NaN to 0, and the
 * DEFAULT comparator is ToString + code-unit comparison -- [10, 9] stays [10, 9]. */
static int sort_compare(jsrt_value x, jsrt_value y, jsrt_value cmp) {
  const bool xu = jsrt_is(x, JSRT_TAG_UNDEFINED);
  const bool yu = jsrt_is(y, JSRT_TAG_UNDEFINED);
  if (xu || yu) {
    return xu ? (yu ? 0 : 1) : -1;
  }
  /* x and y are NaN-boxed copies. The user comparator and the default ToString both allocate,
   * so each operand stays in a slot until the comparison has read it. A throw answers 0; the
   * merge stops on the pending exception and does not write the incomplete run back. */
  JSRT_FRAME(3);
  JSRT_LOCAL(0) = x;
  JSRT_LOCAL(1) = y;
  JSRT_LOCAL(2) = cmp;
  int order = 0;
  if (!jsrt_is(JSRT_LOCAL(2), JSRT_TAG_UNDEFINED)) {
    jsrt_value args[2] = {JSRT_LOCAL(0), JSRT_LOCAL(1)};
    const double d = jsrt_to_number(jsrt_call(JSRT_LOCAL(2), 2, args));
    if (!jsrt_pending()) {
      if (d < 0.0) {
        order = -1;
      } else if (d > 0.0) {
        order = 1;
      }
    }
  } else {
    JSRT_LOCAL(0) = jsrt_to_string(JSRT_LOCAL(0));
    if (!jsrt_pending()) {
      JSRT_LOCAL(1) = jsrt_to_string(JSRT_LOCAL(1));
    }
    if (!jsrt_pending()) {
      order = jsrt_string_compare(JSRT_LOCAL(0), JSRT_LOCAL(1));
    }
  }
  JSRT_FRAME_POP();
  return order;
}

/* Bottom-up stable merge over [lo, mid) x [mid, hi), scratch mirrors the receiver's storage. */
static void sort_merge(jsrt_value *elems, jsrt_value *scratch, uint32_t lo, uint32_t mid,
                       uint32_t hi, jsrt_value cmp) {
  uint32_t a = lo;
  uint32_t b = mid;
  for (uint32_t k = lo; k < hi && !jsrt_pending(); k++) {
    /* The two elements are read into slots BEFORE sort_compare allocates (ToString, or the
     * program's comparator). `<= 0` keeps the left run's element on ties: that inequality IS
     * the stability. */
    JSRT_FRAME(2);
    JSRT_LOCAL(0) = a < mid ? elems[a] : JSRT_UNDEFINED;
    JSRT_LOCAL(1) = b < hi ? elems[b] : JSRT_UNDEFINED;
    const bool take_a =
        a < mid && (b >= hi || sort_compare(JSRT_LOCAL(0), JSRT_LOCAL(1), cmp) <= 0);
    scratch[k] = take_a ? JSRT_LOCAL(0) : JSRT_LOCAL(1);
    if (take_a) {
      a++;
    } else {
      b++;
    }
    JSRT_FRAME_POP();
  }
  if (jsrt_pending()) {
    return; /* the merge is incomplete, so writing it back would duplicate elements */
  }
  memcpy(elems + lo, scratch + lo, (size_t)(hi - lo) * sizeof(jsrt_value));
}

static void sort_range(jsrt_value *elems, jsrt_value *scratch, uint32_t lo, uint32_t hi,
                       jsrt_value cmp) {
  /* A comparator that threw stops the sort where it stands: the receiver is left partially
   * ordered, which nothing may observe -- the caller jumps to its landing pad instead. */
  if (hi - lo < 2 || jsrt_pending()) {
    return;
  }
  const uint32_t mid = lo + (hi - lo) / 2;
  sort_range(elems, scratch, lo, mid, cmp);
  sort_range(elems, scratch, mid, hi, cmp);
  sort_merge(elems, scratch, lo, mid, hi, cmp);
}

jsrt_value jsrt_array_sort(jsrt_value array, jsrt_value cmp) {
  if (jsrt_require_array(array, "sort") == NULL) {
    return JSRT_UNDEFINED;
  }
  /* The scratch array is born here. During a merge an element's only copy may be that scratch,
   * and every comparison allocates, so the receiver, the comparator and the scratch stay in
   * slots. A NaN-boxed local would not. */
  JSRT_FRAME(3);
  JSRT_LOCAL(0) = array;
  JSRT_LOCAL(1) = cmp;
  JSRTArray *a = jsrt_as_array(JSRT_LOCAL(0));
  /* §23.1.3.30 SortIndexedProperties collects only the indices the array HAS: the present
   * elements sort (undefined among them sinking, by sort_compare), and the holes follow them. */
  uint32_t present = 0;
  for (uint32_t i = 0; i < a->length; i++) {
    if (a->elements[i] != JSRT_HOLE) {
      a->elements[present++] = a->elements[i];
    }
  }
  for (uint32_t i = present; i < a->length; i++) {
    a->elements[i] = JSRT_HOLE;
  }
  if (present >= 2) {
    JSRT_LOCAL(2) = jsrt_array_new(present, a->elements);
    a = jsrt_as_array(JSRT_LOCAL(0));
    sort_range(a->elements, jsrt_as_array(JSRT_LOCAL(2))->elements, 0, present, JSRT_LOCAL(1));
  }
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

/* The downward mirrors of find/findIndex, same entry-length + existence discipline. */
jsrt_value jsrt_array_find_last(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "findLast") == NULL) {
    return JSRT_UNDEFINED;
  }
  return find_result(array, cb, false, false);
}

jsrt_value jsrt_array_find_last_index(jsrt_value array, jsrt_value cb) {
  if (jsrt_require_array(array, "findLastIndex") == NULL) {
    return JSRT_UNDEFINED;
  }
  return find_result(array, cb, false, true);
}

/* The ES2023 immutable variants: a fresh copy, then the mutating op's own machinery. Each reads
 * the receiver with Get (§23.1.3.33-36), so the copy has no holes: a hole is `undefined` in it. */
static jsrt_value dense_copy(const JSRTArray *a) {
  return jsrt_array_fill_holes(jsrt_array_new(a->length, a->length > 0 ? a->elements : NULL));
}

jsrt_value jsrt_array_fill_holes(jsrt_value array) {
  JSRTArray *c = arr(array);
  for (uint32_t i = 0; i < c->length; i++) {
    c->elements[i] = jsrt_unhole(c->elements[i]);
  }
  return array;
}

jsrt_value jsrt_array_to_reversed(jsrt_value array) {
  JSRTArray *a = jsrt_require_array(array, "toReversed");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  return jsrt_array_reverse(dense_copy(a));
}

jsrt_value jsrt_array_to_sorted(jsrt_value array, jsrt_value cmp) {
  JSRTArray *a = jsrt_require_array(array, "toSorted");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  return jsrt_array_sort(dense_copy(a), cmp);
}

/* Two-argument form, same rule as splice: skipCount's padding trap is inherited. */
jsrt_value jsrt_array_to_spliced(jsrt_value array, jsrt_value start, jsrt_value skip_count) {
  JSRTArray *a = jsrt_require_array(array, "toSpliced");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  jsrt_value out = dense_copy(a);
  jsrt_array_splice(out, start, skip_count);
  return out;
}

/* ToString on an array IS join with the default separator (§23.1.3.36 via §23.1.3.18). */
jsrt_value jsrt_array_to_string(jsrt_value array) {
  if (jsrt_require_array(array, "toString") == NULL) {
    return JSRT_UNDEFINED;
  }
  return jsrt_array_join(array, JSRT_UNDEFINED);
}

/* `with(i, v)`: a copy with one element replaced. The spec throws RangeError for an index
 * outside the array; builtins cannot raise yet, so out-of-range aborts loudly (STA2005
 * pattern) rather than answering something the spec never returns. */
jsrt_value jsrt_array_with(jsrt_value array, jsrt_value index, jsrt_value value) {
  JSRTArray *a = jsrt_require_array(array, "with");
  if (a == NULL) {
    return JSRT_UNDEFINED;
  }
  double rel = jsrt_int_or_inf(index, 0.0);
  if (rel < 0.0) {
    rel += (double)a->length;
  }
  if (rel < 0.0 || rel >= (double)a->length) {
    jsrt_panic(
        "Array.prototype.with index out of range is not yet supported; the spec throws "
        "RangeError, which builtins cannot raise yet");
  }
  jsrt_value out = dense_copy(a);
  arr(out)->elements[(uint32_t)rel] = value;
  return out;
}

/* ---------------------------------------------------------------- Array.prototype as values
 *
 * `jsrt_get_prop` walks shape tables only, so `a.push` on an array answered `undefined` and the
 * following call aborted STA2006 where Node runs (plan.md §8 step 20). The table below is the
 * Array.prototype half of that gap: every method the HIR's ARRAY_OPS vocabulary can spell, with
 * the spec's `length` (measured against Node 26.7.0 -- optional positions do not count). A hit
 * binds a closure over the receiver; the ordinary call protocol then invokes the trampoline with
 * user arguments only, which pads missing positions with `undefined` exactly as the lowering pads
 * the static path -- EXCEPT the arities the static path refuses to pad, which the trampoline
 * answers the same way the builtins do: `splice` with one argument deletes to the end
 * (`splice_from`), `lastIndexOf` with two searches from the position (`last_index_of_from`), and
 * the variadic `push`/`unshift`/`concat`/`splice` share their argv-array cores with the static
 * multi-argument entries, so the two paths are one idea in one place. `reduce` without an initial
 * stays the with-initial form, because the gate refuses the no-initial form statically too
 * (subset_array_reduce_noinit_ts.ts). A detached method (`const p = a.push; p(9)`) pushes onto
 * the ORIGINAL receiver -- binding at get time is the only protocol an Unknown-receiver call
 * supports, and rebinding per call would need the receiver in argv, which it does not carry. */

typedef enum {
  ARRAY_M_AT,
  ARRAY_M_CONCAT,
  ARRAY_M_COPY_WITHIN,
  ARRAY_M_ENTRIES,
  ARRAY_M_EVERY,
  ARRAY_M_FILL,
  ARRAY_M_FILTER,
  ARRAY_M_FIND,
  ARRAY_M_FIND_INDEX,
  ARRAY_M_FIND_LAST,
  ARRAY_M_FIND_LAST_INDEX,
  ARRAY_M_FLAT,
  ARRAY_M_FLAT_MAP,
  ARRAY_M_FOR_EACH,
  ARRAY_M_INCLUDES,
  ARRAY_M_INDEX_OF,
  ARRAY_M_JOIN,
  ARRAY_M_KEYS,
  ARRAY_M_LAST_INDEX_OF,
  ARRAY_M_MAP,
  ARRAY_M_POP,
  ARRAY_M_PUSH,
  ARRAY_M_REDUCE,
  ARRAY_M_REDUCE_RIGHT,
  ARRAY_M_REVERSE,
  ARRAY_M_SHIFT,
  ARRAY_M_SLICE,
  ARRAY_M_SOME,
  ARRAY_M_SORT,
  ARRAY_M_SPLICE,
  ARRAY_M_TO_REVERSED,
  ARRAY_M_TO_SORTED,
  ARRAY_M_TO_SPLICED,
  ARRAY_M_TO_STRING,
  ARRAY_M_UNSHIFT,
  ARRAY_M_VALUES,
  ARRAY_M_WITH
} ArrayMethod;

static const struct {
  const char *name;
  uint8_t arity;
  uint8_t op;
} ARRAY_METHOD_TABLE[] = {
    {"at", 1, ARRAY_M_AT},
    {"concat", 1, ARRAY_M_CONCAT},
    {"copyWithin", 2, ARRAY_M_COPY_WITHIN},
    {"entries", 0, ARRAY_M_ENTRIES},
    {"every", 1, ARRAY_M_EVERY},
    {"fill", 1, ARRAY_M_FILL},
    {"filter", 1, ARRAY_M_FILTER},
    {"find", 1, ARRAY_M_FIND},
    {"findIndex", 1, ARRAY_M_FIND_INDEX},
    {"findLast", 1, ARRAY_M_FIND_LAST},
    {"findLastIndex", 1, ARRAY_M_FIND_LAST_INDEX},
    {"flat", 0, ARRAY_M_FLAT},
    {"flatMap", 1, ARRAY_M_FLAT_MAP},
    {"forEach", 1, ARRAY_M_FOR_EACH},
    {"includes", 1, ARRAY_M_INCLUDES},
    {"indexOf", 1, ARRAY_M_INDEX_OF},
    {"join", 1, ARRAY_M_JOIN},
    {"keys", 0, ARRAY_M_KEYS},
    {"lastIndexOf", 1, ARRAY_M_LAST_INDEX_OF},
    {"map", 1, ARRAY_M_MAP},
    {"pop", 0, ARRAY_M_POP},
    {"push", 1, ARRAY_M_PUSH},
    {"reduce", 1, ARRAY_M_REDUCE},
    {"reduceRight", 1, ARRAY_M_REDUCE_RIGHT},
    {"reverse", 0, ARRAY_M_REVERSE},
    {"shift", 0, ARRAY_M_SHIFT},
    {"slice", 2, ARRAY_M_SLICE},
    {"some", 1, ARRAY_M_SOME},
    {"sort", 1, ARRAY_M_SORT},
    {"splice", 2, ARRAY_M_SPLICE},
    {"toReversed", 0, ARRAY_M_TO_REVERSED},
    {"toSorted", 1, ARRAY_M_TO_SORTED},
    {"toSpliced", 2, ARRAY_M_TO_SPLICED},
    {"toString", 0, ARRAY_M_TO_STRING},
    {"unshift", 1, ARRAY_M_UNSHIFT},
    {"values", 0, ARRAY_M_VALUES},
    {"with", 2, ARRAY_M_WITH},
};

/* The bound receiver and op travel in the closure's environment -- slot 0 the array (kept alive
 * by the trace), slot 1 the op as a number -- so `jsrt_call` needs no new protocol: the
 * trampoline reads both where a capturing function reads its bindings. `has_receiver` is false:
 * the receiver is already bound, and a second one in argv would shift every user argument. */
static jsrt_value array_method_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const jsrt_value receiver = env->slots[0];
  const ArrayMethod op = (ArrayMethod)jsrt_to_number(env->slots[1]);
  const jsrt_value a0 = jsrt_arg(argc, argv, 0);
  const jsrt_value a1 = jsrt_arg(argc, argv, 1);
  const jsrt_value a2 = jsrt_arg(argc, argv, 2);
  switch (op) {
    case ARRAY_M_AT:
      return jsrt_array_at(receiver, a0);
    case ARRAY_M_CONCAT:
      return concat_items(receiver, argc, argv);
    case ARRAY_M_COPY_WITHIN:
      return jsrt_array_copy_within(receiver, a0, a1, a2);
    case ARRAY_M_ENTRIES:
      return jsrt_iterator_new(receiver, JSRT_ITER_ARRAY_ENTRIES);
    case ARRAY_M_EVERY:
      return jsrt_array_every(receiver, a0);
    case ARRAY_M_FILL:
      return jsrt_array_fill(receiver, a0, a1, a2);
    case ARRAY_M_FILTER:
      return jsrt_array_filter(receiver, a0);
    case ARRAY_M_FIND:
      return jsrt_array_find(receiver, a0);
    case ARRAY_M_FIND_INDEX:
      return jsrt_array_find_index(receiver, a0);
    case ARRAY_M_FIND_LAST:
      return jsrt_array_find_last(receiver, a0);
    case ARRAY_M_FIND_LAST_INDEX:
      return jsrt_array_find_last_index(receiver, a0);
    case ARRAY_M_FLAT:
      return jsrt_array_flat(receiver, a0);
    case ARRAY_M_FLAT_MAP:
      return jsrt_array_flat_map(receiver, a0);
    case ARRAY_M_FOR_EACH:
      return jsrt_array_for_each(receiver, a0);
    case ARRAY_M_INCLUDES:
      return jsrt_array_includes(receiver, a0, a1);
    case ARRAY_M_INDEX_OF:
      return jsrt_array_index_of(receiver, a0, a1);
    case ARRAY_M_JOIN:
      return jsrt_array_join(receiver, a0);
    case ARRAY_M_KEYS:
      return jsrt_iterator_new(receiver, JSRT_ITER_ARRAY_KEYS);
    case ARRAY_M_LAST_INDEX_OF:
      return argc >= 2 ? jsrt_array_last_index_of_from(receiver, a0, a1)
                       : jsrt_array_last_index_of(receiver, a0);
    case ARRAY_M_MAP:
      return jsrt_array_map(receiver, a0);
    case ARRAY_M_POP:
      return jsrt_array_pop(receiver);
    case ARRAY_M_PUSH:
      return push_items(receiver, argc, argv);
    case ARRAY_M_REDUCE:
      return jsrt_array_reduce(receiver, a0, a1);
    case ARRAY_M_REDUCE_RIGHT:
      return jsrt_array_reduce_right(receiver, a0, a1);
    case ARRAY_M_REVERSE:
      return jsrt_array_reverse(receiver);
    case ARRAY_M_SHIFT:
      return jsrt_array_shift(receiver);
    case ARRAY_M_SLICE:
      return jsrt_array_slice(receiver, a0, a1);
    case ARRAY_M_SOME:
      return jsrt_array_some(receiver, a0);
    case ARRAY_M_SORT:
      return jsrt_array_sort(receiver, a0);
    case ARRAY_M_SPLICE:
      if (argc == 0) {
        return jsrt_array_splice(receiver, JSRT_UNDEFINED, JSRT_UNDEFINED);
      }
      if (argc == 1) {
        return jsrt_array_splice_from(receiver, a0);
      }
      if (argc == 2) {
        return jsrt_array_splice(receiver, a0, a1);
      }
      return splice_insert_items(receiver, a0, a1, argc - 2, argv + 2);
    case ARRAY_M_TO_REVERSED:
      return jsrt_array_to_reversed(receiver);
    case ARRAY_M_TO_SORTED:
      return jsrt_array_to_sorted(receiver, a0);
    case ARRAY_M_TO_SPLICED:
      return jsrt_array_to_spliced(receiver, a0, a1);
    case ARRAY_M_TO_STRING:
      return jsrt_array_to_string(receiver);
    case ARRAY_M_UNSHIFT:
      return unshift_items(receiver, argc, argv);
    case ARRAY_M_VALUES:
      return jsrt_iterator_new(receiver, JSRT_ITER_ARRAY_VALUES);
    case ARRAY_M_WITH:
      return jsrt_array_with(receiver, a0, a1);
  }
  jsrt_panic("array method dispatch fell through its own table");
}

jsrt_value jsrt_bound_method(jsrt_value receiver, uint32_t row,
                             jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env),
                             uint32_t length, const char *name) {
  JSRTEnv *env = jsrt_env_new(NULL, 2);
  env->slots[0] = receiver;
  env->slots[1] = jsrt_number((double)row);
  return jsrt_closure_new(fn, length, name, env, false);
}

bool jsrt_array_method(jsrt_value array, const char *key, jsrt_value *out) {
  if (!jsrt_is(array, JSRT_TAG_ARRAY)) {
    return false;
  }
  for (size_t i = 0; i < sizeof ARRAY_METHOD_TABLE / sizeof ARRAY_METHOD_TABLE[0]; i++) {
    if (strcmp(ARRAY_METHOD_TABLE[i].name, key) == 0) {
      *out = jsrt_bound_method(array, (uint32_t)ARRAY_METHOD_TABLE[i].op, array_method_call,
                               ARRAY_METHOD_TABLE[i].arity, ARRAY_METHOD_TABLE[i].name);
      return true;
    }
  }
  return false;
}
