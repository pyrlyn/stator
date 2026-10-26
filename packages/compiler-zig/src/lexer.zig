//! Lexer for the Stator compiler core in Zig (docs/zig-core.md).
//!
//! Mirrors the token stream of the TypeScript scanner (`ts.createScanner` with trivia skipped)
//! that the TypeScript frontend uses today. Token kinds carry the `ts.SyntaxKind` names so the
//! golden files generated from the TypeScript side compare one-to-one.
//!
//! Like the TypeScript scanner, `>` is always a lone `GreaterThanToken` (the parser re-scans
//! `>=`, `>>`, `>>>`), and `/` is always a `SlashToken` or `SlashEqualsToken` (the parser
//! re-scans regular expressions). Unlike it, the lexer re-scans `}` as a template continuation
//! itself, by tracking open `${` substitutions.

const std = @import("std");

pub const Kind = enum {
    Unknown,
    EndOfFileToken,
    // Literals and names.
    NumericLiteral,
    BigIntLiteral,
    StringLiteral,
    NoSubstitutionTemplateLiteral,
    TemplateHead,
    TemplateMiddle,
    TemplateTail,
    Identifier,
    PrivateIdentifier,
    // Punctuation.
    OpenBraceToken,
    CloseBraceToken,
    OpenParenToken,
    CloseParenToken,
    OpenBracketToken,
    CloseBracketToken,
    DotToken,
    DotDotDotToken,
    SemicolonToken,
    CommaToken,
    QuestionDotToken,
    LessThanToken,
    GreaterThanToken,
    LessThanEqualsToken,
    EqualsEqualsToken,
    ExclamationEqualsToken,
    EqualsEqualsEqualsToken,
    ExclamationEqualsEqualsToken,
    EqualsGreaterThanToken,
    PlusToken,
    MinusToken,
    AsteriskToken,
    AsteriskAsteriskToken,
    SlashToken,
    PercentToken,
    PlusPlusToken,
    MinusMinusToken,
    LessThanLessThanToken,
    AmpersandToken,
    BarToken,
    CaretToken,
    ExclamationToken,
    TildeToken,
    AmpersandAmpersandToken,
    BarBarToken,
    QuestionToken,
    ColonToken,
    AtToken,
    QuestionQuestionToken,
    HashToken,
    EqualsToken,
    PlusEqualsToken,
    MinusEqualsToken,
    AsteriskEqualsToken,
    AsteriskAsteriskEqualsToken,
    SlashEqualsToken,
    PercentEqualsToken,
    LessThanLessThanEqualsToken,
    AmpersandEqualsToken,
    BarEqualsToken,
    BarBarEqualsToken,
    AmpersandAmpersandEqualsToken,
    QuestionQuestionEqualsToken,
    CaretEqualsToken,
    // Keywords (reserved and contextual), in ts.SyntaxKind order.
    BreakKeyword,
    CaseKeyword,
    CatchKeyword,
    ClassKeyword,
    ConstKeyword,
    ContinueKeyword,
    DebuggerKeyword,
    DefaultKeyword,
    DeleteKeyword,
    DoKeyword,
    ElseKeyword,
    EnumKeyword,
    ExportKeyword,
    ExtendsKeyword,
    FalseKeyword,
    FinallyKeyword,
    ForKeyword,
    FunctionKeyword,
    IfKeyword,
    ImportKeyword,
    InKeyword,
    InstanceOfKeyword,
    NewKeyword,
    NullKeyword,
    ReturnKeyword,
    SuperKeyword,
    SwitchKeyword,
    ThisKeyword,
    ThrowKeyword,
    TrueKeyword,
    TryKeyword,
    TypeOfKeyword,
    VarKeyword,
    VoidKeyword,
    WhileKeyword,
    WithKeyword,
    ImplementsKeyword,
    InterfaceKeyword,
    LetKeyword,
    PackageKeyword,
    PrivateKeyword,
    ProtectedKeyword,
    PublicKeyword,
    StaticKeyword,
    YieldKeyword,
    AbstractKeyword,
    AccessorKeyword,
    AsKeyword,
    AssertsKeyword,
    AssertKeyword,
    AnyKeyword,
    AsyncKeyword,
    AwaitKeyword,
    BooleanKeyword,
    ConstructorKeyword,
    DeclareKeyword,
    GetKeyword,
    InferKeyword,
    IntrinsicKeyword,
    IsKeyword,
    KeyOfKeyword,
    ModuleKeyword,
    NamespaceKeyword,
    NeverKeyword,
    OutKeyword,
    ReadonlyKeyword,
    RequireKeyword,
    NumberKeyword,
    ObjectKeyword,
    SatisfiesKeyword,
    SetKeyword,
    StringKeyword,
    SymbolKeyword,
    TypeKeyword,
    UndefinedKeyword,
    UniqueKeyword,
    UnknownKeyword,
    UsingKeyword,
    FromKeyword,
    GlobalKeyword,
    BigIntKeyword,
    OverrideKeyword,
    OfKeyword,
    DeferKeyword,
};

pub const Token = struct {
    kind: Kind,
    /// Byte offset of the first byte of the token (trivia excluded).
    start: u32,
    /// Byte offset one past the last byte of the token.
    end: u32,

    pub fn text(self: Token, source: []const u8) []const u8 {
        return source[self.start..self.end];
    }
};

const keywords = std.StaticStringMap(Kind).initComptime(.{
    .{ "abstract", .AbstractKeyword },       .{ "accessor", .AccessorKeyword },
    .{ "any", .AnyKeyword },                 .{ "as", .AsKeyword },
    .{ "asserts", .AssertsKeyword },         .{ "assert", .AssertKeyword },
    .{ "bigint", .BigIntKeyword },           .{ "boolean", .BooleanKeyword },
    .{ "break", .BreakKeyword },             .{ "case", .CaseKeyword },
    .{ "catch", .CatchKeyword },             .{ "class", .ClassKeyword },
    .{ "continue", .ContinueKeyword },       .{ "const", .ConstKeyword },
    .{ "constructor", .ConstructorKeyword }, .{ "debugger", .DebuggerKeyword },
    .{ "declare", .DeclareKeyword },         .{ "default", .DefaultKeyword },
    .{ "defer", .DeferKeyword },             .{ "delete", .DeleteKeyword },
    .{ "do", .DoKeyword },                   .{ "else", .ElseKeyword },
    .{ "enum", .EnumKeyword },               .{ "export", .ExportKeyword },
    .{ "extends", .ExtendsKeyword },         .{ "false", .FalseKeyword },
    .{ "finally", .FinallyKeyword },         .{ "for", .ForKeyword },
    .{ "from", .FromKeyword },               .{ "function", .FunctionKeyword },
    .{ "get", .GetKeyword },                 .{ "if", .IfKeyword },
    .{ "implements", .ImplementsKeyword },   .{ "import", .ImportKeyword },
    .{ "in", .InKeyword },                   .{ "infer", .InferKeyword },
    .{ "instanceof", .InstanceOfKeyword },   .{ "interface", .InterfaceKeyword },
    .{ "intrinsic", .IntrinsicKeyword },     .{ "is", .IsKeyword },
    .{ "keyof", .KeyOfKeyword },             .{ "let", .LetKeyword },
    .{ "module", .ModuleKeyword },           .{ "namespace", .NamespaceKeyword },
    .{ "never", .NeverKeyword },             .{ "new", .NewKeyword },
    .{ "null", .NullKeyword },               .{ "number", .NumberKeyword },
    .{ "object", .ObjectKeyword },           .{ "package", .PackageKeyword },
    .{ "private", .PrivateKeyword },         .{ "protected", .ProtectedKeyword },
    .{ "public", .PublicKeyword },           .{ "override", .OverrideKeyword },
    .{ "out", .OutKeyword },                 .{ "readonly", .ReadonlyKeyword },
    .{ "require", .RequireKeyword },         .{ "global", .GlobalKeyword },
    .{ "return", .ReturnKeyword },           .{ "satisfies", .SatisfiesKeyword },
    .{ "set", .SetKeyword },                 .{ "static", .StaticKeyword },
    .{ "string", .StringKeyword },           .{ "super", .SuperKeyword },
    .{ "switch", .SwitchKeyword },           .{ "symbol", .SymbolKeyword },
    .{ "this", .ThisKeyword },               .{ "throw", .ThrowKeyword },
    .{ "true", .TrueKeyword },               .{ "try", .TryKeyword },
    .{ "type", .TypeKeyword },               .{ "typeof", .TypeOfKeyword },
    .{ "undefined", .UndefinedKeyword },     .{ "unique", .UniqueKeyword },
    .{ "unknown", .UnknownKeyword },         .{ "using", .UsingKeyword },
    .{ "var", .VarKeyword },                 .{ "void", .VoidKeyword },
    .{ "while", .WhileKeyword },             .{ "with", .WithKeyword },
    .{ "yield", .YieldKeyword },             .{ "async", .AsyncKeyword },
    .{ "await", .AwaitKeyword },             .{ "of", .OfKeyword },
});

/// Longest-first punctuator table. `>` combinations are deliberately absent (see file doc).
const Punct = struct { []const u8, Kind };
const punctuators = [_]Punct{
    .{ "...", .DotDotDotToken },               .{ "===", .EqualsEqualsEqualsToken },
    .{ "!==", .ExclamationEqualsEqualsToken }, .{ "**=", .AsteriskAsteriskEqualsToken },
    .{ "<<=", .LessThanLessThanEqualsToken },  .{ "&&=", .AmpersandAmpersandEqualsToken },
    .{ "||=", .BarBarEqualsToken },            .{ "??=", .QuestionQuestionEqualsToken },
    .{ "==", .EqualsEqualsToken },             .{ "!=", .ExclamationEqualsToken },
    .{ "=>", .EqualsGreaterThanToken },        .{ "<=", .LessThanEqualsToken },
    .{ "<<", .LessThanLessThanToken },         .{ "**", .AsteriskAsteriskToken },
    .{ "++", .PlusPlusToken },                 .{ "--", .MinusMinusToken },
    .{ "&&", .AmpersandAmpersandToken },       .{ "||", .BarBarToken },
    .{ "??", .QuestionQuestionToken },         .{ "+=", .PlusEqualsToken },
    .{ "-=", .MinusEqualsToken },              .{ "*=", .AsteriskEqualsToken },
    .{ "/=", .SlashEqualsToken },              .{ "%=", .PercentEqualsToken },
    .{ "&=", .AmpersandEqualsToken },          .{ "|=", .BarEqualsToken },
    .{ "^=", .CaretEqualsToken },              .{ "{", .OpenBraceToken },
    .{ "}", .CloseBraceToken },                .{ "(", .OpenParenToken },
    .{ ")", .CloseParenToken },                .{ "[", .OpenBracketToken },
    .{ "]", .CloseBracketToken },              .{ ".", .DotToken },
    .{ ";", .SemicolonToken },                 .{ ",", .CommaToken },
    .{ "<", .LessThanToken },                  .{ ">", .GreaterThanToken },
    .{ "+", .PlusToken },                      .{ "-", .MinusToken },
    .{ "*", .AsteriskToken },                  .{ "/", .SlashToken },
    .{ "%", .PercentToken },                   .{ "&", .AmpersandToken },
    .{ "|", .BarToken },                       .{ "^", .CaretToken },
    .{ "!", .ExclamationToken },               .{ "~", .TildeToken },
    .{ "?", .QuestionToken },                  .{ ":", .ColonToken },
    .{ "@", .AtToken },                        .{ "=", .EqualsToken },
};

pub const Lexer = struct {
    source: []const u8,
    pos: u32 = 0,
    /// Brace depth inside each open `${ ... }` substitution; a `}` at depth 0 resumes the template.
    template_braces: [64]u16 = undefined,
    template_depth: u8 = 0,

    pub fn init(source: []const u8) Lexer {
        return .{ .source = source };
    }

    fn peek(self: *const Lexer, offset: u32) u8 {
        const i = self.pos + offset;
        return if (i < self.source.len) self.source[i] else 0;
    }

    fn skipTrivia(self: *Lexer) void {
        if (self.pos == 0 and std.mem.startsWith(u8, self.source, "#!")) {
            while (self.pos < self.source.len and self.source[self.pos] != '\n') self.pos += 1;
        }
        while (self.pos < self.source.len) {
            const c = self.source[self.pos];
            switch (c) {
                ' ', '\t', '\n', '\r', 0x0b, 0x0c => self.pos += 1,
                '/' => {
                    if (self.peek(1) == '/') {
                        while (self.pos < self.source.len and self.source[self.pos] != '\n') self.pos += 1;
                    } else if (self.peek(1) == '*') {
                        self.pos += 2;
                        while (self.pos < self.source.len and !(self.source[self.pos] == '*' and self.peek(1) == '/')) self.pos += 1;
                        self.pos = @min(self.pos + 2, @as(u32, @intCast(self.source.len)));
                    } else return;
                },
                else => return,
            }
        }
    }

    pub fn next(self: *Lexer) Token {
        self.skipTrivia();
        const start = self.pos;
        if (start >= self.source.len) return .{ .kind = .EndOfFileToken, .start = start, .end = start };
        const kind = self.scanToken();
        return .{ .kind = kind, .start = start, .end = self.pos };
    }

    fn scanToken(self: *Lexer) Kind {
        const c = self.source[self.pos];
        if (c >= 0x80) {
            const len = std.unicode.utf8ByteSequenceLength(c) catch 1;
            const cp = std.unicode.utf8Decode(self.source[self.pos..@min(self.pos + len, self.source.len)]) catch 0xfffd;
            if (!isUnicodeIdentifierStart(cp)) {
                self.pos += @min(len, @as(u32, @intCast(self.source.len)) - self.pos);
                return .Unknown;
            }
        }
        if (isIdentStart(c)) return self.scanIdentifier();
        if (isDigit(c) or (c == '.' and isDigit(self.peek(1)))) return self.scanNumber();
        switch (c) {
            '"', '\'' => return self.scanString(c),
            '`' => {
                self.pos += 1;
                return self.scanTemplate(true);
            },
            '#' => {
                self.pos += 1;
                if (self.pos < self.source.len and isIdentStart(self.source[self.pos])) {
                    _ = self.scanIdentifier();
                    return .PrivateIdentifier;
                }
                // TS reports a lone `#` as an (erroneous) empty private name.
                return .PrivateIdentifier;
            },
            '?' => if (self.peek(1) == '.' and !isDigit(self.peek(2))) {
                self.pos += 2;
                return .QuestionDotToken;
            },
            '{' => if (self.template_depth > 0) {
                self.template_braces[self.template_depth - 1] += 1;
            },
            '}' => if (self.template_depth > 0) {
                const depth = &self.template_braces[self.template_depth - 1];
                if (depth.* == 0) {
                    self.template_depth -= 1;
                    self.pos += 1;
                    return self.scanTemplate(false);
                }
                depth.* -= 1;
            },
            else => {},
        }
        const rest = self.source[self.pos..];
        for (punctuators) |p| {
            if (std.mem.startsWith(u8, rest, p[0])) {
                self.pos += @intCast(p[0].len);
                return p[1];
            }
        }
        self.pos += 1;
        return .Unknown;
    }

    fn scanIdentifier(self: *Lexer) Kind {
        const start = self.pos;
        while (self.pos < self.source.len and isIdentPart(self.source[self.pos])) self.pos += 1;
        return keywords.get(self.source[start..self.pos]) orelse .Identifier;
    }

    fn scanDigits(self: *Lexer, comptime isValid: fn (u8) bool) void {
        while (self.pos < self.source.len and (isValid(self.source[self.pos]) or self.source[self.pos] == '_')) self.pos += 1;
    }

    fn scanNumber(self: *Lexer) Kind {
        if (self.source[self.pos] == '0') {
            const radix = self.peek(1) | 0x20;
            if (radix == 'x' or radix == 'b' or radix == 'o') {
                self.pos += 2;
                self.scanDigits(std.ascii.isHex);
                return self.bigIntSuffix();
            }
        }
        self.scanDigits(isDigit);
        var integral = true;
        if (self.peek(0) == '.') {
            integral = false;
            self.pos += 1;
            self.scanDigits(isDigit);
        }
        if ((self.peek(0) | 0x20) == 'e') {
            const sign = self.peek(1);
            const skip: u32 = if (sign == '+' or sign == '-') 2 else 1;
            if (isDigit(self.peek(skip))) {
                integral = false;
                self.pos += skip;
                self.scanDigits(isDigit);
            }
        }
        return if (integral) self.bigIntSuffix() else .NumericLiteral;
    }

    fn bigIntSuffix(self: *Lexer) Kind {
        if (self.peek(0) == 'n') {
            self.pos += 1;
            return .BigIntLiteral;
        }
        return .NumericLiteral;
    }

    fn scanString(self: *Lexer, quote: u8) Kind {
        self.pos += 1;
        while (self.pos < self.source.len) {
            const c = self.source[self.pos];
            if (c == quote) {
                self.pos += 1;
                break;
            }
            if (c == '\n' or c == '\r') break; // unterminated: TS stops at the line break too
            self.pos += if (c == '\\') 2 else 1;
        }
        self.pos = @min(self.pos, @as(u32, @intCast(self.source.len)));
        return .StringLiteral;
    }

    /// Scans template text after a backtick (`head`) or after a substitution's closing `}`.
    fn scanTemplate(self: *Lexer, head: bool) Kind {
        while (self.pos < self.source.len) {
            const c = self.source[self.pos];
            if (c == '`') {
                self.pos += 1;
                return if (head) .NoSubstitutionTemplateLiteral else .TemplateTail;
            }
            if (c == '$' and self.peek(1) == '{') {
                self.pos += 2;
                if (self.template_depth < self.template_braces.len) {
                    self.template_braces[self.template_depth] = 0;
                    self.template_depth += 1;
                }
                return if (head) .TemplateHead else .TemplateMiddle;
            }
            self.pos += if (c == '\\') 2 else 1;
        }
        self.pos = @min(self.pos, @as(u32, @intCast(self.source.len)));
        return if (head) .NoSubstitutionTemplateLiteral else .TemplateTail;
    }
};

fn isDigit(c: u8) bool {
    return c >= '0' and c <= '9';
}

fn isIdentStart(c: u8) bool {
    return std.ascii.isAlphabetic(c) or c == '_' or c == '$' or c >= 0x80;
}

/// Approximates Unicode ID_Start without tables: symbol, punctuation and emoji blocks are not
/// identifiers; every other non-ASCII code point is (docs/zig-core.md, limitations).
fn isUnicodeIdentifierStart(cp: u21) bool {
    return !(cp < 0xc0 or (cp >= 0x2000 and cp <= 0x2bff) or (cp >= 0x3000 and cp <= 0x303f) or
        (cp >= 0xfe30 and cp <= 0xfe4f) or (cp >= 0xff00 and cp <= 0xff20) or cp >= 0x1f000 or cp == 0xfffd);
}

fn isIdentPart(c: u8) bool {
    return isIdentStart(c) or isDigit(c);
}

/// Writes the golden-file form of `source`'s token stream: `Kind<TAB>start<TAB>end` per line,
/// ending with the `EndOfFileToken` line.
pub fn dump(source: []const u8, out: *std.Io.Writer) std.Io.Writer.Error!void {
    var lexer = Lexer.init(source);
    while (true) {
        const tok = lexer.next();
        try out.print("{s}\t{d}\t{d}\n", .{ @tagName(tok.kind), tok.start, tok.end });
        if (tok.kind == .EndOfFileToken) return;
    }
}

test "punctuation is longest-match except for `>`" {
    var lexer = Lexer.init("a >>= b ?? c?.d ?.5");
    const expected = [_]Kind{ .Identifier, .GreaterThanToken, .GreaterThanToken, .EqualsToken, .Identifier, .QuestionQuestionToken, .Identifier, .QuestionDotToken, .Identifier, .QuestionToken, .NumericLiteral, .EndOfFileToken };
    for (expected) |kind| try std.testing.expectEqual(kind, lexer.next().kind);
}

test "templates nest through substitutions" {
    var lexer = Lexer.init("`a${ {x:1} }b${`c${d}`}e`");
    const expected = [_]Kind{ .TemplateHead, .OpenBraceToken, .Identifier, .ColonToken, .NumericLiteral, .CloseBraceToken, .TemplateMiddle, .TemplateHead, .Identifier, .TemplateTail, .TemplateTail, .EndOfFileToken };
    for (expected) |kind| try std.testing.expectEqual(kind, lexer.next().kind);
}

test "numbers and bigints" {
    var lexer = Lexer.init("1_000 0xffn 1.5e-3 10n .5");
    const expected = [_]Kind{ .NumericLiteral, .BigIntLiteral, .NumericLiteral, .BigIntLiteral, .NumericLiteral, .EndOfFileToken };
    for (expected) |kind| try std.testing.expectEqual(kind, lexer.next().kind);
}
