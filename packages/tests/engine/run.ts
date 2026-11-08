/* The engine's script corpus and CLI contract (plan/T67, docs/ENGINE.md §5).
 *
 * Every script in scripts/ runs under the pinned Node and under `stator-engine run` in both modes;
 * stdout and the exit status must match Node byte-for-byte. A script that throws uncaught must
 * report it the way Node's first stderr line does. The CLI cases pin usage errors and the
 * not-yet targets. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../support/node-path.ts';
import { engineBinary } from './binary.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, 'scripts');
const MODES = ['interp', 'jit'] as const;

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Ran {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Node's report of an uncaught error carries `Name: message` on a line of its own. */
function uncaughtLine(stderr: string): string {
  return stderr.split('\n').find((l) => /^[A-Za-z]*Error: /.test(l)) ?? '';
}

const engine = engineBinary(
  process.env['STATOR_ENGINE_OPTIMIZE'] === 'Debug' ? 'Debug' : 'ReleaseSafe',
);
const failures: string[] = [];
let passed = 0;

function expect(name: string, ok: boolean, detail: string): void {
  if (ok) passed += 1;
  else failures.push(`${name}: ${detail}`);
}

for (const file of readdirSync(SCRIPTS)
  .filter((f) => /\.(ts|js)$/.test(f))
  .sort()) {
  const path = join(SCRIPTS, file);
  const node = run(nodePath(), [path]);
  for (const mode of MODES) {
    const got = run(engine, ['run', `--mode=${mode}`, path]);
    const name = `${file} [${mode}]`;
    expect(
      name,
      got.status === node.status,
      `exit ${String(got.status)}, Node ${String(node.status)}\n${got.stderr}`,
    );
    expect(
      name,
      got.stdout === node.stdout,
      `stdout differs\n--- node\n${node.stdout}--- engine\n${got.stdout}`,
    );
    if (node.status !== 0) {
      const want = uncaughtLine(node.stderr);
      expect(
        name,
        got.stderr.startsWith(`Uncaught ${want}`),
        `stderr ${JSON.stringify(got.stderr)}, want "Uncaught ${want}"`,
      );
    }
  }
}

interface CliCase {
  readonly args: readonly string[];
  readonly status: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

const cli: readonly CliCase[] = [
  { args: ['--help'], status: 0, stdout: 'usage: stator-engine run' },
  { args: [], status: 2, stderr: 'usage:' },
  { args: ['eval'], status: 2, stderr: "unknown command 'eval'" },
  { args: ['run', '--mode=aot', 'x.js'], status: 2, stderr: "unknown mode 'aot'" },
  { args: ['run', '--lang=py', 'x.js'], status: 2, stderr: "unknown language 'py'" },
  { args: ['run', 'x.txt'], status: 2, stderr: 'cannot tell the language' },
  { args: ['run'], status: 2, stderr: 'no file to run' },
  { args: ['run', join(SCRIPTS, 'missing.js')], status: 1, stderr: 'cannot read' },
  { args: ['run', '--lang=wasm', join(SCRIPTS, 'control.ts')], status: 1, stderr: 'plan/T67.3' },
  { args: ['build', '--target=wasm', 'x.ts'], status: 1, stderr: 'plan/T67.2' },
  { args: ['build', '--target=zig', 'x.ts'], status: 1, stderr: 'plan/T67.4' },
  { args: ['build', 'x.ts'], status: 2, stderr: 'build needs --target' },
];

for (const c of cli) {
  const got = run(engine, c.args);
  const name = `stator-engine ${c.args.join(' ')}`;
  expect(name, got.status === c.status, `exit ${String(got.status)}, want ${String(c.status)}`);
  if (c.stderr !== undefined)
    expect(name, got.stderr.includes(c.stderr), `stderr ${JSON.stringify(got.stderr)}`);
  if (c.stdout !== undefined)
    expect(name, got.stdout.includes(c.stdout), `stdout ${JSON.stringify(got.stdout)}`);
}

for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
process.stdout.write(`engine: ${String(passed)} passed, ${String(failures.length)} failed\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
