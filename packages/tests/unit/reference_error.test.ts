/** Reading a name nothing declares (plan.md §8 step 2a(c)).
 *
 * The invariant under test is the one that is easy to get wrong and expensive when it is: the
 * lowering must keep TWO look-alike failures apart. A name with no runtime declaration (even if
 * the checker synthesizes an expando namespace) is a catchable `ReferenceError`; a real declaration
 * arriving with no binding is a compiler bug (`STA4035`) — the gate must refuse globals the HIR has no
 * vocabulary for. Collapsing them would make the new node swallow compiler bugs silently, which is
 * exactly the failure mode TS2403 demonstrated when a suppression turned `STA0012` into `STA4004`.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { Expression, ReferenceErrorRead } from '../../compiler/src/hir/nodes.ts';
import { lowerSourceFile } from '../../compiler/src/lower/index.ts';
import { createProgram, hirNodes, lowerSource } from './helpers.ts';

/** The first expression-statement's expression, whatever it is. */
function firstExpression(code: string, fileName: string): Expression {
  const { module } = lowerSource(code, fileName);
  const first = module.statements[0];
  assert.ok(first !== undefined, 'expected at least one statement');
  assert.equal(first.kind, 'expression-statement');
  return first.expression;
}

test('an unresolvable name lowers to a reference-error carrying that name', () => {
  const expr = firstExpression('missingName;\n', '/t.js');
  assert.equal(expr.kind, 'reference-error');
  assert.equal((expr as ReferenceErrorRead).name, 'missingName');
});

test('its type is unknown, which is what makes a boundary get inserted downstream', () => {
  // Not `undefined` — the C value the emitter returns is an implementation detail of needing a
  // value at all. STA4096 pins this; the assertion is here so the reason is testable, not just
  // documented.
  const expr = firstExpression('missingName;\n', '/t.js');
  assert.equal(expr.type.kind, 'unknown');
});

test('typeof an unresolvable name is the string "undefined", not a throw', () => {
  // §13.5.1.1 short-circuits before resolving the reference, which is why this is the idiom for
  // asking whether a global exists. The node must be a literal: a `typeof` over a reference-error
  // would throw before the operator ever ran.
  const expr = firstExpression('typeof missingName;\n', '/t.js');
  assert.equal(expr.kind, 'string-literal');
  assert.equal(expr.kind === 'string-literal' ? expr.value : '', 'undefined');
});

test('parentheses do not hide the typeof short-circuit', () => {
  const expr = firstExpression('typeof (missingName);\n', '/t.js');
  assert.equal(expr.kind, 'string-literal');
});

test('a name the checker DOES resolve never becomes a reference-error', () => {
  // `undefined` resolves to a real symbol and has its own lowering. If the symbol test were
  // dropped, the `!binding` branch would catch this first and answer with a ReferenceError for a
  // name that is perfectly defined.
  const expr = firstExpression('undefined;\n', '/t.js');
  assert.equal(expr.kind, 'undefined-literal');
});

test('a declared binding is still an ordinary identifier', () => {
  const { module } = lowerSource('const declared = 1;\ndeclared;\n', '/t.js');
  const second = module.statements[1];
  assert.ok(second !== undefined);
  assert.equal(second.kind, 'expression-statement');
  assert.equal(second.kind === 'expression-statement' ? second.expression.kind : '', 'identifier');
});

test('a simple assignment to an undeclared name keeps its right side, then throws', () => {
  // Node evaluates the RHS before PutValue fails, so its side effects are observable. The block is
  // `flatten` so this desugaring introduces no scope of its own.
  const { module } = lowerSource('missing = 1;\n', '/t.js');
  const first = module.statements[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, 'block');
  if (first.kind !== 'block') return;
  assert.equal(first.flatten, true);
  assert.equal(first.statements.length, 2);
  const [value, thrown] = first.statements;
  assert.equal(value?.kind, 'expression-statement');
  assert.equal(thrown?.kind, 'expression-statement');
  assert.equal(
    thrown?.kind === 'expression-statement' ? thrown.expression.kind : '',
    'reference-error',
  );
});

test('a compound assignment throws on the read, with no right side kept', () => {
  // `missing += f()` reads the target first, so `f` never runs — one statement, not a block.
  const { module } = lowerSource('missing += 1;\n', '/t.js');
  const first = module.statements[0];
  assert.equal(first?.kind, 'expression-statement');
  assert.equal(
    first?.kind === 'expression-statement' ? first.expression.kind : '',
    'reference-error',
  );
});

test('an update of an undeclared name throws on the read', () => {
  for (const code of ['missing++;\n', '--missing;\n']) {
    const { module } = lowerSource(code, '/t.js');
    const first = module.statements[0];
    assert.equal(
      first?.kind === 'expression-statement' ? first.expression.kind : '',
      'reference-error',
      code,
    );
  }
});

test('writes never reach the internal "assigned before declaration" error', () => {
  // STA4034 is a compiler bug report. Suppressing TS2304 without this path would have turned every
  // `missing = 1` in js mode into one — the exact failure TS2403 demonstrated (plan-notes 197).
  for (const code of ['missing = 1;\n', 'missing += 1;\n', 'missing++;\n']) {
    const { diagnostics } = lowerSource(code, '/t.js');
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      [],
      code,
    );
  }
});

test('JS expando namespace symbols do not create runtime bindings', () => {
  for (const code of [
    'missing.a = 1;',
    'missing[0] = 1;',
    'missing["a"] = 1;',
    'missing.a = 1; missing;',
    'missing.a = 1; missing = 2;',
    'missing.a = 1; missing += 2;',
    'missing.a = 1; missing++;',
  ]) {
    const { module, diagnostics } = lowerSource(code, '/t.js');
    assert.deepEqual(diagnostics, [], code);
    assert.ok(
      hirNodes(module).some((node) => node.kind === 'reference-error'),
      code,
    );
  }
});

test('typeof a synthesized JS namespace still short-circuits the missing reference', () => {
  const expr = firstExpression('typeof (missing); missing.a = 1;', '/t.js');
  assert.equal(expr.kind, 'string-literal');
  assert.equal(expr.kind === 'string-literal' ? expr.value : '', 'undefined');
});

test('expando declarations merged with a real binding do not become reference-errors', () => {
  const { module, diagnostics } = lowerSource('const real = { a: 0 }; real.a = 1; real;', '/t.js');
  assert.deepEqual(diagnostics, []);
  assert.ok(hirNodes(module).every((node) => node.kind !== 'reference-error'));
  const read = module.statements[2];
  assert.equal(read?.kind === 'expression-statement' ? read.expression.kind : '', 'identifier');
});

test('real declarations without lowered bindings retain their internal diagnostic', () => {
  for (const code of [
    'Reflect;',
    'later.a = 1; let later;',
    'declared.a = 1; declare const declared: { a: number };',
  ]) {
    // Bypass the gate/checker deliberately: these are lowering-invariant tests, not accepted input.
    const { program, sourceFile } = createProgram(
      code,
      code.includes('declare ') ? '/t.ts' : '/t.js',
    );
    const { diagnostics } = lowerSourceFile(sourceFile, program.getTypeChecker());
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === 'STA4035'),
      code,
    );
  }
});
