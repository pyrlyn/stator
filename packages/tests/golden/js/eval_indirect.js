// `eval` and `Function` as values run in the interpreter's global scope, never the caller's.
const local = 'compiled';
const e = eval;
console.log(e('typeof local'), (0, eval)('1 + 2'), globalThis.eval('"g"'));
console.log(typeof eval, typeof Function, eval === globalThis.eval);

const square = new Function('x', 'return x * x');
const sum = Function('a', 'b', 'c', 'return a + b + c');
console.log(square(7), sum(1, 2, 3), square.length, sum.length);

const counter = new Function('let n = 0; return () => ++n;')();
console.log(counter(), counter(), counter());

try {
  eval('syntax error here');
} catch (err) {
  console.log(err.name);
}
try {
  new Function('throw new TypeError("boom")')();
} catch (err) {
  console.log(err.name, err.message);
}
