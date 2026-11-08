// T34: `new` on a bound function constructs its target with the bound arguments first and
// ignores the bound receiver; `instanceof` sees through it to the target.
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.sum = function () {
  return this.x + this.y;
};
const AtOne = Point.bind({ ignored: true }, 1);
const p = new AtOne(2);
console.log(p.x, p.y, p.sum(), p instanceof Point, p instanceof AtOne);
console.log(p);
const Twice = AtOne.bind(null, 5);
const q = new Twice();
console.log(q.x, q.y, q instanceof Point, q instanceof Twice, Twice.name, Twice.length);
const arrow = () => 1;
try {
  new (arrow.bind(null))();
} catch (e) {
  console.log(e instanceof TypeError);
}
