// A method or constructor call with fewer or more arguments than parameters keeps `this` and every
// argument in place (plan-notes 395): the receiver must never be guessed from the argument count.

class Span {
  readonly start: number;
  readonly end: number;

  constructor(start?: number, end?: number) {
    this.start = start === undefined ? 0 : start;
    this.end = end === undefined ? this.start : end;
  }

  length(): number {
    return this.end - this.start;
  }

  shift(by: number, scale?: number): Span {
    const factor = scale === undefined ? 1 : scale;
    return new Span(this.start + by * factor, this.end + by * factor);
  }

  label(prefix?: string, suffix?: string): string {
    return `${prefix ?? '['}${this.start},${this.end}${suffix ?? ']'}`;
  }
}

class Wide extends Span {
  constructor(start?: number) {
    super(start);
  }
}

const empty = new Span();
console.log(empty.start, empty.end, empty.length());
const one = new Span(3);
console.log(one.start, one.end, one.label());
const two = new Span(1, 4);
console.log(two.label('('), two.label('(', ')'), two.length());
console.log(two.shift(2).label(), two.shift(2, 3).label());
const wide = new Wide(7);
console.log(wide.start, wide.end, wide.label('<', '>'));
