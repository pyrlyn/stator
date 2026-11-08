// Captured bindings live in environments the JIT reads through its helpers.
function counter(): () => number {
  let n = 0;
  return () => ++n;
}
const c = counter();
c();
c();
console.log(c());
const fns: (() => number)[] = [];
for (let i = 0; i < 3; i++) fns.push(() => i * 10);
console.log(fns.map((f) => f()).join(','));
function adder(a: number): (b: number) => number {
  return function (b: number): number {
    return a + b;
  };
}
console.log(adder(2)(40));
function rest(first: number, ...more: number[]): string {
  return `${first}:${more.length}:${more.join('+')}`;
}
console.log(rest(1), rest(1, 2, 3));
function defaults(a: number, b: number = a * 2): number {
  return a + b;
}
console.log(defaults(1), defaults(1, 1));
const compose =
  (f: (x: number) => number, g: (x: number) => number) =>
  (x: number): number =>
    f(g(x));
console.log(
  compose(
    (x) => x + 1,
    (x) => x * 3,
  )(5),
);
