# VALUE.md — the codegen↔runtime value contract

This document is **normative**. `runtime/include/jsrt_value.h` mirrors it exactly; where the two
disagree, this file is right and the header is a bug. Per plan.md §5 Task 2.1, no C may be
emitted before this document merges — everything the emitter writes assumes the layout below.

Four things are specified here, in the order plan.md §2 requires them:

1. the exact bit layout, including how `-0.0` survives;
2. the string struct and its only sanctioned accessors;
3. number→string as shortest-round-trip, byte-identical to Node;
4. the GC rooting protocol, needed by the *first* line of generated C.

---

## 1. Bit layout — NaN boxing

`jsrt_value` is exactly 64 bits (`uint64_t`). It is a plain integer type, never a union and
never a struct: it must pass in a single register and be memcpy-able without ceremony.

```c
typedef uint64_t jsrt_value;
```

A double is stored **as itself**. Everything else hides in the quiet-NaN space:

```
 63   62 .. 52    51     50 .. 48   47 .. 0
┌────┬──────────┬──────┬──────────┬──────────────┐
│sign│ exponent │quiet │   tag    │   payload    │
│ 1  │  0x7FF   │  1   │  3 bits  │   48 bits    │
└────┴──────────┴──────┴──────────┴──────────────┘
```

A value is a **boxed (non-double)** value iff its top 13 bits are all set:

```c
#define JSRT_NANBOX_MASK  UINT64_C(0xFFF8000000000000)
#define jsrt_is_double(v) (((v) & JSRT_NANBOX_MASK) != JSRT_NANBOX_MASK)
```

Note the **sign bit is part of the mask**. Only *negative* quiet NaNs are tags; the entire
positive-NaN space stays available to real doubles. That is what makes rule §1.2 workable.

### 1.1 Tags

| Tag | Name | Payload |
|---|---|---|
| 0 | `Undefined` | zero |
| 1 | `Null` | zero |
| 2 | `Bool` | 0 or 1 |
| 3 | `Int32` | two's-complement `int32_t` in the low 32 bits |
| 4 | `Object` | pointer |
| 5 | `String` | pointer to `JSString` |
| 6 | `Array` | pointer |
| 7 | `Closure` | pointer to `JSRTClosure` |

The tag field is **three bits and completely allocated**. There is no spare tag, and adding one
would take a bit from `JSRT_NANBOX_MASK`, whose width is what keeps the whole positive-NaN space
available to doubles. Anything the runtime needs to make reachable but that is *not* a JavaScript
value — a captured-variable environment, for instance — is rooted structurally instead (§4.3),
never by inventing a tag.

A callable is a `JSRTClosure`. `fn` takes the environment even when there is none, because
`jsrt_call` dispatches through this pointer without knowing whether the closure captures:

```c
typedef struct JSRTClosure {
  jsrt_value (*fn)(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);
  uint32_t     arity;   /* declared parameters, i.e. Function.prototype.length */
  const char  *name;    /* "" for an anonymous function */
  JSRTEnv     *env;     /* NULL when the function captures nothing */
} JSRTClosure;

jsrt_value jsrt_closure_new(jsrt_value (*fn)(uint32_t, const jsrt_value *, JSRTEnv *),
                            uint32_t arity, const char *name, JSRTEnv *env);
```

A function that captures nothing stays a **file-static constant** with `env = NULL` — no
allocation, which is the path rung 4a established and 4b leaves intact. Only a capturing function
is heap-allocated via `jsrt_closure_new`, once per evaluation of its function expression, which is
what makes two evaluations close over different variables.

`arity` is `Function.prototype.length`: parameters to the left of the first rest parameter or the
first parameter with a default. It never bounds what a call site may pass: JavaScript drops extra
arguments and fills missing ones with `undefined`, so every callee reads parameters through
`jsrt_arg` rather than indexing `argv` directly. A rest parameter is packed with `jsrt_args_rest`.
A default expression runs when `jsrt_arg` yields `undefined`.

```c
#define JSRT_TAG_SHIFT  48
#define JSRT_PAYLOAD_MASK  UINT64_C(0x0000FFFFFFFFFFFF)
#define JSRT_BOX(tag, payload) \
  (JSRT_NANBOX_MASK | ((uint64_t)(tag) << JSRT_TAG_SHIFT) | ((uint64_t)(payload) & JSRT_PAYLOAD_MASK))

#define JSRT_UNDEFINED  JSRT_BOX(0, 0)
#define JSRT_NULL       JSRT_BOX(1, 0)
#define JSRT_TRUE       JSRT_BOX(2, 1)
#define JSRT_FALSE      JSRT_BOX(2, 0)
```

Tags 4–7 all carry pointers. They are distinct tags rather than one `Ptr` tag plus a header
read because the common operations — "is this a string?", "is this callable?" — must be a
register compare, not a dependent load through a cold pointer.

**Pointer assumption.** The 48-bit payload holds a full pointer only because every platform in
scope (x86-64 and AArch64, user space) leaves the high 16 bits of a valid heap pointer clear.
`jsrt_init()` asserts this against a real heap allocation at startup rather than trusting it
silently. If Stator is ever ported somewhere with 5-level paging enabled for user space or with
the AArch64 top-byte-ignore feature in play, this assumption breaks loudly at startup instead of
corrupting values — that is the entire point of checking it.

Pointer payloads are **not** shifted or sign-extended on the way out; unboxing is a mask:

```c
#define jsrt_ptr(v) ((void *)(uintptr_t)((v) & JSRT_PAYLOAD_MASK))
```

`Int32` is signed, so it *is* re-widened on the way out:

```c
#define jsrt_int32(v) ((int32_t)(uint32_t)((v) & UINT64_C(0xFFFFFFFF)))
```

### 1.2 NaN canonicalization — required, not optional

The tag space is negative quiet NaNs, and on x86-64 the SSE default NaN produced by `0.0/0.0`
is `0xFFF8000000000000` — bit-identical to `JSRT_UNDEFINED`. An arithmetic NaN flowing into a
value slot unfiltered would silently *become* `undefined`.

So every double entering a `jsrt_value` passes through one funnel, which replaces any NaN with
the canonical positive quiet NaN:

```c
#define JSRT_CANONICAL_NAN  UINT64_C(0x7FF8000000000000)

static inline jsrt_value jsrt_number(double d) {
  jsrt_value v;
  memcpy(&v, &d, sizeof v);
  return jsrt_is_double(v) ? v : JSRT_CANONICAL_NAN;
}
```

This is spec-legal: ECMAScript exposes exactly one NaN. No program can observe which bit pattern
it had. **Generated C never bit-casts a double into a `jsrt_value` directly — it always calls
`jsrt_number()`.** The emitter has no exception to this rule, including for literals it believes
cannot be NaN, because the cost is one predictable branch and the failure mode is silent.

`memcpy` is the type-pun, not a union or a pointer cast: it is the only form that is defined
under C11 strict aliasing, and every compiler in scope lowers it to a register move at `-O1`+.

### 1.3 How `-0.0` survives

`-0.0` has the bit pattern `0x8000000000000000`. Masked with `JSRT_NANBOX_MASK` that yields
`0x8000000000000000`, which is not `JSRT_NANBOX_MASK` — so `jsrt_is_double` says *double*, and
it round-trips unchanged. It is never canonicalized (it is not a NaN) and it is never demoted to
`Int32` (see below).

This matters because `Object.is(-0, 0) === false` and `1/-0 === -Infinity` are observable. Both
are decision tests, per plan.md §2.

**The `Int32` demotion rule exists to protect this.** A double may be stored as `Int32` only if
it is integral, within `int32_t` range, **and is not `-0.0`**:

```c
static inline bool jsrt_fits_int32(double d) {
  return d >= -2147483648.0 && d <= 2147483647.0
      && (double)(int32_t)d == d
      && !(d == 0.0 && signbit(d));   /* -0.0 must stay a double */
}
```

The `signbit` clause is the whole reason this helper exists rather than being inlined at each
call site: `(double)(int32_t)(-0.0) == -0.0` is *true*, so the obvious integral test admits
`-0.0` and would quietly turn it into `+0`.

**Phase 2 does not emit `Int32` at all.** Per plan.md §5, the walking skeleton treats all numbers
as `f64`, which is spec-correct; the `i32` fast path arrives in Phase 3 with `NUMERIC.md` as a
pure optimization. The tag is specified now so that turning it on later is a codegen change with
no layout change — and so that `jsrt_strict_equals` is written correctly from the start.

### 1.4 Equality

Because a number has two possible representations (`Int32` and double) once Phase 3 lands,
`===` on two `jsrt_value`s is **not** `a == b`. Bit equality is a fast path, not the definition:

```c
bool jsrt_strict_equals(jsrt_value a, jsrt_value b);
```

The rules it implements: `NaN !== NaN` (so bit-equal canonical NaNs must compare *false*);
`+0 === -0` (so bit-*unequal* values must compare *true*); a number is equal across
representations; everything else is bit equality. Getting `===` from `==` on the raw integer
gets both zero cases and the NaN case wrong, which is why the operator is a function from day 1
even though Phase 2's subset could get away with less.

---

## 2. Strings

```c
typedef struct JSString {
  uint32_t length;   /* in UTF-16 code units, not bytes and not code points */
  uint32_t flags;    /* JSRT_STRING_GROWN: the string came out of a concatenation */
  uint16_t *data;    /* NOT NUL-terminated */
  void *buffer;      /* the append buffer `data` points into, or NULL for a flat string */
} JSString;
```

A string is a header and a view of its code units. A **flat** string is one pointer-free block:
the header, then its own units, with `data` pointing just past the header (`jsrt_string_alloc`).
Contents never change once a string is visible to anyone.

**Concatenation and the append buffer** (plan.md §9 Task 6.23, F12; `jsrt_string_mem.zig`).
Copying both operands on every `+` made `s += x` in a loop O(n²): 200k one-character appends took
2.5 s against Node's 0.07 s. Now a concatenation onto a string that is itself a concatenation's
result, once the result reaches 64 code units, goes through an **append buffer**: one block of
units with spare capacity and `used`, the end of the longest string viewing it. Every string over
a buffer is a prefix of it, so writing past `used` changes no string anyone holds:

- `a + b` where `a` ends exactly at `used` and `b` fits writes `b` in place and allocates only a
  header. This is the string the loop just made.
- `a + b` where `a` is an older, shorter prefix (its next units belong to a longer string) copies
  into a fresh buffer, as does a full one. Capacity doubles, so the copies total O(n).
- Any other concatenation (a one-off `x + y`, a short result) is a flat copy marked
  `JSRT_STRING_GROWN`, so a one-off concatenation costs no spare memory.

A buffered header keeps the buffer's own address in `buffer`, so the collector retains the buffer
through it without relying on interior-pointer recognition. The header is a scanned allocation;
the flat string and the buffer are pointer-free (atomic). A long-lived built string may hold up to
twice its length in capacity; that is the price of the amortized append.

Past `JSRT_MAX_STRING_LENGTH` (2^29 − 24 code units, V8's `String::kMaxLength`)
`jsrt_string_concat` leaves Node's catchable `RangeError: Invalid string length` pending. It used to
return `JSRT_NULL`, which callers then used as a string. The emitter puts a pending check after
every `+` that may concatenate (any `+` not typed `number`), after `+=` and before its write, after a
template literal with more than one part, and after `String.prototype.concat`.

UTF-16 is not negotiable for v0. `String.prototype.length`, `charCodeAt`, `codePointAt`, surrogate
pair handling, and essentially all of Test262's string coverage are defined in UTF-16 code units.
Choosing UTF-8 to save memory would make every one of those operations either wrong or O(n), and
the conversion cost would reappear at every boundary. Revisit only with measurements, via
`plan-notes.md`.

A string LITERAL reaches the runtime through `jsrt_string_from_utf8`, and the emitter encodes it as
**WTF-8** — UTF-8 plus the three-byte encodings of unpaired surrogates — with every byte outside
printable ASCII written as a three-digit octal escape in the generated C. A lone surrogate is a
legal JS code unit that UTF-8 cannot carry, so emitting the literal as raw source characters lost
it to U+FFFD before clang ever saw it (plan-notes 178). `utf8_decode` already accepts the surrogate
range, so this is an emitter contract, not a runtime one.

`length` is `uint32_t`, not `size_t`: it caps strings at 4 Gi code units (JS's own limit is lower),
keeps the header 4 bytes so `data` starts 8-byte-aligned after padding, and makes the struct the
same size on both 32- and 64-bit targets.

Generated C touches string contents **only** through these:

```c
uint32_t jsrt_string_length(jsrt_value v);
uint16_t jsrt_string_char(jsrt_value v, uint32_t i);
```

No direct `->data[i]` in emitted code, ever. The indirection is what made the append buffer
above a runtime-only change, and keeps a rope or small-string optimization one too. A bounds-check policy lives behind these
accessors too, so it can be compiled out in release builds in one place rather than at thousands
of emitted call sites.

---

## 3. Number → string

**Requirement: byte-identical to the pinned Node.** Golden tests compare stdout with no
tolerance, so this is a correctness requirement, not a formatting preference. "Round to N
decimals" is never an acceptable fix for a mismatch — a mismatch is a bug in this layer.

This splits into two problems that are easy to conflate:

**3.1 Shortest round-trip digits — vendored Ryū.** Given a double, produce the shortest decimal
digit string that parses back to exactly that double. This is `runtime/vendor/ryu/` (plan.md §5
Task 2.5). Do not write this; do not use `printf("%.17g")`, which is neither shortest nor
correctly rounded for this purpose.

**3.2 The surrounding format — ECMA-262 `Number::toString`.** Ryū gives digits and an exponent;
the *shape* of the output is the spec's, and it is not what a C library would print:

| Value | JS output | A naive `%g` would give |
|---|---|---|
| `1e21` | `1e+21` | `1e+21` |
| `1e20` | `100000000000000000000` | `1e+20` |
| `0.000001` | `0.000001` | `1e-06` |
| `0.0000001` | `1e-7` | `1e-07` |

Note both traps: the decimal/exponential threshold is at 1e21 (not the C library's much lower
one), and negative exponents are written `e-7`, with **no zero padding**. These are exactly the
cases where a plausible-looking implementation passes casual testing and fails golden tests.

**3.3 `console.log(-0)` prints `-0` — but `String(-0)` is `"0"`.** These are different
operations. `Number::toString(-0)` is specified to return `"0"`, while Node's `console.log` runs
values through `util.inspect`, which prints `-0` to preserve the distinction for humans.

Golden tests compare `console.log` output, so **`jsrt_print` must implement the inspect rule, not
the `toString` rule** for this case. They are separate functions:

```c
void      jsrt_print(jsrt_value v);            /* console.log semantics */
jsrt_value jsrt_to_string(jsrt_value v);       /* ECMA-262 ToString */
```

The distinction is documented here because it will otherwise be discovered as a one-character
golden-test diff by whoever writes the first `-0` test, and misdiagnosed as a Ryū bug.

---

## 4. GC rooting protocol

Every generated function opens a shadow-stack frame. Every local holding a `jsrt_value` lives in
that frame. Frames pop on **every** exit path — normal return, early return, and landing pads.

```c
typedef struct JSRTFrame {
  struct JSRTFrame *prev;
  uint32_t          count;
  jsrt_value       *slots;
  struct JSRTEnv   *env;    /* this function's own captured-variable environment, or NULL */
} JSRTFrame;

extern _Thread_local JSRTFrame *jsrt_frame_top;

#define JSRT_FRAME(n)                                                        \
  jsrt_value _jsrt_slots[(n)];                                               \
  JSRTFrame  _jsrt_frame = { jsrt_frame_top, (uint32_t)(n), _jsrt_slots, NULL }; \
  jsrt_frame_init(&_jsrt_frame);                                             \
  jsrt_frame_top = &_jsrt_frame

#define JSRT_LOCAL(i)     (_jsrt_slots[(i)])
#define JSRT_FRAME_POP()  (jsrt_frame_top = _jsrt_frame.prev)
#define JSRT_FRAME_ENV(e) (_jsrt_frame.env = (e))
```

`jsrt_frame_init` fills every slot with `JSRT_UNDEFINED` before the frame becomes reachable. The
frame is pushed *after* initialization, so a collection triggered mid-prologue can never scan an
uninitialized slot.

The `env` field is the root for a captured-variable environment (§4.3). A collector traces it
alongside `slots`; it is `NULL` for every frame whose function captures nothing, which is almost
all of them.

### 4.3 Captured-variable environments

A variable read by a nested function cannot live in its declaring function's frame: the frame dies
when the call returns, and the closure may outlive it. Such variables move to a heap `JSRTEnv`,
chained through `parent` so a reference resolves to (levels-up, index) — both compile-time
constants the emitter gets from capture analysis. The chain runs over **env-bearing scopes only**,
not over source nesting, so a function that captures nothing adds no level.

```c
typedef struct JSRTEnv {
  struct JSRTEnv *parent;
  uint32_t        count;
  jsrt_value      slots[];   /* C11 flexible array member */
} JSRTEnv;

JSRTEnv *jsrt_env_new(JSRTEnv *parent, uint32_t count);
```

`jsrt_env_new` fills `slots` with `JSRT_UNDEFINED` before returning, for the same reason
`jsrt_frame_init` does.

Storing captured variables in the env — rather than copying them into each closure — is what makes
a write the declaring function performs *after* building a closure visible through that closure,
which is what the language requires.

**Why the env is rooted by the frame and not by the closure.** Tracing `closure → env → slots`
covers the env only once a closure exists and only while one is alive. Neither holds between
`jsrt_env_new` and the first `jsrt_closure_new`, nor in a function still reading its own captured
locals after every closure it built has died. So the declaring function roots its own env through
`JSRT_FRAME_ENV`. It is *not* a `jsrt_value`: the tag field is three bits and all eight values are
allocated (§2), and widening it would take a bit from `JSRT_NANBOX_MASK`, which exists to keep the
entire positive-NaN space available to doubles. An environment is not a JavaScript value and does
not need to become one. See plan-notes 50.

### 4.1 Why this exists, and what the collector actually reads

Phase 2 uses Boehm GC, which is conservative: it scans memory word by word and retains anything
that looks like a heap address. **A `jsrt_value` is not one.** NaN-boxing puts the tag above bit 48
(§1.1), so a boxed reference is a word no conservative scan recognises — the machine-stack scan
walks straight past every value a frame slot, an array, a Map or an object slot holds. These macros
are therefore not bookkeeping the collector would duplicate anyway: the frame chain is the only
root set there is, and §4.12 is the hook that reads it. This is measured, not theoretical — before
that hook existed, a forced collection over a live 200-entry Map segfaulted (plan-notes 108).

They would be mandatory even under a collector that did see them, because §12's precise
generational GC needs an exact root set. If codegen is written without the discipline and the
discipline is retrofitted later, the retrofit *is* a codegen rewrite — which is precisely the
history plan.md §0.7 cites from Boa. The cost of maintaining it now is a few macros; the cost of
adding it later is the backend.

Consequently: **a frame is opened even when the runtime would not need it.** Uniformity is what
makes the codegen auditable, and plan.md §7 Task 4.5 requires a codegen test that diffs emitted
frames against emitted locals — a test that only works if the rule has no exceptions.

### 4.2 Landing pads

`try`/`catch` lowering (plan.md §6 Task 3.10) uses return-value + landing-pad style, never
`setjmp`/`longjmp`. Every `goto landing_pad_N` runs its scope's cleanup, popping frames in
reverse scope order, before jumping.

The invariant, stated so a reviewer can check it mechanically: **on every path leaving a
function, the number of `JSRT_FRAME_POP()` executed equals the number of `JSRT_FRAME()`
entered.** An unwind path that skips a pop leaves a dangling frame pointing at a dead stack
region — which the root walk (§4.12) reads on the next collection, today, and which a precise GC
would turn into a crash. This is ASan/UBSan-tested per plan.md §6 Task 3.10.

---

## 4.4 Arrays, and the `console.log` shape they print in

A `JSRTArray` is a header — `length`, `capacity`, `elements`, plus the property table below —
boxed under the `Array` tag. The elements are a SEPARATE allocation rather than a flexible array
member, because the buffer grows and a flexible member cannot move without invalidating every
`jsrt_value` that boxes the header. The header's address is therefore stable for the array's whole
life, which is what lets the emitter hold an array in a frame slot across a push.

### Holes (plan.md §11c T11.4 step 4b)

An index below `length` can be ABSENT: `new Array(3)`, `a[5] = 1` on a shorter array, and
`delete a[i]` all leave one. An absent element is stored as `JSRT_HOLE`, `JSRT_BOX(TAG_UNDEFINED,
1)` — a box no program can produce, because `undefined` has exactly one value and it is
`JSRT_BOX(TAG_UNDEFINED, 0)`. Every reader that hands an element to a program goes through
`jsrt_unhole`, which turns the hole into `undefined`: the indexed read, `at`/`pop`/`shift`, the
iterators and the inlined for-of, `join`, `JSON.stringify` (where it is `null`), an array-literal
spread (`[...a]` is the iteration, so `jsrt_array_fill_holes` runs over the copied `concat`), and
the ES2023 copies (`toReversed`, `toSorted`, `toSpliced`, `with`). What the spec makes skip a hole
skips it: `in` and `Object.keys`, the callback methods (`forEach`, `map`, `filter`, `some`,
`every`, `reduce`, `reduceRight`, `flatMap`; `map` keeps the hole in its answer), `flat`, and
`sort`, which moves holes after every `undefined`. `indexOf` never finds one, because a hole's bits
are not `undefined`'s; `includes(undefined)` does. `concat` and `slice` copy holes as holes.

Only an array whose element type is Unknown may hold one. A typed element (`number[]`) has no value
that stands for "absent", so the compiler keeps holes out of it: `Array(n)` with a typed element
and `delete` on one are `STA1214`, an indexed write to an Unknown-element array emits
`jsrt_array_set_sparse` (which fills the gap with holes), and the typed write `jsrt_array_set` still
aborts `STA2002` past the end. `a.length = n` growing the array is `STA2002` on both paths, because
the property write cannot tell which element type it serves. A literal hole (`[1, , 3]`) is still
refused by `gateArrayLiteral`.

`Array(n)` / `new Array(n)` is `jsrt_array_construct`: a number argument must be a uint32
(`RangeError: Invalid array length` otherwise) and answers that many holes; any other single
argument is a one-element array, and zero or two or more arguments are an array literal, lowered as
one. `console.log` prints a run of holes as Node's `formatSpecialArray` does — `<1 empty item>`,
`<3 empty items>` — counting each run as one entry against the 100-entry cap, and a hole makes the
grouped layout left-aligned, since Node right-aligns only when every `value[i]` it looks at is a
number.

### An array with properties

An array can also carry NAMED properties, in the same `shape` + out-of-line `slots` layout §4.10
gives a dynamic object. `shape == NULL` means "no properties", which is every ordinary array: the
table costs one NULL word and no allocation until something writes to it.

One thing needs this, and it is not an optimization: a **RegExp match**. ECMA-262 §22.2.7.2 builds
the answer of `exec` as an array of the capture groups that ALSO has `index`, `input` and `groups`
on it, and `console.log` prints them — `[ '12-ab', '12', 'ab', index: 0, input: '12-ab', groups:
undefined ]`. A dense buffer alone cannot hold that, which is why `exec` and `String.prototype.match`
were deferred until this landed (plan.md §7 Task 4.1).

The consequences worth stating:

- **Indices never enter the table.** They live in `elements`, and a match is dense over its groups,
  so the two spaces do not overlap. `jsrt_shape_property_count` therefore counts named properties
  only, and `console.log` prints them after the elements, as Node does.
- **One code path, two receivers.** `jsrt_get_prop`/`jsrt_set_prop` walk a `PropTable` view that a
  dynamic object and an array both expose (`runtime/src/jsrt_shape.c`), so `m.index` resolves
  through the same shape chain and the same per-site inline cache an `o.x` does. A cache filled at
  one site stays valid however the value was built.
- **`groups` has a NULL PROTOTYPE**, and Node says so when it prints one: `[Object: null prototype]
  { w: 'a' }`. The layout is a dynamic object's exactly; a second class descriptor
  (`jsrt_class_null_proto`) is the only difference, and it exists so the printer can tell them apart
  by pointer. `jsrt_is_dynobj` answers true for both.
- **Grouping is off** for an array with properties, the rule Node applies to objects: its
  `groupArrayElements` is reached only for array-like output.

Two ceilings are deliberate and recorded rather than hidden:

- **No holes.** `jsrt_array_set` refuses a write more than one past the end (`STA2002`, raised at
  runtime), and `jsrt_set_prop` refuses `a.length = n` with `n` past the end the same way; a
  smaller `n` truncates (ECMA-262 §10.4.2.4, plan-notes 310). ECMA-262 leaves the skipped indices absent, and a dense buffer cannot be absent;
  filling them with `undefined` would make `console.log` print a different program's output.
- **A read out of range is `undefined`**, which is why `noUncheckedIndexedAccess` types `a[i]` as
  `T | undefined` and the HIR types it `Unknown` until Task 3.5 narrows it (plan-notes 53).

### The inspect constants

`console.log` on an array is `util.inspect`, not `ToString`, and `jsrt_print` reproduces Node's
formatting byte-for-byte. The constants are Node's defaults, verified empirically against the
pinned Node rather than read out of documentation, and `runtime/tests/print_arrays.{c,mjs}` is the
paired corpus that holds them:

| Constant | Value | What it controls |
|---|---|---|
| `breakLength` | 80 | The column at which a single-line array becomes a multi-line one |
| `depth` | 2 | Below this, a nested array prints as `[Array]` |
| `maxArrayLength` | 100 | Entries printed before `... n more items` |
| `compact` | 3 | Feeds `groupArrayElements`, which packs more than six entries into aligned columns |
| separator space | 2 | The `, ` between entries, which counts toward every width test |

One simplification is worth stating so it does not read as a missing check: Node guards grouping
with `ctx.currentDepth - recurseTimes < ctx.compact`, and with a depth cap of 2 and `compact` of 3
that comparison is **always** true, so it is omitted rather than translated.

Column alignment follows the element types: a run of numbers is right-aligned (`padStart`), and
anything else left-aligned (`padEnd`).

## 4.5 Class instances, and why they print differently from arrays

A `JSRTObject` is a pointer to a `JSRTClass` descriptor followed by its slots, boxed under the
`Object` tag. Unlike `JSRTArray`, the slots ARE a flexible array member — one allocation, not two —
and that is safe here for the reason it is unsafe there: the slot count is fixed at construction,
and a property added later goes to a separate overflow table (§4.24), so the buffer never grows and
the header's address never has to move.

The descriptor is `static const` and file-scope, one per class declaration, shared by every
instance: the class name, the slot count, the field names in slot order, and the base class's
descriptor (`NULL` at the root of a chain). An instance therefore costs a pointer plus its fields,
a field read is an offset load, and `instanceof` walks the parent links comparing descriptor
pointers (`jsrt_instanceof`, rung 6b): one class, one descriptor, so class identity and pointer
identity are the same fact at every link. Anything that is not an object with a descriptor — a
primitive, an array, a closure — answers `false` at the tag test, before any dereference.

A static member is not in the descriptor either, and not in any instance: it is one ordinary
binding for the whole program, named after the class that declares it. Nothing about a class is
per-instance except its slots.

The parent link is the prototype chain as far as this subset can observe it, and `instanceof` is
the only thing that asks. Field access never walks it: a subclass's slots BEGIN with its base's, in
the base's own slot order, so a base-typed read of a subclass instance is the same offset load it
would be on a base instance. Inheritance costs a pointer in the descriptor and nothing per
instance.

A method is not in the object. One function is shared by every instance, with the receiver passed
as argument zero under the ordinary closure ABI. Putting methods in slots would cost one closure
per method per object and turn every call into an indirect one.

The exception is a method on an OBJECT LITERAL that captures (plan.md §8 step 36): one shared
function cannot close over each evaluation's own environment, so every method of a literal rides
in a hidden trailing slot, bound at construction over the definition environment. The slot names
start with `#`, so every reflective walk (`jsrt_fixed_key_order`, `hasOwn`, the spread-order
walks, print) already filters them -- exactly like a `#private` field -- and a stored key order
covers them so the runtime never walks past its end. A method that captures nothing stores the
shared constant, so identity (`o.m === o.m`) is unchanged; a method that captures stores a fresh
closure per evaluation, so two `counter()` calls read two different `n`s. The call loads the
instance's closure and still passes the receiver as argument zero. Class instances keep the
shared layout above: their methods never capture per-evaluation state.

### Two orders, and why the descriptor carries both

Slot order is the **layout**: which offset a field lives at, and therefore what `o.x` compiles to.
It is a property of the TYPE, because the type is all a read has — `slotOf` in the lowering resolves
a name against `type.fields`, and the same read must work on a value that arrived from anywhere.

Enumeration order is a different fact. §10.1.11 OrdinaryOwnPropertyKeys answers in **insertion**
order, and only the literal that allocated the object knows it. The two coincide for a class
declaration, which lays its fields out in the order it writes them, and for the ordinary literal
whose keys are already in its type's order. They do not coincide when the layout came from
somewhere else:

```ts
const o: { y: number; x: string } = { x: "s", y: 2 };  // layout y,x — printed x,y
const spread = { ...base, y: 2 };                      // TS types it y,x,z — built x,z,y
```

So `JSRTClass` carries `key_order`: slot indices in insertion order, `NULL` when insertion order IS
slot order. `jsrt_class_key_slot(cls, i)` is the only accessor, and exactly two walks use it —
`jsrt_print.c`'s object inspector and `jsrt_object_ops.c`'s `collect` (keys/values/entries).
Everything else indexes by slot and must keep doing so. Conflating the two silently miscompiled the
first example above into swapped field values (plan-notes 181).

One consequence for the emitter: the descriptor cache is keyed by the shape name **and** the key
order, because one type with two insertion orders is two descriptors.

Where a method is overridden the descriptor carries a METHOD TABLE: `method_count` entries, each a
pointer to a file-scope `JSRTClosure`, in the same prefix order the fields have — a subclass's table
begins with its base's, so a slot resolved against a receiver's static type indexes the right method
on every descendant, and an override is a different entry at the same index (`jsrt_method`). The
table is per class, not per instance, so overriding costs a pointer and a count in the descriptor
and nothing per object. A class nothing overrides has no table at all (`method_count` 0, `methods`
NULL) and keeps the compile-time-resolved direct call: the frontend decides which of the two a call
site is, and only ever emits the load where it proved the table exists.

An accessor is not in the object either, and not in the descriptor's field list: `get x`/`set x` are
member functions like any other, so a class with accessors keeps the fixed-slot layout of its actual
fields. That is also why an accessor does not print — `util.inspect` shows slots, and there is no
slot.

An unassigned slot reads as `undefined` because that is what it HOLDS. That is a value, not an
absence — so the key still prints, which is the observable difference from a property that was
never declared.

### What inspect does differently for an object

`runtime/tests/print_objects.{c,mjs}` is the paired corpus, and it pins four behaviours that the
array constants in §4.4 do not predict:

- **The class name is inside the 80-column budget**, not merely printed in front of it. The same
  single field under `S` fits on one line and under `AVeryLongClassNameIndeed` does not.
- **Objects never group.** `groupArrayElements` is array-only, so eight fields are eight lines
  where eight array elements would be a grid.
- **Past the depth cap an object prints as `[ClassName]`**, not `[Object]`.

- **`#private` fields do not print.** A field name in the descriptor that begins with `#` is
  skipped, which is the whole implementation of privacy below the gate: the checker has already
  rejected every access from outside the class body, so the printer is the only place the
  distinction is still observable. The names stay in the descriptor because slot *i* of the class
  must be slot *i* of the descriptor.

A class with no fields — and a class whose fields are ALL `#private` — prints as `Name {}`. `ToString` of an object is still `[object Object]`,
which is a different operation from what `console.log` does — a distinction the golden fixture
`tests/golden/ts/classes.ts` checks in both directions.

---

## 4.6 Map and Set — one table, two descriptors

The tag field is fully allocated (§1.1), so a Map cannot have a tag of its own. It does not need
one: a Map is an `Object`-tagged pointer whose first word is a `const JSRTClass *`, exactly like a
class instance, and the descriptor pointer is what says which builtin it is. Two file-scope
descriptors exist for the whole program — `jsrt_class_map` and `jsrt_class_set` — so the test is a
pointer comparison, the same one `instanceof` makes.

```c
typedef struct JSRTMapEntry { jsrt_value key; jsrt_value value; bool live; } JSRTMapEntry;
typedef struct JSRTMap {
  const JSRTClass *cls;   /* &jsrt_class_map or &jsrt_class_set — the prefix every object shares */
  uint32_t size;          /* LIVE entries: what `.size` answers */
  uint32_t used;          /* entries appended, dead ones included: where the next one goes */
  uint32_t capacity;
  JSRTMapEntry *entries;  /* dense, in insertion order — this is why iteration order is insertion order */
  uint32_t *index;        /* open-addressed probe table of (entry index + 1), 0 meaning empty */
  uint32_t index_mask;
} JSRTMap;
```

A Set is the same struct with the value half unused, which is the whole reason there is one
implementation rather than two: the only comparison either needs is SameValueZero.

**SameValueZero** is `===` except that `NaN` finds itself, and `Object.is` except that `-0` finds
`+0`. Both differences are reachable from ordinary arithmetic (`0/0`, `-0`), so the hash has to
agree with the comparison on both: a number key is normalized to a double with `-0` folded to `+0`
and every NaN folded to the canonical one (§1.2), a string is hashed FNV-1a over its UTF-16 units,
and anything else hashes by box identity — which is exactly what identity comparison means for an
object key, with no object model involved.

`index` is kept at least twice `capacity`, so the load factor stays ≤ ½ and linear probing does not
degrade. Growth compacts: dead entries are dropped, the survivors keep their relative order, and the
probe table is rebuilt. A delete blanks the entry's key and value and clears `live` rather than
moving anything, so **insertion order survives a delete-and-reinsert** — the reinsert appends at the
end, it does not reclaim the hole.

`console.log` of either prints through the same `util.inspect` rules objects use, with two
differences pinned by `runtime/tests/print_maps.{c,mjs}`:

- The prefix `Map(n) ` / `Set(n) ` counts toward the 80-column budget, the way a class name does.
- Map and Set entries **never group**. `groupArrayElements` is array-only, so eight entries are
  eight lines where eight array elements would be a grid.

---

## 4.7 `typeof`, and the two places the tag is not the answer

`jsrt_type_name` is a switch on the tag, and it has to be one rather than a derivation, because
ECMA-262 disagrees with this layout twice:

- **`typeof null` is `"object"`.** The 1995 bug that shipped and then became normative. No
  structural route to the `Null` tag gives that answer, so it is asserted.
- **A closure is `"function"`.** Everywhere else in this header a closure IS an object —
  `jsrt_is_object` says so, and so does every operation that takes one. `typeof` is the single
  place the language separates callable from not.

The numeric case is a property of the boxing rather than of the language: a value is a number if it
is an unboxed double OR carries the `Int32` tag, and a real NaN reaches the switch as a double
(the quiet-NaN space holds the tagged values, not NaN itself), so it answers `"number"` correctly
without a special case. `runtime/tests/print_typeof.c` pins every one of these against Node.

## 4.8 Boundary checks — `jsrt_check_*` and STA2001

The check family is `jsrt_check_number`, `jsrt_check_string` and `jsrt_check_boolean`: each returns
its argument on success, so a check composes as an expression and the emitter wraps a value in
place, and each calls `jsrt_panic` on failure with `STA2001` and the `file:line:col` the emitter
baked in as a string literal.

Deliberately three. A tag settles these in constant time; an object's shape, an array's element
type and a function's signature do not, and a "check" that walked an array would turn an O(1)
narrowing into an O(n) one silently. Narrowings to those types are left on the dynamic path instead
(docs/HIR.md §3.2.1).

Failure ABORTS rather than returning an error value. That is the whole contract: everything the
compiler emits downstream of a check is entitled to trust the type completely, and a check that
could be ignored would make that entitlement false.

The same family is what a mixed graph uses: an untyped `.js` value assigned to, passed into, or
returned as a checkable annotation is wrapped here, not trusted. A lying JSDoc never reaches this
path — `checkJs` makes that a compile error (`STA0012`).

---

## 4.9 Exceptions — the pending cell and the landing-pad protocol (Task 3.10)

Exceptions are return-value + landing-pad style, never `setjmp`/`longjmp` (plan.md §2: bad codegen
interactions, GC-root problems). The runtime's entire contribution is a mailbox — one value and one
flag, thread-local, in `runtime/src/jsrt_throw.c`:

- `jsrt_throw(v)` stores the value and raises the flag. Overwriting an already-pending exception is
  legal and REQUIRED: a throw inside a `finally` replaces the completion that got the finally
  running, and the generated code relies on the newest throw winning.
- `jsrt_pending()` reads the flag. Generated C checks it after every operation that can run user
  code — `jsrt_call` in all its spellings — and jumps to the nearest landing pad. The return VALUE
  of an unwinding call is `JSRT_UNDEFINED` and meaningless; the flag is the channel.
- Dynamic property/index reads and writes can throw on nullish receivers or from accessors.
  Their generated callers root the receiver/result and check pending before consuming the result
  or evaluating a later operand. `Object.values`/`entries` stop on a throwing getter;
  `Object.assign` snapshots keys, then alternates each source get and target set, checking after
  both. Enumeration roots its partially built result across callbacks. `JSON.stringify` and
  `console.table` also propagate property exceptions, freeing partial output instead of printing
  it, and read each property/row only when processing it so nested failures stop later getters.
- `jsrt_take_exception()` clears both and hands over the value. A pad that handles the exception
  takes exactly once; not taking would make every later call in the handler appear to throw.
- `jsrt_uncaught()` is main's pad of last resort: prints `Uncaught <value>` to STDERR (stdout stays
  clean for the golden comparison) and exits 1, which is what Node observably does.

Everything else about exceptions — which catch receives one, the order finally blocks run in, how
frames pop on the way out — is a property of the GENERATED C, decided by the emitter where the
scope structure is known (docs/HIR.md §1.3 `TryStatement`). Two invariants tie it to this section:

- **Frames pop on every exit path, landing pads included.** A function with no enclosing try gets
  one `_jsrt_unwind` pad that does `JSRT_FRAME_POP(); return JSRT_UNDEFINED;` — emitted only when
  something in the unit can actually throw.
- **The pending slot is a GC root.** Between throw and take the cell may hold the only reference to
  a heap object, and `finally` blocks on the way out allocate. The root walk pushes it alongside
  the frame chain (§4.12) — not a §12 promise but a live requirement, because a boxed value in that
  cell is invisible to a conservative stack scan and nothing else would keep it alive.

**Runtime-side catch (Phase 5 step 11).** Generated C is the only client the protocol had: after
`jsrt_call` it checks `jsrt_pending()` and jumps to a landing pad. A builtin that must *handle* a
throw — a `then` handler, a `new Promise` executor — cannot jump to a pad it does not have. It
calls `jsrt_call_protected`, which is the same `jsrt_call` plus `jsrt_pending` / `jsrt_take_exception`
on the way back, and yields a `JSRTCompletion { value, threw }`. The builtin then settles a promise
with that value instead of leaving the cell pending. Same mailbox, one extra consumer; a second
pending cell is how two protocols get built by accident. `jsrt_throw_str` boxes a message so a
builtin can raise (`Object.freeze` writes, `toISOString` on an Invalid Date) and generated C's
existing pending check after the op is the landing pad.

---

## 4.10 Dynamic objects — the shape table and inline caches (Task 4.1)

The representation for an object whose property set is **not a compile-time layout**: optional
properties, index signatures, and — from Phase 5 — untyped receivers. Boa's lesson, taken as
design: ICs matter exactly where types are unknown, so the compiled path never touches any of
this — a typed field access is a struct offset load into `JSRTObject`, no cache, no shape.

**The shape chain.** A `JSRTShape` is one link of a property history: `parent` is the shape
before `key` was added, `offset` is the slot the addition claimed. The root (no properties, NULL
key) is a static singleton; everything else is allocated on first use and lives forever — shapes
are program-lifetime metadata, never freed, never moved, so a cached shape pointer can never
dangle. Transitions ("from this shape, adding this key leads to that shape") hang off the parent
as a linked list of children, and **reuse-before-allocate is the invariant that makes sharing
real**: two objects that gain the same keys in the same order land on the *same* shape.

**The object.** `JSRTDynObject` is prefix-shared with `JSRTObject` (`cls` first, pointing at the
marker descriptor `jsrt_class_dynamic`), so the Object tag covers it and the printer, `typeof`,
truthiness and `instanceof` all see an ordinary object. Its name is `""` — a dynamic object IS a
plain object, and prints like a literal (`{ a: 1 }`), because Node cannot tell them apart. Slots
are **out of line**, unlike a fixed-shape object's, because property addition grows them
(doubling from 4) and the header's address must stay stable — every boxed reference is that
address. Under Boehm the slots are a collected, scanned allocation; the shapes hold no values and
use plain malloc either way.

**The inline cache.** One `JSRTIC { shape, offset }` per property-access *site*, emitted `static`
in generated C. The whole protocol is two rules:

- A cache is filled **only from a hit** against the object's current shape, so
  `ic->shape == o->shape` alone proves `ic->offset` is the site's key's slot — the key is fixed
  at compile time, and same shape means same layout. A hit is one pointer compare and one load.
- A get **miss is never cached**: the object can gain the key later under a different shape, and
  a cached "absent" would keep answering `undefined` after the property exists.

Reading a property the object lacks *is* `undefined` — that is the semantics of an optional
property, not an error. A set of an existing key overwrites in place (shape unchanged); a set of
a new key takes or builds a transition and moves the object's shape. Transitions are not
IC-cached: each object performs a given addition once, so a transition cache pays only across
objects — worth building when Phase 5 measures construction-heavy dynamic code, not before.

`delete` removes a key by **rebuilding** the object's shape chain from the root without it
(`jsrt_delete`) — not by adding a removal edge, and not by the dictionary-mode escape this
section used to promise. A shape is shared immortal metadata, so no node can lose a key in
place; replaying the surviving keys' transitions from the root instead REUSES the nodes that
already exist, which costs O(keys) once and buys three things. Insertion order survives, because
the replay walks slots in order. Two objects that deleted the same key from the same shape land
on the SAME shape, so a shared read site's IC still hits for both. And stale caches need no
invalidation: an IC is trusted by shape-POINTER compare, and the receiver now points elsewhere,
so a stale entry simply misses. Slots compact during the same walk (the write index never runs
ahead of the read index). The operator answers Node's boolean — `true` when the key is gone or
was never there, `false` only after raising. A key that is not the object's to remove is answered
where that is decided: a FROZEN property is non-configurable, so it raises Node's
`TypeError: Cannot delete property 'x' of #<Object>`; a fixed-layout receiver and an array
element abort with `STA2007`, the mirror of `STA2004` below — a `JSRTClass` has no way to spell a
missing slot, and a hole has no representation at all. Where the receiver's type is known the
frontend refuses before any of that: `STA1108` in ts mode, `STA1205` in js. Keys are `const char *` with program lifetime
(generated C passes string literals; `jsrt_shape_key` interns a UTF-8 conversion of a JS string
into the same immortal table when a transition or another immortal table stores the pointer).
A lookup that only compares (`jsrt_get_prop_value`, `in`, `delete`, `Object.hasOwn`, an
array-index check, a print or `JSON.stringify` get) uses `jsrt_shape_key_ephemeral` and frees
it, so a miss does not grow the intern table.
The shape table stores the pointer and compares by pointer first, `strcmp` as the backstop for
one key spelled at two sites. Each receiver has a deliberate path: a dynamic object or array walks the shape table; a
fixed-layout object reads and writes existing fields through its `JSRTClass` descriptor and
raises `STA2004` if asked to grow a new key (Phase 8); a string answers `"length"` and
everything else `undefined`; nullish is a TypeError; a primitive write is a TypeError.
`STA4058` is retired.

Pinned by `runtime/tests/print_shapes.{c,mjs}`: insertion-order printing through the chain,
overwrite-in-place, undefined-on-miss, shared-IC reads across shape-sharing objects, the
stale-cache miss after a transition, divergent histories landing on different shapes,
non-identifier keys printing quoted (`{ 'a-b': 1 }`), and intern identity (two conversions of
the same bytes share one pointer; a compare-only miss does not change the intern count; a
stored key interns once; abort on mismatch, not a print). A second named-group exec interning
nothing new is pinned in `runtime/tests/print_regexp.c`. `delete` is pinned against Node instead, by
`tests/golden/{ts,js}/delete_prop.*`: the boolean answer, the `undefined` read and the `in` result
after removal, the print order after a re-add, one read site shared by two objects that rebuilt to
the same shape, and the frozen `TypeError`.

## 4.11 Dates — one double behind a class pointer (Task 4.2)

```c
typedef struct JSRTDate {
  const JSRTClass *cls; /* &jsrt_class_date */
  double time;          /* ms since 1970-01-01T00:00:00Z, or NaN for an Invalid Date */
} JSRTDate;
```

Boxed under `JSRT_TAG_OBJECT`, like `JSRTObject` and `JSRTRegExp`. The load-bearing property is the
**prefix share**: `cls` sits first in all three, so `jsrt_as_object(v)->cls` is a legal read of any
of them and `jsrt_is_date` is a pointer comparison against `&jsrt_class_date`. That is why every
"is this an object" test already answers yes for a Date, and why `print_to`'s dispatch can branch
on the class before it looks at anything else.

There are **no owned pointers**, so a Date adds no GC edges — the descriptor's field table is
empty and the collector needs nothing new to trace it. A Date is nonetheless heap-allocated rather
than a boxed double, because `setTime` and the fourteen `set*` setters mutate it in place and two
bindings holding the same Date must both see the change.

**Every `jsrt_date_*` entry point asserts the class pointer** (`STA4093`) before it dereferences.
The verifier pins the receiver kind above the boundary (`STA4092`) for the same reason it pins a
regexp receiver: a wrong kind here would read a `double` out of whatever object arrived, which is
memory corruption rather than a wrong answer.

**Local time is derived, never stored.** The struct holds an instant; a wall-clock reading is
`t + LocalTZA(t)`, and the offset comes from libc `localtime_r` at call time — the runtime carries
no zone rules of its own, and nothing about the host zone is cached in the object. The consequence
worth knowing is that the inverse is **not a bijection**: a local reading inside a DST gap names no
instant, and one inside a fold names two. §21.4.1.26 settles both with the offset in effect *before*
the transition, which the runtime finds by probing one day either side — the spec's own window.
Every local setter and the component constructor `new Date(y, m, …)` run through that inverse; the
UTC family never touches it, which is the entire difference between the two halves of `DATE_OPS`.

**Printing.** `inspect_date` renders the ISO string, which is what Node's inspect shows and is
TZ-independent — the property that lets `console.log(d)` appear in a golden fixture at all. An
Invalid Date prints `Invalid Date`. `JSON.stringify` routes a Date through `jsrt_date_to_json`,
which answers the ISO string or `JSRT_NULL`; the `null` case is why `JSON.stringify(new Date(NaN))`
is the four characters `null` and not an abort.

**Invalid Date.** `toISOString` throws a `RangeError` through `jsrt_throw` (§21.4.4.36); generated
C checks `jsrt_pending()` after the op (Phase 5 step 11).

## 4.12 The collector — Boehm, and the two hooks that make it see a value

Everything above assumes the collector can find what is live. A conservative collector and a
NaN-boxed value do not meet on their own (§4.1); `runtime/src/jsrt_gc.zig` is where they are made to.

**One allocation seam.** `jsrt_gc_alloc(bytes, what)` (`runtime/include/jsrt.h`) is the runtime's
only collected allocation, and the only place that knows whether a collector is configured at all.
Everything that can hold a `jsrt_value` comes from it — a value stored in memory from anywhere else
is invisible to the collector, because the heap hook below does not cover that memory. `what` names
the allocation in the out-of-memory panic; the call never returns NULL, so callers do not test it.

**Hook 1 — the heap.** Every allocation belongs to a custom object kind (`GC_new_kind`) whose mark
procedure masks each word with `JSRT_PAYLOAD_MASK` before offering it to `GC_MARK_AND_PUSH`. The
word count comes from `GC_size(addr)`, so one procedure covers every allocation shape the runtime
has — fixed struct, flexible array member, bare value buffer — without any of them carrying a
layout descriptor.

**Hook 2 — the roots.** `GC_set_push_other_roots` walks the `JSRT_FRAME` chain, unboxes each slot
into a 128-pointer buffer and hands that buffer to `GC_push_all_eager`. The eager push scans a
memory range *conservatively*, which is exactly what fails on a boxed word — unboxing into a plain
array of raw pointers first is what makes the range scannable. The walk also pushes each frame's
`env` (§4.3, the mark procedure then covers its slots and parent chain) and the pending-exception
cell (§4.9). It runs *after* the hook it replaced (`GC_get_push_other_roots`), because in a
threads-enabled Boehm that default is the C stack and register scan itself: a raw pointer in a
runtime local is a root only through it, and the runtime relies on that whenever a function
allocates twice (plan-notes 163).

**Why masking is safe.** Only two word shapes reach it: a boxed value, whose payload is its low 48
bits, and a raw pointer, whose top 16 bits are zero — `jsrt_init` asserts that against a real
allocation and aborts on a platform where it does not hold (5-level paging, AArch64 TBI). On the
first the mask yields the referent; on the second it is the identity. A word that is neither — a
double, a length — can mask to a plausible address and retain one object it does not own. That is
ordinary conservative-collector behaviour: it costs memory, never correctness.

**Two configurations, both supported.** The justfile asks `pkg-config` for `bdw-gc`. Found:
the archive compiles with `-DJSRT_HAVE_BOEHM` and records `-lgc` in `packages/runtime/build*/link-flags.txt`, which
`packages/compiler/src/cli/build.ts` reads back so the emitted program links the same collector its archive was
compiled against (plan-notes 106). Not found: `jsrt_gc_alloc` is plain `malloc`, nothing is ever
collected, and every test still passes — the program simply keeps every object it allocates. The runtime recipe
prints which one it built (`Runtime built with: Boehm GC` / `plain malloc (no collection)`).

**The check.** `pnpm run test:leak` compiles a 10M-object loop and samples RSS from `ps`: the last
third of the run must not sit meaningfully above the middle. It reads that same `link-flags.txt`
and SKIPS when the build has no collector, because a build that never frees has no plateau to find.
Retention is that test's job specifically — the sanitized suite runs with
`ASAN_OPTIONS=detect_leaks=0`, and the rest of the corpus allocates far too little to reach Boehm's
first collection, which is why the suite stayed green through the whole period the two hooks above
did not exist (plan-notes 108).

**What §12 changes.** A precise generational collector replaces both hooks: the object layout
becomes traced rather than masked, and the frame chain becomes an exact root set rather than an
unboxing pass over one. The discipline that makes that swap runtime-only is already emitted (§4.1).

---

## 4.13 Iterators — specialized loops first, a protocol object only for user iterables (Phase 5 step 8)

The iterator protocol is one *question* with four *surfaces* (`for-of` over non-arrays,
`keys`/`values`/`entries`, `matchAll`, `function*`). The representation is decided here before any
of those surfaces grow a node, so four lowerings do not invent four objects.

### Specialized loops (no protocol object)

A compile-time-known iterable never allocates an iterator. The emitter writes a counted loop
against the representation the value already has:

| Iterable | Cursor | Yields | Why no object |
|---|---|---|---|
| `T[]` | `uint32_t i` vs **current** `length` (already shipped) | `elements[i]` | The array *is* the iterator state |
| `string` | `uint32_t i` over UTF-16 units, advancing 1 or 2 | one string of the **code point** at `i` (surrogate pairs are one yield — `String.prototype[@@iterator]`, not `charAt`) | The string *is* the iterator state |
| `Map` | the table's insertion-order chain | `[key, value]` pair (an array of two) | Map already stores that order |
| `Set` | the same chain | the element | Set is a Map of element → element |

`for (const x of xs)` where `xs` is one of those four types lowers to that loop. `break`/`continue`/
labels are the existing jump labels. A body that mutates length is visible because the bound is
re-read, the same rule the array loop already documents.

`arr.keys()` / `arr.values()` / `arr.entries()` (and the Map/Set triples) are the same loops
exposed as **values**. When the call is the operand of a `for-of`, the loop is inlined and still
allocates nothing. When the call's result is stored (`const it = arr.keys()`), the runtime boxes
the cursor in a `JSRTIterator` (below) so `it.next()` is a method on a real object. `s.matchAll(re)`
is always this boxed form: the call IS the iterator. The boxed form is a cursor plus a tag saying
which specialized loop it is, not a user-callable `next` closure.

### User iterables — one protocol object

A value whose checker type has a `[Symbol.iterator]()` the frontend can see (a user class that
declares the method, returning a Generator or a boxed specialized iterator) does **not** allocate a
third object. The lowering emits a MethodCall of that method and the existing iterator walk drives
what it returns. `Symbol.iterator` as a *stored value* stays `STA1212`; only the computed method
name is admitted, so there is still no Symbol primitive and no symbol-keyed shape table.

```c
typedef struct JSRTIterator {
  const JSRTClass *cls; /* &jsrt_class_iterator -- prefix-shared with JSRTObject */
  jsrt_value target;    /* the iterable; a GC root */
  jsrt_value extra;     /* matchAll: the cloned regexp; undefined otherwise */
  uint32_t index;       /* specialized cursors use this */
  uint8_t kind;         /* JSRT_ITER_* */
} JSRTIterator;
```

`next()` on this object answers `{ value, done }` — an ordinary two-field shape, not a new HIR
type. `return`/`throw` on a specialized iterator are out of scope: the object does not carry
them (Node answers a TypeError from their absence), so the gate refuses the calls with their own
not-yet rather than a silent no-op.

### Unknown iterables — runtime GetIterator dispatch (Phase 5 step 2a(c))

`for (const x of u)` where `u` has no static walk (Unknown, a union, or a checker-refused
non-iterable js mode admitted) lowers its operand through a `get-iterator` HIR node, which emits
one `jsrt_get_iterator` call ahead of the existing boxed walk:

- a generator or a stored box passes through untouched;
- an array, a string, a Map or a Set boxes into the specialized walk the static loop would have
  inlined (array-values, string code points, Map entries, Set values);
- any other object resolves its `__@iterator` method through the shape table — the fixed method
  table or the dynamic one, the same read a dynamic method call makes — and calls it with the
  receiver; the result must be a generator or a box, else Node's
  `TypeError: Result of the Symbol.iterator method is not an object`;
- anything else (nullish, numbers, closures, an object with no method) leaves a catchable
  `X is not iterable` pending, rendered the way STA2009 renders it (Node-exact for
  nullish/number/boolean, best-effort past that for the source-text reason).

A custom `{ next() }` object is the method-result error above, not a new box kind: driving one
needs a callback into compiled code per step, which is the Phase-8 dynamic tier (a
statically-known one stays `STA1214`). Closing the dispatched iterator is the existing
`jsrt_iterator_close` — a no-op except for generators, whose `finally` blocks run. Overriding
`arr[Symbol.iterator]` on an instance is not observed: an array value takes the array walk the
way the static loop does (prototype mutation is out of scope either way). A user class that
extends Map or Set is not a Map or Set here either: its instances carry the subclass's own
descriptor (field layout, not the collection table), so the dispatch answers the same
not-iterable `TypeError` the static walk's `STA1214` always gave those shapes.

One more boxed kind never comes from a member call: `JSRT_ITER_STRING`, the string code-point
walk. A **suspendable unit** (async or generator) boxes EVERY specialized for-of — array, string,
Map, Set — because the loop's cursor cannot live on a C frame that a `yield`/`await` pops: the
resume's `goto` jumps over the initializer and the local reads back as garbage. The boxed walk
keeps the cursor in the heap object, which is what a stored `arr.values()` already does; the
zero-alloc inlined loops stay the sync-unit form.

`JSRT_ITER_UINT8ARRAY` (§4.19) is the boxed walk over a `Uint8Array`: it is what both the static
`for-of` (through `get-iterator`, element `number`) and the dynamic dispatch use. The cursor
re-reads the view's length on every step, so a walk over a view stays inside its window.

### Generators

A generator is a different object, not a tagged `JSRTIterator`. The cursor is a resume point and
the locals live in a heap environment, which a specialized cursor has no reason to carry:

```c
typedef struct JSRTGenerator {
  const JSRTClass *cls; /* &jsrt_class_generator -- prefix-shared with JSRTObject */
  JSRTEnv *env;
  JSRTGenResume resume;
  uint32_t state;
  jsrt_value yielded;
  bool done;
  uint8_t inject;     /* JSRT_GEN_INJECT_*; read and cleared by the resume prologue */
} JSRTGenerator;
```

`function*` is Task 4.6's resume machine driven by the caller: `gen()` only allocates, the body
runs on the first `next()`, and `yield e` parks `e` then pops the C frame. A later `next(v)` is
the value of that `yield`.

`.return(v)`/`.throw(e)` resume the SAME parked label with an injection instead of a value
(ECMA-262 27.5.1.3, GeneratorResumeAbrupt): the resume prologue reads and clears `inject`, then
`throw` rethrows `e` at the yield's own landing pad — the body's `try`/`catch` cannot tell it
from a `yield` that threw — while `return` parks `v` in the return slot and routes through every
enclosing `finally` exactly as a real `return` at that point would, so a `finally` that yields
suspends again and the completion value arrives on the next `next()`. On an unstarted or
completed generator neither enters the body: `return(v)` answers `{ value: v, done: true }` (the
NEW value, not the one it completed with) and `throw(e)` rethrows to the caller.

`Symbol.iterator` as a *stored value* stays `STA1212` until the Symbol primitive lands. A class
method named `[Symbol.iterator]` is not that value: it is a compile-time-known method stored under
TypeScript's `__@iterator`, which is why user-iterable `for-of` compiled without a Symbol tag.

## 4.14 Module namespace objects (Phase 5 step 10, plan.md §11c T11.5a)

A module namespace is not a new NaN-box tag. It is an `HObject` with `namespace: true` whose
fields are the target module's value exports, in the checker's order. A class is no field (a
class has no value in this subset), and neither is a name two `export *` re-exports bind
differently (ES leaves it out of the namespace).

Every module keeps its own top-level scope, so the HIR name of an export is not its exported
name: a renamed export, a default export (`*default*`), or a dependency's binding that shares a
spelling with another module's each carry a different one. A member read therefore never goes
through the field: the lowering resolves `ns.x` — the dot spelling, a destructuring, a
literal-keyed element read, a nested `ns.inner.x` — to the export's own binding, through the
checker's alias chain. `ns.x` and the export are the same cell: live bindings, not a snapshot.

The object VALUE exists for what reaches it without a member name: `import()`'s Promise, `ns`
passed or printed. It is one hidden global per module, an object literal of the exported
bindings built once, when its first importer starts (the target's body has already run in
topological order), and shared by every `import * as ns`, `export * as ns from` and literal
`import()` of that module. Its fields are a snapshot: a `let` export written later is not seen
through the object itself, only through a member read. Identity across importers holds;
printing and `Object.keys` are not the spec's Module exotic object (`[Module: null prototype]`).
A literal specifier is resolved into the whole-program graph as an init edge, so the target's
top-level code has already run when the Promise is produced; `import()` is `Promise.resolve`
of that namespace. A computed specifier stays `STA1207` (Phase 8): the graph cannot name a file
it has not seen.

## 4.15 Accessors — a get/set pair in the object's slot, never on the shape (Phase 5 step 12c/12d)

§4.5 already settles the class case: `get x`/`set x` are member functions like any other, so a
class with accessors keeps the fixed-slot layout of its actual fields, and the accessor does not
print because there is no slot. That stays true and nothing below changes it. What it does not
answer is the two cases step 12 opens, which is why plan.md §8 blocked both families here.

**An object-literal accessor is an OWN property and a class accessor is not.** Measured on the
pinned Node v26.7.0 (plan-notes 190):

```
{ get x(){…}, set y(v){…}, get z(){…}, set z(v){…} }
  → { x: [Getter], y: [Setter], z: [Getter/Setter] }   Object.keys → [ 'x', 'y', 'z' ]
class C { get x(){…} }, new C()
  → C {}                                               Object.keys → []
```

So the two cannot share an answer: the literal's accessor must occupy a key, and the class's must
not. The inspector prints the half that exists — three forms, which is why the pair below carries
both halves rather than a single function plus a flag.

**The class half is already built and does not change.** `docs/SUBSET.md`'s "Classes with
getters/setters" row is **implemented** as of rung 6b: an accessor is a pair of methods under a
name no source can spell (`get x`, `set x`), `o.x` is a call to the first and `o.x = v` a call to
the second, and the property occupies no slot — which is why accessors needed no HIR node, no
verifier case and no emitter case, and why `util.inspect` never prints them. Step 12(d)'s residue
there is dispatch and naming, not representation: a static accessor, a `#private` or computed
accessor name, an override of an inherited accessor, and `o.x += 1`. Only the first two need a
word here, and both are answers rather than mechanisms. A static accessor read through the class
NAME (`C.x`) is a call on a compile-time-known function, because statics are bindings and not slots
(plan-notes 65) — but only that case: reached through a class VALUE, or inherited by a subclass,
it needs the class object `docs/SUBSET.md` row 78 says a plain binding is not, and that is family
(e)'s other half, which stays `STA1214`. A computed or `#private` accessor name stays `STA1214`
too, because the key is an expression the shape model cannot name. An override rides the method
table it already inherits (§4.5).

**The literal half is the shape table, not a new field on `JSRTClass`.** `docs/SUBSET.md`'s
"Getters/setters on object literals" row — the row authority — already gives the verdict as
**dynamic**, "property access routes through the descriptor". That is
Task 4.1's `JSRTDynObject` (§4.10), and it is the right mechanism for the reason row 84 gives for
optional properties: a fixed shape's reads compile to slot indices decided at build time, and an
accessor has no slot to index. So a literal containing an accessor builds a shape table, exactly
as a literal with an optional property already does, and this section adds **nothing** to
`JSRTClass` — the fixed-slot path keeps the layout, the two orders and the branch-free read it has
today.

**The pair goes in the object's SLOT, not on the shape — and that is not a preference.** A
`JSRTShape` is shared program-lifetime metadata: every object that gained the same keys in the same
order points at the same shape, which is the whole reason an inline cache works. An accessor's
functions are not shared, because a getter can capture:

```js
for (let i = 0; i < 3; i++) out.push({ get x() { return i; } });   // three different closures
```

Those three objects have one shape and must have three getters, so a `get`/`set` pair hung off the
shape would alias them onto whichever literal ran last. The pair is therefore per object, and the
place an object already keeps per-object GC values is its slots:

```c
/* Prefix-shared with JSRTObject exactly as JSRTMap and JSRTDynObject are: `cls` first, so the
   Object tag covers it and the descriptor pointer is what says which builtin it is (§4.6). */
typedef struct JSRTAccessorCell {
  const JSRTClass *cls;   /* &jsrt_class_accessor */
  jsrt_value get;         /* undefined for a set-only accessor */
  jsrt_value set;         /* undefined for a get-only accessor */
} JSRTAccessorCell;

extern const JSRTClass jsrt_class_accessor;
```

Both halves are carried, never one function plus a flag, because the inspector prints three forms
and `Object.getOwnPropertyDescriptor` (Phase 8) will want both. The cell is an ordinary
`jsrt_value` in an ordinary slot, so it is traced, enumerated and ordered by machinery that already
exists: `JSRTShape` and `JSRTIC` are **unchanged**, the shape table stays insertion-ordered by
construction, and `Object.keys` and the inspector get the measured order above for free with no
second order to maintain — §4.5's two orders were conflated once already and silently miscompiled
field values (plan-notes 181).

**What tells a cell from a value is the cell itself.** `jsrt_get_prop` and `jsrt_set_prop` resolve
the name through the shape table with the site's inline cache exactly as they do today, then test
the LOADED value: an `Object`-tagged value whose `cls` is `&jsrt_class_accessor` is a cell and the
access becomes a call; anything else is the property's value. Nothing in the language can construct
a cell — `jsrt_define_accessor` is the only producer and generated C is its only caller — so the
test cannot be fooled by a user value, and the IC needs no third field because it caches where the
key lives, not what kind of thing lives there. A getter runs user code, so it can throw and it can
allocate: the receiver stays in its frame slot across the call like any other method receiver
(§4.3), and a throw takes the caller's landing pad through §4.9's pending cell. A setter's argument
is evaluated before the call, in source order.

**The cost, stated rather than discovered.** An accessor deoptimizes its whole literal: a sibling
data property in the same literal becomes an IC lookup instead of a slot load. That is the trade
row 84 already accepted for optional properties, taken here for the same reason, and it is why
this is one paragraph instead of a second object model.

**A literal's accessor makes its whole SHAPE dynamic, siblings included.** `isDynamicShape`
(`src/frontend/types.ts`) treats an accessor as a trigger alongside an optional property and an
index signature; a method stays a refusal, because calling through the shape table is step 12(e).
The corollary is the one refusal this section leaves standing: TypeScript calls
`{ get at(): number }` assignable to `{ at: number }`, and it is not representationally — the
literal must be a `JSRTDynObject` while every read typed by the annotation would compile to a slot
load on it. No conversion can bridge that (a slot cannot hold "call this on read"), so the gate
refuses an accessor literal in a position typed as a fixed shape rather than emitting a program
that reads a raw slot word back as a number. **Implemented 2026-09-04; plan-notes 192.**

**Deliberately not here, and it has an owner.** Property attributes (`enumerable`, `configurable`,
`writable`), `Object.defineProperty` and `getOwnPropertyDescriptor` are Phase 8's descriptor
surface. A `JSRTAccessorCell` is two function values, not a property descriptor, and the gap is the
point: this pair answers "which function runs", never "what may be done to the property".

## 4.16 A method used as a value is the method's own closure — there is no bound closure (Phase 5 step 12e)

Five gate sites name this blocker in the same words ("a bound closure nothing here builds", and
`STA1214` for a method in value position), and plan.md §8 step 12(e) calls it the family where an
accidental second closure representation gets built. It does not need one. The representation
already exists and is a `JSRTClosure`.

A method is emitted as an ordinary unit with the receiver as parameter zero (§4.5), and every
callee reads parameters through `jsrt_arg`, which answers `undefined` for a parameter no call
supplied (§1.1). So a method's closure called with no receiver already computes what ECMA-262
gives a strict-mode call with no receiver — `this` is `undefined` — and class bodies and modules
are always strict. `const f = o.m; f()` is `jsrt_call(m_closure, 0, NULL)`. No allocation, no
adapter, no new struct.

> **CORRECTION (2026-09-09, plan-notes 208): the paragraph above is true of a call with NO
> ARGUMENTS and of nothing else.** `jsrt_arg` fills missing arguments from the RIGHT and the
> receiver is on the left, so `const g = o.add; g(1, 2)` compiled as `jsrt_call(add_closure, 2,
> [1, 2])` binds `this = 1`, `a = 2`, `b = undefined`, where the pinned Node gives
> `this = undefined, a = 1, b = 2` (both measured, plan-notes 208). Every argument is off by one.
> The arguments have to SHIFT and slot zero has to be filled with `undefined`, and a call site
> cannot decide that from a `JSRTClosure` value: nothing in the struct says parameter zero is a
> receiver, and a plain function's closure has no receiver parameter at all. The information must
> travel with the value — a flag or a receiver-arity byte on `JSRTClosure`, plus the shift in
> `jsrt_call` — which is the "new struct" this section says is unnecessary. It is still not the
> two-slot `bind` env below: that one INSERTS a captured receiver, this one DROPS a declared one.
> **Method values and calling a class field landed with `has_receiver` on `JSRTClosure` (plan-notes 230);** the rest
> of the section (identity, `this` being `undefined` rather than auto-bound, virtual dispatch in
> value position, the `TypeError`) is unaffected and still the design.

Two behaviours fall out correct rather than having to be arranged:

- **Identity.** `o.m === o.m` and `p.m === o.m` are both `true`, because both read the same
  file-scope closure constant — which is also Node's answer, since both read the same prototype
  method. An adapter allocated per evaluation would have made the first one `false`.
- **`this`.** It is `undefined`, not `o`. **Auto-binding is the wrong answer**, and the temptation
  is why this is written down: `const f = o.m` in JavaScript does not bind, and a receiver-capturing
  closure would diverge from Node on the first golden fixture that prints `this`.

Three things this decision has to pay for, none of them a representation:

- **`arity` must not count the receiver.** `declaredArity` runs over `fn.params`, whose slot zero
  is the receiver for a method unit, so a method's closure constant has to subtract one.
  `Function.prototype.length` is not in the subset yet, so nothing observes it today — which is
  exactly why it is cheap to get right now and a bug to inherit later. **Landed 2026-09-12**
  (plan-notes 230): `closureMeta` subtracts the receiver and `jsrt_call` shifts when it is
  omitted.
- **A virtual method's value is the receiver's entry, not the statically named one.** Where a
  subclass overrides, `o.m` in value position loads `jsrt_method(recv, slot)` — the same choice
  `method-call` already makes between direct and virtual dispatch, made at the same place. The
  result is still a pointer out of the method table; still no allocation.
- **`this` being `undefined` must be a `TypeError`, not an abort.** A method value called with no
  receiver whose body touches `this` raises the same `TypeError` Node raises, through §4.9's
  pending cell. This is the one runtime behaviour the decision adds.

**A real bound closure has exactly one creator, and it is not this.** `Function.prototype.bind`
(and `call`/`apply`) stay not-yet. When `bind` lands it is a `JSRTClosure` whose `env` holds the
receiver in slot 0 and the target in slot 1, driven by ONE shared runtime thunk that inserts slot 0
at `argv[0]` — an env, which is where captured values already live (§4.3), never a second closure
struct. Writing that down now is the whole point of this section: `bind` is the only construct in
the language that creates a bound function, so it is the only place a second representation could
enter, and it enters as a two-slot env or not at all.

**A builtin method in value position stays not-yet, on purpose.** `const f = m.get` on a `Map` is
not this case: a builtin is not a `JSRTClosure` at all but a compile-time-selected runtime function
with its own signature, so handing one out as a value means a closure constant per builtin member —
a per-member code-size cost with nothing waiting on it. `super` as a value stays `STA1214` too; it
needs a class object, which is family (e)'s other half.

## 4.17 Errors — five descriptors, and no mechanism of their own (Phase 5 step 2a(c))

An Error is an **object with a class descriptor**, the way a Map is (§4.6). There is no error tag, no
error struct, and nothing in `jsrt_shape.c` that knows what an error is.

```c
static const char *const error_fields[] = {"name", "message"};
const JSRTClass jsrt_class_error      = {"Error",     2, error_fields, NULL,              0, NULL, NULL};
const JSRTClass jsrt_class_type_error = {"TypeError", 2, error_fields, &jsrt_class_error, 0, NULL, NULL};
/* RangeError, ReferenceError, SyntaxError likewise */
```

**`parent` is the whole of the subclassing.** §4.5's descriptor already carries a base pointer, and
`jsrt_instanceof` already walks it; pointing each standard class at `Error` is therefore all that
`e instanceof TypeError && e instanceof Error` requires. The `instanceof` on a builtin NAME
(`jsrt_instanceof_builtin`) resolves the name to a descriptor through `jsrt_error_class` and then
does the same walk — which is why a sibling class correctly answers false.

**The layout is fixed and shared: slot 0 `name`, slot 1 `message`.** That is the contract between
`jsrt_error_new`, which writes both by index, and every `e.message` the emitter lowers, which
resolves against the same two fields. `errorHType` in `src/hir/nodes.ts` is the emitter's copy of it
and STA4095 is the check that the two have not drifted. Because the slots are ordinary fields, a
read needs no special case: `fixed_get` finds them exactly as it finds any class instance's.

**Raising one.** `jsrt_throw_error(cls, msg)` builds the object and hands it to the pending cell of
§4.9 — the unwind protocol is unchanged, because a thrown Error is just a thrown value. The bare
`jsrt_throw_str` remains for the sites that have no better answer yet, and it throws a STRING, which
is what every runtime TypeError used to be.

**Three divergences from Node, deliberate and recorded** (plan-notes 195): `name` and `message` are
enumerable here and non-enumerable in Node, so `Object.keys` differs — non-enumerability is a
property-descriptor feature the subset does not have at all; `console.log(err)` prints the object
rather than a stack trace, which this runtime has none of (the same deviation `jsrt_uncaught`
documents); and the `jsrt_panic` sites still abort where Node throws a catchable TypeError, because
turning a panic into a throw changes control flow at every caller and is its own change.

## 4.18 Dynamic methods are data, and the call passes the receiver conditionally (Phase 5 step 22)

A method on a DYNAMIC object literal (`{ [k]: v, m() { … } }` with a runtime key, or any
literal an accessor or optional property sends to the shape table) is an own data property
holding the method's closure, stored in written position by `jsrt_set_prop` like any other
value — there is no method table to index, so there is nothing else it could be. The closure
keeps the method ABI (receiver as parameter zero, §4.5), which is what makes `o.m === o.m`
true and `typeof o.m` `"function"`, exactly as for a fixed literal.

The call (`dyn-method-call` in HIR, only ever built for an Unknown receiver) evaluates the
receiver, the arguments, then the name through the site's own cache, in that order. The
receiver occupies the call's slot zero with the arguments contiguously after it — the same
layout a direct method call passes — and the emitted site calls with the receiver when, and
only when, the loaded value is a closure that declares one:

```c
slot = (jsrt_is(m, JSRT_TAG_CLOSURE) && jsrt_as_closure(m)->has_receiver)
  ? jsrt_call_at(m, 1 + argc, &slot_recv, loc)
  : jsrt_call_at(m, argc, &slot_recv + 1, loc);
```

A plain closure is therefore called as-is (`this` is `undefined`, as for a method value
called bare, §4.16), and a non-function callee panics exactly as an ordinary call does
(`STA2006` with the site's `file:line`). A computed VALUE key with a statically-known name
(`[k]` with `k: "dyn"`) never reaches any of this: it is the name the direct spelling
writes, and the literal takes the fixed path (§4.5) like the direct spelling does.

## 4.19 Typed arrays — a byte block, a view over it, and one table (plan.md §11c T11.1)

`ArrayBuffer` and `Uint8Array` are **objects with a class descriptor**, like a Date or an Error:
the first word is `const JSRTClass *cls`, the descriptor has no fields, and every member is a
direct runtime call. The layouts live in `jsrt_value.h`; the storage and every entry point live in
the Zig memory core (`runtime/src/jsrt_typed.zig`, exported through the C ABI only).

```c
typedef struct JSRTArrayBuffer {
  const JSRTClass *cls; /* &jsrt_class_arraybuffer */
  uint8_t *data;        /* GC_malloc_atomic: pointer-free, zero-filled */
  size_t byte_length;
} JSRTArrayBuffer;

typedef struct JSRTTypedArray {
  const JSRTClass *cls;     /* &jsrt_class_uint8array */
  JSRTArrayBuffer *buffer;  /* the bytes; a GC root through this field */
  size_t byte_offset;
  size_t length;            /* in elements; one byte each for Uint8Array */
} JSRTTypedArray;
```

**The bytes are atomic.** The collector never scans a buffer's data block, so a million-byte
buffer costs no mark time and no byte pattern in it can pin an unrelated object. The block is
allocated BEFORE the header, so the only live pointer to it across the second allocation is a
Zig local -- a stack root under the conservative scan. A zero-length buffer still gets a 1-byte
block, so `data` is never NULL.

**A view never owns bytes.** `subarray` makes a new view over the same buffer (writes show
through, `u.subarray(1).buffer === u.buffer`); `slice` and `new Uint8Array(view)` allocate a new
buffer and copy. `set` copies with `memmove`, so a source that overlaps the target is read as it
was before the copy, which is what §23.2.3.26.1 step 24 requires when the two share a buffer.

**Element access.** `jsrt_uint8array_get(array, index)` answers `undefined` past the end and for a
key that is not a canonical numeric string (`"-0"`, `"1.5"` and `"01"` are not indices; `"1"`
is). `jsrt_uint8array_put` converts the value with ToUint8 FIRST and then drops a store to an
invalid index, which is §10.4.5.16's order -- the conversion's side effects happen even when the
store does not. A non-numeric key degrades to the shape-table path; a non-view receiver degrades
to `jsrt_dyn_index_get`/`_set`, so the entry points are total.

**Construction** dispatches on the first argument's tag: a non-object is a length (ToIndex: a
negative or non-integral-after-truncation length past 2^53 throws `RangeError: Invalid typed
array length`); an `ArrayBuffer` is a window (`Start offset N is outside the bounds of the
buffer`, `Invalid typed array length: N`); a view is copied; a Map, Set, iterator, generator or
an object with `[Symbol.iterator]` is drained into an array first (rooted in a shadow-stack frame
across the drain, because the drain runs compiled code); anything else is read as an array-like.

**The compiler side is one table.** `TYPED_OPS` (hir/nodes.ts) lists every landed member as a
row `{ form: new | get | call, receiver, arity, required, fn, result }`, and one `typed-op` HIR
node carries any of them; the verifier checks the receiver kind, the operand count and the result
type against the row (`STA4101`). Two HTypes name the receivers: `uint8array` and `arraybuffer`,
leaves with no element parameter -- the next element type is a new leaf and new rows, not a
generic. `u[i]` / `u[i] = v` reuse the ordinary index nodes and emit `jsrt_uint8array_get` /
`_put` when the target's HType is `uint8array`.

**Untyped receivers** reach the same functions: `jsrt_get_prop` asks `jsrt_typed_get_prop` first
(index keys, the four data properties, and the methods as closures over the receiver), and
`jsrt_dyn_index_get`/`_set` route a view to the element entry points. A typed array is NOT a
fixed-shape object for `Object.*` (`is_fixed_shape_object` excludes both classes), and an expando
write on one panics with `STA2004` like every other statically shaped builtin.

**Across the extern boundary** (docs/FFI.md §2, plan.md §11c T11.3a). A `Uint8Array` extern
parameter passes `jsrt_uint8array_bytes(view)` (`buffer->data + byte_offset`) and
`jsrt_uint8array_count(view)` (`length`), the two inline accessors in `jsrt_value.h`, after
`jsrt_check_uint8array` has proven the value a view. The layout above is what makes that pointer
safe for the call: the block never moves, never resizes, and stays reachable through the view's
rooted argument slot.

**Printing and strings.** `console.log` uses the array printer with a label
(`Uint8Array(3) [ 1, 2, 3 ]`, grouped and capped at 100 entries like an array) and prints a
buffer as `ArrayBuffer { [Uint8Contents]: <01 02>, [byteLength]: 2 }`, the hex capped at 100
bytes. `String(u)` is the comma join; `JSON.stringify` writes a view as its index-keyed object
and a buffer as `{}`, which is what Node does because neither has a `toJSON`.

## 4.20 Ordinary functions as constructors — a prototype on the closure, a chain on the object (plan.md §11c T11.4 family 4)

JavaScript before classes builds objects with `function P(x) { this.x = x; }`, `P.prototype.m =
function () { … }` and `new P(1)`, and stores data on functions themselves (`assert.sameValue =
function …`, `P.count += 1`). TypeScript's own `_tsc.js` builds every `Symbol`, `Type`, `Signature`
and `Node` that way, and the Test262 harness is written in it. In `js` mode all of it is the
dynamic tier: no layout is invented, every access goes through the shape table (§4.10).

**The closure carries the function's own state.** `JSRTClosure` gains four fields:

| Field | Meaning |
|---|---|
| `constructible` | A `function` declaration or expression — not an arrow, a method, an accessor, an async function or a generator. Only these reach construction. |
| `has_prototype`, `prototype` | `F.prototype`, created on first observation by `jsrt_function_prototype`: a fresh `JSRTDynObject` whose hidden `ctor` is F. A function nobody constructs or inspects pays nothing. An assignment (`F.prototype = { … }`) stores whatever value it is given. |
| `props` | The function's own enumerable properties as a `JSRTDynObject`, NULL until the first write. `name` and `length` stay the closure's read-only fields; writing them throws a `TypeError` worded like Node's `Cannot assign to read only property 'name' of function '…'`, except that Node quotes the function's source text and Stator, with no `Function.prototype.toString`, quotes its name. |

A class object never uses `prototype` or `props`: its statics and methods are its descriptor's
(§4.5). A non-capturing function is a file-static `JSRTClosure` in generated C; it is emitted
**non-`const`**, because the first `P.count = 0` writes it. A capturing one is built by
`jsrt_closure_new` and marked by `jsrt_closure_constructible`, which sets `constructible`. The collector scans
both: file statics are data-segment roots, like the inline caches.

**The object carries its chain.** `JSRTDynObject` gains `proto` (the `[[Prototype]]` an object
`new F()` built was given, 0 for the default `%Object.prototype%`, which holds nothing a lookup can
find) and `ctor` (the hidden, non-enumerable `constructor` of an auto-created `F.prototype`). A
read that misses the own shape walks `ctor` and then `proto`, link by link; a getter found on the
chain runs with the ORIGINAL receiver, and a write of a new own name first looks for a setter on
the chain (§10.1.9.2 OrdinarySetWithOwnDescriptor). Chain hits fill no inline cache: the cache
keys on the receiver's own shape, and a chain hit is not in it. `in` sees the chain;
printing and own-key enumeration do not.

**Construction** (`jsrt_construct` on a closure without `klass`, §10.2.2 [[Construct]]): a
non-constructible callee leaves Node's `X is not a constructor` TypeError pending; otherwise a
fresh dynamic object is rooted, its `proto` set to `F.prototype` when that is an object, F runs
with it as `this` (when F declares a receiver), and the answer is F's return value when that is
an object, the new object otherwise. `new v(…)` in generated C lays the callee and its arguments
out in one contiguous run of rooted slots, the call layout, and lands as a statement followed by
its pending check.

**`instanceof`** (`jsrt_instanceof_ctor`, §7.3.22 OrdinaryHasInstance): a primitive left side is
`false`; a right side whose `prototype` is not an object (an arrow's) is Node's `Function has
non-object prototype 'undefined' in instanceof check`; otherwise the left side's `proto` chain is
compared with `F.prototype`. Replacing `F.prototype` after construction therefore makes older
instances answer `false`, as in Node.

**Printing** follows `util.inspect`: an instance prints under the name of the first `constructor`
on its chain (`P { x: 3 }`), an object whose chain names none prints as a plain object, and a
function with own properties prints them after its label (`[Function: assert] { same: [Function
(anonymous)] }`, `[Function]` past the depth cap).

**Gate and lowering.** The member predicates live in `frontend/types.ts`: `isFunctionValueCallee`
(the callee of `new`/`instanceof` is a function the program wrote, or Unknown — never a class or a
lib builtin), `isFunctionValueMember` (`f.x` on such a function, except `length` and the lib's
`call`/`apply`/`bind`), and `isFunctionMemberRead` (`F.prototype` used as a receiver, whose
checker type — inferred from one `F.prototype = { … }` — is no layout). They lower to the
existing `new-value`, `instanceof-value`, `dyn-field-access`, `dyn-field-assignment` and
`dyn-method-call` nodes; `FunctionExpr.constructible` tells the emitter which closures `new` may
build through. `ts` mode refuses a function's properties as not-yet (`STA1214`) and `new` on a
function through the checker (TS7009, an implicit `any`).

## 4.21 `new RegExp(pattern, flags)` — a pattern the source does not spell (plan.md §11c T11.4 step 4b)

`new RegExp(p, f)` and `RegExp(p, f)` are one `global-call` row (`jsrt_regexp_construct`). A RegExp
`p` lends its source, and its flags when `f` is `undefined` (§22.2.4.1 steps 4-5); otherwise both
go through ToString, with `undefined` meaning the empty string. The source is escaped the way V8's
`EscapeRegExpPattern` does it — `/` outside a class becomes `\/`, a line terminator becomes
`\n`/`\r`/`\u2028`/`\u2029` — so `source`, `toString` and `console.log` match Node. An invalid flag
string throws `SyntaxError: Invalid flags supplied to RegExp constructor '<f>'`, and an invalid
pattern throws `SyntaxError: Invalid regular expression: /<source>/<flags>: <reason>`. The reason
comes from the vendored libregexp, translated to V8's words where one libregexp reason has exactly
one V8 counterpart (`Unterminated group`, `Unmatched ')'`, `Nothing to repeat`, `numbers out of
order in {} quantifier`, `Duplicate capture group name`, `Invalid capture group name`, `Invalid
group`, `Invalid property name`). **Known divergence:** the other reasons keep libregexp's wording
(`unexpected end` where Node says `Unterminated character class` or `\ at end of pattern`, `invalid
class range`, `invalid escape sequence in regular expression`). A regexp literal is unchanged: its
pattern is compiled by `jsrt_regexp_new`, which still aborts `STA2005` on a bad one.

## 4.22 WeakMap and WeakSet — a Map and a Set that refuse primitives (plan.md §11c T11.4 step 4b)

A WeakMap and a WeakSet are `JSRTMap`s (§4.6) under two more descriptors, `jsrt_class_weakmap` and
`jsrt_class_weakset`. The type model folds them into `Map`/`Set` HTypes — the checker already keeps
`size`, `forEach`, `clear` and the iterators off them — so `CollectionNew.weak` is the one place the
difference is recorded: it picks `jsrt_weak_collection_new`. `set`/`add` throw Node's
`TypeError` (`Invalid value used as weak map key` / `Invalid value used in weak set`) on a key that
is not an object, function or array; the emitter adds the pending check only where the key type is
open (Unknown or a type parameter), since a primitive key type means an ordinary Map and an object
key type always passes. `get`, `has` and `delete` of a primitive answer `undefined`/`false` with no
check. `console.log` prints `WeakMap { <items unknown> }` (`[WeakMap]` past the depth cap), `String`
answers `[object WeakMap]`, `JSON.stringify` answers `{}`, and `instanceof` tells all four apart.
**Known divergence:** the keys are held STRONGLY. Nothing is collected while the collection lives,
which no program can observe except through memory use; true weakness needs ephemeron support in
the collector.

## 4.23 Spreads of any iterable, `Array.from`, and call-side spreads (plan.md §11c T11.4 step 5)

**Array literals.** `[a, ...b, c]` folds into nested `concat` calls over literal runs and spread
operands (`foldSpreadList` in the lowering). An array operand is spread as it is; any other operand
-- Unknown, a string, a Map or Set, an iterator, a tuple (which has no HType of its own) -- first
goes through the `...` row of `GLOBAL_CALLS`, `jsrt_spread_operand`, which drains it into a fresh
array through the iterator protocol (`jsrt_typed.zig`'s `drain`, the loop `for-of` runs). The
`concat` alone would APPEND a non-array whole. The chain's receiver is always an array of the
list's own type, so the result is typed by the literal, never by its first operand; a leading array
of that type is copied by the next piece's `concat`, and alone by a `concat` with `[]`. Holes in a
spread source read as `undefined` (§4.4).

**`Array.from(x)`** is a `GLOBAL_CALLS` row too, `jsrt_array_from`: `null`/`undefined` throw
Node's `TypeError`; an array, a string or an iterable drains like a spread; another primitive
answers `[]`; and any other object is read as an array-like, `length` then each index. The mapping
function and `thisArg` forms stay refused (an argument past the last parameter, plan.md §11c T11.4).

**Calls.** `f(...xs)`, `o.m(a, ...xs)` and `arr.push(...xs)` build their whole argument list as ONE
array the same way and pass it to `jsrt_call_spread_at(callee, receiver, list, loc)`, which calls
with the list's own count (`CallExpr.spread`, `DynMethodCall.spread`; the verifier's `STA4104`
holds the list to one array). A method is read through the shape table and called with its object
as `this` -- for an array that read answers the bound method (`jsrt_array_method`), which reads
`push`, `unshift`, `splice` and `concat` by count. A static method or a module namespace's member
is called without a receiver. The list is typed by the one element type its pieces share
(`f(...nums, 1)` over `number[]` stays typed), else Unknown. A spread call is never inlined.

Still refused (`STA1214`): a spread into `new` or `super(...)` (the construct path takes no built
list), inside an optional chain, into a builtin namespace or a fixed-arity builtin op (`console`,
`Math`, string methods, a collection's ops, the array callback ops and `toSpliced`), and -- in js
mode only -- into a function with an annotated TypeScript parameter, whose claim the call edge
checks (`STA2001`, plan-notes 308) at a position a spread knows only at run time.

**Known divergence:** a value that is not iterable throws `TypeError: X is not iterable` with
`X` the value's own string (`undefined`, `5`, `object`). V8 names the SOURCE text (`v is not
iterable`), adds `(cannot read property undefined)` for a nullish call-side operand, and words a
non-nullish one as `Spread syntax requires ...iterable[Symbol.iterator] to be a function`. The
class is the same, so a `catch` that tests it behaves the same.

## 4.24 Growing a fixed layout — an overflow table beside the slots (plan.md §11c T11.4 step 7)

A fixed object's slot count is its class's, and the allocation never grows (§4.10's header-address
rule). A name the class does not declare -- `host.configFileName = x` on an object literal's type,
`c.parent = p` on a class instance -- therefore lands in `JSRTObject::extras`, a dynamic object
(§4.10) created on the first such write and NULL until then. It is the same precedent as a
function's own properties in `JSRTClosure::props` (§4.20) and an array's named extras.

**Which values have one.** Only a value laid out as a `JSRTObject` (`jsrt_is_fixed_object`): a
`JSRT_TAG_OBJECT` that is neither a dynamic object nor one of the runtime's own layouts that share
only the `cls` prefix (`Map`, `Set`, their weak twins, `Date`, `RegExp`, `Promise`, iterators,
generators, the typed-array pair, accessor cells). `jsrt_fixed_extras(v)` answers the table or NULL
for anything else, so no caller has to ask first. Those other layouts still abort `STA2004`.

**The property entries.** `jsrt_get_prop` answers a declared slot first, then the table (an own
property, so it shadows a prototype method), then the class's methods. `jsrt_set_prop` writes a
declared slot, else the table; a frozen object is not extensible, so adding to it throws Node's
`Cannot add property X, object is not extensible`, and `Object.freeze` freezes the table with its
owner, so writing a grown name throws the read-only `TypeError` too. `jsrt_has_prop`, `hasOwn` and
`in` see both halves. `jsrt_delete` removes a grown name from the table; a DECLARED slot still has
no encoding for absence (`STA2007`).

**Reflection.** `Object.keys`/`values`/`entries`, `for-in`, `JSON.stringify` (which walks the
keys) and `console.log` list the declared names in their class order, then the table's in insertion
order. That is Node's order whenever the grown names were added after construction, which is the
only way to add one. Object spread copies them: into a dynamic result after the declared names
(`jsrt_dynobj_spread`), into a fixed result through `jsrt_spread_order_src`, which grows the
result's own table.

**The compiler.** In `js` mode a name the receiver's fixed type does not declare
(`isUndeclaredMember`: an object HType, not a module namespace, and no property of that name on the
checker's type) reads, writes and calls through the shape-table nodes an Unknown receiver uses:
`DynFieldAccess`, `DynFieldAssignment` (every compound, logical and update form, the receiver read
once) and `DynMethodCall`, whose `notFunction` subject keeps Node's `c.missing is not a function`
`TypeError` for a name nothing was stored under. A read's result is Unknown. A computed string or
number key on a fixed shape (`table[node.kind]`, `levels[level] = v`) takes the degrading index
entry points by name, which answer a declared slot or the table. In `ts` mode each of these is the
checker's own TS2339 or TS7053 and stays an error.

**Known divergences.** A fixed spread result lists the source's grown names after ALL its declared
names, so `{ ...grown, extra: 1 }` prints `extra` before them where Node prints it last; and a
grown name the result's type also declares keeps the declared writer's value, since the runtime
cannot tell an earlier writer (which the spread overrides) from a later one. The element spelling
with a static key naming no member (`o["extra"] = 1`) is still refused (`STA1214`).

## 4.25 The native stack guard — a catchable RangeError, then a loud panic (plan.md §9 Task 6.23)

Node throws a catchable `RangeError: Maximum call stack size exceeded` on deep recursion. A Stator
binary used to die of SIGSEGV with nothing printed (QA audit F6). Two layers now:

- **The prologue check.** Every generated function opens with `JSRT_STACK_CHECK()` *before*
  `JSRT_FRAME`, so its early return has no frame to pop. It compares
  `__builtin_frame_address(0)` with the thread-local `jsrt_stack_limit`. Past it, the function
  leaves the RangeError pending and returns `undefined`, and the caller's pending check unwinds as
  for any throw (§4.9). `jsrt_init` measures the thread's real stack
  (`pthread_get_stackaddr_np`/`pthread_get_stacksize_np` on Darwin, `pthread_getattr_np` on Linux)
  and sets the limit 256 KiB above its low end. That headroom is for the runtime code the deepest
  frame still calls: the throw itself, a catch handler's `console.log`. A thread `jsrt_init` never
  ran on has limit 0, and the check is off there. Recursion depth therefore depends on the stack
  size, not on Node's; only the error is Node's. Cost: about 1 ns per call on `fib` (plan-notes
  338).
- **The fault handler.** Recursion no prologue sees, the runtime's own C recursion over deeply
  nested data (`JSON.stringify` of a million-deep array), still overflows. A SIGSEGV or SIGBUS
  whose fault address lies at the stack's low end runs on an alternate signal stack. It prints
  `PANIC: STA2005 stack overflow` and the shadow-stack depth with `write(2)` (stdio is not
  async-signal-safe), then aborts. Any other fault is not ours: the handler reinstalls the action
  it replaced (the default, ASan's reporter, a host program's handler) and returns, so the
  faulting instruction re-runs into it. An alternate stack someone already installed (ASan does)
  is kept.

## 4.26 The class object — a closure-shaped value whose `klass` names the descriptor (plan.md §8 step 12(d)/(e), T27)

A class evaluates to a **class object**: the value `const K = C` would store, `f(C)` would pass,
and `C.name` / `C.static` read through. It is one file-scope `JSRTClosure` per class
(`_jsrt_class_object_N` in generated C), the same shape §4.20 gives an ordinary function, with
two fields that make it a class:

| Field | Meaning |
|---|---|
| `klass` | The class's `JSRTClass` descriptor (§4.5). NULL for every ordinary function. This is how the runtime answers `.name`/`.length`/`typeof`, statics, construction and `instanceof`. |
| `fn` | The constructor, or NULL when the class declares none. Reachable only through `jsrt_construct`; `jsrt_call` refuses a class object with Node's `Class constructor K cannot be invoked without 'new'`. |
| `name` | Node's display name (the closure's own `name` field): the declared name, else a class expression's inner name, else the bound variable, else `default` for `export default class {}`. |
| `arity` | The constructor's declared arity — `Function.prototype.length`. |
| `constructible` | False. A class's construction is `klass`'s, never the function-prototype path. |
| `props` | NULL always. A class object never grows own properties: its statics are the descriptor's (below). |

**Identity.** `C === D` is a pointer comparison on the two closures — one constant per class, so
two spellings of one declaration are one object. A class whose evaluation can repeat (inside a
function or a loop) has no one constant and stays refused at the gate rather than lowered here.

**Statics hang off the descriptor.** A static stays an ordinary binding wherever the compiler can
name it (`C.count` reads the declaring class's unspellable binding directly, §4.5 / SUBSET.md).
`JSRTClass.statics` is the parallel table a *runtime* class value answers through — an untyped
`v.count`, or `this.count` inside a static method whose receiver may be absent. One row per own
static (`JSRTStaticEntry`: name, slot pointer, kind field/method/getter/setter); inherited statics
are the `parent` walk, sound because the gate refuses a static override. A write through the table
and a write through the binding are the same write: the row's `slot` points at the binding's
storage. Accessor half-rows CALL the slot's closure with the class object as receiver.

**What v0 admits as reads (T27 narrow slice).**

| Read | Answer | How |
|---|---|---|
| `C.name`, `K.name` (`const K = C`, chained aliases, class expressions) | Node's display name | Folds to a string-literal at the lowering — no class object is built. |
| `C.static`, `K.static` | The static's value | Alias erasure to the declaring class's binding (already landed). A static read through a *materialized* class value routes to `JSRTClass.statics` (the runtime path above). |
| `C.prototype`, `K.prototype` | — | `not-yet(STA1214)`, "the prototype surface", Phase 8. |
| `C.length`, any other member | — | `not-yet(STA1214)`, "a member read through a class object". |
| `f(C)`, `console.log(K)`, `typeof C` | — | `not-yet(STA1214)`: the opaque class-value surface (step 12(e)). Printing needs `inspect_class` (already in the runtime) behind a materialized value. |

**HIR.** `ClassValue` names one file-scope class object by its HIR name (`className` is the key
`ClassDeclaration` registers under). `NewValue` / `InstanceOfValue` are the value-spelling twins
of `new` and `instanceof` (they dispatch through `jsrt_construct` / `jsrt_instanceof_ctor`).
`ClassDeclaration.staticProps` carries the statics table rows. All four landed as declared,
verified, rewritten and emitted (plan-notes 283); the gate admits the narrow slice above, and the
remainder of the surface stays `STA1214` until the value path is widened.

**Known divergences (narrow slice).** `C.name` is a compile-time fold, so a program that mutates
`C.name` (Node allows it on a function) cannot be expressed here. `C === D` across two distinct
declarations is not yet observable — the opaque identity surface (`f(C)`, printing) is refused.

## 5. What Phase 2 actually implements

The layout above is complete, but the walking skeleton uses only part of it. Recorded so the gap
reads as scheduling, not omission:

| Specified here | Phase 2 | Later |
|---|---|---|
| Double, `Bool`, `Undefined`, `Null`, `String` | yes | — |
| `Int32` tag | layout only, never emitted (but `jsrt_type_name` handles it, §4.7) | Phase 3 (`NUMERIC.md`) |
| `Array` tag + `JSRTArray` | yes, from rung 5 (§4.4) | — |
| `Object` tag + `JSRTClass`/`JSRTObject` | yes, from rung 6a (§4.5); `instanceof`, inheritance, statics, `#private`, method tables, accessors and object-literal shapes from rung 6b; `JSRTMap` from rung 7 (§4.6); `JSRTDynObject` shape table + ICs from Task 4.1 (§4.10) | frontend consumers of the dynamic path: Phase 5 |
| `Closure` tag + `JSRTClosure` | yes, from rung 4a | — |
| `JSRTEnv` + `JSRT_FRAME_ENV` | yes, from rung 4b | — |
| `jsrt_string_length` / `_char` | yes | — |
| Ryū + `Number::toString` format | yes | — |
| `JSRT_FRAME` / `JSRT_LOCAL` | yes, from the first emitted function | — |
| `jsrt_typeof` / `jsrt_check_*` | yes, from Task 3.5 (§4.7, §4.8) | `jsrt_check_*` for shapes: needs Task 4.1 |
| Landing-pad frame discipline | yes, from Task 3.10 (§4.9): pads take the pending exception, unwind pads pop | — |
| Boehm GC, with the mark procedure and root hook of §4.12 | yes, when `bdw-gc` is installed; plain `malloc` and no collection otherwise | precise generational, §12 |
