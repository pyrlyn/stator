// plan.md §8 step 12(d): `this.x` in a static FIELD initializer or BLOCK is the class being
// defined (no class object needed) and erases to that class's static binding. `super.x` in a
// static block or method names a static of the base — lexically bound, so erasure is exact.
// `this.x` in a static METHOD stays refused: `this` there is whoever the method was reached
// through, and a subclass may have overridden the static. Bare `this`/`super` stay refused.

class B {
  static n = 1;
  static tag = "base";
  static m() {
    return 2;
  }
}

class D extends B {
  static tag = "derived";
  static self = this.tag + "!";
  static viaSuper() {
    return super.m() + 10;
  }
  static {
    console.log(super.tag);
    console.log(this.tag);
    console.log(super.m());
    console.log(this.n);
    console.log(this.self);
    console.log(this.viaSuper());
  }
}

console.log(D.self);
console.log(D.viaSuper());
console.log(D.tag);
console.log(D.n);
