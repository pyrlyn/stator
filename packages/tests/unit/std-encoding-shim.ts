// Pure stand-in for `std/encoding` so unit tests can import `packages/node` URL helpers under
// Node without the native `std` archive. UTF-8 only, which is all `fileHrefToPath` needs.
export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
