// Node-side bindings for the extern_ptr golden (packages/tests/golden/run.ts): the same
// calls the Stator side makes as direct C calls, spelled in JS. The sentinel is object
// identity (one allocation, `===`); the blocks are Buffers, and `Buffer.compare` IS memcmp
// on bytes — normalized to -1/0/1 where libc promises only the sign, so the golden asserts
// `0` and `< 0`, which agree on both sides by construction.
const sentinel = {};
globalThis.ptrMake = () => sentinel;
globalThis.ptrCheck = (box) => (box === sentinel ? 1 : 0);
globalThis.sysAlloc = (size) => Buffer.alloc(size);
globalThis.sysFree = (_block) => {};
globalThis.sysSet = (block, value, size) => block.fill(value, 0, size);
globalThis.sysCmp = (a, b, size) => Buffer.compare(a.subarray(0, size), b.subarray(0, size));
