// A read of an optional property pairs its `undefined` off with the target's, so `T` is `Block`.
interface Block { kind: "block" }
interface Try { tryBlock: Block; catchBlock?: Block }
function rewriteOptional<T>(value: T | undefined, f: (v: T) => T): T | undefined {
  return value === undefined ? undefined : f(value);
}
function rewrite(b: Block): Block {
  return b;
}
function go(stmt: Try): Block | undefined {
  return rewriteOptional(stmt.catchBlock, (b) => rewrite(b));
}
function bad(stmt: Try): number | undefined {
  return rewriteOptional(stmt.catchBlock, (b) => rewrite(b));
}
