// A class that extends `Uint8Array` (plan/T11.6a): construction, indexing and the landed members
// read the view, its own methods and statics are the class's, an override wins over the builtin
// member, `subarray` and `slice` answer the subclass (species), `instanceof` holds both ways, and
// the value goes wherever a `Uint8Array` does. Node prints it as `Name(n) [Uint8Array] [ … ]`.

class Bytes extends Uint8Array {
  static ofText(text: string): Bytes {
    const out = new Bytes(text.length);
    for (let i = 0; i < text.length; i++) {
      out[i] = text.charCodeAt(i);
    }
    return out;
  }

  sum(): number {
    let total = 0;
    for (const b of this) {
      total += b;
    }
    return total;
  }

  hex(): string {
    let text = '';
    for (let i = 0; i < this.length; i++) {
      text += (this[i] ?? 0).toString(16).padStart(2, '0');
    }
    return text;
  }

  override toString(): string {
    return `Bytes<${this.hex()}>`;
  }
}

class Tagged extends Bytes {
  tag(): string {
    return `#${this.sum()}`;
  }
}

function total(view: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < view.length; i++) {
    n += view[i] ?? 0;
  }
  return n;
}

const b = Bytes.ofText('hi!');
console.log(b.length, b[0], b[2], b.sum(), b.hex(), b.toString());
console.log(b instanceof Bytes, b instanceof Uint8Array, b instanceof Tagged);
b[1] = 300;
console.log(b[1], b.byteLength, b.byteOffset, total(b));
const sub = b.subarray(1);
console.log(sub.length, sub instanceof Bytes, sub instanceof Uint8Array);
const copy = b.slice(0, 2);
console.log(copy.length, copy instanceof Bytes);
console.log(b);
console.log(new Bytes(0), [new Bytes(2)]);
const t = new Tagged([1, 2, 3]);
console.log(t.tag(), t.hex(), t instanceof Bytes, t instanceof Tagged);
console.log(t);
const fromBuffer = new Bytes(new ArrayBuffer(4), 1, 2);
console.log(fromBuffer.length, fromBuffer.byteOffset);
const plain = new Uint8Array(2);
console.log(plain instanceof Bytes);
