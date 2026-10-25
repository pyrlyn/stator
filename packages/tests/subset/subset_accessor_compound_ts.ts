// @mode: ts
// @verdict: static
// SUBSET.md: Classes with getters/setters
// `o.x += 1` is a get AND a set of one property. The member place machinery evaluates the
// receiver once into a temporary and threads it through both calls — statement position
// discards the fold's answer, value position yields it (plan.md §8 step 12b).

class C {
  val: number = 0;
  get value(): number {
    return this.val;
  }
  set value(v: number) {
    this.val = v;
  }
}
const c = new C();
c.value += 1;
c.value++;
export const s = c.value;
export const a = (c.value += 2);
export const b = c.value++;
export const d = ++c.value;
export const e = c.value--;
export const f = --c.value;
