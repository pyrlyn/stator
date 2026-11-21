/* vite-stator (plan.md §11d T12.2, docs/BUNDLER.md §2–§5): the default adapter against the real
 * Vite, and the `stator()` plugin through `vite build` on `examples/vite`. The goldens `pkg_*`
 * cover the program side byte-for-byte; this file covers what only the adapter can show. */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, test } from 'vitest';
import { adapter } from 'vite-stator';
import { compile, vendorEntry } from '../../compiler/src/api.ts';
import { NATIVE_ONLY } from './helpers.ts';

/* `NATIVE_ONLY` throughout: the last test runs a binary, and the first two compare POSIX paths. */
const EXAMPLE = realpathSync(fileURLToPath(new URL('../../../examples/vite/', import.meta.url)));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'stator-vite-')));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A package of forty functions, `f1` … `f40`. */
function forty(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `export function f${String(index + 1)}(x) {\n  let acc = x;\n` +
      `  for (let k = 0; k < ${String(index + 1)}; k++) acc = (acc * 31 + k) % 1000003;\n` +
      '  return acc;\n}\n',
  ).join('\n');
}

const PACKAGE_JSON = (name: string): string =>
  JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' });

test(
  'the adapter tree-shakes: one import of forty functions bundles one',
  NATIVE_ONLY,
  async () => {
    const root = project({
      'main.js': "import { f7 } from 'forty';\nconsole.log(f7(12));\n",
      'node_modules/forty/package.json': PACKAGE_JSON('forty'),
      'node_modules/forty/index.js': forty(),
    });
    const entry = vendorEntry(join(root, 'main.js'), 'js');
    assert.ok(entry !== undefined);
    const bundle = await adapter.bundle(entry, { external: [/^node:/, /^std\//] });
    assert.match(bundle.code, /function f7\(x\)/);
    assert.equal(bundle.code.match(/function f\d+\(/g)?.length, 1);
    // Sources come out relative to `resolveDir`, the contract (docs/BUNDLER.md §5).
    assert.deepEqual(bundle.map.sources, ['node_modules/forty/index.js']);
    assert.deepEqual(bundle.inputs, [join(root, 'node_modules/forty/index.js')]);
  },
);

test(
  'require of a built-in becomes an import; std/* and node:* imports stay external',
  NATIVE_ONLY,
  async () => {
    const root = project({
      'main.cjs':
        "'use strict';\nconst path = require('path');\nconst { f } = require('esm');\nconsole.log(path.basename('/a/b.js'), f('/x/y'));\n",
      'node_modules/esm/package.json': PACKAGE_JSON('esm'),
      'node_modules/esm/index.js':
        "import { basename } from 'path';\nimport { sep } from 'node:path';\nimport env from 'std/env';\n" +
        'export const f = (p) => basename(p) + sep + typeof env;\n',
    });
    const entry = vendorEntry(join(root, 'main.cjs'), 'js', true);
    assert.ok(entry !== undefined);
    const bundle = await adapter.bundle(entry, {
      external: [/^node:/, ...builtinModules, /^std\//],
    });
    assert.match(bundle.code, /^import \* as \w+ from "path";$/m);
    assert.match(bundle.code, /^import \{ sep \} from "node:path";$/m);
    assert.match(bundle.code, /^import env from "std\/env";$/m);
    // No `__require` through `createRequire`, and no leftover `import "node:module"`.
    assert.doesNotMatch(bundle.code, /createRequire|node:module|__require\(/);
  },
);

test(
  'the default adapter loads by name, and a package diagnostic maps to its file',
  NATIVE_ONLY,
  async () => {
    const root = project({
      'main.js': "import { make } from 'proxied';\nconsole.log(make());\n",
      'node_modules/proxied/package.json': PACKAGE_JSON('proxied'),
      'node_modules/proxied/index.js': 'export function make() {\n  return new Proxy({}, {});\n}\n',
    });
    const result = await compile({ entry: join(root, 'main.js'), mode: 'js' });
    assert.equal(result.error, undefined, result.error?.message ?? '');
    const [diagnostic] = result.diagnostics;
    assert.ok(diagnostic !== undefined, result.stderr);
    assert.equal(diagnostic.code, 'STA1214');
    assert.equal(diagnostic.file, join(root, 'node_modules/proxied/index.js'));
    assert.equal(diagnostic.line, 2);
  },
);

test(
  'examples/vite: `vite build` writes a binary that prints what Node prints',
  NATIVE_ONLY,
  () => {
    const vite = join(EXAMPLE, 'node_modules/.bin/vite');
    const built = spawnSync(vite, ['build'], { cwd: EXAMPLE, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.match(built.stdout, /stator: built .*dist\/hello/);
    const node = spawnSync(process.execPath, [join(EXAMPLE, 'src/main.js')], { encoding: 'utf8' });
    const binary = spawnSync(join(EXAMPLE, 'dist/hello'), { encoding: 'utf8' });
    assert.equal(binary.stdout, node.stdout, binary.stderr);
    assert.match(node.stdout, /Hello, Stator!/);
  },
);
