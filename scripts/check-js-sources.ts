// Task 6.15: tracked JavaScript may only be the exempt set in plan.md §0.10.
// Dependency-free, like check-node.ts — `pnpm run ci` runs this before install.
import { spawnSync } from 'node:child_process';

/** Scripts that live next to vendored trees and must not hide in that exemption. */
const OWN_VENDOR_SCRIPTS = new Set([
  'packages/runtime/vendor/update.js',
  'packages/runtime/vendor/update.mjs',
  'packages/runtime/vendor/update.cjs',
  'packages/runtime/vendor/fdlibm/port.js',
  'packages/runtime/vendor/fdlibm/port.mjs',
  'packages/runtime/vendor/fdlibm/port.cjs',
]);

/** stator-ts files that stay JavaScript (plan-notes 397). `harness.mjs` is `@embedFile`d into the
 * binary and written out at run time as the harness Node or Bun runs the tests in. The other two
 * are its own scripts, exempt only until they are ported to TypeScript (the follow-up 397 names). */
const TRANSPILER_JS = new Set([
  'packages/transpiler/src/harness.mjs',
  'packages/transpiler/scripts/benchmark.mjs',
  'packages/transpiler/tests/ts7/run.mjs',
]);

function isNodeShim(path: string): boolean {
  return (
    path.endsWith('/node_shim.js') ||
    path.endsWith('/node_shim.mjs') ||
    path.endsWith('/node_shim.cjs')
  );
}

/**
 * js-mode test inputs and examples, vendored upstream code, and browser assets.
 * Oracle shims and our own scripts are not in this set.
 */
function isExempt(path: string): boolean {
  if (isNodeShim(path) || OWN_VENDOR_SCRIPTS.has(path)) return false;
  if (path.startsWith('site/public/')) return true;
  if (TRANSPILER_JS.has(path)) return true;
  if (path.startsWith('packages/runtime/vendor/')) return true;
  if (path.startsWith('packages/tests/golden/')) return true;
  if (path.startsWith('packages/tests/subset/')) return true;
  if (path.startsWith('packages/tests/differential/')) return true;
  // stator-ts checker fixtures: inputs its differential tests feed to tsc and to stator-ts.
  if (path.startsWith('packages/transpiler/tests/fixtures/')) return true;
  if (path === 'packages/tests/leak/keys.js') return true;
  // stator-ts checker inputs: its JS/checkJs cases need real .js files. Its runner (tests/ts7) is
  // our own code and stays in scope.
  if (path.startsWith('packages/transpiler/tests/fixtures/')) return true;
  if (path.startsWith('examples/')) return true;
  return false;
}

const listed = spawnSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs'], {
  encoding: 'utf8',
});
if (listed.status !== 0) {
  process.stderr.write(`stator: git ls-files failed\n${listed.stderr}`);
  process.exit(1);
}
const paths = listed.stdout.split('\0').filter((path) => path !== '');
const offenders = paths.filter((path) => !isExempt(path));
if (offenders.length > 0) {
  process.stderr.write(
    'stator: JavaScript in our own source (Task 6.15). Port it to TypeScript. ' +
      'Exempt paths are js-mode test inputs and examples, vendored upstream code, ' +
      'generated output, and site/public assets:\n',
  );
  for (const path of offenders) process.stderr.write(`  ${path}\n`);
  process.exit(1);
}
process.stdout.write(`stator: ${String(paths.length)} tracked js/mjs/cjs files, all exempt\n`);
