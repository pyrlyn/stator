/** The build driver: source -> program -> gate -> HIR -> C -> clang -> executable (plan.md §5
 * Task 2.4).
 *
 * Everything policy-shaped lives above this file. The driver's own job is only sequencing and
 * process control, and it stops at the FIRST stage that produced diagnostics: continuing past a
 * rejected gate would hand the lowering source it already refused, and every diagnostic after that
 * would be a consequence of the first one rather than a fact about the program.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { emitC, type LibraryEmit } from '../codegen/index.ts';
import { collectLinkFlags } from '../frontend/extern.ts';
import {
  collectUnitExports,
  defaultUnitName,
  exportSymbols,
  exportVersionDefinition,
  renderHeader,
  sanitizeUnitName,
} from '../frontend/export.ts';
import { gateProgram } from '../frontend/gate.ts';
import { moduleOrder } from '../frontend/graph.ts';
import { isStdSourceFile, STD_ROOT } from '../frontend/std.ts';
import { verifyHir } from '../hir/verify.ts';
import { optimize } from '../passes/index.ts';
import { BuildError, type Diagnostic } from '../support/diagnostics.ts';
import { type RuntimeFlavor, runtimeFlavor, withRuntimeFlavor } from '../support/features.ts';
import { packageRoot } from '../support/package-root.ts';
import { addStageTime, runStageTimings, withSpan, withSpanAsync } from '../support/telemetry.ts';
import {
  partitionTranslationUnit,
  resolveCompileJobs,
  shouldSplitTranslationUnit,
} from './compile-jobs.ts';
import { isStaleLdSystemLibFailure, staleLdHint, staleLdRetryArgs } from '../support/toolchain.ts';
import {
  type BundlerChoice,
  DEFAULT_BUNDLER,
  loadFrontend,
  lowerFrontend,
  reportedDiagnostics,
} from './bundler.ts';
import { type NamedPath, refuseAliasedOutputs, requireWritable, writeOutput } from './outputs.ts';
import { diagnosticLines, INK_COLORS, print, type Line } from './render.ts';
import { libraryName, objectFormat, pkgConfigPath, writeStaticLibrary } from './library.ts';

type Mode = 'ts' | 'js';

export type OptLevel = 0 | 1 | 2 | 3;

export interface BuildOptions {
  readonly entry: string;
  readonly out: string;
  readonly mode: Mode;
  /** Stop after writing C to `out` instead of invoking the C compiler. */
  readonly emitCOnly: boolean;
  /** Keep the intermediate .c next to the executable instead of deleting it. */
  readonly keepC: boolean;
  /** clang `-O` for the final link when not under ASan. Default 2; CLI `--opt` / `STATOR_OPT`
   * override. `0` trades runtime speed for faster iterate compiles. How many clang processes
   * compile the generated C is `STATOR_COMPILE_JOBS`, not this knob (plan.md §11b T10.3). */
  readonly opt?: OptLevel;
  /** Extra clang link flags from the CLI `--link=` escape hatch (docs/FFI.md §9), in
   * command-line order. The `.d.ts` `@statorLink` pragma flags travel inside the compiled
   * result instead — see `compileToC` — and the link deduplicates libraries across all three
   * sources while preserving order. Accepted but inert with `--emit-header`: nothing links,
   * so there is no line to join (docs/FFI.md §8). Under `--emit=lib` they join the `.pc`. */
  readonly linkFlags?: readonly string[];
  /** Write a C header for the unit's exports to this path (docs/FFI.md §8, plan §10 Task 7.2
   * steps 1–2) and compile a relocatable object instead of linking an executable: a unit
   * exposed to C usually has no `main`, and linking is the consumer's job. Export refusals
   * (STA1122–STA1124) stop the build before anything is written. */
  readonly emitHeader?: string;
  /** `--emit=lib` (plan §10 Task 7.4, docs/FFI.md §8): with `emitHeader`, `out` is
   * `lib<name>.a` — the unit prelinked with a private runtime — and `lib<name>.pc` is written
   * beside it. Without `emitHeader` it is STA0004. */
  readonly emitLib?: boolean;
  /** `--unit-name` override for the `stator_<unit>_<name>` mangling; defaults to the entry's
   * file basename, sanitized to a C identifier. An explicit name must already be one
   * (`^[A-Za-z0-9_]+$`), else STA0004. */
  readonly unitName?: string;
  /** `js` mode: the bundler for package imports and CommonJS project files (docs/BUNDLER.md
   * §5). Default `vite`; it loads only when the graph needs it. */
  readonly bundler?: BundlerChoice;
  /** `--node`: the Node platform (plan.md §11c T11.5, docs/MODES.md §6). Node built-ins resolve
   * to `packages/node`; a frontend policy, like the mode. */
  readonly node?: boolean;
  /** In-process seam for `STATOR_COMPILE_JOBS`. The CLI leaves it unset. */
  readonly compileJobs?: number;
}

export { BuildError };

/** A thrown value is not necessarily an `Error` (`throw "boom"` is legal JavaScript, and a
 * rejection from a dependency can be anything). The diagnostic still has to say something. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** STA4072's message without the `stator: STA4072 ` prefix the CLI adds at print time. Shared by
 * the CLI's catch-all (`src/cli/main.ts`) and `compileToC` below, so an escaping exception reads
 * the same however the compiler was invoked — CLI spawn or in-process (the Test262 runner never
 * passes through `main()`). */
export function internalErrorMessage(error: unknown): string {
  return `internal error: ${messageOf(error)} — this is a compiler bug; report it with the input that triggered it`;
}

/** Per-async-context sink for diagnostics when several builds share one process.
 *
 * test262 used to spawn a fresh `node …/cli/main.ts build` per test (~0.4–1.2s) just to keep
 * stderr isolated. In-process `build()` is ~100–160ms, but concurrent builds must not interleave
 * ink frames on the shared stderr — and must not pay ink's ~1.6s first-import cost on every
 * diagnostic either. When a capture store is set, emitters append plain `diagnosticLines` text;
 * otherwise the CLI keeps printing through ink to stderr.
 */
interface DiagnosticCapture {
  readonly lines: string[];
  /** The same diagnostics, structured, for `statorc/api`. */
  readonly diagnostics: Diagnostic[];
}

const diagnosticCapture = new AsyncLocalStorage<DiagnosticCapture>();

/** Run `fn` with diagnostics captured as plain text (no ink). */
export async function withDiagnosticCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string; diagnostics: readonly Diagnostic[] }> {
  const store: DiagnosticCapture = { lines: [], diagnostics: [] };
  const result = await diagnosticCapture.run(store, fn);
  return { result, stderr: store.lines.join(''), diagnostics: store.diagnostics };
}

/** Route diagnostic lines to the capture store when set, else ink → stderr. */
async function emitDiagnosticLines(lines: readonly Line[]): Promise<void> {
  const store = diagnosticCapture.getStore();
  if (store !== undefined) {
    // Empty is a no-op, matching `print`: capturing nothing must cost nothing.
    if (lines.length === 0) {
      return;
    }
    store.lines.push(`${lines.map((line) => line.text).join('\n')}\n`);
    return;
  }
  await print(lines, process.stderr);
}

const RUNTIME_DIR_OF = { default: 'build', asan: 'build-asan', intl: 'build-intl' } as const;
const RUNTIME_JUST_RECIPE = {
  default: 'runtime',
  asan: 'runtime-asan',
  intl: 'runtime-intl',
} as const;

/** The runtime one build compiles and links against. Resolved once per `build()` call, never at
 * module load: the CLI applies `.env` after its imports run, and an in-process caller may set
 * `STATOR_RUNTIME` around one build, so a value frozen at import time would link one flavor
 * while the gate admitted another (plan.md §9 Task 6.21, QA audit F3).
 *
 * The C runtime (headers + built archive) is a sibling package (`support/package-root.ts`);
 * `STATOR_RUNTIME_ROOT` overrides the layout, and a wrong guess is caught at link time (missing
 * archive). `STATOR_RUNTIME=asan` links the sanitized archive and passes the matching flags, so
 * CI can run the SAME golden fixtures under ASan/UBSan (plan.md §5 Task 2.7). The sanitizer has to
 * be on both the archive and the final link or the instrumentation is only half applied, which is
 * why one variable controls both rather than exposing a flags knob. */
export interface Runtime {
  readonly flavor: RuntimeFlavor;
  readonly sanitized: boolean;
  readonly root: string;
  readonly include: string;
  readonly libDir: string;
  readonly archive: string;
}

export function resolveRuntime(): Runtime {
  const flavor = runtimeFlavor();
  const root = packageRoot('STATOR_RUNTIME_ROOT', 'runtime', 'include');
  const libDir = join(root, RUNTIME_DIR_OF[flavor]);
  return {
    flavor,
    sanitized: flavor === 'asan',
    root,
    include: join(root, 'include'),
    libDir,
    archive: join(libDir, 'libjsrt.a'),
  };
}
/** The std backings (plan.md §11c T11.2): one archive for every runtime flavor — ReleaseSafe Zig
 * over libc, with no dependency on libjsrt.a (packages/std/justfile). Linked only into a program
 * whose module graph holds a std file. */
const STD_ARCHIVE = join(STD_ROOT, 'build', 'libjsrt_std.a');
const SANITIZER_FLAGS = ['-O1', '-g', '-fsanitize=address,undefined'];

/** What a program linking this archive must pass — Boehm's `-lgc` when the runtime was built
 * against it, ICU's when the archive is the feature build, `-flto=thin` when its objects are
 * bitcode (plan-notes 162) — written next to the archive by the just recipe that produced it.
 * Reading them back is the only way this link cannot disagree with the objects it links:
 * rediscovering them here would ask `pkg-config` a second time, in a different environment, and
 * an archive compiled WITH Boehm linked WITHOUT `-lgc` is an undefined-symbol error at the end of
 * every compile (plan-notes 106). The flags go on the one clang call below, so `-flto` also turns
 * the generated C into bitcode and the runtime inlines into it. Absent means an archive built
 * before the recipe wrote one; the link then fails the way it always did, which is the honest
 * outcome. */
function extraLinkFlags(runtime: Runtime): string[] {
  const recorded = join(runtime.libDir, 'link-flags.txt');
  if (!existsSync(recorded)) {
    return [];
  }
  const flags = readFileSync(recorded, 'utf8').trim();
  return flags === '' ? [] : flags.split(/\s+/);
}

/** An explicit `--unit-name` is refused rather than sanitized: the mangling is not injective
 * (`my-lib` and `my_lib` would share every symbol), so only a name that is already safe can be
 * the user's. The default, derived from a file name the user did not choose for C, is sanitized. */
const UNIT_NAME = /^[A-Za-z0-9_]+$/;

/** Returns the process exit code: 0 on success, 1 if the program was rejected. */
export async function build(options: BuildOptions): Promise<number> {
  // Off unless asked: the store and the stderr line are the T10.3 measurement,
  // not part of a normal build's output.
  if (process.env['STATOR_COMPILE_TIMING'] === undefined) {
    return runBuild(options);
  }
  return runStageTimings(() => runBuild(options));
}

async function runBuild(options: BuildOptions): Promise<number> {
  const jobs = demandCompileJobs(options.compileJobs);
  if (options.unitName !== undefined && !UNIT_NAME.test(options.unitName)) {
    throw new BuildError(
      'STA0004',
      `unit name "${options.unitName}" (--unit-name, config "unitName") may hold only letters, ` +
        'digits and _ — it becomes part of every exported C symbol',
    );
  }
  const lib = options.emitLib === true ? libraryOutputs(options) : undefined;
  const unit =
    options.emitHeader === undefined
      ? undefined
      : (options.unitName ?? sanitizeUnitName(defaultUnitName(options.entry)));
  // Every file `build` writes, named the way its diagnostics name them. `<out>.c` is one only
  // when a C compiler runs after it and `--keep-c` keeps it.
  const out: NamedPath = { role: '-o', path: options.out };
  const header: NamedPath | undefined =
    options.emitHeader === undefined
      ? undefined
      : { role: '--emit-header', path: options.emitHeader };
  const keptC: NamedPath | undefined =
    options.keepC && !options.emitCOnly
      ? { role: 'the --keep-c file', path: `${options.out}.c` }
      : undefined;
  const outputs = [out, header, keptC, lib?.pc].filter((target) => target !== undefined);
  // Refused before compiling, so a slip like `-o app.ts` costs nothing and destroys nothing. The
  // whole program's sources are known only after the frontend; they are checked again below,
  // still before the first write.
  refuseAliasedOutputs(outputs, [{ role: 'the entry file', path: options.entry }]);
  if (!options.emitCOnly) {
    requireWritable(out);
  }
  // One resolution feeds the gate (through the pinned flavor) and the link, so the surface the
  // gate admits is the surface the linked archive carries.
  const runtime = resolveRuntime();
  const compiled = await withRuntimeFlavor(runtime.flavor, () =>
    compileToC(options.entry, options.mode, unit, options.bundler, options.node ?? false),
  );
  if (compiled === null) {
    return 1;
  }
  refuseAliasedOutputs(
    outputs,
    compiled.inputs.map((path) => ({ role: 'a source file of the program', path })),
  );

  if (options.emitCOnly) {
    writeOutput(out, compiled.c);
    if (header !== undefined) {
      writeOutput(header, compiled.header ?? '');
    }
    return 0;
  }

  if (header !== undefined) {
    if (lib !== undefined && compiled.exportSurface?.needsJsrtValue === true) {
      throw new BuildError(
        'STA1220',
        `unit "${unit ?? ''}" has an export that crosses as jsrt_value, which --emit=lib does ` +
          "not support yet: the library's runtime is private, so a consumer has no runtime API " +
          'to make or read one (docs/FFI.md §8) — keep plain C types, or use --emit-header ' +
          'without --emit=lib',
      );
    }
    writeOutput(header, compiled.header ?? '');
    // A unit exposed to C links at the consumer, not here: `clang -c`, no `-ljsrt`, no
    // extern link flags. The init, stubs, and error cell (Task 7.2 steps 3–5) are already in
    // the C; only `main` is absent, which is what makes this an object and not a program.
    // `--emit=lib` prelinks that object with the runtime instead of handing it over.
    const scratch = mkdtempSync(join(tmpdir(), 'stator-'));
    const cPath = keptC?.path ?? join(scratch, 'module.c');
    try {
      writeOutput(keptC ?? { role: 'the C file', path: cPath }, compiled.c);
      if (lib === undefined) {
        compileObject(cPath, options.out, options.opt ?? 2, runtime);
        return 0;
      }
      const object = join(scratch, 'unit.o');
      compileObject(cPath, object, options.opt ?? 2, runtime);
      requireLinkArchives(compiled.std, runtime);
      writeStaticLibrary({
        cc: selectCC(runtime),
        object,
        archives: [...(compiled.std ? [STD_ARCHIVE] : []), runtime.archive],
        symbols: compiled.exportSurface?.symbols ?? [],
        out,
        pc: lib.pc,
        header: header.path,
        unit: unit ?? '',
        libs: [
          ...(runtime.sanitized ? ['-fsanitize=address,undefined'] : []),
          ...systemLinkFlags(runtime, [...compiled.linkFlags, ...(options.linkFlags ?? [])]),
        ],
        scratch,
        format: lib.format,
        debug: runtime.sanitized,
      });
      return 0;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // The .c goes beside the executable when it is being kept, so `--keep-c` produces a file the
  // user can actually find; otherwise it lives in a temp dir that is removed on every exit path.
  const scratch = options.keepC ? null : mkdtempSync(join(tmpdir(), 'stator-'));
  const cPath = keptC?.path ?? join(scratch ?? '', 'module.c');

  try {
    writeOutput(keptC ?? { role: 'the C file', path: cPath }, compiled.c);
    // Default -O2; STATOR_OPT=0 / --opt=0 skips most clang opts for faster iterate compiles.
    // Jobs=1 keeps this one clang invocation, so the C it compiles is the text just written.
    const externFlags = [...compiled.linkFlags, ...(options.linkFlags ?? [])];
    const opt = options.opt ?? 2;
    if (shouldSplitTranslationUnit(compiled.c, jobs.jobs, jobs.explicit)) {
      const partsDir = mkdtempSync(join(tmpdir(), 'stator-jobs-'));
      try {
        await linkExecutableParallel(
          compiled.c,
          partsDir,
          options.out,
          opt,
          externFlags,
          compiled.std,
          runtime,
          compiled.flavor,
          jobs.jobs,
        );
      } finally {
        rmSync(partsDir, { recursive: true, force: true });
      }
    } else {
      linkExecutable(cPath, options.out, opt, externFlags, compiled.std, runtime, compiled.flavor);
    }
    return 0;
  } finally {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** `--emit=lib`'s refusals, before anything is compiled, and the `.pc` output it adds. */
function libraryOutputs(options: BuildOptions): {
  readonly pc: NamedPath;
  readonly format: 'macho' | 'elf';
} {
  if (options.emitHeader === undefined) {
    throw new BuildError(
      'STA0004',
      '--emit=lib requires --emit-header=<h> (config "emitHeader"): the header is the ' +
        "library's C surface",
    );
  }
  const name = libraryName(options.out);
  if (name === undefined) {
    throw new BuildError(
      'STA0004',
      `--emit=lib requires -o lib<name>.a, not "${options.out}" — the consumer links it as -l<name>`,
    );
  }
  const format = objectFormat(process.platform);
  if (format === undefined) {
    throw new BuildError(
      'STA1219',
      '--emit=lib is not yet supported on Windows (docs/FFI.md §8) — use --emit-header for ' +
        'an object, linked with the runtime archive',
    );
  }
  return {
    pc: { role: 'the --emit=lib pkg-config file', path: pkgConfigPath(options.out, name) },
    format,
  };
}

/** Source text compiled to C, plus what the link owes the extern surface: the `@statorLink`
 * flags every extern-bearing `.d.ts` contributed (docs/FFI.md §9), in program order. The CLI
 * `--link=` flags join them at the link, never here — one source per carrier. `header` is the
 * `--emit-header` text, present only when a unit name was given (Task 7.2 steps 1–2). */
export interface CompiledC {
  readonly c: string;
  readonly linkFlags: readonly string[];
  /** Whether the module graph holds a `std/*` file, so the link owes `libjsrt_std.a`. */
  readonly std: boolean;
  /** The runtime flavor the gate admitted builtins against; the link must use the same one. */
  readonly flavor: RuntimeFlavor;
  /** Every source file of the program, so `build` can refuse an output that names one. */
  readonly inputs: readonly string[];
  readonly header?: string;
  /** The unit's C symbols (`exportSymbols`) and whether any crosses as `jsrt_value`, present
   * with `header`: `--emit=lib` keeps exactly these global (plan §10 Task 7.4). */
  readonly exportSurface?: {
    readonly symbols: readonly string[];
    readonly needsJsrtValue: boolean;
  };
}

/** The pure half: source text in, C text out, diagnostics to stderr. Shared with `explain`, and
 * the only path any generated C comes from. Returns null if the program was rejected. */
export async function compileToC(
  entry: string,
  mode: Mode,
  unit?: string,
  bundler: BundlerChoice = DEFAULT_BUNDLER,
  node = false,
): Promise<CompiledC | null> {
  try {
    return await compileToCInner(entry, mode, unit, bundler, node);
  } catch (error) {
    // Diagnostics are the contract for everything the pipeline can name; an ESCAPING exception is
    // a compiler bug by AGENTS.md's definition, and its contract is STA4072, never a raw stack
    // trace. `BuildError` passes through: it already carries a code the user can act on —
    // including STA0013, the TypeScript checker's own stack overflow (plan-notes 213, 287). The
    // in-process callers (notably the Test262 runner) never pass through the CLI's catch-all, so
    // without this the whole process dies and the shard uploads no artifact.
    if (error instanceof BuildError) throw error;
    throw new BuildError('STA4072', internalErrorMessage(error));
  }
}

async function compileToCInner(
  entry: string,
  mode: Mode,
  unit: string | undefined,
  bundler: BundlerChoice,
  node: boolean,
): Promise<CompiledC | null> {
  const frontend = await loadFrontend(entry, mode, bundler, node);
  const { program } = frontend;
  // Every stage's diagnostics in the vendor module are mapped before they print (T12.1 step 5).
  const report = (diagnostics: readonly Diagnostic[]): Promise<boolean> =>
    reportDiagnostics(reportedDiagnostics(diagnostics, frontend.vendor));
  if (await report(frontend.diagnostics)) {
    return null;
  }

  // Read where the gate reads it (`intlEnabled`), so the link can check it got the same answer.
  const flavor = runtimeFlavor();
  if (await report(withSpan('frontend/gate', {}, () => gateProgram(program, mode, node)))) {
    return null;
  }

  // Mirrors createProgram's normalization: the program stores the entry under its ABSOLUTE
  // forward-slash name, whatever spelling the command line used.
  const entryFile = program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  if (entryFile === undefined) {
    throw new BuildError('STA0007', `entry file "${entry}" does not exist`);
  }

  // The C-visible set behind `--emit-header` (Task 7.2 steps 1–2): refusals stop the build
  // before the lowering, so no object or header is written for a unit C cannot see.
  let header: string | undefined;
  let library: LibraryEmit | undefined;
  let exportSurface: CompiledC['exportSurface'];
  if (unit !== undefined) {
    const unitExports = withSpan('frontend/export', {}, () =>
      collectUnitExports(entryFile, program.getTypeChecker(), unit, mode),
    );
    if (await report(unitExports.diagnostics)) {
      return null;
    }
    header = renderHeader(unitExports);
    library = { unit, exports: unitExports };
    exportSurface = {
      symbols: exportSymbols(unitExports),
      needsJsrtValue: unitExports.needsJsrtValue,
    };
  }

  // The module graph: every reachable file, dependencies first, cycles refused (STA3001). The
  // whole-program merge happens in the LOWERING -- the graph only decides membership and order.
  const { order, diagnostics: graphDiagnostics } = withSpan('frontend/module-graph', {}, () =>
    moduleOrder(program, entryFile, mode),
  );
  if (await report(graphDiagnostics)) {
    return null;
  }

  const { module, diagnostics: lowerDiagnostics } = withSpan('lower', {}, () =>
    lowerFrontend(frontend, order, mode),
  );
  if ((await report(lowerDiagnostics)) || module === null) {
    return null;
  }

  // Optimization runs BEFORE the verifier, so the verifier checks what the emitter will actually
  // see. A pass that produced ill-typed HIR would otherwise pass through a verifier that had only
  // inspected the lowering's output. A library build roots the shake at its C-visible exports:
  // nothing in the module names them, so without roots an exported-but-uncalled function would
  // be shaken away from under its own stub (plan.md §10 Task 7.2 step 3).
  const exportRoots = library === undefined ? [] : library.exports.functions.map((fn) => fn.name);
  const optimized = withSpan('passes/optimize', {}, () => optimize(module, exportRoots));

  // The verifier is not an optional debug pass: it is the only thing standing between a lowering
  // bug and silently wrong generated C, and it costs one tree walk.
  const problems = withSpan('hir/verify', {}, () => verifyHir(optimized));
  if (problems.length > 0) {
    await emitDiagnosticLines([
      ...problems.map((p) => ({
        text: `stator: ${p.code} internal error in ${p.kind}: ${p.message}`,
        color: INK_COLORS.error,
      })),
      { text: 'stator: this is a compiler bug — please report it with the input' },
    ]);
    return null;
  }

  return withSpan('codegen/emit-c', {}, () => ({
    // With `--emit-header` the object also defines the ABI-identity symbol the header
    // declares (plan §10 Task 7.2 step 7): same unit, same compiler constant, so the two
    // always agree — and a header from another build names a symbol this object lacks. The
    // init, stubs, and error cell ride `library` into the emitter, which owns the module's
    // slot layout and so is the only stage that can place them (steps 3–5).
    c: emitC(optimized, library) + (unit === undefined ? '' : exportVersionDefinition(unit)),
    linkFlags: withSpan('frontend/link-flags', {}, () => collectLinkFlags(program)),
    std: order.some((file) => isStdSourceFile(file.fileName)),
    flavor,
    inputs: program.getSourceFiles().map((file) => file.fileName),
    ...(header !== undefined && { header }),
    ...(exportSurface !== undefined && { exportSurface }),
  }));
}

/** Prints diagnostics and reports whether any of them stops the build. `not-yet` and `never` are
 * both rejections — the difference is what the user should do about it, not whether it compiles. */
async function reportDiagnostics(diagnostics: readonly Diagnostic[]): Promise<boolean> {
  diagnosticCapture.getStore()?.diagnostics.push(...diagnostics);
  await emitDiagnosticLines(diagnosticLines(diagnostics));
  return diagnostics.length > 0;
}

function demandCompileJobs(override: number | undefined): {
  readonly jobs: number;
  readonly explicit: boolean;
} {
  const resolved = resolveCompileJobs(process.env['STATOR_COMPILE_JOBS'], override);
  if (!resolved.ok) {
    throw new BuildError('STA0021', resolved.message);
  }
  return resolved;
}

function linkExecutable(
  cPath: string,
  out: string,
  opt: OptLevel,
  externFlags: readonly string[],
  std: boolean,
  runtime: Runtime,
  gateFlavor: RuntimeFlavor,
): void {
  withSpan('link/clang', {}, () => {
    link(cPath, out, opt, externFlags, std, runtime, gateFlavor);
  });
}

/** Duplicate `-l` libraries dropped, first occurrence wins, everything else verbatim in order
 * (docs/FFI.md §9): several binding files for one library each name it, and the CLI escape
 * hatch may repeat one — while a "helpful" sort, or any reordering at all, breaks static
 * archives whose order is load-bearing. Only `-l` dedups: `-L` paths and object files are
 * idempotent to repeat, and grouping flags (`-Wl,--start-group` … `--end-group`) pass
 * through untouched for the rare circular archive. */
export function dedupLinkLibs(flags: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const flag of flags) {
    if (flag.startsWith('-l') && flag.length > 2) {
      if (seen.has(flag)) {
        continue;
      }
      seen.add(flag);
    }
    kept.push(flag);
  }
  return kept;
}

// conda-clang 21.1.8's Darwin ASan runtime deadlocks during dyld's early malloc
// initialization on the current macOS host. Match justfile's sanitizer fallback so the
// generated golden binaries use the same compiler as the sanitized runtime archive. An
// explicit compiler-path CC remains authoritative for callers testing another toolchain.
// Exported for the `--emit=lib` consumer test, whose link must use the same compiler.
export function selectCC(runtime: Runtime): string {
  return (
    process.env['CC'] ??
    (runtime.sanitized && process.platform === 'darwin' && existsSync('/usr/bin/clang')
      ? '/usr/bin/clang'
      : 'clang')
  );
}

/** The two clang failures that mean the same thing however clang was invoked: a missing
 * toolchain (STA0008 — the one build failure with an actionable fix and a per-platform
 * install hint) and a spawn that died before compiling (STA0009). A nonzero EXIT is the
 * caller's to interpret — the link names its extern flags there, the object compile reports
 * a compiler bug — so this answers only the start. Returns undefined when clang ran. */
function clangStartError(cc: string, result: { error?: unknown }): BuildError | undefined {
  const { error } = result;
  if (
    error !== undefined &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    return new BuildError(
      'STA0008',
      `C compiler "${cc}" not found — install clang ` +
        '(`mise install`, or macOS: `xcode-select --install`; Debian/Ubuntu: `apt install clang`) or set `CC`',
    );
  }
  if (error !== undefined) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    return new BuildError('STA0009', `C compiler failed to start${detail}`);
  }
  return undefined;
}

/** One place owning how clang runs: inherited stdio, so a failing compile shows its own
 * errors rather than routing them through a diagnostic. */
function runClang(cc: string, args: readonly string[]) {
  return spawnSync(cc, args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

interface CapturedClang {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: unknown;
}

/** The link's private runner: captured, so a failure can be classified before anything is
 * printed. Callers replay `stdout`/`stderr` on failure, which keeps the terminal output
 * identical to the inherited-stdio form — buffered rather than live, but byte-identical. */
function runClangCaptured(cc: string, args: readonly string[]): CapturedClang {
  const result = spawnSync(cc, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/** The parallel path's runner. `spawnSync` would serialize the pool; a captured
 * child keeps one failure's text identical to `runClangCaptured` and lets the
 * other units keep compiling. */
function runClangAsync(cc: string, args: readonly string[]): Promise<CapturedClang> {
  return new Promise((resolve) => {
    const child = spawn(cc, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = child.stdout;
    const err = child.stderr;
    let settled = false;
    let spawnError: unknown;
    const finish = (status: number | null, error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, stdout: stdout.join(''), stderr: stderr.join(''), error });
    };
    if (out === null || err === null) {
      finish(null, new Error('clang stdio was not piped'));
      return;
    }
    out.setEncoding('utf8');
    err.setEncoding('utf8');
    out.on('data', (chunk: string) => {
      stdout.push(chunk);
    });
    err.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    // 'error' is not always followed by a useful status. Record it, and also
    // finish here so a spawn that never closes cannot hang the build.
    child.on('error', (error) => {
      spawnError = error;
      finish(null, error);
    });
    child.on('close', (status) => {
      finish(status, spawnError);
    });
  });
}

/** At most `limit` tasks at once. The first failure is the one rethrown, after
 * the tasks already running have finished — clang children are not left behind. */
async function runPool(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  if (tasks.length === 0) {
    return;
  }
  let cursor = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) {
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) {
        return;
      }
      const task = tasks[index];
      if (task === undefined) {
        return;
      }
      try {
        await task();
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure !== undefined) {
    throw failure;
  }
}

/** Compile generated C to a relocatable object for a C consumer (`--emit-header`, plan §10
 * Task 7.2 step 1): `clang -c`, so `-o` names an object, not an executable. No archive, no
 * link flags — linking is the consumer's job once steps 3–5 emit the stubs and the init. */
function compileObject(cPath: string, out: string, opt: OptLevel, runtime: Runtime): void {
  const cc = selectCC(runtime);
  const result = runClang(cc, [
    '-std=c11',
    ...(runtime.sanitized ? SANITIZER_FLAGS : [`-O${String(opt)}`]),
    '-I',
    runtime.include,
    '-c',
    cPath,
    '-o',
    out,
  ]);
  const startError = clangStartError(cc, result);
  if (startError !== undefined) {
    throw startError;
  }
  if (result.status !== 0) {
    throw new BuildError(
      'STA0009',
      `C compiler failed (exit ${result.status ?? 'signal'}) — this is a compiler bug; ` +
        'keep the C with `--keep-c` and report it',
    );
  }
  requireProduced(cc, out);
}

/** A zero exit is not proof of an output: a `CC` that is not clang (or a wrapper that swallows
 * the call) can succeed and write nothing, and `build` must not report success for a file that
 * is not there (QA audit F4). */
function requireProduced(cc: string, out: string): void {
  if (!existsSync(out)) {
    throw new BuildError(
      'STA0009',
      `C compiler "${cc}" exited 0 but wrote no "${out}" — check that CC names a working clang`,
    );
  }
}

/** The clang link line, pure so a test can read it: the generated C, `libjsrt_std.a` exactly
 * when the program imports `std/*` (plan.md §11c T11.2 Check), the runtime archive, the
 * recorded and extern flags. Exported for that test only. */
export function linkArguments(
  cPath: string,
  out: string,
  opt: OptLevel,
  externFlags: readonly string[],
  std: boolean,
  runtime: Runtime = resolveRuntime(),
): string[] {
  // Tree-shaking builtins (plan.md Task 3.12): builtins live in libjsrt.a, and the archive links
  // at .o granularity -- one referenced symbol drags in every builtin its object file holds. The
  // linker's dead-stripping restores function granularity: a builtin the program never references
  // is not in the binary. Mach-O strips per-symbol out of the box; ELF needs the sections split at
  // compile time (the justfile does the same for the archive's own objects). Sanitized
  // builds skip it -- ASan's global registration arrays are exactly the kind of unreferenced
  // section --gc-sections is documented to break.
  const shakeFlags = runtime.sanitized
    ? []
    : process.platform === 'darwin'
      ? ['-Wl,-dead_strip']
      : ['-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections'];
  return [
    '-std=c11',
    ...(runtime.sanitized ? SANITIZER_FLAGS : [`-O${String(opt)}`]),
    ...shakeFlags,
    '-I',
    runtime.include,
    cPath,
    // The std archive before the runtime's, though neither depends on the other: the order a
    // static link reads archives is load-bearing in general, and fixing it here keeps it stable.
    ...(std ? [STD_ARCHIVE] : []),
    '-L',
    runtime.libDir,
    '-ljsrt',
    // The archive states its own system dependencies in `link-flags.txt` (SYS_LIBS, plan-notes
    // 122). Repeating one here is not a safety net -- it made every link warn about a duplicate.
    // Extern surface flags last, in carrier order (pragma files in program order, then the CLI
    // escape hatch), duplicates dropped first-wins: dependents precede their dependencies.
    ...systemLinkFlags(runtime, externFlags),
    '-o',
    out,
  ];
}

/** What a link owes beyond the archives: the runtime's recorded system flags, then the extern
 * surface's, deduplicated. The binary link and the `--emit=lib` `.pc` file both read it, so a
 * library's consumer links exactly what the binary would have (plan §10 Task 7.4 step 2). */
function systemLinkFlags(runtime: Runtime, externFlags: readonly string[]): string[] {
  return dedupLinkLibs([...extraLinkFlags(runtime), ...externFlags]);
}

/** STA0011 for a missing archive (the runtime's, or the std library's for a `std/*` importer),
 * naming the just recipe that builds it. */
function requireArchive(
  what: 'runtime' | 'std',
  archive: string,
  root: string,
  recipe: string,
): void {
  if (!existsSync(archive)) {
    throw new BuildError(
      'STA0011',
      `${what} archive not found at ${archive} — run \`just -f ${join(root, 'justfile')} -d ${root} ${recipe}\``,
    );
  }
}

/** The archives a link (or a `--emit=lib` prelink) reads: the runtime's, and the std library's
 * for a `std/*` importer. */
function requireLinkArchives(std: boolean, runtime: Runtime): void {
  requireArchive('runtime', runtime.archive, runtime.root, RUNTIME_JUST_RECIPE[runtime.flavor]);
  if (std) {
    requireArchive('std', STD_ARCHIVE, STD_ROOT, 'std');
  }
}

function link(
  cPath: string,
  out: string,
  opt: OptLevel,
  externFlags: readonly string[],
  std: boolean,
  runtime: Runtime,
  gateFlavor: RuntimeFlavor,
): void {
  assertLinkFlavor(runtime, gateFlavor);
  requireLinkArchives(std, runtime);
  // conda-clang 21.1.8's Darwin ASan runtime deadlocks during dyld's early malloc
  // initialization on the current macOS host (see selectCC above).
  finishClang(
    selectCC(runtime),
    linkArguments(cPath, out, opt, externFlags, std, runtime),
    out,
    externFlags,
    runtime,
  );
}

/** Jobs > 1: one clang -c per unit, then one link of the objects. The canonical
 * C text is already on disk for `--keep-c`; these files exist only for clang. */
async function linkExecutableParallel(
  c: string,
  dir: string,
  out: string,
  opt: OptLevel,
  externFlags: readonly string[],
  std: boolean,
  runtime: Runtime,
  gateFlavor: RuntimeFlavor,
  jobs: number,
): Promise<void> {
  assertLinkFlavor(runtime, gateFlavor);
  requireLinkArchives(std, runtime);
  const parts = partitionTranslationUnit(c, jobs);
  writeFileSync(join(dir, parts.headerName), parts.header);
  const objects: string[] = [];
  const compiles: (() => Promise<void>)[] = [];
  const cc = selectCC(runtime);
  const system = systemLinkFlags(runtime, externFlags);
  for (const unit of parts.units) {
    const source = join(dir, unit.name);
    const object = join(dir, `${unit.name}.o`);
    writeFileSync(source, unit.source);
    objects.push(object);
    compiles.push(() => compileTranslationUnit(cc, source, object, opt, runtime, system));
  }
  await withSpanAsync('link/clang', {}, async () => {
    const compileStarted = performance.now();
    await runPool(compiles, jobs);
    addStageTime('link/compile', performance.now() - compileStarted);
    const linkStarted = performance.now();
    finishClang(
      cc,
      objectLinkArguments(objects, out, opt, std, runtime, system),
      out,
      externFlags,
      runtime,
    );
    addStageTime('link/ld', performance.now() - linkStarted);
  });
}

/** An invariant, not a user error: `build` pins the flavor it resolved around the gate, so a
 * mismatch means some path read the environment again (QA audit F3). */
function assertLinkFlavor(runtime: Runtime, gateFlavor: RuntimeFlavor): void {
  if (gateFlavor !== runtime.flavor) {
    throw new Error(
      `the gate admitted the ${gateFlavor} runtime surface but the link uses the ${runtime.flavor} archive`,
    );
  }
}

async function compileTranslationUnit(
  cc: string,
  source: string,
  object: string,
  opt: OptLevel,
  runtime: Runtime,
  system: readonly string[],
): Promise<void> {
  const result = await runClangAsync(
    cc,
    objectCompileArguments(source, object, opt, runtime, system),
  );
  const startError = clangStartError(cc, result);
  if (startError !== undefined) {
    throw startError;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new BuildError(
      'STA0009',
      `C compiler failed (exit ${result.status ?? 'signal'}) — this is a compiler bug; ` +
        'keep the C with `--keep-c` and report it',
    );
  }
  requireProduced(cc, object);
}

function objectCompileArguments(
  source: string,
  object: string,
  opt: OptLevel,
  runtime: Runtime,
  system: readonly string[],
): string[] {
  const flags = translationFlags(opt, runtime);
  return [
    ...flags.compile,
    ...system.filter((flag) => flag === '-flto' || flag.startsWith('-flto=')),
    '-I',
    runtime.include,
    '-c',
    source,
    '-o',
    object,
  ];
}

function objectLinkArguments(
  objects: readonly string[],
  out: string,
  opt: OptLevel,
  std: boolean,
  runtime: Runtime,
  system: readonly string[],
): string[] {
  const flags = translationFlags(opt, runtime);
  return [
    ...flags.link,
    ...objects,
    ...(std ? [STD_ARCHIVE] : []),
    '-L',
    runtime.libDir,
    '-ljsrt',
    ...system,
    '-o',
    out,
  ];
}

/** Compile flags and the link-only half of the single-shot shake flags, split so a
 * parallel `-c` and the later link each get the half that applies to them. Concatenated
 * they are the flags `linkArguments` has always passed in one invocation. */
function translationFlags(
  opt: OptLevel,
  runtime: Runtime,
): { readonly compile: readonly string[]; readonly link: readonly string[] } {
  const optimize = runtime.sanitized ? SANITIZER_FLAGS : [`-O${String(opt)}`];
  if (runtime.sanitized || process.platform === 'darwin') {
    return {
      compile: ['-std=c11', ...optimize],
      link: runtime.sanitized ? [...optimize] : ['-Wl,-dead_strip'],
    };
  }
  return {
    compile: ['-std=c11', ...optimize, '-ffunction-sections', '-fdata-sections'],
    link: ['-Wl,--gc-sections'],
  };
}

function finishClang(
  cc: string,
  args: readonly string[],
  out: string,
  externFlags: readonly string[],
  runtime: Runtime,
): void {
  const first = runClangCaptured(cc, args);
  const startError = clangStartError(cc, first);
  if (startError !== undefined) {
    throw startError;
  }
  if (first.status === 0) {
    requireProduced(cc, out);
    return;
  }

  // A stale bundled linker against a newer Xcode SDK (conda ld64-956 vs `.tbd` files naming
  // `arm64e.x1`) fails every Darwin link, including a trivial `int main` — retry once under
  // the newest readable CLT SDK. Green-path cost is zero: this runs only after a failure
  // carrying the signature.
  const staleSignature = isStaleLdSystemLibFailure(first.stderr);
  const retry = staleLdRetryArgs(args, first.stderr, {
    darwin: process.platform === 'darwin',
    defaultCc: process.env['CC'] === undefined,
    sanitized: runtime.sanitized,
  });
  if (retry !== undefined) {
    const second = runClangCaptured(cc, retry.args);
    const secondStartError = clangStartError(cc, second);
    if (secondStartError !== undefined) {
      throw secondStartError;
    }
    if (second.status === 0) {
      requireProduced(cc, out);
      return;
    }
    process.stderr.write(second.stdout);
    process.stderr.write(second.stderr);
    throw linkFailure(externFlags, second.status, staleLdHint(retry.sysroot));
  }

  process.stderr.write(first.stdout);
  process.stderr.write(first.stderr);
  throw linkFailure(externFlags, first.status, staleSignature ? staleLdHint(undefined) : undefined);
}

/** The link diagnostic: a failed link with extern flags is usually a missing library rather
 * than a compiler bug — name the flags so the user knows where to look first. `hint` rides
 * along only for the stale-linker signature, where the raw `ld` output names a format the
 * user cannot act on. */
function linkFailure(
  externFlags: readonly string[],
  status: number | null,
  hint: string | undefined,
): BuildError {
  const where = `C compiler failed (exit ${status ?? 'signal'})`;
  const tail =
    hint === undefined
      ? 'keep the C with `--keep-c` and report it'
      : `${hint}; otherwise keep the C with \`--keep-c\` and report it`;
  if (externFlags.length > 0) {
    return new BuildError(
      'STA0009',
      `${where} with extern link flags ${externFlags.join(' ')} — if a flag names a library ` +
        `that is not installed, install it or fix the @statorLink pragma / --link= value; ${tail}`,
    );
  }
  return new BuildError('STA0009', `${where} — this is a compiler bug; ${tail}`);
}
