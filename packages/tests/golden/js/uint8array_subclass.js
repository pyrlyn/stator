// A class that extends `Uint8Array` in js mode (plan/T11.6a): the typed paths of the ts fixture,
// plus a receiver the checker cannot type, whose members the runtime resolves -- the subclass's
// methods before the builtin's -- and whose string conversion runs the override.

class Bytes extends Uint8Array {
  static of(...values) {
    return new Bytes(values);
  }

  sum() {
    let total = 0;
    for (const b of this) {
      total += b;
    }
    return total;
  }

  toString() {
    return `Bytes(${this.length})`;
  }
}

class Tagged extends Bytes {
  tag() {
    return `#${this.sum()}`;
  }
}

function describe(value) {
  return `${value} ${value.sum()} ${value.length} ${value[1]}`;
}

const b = Bytes.of(1, 2, 3);
console.log(b.sum(), `${b}`, String(b), b instanceof Bytes, b instanceof Uint8Array);
console.log(describe(b), describe(new Tagged([4, 5])));
const t = new Tagged(new Uint8Array([9, 8, 7]));
console.log(t.tag(), t.subarray(1) instanceof Tagged, t.slice(2), [...t]);
console.log({ nested: { deeper: { bytes: t } } });
console.log(Object.prototype.toString.call(b), ArrayBuffer.isView(t));
