// Re-vendor tool: refetch runtime/vendor/<name>/ from upstream at a given ref.
//
//   node packages/runtime/vendor/update.ts quickjs-ng [ref]   # ref defaults to the one VENDOR.md records
//   node packages/runtime/vendor/update.ts fdlibm [ref]
//   node packages/runtime/vendor/update.ts --check            # offline: manifest still matches the tree
//
// AGENTS.md forbids hand-editing runtime/vendor/, so "update the vendored libs" has to be a
// script or it becomes exactly the hand-edit that rule forbids. Provenance stays a human edit:
// the Version rows carry reasoning a script cannot author ("the V8 inside the pinned Node"), so
// this prints the rows to paste rather than rewriting them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

interface PortStep {
  readonly from: string;
  readonly to: string;
  readonly with: string;
}

interface Vendor {
  readonly repo: string;
  readonly files: readonly string[];
  readonly port?: PortStep;
}

// Upstream paths are repo-root-relative; ours are flat, because we take a handful of files out of
// a tree we do not otherwise want. Adding a file here is the whole cost of following an upstream
// split (see each VENDOR.md for what is deliberately NOT taken).
const VENDORS: Record<string, Vendor> = {
  'quickjs-ng': {
    repo: 'quickjs-ng/quickjs',
    files: [
      'libregexp.c',
      'libregexp.h',
      'libregexp-opcode.h',
      'libunicode.c',
      'libunicode.h',
      'libunicode-table.h',
      'cutils.h',
      'LICENSE',
    ],
  },
  fdlibm: {
    repo: 'v8/v8',
    // fdlibm.c is generated, not copied; LICENSE here is hand-assembled (SunSoft + V8's
    // BSD-3-Clause) rather than a file that exists upstream, so neither is fetched.
    files: [],
    port: { from: 'src/base/ieee754.cc', to: 'fdlibm.c', with: 'port.ts' },
  },
};

/** The ref VENDOR.md records: the first backticked token on its `| Version |` row. */
function pinnedRef(name: string): string {
  const text = readFileSync(join(HERE, name, 'VENDOR.md'), 'utf8');
  const row = /^\| Version \|(.*)$/m.exec(text);
  const cell = row?.[1];
  const ref = cell === undefined ? null : /`([^`]+)`/.exec(cell);
  const token = ref?.[1];
  if (token === undefined) {
    throw new Error(`${name}/VENDOR.md: no backticked version on its "| Version |" row`);
  }
  return token;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${String(res.status)} ${res.statusText} — ${url}`);
  }
  return await res.text();
}

const raw = (repo: string, ref: string, path: string): string =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

/** The commit a tag resolves to — the provenance a moving ref would otherwise lose. */
async function resolveCommit(repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { Accept: 'application/vnd.github.sha' },
  });
  return res.ok ? (await res.text()).trim() : '(unresolved)';
}

/** Offline: every manifest entry names a directory whose files and version pin are really there. */
function check(): void {
  for (const [name, v] of Object.entries(VENDORS)) {
    const ref = pinnedRef(name);
    const portFiles = v.port === undefined ? [] : [v.port.to, v.port.with];
    const missing = [...v.files, ...portFiles].filter((f) => !existsSync(join(HERE, name, f)));
    if (missing.length > 0) {
      throw new Error(`${name}: manifest names files that are not vendored: ${missing.join(' ')}`);
    }
    const count = v.files.length + (v.port === undefined ? 0 : 1);
    process.stdout.write(`ok ${name} @ ${ref} (${String(count)} files)\n`);
  }
}

async function update(name: string, ref: string): Promise<void> {
  const v = VENDORS[name];
  if (v === undefined) throw new Error(`unknown vendor ${name}`);
  const dir = join(HERE, name);

  for (const file of v.files) {
    writeFileSync(join(dir, file), await fetchText(raw(v.repo, ref, file)));
    process.stdout.write(`fetched ${name}/${file}\n`);
  }

  if (v.port !== undefined) {
    // The upstream C++ never lands in the tree: it is input to the converter, and keeping it
    // would make "what is vendored" ambiguous.
    const tmp = mkdtempSync(join(tmpdir(), 'stator-vendor-'));
    try {
      const src = join(tmp, 'upstream.cc');
      writeFileSync(src, await fetchText(raw(v.repo, ref, v.port.from)));
      const port = spawnSync(
        process.execPath,
        [join(dir, v.port.with), src, join(dir, v.port.to)],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (port.status !== 0) {
        throw new Error(
          `${v.port.with} failed (exit ${String(port.status)}) — upstream may have moved`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const commit = await resolveCommit(v.repo, ref);
  const today = new Date().toISOString().slice(0, 10);
  if (readFileSync(join(dir, 'VENDOR.md'), 'utf8').includes(ref) === false) {
    process.stdout.write(
      `\n${name}/VENDOR.md still records the previous ref. Update its provenance rows:\n` +
        `| Version | \`${ref}\` |\n| Commit | \`${commit}\` |\n| Vendored | ${today} |\n`,
    );
  }
  process.stdout.write(
    `\n${name} @ ${ref} (${commit})\nnow: just runtime && pnpm run test:runtime && pnpm run test:golden\n`,
  );
  spawnSync('git', ['status', '--short', '--', dir], { stdio: ['ignore', 'inherit', 'inherit'] });
}

const name = process.argv[2];
const refArg = process.argv[3];
if (name === '--check') {
  check();
} else if (name === undefined || VENDORS[name] === undefined) {
  process.stderr.write(`usage: node update.ts <${Object.keys(VENDORS).join('|')}> [ref]\n`);
  process.stderr.write('       node update.ts --check\n');
  process.exit(2);
} else {
  await update(name, refArg ?? pinnedRef(name));
}
