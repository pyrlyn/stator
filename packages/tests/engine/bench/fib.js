// Recursive calls: the call path and integer-valued double arithmetic.
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
function main() {
  console.log(fib(32));
}
main();
