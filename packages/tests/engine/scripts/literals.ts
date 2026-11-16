// Object literals are allocated and filled in compiled code, from the collector's open run.
// What they hold must survive the collections their own allocation starts, which the
// collector's stress switches make of every one of them.
interface Link {
  value: number;
  next: Link | null;
}
let root: Link | null = null;
function cycles(n: number): string {
  let sum = 0;
  let head: Link | null = null;
  for (let i = 0; i < n; i += 1) {
    const a: Link = { value: i, next: null };
    const b: Link = { value: n, next: a };
    a.next = b;
    root = a;
    head = { value: i, next: head };
    sum += a.next.value + (b.next === null ? 0 : b.next.value) + head.value;
  }
  let length = 0;
  for (let p = head; p !== null; p = p.next) length += 1;
  return `${sum},${length},${root === null ? -1 : root.value}`;
}
console.log(cycles(300));
console.log(cycles(3));

interface Kept {
  first: Pair | null;
  second: Pair | null;
  count: number;
}
interface Pair {
  v: number;
  w: Pair | Kept | null;
}
function fill(n: number): number {
  const junk: { i: number; s: string }[] = [];
  for (let i = 0; i < n; i += 1) junk.push({ i, s: `k${i}` });
  return junk.length;
}
// A literal that outlives a collection is written afterwards with objects younger than it.
function survivors(n: number): string {
  const keep: Kept = { first: null, second: null, count: 0 };
  const a: Pair = { v: 1, w: null };
  keep.count = fill(n);
  const b: Pair = { v: 2, w: a };
  keep.first = b;
  a.w = keep;
  keep.count += fill(n);
  const c: Pair = { v: 3, w: keep.first };
  keep.second = c;
  keep.count += fill(n);
  return [keep.first.v, keep.second.v, keep.count, b.w === a, a.w === keep, c.w === b].join();
}
console.log(survivors(200));

// A member that leaves the compiled fast path between two it stored.
function mixed(n: number | string, s: number | string): string {
  const o: Record<string, number | string> = {
    a: n,
    b: `${s}${n}`,
    c: typeof n === 'number' ? n * 2 : 0,
  };
  o['d'] = s;
  return JSON.stringify(o) + Object.keys(o).join('');
}
console.log(mixed(1, 2) + mixed(1, 'x') + mixed('y', 2));

// Literals in a loop whose numbers stay in registers. The run the literals are taken from
// ends in the middle of the loop, and the loop is left with its numbers still in registers.
let left = 0;
function leaving(n: number, stop: number): number {
  let sum = 0;
  let i = 0;
  for (; i < n; i += 1) {
    const a: Link = { value: i, next: null };
    const b: Link = { value: sum % 11, next: a };
    a.next = b;
    root = a;
    sum += a.next.value + b.value + i;
    if (sum > stop) break;
  }
  left = i;
  return sum;
}
function last(): number {
  return root === null ? -1 : root.value;
}
console.log(leaving(60000, 1e12), left, last(), leaving(5000, 100000), left, last());
console.log(leaving(0, 0), left, last(), leaving(1, -1), left, last());

// Literals one after another share one move of the run's pointer, until something that may
// leave the fast path comes between two of them or they are too many.
interface Box {
  v: number;
  w: number;
}
function between(x: number | string, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const a: Box = { v: i, w: 1 };
    const y = (x as number) * 2;
    const b: Box = { v: y, w: a.v };
    const c: Box = { v: b.v + a.w, w: b.w };
    sum += c.v + c.w;
  }
  return sum;
}
console.log(between(3, 50), between('4', 50), between('x', 3), between(0.5, 20000));
interface Nest {
  k: number;
  inner: Nest | null;
}
function nested(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const a = { k: i };
    const b: Nest = { k: i + 1, inner: null };
    const c: Nest = { k: a.k + 2, inner: b };
    const d: Nest = { k: sum % 5, inner: c };
    const e: Nest = { k: 4, inner: d };
    let depth = 0;
    for (let p: Nest | null = e; p !== null; p = p.inner) depth += p.k;
    sum += depth + a.k;
  }
  return sum;
}
console.log(nested(40), nested(30000));

// A number read from a local reaches a float register from the local's own slot, while the
// slot still holds it.
function seeded(seed: number | string, n: number): number | string {
  let sum: number | string = 0;
  for (let i = 0; i < n; i += 1) {
    const o = { value: seed, next: null };
    sum = (sum as number) + (o.value as number) + i;
  }
  return sum;
}
console.log(seeded(2.5, 40), seeded('s', 3), seeded(-0, 1));
function rehomed(seed: number, n: number): number {
  let cur: number | Link = seed;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const t = cur;
    cur = { value: i, next: null };
    sum += (t as number) * 2 + cur.value;
    cur = sum - i;
  }
  return sum;
}
console.log(rehomed(1.5, 30), rehomed(0, 1));

// The block a literal is taken from is not empty: other objects lived there, and what they
// left is where the new one keeps the words nothing has written since.
interface Wide {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}
function wide(n: number): number {
  let kept: Wide | null = null;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    kept = { a: i + 0.5, b: -i, c: 1e300, d: -1e300, e: i * 3, f: 0.25, g: i, h: -0.5 };
    total += kept.a + kept.h;
  }
  return kept === null ? total : total + kept.g;
}
interface Open {
  p: number;
  q: number;
  r?: number;
  missing?: number;
}
function narrow(n: number): number {
  let out = 0;
  for (let i = 0; i < n; i += 1) {
    const o: Open = { p: i, q: 2 };
    o.r = 3;
    out += o.p + o.q + o.r + (o.missing === undefined ? 1 : 0);
  }
  return out;
}
console.log(wide(70000), narrow(70000), wide(0), narrow(1));
