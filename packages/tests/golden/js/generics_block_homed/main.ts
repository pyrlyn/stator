// T28: a generic arrow homed in a block `const` or a single-assignment `let` specializes under a
// position key (docs/HIR.md §7), so two homes with the same name never share a specialization.
function runNum(f: (x: number) => number, v: number): number {
  return f(v);
}
function runStr(f: (x: string) => string, v: string): string {
  return f(v);
}
function first(): number {
  const g = <T,>(x: T): T => x;
  return runNum(g, 1);
}
function second(): string {
  const g = <T,>(x: T): T => x;
  return runStr(g, "two");
}
function both(): string {
  const pair = <T,>(x: T): T[] => [x, x];
  const ns = pair(3);
  const ss = pair("s");
  return `${ns.length}:${ns[0]}/${ss.length}:${ss[1]}`;
}
let id = <T,>(x: T): T => x;
console.log(first());
console.log(second());
console.log(both());
console.log(id(4), id("four"), runNum(id, 5));
if (first() > 0) {
  const inner = <T,>(x: T): string => `[${String(x)}]`;
  console.log(inner(6), inner(true));
}
