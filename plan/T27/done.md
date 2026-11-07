# T27. Done

**What landed** (plan-notes 399, `docs/VALUE.md` §4.26, `docs/SUBSET.md`):

- A class with one evaluation is a file-scope class object: it can be passed, stored, returned,
  compared (`C === D`) and printed (`[class D extends C]`, as in Node).
- `new k()` and `x instanceof k` go through the value, so a `typeof C` that holds a subclass
  builds and tests the subclass.
- `k.name`, `k.length` and primitive statics read through a value use the statics table, with a
  boundary check.
- `this` in a static method erases to the class's own statics when nothing extends the class.
  Otherwise it is a hidden receiver: every call site passes the class object it reached the
  method through, using `jsrt_call_with_this` (`CallExpr.withReceiver`, plan-notes 395).
- Two older static-write bugs are fixed:
  - `Sub.count = 5` on an inherited static used to write the base's binding. It is now refused,
    `not-yet(STA1214)`, and the js path raises `STA2004`.
  - The comment on the runtime's `class_static_find` was wrong and has been corrected.

**Still refused, with their own messages** (the card's narrow-slice clause):

- `C.prototype` stays `not-yet(STA1214)`, Phase 8.
- A class that can be evaluated more than once, and a generic class.
- A static method taken as a value.
- A static accessor that reads `this` and that a subclass can reach.
- Non-primitive statics read through a value.
- An unrelated class where a `typeof C` is expected.

**Check:**

- `stator explain` on `const K = C; K.name` reports `static` and no `STA1214`.
- The goldens `class_object_value`, `class_object_name` and `static_this_method` match the
  pinned Node in both modes.
- `pnpm run test:subset` shows the class-value rows out of expected-fail.
- `pnpm run ci` exits 0. The output is cited in the PR.

**Not done here:** the `packages/compiler-zig` mirror (T41). `test:zigdiff` is not part of `ci`.

PR: PR_PLACEHOLDER
