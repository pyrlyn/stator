// Compares the Zig lexer with the TypeScript scanner on real files (docs/zig-core.md):
//
//   cd packages/compiler-zig && zig build
//   node packages/compiler-zig/tools/compare-corpus.ts $(git ls-files '*.ts')
//
// Prints the first differing token of each mismatching file and exits 1 when any differ.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokens } from './ts-tokens.ts';

const BIN = join(import.meta.dirname, '..', 'zig-out', 'bin', 'statorc-zig');
let same = 0;
let differ = 0;
for (const file of process.argv.slice(2)) {
  const expected = tokens(readFileSync(file, 'utf8'));
  const actual = execFileSync(BIN, ['tokens', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (actual === expected) {
    same += 1;
    continue;
  }
  differ += 1;
  const want = expected.split('\n');
  const got = actual.split('\n');
  const line = want.findIndex((entry, i) => entry !== got[i]);
  process.stdout.write(`${file}: zig ${got[line] ?? '<eof>'} | ts ${want[line] ?? '<eof>'}\n`);
}
process.stdout.write(`compare-corpus: ${String(same)} same, ${String(differ)} differ\n`);
if (differ > 0) {
  process.exit(1);
}
