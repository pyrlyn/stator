// T28, js mode: block-homed generics in a .ts file mixed with an untyped .js module. Each home
// keys on its position (docs/HIR.md §7); an untyped argument reaches it as Unknown.
import { sample, twice } from "./lib.js";

function wrapAll(): string {
  const wrap = <T,>(x: T): T[] => [x];
  const s = sample();
  return `${wrap(s.count).length} ${wrap(s.label)[0]} ${wrap(s.flags).length}`;
}
function keepAll(): string {
  const wrap = <T,>(x: T): string => `<${String(x)}>`;
  return [wrap(1), wrap("a"), wrap(null)].join(",");
}
let echo = <T,>(x: T): T => x;
console.log(wrapAll());
console.log(keepAll());
console.log(twice(echo, 8), echo(sample().label));
for (const n of [1, 2]) {
  const tag = <T,>(x: T): string => `#${String(x)}`;
  console.log(tag(n * 10), tag("x"));
}
