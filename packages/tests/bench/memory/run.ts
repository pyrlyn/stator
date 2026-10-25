/* Memory benchmark: stator binaries vs other JS/TS -> standalone-binary compilers.
 *
 * For every program in ./programs plus the shared ../programs set, each available tool
 * compiles the same source into a standalone executable. Each executable runs RUNS times
 * under `/usr/bin/time -l` (macOS) / `-f %M` (Linux); we record the MEDIAN peak RSS, the
 * median wall time, and the binary size, and byte-compare stdout against the Node oracle.
 * Tools that are missing, fail to build, or print the wrong answer are reported with the
 * reason instead of a number. Results: results/<stamp>-<host>.json and RESULTS.md.
 *
 * Env: BENCH_RUNS (default 5), BENCH_TOOLS (comma list filter), BENCH_PROGRAMS (filter),
 * BENCH_TOOLS_BIN (extra dir prepended to PATH, e.g. a local node_modules/.bin).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { arch, cpus, hostname, platform, release, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../../support/node-path.ts';
import { onPath } from '../../support/on-path.ts';
import { type TimedRun, timedRun } from '../../support/timed-run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'compiler', 'src', 'cli', 'main.ts');
const RUNS = Number(process.env['BENCH_RUNS'] ?? '5');
if (process.env['BENCH_TOOLS_BIN'])
  process.env['PATH'] = `${process.env['BENCH_TOOLS_BIN']}${delimiter}${process.env['PATH'] ?? ''}`;

function sh(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number } = {},
): TimedRun {
  return timedRun(cmd, args, {
    ...opts,
    timeout: opts.timeout ?? 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function firstLine(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? 'unknown';
}
/** `available` for a tool on PATH whose version is the first line of `bin --version`. */
const versionOf = (bin: string) => (): string | undefined =>
  onPath(bin) && firstLine(bin, ['--version']);

/** A compiler: `build` turns (ts source, js source, work dir) into an executable path. */
interface Tool {
  name: string;
  kind: string;
  available(): string | undefined; // version, or undefined when absent
  build(ts: string, js: string, work: string): { exe: string; args?: string[] };
}

/** A tool that is one command writing `<work>/app`; `argv` maps (ts, js, exe) to its arguments. */
function oneCommand(
  name: string,
  kind: string,
  available: () => string | undefined,
  cmd: string,
  argv: (ts: string, js: string, exe: string) => string[],
  timeout?: number,
): Tool {
  return {
    name,
    kind,
    available,
    build: (ts, js, w) => {
      const exe = join(w, 'app');
      must(sh(cmd, argv(ts, js, exe), timeout === undefined ? { cwd: w } : { cwd: w, timeout }));
      return { exe };
    },
  };
}

const node = nodePath();
const tools: Tool[] = [
  oneCommand(
    'stator',
    'TS/JS -> C -> native (this repo)',
    () => 'working tree',
    process.execPath,
    (ts, _js, exe) => [CLI, 'build', ts, '-o', exe],
  ),
  oneCommand('perry', 'TS -> LLVM native', versionOf('perry'), 'perry', (ts, _js, exe) => [
    'compile',
    ts,
    '-o',
    exe,
  ]),
  oneCommand(
    'scriptc',
    'TS -> LLVM native (Vercel Labs)',
    versionOf('scriptc'),
    'scriptc',
    (ts, _js, exe) => ['build', ts, '-o', exe],
  ),
  {
    name: 'porffor',
    kind: 'JS -> Wasm -> C -> native',
    available: versionOf('porf'),
    build: (_ts, js, w) => {
      // porf writes <input-basename> next to the input regardless of the output argument.
      must(sh('porf', ['native', basename(js), 'app'], { cwd: w }));
      return { exe: join(w, basename(js, '.js')) };
    },
  },
  oneCommand(
    'qjsc',
    'JS -> QuickJS bytecode in C -> native',
    () => onPath('qjsc') && firstLine('qjs', ['-h']).replace(/^usage:\s*/i, ''),
    'qjsc',
    (_ts, js, exe) => ['-o', exe, js],
  ),
  oneCommand(
    'shermes',
    'JS -> Static Hermes native',
    () =>
      onPath('shermes') &&
      (process.env['SHERMES_VERSION'] ?? 'Static Hermes (static_h branch build)'),
    'shermes',
    (_ts, js, exe) => ['-O', '-o', exe, js],
  ),
  oneCommand(
    'bun-compile',
    'bundle + embedded JSC runtime',
    versionOf('bun'),
    'bun',
    (ts, _js, exe) => ['build', '--compile', ts, '--outfile', exe],
  ),
  oneCommand(
    'deno-compile',
    'bundle + embedded V8 runtime',
    versionOf('deno'),
    'deno',
    (ts, _js, exe) => ['compile', '-q', '-o', exe, ts],
  ),
  {
    name: 'node-sea',
    kind: 'Node single executable (embedded V8)',
    available: () => firstLine(node, ['--version']),
    build: (_ts, js, w) => {
      const exe = join(w, 'app');
      writeFileSync(
        join(w, 'sea.json'),
        JSON.stringify({ main: js, output: exe, disableExperimentalSEAWarning: true }),
      );
      must(sh(node, ['--build-sea', join(w, 'sea.json')], { cwd: w }));
      // The injected blob invalidates the Mach-O signature; arm64 macOS kills unsigned binaries.
      if (platform() === 'darwin') must(sh('codesign', ['--sign', '-', '--force', exe]));
      return { exe };
    },
  },
  oneCommand(
    'pkg',
    '@yao-pkg/pkg (Node base binary + snapshot fs)',
    versionOf('pkg'),
    'pkg',
    (_ts, js, exe) => [
      '-t',
      `node22-${platform() === 'darwin' ? 'macos' : 'linux'}-${arch()}`,
      '-o',
      exe,
      js,
    ],
  ),
  oneCommand(
    'nexe',
    'nexe (Node base binary + payload)',
    versionOf('nexe'),
    'nexe',
    (_ts, js, exe) => ['-i', js, '-o', exe],
    600_000,
  ),
];

function must(r: TimedRun): void {
  const text = `${r.stdout}\n${r.stderr}`;
  const err = text.split('\n').find((l) => /error/i.test(l));
  if (r.status !== 0 && err) throw new Error(err.trim().slice(0, 300));
  if (r.status !== 0)
    throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 300));
}
/** Non-system shared libraries the executable needs at run time (it is not fully standalone). */
function sharedLibs(exe: string): string[] {
  // Absolute paths: PATH is user-extended above (BENCH_TOOLS_BIN) and must not pick these.
  const r =
    platform() === 'darwin'
      ? spawnSync('/usr/bin/otool', ['-L', exe], { encoding: 'utf8' })
      : spawnSync('/usr/bin/ldd', [exe], { encoding: 'utf8' });
  return (r.stdout ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' ')[0] ?? '')
    .filter((l) => l && !/^\/usr\/lib\/|^\/System\/|^\/lib|linux-vdso|ld-linux/.test(l));
}
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

function programs(): string[] {
  const local = readdirSync(join(HERE, 'programs'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(HERE, 'programs', f));
  // ffi-sqrt uses a stator-only extern and startup.ts is empty (hello.ts covers it).
  const shared = ['fib.ts', 'json-roundtrip.ts', 'nbody.ts', 'string-churn.ts'].map((f) =>
    join(HERE, '..', 'programs', f),
  );
  const filter = process.env['BENCH_PROGRAMS']?.split(',');
  return [...local, ...shared].filter((p) => !filter || filter.includes(basename(p, '.ts')));
}

interface Cell {
  program: string;
  ok: boolean;
  sharedLibs?: string[];
  reason?: string;
  peakRssMedian?: number;
  peakRssRuns?: number[];
  wallMsMedian?: number;
  binaryBytes?: number;
}

function main(): void {
  // BENCH_RENDER=results/<file>.json re-renders RESULTS.md from a recording without running.
  const again = process.env['BENCH_RENDER'];
  if (again !== undefined && again !== '') {
    const rec = JSON.parse(readFileSync(again, 'utf8')) as {
      recordedAt: string;
      host: Record<string, string>;
      runs: number;
      results: { tool: string; kind: string; version: string; cells: Cell[] }[];
    };
    const names = [...new Set(rec.results.flatMap((r) => r.cells.map((c) => c.program)))];
    writeFileSync(
      join(HERE, 'RESULTS.md'),
      render(rec.runs, rec.recordedAt, rec.host, rec.results, names),
    );
    return;
  }
  const progs = programs();
  const filter = process.env['BENCH_TOOLS']?.split(',');
  const results: { tool: string; kind: string; version: string; cells: Cell[] }[] = [];
  for (const tool of tools.filter((t) => !filter || filter.includes(t.name))) {
    let version: string | undefined;
    try {
      version = tool.available() || undefined;
    } catch {
      version = undefined;
    }
    if (!version) {
      results.push({ tool: tool.name, kind: tool.kind, version: 'absent', cells: [] });
      continue;
    }
    const cells: Cell[] = [];
    for (const src of progs) {
      const program = basename(src, '.ts');
      const work = mkdtempSync(join(tmpdir(), `stator-mem-${tool.name}-`));
      try {
        const ts = join(work, `${program}.ts`);
        copyFileSync(src, ts);
        const js = join(work, `${program}.js`);
        writeFileSync(js, stripTypeScriptTypes(readFileSync(src, 'utf8')));
        const expected = sh(node, [js]).stdout;
        const { exe, args = [] } = tool.build(ts, js, work);
        if (!existsSync(exe)) throw new Error('build produced no executable');
        sh(exe, args, { cwd: work }); // warm-up: first launch pays code-signature/page-cache cost
        const rss: number[] = [];
        const ms: number[] = [];
        for (let i = 0; i < RUNS; i += 1) {
          const r = sh(exe, args, { cwd: work });
          if (r.status !== 0)
            throw new Error(
              `exit ${String(r.status)}: ${r.stderr.split('\n')[0] ?? ''}`.slice(0, 200),
            );
          // deno and porffor colourise console.log(number) even on a pipe; compare without ANSI.
          if (
            r.stdout.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') !==
            expected
          )
            throw new Error(
              `wrong output: ${JSON.stringify(r.stdout.slice(0, 40))} != ${JSON.stringify(expected.slice(0, 40))}`,
            );
          rss.push(r.maxRssBytes);
          ms.push(r.ms);
        }
        cells.push({
          program,
          ok: true,
          peakRssMedian: median(rss),
          peakRssRuns: rss,
          wallMsMedian: median(ms),
          binaryBytes: statSync(exe).size,
          sharedLibs: sharedLibs(exe),
        });
      } catch (e) {
        cells.push({ program, ok: false, reason: (e as Error).message });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      process.stderr.write(
        `${tool.name} ${program}: ${cells.at(-1)?.ok === true ? 'ok' : `FAIL ${cells.at(-1)?.reason ?? ''}`}\n`,
      );
    }
    results.push({ tool: tool.name, kind: tool.kind, version, cells });
  }
  const stamp = new Date().toISOString();
  const host = {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
  };
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const id = `${platform()}-${arch()}-${hostname()}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  writeFileSync(
    join(HERE, 'results', `${stamp.replace(/[:.]/g, '-')}-${id}.json`),
    `${JSON.stringify({ recordedAt: stamp, host, runs: RUNS, results }, null, 2)}\n`,
  );
  writeFileSync(
    join(HERE, 'RESULTS.md'),
    render(
      RUNS,
      stamp,
      host,
      results,
      progs.map((p) => basename(p, '.ts')),
    ),
  );
  process.stdout.write(
    render(
      RUNS,
      stamp,
      host,
      results,
      progs.map((p) => basename(p, '.ts')),
    ),
  );
}

const mb = (b: number): string => (b / 1048576).toFixed(b < 10485760 ? 2 : 1);
function render(
  runs: number,
  stamp: string,
  host: Record<string, string>,
  results: { tool: string; kind: string; version: string; cells: Cell[] }[],
  progs: string[],
): string {
  const out = [
    `# Memory benchmark results`,
    '',
    `Recorded ${stamp} on ${host['cpu']} (${host['platform']} ${host['release']}, ${host['arch']}), median of ${String(runs)} runs.`,
    '',
    '## Tools',
    '',
    '| Tool | Kind | Version |',
    '|---|---|---|',
  ];
  for (const r of results) out.push(`| ${r.tool} | ${r.kind} | ${r.version.replace(/\|/g, '/')} |`);
  for (const [title, key, fmt] of [
    ['Peak RSS, MB (median)', 'peakRssMedian', mb],
    ['Binary size, MB', 'binaryBytes', mb],
    ['Wall time, ms (median)', 'wallMsMedian', (n: number) => n.toFixed(0)],
  ] as const) {
    out.push(
      '',
      `## ${title}`,
      '',
      `| Tool | ${progs.join(' | ')} |`,
      `|---|${progs.map(() => '---:').join('|')}|`,
    );
    for (const r of results.filter((x) => x.cells.length > 0))
      out.push(
        `| ${r.tool} | ${progs
          .map((p) => {
            const c = r.cells.find((x) => x.program === p);
            return c?.ok ? fmt(c[key] as number) : 'fail';
          })
          .join(' | ')} |`,
      );
  }
  out.push('', '## Run-time shared-library dependencies (non-system)', '');
  for (const r of results.filter((x) => x.cells.some((c) => c.ok))) {
    const libs = [...new Set(r.cells.flatMap((c) => c.sharedLibs ?? []))];
    out.push(
      `- **${r.tool}**: ${libs.length ? libs.map((l) => `\`${l}\``).join(', ') : 'none (self-contained)'}`,
    );
  }
  const fails = results.flatMap((r) =>
    r.version === 'absent'
      ? [`- **${r.tool}**: not installed`]
      : r.cells
          .filter((c) => !c.ok)
          .map((c) => `- **${r.tool}** / ${c.program}: ${c.reason ?? ''}`),
  );
  if (fails.length) out.push('', '## Failures', '', ...fails);
  return `${out.join('\n')}\n`;
}

main();
