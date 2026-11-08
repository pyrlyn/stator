function run(n) {
  const a = [];
  for (let i = 0; i < 10000; i++) a.push(i);
  let s = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}
console.log(run(200));
