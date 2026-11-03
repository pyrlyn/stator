//! The tuples the lowering specializes on. `gate_generics.zig` answers whether a use is generic;
//! this adds what the gate never reads: which declaration, under which key, with which substitution.
const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const gate = @import("gate_generics.zig");
const H = @import("../hir/types.zig");
const Gate = api.Gate;
const Node = api.Node;
const Type = api.Type;
const HType = H.HType;
const oom = api.oom;

pub const Substitution = gate.Substitution;
pub const Generic = gate.Generic;
pub const genericCall = gate.genericCall;

pub const ClassGeneric = struct {
    declaration: *Node,
    type_arguments: []const *const HType,
    substitution: *Substitution,
};

pub fn genericArrowPrintName(key: []const u8) []const u8 {
    const at = std.mem.indexOfScalar(u8, key, '@') orelse return key;
    return key[0..at];
}

fn fresh(g: *Gate) *Substitution {
    const out = g.a.create(Substitution) catch oom();
    out.* = .{};
    return out;
}

fn instantiateAtParameter(g: *Gate, generic: *Node, key: []const u8, argument: *Node, outer_call: *Node) ?Generic {
    if (!gate.instantiatesAtParameter(g, generic, argument, outer_call)) return null;
    const outer = g.resolvedSignature(outer_call) orelse return null;
    const index = std.mem.indexOfScalar(*Node, api.nodes(outer_call.data.call.args), argument) orelse return null;
    if (index >= outer.params.len) return null;
    const parameter_type = g.parameterType(outer, index);
    const substitution = fresh(g);
    gate.bindReferenceArguments(g, &.{ g.typeAt(argument), parameter_type }, substitution);
    var seen: gate.Seen = .empty;
    gate.unify(g, types.tsTypeToHType(g, g.typeAt(generic)), types.tsTypeToHType(g, parameter_type), substitution, &seen);
    return completed(g, generic, key, substitution);
}

/// The instantiation once the substitution holds every argument it can infer; defaults fill the rest.
fn completed(g: *Gate, declaration: *Node, key: []const u8, substitution: *Substitution) Generic {
    const type_arguments = gate.finishTuple(g, gate.parameterDefaults(g, g.signatureOf(declaration).tparams), substitution);
    return .{ .declaration = declaration, .key = key, .type_arguments = type_arguments, .substitution = substitution };
}

fn inlineGeneric(g: *Gate, argument: *Node) ?Generic {
    gate.inlineGenericTuple(g, argument) orelse return null;
    const unwrapped = api.skipParens(argument);
    const current = api.outermostParen(unwrapped);
    return instantiateAtParameter(g, unwrapped, gate.positionGenericKey(g, unwrapped, null), current, current.parent.?);
}

pub fn genericArgumentTuple(g: *Gate, argument: *Node, outer_call: *Node) ?Generic {
    if (!api.isIdentifier(argument)) return inlineGeneric(g, argument);
    const generic = gate.genericAliasTarget(g, argument) orelse return null;
    const key = gate.keyOf(g, generic) orelse return null;
    return instantiateAtParameter(g, generic, key, argument, outer_call);
}

pub fn genericValue(g: *Gate, node: *Node) ?Generic {
    if (!gate.genericValueInstantiation(g, node)) return null;
    const target = gate.genericAliasTarget(g, node) orelse return null;
    const key = gate.keyOf(g, target) orelse return null;
    return completed(g, target, key, fresh(g));
}

fn defaultTypeOf(g: *Gate, parameter: *const Node) ?*const HType {
    const declared = parameter.data.type_param.default orelse return null;
    return types.tsTypeToHType(g, g.typeFromNode(declared));
}

pub fn genericNewInstantiation(g: *Gate, created: *Node) ?ClassGeneric {
    const x = created.data.new_expr;
    const target = gate.newTarget(g, created) orelse return null;
    const parameters = target.class.data.class.type_params.items;
    if (parameters.len == 0) return null;
    const args = api.nodes(x.args);
    const substitution = fresh(g);
    gate.bindReferenceArguments(g, gate.argumentTypesOf(g, args, created), substitution);
    for (x.type_args.items, 0..) |argument, index| {
        if (index >= parameters.len) break;
        const name = api.text(parameters[index].data.type_param.name) orelse "";
        if (substitution.lookup(name) == null) substitution.put(g, name, types.tsTypeToHType(g, g.typeFromNode(argument)));
    }
    if (target.constructor) |constructor| {
        const resolved = g.resolvedSignature(created);
        gate.unifyCallArguments(g, args, g.signatureOf(constructor).params, if (resolved) |r| r.params else &.{}, substitution);
    }
    const defaults = g.a.alloc(gate.Parameter, parameters.len) catch oom();
    for (parameters, defaults) |parameter, *slot| {
        slot.* = .{ .name = api.text(parameter.data.type_param.name) orelse "", .default = defaultTypeOf(g, parameter) };
    }
    return .{ .declaration = target.class, .type_arguments = gate.finishTuple(g, defaults, substitution), .substitution = substitution };
}

pub fn classReferenceTuple(g: *Gate, declaration: *Node, t: *Type) ?[]const *const HType {
    if (api.valueDeclaration(api.typeSymbol(t)) != declaration) return null;
    const parameters = declaration.data.class.type_params.items;
    const args = gate.referenceArguments(t) orelse return null;
    if (parameters.len == 0 or args.len != parameters.len) return null;
    const out = g.a.alloc(*const HType, args.len) catch oom();
    for (args, out) |arg, *slot| slot.* = types.tsTypeToHType(g, arg);
    return out;
}
