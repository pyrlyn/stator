// @mode: js
// @verdict: static
// SUBSET.md: Object literals with static keys
// Spreading a class instance copies its fields only: methods and accessors live on the
// prototype and `#private` fields are not own properties, so none of them is spread
// (plan.md §8 step 12c residue; js twin of subset_spread_class_ts.ts).

class Point {
  #tag = 'p';
  x = 1;
  y = 2;
  get sum() {
    return this.x + this.y;
  }
  label() {
    return this.#tag;
  }
}
const pt = new Point();
export const spread = { ...pt, z: 3 };
export const label = pt.label();
export const sum = pt.sum;
