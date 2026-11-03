//! Where a boundary check belongs: the narrowing point of an `unknown` value and the `as` cast.
const hir = @import("../hir/types.zig");
const api = @import("gate_api.zig");
const gate_types = @import("gate_types.zig");
const HType = hir.HType;
const Gate = api.Gate;
const Node = api.Node;

pub fn isCheckable(t: *const HType) bool {
    return t.* == .number or t.* == .string or t.* == .boolean;
}

/// The type an `unknown` binding has been narrowed to at `node`, if it has.
pub fn narrowedTo(g: *Gate, node: *Node) ?*const HType {
    const symbol = g.symbolAt(node) orelse return null;
    if (symbol.value_decl == null) return null;
    const declared = gate_types.tsTypeToHType(g, g.typeOfSymbol(symbol));
    if (declared.* != .unknown) return null;
    const narrowed = gate_types.tsTypeToHType(g, g.typeAt(node));
    return if (narrowed.* == .unknown) null else narrowed;
}

/// The type an `as` cast asserts, when it differs from its operand's.
pub fn assertedBy(g: *Gate, cast: *Node) ?*const HType {
    const operand = gate_types.tsTypeToHType(g, g.typeAt(cast.data.as_expr.expr));
    const asserted = gate_types.tsTypeToHType(g, g.typeAt(cast));
    if (asserted.* == .unknown or hir.hTypeEquals(operand, asserted)) return null;
    return asserted;
}
