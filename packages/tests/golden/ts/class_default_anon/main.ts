// Default-export anonymous class, imported and `new`'d (plan.md §8 step 12(d)).
// Node prints `default { … }` for the instance. `Anon.name` is the T27 fold: the anonymous
// default answers `default`, a named default answers its name (docs/VALUE.md §4.26).
// `console.log(C)` stays a class-as-value refusal (the opaque surface).
import Anon from "./shape.ts";
import Named from "./named.ts";

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
