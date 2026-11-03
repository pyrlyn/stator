//! `stator.config.json` (`src/cli/config.ts`, docs/CONFIG.md): strict JSON, the same schema, the
//! same refusals. The file belongs to a project that may not be the user's, so nothing in it is
//! trusted until it has passed `validate`.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const failure = @import("failure.zig");
const Reporter = failure.Reporter;
const Error = failure.Error;
const oom = failure.oom;
const js_text = @import("../support/js_text.zig");

pub const file_name = "stator.config.json";

pub const Mode = enum { ts, js };
pub const Emit = enum { binary, c, lib };
pub const DiagnosticsFormat = enum { text, json };

pub const Config = struct {
    entry: ?[]const u8 = null,
    out: ?[]const u8 = null,
    mode: ?Mode = null,
    opt: ?u2 = null,
    link: ?[]const []const u8 = null,
    emit: ?Emit = null,
    keep_c: ?bool = null,
    emit_header: ?[]const u8 = null,
    unit_name: ?[]const u8 = null,
    bundler: ?[]const u8 = null,
    diagnostics: ?DiagnosticsFormat = null,
    node: ?bool = null,
};

pub const Choice = union(enum) { discover, path: []const u8, none };

pub const Loaded = struct { path: []const u8, config: Config };

/// The file's keys, null where a flag was absent. Only `link` reads differently: each entry is one
/// flag as given, not a string `splitFlags` still has to break up.
pub const CliOptions = Config;

pub const Resolved = struct {
    entry: ?[]const u8,
    out: ?[]const u8,
    mode: Mode,
    opt: u2,
    link: []const []const u8,
    emit: Emit,
    keep_c: bool,
    emit_header: ?[]const u8,
    unit_name: ?[]const u8,
    bundler: ?[]const u8,
    diagnostics: DiagnosticsFormat,
    node: bool,
};

// The JSON value, kept only long enough to validate it.
const Value = union(enum) {
    null,
    boolean: bool,
    number: f64,
    string: []const u8,
    array: []const Value,
    object: []const Member,
};

const Member = struct { key: []const u8, value: Value };

const SyntaxError = enum { InvalidSymbol, PropertyNameExpected, ValueExpected, ColonExpected, CommaExpected, CloseBraceExpected, CloseBracketExpected, EndOfFileExpected, InvalidCommentToken, UnexpectedEndOfString, UnexpectedEndOfNumber, InvalidUnicode, InvalidEscapeCharacter, InvalidCharacter };

const Token = enum { open_brace, close_brace, open_bracket, close_bracket, comma, colon, null_kw, true_kw, false_kw, string, number, comment, unknown, eof };

/// `JSON.parse` decides validity and jsonc-parser (comments and trailing commas disallowed) names
/// the failure. The two accept the same text, so one scanner serves both, shaped like jsonc-parser's
/// because that shape picks the error and offset the user sees. Parsing stops at the first error:
/// only that one is reported.
const Parser = struct {
    a: Allocator,
    text: []const u8,
    pos: usize = 0,
    token: Token = .unknown,
    token_offset: usize = 0,
    string_value: []const u8 = "",
    number_text: []const u8 = "",
    scan_error: ?SyntaxError = null,
    found: ?struct { kind: SyntaxError, offset: usize } = null,

    const Stop = error{Syntax};

    fn at(p: *const Parser, i: usize) u8 {
        return if (i < p.text.len) p.text[i] else 0;
    }

    fn report(p: *Parser, kind: SyntaxError) Stop {
        p.found = .{ .kind = kind, .offset = p.token_offset };
        return error.Syntax;
    }

    fn isWhiteSpace(ch: u8) bool {
        return ch == ' ' or ch == '\t';
    }

    fn isLineBreak(ch: u8) bool {
        return ch == '\n' or ch == '\r';
    }

    fn hexValue(ch: u8) ?u16 {
        return switch (ch) {
            '0'...'9' => ch - '0',
            'a'...'f' => ch - 'a' + 10,
            'A'...'F' => ch - 'A' + 10,
            else => null,
        };
    }

    fn scanHex4(p: *Parser) ?u16 {
        var digits: usize = 0;
        var value: u16 = 0;
        while (digits < 4) : (digits += 1) {
            if (p.pos >= p.text.len) return null;
            const v = hexValue(p.text[p.pos]) orelse return null;
            value = value * 16 + v;
            p.pos += 1;
        }
        return value;
    }

    fn scanNumber(p: *Parser) void {
        const start = p.pos;
        const t = p.text;
        if (p.at(p.pos) == '0') {
            p.pos += 1;
        } else {
            p.pos += 1;
            while (p.pos < t.len and std.ascii.isDigit(t[p.pos])) p.pos += 1;
        }
        if (p.pos < t.len and t[p.pos] == '.') {
            p.pos += 1;
            if (p.pos < t.len and std.ascii.isDigit(t[p.pos])) {
                while (p.pos < t.len and std.ascii.isDigit(t[p.pos])) p.pos += 1;
            } else {
                p.scan_error = .UnexpectedEndOfNumber;
                p.number_text = t[start..p.pos];
                return;
            }
        }
        var end = p.pos;
        if (p.pos < t.len and (t[p.pos] == 'e' or t[p.pos] == 'E')) {
            p.pos += 1;
            if (p.pos < t.len and (t[p.pos] == '+' or t[p.pos] == '-')) p.pos += 1;
            if (p.pos < t.len and std.ascii.isDigit(t[p.pos])) {
                while (p.pos < t.len and std.ascii.isDigit(t[p.pos])) p.pos += 1;
                end = p.pos;
            } else {
                p.scan_error = .UnexpectedEndOfNumber;
            }
        }
        p.number_text = t[start..end];
    }

    fn appendCodeUnit(p: *Parser, out: *std.ArrayList(u8), unit: u16) void {
        var cp: u21 = unit;
        // A high surrogate escape followed by a low one is one character, as in a JS string.
        if (std.unicode.utf16IsHighSurrogate(unit) and p.at(p.pos) == '\\' and p.at(p.pos + 1) == 'u') {
            const saved = p.pos;
            p.pos += 2;
            if (p.scanHex4()) |low| {
                if (std.unicode.utf16IsLowSurrogate(low)) {
                    cp = 0x10000 + ((@as(u21, unit) - 0xD800) << 10) + (low - 0xDC00);
                } else p.pos = saved;
            } else p.pos = saved;
        }
        var buf: [4]u8 = undefined;
        const n = std.unicode.wtf8Encode(cp, &buf) catch return;
        out.appendSlice(p.a, buf[0..n]) catch oom();
    }

    fn scanString(p: *Parser) void {
        var out: std.ArrayList(u8) = .empty;
        const t = p.text;
        while (true) {
            if (p.pos >= t.len) {
                p.scan_error = .UnexpectedEndOfString;
                break;
            }
            const ch = t[p.pos];
            if (ch == '"') {
                p.pos += 1;
                break;
            }
            if (ch == '\\') {
                p.pos += 1;
                if (p.pos >= t.len) {
                    p.scan_error = .UnexpectedEndOfString;
                    break;
                }
                const esc = t[p.pos];
                p.pos += 1;
                switch (esc) {
                    '"', '\\', '/' => out.append(p.a, esc) catch oom(),
                    'b' => out.append(p.a, 0x08) catch oom(),
                    'f' => out.append(p.a, 0x0c) catch oom(),
                    'n' => out.append(p.a, '\n') catch oom(),
                    'r' => out.append(p.a, '\r') catch oom(),
                    't' => out.append(p.a, '\t') catch oom(),
                    'u' => if (p.scanHex4()) |unit| {
                        p.appendCodeUnit(&out, unit);
                    } else {
                        p.scan_error = .InvalidUnicode;
                    },
                    else => p.scan_error = .InvalidEscapeCharacter,
                }
                continue;
            }
            if (ch <= 0x1f) {
                if (isLineBreak(ch)) {
                    p.scan_error = .UnexpectedEndOfString;
                    break;
                }
                p.scan_error = .InvalidCharacter;
            }
            out.append(p.a, ch) catch oom();
            p.pos += 1;
        }
        p.string_value = out.items;
    }

    fn isUnknownContent(ch: u8) bool {
        if (isWhiteSpace(ch) or isLineBreak(ch)) return false;
        return switch (ch) {
            '}', ']', '{', '[', '"', ':', ',', '/' => false,
            else => true,
        };
    }

    fn scanComment(p: *Parser) Token {
        const t = p.text;
        if (p.at(p.pos + 1) == '/') {
            p.pos += 2;
            while (p.pos < t.len and !isLineBreak(t[p.pos])) p.pos += 1;
            return .comment;
        }
        if (p.at(p.pos + 1) == '*') {
            p.pos += 2;
            while (p.pos + 1 < t.len) : (p.pos += 1) {
                if (t[p.pos] == '*' and t[p.pos + 1] == '/') {
                    p.pos += 2;
                    return .comment;
                }
            }
            p.pos = t.len;
            return .comment;
        }
        p.pos += 1;
        return .unknown;
    }

    fn scan(p: *Parser) Token {
        p.scan_error = null;
        p.token_offset = p.pos;
        const t = p.text;
        if (p.pos >= t.len) {
            p.token_offset = t.len;
            return .eof;
        }
        const ch = t[p.pos];
        switch (ch) {
            '{' => return p.single(.open_brace),
            '}' => return p.single(.close_brace),
            '[' => return p.single(.open_bracket),
            ']' => return p.single(.close_bracket),
            ':' => return p.single(.colon),
            ',' => return p.single(.comma),
            '"' => {
                p.pos += 1;
                p.scanString();
                return .string;
            },
            '/' => return p.scanComment(),
            '-' => {
                if (p.pos + 1 == t.len or !std.ascii.isDigit(t[p.pos + 1])) {
                    p.pos += 1;
                    return .unknown;
                }
                const start = p.pos;
                p.pos += 1;
                p.scanNumber();
                p.number_text = t[start .. start + 1 + p.number_text.len];
                return .number;
            },
            '0'...'9' => {
                p.scanNumber();
                return .number;
            },
            else => {},
        }
        while (p.pos < t.len and isUnknownContent(t[p.pos])) p.pos += 1;
        if (p.token_offset == p.pos) {
            p.pos += 1;
            return .unknown;
        }
        const word = t[p.token_offset..p.pos];
        if (std.mem.eql(u8, word, "true")) return .true_kw;
        if (std.mem.eql(u8, word, "false")) return .false_kw;
        if (std.mem.eql(u8, word, "null")) return .null_kw;
        return .unknown;
    }

    fn single(p: *Parser, token: Token) Token {
        p.pos += 1;
        return token;
    }

    fn next(p: *Parser) Stop!void {
        while (true) {
            while (p.pos < p.text.len and (isWhiteSpace(p.text[p.pos]) or isLineBreak(p.text[p.pos]))) p.pos += 1;
            const token = p.scan();
            p.token = token;
            if (p.scan_error) |e| return p.report(e);
            switch (token) {
                .comment => return p.report(.InvalidCommentToken),
                .unknown => return p.report(.InvalidSymbol),
                else => return,
            }
        }
    }

    fn parseValue(p: *Parser) Stop!?Value {
        switch (p.token) {
            .open_bracket => return .{ .array = try p.parseList(Value, .close_bracket, .CloseBracketExpected, arrayItem) },
            .open_brace => return .{ .object = try p.parseList(Member, .close_brace, .CloseBraceExpected, objectMember) },
            .string => {
                const s = p.string_value;
                try p.next();
                return .{ .string = s };
            },
            .number => {
                const n = std.fmt.parseFloat(f64, p.number_text) catch 0;
                try p.next();
                return .{ .number = n };
            },
            .null_kw => {
                try p.next();
                return .null;
            },
            .true_kw => {
                try p.next();
                return .{ .boolean = true };
            },
            .false_kw => {
                try p.next();
                return .{ .boolean = false };
            },
            else => return null,
        }
    }

    /// The comma rules arrays and objects share, up to `close`; `item` parses one element.
    fn parseList(p: *Parser, comptime Item: type, close: Token, unclosed: SyntaxError, comptime item: fn (*Parser, *std.ArrayList(Item)) Stop!void) Stop![]const Item {
        try p.next();
        var list: std.ArrayList(Item) = .empty;
        var needs_comma = false;
        while (p.token != close and p.token != .eof) {
            if (p.token == .comma) {
                if (!needs_comma) return p.report(.ValueExpected);
                try p.next();
            } else if (needs_comma) return p.report(.CommaExpected);
            try item(p, &list);
            needs_comma = true;
        }
        if (p.token != close) return p.report(unclosed);
        try p.next();
        return list.items;
    }

    fn arrayItem(p: *Parser, items: *std.ArrayList(Value)) Stop!void {
        const value = try p.parseValue() orelse return p.report(.ValueExpected);
        items.append(p.a, value) catch oom();
    }

    fn objectMember(p: *Parser, members: *std.ArrayList(Member)) Stop!void {
        if (p.token != .string) return p.report(.PropertyNameExpected);
        const key = p.string_value;
        try p.next();
        if (p.token != .colon) return p.report(.ColonExpected);
        try p.next();
        const value = try p.parseValue() orelse return p.report(.ValueExpected);
        setKey(Member, p.a, members, .{ .key = key, .value = value });
    }

    fn parseDocument(p: *Parser) Stop!Value {
        try p.next();
        if (p.token == .eof) return p.report(.ValueExpected);
        const value = try p.parseValue() orelse return p.report(.ValueExpected);
        if (p.token != .eof) return p.report(.EndOfFileExpected);
        return value;
    }
};

/// `object[key] = value` on a list in insertion order, as `JSON.parse` and dotenv both build one:
/// the last duplicate wins, in the first one's place.
pub fn setKey(comptime Entry: type, a: Allocator, list: *std.ArrayList(Entry), entry: Entry) void {
    for (list.items) |*e| {
        if (std.mem.eql(u8, e.key, entry.key)) {
            e.value = entry.value;
            return;
        }
    }
    list.append(a, entry) catch oom();
}

/// `text.slice(0, offset).split('\n')`: lines end at `\n` only, columns count UTF-16 units.
fn lineAndColumn(text: []const u8, offset: usize) struct { line: usize, column: usize } {
    var line: usize = 1;
    var column: usize = 1;
    var i: usize = 0;
    while (i < offset) {
        const b = text[i];
        if (b == '\n') {
            line += 1;
            column = 1;
            i += 1;
            continue;
        }
        const len = std.unicode.utf8ByteSequenceLength(b) catch 1;
        column += if (len == 4) 2 else 1;
        i += len;
    }
    return .{ .line = line, .column = column };
}

fn parseJson(a: Allocator, r: *Reporter, text: []const u8, path: []const u8) Error!Value {
    var p: Parser = .{ .a = a, .text = text };
    return p.parseDocument() catch {
        const found = p.found.?;
        const at = lineAndColumn(text, found.offset);
        return r.fail("STA0016", "{s}:{d}:{d}: not valid JSON ({t})", .{ path, at.line, at.column, found.kind });
    };
}

/// Node decodes a config file as UTF-8 and replaces what is not; the positions in an error count
/// the decoded text.
pub fn decodeUtf8(a: Allocator, bytes: []const u8) []const u8 {
    if (std.unicode.utf8ValidateSlice(bytes)) return bytes;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < bytes.len) {
        const len = std.unicode.utf8ByteSequenceLength(bytes[i]) catch 0;
        if (len != 0 and i + len <= bytes.len and std.unicode.utf8ValidateSlice(bytes[i .. i + len])) {
            out.appendSlice(a, bytes[i .. i + len]) catch oom();
            i += len;
        } else {
            out.appendSlice(a, "\u{FFFD}") catch oom();
            i += 1;
        }
    }
    return out.items;
}

/// Split on JavaScript's `\s`, which `pattern: '\\S'` goes by too.
pub fn splitFlags(a: Allocator, raw: []const u8) []const []const u8 {
    var flags: std.ArrayList([]const u8) = .empty;
    var start: ?usize = null;
    var it: js_text.CodePoints = .{ .bytes = raw };
    while (it.next()) |c| {
        if (js_text.isSpace(c.cp)) {
            if (start) |s| flags.append(a, raw[s..c.start]) catch oom();
            start = null;
        } else if (start == null) start = c.start;
    }
    if (start) |s| flags.append(a, raw[s..]) catch oom();
    return flags.items;
}

const Problems = struct {
    a: Allocator,
    list: std.ArrayList([]const u8) = .empty,

    fn add(self: *Problems, comptime fmt: []const u8, args: anytype) void {
        self.list.append(self.a, std.fmt.allocPrint(self.a, fmt, args) catch oom()) catch oom();
    }
};

const Rule = enum { string, non_empty, boolean, mode, opt, emit, diagnostics, link };

/// In schema order, which is the order problems are reported in.
const rules = [_]struct { key: []const u8, rule: Rule }{
    .{ .key = "$schema", .rule = .string },
    .{ .key = "entry", .rule = .non_empty },
    .{ .key = "out", .rule = .non_empty },
    .{ .key = "mode", .rule = .mode },
    .{ .key = "opt", .rule = .opt },
    .{ .key = "link", .rule = .link },
    .{ .key = "emit", .rule = .emit },
    .{ .key = "keepC", .rule = .boolean },
    .{ .key = "emitHeader", .rule = .non_empty },
    .{ .key = "unitName", .rule = .non_empty },
    .{ .key = "bundler", .rule = .non_empty },
    .{ .key = "diagnostics", .rule = .diagnostics },
    .{ .key = "node", .rule = .boolean },
};

fn isKnownKey(key: []const u8) bool {
    for (rules) |rule| if (std.mem.eql(u8, rule.key, key)) return true;
    return false;
}

/// `Object.keys` order: array-index keys ascending, then insertion order.
fn arrayIndex(key: []const u8) ?u32 {
    if (key.len == 0 or (key.len > 1 and key[0] == '0')) return null;
    const v = std.fmt.parseInt(u32, key, 10) catch return null;
    if (v == std.math.maxInt(u32)) return null;
    for (key) |c| if (!std.ascii.isDigit(c)) return null;
    return v;
}

fn indexLess(_: void, l: Member, r: Member) bool {
    return arrayIndex(l.key).? < arrayIndex(r.key).?;
}

fn jsonPointer(a: Allocator, key: []const u8) []const u8 {
    const tilde = std.mem.replaceOwned(u8, a, key, "~", "~0") catch oom();
    return std.mem.replaceOwned(u8, a, tilde, "/", "~1") catch oom();
}

fn unknownKeys(a: Allocator, members: []const Member, problems: *Problems) void {
    var indexed: std.ArrayList(Member) = .empty;
    for (members) |m| {
        if (!isKnownKey(m.key) and arrayIndex(m.key) != null) indexed.append(a, m) catch oom();
    }
    std.mem.sort(Member, indexed.items, {}, indexLess);
    for (indexed.items) |m| problems.add("/{s}: unknown key", .{jsonPointer(a, m.key)});
    for (members) |m| {
        if (!isKnownKey(m.key) and arrayIndex(m.key) == null) problems.add("/{s}: unknown key", .{jsonPointer(a, m.key)});
    }
}

fn hasNonSpace(s: []const u8) bool {
    var it: js_text.CodePoints = .{ .bytes = s };
    while (it.next()) |c| if (!js_text.isSpace(c.cp)) return true;
    return false;
}

fn checkEnum(key: []const u8, comptime allowed: []const u8, matches: bool, problems: *Problems) void {
    if (!matches) problems.add("/{s}: expected one of " ++ allowed, .{key});
}

fn stringIs(value: Value, s: []const u8) bool {
    return value == .string and std.mem.eql(u8, value.string, s);
}

fn numberIs(value: Value, n: f64) bool {
    return value == .number and value.number == n;
}

fn checkRule(key: []const u8, rule: Rule, value: Value, problems: *Problems) void {
    switch (rule) {
        .string => if (value != .string) problems.add("/{s}: must be string", .{key}),
        .non_empty => if (value != .string)
            problems.add("/{s}: must be string", .{key})
        else if (value.string.len == 0)
            problems.add("/{s}: must not have fewer than 1 characters", .{key}),
        .boolean => if (value != .boolean) problems.add("/{s}: must be boolean", .{key}),
        .mode => checkEnum(key, "\"ts\", \"js\"", stringIs(value, "ts") or stringIs(value, "js"), problems),
        .emit => checkEnum(key, "\"binary\", \"c\", \"lib\"", stringIs(value, "binary") or stringIs(value, "c") or stringIs(value, "lib"), problems),
        .diagnostics => checkEnum(key, "\"text\", \"json\"", stringIs(value, "text") or stringIs(value, "json"), problems),
        .opt => checkEnum(key, "0, 1, 2, 3", numberIs(value, 0) or numberIs(value, 1) or numberIs(value, 2) or numberIs(value, 3), problems),
        .link => {
            if (value != .array) {
                problems.add("/{s}: must be array", .{key});
                return;
            }
            for (value.array, 0..) |item, i| {
                if (item != .string)
                    problems.add("/{s}/{d}: must be string", .{ key, i })
                else if (!hasNonSpace(item.string))
                    problems.add("/{s}/{d}: expected a string with a non-space character", .{ key, i });
            }
        },
    }
}

fn enumOf(comptime E: type, s: []const u8) E {
    return std.meta.stringToEnum(E, s).?;
}

fn validate(a: Allocator, r: *Reporter, value: Value, path: []const u8) Error!Config {
    if (value != .object) return r.fail("STA0017", "{s}: does not match the schema: /: must be object", .{path});
    var problems: Problems = .{ .a = a };
    unknownKeys(a, value.object, &problems);
    for (rules) |rule| {
        for (value.object) |m| {
            if (std.mem.eql(u8, m.key, rule.key)) checkRule(rule.key, rule.rule, m.value, &problems);
        }
    }
    if (problems.list.items.len != 0) {
        const joined = std.mem.join(a, "; ", problems.list.items) catch oom();
        return r.fail("STA0017", "{s}: does not match the schema: {s}", .{ path, joined });
    }
    var c: Config = .{};
    for (value.object) |m| {
        const v = m.value;
        if (std.mem.eql(u8, m.key, "entry")) c.entry = v.string;
        if (std.mem.eql(u8, m.key, "out")) c.out = v.string;
        if (std.mem.eql(u8, m.key, "mode")) c.mode = enumOf(Mode, v.string);
        if (std.mem.eql(u8, m.key, "opt")) c.opt = @intFromFloat(v.number);
        if (std.mem.eql(u8, m.key, "emit")) c.emit = enumOf(Emit, v.string);
        if (std.mem.eql(u8, m.key, "keepC")) c.keep_c = v.boolean;
        if (std.mem.eql(u8, m.key, "emitHeader")) c.emit_header = v.string;
        if (std.mem.eql(u8, m.key, "unitName")) c.unit_name = v.string;
        if (std.mem.eql(u8, m.key, "bundler")) c.bundler = v.string;
        if (std.mem.eql(u8, m.key, "diagnostics")) c.diagnostics = enumOf(DiagnosticsFormat, v.string);
        if (std.mem.eql(u8, m.key, "node")) c.node = v.boolean;
        if (std.mem.eql(u8, m.key, "link")) {
            const items = a.alloc([]const u8, v.array.len) catch oom();
            for (v.array, items) |item, *out| out.* = item.string;
            c.link = items;
        }
    }
    return c;
}

/// Validates text as if it had been read from `path`.
pub fn parseConfig(a: Allocator, r: *Reporter, bytes: []const u8, path: []const u8) Error!Config {
    const text = decodeUtf8(a, bytes);
    return validate(a, r, try parseJson(a, r, text, path), path);
}

pub fn load(a: Allocator, r: *Reporter, io: Io, choice: Choice, cwd: []const u8) Error!?Loaded {
    const relative = switch (choice) {
        .none => return null,
        .path => |p| p,
        .discover => file_name,
    };
    const path = fspath.resolve(a, &.{ cwd, relative }) catch oom();
    const bytes = Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited) catch |e| switch (e) {
        error.FileNotFound => {
            if (choice == .discover) return null;
            return r.fail("STA0018", "--config names a missing file: {s}", .{path});
        },
        error.IsDir => return r.fail("STA0016", "{s}: cannot read the config file (EISDIR: illegal operation on a directory, read)", .{path}),
        error.AccessDenied, error.PermissionDenied => return r.fail("STA0016", "{s}: cannot read the config file (EACCES: permission denied, open '{s}')", .{ path, path }),
        error.OutOfMemory => oom(),
        else => return r.fail("STA0016", "{s}: cannot read the config file ({t})", .{ path, e }),
    };
    return .{ .path = path, .config = try parseConfig(a, r, bytes, path) };
}

/// Precedence: command line, environment, file, default. `link` concatenates, file first. Paths
/// from the file resolve against its directory; command-line paths stay as given.
pub fn resolveOptions(a: Allocator, cli: CliOptions, env_opt: ?u2, file: ?Loaded) Resolved {
    const c: Config = if (file) |f| f.config else .{};
    const base = if (file) |f| fspath.dirname(f.path) orelse "/" else "";
    const fromFile = struct {
        fn apply(alloc: Allocator, dir: []const u8, value: ?[]const u8) ?[]const u8 {
            const v = value orelse return null;
            return fspath.resolve(alloc, &.{ dir, v }) catch oom();
        }
    }.apply;
    var link: std.ArrayList([]const u8) = .empty;
    if (c.link) |entries| {
        for (entries) |entry| link.appendSlice(a, splitFlags(a, entry)) catch oom();
    }
    link.appendSlice(a, cli.link orelse &.{}) catch oom();
    const bundler = cli.bundler orelse if (c.bundler) |b|
        (if (b[0] == '.') fromFile(a, base, b) else b)
    else
        null;
    return .{
        .entry = cli.entry orelse fromFile(a, base, c.entry),
        .out = cli.out orelse fromFile(a, base, c.out),
        .mode = cli.mode orelse c.mode orelse .ts,
        .opt = cli.opt orelse env_opt orelse c.opt orelse 2,
        .link = link.items,
        .emit = cli.emit orelse c.emit orelse .binary,
        .keep_c = cli.keep_c orelse c.keep_c orelse false,
        .emit_header = cli.emit_header orelse fromFile(a, base, c.emit_header),
        .unit_name = cli.unit_name orelse c.unit_name,
        .bundler = bundler,
        .diagnostics = cli.diagnostics orelse c.diagnostics orelse .text,
        .node = cli.node orelse c.node orelse false,
    };
}

fn expectMessage(text: []const u8, message: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    try std.testing.expectError(error.Failed, parseConfig(arena.allocator(), &r, text, "c.json"));
    try std.testing.expectEqualStrings(message, r.failure.?.message);
}

test "syntax errors name the first problem, located as jsonc-parser locates it" {
    try expectMessage("", "c.json:1:1: not valid JSON (ValueExpected)");
    try expectMessage("{\"a\":1,}", "c.json:1:8: not valid JSON (PropertyNameExpected)");
    try expectMessage("// c\n{}", "c.json:1:1: not valid JSON (InvalidCommentToken)");
    try expectMessage("{} x", "c.json:1:4: not valid JSON (InvalidSymbol)");
    try expectMessage("{\"a\":01}", "c.json:1:7: not valid JSON (CommaExpected)");
    try expectMessage("\t{\n  \"a\": [1,\n 2,,\n]}", "c.json:3:4: not valid JSON (ValueExpected)");
}

test "schema problems come out unknown keys first, then in schema order" {
    try expectMessage("{\"foo\":1,\"opt\":9,\"mode\":3,\"keepC\":\"x\"}", "c.json: does not match the schema: /foo: unknown key; /mode: expected one of \"ts\", \"js\"; /opt: expected one of 0, 1, 2, 3; /keepC: must be boolean");
    try expectMessage("{\"a/b\":2,\"t~\":3}", "c.json: does not match the schema: /a~1b: unknown key; /t~0: unknown key");
    try expectMessage("{\"link\":[1,\"\"]}", "c.json: does not match the schema: /link/0: must be string; /link/1: expected a string with a non-space character");
    try expectMessage("[]", "c.json: does not match the schema: /: must be object");
}

test "precedence: command line, environment, file, default" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r: Reporter = .{ .a = a };
    const c = try parseConfig(a, &r, "{\"opt\":1,\"entry\":\"src/a.ts\",\"link\":[\"-la  -lb\"],\"bundler\":\"./x.ts\"}", "/p/c.json");
    const o = resolveOptions(a, .{ .link = &.{"-lc"} }, 3, .{ .path = "/p/c.json", .config = c });
    try std.testing.expectEqual(@as(u2, 3), o.opt);
    try std.testing.expectEqualStrings("/p/src/a.ts", o.entry.?);
    try std.testing.expectEqualStrings("/p/x.ts", o.bundler.?);
    try std.testing.expectEqual(@as(usize, 3), o.link.len);
}
