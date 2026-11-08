// T34, js mode: `bind` inserts a receiver into plain functions that read `this`, prototype
// methods and untyped receivers; a second bind cannot replace the first receiver.
function describe(prefix) {
  return prefix + this.name + "=" + this.value;
}
const a = { name: "a", value: 1 };
const b = { name: "b", value: 2 };
const ofA = describe.bind(a);
console.log(ofA("first "), ofA("second "));
const stuck = ofA.bind(b);
console.log(stuck("still "));

function Store(items) {
  this.items = items;
}
Store.prototype.add = function (x) {
  this.items.push(x);
  return this.items.length;
};
const store = new Store([]);
const add = store.add.bind(store);
console.log(add("x"), add("y"), store.items.join("+"));
const other = new Store(["z"]);
console.log(store.add.bind(other)("w"), other.items.join("+"), store.items.length);

const callbacks = [1, 2, 3].map(describe.bind({ name: "n", value: 0 }));
console.log(callbacks.join(" | "));
console.log(typeof ofA, ofA.name, ofA.length);
