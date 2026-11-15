// The microtask queue: each await suspends and resumes a frame, and Promise.all fans out and
// joins. A slow job queue or a leaking continuation shows as time and RSS here.
async function step(value: number): Promise<number> {
  await Promise.resolve(0);
  return value + 1;
}

async function chain(start: number, length: number): Promise<number> {
  let value = start;
  for (let i = 0; i < length; i += 1) value = await step(value);
  return value;
}

async function main(): Promise<void> {
  let total = 0;
  // 200 rounds pass today and 300 already panic in the collector (plan/T76), which raises
  // this to 600 when it lands.
  for (let round = 0; round < 200; round += 1) {
    const results = await Promise.all([chain(round, 100), chain(round * 2, 100), chain(1, 100)]);
    for (const result of results) total += result;
  }
  console.log(total);
}

void main();
