// Property and element access, constructors and classes.
interface Point {
  x: number;
  y: number;
}
function len(p: Point): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}
console.log(len({ x: 3, y: 4 }));
const o: Record<string, number> = { a: 1 };
o['b'] = 2;
o.c = o.a + o.b;
console.log(Object.keys(o).join(), JSON.stringify(o));
const arr: number[] = [];
for (let i = 0; i < 5; i++) arr[i] = i * i;
console.log(arr.length, arr.join(' '), arr[10]);
class Vec {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  add(o: Vec): Vec {
    return new Vec(this.x + o.x, this.y + o.y);
  }
  toString(): string {
    return `(${this.x}, ${this.y})`;
  }
}
class Vec3 extends Vec {
  z: number;
  constructor(x: number, y: number, z: number) {
    super(x, y);
    this.z = z;
  }
  override toString(): string {
    return `${super.toString()}+${this.z}`;
  }
}
console.log(String(new Vec(1, 2).add(new Vec(3, 4))), String(new Vec3(1, 2, 3)));
function Old(this: { v: number }, v: number): void {
  this.v = v;
}
console.log(typeof Old, [1, 2, 3].map((x) => x * 2).join());
const { a, ...others } = { a: 1, b: 2, c: 3 };
console.log(a, JSON.stringify(others));
