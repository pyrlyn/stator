# MODES.md — Stator operational specification

This document operationalizes plan.md §1 "Product spec — the two modes." On conflict, plan.md wins; contradictions are reported in plan-notes.md.

## 1. Purpose and authority

Stator compiles TypeScript/JavaScript to native binaries in one of two modes that differ radically in what code they accept and how they type untyped or dynamically-valued code. Mode is a **policy layer**: the frontend gate (file acceptance + diagnostic table + typing of unresolved code). Nothing below the frontend—passes, lowering, codegen, runtime—knows the mode exists; if a pass or the emitter reads the mode, the design is wrong (plan §0.8).

- **`ts` mode (default):** Static TypeScript compilation. `.ts` files only. `any`, `as any`, `eval`, `new Function`, `Proxy`, prototype mutation, `var`, `arguments` are compile errors. Unresolved types are errors. Types fully trusted inside type boundaries.
- **`js` mode:** JavaScript + TypeScript mixed, never rejected. Untyped code compiles via a dynamic representation. `eval` is "not yet" (Phase 8). Types trusted only at narrow points where dynamic values enter typed code.

## 2. `ts` mode (default)

### Inputs

- **Files:** `.ts` only. A `.js`, `.jsx`, or `.tsx` file anywhere in the module graph (including transitive dependencies) is `STA1002` (error) with message "expected .ts, got [ext]; use `--mode=js` for untyped code."
- **Module format:** ESM only (enforced by `tsconfig.json` `module: NodeNext`).
- **Semantic:** ECMAScript semantics, not Node.js; no global `__dirname`, `require`, `process` (these are runtime-provided via standard library or rejected as undefined). Node's modules are a platform, not a mode: `--node` (§6) resolves `node:*` and bare built-ins to `packages/node` in either mode.

### Typing contract

Stator owns `tsconfig.json` (plan §4 Task 1.0): `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`. User code cannot relax these; they are the foundation of the mode's correctness.

- **Implicit `any`:** Untyped function parameters, unresolved global identifiers, or index accesses without type guards are `STA1003` (error): "implicit `any`; annotate the type or use `--mode=js`."
- **Explicit `any` or `as any`:** `STA1001` (error): "explicit `any` is not allowed in `ts` mode; use `unknown` instead and narrow at type boundaries."
- **Unresolved identifiers:** `STA1003` (error): "unknown identifier; import it or declare its type."
- **Constructor/function calls with unknown return type:** `STA1003` (error): "return type is `any`; check the function's type signature."

### Permanently rejected (by design)

No escape hatches; these are design errors, not missing features.

Each construct gets its **own** code — `docs/DIAGNOSTICS.md` holds the exact message text, and
a test that asserts "this file is rejected for using `Proxy`" must not also pass when the file
is rejected for using `var`.

- `eval`: `STA1101` — dynamic code execution defeats static analysis outright.
- `new Function`: `STA1103` — the constructor form of the same thing.
- `Proxy`, `Reflect`: `STA1106` — every property access becomes an opaque trap call.
- Prototype mutation (`Object.setPrototypeOf`, `__proto__` writes): `STA1107` — shapes are fixed at compile time.
- `delete` on a class field: `STA1108` — class instances are C structs with a fixed layout.
- `var` declarations: `STA1104` — function scoping, hoisting, and `undefined` initialization; use `let`/`const`.
- `arguments` object: `STA1105` — use rest parameters.
- `with`: `STA1109`, CommonJS `require()`: `STA1110`, `.jsx`/`.tsx`: `STA1111` — these apply in **both** modes, not just `ts`. `STA1110` is the one narrowed by a platform: `js` mode under `--node` hands a CommonJS project file to the bundler (§6); without the flag its `require`, `module.exports` and `exports` are `STA1110`.
- Untyped catch bindings: `STA1003` — the implicit-`any` rule; annotate the parameter `unknown` (or `Error`) and narrow.

**Not on this list:** `Symbol` and `BigInt`. They are *deferred*, not rejected — `STA1212` and
`STA1213`, both Phase 5 (`docs/SUBSET.md`). Nothing outside plan §1.1's closed list may be
described as permanently rejected, and `Symbol.iterator` in particular cannot be: `for`…`of`
over a typed iterable is a static, supported construct that depends on the protocol.

### Type soundness at boundaries

Inside checked `ts` code, types are trusted fully. At boundaries where typed and untyped code meet (e.g., imports from ambient declarations, JSON.parse results, FFI calls), types are narrowed by runtime checks:

- **`unknown` and unions:** The type checker forces narrowing via guards (`typeof`, `instanceof`, or type predicates) before code can use the value. Stator verifies the narrowing logic statically; the emitted code includes a runtime check that halts compilation if the narrowed type is violated at runtime (a bug in the caller, not Stator).
- **`JSON.parse`:** Returns type `unknown`; must be narrowed.
- **Ambient module declarations (`.d.ts`):** Types are trusted as declared; if they lie (e.g., a function signature in a `.d.ts` doesn't match the implementation), the runtime check at the call site may fail. Stator generates a safe boundary with a source location so the lie is caught immediately with precise feedback.

## 3. `js` mode

### Inputs

- **Files:** Any mix of `.ts` and `.js` (and `.jsx`, `.tsx` in Phase 2+). ESM only; always strict (ESM enforces strict mode).
- **Module format:** ESM enforced by the pipeline (not configurable).
- **Packages and CommonJS (plan.md §11d T12.1, `docs/BUNDLER.md`):** a package import (a bare specifier that is not `node:*`, a built-in or `std/*`) and, under `--node` only (plan-notes 315), a CommonJS project file go to a bundler first. `--bundler=vite|none|<module>` picks it (default `vite`, the `vite-stator` package; `--bundler` in `ts` mode is `STA0004`), and it loads only when the graph has something to bundle. The bundle joins the program as one virtual ESM module, `__stator_vendor__.js` in the entry's directory, compiled under the same `js`-mode rules as every other `.js` file; each project import declaration of a package is rewritten in place to import from it, keeping every line, so project diagnostics and `#line` still point at the user's lines (only code after a rewritten import on the same line can shift columns). A CommonJS file is `.cjs`, a `.js` under `"type": "commonjs"`, or a `.js` with no `"type"`, no ES-module syntax and a read of `require`, `module.exports` or `exports` (plan-notes 320). Without `--node` a CommonJS project file stays in the graph, and its free `require`, `module.exports` and `exports` are `STA1110`; packages are bundled with or without the flag. Diagnostics inside the bundle are reported at the package's own file and line through the bundle's source map, or as `<package bundle>` with "(bundler runtime helper, no source mapping)". `STA0014` means the adapter cannot be loaded, `STA0015` that the bundle step failed. `--bundler=none` keeps a package import `STA1214`.

### Typing rules

- **`.ts` files:** The full static treatment (strict, implicit `any` is an error, `as any` is an error, unresolved types are errors). `.ts` is an **assertion** that the code is statically typeable.
- **`.js` files:** Treated as `allowJs: true` + `checkJs: true` (TypeScript's JavaScript inference mode).
  - Function parameters without JSDoc `@param` annotations are untyped; they lower to `Unknown` (the dynamic representation).
  - Return types without JSDoc `@returns` are inferred from return statements; if inference fails, the return type is `Unknown`.
  - JSDoc annotations are trusted and checked at runtime (see "Mixed-graph boundaries" below).
  - Untyped object literals `{ a: 1, b: "x" }` are inferred as `{ a: number, b: string }`; if inference is impossible (e.g., `{ [someVariable]: value }`), the object lowers to a dynamic shape table.
  - Array literals without type hints are inferred element-wise; heterogeneous arrays (e.g., `[1, "x", true]`) are allowed and lower to `Unknown[]`.
  - Untyped variables are inferred from initial assignment; if no assignment, the type is `Unknown`.

- **`any` in `.js` files:** Allowed. The type `any` is a no-op in `js` mode; it downgrades to the dynamic representation (same as `Unknown`). No error.
- **Unresolved identifiers in `.js` files:** Not an error; the identifier is assumed to be a runtime global or dynamic property and lowers to `Unknown`.

### Which checker diagnostics are fatal

`checkJs` runs the full checker over `.js` files, and its diagnostics surface as `STA0012`. In
`js` mode they split three ways (plan-notes 297):

- **Always fatal:** every syntactic diagnostic, and every JavaScript **early error** — the
  binder and grammar groups of TypeScript's own `plainJSErrors` list, the codes `tsc` reports
  for a `.js` file even without `checkJs` (`let x; let x;`, `with`, `break` outside a loop, …).
  A program carrying one is not JavaScript; Node refuses it before running a line. No code may
  name one of these in the js-mode list below, and `tests/unit/js-early-errors.test.ts` reads
  the list out of the pinned `typescript` to hold that.
- **Degraded to the dynamic path:** a type-level refusal of JavaScript Node runs, listed in
  `JS_MODE_RUNTIME_CODES` (`src/frontend/program.ts`) together with its run-time answer — a
  widened binding, a dynamic read, a runtime throw. Examples: a possibly-`undefined` read
  (TS2532), `"" == 0` (TS2367), a namespace IIFE reassigning a function declaration's binding
  (TS2630; a named function expression's own name is immutable and stays fatal), a spread the
  checker narrowed to `never` (TS2698), `new F()` on a function that returns a value and a read of
  `F.prototype` before the program replaces it (TS2350, TS2565; docs/VALUE.md §4.20), a spread
  into fixed parameters, which calls with the list's own count (TS2556; docs/VALUE.md §4.23), and two
  `export *` re-exports binding one name differently
  (TS2308: ES drops the name from the namespace, and importing it by name is `STA3003`, plan.md
  §11c T11.5a; `ts` mode keeps TS2308 fatal).
- **Fatal until listed:** every other type-level refusal. The lowering trusts JSDoc types and
  the checker's control flow, so dropping a refusal it has no answer for compiles to an internal
  error at best and to a silent miscompile at worst (`const c = 1; c = 2` printed `2` where Node
  throws a `TypeError`). A code moves to the degraded list with its answer and a test.
- **The bundler's vendor module is the exception** (plan-notes 320 Q4, `docs/BUNDLER.md` §6):
  package code is not the user's to fix, so there a type-level refusal is never fatal. The
  binding it names is widened to dynamic instead, and the four codes where Node throws and the
  compiled program would not (TDZ reads TS2448/2449/2450, `const` assignment TS2588) stay fatal.
  A construct the lowering still has no answer for surfaces as an internal error (`STA4xxx`) at
  the package file's position: a compiler bug to report, never a user error.

### JS-only constructs that compile

- **`var` declarations:** Function scoping, hoisting, and `undefined` initialization are honored by lowering to a dynamic representation with explicit scope tracking. Hoisting is visible (assignment without declaration before use initializes to `undefined`).
- **`==` and `!=` operators:** Full ToPrimitive coercion (ES5 spec) on the dynamic path. When both operands are typed, the typed comparison is used; when either is `Unknown`, a dynamic comparison is emitted.
- **Untyped object literals:** Heterogeneous properties, computed property names, and getters/setters compile via dynamic shape tables and inline caches.
- **Function `arguments` object:** Compiled to an `Unknown[]` that mirrors the actual arguments at runtime.
- **`new.target`:** Accessible as `Unknown`.
- **`this` binding in untyped functions:** `this` is `Unknown` unless a type annotation provides it.

### Not yet (Phase 8)

- `eval`, `new Function`: `STA1206` — both land with the interpreter tier, so they share one code.
- `Proxy`: `STA1203`. Prototype mutation: `STA1204`. `delete` on a class field: `STA1205`.

These are the same five constructs `ts` mode rejects permanently, which is the clearest
illustration of what a mode is: identical code, identical pipeline below the gate, different
policy. In `ts` mode the answer is "no"; in `js` mode it is "not until Phase 8."

### Mixed-mode type narrowing in `.js`

When a value flows from untyped or loosely-typed `.js` into strictly-typed `.ts`, a runtime boundary check enforces the declared type:

```javascript
// util.js (untyped)
export function getValue() {
  return 42 || "fallback";  // inferred as unknown (heterogeneous)
}
```

```typescript
// main.ts (typed)
import { getValue } from "./util.js";

const x: number = getValue();  // type error at narrowing, not import
// Emitted code: runtime_check(x, "number"), halt if mismatch
```

## 4. Mixed-graph boundaries

When a value flows from a `.js` module (untyped or partially typed) into `.ts` code (strictly typed), Stator inserts a runtime type check at the import site or use site. The check is deterministic and pinpointed to the source location of the lie.

### Boundary-check examples

**Example 1: a value the checker cannot see, narrowed in `.ts`**

```javascript
// math.js
/**
 * @param {number} x
 * @returns {number}
 */
export function double(x) {
  return x * 2;
}

/** No annotation, so `settings` is `any` and so is everything read out of it. */
export function factorFrom(settings) {
  return settings.factor;
}
```

```typescript
// main.ts
import { double, factorFrom } from "./math.js";

const factor: number = factorFrom(JSON.parse(raw));  // Type-checks: `any` narrows to `number`
// Emitted: check(factorFrom(...), "number") → STA2001 runtime error:
//   "type error at main.ts:3:24: expected number, got string"
console.log(double(factor));
```

The JSDoc on `double` is not what needs checking, and cannot be: `checkJs` verifies it against the
body and Stator makes that verdict fatal, so `double("5")` is a **compile** error (`STA0012 [js]
Argument of type 'string' is not assignable to parameter of type 'number'`) rather than a runtime
one — measured 2026-09-01, plan-notes 140. What no checker can see is the value `factorFrom`
actually answers, and narrowing it to `number` is where the boundary check goes.

**Example 2: inferred `number` from untyped `.js` is already a number**

```javascript
// config.js
export const MAX_RETRIES = 3;
```

```typescript
// app.ts
import { MAX_RETRIES } from "./config.js";

const retries: number = MAX_RETRIES;  // no check: the checker inferred `number`
// `const retries: string = MAX_RETRIES` is checked: check(MAX_RETRIES, "string") → STA2001
```

When the checker's inferred type and the `.ts` annotation disagree (`TS2322`), `ts` mode refuses
the program (`STA0012`). `js` mode does not: it suppresses `TS2322` because in a `.js` file the
disagreement is ordinary JavaScript (`let x = 1; x = 'a'` widens `x` to a dynamic binding). A
`.ts` variable annotated `number`, `string` or `boolean` is not widened. Its annotation stays,
and every declaration or assignment whose value has another type gets a check. A value that
matches passes. One that does not fails with `STA2001` at the narrowing point (plan-notes 301):

```javascript
// lib.js
export function pick(wantNumber) { return wantNumber ? 1 : "one"; }  // inferred 1 | "one"
export function label(x) { return `${x}`; }                          // inferred string
```

```typescript
// main.ts
import { label, pick } from "./lib.js";

const n: number = pick(true);  // check(pick(true), "number") passes
const s: number = label(10);   // check(label(10), "number") → STA2001
```

An annotation no tag settles (an object type or a union) still widens the binding to the dynamic
path, the way a `.js` binding does.

The call and return edges follow the same rule (plan-notes 308). An argument the checker refuses
for a parameter (`TS2345`), or a returned value it refuses for the function's return type (`TS2322`
on a `return` or an arrow's concise body), is suppressed in `js` mode and checked when a TypeScript
file annotated that parameter or return. Function, method and constructor parameters all count;
async functions and generators do not, since their annotation is a `Promise` or a generator, not
the returned value's type:

```typescript
// main.ts
import { label, pick } from "./lib.js";

function inc(x: number): number { return x + 1; }
function first(): number { return pick(true); }  // check(pick(true), "number") passes
const h = (): number => label(4);                // check(label(4), "number") → STA2001

inc(pick(true));  // check(pick(true), "number") passes
inc(label(1));    // check(label(1), "number") → STA2001, `inc` never runs
```

A callee declared in a `.js` file (or described by a `.d.ts`) keeps Node's coercion: its JSDoc is
not a TypeScript annotation, so `increment("2")` against `/** @param {number} value */` still
prints `21`, as Node does (golden `js/argument_mismatch`).

A check appears only when the imported value is still Unknown:

```javascript
export function retriesFrom(settings) {
  return settings.n;
}
```

```typescript
const retries: number = retriesFrom({});  // check(retriesFrom(...), "number")
```

**Example 3: Heterogeneous array from .js**

```javascript
// data.js
export const items = [1, "two", true];  // Inferred as unknown[]
```

```typescript
// consumer.ts
import { items } from "./data.js";

const nums: number[] = items;
// `number[]` is not a tag the runtime can settle in constant time, so this assignment
// is NOT wrapped (docs/HIR.md §3.2.1). Element reads stay on the dynamic path until a
// checkable narrowing (`as number`, `typeof`) at the use.
```

### Typing contract at boundaries

- A value type-checked at a boundary is checked exactly once (at import or use).
- If the check passes, the value is trusted downstream without further checks.
- A check failure is a **runtime** error (`STA2001`) carrying the source location of the narrowing point — never silent undefined behavior, and never memory corruption. It has to be a runtime error: the whole reason a boundary exists is that the value's real type is unknowable at compile time (plan §0.2). What is guaranteed statically is that the check *is emitted*, and that every place one is needed is visible in the source (an import, an assignment, or an `as` cast Stator audits).

## 5. Mode mechanics

### Mode selection

The `--mode=ts|js` flag (default `ts`) determines the mode. No inference magic: a `.js` file under default `ts` mode is always `STA1002` (error), never a silent mode switch. The entry point's extension does not dictate the mode.

```bash
stator build app.ts -o app                # ts mode (default)
stator build app.ts -o app --mode=js      # js mode; .ts files in .ts mode rules
stator build app.js -o app --mode=js      # js mode; .js files allowed
stator build app.js -o app                # ERROR: STA1002 (.js in ts mode)
```

### Diagnostic format

Every diagnostic carries three parts: **source span**, **stable STA code**, **mode**, and **message**.

**Human format (stdout/stderr):**

```
file.ts:10:5 STA1001 [ts] explicit 'any' is not allowed in ts mode; use 'unknown' instead
```

Structure: `path:line:col STA#### [mode] message`

- `path:line:col` — source location, 1-indexed in both axes (matches `tsc`, `clang`, and editor gutters)
- `STA####` — stable diagnostic code (4 digits), never reused or renumbered
- `[mode]` — the active mode (`[ts]` or `[js]`)
- `message` — human-readable, actionable

**JSON format (`--diagnostics=json`):**

```json
{
  "diagnostics": [
    {
      "file": "file.ts",
      "line": 10,
      "column": 5,
      "code": "STA1001",
      "mode": "ts",
      "message": "explicit 'any' is not allowed in ts mode; use 'unknown' instead",
      "severity": "error"
    }
  ]
}
```

- `severity` — one of `"error"`, `"warning"` (warnings in Phase 2+)
- All codes must be stable; tests reference them

### Module init and top-level await

Stator evaluates the program's modules in Task 3.11's topological order (dependencies first, entry last) as a single unit; each module keeps its own top-level namespace (plan.md §11c T11.5a), so only the order is shared. When the body contains a top-level `await`, that unit is async: `main` starts it and drains the microtask queue until it settles.

Node's ESM loader may **interleave sibling subgraphs** — two modules that do not import each other can both run their prefix, hit `await`, and continue in registration order. Stator does not. A dependency's top-level await runs to completion before the next file in topological order begins. The difference is observable only in sibling interleavings; a linear import chain matches Node. Mirroring Node would need per-file init promises and a scheduler, which the whole-program unit does not have.

**Package evaluation order** (`docs/BUNDLER.md` §1, documented only): every package body runs together, where the project first imports *any* package, because the packages are one vendor module. A project module imported between two packages therefore moves: where Node prints `pkg-a a pkg-b main`, Stator prints `pkg-a pkg-b a main`. A linear import chain matches Node.

Imports are **live bindings**, as in Node, however they are spelled: a named, renamed or default import and every member read through a namespace (`ns.x`, `const { x } = ns`, `ns["x"]`) read the exporter's own binding. The namespace OBJECT is where Stator differs: it is built once, when its first importer starts, so a value that reaches it without a member name (`console.log(ns)`, `Object.keys(ns)`, `ns` passed to a function taking a plain object type) sees each export as it was then, and prints as a plain object rather than Node's `[Module: null prototype]`. docs/VALUE.md §4.14.

## 6. `stator explain` — what the compiler will do with a program

`explain` runs the build's front half — program, gate, module graph, lowering — and stops before
codegen. It reports one **file verdict** for the whole module graph, the diagnostics that decided
it, and, when the program lowers, one row per compiled function. Source:
`packages/compiler/src/cli/explain.ts`. A rejected program still exits 0: the verdict is the answer.

### Usage

```bash
stator explain file.ts                   # human-readable
stator explain file.js --mode=js         # js mode
stator explain file.ts --json            # one JSON object on stdout (never through ink)
```

### Verdicts

| Verdict | Meaning |
| --- | --- |
| `error` | a `never`-class diagnostic (rejected by design), or an `error`/`internal` one |
| `not-yet` | a `STA12xx` diagnostic: outside today's subset, scheduled |
| `dynamic` | compiles; some value anywhere in the graph — signature or body — is Unknown |
| `static` | compiles fully typed |

Precedence when one stage reports several classes: `never` > `not-yet` > `error`/`internal`. The
first stage that reports a deciding diagnostic ends the run, so a later stage's diagnostics are
never in the report — the program stage and the gate decide together, then the module graph, then
lowering.

### JSON schema (`--json`)

| Field | Present | Content |
| --- | --- | --- |
| `verdict` | always | one of the four verdicts |
| `code` | exactly when `verdict` is `error` or `not-yet` | the deciding diagnostic's code — the first of the highest-precedence class |
| `diagnostics` | exactly when `code` is | **every** diagnostic of the deciding stage, in source order (file, line, column): `{ file, line, column, code, mode, message }` (plan-notes 291) |
| `functions` | when the program lowered | `{ name, line, provenance, verdict }` per compiled function, in source order; `provenance` is `typed`, `inferred` or `dynamic`, `verdict` is `static` or `dynamic` |
| `externCalls` | when the program makes an extern call | `{ name, line }` per call — the unchecked boundaries (`docs/FFI.md` §5) |

Optional fields are **omitted**, never `null` or empty, so a report carries only what applies.
Consumers key on `verdict` and `code`, never on `message` (`docs/DIAGNOSTICS.md`).
`packages/tests/subset/run.ts` reads only `verdict` and `code`: a decision fixture isolates one
construct, so the file verdict *is* that construct's verdict.

**Why `diagnostics` lists them all.** One code says a file fails; it does not say how far the file
is from compiling. Sizing a large input — Phase 11's `_tsc.js` (§11c T11.4) — is a tally of codes,
and the human output prints that tally first.

**Per-function rows describe signatures.** A row is `static` when the function's signature is
typed; the file verdict still counts every Unknown in every body, so a `dynamic` file over
all-`static` rows is a body-level dynamic site, not a contradiction.

### Human output

The file line, then — when more than one diagnostic decided — a count per code, most frequent
first, then every diagnostic in the build's rendering (`file:line:col CODE [mode] message`), then
the function rows and the unchecked boundaries.

### Worked example: `ts` mode, rejected

```typescript
function unsafe(data: any) {
  return data.x;
}
const other: any = 1;
console.log(unsafe({ x: 1 }), other);
```

```
unsafe.ts: error (STA1001)
  STA1001 x2
  unsafe.ts:1:17 STA1001 [ts] explicit 'any' is not allowed in ts mode; use 'unknown' instead
  unsafe.ts:4:7 STA1001 [ts] explicit 'any' is not allowed in ts mode; use 'unknown' instead
```

```json
{"verdict":"error","code":"STA1001","diagnostics":[
  {"file":"unsafe.ts","line":1,"column":17,"code":"STA1001","mode":"ts","message":"explicit 'any' is not allowed in ts mode; use 'unknown' instead"},
  {"file":"unsafe.ts","line":4,"column":7,"code":"STA1001","mode":"ts","message":"explicit 'any' is not allowed in ts mode; use 'unknown' instead"}]}
```

(`file` is the absolute path the program loaded; shortened here.)

### Worked example: `ts` mode, compiles

```typescript
function add(a: number, b: number): number {
  return a + b;
}

const parsed: unknown = JSON.parse('2');
const n = typeof parsed === 'number' ? parsed : 0;
console.log(add(1, n));
```

```
example.ts: dynamic
  1: add: static (typed)
```

```json
{"verdict":"dynamic","functions":[{"name":"add","line":1,"provenance":"typed","verdict":"static"}]}
```

`JSON.parse` is a boundary in both modes (plan §1.1), so `parsed` is tagged and the file is
`dynamic`; `add`'s signature is typed, so its row is `static`.

### Worked example: `js` mode

```javascript
/** @param {number} a @param {number} b @returns {number} */
function add(a, b) {
  return a + b;
}

function pluck(record) {
  return record.x;
}

console.log(add(1, 2), pluck({ x: 3 }));
```

```
example.js: dynamic
  2: add: static (typed)
  6: pluck: dynamic (dynamic)
```

```json
{"verdict":"dynamic","functions":[{"name":"add","line":2,"provenance":"typed","verdict":"static"},{"name":"pluck","line":6,"provenance":"dynamic","verdict":"dynamic"}]}
```

Untyped `pluck` is not an error in `js` mode — it compiles through the dynamic representation.

### `--node`: the Node platform (Phase 11)

`--node` (plan §11c T11.5) is a platform flag, orthogonal to `--mode`, and `explain` accepts it
like `build` does; `stator.config.json` spells it `"node": true` (docs/CONFIG.md). Like the mode,
it is a frontend policy: nothing below the gate reads it. It changes four things, and only these.

```bash
stator build app.ts -o app --node            # ts mode on the Node platform
stator explain app.js --mode=js --node --json
```

**Resolution.** A Node built-in is `node:<id>` for any public id of the pinned Node's
`builtinModules`, or the bare `<id>` where Node accepts one (`path`, `fs/promises`; `test` and
`sqlite` only with the prefix, as in Node). Under `--node` both spellings resolve to
`packages/node/src/<id>.ts`, strict TypeScript over `std`, through `paths` entries on the
program's own options, the same mechanism `std/` uses (`packages/compiler/src/frontend/node.ts`).
A landed module is ordinary source from there on. A bare built-in is never a package, with or
without the flag (docs/BUNDLER.md §1).

**Landed modules** (T11.6, one slice at a time; `docs/NODE.md` is the per-member list):
`node:path` and `node:path/posix`, POSIX semantics — Stator builds for POSIX hosts, so `path` is
`path.posix`, as on the pinned Node there. `node:assert` (T11.7), the slice Node's own tests use:
`ok`, `strictEqual`, `notStrictEqual`, `deepStrictEqual`, `match`, `fail`, `throws`, `rejects` and
`AssertionError`; its default export is an object, not yet a callable function. `node:module`
(T11.5): `createRequire`, `isBuiltin` and `builtinModules`. `node:fs` (T11.6), the synchronous
subset `tsc` calls: `closeSync`, `existsSync`, `mkdirSync`, `openSync`, `readFileSync`,
`readdirSync`, `realpathSync`, `rmdirSync`, `statSync`, `unlinkSync`, `utimesSync`,
`writeFileSync` and `writeSync`, failing with Node's system errors (`code`, `errno`, `syscall`,
`path` and the same message). Its gaps: paths are strings only (no `Buffer` or `URL`);
`readFileSync` without an encoding answers a `Uint8Array` until `Buffer` lands; `readdirSync` lists
in byte order; a `Dirent` follows symbolic links; a `Stats` carries `size`, `mtimeMs`, `mtime`,
`isFile`, `isDirectory` and `isSymbolicLink` only; a system error is not an `Error` instance;
`watch`, `watchFile` and `unwatchFile` wait on the event loop (N2). `node:process` (T11.6), the
members `tsc` reads plus their neighbours: `argv`, `argv0`, `execArgv`, `execPath`, `env`, `cwd`,
`exit`, `exitCode`, `platform`, `arch`, `pid`, `ppid`, `memoryUsage`, `nextTick`, `stdout` and
`stderr` (below). Each module's default export is the module object
(`import path from 'node:path'`), which the bundle's `import * as m` plus `m.default` also needs.
`path.win32`, `node:path/win32` and `path.matchesGlob` have not landed.

**Platform gaps are diagnostics.** Under `--node` a built-in `packages/node` has not landed, or a
member its module does not export yet while the pinned Node's module does, is `STA1214` naming
Phase 11 (T11.6). So `explain --node`'s `diagnostics` lists the platform gaps the same way it
lists the language ones, and `docs/NODE.md` is the coverage the two must agree with. A member
Node itself does not have stays the checker's error (`STA0012`). Without `--node`, a built-in is
`STA1214` with no phase, and its message names the flag.

**`require`, `module.exports`, `exports`.** `STA1110` narrows to "without `--node`". In `ts` mode
it stays, flag or not. `--node` is also what routes a CommonJS project file to the bundler whole
(T12.1, docs/BUNDLER.md §4; decided 2026-10-02, plan-notes 315), so under it such a file never
reaches the gate. Without the flag the file stays in the graph and its free `require`,
`module.exports` and `exports` are `STA1110`; a CommonJS file that reads none of them compiles as
written. Packages are bundled either way. With `--node` in `js` mode the bundle's `require` is
`createRequire(import.meta.url)` (Rolldown's `__require`), a `require` over built-ins only:
`node:module` (T11.5) answers every built-in `packages/node` has landed, throws
`ERR_UNKNOWN_BUILTIN_MODULE` naming T11.6 for one it has not, and throws Node's
`MODULE_NOT_FOUND` for anything else, because the project's files and packages were bundled at
build time and nothing is left to load. An ES module gets the same `require` from
`createRequire(import.meta.url)`. A free `require`, `module.exports` or `exports` that still
reaches the gate under `--node` (beside ES-module syntax, or under `--bundler=none`) is `STA1110`,
as in Node, where an ES module has none of them. `require` is a plain function: `require.resolve`,
`require.cache` and `require.main` are absent (a function with properties is not-yet).

**`__filename`, `__dirname` and `import.meta`** (decided 2026-10-02, plan-notes 312; landed in
plan-notes 316; docs/BUNDLER.md §9). `__filename` and `__dirname` exist where Node defines them:
in a CommonJS file, which under `--node` reaches the build through the bundler, so in the vendor
module. An ES module has neither, exactly as in Node (`ReferenceError: __dirname is not defined in
ES module scope`), so a free read that reaches the gate is `STA1110`, under the flag or not.
`import.meta.url`, `import.meta.filename` and `import.meta.dirname` exist in every module under
`--node`; without the flag `import.meta` is `STA1214`. The values are **relative to the
executable, resolved at run time**:

- `__dirname` is the directory of the running binary (the path `process.execPath` answers),
  joined with the module's directory relative to the entry file's directory. For a module beside
  the entry it is the binary's directory itself.
- `__filename` is `__dirname` joined with the module's file name.
- Inside the vendor module a read takes the location of the file it was written in, which the
  bundle's source map names (`node_modules/edge/index.js` reads `<bin dir>/node_modules/edge`). A
  read with no mapping, in a bundler helper, takes the vendor module's own: it sits at the entry's
  level, so its `__dirname` is the binary's directory.
- `import.meta.filename` is `__filename`, `import.meta.dirname` is `__dirname`, and
  `import.meta.url` is the `file:` URL of `__filename` (`url.pathToFileURL`'s encoding).

No build-machine path is ever baked into the binary. The frontend rewrites every read into a call
to `packages/node/src/internal/location.ts` that carries the file's path relative to the entry
(`frontend/location.ts`); the call joins it to the binary's directory when the program runs. The
rule keeps the common idiom working: `join(__dirname, "data.json")` finds assets laid out beside
the binary the way they sat beside the source.

**The global `process`** (T11.6, plan-notes 390). Under `--node` a free `process` is the
`node:process` module's default export: the frontend gives every project file, and the vendor
module, that reads one an `import process from "node:process"` (`frontend/location.ts`), resolved
like any other built-in, and `packages/node/src/globals.d.ts` declares its type. A file that binds
its own `process` keeps it. Without the flag `process` is undeclared (`STA0012`); `std/process`
is the non-Node spelling. What the binary answers:

- **`argv` has the shape of Node's single-executable applications**: `argv[0]` is the absolute
  path of the executable (`execPath`), `argv[1]` is the program as it was invoked, and the user's
  arguments start at index 2. Node's single-executable doc
  (https://raw.githubusercontent.com/nodejs/node/v26.7.0/doc/api/single-executable-applications.md,
  checked 2026-10-19, section "Execution arguments") shows a binary launched as
  `sea user-arg1 user-arg2` printing `['/path/to/sea', 'path/to/sea', 'user-arg1', 'user-arg2']`,
  and states that "The user-provided arguments are in the `process.argv` array starting from
  index 2". So `process.argv.slice(2)` reads the same arguments under Node and in the binary.
  `argv0` is `argv[1]`. `execArgv` is empty, because a binary takes no runtime flags of its own.
  A golden fixture's `// @args:` line is the argument list both runs receive.
- **`env` is a plain object**, filled from the environment at startup (`std/env.names()`). Writes
  and `delete` are seen by every later read in the program. They do not reach the OS environment
  or child processes, because an object that forwards writes needs a `Proxy`, which the subset
  does not have.
- **`exit(code)`** ends the process with `code` (the low 8 bits). The method takes the code:
  calling it with no argument is the same shape, at the call, as a method call with no receiver
  (docs/VALUE.md §4.16), so the no-argument form is the function export `exit()`, which uses
  `exitCode` when the code is omitted, else 0. **`exitCode`** is `undefined` until the program
  sets it; the status a normal end uses is set when the program assigns it.
- **`memoryUsage()`** reports a real `rss`. `heapTotal`, `heapUsed`, `external` and
  `arrayBuffers` are 0.
- **`nextTick(fn, ...args)`** runs `fn` as a promise job once the current job ends. Node runs
  every tick before any promise job; here a tick takes its place in the queue. In `ts` mode a
  callback with typed parameters is passed as a closure that calls it.
- **`stdout` and `stderr`** have `write(string | Uint8Array)`, which writes now and answers
  `true`, plus `fd`, `isTTY`, `columns` and `rows`. `isTTY` is `true` on a terminal and
  `undefined` otherwise, as on Node. An encoding argument and a callback are not landed (an
  omitted optional method parameter collides with the receiver, docs/VALUE.md §4.16). There are
  no stream events: `node:events` and `node:stream` are N2, and so are `on`, `once` and `emit`
  on `process`. A string containing a NUL is written as bytes.
- **`browser` and `recordreplay`** are not properties. `tsc` reads both. In `js` mode a missing
  property of the process object reads as `undefined`, which is what those checks test.

## 7. One pipeline, one gate

The pipeline is uniform:

1. **Frontend gate** (mode-aware): parse + typecheck (via `typescript` API) → mode policy (file acceptance, diagnostic table, unresolved type handling)
2. **Typed HIR** (mode-agnostic): lowering (`ts.Type` → `HType`), verifier
3. **Passes** (mode-agnostic): monomorphize, boundary-insert, const-fold, DCE, inline
4. **Codegen** (mode-agnostic): C emitter + runtime library → machine code

**Mode touches only:**

- **File acceptance:** `.ts` only (mode `ts`), or any mix `.ts` + `.js` (mode `js`)
- **Diagnostic table:** Different error codes and constraints per mode (table in §5)
- **Unresolved type handling:** Error in `ts` mode; lower to `Unknown` in `js` mode

**Below the gate (lowering, passes, codegen, runtime):** No reference to the mode. If any pass reads `mode` or branches on it, the design is wrong. Mode is baked into the typed HIR or lowered to `Unknown` by the frontend gate.
