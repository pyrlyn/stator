//! Membership in a fixed list of names.
const std = @import("std");

pub fn contains(list: []const []const u8, name: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item, name)) return true;
    return false;
}

/// The `std.mem.sort` order of names: bytewise, which is also JavaScript's for ASCII.
pub fn lessThan(_: void, l: []const u8, r: []const u8) bool {
    return std.mem.lessThan(u8, l, r);
}

pub fn isWordByte(b: u8) bool {
    return std.ascii.isAlphanumeric(b) or b == '_';
}

pub fn isIdentifierStart(b: u8) bool {
    return std.ascii.isAlphabetic(b) or b == '_';
}

/// `/^[A-Za-z0-9_]+$/`.
pub fn isWord(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |b| if (!isWordByte(b)) return false;
    return true;
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
pub fn isCIdentifier(s: []const u8) bool {
    return isWord(s) and isIdentifierStart(s[0]);
}
