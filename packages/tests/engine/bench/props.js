// Reads and writes of a few properties on one object in a hot loop: the inline caches.
function main() {
  const p = { x: 0, y: 0, vx: 1, vy: 2 };
  for (let i = 0; i < 10000000; i++) {
    p.x = p.x + p.vx;
    p.y = p.y + p.vy;
  }
  console.log(p.x + p.y);
}
main();
