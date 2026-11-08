---
status: in progress
priority: P2
complexity: 4
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T28. Generics residue: homeless arrows, self-application, `instanceof` a generic class

Phase 5 step 12(f) residue. Module-scope `const f = <T>(x: T) => x` already specializes
(plan-notes 280/379). Still refused with named `STA1214`s: an arrow in `let` / a branch / a
spread / a constructor argument (no single parameter type); a generic that is returned or
stored (dynamic tier); a generic call at a generic type; `instanceof` against a generic class
(one descriptor per tuple).

**Landed 2026-10-24 (plan-notes 386).** `docs/HIR.md` §7 states the specialization-key rule
(position key `name@file#offset` for block-homed `const` / single-assignment `let`; module-scope
keeps the plain name). Block-homed slice is `static` (`subset_generic_block_const_*`; nesting
and single-assignment-let fixtures flipped). Every remaining shape's message names its blocker.
**Remainder (this card keeps its number and title):** `instanceof` against a generic class —
the comparison-site tuple slice was tried and reverted (STA4054/STA4048 under a generic
subclass; plan-notes 386); branch / spread / ctor-argument homeless arrows stay refused with
their named blockers; goldens for the landed slice not added (subset decision tests cover it).
**Check is met for the landed subset and the named refusals.**

Steps:
1. Write the specialization-key rule for a **block-homed** generic (block `const`/`let` with
   exactly one assignment) in `docs/HIR.md` — what the key is when no parameter type exists
   (the variable's declared/inferred generic signature, or a canonical tuple). If that rule
   cannot be sound, keep the refusal and say so in the doc rather than in code comments.
2. Land the block-`const`/single-assignment-`let` slice under that rule (or confirm the refusal
   and skip to 3).
3. `instanceof` against a generic class: specialize the descriptor per tuple at the comparison
   site, or refuse with a code that names the one-descriptor-per-tuple blocker.
4. Decision tests both modes; goldens where landed; every remaining shape's message names its
   blocker (never a bare "not yet supported").

**Check:** `gate.ts` emits no unnamed `STA1214` for the shapes in this card's list; goldens for
any landed slice match Node byte-for-byte; `docs/HIR.md` §on generics states the keying rule.

## Execution plan

Steps 1 to 3 landed with plan-notes 386. Step 3 is the refusal option: specializing per tuple was
tried and reverted. What is left is step 4's goldens.

1. Add golden `generics_block_homed`: `ts/generics_block_homed.ts`, plus a js-mode twin as a
   folder fixture `js/generics_block_homed/main.ts`. It covers:
   - two block-homed `const`s with the same name at different types;
   - one block `const` called at two types;
   - a single-assignment module `let` called directly and passed;
   - a `const` homed in an `if` block.
2. Confirm every refused shape's message names its blocker:
   - homeless branch, spread and ctor-argument arrows (`explain`);
   - `instanceof` against a generic class;
   - self-application and a generic as a value (`gate.ts`).
3. Run `pnpm run ci`, then write `done.md`.
