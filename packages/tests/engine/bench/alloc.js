// Short-lived object literals: allocation, shape transitions and the collector.
function main() {
  let sum = 0;
  for (let i = 0; i < 5000000; i++) {
    const o = { a: i, b: i + 1, c: i + 2 };
    sum += o.a + o.b + o.c;
  }
  console.log(sum);
}
main();
