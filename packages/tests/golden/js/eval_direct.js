// A direct eval sees the bindings around it, writes through them, and makes closures that outlive
// the call (docs/INTERPRETER.md §3).
let counter = 10;

function outer(a) {
  let hidden = a + 1;
  function inner(b) {
    return eval('hidden * b + a');
  }
  const bump = eval('(function () { hidden += 10; return hidden; })');
  return [inner(2), bump(), bump(), hidden, inner(1)];
}
console.log(outer(1));

console.log(eval('counter += 1; counter'), counter);

const makers = [];
for (let i = 0; i < 3; i++) {
  makers.push(eval('() => i * 2'));
}
console.log(makers.map((m) => m()));

let total = 0;
for (const w of [1, 2, 3]) eval('total += w');
console.log(total);

const obj = {
  n: 5,
  get() {
    return eval('this.n + 1');
  },
};
console.log(obj.get());

class Box {
  constructor(v) {
    this.v = v;
  }
  read() {
    return eval('this.v');
  }
}
console.log(new Box('x').read());

const fixed = 1;
try {
  eval('fixed = 2');
} catch (e) {
  console.log(e.name, fixed);
}

console.log(eval('var scoped = 4; scoped * 2'), typeof scoped);
console.log(eval(42), eval());
