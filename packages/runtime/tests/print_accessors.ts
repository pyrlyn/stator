// The Node half of print_accessors.c — the same objects, in the same order.
const obj = { val: 21, get double() { return this.val * 2; }, set double(v) { this.val = v / 2; } };
console.log(obj.double);
console.log(obj);
obj.double = 100;
console.log(obj.val);
console.log(obj.double);
console.log(Object.keys(obj));
console.log(Object.values(obj));
console.log(Object.entries(obj));

const halves = { get g() { return this.val * 2; }, set s(v) { this.val = v / 2; } };
halves.val = 3;
console.log(halves);
console.log(halves.s);

const pair = [];
for (let i = 0; i < 2; i++) {
  const captured = i + 7;
  pair.push({ get x() { return captured; } });
}
console.log(pair[0].x);
console.log(pair[1].x);

Object.defineProperty(obj, 'bad', {
  enumerable: true,
  get() { throw new TypeError('access failed'); }
});
for (const operation of [Object.values, Object.entries, (o) => Object.assign(halves, o)]) {
  try { operation(obj); } catch (e) { console.log(e.message); }
}
console.log(halves.val);
for (const operation of [JSON.stringify, console.table, (o) => console.table([o])]) {
  try { operation(obj); } catch (e) { console.log(e.message); }
}
