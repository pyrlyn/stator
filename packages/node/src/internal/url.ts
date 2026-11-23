// `file:` URLs and paths, as `url.pathToFileURL` and `url.fileURLToPath` convert them on POSIX
// (Node v26.7.0 lib/internal/url.js). Only what `node:module` and `import.meta.url` need; the
// `node:url` module is T11.6's.

import { bytesToUtf8, utf8ToBytes } from 'std/encoding';

const HEX = '0123456789ABCDEF';

/** Characters `pathToFileURL` percent-encodes besides every non-ASCII one and the controls. A raw
 * backslash would read as `/` to a URL parser. */
const ENCODED = ' "#%<>?[\\]^`{|}~';

function percentByte(byte: number): string {
  return `%${HEX.charAt(byte >> 4)}${HEX.charAt(byte & 15)}`;
}

/** `url.pathToFileURL(path).href` for an absolute POSIX path. */
export function pathToFileHref(path: string): string {
  let out = 'file://';
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 126 || code < 32 || ENCODED.includes(char)) {
      for (const byte of utf8ToBytes(char)) out += percentByte(byte);
    } else {
      out += char;
    }
  }
  return out;
}

function hexValue(char: string): number {
  return HEX.indexOf(char.toUpperCase());
}

/** `url.fileURLToPath(href)` for a `file:` URL with no host: the path, percent-decoded as UTF-8. */
export function fileHrefToPath(href: string): string {
  const path = href.slice('file://'.length);
  const bytes: number[] = [];
  let at = 0;
  while (at < path.length) {
    const high = path.charAt(at) === '%' ? hexValue(path.charAt(at + 1)) : -1;
    const low = high === -1 ? -1 : hexValue(path.charAt(at + 2));
    if (low !== -1) {
      bytes.push(high * 16 + low);
      at += 3;
      continue;
    }
    // A raw character is a whole code point: a high surrogate takes its partner along.
    const unit = path.charCodeAt(at);
    const width = unit >= 0xd800 && unit <= 0xdbff ? 2 : 1;
    for (const byte of utf8ToBytes(path.slice(at, at + width))) bytes.push(byte);
    at += width;
  }
  return bytesToUtf8(new Uint8Array(bytes));
}
