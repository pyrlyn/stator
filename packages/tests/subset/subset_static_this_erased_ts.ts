// @mode: ts
// @verdict: static
// SUBSET.md: Static methods and static class members
// `this` in a static method of a class nothing extends is always that class (plan.md T27
// step 4), so `this.n` erases to the static binding and a bare `this` is its class object.

class Counter {
  static n = 0;
  static bump(): number {
    this.n += 1;
    return this.n;
  }
  static self(): typeof Counter {
    return this;
  }
}
console.log(Counter.bump(), Counter.self() === Counter);
