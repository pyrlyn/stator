//! `std/encoding` backings (docs/STD.md §5): bytes to text. Text to bytes needs no backing — the
//! surface reads UTF-16 code units with `charCodeAt` — but a string can only be MADE from bytes
//! at the C-string edge (`String.fromCharCode` is not in the subset), so every bytes-to-text
//! direction parks its answer here for the emitter's UTF-8 copy.

const std = @import("std");
const root = @import("jsrt_std.zig");

const Kind = enum(u8) { utf8 = 0, latin1 = 1, base64 = 2, base64url = 3, hex = 4 };

fn latin1Length(bytes: []const u8) usize {
    var n: usize = bytes.len;
    for (bytes) |b| n += @intFromBool(b >= 0x80);
    return n;
}

/// The caller's `Uint8Array` (in place, docs/FFI.md §2) as text of `kind`, parked for `jsrtStdResult`. For `utf8` and `latin1`
/// the surface sends only NUL-free runs (a NUL would end the C string); the emitter's copy
/// turns each maximal invalid UTF-8 subsequence into one U+FFFD, as Node's decoder does.
export fn jsrt_std_encoding_to_text(kind: f64, data: [*]const u8, len: usize) f64 {
    const k = std.enums.fromInt(Kind, root.intIn(kind, 0, 4) orelse return root.fail("EINVAL")) orelse return root.fail("EINVAL");
    const bytes = data[0..len];
    const a = root.allocator;
    const text: [:0]u8 = switch (k) {
        .utf8 => a.dupeSentinel(u8, bytes, 0),
        .latin1 => blk: {
            const out = a.allocSentinel(u8, latin1Length(bytes), 0) catch return root.fail("ENOMEM");
            var i: usize = 0;
            for (bytes) |b| {
                if (b < 0x80) {
                    out[i] = b;
                    i += 1;
                } else {
                    out[i] = 0xC0 | (b >> 6);
                    out[i + 1] = 0x80 | (b & 0x3F);
                    i += 2;
                }
            }
            break :blk out;
        },
        .base64, .base64url => blk: {
            const codec = if (k == .base64) std.base64.standard.Encoder else std.base64.url_safe_no_pad.Encoder;
            const out = a.allocSentinel(u8, codec.calcSize(bytes.len), 0) catch return root.fail("ENOMEM");
            _ = codec.encode(out, bytes);
            break :blk out;
        },
        .hex => blk: {
            const digits = "0123456789abcdef";
            const out = a.allocSentinel(u8, bytes.len * 2, 0) catch return root.fail("ENOMEM");
            for (bytes, 0..) |b, i| {
                out[2 * i] = digits[b >> 4];
                out[2 * i + 1] = digits[b & 0x0F];
            }
            break :blk out;
        },
    } catch return root.fail("ENOMEM");
    root.setResult(text);
    return 0;
}
