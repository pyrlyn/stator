// `Buffer` (Node v26.7.0 lib/buffer.js), a class that extends `Uint8Array` as Node's does
// (plan/T11.6a): indexing, `length`, `subarray`, `slice` and iteration are the view's own, and a
// `Buffer` goes wherever a `Uint8Array` does. Text goes through the encodings `fs` uses
// (`./encoding.ts`). Gaps, each a subset limit:
// - `Buffer.from` takes a string (with an encoding) or a `Uint8Array` or number array; the
//   `ArrayBuffer` form, the object forms and the third overload (which exists so the class's
//   static side still extends `Uint8Array`'s) have not landed;
// - `console.log` prints a `Buffer` as a `Uint8Array` subclass (`Buffer(3) [Uint8Array] [ … ]`),
//   where Node prints `<Buffer 61 62 63>` through its custom inspector;
// - `byteLength` of base64 text is the decoded length, where Node estimates it from the text's
//   length (they differ only for text that is not base64);
// - the rest of `node:buffer` (`allocUnsafe`, `compare`, `copy`, `fill`, `write`, the `read*` and
//   `write*` numeric accessors, `Blob`, `File`, …) has not landed.

import { decodeBytes, encodeText, normalizeEncoding } from './encoding.ts';
import { NodeError } from './errors.ts';

/** Node's `ERR_UNKNOWN_ENCODING`, which `Buffer` throws where `fs` throws `ERR_INVALID_ARG_VALUE`. */
function unknownEncoding(encoding: string): NodeError {
  return new NodeError('TypeError', 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
}

/** `value` with `_` between each three digits, as Node writes a large integer it received
 * (lib/internal/errors.js `addNumericalSeparator`). */
function withSeparators(value: string): string {
  let out = '';
  const start = value.startsWith('-') ? 1 : 0;
  let i = value.length;
  for (; i >= start + 4; i -= 3) {
    out = `_${value.slice(i - 3, i)}${out}`;
  }
  return `${value.slice(0, i)}${out}`;
}

/** `Number.isInteger`, which is not-yet in Stator's subset. */
function isInteger(value: number): boolean {
  return Math.abs(value) !== Infinity && Math.trunc(value) === value;
}

/** `value` when it is an integer in `0..2^53-1`; otherwise Node's `ERR_OUT_OF_RANGE` for `name`. */
function checkedInteger(value: number, name: string): number {
  if (isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return value;
  }
  const range = isInteger(value) ? `>= 0 && <= ${Number.MAX_SAFE_INTEGER}` : 'an integer';
  const received =
    isInteger(value) && Math.abs(value) > 2 ** 32 ? withSeparators(`${value}`) : `${value}`;
  throw new NodeError(
    'RangeError',
    'ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  );
}

/** A relative offset into `length` bytes, as Node's `adjustOffset` reads one: negative counts from
 * the end, `NaN` is 0, and `absent` stands in for `undefined`. */
function offsetIn(offset: number | undefined, length: number, absent: number): number {
  if (offset === undefined) {
    return absent;
  }
  const n = Math.trunc(offset) || 0;
  return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
}

/** The canonical name for `encoding`; one Node does not know throws. */
function knownEncoding(encoding: string): string {
  const canonical = normalizeEncoding(encoding);
  if (canonical === undefined) {
    throw unknownEncoding(encoding);
  }
  return canonical;
}

export class Buffer extends Uint8Array {
  /** A copy of `view`'s elements `offset` to `offset + length`; `fs` answers a file's bytes so. */
  static copyBytesFrom(view: Uint8Array, offset?: number, length?: number): Buffer {
    const start = offset === undefined ? 0 : checkedInteger(offset, 'offset');
    const end =
      length === undefined
        ? view.length
        : Math.min(view.length, start + checkedInteger(length, 'length'));
    const out = new Buffer(Math.max(0, end - start));
    if (start < view.length) {
      out.set(view.subarray(start, end));
    }
    return out;
  }

  static override from(value: string, encoding?: string): Buffer;
  static override from(value: Uint8Array | readonly number[]): Buffer;
  static override from(
    value: ArrayLike<unknown> | Iterable<unknown>,
    mapfn?: (v: unknown, k: number) => number,
    thisArg?: unknown,
  ): Buffer;
  static override from(value: string | Uint8Array | readonly number[], encoding?: unknown): Buffer {
    if (typeof value === 'string') {
      // `from` reads an omitted or empty encoding as UTF-8; `toString` reads only an omitted one so.
      const canonical =
        typeof encoding === 'string' && encoding.length !== 0 ? knownEncoding(encoding) : 'utf8';
      return Buffer.copyBytesFrom(encodeText(value, canonical));
    }
    const out = new Buffer(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = value[i] ?? 0;
    }
    return out;
  }

  /** `size` zero bytes. */
  static alloc(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(value: unknown): boolean {
    return value instanceof Buffer;
  }

  static isEncoding(encoding: unknown): boolean {
    return (
      typeof encoding === 'string' &&
      encoding.length !== 0 &&
      normalizeEncoding(encoding) !== undefined
    );
  }

  /** The bytes `text` takes in `encoding`; an unknown encoding counts UTF-8, as Node's does. */
  static byteLength(text: string | Uint8Array, encoding?: string): number {
    if (typeof text !== 'string') {
      return text.byteLength;
    }
    const canonical = encoding === undefined ? 'utf8' : (normalizeEncoding(encoding) ?? 'utf8');
    return encodeText(text, canonical).length;
  }

  /** The views of `list` end to end, cut or zero-padded to `totalLength` when it is given. */
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    let length = 0;
    if (totalLength === undefined) {
      list.forEach((item) => {
        length += item.length;
      });
    } else {
      length = totalLength;
    }
    const out = new Buffer(length);
    let pos = 0;
    list.forEach((item) => {
      if (pos < length) {
        out.set(item.length > length - pos ? item.subarray(0, length - pos) : item, pos);
        pos += Math.min(item.length, length - pos);
      }
    });
    return out;
  }

  /** Bytes `start` to `end` over the same memory, typed `Buffer` as Node's typings declare it.
   * Written out rather than through `Uint8Array`'s, which would dispatch back here. */
  override subarray(start?: number, end?: number): Buffer {
    const from = offsetIn(start, this.length, 0);
    const to = offsetIn(end, this.length, this.length);
    // A view's memory is always an `ArrayBuffer`: Stator has no `SharedArrayBuffer`.
    return new Buffer(this.buffer as ArrayBuffer, this.byteOffset + from, Math.max(to - from, 0));
  }

  /** Node's `slice` shares memory, as `subarray` does, where `Uint8Array`'s copies. */
  override slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end);
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) {
      return false;
    }
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) {
        return false;
      }
    }
    return true;
  }

  /** Bytes `start` to `end` as text. The range is clamped before the encoding is checked, so an
   * empty range answers `''` even for an unknown encoding, as Node's does. */
  override toString(encoding?: string, start?: number, end?: number): string {
    const len = this.length;
    let from = 0;
    if (start !== undefined && start > 0) {
      if (start >= len) {
        return '';
      }
      from = Math.trunc(start) || 0;
    }
    const to = end === undefined || end > len ? len : Math.trunc(end) || 0;
    if (to <= from) {
      return '';
    }
    return decodeBytes(
      this.subarray(from, to),
      encoding === undefined ? 'utf8' : knownEncoding(encoding),
    );
  }
}
