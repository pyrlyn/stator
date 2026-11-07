/* `--emit=lib`: one static library plus its header and pkg-config file, which a C build can use
 * with no Stator checkout (plan.md §10 Task 7.4, docs/FFI.md §8).
 *
 * The archive carries a PRIVATE runtime (plan-notes 342): the unit's object is prelinked with the
 * runtime archives it references (`cc -r`), then every global except the unit's own C symbols is
 * made local, so two Stator libraries in one program never collide on `jsrt_*` or on the
 * collector's own symbols. Each copy runs its own collector over its own heap (plan/T66).
 *
 * Every step is deterministic, like the header (Task 7.2 step 8): the prelink and the
 * localization write the same bytes for the same inputs, and the archiver runs in its
 * deterministic mode, so two builds of the same input give byte-identical archives. */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { EXPORT_ABI_VERSION } from '../frontend/export.ts';
import { BuildError } from '../support/diagnostics.ts';
import { type NamedPath, writeOutput } from './outputs.ts';

/** `lib<name>.a`: the only spelling a consumer's `-l<name>` finds, so `-o` must use it. */
const LIBRARY_FILE = /^lib([A-Za-z0-9_][A-Za-z0-9_.+-]*)\.a$/;

/** The `<name>` of `-o lib<name>.a`, or undefined when `-o` is not spelled that way. */
export function libraryName(out: string): string | undefined {
  return LIBRARY_FILE.exec(basename(out))?.[1];
}

/** `lib<name>.pc`, next to the archive: `${pcfiledir}` then locates both without a path. */
export function pkgConfigPath(out: string, name: string): string {
  return join(dirname(out), `lib${name}.pc`);
}

/** How the prelinked object's symbols are localized: Mach-O through the linker's export list,
 * ELF through `objcopy` after the link. Windows has no `--emit=lib` yet (STA1219). */
export type ObjectFormat = 'macho' | 'elf';

export function objectFormat(platform: NodeJS.Platform): ObjectFormat | undefined {
  if (platform === 'win32') {
    return undefined;
  }
  return platform === 'darwin' ? 'macho' : 'elf';
}

/** The keep list, one symbol per line. Mach-O spells C names with a leading underscore. */
export function keptSymbolsText(format: ObjectFormat, symbols: readonly string[]): string {
  const prefix = format === 'macho' ? '_' : '';
  return symbols.map((symbol) => `${prefix}${symbol}\n`).join('');
}

/** `cc -r`: the unit object and the runtime archives it references as one relocatable object.
 * The archives follow the object so only the members it reaches are pulled in, std before the
 * runtime as on the binary link. On Mach-O, `-exported_symbols_list` marks every other global
 * private extern, and `ld -r` then makes those static (ld(1), `-keep_private_externs`).
 * Without `debug`, `-S` drops the debug information: the runtime's Zig object carries it even in
 * a release build, and it names the runtime's source and archive paths on the build machine,
 * which a library handed to someone else must not (ld(1) on both linkers). */
export function prelinkArgs(
  format: ObjectFormat,
  object: string,
  archives: readonly string[],
  keepList: string,
  out: string,
  debug: boolean,
): string[] {
  return [
    // A clang configuration file adds link flags for executables, and `ld -r` refuses some of
    // them: the pinned conda clang's adds `-Wl,-rpath` (plan-notes 342).
    '--no-default-config',
    '-r',
    '-nostdlib',
    object,
    ...archives,
    ...(format === 'macho' ? [`-Wl,-exported_symbols_list,${keepList}`] : []),
    ...(debug ? [] : ['-Wl,-S']),
    '-o',
    out,
  ];
}

/** The archiver call: GNU and LLVM `ar` take the `D` modifier (zero uid, gid and mtime); Apple's
 * `ar` refuses it and reads `ZERO_AR_DATE` instead (cctools libtool.c). */
export function archiverCall(
  format: ObjectFormat,
  archive: string,
  member: string,
): { readonly args: string[]; readonly env: Readonly<Record<string, string>> } {
  return format === 'macho'
    ? { args: ['rcs', archive, member], env: { ZERO_AR_DATE: '1' } }
    : { args: ['rcsD', archive, member], env: {} };
}

/** A pkg-config value with its separators escaped: pkg-config splits `Cflags`/`Libs` like a
 * shell, so a space in the relative include path would cut it in two. */
function pcEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_./+-]/g, (ch) => `\\${ch}`);
}

export interface PkgConfigSpec {
  readonly name: string;
  readonly unit: string;
  /** The header's directory relative to the `.pc` file's; empty when they share one. */
  readonly includeDir: string;
  /** What the consumer's link owes the runtime and the unit's extern libraries: the binary
   * link's own list (`build.ts` `systemLinkFlags`). */
  readonly libs: readonly string[];
}

/** The `.pc` text. Relocatable through `${pcfiledir}`, so the three files can move together to
 * any directory. Everything goes in `Libs`, not `Libs.private`: there is no shared variant, and
 * `pkg-config --libs` without `--static` must still give a working link line. */
export function renderPkgConfig(spec: PkgConfigSpec): string {
  const includeDir =
    spec.includeDir === '' ? '${prefix}' : `\${prefix}/${pcEscape(spec.includeDir)}`;
  return [
    `# Generated by \`stator build --emit=lib\` for unit \`${spec.unit}\` (docs/FFI.md §8).`,
    'prefix=${pcfiledir}',
    'libdir=${prefix}',
    `includedir=${includeDir}`,
    '',
    `Name: lib${spec.name}`,
    `Description: Stator unit ${spec.unit} as a static library with a private runtime`,
    // The unit has no version of its own; the export ABI is the one the header asserts.
    `Version: ${String(EXPORT_ABI_VERSION)}`,
    'Cflags: -I${includedir}',
    ['Libs: -L${libdir}', `-l${spec.name}`, ...spec.libs].join(' '),
    '',
  ].join('\n');
}

export interface StaticLibrary {
  readonly cc: string;
  readonly object: string;
  /** Runtime archives in link order: `libjsrt_std.a` when the unit imports `std/*`, then
   * `libjsrt.a`. */
  readonly archives: readonly string[];
  readonly symbols: readonly string[];
  readonly out: NamedPath;
  readonly pc: NamedPath;
  readonly header: string;
  readonly unit: string;
  readonly libs: readonly string[];
  readonly scratch: string;
  readonly format: ObjectFormat;
  /** Keep debug information: the sanitized flavor, whose reports want line numbers. */
  readonly debug: boolean;
}

/** STA0020: a static-library tool that could not start, or exited nonzero. Its own output is
 * replayed first, so the user sees the tool's reason before the diagnostic. */
function runTool(
  tool: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  step: string,
  override: string,
): void {
  const result = spawnSync(tool, [...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const error: unknown = result.error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    throw new BuildError(
      'STA0020',
      `${step}: "${tool}" not found — install it (Linux: binutils; macOS: ` +
        `\`xcode-select --install\`) or set ${override}`,
    );
  }
  if (result.status !== 0) {
    process.stderr.write(typeof result.stdout === 'string' ? result.stdout : '');
    process.stderr.write(typeof result.stderr === 'string' ? result.stderr : '');
    const detail =
      error instanceof Error ? error.message : `exit ${String(result.status ?? 'signal')}`;
    throw new BuildError('STA0020', `${step}: "${tool}" failed (${detail})`);
  }
}

/** Prelink, localize, archive, then write the archive and its `.pc` to their outputs. */
export function writeStaticLibrary(lib: StaticLibrary): void {
  const name = libraryName(lib.out.path);
  if (name === undefined) {
    throw new Error(`--emit=lib output "${lib.out.path}" passed build()'s name check`);
  }
  const keepList = join(lib.scratch, 'keep.txt');
  writeFileSync(keepList, keptSymbolsText(lib.format, lib.symbols));
  // The member keeps the library's name, so an archive listing says whose runtime it holds.
  const prelinked = join(lib.scratch, `${name}.o`);
  runTool(
    lib.cc,
    prelinkArgs(lib.format, lib.object, lib.archives, keepList, prelinked, lib.debug),
    {},
    'static library prelink',
    'CC',
  );
  if (lib.format === 'elf') {
    const objcopy = process.env['OBJCOPY'] ?? 'objcopy';
    runTool(
      objcopy,
      [`--keep-global-symbols=${keepList}`, prelinked],
      {},
      'static library symbol localization',
      'OBJCOPY',
    );
  }
  const archive = join(lib.scratch, `lib${name}.a`);
  const call = archiverCall(lib.format, archive, prelinked);
  runTool(process.env['AR'] ?? 'ar', call.args, call.env, 'static library archive', 'AR');
  writeOutput(lib.out, readFileSync(archive));
  writeOutput(
    lib.pc,
    renderPkgConfig({
      name,
      unit: lib.unit,
      includeDir: relative(dirname(resolve(lib.pc.path)), dirname(resolve(lib.header))),
      libs: lib.libs,
    }),
  );
}
