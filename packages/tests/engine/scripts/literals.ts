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
