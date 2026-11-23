// `file:` URLs and paths, as `url.pathToFileURL` and `url.fileURLToPath` convert them on POSIX
// (Node v26.7.0 lib/internal/url.js). Only what `node:module` and `import.meta.url` need; the
// `node:url` module is T11.6's.

import { bytesToUtf8, utf8ToBytes } from 'std/encoding';
import { platform } from 'std/os';
import { NodeError } from './errors.ts';

const HEX = '0123456789ABCDEF';

/** Characters `pathToFileURL` percent-encodes besides every non-ASCII one and the controls. */
const ENCODED = ' "#%<>?[]^`{|}~';

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

/** Drop `?query` and `#fragment` the way a URL parser does, at the first `?` or `#`. */
function withoutQueryOrFragment(href: string): string {
  let end = href.length;
  const query = href.indexOf('?');
  const fragment = href.indexOf('#');
  if (query !== -1 && query < end) end = query;
  if (fragment !== -1 && fragment < end) end = fragment;
  return href.slice(0, end);
}

/** `url.fileURLToPath(href)` for a `file:` URL: the path, percent-decoded as UTF-8. */
export function fileHrefToPath(href: string): string {
  const cut = withoutQueryOrFragment(href);
  const after = cut.startsWith('file://') ? cut.slice('file://'.length) : cut.slice('file:'.length);
  const slash = after.indexOf('/');
  const host = slash === -1 ? after : after.slice(0, slash);
  const path = slash === -1 ? '' : after.slice(slash);
  if (host !== '' && host.toLowerCase() !== 'localhost') {
    throw new NodeError(
      'TypeError',
      'ERR_INVALID_FILE_URL_HOST',
      `File URL host must be "localhost" or empty on ${platform()}`,
    );
  }
  let at = 0;
  while (at < path.length) {
    if (path.charAt(at) === '%' && path.slice(at, at + 3).toLowerCase() === '%2f') {
      throw new NodeError(
        'TypeError',
        'ERR_INVALID_FILE_URL_PATH',
        'File URL path must not include encoded / characters',
      );
    }
    at += 1;
  }
  const decoded = decodePercentPath(path);
  return decoded === '' ? '/' : decoded;
}

function decodePercentPath(path: string): string {
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
