// T27 step 4: `this` in a static method is the class the call went through. A class with a
// subclass passes it as the receiver (`T.m()` reads `T.v`); a class nothing extends erases
// `this` to its own statics, and a bare `this` there is its one class object.

class S {
  static v = 5;
  static m(): number {
    return this.v * 2;
  }
  static who(): string {
    return this.name;
  }
  static twice(): number {
    return this.m() + 1;
  }
  static make(): S {
    return new this();
  }
  static self(): typeof S {
    return this;
  }
}
class T extends S {
  static override v = 10;
  static viaSuper(): number {
    return super.m();
  }
}
console.log(`${S.m()} ${T.m()}`);
console.log(S.who(), T.who(), S.twice(), T.twice());
console.log(T.make() instanceof T, S.make() instanceof T);
console.log(T.self() === T, S.self() === S, T.viaSuper());
function call(k: typeof S): number {
  return k.m();
}
console.log(call(S), call(T));

class B {
  static id = 'B';
  static m(): string {
    return `B:${this.id}`;
  }
}
class D extends B {
  static override id = 'D';
  static override m(): string {
    return `D>${super.m()}`;
  }
}
console.log(B.m(), D.m());

class Solo {
  static n = 3;
  static bump(): number {
    this.n += 1;
    return this.n;
  }
  static me(): typeof Solo {
    return this;
  }
}
console.log(Solo.bump(), Solo.bump(), Solo.me() === Solo, Solo.me().n);

// The receiver travels apart from the arguments, so a call that omits an optional parameter or
// leaves a default to fill still reads its own class as `this` (plan-notes 395).
class P {
  static base = 1;
  static add(n?: number, m = 2): number {
    return this.base + (n ?? 0) + m;
  }
}
class Q extends P {
  static override base = 100;
}
console.log(P.add(), Q.add(), Q.add(5), Q.add(5, 7));
