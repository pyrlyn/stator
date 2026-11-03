//! The CLI layer that needs nothing outside this directory. The drivers import the frontend, so
//! they are reachable only from the package root.
pub const crash = @import("crash.zig");
pub const failure = @import("failure.zig");
pub const terminal = @import("terminal.zig");
pub const config = @import("config.zig");
pub const args = @import("args.zig");
pub const env_file = @import("env_file.zig");
pub const outputs = @import("outputs.zig");
pub const compile_jobs = @import("compile_jobs.zig");
pub const toolchain = @import("toolchain.zig");
pub const link = @import("link.zig");
pub const library = @import("library.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
