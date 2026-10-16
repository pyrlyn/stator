/* jsrt_value.c — value representation, frame management, and GC initialization. */

#include "jsrt_value.h"

#include "jsrt.h"

#include "jsrt_mem.h"

#include <assert.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================================
 * Boehm GC — optional conditional inclusion
 * ============================================================================ */

/* ============================================================================
 * Shadow stack frame management — rooting protocol for the GC
 * ============================================================================ */

_Thread_local JSRTFrame *jsrt_frame_top = NULL;

void jsrt_frame_init(JSRTFrame *frame) {
  /* Fill every slot with JSRT_UNDEFINED before the frame becomes reachable.
   * The frame is pushed AFTER this returns (in the JSRT_FRAME macro), so
   * a collection triggered mid-prologue can never scan an uninitialized slot. */
  for (uint32_t i = 0; i < frame->count; i++) {
    frame->slots[i] = JSRT_UNDEFINED;
  }
}

/* ============================================================================
 * Strict equality — NaN !== NaN, +0 === -0, number cross-representation
 * ============================================================================ */

bool jsrt_strict_equals(jsrt_value a, jsrt_value b) {
  /* Numbers compare by VALUE, not by bits, and in both directions: two representations of the
   * same number are equal even when their bits differ (+0 vs -0, and i32 5 vs double 5.0), while
   * NaN is unequal to itself even when the bits are identical. Normalizing both sides to a double
   * first is what makes all four of those cases fall out of one comparison. */
  if (jsrt_is_number(a) && jsrt_is_number(b)) {
    double da = jsrt_number_value(a);
    double db = jsrt_number_value(b);
    return da == db; /* C's == already gives false for NaN and true for +0 vs -0 */
  }

  /* Strings compare by content, not by pointer. Two identical string values at different
   * addresses must be equal. */
  if (jsrt_is(a, JSRT_TAG_STRING) && jsrt_is(b, JSRT_TAG_STRING)) {
    return jsrt_string_equals(a, b);
  }

  /* Everything else is bit equality. */
  return a == b;
}

/* ============================================================================
 * Initialization — assert 48-bit pointer assumption and set up GC
 * ============================================================================ */

void jsrt_init(void) {
  /* Verify the 48-bit pointer assumption against a real heap allocation.
   * This check must fail loudly at startup, never silently. */
  void *test_ptr = malloc(1024);
  if (test_ptr == NULL) {
    fprintf(stderr,
            "jsrt_init: malloc failed during pointer-width check\n");
    abort();
  }

  uintptr_t ptr_val = (uintptr_t)test_ptr;
  if ((ptr_val >> 48) != 0) {
    fprintf(stderr,
            "jsrt_init: FATAL — 48-bit pointer assumption violated.\n"
            "  Heap pointer %p has bits set above bit 48.\n"
            "  This platform (likely with 5-level paging or AArch64 TBI) "
            "is out of scope for Stator v0.\n",
            test_ptr);
    free(test_ptr);
    abort();
  }

  free(test_ptr);

  jsrt_gc_init();
}

/* ----------------------------------------------------------------- calls */

/* Runs `c` with `receiver` at argv[0] and the arguments after it: the receiver slot filled,
 * `jsrt_arg` padding the rest. The caller keeps `receiver` rooted. */
static jsrt_value call_with_receiver(const JSRTClosure *c, jsrt_value receiver, uint32_t argc,
                                     const jsrt_value *argv) {
  jsrt_value call_argv[argc + 1U];
  call_argv[0] = receiver;
  for (uint32_t i = 0; i < argc; i++) {
    call_argv[i + 1U] = argv[i];
  }
  return c->fn(argc + 1U, call_argv, c->env);
}

jsrt_value jsrt_call_at(jsrt_value callee, uint32_t argc, const jsrt_value *argv, const char *loc) {
  if (!jsrt_is(callee, JSRT_TAG_CLOSURE)) {
    if (loc != NULL) {
      char msg[512];
      (void)snprintf(msg, sizeof msg, "STA2006: calling a non-function at %s", loc);
      jsrt_panic(msg);
    }
    jsrt_panic("TypeError: callee is not a function");
  }
  const JSRTClosure *c = jsrt_as_closure(callee);
  /* A class object is callable -- `typeof` is "function" -- but calling one without `new` is
   * Node's catchable TypeError, never the constructor body (docs/VALUE.md §4.17). */
  if (c->klass != NULL) {
    char message[256];
    (void)snprintf(message, sizeof message, "Class constructor %s cannot be invoked without 'new'",
                   c->name);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return JSRT_UNDEFINED;
  }
  /* `env` is NULL for a non-capturing function; the callee takes the parameter either way, so
   * dispatch here does not have to know which kind it is holding. */
  if (c->has_receiver) {
    /* A method's parameter zero is `this`, and a plain call passes none (`g(a)` on a method
     * value), so slot zero is `undefined` and the arguments keep their positions (docs/VALUE.md
     * §4.16, plan-notes 208). A call that HAS a receiver says so through jsrt_call_method_at:
     * guessing it from argc against the arity read `o.m(a)` on `m(a, b?)` and `g(a, b, c)` on a
     * two-parameter method value backwards (plan-notes 319). */
    return call_with_receiver(c, JSRT_UNDEFINED, argc, argv);
  }
  return c->fn(argc, argv, c->env);
}

jsrt_value jsrt_call(jsrt_value callee, uint32_t argc, const jsrt_value *argv) {
  return jsrt_call_at(callee, argc, argv, NULL);
}

/* `o.m(a)`, `new K(a)`, a getter or setter: argv[0] is the receiver, always (plan-notes 319). A
 * closure that declares one gets argv as it is, `jsrt_arg` padding an omitted tail; anything else
 * is jsrt_call_at's call on the arguments after it, panic and TypeError included. */
jsrt_value jsrt_call_method_at(jsrt_value callee, uint32_t argc, const jsrt_value *argv,
                               const char *loc) {
  if (!jsrt_is(callee, JSRT_TAG_CLOSURE) || jsrt_as_closure(callee)->klass != NULL ||
      !jsrt_as_closure(callee)->has_receiver) {
    return jsrt_call_at(callee, argc - 1U, argv + 1, loc);
  }
  const JSRTClosure *c = jsrt_as_closure(callee);
  return c->fn(argc, argv, c->env);
}

/* `f(...xs)` and `o.m(a, ...xs)` (plan.md §11c T11.4 step 5): `args` is every argument, spreads
 * expanded, as one array the caller keeps rooted. A method call names its receiver here, as
 * jsrt_call_method_at's callers do: a closure that declares one gets `*receiver` (or `undefined`
 * when there is none) and every argument after it; anything else is jsrt_call_at's call, panic
 * and TypeError included. */
jsrt_value jsrt_call_spread_at(jsrt_value callee, const jsrt_value *receiver, jsrt_value args,
                               const char *loc) {
  const JSRTArray *list = jsrt_as_array(args);
  if (!jsrt_is(callee, JSRT_TAG_CLOSURE) || jsrt_as_closure(callee)->klass != NULL ||
      !jsrt_as_closure(callee)->has_receiver) {
    return jsrt_call_at(callee, list->length, list->elements, loc);
  }
  return call_with_receiver(jsrt_as_closure(callee), receiver != NULL ? *receiver : JSRT_UNDEFINED,
                            list->length, list->elements);
}

/* `new F(...)` for an ordinary function (§10.2.2 [[Construct]], plan-notes 310). JavaScript
 * splits its answer: a `function` constructs, an arrow, a method, an async function or a generator
 * raises `X is not a constructor` -- the split the closure's `constructible` records. The object
 * is a dynamic one whose prototype is `F.prototype` when that is an object; F runs with it as
 * `this` when F reads `this` at all (a function that never does takes no receiver slot), and F's
 * return replaces it exactly when the return is an object. */
static jsrt_value construct_function(jsrt_value ctor, uint32_t argc, const jsrt_value *argv) {
  const JSRTClosure *c = jsrt_as_closure(ctor);
  if (!c->constructible) {
    char message[256];
    (void)snprintf(message, sizeof message, "%s is not a constructor",
                   c->name[0] != '\0' ? c->name : "(intermediate value)");
    jsrt_throw_error(&jsrt_class_type_error, message);
    return JSRT_UNDEFINED;
  }
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_dynobj_new();
  const jsrt_value proto = jsrt_function_prototype(ctor);
  if (jsrt_is_object(proto)) {
    ((JSRTDynObject *)jsrt_ptr(JSRT_LOCAL(0)))->proto = proto;
  }
  if (c->has_receiver) {
    JSRT_LOCAL(1) = call_with_receiver(c, JSRT_LOCAL(0), argc, argv);
  } else {
    JSRT_LOCAL(1) = c->fn(argc, argv, c->env);
  }
  const jsrt_value out = jsrt_is_object(JSRT_LOCAL(1)) ? JSRT_LOCAL(1) : JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

jsrt_value jsrt_construct(jsrt_value ctor, uint32_t argc, const jsrt_value *argv) {
  if (!jsrt_is(ctor, JSRT_TAG_CLOSURE)) {
    /* Node's wording names the operand's rendered value (`5 is not a constructor`). */
    const char *shown = jsrt_shape_key(jsrt_to_string(ctor));
    char message[256];
    (void)snprintf(message, sizeof message, "%s is not a constructor", shown);
    free((void *)shown);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return JSRT_UNDEFINED;
  }
  const JSRTClosure *c = jsrt_as_closure(ctor);
  if (c->klass == NULL) {
    return construct_function(ctor, argc, argv);
  }
  /* The fresh instance must survive whatever the constructor allocates, so it is rooted before
   * the call exactly as a generated `new` roots its object slot (docs/VALUE.md §4.17). */
  JSRT_FRAME(2);
  JSRT_LOCAL(0) = jsrt_object_new(c->klass);
  if (c->fn != NULL) {
    /* Every class constructor declares a receiver (`this` is parameter zero). */
    (void)call_with_receiver(c, JSRT_LOCAL(0), argc, argv);
  }
  /* The constructor's return is ignored: the gate admits no explicit object return in a class
   * constructor, so the fresh instance IS the constructed value. */
  const jsrt_value out = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return out;
}

bool jsrt_instanceof_ctor(jsrt_value obj, jsrt_value ctor) {
  if (jsrt_is(ctor, JSRT_TAG_CLOSURE)) {
    const JSRTClosure *c = jsrt_as_closure(ctor);
    if (c->klass != NULL) {
      return jsrt_instanceof(obj, c->klass);
    }
    /* An ordinary function: §7.3.22 OrdinaryHasInstance against `f.prototype`. Only an object
     * `new` built through a function has a prototype chain to walk (plan-notes 310); every
     * other value's chain ends at a prototype this runtime does not represent. A primitive is
     * `false` before the prototype is read, which is why `1 instanceof (() => 0)` does not throw. */
    if (!jsrt_is_object(obj)) {
      return false;
    }
    const jsrt_value proto = jsrt_function_prototype(ctor);
    if (!jsrt_is_object(proto)) {
      const char *shown = jsrt_shape_key(jsrt_to_string(proto));
      char message[256];
      (void)snprintf(message, sizeof message,
                     "Function has non-object prototype '%s' in instanceof check", shown);
      free((void *)shown);
      jsrt_throw_error(&jsrt_class_type_error, message);
      return false;
    }
    for (jsrt_value p = obj; jsrt_is_dynobj(p);) {
      p = ((const JSRTDynObject *)jsrt_ptr(p))->proto;
      if (p == proto) {
        return true;
      }
    }
    return false;
  }
  /* Node distinguishes "not an object" (a primitive right operand) from "not callable" (an
   * object that is not a function); both are catchable TypeErrors. */
  const bool primitive = jsrt_is_double(ctor) || jsrt_is(ctor, JSRT_TAG_INT32) ||
                         jsrt_is(ctor, JSRT_TAG_BOOL) || jsrt_is(ctor, JSRT_TAG_STRING) ||
                         jsrt_is(ctor, JSRT_TAG_NULL) || jsrt_is(ctor, JSRT_TAG_UNDEFINED);
  jsrt_throw_error(&jsrt_class_type_error,
                   primitive ? "Right-hand side of 'instanceof' is not an object"
                             : "Right-hand side of 'instanceof' is not callable");
  return false;
}

/* The allocation helpers jsrt_value.h declares -- objects, arrays and their growth, environments,
 * closures, rest arrays -- are jsrt_alloc.zig. What stays here is what they are used for. */

/* --------------------------------------------------------------- arrays */

/* The STA2008 throw `jsrt_require_array` raises for a non-array receiver: Node's member-access
 * wording for a nullish receiver (`Cannot read properties of undefined (reading 'push')`, which
 * is where Node throws for the same program), `Array.prototype.<method> called on incompatible
 * receiver` otherwise -- Node's message names receiver SOURCE TEXT, which compiled code no longer
 * has, so only the nullish half can be Node-exact. The incompatible-receiver shape follows the
 * generator/iterator precedent in jsrt_iterator.c. */
static void throw_array_receiver(jsrt_value array, const char *method) {
  if (jsrt_is_nullish(array)) {
    char message[256];
    (void)snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
                    array == JSRT_NULL ? "null" : "undefined", method);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return;
  }
  char message[256];
  (void)snprintf(message, sizeof message, "Array.prototype.%s called on incompatible receiver",
                 method);
  jsrt_throw_error(&jsrt_class_type_error, message);
}

JSRTArray *jsrt_require_array(jsrt_value array, const char *method) {
  if (jsrt_is(array, JSRT_TAG_ARRAY)) {
    return jsrt_as_array(array);
  }
  throw_array_receiver(array, method);
  return NULL;
}

/* Render the for-of receiver for STA2009's `X is not iterable`: the nullish words and
 * number/boolean ToString are Node-exact; a string renders as its content (a real string never
 * reaches here -- strings are iterable -- so this is an annotation lie, not a language path);
 * anything else is "object", which names no value but also invents none. */
static void iterable_name(jsrt_value value, char *buf, size_t buflen) {
  if (value == JSRT_NULL) {
    (void)snprintf(buf, buflen, "null");
    return;
  }
  if (value == JSRT_UNDEFINED) {
    (void)snprintf(buf, buflen, "undefined");
    return;
  }
  if (jsrt_is_number(value) || jsrt_is(value, JSRT_TAG_BOOL)) {
    const jsrt_value text = jsrt_to_string(value);
    const uint32_t len = jsrt_string_length(text);
    size_t i = 0;
    for (; i < len && i + 1 < buflen; i++) {
      buf[i] = (char)jsrt_string_char(text, i);
    }
    buf[i] = '\0';
    return;
  }
  if (jsrt_is(value, JSRT_TAG_STRING)) {
    const uint32_t len = jsrt_string_length(value);
    size_t i = 0;
    for (; i < len && i + 1 < buflen; i++) {
      buf[i] = (char)jsrt_string_char(value, i);
    }
    buf[i] = '\0';
    return;
  }
  (void)snprintf(buf, buflen, "object");
}

void jsrt_throw_not_iterable(jsrt_value value) {
  char name[128];
  iterable_name(value, name, sizeof name);
  char message[256];
  (void)snprintf(message, sizeof message, "%s is not iterable", name);
  jsrt_throw_error(&jsrt_class_type_error, message);
}

void jsrt_require_array_iterable(jsrt_value value) {
  if (jsrt_is(value, JSRT_TAG_ARRAY)) {
    return;
  }
  jsrt_throw_not_iterable(value);
}

jsrt_value jsrt_array_length(jsrt_value array) {
  if (!jsrt_is(array, JSRT_TAG_ARRAY)) {
    /* Degrades like the index paths: nullish throws Node's `(reading 'length')`, a string
     * answers its length, anything else misses to `undefined`. */
    return jsrt_get_prop(array, "length", NULL);
  }
  return jsrt_number((double)jsrt_as_array(array)->length);
}

/* An index is in range only when its ToPropertyKey is a canonical numeric string (ECMA-262
 * §6.1.7) below `length`. Everything else -- a fraction, a negative, NaN, a number past the end,
 * a boolean, null, `"01"` -- is a property name that this array does not have, which reads as
 * `undefined`. A bare `jsrt_to_number` cannot tell them apart (`true` is 1, `"01"` is 1, `""` is
 * 0, all of which Node misses), so only numbers take the numeric test; every other key goes
 * through the same canonical spelling the shape table uses (plan.md §8 step 44b). Returning the
 * index through a bool keeps that single definition of "in range" shared between the read and
 * the write path. */
static bool index_of(jsrt_value index, uint32_t *out) {
  if (jsrt_is_number(index)) {
    const double d = jsrt_number_value(index);
    /* Check the upper bound BEFORE converting: a C floating-to-uint32 conversion outside the
     * representable range is undefined, while JavaScript simply treats that value as a named
     * (non-index) property. */
    if (!(d >= 0.0) || d >= 4294967296.0 || d != trunc(d)) {
      return false;
    }
    *out = (uint32_t)d;
    return true;
  }
  const char *key = jsrt_shape_key(jsrt_to_string(index));
  const bool ok = jsrt_key_is_array_index(key, out);
  free((void *)key);
  return ok;
}

jsrt_value jsrt_array_get(jsrt_value array, jsrt_value index) {
  if (!jsrt_is(array, JSRT_TAG_ARRAY)) {
    /* A lying receiver degrades to the dynamic read, so the static and dynamic index paths
     * agree by construction: nullish throws Node's reading-message, a primitive misses to
     * `undefined`, a fixed shape walks its descriptor. (A string answers `undefined` here where
     * Node answers the code unit -- the dynamic path's own gap, shared rather than doubled.) */
    return jsrt_get_prop(array, jsrt_shape_key(jsrt_to_string(index)), NULL);
  }
  const JSRTArray *a = jsrt_as_array(array);
  uint32_t i = 0;
  if (!index_of(index, &i) || i >= a->length) {
    return JSRT_UNDEFINED;
  }
  return jsrt_unhole(a->elements[i]);
}

/* The write both entry points share; `sparse` is whether the skipped indices of a write past the
 * end may become holes (docs/VALUE.md §4.4). */
static void array_store(jsrt_value array, jsrt_value index, jsrt_value element, bool sparse) {
  if (!jsrt_is(array, JSRT_TAG_ARRAY)) {
    /* Same degradation as the read: nullish throws Node's setting-message, a primitive throws
     * the dynamic write's TypeError, a fixed shape takes its existing-or-STA2004 path. */
    jsrt_set_prop(array, jsrt_shape_key(jsrt_to_string(index)), element, NULL);
    return;
  }
  JSRTArray *a = jsrt_as_array(array);
  uint32_t i = 0;
  if (!index_of(index, &i)) {
    /* A non-index key is a named property. The subset has no property table, so the store is
     * dropped rather than silently corrupting element storage. */
    return;
  }

  if (i > a->length && !sparse) {
    /* A write more than one past the end leaves the skipped indices ABSENT in ECMA-262, and a hole
     * reads as `undefined` -- which an array of a typed element must never hand out, so only the
     * sparse entry (an Unknown element type) may leave one (docs/VALUE.md §4.4). In-range writes
     * and the append idiom `a[a.length] = v` are unaffected. */
    jsrt_panic("STA2002: a write past the end of an array of a typed element would leave holes");
  }

  if (i >= a->capacity) {
    jsrt_array_grow(a, i);
  }

  for (uint32_t k = a->length; k < i; k++) {
    a->elements[k] = JSRT_HOLE;
  }
  a->elements[i] = element;
  if (i >= a->length) {
    a->length = i + 1;
  }
}

void jsrt_array_set(jsrt_value array, jsrt_value index, jsrt_value element) {
  array_store(array, index, element, false);
}

void jsrt_array_set_sparse(jsrt_value array, jsrt_value index, jsrt_value element) {
  array_store(array, index, element, true);
}

bool jsrt_array_delete(jsrt_value array, uint32_t index) {
  JSRTArray *a = jsrt_as_array(array);
  if (index < a->length) {
    a->elements[index] = JSRT_HOLE;
  }
  return true;
}

/* -------------------------------------------------------------- objects */

jsrt_value jsrt_object_get_field(jsrt_value obj, uint32_t slot, const char *field) {
  if (jsrt_is_nullish(obj)) {
    char message[256];
    (void)snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
                   obj == JSRT_NULL ? "null" : "undefined", field);
    jsrt_throw_error(&jsrt_class_type_error, message);
    return JSRT_UNDEFINED;
  }
  return jsrt_as_object(obj)->fields[slot];
}

void jsrt_object_set(jsrt_value obj, uint32_t slot, jsrt_value v) {
  JSRTObject *object = jsrt_as_object(obj);
  if (object->frozen) {
    /* The class knows the field names, so the fixed-shape path names the property just as the
     * dynamic one does (jsrt_shape.c store_prop) -- Node's exact wording. */
    char msg[256];
    snprintf(msg, sizeof msg, "Cannot assign to read only property '%s' of object '#<Object>'",
             slot < object->cls->field_count ? object->cls->fields[slot] : "?");
    jsrt_throw_error(&jsrt_class_type_error, msg);
    return;
  }
  object->fields[slot] = v;
}
