/* jsrt_iterator.c — boxed specialized iterators (docs/VALUE.md §4.13).
 *
 * `arr.keys()` and the Map/Set triples allocate one of these when the call is stored
 * (`const it = arr.keys()`). The for-of operand form is inlined by the emitter and never
 * reaches here. The object is a cursor plus a kind tag, not a `next` closure: compiled
 * `it.next()` is `jsrt_iterator_next`, and for-of over a stored iterator is
 * `jsrt_iterator_step`.
 *
 * Map/Set kinds bump `iterating` for the box's life so compaction cannot renumber the
 * cursor between `next` calls. Exhaustion (the first time step fails) drops the count;
 * an abandoned iterator leaves it held, which only suppresses compaction.
 */

#include "jsrt.h"
#include "jsrt_value.h"

#include <stdint.h>

const JSRTClass jsrt_class_iterator = {"Iterator", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

static const uint32_t ITER_DONE = UINT32_MAX;

static jsrt_value iterator_result(jsrt_value value, bool done) {
  /* A nameless dynamic object, so `console.log` prints `{ value: …, done: … }` the way Node
   * prints IteratorResult — not `Iterator { … }`. Insertion order is the spec's field order. */
  jsrt_value o = jsrt_dynobj_new();
  jsrt_set_prop(o, "value", value, NULL);
  jsrt_set_prop(o, "done", jsrt_bool(done), NULL);
  return o;
}

static bool is_map_kind(uint8_t kind) {
  return kind >= JSRT_ITER_MAP_KEYS && kind <= JSRT_ITER_SET_ENTRIES;
}

static jsrt_value make_iter(jsrt_value target, jsrt_value extra, uint8_t kind) {
  JSRTIterator *it = (JSRTIterator *)jsrt_gc_alloc(sizeof(JSRTIterator), "iterator");
  it->cls = &jsrt_class_iterator;
  it->target = target;
  it->extra = extra;
  it->index = 0;
  it->kind = kind;
  if (is_map_kind(kind)) {
    jsrt_map_iter_begin(target);
  }
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)it);
}

jsrt_value jsrt_iterator_new(jsrt_value target, uint8_t kind) {
  /* A stored `arr.values()` on a lying receiver must throw at construction, not segfault at the
   * first step: `array_step` unboxes the target unchecked (plan.md §8 step 20, STA2008). Only
   * the array kinds; every other kind has its own walk and its own step. */
  if (kind == JSRT_ITER_ARRAY_KEYS || kind == JSRT_ITER_ARRAY_VALUES ||
      kind == JSRT_ITER_ARRAY_ENTRIES) {
    const char *method =
        kind == JSRT_ITER_ARRAY_KEYS ? "keys" : kind == JSRT_ITER_ARRAY_VALUES ? "values" : "entries";
    if (jsrt_require_array(target, method) == NULL) {
      return JSRT_UNDEFINED;
    }
  }
  return make_iter(target, JSRT_UNDEFINED, kind);
}

jsrt_value jsrt_iterator_match_all_new(jsrt_value str, jsrt_value matcher) {
  return make_iter(str, matcher, JSRT_ITER_MATCH_ALL);
}

static JSRTIterator *as_iter(jsrt_value v) { return (JSRTIterator *)jsrt_ptr(v); }

static bool is_iterator(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && jsrt_as_object(v)->cls == &jsrt_class_iterator;
}

static bool array_step(JSRTIterator *it, jsrt_value *out) {
  const JSRTArray *a = jsrt_as_array(it->target);
  if (it->index >= a->length) {
    return false;
  }
  const uint32_t i = it->index++;
  switch (it->kind) {
    case JSRT_ITER_ARRAY_KEYS:
      *out = jsrt_number((double)i);
      return true;
    case JSRT_ITER_ARRAY_VALUES:
      *out = jsrt_unhole(a->elements[i]);
      return true;
    case JSRT_ITER_ARRAY_ENTRIES: {
      jsrt_value items[2] = {jsrt_number((double)i), jsrt_unhole(a->elements[i])};
      *out = jsrt_array_new(2, items);
      return true;
    }
    default:
      jsrt_panic("STA4000: iterator kind is not an array walk");
  }
}

static bool map_step(JSRTIterator *it, jsrt_value *out) {
  jsrt_value key;
  jsrt_value value;
  if (!jsrt_map_iter_step(it->target, &it->index, &key, &value)) {
    return false;
  }
  switch (it->kind) {
    case JSRT_ITER_MAP_KEYS:
    case JSRT_ITER_SET_KEYS:
    case JSRT_ITER_SET_VALUES:
      *out = key;
      return true;
    case JSRT_ITER_MAP_VALUES:
      *out = value;
      return true;
    case JSRT_ITER_MAP_ENTRIES: {
      jsrt_value items[2] = {key, value};
      *out = jsrt_array_new(2, items);
      return true;
    }
    case JSRT_ITER_SET_ENTRIES: {
      jsrt_value items[2] = {key, key};
      *out = jsrt_array_new(2, items);
      return true;
    }
    default:
      jsrt_panic("STA4000: iterator kind is not a Map/Set walk");
  }
}

/* The string code-point walk, boxed: `index` is the code-unit cursor jsrt_string_iter_next
 * advances by 1 or 2, exactly the loop the sync emitter inlines. */
static bool string_step(JSRTIterator *it, jsrt_value *out) {
  if (it->index >= jsrt_string_length(it->target)) {
    return false;
  }
  *out = jsrt_string_iter_next(it->target, &it->index);
  return true;
}

/* The Uint8Array element walk: the length is re-read every step, through the view's own
 * accessor, so the cursor never indexes past the bytes. */
static bool uint8array_step(JSRTIterator *it, jsrt_value *out) {
  if (it->index >= jsrt_number_value(jsrt_uint8array_length(it->target))) {
    return false;
  }
  *out = jsrt_uint8array_get(it->target, jsrt_number((double)it->index++));
  return true;
}

const JSRTClass jsrt_class_generator = {"Generator", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

jsrt_value jsrt_generator_new(JSRTEnv *env, JSRTGenResume resume) {
  JSRTGenerator *g = (JSRTGenerator *)jsrt_gc_alloc(sizeof(JSRTGenerator), "generator");
  g->cls = &jsrt_class_generator;
  g->env = env;
  g->resume = resume;
  g->state = 0;
  g->yielded = JSRT_UNDEFINED;
  g->done = false;
  g->inject = JSRT_GEN_INJECT_NONE;
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)g);
}

void jsrt_generator_yield(JSRTGenerator *self, jsrt_value value) { self->yielded = value; }

void jsrt_generator_return(JSRTGenerator *self, jsrt_value value) {
  self->yielded = value;
  self->done = true;
}

static JSRTGenerator *as_gen(jsrt_value v) { return (JSRTGenerator *)jsrt_ptr(v); }

/* Shared by Generator.prototype.return/throw. `inject` is what the generated resume prologue
 * reads at the parked label: RETURN becomes a synthetic `return value` routed through the
 * finally blocks, THROW rethrows `value` at the yield's own landing pad. A throw the body does
 * not catch leaves the exception pending and the generator done, so the call site unwinds and a
 * later `next()` answers done. */
static jsrt_value generator_inject(jsrt_value gen, jsrt_value value, uint8_t inject) {
  if (!jsrt_is_generator(gen)) {
    jsrt_throw_error(&jsrt_class_type_error, "Generator method called on incompatible receiver");
    return JSRT_UNDEFINED;
  }
  JSRTGenerator *g = as_gen(gen);
  /* GeneratorResumeAbrupt (ECMA-262 27.5.1.3): suspendedStart and completed share one answer,
   * and neither enters the body -- `return(v)` answers `{ value: v, done: true }` and `throw(e)`
   * rethrows `e` to the caller. A completed generator's `return` answers the NEW value, not the
   * one it completed with. */
  if (g->done || g->state == 0) {
    g->done = true;
    if (inject == JSRT_GEN_INJECT_RETURN) {
      return iterator_result(value, true);
    }
    jsrt_throw(value);
    return JSRT_UNDEFINED;
  }
  g->inject = inject;
  g->resume(g, value);
  if (jsrt_pending()) {
    return JSRT_UNDEFINED;
  }
  return iterator_result(g->yielded, g->done);
}

jsrt_value jsrt_generator_close(jsrt_value gen, jsrt_value value) {
  return generator_inject(gen, value, JSRT_GEN_INJECT_RETURN);
}

jsrt_value jsrt_generator_throw(jsrt_value gen, jsrt_value value) {
  return generator_inject(gen, value, JSRT_GEN_INJECT_THROW);
}

static jsrt_value generator_next(jsrt_value gen, jsrt_value sent) {
  JSRTGenerator *g = as_gen(gen);
  if (g->done) {
    return iterator_result(JSRT_UNDEFINED, true);
  }
  g->resume(g, sent);
  if (jsrt_pending()) {
    return JSRT_UNDEFINED;
  }
  return iterator_result(g->yielded, g->done);
}

static bool generator_step(jsrt_value gen, jsrt_value sent, jsrt_value *out) {
  JSRTGenerator *g = as_gen(gen);
  if (g->done) {
    return false;
  }
  g->resume(g, sent);
  if (jsrt_pending()) {
    return false;
  }
  if (g->done) {
    return false;
  }
  *out = g->yielded;
  return true;
}

jsrt_value jsrt_get_iterator(jsrt_value value) {
  if (jsrt_is_generator(value) || is_iterator(value)) {
    return value;
  }
  if (jsrt_is(value, JSRT_TAG_ARRAY)) {
    return jsrt_iterator_new(value, JSRT_ITER_ARRAY_VALUES);
  }
  if (jsrt_is(value, JSRT_TAG_STRING)) {
    return jsrt_iterator_new(value, JSRT_ITER_STRING);
  }
  if (jsrt_is(value, JSRT_TAG_OBJECT)) {
    const JSRTClass *cls = jsrt_as_object(value)->cls;
    /* The builtin iterables, each with its default walk (a Map yields entries, a Set values). */
    const int walk = cls == &jsrt_class_map          ? JSRT_ITER_MAP_ENTRIES
                     : cls == &jsrt_class_set        ? JSRT_ITER_SET_VALUES
                     : cls == &jsrt_class_uint8array ? JSRT_ITER_UINT8ARRAY
                                                     : -1;
    if (walk >= 0) {
      return jsrt_iterator_new(value, (uint8_t)walk);
    }
    /* A user iterable: the method the frontend names `__@iterator`, resolved the way any
     * dynamic method call resolves it (fixed method table or shape table alike). It must be
     * a closure -- anything else is the non-iterable below, not a call through a garbage
     * pointer -- and `jsrt_call` passes the receiver itself, since the method declares one. */
    jsrt_value method = jsrt_get_prop(value, "__@iterator", NULL);
    if (jsrt_pending()) {
      return JSRT_UNDEFINED;
    }
    if (!jsrt_is(method, JSRT_TAG_CLOSURE)) {
      jsrt_throw_not_iterable(value);
      return JSRT_UNDEFINED;
    }
    jsrt_value iterator = jsrt_call_method_at(method, 1, &value, NULL);
    if (jsrt_pending()) {
      return JSRT_UNDEFINED;
    }
    if (!jsrt_is_generator(iterator) && !is_iterator(iterator)) {
      jsrt_throw_error(&jsrt_class_type_error,
                       "Result of the Symbol.iterator method is not an object");
      return JSRT_UNDEFINED;
    }
    return iterator;
  }
  jsrt_throw_not_iterable(value);
  return JSRT_UNDEFINED;
}

bool jsrt_iterator_step(jsrt_value itv, jsrt_value *out) {
  if (jsrt_is_generator(itv)) {
    return generator_step(itv, JSRT_UNDEFINED, out);
  }
  if (!is_iterator(itv)) {
    jsrt_throw_error(&jsrt_class_type_error, "Iterator method called on incompatible receiver");
    return false;
  }
  JSRTIterator *it = as_iter(itv);
  if (it->index == ITER_DONE) {
    return false;
  }
  bool more;
  if (it->kind == JSRT_ITER_MATCH_ALL) {
    more = jsrt_regexp_match_all_step(it->extra, it->target, out);
  } else if (it->kind == JSRT_ITER_STRING) {
    more = string_step(it, out);
  } else if (it->kind == JSRT_ITER_UINT8ARRAY) {
    more = uint8array_step(it, out);
  } else {
    more = is_map_kind(it->kind) ? map_step(it, out) : array_step(it, out);
  }
  if (!more) {
    if (is_map_kind(it->kind)) {
      jsrt_map_iter_end(it->target);
    }
    it->index = ITER_DONE;
  }
  return more;
}

jsrt_value jsrt_iterator_next(jsrt_value itv, jsrt_value sent) {
  if (jsrt_is_generator(itv)) {
    return generator_next(itv, sent);
  }
  (void)sent;
  jsrt_value value;
  if (!jsrt_iterator_step(itv, &value)) {
    if (jsrt_pending()) {
      return JSRT_UNDEFINED;
    }
    return iterator_result(JSRT_UNDEFINED, true);
  }
  return iterator_result(value, false);
}

/* IteratorClose for `for...of` (plan.md §8 step 34). The emitter routes every abrupt exit
 * from a boxed loop — `break`/`return` out, a throw, a throwing step — through its fin,
 * which calls this; `continue` and the step's own exhaustion never reach here.
 *
 * Only a generator has anything to run: the close resumes it with a RETURN injection, so
 * the `finally` blocks between the parked yield and the top run exactly as a `gen.return()`
 * call would run them. Every other box is a built-in iterator, and built-in iterators define
 * no `return()` method — breaking out of a stored `arr.values()` and calling `next()` keeps
 * yielding where it left off, so the close is deliberately a no-op for them (marking the box
 * done would be the observable divergence). A close that throws (a throwing `finally`)
 * leaves it pending for the fin, which gives the original exception precedence on the throw
 * path, per ECMA-262 IteratorClose step 4. */
void jsrt_iterator_close(jsrt_value itv) {
  if (!jsrt_is_generator(itv)) {
    return;
  }
  const JSRTGenerator *g = as_gen(itv);
  /* generator_inject answers without entering the body for these two states, so calling it
   * would only allocate the `{ value, done }` result to discard it. */
  if (!g->done && g->state != 0) {
    jsrt_generator_close(itv, JSRT_UNDEFINED);
  }
}
