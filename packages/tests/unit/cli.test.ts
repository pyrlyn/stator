import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { BuildError, build } from '../../compiler/src/cli/build.ts';
import { NATIVE_ONLY } from './helpers.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'compiler', 'src', 'cli', 'main.ts');

interface Run {
  readonly status: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** All process spawning in this file goes through execa (owner directive, plan-notes 187):
 * rejection never throws — a CLI test asserts the failure, it doesn't die from it.
 *
 * Async on purpose: the spawns below are independent children, and awaiting them one by one would
 * idle the event loop while the OS could be running the next one. Tests that issue two independent
 * spawns overlap them with `Promise.all`; build-then-run pairs stay ordered (the binary does not
 * exist until the build finishes). */
async function spawn(command: string, args: readonly string[], cwd?: string): Promise<Run> {
  const result = await execa(command, [...args], {
    reject: false,
    // Byte-exactness is this codebase's testing contract; execa's convenience default would
    // silently eat a trailing '\n' and lie to an assertion comparing against one.
    stripFinalNewline: false,
    ...(cwd ? { cwd } : {}),
  });
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function stator(...args: string[]): Promise<Run> {
  return spawn(process.execPath, [CLI, ...args]);
}

/** Build `entry` to `binary`, assert the build held, and run the result — the ordered pair every
 * native test below needs. Ordered, not overlapped: the binary does not exist until the build
 * finishes. What the RUN must prove (status, streams) stays in the test: that is the claim. */
async function buildAndRun(entry: string, binary: string, ...buildArgs: string[]): Promise<Run> {
  const build = await stator('build', entry, '-o', binary, ...buildArgs);
  assert.equal(build.status, 0, build.stderr);
  return spawn(binary, []);
}

function packageJson(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO, 'compiler', 'package.json'), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null, 'package.json must be an object');
  return parsed as Record<string, unknown>;
}

test('the published binary is named stator even though the package is not', () => {
  const pkg = packageJson();
  assert.deepEqual(pkg['bin'], { stator: 'dist/cli/main.js' });
  assert.equal(pkg['name'], 'statorc', 'npm name "stator" is taken — see plan-notes.md');
});

test('--version prints the package version', async () => {
  const pkg = packageJson();
  const { status, stdout } = await stator('--version');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), pkg['version']);
});

test('--help names both modes', async () => {
  const { status, stdout } = await stator('--help');
  assert.equal(status, 0);
  assert.match(stdout, /--mode=ts\|js/);
});

test('an unknown command fails with a stable STA code, not a stack trace', async () => {
  const { status, stderr } = await stator('frobnicate');
  assert.equal(status, 1);
  assert.match(stderr, /^stator: STA0003 /);
  assert.doesNotMatch(stderr, /at .*\.ts:\d+/, 'diagnostics must never leak a stack trace');
});

test('an invalid mode is rejected', async () => {
  const { status, stderr } = await stator('build', 'x.ts', '-o', 'x', '--mode=wasm');
  assert.equal(status, 1);
  assert.match(stderr, /^stator: STA0002 /);
});

test('build and explain report a missing entry file as a path error', async () => {
  // Both commands must fail on the PATH before either tries to build a program, so the user gets
  // "no such file" rather than a checker diagnostic about a file that was never there.
  // The two spawns touch no shared state (a missing file is never written), so they run together;
  // assertions stay in argv order so the report reads like the serial one.
  const argvs: readonly (readonly string[])[] = [
    ['build', 'x.ts', '-o', 'x'],
    ['explain', 'x.ts'],
  ];
  const results = await Promise.all(argvs.map((argv) => stator(...argv)));
  for (const { status, stderr } of results) {
    assert.equal(status, 1);
    assert.match(stderr, /^stator: STA0007 entry file "x\.ts" does not exist/);
  }
});

test(
  'a builtin the program never references is not in the binary (Task 3.12)',
  NATIVE_ONLY,
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'stator-shake-'));
    try {
      const src = join(work, 'hello.ts');
      const out = join(work, 'hello');
      writeFileSync(src, 'console.log("hello");\n');
      const { status, stderr } = await stator('build', src, '-o', out);
      assert.equal(status, 0, stderr);
      // The symbol table's strings live in the file, so a byte search is a portable stand-in for
      // `nm`: a dead-stripped builtin's name is gone, a referenced one's remains.
      const binary = readFileSync(out).toString('latin1');
      // Thin LTO inlines small builtins (`jsrt_print`); the generated main still calls `jsrt_init`.
      assert.ok(binary.includes('jsrt_init'), 'the referenced builtin must survive the link');
      assert.ok(
        !binary.includes('jsrt_map_new'),
        'an unreferenced builtin must be dead-stripped, not dragged in with its object file',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test('a relative entry path resolves its imports (module graph is cwd-independent)', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-relative-'));
  try {
    writeFileSync(join(work, 'dep.ts'), 'export function five(): number {\n  return 5;\n}\n');
    writeFileSync(
      join(work, 'entry.ts'),
      'import { five } from "./dep.ts";\nconsole.log(five());\n',
    );
    // The regression: with a relative root the program's fileNames stayed relative while the
    // resolver answered absolute, so every import edge silently missed and legal source died
    // as STA4035 in the lowering.
    const result = await spawn(process.execPath, [CLI, 'explain', 'entry.ts', '--json'], work);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"verdict":"static"/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// Phase 5 step 4 lifted STA2004 for *reads* of an existing field: the shape-table entry points
// walk the class descriptor. Growing a NEW key on a fixed layout still cannot invent a slot, so
// that write stays STA2004 (Phase 8).
test('a fixed-shape object answers an aliased read of an existing field', NATIVE_ONLY, async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-cli-'));
  try {
    const entry = join(work, 'alias.ts');
    writeFileSync(
      entry,
      'const a: { x: number } = { x: 1 };\nconst b: { x?: number } = a;\nconsole.log(b.x);\n',
    );
    const binary = join(work, 'alias');
    const run = await buildAndRun(entry, binary);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '1\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test(
  'adding a new key to a fixed-shape object grows its overflow table (docs/VALUE.md §4.24)',
  NATIVE_ONLY,
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'stator-cli-'));
    try {
      const entry = join(work, 'grow.ts');
      writeFileSync(
        entry,
        'const a: { x: number } = { x: 1 };\nconst b: { x?: number; y?: number } = a;\nb.y = 2;\nconsole.log(b.y);\n',
      );
      const binary = join(work, 'grow');
      const run = await buildAndRun(entry, binary);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '2\n');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  'calling a non-function through an Unknown callee aborts with STA2006 at the site',
  NATIVE_ONLY,
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'stator-cli-'));
    try {
      const entry = join(work, 'call.js');
      writeFileSync(entry, 'function f(g) {\n  return g(1);\n}\nconsole.log(f(1));\n');
      const binary = join(work, 'call');
      const run = await buildAndRun(entry, binary, '--mode=js');
      assert.notEqual(run.status, 0, 'a non-function callee must abort, never jump');
      assert.match(run.stderr, /STA2006/);
      assert.match(run.stderr, /call\.js:2/);
      assert.equal(run.stdout, '', 'nothing may print before the abort');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  'a dynamic value reaching an annotated .ts binding aborts with STA2001',
  NATIVE_ONLY,
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'stator-cli-'));
    try {
      writeFileSync(join(work, 'wrap.js'), 'export function wrap(x) {\n  return x;\n}\n');
      const entry = join(work, 'main.ts');
      writeFileSync(
        entry,
        'import { wrap } from "./wrap.js";\nconst factor: number = wrap("10");\nconsole.log(factor);\n',
      );
      const binary = join(work, 'main');
      const run = await buildAndRun(entry, binary, '--mode=js');
      assert.notEqual(run.status, 0, 'a string in a number slot must abort, never print');
      assert.match(run.stderr, /STA2001/);
      assert.match(run.stderr, /main\.ts:2/);
      assert.equal(run.stdout, '', 'nothing may print before the abort');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

/* The same edge when the checker has an opinion: `label` infers `string`, so `const n: number =
 * label(10)` is TS2322. js mode suppresses it, and used to widen `n` to Unknown, which printed
 * `10` out of a `number` binding (plan-notes 301). The annotation now stays and the declaration
 * and assignment edges are checked. The passing half is golden `js/boundary_inferred`.
 * The call edge (TS2345) and the return edge (TS2322 on a `return` or an arrow's concise body) had
 * the same hole with no widening at all: `inc(label(1))` printed `11` and a `number` function
 * returned `"2"` (plan-notes 308). Their passing half is golden `js/boundary_call_return`. */
for (const [edge, body, line] of [
  ['declaration', 'const n: number = label(10);\nconsole.log(n);\n', 2],
  ['assignment', 'let n: number = 0;\nn = label(10);\nconsole.log(n);\n', 3],
  [
    'call',
    'function inc(x: number): number {\n  return x + 1;\n}\nconsole.log(inc(label(1)));\n',
    5,
  ],
  [
    'method-call',
    'class Box {\n  add(by: number): number {\n    return by + 1;\n  }\n}\n' +
      'console.log(new Box().add(label(1)));\n',
    7,
  ],
  [
    'constructor-call',
    'class Box {\n  n: number;\n  constructor(n: number) {\n    this.n = n;\n  }\n}\n' +
      'console.log(new Box(label(1)).n);\n',
    8,
  ],
  ['return', 'function g(): number {\n  return label(2);\n}\nconsole.log(g());\n', 3],
  ['concise-return', 'const h = (): number => label(4);\nconsole.log(h());\n', 2],
] as const) {
  test(
    `a .js value the checker types differently aborts the ${edge} edge with STA2001`,
    NATIVE_ONLY,
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'stator-cli-'));
      try {
        writeFileSync(join(work, 'lib.js'), 'export function label(x) {\n  return `${x}`;\n}\n');
        const entry = join(work, 'main.ts');
        writeFileSync(entry, `import { label } from "./lib.js";\n${body}`);
        const run = await buildAndRun(entry, join(work, 'main'), '--mode=js');
        assert.notEqual(run.status, 0, 'a string in a number slot must abort, never print');
        assert.match(run.stderr, /STA2001/);
        assert.match(run.stderr, new RegExp(`main\\.ts:${String(line)}:`));
        assert.match(run.stderr, /expected number, got string/);
        assert.equal(run.stdout, '', 'nothing may print before the abort');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}

/* A concise arrow body's TS2322 starts at the body's first identifier -- here the CALLEE `lbl`.
 * The suppression used to widen whatever identifier the diagnostic started at, so `lbl` itself
 * turned dynamic and the file graded `dynamic` (plan-notes 308). The return edge is a check, not a
 * widening: the file stays `static`. */
test('a concise-body return mismatch widens nothing in js mode', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-concise-'));
  try {
    const entry = join(work, 'main.ts');
    writeFileSync(
      entry,
      'const lbl = (x: number): string => `${x}`;\nconst h = (): number => lbl(4);\n' +
        'console.log(lbl(3), h());\n',
    );
    const explained = await stator('explain', entry, '--mode=js', '--json');
    assert.equal(explained.status, 0, explained.stderr);
    assert.equal((JSON.parse(explained.stdout) as { verdict: unknown }).verdict, 'static');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/* Provenance has to survive the trip to stdout (plan.md §8 step 1). `lower.test.ts` proves the HIR
 * fact; this proves the report carries it, because a grade that is right in the HIR and lost on the
 * way out is still a wrong answer to the question the user asked.
 *
 * All three grades in one matrix, because each is defined against the other two: `typed` is a
 * signature its AUTHOR wrote whole, `inferred` is one the checker finished, and `dynamic` is one
 * holding an Unknown -- which outranks both, since an un-annotated js parameter is not an omission
 * the checker happened to solve, it is the request for a dynamic value. The js half is the half
 * worth pinning: JSDoc is an annotation by the same author in a second spelling, so a fully
 * documented `.js` function grades `typed`, and only the PARTLY documented one is `inferred`
 * (plan-notes 140). */
test('explain --json grades every function typed, inferred or dynamic', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-provenance-'));
  try {
    // One statement per call: `console.log` takes one argument until plan §8 step 12 lands the rest.
    writeFileSync(
      join(work, 'grades.ts'),
      'function whole(x: number): number { return x; }\n' +
        'function halfWritten(x: number) { return x; }\n' +
        'console.log(whole(1));\n' +
        'console.log(halfWritten(2));\n',
    );
    writeFileSync(
      join(work, 'grades.js'),
      '/**\n * @param {number} x\n * @returns {number}\n */\n' +
        'function whole(x) { return x; }\n' +
        '/** @param {number} x */\n' +
        'function halfWritten(x) { return x; }\n' +
        'function none(x) { return x; }\n' +
        'console.log(whole(1));\n' +
        'console.log(halfWritten(2));\n' +
        'console.log(none(3));\n',
    );

    // The two explains read different entry files and write nowhere, so they run together.
    const [ts, js] = await Promise.all([
      stator('explain', join(work, 'grades.ts'), '--json'),
      stator('explain', join(work, 'grades.js'), '--mode=js', '--json'),
    ]);
    assert.equal(ts.status, 0, ts.stderr);
    assert.deepEqual(JSON.parse(ts.stdout), {
      verdict: 'static',
      functions: [
        { name: 'whole', line: 1, provenance: 'typed', verdict: 'static' },
        // An inferred RETURN is enough to demote it: the question is what the author asserted, and
        // the shape of the declaration never enters into it.
        { name: 'halfWritten', line: 2, provenance: 'inferred', verdict: 'static' },
      ],
    });

    assert.equal(js.status, 0, js.stderr);
    assert.deepEqual(JSON.parse(js.stdout), {
      // The FILE is dynamic because `none` is; its two annotated neighbours still compile static,
      // which is the js-mode claim §8 step 6 calls the JSDoc freebie.
      verdict: 'dynamic',
      functions: [
        { name: 'whole', line: 5, provenance: 'typed', verdict: 'static' },
        { name: 'halfWritten', line: 7, provenance: 'inferred', verdict: 'static' },
        { name: 'none', line: 8, provenance: 'dynamic', verdict: 'dynamic' },
      ],
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a fully JSDoc-annotated .js module has file verdict static', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-jsdoc-'));
  try {
    const entry = join(work, 'freebie.js');
    writeFileSync(
      entry,
      '/**\n * @param {number} x\n * @returns {number}\n */\n' +
        'function double(x) {\n  return x * 2;\n}\n' +
        'console.log(double(21));\n',
    );
    const explained = await stator('explain', entry, '--mode=js', '--json');
    assert.equal(explained.status, 0, explained.stderr);
    assert.deepEqual(JSON.parse(explained.stdout), {
      verdict: 'static',
      functions: [{ name: 'double', line: 5, provenance: 'typed', verdict: 'static' }],
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('explain lists every diagnostic of the deciding stage, in source order', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-explain-all-'));
  try {
    const entry = join(work, 'many.ts');
    // Written out of order on purpose: the report sorts by position, not by discovery.
    writeFileSync(entry, 'let b: any = 2;\nlet a: any = 1;\nconsole.log(a, b);\n');
    const [json, human] = await Promise.all([
      stator('explain', entry, '--json'),
      stator('explain', entry),
    ]);
    assert.equal(json.status, 0, json.stderr);
    const report: unknown = JSON.parse(json.stdout);
    assert.ok(typeof report === 'object' && report !== null);
    assert.ok('diagnostics' in report && Array.isArray(report.diagnostics));
    assert.deepEqual(
      report.diagnostics.map((d: unknown) =>
        typeof d === 'object' && d !== null && 'code' in d && 'line' in d ? [d.code, d.line] : d,
      ),
      [
        ['STA1001', 1],
        ['STA1001', 2],
      ],
    );
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /STA1001 x2/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a BigInt literal is not-yet STA1213, never internal STA4031', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-bigint-'));
  try {
    writeFileSync(join(work, 'b.ts'), 'const b = 1n;\n');
    writeFileSync(join(work, 'b.js'), 'console.log(1n === 1n);\n');
    const [ts, js] = await Promise.all([
      stator('explain', join(work, 'b.ts'), '--json'),
      stator('build', join(work, 'b.js'), '-o', join(work, 'b'), '--mode=js'),
    ]);
    assert.equal(ts.status, 0, ts.stderr);
    const report: unknown = JSON.parse(ts.stdout);
    assert.ok(typeof report === 'object' && report !== null);
    assert.deepEqual(
      { ...report, diagnostics: undefined },
      { verdict: 'not-yet', code: 'STA1213', diagnostics: undefined },
    );
    assert.notEqual(js.status, 0);
    assert.match(js.stderr, /STA1213/);
    assert.doesNotMatch(js.stderr, /STA4031/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a .js entry under default ts mode is STA1002 with a --mode=js hint, not tsc's allowJs error", async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-js-under-ts-'));
  try {
    const entry = join(work, 'entry.js');
    writeFileSync(entry, 'console.log(1);\n');

    // `explain` only reads the entry; `build` writes a separate `out` path — neither observes
    // the other, so they run together.
    const [explained, built] = await Promise.all([
      stator('explain', entry, '--json'),
      stator('build', entry, '-o', join(work, 'out')),
    ]);
    assert.equal(explained.status, 0, explained.stderr);
    const report: unknown = JSON.parse(explained.stdout);
    assert.ok(typeof report === 'object' && report !== null && 'diagnostics' in report);
    assert.deepEqual(
      { ...report, diagnostics: undefined },
      { verdict: 'error', code: 'STA1002', diagnostics: undefined },
    );

    // The hint has to come from the CLI path, not the in-memory host: tsc used to DROP the .js
    // file and answer STA0012 "enable the allowJs option", which is the wrong code and the wrong
    // flag. `build` reports programDiagnostics before the gate, so this is the path that used to
    // lose.
    assert.notEqual(built.status, 0);
    assert.match(built.stderr, /STA1002/);
    assert.match(built.stderr, /`--mode=js`/);
    assert.doesNotMatch(built.stderr, /STA0012/);
    assert.doesNotMatch(built.stderr, /allowJs/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a stack overflow inside the checker is STA0013, not a Node stack trace', async () => {
  // `var yield` plus a generator method whose computed key is `[yield]` makes the TypeScript
  // checker recurse without a depth guard until the JS stack is gone (upstream: `tsc` 6.0.3 dies on
  // the same file, Test262's generator-prop-name-yield-expr.js). Stator cannot fix that, but
  // AGENTS.md is unambiguous about what a user sees instead: a stable STA code, never a traceback
  // -- and not STA4072, which would call it a Stator bug (plan-notes 287).
  const work = mkdtempSync(join(tmpdir(), 'stator-checker-crash-'));
  try {
    const entry = join(work, 'entry.js');
    writeFileSync(
      entry,
      'var obj = null;\n' +
        "var yield = 'propNameViaIdentifier';\n" +
        'var iter = (function*() {\n' +
        '  obj = {\n' +
        '    *[yield]() {}\n' +
        '  };\n' +
        '})();\n' +
        'console.log(typeof iter);\n',
    );
    const { status, stderr } = await stator('build', entry, '-o', join(work, 'out'), '--mode=js');
    assert.equal(status, 1);
    assert.match(stderr, /^stator: STA0013 the TypeScript checker ran out of stack/);
    assert.doesNotMatch(stderr, /typescript\.js/, 'the upstream frame must not leak');
    assert.doesNotMatch(stderr, /\n\s+at /, 'diagnostics must never leak a stack trace');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a long chain of inferred return types is STA0013 from explain, not STA4072', async () => {
  // The terminating shape behind TypeScript 6.0.3's `_tsc.js` (plan-notes 286, 287): the checker
  // infers `f0`'s return type from `f1`'s, and so on, one nested inference per link. 600 links
  // overflow the default stack (plain `tsc` too); 3000 keeps the margin wide. A JSDoc return type
  // every few hundred links cuts the chain, which is what STA0013's message tells the user.
  const work = mkdtempSync(join(tmpdir(), 'stator-checker-chain-'));
  try {
    const links = 3000;
    const chain = (annotateEvery: number): string => {
      let text = '';
      for (let i = 0; i < links; i++) {
        if (i % annotateEvery === 0) text += '/** @returns {number} */\n';
        text += `function f${String(i)}(x) { return f${String(i + 1)}(x); }\n`;
      }
      return `${text}function f${String(links)}(x) { return x; }\nconsole.log(f0(1));\n`;
    };
    const entry = join(work, 'chain.js');
    writeFileSync(entry, chain(links));
    const overflowed = await stator('explain', entry, '--mode=js', '--json');
    assert.equal(overflowed.status, 1);
    assert.match(overflowed.stderr, /^stator: STA0013 /);
    assert.doesNotMatch(overflowed.stderr, /STA4072/);

    writeFileSync(entry, chain(200));
    const annotated = await stator('explain', entry, '--mode=js', '--json');
    assert.equal(annotated.status, 0, annotated.stderr);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('an in-process build whose checker overflows is BuildError STA0013, not a throw', async () => {
  // Same crashing construct as the CLI test above, through the path the Test262 runner uses:
  // `build()` in-process never passes through `main()`'s catch-all, so without `compileToC`'s own
  // guard the RangeError escapes, kills the shard, and no artifact is uploaded.
  const work = mkdtempSync(join(tmpdir(), 'stator-checker-crash-inprocess-'));
  try {
    const entry = join(work, 'entry.js');
    writeFileSync(
      entry,
      'var obj = null;\n' +
        "var yield = 'propNameViaIdentifier';\n" +
        'var iter = (function*() {\n' +
        '  obj = {\n' +
        '    *[yield]() {}\n' +
        '  };\n' +
        '})();\n' +
        'console.log(typeof iter);\n',
    );
    await assert.rejects(
      build({ entry, out: join(work, 'out'), mode: 'js', emitCOnly: false, keepC: false }),
      (error: unknown) => {
        assert.ok(error instanceof BuildError);
        assert.equal(error.code, 'STA0013');
        assert.match(error.message, /^the TypeScript checker ran out of stack/);
        assert.doesNotMatch(error.message, /typescript\.js/, 'the upstream frame must not leak');
        return true;
      },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/* Task 6.20 (QA audit F1, F2, F10, F11): `build` never destroys an input, and a user's mistake is
 * a user error with a stable code, never STA4072 "compiler bug". Every refusal below happens
 * before clang runs, so none of these needs the native toolchain. */

/** A scratch directory with `files` written into it, removed after `body`. */
async function inScratch(
  files: Readonly<Record<string, string>>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'stator-cli-outputs-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `stator` in `dir`, with stderr on one line: ink wraps a diagnostic at the terminal width, and
 * these tests read the message, not its layout. Paths stay relative so a wrap cannot split one. */
async function statorIn(dir: string, ...args: string[]): Promise<Run> {
  const run = await spawn(process.execPath, [CLI, ...args], dir);
  return { ...run, stderr: run.stderr.replace(/\s+/g, ' ') };
}

const ADD = 'export function add(a: number, b: number): number { return a + b; }\n';

test('build refuses an -o that is the entry file (F1: the source must survive)', async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const r = await statorIn(dir, 'build', 'app.ts', '-o', 'app.ts', '--emit=c');
    const entry = join(dir, 'app.ts');
    assert.equal(readFileSync(entry, 'utf8'), 'console.log(1);\n', 'entry overwritten with C');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^stator: STA0004 -o "app\.ts" is the entry file "app\.ts"/);
  });
});

test('--emit-header refuses to alias -o or the entry (F1)', async () => {
  await inScratch({ 'lib.ts': ADD }, async (dir) => {
    const [aliasOut, aliasEntry] = await Promise.all([
      statorIn(dir, 'build', 'lib.ts', '-o', 'lib.h', '--emit=c', '--emit-header=lib.h'),
      statorIn(dir, 'build', 'lib.ts', '-o', 'lib.c', '--emit=c', '--emit-header=lib.ts'),
    ]);
    const entry = join(dir, 'lib.ts');
    assert.equal(aliasOut.status, 1, 'the header silently replaced the C output');
    assert.match(
      aliasOut.stderr,
      /STA0004 -o ".*lib\.h" and --emit-header ".*lib\.h" name the same file/,
    );
    assert.equal(aliasEntry.status, 1);
    assert.match(aliasEntry.stderr, /STA0004 --emit-header ".*lib\.ts" is the entry file/);
    assert.equal(readFileSync(entry, 'utf8'), ADD);
    assert.equal(existsSync(join(dir, 'lib.h')), false);
  });
});

test('-o naming an imported module, or the --keep-c file naming the header, is refused (F1)', async () => {
  await inScratch(
    { 'main.ts': "import { add } from './dep.ts';\nconsole.log(add(1, 2));\n", 'dep.ts': ADD },
    async (dir) => {
      const [imported, keptC] = await Promise.all([
        statorIn(dir, 'build', 'main.ts', '-o', 'dep.ts', '--emit=c'),
        statorIn(dir, 'build', 'main.ts', '-o', 'x', '--keep-c', '--emit-header=x.c'),
      ]);
      assert.equal(imported.status, 1);
      assert.match(
        imported.stderr,
        /STA0004 -o "dep\.ts" is a source file of the program ".*dep\.ts"/,
      );
      assert.equal(readFileSync(join(dir, 'dep.ts'), 'utf8'), ADD);
      assert.equal(keptC.status, 1);
      assert.match(
        keptC.stderr,
        /STA0004 --emit-header "x\.c" and the --keep-c file "x\.c" name the same file/,
      );
    },
  );
});

test('an in-process build() refuses an aliased output too (F1: statorc/api callers)', async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const entry = join(dir, 'app.ts');
    await assert.rejects(
      build({ entry, out: entry, mode: 'ts', emitCOnly: true, keepC: false }),
      (error: unknown) => error instanceof BuildError && error.code === 'STA0004',
    );
    assert.equal(readFileSync(entry, 'utf8'), 'console.log(1);\n');
  });
});

test('an unwritable output is STA0019, not STA4072 "compiler bug" (F2)', async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n', 'lib.ts': ADD }, async (dir) => {
    const [cOut, binary, header, isDir] = await Promise.all([
      statorIn(dir, 'build', 'app.ts', '-o', 'missing/out.c', '--emit=c'),
      statorIn(dir, 'build', 'app.ts', '-o', 'missing/app'),
      statorIn(dir, 'build', 'lib.ts', '-o', 'lib.c', '--emit=c', '--emit-header=missing/lib.h'),
      statorIn(dir, 'build', 'app.ts', '-o', '.'),
    ]);
    for (const r of [cOut, binary, header, isDir]) {
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /^stator: STA0019 cannot write /);
      assert.doesNotMatch(r.stderr, /STA4072|compiler bug/);
    }
    assert.match(
      cOut.stderr,
      /cannot write -o "missing\/out\.c": ENOENT \(the directory does not exist\)/,
    );
    assert.match(binary.stderr, /ENOENT/);
    assert.match(header.stderr, /cannot write --emit-header /);
    assert.match(isDir.stderr, /EISDIR \(it is a directory\)/);
  });
});

test('an explicit --unit-name must already be a C identifier part (F10)', async () => {
  await inScratch({ 'lib.ts': ADD }, async (dir) => {
    const header = (name: string) =>
      statorIn(
        dir,
        'build',
        'lib.ts',
        '-o',
        `${name}.c`,
        '--emit=c',
        `--emit-header=${name}.h`,
        `--unit-name=${name}`,
      );
    const [dashed, dotted, plain] = await Promise.all([
      header('my-lib'),
      header('my.lib'),
      header('my_lib'),
    ]);
    for (const refused of [dashed, dotted]) {
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /^stator: STA0004 unit name "my[-.]lib"/);
    }
    assert.equal(existsSync(join(dir, 'my-lib.h')), false);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(readFileSync(join(dir, 'my_lib.h'), 'utf8'), /stator_my_lib_add/);
  });
});

test('a value flag refuses a flag as its value (F11)', async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const [out, link, linkEq] = await Promise.all([
      statorIn(dir, 'build', 'app.ts', '-o', '--emit=c'),
      statorIn(dir, 'build', 'app.ts', '-o', 'app', '--link', '-lm'),
      statorIn(dir, 'build', 'none.ts', '-o', 'app', '--link=-lm'),
    ]);
    assert.equal(out.status, 1);
    assert.match(
      out.stderr,
      /^stator: STA0004 -o requires an output path, not the flag "--emit=c"/,
    );
    assert.equal(existsSync(join(dir, '--emit=c')), false);
    assert.match(link.stderr, /^stator: STA0004 --link requires .*write --link=-lm/);
    // The `=` spelling carries a dash-led value: the parse passes, and the missing entry is next.
    assert.match(linkEq.stderr, /^stator: STA0007 /);
  });
});

test('each command accepts only its own flags (F11)', async () => {
  const runs = await Promise.all(
    [
      ['explain', 'lib.ts', '--emit=c'],
      ['explain', 'lib.ts', '--opt=3'],
      ['explain', 'lib.ts', '-o', 'x'],
      ['explain', 'lib.ts', '--keep-c'],
      ['explain', 'lib.ts', '--link=-lm'],
      ['build', 'lib.ts', '-o', 'x', '--json'],
    ].map(async (argv) => ({ argv, run: await stator(...argv) })),
  );
  for (const { argv, run } of runs) {
    assert.equal(run.status, 1, argv.join(' '));
    assert.match(
      run.stderr,
      new RegExp(`^stator: STA0005 flag "[^"]+" does not apply to ${argv[0] ?? ''}`),
      argv.join(' '),
    );
  }
});

test('a bad STATOR_OPT names the environment as its origin (F11)', async () => {
  const run = await execa(process.execPath, [CLI, 'build', 'x.ts', '-o', 'x.c', '--emit=c'], {
    reject: false,
    env: { STATOR_OPT: 'fast' },
  });
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /STA0002 unknown opt "fast" in the environment variable STATOR_OPT/);
});

/* Task 6.21 (QA audit F3, F4): the runtime is resolved per build, and a project `.env` may choose
 * only STATOR_OPT, STATOR_RUNTIME and STATOR_OTEL — never the C compiler, the runtime root or the
 * telemetry exporter. */

/** `stator` in `dir` with `env` merged over the real environment (`undefined` unsets a key). */
async function statorEnv(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  ...args: string[]
): Promise<Run> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  const result = await execa(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: merged,
    extendEnv: false,
    reject: false,
  });
  return {
    status: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr.replace(/\s+/g, ' '),
  };
}

const LOCALE_COMPARE = "console.log('a'.localeCompare('b', 'en'));\n";

test('STATOR_RUNTIME from .env reaches the link, not only the gate (F3)', NATIVE_ONLY, async () => {
  await inScratch({ '.env': 'STATOR_RUNTIME=intl\n', 'lc.ts': LOCALE_COMPARE }, async (dir) => {
    const b = await statorEnv(dir, { STATOR_RUNTIME: undefined }, 'build', 'lc.ts', '-o', 'lc');
    assert.match(b.stderr, /stator: \.env: applied STATOR_RUNTIME/);
    if (b.status === 0) {
      const r = await spawn(join(dir, 'lc'), [], dir);
      assert.equal(r.status, 0, `linked against the default archive and panicked:\n${r.stderr}`);
    } else {
      // Without the ICU build the answer is the same as with the variable set for real.
      assert.match(b.stderr, /STA0011 runtime archive not found at .*build-intl/);
    }
  });
});

test('an in-process build reads the runtime when it runs, not when build.ts was imported (F3)', async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const saved = process.env['STATOR_RUNTIME_ROOT'];
    process.env['STATOR_RUNTIME_ROOT'] = join(dir, 'no-runtime');
    try {
      await assert.rejects(
        build({
          entry: join(dir, 'app.ts'),
          out: join(dir, 'app'),
          mode: 'ts',
          emitCOnly: false,
          keepC: false,
        }),
        (error: unknown) =>
          error instanceof BuildError &&
          error.code === 'STA0011' &&
          error.message.includes('no-runtime'),
      );
    } finally {
      if (saved === undefined) {
        delete process.env['STATOR_RUNTIME_ROOT'];
      } else {
        process.env['STATOR_RUNTIME_ROOT'] = saved;
      }
    }
  });
});

test('a project .env must not choose the C compiler (F4)', NATIVE_ONLY, async () => {
  await inScratch({ 'lib.ts': ADD }, async (dir) => {
    const marker = join(dir, 'ran.txt');
    const fake = join(dir, 'fakecc.sh');
    writeFileSync(fake, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(fake, 0o755);
    writeFileSync(
      join(dir, '.env'),
      `CC=${fake}\nSTATOR_RUNTIME_ROOT=/nonexistent\nOTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9\n`,
    );
    const r = await statorEnv(
      dir,
      { CC: undefined, STATOR_RUNTIME_ROOT: undefined, OTEL_EXPORTER_OTLP_ENDPOINT: undefined },
      'build',
      'lib.ts',
      '-o',
      'lib.o',
      '--emit-header=lib.h',
    );
    assert.equal(existsSync(marker), false, 'CC from the project .env was executed');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'lib.o')), 'the real clang wrote the object');
    assert.match(
      r.stderr,
      /stator: \.env: ignored CC, STATOR_RUNTIME_ROOT, OTEL_EXPORTER_OTLP_ENDPOINT \(only STATOR_OPT, STATOR_RUNTIME, STATOR_OTEL may come from \.env\)/,
    );
  });
});

test('.env may set STATOR_OPT, and the real environment wins over it (F4)', async () => {
  await inScratch({ '.env': 'STATOR_OPT=fast\n', 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const [fromFile, fromEnv] = await Promise.all([
      statorEnv(dir, { STATOR_OPT: undefined }, 'build', 'app.ts', '-o', 'a.c', '--emit=c'),
      statorEnv(dir, { STATOR_OPT: '1' }, 'build', 'app.ts', '-o', 'b.c', '--emit=c'),
    ]);
    assert.equal(fromFile.status, 1);
    assert.match(fromFile.stderr, /^stator: \.env: applied STATOR_OPT /);
    assert.match(
      fromFile.stderr,
      /STA0002 unknown opt "fast" in the environment variable STATOR_OPT/,
    );
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.doesNotMatch(fromEnv.stderr, /\.env/, 'nothing applied, so nothing to say');
  });
});

test('a C compiler that exits 0 but writes nothing fails the build (F4)', NATIVE_ONLY, async () => {
  await inScratch({ 'app.ts': 'console.log(1);\n', 'lib.ts': ADD }, async (dir) => {
    const fake = join(dir, 'silentcc.sh');
    // Passes the `--version` probe as clang, then swallows the compile.
    writeFileSync(fake, '#!/bin/sh\n[ "$1" = --version ] && echo "clang version 21.1.8"\nexit 0\n');
    chmodSync(fake, 0o755);
    const [binary, object] = await Promise.all([
      statorEnv(dir, { CC: fake }, 'build', 'app.ts', '-o', 'app'),
      statorEnv(dir, { CC: fake }, 'build', 'lib.ts', '-o', 'lib.o', '--emit-header=lib.h'),
    ]);
    for (const r of [binary, object]) {
      assert.equal(r.status, 1, 'a build that produced nothing reported success');
      assert.match(
        r.stderr,
        /STA0009 C compiler ".*silentcc\.sh" exited 0 but wrote no "(app|lib\.o)"/,
      );
    }
  });
});

/** A `CC` that fails the `--version` probe (plan/T35): the diagnostic, its fix, no stack. */
async function refusedCompiler(
  env: Readonly<Record<string, string | undefined>>,
  ...flags: string[]
): Promise<string> {
  let stderr = '';
  await inScratch({ 'app.ts': 'console.log(1);\n' }, async (dir) => {
    const r = await statorEnv(dir, env, 'build', 'app.ts', '-o', 'app', ...flags);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /STA0022 /);
    assert.match(r.stderr, /--cc=<name\|path>, config "cc" or CC/);
    assert.doesNotMatch(r.stderr, / at \S+ \(|node:internal|STA4072/, 'no stack trace');
    assert.equal(existsSync(join(dir, 'app')), false);
    stderr = r.stderr;
  });
  return stderr;
}

test('--cc names a missing compiler: STA0022 naming the value and --cc (T35)', async () => {
  const stderr = await refusedCompiler({ CC: undefined }, '--cc=stator-no-such-cc');
  assert.match(stderr, /C compiler "stator-no-such-cc" \(from --cc\) not found/);
});

test(
  'CC=/usr/bin/false fails the --version probe: STA0022 naming CC (T35)',
  NATIVE_ONLY,
  async () => {
    const stderr = await refusedCompiler({ CC: '/usr/bin/false' });
    assert.match(
      stderr,
      /C compiler "\/usr\/bin\/false" \(from CC\) failed `--version` \(exit 1\)/,
    );
  },
);

test(
  'the default clang without mise on PATH: STA0022 naming mise and the fix, no fallback (T35)',
  NATIVE_ONLY,
  async () => {
    const empty = mkdtempSync(join(tmpdir(), 'stator-no-mise-'));
    try {
      const stderr = await refusedCompiler({
        CC: undefined,
        STATOR_RUNTIME: undefined,
        PATH: empty,
      });
      assert.match(
        stderr,
        /the default C compiler, mise's pinned LLVM clang \(conda:clang@[\d.]+\), is unavailable: mise is not on PATH — run `mise install`/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  },
);

test('an unknown --version banner is refused: STA0022 quoting it (T35)', NATIVE_ONLY, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-cc-'));
  try {
    const fake = join(dir, 'oddcc.sh');
    writeFileSync(fake, '#!/bin/sh\necho "Odd C 1.0"\n');
    chmodSync(fake, 0o755);
    const stderr = await refusedCompiler({ CC: '/usr/bin/false' }, `--cc=${fake}`);
    assert.match(
      stderr,
      /\(from --cc\) is not clang, Apple clang or gcc: `--version` printed "Odd C 1\.0"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build --help lists --cc (T35)', async () => {
  const { status, stdout } = await stator('build', '--help');
  assert.equal(status, 0);
  assert.match(stdout, /--cc <cc>/);
});
