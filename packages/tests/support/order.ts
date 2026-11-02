/** UTF-16 code-unit order, what `sort()` uses by default, spelled out so a locale never decides it. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
