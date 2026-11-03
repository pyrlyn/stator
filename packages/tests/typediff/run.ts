// Compares stator-ts's type of every expression with the `typescript` checker's, over the ts-mode
// subset and golden fixtures, and at each of them every other question the Zig compiler asks a
// `Session`. The compiler lowers from those answers, so a difference here is a wrong native value
// later. Counts ratchet against baseline.json; --update records them.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as ts from 'typescript';
import { ratchet } from '../support/ratchet.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const baselinePath = join(here, 'baseline.json');
const reportPath = join(repo, '.cache/typediff/report.json');
const binary = process.env['STATOR_TS'] ?? resolve(repo, '../stator-ts/zig-out/bin/stator-ts');
const libDir = join(repo, 'packages/compiler/node_modules/typescript/lib');
const globals = join(repo, 'packages/compiler/src/frontend/lib/stator.globals.d.ts');
const jobs = 8;

/** The options `frontend/program.ts` gives ts mode, in tsconfig form. */
const compilerOptions = {
  strict: true,
  noImplicitAny: true,
  noImplicitThis: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  useUnknownInCatchVariables: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  allowImportingTsExtensions: true,
  module: 'esnext',
  moduleResolution: 'bundler',
  moduleDetection: 'force',
  target: 'es2025',
  lib: ['es2025'],
  noEmit: true,
  skipLibCheck: true,
};

interface Counts extends Record<string, number> {
  fixtures: number;
  crashed: number;
  expressions: number;
  same: number;
  different: number;
  degraded: number;
  unmatched: number;
}

function fixtures(): string[] {
  const out: string[] = [];
  for (const dir of ['packages/tests/subset', 'packages/tests/golden/ts']) {
    for (const name of readdirSync(join(repo, dir)).sort()) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name === 'run.ts') continue;
      const path = join(repo, dir, name);
      const head = readFileSync(path, 'utf8').slice(0, 200);
      if (!head.includes('@mode: js')) out.push(path);
    }
  }
  return out;
}

const parsed = ts.parseJsonConfigFileContent({ compilerOptions }, ts.sys, repo);
const baseHost = ts.createCompilerHost(parsed.options);
const sourceCache = new Map<string, ts.SourceFile | undefined>();
const host: ts.CompilerHost = {
  ...baseHost,
  getSourceFile(name, languageVersion) {
    if (!sourceCache.has(name))
      sourceCache.set(name, baseHost.getSourceFile(name, languageVersion));
    return sourceCache.get(name);
  },
};

function nodesBySpan(file: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (n: ts.Node): void => {
    // The outermost node of a span wins for everything but a name, which a parent never shares.
    const key = `${String(n.getStart(file))}:${String(n.end)}`;
    if (!out.has(key)) out.set(key, n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

function identifierOf(n: ts.Node): ts.Node {
  if (ts.isIdentifier(n)) return n;
  const inner = ts.forEachChild(n, (c) =>
    c.pos <= n.getStart() && c.end === n.end ? c : undefined,
  );
  return inner === undefined ? n : identifierOf(inner);
}

/** stator-ts counts UTF-8 bytes and TypeScript UTF-16 units. */
function byteOffsets(text: string): Map<number, number> {
  const out = new Map<number, number>();
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    out.set(bytes, i);
    const point = text.codePointAt(i) ?? 0;
    bytes += Buffer.byteLength(String.fromCodePoint(point));
    i += point > 0xffff ? 2 : 1;
  }
  out.set(bytes, text.length);
  return out;
}

/** A lone surrogate has no UTF-8, so the dump on the other side can only say U+FFFD for it. */
const normalize = (s: string): string =>
  s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/\s+/g, ' ')
    .replace(/;? }/g, ' }')
    .trim();

interface Difference {
  theirs: string;
  ours: string;
  kind: string;
  at: string;
}

/** The `Session` answers after the type, in the order `stator-ts api` prints them. */
const apiColumns = [
  'typeFlags',
  'objectFlags',
  'symbol',
  'symbolFlags',
  'qualifiedName',
  'typeSymbol',
  'alias',
  'properties',
  'signatures',
  'typeArguments',
  'apparent',
  'baseTypes',
  'contextual',
  'resolvedSignature',
  'typeOfSymbolAt',
  'indexInfos',
] as const;
type ApiColumn = (typeof apiColumns)[number];

/** Flags that say what a type or symbol is, leaving out tsc's bookkeeping bits. */
const typeFlagsCompared = 0x1fffffff;
const objectFlagsCompared =
  ts.ObjectFlags.ClassOrInterface |
  ts.ObjectFlags.Reference |
  ts.ObjectFlags.Tuple |
  ts.ObjectFlags.Anonymous |
  ts.ObjectFlags.Mapped |
  ts.ObjectFlags.Instantiated |
  ts.ObjectFlags.ObjectLiteral |
  ts.ObjectFlags.FreshLiteral;
const symbolFlagsCompared =
  0xfffff | ts.SymbolFlags.Alias | ts.SymbolFlags.Optional | ts.SymbolFlags.Assignment;

/** `__@iterator@12` and `__#12@#x` carry a unique id, and the key is all stator-ts keeps. */
const withoutIds = (name: string): string =>
  name.replace(/__#\d+@/g, '').replace(/(__@[A-Za-z]+)@\d+/g, '$1');
const symbolName = (s: ts.Symbol): string =>
  withoutIds(ts.unescapeLeadingUnderscores(s.escapedName));

/** A literal type's synthetic symbol, which names nothing on either side. */
const unnamed = (name: string): string =>
  /^__(type|object|function|class)$/.test(name) ? '' : name;

function typeReference(type: ts.Type): ts.TypeReference | undefined {
  const object = type.flags & ts.TypeFlags.Object ? (type as ts.ObjectType) : undefined;
  return object !== undefined && object.objectFlags & ts.ObjectFlags.Reference
    ? (object as ts.TypeReference)
    : undefined;
}

function oracleApi(
  checker: ts.TypeChecker,
  node: ts.Node,
  type: ts.Type,
): Record<ApiColumn, string> {
  const print = (t: ts.Type): string =>
    normalize(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation));
  const symbol = checker.getSymbolAtLocation(node);
  const reference = typeReference(type);
  const args =
    reference === undefined
      ? []
      : checker
          .getTypeArguments(reference)
          .slice(0, (reference.target.typeParameters ?? []).length);
  const declared = reference?.target ?? type;
  const parent = node.parent as ts.Node & { name?: ts.Node };
  const contextual =
    ts.isExpression(node) && parent.name !== node ? checker.getContextualType(node) : undefined;
  const signature =
    ts.isCallExpression(node) || ts.isNewExpression(node)
      ? checker.getResolvedSignature(node)
      : undefined;
  const typeSymbol = type.symbol as ts.Symbol | undefined;
  const typeSymbolName = typeSymbol === undefined ? '' : symbolName(typeSymbol);
  return {
    typeFlags: String(type.flags & typeFlagsCompared),
    objectFlags: String(
      type.flags & ts.TypeFlags.Object
        ? (type as ts.ObjectType).objectFlags & objectFlagsCompared
        : 0,
    ),
    symbol: symbol === undefined ? '' : symbolName(symbol),
    symbolFlags: symbol === undefined ? '' : String(symbol.flags & symbolFlagsCompared),
    qualifiedName: symbol === undefined ? '' : withoutIds(checker.getFullyQualifiedName(symbol)),
    typeSymbol: unnamed(typeSymbolName),
    alias:
      type.aliasSymbol === undefined
        ? ''
        : `${String(type.aliasSymbol.escapedName)}/${String((type.aliasTypeArguments ?? []).length)}`,
    properties: checker.getPropertiesOfType(type).map(symbolName).join(','),
    signatures: `${String(checker.getSignaturesOfType(type, ts.SignatureKind.Call).length)}/${String(checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length)}`,
    typeArguments: args.map(print).join('; '),
    apparent: print(checker.getApparentType(type)),
    baseTypes: declared.isClassOrInterface()
      ? checker.getBaseTypes(declared).map(print).join('; ')
      : '',
    contextual: contextual === undefined ? '' : print(contextual),
    resolvedSignature:
      signature === undefined
        ? ''
        : `${String(signature.parameters.length)}:${print(checker.getReturnTypeOfSignature(signature))}`,
    typeOfSymbolAt:
      symbol === undefined ? '' : print(checker.getTypeOfSymbolAtLocation(symbol, node)),
    indexInfos: checker
      .getIndexInfosOfType(type)
      .map((i) => `${print(i.keyType)}:${print(i.type)}`)
      .join('; '),
  };
}

function compare(
  path: string,
  dump: string,
  counts: Counts,
  differences: Difference[],
  api: Map<ApiColumn, Difference[]>,
  gaps: string[],
): void {
  const program = ts.createProgram([globals, path], parsed.options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path);
  if (file === undefined) return;
  const spans = nodesBySpan(file);
  const offsets = byteOffsets(file.text);
  for (const line of dump.split('\n')) {
    const [linePath, start, end, kind, degraded, type, ...answers] = line.split('\t');
    if (linePath !== path || start === undefined || end === undefined) continue;
    counts.expressions += 1;
    const at = `${path.slice(repo.length + 1)}:${start}`;
    if (degraded === '1') {
      counts.degraded += 1;
      gaps.push(`degraded ${kind ?? ''} ${at}`);
    }
    const outer = spans.get(
      `${String(offsets.get(Number(start)))}:${String(offsets.get(Number(end)))}`,
    );
    if (outer === undefined) {
      counts.unmatched += 1;
      gaps.push(`unmatched ${kind ?? ''} ${at}`);
      continue;
    }
    // `let e` has a declaration and its name on one span, and stator-ts means the name. A heritage
    // entry and its expression share one too, and stator-ts means the expression.
    const inner = ts.isExpressionWithTypeArguments(outer) ? outer.expression : outer;
    const node = kind === 'identifier' ? identifierOf(inner) : inner;
    const theirType = checker.getTypeAtLocation(node);
    const theirs = normalize(
      checker.typeToString(theirType, undefined, ts.TypeFormatFlags.NoTruncation),
    );
    const ours = normalize(type ?? '');
    if (theirs === ours) {
      counts.same += 1;
    } else {
      counts.different += 1;
      differences.push({ theirs, ours, kind: kind ?? '', at });
    }
    const oracle = oracleApi(checker, node, theirType);
    apiColumns.forEach((column, i) => {
      const answer = normalize(answers[i] ?? '');
      const our = column === 'typeSymbol' ? unnamed(answer) : answer;
      const their = normalize(oracle[column]);
      counts[`api_${column}`] = (counts[`api_${column}`] ?? 0) + (our === their ? 0 : 1);
      if (our !== their) {
        api.get(column)?.push({ theirs: their, ours: our, kind: kind ?? '', at });
      }
    });
  }
}

function topPairs(
  differences: Difference[],
  limit: number,
): [string, { count: number; first: Difference }][] {
  const pairs = new Map<string, { count: number; first: Difference }>();
  for (const d of differences) {
    const key = `${d.ours}  <>  ${d.theirs}`;
    const known = pairs.get(key);
    if (known === undefined) pairs.set(key, { count: 1, first: d });
    else known.count += 1;
  }
  return [...pairs.entries()].sort((l, r) => r[1].count - l[1].count).slice(0, limit);
}

const run = promisify(execFile);

async function dumpOf(path: string, work: string, index: number): Promise<string | undefined> {
  const dir = join(work, String(index));
  mkdirSync(dir);
  const config = join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions, files: [globals, path] }));
  try {
    const { stdout } = await run(binary, ['api', '-p', config, '--lib-dir', libDir], {
      maxBuffer: 1 << 28,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  if (!existsSync(binary)) {
    console.error(`typediff: no stator-ts at ${binary}; set STATOR_TS`);
    return 1;
  }
  const paths = fixtures();
  const counts: Counts = {
    fixtures: paths.length,
    crashed: 0,
    expressions: 0,
    same: 0,
    different: 0,
    degraded: 0,
    unmatched: 0,
  };
  const work = mkdtempSync(join(tmpdir(), 'stator-typediff-'));
  const dumps: (string | undefined)[] = Array.from({ length: paths.length }, () => undefined);
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let i = next++; i < paths.length; i = next++) {
        const path = paths[i];
        if (path !== undefined) dumps[i] = await dumpOf(path, work, i);
      }
    }),
  );
  rmSync(work, { recursive: true, force: true });

  const differences: Difference[] = [];
  const gaps: string[] = [];
  const api = new Map<ApiColumn, Difference[]>(apiColumns.map((column) => [column, []]));
  paths.forEach((path, i) => {
    const dump = dumps[i];
    if (dump === undefined) {
      counts.crashed += 1;
    } else {
      compare(path, dump, counts, differences, api, gaps);
    }
  });

  const top = topPairs(differences, 200);
  const apiTop = Object.fromEntries([...api].map(([column, list]) => [column, topPairs(list, 60)]));
  console.log(`typediff: ${JSON.stringify(counts)}`);
  return ratchet({
    name: 'typediff',
    baselinePath,
    reportPath,
    counts: { ...counts },
    report: { counts, top, gaps, api: apiTop },
    mayOnlyFall: [
      'crashed',
      'different',
      'degraded',
      'unmatched',
      ...apiColumns.map((column) => `api_${column}`),
    ],
  });
}

process.exitCode = await main();
