// @mode: js
// @verdict: static
// SUBSET.md: `e satisfies T` erases to its operand

type Unit = 'ms' | 's';
const unit = 's' satisfies Unit;
const limits = { low: 1, high: 9 } satisfies Record<string, number>;
function pick(u: Unit): number {
  switch (u) {
    case 'ms':
      return 1;
    case 's':
      return 1000;
    default:
      u satisfies never;
      return 0;
  }
}
console.log(unit, limits.low + limits.high, pick(unit));
