# FFI.md — calling C from Stator (Phase 7, Task 7.1)

The contract for the extern surface: how a C function is declared, which types
may cross the boundary, who owns the memory, and what the compiler promises
(and refuses to promise) about the call. This file implements plan.md §10 Task
7.1 steps 1–2 — the surface and the ABI table, written down **before** any
lowering (plan §15.6).

Steps 4–7 have landed: error mapping, lowering and the emitter (steps 4–5), opaque
pointer pass-through borrow-only (step 6, §6), and header/link plumbing with the `@statorLink`
pragma and `--link=` (step 7, §9). The `T**` out-param question Task 7.3 forced is
answered: the `Out<T>` row (§2) with misuses at STA1125. What remains for Task 7.3 is the
ambient `CString` lib declarations (§7). Sections below
say where each remaining mechanism hooks in, but no unbuilt mechanism is claimed.

Normative companions: `docs/SUBSET.md` carries the extern rows (feature × mode
matrix), and `docs/DIAGNOSTICS.md` is the sole allocator — every code named
below has a row there. On any disagreement between this file and plan.md §10,
the plan wins and this file is edited (§15.3).

---

## 1. The marker: `declare` + `@statorExtern` in a `.d.ts`

An extern function is an ambient function declaration carrying one explicit
per-declaration marker — a JSDoc tag, TS-native, rather than Static Hermes's
`$SHBuiltin.extern_c` call form:

```ts
// sqlite.d.ts
/** @statorExtern */
declare function sqliteVersionNumber(): number;
/** @statorExtern sqlite3_open_v2 */
declare function sqliteOpenV2(filename: CString, flags: number): Ptr_sqlite3;
```

Three sub-decisions, settled here because each becomes unchangeable once
bindings exist (plan §10 Task 7.1 step 1):

1. **The marker attaches per declaration, never to a whole file.** A whole-`.d.ts`
   marking would make extern-ness silent: one new declaration in an annotated
   file would cross the trust boundary (§5) without anyone writing it down.
   Each binding is an audit point (`stator explain` flags every one, §5), so
   each one is marked. A `declare function` in a `.d.ts` _without_ the tag is
   an ordinary ambient declaration, not an extern call.
2. **The C symbol defaults to the TS name; the tag's trailing text overrides
   it.** `/** @statorExtern */` calls the C symbol spelled exactly like the TS
   function; `/** @statorExtern sqlite3_open_v2 */` calls `sqlite3_open_v2`.
   Rationale: JSDoc is readable through the TS API (`ts.getJSDocTags`) with no
   new syntax, and comments erase at emit — safe under `erasableSyntaxOnly`,
   where a decorator marker is unavailable anyway (decorators are
   error(STA1112) in both modes). No second spelling exists: one marker, one
   override position.
3. **Extern declarations are legal only in `.d.ts` files.** Elsewhere they are
   error(STA1121). Rationale (the plan's recommendation): keeping them in
   declaration files is what makes Task 7.3's generator output a drop-in, and
   it keeps the trust boundary greppable — every unchecked call site (§5) is
   declared in a file whose extension already says "this is an interface, not
   an implementation". A `declare function` WITHOUT the tag is an ordinary
   ambient declaration, not an extern: existing arms decide it (not-yet
   STA1214 today), and calls to it never reach the extern call arm.
4. **Overloads resolve to the first marked declaration.** The surface is one C
   symbol per TS name, so overloads of an extern are a user error the arity
   rule answers, not a second signature.
5. **A binding file may be a module.** `export declare function` (and `export type`
   for `CString` and the brands) turns the `.d.ts` into a module whose bindings are
   imported by relative path (`import { f } from './native/env.js'`) rather than
   seen globally, so two binding files can spell `CString` without colliding. The
   marker, the ABI and the call-site rules are the same either way; `packages/std`
   is written this way (docs/STD.md §6).

---

## 2. The ABI table

The table is the contract, and it is small on purpose (plan §10 Task 7.1
step 2):

| TS type                     | C type        | Notes                                                                                              |
| --------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `number`                    | `double`      | The unmarked case; no conversion                                                                   |
| `number` + `i32` refinement | `int32_t`     | No user spelling exists yet — until one lands, every `number` maps to `double` (`docs/NUMERIC.md`) |
| `boolean`                   | `bool`        | `<stdbool.h>`                                                                                      |
| `void`                      | `void`        | Return position only; a `void` parameter is STA1119                                                |
| branded pointer type        | `T*`          | Opaque; never dereferenced by generated code (see below)                                           |
| `Out<T>` out-slot           | `T**`         | Parameter-only; the caller allocates the cell, the callee writes it (see below)                    |
| `Out<CString>` out-slot     | `const char**`| Parameter-only; copy-on-read through `.value` (see below)                                          |
| `CString` / `CStringOwned`  | `const char*` | Allocates; see §3. `CStringOwned` is parameter-only                                                |
| `Uint8Array`                | `uint8_t *`, `size_t` | Parameter-only; the view's own bytes and length for the call, no copy (see below)          |
| anything else               | —             | Compile error (STA1119 catch-all; specific kinds below)                                            |

**Branded pointer.** An opaque handle the TS side names but never inspects:

```ts
type sqlite3 = { readonly __brand: 'sqlite3' };
```

Recognition is structural and exact: an object type (alias or interface) with
exactly one property, named `__brand`, `readonly`, of string-literal type.
The spelling prefix is irrelevant; a wider object is STA1115 whatever it names
its fields.

Generated code passes the pointer through and never dereferences it. Its
lifetime belongs to the C library, not to the collector: a binding that keeps
a pointer (a database handle, a prepared statement) uses this type, and the
declaration's documentation says who frees it and when. The two-lifetime rule
(borrowed for the call, or copied/transferred — §6) is per signature because
the compiler cannot check it; for handles v0 admits only the first — §6's
borrow-only.

**`Out<T>` out-slots.** A `T**` out-param spelled `Out<brand>` (or `const char**`
spelled `Out<CString>`):

```ts
type Out<T> = { readonly value: T };
declare function outSlot<T>(): Out<T>;
/** @statorExtern sqlite3_open */
declare function sqliteOpenDb(filename: CString, db: Out<SqliteDb>): number;

const dbSlot = outSlot<SqliteDb>();
sqliteOpenDb(":memory:", dbSlot);
const db: SqliteDb = dbSlot.value;
```

Recognition is structural and exact, mirroring brands: the `Out` alias with exactly one
type argument, an object with exactly one property named `value`. The inner must be a
branded pointer or `CString`; anything else wearing the alias is STA1125. Spelling the
same shape without the alias is a plain heap object, never a slot.

The rules, each enforced where it can be checked (the contract is STA1125 everywhere):

- Slots are created by the blessed `outSlot<T>()` — a bare-identifier call resolving to
  an ambient `declare function outSlot` with an `Out` return. A real implementation under
  the name is the user's own function, never the builtin. The call needs a resolvable
  inner: an explicit type argument (`outSlot<Db>()`) or a binding annotation
  (`const s: Out<Db> = outSlot()`).
- Slots live in locals, pass to `Out<T>` parameters (by name, or a fresh inline slot),
  and read through `.value`. Anything else — returns, aggregates, non-`Out` bindings,
  exports (STA1126) — is STA1125. Copies share nothing: every binding owns its cell, so
  write and read through the same name. Truthiness, string/number coercion, and arithmetic
  on slots are out of contract (like §6's residue: deterministic bits, never a crash).
- An out-param WRITES through the pointer, so unlike a `T*` read no runtime check can
  verify an address: only a proven slot crosses, in both modes (a dynamically-typed
  argument is STA1125, not STA2001). In `ts` mode the checker already refuses mistyped
  arguments (STA0012, like extern arity), so the gate fires only for `any` flows there.
- Representation: every slot is an ordinary frame slot holding handle-or-zero bits —
  never addresses as values, so nothing can dangle. The emitter passes the slot's own
  address (`(TAG**)&slot` under a header, `void**` in the fallback declaration) and
  copies the written bits back to a named slot after the call. Under a header the brand
  literal must be a C identifier (it names the struct tag); a lying tag fails loudly at
  the clang line, exactly like any other uncheckable boundary value (§5).
- `Out<CString>` reads copy through `from_cstr` like a `cstring` return — including its
  NULL assert, so a NULL read belongs behind the error convention guarding the call.
- A slot read before any call wrote answers the zero-handle (`+0.0`), the same rule §8
  states for NULL handles.

**`Uint8Array` views** (plan.md §11c T11.3a). One TS parameter becomes two C arguments: the
view's bytes in place and its element count.

```ts
/** @statorExtern bytes_sum */
declare function bytesSum(buf: Uint8Array): number;
```

```c
double bytes_sum(uint8_t *data, size_t length);   /* the emitted forward declaration */
bytes_sum((void *)jsrt_uint8array_bytes(slot), jsrt_uint8array_count(slot));
```

- **No copy.** The pointer is the buffer's data block plus the view's `byteOffset`, so a
  `subarray` passes its own window and a C write shows through every view of that buffer. A
  megabyte is one call (golden `extern_bytes` counts the crossings). The `void *` cast lets a
  binding header spell the pointee its own way (`char *`, `unsigned char *`, `void *`).
- **Never NULL.** A zero-length view still points at a live block (docs/VALUE.md §4.19), so a
  callee may take `data` unconditionally; it must read only `length` bytes.
- **Stable for the call, and only for the call.** Four facts make the pointer valid until the
  callee returns. The view stays in its rooted argument slot, and its `buffer` edge keeps the data
  block alive. Neither collector moves memory: Boehm is non-moving, and the no-GC build is plain
  malloc. A buffer never resizes, transfers or detaches (no such API exists). And the C call runs
  no Stator code, so nothing can collect or mutate the buffer mid-call. A callee that keeps the
  pointer past its return is out of contract: nothing roots the bytes after the call.
- **Checked on every call.** The emitter guards the layout read with `jsrt_check_uint8array`
  (STA2001 on a non-view), even for a statically proven view. A js-mode caller can reach a
  `.ts` parameter annotated `Uint8Array` with any value (only the number/string/boolean call
  edges are checked, plan-notes 308), and here a lie would be a wild pointer, not a wrong value.
  A dynamic argument carries the lowering's own check instead, so it is checked once.
- **Parameter-only.** A `Uint8Array` return is STA1119: a returned buffer has no owner and no
  length in a C signature. A callee that produces bytes fills a view the caller passes (the
  caller sizes it, as `std/io.read` does; docs/STD.md §6). An exported function keeps the
  `jsrt_value` form for a `Uint8Array` position (Task 7.2 direction).
- Only `Uint8Array`: `ArrayBuffer`, the other element types and `DataView` have no row.

**`string` deliberately maps to nothing.** UTF-16 in, bytes out is a real
conversion with a real allocation, so it is spelled at the declaration and
never inferred. A bare `string` in an extern signature is error(STA1118); the
fix is `CString` (borrow) or `CStringOwned` (transfer), §3.

**Each refusal gets its own code** (never class — the table is small by
design, so these are permanent, not scheduled; a future task that widens the
table splits a kind out with a NEW code, never by reusing one):

| Refused kind                                                                                                                 | Code           | Fix                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown` in an extern signature                                                                                             | error(STA1114) | Narrow first, or pick an ABI type. Explicit or implicit `any` counts as `unknown` here, in both modes — dynamic is inexpressible across the boundary |
| object type in an extern signature                                                                                           | error(STA1115) | Branded pointer, or `CString` for text                                                                                                               |
| array type in an extern signature                                                                                            | error(STA1116) | A `Uint8Array` for bytes (the row above); otherwise a pointer + length as ABI types                                                                  |
| function/closure type in an extern signature                                                                                 | error(STA1117) | v0 has no trampoline; C calls in via Task 7.2 exports instead                                                                                        |
| bare `string` in an extern signature                                                                                         | error(STA1118) | `CString` (borrow) or `CStringOwned` (transfer)                                                                                                      |
| anything else outside the table — incl. struct by value, `Out` misuses (STA1125), `void` as a parameter, `CStringOwned` or `Uint8Array` as a return | error(STA1119) | No mapping exists in v0                                                                                                                              |
| variadic (`printf`-style) extern declaration                                                                                 | error(STA1120) | No sound signature; each call site is a different function type (permanent — plan §10 out-of-scope table)                                            |
| extern declaration outside a `.d.ts`                                                                                         | error(STA1121) | Move it into a `.d.ts` (§1.3)                                                                                                                        |

Notes on the refusals: `Unknown`, objects, arrays, and closures are errors by
construction — they are the cases that would need boxing, and "no boxing for
primitives" is only meaningful if the non-primitives are refused rather than
silently boxed. Struct **by value** is STA1119 for v0 (ABI layout per platform
is a task of its own; plan §10 out-of-scope table). `T**` out-params — the
SQLite shape — were STA1119 until v0.1 answered the question Task 7.3 forced: the
`Out<T>` row above, with misuses split out to STA1125 per this table's own promise.
What stays refused: `T**` in return position, `T**` over non-brand non-`CString`
pointees, and nullable-pointer parameters (e.g. `sqlite3_open_v2`'s `zVfs`) — each
STA1119 naming the position. C++ symbols, name mangling,
and C calling back into a JS closure have no spelling in this surface at all,
so there is nothing for the gate to refuse; they are out of scope for v0 by
the plan's table, not by a code. Threads: v0 FFI is single-threaded, said out
loud (OS threads + async bridge are Phase 10, T10.2).

---

## 3. Strings, both directions, with the lifetime written down

`CString` is NUL-terminated UTF-8 at the boundary. The two directions are
asymmetric on purpose:

- **In (TS → C).** The runtime allocates a NUL-terminated UTF-8 copy of the
  JS string for the call. Default (`CString`) is a **borrow**: the copy is
  freed after the call returns, and the callee must not retain the pointer.
  If the callee stores the pointer, the declaration spells `CStringOwned`
  instead — ownership **transfers** to the callee, and the runtime never frees
  it. Two options only, because a third would be a lifetime the compiler
  cannot express.
- **Out (C → TS).** A `const char*` return is **copied** into a fresh runtime
  (UTF-16) string at the boundary — never wrapped, because a wrapper's
  lifetime belongs to the C library and nothing in the runtime can track it.
  Declare the return as **`CString`** (the parameter spelling works in both
  positions; `CStringOwned` stays parameter-only). The original pointer is
  never freed by the runtime either: the allocator is the library's, not ours. A C function that `malloc`s its return needs an
  explicit free function in the same binding, declared as its own extern; the
  binding's documentation says so.

Away from the call, a `CString` value is a string: the brand is a phantom only
the extern signature reads, so `const v = cEcho(s as CString)` and an arrow
whose return is inferred from an extern call are statically typed `string`
(plan-notes 322). Its string surface (`.length`, methods) still wants a
`string`-typed binding first: the gate reads string-ness from the checker,
which does not see through the brand.

Two stated answers, not accidents:

- **Embedded NULs (in).** A JS string containing U+0000 is truncated at the
  first NUL — C string semantics. Documented here so no one discovers it from
  a corrupted query.
- **Invalid UTF-8 (out).** Bytes that are not well-formed UTF-8 decode to
  U+FFFD (replacement character), one per maximal invalid subsequence — the
  rule Node's `Buffer.toString('utf8')` applies.
- **Lone surrogates (in).** Each lone surrogate encodes as U+FFFD (standard
  UTF-8, not WTF-8) — which makes `to_cstr∘from_cstr` a fixed point, proved by
  the `print_ffi_strings` corpus.
- **NULL returns.** `from_cstr(NULL)` asserts: a NULL return belongs to the
  step-4 `@statorError null` convention, which must guard the call — the
  converter never sees one.

`CStringOwned` in return position is STA1119: a returned pointer the runtime
must free has no known allocator (§5's asymmetry again — the doc cannot name
what it cannot check, so it refuses instead).

---

## 4. Errors: C returns codes, and only the declaration knows what they mean

**Default: the return value is a plain value and a failing call is not an
exception.** Opt in per declaration with one of a closed set of conventions,
spelled as a second JSDoc tag with a closed vocabulary:

```ts
/** @statorExtern @statorError nonzero */
declare function sqliteStep(stmt: sqlite3_stmt): number;
```

| Tag                     | Meaning; the lowering emits the throw                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| _(absent)_              | No convention: the return is a value, never an exception                                          |
| `@statorError nonzero`  | Nonzero return throws                                                                             |
| `@statorError negative` | Negative return throws                                                                            |
| `@statorError null`     | NULL (pointer-typed) return throws — a `CString` return or a branded pointer                      |
| `@statorError errno`    | `errno` carries the failure; it is read immediately after the call, before any other runtime call |

The thrown value is an `Error` naming the TS function and the failed convention —
`extern call '<tsName>' failed: <nonzero return | negative return | NULL return | errno set>` —
raised through the runtime's own literal-message throw
(`jsrt_throw_error(&jsrt_class_error, ...)`), so a `catch` reads `name`/`message`/`instanceof`
like any other `Error`. The vocabulary is closed: a
misspelled convention is a gate error at the declaration, not a silent
default — a binding that invents its own convention is the failure this
section exists to prevent. Conventions compose with return kinds only where
the combination means something: `nonzero`/`negative` require `number`
returns, `null` requires a `CString` or branded-pointer return, `errno`
combines with anything including `void` (it is read before any copy allocation);
anything else is STA1119 naming the mismatch. A NULL handle throws rather than becoming a
usable value: the check guards the call, so a failed open never yields a handle to close.

Two absolutes (plan's words):

- A JS exception must **never** unwind through a C frame. The extern call is
  emitted outside any construct that could throw across it; the mechanism is
  step 5's, the invariant is stated here.
- An unmapped nonzero return must not be silently discarded. A declaration
  that maps a value-returning C function to TS `void` is STA1119 — discarding
  would hide exactly the failures conventions exist to surface.

---

## 5. The trust boundary, honestly named

Plan §0 rule 2 says never trust an annotation without a boundary check — but
a C return value **cannot** be runtime-checked, so FFI is the one boundary
where the annotation is asserted by a human and not verified. `stator explain`
marks every extern call as an **unchecked boundary** so an audit can enumerate
every one of them. The mark rides **alongside** the verdict, not instead of
it: the four-verdict vocabulary (`static | dynamic | error | not-yet`,
`docs/MODES.md` §6) is unchanged, and `tests/subset/run.ts` keeps reading
verdict + code only. Steps 5+ have landed, so compiled calls carry the flag: `ts`-mode
extern calls are `static` + flag (direct C calls, unboxed); `js`-mode calls are `static` +
flag when every argument is statically typed, else `dynamic` + flag. A handle-typed
argument never contributes `dynamic` by itself: it crosses unboxed with no check to fail,
so the call's mechanics are static whatever the HType says (the HIR cannot name a brand).
An out-slot is the same story one step further: creating, passing, and reading a slot never
touches the dynamic representation, so slot positions are `static` — legality is the gate's
STA1125 contract, never a verdict. A dynamically-typed argument at an `Out` parameter is the
one place `js` mode refuses where it would otherwise check: no runtime test can verify a
slot address, so there is nothing for STA2001 to do.
A call that does not compile — a refusal — carries no flag: it is not a
boundary, it is a refusal, and its code already names it. Refusals surface at the
**declaration** (STA1114–21); STA1217 additionally surfaces at value-use sites, the one
call position the declaration verdict does not cover. (An optional call `ext?.()` is a
direct call, not a refusal: the callee always links, so `?.` is a proven no-op.)

This is also the honest answer to "why is FFI not available in `ts` mode's
safety story" — it is, with the caveat printed. (`docs/MODES.md`'s rule that
`.d.ts` declarations are trusted-with-a-call-site-check holds for
Stator-compiled implementations; extern C declarations are the carved-out
exception, and the flag is the carve mark.)

**`js` mode.** The extern declaration itself is identical in both modes; only
the checks differ. Arguments arriving from untyped code are dynamic, so they
get a boundary check at the call and `STA2001` on mismatch — the existing
runtime trap doing its existing job, not a new mechanism.

---

## 6. Ownership, per signature

A pointer handed to C is invisible to the collector for the duration of the
call. The frame that owns it stays live across the call, and the callee must
not retain it past return unless the declaration says it takes ownership —
`CString` (borrow) versus `CStringOwned` (transfer) in §3 is this rule worked
out for strings. Opaque handles are borrow-only in v0: there is no transfer
spelling for a branded pointer, so every one crosses untouched and unretained,
and any use that would retain one past the call — aliasing the extern as a value —
stays STA1217 (phaseless: no open phase owns a C value representation for externs).

What the emitter guarantees, by construction rather than by audit
(plan §10 Task 7.1 step 6):

- Arguments evaluate into rooted frame slots first; the call reads each handle
  from its slot (`jsrt_ptr`) at the call — the slot, and the frame holding it,
  stay live across it, because frames pop only at returns and landing-pad
  dispatch, neither of which a direct C call can reach.
- The handle is never dereferenced and never stored anywhere but the callee's
  parameter: generated code has no load through it and no copy beside the slot.
- A returned handle lands in a C local and is stored to its slot by bit pattern
  (`(jsrt_value)(uintptr_t)` — the loop state's raw-`JSRTEnv *`-in-a-slot
  precedent, safe because the collector masks every word). No GC allocation
  stands between receipt and rooting: the `errno` read is an int, the frees are
  libc, and the convention throw runs only after the frees, with nothing
  outstanding.

Three positions are supported: an extern return producing a handle, a binding
(or call argument, or return) forwarding it, and a pointer parameter consuming
it. Everything else a program can spell with a handle — printing it, arithmetic
on it, reading a property through it — is out of scope in v0, with behavior the
contract does not define: the HIR cannot name a brand, so no position past the
three can tell a handle from the value its bits resemble. Refusing those
positions is follow-up work with its own pins, not this section.

---

## 7. Open items for steps 5+

When the implementation starts, it owes, in one change each where the plan
demands it (§15.3, §15.6):

1. ~~Gate wiring for the marker, the eight refusal codes, and STA1217 (phase 7 —
   an open phase, so `src/support/phases.ts` needs no change; `COMPLETED_PHASES`
   lists finished phases only, and `tests/unit/phases.test.ts` already enforces
   that no `not-yet` names one).~~ Landed with steps 4–5: `src/frontend/extern.ts`
   classifies (the one reader of the surface, shared by gate and lowering), the gate
   accepts direct calls and refuses signatures/call shapes, and STA1217 now names only
   what steps 5+ do not cover (branded pointers → step 6; extern-as-value). The landing
   added three rules the surface implies but never wrote down: exact arity (STA1119 in
   `js` mode; the checker's own arity diagnostic owns it in `ts` mode), no spread
   (STA1119), and direct-callee-position only (STA1217 elsewhere). Step 6 landed
   separately and closed the pointer deferral: brands classify as the `pointer` ABI
   kind (borrow-only, §6), so STA1217 names only extern-as-value and optional-call
   positions now. Step 7 landed with §9. (Phase 7 close-out, 2026-09-16: the optional
   call delivered as a direct call — `?.` is a proven no-op on an always-linked callee —
   so STA1217 is extern-as-value only, phaseless since no open phase owns it.)
2. ~~Decision fixtures in both modes for every `docs/SUBSET.md` extern row
   (extern call, each refusal kind, varargs, outside-`.d.ts`, the
   unchecked-boundary mark) — `// @expected-fail: true` until the gate lands
   them, removed in the landing commit (AGENTS.md Testing rules).~~ Landed with
   steps 4–5 (the four step-3 `subset_extern_cstr_*` fixtures flipped to `static` in the
   same commit) plus the `subset_extern_direct_*`/`error_*`/`value_*`/`arity_*`/`spread_*`/
   `ptr_*`/`badconv_*`/`convmismatch_*` rows for the rules item 1 added.
3. ~~The `@statorError` throw wording, the errno-read sequence,~~ and the ambient
   `CString` / `CStringOwned` declarations in the stator lib. Wording and sequence landed
   with steps 4–5 (§4 names both); the ambient lib declarations stay open for §7.3, which
   owns the binding set — fixtures declare the brands locally until then.
4. ~~The `T**` out-param question Task 7.3's SQLite binding forced
   (STA1119 until then — §2).~~ Answered in v0.1: the `Out<T>` row (§2), with misuses
   split out to STA1125. What stays refused (STA1119 naming the position): `T**` returns,
   `T**` over non-brand non-`CString` pointees, and nullable-pointer parameters.
5. ~~`docs/README.md` index and the AGENTS.md repo map do not list this file
   yet~~ — done alongside the surface commit; both list `FFI.md` now.
6. `docs/SUBSET.md` Types-row note still says "FFI returns are still Phase 6";
   FFI is Phase 7 (§10) and Phase 6 is conformance/fuzzing (§9). Left
   deliberately: the row covers boundary-checked narrowing where Phase 6 is
   the proof venue (differential evidence), not the feature owner — flipping
   it would assert an undecided owner change (plan-notes 253).

## 8. Task 7.2 design sketch (non-normative appendix — proposed, not approved)

The sections above are the Task 7.1 contract; what follows is an agent-drafted sketch ahead
of Task 7.2, kept here so the implementer finds it. Steps 1–9 have LANDED (below):
step 8's determinism rule is proved by a real `--emit-header` double build in
`packages/tests/ffi/run.ts` (not only the unit-level byte-compare), and step 9's CI example
lives in `packages/tests/ffi/example-c-consumer/` and runs in the ffi CI job. What remains
sketch is only the *wording* of this appendix, which still narrates steps 8–9 as future work.

Landed (steps 1–2): `--emit-header`, the reverse mapping, the export decision, and the
determinism rule. `src/frontend/export.ts` is the only reader of the export surface;
`src/frontend/extern.ts`'s `exportAbiKindOf` is the table's export direction — one table,
two directions, so the halves cannot drift. `STA1122`–`STA1124` and `STA1126` are allocated rows in
`docs/DIAGNOSTICS.md`, no longer proposals.

Landed (steps 3–5): the init contract, the TS-throws contract, and the frame/stack roots —
`src/codegen/` (the C emitter family modules; `emitC` is re-exported from `index.ts`) emits them from the same slot layout `main` uses, `build.ts` roots
the shake at the export names, and every decision below is pinned in
`tests/unit/export-stubs.test.ts` (in-process shape plus a linked C `main()` proving the
init→call→error paths; the CI example stays step 9's). Recorded choices, each made once
and generated uniformly:

- **Init is `stator_init_<unit>()`, declared first in the header** — GC, the globals
  frame, the module environment, then the merged module's top-level statements in Task
  3.11 order (the SAME emission `main` runs, shared helpers, never a second copy), then
  the microtask drain, then the exported-const stores. Idempotent via a set-before static
  guard: a second `JSRT_GLOBALS_ENTER` would wipe every global. `jsrt_init()` is
  idempotent on its own (plan-notes 341): two units linked against one `libjsrt.a` each
  call it, and before the guard in `jsrt_gc_init` the second call installed the Boehm roots
  hook as its own predecessor, so the first collection overflowed the stack. Calling an exported function before init
  is undefined behavior (the header says so). A top-level throw lands in the error cell
  like any stub failure instead of `jsrt_uncaught`'s exit — the unit is then unusable.
  `jsrt_init` also installs the stack-overflow fault handler for SIGSEGV and SIGBUS
  (docs/VALUE.md §4.25); a fault that is not a stack overflow is handed back to whatever
  handler the host program had installed before. A top-level-await module starts and drains like `main`'s async startup; a rejected body
  parks its reason for the init to capture rather than exiting, while an unhandled
  rejection from a queued job still exits exactly as in `main`.
- **Throws are `stator_<unit>_last_error()` (NULL = success) plus a zero-value sentinel**
  per C spelling — `0.0`, `false`, `NULL`, `JSRT_UNDEFINED`; `void` has nothing to get
  wrong. The companion carries the unit prefix (step 7's mangling applied to a generated
  symbol) so two units linked together never share one cell. Cleared on every stub entry,
  `_Thread_local` storage, valid until the next exported call. Never abort, never unwind:
  the stub takes the pending cell into a ROOTED slot (a frame slot, or the scratch global
  in init — never a bare C local across the `to_string` allocation), renders it through
  `jsrt_to_string` (total in this subset: no `valueOf`, no `Symbol.toPrimitive`), and
  answers the sentinel. A `NULL` `const char *` argument is the same path — a catchable
  `TypeError` in the cell, never the converter's assert. Panics (`STA2002`, OOM) still
  abort: they are internal errors, not exceptions, and aborting does not unwind.
- **Every stub opens one `JSRT_FRAME` (argc + answer, floor 1) and pops it on every exit**
  — the normal return and the single `_jsrt_err` epilogue every throw path funnels
  through. Arguments convert into the frame's slots (which double as `argv`), so every
  operand is rooted across the call's own allocation. Stubs never `JSRT_GLOBALS_ENTER`
  (init owns it). No per-call Boehm registration exists in v0, deliberately: Boehm scans
  the init thread's C stack itself since `jsrt_init`, every stub runs on that thread, and
  a second thread is UB by the header — Phase 10 adds `GC_register_my_thread` at spawn,
  which is already where that registration belongs.
- **Ownership at the edge, stated once:** a `const char *` PARAMETER is the caller's
  borrow (copied in, never freed, never retained); a `const char *` ANSWER is a fresh
  malloc copy the caller frees. A `void *` travels by bit pattern both ways and is never
  inspected — which fixes its NULL rule: a NULL handle arrives as `+0.0` (bit pattern
  zero), round-trips back to NULL, and cannot be tested from TS in v0 (the checker
  refuses the comparison that would observe it). A `jsrt_value` answer is additionally
  parked in the rooted scratch global, so "live until the next call" is a mechanism, not
  a promise — root longer-lived values in the caller's own `JSRT_FRAME`. Exported consts
  are defined mutable in the object and stored by init from their globals (const-after-
  init; the header's `extern const` is the consumer's never-write view), so computed
  primitives link with the same symbol a literal one does. A `CString` const spells one
  `const`, not two (`extern const char *` — the doubled form fails the consumer build).
- **Version note:** `EXPORT_ABI_VERSION` stays 0. Steps 3–5 complete the v0 contract the
  version was introduced alongside; they do not revise a shipped one — and a skewed
  header/object pair already fails at link time on the missing init/stub symbols
  themselves. The bump protocol (test + header + link proof together) governs the first
  real revision.

Landed (steps 6–7): the single-threaded-v0 sentence rides every emitted header (`calling
in from a second thread is undefined behavior until T10.2`); the `stator_<unit>_<name>`
mangling with the `--unit-name` prefix and sanitization, STA1124 refusing collisions on
the sanitized symbol, and the `stator_<unit>_abi_v<V>` version symbol the header declares
and the object defines — a header from one build linked against an object from another
fails at link time instead of at runtime. All pinned in `tests/unit/export-header.test.ts`
plus a manual link proof (fresh pair links and runs; version-skewed pair fails with
`Undefined symbols ... "_stator_<unit>_abi_v<V>"`).

- **Export marker is ESM `export`, no new marker.** The C-visible set is exactly the
  exported-function set (no second list to drift); header declares `stator_<unit>_<name>`.
- **`--emit-header=<path.h>` + `--unit-name=<unit>`** (both `--flag=value` and
  `--flag value` forms) — LANDED. With the flag, `-o` names a relocatable object
  (`clang -c`), no `main()` required and nothing linked; `--emit=c` alongside writes the C
  and the header and skips clang. `--unit-name` overrides the default unit (the entry's
  file basename, sanitized to a C identifier). An explicit name must already be one
  (`^[A-Za-z0-9_]+$`, else `STA0004`, plan.md §9 Task 6.20): sanitizing is not injective, so
  `my-lib` and `my_lib` would export the same symbols. `--link` and
  `@statorLink` flags are accepted but inert with the flag — linking is the consumer's
  job, and the consumer link line arrives with step 9. Under `--emit=lib` (below) they are
  not inert: they join the `.pc` file's `Libs`. An exported function whose WHOLE
  signature is in §2's table spells plain C types; any other position spells `jsrt_value`.
  An exported `const` number/boolean spells `extern const double`/`bool`, a `CString`
  `extern const char *`, a string/null/undefined `extern const jsrt_value`. The header
  carries no timestamps, no paths, and no hash-ordered iteration — same input,
  byte-identical output, proved by a unit test that collects twice. Only the entry file's
  direct declaration exports are read.
- **Init contract — LANDED, see the record above.** (Was: top-level statements in
  Task 3.11 order become `stator_init_<unit>()`, idempotent via a set-before static guard.)
- **Throws — LANDED, see the record above.** (Was: companion `stator_last_error()`
  (NULL = success) + documented zero-value sentinel; never abort. The unit prefix on the
  companion name resolves the sketch's open collision question per step 7.)
- **Frames — LANDED, see the record above.** (Was: every stub opens one `JSRT_FRAME`,
  pops on every exit path; args convert into frame slots; stubs never `JSRT_GLOBALS_ENTER`.)
- **Refusals — LANDED as `docs/DIAGNOSTICS.md` rows (never class):** `STA1122` the
  declaration shape (class, closure-valued const, generic function, rest/destructured
  parameter, `export default`, re-export and other non-declaration export forms);
  `STA1123` mutable or non-primitive exported state (`let`/`var`, destructured or
  uninitialized consts, consts of non-primitive type); `STA1124` two exports colliding on
  one `stator_<unit>_<name>` — a compile error, never last-writer-wins; `STA1126` an
  exported `Out<T>` slot, which names a call-local address with no cross-boundary meaning.
- **Tests:** `tests/ffi/` fixture + `main.c` byte-compare, double-build `cmp`
  determinism, collision/error-path goldens, GC-hygiene loop under Boehm, ASan job.

### Static library: `--emit=lib` (plan.md §10 Task 7.4) — LANDED

`--emit=lib` (config `"emit": "lib"`) turns the `--emit-header` object into three files a C
build can use with no Stator checkout:

```sh
stator build unit.ts --emit=lib -o out/libconsumer.a --emit-header=out/consumer.h --unit-name consumer
PKG_CONFIG_PATH=out cc main.c $(pkg-config --cflags --libs libconsumer) -o app
```

- **`-o lib<name>.a`** holds one member, `<name>.o`: the unit's object prelinked (`cc -r`)
  with the runtime archive members it reaches — `libjsrt_std.a` when the unit imports
  `std/*`, then `libjsrt.a`. Any other `-o` spelling is `STA0004`, because `-l<name>` finds
  nothing else, and so is `--emit=lib` without `--emit-header`.
- **`lib<name>.pc`** is written beside the archive. It is relocatable (`prefix=${pcfiledir}`),
  so the three files can move together. `Libs` carries exactly the binary link's list
  (`build.ts` `systemLinkFlags`: the runtime's recorded `link-flags.txt` — Boehm's `-lgc`,
  `-lm` — plus the unit's `@statorLink` and `--link=` flags), all in `Libs` rather than
  `Libs.private`: there is no shared variant, and `pkg-config --libs` must give a working
  line without `--static`.
- **The runtime is private.** Every global in the member except the header's symbols
  (`stator_<unit>_*`, the version symbol) is made local: on Mach-O through the linker's
  `-exported_symbols_list`, which `ld -r` turns into static symbols; on ELF through
  `objcopy --keep-global-symbols` after the link. Two Stator libraries therefore link into
  one program without colliding on `jsrt_*`, each with its own runtime, frames and
  globals. A third choice, `--runtime=external` (the consumer links one shared
  `libjsrt.a`), was measured and not taken: it leaks the runtime's ~900 symbols into the
  consumer's namespace and makes the consumer pick a matching archive by hand
  (plan-notes 342).
- **Consequences of the private runtime**, measured in plan-notes 342:
  1. *Size*: each library carries its own runtime, about 200 KB of code per extra library
     in a program (`-dead_strip`; the member before the final link is about 400 KB). One
     library costs what an `--emit-header` object plus `libjsrt.a` costs.
  2. *One collector*: Boehm stays a shared system library, so every runtime copy shares one
     heap. The copies share one Boehm object kind through a weak global the library keeps
     exported (`jsrt_gc_shared_kind_p48`, `packages/runtime/src/jsrt_mem.h`); without it the
     13th library in one process aborted with Boehm's "Too many kinds". Each copy chains
     its own roots hook, so a collection sees every library's frames.
  3. *No `jsrt_value` crossing*: an export whose header would need `jsrt_value.h` (any
     position outside §2's table) is `STA1220` under `--emit=lib`, because the consumer
     has no runtime API to make or read one. Plain `--emit-header` still exposes it.
  4. *One stack guard per copy*: each runtime's init measures the calling thread's stack and
     sets its own limit, so unbounded recursion inside any library is a `RangeError` in that
     library's `last_error`. The SIGSEGV/SIGBUS fault handler (plan-notes 338) is installed
     once per copy; each one hands a fault outside its guard region back to the handler it
     replaced, so the copies chain like the Boehm roots hooks do.
- **Deterministic**: the prelink drops debug information (`-Wl,-S`), which would name the
  build machine's runtime paths, and the archiver runs in its deterministic mode (`ar D` on
  ELF; `ZERO_AR_DATE=1` for Apple's `ar`, which refuses `D`). Two builds of the same input
  give byte-identical `.a`, `.h` and `.pc`. The archive still names the unit's own source
  files where the program reports them (a call site's `file:line` for error stacks, as in a
  binary), so building the same unit from another directory changes those strings. The sanitized flavor (`STATOR_RUNTIME=asan`)
  keeps its debug information for line numbers in reports, so its archive is not
  byte-reproducible; it is a test build, never one to hand out.
- **Tools**: `$CC` for the prelink, `objcopy` on ELF and `ar`; `OBJCOPY` and `AR` override
  the last two. A missing or failing one is `STA0020` (`docs/TOOLCHAIN.md`).
- **Windows** is `STA1219` (not yet): a COFF library needs `llvm-lib` and a symbol
  localization this path does not have.
- **Proof**: `packages/tests/ffi/example-c-consumer/static-lib.ts` builds the example twice
  and compares the bytes, links `main.c` from a fresh directory through `pkg-config` alone
  and checks `expected.txt`, then links `consumer` and a second library (`keeper.ts`) into
  `two.c`, forces Boehm collections between calls into both, and overflows the stack in one
  while the other keeps answering. The ffi CI jobs (Linux and
  macOS) run it, and so does the ASan gate (`pnpm run test:asan`) against the sanitized
  runtime.

---

## 9. Headers and link flags (step 7)

An extern declaration needs two things the signature does not name: a header to
compile against and a library to link. Both arrive through one per-`.d.ts` pragma
plus one CLI escape hatch — this section is the whole of that plumbing, and closes
gap G6 (plan-notes 256: the pragma had no spelling and no provenance until it).

### The pragma: `// @statorLink …`

One marker, two forms, per declaration file:

```ts
// sqlite.d.ts
// @statorLink: -lsqlite3
// @statorLink #include <sqlite3.h>
/** @statorExtern sqlite3_open_v2 */
declare function sqliteOpenV2(filename: CString, flags: number): sqlite3;
```

- **Flags form.** Everything after the marker is link flags in file order, from
  an allowlist: `-l<name>`, `-L<dir>`, `-framework <name>` and
  `-Wl,-rpath,<dir>` (one directory, no further comma). Anything else — an
  archive path, `-Wl,--start-group`, `-fplugin=`, `-Xclang`, `-o` — is STA1119
  naming the flag. Any `.d.ts` in the program can carry a pragma, a dependency's
  included, and its words reach clang's argv, so an arbitrary flag would let a
  dependency run or redirect code at `stator build` time; the user's own
  `--link=` stays the escape hatch for everything else (plan-notes 330, 335).
  The colon is optional —
  `// @statorLink: -lfoo` and `// @statorLink -lfoo` are the same pragma, matching
  the `// @directive: value` shape every other file-level directive in this repo
  uses. Words split on whitespace; `"..."` groups across it (for paths with
  spaces). Several lines accumulate in file order.
- **Header form.** `#include` plus exactly one header: `<...>` as written,
  `"..."` as written for a bare name (resolved through the link line's `-I`
  flags like any user header), and `"..."` containing a `/` resolved against the
  declaring file — because the generated C lives in a scratch directory where a
  relative include would otherwise point nowhere. At most one `#include` per
  file: one binding file wraps one library, so a second header names a second
  binding the file does not contain. `#include` reads a header name literally
  (no escape sequence exists inside one), so the resolved path is emitted as
  written, non-ASCII included, and a path holding a `"`, a line break or NUL —
  which no `#include` can spell — is STA1119 at the pragma.
- **Shape rules, all permanent (`never`, STA1119 at the pragma's own line):** a
  malformed line (bare marker, unterminated quote, unquoted or doubled `#include`,
  any other `#directive`); a flag outside the allowlist; a header path no
  `#include` can spell; a pragma in a file with no `@statorExtern`
  declaration — flags belong to the binding they link, so a stray is refused
  rather than linked or dropped silently; a second `#include` in one file.
  Only `//` line comments carry the pragma (block comments and JSDoc never do),
  and only `.d.ts` files are read — a line elsewhere is an ordinary comment.

What the header DOES. The prologue emits the binding headers after the runtime
headers (`jsrt_value.h`, then `<errno.h>`/`<stdlib.h>` when owed), and emits NO
forward declaration for that file's symbols: the header's real prototype governs
the call. That is what lets a binding use libc's true `size_t` signatures
(`malloc`, `memset`, `memcmp` — the `extern_ptr` golden), where the emitter's
`double`-based spelling would be undefined behavior. Without a header the
emitter declares each symbol from the ABI kinds (`void *` for a handle): a
definition that agrees at the ABI level links, and one that does not fails
loudly at the clang line — the trust boundary fails closed, exactly as §2's
`strlen`/`size_t` rule already required.

### The escape hatch: `--link=`

`stator build … --link=-lsqlite3 --link="-L/opt/x/lib"` — repeatable, in both
`--link=X` and `--link X` forms, each value splitting on whitespace like the
pragma. A missing or empty value is STA0004 (it almost always means an
unexpanded `$VAR`, and an invisible no-op would hide that). The hatch joins the
pragma flags at the link — never in the C — so a consumer can satisfy a binding
without editing it.

### Order, dedup, and the link line

`linkExecutable` assembles one line: the recorded `link-flags.txt` first, then
the pragma flags in program order (the order the user's own references and
imports discover the bindings in — which is the order a static link reads
them), then the CLI flags in command-line order. Duplicate `-l` libraries drop
first-wins; everything else passes through verbatim in order — no sorting ever,
because link order is load-bearing for static archives, and grouping flags
(`-Wl,--start-group` … `--end-group`, `--link=` only) cross untouched for the
rare circular one. A link that fails with extern flags on the line reports STA0009 naming the
flags: a missing library is a configuration error, not a compiler bug, and the
message says where to look first.

`libm` needs no plumbing: `-lm` already rides every link inside the recorded
`link-flags.txt` (the justfile's `SYS_LIBS`), so the `extern_libm` golden calls
`sqrt`/`fmod` with no pragma at all — the proof, not a second mechanism. The
rule generalizes: a system library the recorded flags already provide needs no
pragma; the pragma is for the binding's own library.

### The harness side

A golden fixture directory may carry its own `.c` sources next to the entry
(plan §10 step 10): the runner compiles each with the same C11
`-Wall -Wextra -Werror` discipline as the runtime and links the objects through
the `--link=` channel — the `extraLinkFlags` consumer path, exercised by a test
instead of asserted by a comment. The `extern_ptr` golden is the shape's proof:
a two-function fixture C (sentinel identity, no header) beside real-libc
allocation (header pragmas, true prototypes), byte-identical against Node.
