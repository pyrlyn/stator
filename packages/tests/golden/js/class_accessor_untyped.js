// Class accessors through an untyped receiver (docs/SUBSET.md, "Classes with getters/setters"):
// `let k; k = new K()` leaves `k` without a layout, so `k.x` and `k.x = v` are the dynamic read
// and write, and they must run the class's `get x` / `set x` exactly as a typed site calls them.

class K {
  constructor() {
    this.v = 1;
  }
  get me() {
    return this;
  }
  get val() {
    return this.v;
  }
  set val(x) {
    this.v = x * 10;
  }
  get only() {
    return "ro";
  }
  method() {
    return "m";
  }
}

class S extends K {
  get extra() {
    return this.v + 1;
  }
}

let k;
k = new K();
console.log(k.me === k, k.val, k.only, k.method());
k.val = 2;
console.log(k.val, k.v);

// A getter with no setter refuses the write in strict code, as a compiled module is.
function strictWrite(o) {
  "use strict";
  o.only = 5;
}
try {
  strictWrite(k);
} catch (e) {
  console.log(e.name, e.message);
}

// Inherited halves, and a getter that runs once per read.
let s;
s = new S();
s.val = 3;
console.log(s.val, s.extra, s.me === s);
let reads = 0;
class C {
  constructor() {
    this.tag = "c";
  }
  get count() {
    reads++;
    return reads;
  }
}
let c;
c = new C();
console.log(c.count, c.count, c.tag);
