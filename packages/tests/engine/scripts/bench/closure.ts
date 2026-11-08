function make() {
  let x = 0;
  return function () {
    return ++x;
  };
}
function run(n) {
  const f = make();
  let s = 0;
  for (let i = 0; i < n; i++) s += f();
  return s;
}
console.log(run(1000000));
