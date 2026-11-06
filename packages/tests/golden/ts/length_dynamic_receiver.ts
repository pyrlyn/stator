// `.length` on an array field read through a receiver the lowering reads dynamically: a class
// instance narrowed from `T | undefined`, one narrowed from `unknown` by `instanceof`, and a member
// of a union of object types. The read's static type is gone at that point, so the name resolves at
// run time instead of being guessed as a string's length.

class Box {
  items: string[];
  counts: number[];
  constructor(items: string[], counts: number[]) {
    this.items = items;
    this.counts = counts;
  }
}

const boxes: Box[] = [new Box(["a", "b"], [1, 2, 3])];
const first = boxes[0];
if (first !== undefined) {
  console.log(first.items.length);
  console.log(first.counts.length + 1);
  for (let i = 0; i < first.counts.length; i++) {
    console.log(first.counts[i]);
  }
}

function arity(value: unknown): number {
  if (!(value instanceof Box)) {
    return -1;
  }
  return value.items.length;
}
console.log(arity(new Box(["x"], [])));
console.log(arity(7));

type Shape = { kind: "list"; xs: number[] } | { kind: "text"; s: string };
function size(shape: Shape): number {
  return shape.kind === "list" ? shape.xs.length : shape.s.length;
}
console.log(size({ kind: "list", xs: [4, 5, 6, 7] }));
console.log(size({ kind: "text", s: "hello" }));
