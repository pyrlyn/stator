function run(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += 'abcdefgh';
  return s.length;
}
console.log(run(100000));
