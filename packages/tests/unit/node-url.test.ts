// `fileHrefToPath` against Node's `fileURLToPath` (pyrlyn/stator#335): query/fragment stripped,
// encoded `/` and a non-localhost host refused with Node's codes. The comparison runs in a child
// so the `std/encoding` shim hook does not leak into other unit tests.

import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'file-href-to-path-probe.ts');

test('fileHrefToPath matches Node fileURLToPath, including the #335 cases', async () => {
  const result = await execa(process.execPath, [PROBE], {
    reject: false,
    stripFinalNewline: false,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fileHrefToPath matches fileURLToPath for \d+ cases/);
});
