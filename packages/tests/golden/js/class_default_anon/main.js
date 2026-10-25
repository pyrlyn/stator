// Default-export anonymous class, imported and `new`'d (plan.md §8 step 12(d)), js mode.
// `Anon.name` is the T27 fold (docs/VALUE.md §4.26).
import Anon from "./shape.js";
import Named from "./named.js";

const a = new Anon();
const n = new Named();

console.log(Anon.name);
console.log(Named.name);
console.log(a.m());
console.log(a.describe());
a.relabel("custom");
console.log(a.describe());
console.log(a.n);
console.log(a);
console.log(n.who());
console.log(n);
console.log(a instanceof Anon);
console.log(n instanceof Named);
