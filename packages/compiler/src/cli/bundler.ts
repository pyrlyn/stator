/* The bundle step of `js` mode (plan.md §11d T12.1 step 4, docs/BUNDLER.md §5): choose the
 * adapter, load it only when the graph needs one, run it, check what it answers, and load the
 * program over the bundle. `build`, `explain` and `statorc/api` share this one frontend driver,
 * so the three can never disagree about which program they compiled.
 *
 * The compiler imports no bundler (plan §0.9): an adapter is a module loaded by name at run time,
 * and everything it answers is `unknown` until checked here (golden rule 4). */

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ts from 'typescript';
import { locationRewrites } from '../frontend/location.ts';
import { planVendor, platformPath, type VendorEntry } from '../frontend/vendor.ts';
import { createProgram, type LoadedProgram, sha256 } from '../frontend/program.ts';
import type { Module } from '../hir/nodes.ts';
import { lowerProgram } from '../lower/index.ts';
import { BuildError, type Diagnostic } from '../support/diagnostics.ts';
import {
  isSourceMapV3,
  type PositionMapper,
  type SourceMapV3,
  sourceMapper,
  UNMAPPED_FILE,
  UNMAPPED_NOTE,
} from '../support/sourcemap.ts';
import { withSpanAsync } from '../support/telemetry.ts';

type Mode = 'ts' | 'js';

/** What `bundle()` gets besides the entry (docs/BUNDLER.md §3). */
export interface BundleOptions {
  readonly external: readonly (string | RegExp)[];
}

/** One ESM module, its map and every file the bundler read (docs/BUNDLER.md §2, §6, §7). */
export interface BundleResult {
  readonly code: string;
  readonly map: SourceMapV3;
  readonly inputs: readonly string[];
}

/** The adapter contract (docs/BUNDLER.md §5). */
export interface BundlerAdapter {
  readonly name: string;
  bundle(entry: VendorEntry, options: BundleOptions): Promise<BundleResult>;
}

/** An adapter as far as the compiler trusts it: a name and a callable `bundle` whose answer is
 * checked before use. Every `BundlerAdapter` is one. */
interface UncheckedAdapter {
  readonly name: string;
  bundle(entry: VendorEntry, options: BundleOptions): unknown;
}

/** Which bundler a build uses. `module` is loaded by specifier only when the graph needs it;
 * `adapter` and `bundle` come from `statorc/api` callers, already in hand. */
export type BundlerChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'module'; readonly name: string; readonly specifier: string }
  | { readonly kind: 'adapter'; readonly adapter: unknown }
  | { readonly kind: 'bundle'; readonly bundle: unknown };

/** `--bundler=vite`, the `js`-mode default: the `vite-stator` package (T12.2). */
export const DEFAULT_BUNDLER: BundlerChoice = {
  kind: 'module',
  name: 'vite',
  specifier: 'vite-stator',
};

/** `--bundler=vite|none|<module>`: a path (relative to the current directory) or a package. */
export function bundlerChoice(raw: string): BundlerChoice {
  if (raw === 'none') return { kind: 'none' };
  if (raw === 'vite') return DEFAULT_BUNDLER;
  return { kind: 'module', name: raw, specifier: raw };
}

/** `node:*`, the bare built-ins and `std/*` stay imports in the bundle (docs/BUNDLER.md §3). */
const EXTERNAL: readonly (string | RegExp)[] = [/^node:/, ...builtinModules, /^std\//];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || isAbsolute(specifier);
}

/** The adapter package resolves from the project first, then beside the compiler, the way a
 * locally or globally installed `statorc` finds its peers. */
function resolveAdapterUrl(specifier: string, resolveDir: string): string {
  if (isPathSpecifier(specifier)) return pathToFileURL(resolve(specifier)).href;
  try {
    return pathToFileURL(createRequire(join(resolveDir, 'package.json')).resolve(specifier)).href;
  } catch {
    return import.meta.resolve(specifier);
  }
}

function isAdapter(value: unknown): value is UncheckedAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'bundle' in value &&
    typeof value.bundle === 'function'
  );
}

/** The adapter a module provides: its default export, or a named `adapter`. */
function adapterOf(loaded: unknown): UncheckedAdapter | undefined {
  if (typeof loaded !== 'object' || loaded === null) return undefined;
  if ('default' in loaded && isAdapter(loaded.default)) return loaded.default;
  if ('adapter' in loaded && isAdapter(loaded.adapter)) return loaded.adapter;
  return undefined;
}

async function loadAdapter(
  name: string,
  specifier: string,
  resolveDir: string,
): Promise<UncheckedAdapter> {
  const install =
    specifier === 'vite-stator' ? 'vite-stator and vite (pnpm add -D vite-stator vite)' : specifier;
  const fail = (reason: string): BuildError =>
    new BuildError(
      'STA0014',
      `bundler adapter '${name}' could not be loaded — install ${install}, or build with ` +
        `--bundler=none (${reason})`,
    );
  let loaded: unknown;
  try {
    loaded = await import(resolveAdapterUrl(specifier, resolveDir));
  } catch (error) {
    throw fail(messageOf(error));
  }
  const adapter = adapterOf(loaded);
  if (adapter === undefined) {
    throw fail('the module exports no adapter: a default export { name, bundle }');
  }
  return adapter;
}

function bundleFailed(message: string): BuildError {
  return new BuildError('STA0015', `the bundle step failed: ${message}`);
}

/** A bundle as the adapter contract promises it, or STA0015 naming what is missing. */
export function checkBundle(value: unknown, source: string): BundleResult {
  if (typeof value !== 'object' || value === null) {
    throw bundleFailed(`${source} returned no bundle`);
  }
  if (!('code' in value) || typeof value.code !== 'string') {
    throw bundleFailed(`${source} returned no code string`);
  }
  if (!('map' in value) || !isSourceMapV3(value.map)) {
    throw bundleFailed(`${source} returned no version-3 source map`);
  }
  const raw: unknown = 'inputs' in value ? value.inputs : undefined;
  const list: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const inputs = list.filter((input) => typeof input === 'string');
  if (!Array.isArray(raw) || inputs.length !== list.length) {
    throw bundleFailed(`${source} returned no inputs list`);
  }
  return { code: value.code, map: value.map, inputs };
}

async function runAdapter(adapter: UncheckedAdapter, entry: VendorEntry): Promise<BundleResult> {
  let raw: unknown;
  try {
    raw = await adapter.bundle(entry, { external: EXTERNAL });
  } catch (error) {
    // The bundler owns this error space; its message passes through (the STA0012 precedent).
    throw bundleFailed(messageOf(error));
  }
  return checkBundle(raw, `adapter '${adapter.name}'`);
}

async function obtainBundle(
  choice: BundlerChoice,
  entry: VendorEntry,
): Promise<BundleResult | undefined> {
  switch (choice.kind) {
    case 'none':
      return undefined;
    case 'bundle':
      return checkBundle(choice.bundle, 'the vendor bundle');
    case 'adapter':
      if (!isAdapter(choice.adapter)) {
        throw new BuildError(
          'STA0014',
          'bundler adapter could not be loaded — the value given is not { name, bundle }',
        );
      }
      return runAdapter(choice.adapter, entry);
    case 'module':
      return runAdapter(await loadAdapter(choice.name, choice.specifier, entry.resolveDir), entry);
  }
}

/** The vendor module a program holds, and where its positions came from. */
export interface VendorModule {
  readonly path: string;
  readonly map: PositionMapper;
}

export interface Frontend extends LoadedProgram {
  /** Present when the graph was bundled: diagnostics and spans in this file are mapped. */
  readonly vendor?: VendorModule;
}

/** The program a build compiles; `node` is the `--node` platform (docs/MODES.md §6). Without a package import or a CommonJS project file, or under
 * `none`, it is the plain program and no adapter loads (the goldens' case). Otherwise the bundle
 * joins it as the virtual vendor module and the project's package imports name that module. */
export async function loadFrontend(
  entry: string,
  mode: Mode,
  bundler: BundlerChoice,
  node = false,
): Promise<Frontend> {
  if (!existsSync(entry)) {
    throw new BuildError('STA0007', `entry file "${entry}" does not exist`);
  }
  return withSpanAsync('frontend/program', {}, () => loadFrontendInner(entry, mode, bundler, node));
}

async function loadFrontendInner(
  entry: string,
  mode: Mode,
  bundler: BundlerChoice,
  node: boolean,
): Promise<Frontend> {
  const bundled = await bundledFrontend(entry, mode, bundler, node);
  return node ? located(entry, mode, bundled) : bundled.frontend;
}

/** A frontend and the overlay it was loaded with (none for the plain program). */
interface Overlaid {
  readonly frontend: Frontend;
  readonly files: ReadonlyMap<string, string>;
}

async function bundledFrontend(
  entry: string,
  mode: Mode,
  bundler: BundlerChoice,
  node: boolean,
): Promise<Overlaid> {
  const base = createProgram(entry, mode, undefined, undefined, node);
  const plain = { frontend: base, files: new Map<string, string>() };
  if (mode !== 'js' || bundler.kind === 'none') return plain;
  const entryFile = base.program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  if (entryFile === undefined) return plain;
  const plan = planVendor(base.program, entryFile, node);
  if (plan === undefined) return plain;
  // No bundle can make the source parse, so a parse-phase error is the build's answer before any
  // adapter loads; the package imports it left unresolved are not reported beside it.
  if (base.parseDiagnostics.length > 0) {
    return { frontend: { ...base, diagnostics: [...base.parseDiagnostics] }, files: plain.files };
  }
  const bundle = await obtainBundle(bundler, plan.entry);
  if (bundle === undefined) return plain;
  const files = new Map(plan.rewrites(bundle.code));
  files.set(plan.modulePath, bundle.code);
  // The bundle's code is what the card keys on (T12.1 step 6); the rewrites follow from the
  // entry's bytes and the bundle, but hashing them too costs nothing and keys on every byte read.
  const key = sha256(JSON.stringify([...files]));
  const loaded = createProgram(
    entry,
    mode,
    undefined,
    { files, key, unchecked: plan.modulePath },
    node,
  );
  return {
    frontend: {
      ...loaded,
      vendor: { path: plan.modulePath, map: sourceMapper(bundle.map, plan.entry.resolveDir) },
    },
    files,
  };
}

/** Under `--node`, the frontend again with every module-location read and every free `process`
 * rewritten (`frontend/location.ts`, plan-notes 316, 361); the same frontend when nothing reads
 * either. */
function located(entry: string, mode: Mode, { frontend, files }: Overlaid): Frontend {
  const entryFile = frontend.program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  if (entryFile === undefined) return frontend;
  const rewrites = locationRewrites(frontend.program, entryFile, frontend.vendor);
  if (rewrites.size === 0) return frontend;
  const merged = new Map([...files, ...rewrites]);
  const loaded = createProgram(
    entry,
    mode,
    undefined,
    { files: merged, key: sha256(JSON.stringify([...merged])) },
    true,
  );
  return frontend.vendor === undefined ? loaded : { ...loaded, vendor: frontend.vendor };
}

/** The lowering of a loaded frontend, with vendor spans mapped (T12.1 step 5). */
export function lowerFrontend(
  frontend: Frontend,
  order: readonly ts.SourceFile[],
  mode: Mode,
): { readonly module: Module | null; readonly diagnostics: readonly Diagnostic[] } {
  const { vendor } = frontend;
  return lowerProgram(
    order,
    frontend.program.getTypeChecker(),
    frontend.runtimeDynamicSymbols,
    mode,
    vendor === undefined ? undefined : { file: vendor.path, map: vendor.map },
  );
}

/** 0-indexed offset of a 1-indexed line and column in `file`, or 0 when it cannot be read. */
function offsetIn(file: string, line: number, column: number): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let offset = 0;
  for (let at = 1; at < line; at += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return 0;
    offset = next + 1;
  }
  return offset + column - 1;
}

/** Diagnostics as they leave the compiler, the one step `build` and `explain` both take. A
 * diagnostic in the vendor module is reported where the code was written (docs/BUNDLER.md §6):
 * the original file and position, or `<package bundle>` and the bundle's own position with a
 * note that no mapping exists. Every file is then in the platform's form (§5, "Paths"). */
export function reportedDiagnostics(
  diagnostics: readonly Diagnostic[],
  vendor: VendorModule | undefined,
): readonly Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const mapped = vendor === undefined ? diagnostic : vendorMapped(diagnostic, vendor);
    return { ...mapped, file: platformPath(mapped.file) };
  });
}

function vendorMapped(diagnostic: Diagnostic, vendor: VendorModule): Diagnostic {
  if (diagnostic.file !== vendor.path) return diagnostic;
  const at = vendor.map(diagnostic.line, diagnostic.column);
  if (at === undefined) {
    return { ...diagnostic, file: UNMAPPED_FILE, message: diagnostic.message + UNMAPPED_NOTE };
  }
  return {
    ...diagnostic,
    file: at.file,
    line: at.line,
    column: at.column,
    span: { start: offsetIn(at.file, at.line, at.column), length: diagnostic.span.length },
  };
}
