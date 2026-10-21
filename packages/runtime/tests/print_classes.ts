// The Node half of print_classes.c — the same classes, printed in the same order.
class S { static v = 5; }
class T extends S { static v = 10; }
class U extends T {}
class E {}
class F extends E {
  static a = 1;
  static b = 'x';
  static c = [1, 2];
  static get g() { return 1; }
  static h() {}
}
class Long {
  static aaaaaaaaaaaaaaaa = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  static bbbbbbbbbbbbbbbbbbbb = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  static cccc = 3;
}
class Wide {
  static alpha = 'aaaaaaaaaaaaaaaaaaaa';
  static beta = 'bbbbbbbbbbbbbbbb';
}
class Narrow {
  static alpha = 'aaaaaaaaaaaaaaaaaaaa';
  static beta = 'bbbbbbbbbbbbbbbb';
}
class H { constructor(k) { this.k = k; } }

console.log(S);
console.log(T);
console.log(U);
console.log(E);
console.log(F);
console.log(Long);
console.log(Wide);
console.log(Narrow);
console.log([S, T]);
console.log([E]);
console.log(new H(S));
console.log(new H(new H(new H(S))));
console.log(new H(new H(new H(E))));
console.log(typeof S);
console.log(S === S);
try { T(); } catch (e) { console.log(e.message); }
S.v = 6;
console.log(S);
