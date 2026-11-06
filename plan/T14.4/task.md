---
status: todo
priority: P2
complexity: 4
readiness: 0%
agent:
---

# T14.4. Async, generators, and the remaining constructs

Depends on T14.3. Interpreted `async`/`await`, generators and async iteration on the runtime's
`JSRTAsync` and generator machinery (`docs/INTERPRETER.md` §5), plus the `STA12xx` codes §6
assigns to the interpreter: `STA1201`'s residue, `STA1202`, and `STA1214`'s `js`-mode constructs,
through function-level interpretation.

**Check:** the Test262 slice for these features passes at a recorded rate. Each code taken over
flips its decision tests in the same commit, and `explain` no longer lists it for those
constructs.
