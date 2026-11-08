// String building and reads of its length.
function main() {
  let s = '';
  let total = 0;
  for (let i = 0; i < 1000000; i++) {
    s += String.fromCharCode(97 + (i % 26));
    total += s.length % 7;
  }
  console.log(s.length, total);
}
main();
