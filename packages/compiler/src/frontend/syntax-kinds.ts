/* Tables of syntax kinds, spelled by member name.
 *
 * A table written as `ts.SyntaxKind.X` rows repeats one prefix on every line, so two tables that
 * list different kinds read as copies of each other to the clone check (`pnpm run dupes`, which
 * ignores identifiers). By name, each row is only the kind it lists, and the names are still
 * checked against the enum. */

import * as ts from 'typescript';

/** A `ts.SyntaxKind` member name; the enum's reverse mapping adds `number` keys, which name none. */
export type SyntaxKindName = Extract<keyof typeof ts.SyntaxKind, string>;

export function syntaxKindSet(...names: readonly SyntaxKindName[]): ReadonlySet<ts.SyntaxKind> {
  return new Set(names.map((name) => ts.SyntaxKind[name]));
}

export function syntaxKindMap<V>(
  rows: Readonly<Partial<Record<SyntaxKindName, V>>>,
): ReadonlyMap<ts.SyntaxKind, V> {
  const map = new Map<ts.SyntaxKind, V>();
  for (const [name, value] of Object.entries(rows)) {
    if (value !== undefined) {
      map.set(ts.SyntaxKind[name as SyntaxKindName], value);
    }
  }
  return map;
}
