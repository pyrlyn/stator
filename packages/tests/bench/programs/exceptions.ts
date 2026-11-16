// Throw and catch across frames: the unwind cost, error construction, and a finally block on
// every exit path. One iteration in four throws, so the non-throwing path is measured too, and
// both a user class and a built-in Error are thrown so neither catch path is skipped.
class ParseFailure {
  readonly at: number;
  constructor(at: number) {
    this.at = at;
  }
}

function parse(value: number, depth: number): number {
  if (depth > 0) return parse(value, depth - 1) + 1;
  if (value % 8 === 0) throw new ParseFailure(value);
  if (value % 8 === 4) throw new Error(`bad input at ${String(value)}`);
  return value;
}

let total: number = 0;
let finals: number = 0;
for (let i = 0; i < 100_000; i += 1) {
  try {
    total += parse(i, 5);
  } catch (error) {
    if (error instanceof ParseFailure) total += error.at % 10;
    else if (error instanceof Error) total += error.message.length;
    else throw error;
  } finally {
    finals += 1;
  }
}
console.log(total, finals);
