// plan.md §8 step 12(b)/(d): read-modify-write on an instance accessor, in both positions.
// Each form is one get and one set; a side-effecting receiver runs exactly once. Statement
// position discards the fold's answer; value position yields it (plan.md §8 step 12b).

class C {
  val: number = 0;
  get value(): number {
    return this.val;
  }
  set value(v: number) {
    this.val = v;
  }
}

let calls = 0;
function getC(c: C): C {
  calls += 1;
  return c;
}

const c = new C();
c.value += 1;
c.value++;
++c.value;
c.value -= 2;
getC(c).value += 10;
for (let i = 0; i < 2; i++) {
  c.value += 100;
}
console.log(c.value);
console.log(c.val);
console.log(calls);

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

// A side-effecting receiver runs exactly once in value position too.
const b = new C();
const once = (getC(b).value += 10);
console.log(once, b.value, calls);

// A derived property (get/set over a different backing slot) takes the same path.
class Counter {
  #n: number = 0;
  get n(): number {
    return this.#n;
  }
  set n(v: number) {
    this.#n = v;
  }
  get double(): number {
    return this.#n * 2;
  }
  set double(v: number) {
    this.#n = v / 2;
  }
}
const k = new Counter();
console.log((k.n += 5));
console.log(k.double++);
console.log((k.double *= 3));
console.log(k.n, k.double);
