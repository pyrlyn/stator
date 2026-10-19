// Node-side bindings for the extern_ptr golden (packages/tests/golden/run.ts): the same
// calls the Stator side makes as direct C calls, spelled in JS. The sentinel is object
// identity (one allocation, `===`); the blocks are Buffers, and `Buffer.compare` IS memcmp
// on bytes — normalized to -1/0/1 where libc promises only the sign, so the golden asserts
// `0` and `< 0`, which agree on both sides by construction.
type Bindings = Record<string, unknown>;
const bindings = globalThis as unknown as Bindings;
const sentinel: object = {};
bindings['ptrMake'] = (): object => sentinel;
bindings['ptrCheck'] = (box: unknown): number => (box === sentinel ? 1 : 0);
bindings['sysAlloc'] = (size: number): Buffer => Buffer.alloc(size);
bindings['sysFree'] = (_block: Buffer): void => {};
bindings['sysSet'] = (block: Buffer, value: number, size: number): Buffer => block.fill(value, 0, size);
bindings['sysCmp'] = (a: Buffer, b: Buffer, size: number): number =>
  Buffer.compare(a.subarray(0, size), b.subarray(0, size));
