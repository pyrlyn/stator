/* Module locations and the global `process` under `--node` (plan.md §11c T11.5, T11.6,
 * docs/MODES.md §6, plan-notes 312, 316, 361).
 *
 * A native binary has no source files, so every read of where a module is becomes a call that
 * answers it at run time, relative to the executable: `import.meta.url`, `import.meta.filename`
 * and `import.meta.dirname` in any file the project wrote, and the free `__filename` and
 * `__dirname` of the vendor module, which is where the bundler leaves a CommonJS file's reads of
 * them. Each call carries the file's path relative to the entry's directory; for the vendor module
 * that is the file the read was written in, found through the bundle's source map, or the vendor
 * module itself for a read with no mapping (a bundler helper). The helpers live in
 * `packages/node/src/internal/location.ts`, so no build-machine path reaches the binary.
 *
 * The same rewrite gives a file that reads the global `process` (any project file, and the vendor
 * module) `import process from "node:process"`, so the global is the `node:process` module's
 * default export, resolved by the same `paths` entries as every other built-in (`node.ts`). The
 * type comes from `packages/node/src/globals.d.ts`, which is why a read that only a declaration
 * file declares still counts as free. A file that binds its own `process` keeps that binding.
 *
 * The rewrite is text, like the vendor rewrite (`vendor.ts`): the imports join the file's first
 * line (after a shebang) and each read is replaced in place, so no line moves; only columns after
 * a rewritten read on its own line do.
 *
 * Pure: a program in, text out. The flag is a platform, not a mode (§0.8): nothing below the
 * frontend sees either the reads or the rewrite. */

import { dirname, relative } from 'node:path';
import * as ts from 'typescript';
import type { PositionMapper } from '../support/sourcemap.ts';
import { isNodeSourceFile, nodeLocationFile, nodeLocationModule } from './node.ts';
import { isFreeCommonJsName, isProjectFile, relativeSpecifier } from './vendor.ts';

/** The helper each read becomes. */
const HELPERS = {
  url: '__statorModuleUrl',
  filename: '__statorFilename',
  dirname: '__statorDirname',
  __filename: '__statorFilename',
  __dirname: '__statorDirname',
} as const;

type Read = keyof typeof HELPERS;

interface Site {
  readonly start: number;
  readonly end: number;
  readonly read: Read;
  /** The file the read was written in, relative to the entry's directory. */
  readonly relative: string;
}

/** The vendor module a program holds, and how its positions map back. */
export interface LocatedVendor {
  readonly path: string;
  readonly map: PositionMapper;
}

/** `import.meta.url` / `.filename` / `.dirname`: the property it reads, or `undefined`. */
function importMetaRead(node: ts.Node): Read | undefined {
  if (
    !ts.isPropertyAccessExpression(node) ||
    !ts.isMetaProperty(node.expression) ||
    node.expression.keywordToken !== ts.SyntaxKind.ImportKeyword
  ) {
    return undefined;
  }
  const name = node.name.text;
  return name === 'url' || name === 'filename' || name === 'dirname' ? name : undefined;
}

function nodePathRead(node: ts.Node, checker: ts.TypeChecker): Read | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  for (const name of ['__filename', '__dirname'] as const) {
    if (isFreeCommonJsName(node, name, checker)) return name;
  }
  return undefined;
}

/** Whether `file` reads a `process` it does not bind itself. */
function readsProcess(file: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && isFreeCommonJsName(node, 'process', checker)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sitesOf(
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  entryDir: string,
  vendor: LocatedVendor | undefined,
): Site[] {
  const inVendor = vendor !== undefined && file.fileName === vendor.path;
  const own = relative(entryDir, file.fileName).replace(/\\/g, '/');
  const writtenIn = (start: number): string => {
    if (!inVendor) return own;
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    const original = vendor.map(line + 1, character + 1);
    return original === undefined ? own : relative(entryDir, original.file).replace(/\\/g, '/');
  };
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    const read = importMetaRead(node) ?? (inVendor ? nodePathRead(node, checker) : undefined);
    if (read !== undefined) {
      const start = node.getStart(file);
      sites.push({ start, end: node.getEnd(), read, relative: writtenIn(start) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/** Where the import may join the text: after a shebang line, else at the start. */
function importOffset(text: string): number {
  if (!text.startsWith('#!')) return 0;
  const end = text.search(/\r?\n/);
  return end === -1 ? text.length : text.indexOf('\n', end) + 1;
}

function rewrite(file: ts.SourceFile, sites: readonly Site[], processImport: boolean): string {
  const used = [...new Set(sites.map((site) => HELPERS[site.read]))].sort();
  const nearby = relativeSpecifier(dirname(file.fileName), nodeLocationFile());
  const specifier = nearby.startsWith('.') ? nearby : nodeLocationModule();
  const locationHeader =
    used.length === 0 ? '' : `import { ${used.join(', ')} } from ${JSON.stringify(specifier)}; `;
  const header = (processImport ? 'import process from "node:process"; ' : '') + locationHeader;
  const at = importOffset(file.text);
  let out = file.text.slice(0, at) + header;
  let from = at;
  for (const site of [...sites].sort((a, b) => a.start - b.start)) {
    out +=
      file.text.slice(from, site.start) + `${HELPERS[site.read]}(${JSON.stringify(site.relative)})`;
    from = site.end;
  }
  return out + file.text.slice(from);
}

/** The rewritten text of every file that reads its location or `process`, by file name; empty
 * when none does. Call it under `--node` only: without the flag there is no `packages/node`. */
export function locationRewrites(
  program: ts.Program,
  entryFile: ts.SourceFile,
  vendor: LocatedVendor | undefined,
): Map<string, string> {
  const checker = program.getTypeChecker();
  const entryDir = dirname(entryFile.fileName);
  const rewrites = new Map<string, string>();
  for (const file of program.getSourceFiles()) {
    const isVendor = vendor !== undefined && file.fileName === vendor.path;
    if (!isVendor && (!isProjectFile(program, file) || isNodeSourceFile(file.fileName))) continue;
    const sites = sitesOf(file, checker, entryDir, vendor);
    const processImport = readsProcess(file, checker);
    if (sites.length > 0 || processImport)
      rewrites.set(file.fileName, rewrite(file, sites, processImport));
  }
  return rewrites;
}
