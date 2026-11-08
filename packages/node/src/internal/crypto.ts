// `node:crypto` digests (Node v26.7.0 lib/internal/crypto/hash.js) over `std/hash`. `tsc` hashes
// with `createHash("sha256").update(text).digest("hex")` (plan.md §11c, slice N1). Gaps, each a
// subset limit:
// - the algorithms are the three `std/hash` computes (SHA-256, SHA-1, MD5) under OpenSSL's
//   common spellings; any other (`sha512`, …) throws Node's "Digest method not supported";
// - `update` buffers its input and the digest is computed once, by `digest`: `std/hash` is
//   one-shot, and the answer is the same;
// - arguments are not type-checked (`ERR_INVALID_ARG_TYPE`), a `DataView` is not data, and
//   `copy` and `createHash` ignore their `options` (`outputLength` is for XOF digests only);
// - the rest of `node:crypto` (`randomBytes`, `createHmac`, ciphers, keys, `webcrypto`, …) has
//   not landed.

import { md5, sha1, sha256 } from 'std/hash';
import { Buffer } from './buffer.ts';
import { decodeBytes, encodeText, normalizeEncoding } from './encoding.ts';
import { NodeError } from './errors.ts';

/** The encodings that make `digest` answer text; any other answers a `Buffer`, as Node's does. */
export type BinaryToTextEncoding =
  | 'base64'
  | 'base64url'
  | 'hex'
  | 'binary'
  | 'latin1'
  | 'utf8'
  | 'utf-8'
  | 'ascii'
  | 'utf16le'
  | 'ucs2';

/** The `std/hash` digest `algorithm` names, or `undefined`. OpenSSL reads the name
 * case-insensitively and knows the `sha-256` and `RSA-SHA256` spellings too. */
function digestName(algorithm: string): string | undefined {
  switch (algorithm.toLowerCase()) {
    case 'sha256':
    case 'sha-256':
    case 'sha2-256':
    case 'rsa-sha256':
      return 'sha256';
    case 'sha1':
    case 'sha-1':
    case 'rsa-sha1':
      return 'sha1';
    case 'md5':
    case 'rsa-md5':
      return 'md5';
    default:
      return undefined;
  }
}

function digestBytes(name: string, data: Uint8Array): Uint8Array {
  switch (name) {
    case 'sha1':
      return sha1(data);
    case 'md5':
      return md5(data);
    default:
      return sha256(data);
  }
}

/** `data` as bytes: a string in `encoding` (UTF-8 when absent or unknown, as Node reads it). */
function inputBytes(data: string | Uint8Array, encoding: string | undefined): Uint8Array {
  if (typeof data === 'string') {
    return encodeText(
      data,
      (encoding === undefined ? undefined : normalizeEncoding(encoding)) ?? 'utf8',
    );
  }
  return data;
}

export class Hash {
  private readonly name: string;
  private readonly algorithm: string;
  // Copies, not the caller's views: Node hashes the bytes as `update` receives them.
  private chunks: Uint8Array[] = [];
  private finalized = false;

  constructor(algorithm: string) {
    const name = digestName(algorithm);
    if (name === undefined) {
      throw new Error('Digest method not supported');
    }
    this.name = name;
    this.algorithm = algorithm;
  }

  private checkOpen(): void {
    if (this.finalized) {
      throw new NodeError('Error', 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    }
  }

  /** Adds `data` (a string in `inputEncoding`) and answers this hash, so calls chain. */
  update(data: string | Uint8Array, inputEncoding?: string): Hash {
    this.checkOpen();
    this.chunks.push(Buffer.copyBytesFrom(inputBytes(data, inputEncoding)));
    return this;
  }

  /** A hash with this one's state, which goes on independently. */
  copy(): Hash {
    this.checkOpen();
    const out = new Hash(this.algorithm);
    out.chunks = this.chunks.slice();
    return out;
  }

  /** The digest of everything added, once: a `Buffer`, or text in `encoding`. */
  digest(): Buffer;
  digest(encoding: BinaryToTextEncoding): string;
  digest(encoding: string): string | Buffer;
  digest(encoding?: string): string | Buffer {
    this.checkOpen();
    this.finalized = true;
    const bytes = digestBytes(this.name, Buffer.concat(this.chunks));
    const canonical = encoding === undefined ? undefined : normalizeEncoding(encoding);
    return canonical === undefined ? Buffer.copyBytesFrom(bytes) : decodeBytes(bytes, canonical);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

/** The one-shot digest of `data`: text in `outputEncoding` (hex by default), or a `Buffer` for
 * `'buffer'`. Unlike `digest`, an unknown encoding throws. */
export function hash(algorithm: string, data: string | Uint8Array): string;
export function hash(
  algorithm: string,
  data: string | Uint8Array,
  outputEncoding: 'buffer',
): Buffer;
export function hash(
  algorithm: string,
  data: string | Uint8Array,
  outputEncoding: BinaryToTextEncoding,
): string;
export function hash(
  algorithm: string,
  data: string | Uint8Array,
  outputEncoding?: string,
): string | Buffer {
  const encoding = outputEncoding ?? 'hex';
  const canonical = normalizeEncoding(encoding);
  if (canonical === undefined && encoding !== 'buffer') {
    throw new NodeError(
      'TypeError',
      'ERR_INVALID_ARG_VALUE',
      `The argument 'outputEncoding' is invalid. Received '${encoding}'`,
    );
  }
  const name = digestName(algorithm);
  if (name === undefined) {
    throw new Error(`Digest method ${algorithm} is not supported`);
  }
  const bytes = digestBytes(name, inputBytes(data, undefined));
  return canonical === undefined ? Buffer.copyBytesFrom(bytes) : decodeBytes(bytes, canonical);
}
