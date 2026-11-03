//! macOS SDK fallback for a stale bundled linker (`src/support/toolchain.ts`). The pinned conda
//! clang ships an ld64 that predates the `.tbd` format Xcode 26 writes, so every link against the
//! default SDK fails. The repair is a retry, not a switch: only a failure carrying the stale-linker
//! signature retries once with `-isysroot` at the newest Command Line Tools SDK the old parser reads.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const oom = @import("failure.zig").oom;

pub const clt_sdk_root = "/Library/Developer/CommandLineTools/SDKs";

const Rank = struct { major: i64, minor: i64 };

/// A missing minor is -1, so `MacOSX26.sdk` is older than `MacOSX26.0.sdk`.
fn versionedSdkRank(name: []const u8) ?Rank {
    if (!std.mem.startsWith(u8, name, "MacOSX") or !std.mem.endsWith(u8, name, ".sdk")) return null;
    const version = name["MacOSX".len .. name.len - ".sdk".len];
    var parts = std.mem.splitScalar(u8, version, '.');
    const major = parts.next() orelse return null;
    const minor = parts.next();
    if (parts.next() != null) return null;
    const parse = struct {
        fn digits(s: []const u8) ?i64 {
            if (s.len == 0) return null;
            for (s) |c| if (!std.ascii.isDigit(c)) return null;
            return std.fmt.parseInt(i64, s, 10) catch null;
        }
    }.digits;
    return .{ .major = parse(major) orelse return null, .minor = if (minor) |m| parse(m) orelse return null else -1 };
}

/// Version order: lexicographic order puts `MacOSX26.sdk` after `MacOSX26.5.sdk`.
pub fn sdkLess(_: void, first: []const u8, second: []const u8) bool {
    const a = versionedSdkRank(first);
    const b = versionedSdkRank(second);
    if (a == null or b == null) {
        if (a == null and b == null) return std.mem.lessThan(u8, first, second);
        return a == null;
    }
    if (a.?.major != b.?.major) return a.?.major < b.?.major;
    return a.?.minor < b.?.minor;
}

/// `arm64e.x1`: plain `arm64e` parses fine and must not match.
fn hasNewArchToken(tbd: []const u8) bool {
    var at: usize = 0;
    while (std.mem.indexOfPos(u8, tbd, at, "arm64e.")) |i| {
        const next = i + "arm64e.".len;
        if (next < tbd.len and (std.ascii.isLower(tbd[next]) or std.ascii.isDigit(tbd[next]))) return true;
        at = next;
    }
    return false;
}

/// Kept narrow on purpose: any other link failure must surface unchanged.
pub fn isStaleLdSystemLibFailure(stderr: []const u8) bool {
    return std.mem.indexOf(u8, stderr, ".tbd") != null and
        (std.mem.indexOf(u8, stderr, "malformed file") != null or std.mem.indexOf(u8, stderr, "unknown architecture") != null);
}

/// Null on any filesystem surprise: this runs on a link-failure path that already has an error to
/// report.
pub fn findFallbackSdk(a: Allocator, io: Io, sdk_root: []const u8) ?[]const u8 {
    var dir = Io.Dir.cwd().openDir(io, sdk_root, .{ .iterate = true }) catch return null;
    defer dir.close(io);
    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (it.next(io) catch return null) |entry| {
        if (versionedSdkRank(entry.name) == null) continue;
        const tbd_path = std.fmt.allocPrint(a, "{s}/{s}/usr/lib/libSystem.tbd", .{ sdk_root, entry.name }) catch oom();
        const tbd = Io.Dir.cwd().readFileAlloc(io, tbd_path, a, .unlimited) catch continue;
        if (hasNewArchToken(tbd)) continue;
        names.append(a, a.dupe(u8, entry.name) catch oom()) catch oom();
    }
    std.mem.sort([]const u8, names.items, {}, sdkLess);
    if (names.items.len == 0) return null;
    return std.fmt.allocPrint(a, "{s}/{s}", .{ sdk_root, names.items[names.items.len - 1] }) catch oom();
}

pub const hint_fix = " — install the CLT (`xcode-select --install`) or link with the system compiler (`CC=/usr/bin/clang`)";

pub fn staleLdHint(a: Allocator, retried_sysroot: ?[]const u8) []const u8 {
    const tried = if (retried_sysroot) |s|
        std.fmt.allocPrint(a, "retrying with -isysroot {s} failed too", .{s}) catch oom()
    else
        "no older Command Line Tools SDK was found to retry with";
    return std.fmt.allocPrint(a, "the system SDK's .tbd files use a format this linker's ld cannot parse (stale bundled ld vs a newer Xcode; {s}){s}", .{ tried, hint_fix }) catch oom();
}

test "SDKs sort by version, garbage below every version" {
    try std.testing.expect(sdkLess({}, "MacOSX26.sdk", "MacOSX26.5.sdk"));
    try std.testing.expect(!sdkLess({}, "MacOSX26.5.sdk", "MacOSX26.sdk"));
    try std.testing.expect(sdkLess({}, "notes.txt", "MacOSX0.sdk"));
}

test "the stale-linker signature is narrow" {
    try std.testing.expect(isStaleLdSystemLibFailure("ld: malformed file libSystem.tbd"));
    try std.testing.expect(!isStaleLdSystemLibFailure("undefined symbol _foo"));
    try std.testing.expect(hasNewArchToken("targets: [ arm64e.x1-macos ]"));
    try std.testing.expect(!hasNewArchToken("targets: [ arm64e-macos ]"));
}
