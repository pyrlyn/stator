// The anonymous `export default class {}` (plan.md §8 step 12(d)), js mode.
export default class {
  constructor() {
    this.n = 3;
    this.label = "anon";
  }
  m() {
    return this.n * 2;
  }
  describe() {
    return `${this.label}:${String(this.m())}`;
  }
  relabel(next) {
    this.label = next;
  }
}
