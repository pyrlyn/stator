/* Node API coverage dashboard (plan.md §11c, the `--node` platform) → docs/NODE.md.
 *
 *   node packages/tests/golden/node-coverage.ts           # rewrite docs/NODE.md
 *   node packages/tests/golden/node-coverage.ts --check   # fail when docs/NODE.md is stale (ci)
 *
 * The DENOMINATOR is not hand-written: it is every public member of every built-in module, read
 * from the pinned Node itself — so the percentage cannot be raised by forgetting a member. Per
 * module that is its enumerable exports, plus, for each exported class, its static and prototype
 * members. `_`-prefixed names are private by Node's convention and left out; Symbol keys too.
 *
 * The NUMERATOR follows test:builtins exactly (coverage-claims.ts): a member counts as covered
 * only when tests/golden/node_coverage.json names a golden fixture that exercises it and matches
 * Node byte-for-byte, and that fixture exists and mentions the member. A nondeterministic member
 * (`os.hostname`, `process.pid`) is carved out of the denominator with a named proof instead.
 *
 * The output depends on the Node version, so this refuses to run on anything but the pin.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExpectations, moduleOf } from '../node-suite/suite.ts';
import {
  loadClaims,
  mentionsAccess,
  percent,
  verifyClaim,
  type Verdict,
} from './coverage-claims.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(ROOT, 'docs', 'NODE.md');
const SCAN = join(ROOT, 'docs', 'research', 'node-mode', 'scan.json');
const GLOBAL_ALIAS: Readonly<Record<string, string>> = {
  setTimeout: 'timers.setTimeout',
  clearTimeout: 'timers.clearTimeout',
  setInterval: 'timers.setInterval',
  clearInterval: 'timers.clearInterval',
  setImmediate: 'timers.setImmediate',
  clearImmediate: 'timers.clearImmediate',
  performance: 'perf_hooks.performance',
  URL: 'url.URL',
  URLSearchParams: 'url.URLSearchParams',
  TextEncoder: 'util.TextEncoder',
  TextDecoder: 'util.TextDecoder',
  MessageChannel: 'worker_threads.MessageChannel',
};
const CLASS_STATIC_SKIP = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);

type Kind =
  | 'function'
  | 'class'
  | 'value'
  | 'getter'
  | 'static'
  | 'method'
  | 'accessor'
  | 'value (Linux)'
  | 'value (macOS)'
  | 'function (macOS)';

// Measured from official Node v26.7.0 on Linux x64 and macOS arm64 (plan-notes 378).
// Absent exports must remain in the union: omitting them would inflate coverage on one host.
const PLATFORM_SURFACE_NODE = 'v26.7.0';
type PlatformExport = {
  readonly kind: Kind;
  readonly variants: Readonly<Record<string, 'absent' | 'number' | 'function' | 'undefined'>>;
};
const PLATFORM_EXPORTS: Readonly<Record<string, Readonly<Record<string, PlatformExport>>>> = {
  constants: {
    O_DIRECT: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
    O_NOATIME: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
    O_SYMLINK: { kind: 'value (macOS)', variants: { linux: 'absent', darwin: 'number' } },
    RTLD_DEEPBIND: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
    SIGINFO: { kind: 'value (macOS)', variants: { linux: 'absent', darwin: 'number' } },
    SIGPOLL: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
    SIGPWR: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
    SIGSTKFLT: { kind: 'value (Linux)', variants: { linux: 'number', darwin: 'absent' } },
  },
  fs: {
    lchmod: { kind: 'function (macOS)', variants: { linux: 'undefined', darwin: 'function' } },
    lchmodSync: { kind: 'function (macOS)', variants: { linux: 'undefined', darwin: 'function' } },
  },
};
type Member = {
  readonly name: string;
  readonly kind: Kind;
  readonly spelled: string;
  readonly mentions: (s: string) => boolean;
};
type Row = Member & { readonly verdict: Verdict; readonly corpus: number; readonly tsc: boolean };

function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

function isClass(value: unknown, name: string): value is { prototype: object } {
  if (typeof value !== 'function' || !/^[A-Z]/.test(name)) return false;
  const proto: unknown = (value as { prototype?: unknown }).prototype;
  return (
    typeof proto === 'object' &&
    proto !== null &&
    Object.getOwnPropertyNames(proto).some((n) => n !== 'constructor')
  );
}

function mentionsWord(word: string): (s: string) => boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`);
  return (s) => re.test(s);
}

/** The module's public surface. Getters are listed, never invoked: some warn or throw. */
function surfaceOf(id: string, exports: unknown): Member[] {
  if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) return [];
  const bare = id.replace(/^node:/, '');
  const specifier = (s: string): boolean =>
    s.includes(`'${id}'`) || s.includes(`"${id}"`) || s.includes(`node:${bare}`);
  const out: Member[] = [];
  const platformExports = PLATFORM_EXPORTS[bare];
  const names = new Set([
    ...Object.keys(exports).filter(isPublic),
    ...Object.keys(platformExports ?? {}),
  ]);
  // Preserve Node's UTF-16 order independently of the host locale.
  for (const name of [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const desc = Object.getOwnPropertyDescriptor(exports, name);
    const word = mentionsWord(name);
    const top = (s: string): boolean => specifier(s) && word(s);
    const platformExport = platformExports?.[name];
    if (platformExport !== undefined) {
      const expected = platformExport.variants[process.platform];
      const observed = desc === undefined ? 'absent' : typeof desc.value;
      if (expected === undefined || observed !== expected) {
        throw new Error(
          `node-coverage: ${id}.${name} on ${process.platform} is ${observed}; refresh the measured platform surface`,
        );
      }
      out.push({ name, kind: platformExport.kind, spelled: `${bare}.${name}`, mentions: top });
      continue;
    }
    if (desc === undefined) continue;
    if (desc.get !== undefined || desc.set !== undefined) {
      out.push({ name, kind: 'getter', spelled: `${bare}.${name}`, mentions: top });
      continue;
    }
    const value: unknown = desc.value;
    if (isClass(value, name)) {
      out.push({ name, kind: 'class', spelled: `${bare}.${name}`, mentions: top });
      const statics = Object.getOwnPropertyNames(value).filter(
        (n) => isPublic(n) && !CLASS_STATIC_SKIP.has(n),
      );
      for (const s of statics.sort()) {
        out.push({
          name: `${name}.${s}`,
          kind: 'static',
          spelled: `${bare}.${name}.${s}`,
          mentions: (src) => top(src) && src.includes(`${name}.${s}`),
        });
      }
      const proto = Object.getOwnPropertyNames(value.prototype).filter(
        (n) => isPublic(n) && n !== 'constructor',
      );
      for (const p of proto.sort()) {
        const pd = Object.getOwnPropertyDescriptor(value.prototype, p);
        const kind: Kind =
          pd !== undefined && (pd.get !== undefined || pd.set !== undefined)
            ? 'accessor'
            : 'method';
        const access = mentionsAccess(p);
        out.push({
          name: `${name}.prototype.${p}`,
          kind,
          spelled: `${bare}.${name}.prototype.${p}`,
          mentions: (src) => top(src) && access(src),
        });
      }
    } else {
      out.push({
        name,
        kind: typeof value === 'function' ? 'function' : 'value',
        spelled: `${bare}.${name}`,
        mentions: top,
      });
    }
  }
  return out;
}

/** Corpus uses per module member from the T11.0 scan (docs/research/node-mode/scan.json). */
function corpusUses(): { all: Map<string, number>; tsc: Set<string> } {
  const all = new Map<string, number>();
  const tsc = new Set<string>();
  const raw: unknown = JSON.parse(readFileSync(SCAN, 'utf8'));
  const corpus =
    typeof raw === 'object' && raw !== null && 'corpus' in raw && Array.isArray(raw.corpus)
      ? (raw.corpus as unknown[])
      : [];
  for (const pkg of corpus) {
    if (typeof pkg !== 'object' || pkg === null || !('modules' in pkg) || !('name' in pkg))
      continue;
    const modules = pkg.modules;
    if (typeof modules !== 'object' || modules === null) continue;
    for (const [mod, entry] of Object.entries(modules)) {
      const members: unknown =
        typeof entry === 'object' && entry !== null && 'members' in entry
          ? entry.members
          : undefined;
      if (typeof members !== 'object' || members === null) continue;
      for (const [member, count] of Object.entries(members)) {
        if (typeof count !== 'number') continue;
        const key = `${mod}.${member}`;
        all.set(key, (all.get(key) ?? 0) + count);
        if (pkg.name === 'typescript') tsc.add(key);
      }
    }
  }
  // Node globals are the same objects as module members (`process` is `node:process`, `Buffer` is
  // `node:buffer`'s), so their corpus uses count toward the module member they alias.
  for (const pkg of corpus) {
    if (typeof pkg !== 'object' || pkg === null || !('globals' in pkg) || !('name' in pkg))
      continue;
    const globals = pkg.globals;
    if (typeof globals !== 'object' || globals === null) continue;
    for (const [name, entry] of Object.entries(globals)) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('uses' in entry) ||
        !('members' in entry)
      )
        continue;
      const add = (key: string, count: number): void => {
        all.set(key, (all.get(key) ?? 0) + count);
        if (pkg.name === 'typescript') tsc.add(key);
      };
      const members = entry.members;
      const each = (prefix: string): void => {
        if (typeof members !== 'object' || members === null) return;
        for (const [m, c] of Object.entries(members))
          if (typeof c === 'number') add(`${prefix}${m}`, c);
      };
      const uses = typeof entry.uses === 'number' ? entry.uses : 0;
      const alias = GLOBAL_ALIAS[name];
      if (name === 'process') each('process.');
      else if (name === 'Buffer') {
        add('buffer.Buffer', uses);
        each('buffer.Buffer.');
      } else if (alias !== undefined) add(alias, uses);
    }
  }
  return { all, tsc };
}

/** GitHub's heading anchor for `### node:<id>`: lower case, punctuation other than `-`/`_` dropped. */
function anchor(id: string): string {
  return `node:${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Node's own tests per module (T11.7): the selected files and those expected to pass. */
interface SuiteCount {
  passed: number;
  selected: number;
}

function suiteCounts(ids: readonly string[]): Map<string, SuiteCount> {
  const counts = new Map<string, SuiteCount>();
  for (const entry of loadExpectations()) {
    const id = moduleOf(entry.test, ids);
    if (id === undefined) continue;
    const count = counts.get(id) ?? { passed: 0, selected: 0 };
    count.selected++;
    if (entry.expect === 'pass') count.passed++;
    counts.set(id, count);
  }
  return counts;
}

function render(version: string, modules: readonly { id: string; rows: readonly Row[] }[]): string {
  const suite = suiteCounts(modules.map((m) => m.id));
  const stats = modules.map(({ id, rows }) => {
    const landed = rows.filter((r) => r.verdict === 'landed').length;
    const surface = rows.filter((r) => r.verdict !== 'carved').length;
    const corpus = rows.reduce((n, r) => n + r.corpus, 0);
    const tests = suite.get(id);
    const nodeTests =
      tests === undefined ? '' : `${String(tests.passed)} / ${String(tests.selected)}`;
    return { id, rows, landed, surface, corpus, tsc: rows.filter((r) => r.tsc).length, nodeTests };
  });
  const suitePassed = [...suite.values()].reduce((n, c) => n + c.passed, 0);
  const suiteSelected = [...suite.values()].reduce((n, c) => n + c.selected, 0);
  const landed = stats.reduce((n, m) => n + m.landed, 0);
  const surface = stats.reduce((n, m) => n + m.surface, 0);
  const tscRows = stats.flatMap((m) => m.rows.filter((r) => r.tsc));
  const tscLanded = tscRows.filter((r) => r.verdict === 'landed').length;
  const lines = [
    '# NODE.md — Node API coverage',
    '',
    `Generated by \`packages/tests/golden/node-coverage.ts\` from the pinned Node ${version} and`,
    '`packages/tests/golden/node_coverage.json`. **Do not edit by hand:** run `pnpm run docs:node`',
    'after every change that adds or removes `node:*` coverage; `pnpm run ci` fails when this file',
    'is stale (AGENTS.md, Testing rules).',
    '',
    'A member is **covered** only when a golden fixture exercises it and matches Node byte-for-byte —',
    'the `test:builtins` rule. The member list is read from Node itself: every enumerable export of',
    "every built-in module, plus each exported class's static and prototype members (`_`-prefixed",
    'names are private and left out). Platform-specific exports use the measured union of Linux',
    'and macOS on this Node pin: kinds name the platform when availability differs, and the',
    'generator validates those differences on the current host (plan-notes 378).',
    '**Corpus** counts uses in the T11.0 corpus',
    "(`docs/research/node-mode/scan.json`); **tsc** marks members TypeScript 6.0.3's `tsc` needs",
    "(plan.md §11c, slice N1). **Node tests** counts files of Node's own `test/parallel` selected",
    'for the module and expected to pass under Stator, from',
    '`packages/tests/node-suite/expectations.json`, which `pnpm run test:node-suite` holds to the',
    'truth (plan.md §11c T11.7).',
    '',
    `**Total: ${String(landed)} / ${String(surface)} members covered (${String(percent(landed, surface))}%) across ${String(stats.length)} modules.**`,
    `**Slice N1 (\`tsc\`): ${String(tscLanded)} / ${String(tscRows.length)} (${String(percent(tscLanded, tscRows.length))}%).**`,
    `**Node tests: ${String(suitePassed)} / ${String(suiteSelected)} selected files pass.**`,
    '',
    '| Module | Covered | Members | % | Corpus uses | tsc members | Node tests |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...stats.map(
      (m) =>
        `| [\`node:${m.id}\`](#${anchor(m.id)}) | ${String(m.landed)} | ${String(m.surface)} | ${String(percent(m.landed, m.surface))}% | ${String(m.corpus)} | ${String(m.tsc)} | ${m.nodeTests} |`,
    ),
    '',
    '## Members by module',
    '',
  ];
  const mark: Record<Verdict, string> = {
    landed: '✅',
    carved: '➖ nondeterministic',
    missing: '—',
  };
  for (const m of stats) {
    lines.push(
      `### node:${m.id}`,
      '',
      `<details><summary><code>node:${m.id}</code> — ${String(m.landed)} / ${String(m.surface)} (${String(percent(m.landed, m.surface))}%)</summary>`,
      '',
      '| Member | Kind | Covered | Corpus | tsc |',
      '| --- | --- | --- | --- | --- |',
      ...m.rows.map(
        (r) =>
          `| \`${r.name}\` | ${r.kind} | ${mark[r.verdict]} | ${r.corpus === 0 ? '' : String(r.corpus)} | ${r.tsc ? '✓' : ''} |`,
      ),
      '',
      '</details>',
      '',
    );
  }
  return lines.join('\n');
}

function main(): void {
  const pinned = readFileSync(join(ROOT, '.node-version'), 'utf8').trim().replace(/^v/, '');
  if (process.version.replace(/^v/, '') !== pinned) {
    console.error(
      `node-coverage: running ${process.version}, pinned ${pinned} — the surface is read from the pin only`,
    );
    process.exit(1);
  }
  if (process.version !== PLATFORM_SURFACE_NODE) {
    throw new Error('node-coverage: refresh the measured platform surface for the new Node pin');
  }
  process.noDeprecation = true;
  process.removeAllListeners('warning');
  const require = createRequire(import.meta.url);
  const claims = loadClaims(join(HERE, 'node_coverage.json'), 'node_coverage.json');
  const uses = corpusUses();
  const problems: string[] = [];
  const ids = [...new Set(builtinModules.map((m) => m.replace(/^node:/, '')))]
    .filter(isPublic)
    .sort();
  const modules: { id: string; rows: Row[] }[] = [];
  for (const id of ids) {
    const spec = builtinModules.includes(id) ? id : `node:${id}`;
    let exports: unknown;
    try {
      exports = require(spec);
    } catch {
      continue; // gated behind a flag on this Node; it has no surface to cover yet
    }
    const surface = surfaceOf(spec, exports);
    const claimed = claims[id] ?? {};
    for (const name of Object.keys(claimed)) {
      if (!surface.some((m) => m.name === name))
        problems.push(`${id}.${name}: claimed, but node:${id} has no such member`);
    }
    const rows = surface.map((m): Row => {
      const claim = claimed[m.name];
      const verdict =
        claim === undefined
          ? 'missing'
          : verifyClaim(m.spelled, claim, m.mentions, HERE, join(HERE, '..'), problems);
      return {
        ...m,
        verdict,
        corpus: uses.all.get(`${id}.${m.name}`) ?? 0,
        tsc: uses.tsc.has(`${id}.${m.name}`),
      };
    });
    modules.push({ id, rows });
  }
  for (const id of Object.keys(claims)) {
    if (!ids.includes(id)) problems.push(`${id}: claimed, but Node has no such built-in module`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`node-coverage: STALE CLAIM — ${p}`);
    process.exit(1);
  }
  const text = `${render(process.version, modules)}\n`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      // a missing file is stale by definition
    }
    if (current !== text) {
      console.error(
        'node-coverage: docs/NODE.md is stale — run `pnpm run docs:node` and commit it',
      );
      process.exit(1);
    }
    console.log('node-coverage: docs/NODE.md is current');
    return;
  }
  writeFileSync(OUT, text);
  console.log(`node-coverage: wrote docs/NODE.md (${String(modules.length)} modules)`);
}

main();
