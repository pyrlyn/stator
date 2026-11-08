/* jsrt_interp.h — the interpreter's entry points for generated C (docs/INTERPRETER.md §3, §4).
 *
 * The definitions live in `libjsrt_interp.a` (packages/interpreter), which a program links only
 * when its HIR holds an `Interpret` node, and generated C includes this header only then. Errors
 * follow the runtime's protocol: the exception is left pending and the call answers a value the
 * caller checks with `jsrt_pending()`. */
#ifndef JSRT_INTERP_H
#define JSRT_INTERP_H

#include <stdbool.h>
#include <stdint.h>

#include "jsrt_value.h"

/* One binding a direct `eval` can see: its source name, the jsrt_value it lives in (a slot of a
 * JSRTEnv or a module global, so a closure the eval code makes can outlive the call), and whether
 * an assignment to it is a TypeError. */
typedef struct JSRTEvalBinding {
  const char *name;
  jsrt_value *cell;
  bool constant;
} JSRTEvalBinding;

/* A property of the interpreter's global object: `eval` and `Function` as values. */
jsrt_value jsrt_interp_global(const char *name);

/* A direct `eval(source)` from strict code: a non-string `source` is the result unchanged. The
 * eval code resolves a free name against `bindings` first, then the global object. */
jsrt_value jsrt_interp_eval_direct(jsrt_value source, jsrt_value this_value, uint32_t count,
                                   const JSRTEvalBinding *bindings);

#endif /* JSRT_INTERP_H */
