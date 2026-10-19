// Task 6.15: tracked JavaScript is only the exempt list in plan.md §0.10.
// Runs from the workspace root (`pnpm run lint`, and therefore `pnpm run ci`).
import { execFileSync } from 'node:child_process';

/** Our re-vendor tools live under `vendor/` but they are not upstream. A JavaScript
 * spelling of either name is this task regressing. */
const VENDOR_OURS = new Set([
  'packages/runtime/vendor/update.js',
  'packages/runtime/vendor/update.mjs',
  'packages/runtime/vendor/update.cjs',
  'packages/runtime/vendor/fdlibm/port.js',
  'packages/runtime/vendor/fdlibm/port.mjs',
  'packages/runtime/vendor/fdlibm/port.cjs',
]);

function exempt(path: string): boolean {
  if (path.startsWith('site/public/')) return true;
  if (path.startsWith('packages/runtime/vendor/')) return !VENDOR_OURS.has(path);
  // js-mode inputs and examples: the thing under test, not a tool we run.
  if (path.startsWith('packages/tests/golden/js/')) return true;
  if (path.startsWith('packages/tests/subset/')) return true;
  if (path.startsWith('packages/tests/differential/')) return true;
  if (path.startsWith('packages/tests/bench/')) return true;
  if (path === 'packages/tests/leak/keys.js') return true;
  // Concatenated into every harnessed Test262 program. The host adapter is source
  // text the corpus executes; Node never type-strips it.
  if (path === 'packages/tests/test262/harness/done.js') return true;
  if (
    path.startsWith('examples/') &&
    !path.endsWith('/node_shim.js') &&
    !path.endsWith('/node_shim.mjs') &&
    !path.endsWith('/node_shim.cjs')
  ) {
    return true;
  }
  return false;
}

const listed = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], { encoding: 'utf8' });
const paths = listed.split('\n').filter((line) => line !== '');
const offenders = paths.filter((path) => !exempt(path));
if (offenders.length > 0) {
  process.stderr.write(
    `stator: tracked JavaScript outside the Task 6.15 exempt list:\n${offenders
      .map((path) => `  ${path}\n`)
      .join('')}`,
  );
  process.exit(1);
}
process.stdout.write(
  `stator: tracked JavaScript is only the exempt list (${String(paths.length)} files)\n`,
);
