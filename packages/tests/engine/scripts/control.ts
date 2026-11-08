// Loops, branches and recursion: the shapes the baseline JIT compiles first.
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
function sum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) continue;
    if (i > 900) break;
    s += i;
  }
  return s;
}
function collatz(n: number): number {
  let steps = 0;
  while (n !== 1) {
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
    steps++;
  }
  return steps;
}
function logic(a: unknown, b: unknown): unknown[] {
  return [a && b, a || b, a ?? b, !a, !!b];
}
console.log(fib(20), sum(1000), collatz(27));
console.log(logic(0, 'x').join('|'), logic('a', null).join('|'), logic(undefined, 5).join('|'));
let label = '';
for (let i = 0; i < 4; i++) {
  switch (i) {
    case 0:
      label += 'zero ';
      break;
    case 1:
    case 2:
      label += 'small ';
      break;
    default:
      label += 'big';
  }
}
console.log(label);
let k = 0;
do k += 3;
while (k < 10);
console.log(k);
