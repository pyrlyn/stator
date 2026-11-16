// What compiled code reads without a call -- a cached property, an array element, an array's
// length -- and each value that makes it ask the generic code instead, in loops whose numbers
// stay in registers and with values still waiting for the frame window when it does.
interface Point {
  x: number;
  y: number;
}
function total(ps: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i];
    sum += p.x + p.y;
  }
  return sum;
}
const points: Point[] = [];
for (let i = 0; i < 40; i += 1) points.push({ x: i, y: i * 0.5 });
console.log(total(points), total([]), total([{ x: -0, y: NaN }]));

// Another shape, a getter, an inherited member and a member that is missing.
class Polar {
  r: number;
  constructor(r: number) {
    this.r = r;
  }
  get x(): number {
    return this.r * 2;
  }
  get y(): number {
    return -this.r;
  }
}
let asked = 0;
const counting = {
  get x(): number {
    asked += 1;
    return asked;
  },
  y: 10,
};
const inherited: Point = Object.create({ x: 7, y: 8 });
const mixed: Point[] = [
  { x: 1, y: 2 },
  { y: 3, x: 4 },
  new Polar(5),
  counting,
  inherited,
  counting,
];
console.log(total(mixed), asked);
const lacking = [{ x: 1 }, { y: 2 }, {}] as Point[];
console.log(
  total(lacking),
  total([
    { x: 'a', y: 1 },
    { x: 2, y: 'b' },
  ] as unknown as Point[]),
);

// A getter that changes the array the loop is reading.
function shrinking(n: number): string {
  const xs: Point[] = [];
  for (let i = 0; i < n; i += 1) xs.push({ x: i, y: 1 });
  const trap = {
    get x(): number {
      xs.length = 3;
      xs.push({ x: 100, y: 100 });
      return 1000;
    },
    y: 0,
  };
  xs[2] = trap;
  return `${total(xs)},${xs.length}`;
}
console.log(shrinking(10), shrinking(3));

// Elements: numbers, holes, the end of the array, and indexes that are no element's.
function sumOf(xs: number[], from: number, to: number, step: number): number {
  let sum = 0;
  for (let i = from; i < to; i += step) sum += xs[i];
  return sum;
}
const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
console.log(sumOf(numbers, 0, 8, 1), sumOf(numbers, 1, 8, 2), sumOf(numbers, 0, 9, 1));
console.log(sumOf(numbers, -1, 3, 1), sumOf(numbers, 0, 3, 0.5), sumOf(numbers, 7, 8, 1));
const holes = [1, , 3, undefined, 5];
console.log(sumOf(holes as number[], 0, 5, 1), sumOf(holes as number[], 0, 1, 1));
function kinds(xs: unknown[]): string {
  let out = '';
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    out += x === undefined ? 'u' : typeof x === 'number' ? 'n' : 'o';
  }
  return out;
}
console.log(kinds(holes), kinds([, 1, , null, {}, ,]), String(holes[1]), holes[1] === undefined);
function at(xs: unknown, i: unknown): unknown {
  return (xs as unknown[])[i as number];
}
console.log(
  [
    at(numbers, 0),
    at(numbers, 7),
    at(numbers, 8),
    at(numbers, -1),
    at(numbers, 1.5),
    at(numbers, NaN),
    at(numbers, -0),
    at(numbers, 4294967296),
    at(numbers, 1e300),
    at(numbers, '2'),
    at(holes, 1),
    at('text', 1),
    at('text', 9),
    at({ 1: 'one' }, 1),
    at([[0.5, 1.5]], 0),
  ].join(),
);

// `length` is asked of arrays, strings and objects that have a member of that name.
function below(xs: { length: unknown }, n: number): number {
  let count = 0;
  for (let i = 0; i < xs.length; i += 1) count += n;
  return count;
}
console.log(
  below(numbers, 1),
  below('four', 2),
  below({ length: 3 }, 3),
  below({ length: '2' }, 1),
);
console.log(below({ length: NaN }, 1), below(new Array(5), 1), below([], 7));
function growing(n: number): number {
  const xs: number[] = [0];
  let seen = 0;
  for (let i = 0; i < xs.length; i += 1) {
    seen += xs[i];
    if (xs.length < n) xs.push(i + 1);
  }
  return seen;
}
console.log(growing(50), growing(1));

// What is still in registers when a read leaves for the generic code.
function waiting(ps: unknown[], k: number): string {
  let out = '';
  let acc = k;
  for (let i = 0; i < ps.length; i += 1) {
    const before = acc * 2 + i;
    const p = ps[i] as Point;
    acc = before - p.x + (i % 3) * p.y;
    out += `${before}:${acc};`;
  }
  return out;
}
console.log(waiting([{ x: 1, y: 2 }, { x: '3', y: 4 }, new Polar(2), { x: 5, y: 6 }, { y: 1 }], 3));
function pairSum(a: Point, b: Point): number {
  const left = { p: a.x + b.x, q: a.y };
  const right = { p: left.p * 2, q: b.y + left.q };
  return left.p + left.q + right.p + right.q + a.x * b.y;
}
console.log(pairSum({ x: 1, y: 2 }, { x: 3, y: 4 }), pairSum(new Polar(1), { x: 3, y: 4 }));
console.log(
  pairSum({ x: 1, y: 2 }, counting),
  pairSum({ x: 'a', y: 'b' } as unknown as Point, { x: 3, y: 4 }),
);

// Members whose names the objects' own shapes do not answer for.
function named(o: Record<string, unknown>): string {
  return `${typeof o.constructor},${String(o.length)},${String(o.x)}`;
}
console.log(named({ x: 1 }), named({ length: 2, x: [] }), named({ constructor: 1, length: 'n' }));
console.log(
  named([5] as unknown as Record<string, unknown>),
  named(named as unknown as Record<string, unknown>),
);
