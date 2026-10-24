// T27 narrow slice: `C.name` / `K.name` folds to Node's display name (docs/VALUE.md §4.26).
// A class alias (`const K = C`) and a chained alias read the same fold; a class expression
// answers its inner name, else the bound variable; a named default export answers its name
// (the anonymous default's `default` is `class_default_anon`). `C.prototype` stays not-yet
// (the Phase-8 prototype surface) and is not in this fixture. Statics through the alias are
// the existing binding erasure, beside the fold.

class Point {
  x: number = 1;
  static count: number = 0;
  constructor() {
    Point.count++;
  }
}

const K = Point;
console.log(K.name);
console.log(Point.name);
console.log(K.count);

const J = K;
console.log(J.name);

const Expr = class Inner {
  m(): number {
    return 1;
  }
};
console.log(Expr.name);

const Anon = class {
  n(): number {
    return 2;
  }
};
console.log(Anon.name);

class Dot extends Point {
  label: string = 'dot';
}
console.log(Dot.name);
const DK = Dot;
console.log(DK.name);

export default class Def {
  z: number = 2;
}
console.log(Def.name);
