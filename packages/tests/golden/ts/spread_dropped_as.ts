function spread(o: object): object {
  return { ...(o as { x: number }), z: 3 };
}
const o = { x: 1, y: 2 };
console.log(spread(o));
console.log({ ...o, x: 9 });
