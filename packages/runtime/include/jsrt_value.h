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

typedef struct JSString {
  uint32_t length;  /* UTF-16 code units -- not bytes, not code points */
  uint16_t data[];  /* flexible array member; NOT NUL-terminated */
} JSString;

/* Generated C touches string contents only through these two, never ->data[i] directly, so that
 * rope/small-string representations stay a runtime-only change (docs/VALUE.md §2). */
uint32_t jsrt_string_length(jsrt_value v);
uint16_t jsrt_string_char(jsrt_value v, uint32_t i);

/* String construction from UTF-8 bytes. */
jsrt_value jsrt_string_from_utf8(const char *bytes, size_t len);

/* String construction from UTF-16 code units, copied verbatim (lone surrogates included). */
jsrt_value jsrt_string_from_units(const uint16_t *units, uint32_t len);

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

/* ToPrimitive (ECMA-262 §7.1.1, docs/NUMERIC.md §7): the conversion every other abstract
 * operation runs FIRST when handed an object. A primitive passes through untouched.
 *
 * There is no `hint` parameter, and that is a fact about the subset rather than a shortcut: the
 * hint only selects whether `valueOf` or `toString` is tried first, and this subset has neither a
 * user-written `valueOf` nor a `Symbol.toPrimitive` (STA1212, Phase 5). The inherited
 * `Object.prototype.valueOf` returns the object itself -- not a primitive -- so BOTH hints fall
 * through to `toString` for every object that exists here, and the two hints cannot be told apart.
 * Adding user methods is what makes the hint observable; add the parameter then, not before. */
jsrt_value jsrt_to_primitive(jsrt_value v);

/* ToNumber: convert a jsrt_value to a double. An object is run through ToPrimitive first.
 * Handles double, boolean, null, undefined, string, and Int32. */
double jsrt_to_number(jsrt_value v);

/* StringNumericLiteral: parse a string value as a number.
 * Not strtod: rejects trailing garbage, handles hex (0x10 = 16), trims whitespace.
 * Non-ASCII code units -> NaN. */
double jsrt_string_to_number(jsrt_value s);

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
   * whose methods capture: such a closure is not one constant per class. */
  uint32_t method_count;
  const struct JSRTClosure *const *methods;
  /* Slot indices in PROPERTY-INSERTION order, or NULL when insertion order IS slot order.
   *
   * A fixed shape's slot order is the LAYOUT -- what `o.x` resolves against, and therefore a
   * property of the TYPE, which the checker may list in a different order than the literal wrote
   * (`const o: { y: number; x: string } = { x: "s", y: 2 }`, and every object spread). Enumeration
   * order is a different fact: §10.1.11 OrdinaryOwnPropertyKeys answers in insertion order, which
   * only the allocating literal knows. Keeping both means a reordering annotation and a spread
   * store to the right slots AND print the way Node prints (plan-notes 181).
   *
   * Length is field_count when present; every slot appears exactly once. */
  const uint32_t *key_order;
  /* The class's own `[Symbol.iterator]()` when declared, or NULL. Runtime GetIterator walks the
   * parent chain for the first non-NULL entry (docs/VALUE.md §4.13). */
  const struct JSRTClosure *iterator_method;
} JSRTClass;

/* The slot the i-th enumerated property lives in. Identity when a class declares no reordering --
 * a class declaration's fields are laid out in the order they are written, so it never does. */
static inline uint32_t jsrt_class_key_slot(const JSRTClass *cls, uint32_t i) {
  return cls->key_order == NULL ? i : cls->key_order[i];
}

struct JSRTClosure;

/* Unlike JSRTArray, the elements ARE a flexible member here, and that is safe for the reason it is
 * unsafe there: an object's slot count is fixed by its class at construction and the subset has no
 * way to add a property, so this allocation never grows and therefore never moves. If dynamic
 * property addition ever lands, it does NOT get to grow this -- it gets an overflow table, or the
 * header's address stops being stable and every boxed reference to it becomes wrong. */
typedef struct JSRTObject {
  const JSRTClass *cls;
  bool frozen; /* Object.freeze: writes throw TypeError (Phase 5 step 11) */
  jsrt_value fields[];
} JSRTObject;

/* Every slot starts as `undefined`, which is what a declared-but-unassigned field reads as in
 * JavaScript. The constructor body then assigns the ones it assigns. */
jsrt_value jsrt_object_new(const JSRTClass *cls);

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

/* A shape key from a JS string: an immortal NUL-terminated UTF-8 copy, the lifetime the shape
 * table already gives every key. A key containing U+0000 aborts -- a C string cannot hold one. */
const char *jsrt_shape_key(jsrt_value name);
/* Reading a property the object does not have is `undefined` -- that IS the semantics of an
 * optional property. A miss is never cached: the same object can gain the key later. */
jsrt_value jsrt_get_prop(jsrt_value obj, const char *key, JSRTIC *ic);
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
 * mutate in place and return the receiver. */
jsrt_value jsrt_array_push(jsrt_value array, jsrt_value element);
jsrt_value jsrt_array_pop(jsrt_value array);
jsrt_value jsrt_array_shift(jsrt_value array);
jsrt_value jsrt_array_unshift(jsrt_value array, jsrt_value element);
jsrt_value jsrt_array_at(jsrt_value array, jsrt_value index);
jsrt_value jsrt_array_index_of(jsrt_value array, jsrt_value search, jsrt_value from);
jsrt_value jsrt_array_last_index_of(jsrt_value array, jsrt_value search);
jsrt_value jsrt_array_includes(jsrt_value array, jsrt_value search, jsrt_value from);
jsrt_value jsrt_array_join(jsrt_value array, jsrt_value separator);
jsrt_value jsrt_array_slice(jsrt_value array, jsrt_value start, jsrt_value end);
jsrt_value jsrt_array_concat(jsrt_value array, jsrt_value other);
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
/* Two-argument form only; returns the removed run. */
jsrt_value jsrt_array_splice(jsrt_value array, jsrt_value start, jsrt_value delete_count);
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

/* Object.keys/values/entries (§20.1.2) over the two object layouts — runtime/src/jsrt_object_ops.c.
 * Fixed shapes enumerate declaration-order public identifiers (private #name slots are omitted);
 * dynamic shapes apply the full OrdinaryOwnPropertyKeys order because Object.fromEntries/JSON.parse
 * can create integer keys. */
jsrt_value jsrt_object_keys(jsrt_value v);
jsrt_value jsrt_object_values(jsrt_value v);
jsrt_value jsrt_object_entries(jsrt_value v);
jsrt_value jsrt_object_get_own_property_names(jsrt_value v);
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

jsrt_value jsrt_map_new(void);
jsrt_value jsrt_set_new(void);

static inline JSRTMap *jsrt_as_map(jsrt_value v) { return (JSRTMap *)jsrt_ptr(v); }

/* True for a Map or a Set -- the test the printer runs before treating an object as a class
 * instance, since both carry the object tag. */
static inline bool jsrt_is_map_or_set(jsrt_value v) {
  if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
    return false;
  }
  const JSRTClass *cls = jsrt_as_object(v)->cls;
  return cls == &jsrt_class_map || cls == &jsrt_class_set;
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
/* Iterator object returned from a well-known `Symbol.iterator` call on an unknown iterable. The
 * target is that object; each step calls its `next()` (docs/VALUE.md §4.13). */
#define JSRT_ITER_PROTOCOL 11

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
jsrt_value jsrt_iterator_next(jsrt_value it, jsrt_value sent);
bool jsrt_iterator_step(jsrt_value it, jsrt_value *out);
/* GetIterator (ECMA-262): specialized tag dispatch first, then the well-known iterator method.
 * Answers a boxed walk, a generator, or a protocol iterator; throws a catchable TypeError when the
 * value is nullish or has no usable `Symbol.iterator` (plan.md §8 step 2a(c)). */
jsrt_value jsrt_get_iterator(jsrt_value obj);

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
 * NOT here: both append the host zone's long display name, which Node sources from ICU and libc's
 * `%Z` cannot produce -- so they stay residue under STA1210 with the `toLocale*` family. */
jsrt_value jsrt_date_to_date_string(jsrt_value v);

/* The two statics. `Date.UTC` takes all seven components, absent ones as `undefined`; `Date.parse`
 * accepts the §21.4.1.32 Date Time String Format ONLY and answers NaN for anything else. */
jsrt_value jsrt_date_utc(jsrt_value year, jsrt_value month, jsrt_value day, jsrt_value hours,
                        jsrt_value minutes, jsrt_value seconds, jsrt_value ms);
jsrt_value jsrt_date_parse(jsrt_value text);

extern const JSRTClass jsrt_class_regexp;

static inline JSRTRegExp *jsrt_as_regexp(jsrt_value v) { return (JSRTRegExp *)jsrt_ptr(v); }

static inline bool jsrt_is_regexp(jsrt_value v) {
  return jsrt_is(v, JSRT_TAG_OBJECT) && jsrt_as_object(v)->cls == &jsrt_class_regexp;
}

/* `/source/flags`. Both arguments are strings; a pattern the engine refuses is a compile-time
 * error in every spelling the subset accepts, so this aborts with the STA2005 pattern rather than
 * answering with something that is not a regexp. */
jsrt_value jsrt_regexp_new(jsrt_value source, jsrt_value flags);

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

jsrt_value jsrt_regexp_search(jsrt_value re, jsrt_value str);
jsrt_value jsrt_regexp_split(jsrt_value re, jsrt_value str);
jsrt_value jsrt_regexp_replace(jsrt_value re, jsrt_value str, jsrt_value replacement, bool all);

/* ---------------------------------------------------------------- arrays */

/* A dense array: `length` contiguous elements and no holes, plus the named-property table below
 * (empty for every array but a RegExp match).
 *
 * `elements` is a separate allocation rather than a flexible array member, because `length` grows
 * (a write past the end extends the array) and a flexible member cannot move without invalidating
 * every `jsrt_value` that boxes this header. The header's address is therefore stable for the
 * array's whole life, which is what lets the emitter hold an array in a frame slot across a push.
 *
 * KNOWN CEILING: no holes. ECMA-262 leaves the indices skipped by `a[5] = v` on a shorter array
 * genuinely ABSENT -- `console.log` prints `<4 empty items>`, not `undefined` -- and a dense buffer
 * has no way to be absent. Rather than fill the gap and print a different program's output,
 * `jsrt_array_set` refuses a write more than one past the end (STA2002). Replacing an element and
 * appending at `length` -- the cases real programs use -- are unaffected. Sparse storage arrives
 * with the object model, and the refusal lifts with it. */
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

static inline JSRTArray *jsrt_as_array(jsrt_value v) {
  return (JSRTArray *)jsrt_ptr(v);
}

/* `.length` as a Number, so the emitter never reads the struct field itself. */
jsrt_value jsrt_array_length(jsrt_value array);

/* Indexed read and write. Both take the index as a VALUE and convert it here: an index is an
 * arbitrary expression, and only the runtime knows whether it landed on an integer. A read outside
 * the array is `undefined` (ECMA-262, not an error); a write outside it extends the array. */
jsrt_value jsrt_array_get(jsrt_value array, jsrt_value index);
void jsrt_array_set(jsrt_value array, jsrt_value index, jsrt_value element);

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

/* A callable.
 *
 * `env` is NULL for a function that captures nothing, and such a closure stays a file-static
 * constant in the generated C -- rung 4a's zero-allocation path, unchanged. A function WITH
 * captures is heap-allocated once per evaluation of its function expression, which is what makes
 * two evaluations close over different variables.
 *
 * `fn` takes the environment even when it is NULL: `jsrt_call` dispatches through this pointer
 * without knowing which kind of closure it holds, so the signature cannot vary between them. */
typedef struct JSRTClosure {
  jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);
  uint32_t arity;   /* declared parameters, i.e. Function.prototype.length */
  const char *name; /* "" for an anonymous function */
  JSRTEnv *env;     /* NULL when the function captures nothing */
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
                            uint32_t arity, const char *name, JSRTEnv *env);

static inline const JSRTClosure *jsrt_as_closure(jsrt_value v) {
  return (const JSRTClosure *)jsrt_ptr(v);
}

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
 * Phase 6 is conformance fuzzing. Corrected in plan-notes 125.) */
jsrt_value jsrt_call(jsrt_value callee, uint32_t argc, const jsrt_value *argv);
/* Same as jsrt_call, with a `file:line` baked in so a non-function callee names the site
 * (STA2006). `loc` may be NULL, which keeps the unlocated TypeError for builtin-internal calls. */
jsrt_value jsrt_call_at(jsrt_value callee, uint32_t argc, const jsrt_value *argv, const char *loc);

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
  if (strcmp(name, "Map") == 0 || strcmp(name, "Set") == 0) {
    if (!jsrt_is(v, JSRT_TAG_OBJECT)) {
      return false;
    }
    const JSRTClass *cls = jsrt_as_object(v)->cls;
    return strcmp(name, "Map") == 0 ? cls == &jsrt_class_map : cls == &jsrt_class_set;
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

/* --------------------------------------------------------------- output */

void jsrt_print(jsrt_value v); /* console.log semantics: prints -0 as "-0" */
void jsrt_eprint(jsrt_value v);      /* console.error/warn: same form, stderr */
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
jsrt_value jsrt_to_string(jsrt_value v); /* ECMA-262 ToString: -0 becomes "0" */

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

#endif /* JSRT_VALUE_H */
