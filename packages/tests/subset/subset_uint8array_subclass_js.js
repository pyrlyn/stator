// @mode: js
// @verdict: static
// SUBSET.md: Uint8Array and ArrayBuffer
// The same class in js mode: the checker infers the subclass from the declaration, so the
// methods and the inherited members resolve without an annotation (plan/T11.6a).
class Bytes extends Uint8Array {
  half() {
    return this.length / 2;
  }
}
const bytes = new Bytes([7, 8]);
console.log(bytes.half(), bytes.byteOffset, bytes instanceof Uint8Array);
