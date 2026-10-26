import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { Statement } from '../../compiler/src/hir/nodes.ts';
import { rewriteModule, rewriteStatements } from '../../compiler/src/passes/rewrite.ts';
import { consoleLog, exprStmt, makeModule, num } from './helpers.ts';

test('unchanged walks preserve frozen trees and call list hooks, including empty lists', () => {
  const args = Object.freeze([Object.freeze(num(1)), Object.freeze(num(2))]);
  const log = Object.freeze(consoleLog(args));
  const statement = Object.freeze(exprStmt(log));
  const statements = Object.freeze([statement]);
  const module = Object.freeze(makeModule(statements));
  for (const withStatementHook of [false, true]) {
    const seen: string[] = [];
    assert.equal(
      rewriteModule(module, {
        expression: (expr) => {
          seen.push(expr.kind);
          return expr;
        },
        ...(withStatementHook
          ? {
              statement: (stmt: Statement) => {
                seen.push(stmt.kind);
                return [stmt];
              },
            }
          : {}),
        statements: (items) => {
          assert.equal(items, statements);
          seen.push('list');
          return items;
        },
      }),
      module,
    );
    assert.deepEqual(seen, [
      'number-literal',
      'number-literal',
      'console-log',
      ...(withStatementHook ? ['expression-statement'] : []),
      'list',
    ]);
  }
  const empty = Object.freeze([]);
  let calls = 0;
  assert.equal(
    rewriteStatements(empty, {
      statements: (items) => {
        calls++;
        return items;
      },
    }),
    empty,
  );
  assert.equal(calls, 1);
});

test('expression rewrites copy only the affected path and visit each sibling once in order', () => {
  const args = Object.freeze([num(1), num(2), num(3)]);
  const log = consoleLog(args);
  const before = exprStmt(num(10));
  const after = exprStmt(num(20));
  const statement = exprStmt(log);
  const module = makeModule(Object.freeze([before, statement, after]));
  for (const value of [1, 2, 3]) {
    const seen: number[] = [];
    const replacement = num(-value);
    const result = rewriteModule(module, {
      expression: (expr) => {
        if (expr.kind !== 'number-literal') return expr;
        seen.push(expr.value);
        return expr.value === value ? replacement : expr;
      },
    });
    assert.deepEqual(seen, [10, 1, 2, 3, 20]);
    assert.equal(result.statements[0], before);
    assert.equal(result.statements[2], after);
    const changed = result.statements[1];
    assert.ok(
      changed?.kind === 'expression-statement' && changed.expression.kind === 'console-log',
    );
    assert.notEqual(changed.expression.args, args);
    assert.deepEqual(
      changed.expression.args,
      args.map((arg) => (arg.value === value ? replacement : arg)),
    );
    assert.equal(module.statements[1], statement);
    assert.equal(log.args, args);
  }
});

test('statement rewrites preserve prefixes and suffixes when deleting, replacing or expanding', () => {
  const statements = Object.freeze([exprStmt(num(1)), exprStmt(num(2)), exprStmt(num(3))]);
  const extra = exprStmt(num(4));
  for (let index = 0; index < statements.length; index++) {
    for (const replacement of [[], [extra], [extra, extra]]) {
      const seen: Statement[] = [];
      const result = rewriteStatements(statements, {
        statement: (stmt) => {
          seen.push(stmt);
          return stmt === statements[index] ? replacement : [stmt];
        },
        statements: (items) => {
          assert.deepEqual(items, [
            ...statements.slice(0, index),
            ...replacement,
            ...statements.slice(index + 1),
          ]);
          return items;
        },
      });
      assert.deepEqual(seen, statements);
      assert.notEqual(result, statements);
    }
  }
  assert.deepEqual(rewriteStatements(statements, { statement: () => [] }), []);
});

test('large statement expansions do not depend on the engine argument limit', () => {
  const stmt = exprStmt(num(1));
  const expanded = Array.from({ length: 150_000 }, () => stmt);
  assert.deepEqual(rewriteStatements([stmt], { statement: () => expanded }), expanded);
});
