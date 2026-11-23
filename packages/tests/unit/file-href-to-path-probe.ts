// Compare `fileHrefToPath` with Node's `fileURLToPath` (pyrlyn/stator#335). Imports the real
// helper after remapping `std/encoding` to a pure UTF-8 shim, the same idea as the QA probe.
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'std/encoding') {
      return { url: pathToFileURL(join(HERE, 'std-encoding-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === 'std/os') {
      return { url: pathToFileURL(join(HERE, 'std-os-shim.ts')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { fileHrefToPath } = await import(
  pathToFileURL(join(HERE, '..', '..', 'node', 'src', 'internal', 'url.ts')).href
);

/** Cases that already matched Node, plus the six that #335 names. Normalization of `.` / `..`
 * and the `file:/` single-slash form are not in scope: they were not among the mismatches. */
const CASES: readonly string[] = [
  'file:///a%2Fb',
  'file:///a%2fb',
  'file:///a#frag',
  'file:///a?q=1',
  'file://host/a',
  'file://localhost/a',
  'file:///a',
  'file:///',
  'file://localhost/',
  'file://localhost/a?q=1#f',
  'file:///a%5Cb',
  'file:///a%5cb',
  'file:///tmp/foo',
  'file:///tmp/foo%20bar',
  'file:///a%3Fb',
  'file:///a%23b',
  'file://HOST/a',
  'file://LocalHost/a',
  'file://127.0.0.1/a',
  'file:////a',
  'file:///a?q#f',
  'file:///a#f?q',
  'file://localhost',
  'file://',
  'file:///a%2Fb/c',
  'file:///a%2fb/c',
  'file:///a%252Fb',
  'file:///caf%C3%A9',
  'file:///a%20b',
  'file:///a//b',
  'file://localhost/a%2Fb',
  'file:///x?q',
  'file://host/x',
  'file:///x',
  'file://localhost/x',
  'file:///empty?',
  'file:///empty#',
  'file://localhost/a?q',
  'file://localhost/a#f',
  'file:///A',
  'file://////a',
  'file://[::1]/a',
  'file:///foo/bar',
  'file:///foo%2Bbar',
  'file://localhost/tmp/x',
  'file:///space%20%20x',
  'file:///a%2Fb%2Fc',
];

interface Result {
  readonly ok: boolean;
  readonly value?: string;
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
}

function probe(fn: (href: string) => string, href: string): Result {
  try {
    return { ok: true, value: fn(href) };
  } catch (error) {
    const failure = error as { readonly name?: string; readonly code?: string; readonly message?: string };
    return {
      ok: false,
      ...(failure.name !== undefined ? { name: failure.name } : {}),
      ...(failure.code !== undefined ? { code: failure.code } : {}),
      ...(failure.message !== undefined ? { message: failure.message } : {}),
    };
  }
}

const mismatches: string[] = [];
for (const href of CASES) {
  const ours = probe(fileHrefToPath as (href: string) => string, href);
  const node = probe(fileURLToPath, href);
  if (JSON.stringify(ours) !== JSON.stringify(node)) {
    mismatches.push(`${href}\n  ours ${JSON.stringify(ours)}\n  node ${JSON.stringify(node)}`);
  }
}

if (mismatches.length !== 0) {
  console.error(`${mismatches.length} of ${CASES.length} cases differ:\n${mismatches.join('\n')}`);
  process.exit(1);
}

console.log(`fileHrefToPath matches fileURLToPath for ${CASES.length} cases`);
