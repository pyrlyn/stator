/* print_promise.c — the promise corpus: print forms, reaction ordering, and Promise.all.
 *
 * Ground truth is Node (runtime/tests/print_promise.ts), which is the only reason this file can
 * assert anything about ORDER. Reaction ordering is the part of a promise implementation that is
 * easy to get subtly wrong -- one tick early or late -- and impossible to check against yourself.
 *
 * The two sides express "subscribe a reaction" differently on purpose: here it is a native
 * continuation, there it is `.then`. That is the same mechanism at both ends of Task 4.6's design
 * (a reaction is a C function plus state, and `.then` will become a client of it), and the whole
 * question this corpus asks is whether it ticks like the spec's.
 *
 * Everything is registered synchronously and the queue is drained ONCE at the end, which is what a
 * Node script does with its own microtask queue -- so the two programs have the same shape and the
 * diff is about ordering rather than about where each side chose to drain.
 */

#include "corpus.h"

#include <stdio.h>

/* A reaction that reports which subscription it was and how the promise settled. Numbers only:
 * `console.log('tag', v)` inspects its second argument where jsrt_print writes a top-level string
 * bare, and the corpus is about ordering, not about re-testing quoting. */
static void note(void *state, jsrt_value value, bool rejected) {
  printf("%s %s ", (const char *)state, rejected ? "rejected" : "fulfilled");
  jsrt_print(value);
}

/* Retires a rejection without reporting it: the drain aborts on a rejection nobody subscribed to
 * (STA2005), so a corpus that prints a rejected promise has to claim it, exactly as the .ts side
 * claims the same one with `.catch(() => {})`. Prints nothing, so it costs a tick and no output. */
static void ignore(void *state, jsrt_value value, bool rejected) {
  (void)state;
  (void)value;
  (void)rejected;
}

/* Chains a second reaction from inside the first, which is how a multi-tick chain is expressed
 * without `.then` -- and the thing that makes the interleaving below worth printing. */
static void relay(void *state, jsrt_value value, bool rejected) {
  (void)rejected;
  printf("%s relay ", (const char *)state);
  jsrt_print(value);
  jsrt_promise_subscribe(jsrt_promise_resolve(value), note, state);
}

int main(void) {
  jsrt_init();

  /* ------------------------------------------------------------ print forms */
  jsrt_print(jsrt_promise_new());
  jsrt_print(jsrt_promise_resolve(num(42)));
  jsrt_print(jsrt_promise_resolve(str("hi")));
  {
    jsrt_value boom = jsrt_promise_reject(str("boom"));
    jsrt_print(boom);
    jsrt_promise_subscribe(boom, ignore, NULL);
  }
  /* Promise.resolve of a promise is the SAME promise, so this prints the inner one's state. */
  jsrt_print(jsrt_promise_resolve(jsrt_promise_resolve(num(7))));
  printf("%s\n", jsrt_type_name(jsrt_promise_new()));

  /* An already-settled promise still QUEUES its reactions rather than running them inline. */
  {
    jsrt_value a = jsrt_promise_resolve(num(1));
    jsrt_promise_subscribe(a, note, (void *)"a1");
    jsrt_promise_subscribe(a, note, (void *)"a2");
  }

  /* A pending promise settled after its reaction is registered. */
  {
    jsrt_value b = jsrt_promise_new();
    jsrt_promise_subscribe(b, note, (void *)"b");
    jsrt_promise_settle(b, num(2), false);
  }

  /* Rejection reaches the same reaction with the flag set. */
  {
    jsrt_value c = jsrt_promise_new();
    jsrt_promise_subscribe(c, note, (void *)"c");
    jsrt_promise_settle(c, num(3), true);
  }

  /* Two ticks against one: `d` reports on the second tick, so it lands after every one-tick
   * reaction registered before it and before nothing that was not. */
  {
    jsrt_value d = jsrt_promise_resolve(num(4));
    jsrt_promise_subscribe(d, relay, (void *)"d");
  }

  printf("sync done\n");
  jsrt_run_microtasks();
  printf("drained\n");

  /* Settling twice is a no-op the second time, not an error. */
  {
    jsrt_value e = jsrt_promise_new();
    jsrt_promise_settle(e, num(5), false);
    jsrt_promise_settle(e, num(6), false);
    jsrt_print(e);
  }

  /* Fulfilling with a promise ADOPTS it: the outer promise stays pending until the inner settles. */
  {
    jsrt_value inner = jsrt_promise_new();
    jsrt_value outer = jsrt_promise_new();
    jsrt_promise_settle(outer, inner, false);
    jsrt_print(outer);
    jsrt_promise_settle(inner, num(8), false);
    jsrt_run_microtasks();
    jsrt_print(outer);
  }

  /* Promise.all: results in INPUT order however the elements settle, and a plain value counts as
   * an already-resolved one. */
  {
    jsrt_value slow = jsrt_promise_new();
    jsrt_value items[3] = {slow, jsrt_promise_resolve(num(20)), num(30)};
    jsrt_value all = jsrt_promise_all(jsrt_array_new(3, items));
    jsrt_promise_subscribe(all, note, (void *)"all");
    jsrt_print(all);
    jsrt_promise_settle(slow, num(10), false);
    jsrt_run_microtasks();
    jsrt_print(all);
  }

  /* An empty list settles with an empty array. */
  {
    jsrt_value all = jsrt_promise_all(jsrt_array_new(0, NULL));
    jsrt_promise_subscribe(all, note, (void *)"empty");
    jsrt_run_microtasks();
  }

  /* The first rejection wins and the later settles are ignored. */
  {
    jsrt_value bad = jsrt_promise_new();
    jsrt_value worse = jsrt_promise_new();
    jsrt_value items[2] = {bad, worse};
    jsrt_value all = jsrt_promise_all(jsrt_array_new(2, items));
    jsrt_promise_subscribe(all, note, (void *)"rejected-all");
    jsrt_promise_settle(bad, num(1), true);
    jsrt_promise_settle(worse, num(2), true);
    jsrt_run_microtasks();
    jsrt_print(all);
  }

  return 0;
}
