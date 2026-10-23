/* The frontend gate (src/frontend/gate.ts) had no direct unit tests before this file — every case
 * was reached only indirectly, through `explain`/`build` in the decision-test corpus. That leaves
 * exactly the kind of rule this gate depends on unverified in isolation: a POSITION test, not a
 * syntax test, which a decision test exercises only by accident of what example it happens to use.
 *
 * `gateProgram` takes a real `ts.Program`; `program()` below builds one exactly the way
 * `stator explain`/`build` would, so a passing test here is a claim about the actual gate. */

import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { gateProgram } from '../../compiler/src/frontend/gate.ts';
import { createProgram } from './helpers.ts';

function codesFor(source: string, mode: 'ts' | 'js' = 'ts', fileName?: string): string[] {
  const { program } = createProgram(source, fileName ?? (mode === 'js' ? '/test.js' : '/test.ts'));
  return gateProgram(program, mode).map((d) => d.code);
}

// `x++`, `--x`, `x += e` all read-then-write-then-produce-a-value. Statement position still
// folds to Assignment; value position is an UpdateExpr.
test('++ and -- are accepted where their value is discarded', () => {
  assert.deepEqual(codesFor('let x: number = 0;\nx++;'), []);
  assert.deepEqual(codesFor('let x: number = 0;\n--x;'), []);
  assert.deepEqual(codesFor('for (let i: number = 0; i < 1; i++) { }'), []);
});

test('++ and -- are accepted where their value is USED', () => {
  assert.deepEqual(codesFor('let x: number = 0;\nlet y: number = x++;'), []);
  assert.deepEqual(codesFor('let n: number = 0;\nlet y: number = (n = 1);'), []);
  assert.deepEqual(codesFor('let x: number = 0;\nlet y: number = --x;'), []);
});

test('compound assignment is accepted in statement and value position', () => {
  assert.deepEqual(codesFor('let x: number = 0;\nx += 1;'), []);
  assert.deepEqual(codesFor('for (let i: number = 0; i < 1; i += 1) { }'), []);
  assert.deepEqual(codesFor('let x: number = 0;\nlet y: number = (x += 1);'), []);
});

test('compound assignment to anything but a bare identifier is deferred, not accepted', () => {
  // No object model exists yet for the target to reach the fold soundly, so `.length` — the one
  // property this subset already exposes — has to be refused rather than silently miscompiled.
  assert.deepEqual(codesFor('let s: string = "x";\ns.length += 1;'), ['STA1214']);
});

// A label exists only to be named by `break`/`continue`. Loops, switches, and blocks carry one.
test('a label on a loop, switch, or block is accepted', () => {
  assert.deepEqual(codesFor('outer: while (false) { break outer; }'), []);
  assert.deepEqual(codesFor('let x: number = 0;\nouter: switch (x) { }'), []);
  assert.deepEqual(codesFor('outer: { }'), []);
});

// `for`, `for-of`, `for-in` all parse as loops, but they are three different things and their
// diagnostics have to say so. Conflating them ("for loops is not yet supported") would misname
// what is actually missing (plan-notes 44). for-of over an ARRAY landed with rung 5, over a
// STRING/Map/Set with Phase 5 step 8; a class with `[Symbol.iterator]()` is a user iterable; for-in
// desugars to Object.keys plus a counting for.
test('for-of and for-in report distinctly from the for loop they are not', () => {
  assert.deepEqual(codesFor('for (const x of [1, 2]) { }'), []);
  assert.deepEqual(codesFor("for (const c of 'ab') { }"), []);
  assert.deepEqual(
    codesFor('const m: Map<number, number> = new Map();\nfor (const e of m) { }'),
    [],
  );
  assert.deepEqual(codesFor('const s: Set<number> = new Set();\nfor (const e of s) { }'), []);
  assert.deepEqual(codesFor('const xs: Iterable<number> = [1];\nfor (const e of xs) { }'), [
    'STA1214',
  ]);
  assert.deepEqual(
    codesFor(
      'function* g(): Generator<number, void, undefined> { yield 1; }\n' +
        'class C { [Symbol.iterator](): Generator<number, void, undefined> { return g(); } }\n' +
        'for (const x of new C()) { }',
    ),
    [],
  );
  assert.deepEqual(codesFor('const s = Symbol("id");'), ['STA1212']);
  assert.deepEqual(codesFor('for (const x in {}) { }'), []);
  assert.deepEqual(codesFor('for (let i: number = 0; i < 1; i++) { }'), []);
});

// A BigInt literal is a token, and the token skip used to accept it into a lowering that could
// only answer STA4031 (audit F5, plan.md §9 Task 6.25).
test('BigInt is not-yet STA1213 in both modes, never an internal error', () => {
  for (const mode of ['ts', 'js'] as const) {
    assert.deepEqual(codesFor('const b = 1n;', mode), ['STA1213']);
    assert.deepEqual(codesFor('console.log(typeof 1n);', mode), ['STA1213']);
    assert.deepEqual(codesFor('console.log(10n > 5);', mode), ['STA1213']);
    assert.deepEqual(codesFor('const b = BigInt(5);', mode), ['STA1213']);
  }
  // A bigint that arrives without a literal is refused where it is read, not where it is named.
  assert.deepEqual(codesFor('function f(a: bigint): bigint {\n  return a;\n}\nf;'), ['STA1213']);
  // A narrowing of `unknown` to bigint is a branch no compiled program can enter.
  assert.deepEqual(
    codesFor(
      'function g(u: unknown): string {\n  if (typeof u === "bigint") return String(u);\n  return "";\n}\ng(1);',
    ),
    [],
  );
});

// Index access is admitted only where the target is genuinely an array. `s[0]` and `o['k']` are
// the same syntax reaching a different runtime operation, and neither has an HIR node yet.
test('index access is accepted on an array and a string, not-yet on anything else', () => {
  assert.deepEqual(codesFor('const a: number[] = [1];\nconsole.log(a[0]);'), []);
  // A string's exotic index is admitted (plan-notes 376 / F1): `s[0]` is the UTF-16 unit.
  assert.deepEqual(codesFor("const s: string = 'ab';\nconsole.log(s[0]);"), []);
  // A hole is rejected: a dense array cannot be absent. Array spread of a typed array is accepted.
  assert.deepEqual(codesFor('const a: number[] = [1, , 3];'), ['STA1214']);
  assert.deepEqual(codesFor('const a: number[] = [1];\nconst b: number[] = [...a];'), []);
  assert.deepEqual(codesFor('const a: number[] = [1, 2];\nconst b: number[] = [0, ...a, 3];'), []);
  // A string is iterable: its spread drains through the `...` row (plan.md §11c T11.4 step 5).
  assert.deepEqual(codesFor('const s: string = "ab";\nconst c: string[] = [...s];'), []);
});

// An array-literal spread drains any operand that is not an array through the `...` row, the
// iterator protocol at run time (plan.md §11c T11.4 step 5, docs/VALUE.md §4.23): the `concat`
// the lowering folds into always receives an array, so the verifier's STA4082 cannot fire. The
// object twin still needs a shape and stays refused.
test('spread of an unknown value drains at run time; an object spread of one is not-yet', () => {
  assert.deepEqual(codesFor('const u = JSON.parse("[1]");\nconst b = [...u];', 'js'), []);
  // An `as` assertion to an array type is never checkable, so the lowering drops it and spreads
  // the unknown operand -- which the drain then checks for iterability.
  assert.deepEqual(
    codesFor('declare const u: unknown;\nconst b = [...(u as number[])];', 'js'),
    [],
  );
  // A tuple is a checker-level array the HType model calls Unknown.
  assert.deepEqual(codesFor('const t: [number, string] = [1, "a"];\nconst b = [...t];', 'js'), []);
  // The object twin: a dropped assertion to a fixed shape names the unknown VALUE, so the
  // spread enumerates run-time keys through the shape table (plan-notes 376 / F3).
  assert.deepEqual(
    codesFor('declare const u: unknown;\nconst b = { ...(u as { x: number }) };', 'js'),
    [],
  );
  // A directly-`unknown` operand stays the checker's (TS2488) in ts mode, and js mode suppresses
  // that code: the gate is silent either way.
  assert.deepEqual(codesFor('declare const u: unknown;\nconst b = [...u];'), []);
  assert.deepEqual(codesFor('declare const u: unknown;\nconst b = [...u];', 'js'), []);
  assert.deepEqual(codesFor('const a: number[] = [1];\nconst b = [...(a as number[])];', 'js'), []);
  assert.deepEqual(codesFor('const a: unknown[] = [1];\nconst b: unknown[] = [...a];', 'js'), []);
});

test('an object spread of a dropped-as unknown is accepted on the dynamic path', () => {
  const { program: objectProgram } = createProgram(
    'declare const u: unknown;\nconst b = { ...(u as { x: number }) };',
    '/test.ts',
  );
  const objectDiags = gateProgram(objectProgram, 'js');
  assert.deepEqual(
    objectDiags.map((d) => d.message),
    [],
  );
});

test('switch, case, default and do/while are all accepted syntax', () => {
  assert.deepEqual(
    codesFor('let x: number = 0;\nswitch (x) { case 1: break; default: break; }'),
    [],
  );
  assert.deepEqual(codesFor('let x: number = 0;\ndo { x++; } while (x < 1);'), []);
});

test('try/catch/finally and throw are accepted, including a destructured catch', () => {
  assert.deepEqual(codesFor("try { throw 'boom'; } catch { console.log('handled'); }"), []);
  assert.deepEqual(codesFor("try { throw 'boom'; } catch (e) { console.log(typeof e); }"), []);
  assert.deepEqual(codesFor('try { console.log(1); } finally { console.log(2); }'), []);
  assert.deepEqual(codesFor('try { throw 1; } catch ({ message }) { console.log(1); }'), []);
});

// `var` is banned in ts mode BY DESIGN (STA1104, a 'never' code, no phase) — function-scoped
// hoisting with `undefined` initialization is the dynamic-scoping behaviour strict mode exists
// to exclude. js mode accepts it (plan.md §8 step 3).
test('var is a permanent rejection in ts mode and is accepted in js mode', () => {
  assert.deepEqual(codesFor('var x = 1;'), ['STA1104']);
  assert.deepEqual(codesFor('var x = 1;', 'js'), []);
  assert.deepEqual(codesFor('var x;', 'js'), []);
  assert.deepEqual(
    codesFor(
      'function f() { for (var i = 0; i < 2; i++) { const g = function () { return i; }; console.log(g()); } }',
      'js',
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      'function f() { for (let i = 0; i < 2; i++) { const g = function () { return i; }; console.log(g()); } }',
      'js',
    ),
    [],
  );
});

// The HIR's Declaration carries exactly one name. Destructuring still has no shape to lower into.
test('simple destructuring is accepted; nested and rest stay deferred', () => {
  assert.deepEqual(
    codesFor('const p: { x: number; y: number } = { x: 1, y: 2 }; const { x, y } = p;'),
    [],
  );
  assert.deepEqual(codesFor('const arr: number[] = [1, 2]; const [a, b] = arr;'), []);
  assert.deepEqual(codesFor('function f({ x }: { x: number }): number { return x; }'), []);
  assert.deepEqual(codesFor('try { throw 1; } catch ({ message }) { console.log(1); }'), []);
  assert.deepEqual(codesFor('const { a: { b } }: { a: { b: number } } = { a: { b: 1 } };'), [
    'STA1214',
  ]);
  assert.deepEqual(codesFor('const [a, ...rest]: number[] = [1, 2];'), ['STA1214']);
});

// Mirrors the compound-assignment-to-non-identifier test above, but for plain `=`: HIR Assignment
// only ever targets a bare name, so `obj.x = 1` needs an object model this subset doesn't have.
test('plain assignment to anything but a bare identifier is deferred, not accepted', () => {
  assert.deepEqual(codesFor('let s: string = "x";\ns.length = 2;'), ['STA1214']);
});

// Loose equality is accepted alongside strict equality (docs/NUMERIC.md §6.3): its ToPrimitive
// half is unreachable while every value is a primitive, so it needs no object model to be sound.
test('loose equality (== and !=) is accepted, not deferred pending an object model', () => {
  assert.deepEqual(codesFor('let x: number = 1;\nconsole.log(x == 1);'), []);
  assert.deepEqual(codesFor('let x: number = 1;\nconsole.log(x != 2);'), []);
});

// `.length` is the one gate rule that consults the type checker instead of syntax alone: the same
// PropertyAccessExpression is legal on a string and meaningless on anything else, so only the
// checker's answer -- not the shape of the code -- can tell the two apart.
test('.length is accepted on a string type and deferred on anything else', () => {
  assert.deepEqual(codesFor('let s: string = "hi";\nconsole.log(s.length);'), []);
  assert.deepEqual(codesFor('let b: boolean = true;\nconsole.log(b.length);'), ['STA1214']);
});

// A global the compiler does not model is the case where the gate accepting too much cost the
// COMPILER its own invariant rather than the user a feature: the lowering binds only declarations
// it lowers, so an accepted `String` reached `STA4035 used before declaration` — an internal error
// raised by legal source. These tests are position tests, and every one of them once passed the
// gate (plan-notes 61).
test('a global the compiler does not model is a not-yet, never an internal error', () => {
  assert.deepEqual(codesFor('const s: string = escape("a b");\nconsole.log(s);'), ['STA1214']);
  // A global function READ as a value has no node either (plan.md §11c T11.4 lands only the call).
  assert.deepEqual(codesFor('const f = parseInt;\nconsole.log(f("4"));'), ['STA1214']);
  // Declared nowhere at all rather than in a lib file — the checker synthesizes it, and
  // `globalThis` slipped through a valueDeclaration-based test.
  assert.deepEqual(codesFor('const g = globalThis;\nconsole.log(1);'), ['STA1214']);
  // `NaN` sat in this list until Task 4.2's Math slice gave it a lowering (a number literal,
  // like `undefined`'s undefined-literal) — the exact lift the plan's Task 4.2 note promises.
  assert.deepEqual(codesFor('console.log(NaN);'), []);
});

test('the three spellings that only MENTION a global name still pass', () => {
  // `undefined` is the one global with a lowering: it answers with an undefined-literal, and the
  // gate exempts it by name so both sides agree on the same single exception.
  assert.deepEqual(codesFor('const u = undefined;\nconsole.log(u);'), []);
  // A property NAME is answered by the object's shape, never by scope; that `length` resolves to a
  // lib declaration is an accident of where the type came from.
  assert.deepEqual(codesFor('const s: string = "ab";\nconsole.log(s.length);'), []);
  assert.deepEqual(codesFor('console.log([1, 2].length);'), []);
  // `console` is the receiver of the one call the compiler models itself. gateCall vets the whole
  // expression; the walker descends into the callee anyway.
  assert.deepEqual(codesFor('console.log(1);'), []);
  // A type position erases, so there is nothing to lower.
  assert.deepEqual(codesFor('const xs: Array<number> = [1];\nconsole.log(xs.length);'), []);
});

test('a user binding that shadows a global name is a user binding', () => {
  // The rule is "declared nowhere in the module", not "spelled like a global": the check is over
  // where the symbol's declarations LIVE, so a name declared in user code stays a normal binding
  // even when a lib global answers to it too.
  assert.deepEqual(
    codesFor(
      'function f(): number {\n  const String: number = 1;\n  return String;\n}\nconsole.log(f());',
    ),
    [],
  );
});

test('the global functions land as callees only, each refused by name otherwise', () => {
  // plan.md §11c T11.4: calls, typeof and Array.isArray are accepted ...
  assert.deepEqual(codesFor('console.log(Number("1"), Boolean(0), parseFloat("2"));'), []);
  assert.deepEqual(codesFor('console.log(isNaN(1), isFinite(1), parseInt("8", 8));'), []);
  assert.deepEqual(codesFor('console.log(typeof JSON, typeof Math, typeof parseInt);'), []);
  assert.deepEqual(codesFor('console.log(Array.isArray([1]));'), []);
  assert.deepEqual(codesFor('const { length: n } = [1, 2];\nconsole.log(n);'), []);
  // ... and everything around them stays a named not-yet.
  assert.deepEqual(codesFor('console.log(parseInt("1", 10, 3));'), ['STA1214']);
  assert.deepEqual(codesFor('const a: [string] = ["1"];\nconsole.log(Number(...a));'), ['STA1214']);
  assert.deepEqual(codesFor('console.log(Array.from([1]));'), []);
  assert.deepEqual(codesFor('console.log(Array.from([1], (x) => x));'), ['STA1214']);
  assert.deepEqual(codesFor('const f = Array.from;\nconsole.log(f([]));'), ['STA1214']);
  assert.deepEqual(codesFor('const f = Array.isArray;\nconsole.log(f([]));'), ['STA1214']);
  assert.deepEqual(codesFor('console.log(typeof Symbol);'), ['STA1212']);
  // A user binding that shadows the name is an ordinary call.
  assert.deepEqual(
    codesFor(
      'function parseInt(s: string): number {\n  return s.length;\n}\nconsole.log(parseInt("ab"));',
    ),
    [],
  );
});

test('a function-valued field is callable through its object', () => {
  // plan-notes 310: an arrow, a function expression and a shorthand function in a literal.
  assert.deepEqual(
    codesFor(
      'function f(): number {\n  return 1;\n}\nconst o = { f, g: (x: number): number => x, h: function (): void {} };\nconsole.log(o.f(), o.g(2));\no.h();',
    ),
    [],
  );
  // A number-typed field is read, then its own method called: no field call involved.
  assert.deepEqual(codesFor('const o = { n: 1 };\nconsole.log(o.n.toFixed(1));'), []);
});

test('Number methods, statics and constants land by name; the rest are refused by name', () => {
  assert.deepEqual(
    codesFor('const n: number = 255;\nconsole.log(n.toString(16), n.toFixed(2), n.toString());'),
    [],
  );
  assert.deepEqual(
    codesFor('console.log(Number.parseInt("8"), Number.parseFloat("1"), Number.MAX_VALUE);'),
    [],
  );
  assert.deepEqual(codesFor('const n: number = 1;\nconsole.log(n.toPrecision(2));'), ['STA1214']);
  assert.deepEqual(codesFor('console.log(Number.isInteger(1));'), ['STA1214']);
  assert.deepEqual(codesFor('const n: number = 1;\nconst f = n.toFixed;\nconsole.log(f);'), [
    'STA1214',
  ]);
});

test('inheritance, overriding and super.m() are accepted; a re-declared FIELD is shared', () => {
  const chain = `class A {\n  n = 1;\n  m(): number {\n    return this.n;\n  }\n}\n`;
  assert.deepEqual(
    codesFor(`${chain}class B extends A {\n  k = 2;\n}\nconsole.log(new B().m());`),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${chain}class B extends A {\n  override m(): number {\n    return 2;\n  }\n}\nconsole.log(new B().m());`,
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${chain}class B extends A {\n  override m(): number {\n    return super.m() + 1;\n  }\n}\nconsole.log(new B().m());`,
    ),
    [],
  );
  // A field is a SLOT, and a subclass re-declaring one shares it: the base initializers run in
  // `super(...)` and the subclass's overwrite after, which is exactly what the language does. A
  // slot and a METHOD under one name is still refused -- reads would take the method while
  // writes take the slot.
  assert.deepEqual(
    codesFor(`${chain}class B extends A {\n  override n = 2;\n}\nconsole.log(new B().m());`),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${chain}class B extends A {\n  override n(): number {\n    return 2;\n  }\n}\nconsole.log(new B().m());`,
    ),
    ['STA1214'],
  );
});

test('a method table is a file-scope constant, so an override inside a function is not', () => {
  // A class declared in a function may have methods that CAPTURE, and a captured environment is
  // per evaluation of the declaration -- there is no one table for the class to point at.
  const nested = `function f(): number {\n  class A {\n    m(): number {\n      return 1;\n    }\n  }\n  class B extends A {\n    override m(): number {\n      return 2;\n    }\n  }\n  return new B().m();\n}\nconsole.log(f());`;
  assert.deepEqual(codesFor(nested), ['STA1214']);
});

test('super is a marker on two forms, not a value', () => {
  const chain = `class A {\n  n = 1;\n  m(): number {\n    return this.n;\n  }\n}\n`;
  // `super.n` is the same SLOT as `this.n` -- the spelling would promise a distinction the layout
  // cannot make -- and `super.m` as a value would need a bound method object nothing builds.
  assert.deepEqual(
    codesFor(
      `${chain}class B extends A {\n  k(): number {\n    return super.n;\n  }\n}\nconsole.log(new B().k());`,
    ),
    ['STA1214'],
  );
});

test('a derived constructor may validate before super(...)', () => {
  // Field initializers are spliced after the super call wherever it stands, so statements before
  // it must not read the receiver -- but validating or transforming the parameters is the shape
  // real constructors take. With no initializers to splice, the call may also sit in `if`/`else`
  // arms (one per arm, every arm covered); with initializers it keeps the top-level rule
  // (plan.md §8 step 12(d), plan-notes 277).
  const base = 'class A {\n  n: number;\n  constructor(n: number) {\n    this.n = n;\n  }\n}\n';
  assert.deepEqual(
    codesFor(
      `${base}class B extends A {\n  constructor() {\n    super(1);\n  }\n}\nconsole.log(new B().n);`,
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${base}class B extends A {\n  constructor() {\n    console.log(0);\n    super(1);\n  }\n}\nconsole.log(new B().n);`,
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${base}class B extends A {\n  constructor(n: number) {\n    if (n > 0) {\n      super(n);\n    } else {\n      super(0);\n    }\n  }\n}\nconsole.log(new B().n);`,
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      `${base}class B extends A {\n  doubled = 0;\n  constructor(n: number) {\n    if (n > 0) {\n      super(n);\n    } else {\n      super(0);\n    }\n  }\n}\nconsole.log(new B().n);`,
    ),
    ['STA1214'],
  );
});

test('statics are accepted; what has no class object to read is not', () => {
  const cls = 'class C {\n  static n = 1;\n  static m(): number {\n    return C.n;\n  }\n}\n';
  assert.deepEqual(codesFor(`${cls}console.log(C.m());`), []);
  // A static initialization block runs at class-definition time against the statics, which are
  // plain bindings initialized where the class declaration sits -- so its statements lower
  // right after it. `this.x` naming a static erases to that binding; bare `this` stays refused.
  assert.deepEqual(
    codesFor('class C {\n  static n = 1;\n  static {\n    C.n = 2;\n  }\n}\nconsole.log(C.n);'),
    [],
  );
  assert.deepEqual(
    codesFor('class C {\n  static n = 1;\n  static {\n    this.n = 2;\n  }\n}\nconsole.log(C.n);'),
    [],
  );
  assert.deepEqual(
    codesFor('class C {\n  static n = 1;\n  static {\n    console.log(this);\n  }\n}\n'),
    ['STA1214'],
  );
  assert.deepEqual(
    codesFor(
      'class C {\n  static n = 1;\n  static m(): number {\n    return this.n;\n  }\n}\nconsole.log(C.m());',
    ),
    ['STA1214'],
  );
  // The rest of the class object -- `C.name`, `C.prototype` -- is a member no static declares.
  assert.deepEqual(codesFor('class C {\n  static n = 1;\n}\nconsole.log(C.name);'), ['STA1214']);
});

test('a class alias erases in place and stays not-yet as a value', () => {
  // `const K = C` binds no value: every in-place use erases to the target declaration, so the
  // three spellings below compile exactly as the direct ones (plan.md §8 step 12e). Anything
  // else reads the alias as a value, which is the class object -- the same STA1214.
  const cls =
    'class C {\n  x: number = 1;\n  static s: number = 5;\n  static sm(): number {\n    return C.s;\n  }\n}\nconst K = C;\n';
  assert.deepEqual(codesFor(`${cls}console.log(new K().x);`), []);
  assert.deepEqual(codesFor(`${cls}console.log(new K() instanceof K);`), []);
  assert.deepEqual(codesFor(`${cls}console.log(K.s);\nconsole.log(K.sm());`), []);
  assert.deepEqual(codesFor(`${cls}K.s = 2;\nconsole.log(K.s);`), []);
  assert.deepEqual(codesFor(`${cls}const J = K;\nconsole.log(new J() instanceof K);`), []);
  assert.deepEqual(codesFor(`${cls}console.log(K);`), ['STA1214']);
  assert.deepEqual(codesFor(`${cls}function f(v: unknown): void { console.log(v); }\nf(K);`), [
    'STA1214',
  ]);
  // A `let` can be reassigned, so erasing it would compile a different program.
  assert.deepEqual(
    codesFor('class C {\n  x: number = 1;\n}\nlet K = C;\nconsole.log(new K().x);'),
    ['STA1214'],
  );
  // A heritage base naming an alias grounds to the target's layout (plan.md §8 step 43): a
  // `const` chain erases, while a `let` stays refused at the heritage rule.
  assert.deepEqual(codesFor(`${cls}class D extends K {\n}\nconsole.log(new D().x);`), []);
  assert.deepEqual(
    codesFor(`${cls}const J = K;\nclass E extends J {\n}\nconsole.log(new E().x);`),
    [],
  );
  // A `let` alias erases nowhere: the formation itself reads the class as a value, and the
  // heritage base stays refused -- two diagnostics under the one code.
  assert.deepEqual(
    codesFor('class C {\n  x: number = 1;\n}\nlet K = C;\nclass D extends K {\n}\nconsole.log(1);'),
    ['STA1214', 'STA1214'],
  );
  // A computed base is a value, not a declaration: no layout exists to ground the subclass in,
  // so a true mixin stays not-yet under the same heritage message, in both modes.
  for (const mode of ['ts', 'js'] as const) {
    assert.deepEqual(
      codesFor(
        'class C {\n  x: number = 1;\n}\nfunction mixin(Base: new () => C): new () => C {\n  return Base;\n}\nclass D extends mixin(C) {\n  y: number = 2;\n}\nconsole.log(new D().x);',
        mode,
        mode === 'js' ? '/test.js' : '/test.ts',
      ),
      ['STA1214'],
    );
  }
  // A member-expression base naming one class declaration is accepted by the heritage rule;
  // the namespace itself stays not-yet on its own verdict, which is then the only diagnostic.
  {
    const { program } = createProgram(
      'namespace NS {\n  export class C {\n    x: number = 1;\n  }\n}\nclass D extends NS.C {\n  y: number = 2;\n}\nconsole.log(new D().x);',
    );
    const diags = gateProgram(program, 'ts');
    assert.deepEqual(
      diags.map((d) => d.code),
      ['STA1214'],
    );
    assert.match(diags[0]?.message ?? '', /ModuleDeclaration/);
  }
  // The message is the class's own, in both modes.
  for (const mode of ['ts', 'js'] as const) {
    const { program } = createProgram(
      mode === 'js' ? 'class C { }\nconst K = C;\nconsole.log(K);' : `${cls}console.log(K);`,
      mode === 'js' ? '/test.js' : '/test.ts',
    );
    const diags = gateProgram(program, mode);
    assert.deepEqual(
      diags.map((d) => d.code),
      ['STA1214'],
    );
    assert.match(
      diags[0]?.message ?? '',
      /using a class as a value is not yet supported; planned for Phase 5/,
    );
  }
});

test('a bound class expression is vetted like a declaration and compiles', () => {
  // `const C = class { … }` used to fall into the describeKind catch-all ("classes is not yet
  // supported"). It now runs through gateClass like a declaration: a broken member reads as
  // the member problem, and a well-formed bound expression is accepted — the formation emits
  // the descriptor and binds no value, and every in-place use erases to it (plan.md §8 step
  // 12(d), plan-notes 278).
  for (const mode of ['ts', 'js'] as const) {
    const { program } = createProgram(
      'const C = class { m() { return 7; } }\nconsole.log(new C().m());',
      mode === 'js' ? '/test.js' : '/test.ts',
    );
    assert.deepEqual(
      gateProgram(program, mode).map((d) => d.code),
      [],
    );
  }
  // A named expression vets the same way; the inner name is visible in the class body only.
  const { program: namedProgram } = createProgram(
    'const C = class D { m() { return 7; } n() { return new D().m(); } }\nconsole.log(new C().n());',
    '/test.ts',
  );
  assert.deepEqual(
    gateProgram(namedProgram, 'ts').map((d) => d.code),
    [],
  );
  // Still refused, each with the message that names it: an unbound expression has no identity,
  // a `let` formation the file repoints names two classes (one nothing writes is a formation,
  // plan.md §11d T12.3), a generic one has nowhere to specialize, and an opaque use reads the
  // class object (plan.md §8 step 12e).
  assert.deepEqual(
    codesFor(
      'function take(x: unknown): void {}\ntake(class { m() { return 1; } });\nexport const x = 1;\n',
    ),
    ['STA1214'],
  );
  const unbound = gateProgram(
    createProgram(
      'function take(x: unknown): void {}\ntake(class { m() { return 1; } });\nexport const x = 1;\n',
    ).program,
    'ts',
  );
  assert.match(
    unbound[0]?.message ?? '',
    /an anonymous class expression is not yet supported; planned for Phase 5/,
  );
  assert.deepEqual(
    codesFor('let C = class D { m() { return 7; } }\nconsole.log(new C().m());\n'),
    [],
  );
  const repointed =
    'let C = class D { m() { return 7; } }\nC = class D {};\nconsole.log(new C());\n';
  assert.deepEqual(codesFor(repointed), ['STA1214', 'STA1214']);
  const letBound = gateProgram(createProgram(repointed).program, 'ts');
  assert.match(letBound[0]?.message ?? '', /a class expression 'D' is not yet supported/);
  assert.deepEqual(codesFor('const C = class<T> { m(): T | undefined { return undefined; } }\n'), [
    'STA1214',
  ]);
  const generic = gateProgram(
    createProgram('const C = class<T> { m(): T | undefined { return undefined; } }\n').program,
    'ts',
  );
  assert.match(generic[0]?.message ?? '', /a generic class expression is not yet supported/);
  assert.deepEqual(codesFor('const C = class { m() { return 7; } }\nconsole.log(C);\n'), [
    'STA1214',
  ]);
  const opaque = gateProgram(
    createProgram('const C = class { m() { return 7; } }\nconsole.log(C);\n').program,
    'ts',
  );
  assert.match(opaque[0]?.message ?? '', /using a class as a value is not yet supported/);
  // Shared vetting, not a duplicated one: a computed member in an expression reports the member.
  assert.deepEqual(
    codesFor(
      'const key: string = "k";\nconst C = class D { [key]() { return 1; } };\nexport const x = 1;\n',
    ),
    ['STA1214'],
  );
  // An anonymous default DECLARATION takes Node's `.name` (`default`) and is accepted
  // (plan.md §8 step 12(d)); a named default class is accepted as before.
  assert.deepEqual(codesFor('export default class { m() { return 7; } }\n'), []);
  assert.deepEqual(codesFor('export default class N { m() { return 7; } }\n'), []);
});

test('this is gated, not left to the lowering', () => {
  // `this` is a TOKEN, and the gate short-circuits tokens. It is exempted by name, without which
  // its case is dead code and `this` outside a class reaches an internal error instead.
  assert.deepEqual(codesFor('console.log(this);'), ['STA1214']);
  // A field initializer is a `this` position though it is inside no function: the lowering moves
  // it into the constructor, where the receiver is a parameter.
  assert.deepEqual(
    codesFor('class C {\n  a = 1;\n  b = this.a + 1;\n}\nconsole.log(new C().b);'),
    [],
  );
});

test('#private members are accepted, re-declared down the chain included', () => {
  assert.deepEqual(
    codesFor(`class C {
  #n: number = 0;
  static #m: number = 0;
  #read(): number { return this.#n; }
  get(): number { return this.#read() + C.#m; }
}
console.log(new C().get());
`),
    [],
    'a #private field, method and static are ordinary members with an unspellable name',
  );
  // One spelling, one slot PER CLASS: two `#n`s in one chain are two distinct slots under two
  // per-class names, so each body reads the slot its own class declared.
  assert.deepEqual(
    codesFor(`class B { #n: number = 0; b(): number { return this.#n; } }
class D extends B { #n: number = 1; d(): number { return this.#n; } }
console.log(new D().d() + new D().b());
`),
    [],
  );
});

test('the #brand-in-object test is an instanceof against the declaring class', () => {
  // `#n in o` is not a property read: it asks whether o carries the brand, which is exactly
  // whether o is an instance of the class that declares it -- so it lowers to `instanceof`.
  assert.deepEqual(
    codesFor(`class C {
  #n: number = 0;
  static has(o: C): boolean { return #n in o; }
}
console.log(C.has(new C()));
`),
    [],
  );
});

test('accessors are accepted, in statement position and as statics', () => {
  const body = `  raw: number = 0;\n  get value(): number {\n    return this.raw;\n  }\n  set value(v: number) {\n    this.raw = v;\n  }\n`;
  assert.deepEqual(
    codesFor(`class C {\n${body}}\nconst c = new C();\nc.value = 1;\nconsole.log(c.value);`),
    [],
  );
  // A read-modify-write is a get AND a set of one property. The member place machinery
  // evaluates the receiver once into a temporary and threads it through both calls --
  // statement position discards the fold's answer, value position yields it (step 12b).
  assert.deepEqual(
    codesFor(`class C {\n${body}}\nconst c = new C();\nc.value += 1;\nconsole.log(c.value);`),
    [],
  );
  assert.deepEqual(
    codesFor(`class C {\n${body}}\nconst c = new C();\nc.value++;\nconsole.log(c.value);`),
    [],
  );
  assert.deepEqual(
    codesFor(`class C {\n${body}}\nconst c = new C();\nconst y = c.value++;\nconsole.log(y);`),
    [],
  );
  // A static accessor is a pair of plain functions under mangled static bindings: reading
  // `C.value` runs the getter, writing it runs the setter.
  assert.deepEqual(
    codesFor(
      'class C {\n  static raw: number = 0;\n  static get value(): number {\n    return C.raw;\n  }\n  static set value(v: number) {\n    C.raw = v;\n  }\n}\nC.value = 1;\nconsole.log(C.value);',
    ),
    [],
  );
});

test('an object literal is accepted exactly where its shape is a fixed slot list', () => {
  assert.deepEqual(codesFor("const p = { x: 1, y: 'two' };\nconsole.log(p.x);"), []);
  assert.deepEqual(codesFor('const e = {};\nconsole.log(e);'), []);
  assert.deepEqual(codesFor('const t = { c: { d: 1 } };\nconsole.log(t.c.d);'), []);
});

test('every literal form that is not a fixed slot list is a not-yet', () => {
  // Methods landed in step 12(c); a computed key needs the key set at RUNTIME. A spread of a
  // call result landed with the spread-call-result golden (one evaluation per operand): the
  // expansion reads the operand once, so an operand with an effect runs exactly once.
  assert.deepEqual(codesFor('const o = { m(): number { return 1; } };\nconsole.log(o.m());'), []);
  assert.deepEqual(
    codesFor(
      'function f(): { x: number } {\n  return { x: 1 };\n}\nconst b = { ...f() };\nconsole.log(b.x);',
    ),
    [],
  );
});

test('object literal computed keys are accepted on the dynamic shape path', () => {
  assert.deepEqual(codesFor("const k = 'x';\nconst o = { [k]: 1 };\nconsole.log(o.x);"), []);
  assert.deepEqual(codesFor('const o = { b: 1, [0]: 2 };\nconsole.log(o);'), []);
});

// plan.md §8 step 12(c): an accessor member is ACCEPTED, and it takes the shape-table path -- the
// pair lives in the object's slot (docs/VALUE.md §4.15), which no fixed layout has room for. The
// one refusal left is a position typed as a fixed shape: TypeScript calls `{ get at() {…} }`
// assignable to `{ at: number }`, and there is no conversion that could honor it.
test('an object literal accessor is accepted, except into a fixed-shape position', () => {
  assert.deepEqual(
    codesFor('const o = {\n  get x(): number {\n    return 1;\n  },\n};\nconsole.log(o.x);'),
    [],
  );
  assert.deepEqual(
    codesFor(
      'const o = {\n  val: 1,\n  get x(): number {\n    return this.val;\n  },\n  set x(v: number) {\n    this.val = v;\n  },\n};\nconsole.log(o.x);',
    ),
    [],
  );
  assert.deepEqual(
    codesFor(
      'const o: { x: number } = {\n  get x(): number {\n    return 1;\n  },\n};\nconsole.log(o.x);',
    ),
    ['STA1214'],
  );
});

// plan.md §8 step 12 family (c): shorthand is `{ x: x }` -- the same key, the same value, and no
// layout question of its own -- and a string-literal key is the only spelling TypeScript gives a
// key no identifier can express. Both are fixed slot lists, and `o["a-b"]` reads one back.
test('shorthand and string-literal keys are fixed slot lists', () => {
  assert.deepEqual(codesFor('const x = 1;\nconst o = { x };\nconsole.log(o.x);'), []);
  assert.deepEqual(codesFor('const a = { x: 1 };\nconst b = { ...a };\nconsole.log(b.x);'), []);
  assert.deepEqual(codesFor('const o = { "a-b": 1, ok: 2 };\nconsole.log(o["a-b"] + o.ok);'), []);
  // A literal key naming no field of the shape is still an index, not a slot read.
  assert.deepEqual(codesFor('const o = { ok: 2 };\nconsole.log(o["nope"]);'), ['STA1214']);
});

// Task 4.1: an anonymous shape with an OPTIONAL property has no fixed slot list, so it takes the
// dynamic path — shape table + inline caches (docs/VALUE.md §4.10). The gate's job is drawing the
// line: optional or indexed shapes are dynamic, all-required shapes stay fixed, and everything a
// shape table alone cannot serve (methods, calls through it) stays deferred.
test('an object literal typed by an optional shape is accepted', () => {
  assert.deepEqual(codesFor('const o: { x?: number } = { x: 1 };\nconsole.log(o);'), []);
  // The empty literal is the canonical dynamic object: nothing to build a layout FROM.
  assert.deepEqual(codesFor('const o: { x?: number } = {};\nconsole.log(o);'), []);
});

test('reads and plain writes through a dynamic shape are accepted', () => {
  const source = 'const o: { x?: number; y?: number } = { x: 1 };\no.y = 2;\nconsole.log(o.x);';
  assert.deepEqual(codesFor(source), []);
});

test('compound assignment through a dynamic shape is accepted', () => {
  // UpdateExpr evaluates the receiver once, so a shape-table entry is a legal place.
  const source = 'const o: { x?: number } = { x: 1 };\no.x += 1;';
  assert.deepEqual(codesFor(source), []);
});

test('an object literal method member is accepted; method-as-value stays not-yet', () => {
  assert.deepEqual(
    codesFor('const o = { v: 1, m() { return this.v; } };\nconsole.log(o.m());'),
    [],
  );
  const call = 'const o: { x?: number; m?: () => number } = { m: () => 2 };\nconsole.log(o.m());';
  assert.deepEqual(codesFor(call), []);
  assert.deepEqual(codesFor('const o = { m() { return 1; } };\nconst f = o.m;'), ['STA1214']);
});

test('an Unknown receiver accepts property get, set, index, and call', () => {
  // plan.md §8 step 4: untyped `o.x` / `o.x = v` / `o[k]` / `o.m()` take the shape-table path.
  // A typed dynamic shape still refuses a CALL through the table (bound methods wait).
  assert.deepEqual(codesFor('function f(o) { return o.x; }', 'js'), []);
  assert.deepEqual(codesFor('function f(o) { o.x = 1; }', 'js'), []);
  assert.deepEqual(codesFor('function f(o, k) { return o[k]; }', 'js'), []);
  assert.deepEqual(codesFor('function f(o) { return o.m(1); }', 'js'), []);
  assert.deepEqual(codesFor('let o = {};\no.x = 1;\nconsole.log(o.x);', 'js'), []);
});

test('the contextual type decides: a fully-required literal under an optional annotation is dynamic', () => {
  // `{ x: 1 }` alone is a perfectly good layout — but every later read of `o` goes through the
  // annotation, so the literal must build the dynamic object those reads resolve against.
  assert.deepEqual(codesFor('const o: { x?: number } = { x: 1 };\nconsole.log(o.x);'), []);
});

// Task 4.2, Math slice: methods exist only as callees, constants only as reads, and the
// declaration-file test keeps a user binding named Math on the ordinary identifier path.
test('Math methods and constants in the landed set are accepted', () => {
  assert.deepEqual(codesFor('console.log(Math.floor(2.5));'), []);
  assert.deepEqual(codesFor('console.log(Math.min(1, 2, 3));'), []);
  assert.deepEqual(codesFor('console.log(Math.PI);'), []);
  assert.deepEqual(codesFor('console.log(NaN);\nconsole.log(Infinity);'), []);
});

test('the bit-exact Math members are accepted', () => {
  assert.deepEqual(codesFor('console.log(Math.clz32(7));'), []);
  assert.deepEqual(codesFor('console.log(Math.imul(3, 4));'), []);
  assert.deepEqual(codesFor('console.log(Math.fround(0.1));'), []);
});

// The approximated transcendentals used to be deferred here, waiting on vendored fdlibm. They
// landed with it (plan-notes 117), so this now pins the opposite: they must be ACCEPTED, and the
// host libm must not be what answers them.
test('the approximated transcendentals are accepted', () => {
  assert.deepEqual(codesFor('console.log(Math.sin(1));'), []);
  assert.deepEqual(codesFor('console.log(Math.log2(8));'), []);
  assert.deepEqual(codesFor('console.log(Math.atan2(1, 2));'), []);
  assert.deepEqual(codesFor('console.log(Math.random());'), []);
});

test('a Math method as a VALUE and an unfoldable variadic stay deferred', () => {
  assert.deepEqual(codesFor('const f = Math.floor;\nconsole.log(f(1));'), ['STA1214']);
  assert.deepEqual(codesFor('const xs = [1, 2];\nconsole.log(Math.min(...xs));'), ['STA1214']);
  // hypot is not associative, so unlike min/max its variadic form cannot be folded into nested
  // binary calls -- V8 computes the 3-argument case with a Kahan compensation term. Refused
  // rather than approximated; the binary and degenerate arities are accepted.
  assert.deepEqual(codesFor('console.log(Math.hypot(1, 2, 3));'), ['STA1214']);
  assert.deepEqual(codesFor('console.log(Math.hypot(3, 4));'), []);
  assert.deepEqual(codesFor('console.log(Math.hypot(-7));'), []);
  assert.deepEqual(codesFor('console.log(Math.hypot());'), []);
});

// Task 4.2, String slice: the closed STRING_OPS set is accepted only in callee position on a
// string-typed receiver; everything else on String.prototype stays deferred.
test('String.prototype ops in the landed set are accepted', () => {
  assert.deepEqual(codesFor('console.log("abc".indexOf("b", 1));'), []);
  assert.deepEqual(codesFor('const s: string = "a,b";\nconsole.log(s.split(","));'), []);
  assert.deepEqual(codesFor('console.log("a-b".replaceAll("-", "+"));'), []);
  assert.deepEqual(codesFor('console.log("x".padStart(3, "0"));'), []);
});

test('String.prototype residue stays deferred', () => {
  // A method as a VALUE: there is no bound-function object to hand out yet.
  assert.deepEqual(codesFor('const f = "abc".trim;\nconsole.log(f());'), ['STA1214']);
  // A member outside the landed set. `match` and `matchAll` are in the table; a string pattern
  // for matchAll is still refused (RegExpCreate).
  assert.deepEqual(codesFor('console.log("abc".matchAll(/b/g));'), []);
  assert.deepEqual(codesFor('console.log("abc".matchAll("b"));'), ['STA1214']);
  // split's limit argument changes the element-count contract; deferred with the rest.
  assert.deepEqual(codesFor('console.log("a,b".split(",", 1));'), ['STA1214']);
  // A REPLACEMENT that is a regexp is not a pattern: only argument zero takes one.
  assert.deepEqual(codesFor('console.log("abc".replace("b", /x/));'), ['STA1214']);
  // A replacer FUNCTION runs user code per match, which no string op has machinery for.
  assert.deepEqual(codesFor('console.log("abc".replace(/b/, (m: string) => m));'), ['STA1214']);
  // Spread arguments never reach the fixed-arity table.
  assert.deepEqual(codesFor('const xs: [string] = ["b"];\nconsole.log("abc".includes(...xs));'), [
    'STA1214',
  ]);
});

// Task 4.2, Array slice: the closed ARRAY_OPS set on an array-typed receiver, with the refusals
// that keep the fixed-arity table honest.
test('the at/codePointAt/concat/identity string ops are accepted', () => {
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.at(-1));'), []);
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.codePointAt(0));'), []);
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.concat("b"));'), []);
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.toString());'), []);
  // Variadic concat folds left into nested singles (plan.md §8 step 19).
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.concat("b", "c"));'), []);
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.concat());'), []);
});

test('String.fromCharCode lands with any count; the rest of String is named', () => {
  // Plan.md §8 step 19: the multi-code form, the single-code form (previously the catch-all),
  // and the zero-argument empty string.
  assert.deepEqual(codesFor('console.log(String.fromCharCode(65, 66));'), []);
  assert.deepEqual(codesFor('console.log(String.fromCharCode(65));'), []);
  assert.deepEqual(codesFor('console.log(String.fromCharCode());'), []);
  // A member outside the landed set is deferred BY NAME, never by the catch-all.
  assert.deepEqual(codesFor('console.log(String.fromCodePoint(65));'), ['STA1214']);
  // A namespace method as a value: there is no function object to hand out.
  assert.deepEqual(codesFor('const f = String.fromCharCode;\nconsole.log(typeof f);'), ['STA1214']);
  // `String(x)` the converter is a different surface: it landed with the global functions
  // (plan.md §11c T11.4), and `String` read as a value stays deferred.
  assert.deepEqual(codesFor('console.log(String(42));'), []);
  assert.deepEqual(codesFor('const S = String;\nconsole.log(S(42));'), ['STA1214']);
});

test('Array.prototype ops in the landed set are accepted', () => {
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.push(2));'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1, 2];\nconsole.log(xs.indexOf(2, 1));'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1, 2];\nconsole.log(xs.join("-"));'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1, 2];\nconsole.log(xs.concat([3]));'), []);
  // The callback methods: an arrow, and a named function as the callback.
  assert.deepEqual(
    codesFor('const xs: number[] = [1];\nconsole.log(xs.map((x: number): number => x));'),
    [],
  );
  assert.deepEqual(
    codesFor(
      'function odd(x: number): boolean { return x % 2 === 1; }\nconsole.log([1, 2].filter(odd));',
    ),
    [],
  );
  // reduce, in its with-initial form.
  assert.deepEqual(
    codesFor(
      'const xs: number[] = [1];\nconsole.log(xs.reduce((a: number, x: number): number => a + x, 0));',
    ),
    [],
  );
  // The structural ops: exact-arity splice, default-depth flat, copyWithin's padded range.
  assert.deepEqual(codesFor('const xs: number[] = [1, 2, 3];\nconsole.log(xs.splice(1, 1));'), []);
  assert.deepEqual(codesFor('const xs: number[][] = [[1]];\nconsole.log(xs.flat());'), []);
  assert.deepEqual(
    codesFor('const xs: number[] = [1, 2, 3];\nconsole.log(xs.copyWithin(0, 1));'),
    [],
  );
  assert.deepEqual(
    codesFor('const xs: number[] = [1];\nconsole.log(xs.flatMap((x: number): number[] => [x]));'),
    [],
  );
  // The find-last mirrors and the ES2023 immutable variants.
  assert.deepEqual(
    codesFor('const xs: number[] = [1];\nconsole.log(xs.findLast((x: number): boolean => x > 0));'),
    [],
  );
  assert.deepEqual(codesFor('const xs: number[] = [2, 1];\nconsole.log(xs.toReversed());'), []);
  assert.deepEqual(codesFor('const xs: number[] = [2, 1];\nconsole.log(xs.toSorted());'), []);
  assert.deepEqual(codesFor('const xs: number[] = [2, 1];\nconsole.log(xs.toString());'), []);
  assert.deepEqual(codesFor('const xs: number[] = [2, 1];\nconsole.log(xs.with(0, 9));'), []);
  // sort: the ToString default and the comparator form.
  assert.deepEqual(codesFor('const xs: number[] = [2, 1];\nconsole.log(xs.sort());'), []);
  assert.deepEqual(
    codesFor(
      'const xs: number[] = [2, 1];\nconsole.log(xs.sort((a: number, b: number): number => a - b));',
    ),
    [],
  );
});

test('the locale-sensitive trio follows the ICU feature build', () => {
  // Off by default, and refused by NAME rather than by the generic subset-boundary code: the
  // program is not waiting for a phase, it is waiting for a build flag the message spells out.
  assert.deepEqual(codesFor('console.log("a".localeCompare("b", "en"));'), ['STA1215']);
  assert.deepEqual(codesFor('console.log("i".toLocaleUpperCase("tr"));'), ['STA1215']);
  assert.deepEqual(codesFor('console.log("I".toLocaleLowerCase("tr"));'), ['STA1215']);

  const saved = process.env['STATOR_RUNTIME'];
  process.env['STATOR_RUNTIME'] = 'intl';
  try {
    assert.deepEqual(codesFor('console.log("a".localeCompare("b", "en"));'), []);
    assert.deepEqual(codesFor('console.log("i".toLocaleUpperCase("tr"));'), []);
    // The absent-locale form stays refused WITH the flag on: the spec reads the host's default
    // locale there, so the compiled program's answer would depend on the machine that runs it.
    assert.deepEqual(codesFor('console.log("a".localeCompare("b"));'), ['STA1214']);
    assert.deepEqual(codesFor('console.log("i".toLocaleUpperCase());'), ['STA1214']);
    // `locales` is legally a string[] and `options` an object; both are Intl negotiation this
    // compiler does not model.
    assert.deepEqual(
      codesFor('const ls: string[] = ["en"];\nconsole.log("a".localeCompare("b", ls));'),
      ['STA1214'],
    );
  } finally {
    if (saved === undefined) {
      delete process.env['STATOR_RUNTIME'];
    } else {
      process.env['STATOR_RUNTIME'] = saved;
    }
  }
});

test('Array.prototype residue stays deferred', () => {
  // The thisArg form of a callback method lowers with none of them.
  assert.deepEqual(
    codesFor(
      'const xs: number[] = [1];\nconsole.log(xs.map(function (x: number): number { return x; }, {}));',
    ),
    ['STA1214'],
  );
  // reduce WITHOUT an initial value is deferred: the first element becomes the seed there, and
  // an explicit undefined initial is an initial, so the forms cannot share a padded signature.
  assert.deepEqual(
    codesFor(
      'const xs: number[] = [1];\nconsole.log(xs.reduce((a: number, x: number): number => a + x));',
    ),
    ['STA1214'],
  );
  // splice's one-argument form deletes to the end, and the insertion form takes any
  // further arguments (plan.md §8 step 19).
  assert.deepEqual(codesFor('const xs: number[] = [1, 2, 3];\nconsole.log(xs.splice(1));'), []);
  assert.deepEqual(
    codesFor('const xs: number[] = [1, 2, 3];\nconsole.log(xs.splice(1, 1, 9, 8));'),
    [],
  );
  // `toSpliced` keeps its two-argument form: the insertion variant is still deferred.
  assert.deepEqual(
    codesFor('const xs: number[] = [1, 2, 3];\nconsole.log(xs.toSpliced(1, 1, 9));'),
    ['STA1214'],
  );
  // Variadic push and unshift land with any count (plan.md §8 step 19).
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.push(2, 3));'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.push());'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.unshift(0, 1));'), []);
  // lastIndexOf takes an optional position; a third argument stays deferred (in a real
  // ts-mode build the checker's own arity diagnostic owns that refusal first; the gate-level
  // truth this helper reads is the STA1214 below, which is what js mode reports end to end).
  assert.deepEqual(
    codesFor('const xs: number[] = [1, 2];\nconsole.log(xs.lastIndexOf(1, 0));'),
    [],
  );
  assert.deepEqual(
    codesFor('const xs: number[] = [1, 2];\nconsole.log(xs.lastIndexOf(1, 0, 0));'),
    ['STA1214'],
  );
  assert.deepEqual(codesFor('const xs = [1, 2];\nconsole.log(xs.lastIndexOf(1, 0, 0));', 'js'), [
    'STA1214',
  ]);
  // concat takes any count: several arrays, none, and (in js mode) values.
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.concat([2], [3]));'), []);
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconsole.log(xs.concat());'), []);
  // Object.prototype members that are NOT table entries must stay deferred: a bare `in` test
  // would find `constructor`/`hasOwnProperty` on the prototype chain (the hasOwn bug).
  assert.deepEqual(codesFor('const s: string = "a";\nconsole.log(s.hasOwnProperty("x"));'), [
    'STA1214',
  ]);
  // A method as a VALUE: there is no bound-function object to hand out.
  assert.deepEqual(codesFor('const xs: number[] = [1];\nconst f = xs.pop;'), ['STA1214']);
});

// Task 4.2, console slice: the eleven members whose output a golden test can hold to Node
// byte-for-byte lower; the rest of console stays deferred.
test('console methods in the landed set are accepted, the rest deferred', () => {
  assert.deepEqual(codesFor('console.error("e");'), []);
  assert.deepEqual(codesFor('console.warn("w");'), []);
  assert.deepEqual(codesFor('console.info("i");\nconsole.debug("d");'), []);
  assert.deepEqual(codesFor('console.dir([1]);'), []);
  assert.deepEqual(codesFor('console.group("g");\nconsole.groupEnd();'), []);
  // Every optional tail is genuinely optional: the omitted argument pads to `undefined`, which
  // means for each of these exactly what absence means.
  assert.deepEqual(codesFor('console.group();\nconsole.groupEnd();'), []);
  assert.deepEqual(codesFor('console.count();\nconsole.count("k");'), []);
  assert.deepEqual(codesFor('console.countReset("k");'), []);
  assert.deepEqual(codesFor('console.assert(true);'), []);
  assert.deepEqual(codesFor('console.assert(false, "why");'), []);
  // `table` landed: its column layout is a pure function of the data, so a golden test CAN pin it
  // to Node. The Map/Set form is not -- Node draws that with an `(iteration index)` column, and a
  // Map with a second `Key` column, which is a different table rather than a wider one.
  assert.deepEqual(codesFor('console.table([1]);'), []);
  assert.deepEqual(codesFor('console.table({ a: 1 });'), []);
  assert.deepEqual(codesFor("console.table('x');"), []);
  assert.deepEqual(codesFor('console.table(new Map([["k", 1]]));'), ['STA1214']);
  assert.deepEqual(codesFor('console.table(new Set([1]));'), ['STA1214']);
  // `time`/`timeEnd` print an elapsed duration and `trace` a stack, neither of which is output a
  // golden test can pin to Node -- so they landed under the DETERMINISM CARVE-OUT instead
  // (plan-notes 124/127), proved by tests/unit/console-carveout.test.ts. The gate treats them like
  // any other console member: only arity is its business.
  assert.deepEqual(codesFor('console.time("t");'), []);
  assert.deepEqual(codesFor('console.time();'), []);
  assert.deepEqual(codesFor('console.timeEnd("t");'), []);
  assert.deepEqual(codesFor('console.trace("t");'), []);
  assert.deepEqual(codesFor('console.trace();'), []);
  assert.deepEqual(codesFor('console.time("a", "b");'), ['STA1214']);
  // Arity is part of the accepted form, not a detail the emitter shrugs off.
  assert.deepEqual(codesFor('console.groupEnd(1);'), ['STA1214']);
  assert.deepEqual(codesFor('console.assert();'), ['STA1214']);
  assert.deepEqual(codesFor('console.count("a", "b");'), ['STA1214']);
  // A spread's argument COUNT is not its arity, and both the padding and the entry-point choice
  // are made by count.
  assert.deepEqual(codesFor('const xs: [number] = [1];\nconsole.log(...xs);'), ['STA1214']);
});

// Task 4.2: `Date`. What the gate decides here is which members exist, and every refusal carries
// STA1210 (Date's residue code, as STA1211 is RegExp's) rather than the generic STA1214, so a
// program can tell "this builtin is partly here" from "this construct is not". After slice B the
// residue is exactly the ICU-dependent string forms.
test('gate: Date lands the UTC and local surfaces and refuses the ICU forms by name', () => {
  // The constructor: one argument (a time value, an ISO string, another Date), or none at all.
  assert.deepEqual(codesFor('const d = new Date(0);'), []);
  assert.deepEqual(codesFor("const d = new Date('2024-01-01T00:00:00Z');"), []);
  assert.deepEqual(codesFor('const a = new Date(0);\nconst b = new Date(a);'), []);
  // The zero-argument form is ACCEPTED even though it reads a clock: nondeterminism is a proof
  // problem, not an acceptance problem, and tests/unit/date-clock.test.ts is the proof.
  assert.deepEqual(codesFor('const d = new Date();'), []);
  // The COMPONENT constructor, two components up to all seven. A spread is still refused: the
  // arity a spread contributes is not knowable at the gate.
  assert.deepEqual(codesFor('const d = new Date(2024, 1, 29);'), []);
  assert.deepEqual(codesFor('const d = new Date(2024, 1, 29, 1, 2, 3, 4);'), []);
  assert.deepEqual(codesFor('const xs: [number] = [0];\nconst d = new Date(...xs);'), ['STA1210']);

  // The landed prototype surface: the two time-value reads, the eight UTC getters, the seven UTC
  // setters, the three string forms.
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.getTime());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.valueOf());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.getUTCFullYear());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.getUTCMilliseconds());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toISOString());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toJSON());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toUTCString());'), []);
  // Trailing components may be omitted -- the lowering pads them -- but not added.
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.setUTCHours(1));'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.setUTCHours(1, 2, 3, 4));'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.setUTCHours(1, 2, 3, 4, 5));'), [
    'STA1210',
  ]);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.setUTCDate());'), ['STA1210']);

  // The local surface, landed with slice B.
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.getFullYear());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.getTimezoneOffset());'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.setHours(1, 2));'), []);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toDateString());'), []);
  // The residue: `toString` and `toTimeString` append the zone's LONG display name, which is ICU
  // data libc cannot produce, so they sit with `toLocale*` rather than with `toDateString`.
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toString());'), ['STA1210']);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toTimeString());'), ['STA1210']);
  assert.deepEqual(codesFor('const d = new Date(0);\nconsole.log(d.toLocaleDateString());'), [
    'STA1210',
  ]);
  // A method used as a VALUE has no function object to bind, the rule every builtin follows.
  assert.deepEqual(codesFor('const d = new Date(0);\nconst f = d.getTime;'), ['STA1214']);

  // The namespace. `now` is a landed member under the carve-out; everything else is refused.
  assert.deepEqual(codesFor('console.log(Date.UTC(2024, 0, 1));'), []);
  assert.deepEqual(codesFor('console.log(Date.UTC(2024, 0, 1, 2, 3, 4, 5));'), []);
  // Only the YEAR is required: §21.4.3.4 defaults month to 0 and the rest to 0/1, and the lib
  // declares every later parameter optional, so a one-argument call is legal both ways.
  assert.deepEqual(codesFor('console.log(Date.UTC(2024));'), []);
  assert.deepEqual(codesFor('console.log(Date.UTC());'), ['STA1210']);
  assert.deepEqual(codesFor('console.log(Date.UTC(2024, 0, 1, 2, 3, 4, 5, 6));'), ['STA1210']);
  assert.deepEqual(codesFor("console.log(Date.parse('2024-01-01'));"), []);
  assert.deepEqual(codesFor('console.log(Date.now());'), []);
  assert.deepEqual(codesFor('const f = Date.now;'), ['STA1214']);
});

// Task 4.2: Map/Set forEach takes a CALLBACK, not an iterator — the distinction that lets it land
// without waiting on the boxed-iterator form of keys/values/entries (Phase 5 step 8).
test('Map and Set forEach are accepted; keys/values/entries are accepted as iterator boxes', () => {
  const map = 'const m = new Map<string, number>();\nm.set("a", 1);\n';
  const set = 'const s = new Set<number>();\ns.add(1);\n';
  assert.deepEqual(
    codesFor(`${map}m.forEach((v: number, k: string): void => { console.log(k); });`),
    [],
  );
  assert.deepEqual(codesFor(`${set}s.forEach((v: number): void => { console.log(v); });`), []);
  // A callback the checker cannot type as callable would reach jsrt_call as a non-closure. The
  // gate speaks for itself here; a real build reports the lib's own type error alongside it, which
  // this helper does not collect.
  assert.deepEqual(codesFor(`${map}const cb: number = 1;\nm.forEach(cb);`), ['STA1214']);
  // The thisArg form binds a `this` a compiled callback does not have.
  assert.deepEqual(codesFor(`${map}m.forEach((v: number): void => { console.log(v); }, {});`), [
    'STA1214',
  ]);
  assert.deepEqual(codesFor(`${map}console.log(m.keys());`), []);
  assert.deepEqual(codesFor(`${map}console.log(m.entries());`), []);
  assert.deepEqual(codesFor(`${set}console.log(s.values());`), []);
  assert.deepEqual(codesFor(`${map}const it = m.keys();\nconsole.log(it.next());`), []);
  assert.deepEqual(
    codesFor('const xs: number[] = [1];\nfor (const k of xs.keys()) { console.log(k); }'),
    [],
  );
  // An operation belongs to the collection that has it: a Set has no `get`, so it never reaches
  // the arity rule below the table lookup.
  assert.deepEqual(codesFor(`${set}console.log(s.get(1));`), ['STA1214']);
});

// Task 4.2, the ES2025 set operations: the only collection ops whose argument is a COLLECTION.
test('the ES2025 set operations are accepted over two Sets, and refused over anything else', () => {
  const two = 'const a = new Set<number>();\na.add(1);\nconst b = new Set<number>();\nb.add(2);\n';
  assert.deepEqual(codesFor(`${two}console.log(a.union(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.intersection(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.difference(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.symmetricDifference(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.isSubsetOf(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.isSupersetOf(b));`), []);
  assert.deepEqual(codesFor(`${two}console.log(a.isDisjointFrom(b));`), []);
  // The lib types the parameter as a set-like OBJECT, so a Map is well-typed here and a plain
  // object literal is too. The runtime reads the argument as a table, so both are refused.
  const map = 'const m = new Map<number, number>();\nm.set(1, 1);\n';
  assert.deepEqual(codesFor(`${two}${map}console.log(a.union(m));`), ['STA1214']);
  assert.deepEqual(
    codesFor(
      `${two}const like = { size: 0, has: (v: number): boolean => v === 1, keys: (): IterableIterator<number> => b.keys() };\nconsole.log(a.union(like));`,
    ),
    // The set-like OBJECT is still refused; `b.keys()` itself is now a legal iterator box.
    ['STA1214'],
  );
  // They belong to Set alone -- a Map has no `union`, so it never reaches the argument rule.
  assert.deepEqual(codesFor(`${two}${map}console.log(m.union(a));`), ['STA1214']);
});

// Task 4.2, Object slice: the landed namespace, over the two object layouts only.
test('Object namespace methods are accepted, the rest deferred', () => {
  assert.deepEqual(codesFor('console.log(Object.keys({ x: 1 }));'), []);
  assert.deepEqual(codesFor('console.log(Object.values({ x: 1 }));'), []);
  assert.deepEqual(codesFor('console.log(Object.entries({ x: 1 }));'), []);
  // The rest of the namespace, and a method as a value, stay deferred by name.
  // `assign` writes, so the two arguments are asked different questions. A fixed-shape TARGET is
  // refused (its reads are slot indices fixed at build time, so an added key is unreadable) while a
  // fixed-shape SOURCE is fine -- reading a fixed shape's keys is what `Object.entries` already
  // does. Growability comes from an optional property or an index signature, never from inference.
  assert.deepEqual(codesFor('console.log(Object.assign({ x: 1 }, { y: 2 }));'), ['STA1214']);
  assert.deepEqual(
    codesFor(
      'const t: Record<string, number> = { x: 1 };\nconsole.log(Object.assign(t, { y: 2 }));',
    ),
    [],
  );
  assert.deepEqual(
    codesFor('const t: { x?: number } = {};\nconsole.log(Object.assign(t, { x: 2 }));'),
    [],
  );
  assert.deepEqual(
    codesFor('const t: Record<string, number> = {};\nconsole.log(Object.assign(t, [1, 2]));'),
    ['STA1214'],
  );
  assert.deepEqual(
    codesFor(
      'const t: Record<string, number> = {};\nconsole.log(Object.assign(t, { a: 1 }, { b: 2 }));',
    ),
    ['STA1214'],
  );
  assert.deepEqual(codesFor('const f = Object.keys;\nconsole.log(f({ x: 1 }));'), ['STA1214']);
  // An argument the runtime cannot walk: an array answers index strings in Node, which neither
  // object layout's walk would produce.
  assert.deepEqual(codesFor('console.log(Object.keys([1, 2]));'), ['STA1214']);
  // getOwnPropertyNames walks like keys; hasOwn takes a second, string-typed argument.
  assert.deepEqual(codesFor('console.log(Object.getOwnPropertyNames({ x: 1 }));'), []);
  assert.deepEqual(codesFor('console.log(Object.hasOwn({ x: 1 }, "x"));'), []);
  assert.deepEqual(
    codesFor('const k: string = "x";\nconsole.log(Object.hasOwn({ x: 1 }, k));'),
    [],
  );
  // Arity is exact per method, both ways.
  assert.deepEqual(codesFor('console.log(Object.hasOwn({ x: 1 }));'), ['STA1214']);
  assert.deepEqual(codesFor('console.log(Object.keys({ x: 1 }, "x"));'), ['STA1214']);
  // fromEntries is the mirror of the walkers: it wants the ARRAY, not the object.
  assert.deepEqual(
    codesFor('const p: string[][] = [["a", "b"]];\nconsole.log(typeof Object.fromEntries(p));'),
    [],
  );
  assert.deepEqual(codesFor('console.log(typeof Object.fromEntries({ x: 1 }));'), ['STA1214']);
});

// Task 4.2, JSON slice: stringify's single-argument form only.
test('JSON.stringify is accepted, its other forms deferred', () => {
  assert.deepEqual(codesFor('console.log(JSON.stringify({ x: 1 }));'), []);
  assert.deepEqual(codesFor('console.log(JSON.stringify([1, 2]));'), []);
  assert.deepEqual(codesFor('console.log(JSON.stringify("s"));'), []);
  // The replacer/space forms change the whole output shape.
  assert.deepEqual(codesFor('console.log(JSON.stringify({ x: 1 }, null, 2));'), ['STA1214']);
  // A method as a value, and the rest of the namespace by name.
  assert.deepEqual(codesFor('const f = JSON.stringify;\nconsole.log(f(1));'), ['STA1214']);
  // A top-level argument that may be undefined: the spec answers undefined where the call's
  // type promises a string.
  assert.deepEqual(
    codesFor('function f(x: number | undefined): string { return JSON.stringify(x); }\nf(1);'),
    ['STA1214'],
  );
  // Likewise a function-typed argument -- stringify answers undefined for it at the top level.
  assert.deepEqual(codesFor('const g = (): number => 1;\nconsole.log(JSON.stringify(g));'), [
    'STA1214',
  ]);
});

// Task 4.2, JSON.parse slice: the single-argument form, whose result is Unknown.
test('JSON.parse is accepted in its single-argument form', () => {
  assert.deepEqual(codesFor('const v: unknown = JSON.parse("[1]");\nconsole.log(typeof v);'), []);
  // Any string-ish argument, not just the `string` type itself.
  assert.deepEqual(
    codesFor(
      'const t: "a" | "b" = "a";\nconst v: unknown = JSON.parse(t);\nconsole.log(typeof v);',
    ),
    [],
  );
  // An untyped argument is the js-mode norm and is accepted -- the runtime settles the tag.
  assert.deepEqual(codesFor('export function f(t) {\n  return JSON.parse(t);\n}', 'js'), []);
  // A reviver runs user code at every node of the result.
  assert.deepEqual(
    codesFor(
      'const v: unknown = JSON.parse("1", (_k: string, x: unknown) => x);\nconsole.log(typeof v);',
    ),
    ['STA1214'],
  );
  // As a value rather than a callee, like every other namespace member.
  assert.deepEqual(codesFor('const f = JSON.parse;\nconsole.log(typeof f("1"));'), ['STA1214']);
  // The gate's answer for an argument the checker types as a known non-string.
  assert.deepEqual(codesFor('export const v = JSON.parse(42);', 'js'), ['STA1214']);
  // The rest of the namespace is still deferred by name.
  assert.deepEqual(codesFor('console.log(typeof JSON.rawJSON);'), ['STA1214']);
});

test('a user binding named Math shadows the global and stays on the ordinary path', () => {
  // The local wins at runtime, so it must win at the gate: inside the function this is a property
  // read on a shape, not a builtin. (Function-scoped, because at the top level of a SCRIPT a
  // `const Math` is a TS redeclaration error against the global `var Math` — the checker then
  // resolves the name to the lib symbol, and there is no shadow to test.)
  const source =
    'function f(): number { const Math = { floor: 1 }; return Math.floor; }\nconsole.log(f());';
  assert.deepEqual(codesFor(source), []);
});

// Task 4.3, the RegExp slice: `test` is the landed surface, and everything else on the prototype
// keeps the family's own code (STA1211) rather than the generic subset-boundary one.
test('regexp literals and test are accepted, the rest of the prototype deferred', () => {
  assert.deepEqual(codesFor('const re = /ab+c/gi;\nconsole.log(re.test("abbc"));'), []);
  // A literal is a value: it lives in a binding, an array, and an argument position.
  assert.deepEqual(codesFor('console.log(/x/.test("x"));'), []);
  assert.deepEqual(codesFor('const all = [/a/, /b/];\nconsole.log(all.length);'), []);
  // The subject follows JSON.parse's rule: a string, or untyped and settled by the runtime.
  assert.deepEqual(codesFor('console.log(/x/.test(1));'), ['STA1214']);
  assert.deepEqual(
    codesFor(
      'function f(s: unknown): boolean { return /x/.test(s as string); }\nconsole.log(f(1));',
    ),
    [],
  );
  // Task 4.1, array-with-properties slice: `exec` landed once an array could carry the
  // `index`/`input`/`groups` a match hangs off its result.
  assert.deepEqual(codesFor('console.log(/x/.exec("x"));'), []);
  // The four names a match exposes, off a receiver the checker narrowed and the HIR types Unknown.
  assert.deepEqual(
    codesFor('const m = /x/.exec("x");\nif (m !== null) { console.log(m.index); }'),
    [],
  );
  assert.deepEqual(
    codesFor('const m = /x/.exec("x");\nif (m !== null) { console.log(m[0]); }'),
    [],
  );
  // Anything else on a match waits for it to have an HIR type of its own -- Phase 5's union work.
  assert.deepEqual(
    codesFor('const m = /x/.exec("x");\nif (m !== null) { console.log(m.slice(0)); }'),
    ['STA1214'],
  );
  // The DATA properties landed with Task 4.2: a closed table of eleven, read off the compiled
  // regexp. `unicodeSets` is the twelfth and is deliberately absent here -- it is declared in
  // lib.es2024 and this project's `lib` is es2023, so it fails the CHECKER before the gate sees it.
  for (const field of [
    'source',
    'flags',
    'lastIndex',
    'global',
    'ignoreCase',
    'multiline',
    'dotAll',
    'sticky',
    'unicode',
    'hasIndices',
  ]) {
    assert.deepEqual(codesFor(`const re = /x/g;\nconsole.log(re.${field});`), [], field);
  }
  assert.deepEqual(codesFor('const re = /x/;\nconsole.log(re.toString());'), []);
  // A WRITE is not a read spelled backwards: it is an assignment target, and the assignment gate
  // admits a field of a class and nothing else -- so it keeps the generic code, not STA1211.
  assert.deepEqual(codesFor('const re = /x/g;\nre.lastIndex = 3;'), ['STA1214']);
  // `compile` is the one member outside both tables (plan-notes 121).
  assert.deepEqual(codesFor("const re = /x/;\nre.compile('y', 'g');"), ['STA1211']);
  // A method as a VALUE is refused for the reason every other prototype method is: nothing here
  // builds the bound closure it would need.
  assert.deepEqual(codesFor('const re = /x/;\nconst t = re.test;\nconsole.log(t);'), ['STA1211']);
});

// Task 4.3, second slice: a pattern position takes a string OR a regexp, and everything else in
// an argument position is still a string.
test('the regexp forms of the pattern-taking string methods are accepted', () => {
  assert.deepEqual(codesFor("console.log('a1b'.split(/\\d/));"), []);
  assert.deepEqual(codesFor("console.log('a1b'.replace(/\\d/, '#'));"), []);
  assert.deepEqual(codesFor("console.log('a1b'.replaceAll(/\\d/g, '#'));"), []);
  assert.deepEqual(codesFor("console.log('a1b'.search(/\\d/));"), []);
  // `search` has no string form: the spec builds a RegExp out of the argument, with a constructor
  // this compiler does not have.
  assert.deepEqual(codesFor("console.log('a1b'.search('1'));"), ['STA1214']);
  // A regexp in a REPLACEMENT position is not a pattern; the string forms are unchanged.
  assert.deepEqual(codesFor("console.log('a1b'.replace('1', '#'));"), []);
  // Task 4.1, array-with-properties slice: `match` joined the table once an array could carry the
  // `index`/`input`/`groups` a non-global match hangs off its result.
  assert.deepEqual(codesFor("console.log('a1b'.match(/\\d/));"), []);
  // `matchAll` answers an iterator of match arrays, which is why it split from `match`.
  assert.deepEqual(codesFor("console.log('a1b'.matchAll(/\\d/g));"), []);
});

// Phase 5 step 2: the diagnostic table is a function of mode. The same source that is a never in
// ts mode is either a dynamic value or a not-yet in js mode — never the other mode's code.
test('explicit any is STA1001 in ts mode and accepted in js mode', () => {
  // Type annotations are TypeScript syntax, so the js-mode case has to live in a .ts file; a .js
  // file would be a parse error rather than a mode decision.
  assert.deepEqual(codesFor('const x: any = 42;'), ['STA1001']);
  assert.deepEqual(codesFor('const x: any = 42;', 'js', '/test.ts'), []);
});

test('as any is explicit STA1001, not implicit STA1003', () => {
  // `const x = 1 as any` has no annotation on the BINDING. Before this step the binding fired
  // STA1003 (implicit) and the AsExpression fired STA1001, and classify picked the first never.
  assert.deepEqual(codesFor('const x = 1 as any;'), ['STA1001']);
  assert.deepEqual(codesFor('const x = 1 as any;', 'js', '/test.ts'), []);
});

test('eval is STA1101 never in ts mode and STA1206 not-yet in js mode', () => {
  assert.deepEqual(codesFor('eval("1 + 1");'), ['STA1101']);
  assert.deepEqual(codesFor('eval("1 + 1");', 'js'), ['STA1206']);
  assert.deepEqual(codesFor('globalThis.eval("1");'), ['STA1101']);
  assert.deepEqual(codesFor('globalThis.eval("1");', 'js'), ['STA1206']);
  // Aliasing is the same construct: a callee check that only looked at the call site would miss it.
  assert.deepEqual(codesFor('const e = eval;'), ['STA1101']);
  assert.deepEqual(codesFor('const e = eval;', 'js'), ['STA1206']);
});

test('Function and new Function are STA1103 in ts mode and STA1206 in js mode', () => {
  assert.deepEqual(codesFor('const f = new Function("return 42");'), ['STA1103']);
  assert.deepEqual(codesFor('const f = new Function("return 42");', 'js'), ['STA1206']);
  assert.deepEqual(codesFor('const f = Function("return 42");'), ['STA1103']);
  assert.deepEqual(codesFor('const f = Function("return 42");', 'js'), ['STA1206']);
});

test('a .js file under ts mode is STA1002 with a --mode=js hint', () => {
  const { program } = createProgram('console.log(1);', '/test.js');
  const diags = gateProgram(program, 'ts');
  assert.deepEqual(
    diags.map((d) => d.code),
    ['STA1002'],
  );
  assert.match(diags[0]?.message ?? '', /`--mode=js`/);
});

test('for-of over a string is accepted', () => {
  assert.deepEqual(codesFor('for (const c of "ab") { console.log(c); }\n'), []);
  assert.deepEqual(codesFor('for (const c of "ab") { console.log(c); }\n', 'js'), []);
});

test('for-of over a Map or a Set is accepted', () => {
  assert.deepEqual(
    codesFor(
      'const m = new Map<string, number>();\nm.set("a", 1);\nfor (const e of m) { console.log(e); }\n',
    ),
    [],
  );
  assert.deepEqual(
    codesFor('const s = new Set<string>();\ns.add("a");\nfor (const e of s) { console.log(e); }\n'),
    [],
  );
  assert.deepEqual(
    codesFor(
      'const m = new Map();\nm.set("a", 1);\nfor (const e of m) { console.log(e); }\n',
      'js',
    ),
    [],
  );
  assert.deepEqual(
    codesFor('const s = new Set();\ns.add("a");\nfor (const e of s) { console.log(e); }\n', 'js'),
    [],
  );
});

test('function* declarations and yield are accepted; methods and yield* are not', () => {
  assert.deepEqual(
    codesFor(
      'function* g(): Generator<number> { yield 1; }\nfor (const x of g()) { console.log(x); }\n',
    ),
    [],
  );
  assert.deepEqual(codesFor('function* g() { yield 1; }\nconsole.log(g().next());\n', 'js'), []);
  assert.deepEqual(
    codesFor(
      'function* g(): Generator<number, number, number> { const a: number = yield 1; return a; }\nconsole.log(g().next(2));\n',
    ),
    [],
  );
  // Generator methods keep STA1201: a receiver would have to join the heap environment.
  assert.deepEqual(codesFor('class C { *m(): Generator<number> { yield 1; } }\n'), ['STA1201']);
  assert.deepEqual(codesFor('class C { *m() { yield 1; } }\n', 'js'), ['STA1201']);
  assert.deepEqual(codesFor('function* g(): Generator<number> { yield* [1]; }\n'), ['STA1214']);
  assert.deepEqual(codesFor('async function* g(): AsyncGenerator<number> { yield 1; }\n'), [
    'STA1201',
  ]);
});

test('a declaration without an initializer is accepted', () => {
  assert.deepEqual(codesFor('let n: number; n = 1;'), []);
  assert.deepEqual(codesFor('let n; n = 1;', 'js'), []);
});

test('default and optional parameters are accepted', () => {
  assert.deepEqual(codesFor('function greet(name: string = "world"): string { return name; }'), []);
  assert.deepEqual(codesFor('function greet(name = "world") { return name; }', 'js'), []);
  assert.deepEqual(codesFor('function f(x?: number): number { return 0; }'), []);
});

test('rest parameters are accepted', () => {
  assert.deepEqual(
    codesFor('function sum(a: number, ...rest: number[]): number { return a; }'),
    [],
  );
  assert.deepEqual(codesFor('function sum(a, ...rest) { return a; }', 'js'), []);
});

test('Promise.prototype.then/catch/finally and new Promise(executor) are accepted', () => {
  assert.deepEqual(codesFor('Promise.resolve(1).then((n: number) => n);'), []);
  assert.deepEqual(codesFor('Promise.reject(1).catch((e: number) => e);'), []);
  assert.deepEqual(codesFor('Promise.resolve(1).finally(() => undefined);'), []);
  assert.deepEqual(codesFor('const p = new Promise<number>((resolve) => { resolve(1); });'), []);
});

test('Object.freeze and Object.isFrozen are accepted', () => {
  assert.deepEqual(
    codesFor(
      'class C { x: number = 1; }\nconst o = new C();\nObject.freeze(o);\nconsole.log(Object.isFrozen(o));',
    ),
    [],
  );
});

test('literal import() is accepted; a computed specifier is STA1207', () => {
  assert.deepEqual(codesFor('const m = import("./x.ts");\n'), []);
  assert.deepEqual(codesFor('const m = import("./x.ts");\n', 'js'), []);
  assert.deepEqual(codesFor('const m = import("x" + ".ts");\n'), ['STA1207']);
});

test('top-level await is accepted; await in a non-async function is not', () => {
  assert.deepEqual(codesFor('const x: number = await Promise.resolve(1);\nconsole.log(x);\n'), []);
  assert.deepEqual(codesFor('const x = await Promise.resolve(1);\nconsole.log(x);\n', 'js'), []);
  assert.deepEqual(codesFor('function f() { return await Promise.resolve(1); }\n'), ['STA1214']);
});
