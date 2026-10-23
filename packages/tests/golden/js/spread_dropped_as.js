// Dropped `as` unknown object spread takes the dynamic literal path (F3).
function spread(o) {
  return { ...(o), z: 3 };
}
const o = { x: 1, y: 2 };
console.log(spread(o));
console.log({ ...o, x: 9 });
