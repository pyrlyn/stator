// Calls through closures that read and write a captured variable.
function counter() {
  let n = 0;
  return function (by) {
    n += by;
    return n;
  };
}
function main() {
  const inc = counter();
  let last = 0;
  for (let i = 0; i < 5000000; i++) last = inc(1);
  console.log(last);
}
main();
