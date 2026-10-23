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
#include "jsrt_mem.h"
#include "jsrt_value.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <assert.h>

const JSRTClass jsrt_class_dynamic = {"", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

/* Identical to `jsrt_class_dynamic` in every field that means anything -- the SHAPE owns the layout
 * -- and distinct from it by address, which is the whole job: it marks the objects §22.2.7.2 builds
 * with a null prototype so the printer writes Node's `[Object: null prototype]` prefix. */
const JSRTClass jsrt_class_null_proto = {"", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

/* The descriptor that marks an accessor CELL (docs/VALUE.md §4.15). Like the two above it means
 * nothing by its fields and everything by its address: a property read tests the value it just
 * loaded against this pointer to tell a get/set pair from an ordinary property value. Nothing in
 * the language can build one, so the test cannot be fooled -- jsrt_define_accessor is the only
 * producer. */
const JSRTClass jsrt_class_accessor = {"", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

/* A property is an array index exactly when its canonical decimal spelling round-trips through
 * ToUint32 and is not 2^32-1. Shape keys are UTF-8, so non-ASCII bytes and any leading zero make
 * the key an ordinary string. Fixed-shape enumeration (jsrt_fixed_key_order below) shares this
 * test: a string-literal key like "1" in a fixed layout is an index exactly as it is in a shape. */
bool jsrt_key_is_array_index(const char *key, uint32_t *value) {
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

/* The shape table itself -- the root, the chain walk, transitions, slot growth, key order and the
 * delete replay -- is jsrt_shape.zig (declared in jsrt_mem.h), and the dynamic-object allocators
 * are jsrt_alloc.zig. What stays here is property SEMANTICS over that table: inline caches,
 * accessors, the fixed-layout fallbacks and every TypeError the language names. */

/* Whether slot `a` enumerates before slot `b` of the same fixed layout. Canonical array-index
 * keys come first in ascending numeric order; ordinary keys never move relative to each other,
 * so the sort below is stable by construction and needs no tie-breaker (two distinct canonical
 * index spellings cannot share a value). */
static bool fixed_before(const JSRTClass *cls, uint32_t a, uint32_t b) {
  uint32_t ai = 0;
  uint32_t bi = 0;
  const bool a_is_index = jsrt_key_is_array_index(cls->fields[a], &ai);
  const bool b_is_index = jsrt_key_is_array_index(cls->fields[b], &bi);
  if (a_is_index != b_is_index) {
    return a_is_index;
  }
  return a_is_index && ai < bi;
}

uint32_t *jsrt_fixed_key_order(const JSRTClass *cls, uint32_t *count_out) {
  const uint32_t n = cls->field_count;
  /* Visible slots in insertion (key_order) sequence first; the partition below only reorders. */
  uint32_t *order = (uint32_t *)malloc((size_t)(n == 0 ? 1 : n) * sizeof(uint32_t));
  if (order == NULL) {
    jsrt_panic("out of memory: fixed object keys");
  }
  uint32_t m = 0;
  if (cls->fields != NULL) {
    for (uint32_t i = 0; i < n; i++) {
      const uint32_t slot = jsrt_class_key_slot(cls, i);
      const char *key = slot < n ? cls->fields[slot] : NULL;
      /* `#private` slots are storage, not properties -- every reflective walk filters them,
       * and the filter lives here once rather than in each caller. */
      if (key != NULL && key[0] != '#') {
        order[m++] = slot;
      }
    }
  }
  /* Stable insertion sort, field-count-sized like the shape walk above. */
  for (uint32_t i = 1; i < m; i++) {
    const uint32_t current = order[i];
    uint32_t j = i;
    while (j > 0 && fixed_before(cls, current, order[j - 1])) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = current;
  }
  *count_out = m;
  return order;
}

static JSRTDynObject *as_dynobj(jsrt_value v, const char *op) {
  (void)op;
  return (JSRTDynObject *)jsrt_ptr(v);
}

static bool has_prop_table(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_ARRAY) || jsrt_is_dynobj(v);
}

bool jsrt_is_fixed_object(jsrt_value v) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT) || jsrt_is_dynobj(v)) {
    return false;
  }
  const JSRTClass *cls = jsrt_as_object(v)->cls;
  return cls != &jsrt_class_promise && cls != &jsrt_class_date && cls != &jsrt_class_map &&
         cls != &jsrt_class_set && cls != &jsrt_class_weakmap && cls != &jsrt_class_weakset &&
         cls != &jsrt_class_regexp && cls != &jsrt_class_iterator &&
         cls != &jsrt_class_generator && cls != &jsrt_class_uint8array &&
         cls != &jsrt_class_arraybuffer && cls != &jsrt_class_accessor;
}

JSRTDynObject *jsrt_fixed_extras(jsrt_value v) {
  return jsrt_is_fixed_object(v) ? jsrt_as_object(v)->extras : NULL;
}

/* The overflow table as a value, for the property entries to recurse into. */
static jsrt_value extras_value(const JSRTDynObject *extras) {
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)extras);
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

/* Dynamic method dispatch through Unknown (plan.md §8 step 45): a fixed-shape object's methods
 * live in no slot `fixed_get` walks -- an object-literal method rides a hidden trailing
 * `#method:<name>` slot bound per evaluation, a class method rides the descriptor's method
 * table -- so a shape-table read of a method NAME missed to `undefined` and the following call
 * aborted STA2006 where Node runs. Own data properties shadow: the caller asks only on a field
 * miss, and a hit never fills the IC (a bound closure belongs to one receiver for literals,
 * and the IC fast path trusts a shape match for the site's key alone).
 *
 * Sets `*found` true on a hit and answers the closure; otherwise sets it false and answers
 * `undefined`. A NULL table entry (a capturing method with no one constant form) is skipped,
 * leaving the hidden slot -- which carries the construction-site environment -- as the hit.
 * Accessors (`get x`) are not methods under `x` and never match here. */
static jsrt_value fixed_method_get(jsrt_value obj, const char *key, bool *found) {
  JSRTObject *o = jsrt_as_object(obj);
  const JSRTClass *cls = o->cls;
  if (cls->fields != NULL) {
    for (uint32_t i = 0; i < cls->field_count; i++) {
      const char *name = cls->fields[i];
      if (name != NULL && strncmp(name, "#method:", 8) == 0 && strcmp(name + 8, key) == 0) {
        *found = true;
        return o->fields[i];
      }
    }
  }
  if (cls->method_names != NULL && cls->methods != NULL) {
    for (uint32_t i = 0; i < cls->method_count; i++) {
      const char *name = cls->method_names[i];
      const JSRTClosure *entry = cls->methods[i];
      if (name != NULL && entry != NULL && (name == key || strcmp(name, key) == 0)) {
        *found = true;
        return jsrt_closure(entry);
      }
    }
  }
  *found = false;
  return JSRT_UNDEFINED;
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
      a->shape = &jsrt_shape_root; /* first touch: an ordinary array pays nothing until here */
    }
    return (PropTable){&a->shape, &a->slots, &a->slot_capacity};
  }
  JSRTDynObject *o = as_dynobj(v, op);
  return (PropTable){&o->shape, &o->slots, &o->capacity};
}

/* One code point as UTF-8 at `p`. Early-return branches, not `buf[i++]`, so this is not a
 * second copy of the index-loop encoder in jsrt_regexp.c / jsrt_string.c. */
static char *shape_utf8_put(char *p, uint32_t cp) {
  if (cp < 0x80) {
    *p++ = (char)cp;
    return p;
  }
  if (cp < 0x800) {
    *p++ = (char)(0xC0 | (cp >> 6));
    *p++ = (char)(0x80 | (cp & 0x3F));
    return p;
  }
  if (cp < 0x10000) {
    *p++ = (char)(0xE0 | (cp >> 12));
    *p++ = (char)(0x80 | ((cp >> 6) & 0x3F));
    *p++ = (char)(0x80 | (cp & 0x3F));
    return p;
  }
  *p++ = (char)(0xF0 | (cp >> 18));
  *p++ = (char)(0x80 | ((cp >> 12) & 0x3F));
  *p++ = (char)(0x80 | ((cp >> 6) & 0x3F));
  *p++ = (char)(0x80 | (cp & 0x3F));
  return p;
}

/* UTF-8 for a JS string. The caller owns the buffer. Surrogate pairs combine into one code point;
 * a lone surrogate is encoded as itself. U+0000 has no representation in a C string and aborts
 * loudly rather than truncating the key silently. Plain malloc: the buffer is bytes, not a
 * jsrt_value, and a compare-only caller frees it before anything else can collect. */
static char *shape_key_bytes(jsrt_value name) {
  const uint32_t len = jsrt_string_length(name);
  /* Worst case is three bytes per code unit: an astral PAIR takes four bytes for two units. */
  char *key = (char *)malloc((size_t)len * 3 + 1);
  if (key == NULL) {
    jsrt_panic("out of memory: shape key");
  }
  char *p = key;
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
      *p++ = (char)cp;
    } else {
      p = shape_utf8_put(p, cp);
    }
  }
  *p = '\0';
  return key;
}

/* A shape key from a JS string. The shape table stores keys as NUL-terminated UTF-8 and keeps the
 * pointer forever, so a key a transition stores is deliberately immortal -- exactly the lifetime
 * shapes already have. A second conversion of the same bytes returns the first pointer. */
const char *jsrt_shape_key(jsrt_value name) { return jsrt_shape_intern(shape_key_bytes(name)); }

char *jsrt_shape_key_ephemeral(jsrt_value name) { return shape_key_bytes(name); }

jsrt_value jsrt_get_prop_value(jsrt_value obj, jsrt_value name, JSRTIC *ic) {
  char *key = shape_key_bytes(jsrt_to_string(name));
  const jsrt_value value = jsrt_get_prop(obj, key, ic);
  free(key);
  return value;
}

bool jsrt_has_prop_value(jsrt_value obj, jsrt_value name) {
  char *key = shape_key_bytes(name);
  const bool answer = jsrt_has_prop(obj, key);
  free(key);
  return answer;
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

/* `fn.length` on a statically-typed function value: the declared arity, which never counts
 * a method's receiver (docs/VALUE.md §4.16, plan.md §8 step 21b). The dynamic path answers the
 * same field through `jsrt_get_prop` below. */
uint32_t jsrt_closure_arity(jsrt_value v) {
  assert(jsrt_is(v, JSRT_TAG_CLOSURE));
  return jsrt_as_closure(v)->arity;
}

/* The statics entry for `key` on a class object (docs/VALUE.md §4.17), or NULL.
 *
 * The lookup walks the class's own descriptor and then its `parent`s -- statics are inherited in
 * JavaScript, and the gate refuses a static override, so one name is one binding per chain. Own
 * statics shadow the Function fallbacks exactly like own properties shadow a prototype (a
 * `static name = 5` hides the class's own name in JavaScript), which is why the table is asked
 * first. A name's getter wins a read and its setter wins a write; a same-named FIELD/METHOD is
 * the fallback when no accessor half matches. */
static const JSRTStaticEntry *class_static_find(const JSRTClosure *c, const char *key,
                                                bool for_write) {
  if (c->klass == NULL) {
    return NULL;
  }
  const JSRTStaticEntry *plain = NULL;
  for (const JSRTClass *k = c->klass; k != NULL && plain == NULL; k = k->parent) {
    if (k->statics == NULL) {
      continue;
    }
    for (const JSRTStaticEntry *e = k->statics; e->name != NULL; e++) {
      if (strcmp(e->name, key) != 0) {
        continue;
      }
      const uint8_t wanted = for_write ? JSRT_STATIC_SETTER : JSRT_STATIC_GETTER;
      if (e->kind == wanted) {
        return e;
      }
      if (e->kind == JSRT_STATIC_FIELD || e->kind == JSRT_STATIC_METHOD) {
        plain = e;
      }
    }
  }
  return plain;
}

/* True when some accessor half declares `key` with no matching half for this direction -- a
 * getter-only name being written (or a setter-only name being read). */
static bool class_static_other_half(const JSRTClosure *c, const char *key, bool for_write) {
  if (c->klass == NULL) {
    return false;
  }
  const uint8_t other = for_write ? JSRT_STATIC_GETTER : JSRT_STATIC_SETTER;
  for (const JSRTClass *k = c->klass; k != NULL; k = k->parent) {
    if (k->statics == NULL) {
      continue;
    }
    for (const JSRTStaticEntry *e = k->statics; e->name != NULL; e++) {
      if (strcmp(e->name, key) == 0 && e->kind == other) {
        return true;
      }
    }
  }
  return false;
}

/* The mutable view of an ordinary function's closure. Only a closure with `klass == NULL` is
 * written through it: those are heap closures or the emitter's non-const file statics, while a
 * class object is a `const` file static and never reaches here (plan-notes 310). */
static JSRTClosure *function_record(jsrt_value fn) { return (JSRTClosure *)jsrt_ptr(fn); }

jsrt_value jsrt_function_prototype(jsrt_value fn) {
  JSRTClosure *c = function_record(fn);
  if (!c->has_prototype) {
    if (!c->constructible) {
      return JSRT_UNDEFINED;
    }
    /* Created on first observation and kept, so every later read -- and every `new` -- sees the
     * same object. Its `constructor` is the hidden field, never a shape key: JavaScript makes it
     * non-enumerable, so `console.log(F.prototype)` prints `{}`. */
    const jsrt_value proto = jsrt_dynobj_new();
    ((JSRTDynObject *)jsrt_ptr(proto))->ctor = fn;
    c->prototype = proto;
    c->has_prototype = true;
  }
  return c->prototype;
}

/* `key` read on an ordinary function: its `prototype`, then its own properties. False on a miss,
 * which leaves `length`/`name` to the caller. */
static bool function_own_get(jsrt_value fn, const char *key, jsrt_value *out) {
  const JSRTClosure *c = jsrt_as_closure(fn);
  if (strcmp(key, "prototype") == 0 && (c->constructible || c->has_prototype)) {
    *out = jsrt_function_prototype(fn);
    return true;
  }
  if (c->props == NULL) {
    return false;
  }
  const JSRTShape *hit = jsrt_shape_find(c->props->shape, key);
  if (hit == NULL) {
    return false;
  }
  *out = accessor_read(c->props->slots[hit->offset], fn);
  return true;
}

/* `key` on the hidden half and the prototype chain of a dynamic object, after its own shape
 * missed: the hidden `constructor` of a function's prototype object, then each prototype in turn
 * (§10.1.8.1 OrdinaryGet). A getter found on the chain runs with the ORIGINAL receiver. A prototype
 * that is not a dynamic object -- `F.prototype = [1]` -- answers through its own lookup and ends
 * the walk; one that has no representation (%Object.prototype%) is 0 and ends it with a miss. */
static bool inherited_get(jsrt_value obj, const char *key, jsrt_value recv, jsrt_value *out) {
  for (jsrt_value p = obj; p != 0;) {
    if (!jsrt_is_dynobj(p)) {
      if (!jsrt_has_prop(p, key)) {
        return false;
      }
      *out = jsrt_get_prop(p, key, NULL);
      return true;
    }
    const JSRTDynObject *o = (const JSRTDynObject *)jsrt_ptr(p);
    if (p != obj) {
      const JSRTShape *hit = jsrt_shape_find(o->shape, key);
      if (hit != NULL) {
        *out = accessor_read(o->slots[hit->offset], recv);
        return true;
      }
    }
    if (o->ctor != 0 && strcmp(key, "constructor") == 0) {
      *out = o->ctor;
      return true;
    }
    p = o->proto;
  }
  return false;
}

/* The accessor a write of `key` meets on `obj`'s prototype chain, or 0. A data property there is
 * shadowed by the write (it lands on `obj`), so only an accessor cell changes what a write does:
 * its setter runs, or its missing setter throws (§10.1.9.2 OrdinarySetWithOwnDescriptor). */
static jsrt_value inherited_accessor(jsrt_value obj, const char *key) {
  for (jsrt_value p = ((const JSRTDynObject *)jsrt_ptr(obj))->proto; p != 0 && jsrt_is_dynobj(p);) {
    const JSRTDynObject *o = (const JSRTDynObject *)jsrt_ptr(p);
    const JSRTShape *hit = jsrt_shape_find(o->shape, key);
    if (hit != NULL) {
      const jsrt_value slot = o->slots[hit->offset];
      return jsrt_is_accessor_cell(slot) ? slot : 0;
    }
    p = o->proto;
  }
  return 0;
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
  /* A closure's own answers (`fn.length`, and `fn.name` for every function): the closure's own
   * fields, which never count a method's receiver (docs/VALUE.md §4.16, plan.md §8 step 21b). A
   * closure has no shape, so without these the read falls through to the table walk and answers
   * `undefined` where Node answers the arity or the name. A class object's statics shadow both
   * (`static name = 5` hides the class name in JavaScript), so its table is asked first. */
  if (jsrt_is(obj, JSRT_TAG_CLOSURE)) {
    const JSRTClosure *c = jsrt_as_closure(obj);
    const JSRTStaticEntry *entry = class_static_find(c, key, false);
    if (entry != NULL) {
      if (entry->kind == JSRT_STATIC_GETTER) {
        return jsrt_call(*entry->slot, 1, &obj);
      }
      return *entry->slot;
    }
    if (strcmp(key, "length") == 0) {
      return jsrt_number((double)c->arity);
    }
    if (strcmp(key, "name") == 0) {
      return jsrt_string_from_utf8(c->name, strlen(c->name));
    }
    jsrt_value own = JSRT_UNDEFINED;
    if (c->klass == NULL && function_own_get(obj, key, &own)) {
      return own;
    }
    return JSRT_UNDEFINED;
  }
  /* ArrayBuffer and Uint8Array have no shape: their data properties, index keys and methods are
   * answered by the layout itself (jsrt_typed.zig), and a key neither class has reads undefined. */
  if (jsrt_is_uint8array(obj) || jsrt_is_arraybuffer(obj)) {
    jsrt_value out = JSRT_UNDEFINED;
    (void)jsrt_typed_get_prop(obj, key, &out);
    return out;
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      const int32_t slot = fixed_slot(obj, key);
      if (slot >= 0) {
        return jsrt_as_object(obj)->fields[slot];
      }
      /* An undeclared OWN property shadows a method the prototype would answer. */
      const JSRTDynObject *extras = jsrt_fixed_extras(obj);
      if (extras != NULL && jsrt_shape_find(extras->shape, key) != NULL) {
        return jsrt_get_prop(extras_value(extras), key, NULL);
      }
      bool found = false;
      jsrt_value method = fixed_method_get(obj, key, &found);
      if (found || jsrt_regexp_property(obj, key, &method)) {
        return method;
      }
      return JSRT_UNDEFINED;
    }
    if (jsrt_is(obj, JSRT_TAG_STRING)) {
      if (strcmp(key, "length") == 0) {
        return jsrt_number((double)jsrt_string_length(obj));
      }
      /* String exotic index (ECMA-262 §10.4.3): a canonical array index below length answers
       * the UTF-16 unit at that position (plan-notes 375 / F1). Out of range stays undefined. */
      uint32_t index = 0;
      if (jsrt_key_is_array_index(key, &index) && index < jsrt_string_length(obj)) {
        const uint16_t unit = jsrt_string_char(obj, index);
        return jsrt_string_from_units(&unit, 1);
      }
    }
    /* A primitive's prototype methods, bound to it (plan-notes 310; booleans plan-notes 372):
     * `text.slice(1)` on an Unknown receiver read `undefined` here and the call aborted STA2006. */
    jsrt_value primitive_method = JSRT_UNDEFINED;
    if (jsrt_string_method(obj, key, &primitive_method) ||
        jsrt_number_method(obj, key, &primitive_method) ||
        jsrt_boolean_method(obj, key, &primitive_method)) {
      return primitive_method;
    }
    return JSRT_UNDEFINED;
  }
  const PropTable o = as_prop_table(obj, "get");
  if (ic != NULL && ic->shape == *o.shape) {
    return accessor_read((*o.slots)[ic->offset], obj);
  }
  const JSRTShape *hit = jsrt_shape_find(*o.shape, key);
  if (hit == NULL) {
    /* Array.prototype as values (plan.md §8 step 20): the walk above covers own properties
     * only, so `a.push` on an array fell through to `undefined` and the call aborted STA2006
     * where Node runs. Own properties shadow -- this asks only on a miss -- and a method hit
     * never fills the IC, whose fast path trusts a shape match for the site's key alone while a
     * bound method belongs to one receiver. */
    jsrt_value method = JSRT_UNDEFINED;
    if (jsrt_is(obj, JSRT_TAG_ARRAY) && jsrt_array_method(obj, key, &method)) {
      return method;
    }
    /* A prototype hit never fills the IC either: the site's cache says "this shape, this own
     * slot", and an inherited member is neither. */
    if (jsrt_is_dynobj(obj) && inherited_get(obj, key, obj, &method)) {
      return method;
    }
    return JSRT_UNDEFINED;
  }
  if (ic != NULL) {
    ic->shape = *o.shape;
    ic->offset = hit->offset;
  }
  return accessor_read((*o.slots)[hit->offset], obj);
}

/* `key`'s index in a class's method table, or -1. */
static int32_t method_index(const JSRTClass *cls, const char *key) {
  if (cls->method_names == NULL || cls->methods == NULL) {
    return -1;
  }
  for (uint32_t i = 0; i < cls->method_count; i++) {
    if (cls->method_names[i] != NULL && strcmp(cls->method_names[i], key) == 0) {
      return (int32_t)i;
    }
  }
  return -1;
}

/* The OWN `constructor` of a dynamic prototype object, by name: a `constructor` key written on
 * it, else the hidden one `F.prototype` carries; "" for neither, or for a value that is not a
 * function -- util.format reads the own descriptor's value and asks for a function's name. */
static const char *own_constructor_name(const JSRTDynObject *o) {
  const JSRTShape *hit = jsrt_shape_find(o->shape, "constructor");
  const jsrt_value ctor = hit != NULL ? o->slots[hit->offset] : o->ctor;
  return ctor != 0 && jsrt_is(ctor, JSRT_TAG_CLOSURE) ? jsrt_as_closure(ctor)->name : "";
}

/* A class method on a fixed instance: the descriptor's table entry, or the hidden `#method:` slot
 * when the method captures and has no one constant form. The holder is the class whose prototype
 * owns it -- the topmost class in the chain still sharing the receiver's entry -- which a NULL
 * entry cannot single out; then every candidate is a class that lists the name. */
static void class_method_holder(const JSRTClass *cls, const char *key, int32_t index,
                                const char **holder, bool *exact) {
  const JSRTClosure *entry = cls->methods[index];
  const JSRTClass *k = cls;
  if (entry != NULL) {
    while (k->parent != NULL) {
      const int32_t at = method_index(k->parent, key);
      if (at < 0 || k->parent->methods[at] != entry) {
        break;
      }
      k = k->parent;
    }
    *holder = k->name;
    return;
  }
  *holder = cls->name;
  for (; k != NULL && method_index(k, key) >= 0; k = k->parent) {
    if (k != cls) {
      *exact = false;
    }
    if (jsrt_is_builtin_constructor_name(k->name)) {
      *holder = k->name;
    }
  }
}

/* A fixed-layout object's half of jsrt_user_get: an own field, the overflow table, a literal's own
 * method slot, a class's method. */
static bool fixed_user_get(jsrt_value obj, const char *key, jsrt_value *out, const char **holder,
                           bool *exact) {
  const JSRTObject *o = jsrt_as_object(obj);
  const int32_t slot = fixed_slot(obj, key);
  if (slot >= 0) {
    *out = o->fields[slot];
    return true;
  }
  const JSRTDynObject *extras = jsrt_fixed_extras(obj);
  if (extras != NULL && jsrt_shape_find(extras->shape, key) != NULL) {
    *out = jsrt_get_prop(extras_value(extras), key, NULL);
    return true;
  }
  const int32_t index = method_index(o->cls, key);
  bool found = false;
  const jsrt_value method = fixed_method_get(obj, key, &found);
  if (!found) {
    return false;
  }
  *out = method;
  /* A `#method:` slot the class table does not list is an object literal's OWN method. */
  if (index >= 0) {
    class_method_holder(o->cls, key, index, holder, exact);
  }
  return true;
}

bool jsrt_user_get(jsrt_value obj, const char *key, jsrt_value *out, const char **holder,
                   bool *exact) {
  const char *where = NULL;
  bool sure = true;
  bool found = false;
  jsrt_value value = JSRT_UNDEFINED;
  if (jsrt_is(obj, JSRT_TAG_CLOSURE)) {
    const JSRTClosure *c = jsrt_as_closure(obj);
    const JSRTStaticEntry *entry = class_static_find(c, key, false);
    if (entry != NULL) {
      found = true;
      value = entry->kind == JSRT_STATIC_GETTER ? jsrt_call(*entry->slot, 1, &obj) : *entry->slot;
    } else if (c->klass == NULL) {
      found = function_own_get(obj, key, &value);
    }
  } else if (jsrt_is_uint8array(obj) || jsrt_is_arraybuffer(obj)) {
    found = false; /* no shape: every key is the layout's own, and none is a user method */
  } else if (!has_prop_table(obj)) {
    found = jsrt_is(obj, JSRT_TAG_OBJECT) && fixed_user_get(obj, key, &value, &where, &sure);
  } else {
    const PropTable o = as_prop_table(obj, "get");
    const JSRTShape *hit = jsrt_shape_find(*o.shape, key);
    if (hit != NULL) {
      found = true;
      value = accessor_read((*o.slots)[hit->offset], obj);
    }
    /* §10.1.8.1 OrdinaryGet up a dynamic object's chain: a getter found runs with the ORIGINAL
     * receiver. A prototype that is not a dynamic object answers for itself and has no own
     * `constructor`; one with no representation (%Object.prototype%) ends the walk with a miss. */
    for (jsrt_value p = jsrt_is_dynobj(obj) ? ((const JSRTDynObject *)jsrt_ptr(obj))->proto : 0;
         !found && p != 0;) {
      if (!jsrt_is_dynobj(p)) {
        found = jsrt_user_get(p, key, &value, NULL, NULL);
        where = "";
        break;
      }
      const JSRTDynObject *proto = (const JSRTDynObject *)jsrt_ptr(p);
      const JSRTShape *inherited = jsrt_shape_find(proto->shape, key);
      if (inherited != NULL) {
        found = true;
        value = accessor_read(proto->slots[inherited->offset], obj);
        where = own_constructor_name(proto);
      }
      p = proto->proto;
    }
  }
  if (found) {
    *out = value;
    if (holder != NULL) {
      *holder = where;
    }
    if (exact != NULL) {
      *exact = sure;
    }
  }
  return found;
}

bool jsrt_has_prop(jsrt_value obj, const char *key) {
  if (jsrt_is_nullish(obj)) {
    return false;
  }
  if (jsrt_is(obj, JSRT_TAG_CLOSURE)) {
    /* The same presence `jsrt_get_prop` reads through: a class object's statics (own and
     * inherited), then the closure's own `length`/`name`. */
    const JSRTClosure *c = jsrt_as_closure(obj);
    if (c->klass != NULL) {
      for (const JSRTClass *k = c->klass; k != NULL; k = k->parent) {
        if (k->statics == NULL) {
          continue;
        }
        for (const JSRTStaticEntry *e = k->statics; e->name != NULL; e++) {
          if (strcmp(e->name, key) == 0) {
            return true;
          }
        }
      }
    }
    jsrt_value own = JSRT_UNDEFINED;
    return strcmp(key, "length") == 0 || strcmp(key, "name") == 0 ||
           (c->klass == NULL && function_own_get(obj, key, &own));
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      const JSRTDynObject *extras = jsrt_fixed_extras(obj);
      return fixed_has(obj, key) ||
             (extras != NULL && jsrt_shape_find(extras->shape, key) != NULL);
    }
    if (jsrt_is(obj, JSRT_TAG_STRING)) {
      if (strcmp(key, "length") == 0) {
        return true;
      }
      uint32_t index = 0;
      return jsrt_key_is_array_index(key, &index) && index < jsrt_string_length(obj);
    }
    return false;
  }
  const PropTable o = as_prop_table(obj, "has");
  return jsrt_shape_find(*o.shape, key) != NULL;
}

bool jsrt_in(jsrt_value key, jsrt_value obj) {
  if (jsrt_is_nullish(obj)) {
    jsrt_throw_error(&jsrt_class_type_error,
                     "Cannot use 'in' operator to search for a value in null or undefined");
    return false;
  }
  /* Compared, never stored: a miss must not enter the intern table (T16). */
  char *k = jsrt_shape_key_ephemeral(jsrt_to_string(key));
  if (!jsrt_is_object(obj)) {
    /* §13.10.1 step 6: the RIGHT operand must be an Object, and a primitive is not one -- so the
     * answer is a TypeError, never a boolean. Two wrong answers lived here: `"length" in "abc"`
     * reported `true` through the string branch of `jsrt_has_prop`, and any other primitive
     * reported `false`, so a thrown error was hidden behind an ordinary value (plan-notes 220).
     * Node's wording names both operands, so the receiver goes through ToString like the key. */
    char *receiver = jsrt_shape_key_ephemeral(jsrt_to_string(obj));
    char message[256];
    snprintf(message, sizeof message, "Cannot use 'in' operator to search for '%s' in %s", k,
             receiver);
    free(receiver);
    free(k);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return false;
  }
  bool answer = false;
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    /* An INDEX test, not a decimal parse: `strtoul` accepts a sign and leading zeros, so `'01' in
     * a`, `'+1' in a` and `'-0' in a` all answered `true` where Node answers `false`. The canonical
     * spelling `jsrt_key_is_array_index` is the one test the rest of this file uses. */
    uint32_t index = 0;
    const JSRTArray *a = jsrt_as_array(obj);
    answer = strcmp(k, "length") == 0 || (jsrt_key_is_array_index(k, &index) &&
                                          index < a->length && a->elements[index] != JSRT_HOLE);
  }
  if (!answer) {
    answer = jsrt_has_prop(obj, k);
  }
  /* `in` sees the prototype chain, where `Object.hasOwn` (the other `jsrt_has_prop` caller) must
   * not: `'get' in new F()` is true when `F.prototype.get` is (§10.1.7.1 OrdinaryHasProperty). */
  jsrt_value inherited = JSRT_UNDEFINED;
  if (!answer && jsrt_is_dynobj(obj)) {
    answer = inherited_get(obj, k, obj, &inherited);
  }
  free(k);
  return answer;
}

/* `a.length = v` (ECMA-262 §10.4.2.4 ArraySetLength): the length is ToUint32 of the value, and a
 * value that ToUint32 changes is a RangeError. Shrinking drops the tail; growing would leave the new
 * indices ABSENT, which a dense array cannot spell, so it refuses loudly exactly as a write past the
 * end does (STA2002) rather than print `undefined` where Node prints `<n empty items>`. The value is
 * coerced once, where the spec coerces it twice -- observable only through a `valueOf` with side
 * effects (plan-notes 310). */
static void array_set_length(jsrt_value array, jsrt_value value) {
  const double number = jsrt_to_number(value);
  if (jsrt_pending()) {
    return;
  }
  const uint32_t length = jsrt_to_uint32(number);
  if ((double)length != number) {
    jsrt_throw_error(&jsrt_class_range_error, "Invalid array length");
    return;
  }
  JSRTArray *a = jsrt_as_array(array);
  if (length > a->length) {
    jsrt_panic("STA2002: sparse arrays are not yet supported: an array length grown by assignment");
  }
  /* The dropped tail is cleared so the collector does not keep its elements alive. */
  for (uint32_t i = length; i < a->length; i++) {
    a->elements[i] = JSRT_UNDEFINED;
  }
  a->length = length;
}

/* An existing own slot takes `value` -- through its setter when it holds an accessor cell and the
 * write honors accessors, which every write but a definition does. */
static void write_own_slot(jsrt_value *slot, const char *key, jsrt_value obj, jsrt_value value,
                           bool honor_accessor) {
  if (honor_accessor && accessor_write(*slot, key, obj, value)) {
    return;
  }
  *slot = value;
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
  if (jsrt_is(obj, JSRT_TAG_CLOSURE) && jsrt_as_closure(obj)->klass != NULL) {
    /* A class object's statics write through the same slots the named spelling writes
     * (docs/VALUE.md §4.17); a setter runs with the class object as receiver. Node's strict-mode
     * answer to writing a getter-only name is a TypeError, and adding a NEW static is the same
     * growth a fixed shape refuses below (STA2004, Phase 8's surface). */
    const JSRTClosure *c = jsrt_as_closure(obj);
    const JSRTStaticEntry *entry = class_static_find(c, key, true);
    if (entry != NULL) {
      if (entry->kind == JSRT_STATIC_SETTER) {
        jsrt_value args[2] = {obj, value};
        (void)jsrt_call(*entry->slot, 2, args);
        return;
      }
      *entry->slot = value;
      return;
    }
    if (class_static_other_half(c, key, true)) {
      char msg[256];
      snprintf(msg, sizeof msg, "Cannot set property %s of #<class %s> which has only a getter",
               key, c->name);
      jsrt_throw_error(&jsrt_class_type_error, msg);
      return;
    }
    jsrt_panic("STA2004: a class object cannot grow a new static; planned for Phase 8");
  }
  if (jsrt_is(obj, JSRT_TAG_CLOSURE)) {
    /* An ordinary function's own properties (plan-notes 310): `prototype` is its own slot, `name`
     * and `length` are read-only (compiled modules are strict, so the write throws), and anything
     * else lands in the function's property object, created on the first write. */
    JSRTClosure *c = function_record(obj);
    if (strcmp(key, "prototype") == 0 && (c->constructible || c->has_prototype)) {
      c->prototype = value;
      c->has_prototype = true;
      return;
    }
    if (strcmp(key, "name") == 0 || strcmp(key, "length") == 0) {
      char msg[256];
      snprintf(msg, sizeof msg, "Cannot assign to read only property '%s' of function '%s'", key,
               c->name);
      jsrt_throw_error(&jsrt_class_type_error, msg);
      return;
    }
    if (c->props == NULL) {
      c->props = (JSRTDynObject *)jsrt_ptr(jsrt_dynobj_new());
    }
    store_prop(JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)c->props), key, value, NULL, honor_accessor);
    return;
  }
  if (jsrt_is(obj, JSRT_TAG_ARRAY) && strcmp(key, "length") == 0) {
    array_set_length(obj, value);
    return;
  }
  if (!has_prop_table(obj)) {
    if (jsrt_is(obj, JSRT_TAG_OBJECT)) {
      if (fixed_set(obj, key, value)) {
        return;
      }
      /* Growth (docs/VALUE.md §4.24): a name the class never declared lands in the overflow
       * table, created on the first such write. A frozen object is not extensible, and strict
       * code -- every compiled module -- throws Node's TypeError for adding to it. */
      if (jsrt_is_fixed_object(obj)) {
        JSRTObject *o = jsrt_as_object(obj);
        if (o->frozen && (o->extras == NULL || jsrt_shape_find(o->extras->shape, key) == NULL)) {
          char msg[256];
          snprintf(msg, sizeof msg, "Cannot add property %s, object is not extensible", key);
          jsrt_throw_error(&jsrt_class_type_error, msg);
          return;
        }
        if (o->extras == NULL) {
          o->extras = (JSRTDynObject *)jsrt_ptr(jsrt_dynobj_new());
        }
        store_prop(extras_value(o->extras), key, value, NULL, honor_accessor);
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
    write_own_slot(&(*o.slots)[ic->offset], key, obj, value, honor_accessor);
    return;
  }
  const JSRTShape *hit = jsrt_shape_find((*o.shape), key);
  if (hit != NULL) {
    if (ic != NULL) {
      ic->shape = (*o.shape);
      ic->offset = hit->offset;
    }
    write_own_slot(&(*o.slots)[hit->offset], key, obj, value, honor_accessor);
    return;
  }

  if (jsrt_is_dynobj(obj) && honor_accessor) {
    const jsrt_value inherited = inherited_accessor(obj, key);
    if (inherited != 0 && accessor_write(inherited, key, obj, value)) {
      return;
    }
  }

  /* New property: take (or build) the transition, and make its slot writable. */
  JSRTShape *next = jsrt_shape_transition((*o.shape), key);
  jsrt_shape_reserve(o.slots, o.capacity, next->offset);
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
  JSRTAccessorCell *cell =
      (JSRTAccessorCell *)jsrt_gc_alloc(sizeof(JSRTAccessorCell), "dynamic object slots");
  cell->cls = &jsrt_class_accessor;
  cell->get = get;
  cell->set = set;
  /* No IC: installation happens once per object at construction, so a cache would never hit. */
  store_prop(obj, key, JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)cell), NULL, false);
}

bool jsrt_delete(jsrt_value obj, jsrt_value key) {
  if (jsrt_is_nullish(obj)) {
    jsrt_throw_error(&jsrt_class_type_error, "Cannot convert undefined or null to object");
    return false;
  }
  /* Compared, never stored on this call: the chain a removal replays already holds the
   * interned pointers. A miss must not enter the intern table (T16). */
  char *k = jsrt_shape_key_ephemeral(jsrt_to_string(key));
  bool answer = true;
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    uint32_t index = 0;
    /* `delete a[1]` leaves a HOLE that `1 in a` denies and iteration skips (docs/VALUE.md §4.4).
     * `length` is non-configurable: strict code throws Node's TypeError for it. */
    if (strcmp(k, "length") == 0) {
      jsrt_throw_error(&jsrt_class_type_error,
                       "Cannot delete property 'length' of [object Array]");
      answer = false;
    } else if (jsrt_key_is_array_index(k, &index)) {
      answer = jsrt_array_delete(obj, index);
    }
  } else if (!has_prop_table(obj)) {
    /* A fixed layout is slots at compile-time offsets; a missing one has no encoding. Deleting a
     * key it never had is still `true` -- there was nothing to remove. Symmetric with STA2004,
     * and it lifts with the same Phase 8 dictionary-mode escape.
     *
     * FROZEN is the one fixed-shape delete with a right answer, and it is the answer: a frozen
     * property is non-configurable, so the spec's `delete` raises in strict mode and never has to
     * reach a representation the layout does not have (plan.md §8 step 2a(c), bucket 2704). */
    const JSRTDynObject *extras = jsrt_fixed_extras(obj);
    if (extras != NULL && jsrt_shape_find(extras->shape, k) != NULL) {
      free(k);
      return jsrt_delete(extras_value(extras), key);
    }
    if (jsrt_is(obj, JSRT_TAG_OBJECT) && fixed_has(obj, k)) {
      if (jsrt_as_object(obj)->frozen) {
        char msg[256];
        snprintf(msg, sizeof msg, "Cannot delete property '%s' of #<Object>", k);
        free(k);
        jsrt_throw_error(&jsrt_class_type_error, msg);
        return false;
      }
      free(k);
      jsrt_panic(
          "STA2007: a statically-shaped object cannot lose a property; planned for Phase 8");
    }
    free(k);
    return true;
  }
  const PropTable o = as_prop_table(obj, "delete");
  const JSRTShape *hit = jsrt_shape_find(*o.shape, k);
  if (hit == NULL) {
    /* Absent is `true` even on a frozen object: §13.5.1.2 asks [[Delete]], and deleting what is
     * not there succeeds. Only an existing non-configurable property raises. */
    free(k);
    return true;
  }
  if (jsrt_is_dynobj(obj) && ((JSRTDynObject *)jsrt_ptr(obj))->frozen) {
    char msg[256];
    snprintf(msg, sizeof msg, "Cannot delete property '%s' of #<Object>", k);
    jsrt_throw_error(&jsrt_class_type_error, msg);
    answer = false;
  } else {
    jsrt_shape_remove(o.shape, *o.slots, hit);
  }
  free(k);
  return answer;
}

jsrt_value jsrt_dyn_index_get(jsrt_value obj, jsrt_value index, JSRTIC *ic) {
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    return jsrt_array_get(obj, index);
  }
  if (jsrt_is_uint8array(obj)) {
    return jsrt_uint8array_get(obj, index);
  }
  return jsrt_get_prop_value(obj, index, ic);
}

void jsrt_dyn_index_set(jsrt_value obj, jsrt_value index, jsrt_value value, JSRTIC *ic) {
  if (jsrt_is(obj, JSRT_TAG_ARRAY)) {
    /* An Unknown receiver is an Unknown-element view, so a write past the end may leave holes
     * (docs/VALUE.md §4.4). */
    jsrt_array_set_sparse(obj, index, value);
    return;
  }
  if (jsrt_is_uint8array(obj)) {
    jsrt_uint8array_put(obj, index, value);
    return;
  }
  jsrt_set_prop(obj, jsrt_shape_key(jsrt_to_string(index)), value, ic);
}
