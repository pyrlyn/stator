/* plan.md §11c T11.2: the `std/*` package below the goldens.
 *
 * The goldens prove what a std call prints; this file pins what they cannot see — that the std
 * archive joins the link line only for a program whose module graph holds a std module (the
 * Check's "a program without `std/*` imports links no `libjsrt_std.a`"), and the two process
 * exits a golden cannot run because the golden runner demands status 0: a non-zero `exit` and
 * `abort`. */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { compileToC, linkArguments } from '../../compiler/src/cli/build.ts';
import { NATIVE_ONLY } from './helpers.ts';

const CLI = fileURLToPath(new URL('../../compiler/src/cli/main.ts', import.meta.url));

function withProgram<T>(source: string, body: (entry: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'stator-std-'));
  try {
    const entry = join(dir, 'main.ts');
    writeFileSync(entry, source);
    return body(entry, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `script(1)`'s spelling of "run this command on a fresh pseudo-terminal": BSD/macOS take the
 * command after the transcript file, util-linux takes it as `-c`. */
function underTerminal(binary: string): [string, string[]] {
  return process.platform === 'darwin'
    ? ['script', ['-q', '/dev/null', binary]]
    : ['script', ['-q', '-e', '-c', binary, '/dev/null']];
}

/** Build `source` and run the binary, handing back how it ended: fed `input` on stdin, or on a
 * pseudo-terminal when `terminal` is set. */
function buildAndRun(
  source: string,
  options: {
    readonly input?: string;
    readonly bindings?: string;
    readonly terminal?: boolean;
    readonly args?: readonly string[];
  } = {},
): ReturnType<typeof spawnSync> & { stdout: string } {
  return withProgram(source, (entry, dir) => {
    if (options.bindings !== undefined) writeFileSync(join(dir, 'native.d.ts'), options.bindings);
    const out = join(dir, 'main');
    const build = spawnSync(process.execPath, [CLI, 'build', entry, '-o', out], {
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, `build failed:\n${build.stdout}${build.stderr}`);
    if (options.terminal === true) {
      // stdin is /dev/null: BSD `script` refuses a socket there (spawnSync's default pipe).
      const [command, args] = underTerminal(out);
      return spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    }
    return spawnSync(out, options.args ?? [], {
      encoding: 'utf8',
      input: options.input ?? '',
      timeout: 30_000,
      // maxBuffer caps stdout and stderr TOGETHER (default 1 MiB): the MiB round trip plus its
      // stderr count went over, and the child was SIGTERMed whenever it had not exited yet.
      maxBuffer: 64 * 1024 * 1024,
    });
  });
}

test('the link line names libjsrt_std.a only when asked to', () => {
  const plain = linkArguments('main.c', 'main', 2, [], false);
  const std = linkArguments('main.c', 'main', 2, [], true);
  assert.equal(plain.filter((arg) => arg.endsWith('libjsrt_std.a')).length, 0);
  const archives = std.filter((arg) => arg.endsWith('libjsrt_std.a'));
  assert.equal(archives.length, 1);
  // Before `-ljsrt`: a static archive only satisfies references the objects before it made.
  const archive = archives[0] ?? '';
  assert.ok(std.indexOf(archive) < std.indexOf('-ljsrt'), 'std archive precedes the runtime');
  assert.deepEqual(
    std.filter((arg) => arg !== archive),
    plain,
    'the archive is the only difference',
  );
});

async function compiledStdC(
  source: string,
): Promise<{ readonly c: string; readonly std: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'stator-std-'));
  try {
    const entry = join(dir, 'main.ts');
    writeFileSync(entry, source);
    const compiled = await compileToC(entry, 'ts');
    assert.ok(compiled !== null, 'the program compiles');
    return compiled;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function compiledStd(source: string): Promise<boolean> {
  return (await compiledStdC(source)).std;
}

test('a std importer is a std link; a program without std imports is not', async () => {
  assert.equal(
    await compiledStd('import { join } from "std/path";\nconsole.log(join("a", "b"));\n'),
    true,
  );
  assert.equal(await compiledStd('console.log("no std");\n'), false);
});

test('std/process exit ends the program with its code, after what was printed', NATIVE_ONLY, () => {
  const run = buildAndRun(
    'import { exit } from "std/process";\nconsole.log("before");\nexit(3);\nconsole.log("after");\n',
  );
  assert.equal(run.status, 3);
  assert.equal(run.stdout, 'before\n');
});

test('std/process abort ends the program with SIGABRT', NATIVE_ONLY, () => {
  const run = buildAndRun(
    'import { abort } from "std/process";\nconsole.log("before");\nabort();\n',
  );
  assert.equal(run.signal, 'SIGABRT');
  assert.equal(run.status, null);
});

test('std/io write keeps program order with console.log on the same stream', NATIVE_ONLY, () => {
  const run = buildAndRun(
    'import { stdout, write } from "std/io";\n' +
      'console.log("one");\nwrite(stdout, "two\\n");\nconsole.log("three");\n',
  );
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'one\ntwo\nthree\n');
});

test('std/io read takes what stdin holds, then an empty answer at end of file', NATIVE_ONLY, () => {
  const run = buildAndRun(
    'import { read, stdin, stdout, writeBytes } from "std/io";\n' +
      'const first = read(stdin, 64);\nwriteBytes(stdout, first);\n' +
      'console.log(first.length, read(stdin, 64).length);\n',
    { input: 'h\u00e9 \u0000x\n' },
  );
  assert.equal(run.status, 0);
  // The NUL survives: bytes never cross the C-string boundary.
  assert.equal(run.stdout, 'h\u00e9 \u0000x\n7 0\n');
});

// plan.md §11c T11.3a: a `Uint8Array` crosses as its storage, so std/io's bytes take ONE call
// whatever their length — the byte channel this replaced made one call per byte.
test('std/io passes a Uint8Array to its backing as one pointer + length call', async () => {
  const { c } = await compiledStdC(
    'import { read, stdin, stdout, writeBytes } from "std/io";\n' +
      'writeBytes(stdout, read(stdin, 1048576));\n',
  );
  // A call site lands its raw result in an `_jsrt_exr_` local; the forward declaration does not.
  const lines = c.split('\n');
  for (const backing of ['jsrt_std_io_write_bytes', 'jsrt_std_io_read']) {
    const calls = lines.filter((line) => line.includes(`= ${backing}(`));
    assert.equal(calls.length, 1, `one call site for ${backing}`);
    assert.match(calls[0] ?? '', /\(void \*\)jsrt_uint8array_bytes\(.*\), jsrt_uint8array_count\(/);
  }
  assert.ok(!c.includes('jsrt_std_bytes_'), 'no byte channel is left');
});

// The same row carries std/hash and std/encoding: a digest, a random fill and a bytes-to-text
// conversion are each one call, the answer's view passed in for the backing to fill.
test('std/hash and std/encoding pass their bytes as one pointer + length call', async () => {
  const { c } = await compiledStdC(
    'import { bytesToHex } from "std/encoding";\n' +
      'import { randomBytes, sha256 } from "std/hash";\n' +
      'console.log(bytesToHex(sha256(randomBytes(1048576))));\n',
  );
  const lines = c.split('\n');
  const want: ReadonlyArray<readonly [string, number]> = [
    ['jsrt_std_hash_digest', 2],
    ['jsrt_std_hash_random_bytes', 1],
    ['jsrt_std_encoding_to_text', 1],
  ];
  for (const [backing, views] of want) {
    const calls = lines.filter((line) => line.includes(`= ${backing}(`));
    assert.equal(calls.length, 1, `one call site for ${backing}`);
    assert.equal(
      (calls[0] ?? '').split('jsrt_uint8array_count(').length - 1,
      views,
      `${backing} takes ${String(views)} view(s)`,
    );
  }
  assert.ok(!c.includes('jsrt_std_bytes_'), 'no byte channel is left');
});

test('std/io moves a MiB through read and writeBytes byte for byte', NATIVE_ONLY, () => {
  const input = Array.from({ length: 1 << 20 }, (_, i) => String.fromCharCode(32 + (i % 95))).join(
    '',
  );
  const run = buildAndRun(
    'import { read, stderr, stdin, stdout, write, writeBytes } from "std/io";\n' +
      'let total = 0;\nlet chunk = read(stdin, 1048576);\n' +
      'while (chunk.length > 0) {\n  writeBytes(stdout, chunk);\n  total += chunk.length;\n' +
      '  chunk = read(stdin, 1048576);\n}\nwrite(stderr, `${total}\\n`);\n',
    { input },
  );
  assert.equal(run.status, 0, `${String(run.signal)} ${String(run.error)} ${String(run.stderr)}`);
  assert.equal(run.stderr, `${String(1 << 20)}\n`);
  assert.ok(run.stdout === input, 'the MiB comes back unchanged');
});

test('std/io sees a terminal on a pseudo-terminal', NATIVE_ONLY, () => {
  const run = buildAndRun(
    'import { isatty, stdout, terminalSize } from "std/io";\n' +
      'const size = terminalSize(stdout);\n' +
      'console.log(isatty(stdout), size.columns === Math.floor(size.columns) && size.columns >= 0, ' +
      'size.rows === Math.floor(size.rows) && size.rows >= 0);\n',
    { terminal: true },
  );
  assert.equal(run.status, 0, String(run.stderr));
  // The terminal turns `\n` into `\r\n`, and BSD `script` echoes the EOF it reads (`^D`) first.
  assert.match(run.stdout.replace(/\r\n/g, '\n'), /(^|\n|\b)true true true\n$/);
});

test('std/hash randomBytes draws fresh bytes that cover the whole byte range', NATIVE_ONLY, () => {
  // Two 32-byte draws collide with probability 2^-256, and 65536 bytes miss one of the 256
  // values with probability about 256 * (255/256)^65536, below 10^-100.
  const run = buildAndRun(
    'import { bytesToHex } from "std/encoding";\n' +
      'import { randomBytes } from "std/hash";\n' +
      'console.log(bytesToHex(randomBytes(32)) !== bytesToHex(randomBytes(32)));\n' +
      'const seen = new Uint8Array(256);\n' +
      'for (const byte of randomBytes(65536)) {\n  seen[byte] = 1;\n}\n' +
      'let distinct = 0;\nfor (const flag of seen) {\n  distinct += flag;\n}\n' +
      'console.log(distinct);\n',
  );
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(run.stdout, 'true\n256\n');
});

// plan.md §11c T11.3 step 3: what the `std_process` golden cannot run — the golden runner passes
// no arguments and demands status 0, and a pid, a clock or a memory size differs every run.
test("std/process argv is main's argument vector, byte for byte", NATIVE_ONLY, () => {
  const args = ['plain', 'two words', '', 'h\u00e9 \u{1f600}', '--flag=x'];
  const run = buildAndRun(
    'import { argv } from "std/process";\nconst all = argv();\n' +
      'console.log(all.length);\nfor (const arg of all.slice(1)) {\n  console.log(`[${arg}]`);\n}\n' +
      'console.log((all[0] ?? "").endsWith("/main"));\n',
    { args },
  );
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(
    run.stdout,
    `${String(args.length + 1)}\n${args.map((arg) => `[${arg}]\n`).join('')}true\n`,
  );
});

test(
  'std/process setExitCode is the status of a normal end; exit and a throw still win',
  NATIVE_ONLY,
  () => {
    const set = 'import { exit, exitCode, setExitCode } from "std/process";\nsetExitCode(7);\n';
    const normal = buildAndRun(`${set}console.log(exitCode());\n`);
    assert.equal(normal.status, 7);
    assert.equal(normal.stdout, '7\n');
    assert.equal(buildAndRun(`${set}exit(3);\n`).status, 3);
    assert.equal(buildAndRun(`${set}throw new Error("boom");\n`).status, 1);
    assert.equal(buildAndRun(`${set}setExitCode(0);\n`).status, 0);
  },
);

test(
  'std/process and std/os identity, clock and memory answer plausible values',
  NATIVE_ONLY,
  () => {
    const run = withProgram(
      'import { hostname } from "std/os";\n' +
        'import { execPath, hrtimeNs, memoryUsage, pid, ppid } from "std/process";\n' +
        'import { sleepMs } from "std/time";\n' +
        'const t0 = hrtimeNs();\nsleepMs(20);\nconst t1 = hrtimeNs();\n' +
        'console.log(pid());\nconsole.log(ppid());\nconsole.log(execPath());\n' +
        'console.log(t1 - t0);\nconsole.log(memoryUsage().rss);\nconsole.log(hostname());\n',
      (entry, dir) => {
        const out = join(dir, 'main');
        const build = spawnSync(process.execPath, [CLI, 'build', entry, '-o', out], {
          encoding: 'utf8',
        });
        assert.equal(build.status, 0, `build failed:\n${build.stdout}${build.stderr}`);
        const ran = spawnSync(out, [], { encoding: 'utf8', timeout: 30_000 });
        return { ran, exe: realpathSync(out) };
      },
    );
    assert.equal(run.ran.status, 0, run.ran.stderr);
    const [pid, ppid, exe, elapsed, rss, host] = run.ran.stdout.trimEnd().split('\n');
    // spawnSync starts the binary directly, so its parent is this test process.
    assert.equal(Number(ppid), process.pid);
    assert.ok(Number(pid) > 0 && Number(pid) !== process.pid);
    assert.equal(exe, run.exe);
    assert.equal(host, hostname());
    // A 20 ms sleep on the monotonic clock: at least 20 ms, and well under the run's timeout.
    assert.ok(Number(elapsed) >= 20e6 && Number(elapsed) < 30e9, `elapsed ${String(elapsed)} ns`);
    assert.ok(Number(rss) >= 1 << 20 && Number(rss) < 2 ** 34, `rss ${String(rss)}`);
  },
);

// Thread-only oracles deliberately do not substitute Node workers: Stator shares closure cells.
test('std/thread publishes captured results, errors and main callbacks', NATIVE_ONLY, () => {
  const result = buildAndRun(`
    import { spawn, join, runOnMain, availableParallelism } from 'std/thread';
    import { Channel } from 'std/sync';
    const ready = new Channel<number>(1);
    const release = new Channel<number>(1);
    let observed = 0;
    let fulfill: (value: number) => void = () => {};
    const promised = new Promise<number>((resolve) => { fulfill = (value: number) => resolve(value); });
    Promise.resolve(1).then(() => console.log('microtask'));
    const worker = spawn(() => {
      runOnMain(() => { observed = 9; fulfill(15); release.send(1); });
      ready.send(1);
      release.receive();
      return 'answer';
    });
    const bad = spawn(() => { throw new Error('worker failed'); });
    async function errors(): Promise<void> {
      try { await bad.join(); } catch (e) { console.log((e as Error).message); }
    }
    async function main(): Promise<void> {
      ready.receive();
      console.log(availableParallelism() >= 1);
      console.log(worker.join() === join(worker));
      console.log(await promised);
      console.log(await worker.join());
      console.log(observed);
    }
    // No ordering assumption between independent completions.
    async function ordered(): Promise<void> { await main(); await errors(); }
    // Attach the error handler immediately; output ordering is pinned by awaiting it below.
    const handled = bad.join().catch(() => 'handled');
    ordered();
  `);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout, 'true\ntrue\nmicrotask\n15\nanswer\n9\nworker failed\n');
});

test('std/sync mutex contention and condition predicates publish shared state', NATIVE_ONLY, () => {
  const result = buildAndRun(`
    import { spawn } from 'std/thread';
    import { Mutex, CondVar, Channel } from 'std/sync';
    const mutex = new Mutex();
    const condition = new CondVar();
    const ready = new Channel<number>(2);
    const awake = new Channel<number>(2);
    let released = false;
    let total = 0;
    function work(): number {
      mutex.lock();
      ready.send(1);
      while (!released) condition.wait(mutex);
      mutex.unlock();
      awake.send(1);
      for (let i = 0; i < 1000; i++) {
        mutex.lock(); total += 1; mutex.unlock();
      }
      return 1;
    }
    const a = spawn(work);
    const b = spawn(work);
    ready.receive(); ready.receive();
    mutex.lock(); released = true; condition.signal(); mutex.unlock();
    awake.receive();
    mutex.lock(); condition.broadcast(); mutex.unlock();
    awake.receive();
    async function main(): Promise<void> {
      await a.join(); await b.join();
      console.log(total);
      console.log(mutex.tryLock()); console.log(mutex.tryLock()); mutex.unlock();
      condition.destroy(); mutex.destroy();
      try { mutex.lock(); } catch { console.log('destroyed'); }
    }
    main();
  `);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout, '2000\ntrue\nfalse\ndestroyed\n');
});

test('std/sync channels preserve FIFO, backpressure and close semantics', NATIVE_ONLY, () => {
  const result = buildAndRun(`
    import { spawn } from 'std/thread';
    import { Channel } from 'std/sync';
    const channel = new Channel<string>(1);
    const worker = spawn(() => {
      for (let i = 0; i < 100; i++) channel.send('item:' + i);
      channel.close();
      return 100;
    });
    let ordered = true;
    for (let i = 0; i < 100; i++) if (channel.receive() !== 'item:' + i) ordered = false;
    console.log(ordered);
    try { channel.receive(); } catch { console.log('empty closed'); }
    try { channel.send('late'); } catch { console.log('send closed'); }
    channel.close();
    async function main(): Promise<void> { console.log(await worker.join()); }
    main();
    try { new Channel<number>(0); } catch { console.log('capacity'); }
  `);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout, 'true\nempty closed\nsend closed\ncapacity\n100\n');
});

test(
  'std/thread collects while other threads hold closure, channel and return values',
  NATIVE_ONLY,
  () => {
    const result = buildAndRun(
      `
    import { collect } from './native.js';
    import { spawn } from 'std/thread';
    import { Channel } from 'std/sync';
    class Item {
      text: string;
      constructor(text: string) { this.text = text; }
    }
    const channel = new Channel<Item>(2);
    const prefix = 'prefix:'.repeat(30);
    function work(): string {
      let held = new Item(prefix);
      for (let i = 0; i < 150; i++) {
        const item = new Item(prefix + i);
        const data = { a: i };
        const spread = { b: i, ...data };
        if (Object.keys(spread).join(',') !== 'b,a') throw new Error('spread order');
        channel.send(item);
        collect();
        if (held.text.length < prefix.length) throw new Error('lost root');
        held = item;
      }
      return held.text;
    }
    const a = spawn(work); const b = spawn(work); const c = spawn(work); const d = spawn(work);
    let valid = true;
    for (let i = 0; i < 600; i++) {
      const item = channel.receive();
      collect();
      if (!item.text.startsWith(prefix)) valid = false;
    }
    async function main(): Promise<void> {
      const x = await a.join(); const y = await b.join();
      const z = await c.join(); const w = await d.join();
      collect();
      console.log(valid, x === prefix + 149, y === x, z === x, w === x);
    }
    main();
  `,
      { bindings: '/** @statorExtern jsrt_gc_collect */ export declare function collect(): void;' },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout, 'true true true true true\n');
  },
);

test('std/fs Promise twins perform native worker I/O and reject failures', NATIVE_ONLY, () => {
  const result = buildAndRun(`
    import { mkdirAsync, writeTextAsync, readTextAsync, statAsync, unlinkAsync, rmdirAsync } from 'std/fs';
    import { pid } from 'std/process';
    import { tmpdir } from 'std/os';
    async function main(): Promise<void> {
      const dir = tmpdir() + '/stator-thread-fs-' + pid();
      const file = dir + '/data';
      await mkdirAsync(dir);
      await writeTextAsync(file, 'thread I/O');
      console.log(await readTextAsync(file));
      const info = await statAsync(file);
      console.log(info.size);
      await unlinkAsync(file); await rmdirAsync(dir);
      try { await readTextAsync(file); } catch { console.log('missing'); }
    }
    main();
  `);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout, 'thread I/O\n10\nmissing\n');
});

test('std/fs Promise pool reuses workers across waves, errors and collection', NATIVE_ONLY, () => {
  const result = buildAndRun(
    `
    import { writeTextAsync, readTextAsync, unlinkAsync } from 'std/fs';
    import { pid } from 'std/process';
    import { tmpdir } from 'std/os';
    import { started, collect, drain } from './native.js';
    const file = tmpdir() + '/stator-pool-' + pid();
    const text = 'pool-'.repeat(4096);
    async function main(): Promise<void> {
      for (let i = 0; i < 32; i++) await writeTextAsync(file, text);
      console.log(started() === 1);
      try { await readTextAsync(file + '-missing'); } catch { console.log('missing'); }
      console.log(await readTextAsync(file) === text, started() === 1);
      const jobs: Promise<string>[] = [];
      for (let i = 0; i < 96; i++) jobs.push(readTextAsync(file));
      for (let i = 0; i < 100; i++) collect();
      const values = await Promise.all(jobs);
      console.log(values.length, values.every((value) => value === text));
      console.log(started() >= 1 && started() <= 4);
      const before = started();
      for (let i = 0; i < 16; i++) await readTextAsync(file);
      console.log(started() === before);
      await unlinkAsync(file);
    }
    main();
    drain();
    const beforeRestart = started();
    // A later drain starts a fresh pool; exit also waits for this unawaited chain.
    writeTextAsync(file, 'restart').then(() => {
      console.log(started() === beforeRestart + 1);
      return unlinkAsync(file);
    }).then(() => { console.log('drained'); });
    `,
    {
      bindings: `
        /** @statorExtern jsrt_thread_pool_started */
        export declare function started(): number;
        /** @statorExtern jsrt_gc_collect */
        export declare function collect(): void;
        /** @statorExtern jsrt_run_microtasks */
        export declare function drain(): void;
      `,
    },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout, 'true\nmissing\ntrue true\n96 true\ntrue\ntrue\ntrue\ndrained\n');
});

test('std/thread enforces worker restrictions and drains unjoined work', NATIVE_ONLY, () => {
  const result = buildAndRun(`
    import { spawn, runOnMain } from 'std/thread';
    import { Mutex, CondVar, Channel } from 'std/sync';
    const mutex = new Mutex();
    const condition = new CondVar();
    mutex.lock();
    try { mutex.lock(); } catch { console.log('recursive'); }
    try { mutex.destroy(); } catch { console.log('busy'); }
    mutex.unlock();
    try { mutex.unlock(); } catch { console.log('owner'); }
    try { condition.wait(mutex); } catch { console.log('wait owner'); }
    const blocked = new Channel<number>(1);
    blocked.send(1);
    const closed = spawn(() => {
      try { blocked.send(2); } catch { return 'closed'; }
      return 'sent';
    });
    blocked.close();
    const bad = spawn(async () => 1);
    const rejected = bad.join().catch(() => 'async rejected');
    spawn(() => { runOnMain(() => console.log('posted')); return 0; });
    async function main(): Promise<void> {
      console.log(await closed.join());
      console.log(await rejected);
    }
    main();
  `);
  assert.equal(result.status, 0, result.stderr.toString());
  // Publication order between independent workers is deliberately unspecified.
  assert.deepEqual(
    result.stdout.trim().split('\n').sort(),
    ['recursive', 'busy', 'owner', 'wait owner', 'closed', 'async rejected', 'posted'].sort(),
  );
});
