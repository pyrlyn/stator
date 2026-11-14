/* jsrt_shape.c — dynamic objects: the shape table (hidden classes) and inline caches.
 *
 * Design and invariants: docs/VALUE.md §4.10 and the header block over JSRTShape. What this file
 * has to get right, beyond the structures: an IC is filled ONLY on a hit against the object's
 * current shape, so a filled cache can be trusted by pointer compare alone; a get MISS is never
 * cached (the object can gain the key later under a different shape); and a transition reuses an
 * existing child before allocating, because shape sharing is the entire point — two objects that
 * gained the same keys in the same order must land on the same shape or every IC downstream of
 * them degrades to the slow path.
 */

#include "jsrt.h"
#include "jsrt_value.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const JSRTClass jsrt_class_dynamic = {"", 0, NULL, NULL, 0, NULL, NULL, NULL};

/* Identical to `jsrt_class_dynamic` in every field that means anything -- the SHAPE owns the layout
 * -- and distinct from it by address, which is the whole job: it marks the objects §22.2.7.2 builds
 * with a null prototype so the printer writes Node's `[Object: null prototype]` prefix. */
const JSRTClass jsrt_class_null_proto = {"", 0, NULL, NULL, 0, NULL, NULL, NULL};

/* The descriptor that marks an accessor CELL (docs/VALUE.md §4.15). Like the two above it means
 * nothing by its fields and everything by its address: a property read tests the value it just
 * loaded against this pointer to tell a get/set pair from an ordinary property value. Nothing in
 * the language can build one, so the test cannot be fooled -- jsrt_define_accessor is the only
 * producer. */
const JSRTClass jsrt_class_accessor = {"", 0, NULL, NULL, 0, NULL, NULL, NULL};

/* The one shape with no key: every dynamic object starts here. Static, so "has no properties"
 * needs no allocation and compares by address. */
static JSRTShape shape_root = {NULL, NULL, 0, NULL, NULL};

/* Slot storage holds jsrt_values, so under Boehm it must be a COLLECTED allocation the collector
 * scans; the shapes themselves hold no values and are immortal metadata, so they use plain malloc
 * either way (a shape is never garbage: the table only grows, by design). */
static void *slots_alloc(size_t bytes) {
  void *p = jsrt_gc_alloc(bytes, "dynamic object slots");
  return p;
}

static uint32_t shape_slot_count(const JSRTShape *shape) {
  if (shape->key == NULL) {
    return 0;
  }
  return shape->offset + 1;
}

/* A property is an array index exactly when its canonical decimal spelling round-trips through
 * ToUint32 and is not 2^32-1.  Shape keys are UTF-8, so non-ASCII bytes and any leading zero make
 * the key an ordinary string. */
static bool array_index_value(const char *key, uint32_t *value) {
  if (key[0] == '\0' || (key[0] == '0' && key[1] != '\0')) {
    return false;
  }
  uint64_t parsed = 0;
  for (const unsigned char *p = (const unsigned char *)key; *p != '\0'; p++) {
    if (*p < '0' || *p > '9') {
      return false;
    }
    const uint64_t digit = (uint64_t)(*p - '0');
    if (parsed > ((uint64_t)UINT32_MAX - 1u - digit) / 10u) {
      return false;
    }
    parsed = parsed * 10u + digit;
  }
  *value = (uint32_t)parsed;
  return true;
}

static bool property_before(const JSRTShape *a, const JSRTShape *b) {
  uint32_t ai = 0;
  uint32_t bi = 0;
  const bool a_is_index = array_index_value(a->key, &ai);
  const bool b_is_index = array_index_value(b->key, &bi);
  if (a_is_index != b_is_index) {
    return a_is_index;
  }
  if (a_is_index && ai != bi) {
    return ai < bi;
  }
  /* Distinct canonical index keys cannot tie; this offset tie-breaker preserves insertion order
   * for ordinary keys and keeps the sort deterministic if malformed metadata ever appears. */
  return a->offset < b->offset;
}

uint32_t jsrt_shape_property_count(const JSRTShape *shape) {
  /* NULL is an array that never gained a property -- the same "no properties" the root shape means
   * for a dynamic object, spelled without an allocation. */
  return shape == NULL || shape->key == NULL ? 0 : shape->offset + 1;
}

/* The chain flattened into slot order: `links[i]` is the shape node whose value lives in slot `i`.
 * That IS insertion order, which both callers need before doing anything else -- enumeration sorts
 * it, and a delete replays it. */
static const JSRTShape **shape_links(const JSRTShape *shape, uint32_t count) {
  const JSRTShape **links =
      (const JSRTShape **)malloc((size_t)count * sizeof(const JSRTShape *));
  if (links == NULL && count > 0) {
    jsrt_panic("out of memory: dynamic object keys");
  }
  for (const JSRTShape *s = shape; s != NULL && s->key != NULL; s = s->parent) {
    links[s->offset] = s;
  }
  return links;
}

const JSRTShape **jsrt_shape_property_order(const JSRTShape *shape, uint32_t count) {
  const JSRTShape **links = shape_links(shape, count);
  /* Stable insertion sort is sufficient for shape-sized key sets and avoids a comparator carrying
   * hidden state.  Offset order is the insertion order for non-index keys. */
  for (uint32_t i = 1; i < count; i++) {
    const JSRTShape *current = links[i];
    uint32_t j = i;
    while (j > 0 && property_before(current, links[j - 1])) {
      links[j] = links[j - 1];
      j--;
    }
    links[j] = current;
  }
  return links;
}

static JSRTDynObject *as_dynobj(jsrt_value v, const char *op) {
  (void)op;
  return (JSRTDynObject *)jsrt_ptr(v);
}

static bool has_prop_table(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_ARRAY) || jsrt_is_dynobj(v);
}

static int32_t fixed_slot(jsrt_value obj, const char *key) {
  JSRTObject *o = jsrt_as_object(obj);
  const JSRTClass *cls = o->cls;
  if (cls->fields == NULL) {
    return -1;
  }
  for (uint32_t i = 0; i < cls->field_count; i++) {
    const char *name = cls->fields[i];
    if (name != NULL && (name == key || strcmp(name, key) == 0)) {
      return (int32_t)i;
    }
  }
  return -1;
}

static jsrt_value fixed_get(jsrt_value obj, const char *key) {
  const int32_t slot = fixed_slot(obj, key);
  return slot < 0 ? JSRT_UNDEFINED : jsrt_as_object(obj)->fields[slot];
}

static bool fixed_set(jsrt_value obj, const char *key, jsrt_value value) {
  const int32_t slot = fixed_slot(obj, key);
  if (slot < 0) {
    return false;
  }
  jsrt_as_object(obj)->fields[slot] = value;
  return true;
}

static bool fixed_has(jsrt_value obj, const char *key) { return fixed_slot(obj, key) >= 0; }

/* The property table, as the two receivers that own one both expose it: a dynamic object keeps it
 * inline, an array keeps it beside its elements. Everything below walks this view, so a match
 * array's `m.index` and a `{ }` receiver's `o.x` are literally the same code path -- which is what
 * makes an inline cache filled at one site valid however the value was built. */
typedef struct {
  JSRTShape **shape;
  jsrt_value **slots;
  uint32_t *capacity;
} PropTable;

static PropTable as_prop_table(jsrt_value v, const char *op) {
  if (jsrt_is(v, JSRT_TAG_ARRAY)) {
    JSRTArray *a = jsrt_as_array(v);
    if (a->shape == NULL) {
      a->shape = &shape_root; /* first touch: an ordinary array pays nothing until here */
    }
    return (PropTable){&a->shape, &a->slots, &a->slot_capacity};
  }
  JSRTDynObject *o = as_dynobj(v, op);
  return (PropTable){&o->shape, &o->slots, &o->capacity};
}

/* A shape key from a JS string. The shape table stores keys as NUL-terminated UTF-8 and keeps the
 * pointer forever, so the copy is deliberately immortal -- exactly the lifetime shapes already
 * have, and the reason this is plain malloc rather than a collected allocation. Surrogate pairs
 * combine into one code point; a lone surrogate is encoded as itself. U+0000 has no
 * representation in a C string and aborts loudly rather than truncating the key silently. */
const char *jsrt_shape_key(jsrt_value name) {
  const uint32_t len = jsrt_string_length(name);
  /* Worst case is three bytes per code unit: an astral PAIR takes four bytes for two units. */
  char *key = (char *)malloc((size_t)len * 3 + 1);
  if (key == NULL) {
    jsrt_panic("out of memory: shape key");
  }
  size_t k = 0;
  for (uint32_t i = 0; i < len; i++) {
    uint32_t cp = jsrt_string_char(name, i);
    if (cp == 0) {
      jsrt_panic("STA2005: a property key containing U+0000 is not yet representable");
    }
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < len) {
      const uint16_t trail = jsrt_string_char(name, i + 1);
      if (trail >= 0xDC00 && trail <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (trail - 0xDC00);
        i++;
      }
    }
    if (cp < 0x80) {
      key[k++] = (char)cp;
    } else if (cp < 0x800) {
      key[k++] = (char)(0xC0 | (cp >> 6));
      key[k++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      key[k++] = (char)(0xE0 | (cp >> 12));
      key[k++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      key[k++] = (char)(0x80 | (cp & 0x3F));
    } else {
      key[k++] = (char)(0xF0 | (cp >> 18));
      key[k++] = (char)(0x80 | ((cp >> 12) & 0x3F));
      key[k++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      key[k++] = (char)(0x80 | (cp & 0x3F));
    }
  }
  key[k] = '\0';
  return key;
}

static jsrt_value dynobj_new(const JSRTClass *cls) {
  JSRTDynObject *o = (JSRTDynObject *)slots_alloc(sizeof(JSRTDynObject));
  o->cls = cls;
  o->shape = &shape_root;
  o->capacity = 0;
  o->slots = NULL;
  o->frozen = false;
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)o);
}

jsrt_value jsrt_dynobj_new(void) { return dynobj_new(&jsrt_class_dynamic); }

jsrt_value jsrt_null_proto_new(void) { return dynobj_new(&jsrt_class_null_proto); }

/* The chain walk both get and set share: the object's live keys are exactly the keys on the path
 * from its shape back to the root. Pointer compare first — generated C passes string literals,
 * and the transition that created the shape stored that same literal — with strcmp as the
 * correctness backstop for a key spelled at two sites. */
static const JSRTShape *shape_find(const JSRTShape *shape, const char *key) {
  for (const JSRTShape *s = shape; s->key != NULL; s = s->parent) {
    if (s->key == key || strcmp(s->key, key) == 0) {
      return s;
    }
  }
  return NULL;
}

/* The child of `from` that adds `key`, reusing an existing one before allocating. Reuse before
 * allocation is what keeps two same-history objects on ONE shape -- and it is why a delete can
 * replay a chain minus one key and land where an object built without that key would have. */
static JSRTShape *shape_transition(JSRTShape *from, const char *key) {
  for (JSRTShape *s = from->transitions; s != NULL; s = s->sibling) {
    if (s->key == key || strcmp(s->key, key) == 0) {
      return s;
    }
  }
  JSRTShape *next = (JSRTShape *)malloc(sizeof(JSRTShape));
  if (next == NULL) {
    jsrt_panic("out of memory: shape");
  }
  next->parent = from;
  next->key = key;
  next->offset = shape_slot_count(from);
  next->transitions = NULL;
  next->sibling = from->transitions;
  from->transitions = next;
  return next;
}

/* A loaded slot, resolved. An accessor cell becomes a call with the receiver as argument zero --
 * the ordinary method ABI (docs/VALUE.md §4.5), so an accessor body is an ordinary function unit.
 * A cell with no getter reads `undefined`, which is what §10.4.x AccessorDescriptor Get answers
 * when [[Get]] is undefined. */
static jsrt_value accessor_read(jsrt_value slot, jsrt_value recv) {
  if (!jsrt_is_accessor_cell(slot)) {
    return slot;
  }
  const JSRTAccessorCell *cell = (const JSRTAccessorCell *)jsrt_ptr(slot);
  return cell->get == JSRT_UNDEFINED ? JSRT_UNDEFINED : jsrt_call(cell->get, 1, &recv);
}

/* Answers whether the write was an accessor's, so the caller knows not to store. A setter-less
 * accessor THROWS rather than silently dropping the write: compiled modules are always strict, and
 * strict mode is where §10.4.x OrdinarySetWithOwnDescriptor returns false and the assignment
 * raises. Node's wording, matched exactly. */
static bool accessor_write(jsrt_value slot, const char *key, jsrt_value recv, jsrt_value value) {
  if (!jsrt_is_accessor_cell(slot)) {
    return false;
  }
  const JSRTAccessorCell *cell = (const JSRTAccessorCell *)jsrt_ptr(slot);
  if (cell->set == JSRT_UNDEFINED) {
    char msg[192];
    snprintf(msg, sizeof msg, "Cannot set property %s of #<Object> which has only a getter", key);
    jsrt_throw_error(&jsrt_class_type_error, msg);
    return true;
  }
  jsrt_value args[2] = {recv, value};
  jsrt_call(cell->set, 2, args);
  return true;
}

jsrt_value jsrt_get_prop(jsrt_value obj, const char *key, JSRTIC *ic) {
  if (jsrt_is_nullish(obj)) {
    char message[256];
    snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
             obj == JSRT_NULL ? "null" : "undefined", key);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return JSRT_UNDEFINED;
  }
  if (jsrt_is(obj, JSRT_TAG_ARRAY) && strcmp(key, "length") == 0) {
    return jsrt_number((double)jsrt_as_array(obj)->length);
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      return fixed_get(obj, key);
    }
    if (jsrt_is(obj, JSRT_TAG_STRING) && strcmp(key, "length") == 0) {
      return jsrt_number((double)jsrt_string_length(obj));
    }
    return JSRT_UNDEFINED;
  }
  const PropTable o = as_prop_table(obj, "get");
  if (ic != NULL && ic->shape == *o.shape) {
    return accessor_read((*o.slots)[ic->offset], obj);
  }
  const JSRTShape *hit = shape_find(*o.shape, key);
  if (hit == NULL) {
    return JSRT_UNDEFINED;
  }
  if (ic != NULL) {
    ic->shape = *o.shape;
    ic->offset = hit->offset;
  }
  return accessor_read((*o.slots)[hit->offset], obj);
}

bool jsrt_has_prop(jsrt_value obj, const char *key) {
  if (jsrt_is_nullish(obj)) {
    return false;
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      return fixed_has(obj, key);
    }
    return jsrt_is(obj, JSRT_TAG_STRING) && strcmp(key, "length") == 0;
  }
  const PropTable o = as_prop_table(obj, "has");
  return shape_find(*o.shape, key) != NULL;
}

bool jsrt_in(jsrt_value key, jsrt_value obj) {
  if (jsrt_is_nullish(obj)) {
    jsrt_throw_error(&jsrt_class_type_error,
                     "Cannot use 'in' operator to search for a value in null or undefined");
    return false;
  }
  const char *k = jsrt_shape_key(jsrt_to_string(key));
  if (!jsrt_is_object(obj)) {
    /* §13.10.1 step 6: the RIGHT operand must be an Object, and a primitive is not one -- so the
     * answer is a TypeError, never a boolean. Two wrong answers lived here: `"length" in "abc"`
     * reported `true` through the string branch of `jsrt_has_prop`, and any other primitive
     * reported `false`, so a thrown error was hidden behind an ordinary value (plan-notes 220).
     * Node's wording names both operands, so the receiver goes through ToString like the key. */
    const char *receiver = jsrt_shape_key(jsrt_to_string(obj));
    char message[256];
    snprintf(message, sizeof message, "Cannot use 'in' operator to search for '%s' in %s", k,
             receiver);
    jsrt_throw_error(&jsrt_class_type_error, message);
    free((void *)receiver);
    free((void *)k);
    return false;
  }
  bool answer = false;
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    /* An INDEX test, not a decimal parse: `strtoul` accepts a sign and leading zeros, so `'01' in
     * a`, `'+1' in a` and `'-0' in a` all answered `true` where Node answers `false`. The canonical
     * spelling `array_index_value` is the one test the rest of this file uses. */
    uint32_t index = 0;
    answer = strcmp(k, "length") == 0 ||
             (array_index_value(k, &index) && index < jsrt_as_array(obj)->length);
  }
  if (!answer) {
    answer = jsrt_has_prop(obj, k);
  }
  /* Compared only -- nothing here keeps the key, unlike a write that installs it in a shape -- so
   * this copy dies with the call instead of joining the immortal shape table. */
  free((void *)k);
  return answer;
}

/* `honor_accessor` is false for exactly one caller: jsrt_define_accessor, which is INSTALLING the
 * cell and must overwrite whatever the key held rather than invoke it. Every other write honors it,
 * which is what makes `o.x = v` on an accessor a call. */
static void store_prop(jsrt_value obj, const char *key, jsrt_value value, JSRTIC *ic,
                       bool honor_accessor) {
  if (jsrt_is_nullish(obj)) {
    char message[256];
    snprintf(message, sizeof message, "Cannot set properties of %s (setting '%s')",
             obj == JSRT_NULL ? "null" : "undefined", key);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return;
  }
  if (jsrt_is_dynobj(obj) && ((JSRTDynObject *)jsrt_ptr(obj))->frozen) {
    /* Node's exact wording, property name included -- a frozen-write TypeError that did not say
     * WHICH property is the least useful half of the message (plan.md §8 step 2a(c)). */
    char msg[256];
    snprintf(msg, sizeof msg, "Cannot assign to read only property '%s' of object '#<Object>'", key);
    jsrt_throw_error(&jsrt_class_type_error, msg);
    return;
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      if (fixed_set(obj, key, value)) {
        return;
      }
      jsrt_panic(
          "STA2004: a statically-shaped object cannot grow a new property; planned for Phase 8");
    }
    jsrt_throw_error(&jsrt_class_type_error, "Cannot set properties of a primitive");
    return;
  }
  const PropTable o = as_prop_table(obj, "set");
  if (ic != NULL && ic->shape == (*o.shape)) {
    if (honor_accessor && accessor_write((*o.slots)[ic->offset], key, obj, value)) {
      return;
    }
    (*o.slots)[ic->offset] = value;
    return;
  }
  const JSRTShape *hit = shape_find((*o.shape), key);
  if (hit != NULL) {
    if (ic != NULL) {
      ic->shape = (*o.shape);
      ic->offset = hit->offset;
    }
    if (honor_accessor && accessor_write((*o.slots)[hit->offset], key, obj, value)) {
      return;
    }
    (*o.slots)[hit->offset] = value;
    return;
  }

  /* New property: take (or build) the transition. */
  JSRTShape *next = shape_transition((*o.shape), key);

  if (next->offset >= (*o.capacity)) {
    /* Double from 4 so repeated additions stay amortized O(1). The old slots are copied, not
     * reallocated in place: under Boehm the old block is simply dropped for the collector. */
    uint32_t grown = (*o.capacity) == 0 ? 4 : (*o.capacity) * 2;
    jsrt_value *fresh = (jsrt_value *)slots_alloc((size_t)grown * sizeof(jsrt_value));
    for (uint32_t i = 0; i < (*o.capacity); i++) {
      fresh[i] = (*o.slots)[i];
    }
#ifndef JSRT_HAVE_BOEHM
    free((*o.slots));
#endif
    (*o.slots) = fresh;
    (*o.capacity) = grown;
  }
  (*o.slots)[next->offset] = value;
  /* Transitions are not IC-cached: each object performs a given addition exactly once, so a
   * transition cache would only ever hit across objects — worth building when Phase 5 measures
   * construction-heavy dynamic code, not before. */
  (*o.shape) = next;
}

void jsrt_set_prop(jsrt_value obj, const char *key, jsrt_value value, JSRTIC *ic) {
  store_prop(obj, key, value, ic, true);
}

void jsrt_define_accessor(jsrt_value obj, const char *key, jsrt_value get, jsrt_value set) {
  JSRTAccessorCell *cell = (JSRTAccessorCell *)slots_alloc(sizeof(JSRTAccessorCell));
  cell->cls = &jsrt_class_accessor;
  cell->get = get;
  cell->set = set;
  /* No IC: installation happens once per object at construction, so a cache would never hit. */
  store_prop(obj, key, JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)cell), NULL, false);
}

/* The shape rebuild. A shape node is shared metadata -- other objects sit on the same chain -- so
 * removing a key means replaying the chain from the root without it and compacting the slots to
 * match. `next` never runs ahead of `i`, so the compaction reads every slot before it is written.
 * Deliberately not IC-aware: an IC is trusted by shape-pointer compare, and the object now holds a
 * different pointer, so every cache filled against the old shape simply misses. */
static void shape_delete(PropTable o, const JSRTShape *hit) {
  const uint32_t count = shape_slot_count(*o.shape);
  const JSRTShape **links = shape_links(*o.shape, count);
  JSRTShape *shape = &shape_root;
  uint32_t next = 0;
  for (uint32_t i = 0; i < count; i++) {
    if (links[i] == hit) {
      continue;
    }
    shape = shape_transition(shape, links[i]->key);
    (*o.slots)[next++] = (*o.slots)[i];
  }
  free(links);
  *o.shape = shape;
}

bool jsrt_delete(jsrt_value obj, jsrt_value key) {
  if (jsrt_is_nullish(obj)) {
    jsrt_throw_error(&jsrt_class_type_error, "Cannot convert undefined or null to object");
    return false;
  }
  /* Owned here, unlike every other shape key: a delete only COMPARES the key -- the chain it
   * replays carries the immortal keys the old shapes already held -- so this copy dies with the
   * call instead of joining the table. */
  const char *k = jsrt_shape_key(jsrt_to_string(key));
  bool answer = true;
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    uint32_t index = 0;
    /* A dense array has no representation for an absent element: `delete a[1]` must leave a HOLE
     * that `1 in a` denies and iteration skips, and `undefined` is not that (plan.md §8 step 2a(c);
     * the same gap gateArrayLiteral names for `[1, , 3]`). `length` is non-configurable, which is
     * a different refusal the same absence blocks from being spelled honestly. */
    if (strcmp(k, "length") == 0 ||
        (array_index_value(k, &index) && index < jsrt_as_array(obj)->length)) {
      jsrt_panic("STA2007: an array element cannot be deleted; planned for Phase 5 (array holes)");
    }
  } else if (!has_prop_table(obj)) {
    /* A fixed layout is slots at compile-time offsets; a missing one has no encoding. Deleting a
     * key it never had is still `true` -- there was nothing to remove. Symmetric with STA2004,
     * and it lifts with the same Phase 8 dictionary-mode escape.
     *
     * FROZEN is the one fixed-shape delete with a right answer, and it is the answer: a frozen
     * property is non-configurable, so the spec's `delete` raises in strict mode and never has to
     * reach a representation the layout does not have (plan.md §8 step 2a(c), bucket 2704). */
    if (jsrt_is(obj, JSRT_TAG_OBJECT) && fixed_has(obj, k)) {
      if (jsrt_as_object(obj)->frozen) {
        char msg[256];
        snprintf(msg, sizeof msg, "Cannot delete property '%s' of #<Object>", k);
        jsrt_throw_error(&jsrt_class_type_error, msg);
        free((void *)k);
        return false;
      }
      jsrt_panic(
          "STA2007: a statically-shaped object cannot lose a property; planned for Phase 8");
    }
    free((void *)k);
    return true;
  }
  const PropTable o = as_prop_table(obj, "delete");
  const JSRTShape *hit = shape_find(*o.shape, k);
  if (hit == NULL) {
    /* Absent is `true` even on a frozen object: §13.5.1.2 asks [[Delete]], and deleting what is
     * not there succeeds. Only an existing non-configurable property raises. */
    free((void *)k);
    return true;
  }
  if (jsrt_is_dynobj(obj) && ((JSRTDynObject *)jsrt_ptr(obj))->frozen) {
    char msg[256];
    snprintf(msg, sizeof msg, "Cannot delete property '%s' of #<Object>", k);
    jsrt_throw_error(&jsrt_class_type_error, msg);
    answer = false;
  } else {
    shape_delete(o, hit);
  }
  free((void *)k);
  return answer;
}

jsrt_value jsrt_dyn_index_get(jsrt_value obj, jsrt_value index, JSRTIC *ic) {
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    return jsrt_array_get(obj, index);
  }
  return jsrt_get_prop(obj, jsrt_shape_key(jsrt_to_string(index)), ic);
}

void jsrt_dyn_index_set(jsrt_value obj, jsrt_value index, jsrt_value value, JSRTIC *ic) {
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    jsrt_array_set(obj, index, value);
    return;
  }
  jsrt_set_prop(obj, jsrt_shape_key(jsrt_to_string(index)), value, ic);
}
