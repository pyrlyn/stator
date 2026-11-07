// A method or constructor call with fewer or more arguments than parameters keeps `this` and every
// argument in place (plan-notes 395): the receiver must never be guessed from the argument count.

class Pair {
  constructor(left, right) {
    this.left = left;
    this.right = right;
  }

  sum(extra) {
    return this.left + this.right + (extra === undefined ? 0 : extra);
  }
}

class Shifted extends Pair {
  constructor(left) {
    super(left, 1, 2, 3);
  }
}

const short = new Pair(1);
console.log(short.left, short.right);
const long = new Pair(2, 3, 4, 5);
console.log(long.left, long.right, long.sum(), long.sum(10), long.sum(10, 20, 30));
const shifted = new Shifted(5);
console.log(shifted.left, shifted.right, shifted.sum(1, 2));

// An untyped receiver takes the dynamic call, which names its receiver the same way (plan-notes 399).
let loose;
loose = long;
console.log(loose.sum(), loose.sum(1), loose.sum(1, 2, 3));
