# quickjs-ng — libregexp

The regular-expression engine, vendored rather than written: plan.md golden rule 5 ("don't write a
regex engine — vendor QuickJS-NG's libregexp"). It is small, proven by Test262, and designed for
embedding — it names the three functions the embedder must supply and asks nothing else of its host.

| | |
|---|---|
| Upstream | <https://github.com/quickjs-ng/quickjs> |
| Version | `v0.16.2` |
| Commit | `1ab8676f4b6d6d669baeb5f21790fb9734636a20` |
| License | MIT (see `LICENSE`; Fabrice Bellard, Charlie Gordon, Ben Noordhuis) |
| Vendored | 2026-08-30 |

## What is here, and what is not

| File | Why |
|---|---|
| `libregexp.c` `libregexp.h` `libregexp-opcode.h` | The engine: `lre_compile` produces bytecode, `lre_exec` runs it. |
| `libunicode.c` `libunicode.h` `libunicode-table.h` | Case folding and the Unicode property tables `libregexp` indexes for `\p{…}`, `i` and `u`. |
| `cutils.h` | Header-only in this release (there is no `cutils.c`): the dynamic buffer and bit helpers both of the above use. |
| `LICENSE` | Upstream's, unmodified. |

Deliberately NOT vendored: `quickjs.c` and everything else in the upstream tree. Stator has its own
value representation, its own strings and its own allocator; `libregexp` is the one piece it wants,
and the embedding API is exactly the seam that makes taking only that piece possible.

## The three functions the embedder owes it

Declared at the bottom of `libregexp.h`, defined by us in `runtime/src/jsrt_regexp.c`:
`lre_realloc`, `lre_check_stack_overflow` and `lre_check_timeout`.

## Rules

**Never hand-edit these files** (AGENTS.md, Don'ts). A patch that turns out to be necessary is a
`plan-notes.md` entry first, applied as a recorded diff against the pinned commit — so that the next
version bump is a re-vendor plus a re-apply, and never a silent divergence. The re-vendor is
`node packages/runtime/vendor/update.ts quickjs-ng [ref]` (`pnpm run vendor:update`).

They are also the one exception to the runtime's `-Wall -Wextra -Werror`: the justfile compiles
`vendor/` with `-Wall` alone, because holding code we may not edit to our own warning policy would
force exactly the edits the rule above forbids (plan-notes 101). The bridge in `runtime/src/` is
ours, and is held to the full flags like everything else there.
