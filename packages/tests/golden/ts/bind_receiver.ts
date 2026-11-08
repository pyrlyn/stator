// T34: `bind` inserts a receiver -- a method value bound to its own object or to another, and a
// second bind that cannot replace the first receiver.
class Counter {
  n = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  inc(by: number): number {
    this.n += by;
    return this.n;
  }
  show(prefix: string): string {
    return `${prefix}${this.label}=${String(this.n)}`;
  }
}
const c = new Counter("c");
const inc = c.inc.bind(c);
console.log(inc(2), inc(3), c.n);
const other = new Counter("other");
const incOther = c.inc.bind(other);
console.log(incOther(5), other.n, c.n);
const show = c.show.bind(other);
console.log(show("> "));
const rebound = show.bind(c);
console.log(rebound("again "), typeof rebound);
