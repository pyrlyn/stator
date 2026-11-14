/* jsrt_error.c — the standard Error objects (plan.md §8 step 2a(c)).
 *
 * An Error needs no representation of its own. It is an OBJECT with a class descriptor, exactly as
 * a Map is: `cls` first, one descriptor per class in the whole program, and `parent` linking a
 * subclass to `Error`. That single link is what makes `e instanceof TypeError` and
 * `e instanceof Error` both true through the same pointer walk `jsrt_instanceof` already does for
 * user classes — there is no second mechanism here, only a descriptor chain the runtime owns
 * instead of the emitter.
 *
 * `name` and `message` are SLOTS rather than anything cleverer. That makes `e.name` and `e.message`
 * ordinary fixed-shape reads, resolved by the same `fixed_get` every other object uses, with no
 * special case anywhere in jsrt_shape.c. The cost is one honest divergence, recorded rather than
 * hidden: in Node both properties are non-enumerable, so `Object.keys(e)` is `[]` and here it is
 * `['name', 'message']`. Non-enumerability is a property-descriptor feature the subset does not
 * have at all (Object.defineProperty is a Phase 8 not-yet), so this is the same gap showing through
 * a new hole, not a new one. Printing an error is the other divergence and it is inherent: Node's
 * `console.log(err)` writes a stack trace, which this runtime does not have (see jsrt_uncaught).
 */

#include "jsrt.h"
#include "jsrt_value.h"

#include <stdio.h>
#include <string.h>

/* Shared by every error class: the layout is identical, so one field list serves all of them and
 * the slot indices below are true for any error whatever its class. */
static const char *const error_fields[] = {"name", "message"};

/* `parent` is the whole of the subclassing. Error is the root; each standard subclass points at it,
 * which is the prototype chain as far as `instanceof` — the only question asked of it — can see. */
const JSRTClass jsrt_class_error = {"Error", 2, error_fields, NULL, 0, NULL, NULL, NULL};
const JSRTClass jsrt_class_type_error = {"TypeError", 2, error_fields, &jsrt_class_error,
                                         0,           NULL,          NULL, NULL};
const JSRTClass jsrt_class_range_error = {"RangeError", 2, error_fields, &jsrt_class_error,
                                          0,            NULL,          NULL, NULL};
const JSRTClass jsrt_class_reference_error = {"ReferenceError", 2,    error_fields,
                                              &jsrt_class_error, 0, NULL, NULL, NULL};
const JSRTClass jsrt_class_syntax_error = {"SyntaxError", 2, error_fields, &jsrt_class_error,
                                           0,             NULL,          NULL, NULL};

/* The name -> descriptor map `jsrt_instanceof_builtin` needs. A linear walk over five entries: the
 * list is closed by the language, and a table would not be faster than five pointer compares. */
const JSRTClass *jsrt_error_class(const char *name) {
  static const JSRTClass *const all[] = {
      &jsrt_class_error,           &jsrt_class_type_error,   &jsrt_class_range_error,
      &jsrt_class_reference_error, &jsrt_class_syntax_error,
  };
  for (size_t i = 0; i < sizeof all / sizeof all[0]; i++) {
    if (strcmp(all[i]->name, name) == 0) {
      return all[i];
    }
  }
  return NULL;
}

/* Every intermediate lives in a rooted slot. A NaN-boxed local is INVISIBLE to the collector --
 * its high bits are the box's, so it is not a pointer by any conservative test -- which is what the
 * previous version of this function got wrong: the half-built Error sat in a C local while
 * jsrt_string_from_utf8 and jsrt_object_new allocated, and a collection under memory pressure left
 * `name`/`message` pointing at reclaimed strings (plan-notes 222).
 *
 * `message` is ToString'd here, because the slot it lands in is the string the HIR types as one:
 * §20.5.1.1 step 3 says `undefined` becomes the EMPTY string and everything else goes through
 * ToString, so `new Error(undefined).message.length` is 0 (it used to abort on the length
 * assertion) and `new Error(42).message` is "42" (it used to store the number in a string slot). */
jsrt_value jsrt_error_new(const JSRTClass *cls, jsrt_value message) {
  JSRT_FRAME(3);
  JSRT_LOCAL(0) = jsrt_string_from_utf8(cls->name, strlen(cls->name));
  JSRT_LOCAL(2) = message == JSRT_UNDEFINED ? jsrt_string_from_utf8("", 0) : jsrt_to_string(message);
  JSRT_LOCAL(1) = jsrt_object_new(cls);
  JSRTObject *object = jsrt_as_object(JSRT_LOCAL(1));
  object->fields[JSRT_ERROR_SLOT_NAME] = JSRT_LOCAL(0);
  object->fields[JSRT_ERROR_SLOT_MESSAGE] = JSRT_LOCAL(2);
  const jsrt_value error = JSRT_LOCAL(1);
  JSRT_FRAME_POP();
  return error;
}

void jsrt_throw_error(const JSRTClass *cls, const char *message) {
  jsrt_throw(jsrt_error_new(cls, jsrt_string_from_utf8(message, strlen(message))));
}

/* The answer to reading a name nothing declares. Node's wording is `<name> is not defined`, and the
 * class is the one the (b) sweep could not use until the model above existed: a ReferenceError the
 * program can CATCH, whose `name`/`message`/`instanceof` a golden can compare against Node.
 *
 * It returns `undefined` only so the emitter has a C value for an expression position -- control
 * never reaches the consumer, because the caller's `jsrt_pending()` check jumps to the landing pad
 * on the next line. The cap is the same 256 bytes every other message site here uses; a truncated
 * identifier is a worse message, never a wrong throw. */
jsrt_value jsrt_reference_error(const char *name) {
  char message[256];
  snprintf(message, sizeof message, "%s is not defined", name);
  jsrt_throw_error(&jsrt_class_reference_error, message);
  return JSRT_UNDEFINED;
}
