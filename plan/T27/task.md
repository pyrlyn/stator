---
status: in progress
priority: P1
complexity: 5
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T27. The class object — opaque class values and `this` in a static method

Phase 5 step 12(d)/(e) residue. The in-place spellings (`new K`, `K.static`, `o instanceof K`,
alias formation) work; anything else that needs to *hold* a class is refused at the gate
(`gate.ts` "using a class as a value"). `this` inside a static **method** is the same object
(field initializers and `static {}` already erase to static bindings — plan-notes 373).

Steps:
1. **Design first (§15.6):** `docs/SUBSET.md` + `docs/VALUE.md` gain the class-object model —
   what a class value *is* (descriptor + constructor function + prototype slot + static table),
   identity (`C === D`), and which members a class object exposes in v0 (`name`, `prototype`,
   static fields/methods; `length` optional).
2. HIR: a `class-object` expression node (or a documented refusal list if v0 admits only
   `C.name` / `C.static` as reads — decide and write it down).
3. Lowering + codegen: materialize the descriptor as a value; `C.name` folds to the display
   name; a static read through a class value routes to the static table.
4. `this` in a static method erases to the defining class's static binding **only** when the
   method cannot be reached through a subclass (`S.m()` vs `T.m()`); otherwise the call passes
   the reached-through class. Document the rule; implement it.
5. Decision tests both modes + goldens (`class_object_name`, `static_this_method`) byte-for-byte
   vs Node. Flip every `@expected-fail` in the same commit.

**Check:** `stator explain` on a fixture that stores `const K = C` and reads `K.name` reports
`static` (or `dynamic` if the card chose the value path) with no `STA1214`; goldens match the
pinned Node; `pnpm run test:subset` shows the 12(d)/(e) class-value rows out of expected-fail.

**Blocked on nothing.** Narrow slice allowed: land `C.name` + static reads first and leave
`C.prototype` not-yet with a named code (then the Check covers the landed subset and the
remainder is recorded here).

**Narrow slice landed 2026-10-24 (plan-notes 382).** `docs/VALUE.md` §4.26 + `docs/SUBSET.md`
class-object row; `C.name` / `K.name` folds to the display name (verdict `static`); `K.static`
keeps alias erasure; `C.prototype` stays `STA1214` ("the prototype surface", Phase 8). Fixtures
`subset_class_object_name_*` / `subset_class_object_prototype_*`, goldens `class_object_name` both
modes. **`typeof C` / `typeof K` folds to `"function"` landed 2026-10-25 (plan-notes 387)** beside
the `C.name` fold (no class object built); fixtures `subset_class_typeof_*`, goldens `class_typeof`
both modes. **Remainder (this card keeps its number and title):** materializing a class object as a
value (`f(C)`, `console.log(K)`, `K.length`, `C === D` observability), static reads
through a *materialized* value (`ClassValue` + `staticProps` / `JSRTClass.statics` population),
`this` in a static method (step 4), and `C.prototype` itself. HIR `ClassValue`/`NewValue`/
`InstanceOfValue` and the runtime class-object entries stay declared but unreachable for those
surfaces (plan-notes 283).

## Execution plan (Claude Code / claude-opus-5-5)

1. Gate (`packages/compiler/src/frontend/gate.ts`): admit a class with one evaluation as a value;
   refuse an unrelated class where `typeof C` is expected, a static method taken as a value, a
   reachable static accessor that reads `this`, and non-primitive statics read through a value.
2. Lowering (`lower/index.ts`) and codegen: `ClassValue` loads the file-scope class object; reads
   through a value go to the statics table with a boundary check; `new k()` / `instanceof k` use
   the value.
3. `this` in a static method: erase when nothing extends the class, otherwise a hidden receiver
   passed through `jsrt_call_with_this` (`CallExpr.withReceiver`, plan-notes 395).
4. Docs: `docs/VALUE.md` §4.26, `docs/SUBSET.md`, plan-notes 399.
5. Verify: decision tests in both modes, goldens `class_object_value` / `static_this_method`
   byte-for-byte vs the pinned Node, then `pnpm run ci`.
