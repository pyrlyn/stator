// plan-notes 319: whether a call passes a receiver is said by the call, never guessed from its
// argument count -- here through the dynamic paths: an object literal's method (`dyn-method-call`),
// a class in js mode, and method values handed to callbacks with more arguments than they declare.

const k = "dyn";
const o = {
  [k]: 1,
  tag: "o",
  m(a, b) {
    return `${this.tag} ${a} ${b}`;
  },
};
console.log(o.m("x"));
console.log(o.m("x", "y"));
console.log(o.m("x", "y", "z"));
console.log(o.m());

class Pair {
  constructor(tag, note) {
    this.tag = tag;
    console.log("ctor", tag, note);
  }
  join(a, b) {
    return `${this.tag}:${a}:${b}`;
  }
}
const p = new Pair("p");
console.log(p.join("x"), p.join("x", "y", "z"));

class Echo {
  show(a, b) {
    return `${typeof this} ${a} ${b}`;
  }
}
const show = new Echo().show;
console.log(["a", "b"].map(show).join(" | "));
console.log(show(1, 2), show(1, 2, 3));
console.log(["a"].map((v) => p.join(v)).join(""));
