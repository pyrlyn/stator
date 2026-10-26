// The TypeScript scanner's token stream in the lexer golden-file form (docs/zig-core.md):
// `Kind<TAB>start<TAB>end` lines, offsets in UTF-8 bytes. Shared by gen-golden.ts and
// compare-corpus.ts.
import ts from 'typescript';

/** UTF-16 offset → UTF-8 byte offset into `text` (identity for ASCII sources). */
function utf8Offsets(text: string): (offset: number) => number {
  if (!/[^\p{ASCII}]/u.test(text)) {
    return (offset) => offset;
  }
  const table = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    table[i] = bytes;
    const unit = text.charCodeAt(i);
    bytes +=
      unit < 0x80
        ? 1
        : unit < 0x800
          ? 2
          : unit >= 0xd800 && unit <= 0xdbff
            ? 4
            : unit >= 0xdc00 && unit <= 0xdfff
              ? 0
              : 3;
  }
  table[text.length] = bytes;
  return (offset) => table[offset] ?? bytes;
}

/** `ts.SyntaxKind` value → its name, skipping the `First*`/`Last*` range aliases. */
const kindNames = new Map<number, string>();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value === 'number' && !/^(First|Last)/.test(name) && !kindNames.has(value)) {
    kindNames.set(value, name);
  }
}

/** The token stream as the frontend's parser sees it: `}` closing a `${` substitution is
 * re-scanned as template text, nothing else is re-scanned. Offsets are UTF-8 bytes, as in Zig. */
export function tokens(text: string): string {
  const bytes = utf8Offsets(text);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const braces: number[] = [];
  const lines: string[] = [];
  for (;;) {
    let kind = scanner.scan();
    const top = braces.length - 1;
    if (kind === ts.SyntaxKind.OpenBraceToken && top >= 0) {
      braces[top] = (braces[top] ?? 0) + 1;
    } else if (kind === ts.SyntaxKind.CloseBraceToken && top >= 0) {
      if (braces[top] === 0) {
        braces.pop();
        kind = scanner.reScanTemplateToken(false);
      } else {
        braces[top] = (braces[top] ?? 1) - 1;
      }
    }
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) {
      braces.push(0);
    }
    const name = kindNames.get(kind) ?? `Kind${String(kind)}`;
    lines.push(
      `${name}\t${String(bytes(scanner.getTokenStart()))}\t${String(bytes(scanner.getTokenEnd()))}`,
    );
    if (kind === ts.SyntaxKind.EndOfFileToken) {
      return `${lines.join('\n')}\n`;
    }
  }
}
