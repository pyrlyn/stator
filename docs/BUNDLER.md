# BUNDLER.md — the bundler contract for `js` mode (Phase 12)

> **Status: T12.1 and T12.2 implemented (plan-notes 320, 321); T12.3 open.** This is T12.0's
> docs-first output (§15.6). It fixes what T12.1 (`packages/compiler`: `statorc/api`) and T12.2
> (`packages/vite-stator`) build, and it records the measured spike the decisions rest on. Where
> T12.1 had to decide something this document left open, the section says so and names
> plan-notes 320. The choice is plan-notes 296; the
> creator settled §9's three questions on 2026-10-02. On any disagreement with `plan.md` §11d,
> the plan wins.

Checked 2026-10-02. Facts carry a primary source (URL + version or date checked) or a spike
number. Lines marked *synthesis* are this document's reasoning, not a source's or a measurement.

## 0. The decision in one paragraph

In `js` mode the bundler bundles the **dependencies, not the project**. Stator keeps compiling
the project's own `.ts` and `.js` files as its own module graph, exactly as today. Two kinds
of input go to the bundler instead:

- every import of a **package**, meaning a bare specifier that is not `node:*`, a Node
  built-in or `std/*`;
- every **CommonJS** project file, with its `require` closure. "CommonJS" uses Node's own
  rule (§4).

They are collected into one generated *vendor entry*. The adapter bundles that entry into
**one ESM file** with a source map: `node_modules` resolved, CommonJS converted, tree-shaken. Stator adds the file to
the graph as one more `js`-mode module. A project that imports no package never calls the
bundler, so it builds without Vite installed. This is option B of question 1, narrowed by the
spike from "bundle all JS" to "bundle packages". The reasons are §1's numbers.

## The spike

`docs/research/bundler/spike.ts` (strict TS, not part of `ci`) reproduces every number below:

```bash
mkdir /some/dir && cd /some/dir && pnpm add vite@8.3.1      # outside the workspace
node docs/research/bundler/spike.ts --vite /some/dir --runs 11 > report.json
```

For each case it builds and runs the original graph (`none`), and it builds three bundles:

- **A**, the whole graph, with §2's contract.
- **A′**, the whole graph, with Vite's own output defaults.
- **B**, the vendor bundle only, which is the decision.

Each binary's stdout is compared byte-for-byte with `node <original entry>`. Setup: Vite 8.3.1
on Rolldown 1.2.12, Node 26.7.0, clang 21.1.8, Apple M3 Max, macOS 27.0. Run times are the
median of 11 runs, and they move about ±10% between runs on this machine.

| Case | Origin | `none` (today) | A: whole graph bundled | B: packages bundled |
| --- | --- | --- | --- | --- |
| `modules` | golden `js/modules` (3 files) | dynamic · 74 408 B · = Node | dynamic · 74 088 B · = Node | no packages → nothing bundled, = `none` |
| `mixed_graph` | golden `js/mixed_graph` (.ts + .js) | dynamic · 74 232 B · = Node | dynamic · 74 088 B · = Node | = `none` |
| `dynamic_import` | golden `js/dynamic_import` | **static** · 75 304 B · = Node | **not-yet** STA1214 ×3 (Rolldown helpers) | = `none` |
| `exitcheck` | golden `ts/exitcheck` (5 typed files) in `js` mode | dynamic, 34/34 functions typed·static · 146 968 B · = Node | **not-yet** STA1214 ×3 (`var X = class {}`) | = `none` |
| `fib` | bench `fib.ts` | **static** · 425.9 ms | **dynamic** · 426.8 ms | = `none` |
| `nbody` | bench `nbody.ts` | static · 21.6 ms | static · 21.6 ms | = `none` |
| `boundary` | generated: `.ts` annotation over a lying `JSON.parse` | **aborts STA2001** (Stator's check) | prints `s` = Node (check gone) | = `none` |
| `typed_app` | generated: typed `.ts` + ESM package | not-yet STA1214 (package import) | dynamic, `fib` dynamic · 94 008 B · = Node | dynamic, **`fib` typed·static** · 94 008 B · = Node |
| `order` | generated: `pkg-a`, `./a.js`, `pkg-b` | not-yet STA1214 | static · = Node | static · **≠ Node** (`pkg-a pkg-b a main`) |
| `treeshake` | generated: 1 of 40 functions used | dynamic · 93 976 B | dynamic · 93 976 B | = `none` |
| `cjs` | generated: `exports.x`, `module.exports =`, nested `require` | not-yet STA1214 | not-yet STA1214 ×9 (interop helpers) | not-yet STA1214 ×10 |
| `diag` | generated: `new Proxy` in a dependency | not-yet STA1214 at `dep.js:4:10` | same, mapped back from `bundle.js:3:9` | = `none` |

A′ (Vite's default output) gives the same verdicts as A, with binaries 8 bytes larger. Every
bundle that compiled matched Node byte-for-byte. The one mismatch is B's `order` case, a known
cost (§1).

## 1. Typed code in a mixed graph

**Question.** A bundler strips TS types. Bundle everything, or keep project `.ts` typed?

**Measured.** Bundling the whole graph (A) takes the types away from Stator:

- `fib` goes from `static` to `dynamic`.
- `exitcheck` goes from 34 typed·static functions to 3 typed + 6 inferred·static + 24 dynamic.
  That was measured after hand-rewriting Rolldown's `var X = class {}` to `const`, because
  Stator does not lower the `var` form yet. Its output then matches Node, and the binary is
  2 184 B larger.
- The `boundary` case loses its check. Unbundled, Stator aborts with `STA2001` (golden rule 4).
  Bundled, the annotation is gone, and the program prints `s`, as Node does.

`docs/MODES.md` §3 says a `.ts` file in `js` mode gets the full static treatment, and bundling
everything would quietly drop that promise.

**Runtime cost today: none.** `fib` runs 425.9 ms static and 426.8 ms dynamic. The emitted C is
identical except for the `#line` paths. Today's emitter routes even `--mode=ts` code through
`jsrt_value`: `fib.ts --mode=ts --emit=c` calls `jsrt_op_lt` and `jsrt_op_add`. So the loss is
deferred, not avoided. It arrives the day typed values compile unboxed (§1's promise, the §12
ladder). *Synthesis.*

**Why not bundle project `.js` too** (the card's option B as first written)? It gains nothing
the spike could find, and it costs three things:

- **Tree-shaking.** Stator's own DCE already removes unused project code. `treeshake` is
  93 976 B with and without the bundler.
- **Goldens.** Bundling project JS breaks `dynamic_import`: Rolldown's namespace helpers need
  `Object.defineProperty`, `Symbol.toStringTag` and a zero-argument `Promise.resolve()`.
- **Cycles.** A project `.js` that imports a `.ts` would make the bundle and the typed modules
  import each other. *Synthesis, not measured.*

**Decision: B, packages only.** All existing `js` goldens keep their behavior trivially, since
none of them imports a package. Project `.ts` stays typed, and the boundary checks stay.

**Known cost: evaluation order.** All package bodies run where the project first imports
*any* package, so a project module imported between two packages moves. In `order`, Node prints
`pkg-a a pkg-b main` and B prints `pkg-a pkg-b a main`. Linear cases match, as `typed_app`
does. This is the same kind of documented deviation as top-level-await interleaving
(`docs/MODES.md` §5). **Decided (§9): documented only**, here and in `docs/MODES.md` §5 when
T12.1 ships package imports. No card closes it. *Synthesis.*

**Found by the spike, out of this card's scope.** In `boundary_inferred` (`.js` returns
`` `${x}` ``; the `.ts` declares `number`), `tsc --strict` reports `TS2322` on `main.ts`. Stator
`--mode=js` neither reported it nor checked the boundary, and it printed `10`. Under golden
rule 4 this was a soundness bug. Fixed by plan-notes 301: the edge now gets a boundary check, and
that program aborts with `STA2001` (golden `js/boundary_inferred` pins the passing half).

## 2. Output contract

One ESM file, no code splitting, no minification, a source map. Measured configuration for
Vite 8.3.1, re-checked on the 8.3.2 pin (the `vite-stator` adapter's defaults):

| Setting | Value | Why (source) |
| --- | --- | --- |
| build kind | `build.ssr: <vendor entry>`, `ssr.noExternal: true`, `ssr.target: 'node'` | `noExternal: true` bundles every dependency, and with `target: 'node'` built-ins stay external (https://vite.dev/config/ssr-options, v8.3.1). **Library mode is wrong:** the spike's `externals` case in `build.lib` replaced `node:path` with an empty `__vite-browser-external` stub (`module.exports = {}`), with no error |
| `build.rolldownOptions.output.format` | `'es'` | one ESM module |
| `…output.codeSplitting` | `false` | inlines dynamic `import()`. `inlineDynamicImports` is deprecated in favor of it (rolldown 1.2.12 `define-config` typings) |
| `build.minify` | `false` | names stay readable in diagnostics and traces. Vite then runs Rolldown with `minify: 'dce-only'` (vite 8.3.1 `dist/node/chunks/node.js`) |
| `build.sourcemap` | `true` | §6 |
| `…output.topLevelVar` | `false` | Vite's build sets Rolldown's `topLevelVar: true` (vite 8.3.1 `dist/node/chunks/node.js`; Rolldown's own default is `false`). That rewrites top-level `let`/`const` to `var`, and `js` mode lowers `var` with function-scope tracking. Measured: `fib`'s `const n` came out as `var n` |
| `build.rolldownOptions.external` | `[/^std\//]` | §3 |
| `build.target` | `'esnext'` | no down-levelling, so Stator sees the source's own syntax |
| plugins | `esmExternalRequirePlugin` | §4 |

**As implemented (T12.2, `packages/vite-stator`, plan-notes 321).** The adapter is
`src/adapter.ts`: one `vite.build()` per compile, exactly the table above, with these details the
table leaves open:

- The vendor entry has no file. A `pre` plugin serves it under the id
  `<resolveDir>/__stator_vendor_entry__.js`, so a CommonJS project file's relative specifier
  resolves from the project's directory.
- `configFile: false`, `envFile: false`, `publicDir: false`: the project's own
  `vite.config.*` never shapes the vendor build.
- `build.outDir` is `resolveDir` with `write: false`. Nothing is written, and the map's
  `sources` come out relative to `resolveDir`, which is what §5 promises.
- `external` is the compiler's list (§3), passed to `esmExternalRequirePlugin` only.
  Rolldown's own `external` answers before any plugin, so with the list there `require('path')`
  stayed `__require("path")` through `createRequire` (measured). The plugin leaves every match
  external for `import` too.
- `treeshake.moduleSideEffects` is `false` for an external built-in, so the `import "node:module"`
  Rolldown's runtime keeps after the last `__require` is gone is dropped.
- `inputs` are the chunk's absolute module ids, less the virtual entry. A build that answers
  more than one chunk, or no map, is an error, so `STA0015`.

The installed devDependency is Vite **8.3.3** (`packages/vite-stator` and `examples/vite`; peer
`^8.3.2`). The creator approved the bump to 8.3.2 (plan-notes 321 item 2); 8.3.3 landed in #141.
The measurements in this section were taken on 8.3.1; the unit tests and goldens re-ran green on 8.3.2.

**The `stator()` plugin** (`src/plugin.ts`) makes `vite build` produce the binary:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { stator } from 'vite-stator';
export default defineConfig({ plugins: [stator({ entry: 'src/main.js', out: 'dist/hello' })] });
```

It applies to `build` only. It points `build.ssr` at the entry with `write: false`, so Vite's own
pass writes nothing, and keeps `node:*` and `std/*` external. In `closeBundle` it calls
`statorc/api`'s `compile` with this adapter (`js` mode by default; `mode: 'ts'` builds with no
bundler, as §0 requires) and fails the Vite build with Stator's diagnostics when the compile
fails. `examples/vite` is the worked example.

**A namespace import of a package does not compile yet.** The vendor entry's
`export * as p$ns from 'p'` makes Rolldown emit its `__exportAll` helper
(`Object.defineProperty` and `Symbol.toStringTag`: STA1214 and STA1212, measured through the
adapter). That is T12.3's "dynamic-import namespace helpers" item, so the namespace golden moved
to T12.3's Check (plan-notes 321).

**What Rolldown output always contains.** Two things the contract cannot switch off, so
Stator must lower them (T12.3):

- Every top-level class comes out as `var X = class {}`. The rolldown 1.2.12 typings say this
  is "always", independent of `topLevelVar`. Since T12.3, a `var`/`let` formation that nothing in
  its file writes lowers like `const X = class {}` (golden `js/pkg_class`); before, it was
  STA1214 "anonymous class expression" (spike `exitcheck`, and hand-checked).
- Constants are inlined across modules (`inlineConst`, default `smart`). In `modules`, the
  bundle has `doubled + 10`. This is harmless.

## 3. Externals

**Measured.** In the SSR build, `import … from 'node:path'` and from bare `'path'` stay as ESM
imports at the top of the bundle. `std/env` stays external through `external: [/^std\//]`.
Both are what plan-notes 290 asks for: the bundler never sees platform code.

The vendor entry never includes a `node:*`, built-in or `std/*` specifier, so the project's
own imports of them go straight to Stator, as today. Today Stator rejects all three kinds the
same way, as STA1214 "importing a package" (spike `externals`, `std`). They become legal with
T11.5 (`node:*`, built-ins) and T10.x (`std/*`).

## 4. CommonJS

**Primary sources.** Rolldown converts CommonJS without a plugin. It wraps each module in a
lazy `__commonJS` function, converts exports for ESM importers with `__toESM`, and for external
requires on the Node platform generates a `require` from `module.createRequire`
(https://rolldown.rs/in-depth/bundling-cjs, checked 2026-10-02). In Vite 8 `build.commonjsOptions`
is a no-op, and the CJS default-import rule (`.mjs`/`.mts` importer, `"type": "module"`,
`__esModule`) is the same in dev and build (https://vite.dev/guide/migration, checked 2026-10-02).

**Measured** (`cjs`, `cjs_edges`). Each CJS module becomes
`var require_x = __commonJSMin((exports, module) => { … })`. That is the "one function over a
module record" that T11.5 planned to write. The helper sets `mod` before the body runs, so a
re-entrant `require` returns the partial `exports`, which is Node's cycle behavior. *Read from
the helper source; T12.3's golden proves it.*

What the bundle leaves for Stator:

| Leftover | Measured | Who handles it |
| --- | --- | --- |
| `__commonJSMin` itself | `(mod \|\| (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports)`: an internal STA4013, because the checker typed the comma from `mod`'s declaration while its right operand read `mod` narrowed by the assignment | T12.3, landed: a comma types as its right operand (goldens `pkg_cjs_*`, `node_cjs_entry`, `node_pkg_location`, `comma_narrowing`) |
| interop helpers `__toESM`, `__copyProps` | `Object.create`, `Object.defineProperty` (getter descriptors), `getOwnPropertyDescriptor`, `getOwnPropertyNames`, `getPrototypeOf`, `Object.prototype.hasOwnProperty.call`, `Function.prototype.bind`: 9 STA1214 in `cjs` | T12.3 (overlaps T11.4's `Object.*` and method-call families) |
| `require('path')` of a built-in | `__require("path")` through `createRequire(import.meta.url)`. With `esmExternalRequirePlugin({ external: [/^node:/, …builtinModules] })` (re-exported by Vite 8.3.1) it becomes `import * as m from "path"` and `module.exports = m.default` | the plugin in `vite-stator` (T12.2). Built-ins need a default export (T11.6) |
| computed `require('./' + n)` | stays `__require(...)`, and Node itself fails on the bundle with `Cannot find module './five.js'` | T11.5: a `require` over built-ins only. Anything else throws `MODULE_NOT_FOUND` |
| `__filename`, `__dirname` | left free, so **Node itself crashes on the bundle** (`ReferenceError: __filename is not defined in ES module scope`) | **decided (§9):** under `--node` the frontend injects a value relative to the executable (T11.5, plan-notes 316); a read that reaches the gate is `STA1110` (it was T12.1's not-yet `STA1218`, now retired). No path is baked into the binary, so the spike's 6-line transform (which baked the build machine's absolute path) is not adopted. Before T12.1, Stator compiled an unbundled free `__filename` as `dynamic` and the binary threw `ReferenceError` where Node prints the path (measured), so the same diagnostic covers project files |

**CommonJS project files** (`cjs_entry`, the shape of `_tsc.js`) go to the bundler whole. A
file is CommonJS by Node's rule (https://nodejs.org/api/packages.html, docs v26.10.0, checked
2026-10-02):

- `.cjs` always;
- `.js` under `"type": "commonjs"`;
- `.js` with no `"type"` and no ES-module syntax. Syntax detection is unflagged since v22.7.0.

**As implemented (T12.1, plan-notes 320; the creator's decision, plan-notes 315).** The third case
is narrowed: a `.js` with no `"type"` and no ES-module syntax is routed only when it reads a free
`require(…)`, `module.exports` or `exports`. A script that touches none of them means the same
thing as a module or a CommonJS file, and routing it would make every plain script — Test262's
harness, a tmpdir-staged test fixture — need a bundler. "Free" means no binding of the user's: a
parameter or `const` named `exports` is the user's, while TypeScript's own CommonJS model of a
`.js` file (it declares `module` and `exports` by the assignments that use them) is not. ES-module
syntax is an import or export statement, `import.meta`, or a top-level `await`.
`src/frontend/vendor.ts` `isCommonJsFile`. A CommonJS entry becomes one side-effect import of
itself in the vendor entry (`import "./main.cjs";`), and the program's entry is a one-line import
of the vendor module.

**`--node` gates the routing of project files** (decided 2026-10-02, plan-notes 315). Only under
`--node` in `js` mode does a CommonJS project file go to the bundler. Without the flag it stays
in Stator's graph, and the gate answers its free `require`, `module.exports` and `exports` with
`STA1110`: ES modules are the only module system there. A CommonJS file that reads none of them
(a plain `.cjs` script) compiles as written, since it means the same either way. Packages under
`node_modules` are bundled with or without the flag; a package's format is the bundler's
business, not the platform's.

The bundle runs on Node unchanged (= Node). With `esmExternalRequirePlugin`, Stator then
reports four things:

- the two built-in imports, `node:module` and `path`, which wait on T11.5;
- a leftover side-effect `import "node:module"`;
- `export default require_main()`, which Stator reports as STA1214 "a default export with a
  computed value" (T12.3).

The same file unbundled is STA1214 "the global 'require'". The vendor module then holds that
file's code, so it is dynamic like any `.js`. *Measured; the routing itself is T12.1's.*

**Consequence for T11.5.** Stator no longer writes CommonJS lowering. Module records, compile-time
`require` edges, the `"type"` decision and the CJS-cycle exemption from `STA3001` all move to
the bundler. T11.5 shrinks to the `--node` flag, the Node globals, external resolution of
`node:*` and built-ins, and a `createRequire`/`require` over built-ins. `STA1110` narrows as
T11.5 already planned. With `--node` in `js` mode a CommonJS project file goes to the bundler,
and T11.5 owns what `__filename`/`__dirname` mean then, under the rule that no build path is
baked into the binary.
Landed (plan-notes 316): the bundle's `__require` is `node:module`'s `createRequire`, a `require`
over built-ins that throws `MODULE_NOT_FOUND` for anything else, and the frontend rewrites each
free `__filename`/`__dirname` left in the vendor module, and each `import.meta.url`, into a
run-time value relative to the executable, using the source map to find the file the read was
written in (`docs/MODES.md` §6).
Without `--node`, or in `ts` mode, a free `require`, `module.exports`, `exports`, `__filename` or
`__dirname` is `STA1110`. Under `--node` one that reaches the gate is in an ES module (Node has
none of them there) or in a build under `--bundler=none`, where nothing converts CommonJS, and it
is `STA1110` too. Fixtures `subset_commonjs_require_*`, `subset_commonjs_file_*`,
`subset_node_filename_*` and `subset_node_dirname_*`; the `js` + `--node` cell needs an adapter
and is proved in `unit/bundler.test.ts`.

## 5. The API

`statorc/api` (T12.1). The compiler imports no bundler (§0.9). It loads an adapter by module
name only when the graph imports a package or, under `--node`, holds a CommonJS project file.
`CompileRequest.node` and `vendorEntry(entry, mode, node)` carry the flag.

```ts
export type VendorEntry = {
  code: string; // generated ESM: `export { pad } from 'leftpad-esm';` …
  resolveDir: string; // where package resolution starts (the entry's directory), platform form
};
export type BundleOptions = {
  external: readonly (string | RegExp)[]; // node:*, built-ins, std/* (§3)
};
export type BundleResult = {
  code: string; // one ESM module (§2)
  map: SourceMapV3; // always present (§6)
  inputs: readonly string[]; // absolute paths of every file read (§7)
};
export type BundlerAdapter = {
  name: string;
  bundle(entry: VendorEntry, options: BundleOptions): Promise<BundleResult>;
};
export function compile(request: CompileRequest): Promise<CompileResult>; // vendor bundle optional
```

**Paths.** A file name has two spellings, and the seam says which one it uses where (T6.30,
plan-notes 352):

- **Out of the compiler, the platform's form**: absolute, with the separator `path.join` gives
  (`\` on Windows). That is `VendorEntry.resolveDir` and the `file` of every diagnostic, in
  `CompileResult.diagnostics`, in `stderr` and in `stator explain` (text and `--json`), mapped
  vendor diagnostics included (§6). A Windows user reads `C:\app\main.js:2:1`, and a caller
  compares with `join(root, 'main.js')`. On Linux and macOS both forms are the same string.
- **Inside the compiler and in what it generates, the checker's form**: absolute, forward
  slashes, on every platform, because TypeScript names every `SourceFile` that way. That is
  `VendorPlan.modulePath`, the keys of `VendorPlan.rewrites` (the overlay the program is
  re-created with), and the file names in the C: `#line` and the locations the binary prints at
  run time. clang and debuggers accept forward slashes on Windows.
- **Specifiers the compiler writes** (the vendor entry's `from` for a CommonJS project file, the
  rewritten imports, the `--node` location helper's import) are relative with forward slashes.
  When no relative path exists (a file on another Windows drive) they are the absolute target
  with forward slashes, and the location helper's import also drops `.ts`, since the checker
  flags a non-relative `.ts` import as one emit cannot rewrite (TS2877). The gate accepts that
  one absolute spelling, which names the compiler's own file.
- **In**, either form: `entry` and a map's `sources` are resolved before use, and
  `BundleResult.inputs` may list absolute paths in either spelling.

**The vendor entry** comes from the project's import declarations. The spike's `depsOnly`
generates it in about 60 lines:

- a named import becomes `export { a } from 'p'`;
- a default import becomes `export { default as p$default } from 'p'`;
- a namespace import becomes `export * as p$ns from 'p'`;
- a bare `import 'p'` stays `import 'p'`.

A name is mangled only when two packages export it, because Rolldown then emits
`export { a as b }`, which Stator does not lower yet (STA1214 "renaming an export", measured).
T12.1 lowers that form. Only the named imports enter the vendor entry, so a package's unused
exports never reach Stator.

**As implemented (T12.1, `src/frontend/vendor.ts`).** A mangled name is `<stem>$<tail>`: the
stem is the source spelled as an identifier (`@scope/util` → `_scope_util`), the tail `default`,
`ns`, or the export name; a clash takes `$2`, `$3`. A named export that is not an identifier
(`'a-b'`) is mangled too. A CommonJS project file is a source like a package, spelled relative to
`resolveDir`. Each project declaration is rewritten in place to name the vendor module, every
line kept (`import { pad } from "./__stator_vendor__.js";`); a mixed clause keeps its type-only
names on an `import type` of the original specifier. Named re-exports and `export * as ns from
'p'` are rewritten the same way. Import attributes (`with { type: 'json' }`) travel to the
entry line, which is the bundler's to read; the rewritten import of the vendor module drops them,
because that module is JavaScript (T12.3). The deprecated `assert` form is not rewritten.

**`export * from 'p'` (T12.3).** Only the bundle knows `p`'s names, so the entry spells
`export * from "p";` and the rewrite waits for the bundle: it parses the bundle's own `export`
declarations and re-exports every plain name. With a star in the entry every named request is
mangled, so the plain names are exactly the star's. The file's own exports, and names another
`export *` of the same file also offers, are left out (an own export shadows a star; two stars
make a name ambiguous, ECMA-262 §16.2.1.6.3). Two different packages under `export *` cannot be
told apart in one bundle, so those declarations stay as written and STA1214, as does a bundle
whose exports include an `export * from` an external. `import('p')` is STA1214 too: its namespace
is Rolldown's `__exportAll` (§8).

**Loading the adapter.** `vite` loads the `vite-stator` package; any other value is a module: a
path (starting with `.` or absolute; relative to the current directory, or to the config file
for the config key) or a package name, resolved from the entry's directory first and then from
the compiler's own. The adapter is the module's default export, or a named `adapter`. Everything
it answers is checked before use (golden rule 4): `code` a string, `map` a version-3 map, `inputs`
a string array, else STA0015.

**The library entry.** `statorc/api` (`packages/compiler/package.json` `exports`) has
`compile({ entry, mode, bundle?, bundler?, out? })`, which answers `{ ok, diagnostics, stderr,
error?, c? }` and never throws for a user error, and `vendorEntry(entry, mode)`, which answers
what the bundler would be asked to bundle, or `undefined`.

**CLI.** `--bundler=vite|none|<module>` on `build` and `explain`:

- The default in `js` mode is `vite`, which loads `vite-stator`.
- `none` is today's behavior: a package import is STA1214.
- In `ts` mode `--bundler` is `STA0004` ("`--bundler` requires `--mode=js`").

**Diagnostics allocated** (`docs/DIAGNOSTICS.md`, planned, emitted from T12.1):

- `STA0014`: the adapter's module cannot be loaded. The message names the package and how to
  install it (`pnpm add -D vite-stator vite`).
- `STA0015`: the adapter's bundle step failed, with the bundler's message passed through, the
  same model as `STA0012`.

**Parse errors come first** (plan.md §9 Task 6.29). The bundle step runs only on a graph that
parses. When a project file has a parse-phase error, the build reports that error and stops
before any adapter loads. Parse-phase errors are the parser's, the binder's (such as
`import { x, y as x } from 'pkg'`) and `STA3005`. The package imports the graph leaves
unresolved are not reported next to it. Without this, an unbuildable bare specifier would turn a
SyntaxError into `STA0015`.

## 6. Diagnostics through the source map

**Measured.** Node's built-in `module.SourceMap` maps a bundle position back:
`findOrigin(line, column)` is 1-indexed both ways (https://nodejs.org/api/module.html, docs
v26.10.0, checked 2026-10-02; run on 26.7.0). In `diag`, `STA1214` at `bundle.js:3:9` maps to
`dep.js:4:10`, the `new` of `new Proxy` in the original file.

**Decision.** T12.1 uses `node:module`'s `SourceMap`. It has zero dependencies, so the §0.9
budget holds. Its stability index is **1.1, active development** (same page), so T12.1
wraps it behind one function in `src/support/`.

**Rules for T12.1:**

- `sources` are relative to the map file (`../src/dep.js` measured). Resolve them against the
  map's location and `sourceRoot`. The adapter hands back a map with no file of its own, so
  T12.1 resolves `sources` against the vendor entry's `resolveDir`, then `sourceRoot`
  (plan-notes 320); an absolute source or a `file:` URL stands as is, and a source with a
  `\0` prefix or another URL scheme counts as unmapped.
- A position with no mapping must say so. All 9 `cjs` diagnostics sit in Rolldown's
  `\0rolldown/runtime.js` region and map to nothing (measured). Report them as
  `<package bundle>:line:col (bundler runtime helper, no source mapping)`, never as a
  position in a user file. Such a diagnostic is a Stator gap, not a user error.
- The emitter's `#line` and the runtime's call-site strings (`jsrt_call_at(…, "file:line")`)
  for vendor statements use the mapped file and line.
- Under B only the vendor module needs mapping. Project diagnostics point at real files, as
  today.

**Checker errors in package code (plan-notes 320 Q4, decided 2026-10-02).** The vendor module
is package code: untyped JavaScript on the dynamic path, which the user cannot edit. A
type-checker complaint there (TypeScript code 2000 and up) is not reported, so it never fails the
build. The binding the complaint names stops trusting its inferred type and goes dynamic, the way
`js` mode already widens an incompatible assignment, so the program does at run time what Node
does (`[1] < {}` prints `true`, `o++` on an object makes it `NaN`). Three things are still
reported:

- syntax and grammar errors (codes below 2000), which are early errors Node raises too;
- a checker error where Node throws at run time and the compiled program would not: a binding
  read in its temporal dead zone (TS2448, TS2449, TS2450) and an assignment to a `const`
  (TS2588). They stay `STA0012` at the mapped position (`VENDOR_THROW_CODES`);
- every Stator verdict: the gate, the module edges and the lowering (`STA1214`, `STA1110`, …).

The same complaint in a project file is still `STA0012`.

## 7. Caching

**Measured cost.** Importing Vite takes 68–256 ms, cold to warm process. One vendor or graph
bundle takes 6–30 ms. A Stator build takes 660–1 450 ms, almost all of it the frontend and
clang. The bundle step is about 1–3% of a build.

**Bundler side.** Rolldown has no persistent cache. `experimental.incrementalBuild` exists
only for watch mode (rolldown 1.2.12 typings). So T12.1 does not cache the bundle step. It
reruns, cheaply, and only for graphs with package imports.

**Program cache (Task 6.9, T20).** The in-process key is (absolute entry, mode, platform,
sha256 of the entry bytes, sha256 of every other on-disk source file the program loaded, and
the overlay key), two slots deep, and skipped for custom hosts. Default library files are not
part of the dependency hash. Overlay files are not read back from disk; their bytes are the
overlay key, which is the sha256 of the vendor bundle's `code` together with the rewritten
project files (T12.1). A changed local import or a changed bundle misses even when the entry
did not. `compile` over an in-memory bundle keys on content, not on a path. A later watch mode
keeps this key; it does not grow a second invalidation scheme for file edits.

**moon.** A task that builds a binary declares as `inputs`:

- the project sources;
- `package.json` and the lockfile, which cover every package version;
- the Vite config, if any.

moon's input hash then skips the bundle step and the build together. The adapter's `inputs`
list is what `vite-stator` hands Vite's watcher in dev, not moon.

## 8. What each card gets from this

- **T12.1** (`packages/compiler`):
  - package-import collection, CommonJS-file routing, and the vendor entry;
  - `statorc/api` and the adapter interface (§5);
  - `--bundler`, `STA0014`, `STA0015`;
  - the vendor bundle as one virtual `js` module, and `export { a as b }` lowering;
  - source-map mapping of diagnostics, `#line` and call-site strings (§6);
  - the cache key (§7);
  - the `not-yet` diagnostic for `__filename`/`__dirname` without `--node` (§4, §9);
  - docs: `MODES.md` (packages and the order deviation), `HOW-IT-WORKS.md`, `pipeline.d2`.
- **T12.2** (`packages/vite-stator`, implemented, plan-notes 321): §2's configuration,
  `esmExternalRequirePlugin`, and the `stator()` Vite plugin.
- **T12.3** (in progress): make Rolldown's output compile. Landed in its first slice:
  `__commonJSMin`, whose comma expression was an internal STA4013 (the comma now types as its
  right operand), so `exports.x` packages imported by name, nested `require`, CJS cycles and a
  `.cjs` entry compile; `var`/`let X = class {}`; `export * from` one package; attributed package
  imports. Open:
  - the interop helpers (§4 table): `__toESM`/`__copyProps`, reached by a default import of a
    CommonJS package or `module.exports` replacement, need T11.4 step 8's `Object.*`;
  - the dynamic-import namespace helpers (`__esmMin`, `__exportAll`: `Object.defineProperty`,
    `Symbol.toStringTag`, zero-argument `Promise.resolve()`), measured in `dynamic_import`'s A
    bundle and in every namespace import of a package (T12.2, plan-notes 321). The runtime has no
    symbol values, so `Symbol.toStringTag` is Phase 5's STA1212, not only T11.4's `Object.*`
    (plan-notes 323);
  - ~~`import.meta.url` (STA1214 "MetaProperty" in `cjs_edges`)~~: landed under `--node` by T11.5
    (plan-notes 316); without the flag it stays STA1214;
  - ~~a computed `export default` (`cjs_entry`)~~: lowers since T11.5a
    (`subset_export_default_expression_*`).
- **T11.5**: re-scoped per §4, plus the meaning of `__filename`/`__dirname` under `--node`.

## 9. Decided by the creator (2026-10-02)

These were open questions in the first draft. The creator answered them on 2026-10-02
(plan-notes 296).

1. **"One file" means the dependencies.** plan-notes 290 says the module graph is bundled
   into one file. **Decided: the dependencies only. Decision B stands.** Only the packages and
   CommonJS project files are bundled into one file, and the project stays in Stator's graph.
   That keeps types, boundary checks and goldens (§1's numbers).
2. **`__filename`/`__dirname` in a native binary.** CJS packages read them, and a binary has no
   source files at run time. The options were:
   - bake the build machine's absolute path;
   - make them relative to the executable;
   - make them `not-yet`.

   **Decided: a `not-yet` diagnostic until `--node` (T11.5).** No path is baked into the
   binary. T12.1 raises the diagnostic, and T11.5 defines the values under `--node`.
3. **The evaluation-order deviation** (§1, `order`). **Decided: documented only**, in this
   file and in `docs/MODES.md` §5 next to top-level-await interleaving. No card makes package
   bodies run in exact Node order.

## Sources

- Vite SSR options, v8.3.1: https://vite.dev/config/ssr-options (checked 2026-10-02)
- Vite 8 migration guide: https://vite.dev/guide/migration (checked 2026-10-02)
- Rolldown, bundling CommonJS: https://rolldown.rs/in-depth/bundling-cjs (checked 2026-10-02)
- npm `rolldown@1.2.12`: `dist/shared/define-config-*.d.mts` (`topLevelVar`, `codeSplitting`,
  `inlineConst`, `experimental.incrementalBuild`); `dist/plugins-index.d.mts`
  (`esmExternalRequirePlugin`)
- npm `vite@8.3.1`: `dist/node/chunks/node.js` (build output defaults: `topLevelVar: true`,
  `minify: false` → `'dce-only'`); `dist/node/index.d.ts` (re-exports `esmExternalRequirePlugin`)
- Node.js Module API, `module.SourceMap`, docs v26.10.0: https://nodejs.org/api/module.html
  (checked 2026-10-02)
