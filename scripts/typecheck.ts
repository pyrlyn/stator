// `pnpm run typecheck` (plan/T65): type-checks the TypeScript projects with stator-ts
// (`packages/transpiler`) instead of `tsc`.
//
// It builds stator-ts first, because the gate must check with the checker in this tree: a binary
// from another commit could pass code this one rejects. `zig build` caches, so an unchanged
// checker costs a cache lookup. `STATOR_TS` names a prebuilt binary instead, as for `test:typediff`.
//
// usage: node scripts/typecheck.ts [project-dir...]   (default: the five projects below)
// stator-ts reads lib.*.d.ts from the installed `typescript` package, so it matches the tsc pin.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projects = [
  'packages/compiler',
  'packages/tests',
  'packages/std',
  'packages/node',
  'packages/vite-stator',
];
const transpiler = join(root, 'packages', 'transpiler');

function buildStatorTs(): string {
  // ReleaseSafe: a checker bug must stop the gate with a panic, not pass it with a wrong answer.
  const built = spawnSync('zig', ['build', '-Doptimize=ReleaseSafe'], {
    cwd: transpiler,
    stdio: 'inherit',
  });
  if (built.error !== undefined || built.status !== 0) {
    const why = built.error === undefined ? `exit ${String(built.status)}` : built.error.message;
    console.error(`typecheck: building stator-ts failed (${why})`);
    console.error(
      'typecheck: fix: `mise install` provides Zig, or set STATOR_TS to a built stator-ts',
    );
    process.exit(1);
  }
  return join(
    transpiler,
    'zig-out',
    'bin',
    process.platform === 'win32' ? 'stator-ts.exe' : 'stator-ts',
  );
}

const preset = process.env['STATOR_TS'];
const binary = preset !== undefined && preset !== '' ? preset : buildStatorTs();
const wanted = process.argv.slice(2);

let failed = 0;
for (const project of wanted.length > 0 ? wanted : projects) {
  const run = spawnSync(binary, ['check', '-p', join(root, project, 'tsconfig.json')], {
    cwd: root,
    stdio: 'inherit',
  });
  // 0 and 2 are `check`'s verdicts (clean, errors); anything else is no verdict at all.
  if (run.error !== undefined || (run.status !== 0 && run.status !== 2)) {
    const why =
      run.error === undefined ? `exit ${String(run.status ?? run.signal)}` : run.error.message;
    console.error(`typecheck: stator-ts gave no verdict on ${project} (${why})`);
    failed += 1;
  } else if (run.status === 2) {
    console.error(`typecheck: ${project} has type errors`);
    failed += 1;
  }
}
process.exit(failed === 0 ? 0 : 1);
