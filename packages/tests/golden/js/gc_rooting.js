// Allocation pressure on two runtime paths that build a value while allocating (plan-notes 222).
// The collector runs on allocation volume, so the loop count is the pressure: with the half-built value
// held only in a C local -- invisible to the collector, because a NaN-boxed word is not a pointer
// by any conservative test -- a collection under pressure freed it and the next write went into
// reclaimed memory. The answers below are what Node prints; before the fix the first loop reported
// lengths in the tens of millions and the second lost whole iterations.

const re = /(a)/;
const subject = 'a';
let lengths = 0;
for (let i = 0; i < 200000; i++) {
  const m = subject.match(re);
  lengths += m.length;
}
console.log(lengths);

let total = 0;
for (let i = 0; i < 200000; i++) {
  const parsed = JSON.parse('[1,2,3]');
  total += (parsed + []).length;
}
console.log(total);

// The same operator path with objects on both sides, so both ToPrimitive calls allocate.
let joined = 0;
for (let i = 0; i < 100000; i++) {
  const pair = JSON.parse('[[1],[2]]');
  joined += (pair[0] + pair[1]).length;
}
console.log(joined);

// Relational compare, loose equality, sort and promise adoption each hold a boxed value across
// an allocating call (plan.md T18). The loop count is the pressure, as above.
class Label {
  constructor(n) {
    this.n = n;
  }
  valueOf() {
    return this;
  }
  toString() {
    return String(this.n);
  }
}

let less = 0;
for (let i = 0; i < 20000; i++) {
  if (new Label(i) < new Label(i + 1)) less++;
}
console.log(less);

const nums = [];
for (let i = 0; i < 500; i++) nums.push((i * 17) % 500);
nums.sort(); // NOSONAR javascript:S2871 -- the default string order is the path under test
console.log(nums[0], nums[nums.length - 1], nums.length);

let eq = 0;
for (let i = 0; i < 20000; i++) {
  const text = String(i % 50);
  if (new Label(i % 50) == text) eq++;
}
console.log(eq);

async function adopted() {
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const inner = Promise.resolve(i);
    const outer = new Promise((resolve) => {
      resolve(inner);
    });
    if (i % 250 === 249) sum += await outer;
  }
  console.log(sum);
}
adopted();
