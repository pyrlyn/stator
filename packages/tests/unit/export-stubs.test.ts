/* Task 7.2 steps 3–5: init contract, TS-throws contract, frame/stack roots
 * (plan.md §10).
 *
 * The header half of the contract (init/last-error declarations, UB-before-init comment)
 * is pinned in `export-header.test.ts`; this file pins the OBJECT half. Mapping and frame
 * discipline run in-process against `emitC` with a library unit (no toolchain); the Check's
 * shape — init→call→error through a real C `main()` linked against the object — runs behind
 * NATIVE_ONLY. The C harness here is unit-level, not CI: the CI example is step 9's, which
 * this file must not claim (`packages/tests/ffi/run.ts` owns that stub).
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { emitC } from '../../compiler/src/codegen/index.ts';
import { collectUnitExports, renderHeader } from '../../compiler/src/frontend/export.ts';
import type { Module } from '../../compiler/src/hir/nodes.ts';
import { verifyHir } from '../../compiler/src/hir/verify.ts';
import { lowerSourceFile } from '../../compiler/src/lower/index.ts';
import { eliminateDeadCode, optimize } from '../../compiler/src/passes/index.ts';
import { staleLdRetryArgs } from '../../compiler/src/support/toolchain.ts';
import { linkConsumer } from '../support/c-runner.ts';
import {
  assertReturnsPopFrame,
  createProgram,
  lowerSource,
  NATIVE_ONLY,
  splitEmittedFunctions,
  type EmittedFunction,
} from './helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL('../../compiler/src/cli/main.ts', import.meta.url));
const RUNTIME_ROOT = join(HERE, '..', '..', 'runtime');
const RUNTIME_INCLUDE = join(RUNTIME_ROOT, 'include');
const RUNTIME_LIB_DIR = join(RUNTIME_ROOT, 'build');
const RUNTIME_ARCHIVE = join(RUNTIME_LIB_DIR, 'libjsrt.a');

/** `c-runner`'s failure hook for a vitest body: throwing fails the test with the message. */
function throwFail(message: string): never {
  throw new Error(message);
}

/** Lower `source` straight to HIR, asserting the lowering itself was clean. */
function loweredModule(source: string): Module {
  const { module, diagnostics } = lowerSource(source);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    [],
    'lowering should be clean',
  );
  assert.ok(module !== null);
  return module;
}

/** The full in-process library path: collect, lower, optimize with export roots, verify,
 * emit with the unit — the same order `compileToC` runs them in. */
function emitLibrary(source: string, unit = 'u'): { c: string; header: string } {
  const { program, sourceFile } = createProgram(source);
  const checker = program.getTypeChecker();
  const unitExports = collectUnitExports(sourceFile, checker, unit, 'ts');
  assert.deepEqual(
    unitExports.diagnostics.map((d) => d.code),
    [],
    'export collection should be clean',
  );
  const { module, diagnostics } = lowerSourceFile(sourceFile, checker);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    [],
    'lowering should be clean',
  );
  assert.ok(module !== null);
  const optimized = optimize(
    module,
    unitExports.functions.map((fn) => fn.name),
  );
  assert.deepEqual(
    verifyHir(optimized).map((p) => p.code),
    [],
    'HIR should verify clean',
  );
  return { c: emitC(optimized, { unit, exports: unitExports }), header: renderHeader(unitExports) };
}

test('the shake keeps C-visible exports nothing in the module calls', () => {
  const source =
    'export function live(): number { return 1; }\n' +
    'export function dead(): number { return 2; }\n' +
    'console.log(live());\n';
  const namesOf = (module: Module): string[] =>
    module.statements
      .filter((stmt) => stmt.kind === 'function-declaration')
      .map((stmt) => (stmt.kind === 'function-declaration' ? stmt.name : ''));
  // Without roots the uncalled export shakes away, like any unreachable function.
  assert.deepEqual(namesOf(eliminateDeadCode(loweredModule(source))), ['live']);
  // With the export roots the build passes, it and whatever it calls survive.
  assert.deepEqual(namesOf(eliminateDeadCode(loweredModule(source), ['dead'])), ['live', 'dead']);
});

test('the library object has init instead of main, with the guard set before jsrt_init', () => {
  const { c } = emitLibrary(
    'export function add(a: number, b: number): number { return a + b; }\n',
  );
  assert.ok(!c.includes('int main('), 'a unit exposed to C has no main');
  assert.ok(c.includes('void stator_u_init(void) {'));
  assert.ok(c.includes('static bool _stator_u_initialized = false;'));
  const guardSet = c.indexOf('_stator_u_initialized = true;');
  const initCall = c.indexOf('jsrt_init();');
  const globalsEnter = c.indexOf('JSRT_GLOBALS_ENTER(');
  assert.ok(guardSet !== -1 && initCall !== -1 && globalsEnter !== -1);
  // Set-before: a second GLOBALS_ENTER would wipe every global, so the guard commits first.
  assert.ok(guardSet < initCall && initCall < globalsEnter);
  // One extra global past the module's own: the scratch the init stash and the last
  // jsrt_value result share.
  assert.ok(c.includes('JSRT_GLOBALS(2);'));
  assert.ok(c.includes('JSRT_GLOBALS_ENTER(2);'));
});

test('a top-level throw in init lands in the error cell instead of exiting', () => {
  const { c } = emitLibrary(
    'export function add(a: number, b: number): number { return a + b; }\n' +
      'if (add(1, 1) !== 2) { throw new Error("unreachable"); }\n' +
      'throw new Error("top");\n',
  );
  assert.ok(c.includes('_jsrt_unwind: ;'));
  assert.ok(c.includes('jsrt_take_exception();'));
  assert.ok(c.includes('_stator_u_error_capture('));
  assert.ok(!c.includes('jsrt_uncaught();'), 'a library never exits its host');
});

test('stubs convert, call through the global, and answer sentinels on the error path', () => {
  const { c } = emitLibrary(
    'export function add(a: number, b: number): number { return a + b; }\n' +
      'export function done(x: number): void {}\n' +
      'export function flag(x: number): boolean { return x > 0; }\n' +
      'export function get(key: string): unknown { return key; }\n',
  );
  // In-table scalars stay unboxed at the boundary; anything else crosses as jsrt_value.
  assert.ok(c.includes('JSRT_LOCAL(0) = jsrt_number(a);'));
  assert.ok(c.includes('double _jsrt_ret = jsrt_to_number(JSRT_LOCAL(2));'));
  assert.ok(c.includes('jsrt_value _jsrt_ret = JSRT_GLOBAL(4) = JSRT_LOCAL(1);'));
  // Every stub clears the cell on entry, funnels every throw through one epilogue, and
  // pops on both exits; the sentinel is per C spelling, never one shared zero.
  for (const stub of ['stator_u_add', 'stator_u_done', 'stator_u_flag', 'stator_u_get']) {
    const at = c.indexOf(`${stub}(`);
    assert.ok(at !== -1, `expected a stub for ${stub}`);
  }
  assert.equal(c.match(/_stator_u_error_clear\(\);/g)?.length, 4);
  assert.equal(c.match(/goto _jsrt_err;/g)?.length, 4);
  assert.ok(c.includes('return 0.0;'));
  assert.ok(c.includes('return false;'));
  assert.ok(c.includes('return JSRT_UNDEFINED;'));
  // A void stub has no answer slot and no sentinel value to get wrong.
  assert.ok(c.includes('void stator_u_done(double x) {'));
  // The error cell and its accessor: thread-local, NULL on success.
  assert.ok(c.includes('static _Thread_local char *_stator_u_last_error_msg = NULL;'));
  assert.ok(c.includes('const char *stator_u_last_error(void) {'));
});

test('a NULL CString argument is a catchable TypeError, never an assert', () => {
  const { c } = emitLibrary(
    'type CString = string & { readonly __statorCstr: "CString" };\n' +
      'export function size(s: CString): number { return 0; }\n',
  );
  assert.ok(c.includes('if (s == NULL) {'));
  assert.ok(c.includes('jsrt_throw_error(&jsrt_class_type_error,'));
  assert.ok(c.includes('JSRT_LOCAL(0) = jsrt_string_from_cstr(s);'));
});

test('exported consts are defined mutable and stored by init from their globals', () => {
  const { c } = emitLibrary(
    'export const VERSION: number = 1;\nexport const NAME = "s";\nconsole.log(VERSION);\n',
  );
  assert.ok(c.includes('double stator_u_VERSION;'));
  assert.ok(c.includes('jsrt_value stator_u_NAME;'));
  assert.ok(c.includes('stator_u_VERSION = jsrt_to_number(JSRT_GLOBAL('));
  assert.ok(c.includes('stator_u_NAME = JSRT_GLOBAL('));
  // Stored after the body ran: the store must follow the statements, not precede them.
  assert.ok(c.indexOf('jsrt_print(') < c.indexOf('stator_u_VERSION = '));
});

test('the header declares init first, then the error cell, then the stubs', () => {
  const { header } = emitLibrary(
    'export function add(a: number, b: number): number { return a + b; }\n',
  );
  const init = header.indexOf('void stator_u_init(void);');
  const lastError = header.indexOf('const char *stator_u_last_error(void);');
  const stub = header.indexOf('double stator_u_add(double a, double b);');
  assert.ok(init !== -1 && lastError !== -1 && stub !== -1);
  assert.ok(init < lastError && lastError < stub);
  assert.ok(header.includes('calling an exported'));
  assert.ok(header.includes('function first is undefined behavior.'));
});

test('the same library input emits byte-identical C across runs', () => {
  const source =
    'export function add(a: number, b: number): number { return a + b; }\n' +
    'export const VERSION: number = 1;\n';
  assert.equal(emitLibrary(source, 'widget').c, emitLibrary(source, 'widget').c);
});

/* The library symbols — init, stubs, and the error helpers — out of the emitted C, on
 * the same walk the shadow-frame audit uses. */
function functionsIn(c: string): EmittedFunction[] {
  return splitEmittedFunctions(c, (line) => {
    const start = /^(?:.*\s)?(stator_u_\w+|_stator_u_\w+)\(/.exec(line);
    return start?.[1];
  });
}

test('every stub frame roots exactly what the stub writes and pops on every exit', () => {
  const { c } = emitLibrary(
    'export function add(a: number, b: number): number { return a + b; }\n' +
      'export function done(x: number): void {}\n' +
      'export function get(key: string): unknown { return key; }\n',
  );
  const stubs = functionsIn(c).filter((fn) => !fn.name.startsWith('_stator_u_'));
  assert.ok(stubs.length >= 3, `expected the stubs, got ${stubs.map((s) => s.name).join(', ')}`);
  for (const stub of stubs) {
    if (stub.name === 'stator_u_init' || stub.name === 'stator_u_last_error') {
      continue;
    }
    const frame = /JSRT_FRAME\((\d+)\)/.exec(stub.body);
    assert.ok(frame !== null && frame[1] !== undefined, `${stub.name} has no frame`);
    const size = Number(frame[1]);
    const used = [...stub.body.matchAll(/JSRT_LOCAL\((\d+)\)/g)].map((m) => Number(m[1]));
    for (const slot of used) {
      assert.ok(
        slot < size,
        `${stub.name} writes JSRT_LOCAL(${String(slot)}) past a frame of ${String(size)}`,
      );
    }
    // Every `return` pops first: the normal answer and the sentinel path alike.
    assertReturnsPopFrame(stub.body, stub.name);
  }
});

const STUB_FIXTURE =
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
  'export function boom(x: number): number {\n  if (x < 0) {\n    throw new Error("neg");\n  }\n  return x;\n}\n' +
  'export function done(x: number): void {\n  console.log(x);\n}\n' +
  'type CString = string & { readonly __statorCstr: "CString" };\n' +
  'export function exclaim(s: CString): CString {\n  return (s + "!") as CString;\n}\n' +
  'type db = { readonly __brand: "sqlite3" };\n' +
  'export function count(h: db): number {\n  return 1;\n}\n' +
  'export function ident(x: unknown): unknown {\n  return x;\n}\n' +
  'export const VERSION: number = 3;\n' +
  'export const ON: boolean = true;\n' +
  'export const TAG: CString = "v1" as CString;\n' +
  'export const NOTHING: null = null;\n' +
  'let base = 0;\n' +
  'base = 40;\n' +
  'export function answer(): number {\n  return base + 2;\n}\n' +
  'console.log("init-side-effect");\n';

const STUB_MAIN = (headerName: string): string =>
  '#include "' +
  headerName +
  '"\n' +
  '\n' +
  '#include <assert.h>\n' +
  '#include <stdbool.h>\n' +
  '#include <stdio.h>\n' +
  '#include <stdlib.h>\n' +
  '#include <string.h>\n' +
  '\n' +
  'int main(void) {\n' +
  '  stator_widget_init();\n' +
  '  stator_widget_init();\n' +
  '  assert(stator_widget_last_error() == NULL);\n' +
  '  assert(stator_widget_add(40.0, 2.0) == 42.0);\n' +
  '  assert(stator_widget_last_error() == NULL);\n' +
  '  assert(stator_widget_answer() == 42.0);\n' +
  '  assert(stator_widget_VERSION == 3.0);\n' +
  '  assert(stator_widget_ON == true);\n' +
  '  assert(stator_widget_boom(-1.0) == 0.0);\n' +
  '  const char *err = stator_widget_last_error();\n' +
  '  assert(err != NULL);\n' +
  '  printf("captured: %s\\n", err);\n' +
  '  assert(strstr(err, "neg") != NULL);\n' +
  '  assert(stator_widget_boom(7.0) == 7.0);\n' +
  '  assert(stator_widget_last_error() == NULL);\n' +
  '  char *loud = (char *)stator_widget_exclaim("hey");\n' +
  '  assert(loud != NULL);\n' +
  '  assert(strcmp(loud, "hey!") == 0);\n' +
  '  free(loud);\n' +
  '  assert(stator_widget_exclaim(NULL) == NULL);\n' +
  '  assert(strstr(stator_widget_last_error(), "NULL") != NULL);\n' +
  '  assert(stator_widget_count((void *)0x1234) == 1.0);\n' +
  '  assert(stator_widget_count(NULL) == 1.0);\n' +
  '  assert(strcmp(stator_widget_TAG, "v1") == 0);\n' +
  '  assert(stator_widget_ident(stator_widget_NOTHING) == stator_widget_NOTHING);\n' +
  '  stator_widget_done(9.0);\n' +
  '  assert(stator_widget_last_error() == NULL);\n' +
  '  printf("ffi-stubs ok\\n");\n' +
  '  return 0;\n' +
  '}\n';

/** The archive's own system dependencies, recorded beside it by the just recipe that built
 * it — the same flags `linkExecutable` reads, so this hand link is the link a user gets. */
function archiveSystemFlags(): string[] {
  const recorded = join(RUNTIME_LIB_DIR, 'link-flags.txt');
  assert.ok(
    existsSync(recorded),
    `runtime archive flags missing at ${recorded} — run the runtime recipe first`,
  );
  const flags = readFileSync(recorded, 'utf8').trim();
  return flags === '' ? [] : flags.split(/\s+/);
}

test('exported fallible and infallible functions callable through the header', NATIVE_ONLY, () => {
  assert.ok(existsSync(RUNTIME_ARCHIVE), `runtime archive missing at ${RUNTIME_ARCHIVE}`);
  const work = mkdtempSync(join(tmpdir(), 'stator-export-stubs-'));
  try {
    const entry = join(work, 'widget.ts');
    const headerPath = join(work, 'widget.h');
    const out = join(work, 'widget.o');
    writeFileSync(entry, STUB_FIXTURE);
    const build = spawnSync(
      process.execPath,
      [CLI, 'build', entry, '-o', out, '--emit-header', headerPath, '--unit-name', 'widget'],
      { encoding: 'utf8' },
    );
    assert.equal(build.status, 0, `build failed:\n${build.stdout}${build.stderr}`);
    const mainPath = join(work, 'main.c');
    writeFileSync(mainPath, STUB_MAIN('widget.h'));
    const app = join(work, 'app');
    const linkArgs: string[] = [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      RUNTIME_INCLUDE,
      '-I',
      work,
      mainPath,
      out,
      '-L',
      RUNTIME_LIB_DIR,
      '-ljsrt',
      ...archiveSystemFlags(),
      '-o',
      app,
    ];
    // The consumer-side link shares the CLI's stale-linker retry (a stale bundled ld
    // against a newer Xcode SDK fails here exactly as in `build.ts` link()): one retry
    // under the newest readable CLT SDK, then the original failure stands.
    let link = spawnSync('clang', linkArgs, { encoding: 'utf8' });
    const retry = staleLdRetryArgs(linkArgs, link.stderr, {
      darwin: process.platform === 'darwin',
      defaultCc: true,
      sanitized: false,
    });
    if (link.status !== 0 && retry !== undefined) {
      link = spawnSync('clang', retry.args, { encoding: 'utf8' });
    }
    assert.equal(link.status, 0, `link failed:\n${link.stdout}${link.stderr}`);
    const run = spawnSync(app, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, `run failed:\n${run.stdout}${run.stderr}`);
    assert.equal(run.stdout, 'init-side-effect\ncaptured: Error: neg\n9\nffi-stubs ok\n');
    assert.equal(run.stderr, '');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/** A unit that keeps what it allocates: every string `grow` pushes must still read back after
 * the collections between calls, so a lost root shows up as a wrong count, not a pass. */
const KEEPER = (tag: string): string =>
  'const kept: string[] = [];\n' +
  'export function grow(n: number): number {\n' +
  '  for (let i = 0; i < n; i++) {\n' +
  `    kept.push('${tag}' + String(kept.length));\n` +
  '  }\n' +
  '  return kept.length;\n' +
  '}\n' +
  'export function check(): number {\n' +
  '  let total = 0;\n' +
  '  for (let i = 0; i < kept.length; i++) {\n' +
  `    if (kept[i] === '${tag}' + String(i)) {\n` +
  '      total = total + 1;\n' +
  '    }\n' +
  '  }\n' +
  '  return total;\n' +
  '}\n';

const TWO_UNITS_MAIN =
  '#include "ka.h"\n' +
  '#include "kb.h"\n' +
  '#include <stdio.h>\n' +
  // Both units share one libjsrt.a here, so its collection entry point is a global symbol.
  'void jsrt_gc_collect(void);\n' +
  '#define COLLECT() jsrt_gc_collect()\n' +
  'int main(void) {\n' +
  '  stator_ka_init();\n' +
  '  stator_kb_init();\n' +
  '  for (int round = 0; round < 10; round++) {\n' +
  '    stator_ka_grow(500.0);\n' +
  '    COLLECT();\n' +
  '    stator_kb_grow(500.0);\n' +
  '    COLLECT();\n' +
  '  }\n' +
  '  printf("a=%g b=%g\\n", stator_ka_check(), stator_kb_check());\n' +
  '  return 0;\n' +
  '}\n';

// plan-notes 341: each unit's init calls jsrt_init, and a second jsrt_gc_init used to install the
// roots hook as its own predecessor, so the first collection recursed until the stack overflowed.
test('two --emit-header units share one libjsrt.a across forced collections', NATIVE_ONLY, () => {
  assert.ok(existsSync(RUNTIME_ARCHIVE), `runtime archive missing at ${RUNTIME_ARCHIVE}`);
  const work = mkdtempSync(join(tmpdir(), 'stator-two-units-'));
  try {
    const objects: string[] = [];
    for (const unit of ['ka', 'kb']) {
      const entry = join(work, `${unit}.ts`);
      const out = join(work, `${unit}.o`);
      writeFileSync(entry, KEEPER(unit));
      const build = spawnSync(
        process.execPath,
        [CLI, 'build', entry, '-o', out, `--emit-header=${join(work, `${unit}.h`)}`],
        { encoding: 'utf8' },
      );
      assert.equal(build.status, 0, `build ${unit} failed:\n${build.stdout}${build.stderr}`);
      objects.push(out);
    }
    const mainPath = join(work, 'main.c');
    writeFileSync(mainPath, TWO_UNITS_MAIN);
    const sysFlags = archiveSystemFlags();
    const app = join(work, 'app');
    linkConsumer(
      'clang',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I',
        work,
        mainPath,
        ...objects,
        '-L',
        RUNTIME_LIB_DIR,
        '-ljsrt',
        ...sysFlags,
        '-o',
        app,
      ],
      throwFail,
    );
    const run = spawnSync(app, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, `run failed (signal ${String(run.signal)}):\n${run.stderr}`);
    assert.equal(run.stdout, 'a=5000 b=5000\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
