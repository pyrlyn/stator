function run(n) {
  let s = 0;
  const a = { x: 1, y: 2 };
  for (let i = 0; i < n; i++) {
    a.x += a.y;
    s += a.x;
  }
  return s;
}
console.log(run(2000000));
