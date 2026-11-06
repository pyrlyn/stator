/* Optimization passes (Tasks 3.6–3.9) — what they do, and the more important half: what they
 * decline to do.
 *
 * The golden fixtures already prove the OUTPUT is unchanged, and that is the property that matters:
 * an optimizer whose only visible effect is a faster binary is a correct one. But they would keep
 * passing if `optimize` were the identity function, so the folding and elimination themselves need
 * assertions on the TREE. And a golden fixture cannot show a refusal at all — an unfolded `f() + 1`
 * and a wrongly folded one print the same thing right up until `f` has a side effect. Half the
 * tests here are therefore negative, and each names the condition that stopped the rewrite.
 */

import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type {
  Expression,
  Module,
  NumberLiteral,
  StringLiteral,
} from '../../compiler/src/hir/nodes.ts';
import { verifyHir } from '../../compiler/src/hir/verify.ts';
import {
  constFold,
  eliminateDeadCode,
  inlineCalls,
  optimize,
} from '../../compiler/src/passes/index.ts';
import { hirNodes, lowerSource } from './helpers.ts';

/** Lower and optimize, asserting the lowering itself was clean. */
function optimized(code: string): Module {
  const { module, diagnostics } = lowerSource(code);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    [],
    'lowering should be clean',
  );
  return optimize(module);
}

function kinds(root: unknown): string[] {
  return hirNodes(root).map((n) => n.kind);
}

/** The value of the sole argument to the program's single `console.log`, which is how most of these
 * tests read a folded result: the fixture computes one expression and prints it. */
function loggedValue(module: Module): Expression | undefined {
  const log = hirNodes(module).find((n) => n.kind === 'console-log');
  return (log as { args?: readonly Expression[] } | undefined)?.args?.[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Const-fold

test('arithmetic over literals folds to one literal, bottom-up in a single pass', () => {
  const value = loggedValue(optimized('console.log(1 + 2 * 3);'));
  assert.equal(value?.kind, 'number-literal');
  assert.equal((value as NumberLiteral).value, 7);
});

test('folding uses JavaScript semantics, not C: /0 is Infinity and 0/0 is NaN', () => {
  // The reason to fold with the language's own operators rather than a reimplementation. C's `/`
  // on integers would trap here, and any hand-written table would have to get both of these right
  // to no benefit -- Node computed the golden output too.
  const inf = loggedValue(optimized('console.log(1 / 0);'));
  assert.equal((inf as NumberLiteral).value, Number.POSITIVE_INFINITY);
  const nan = loggedValue(optimized('console.log(0 / 0);'));
  assert.ok(Number.isNaN((nan as NumberLiteral).value));
});

test('folding preserves the sign of zero', () => {
  // `-0` is not `0` to `Object.is`, to `1/x`, or to the runtime's printer, so a fold that lost the
  // sign would be a wrong answer rather than a smaller tree (docs/NUMERIC.md §3.4).
  const value = loggedValue(optimized('console.log(0 * -1);'));
  assert.ok(Object.is((value as NumberLiteral).value, -0));
});

test('a string comparison folds as a string, not as a coerced number', () => {
  const value = loggedValue(optimized('console.log("a" < "b");'));
  assert.equal(value?.kind, 'boolean-literal');
});

test('a template literal with literal holes folds to one string', () => {
  const value = loggedValue(optimized(`console.log(\`x=\${1 / 3}\`);`));
  assert.equal(value?.kind, 'string-literal');
  // The compiler runs on the pinned Node the golden tests diff against, so this IS the runtime's
  // Ryu output -- which is the entire argument for folding it here.
  assert.equal((value as StringLiteral).value, `x=${1 / 3}`);
});

test('typeof over a literal folds to its answer', () => {
  const value = loggedValue(optimized('console.log(typeof 42);'));
  assert.equal((value as StringLiteral).value, 'number');
});

test('a literal left operand decides a logical operator and drops the other side', () => {
  const module = optimized(`
    function f(): boolean {
      return true;
    }
    console.log(false && f());
  `);
  assert.equal(loggedValue(module)?.kind, 'boolean-literal');
  // Dropping the call is correct rather than merely allowed: `false && f()` does not call f at run
  // time either. Nothing references f afterwards, so the shake removes the declaration too.
  assert.ok(!kinds(module).includes('call'));
});

test('nothing folds through a call, however constant the call looks', () => {
  // The restriction that makes the pass safe: an operand must be a literal NODE. `f()` is not one,
  // even when f provably returns 1, because folding it would delete the call.
  const module = optimized(`
    function f(): number {
      console.log("effect");
      return 1;
    }
    console.log(f() + 1);
  `);
  assert.ok(kinds(module).includes('binary-op'));
  assert.ok(kinds(module).includes('call'));
});

test('an array length folds only when every element is a literal', () => {
  const folded = optimized('console.log([1, 2, 3].length);');
  assert.equal((loggedValue(folded) as NumberLiteral | undefined)?.value, 3);

  // Same length, and folding it anyway would delete the call that produced the element.
  const kept = optimized(`
    function f(): number {
      console.log("effect");
      return 1;
    }
    console.log([f()].length);
  `);
  assert.ok(kinds(kept).includes('array-length'));
  assert.ok(kinds(kept).includes('call'));
});

test('const-fold alone never changes the node count of an unfoldable program', () => {
  const { module } = lowerSource(`
    function f(x: number): number {
      return x + 1;
    }
    console.log(f(2));
  `);
  // `x + 1` has a non-literal operand and `f(2)` is a call, so const-fold on its own has nothing
  // to do -- and a pass with nothing to do must return its input by identity, which is how every
  // caller here tells "unchanged" from "rebuilt identically".
  assert.equal(constFold(module), module);
});

// ─────────────────────────────────────────────────────────────────────────────
// Dead-code elimination

test('statements after a return are dropped', () => {
  const module = optimized(`
    function f(): number {
      return 1;
      console.log("unreachable");
    }
    console.log(f());
  `);
  assert.ok(!kinds(module).includes('console-log') || loggedValue(module) !== undefined);
  assert.ok(!hirNodes(module).some((n) => n.kind === 'string-literal'));
});

test('a function declaration after a return survives, because it is hoisted', () => {
  // `g` holds its binding from the moment the scope is entered, so the `return` above it does not
  // make it dead -- the call before the return is what reaches it.
  const module = optimized(`
    function f(): number {
      return g();
      function g(): number {
        return 2;
      }
    }
    console.log(f());
  `);
  const names = hirNodes(module)
    .filter((n) => n.kind === 'function-declaration')
    .map((n) => (n as unknown as { name: string }).name);
  assert.ok(names.includes('g'));
});

test('a literal condition selects a branch, and the branch keeps its own scope', () => {
  const module = optimized(`
    if (1 < 2) {
      const taken = 1;
      console.log(taken);
    } else {
      console.log("no");
    }
  `);
  assert.ok(!kinds(module).includes('if-statement'));
  // A block, not the branch's statements spliced into the module: splicing would promote `taken`
  // into the enclosing scope, where a later `const taken` becomes a redeclaration.
  assert.equal(module.statements[0]?.kind, 'block');
  assert.ok(!hirNodes(module).some((n) => n.kind === 'string-literal'));
});

test('while (false) is removed and while (true) is left alone', () => {
  assert.ok(!kinds(optimized('while (false) { console.log(1); }')).includes('while-statement'));
  // Rewriting `while (true)` to its body would be wrong -- the body repeats -- and stripping the
  // test buys nothing clang will not do itself.
  assert.ok(kinds(optimized('while (true) { break; }')).includes('while-statement'));
});

test('a module-level function nothing reaches is shaken out, transitively', () => {
  const module = optimized(`
    function used(): number {
      const n = helper();
      return n;
    }
    function helper(): number {
      const n = 1;
      return n;
    }
    function orphan(): number {
      const n = alsoOrphan();
      return n;
    }
    function alsoOrphan(): number {
      const n = 2;
      return n;
    }
    console.log(used());
  `);
  const names = hirNodes(module)
    .filter((n) => n.kind === 'function-declaration')
    .map((n) => (n as unknown as { name: string }).name);
  // Each body is two statements so the inliner declines it and the SHAKE is what this measures.
  // `orphan` calls `alsoOrphan`, which is why one filtering pass is not enough: `alsoOrphan` has a
  // reference right up until `orphan` is removed.
  assert.deepEqual(
    names.toSorted((a, b) => a.localeCompare(b)),
    ['helper', 'used'],
  );
});

test('DCE never removes a declaration something still names', () => {
  const module = optimized(`
    function kept(): number {
      return 1;
    }
    const f = kept;
    console.log(f());
  `);
  assert.ok(
    hirNodes(module).some(
      (n) =>
        n.kind === 'function-declaration' && (n as unknown as { name: string }).name === 'kept',
    ),
  );
});

test('a function used only as an array callback is not shaken out', () => {
  const module = optimized(`
    function isBig(x: number): boolean {
      const big = x > 1;
      return big;
    }
    const xs: number[] = [1, 2, 3];
    console.log(xs.filter(isBig));
  `);
  assert.ok(
    hirNodes(module).some(
      (n) =>
        n.kind === 'function-declaration' && (n as unknown as { name: string }).name === 'isBig',
    ),
  );
});

test('eliminateDeadCode returns its input untouched when nothing is dead', () => {
  const { module } = lowerSource('console.log(1);');
  assert.equal(eliminateDeadCode(module), module);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inlining

test('a one-line function called with a literal is inlined and then folded away', () => {
  const module = optimized(`
    function double(n: number): number {
      return n * 2;
    }
    console.log(double(21));
  `);
  assert.equal((loggedValue(module) as NumberLiteral | undefined)?.value, 42);
  // Inlined at the only call site, so the declaration is now unreachable and the shake takes it.
  assert.ok(!kinds(module).includes('function-declaration'));
});

test('an identifier argument inlines too, and the parameter is substituted everywhere', () => {
  const module = optimized(`
    function square(n: number): number {
      return n * n;
    }
    const x = 3;
    console.log(square(x));
  `);
  assert.ok(!kinds(module).includes('call'));
  const names = hirNodes(module)
    .filter((n) => n.kind === 'identifier')
    .map((n) => (n as unknown as { name: string }).name);
  assert.deepEqual(names, ['x', 'x']);
});

test('an inlined body shares no node with the function it came from', () => {
  // The emitter keys frame slots by node identity, so a body node that is also the callee's would
  // carry the callee's slot numbers into the call site (plan-notes 394).
  const { module } = lowerSource(`
    function seven(): number {
      return 3 + 4;
    }
    const x = seven();
    console.log(x);
  `);
  const inlined = inlineCalls(module);
  assert.ok(!kinds(inlined).includes('call'));
  // The declaration is still there (the shake runs later), so the sum appears twice.
  const sums = hirNodes(inlined).filter((node) => node.kind === 'binary-op');
  assert.equal(sums.length, 2);
  assert.equal(new Set(sums).size, 2);
});

test('an argument that could have a side effect is not inlined', () => {
  // A parameter used twice would duplicate the call, and one used zero times would delete it.
  // Neither is a risk worth an analysis when the fix is to decline.
  const module = optimized(`
    function square(n: number): number {
      return n * n;
    }
    function effect(): number {
      console.log("once");
      return 3;
    }
    console.log(square(effect()));
  `);
  assert.ok(kinds(module).includes('call'));
});

test('a function whose body names anything but its parameters is not inlined', () => {
  // The condition that closes the shadowing hazard: moving `return g` into a caller that has its
  // own `g` would silently read the caller's. The HIR resolves identifiers by name alone, so there
  // is no scope information here that could tell the two apart.
  const { module } = lowerSource(`
    const g = 5;
    function readsG(): number {
      return g;
    }
    console.log(readsG());
  `);
  assert.ok(kinds(inlineCalls(module)).includes('call'));
});

test('a function with more than one statement is not inlined', () => {
  const { module } = lowerSource(`
    function twoStatements(n: number): number {
      const doubled = n * 2;
      return doubled;
    }
    console.log(twoStatements(2));
  `);
  assert.ok(kinds(inlineCalls(module)).includes('call'));
});

test('a recursive function is never a candidate, by construction', () => {
  // Nothing tests for recursion: a recursive body must NAME itself, and a body that names anything
  // other than its parameters already fails the free-name condition.
  const { module } = lowerSource(`
    function countdown(n: number): number {
      if (n < 1) {
        return 0;
      }
      return countdown(n - 1);
    }
    console.log(countdown(3));
  `);
  assert.ok(kinds(inlineCalls(module)).includes('call'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline as a whole

test('the optimized module is verifier-clean', () => {
  // The pipeline runs BEFORE the verifier in build.ts, so this is the property that makes that
  // ordering safe: whatever the passes produce is what gets checked, and what gets emitted.
  assert.deepEqual(
    verifyHir(
      optimized(`
        function double(n: number): number {
          return n * 2;
        }
        function unused(): number {
          return 0;
        }
        let total = 0;
        for (let i = 0; i < 4; i = i + 1) {
          if (2 > 1) {
            total = total + double(i);
          }
        }
        console.log(\`total=\${total}\`);
      `),
    ),
    [],
  );
});

test('optimization does not touch a program with nothing to optimize', () => {
  const { module } = lowerSource(`
    let n = 0;
    while (n < 3) {
      n = n + 1;
    }
    console.log(n);
  `);
  assert.equal(optimize(module), module);
});
