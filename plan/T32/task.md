---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent:
---

# T32. Abstract accessors and the virtual-accessor rule

Step 12(d) residue (`gate.ts` override arm). Accessors already work as get/set method pairs
(plan-notes 373 landed the static and compound slices); an `abstract get`/`set` override and
an accessor override that must dispatch virtually through a base-typed receiver are still
refused.

Steps:
1. Finish the virtual rule from plan-notes 373's landed pair-whole override: a base-typed
   `o.x` on a receiver whose class overrides the accessor must call the override.
2. `abstract` accessors: throw-stub pattern from plan-notes 275 (already used for abstract
   members) applied to the get/set pair; subclass supplies the implementation.
3. Goldens `abstract_accessor`, `accessor_override_virtual` both modes; subset rows flip.

**Check:** goldens match Node; `pnpm run test:subset` has no `expected-fail` row for abstract
or overridden accessors; the `statics`/`class-members` unit suites stay green.
