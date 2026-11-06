// `Uint8Array` across the extern boundary (docs/FFI.md section 2, plan.md section 11c T11.3a):
// a view is its bytes in place plus its length, so C writes show through every view of the
// buffer, a subarray passes its own window, an empty view passes length 0, and a megabyte is one
// call — `bytesCalls` counts crossings on both sides.
/// <reference path="./bytes.d.ts" />

const buf = new Uint8Array(8);
console.log(bytesFill(buf.subarray(2, 6), 7));
console.log(buf);
for (let i = 0; i < buf.length; i++) {
  buf[i] = i * 3;
}
console.log(bytesSum(buf), bytesSum(buf.subarray(4)));
bytesReverse(buf.subarray(1));
console.log(buf);
console.log(bytesSum(new Uint8Array(0)), bytesFill(new Uint8Array(0), 9));
console.log(bytesEqual(buf, buf.slice()), bytesEqual(buf, buf.subarray(1)));
const view = new Uint8Array(buf.buffer, 2, 3);
bytesFill(view, 255);
console.log(buf);

// A subclass instance is a view (plan/T11.6a), so it crosses as its bytes like any other.
class Bytes extends Uint8Array {
  total(): number {
    return bytesSum(this);
  }
}
const own = new Bytes([1, 2, 3]);
bytesReverse(own);
console.log(own, own.total(), bytesSum(own.subarray(1)));

const big = new Uint8Array(1 << 20);
const before = bytesCalls();
console.log(bytesFill(big, 1));
console.log("calls for 1 MiB:", bytesCalls() - before);
console.log(bytesSum(big), big[0], big[big.length - 1]);
export {};
