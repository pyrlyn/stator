# Ideas

Not approved. Nothing here moves into `roadmap.md`, `plan.md` or `plan/` without the creator.

No unapproved ideas for the `plan.md` work are written down yet (re-checked 2026-10-24). `NICHE.md`, `README.md`,
and `docs/` do not hold a separate idea list. Approved work is already in `plan.md`, including
the T27–T34 cards promoted from the former roadmap residue pointers. Refusals already recorded
there stay recorded: the non-goals in §0, and the cloud review's note that exposing `ffi-gen`
as a `stator ffi-gen` subcommand stays in-tree and is not scheduled.

## Stator Transpiler (`packages/transpiler`)

- Native backend.
- Report TS5056 when `foo.ts` and `foo.tsx` map to one output file.
- Find out why evaluating conditional types over mapped types that mention only `this` breaks `this is` narrowing on VS Code; `isGeneric` still treats them as generic for that reason.
- Build members of instantiated generics on demand. tsrs instantiates 1,287,137 of 8,810,354 declared members on VS Code. Diagnostics must stay the same at every `-j`.
- Follow TypeScript 7.1: it reports 11 more errors on VS Code, all around `IConfigurationResolverService`, where a distributed `T` no longer relates to a non-distributed one.
- Close the tsc gaps left after T55. Missed: TS2448 for a destructuring default that reads itself, TS2729, TS2372, TS2373, TS7057, TS1202, TS1344, TS2664, TS2666, TS2667, TS2303 for `export { local }` in a namespace, TS2300 for `import { c }` next to `export { c }` in a body, and TS1473 and TS1474 in checked JavaScript. tsc's "did you mean to call this" elaboration is missing too, so `run(() => f)` gets TS2322 inside the arrow where tsc gives TS2345 on it. TS7032 is missing, for a set accessor with no type and no getter. TS7022 through flow analysis stays silent: `let t; while (true) { const u = t; t = u; if (!t) break; }`. Without `noImplicitThis` `this` in an object literal method should be `any`, and Stator Transpiler gives TS2339 for a property the literal lacks. `import y = require("./b")` next to `import("./b")` in a namespace gets no TS2307, since tsc keys resolution by mode.
- Print aliases, index parameter names and method members as tsc does, so message text matches and not just the code.
- Find out why one checker per file prints `Type '{}'` where a normal run prints `Type 'PermissionRequestHandler'` in a TS2344 on VS Code: the file, line and code match, the text depends on the run.
- Close the tsc gaps found while writing T56's fixture: `take(pick("a", over(false)))` misses TS2345 on the outer call, and a statement call with a failing overload narrows by the last overload where tsc does not.

## Engine (`packages/engine`)

Found while writing T73's cases, each against the pinned Node (2026-11-16):

- A plain object does not answer `Object.prototype`'s methods on a property read: `typeof ({ a: 1 }).toString` is `undefined`.
- A write to a frozen object in sloppy code throws a TypeError; it is ignored there and throws only in strict code.
- A method taken off an array stays bound to that array: `const push = a.push; push.call(b, 5)` grows `a`.
- There is no `Float64Array` (`typeof Float64Array` is `undefined`), nor any other typed array.
- `length` asked of an array by a computed key answers `undefined`: `xs['length']`, and `xs[k]` with `k = 'length'`.
- A hole in an array does not consult `Array.prototype`: with `Array.prototype[1] = 'proto'`, `[0, , 2][1]` is `undefined`.
- `typeof ({ a: 1 }).__proto__` is `undefined`, and `typeof Object.create(null).constructor` is `function`.
- The JIT leaves a whole function to the interpreter for one opcode it has no form for. A template literal (`to_string`), a computed string key (`to_key`) and an array literal with elements (`array_push`) are the common ones: of the engine corpus's functions, `STATOR_JIT_TRACE=1` shows about one in four rejected for them. A generic form that calls the VM's own function, as every other operation has, would compile the rest of such a function.
