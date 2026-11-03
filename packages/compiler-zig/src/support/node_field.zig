//! The field several AST node kinds share under one meaning (a declaration's initializer, the
//! object a member access reads), read from a table of kinds so each use is not its own switch.
const ast = @import("stator_ts").ast;

fn Field(comptime T: type) type {
    return if (@typeInfo(T) == .optional) T else ?T;
}

/// `arms` pairs a node kind with the name of the field that holds the value there; any other kind
/// yields null.
pub fn of(comptime T: type, node: *const ast.Node, comptime arms: anytype) Field(T) {
    inline for (arms) |arm| {
        if (node.data == arm[0]) return @field(@field(node.data, @tagName(arm[0])), arm[1]);
    }
    return null;
}

/// Whether `node` is one of `kinds`, written as a list where a switch would only say yes or no.
pub fn isAny(node: *const ast.Node, comptime kinds: anytype) bool {
    inline for (kinds) |kind| if (node.data == kind) return true;
    return false;
}
