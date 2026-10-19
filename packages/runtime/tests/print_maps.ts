// print_maps.ts — the ground truth for print_maps.c. Same collections, same order, console.log.
// If these two files drift apart the diff is meaningless, so edit them together.

class P {
  x: unknown;
  constructor(x: unknown) {
    this.x = x;
  }
}

console.log(new Map());
console.log(new Set());

{
  const m = new Map();
  m.set('a', 1);
  m.set('b', 2);
  console.log(m);
  console.log(m.has('a'));
  console.log(m.has('z'));
}

{
  const s = new Set();
  s.add(1);
  s.add(2);
  s.add(1);
  console.log(s);
}

{
  const m = new Map();
  m.set("it's", 'quoted');
  m.set(true, null);
  m.set(undefined, -0);
  m.set(Infinity, NaN);
  console.log(m);
}

{
  const m = new Map();
  m.set(NaN, 'first');
  m.set(-NaN, 'second');
  m.set(0, 'zero');
  m.set(-0, 'negative zero');
  console.log(m);
}

{
  const a = new P(1);
  const b = new P(1);
  const m = new Map();
  m.set(a, 'a');
  m.set(b, 'b');
  console.log(m);
  console.log(m.has(a));
  console.log(m.has(new P(1)));
}

{
  const m = new Map();
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  m.set('a', 9);
  console.log(m.delete('b'));
  console.log(m.delete('b'));
  m.set('d', 4);
  console.log(m);
  console.log(m.size);
  m.clear();
  console.log(m);
  m.set('e', 5);
  console.log(m);
}

{
  const inner = new Map();
  inner.set('k', 1);
  const outer = new Map();
  outer.set('m', inner);
  outer.set('p', new P(2));
  console.log(outer);

  console.log([inner, new Set()]);

  const d1 = new Map();
  d1.set(1, 1);
  const d2 = new Map();
  d2.set(2, d1);
  const d3 = new Map();
  d3.set(3, d2);
  const d4 = new Map();
  d4.set(4, d3);
  console.log(d4);
}

{
  const s = new Set();
  for (let i = 0; i < 8; i++) {
    s.add(i);
  }
  console.log(s);
}
{
  const m = new Map();
  m.set('averyveryverylongkeyname', 'a value long enough to matter');
  m.set('another', 'and another value');
  console.log(m);
}

{
  const m = new Map();
  for (let i = 0; i < 40; i++) {
    m.set(i, i * 2);
  }
  for (let i = 0; i < 40; i += 2) {
    m.delete(i);
  }
  for (let i = 40; i < 60; i++) {
    m.set(i, i * 2);
  }
  console.log(m.size);
  console.log(m.get(39));
  console.log(m.get(38));
  console.log(m);
}

{
  const s = new Set();
  for (let i = 0; i < 102; i++) {
    s.add(i);
  }
  console.log(s);
}
