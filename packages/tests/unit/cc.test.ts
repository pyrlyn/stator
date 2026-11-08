// The C compiler choice (plan/T35): precedence, the `--version` probe and the family flag table.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'vitest';
import { BuildError } from '../../compiler/src/cli/build.ts';
import {
  type CcHost,
  chooseCC,
  classifyCompiler,
  detectCC,
  requireFlagsSupported,
} from '../../compiler/src/cli/cc.ts';
import { type CliOptions, resolveOptions } from '../../compiler/src/cli/config.ts';

const LINUX: CcHost = { darwin: false, systemClang: false };
const MAC: CcHost = { darwin: true, systemClang: true };

test('--cc beats CC, CC beats the default, empty CC is unset', () => {
  const explicit = { command: 'gcc-14', source: '--cc' } as const;
  assert.deepEqual(chooseCC(explicit, { CC: 'cc' }, false, LINUX).choice, explicit);
  assert.deepEqual(chooseCC(undefined, { CC: 'cc' }, false, LINUX).choice, {
    command: 'cc',
    source: 'CC',
  });
  assert.deepEqual(chooseCC(undefined, {}, false, LINUX).choice, {
    command: 'clang',
    source: 'default',
  });
  assert.deepEqual(chooseCC(undefined, { CC: '' }, false, LINUX).choice, {
    command: 'clang',
    source: 'default',
  });
});

test('CC beats config "cc"; config "cc" beats the default', () => {
  const config = { command: 'gcc-14', source: 'config' } as const;
  assert.deepEqual(chooseCC(config, { CC: 'cc' }, false, LINUX).choice, {
    command: 'cc',
    source: 'CC',
  });
  assert.deepEqual(chooseCC(config, {}, false, LINUX).choice, config);
  assert.deepEqual(chooseCC(config, { CC: '' }, false, LINUX).choice, config);
});

const BASE: CliOptions = {
  entry: undefined,
  out: undefined,
  mode: undefined,
  opt: undefined,
  link: [],
  emit: undefined,
  keepC: undefined,
  emitHeader: undefined,
  unitName: undefined,
  bundler: undefined,
  cc: undefined,
  diagnostics: undefined,
  node: undefined,
};

test('--cc beats config "cc"; a relative config path resolves next to the file', () => {
  const file = { path: join('/proj', 'stator.config.json'), config: { cc: './tools/cc' } };
  assert.deepEqual(resolveOptions({ ...BASE, cc: 'gcc' }, { opt: undefined }, file).cc, {
    command: 'gcc',
    source: '--cc',
  });
  assert.deepEqual(resolveOptions(BASE, { opt: undefined }, file).cc, {
    command: join('/proj', 'tools', 'cc'),
    source: 'config',
  });
  const named = { path: file.path, config: { cc: 'gcc-14' } };
  assert.deepEqual(resolveOptions(BASE, { opt: undefined }, named).cc, {
    command: 'gcc-14',
    source: 'config',
  });
  assert.equal(resolveOptions(BASE, { opt: undefined }, undefined).cc, undefined);
});

test('the macOS ASan override applies to the default only; an explicit choice warns', () => {
  assert.deepEqual(chooseCC(undefined, {}, true, MAC), {
    choice: { command: '/usr/bin/clang', source: 'default' },
  });
  assert.equal(chooseCC(undefined, {}, true, LINUX).choice.command, 'clang');
  assert.equal(chooseCC(undefined, {}, false, MAC).choice.command, 'clang');
  const explicit = chooseCC(undefined, { CC: 'clang' }, true, MAC);
  assert.equal(explicit.choice.command, 'clang');
  assert.match(explicit.warning ?? '', /\(from CC\) is used under the ASan runtime/);
  assert.equal(chooseCC(undefined, { CC: 'clang' }, false, MAC).warning, undefined);
});

test('--version banners classify into clang, apple-clang and gcc', () => {
  assert.equal(classifyCompiler('clang version 21.1.8\nTarget: arm64-apple-darwin25'), 'clang');
  assert.equal(
    classifyCompiler('Ubuntu clang version 18.1.3 (1ubuntu1)\nTarget: x86_64-pc-linux-gnu'),
    'clang',
  );
  assert.equal(
    classifyCompiler('Apple clang version 17.0.0 (clang-1700.0.13.5)\nTarget: arm64'),
    'apple-clang',
  );
  assert.equal(
    classifyCompiler(
      'gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0\nCopyright (C) 2023 Free Software Foundation, Inc.',
    ),
    'gcc',
  );
  assert.equal(classifyCompiler('cc (Debian 12.2.0-14) 12.2.0\n'), 'gcc');
  assert.equal(classifyCompiler('tcc version 0.9.27 (x86_64 Linux)'), undefined);
  assert.equal(classifyCompiler(''), undefined);
});

function refusal(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BuildError);
    assert.equal(error.code, 'STA0022');
    assert.match(error.message, pattern);
    return true;
  });
}

test('the probe refuses a missing binary, a failing one and an unknown family', () => {
  const missing = Object.assign(new Error('spawnSync nope ENOENT'), { code: 'ENOENT' });
  refusal(
    () =>
      detectCC({ command: 'nope', source: '--cc' }, () => ({
        status: null,
        stdout: '',
        error: missing,
      })),
    /C compiler "nope" \(from --cc\) not found .* or choose another with --cc=<name\|path>/,
  );
  refusal(
    () => detectCC({ command: '/usr/bin/false', source: 'CC' }, () => ({ status: 1, stdout: '' })),
    /"\/usr\/bin\/false" \(from CC\) failed `--version` \(exit 1\)/,
  );
  refusal(
    () =>
      detectCC({ command: 'odd', source: 'config' }, () => ({ status: 0, stdout: 'Odd C 1.0\n' })),
    /"odd" \(from config "cc"\) is not clang, Apple clang or gcc: `--version` printed "Odd C 1.0"/,
  );
});

test('the probe runs once per command', () => {
  let runs = 0;
  const run = () => {
    runs += 1;
    return { status: 0, stdout: 'gcc (GCC) 14.2.0\n' };
  };
  const first = detectCC({ command: 'stator-test-gcc', source: 'CC' }, run);
  const second = detectCC({ command: 'stator-test-gcc', source: '--cc' }, run);
  assert.equal(first.family, 'gcc');
  assert.deepEqual(second, { command: 'stator-test-gcc', source: '--cc', family: 'gcc' });
  assert.equal(runs, 1);
});

test('gcc refuses -flto=thin by name; clang takes it', () => {
  const gcc = { command: 'gcc', source: 'CC', family: 'gcc' } as const;
  refusal(
    () => requireFlagsSupported(gcc, ['-lm', '-flto=thin'], 'link-flags.txt', 'rebuild it'),
    /"gcc" \(gcc, from CC\) does not take -flto=thin, which link-flags.txt asks for .* — rebuild it/,
  );
  requireFlagsSupported(gcc, ['-lm', '-O2', '-fsanitize=address,undefined'], 'x', 'y');
  requireFlagsSupported({ ...gcc, family: 'clang' }, ['-flto=thin'], 'x', 'y');
});
