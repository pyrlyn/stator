// Closure allocation and indirect calls: every adder captures a fresh cell, compose builds a
// chain of closures over closures, and the counter mutates its captured binding.
function adder(step: number): (value: number) => number {
  return (value) => value + step;
}

function compose(
  f: (value: number) => number,
  g: (value: number) => number,
): (value: number) => number {
  return (value) => g(f(value));
}

function counter(): () => number {
  let count = 0;
  return () => {
    count += 1;
    return count;
  };
}

let total: number = 0;
const tick = counter();
for (let i = 0; i < 300_000; i += 1) {
  const chain = compose(adder(i % 10), compose(adder(1), adder(2)));
  total = (total + chain(i) + tick()) % 1_000_000_007;
}
console.log(total);
