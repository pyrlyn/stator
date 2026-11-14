/* jsrt_map.c — Map and Set: SameValueZero keys, insertion order, one implementation for both.
 *
 * The structure is documented in jsrt_value.h. What lives here is the part a comment in a header
 * cannot carry: the equality and hash rules, which are where a collection keyed by JavaScript
 * values goes wrong.
 *
 * SameValueZero is NOT `===` and NOT `Object.is`. It differs from each in exactly one place:
 * `NaN` is its own key (unlike `===`) and `-0` is the same key as `+0` (unlike `Object.is`). Both
 * cases are reachable from ordinary arithmetic — `0/0` and `-1 * 0` — so neither is a curiosity.
 */

#include "jsrt.h"
#include "jsrt_value.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* One descriptor each, file-scope and const: the printer's test and `instanceof` are both pointer
 * comparisons against these. No fields, because a Map's entries are not slots — nothing in the
 * subset can reach them by name. */
const JSRTClass jsrt_class_map = {"Map", 0, NULL, NULL, 0, NULL, NULL, NULL};
const JSRTClass jsrt_class_set = {"Set", 0, NULL, NULL, 0, NULL, NULL, NULL};

/* ============================================================================
 * Keys — SameValueZero and a hash that agrees with it
 * ============================================================================ */

/* Two keys that are equal MUST hash equally, and the two functions below are the only place that
 * pairing is stated. Every case where they could drift is a number: `-0` and `+0` are one key with
 * different bits, `NaN` is one key with several possible bit patterns, and once the Int32 tag is
 * emitted `5` has two representations. Normalizing to a double first is what collapses all three. */
static uint64_t mix64(uint64_t x) {
  /* splitmix64's finalizer: a cheap avalanche, so a pointer's low zero bits and a small integer's
   * high zero bits both spread across the table instead of clustering in one probe chain. */
  x ^= x >> 30;
  x *= UINT64_C(0xbf58476d1ce4e5b9);
  x ^= x >> 27;
  x *= UINT64_C(0x94d049bb133111eb);
  x ^= x >> 31;
  return x;
}

static uint64_t hash_key(jsrt_value v) {
  if (jsrt_is_number(v)) {
    double d = jsrt_number_value(v);
    if (isnan(d)) {
      return mix64(JSRT_CANONICAL_NAN);
    }
    if (d == 0.0) {
      d = 0.0; /* +0, so that -0 lands in the same bucket as the key it equals */
    }
    uint64_t bits;
    memcpy(&bits, &d, sizeof bits);
    return mix64(bits);
  }
  if (jsrt_is(v, JSRT_TAG_STRING)) {
    /* Strings are keyed by CONTENT, so the hash reads the code units. FNV-1a over UTF-16 units,
     * which is the same unit `jsrt_string_equals` compares. */
    uint64_t h = UINT64_C(1469598103934665603);
    const uint32_t n = jsrt_string_length(v);
    for (uint32_t i = 0; i < n; i++) {
      h ^= jsrt_string_char(v, i);
      h *= UINT64_C(1099511628211);
    }
    return mix64(h);
  }
  /* Objects, arrays, closures, booleans, null, undefined: the box IS the identity. Two distinct
   * objects with identical contents are different keys, which is what JavaScript says. */
  return mix64(v);
}

static bool same_value_zero(jsrt_value a, jsrt_value b) {
  if (jsrt_is_number(a) && jsrt_is_number(b)) {
    const double x = jsrt_number_value(a);
    const double y = jsrt_number_value(b);
    /* `x == y` already gives `-0 == +0`; the NaN pair is the one case C's `==` gets wrong for a
     * key, because a Map really does find the value stored under NaN. */
    return x == y || (isnan(x) && isnan(y));
  }
  if (jsrt_is(a, JSRT_TAG_STRING) && jsrt_is(b, JSRT_TAG_STRING)) {
    return jsrt_string_equals(a, b);
  }
  return a == b;
}

/* ============================================================================
 * Storage
 * ============================================================================ */

static void *map_alloc(size_t bytes) {
  void *p = jsrt_gc_alloc(bytes, "map");
  return p;
}

/* The empty state, which a fresh collection and a cleared one are the same thing: both own nothing,
 * and the next insert allocates from scratch. Written once so the two cannot drift apart -- a
 * `clear` that left one field behind would be a table whose count disagrees with its storage. */
static void map_reset(JSRTMap *m) {
  m->size = 0;
  m->used = 0;
  m->capacity = 0;
  m->entries = NULL;
  m->index = NULL;
  m->index_mask = 0;
}

static jsrt_value map_new(const JSRTClass *cls) {
  JSRTMap *m = (JSRTMap *)map_alloc(sizeof(JSRTMap));
  m->cls = cls;
  /* Set here and NOT in map_reset: `clear()` resets through that path, and a clear called from
   * inside a forEach must not re-enable compaction while the walk still holds an index. */
  m->iterating = 0;
  map_reset(m);
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)m);
}

jsrt_value jsrt_map_new(void) { return map_new(&jsrt_class_map); }
jsrt_value jsrt_set_new(void) { return map_new(&jsrt_class_set); }

/* Probe for `key`. Returns the live entry holding it, or NULL; either way `*slot` is left on the
 * index position the key belongs at — the entry's own position on a hit, the first empty one on a
 * miss, which is where an insert writes. A dead entry does not stop the probe: it is passed over
 * like a mismatch, so a chain broken by a deletion still reaches what follows it. */
static JSRTMapEntry *probe(const JSRTMap *m, jsrt_value key, uint32_t *slot) {
  if (m->index == NULL) {
    *slot = 0;
    return NULL;
  }
  uint32_t i = (uint32_t)(hash_key(key) & m->index_mask);
  for (;;) {
    const uint32_t held = m->index[i];
    if (held == 0) {
      *slot = i;
      return NULL;
    }
    JSRTMapEntry *entry = &m->entries[held - 1];
    if (entry->live && same_value_zero(entry->key, key)) {
      *slot = i;
      return entry;
    }
    i = (i + 1) & m->index_mask;
  }
}

/* Make room for one more entry: compact the dead ones away, grow if the live ones alone fill the
 * array, and rebuild the index over what survives.
 *
 * Compaction is what keeps `set`/`delete` in a loop from growing without bound, and it is also the
 * only thing that renumbers entries — which is why the index is rebuilt here rather than patched. */
static void grow(JSRTMap *m) {
  /* A forEach in progress holds an index into `entries`, and compaction is the only thing that
   * renumbers them -- so while one is walking, dead entries keep their slots and the array grows
   * unconditionally. Without this a callback that inserts could trigger a compaction that shifts
   * every later entry down, and the walk would SKIP the ones it stepped over. */
  const bool compacting = m->iterating == 0;
  uint32_t capacity = m->capacity;
  if (!compacting || m->size + 1 > capacity / 2) {
    capacity = capacity == 0 ? 8 : capacity * 2;
  }

  JSRTMapEntry *entries = (JSRTMapEntry *)map_alloc(capacity * sizeof(JSRTMapEntry));
  uint32_t used = 0;
  for (uint32_t i = 0; i < m->used; i++) {
    if (compacting && !m->entries[i].live) {
      continue;
    }
    entries[used++] = m->entries[i];
  }
  /* Past `used` the array is scanned conservatively, so it must not hold bits that look like a
   * pointer to something already unreachable. */
  for (uint32_t i = used; i < capacity; i++) {
    entries[i].key = JSRT_UNDEFINED;
    entries[i].value = JSRT_UNDEFINED;
    entries[i].live = false;
  }

  uint32_t slots = 16;
  while (slots < capacity * 2) {
    slots *= 2;
  }
  uint32_t *index = (uint32_t *)map_alloc(slots * sizeof(uint32_t));
  memset(index, 0, slots * sizeof(uint32_t));

  m->entries = entries;
  m->used = used;
  m->capacity = capacity;
  m->index = index;
  m->index_mask = slots - 1;

  for (uint32_t i = 0; i < used; i++) {
    if (!entries[i].live) {
      continue; /* a preserved dead entry holds its slot but is not findable */
    }
    uint32_t slot;
    (void)probe(m, entries[i].key, &slot);
    m->index[slot] = i + 1;
  }
}

/* ============================================================================
 * Operations
 * ============================================================================ */

jsrt_value jsrt_map_get(jsrt_value map, jsrt_value key) {
  uint32_t slot;
  const JSRTMapEntry *entry = probe(jsrt_as_map(map), key, &slot);
  return entry == NULL ? JSRT_UNDEFINED : entry->value;
}

bool jsrt_map_has(jsrt_value map, jsrt_value key) {
  uint32_t slot;
  return probe(jsrt_as_map(map), key, &slot) != NULL;
}

/* §24.1.3.9 step 6 and §24.2.3.1 step 4: a key of -0 is STORED as +0. SameValueZero already finds
 * one through the other, so this changes no lookup -- it changes what the entry prints as and what
 * a forEach callback is handed, both of which are observable (`1 / k`). */
static jsrt_value normalized_key(jsrt_value key) {
  return jsrt_is_number(key) && jsrt_number_value(key) == 0.0 ? jsrt_number(0.0) : key;
}

static jsrt_value map_put(jsrt_value map, jsrt_value raw_key, jsrt_value value) {
  const jsrt_value key = normalized_key(raw_key);
  JSRTMap *m = jsrt_as_map(map);
  uint32_t slot;
  JSRTMapEntry *entry = probe(m, key, &slot);
  if (entry != NULL) {
    /* An existing key keeps its position: `m.set('a', 2)` on a map that already has `'a'` changes
     * the value and NOT the order the entry prints in. */
    entry->value = value;
    return map;
  }
  if (m->used == m->capacity) {
    grow(m);
    (void)probe(m, key, &slot); /* the index was rebuilt, so the slot from before is meaningless */
  }
  m->entries[m->used].key = key;
  m->entries[m->used].value = value;
  m->entries[m->used].live = true;
  m->index[slot] = m->used + 1;
  m->used++;
  m->size++;
  return map;
}

jsrt_value jsrt_map_set(jsrt_value map, jsrt_value key, jsrt_value value) {
  return map_put(map, key, value);
}

jsrt_value jsrt_set_add(jsrt_value set, jsrt_value key) {
  return map_put(set, key, JSRT_UNDEFINED);
}

/* The walk both collections share. `used` is re-read each step because a callback may append --
 * the spec visits entries added during the walk -- and the entry is re-read through the map
 * because an append can reallocate `entries`. Indices stay meaningful across that reallocation
 * only because `iterating` suppresses compaction; the counter is what makes the cursor valid.
 *
 * `pass_key` is the Map/Set difference in full: a Set hands the element to the callback twice,
 * because a Set entry is its own key. */
static jsrt_value for_each(jsrt_value collection, jsrt_value cb, bool pass_key) {
  JSRTMap *m = jsrt_as_map(collection);
  m->iterating++;
  for (uint32_t i = 0; i < m->used && !jsrt_pending(); i++) {
    if (!m->entries[i].live) {
      continue; /* deleted before it was reached: the spec does not visit it */
    }
    const jsrt_value key = m->entries[i].key;
    jsrt_value args[3] = {pass_key ? m->entries[i].value : key, key, collection};
    jsrt_call(cb, 3, args);
  }
  m->iterating--;
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_map_for_each(jsrt_value map, jsrt_value cb) { return for_each(map, cb, true); }

jsrt_value jsrt_set_for_each(jsrt_value set, jsrt_value cb) { return for_each(set, cb, false); }

void jsrt_map_iter_begin(jsrt_value map) { jsrt_as_map(map)->iterating++; }

void jsrt_map_iter_end(jsrt_value map) { jsrt_as_map(map)->iterating--; }

/* Shared by Map and Set for-of. `used` is re-read every call because the body may append, and the
 * entry is re-read through the map because an append can reallocate `entries`. Indices stay valid
 * across that reallocation only because `begin` suppressed compaction. */
bool jsrt_map_iter_step(
    jsrt_value collection, uint32_t *index, jsrt_value *key, jsrt_value *value) {
  JSRTMap *m = jsrt_as_map(collection);
  while (*index < m->used) {
    const uint32_t i = (*index)++;
    if (!m->entries[i].live) {
      continue; /* deleted before it was reached: the spec does not visit it */
    }
    *key = m->entries[i].key;
    *value = m->entries[i].value;
    return true;
  }
  return false;
}

static bool collection_iter_next(
    jsrt_value collection, uint32_t *index, jsrt_value *out, bool pairs) {
  jsrt_value key;
  jsrt_value value;
  if (!jsrt_map_iter_step(collection, index, &key, &value)) {
    return false;
  }
  if (pairs) {
    jsrt_value items[2] = {key, value};
    *out = jsrt_array_new(2, items);
  } else {
    *out = key;
  }
  return true;
}

bool jsrt_map_iter_next(jsrt_value map, uint32_t *index, jsrt_value *out) {
  return collection_iter_next(map, index, out, true);
}

bool jsrt_set_iter_next(jsrt_value set, uint32_t *index, jsrt_value *out) {
  return collection_iter_next(set, index, out, false);
}

bool jsrt_map_delete(jsrt_value map, jsrt_value key) {
  JSRTMap *m = jsrt_as_map(map);
  uint32_t slot;
  JSRTMapEntry *entry = probe(m, key, &slot);
  if (entry == NULL) {
    return false;
  }
  /* Blanked, not just flagged: the entry stays in place so the entries after it keep their
   * positions, and holding the old key here would keep a dead object reachable. */
  entry->key = JSRT_UNDEFINED;
  entry->value = JSRT_UNDEFINED;
  entry->live = false;
  m->size--;
  return true;
}

jsrt_value jsrt_map_clear(jsrt_value map) {
  /* Dropping both allocations is the whole operation -- a cleared collection IS an empty one. */
  map_reset(jsrt_as_map(map));
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_map_size(jsrt_value map) {
  return jsrt_number((double)jsrt_as_map(map)->size);
}

/* ============================================================================
 * The ES2025 set operations (§24.2.4)
 * ============================================================================
 *
 * The spec takes a SET-LIKE argument -- any object with a numeric `size`, a callable `has` and a
 * callable `keys` -- and reads it through GetSetRecord, iterating it with `keys()`. The gate
 * accepts only a real Set, so these read the second table directly: a set-like OBJECT would need
 * the iteration protocol the subset does not have, and refusing it is the honest answer.
 *
 * Order is normative here, and it is not always the receiver's. `intersection` walks whichever
 * collection is SMALLER and appends in that one's order, which the spec spells out step by step
 * and the pinned Node observes -- so it is a semantics rule, not an optimization. Everything else
 * appends the receiver's elements first and the argument's after.
 *
 * None of these mutates either operand: each builds a new Set. */

static uint32_t set_count(jsrt_value s) { return jsrt_as_map(s)->size; }

/* Append every live key of `from` to `into`, in insertion order. `map_put` leaves an existing key
 * where it already sits, so this is also how a union keeps the receiver's positions. */
static void copy_keys(jsrt_value into, jsrt_value from) {
  const JSRTMap *m = jsrt_as_map(from);
  for (uint32_t i = 0; i < m->used; i++) {
    if (m->entries[i].live) {
      jsrt_set_add(into, m->entries[i].key);
    }
  }
}

/* The live keys of a set, in insertion order: `*at` walks ENTRY indices (not element numbers), and
 * each call advances it past the dead ones. False ends the walk. None of the operations below runs
 * user code or writes to the collection it is walking, so the cursor needs none of the compaction
 * suppression `forEach` does. */
static bool next_key(jsrt_value s, uint32_t *at, jsrt_value *key) {
  const JSRTMap *m = jsrt_as_map(s);
  for (; *at < m->used; (*at)++) {
    if (m->entries[*at].live) {
      *key = m->entries[(*at)++].key;
      return true;
    }
  }
  return false;
}

jsrt_value jsrt_set_union(jsrt_value a, jsrt_value b) {
  jsrt_value out = jsrt_set_new();
  copy_keys(out, a);
  copy_keys(out, b);
  return out;
}

jsrt_value jsrt_set_intersection(jsrt_value a, jsrt_value b) {
  /* §24.2.4.9: the walk runs over the receiver only while the receiver is no larger than the
   * argument; otherwise it runs over the argument, and the RESULT ORDER follows it. */
  const bool walk_a = set_count(a) <= set_count(b);
  const jsrt_value walk = walk_a ? a : b;
  const jsrt_value test = walk_a ? b : a;
  jsrt_value out = jsrt_set_new();
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(walk, &at, &key)) {
    if (jsrt_map_has(test, key)) {
      jsrt_set_add(out, key);
    }
  }
  return out;
}

jsrt_value jsrt_set_difference(jsrt_value a, jsrt_value b) {
  jsrt_value out = jsrt_set_new();
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(a, &at, &key)) {
    if (!jsrt_map_has(b, key)) {
      jsrt_set_add(out, key);
    }
  }
  return out;
}

jsrt_value jsrt_set_symmetric_difference(jsrt_value a, jsrt_value b) {
  jsrt_value out = jsrt_set_new();
  copy_keys(out, a);
  /* Membership is tested against A, not against the result: the result is losing keys as this
   * runs, and the spec asks whether the RECEIVER had the key. */
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(b, &at, &key)) {
    if (jsrt_map_has(a, key)) {
      (void)jsrt_map_delete(out, key);
    } else {
      jsrt_set_add(out, key);
    }
  }
  return out;
}

bool jsrt_set_is_subset_of(jsrt_value a, jsrt_value b) {
  /* The size test is not a shortcut -- it is the spec's first step, and it is what makes the walk
   * below sufficient: a set cannot be contained in a smaller one. */
  if (set_count(a) > set_count(b)) {
    return false;
  }
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(a, &at, &key)) {
    if (!jsrt_map_has(b, key)) {
      return false;
    }
  }
  return true;
}

bool jsrt_set_is_superset_of(jsrt_value a, jsrt_value b) {
  if (set_count(a) < set_count(b)) {
    return false;
  }
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(b, &at, &key)) {
    if (!jsrt_map_has(a, key)) {
      return false;
    }
  }
  return true;
}

bool jsrt_set_is_disjoint_from(jsrt_value a, jsrt_value b) {
  /* Either side answers the same question, so the smaller walk is a true optimization here --
   * unlike `intersection`, a boolean has no order to observe. */
  const bool walk_a = set_count(a) <= set_count(b);
  const jsrt_value walk = walk_a ? a : b;
  const jsrt_value test = walk_a ? b : a;
  uint32_t at = 0;
  jsrt_value key;
  while (next_key(walk, &at, &key)) {
    if (jsrt_map_has(test, key)) {
      return false;
    }
  }
  return true;
}
