# done.md — the completion record

Finished work, moved out of `plan.md` so that file stays a roadmap of what is LEFT. This is an
archive, not an authority: nothing here is normative. When a completed task left behind a rule the
compiler still has to obey — the locked `tsconfig.json`, a live Check — that rule stayed in
`plan.md` and only its evidence came here.

Task numbers are unchanged, and `plan.md` keeps a one-line stub for every task below, so a
`plan.md §N Task X.Y` reference in code or docs still resolves to the right place in both files.

Ordering follows `plan.md`: phases ascending, tasks ascending within a phase.

---

## Phase 0 — Go/no-go gate ✅ CLOSED (2026-09-01)

*`plan.md` §3. The gate's five steps stay in `plan.md`: they are the gate's own definition, and
§15.1 — no phase entered without its gate — is enforced by pointing at them.*

~~**Task 0.1 — Build-vs-join check.**~~ ✅ **Approved by the repository owner on 2026-09-01**, by
this document's own title: "Stator niche decision — explicit static/dynamic policy for tooling
binaries". `NICHE.md` names all three required elements — the niche (small standalone
developer-tool and worker binaries being migrated from JavaScript to strict TypeScript, under an
explicit two-mode policy over ONE module graph), the competitor that almost serves it
([scriptc](https://github.com/vercel-labs/scriptc), whose public contract is construct-level static
compilation with an embedded QuickJS-NG fallback), and why it does not: Stator's contract is two
auditable source-POLICY modes in the same graph, with typed/dynamic provenance carried through HIR
and mandatory checks where dynamic JavaScript enters typed TypeScript. Step 3's disqualifier is
answered in the file and stands: if the real requirement is extensible end-user scripting, embedding
an engine is the lower-risk choice and Stator should not be used. Every market claim is a product
SELF-DESCRIPTION with a link — no competitor benchmark number is cited as evidence, per the rule in
AGENTS.md. Two conditions ride with the approval: scriptc is re-evaluated quarterly, and reopening
the decision needs §15.4's bar (new measured evidence in `plan-notes.md`), not a change of mind.

**Check — PASSED** (2026-09-01; re-verified at HEAD `e27e118` the same day, five commits later):
`NICHE.md` exists with the three required elements ✅ (the read is the paragraph above);
`git cat-file -e phase-0-approved:NICHE.md` → exit 0, and
`git log --diff-filter=A --format=%H phase-0-approved -- NICHE.md` → `f5bdb0c6da59ac746cfddf925a09bccae6adfe24`,
equal to `git rev-parse phase-0-approved^{commit}` — the tagged commit is the one that added the
file ✅ (plan-notes 123). The Check originally read `git describe --tags --exact-match HEAD`, which
stopped passing with the next commit; replaced in `plan.md` §3 and explained in plan-notes 135.

Phase 1 had already run ahead of this gate on explicit owner instruction — recorded at the time as
an exception under §15.1 rather than as a reinterpretation of it. That exception is now moot.

---

## Phase 1 — Bootstrap and specifications ✅ COMPLETE (2026-08-29)

*`plan.md` §4. The locked `tsconfig.json` this phase produced stays in `plan.md` — it is normative
under §15.7 and changing it requires a plan edit.*

~~**Task 1.0 — Bootstrap the TypeScript workspace.**~~ ✅ Done. Highlights: npm name `stator` is taken → package **`statorc`**, binary stays **`stator`**, both pinned by a unit test (notes #1); `typescript` pinned **6.0.3** — npm `latest` is already 7.0.2/tsgo, which §0.3 bans; re-evaluate 2026-11-29 (notes #2); lint/format is **Biome** (one dev dep replacing ESLint's ~130; the four load-bearing rules at `error`; `noUnnecessaryConditions` off for a documented inference gap; notes #19); runtime archives build to separate `build/` and `build-asan/` trees so a sanitized object can never reach a release link (notes #7); the package manager is **pnpm 11.20.0** (`packageManager` pin) and `cpd` 5.0.16 gates duplication at 1% inside `pnpm run ci` (notes #20). The **locked `tsconfig.json`** it produced stays in `plan.md` §4 and remains normative (§15.7).

**Check — PASSED** (2026-08-29): `./ci.sh` green end to end (`pnpm install --frozen-lockfile && pnpm run ci` + the ASan runtime build); `node src/cli/main.ts --version` prints the version (pinned by a unit test); `make -C runtime` produces `runtime/build/libjsrt.a`. The literal "fresh clone" wording stays unverifiable until the initial commit exists — re-run it then.

~~**Task 1.1 — Write `docs/SUBSET.md`: the feature × mode matrix.**~~ ✅ Done — **`docs/SUBSET.md` is the sole authority for feature rows and their codes** (76 rows, grown from this plan's 26-row seed; the seed table is removed from here so it cannot drift — several of its placeholder codes were remapped when `DIAGNOSTICS.md` won the allocation collisions; notes #10/#11/#15/#17). The verdict vocabulary stays normative: **static** (compiled, unboxed hot path), **dynamic** (compiled via tagged values/shapes/ICs), **error(CODE)** (permanent, by design), **not-yet(CODE, phase)** (planned, diagnostic names the phase).

~~**Task 1.2 — Write `docs/MODES.md`.**~~ ✅ Done — includes the `explain --json` schema resolution (per-construct `constructs` array **plus** a derived file-level rollup, severity `error > not-yet > dynamic > static`; notes #12) and four contradictions found and fixed during reconciliation (1-indexed columns; per-construct codes; `Symbol` correctly a deferral, not permanent; `STA2001` reclassified as a *runtime* diagnostic; notes #13).

~~**Task 1.3 — Write `docs/DIAGNOSTICS.md`.**~~ ✅ Done — it is the **authoritative code allocator** (it wins every collision) and carries a "Retired codes" table: `STA1102` is retired (a not-yet code misfiled in the never range) and must never be reused (notes #10/#11). The range scheme stays as specified: `STA0xxx` CLI/config/toolchain; `STA10xx`/`STA11xx` "never" classes; `STA12xx` "not yet" (names the delivering phase); `STA2xxx` lowering/boundary (`STA2001` is a *runtime* class); `STA3xxx` module graph; `STA4xxx` internal errors (always a compiler bug).

~~**Task 1.4 — Decision tests + conventions.**~~ ✅ Done — **152 fixtures** (76 rows × 2 modes, identical slug sets) in `tests/subset/`; the runner also validates every `@code` against `DIAGNOSTICS.md` (retired codes fail — closes the hole where expected-fail fixtures are never otherwise executed; notes #14), and conditional "static if typed, else dynamic" rows follow the convention: the `ts` fixture takes the typed branch, the `js` fixture the untyped one (notes #16). The directive format lives in AGENTS.md → Testing rules.

**Check — PASSED** (2026-08-29): all three docs exist; 76 × 2 coverage holds by slug-set equality; `pnpm run test:subset` → `152 fixtures — 0 passed, 152 expected-fail, 0 failed`. All-expected-fail is the correct state until Phase 2 ships `explain`; **152 is the number to watch fall.**

---

## Phase 2 — Walking skeleton, end to end ✅ COMPLETE (2026-08-29)

*`plan.md` §5.*

Ship the smallest full pipeline (`ts` mode only) before making any part good. The skeleton treats **all numbers as f64** — that is spec-correct JS semantics; the i32 fast path arrives with `NUMERIC.md` in Phase 3 as a pure optimization.

**Task 2.1 — Write `docs/VALUE.md` first.** All four §2 requirements (bit layout incl. `-0.0`, string struct + accessors, Ryū-exact number printing, rooting protocol). Mirror it in `runtime/include/jsrt_value.h`. No C emission before this merges.

**Task 2.2 — Micro-frontend.** Steps:
1. `src/frontend/program.ts`: build a `ts.Program` from the entry file with Stator-owned `compilerOptions` (strict family on; `noEmit`); surface tsc diagnostics as Stator diagnostics (type errors fail the build).
2. `src/frontend/gate.ts`: mode policy gate for the micro-subset — accept: literals (number/string/boolean), `let`/`const`, arithmetic `+ - * / %`, comparisons, `if`/`while`, `console.log`. Everything else: honest not-yet diagnostic with a span.
3. `src/frontend/types.ts`: `ts.Type → HType` for `number`/`string`/`boolean` only.

**Task 2.3 — Micro-HIR + verifier.** `src/hir/`: node defs for the micro-subset, every node carries an HType; `src/hir/verify.ts` checks type presence and operand agreement; runs after lowering in all builds for now.

**Task 2.4 — C emitter + driver.** Steps:
1. `src/codegen/`: emit one C file; `#line` directives mapping every statement to the `.ts` source; every function opens `JSRT_FRAME`/`JSRT_LOCAL` per `VALUE.md` — from the very first emitted line.
2. `src/cli/build.ts`: orchestrate emit → `clang -O2 -std=c11` → link `runtime/build/libjsrt.a` → executable at `-o` path. `--emit=c`/`--keep-c` retain the C file. Missing clang = `STA0xxx` with install hint.

**Task 2.5 — Runtime v0 (C11).** `jsrt_value` per `VALUE.md`; `JSString` + accessors; `jsrt_print` (console.log for number/string/boolean); shortest-round-trip number printing behind the `shortest_digits()` seam — Ryū (`runtime/vendor/ryu/`) drops into that one function when it can be vendored, see plan-notes 28; Boehm GC initialized where `bdw-gc` is present, with the plain-malloc fallback building and reporting itself when it is not (record install line for macOS/Linux in `TOOLCHAIN.md`); panic handler printing a stack-frame count.

**Task 2.6 — Golden-test harness.** `tests/golden/run.ts`: each `tests/golden/ts/*.ts` is compiled AND run under the pinned Node (`node file.ts` — Node strips types natively); stdout must match **byte-for-byte**. This differential check against Node is the project's ground truth from day 1.

**Task 2.7 — CI hardening.** Add golden tests to `pnpm run ci`; add the ASan/UBSan job (golden tests against `make -C runtime asan` + clang `-fsanitize=address,undefined` on generated C). Record baseline binary size and compile wall-time into `tests/bench/baseline.json`.

**Check:** `console.log(1 + 2 * 3)` prints `7` and an iterative fibonacci with `let`/`while` compiles, runs, and matches Node byte-for-byte in CI, ASan/UBSan clean; `stator explain` reports `static` for both programs; baseline metrics recorded.

**Status: ✅ COMPLETE (2026-08-29).** Check evidence:
- `pnpm run test:golden` → `golden: 6 fixtures — 6 passed, 0 failed`, covering `arithmetic.ts` (prints `7`), `fibonacci.ts` (`let`/`while`, prints `6765`), `numbers.ts` (the formatting boundaries: 1e20, 1e21, 1e-7, `0.1 + 0.2`, ±Infinity, NaN), `control-flow.ts`, `strings.ts` (UTF-8 output), and one `js`-mode fixture. Each is compared byte-for-byte against `node <file>` on the pinned Node.
- `pnpm run test:asan` → the same 6 fixtures pass with the runtime and generated C built `-fsanitize=address,undefined`, plus `runtime: print corpus matches Node (ASan/UBSan)`.
- `pnpm run test:runtime` → the 45-value number/string corpus in `runtime/tests/` matches `console.log` byte-for-byte.
- `stator explain --json` reports `{"verdict":"static"}` for both Check programs.
- `tests/bench/baseline.json` records compile wall-time and binary size per fixture, with host, Node, and clang versions.

Ten defects were found and fixed while making this Check pass; the ones with a lasting rule attached are plan-notes 28–34. The load-bearing one: **the gate's accept set must equal the HIR's vocabulary exactly** — a construct accepted above but unrepresentable below is not a missing feature, it is an internal error waiting to happen.


---

## Phase 3 — Typed HIR and the lowering ladder ✅ COMPLETE (2026-08-30)

*`plan.md` §6.*

**Task 3.1 — HIR design doc (`docs/HIR.md`). ✅ COMPLETE.** **Task 3.2 — `docs/NUMERIC.md`. ✅ COMPLETE**, all 34 of its §10 claims pinned against the pinned Node by `tests/unit/numeric-spec.test.ts` (one claim in the first draft was wrong: `1e21 | 0` is negative).

**Task 3.1 — HIR design doc (`docs/HIR.md`).** Typed, structured control flow (not SSA — structured HIR keeps C emission trivial); every node carries an HType; the HType lattice includes **`Unknown` as a first-class type**: source `any` (js mode)/`unknown`/unions lower to it immediately, codegen emits it as tagged `jsrt_value`, and **every pass (const-fold, DCE, inline) must preserve `Unknown` and may never elide a check on one** — boundary checking is a property of the type system, not a post-hoc pass optimizers can undo. The ts.Type→HType mapping section with ≥10 worked examples (§2). The **HIR verifier** runs after every transform in debug builds.

**Task 3.2 — `docs/NUMERIC.md` — numeric semantics contract**, written before general arithmetic lowering:
- internal i32 fast path; i32 overflow promotes to f64 (JS numbers are f64 — i32 is our invisible optimization);
- bitwise ops (`& | ^ << >> >>>`) apply spec `ToInt32`/`ToUint32` to operands *whatever representation they currently have*; `>>>` produces uint32 (may need f64);
- `-0`, `NaN` propagation, `Object.is` SameValue semantics;
- `==` loose-equality table for primitives; ToPrimitive (valueOf/toString order) specified for the dynamic path;
- decision tests: `(0xFFFFFFFF >>> 0) === 4294967295`, `Object.is(-0, 0) === false`, `(1/3 | 0) === 0`, `NaN !== NaN`.

**Task 3.3 — The lowering ladder.** Lower in this order; each rung ~1–3 weeks, each with golden + decision tests before moving on (arithmetic/strings can run in parallel with control-flow/functions if two agents work disjoint files):
1. Arithmetic per `NUMERIC.md` (introduces i32/f64 split into HIR + runtime).
   - **1a — semantics on the f64-only path: ✅ COMPLETE (2026-08-29).** Unary `- + ! ~`; bitwise
     `& | ^ << >> >>>` with spec `ToInt32`/`ToUint32`; loose equality `==`/`!=`; short-circuiting
     `&&`, `||`, `??`; `null` and `undefined` literals; ToBoolean on conditions. `pnpm run ci`
     green: 70 unit tests, `golden: 10 fixtures — 10 passed` under both the release and the
     ASan/UBSan runtime. Four new golden fixtures (`bitwise`, `unary`, `logical`, `equality`)
     match Node byte-for-byte. Defects found and fixed: plan-notes 35–38.
   - **1b — the i32 refinement: DEFERRED until a runtime-speed measurement exists (Task 6.3).**
     `NUMERIC.md` §11's stated precondition — §10's tests passing on the f64 path — is met. Its
     unstated one is not: §11 also says the refinement "can only *break* things: there is no
     correctness argument for it, only a performance one", and nothing in the repo can measure that
     performance. `tests/bench/baseline.json` records compile wall-time and binary size only, by
     Task 2.7's design; the compute set that would show an i32 win is Task 6.3. Landing 1b now would
     mean claiming a task done on a Check that cannot be run (plan-notes 56). The ladder therefore
     continues at rung 6, and 1b is pulled forward the moment someone wants to spend the
     measurement effort — nothing depends on it, and no `i32` is half-built (`VALUE.md` §5 still
     lists the tag as layout only).
2. **Strings + template literals: ✅ COMPLETE (2026-08-29).** UTF-16 via `VALUE.md` accessors;
   `jsrt_op_add` (the `+` that concatenates when *either* operand is a string), content equality,
   code-unit ordering, template literals as their own HIR node, and `.length`. `pnpm run ci` green:
   71 unit tests, `golden: 12 fixtures — 12 passed` under both the release and the ASan/UBSan
   runtime, `subset: 152 fixtures — 17 passed, 135 expected-fail, 0 failed`. Two golden fixtures
   added (`string-ops`, `template`). Defects found and fixed: plan-notes 39–42. Rung 1a's deliberate
   gap — `+` on strings — is now closed.
3. **Control flow completion: ✅ COMPLETE (2026-08-29).** C-style `for` (all three header slots
   optional), `do`/`while`, `switch`, `break`/`continue`, and labels — all jumps compiled to
   `goto`. Compound assignment (`+= -= *= /= %=`) and `++`/`--` landed with them: rung 1 deferred
   both, and every one of this rung's decision tests needs them (plan-notes 43). `pnpm run ci`
   green: 80 unit tests, `golden: 12 fixtures — 12 passed` under both the release and the
   ASan/UBSan runtime, `subset: 152 fixtures — 26 passed, 126 expected-fail, 0 failed` (up from
   17). One golden fixture added (`control-flow`). Defects found and fixed: plan-notes 43–46.
   - `for-of` moved to rung 5: it iterates an array, so it cannot land before arrays exist. It was
     listed here because it is spelled like a loop, which is the wrong axis — see plan-notes 44.
4. Functions + closures — split into **4a** (calls) and **4b** (captures); recursion needs no
   environment, so it belongs with the former (plan-notes 49).
   - **4a ✅ COMPLETE (2026-08-29).** Function declarations, function expressions, arrow functions,
     parameters, `return`, calls, recursion and mutual recursion. Module-level bindings moved out of
     `main`'s frame into a file-static `JSRT_GLOBALS(n)` pushed once and never popped, because a
     function body may legally read them; that is what makes a self-call resolve. `pnpm run ci`
     green: 116 unit tests, `golden: 14 fixtures — 14 passed` under both the release and the
     ASan/UBSan runtime, `subset: 152 fixtures — 35 passed, 117 expected-fail, 0 failed` (up from
     26). Two golden fixtures added (`ts/functions`, `js/functions`). Defects found and fixed:
     plan-notes 47–48 — Stator was enforcing `noUnusedLocals`/`noUnusedParameters` on *user* source
     and `noImplicitAny` in js mode, and no expected-fail marker had ever been checked for
     staleness. The rung's two standing ceilings are recorded in plan-notes 49.
   - **4b ✅ COMPLETE (2026-08-29).** Captured function-locals: environment structs, capture
     analysis. A closure becomes heap-allocated with an environment pointer; the gate stops
     rejecting cross-function references. `pnpm run ci` green: 125 unit tests,
     `golden: 16 fixtures — 16 passed` under both the release and the ASan/UBSan runtime,
     `subset: 156 fixtures — 39 passed, 117 expected-fail, 0 failed` (up from 35), `12 clones ·
     0.6% duplication`. One golden fixture added (`ts/closures`), four decision tests
     (`closure_capture` and `closure_capture_in_loop`, both modes), one unit-test file
     (`tests/unit/captures.test.ts`). Defects found and fixed: plan-notes 51–52 — a nested
     function's own name was counted as a capture of itself (costing every such function 4a's
     static closure), and a captured loop variable compiled to the last iteration's value, which is
     now `STA1214` rather than a wrong answer. **The rung's standing ceiling:** capturing a binding
     declared inside a loop needs per-iteration environments, deferred to the loop-scope work Phase
     5 step 3 also depends on (plan-notes 52).
     **Representation settled in plan-notes 50** — a heap `JSRTEnv` traced
     `closure → env → slots` (not bare cells, which only a conservative collector can find), the
     env rooted by a new `JSRTEnv *env` field on `JSRTFrame` (it is not reachable from any closure
     before the first one is created, and the tag space is full — see the correction in that
     entry), and a parent chain rather than
     flat capture (flat either breaks shared mutation or reintroduces cells). Non-capturing
     functions keep 4a's static closure with `env = NULL`. `JSRTClosure.fn` gains an env parameter,
     so every generated function's signature changes — that is a `docs/VALUE.md` change too.
5. **Arrays: ✅ COMPLETE (2026-08-29).** Dense, bounds-checked storage (`JSRTArray`: `length`,
   `capacity`, and a separately-allocated element buffer, so the header address stays stable across
   growth); array literals, `.length`, index read and index write, and `for-of` over an array —
   compiled to a counted loop that re-reads the length each step, and labellable like any other
   loop. `console.log` on an array reproduces Node's `util.inspect` byte-for-byte, grouping and
   80-column break and depth cap included (`docs/VALUE.md` §4.4). `pnpm run ci` green: 136 unit
   tests, `golden: 17 fixtures — 17 passed` under both the release and the ASan/UBSan runtime,
   `subset: 160 fixtures — 50 passed, 110 expected-fail, 0 failed` (up from 39), `runtime: print
   corpus matches Node` in both builds, `16 clones · 0.6% duplication`. One golden fixture added
   (`ts/arrays`), ten decision tests (five array/for-of pairs), one unit-test file
   (`tests/unit/arrays.test.ts`). Defects found and fixed: plan-notes 53–55 — a binding's HType came
   from its initializer rather than its declaration, which made the legal `let x: string | number =
   1; x = 'a'` an internal compiler error; a write that would leave a hole silently filled it with
   `undefined` and printed a different program's output; and the unit-test helper had been building
   every program with `lib: ['es2024']`, which is not a lib FILE name and so resolved to no standard
   library at all (in which `number[]` is an error type).
   **The rung's standing ceilings, both with the plan's own answer:**
   - **Sparse arrays are `STA2002`, raised at runtime.** A write more than one past the end refuses
     rather than filling the gap; in-range writes and `a[a.length] = v` are unaffected. Lifts with
     the object model (plan-notes 55).
   - **The typed read of `a[i]` landed with Task 3.5.** `noUncheckedIndexedAccess` (Task 1.0) types
     an indexed read as `T | undefined`, which lands in the HIR as `Unknown`; narrowing one now
     inserts a check, so `const v = a[i]; if (v !== undefined) { sum = sum + v; }` compiles and the
     addition is on a value proved to be a number. The bare `sum += a[i]` still does not, and that
     is the CHECKER refusing it, not the gate — `T | undefined` is not addable, and no check the
     compiler inserts changes what TypeScript will accept.
     Elision of the bounds check remains open and belongs to the optimization passes: 3.5 gives it
     something to elide, it is not itself the eliding. The flag stays on: an index is a boundary,
     and golden rule 4 applies to it (plan-notes 53).
6. Classes → fixed slot offsets; getter/setter classes take the dynamic path per `SUBSET.md`.
   Split into **6a** (a class whose layout is fixed at its declaration) and **6b** (everything that
   changes what a layout is), on the line drawn in plan-notes 59.
   - **6a ✅ COMPLETE (2026-08-29).** Classes with fields, one constructor, instance methods and
     field initializers; `new`, `this`, field read and write in every assignment form, and method
     calls. An instance is one allocation — a pointer to a file-scope `static const JSRTClass`
     descriptor followed by its slots — with declaration order as slot order; a field read is an
     offset load. A method occupies no slot: one function is shared by every instance and the call
     resolves at compile time, with the receiver passed as argument zero. `console.log` on an
     instance reproduces Node's `util.inspect` byte-for-byte, including the fact that the class name
     counts toward the 80-column budget and that objects never group (`docs/VALUE.md` §4.5).
     `pnpm run ci` green: 147 unit tests, `golden: 18 fixtures — 18 passed` under both the release
     and the ASan/UBSan runtime, `subset: 160 fixtures — 52 passed, 108 expected-fail, 0 failed`
     (up from 50), `runtime: print corpus matches Node` in both builds, `22 clones · 0.8%
     duplication`. One golden fixture added (`ts/classes`), one runtime corpus (`print_objects`),
     one unit-test file (`tests/unit/classes.test.ts`); the `class_fixed_shape` decision tests flip
     to passing in **both** modes. Defects found and fixed: plan-notes 57. Design decisions
     recorded: plan-notes 58 (`this` is a parameter, not a node kind) and 59 (the 6a/6b line).
   - **6b — ToPrimitive ✅ done (2026-08-29).** ToPrimitive was listed here
     as a feature and was not one: `jsrt_loose_equals`, `jsrt_to_number`, `jsrt_op_add`, and
     `jsrt_compare` had all shipped object-blind in rung 5, so `a == a` answered **false** for every
     array and class instance while `a === a` answered true. One `jsrt_to_primitive`, run first in
     each of the four, closes all 12 mismatches a 22-expression probe found against Node
     (plan-notes 60); it takes no `hint` parameter, because nothing in the subset can observe one
     (`docs/NUMERIC.md` §7 says when that changes). Two golden fixtures carry it: the object rows of
     `ts/equality` and a new `js/to-primitive` for the conversions ts mode's checker rejects before
     the compiler sees them. Second defect fixed in passing: `STA4011`/`STA4012` rejected an
     `unknown` arithmetic operand, so `id(a) - 1` in js mode — source the gate accepts — reached an
     internal error.
   - **6b — inheritance and `super(...)` ✅ done (2026-08-29).** `extends`, `super(...)`, prefix
     layout, assignability, `instanceof` up the chain, and synthesized derived constructors. A
     subclass's slots START with its base's, in the base's own slot order, which is the only thing
     making `hTypeAssignable` sound: the first N slots of a `Dog` *are* an `Animal`, so every
     existing node — `FieldAccess`, `MethodCall`, `console.log`'s printer — works unchanged on a
     base-typed reference. The slot list is rebuilt root-first from the chain, because the checker
     lists a subclass's OWN properties first (plan-notes 62, which also records the js-mode bug a
     sort-based fix caused and a golden fixture caught). `JSRTClass` grew one `parent` pointer and
     `jsrt_instanceof` grew the walk; no generated C at a call site changed. `MethodCall.className`
     became the class that DECLARES the method, so an inherited method is a direct call to the one
     function that exists. Field initializers now run AFTER `super(...)`, since one may read a field
     the base wrote. A derived class that writes no constructor gets JavaScript's implicit
     `constructor(...args) { super(...args) }`.
     **Method overriding and `super.method()` are deferred with the vtable, deliberately**: static
     dispatch is sound exactly while no method is overridden, so redeclaring an inherited member is
     refused at the gate with that reason in both modes rather than silently dispatching to the
     base's body (plan-notes 63, which also records three load-bearing-invariant violations found on
     the way). `pnpm run ci` green: 158 unit tests, `golden: 22 fixtures — 22 passed` under both the
     release and the ASan/UBSan runtime, `subset: 164 fixtures — 60 passed, 104 expected-fail, 0
     failed`, `runtime: print corpus matches Node` in both builds, `22 clones · 0.8% duplication`.
     Two golden fixtures added (`ts/inheritance`, `js/inheritance`); `class_inheritance` flips to
     passing in both modes and a new `method_override` pair pins the deferral.
   - **6b — static members ✅ done (2026-08-29).** A static belongs to the class object and there
     is no class object here, so a static is ONE binding for the whole program under a name no
     source can spell (`C.count`; the dot does what the receiver parameter's leading space does).
     That reduction is the design: a read is an `Identifier`, a write is an `Assignment`, `C.m()` is
     a `CallExpr`, and `C.count += 1` reuses the identifier compound path unchanged — statics needed
     **no HIR node, no verifier case and no emitter case**, only a `statics` list on
     `ClassDeclaration` that the enclosing scope walks. The name carries the DECLARING class,
     because statics are inherited and `Sub.count` must be the same binding as `Base.count`; names
     hoist before values are lowered, so one static method may call another written below it
     (plan-notes 65).
     Two pre-existing defects surfaced and were fixed. `hTypeAssignable` refused an Unknown VALUE
     into a typed binding, making six lines of ordinary js-mode source (`let total = 0; total =
     add(total, 3)` with an untyped `add`) an internal error; Unknown is now assignable in both
     directions, the same exemption arithmetic operands already got. And `this`/`super` were gated
     by **dead code** — both are `ts.SyntaxKind` TOKENS, so the walker's token short-circuit
     swallowed their cases, and `console.log(this)` reached `STA4061` instead of a `not-yet`
     (plan-notes 64). `pnpm run ci` green: 164 unit tests, `golden: 24 fixtures — 24 passed` under
     both the release and the ASan/UBSan runtime, `subset: 166 fixtures — 64 passed, 102
     expected-fail, 0 failed`, `runtime: print corpus matches Node` in both builds, `22 clones ·
     0.7% duplication`. Two golden fixtures added (`ts/statics`, `js/statics`);
     `static_class_members` flips to passing in both modes and a new `static_block` pair pins the
     deferral.
     `#private` members then landed with **no compiler surface of their own**: `#count` is a slot,
     `#step()` a member function, `static #next` a static binding, and the name simply keeps its
     `#`. Privacy is a checker fact — every access from outside the class body is already an error
     before the gate runs — so the whole feature below the frontend is one rule in the runtime
     printer: `util.inspect` omits `#private` fields, so a descriptor field name starting with `#`
     is skipped, and a class whose fields are all private prints `C {}`. Two deferrals are forced by
     the layout, not by privacy: a subclass re-declaring an ancestor's `#private` name is two slots
     sharing a spelling that a name-keyed list would merge, and `#brand in o` asks whether a slot
     exists rather than reading it. A third defect surfaced: the runtime Makefile listed no header
     prerequisites, so editing `jsrt_value.h` rebuilt nothing and `make -C runtime test` had been
     linking corpus binaries against a struct that no longer existed; fixed with generated depfiles
     (plan-notes 66). `pnpm run ci` green: 168 unit tests, `golden: 26 fixtures — 26 passed` under
     both the release and the ASan/UBSan runtime, `subset: 168 fixtures — 68 passed, 100
     expected-fail, 0 failed`, `runtime: print corpus matches Node` in both builds, `23 clones ·
     0.8% duplication`. Two golden fixtures added (`ts/private`, `js/private`); `private_fields`
     flips to passing in both modes and a new `private_shadowed` pair pins the deferral.
     Method overriding then landed with a **method table in the class descriptor**: `method_count`
     entries of file-scope `JSRTClosure` pointers, in the same prefix order the fields have, so the
     slot comes from the receiver's static type and the entry from its dynamic one. Dispatch is
     decided per METHOD, not per call site — the lowering asks the whole file whether any chain
     containing the receiver's class declares that name twice — so a method nothing overrides keeps
     rung 6a's direct call and a program that overrides nothing pays nothing. `super.m()` is a call
     on the same receiver with the override skipped, and is direct even where the same method is
     virtual everywhere else; a virtual call there would find the override again and recur. Two
     deferrals follow from the table being a constant: overriding inside a function (a method there
     may capture) and re-declaring a FIELD (one slot, two initializers). A mode-policy bug fell out
     and was fixed: `noImplicitOverride` demanded a JSDoc `@override` tag in js mode, rejecting
     ordinary JavaScript, and is now `mode === 'ts'` like `noImplicitAny` (plan-notes 67). One
     contradiction is recorded and NOT fixed: js mode still rejects an override that narrows an
     inferred return type, pinned as an `@expected-fail` decision test (plan-notes 68).
     `pnpm run ci` green: 175 unit tests, `golden: 28 fixtures — 28 passed` under both the release
     and the ASan/UBSan runtime, `subset: 173 fixtures — 72 passed, 101 expected-fail, 0 failed`,
     `runtime: print corpus matches Node` in both builds, `23 clones · 0.8% duplication`. Two golden
     fixtures added (`ts/override`, `js/override`); `method_override` flips to passing in both
     modes and new `override_nested` and `field_redeclared` pairs pin the deferrals.
     Getters and setters then landed — and NOT via the dynamic path the plan predicted. An accessor
     is a pair of member functions under a name no source can spell (`get x`, `set x`, where the
     space does what the dot does for a static), so `o.x` is a call and `o.x = v` is a call, the
     property occupies no slot, and the class keeps the fixed-slot layout of its actual fields. The
     whole feature is a mangled name, one branch in `classTypeToHType` and two in the lowering: no
     HIR node, no verifier case, no emitter case, no runtime change, and `util.inspect` omits the
     property for free because the printer prints slots. The `dynamic` verdict this plan promised
     for such a class is now `static`, and `docs/SUBSET.md` is corrected (plan-notes 69). Deferred
     with reasons: a compound assignment to an accessor, a static accessor, a `#private` or computed
     accessor name, and overriding an inherited accessor. `pnpm run ci` green: 179 unit tests,
     `golden: 30 fixtures — 30 passed` under both the release and the ASan/UBSan runtime,
     `subset: 177 fixtures — 78 passed, 99 expected-fail, 0 failed`, `runtime: print corpus matches
     Node` in both builds, `25 clones · 0.8% duplication`. Two golden fixtures added
     (`ts/accessors`, `js/accessors`); `class_with_getters_setters` flips to passing in both modes
     and new `accessor_compound` and `static_accessor` pairs pin the deferrals.
     Object literals closed the rung, and the premise this plan gave for deferring them — "a
     literal has no class declaration to be a layout OF" — was true of the DECLARATION and false of
     the layout. The checker already computes the anonymous object type, with its properties in
     written order, which is exactly what the class path consumes; the missing piece was a NAME. A
     shape is named structurally (`{x: number, y: string}`, whose leading brace is unspellable the
     way the receiver's leading space and a static's dot are), so two literals with the same fields
     are one HType, share one emitted descriptor, and are assignable to each other — while a
     different key ORDER is a different shape, because order is layout. The descriptor's name is
     empty and the printer reads an empty name as "no constructor name", which is the single
     runtime change the feature needed and the reason `{ x: 1 }` prints bare where `Point { x: 1 }`
     does not. One HIR node (`ObjectLiteral`: entries in written order, no keys below the gate), one
     verifier case (STA4052 — the entries ARE the slots, so an order that disagrees with the shape
     would emit a silently wrong object), one emitter sequence expression (plan-notes 70). Deferred
     with reasons: a shorthand, spread, method or accessor member and a non-identifier key (Phase 3
     — statically knowable, nothing to lower to yet); a literal whose type is not a layout, meaning
     an optional property or an index signature (Phase 4 — that is the shape table in Task 4.1, and
     the gate's message says so rather than naming one phase for both kinds of refusal).
     `pnpm run ci` green: 187 unit tests, `golden: 32 fixtures — 32 passed` under both the release
     and the ASan/UBSan runtime, `subset: 181 fixtures — 84 passed, 97 expected-fail, 0 failed`,
     `runtime: print corpus matches Node` in both builds, `25 clones · 0.8% duplication`. Two golden
     fixtures added (`ts/objects`, `js/objects`); `object_literal_static_keys` flips to passing in
     both modes and new `object_literal_method` and `object_literal_spread` pairs pin the deferrals.
     One side finding, recorded because it changes a shared file: the two added interfaces pushed
     `nodes.ts` past jscpd's 50-token floor, and jscpd bills a match by the LINE span between its
     first and last token, so 50 tokens in a comment-heavy declaration file were charged as 623
     duplicated lines. `nodes.ts` holds types and nothing else, and a discriminated union's `kind`
     field cannot be factored out without deleting what makes the IR safe, so the declarations are
     wrapped in `jscpd:ignore` markers that say why in the file. The threshold stays 1% and the
     config is untouched (plan-notes 71).
   - **6b ✅ COMPLETE (2026-08-29).** Everything plan-notes 59 assigned to the rung has landed:
     ToPrimitive, inheritance and `super(...)`, statics, `#private`, method overriding and
     `super.m()`, accessors, and object literals with static keys. Two claims this plan made about
     the rung turned out to be wrong and are corrected above rather than left standing: a class with
     accessors does NOT take the dynamic path (an accessor is a method under an unspellable name,
     plan-notes 69), and a literal's lack of a class declaration does not deny it a layout (the
     shape comes from the type, plan-notes 70). Deferrals are individually justified where they
     appear, and each is pinned by an `@expected-fail` decision test in both modes; the only one
     that is a plan contradiction rather than a schedule is plan-notes 68 (js mode rejects an
     override narrowing an inferred return type).
7. `Map`/`Set`: **one** open-addressed hash table keyed by SameValueZero, not the two paths this
   line used to ask for. A NaN-boxed primitive key already IS its unboxed bits and an object key
   already IS its pointer, so the "specialized primitive" and "identity-hash" tables would have been
   the same code twice; the only difference is four lines inside one `hash_key` (plan-notes 72).
   - **7 ✅ COMPLETE (2026-08-29).** `new Map<K, V>()` / `new Set<T>()`, `get`, `set`, `has`,
     `delete`, `clear`, `add`, `size`, and `console.log` of either matching Node byte-for-byte in
     both the release and ASan/UBSan builds. Entries are dense and in insertion order, so print
     order survives deletion and the growth compaction. A Set is the same struct with the value half
     unused, told apart by a second `JSRTClass` descriptor — the tag field is full (`docs/VALUE.md`
     §1.1), so a builtin is an `Object`-tagged pointer distinguished by its descriptor, exactly as
     an object literal is. Two frontend facts this plan did not predict are recorded in SUBSET.md:
     the type arguments must be on the CONSTRUCTION (`const m: Map<string, number> = new Map()`
     types the call `Map<any, any>`), and `.get` is dynamic everywhere because the lib types it
     `V | undefined` and the HType model has no union. Deferred: constructing from an iterable,
     iteration through an ITERATOR (`for-of`, `keys`, `values`, `entries`), and `WeakMap`/
     `WeakSet`, which need the collector to know what weakness is. `forEach` is not among them
     and once was by mistake: it takes a callback, not an iterator (Task 4.2 addendum below).

**Task 3.4 — Monomorphization.** ✅ **Done.** Generic function DECLARATIONS are instantiated per concrete type tuple, shared by HType identity, and capped at depth 16 (`STA2003`, a user error — the program genuinely has no fixed point).

  Specialization happens at the LOWERING, not in a pass: the generic's AST is lowered once per tuple with the substitution in scope (carried in the binding map already threaded everywhere, under the unspellable key `<T>`), so a type parameter is never built into the HIR at all — `hasTypeParam` in the verifier (`STA4054`) checks an invariant of construction rather than the output of a walk. See plan-notes.md entry 73 for why this beats an HIR clone pass.

  The substitution is recovered through the public API by unifying the DECLARED signature's HTypes (which mention `T`) against the RESOLVED one's (which do not) — exact, not heuristic, because one is the other instantiated. Unifying on HType rather than `ts.Type` is what makes `box(1)` and `box(2)` share one specialization: their literal types collapse to `number`.

  Deferred (`STA1214`): a generic used as a VALUE, generic arrows/function expressions, constrained or defaulted type parameters, explicit type arguments, and generic classes. The boxed-`Unknown` fallback instantiation for cold generics is not built — §13's bloat budget has not been tripped, and building it before it is would be a second code path with no measurement behind it.

  `pnpm run ci` green: `Checked 45 files … No fixes applied`, `28 clones · 0.9% duplication`, 209 unit tests (14 of them `tests/unit/generics.test.ts`), `runtime: print corpus matches Node`, `subset: 181 fixtures — 94 passed, 87 expected-fail, 0 failed`, `golden: 36 fixtures — 36 passed, 0 failed` under both the release and the ASan/UBSan runtime.

**Task 3.5 — Boundary-check insertion.** ✅ **Done.** A narrowed read of an `Unknown` and an `as` cast off one both lower to a `BoundaryCheck`, which emits `jsrt_check_number/string/boolean` — the value back on success, `STA2001` with a `file:line:col` on failure. `typeof` landed with it, as its own HIR node.

  Not a pass, for the same reason Task 3.4 is not: the insertion point is where a `ts.Type` becomes an HType, which only the lowering has. A pass would have to rediscover the narrowing from an HIR that had already thrown it away.

  Three deliberate scopings, all recorded in plan-notes.md entry 74. The check is per USE, not per binding — nothing proves the value did not change between two reads. A narrowing to a type no TAG settles in constant time (an object, an array, a signature) leaves the value `Unknown` on the dynamic path rather than being refused: refusing buys no soundness, since nothing downstream was going to trust the type, and would break `m.get(k) ?? d` and every other narrowing that compiles today. And **union types came free**: the HType model has no union node, so `string | number` IS `Unknown`, and narrowing one is the machinery `unknown` already needed. A union whose constituents all map to one HType is widened to it (`"a" | "b"` → `string`), which is what makes `typeof` usable at all — TypeScript types it as a union of eight string literals.

  Deferred: `JSON.parse` and FFI returns, which need the builtin (§7 Task 4.2) and Phase 6 rather than new check machinery; `.ts`↔`.js` graph boundaries, which need Phase 5's module graph; and discriminated unions keyed on a TAG, which need a union the model can see the constituents of.

  `pnpm run ci` green: `Checked 47 files … No fixes applied`, `28 clones · 0.9% duplication`, 220 unit tests (11 of them `tests/unit/narrowing.test.ts`), `runtime: print corpus matches Node` (now including `print_typeof`), `subset: 181 fixtures — 100 passed, 81 expected-fail, 0 failed` (`typeof`, `unknown` and union fixtures flipped off `@expected-fail` in both modes), `golden: 38 fixtures — 38 passed, 0 failed` under both the release and the ASan/UBSan runtime.

**Task 3.6–3.9 — Optimization passes v0.** ✅ **Done.** Const-fold, DCE/tree-shake and inlining run as `optimize()` from `src/passes/index.ts`, over a shared bottom-up, identity-preserving rewriter (`src/passes/rewrite.ts`) with exhaustive switches over every HIR node kind.

  They run BEFORE the verifier, not after the lowering: what reaches the emitter is the optimized module, so that is what has to be checked. Verifying the lowering's output instead would check a tree nothing emits (plan-notes.md entry 75).

  `Unknown` preservation is a property of each pass's admission rule rather than a check bolted on. Const-fold folds only when every operand is a LITERAL NODE — which is simultaneously why no fold can elide a boundary check (a literal is never `Unknown`) and why no fold can delete a side effect (a literal has none). DCE reasons only about control flow, never about values. Inlining requires the argument's HType to equal the parameter's, which is what stops a `js`-mode call from having its `Unknown` parameter replaced by a typed subtree.

  The evaluator for folding is JavaScript's own — the compiler runs on the pinned Node the golden tests diff against, so a folded `${1 / 3}` and an unfolded one produce the same bytes, and `-0`, NaN and `1 << 31` need no special case.

  Inlining covers a body that is exactly one `return <expr>`, bounded by four refusals (one statement; the body names nothing but its parameters; every argument is a literal or identifier; types agree exactly). Condition two closes the shadowing hazard the HIR's name-only identifier resolution creates, and makes recursion impossible by construction — nothing tests for it. The pipeline runs once rather than to a fixpoint; both scopings and the ordering argument are in plan-notes.md entry 75.

  Deferred: a general inliner (needs a block-expression or the statement machinery for multi-return bodies), iterating to a fixpoint, treating an `if` whose branches both return as a terminator, and shaking classes — `new C()` names its class by string, so the reference walk cannot see it. Builtin tree-shaking is Task 3.12.

  `pnpm run ci` green: `Checked 52 files … No fixes applied`, `28 clones · 0.8% duplication`, 245 unit tests (25 of them `tests/unit/passes.test.ts`), `runtime: print corpus matches Node`, `subset: 181 fixtures — 100 passed, 81 expected-fail, 0 failed`, `golden: 40 fixtures — 40 passed, 0 failed` under both the release and the ASan/UBSan runtime.

**Task 3.10 — Exception unwinding.** `try/catch/finally` lowering emits per-scope cleanup blocks; every `goto landing_pad_N` routes through the scope's cleanup (shadow-frame pops, `finally` bodies); decision tests exercise throw-inside-loop-inside-try with ASan on.

  ✅ **Done (2026-08-30).** Return-value + landing-pad style exactly as §2 prescribes: the runtime contributes one thread-local pending cell (`jsrt_throw`/`jsrt_pending`/`jsrt_take_exception`, overwrite-on-throw required so a finally's throw replaces the in-flight completion) plus `jsrt_uncaught` (stderr + exit 1, matching Node observably); everything else is generated C. Every throwing operation — `jsrt_call` in all its spellings — is emitted as its own statement followed by `if (jsrt_pending()) goto <pad>;`, which forced the emitter's comma-expression builders to learn to flush to statements when an operand carries a call (evaluation order stays JavaScript's: already-evaluated operands are in rooted slots before a later operand's call runs). Loop conditions and short-circuit right operands capture their prelude and replay it at the re-evaluation point. A try-with-finally lowers to an `int` completion code (0 normal, 1 rethrow the stashed — rooted — exception, 2+ one per distinct `return`/`break`/`continue` out of the protected code) dispatched after the finally body; the dispatch re-performs the jump in the popped context, so a jump crossing two finallys chains through both, and a finally's own throw/jump abandons the code undispatched — which IS the replacement rule. Units that can throw get a `_jsrt_unwind` pad that pops the frame (main's calls `jsrt_uncaught`). New: HIR `ThrowStatement`/`TryStatement` (catch binding Unknown always; `STA4057` for unbuildable shapes), gate accepts try/throw/catch (destructured catch binding stays not-yet STA1214), docs/VALUE.md §4.9, docs/HIR.md §1.3. Check: `pnpm run ci` green — `Checked 52 files … No fixes applied`, `31 clones · 0.9% duplication`, `tests 255 / pass 255 / fail 0`, `subset: 181 fixtures — 102 passed, 79 expected-fail, 0 failed` (both `subset_try_catch_finally_throw_*` flipped from expected-fail), `golden: 42 fixtures — 42 passed, 0 failed` under both the release and the ASan/UBSan runtime; `tests/golden/{ts,js}/exceptions.*` exercise throw-inside-loop-inside-try, return/break/continue through finally, rethrow, nested try and finally-replaces-throw, byte-for-byte against Node.

**Task 3.11 — Modules.** ESM only, whole-program v0. Build the import graph from the `ts.Program`; **cycles are `STA3001` with source locations** (never silently pick an order); module-init code in topological order. Decision tests: cycle rejected; `a→b→c` initializes c, b, a.

  ✅ **Done (2026-08-30).** Whole-program v0 as one merged Module HIR: `src/frontend/graph.ts` walks value imports (type-only edges skipped) off the `ts.Program`, DFS back edges are STA3001 with the cycle spelled (`a.ts → b.ts → a.ts`), and the postorder is the init order — dependencies first, entry last — which `lowerProgram` lowers into a single statement list sharing one binding namespace. An import binds nothing (the name resolves to the exporting file's own top-level binding), so the gate refuses every aliasing shape as not-yet STA1214: renamed specifiers, default imports, namespace imports, re-exports, non-literal default exports; cross-file top-level name collisions are likewise refused, naming both files. `export default <literal>` accepted, lowers to nothing. compilerOptions moved NodeNext → ESNext/Bundler/Force (NodeNext classified bare `.ts` directories as CommonJS via package.json sniffing); the gate re-imposes Node's permanent extension rule as STA1113 (never) since Bundler would resolve extensionless specifiers. Evidence + decisions: plan-notes 78. Check: `pnpm run ci` green (figures below); decision tests `subset_cyclic_imports_{ts,js}` (STA3001) and `subset_{import,export}_declarations_{ts,js}` flipped from expected-fail; golden `tests/golden/{ts,js}/modules/` (`main → b → c`) prints `init c / init b / init a` then computed values, byte-for-byte with Node; `tests/unit/graph.test.ts` covers topo order, cycle spelling, collision, and the type-only exemption.

**Task 3.12 — Tree-shaking builtins.** Builtins are HIR-level library modules; only referenced ones are emitted/linked. Size target once stable: hello-world < 500 KB (competitors report 170–330 KB — sources conflict; measure current releases yourself, record in `tests/bench/`).

  ✅ **Done (2026-08-30).** "Only referenced ones are linked" is the linker's job, done at function granularity: the runtime archive compiles with `-ffunction-sections -fdata-sections` and the release link passes `-Wl,-dead_strip` (Mach-O) / `-Wl,--gc-sections` (ELF), so hello-world drops from 53 linked `jsrt_*` builtins to the 5 it references (`init`, `frame_init`, `string_from_utf8`, `print`, `panic`) and from 72 KB to 51.8 KB — the < 500 KB target is met with ~10× headroom (recorded per-fixture in `tests/bench/baseline.json`, refreshed). Sanitized builds skip stripping (ASan global-registration sections are what `--gc-sections` drops). The task's "HIR-level library modules" phrasing described a builtin representation that does not exist yet — every builtin is a C runtime function, and none is authored at HIR level to shake (plan-notes 79); the emitter already emits only user code. Check: `tests/unit/cli.test.ts` asserts a built binary contains `jsrt_print` and not `jsrt_map_new`; golden 44/44 under both release and ASan runtimes after the flag change; full `pnpm run ci` green (figures below).

**Check per rung:** golden tests match Node; HIR verifier clean; the construct's decision tests flip from expected-fail to passing. *(This third clause was unmeetable until 2026-08-29: every fixture ended in `export {…}`, so all 152 asserted only "modules are not-yet". Fixed in plan-notes 42 — a fixture must not depend on a construct it does not name.)* **Phase exit:** a real ~500-line typed TS program (e.g. a JSON→CSV converter) compiles in `ts` mode and matches Node with ≤3 workarounds (§13 tripwire).

  ✅ **Phase exit met (2026-08-30).** `tests/golden/ts/exitcheck/` — a 477-line transit route planner across five modules (city registry, CSR graph, binary min-heap, Dijkstra + fare rules, report driver) exercising classes, Map, arrays with the append idiom, for-of, generics at two instantiations, exceptions, and the Task 3.11 module graph. Compiles in `ts` mode and matches Node byte-for-byte as a golden fixture (`golden: 45 fixtures — 45 passed`). Workarounds used, three families: (1) `as number/string/boolean` on index reads — the `noUncheckedIndexedAccess` union has no HType, and each cast is a real runtime check; (2) missing Phase-4 globals substituted — `| 0` for `Math.floor`, an integer sentinel for `Infinity`, thrown strings for `new Error`; (3) `.length =` truncation is not in the subset, so the heap tracks a logical count over storage that never shrinks. At the ≤3 boundary, not over it — the §13 tripwire does not fire, and all three families name their Phase-4/object-model lifts. Writing the program also flushed out a real Task 3.11 bug, fixed in the same change: a RELATIVE entry path left the program's fileNames relative while the resolver answered absolute, so every import edge silently missed and legal source died as internal STA4035; `createProgram` now roots the entry absolute, with a cwd-pinned regression test in `tests/unit/cli.test.ts`.


---

## Phase 4 — Runtime v1 ✅ COMPLETE (2026-09-01)

*`plan.md` §7. **The phase is still open**: Task 4.2 (builtins) is in progress and its statement,
along with the phase Check, is still in `plan.md`. What follows is the evidence for the slices that
have landed.*

### Task 4.1 — Objects

✅ **Done.** The fixed-shape half landed with Phase 3 rung 6 (classes and literal layouts — a field read is an offset load, no IC). This task added the dynamic residue: `JSRTShape` transition chains off one root shape, `JSRTDynObject` with out-of-line doubling slot storage, and per-SITE `JSRTIC {shape, offset}` caches, filled only on hit — get-misses answer `undefined` and are never cached, and construction stores carry `NULL` caches because every one transitions (docs/VALUE.md §4.10, `runtime/src/jsrt_shape.c`, print corpus `print_shapes`). The frontend consumer: a literal whose CONTEXTUAL type (`getContextualType ?? getTypeAtLocation` — the annotation must win, since later reads go through it) has an optional property or index signature lowers to `DynObjectLiteral`, and property sites on such receivers to `DynFieldAccess`/`DynFieldAssignment`, all typed Unknown under verifier discipline `STA4059` (docs/HIR.md). Structural aliasing of a fixed object into a dynamic site aborts loudly at run time — `STA2004`, the third runtime-emitted diagnostic — rather than guess a slot (plan-notes 80). Check: `pnpm run ci` — 268 unit tests, subset 183 fixtures (112 passed / 71 expected-fail / 0 failed), golden 47/47 both runtimes, ASan/UBSan clean.

**Array-with-properties slice landed (2026-09-01), closing this task.** `JSRTArray` gained the
dynamic object's own property layout — `shape` + out-of-line `slots` + `slot_capacity`, with
`shape == NULL` meaning "no properties" so every ordinary array pays one NULL word and no
allocation — and `runtime/src/jsrt_shape.c` now drives a dynamic object and an array through ONE
`PropTable` view, so `m.index` resolves through the same shape chain and the same per-site inline
cache an `o.x` does (docs/VALUE.md §4.4). One thing needs this and it is not an optimization: a
RegExp match, which ECMA-262 §22.2.7.2 builds as an array of the capture groups carrying `index`,
`input` and `groups` as properties. `RegExp.prototype.exec` and `String.prototype.match` landed on
it, along with the print form Node uses — properties after the elements, no element grouping, and
`groups` printed as the NULL-PROTOTYPE object it is (`[Object: null prototype] { year: '2026' }`,
marked by a second class descriptor `jsrt_class_null_proto` that differs from `jsrt_class_dynamic`
by address alone). A capture that did not participate is `undefined` IN the array; `lastIndex`
moves exactly as `test` moves it, because exec and test are one algorithm with two answers; `match`
without `/g` IS exec and with `/g` answers the plain CreateArrayFromList list, or `null`.

The typing decision is recorded in full in plan-notes 120: the match's HIR type is **Unknown** and
its verdict `dynamic`, because `exec` answers a match OR null and the HIR has no union. Rather than
add `array` to `CHECKABLE` (which would silently widen every `unknown → T[]` narrowing in the
language) or give the match array an HType of its own, the surface follows the discipline every
other builtin follows: a closed table (`MATCH_FIELDS` — `index`, `input`, `groups`, `length`), one
HIR node (`MatchRead`, verifier `STA4089`), and the CHECKER as the proof that a receiver is a match
(`isMatchReceiver`, exactly as `isStringReceiver` proves a string). `m[0]` indexes it like the dense
array it is. Everything else on a match — `m.map`, `m.slice`, spreading it — is
`not-yet(STA1214, Phase 5)`, the union work. Check: `pnpm run ci` — 297 unit tests, 257 subset
fixtures (192 passed / 65 expected-fail / 0 failed), 85 golden fixtures both modes, runtime print
corpus matches Node, ASan/UBSan clean; `pnpm run test:builtins` 154/196 with `String.prototype`
31/32.

### Task 4.2 — Builtins (in progress; these slices landed)

**In progress — Math slice landed (2026-08-30).** The dashboard exists and runs in CI (`tests/golden/builtins_coverage.json` + `pnpm run test:builtins`, which verifies every claim: fixture exists AND mentions the member). Math's exactly-specified operations are done — `abs ceil floor round sign trunc sqrt pow min max`, all 8 constants, plus the `NaN`/`Infinity` globals — as one `MathCall` HIR node (CollectionOp precedent, `STA4080` verifier discipline) and one ECMA-exact C function each in `runtime/src/jsrt_math.c`; constants fold to the pinned Node's own doubles at lowering (plan-notes 81). The approximated transcendentals (`sin`, `log`, `exp`, `random`, …) are deliberately deferred until fdlibm is vendored — golden tests are byte-for-byte against Node, whose answers come from V8's fdlibm, not the host libm.

**Math transcendental slice landed (2026-09-01).** Vendored fdlibm now backs the remaining
transcendental wrappers, while `hypot` uses V8-compatible scaled binary arithmetic and `Math.random`
uses the determinism carve-out with a range/distribution proof. The new `tests/golden/ts/math_transcendental.ts`
fixture matches Node byte-for-byte. Dashboard coverage is **Math 42/42**, with `Math.random` carved
out as nondeterministic (overall **152/196** deterministic surface members). Full Phase 4 remains
open for Object, Date, console, and RegExp array-properties.
**String slice landed (2026-08-30).** 20 `String.prototype` methods (`charAt charCodeAt indexOf lastIndexOf includes startsWith endsWith slice substring split replace replaceAll repeat padStart padEnd trim trimStart trimEnd toLowerCase toUpperCase`) as one `StringOp` HIR node driven by the `STRING_OPS` table in `src/hir/nodes.ts` — the gate, the lowering, the verifier (`STA4081`), and the emitter (mechanical camelCase→`jsrt_string_snake_case` name derivation) all read the same table. Omitted optional arguments are padded with `undefined` literals at lowering (ECMA-262 treats explicit `undefined` as absent for every op in the set). `replace`/`replaceAll` implement GetSubstitution for plain-string patterns; `repeat`'s RangeError and non-ASCII case mapping raise `STA2005` at run time rather than answer wrongly (plan-notes 82). Remaining: `JSON`, `Array.prototype`, `Object`, `console` beyond `log`.
**Array slice landed (2026-08-30).** 13 non-callback `Array.prototype` methods (`push pop shift unshift at indexOf lastIndexOf includes join slice concat reverse fill`) as one `ArrayOp` HIR node on the `ARRAY_OPS` table discipline (verifier `STA4082`; `join` lives in `jsrt_print.c` with the ToString machinery, the rest in `runtime/src/jsrt_array_ops.c`; shared index conversions extracted to `jsrt_index_util.h`). `includes` is SameValueZero (finds NaN), `indexOf` strict (cannot) — the spec's asymmetry, golden-tested. `lastIndexOf` lands without its position argument because explicit `undefined` ≠ absent there (plan-notes 83). Deferred: every callback-taking method — they need a runtime→compiled-code call protocol. Remaining now: `JSON`, `Object`, `console` beyond `log`, and the callback protocol.
**console slice landed (2026-08-30).** `info`/`debug`/`warn`/`error` join `log` as the same single HIR node with a `stderr` flag — the one fact the emitter needs. `warn`/`error` map to `jsrt_eprint` (stderr, `log`'s exact formatting), and the golden runner now compares BOTH streams byte-for-byte, so the stream split is held to Node's rather than asserted (plan-notes 84). The rest of console stays deferred by the member path. Remaining now: `JSON`, `Object`, and the callback protocol.
**Object slice landed (2026-08-30).** `Object.keys`/`values`/`entries` as one `ObjectStaticCall` HIR node (namespace call, MathCall-style; verifier `STA4083`, runtime contract `STA4084`) over one runtime walk in `runtime/src/jsrt_object_ops.c` covering both object layouts: fixed shapes enumerate their class descriptor's field list, dynamic shapes their shape chain — declaration order and insertion order respectively, both the spec's enumeration order since identifier keys never trigger the integer-first reorder. `entries` yields `[string, T]` pairs the HType model cannot spell (no tuple), so its element is Unknown and the verdict honestly reports `dynamic` (plan-notes 85). Remaining now: `JSON` and the callback protocol.
**JSON slice landed (2026-08-30), stringify only.** `JSON.stringify(v)` single-argument form as a `JsonStringify` HIR node (namespace call, ObjectStaticCall-shaped, pinned `string` — verifier `STA4085`) over one recursive runtime walk (`jsrt_json_stringify` in `jsrt_print.c`, reusing the Object.entries walk for both object layouts and `format_double` with `-0` spelled `"0"`). Escaping is well-formed `JSON.stringify`: short escapes, `\u00XX` controls, lone surrogates as `\udXXX`, UTF-8 for everything else. The gate refuses top-level argument types admitting `undefined`/functions (the spec answers `undefined` there against the node's `string`); inside structures both serialize per spec, and cycles abort loudly on the STA2005 pattern (spec throws TypeError, which builtins cannot raise yet). Deferred: replacer/space forms, and `JSON.parse` — parse returns `any` (STA1003 in ts mode before the gate speaks) and needs the untyped-result story (plan-notes 86). Remaining now: the callback protocol.
**Callback methods landed (2026-08-30).** `forEach map filter some every find findIndex` joined `ARRAY_OPS` — no new protocol was needed: the runtime calls the compiled callback through `jsrt_call`, the SAME closure ABI every compiled call site already dispatches through, passing the spec's `(element, index, array)` triple, caching `length` at entry, and coercing predicate answers through `jsrt_truthy`. Two result kinds joined the table: `mapped` (the checker's answer — `map`'s element is the callback's to choose, and a type-guard `filter` narrows below the receiver; verifier pins only "some array") and `undefined` (`forEach`). The gate holds the single argument to a function type (an `any` callback in js mode defers rather than reaching `jsrt_call` unvetted) and defers the thisArg form. `reduce`/`reduceRight` followed in their WITH-initial form (result kind `checker` — nothing pinned; the zero-initial form is deferred because an explicit `undefined` initial IS an initial, plan-notes 88). `sort` closed the family out (plan-notes 89): a stable merge — stability is normative, so no qsort — whose scratch is a real jsrt array (a collector must see elements mid-merge); absent and explicit-`undefined` comparators both mean the ToString default, so the padding rule holds. The structural quartet `flat`/`flatMap`/`splice`/`copyWithin` followed (plan-notes 90): `splice` in its exact two-argument form only (its one-argument form deletes to the end — the `lastIndexOf` padding trap — and insertion is variadic); the other three pad safely. The find-last pair, the ES2023 `toX` copies, `toString` (= `join`), and `with` (out-of-range aborts, STA2005 pattern) closed the surface to 34/37 — the residue is exactly the three iterator methods, which wait on an iteration protocol (plan-notes 91 records the `Object.hasOwn` bug this slice surfaced: a bare `in` test against the op tables found `toString`/`valueOf`/`constructor` on the PROTOTYPE CHAIN). Task 4.2's remaining surface: `Math` transcendentals (fdlibm question), `String` regex-adjacent methods (Task 4.3), `reduce`/`sort`/`splice`/`flat`, `JSON.parse`, remaining `Object`/`console` members.
**Math bit-exact trio landed (2026-08-30).** `clz32`/`imul`/`fround` joined `MATH_METHODS`: each is exactly specified (leading zeros of ToUint32; int32 wrap-around multiply, computed unsigned so the overflow is defined C; a round-trip through IEEE single precision), so the fdlibm question that holds back the transcendentals does not arise. Math now 21/43; the remainder is the approximated set (`sin`, `log`, `exp`, …, and `random`), all waiting on the fdlibm vendoring decision plus a seeding story for `random`.
**String addendum (2026-08-30).** `at`/`codePointAt` (result kind `element` — honestly Unknown, they answer `undefined` out of range; `codePointAt` combines surrogate pairs), `concat` (exactly one argument; its mechanical C name IS `jsrt_string_concat`, the `+` primitive — zero new runtime code), and identity `toString`/`valueOf` close `String.prototype` to 25/32; the residue is `normalize`/`localeCompare` (Unicode/Intl tables) and the regex-shaped set (Task 4.3). Landing `valueOf` as a table entry retargeted the hasOwn regression test at `hasOwnProperty`.

**JSON.parse landed (2026-08-30), completing the namespace.** `JSON.parse(text)` single-argument form as a `JsonParse` HIR node — the same one-argument-one-slot namespace shape as `JsonStringify`, and its exact opposite in the verifier: nothing is pinned, because the result is data the checker cannot see into. The lowering types it **Unknown**, so `explain` reports the call as the point where a program becomes dynamic and Task 3.5's boundary machinery (`typeof` narrowing, an `as` cast, `jsrt_check_*`) is what settles each use. In ts mode that means the ANNOTATED spelling — `const v: unknown = JSON.parse(t)`; unannotated, the lib's `any` return trips STA1003 at the declaration before the gate speaks, which the subset fixtures record as the honest verdict for that spelling. The runtime parser (`runtime/src/jsrt_json.c`) is recursive descent over the text's UTF-16 code units, building dynamic-shape objects through `jsrt_set_prop` (so duplicate keys resolve exactly as the shape table already resolves them — last value, first position) and real jsrt arrays, with `strtod` on the ASCII the number grammar admitted. Four conditions abort loudly on the STA2005 pattern rather than answer wrongly: malformed text, a key containing U+0000 (shape keys are C strings), nesting past 512 (a stack fault is a crash, not a diagnostic), and a non-string reaching the call at run time — the gate ACCEPTS an untyped argument, which is the js-mode norm, and lets the runtime settle the tag. The reviver form is deferred: it runs user code at every node of the result. Coverage: **93/145 (64%)**, `JSON` at 2/2. Task 4.2's remaining surface: `Math` transcendentals (fdlibm question) and `Math.random` (needs a determinism story), the `String` regex-adjacent methods (Task 4.3), the three `Array` iterator methods (iteration protocol), and the remaining `Object`/`console` members.

**Object namespace addendum (2026-08-30).** `getOwnPropertyNames`, `hasOwn` and `fromEntries` joined the namespace, taking `Object` to 6/13 and the dashboard to **96/145 (66%)**. `getOwnPropertyNames` IS the `keys` walk for every object the subset can build — both layouts hold only string-keyed, enumerable own properties, so the entry points diverge only once non-enumerable properties become expressible. `hasOwn` asks the shape chain (or the class descriptor) directly: neither layout has a prototype the subset can reach, so “own” needs no second question. `fromEntries` is the walkers' mirror — it takes the ARRAY of pairs and BUILDS a dynamic shape, so its result is Unknown and its verdict `dynamic`, and duplicate keys resolve the way the shape table already resolves them (last value, first position). Two structural consequences: `ObjectStaticCall` now carries an argument LIST (arity fixed per method by the gate's `OBJECT_STATICS` table, restated in the verifier's `OBJECT_STATIC_SHAPES` with result kinds in the collection-table idiom), and its emit merged into `MathCall`'s N-argument case, the shape it now shares. A JS string becomes a shape key in ONE place — `jsrt_shape_key` in `jsrt_shape.c`, the immortal UTF-8 copy the shape table's own lifetime rule demands — which `JSON.parse` and `fromEntries` both call. Still deferred, each for a reason: `assign` mutates a target a fixed shape cannot accept and is variadic; `freeze`/`isFrozen` need a frozen bit every write site would consult; `create`/`defineProperty`/`getPrototypeOf`/`setPrototypeOf` are prototype machinery ts mode bans by design.

**console namespace addendum (2026-08-30).** `dir`, `group`, `groupEnd`, `count`, `countReset` and `assert` joined `log`/`info`/`debug`/`warn`/`error`, taking `console` to 11/15 and the dashboard to **102/145 (70%)**. The slice replaced `ConsoleLogCall`'s `stderr` boolean with a `method` name and one table, `CONSOLE_METHODS` in `src/hir/nodes.ts`, that the gate, the lowering, the verifier (`STA4019` now covers arity as well as void-ness) and the emitter all read — the `ARRAY_OPS`/`STRING_OPS` discipline applied to a namespace whose members differ in arity rather than in receiver. Each entry gives an arity, a count of OPTIONAL trailing arguments, the C entry point, and — for the two members that need it — a second entry point for the short form. That second name is the slice's one real finding: the padding rule (`STRING_OPS` pads, `lastIndexOf` cannot, plan-notes 83) splits console down the middle. `count()` and `count(undefined)` both tally under `default`, so `count` pads; but Node prints `console.group(undefined)` as `undefined` and `console.assert(c, undefined)` as `Assertion failed undefined` where the omitted forms print nothing, so padding those would print nothing for source a program can legally write. They get `jsrt_console_group_bare`/`jsrt_console_assert_bare` instead — the third answer to the `lastIndexOf` question, available because the runtime function is ours to split — and `consoleEntryPoint` is the one place a width maps to a call, asked by the verifier and the emitter alike (plan-notes 94). Three runtime facts are Node's, held byte-for-byte on both streams: `dir` is `log`'s formatting WITHOUT its top-level-string exception, so `console.dir("a")` prints `'a'`; `group`/`groupEnd` keep an indent that prefixes EVERY line of a multi-line inspect and an unmatched `groupEnd` is a no-op; `count` tallies per label and prints `label: n`. Deferred, and for a reason that will not change: `time`/`timeEnd` print an elapsed DURATION and `trace` a stack, neither of which a golden test can hold to Node byte-for-byte, and `table` is a column-layout algorithm of its own. Task 4.2's remaining surface: `Math` transcendentals (fdlibm question) and `Math.random` (determinism story), `String.prototype` `normalize`/`localeCompare` (Unicode/Intl) and the regex-shaped set (Task 4.3), the three `Array` iterator methods (iteration protocol), and the `Object` prototype/mutation residue.

**Map/Set joined the dashboard (2026-08-30).** Task 4.2 names `Map` and `Set` among the builtins it covers, and both landed back at rung 7 with `tests/golden/{ts,js}/maps.*` — but neither was a namespace in `tests/golden/builtins_coverage.json`, so the dashboard was reporting a percentage of a surface that silently excluded them. Adding `Map.prototype` (10 members) and `Set.prototype` (16) moves the number from 102/145 (70%) to **113/171 (66%)**: the coverage did not fall, the denominator got honest. `Map` is 6/10 and `Set` 5/16; the shared gap is the iteration quartet (`entries`/`forEach`/`keys`/`values`), which is the same iteration-protocol blocker the three `Array` iterator methods wait on, and `Set`'s remainder is the ES2025 set operations. Adding them required one fix to the renderer: a `.prototype` member was matched by CALL syntax (`.trim(`), which no property can satisfy, so `size` would have been unverifiable — the needle is now access syntax not followed by an identifier character, which checks a property and still keeps `.trim` from matching inside `.trimStart` (plan-notes 95).

**A throwing callback was neither stopping nor propagating (2026-08-30).** Landing the `Array.prototype` callback family (`forEach`/`map`/`filter`/`some`/`every`/`find*`/`reduce*`/`sort`/`flatMap`) left both halves of the exception protocol unwired, and a golden fixture that throws from inside a callback found it: `[1,2,3].forEach(cb)` where `cb` throws on the second element printed all THREE elements and the surrounding `catch` never ran. The runtime kept walking because its loop guards asked only about the length, and the emitter never checked `jsrt_pending()` after the op, so the pending exception was dropped on the floor — the program silently continued past a `throw`. Both halves are now closed: `ARRAY_OPS` entries carry `calls: true` (the 13 ops that call back into compiled code), the runtime's walks share one `walking()` guard that includes `!jsrt_pending()`, and the emitter gives a `calls` op its own statement plus the pending check that `call`, `new` and `method-call` already emitted. Getters were checked and were never affected — they lower to a method call, which had the check all along. The regression is pinned in both `array_callbacks` fixtures, which now cover a throwing callback, predicate, comparator and reducer (plan-notes 96).

**Map/Set `forEach` landed (2026-08-30).** The one member of the deferred iteration group that was never an iteration-protocol question: `forEach` takes a CALLBACK, and the runtime calls it through `jsrt_call` exactly as the `Array.prototype` callback ops do — so it needed no protocol the subset lacks, and it joined `COLLECTION_OPS` with the same rules those follow (function-typed callback required, thisArg form deferred, its own emitted statement plus a pending check so a throwing callback reaches its landing pad). It passes the spec's `(value, key, collection)` triple — for a Set the value IS the key — and sees mutation during the walk the way the spec requires. That last requirement is what the slice actually cost: the table's `grow()` COMPACTS dead entries away, which renumbers every live one, and a walk holds an index — so a `delete` that triggers a growth mid-walk would silently skip or repeat entries. `JSRTMap` gained an `iterating` depth counter that suppresses compaction (not growth) while any walk is in flight; it is initialised in `map_new` and deliberately NOT in `map_reset`, because `clear()` resets through that path and a clear called from inside a `forEach` must not re-enable compaction under the walk that called it. Both `maps` fixtures now cover the triple, short callbacks, delete-and-reinsert order, mutation and growth during the walk, `clear()` during the walk, nested walks, and a throwing callback. Dashboard: 113/171 → **115/171 (67%)**; the residue of the group is exactly the iterator quartet (plan-notes 97). The slice also surfaced a rung-7 bug the table could not have shown before it: a key inserted as `-0` was STORED as -0, because SameValueZero governs comparison and the spec's normalization (§24.1.3.9 step 6, §24.2.3.1 step 4) happens at the INSERT. No read path could tell — every one of them went back through SameValueZero — until `forEach` handed the key to user code and `1 / k` answered -Infinity. One guard in `map_put` closes it (plan-notes 98).

**The ES2025 set operations landed (2026-08-30).** `union` `intersection` `difference` `symmetricDifference` `isSubsetOf` `isSupersetOf` `isDisjointFrom` joined `COLLECTION_OPS`, taking `Set.prototype` from 6/16 to 13/16 and the dashboard from 115/171 to **122/171 (71%)**; the residue is the iterator trio. They are the only operations in the subset whose ARGUMENT is a collection, which is what the slice is really about: the runtime reads it as a `JSRTMap`, so a wrong argument is memory corruption rather than a wrong answer, and neither the arity check nor the receiver check would catch it — hence a `SET_OPS` table in `src/hir/nodes.ts` that the gate, the verifier and the emitter all read, and a verifier check on the argument's type kind and the result's. The spec's set-LIKE argument (any object with a `size`, a `has` and a `keys`) is refused: reading one means calling its `keys()` iterator, the protocol the trio waits on. Result ORDER is normative and is not always the receiver's — `intersection` walks whichever collection is smaller and answers in that one's order — so the fixtures pin every combination's order against Node rather than treating it as an implementation detail (plan-notes 100). The slice also raised the lib the compiler hands USER SOURCE from es2023 to es2025: the lib describes the JavaScript the differential ground truth implements, not the subset Stator has landed, because the gate is what states the subset and `STA1214` names the delivering phase — where too low a lib produced a type error telling the user to change a `lib` option they do not own (plan-notes 99).

**RegExp data properties landed (2026-09-01), closing everything this phase owns on
`RegExp.prototype`.** The eleven properties of §22.2.6 plus `toString`, on a `REGEXP_FIELDS` table
beside the `REGEXP_OPS` method table — two closed tables rather than one, because `toString` and
`source` are both arity 0 and a single table could not tell the call from the read without a `form`
discriminant, which is two tables wearing one name. Every property is DERIVED, so nothing became
state the compiler has to keep in step: `source` and `flags` are two strings on `JSRTRegExp`,
`lastIndex` is a header field, and the eight flag predicates are one bit test against `lre_flags`
each — passed the flag's LETTER, because the `LRE_FLAG_*` constants belong to the vendored engine's
header and generated C does not include it. One HIR node (`regexp-read`) and one verifier code
(**STA4090**), the `MatchRead` shape with the receiver pinned the other way: a regexp is concretely
typed, so the verifier pins the receiver as it does a `RegExpOp`'s, where a match read must pin it
Unknown. The slice found a live output bug: `re->flags` stored the flag string AS WRITTEN, while
§22.2.6.4 orders it `d g i m s u v y` and Node normalizes everywhere — `console.log(/a/ig)` prints
`/a/gi`. Fixed at the single place that can fix it, `jsrt_regexp_new`, so `flags`, `toString` and
`inspect` read one normalized string and cannot drift. Three members deliberately stay out, each
for a different reason (plan-notes 121): `lastIndex` as a WRITE (an assignment target, which the
assignment gate admits only for a field of a class — refused by name rather than lowered into a
store), `unicodeSets` (declared in lib.es2024, unreachable while `tsconfig.json` pins
`lib: ["es2023"]`), and `compile` (Annex B §B.2.4 legacy with an optional second argument a
fixed-arity table cannot express). Dashboard: `RegExp.prototype` 2/15 → **13/15**, total
154/196 → **165/196**.

**`Date` slice A landed (2026-09-01) — the TZ-independent core.** Plan §7 Task 4.2's Date steps
1-7. A Date is one `double` on the heap behind a `jsrt_class_date` descriptor (`docs/VALUE.md`
§4.11) — the `JSRTRegExp` layout with a number where the pattern strings were, so it prefix-shares
`const JSRTClass *cls` with `JSRTObject`, adds no GC edges, and `jsrt_is_date` is a pointer
comparison. Three HIR nodes on the closed-table discipline: `DateOp` over `DATE_OPS` (22 members),
`DateStaticCall` over `DATE_STATICS` (`UTC`, `parse`, `now`), and `DateNew`, with verifier code
**STA4092** and runtime contract **STA4093**. `DATE_OPS` writes each C name out explicitly rather
than deriving it, because the mechanical camelCase→snake_case rule the string ops use turns
`getUTCFullYear` into `get_u_t_c_full_year`.

The landed surface: `new Date(ms | isoString | date)` and `new Date()`; `getTime`/`valueOf`/
`setTime`; the 8 `getUTC*` getters; the 7 `setUTC*` setters; `toISOString`/`toJSON`/`toUTCString`;
`Date.UTC` (1-7 args, spec defaults filled at lower time so the runtime entry stays fixed-arity);
ISO-only `Date.parse`; `Date.now`. Calendar arithmetic is Hinnant's `days_from_civil`/
`civil_from_days` over the proleptic Gregorian calendar §21.4.1 defines, validated against Node by
its own runtime corpus (`runtime/tests/print_dates.{c,mjs}`) BEFORE the compiler was touched — pre-
epoch flooring, the 1900/2000 leap exceptions, TimeClip at ±8.64e15, expanded ±6-digit years,
rolling setters, §21.4.4.21's Invalid-Date recovery for `setUTCFullYear` alone, and `toJSON`'s
`null`.

`new Date()` needed no node of its own: §21.4.2.1 step 2 defines it as the current time value, so
the lowering desugars it to `new Date(Date.now())`, which keeps `date-new` in the four switch arms
it shares with `json-parse` and costs the HIR nothing. It is a desugaring and not padding because
`new Date(undefined)` is an Invalid Date — an absent argument and an explicit `undefined` are
different programs. `Date.now` and the zero-argument constructor are ACCEPTED rather than deferred:
nondeterminism is a proof problem, not an acceptance problem, and they prove through the
determinism carve-out (`tests/unit/date-clock.test.ts` — wall-clock era, whole milliseconds,
monotonicity, real advance across ~3M iterations, and the desugaring bracketed by two readings of
the same clock).

Three documented ceilings, each recorded rather than worked around: `Date.parse` is ISO-only (Node's
non-ISO heuristics are TZ-dependent and implementation-defined, so a golden over one would pin this
machine); `toISOString` on an Invalid Date aborts where §21.4.4.36 throws a `RangeError`, the
`Object.freeze` ceiling exactly, until Phase 5 step 11; and `toJSON` answers `null` for an Invalid
Date though `lib.es5.d.ts` declares it `(): string` — §21.4.4.37 and Node both say `null`, which is
what makes `JSON.stringify(new Date(NaN))` the string `"null"`. `STA1210` became a RESIDUE code
(the `STA1211` shape) naming one member at a time: slice B (local time, blocked on the golden
runner's `TZ` pin) and the `toString`/`toLocale*` family (ICU CLDR data). Full record and the four
places the tree corrected the plan's steps: plan-notes 132. Dashboard: `Date` **3/3** (2 + 1
carved), `Date.prototype` **21/43**, total 165/196 → **190/239 (79%)**.

**Task 4.2 — `Date` slice B landed (2026-09-01).** The local-time half, plus `toDateString`. The
whole slice rests on one identity, §21.4.1.7's `LocalTime(t) = t + LocalTZA(t)`, with the offset
read from libc `localtime_r` at call time — the runtime carries no zone rules of its own and caches
nothing about the host zone in the object, so `tm_gmtoff` is the only tzdb question it asks. The 8
local getters were generated from the existing `DATE_GETTER` macro by adding one `local` flag to it
rather than hand-writing eight near-copies, and the 14 setters (7 UTC + 7 local) were collapsed the
same way into four shape macros over `set_fields(…, bool local)` — written out by hand that is
~120 lines in which the two halves could silently drift, and it would have breached the 1%
duplication gate besides.

The one thing that is genuinely hard here is the INVERSE. `local_time` is a function; its inverse
is not, because a wall-clock reading inside a DST gap names no instant and one inside a fold names
two. The first implementation used a single probe (`offset_at(local)`, correct once, then retry)
and got the fold wrong: on 2024-10-27 in Berlin, 02:30 local happens at 00:30Z under CEST and again
at 01:30Z under CET, and Node answers the first. §21.4.1.26 says why — both the gap and the fold
resolve to the offset in effect BEFORE the transition, which for the fold is the earlier instant.
The fix probes the offset one day either side (the spec's own window: its `before` is `t - 1 day`),
builds both candidate instants, and takes the first whose own offset validates it; when neither
does — the gap — the pre-transition offset settles it. Verified against the pinned Node in seven
zones covering DST both hemispheres, a 45-minute offset and a no-DST half-hour zone
(`UTC`, `Europe/Berlin`, `America/New_York`, `Australia/Lord_Howe`, `Asia/Kolkata`,
`Pacific/Chatham`, `America/Sao_Paulo`): byte-identical in all seven.

**The proof split is the point of the slice.** The golden runner now pins `TZ=UTC` via one
`PINNED_ENV` on all three `spawnSync` calls — the compiled binary AND the Node ground truth. UTC is
chosen deliberately over a zone that would make the fixtures distinguish local from UTC: the binary
reads the tzdb through libc while Node reads it through ICU, and for any real zone a tzdata skew
between the two surfaces as a byte diff that looks exactly like a semantics bug and is not. Under
that pin `tests/golden/{ts,js}/date_local.{ts,js}` prove the wiring end to end and the calendar
arithmetic, and every zone-dependent claim moves to `tests/unit/date-local.test.ts`, which names its
own `TZ` per case (Berlin for DST, Kolkata for the half-hour control) and asserts against dates
whose rules have been settled since 1996. `compileAndRunStreams`/`compileAndRunLines` gained an
optional `tz` that pins the RUN only; the build reads no clock and no tzdb.

`new Date(y, m, …)` became its own HIR node, `date-components`, rather than a discriminant on
`DateNew`: the two have different shapes (one value versus seven padded components), and a
`form` flag would have forced `arg` optional across five shared switch arms that all destructure it.
As a separate node it joined the existing N-argument family beside `date-static` and cost one arm
each in the verifier, the rewriter, `explain`, and the two emitter passes.

**Two things the tree corrected in the plan** (plan-notes 133). First, `toDateString` was listed
with the ICU family in `SUBSET.md`, `DIAGNOSTICS.md` and the exit criterion — wrongly: its output is
`Mon Jul 15 2024`, with no zone name in it, so it landed here. Its siblings `toString` and
`toTimeString` genuinely are ICU-blocked, and now for a MEASURED reason rather than an assumed one:
Node prints `(Central European Summer Time)` where libc's `%Z` gives `CEST`. Second, slice A's
`toUTCString` padded a negative year to six digits on the strength of a comment that no fixture
contradicted; Node pads it to four (`Fri, 01 Jan -0001 00:00:00 GMT`) and only `toISOString`'s
expanded-year form uses six. The new fixture has a negative year in it, which is how this surfaced.

Residue under `STA1210` is now exactly five members, all ICU-dependent: `toString`, `toTimeString`
and the three `toLocale*`, plus the call form `Date()`. Nothing time-zone-dependent remains, which
is what Date step 9 asked for. Dashboard: **207/238 (87%) +5 nondeterministic**, `Date` 3/3,
`Date.prototype` **38/43**.

### Task 4.3 — RegExp

**Task 4.3 landed (2026-08-30).** `libregexp` (+ `libunicode`, `cutils`) is vendored from quickjs-ng `v0.16.2` into `runtime/vendor/quickjs-ng/`, recorded in its own `VENDOR.md`, and compiled with `-Wall` alone rather than this repo's `-Wall -Wextra -Werror`: upstream code is not ours to fix, and a warning flag is not a correctness flag (plan-notes 101). The engine asks its embedder for exactly three functions — an allocator, a stack-depth question and a timeout question — and `runtime/src/jsrt_regexp.c` is the whole bridge. Two facts about that bridge were read out of the engine rather than assumed: `lre_compile` takes UTF-8, or CESU-8 when the pattern is not a unicode one (a lone surrogate is legal in a non-unicode pattern and has no UTF-8 encoding), and the capture array must be sized by `lre_get_alloc_count`, NOT by twice the capture count — the executor spills its own registers into the same array, and upstream's comment records the heap overflow that taught it. The subject needs no conversion at all: our strings ARE UTF-16 code units, which is `cbuf_type` 1, and the engine promotes that to 2 by itself for a unicode pattern. Above the C boundary, `RegExpLiteral` and `RegExpOp` joined the HIR on the `StringOp` table discipline (`REGEXP_OPS`, verifier `STA4086`): the pattern and the flags travel as TEXT, so nothing in this compiler parses them and nothing in it can disagree with the engine, and the literal is compiled at EVERY evaluation rather than hoisted — §22.2.4.1 makes each evaluation a fresh object, and it has to be, because `lastIndex` is mutable state on it (plan-notes 102). `test` is the landed surface; `exec` and the non-global `match` stay under `STA1211` because they answer an array WITH properties and a jsrt array is dense with no property table, and `new RegExp(...)` stays deferred because a pattern that is not in the source is a pattern the compiler cannot see. Dashboard: **123/186 (66%)**, `RegExp.prototype` at 1/15 — the denominator grew by the whole prototype, which is the dashboard's rule (plan-notes 95). Next on this task's own ground: the RegExp-taking `String.prototype` methods.

**Task 4.3, second slice (2026-08-30): the regexp-taking String methods.** `search` joined `STRING_OPS`, and `split`/`replace`/`replaceAll` gained their regexp forms — as the SAME op node, not new ones: the runtime dispatches on the pattern's TAG, because a regexp pattern is a scan and a string one is a substring search, and nothing above the C boundary needs to know which. The algorithms live in `jsrt_regexp.c` rather than `jsrt_string_ops.c` because all three are the engine's: one `scan()` collects every match's group offsets in a single pass, and search/split/replace are three readings of that list. Three spec details were settled against Node rather than guessed (plan-notes 103): `@@split`'s loop runs `while q < size`, so a match starting AT the end of the subject is never attempted — which is the whole reason `'abc'.split(/(?:)/)` is three elements and not four, and the golden fixture caught the fourth; `@@split`'s splitter is STICKY, so a failed attempt retries one position later rather than ending the scan, which is the one place the two loops the spec writes actually differ; and `$n` substitution caps at the pattern's group count, so `$1` in a groupless pattern stays literal. `search` never leaves `lastIndex` behind (§22.2.5.9 saves and restores it) while `replace` follows RegExpBuiltinExec's rule — a cursor is read and written only by a `/g` or `/y` pattern. `replaceAll` with a non-global pattern aborts loudly (the spec throws TypeError). Deferred, with a shared reason: `match`/`matchAll` answer an array WITH properties, `exec`'s blocker, and a replacer FUNCTION runs user code per match. Dashboard: **124/186 (67%)**, `String.prototype` at 26/32.

**Task 4.3, third slice (2026-08-30): libunicode pays a debt.** Vendoring libregexp brought libunicode with it, and the tables it needs for case folding are the same ones `toUpperCase`, `toLowerCase` and `normalize` need. Until now case mapping above ASCII ABORTED (`STA2005`) rather than answer wrongly — an honest placeholder for legal source, and one this slice retires. `runtime/src/jsrt_unicode.c` is the bridge, and it works in code POINTS rather than code units, because neither operation can be expressed as a per-unit walk: one code point can map to three (`ß` → `SS`, `ﬃ` → `FFI`), an astral character is one code point across two units, and `normalize` reorders and composes. The one context-dependent rule ECMA-262 keeps came with it — Final_Sigma, where `Σ` lowercases to `ς` at the end of a word and to `σ` inside one — implemented on `lre_is_cased`/`lre_is_case_ignorable`, which is the only reason libunicode exports them (plan-notes 104). `normalize` joined `STRING_OPS` at arity 1: an absent form means NFC, so the padding rule holds for one more op, and a form that is not one of the four aborts loudly (the spec throws RangeError). An ASCII string still takes the old per-unit path — it cannot change shape, so decoding it would buy nothing. Dashboard: **125/186 (67%)**, `String.prototype` at 27/32, and the residue is now exactly two families: `match`/`matchAll` (an array with properties, `exec`'s blocker) and `localeCompare`/`toLocale*`, which are collation and TAILORED casing rather than Unicode's own tables — Task 4.4's question, handed to it cleanly.

### Task 4.4 — Intl/ICU

**Task 4.4 landed (2026-08-30).** The three members `String.prototype` was still missing for a reason that was not scheduling: `localeCompare`, `toLocaleUpperCase` and `toLocaleLowerCase`. Unicode's own tables — the ones Task 4.3's third slice vendored — cannot answer either question. Collation is a per-locale ORDER (`'ä'` is an A with an accent in German and a letter after Z in Swedish) and tailored casing a per-locale EXCEPTION to the default mapping (`'i'` uppercases to `'İ'` in Turkish); both are CLDR data. They joined `STRING_OPS` like every other op, so the gate, the lowering, the verifier and the emitter needed no case of their own — the whole task is a build flag, a gate rule, and `runtime/src/jsrt_intl.c` over `ucol_strcoll`/`u_strToUpper`/`u_strToLower`. Three decisions carry it: the ICU objects live in their OWN directory, because `make` can see a stale timestamp but never a stale `-DJSRT_HAVE_ICU`; the link flags are written next to the archive by the build that produced it and read back by the CLI, so the two cannot disagree about which ICU this is; and the locale argument is REQUIRED even with the flag on, because the spec's absent-locales form reads the host's default and a compiled program whose output depends on the machine that runs it is not one this repo can golden-test. Without the flag the gate refuses all three under the new **STA1215**, which names the flag rather than a phase. `pnpm run ci` stays ICU-free and green (79 golden fixtures); `pnpm run test:intl` builds the feature runtime and runs 81, the two extra being `intl_locale.{ts,js}` — Turkish casing, Swedish and German collation, and Greek final sigma, all byte-for-byte against the pinned Node, which bundles the same ICU 78.3 / Unicode 17.0. Dashboard: **128/186 (69%)**, `String.prototype` at 30/32, and its residue is now exactly `match`/`matchAll` — the array WITH properties that also blocks `exec`, and no longer a data question at all.

### Task 4.5 — GC hygiene tests

**Task 4.5 landed (2026-08-30).** Both halves, and each found something the other could not have.

The **leak test** (`tests/leak/`, `pnpm run test:leak`, in `ci`) compiles the 10M-object loop and samples the process's RSS from `ps` — not from a counter the runtime keeps, which would be the runtime grading its own homework. It asserts a PLATEAU, never a figure: a peak inside a bound no non-collecting run could meet, and a tail that does not keep climbing. Measured both ways on this machine: **3056 KB flat with Boehm, 284 MB and still rising without it**, so the 64 MB cap separates the outcomes by a factor of five. Running it at all required installing `bdw-gc`, and that instantly turned all 79 golden fixtures red — `src/cli/build.ts` had never passed `-lgc`, because no machine this repo had run on had Boehm and the fallback was the only path ever taken (plan-notes 106). The fix generalised Task 4.4's mechanism: every build now records its link flags next to the archive it produced, and the CLI reads them back for every flavour.

The **frame audit** (`tests/unit/frames.test.ts`) emits the C for every standalone golden fixture and holds each function to four invariants: no `JSRT_LOCAL(i)` outside its own frame (the one failure here that is memory corruption rather than waste), a frame exactly as large as the slots written into it, a globals frame exactly as large as the globals used, and a `JSRT_FRAME_POP()` on every path out — every `return` and the fallthrough. It failed on three over-allocations the moment it was written, all of them the counting pass reserving storage the emitter had a better home for: a CAPTURED local that already lived in the heap environment, an unconditional return slot in functions that never return a value, and a scratch slot claimed by `{}` for an entry it does not have (plan-notes 107). One reservation stays conservative and is counted as an allowance rather than pretended away: a `try`/`finally`'s exception stash, whose need is decided while emitting the try body, long after `JSRT_FRAME(n)` had to be final.

Neither test can see what the other sees. The audit proves the emitted C declares the slots it writes; only the leak test can tell a runtime that collects from one that never frees, because both print the same number.

Neither could see the third thing, and it was the one that mattered: **the collector could not see a single reference the runtime held.** Boehm is conservative — it retains what looks like a heap address — and a NaN-boxed `jsrt_value` never does, because the tag sits above bit 48. Every object reachable only through a boxed reference (a Map's entries, an array's elements, an object slot, a `JSRT_LOCAL`) was collectible while live; a probe holding a 200-entry Map across a forced collection SIGSEGV'd, and the reason no test had ever said so is that every fixture allocated too little to reach Boehm's first collection. `bdw-gc 8.2.12` predates `GC_set_pointer_mask`, so the fix unboxes explicitly at both places a reference hides, in the new `runtime/src/jsrt_gc.c`: a custom object kind whose mark procedure masks every word it scans, and a `GC_set_push_other_roots` walk of the `JSRT_FRAME` shadow stack — the first thing that has ever READ those frames. Consolidating all fourteen collected allocations behind one `jsrt_gc_alloc` is what makes "the whole heap" a fact rather than a hope (plan-notes 108). The same reasoning found a second invisible cell — `jsrt_throw`'s pending-exception mailbox, static storage holding the only reference to a value while the `finally` blocks on the way out allocate — whose rooting invariant jsrt_value.h had written down and nothing had implemented. `tests/golden/ts/gc_reachability.ts` is the standing check, and its heap half is provably not vacuous: with the hooks removed it is the suite's one failure, a SIGSEGV. Its unwind half is not — it passes with the exception root removed too, because at `-O2` the thrown value survives in a register the collector happens to scan, and plan-notes 108 says so rather than banking the coverage.

### Task 4.6 — `async`/`await` (generators deferred to Phase 5)

**Task 4.6 landed (2026-08-30), async half only.** `async`/`await` works; generators do not, and the two were split apart rather than shipped together, because the state machine is only half of what a generator needs — the other half is the iterator protocol, and a `yield` answers its caller where an `await` answers a scheduler. Generators keep their own subset rows and stay not-yet under **STA1201** — which now names **Phase 5** rather than the phase closing here, because what they still need is the iterator protocol, and that is the same blocker holding `for-of` and the `keys`/`values`/`entries` triple that `Array`/`Map`/`Set` are each missing. Four surfaces, one owner: Phase 5 step 8 (plan-notes 112).

The decision the whole task rests on: **a reaction is a native continuation** — a C function plus GC-allocated state — not a JS callback. An async function's resume point and `Promise.all`'s per-element handler are the same kind of thing, so one mechanism (`jsrt_promise_subscribe`) serves both and neither needs `.then` to exist. That is why the deferred list reads oddly: `Promise.resolve`/`reject`/`all` are implemented while `.then` is not. `.then` is not the foundation here, it is a future *client* of it — a reaction whose state is the JS handler and the derived promise — and what blocks it is that a handler's throw must become a rejection, which needs a runtime-level catch around user code (**STA1216**, Phase 5, along with `new Promise(executor)` for the same reason).

Two rules carry ordering, which is the part of a promise implementation that is easy to get subtly wrong and observable when you do: a reaction is always QUEUED and never run inline, even when the promise it subscribes to has already settled; and reactions run in registration order. `jsrt_await` subscribes to `jsrt_promise_resolve(operand)`, so awaiting a non-promise still costs exactly one tick — which is what makes an interleaving match Node's rather than merely finishing with the same answer. The event loop is `jsrt_run_microtasks()` and nothing more: no timers, no I/O, so no macrotask phase and no libuv.

In codegen an async unit is **two C functions**. The entry point keeps the closure ABI, builds the heap environment that outlives every suspension, and hands it to `jsrt_async_start`, which runs the body's prefix synchronously on the caller's stack (observable, and the difference between an async function and a callback). The resume function holds the body: each `await` parks a state number, subscribes, pops the frame and returns; each resumption rebuilds the frame and jumps to the suspension point. **Nothing lives in the C frame across a suspension** — every local of an async unit is addressed as `_jsrt_env->slots[i]` — and that is precisely what makes a `goto` into the middle of a loop or a `try` block correct rather than a hazard.

Unhandled rejections are counted at settle and checked **after** the drain, not at the rejection: a promise rejected now is routinely awaited by a continuation still sitting in the queue, and only an empty queue settles the question. The check then aborts with the `STA2005` pattern rather than swallowing, because matching Node's report byte-for-byte means an `Error` object with a stack this runtime does not build yet — and silently discarding a rejection is the one outcome that would be wrong without saying so.

Ground truth comes in a pair, `runtime/tests/print_promise.{c,mjs}`: the same promises, the same subscriptions, the same order, expressed as native continuations on one side and `.then` on the other. That is the only way this file can assert anything about ORDER — an implementation cannot check its own tick count against itself. The golden half is `{ts,js}/async_await.{ts,js}`: interleaved starts, a three-deep await chain, a throw in an async body caught by an awaiting `try`, and `Promise.all` proving input order survives out-of-order settling plus first-rejection-wins. The js fixture prints its `Promise.all` result whole rather than indexed, because without an annotation the checker calls it a tuple and indexing one is a property access the js tier does not have yet (STA1214) — the claim under test is order, and printing the array whole makes it.

Auditing the emitted diagnostics against `docs/DIAGNOSTICS.md` found four codes with no table row, and one of them was worse than missing: top-level await had been renumbered from the allocated **STA1208** to a fresh code, which the sole-allocator rule exists to prevent. Restored, and the Promise-callback code renumbered down to keep the band contiguous (plan-notes 110). Top-level await and `import()` moved from Phase 4 to Phase 7 in `docs/SUBSET.md`, where the module work actually lives. `pnpm run ci` is green end to end: 290 unit tests, 253 subset fixtures (188 passed, 65 expected-fail, 0 failed), 82 golden fixtures, the print corpus byte-for-byte against Node under both `-O2` and ASan/UBSan, and the leak test at 3072 KB of a 65536 KB cap. Dashboard: **131/197 (66%)** — down from 69%, because `Promise` and `Promise.prototype` joined the surface with their combinators empty, and a namespace that grows the denominator honestly is the point of the dashboard (plan-notes 95).

**Task 4.7 landed (2026-09-01).** Every not-yet phase pointer in `src/frontend/gate.ts` now names
the phase that owns its blocker, and a test fails the build if that ever stops being true.

**Step 1 rewrote the task.** The audit this task was written from counted **63** phase-4 sites by
grep. Parsing `gate.ts` with the `typescript` API instead — the tool the compiler already uses, so
a multi-line call, a template-literal message and a nested ternary each count exactly once — found
**165**, and the distribution was the finding: **70 of them named Phase 3, complete since
2026-08-30**. Not latent, either. `node src/cli/main.ts build /tmp/rest.ts` answered `rest
parameters are not yet supported; planned for Phase 3` — a shipped promise pointing at finished
work, in the compiler's default mode. The audit missed them because it asked *"which sites name
phase 4?"*, a question about the phase that happened to be open, while the rule the task itself
establishes implies the general one. Phase 3's ladder had deferred its surface under
`notYet(…, 3)` rung by rung — honest when written — and the residue outlived its owner. Full
evidence and root cause in plan-notes 136; the plan was edited in the same change (Task 4.7's
inventory table, §8 Phase 5 step 12, §15 rule 9).

**The reassignment, by group.** 70 phase-3 sites → **Phase 5 step 12**, the `ts`-mode static
language surface added to §8 to own them (parameters, destructuring, the class member surface,
generics beyond monomorphization, object-literal forms, `this`/`super`/`new` positions, bound
method values). 63 phase-4 sites → Phase 5 as well: the module surface, the builtin arity and
argument-shape refinements, and the method-as-value family are all lowering work, and Phase 4 owns
none of it now that its exit criterion is met. Three groups did NOT follow the majority, and each
is why the sweep had to be per-construct rather than a rename:

- **`Object`'s catch-all straddled two phases.** One number cannot be right for six unlanded
  members that wait on two mechanisms: `freeze`/`isFrozen`/`seal`/`isSealed` need a
  RUNTIME-RAISED exception (Phase 5 step 11's pending-cell extension), while
  `create`/`defineProperty`/`getPrototypeOf`/`setPrototypeOf` are `STA1204`'s prototype surface in
  Phase 8. `OBJECT_STATIC_OWNER` answers by member; the catch-all keeps 5 for the residue.
- **`STA1215` and the `Date` residue name a FLAG, not a phase.** `STA1215`'s own
  `DIAGNOSTICS.md` row already said its message names `make -C runtime intl` rather than a
  release — and the object still set `phase: 4`, so the day Phase 4 closed it would have promised
  a finished release. It now omits `phase` entirely, which is the no-phase sentinel
  (`src/support/phases.ts`), and `dateNotYet` gained the same split: `Date.prototype`'s member
  catch-all is now exactly the ICU family (`toString`/`toTimeString` and the three `toLocale*`)
  and carries no phase, while the arity and spread refusals under the same code are ordinary
  lowering work at Phase 5.
- **`STA1211` moved to Phase 8.** Everything under it has landed except `compile`, and `compile`
  is not a builtin Phase 4 declined to write: it is Annex B §B.2.4 legacy that RE-INITIALIZES an
  existing RegExp in place, which is the mutate-a-built-object surface Phase 8 owns with
  `STA1204`. `unicodeSets`, the other name the access-side catch-all would refuse, never reaches
  the gate — it is declared in lib.es2024 and `tsconfig.json` pins `lib: ["es2023"]`.

**The `Promise` code question the task raised resolves as "already split correctly".** Step 4 asked
whether the call-side `Promise` sites should move from `STA1214` to `STA1216`. They should not.
`STA1216`'s recorded blocker is *a throw crossing back out of a JS callback*, which is true of
`new Promise(executor)` and `Promise.prototype.then`/`catch`/`finally` and of nothing else. The
combinator residue (`allSettled`/`any`/`race`/`withResolvers`/`try`) takes promises, not callbacks;
it waits on being written, which is what `STA1214` means. Recorded rather than changed.

**The mechanism, which is the part that outlives the sweep.** `src/support/phases.ts` exports
`COMPLETED_PHASES` and documents the no-phase convention; `tests/unit/phases.test.ts` asks the
general question four ways, because each catches what the others cannot:

1. **Source scan** — parse every `.ts` file under `src/` and read every phase argument, in all
   three spellings: the `notYet`/`dateNotYet` helpers, the hand-written `{ kind: 'not-yet', ... }`
   literals, and `diagnosticFromNode`'s positional 7th argument. The only check that sees a site no
   fixture reaches, and most of the seventy were exactly that.
2. **Message scan** — a phase can also be WRITTEN into a string, where the numeric field never
   sees it (plan §7 Task 4.7 step 7 requires both). Comments discussing a finished phase are
   allowed; string literals are not.
3. **End to end** — compile three programs from three families and read what a user gets, so a
   phase that is right in the call and lost on the way to the terminal still fails.
4. **`COMPLETED_PHASES` against `done.md`** — this file is the authority and `phases.ts` is its
   projection, so marking a phase complete in one and not the other fails.

The guard was proved by breaking it: reverting one site to `notYet(…, 3)` fails tests 1 and 3 with
`gate.ts:1461 notYet(...) names Phase 3` and `rest parameters are not yet supported; planned for
Phase 3 — Phase 3 is complete`. A test that cannot fail is not a check.

**And the guard's first version had the defect it was built to catch.** It scanned `gate.ts` alone
— because that is where the 165 sites were — and `src/frontend/graph.ts` had been quietly naming
Phase 4 the whole time, for cross-file top-level name collisions, whose blocker is per-module
namespaces (Phase 5's module surface). Two things hid it: the file is not the gate, and the phase
travels as `diagnosticFromNode`'s **positional 7th argument** rather than through `notYet`, so
neither the helper-call arm nor the object-literal arm would have seen it even in the right file.
`SUBSET.md` had already been corrected to "Phase 5" in this same change, so code and doc were
disagreeing while every test passed. The scan now walks **every `.ts` file under `src/`** and reads
all three spellings, and the message scan walks the AST rather than the lines — a "quote somewhere
on this line" regex called three legitimate comments offenders, and comments SHOULD discuss
finished phases. Re-broken to confirm: `frontend/graph.ts (diagnosticFromNode(...)) line 120 names
Phase 4`. One place is never all the places, which is the entire lesson of this task, and it took
being learned twice.

**Docs synced in the same change**, the three surfaces that had already drifted apart once:
`DIAGNOSTICS.md`'s `STA1210`/`STA1211`/`STA1215` rows and the `STA1209` footnote; `SUBSET.md`'s
`STA1210`/`STA1211` reference rows, the eight `not-yet(STA1214, Phase 4)` module-surface verdicts,
the globals catch-all row, and the dynamic-`import()` row, whose prose ended "Phase 7." while its
own verdict column and the `STA1207` row below it both said Phase 5.

**Check — PASSED** (2026-09-01, `pnpm run ci` exit 0 on the pinned Node v26.7.0):

```
biome check          Checked 65 files. No fixes applied.
jscpd                58 clones · 0.8% duplication
node --test          ℹ tests 319   ℹ pass 319   ℹ fail 0
runtime              print corpus matches Node
subset               272 fixtures — 209 passed, 63 expected-fail, 0 failed
golden               93 fixtures — 93 passed, 0 failed
leak                 10M objects — peak RSS 3024 KB of a 65536 KB cap, 18 samples, plateau
ASan/UBSan           print corpus matches Node; golden 93 fixtures — 93 passed, 0 failed
```

The four clauses of the task's own Check, each answered: the completed-phase regression test
exists and passes (`tests/unit/phases.test.ts`, four tests, and it was proved able to FAIL);
`pnpm run test` and `pnpm run test:subset` are green with **no verdict flips** — the sweep changed
phase numbers, never codes, so no fixture's expectation moved; a parse of every file under `src/` finds
zero not-yets naming a phase `done.md` marks complete (the remaining distribution is Phase 5 and Phase
8 only, plus the two no-phase sites); and `DIAGNOSTICS.md` and `SUBSET.md` agree with `gate.ts` on
every touched code.

---

**Phase 4 EXIT — the criterion, bullet by bullet (2026-09-01).** The phase's Check
("runtime unit tests + ASan/UBSan clean + the leak test; builtins dashboard renders in CI; an async
golden test (`await` chain + `Promise.all`) matches Node") is one `pnpm run ci` away, and it passed
at exit 0. The exit CRITERION -- added mid-flight because a Check without a scope boundary made
"is Phase 4 done?" unanswerable, and let four not-yet codes name this phase as their deliverer
while it was closing (plan-notes 116) -- reads:

| bullet | dashboard | verdict |
|---|---|---|
| `Math` | 42/42 (100%) [+1 nondeterministic] | ✅ every deterministic member on fdlibm; `Math.random` on the carve-out proof |
| `Object` | 7/13 (54%) | ✅ `assign` was the only member Phase 4 owned. `freeze`/`isFrozen` need a runtime-RAISED exception (Phase 5 step 11); `create`/`defineProperty`/`getPrototypeOf`/`setPrototypeOf` are `STA1204`'s prototype surface (Phase 8) |
| `console` | 12/12 (100%) [+3 nondeterministic] | ✅ `table` landed as ordinary work; `time`/`timeEnd`/`trace` on the carve-out |
| `RegExp.prototype` | 13/15 (87%) | ✅ `compile` is Annex B in-place re-initialization (Phase 8); `unicodeSets` is unreachable under `lib: ["es2023"]` |
| `Date` | 2/2 + 38/43 | ✅ slices A and B; the five left are ICU string forms -- the feature build, a flag rather than a phase |

The dashboard counts MEMBERS, not blockers, which is why three of those five rows sit below 100%
and the phase still exits (plan-notes 125). Every residue names an owner, and as of Task 4.7 that
claim is machine-checked rather than asserted: `tests/unit/phases.test.ts` fails the build if any
not-yet anywhere under `src/` names a phase this file marks complete -- which, from this commit, includes
Phase 4 itself. `src/support/phases.ts` gained `4` in the same change, and the test's fourth case
pins the two together.

**Full evidence** (`pnpm run ci`, exit 0, Node v26.7.0):

```
biome check          Checked 65 files. No fixes applied.
jscpd                58 clones · 0.8% duplication
node --test          ℹ tests 319   ℹ pass 319   ℹ fail 0
runtime              print corpus matches Node
subset               272 fixtures — 209 passed, 63 expected-fail, 0 failed
golden               93 fixtures — 93 passed, 0 failed
builtins             207/238 surface members landed (87%), +5 nondeterministic
leak                 10M objects — peak RSS 3024 KB of a 65536 KB cap, 18 samples, plateau
ASan/UBSan           print corpus matches Node; golden 93 fixtures — 93 passed, 0 failed
```

**Next:** Phase 5 (§8) -- `js` mode, and the language surface Phases 3 and 4 deferred.

---

## Phase 5 — `js` mode, and the language surface Phases 3 and 4 deferred (in progress)

### Step 1 — provenance grades what the author wrote

Landed in `cf61473` (2026-09-01). The `inferred` grade was already in the tree; the step's remaining
work was the `explain --json` matrix and a spec correction: the grade answers what the author wrote,
not which file it lives in (plan-notes 140).

### Step 2 — Gate switches the diagnostic table by mode

**Step 2 landed (2026-09-02).** The same source now flips verdict by mode:

| construct | ts | js |
|---|---|---|
| `const x: any = 42` / `1 as any` | `STA1001` never | accepted, lowers to Unknown (`dynamic`) |
| `var x = 1` | `STA1104` never (untouched) | `STA1214` not-yet (lowering is step 3) |
| `.js` entry | `STA1002` never, message names `--mode=js` | accepted (already) |
| `eval(...)` / `globalThis.eval` / `const e = eval` | `STA1101` never | `STA1206` not-yet Phase 8 |
| `new Function` / `Function(...)` | `STA1103` never | `STA1206` not-yet Phase 8 |

Three codes that looked implemented were dead (plan-notes 141): `STA1002` because `allowJs` was
ts-off and tsc dropped the file as `STA0012`; `STA1101`/`STA1103`/`STA1206` because the eval check
required a missing symbol and eval has a lib declaration; `1 as any` because the un-annotated
binding fired `STA1003` first. `allowJs` is now on in both modes (`checkJs` stays js-only).
Indirect eval `(0, eval)("x")` is still the arbitrary-callee not-yet.

Tests: `tests/unit/gate.test.ts` (same-source any, as-any vs STA1003, eval/Function matrix,
STA1002 message), `tests/unit/cli.test.ts` (real `.js` file through `program.ts`, not the
in-memory host), subset fixtures `subset_eval_call_*`, `subset_new_function_*` (expected-fail
removed), `subset_js_file_ts.js`, `subset_as_any_*`.

### Step 2a — the `compilerOptions`, not just the diagnostic table

Step 2 switched *which diagnostics the gate emits* by mode; 2a audits *what Stator asks the checker
to enforce* against the same §1.2 contract — untyped code is never rejected. Task 6.1's first
corpus pass is what surfaced it: `noFallthroughCasesInSwitch` and `useUnknownInCatchVariables` were
refusing valid JavaScript in js mode (plan-notes 175), and both became `mode === 'ts'` there.

**The rule every landing below obeys.** The suppression is of the CODE and never of the OPTION.
`strictNullChecks: false` or `noUncheckedIndexedAccess: false` is program-wide, so in a mixed graph
it would strip null safety from the `.ts` half and delete the boundary checks §0.4 requires.
Leaving `T | undefined` in the type is the point: the union lowers to the dynamic path and the
check still happens at run time. `JS_MODE_RUNTIME_CODES` is therefore an **enumerated** set with a
reason per line, never a range — an operation no runtime could settle must stay a hard error.

**And the honest half of every number.** `passed` stayed at **2379** through all five landings. The
tests did not start passing; they stopped being refused by a *checker lint* and are now refused by
*Stator's own schedule*, landing in the skip column attributed to an `STA12xx`. That is what §1.3's
disjoint never/not-yet ranges are for, and the pass number is the one that says the compiler runs
more JavaScript.

| # | landed | codes | Test262 after (passed / failed / skipped) |
|---|---|---|---|
| (a) | 2026-09-03, plan-notes 180 | 2531/2532/2533, 2721/2722/2723, 18047/18048/18049 — possibly-null | 2379 / **9222** / 41,979 |
| (b) arity | 2026-09-03, plan-notes 183 | 2554 extra/missing arguments | 2379 / **8839** / 42,362 |
| (b) assignment | 2026-09-03, plan-notes 184 | 2322 assignment mismatch | 2379 / **8444** / 42,757 |
| (b) argument | 2026-09-03, plan-notes 185 | 2345 argument mismatch | 2379 / **7433** / 43,768 |
| (b) arithmetic | 2026-09-03, plan-notes 186 | 2362 / 2363 arithmetic operands | 2379 / **7276** / 43,925 |

Baseline before (a) was Task 6.1's first pin: 2379 / 10,513 / 40,688.

**(a) the possibly-null family** was 3855 of those 10,513 — the largest bucket by a factor of three,
and every one of them JavaScript that runs (`xs[i] + 1` is how the language indexes an array). It
uncovered one internal error worth keeping: `typeAt` answered with the checker's **narrowed** type
while an identifier **lowers to its binding**, and the two disagree on exactly the narrowings
`isCheckable` refuses. `/** @type {{a:number}|undefined} */ var box = {a:7}; box.a` compiled to
`STA4060`. The fix is in `typeAt`, the one function every branch selection consults: when the
binding is `Unknown` and the narrowed type is not checkable, answer the binding — the value really
is dynamic at run time, so that is the truthful answer, not a workaround. It returns the binding
rather than a fresh `hUnknown(false)`, because an `Unknown` carries whether it came from an implicit
`any` and the verifier compares the two for equality. Nothing had noticed because a `.ts` program
cannot reach it and no `.js` fixture had a JSDoc'd nullable object. **Residue:** `xs[i].toFixed(2)`
compiles and then panics `STA2006` — a method call on a dynamic *primitive* needs `Number.prototype`
dispatch and the runtime has no prototype chain (Phase 8 owns that surface). A located abort, not a
wrong answer, but not Node's answer either.

**(b) argument mismatch (2345) was not a diagnostic filter**, and finding that out is the entry's
value. A bare filter let `Math.abs("-3")` reach HIR, where the verifier raised `STA4080`: it
asserted every `math-call` argument had HType `number` despite the C signature accepting a boxed
`jsrt_value`, and the runtime then read a non-number's NaN-box payload as a double through
`jsrt_number_value`. Removing only the verifier assertion would have emitted a wrong native
program. Math's HIR contract is now exact arity plus a number result, with operand coercion as
runtime semantics: `jsrt_math.c` applies `jsrt_to_number` once in its shared argument helper, so
every Math entry point implements ECMAScript `ToNumber` before numeric work
(`runtime/include/jsrt_value.h` documents it).

**(b) assignment mismatch (2322)** is likewise not a filter: the frontend records the diagnosed
binding *symbol* and passes that mode-free lowering policy downstream, so lowering answers `Unknown`
for that symbol and the verifier sees a dynamic assignment rather than the impossible
`number = string` pair. Module and nested-function fixtures prove the symbol identity survives
scope. **(b) arity (2554)** and **arithmetic (2362/2363)** needed no new mechanism — the closure ABI
already ignores extra arguments and `jsrt_arg` supplies `undefined` for an absent one, and
`binary-op` already lowers through the runtime's ECMAScript numeric operators. Both diagnostics had
been blocking paths whose runtime behavior was implemented and independently verified.

Each landing carries a both-modes decision fixture (the same source, `error` in ts and `dynamic` in
js) and a golden proving js mode compiles it to Node's answer — e.g. `tests/golden/js/argument_mismatch.js`
(`increment("2")` and `Math.abs("-3")`), and `"3" - 1` / `1 - "3"` / `"3" * 2` for the arithmetic pair.

**The (b) sweep finished on 2026-09-04** (plan-notes 194): every remaining `STA0012` bucket was
judged one at a time rather than as a group, and four more codes landed with the fixture pair and
golden the Check demands — 18050 `The value 'undefined' cannot be used here` (`1 + undefined` is
NaN, which is what `language/expressions/addition/S11.6.1_A3.1_*` asserts), 2403 `Subsequent variable
declarations must have the same type` (`var x = 1; var x = 'a'` is one binding written twice), 2695
`Left side of comma operator is unused` (a style lint — the comma operator's answer is its right
operand either way), and 8024/8029 JSDoc `@param` (a COMMENT cannot refuse a program; the parameter
list is the code).

**2403 is the rule the sweep produced, and it produced it by breaking it.** Suppressing the code
alone turned the checker refusal into `STA4004 internal error in assignment: assignment target type
number does not match value type string` — because a redeclaration is the same type disagreement as
2322, just spelled differently, and needed the same widening. Extending the `runtimeDynamicSymbols`
branch built for 2322 fixed it, and the general rule was recorded: **a suppression is finished only
when the program it admits COMPILES; a code that turns `STA0012` into `STA4xxx` is a bug report, not
a candidate.**

**The strict-mode family is a real refusal Stator keeps** (`with`, reserved words, "Modules are
automatically in strict mode" — ~383 tests). §1.2 makes ESM strict in both modes, so there is no
sloppy reading left to run. This is the enumerated list earning its keep: it is not a free pass, and
an operation no runtime could settle stays a hard error in both modes.

### Step 2a(c) — the Error object model

**Landed 2026-09-05** (plan-notes 195). The (b) sweep ended pointing at one shared blocker rather
than a set of buckets: several §1.2 violations have a *thrown Error object* as their runtime answer,
and the runtime could not build one — `jsrt_throw_str` threw a **string**, and every runtime
TypeError was a string-literal prefix, so no golden could prove js mode reached Node's answer.

**It needed no new mechanism.** `JSRTClass` already carries a name, a field list and a `parent`, and
`jsrt_instanceof` already walked that chain for user classes, so the whole model is five descriptors
and two functions in `runtime/src/jsrt_error.c`:

```c
static const char *const error_fields[] = {"name", "message"};
const JSRTClass jsrt_class_error      = {"Error",     2, error_fields, NULL,              0, NULL, NULL};
const JSRTClass jsrt_class_type_error = {"TypeError", 2, error_fields, &jsrt_class_error, 0, NULL, NULL};
/* RangeError, ReferenceError, SyntaxError likewise */
```

Pointing each standard class at `Error` IS the subclass relation as far as `instanceof` can observe
it. Making `name` and `message` ordinary slots 0 and 1 meant `fixed_get` resolved `e.message` with
zero special-casing — **nothing in `jsrt_shape.c` changed**. `errorHType` in `src/hir/nodes.ts` is
the emitter's copy of that layout and **STA4095** is the verifier check that the two have not
drifted; `new TypeError('x')` lowers to an `error-new` node whose class comes from the CALLEE, not
the checker, because TypeScript types all five as the structural `Error` interface.

**It removed a wrong answer, not just a gap.** `Error` was already in `INSTANCEOF_BUILTINS`, so
`e instanceof Error` compiled and silently answered **false**. `jsrt_instanceof_builtin` now resolves
the name to a descriptor through `jsrt_error_class` and does the same pointer walk.

That immediately unblocked **2540** read-only assignment, which the (b) sweep had refused precisely
because the runtime could not build its answer — the loop closing. The runtime's own TypeErrors now
go through `jsrt_throw_error` with Node's exact wording (`Cannot assign to read only property 'a' of
object '#<Object>'`), so a `catch` reads `name`/`message`/`instanceof` as it does in Node.

**Three divergences from Node, deliberate and recorded** (plan-notes 195, docs/VALUE.md §4.17):
`name`/`message` are enumerable here and non-enumerable in Node, so `Object.keys(new Error('x'))`
differs — non-enumerability is a property-descriptor feature the subset does not have at all;
`console.log(err)` prints the object rather than a stack trace this runtime does not have; and the
`jsrt_panic` sites still abort where Node throws a catchable TypeError, because turning a panic into
a throw changes control flow at every caller and is its own change.

**What the landings were measured to have done** (plan-notes 196). `tests/test262/run.ts` has no
filter flag, so the check was taken by pointing `STATOR_TEST262` at a scratch root holding the four
directories the landed codes touch — 655 tests:

```
TOTAL 655: passed 41, failed 115, skipped 499
FAIL REASONS:  115  STA0012
```

Every remaining failure is `STA0012` and **not one is `STA4xxx`** — the 2403 rule above, asked of 655
programs at once instead of one fixture. The measurement also forced a correction: **2704** read-only
*delete* landed only as a RECLASSIFICATION (`STA0012` → `STA1214 (DeleteExpression)`), because the
`delete` operator has no lowering anywhere; and it surfaced **2790**, a bucket the sweep had missed.
Both are recorded as open in `plan.md` §8 step 2a(c).

**`Cannot find name` — the largest bucket — landed 2026-09-05** (plan-notes 197). TS2304/TS2552
(1345 Test262 lines) are dropped in js mode, and reading a name nothing declares now answers the way
JavaScript does: `ReferenceError: <name> is not defined`, catchable, with a working `instanceof`.
This is the bucket the (b) sweep said needed no runtime it did not have — only somewhere for the
answer to come from, which the Error model above built.

The mechanism is one HIR node and one runtime function. `ReferenceErrorRead` carries a NAME rather
than a binding, because having no binding is the condition being modelled; `jsrt_reference_error`
formats Node's message and returns `JSRT_UNDEFINED` purely so the emitter has a C value for an
expression position. Because the emitter's case appends LINES, `sequencePart` flushes the operands
already evaluated out as a statement first, which is what keeps the language's evaluation order
across a throw that happens mid-expression.

**The gate needed no change, which corrected the plan's own premise.** §8 step 2a(c) had recorded
this as needing "the gate path"; in fact `gateIdentifier`'s global branch is guarded by
`symbol !== undefined`, so a symbol-less identifier already fell through to `accept` — it was the
LOWERING that manufactured `STA4035`. One branch there fixed it, turning on the test that does the
real work: `checker.getSymbolAtLocation(node) === undefined` separates a name the checker could not
resolve (a ReferenceError the program may catch) from a name the checker DID resolve arriving with
no binding (a compiler bug). Collapsing those two would let the new node swallow compiler bugs.

`typeof` is answered on the OPERATOR, not the operand: §13.5.1.1 short-circuits before the reference
is resolved, so `typeof missingName` lowers to a `'undefined'` string literal. Teaching the
identifier branch about its parent would have put the language's exception in the wrong place.

**The rule earned its keep a second time.** Suppressing 2304 turned three WRITE forms into
`STA4034` — an internal error for a program the language answers fine. It was caught by asking the
TS2403 question of 24 syntactic positions at once instead of one fixture (`STA4xxx internal errors:
2` → `0`), and the fix models the ordering the language specifies, because the difference is
observable: a simple `=` evaluates its right side FIRST and throws after, while a compound
assignment or an update reads the target before the right side runs. The first lowers to a `flatten`
Block, the second to the throw alone, and `tests/golden/js/reference_error_write.js` pins the
ORDERING — `rhs ran` printed, `never ran` absent — not merely the message.

A pre-existing bug was uncovered and deliberately left: `missing.a = 1` still raises `STA4035`,
because TypeScript auto-declares a global from a property assignment in a `.js` file and the checker
reports nothing for it, so it reached the lowering with a symbol long before 2304 was suppressed. It
is recorded as open in `plan.md` §8 step 2a(c) rather than folded into this change.

Evidence: `pnpm run ci` green — 378 unit tests, `subset: 354 fixtures — 325 passed, 29
expected-fail, 0 failed`, `golden: 160 fixtures — 160 passed`, and the same 160 under ASan/UBSan.

**Inferred JS namespaces — property-reference errors fixed 2026-09-05** (plan-notes 199).
Closes the specific `missing.a = 1` / `missing[0] = 1` residue recorded above. The checker may
synthesize an expando namespace with only Identifier declarations; that is not a runtime binding.
One lowering predicate now handles that distinction consistently for reads, writes, `typeof`, and
receiver typing, reusing `ReferenceErrorRead` and the existing dynamic property path. Real
declarations merged with expando metadata remain bindings; missing slots for real declarations
still report `STA4035`.

**Check evidence, Node v26.7.0:** the new regression tests failed before the fix; afterward
`node --test tests/unit/reference_error.test.ts` reports **14 tests, 14 pass, 0 fail**.
The new `tests/golden/js/reference_error_property.js` matches Node byte-for-byte and proves
receiver-before-key/RHS ordering, bare-write ordering, `typeof`, catch/finally, and preserved real
and shadowing bindings. Paired `subset_reference_error_property` fixtures preserve the two modes.
`pnpm run ci` exits **0**:

```text
tests 382; pass 382; fail 0
runtime: print corpus matches Node
subset: 356 fixtures — 327 passed, 29 expected-fail, 0 failed
golden: 161 fixtures — 161 passed, 0 failed
leak: 10M objects — peak RSS 3040 KB, 39 samples, plateau
runtime: print corpus matches Node (ASan/UBSan)
golden: 161 fixtures — 161 passed, 0 failed
```

Typecheck, lint, duplication gate and builtins dashboard also passed as part of that command.
No new checker diagnostic was suppressed and the Test262 corpus/ratchet was not rerun or changed.

**Catchable property and iterator failures landed 2026-09-05** (plan-notes 200). This is the
"panic-to-throw" Check of step 2a(c), delivered for the sites that actually were panics — and it
corrected the premise that the 2488/2454 buckets sit behind such a conversion. A JS function
annotated `@returns {Generator<…>}` but returning `1` built successfully and SIGSEGVed in `for-of`
where Node throws a `TypeError`: iterator step/next and generator return/throw now validate their
receiver before casting and leave a catchable `TypeError` in the pending cell (impossible internal
iterator kinds remain compiler panics). Nullish property gets/sets use Node's wording
(`Cannot read properties of undefined (reading 'x')`); primitive writes also raise a catchable
TypeError instead of aborting.

Making those throwable forced the emitter to root and check what it had treated as slot-free:
`dyn-field-access` now takes a temp slot and a pending check, as do dynamic indexed reads/writes,
read-modify-write reads (before the RHS is evaluated), and `Object` static calls. `Object.values`/
`entries` stop on a throwing getter and root their partially built array across callbacks.
`Object.assign` snapshots KEYS and then alternates each source get with its target set — the old
eager `collect(OBJ_ENTRIES)` ran later getters before earlier writes, losing partial assignment and
running getters after a setter should already have thrown.

The caller audit also covered `JSON.stringify` and `console.table`: both unwind rather than casting
a failed enumeration result to an array, free their partial output, and have generated pending
checks (including console calls in value position). They snapshot keys and process one property or
row at a time so a nested failure prevents later getters. The golden and runtime accessor corpus
cover those paths, and the emitter unit assertions include their immediate checks.

**What it does not do.** No dynamic `GetIterator` dispatch: 2488 `Symbol.iterator` still needs
runtime dispatch for unknown iterables. And 2454 is definite assignment, not TDZ — an uninitialized
annotated binding holds `undefined`, syntactic TDZ is 2448, and there is no runtime TDZ sentinel to
convert; a trial suppressing 2454 exposed internal receiver checks for string/array/date/regexp
methods (STA4081/4082/4092/4086) and was removed. Both buckets stay open in `plan.md` §8 step 2a(c)
with the corrected reasons. `STA4071`'s runtime half was retired from `docs/DIAGNOSTICS.md`; the
lowering invariant remains.

**Check evidence, Node v26.7.0:** `tests/golden/js/property_errors.js` (operand ordering, warm ICs,
catch/finally, `Object.assign` getter/setter stops) and `tests/golden/js/iterator_receiver_error.js`
(the lying annotation, caught in `for-of`, `next`, `return`, `throw`) match Node byte-for-byte; the
new `runtime/tests/print_iterators` corpus drives six incompatible receiver tags through
step/next/return/throw and the accessor corpus gained abrupt enumeration and partial assignment;
`tests/unit/property-errors.test.ts` pins the pending check after each throwing operation in the
emitted C. `pnpm run ci` exits **0**:

```text
tests 383; pass 383; fail 0
75 clones · 0.9% duplication
runtime: print corpus matches Node
subset: 356 fixtures — 327 passed, 29 expected-fail, 0 failed
golden: 163 fixtures — 163 passed, 0 failed
builtins: 217/238 surface members landed (91%), +5 nondeterministic (proved outside golden)
leak: 10M objects — peak RSS 3040 KB of a 65536 KB cap, 253 samples, plateau
runtime: print corpus matches Node (ASan/UBSan)
golden: 163 fixtures — 163 passed, 0 failed
```

Final aggregate log (including JSON/table regressions): `/tmp/stator-phase5-errors-ci.log`.

Test262 was not rerun and no ratchet changed. In the same change, `.claude/worktrees` was excluded
from the Biome and CPD scan roots (plan-notes 201) — scan ownership, not a lint exemption.

The live Check for everything still open under step 2a stays in `plan.md` §8 — this section is the
record of what landed, not the authority on what remains.

### Step 2a(c) — the `delete` operator, and the answer a fixed shape gives (2026-09-09)

**The Check that closed** (`plan.md` §8 step 2a(c)): *the two delete buckets (2704, 2790) land with
the `delete` OPERATOR — lowering plus whatever answer a fixed-shape object gives when it loses a
field — proved by a golden where `delete o.a` returns Node's boolean and the subsequent read answers
`undefined`.* Both halves landed; the second half answered itself. Design record: plan-notes 210.

**What was there before.** Nothing. 2704 had "landed" in 2026-09-05 only as a reclassification
(plan-notes 196): removing the checker's refusal moved the program from `STA0012` to
`STA1214 (DeleteExpression)`, because no `DeleteExpression` case existed in `src/lower/`,
`src/frontend/gate.ts` or the runtime. 2790 was a bucket the (b) sweep had missed entirely.

**The operator, end to end.** A new HIR node `DeleteProp { target, key }` typed `H_BOOLEAN` — the key
is always an `Expression`, so `delete o.a` and `delete o[e]` are one node, the first with a
synthesized string literal. `gateDelete` classifies the receiver, the lowering unwraps parentheses
and builds the pair, `verify.ts` pins the result type (`STA4097`), `rewrite.ts` recurses into both
children, `explain.ts` reports the construct as dynamic (unlike `typeof`, `delete` operates on the
receiver), and the emitter takes two slots and emits
`t0 = jsrt_bool(jsrt_delete(t0, t1));` followed by the pending check. In the runtime,
`jsrt_delete` in `runtime/src/jsrt_shape.c` REBUILDS the object's shape chain from the root without
the key rather than editing a node — shapes are shared immortal metadata — which preserves insertion
order, lands two objects that deleted the same key on ONE shape (so a shared read site's IC still
hits), and invalidates stale caches for free, since an IC is trusted by shape-pointer compare. Slots
compact in the same walk. The contract is `docs/VALUE.md` §4.10, which previously promised a
dictionary-mode escape that this change does not need.

**The open question, answered: a fixed-shape object does not lose a field — it refuses.** `STA1108`
(never) in ts mode, `STA1205` (not-yet, Phase 8) in js mode, `STA2007` at run time for an Unknown
receiver that turns out fixed. That is `STA2004`'s mirror image (a layout asked to GROW vs asked to
SHRINK, the same absent encoding) and it lifts with the same Phase 8 dictionary mode. In ts mode the
refusal is nearly unreachable by construction: TS2790 demands an optional property, and an optional
property is exactly what sends an anonymous shape to the dynamic representation, so only a class
field can reach `STA1108`. **One fixed-shape delete does have a right answer and takes it:** a frozen
property is non-configurable, so `Object.freeze({x:1})` + `delete frozen.x` raises Node's
`TypeError: Cannot delete property 'x' of #<Object>` rather than aborting — the removal that cannot
be represented is also the one the spec forbids. An array element is refused too, at the gate and as
`STA2007`, because a hole has no representation (Phase 5 rung 5, not Phase 8).

**Suppression.** `2790` joined `JS_MODE_RUNTIME_CODES` in `src/frontend/program.ts`; `2704` was
already there. Neither could be dropped before the operator existed, which is why the plan kept both
open behind one Check rather than counting the reclassification as delivery.

**Two extractions in `jsrt_shape.c`, forced by the rebuild:** `shape_links` (the offset-indexed link
fill) out of `jsrt_shape_property_order`, which now fills then sorts, and `shape_transition`
(reuse-before-allocate) out of `store_prop`. `jsrt_delete` calls both; duplication stayed at 0.9%.

**Check evidence, Node v26.7.0.** `tests/golden/ts/delete_prop.ts` and
`tests/golden/js/delete_prop.js` match Node byte-for-byte: `delete o.a` answers `true`, the
subsequent read answers `undefined`, `in` flips, the printer drops the key, a double delete answers
`true` twice, an absent key answers `true`, a computed `delete o[key]` works, a re-add appends at the
END (`{ c: 3, a: 10, d: 4 }`), two objects that deleted the same key are read through ONE shared
site, and the frozen delete's `TypeError` is caught with `e instanceof TypeError` true. Decision
fixtures `subset_delete_property_{ts,js}` report `dynamic` in both modes, and
`subset_delete_class_field_{ts,js}` lost their `@expected-fail` markers — they now really do report
`error(STA1108)` and `not-yet(STA1205)`.

```text
tests 384; pass 384; fail 0
76 clones · 0.9% duplication
runtime: print corpus matches Node
subset: 364 fixtures — 339 passed, 25 expected-fail, 0 failed
golden: 172 fixtures — 172 passed, 0 failed
builtins: 222/238 surface members landed (93%), +5 nondeterministic (proved outside golden)
leak: 10M objects — peak RSS 3040 KB of a 65536 KB cap, 50 samples, plateau
runtime: print corpus matches Node (ASan/UBSan)
golden: 172 fixtures — 172 passed, 0 failed   (ASan/UBSan)
```

(The subset and golden totals include a concurrent step-12(e) landing in the same worktree; the
`delete` fixtures are the four new subset entries and the two new goldens.)

**Test262 (not part of `ci`), whole pinned corpus, measured in the same tree:** `failed` fell
7276 → 3100 and `skipped` rose 43925 → 48108. That is the 2790 suppression reaching one harness
file — `harness/propertyHelper.js` does `delete obj[name]`, so every test including it used to die
at `STA0012` before Stator's own schedule could classify it. 6 of the 1,233 corpus tests that use a
`delete` expression now pass. `passed` also fell 2379 → 2372, which the ratchet refuses; **the
ratchet was not moved** — the drop is not attributable to this change (before today every `delete`
was `STA1214` or `STA0012`, so no passing test could have contained one) and the measurement shares
a working copy with the step-12(e) landing whose new shadowing refusal has exactly that shape. Full
evidence and the re-measure condition: plan-notes 210.

### Step 2a(c) — unknown-iterable GetIterator dispatch, 2488 (2026-09-16)

**The Check that closed** (`plan.md` §8 step 2a(c)): *each suppression lands with a both-modes
decision fixture (`error` in ts, `dynamic` in js) and a golden proving js mode compiles it to
Node's answer.* The 2488 suppression does exactly that; the 2454 half had landed in wave 3 and
is verified green here. Design record: plan-notes 280.

**What was there before.** `for-of` over anything without a static walk was `STA1214` in both
modes, and `c[Symbol.iterator]` on an unknown receiver a precise Phase-8 refusal (wave 4). The
checker's TS2488 fired for every one of these shapes in both modes.

**The dispatch, end to end.** A `get-iterator` HIR node (`target`, always typed `iterator` with
an Unknown element) wraps any `for-of` operand no static walk covers — an Unknown value, a
union, or a checker-refused non-iterable js mode admitted. The gate admits those in js mode
only (`gateForOf` takes the mode); the lowering wraps them (`wrapDynamicIterator`); `program.ts`
suppresses TS2488 in js; ts mode keeps the refusal. The node emits one `jsrt_get_iterator` call
ahead of the existing boxed walk, so no emission arm was added: the verifier pins the
node-type contract (`STA4045`), codegen counts one rooted temp, `rewrite.ts` and `explain.ts`
carry their arms. The runtime (`runtime/src/jsrt_iterator.c`) passes generators and stored
boxes through, boxes arrays/strings/Maps/Sets into their specialized walks, resolves
`__@iterator` through the shape table and calls it with the receiver (a non-generator,
non-box result is Node-verbatim `TypeError: Result of the Symbol.iterator method is not an
object`), and throws catchable `X is not iterable` otherwise — rendered by the shared
`jsrt_throw_not_iterable` the `STA2009` path now also uses. A custom `{ next() }` object stays
`STA1214` by card; driving one is the Phase-8 tier, not this dispatch.

**Two gate refinements the landing forced.** In ts mode the gate refuses only what the checker
accepted (asked via the checker's property list, since `__@iterator@<id>` suffixing defeats
exact lookup and the HType mapping drops interface methods — `Iterable<T>` proved it), leaving
a lone STA0012 otherwise, because `explain` ranks not-yet above error-class. And a `for-of`
binding is not an annotation site (`annotationSiteOf`), so the checker's recovery-`any` no
longer buries that STA0012 under STA1003 — every other any-binding has a companion diagnostic,
so nothing goes silent.

**Check evidence, Node v26.7.0.** Decision fixtures `subset_for_of_unknown_js` (`dynamic`) and
`subset_for_of_unknown_ts` (`error STA0012`); `tests/golden/js/for_of_unknown.js` matches Node
byte-for-byte (collections, code-point strings, Map entries, Set, generators with
finally-on-break/throw, user classes, stored boxes, `.keys()` views, unions, every TypeError
path). The suppression's wake on spread — directly-`unknown` array spread moving STA0012 →
lowering STA1214 in js — is pinned by `subset_spread_direct_unknown_{js,ts}`. Test262 per-slice before/after (pristine
worktree at the base commit vs this branch): `for-of` 87/675/67 → 87/708/34, `spread` 8/286/37
unchanged, `iterat` 2/598/23 → 2/607/14, `generator` 110/1688/51 → 110/1700/39 — 54
failed→skipped, zero passed→failed; `ratchet.json` untouched per plan.md:416-422.

```text
tests 564; pass 564; fail 0
114 clones · 0.9% duplication
runtime: print corpus matches Node
subset: 679 fixtures — 641 passed, 38 expected-fail, 0 failed
golden: 387 fixtures — 387 passed, 0 failed
golden: 387 fixtures — 387 passed, 0 failed   (ASan/UBSan)
```

### Step 15 — Suspension inside a per-iteration-env loop (2026-09-11)

**The Check that closed** (`plan.md` §8 step 15): *a golden where an async function awaits inside a
loop whose body captures the binding matches the pinned Node byte-for-byte at `-O2`, and the same
for a generator that yields there.* Both are in `tests/golden/js/suspend_in_loop.js`. Design record:
plan-notes 226.

**The defect.** The emitter declared a per-iteration loop's environment state as two C locals inside
the loop body (`JSRTEnv *_jsrt_saved_env_0 = _jsrt_env; _jsrt_iter_env_0 = NULL;`) and put the
`await`'s resume label in that same block, so a resume jumped PAST the initializers and both were
indeterminate. At `-O2` clang turned the UB into `brk #1` (SIGTRAP, exit 133); at `-O0` it happened
to work, which is why no local run caught it. Pre-existing: reproduced on the pristine tree before
anything in this session was applied.

**The fix, in two halves.**

- The state is two frame SLOTS per loop rather than two C locals (`iterEnvSlots`, claimed while
  counting). `slotAt` resolves a slot to the C frame in a sync unit and to the heap environment in
  an async or generator one — and the environment is exactly the storage that survives a
  suspension — so one code path serves all three unit kinds. The slots hold a raw `JSRTEnv *`
  bit-cast into a `jsrt_value`, which the collector traces because its mark procedure masks every
  word of a collected object and marks what looks like a pointer.
- `emitPark` now writes `_jsrt_self->env = _jsrt_env;` before suspending. `JSRTAsync.env` had only
  ever been written by `jsrt_async_start`, so a resume re-entered on the loop's BASE environment
  while the body's remaining code read and wrote the iteration's CLONE. Without this half the first
  measurement was an infinite loop — `i` stuck at its last value, 5.9M lines of output in two
  seconds — which is the honest sign that the slots half alone was not the fix.

```text
unit 385; pass 385; fail 0
subset: 364 fixtures — 339 passed, 25 expected-fail, 0 failed
golden: 197 fixtures — 197 passed, 0 failed
runtime: print corpus matches Node
```

### Step 16 — An interface is the same type as its anonymous twin (2026-09-11)

**The Check that closed** (`plan.md` §8 step 16): *both fixtures match Node, and the choice is
recorded.* The choice is the **dynamic** one: an interface with an optional property or an index
signature is a dynamic shape, exactly like the anonymous type it is structurally identical to, and
the five standard error interfaces are the runtime layout their constructors produce. Design record:
plan-notes 225.

**What was wrong.** Two failures that look unrelated and are one disagreement between what the
frontend typed and what the runtime represented:

- `interface O { x?: number; y?: number }; const o: O = { x: 1, y: 2 }; delete o.x` — `PANIC:
  STA2007` where Node answers `true`. The literal was emitted as a FIXED layout (`isDynamicShape`
  required an anonymous `ObjectLiteral|TypeLiteral` symbol; an interface is `SymbolFlags.Interface`)
  while its HType was Unknown, and Unknown is what `delete` and dynamic writes read as
  "dynamic, allowed" — so the gate passed and the runtime aborted against a layout that cannot lose
  a slot.
- `console.log(new Error('x').message)` — `STA4059` (internal error) where Node prints `x`. The
  `error-new` node is typed `errorHType`, but `tsTypeToHType` sent the `Error` INTERFACE to Unknown
  because of its optional `stack`, so an inline `new Error(...)` produced a dynamic read whose target
  the lowering had concretely typed.

**The fix.** `isDynamicShape` accepts `SymbolFlags.Interface` alongside the two anonymous literal
symbols — a CLASS stays out, because a class instance's declared layout is the point of ts mode —
and `tsTypeToHType` maps the five standard error interfaces to `errorHType`, by lib-interface name
the way `Date` and `RegExp` already were. `isDynamicShape` excludes those five explicitly, because
their `stack?: string` would otherwise re-route `e.message` through the shape table.

**Evidence.** `tests/golden/ts/interface_shape.ts` (delete, `in`, a read after delete, a write, and
the anonymous twin) and `tests/golden/ts/error_family.ts` (all five constructors, `.name`,
`.message`, `instanceof`, an empty message, a caught error) — both byte-for-byte against the pinned
Node. `subset_error_construct_{ts,js}` moved from `dynamic` to `static`, which is what their own
comment predicted would happen when the interface was modelled (plan-notes 195).

```text
unit 385; pass 385; fail 0
subset: 364 fixtures — 339 passed, 25 expected-fail, 0 failed
golden: 197 fixtures — 197 passed, 0 failed
```

### Step 17 — A shadow-renamed function's display name leaks the HIR spelling (2026-09-14)

**The Check that closed** (`plan.md` §8 step 17): *a golden fixture printing a shadowed
non-capturing function and a capturing arrow matches the pinned Node byte-for-byte; the culprit
fixture compiles warning-free.* Triage record: plan-notes 247.

**What was wrong.** Step-14 alpha-renaming gives a shadowed binding an unspellable HIR name
(`\0shadow:f#4`), and the emitter promoted that slot name to the closure's display-name C
string — a `-Wnull-character` warning plus, whenever the value was live and printed,
`[Function (anonymous)]` where Node prints the source name. Found because the in-process
runner surfaces clang stderr (the old spawn runner discarded it on success); the bytes were
always emitted. In the culprit fixture the NUL static was unreachable (the live value is the
heap closure), but a shadowed non-capturing function printed anonymous — an observable
divergence with no golden covering it — and capturing arrows assigned to a const had the same
anonymous gap (the lowering never back-filled arrow names from declarators).

**The fix.** At the lowering, following the rule declarations already keep (`fn.name` holds the
SOURCE spelling while the binding takes the HIR name): a declaration whose lowered initializer
is an anonymous function carries the declarator's source spelling as its display name, and the
emitter prints the display name (`stmt.value.name ?? stmt.name`), never the slot name. Complement
in the same change: `escapeCString` octal-escapes C0 controls and DEL, so no future debug name
can reintroduce the warning (cosmetic only — the display name is the fix). One deliberate flip:
`tests/unit/lower.test.ts` provenance for `const arrow = …` now reports `'arrow'`, toward Node.

**Evidence.** New `tests/golden/{ts,js}/function_display_name.*` (shadowed non-capturing `const f`,
shadowing+capturing `add` inside `makeAdder`, named-function-expression control) — byte-for-byte
against the pinned Node in both modes. Culprit `module_loop_capture.ts`: clang stderr 0 bytes,
`--emit=c` 0 NUL bytes (`{"f"}` where `{"\0shadow:f#4"}` was), output still byte-exact.

```text
unit 390; pass 390; fail 0
subset: 372 fixtures — 351 passed, 21 expected-fail, 0 failed
golden: 214 fixtures — 214 passed, 0 failed
```

### Step 14 — Block scoping: alpha-renaming at the lowering (2026-09-11)

**The Check that closed** (`plan.md` §8 step 14): *a golden fixture shadowing a `const`, a `let`, a
parameter and a function declaration in nested blocks matches the pinned Node byte-for-byte; the
`subset_block_function_shadow_*` rows move from `not-yet` to `static`/`dynamic`; and `gate.ts` emits
no `not-yet` naming a shadowed block binding.* All three hold. Design record: plan-notes 216.

**The defect.** HIR names were source names, so two bindings sharing a spelling had one home in
every consumer — the verifier's binding map, the emitter's `bindSlot`/`slotRef`, the capture
analysis. `const x = 1; { const x = 2; } console.log(x)` printed `2` where the pinned Node prints
`1`, and nothing reported it: the HIR was well-formed and every consumer agreed with every other.

**The fix.** `src/lower/scope.ts` replaces the bare `Map<string, HType>` with a `Scope`: a source
name maps to its type AND to the HIR name a reference must use, and `declare` returns the HIR name
to emit a declaration under. A declaration that would be a SECOND home for its name — a shadow of a
visible binding, or a second declaration of that name anywhere in the same slot space — is emitted
under `\u0000shadow:<source>#<n>`, which no source can spell. Nothing downstream learns that scopes
exist; it only sees names that are already distinct. The slot-space rule is what makes
`{ const value = 'block'; push(() => value); } const value = 'module';` come out `block`, `module`
(Names are not visible to each other there, but both are module globals and the emitter allocates
one slot per HIR name). `child()` (block, loop body, clause list, catch clause) shares the unit's
declared-name set; `functionScope()` starts a new one.

**The capture analysis had to be told**, because it resolves references by SYMBOL and is therefore
spelled in source names while the emitter's `envMap`/`captureMap` are keyed by name.
`CaptureInfo` now carries the declaration behind each `envVar` and each capture, the lowering spells
them through a `WeakMap<ts.Declaration, string>` filled at every `declare`, and the module
environment's slot list is built from DECLARATIONS — two loops at module level each declaring
`let i` are two bindings and need two slots. The re-sort of that list in `lowerProgram` had to go
too: it was idempotent while names were source spellings, and a `\u0000`-prefixed name sorts to the
front, which put every index after it one slot off. `tests/golden/{ts,js}/module_loop_capture.*`
caught exactly that, in both modes.

**Refusal removed with the defect.** `gate.ts`'s `shadowsEnclosingBinding`/`bindsName` — step
12(e)'s deliberately over-broad refusal for a block function declaration that shadows — are gone.
`subset_block_function_shadow_{ts,js}` moved from `not-yet(STA1214)` to `static`/`static`.

```text
unit 384; pass 384; fail 0
subset: 364 fixtures — 339 passed, 25 expected-fail, 0 failed
golden: 177 fixtures — 177 passed, 0 failed
```

**Fixtures.** `tests/golden/js/block_shadow.js`: the four Check shapes, four levels of nesting, a
shadow captured by a closure that outlives its block, a shadowing `catch` parameter, assignment to
a shadow, and a shadowing `for` header — byte-for-byte against Node. Plus the leak half's
`tests/golden/{js,ts}/block_scope.*` (plan-notes 215). **Not claimed:** TDZ, which is a separate
defect this change neither fixes nor worsens.

### Step 3 — Lower `var`

**Step 3 landed (2026-09-02).** `var` in js mode is function-scoped, hoisted, and initialized
`undefined`. There is no HIR `var` kind: each binding becomes a function-scoped (or module-scoped)
`let` initialized `undefined` at the start of its unit, and the original site is an assignment
when it has an initializer. A second `var` of the same name is a second write to that slot. A
`var` that repeats a parameter or a function declaration shares that slot — the spec instantiates
the function/parameter first and does not reinitialize the var to `undefined`.

Capturing a `var` whose spelling sits inside a loop is accepted: the binding is function-scoped,
so every closure sees one slot, which env capture already implements. Capturing a loop `let`/`const`
stays not-yet (per-iteration bindings). ts mode is unchanged (`STA1104` never).

checkJs's "used before assigned" still rejects `console.log(x); var x = 1` as `STA0012`. That
spelling is legal JS and the lowering desugars it (pinned by `tests/unit/var.test.ts`); the
golden proves the observable fact with the equivalent `var x; console.log(x); x = 1`.

Tests: `tests/unit/var.test.ts`, `tests/unit/gate.test.ts` (js accept / ts STA1104 / loop-var
capture vs loop-let capture), `tests/golden/js/var_hoist.js` (read-before-write, block escape,
redeclaration, parameter shadow, loop-shared closures), `tests/subset/subset_var_declarations_js.js`
(expected-fail removed).

### Step 4 — Dynamic lowering completion

**Step 4 landed (2026-09-02).** Unknown (and empty `{}`) property get/set/index/call lower onto
Task 4.1's shape table. Empty anonymous objects are dynamic so they can grow; a required-field
literal stays a fixed layout. `jsrt_get_prop` reads existing fields of a fixed object through
its class descriptor; growing a new key is still `STA2004` (Phase 8). Computed index is
`jsrt_dyn_index_get`/`set`. Calling a non-function is `STA2006` at `file:line`. Arity padding
is `jsrt_arg`. Ordinary functions do not take `this` as argv[0]. `==`/`!=` was already
`jsrt_loose_equals` (`tests/golden/js/to-primitive.js`). `STA4058` retired.

Tests: `tests/unit/dyn.test.ts`, `tests/unit/gate.test.ts` (Unknown get/set/index/call, empty
`{}` grow), `tests/unit/codegen.test.ts` (`jsrt_call_at`, `jsrt_dyn_index_*`),
`tests/unit/cli.test.ts` (aliased read prints; grow still STA2004; STA2006 locates the site),
`tests/golden/js/dyn_unknown.js`, `tests/subset/subset_unknown_property_js.js`. plan-notes 143.

### Step 5 — Mixed-graph boundary checks

**Step 5 landed (2026-09-02).** An Unknown value reaching a checkable annotation (`number` /
`string` / `boolean`) is wrapped in `BoundaryCheck` at the edge: a declaration initializer, an
assignment to an annotated binding, a call argument against a typed parameter, and a return against
a typed return. The key is the EDGE, not provenance (plan-notes 140). A lying JSDoc is still a
compile error (`STA0012`); the runtime trap is an untyped `.js` `wrap(x){return x}` imported into
`.ts` and assigned to `const factor: number` — `STA2001`, empty stdout. The happy path is
`tests/golden/js/mixed_graph/` (js-mode directory entering at `main.ts`).

Tests: `tests/unit/narrowing.test.ts` (declaration / assignment / call / return / JSDoc),
`tests/unit/cli.test.ts` (STA2001 mixed-graph trap), `tests/golden/js/mixed_graph/`. plan-notes 144.

### Step 6 — JSDoc freebie (file verdict static)

**Step 6 landed (2026-09-02).** A `.js` module whose every function is fully JSDoc-annotated
reports file verdict `static` with provenance `typed`. The per-function half was already pinned
by step 1's `explain --json` matrix; this step pins the FILE claim and a vs-Node golden on the
static path. No lowering change: `hasUnknown` was already the rollup.

Tests: `tests/unit/cli.test.ts` (`a fully JSDoc-annotated .js module has file verdict static`),
`tests/golden/js/jsdoc_static.js`.

### Step 7 — js-column honesty + untyped capstone

**Step 7 landed (2026-09-02).** Twelve js-column subset fixtures whose constructs already compiled
dropped `@expected-fail` (never in bulk for not-yet work): typed-literal arithmetic/bitwise/
comparison/unary/template/switch/let-const/`==`/number/string are `static`; untyped `if` and `??`
are `dynamic`. Remaining expected-fail still name their owner (rest, destructure, iterators,
`import()`, bigint, …). Capstone `tests/golden/js/capstone.js` is an untyped in-memory catalog
(~200 lines) matching Node, covering var, growing objects, computed index, Unknown call, and `==`.

`var xs = []` was STA4004: the hoist splits a binding from its initializer and the two `unknown[]`
differed only in `fromImplicitAny`. `hTypeAssignable` now recurses into arrays.

Tests: the twelve subset flips, `tests/golden/js/capstone.js`, `tests/unit/types.test.ts`.
plan-notes 146.

### Step 8 — the iterator protocol, and generators with it

**Step 8 landed (2026-09-02).** Specialized `for-of` (array/string/Map/Set), `keys`/`values`/
`entries`, `matchAll`, `function*`, and generator `.return()`/`.throw()`. User-iterable `for-of` is
a compile-time MethodCall of a class `[Symbol.iterator]()` whose return type is already HIR
`iterator`, driven by the existing boxed-iterator walk — TypeScript unique-ifies the well-known as
`__@iterator@<id>` and HIR canonicalizes it to `__@iterator` so the MethodCall slot matches
`instanceMethodName`. `Symbol.iterator` as a stored value, `Symbol()`, and `Symbol.for` stay
`STA1212`; generator methods, async generators, and `for await` stay `STA1201`; `yield*` and a
custom `{next()}` object stay `STA1214`. plan-notes 147–154.

### Step 9 — top-level await

**Step 9 landed (2026-09-02).** The merged module body is an async unit on Task 4.6's resume points:
named bindings stay globals, temps live in a heap environment, and `main` starts the unit then
drains the microtask queue. Init order is Task 3.11's topological order, **not** Node's
sibling-subgraph interleaving — a deliberate, documented divergence (docs/MODES.md). `STA1208` is
no longer emitted. plan-notes 155.

### Step 10 — dynamic `import()`

**Step 10 landed (2026-09-02).** A module namespace is an `HObject` with `namespace: true`; field
reads compile to the export's global slot, so bindings stay live. A literal-specifier `import()` is
`Promise.resolve` of that object, and the specifier is a value-import edge, so the target's
top-level has already run by the time the promise settles. Computed specifier stays `STA1207`
(Phase 8); `import * as ns` stays `STA1214` (step 12). plan-notes 156.

### Step 11 — `Promise.prototype.then`/`catch`/`finally` and `new Promise(executor)`

**Step 11 landed (2026-09-02).** `jsrt_call_protected` extends §4.9's pending cell into a completion
value, so a handler's throw rejects the derived promise instead of unwinding into library C;
then/catch/finally and `new Promise` are its clients. `Object.freeze`/`isFrozen` and `toISOString`
on an Invalid Date raise through the same mailbox. Combinator residue
(`allSettled`/`any`/`race`/`withResolvers`/`try`) stays not-yet, and `STA1216` remains allocated for
the other `Promise.prototype` members and a non-arity-1 constructor. plan-notes 157.

### Step 12a — parameter and binding forms

**Landed (2026-09-02).** Rest, default, and optional parameters; uninitialized `let`; and shallow
destructuring of parameters, declarations, and catch. Rest parameters are packed at the callee.
Nested patterns, rest-in-pattern, and default-in-pattern stay not-yet in this family.
plan-notes 158–161.

### Step 12b — expression-position residue

**Landed (2026-09-02).** Labels on anything but a loop or switch, capturing a variable declared
inside a loop, `instanceof` against anything but a class name, assignment and compound assignment
to a non-variable, `++`/`--` on a non-variable and in value position, and the binary/unary/statement
catch-alls (`describeKind`) — one family of HIR nodes, not a second lowering. Accessor compound and
`#n in o` stay not-yet (families d / private). plan-notes 164.

### Step 12c — object literal forms (shorthand, non-identifier keys, spread)

**Landed 2026-09-03** (plan-notes 181). `{ x }` desugars to `{ x: x }` in the lowering; a
string-literal key is a slot like any other and `o["a-b"]` reads it back; `{ ...a, y: 1 }` expands to
one field read per field of `a`'s shape.

Landing spread first required fixing a **silent wrong answer** it uncovered — three lines of
ordinary TypeScript, no spread involved:

```ts
const o: { y: number; x: string } = { x: "s", y: 2 };
console.log(o.x);   // Stator: 2      Node: s
console.log(o.y);   // Stator: s      Node: 2
```

A fixed shape has **two** orders and the compiler had conflated them. **Layout** — which slot a
field lives in — is a property of the TYPE (`slotOf` looks the name up in `target.type.fields`),
here the annotation's `y, x`. **Enumeration order** — what `console.log`, `Object.keys` and
`for…in` answer — is §10.1.11 OrdinaryOwnPropertyKeys insertion order, which only the ALLOCATING
LITERAL knows, here `x, y`. `registerShape` built the descriptor from the literal's entries and the
emitter stored `entries[i]` into slot `i`, so writes used the literal's order while reads used the
type's. Printing was right by accident, which is why 140 golden fixtures passed: in every one of
them the two orders coincided. Object spread makes them coincide **never** — TypeScript's spread
result type puts explicit properties first (`{ ...base, y: 2 }` with `base: {x, z}` types as
`{y, x, z}` while JS builds `x, z, y`; measured, not assumed) — which is the real reason family (c)
listed spread beside shorthand.

The fix, at the layer that owns each fact: `JSRTClass` gains `key_order` (slot indices in insertion
order, `NULL` when insertion order IS slot order, which a class declaration always satisfies), with
`jsrt_class_key_slot` the one accessor and `jsrt_print.c` plus `jsrt_object_ops.c`'s `collect` the
only two walks that changed; the lowering takes the **contextual** type as the literal's layout when
there is one, the same "contextual type wins" rule `objectLiteralIsDynamic` already applies; the
emitter stores each entry into its NAME's slot, not its position, and the descriptor cache is keyed
by shape name **plus** key order (one type with two insertion orders is two descriptors); and the
HIR verifier's "entry `i` is the shape's field `i`" check — which was exactly the conflation —
becomes the invariant that survives, that every entry names a field of the shape and the literal
covers the shape exactly.

Spread then falls out as pure lowering. The gate holds the operand to an **identifier** — the
expansion reads it once per field, so anything with an effect would run that effect N times — and to
a fixed shape. `{ ...a, x: 1 }` needs no dedup rule: both entries resolve to one slot and the
emitter stores in source order, so the last write wins per §13.2.5.5, and `keyOrderOf` keeps the
key's first position.

**Residue**, named rather than hidden: a spread of a call result, a member access, or a value with
no fixed shape stays `STA1214`. Methods, computed keys, and accessors landed in later 12c sections.

### Step 12c accessors — getters and setters on object literals ✅ (2026-09-04)

`{ get x() { … }, set x(v) { … } }` compiles. plan-notes 192; representation `docs/VALUE.md` §4.15;
row 85 of `docs/SUBSET.md`.

**The representation, and why it is not where the plan first put it.** The get/set pair lives in the
object's **slot**, as a `JSRTAccessorCell` — not on the `JSRTShape` entry, where plan-notes 190 had
put it. A shape is shared by every object with the same key history; a getter can capture. Node
settles it: `for (let i = 0; i < 3; i++) out.push({ get x() { return i; } })` gives three objects,
one shape, and three different getters. `JSRTShape`, `JSRTIC` and `JSRTClass` are therefore all
**unchanged** — a property read tests the value it just loaded against `&jsrt_class_accessor`, and
nothing in the language can construct a cell, so the test cannot be fooled. Each half is an ordinary
function unit with the receiver as parameter zero (the method ABI, unchanged), so a capturing getter
needs no new machinery: `jsrt_closure_new(fn, 1, "at", env)`.

**An accessor is a dynamic TRIGGER, not a refusal.** `isDynamicShape` used to lump accessors in with
methods and answer "not dynamic" for both, which meant `shapeTypeToHType` built a layout for
`{ get at(): number }` — field `at` at slot 0 — and a read through such a type compiled to
`jsrt_object_get` on a `JSRTDynObject`. Measured: `2e-323` where Node printed `0`. An accessor now
joins the optional property and the index signature as a trigger; a method stays a refusal (step
12(c) methods). Consequence, stated because it is a cost: an accessor deoptimizes its whole shape, siblings
included — one object cannot be half a layout.

**The one refusal left.** TypeScript calls `{ get at(): number }` assignable to `{ at: number }`.
It is not representationally, and there is no conversion to insert — a slot cannot hold "call this
on read" — so an accessor literal in a position typed as a fixed shape is `STA1214` (Phase 5) rather
than a program that reads garbage.

**Node's semantics, pinned byte-for-byte.** `util.inspect` does NOT call the getter (`[Getter]`,
`[Setter]`, `[Getter/Setter]`); `Object.keys` does not either, while `Object.values`,
`Object.entries` and `JSON.stringify` do; a write to a get-only property throws `TypeError: Cannot
set property x of #<Object> which has only a getter`. That last needed an ESM probe to measure —
`node -e 'o.x = 5'` runs sloppy, where the write silently does nothing, and compiled modules are
always strict.

**Check.** `pnpm run ci` clean: 149 golden fixtures (adds `ts/object_accessors.ts`,
`js/object_accessors.js`), 342 subset fixtures with `subset_object_literal_accessors_{ts,js}` flipped
out of expected-fail, and the runtime print corpus gains `print_accessors.{c,mjs}`.


### Step 12c computed keys — `[expr]` on object literals ✅ (2026-09-12)

Runtime computed property names on object literals take the dynamic shape path: lowering builds a
`ComputedEntry` (`key` + `value`) and the emitter stores through `jsrt_dyn_index_set`, which
canonicalizes the key the same way element assignment does. Compile-time string-literal computed keys
(`{ ["x"]: 1 }`) stay on the fixed layout path via `propertyNameIsLayoutKey`. Integer index keys
(`{ [0]: 1 }`, `{ b: 1, [0]: 2 }`) force the dynamic path so enumeration order matches Node
(OrdinaryOwnPropertyKeys: indices first, then insertion order). `objectLiteralIsDynamic` also treats
any literal with a runtime computed key as dynamic. Type-annotation index signatures
(`const o: { [k: string]: number } = …`) are accepted at the gate as checker metadata only
(`IndexSignature`), distinct from class index signatures still refused in `gateClass`.

**Check** (`mise exec node --`, Node 26.8.2):
`pnpm run typecheck` clean; `pnpm run lint` clean; `pnpm run test` → `ℹ pass 386`;
`pnpm run test:subset` → `341 passed, 23 expected-fail, 0 failed` (both
`subset_object_literal_dynamic_keys_*` flipped); `pnpm run test:golden` → `199 passed, 0 failed`
(includes `object_computed_keys` js/ts with `{ b: 1, [0]: 2, [key]: 42 }` ordering).


### Step 12c methods — method members on object literals ✅ (2026-09-12)

`{ m() { return this.v; }, v: 1 }` and `o.m()` compile. plan-notes 228; `docs/VALUE.md` §4.5 method
ABI; row 85 of `docs/SUBSET.md`.

**The representation.** A method member does not take a slot and does not go dynamic: it rides the same
hidden-class descriptor and method table as a class instance. `shapeTypeToHType` now collects methods
into `HObject.methods`; lowering emits `ObjectLiteral.methods` as ordinary `ClassMethod` units with
the literal's layout type as receiver parameter zero; codegen's `registerShape` registers those
methods on the per-shape `JSRTClass` and `MethodCall` names the shape. No second ABI, no bound
closure — `o.m()` is a direct method call with the receiver in argv slot zero.

**What stays not-yet.** Spread of a non-variable fixed shape remains `STA1214`. Method-as-value
(`const f = o.m`) landed in step 12(e) (plan-notes 230).

**Check.** `node packages/tests/subset/run.ts` — `subset_object_literal_method_{ts,js}` static, 0
failed; `node packages/tests/golden/run.ts` — adds `ts/object_literal_method.ts`,
`js/object_literal_method.js`, 199 passed; `node --test packages/tests/unit/*.test.ts` — 385 passed.

### Interfaces and type aliases — SUBSET row 61 delivered (2026-09-08)

`docs/SUBSET.md` promised `static`; the gate answered `STA1214 (InterfaceDeclaration)` — found by
building the `examples/todo/` demo against the shared core, which needs a named shared type. The
gate accepts both declarations, the lowering erases them (top-level skip plus a nested no-op
block, the `EmptyStatement` shape); no HIR/verifier/codegen change, because uses of the name are
annotations the checker already resolves. The two decision fixtures flip out of expected-fail with
honestly different verdicts: a `type` alias of an object literal gets a fixed layout (`static`),
while a value typed by an `interface` goes dynamic by deliberate design (an interface may be
implemented by any class with any layout — `src/frontend/types.ts` — so only anonymous shapes get
layouts). `tests/golden/ts/interface_erase.ts` matches Node byte-for-byte. `enum`/`namespace`
stay refused: they have runtime meaning. Evidence: plan-notes 206.

### Step-12 bookkeeping debt — closed (2026-09-08)

The paragraph `plan.md` §8 carried since 2026-09-04, all three sub-items in one bundle:
(a) `Promise.prototype.then/catch/finally` cite `["ts/promise_then.ts", "js/promise_then.js"]`;
(b) new js-column twin `tests/golden/js/object_freeze.js` (matches Node byte-for-byte) with
`freeze`/`isFrozen` citing both columns; (c) red drift is a build failure —
`packages/tests/unit/builtins-coverage.test.ts` cross-references every empty claim against the
`jsrt_*` symbols in `packages/runtime/include/jsrt_value.h` (console aliases from the same
`CONSOLE_METHODS` table codegen emits through), negative-proofed by emptying one claim and
watching it fail. Dashboard: 222/238, `Promise.prototype: 3/3 (100%)`. Evidence: plan-notes 206.

### Step 12e — the receiver-free half: an arbitrary callee, and functions declared in a block (2026-09-09)

Two of family (e)'s seven constructs. They are the two that need no receiver and no class object,
which is why they landed together and why the other five did not: implementing against
`docs/VALUE.md` §4.16 is what found the hole recorded as plan-notes 208.

**Calling an arbitrary expression was a gate refusal with nothing behind it.** `CallExpr.callee`
was always an ordinary `Expression`, the emitter always evaluated it into its own rooted slot ahead
of the arguments, and the verifier already required its type to be `fn` or Unknown. Only
`gateCall` insisted on an identifier or a function literal. The arm is gone: whatever refusal a
callee's own shape deserves comes from gating that expression, which the walk does anyway, and
deciding it a second time is what made `(up ? inc : dec)(x)` a not-yet. The argument count stays
deliberately unchecked — JavaScript drops extras and fills missing ones with `undefined`, and the
calling convention does that at runtime rather than making it a gate decision.

**A function declared in a block was hoisted at the wrong level.** The lowering already bound it
(`hoistFunctionDeclarations` runs per block) and the counting pass already gave it a slot
(`countBindings` recurses), but the emitter only INITIALISED such bindings in a module or function
body's prologue — so `{ f(); function f() {} }` called `undefined` and aborted with `STA2006`.
Fixed by making the initialisation follow the scope: one `emitScope(statements)` helper does the
hoist and then the statements, and the ten places that emitted a statement list by hand — block,
labeled block, both arms of `if`, `while`, `do`/`while`, `for`, and the three `for-of` shapes —
route through it. `try`/`catch`/`finally` came along for free: those emit their blocks as
statements. Re-running the hoist per iteration is not a cost but the semantics: a loop body's
declaration closes over that iteration's bindings, which is what `steps.map(f => f())` proves.

A `switch` needed all three layers, because its clause list is ONE scope and not one per clause
(the HIR's own `SwitchClause` doc says so): the lowering hoists across every clause before lowering
any (`lowerSwitch`), the verifier mirrors it, and the emitter hoists all clauses before the
dispatch — hoisting per clause would leave a declaration uninitialised whenever the jump lands past
it. Measured on the pinned Node first: `case 0: return describe('zero');` with `function describe`
written under `default:` prints `<zero>`, while the same declaration wrapped in a `{ }` under
`default:` is a `ReferenceError` — the block is the scope, the clause is not.

**One narrow refusal stays, and it is not this construct's.** A block declaration that reuses a
visible name still shares the enclosing slot, because HIR names are source names — the same defect
`{ const x = 2; }` under an outer `const x = 1` has had since blocks were lowered, measured in
plan-notes 209 and now owned by `plan.md` §8 step 14. So `gateFunction` refuses exactly the
shadowing case (`shadowsEnclosingBinding`, deliberately over-broad: every name an enclosing scope
binds counts) rather than letting this landing add a silent wrong answer, and step 14 removes the
refusal with the defect. Ground truth for the fixtures was measured **as an ES module**: a module is
always strict, so these declarations are block-scoped and Annex B's var-scoped alias does not exist
— the same source run as CommonJS answers differently, and measuring in the wrong goal would have
pinned sloppy-mode semantics Stator never has.

**Check.** `tests/golden/ts/call_expression.ts`, `tests/golden/ts/block_function.ts` and
`tests/golden/js/block_function.js` match the pinned Node byte-for-byte; six new decision fixtures
(`subset_call_arbitrary_callee_{ts,js}`, `subset_block_function_{ts,js}`,
`subset_block_function_shadow_{ts,js}`), none of them expected-fail. Run on 2026-09-09:

```
golden: 172 fixtures — 172 passed, 0 failed
subset: 364 fixtures — 339 passed, 25 expected-fail, 0 failed
tests 384 / pass 384 / fail 0
biome: Checked 94 files. No fixes applied.
jscpd: 70 clones · 0.7% duplication
tsc --noEmit: clean on both the compiler and the tests project
```

The C runtime was not rebuilt for this landing and needed no change: every layer touched is
TypeScript, and `packages/tests/unit/frames.test.ts` (in the 384) is what holds the new emit path
to the frame-vs-locals discipline.

---

### Step 12e — method values and calling a class field (2026-09-12)

The receiver-carrying half of family (e). Plan-notes 208 measured the hole in §4.16: a method
value called with arguments bound every parameter off by one because `jsrt_arg` fills from the
right and the receiver is parameter zero on the left.

**`JSRTClosure` carries `has_receiver`.** Method units emit `arity` without counting the receiver
(`closureMeta` subtracts parameter zero) and set `has_receiver = true`. `jsrt_call` prepends
`undefined` to `argv` when `argc == arity` (a bare method-value call) and passes `argv` through
when `argc == arity + 1` (`o.m(a)`). Still not `Function.prototype.bind`, which INSERTS a
captured receiver.

**Compiler surface.** New HIR `method-value` loads a direct closure or `jsrt_method` for virtual
dispatch. `gatePropertyAccess` admits `o.m` in value position; `gateCall` admits `o.field()` when
the name is a class field. `jsrt_object_get_field` raises Node's TypeError when a method body reads
`this` on an unbound call.

**Check.** `tests/golden/{ts,js}/method_value.*`, `method_value_this_error.*`, `class_field_call.*`
match the pinned Node byte-for-byte; decision fixtures `subset_method_value_{ts,js}` and
`subset_class_field_call_{ts,js}` are out of expected-fail. Run on 2026-09-12:

```
runtime: print corpus matches Node
tsc --noEmit: clean (compiler + tests)
tests 385 / pass 385 / fail 0
subset: 368 fixtures — 343 passed, 25 expected-fail, 0 failed
golden: 202 passed for this landing's six fixtures; 1 unrelated pre-existing fail (array_callbacks.ts, STA4002)
```


### Steps 18–38 — the 2026-09-14 bug-hunt batch ✅ (landed 2026-09-14/15, consolidated 2026-09-15)

Twenty-one steps from the 2026-09-14 bug hunt (plan-notes 249–251) landed in three commits but were
never moved out of `plan.md` — the plan kept listing implemented work as open (golden rule 1).
Verified 2026-09-15 by four parallel verification agents (one per step group), each rebuilding the
step's goldens in both modes against the pinned Node 26.7.0 and running the subset runner; all
Checks passed with no code changes, working tree clean throughout.

- **Batch 1 — steps 18–27** (`49d8193`, 2026-09-14): console variadic (18), variadic builtins (19 —
  the only remaining "method calls are not yet supported" is the generic unresolvable-receiver
  fallback at `gate.ts:2266`, not a named builtin), dynamic-receiver crash → catchable `STA2008` /
  `STA2009` (20), four runtime divergences (21), computed keys with methods/accessors (22),
  shadowed-class identity via `Scope.declare` (23), optional chaining with the decision fixture now
  honestly `dynamic` (24), field-initializer arrow `this` (25 — landing renamed
  `enclosingNonArrowFunction` to `enclosingThisOwner`), duplicate-keys js carve-out with ts keeping
  `STA0012` (26), spec-exact `ToNumber(string)` in `jsrt_numeric.c` (27).
- **Batch 2 — steps 28–37** (`6ed9f77`, 2026-09-15; the commit message under-names the batch as
  "33–37" — history is not rewritten, this entry is the correction): integer-key enumeration order
  (28), `ToString` of Map/Set/RegExp/Date/Error (29), five inspector divergences (30), the
  `2^29−24` string-length cap with catchable `RangeError` (31, correcting note 203), `Date.parse`
  ISO leniencies (32), `{ __proto__: 1 }` as proto setter (33), `IteratorClose` on abrupt exit but
  not `continue` (34), Promise adoption/`finally` ordering (35), object-method capture UB fixed and
  ASan-clean (36, the P0 segfault), suppressed-diagnostics → no `STA4xxx` with spread-call honestly
  `STA1214` (37).
- **Step 38** (`5a83a1d`, 2026-09-15, plan-notes 257): `for-in` over arrays/strings via `forInKeys`
  with `TS2407` suppressed in both modes; `Object.keys` off-layout stays loud `STA4084` by design.
  Records the ts-mode contract tension honestly (tsc refuses `for-in` over a string; Stator compiles
  it with byte-exact semantics — revert the `BOTH_MODES` half to js-only in one line if the owner
  prefers refusal).

**Check evidence** (cited runs): `golden: 337 fixtures — 337 passed, 0 failed` (release; every
step filter above also green under `STATOR_RUNTIME=asan`); `subset: 570 fixtures — 530 passed,
40 expected-fail, 0 failed`; per-step manual `build` + run + `diff` vs the pinned Node byte-exact
in both modes (16 js fixtures + 15 ts twins for steps 18–22; 5/5/2/2/2 release+ASan pairs for
28–32; proto/iterator/promise/capture/nonfunction/for-in pairs for 33–38, plus a `STA4` grep over
step-37 js builds with zero hits). Two observations carried forward, not gaps: `docs/NUMERIC.md`
§6.3 was not expanded with step 27's six cases (detail lives in code comments + fixtures), and
§8 step-12 prose is stale where later landings went broader than written (recorded in plan-notes
258 with the triaged residue).

### Steps 39–40, uninit optional fields, spread methods, 2464 coercion ✅ (landed 2026-09-15)

One wave of five parallel slices (`6f88a8b`), all from the 2026-09-15 triage (plan-notes 258):

- **Step 39** — spread of an unknown value threw `STA4082`/`STA4068` (gate accepted, verifier
  rejected). The gate now judges the spread by the type the lowering gives the operand and emits
  an honest `STA1214` Phase 5 for both arms (array + object twin); ts behavior preserved
  (`STA1003`/`STA0012` twins). Residual for a follow-up: spread of a union of arrays still throws
  `STA4082` — a union is always iterable and deserves compilation, not refusal.
- **Step 40** — lowering diagnostics printed `[ts]` under `--mode=js`. `lowerProgram`/
  `lowerSourceFile` take a trailing label-only `mode` (§0.8: zero `mode ===` branches in lowering);
  `lower-mode-label.test.ts` pins `[ts]`/`[js]` on `STA4032`.
- **Step-12(d) slice** — uninitialized optional class fields (`x?: T`, incl. static/`#private`)
  compile with the slot defaulting to `undefined` (Node uses define-semantics: `"x" in c` is true;
  `jsrt_object_new` zero-fills). Gate-only change; computed/accessor names stay `STA1214`. The
  verdict is `dynamic` (union field type), like the initialized twins — the wave's plan said
  `static` and the runner corrected it.
- **Step-12(c) slice** — spread of a methods-carrying literal copies each method as data
  (`MethodCopy` HIR: the source's bound closure, `this` answers the copy) plus a runtime arm in
  `jsrt_dynobj_spread` for `#method:` slots. Accessor-into-literal and reorder spellings stay
  honest `STA1214` with their reasons in the fixture headers.
- **Step-2a(b) slice** — TS2464 suppressed in js mode; computed keys coerce via ToPropertyKey
  (`{} → "[object Object]"`, `42 → "42"`, null/void/bool/array likewise), ts keeps `STA0012`.
  No fallback needed; custom-`toString` dispatch is Phase-8 ceiling, shared with concat/`o[k]`.

**Integration fixes the wave itself surfaced** (same commit): `dynLiteralBaseSlots` over-reserved
the value scratch for spreads-only dynamic literals (`{ ...o }` into a dynamic result copies via
`jsrt_dynobj_spread` and never stores through it — frames.test.ts caught the gap, one slot), and
`class-members.test.ts` pinned the old optional-field refusal (updated to the landed behavior).

**Check evidence:** `tsc` clean (compiler + tests); `oxlint` 0/0; `oxfmt` clean; `cpd` 0.9%;
`unit: 479/479`; `subset: 581 — 541 passed, 40 expected-fail, 0 failed`;
`golden: 343/343`; single-accessor/spread-only/spread+plain dynamic shapes probed exact
(no unwritten slots, no overruns) beyond the corpus.

### Wave 3 — class surface + 2a residue ✅ (landed 2026-09-15)

Five parallel slices (`7e9079d`), all green at HEAD (`tsc` both projects, oxlint 0/0, oxfmt
clean, `unit 484/484`, `subset 603 — 563/40/0`, `golden 355/355`):

- **S-F class expressions** — `ClassExpression` rides the shared `gateClass` vetting (no duplicated
  member checks); verdict stays honest `STA1214` (lowering has no expression arm — accepting would
  trade it for `STA4031`), with correct messages for anonymous/named expressions. Mid-wave
  collision (a half-landed computed-names refactor broke named-class paths) resolved by the
  refactor's owner in the same tree; lesson recorded in plan-notes 259 and reused here: verify
  against the final shared state, not the slice start.
- **Literal-typed computed members** — `[k]` with a static name declares/reads/calls exactly what
  the direct spelling does (dot/element twins share lowering); dynamic keys, integer-like keys and
  `C[k]` stay `STA1214` with their boundaries. Observed out of scope: nullable `c?.m` answers
  `undefined` where Node answers the function — needs a triage owner.
- **Per-class `#private` slots** — `#name@Owner` storage with lexical resolution through the
  checker's symbol; static `#private` accessors land; same-chain redeclare stays a (currently
  unreachable) defense-in-depth refusal. Also fixed a latent static-setter placeholder mistype.
- **Array spreads** — `{...a}` accepted for dynamic literals only (a fixed binding would promise
  slots the value never builds — silent garbage reproduced, hence dynamic-only); `[...u]` over
  all-array unions lowers to `[].concat(u)`. `RegExpExecArray` spread and fixed-param/dynamic-arg
  miscompile observed adjacent, not fixed.
- **2454 definite assignment** — suppressed in js as a CODE (no option flip) + binding widening so
  every use goes dynamic; uninit method receivers throw Node's catchable `TypeError` (unknown arms
  fall through to `dyn-method-call`). Test262 moves 88 failed→skipped, 0 passed→failed; `ratchet.json`
  untouched (the 2372→2371 gap is pre-existing corpus drift, red at baseline too).

### Wave 4 — generics, class values, receivers ✅ (landed 2026-09-15)

Five parallel slices (`93af561`), all green at HEAD (`tsc` both projects, oxlint 0/0, oxfmt
clean, cpd 0.9%, `unit 495/495`, `subset 623 — 583/40/0`, `golden 368/368`):

- **Generic bases + nesting** — concrete-arity generic bases (heritage grounding per declaring
  class, tuple descriptors seeded) and program-unique nested generic classes; generic subclasses,
  partial bounds, dup names, and `instanceof` against a generic class stay `STA1214` (no
  family-wide check exists without a runtime mechanism — deliberate).
- **Class-as-value via alias erasure** — the "blocked on the class object" premise dissolved:
  `new K()`/`instanceof K`/`K.static` never evaluate the class, so `const K = C` binds no value
  and every in-place use rewrites to the target (zero runtime/C/HIR/GC changes). Opaque uses,
  `extends K`, `let`-formations, and `super`-as-value stay `STA1214` (super-as-value has scoped
  follow-up pointers: `method-value` with receiver param + `direct` dispatch).
- **Dynamic `this` (2683)** — `noImplicitThis: mode === 'ts'` plus Unknown receiver param zero,
  reusing the `has_receiver` machinery; ESM-strict `undefined` is the honest answer. ts keeps
  `STA0012`; top-level/static/explicit-`this` stay `STA1214`.
- **Overload fallback (2769)** — js suppression + gate acceptance of signatures with an
  implementation; calls flow through the existing Unknown/`STA2001` path. **TS2416 verdict:
  REAL REFUSAL Stator keeps** — one name cannot be both a field slot and a method entry, and a
  fixed layout would answer base-typed reads wrong (evidence table in the report); same
  conclusion shape as 2790's fixed-shape delete.
- **Iterator dispatch + nullable reads** — static `c[Symbol.iterator]` through member machinery;
  unknown receivers get a precise Phase-8 `STA1214` (full GetIterator scoped with file:line);
  `c?.m` lowers statically in the `?.`-consequent for single-class receivers (short-circuit
  makes it sound). Test262: 88 more failed→skipped via 2454's wake, 0 passed→failed.

### Wave 5 — remaining surface (steps 41–44) ✅ (landed 2026-09-15)

Four parallel slices (`a84a970`), all green at HEAD (`tsc` both projects, oxlint 0/0, oxfmt
clean, cpd 1.0% — exactly at the gate, see plan-notes 262; `unit 503/503`,
`subset 643 — 603/40/0`, `golden 376/376`):

- **41 bare generics as value** — `typeof id` folds to `"function"`; other value positions take
  the canonical tuple (shared specialization); callbacks specialize at the parameter type via
  `genericArgumentTuple` (which also closed an `STA4054` gap on receiver-op paths). Escape
  positions (`return`/`===`/spread/…) stay `STA1214`; explicit type args on non-generics stay
  `STA0012` (genuine TS2558).
- **42 `super` as value** — `super.m` tear-off lowers to `method-value` (`direct` dispatch,
  receiver param); plus a root-cause fix in `captures.ts` (`SuperKeyword` now registers a
  receiver capture — also fixed pre-existing `super.m()`-in-arrow `STA4072`). Bare `super`,
  field/accessor/element/static positions stay refused.
- **43 alias/member bases** — `extends K` (incl. chains, `K<number>`, cross-file) and
  member-expression bases through `baseClassOf` + alias erasure; true mixins, `let` aliases,
  `NS.K` stay `STA1214`. `extends NS.C` still fails on the namespace's own refusal (separate).
- **44 receiver hardening** — match-array spread rides `[].concat(u)`; `o[kObj]` reads suppress
  TS2538 in js with ToPropertyKey coercion (which also fixed pre-existing `a["01"]`→`a[1]`
  garbage); fixed-param/dynamic-arg widens through the 2322/2454 channel (method-touching bodies
  keep static dispatch). **Remainder → step 45:** return/decl/assign edges still miscompile the
  same garbage; dynamic method dispatch on class instances stays `STA2006` (baseline).

### Wave 6 — step 45 boundary edges ✅ (landed 2026-09-15)

Two parallel slices (`2ac7e4d`), green at HEAD (`tsc` both, oxlint 0/0, oxfmt clean, cpd
unchanged 1.0%, `unit 503/503`, `subset 653 — 613/40/0`, `golden 380/380`, new goldens ASan-clean):

- **Return edge** — `collectDynamicReturns` pre-pass widens the CALL (never the declaration, so
  overload/vtable contracts hold); chains to a fixpoint; `calleeTargetDeclaration` also resolves
  variables holding functions. Unknown-spread sources now refuse honest `STA1214` instead of
  garbage/`STA4xxx`.
- **Decl/assign edges** — `widenVariableIfUnsafe` in the shared fixpoint (object declared +
  unsafe value; literals excluded so order-strict stays static) with gate coherence by
  construction (same probe both sides); `lowerClassMemberRead` takes the dynamic path for
  widened targets. Spreading a widened binding stays an honest not-yet for the dynamic-spread
  owner.
- **Remainder → step 46:** the decl×return combination (`const x: Fixed = f()` with widened
  `f()`) needs the two passes joined in one fixpoint — each pass is blind to the other's marks.

### Wave 7 — step 46 + Task 7.2 steps 1–2 ✅ (landed 2026-09-15)

Two parallel slices (`4445956`), green at HEAD (`tsc` both, oxlint 0/0, oxfmt clean, cpd
0.9% — net code removed; `unit 517/517`, `subset 655 — 615/40/0`, `golden 382/382`):

- **Step 46** — one joint driver `collectDynamicWidening`: slots and returns passes alternate
  in a single fixpoint, slot marks feed back as `knownDynamic`, return marks as `knownReturn`;
  both sets grow monotonically (combined least fixpoint, source-order independent); keyspace
  disjointness untouched.
- **Task 7.2 steps 1–2** — `--emit-header`/`--unit-name` CLI flags; `frontend/export.ts` (the
  only surface reader) renders deterministic headers from Task 7.1's ABI table in reverse
  (in-table → C prototype, else `jsrt_value`; `extern const` for primitives); refusals
  `STA1122` (shape) / `STA1123` (mutable state) / `STA1124` (symbol collision); `clang -c`
  object output; determinism unit-pinned. Follow-up (steps 3–9): export stubs, init/error
  companions, frame/thread treatment, version symbol, CI example.

## Phase 6 — Conformance and differential fuzzing (in progress)

### Task 6.1 — Test262 runner ✅ (2026-09-03)

**Check clause:** *Test262 % visible and monotonically tracked.* Met.

```
$ pnpm run test262
test262: 2379 passed, 40688 skipped (BigInt: 1193, STA1214: 34932, Symbol: 2663, …), 10513 failed
         — pass rate 18.5%
```

Pinned corpus `771005236e88a909635104e03ba12559688c0172`, 53,580 tests after `_FIXTURE.js` exclusion.
`tests/test262/ratchet.json` now holds `{2379, 10513, 40688}`: `passed` may not drop and `failed`
may not rise. The number is CI-visible per commit via the `test262` job's
`$GITHUB_STEP_SUMMARY` line.

**Steps 1–8 as built.** Corpus fetched by SHA into a git-ignored directory, resolution order
`$STATOR_TEST262` → default, missing corpus a visible skip so `pnpm run ci` stays offline-runnable;
a ~50-line frontmatter parser that hard-errors on an unrecognized top-level key; a harness adapter
concatenating `assert.js` + `sta.js` + `includes:` ahead of the body; negative tests inverted
through an `STA`→spec-error-class table; a feature map where an unmapped tag is a runner error, not
a skip; `results.json` plus the human line carrying the rate and the raw skip count together; the
ratchet; and a `test262` CI job on `ubuntu-24.04` alone.

**What the first pass cost, and what it changed** (plan-notes 175–176). Every one of the 98 failures
in the first 113-test slice was the runner or the gate refusing the HARNESS, not the test:

| defect | effect |
|---|---|
| `harness/sta.js` shadowed the corpus file of that name, defining only `$DONE` | `Test262Error` did not exist; every harnessed test died on `Cannot find name`. Now `harness/done.js`, `$DONE` alone, concatenated after both corpus files |
| `noFallthroughCasesInSwitch` on in js mode | refuses valid JS (`assert.js` falls through on purpose). Now `mode === 'ts'` |
| `useUnknownInCatchVariables` on in js mode | refuses `catch (e) { e.name }`. Now `mode === 'ts'` |
| `flags: [generated]` not in `ALLOWED_FLAGS` | 17,003 tests — a third of Test262 — skipped for a provenance note with no execution meaning |
| `_FIXTURE.js` files enumerated as tests | 294 non-tests reported as `missing frontmatter`, the bucket that means "a real test we could not read" |
| a not-yet build counted as a failure | `STA12xx` is schedule, not conformance (§1.3); now a skip attributed to that code, unless the build raised something else too |
| CI's `pnpm run test262 \| tee` without `pipefail` | `tee` decided the job's exit status: the ratchet could fail and the job stay green |

The lesson worth keeping: **the skip column is where a runner's own defects hide**, because a skip
looks deliberate. Everything in it has to name a rule, and the rule has to be about the compiler.

The runner is also a pool over `availableParallelism()` — 37 s → 5.9 s on a 113-test slice, 6.3× on
this host. Not an optimization: a serial pass is ~5 hours, which step 8's per-commit job cannot
afford. Temp filenames carry the pool slot; keyed by pid alone, two workers would have compiled each
other's source and reported the answer to the wrong test.

**What the 10,513 failures say.** `STA0012` — a TypeScript checker refusal, not a Stator gate
decision — is essentially all of them, and the largest bucket (3127, `'x' is possibly
'null'/'undefined'`) is the same finding as the two harness fixes at scale: `strictNullChecks`
refuses ordinary JavaScript in js mode. That is Phase 5 step 2's residue, not this task's, and it is
filed as **plan.md §8 step 2a** with a measured ordering rather than folded in here. Phase 6 produces
evidence, not features; this is the evidence.

Tests: `tests/unit/phase6.test.ts` (frontmatter, feature map, `scheduleSkipCode`),
`tests/subset/subset_switch_fallthrough_{js,ts}`, `tests/subset/subset_catch_binding_property_{js,ts}`,
`tests/golden/js/mode_policy_es5.js`.

### Task 6.2 — Differential fuzzing ✅ (built 2026-09-02, hardened 2026-09-03)

**Check clause:** *fuzzer runs ≥1 h nightly with zero unexplained divergences.* Met by
`.github/workflows/nightly.yml` (`--minutes=60 --seed=${{ github.run_number }}`, `0 2 * * *`);
re-verified locally on the pinned Node at HEAD `4956428`:

```
$ mise exec node -- node packages/tests/differential/run.ts --count=12
differential: seed=1 modes=ts,js
differential: 24 cases — 0 divergences          # 26 s
```

**Steps 1–9 as built.** `packages/tests/differential/` holds `generate.ts`, `minimize.ts`, `run.ts`,
`corpus/` and a git-ignored `failures/`. Entropy is one `XorShift32` class and nothing else — the
file says so in a doc comment, and `Date.now`/`Math.random` appear nowhere in the directory, so
`--seed=N` replays a run exactly. Generation is type-directed (`chooseType` first, then an
expression inhabiting it), which is what makes a program that fails to compile a *generator* bug
rather than a finding. The grammar is weighted at the five regions step 4 names —
`NUMBER_EDGES` (i32 boundaries, `MIN_VALUE`/`MAX_VALUE`, shortest-round-trip fodder),
`IDENTITY_EDGES` kept deliberately separate (`NaN`/`±Infinity`/`-0`/`0`: arithmetic over them
yields `NaN` and would drown the float region), `STRINGS` carrying a lone surrogate, a surrogate
pair and an astral character, `Map`/`Set` construction over two identity edges (SameValueZero is
reachable only through the containers), and `COERCION_OPERANDS` for cross-type `==`. The oracle
runs the same source on the pinned Node and compares stdout byte-for-byte with a 5 s timeout
counted as a divergence; `minimize.ts` delta-debugs to the smallest program preserving it; a
finding is written out as `.source`, `.min.js`, `.node.json`, `.stator.json`. The `js` arm (step 8)
is not a separate generator: `--mode=both` splits the time budget evenly per mode.

**Two defects the hardening pass fixed** (plan-notes 177, commit `78a5bf3`): TS 2367
(*"comparison appears to be unintentional"*) was on in **js** mode, so a cross-type `==` could not
be generated at all — a lint about intent, refusing the coercion table that js mode exists to run;
and `--minutes=N` set ONE deadline for the whole run, so the first mode spent the entire budget and
the second fell through to `count` cases — one, by default — and still printed `0 divergences`.
An hour-long nightly would have fuzzed `ts` for an hour, `js` for one program, and reported a clean
sheet for both. The arm that would have silently disappeared is `js`, which is step 8's whole
subject.

**Step 7 has been exercised once, on the fuzzer's first finding** (plan-notes 178):
`"\ud800".charCodeAt(0)` answered `65533` where Node answers `55296`, found within seconds of the
generator gaining the surrogate region. The runtime was correct — the **emitter** copied non-ASCII
source characters verbatim into the generated `.c`, where writing an unpaired surrogate as UTF-8
substitutes U+FFFD before clang ever saw it. Literals now travel as WTF-8 with every non-ASCII byte
written as a three-digit **octal** escape (octal, not `\x`: a C hex escape consumes every hex digit
that follows it). Landed as `tests/golden/ts/string_surrogates.ts` with the pre-minimization program
in `tests/differential/corpus/ts-20260915.ts`, in the commit that fixed it.

### Task 6.2a — Pin the ground truth's invocation ✅ (2026-09-08)

**Check clause:** *in a shell whose bare `node` is not the pinned major, `pnpm run ci`
refuses to start and prints the remediation; under the pin, CI is unchanged and green.* Met.

The guard is `scripts/check-node.mjs`: dependency-free (it runs before anything is
installed, so it imports only `node:fs`/`node:path`/`node:url`), reads `.node-version` from
the workspace root, and compares the running major against the pinned major. Major-only is
exactly what the Check names — a 26.x drift against a 26.7.0 pin still runs. Mismatch prints
the cause plus the one-line fix (`mise exec node -- <your command>`) and exits 1; match
prints one confirmation line and exits 0. It runs first in `pnpm run ci` and in `ci.sh`
(the task's "cheapest correct form": one script, invoked at the gate, not fanned out into
every `test*` script), and the remediation is recorded in AGENTS.md's Commands preamble.

Measured in this shell, whose PATH puts mise's `node/lts` (v24.20.0) ahead of the shims:

```
$ node --version
v24.20.0
$ pnpm run ci
$ node scripts/check-node.mjs && ...
stator: node v24.20.0 is not the pinned Node (26.7.0 from .node-version) — suites diff against the pinned Node, so a run here proves nothing
stator: fix: mise exec node -- <your command>
[ELIFECYCLE] Command failed with exit code 1.   # EXIT:1, before any suite ran
$ mise exec node@24 -- node scripts/check-node.mjs   # same refusal, other 24
EXIT:1
$ mise exec node@26.7.0 -- node scripts/check-node.mjs
stator: node v26.7.0 matches .node-version (26.7.0)
EXIT:0
```

Under the pin every CI step is green (same host): `typecheck` (both projects), `lint`,
`dupes` (75 clones · 0.9%), `runtime` (Boehm build), unit 383/383, coverage 90.46% exit 0,
`test:runtime` corpus match, `test:subset` 327 passed / 29 expected-fail / 0 failed,
`test:golden` 165/165, `test:builtins` 217/238, `test:leak` plateau, `moon run tests:ci`
exit 0, ASan golden under `STATOR_RUNTIME=asan` exit 0.

Deliberate scopings (plan-notes 205): no unit test — the matrix is the runtime itself, so
the two-shell behavioral run above IS the test; `moon run tests:ci` does not invoke the
guard (it spawns the ambient node directly, per plan-notes 204's no-pnpm rule), so a moon
run from an off-pin shell still trusts PATH — recorded, not fixed, since the Check names
only `pnpm run ci`. Drive-by in the same change: `ci.sh`'s trailing `just runtime-asan`
no longer resolved after the `packages/*` move (no root justfile); now
`just -f packages/runtime/justfile -d packages/runtime runtime-asan`.


### Task 6.3 — Benchmark harness ✅ (built 2026-09-02, hardened 2026-09-03)

**Check clause:** *benchmark page auto-updates.* Met. Re-verified on the pinned Node at HEAD
`4956428` (the generated page and `baseline.json` were restored afterwards — they are machine-local
by rule, and this host is not the recording host):

```
$ mise exec node -- node packages/tests/bench/record.ts
bench: recorded 5 programs to packages/tests/bench/results/2026-09-09T07-23-51-394Z-darwin-arm64-….json

# packages/tests/bench/README.md, generated:
| Engine | Version | Geomean runtime (ms) |
| stator | working tree |  22.36 |
| node   | v26.7.0      |  59.29 |
| bun    | 1.3.14       |  20.00 |
| qjs / perry / scriptc / hermes | absent | — |
```

**Steps 1–7 as built.** `tests/bench/record.ts` was **extended, not replaced**: best-of-5 and the
host/CPU/Node/clang/`-O2` stamp are the Phase-2 shape, and run-time measurement, a program set and
other engines were added onto it. The compute set is its own directory (`tests/bench/programs/`:
`fib`, `nbody`, `json-roundtrip`, `string-churn`, plus `startup` — the empty program that separates
"our binary starts fast" from "our fib is fast"), deliberately outside the golden suite, and **every
program is verified against Node at record time**: `main()` runs each on the pinned Node first and
`measureStator` throws on a mismatch, so a benchmark that computes the wrong answer quickly aborts
the recording instead of becoming a data point. The RSS portability trap is handled where the plan
named it: `run()` shells `/usr/bin/time` (`-l` on darwin, `-f %M` on Linux) and returns BOTH
`maxRssRaw` and `maxRssBytes`, converting `* 1024` on Linux only — the raw value is kept beside the
normalized one, so the first cross-platform comparison cannot silently report a 1000× regression.
The competitor matrix is by **discovery**: `probe()` walks `node`, `bun`, `qjs`, `perry`, `scriptc`,
`hermes` on `PATH` and records each engine's own version string; an absent engine is written as
`"absent"`, never omitted, because an omitted row and a slow row look identical six months later.
Results append to `tests/bench/results/<timestamp>-<host-id>.json` (git-ignored) and the page is
**generated** into `tests/bench/README.md`. The weekly job shares `nightly.yml` with a second cron
(`0 3 * * 0`), uploads the results file with `if-no-files-found: error`, and writes the generated
page itself to `$GITHUB_STEP_SUMMARY`.

**Two hardening fixes** (commit `78a5bf3`): the results filename carries a full timestamp rather
than `stamp.slice(0, 10)` — two recordings on the same day wrote the same file, so the second
silently replaced the first and the regression gate lost the run it should have compared against,
which step 5's "appended, never overwritten" cannot survive; and the benchmark step gained
`set -o pipefail`, without which `tee` decides the step's exit status and a failed recording is
still green — the same defect already fixed in `ci.yml`'s Test262 step (plan-notes 175), in the job
that publishes the numbers.

**Step 7's threshold, measured rather than assumed.** `sameHostPrevious()` compares the geomean
against the newest previous result **for the same host id** and throws above
`regression.thresholdPercent`, which is 20. The step requires the gate to sit above a measured
spread, so the same commit was recorded twice on this host: geomean **22.358 ms → 21.458 ms**, a
**4.0%** swing with no code change. The 20% gate is five times that floor. Named honestly as
residue rather than closed: that is ONE repeat on ONE host, and a floor worth trusting wants a
handful of repeats on the machine that actually runs the weekly job.

### Task 6.4 — Plain `test` is the gate; `test:coverage` is on-demand only ✅ (landed 2026-09-14)

No new script was needed — `pnpm run test` already existed beside `test:coverage` (AGENTS.md:
find the existing helper rather than adding a parallel one). The change is wiring + rule only:
`package.json` `ci` runs `test` instead of `test:coverage`; `packages/tests/moon.yml` `ci` deps
run `tests:unit` instead of `tests:coverage` (the `coverage` task itself is unchanged, still
runnable via `moon run tests:coverage`); `AGENTS.md` Commands + Testing rules and
`docs/TOOLCHAIN.md` Commands now state `test` is the iteration/gate default and `test:coverage`
runs only when the coverage table is the question. `.github/workflows/ci.yml` untouched —
linux/x64 `frontend` still owns the only lcov upload, so no artifact was dropped. Nothing gates
on the coverage number (the run carries no threshold), which is why removing it from the local
gate loses no signal.

Check evidence (pinned Node v26.8.2 via `mise exec node --`; `mise`'s `npm:pnpm` stub is unusable
from a raw child process on this machine — plan-notes 204 — so the exact script bodies ran under
the pinned node rather than through the `pnpm` shim):

```text
$ node --test "packages/tests/unit/*.test.ts"   # exact body of `pnpm run test`
ℹ tests 389
ℹ suites 1
ℹ pass 389
ℹ fail 0
ℹ duration_ms 11896.671917
$ node --test --experimental-test-coverage --test-coverage-include="packages/compiler/src/**" packages/tests/unit/diagnostics.test.ts
ℹ tests 5 / pass 5 / fail 0   # on-demand coverage path still works
$ oxlint --deny-warnings .            # 0 warnings, 0 errors
$ oxfmt --check package.json packages/tests/moon.yml   # correct format
```

(`oxfmt --check` over the wider lint glob flags 4 `.ts` files, all pre-existing and untouched by
this change; `.md` rewording sits outside the lint glob.)

### Task 6.5 — Pin the oracle: the ground truth is named, never inherited from the host ✅ (landed 2026-09-14)

New `packages/tests/support/node-path.ts`: `nodePath()` returns `STATOR_NODE` when set and
non-empty, else `process.execPath`, with the invariant in the file comment — oracle spawns MUST
use it, compiler-host spawns keep `process.execPath`. Migrated exactly the four oracle sites
(`golden/run.ts` `runNode`, `differential/run.ts` both oracle calls, `leak/run.ts` `expected()`,
`bench/record.ts` oracle loop); every `CLI` build/explain spawn stays on `process.execPath`, and
the four compiler-host-only files (`subset/run.ts`, `unit/helpers.ts`, `unit/cli.test.ts`,
`unit/telemetry.test.ts`) are byte-identical. `scripts/check-node.mjs` stays dependency-free and
now also probes the oracle (`spawnSync(oracle, ['--version'])`) and fails fast on probe failure
or major mismatch, with the same fix-hint style. Nuance found during the work: Bun's `--version`
reports `1.3.14`, not its `process.version` compat string (`v24.x`) — either way the probe fails
fast with the pin message, so no special-casing was needed.

Check evidence (pinned Node v26.8.2 via `mise exec node --`):

```text
$ node packages/tests/subset/run.ts
subset: 372 fixtures — 351 passed, 21 expected-fail, 0 failed
$ node packages/tests/golden/run.ts
golden: 212 fixtures — 212 passed, 0 failed
$ STATOR_NODE=/Users/listepo/.local/share/mise/installs/node/26/bin/node node packages/tests/subset/run.ts
subset: 372 fixtures — 351 passed, 21 expected-fail, 0 failed     # override honored
$ STATOR_NODE=<same> node packages/tests/golden/run.ts
golden: 212 fixtures — 212 passed, 0 failed                      # override honored
$ STATOR_NODE=/Users/listepo/.bun/bin/bun node scripts/check-node.mjs
stator: node oracle /Users/listepo/.bun/bin/bun is 1.3.14, not the pinned Node (26.7.0 from .node-version) — suites diff against the pinned Node, so a run here proves nothing
EXIT:1                                                            # fail fast, as designed
$ node packages/tests/differential/run.ts --seed=1 --count=2 --mode=ts
2 cases — 0 divergences                                           # smoke on a migrated oracle
$ node packages/tests/leak/run.ts
leak: 10M objects — peak RSS 3040 KB of a 65536 KB cap, 32 samples, plateau
```

`oxlint`, `oxfmt --check`, and `tsc --noEmit` (both projects) clean on all touched files. `bench/record.ts`
not executed (it writes results/baseline/README side effects); its oracle line is the same one-line
pattern, proved by the other three suites.

### Task 6.6 — In-process subset and golden runners ✅ (landed 2026-09-14)

`tests/subset/run.ts` calls in-process `explainFile()` instead of spawning `node main.ts explain
--json` per fixture; `tests/golden/run.ts` compiles via in-process `build()` under
`withDiagnosticCapture` (test262's pattern, including the `BuildError → exit 1 + stator: CODE
msg` mapping so failure text is unchanged). The clang link still spawns (inside `build()`), both
executes stay spawned, the oracle uses Task 6.5's `nodePath()`. `tests/support/parallel.ts`
untouched — pool width, `STATOR_TEST_JOBS`, and fixture-indexed results unchanged. The golden
runner sets `process.env['TZ'] = 'UTC'` in-process since no spawn carries `PINNED_ENV` anymore
(same pin, one layer up). No new dependencies; `dupes` clean on the touched files.

The landing run exposed a latent compiler defect (full story: plan-notes 242): `block_scope.js`
failed with spurious `STA4020`, deterministically, only when compiled in-process after
`named_function_expression.js` — `immutableSelfBindings` in `src/lower/index.ts` was never reset
between `lowerProgram` calls. Fixed in the same change (`immutableSelfBindings.clear()` plus
`bindTempId` and scope.ts's `shadowCounter` resets via a new `resetShadowCounter()` export —
fresh-process parity: same input → same HIR names → same C). Two compiler lines of behavior,
eleven of comment.

Check evidence (pinned Node v26.8.2 via `mise exec node --`):

```text
$ node packages/tests/subset/run.ts
subset: 372 fixtures — 351 passed, 21 expected-fail, 0 failed     # wall 10.6 s (spawned ~21 s)
$ node packages/tests/golden/run.ts
golden: 212 fixtures — 212 passed, 0 failed                      # wall 41.6 s
```

`tsc --noEmit` (both projects), `oxlint`, `oxfmt --check` clean on every touched file (the one
`oxfmt` complaint in `lower/index.ts` is pre-existing drift in three unrelated hunks — left
alone). Failure-path parity: an invalid directive still surfaces per fixture from the untouched
`parseDirectives`, and the two on-disk `intl_*` fixtures still skip by default. Known residue of
the new transport, not fixed here: raw clang `ld: duplicate symbol '_jsrt_array_new'`
(`jsrt_value.o` vs `jsrt_zig.o` in the current archive) now reaches the terminal instead of dying
in a per-fixture capture — links succeed; the archive belongs to T9.1's tree.

### Task 6.7 — `cli.test.ts` spawns in parallel ✅ (landed 2026-09-14)

Mechanical `execaSync → execa` conversion (all 16 tests; the spawn-free `bin`-name test stays
sync), every assertion byte-identical, `NATIVE_ONLY` and per-test `mkdtempSync` dirs unchanged.
`Promise.all` overlaps exactly the three tests with independent spawns (missing-entry
build+explain, ts+js provenance explains, STA1002 explain+build); the four build-then-run tests
stay ordered with an inline note each. No pool: max introduced concurrency is 2, so a semaphore
would be review surface without scheduling benefit (plan-notes 242 records the reason the card's
pool clause was not built).

Check evidence: `node --test packages/tests/unit/cli.test.ts` → 16 pass, 0 fail, wall **8.9 s**
on a quiet box (11.4 s pre-change baseline under different load — directionally better; the
overlap itself is worth ~2–3 spawn latencies). `tsc`, `oxlint`, `oxfmt --check` clean.

### Task 6.9 — Key the program cache on content, not mtime ✅ (landed 2026-09-14)

`createProgram` (`src/frontend/program.ts`) now keys its single-entry cache on
(path, mode, sha256 of the entry bytes) instead of (path, mode, mtimeMs); the `statSync`
import left with the mtime it served. New `tests/unit/program-cache.test.ts` pins the mtime
to a whole-second constant and swaps the bytes — proved red against the old key (stale hit,
`fail 1`) and green against the hash. Debugging note kept with the test: a raw
`statSync().mtimeMs` float does NOT round-trip through `utimesSync` (sub-millisecond
truncation), so the first version of this test passed against the old code for the wrong
reason; whole-second constants compare `===` exactly. Full audit in plan-notes 245 (only
test262 reuses paths; subset/golden safe by unique paths, differential/leak by process
isolation; the admitted dependency-hole stays).

Check evidence: the new test 1/1; `test:subset` 372 — 351/21/0; unit 390/390; `tsc --noEmit`
(both projects), `oxlint`, `oxfmt --check` clean on both touched files.

### Task 6.8 — Stop paying for the duplicate ASan golden pass ✅ (landed 2026-09-14 as option (a))

New `packages/tests/golden/asan-gate.ts`: stages 1–2 (`runtime-asan`, `runtime-test-asan`) run
unconditionally, then a sha256 over the outcome-determining inputs decides whether stage 3 (the
duplicate golden pass) runs. Two load-bearing deviations from the card, both now in-code
comments: the gate hashes sorted member names + `ar p` member bytes, NOT the archive bytes —
BSD `ar`'s derived `__.SYMDEF` index embeds a fresh timestamp per archival, so four no-change
rebuilds hashed four ways with identical members (a byte-hash gate would never skip); and the
Check's "a touch re-triggers" is redefined as content-change re-triggers (a `touch` rebuilds
byte-identical objects, which a content gate must skip — sensitivity proven with a real comment
change instead). Record: `packages/tests/.asan-last-green.json` (gitignored, tmp+rename, written
only on green, never on skip/red) holding hash/commit/counts/inputs. `STATOR_ASAN_FORCE=1`
forces full; CI sets it, so CI coverage is unchanged — the skip fires only on local iteration.
Wiring: `package.json` + moon `asan` scripts invoke the gate; 6 unit tests cover hash/compare/
record/force/skip-line. Counts are 214 (212 at card time + 2 step-17 goldens).

Check evidence: forced full green (`runtime-asan` + corpus match + `golden: 214 — 214 passed`,
record written); immediate rerun exits 0 in ~8 s with hash+skip evidence; comment-change
re-triggers, `touch` correctly skips; post-restore rerun reproduces the pristine hash exactly.

### Task 6.10 — The differential oracle never records what it cannot reproduce ✅ (landed 2026-09-14)

`finding()` re-checks `sameResult` on the final minimized run and drops transients (a timeout
finding re-runs once; the confirming run is the recorded evidence); timeouts stay divergences
for the run itself. The minimizer's paren rewrite no longer eats call parentheses (lookbehind
for identifier chars — `console.log(0);` survived; `(1+2)` still folds). 12 stale `failures/ts-*`
artifacts deleted case-by-case (byte-identical node/stator outputs or corrupted `console.log0`
minimizes); the gitignored dir is empty. Drive-by in the same files: `result.error?.code` did
not typecheck (`Error` has no `code`; invisible to every gate — the harness is excluded from
tsconfigs, lint, and jscpd) — narrowed through `in`, proven with direct strict `tsc` on both
harness files.

Check evidence: seed 58 → 0 divergences, `failures/` empty; `--seed=1 --count=50 --mode=both` →
100 cases, 0 divergences; minimized outputs recompile.

### Task 6.13 — The golden runner reports its skipped `intl_*` fixtures ✅ (landed 2026-09-14)

`skippedIntlCount()` in `tests/golden/run.ts` counts `intl_*` entries neither mode compiled;
a default run now prints `golden: SKIPPED 2 intl_* fixtures (…)` beside the pass line, mirroring
`leak: SKIPPED`. Gate unchanged (verified: default run still `214 — 214 passed, 0 failed`).

### Task 6.14 — A checker stack overflow fails its test, never its shard ✅ (landed 2026-09-14)

`buildInProcess`'s catch in `tests/test262/run.ts` converts a checker-stack `RangeError`
(`/call stack/i`; OOM rethrows) to `{ status: 1, stderr: 'stator: STA4072 … checker stack
overflow' }`, which classifies as failed on every path — pool invariants and `finally` cleanup
intact, zero behavior change for non-crashing tests.

Check evidence: synthetic mini-corpus dies raw without the guard, reports `0 passed, 0 skipped,
1 failed` with it; full shard 1 completes (305 passed, 6000 skipped, 393 failed of 6698,
exit 0) where it deterministically died before; `--shard=1/200` shape unchanged (13/238/17).

### Task 6.11 — The duplication gate is green, and sees the differential harness ✅ (landed 2026-09-14)

Code top-3 extracted (`checkMethodReceiver`, call-shape emitter helpers,
`lowerReceiverCall`/`padToArity` — 97 → 68 clone entries); CI repetitions anchored
(322 → 302 lines, effective-equality proven); runtime C micro-clones unified
(22 → 8 entries in `runtime/src`); differential ignore narrowed to artifacts
(`corpus/`, `failures/`), the three harness sources scanned; unit-test helpers
extracted (+95/−129 lines, 396/396 tests preserved). Threshold untouched per the card.
Markdown prose echo (TOOLCHAIN/done/plan quotations, historical Check evidence, intentional
doc mirrors) deliberately NOT rewritten: editing the archive to satisfy the detector would
trade honesty for a number, and every remaining pair carries a documented reason. The card's
own step-1 doc-table half is therefore closed by decision, not by edit — recorded here so a
reopen has the full picture.

Check evidence: `pnpm run dupes` exits 0 (`68 clones · 0.7%`); scan output names
`differential/run.ts` among analyzed files.

### Task 6.17 — Test impact: build and run only what a change reaches ✅ (landed 2026-10-02; step 4, CI, still open in plan.md)

The card as written (plan-notes 293):

Creator's
direction (2026-10-02). On a pull request and locally, run only the tests whose execution reaches
a changed line — through the TypeScript compiler and on down into the C/Zig runtime the compiled
binaries link. `main` and the nightly keep the full run: it records the map, and it is what
catches a selection bug. Plain `pnpm run test` and `pnpm run ci` are unchanged.

1. **The map** (`impact-map.json`, written by a full run with `STATOR_IMPACT_RECORD=<dir>`, never
   committed) records, per test — a unit test file, a subset fixture, a golden fixture, or a whole
   harness — with the commit, the Node version and the platform it was recorded on:
   - **TypeScript:** every function the test executed, as line spans of its file. Unit files run
     under `NODE_V8_COVERAGE`, which also covers the CLI processes the tests spawn. The in-process
     runners (subset, golden) use `node:inspector`'s precise coverage: one take after loading,
     then one take-and-reset per fixture, run serially. Verified on Node 26.7.0: after a reset, a
     take reports only the functions the fixture ran, and loading reports what loading ran.
   - **Native:** the runtime archive members the fixture's binary linked — its defined symbols
     (`nm`) against each member's (`nm -A libjsrt.a`) — expanded to the sources and headers each
     member depends on, read from the build's `-MMD` sidecars.
2. **The diff** is `git diff <map commit>` (working tree included). TypeScript files are compared
   after `module.stripTypeScriptTypes`, which keeps every offset, so a type-only edit selects
   nothing. A change inside a function selects the tests that executed it. A change outside every
   function (module scope), or in a function that ran while its module loaded, selects every test
   that loaded the file. A change in a runtime source or header selects the tests whose binary
   linked a member depending on it.
3. **Whole-harness triggers:** the lockfile, `package.json`, `tsconfig*.json`, the vitest config,
   `.node-version`, `mise.toml`, the runtime justfile, `packages/tests/support/**` and a runner's
   own script select that whole harness, or everything if they are shared.
4. **New tests always run:** a test file or fixture that is not in the map.
5. **Fall back to the full run, out loud:** no map, a map commit that is not an ancestor of
   `HEAD`, another Node or platform, or another schema version. The selector prints what it chose
   and why. Selecting zero tests is a result it reports, never a silent pass.
6. **Build only what is needed:** the runtime is built (already incremental through `-MMD`) only
   when a selected test links it. CI caches `packages/runtime/build` keyed on the runtime's
   sources.

Steps: (1) `packages/tests/support/impact.ts` — map schema, diff and selection, pure, with unit
tests. (2) Recorders in the unit, subset and golden runners, plus harness-level records for
`test:runtime`, `test:leak`, `test:asan`, `test:ffi` and `test:builtins`. (3) `--only=<file>`
selectors on the subset and golden runners, and `pnpm run test:impact [<base>]`, which drives
every harness with its selection and replaces `test:affected`. (4) CI, after PR #45's staged
pipeline: `main` and the nightly record and upload the map; pull requests download the newest
`main` map and run `test:impact`. (5) Docs: AGENTS.md commands and Testing rules, `docs/TOOLCHAIN.md`.

**Check:** (a) soundness by mutation: for 20 seeded mutations (a compiler function's body
replaced by a `throw`, one runtime C function made to `abort()`), every test the full run fails is
in the selection; (b) a type-only edit selects 0 tests; (c) an edit to one function in
`jsrt_date.c` selects only fixtures whose binary links `jsrt_date.o`; (d) a missing map, or one
from a commit that is not an ancestor, falls back to the full run with the reason printed; (e)
on a one-function compiler change, `test:impact` runs well under the full suite's wall time
(measured, numbers in plan-notes).

What landed: `packages/tests/support/impact.ts` (map schema 1, diff, selection — pure, 20 unit
tests in `unit/impact.test.ts`); `packages/tests/impact/` — `preload.ts` + `recorder.ts` (V8
precise coverage, `node:fs` read hooks, `nm` after every runtime link), `coverage.ts`,
`native.ts`, `record.ts` (`pnpm run test:impact:record`), `run.ts` (`pnpm run test:impact`),
`mutate.ts` (Check (a)); `--only=<file>` on the subset and golden runners; `test:affected` removed.
Design deviations are in plan-notes 293 → "Landed".

Check evidence (Node 26.7.0, darwin-arm64, 16 cores; map recorded at 7a992cc in 224 s, 3.1 MB):

- **(a)** `node packages/tests/impact/mutate.ts` (seed 6017): 20 compiler functions (`throw new
  Error('mut')`) + 3 runtime C functions (`__builtin_abort()` in `jsrt_date_new`,
  `jsrt_string_length`, `jsrt_regexp_test`), each followed by the full unit, subset and golden
  runs (and the runtime corpus for C): `23 mutations (seed 6017), 23 broke at least one test, 0
  unsound, 1506 s`. Example rows (failed/selected): `lower/index.ts staticAccessorCall` unit 1/2,
  subset 5/5, golden 5/5; `ffi-gen/abi.ts mapStructPointee` unit 1/2, nothing else;
  `codegen/index.ts icSite` unit 3/17, subset 0/744, golden 79/397; `jsrt_regexp_test` golden
  4/397, unit 0/8.
- **(b)** `renderDiagnostic(d: DiagnosticSite)` → `(d: Readonly<DiagnosticSite>)`: every harness
  `0 of N selected — nothing to run`.
- **(c)** an edit inside `jsrt_date_to_json`: golden 397/397, asan 397/397, unit 8/45, leak, ffi,
  runtime; subset, builtins, node-coverage 0. Every golden binary links `jsrt_date.o` (`jsrt_print`
  references `jsrt_class_date` and `jsrt_date_to_json`; even `console.log(1)` links them), so the
  selection is exactly "fixtures whose binary links `jsrt_date.o`" and that is all of them. The
  same edit in `jsrt_json.c` selects golden 10/397, asan 10/397, unit 0.
- **(d)** `--map=<missing>` → `impact: FULL RUN — no map at … (record one: pnpm run
  test:impact:record)`; a foreign commit → `FULL RUN — map commit 0123456789ab is not an ancestor
  of HEAD`; `node: v24.0.0` → `FULL RUN — map was recorded on Node v24.0.0, this is v26.7.0`;
  `dirty: true` → `FULL RUN — map was recorded on a dirty tree`; a lockfile edit → every harness
  `all selected (pnpm-lock.yaml → whole-run trigger)`.
- **(e)** one-function change in `lower/index.ts` (`staticAccessorCall`): `pnpm run test:impact`
  ran unit 2/45, subset 5/744, golden 5/397, asan 5/397 in **14.8 s** (`6 step(s), 0 failed`);
  the full run through the same driver (`--map=/nonexistent.json`): **223.4 s** (unit 23.3,
  runtime 9.7, subset 6.9, golden 37.5, ffi 4.3, leak 24.7, asan 116.0).

Re-checked after rebasing onto `main` at eb27394 (the std package; the suite is now unit 47
files, subset 761, golden 402), with the map re-recorded there (217 s): a second mutation run
`mutate.ts --seed=293 --count=8 --native=2` → `10 mutations (seed 293), 10 broke at least one
test, 0 unsound, 538 s`; (b) still 0 selected in every harness; (e) the same one-function change
ran unit 2/47, subset 5/761, golden 5/402, asan 5/402 in 22.7 s (now also building
`libjsrt_std.a`).

Gate: `tsc` (compiler, tests, std), `oxlint --deny-warnings`, `oxfmt --check`, `cpd` clean; vitest
47 files / 627 tests, subset 761 (724 passed, 37 expected-fail), golden 402 passed.

### Task 6.18 — `stator.config.json`: every CLI option in one validated file ✅ (landed 2026-10-02)

(creator's direction 2026-10-02, plan-notes 303). Stator works both with a config file and without
one. Every option a command takes can come from the file, from the command line, or from both.

1. **The file.** It is `stator.config.json`, JSON only: no code runs to read it, and §0.10 holds.
   Without `--config`, Stator reads `./stator.config.json` from the current directory if it
   exists. `--config=<path>` reads that file instead, and a missing file is an error.
   `--no-config` skips the file. `--config`, `--no-config`, `--help` and `--version` are the only
   flags with **no** key in the file: a config cannot name a config.
2. **Keys.** One key per flag: `entry`, `out`, `mode`, `opt`, `link` (array), `emit`, `keepC`,
   `emitHeader`, `unitName`, `diagnostics`, plus `$schema`. Planned flags get their keys in the
   same change as the flag: `node` (T11.5), `bundler` (T12.1), `renderer` (T13), `interpreter`
   (T14). Unknown keys are errors (`additionalProperties: false`), so a typo cannot pass silently.
   Paths are resolved against the config file's directory; command-line paths against the current
   directory.
3. **Precedence.** Command line, then environment (`STATOR_OPT`, …), then the config file, then
   the built-in default. `link` from the file and from the command line are concatenated, file
   first.
4. **Schema and validation from one source.** The JSON Schema is generated from the config's type,
   committed at `packages/compiler/schema/stator.config.schema.json`, and checked by a drift test
   in `pnpm run test`. One module (`src/cli/config.ts`) owns finding, loading and validating the
   file (AGENTS.md, Config files). Pick the best ready solution before writing a validator (for
   example zod 4 with `toJSONSchema`, TypeBox, or `ts-json-schema-generator` with ajv). Record the
   choice and why in the plan-notes entry. Any runtime dependency stays inside `src/cli/` (§0.9).
5. **Diagnostics.** Errors are reported as `STA0xxx` codes from the free range, allocated in
   `docs/DIAGNOSTICS.md`. There are three cases: the file cannot be read or is not valid JSON
   (message includes line and column), the file does not match the schema (message includes the
   JSON pointer and the expected type), and `--config` names a missing file. None of them is a
   stack trace.
6. **Docs.** A new `docs/CONFIG.md` covers the keys, precedence, discovery and an example, and
   `docs/README.md` lists it. `--help` mentions `--config` and `--no-config`. AGENTS.md gets a rule:
   every new CLI flag lands with its config key and a regenerated schema in the same change.

**Check:**
- Unit tests cover every key from the file alone, every key overridden from the command line,
  `--no-config`, a missing `--config` path, invalid JSON, a schema violation and an unknown key.
  Each error case asserts its `STA` code.
- The drift test fails after a hand edit of the schema.
- `build` and `explain` with no config file behave byte-for-byte as before: all subset and golden
  runs pass unchanged.

**Check — PASSED** (2026-10-02, `pnpm run ci` exit 0 on Node 26.7.0, after merging main at
ce66355):

- **Unit tests** (`packages/tests/unit/config.test.ts`, 14 tests; the whole suite is 621/621 in
  47 files). They cover:
  - every key read from the file alone, with paths resolved against the file's directory;
  - every key overridden from the command line, including `--emit=binary` and
    `--diagnostics=text`, with `link` concatenated file-first;
  - `STATOR_OPT` between the command line and the file;
  - the built-in defaults when there is no file;
  - `--no-config` over a broken file;
  - `--config` with a relative path;
  - a missing `--config` path → `STA0018`;
  - invalid JSON, trailing commas and a directory → `STA0016`, with `path:line:column`;
  - schema violations → `STA0017`, with JSON pointers and the expected types;
  - unknown keys, including `config`, `noConfig`, `help` and `version` → `STA0017`;
  - an end-to-end `explain` spawn proving the `parse()` wiring.
- **Drift test.** It fails after a hand edit of the schema. Measured: adding `"py"` to
  `/properties/mode/enum` in the committed file gave `× drift: the committed schema equals the
  one config.ts generates`, and restoring the file made it pass again.
- **No config file, unchanged behaviour.**
  - subset: 761 fixtures, 724 passed, 37 expected-fail, 0 failed;
  - golden: 402/402 (2 `intl_*` skipped as designed);
  - runtime print corpus matches Node, plain and ASan;
  - builtins 223/238;
  - `docs/NODE.md` is current;
  - leak plateaus: 3632 KB and 3664 KB of a 65536 KB cap;
  - golden-asan 402/402.
- **Gate.** `typecheck`, `lint` and `dupes` are clean, with no new clones.

Libraries: `typebox` 1.3.34 and `jsonc-parser` 3.3.1. Why each was chosen is recorded in
plan-notes 303.

### Task 6.19 — Stator compiles itself and its own packages: a self-compilation test ✅ (landed 2026-10-02)

Creator's direction 2026-10-02 (plan-notes 304). The record of the landing is plan-notes 306. The
card's standing rules (targets, ratchet) and the stage-2 check, which is not built yet, stay in
plan.md.

**What landed:**
- `pnpm run test:selfhost` (`packages/tests/selfhost/run.ts`) runs `stator explain --json` for
  each target, in parallel, from the target package's own directory. That package's
  `stator.config.json` supplies the mode, and for the compiler the entry: the command a user would
  run (card point 5).
- **Targets** are listed in `packages/tests/selfhost/targets.json`:
  - `packages/compiler`;
  - each `packages/std/src/*.ts`;
  - `notTargets`: `packages/runtime` (C and Zig) and `packages/tests` (Node harnesses), each with
    its reason.

  Every directory under `packages/` must be one or the other.
- **Ratchet.** `packages/tests/selfhost/baseline.json` holds each target's verdict and its count
  per code. The logic is in `ratchet.ts`. The test fails on a raised count, a new code, a worse
  verdict, a target missing from the baseline, or a shrink that `--update` has not recorded.
- **Smoke.** Targets whose verdict is `static` or `dynamic` build: each `std` module is built with
  `stator build` and its binary runs. Then the `std_*` goldens run. A `stage2` target that reaches
  `static` or `dynamic` fails until its stage-2 check exists.
- **Wiring.** `test:selfhost` is in `pnpm run ci` after `test:golden`, in the GitHub `runtime`
  jobs and in `moon run tests:ci` (`tests:selfhost`, which depends on `runtime:build` and
  `std:build`). The README, AGENTS.md, `docs/HOW-IT-WORKS.md` and `docs/TOOLCHAIN.md` list the
  command.
- **Fixes:**
  - `FirstNode` → `syntaxKindName` in `src/support/diagnostics.ts`. It is used by the gate's
    catch-all, by `lower/index.ts` and by `frontend/export.ts`.
  - The two implicit `any[]` callbacks in `src/cli/config.ts` were turned into `unknown[]`. They
    made the compiler's verdict `error` (2 × STA1003).

**Baseline** (main `31e7b52` + this change; unchanged on `5e53d26`):
- `packages/compiler`: `not-yet`, 2 549 × `STA1214`.
- `std/env.ts`: `dynamic`.
- `std/{fs,path,process,time}.ts`: `static`.

**Check:**
- **`pnpm run test:selfhost` passes against the committed baseline.** It took 38.0 s, 47.1 s and
  53.1 s on darwin/arm64, at a load average of about 70.
  - It fails on a hand-raised count (`a hand-raised count fails`) and on an unlisted workspace
    package (`an unlisted package fails`).
  - `packages/tests/unit/selfhost.test.ts` has 13 tests.
- **`std` builds and its smoke check runs:** 5 modules built and run, then `golden: 6 fixtures — 6
  passed, 0 failed`.
- **The `FirstNode` message names the real syntax kind.** The 1 134 diagnostics now read
  `this construct (QualifiedName)`, and the baseline was re-recorded.
  - Unit tests: `syntax kinds are named by the kind, not by a range marker` and `the not-yet
    message for a qualified type name says QualifiedName`.
- **`pnpm run ci`** exit 0 on main `5e53d26` + this change:
  - unit 665/665 in 50 files;
  - subset 769 fixtures: 732 passed, 37 expected-fail, 0 failed;
  - golden 405/405 (2 intl skipped);
  - selfhost 6 targets match (39.0 s: explain 29.1 s, smoke 9.9 s);
  - builtins 234/294;
  - NODE.md current;
  - leak 3632 KB and 3696 KB of a 65536 KB cap;
  - golden-asan 405/405.
- **Gate.** `typecheck`, `lint` and `dupes` are clean, with no new clones.

The card as it stood before landing:

> **Task 6.19 — Stator compiles itself and its own packages: a self-compilation test — [D3]**
> (creator's direction 2026-10-02, plan-notes 304). The compiler must compile itself, and the
> packages written for programs to import (`std`, `node`, `webapi`, `interpreter`) must compile too.
> For now this is a **test**, not a shipped feature. It tracks progress and never lets it slip back.
>
> 1. **Targets.** Every workspace package written for Stator to compile. Today those are
>    `packages/compiler` (entry `src/cli/main.ts`, `ts` mode) and `packages/std` (each `src/*.ts`).
>    `packages/node` (T11.6), `packages/webapi` (T13.1), `packages/renderer-clay` (T13.4) and
>    `packages/interpreter` (T14.1) join when they are created. The cards that create them add the
>    package to this test in the same change. The target list is checked in next to the baseline,
>    and a workspace package that is neither listed nor marked "not a target" fails the test.
> 2. **What a run does.** `stator explain <entry> --json` per target, tallying the deciding
>    stage's diagnostics by code (plan-notes 291). A target whose verdict is `static` or `dynamic`
>    then goes through `stator build`, and the binary runs that package's own smoke check. For
>    `std`, that check is its goldens. For the compiler, the binary compiles a hello-world fixture
>    and its C output must be **byte-identical** to the C the Node-hosted compiler emits: the
>    stage-2 bootstrap check.
> 3. **Ratchet.** `packages/tests/selfhost/baseline.json` holds, per target, the verdict and the
>    count per diagnostic code. The test fails when any count grows, a new code appears, or a
>    verdict gets worse. When a count shrinks, `--update` rewrites the baseline in the same change,
>    as `.jscpd-baseline.json` does (Task 6.16). Reaching zero for a target is that target's
>    milestone. From then on, its build and smoke check are part of the gate.
> 4. **Cost.** One `explain` of the compiler takes about 35 s on the dev host (below). The test runs
>    in `ci` if the whole run stays under 60 s on that host; otherwise it runs nightly and on PRs
>    that Task 6.17's impact selection says reach `packages/compiler` or the target packages. The
>    choice and the timing go in plan-notes.
> 5. **Config.** Each target's mode and entry come from its own `stator.config.json` (Task 6.18)
>    once that lands, so the test runs the same command a user would.
>
> **Baseline measured 2026-10-02** (main `f8db9eb`, darwin/arm64, `explain --json`):
> - **Compiler, `ts` mode:** `not-yet`, 2 522 × `STA1214`, 34.8 s. The top families are:
>   - 1 127 — an unsupported construct whose message prints the syntax kind as `FirstNode`. That is
>     an enum alias, so the message names the wrong kind: a diagnostics bug to fix with this task.
>   - 915 — method calls.
>   - 158 — unsupported globals.
>   - 52 — index access on a non-array.
>   - 52 — `for-of` over a user iterable.
>   - 47 — object spread without a fixed shape.
>   - 32 — package imports (`typescript`).
> - **Compiler, `js` mode:** `not-yet`, 2 586 × `STA1214`, 41.8 s.
> - **`packages/std`:** `env.ts` is `dynamic`; `fs.ts`, `path.ts`, `process.ts` and `time.ts` are
>   `static`.
>
> **Check:**
> - `pnpm run test:selfhost` passes against the committed baseline. It fails on a hand-raised count
>   and on an unlisted workspace package.
> - `std` builds and its smoke check runs.
> - The `FirstNode` message names the real syntax kind, and the baseline is re-recorded.

### Task 6.20 — `build` never destroys an input and never calls a user's mistake a compiler bug ✅ (landed 2026-10-04)

From the 2026-10-01 QA audit (draft PR #57, findings F1, F2, F10, F11; plan-notes 330). The
landing is plan-notes 331.

> **Task 6.20 — `build` never destroys an input and never calls a user's mistake a compiler bug
> (F1, F2, F10, F11).**
>
> - **F1.** `build()` (not only `main.ts`, so in-process callers are covered) resolves `entry`, every
>   program source file, `out`, `emitHeader`, and `<out>.c` under `--keep-c`. It refuses any two
>   that name the same file with `STA0004` before compiling.
> - **F2.** One `writeOutput(path, text)` helper turns `ENOENT`/`EACCES`/`EROFS`/`ENOSPC`/`EISDIR`
>   into a user error with a new code (the next free `STA00xx`, allocated in `docs/DIAGNOSTICS.md`).
>   The link step checks `dirname(out)` before it blames the compiler (`linkFailure`).
> - **F10.** An explicit `--unit-name` (and its config key) must match `^[A-Za-z0-9_]+$`, else
>   `STA0004`. A derived default is still sanitized.
> - **F11.** A value flag refuses a next argument that starts with `-` (`-o --emit=c` is `STA0004`).
>   Each command accepts only its own flags (`explain --emit=c` is refused). A bad `STATOR_OPT`
>   names the environment as its origin.
>
> **Check:** the audit's F1, F2, F10 and F11 tests pass in `packages/tests/unit/cli.test.ts`;
> `docs/CLI.md`/`docs/DIAGNOSTICS.md` list the new refusals; `pnpm run ci` green.

**What landed.**

- **F1.** `src/cli/outputs.ts` `refuseAliasedOutputs`: `build()` compares `-o`, `--emit-header` and
  the `--keep-c` file (`<out>.c`, only when clang runs) with each other and with the entry before
  compiling, then with every source file of the program (`CompiledC.inputs`) before the first
  write. An existing file is compared by inode (`dev:ino`, bigint), so a symlink, a hard link or a
  case-folding file system cannot hide an alias; a new file by its canonical directory plus name.
- **F2.** `writeOutput` and `requireWritable` turn `ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`,
  `EPERM`, `EROFS` and `ENOSPC` into the new `STA0019` (`cannot write -o "missing/out.c": ENOENT
  (the directory does not exist)`). `-o`'s directory is checked before clang runs, so the link
  never blames the compiler for it. Any other write error is still `STA4072`.
- **F10.** An explicit unit name outside `^[A-Za-z0-9_]+$` is `STA0004`, from the flag, the config
  key or an in-process caller. The default (the entry basename) is still sanitized. The
  `export-header` collision test now gets its unsanitized unit from the entry name `my-lib.ts`.
- **F11.** The parser in `src/cli/main.ts` is one flag table with the commands each flag belongs
  to. A value flag refuses a next argument that starts with `-` and suggests `--flag=value`
  (`--link -lm` → `--link=-lm`); a flag on the wrong command is `STA0005 flag "--emit=c" does not
  apply to explain`; `STATOR_OPT=fast` reports `unknown opt "fast" in the environment variable
  STATOR_OPT`. An empty `--mode=`/`--opt=` is now `STA0004` (requires a value), like the others.

Docs: `DIAGNOSTICS.md` (`STA0002`, `STA0004`, `STA0005`, new `STA0019`), `CONFIG.md` (flags per
command, the Outputs section, the `unitName` row), `FFI.md` (unit name), `TOOLCHAIN.md`
(`STATOR_OPT`). There is no `docs/CLI.md`; the CLI surface is documented in `CONFIG.md`. The
selfhost baseline grew by 4 `STA1214` in `packages/compiler` (1791 → 1795), recorded with
`--update` (plan-notes 306).

**Check — PASSED** (2026-10-04, branch `t6-20-cli-outputs` on `3aeb9dd`):

- The audit's tests, adapted, in `packages/tests/unit/cli.test.ts` (F1: entry, header, imported
  module, `--keep-c`, in-process `build()`; F2: `--emit=c`, binary, header, directory; F10; F11:
  value flags, per-command flags, `STATOR_OPT`): 9 passed.
- `pnpm run ci` → exit 0: typecheck, lint, dupes (186 clones, none new), runtime, unit
  (`Tests  743 passed (743)`), runtime corpus, subset (`921 fixtures — 888 passed, 33
  expected-fail, 0 failed`), golden (`453 fixtures — 453 passed, 0 failed`), selfhost (14 targets
  match the baseline), builtins 255/324, node-coverage, leak (plateau), ASan (453/453).

### Task 6.21 — The runtime selection and the toolchain come from the real environment ✅ (landed 2026-10-04)

From the 2026-10-01 QA audit (draft PR #57, findings F3, F4; plan-notes 330). The landing is
plan-notes 332.

> **Task 6.21 — The runtime selection and the toolchain come from the real environment (F3, F4).**
>
> - **F3.** The runtime flavor, root and archive are resolved once per `build()` call, inside it,
>   and the same value feeds the gate (`intlEnabled`) and the link. No module-level `const` reads
>   `STATOR_RUNTIME*` at import time. `link()` asserts the gate's flavor equals the archive's.
> - **F4.** A project `.env` (loaded from the working directory) may set only an allowlist:
>   `STATOR_OPT`, `STATOR_RUNTIME` and `STATOR_OTEL`. It never sets `CC`, `STATOR_RUNTIME_ROOT`
>   or any `OTEL_*` exporter variable; those come from the real environment only. When `.env`
>   applies keys, one stderr line names them. After clang exits 0, `compileObject` and `link`
>   check that the output file exists.
>
> **Check:** the audit's F3 and F4 tests pass; `docs/TOOLCHAIN.md` and `docs/CONFIG.md` describe the
> allowlist; `pnpm run ci` green.

**What landed.**

- **F3.** `build.ts` has no module-level runtime `const` any more. `resolveRuntime()` (flavor, root,
  include, lib dir, archive) runs once per `build()` call, after the CLI applied `.env`.
  `support/features.ts` gains `withRuntimeFlavor`: `build()` pins the resolved flavor
  (AsyncLocalStorage, so concurrent in-process builds keep their own) around `compileToC`, so the
  gate's `intlEnabled()` reads the same value the link uses. `compileToC` records the flavor it
  gated with (`CompiledC.flavor`), and `link()` throws (an internal error, `STA4072`) when it
  differs from the archive's. `linkArguments` takes the runtime as an optional last argument.
- **F4.** `src/cli/env-file.ts` replaces `dotenv.config()`: it parses `./.env` and copies only
  `STATOR_OPT`, `STATOR_RUNTIME` and `STATOR_OTEL`, never over a real variable. One stderr line
  names what it applied, and the `CC`/`STATOR_*`/`OTEL_*` keys it refused (`stator: .env: applied
  STATOR_OTEL; ignored OTEL_EXPORTER_OTLP_ENDPOINT (only STATOR_OPT, STATOR_RUNTIME, STATOR_OTEL may
  come from .env)`). Other keys are not read. An unreadable `.env` is a warning, not a failure.
  After clang exits 0, `compileObject` and both link attempts check that the output exists
  (`STA0009 C compiler "…" exited 0 but wrote no "…"`).
- The telemetry test that took the OTLP endpoint from `.env` now proves the opposite: `.env`
  switches tracing on, and the spans reach the real environment's endpoint, not the file's.

Docs: `TOOLCHAIN.md` (new section "Environment variables and `.env`"), `CONFIG.md` (precedence),
`DIAGNOSTICS.md` (`STA0009`'s second template). The selfhost baseline grew from 1804 to 1813
`STA1214` in `packages/compiler`, recorded with `--update` (plan-notes 306).

**Check — PASSED** (2026-10-04, branch `t6-21-env-trust` on `5f8e7e6`):

- The audit's F3 and F4 tests, adapted, in `packages/tests/unit/cli.test.ts`: `.env`
  `STATOR_RUNTIME=intl` reaches the link (`STA0011 … build-intl` without the ICU archive, a working
  binary with it); an in-process `build()` honours a `STATOR_RUNTIME_ROOT` set after `build.ts` was
  imported; a `.env` `CC` is never run and `STATOR_RUNTIME_ROOT`/`OTEL_*` in it are ignored and
  named; `.env` `STATOR_OPT` applies and the real environment wins; a `CC` that exits 0 without
  output fails both the link and the object compile. Plus `unit/telemetry.test.ts`.
- `pnpm run ci` → exit 0: typecheck and lint clean; `dupes` 186 clones (none new);
  unit 758/758; subset 929 fixtures (898 passed, 31 expected-fail, 0 failed); golden 455/455;
  selfhost 14 targets match the baseline; builtins 255/324; `docs/NODE.md` current; leak plateau
  (objects peak RSS 3728 KB, FFI strings 3776 KB).

### Task 6.27 — A user-defined `toString`/`valueOf` is honored when an object becomes a string ✅ (landed 2026-10-04)

What landed (plan-notes 345; docs/NUMERIC.md §7, docs/SUBSET.md):

- `jsrt_to_primitive(v, hint)` (`runtime/src/jsrt_ops.c`) follows ECMA-262 §7.1.1.1
  OrdinaryToPrimitive. Each method is looked up with `jsrt_user_get` (`jsrt_shape.c`): an own
  field, a literal method, a class method (inherited too) or a constructor's prototype method.
  A hit is called with the object as `this` (`jsrt_call_with_this`). A miss is the builtin's
  method, modelled. A Date's `default` hint reads as `string`. Callers pass the hint:
  - `jsrt_to_string`: `string`;
  - `+` and `==`: `default`;
  - `jsrt_to_number` and the comparisons: `number`.
  `join`, `concat`, the default `sort` and `parseInt` stop at a throw.
- Codegen (`codegen/index.ts`) follows every conversion of a value that may be an object
  (`hTypeConversionRunsUserCode`) with a pending check. The numeric operators convert their
  operands in rooted slots, left then right.
- Lowering (`userConversion`, `lower/index.ts`) turns a template hole, `String(x)` and a `+`
  operand into a direct or virtual call when the receiver's class declares the first-tried
  method with no parameter and a primitive return.
- `%s`/`%d`/`%i`/`%f` follow Node's `hasBuiltInToString`. The 47-name `builtInObjects` copy is
  re-measured by `unit/to-primitive.test.ts`. The gate's three STA1214 format refusals are lifted.
- `emitErrorCell` falls back to the builtin text when the thrown object's own `toString` throws.

Check evidence:

- Goldens `golden/ts/to_primitive.ts` and `golden/js/to_primitive.js` match Node byte-for-byte.
  They cover every site, class/literal/inherited/prototype methods, a throwing method caught by
  `try` (before the right operand converts), the object-returning `TypeError`, a skipped
  non-callable method and the format placeholders.
- Decision tests `subset_to_primitive_{ts,js}` and `subset_console_format_user_tostring_{ts,js}`
  (the ts one flipped from not-yet to static).
- `pnpm run ci` → exit 0:
  - dupes 183 clones, none new;
  - unit 763/763;
  - runtime print corpus matches Node;
  - subset 932 fixtures (901 passed, 31 expected-fail, 0 failed);
  - golden 461/461;
  - selfhost 14 targets match after re-recording `packages/compiler` `STA1214` 1813 → 1815
    (plan-notes 345);
  - builtins 255/324;
  - `docs/NODE.md` current;
  - leak plateau;
  - golden-asan green (461 passed).

> **Task 6.27 — A user-defined `toString`/`valueOf` is honored when an object becomes a string.**
> Today ToString of an ordinary object ignores the user's method and prints `[object Object]`
> (`jsrt_print.c`, the fallback branch at the end of `jsrt_to_string`), while `explain` answers
> `static`. Wherever ECMA-262 runs ToPrimitive, call the method the object actually has: a template
> literal, `String(x)` and `.concat` (hint `string`: `toString` first, then `valueOf`), `'' + x`
> (hint `default`: `valueOf` first, then `toString`), and `Array.prototype.join`. That includes a
> class method, an object-literal method and an inherited one, with `Symbol.toPrimitive` not-yet
> until symbols exist (Phase 5). A method that throws propagates as a catchable exception. A method
> that returns an object is a `TypeError`, as in Node.
> 1. In `ts` mode the receiver's type says whether the method is the user's, so lowering emits a
>    direct call and the runtime fallback is never reached.
> 2. In `js` mode, and for a `ts` receiver whose type cannot say (a union, an interface), the
>    runtime looks the method up with `jsrt_get_prop` and calls it with `jsrt_call`. The emitter
>    follows every such conversion with the pending-exception check, as it does after
>    `JSON.stringify` (`consoleMayThrow` is the precedent).
> 3. Lift the 6.24 refusals that share this path: `%s` of an object with its own `toString`, and
>    `%d`/`%i`/`%f` through a user `toString`/`valueOf`. They are `STA1214` at the gate today and
>    `PANIC: STA2005` at run time (plan-notes 337). A refusal this card cannot lift stays as it is.
> 4. Where a case still cannot match Node, refuse it with a not-yet code and never print other bytes.
>
> `v + 1` with a user `valueOf` in `js` mode is `STA0012` today, because TS2365 is not in
> `JS_MODE_RUNTIME_CODES`. That is a mode-policy question, not this card's (plan-notes 344).
> **Check:** goldens `golden/ts/to_primitive.ts` and `golden/js/to_primitive.js` cover every site
> above, inheritance, a throwing method caught by `try`, and the object-returning `TypeError`, and
> match Node byte-for-byte. Decision tests in both modes. Any 6.24 refusal that was lifted moves out
> of `docs/SUBSET.md`'s not-yet list. `pnpm run ci` is green.

### Task 6.25 — A BigInt is not-yet, never an internal error (F5) ✅ (landed 2026-10-04)

Audit finding F5 (plan-notes 330): `const b = 1n;` answered `STA4031` "unexpected expression kind:
BigIntLiteral" in both modes, because a BigInt literal is a token and `gateConstruct` accepted
every token before its switch. The lowering then had nothing to lower it to.

What landed (plan-notes 334):

- `isBigIntUse` in `src/frontend/gate.ts` runs before the token skip. It refuses a BigInt literal
  and every expression whose type, or a member of whose union type, is `BigIntLike`, with not-yet
  `STA1213` (Phase 5). `BigInt(5)` moves from `STA1214` ("the global 'BigInt'") to `STA1213`.
- A name or property access is judged by its symbol's declared type, not the narrowed one.
  `node:assert`'s `inspect` has `typeof value === 'bigint'` over an `unknown`, a branch no compiled
  program can enter; the narrowed type would have refused `packages/node`.
- A declaration's own name is skipped (`ts.getNameOfDeclaration`), so a bigint is refused where
  it is read, once, not again where it is named or exported.
- Tests: the audit's F5 test (`unit/cli.test.ts`, `explain --json` in ts mode plus a js-mode
  `build`), a gate unit test covering literals, `typeof 1n`, `10n > 5`, `BigInt(5)`, a `bigint`
  parameter and the narrowing in both modes, and both `subset_bigint_primitive_*` fixtures without
  `@expected-fail`.
- `docs/SUBSET.md` describes what the refusal covers. The selfhost baseline grows by 3 `STA1214`
  in `packages/compiler`: the new function's `ts.Node`/`ts.TypeChecker`/`ts.Declaration`
  qualified type names, which every gate function carries.

Check evidence: `pnpm run test:subset` → `921 fixtures — 890 passed, 31 expected-fail, 0 failed`
(both `subset_bigint_primitive_*` pass without the marker); `pnpm run test` → 57 files, 736
tests passed (the audit's F5 test included); `pnpm run test:golden` → `453 passed, 0 failed`;
`pnpm run test:selfhost` → `14 targets match the baseline`; typecheck, lint and dupes clean.

> **Task 6.25 — A BigInt is not-yet, never an internal error (F5).** The gate refuses
> `SyntaxKind.BigIntLiteral` and any expression whose type is `BigIntLike` with not-yet `STA1213`
> (Phase 5), in both modes, in `build` and `explain`. **Check:** `subset_bigint_primitive_ts.ts`
> loses its `@expected-fail` marker; a js-mode twin passes; the audit's F5 test passes;
> `pnpm run ci` green.

### Task 6.22 — FFI inputs are validated before they reach C or clang (F7, F8, F9) ✅ (landed 2026-10-04)

Audit findings F7, F8 and F9 (plan-notes 330). What landed (plan-notes 335):

- **F7, `ffi-gen/main.ts`.** `--out` that names the input header or the `--diff` file (same resolved path, or the same inode through a symlink or hard link) is
  refused (exit 2) before anything is read or written. `--lib` must match
  `^[A-Za-z0-9_.+-]+$`, so a newline or a space can no longer append source or a second clang
  flag to the committed `.d.ts`. `--help`/`-h` prints the usage to stdout and exits 0.
- **F8, `frontend/extern.ts`.** A resolved quote-form header path, a bare name or an angle header
  holding a `"`, a line break or NUL is an `invalid` pragma, which the gate reports as `STA1119`
  at the pragma's line. Every other path is emitted as written. The card said "through
  `escapeCString`", but clang reads a header name literally: `#include "…/q\"d/m.h"` and the
  octal-escaped spelling of a non-ASCII directory are both "file not found" (plan-notes 335).
  Escaping would have broken every non-ASCII binding directory that works today.
- **F9, `frontend/extern.ts`.** `linkFlagRefused` allows `-l<name>`, `-L<dir>`,
  `-framework <name>` and `-Wl,-rpath,<dir>` (no further comma). Anything else is `invalid`, and
  the message names the flag and points at `--link=`. The gate's prefix for an invalid pragma
  now reads "refused @statorLink pragma", since a disallowed flag is not malformed.
- **Fixtures adjusted on purpose.** One unit test parsed `-lfoo "/p a t h/x.a"`, an archive
  path, which the allowlist now refuses. It now groups `"-L/p a t h"`, and the test also covers
  `-framework` and `-Wl,-rpath,`. No golden, example or `packages/*` binding used a flag outside
  the allowlist. Every pragma in the tree is `-l<name>`, `-L<dir>` or `#include`.
- **Tests.** The audit's F7 tests and its F8 test, adapted to assert the `STA1119` refusal and
  that no C is written (`unit/ffi-gen-binding.test.ts`). Unit tests for the allowlist (eight
  refused spellings, each named) and for unspellable paths, with a non-ASCII directory kept as
  written (`unit/extern_link.test.ts`). Decision tests `subset_extern_link_flag_{ts,js}`
  refusing `-fplugin=` in both modes.
- **Docs.** `docs/FFI.md §9`, `docs/SUBSET.md` and `docs/DIAGNOSTICS.md` (the STA1119 row).

Check evidence:
- `pnpm run test:subset`: 923 fixtures, 892 passed, 31 expected-fail, 0 failed. Both
  `subset_extern_link_flag_*` pass.
- `pnpm run test`: 57 files, 742 tests passed, including the audit's F7 and F8 tests.
- `pnpm run test:golden`: 453 passed, 0 failed.
- `pnpm run test:selfhost`: 14 targets match the baseline.
- typecheck, lint and dupes clean.

> **Task 6.22 — FFI inputs are validated before they reach C or clang (F7, F8, F9).**
>
> - **F7.** `ffi-gen` refuses an `--out` (or `--diff`) equal to the input header, validates `--lib`
>   against `^[A-Za-z0-9_.+-]+$`, and prints `--help` to stdout with exit 0.
> - **F8.** A resolved `@statorLink` header path containing `"`, `\n`, `\r` or NUL is refused
>   (`STA1119`); every other path is emitted through the emitter's `escapeCString`, as `#line` is.
> - **F9.** `@statorLink` flags are limited to link flags: `-l<name>`, `-L<dir>`,
>   `-framework <name>` and `-Wl,-rpath,<dir>`. Anything else is `STA1119` naming the flag; the
>   explicit escape hatch stays `--link=` on the command line. `docs/FFI.md §9` changes from
>   "verbatim clang link flags" to the allowlist.
>
> **Check:** the audit's F7 and F8 tests pass, plus a decision test refusing `-fplugin=` in a
> pragma; `docs/FFI.md` updated; `pnpm run ci` green.

### Task 6.26 — The landing page works without storage, at 320 px and without third parties (F14, F15, F16) ✅ (landed 2026-10-04)

Audit findings F14, F15 and F16 (plan-notes 330). With `localStorage` blocked the theme toggle
cycled `light, light, light`, and it showed without JS. At 320 and 360 px the header overflowed
(`scrollWidth 370`). Every visit asked `fonts.googleapis.com` for IBM Plex, and the page had no CSP.

What landed (plan-notes 336):

- **F14.** `site/public/js/theme.js` keeps the preference in a closure variable that `apply()`
  sets, and `cycle()` steps from it; storage only persists it. The button renders `hidden` and the
  script unhides it when it wires the click.
- **F15.** `.top-inner`, `.header-actions` and `.nav` wrap (`flex-wrap`, `min-width: 0`), and the
  theme label hides under 400 px, leaving the icon button.
- **F16.** IBM Plex Sans and Mono (400/500/600, OFL-1.1) come from `@fontsource/ibm-plex-sans` and
  `@fontsource/ibm-plex-mono` 5.3.0, imported by `BaseLayout.astro`; the Google Fonts links are
  gone. `security.csp` in `astro.config.mjs` puts a `<meta>` CSP on every page: `default-src
  'self'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'none'`, Astro's own script and
  style hashes, and the inline boot script's hash, computed from `src/scripts/theme-boot.ts`, the
  one source both the layout and the config read. The layout's scripts open `<body>`, because
  Astro puts the meta at the end of `<head>`.
- **Check script.** `site/scripts/check.ts` (strict TS; `pnpm run check:browser`) serves `dist/`
  under the base path and drives the installed Chrome through `playwright-core` 1.63.0. It
  aborts and records every request to another origin, collects `securitypolicyviolation` events,
  and checks the fonts, the CSP meta, the scroll width at 320 and 360 px, the theme cycle with
  storage blocked and with it, and the toggle without JS. `.github/workflows/pages.yml` runs it
  after the build.
- Docs: `site/README.md` (the check, fonts and CSP), `docs/TOOLCHAIN.md` (a Site table).

Check evidence (macOS arm64, Node 26.7.0, Astro 7.3.3, Chrome 154.0.8037.93): `pnpm build` →
`1 page(s) built`; `pnpm run check:browser` → 9 checks `ok`, `site check: all passed`
(`no request to another origin ()`, `no CSP violation ()`, `IBM Plex Sans and Mono load from
the site`, `scrollWidth 320, clientWidth 320`, `scrollWidth 360, clientWidth 360`,
`blocked-storage cycle is light,dark,system`, `the toggle is hidden without JS`). The same script
over the pre-fix site fails 7 checks: the Google Fonts requests, the fonts (those requests are
aborted), the missing CSP meta, `scrollWidth 370` at both widths, `light,light,light`, and a
visible toggle without JS. Root `pnpm run lint` clean.

> **Task 6.26 — The landing page works without storage, at 320 px and without third parties
> (F14, F15, F16).**
>
> - **F14.** `site/public/js/theme.js` cycles from an in-memory state that `apply()` updates, so a
>   blocked `localStorage` still cycles `light → dark → system`. The toggle is hidden until the
>   script runs.
> - **F15.** The header wraps (`flex-wrap`, `min-width: 0` on `.nav`) and drops the theme label
>   text under ~400 px, so nothing overflows at 320 and 360 px.
> - **F16.** IBM Plex is self-hosted under `site/` (OFL), the `fonts.googleapis.com` links go,
>   and the layout carries a restrictive CSP meta (`default-src 'self'`, the inline boot script by
>   hash).
>
> **Check:** the site builds; a check (in the site's own build or a script under `site/`) shows
> no request to another origin, no horizontal scroll at 320 px, and the blocked-storage cycle
> `light,dark,system`.

### Task 6.24 — `console.log` formats like Node (F13) ✅ (landed 2026-10-04)

What landed (plan-notes 337):

- `format_into` in `runtime/src/jsrt_print.c` is the one runtime function. It mirrors Node
  v26.7.0's `formatWithOptionsInternal` for `log`/`info`/`debug`/`error`/`warn` whenever there
  are two or more arguments and the first is a string at run time. `%s %d %i %f %j %O %c %%` are
  applied; `%o` is applied to primitives. A trailing `%` and an unknown `%x` stay literal. Only
  `%%` collapses once the arguments run out, and arguments left over are appended with a space.
- `%j` shares `JSON.stringify`'s stringifier (`json_format`): a cycle prints `[Circular]`, an
  unserializable value prints `undefined`, and a throwing getter leaves the exception pending.
  `consoleMayThrow` (`hir/nodes.ts`) makes codegen emit the pending check after such a call.
- What the binary cannot print identically yet is refused, never approximated. These cases are
  `%o` of an object, `%s` of a function, `%s` of an object with its own `toString`,
  `%d`/`%i`/`%f` through a user `toString`/`valueOf`, and `%d` of a `Date`. With a literal
  format string the gate (`formatRefusal` in `frontend/gate.ts`) answers not-yet `STA1214`. A
  format string known only at run time reaches a named `PANIC: STA2005` in the runtime.
- Docs: `docs/SUBSET.md` (console row), `docs/DIAGNOSTICS.md` (`STA2005`).

Check evidence:

- New goldens `golden/ts/console_format.ts` and `golden/js/console_format.js` cover every
  specifier, `%%`, missing and extra arguments, `error`/`warn`/`info`/`debug`, a runtime format
  string, a cyclic `%j` and a caught `%j` getter throw. Both match Node byte-for-byte, stdout and
  stderr.
- Six decision tests `subset/subset_console_format_*`.
- `unit/console-format.test.ts` covers the audit's F13 test (`'%s=%d', 'n', 5` → `n=5`) and the
  runtime `STA2005` refusal.
- `pnpm run ci` on the rebased branch exited 0:
  - typecheck and lint clean;
  - dupes: 186 clones, unchanged;
  - `pnpm run test`: 738 tests passed;
  - `test:runtime`: the print corpus matches Node;
  - `test:subset`: `927 fixtures — 896 passed, 31 expected-fail, 0 failed`;
  - `test:golden`: `455 fixtures — 455 passed, 0 failed`;
  - `test:selfhost`: green after re-recording `packages/compiler` `STA1214` 1794 → 1800, for
    the gate's new format-string scan Merged with main f126a49 (Tasks 6.20, 6.22, 6.25,
    6.26) the count is 1798 → 1804: the same six;
  - builtins, node-coverage and leak green;
  - `test:asan`: `golden-asan green`, 455 passed.

> **Task 6.24 — `console.log` formats like Node (F13).** `console.log`/`error`/`warn` with two or
> more arguments and a string first argument substitute `%s %d %i %f %j %o %O %c %%` with
> `util.format` semantics, in one runtime function. **Check:** a golden in each mode covering every
> specifier, `%%`, missing and extra arguments, byte-for-byte vs Node; `pnpm run ci` green.

### Task 6.23 — Runtime failures are Node's errors, not crashes or silent nulls (F6, F12) ✅ (landed 2026-10-04)

What landed (plan-notes 338, 339; docs/VALUE.md §2 and §4.25):

- **F6.**
  - Every generated function opens with `JSRT_STACK_CHECK()` before `JSRT_FRAME`. It compares
    its frame address against the thread-local `jsrt_stack_limit`, which `jsrt_stack_init`
    (`runtime/src/jsrt_stack.zig`) sets at `jsrt_init` from the thread's real stack bounds
    plus 256 KiB of headroom. Past the limit it throws a catchable
    `RangeError: Maximum call stack size exceeded`.
  - Recursion that no prologue sees, such as the runtime's C recursion over deeply nested data,
    hits a SIGSEGV/SIGBUS handler on an alternate stack. It prints
    `PANIC: STA2005 stack overflow` and the shadow-stack depth. Any other fault goes to the
    handler that was installed before.
  - Overhead: +3.7 % on `fib(36)`, about 0.8 ns per call.
- **F12.**
  - `JSString` is now `{length, flags, data, buffer}`. `jsrt_string_concat`, moved to
    `runtime/src/jsrt_string_mem.zig`, extends a shared append buffer when the left operand
    ends at the buffer's end, and doubles the buffer otherwise. 200 000 one-character appends
    take 15.1 ms, against Node's 54.9 ms and 2.32 s before this change.
  - Past 2^29 − 24 code units, concat throws `RangeError: Invalid string length` instead of
    answering `JSRT_NULL`. The emitter now checks for a pending exception at four places:
    - after every `+` not typed `number`;
    - after `+=`, before the write;
    - after a template literal with more than one part;
    - after `String.prototype.concat`.
- Docs: `docs/VALUE.md` §2 (the layout and the append buffer) and new §4.25 (the stack guard),
  `docs/DIAGNOSTICS.md` (`STA2005`), `docs/FFI.md` (the fault handler under `stator_init_<unit>`).

Check evidence:

- New goldens match Node byte-for-byte:
  - `golden/ts/stack_overflow.ts` and `golden/js/stack_overflow.js` catch the `RangeError` from
    deep recursion (a function, a method, mutual recursion, a recursion allocating per frame)
    and print its message.
  - `golden/ts/string_append.ts` and `golden/js/string_append.js` hold the prefix-sharing cases.
- `unit/runtime-errors.test.ts` covers:
  - the audit's F6 test (`f(1000000)`: no signal, exit 1, `RangeError` on stderr);
  - the native-recursion `PANIC: STA2005 stack overflow`;
  - the string cap across `+=`, a template literal and `concat`.
- The F12 measurement is in plan-notes 339.
- `pnpm run ci` exited 0:
  - typecheck and lint clean;
  - dupes: 183 clones, baseline shrunk 186 → 183;
  - `pnpm run test`: 756 tests passed;
  - `test:runtime`: print corpus matches Node;
  - `test:subset`: `929 fixtures — 898 passed, 31 expected-fail, 0 failed`;
  - `test:golden`: `459 fixtures — 459 passed, 0 failed`;
  - `test:selfhost`: green and unchanged (`STA1214` 1804);
  - builtins, node-coverage and leak (both plateau) green;
  - `test:asan`: print corpus matches Node under ASan/UBSan, `golden-asan green`, 459 passed.

> **Task 6.23 — Runtime failures are Node's errors, not crashes or silent nulls (F6, F12).**
> 
> - **F6.** `JSRT_FRAME` (or the function prologue) checks the native stack against a limit set at
>   `jsrt_init` from the thread's stack size and throws a catchable
>   `RangeError: Maximum call stack size exceeded`. A `sigaltstack` SIGSEGV handler that prints
>   `PANIC: STA2005 stack overflow` is the fallback for frames the check cannot see.
> - **F12.** `jsrt_string_concat` throws `RangeError: Invalid string length` past Node's cap
>   (the one `jsrt_string_ops.c` already uses for `repeat`/`padStart`) instead of returning
>   `JSRT_NULL`. String `+=` in a loop becomes amortized linear (an append buffer with spare
>   capacity, or the rope `docs/VALUE.md §12` anticipates): 200 000 one-character appends must
>   stay within 3× Node's time on the same host.
> 
> **Check:** a golden that catches the `RangeError` from deep recursion and prints its message;
> the audit's F6 test passes; a unit or bench measurement for F12 recorded in plan-notes;
> `pnpm run ci` green, including ASan.

### Task 6.28 — A function initializer may refer to its own binding ✅ (landed 2026-10-04)

Found while landing 6.24 (plan-notes 344): `const g = (n) => … g(n - 1)`, an anonymous
`const walk = function (…) { … walk(…) }`, the same inside a function body, a `let` binding, and
`const o = { f: (n) => … o.f(n - 1) }` all stopped with `STA4002 internal error: identifier 'g'
is not defined` in both modes while `explain` said `static`/`dynamic`.

What landed (plan-notes 347):

- Root cause in `src/hir/verify.ts`: the `declaration` case verified the initializer before it
  registered the name. The lowering already declared the binding first and capture analysis
  already gave it an environment slot or a global, so lowering and codegen are unchanged.
- The verifier registers the binding as `initializing` while its initializer is verified, and
  `Scope.readable` resolves it only through a function-body scope (`Scope.functionChild`). A read
  or assignment on the initializer's own evaluation path is still `STA4002`/`STA4003`.
- Closure-mediated TDZ: the gate (`mayRunInOwnInitializer` in `src/frontend/gate.ts`) refuses a
  self-read whose function the initializer may call before it finishes, such as a callback passed
  to a call, a `toString` coerced by `+`, or a spread. It is not-yet `STA1214` with no phase, because
  the compiler has no run-time TDZ check to throw Node's `ReferenceError`. A direct read, an IIFE
  included, stays TS2448.
- Tests: goldens `ts/self_reference_initializer.ts` and `js/self_reference_initializer.js` (the
  five shapes, a reassigned `let`, an object-literal method, `?:` and `&&`/`||` containers, and
  3000-deep recursion at module level and in a function body); decision tests
  `subset_self_reference_initializer_{ts,js}` (static/dynamic) and
  `subset_self_reference_initializer_call_{ts,js}` (not-yet `STA1214`); three
  `unit/verify.test.ts` cases (the shapes verify clean, a direct self-read is `STA4002`, the gate
  refusals in both modes).
- Docs: `docs/HIR.md` §5.1 (binding scope) and the functions row of `docs/SUBSET.md`. The
  selfhost baseline grows by 7 `STA1214` in `packages/compiler`, all from the `ts.*` qualified type
  names in the two new gate helpers.
- Deviation from the card: the Check asked for `g(10000)`. ASan frames overflow the stack near
  6000 levels, and Node itself overflows `1 + g(n - 1)` near 9000, so the goldens recurse 3000
  levels (plan-notes 347).

Check evidence: `pnpm run ci` → exit 0: typecheck and lint clean; `dupes` 183 clones
(none new); unit 764/764; subset 933 fixtures (902 passed, 31 expected-fail, 0 failed); golden
461/461 (both `self_reference_initializer` goldens included); selfhost 14 targets match the updated
baseline; builtins 255/324; `docs/NODE.md` current; leak plateau (objects peak RSS 3840 KB, FFI
strings 3904 KB); golden-asan 461/461 green. The HIR verifier is clean on every golden, since a
verifier problem fails the build.

> **Task 6.28 — A function initializer may refer to its own binding.** `const g = (n) => … g(n - 1)`,
> a `const walk = function (…) { … walk(…) }`, the same inside a function body, a `let` binding, and
> `const o = { f: (n) => … o.f(n - 1) }` all stop with `STA4002 internal error: identifier 'g' is not
> defined` (`hir/verify.ts`, the `identifier` case) in both modes, while `explain` says
> `static`/`dynamic`. The closure captures the binding, not its value, so the binding has to be in
> scope (and boxed, if captures box) before its initializer is lowered. A call made before
> initialization stays Node's TDZ `ReferenceError`.
> Find the root cause in lowering and the verifier's scope order, rather than relaxing the verifier.
> **Check:** a golden in each mode covering the five shapes above and a recursion deep enough to
> prove it runs (`g(10000)`), matching Node byte-for-byte; a decision test per mode; the
> HIR verifier is clean on all of them; `pnpm run ci` is green.

### Task 6.29 — Test262 gets back the six module tests it lost ✅ (landed 2026-10-03)

The six tests were lost for two reasons (plan-notes 349, 350). The four `early-import-*` tests
and `instn-named-err-not-found-dflt` had never really passed. Until `68c8d57`, the runner compiled
a module test under a temporary name, so its imports failed to resolve with `STA0012`, which
counts as a SyntaxError. Stator had no refusal for either shape. `dup-bound-names` lost because
the bundle step (T12.1) ran before the duplicate binding was reported.

What landed (plan-notes 350):

- `STA3005`, both modes: an imported binding named `eval` or `arguments` (`strictReservedImports`
  in `src/frontend/modules.ts`, raised by `createProgram`).
- `LoadedProgram.parseDiagnostics`: the parser's and the binder's diagnostics plus `STA3005`.
  When there are any, `bundledFrontend` (`src/cli/bundler.ts`) reports only them and loads no
  adapter.
- `STA3004`, js mode: the default of a `.js` file that Node loads as an ES module and that has no
  module syntax, in an import, an `import { default as x }`, or an `export { default } from`
  (`missingDefault` in `src/frontend/gate.ts`, `isSyntaxFreeEsModule` in `src/frontend/vendor.ts`).
- The Test262 runner maps both codes to SyntaxError, the way it maps `STA3003`.
- Tests:
  - decision tests `subset_import_binding_eval_{ts,js}` and `subset_import_default_missing_{ts,js}`;
  - three unit tests in `unit/bundler.test.ts`: parse errors come before the adapter, the
    binder's list is still where `parsePhaseKeys` reads it, and STA3004 in its three shapes but
    not for a CommonJS file.
- Docs: `docs/DIAGNOSTICS.md` (two rows), `docs/SUBSET.md` (the imports row), `docs/BUNDLER.md` §5.

The Check, on linux CI: run 37154148433 on `eb44366`, job "test262 conformance" (Aggregate and
gate), reports `test262: merged 8 shard(s), 53580 results` and `test262: 2377 passed, 49384
skipped, … 1819 failed`. The ratchet gate is green.

Local evidence (macOS arm64, Node 26.7.0, corpus pin `771005236e88`):

- `pnpm run test262` → `2377 passed, 49384 skipped, … 1819 failed`, exit 0.
- `ratchet.json` `passed`: 2372 → 2377.
- `run.ts --filter`:
  - `module-code/early-import` → `4 passed`;
  - `import/dup-bound-names` → `1 passed`;
  - `instn-named-err-not-found-dflt` → `1 passed`;
  - the five tests gained since `76a69ed` → `1 passed` each.
- `pnpm run ci` → exit 0:
  - typecheck and lint clean, dupes at 183 clones;
  - unit `764 passed (764)`;
  - `subset: 933 fixtures — 902 passed, 31 expected-fail, 0 failed`;
  - `golden: 459 fixtures — 459 passed, 0 failed`;
  - `selfhost: 14 targets match the baseline`, after `--update` raised compiler `STA1214` from
    1833 to 1845 for the new frontend code;
  - builtins, node-coverage, leak and ASan green.

> **Task 6.29 — Test262 gets back the six module tests it lost (plan-notes 349).** CI on
> `b95a0dc` passes 2371 tests, but `ratchet.json` holds 2372. Compared with the last green run
> (`76a69ed`, 2026-09-25), six tests were lost and five gained. The six fall into two groups:
> 1. `module-code/early-import-{eval,arguments}` and `early-import-as-{eval,arguments}` (negative,
>    phase parse, SyntaxError). The build now raises only `STA1214` ("method calls are not yet
>    supported", from harness lines), so the runner records a skip. The SyntaxError for an
>    imported binding named `eval`/`arguments` is no longer reported. `instn-named-err-not-found-dflt`
>    is skipped the same way. Find the commit that dropped it (bisect with
>    `run.ts --filter module-code/early-import`), and restore the refusal. A strict-mode binding error
>    is a SyntaxError in every module.
> 2. `import/dup-bound-names.js` (`import { x, y as x } from 'z'`, negative parse SyntaxError). The bare
>    specifier now goes to the bundler first, which fails with `STA0015` (on CI it also exceeds the
>    30 s build ceiling). The duplicate binding is a parse-phase error, so it has to be reported
>    before any bundle step runs.
>
> **Check:** `pnpm run test262` on linux CI gets back all six tests with `passed` ≥ 2372 (the
> five gained tests stay), and `ratchet.json` is raised to the new total.

### Task 6.30 — The Windows frontend legs are green again ✅ (landed 2026-10-04)

`frontend (windows/x64)` failed eleven unit tests once stage 2 ran again (CI run 37150879614, job
111286117947). Ten were in `unit/bundler.test.ts` and one was the selfhost baseline test. Four
root causes (plan-notes 352):

- **No stated path form at the bundler seam.** The code answered the checker's spelling
  (`C:/…`), and the tests glued `${root}/…` onto a `C:\…` root.
- **A cross-drive bug.** The runner's temp dir is on `C:` and the checkout on `D:`.
  `path.relative` answers an absolute path there, and `relativeSpecifier` put `./` in front of
  it, so a `--node` location read failed with `Cannot find module './D:/…/location.ts'`.
- **The helper's absolute import**, once spelled correctly, still met TS2877 (a non-relative
  `.ts` import) and then the gate's package rule.
- **CRLF.** The repo had no `.gitattributes`, and git on the Windows runner checks out with
  `core.autocrlf=true`.

What landed:

- docs/BUNDLER.md §5 "Paths": what leaves the compiler is in the platform's form, namely
  `VendorEntry.resolveDir` and every diagnostic's `file` (the API, `stderr`, `stator explain`).
  `modulePath`, the `rewrites` keys, `#line` and run-time locations keep the checker's form.
  docs/DIAGNOSTICS.md says the same for the `file` field.
- `platformPath` in `frontend/vendor.ts`. `mapVendorDiagnostics` becomes `reportedDiagnostics`,
  the one outbound step `build` and `explain` share, and it converts every `file`.
- `relativeSpecifier` answers the absolute target when no relative path exists. The location
  rewrite then imports `nodeLocationModule()` (the helper's checker path without `.ts`), and the
  gate accepts exactly that string.
- `.gitattributes`: `* text=auto eol=lf`. `git add --renormalize .` changed no file. The
  `ci.yml` comment that blamed line-ending translation for keeping `lint` off the desktop legs
  now gives the real reason.
- Tests state which form they expect: `join(root, …)` for what comes out, `checkerName` for
  internal names. No assertion got looser. The `#line` regexes became exact `includes`, and two
  `rewrites(…).get(…) === undefined` checks that passed vacuously on Windows now test something.
  The `--node` bundler test is split: the compile runs on every platform (on the Windows x64
  runner it crosses drives), and the run of the binary is `NATIVE_ONLY`.
- Merging main brought Task 7.4's `unit/static-lib.test.ts`, whose Windows leg had never run:
  "an export that crosses as jsrt_value is STA1220" met STA1219, because Windows refuses
  `--emit=lib` before compiling (docs/FFI.md §8). It is skipped on `win32`; the next test pins
  STA1219 there.
- After that merge, `frontend (windows/arm64)` (CI on `54ba88f`, job 111328467740) still fails one
  Task 6.27 test, `unit/to-primitive.test.ts`: Node's own builtin-constructor set is seven names
  larger on that runner (plan-notes 352). `frontend (windows/x64)` passes.

Check evidence (PR #110, head `f9a5e72`, CI run 37155782218):

- `frontend (windows/x64)` (job 111299744263) and `frontend (windows/arm64)` (job 111299744145):
  pass, `Tests  702 passed | 63 skipped (765)` each.
- Every other job passes except `test262 conformance` (`FAIL ratchet: passed dropped from 2372
  to 2371`), which is Task 6.29's known drop and is on main too.
- Local `pnpm run ci` → exit 0 (`Tests  762 passed (762)`, subset 898 passed + 31 expected-fail,
  golden 459/459, selfhost 14 targets match the baseline).

> **Task 6.30 — The Windows frontend legs are green again (plan-notes 349).** `frontend (windows/x64)`
> and `frontend (windows/arm64)` fail 11 unit tests on `ci-linux-fix-main`. They have not run green
> since `76a69ed`, because stage 2 waits on the linux jobs, which were red.
> 1. Ten `unit/bundler.test.ts` tests (T12.1–T12.3) compare a bundler path such as `resolveDir`, a
>    `#line` file or a diagnostic file against `join(...)`. The code answers `C:/Users/…` and the test
>    expects `C:\Users\…`. Decide which form the bundler seam promises, document it in
>    `docs/BUNDLER.md`, and make the code and the tests agree. A diagnostic shown to a Windows user
>    should use the platform's separators.
> 2. `unit/selfhost.test.ts` "the committed baseline is in --update form" fails on Windows (most
>    likely CRLF from checkout, compared against the `--update` text). Fix it with a
>    `.gitattributes` rule or by normalizing the comparison, whichever is the root cause.
>
> **Check:** `frontend (windows/x64)` and `frontend (windows/arm64)` green on a PR.

## Phase 7 — FFI ✅ COMPLETE (2026-09-16)

**Check — PASSED.** *An example that statically links SQLite, queries it from TS, and is
itself callable from a C `main()` — built and run in CI* (plan.md §10). The demo
(`examples/ffi/sqlite/`: generated binding from the curated `sqlite_mini.h` + `demo.ts` +
C `main.c`) opens `:memory:`, creates/fills/selects/prints, finalizes, and closes —
byte-identical to the pinned Node 26.7.0 — and answers from a C `main()` through the 7.2
header (success + `last_error` paths). The CI proof is the ffi job's own steps
(`.github/workflows/ci.yml`: `test:ffi`, the C-consumer runner, the SQLite C-main runner).

Re-verified at close-out (2026-09-16 on `9f2eba4`, docs-only changes since):
`test:ffi` 5 checks — 5 passed, 0 failed, 0 not run; `c-consumer.ts` → `ffi c-consumer: ok`;
`sqlite-c-main.ts` → `ffi sqlite-c-main: ok`; `sqlite-demo.ts` → `sqlite demo: ok`; libm/stat
examples ok; full `pnpm run ci` green (check-node v26.7.0; typecheck/lint/dupes clean; unit
564/564; runtime corpus matches Node; subset 677 — 639 passed, 38 expected-fail, 0 failed;
golden 386/386 + 2 intl skipped; builtins 223/238; leak 10M-object plateau 3664 KB;
golden-asan green).

Task records below: 7.1 steps 1–2 (surface docs), 3–5 (converters/lowering), 6–10
(ownership/link/explain/js-checks/tests), 7.2 steps 1–2 (header flags), 3–8
(stubs/init/throws/frames/threads/mangling/determinism), step 9 (CI example), 7.3
(`Out<T>`, generator, demo). The contract lives on in `docs/FFI.md`, the codes in
`docs/DIAGNOSTICS.md`, the matrix rows in `docs/SUBSET.md`.

**Residue, named not owned.** Two follow-ups were never Check items and have no phase owner:
the ambient `CString`/`CStringOwned` (+ `Out`) declarations in the stator lib (fixtures
declare brands locally until then — FFI.md §7.3), and generator convention transfer (the
demo hand-checks every unconventioned return code until then — plan-notes 271); the
TS-name/brand alias policies are mechanical deltas documented there too. A future card owns
them; the phase does not stay open for them.

**§15.9 reassignment in the same change.** Closing the phase forced the rule's question —
three `phase: 7` sites survived under `src/` (plan-notes 273): the optional extern call
DELIVERED as a direct C call (`?.` on an always-linked callee is a proven no-op;
`isDirectCalleePosition` + `gateExternCall` + `lowerExternCall` agree, proved by
`subset_extern_optional_call_{ts,js}` at `static` and the new `?.` lines in the
`extern_libm` goldens both modes), and the extern-as-value STA1217 plus the bare-package
STA1214 reassigned PHASELESS (no open phase owns either; messages name the blocker, never
a phase number). `COMPLETED_PHASES` gains 7; `tests/unit/phases.test.ts` green.

### Task 7.1 steps 1–2 — Extern surface frozen in docs ✅ (landed 2026-09-14, `a732cd5`)

Docs before code (§15.6): `docs/FFI.md` §§1–2 (the `@statorExtern` marker — per declaration,
C symbol defaulting to the TS name with trailing-text override, `.d.ts`-only — and the ABI
table with `string`-maps-to-nothing and per-kind refusal codes), `docs/SUBSET.md` FFI rows,
`docs/DIAGNOSTICS.md` STA1114–STA1121 (`never`) + STA1217 (`not-yet` Phase 7). No compiler
code in the commit — the surface existed on paper before the lowering was allowed to start.

### Task 7.1 steps 6–9 — Ownership, link plumbing, explain mark, js checks ✅ (landed 2026-09-14/15)

- **Step 6, borrow-only pointers** (`0357121` extern-borrow surface): brands classify as the
  `pointer` ABI kind; generated code evaluates arguments into rooted frame slots and passes
  handles through untouched and unretained (`docs/FFI.md` §6 — the emitter guarantees, by
  construction, no load through the handle and no copy beside the slot). STA1217 now names
  only extern-as-value and optional-call positions.
- **Step 7, headers and link flags** (`docs/FFI.md` §9; reader
  `packages/compiler/src/frontend/extern.ts:432`): one `// @statorLink` pragma per `.d.ts`
  (flags form + single-`#include` header form, STA1119 shape rules) plus the repeatable
  `--link=` CLI hatch (`packages/compiler/src/cli/main.ts:33,125`); `linkExecutable`
  assembles recorded flags, then pragma flags in program order, then CLI flags — dedup
  first-wins on `-l`, never sorted. `libm` needs no pragma (`-lm` rides `link-flags.txt`).
- **Step 8, the honest boundary** (`83e2272` field, §5 semantics): `stator explain` carries
  `externCalls` alongside the verdict (`packages/compiler/src/cli/explain.ts:47,107,178`) —
  ts calls `static` + flag, js calls `static`/`dynamic` + flag by argument provenance, slots
  always `static`; refusals carry no flag.
- **Step 9, js-mode checks** (no new mechanism): each dynamic argument is wrapped in the
  call-edge boundary check the mixed-graph rule owns
  (`packages/compiler/src/lower/index.ts:9595` — `maybeBoundary`, STA2001 at run time on
  mismatch). The declaration is identical in both modes; only the checks differ.
- **Step 10** is the test-infra record below (libm both modes, self-compiled `.c` through
  `--link=`, real `--emit-header` double build, ASan buffer ownership — all passing checks
  in `packages/tests/ffi/run.ts`).

### Task 7.2 steps 3–8 — Init, throws, frames, threads, mangling, determinism ✅ (landed 2026-09-15)

Stubs in `39da02f` (361-line `tests/unit/export-stubs.test.ts`: in-process shape plus a
linked C `main()` proving init→call→error), header rules in `4445956`/`a42c198`, all restated
normatively in `docs/FFI.md` §8:

- **Step 3, init:** `stator_init_<unit>()` — GC, globals frame, module environment, the same
  top-level emission `main` runs (never a second copy), microtask drain, exported-const
  stores; idempotent via a set-before guard; declared first; calling anything before it is UB
  (`packages/compiler/src/codegen/index.ts:1205`).
- **Step 4, throws:** `stator_<unit>_last_error()` (NULL = success) plus a zero-value
  sentinel per C spelling; cleared on entry, `_Thread_local`, valid until the next call; the
  stub funnels every throw path through one `_jsrt_err` epilogue into a rooted slot — never
  abort, never unwind (`codegen/index.ts:1147`).
- **Step 5, frames:** every stub opens one `JSRT_FRAME` and pops it on every exit including
  step 4's; arguments convert into frame slots; stubs never `JSRT_GLOBALS_ENTER`.
- **Step 6, threads:** every emitted header carries the sentence — calling in from a second
  thread is UB until T10.2 (`packages/compiler/src/frontend/export.ts:592`).
- **Step 7, mangling:** `stator_<unit>_<name>` with `--unit-name` prefix/sanitization,
  STA1124 on sanitized-symbol collision, `stator_<unit>_abi_v<V>` version symbol the header
  declares and the object defines (skew fails at link time).
- **Step 8, determinism:** no timestamps/paths/hash order — proved by the real double build
  in `packages/tests/ffi/run.ts`, not only the unit byte-compare.

### Task 7.3 — Bindings, generator, and the SQLite Check demo ✅ (landed 2026-09-15)

The `T**` question Task 7.3 forced got its v0.1 answer instead of another deferral: the
`Out<T>` row in the ABI table (`T**` over brands, `Out<CString>` over `const char**`),
created by blessed `outSlot<T>()`, read via `.value` (docs/FFI.md §2; misuses STA1125,
exports STA1126). Slots are ordinary frame cells holding handle-or-zero bits — never
addresses as values, so nothing can dangle; the emitter passes each argument slot's own
address and copies writes back to named slots. Under a header the cast spells the brand
tag (`char` for tails); the fallback declares `void **`.

Compiler core: `OutNew`/`OutGet` HIR nodes, `out-pointer` ABI kind with `argTags`, the
`outSlotInner`/`isOutAlias` recognizers (alias type arguments, not `getTypeArguments`),
monomorphization and generic-alias-formation skips for the blessed call, verdict
machinery that reads slots static (`collectOutSlots` + `out-new`/`out-get`/identifier
cases + `out-pointer` arg exemption), and the gate's seven micro-arms (constructor
shape/inner, out-arg shape/type, returns, aggregates, annotation agreement, Out-bound
assignment, no-value aliasing).

The generator (`packages/compiler/src/ffi-gen/`, no new dependencies) maps headers
through the table in reverse with deterministic output: mechanical camelCase names,
`Ptr_` brands, `--lib=`/`#include` pragma emission, `Out<T>` for `T**` (brands and
`const char**` tails), and scope refusals with construct + header line (STA1130 where no
gate code exists, would-be gate codes elsewhere) plus per-reason counts. The full-header
oracle agrees kind-for-kind with the hand-written binding (mechanical name deltas only).

The Check: `examples/ffi/sqlite/` builds a generated binding (`sqlite_mini.h` curated
from real prototypes) into a demo that opens `:memory:`, creates/fills/selects/prints,
finalizes, and closes — byte-identical to the pinned Node — and answers from a C `main()`
through the 7.2 header (success + `last_error` paths), both runners green
(`sqlite demo: ok`, `ffi sqlite-c-main: ok`) and both wired into the ffi CI job
(`libsqlite3-dev` on Linux; the macOS SDK ships it).

Check evidence: 12/12 `subset_out_*` decision fixtures (ts/js twins with the
checker-owns-ts splits), 5/5 `extern-out` classifier unit tests, 17/17 generator unit
tests, golden 386/386 (serial, sharded, ASan), `test:ffi` 5/5, differential smoke 10/10
with 0 divergences. Net `cpd` unchanged at 0.9%.

### Task 7.4 — A self-contained static library for C consumers ✅ (landed 2026-10-03)

Asked by the creator (plan-notes 340). Step 3 chose (a), a private runtime per library, on measured
evidence (plan-notes 342); two runtime bugs found on the way are plan-notes 341 and 342.

> **[D3] Task 7.4 — A self-contained static library for C consumers (creator, 2026-10-04, plan-notes 340).**
> Task 7.2 gives a C program a header and one relocatable object (`--emit-header`, `-o unit.o`).
> The consumer must then find and link `libjsrt.a`, `libjsrt_std.a` and the runtime's system
> libraries itself, as `packages/tests/ffi/example-c-consumer/` does with paths into this repo.
> This task makes `stator build` produce one static library plus its header, which a C build can
> use with no Stator checkout.
>
> Steps:
>
> 1. **`--emit=lib`** (config key `emit: "lib"`, schema regenerated, `docs/CONFIG.md` row) with
>    `--emit-header=<h>`: `-o lib<unit>.a` holds the unit's object and every runtime and `std`
>    member it references. `--emit=lib` without `--emit-header` is a usage error. The archive is
>    written in deterministic mode (`llvm-ar`/`ar` `D`, no timestamps or uids), so two builds of the
>    same input are byte-identical, as the header already is (Task 7.2 step 8).
> 2. **System libraries travel with the archive.** Boehm (`-lgc`, when the runtime was built with
>    it), ICU (intl flavor), `-lm` and `-lpthread` cannot go inside a static archive. The build
>    writes them next to it as `lib<unit>.pc` (pkg-config: `Libs:`, `Libs.private:`, `Cflags:`),
>    the same list `build.ts`'s runtime link line uses today, so the two cannot drift.
> 3. **One runtime per process; decide by measurement.** Two Stator libraries linked into one C
>    program would each carry `jsrt_*` and collide. Measure both options and record the result in
>    plan-notes before choosing:
>    (a) prelink: `ld -r` the unit with the runtime into one object, then keep only
>    `stator_<unit>_*` global (`-exported_symbols_list` on Mach-O, `objcopy --keep-global-symbols`
>    on ELF), so each library carries a private runtime; this must prove two such libraries work
>    in one process, including two collectors' init and roots;
>    (b) `--runtime=external`: the archive omits the runtime members, and the `.pc` file names a
>    shared `libjsrt.a` installed once.
>    Whichever is chosen, the other combination is refused or documented. It never fails at run
>    time.
> 4. **Docs.** `docs/FFI.md §8` gains a "static library" section with the consumer's build line
>    (`cc main.c $(pkg-config --cflags --libs lib<unit>)`). `docs/TOOLCHAIN.md` names the archiver.
>    Any new refusal is allocated in `docs/DIAGNOSTICS.md`.
> 5. **Platforms.** macOS and Linux first. Windows (`.lib` through `llvm-lib`) is a later step,
>    refused with a not-yet diagnostic until then.
>
> **Check:** a copy of `example-c-consumer` builds against only the emitted `lib<unit>.a`,
> `<unit>.h` and `lib<unit>.pc`, copied to a temporary directory with no path into the repo. It
> runs and prints `expected.txt`. Two builds give byte-identical archives (`cmp`). Two units are
> linked into one C program and both called, under the option step 3 chose. The ffi CI job and
> the ASan job run it. `pnpm run ci` is green.

**What landed.** `src/cli/library.ts` (prelink, localization, deterministic `ar`, the `.pc`),
the `--emit=lib` branch and `systemLinkFlags` in `src/cli/build.ts`, the config key and schema,
STA0020/STA1219/STA1220 and two STA0004 forms in `docs/DIAGNOSTICS.md`, the shared Boehm kind
(`jsrt_gc_shared_kind_p48`) and idempotent `jsrt_gc_init` in the runtime, and
`-fno-sanitize-address-globals-dead-stripping` for the sanitized runtime (ELF COMDAT groups broke
two sanitized libraries in one link). Docs: `docs/FFI.md` §8 "Static library", TOOLCHAIN, CONFIG,
HOW-IT-WORKS. Option (b), `--runtime=external`, is documented as not offered.

**Check — PASSED:**

- `packages/tests/ffi/example-c-consumer/static-lib.ts`: builds `libconsumer.a` twice and compares
  the `.a`, `.h` and `.pc` bytes; copies them with `main.c` to a fresh temp dir, refuses any repo
  path (the unit's own error-stack `file:line` strings excepted), links through `pkg-config` alone
  and matches `expected.txt`; links `libconsumer` and `libkeeper` into `two.c` with forced Boehm
  collections (`GC_get_gc_no() >= 10`) and a stack overflow in one library.
- Linux CI (run 37148352874, ubuntu-24.04, clang 18.1.3, GNU binutils 2.42): `ffi (linux/x64)`,
  `ffi (linux/arm64)` → `ffi static-lib: ok (two libraries, forced Boehm collections)`;
  `asan (linux/x64)`, `asan (linux/arm64)` → `ffi static-lib: ok (asan, two libraries, forced Boehm
  collections)`.
- macOS 27.0.1 arm64 locally: default and ASan both ok. CI run 37153833737 (Apple clang 15.0.0,
  ld-1053.12): `ffi (macos/arm64)` → `ffi static-lib: ok (two libraries, forced Boehm collections)`;
  `asan (macos/arm64)` → `ffi static-lib: ok (asan, two libraries, forced Boehm collections)`.
- `pnpm run ci` exit 0 locally (unit 772 passed, subset 0 failed, golden 459/459, selfhost matches
  baseline); `pnpm run test:ffi` exit 0; `unit/static-lib.test.ts` 10 passed.

### Test-infra track: Darwin link retry, `test:ffi` real checks, C-consumer example ✅ (landed 2026-09-15)

Three pieces, one unblock: the pinned conda clang ships ld64-956, which cannot parse an
Xcode 26 SDK's `.tbd` files, so every Darwin link failed (plan-notes 266). `support/toolchain.ts`
owns the pure core (stale-linker signature, newest-readable-CLT-SDK pick, `staleLdRetryArgs`
shared by the CLI link, the export-stubs consumer link, and the FFI C-consumer link);
`cli/build.ts` link() retries once after a signature-carrying failure (zero green-path cost,
terminal output byte-identical); the justfile's `runtime-test` corpus link retries the same
way in bash. Pinned in `tests/unit/toolchain-sdk.test.ts` (6 tests, no toolchain).

`packages/tests/ffi/run.ts` went from 2 checks + 3 `TODO(step-7)` stubs to 5 real checks:
libm byte-compare in both modes (now in-process), the self-compiled `.c` fixture through
the `--link=` channel, a real `--emit-header` double build, and the ASan buffer-ownership
check (loud `not run` only without a sanitized archive) — plus `--filter`. Shared
build/oracle mechanics with the golden runner live in `tests/support/fixture-build.ts`
(`buildFixture`, `compileFixtureC`, `runNodeOracle`), which took `cpd` back to 0.9%.
Task 7.2 step 9's CI example is `packages/tests/ffi/example-c-consumer/` (init-twice,
success/boolean/throw-recovery paths, header `cmp`, byte-compare vs `expected.txt`),
wired into the ffi CI job.

Check evidence: unit 540/540, `test:ffi` 5/5 with 0 not-run, C-consumer `ok`,
`just runtime-test` matches Node, full ASan golden 386/386.

### Binding generator (Task 7.3 steps 3–5) ✅ (landed 2026-09-15)

`packages/compiler/src/ffi-gen/` maps C headers to `.d.ts` through `clang -Xclang
-ast-dump=json` — no new dependencies. Small IR, reverse ABI table mirroring
`exportAbiKindOf`, deterministic printer, and scope refusals (varargs, function pointers,
unions, bitfields, macro constants, inline functions) naming construct + header line with
a per-reason emitted/refused summary. Oracle prep: `sqlite3.h` regenerates at
172 emitted / 665 refused with zero kind mismatches against the hand-written binding
(11 name-spelling deltas only). Pinned in `packages/tests/unit/ffi-gen-binding.test.ts`
(12 tests, every emitted decl through the real `classifyExternDeclaration`).
Open for the wiring follow-up: generator-refusal STA family, TS-name/brand policies, and
`@statorLink` emission (plan-notes 270).

### Steps 3–5 — String converters, gate refusals, extern-call lowering ✅ (landed 2026-09-14)

Step 3 (runtime): `jsrt_string_to_cstr` (borrow) / `jsrt_string_from_cstr` (copy) with a strict
maximal-subsequence U+FFFD decoder, NUL truncation on input, lone surrogates → U+FFFD (making
`to_cstr∘from_cstr` a fixed point), `from_cstr(NULL)` asserting (NULL belongs to step 4);
`print_ffi_strings` corpus proves all of it byte-for-byte against Node. Steps 4–5 (compiler):
`src/frontend/extern.ts` (the one reader of the surface; `ts.Type` never leaves it), `ExternCall`
HIR node, gate marker/placement/signature/arity/spread/value-use arms, verifier STA4098
defense-in-depth, emitter direct calls (unboxed, temporaries freed before throws, `errno`
zeroed pre-call and read post-call), closed `@statorError` vocabulary with the return-kind
compatibility matrix, and `explain`'s `externCalls` audit flag. Lying declarations die at the
clang line (conflicting types), not silently. Branded pointers defer as STA1217 (step 6 owns
ownership); `ts` arity is the checker's, `js` arity the gate's.

Check evidence: `tests/golden/{ts,js}/extern_libm/` (`sqrt`/`fmod`/`log`/`atof`/`getenv`)
byte-exact vs Node in both modes; 17 `subset_extern_*` decision fixtures + the 4 step-3
`subset_extern_cstr_*` flipped to `static`; 13 unit tests; full suites green (unit 409,
subset 411, golden 216, leak plateau); targeted ASan/UBSan extern runs clean, zero sanitizer
output. `docs/FFI.md` §§1–5 now state every implemented rule (CString returns, brand
recognition, `any`→STA1114, overloads, untagged-ambient fate, STA1217 scope, convention
matrix); §8 sketches Task 7.2 as a non-normative appendix.

---

## Phase 5 step 13 — Module-scope closures, and the two defects stacked in front of them (2026-09-04)

Entry 192 ended by reporting a divergence it had found and deliberately not fixed: a closure created
at MODULE scope capturing a loop-body binding printed `20 20 20` where Node prints `0 10 20`. Fixing
it meant fixing two unrelated defects first, because neither let the repro compile.

**The console call had no value.** Every `console.*` entry point returns `void` in C. The emitter
returned that call as an expression, which is correct in statement position and a hard error in
value position — `const r = console.log(x)` emitted `JSRT_LOCAL(0) = jsrt_print(...)` and clang
refused the file (`STA0009`). The HIR had always said otherwise: the verifier pins a console node's
type to `undefined`. The emitter now supplies that value with the `void` operator's own shape,
`(call, JSRT_UNDEFINED)`, in value position only — as a statement it would be a `-Wunused-value`
warning on every `console.log` in the program, which was measured rather than assumed. One
`consoleCall` helper serves both positions so the width-to-entry-point rule is stated once.

**The `for-of` binding had two types.** The lowering typed the loop variable from the checker at the
binding name; the verifier typed it from the lowered iterable. Those agree everywhere annotated and
disagree exactly where js mode widens something the checker still resolves — `const xs = [];
xs.push(1)` is an evolving array, `number[]` to the checker and `Unknown` to the widening — so the
binding claimed a type the emitted loop never produced (`STA4010`). `forOfElementType` moved from
`verify.ts` to `hir/nodes.ts`; both callers ask it now, so the two answers cannot drift apart again.

**The capture itself.** The root cause was one assumption in `lower/captures.ts` pass 1: a
module-level binding lives in the globals array, so it is never a capture. True for the life of the
program, false for a `let`/`const` declared inside a top-level loop — JavaScript re-creates that
binding every iteration, and one global slot cannot hold three of them. The module now owns an
environment (`EnvOwner = FunctionLike | ts.SourceFile`) holding exactly those bindings, laid out by
the rule a function's `envVars` already follow.

No new mechanism: `loopNeedsPerIterationEnv` had been firing at module scope all along and
`enterLoop` discarded it for want of an environment (`envMap.size > 0`), so the clone/commit pair
now runs there unchanged. `JSRT_GLOBALS_ENV` roots the module env through the globals frame — the
only frame a sync `main` has — and the async-module path reuses the layout an async FUNCTION already
uses (captured bindings at indices `0..envVars.length-1`, suspension-surviving locals past them), so
top-level `await` needed no separate case. `var` is excluded on purpose: one shared binding IS its
semantics, and the globals array already implements that.

**Check.** `pnpm run ci` clean on the pinned Node:

```
biome check --error-on-warnings .   Checked 85 files. No fixes applied.
tsc --noEmit (src + tests)           clean
unit:    368 tests, 368 pass, 0 fail
golden:  151 fixtures — 151 passed, 0 failed
subset:  342 fixtures — 313 passed, 29 expected-fail, 0 failed
runtime: print corpus matches Node
asan:    print corpus matches Node (ASan/UBSan); golden 151/151 passed
leak:    10M objects — peak RSS 3024 KB of a 65536 KB cap, plateau
dupes:   72 clones · 0.9% duplication
```

ASan/UBSan matters more than usual here: the module environment is a new GC root, reached through
the globals frame rather than a stack frame, and the new fixtures exercise it under the sanitizers.

Fixtures, all matching the pinned Node byte-for-byte:
`tests/golden/{js,ts}/module_loop_capture.*` pin four semantics measured against Node rather than
assumed — the loop VARIABLE is per-iteration too (`for (let i)` closures print `0 1 2`); a write
after the closure is built is visible through it, so the closure holds the binding and not a
snapshot; `var` in the same shape still prints `3 3 3`; and nested top-level loops each contribute
their own binding. `tests/golden/{js,ts}/console_builtins.*` gained the value positions — the ts
twin asserts they COMPILE and prints `typeof`, because TypeScript types `console.log` as `void` and
refuses it as an argument. `tests/golden/js/dyn_unknown.js` gained the evolving array, including a
mixed-element one and an `entries()` view.

### Step 12e (named function expressions) — inner self-binding (2026-09-12)

The last receiver-free construct in family (e). `gateFunction` had been refusing named function
expressions outright; the lowering already carried `FunctionExpr.name` for diagnostics and the
emitter's C symbol, but nothing declared the inner identifier in the function's scope.

**Lowering** declares the source name in the function's inner scope before the body is lowered
(`inner.declare`), records the HIR spelling on `FunctionExpr.selfBinding`, and tracks it in
`immutableSelfBindings` so an assignment lowers to a `type-error` node rather than a write.
**Codegen** binds the self slot during counting and initialises it at function entry with
`emitNamedFunctionSelfBinding` — the same closure the expression evaluates to, which is enough for
recursion when the function captures nothing (the common case). **Verifier** registers
`selfBinding` as `const` in the function body's binding map.

Reassignment of the inner name is rejected at compile time by the TypeScript checker (`STA0012`),
which is stricter than Node's runtime `TypeError` but matches Stator's ESM/strict pipeline; subset
fixtures pin that refusal in both modes.

**Check.** On the pinned Node (2026-09-12):

```
pnpm run typecheck   clean
pnpm run lint        clean
pnpm run test:subset subset: 368 fixtures — 343 passed, 25 expected-fail, 0 failed
pnpm run test:golden golden: 199 fixtures — 199 passed, 0 failed
```

Fixtures: `tests/golden/{js,ts}/named_function_expression.*` (recursion via inner name, outer scope
does not see it); `subset_named_function_expression_{ts,js}`; `subset_named_function_expression_assign_{ts,js}`.
`gate.ts` emits no `not-yet` for named function expressions.


### Task 6.12 — Pin the oracle exactly (2026-09-15)

The task's premise aged out before the work did: `mise.toml` already selected
`node = "26.7.0"` exact (no re-baseline — the pin never moved) and
`scripts/check-node.mjs` already compared full versions with a mise↔pin drift check.
Verification closed the remaining legs: pinned Node prints the match (exit 0); bare
v24.20.0, a skewed `STATOR_NODE`, an unrunnable oracle, and a scratch-copy
`node = "26"` drift all refuse (exit 1); `engines >= 24` stays a range floor by design.

**Check.** `mise exec node -- node --version` is `v26.7.0`, equal to `.node-version`;
the preflight refuses every skew above; and the gate is green on the pinned Node with
every suite run directly (mise's pnpm is unusable from a raw child process on this
machine — plan-notes 204 — so `pnpm run ci` itself cannot execute here, only its steps):
typecheck (both projects) clean, oxlint 0/0, oxfmt gate-globs clean, cpd 0.9%, unit
540/540, subset 663 (625 passed, 38 expected-fail, 0 failed), golden 386/386 serial and
`--shards=8` byte-identical (17s vs 113s), builtins exit 0, leak plateau both loops,
`test:ffi` 5/5 with 0 not-run, C-consumer `ok`, runtime-test corpus matches Node, and
the full ASan golden pass 386/386. The `ci green` leg was blocked only by the host link
failure of plan-notes 266; with that fixed nothing stands between the pin and green.

---

## Phase 9 — Zig memory core ✅ COMPLETE (2026-09-16)

*`plan.md` §11a. The Language & library boundaries table stays in `plan.md`: it is normative
(Zig never grows past the memory core without a new card). The `mlugg/setup-zig@v2` CI
install is still open for the creator (plan-notes 272) — CI runtime jobs fail at
`zig: command not found` until it lands.*

~~**T9.1. Runtime memory core in Zig**~~ ✅ Done — re-applied onto main (base `9f2eba4`) in
four commits, one per move step, **not** a merge of the stale `.worktrees/t9-1` planning
change (base `82d833f`-era, whose uncommitted tree also carried unrelated phase work).
The Zig root `packages/runtime/src/jsrt_mem.zig` builds one object, `jsrt_zig.o`, from
`jsrt_gc.zig`, `jsrt_buf.zig`, `jsrt_shape.zig` and `jsrt_alloc.zig`, declared for C in
`src/jsrt_mem.h`; `jsrt_gc.c` is deleted. The string ops have no growable buffer, so
nothing there moved. Property semantics stay in `jsrt_shape.c` and builtin-specific
constructors stay with their builtins. Two deliberate adaptations to main's drift since
`82d833f` (plan-notes 273): no `jsrt_shape_array_index` (the Zig ordering calls the
shared `jsrt_key_is_array_index` instead of carrying a second copy) and no
`jsrt_dynobj_new_class`/`bool dynamic` (that index-signature-class surface does not
exist on main).

**Check — PASSED** (2026-09-16, arm64 macOS, zig 0.16.0, Boehm, pinned Node 26.7.0):
`pnpm run ci` green end to end — typecheck/lint/dupes clean; unit 564/564; runtime
print corpus matches Node (rel and ASan/UBSan); subset 675 fixtures (637 passed,
38 expected-fail, 0 failed); golden 386/386 plain and 386/386 under ASan; leak plateaus
(10M objects 3664 KB peak, 10M FFI strings 3728 KB peak). "No C file still holds moved
code": every one of the 30 Zig exports is defined exactly once in `libjsrt.a`
(`nm`-checked), and `grep` finds only call sites left in C. `docs/TOOLCHAIN.md` lists
zig.

## Phase 11 — T11.0 research ✅ (2026-10-02)

### T11.0. Research: what `--node` means and what it costs — **[D3]**

Docs only. The output is `docs/research/node-mode.md`. Every fact in it carries its primary
source: the URL plus the version or the date it was checked. The research answers these
questions:

1. **Surface, measured rather than guessed.** Which Node globals and `node:*` modules a corpus
   actually uses, in priority order. Start from the `tsc` bundle (plan-notes 286), then add a
   few popular CLIs. Cover sync vs async `fs`, and what `ts.sys` needs.
2. **Mode shape.** Is `--node` a third `--mode` or a platform flag orthogonal to `ts`/`js`? How
   does it stay a policy layer above the frontend gate (§0.8)? Cover file acceptance, the
   diagnostic table, and ambient types (`@types/node` or our own declarations).
3. **CommonJS semantics.** A literal `require("x")` as a module-graph edge; `module.exports` and
   `exports` interop with ESM; `__dirname` and `__filename`; `require.resolve`. Computed
   `require(expr)`, which is how `tsc` loads plugins, is a Phase 8 question. CommonJS cycles
   are legal and expose partially built exports, which conflicts with `STA3001`.
4. **Backing.** Which built-ins can sit on `std` (T10.1) C functions, and which need libuv or an
   event loop on Task 4.6's machinery. Cover how prior art handles this: Bun's and Deno's Node
   compatibility, Static Hermes, Porffor, and Node SEA / pkg (which bundle Node rather than
   compile ahead of time).
5. **Oracle.** How goldens prove Node parity for I/O: byte-exact stdout and stderr, exit codes,
   the filesystem side effects. Is a slice of Node's own test suite a usable conformance
   ratchet, the way Test262 is?
6. **Diagnostics.** Which codes `docs/DIAGNOSTICS.md` must allocate, and whether `STA1110`
   narrows to "never outside `--node`". Codes are never reused or renumbered.
7. **Cost and verdict.** An effort estimate per slice, and a go / no-go recommendation.

**Creator's constraint (2026-10-02): two layers, `std` first.** Stator gets its own base
libraries for files, network, processes, time, OS information and the like, as typed `std/*`
modules backed by C (the §11b A model, extended past T10.1's v0 table). `node:*` modules are
thin wrappers over `std`, never C of their own. So the research must answer, per Node module the
corpus needs, which `std` module and functions would back it. T10.1's `std/fs`, `std/process`
and `std/time` are the start, and `std/net`, `std/child_process`-style spawning and an event
loop are likely new rows.

**Execution plan.**
1. Measure the corpus with a TypeScript-API scanner (`packages/tests/` is not touched; the
   script and its raw output go under `docs/research/node-mode/`). Count `require` /
   `node:` specifiers, `process.*` / `Buffer.*` / timer uses, and the members used per
   module. The corpus is `tsc` 6.0.3 plus other bundled CLIs in this repo's `node_modules`, with
   versions recorded.
2. Primary-source research, run in parallel:
   - Node 26 docs: the module surface, CommonJS loading and cycles, `process`, `Buffer`.
   - Prior art: Bun, Deno, Static Hermes, Porffor, Node SEA / pkg.
   - Backing: libuv, and how other systems stdlibs layer files, net and processes.
   - The oracle: Node's own test suite layout.
3. Write `docs/research/node-mode.md`. It holds the `std` layer table (module → functions → C
   backing), the `node:*` → `std` mapping, the mode shape, CommonJS semantics, the oracle,
   diagnostics, cost per slice and the go / no-go.

**Status:** execution steps 1–3 are done — `docs/research/node-mode.md`, corpus under
`docs/research/node-mode/`, summary in plan-notes 288. The Check stays open until the creator's
decision is recorded.

**Check:** `docs/research/node-mode.md` exists with sources for every fact and ends in a
go / no-go recommendation; the creator's decision is recorded in `plan-notes.md`. If the answer
is go, the T11.1+ cards are written here, and §0, `STA1110` and §11b A are edited in the same
change.

**Check — PASSED** (2026-10-02): `docs/research/node-mode.md` exists, every fact carries its
primary source (URL + version or date checked), and §8 ends in a go / no-go recommendation. The
creator's decision is plan-notes 289 (go P0 + N1, defer N2, no N3; `--node` is a platform flag;
`std` backings and the loop in Zig; `node:*` written from scratch). The T11.1+ cards are in
plan.md §11c; §0 (Zig rule, no-JS rule, non-goals), `STA1110` (docs/DIAGNOSTICS.md note) and
§11b A (backed by Zig, new rows) were edited in the same change.

## Phase 12 — T12.0 design ✅ (2026-10-02)

### T12.0. Design: the bundler contract — **[D3]**

Docs first (§15.6): `docs/BUNDLER.md`, settled with a measured spike — one `js` golden fixture
bundled by Vite, compiled by Stator, output byte-for-byte equal to Node. Questions it must answer:

1. **Typed code in a mixed graph.** A bundler strips TS types, which would turn typed `.ts` in a
   `js`-mode graph dynamic. Options: bundle everything (all dynamic), or keep project `.ts` out of
   the bundle as typed modules and bundle only JS (`node_modules`, `.js`). Measure both.
2. **Output contract.** One ESM chunk, no code splitting (dynamic `import()` inlined), no
   minification by default (names show up in diagnostics and stack traces), a source map always.
3. **Externals.** `std/*`, `node:*` and bare built-ins stay external and are resolved by Stator
   (§11c packages).
4. **CommonJS.** If the bundler converts CJS, §11c T11.5 shrinks to the flag, the globals and
   external resolution — record the re-scope in T11.5 in the same change.
5. **The API.** `statorc/api` takes the bundle plus its source map; `BundlerAdapter` is
   `{ name, bundle(entry, options) → { code, map, inputs } }`; `--bundler=vite|none|<module>`; the
   default is `vite` in `js` mode. What happens when the default adapter is not installed — a
   `STA0xxx` naming the package, allocated in `docs/DIAGNOSTICS.md`.
6. **Diagnostics.** Every span in a bundled file maps back to its original file through the
   source map; a span with no mapping says so rather than pointing into the bundle.
7. **Caching.** How the bundle step participates in the program cache (Task 6.9) and in moon.

**Check:** `docs/BUNDLER.md` answers 1–7 with the spike's numbers; plan-notes records the choice;
T12.1–T12.2 are edited to match.

**Check — PASSED** (2026-10-02): `docs/BUNDLER.md` answers questions 1–7 with the numbers from
`docs/research/bundler/spike.ts` (Vite 8.3.1 / Rolldown 1.2.12, Node 26.7.0). The choice is
plan-notes 296: bundle package imports and CommonJS project files into one vendor ESM module,
and keep the project `.ts`/ESM `.js` in Stator's graph.

The answers, measured:

1. **Typed code.** Bundling the whole graph turns `fib` from static to dynamic and drops
   `STA2001`. B keeps both.
2. **Output contract.** The bundle is one ESM file with `codeSplitting: false`,
   `topLevelVar: false`, no minification and a source map. It runs as an SSR build, because
   library mode stubs `node:*`.
3. **Externals.** `node:*`, built-ins and `std/*` stay ESM imports.
4. **CommonJS.** Rolldown's `__commonJSMin` converts it, so T11.5 loses its CJS lowering.
5. **API.** `BundlerAdapter.bundle(entry, { external })` returns `{ code, map, inputs }`.
   `--bundler=vite|none|<module>`, and the adapter loads only when the graph needs it.
6. **Diagnostics.** `node:module` `SourceMap` maps `bundle.js:3:9` back to `dep.js:4:10`.
   Runtime helpers are reported as unmapped.
7. **Caching.** The bundle step is 1–3% of a build and Rolldown has no persistent cache, so
   the vendor sha256 goes into the program-cache key.

Every bundle that compiled matched Node byte-for-byte. The one known deviation is the package
evaluation order, recorded in BUNDLER.md §1.

T12.1 and T12.2 were edited, T12.3 is new, and T11.5 was re-scoped, all in the same change.
The three questions in BUNDLER.md §9 were answered by the creator on 2026-10-02:

- "one file" means the dependencies;
- `__filename`/`__dirname` are `not-yet` until `--node`, with no paths baked into the binary;
- the order deviation is documented only.

The T12.1, T12.2, T12.3 and T11.5 cards were edited to match.

## Phase 11 — T11.2 std package ✅ (2026-10-02)

### T11.2. `packages/std`: the real `std/*` package — **[D4]**

Today `std/env` and `std/path` are golden fixtures over `declare` externs (plan-notes 284), not an
importable package. Steps: create `packages/std` (workspace member + moon project; `src/<module>.ts`
surface, `zig/<module>.zig` backings building `libjsrt_std.a`); the compiler resolves `std/*` to
it and links the library only when a program imports `std/*`; unknown `std/foo` stays a hard
error (STD.md §1); move `std/env` + `std/path` in; land T10.1 steps 3–4 (`std/process`, sync
`std/fs`, `std/time`) here. Update `docs/STD.md` (no longer a skeleton) and `packages.d2`.

**Check:** `std_env` / `std_path` goldens pass through `import … from 'std/…'` with no
`declare` fixture; T10.1's Check; a program without `std/*` imports links no `libjsrt_std.a`.

**Execution plan** (Claude Code / opus-5-5, branch `t11-2-std-package`):

1. `packages/std`: `package.json` (private workspace member), `moon.yml` (`build`, `typecheck`),
   `tsconfig.json` (Stator's own subset: es2025 lib, no Node types), `justfile` (`just std` →
   `build/libjsrt_std.a`, one Zig root `zig/jsrt_std.zig` importing one file per module,
   `zig fmt --check`, the runtime's Zig flags and macOS target rule). Surfaces in
   `src/<module>.ts`, their extern declarations in `src/native/<module>.d.ts`. `std/path` is pure
   TS (no backing, no leak — the 284 C shims leaked every result); `env`, `process`, `fs`, `time`
   are Zig over libc, returning C strings through one reused result buffer the emitter copies.
2. Compiler: `src/frontend/std.ts` owns the `std/` prefix — the package root (sibling package,
   `STATOR_STD_ROOT` override), the module list (the files in `src/`), and one classifier
   shared by the gate and the checker-diagnostic mapping: a known module resolves through a
   `paths` entry on the program's options; `std/sync` / `std/thread` are not-yet naming Phase 10
   (`STA1214`); any other `std/foo` is a hard error with a new `STA3002`. `cli/build.ts` links
   the archive (before `-ljsrt`; it calls only libc and has its own panic handler) only when the module graph holds a
   `std` file; a missing archive is `STA0011` naming the std recipe.
3. Tests: `std_env` / `std_path` goldens rewritten as `import … from 'std/…'` (their `declare`
   fixtures, C shims and `.mjs` shims deleted), new `std_process` / `std_fs` / `std_time` goldens
   and one js-mode golden. The Node oracle loads one TS resolve hook mapping `std/<m>` to a
   Node-backed oracle module, or to the real `packages/std/src/<m>.ts` when the module has no
   backing (path). Decision fixtures in both modes per module plus unknown / thread refusals;
   a unit test proves the link line carries `libjsrt_std.a` only for a `std` importer.
4. Wiring: pnpm workspace + lockfile importer, moon project + `std:build` edges, `pnpm run
   runtime` / `test:intl` / `test:asan` build the std archive too, root `typecheck` covers
   `packages/std`.
5. Docs: `docs/STD.md` (implemented, §8 questions answered), `SUBSET.md` std rows,
   `DIAGNOSTICS.md` (`STA3002`, `STA0011` scope), `packages.d2` + SVG, `TOOLCHAIN.md`,
   `AGENTS.md` repo map + commands, `README`s; plan-notes 294.
6. Verify with the full gate (tsc ×3, oxlint, oxfmt, cpd, vitest, subset, golden, builtins,
   node-coverage, `zig fmt --check`, runtime `-Werror` build, ASan gate), then move the record to
   `done.md` and leave the stub.

**Check — PASSED** (2026-10-02, darwin/arm64, Node per `.node-version`, on main `fde70c0`):

- `std_env` / `std_path` goldens pass through `import … from 'std/…'` with no `declare`
  fixture: the 284 fixtures (`env.d.ts`, `path.d.ts`, `path.c`, both `node_shim.mjs`,
  `helper_std_*.d.ts`) are deleted, and `node packages/tests/golden/run.ts` →
  `golden: 402 fixtures — 402 passed, 0 failed` (std goldens: `std_env`, `std_path`,
  `std_process`, `std_fs`, `std_time`, js `std_js`).
- T10.1's Check (`std/process`, sync `std/fs`, `std/time` with goldens against Node): the same
  run; `node packages/tests/subset/run.ts` → 761 fixtures, 724 passed, 37 expected-fail,
  0 failed (std fixtures in both modes per module, plus `STA3002` unknown and `STA1214`
  thread refusals).
- A program without `std/*` imports links no `libjsrt_std.a`: `unit/std.test.ts` proves the
  link line carries the archive only for a std importer (before `-ljsrt`, the only difference)
  and that the module-graph test is false for a plain program. Vitest → `Tests 607 passed (607)`.
- Rest of the gate: `tsc --noEmit` for compiler, tests and std clean; `oxlint --deny-warnings`
  0 warnings; `oxfmt --check` clean; `cpd .` passes against the baseline (no new clones);
  `golden/builtins.ts` → 223/238 members (94%), exit 0; `node-coverage.ts --check` →
  `docs/NODE.md is current`; `zig fmt --check` clean; runtime `-Werror` build and `just std`
  green; `STATOR_ASAN_FORCE=1 node packages/tests/golden/asan-gate.ts` → print corpus matches Node
  under ASan/UBSan, golden-asan 402 passed, 0 failed.

Design decisions, deviations, the emitter fix and the pre-existing gaps it found: plan-notes 294.

## Phase 11 — T11.1 typed arrays ✅ (2026-10-02)

### T11.1. `packages/runtime`: typed arrays — **[D4]**

`Buffer` is a `Uint8Array` subclass, and every byte-level API (file reads, hashes, codecs) needs
a byte container; the tree has none. Steps: `ArrayBuffer` + `Uint8Array` first (constructor
forms, indexing, `length`, `subarray`, `set`, `slice`, iteration), storage in Zig (§0.5), then the
rest of the `TypedArray` family only as the corpus needs it. Docs: `docs/SUBSET.md` rows,
`builtins_coverage.json` namespaces.

**Check:** decision tests (both modes) + goldens for every landed member; `test:builtins` lists
the new namespaces; ASan clean.

**Execution plan (Claude Code / opus-5-5, branch `t11-1-typed-arrays`):**
1. Runtime: `JSRTArrayBuffer` / `JSRTTypedArray` layouts + entry points in `jsrt_value.h`; storage,
   construction, element get/set (ToUint8), `subarray`/`slice`/`set`, `ArrayBuffer.slice` and the
   dynamic-method closures in a new `src/jsrt_typed.zig` (byte storage is pointer-free memory).
   C hooks only where the existing C dispatches: `jsrt_get_prop` / `jsrt_dyn_index_*` (dynamic
   tier), `jsrt_get_iterator` (a typed-array walk kind), `console.log` (Node's `Uint8Array(n) [ … ]`
   / `ArrayBuffer { [Uint8Contents]: <…>, [byteLength]: n }`), `String()` / `JSON.stringify`,
   `instanceof`.
2. Compiler: HTypes `uint8array` and `arraybuffer` (leaves -- the next element type is a new leaf
   and new rows, not a generic); one HIR node `typed-op`
   driven by one table (`TYPED_OPS`, hir/nodes.ts) that the gate, lowering, verifier (new
   STA4101) and emitter all read; `u[i]` / `u[i] = v` reuse the index nodes; `for-of` goes through
   `get-iterator` with a `number` element.
3. Tests: decision tests (ts + js, static + a dynamic js case + not-yet for unlanded members),
   goldens `ts/typed_arrays.ts` + `js/typed_arrays.js` (+ dynamic js), ASan gate.
4. Docs: `docs/SUBSET.md` row, `docs/VALUE.md` §4.19, `docs/DIAGNOSTICS.md` STA4101,
   `builtins_coverage.json` namespaces; then the record moves to `done.md`.

**Landed.** Runtime: `packages/runtime/src/jsrt_typed.zig` (new) holds the two classes, the
storage (an atomic, zero-filled byte block per buffer; `jsrt_gc.zig` gained `allocAtomic`), every
entry point and the method closures the dynamic tier hands out; `jsrt_value.h` declares the
layouts and the C ABI. C hooks: `jsrt_get_prop` → `jsrt_typed_get_prop`, `jsrt_dyn_index_get`/`_set`,
`jsrt_get_iterator` (`JSRT_ITER_UINT8ARRAY`), `console.log` (`inspect_list` now prints arrays and
views from one layout; `inspect_heap` is the shared builtin dispatch), `String()` /
`JSON.stringify`, `instanceof`, and `is_fixed_shape_object`. Compiler: `TYPED_OPS` rows for
`new ArrayBuffer`, `new Uint8Array`, `ArrayBuffer.prototype.byteLength`/`slice`,
`Uint8Array.prototype.length`/`byteLength`/`byteOffset`/`buffer`/`subarray`/`slice`/`set`; the gate
refuses everything else by its qualified name (`STA1214`, phase 11); verifier `STA4101`;
codegen's `indexGetCall`/`indexSetCall` pick `jsrt_uint8array_get`/`_put` for a `uint8array`
target. Tests: decision tests `subset_typed_arrays_{ts,js,dynamic_ts,dynamic_js,not_yet_ts,not_yet_js}`,
goldens `ts/typed_arrays.ts` + `js/typed_arrays.js` (the js one also drives the dynamic tier),
`unit/typed-arrays.test.ts`. Docs: `docs/SUBSET.md` (two rows, plus `for-of` and `instanceof`),
`docs/VALUE.md` §4.19, `docs/DIAGNOSTICS.md` STA4101, `builtins_coverage.json` (globals
`Uint8Array`/`ArrayBuffer`; namespaces `Uint8Array`, `Uint8Array.prototype`, `ArrayBuffer`,
`ArrayBuffer.prototype`).

**Known ceilings** (documented in docs/SUBSET.md): an expando write on an untyped view panics with
`STA2004`, like every statically shaped builtin; a dynamic call of an unlanded method reads
`undefined` and throws the missing-method TypeError; `Object.keys` on a view is refused by the
existing argument gate; a constructor of another element type falls under the generic `new`
refusal. No runtime print corpus was added: the corpora are `.mjs` scripts, the no-JS rule (plan.md §0
item 10, plan-notes 289) stops a new one until Task 6.15 migrates them, and the goldens prove the
same printer against Node.

**Check — PASSED** (2026-10-02, rebased on T11.2 `ce66355`):
- decision tests: `node packages/tests/subset/run.ts` → `subset: 767 fixtures — 730 passed, 37 expected-fail, 0 failed` (six new typed-array fixtures, both modes, static / dynamic / not-yet);
- goldens: `node packages/tests/golden/run.ts` → `golden: 404 fixtures — 404 passed, 0 failed`;
- `node packages/tests/golden/builtins.ts` → `builtins: 234/294 surface members landed (80%)`, listing `Uint8Array: 0/5`, `Uint8Array.prototype: 7/40`, `ArrayBuffer: 0/1`, `ArrayBuffer.prototype: 2/8`;
- ASan: `node packages/tests/golden/asan-gate.ts` → `golden: 404 fixtures — 404 passed, 0 failed` under ASan/UBSan, `golden-asan green`;
- also clean: `tsc` (compiler, tests, std), `oxlint --deny-warnings`, `oxfmt --check`, `cpd` (217 clones, no new ones against the baseline), `vitest` (47 files, 613 tests), `node-coverage --check`, `just runtime-test`, `zig fmt --check`.

## Phase 10 — T10.1 std low-level API ✅ (2026-10-02)

**Landed 2026-10-02** (plan-notes 284, 294, 307). Steps 1–4 landed with T11.2 (`std/env`,
`std/path`, `std/process`, sync `std/fs`, `std/time` in `packages/std`, docs/STD.md). Step 5
closes the card: the Promise twins of the sync `std/fs` calls (`readTextAsync`,
`writeTextAsync`, `statAsync`, `mkdirAsync`, `unlinkAsync`, `rmdirAsync`) are `STA1214` naming
Phase 10 (T10.2's thread pool) in both modes, where before they were the checker's plain
"no exported member" (`STA0012`). The twin list is `THREAD_POOL_MEMBERS` in
`frontend/std.ts`; `stdImportRefusal` in `frontend/program.ts` maps TS2305/TS2724 on a twin to
it. Every other missing member keeps `STA0012`. No new diagnostic code.

**Check evidence:**

- goldens: `node packages/tests/golden/run.ts --filter std_` → 6 passed (`std_env`, `std_path`,
  `std_process`, `std_fs`, `std_time`, `std_js`), each against its `std-oracle` Node twin;
- subset rows match docs/SUBSET.md: `node packages/tests/subset/run.ts --filter subset_std` →
  17 passed, including `subset_std_fs_async_ts`/`_js` (not-yet `STA1214`) and
  `subset_std_fs_missing_ts` (error `STA0012`);
- no Node polyfill dependency: `packages/std/package.json` declares only a `typescript`
  devDependency;
- self-compilation: compiler `STA1214` 2549 → 2553, recorded with `--update` (plan-notes 306).

The card as it stood in plan.md:

### T10.1. `std` low-level API (sans threads) — **[D4]**

Steps:

1. Write `docs/STD.md` (module path, error model, v0 table above). Add stub `SUBSET.md` rows /
   diagnostics that name Phase 10.
2. ~~Wire `std/env` and `std/path` end-to-end (types → runtime → golden).~~ Landed (plan-notes
   284), then moved into `packages/std` by T11.2.
3. ~~Add `std/process` (`exit`/`pid`).~~ Landed in `packages/std` by T11.2 (plan-notes 294).
4. ~~Add sync `std/fs` + `std/time` (`nowMs`; sync `sleepMs` only).~~ Landed in `packages/std`
   by T11.2 (plan-notes 294).
5. Promise-flavored `std/fs` APIs: either `not-yet` until T10.2, or implemented as sync under a
   documented lie — **prefer not-yet** so async programs do not block main by accident.

Steps 2–4 live in `packages/std` since T11.2 (plan-notes 294); step 5 is what remains — today
`std/fs` simply has no Promise members, and the card closes when that refusal is a `not-yet`
naming Phase 10.

**Check:** goldens for env/path/process/fs sync; subset rows match; no Node polyfill dependency.

## Phase 11 — T11.5a per-module namespaces ✅ (2026-10-02)

### T11.5a. `packages/compiler`: per-module namespaces — **[D4]**

Creator's direction (2026-10-02, plan-notes 302). This is a prerequisite of T11.6. Today one
program has **one** namespace, so three things go wrong:
- Importing a module reserves all of its top-level names, exported or not, for the whole program.
  A user `function get()` next to `import { has } from "std/env"` is `STA1214`.
- Every aliasing shape is `STA1214` (docs/SUBSET.md, "Renamed/default/namespace imports" and
  "Re-exports" rows), so a library cannot hide its helpers or rename what it exports.
- `packages/node` would hit both on every module (plan-notes 294).

Steps:
1. **Per-module symbols.** Every module's top-level bindings get a module-qualified C name. Two
   modules may then declare the same name, and a module's unexported names are invisible to
   others. Diagnostics and `#line` mapping keep the source name.
2. **Aliasing imports.** `import { x as y }`, default imports, and `import * as ns` as a static
   namespace object. A static `ns.x` resolves at compile time, like the `import()` namespace from
   Phase 5 step 10. A namespace that escapes as a value uses that same `HObject`
   (`namespace: true`).
3. **Aliasing exports.** `export { x as y }`, `export default`, and re-exports:
   `export { x } from`, `export * from` (with ES ambiguity rules: a name exported twice by `*` is
   dropped, not an error) and `export * as ns from`. This takes over T12.1 step 3's
   `export { a as b }`. Whichever card lands first owns it, and the other cites it.
4. **Both modes, both kinds of graph.** The same rules apply to `ts`-mode modules, `js`-mode
   modules and mixed graphs. `std/*` and the T12.1 vendor module are ordinary modules here,
   with no special case.
5. **Docs.** Flip the SUBSET.md rows. The Phase 5 step 12 line that still owns `import * as ns`
   cites this card. Update MODES.md if init order or live bindings show a Node difference.

**Check:**
- A user `function get()` beside `import { has } from "std/env"` builds.
- Two modules with a same-named private helper build and run as under Node.
- Decision tests flip `not-yet` → `static` for every aliasing shape in both modes, removing the
  `// @expected-fail` markers in the same commit.
- Goldens cover renamed imports and exports, default, `import * as ns`, `export *` with an
  ambiguous name, and a re-export chain. Each matches Node byte for byte.
- `STA1214` is no longer emitted for those shapes, and the `test262` `language/module-code`
  pass count rises, recorded in plan-notes.

**Check — PASSED as amended** (the creator moved the test262 clause to T11.4 on 2026-10-02, plan-notes
302; run 2026-10-02, darwin/arm64, Node per `.node-version`,
on main `ede4537`):

- **`std/env` beside a user `get`.** `import { has } from "std/env"; function get(): number {
  return 41; }` builds and prints `42 true`.
- **Same-named private helpers.** Two modules declaring the same private helper build and run as
  under Node: the fixtures `subset_cross_module_collision_{ts,js}`, and the
  `golden/{ts,js}/module_aliasing` goldens.
- **Decision tests.** `node packages/tests/subset/run.ts` →
  `subset: 793 fixtures — 758 passed, 35 expected-fail, 0 failed`.
  - Every aliasing shape is static in both modes: renamed, default and namespace imports; renamed
    exports; `export default <expression>`; `export *`; `export * as`; cross-module collisions.
  - `subset_re_exports_{ts,js}` lost `@expected-fail` in this change.
  - The ambiguous `export *` is `STA3003` in js mode and `STA0012` (TS2308) in ts mode.
- **Goldens.** `node packages/tests/golden/run.ts` → `golden: 408 fixtures — 408 passed, 0 failed`.
  - `golden/ts/module_aliasing` covers renamed imports and exports, default exports,
    `import * as ns`, `export * as` and a re-export chain.
  - `golden/js/module_aliasing` is a mixed js + ts graph. It adds `export *` with an ambiguous
    name and an expression default.
- **`STA1214` is gone for those shapes**, and the self-compilation baseline shrinks with it.
  `node packages/tests/selfhost/run.ts` reported `packages/compiler: STA1214 2572 -> 1771`, and
  `--update` recorded the new count in `packages/tests/selfhost/baseline.json`.
- **test262 `language/module-code` (599 tests): moved to T11.4 by the amendment.** The pass count
  does not rise yet; these numbers are T11.4's baseline.

  | Run | Passed | Skipped | Failed |
  | --- | --- | --- | --- |
  | before | 152 | 351 | 96 |
  | after | 152 | 426 | 21 |

  - The "before" runner compiled module tests away from their fixtures. Its SyntaxError
    passes, the four ambiguous-export tests among them, matched "Cannot find module".
  - The runner now compiles each module test beside its fixtures. The four ambiguous-export tests
    pass on `STA3003`, and no positive module test can pass yet, because the corpus harness itself
    is `STA1214`.
  - Full evidence is in plan-notes 302, "Implementation" and "Check amended". The clause needs the
    harness to compile, which is T11.4's unsupported-globals work.
- **Rest of the gate** (`pnpm run ci`, exit 0).
  - `tsc` (compiler, tests, std), `oxlint --deny-warnings` and `oxfmt --check`: clean.
  - `cpd`: 207 clones, none new against the baseline.
  - vitest: 50 files, 672 tests.
  - `just runtime-test`: the print corpus matches Node.
  - `builtins`: 234/294. `node-coverage --check`: current.
  - leak: plateau.
  - ASan: `node packages/tests/golden/asan-gate.ts` → 408 passed, `golden-asan green`.

## Phase 11 — T11.3a `Uint8Array` across the extern boundary ✅ (2026-10-02)

**Landed 2026-10-02** (plan-notes 311, changelog v4.39). A `Uint8Array` is a parameter row of
the FFI table (docs/FFI.md §2). The new ABI kind is `bytes`: one TS parameter, two C arguments
(`uint8_t *`, `size_t`), pointing at the view's own storage for the call, with no copy. The
classifier maps it in `frontend/extern.ts`, and a return is STA1119 because a returned buffer has
no owner and no length. Exports keep the `jsrt_value` form. The lowering checks a dynamic
argument, and the emitter guards every other one with `jsrt_check_uint8array` (STA2001), because a
js-mode caller can reach an annotated `.ts` parameter with anything. The runtime gains the
`jsrt_uint8array_bytes`/`_count` accessors and the check. `std/io.writeBytes`/`read` take the row,
and the byte channel (`internal/bytes.ts`, `jsrt_std_bytes_*`) is deleted. A new fixture's Node
twin may be `node_shim.ts`.

**GC rule, as checked against T11.1's design.** The view stays in its rooted argument slot for the
call, and its `buffer` edge keeps the data block alive. Boehm is non-moving and the no-GC build is
plain malloc. A buffer never resizes or detaches. The C call runs no Stator code. So the pointer
is stable until the callee returns. No design change was needed.

**Check evidence:**

- **Decision tests, both modes:** `pnpm run test:subset` → 813 fixtures, 778 passed,
  35 expected-fail, 0 failed. New: `subset_extern_bytes_ts`/`_js` (static),
  `subset_extern_bytes_dynamic_js` (dynamic: the lowering's check), and
  `subset_extern_bytesret_ts`/`_js` (error `STA1119`).
- **Goldens, byte for byte vs Node:** `pnpm run test:golden` → 413 passed.
  - `golden/ts/extern_bytes` passes views into fixture C (`ffi.c`) and gets bytes back. It
    covers a fill through a `subarray`, a reverse in place, a window over `buf.buffer`, empty
    views and a 1 MiB fill. Its Node twin is `node_shim.ts`.
  - `golden/ts/std_io` writes a whole view and an offset `subarray` through `std/io.writeBytes`.
  - `unit/std.test.ts` reads a MiB from stdin through `std/io.read` and writes it back
    unchanged.
- **ASan:** `node packages/tests/golden/asan-gate.ts` → the print corpus matches Node under
  ASan/UBSan, 413 passed, `golden-asan green`.
- **One call, not 1M:** `extern_bytes` prints `calls for 1 MiB: 1` on both sides.
  `unit/std.test.ts` asserts a single `jsrt_std_io_write_bytes(`/`jsrt_std_io_read(` call site,
  each passing pointer + length.
- **Timing (hyperfine, M3 Max):** 10 MiB written goes from 87.1 to 3.9 ms, and 10 MiB read from
  247.5 to 5.3 ms, against a 3.6 ms startup floor. The numbers are in plan-notes 311.
- **The guard:** `unit/extern-bytes.test.ts` (5 tests) covers four things.
  - The classifier: a parameter is `bytes`, a return is `STA1119`, and the export position falls
    back to `jsrt_value`.
  - The paired prototype and arguments.
  - One guard per call, and none doubled on a dynamic argument.
  - A string through `std/io.writeBytes` from js mode ends with SIGABRT and `STA2001`, not
    SIGSEGV.
- **Rest of `pnpm run ci` (exit 0):** typecheck and lint are clean. `cpd`: 207 clones, none new.
  vitest: 51 files, 683 tests. `builtins` 242/304; `node-coverage` current; leak plateau.
  selfhost: 8 targets match the baseline, no `--update` needed (`std/io` stays static).

The card as it stood in plan.md:

### T11.3a. `Uint8Array` across the extern boundary — **[D3 · P1]**

Depends on T11.1 (the storage) and replaces T11.3's byte channel before T11.3 steps 2 and 3
merge.

- `Uint8Array` becomes a parameter row in the extern table (docs/FFI.md §2), and a return row
  too if that is cheap; decide and document it.
- The emitter passes pointer + length from the T11.1 Zig-owned storage; the backing copies at
  most once.
- GC rule: the buffer stays rooted and does not move for the call. Check the T11.1 design and
  say how it is guaranteed.
- `packages/std` drops `internal/bytes.ts` and the push/at channel; `io.writeBytes`/`read` move
  to the new row.
- Docs: FFI.md, STD.md §6, SUBSET.md, DIAGNOSTICS.md if STA1115's wording changes.

**Check:** decision tests in both modes; goldens that pass a `Uint8Array` to an extern and get
bytes back, byte-for-byte vs Node (for std/io); an ASan run; a unit or bench measurement showing
1 MB crosses in one call, not 1M, with numbers recorded in plan-notes.

## Phase 11 — T11.3 the N1 `std` modules ✅ (2026-10-02)

**Landed 2026-10-02** in three PRs (plan-notes 309; changelog v4.28, v4.29, v4.30), with T11.3a
(plan-notes 311) between steps 1 and 2.

- **Step 1** (#70): `std/os` and `std/io`. `std/io` calls libc directly, so a bad descriptor is
  `EBADF` rather than a Zig panic, and a write flushes C stdio first. Its bytes first crossed a
  byte channel; T11.3a replaced that with the extern table's `Uint8Array` row.
- **Step 2** (#71): `std/encoding` (Node's `Buffer` conversions; bytes-to-text through the
  backing, in NUL-free runs) and `std/hash` (Zig's `std.crypto` digests, `std.Io` secure
  random), both over the row.
- **Step 3**: `std/process` gains `argv`, `execPath`, `platform`, `arch`, `ppid`, `hrtimeNs`,
  `memoryUsage`, `exitCode`/`setExitCode`. The emitter's `main` takes `argc`/`argv` and returns
  the runtime's exit-code slot (`packages/runtime/src/jsrt_process.c`). `std/fs` gains
  descriptors (`open`/`read`/`write`/`close`), `readBytes`, `readdir`, `realpath`, `utimes` and
  `exists`.

**Check evidence:**

- **A golden per module against Node's equivalent:** `std_os`, `std_io`, `std_encoding`,
  `std_hash`, `std_process` and `std_fs`, each against its `golden/std-oracle/` twin.
  `pnpm run test:golden` → 415 passed.
- **Nondeterministic results by unit-test ranges** (`unit/std.test.ts`, 14 tests):
  `randomBytes` draws are fresh and cover all 256 byte values; `pid`, `ppid` (the spawning
  process), `execPath` (the binary's real path), `hrtimeNs` (a 20 ms sleep measures at least
  20 ms), `memoryUsage().rss` (1 MiB to 16 GiB) and `hostname` (Node's `os.hostname()`).
  Real arguments, a non-zero `setExitCode`/`exit`, an uncaught throw's status 1 and `abort` are
  there too, since the golden runner passes no arguments and demands status 0.
- **Subset rows in both modes:** `pnpm run test:subset` → 821 fixtures, 786 passed,
  35 expected-fail, 0 failed; `subset_std_{os,io,encoding,hash,process,process_n1,fs,fs_fd}_ts`
  and `_js` are all static except `std/hash`'s, which are dynamic (the `Uint8Array | string`
  union, STD.md §5).
- **Rest of `pnpm run ci` (exit 0):** typecheck and lint clean; `cpd` 206 clones (one fewer:
  the two async entries share `emitAsyncModuleRun`); vitest 51 files, 688 tests; selfhost matches
  its baseline; `builtins` 242/304; `docs/NODE.md` current; leak plateau; `golden-asan green`.

The card as it stood in plan.md:

### T11.3. `packages/std`: the N1 modules — **[D3]**

Depends on T11.1, T11.2. Zig backings, POSIX first (STD.md §4). Errors throw with a stable
`code` (STD.md §3).

| Module | Functions |
| --- | --- |
| `std/process` (extend) | `argv`, `execPath`, `platform`, `arch`, `ppid`, `hrtimeNs`, `memoryUsage`, `exitCode` |
| `std/fs` (extend) | `open`/`read`/`write`/`close` on fds, `readdir`, `realpath`, `utimes`, `exists`, bytes reads (`unlink`, `rmdir` and UTF-8 text reads landed with T11.2) |
| `std/os` | `platform`, `arch`, `release`, `hostname`, `homedir`, `tmpdir`, `cpuCount`, `totalMemory`, `eol` |
| `std/io` | `stdin`/`stdout`/`stderr` fds, `write`, `read`, `isatty`, `terminalSize` |
| `std/hash` | `sha256`, `sha1`, `md5` over bytes or strings; `randomBytes` |
| `std/encoding` | UTF-8 / latin1 / base64 / base64url / hex ↔ bytes |

**In progress** — Claude Code / opus-5-5. Execution plan, three PRs in this order, each with its
own Check evidence (a golden per module it lands). Steps 1 and 2 land with plan-notes 309:

1. `std/os` + `std/io`. `io` writes flush C stdio first so `console.log` and `io.write` keep
   program order. New §3 codes `EBADF` and `ENOTTY`. Bytes first crossed through a byte channel
   (one FFI call per byte); T11.3a replaced it with the extern table's `Uint8Array` row.
2. `std/encoding` + `std/hash`: encoding is strict TypeScript over `Uint8Array` (no OS edge;
   a string never crosses the C-string boundary, so a NUL survives); hash is Zig's
   `std.crypto` (`Sha256`, `Sha1`, `Md5`) over the `Uint8Array` row (T11.3a), `randomBytes` is
   `std.Io`'s secure random filling a caller-sized view.
3. `std/process` + `std/fs` extensions: `argv` needs `int main(int argc, char **argv)` from the
   emitter and a runtime slot (plan-notes 294); fd calls own a second lifetime (STD.md §9.3).

Each step: `zig/<module>.zig`, `src/<module>.ts`, `src/native/<module>.d.ts`, a Node twin in
`golden/std-oracle/`, a `std_<module>` golden, subset rows in both modes, unit-test ranges for
nondeterministic values, docs/STD.md §3/§5 and docs/SUBSET.md rows.

**Check:** a golden per module against Node's equivalent (nondeterministic results — `hostname`,
`pid`, `randomBytes` — proved by unit-test ranges, as `test:builtins` carves them out).

## Phase 12 — T12.1 bundler API ✅ (2026-10-02)

### T12.1. `packages/compiler`: the bundler API — **[D4]**

Depends on T12.0. Contract: `docs/BUNDLER.md` §5–§7.

**Landed 2026-10-02** (plan-notes 320). The execution plan it was claimed with:

1. `src/api.ts` (`statorc/api` in `package.json` `exports`): the §5 types, `compile` and
   `vendorEntry`. Adapter and bundle results are `unknown` until validated (golden rule 4).
2. `src/frontend/vendor.ts`: collect package imports (bare, not `node:*`, a built-in or `std/*`)
   and CommonJS project files from the loaded program, mangle names, generate the entry.
3. Same module: rewrite each project import of a package into an import of one virtual
   `__stator_vendor__.js` module, line count kept; `createProgram` takes the overlay (the
   rewritten files plus the bundle) and its cache key gains the bundle's sha256 (step 6). The
   module graph resolves edges through the checker, so the virtual module is an edge.
4. `src/cli/bundler.ts`: `--bundler` on `build`/`explain` and the config key; STA0004 in `ts`
   mode, STA0014 when the adapter cannot load, STA0015 when `bundle()` rejects or returns no
   valid bundle. `build` and `explain` share one frontend driver.
5. `src/support/sourcemap.ts`: one wrapper over `node:module` `SourceMap`. Diagnostics in the
   vendor module are mapped after each stage; the lowering maps vendor spans, so `#line` and
   `jsrt_call_at` strings name the original file, or `<package bundle>` with no mapping.
6. Card step 7: the gate raises a new `not-yet` code (STA1218, Phase 11) for a free `__filename` or
   `__dirname`; `program.ts` drops the checker's "cannot find name" for the two names so the
   gate's verdict stands in both modes.

Tests: unit tests over a stub adapter (vendor entry, rebinding, mapping, STA0014/STA0015),
decision tests for STA1218 in both modes, and the `js` goldens under `--bundler=none` and the
default. Docs: `BUNDLER.md`, `MODES.md`, `HOW-IT-WORKS.md`, `DIAGNOSTICS.md`, `CONFIG.md`,
`pipeline.d2`; plan-notes 320, changelog v4.40.

1. **The API.** `statorc/api`: a programmatic `compile` that takes an optional vendor bundle
   (`{ code, map, inputs }`), and the adapter interface
   `BundlerAdapter = { name, bundle(entry: { code, resolveDir }, { external }) → Promise<{ code, map, inputs }> }`.
2. **The vendor entry.** After the program loads, collect the package imports and route the
   CommonJS project files. Generate the vendor entry:
   - named imports become `export { a } from 'p'`;
   - default and namespace imports get mangled names;
   - a name is mangled only on collision.
3. **The vendor module.** Add the bundle as one virtual `js`-mode module and rebind the
   imports to its exports. `export { a as b }`, the form Rolldown emits for renamed exports, is
   lowered already: it landed with §11c T11.5a step 3 (`subset_export_renamed_*`).
4. **The CLI.** `--bundler=vite|none|<module>` on `build` and `explain`:
   - the default in `js` mode is `vite`, loading `vite-stator`;
   - in `ts` mode the flag is `STA0004`;
   - the adapter loads only when step 2 found something;
   - `STA0014` means the adapter cannot be loaded, and its message names the package;
   - `STA0015` means the bundle step failed, with the bundler's message passed through.
5. **Source maps.** Diagnostics, `#line` and runtime call-site strings in the vendor module
   map through the source map (`node:module` `SourceMap`, wrapped once in `src/support/`;
   stability 1.1). A position with no mapping says it sits in a bundler runtime helper, never
   a user file.
6. **The cache.** The program-cache key (Task 6.9) adds the sha256 of the vendor `code`.
7. **`__filename`/`__dirname`.** Without `--node`, a free read of either in a project file
   or in the vendor module is a `not-yet` diagnostic naming T11.5 (BUNDLER.md §4, §9). Inside
   the vendor module it is reported at the mapped position. The code is allocated in
   `docs/DIAGNOSTICS.md` when this lands.

   Today such a read compiles as `dynamic`, and the binary throws `ReferenceError` where Node
   prints the path. No path is ever baked into the binary.

Docs: `HOW-IT-WORKS.md`; `MODES.md`, covering packages, the vendor module and the
package-evaluation-order deviation (BUNDLER.md §1, documented only, no card closes it), the
latter next to top-level-await interleaving in §5; `DIAGNOSTICS.md` (STA0014/STA0015 move from
planned to emitted, plus step 7's code); `pipeline.d2` (a dependency-bundling stage before the frontend in
`js` mode).

**Check:**

- Unit tests drive `compile` and the vendor-entry generator through a stub adapter.
- Every existing `js` golden passes byte-for-byte under `--bundler=none` **and** under the
  default, with Vite not installed. None of them imports a package, so the adapter must not
  load.
- A diagnostic inside a vendored module reports the original file and line. One inside a
  runtime helper says "no source mapping".
- `STA0014` is raised for a package import when the adapter is absent.
- Decision tests: `__filename`/`__dirname` are `not-yet` in a project `.js` without `--node`.

**What landed.**

- `src/frontend/vendor.ts`: package imports and CommonJS project files out of the loaded
  program; the vendor entry with mangled names; the in-place rewrite of each project declaration
  to `./__stator_vendor__.js`, every line kept, type-only names split onto the original module.
- `src/cli/bundler.ts`: the one frontend driver `build`, `explain` and `statorc/api` share. It
  loads the adapter by name only when the vendor plan is not empty, checks every answer
  (golden rule 4), reloads the program over the overlay, and maps diagnostics.
- `src/frontend/program.ts`: `createProgram` takes the overlay; the program cache has two slots
  and keys on the overlay's sha256 as well. `src/frontend/graph.ts` resolves edges through the
  checker, so the virtual module is an edge.
- `src/support/sourcemap.ts`: the wrapper over `node:module` `SourceMap`. The lowering maps
  vendor spans, so `#line`, `jsrt_call_at` strings and STA2001 locations name the package file,
  or `<package bundle>`.
- `--bundler=vite|none|<module>` on both commands and the `bundler` config key (schema
  regenerated). STA0014, STA0015 emitted; STA0004 for `--bundler` in `ts` mode.
- `src/api.ts` (`statorc/api` in `package.json` `exports`): `compile`, `vendorEntry`, the §5 types.
- STA1218 (step 6) for a free `__filename`/`__dirname`, in both modes.
- Decisions this card had to make (CommonJS routing narrowed to files that read `require`,
  `module` or `exports`; `sources` resolved against `resolveDir`; `export *`/`import()` of a
  package left refused): plan-notes 320.

**Check evidence.**

- Unit tests over stub adapters, `packages/tests/unit/bundler.test.ts` (16 tests): the vendor
  entry and mangling, the rewrite, CommonJS routing, `compile` with a stub (C carries
  `#line 3 "<root>/node_modules/leftpad/index.js"`), a vendor diagnostic at
  `node_modules/leftpad/index.js:6:1 STA1214`, a helper diagnostic at `<package bundle>` with
  "(bundler runtime helper, no source mapping)", STA0014 with no `vite-stator` installed and for
  a missing or export-less module, STA0015 for a rejecting adapter and a map-less bundle, an
  adapter that is never called when nothing needs bundling, STA0004, and the cache key.
  `pnpm run test` → `Test Files  52 passed (52)`, `Tests  704 passed (704)`.
- `js` goldens with Vite not installed (`node_modules/vite`, `node_modules/vite-stator` absent):
  `pnpm run test:golden` → `golden: 415 fixtures — 415 passed, 0 failed`;
  `node packages/tests/golden/run.ts --bundler=none` → `golden: 415 fixtures — 415 passed, 0 failed`.
  The default run is the proof that no adapter loads: a fixture that needed one would fail STA0014.
- Decision tests `subset_node_{filename,dirname}_{ts,js}` (not-yet, STA1218):
  `pnpm run test:subset` → `subset: 825 fixtures — 790 passed, 35 expected-fail, 0 failed`.
- Self-compilation: the new code adds 1 × STA1207 (the adapter's `import()` of a computed
  specifier) and 63 × STA1214 to `packages/compiler` (1648 → 1711), recorded with `--update` (plan-notes 306);
  `pnpm run test:selfhost` → `selfhost: 10 targets match the baseline`.
- `pnpm run ci` on the branch rebased onto 10930d1: exit 0 (typecheck, lint, dupes at 205 clones,
  runtime, unit, runtime corpus, subset, golden, selfhost, builtins, node-coverage, leak, ASan).

## Phase 12 — T12.2 `packages/vite-stator` ✅ (2026-10-02)

### T12.2. `packages/vite-stator`: the default integration — **[D3]**

Depends on T12.1. New workspace package, strict TS (§0.10). `vite` is a `peerDependency`
(plan-notes entry: the integration *is* Vite, no few lines replace it). It ships:

- the adapter `stator build --mode=js` uses by default, configured per BUNDLER.md §2:
  - an SSR build with `ssr.noExternal: true` and `ssr.target: 'node'`. Library mode is wrong:
    it stubs `node:*` out;
  - Rolldown output `format: 'es'`, `codeSplitting: false` and `topLevelVar: false`;
  - `minify: false`, `sourcemap: true`, `std/*` external;
  - Vite's `esmExternalRequirePlugin` for built-ins;
  - no `__filename`/`__dirname` transform. They stay free, and T12.1 reports them as
    `not-yet` (BUNDLER.md §9);
- the `stator()` Vite plugin (`vite build` produces the native binary);
- an example under `examples/vite/` with its README.

**Check:**

- New goldens with a `node_modules` package pass through the default adapter, byte-for-byte
  vs Node: named, default and namespace imports, and two packages sharing a dependency (one
  instance).
- `examples/vite` builds a binary with `vite build`.
- Tree-shaking, measured on a package, because project code is already tree-shaken by
  Stator's DCE (BUNDLER.md §1, 93 976 B both ways). Import 1 of 40 functions from a package:
  - the vendor module holds only that function;
  - the binary is within 1% of the same function written in the project.
  The numbers go in plan-notes.

**Landed 2026-10-02** (plan-notes 321). The execution plan it was claimed with:

1. `packages/vite-stator` (workspace package, strict TS): `src/adapter.ts`, the default adapter,
   with §2's configuration as one Vite SSR build of an in-memory vendor entry; `src/plugin.ts`,
   `stator()`; `src/index.ts` (default export = the adapter). `vite` is a peer and a dev
   dependency at the version the lockfile already holds; root `devDependencies` gains
   `vite-stator` so the compiler resolves it. tsconfig, `typecheck`, moon project, TOOLCHAIN.md.
2. Goldens `packages/tests/golden/js/pkg_*` with a committed `node_modules` (`.gitignore`
   exception): named, default and namespace imports, and two packages sharing one dependency.
   `golden/run.ts --bundler=none` skips fixtures that hold a `node_modules`.
3. `examples/vite`: a workspace example whose `vite build` writes a native binary; a unit test
   runs it.
4. Tree-shaking: a 40-function package, one imported; the vendor module and the binary size
   against the same function in the project, in plan-notes.
5. Docs (BUNDLER.md, README, AGENTS.md repo map, TOOLCHAIN.md), plan-notes, changelog, done.md.

**Re-scoped on landing (plan-notes 321).** The namespace import of a package moved to T12.3's
Check: the vendor entry's `export * as p$ns` makes Rolldown emit `__exportAll`
(`Object.defineProperty`, `Symbol.toStringTag`), T12.3's helper item. Vite is pinned at 8.3.1,
not the latest 8.3.2, because 8.3.2 is inside pnpm's `minimumReleaseAge` and would bump vitest's
`vite` (open for the creator).

**What landed.**

- `packages/vite-stator`: `src/adapter.ts` (one `vite.build()` per compile: the vendor entry
  served in memory as `<resolveDir>/__stator_vendor_entry__.js`, `outDir: resolveDir` with
  `write: false` so map sources are relative to `resolveDir`, one chunk or an error),
  `src/plugin.ts` (`stator({ entry, out?, mode? })`: `build.ssr` at the entry with nothing
  written, `compile` in `closeBundle`, the Vite build fails on a failed compile), `src/index.ts`,
  tsconfig, `moon.yml`; root `typecheck` and moon's `tests:ci` include it.
- The adapter passes the external list to `esmExternalRequirePlugin` only, so `require` of a
  built-in becomes an `import` (Rolldown's own `external` pre-empted the plugin; plan-notes 321).
- `examples/vite`: `src/main.js` imports `greeting` (`link:./greeting`); `vite build` writes
  `dist/hello`.
- Goldens `pkg_imports` and `pkg_shared_dependency` with committed `node_modules`;
  `golden/run.ts --bundler=none` skips them and says so.
- Docs: BUNDLER.md (status, "As implemented (T12.2)", the plugin, §8), README, AGENTS.md repo map,
  TOOLCHAIN.md (`vite`, `vite-stator`), ARCHITECTURE.md and `packages.d2`/`.svg` (the package is
  loaded, never imported), `examples/vite/README.md`.

**Check evidence.**

- Goldens through the default adapter, byte-for-byte vs Node: `pkg_imports` (named and default
  imports, a package `exports` map) and `pkg_shared_dependency` (`a1 b2 a3` / `4 4`: one
  `counter` instance). `pnpm run test:golden` → `golden: 433 fixtures — 433 passed, 0 failed`;
  `node packages/tests/golden/run.ts --bundler=none --filter pkg_` →
  `golden: SKIPPED 2 fixtures that import packages (--bundler=none)`.
- `examples/vite` builds a binary with `vite build`: unit test `examples/vite: vite build writes
  a binary that prints what Node prints` (`packages/tests/unit/vite-stator.test.ts`, 4 tests).
- Tree-shaking: 1 of 40 functions imported; the vendor module holds only `function f7` (unit
  test `the adapter tree-shakes`); the binary is 116 880 B through the package and 116 880 B with
  the function in the project, 0% apart (plan-notes 321).
- The Node suite (T11.7): `pnpm run test:node-suite` → `Tests  15 passed | 2 skipped (17)`; the
  15 CommonJS `test-path*` files now stop at `STA0015` (`../common` resolves only through the
  harness's host hook), not `STA0014` (plan-notes 321).
- `pnpm run ci` on the branch rebased onto 9a26b03: exit 0 (typecheck, lint, dupes at 188
  clones, runtime, unit `Test Files  55 passed (55)` / `Tests  721 passed (721)`, runtime
  corpus, subset `879 fixtures — 846 passed, 33 expected-fail, 0 failed`, golden 433/433,
  selfhost `12 targets match the baseline`, builtins, node-coverage, leak, ASan golden 433/433).

## Phase 11 — T11.5 `--node` and CommonJS ✅ (2026-10-02)

### T11.5. `packages/compiler`: the `--node` flag and CommonJS — **[D4]**

Depends on T11.2. **Re-scoped by T12.0** (question 4, plan-notes 296; `docs/BUNDLER.md` §4):
the bundler converts CommonJS. Rolldown wraps each module as a function over
`(exports, module)`, and it already turns static `require` into graph edges, decides `"type"`
and gives CJS cycles Node's partial `exports`. Stator writes none of that. A CommonJS project
file (Node's rule: `.cjs`, `"type": "commonjs"`, or `.js` without ES-module syntax) is routed
to the bundler by T12.1, under `--node` only (decided 2026-10-02, plan-notes 315).

**Landed 2026-10-02** (plan-notes 312, 315, 316), in three changes: the steps that do not need
the bundler (312); `--node` gating CommonJS routing of project files (315); and the run-time
steps (316): `node:module` with a `require` over built-ins, `import.meta` under `--node`, and the
vendor module's `__filename`/`__dirname` injected relative to the executable. `STA1218` is
retired; every free CommonJS binding that reaches the gate is `STA1110`.

Steps:

- ~~**The flag.**~~ Landed (plan-notes 312): `--node` on `build` and `explain`, the config key
  `node`. An unlanded `node:*` module or member is `STA1214` naming Phase 11 (T11.6). A Node
  global member under `--node` joins this when `packages/node` declares its globals (T11.6).
- ~~**The Node globals' location.**~~ Decided (plan-notes 312, `docs/MODES.md` §6): relative to
  the executable, resolved at run time, never `import.meta.url`. Landed (plan-notes 316): the vendor
  module's values are injected; `STA1218` is retired.
- **Resolution.** ~~ESM imports in project files~~ landed (plan-notes 312): `node:*` and bare
  built-ins resolve to `packages/node` through `paths` entries. Landed (plan-notes 316): `node:module` and every landed built-in have a default export. The
  vendor bundle reaches them as `import * as m from "path"` plus `m.default`
  (`esmExternalRequirePlugin`), so built-ins need a default export (T11.6 provides it).
- ~~**`require` at run time.**~~ Landed (plan-notes 316). `import.meta.url` + `node:module.createRequire`
  give a `require` over built-ins only. It serves Rolldown's `__require` for computed
  `require(expr)`, and anything that is not a built-in throws Node's `MODULE_NOT_FOUND`. A
  computed require of a bundled file cannot resolve: Node itself fails on the bundle, as
  measured in T12.0.
- ~~**`STA1110`** narrows to "without `--node`".~~ Landed (plan-notes 312): it stays in `ts` mode
  with or without the flag, and in `js` mode without it. No new code.
- ~~**`--node` gates CommonJS routing.**~~ Landed (plan-notes 315): `planVendor` routes a CommonJS
  project file only under the flag, and the gate answers a free `module.exports` or `exports`
  with `STA1110` (it used to reach the lowering as `STA4035`).

Docs: `MODES.md` (platform section), `SUBSET.md`, `DIAGNOSTICS.md`, `HOW-IT-WORKS.md`,
`CONFIG.md` — updated for the landed steps.

**Check:** decision tests for `require` in all four mode × platform cells — **passing**
(`subset_commonjs_require_*`); for a CommonJS project file in all four — **passing**
(`subset_commonjs_file_ts` / `_node_ts` / `_js`, and the `js` + `--node` cell, which needs an
adapter, in `unit/bundler.test.ts`). Goldens, byte-for-byte vs Node: `createRequire` of a built-in, a
computed `require` hit (a built-in) and miss (`MODULE_NOT_FOUND`) — landed (plan-notes 316). The CJS
cycle and `module.exports` replacement goldens moved to T12.3.

**Check — PASSED** (2026-10-02, on main 9a26b03):

- Decision tests for `require` in all four mode × platform cells (`subset_commonjs_require_*`,
  all `STA1110`), for a CommonJS project file in all four (`subset_commonjs_file_*`, the `js` +
  `--node` cell in `unit/bundler.test.ts`), and for `__filename`/`__dirname` and `import.meta`
  (`subset_node_filename_*`, `subset_node_dirname_*`, `subset_node_import_meta_*`):
  `pnpm run test:subset` → `subset: 887 fixtures — 854 passed, 33 expected-fail, 0 failed`.
- Goldens byte-for-byte vs Node: `createRequire` of a built-in, a computed `require` hit (a
  built-in) and miss (`MODULE_NOT_FOUND`), in `ts/node_module.ts` and `js/node_module.js`:
  `pnpm run test:golden` → `golden: 433 fixtures — 433 passed, 0 failed`.
- The vendor module's injected `__filename`/`__dirname`, with a ready bundle in Rolldown's shape
  (`unit/bundler.test.ts`), and the `landed` table (`unit/node-module.test.ts`):
  `pnpm run test` → `Tests  720 passed (720)`.
- `pnpm run ci` → exit 0 (typecheck, lint, dupes at 188 clones, runtime, unit, runtime corpus,
  subset, golden, selfhost at 13 targets, builtins, node-coverage, leak, ASan).

Left to other cards: `esmExternalRequirePlugin` in `vite-stator` (T12.2) and the CommonJS goldens
through the default adapter (T12.3). The CJS cycle and `module.exports` replacement goldens moved
to T12.3 earlier.

### T15. Required root docs

`todo.md`, `roadmap.md`, `ideas.md` and `toolchain.md` exist at the repo root and are filled from `plan.md`, the manifests and `docs/TOOLCHAIN.md` (plan-notes 359). `todo.md` lists the open audit rows. `roadmap.md` points at the open phases already in `plan.md` and holds nothing that is waiting to be scheduled. `ideas.md` is the unapproved inbox and is empty. `toolchain.md` lists the mise and npm pins; `docs/TOOLCHAIN.md` and `docs/BUNDLER.md` were brought up to those pins in the same change (typebox 1.3.36, `@types/node` 26.6.3, oxlint 1.86.0, oxlint-tsgolint 7.0.2003, oxfmt 0.71.0, cpd 5.4.0, vite 8.3.3, astro `^7.3.5`). `toolchain.md` records that `memfs` is not a dependency: it left the manifests in plan-notes 353. `todo-js` and `todo-ts` are not in the tree, so there was nothing to leave in place.

Package audit: a package is covered when its directory name already appears in `packages/tests`. No new test was added.

Check:

```
test -f todo.md -a -f roadmap.md -a -f ideas.md -a -f toolchain.md
for p in compiler runtime std node tests vite-stator; do
  rg -l --glob '!**/node_modules/**' "packages/$p" packages/tests >/dev/null && echo "$p covered"
done
```

Observed 2026-10-15: all four files exist, and each package printed `covered` (`compiler` in `packages/tests/golden/asan-gate.ts` and `selfhost/targets.json`; `runtime` and `std` in the same two; `node` in `selfhost/targets.json` and `unit/node-platform.test.ts`; `tests` in the harness paths; `vite-stator` in `unit/vite-stator.test.ts` and `selfhost/targets.json`).

### T16. Compare-only shape keys are freed; stores still intern

`jsrt_shape_key` interned every UTF-8 conversion. A second lookup of the same bytes was freed (plan-notes 353), but a miss never stores the pointer, so each distinct computed read, `in`, `delete`, `Object.hasOwn`, array-index check, print/`JSON.stringify` get, and error-message rendering kept `3·len+1` bytes plus an intern node for the life of the process. A named-group `exec` malloc'd the group name and passed it to `jsrt_set_prop`; the second match reused the existing transition and leaked that malloc. Reproduced before the call-site change: `print_shapes` reported `compare-only key lookup interned 32 keys`.

Compare-only sites now go through `jsrt_shape_key_ephemeral` (`jsrt_get_prop_value` / `jsrt_has_prop_value` free it). Stores (`jsrt_set_prop`, `JSON.parse` keys, `console.count` labels) still intern. Named-group names go through `jsrt_shape_intern`. The leak harness covers 2M distinct computed-key reads (`packages/tests/leak/keys.js`, `--mode=js`).

Check: `just -f packages/runtime/justfile -d packages/runtime runtime-test` — `runtime: print corpus matches Node` (32 misses leave `jsrt_shape_intern_count` unchanged; one stored key adds one; two named-group execs in `print_regexp` add the two names and nothing on the second exec). `pnpm run test:leak` — `leak: 2M computed-key reads — peak RSS 2956 KB of a 65536 KB cap, 114 samples, plateau` (the 10M object and FFI rows still plateau).

### T17. `"".repeat` with a huge count no longer hangs or runs an undefined cast

`packages/runtime/src/jsrt_string_ops.c` `jsrt_string_repeat` checked only `count * str->length > JSRT_MAX_STRING_LENGTH`: an empty receiver makes that product zero for any count, so `"".repeat(4294967295)` fell into a 4294967295-iteration loop over zero bytes (Node answers `""` instantly) and a count past UINT32_MAX reached `(uint32_t)count`, undefined by C11 §6.3.1.4. Found by the 2026-10-07 audit (task T17 of the audit set; the plan-table rows ride the in-flight plan restructure). Fix: an empty receiver returns itself before anything else, and a count past UINT32_MAX throws the spec's `Invalid string length` before the cast — keeping the length cap's coverage of the cast true by construction.
Model: ZCode / GLM-5.3 · Status: done 2026-10-07 · Priority: P1 · Complexity: 1 · Files: `packages/runtime/src/jsrt_string_ops.c`, `packages/tests/golden/{js,ts}/string_range_error.ts`
Check: `moon run tests:golden -- --filter string_range_error` — both fixtures' full outputs match Node, including the new `"".repeat(4294967295)` and `"".repeat(2**53)` cases (the full golden pass: 463/463).

### T18. GC rooting hazards: boxed values stay in frame slots across allocating calls

`jsrt_compare` copied both primitives out of its frame and popped before `jsrt_string_compare` / `jsrt_to_number`. `sort_compare` left the right-hand `ToString` (and both operands of a user comparator) in C locals, and `sort_merge` read array elements around that allocating call. `jsrt_array_sort` kept the scratch array — the block a merge writes into — in an unrooted local. `jsrt_promise_settle` passed the outer and inner promises into `enqueue`, which `jsrt_gc_alloc`s the microtask before storing them. `jsrt_loose_equals` passed the `ToPrimitive` result into the recursive call from a C local. A NaN-boxed word is not a Boehm root (plan-notes 108). Each of those values is now a `JSRT_FRAME` slot for the whole allocating call, the same way `jsrt_op_add` already parks its primitives. `jsrt_gc_stress` collects before every `jsrt_gc_alloc` so a test can hit the window without waiting on heap size.

Check: `just -f packages/runtime/justfile -d packages/runtime runtime-test` — print corpus matches Node, then `packages/runtime/tests/roots.c` prints `roots ok` (compare, loose equality, default sort, user sort, promise adoption whose inner-promise finalizer stays quiet), under `jsrt_gc_stress`. Observed 2026-10-09: that command printed `roots ok` then `runtime: print corpus matches Node`.

### T19. Small runtime fixes: RegExp NULL-capture and `replace_impl` double scan

`jsrt_regexp_test` passed `capture_buffer`'s NULL (bytecode whose header claims no captures and no registers) straight into `exec_at`, and `lre_exec` writes `capture[i]` before it reads the subject. `jsrt_regexp_search` already treated that NULL as a miss. The refusal now lives in `exec_at`, so `test`, `search` and `scan` share it; `search` no longer keeps a second copy of the check.

`replace_impl` called `index_of_from` in the counting loop's condition and again for the same hit, then the length pass and the emit pass each searched from the start again (the three sites at the old `jsrt_string_ops.c` lines 507–508, 523 and 537). One scan records the positions — plain `uint32_t`s, malloc'd, freed before the result is boxed — and both later passes read that list. An empty pattern still advances by one and still measures the match as zero units.

Model: Cursor / grok 4.7 · Status: done 2026-10-15 · Priority: P3 · Complexity: 1 · Files: `packages/runtime/src/jsrt_regexp.c`, `packages/runtime/src/jsrt_string_ops.c`

Check: `just -f packages/runtime/justfile -d packages/runtime runtime-test` — `roots ok` then `runtime: print corpus matches Node` (plain malloc, no LTO). `node packages/tests/golden/run.ts --filter string_builtins` — `golden: 2 fixtures — 2 passed, 0 failed`. The same runner with `--filter primitive_methods` and `--filter regexp_strings` — 2 passed each. Observed 2026-10-15.

### T23. Builtin-constructor comparison follows the startup snapshot

`unit/to-primitive.test.ts` compared `BUILTIN_CONSTRUCTOR_NAMES` with the host `util.format` set and skipped `win32`/`arm64`, so main's `frontend (windows/arm64)` was green while any branch without the skip failed (PR #61, PR #114). The official win-arm64 Node 26.7.0 is cross-compiled from win-x64, so `node_use_node_snapshot` is false and `inspect.js` records seven later globals. The runtime list stays the snapshot set. The test now branches on that flag and fails unless a no-snapshot build differs by exactly those seven names (plan-notes 354).
