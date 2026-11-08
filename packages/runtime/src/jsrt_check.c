/* jsrt_check.c — `typeof`, and the boundary checks that make a type annotation true.
 *
 * These two live together because they are the same question asked for two purposes. `typeof` asks
 * a value what it is and hands the answer to the program; a boundary check asks the same question
 * and compares the answer to what the program already claimed, refusing to continue if the claim
 * was a lie. The second is why golden rule 4 is enforceable: TypeScript's types are unsound, so an
 * `unknown` that narrows to `string` has been ASSERTED to be a string, not proven to be one, and
 * the check is where the assertion is settled (plan.md §0.2, docs/DIAGNOSTICS.md STA2001).
 */

#include "jsrt_value.h"

#include "jsrt.h"

#include <stdio.h>
#include <string.h>

const char *jsrt_type_name(jsrt_value v) {
  /* A double is any number that is not boxed as an int32, INCLUDING NaN -- the NaN-boxing scheme
   * reserves the quiet-NaN space for tagged values, so a real NaN reaches here as a double and
   * answers "number", which is what the language says. */
  if (jsrt_is_double(v)) {
    return "number";
  }
  switch (jsrt_tag(v)) {
    case JSRT_TAG_UNDEFINED:
      return "undefined";
    /* `typeof null === "object"` is the 1995 bug that shipped and then became normative. It is
     * asserted here rather than derived, because every structural route to it gives "null". */
    case JSRT_TAG_NULL:
      return "object";
    case JSRT_TAG_BOOL:
      return "boolean";
    case JSRT_TAG_INT32:
      return "number";
    case JSRT_TAG_STRING:
      return "string";
    /* A closure is an object to jsrt_is_object and to every operation in this runtime; `typeof`
     * is the one place the language separates callable from not. */
    case JSRT_TAG_CLOSURE:
      return "function";
    default:
      return "object";
  }
}

jsrt_value jsrt_typeof(jsrt_value v) {
  const char *name = jsrt_type_name(v);
  return jsrt_string_from_utf8(name, strlen(name));
}

/* One failure path for every check: the diagnostic is one code (STA2001) because the consequence
 * is one thing -- the program's type is not the value's type, and nothing after this point is
 * sound. Aborting rather than returning an error value is deliberate: a boundary check that could
 * be ignored would be a suggestion, and the whole point is that the compiled code downstream is
 * allowed to trust the type completely. */
_Noreturn static void check_failed(jsrt_value v, const char *expected, const char *where) {
  char message[256];
  snprintf(message, sizeof message, "STA2001: boundary check failed at %s — expected %s, got %s",
           where, expected, jsrt_type_name(v));
  jsrt_panic(message);
}

/* `v` when `ok`, the failure path otherwise: the shape of every primitive check below. */
static jsrt_value checked(bool ok, jsrt_value v, const char *expected, const char *where) {
  if (!ok) {
    check_failed(v, expected, where);
  }
  return v;
}

jsrt_value jsrt_check_number(jsrt_value v, const char *where) {
  return checked(jsrt_is_number(v), v, "number", where);
}

jsrt_value jsrt_check_string(jsrt_value v, const char *where) {
  return checked(jsrt_is(v, JSRT_TAG_STRING), v, "string", where);
}

jsrt_value jsrt_check_boolean(jsrt_value v, const char *where) {
  return checked(jsrt_is(v, JSRT_TAG_BOOL), v, "boolean", where);
}

jsrt_value jsrt_check_uint8array(jsrt_value v, const char *where) {
  return checked(jsrt_is_uint8array(v), v, "Uint8Array", where);
}
