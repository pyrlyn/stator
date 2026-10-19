// The Node half of print_accessors.c — the same objects, in the same order.
const obj = {
  val: 21,
  get double(): number {
    return this.val * 2;
  },
  set double(v: number) {
    this.val = v / 2;
  },
};
console.log(obj.double);
console.log(obj);
obj.double = 100;
console.log(obj.val);
console.log(obj.double);
console.log(Object.keys(obj));
console.log(Object.values(obj));
console.log(Object.entries(obj));

const halves = {
  get g(): number {
    return (this as unknown as { val: number }).val * 2;
  },
  set s(v: number) {
    (this as unknown as { val: number }).val = v / 2;
  },
};
(halves as unknown as { val: number }).val = 3;
console.log(halves);
console.log((halves as unknown as { s?: undefined }).s);

const pair: { readonly x: number }[] = [];
for (let i = 0; i < 2; i++) {
  const captured = i + 7;
  pair.push({
    get x(): number {
      return captured;
    },
  });
}
console.log((pair[0] as { readonly x: number }).x);
console.log((pair[1] as { readonly x: number }).x);

Object.defineProperty(obj, 'bad', {
  enumerable: true,
  get() {
    throw new TypeError('access failed');
  },
});
const operations: readonly ((o: object) => unknown)[] = [
  Object.values,
  Object.entries,
  (o: object) => Object.assign(halves, o),
];
for (const operation of operations) {
  try {
    operation(obj);
  } catch (e) {
    console.log((e as Error).message);
  }
}
console.log((halves as unknown as { val: number }).val);
const reporters: readonly ((o: object) => unknown)[] = [
  JSON.stringify,
  console.table,
  (o: object) => console.table([o]),
];
for (const operation of reporters) {
  try {
    operation(obj);
  } catch (e) {
    console.log((e as Error).message);
  }
}
