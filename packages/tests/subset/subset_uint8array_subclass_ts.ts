// @mode: ts
// @verdict: static
// SUBSET.md: Uint8Array and ArrayBuffer
// A class extending `Uint8Array` with methods and statics but no constructor and no instance
// fields (plan/T11.6a): its instances are views, so writes and the landed members stay typed,
// and its own methods take the class's direct-call path.
class Bytes extends Uint8Array {
  static of2(a: number, b: number): Bytes {
    const out = new Bytes(2);
    out[0] = a;
    out[1] = b;
    return out;
  }

  half(): number {
    return this.length / 2;
  }
}
const bytes = Bytes.of2(1, 2);
console.log(bytes.half(), bytes.byteLength, bytes.subarray(1) instanceof Bytes);
