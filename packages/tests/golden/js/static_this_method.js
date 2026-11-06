// T27 step 4 (js mode twin of golden/ts/static_this_method.ts): `this` in a static method
// is the class the call went through. A class with a subclass passes it as the receiver
// (`T.m()` reads `T.v`); a class nothing extends erases `this` to its own statics, and a bare
// `this` there is its one class object.

class S {
  static v = 5;
  static m() {
    return this.v * 2;
  }
  static who() {
    return this.name;
  }
  static twice() {
    return this.m() + 1;
  }
  static make() {
    return new this();
  }
  static self() {
    return this;
  }
}
class T extends S {
  static v = 10;
  static viaSuper() {
    return super.m();
  }
}
console.log(`${S.m()} ${T.m()}`);
console.log(S.who(), T.who(), S.twice(), T.twice());
console.log(T.make() instanceof T, S.make() instanceof T);
console.log(T.self() === T, S.self() === S, T.viaSuper());
function call(k) {
  return k.m();
}
console.log(call(S), call(T));

class B {
  static id = 'B';
  static m() {
    return `B:${this.id}`;
  }
}
class D extends B {
  static id = 'D';
  static m() {
    return `D>${super.m()}`;
  }
}
console.log(B.m(), D.m());

class Solo {
  static n = 3;
  static bump() {
    this.n += 1;
    return this.n;
  }
  static me() {
    return this;
  }
}
console.log(Solo.bump(), Solo.bump(), Solo.me() === Solo, Solo.me().n);

// The receiver travels apart from the arguments, so a call that omits a parameter or leaves a
// default to fill still reads its own class as `this` (plan-notes 395).
class P {
  static base = 1;
  static add(n, m = 2) {
    return this.base + (n ?? 0) + m;
  }
}
class Q extends P {
  static base = 100;
}
console.log(P.add(), Q.add(), Q.add(5), Q.add(5, 7));
