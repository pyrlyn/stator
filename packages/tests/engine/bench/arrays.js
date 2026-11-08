// Array growth by push and indexed reads.
function main() {
  const xs = [];
  for (let i = 0; i < 1000000; i++) xs.push(i);
  let s = 0;
  for (let k = 0; k < 10; k++) for (let i = 0; i < xs.length; i++) s += xs[i];
  console.log(s);
}
main();
