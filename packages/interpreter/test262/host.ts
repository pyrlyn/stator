// The Test262 host (docs/INTERPRETER.md §8): compiled `--mode=js --node`, so the test runs in the
// interpreter through an indirect `eval` and the harness's `$262` and `print` are compiled code.
// `test262/exec.zig` composes the script and runs this once per test and mode:
//
//   test262-host <script> [<negative type>]
//
// Exit 0 when the script completes, or throws the error its negative metadata names; 1 when it
// fails; 3 when it reaches a construct the interpreter does not run yet, printed after
// `UNSUPPORTED ` so the driver can count it by construct.
import { readFileSync } from 'node:fs';

const unsupported = 'not supported by the interpreter yet: ';
const [, , path = '', expected = ''] = process.argv;
// oxlint-disable-next-line no-eval -- this host exists to hand Test262 scripts to the interpreter, whose entry is indirect `eval`.
const indirect = eval;
// The interpreter's global object, which the harness and the test see as theirs.
const global = indirect('globalThis');
global.print = (value: unknown) => {
  console.log(String(value));
};
global.$262 = {
  global,
  evalScript: (source: unknown) => indirect(String(source)),
  gc: () => undefined,
};

/** The thrown value's constructor name, or '' when it has none (a primitive). */
function errorName(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  if ('constructor' in e && typeof e.constructor === 'function') return e.constructor.name;
  // The runtime's own errors do not answer `in` for their inherited `constructor` yet.
  return 'name' in e && typeof e.name === 'string' ? e.name : '';
}

function message(e: unknown): string {
  if (typeof e !== 'object' || e === null || !('message' in e)) return '';
  return typeof e.message === 'string' ? e.message : '';
}

try {
  indirect(readFileSync(path, 'utf8'));
} catch (e) {
  const text = message(e);
  if (errorName(e) === 'Error' && text.startsWith(unsupported)) {
    console.log(`UNSUPPORTED ${text.slice(unsupported.length)}`);
    process.exit(3);
  }
  if (expected !== '' && errorName(e) === expected) process.exit(0);
  console.log(`threw ${errorName(e)}: ${text}`);
  process.exit(1);
}
if (expected !== '') {
  console.log(`completed, expected a ${expected}`);
  process.exit(1);
}
