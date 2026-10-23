// Default-export anonymous class, imported and `new`'d (plan.md §8 step 12(d)), js mode.
import Anon from "./shape.js";
import Named from "./named.js";

const a = new Anon();
const n = new Named();

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
