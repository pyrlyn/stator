/* Monomorphization (rung 3.4) — the pass that has no pass.
 *
 * Specialization happens AT the lowering: a generic declaration is lowered once per concrete type
 * tuple, with the substitution in scope, so a type parameter is never built into the HIR at all.
 * That makes "no `T` survives" an invariant of construction rather than an obligation on a later
 * walk — and it is exactly what these tests pin down, because the golden fixtures cannot: correct
 * stdout is equally consistent with emitting the same specialization four times.
 *
 * What is checked here: the tuple the checker's inference is recovered as, that equal tuples share
 * one function, that unequal ones do not, that a specialization keeps the source's printable name,
 * and the four shapes the gate refuses because the lowering has no answer for them.
 */

import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { FunctionDeclaration } from '../../compiler/src/hir/nodes.ts';
import { hTypeName } from '../../compiler/src/hir/types.ts';
import { verifyHir } from '../../compiler/src/hir/verify.ts';
import { lowerSourceFile } from '../../compiler/src/lower/index.ts';
import { createProgram, gateCodes, loweredStatements, lowerSource } from './helpers.ts';

/** Every function the lowering emitted, by the name it is BOUND under — the specialization key
 * `box<number>` for a specialization, the plain name for an ordinary function. */
function emittedFunctions(code: string): string[] {
  return loweredStatements(code)
    .filter((s): s is FunctionDeclaration => s.kind === 'function-declaration')
    .map((s) => s.name);
}

test('a generic is specialized once per concrete type tuple', () => {
  assert.deepEqual(
    emittedFunctions(`
      function box<T>(item: T): T { return item; }
      console.log(box(42));
      console.log(box("x"));
    `),
    ['box<number>', 'box<string>'],
  );
});

test('two calls with the same tuple share one specialization', () => {
  // The checker infers `T = 42` for the first call and `T = 7` for the second -- two DIFFERENT
  // literal types. Unification runs on HType, where both are `number`, so the two collapse. This is
  // the reason the tuple is expressed in HType and not in ts.Type.
  assert.deepEqual(
    emittedFunctions(`
      function box<T>(item: T): T { return item; }
      console.log(box(42));
      console.log(box(7));
    `),
    ['box<number>'],
  );
});

test('a multi-parameter generic keys on the whole tuple, in order', () => {
  assert.deepEqual(
    emittedFunctions(`
      function pair<A, B>(a: A, b: B): string { return \`\${a}/\${b}\`; }
      console.log(pair(1, "one"));
      console.log(pair("two", 2));
      console.log(pair(3, "three"));
    `),
    ['pair<number, string>', 'pair<string, number>'],
  );
});

test('a compound type argument is part of the key', () => {
  assert.deepEqual(
    emittedFunctions(`
      function count<T>(items: T[]): number { return items.length; }
      console.log(count([1, 2]));
      console.log(count(["a"]));
    `),
    ['count<number>', 'count<string>'],
  );
});

test('a generic calling a generic instantiates the callee at the caller substitution', () => {
  // `twice<string>` calls `box` at `T = string`, which is only knowable once `twice`'s own T is
  // bound -- so the collection walk has to carry the enclosing substitution into the nested call.
  // The order is the queue's, breadth-first: `twice`'s two tuples come from the source's own calls,
  // and `box`'s come from lowering those. Nothing depends on it -- the emitter forward-declares
  // every function before defining any -- but it is asserted rather than sorted away, because a
  // change in it means the walk changed shape.
  assert.deepEqual(
    emittedFunctions(`
      function box<T>(item: T): T { return item; }
      function twice<T>(item: T): T { return box(box(item)); }
      console.log(twice(1));
      console.log(twice("z"));
    `),
    ['twice<number>', 'twice<string>', 'box<number>', 'box<string>'],
  );
});

test('a specialization keeps the source name, not the key it is bound under', () => {
  // The key is unspellable on purpose (no identifier contains an angle bracket), but it must not
  // reach the emitted closure: `console.log(f)` prints `[Function: box]` in Node, not
  // `[Function: box<number>]`.
  const [decl] = loweredStatements(`
    function box<T>(item: T): T { return item; }
    console.log(box(1));
  `);
  assert.equal(decl?.kind, 'function-declaration');
  assert.equal((decl as FunctionDeclaration).name, 'box<number>');
  assert.equal((decl as FunctionDeclaration).fn.name, 'box');
});

test('no type parameter survives into the HIR', () => {
  const { module } = lowerSource(`
    function box<T>(item: T): T { return item; }
    function count<T>(items: T[]): number { return items.length; }
    console.log(box("x"));
    console.log(count([1, 2]));
  `);
  // STA4054 is the verifier's type-parameter check. It runs before every other expression rule
  // precisely so that a leftover `T` is reported as itself rather than as a downstream mismatch.
  assert.deepEqual(
    verifyHir(module)
      .filter((p) => p.code === 'STA4054')
      .map((p) => p.message),
    [],
  );
});

test('the specialization is typed with its concrete arguments', () => {
  const [decl] = loweredStatements(`
    function box<T>(item: T): T { return item; }
    console.log(box("x"));
  `);
  assert.equal(decl?.kind, 'function-declaration');
  assert.equal(hTypeName((decl as FunctionDeclaration).fn.type), '(a0: string) => string');
});

test('a generic used as a value takes the canonical tuple', () => {
  // No call site determines a tuple, so the value shares its specialization with an
  // undetermined call: every parameter takes its declared default, else Unknown
  // (plan.md §8 step 41). The gate accepts the read and the collection enqueues the one
  // specialization every such read resolves to.
  const source = `
    function box<T>(item: T): T { return item; }
    console.log(box);
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['box<unknown>']);
});

test('a generic read through an alias takes the same canonical tuple', () => {
  // The alias binds no value, so every read resolves through it to the ultimate generic —
  // and to the same specialization a direct read takes.
  const source = `
    function box<T>(item: T): T { return item; }
    const f = box;
    console.log(f);
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['box<unknown>']);
});

test('a generic arrow read as a value takes the canonical tuple under its variable', () => {
  const source = `
    const box = <T,>(item: T): T => item;
    console.log(box);
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['box<unknown>']);
});

test('a defaulted parameter keeps its default in the canonical tuple', () => {
  // The canonical tuple is what a call with no information takes, so a defaulted
  // parameter reads its default rather than Unknown.
  const source = `
    function withDefault<T = string>(x?: T): string { return \`\${x}\`; }
    console.log(withDefault);
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['withDefault<string>']);
});

test('typeof a generic names no specialization', () => {
  // Every specialization is a function, so `typeof` folds to the literal without building
  // a value at all.
  const source = `
    function box<T>(item: T): T { return item; }
    console.log(typeof box);
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), []);
});

test('a generic callback to a receiver op specializes at the callback type', () => {
  // The gate always accepted the position (the checker's instantiated parameter type has
  // no unbound parameter); the lowering dropped it by routing receiver-op arguments
  // around the specialization hook, which died in the verifier as STA4054.
  const source = `
    function box<T>(item: T): T { return item; }
    console.log([1, 2].map(box));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['box<number>']);
});

test('a generic returned from a function is still refused', () => {
  // A returned generic escapes every call site that could name a tuple — even when the
  // declared return type is function-typed — so it waits on the dynamic tier with the
  // other escaping positions (plan.md §8 step 41).
  assert.deepEqual(
    gateCodes(`
      function box<T>(item: T): T { return item; }
      function get(): (x: number) => number { return box; }
      console.log(get()(1));
    `),
    ['STA1214'],
  );
});

test('a generic call at a generic type is refused, not an internal error', () => {
  // Self-application `box(box)` infers a generic type for the argument, which no
  // monomorphic copy can spell. The widened argument arm accepts the read, so the call
  // itself refuses — otherwise the file reaches the collection's STA4070 canary, which
  // exists for compiler bugs, not user programs (plan.md §8 step 41).
  assert.deepEqual(
    gateCodes(`
      function box<T>(item: T): T { return item; }
      console.log(typeof box(box));
    `),
    ['STA1214'],
  );
});

test('a type parameter no argument determines defaults to Unknown', () => {
  // `T` appears in no parameter and in no return type, so no call ever determines it. There is
  // no static information at all, and `Unknown` — the dynamic representation, not a guess — is
  // the honest tuple element: one shared specialization, exactly as inference produces when a
  // call site leaves the parameter free.
  const source = `
    function f<T>(n: number): number { return n; }
    console.log(f(1));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['f<unknown>']);
});

test('a constrained type parameter specializes per tuple', () => {
  // A constraint is enforced by the checker at every call site, so there is nothing for the
  // lowering to check: monomorphization substitutes the resolved tuple exactly as for an
  // unconstrained parameter.
  const source = `
    function big<T extends number>(item: T): T { return item; }
    console.log(big(1));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['big<number>']);
});

test('a defaulted type parameter falls back to its default', () => {
  // The default supplies the tuple element no call site wrote — the same instantiation the
  // checker itself resolves — while an explicit argument still determines its own.
  const source = `
    function withDefault<T = string>(x?: T): string { return \`\${x}\`; }
    console.log(withDefault());
    console.log(withDefault<number>(7));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['withDefault<string>', 'withDefault<number>']);
});

test('a later default sees the earlier bindings, in order', () => {
  // `<T, U = T[]>` called with one argument binds `T` from the argument and `U` from the
  // default applied to it — declaration order is what makes the default's reference resolve.
  const source = `
    function pair<T, U = T[]>(t: T): number { return 0; }
    console.log(pair(1));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['pair<number, number[]>']);
});

test('explicit type arguments on a non-generic call are refused', () => {
  assert.deepEqual(
    gateCodes(`
      function f(n: number): number { return n; }
      console.log(f<number>(1));
    `).length > 0,
    true,
  );
});

test('a generic arrow or function expression assigned to a const specializes', () => {
  // A `const` (module scope or block) names the specializations the way a declaration names its
  // own. Module scope keeps the plain name; a block-homed one takes a position key (docs/HIR.md §7).
  const source = `
    const box = <T,>(item: T): T => item;
    console.log(box(1));
    console.log(box("x"));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), ['box<number>', 'box<string>']);
});

test('a generic arrow in a single-assignment let or a nesting specializes', () => {
  // Block-homed under the specialization-key rule (docs/HIR.md §7): a `let` whose only write is
  // the initializer and a nested `const` both take a position-derived key, so the specializations
  // have a stable home. A `let` that is reassigned still has no home (tested below).
  assert.deepEqual(
    gateCodes(`
      let box = <T,>(item: T): T => item;
      console.log(box(1));
    `),
    [],
  );
  assert.deepEqual(
    gateCodes(`
      function f() { const box = <T,>(item: T): T => item; return box(1); }
      console.log(f());
    `),
    [],
  );
  // A reassigned `let` has no single assignment to key the specializations to.
  assert.deepEqual(
    gateCodes(`
      let box = <T,>(item: T): T => item;
      box = <T,>(item: T): T => item;
      console.log(box(1));
    `).length > 0,
    true,
  );
});

test('a generic that instantiates itself at a larger type is capped, not looped', () => {
  // `grow<T>` calls `grow<T[]>`, so every instantiation demands a strictly larger one and the queue
  // never drains. Monomorphization has no fixed point here and no amount of patience finds one, so
  // the cap is the only thing between this program and an emitter that runs until memory does.
  // Deliberately a USER error (STA2003), not an internal one: the program really is not compilable
  // ahead of time. The reported name shows the cap was reached by growth, not by recursion depth.
  // Called through lowerSourceFile rather than the `lowerSource` helper above: the cap ABANDONS the
  // module (there is no partial answer to give), and the helper's contract is that a module exists.
  const { program, sourceFile } = createProgram(`
    function grow<T>(item: T): number { return grow([item]); }
    console.log(grow(1));
  `);
  const { module, diagnostics } = lowerSourceFile(sourceFile, program.getTypeChecker());
  assert.equal(module, null);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    ['STA2003'],
  );
  assert.match(diagnostics[0]?.message ?? '', /grow<number\[\]\[\]/);
});

/** The position-derived key an inline generic takes: `arrow@test.ts#<offset><tuple>`. The
 * offset is the arrow's own start in the source, so the expectation is computed, not copied
 * from a failure message. */
function inlineKey(source: string, arrow: string, tuple: string, kind = 'arrow'): string {
  const offset = source.indexOf(arrow);
  assert.notEqual(offset, -1);
  return `${kind}@test.ts#${String(offset)}<${tuple}>`;
}

test('an inline generic arrow at a callback specializes at the parameter type', () => {
  // The arrow literal is its own use site, so one tuple suffices and the key is the position
  // rather than a variable. The parameter's `(value: number, …) => number` binds `T` to
  // `number` exactly as a named generic passed there would.
  const source = `
    console.log([1].map(<T,>(item: T): T => item));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), [
    inlineKey(source, '<T,>(item: T): T => item', 'number'),
  ]);
});

test('an inline generic function expression specializes too', () => {
  const source = `
    console.log([1].map(function twice<T,>(item: T): T[] { return [item, item]; }));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), [
    inlineKey(source, 'function twice<T,>(item: T): T[] { return [item, item]; }', 'number', 'fn'),
  ]);
});

test('two inline arrows at one tuple specialize separately', () => {
  // Positions are the identity: two literals with one tuple are two specializations, because
  // sharing one body between two literals would answer one literal's closure with the other's.
  const source = `
    console.log([1].map(<T,>(item: T): T => item));
    console.log([2].map(<T,>(item: T): T => item));
  `;
  assert.deepEqual(gateCodes(source), []);
  const first = source.indexOf('<T,>(item: T): T => item');
  const second = source.indexOf('<T,>(item: T): T => item', first + 1);
  assert.deepEqual(emittedFunctions(source), [
    `arrow@test.ts#${String(first)}<number>`,
    `arrow@test.ts#${String(second)}<number>`,
  ]);
});

test('an inline arrow keeps no display name', () => {
  // The key is a position, not a name: back-filling it as the display name would print
  // `[Function: arrow@test.ts#…]` where Node prints `[Function (anonymous)]`, so an
  // anonymous arrow lowers with no name at all — exactly as a non-generic inline arrow does.
  // A named function expression keeps its own name, which is what Node prints for it.
  const [arrow] = loweredStatements(`
    console.log([1].map(<T,>(item: T): T => item));
  `);
  assert.equal(arrow?.kind, 'function-declaration');
  assert.equal((arrow as FunctionDeclaration).fn.name, undefined);
  const [named] = loweredStatements(`
    console.log([1].map(function twice<T,>(item: T): T { return item; }));
  `);
  assert.equal(named?.kind, 'function-declaration');
  assert.equal((named as FunctionDeclaration).fn.name, 'twice');
});

test('an inline arrow nested in a function compiles when it captures nothing', () => {
  const source = `
    function f() { return [1].map(<T,>(item: T): T => item); }
    console.log(f());
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), [
    inlineKey(source, '<T,>(item: T): T => item', 'number'),
    'f',
  ]);
});

test('an inline arrow inside a generic body substitutes the enclosing tuple', () => {
  // The arrow's `U` binds through the enclosing `T`: the worklist walks the specialization
  // body with its substitution in scope, so one literal yields one specialization per tuple.
  const source = `
    function outer<T>(x: T): T[] { return [x].map(<U,>(y: U): U => y); }
    console.log(outer(7));
    console.log(outer("s"));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), [
    'outer<number>',
    'outer<string>',
    inlineKey(source, '<U,>(y: U): U => y', 'number'),
    inlineKey(source, '<U,>(y: U): U => y', 'string'),
  ]);
});

test('no type parameter survives from an inline specialization', () => {
  const { module } = lowerSource(`
    console.log([1].map(<T,>(item: T): T => item));
  `);
  assert.deepEqual(
    verifyHir(module)
      .filter((p) => p.code === 'STA4054')
      .map((p) => p.message),
    [],
  );
});

test('an inline arrow that reads an enclosing binding is refused', () => {
  // A specialization is a module-level function: the body's `y` would resolve to no binding
  // there (STA4035), so the gate refuses the arrow rather than manufacture that error.
  assert.deepEqual(
    gateCodes(`
      function f() { const y = 1; return [1].map(<T,>(item: T): number => item as number + y); }
      console.log(f());
    `),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(`
      class C { v = 1; m() { return [1].map(<T,>(item: T): number => (item as number) + this.v); } }
      console.log(new C().m());
    `),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(`
      const c = true;
      if (c) { const y = 1; console.log([1].map(<T,>(item: T): number => (item as number) + y)); }
    `),
    ['STA1214'],
  );
});

test('an inline arrow that reads a module-level let is refused', () => {
  // Specialization bodies lower before their file's own statements, so a same-file `let`
  // (and a `const`, and a `var`, whose hoist feeds the lowering but not the verifier) is no
  // binding yet where the body reads it. Functions, classes, imports, and globals hoist or
  // pre-register and stay accepted.
  assert.deepEqual(
    gateCodes(`
      const base = 100;
      console.log([1].map(<T,>(item: T): number => (item as number) + base));
    `),
    ['STA1214'],
  );
});

test('a named generic that reads a same-file binding is refused, not an internal error', () => {
  // Named declarations predated the module-order rule the inline path enforces: they accepted
  // and failed downstream as STA4035 (let/const) or STA4002 (var, whose hoist feeds the
  // lowering but not the verifier). The gate now refuses both shapes with the same owner.
  assert.deepEqual(
    gateCodes(`
      let base = 100;
      function id<T>(x: T): T { console.log(base); return x; }
      console.log(id(5));
    `),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(`
      const base = 100;
      function id<T>(x: T): T { console.log(base); return x; }
      console.log(id(5));
    `),
    ['STA1214'],
  );
  // A homed arrow reads through the same rule: its specialization is module-level too.
  assert.deepEqual(
    gateCodes(`
      let base = 100;
      const id = <T,>(x: T): T => { console.log(base); return x; };
      console.log(id(5));
    `),
    ['STA1214'],
  );
  // Hoisted bindings stay accepted: a function declaration is reachable in time.
  assert.deepEqual(
    gateCodes(`
      function dbl(n: number): number { return n * 2; }
      function id<T>(x: T): T { console.log(dbl(2)); return x; }
      console.log(id(5));
    `),
    [],
  );
});

test('a named generic that reads an enclosing scope is refused', () => {
  // A specialization is a module-level function, so an enclosing parameter or local has no
  // binding to read there — the same rule the inline path enforces.
  assert.deepEqual(
    gateCodes(`
      function outer(y: number): void {
        function id<T>(x: T): T { console.log(y); return x; }
        console.log(id(5));
      }
      outer(1);
    `),
    ['STA1214'],
  );
});

test('an inline arrow away from a direct argument is refused', () => {
  // A branch, a spread, and a constructor argument have no single parameter type to read.
  assert.deepEqual(
    gateCodes(`
      function run(f: (x: number) => number, v: number): number { return f(v); }
      console.log(run((1 > 0 ? <T,>(x: T): T => x : (x: number) => x + 1), 1));
    `),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(`
      class Box { constructor(f: (x: number) => number) { console.log(f(1)); } }
      new Box(<T,>(x: T): T => x);
    `),
    ['STA1214'],
  );
});

test('a parenthesized inline arrow specializes at the same tuple', () => {
  // The parameter pairs by the argument's own position, which through parentheses is the
  // chain's top — pairing by the bare arrow instead finds no parameter and refuses.
  const source = `
    function run(f: (x: number) => number, v: number): number { return f(v); }
    console.log(run((<T,>(x: T): T => x), 3));
  `;
  assert.deepEqual(gateCodes(source), []);
  assert.deepEqual(emittedFunctions(source), [
    inlineKey(source, '<T,>(x: T): T => x', 'number'),
    'run',
  ]);
});
