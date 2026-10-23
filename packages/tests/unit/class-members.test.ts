/* Step-12(d) class member surface — the parts golden tests cannot see.
 *
 * A golden proves the program PRINTS what Node prints. It cannot prove why: that an overload
 * signature emitted no function, that an optional member is one slot rather than two spellings
 * of one, or that a derived constructor's initializers run after `super` wherever `super`
 * stands. Each of those is an invariant the emitter depends on, pinned here.
 */

import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { ClassDeclaration, Statement } from '../../compiler/src/hir/nodes.ts';
import { gateCodes, hirNodes, verifiedStatements } from './helpers.ts';

function classOf(code: string): ClassDeclaration {
  const found = verifiedStatements(code).find((s) => s.kind === 'class-declaration');
  assert.ok(found !== undefined, 'source should declare a class');
  return found as ClassDeclaration;
}

function classesOf(code: string): ClassDeclaration[] {
  return verifiedStatements(code).filter(
    (s): s is ClassDeclaration => s.kind === 'class-declaration',
  );
}

const OVERLOADED = `class C {
  n: number;
  constructor(n: string);
  constructor(n: number);
  constructor(n: string | number) {
    this.n = typeof n === "number" ? n : 1;
  }
  m(x: string): string;
  m(x: number): number;
  m(x: string | number): string | number {
    return x;
  }
}
`;

test('overload signatures emit nothing; the implementation is the one method', () => {
  const decl = classOf(OVERLOADED);
  assert.deepEqual(
    decl.methods.map((m) => m.name),
    ['m'],
    'two signatures and one implementation lower to one member function',
  );
  assert.ok(decl.ctor !== undefined, 'the constructor implementation survives its signatures');
  assert.equal(decl.ctor.fn.params.length, 2, 'receiver plus the implementation parameter');
});

test('overload signatures are accepted in both modes', () => {
  assert.deepEqual(gateCodes(OVERLOADED, 'ts'), []);
  assert.deepEqual(gateCodes(OVERLOADED, 'js'), []);
});

test('a constructor signature without an implementation stays not-yet', () => {
  const sigOnly = `class C {
    constructor(n: string);
  }
  `;
  assert.deepEqual(gateCodes(sigOnly, 'ts'), ['STA1214']);
});

test('a method signature without an implementation stays not-yet', () => {
  const sigOnly = `class C {
    m(x: string): string;
  }
  `;
  assert.deepEqual(gateCodes(sigOnly, 'ts'), ['STA1214']);
});

test('two constructor bodies are still refused, with or without signatures', () => {
  const bodies = `class C {
    n: number;
    constructor(n: string) {
      this.n = 1;
    }
    constructor(n: number) {
      this.n = n;
    }
  }
  `;
  assert.deepEqual(gateCodes(bodies, 'ts'), ['STA1214']);
});

test('static overloads emit one binding, not one per signature', () => {
  const decl = classOf(`class C {
    static make(s: string): number;
    static make(n: number): number;
    static make(v: string | number): number {
      return typeof v === "number" ? v : 0;
    }
  }
  `);
  assert.deepEqual(
    decl.statics.map((s) => (s as { name: string }).name),
    ['C.make'],
  );
});

test('a derived class forwards the implementation parameters, not a signature', () => {
  const [base, derived] = classesOf(`${OVERLOADED}class D extends C {
    constructor(n: number) {
      super(n);
    }
  }
  `);
  assert.ok(base !== undefined && derived !== undefined);
  assert.ok(derived.ctor !== undefined);
  // The base implementation takes one user parameter; a signature's arity must not leak in.
  assert.equal(derived.ctor.fn.params.length, 2, 'receiver plus the forwarded parameter');
});

test('no stray statements leak from skipped signatures', () => {
  const statements: readonly Statement[] = verifiedStatements(OVERLOADED);
  assert.equal(statements.length, 1, 'the class is the only statement');
});

test('an optional method with a body lowers as a plain method', () => {
  const decl = classOf(`class C {
    m?(): number {
      return 1;
    }
  }
  `);
  assert.deepEqual(
    decl.methods.map((m) => m.name),
    ['m'],
    'the `?` narrows assignability only; at runtime the method is always present',
  );
  assert.deepEqual(
    gateCodes(
      `class C {
      m?(): number {
        return 1;
      }
    }
    `,
      'ts',
    ),
    [],
  );
});

test('an initialized optional field lowers as a plain field', () => {
  const decl = classOf(`class C {
    x?: number = 5;
  }
  `);
  assert.deepEqual(
    decl.fields.map((f) => f.name),
    ['x'],
    'the initializer runs for every instance, so the slot is always present',
  );
});

test('an uninitialized optional field lowers as a plain field', () => {
  // Absent versus holding `undefined` was the old refusal's worry; Node uses define-semantics
  // here (`"x" in c` is true), the slot is always present, and `jsrt_object_new` zero-fills it
  // to `undefined` — so there is no distinction to keep (plan.md §8 step-12 S-B).
  const decl = classOf(`class C {
    x?: number;
  }
  `);
  assert.deepEqual(
    decl.fields.map((f) => f.name),
    ['x'],
    'the slot is always present, like its initialized twin',
  );
  assert.deepEqual(
    gateCodes(
      `class C {
        x?: number;
      }
      `,
      'ts',
    ),
    [],
  );
});

const ACCESSOR = `class C {
  val: number = 0;
  get value(): number {
    return this.val;
  }
  set value(v: number) {
    this.val = v;
  }
}
`;

test('a statement-position compound on an accessor is accepted', () => {
  assert.deepEqual(gateCodes(`${ACCESSOR}const c = new C();\nc.value += 1;\n`, 'ts'), []);
  assert.deepEqual(gateCodes(`${ACCESSOR}const c = new C();\nc.value++;\n`, 'ts'), []);
  assert.deepEqual(gateCodes(`${ACCESSOR}const c = new C();\n--c.value;\n`, 'ts'), []);
});

test('a value-position compound on an accessor stays not-yet', () => {
  // The target lowers to the getter call, which is not an update place.
  assert.deepEqual(gateCodes(`${ACCESSOR}const c = new C();\nconst y = c.value++;\n`, 'ts'), [
    'STA1214',
  ]);
  assert.deepEqual(gateCodes(`${ACCESSOR}const c = new C();\nconst y = (c.value += 1);\n`, 'ts'), [
    'STA1214',
  ]);
});

test('an accessor compound evaluates a side-effecting receiver once', () => {
  const statements = verifiedStatements(
    `${ACCESSOR}function f(c: C): C {\n  return c;\n}\nconst c = new C();\nf(c).value += 1;\n`,
  );
  const block = statements.at(-1);
  assert.equal(block?.kind, 'block', 'the hoisted receiver and the write form one block');
});

const PRIVATE_ACCESSOR = `class C {
  #v: number = 0;
  get #x(): number {
    return this.#v;
  }
  set #x(v: number) {
    this.#v = v;
  }
  run(): number {
    this.#x = 3;
    return this.#x;
  }
  has(o: object): boolean {
    return #x in o;
  }
}
`;

test('a #private accessor lowers as a mangled member function', () => {
  const decl = classOf(PRIVATE_ACCESSOR);
  assert.deepEqual(
    decl.methods.map((m) => m.name),
    ['get #x@C', 'set #x@C', 'run', 'has'],
    'private accessors join the method list under per-class mangled names, like public ones',
  );
  assert.deepEqual(gateCodes(PRIVATE_ACCESSOR, 'ts'), []);
  assert.deepEqual(gateCodes(PRIVATE_ACCESSOR, 'js'), []);
});

test('a literal-typed computed accessor name lowers as a mangled member function', () => {
  // `k` has the literal type `"x"`, so `[k]` is the name `x` -- the step-22 computed-literal
  // rule -- and the pair joins the method list under the resolved name, like a direct spelling.
  const source = `const k = "x";\nclass C {\n  backing: number = 0;\n  get [k](): number {\n    return this.backing;\n  }\n  set [k](v: number) {\n    this.backing = v;\n  }\n}\n`;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  assert.deepEqual(gateCodes(source, 'js'), []);
  const decl = classOf(source);
  assert.deepEqual(
    decl.methods.map((m) => m.name),
    ['get x', 'set x'],
    'a literal-typed computed accessor joins the method list under the resolved name',
  );
});

test('a runtime computed accessor name stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `function build(k: string): void {\n  class C {\n    get [k](): number {\n      return 1;\n    }\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a literal-typed computed method and field lower under the resolved name', () => {
  const source = `const k = "m";\nconst f = "count";\nclass C {\n  [f]: number = 10;\n  [k](): number {\n    return 5;\n  }\n}\n`;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  assert.deepEqual(gateCodes(source, 'js'), []);
  const decl = classOf(source);
  assert.deepEqual(
    decl.fields.map((field) => field.name),
    ['count'],
    'a literal-typed computed field takes the slot the direct spelling writes',
  );
  assert.deepEqual(
    decl.methods.map((method) => method.name),
    ['m'],
    'a literal-typed computed method joins the method list under the resolved name',
  );
});

test('a #private accessor re-declaring an ancestor one stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `class B {\n  get #x(): number {\n    return 1;\n  }\n}\nclass D extends B {\n  get #x(): number {\n    return 2;\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

test('the brand check lowers to instanceof against the declaring class', () => {
  const statements = verifiedStatements(
    `class C {\n  #v: number = 0;\n  has(o: object): boolean {\n    return #v in o;\n  }\n}\n`,
  );
  const kinds = hirNodes(statements).map((n) => n.kind);
  assert.ok(!kinds.includes('binary-op'), 'no `in` binary node survives the lowering');
  const test = hirNodes(statements).find((n) => n.kind === 'instanceof');
  assert.ok(test !== undefined, 'the brand check is an instanceof node');
  assert.equal(
    (test as unknown as { className: string }).className,
    'C',
    'the brand resolves to the class that declares it',
  );
});

test('a brand check cannot name an ancestor-declared brand from a subclass', () => {
  // Private names are lexically scoped: `#v` is not in scope inside `D`, so there is no class
  // for the check to name. (An inherited brand METHOD still works on a subclass instance --
  // the golden proves it -- because the use site is the base's own body.)
  assert.deepEqual(
    gateCodes(
      `class C {\n  #v: number = 0;\n}\nclass D extends C {\n  has(o: object): boolean {\n    return #v in o;\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

const STATIC_ACCESSOR = `class C {
  static val: number = 0;
  static get value(): number {
    return C.val;
  }
  static set value(v: number) {
    C.val = v;
  }
}
`;

test('a static accessor emits two plain functions under mangled static names', () => {
  const decl = classOf(STATIC_ACCESSOR);
  assert.deepEqual(
    decl.statics.map((s) => s.name),
    ['C.val', 'C.get value', 'C.set value'],
    'the pair joins the statics, mangled exactly as instance accessors mangle methods',
  );
  for (const name of ['C.get value', 'C.set value']) {
    const binding = decl.statics.find((s) => s.name === name);
    assert.equal(binding?.declKind, 'const', 'an accessor function cannot be reassigned');
  }
  assert.deepEqual(gateCodes(STATIC_ACCESSOR, 'ts'), []);
  assert.deepEqual(gateCodes(STATIC_ACCESSOR, 'js'), []);
});

test('a static accessor read lowers to a getter call, not a binding read', () => {
  const statements = verifiedStatements(`${STATIC_ACCESSOR}export const x = C.value;\n`);
  const kinds = hirNodes(statements).map((n) => n.kind);
  assert.ok(kinds.includes('call'), 'reading `C.value` runs the getter');
});

test('a static #private accessor emits two plain functions under mangled static names', () => {
  const source = `class C {\n  static #v: number = 0;\n  static get #x(): number {\n    return C.#v;\n  }\n  static set #x(v: number) {\n    C.#v = v;\n  }\n}\n`;
  const decl = classOf(source);
  assert.deepEqual(
    decl.statics.map((s) => s.name),
    ['C.#v', 'C.get #x', 'C.set #x'],
    'the pair joins the statics under the declaring class, exactly as public ones do',
  );
  assert.deepEqual(gateCodes(source, 'ts'), []);
  assert.deepEqual(gateCodes(source, 'js'), []);
});

test('a lone static #private half over an ancestor pair stays not-yet', () => {
  // The missing half would resolve to a binding the subclass never emitted -- the private twin
  // of the identifier pair rule the neighboring test pins.
  assert.deepEqual(
    gateCodes(
      `class C {\n  static get #x(): number {\n    return 1;\n  }\n  static set #x(v: number) {\n  }\n}\nclass D extends C {\n  static get #x(): number {\n    return 2;\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(
      `class C {\n  static get #x(): number {\n    return 1;\n  }\n  static set #x(v: number) {\n  }\n}\nclass D extends C {\n  static get #x(): number {\n    return 2;\n  }\n  static set #x(v: number) {\n  }\n}\n`,
      'ts',
    ),
    [],
  );
});

test('a static accessor overriding an inherited static stays not-yet', () => {
  // Only a COMPLETE pair shadows cleanly: a lone half would split the pair across the chain,
  // with the missing half resolving to a binding the subclass never emitted.
  assert.deepEqual(
    gateCodes(
      `class C {\n  static get val(): number {\n    return 1;\n  }\n  static set val(v: number) {\n  }\n}\nclass D extends C {\n  static get val(): number {\n    return 2;\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(
      `class C {\n  static get val(): number {\n    return 1;\n  }\n  static set val(v: number) {\n  }\n}\nclass D extends C {\n  static get val(): number {\n    return 2;\n  }\n  static set val(v: number) {\n  }\n}\n`,
      'ts',
    ),
    [],
  );
});

const STATIC_BLOCK = `class C {
  static n = 1;
  static {
    C.n = 2;
  }
}
`;

test('a static block lowers after the class declaration, in the same scope', () => {
  const statements = verifiedStatements(STATIC_BLOCK);
  assert.equal(statements.length, 1, 'the declaration and its blocks stay one statement');
  const block = statements[0];
  assert.equal(block?.kind, 'block', 'a flattened wrapper, not a new node kind');
  const inner = (block as unknown as { statements: { kind: string }[] }).statements;
  assert.deepEqual(
    inner.map((s) => s.kind),
    ['class-declaration', 'block'],
  );
  assert.deepEqual(gateCodes(STATIC_BLOCK, 'ts'), []);
  assert.deepEqual(gateCodes(STATIC_BLOCK, 'js'), []);
});

test('this in a static block stays not-yet', () => {
  assert.deepEqual(
    gateCodes(`class C {\n  static n = 1;\n  static {\n    this.n = 2;\n  }\n}\n`, 'ts'),
    ['STA1214'],
  );
});

test('super in a static block stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `class B {\n  m(): number {\n    return 1;\n  }\n}\nclass D extends B {\n  static s = 0;\n  static {\n    D.s = super.m();\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a static field after a static block initializes after it', () => {
  // Source order is execution order: the later field's slot is `undefined` in the declaration
  // and assigns after its block (plan.md §8 step 12(d), plan-notes 276). A block that touches
  // a later field is still refused — by the checker (`used before its initialization`, both
  // modes), not the gate — so the gate accepts the ordering shape here.
  const source = `class C {
    static a = 1;
    static {
      C.a = C.a + 1;
    }
    static b = C.a * 10;
  }
  `;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  assert.deepEqual(gateCodes(source, 'js'), []);
  const [wrapper] = verifiedStatements(source).filter((s) => s.kind === 'block');
  assert.ok(wrapper !== undefined && wrapper.kind === 'block');
  const kinds = wrapper.statements.map((s) => s.kind);
  assert.deepEqual(kinds, ['class-declaration', 'block', 'assignment']);
  const assignment = wrapper.statements[2];
  assert.ok(assignment !== undefined && assignment.kind === 'assignment');
  assert.equal(assignment.target, 'C.b');
});

const LATE_SUPER = `class B {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
`;

test('pre-super parameter validation is accepted', () => {
  const source = `${LATE_SUPER}class D extends B {
    doubled = 0;
    constructor(n: number) {
      const m = n * 2;
      super(m);
      this.doubled = this.n * 2;
    }
  }
  `;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  const [, derived] = verifiedStatements(source).filter(
    (s): s is ClassDeclaration => s.kind === 'class-declaration',
  );
  assert.ok(derived?.ctor !== undefined);
  const kinds = hirNodes(derived.ctor.fn.body).map((n) => n.kind);
  // The field initializer runs after the super call, wherever the call stands.
  assert.ok(kinds.indexOf('super-call') < kinds.indexOf('field-assignment'));
});

test('a super call in if/else arms is accepted when no initializers need splicing', () => {
  // A class with no field initializers has nothing to splice after the call, so one super per
  // arm, every arm covered, is a fixed enough position (plan.md §8 step 12(d), plan-notes 277).
  const source = `${LATE_SUPER}class D extends B {
    constructor(n: number) {
      if (n > 0) {
        super(n);
      } else {
        super(0);
      }
    }
  }
  `;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  const [, derived] = verifiedStatements(source).filter(
    (s): s is ClassDeclaration => s.kind === 'class-declaration',
  );
  assert.ok(derived?.ctor !== undefined);
  const ifNode = derived.ctor.fn.body.statements.find((s) => s.kind === 'if-statement');
  assert.ok(ifNode !== undefined && ifNode.kind === 'if-statement', 'the branch survives');
  for (const arm of [ifNode.consequent, ifNode.alternate]) {
    assert.ok(arm !== undefined, 'both arms exist');
    const kinds = hirNodes(arm).map((n) => n.kind);
    assert.ok(kinds.includes('super-call'), 'each arm calls super');
    assert.ok(!kinds.includes('field-assignment'), 'nothing splices with no initializers');
  }
});

test('a super call in a branch stays not-yet when initializers need splicing', () => {
  // The same branch with a field initializer has no fixed splice position: the initializer
  // cannot follow the call into both arms (plan.md §8 step 12(d)).
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        doubled = 0;
        constructor(n: number) {
          if (n > 0) {
            super(n);
          } else {
            super(0);
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a second super call on a covered path stays not-yet', () => {
  // Re-running the base constructor is a ReferenceError in Node, not a second initialization.
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(n: number) {
          super(n);
          super(n);
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a super call nested in an arrow stays not-yet', () => {
  // Legal JavaScript with no fixed position for the initializers, so honestly deferred.
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(n: number) {
          super(n);
          const init = (): void => {
            super(n);
          };
          init();
        }
      }
      `,
      'js',
    ),
    ['STA1214'],
  );
});

test('a super call in switch clauses is accepted when no initializers need splicing', () => {
  // The `switch` twin of the arm rule (plan.md §8 step 12(d)): one call per path through
  // the clauses, a `default` covering the unmatched path, grouped cases sharing one body.
  const source = `${LATE_SUPER}class D extends B {
    constructor(x: number) {
      switch (x) {
        case 1:
          super(1);
          break;
        case 2:
        case 3:
          super(2);
          break;
        default:
          super(0);
      }
    }
  }
  `;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  const [, derived] = classesOf(source);
  assert.ok(derived?.ctor !== undefined);
  const switchNode = derived.ctor.fn.body.statements.find((s) => s.kind === 'switch-statement');
  assert.ok(
    switchNode !== undefined && switchNode.kind === 'switch-statement',
    'the switch survives',
  );
  const kinds = hirNodes(switchNode).map((n) => n.kind);
  assert.equal(kinds.filter((k) => k === 'super-call').length, 3, 'one call per clause body');
  assert.ok(!kinds.includes('field-assignment'), 'nothing splices with no initializers');
});

test('switch and if nest in both directions like the arm rule', () => {
  const source = `${LATE_SUPER}class D extends B {
    constructor(x: number) {
      if (x > 10) {
        switch (x) {
          case 11:
            super(11);
            break;
          default:
            super(12);
        }
      } else if (x > 0) {
        super(x);
      } else {
        super(0);
      }
    }
  }
  `;
  assert.deepEqual(gateCodes(source, 'ts'), []);
  const inCase = `${LATE_SUPER}class D extends B {
    constructor(x: number) {
      switch (x) {
        case 1:
          if (x > 0) {
            super(1);
          } else {
            super(2);
          }
          break;
        default:
          super(3);
      }
    }
  }
  `;
  assert.deepEqual(gateCodes(inCase, 'ts'), []);
});

test('a case that falls through into a later super call stays not-yet', () => {
  // The falling path re-runs the base constructor; Node answers ReferenceError
  // ("Super constructor may only be called once"), so a chain may call at most once.
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(x: number) {
          switch (x) {
            case 1:
              super(1);
            case 2:
              super(2);
              break;
            default:
              super(3);
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a switch without default leaves its unmatched path uncovered and stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(x: number) {
          switch (x) {
            case 1:
              super(1);
              break;
            case 2:
              super(2);
              break;
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
  // An EMPTY default is no cover either: its path completes with the base never run.
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(x: number) {
          switch (x) {
            case 1:
              super(1);
              break;
            default:
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a super call in a switch stays not-yet when initializers need splicing', () => {
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        doubled = 0;
        constructor(x: number) {
          switch (x) {
            case 1:
              super(1);
              break;
            default:
              super(0);
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a try-guarded super call stays not-yet', () => {
  // A `try` body can abort after the call and before it, so a catch that re-calls re-runs
  // the base on one path (Node: ReferenceError) and retries it on the other (legal) — no
  // one handler body is right for both, and abort points are every checked call (plan.md
  // §8 step 12(d)).
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(n: number) {
          try {
            super(n);
          } catch (e) {
            super(0);
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a return that completes a path before the call stays not-yet', () => {
  // A bare `return` completes the construction with `this` unbound — Node answers
  // ReferenceError where the compiled constructor would return an instance (plan.md §8
  // step 12(d)). The call after it cannot rescue the returning path, at any nesting.
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(n: number) {
          if (n > 0) {
            return;
          }
          super(n);
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(n: number) {
          while (n > 0) {
            return;
          }
          super(n);
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a return after the call is accepted; a value return stays not-yet', () => {
  // A bare return past the call retires its path with the base initialized. A VALUE return
  // cannot land at all: `new` yields the allocated object and ignores what a constructor
  // returns (codegen/), where Node substitutes the returned object (plan.md §8
  // step 12(d)). A nested arrow's return completes the arrow and is nobody else's.
  const bare = `${LATE_SUPER}class D extends B {
    constructor(n: number) {
      super(n);
      if (n > 0) {
        return;
      }
      this.n = 0;
    }
  }
  `;
  assert.deepEqual(gateCodes(bare, 'ts'), []);
  assert.deepEqual(
    gateCodes(
      `class C {
        constructor() {
          const o = { a: 1 };
          return o;
        }
      }
      export const x = 1;
      `,
      'ts',
    ),
    ['STA1214'],
  );
  assert.deepEqual(
    gateCodes(
      `class C {
        constructor() {
          const f = (): { a: number } => {
            return { a: 1 };
          };
          console.log(f().a);
        }
      }
      export const x = 1;
      `,
      'ts',
    ),
    [],
  );
});

test('super-carrying paths may not read the receiver before the call in switch shapes', () => {
  assert.deepEqual(
    gateCodes(
      `${LATE_SUPER}class D extends B {
        constructor(x: number) {
          switch (x) {
            case 1:
              console.log(this.n);
              super(1);
              break;
            default:
              super(0);
          }
        }
      }
      `,
      'ts',
    ),
    ['STA1214'],
  );
});

const SHADOW = `class B {
  x: number = 1;
  static n: number = 10;
  static m(): number {
    return 100;
  }
}
class D extends B {
  override x: number = 2;
  static override n: number = 20;
  static override m(): number {
    return 200;
  }
}
`;

test('same-kind shadowing is accepted in both modes', () => {
  assert.deepEqual(gateCodes(SHADOW, 'ts'), []);
  assert.deepEqual(gateCodes(SHADOW, 'js'), []);
});

test('a shadowed field shares the base slot; shadowing statics keep both bindings', () => {
  const [, derived] = verifiedStatements(SHADOW).filter(
    (s): s is ClassDeclaration => s.kind === 'class-declaration',
  );
  assert.ok(derived !== undefined);
  assert.deepEqual(
    derived.fields.map((f) => f.name),
    ['x'],
    'one slot, written by both initializers in initializer order',
  );
  assert.deepEqual(
    derived.statics.map((s) => s.name),
    ['D.n', 'D.m'],
    'the subclass keeps its own static bindings; the base keeps its',
  );
});

test('a method over a field stays not-yet', () => {
  // A slot and a method under one name: reads would take the method while writes take the
  // slot, which is not what either spelling means.
  assert.deepEqual(
    gateCodes(
      `class B {\n  x: number = 1;\n}\nclass D extends B {\n  override x(): number {\n    return 2;\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a field over a method stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `class B {\n  m(): number {\n    return 1;\n  }\n}\nclass D extends B {\n  override m: number = 2;\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

test('a mixed-kind static shadow stays not-yet', () => {
  assert.deepEqual(
    gateCodes(
      `class C {\n  static val: number = 0;\n}\nclass D extends C {\n  static get val(): number {\n    return 1;\n  }\n  static set val(v: number) {\n  }\n}\n`,
      'ts',
    ),
    ['STA1214'],
  );
});

const INDEX_SIG = `class C {
  [k: string]: number;
  x: number = 1;
}
`;

test('an index signature adds no slot and refuses nothing declared', () => {
  const decl = classOf(INDEX_SIG);
  assert.deepEqual(
    decl.fields.map((f) => f.name),
    ['x'],
    'the signature contributes no layout of its own',
  );
  assert.deepEqual(gateCodes(INDEX_SIG, 'ts'), []);
  assert.deepEqual(gateCodes(INDEX_SIG, 'js'), []);
});

test('a dynamic key through an index signature stays not-yet', () => {
  // Every spelling funnels through the member access the gate vets: reads, writes, and element
  // access all name Phase 8's dictionary mode, while calls and compounds are checker errors.
  assert.deepEqual(gateCodes(`${INDEX_SIG}const c = new C();\nexport const y = c.dyn;\n`, 'ts'), [
    'STA1214',
  ]);
  assert.deepEqual(gateCodes(`${INDEX_SIG}const c = new C();\nc.dyn = 1;\n`, 'ts'), ['STA1214']);
  assert.deepEqual(
    gateCodes(`${INDEX_SIG}const c = new C();\nexport const y = c["dyn"];\n`, 'ts'),
    ['STA1214'],
  );
});

test('an undeclared member without an index signature is still the checkers business', () => {
  // No behavior change where no signature exists: the checker rejects first, and the gate's
  // accept set is untouched.
  assert.deepEqual(gateCodes(`class C {\n  x: number = 1;\n}\n`, 'ts'), []);
});

const ABSTRACT_ACCESSOR = `abstract class A {
  raw: number = 0;
  abstract get value(): number;
  abstract set value(v: number);
}
class B extends A {
  override get value(): number { return this.raw; }
  override set value(v: number) { this.raw = v; }
}
const a: A = new B();
a.value = 1;
export const y = a.value;
`;

test('an abstract accessor pair is accepted in both modes', () => {
  assert.deepEqual(gateCodes(ABSTRACT_ACCESSOR, 'ts'), []);
  assert.deepEqual(gateCodes(ABSTRACT_ACCESSOR, 'js'), []);
});

test('an abstract accessor lowers to a throw-stub per half, plan-notes 275 style', () => {
  // The stub gives the base class a complete table and a direct-call target; a virtual call
  // lands on the runtime class's entry, and every path that could reach the stub is
  // checker-refused first (TS2511 construction, TS2515 missing override, TS2513 super).
  const [base, derived] = classesOf(ABSTRACT_ACCESSOR);
  assert.ok(base !== undefined && derived !== undefined);
  assert.deepEqual(
    base.methods.map((m) => m.name),
    ['get value', 'set value'],
    'the abstract pair is two member functions under the mangled half names',
  );
  for (const half of base.methods) {
    const kinds = hirNodes(half.fn.body).map((n) => n.kind);
    assert.ok(kinds.includes('throw-statement'), 'the stub body throws');
    assert.ok(kinds.includes('error-new'), 'Node answers a catchable TypeError');
  }
  assert.deepEqual(
    derived.methods.map((m) => m.name),
    ['get value', 'set value'],
    'the implementing subclass emits the same pair under its own entry',
  );
});

test('an accessor override keeps the pair whole: get-only, set-only, and pair shapes', () => {
  const getOnly = `abstract class A {\n  abstract get x(): string;\n}\nclass B extends A {\n  get x(): string {\n    return 'b';\n  }\n}\nexport const y = new B().x;\n`;
  const setOnly = `abstract class A {\n  abstract set x(v: number);\n}\nclass B extends A {\n  n: number = 0;\n  set x(v: number) {\n    this.n = v;\n  }\n}\nconst b = new B();\nb.x = 1;\nexport const y = b.n;\n`;
  for (const source of [getOnly, setOnly]) {
    assert.deepEqual(gateCodes(source, 'ts'), []);
    assert.deepEqual(gateCodes(source, 'js'), []);
  }
});

test('a dropped or added accessor half over an inherited pair stays not-yet', () => {
  // The derived accessor SHADOWS the inherited pair in Node: a write to a get-only shadow
  // throws (compiled modules are strict) and a read of a set-only one answers `undefined`,
  // where the table would dispatch the missing half to the base's body. An added half has no
  // slot in the base's layout for a base-typed site to index.
  const dropped = `class A {\n  get x(): number { return 1; }\n  set x(v: number) {}\n}\nclass B extends A {\n  override get x(): number { return 2; }\n}\nexport const y = new B().x;\n`;
  const added = `class A {\n  get x(): number { return 1; }\n}\nclass B extends A {\n  override get x(): number { return 2; }\n  set x(v: number) {}\n}\nexport const y = new B().x;\n`;
  assert.deepEqual(gateCodes(dropped, 'ts'), ['STA1214']);
  assert.deepEqual(gateCodes(added, 'ts'), ['STA1214']);
});

test('a partial implementation of an abstract pair stays not-yet', () => {
  // Checker-clean (TS reads the pair as one abstract member) and refused on the pair rule:
  // the missing half's entry cannot answer what Node's shadowing accessor does.
  const partial = `abstract class A {\n  abstract get x(): number;\n  abstract set x(v: number);\n}\nclass B extends A {\n  override get x(): number { return 2; }\n}\nexport const y = new B().x;\n`;
  assert.deepEqual(gateCodes(partial, 'ts'), ['STA1214']);
});

test('an accessor with no body and no abstract stays not-yet', () => {
  assert.deepEqual(
    gateCodes(`declare class C {\n  get x(): number;\n}\nexport const y = 1;\n`, 'ts'),
    ['STA1214'],
  );
});
