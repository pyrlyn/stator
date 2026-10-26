/* jsrt_value.h — the codegen<->runtime value contract.
 *
 * This header MIRRORS docs/VALUE.md. Where they disagree, the document is right and this file
 * is a bug. Read the document before changing anything here: every macro below is load-bearing
 * for generated C, and several encode a correctness trap (NaN canonicalization, -0.0 survival,
 * frame/pop balance) that is invisible from the code alone.
 */
#ifndef JSRT_VALUE_H
#define JSRT_VALUE_H

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* ---------------------------------------------------------------- layout */

typedef uint64_t jsrt_value;

/* Top 13 bits: sign + exponent + quiet. The sign bit is deliberately part of the mask, so only
 * NEGATIVE quiet NaNs are tags and the whole positive-NaN space stays available to doubles. */
#define JSRT_NANBOX_MASK UINT64_C(0xFFF8000000000000)
#define JSRT_PAYLOAD_MASK UINT64_C(0x0000FFFFFFFFFFFF)
#define JSRT_TAG_SHIFT 48

#define JSRT_TAG_UNDEFINED 0
#define JSRT_TAG_NULL 1
#define JSRT_TAG_BOOL 2
#define JSRT_TAG_INT32 3
#define JSRT_TAG_OBJECT 4
#define JSRT_TAG_STRING 5
#define JSRT_TAG_ARRAY 6
#define JSRT_TAG_CLOSURE 7

#define JSRT_BOX(tag, payload)                       \
  (JSRT_NANBOX_MASK | ((uint64_t)(tag) << JSRT_TAG_SHIFT) | \
   ((uint64_t)(payload) & JSRT_PAYLOAD_MASK))

#define JSRT_UNDEFINED JSRT_BOX(JSRT_TAG_UNDEFINED, 0)
#define JSRT_NULL JSRT_BOX(JSRT_TAG_NULL, 0)
#define JSRT_TRUE JSRT_BOX(JSRT_TAG_BOOL, 1)
#define JSRT_FALSE JSRT_BOX(JSRT_TAG_BOOL, 0)

/* The one NaN any double is allowed to have once boxed. See jsrt_number(). */
#define JSRT_CANONICAL_NAN UINT64_C(0x7FF8000000000000)

static inline bool jsrt_is_double(jsrt_value v) {
  return (v & JSRT_NANBOX_MASK) != JSRT_NANBOX_MASK;
}

static inline uint8_t jsrt_tag(jsrt_value v) {
  return (uint8_t)((v >> JSRT_TAG_SHIFT) & 0x7u);
}

static inline bool jsrt_is(jsrt_value v, uint8_t tag) {
  return !jsrt_is_double(v) && jsrt_tag(v) == tag;
}

/* ------------------------------------------------------------ conversions */

/* The ONLY sanctioned way to get a double into a jsrt_value. Generated C never bit-casts.
 *
 * x86-64's default NaN from 0.0/0.0 is 0xFFF8000000000000 -- bit-identical to JSRT_UNDEFINED.
 * An un-canonicalized arithmetic NaN would therefore silently BECOME undefined. ECMAScript
 * exposes only one NaN, so collapsing them all to the positive quiet NaN is unobservable. */
static inline jsrt_value jsrt_number(double d) {
  jsrt_value v;
  memcpy(&v, &d, sizeof v); /* memcpy is the only strict-aliasing-safe pun; compiles to a move */
  return jsrt_is_double(v) ? v : JSRT_CANONICAL_NAN;
}

static inline double jsrt_to_double(jsrt_value v) {
  double d;
  memcpy(&d, &v, sizeof d);
  return d;
}

static inline jsrt_value jsrt_bool(bool b) { return b ? JSRT_TRUE : JSRT_FALSE; }

static inline bool jsrt_as_bool(jsrt_value v) { return (v & 1u) != 0u; }

static inline int32_t jsrt_as_int32(jsrt_value v) {
  return (int32_t)(uint32_t)(v & UINT64_C(0xFFFFFFFF));
}

static inline void *jsrt_ptr(jsrt_value v) {
  return (void *)(uintptr_t)(v & JSRT_PAYLOAD_MASK);
}

/* Phase 2 never calls this -- the walking skeleton keeps every number an f64 (plan.md §5), and
 * the i32 fast path arrives with NUMERIC.md in Phase 3. It is defined now because the -0.0 rule
 * below is the reason the Int32 tag cannot be introduced casually later.
 *
 * (double)(int32_t)(-0.0) == -0.0 is TRUE, so the obvious integral test admits -0.0 and would
 * quietly turn it into +0 -- breaking Object.is(-0, 0) === false and 1/-0 === -Infinity. */
static inline bool jsrt_fits_int32(double d) {
  return d >= -2147483648.0 && d <= 2147483647.0 && (double)(int32_t)d == d &&
         !(d == 0.0 && signbit(d));
}

/* --------------------------------------------------------------- strings */

/* A string is a header and a view of its code units (docs/VALUE.md §2). `data` points either just
 * past the header, where a flat string keeps its own units, or into an append buffer that several
 * strings share: each of those is a prefix of the buffer, so appending past every prefix's end
 * changes none of them, and `s += x` in a loop extends the buffer instead of copying the whole
 * string again (plan.md §9 Task 6.23, F12). Contents never change once a string is visible.
 * Construction goes through jsrt_string_alloc and jsrt_string_concat (jsrt_string_mem.zig). */
typedef struct JSString {
  uint32_t length;   /* UTF-16 code units -- not bytes, not code points */
  uint32_t flags;    /* JSRT_STRING_* */
  uint16_t *data;    /* NOT NUL-terminated */
  void *buffer;      /* the append buffer `data` points into, or NULL for a flat string */
} JSString;

/* The string came out of a concatenation: the next concatenation onto it reserves room to grow. */
#define JSRT_STRING_GROWN 1u

/* Maximum string length in code units: 2^29 - 24 = 536870888, matching V8's `String::kMaxLength`
 * on 64-bit (the pinned Node's limit; plan-notes 251 A12). An earlier cap of 2^31-1 (plan-notes
 * 203) disagreed with Node: lengths between the two caps must throw
 * `RangeError: Invalid string length`. */
#define JSRT_MAX_STRING_LENGTH 536870888u

/* A flat string of `len` code units for the caller to fill before it is visible anywhere. */
JSString *jsrt_string_alloc(uint32_t len);

/* Generated C touches string contents only through these two, never ->data[i] directly, so that
 * rope/small-string representations stay a runtime-only change (docs/VALUE.md §2). */
uint32_t jsrt_string_length(jsrt_value v);
uint16_t jsrt_string_char(jsrt_value v, uint32_t i);

/* String construction from UTF-8 bytes. */
jsrt_value jsrt_string_from_utf8(const char *bytes, size_t len);

/* FFI string conversions (docs/FFI.md §3) — the only path between a JS string and a C
 * string. The two directions are asymmetric on purpose:
 *
 * - `jsrt_string_to_cstr` (TS → C) encodes the string as NUL-terminated UTF-8 in a
 *   plain-malloc buffer the CALLER owns: `free` it after the call (the `CString` borrow),
 *   or hand it to the callee (the `CStringOwned` transfer — the runtime never frees it).
 *   A GC allocation cannot serve here: the collector cannot free on return, and a callee
 *   that keeps the pointer must hold malloc memory, not collected memory. An embedded
 *   U+0000 truncates (C string semantics); a lone surrogate encodes as U+FFFD, because
 *   `CString` is UTF-8 at the boundary and a surrogate range encoding is not UTF-8
 *   (`jsrt_print.c`'s encoder makes the same choice; `jsrt_shape_key`'s WTF-8 is internal
 *   metadata, not a foreign boundary, so it differs deliberately).
 * - `jsrt_string_from_cstr` (C → TS) copies a NUL-terminated `const char *` return into a
 *   fresh runtime string — never wrapped, never freed, because the allocator is the
 *   library's, not ours. Decoding is strict UTF-8 with U+FFFD per maximal invalid
 *   subsequence (Node's `Buffer.toString('utf8')` rule), NOT the WTF-8 `from_utf8` above
 *   accepts for source literals: surrogate-range bytes are three U+FFFDs here.
 *
 * Preconditions (asserted, not diagnosed — the emitter's boundary checks own the message):
 * `s`/`v` is a string value, and `s` is non-NULL. A NULL C return is answered by the
 * `@statorError null` convention (FFI step 4), never by this copy. */
char *jsrt_string_to_cstr(jsrt_value v);
jsrt_value jsrt_string_from_cstr(const char *s);

/* String construction from UTF-16 code units, copied verbatim (lone surrogates included). */
jsrt_value jsrt_string_from_units(const uint16_t *units, uint32_t len);

/* `String.fromCharCode(...codes)` (plan.md §8 step 19): one UTF-16 unit per argument, each
 * ToUint16 of its value. `n` is the count, followed by `n` jsrt_values. */
jsrt_value jsrt_string_from_char_code(uint32_t n, ...);

/* One step of String.prototype[@@iterator]: yield the code point at *index (a string of 1 or 2
 * UTF-16 units) and advance *index. Strings are immutable so the caller may bound the loop on
 * jsrt_string_length. */
jsrt_value jsrt_string_iter_next(jsrt_value s, uint32_t *index);

/* String operations: concatenation, equality, and lexicographic comparison. */
jsrt_value jsrt_string_concat(jsrt_value a, jsrt_value b);
jsrt_value jsrt_string_at(jsrt_value s, jsrt_value i);
jsrt_value jsrt_string_code_point_at(jsrt_value s, jsrt_value i);
jsrt_value jsrt_string_to_string(jsrt_value s);
jsrt_value jsrt_string_value_of(jsrt_value s);
bool jsrt_string_equals(jsrt_value a, jsrt_value b);
/* Compare two strings lexicographically by UTF-16 code unit.
 * Returns: <0 if a < b, 0 if a == b, >0 if a > b */
int jsrt_string_compare(jsrt_value a, jsrt_value b);

/* True when v holds a JS Number. A Number has TWO representations once Phase 3's i32 refinement
 * lands (docs/NUMERIC.md §1), and every predicate that compares numbers has to admit both -- so
 * the test lives here rather than being re-spelled at each call site. */
static inline bool jsrt_is_number(jsrt_value v) {
  return jsrt_is_double(v) || jsrt_is(v, JSRT_TAG_INT32);
}

/* The double a Number denotes. Meaningless for values where jsrt_is_number is false. */
static inline double jsrt_number_value(jsrt_value v) {
  return jsrt_is_double(v) ? jsrt_to_double(v) : (double)jsrt_as_int32(v);
}

/* True when v is an OBJECT in the spec's sense -- the ToPrimitive-needing half of the value
 * space, not the JSRT_TAG_OBJECT tag. An array and a function are objects to every abstract
 * operation (`[1] == "1"` is true, `[] + []` is `""`); only the printer cares which tag it is. */
static inline bool jsrt_is_object(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) || jsrt_is(v, JSRT_TAG_ARRAY) || jsrt_is(v, JSRT_TAG_CLOSURE);
}

/* --------------------------------------------------------- numeric helpers */

/* ToInt32: convert a double to int32_t using the spec algorithm, not a C cast.
 * C cast is undefined behaviour when out of range; this uses fmod for modular wrap. */
int32_t jsrt_to_int32(double d);

/* ToUint32: convert a double to uint32_t using the spec algorithm. */
uint32_t jsrt_to_uint32(double d);

/* ToPrimitive's preferred type (ECMA-262 §7.1.1): `string` tries `toString` first, the other two
 * `valueOf` first. `default` is what `+` and `==` pass; only a Date tells it from `number`. */
typedef enum { JSRT_HINT_DEFAULT, JSRT_HINT_NUMBER, JSRT_HINT_STRING } jsrt_hint;

/* ToPrimitive (ECMA-262 §7.1.1, docs/NUMERIC.md §7): the conversion every other abstract
 * operation runs FIRST when handed an object. A primitive passes through untouched.
 *
 * An object runs OrdinaryToPrimitive (§7.1.1.1): the two methods in the hint's order, the one the
 * object actually has -- its own, its class's, a prototype's (jsrt_user_get) -- or else the builtin
 * prototype's. The first call that answers a primitive wins; a method that is not callable is
 * skipped; when neither answers a primitive the result is Node's `TypeError: Cannot convert
 * object to primitive value`. A Date's default hint is `string` (§21.4.4.45). There is no
 * `Symbol.toPrimitive`: symbols are STA1212 (Phase 5), so no object can carry one.
 *
 * User code runs here, so the answer may be an exception: it is left pending and the value is
 * `undefined`, which the caller must not use before checking jsrt_pending(). */
jsrt_value jsrt_to_primitive(jsrt_value v, jsrt_hint hint);

/* ToNumber: convert a jsrt_value to a double. An object is run through ToPrimitive first.
 * Handles double, boolean, null, undefined, string, and Int32. */
double jsrt_to_number(jsrt_value v);

/* StringNumericLiteral: parse a string value as a number.
 * Not strtod: rejects trailing garbage, handles hex (0x10 = 16), trims whitespace.
 * Non-ASCII code units -> NaN. */
double jsrt_string_to_number(jsrt_value s);

/* The global number functions (§19.2): `parseInt(string, radix)`, `parseFloat(string)`,
 * `isNaN(x)`, `isFinite(x)`. Every argument is any value -- the string ones run ToString, the
 * other two ToNumber -- and an omitted one arrives as JSRT_UNDEFINED (plan.md §11c T11.4). */
jsrt_value jsrt_global_parse_int(jsrt_value string, jsrt_value radix);
jsrt_value jsrt_global_parse_float(jsrt_value string);
jsrt_value jsrt_global_is_nan(jsrt_value v);
jsrt_value jsrt_global_is_finite(jsrt_value v);
jsrt_value jsrt_number_is_finite(jsrt_value v);
jsrt_value jsrt_number_is_nan(jsrt_value v);

/* Builtin constructors and prototypes as values (jsrt_builtin_values.c, docs/VALUE.md §4.24). */
jsrt_value jsrt_builtin_ctor(const char *name);
jsrt_value jsrt_builtin_proto(const char *name);
bool jsrt_builtin_constructor_of(jsrt_value v, jsrt_value *out);
bool jsrt_builtin_member(jsrt_value obj, const char *key, jsrt_value *out);
jsrt_value jsrt_object_proto_method(const char *name);
jsrt_value jsrt_arraybuffer_is_view(jsrt_value v);
jsrt_value jsrt_function_call_method(jsrt_value fn, bool apply);
jsrt_value jsrt_builtin_ctor_value(jsrt_value name);
jsrt_value jsrt_builtin_proto_value(jsrt_value name);
jsrt_value jsrt_object_proto_method_value(jsrt_value name);

/* `n.toString(radix)` and `n.toFixed(digits)` (§21.1.3): `number` is the receiver, a number; the
 * argument is any value, JSRT_UNDEFINED when omitted. An out-of-range argument leaves Node's
 * RangeError pending and answers undefined. */
jsrt_value jsrt_number_to_string_radix(jsrt_value number, jsrt_value radix);
jsrt_value jsrt_number_to_fixed(jsrt_value number, jsrt_value digits);
/* Number.prototype, String.prototype and Boolean.prototype as VALUES for an Unknown receiver
 * (plan.md §11c T11.4, plan-notes 310; Boolean plan-notes 372), on the `jsrt_array_method`
 * contract: true when `key` names a landed method of the receiver's primitive type, with `*out`
 * a closure bound to the receiver. `jsrt_get_prop` asks them, since a primitive has no shape
 * table to walk. */
bool jsrt_number_method(jsrt_value number, const char *key, jsrt_value *out);
bool jsrt_string_method(jsrt_value string, const char *key, jsrt_value *out);
bool jsrt_boolean_method(jsrt_value boolean, const char *key, jsrt_value *out);

/* ToBoolean: convert a jsrt_value to a boolean.
 * Falsy: false, +0, -0, NaN, undefined, null, empty string.
 * Truthy: everything else (including "0" and "false" as strings). */
bool jsrt_truthy(jsrt_value v);

/* Loose equality (==): NUMERIC.md §6.3 table.
 * Key: null == undefined is true; null/undefined equal nothing else. */
bool jsrt_loose_equals(jsrt_value a, jsrt_value b);

/* SameValue (Object.is): like === but NaN === NaN and -0 !== +0.
 * Opposite of === on exactly these two inputs. Do not define via ===. */
bool jsrt_same_value(jsrt_value a, jsrt_value b);

/* Nullish test for `??`. Exactly `null` and `undefined` -- NOT the same set as falsy. */
static inline bool jsrt_is_nullish(jsrt_value v) {
  return v == JSRT_NULL || v == JSRT_UNDEFINED;
}

/* ------------------------------------------------------ bitwise operators */

/* The six bitwise operators and `~`, as whole operations rather than pieces the emitter
 * assembles. They live here because each one hides a C hazard that must be got right ONCE:
 *   - shifting a negative signed value left is undefined behaviour;
 *   - right-shifting a negative signed value is implementation-defined;
 *   - converting an out-of-range uint32 back to int32 is implementation-defined.
 * All three are avoided inside these functions by working in uint32 and sign-extending by hand.
 *
 * Every one returns a NUMBER, not an integer: `>>>` in particular can produce a value larger than
 * int32 can hold (docs/NUMERIC.md §4.2). */
jsrt_value jsrt_op_bitand(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_bitor(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_bitxor(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_shl(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_shr(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_ushr(jsrt_value a, jsrt_value b);
jsrt_value jsrt_op_bitnot(jsrt_value a);

/* ------------------------------------------------------------- equality */

/* NOT the same as a == b: NaN !== NaN despite bit equality, and +0 === -0 despite bit
 * inequality. Once Phase 3 emits Int32, a number also has two representations. */
bool jsrt_strict_equals(jsrt_value a, jsrt_value b);

/* ------------------------------------------------------ arithmetic operators */

/* The `+` operator: if either operand is a string, ToString both and concatenate;
 * otherwise ToNumber both and add. ECMA-262 §12.8.3. */
jsrt_value jsrt_op_add(jsrt_value a, jsrt_value b);

/* Relational comparison operators: <, >, <=, >=. ECMA-262 §12.10.
 * When BOTH operands are strings, compare lexicographically by UTF-16 code unit.
 * Otherwise, ToNumber both and compare numerically.
 * NaN makes all four operators return false. */
bool jsrt_op_lt(jsrt_value a, jsrt_value b);
bool jsrt_op_gt(jsrt_value a, jsrt_value b);
bool jsrt_op_le(jsrt_value a, jsrt_value b);
bool jsrt_op_ge(jsrt_value a, jsrt_value b);

/* --------------------------------------------------------------- objects */

/* A class instance: a fixed set of named slots, and a pointer to the static description of what
 * those slots ARE. This is `SUBSET.md`'s "C struct with fixed slot offsets" -- the emitter knows
 * every field's index at compile time and reads it directly, with no property lookup and no hash.
 *
 * `JSRTClass` is emitted `static const` per class, one instance per class in the whole program, so
 * comparing two `cls` pointers is a class-identity test -- that is what `instanceof` is.
 * `fields` is only needed to PRINT an object -- `console.log` shows `P { x: 1 }` -- so the names
 * live here once rather than in every instance. */
typedef struct JSRTClass {
  const char *name;           /* the class's own name, as written; "" is not a valid class */
  uint32_t field_count;
  const char *const *fields;  /* field names, in slot order; length is field_count */
  /* The base class's descriptor, or NULL at the root. This IS the prototype chain as far as this
   * subset can observe it: the only question anything asks of it is `instanceof`. The chain is
   * finite because `extends` is a declaration-order relation the frontend already proved acyclic,
   * so the walk below needs no visited set. */
  const struct JSRTClass *parent;
  /* The method table, in slot order, or NULL for a class that participates in no overriding.
   * A subclass's table BEGINS with its base's, in the base's own slot order -- the same prefix
   * property the fields have -- so a slot resolved against the static type of a receiver indexes
   * the same method on every descendant, and an override is a different entry at the same index.
   * The entries are file-scope constants, which is exactly why the table is absent for a class
   * whose methods capture: such a closure is not one constant per class.
   *
   * Since dynamic dispatch through Unknown (plan.md §8 step 45), the table is emitted for every
   * class with methods -- not only overridden families -- so that `jsrt_get_prop` can resolve a
   * method NAME at run time. `method_names` is parallel to `methods`: `method_names[i]` is the
   * name `methods[i]` implements. A capturing method's entry is NULL (it has no one constant
   * form); the dynamic get skips NULL entries and falls back to the instance's hidden
   * `#method:` slot, which carries the construction-site closure. */
  uint32_t method_count;
  const struct JSRTClosure *const *methods;
  const char *const *method_names;
  /* Slot indices in PROPERTY-INSERTION order, or NULL when insertion order IS slot order.
   *
   * A fixed shape's slot order is the LAYOUT -- what `o.x` resolves against, and therefore a
   * property of the TYPE, which the checker may list in a different order than the literal wrote
   * (`const o: { y: number; x: string } = { x: "s", y: 2 }`, and every object spread). Enumeration
   * order is a different fact: §10.1.11 OrdinaryOwnPropertyKeys answers ordinary string keys in
   * insertion order, which only the allocating literal knows -- with canonical array-index keys
   * ("1", "10") partitioned ahead of them in ascending numeric order at enumeration time
   * (jsrt_fixed_key_order; plan.md §8 step 28). Keeping both means a reordering annotation and a
   * spread store to the right slots AND print the way Node prints (plan-notes 181).
   *
   * Length is field_count when present; every slot appears exactly once. */
  const uint32_t *key_order;
  /* This class's OWN static members for a runtime class value to resolve (docs/VALUE.md §4.17;
  * `struct JSRTStaticEntry` is declared below), or NULL when it has none. Inherited statics are
  * the `parent` walk a lookup makes -- sound because the gate refuses a static override, so one
  * name is one binding per chain. Last in the layout so every positional initializer above
  * keeps its meaning and merely gains a zero. */
  const struct JSRTStaticEntry *statics;
} JSRTClass;

/* The slot the i-th enumerated property lives in. Identity when a class declares no reordering --
 * a class declaration's fields are laid out in the order they are written, so it never does. */
static inline uint32_t jsrt_class_key_slot(const JSRTClass *cls, uint32_t i) {
  return cls->key_order == NULL ? i : cls->key_order[i];
}

struct JSRTClosure;

struct JSRTDynObject;

/* Unlike JSRTArray, the elements ARE a flexible member here, and that is safe for the reason it is
 * unsafe there: an object's slot count is fixed by its class at construction, so this allocation
 * never grows and therefore never moves. A property the class never declared does NOT grow it: it
 * lands in `extras`, a dynamic object created on the first such write (docs/VALUE.md §4.24), the
 * way a function's own properties land in JSRTClosure::props. Growing `fields` instead would move
 * the header and make every boxed reference to it wrong. */
typedef struct JSRTObject {
  const JSRTClass *cls;
  bool frozen; /* Object.freeze: writes throw TypeError (Phase 5 step 11) */
  /* The undeclared properties, in insertion order after every declared one; NULL until the first
   * write of a name the class does not declare. */
  struct JSRTDynObject *extras;
  jsrt_value fields[];
} JSRTObject;

/* True exactly for a value laid out as a JSRTObject: a JSRT_TAG_OBJECT that is neither a dynamic
 * object nor one of the runtime's own layouts (Map, Date, RegExp, ...) that only share its `cls`
 * prefix. Only such a value has `frozen`, `extras` and `fields`. */
bool jsrt_is_fixed_object(jsrt_value v);

/* A fixed object's undeclared properties as a dynamic object, or NULL when it has none -- and for
 * any value that is not a fixed object, so a caller need not ask jsrt_is_fixed_object first. */
struct JSRTDynObject *jsrt_fixed_extras(jsrt_value v);

/* Every slot starts as `undefined`, which is what a declared-but-unassigned field reads as in
 * JavaScript. The constructor body then assigns the ones it assigns. */
jsrt_value jsrt_object_new(const JSRTClass *cls);

/* Spread-order repair (plan.md §8 step 21a): a `{ ...src }` result copies the right values but
 * bakes its type's field order into the descriptor, so these rebuild the SOURCE's order after
 * the values land. Own keys record their result slot; each spread source contributes its keys
 * in its own enumeration order; the finished order becomes the result's descriptor (interned,
 * shared like every other). `order`/`count`/`cap` are caller-owned scratch of `cap` entries.
 * The record calls return nothing (the emitter threads them as statements); the stamp and the
 * dynamic copy answer their result for the emitter's comma chains. */
void jsrt_spread_order_key(uint32_t *order, uint32_t *count, uint32_t cap, uint32_t slot);
void jsrt_spread_order_src(uint32_t *order, uint32_t *count, uint32_t cap, jsrt_value dst,
                           jsrt_value src);
/* Stamp the finished order and answer the result for the emitter's comma chains. */
jsrt_value jsrt_object_set_order(jsrt_value dst, const uint32_t *order, uint32_t count);
/* One spread fragment into a dynamic result, in the source's order; answers the result. */
jsrt_value jsrt_dynobj_spread(jsrt_value dst, jsrt_value src);

/* ============================================================================
 * Dynamic objects -- the shape table (hidden classes), docs/VALUE.md §4.10
 * ============================================================================
 *
 * A dynamic object is the representation for an object whose property SET is not a compile-time
 * layout: optional properties, index signatures, and (from Phase 5) untyped receivers. Its
 * properties live in an out-of-line slots array, and WHICH property is at which slot is recorded
 * once per distinct property history in a shared JSRTShape chain -- two objects that gained the
 * same keys in the same order point at the same shape, which is what makes a per-site inline
 * cache work: "same shape" implies "same offset", so a hit is one pointer compare and one load.
 *
 * A shape is one link of that history: `parent` is the object's shape before `key` was added, and
 * `offset` is the slot the addition claimed, so a shape's slot count is `offset + 1` and the root
 * (no properties yet) is the one shape with a NULL key. Transitions -- "from this shape, adding
 * this key leads to that shape" -- hang off the parent as a linked list of children. Shapes are
 * program-lifetime metadata: allocated on first use, never freed, never moved.
 *
 * The subset has no `delete`, so shapes never need a removal edge; when deletion lands it gets a
 * dictionary-mode escape, not shape surgery. */
typedef struct JSRTShape {
  struct JSRTShape *parent; /* the shape before `key` was added; NULL only at the root */
  const char *key;          /* the property this link added; NULL only at the root */
  uint32_t offset;          /* slot index `key` occupies; slot count of this shape is offset+1 */
  struct JSRTShape *transitions; /* first child: a shape reached by adding one more key */
  struct JSRTShape *sibling;     /* next child in the parent's transition list */
} JSRTShape;

/* Prefix-shared with JSRTObject exactly as JSRTMap is: `cls` first, so the Object tag covers it
 * and `jsrt_class_dynamic` (by pointer) is what distinguishes it. Slots are OUT of line, unlike a
 * fixed-shape object's, because property addition grows them and the header's address must stay
 * stable -- every boxed reference is the header's address. */
typedef struct JSRTDynObject {
  const JSRTClass *cls; /* &jsrt_class_dynamic -- prefix-shared with JSRTObject */
  JSRTShape *shape;
  uint32_t capacity;    /* slots allocated; the shape says how many are live */
  jsrt_value *slots;
  bool frozen; /* Object.freeze: writes throw TypeError (Phase 5 step 11) */
  /* [[Prototype]] of an object `new F()` built: `F.prototype` when that was an object, else 0 --
   * the default %Object.prototype%, which has no representation here and holds nothing a lookup
   * can find (plan-notes 310). A read that misses the own shape walks this chain; only
   * `jsrt_construct` sets it. */
  jsrt_value proto;
  /* The hidden `constructor` of the object `F.prototype` creates on first observation: the
   * function F, or 0. JavaScript makes that property non-enumerable, so it is a field rather than
   * a shape key -- printing and key enumeration never see it, and a read of `constructor` does. */
  jsrt_value ctor;
} JSRTDynObject;

/* One per property-access SITE, emitted `static` in generated C so it persists across executions
 * of the site. `shape == NULL` is the empty cache. The invariant a hit relies on: an IC is filled
 * only from a hit against a specific shape, so `ic->shape == o->shape` implies `ic->offset` is
 * `key`'s slot in that shape -- the site's key is fixed at compile time. */
typedef struct JSRTIC {
  const JSRTShape *shape;
  uint32_t offset;
} JSRTIC;

/* The marker descriptor every dynamic object shares. Its name is "" (prints like a literal) and
 * its field list is empty -- the SHAPE owns the layout, not the class. */
extern const JSRTClass jsrt_class_dynamic;

/* The `groups` object a RegExp match carries has a NULL prototype -- §22.2.7.2 builds it with
 * OrdinaryObjectCreate(null) -- and Node's inspector says so out loud: `[Object: null prototype]
 * { w: 'a' }`. The layout is a dynamic object's exactly; this second descriptor is the only thing
 * that differs, and it exists so the printer can tell them apart by pointer. */
extern const JSRTClass jsrt_class_null_proto;

jsrt_value jsrt_dynobj_new(void);
jsrt_value jsrt_null_proto_new(void);

/* An accessor property -- `{ get x() {…}, set x(v) {…} }` -- docs/VALUE.md §4.15.
 *
 * The pair lives in the object's SLOT, not on the shape, and that is forced rather than chosen: a
 * shape is shared by every object with the same key history, while a getter can capture, so three
 * objects built by one literal in a loop have one shape and must have three getters.
 *
 * Prefix-shared with JSRTObject exactly as JSRTMap and JSRTDynObject are, so the Object tag covers
 * it and the descriptor pointer is what says which builtin it is. Nothing in the language can
 * construct one -- jsrt_define_accessor is the only producer -- which is what lets a property read
 * tell a cell from a value by testing the value it just loaded, with no flag on the shape and no
 * third field in the IC. */
typedef struct JSRTAccessorCell {
  const JSRTClass *cls; /* &jsrt_class_accessor -- prefix-shared with JSRTObject */
  jsrt_value get;       /* JSRT_UNDEFINED for a set-only accessor */
  jsrt_value set;       /* JSRT_UNDEFINED for a get-only accessor */
} JSRTAccessorCell;

extern const JSRTClass jsrt_class_accessor;

static inline bool jsrt_is_accessor_cell(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) &&
         ((const JSRTObject *)jsrt_ptr(v))->cls == &jsrt_class_accessor;
}

/* Installs the pair under `key`, replacing whatever the key held. Either half may be
 * JSRT_UNDEFINED, but not both. `key` must outlive the program, exactly as jsrt_set_prop requires:
 * the shape table stores the pointer. */
void jsrt_define_accessor(jsrt_value obj, const char *key, jsrt_value get, jsrt_value set);

/* Own-property order for a shape -- a dynamic object's, or the table a match array carries: canonical array-index keys first in numeric order,
 * followed by the remaining string keys in insertion order (ECMA-262 OrdinaryOwnPropertyKeys).
 * The returned shape-pointer array is malloc-owned by the caller; it contains metadata pointers,
 * not GC values, and is therefore safe to hold outside a JSRT_FRAME. */
uint32_t jsrt_shape_property_count(const JSRTShape *shape);
const JSRTShape **jsrt_shape_property_order(const JSRTShape *shape, uint32_t count);
/* The array-index half of the same rule, over a NUL-terminated UTF-8 key: true with `*value` the
 * numeric value when the spelling round-trips through ToUint32 and is not 2^32-1 (so "01",
 * "+1" and "-0" are ordinary strings). Shared by the shape walk above and fixed-shape
 * enumeration below, which is one rule over two layouts. */
bool jsrt_key_is_array_index(const char *key, uint32_t *value);
/* Own-property order for a FIXED layout, in the same OrdinaryOwnPropertyKeys order: canonical
 * array-index keys first in ascending numeric order, then the remaining keys in insertion
 * (key_order) sequence. `#private` slots are not properties and are already filtered out, so
 * `*count_out` is the visible key count. The returned slot array is malloc-owned by the caller. */
uint32_t *jsrt_fixed_key_order(const JSRTClass *cls, uint32_t *count_out);

/* A shape key from a JS string: an interned immortal NUL-terminated UTF-8 copy, the lifetime the
 * shape table already gives every key it STORES. A second intern of the same bytes returns the
 * first pointer. A key containing U+0000 aborts -- a C string cannot hold one. A lookup that only
 * compares uses `jsrt_shape_key_ephemeral` and frees it; interning a miss keeps the bytes forever. */
const char *jsrt_shape_key(jsrt_value name);
/* The same UTF-8 conversion, owned by the caller (`free`). Not interned. */
char *jsrt_shape_key_ephemeral(jsrt_value name);
/* Distinct keys currently in the intern table. A compare-only lookup must not change it. */
size_t jsrt_shape_intern_count(void);
/* [[Get]] / [[HasProperty]] of a JS key. The conversion is freed before return, so a miss does
 * not enter the intern table. `jsrt_get_prop_value` runs ToString; `jsrt_has_prop_value` requires
 * a string (the caller already did ToPropertyKey). */
jsrt_value jsrt_get_prop_value(jsrt_value obj, jsrt_value name, JSRTIC *ic);
bool jsrt_has_prop_value(jsrt_value obj, jsrt_value name);
/* Reading a property the object does not have is `undefined` -- that IS the semantics of an
 * optional property. A miss is never cached: the same object can gain the key later. */
jsrt_value jsrt_get_prop(jsrt_value obj, const char *key, JSRTIC *ic);
/* [[Get]] of `key` restricted to what the PROGRAM put there: the object's own properties, its
 * class's methods, and a dynamic object's prototype chain. False on a miss, which means the key
 * resolves on a builtin prototype (%Object.prototype%, %Array.prototype%, ...) whose methods the
 * caller models itself -- ToPrimitive's fallback, util.format's `hasBuiltInToString`. A getter
 * found runs, and may leave an exception pending.
 *
 * `holder` (may be NULL) answers where the hit lives: NULL for an own property, otherwise the
 * `constructor.name` of the prototype that holds it ("" when that prototype has none). A class
 * method whose capturing closure has no table entry cannot be traced to one class; `*exact` (may
 * be NULL) is then false and `*holder` names the most-derived candidate, or a builtin-named one
 * when any candidate is (jsrt_is_builtin_constructor_name), so a caller refuses rather than
 * guesses. */
bool jsrt_user_get(jsrt_value obj, const char *key, jsrt_value *out, const char **holder,
                   bool *exact);
/* Overwrites in place when the key exists; transitions the shape (growing slots) when it does
 * not. Transitions are not IC-cached -- each object performs a given addition once. `key` must
 * outlive the program (generated C passes string literals); the shape table stores the pointer. */
void jsrt_set_prop(jsrt_value obj, const char *key, jsrt_value value, JSRTIC *ic);
bool jsrt_has_prop(jsrt_value obj, const char *key);
/* `key in obj`. Throws on null/undefined; arrays answer for `length` and live indices. */
bool jsrt_in(jsrt_value key, jsrt_value obj);
/* Computed-key get/set for an Unknown receiver: arrays go through the dense element path,
 * everything else through the property table with ToString(index) as the key. */
jsrt_value jsrt_dyn_index_get(jsrt_value obj, jsrt_value index, JSRTIC *ic);
void jsrt_dyn_index_set(jsrt_value obj, jsrt_value index, jsrt_value value, JSRTIC *ic);
/* `delete obj[key]` (`delete o.a` is this with a literal key). Answers the operator's boolean:
 * true when the key is gone or was never there, false only after raising. Removing a key REBUILDS
 * the object's shape chain from the root without it -- a shape is shared metadata and cannot lose
 * a node in place -- which is O(keys) and keeps two objects that deleted the same key on ONE shape.
 * A key that is not the object's to remove is answered where it is decided: a frozen dynamic
 * object raises Node's TypeError, and a fixed-shape receiver aborts (STA2007), because a layout
 * has no representation for a missing slot. */
bool jsrt_delete(jsrt_value obj, jsrt_value key);

/* Math builtins (jsrt_math.c) — number -> number, ECMA-262 §21.3.2 exactly. Entry points
 * apply ToNumber, so js-mode calls preserve JavaScript coercion semantics. The approximated
 * transcendentals below come from the vendored fdlibm (the code V8 runs), never the host libm,
 * so they agree with Node bit-for-bit (plan-notes 117). min/max/hypot are BINARY: the frontend
 * folds min/max's variadic forms into nested calls, and gates hypot above two arguments because
 * hypot is not associative. */
jsrt_value jsrt_math_abs(jsrt_value x);
jsrt_value jsrt_math_clz32(jsrt_value x);
jsrt_value jsrt_math_fround(jsrt_value x);
jsrt_value jsrt_math_imul(jsrt_value a, jsrt_value b);
jsrt_value jsrt_math_ceil(jsrt_value x);
jsrt_value jsrt_math_floor(jsrt_value x);
jsrt_value jsrt_math_round(jsrt_value x);
jsrt_value jsrt_math_sign(jsrt_value x);
jsrt_value jsrt_math_sqrt(jsrt_value x);
jsrt_value jsrt_math_trunc(jsrt_value x);
jsrt_value jsrt_math_pow(jsrt_value base, jsrt_value exponent);
jsrt_value jsrt_math_min(jsrt_value a, jsrt_value b);
jsrt_value jsrt_math_max(jsrt_value a, jsrt_value b);
jsrt_value jsrt_math_acos(jsrt_value x);
jsrt_value jsrt_math_acosh(jsrt_value x);
jsrt_value jsrt_math_asin(jsrt_value x);
jsrt_value jsrt_math_asinh(jsrt_value x);
jsrt_value jsrt_math_atan(jsrt_value x);
jsrt_value jsrt_math_atan2(jsrt_value y, jsrt_value x);
jsrt_value jsrt_math_atanh(jsrt_value x);
jsrt_value jsrt_math_cbrt(jsrt_value x);
jsrt_value jsrt_math_cos(jsrt_value x);
jsrt_value jsrt_math_cosh(jsrt_value x);
jsrt_value jsrt_math_exp(jsrt_value x);
jsrt_value jsrt_math_expm1(jsrt_value x);
jsrt_value jsrt_math_hypot(jsrt_value a, jsrt_value b);
jsrt_value jsrt_math_log(jsrt_value x);
jsrt_value jsrt_math_log10(jsrt_value x);
jsrt_value jsrt_math_log1p(jsrt_value x);
jsrt_value jsrt_math_log2(jsrt_value x);
/* Nondeterministic by specification — proved by range/distribution assertions in tests/unit/,
 * never by a golden test (plan.md §7 Task 4.2, determinism carve-out). */
jsrt_value jsrt_math_random(void);
jsrt_value jsrt_math_sin(jsrt_value x);
jsrt_value jsrt_math_sinh(jsrt_value x);
jsrt_value jsrt_math_tan(jsrt_value x);
jsrt_value jsrt_math_tanh(jsrt_value x);

/* String.prototype builtins (jsrt_string_ops.c) — UTF-16 code-unit semantics, ECMA-262 §22.1.3
 * exactly. Optional arguments arrive as JSRT_UNDEFINED (the lowering pads them; for every method
 * here an explicit undefined means the same as absent). Case mapping outside ASCII and repeat's
 * RangeError are loud runtime not-yets (STA2005), never approximations. */
jsrt_value jsrt_string_char_at(jsrt_value s, jsrt_value i);
jsrt_value jsrt_string_char_code_at(jsrt_value s, jsrt_value i);
jsrt_value jsrt_string_index_of(jsrt_value s, jsrt_value search, jsrt_value from);
jsrt_value jsrt_string_last_index_of(jsrt_value s, jsrt_value search, jsrt_value from);
jsrt_value jsrt_string_includes(jsrt_value s, jsrt_value search, jsrt_value from);
jsrt_value jsrt_string_starts_with(jsrt_value s, jsrt_value search, jsrt_value from);
jsrt_value jsrt_string_ends_with(jsrt_value s, jsrt_value search, jsrt_value end);
jsrt_value jsrt_string_slice(jsrt_value s, jsrt_value a, jsrt_value b);
jsrt_value jsrt_string_substring(jsrt_value s, jsrt_value a, jsrt_value b);
jsrt_value jsrt_string_trim(jsrt_value s);
jsrt_value jsrt_string_trim_start(jsrt_value s);
jsrt_value jsrt_string_trim_end(jsrt_value s);
jsrt_value jsrt_string_repeat(jsrt_value s, jsrt_value n);
jsrt_value jsrt_string_pad_start(jsrt_value s, jsrt_value target, jsrt_value pad);
jsrt_value jsrt_string_pad_end(jsrt_value s, jsrt_value target, jsrt_value pad);
/* The libunicode-backed String.prototype methods (runtime/src/jsrt_unicode.c). Case mapping is
 * defined on CODE POINTS and one of them can map to three, so neither of these is a per-unit walk;
 * `normalize` takes the form string or `undefined`, which means NFC. */
jsrt_value jsrt_unicode_case(jsrt_value s, bool upper);
jsrt_value jsrt_unicode_normalize(jsrt_value s, jsrt_value form);

/* `s.search(re)` -- the one String.prototype method the subset admits ONLY with a regexp: the spec
 * converts a non-regexp with `new RegExp(...)`, a constructor the compiler does not have. */
jsrt_value jsrt_string_search(jsrt_value s, jsrt_value re);
jsrt_value jsrt_string_match(jsrt_value s, jsrt_value re);
jsrt_value jsrt_string_match_all(jsrt_value s, jsrt_value re);
jsrt_value jsrt_string_normalize(jsrt_value s, jsrt_value form);
jsrt_value jsrt_string_split(jsrt_value s, jsrt_value sep);
jsrt_value jsrt_string_replace(jsrt_value s, jsrt_value pattern, jsrt_value replacement);
jsrt_value jsrt_string_replace_all(jsrt_value s, jsrt_value pattern, jsrt_value replacement);
jsrt_value jsrt_string_to_upper_case(jsrt_value s);

/* The locale-sensitive trio (runtime/src/jsrt_intl.c). Collation and TAILORED casing are CLDR
 * data, not Unicode tables, so these are the one part of the string surface that needs ICU: they
 * are implemented in the `just runtime-intl` build and abort with an STA2005 naming that flag
 * in the default one. `locales` is a single BCP 47 tag, never absent -- an implicit default locale
 * would make the answer depend on the machine that RUNS the binary. */
jsrt_value jsrt_string_locale_compare(jsrt_value s, jsrt_value that, jsrt_value locales);
jsrt_value jsrt_string_to_locale_upper_case(jsrt_value s, jsrt_value locales);
jsrt_value jsrt_string_to_locale_lower_case(jsrt_value s, jsrt_value locales);

/* Array.prototype builtins (§23.1.3) — the non-callback surface, runtime/src/jsrt_array_ops.c
 * (join lives in jsrt_print.c with the ToString machinery it needs). Optional positions arrive as
 * JSRT_UNDEFINED per the lowering's padding; `lastIndexOf` has no position argument because the
 * spec gives its explicit `undefined` a DIFFERENT meaning than absence. `reverse` and `fill`
 * mutate in place and return the receiver. The variadic entry points (plan.md §8 step 19) take a
 * count followed by that many jsrt_values: `push`/`unshift` append/prepend a run, `concat`
 * spreads each array argument and appends each non-array one as a single element, `splice`
 * removes a span and inserts a run in its place. */
jsrt_value jsrt_array_push(jsrt_value array, jsrt_value element);
jsrt_value jsrt_array_push_many(jsrt_value array, uint32_t n, ...);
jsrt_value jsrt_array_pop(jsrt_value array);
jsrt_value jsrt_array_shift(jsrt_value array);
jsrt_value jsrt_array_unshift(jsrt_value array, jsrt_value element);
jsrt_value jsrt_array_unshift_many(jsrt_value array, uint32_t n, ...);
jsrt_value jsrt_array_at(jsrt_value array, jsrt_value index);
jsrt_value jsrt_array_index_of(jsrt_value array, jsrt_value search, jsrt_value from);
jsrt_value jsrt_array_last_index_of(jsrt_value array, jsrt_value search);
jsrt_value jsrt_array_last_index_of_from(jsrt_value array, jsrt_value search, jsrt_value from);
jsrt_value jsrt_array_includes(jsrt_value array, jsrt_value search, jsrt_value from);
jsrt_value jsrt_array_join(jsrt_value array, jsrt_value separator);
jsrt_value jsrt_array_slice(jsrt_value array, jsrt_value start, jsrt_value end);
jsrt_value jsrt_array_concat(jsrt_value array, jsrt_value other);
jsrt_value jsrt_array_concat_many(jsrt_value array, uint32_t n, ...);
/* Replace every hole of `array` with `undefined`, in place, and answer it: an array-literal
 * spread iterates its operand, so `[...xs]` has no holes where `xs.concat()` keeps them. */
jsrt_value jsrt_array_fill_holes(jsrt_value array);
/* `[...x]`'s operand as an array: an array itself, anything else drained through its iterator, a
 * non-iterable a pending TypeError (jsrt_typed.zig, docs/VALUE.md §4.23). */
jsrt_value jsrt_spread_operand(jsrt_value source);
/* `Array.from(items)` with one argument (§23.1.2.1): iterables drained, array-likes read by
 * `length`, nullish a pending TypeError. */
jsrt_value jsrt_array_from(jsrt_value source);
jsrt_value jsrt_array_reverse(jsrt_value array);
jsrt_value jsrt_array_fill(jsrt_value array, jsrt_value value, jsrt_value start, jsrt_value end);

/* The callback-taking methods. Each calls back into compiled code through jsrt_call with the
 * spec's (element, index, array) triple, caching `length` at entry; predicates coerce the
 * callback's answer through jsrt_truthy, exactly ToBoolean. */
jsrt_value jsrt_array_for_each(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_map(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_filter(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_some(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_every(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_find(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_find_index(jsrt_value array, jsrt_value cb);
/* With-initial forms only; the callback gets (accumulator, element, index, array). */
jsrt_value jsrt_array_reduce(jsrt_value array, jsrt_value cb, jsrt_value initial);
jsrt_value jsrt_array_reduce_right(jsrt_value array, jsrt_value cb, jsrt_value initial);
/* Stable in-place sort returning the receiver; an undefined comparator means the spec's
 * ToString default. */
jsrt_value jsrt_array_sort(jsrt_value array, jsrt_value cmp);
jsrt_value jsrt_array_copy_within(jsrt_value array, jsrt_value target, jsrt_value start,
                                  jsrt_value end);
/* The two removal forms and the insertion form (plan.md §8 step 19); each returns the
 * removed run. `splice_from` removes from `start` to the end; `splice_insert` removes the span
 * and inserts `n` items at its start. */
jsrt_value jsrt_array_splice(jsrt_value array, jsrt_value start, jsrt_value delete_count);
jsrt_value jsrt_array_splice_from(jsrt_value array, jsrt_value start);
jsrt_value jsrt_array_splice_insert(jsrt_value array, jsrt_value start, jsrt_value delete_count,
                                    uint32_t n, ...);
jsrt_value jsrt_array_flat(jsrt_value array, jsrt_value depth);
jsrt_value jsrt_array_flat_map(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_find_last(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_find_last_index(jsrt_value array, jsrt_value cb);
jsrt_value jsrt_array_to_reversed(jsrt_value array);
jsrt_value jsrt_array_to_sorted(jsrt_value array, jsrt_value cmp);
jsrt_value jsrt_array_to_spliced(jsrt_value array, jsrt_value start, jsrt_value skip_count);
jsrt_value jsrt_array_to_string(jsrt_value array);
/* Out-of-range index aborts (spec: RangeError; STA2005 pattern). */
jsrt_value jsrt_array_with(jsrt_value array, jsrt_value index, jsrt_value value);

/* Array.prototype as VALUES for an Unknown receiver (plan.md §8 step 20): `jsrt_get_prop` walks
 * shape tables only, so `a.push` on an array answered `undefined` and the following call aborted
 * STA2006 where Node runs. True when `key` names an Array.prototype method, with `*out` a bound
 * closure over the receiver that the ordinary call protocol invokes (the receiver rides in the
 * closure's environment, not in argv, because an Unknown-receiver call passes user arguments
 * only). Own properties shadow: the caller walks the shape table first and asks only on a miss,
 * and a hit here never fills the IC (the bound value is per-receiver). Only arrays: every other
 * builtin prototype is its own step. */
bool jsrt_array_method(jsrt_value array, const char *key, jsrt_value *out);

/* Object.keys/values/entries (§20.1.2) over the two object layouts — runtime/src/jsrt_object_ops.c.
 * Both layouts enumerate ECMA-262 OrdinaryOwnPropertyKeys: canonical array-index keys first in
 * ascending numeric order, then the remaining string keys in insertion order. The dynamic walk
 * sorts the shape chain (Object.fromEntries/JSON.parse can create integer keys there); the fixed
 * walk partitions the class descriptor the same way, because a string-literal key like "1" in a
 * fixed layout is an index exactly as it is in a shape (plan.md §8 step 28 -- plan-notes 85's
 * "integer-like keys cannot trigger" invariant was falsified by string-literal keys). */
jsrt_value jsrt_object_keys(jsrt_value v);
jsrt_value jsrt_object_values(jsrt_value v);
jsrt_value jsrt_object_entries(jsrt_value v);
jsrt_value jsrt_object_get_own_property_names(jsrt_value v);
/* The `for-in` desugar's total keys walk (plan.md §8 step 38): own enumerable keys for objects,
 * arrays and strings, an empty list for every other primitive. */
jsrt_value jsrt_object_for_in_keys(jsrt_value v);
jsrt_value jsrt_object_has_own(jsrt_value v, jsrt_value key);
jsrt_value jsrt_object_from_entries(jsrt_value pairs);
/* Object.assign, two-argument form. The TARGET must be a dynamic-shape object: a fixed shape's
 * reads are slot indices fixed at build time, so a target that can grow is the only sound one. */
jsrt_value jsrt_object_assign(jsrt_value target, jsrt_value source);
jsrt_value jsrt_object_freeze(jsrt_value v);
jsrt_value jsrt_object_is_frozen(jsrt_value v);

/* JSON.stringify (§25.5.2), single-argument form — runtime/src/jsrt_print.c, with the rest of
 * stringification. Non-finite numbers and -0 serialize per spec ("null", "0"); a cycle or a
 * top-level undefined aborts loudly (STA2005 pattern) because the spec's answers — TypeError and
 * an undefined result — are not expressible yet. */
jsrt_value jsrt_json_stringify(jsrt_value v);

/* JSON.parse, single-argument form: text in, runtime value out -- JSON objects become dynamic-
 * shape objects, JSON arrays become arrays. Malformed text aborts loudly (the spec throws
 * SyntaxError, which builtins cannot raise yet). */
jsrt_value jsrt_json_parse(jsrt_value text);
jsrt_value jsrt_string_to_lower_case(jsrt_value s);

static inline bool jsrt_is_dynobj(jsrt_value v) {
  /* JSRT_TAG_OBJECT specifically: jsrt_is_object also answers true for arrays and closures,
   * which carry no JSRTClass and must not be dereferenced as one. */
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return false;
  }
  const JSRTClass *cls = ((const JSRTObject *)jsrt_ptr(v))->cls;
  return cls == &jsrt_class_dynamic || cls == &jsrt_class_null_proto;
}

static inline JSRTObject *jsrt_as_object(jsrt_value v) {
  return (JSRTObject *)jsrt_ptr(v);
}

/* Slot access. `slot` is a compile-time constant the emitter got from the class's field list, so
 * these are inline rather than calls: there is no lookup to amortize, only a bounds fact the
 * compiler already proved. They are here rather than open-coded at the emitter so that the layout
 * stays a runtime detail -- the emitter names a slot, never an offset. */
static inline jsrt_value jsrt_object_get(jsrt_value obj, uint32_t slot) {
  return jsrt_as_object(obj)->fields[slot];
}

/* Like `jsrt_object_get`, but raises Node's TypeError when `obj` is nullish -- the path a method
 * body's `this.x` takes when `this` is `undefined` after a method value is called bare. */
jsrt_value jsrt_object_get_field(jsrt_value obj, uint32_t slot, const char *field);

/* May throw (frozen object). Generated C checks jsrt_pending() after every write. */
void jsrt_object_set(jsrt_value obj, uint32_t slot, jsrt_value v);

/* `x instanceof C`. There is exactly one `JSRTClass` per class in the program, so class identity is
 * descriptor identity and each link of the walk is a pointer comparison -- no string compare, no
 * lookup. Walking `parent` is what makes a `Dog` an `Animal`.
 *
 * A non-object answers `false` rather than raising: `1 instanceof C` is false in JavaScript, and it
 * is the RIGHT operand that has to be a constructor, which the frontend proved. Arrays and closures
 * are objects with no `JSRTClass` at all, so the tag test excludes them before any dereference. */
static inline bool jsrt_instanceof(jsrt_value v, const JSRTClass *cls) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return false;
  }
  for (const JSRTClass *c = jsrt_as_object(v)->cls; c != NULL; c = c->parent) {
    if (c == cls) {
      return true;
    }
  }
  return false;
}

/* `o instanceof v` where `v` is a VALUE (a class object or a function reached at run time), not a
 * name the emitter resolved (docs/VALUE.md §4.20). A class object walks the same chain
 * `jsrt_instanceof` walks, against the descriptor the value carries. An ordinary function answers
 * through `v.prototype` (§7.3.22 OrdinaryHasInstance): true when it is on `o`'s prototype chain,
 * which only an object `new` built through a function has (plan-notes 310), and Node's TypeError
 * when the prototype is not an object (an arrow's). The right operand of `instanceof` must be
 * callable in JavaScript; a non-callable answers Node's catchable TypeError (`Right-hand side of
 * 'instanceof' is not an object` -- or `not callable` for an object that is not a function). */
bool jsrt_instanceof_ctor(jsrt_value obj, jsrt_value ctor);

/* ---------------------------------------------------------------- errors */

/* The standard Error classes. Each is an ordinary `JSRTClass` whose `parent` is `Error`, so the
 * subclass relation IS the walk `jsrt_instanceof` above already does — there is no error-specific
 * machinery, which is the point. Layout is fixed and shared: slot 0 `name`, slot 1 `message`, so
 * `e.name` and `e.message` are the same fixed-shape reads every other object gets.
 *
 * Defined in jsrt_error.c, where the two divergences from Node (enumerability of the two slots,
 * and the absence of a stack trace) are recorded. */
#define JSRT_ERROR_SLOT_NAME 0u
#define JSRT_ERROR_SLOT_MESSAGE 1u

extern const JSRTClass jsrt_class_error;
extern const JSRTClass jsrt_class_type_error;
extern const JSRTClass jsrt_class_range_error;
extern const JSRTClass jsrt_class_reference_error;
extern const JSRTClass jsrt_class_syntax_error;

/* The descriptor for a standard error class by name, or NULL if the name is not one. */
const JSRTClass *jsrt_error_class(const char *name);

/* `new <cls>(message)`. `message` is already a value because the caller may have one that is not a
 * C string; jsrt_throw_error is the convenience for the runtime's own literal messages. */
jsrt_value jsrt_error_new(const JSRTClass *cls, jsrt_value message);
void jsrt_throw_error(const JSRTClass *cls, const char *message);
/* Throws `ReferenceError: <name> is not defined` and answers undefined so an expression
 * position has a value; the caller checks jsrt_pending() and unwinds (plan.md §8 step 2a(c)). */
jsrt_value jsrt_reference_error(const char *name);

/* True for exactly the five standard error classes -- pointer compares, NOT the parent walk
 * `jsrt_instanceof` does. A user class cannot extend one today (`extends` anything but a class
 * declaration is STA1214), and if that ever lands the subclass's layout is its own, so slots
 * 0/1 below would be the wrong read; exact match keeps `jsrt_error_to_string` honest. */
static inline bool jsrt_is_error(jsrt_value v) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return false;
  }
  const JSRTClass *cls = jsrt_as_object(v)->cls;
  return cls == &jsrt_class_error || cls == &jsrt_class_type_error ||
         cls == &jsrt_class_range_error || cls == &jsrt_class_reference_error ||
         cls == &jsrt_class_syntax_error;
}

/* `Error.prototype.toString` without the method (§20.5.3.4): `name` + `": "` + `message`,
 * with the spec's empty-side rules. `jsrt_to_string` routes every error here. */
jsrt_value jsrt_error_to_string(jsrt_value v);

/* ------------------------------------------------------------ Map and Set */

/* A Map and a Set are ONE structure under two descriptors, because they differ in exactly two
 * places: a Set ignores the value half of an entry, and the printer writes `1` where a Map writes
 * `'a' => 1`. Everything that is actually hard -- SameValueZero on the keys, insertion order,
 * deletion without disturbing it -- is identical, and writing it twice would mean two chances to
 * get NaN or -0 wrong.
 *
 * `cls` is FIRST, exactly as in JSRTObject, and that prefix is what makes a Map an object: the tag
 * is JSRT_TAG_OBJECT, `jsrt_as_object(m)->cls` is a valid read, and `instanceof` walks it like any
 * other class. The printer tells the two apart by comparing that pointer against the two
 * descriptors below -- there is one of each in the whole program, so it is a pointer compare, the
 * same identity test `instanceof` is.
 *
 * Insertion order is a SPEC guarantee, not a convenience: `console.log` and every iteration form
 * print entries in the order they were first inserted, and re-setting an existing key does not
 * move it. That is why entries live in an append-only array and the hash table holds INDICES into
 * it rather than the entries themselves. A deletion marks its entry dead and blanks both halves
 * (stale bits in a GC-scanned allocation would keep a dead key alive); the dead entries are
 * compacted away the next time the array is full. */
typedef struct JSRTMapEntry {
  jsrt_value key;
  jsrt_value value; /* JSRT_UNDEFINED throughout a Set, which stores keys and nothing else */
  bool live;
} JSRTMapEntry;

typedef struct JSRTMap {
  const JSRTClass *cls; /* &jsrt_class_map or &jsrt_class_set -- prefix-shared with JSRTObject */
  uint32_t size;        /* LIVE entries: what `.size` reports */
  uint32_t used;        /* entries appended, live or dead: entries[0..used) have been written */
  uint32_t capacity;
  JSRTMapEntry *entries;
  /* Open-addressed, linear-probed, holding `entry index + 1` so that 0 means empty. Sized to a
   * power of two at twice `capacity`, which keeps the load factor at or below one half. */
  uint32_t *index;
  uint32_t index_mask;
  /* Depth of forEach walks in progress. A walk holds an INDEX into `entries`, and compaction is
   * the one thing that renumbers them (see grow()), so while this is non-zero the array only ever
   * grows and dead entries keep their slots. Nested walks are why it counts rather than flags. */
  uint32_t iterating;
} JSRTMap;

extern const JSRTClass jsrt_class_map;
extern const JSRTClass jsrt_class_set;
extern const JSRTClass jsrt_class_weakmap;
extern const JSRTClass jsrt_class_weakset;

jsrt_value jsrt_map_new(void);
jsrt_value jsrt_set_new(void);
/* `new WeakMap()` (map) or `new WeakSet()`: a JSRTMap whose `set`/`add` throws a TypeError on a
 * non-object key (docs/VALUE.md §4.22). */
jsrt_value jsrt_weak_collection_new(bool map);

static inline JSRTMap *jsrt_as_map(jsrt_value v) { return (JSRTMap *)jsrt_ptr(v); }

/* True for a Map or a Set, weak or not -- the test the printer runs before treating an object as
 * a class instance, since all four carry the object tag and the JSRTMap layout. */
static inline bool jsrt_is_map_or_set(jsrt_value v) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return false;
  }
  const JSRTClass *cls = jsrt_as_object(v)->cls;
  return cls == &jsrt_class_map || cls == &jsrt_class_set || cls == &jsrt_class_weakmap ||
         cls == &jsrt_class_weakset;
}

/* `m.get(k)` -- `undefined` for an absent key, which is what JavaScript returns and why the static
 * type of a `.get` is `V | undefined`. */
jsrt_value jsrt_map_get(jsrt_value map, jsrt_value key);

/* `m.forEach(cb)` and `s.forEach(cb)`: the spec's callback triple is (value, key, collection) for a
 * Map and (value, value, set) for a Set -- a Set entry is its own key, which is exactly how it is
 * stored. Insertion order, entries added DURING the walk are visited, and an entry deleted before
 * it is reached is not. Both return undefined. */
jsrt_value jsrt_map_for_each(jsrt_value map, jsrt_value cb);
jsrt_value jsrt_set_for_each(jsrt_value set, jsrt_value cb);

/* Specialized for-of (docs/VALUE.md §4.13): a live walk of the insertion-order chain, no iterator
 * object. `begin` bumps `iterating` so compaction cannot renumber the cursor; `end` must run on
 * every exit, including throw and return. `next` advances `*index` to the next live entry and
 * writes the yield — a two-element array for Map, the element for Set. */
void jsrt_map_iter_begin(jsrt_value map);
void jsrt_map_iter_end(jsrt_value map);
bool jsrt_map_iter_next(jsrt_value map, uint32_t *index, jsrt_value *out);
bool jsrt_set_iter_next(jsrt_value set, uint32_t *index, jsrt_value *out);
/* Key and value separately, so keys()/values()/entries() can pick a yield without a second walk. */
bool jsrt_map_iter_step(jsrt_value map, uint32_t *index, jsrt_value *key, jsrt_value *value);

/* Boxed specialized iterators (docs/VALUE.md §4.13). `cls` is the shared object header; the
 * three fields after it are the cursor VALUE.md names. Kind values are stable so generated C
 * can pass them as literals. */
#define JSRT_ITER_ARRAY_KEYS 0
#define JSRT_ITER_ARRAY_VALUES 1
#define JSRT_ITER_ARRAY_ENTRIES 2
#define JSRT_ITER_MAP_KEYS 3
#define JSRT_ITER_MAP_VALUES 4
#define JSRT_ITER_MAP_ENTRIES 5
#define JSRT_ITER_SET_KEYS 6
#define JSRT_ITER_SET_VALUES 7
#define JSRT_ITER_SET_ENTRIES 8
#define JSRT_ITER_MATCH_ALL 9
/* The string code-point walk, boxed. Never a stored member result -- only the suspendable-unit
 * for-of boxes it, because a cursor on the C frame would not survive a yield/await. */
#define JSRT_ITER_STRING 10
/* A Uint8Array's element walk (`for (const b of bytes)`): `index` is the element cursor, and each
 * step re-reads the view's length, so the walk sees the bytes as they are when it reaches them. */
#define JSRT_ITER_UINT8ARRAY 11

typedef struct JSRTIterator {
  const JSRTClass *cls; /* &jsrt_class_iterator -- prefix-shared with JSRTObject */
  jsrt_value target;    /* the iterable; a GC root */
  jsrt_value extra;     /* matchAll: the cloned regexp; undefined otherwise */
  uint32_t index;       /* specialized cursor */
  uint8_t kind;         /* JSRT_ITER_* */
} JSRTIterator;

extern const JSRTClass jsrt_class_iterator;

jsrt_value jsrt_iterator_new(jsrt_value target, uint8_t kind);
jsrt_value jsrt_iterator_match_all_new(jsrt_value str, jsrt_value matcher);
/* Dynamic GetIterator dispatch for `for-of` over a statically-unknown iterable (plan.md §8 step
 * 2a(c), TS2488): arrays, strings, Maps and Sets box into the specialized walk the static loop
 * would have inlined; generators and stored boxes pass through untouched; any other object
 * resolves its `__@iterator` method through the shape table (fixed or dynamic alike) and calls
 * it with the receiver, and whatever else arrives leaves a catchable `X is not iterable`
 * pending. The answer is always something `jsrt_iterator_step` drives -- a method result that
 * is neither a generator nor a box is Node's `TypeError: Result of the Symbol.iterator method
 * is not an object` rather than a step the walk cannot take. A custom `{ next() }` object is
 * that error too: driving one needs a callback into compiled code per step, which is the
 * Phase-8 dynamic tier, not this dispatch (a statically-known one stays STA1214). */
jsrt_value jsrt_get_iterator(jsrt_value value);
jsrt_value jsrt_iterator_next(jsrt_value it, jsrt_value sent);
bool jsrt_iterator_step(jsrt_value it, jsrt_value *out);
/* IteratorClose for `for...of` (plan.md §8 step 34): a `break`, `return` or `throw` out of the
 * loop body runs the iterator's `return()` — a generator's `finally`. Only generators define
 * one: closing any other box is a no-op (a stored `arr.values()` keeps yielding after the loop
 * breaks, so touching the box would be the divergence). A close that throws leaves it pending
 * for the call site, which is the generated-code convention for a user call that throws. */
void jsrt_iterator_close(jsrt_value it);

/* `m.set(k, v)` and `s.add(v)` both RETURN THE COLLECTION, which is what makes them chainable. */
jsrt_value jsrt_map_set(jsrt_value map, jsrt_value key, jsrt_value value);
jsrt_value jsrt_set_add(jsrt_value set, jsrt_value key);

bool jsrt_map_has(jsrt_value map, jsrt_value key);
/* `true` when the key was there, `false` when it was not -- the value JavaScript's delete returns. */
bool jsrt_map_delete(jsrt_value map, jsrt_value key);
/* Undefined, the value `clear()` evaluates to -- so a statement that calls it is an ordinary
 * expression rather than one the emitter has to wrap in a comma to give a value to. */
jsrt_value jsrt_map_clear(jsrt_value map);
/* `.size` as a Number, so the emitter never reads the struct field itself. */
jsrt_value jsrt_map_size(jsrt_value map);

/* The ES2025 set operations (§24.2.4). Both operands are real Sets -- the spec's set-like object
 * is refused at the gate, because reading one means calling its `keys()` iterator. Neither operand
 * is mutated: the four combining forms build a new Set.
 *
 * Order is normative and is NOT always the receiver's: `intersection` walks the smaller collection
 * and answers in that one's order (the spec's own branch, which the pinned Node observes). The
 * others answer in the receiver's order, followed by the argument's. */
jsrt_value jsrt_set_union(jsrt_value a, jsrt_value b);
jsrt_value jsrt_set_intersection(jsrt_value a, jsrt_value b);
jsrt_value jsrt_set_difference(jsrt_value a, jsrt_value b);
jsrt_value jsrt_set_symmetric_difference(jsrt_value a, jsrt_value b);
bool jsrt_set_is_subset_of(jsrt_value a, jsrt_value b);
bool jsrt_set_is_superset_of(jsrt_value a, jsrt_value b);
bool jsrt_set_is_disjoint_from(jsrt_value a, jsrt_value b);

/* --------------------------------------------------------------- regexps */

/* A compiled regular expression: the engine's bytecode plus the two strings a program can read back
 * off it. The engine is quickjs-ng's libregexp, vendored under `runtime/vendor/` (plan.md golden
 * rule 5 -- do not write a regex engine); this struct is the whole of what Stator adds to it.
 *
 * `bytecode` is `lre_compile`'s output: plain bytes with no `jsrt_value` inside, so a collector
 * never scans it. It is allocated through `lre_realloc`, which is one of the three functions the
 * engine asks its embedder for (`runtime/src/jsrt_regexp.c`).
 *
 * `last_index` is the `lastIndex` property, and it is state ON THE PATTERN rather than on the
 * match: `/g` and `/y` read it to decide where to start and write it back after a match, which is
 * why two loops sharing one regexp literal are not independent in JavaScript. */
typedef struct JSRTRegExp {
  const JSRTClass *cls; /* &jsrt_class_regexp -- prefix-shared with JSRTObject */
  jsrt_value source;    /* the pattern as written, without the delimiting slashes */
  jsrt_value flags;     /* the flags as a string, in the spec's canonical order */
  int lre_flags;        /* the same flags as the LRE_FLAG_* set the bytecode was compiled with */
  uint32_t last_index;
  int bytecode_len;
  uint8_t *bytecode;
} JSRTRegExp;

/* A `Date`: one double, milliseconds since the epoch, or NaN for an Invalid Date. Prefix-shared
 * with JSRTObject the way JSRTRegExp is, so `jsrt_is_date` is a class-pointer comparison and every
 * abstract operation that asks "is this an object" already answers yes.
 *
 * There is nothing else to store. Every field a program can read -- year, month, weekday, the ISO
 * string -- is DERIVED from this double by calendar arithmetic (runtime/src/jsrt_date.c), so a
 * Date cannot hold two facts that disagree, and `setUTCMonth` rolling into the next year is
 * arithmetic rather than a normalization pass. */
typedef struct JSRTDate {
  const JSRTClass *cls; /* &jsrt_class_date */
  double time;
} JSRTDate;

extern const JSRTClass jsrt_class_date;

static inline bool jsrt_is_date(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && jsrt_as_object(v)->cls == &jsrt_class_date;
}

/* Construction. `jsrt_date_new` TimeClips its argument (§21.4.1.31): a value outside +-8.64e15 is
 * an Invalid Date, not a clamped one. `jsrt_date_from_value` is `new Date(x)` for a non-number x --
 * a string goes through the ISO parser, a Date copies its time value, anything else ToNumber. */
jsrt_value jsrt_date_new(double time);
/* The wall clock, in whole milliseconds since the epoch (§21.4.3.1). `jsrt_date_now` is the
 * `Date.now()` entry point; `jsrt_date_now_ms` is the same reading as a double, which is what
 * zero-argument `new Date()` hands to `jsrt_date_new`. Nothing else in the runtime reads a clock,
 * which is what keeps every other Date operation golden-testable. */
jsrt_value jsrt_date_now(void);
double jsrt_date_now_ms(void);
jsrt_value jsrt_date_from_value(jsrt_value v);
double jsrt_date_value(jsrt_value v);

/* The time value itself. `getTime` and `valueOf` are the same operation under two names. */
jsrt_value jsrt_date_get_time(jsrt_value v);
jsrt_value jsrt_date_set_time(jsrt_value v, jsrt_value ms);

/* The UTC field getters (§21.4.4.x). Every one answers NaN for an Invalid Date. `month` is
 * ZERO-based and `day` is the weekday, both as the language exposes them. */
jsrt_value jsrt_date_get_utc_full_year(jsrt_value v);
jsrt_value jsrt_date_get_utc_month(jsrt_value v);
jsrt_value jsrt_date_get_utc_date(jsrt_value v);
jsrt_value jsrt_date_get_utc_day(jsrt_value v);
jsrt_value jsrt_date_get_utc_hours(jsrt_value v);
jsrt_value jsrt_date_get_utc_minutes(jsrt_value v);
jsrt_value jsrt_date_get_utc_seconds(jsrt_value v);
jsrt_value jsrt_date_get_utc_milliseconds(jsrt_value v);

/* The UTC field setters (§21.4.4.2x). Each rebuilds the time value from the fields it is NOT
 * changing, so an out-of-range component ROLLS -- `setUTCMonth(13)` is February of the next year.
 * An omitted trailing component arrives as `undefined` and keeps its current value. All return the
 * new time value, and all mutate in place. */
jsrt_value jsrt_date_set_utc_full_year(jsrt_value v, jsrt_value year, jsrt_value month,
                                       jsrt_value day);
jsrt_value jsrt_date_set_utc_month(jsrt_value v, jsrt_value month, jsrt_value day);
jsrt_value jsrt_date_set_utc_date(jsrt_value v, jsrt_value day);
jsrt_value jsrt_date_set_utc_hours(jsrt_value v, jsrt_value h, jsrt_value mi, jsrt_value s,
                                   jsrt_value ms);
jsrt_value jsrt_date_set_utc_minutes(jsrt_value v, jsrt_value mi, jsrt_value s, jsrt_value ms);
jsrt_value jsrt_date_set_utc_seconds(jsrt_value v, jsrt_value s, jsrt_value ms);
jsrt_value jsrt_date_set_utc_milliseconds(jsrt_value v, jsrt_value ms);

/* The LOCAL field getters and setters (§21.4.4.x), and `getTimezoneOffset`. Same calendar
 * arithmetic as the UTC family over a shifted reading: the offset comes from libc `localtime_r`,
 * which owns the tzdb -- the runtime never carries zone rules of its own. A setter rebuilds a
 * WALL-CLOCK time and converts it back to an instant, which is not a bijection across a DST
 * transition; the spec's `UTC()` (§21.4.1.26) is what resolves the gap and the overlap.
 *
 * `getTimezoneOffset` answers MINUTES WEST of UTC -- the sign is inverted relative to the offset
 * itself, so UTC+2 reads -120. */
jsrt_value jsrt_date_get_full_year(jsrt_value v);
jsrt_value jsrt_date_get_month(jsrt_value v);
jsrt_value jsrt_date_get_date(jsrt_value v);
jsrt_value jsrt_date_get_day(jsrt_value v);
jsrt_value jsrt_date_get_hours(jsrt_value v);
jsrt_value jsrt_date_get_minutes(jsrt_value v);
jsrt_value jsrt_date_get_seconds(jsrt_value v);
jsrt_value jsrt_date_get_milliseconds(jsrt_value v);
jsrt_value jsrt_date_get_timezone_offset(jsrt_value v);
jsrt_value jsrt_date_set_full_year(jsrt_value v, jsrt_value year, jsrt_value month, jsrt_value day);
jsrt_value jsrt_date_set_month(jsrt_value v, jsrt_value month, jsrt_value day);
jsrt_value jsrt_date_set_date(jsrt_value v, jsrt_value day);
jsrt_value jsrt_date_set_hours(jsrt_value v, jsrt_value h, jsrt_value mi, jsrt_value s,
                               jsrt_value ms);
jsrt_value jsrt_date_set_minutes(jsrt_value v, jsrt_value mi, jsrt_value s, jsrt_value ms);
jsrt_value jsrt_date_set_seconds(jsrt_value v, jsrt_value s, jsrt_value ms);
jsrt_value jsrt_date_set_milliseconds(jsrt_value v, jsrt_value ms);

/* `new Date(y, m, d?, h?, mi?, s?, ms?)` (§21.4.2.1 steps 4-11). The same arithmetic as `Date.UTC`
 * -- two-digit-year rule included -- read as LOCAL time, which is the only difference between the
 * two and the reason this cannot just call `jsrt_date_utc`. */
jsrt_value jsrt_date_from_components(jsrt_value year, jsrt_value month, jsrt_value day,
                                     jsrt_value hours, jsrt_value minutes, jsrt_value seconds,
                                     jsrt_value ms);

/* The string forms that need no locale. `toISOString` PANICS on an Invalid Date, where the spec
 * throws a RangeError the runtime cannot raise until Phase 5 step 11; `toJSON` answers null there
 * instead, which is why `JSON.stringify(new Date(NaN))` is "null" rather than an abort. */
jsrt_value jsrt_date_to_iso_string(jsrt_value v);
jsrt_value jsrt_date_to_json(jsrt_value v);
jsrt_value jsrt_date_to_utc_string(jsrt_value v);
/* `toDateString` is the LOCAL calendar date alone. Its siblings `toString` and `toTimeString` are
 * NOT here as METHODS: both append the host zone's long display name, which Node sources from ICU and libc's
 * `%Z` cannot produce -- so they stay residue under STA1210 with the `toLocale*` family.
 * `jsrt_date_to_string` below is the narrower IMPLICIT form `"" + date` needs (plan.md §8 step 29):
 * the same fields, with the UTC long name special-cased where libc cannot supply it. */
jsrt_value jsrt_date_to_date_string(jsrt_value v);
jsrt_value jsrt_date_to_string(jsrt_value v);

/* The two statics. `Date.UTC` takes all seven components, absent ones as `undefined`; `Date.parse`
 * accepts the §21.4.1.32 Date Time String Format ONLY and answers NaN for anything else. */
jsrt_value jsrt_date_utc(jsrt_value year, jsrt_value month, jsrt_value day, jsrt_value hours,
                        jsrt_value minutes, jsrt_value seconds, jsrt_value ms);
jsrt_value jsrt_date_parse(jsrt_value text);

/* --------------------------------------------------------------- typed arrays (plan.md T11.1) */

/* `ArrayBuffer` and `Uint8Array` (docs/VALUE.md §4.19). Both are Object-tagged pointers whose first
 * word is the class descriptor, the prefix every builtin shares, so the tests below are pointer
 * comparisons. The storage is Zig (runtime/src/jsrt_typed.zig): `data` is a separate POINTER-FREE
 * collected block, so the collector never scans a byte as a reference, and it is never NULL -- an
 * empty buffer still owns a one-granule block.
 *
 * A view does not cache `buffer->data + byte_offset`: the collector would see an interior pointer,
 * and a view's bytes are reached through its buffer so a slice of a slice cannot outlive it. */
typedef struct JSRTArrayBuffer {
  const JSRTClass *cls; /* &jsrt_class_arraybuffer */
  uint8_t *data;
  size_t byte_length;
} JSRTArrayBuffer;

typedef struct JSRTTypedArray {
  const JSRTClass *cls;     /* &jsrt_class_uint8array */
  JSRTArrayBuffer *buffer;  /* the bytes this view reads and writes; shared by every subarray */
  size_t byte_offset;
  size_t length;            /* elements; equal to the byte length while Uint8Array is the only kind */
} JSRTTypedArray;

extern const JSRTClass jsrt_class_arraybuffer;
extern const JSRTClass jsrt_class_uint8array;

static inline bool jsrt_is_arraybuffer(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && ((const JSRTObject *)jsrt_ptr(v))->cls == &jsrt_class_arraybuffer;
}

static inline bool jsrt_is_uint8array(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && ((const JSRTObject *)jsrt_ptr(v))->cls == &jsrt_class_uint8array;
}

/* A view's bytes and length, as an extern `Uint8Array` parameter passes them (docs/FFI.md §2):
 * the pointer is the buffer's data block plus the view's offset, never a copy. Valid only while
 * the view stays rooted -- the generated call holds it in its argument slot, the buffer edge keeps
 * the block alive, and neither collector moves memory (docs/VALUE.md §4.19). The caller has
 * already proven the value a view (statically, or through jsrt_check_uint8array). */
static inline uint8_t *jsrt_uint8array_bytes(jsrt_value v) {
  const JSRTTypedArray *view = (const JSRTTypedArray *)jsrt_ptr(v);
  return view->buffer->data + view->byte_offset;
}

static inline size_t jsrt_uint8array_count(jsrt_value v) {
  return ((const JSRTTypedArray *)jsrt_ptr(v))->length;
}

/* `new ArrayBuffer(n)`: n zeroed bytes. A length ToIndex refuses is Node's RangeError. */
jsrt_value jsrt_arraybuffer_new(jsrt_value length);
jsrt_value jsrt_arraybuffer_byte_length(jsrt_value buffer);
/* `buf.slice(start, end)`: a COPY of the clamped range, as a new buffer. Absent bounds arrive as
 * `undefined`, which reads as 0 and the byte length, the spec's own defaults. */
jsrt_value jsrt_arraybuffer_slice(jsrt_value buffer, jsrt_value start, jsrt_value end);

/* `new Uint8Array(x, offset, length)` in every form §23.2.5.1 dispatches on the FIRST argument: a
 * non-object is a length (ToIndex), an ArrayBuffer is a view at `offset` for `length` bytes, a
 * typed array or an array is copied element by element (ToNumber, then ToUint8), any other
 * iterable is drained first, and anything else is read as an array-like. `offset`/`length` are
 * ignored unless `x` is a buffer. Absent arguments arrive as `undefined`. */
jsrt_value jsrt_uint8array_new(jsrt_value source, jsrt_value offset, jsrt_value length);
jsrt_value jsrt_uint8array_length(jsrt_value array);
jsrt_value jsrt_uint8array_byte_length(jsrt_value array);
jsrt_value jsrt_uint8array_byte_offset(jsrt_value array);
jsrt_value jsrt_uint8array_buffer(jsrt_value array);
/* `a[i]` and `a[i] = v`. An index that is not an integer in range reads `undefined` and drops the
 * write -- a typed array never grows and has no holes -- but the value is still converted first,
 * because §10.4.5.16 runs ToNumber before it asks whether the index is valid. A receiver that is
 * not a Uint8Array degrades to the dynamic access, the way `jsrt_array_get` does. */
jsrt_value jsrt_uint8array_get(jsrt_value array, jsrt_value index);
void jsrt_uint8array_put(jsrt_value array, jsrt_value index, jsrt_value value);
/* `subarray` shares the buffer; `slice` copies it. Both clamp relative bounds the way
 * `Array.prototype.slice` does. */
jsrt_value jsrt_uint8array_subarray(jsrt_value array, jsrt_value begin, jsrt_value end);
jsrt_value jsrt_uint8array_slice(jsrt_value array, jsrt_value start, jsrt_value end);
/* `a.set(source, offset)`: copies an array, a typed array or an array-like in at `offset`. An
 * overlapping typed source (a subarray of the same buffer) copies as if through a temporary, as
 * §23.2.3.26.1 requires. Answers `undefined`. */
jsrt_value jsrt_uint8array_set(jsrt_value array, jsrt_value source, jsrt_value offset);
/* The dynamic tier's view of both classes (`jsrt_get_prop` on an Unknown receiver): the data
 * properties, the index keys, and the methods as closures over the receiver -- the same contract
 * as `jsrt_array_method`. Answers false for a key neither class has, which reads `undefined`. */
bool jsrt_typed_get_prop(jsrt_value obj, const char *key, jsrt_value *out);
/* ToString of a view: the elements joined by "," (what `String(a)` and a template hole answer).
 * Not `join` itself -- that member, with its separator argument, has not landed. */
jsrt_value jsrt_uint8array_text(jsrt_value array);

extern const JSRTClass jsrt_class_regexp;

static inline JSRTRegExp *jsrt_as_regexp(jsrt_value v) { return (JSRTRegExp *)jsrt_ptr(v); }

static inline bool jsrt_is_regexp(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && jsrt_as_object(v)->cls == &jsrt_class_regexp;
}

/* `/source/flags`. Both arguments are strings; a pattern the engine refuses is a compile-time
 * error in every spelling the subset accepts, so this aborts with the STA2005 pattern rather than
 * answering with something that is not a regexp. */
jsrt_value jsrt_regexp_new(jsrt_value source, jsrt_value flags);

/* `new RegExp(pattern, flags)` and `RegExp(pattern, flags)` (§22.2.4.1), whose operands are data:
 * a RegExp pattern lends its source (and its flags when `flags` is undefined), anything else is
 * ToString'd, and undefined is the empty string. The source is escaped as Node prints it
 * (§22.2.6.13.1). A flag string or a pattern the engine refuses is a catchable SyntaxError with
 * V8's head; the reason after it is libregexp's wording (docs/VALUE.md §4.21). */
jsrt_value jsrt_regexp_construct(jsrt_value pattern, jsrt_value flags);

/* `re.test(s)` -- and the one operation that also WRITES `lastIndex`, for a /g or /y pattern. */
bool jsrt_regexp_test(jsrt_value re, jsrt_value str);

/* The regexp-taking String.prototype methods (§22.2.5). They live here rather than in
 * jsrt_string_ops.c because they are the ENGINE's algorithms: everything they do is a scan, and
 * the scan is the vendored executor. jsrt_string_ops.c dispatches to them on the pattern's tag. */
/* `re.exec(s)` -- RegExpBuiltinExec, §22.2.7.2. Answers the MATCH ARRAY (element 0 the whole match,
 * element g the g'th group, or `undefined` where a group did not participate) carrying `index`,
 * `input` and `groups`, or `null` when the pattern does not match. It reads and writes `lastIndex`
 * for a /g or /y pattern exactly as `test` does: they are one algorithm with two answers. */
jsrt_value jsrt_regexp_exec(jsrt_value re, jsrt_value str);

/* `s.match(re)` -- §22.2.5.6. Without /g this IS exec. With /g it resets `lastIndex` to 0 and
 * answers a PLAIN dense array of the whole-match strings -- the spec builds that one with
 * CreateArrayFromList, so it carries no properties -- or `null` when nothing matched. */
jsrt_value jsrt_regexp_match(jsrt_value re, jsrt_value str);
/* `s.matchAll(re)` — §22.1.3.14. Requires `/g` (STA2005 otherwise, the spec's TypeError).
 * Answers a boxed iterator of match arrays; the original regexp's lastIndex is not mutated. */
jsrt_value jsrt_regexp_match_all(jsrt_value re, jsrt_value str);
bool jsrt_regexp_match_all_step(jsrt_value re, jsrt_value str, jsrt_value *out);

/* ------------------------------------------------- the data-property surface (§22.2.6)
 *
 * All eleven properties are DERIVED -- nothing here is stored a second time. `source` and `flags`
 * are the strings `jsrt_regexp_new` normalized once (empty pattern -> `(?:)`, flags -> the spec's
 * canonical `dgimsuvy` order), and the eight flag predicates are one bit test each, which is why
 * they take the flag's LETTER: the LRE_FLAG_* constants live in the vendored header and generated
 * C must not need it. */
static inline jsrt_value jsrt_regexp_source(jsrt_value re) { return jsrt_as_regexp(re)->source; }
static inline jsrt_value jsrt_regexp_flags(jsrt_value re) { return jsrt_as_regexp(re)->flags; }
static inline jsrt_value jsrt_regexp_last_index(jsrt_value re) {
  return jsrt_number((double)jsrt_as_regexp(re)->last_index);
}

/* `re.global` and its seven siblings, by the flag letter: one of `dgimsuvy`. */
bool jsrt_regexp_flag(jsrt_value re, int letter);

/* `re.toString()` -- §22.2.6.13, which is `/source/flags` off the two normalized strings, so it
 * is always a spelling that parses back to an equal pattern. */
jsrt_value jsrt_regexp_to_string(jsrt_value re);

/* A regexp's data property or bound method by name, for a receiver the compiler only knows as
 * Unknown (`jsrt_get_prop`); false for a non-regexp or a name RegExp.prototype does not have here. */
bool jsrt_regexp_property(jsrt_value re, const char *key, jsrt_value *out);

jsrt_value jsrt_regexp_search(jsrt_value re, jsrt_value str);
jsrt_value jsrt_regexp_split(jsrt_value re, jsrt_value str);
jsrt_value jsrt_regexp_replace(jsrt_value re, jsrt_value str, jsrt_value replacement, bool all);

/* ---------------------------------------------------------------- arrays */

/* An array: `length` contiguous element slots, plus the named-property table below (empty for
 * every array but a RegExp match).
 *
 * `elements` is a separate allocation rather than a flexible array member, because `length` grows
 * (a write past the end extends the array) and a flexible member cannot move without invalidating
 * every `jsrt_value` that boxes this header. The header's address is therefore stable for the
 * array's whole life, which is what lets the emitter hold an array in a frame slot across a push.
 *
 * HOLES. ECMA-262 leaves an index below `length` genuinely ABSENT after `new Array(3)`, `a[5] = v`
 * on a shorter array, or `delete a[1]` -- `console.log` prints `<3 empty items>`, `1 in a` is false,
 * `forEach` skips it -- and a slot holding JSRT_HOLE is that absence (docs/VALUE.md §4.4). Storage
 * stays dense: a hole costs its slot. Only an array whose static element type is Unknown may gain
 * one, because a hole READS as `undefined` and a typed element would hand typed code a value its
 * type excludes: the emitter writes such an array through `jsrt_array_set_sparse` and every other
 * one through `jsrt_array_set`, which keeps refusing a write more than one past the end
 * (STA2002). */
typedef struct JSRTArray {
  uint32_t length;
  uint32_t capacity;
  jsrt_value *elements;
  /* The NAMED-property table an array carries only once something hangs a property off it -- today
   * that is exactly a RegExp match, whose `index`, `input` and `groups` are properties of the
   * result array (ECMA-262 §22.2.7.2). `shape == NULL` is "no properties", which is every ordinary
   * array: an empty table costs one NULL word, not an allocation.
   *
   * The layout is the dynamic object's, deliberately: jsrt_shape.c drives both through one walk, so
   * `m.index` resolves through the same shape chain and the same per-site inline cache a `{ }`
   * receiver uses. Indices stay in `elements` and never enter this table -- a match array is dense
   * over its capture groups, so the two never overlap. */
  JSRTShape *shape;
  jsrt_value *slots;
  uint32_t slot_capacity;
} JSRTArray;

/* Build an array from `count` initial elements; `items` may be NULL when `count` is 0. Returns an
 * already-boxed value because the header is reachable only through it. */
jsrt_value jsrt_array_new(uint32_t count, const jsrt_value *items);

/* The element-slot state of an absent index: undefined's tag with a payload no `undefined` VALUE
 * ever carries, so a collector scans it as an immediate and bit equality never mistakes it for
 * `undefined` (`indexOf(undefined)` skips a hole, as §23.1.3.17 requires). It is never a value:
 * every path that hands an element out answers `undefined` for it (`jsrt_unhole`) or skips it as
 * its spec step's HasProperty does. */
#define JSRT_HOLE JSRT_BOX(JSRT_TAG_UNDEFINED, 1)

static inline jsrt_value jsrt_unhole(jsrt_value element) {
  return element == JSRT_HOLE ? JSRT_UNDEFINED : element;
}

/* `Array(n)` / `new Array(n)` with its one argument (§23.1.1.1): a Number is a LENGTH -- that many
 * holes, or a catchable `RangeError: Invalid array length` when it is not a uint32 -- and anything
 * else is the sole element. */
jsrt_value jsrt_array_construct(jsrt_value arg);

static inline JSRTArray *jsrt_as_array(jsrt_value v) {
  return (JSRTArray *)jsrt_ptr(v);
}

/* The checked unbox every Array.prototype entry shares (plan.md §8 step 20, STA2008): a
 * statically-typed array that arrives as something else -- `var` hoisting hands the op
 * `undefined`, a lying annotation hands it anything -- used to reach `jsrt_as_array` above
 * unchecked and segfault. Answers NULL with a catchable TypeError pending instead: Node's
 * member-access wording for a nullish receiver (`Cannot read properties of undefined (reading
 * 'push')`, which is where Node throws for the same program), `Array.prototype.<method> called
 * on incompatible receiver` otherwise (Node's message names receiver SOURCE TEXT, which compiled
 * code no longer has, so only the nullish half can be Node-exact). Internal helpers keep the raw
 * unbox: they run on values a public entry already validated. */
JSRTArray *jsrt_require_array(jsrt_value array, const char *method);

/* The for-of counterpart (plan.md §8 step 20, STA2009): the sync array walk reads the header
 * directly instead of going through an entry, so it needs the check as its own statement before
 * the loop. Arrays pass silently; anything else leaves a catchable `X is not iterable` pending --
 * Node-exact for a nullish receiver, best-effort past it for the same source-text reason as
 * above. Only the array-kind operand takes this path; other static kinds have their own walks
 * and their own steps. */
void jsrt_require_array_iterable(jsrt_value value);

/* Shared `X is not iterable` throw for the dynamic GetIterator dispatch (plan.md §8 step 2a(c)):
 * the same rendering `jsrt_require_array_iterable` uses, so every for-of refusal names the
 * receiver the same way. Catchable, like STA2009's. */
void jsrt_throw_not_iterable(jsrt_value value);

/* `.length` as a Number, so the emitter never reads the struct field itself. */
jsrt_value jsrt_array_length(jsrt_value array);

/* Indexed read and write. Both take the index as a VALUE and convert it here: an index is an
 * arbitrary expression, and only the runtime knows whether it landed on an integer. A read outside
 * the array is `undefined` (ECMA-262, not an error); a write outside it extends the array. */
jsrt_value jsrt_array_get(jsrt_value array, jsrt_value index);
void jsrt_array_set(jsrt_value array, jsrt_value index, jsrt_value element);
/* The write an Unknown-element array takes (and every dynamic index write): past the end, the
 * skipped indices become holes instead of STA2002. */
void jsrt_array_set_sparse(jsrt_value array, jsrt_value index, jsrt_value element);
/* `delete a[i]` on an array: an index below `length` becomes a hole. Answers true, as the
 * operator does for an element (they are configurable). */
bool jsrt_array_delete(jsrt_value array, uint32_t index);

/* ------------------------------------------------------------- closures */

/* A captured-variable environment (plan-notes 50).
 *
 * One per scope that owns variables a nested function reads, chained through `parent` so a name
 * resolves to (levels-up, index) — both compile-time constants. The chain is over ENV-BEARING
 * scopes only, not over source nesting: a function that captures nothing contributes no level.
 *
 * `slots` is where the captured variables actually live. The declaring function reads and writes
 * them here rather than in its frame, which is what makes a write the outer function performs
 * after building a closure visible to that closure. */
typedef struct JSRTEnv {
  struct JSRTEnv *parent;
  uint32_t count;
  jsrt_value slots[]; /* C11 flexible array member */
} JSRTEnv;

/* Slots start as `undefined`, so a collection between allocation and the first store never scans
 * uninitialized memory -- the same discipline JSRT_FRAME follows. */
JSRTEnv *jsrt_env_new(JSRTEnv *parent, uint32_t count);
/* A fresh environment with the same parent and slot values. Closures created in a loop
 * iteration hold this copy, so a later increment of the loop binding is not visible to them. */
JSRTEnv *jsrt_env_clone(JSRTEnv *env);
/* Copy `src`'s slots into `dst` (same layout). Used to commit a per-iteration clone so the
 * next clone starts from the updated bindings. */
void jsrt_env_copy_slots(JSRTEnv *dst, const JSRTEnv *src);

/* One STATIC member of a class (docs/VALUE.md §4.17).
 *
 * A class's statics stay ordinary bindings wherever the compiler can NAME them (`C.count` reads
 * the declaring class's binding directly); this table is how a RUNTIME class value answers the
 * same questions -- an untyped `v.count`, or `this.count` inside a static method whose receiver
 * may be absent (a tear-off call). `slot` points at the binding's own storage (a module global
 * for a module-level class), so a write through the table and a write through the binding are
 * the same write. A descriptor carries its class's OWN statics; inheritance is the `parent` walk
 * a lookup makes, which is sound because statics cannot be overridden in this subset (one name
 * is one binding per chain). The table is terminated by a NULL `name`.
 *
 * `kind` says what the member is, which decides two behaviours: a read of a getter (or a write
 * of a setter) CALLS the slot's closure with the class object as receiver instead of loading
 * the slot, and `console.log` of a class prints its data fields only (Node's inspector skips
 * methods and accessors). */
#define JSRT_STATIC_FIELD 0
#define JSRT_STATIC_METHOD 1
#define JSRT_STATIC_GETTER 2
#define JSRT_STATIC_SETTER 3

typedef struct JSRTStaticEntry {
  const char *name; /* the property name as written; NULL terminates the table */
  jsrt_value *slot; /* the binding's storage -- read/written in place */
  uint8_t kind;
} JSRTStaticEntry;

/* A callable.
 *
 * `env` is NULL for a function that captures nothing, and such a closure stays a file-static
 * constant in the generated C -- rung 4a's zero-allocation path, unchanged. A function WITH
 * captures is heap-allocated once per evaluation of its function expression, which is what makes
 * two evaluations close over different variables.
 *
 * `fn` takes the environment even when it is NULL: `jsrt_call` dispatches through this pointer
 * without knowing which kind of closure it holds, so the signature cannot vary between them.
 *
 * `klass` is NULL for every ordinary function and names the descriptor for a CLASS OBJECT
 * (docs/VALUE.md §4.17) -- the value a class evaluates to. `fn` is then the class's constructor
 * (NULL when the class declares none, which constructs by allocation alone) and MUST NOT be
 * reached through `jsrt_call`: calling a class without `new` is Node's catchable TypeError.
 * `jsrt_construct` is the only caller of a class's `fn`. `arity`/`name` are the constructor's
 * declared arity and Node's `.name` for the class, so `Function.prototype.length`, `.name` and
 * `typeof` need no class-specific answer. The class's statics hang off `klass`'s descriptor. */
typedef struct JSRTClosure {
  jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);
  uint32_t arity;   /* declared parameters, i.e. Function.prototype.length -- never counts `this` */
  const char *name; /* "" for an anonymous function */
  JSRTEnv *env;     /* NULL when the function captures nothing */
  bool has_receiver; /* parameter zero is `this`; `jsrt_call` shifts when the caller omits it */
  const struct JSRTClass *klass;      /* NULL unless this is a class object */
  /* A `function` declaration or expression -- not an arrow, a method, an async function or a
   * generator, none of which JavaScript constructs. `new` builds through it (`jsrt_construct`),
   * and it has a `prototype`. False for a class object, whose construction is `klass`'s. */
  bool constructible;
  /* `F.prototype` once something read or wrote it: an ordinary function's prototype is created on
   * first observation (`jsrt_function_prototype`), so a function never constructed pays nothing. */
  bool has_prototype;
  jsrt_value prototype;
  /* The function's own enumerable properties (`f.count = 0`, `assert.sameValue = ...`), as a
   * dynamic object; NULL until the first write. A class object never has one: its statics are
   * its descriptor's (plan-notes 310). */
  struct JSRTDynObject *props;
} JSRTClosure;

static inline jsrt_value jsrt_closure(const JSRTClosure *c) {
  return JSRT_BOX(JSRT_TAG_CLOSURE, (uintptr_t)c);
}

/* Virtual dispatch: the receiver's OWN class answers, which is the whole point -- the slot came
 * from the static type, the entry comes from the dynamic one. The frontend emits this only where
 * it proved the table exists, so a NULL table here is a codegen bug, not a runtime condition. */
static inline jsrt_value jsrt_method(jsrt_value obj, uint32_t slot) {
  return jsrt_closure(jsrt_as_object(obj)->cls->methods[slot]);
}

/* The heap-allocated form, for a function that captures. Returns an already-boxed value because
 * the closure is reachable only through it. */
jsrt_value jsrt_closure_new(jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env),
                            uint32_t arity, const char *name, JSRTEnv *env, bool has_receiver);

/* Marks a fresh heap closure as a `function` that captures -- one `new` can build through
 * (`constructible`) -- and answers it. Nothing allocates between the two calls. */
jsrt_value jsrt_closure_constructible(jsrt_value closure);

/* `F.prototype` of an ordinary function: what was assigned, or -- for a constructible function
 * never asked before -- a fresh object whose hidden `constructor` is F, created now and kept.
 * `undefined` for a function that is not constructible and was never assigned one. */
jsrt_value jsrt_function_prototype(jsrt_value fn);

/* The closure every `jsrt_*_method` answers: environment slot 0 holds the receiver (kept alive by
 * the trace) and slot 1 the table row as a number, so `jsrt_call` needs no new protocol.
 * `has_receiver` is false: the receiver is already bound, and a second one in argv would shift
 * every user argument. `length` is the method's `length`, and `name` must outlive the program. */
jsrt_value jsrt_bound_method(jsrt_value receiver, uint32_t row,
                             jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env),
                             uint32_t length, const char *name);

static inline const JSRTClosure *jsrt_as_closure(jsrt_value v) {
  return (const JSRTClosure *)jsrt_ptr(v);
}

/* `fn.length`: the declared arity, which never counts a method's receiver (docs/VALUE.md §4.16).
 * The typed path's direct read; the dynamic path answers through `jsrt_get_prop` instead. */
uint32_t jsrt_closure_arity(jsrt_value v);

/* JavaScript arity is not C arity: a missing argument is `undefined` and an extra one is dropped.
 * Every generated callee reads its parameters through this, so neither is ever a read past the end
 * of `argv`. */
static inline jsrt_value jsrt_arg(uint32_t argc, const jsrt_value *argv, uint32_t i) {
  return i < argc ? argv[i] : JSRT_UNDEFINED;
}

/* `...rest` from argv[from] onward. An empty rest is a fresh empty array, not undefined. */
jsrt_value jsrt_args_rest(uint32_t argc, const jsrt_value *argv, uint32_t from);

/* Calling a non-function is a TypeError. Until Phase 5 step 11 gives the runtime a catch around
 * user code, it is fatal -- loud and located, rather than a jump through a garbage pointer.
 * (Phase 6 until 2026-09-01: the phase restructuring of plan-notes 116 moved the mechanism, and
 * Phase 6 is conformance fuzzing. Corrected in plan-notes 125.)
 *
 * A class object is a closure, but calling one without `new` is Node's catchable TypeError
 * (`Class constructor K cannot be invoked without 'new'`), never its constructor body: `fn` is
 * reached only through `jsrt_construct` below (docs/VALUE.md §4.17). */
jsrt_value jsrt_call(jsrt_value callee, uint32_t argc, const jsrt_value *argv);
/* Same as jsrt_call, with a `file:line` baked in so a non-function callee names the site
 * (STA2006). `loc` may be NULL, which keeps the unlocated TypeError for builtin-internal calls. */
jsrt_value jsrt_call_at(jsrt_value callee, uint32_t argc, const jsrt_value *argv, const char *loc);
/* A call whose arguments include a spread: `args` is the array of all of them. `receiver` is the
 * method call's receiver, passed to a closure that declares one, or NULL for a plain call. */
jsrt_value jsrt_call_spread_at(jsrt_value callee, const jsrt_value *receiver, jsrt_value args,
                               const char *loc);
/* A call the RUNTIME makes with a known `this` (ToPrimitive calling `toString`): a closure that
 * declares a receiver gets `receiver` in slot zero whatever its arity, anything else is
 * jsrt_call's call -- a class object's TypeError included. */
jsrt_value jsrt_call_with_this(jsrt_value callee, jsrt_value receiver, uint32_t argc,
                               const jsrt_value *argv);

/* `new v(...)`: the one caller of a class object's constructor (docs/VALUE.md §4.17).
 *
 * A class object allocates its instance (`jsrt_object_new`), then runs `fn` with the instance as
 * receiver and the arguments after it; the constructor's return is ignored, because the gate
 * admits no explicit object return in a constructor. A constructible function (`function F`)
 * builds a dynamic object whose prototype is `F.prototype`, runs F with it as `this`, and answers
 * F's return when that is an object, the new object otherwise (§10.2.2 [[Construct]], plan-notes
 * 310). Anything else -- an arrow, a method, a non-function -- leaves Node's catchable
 * `X is not a constructor` TypeError pending. */
jsrt_value jsrt_construct(jsrt_value ctor, uint32_t argc, const jsrt_value *argv);

/* ------------------------------------------------------------ promises */

/* A promise is an OBJECT with its own class descriptor, the way a Map is: `cls` first, compared
 * against the one `jsrt_class_promise` in the program. That is what lets `typeof`, `instanceof`
 * and the printer treat it as an object without knowing anything else about it.
 *
 * A reaction is a NATIVE continuation -- a C function plus GC-allocated state -- not a JS callback.
 * That is the whole shape of Phase 4's async: an async function's resume point and `Promise.all`'s
 * per-element handler are both reactions, so `.then` is not the mechanism, it is a future CLIENT
 * of the mechanism. Reactions run from the microtask queue and never inline, which is what makes
 * `await` observably asynchronous even when the awaited value has already settled. */

typedef void (*JSRTSettle)(void *state, jsrt_value value, bool rejected);

typedef struct JSRTReaction {
  JSRTSettle on_settle;
  void *state;
  struct JSRTReaction *next;
} JSRTReaction;

#define JSRT_PROMISE_PENDING 0u
#define JSRT_PROMISE_FULFILLED 1u
#define JSRT_PROMISE_REJECTED 2u

typedef struct JSRTPromise {
  const JSRTClass *cls; /* &jsrt_class_promise -- prefix-shared with JSRTObject */
  uint32_t state;
  /* §27.2.1.3.2's [[AlreadyResolved]]: the FIRST resolution -- a value, a rejection, or adopting
   * another promise -- wins, and every later call to the resolving functions is a no-op. It cannot
   * be read off `state`, because adoption leaves the promise PENDING while the inner one settles,
   * which is exactly the window in which `resolve(inner); reject(x)` used to reject. */
  bool resolved;
  jsrt_value value; /* the fulfilment value or the rejection reason; undefined while pending */
  /* Registration order is observable: reactions on one promise run in the order they subscribed,
   * so the list is appended to at `last` and drained from `first`. */
  JSRTReaction *first;
  JSRTReaction *last;
  /* Rejected with no reaction registered. The drain reports one rather than swallowing it, and a
   * later subscribe clears it -- which is exactly what "something is awaiting this" means. */
  bool unhandled;
} JSRTPromise;

extern const JSRTClass jsrt_class_promise;

static inline JSRTPromise *jsrt_as_promise(jsrt_value v) { return (JSRTPromise *)jsrt_ptr(v); }

static inline bool jsrt_is_promise(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && ((const JSRTObject *)jsrt_ptr(v))->cls == &jsrt_class_promise;
}


/* `x instanceof Array` / `Object` / `Function` / `Date` / `Map` / `Set` / `RegExp` / `Promise` /
 * `Error` and its four standard subclasses. Built-ins have tags (or a well-known `JSRTClass`
 * pointer), not a user descriptor. Boxed `Boolean`/`Number`/`String` have no representation yet and
 * answer false — which is a WRONG answer, not an absent one, and the reason the error classes are
 * handled here rather than left in that list: `e instanceof TypeError` silently answering false is
 * how a catch block mis-routes (plan.md §8 step 2a(c)). */
static inline bool jsrt_instanceof_builtin(jsrt_value v, const char *name) {
  {
    /* Checked first because the error names are the only ones that reach a chain walk: `Error`
     * must be true for every subclass, which is exactly what `parent` gives. */
    const JSRTClass *const error = jsrt_error_class(name);
    if (error != NULL) {
      return jsrt_instanceof(v, error);
    }
  }
  if (strcmp(name, "Array") == 0) {
    return jsrt_is(v, JSRT_TAG_ARRAY);
  }
  if (strcmp(name, "Function") == 0) {
    return jsrt_is(v, JSRT_TAG_CLOSURE);
  }
  if (strcmp(name, "Object") == 0) {
    return jsrt_is_object(v);
  }
  if (strcmp(name, "Date") == 0) {
    return jsrt_is_date(v);
  }
  if (strcmp(name, "RegExp") == 0) {
    return jsrt_is_regexp(v);
  }
  if (strcmp(name, "Promise") == 0) {
    return jsrt_is_promise(v);
  }
  if (strcmp(name, "Uint8Array") == 0) {
    return jsrt_is_uint8array(v);
  }
  if (strcmp(name, "ArrayBuffer") == 0) {
    return jsrt_is_arraybuffer(v);
  }
  if (strcmp(name, "Map") == 0 || strcmp(name, "Set") == 0 || strcmp(name, "WeakMap") == 0 ||
      strcmp(name, "WeakSet") == 0) {
    /* The class descriptor's name IS the constructor's: a WeakMap is not `instanceof Map`. */
    return jsrt_is_map_or_set(v) && strcmp(jsrt_as_object(v)->cls->name, name) == 0;
  }
  return false;
}

jsrt_value jsrt_promise_new(void);

/* Settles a pending promise and queues its reactions. Settling an already-settled promise is a
 * no-op, not an error: the spec's resolving functions are idempotent, and both `Promise.all` and
 * an async body's landing pad can reach a settle twice on the same value.
 *
 * Fulfilling WITH a promise adopts it instead of nesting: the outer promise settles when the inner
 * one does. That is §27.2.1.3.2's thenable step, restricted to the only thenables that exist here,
 * and it is what makes `return somePromise` inside an async function mean what it means. */
void jsrt_promise_settle(jsrt_value promise, jsrt_value value, bool rejected);

/* Registers a reaction. If the promise has already settled, the reaction is queued immediately --
 * queued, never called, so the ordering rule holds for a settled promise too. */
void jsrt_promise_subscribe(jsrt_value promise, JSRTSettle on_settle, void *state);

jsrt_value jsrt_promise_resolve(jsrt_value v);      /* Promise.resolve: passes a promise through */
jsrt_value jsrt_promise_reject(jsrt_value reason);  /* Promise.reject */
jsrt_value jsrt_promise_all(jsrt_value array);      /* Promise.all over an ARRAY, the only iterable
                                                     * the subset can hand it */
jsrt_value jsrt_promise_then(jsrt_value promise, jsrt_value on_fulfilled, jsrt_value on_rejected);
jsrt_value jsrt_promise_catch(jsrt_value promise, jsrt_value on_rejected);
jsrt_value jsrt_promise_finally(jsrt_value promise, jsrt_value on_finally);
jsrt_value jsrt_promise_construct(jsrt_value executor); /* new Promise(executor) */

/* The event loop, such as it is: drain the microtask queue until it is empty. Generated `main`
 * calls it once, after the module body, and that is the whole loop until timers or I/O exist to
 * need more (plan.md Task 4.6). */
/* Internal std/thread bridge; main alone owns Promise state. */
bool jsrt_thread_poll(void);
bool jsrt_thread_is_worker(void);
double jsrt_thread_pool_started(void); /* internal lifecycle probe, main-only */
void jsrt_thread_require_main(void);
void jsrt_gc_safepoint(void);
void jsrt_gc_collect(void);
void jsrt_shape_metadata_lock(void);
void jsrt_shape_metadata_unlock(void);
jsrt_value jsrt_gc_handoff(jsrt_value value);
void jsrt_run_microtasks(void);

/* ---------------------------------------------------------- async bodies */

/* An async function compiles to two C functions: a CONSTRUCTOR that builds the environment holding
 * every local and calls jsrt_async_start, and a RESUME body that is re-entered once per await with
 * the awaited value. `state` is the resume label; generated C writes it before suspending and
 * switches on it on the way back in. The environment is where the locals live -- which is why
 * an async body's bindings are forced into the env rather than onto the C stack, whose frame does
 * not survive a suspension. */
typedef struct JSRTAsync JSRTAsync;
typedef void (*JSRTResume)(JSRTAsync *self, jsrt_value value, bool rejected);

struct JSRTAsync {
  JSRTEnv *env;
  JSRTResume resume;
  jsrt_value promise; /* what the call returned, settled by jsrt_async_return/throw */
  uint32_t state;
};

/* Runs the body synchronously up to its first await or its completion -- an async function's
 * prefix is NOT deferred -- and returns the promise the call evaluates to. */
jsrt_value jsrt_async_start(JSRTEnv *env, JSRTResume resume);

/* Suspends: subscribe this body's resume to `awaited`, wrapping a non-promise in a settled one so
 * that `await 1` still yields to the microtask queue, as the spec requires. */
void jsrt_await(JSRTAsync *self, jsrt_value awaited);

void jsrt_async_return(JSRTAsync *self, jsrt_value value);
void jsrt_async_throw(JSRTAsync *self, jsrt_value reason);

/* ---------------------------------------------------------- generators (Phase 5 step 8)
 *
 * A generator is an iterator whose cursor is a resume point, not an index. Calling the function
 * ALLOCATES the object and does not run the body -- the first `next()` does. `sent` is what a
 * subsequent `next(v)` injects as the value of the `yield` that suspended.
 *
 * `return(v)`/`throw(e)` re-enter the suspended body with an INJECTION rather than a value:
 * `inject` tells the generated resume prologue, at the label the suspension parked on, to route
 * a synthetic `return v` (through any finally blocks, exactly as a real return would) or to
 * rethrow `e` at the yield's own landing pad. The resume prologue clears the mode before the
 * body runs again, so a yield from inside a finally of an injected return resumes ordinarily.
 * State 0 is "never started": `return` closes it without running the body and `throw` rethrows
 * the value to its caller (ECMA-262 27.5.1.4), both without a resume call. */
#define JSRT_GEN_INJECT_NONE 0
#define JSRT_GEN_INJECT_RETURN 1
#define JSRT_GEN_INJECT_THROW 2

typedef struct JSRTGenerator JSRTGenerator;
typedef void (*JSRTGenResume)(JSRTGenerator *self, jsrt_value sent);

struct JSRTGenerator {
  const JSRTClass *cls; /* &jsrt_class_generator -- prefix-shared with JSRTObject */
  JSRTEnv *env;
  JSRTGenResume resume;
  uint32_t state;
  jsrt_value yielded;
  bool done;
  uint8_t inject; /* JSRT_GEN_INJECT_*; read and cleared by the resume prologue */
};

extern const JSRTClass jsrt_class_generator;

jsrt_value jsrt_generator_new(JSRTEnv *env, JSRTGenResume resume);
void jsrt_generator_yield(JSRTGenerator *self, jsrt_value value);
/* Body-side settle: the body ran off its end or executed `return`. NOT the `gen.return()` method
 * -- that is jsrt_generator_close below, and the two must never share a name. */
void jsrt_generator_return(JSRTGenerator *self, jsrt_value value);
/* `gen.return(v)` / `gen.throw(e)` — Generator.prototype's two closing methods. Answer
 * `{ value, done }`; a thrown value that the body does not catch stays pending for the call site,
 * which is the generated-code convention for a user call that throws. */
jsrt_value jsrt_generator_close(jsrt_value gen, jsrt_value value);
jsrt_value jsrt_generator_throw(jsrt_value gen, jsrt_value value);
static inline bool jsrt_is_generator(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && jsrt_as_object(v)->cls == &jsrt_class_generator;
}

/* ------------------------------------------------------------- typeof */

/* The string ECMA-262's `typeof` produces, as a C literal with static storage.
 *
 * Seven answers, and two of them are famously not the ones a tag would give: `typeof null` is
 * "object" (the original 1995 bug, now normative), and a callable is "function" even though a
 * function IS an object everywhere else in this header -- which is why this is a switch on the tag
 * and not a call to jsrt_is_object. */
const char *jsrt_type_name(jsrt_value v);

/* `typeof x`. The string, boxed. */
jsrt_value jsrt_typeof(jsrt_value v);

/* ---------------------------------------------------------- boundary checks */

/* STA2001. A value crossing INTO typed code is checked against the type the program claimed for
 * it, and a mismatch is a located runtime error rather than a value the compiled code then reads
 * as if the claim were true (plan.md §0.2, golden rule 4).
 *
 * Each returns `v` unchanged when the check passes, so a check composes as an expression and the
 * emitter can wrap a value in place. `where` is "file.ts:line:col", baked into the generated C as
 * a string literal -- the check knows the source location because the emitter knew it, and nothing
 * has to be reconstructed from a stack at the point of failure.
 *
 * The number check accepts either numeric tag: a double and an int32 are one type to the language,
 * and which one a value happens to be boxed as is the runtime's business, not the program's. */
jsrt_value jsrt_check_number(jsrt_value v, const char *where);
jsrt_value jsrt_check_string(jsrt_value v, const char *where);
jsrt_value jsrt_check_boolean(jsrt_value v, const char *where);
/* A `Uint8Array` extern argument (docs/FFI.md §2): the one non-primitive check, because the
 * emitter reads the view's layout straight after it. */
jsrt_value jsrt_check_uint8array(jsrt_value v, const char *where);

/* --------------------------------------------------------------- output */

void jsrt_print(jsrt_value v); /* console.log semantics: prints -0 as "-0" */
void jsrt_eprint(jsrt_value v);      /* console.error/warn: same form, stderr */
/* The variadic console form (plan.md §8 step 18): inspects every argument with the bare-string
 * exception and joins the forms with one space; no arguments prints the bare newline. The argv
 * points at the caller's rooted frame slots on the `jsrt_array_new` discipline. */
void jsrt_print_many(uint32_t count, const jsrt_value *args); /* stdout: log/info/debug */
void jsrt_eprint_many(uint32_t count, const jsrt_value *args); /* stderr: error/warn */
void jsrt_console_dir(jsrt_value v); /* console.dir: inspect form, no bare-string exception */
/* console.table: the box-drawn grid, over an array or a plain object. Anything else falls back to
 * console.log, which is Node's own rule for a value that is not a collection of rows. */
void jsrt_console_table(jsrt_value v);
/* console.group/assert take their optional argument by ENTRY POINT, not by a JSRT_UNDEFINED
 * sentinel: Node prints an explicitly passed undefined ("undefined"; "Assertion failed undefined")
 * where the omitted form prints nothing, so the two forms are genuinely two calls. The lowering
 * therefore pads neither -- contrast count/countReset below, where the spec's own absent case IS
 * undefined and one entry point serves both. */
void jsrt_console_group(jsrt_value label);
void jsrt_console_group_bare(void);
void jsrt_console_group_end(void);
void jsrt_console_assert(jsrt_value condition, jsrt_value message);
void jsrt_console_assert_bare(jsrt_value condition);
jsrt_value jsrt_console_count(jsrt_value label);       /* label may be JSRT_UNDEFINED: "default" */
jsrt_value jsrt_console_count_reset(jsrt_value label); /* same, and prints nothing */
/* The three determinism carve-out members (plan.md §7 Task 4.2): a duration measures THIS run and
 * a stack is frames this runtime does not have, so neither can be pinned to Node byte-for-byte.
 * `time` prints nothing; `timeEnd` prints `label: <duration>` on stdout, and nothing at all for a
 * label that was never started; `trace` prints `Trace[: message]` on STDERR without frames. */
jsrt_value jsrt_console_time(jsrt_value label);
jsrt_value jsrt_console_time_end(jsrt_value label);
void jsrt_console_trace(jsrt_value message);
void jsrt_console_trace_bare(void);
/* ECMA-262 ToString: -0 becomes "0". An object goes through ToPrimitive with hint `string`, so a
 * `toString` (or `valueOf`) the program wrote RUNS here and may throw: the exception is left
 * pending and the answer is the empty string, which no caller may use before it checks
 * jsrt_pending() (plan.md §9 Task 6.27). */
jsrt_value jsrt_to_string(jsrt_value v);
/* What the builtin prototypes' own `toString` answers for an object -- `[object Object]`, an
 * array's join, a Date's or an Error's text -- never a method the program wrote. ToPrimitive's
 * fallback when the program wrote none, and the rendering a runtime error MESSAGE uses, which must
 * not call into the program (Node names such an operand without converting it). */
jsrt_value jsrt_builtin_to_string(jsrt_value v);
/* util.format's `builtInObjects` (lib/internal/util/inspect.js, Node v26.7.0): the globals whose
 * name, as a holder's `constructor.name`, makes `%s` inspect an object instead of calling its
 * `toString`. The list is the pinned Node's, measured, and a unit test re-measures it. */
bool jsrt_is_builtin_constructor_name(const char *name);

/* ----------------------------------------------------------- exceptions */

/* One pending exception per thread -- return-value + landing-pad style, never setjmp/longjmp
 * (plan.md §2: bad codegen interactions, GC-root problems). The contract with generated C:
 *
 *   - `throw e` compiles to `jsrt_throw(v); goto <pad>;`.
 *   - After every call that can run user code, generated C checks `jsrt_pending()` and jumps to
 *     the nearest landing pad: a catch, a finally, or the function's unwind pad, which pops the
 *     shadow frame and returns. The return VALUE of an unwinding call is JSRT_UNDEFINED and
 *     meaningless -- the pending flag is the channel, not the value.
 *   - A pad that handles the exception calls `jsrt_take_exception()` exactly once, which clears
 *     the flag and hands over the value. Not clearing it would make every later call in the
 *     handler appear to throw.
 *
 * ROOTING INVARIANT: between jsrt_throw and jsrt_take_exception the stored value may be the only
 * reference to a heap object, so the collector traces the pending slot as a root alongside the
 * frame chain. That is not hypothetical: a `finally` on the way out runs arbitrary code, and the
 * cell is static storage, which a conservative collector cannot read a boxed value out of any
 * more than it can read one out of the heap (plan-notes 108). `jsrt_pending_slot` is how the
 * collector reaches it; nothing else may call it. */
void jsrt_throw(jsrt_value v);
/* Throws a bare STRING. Kept for the two callers that have no better answer yet; everything the
 * spec calls a TypeError/RangeError/... goes through jsrt_throw_error, so that a `catch` can read
 * `.name`, `.message` and `instanceof` the way it does in Node (plan.md §8 step 2a(c)). */
void jsrt_throw_str(const char *msg);
bool jsrt_pending(void);
jsrt_value jsrt_take_exception(void);
jsrt_value *jsrt_pending_slot(void);

/* A runtime-side invoke that turns a pending throw into a completion value so a builtin can
 * settle a promise (or otherwise handle it) instead of unwinding into library C. docs/VALUE.md §4.9. */
typedef struct JSRTCompletion {
  jsrt_value value;
  bool threw;
} JSRTCompletion;
JSRTCompletion jsrt_call_protected(jsrt_value callee, uint32_t argc, const jsrt_value *argv);

/* The pad of last resort: main's. Prints the value to STDERR and exits 1 -- stdout stays clean,
 * which is what the golden runner compares, and the exit code is what Node observably does with
 * an uncaught throw. */
_Noreturn void jsrt_uncaught(void);

/* ------------------------------------------------------- rooting protocol */

/* `env` is how a captured-variable environment stays rooted (plan-notes 50). An env is reachable
 * by tracing a closure, but only once a closure has been built from it and only while that closure
 * is alive -- neither holds between `jsrt_env_new` and the first `jsrt_closure_new`, nor in a
 * function still reading its own captured locals after every closure it made has died. The frame
 * is the unit of the exact root set, so the collector traces `frame->env` alongside the slots.
 * NULL for the overwhelming majority of frames, whose function captures nothing. */
typedef struct JSRTFrame {
  struct JSRTFrame *prev;
  uint32_t count;
  jsrt_value *slots;
  struct JSRTEnv *env;
} JSRTFrame;

extern _Thread_local JSRTFrame *jsrt_frame_top;

void jsrt_frame_init(JSRTFrame *frame);

/* The native stack guard (plan.md §9 Task 6.23, docs/VALUE.md §4.25). Every generated function opens
 * with JSRT_STACK_CHECK() BEFORE its JSRT_FRAME, so the early return has no frame to pop: it leaves
 * Node's catchable `RangeError: Maximum call stack size exceeded` pending and returns undefined,
 * and the caller's pending check unwinds as for any throw. `jsrt_stack_limit` is the lowest frame
 * address a generated function may open at on this thread; jsrt_init sets it from the thread's real
 * stack bounds, leaving headroom for the runtime code the deepest frame still calls. It is 0 on a
 * thread jsrt_init never ran on, which disables the check rather than failing every call. */
extern _Thread_local uintptr_t jsrt_stack_limit;
jsrt_value jsrt_stack_overflow(void);
#define JSRT_STACK_CHECK()                                                               \
  do {                                                                                   \
    if (__builtin_expect((uintptr_t)__builtin_frame_address(0) < jsrt_stack_limit, 0)) { \
      return jsrt_stack_overflow();                                                      \
    }                                                                                    \
  } while (0)

/* Slots are filled with JSRT_UNDEFINED and only THEN is the frame published to jsrt_frame_top,
 * so a collection triggered mid-prologue can never scan an uninitialized slot. */
#define JSRT_FRAME(n)                                                          \
  jsrt_value _jsrt_slots[(n)];                                                 \
  JSRTFrame _jsrt_frame = {jsrt_frame_top, (uint32_t)(n), _jsrt_slots, NULL};  \
  jsrt_frame_init(&_jsrt_frame);                                               \
  jsrt_frame_top = &_jsrt_frame

#define JSRT_LOCAL(i) (_jsrt_slots[(i)])

/* Publishes this function's own environment as a root, immediately after allocating it. Separate
 * from JSRT_FRAME because the env's own construction may need the frame to already exist. */
#define JSRT_FRAME_ENV(e) (_jsrt_frame.env = (e))

/* A captured variable, `levels` env-bearing scopes out from `e`. `levels` is 0 for the function's
 * own env and counts only scopes that own captured variables, so it is a constant the emitter
 * computes from capture analysis, never a search. */
#define JSRT_ENV_AT(e, levels, i) (jsrt_env_up((e), (levels))->slots[(i)])

static inline JSRTEnv *jsrt_env_up(JSRTEnv *env, uint32_t levels) {
  for (uint32_t k = 0; k < levels; k++) {
    env = env->parent;
  }
  return env;
}

/* INVARIANT: on every path leaving a function -- normal return, early return, landing pad --
 * the count of JSRT_FRAME_POP() executed equals the count of JSRT_FRAME() entered. A skipped
 * pop leaves a frame pointing at dead stack: a crash under a precise GC, and an invisible time
 * bomb under Boehm that only surfaces when §12 lands. */
#define JSRT_FRAME_POP() (jsrt_frame_top = _jsrt_frame.prev)

/* Module-level bindings outlive `main`'s frame -- a function called from anywhere still reads them,
 * and rung 4a has no environment structs to hold them instead -- so they live in a file-static
 * array whose frame is pushed once at startup and deliberately never popped. `JSRT_GLOBAL(i)` is
 * the same kind of lvalue as `JSRT_LOCAL(i)`, in that array rather than on the stack. */
#define JSRT_GLOBALS(n)                    \
  static jsrt_value _jsrt_globals[(n)];    \
  static JSRTFrame _jsrt_global_frame

#define JSRT_GLOBALS_ENTER(n)                          \
  do {                                                 \
    _jsrt_global_frame.prev = jsrt_frame_top;          \
    _jsrt_global_frame.count = (uint32_t)(n);          \
    _jsrt_global_frame.slots = _jsrt_globals;          \
    jsrt_frame_init(&_jsrt_global_frame);              \
    jsrt_frame_top = &_jsrt_global_frame;              \
  } while (0)

#define JSRT_GLOBAL(i) (_jsrt_globals[(i)])

/* JSRT_FRAME_ENV's counterpart for module scope, where the live frame is the globals frame rather
 * than a `JSRT_FRAME(n)` on the stack. A module owns an environment only when a top-level loop
 * declares a `let`/`const` that a closure captures: those bindings are per-iteration, so one
 * global slot cannot hold them (docs/VALUE.md §4.3). Rooting them through the globals frame is
 * what makes them outlive `main`'s locals, exactly as the globals array does. */
#define JSRT_GLOBALS_ENV(e) (_jsrt_global_frame.env = (e))

/* ------------------------------------------------------------- lifecycle */

/* Asserts the 48-bit pointer assumption against a real allocation, then initializes the GC.
 * Fails loudly at startup rather than corrupting values on a platform where it does not hold. */
void jsrt_init(void);

/* The process slots (src/jsrt_process.c): the generated `main` hands its argument vector to
 * `jsrt_process_args` right after `jsrt_init` and returns `jsrt_process_exit_code()`.
 * `std/process` binds the other four as `@statorExtern` functions, so their spellings are the
 * emitter's extern ones (`double` for a number, `char *` for a returned string) — a generated unit
 * that declares one again must match this declaration exactly. */
void jsrt_process_args(int argc, char **argv);
double jsrt_process_argc(void);
char *jsrt_process_argv(double index);
double jsrt_process_exit_code(void);
void jsrt_process_set_exit_code(double code);

#endif /* JSRT_VALUE_H */
