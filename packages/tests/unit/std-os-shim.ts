// Pure stand-in for `std/os` so unit tests can import `fileHrefToPath` under Node.
export function platform(): string {
  return process.platform;
}
