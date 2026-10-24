import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { emitC } from '../../compiler/src/codegen/index.ts';
import { hirNodes, lowerSource } from './helpers.ts';

function kindsOf(code: string): string[] {
  const { module, diagnostics } = lowerSource(code, '/test.js');
  assert.equal(diagnostics.length, 0, diagnostics.map((d) => d.message).join('\n'));
  return hirNodes(module).map((n) => n.kind);
}

test('an untyped property read and write lower to dyn-field nodes', () => {
  const kinds = kindsOf('function f(o) { o.x = 1; return o.x; }');
  assert.ok(kinds.includes('dyn-field-assignment'), `got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('dyn-field-access'), `got ${kinds.join(', ')}`);
});

test('an untyped computed index lowers to index-access / index-assignment on Unknown', () => {
  const kinds = kindsOf('function f(o, k, v) { o[k] = v; return o[k]; }');
  assert.ok(kinds.includes('index-assignment'), `got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('index-access'), `got ${kinds.join(', ')}`);
});

test('an empty object literal lowers to a dyn-object-literal so it can grow', () => {
  const kinds = kindsOf('let o = {}; o.x = 1;');
  assert.ok(kinds.includes('dyn-object-literal'), `got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('dyn-field-assignment'), `got ${kinds.join(', ')}`);
});

test('every dyn-method-call carries notFunction so a miss throws Node TypeError (plan-notes 372)', () => {
  for (const code of [
    'function f(a) { return a.nosuch(); }',
    'function f(a) { return a.push(1); }',
    'function f(a) { return a.toString(); }',
    'function f(o) { return o.m(); }',
  ]) {
    const { module, diagnostics } = lowerSource(code, '/test.js');
    assert.deepEqual(diagnostics, [], code);
    const calls = hirNodes(module).filter((n) => n.kind === 'dyn-method-call');
    assert.ok(calls.length > 0, code);
    for (const call of calls) {
      const notFunction = (call as { notFunction?: unknown }).notFunction;
      assert.equal(typeof notFunction, 'string', `${code}: notFunction missing`);
      assert.ok((notFunction as string).length > 0, code);
    }
  }
});

test('the emitter writes the non-closure check before a dyn-method-call (plan-notes 372)', () => {
  const { module, diagnostics } = lowerSource('function f(a) { return a.nosuch(); }', '/test.js');
  assert.deepEqual(diagnostics, []);
  const lines = emitC(module)
    .split('\n')
    .filter((line) => !line.startsWith('#line'));
  const index = lines.findIndex((line) => line.includes('jsrt_get_prop('));
  assert.ok(index >= 0, 'jsrt_get_prop missing');
  assert.match(
    lines.slice(index, index + 8).join('\n'),
    /jsrt_throw_error\(&jsrt_class_type_error/,
  );
});
