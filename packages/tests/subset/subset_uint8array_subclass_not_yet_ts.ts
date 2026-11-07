// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Uint8Array and ArrayBuffer
// A class extending `Uint8Array` with a constructor would need `super(...)` to build the view and
// the species construction of `subarray`/`slice` to call it; neither has landed (plan/T11.6a).
class Bytes extends Uint8Array {
  constructor(size: number) {
    super(size);
  }
}
console.log(new Bytes(2).length);
