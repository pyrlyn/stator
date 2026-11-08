# T28. Done

Steps 1 to 3 landed in plan-notes 386:
- `docs/HIR.md` §7 states the specialization-key rule. A block-homed `const`, or a `let`/`var` whose only write is the initializer, keys on `name@file#offset`. A module-scope binding keeps its plain name.
- The block-homed slice is `static` (`subset_generic_block_const_*`).
- Step 3 took the refusal option. A per-tuple descriptor at the comparison site was tried and reverted (STA4054/STA4048 under a generic subclass; plan-notes 386).

This change adds the goldens step 4 asks for:
- `packages/tests/golden/ts/generics_block_homed.ts`.
- `packages/tests/golden/js/generics_block_homed/` (`main.ts` plus an untyped `lib.js`), the js-mode fixture. A `.js` file cannot spell a type parameter, so the js-mode generic is a `.ts` file mixed with untyped JavaScript. Its arguments reach the homes as Unknown.

Together they cover:
- Two block `const` homes under one name, at `number` and `string`, and one called at several types.
- A module `let` with a single write, also passed to an untyped higher-order function.
- A `const` inside an `if` block and inside a `for-of` body.

## Check

- Unnamed refusals: none. Each remaining shape names its blocker in `gate.ts`:
  - A homeless arrow: "a generic function expression or arrow outside a `const` (or single-assignment `let`) binding has no specialization home: …".
  - Self-application: "a generic call at a generic type is not yet supported: self-application infers a generic tuple that no monomorphic copy can spell".
  - `instanceof`: "instanceof against a generic class is not yet supported: one descriptor per tuple, and the bare name identifies no descriptor to compare against".
- Goldens: `pnpm run test:golden` gives `golden: 520 fixtures — 520 passed, 0 failed`.
- Subset: `pnpm run test:subset` gives `subset: 1039 fixtures — 1008 passed, 31 expected-fail, 0 failed`.
- `docs/HIR.md` §7 states the keying rule (table row "Block-homed `const` … `name@file#offset`").
- `pnpm run ci` passes, every step from typecheck through `test:asan` (exit 0). Lint was run as `oxlint --deny-warnings .` plus `oxfmt --check` over tracked files, because a local untracked harness file (`.claude/settings.local.json`) fails the glob.
