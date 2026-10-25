// plan.md §8 step 12(b)/(d): read-modify-write on an instance accessor, in both positions.
// Each form is one get and one set. Statement position discards the fold's answer; value
// position yields it (plan.md §8 step 12b). An untyped call-result receiver takes the
// dynamic path instead (docs/VALUE.md §4.24) and is not this fixture.

class C {
  constructor() {
    this.val = 0;
  }
  get value() {
    return this.val;
  }
  set value(v) {
    this.val = v;
  }
}

const c = new C();
c.value += 1;
c.value++;
++c.value;
c.value -= 2;
for (let i = 0; i < 2; i++) {
  c.value += 100;
}
console.log(c.value);
console.log(c.val);

// Value position: the fold's answer is the expression's value. `+=` and prefix `++`/`--`
// answer the new value; postfix answers the old one (ToNumber'd).
const a = new C();
const x = (a.value += 5);
const y = a.value++;
const z = ++a.value;
const w = a.value--;
const v = --a.value;
console.log(x, y, z, w, v);
console.log(a.value, a.val);

// A derived property (get/set over a different backing slot) takes the same path.
class Counter {
  #n = 0;
  get n() {
    return this.#n;
  }
  set n(v) {
    this.#n = v;
  }
  get double() {
    return this.#n * 2;
  }
  set double(v) {
    this.#n = v / 2;
  }
}
const k = new Counter();
console.log((k.n += 5));
console.log(k.double++);
console.log((k.double *= 3));
console.log(k.n, k.double);
