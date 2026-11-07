# T14.1 done

**What was done.** `packages/interpreter/` (Zig 0.17.0) is the interpreter's parser front:

- `src/parse.zig`: `parse` (the Script goal for `eval`, or a module) and `parseFunction`
  (CreateDynamicFunction's source text, parsed once, checked so that each piece stays where the
  text put it). The result is the tree or the first early error.
- `src/capi.zig`: `jsrt_interp_parse_script`, which leaves a `SyntaxError` pending through
  `jsrt_throw_error`. `zig build lib` builds `libjsrt_interp.a`.
- `test262/parse.zig`: Test262's `test/language/` through `parse`, ratcheted per directory in
  `test262-parse.json` (`pnpm run test262:interp-parse`; `pnpm run interp:test` for the unit tests).

stator-ts is imported as it stands: its `lib.zig` does not export the parser, so the package roots
a module of its own at `parser.zig`. `packages/transpiler` is unchanged. The gaps the driver found
are stator-ts's, and plan-notes 401 lists them for its owners: 3,444 early errors not reported, and
1,120 valid tests rejected (779 escaped or non-ASCII identifiers, 232 proposal syntax, 75
top-level `await` without a goal flag, 34 others). They are not fixed in this change.

**Check.**

- The rate at the pin `771005236e88`: 19,162 of 23,726 tests pass (80.76%), over 40,694 parses.
- Parse speed: 188–194 MiB/s `ReleaseFast` on an Apple M3 Max.
- `libjsrt_interp.a`: 3,152,688 B `ReleaseFast` (562,888 B stripped), 323,280 B `ReleaseSmall`.

All of these are recorded in plan-notes 401. The ratchet fails on a lowered count: with `asi` set
one above its real pass count it answers `asi: 101 pass, the baseline has 102` and exits 1.
`zig build test` passes and `zig fmt --check` is clean.
