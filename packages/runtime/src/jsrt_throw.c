/* jsrt_throw.c — the pending-exception cell (plan.md §6 Task 3.10).
 *
 * The state is deliberately this small: one value, one flag, per thread. Everything interesting
 * about exceptions — which catch receives one, in what order the finally blocks run, how a frame
 * is popped on the way out — is a property of the GENERATED C, decided by the emitter where the
 * scope structure is known, not of the runtime, which cannot see scopes at all. The runtime's
 * whole contribution is a mailbox the unwind protocol reads; the protocol itself is documented
 * at the declarations in jsrt_value.h.
 */

#include "jsrt_value.h"

#include <string.h>

_Thread_local static jsrt_value pending_value;
_Thread_local static bool pending_flag;

void jsrt_throw(jsrt_value v) {
  /* Overwriting an already-pending exception is legal and REQUIRED: a throw inside a finally
   * replaces the completion that got the finally running, which is JavaScript's rule, and the
   * generated code relies on the newest throw winning. */
  pending_value = v;
  pending_flag = true;
}

/* The pending exception is a ROOT, and the only one outside the shadow stack. A boxed value in
 * static storage is as invisible to the collector as one in the heap (plan-notes 108), and this
 * cell is by definition the last reference to what it holds: the scope that threw has been left,
 * and a `finally` running on the way out allocates freely. Published here rather than reached
 * from jsrt_gc.zig directly so that the cell stays private to the mailbox that owns it. */
jsrt_value *jsrt_pending_slot(void) {
  return &pending_value;
}

bool jsrt_pending(void) {
  return pending_flag;
}

jsrt_value jsrt_take_exception(void) {
  /* Clear the cell as well as the flag: a taken exception the cell kept alive would be a leak
   * under a real collector, invisible under this one. */
  jsrt_value v = jsrt_gc_handoff(pending_value);
  pending_value = JSRT_UNDEFINED;
  pending_flag = false;
  return v;
}

void jsrt_throw_str(const char *msg) {
  jsrt_throw(jsrt_string_from_utf8(msg, strlen(msg)));
}

JSRTCompletion jsrt_call_protected(jsrt_value callee, uint32_t argc, const jsrt_value *argv) {
  JSRTCompletion done;
  if (!jsrt_is(callee, JSRT_TAG_CLOSURE)) {
    done.value = jsrt_error_new(&jsrt_class_type_error,
                                jsrt_string_from_utf8("callee is not a function",
                                                      strlen("callee is not a function")));
    done.threw = true;
    return done;
  }
  done.value = jsrt_call(callee, argc, argv);
  if (jsrt_pending()) {
    done.value = jsrt_take_exception();
    done.threw = true;
    return done;
  }
  done.threw = false;
  return done;
}
