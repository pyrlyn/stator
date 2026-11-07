// node:crypto (plan.md §11c T11.6): `createHash`, `Hash` and the one-shot `hash` over `std/hash`,
// through named imports and the default export. `tsc` hashes with
// `createHash("sha256").update(text).digest("hex")`.
import crypto, { Hash, createHash, hash } from "node:crypto";

function report(run: () => string | object): void {
  try {
    console.log(run());
  } catch (e) {
    if (e instanceof Error) {
      console.log("threw", e.message);
    } else {
      console.log("threw", String(e));
    }
  }
}

console.log(createHash("sha256").update("abc").digest("hex"));
console.log(crypto.createHash("sha1").update("abc").digest("hex"));
console.log(createHash("md5").update("abc").digest("base64"));
console.log(createHash("sha256").digest("hex"));

// Spellings OpenSSL accepts.
for (const name of ["SHA256", "sha-256", "RSA-SHA256", "Sha1", "MD5"]) {
  console.log(name, createHash(name).update("x").digest("hex").length);
}
report(() => createHash("nope"));

// `update` chains, takes bytes, and reads a string in its input encoding.
const h = createHash("sha256");
console.log(h.update("ab") === h, h instanceof Hash);
h.update(new Uint8Array([99]));
const twin = h.copy();
console.log(h.digest("hex"));
console.log(twin.digest("base64"));
console.log(createHash("md5").update("ff", "hex").update("ZmY=", "base64").digest("hex"));
console.log(createHash("sha1").update("é", "latin1").digest("hex"));
console.log(createHash("sha1").update("é").digest("hex"));
console.log(createHash("md5").update("x", "bogus").digest("hex"));

// The input is hashed as `update` receives it.
const bytes = new Uint8Array([1, 2, 3]);
const early = createHash("md5").update(bytes);
bytes[0] = 9;
console.log(early.digest("hex"));

// A digest without an encoding, or with an unknown one, is a `Buffer`.
const raw = createHash("md5").update("hi").digest();
console.log(raw.length, raw instanceof Uint8Array, raw.toString("hex"));
const odd = createHash("md5").update("hi").digest("bogus");
console.log(typeof odd, odd.length);
console.log(createHash("md5").update("hi").digest("latin1").length);
console.log(createHash("md5").update("x").digest("base64url"));

// A finished hash refuses more work.
const done = createHash("sha256");
done.digest();
for (const step of [() => done.digest(), () => done.update("x"), () => done.copy()]) {
  try {
    step();
  } catch (e) {
    console.log(String(e));
  }
}

console.log(hash("sha1", "abc"), hash("md5", "abc", "base64"));
console.log(hash("sha256", new Uint8Array([97]), "buffer").toString("hex"));
console.log(crypto.hash("md5", "x", "hex"));
report(() => hash("nope", "x"));
try {
  hash("md5", "x", "bogus" as "hex");
} catch (e) {
  console.log(String(e));
}
