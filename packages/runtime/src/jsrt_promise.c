/* jsrt_promise.c — promises, the microtask queue, and the async-body driver (plan.md Task 4.6).
 *
 * The design decision that shapes this file: a reaction is a NATIVE continuation, a C function
 * plus GC-allocated state, not a JS callback. An async function's resume point and `Promise.all`'s
 * per-element handler are the same kind of thing, so both are served by one mechanism and neither
 * needs `.then` to exist. When `.then` lands it becomes a client of this — a reaction whose state
 * is the JS handler and the derived promise — rather than the thing everything else is built on.
 *
 * Ordering is the part that is easy to get wrong and observable when you do. Three rules carry
 * it: a reaction is always QUEUED and never called inline, even when the promise it subscribes
 * to has already settled; reactions run in registration order; and adoption costs a subscribe
 * job of its own, so resolving with an already-settled promise still ticks once before anything
 * is queued off it. Together they make `await` yield to the queue exactly once per await
 * regardless of whether the awaited value was ready, which is what makes an interleaving match
 * Node's rather than merely finishing with the same answer.
 *
 * The event loop is a drain and nothing more: `main` calls jsrt_run_microtasks() once after the
 * module body. There are no timers and no I/O, so there is no macrotask phase to run — plan.md is
 * explicit that libuv waits until something actually needs it.
 */

#include "jsrt.h"
#include "jsrt_value.h"

#include <stdio.h>

const JSRTClass jsrt_class_promise = {"Promise", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

static bool on_main(void) {
  jsrt_thread_require_main();
  return !jsrt_pending();
}

/* ------------------------------------------------------------ microtasks */

/* A queued reaction, with the value it will be handed. The value is captured at QUEUE time, not
 * read at run time: a promise cannot change once settled, but `Promise.all` settles a combined
 * promise from inside a reaction, and reading later would be one more thing to reason about. */
typedef struct Microtask {
  JSRTSettle on_settle;
  void *state;
  jsrt_value value;
  bool rejected;
  struct Microtask *next;
} Microtask;

/* Raw pointers in static storage, which the collector scans conservatively and correctly — unlike
 * a jsrt_value, which it cannot read at all (plan-notes 108). Everything reachable from the queue
 * is a collected allocation, so the whole pending graph stays alive through the head pointer. */
static Microtask *queue_first;
static Microtask *queue_last;

static void enqueue(JSRTSettle on_settle, void *state, jsrt_value value, bool rejected) {
  Microtask *task = (Microtask *)jsrt_gc_alloc(sizeof(Microtask), "microtask");
  task->on_settle = on_settle;
  task->state = state;
  task->value = value;
  task->rejected = rejected;
  task->next = NULL;
  if (queue_last == NULL) {
    queue_first = task;
  } else {
    queue_last->next = task;
  }
  queue_last = task;
}

/* Rejections nobody is listening to. Node reports one and exits nonzero; matching its report
 * byte-for-byte means an Error object with a stack, which this runtime does not build yet -- so
 * the drain aborts loudly with the STA2005 pattern instead of swallowing it, which is the one
 * outcome that would be silently wrong. Counted rather than listed: a rejection acquires a
 * handler by being subscribed to, and that is the only event that can clear one. */
static uint32_t unhandled_rejections;

void jsrt_run_microtasks(void) {
  while (queue_first != NULL || jsrt_thread_poll()) {
    if (jsrt_pending()) jsrt_uncaught();
    if (queue_first == NULL) continue;
    Microtask *task = queue_first;
    queue_first = task->next;
    if (queue_first == NULL) {
      queue_last = NULL;
    }
    /* Dropped from the queue BEFORE running, so a reaction that queues more work appends behind
     * the tasks already waiting rather than ahead of them. */
    task->on_settle(task->state, task->value, task->rejected);
    if (jsrt_pending()) {
      /* A throw that escaped a reaction has no enclosing scope left to catch it: the stack that
       * created this work is long gone. Node reports it and exits, and so does this. */
      jsrt_uncaught();
    }
  }
  /* Checked after the drain, not at the rejection: a promise rejected now is routinely awaited by
   * a continuation still sitting in the queue, and only an empty queue settles the question. */
  if (unhandled_rejections > 0) {
    jsrt_panic("STA2005: a promise was rejected with nothing awaiting it; the unhandled-rejection "
               "report is not yet supported");
  }
}

/* -------------------------------------------------------------- promises */

jsrt_value jsrt_promise_new(void) {
  if (!on_main()) return JSRT_UNDEFINED;
  JSRTPromise *p = (JSRTPromise *)jsrt_gc_alloc(sizeof(JSRTPromise), "promise");
  p->cls = &jsrt_class_promise;
  p->state = JSRT_PROMISE_PENDING;
  p->resolved = false;
  p->value = JSRT_UNDEFINED;
  p->first = NULL;
  p->last = NULL;
  p->unhandled = false;
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)p);
}

void jsrt_promise_subscribe(jsrt_value promise, JSRTSettle on_settle, void *state) {
  if (!on_main()) return;
  JSRTPromise *p = jsrt_as_promise(promise);
  if (p->state != JSRT_PROMISE_PENDING) {
    if (p->unhandled) {
      p->unhandled = false;
      unhandled_rejections--;
    }
    enqueue(on_settle, state, p->value, p->state == JSRT_PROMISE_REJECTED);
    return;
  }
  JSRTReaction *r = (JSRTReaction *)jsrt_gc_alloc(sizeof(JSRTReaction), "promise reaction");
  r->on_settle = on_settle;
  r->state = state;
  r->next = NULL;
  if (p->last == NULL) {
    p->first = r;
  } else {
    p->last->next = r;
  }
  p->last = r;
}

/* The state change itself, with no [[AlreadyResolved]] test: the caller has already decided that
 * this settlement is the one that counts. */
static void promise_settle_now(jsrt_value promise, jsrt_value value, bool rejected) {
  JSRTPromise *p = jsrt_as_promise(promise);
  p->state = rejected ? JSRT_PROMISE_REJECTED : JSRT_PROMISE_FULFILLED;
  p->value = value;
  if (rejected && p->first == NULL) {
    p->unhandled = true;
    unhandled_rejections++;
  }
  for (JSRTReaction *r = p->first; r != NULL; r = r->next) {
    enqueue(r->on_settle, r->state, value, rejected);
  }
  p->first = NULL;
  p->last = NULL;
}

/* Adoption: an outer promise fulfilled WITH a promise settles when the inner one does.
 * Registered as an ordinary reaction, so the outer promise's own [[AlreadyResolved]] stays
 * consumed by the resolve() call that adopted (this reaction IS that resolution completing)
 * and the state change goes straight through. */
static void adopt(void *state, jsrt_value value, bool rejected) {
  promise_settle_now((jsrt_value)(uintptr_t)state, value, rejected);
}

/* NewPromiseResolveThenableJob (§27.5.2.2): resolving with a promise enqueues a job that
 * SUBSCRIBES to it, rather than subscribing synchronously. Subscribing to an already-settled
 * promise queues its reaction immediately, so subscribing inline skips the thenable job and an
 * adoption chain runs one microtask ahead of Node (plan.md §8 step 35). The job is enqueued
 * even when the inner promise is still pending -- the spec does not condition on it, and the
 * queue position (ahead of every subscription that has not run yet) is observable. */
static void adopt_subscribe(void *state, jsrt_value value, bool rejected) {
  (void)rejected;
  jsrt_promise_subscribe(value, adopt, state);
}

void jsrt_promise_settle(jsrt_value promise, jsrt_value value, bool rejected) {
  if (!on_main()) return;
  JSRTPromise *p = jsrt_as_promise(promise);
  if (p->resolved) {
    return; /* already resolved: the resolving functions are idempotent, adoption included */
  }
  /* Both arguments are NaN-boxed. enqueue allocates the microtask before it stores them, and the
   * self-cycle path allocates a TypeError, so neither promise may live only in a parameter. */
  JSRT_FRAME(4);
  JSRT_LOCAL(0) = promise;
  JSRT_LOCAL(1) = value;
  p = jsrt_as_promise(JSRT_LOCAL(0));
  p->resolved = true;
  if (!rejected && jsrt_is_promise(JSRT_LOCAL(1))) {
    if (JSRT_LOCAL(0) == JSRT_LOCAL(1)) {
      const char *text = "Chaining cycle detected for promise";
      JSRT_LOCAL(2) = jsrt_string_from_utf8(text, strlen(text));
      JSRT_LOCAL(3) = jsrt_error_new(&jsrt_class_type_error, JSRT_LOCAL(2));
      promise_settle_now(JSRT_LOCAL(0), JSRT_LOCAL(3), true);
      JSRT_FRAME_POP();
      return;
    }
    enqueue(adopt_subscribe, (void *)(uintptr_t)JSRT_LOCAL(0), JSRT_LOCAL(1), false);
    JSRT_FRAME_POP();
    return;
  }
  promise_settle_now(JSRT_LOCAL(0), JSRT_LOCAL(1), rejected);
  JSRT_FRAME_POP();
}

jsrt_value jsrt_promise_resolve(jsrt_value v) {
  if (!on_main()) return JSRT_UNDEFINED;
  if (jsrt_is_promise(v)) {
    return v; /* §27.2.4.6: an already-promise passes through, same identity */
  }
  jsrt_value p = jsrt_promise_new();
  jsrt_promise_settle(p, v, false);
  return p;
}

jsrt_value jsrt_promise_reject(jsrt_value reason) {
  if (!on_main()) return JSRT_UNDEFINED;
  jsrt_value p = jsrt_promise_new();
  jsrt_promise_settle(p, reason, true);
  return p;
}

/* ------------------------------------------------------------ Promise.all */

typedef struct {
  jsrt_value results; /* the array handed to the combined promise, filled BY INDEX */
  jsrt_value promise;
  uint32_t remaining;
} AllState;

typedef struct {
  AllState *all;
  uint32_t index;
} AllElement;

static void all_element(void *state, jsrt_value value, bool rejected) {
  AllElement *e = (AllElement *)state;
  AllState *all = e->all;
  if (rejected) {
    /* First rejection wins and the rest are ignored — settle is idempotent, so the later ones
     * arrive and do nothing rather than needing a flag here. */
    jsrt_promise_settle(all->promise, value, true);
    return;
  }
  /* By index, never by arrival: `Promise.all` preserves the input order however the elements
   * happen to settle. The array was pre-filled to the right length for exactly this. */
  jsrt_array_set(all->results, jsrt_number((double)e->index), value);
  all->remaining--;
  if (all->remaining == 0) {
    jsrt_promise_settle(all->promise, all->results, false);
  }
}

jsrt_value jsrt_promise_all(jsrt_value array) {
  if (!on_main()) return JSRT_UNDEFINED;
  if (!jsrt_is(array, JSRT_TAG_ARRAY)) {
    jsrt_panic("STA2005: Promise.all over a non-array is not yet supported");
  }
  const uint32_t n = jsrt_as_array(array)->length;
  AllState *all = (AllState *)jsrt_gc_alloc(sizeof(AllState), "Promise.all");
  all->promise = jsrt_promise_new();
  all->remaining = n;
  all->results = jsrt_array_new(0, NULL);
  for (uint32_t i = 0; i < n; i++) {
    jsrt_array_set(all->results, jsrt_number((double)i), JSRT_UNDEFINED);
  }
  if (n == 0) {
    /* An empty list is already done, and settles on this tick rather than never. */
    jsrt_promise_settle(all->promise, all->results, false);
    return all->promise;
  }
  for (uint32_t i = 0; i < n; i++) {
    AllElement *e = (AllElement *)jsrt_gc_alloc(sizeof(AllElement), "Promise.all element");
    e->all = all;
    e->index = i;
    jsrt_promise_subscribe(jsrt_promise_resolve(jsrt_unhole(jsrt_as_array(array)->elements[i])), all_element, e);
  }
  return all->promise;
}

/* ---------------------------------------------------------- async bodies */

static void async_resume(void *state, jsrt_value value, bool rejected) {
  JSRTAsync *self = (JSRTAsync *)state;
  self->resume(self, value, rejected);
}

jsrt_value jsrt_async_start(JSRTEnv *env, JSRTResume resume) {
  if (!on_main()) return JSRT_UNDEFINED;
  JSRTAsync *self = (JSRTAsync *)jsrt_gc_alloc(sizeof(JSRTAsync), "async frame");
  self->env = env;
  self->resume = resume;
  self->promise = jsrt_promise_new();
  self->state = 0;
  /* The prefix runs NOW, on the caller's stack: an async function's body up to its first await is
   * synchronous, which is observable and is the difference between an async function and a
   * callback. */
  resume(self, JSRT_UNDEFINED, false);
  return self->promise;
}

void jsrt_await(JSRTAsync *self, jsrt_value awaited) {
  jsrt_promise_subscribe(jsrt_promise_resolve(awaited), async_resume, self);
}

void jsrt_async_return(JSRTAsync *self, jsrt_value value) {
  jsrt_promise_settle(self->promise, value, false);
}

void jsrt_async_throw(JSRTAsync *self, jsrt_value reason) {
  jsrt_promise_settle(self->promise, reason, true);
}


/* ------------------------------------------------ Promise.prototype / new Promise */

typedef struct {
  jsrt_value derived;
  jsrt_value on_fulfilled;
  jsrt_value on_rejected;
} ThenState;

static void then_react(void *state, jsrt_value value, bool rejected) {
  ThenState *s = (ThenState *)state;
  jsrt_value handler = rejected ? s->on_rejected : s->on_fulfilled;
  if (!jsrt_is(handler, JSRT_TAG_CLOSURE)) {
    jsrt_promise_settle(s->derived, value, rejected);
    return;
  }
  jsrt_value args[1] = {value};
  JSRTCompletion done = jsrt_call_protected(handler, 1, args);
  if (done.threw) {
    jsrt_promise_settle(s->derived, done.value, true);
    return;
  }
  jsrt_promise_settle(s->derived, done.value, false);
}

jsrt_value jsrt_promise_then(jsrt_value promise, jsrt_value on_fulfilled, jsrt_value on_rejected) {
  if (!on_main()) return JSRT_UNDEFINED;
  ThenState *s = (ThenState *)jsrt_gc_alloc(sizeof(ThenState), "Promise.then");
  s->derived = jsrt_promise_new();
  s->on_fulfilled = on_fulfilled;
  s->on_rejected = on_rejected;
  jsrt_promise_subscribe(promise, then_react, s);
  return s->derived;
}

jsrt_value jsrt_promise_catch(jsrt_value promise, jsrt_value on_rejected) {
  if (!on_main()) return JSRT_UNDEFINED;
  return jsrt_promise_then(promise, JSRT_UNDEFINED, on_rejected);
}

typedef struct {
  jsrt_value derived;
  jsrt_value on_finally;
  jsrt_value value;
  bool rejected;
} FinallyState;

/* The `valueThunk`/`thrower` half of the spec's pass-through wrapper (§27.5.5.3): `thenFinally`
 * answers `p.then(valueThunk)`, and the outer reaction adopts that intermediate -- it is the
 * intermediate this settles, never the derived promise directly. On the callback promise's
 * fulfilment the ORIGINAL settlement passes through untouched; on its rejection the callback's
 * reason wins and the original is dropped. Skipping the wrapper settles the derived promise in
 * the reaction itself, so a `.finally().then()` chain runs two microtasks ahead of Node. */
static void finally_thunk(void *state, jsrt_value value, bool rejected) {
  FinallyState *s = (FinallyState *)state;
  if (rejected) {
    jsrt_promise_settle(s->derived, value, true);
    return;
  }
  jsrt_promise_settle(s->derived, s->value, s->rejected);
}

static void finally_react(void *state, jsrt_value value, bool rejected) {
  FinallyState *s = (FinallyState *)state;
  s->value = value;
  s->rejected = rejected;
  if (!jsrt_is(s->on_finally, JSRT_TAG_CLOSURE)) {
    jsrt_promise_settle(s->derived, value, rejected);
    return;
  }
  JSRTCompletion done = jsrt_call_protected(s->on_finally, 0, NULL);
  if (done.threw) {
    jsrt_promise_settle(s->derived, done.value, true);
    return;
  }
  FinallyState *inner = (FinallyState *)jsrt_gc_alloc(sizeof(FinallyState), "Promise.finally");
  inner->derived = jsrt_promise_new();
  inner->on_finally = JSRT_UNDEFINED;
  inner->value = value;
  inner->rejected = rejected;
  /* Adopt the intermediate BEFORE subscribing the thunk: the adoption job then runs first and
   * finds it pending (a plain registration, no tick of its own), so settling it queues the
   * reaction -- and a rejection never sits unobserved between the two jobs. */
  jsrt_promise_settle(s->derived, inner->derived, false);
  jsrt_promise_subscribe(jsrt_promise_resolve(done.value), finally_thunk, inner);
}

jsrt_value jsrt_promise_finally(jsrt_value promise, jsrt_value on_finally) {
  if (!on_main()) return JSRT_UNDEFINED;
  FinallyState *s = (FinallyState *)jsrt_gc_alloc(sizeof(FinallyState), "Promise.finally");
  s->derived = jsrt_promise_new();
  s->on_finally = on_finally;
  s->value = JSRT_UNDEFINED;
  s->rejected = false;
  jsrt_promise_subscribe(promise, finally_react, s);
  return s->derived;
}

static jsrt_value promise_resolve_fn(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  jsrt_promise_settle(env->slots[0], argc > 0 ? argv[0] : JSRT_UNDEFINED, false);
  return JSRT_UNDEFINED;
}

static jsrt_value promise_reject_fn(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  jsrt_promise_settle(env->slots[0], argc > 0 ? argv[0] : JSRT_UNDEFINED, true);
  return JSRT_UNDEFINED;
}

jsrt_value jsrt_promise_construct(jsrt_value executor) {
  if (!on_main()) return JSRT_UNDEFINED;
  /* Rooted: jsrt_env_new and the two jsrt_closure_new calls below all allocate, and the promise
   * the executor resolves is otherwise reachable from nothing (plan-notes 222). The resolver pair
   * is reachable through `env`, which the first closure is handed and the second is not -- so the
   * ARRAY of arguments is rooted too. */
  JSRT_FRAME(3);
  JSRT_LOCAL(0) = jsrt_promise_new();
  if (!jsrt_is(executor, JSRT_TAG_CLOSURE)) {
    jsrt_throw_error(&jsrt_class_type_error, "Promise resolver is not a function");
    JSRT_FRAME_POP();
    return JSRT_UNDEFINED;
  }
  JSRTEnv *env = jsrt_env_new(NULL, 1);
  env->slots[0] = JSRT_LOCAL(0);
  JSRT_LOCAL(1) = jsrt_closure_new(promise_resolve_fn, 1, "", env, false);
  JSRT_LOCAL(2) = jsrt_closure_new(promise_reject_fn, 1, "", env, false);
  jsrt_value args[2] = {JSRT_LOCAL(1), JSRT_LOCAL(2)};
  JSRTCompletion done = jsrt_call_protected(executor, 2, args);
  if (done.threw) {
    jsrt_promise_settle(JSRT_LOCAL(0), done.value, true);
  }
  const jsrt_value promise = JSRT_LOCAL(0);
  JSRT_FRAME_POP();
  return promise;
}
