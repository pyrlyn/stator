// Default-export anonymous class, imported and `new`'d (plan.md §8 step 12(d)).
// Node prints `default { … }` for the instance; the class object itself stays a
// class-as-value refusal (`C.name`, `console.log(C)`).
import Anon from "./shape.ts";
import Named from "./named.ts";

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
