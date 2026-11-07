//! The interpreter tier (docs/INTERPRETER.md): `eval`, `new Function` and the `js`-mode code the
//! compiler hands it, run by Zig code inside the runtime.
/// The runtime's C ABI, as the VM calls it.
pub const c = @import("jsrt");
pub const parse = @import("parse.zig");
pub const scope = @import("scope.zig");
pub const bytecode = @import("bytecode.zig");
pub const compile = @import("compile.zig");
pub const realm = @import("realm.zig");
pub const vm = @import("vm.zig");

test {
    _ = parse;
    _ = scope;
    _ = bytecode;
    _ = compile;
    _ = vm;
}
