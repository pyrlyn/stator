//! The interpreter tier (docs/INTERPRETER.md): `eval`, `new Function` and the `js`-mode code the
//! compiler hands it, run by Zig code inside the runtime.
pub const parse = @import("parse.zig");

test {
    _ = parse;
}
