//! The interpreter tier (docs/INTERPRETER.md): `eval`, `new Function` and the `js`-mode code the
//! compiler hands it, run by Zig code inside the runtime.
pub const parse = @import("parse.zig");
pub const rt = @import("rt.zig");
pub const interp = @import("interp.zig");
pub const vm = @import("vm.zig");

test {
    _ = parse;
    _ = @import("compile.zig");
    _ = interp;
}

test "the runtime links" {
    rt.c.jsrt_init();
    const s = rt.string("héllo");
    try @import("std").testing.expect(rt.is(s, rt.c.JSRT_TAG_STRING));
    try @import("std").testing.expectEqual(@as(f64, 5), rt.c.jsrt_to_number(rt.c.jsrt_get_prop(s, "length", null)));
}
