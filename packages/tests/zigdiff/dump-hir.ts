// Dumps the HIR of a program as the TypeScript compiler builds it, twice: right after the lowering
// (`lowered.json`) and after every pass (`optimized.json`, what `emitC` receives). The format is
// HIR-JSON.md, and it is canonical, so the Zig compiler's own dump compares byte for byte.
//
// The walk knows no node by name: every key an object carries reaches the JSON, and the Zig reader
// refuses a key its structs do not declare. A value this format cannot carry throws rather than
// being skipped, so a dump is either complete or absent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUNDLER, loadFrontend, lowerFrontend } from '../../compiler/src/cli/bundler.ts';
import { gateProgram } from '../../compiler/src/frontend/gate.ts';
import { moduleOrder } from '../../compiler/src/frontend/graph.ts';
import type { Module } from '../../compiler/src/hir/nodes.ts';
import { verifyHir } from '../../compiler/src/hir/verify.ts';
import { optimize } from '../../compiler/src/passes/index.ts';
import type { Diagnostic } from '../../compiler/src/support/diagnostics.ts';
import { compareStrings } from '../support/order.ts';

const FORMAT = 1;

type Mode = 'ts' | 'js';
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Plain = { readonly [key: string]: unknown };

function isPlain(value: object): value is Plain {
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** A key the walk would not see is a field the dump would lose without saying so. */
function ownEntries(value: Plain, where: string): (readonly [string, unknown])[] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${where}: symbol key`);
  }
  const names = Object.getOwnPropertyNames(value).sort(compareStrings);
  if (names.length !== Object.keys(value).length) {
    throw new Error(`${where}: non-enumerable key`);
  }
  return names.map((name) => [name, value[name]]);
}

/** A node has identity; the plain records inside one (a Parameter, a `StaticProp` with its own
 * `kind`) do not, which is why `kind` alone does not say. */
function isNode(value: Plain): boolean {
  return (
    typeof value['kind'] === 'string' &&
    Object.hasOwn(value, 'span') &&
    Object.hasOwn(value, 'type')
  );
}

/** Nodes reachable twice, which are the ones the emitter's identity-keyed slot maps must see as one
 * node. Keeps a per-walk stack as well: a cycle has no finite JSON form here. */
function sharedNodes(root: Module): ReadonlySet<object> {
  const seen = new Set<object>();
  const shared = new Set<object>();
  const open = new Set<object>();
  const visit = (value: unknown, key: string): void => {
    if (key === 'type' || key === 'span' || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!isPlain(value)) throw new Error(`${key}: not a plain object`);
    if (isNode(value)) {
      if (open.has(value)) throw new Error(`${key}: cyclic node`);
      if (seen.has(value)) {
        shared.add(value);
        return;
      }
      seen.add(value);
      open.add(value);
    }
    for (const [name, child] of Object.entries(value)) visit(child, name);
    open.delete(value);
  };
  visit(root, 'module');
  return shared;
}

/** IEEE-754 bits, because JSON has no NaN, no infinities and no `-0`, and a decimal would ask both
 * sides to agree on printing. Every NaN is one value to JavaScript, so its payload is not data. */
function floatBits(value: number): string {
  if (Number.isNaN(value)) return '7ff8000000000000';
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

class Dump {
  readonly #shared: ReadonlySet<object>;
  readonly #nodeIds = new Map<object, number>();
  readonly #typeIds = new Map<object, number>();
  readonly #typeText = new Map<string, number>();
  readonly #openTypes = new Set<object>();
  readonly #fileIds = new Map<string, number>();
  readonly types: Json[] = [];
  readonly files: string[] = [];

  constructor(shared: ReadonlySet<object>) {
    this.#shared = shared;
  }

  #fileId(file: string): number {
    const known = this.#fileIds.get(file);
    if (known !== undefined) return known;
    const id = this.files.length;
    this.files.push(file);
    this.#fileIds.set(file, id);
    return id;
  }

  #span(value: unknown): Json {
    if (typeof value !== 'object' || value === null || !isPlain(value)) {
      throw new Error('span: not a plain object');
    }
    const { start, length, line, file } = value;
    if (Object.keys(value).some((key) => !['start', 'length', 'line', 'file'].includes(key))) {
      throw new Error('span: unknown key');
    }
    const head = [
      this.#integer(start, 'span'),
      this.#integer(length, 'span'),
      this.#integer(line, 'span'),
    ];
    if (file === undefined) return head;
    if (typeof file !== 'string') throw new Error('span: file is not a string');
    return [...head, this.#fileId(file)];
  }

  #integer(value: unknown, where: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${where}: not an integer: ${String(value)}`);
    }
    return value;
  }

  /** Structurally interned, children first, so an entry only names lower ids and a type's id says
   * nothing about which object held it. Nothing below the gate compares types by address. */
  #typeId(value: unknown): number {
    if (typeof value !== 'object' || value === null || !isPlain(value)) {
      throw new Error('type: not a plain object');
    }
    const known = this.#typeIds.get(value);
    if (known !== undefined) return known;
    if (this.#openTypes.has(value)) throw new Error(`type: cyclic ${String(value['kind'])}`);
    this.#openTypes.add(value);
    const entry = this.#typeRecord(value);
    this.#openTypes.delete(value);
    const text = JSON.stringify(entry);
    let id = this.#typeText.get(text);
    if (id === undefined) {
      id = this.types.length;
      this.types.push(entry);
      this.#typeText.set(text, id);
    }
    this.#typeIds.set(value, id);
    return id;
  }

  #typeRecord(value: Plain): Json {
    const kind = value['kind'];
    if (typeof kind !== 'string') throw new Error('type: no kind');
    const out: Record<string, Json> = { kind };
    for (const [key, child] of ownEntries(value, `type ${kind}`)) {
      if (key !== 'kind' && child !== undefined) out[key] = this.#typeChild(child, key);
    }
    return out;
  }

  #typeChild(value: unknown, key: string): Json {
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return items.map((item) => this.#typeChild(item, key));
    }
    if (typeof value !== 'object' || value === null || !isPlain(value)) {
      throw new Error(`type ${key}: unsupported value`);
    }
    // A field of a class is a record around a type, and the only record a type holds.
    if (Object.hasOwn(value, 'kind')) return this.#typeId(value);
    const out: Record<string, Json> = {};
    for (const [name, child] of ownEntries(value, `type ${key}`)) {
      if (child !== undefined)
        out[name] = name === 'type' ? this.#typeId(child) : this.#typeChild(child, name);
    }
    return out;
  }

  #record(value: Plain, where: string, first: Readonly<Record<string, Json>>): Json {
    const out: Record<string, Json> = { ...first };
    for (const [key, child] of ownEntries(value, where)) {
      if (Object.hasOwn(out, key) || child === undefined) continue;
      out[key] = this.value(child, key, value);
    }
    return out;
  }

  #node(value: Plain, kind: string): Json {
    const known = this.#nodeIds.get(value);
    if (known !== undefined) return { $ref: known };
    if (!this.#shared.has(value)) return this.#record(value, kind, { kind });
    const id = this.#nodeIds.size;
    this.#nodeIds.set(value, id);
    return this.#record(value, kind, { kind, $id: id });
  }

  /** TypeScript tells a dynamic entry by which keys it holds, and a key holding `undefined` has no
   * JSON form, so the entry says what it is. */
  #dynEntry(value: unknown): Json {
    if (typeof value !== 'object' || value === null || !isPlain(value)) {
      throw new Error('entry: not a plain object');
    }
    const kind = Object.hasOwn(value, 'get')
      ? 'accessor-entry'
      : Object.hasOwn(value, 'key')
        ? 'computed-entry'
        : 'object-entry';
    return this.#record(value, kind, { kind });
  }

  value(value: unknown, key: string, parent: Plain | undefined): Json {
    if (key === 'type') return this.#typeId(value);
    if (key === 'span') return this.#span(value);
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        return parent?.['kind'] === 'number-literal' && key === 'value'
          ? floatBits(value)
          : this.#integer(value, key);
      case 'object':
        break;
      default:
        throw new Error(`${key}: unsupported ${typeof value}`);
    }
    if (value === null) throw new Error(`${key}: null`);
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      if (parent?.['kind'] === 'dyn-object-literal' && key === 'entries') {
        return items.map((item) => this.#dynEntry(item));
      }
      // Only `ExternCall.argTags` holds undefined, and a position there is meaningful.
      return items.map((item) => (item === undefined ? null : this.value(item, key, undefined)));
    }
    if (!isPlain(value)) throw new Error(`${key}: not a plain object`);
    const kind = value['kind'];
    return isNode(value) && typeof kind === 'string'
      ? this.#node(value, kind)
      : this.#record(value, key, {});
  }
}

/** One program's HIR as the canonical JSON text. */
export function hirJson(module: Module): string {
  const dump = new Dump(sharedNodes(module));
  const root = dump.value(module, 'module', undefined);
  return JSON.stringify({ format: FORMAT, files: dump.files, types: dump.types, module: root });
}

export type DumpResult =
  | { readonly kind: 'dumped'; readonly lowered: Module; readonly optimized: Module }
  | { readonly kind: 'refused'; readonly diagnostics: readonly Diagnostic[] };

/** The sequence `compileToCInner` in `cli/build.ts` runs up to the emitter, for a build with no
 * `--emit-header` unit. Any diagnostic stops it where it stops a build. */
export async function dumpHir(
  entry: string,
  mode: Mode,
  node: boolean,
  outDir: string,
): Promise<DumpResult> {
  const frontend = await loadFrontend(entry, mode, DEFAULT_BUNDLER, node);
  if (frontend.diagnostics.length > 0) {
    return { kind: 'refused', diagnostics: frontend.diagnostics };
  }
  const { program } = frontend;
  const gate = gateProgram(program, mode, node);
  if (gate.length > 0) return { kind: 'refused', diagnostics: gate };

  const entryFile = program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  if (entryFile === undefined) throw new Error(`${entry}: not in the program`);
  const { order, diagnostics: graph } = moduleOrder(program, entryFile, mode);
  if (graph.length > 0) return { kind: 'refused', diagnostics: graph };

  const { module, diagnostics: lowering } = lowerFrontend(frontend, order, mode);
  if (lowering.length > 0 || module === null) return { kind: 'refused', diagnostics: lowering };

  // Encoded before `optimize`, though no pass mutates, so the file holds what the lowering built
  // whatever a future pass does.
  const lowered = hirJson(module);
  const optimized = optimize(module, []);
  const problems = verifyHir(optimized);
  if (problems.length > 0) {
    throw new Error(`verifier: ${JSON.stringify(problems)}`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'lowered.json'), lowered);
  writeFileSync(join(outDir, 'optimized.json'), hirJson(optimized));
  return { kind: 'dumped', lowered: module, optimized };
}

async function main(): Promise<number> {
  const args = argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const [entry, outDir] = positional;
  if (entry === undefined || outDir === undefined) {
    stderr.write('usage: dump-hir.ts <entry> <out-dir> [--mode=ts|js] [--node]\n');
    return 2;
  }
  const mode: Mode = args.includes('--mode=js') ? 'js' : 'ts';
  const result = await dumpHir(entry, mode, args.includes('--node'), outDir);
  if (result.kind === 'refused') {
    for (const diagnostic of result.diagnostics) {
      stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
    }
    return 1;
  }
  return 0;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
