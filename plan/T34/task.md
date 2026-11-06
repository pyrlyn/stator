---
status: todo
priority: P2
complexity: 3
readiness: 100%
agent:
---

# T34. `Function.prototype.bind` and the two-slot environment

Step 12(e) residue: method values use `has_receiver` (drop the receiver); `bind` *inserts* one
and needs the two-slot `JSRTEnv` `docs/VALUE.md` §4.16 reserved.

Steps:
1. Runtime: `JSRTBound` / env layout with inserted receiver + partial args; `jsrt_call` handles
   the shift (documented beside `has_receiver`).
2. `bind` as a builtin method; `length`/`name` of a bound function per spec (or a named
   not-yet if v0 skips them — decide in `docs/SUBSET.md`).
3. Goldens `bind_receiver`, `bind_partial_args`, `bind_new` (`new` on a bound function) both
   modes; decision tests.

**Check:** goldens match Node; `subset_bind_*` rows leave `expected-fail`; no regression in the
existing `has_receiver` method-value goldens.
