// Programs written to reach a pass rule the corpus does not. Breaking these rules on purpose went
// unnoticed until they existed. They are text rather than fixture files because a program that
// exists to hold dead code is one the lint and the type-checker rightly refuse; the harness writes
// them out and compiles them like any other fixture.
export const RULE_PROGRAMS: Readonly<Record<string, string>> = {
  // A name the inlined body rebinds is not the parameter, however it is spelled.
  'inline_rebinds.ts': `function shadowsInClosure(a: number): (a: number) => number {
  return (a: number): number => a + 1;
}
function shadowsInBody(a: number): () => number {
  return (): number => {
    const a = 7;
    return a;
  };
}
console.log(shadowsInClosure(1)(2));
console.log(shadowsInBody(1)());
`,
  // What an elimination may and may not delete, with the literal conditions the passes themselves produce.
  'dce_control.ts': `function hoisted(): number {
  return below();
  function below(): number {
    return 1;
  }
}
function skipsLet(): number {
  return 2;
  const never = 3;
  console.log(never);
}
function jumpsOut(): number {
  let count = 0;
  for (let i = 0; i < 3; i++) {
    do {
      count++;
      if (i === 1) break;
      count += 10;
    } while (false);
  }
  return count;
}
function plain(): number {
  let total = 0;
  do {
    total += 1;
  } while (false);
  return total;
}
function nothing(): null {
  return null;
}
function absent(): undefined {
  return undefined;
}
function empty(): string {
  return '';
}
function text(): string {
  return 'x';
}
if (nothing()) console.log('null');
if (absent()) console.log('undefined');
if (empty()) console.log('empty');
if (text()) console.log('text');
if (1 - 1) console.log('zero');
if (0 / 0) console.log('nan');
if (2 - 1) console.log('one');
while (1 - 1) console.log('never');
console.log(hoisted(), skipsLet(), jumpsOut(), plain());
`,
  // Every position a walk has to reach, each holding something a pass acts on. A slot the rewriter
  // skips is not an error anywhere: it is an expression left unoptimized.
  'walk_positions.ts': `function one(): number {
  return 1;
}
class Holder {
  static fixed: number = one() + 1;
  value: number = one() + 2;
  constructor() {
    this.value += one();
  }
  read(): number {
    return this.value + one();
  }
}
const shape = {
  method(): number {
    return one() + 3;
  },
};
function guarded(): number {
  try {
    return one();
  } catch {
    return one() + 4;
  } finally {
    console.log(one() + 5);
  }
}
function defaulted(x: number = one() + 6): number {
  return x * x;
}
for (let i = 0; i < 3; i += one()) console.log(i);
console.log(Holder.fixed, new Holder().read(), shape.method(), guarded(), defaulted());
`,
  // What keeps a function alive: a default parameter, a chain, and not a cycle of its own.
  'dce_shake.ts': `function viaDefault(): number {
  const five = 5;
  return five;
}
function hasDefault(x: number = viaDefault()): number {
  return x;
}
function chainA(): number {
  return chainB();
}
function chainB(): number {
  return 1;
}
function deadA(): number {
  return deadB();
}
function deadB(): number {
  return deadA();
}
console.log(hasDefault(), chainA());
`,
};
