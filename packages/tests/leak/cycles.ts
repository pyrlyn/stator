// Cycles the collector must reclaim (plan/T66). Reference counting alone never frees a cycle, and
// a cycle that dies young is freed without being counted at all, so each cycle here lives through
// collections first: a window of the last 4096 iterations keeps it, and the store that overwrites
// its slot drops it, leaving only trial deletion to find it dead. Each iteration builds a two-node
// ring, a ring through a closure and an array that holds itself. Kept, they are ~400 bytes an
// iteration, ~800 MB over two million.
class Ring {
  next: Ring | null = null;
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

interface Holder {
  f: () => number;
}

const size: number = 4096;
const rings: Ring[] = [];
const holders: Holder[] = [];
const selves: unknown[][] = [];
let sum: number = 0;
for (let i: number = 0; i < 2000000; i = i + 1) {
  const a: Ring = new Ring(i % 7);
  const b: Ring = new Ring(1);
  a.next = b;
  b.next = a;
  const holder: Holder = { f: (): number => 0 };
  holder.f = (): number => holder.f.length + a.value;
  const self: unknown[] = [i];
  self.push(self);
  if (i < size) {
    rings.push(a);
    holders.push(holder);
    selves.push(self);
  } else {
    rings[i % size] = a;
    holders[i % size] = holder;
    selves[i % size] = self;
  }
  sum = sum + holder.f() + b.value + self.length;
}
console.log(sum, rings.length, holders.length, selves.length);
