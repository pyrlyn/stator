// A method value called bare takes no receiver, whatever the argument count: `this` is
// `undefined`, every argument keeps its position, and a rest parameter sees them all
// (plan-notes 395). A callback passing one argument more than `length` used to bind `this`
// to its first argument.
class Tags {
  tag(a: number, i: number): string {
    return `${String(a)}/${String(i)}`;
  }
  count(...xs: number[]): number {
    return xs.length;
  }
  first(a: number, ...rest: number[]): string {
    return `${String(a)}+${String(rest.length)}`;
  }
  isBare(): boolean {
    return this === undefined;
  }
}

const t = new Tags();
// The bare method value IS the case under test: `map` passes it three arguments, one more than
// its `length`.
console.log([7, 8].map(t.tag).join(',')); // NOSONAR typescript:S7727
const count = t.count;
console.log(count(1, 2, 3));
console.log(count());
const first = t.first;
console.log(first(1, 2, 3, 4));
const isBare = t.isBare;
console.log(isBare());
console.log(t.isBare());
console.log(t.count(1, 2, 3), t.first(9));
