// T27: a class used as a value is its one class object (docs/VALUE.md §4.26): passed,
// stored, compared, printed, constructed and tested through, with statics read through
// whichever class the value holds. `C.prototype` stays not-yet and is not in this fixture.

class Shape {
  static count = 0;
  static label = 'shape';
  side: number;
  constructor(side: number) {
    this.side = side;
    Shape.count += 1;
  }
  static describe(): string {
    return `shapes: ${Shape.count}`;
  }
  static get twice(): number {
    return Shape.count * 2;
  }
}
class Square extends Shape {
  static corners = 4;
}
const Box = class {
  static size = 3;
};
const Alias = Shape;

function build(k: typeof Shape, side: number): Shape {
  return new k(side);
}
function nameOf(k: typeof Shape): string {
  return k.name;
}
const all: (typeof Shape)[] = [Shape, Square, Alias];
for (const k of all) {
  const made = build(k, 2);
  console.log(nameOf(k), made.side, made instanceof Square, made instanceof k);
}
console.log(Shape, Square);
console.log(Box);
console.log([Shape, Box]);
console.log({ k: Square });
console.log(Alias === Shape, Square === (Shape as unknown), all.indexOf(Square));

let current: typeof Shape = Shape;
current = Square;
console.log(current.name, typeof current, current.length);
function pick(flag: boolean): typeof Shape {
  return flag ? Square : Shape;
}
console.log(pick(true) === Square, pick(false).name);

function readCount(k: typeof Shape): number {
  return k.count;
}
function readLabel(k: typeof Shape): string {
  return k.label;
}
function callDescribe(k: typeof Shape): string {
  return k.describe();
}
function readTwice(k: typeof Shape): number {
  return k.twice;
}
console.log(readCount(Square), readLabel(Square), callDescribe(Square), readTwice(Shape));

const untyped: unknown = Square;
console.log(typeof untyped, untyped === Square);
