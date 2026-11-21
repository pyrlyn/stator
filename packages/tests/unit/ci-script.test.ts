// `ci.sh`, the local mirror of CI (plan.md §4 Task 1.0 step 10): every repository script it runs
// must exist. Task 6.15 ported `scripts/check-node.mjs` to TypeScript and `ci.sh` kept the old
// name, so `./ci.sh` died on its first command while `pnpm run ci` stayed green.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The repository paths `ci.sh` hands to `node`, one per command line. */
function nodeScripts(script: string): string[] {
  const paths: string[] = [];
  for (const line of script.split('\n')) {
    const command = line.trim();
    if (command.startsWith('#')) continue;
    const match = /^node\s+(\S+)/.exec(command);
    if (match?.[1] !== undefined) paths.push(match[1]);
  }
  return paths;
}

test('every script ci.sh runs with node exists', () => {
  const scripts = nodeScripts(readFileSync(join(ROOT, 'ci.sh'), 'utf8'));
  assert.ok(scripts.length > 0, 'ci.sh runs no node script; the check would prove nothing');
  for (const path of scripts) {
    assert.ok(existsSync(join(ROOT, path)), `ci.sh runs "node ${path}", which does not exist`);
  }
});

test('ci.sh runs the same Node preflight as pnpm run ci', () => {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ci =
    typeof pkg === 'object' &&
    pkg !== null &&
    'scripts' in pkg &&
    typeof pkg.scripts === 'object' &&
    pkg.scripts !== null &&
    'ci' in pkg.scripts &&
    typeof pkg.scripts.ci === 'string'
      ? pkg.scripts.ci
      : '';
  const preflight = /^node (scripts\/check-node\.\w+)/.exec(ci)?.[1];
  assert.ok(preflight !== undefined, 'pnpm run ci no longer starts with the Node preflight');
  assert.ok(
    nodeScripts(readFileSync(join(ROOT, 'ci.sh'), 'utf8')).includes(preflight),
    `ci.sh does not run ${preflight}`,
  );
});
