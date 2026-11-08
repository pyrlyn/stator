// A numeric loop on doubles: no calls, no objects.
function main() {
  let s = 0;
  for (let i = 0; i < 30000000; i++) s += i * 0.5;
  console.log(s);
}
main();
