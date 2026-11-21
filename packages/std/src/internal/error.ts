// The one shape every `std` failure takes (docs/STD.md §3): an `Error` whose message is
// `<module>.<function>(<argument>): <CODE>`, the code read back from the backing that failed.
//
// The code rides the message, not a `code` property, until Stator compiles a class that extends
// `Error` (today STA1214, Phase 5): the grammar is fixed so a caller can recover it — the text
// after the last `: ` — and the property arrives without changing a single message.
//
// Not importable as `std/internal/error`: only top-level files under `src/` are std modules.
// Names here start with `__std` because whole-program v0 merges every file's top level into one
// namespace (plan.md §5 Task 3.11): a helper's name must not take one a user program could want.

import { jsrtStdLastError } from '../native/core.js';

/** The error for `call` failing on `argument` with `code`, in the one grammar above. */
export function __stdError(call: string, argument: string, code: string): Error {
  return new Error(`${call}(${argument}): ${code}`);
}

/** The error for a backing that answered failure, with the code it recorded. */
export function __stdFailure(call: string, argument: string): Error {
  return __stdError(call, argument, jsrtStdLastError());
}

/** A string argument as the message spells it. */
export function __stdQuote(text: string): string {
  return `'${text}'`;
}
