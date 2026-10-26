// Regenerates the lexer golden files (docs/zig-core.md): every `src/testdata/samples/*.ts` is
// scanned with the TypeScript scanner the frontend uses, and its token stream is written to
// `src/testdata/golden/<name>.tokens` as `Kind<TAB>start<TAB>end` lines.
//
//   node packages/compiler-zig/tools/gen-golden.ts          # rewrite the golden files
//   node packages/compiler-zig/tools/gen-golden.ts --check  # fail when one is stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tokens } from './ts-tokens.ts';

const ROOT = join(import.meta.dirname, '..', 'src', 'testdata');
const SAMPLES = join(ROOT, 'samples');
const GOLDEN = join(ROOT, 'golden');

const check = process.argv.includes('--check');
let stale = 0;
for (const file of readdirSync(SAMPLES)
  .filter((f) => f.endsWith('.ts'))
  .sort()) {
  const out = join(GOLDEN, `${basename(file, '.ts')}.tokens`);
  const expected = tokens(readFileSync(join(SAMPLES, file), 'utf8'));
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(out, 'utf8');
    } catch {
      actual = '';
    }
    if (actual !== expected) {
      process.stderr.write(`gen-golden: ${out} is stale\n`);
      stale += 1;
    }
  } else {
    writeFileSync(out, expected);
  }
}
if (stale > 0) {
  process.exit(1);
}
