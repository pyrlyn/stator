// The Node half of print_shapes.c — the same objects, in the same order.
const empty = {};
console.log(empty);

const box = {};
box.a = 1;
box.b = "two";
box.c = true;
box.d = null;
box.e = 2.5;
const inner = {};
inner.deep = "in";
box.f = inner;
console.log(box);

box.b = 22;
console.log(box);

console.log(box.nope);
console.log(box.a);

const first = {};
first.x = 10;
first.y = 20;
const second = {};
second.x = 30;
second.y = 40;
console.log(first.x);
console.log(second.x);
second.z = 50;
console.log(second.x);
console.log(second);

const other = {};
other.y = 9;
other.x = 8;
console.log(other);

const quoted = {};
quoted["a-b"] = 1;
quoted.ok = 2;
quoted["1x"] = 3;
console.log(quoted);
