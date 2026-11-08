let liveObjects = [];
function bench(seed: number): number {
  const retained = [];
  for (let i = 0; i < 1000; i += 1) retained.push({ x: i, y: seed });
  let sum = 0;
  for (let i = 0; i < retained.length; i += 1) {
    const value = retained[i];
    sum += value.x + value.y;
  }
  liveObjects = retained;
  return sum;
}
