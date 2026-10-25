// The anonymous `export default class {}` (plan.md §8 step 12(d)): Node's `.name` is
// `default`, the descriptor keys on `*default*`, and a default import constructs it
// like any other class.
export default class {
  n: number = 3;
  label: string = "anon";
  m(): number {
    return this.n * 2;
  }
  describe(): string {
    return `${this.label}:${String(this.m())}`;
  }
  relabel(next: string): void {
    this.label = next;
  }
}
