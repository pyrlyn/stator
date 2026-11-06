---
status: in progress
priority: P1
complexity: 5
readiness: 0%
agent: Claude Code / opus-5-5
---

# T11.4. `packages/compiler`: js-mode coverage for the `tsc` bundle

The largest P0 item (plan-notes 286). Prerequisites run in their own sessions: the `STA4072`
stack overflow on large inputs and the js-mode false rejections (the TS2630/TS2698 pair landed,
plan-notes 297; the 45 `STA0012` left on `_tsc.js` are Node globals, the platform's work). Then
the `STA1214` families on
`_tsc.js`: method calls on inferred shapes (402), assignment to non-variables (518),
unsupported globals (111), spreads (~190), Map/Set from iterables (71), `new` on non-class (50),
index access on non-array (33), `Object.*` (24), destructuring (31), class expressions (~8).
Each family is its own sub-step with its own fixtures — none of it is Node-specific.

One PR per family, each with decision tests in
both modes and goldens, a full `pnpm run ci`, and the self-compilation baseline re-recorded with
`--update` when its counts move.

**Execution plan** (re-measured on 68c8d57, plan-notes 310; counts are `STA1214` messages):

1. **Unsupported globals (78) — landed** (plan-notes 310; 78 → 20: `require`, `Array(n)`,
   `Array.from`, `encodeURI`, `Error.captureStackTrace` and `arguments` remain, each assigned to a
   later family). Exempt the property NAME of an object binding pattern, which is
   not a reference (about 22 of the 78: `{ setTimeout: setTimeout2 } = host`). Lower the global
   converters and number functions as callees through one table-driven node, the
   `String.fromCharCode` pattern: `String(x)`, `Number(x)`, `Boolean(x)`, `parseInt`,
   `parseFloat`, `isNaN`, `isFinite`, plus `Array.isArray`. `typeof` of a global the compiler
   knows answers its constant. `require`, `arguments` and `Error.captureStackTrace` stay refused
   (CommonJS is T11.5; the other two are not values Stator models).
2. **Method calls on inferred shapes (403) — landed** (plan-notes 310; 403 → 19). A call of a
   function-valued field of an object shape is a `field-call` node, and `n.toString(radix)` /
   `n.toFixed(digits)` are a `number-op` node; `Number.parseInt`/`parseFloat` and the `Number`
   constants land with them. Left for step 9: `.call`/`.apply` on a function (13), static calls on
   a class expression (3) and receivers typed as possibly `undefined` (3).
3. **Assignment and compound assignment to non-variables (525) — landed** (plan-notes 310; 525 →
   97). Compound, logical and update forms on dynamic receivers, `xs.length = n`, and
   destructuring assignment of variables as a statement. The 92 plain writes of a property the
   object's shape does not declare are layout growth and move to step 7; the 5 on a `Map` or an
   array go to steps 6 and 7.
4. **`new` on non-class (50): function constructors — landed** (plan-notes 310; 50 → 28). `new`
   and `instanceof` on an ordinary function or an Unknown callee, a function's own properties and
   its `prototype`, and prototype-chain reads on what `new` built (docs/VALUE.md §4.20). The 28 left
   are builtins, split off as step 4b.
   4b. **The builtin constructors left by step 4 — landed** (plan-notes 310; 32 → 2). `new
   Array(n)` (13) and `Array(n)` (4) with array holes in an Unknown-element array (docs/VALUE.md
   §4.4), `new RegExp(pattern, flags)` (8, §4.21), `WeakMap` (4) and `WeakSet` (2, §4.22). Left:
   `Array.from` (1), which is a spread over an iterator and moves to step 5, and `new Uint16Array`
   (1), T11.1's typed-array surface, not this card's.
5. **Spreads (196) — landed** (plan-notes 310; 196 → 3). Call, method-call and array-method
   arguments build one list and call through `jsrt_call_spread_at`; an array-literal spread of
   any iterable drains through the `...` row; `Array.from(iterable)` (from step 4b) is a
   `global-call` row (docs/VALUE.md §4.23). Left: an object spread of a value with no fixed shape
   (2), which is step 8's `Object.*` surface, and a spread into `String.fromCharCode` (1), step 9.
   Map/Set from an iterable (73) is step 6, which can now drain through the same helper.
6. **Map/Set from iterables (73)**, Map `add`/`remove` misuse included.
7. **Layout growth — landed** (plan-notes 310; 55 reads + 92 writes + 33 index accesses → 0 + 5
   + 6). A fixed object grows through an overflow table: `JSRTObject.extras`, a dynamic object
   allocated by the first write of a name its layout does not declare (docs/VALUE.md §4.24). In
   js mode, a read, write, compound write, call or `delete` of an undeclared member is a dynamic
   node, and a string or number key on a fixed object is a by-name index access. Left: the 3
   named writes on an array (`queue.pollIndex = 0`) and the 2 on a `Map` (`map2.add = …`), which
   go through the builtins' member gate (the `Map` pair rides step 6; the array writes stay here),
   and 6 index accesses whose receiver is a string or a union. Both residues stay with this step,
   queued after step 11.
8. **`Object.*` (21)** and destructuring (31, for-of, declarations, parameters), split in two:
   8a. **`Object.*` reflection — in progress, Claude Code / sonnet-5-5** (handed over by the card's
   owner; it unblocks T12.3's `__toESM`/`__copyProps`). Execution plan: property attributes on a
   dynamic object (the accessor cell of docs/VALUE.md §4.15 grows a data form and
   `enumerable`/`writable`/`configurable` flags, and every own-key walk skips a non-enumerable
   key); `Object.create`, `Object.defineProperty`, `Object.getOwnPropertyDescriptor`,
   `Object.getOwnPropertyNames` and `Object.getPrototypeOf` in `js` mode, as callees and as
   values (`var __create = Object.create`); `Object.prototype` and
   `Object.prototype.hasOwnProperty` as values. The runtime half is one new file,
   `runtime/src/jsrt_reflect.c`; `ts` mode keeps its verdicts (prototype machinery, plan-notes
   125). Decision tests in both modes, goldens `js/object_reflection` and T12.3's
   `pkg_cjs_exports`/`pkg_cjs_replace`.
   8b. Destructuring (31) — not claimed; stays with the card's owner.
9. **Class expressions (~10)** and the remaining singletons, split in two:
   9a. **`Function.prototype.call`/`apply`/`bind` — in progress, Claude Code / sonnet-5-5.**
   Execution plan: `jsrt_get_prop` answers `call`/`apply`/`bind` on any closure through the
   `jsrt_bound_method` mechanism the primitives use; `bind` builds the two-slot env docs/VALUE.md
   §4.16 prescribes; the gate admits the three members on a function-typed receiver in `js` mode
   and lowers them as the dynamic method call. Golden `js/function_call_apply_bind`.
   9b. Class expressions, `encodeURI`, `Error.captureStackTrace`, a spread into
   `String.fromCharCode`, and a `[Symbol.iterator]` method in an object literal (an internal
   `STA4068` in both modes today, plan-notes 310 step 5) — not claimed.
10. ~~**A `RegExp` method called straight off a union narrowing** (`unknown` or a union narrowed by `instanceof RegExp`, then `.test()` / `.toString()`) panics at run time with `STA2006` "calling a non-function"; binding it to a `RegExp`-typed local first works (plan-notes 314). Primitive and built-in method dispatch, `jsrt_get_prop` included.~~ Fixed by step 4b (v4.35): `jsrt_get_prop` answers a RegExp's methods and data properties on an Unknown receiver.
11. **A `Date` method called off a union narrowing** (plan-notes 317). On `t: number | Date`
   narrowed by `typeof`, `instanceof Date` or `valueOf`, `t.getTime()` compiles but panics at run
   time with `STA2006` "calling a non-function", and `Number(t)` gives `NaN`; passing the value to a
   `Date`-typed parameter works. It is step 4b's RegExp gap for `Date`: `jsrt_get_prop` must answer
   a Date's methods on an Unknown receiver, and ToNumber of a Date must be its time value. Lands
   with a golden. Queued after step 6.

**Check:** `stator explain _tsc.js --mode=js --json` lists no `STA1214` in `diagnostics` and ends
with a verdict, not `STA0013`/`STA4072` (PR #44 names the checker's stack overflow `STA0013`).
Baseline 2026-10-02 on 68c8d57 at `--stack-size=7600` (110 s): 1 560 diagnostics — 1 514
`STA1214`, 45 `STA0012`, 1 `STA1210` (plan-notes 310; the first baseline, 1 589, is plan-notes
291). Every landed construct has decision tests in both modes + a golden (Testing rules).
Also, moved here from T11.5a (plan-notes 302): once the Test262 harness (`assert.js`, `sta.js`)
compiles, the `test262` `language/module-code` pass count rises above T11.5a's baseline of 152
passed (426 skipped, 21 failed; measured with T11.5a's runner fix, which compiles a module test
beside its fixtures). `String` and `JSON` as values are not enough on their own (plan-notes 310):
the harness also needs method calls on inferred shapes, assignment to a function's properties
(`assert.sameValue = function …`, `Test262Error.prototype.toString = …`), `new` on a function
constructor and `instanceof` against one, and `.call` on a builtin method
(`Object.prototype.toString.call(v)`, `Array.prototype.map.call(xs, String)`; step 9), so this
clause is met by families 1–4 and step 9 together. After family 4 those two `.call` sites are the
harness's only refusals (plan-notes 310).
