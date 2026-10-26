/* Builtin constructors and prototypes as VALUES, and the builtin-receiver methods an Unknown
 * receiver reads by name (docs/VALUE.md §4.24).
 *
 * `ctor === Date`, `[].filter(Boolean)`, `o === Object.prototype`: the compiler lowers each
 * global constructor read as a value to `jsrt_builtin_ctor(name)`, and `X.prototype` to
 * `jsrt_builtin_proto(name)`. Both are interned per name, so identity comparison is exact, and
 * `v.constructor` on a builtin value answers the same interned object. The three conversion
 * constructors (`Boolean`, `Number`, `String`) are callable and convert; every other one throws
 * the TypeError Node throws for a class constructor called without `new`, and none of them is
 * constructible -- the compiler only admits them where they are compared or passed. */
#include "jsrt.h"
#include "jsrt_value.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *const BUILTIN_NAMES[] = {
    "Object",  "Array",       "Boolean",  "Number",     "String",  "Date",
    "RegExp",  "Map",         "Set",      "WeakMap",    "WeakSet", "ArrayBuffer",
    "DataView", "Uint8Array", "Promise",  "Function",   "Error",
};
#define BUILTIN_COUNT (sizeof BUILTIN_NAMES / sizeof BUILTIN_NAMES[0])

/* Interned once per name and kept in static storage, which the collector scans as a root. */
static jsrt_value ctor_cache[BUILTIN_COUNT];
static jsrt_value proto_cache[BUILTIN_COUNT];

static int builtin_index(const char *name) {
  for (size_t i = 0; i < BUILTIN_COUNT; i++) {
    if (strcmp(BUILTIN_NAMES[i], name) == 0) {
      return (int)i;
    }
  }
  return -1;
}

static jsrt_value ctor_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const uint32_t row = (uint32_t)jsrt_to_number(env->slots[1]);
  const char *name = BUILTIN_NAMES[row];
  const jsrt_value argument = jsrt_arg(argc, argv, 0);
  if (strcmp(name, "Boolean") == 0) {
    return jsrt_bool(argc > 0 && jsrt_truthy(argument));
  }
  if (strcmp(name, "Number") == 0) {
    return argc == 0 ? jsrt_number(0) : jsrt_number(jsrt_to_number(argument));
  }
  if (strcmp(name, "String") == 0) {
    return argc == 0 ? jsrt_string_from_utf8("", 0) : jsrt_to_string(argument);
  }
  char message[256];
  (void)snprintf(message, sizeof message,
                 "calling the builtin %s through a value is not supported by this runtime", name);
  jsrt_throw_error(&jsrt_class_type_error, message);
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_builtin_ctor(const char *name) {
  const int i = builtin_index(name);
  if (i < 0) {
    jsrt_panic("jsrt_builtin_ctor: unknown builtin");
  }
  if (ctor_cache[i] == 0) {
    ctor_cache[i] = jsrt_bound_method(JSRT_UNDEFINED, (uint32_t)i, ctor_call, 1, BUILTIN_NAMES[i]);
  }
  return ctor_cache[i];
}

jsrt_value jsrt_builtin_proto(const char *name) {
  const int i = builtin_index(name);
  if (i < 0) {
    jsrt_panic("jsrt_builtin_proto: unknown builtin");
  }
  if (proto_cache[i] == 0) {
    proto_cache[i] = jsrt_dynobj_new();
  }
  return proto_cache[i];
}

/* The builtin name `v.constructor` answers for a builtin value, or NULL. Plain dynamic objects
 * are answered by the caller after the prototype walk misses, so an own or inherited
 * `constructor` still shadows. */
static const char *builtin_kind_name(jsrt_value v) {
  if (jsrt_is(v, JSRT_TAG_ARRAY)) {
    return "Array";
  }
  if (jsrt_is_uint8array(v)) {
    return "Uint8Array";
  }
  /* A primitive's `constructor` is its wrapper's, read through the prototype (§20.1.3.1). */
  if (jsrt_is_number(v)) {
    return "Number";
  }
  if (jsrt_is(v, JSRT_TAG_STRING)) {
    return "String";
  }
  if (v == JSRT_TRUE || v == JSRT_FALSE) {
    return "Boolean";
  }
  if (jsrt_is_arraybuffer(v)) {
    return "ArrayBuffer";
  }
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return NULL;
  }
  const JSRTClass *cls = jsrt_as_object(v)->cls;
  if (cls == &jsrt_class_map) {
    return "Map";
  }
  if (cls == &jsrt_class_set) {
    return "Set";
  }
  if (cls == &jsrt_class_weakmap) {
    return "WeakMap";
  }
  if (cls == &jsrt_class_weakset) {
    return "WeakSet";
  }
  if (cls == &jsrt_class_date) {
    return "Date";
  }
  if (cls == &jsrt_class_regexp) {
    return "RegExp";
  }
  if (cls == &jsrt_class_promise) {
    return "Promise";
  }
  return NULL;
}

bool jsrt_builtin_constructor_of(jsrt_value v, jsrt_value *out) {
  const char *name = builtin_kind_name(v);
  if (name == NULL) {
    return false;
  }
  *out = jsrt_builtin_ctor(name);
  return true;
}

/* The generated-code entry points: the name arrives as a string literal value. */
jsrt_value jsrt_builtin_ctor_value(jsrt_value name) {
  char *key = jsrt_shape_key_ephemeral(name);
  const jsrt_value out = jsrt_builtin_ctor(key);
  free(key);
  return out;
}

jsrt_value jsrt_builtin_proto_value(jsrt_value name) {
  char *key = jsrt_shape_key_ephemeral(name);
  const jsrt_value out = jsrt_builtin_proto(key);
  free(key);
  return out;
}

/* `ArrayBuffer.isView(v)` (§25.1.5.1): true for a view on a buffer. Uint8Array is the one view
 * this runtime has. */
jsrt_value jsrt_arraybuffer_is_view(jsrt_value v) { return jsrt_bool(jsrt_is_uint8array(v)); }

/* -------------------------------------------- Map/Set/Date methods on an Unknown receiver */

enum {
  COLL_HAS,
  COLL_GET,
  COLL_SET,
  COLL_ADD,
  COLL_DELETE,
  COLL_CLEAR,
  COLL_KEYS,
  COLL_VALUES,
  COLL_ENTRIES,
  COLL_FOR_EACH,
  DATE_GET_TIME,
  DATE_VALUE_OF,
  DATE_TO_ISO_STRING,
};

static jsrt_value builtin_method_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const jsrt_value self = env->slots[0];
  const uint32_t row = (uint32_t)jsrt_to_number(env->slots[1]);
  const jsrt_value a = jsrt_arg(argc, argv, 0);
  const bool is_map = jsrt_is(self, JSRT_TAG_OBJECT) && jsrt_as_object(self)->cls == &jsrt_class_map;
  switch (row) {
    case COLL_HAS:
      return jsrt_bool(jsrt_map_has(self, a));
    case COLL_GET:
      return jsrt_map_get(self, a);
    case COLL_SET:
      return jsrt_map_set(self, a, jsrt_arg(argc, argv, 1));
    case COLL_ADD:
      return jsrt_set_add(self, a);
    case COLL_DELETE:
      return jsrt_bool(jsrt_map_delete(self, a));
    case COLL_CLEAR:
      return jsrt_map_clear(self);
    case COLL_KEYS:
      return jsrt_iterator_new(self, is_map ? JSRT_ITER_MAP_KEYS : JSRT_ITER_SET_KEYS);
    case COLL_VALUES:
      return jsrt_iterator_new(self, is_map ? JSRT_ITER_MAP_VALUES : JSRT_ITER_SET_VALUES);
    case COLL_ENTRIES:
      return jsrt_iterator_new(self, is_map ? JSRT_ITER_MAP_ENTRIES : JSRT_ITER_SET_ENTRIES);
    case COLL_FOR_EACH:
      return is_map ? jsrt_map_for_each(self, a) : jsrt_set_for_each(self, a);
    case DATE_GET_TIME:
    case DATE_VALUE_OF:
      return jsrt_date_get_time(self);
    case DATE_TO_ISO_STRING:
      return jsrt_date_to_iso_string(self);
    default:
      jsrt_panic("builtin_method_call: bad row");
  }
}

typedef struct {
  const char *name;
  uint32_t row;
  uint32_t length;
} MethodRow;

static const MethodRow MAP_ROWS[] = {
    {"has", COLL_HAS, 1},       {"get", COLL_GET, 1},         {"set", COLL_SET, 2},
    {"delete", COLL_DELETE, 1}, {"clear", COLL_CLEAR, 0},     {"keys", COLL_KEYS, 0},
    {"values", COLL_VALUES, 0}, {"entries", COLL_ENTRIES, 0}, {"forEach", COLL_FOR_EACH, 1},
};
static const MethodRow SET_ROWS[] = {
    {"has", COLL_HAS, 1},       {"add", COLL_ADD, 1},         {"delete", COLL_DELETE, 1},
    {"clear", COLL_CLEAR, 0},   {"keys", COLL_KEYS, 0},       {"values", COLL_VALUES, 0},
    {"entries", COLL_ENTRIES, 0}, {"forEach", COLL_FOR_EACH, 1},
};
static const MethodRow DATE_ROWS[] = {
    {"getTime", DATE_GET_TIME, 0},
    {"valueOf", DATE_VALUE_OF, 0},
    {"toISOString", DATE_TO_ISO_STRING, 0},
};

static bool find_row(const MethodRow *rows, size_t n, jsrt_value self, const char *key,
                     jsrt_value *out) {
  for (size_t i = 0; i < n; i++) {
    if (strcmp(rows[i].name, key) == 0) {
      *out = jsrt_bound_method(self, rows[i].row, builtin_method_call, rows[i].length, rows[i].name);
      return true;
    }
  }
  return false;
}

bool jsrt_builtin_member(jsrt_value obj, const char *key, jsrt_value *out) {
  if (!jsrt_is(obj, JSRT_TAG_OBJECT)) {
    return false;
  }
  const JSRTClass *cls = jsrt_as_object(obj)->cls;
  if (cls == &jsrt_class_map || cls == &jsrt_class_set) {
    if (strcmp(key, "size") == 0) {
      *out = jsrt_map_size(obj);
      return true;
    }
    return cls == &jsrt_class_map
               ? find_row(MAP_ROWS, sizeof MAP_ROWS / sizeof MAP_ROWS[0], obj, key, out)
               : find_row(SET_ROWS, sizeof SET_ROWS / sizeof SET_ROWS[0], obj, key, out);
  }
  if (cls == &jsrt_class_date) {
    return find_row(DATE_ROWS, sizeof DATE_ROWS / sizeof DATE_ROWS[0], obj, key, out);
  }
  return false;
}

/* ----------------------------------------------- Function.prototype.call / apply, bound */

static jsrt_value function_call_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const jsrt_value fn = env->slots[0];
  const bool apply = jsrt_to_number(env->slots[1]) == 1.0;
  const jsrt_value receiver = jsrt_arg(argc, argv, 0);
  if (!apply) {
    return jsrt_call_with_this(fn, receiver, argc > 0 ? argc - 1U : 0U, argc > 0 ? argv + 1 : argv);
  }
  const jsrt_value list = jsrt_arg(argc, argv, 1);
  if (jsrt_is_nullish(list)) {
    return jsrt_call_with_this(fn, receiver, 0, NULL);
  }
  if (!jsrt_is(list, JSRT_TAG_ARRAY)) {
    jsrt_throw_error(&jsrt_class_type_error, "CreateListFromArrayLike called on non-object");
    return JSRT_UNDEFINED;
  }
  const JSRTArray *array = jsrt_as_array(list);
  return jsrt_call_with_this(fn, receiver, array->length, array->elements);
}

jsrt_value jsrt_function_call_method(jsrt_value fn, bool apply) {
  return jsrt_bound_method(fn, apply ? 1U : 0U, function_call_call, apply ? 2U : 1U,
                           apply ? "apply" : "call");
}

/* ------------------------------------------- Object.prototype methods as values (`has.call`) */

/* Object.prototype.hasOwnProperty over any receiver: the key is ToPropertyKey'd to a string; an
 * array answers its present indices and `length`, a string its indices and `length`, an object
 * its own properties, and anything else false. */
static jsrt_value builtin_has_own(jsrt_value self, jsrt_value key) {
  const jsrt_value name = jsrt_is(key, JSRT_TAG_STRING) ? key : jsrt_to_string(key);
  if (jsrt_is(self, JSRT_TAG_ARRAY) || jsrt_is(self, JSRT_TAG_STRING)) {
    const jsrt_value keys = jsrt_object_keys(self);
    const JSRTArray *list = jsrt_as_array(keys);
    char *text = jsrt_shape_key_ephemeral(name);
    bool found = strcmp(text, "length") == 0;
    free(text);
    for (uint32_t i = 0; !found && i < list->length; i++) {
      found = jsrt_string_equals(list->elements[i], name);
    }
    return jsrt_bool(found);
  }
  jsrt_value ctor = JSRT_UNDEFINED;
  if (!jsrt_is(self, JSRT_TAG_OBJECT) || jsrt_builtin_constructor_of(self, &ctor)) {
    return JSRT_FALSE;
  }
  return jsrt_object_has_own(self, name);
}

static jsrt_value object_proto_call(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  const uint32_t row = (uint32_t)jsrt_to_number(env->slots[1]);
  const jsrt_value self = jsrt_arg(argc, argv, 0);
  if (row == 0) {
    if (jsrt_is_nullish(self)) {
      jsrt_throw_error(&jsrt_class_type_error, "Cannot convert undefined or null to object");
      return JSRT_UNDEFINED;
    }
    return builtin_has_own(self, jsrt_arg(argc, argv, 1));
  }
  /* Object.prototype.toString (§20.1.3.6): the builtin tag, with no Symbol.toStringTag. */
  const char *tag = "Object";
  if (self == JSRT_UNDEFINED) {
    tag = "Undefined";
  } else if (self == JSRT_NULL) {
    tag = "Null";
  } else if (jsrt_is(self, JSRT_TAG_ARRAY)) {
    tag = "Array";
  } else if (jsrt_is(self, JSRT_TAG_CLOSURE)) {
    tag = "Function";
  } else if (jsrt_is(self, JSRT_TAG_STRING)) {
    tag = "String";
  } else if (jsrt_is_number(self)) {
    tag = "Number";
  } else if (self == JSRT_TRUE || self == JSRT_FALSE) {
    tag = "Boolean";
  } else if (jsrt_is_date(self)) {
    tag = "Date";
  } else if (jsrt_is_regexp(self)) {
    tag = "RegExp";
  } else {
    const char *kind = builtin_kind_name(self);
    if (kind != NULL && (strcmp(kind, "Map") == 0 || strcmp(kind, "Set") == 0 ||
                         strcmp(kind, "Promise") == 0 || strcmp(kind, "Uint8Array") == 0 ||
                         strcmp(kind, "ArrayBuffer") == 0 || strcmp(kind, "WeakMap") == 0 ||
                         strcmp(kind, "WeakSet") == 0)) {
      tag = kind;
    }
  }
  char buf[64];
  const int n = snprintf(buf, sizeof buf, "[object %s]", tag);
  return jsrt_string_from_utf8(buf, (size_t)n);
}

static jsrt_value object_proto_cache[2];

jsrt_value jsrt_object_proto_method(const char *name) {
  const uint32_t row = strcmp(name, "hasOwnProperty") == 0 ? 0U : 1U;
  if (row == 1U && strcmp(name, "toString") != 0) {
    jsrt_panic("jsrt_object_proto_method: unknown method");
  }
  if (object_proto_cache[row] == 0) {
    JSRTEnv *env = jsrt_env_new(NULL, 2);
    env->slots[0] = JSRT_UNDEFINED;
    env->slots[1] = jsrt_number((double)row);
    object_proto_cache[row] =
        jsrt_closure_new(object_proto_call, row == 0U ? 1U : 0U, name, env, true);
  }
  return object_proto_cache[row];
}

jsrt_value jsrt_object_proto_method_value(jsrt_value name) {
  char *key = jsrt_shape_key_ephemeral(name);
  const jsrt_value out = jsrt_object_proto_method(key);
  free(key);
  return out;
}
