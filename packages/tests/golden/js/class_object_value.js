// T27 (js mode twin of golden/ts/class_object_value.ts): a class used as a value is its one
// class object (docs/VALUE.md §4.26): passed, stored, compared, printed, constructed and tested
// through, with statics read through whichever class the value holds. `C.prototype` stays
// not-yet and is not in this fixture.

class Shape {
  static count = 0;
  static label = 'shape';
  constructor(side) {
    this.side = side;
    Shape.count += 1;
  }
  static describe() {
    return `shapes: ${Shape.count}`;
  }
  static get twice() {
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

function build(k, side) {
  return new k(side);
}
function nameOf(k) {
  return k.name;
}
const all = [Shape, Square, Alias];
for (const k of all) {
  const made = build(k, 2);
  console.log(nameOf(k), made.side, made instanceof Square, made instanceof k);
}
console.log(Shape, Square);
console.log(Box);
console.log([Shape, Box]);
console.log({ k: Square });
console.log(Alias === Shape, Square === Shape, all.indexOf(Square));

let current = Shape;
current = Square;
console.log(current.name, typeof current, current.length);
function pick(flag) {
  return flag ? Square : Shape;
}
console.log(pick(true) === Square, pick(false).name);

function readCount(k) {
  return k.count;
}
function readLabel(k) {
  return k.label;
}
function callDescribe(k) {
  return k.describe();
}
function readTwice(k) {
  return k.twice;
}
console.log(readCount(Square), readLabel(Square), callDescribe(Square), readTwice(Shape));

const untyped = Square;
console.log(typeof untyped, untyped === Square);
