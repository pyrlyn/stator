/* CPU profiling of stator binaries with samply, exported to speedscope JSON.
 *
 * For every memory-benchmark program (../memory/programs plus the shared ../programs set used
 * by ../memory/run.ts) this compiles the program with stator (CC wrapper adds frame pointers,
 * nothing else), records it with `samply record --save-only --unstable-presymbolicate`, then
 * converts the Firefox-Profiler output to speedscope JSON plus a plain-text hot-spot summary.
 *
 * Output (gitignored): packages/tests/bench/profile/out/<program>/
 *   app                       the profiled binary (keeps its symbol table)
 *   profile.json.gz           raw samply profile (open with `samply load`)
 *   profile.json.syms.json    samply's symbol sidecar
 *   profile.speedscope.json   speedscope file (https://www.speedscope.app, or read as JSON)
 *   summary.txt               top functions by self / total CPU share, per library
 *
 * Env: PROFILE_PROGRAMS (comma filter), PROFILE_RATE (Hz, default 4000), PROFILE_TOP (default 25),
 *      PROFILE_OUT (output dir), SAMPLY (samply binary), PYTHON (default python3).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'compiler', 'src', 'cli', 'main.ts');
const OUT = process.env['PROFILE_OUT'] ?? join(HERE, 'out');
const SAMPLY = process.env['SAMPLY'] ?? 'samply';
const PYTHON = process.env['PYTHON'] ?? 'python3';
const RATE = process.env['PROFILE_RATE'] ?? '4000';
const TOP = process.env['PROFILE_TOP'] ?? '25';

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string): void {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], env, cwd });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

function programs(): string[] {
  const local = readdirSync(join(HERE, '..', 'memory', 'programs'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(HERE, '..', 'memory', 'programs', f));
  const shared = ['fib.ts', 'json-roundtrip.ts', 'nbody.ts', 'string-churn.ts'].map((f) =>
    join(HERE, '..', 'programs', f),
  );
  const filter = process.env['PROFILE_PROGRAMS']?.split(',');
  return [...local, ...shared].filter((p) => !filter || filter.includes(basename(p, '.ts')));
}

if (spawnSync(SAMPLY, ['--version']).status !== 0) {
  console.error('samply not found: `brew install samply` or `cargo install --locked samply`');
  process.exit(1);
}

const ccEnv = {
  ...process.env,
  // A custom CC disables the driver's stale-ld/SDK retry, so on macOS default to the system
  // clang (always links against the installed SDK); elsewhere plain `clang`.
  STATOR_PROFILE_REAL_CC:
    process.env['CC'] ??
    (process.platform === 'darwin' && existsSync('/usr/bin/clang') ? '/usr/bin/clang' : 'clang'),
  CC: join(HERE, 'cc-profile.sh'),
};
const index: string[] = [];
let failed = 0;
for (const ts of programs()) {
  const name = basename(ts, '.ts');
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'app');
  const raw = join(dir, 'profile.json.gz');
  try {
    process.stderr.write(`[${name}] build\n`);
    run(process.execPath, [CLI, 'build', ts, '-o', exe], ccEnv);
    process.stderr.write(`[${name}] samply record @ ${RATE} Hz\n`);
    run(SAMPLY, ['record', '--save-only', '--unstable-presymbolicate', '-r', RATE, '-o', raw, exe], process.env, dir);
    const summary = join(dir, 'summary.txt');
    run(PYTHON, [join(HERE, 'to_speedscope.py'), raw, join(dir, 'profile.speedscope.json'), '--summary', summary, '--top', TOP]);
    index.push(`## ${name}\n\n\`\`\`\n${readFileSync(summary, 'utf8')}\`\`\`\n`);
  } catch (e) {
    failed++;
    console.error(`[${name}] FAILED: ${(e as Error).message}`);
    index.push(`## ${name}\n\nFAILED: ${(e as Error).message}\n`);
  }
}
writeFileSync(join(OUT, 'SUMMARY.md'), `# stator samply profiles\n\n${index.join('\n')}`);
console.log(`profiles in ${OUT}${existsSync(join(OUT, 'SUMMARY.md')) ? ' (SUMMARY.md)' : ''}`);
process.exit(failed ? 1 : 0);
