// node:crypto in js mode (plan.md §11c T11.6): `createHash` as `tsc` calls it, through `require`
// and the named import, plus `hash`.
import { createRequire } from "node:module";
import { createHash, hash } from "node:crypto";

const require = createRequire(import.meta.url);
const crypto = require("crypto");

function sha256(data) {
  const h = crypto.createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

console.log(sha256("abc"));
console.log(sha256(""));
console.log(createHash("md5").update("ab").update("c").digest("base64"));
const h = createHash("sha1");
h.update("x");
const twin = h.copy();
console.log(h.digest("hex"), twin.digest("hex"));
try {
  h.digest();
} catch (e) {
  console.log(String(e));
}
console.log(hash("sha1", "abc"), hash("md5", "abc", "base64"));
try {
  createHash("nope");
} catch (e) {
  console.log(e.message);
}
