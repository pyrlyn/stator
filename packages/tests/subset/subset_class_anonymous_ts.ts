// @mode: ts
// @verdict: static
// SUBSET.md: Classes -- the anonymous DECLARATION (`export default class { … }`) takes
// Node's `.name` (`default`); the descriptor keys on ES's `*default*` binding, which the
// default import aliases (plan.md §8 step 12(d)). Constructing, reading fields, calling
// methods and `instanceof` all work; the class object itself (`C.name`, `console.log(C)`)
// stays the class-as-value refusal.

export default class {
  m(): number {
    return 7;
  }
}
