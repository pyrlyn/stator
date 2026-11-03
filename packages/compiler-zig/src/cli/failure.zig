//! A build failure before any source position: a stable STA code and a message the user can act
//! on. `BuildError` and `StatorError` in the TypeScript CLI render the same way, so one type serves
//! both here.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Error = error{Failed};

pub const Failure = struct { code: []const u8, message: []const u8 };

/// Owns the one failure a run can stop on. An error union cannot carry the message, and every
/// caller wants exactly one.
pub const Reporter = struct {
    a: Allocator,
    failure: ?Failure = null,

    pub fn fail(self: *Reporter, code: []const u8, comptime fmt: []const u8, args: anytype) Error {
        const message = std.fmt.allocPrint(self.a, fmt, args) catch oom();
        self.failure = .{ .code = code, .message = message };
        return error.Failed;
    }
};

pub fn oom() noreturn {
    @panic("out of memory");
}
