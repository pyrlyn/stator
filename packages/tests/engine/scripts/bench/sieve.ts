function run(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(true);
  let count = 0;
  for (let i = 2; i < n; i++)
    if (a[i]) {
      count++;
      for (let j = i + i; j < n; j += i) a[j] = false;
    }
  return count;
}
console.log(run(200000));
