// Method calls on class instances: `this`, property reads and calls together.
class Vec {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  dot(o) {
    return this.x * o.x + this.y * o.y;
  }
}
function main() {
  const a = new Vec(1, 2);
  const b = new Vec(3, 4);
  let s = 0;
  for (let i = 0; i < 5000000; i++) s += a.dot(b);
  console.log(s);
}
main();
