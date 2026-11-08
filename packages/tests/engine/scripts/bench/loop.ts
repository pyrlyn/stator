function run(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + i) % 100000;
  return s;
}
console.log(run(5000000));
