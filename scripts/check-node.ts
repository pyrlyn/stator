// Preflight for `pnpm run ci` (plan.md Task 6.2a): refuse to run the suites on the
// wrong Node.
//
// The golden and differential runners diff against the pinned Node in `.node-version`
// (the oracle: `STATOR_NODE` when set and non-empty, else `process.execPath` — mirrors
// `packages/tests/support/node-path.ts`, by hand because this runs pre-install), so a
// suite that is green under any other major proves nothing about the ground truth.
// Compare FULL versions, not majors: the golden and differential ground truth is the pinned
// Node and only that Node (Task 6.5), so 26.8.2 passing as "26" does not prove 26.7.0 ran.
// A patch-level move is a deliberate re-baseline (146 golden fixtures, the Test262 ratchet,
// bench/baseline.json), never silent drift — plan.md §9 Task 6.12.
// Dependency-free on purpose: this runs before anything is installed, so it cannot import
// anything that is not Node itself.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function exactOf(version: string): string {
  return version.trim().replace(/^v/, '');
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pinnedRaw: string;
try {
  pinnedRaw = readFileSync(join(root, '.node-version'), 'utf8');
} catch {
  console.error('stator: cannot read .node-version — run from the workspace root');
  process.exit(1);
}
const pinnedLine = pinnedRaw.split('\n').at(0) ?? '';
const pinned = pinnedLine.trim();
if (pinned === '') {
  console.error('stator: .node-version is empty — the Node pin is the test ground truth');
  process.exit(1);
}

const running = process.version;
if (exactOf(running) !== exactOf(pinned)) {
  console.error(
    `stator: node ${running} is not the pinned Node (${pinned} from .node-version) — ` +
      'suites diff against the pinned Node, so a run here proves nothing',
  );
  console.error('stator: fix: mise exec node -- <your command>');
  process.exit(1);
}

console.log(`stator: node ${running} matches .node-version (${pinned})`);

// `mise.toml` must select exactly what `.node-version` names: a bare `"26"` drifts with every
// patch release and the drift is silent until a formatting byte moves. `engines` in
// `package.json` stays a range floor (`>=24`) on purpose — it is not a pin, so there is nothing
// to compare it against. TOML is parsed with one regex (dependency-free rule above); if the file
// or the line is absent the check is skipped rather than failed — an environment without mise
// still gets the exact running-vs-pinned verdict above.
try {
  const mise = readFileSync(join(root, 'mise.toml'), 'utf8');
  const selected = /^node\s*=\s*"([^"]+)"/m.exec(mise)?.[1];
  if (selected !== undefined && exactOf(selected) !== exactOf(pinned)) {
    console.error(
      `stator: mise.toml selects node "${selected}" but .node-version pins ${pinned} — ` +
        'pick one pin (Task 6.12) or suites may run under a Node the ground truth never named',
    );
    console.error('stator: fix: set mise.toml `node` to the exact .node-version value');
    process.exit(1);
  }
} catch {
  // No mise.toml here — the running-vs-pinned verdict above is the whole preflight.
}

// The oracle is `STATOR_NODE` when set and non-empty, else the running Node — the same
// resolution as `nodePath()`. When set to another binary, that binary IS the ground truth
// the suites diff against, so its major is checked too. Unset means the oracle is the
// running Node, already verified above, and no second probe is needed.
const oracle = process.env['STATOR_NODE'];
if (oracle !== undefined && oracle !== '' && oracle !== process.execPath) {
  const probed = spawnSync(oracle, ['--version'], { encoding: 'utf8' });
  const oracleVersion = (probed.stdout ?? '').trim();
  if (probed.status !== 0 || oracleVersion === '') {
    console.error(
      `stator: cannot run the Node oracle ${oracle} (--version failed) — suites diff against it, so a run here proves nothing`,
    );
    console.error('stator: fix: STATOR_NODE="$(mise exec node -- which node)" <your command>');
    process.exit(1);
  }
  if (exactOf(oracleVersion) !== exactOf(pinned)) {
    console.error(
      `stator: node oracle ${oracle} is ${oracleVersion}, not the pinned Node (${pinned} from .node-version) — ` +
        'suites diff against the pinned Node, so a run here proves nothing',
    );
    console.error('stator: fix: STATOR_NODE="$(mise exec node -- which node)" <your command>');
    process.exit(1);
  }
  console.log(`stator: node oracle ${oracle} (${oracleVersion}) matches .node-version (${pinned})`);
}
