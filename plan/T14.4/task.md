---
status: todo
priority: P2
complexity: 4
readiness: 0%
agent:
---

# T14.4. Async, generators, and the remaining constructs

Depends on T14.3. Interpreted `async`/`await`, generators and async iteration on the shared
promise machinery (T14.0 §5), plus every other `STA12xx` code T14.0 §6 assigned to the interpreter.

**Check:** the Test262 slice for these features passes at a recorded rate. Each code taken over
flips its decision tests in the same commit, and `explain` no longer lists it for those
constructs.
