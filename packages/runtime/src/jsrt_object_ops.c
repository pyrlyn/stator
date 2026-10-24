/* Object.keys / Object.values / Object.entries (plan.md §7 Task 4.2), ECMA-262 §20.1.2.
 *
 * Two receiver layouts, one enumeration rule (ECMA-262 OrdinaryOwnPropertyKeys): canonical
 * array-index keys first in ascending numeric order, then the remaining string keys in insertion
 * order. A dynamic object walks its shape chain through jsrt_shape_property_order; a fixed-shape
 * object walks its class descriptor through jsrt_fixed_key_order, which applies the same
 * partition -- a string-literal key like "1" in a fixed layout IS an index (plan.md §8 step 28).
 * plan-notes 85's claim that identifier-only layouts cannot trigger the reorder was falsified by
 * the string-literal keys note 181 landed: `{ b: 1, "1": 2, a: 3 }` is fixed and enumerates
 * `1,b,a`.
 *
 * Arrays enumerate their indices first (then any named extras), strings their code-unit
 * indices; anything else at the argument position is a compiler bug — the gate restricts the
 * argument to the object layouts, arrays and strings — and panics as one (STA4084). */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jsrt.h"
#include "jsrt_value.h"

static jsrt_value key_string(const char *key) {
  return jsrt_string_from_utf8(key, strlen(key));
}

/* Private class names occupy slots for direct `#name` access, but they are not properties in the
 * ordinary property-key namespace.  The fixed-shape descriptor stores them alongside public
 * fields, so every reflective walk must filter them out.  A public field cannot start with `#` in
 * the subset: computed/string-literal class names are rejected by the frontend gate. */
static bool is_private_field(const char *key) { return key[0] == '#'; }

/* One walk serves all three entry points: what varies is only what each index becomes. */
typedef enum { OBJ_KEYS, OBJ_VALUES, OBJ_ENTRIES } ObjSelect;

static jsrt_value collect(jsrt_value v, ObjSelect select) {
  if (
    !jsrt_is(v, JSRT_TAG_OBJECT) && !jsrt_is(v, JSRT_TAG_ARRAY) && !jsrt_is(v, JSRT_TAG_STRING)
  ) {
    jsrt_panic("STA4084: Object.keys/values/entries on a non-object value");
  }
  /* Arrays and strings enumerate their index keys first (ECMA-262 OrdinaryOwnPropertyKeys:
   * ascending indices, then string keys). `for-in` lowers to this same walk, so
   * `for (const k in [10, 20])` answers `0 / 1` and `for (const k in "ab")` answers `0 / 1`
   * instead of panicking (plan.md §8 step 38). Named extras on an array (today: RegExp match
   * `index`/`input`/`groups`) ride the same shape walk as a dynamic object afterwards. */
  const bool array = jsrt_is(v, JSRT_TAG_ARRAY);
  const bool string = !array && jsrt_is(v, JSRT_TAG_STRING);
  const JSRTArray *arr = array ? (const JSRTArray *)jsrt_ptr(v) : NULL;
  const uint32_t index_count =
      array && arr != NULL ? arr->length : (string ? jsrt_string_length(v) : 0);
  const JSRTObject *fixed = (array || string) ? NULL : (const JSRTObject *)jsrt_ptr(v);
  const bool dynamic = !array && !string && jsrt_is_dynobj(v);
  const JSRTDynObject *dyn = dynamic ? (const JSRTDynObject *)jsrt_ptr(v) : NULL;
  /* The dynamic walk sorts the shape chain; the fixed walk partitions the class descriptor the
   * same way (integer indices first, then insertion order). Array extras share the dynamic
   * layout (shape + slots on JSRTArray), so they walk through the same pointers. Both arrays
   * are malloc-owned and die with the call; free(NULL) covers the layout that did not
   * allocate.
   * A fixed object's overflow table (docs/VALUE.md §4.24) is the same layout again, walked after
   * every declared key: its keys were all added after construction. */
  const JSRTDynObject *table = dynamic ? dyn : jsrt_fixed_extras(v);
  JSRTShape *shape =
      table != NULL ? table->shape : (array && arr != NULL ? arr->shape : NULL);
  jsrt_value *slots =
      table != NULL ? table->slots : (array && arr != NULL ? arr->slots : NULL);
  const uint32_t shape_count = shape == NULL ? 0 : jsrt_shape_property_count(shape);
  const JSRTShape **links = shape == NULL ? NULL : jsrt_shape_property_order(shape, shape_count);
  uint32_t fixed_count = 0;
  uint32_t *fixed_order =
      (array || string || dynamic || fixed == NULL) ? NULL : jsrt_fixed_key_order(fixed->cls, &fixed_count);
  const uint32_t count = fixed_count + shape_count;

  /* A getter can allocate or collect; the partially built result is not reachable from v. */
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_array_new(0, NULL);
  /* Index keys first, ascending: array elements, then string code units (one UTF-16 unit per
   * key, matching the indices a `for-in` over the value must visit). */
  for (uint32_t i = 0; i < index_count; i++) {
    char digits[12];
    snprintf(digits, sizeof(digits), "%u", i);
    jsrt_value value;
    if (array && arr != NULL) {
      /* A hole is no key at all (§10.4.2's OwnPropertyKeys lists only present indices). */
      if (arr->elements[i] == JSRT_HOLE) {
        continue;
      }
      value = arr->elements[i];
    } else {
      const uint16_t unit = jsrt_string_char(v, i);
      value = jsrt_string_from_units(&unit, 1);
    }
    JSRT_LOCAL(1) = value;
    jsrt_value item;
    if (select == OBJ_KEYS) {
      item = key_string(digits);
    } else if (select == OBJ_VALUES) {
      item = JSRT_LOCAL(1);
    } else {
      const jsrt_value pair[2] = {key_string(digits), JSRT_LOCAL(1)};
      item = jsrt_array_new(2, pair);
    }
    JSRT_LOCAL(1) = item;
    jsrt_array_push(JSRT_LOCAL(0), JSRT_LOCAL(1));
  }
  for (uint32_t i = 0; i < count; i++) {
    /* The declared keys first (none on a dynamic object or an array), then the table's. */
    const bool declared = i < fixed_count;
    const JSRTShape *link = declared || links == NULL ? NULL : links[i - fixed_count];
    const uint32_t slot = link != NULL ? link->offset : fixed_order[i];
    const char *key = link != NULL ? link->key : fixed->cls->fields[slot];
    jsrt_value value = link != NULL && slots != NULL ? slots[slot] : fixed->fields[slot];
    /* An accessor's value is what its getter RETURNS: Object.values and Object.entries perform a
     * [[Get]], while Object.keys needs only the key and must not call anything. jsrt_get_prop is
     * the single place that knows how to resolve a cell, so the call is spelled as a property
     * read rather than repeated here. */
    if (select != OBJ_KEYS && jsrt_is_accessor_cell(value)) {
      value = jsrt_get_prop(v, key, NULL);
      if (jsrt_pending()) {
        free((void *)links);
        free(fixed_order);
        JSRT_FRAME_POP();
        return JSRT_UNDEFINED;
      }
    }
    jsrt_value item;
    if (select == OBJ_KEYS) {
      item = key_string(key);
    } else if (select == OBJ_VALUES) {
      item = value;
    } else {
      JSRT_LOCAL(1) = value;
      const jsrt_value pair[2] = {key_string(key), value};
      item = jsrt_array_new(2, pair);
    }
    JSRT_LOCAL(1) = item;
    jsrt_array_push(JSRT_LOCAL(0), JSRT_LOCAL(1));
  }
  free((void *)links);
  free(fixed_order);
  const jsrt_value result = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return result;
}

jsrt_value jsrt_object_keys(jsrt_value v) { return collect(v, OBJ_KEYS); }

jsrt_value jsrt_object_values(jsrt_value v) { return collect(v, OBJ_VALUES); }

jsrt_value jsrt_object_entries(jsrt_value v) { return collect(v, OBJ_ENTRIES); }

/* The `for-in` desugar's private entry into the keys walk (plan.md §8 step 38): exactly what the
 * loop visits — own enumerable keys of objects, arrays and strings — and an empty list for
 * every other primitive, where the namespace call stays a loud STA4084. `for (const k in 5)`
 * visits nothing in Node; aborting the compiled program for it would turn a suppressed checker
 * refusal into a runtime crash. */
jsrt_value jsrt_object_for_in_keys(jsrt_value v) {
  if (jsrt_is(v, JSRT_TAG_OBJECT) || jsrt_is(v, JSRT_TAG_ARRAY) || jsrt_is(v, JSRT_TAG_STRING)) {
    return collect(v, OBJ_KEYS);
  }
  return jsrt_array_new(0, NULL);
}

/* getOwnPropertyNames answers the same list as keys for every object the subset can build: both
 * layouts hold only string-keyed, enumerable own properties -- a class field and a literal
 * property are both, and neither layout has a way to spell anything else. The two entry points
 * diverge when non-enumerable properties become expressible, which is the object model's job,
 * not this walk's. */
jsrt_value jsrt_object_get_own_property_names(jsrt_value v) { return collect(v, OBJ_KEYS); }

/* Object.hasOwn (§20.1.2.13). The shape chain and the class descriptor each list exactly the own
 * properties, so "own" needs no prototype question asked -- neither layout HAS a prototype the
 * subset can reach. The key arrives as a value because it is an arbitrary expression; the gate
 * has already held it to a string type. */
jsrt_value jsrt_object_has_own(jsrt_value v, jsrt_value key) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    jsrt_panic("STA4084: Object.hasOwn on a non-object value");
  }
  if (!jsrt_is(key, JSRT_TAG_STRING)) {
    jsrt_panic("STA2005: Object.hasOwn with a non-string key is not yet supported");
  }
  const JSRTObject *fixed = (const JSRTObject *)jsrt_ptr(v);
  if (jsrt_is_dynobj(v)) {
    return jsrt_bool(jsrt_has_prop_value(v, key));
  }
  for (uint32_t i = 0; i < fixed->cls->field_count; i++) {
    if (is_private_field(fixed->cls->fields[i])) {
      continue;
    }
    if (jsrt_string_equals(key_string(fixed->cls->fields[i]), key)) {
      return JSRT_TRUE;
    }
  }
  const JSRTDynObject *extras = jsrt_fixed_extras(v);
  return extras != NULL ? jsrt_bool(jsrt_has_prop_value(
                             JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)extras), key))
                        : JSRT_FALSE;
}

/* Object.fromEntries (§20.1.2.7) over an ARRAY of pairs -- the iterable form the gate accepts.
 * The result is a dynamic object built key by key, so insertion order is the pair order and a
 * duplicate key resolves the way the shape table already resolves one: the later value wins and
 * the key keeps its first position. */
jsrt_value jsrt_object_from_entries(jsrt_value pairs) {
  if (!jsrt_is(pairs, JSRT_TAG_ARRAY)) {
    jsrt_panic("STA4084: Object.fromEntries on a value that is not an array");
  }
  JSRT_FRAME(1);
  JSRT_LOCAL(0) = jsrt_dynobj_new();
  const JSRTArray *list = jsrt_as_array(pairs);
  for (uint32_t i = 0; i < list->length; i++) {
    const jsrt_value pair = jsrt_unhole(list->elements[i]);
    if (!jsrt_is(pair, JSRT_TAG_ARRAY)) {
      jsrt_panic("STA2005: Object.fromEntries over entries that are not arrays is not yet "
                 "supported");
    }
    const JSRTArray *entry = jsrt_as_array(pair);
    const jsrt_value key = entry->length > 0 ? jsrt_unhole(entry->elements[0]) : JSRT_UNDEFINED;
    const jsrt_value value = entry->length > 1 ? jsrt_unhole(entry->elements[1]) : JSRT_UNDEFINED;
    if (!jsrt_is(key, JSRT_TAG_STRING)) {
      jsrt_panic("STA2005: Object.fromEntries with a non-string key is not yet supported");
    }
    jsrt_set_prop(JSRT_LOCAL(0), jsrt_shape_key(key), value, NULL);
  }
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

/* Object.assign (§20.1.2.1) in its two-argument form, copying the source's own enumerable string
 * keys onto the target and returning the target. The gate restricts the TARGET to a dynamic shape
 * for a reason a comment has to carry: a fixed shape's reads compile to slot indices decided at
 * build time, so a key this adds could never be read, and a key it overwrites is fine only because
 * the type system already listed it. A dynamic shape looks every key up through the shape table,
 * which is what makes a target that GROWS legal at all.
 *
 * Snapshot keys, not values: each source getter must run immediately before its target setter,
 * and an exception must prevent all subsequent gets and sets.
 *
 * An ARRAY source reads its indices out of its elements, not through `jsrt_get_prop`: indices
 * live beside the shape table rather than in it, so the property read would miss them and answer
 * `undefined` for every element. Named extras ride the shape table and read through the ordinary
 * path. Source-level `Object.assign` with an array source never reaches here (the gate holds the
 * source to the object layouts); the object-spread-of-array desugar is the only caller that can
 * hand one over, and it is also why this loop rather than `jsrt_dynobj_spread` carries the case
 * (that entry point copies fixed-shape fields and panics on anything else). A STRING source (an
 * untyped spread operand) has no elements to read, so its index keys answer one code unit each.
 *
 * Any other source copies nothing. CopyDataProperties (§13.2.5.5) and Object.assign skip
 * `undefined` and `null`, ToObject of a boolean or number has no own enumerable string key, and a
 * closure carries no own properties in this runtime. The object-spread fold of an untyped operand
 * hands all of these over (plan-notes 297). */
jsrt_value jsrt_object_assign(jsrt_value target, jsrt_value source) {
  if (!jsrt_is_dynobj(target)) {
    jsrt_panic("STA4084: Object.assign onto a value that is not a dynamic-shape object");
  }
  if (
    !jsrt_is(source, JSRT_TAG_OBJECT) && !jsrt_is(source, JSRT_TAG_ARRAY) &&
    !jsrt_is(source, JSRT_TAG_STRING)
  ) {
    return target;
  }
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = collect(source, OBJ_KEYS);
  if (jsrt_pending()) {
    JSRT_FRAME_POP();
    return JSRT_UNDEFINED;
  }
  const bool sourceIsArray = jsrt_is(source, JSRT_TAG_ARRAY);
  const JSRTArray *srcArray = sourceIsArray ? jsrt_as_array(source) : NULL;
  const bool sourceIsString = jsrt_is(source, JSRT_TAG_STRING);
  const JSRTArray *list = jsrt_as_array(JSRT_LOCAL(0));
  for (uint32_t i = 0; i < list->length; i++) {
    const char *key = jsrt_shape_key(list->elements[i]);
    uint32_t index = 0;
    const bool indexed = jsrt_key_is_array_index(key, &index);
    uint16_t unit = 0;
    JSRT_LOCAL(1) =
        srcArray != NULL && indexed && index < srcArray->length ? srcArray->elements[index]
        : sourceIsString && indexed
            ? (unit = jsrt_string_char(source, index), jsrt_string_from_units(&unit, 1))
            : jsrt_get_prop(source, key, NULL);
    if (jsrt_pending()) {
      JSRT_FRAME_POP();
      return JSRT_UNDEFINED;
    }
    jsrt_set_prop(target, key, JSRT_LOCAL(1), NULL);
    if (jsrt_pending()) {
      JSRT_FRAME_POP();
      return JSRT_UNDEFINED;
    }
  }
  JSRT_FRAME_POP();
  return target;
}

jsrt_value jsrt_object_freeze(jsrt_value v) {
  if (jsrt_is_dynobj(v)) {
    ((JSRTDynObject *)jsrt_ptr(v))->frozen = true;
    return v;
  }
  if (jsrt_is_fixed_object(v)) {
    /* The overflow table freezes with its owner: its keys are the object's own properties. */
    JSRTObject *o = jsrt_as_object(v);
    o->frozen = true;
    if (o->extras != NULL) {
      o->extras->frozen = true;
    }
    return v;
  }
  return v;
}

jsrt_value jsrt_object_is_frozen(jsrt_value v) {
  if (jsrt_is_dynobj(v)) {
    return jsrt_bool(((const JSRTDynObject *)jsrt_ptr(v))->frozen);
  }
  if (jsrt_is_fixed_object(v)) {
    return jsrt_bool(jsrt_as_object(v)->frozen);
  }
  /* Primitives are frozen. Builtin objects this landing does not mark are not. */
  return jsrt_is(v, JSRT_TAG_OBJECT) || jsrt_is(v, JSRT_TAG_ARRAY) ? JSRT_FALSE : JSRT_TRUE;
}

/* ---------------------------------------------------------------- spread order
 *
 * `{ ...src }` enumerates in the SOURCE OBJECT's key order, not its type's field order
 * (plan.md §8 step 21a): a reordering annotation (`const o: { y: x } = { x, y }`) types the
 * fields one way while the object still enumerates the way it was built. The lowering expands
 * a spread into one read per field of the TYPE, which copies the right values into the right
 * slots but bakes the type's order into the result -- so the result's enumeration order is
 * repaired here, at run time, where the source's order lives.
 *
 * A fixed result's order lives in its shared descriptor (`JSRTClass::key_order`), which the
 * emitter chose at compile time -- so these three calls rebuild it after the values land: two
 * record first-occurrence order fragment by fragment (own keys, then each spread source in
 * ITS order), and the third interns the finished order as the result's descriptor. A dynamic
 * result keeps insertion order for free, so one call copies a whole spread source in order. */

static void order_append(uint32_t *order, uint32_t *count, uint32_t cap, uint32_t slot) {
  for (uint32_t i = 0; i < *count; i++) {
    if (order[i] == slot) {
      return;
    }
  }
  if (*count >= cap) {
    jsrt_panic("spread order overflow: more distinct keys than the result has slots");
  }
  order[(*count)++] = slot;
}

/* One own key of the literal, by its slot in the result layout. Later occurrences -- an
 * override after a spread that already contributed the key -- keep the first position, which
 * is §13.2.5.5's rule and falls out of the duplicate skip. */
void jsrt_spread_order_key(uint32_t *order, uint32_t *count, uint32_t cap, uint32_t slot) {
  order_append(order, count, cap, slot);
}

/* The destination slot a source key lands in, by name: the source layout is a SUBSET of the
 * result's (the gate held every spread operand to a fixed shape the result type covers), and
 * a key the result does not declare -- a class instance wider than its static type -- is one
 * the value copy skipped too, so the order skips it as well. */
static bool dst_slot_of(const JSRTClass *dst, const char *key, uint32_t *slot) {
  if (dst->fields == NULL) {
    return false;
  }
  for (uint32_t i = 0; i < dst->field_count; i++) {
    if (dst->fields[i] != NULL && strcmp(dst->fields[i], key) == 0) {
      *slot = i;
      return true;
    }
  }
  return false;
}

/* A spread source's undeclared properties (docs/VALUE.md §4.24), in insertion order, written onto
 * `dst` through the ordinary property write -- except a key `skip` (a fixed result's layout)
 * declares, which the caller's declared writers own. */
static void copy_extras(jsrt_value dst, jsrt_value src, const JSRTClass *skip) {
  const JSRTDynObject *extras = jsrt_fixed_extras(src);
  if (extras == NULL) {
    return;
  }
  const uint32_t n = jsrt_shape_property_count(extras->shape);
  const JSRTShape **links = jsrt_shape_property_order(extras->shape, n);
  for (uint32_t i = 0; i < n; i++) {
    uint32_t slot = 0;
    if (skip == NULL || !dst_slot_of(skip, links[i]->key, &slot)) {
      jsrt_set_prop(dst, links[i]->key, extras->slots[links[i]->offset], NULL);
    }
  }
  free((void *)links);
}

/* One spread fragment: every own key of the source that the result declares, in the SOURCE's
 * enumeration order. `#private` slots are not properties and never enter an order. A dynamic
 * source walks its shape chain; anything that is not an object at all is a compiler bug -- the
 * gate held the operand to a fixed shape. */
void jsrt_spread_order_src(uint32_t *order, uint32_t *count, uint32_t cap, jsrt_value dst,
                           jsrt_value src) {
  if (!jsrt_is(src, JSRT_TAG_OBJECT)) {
    jsrt_panic("object spread of a value that is not an object");
  }
  const JSRTClass *dc = jsrt_as_object(dst)->cls;
  if (jsrt_is_dynobj(src)) {
    const JSRTDynObject *dyn = (const JSRTDynObject *)jsrt_ptr(src);
    const uint32_t n = jsrt_shape_property_count(dyn->shape);
    const JSRTShape **links = jsrt_shape_property_order(dyn->shape, n);
    for (uint32_t i = 0; i < n; i++) {
      uint32_t slot = 0;
      if (dst_slot_of(dc, links[i]->key, &slot)) {
        order_append(order, count, cap, slot);
      }
    }
    free((void *)links);
    return;
  }
  const JSRTObject *fixed = jsrt_as_object(src);
  for (uint32_t i = 0; i < fixed->cls->field_count; i++) {
    const char *key = fixed->cls->fields[jsrt_class_key_slot(fixed->cls, i)];
    if (key != NULL && !is_private_field(key)) {
      uint32_t slot = 0;
      if (dst_slot_of(dc, key, &slot)) {
        order_append(order, count, cap, slot);
      }
    }
  }
  /* The source's undeclared properties (docs/VALUE.md §4.24): no per-field read copied them,
   * because the source's TYPE does not list them, so they grow the result's own overflow table
   * here, after its values landed. A key the result's type declares is left to its declared
   * writer -- this call cannot tell an earlier writer, which the source overrides, from a later
   * one, which overrides the source. */
  copy_extras(dst, src, dc);
}

/* One (layout, order) pair, interned for the life of the program: two spread results with the
 * same layout and the same order share one descriptor, the way two literals that wrote the same
 * keys share one today. Descriptors hold no values, so plain malloc is correct (the shape
 * table's rule, docs/VALUE.md §4.10). */
typedef struct OrderIntern {
  const JSRTClass *layout;
  uint32_t *order; /* length is layout->field_count */
  JSRTClass desc;
  struct OrderIntern *next;
} OrderIntern;

static OrderIntern *order_interns = NULL;

static const JSRTClass *shape_with_order(const JSRTClass *layout, const uint32_t *order) {
  jsrt_shape_metadata_lock();
  const uint32_t n = layout->field_count;
  for (const OrderIntern *e = order_interns; e != NULL; e = e->next) {
    if (e->layout == layout && memcmp(e->order, order, (size_t)n * sizeof(uint32_t)) == 0) {
      jsrt_shape_metadata_unlock();
      return &e->desc;
    }
  }
  OrderIntern *e = (OrderIntern *)malloc(sizeof(OrderIntern) + (size_t)n * sizeof(uint32_t));
  if (e == NULL) {
    jsrt_panic("out of memory: spread order");
  }
  e->layout = layout;
  e->order = (uint32_t *)(e + 1);
  memcpy(e->order, order, (size_t)n * sizeof(uint32_t));
  e->desc = *layout;
  e->desc.key_order = e->order;
  e->next = order_interns;
  order_interns = e;
  jsrt_shape_metadata_unlock();
  return &e->desc;
}

/* Stamp the finished order onto a fresh fixed spread result and answer it for the emitter's
 * comma chains. Slots the fragments never mentioned -- unreachable through the gate, which
 * expands every field -- pad in layout order rather than dropping a key. An order that matches
 * the descriptor the emitter already chose interns nothing. */
jsrt_value jsrt_object_set_order(jsrt_value dst, const uint32_t *order, uint32_t count) {
  JSRTObject *o = jsrt_as_object(dst);
  const JSRTClass *layout = o->cls;
  const uint32_t n = layout->field_count;
  if (n == 0) {
    return dst;
  }
  uint32_t *full = (uint32_t *)malloc((size_t)n * sizeof(uint32_t));
  if (full == NULL) {
    jsrt_panic("out of memory: spread order");
  }
  uint32_t m = 0;
  for (uint32_t i = 0; i < count && m < n; i++) {
    if (order[i] >= n) {
      continue;
    }
    bool seen = false;
    for (uint32_t j = 0; j < m; j++) {
      if (full[j] == order[i]) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      full[m++] = order[i];
    }
  }
  for (uint32_t s = 0; s < n; s++) {
    bool seen = false;
    for (uint32_t j = 0; j < m; j++) {
      if (full[j] == s) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      full[m++] = s;
    }
  }
  bool same = true;
  if (layout->key_order != NULL) {
    for (uint32_t i = 0; i < n; i++) {
      if (layout->key_order[i] != full[i]) {
        same = false;
        break;
      }
    }
  } else {
    for (uint32_t i = 0; i < n; i++) {
      if (full[i] != i) {
        same = false;
        break;
      }
    }
  }
  if (!same) {
    o->cls = shape_with_order(layout, full);
  }
  free(full);
  return dst;
}

/* One spread fragment into a DYNAMIC result: every own key of a fixed-shape source, in the
 * source's enumeration order, through the same `jsrt_set_prop` the per-field expansion used --
 * so setter-vs-define answers do not change, only the insertion order does. Insertion order IS
 * enumeration order on a fresh shape table, which is why this result needs no repair call. */
jsrt_value jsrt_dynobj_spread(jsrt_value dst, jsrt_value src) {
  if (!jsrt_is(src, JSRT_TAG_OBJECT) || jsrt_is_dynobj(src)) {
    jsrt_panic("object spread of a value with no fixed shape");
  }
  const JSRTObject *fixed = jsrt_as_object(src);
  for (uint32_t i = 0; i < fixed->cls->field_count; i++) {
    const uint32_t slot = jsrt_class_key_slot(fixed->cls, i);
    const char *key = fixed->cls->fields[slot];
    if (key == NULL) {
      continue;
    }
    /* A method on an object literal IS an own enumerable property (plan.md §8 step 12c S-C):
     * its bound closure rides a `#method:`-prefixed hidden slot, which every reflective walk
     * filters -- but a spread copies own keys, so the closure is stored as data under the
     * unprefixed name, exactly as a dynamic literal's own method entry does. The closure keeps
     * its construction-site environment with the call-site receiver, which is what makes
     * `this` answer the copy. Any other `#` slot is a `#private` field: storage, not a
     * property, and never copied. */
    if (strncmp(key, "#method:", 8) == 0) {
      jsrt_set_prop(dst, key + 8, fixed->fields[slot], NULL);
    } else if (!is_private_field(key)) {
      jsrt_set_prop(dst, key, fixed->fields[slot], NULL);
    }
  }
  /* The undeclared properties follow the declared ones, as they enumerate (docs/VALUE.md §4.24). */
  copy_extras(dst, src, NULL);
  return dst;
}
