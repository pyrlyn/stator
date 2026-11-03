//! Class declarations, specialized or not: layout, members in declaration order, the constructor
//! with its field initializers after `super()`, and the vtable.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const StmtList = c.StmtList;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const api = c.api;
const gt = c.gt;
const H_UNDEFINED = c.H_UNDEFINED;
const H_STRING = c.H_STRING;
const captures = @import("captures.zig");
const RECEIVER = captures.RECEIVER_NAME;
const expressions = @import("expressions.zig");
const functions = @import("functions.zig");
const members = @import("members.zig");
const assign = @import("assign.zig");
const calls = @import("calls.zig");
const specialize = @import("specialize.zig");
const module_names = @import("module_names.zig");
const generics = @import("../frontend/generics.zig");
const Substitution = generics.Substitution;
const ClassSpecialization = specialize.ClassSpecialization;
const lowerExpression = expressions.lowerExpression;
const typeAt = expressions.typeAt;

pub const Spec = struct {
    name: []const u8,
    substitution: *const Substitution,
    statics_only: bool,
};

fn renamed(l: *Lower, t: *const HType, name: []const u8) *const HType {
    const o = t.object;
    return l.hObject(name, o.fields, o.methods, o.bases, o.namespace);
}

fn substituteObject(l: *Lower, t: *const HType, substitution: *const Substitution) *const HType {
    const o = t.object;
    return l.hObject(o.name, expressions.substituteFields(l, o.fields, substitution), expressions.substituteFields(l, o.methods, substitution), o.bases, o.namespace);
}

pub fn lowerClassSpecialization(l: *Lower, spec: ClassSpecialization, b: *Scope) E!Statement {
    const applied: Spec = .{ .name = spec.name, .substitution = spec.substitution, .statics_only = spec.statics_only };
    if (spec.statics_only) return lowerClassAs(l, spec.declaration, b, applied);
    const inner = b.child();
    specialize.bindSubstitution(l, inner, spec.substitution);
    return lowerClassAs(l, spec.declaration, inner, applied);
}

pub fn lowerGenericClassDeclaration(l: *Lower, node: *Node, mine: []const ClassSpecialization, b: *Scope) E![]const Statement {
    const carrier: ClassSpecialization = .{
        .name = if (node.data.class.name) |n| api.text(n) orelse "" else "",
        .declaration = node,
        .substitution = l.create(Substitution{}),
        .statics_only = true,
    };
    b.set(carrier.name, classSpecType(l, carrier));
    var lowered: StmtList = .empty;
    l.push(&lowered, try lowerClassSpecialization(l, carrier, b));
    for (mine) |spec| {
        if (!spec.statics_only) l.push(&lowered, try lowerClassSpecialization(l, spec, b));
    }
    return lowered.items;
}

pub fn classSpecType(l: *Lower, spec: ClassSpecialization) *const HType {
    if (spec.declaration.data.class.name == null) return c.hUnknown(false);
    const self = gt.declaredTypeOf(l.g, spec.declaration) orelse return c.hUnknown(false);
    const t = gt.tsTypeToHType(l.g, self);
    return if (t.* == .object) substituteObject(l, t, spec.substitution) else c.hUnknown(false);
}

fn abstractMemberStub(l: *Lower, member: *Node, receiver: *const HType, b: *Scope) *const N.FunctionExpr {
    const span = l.span(member);
    const inner = b.functionScope();
    var params: std.ArrayList(N.Parameter) = .empty;
    l.push(&params, N.Parameter{ .name = RECEIVER, .type = receiver, .span = l.makeSpan(member.start, member.start) });
    inner.set(RECEIVER, receiver);
    const f = member.data.func;
    for (f.params) |param| _ = functions.bindOneParameter(l, param, typeAt(l, param, b), inner, null, &params);
    const declared = typeAt(l, member, b);
    const param_types = l.a.alloc(*const HType, params.items.len) catch c.oom();
    for (params.items, param_types) |p, *slot| slot.* = p.type;
    const t = l.hFunction(param_types, if (declared.* == .@"fn") declared.@"fn".ret else H_UNDEFINED);
    const name: ?[]const u8 = if (f.name != null and f.name.?.data == .identifier) f.name.?.data.identifier else null;
    const message = l.string(span, l.fmt("abstract method '{s}' has no implementation", .{name orelse "anonymous"}));
    const thrown = l.ex(.error_new, .{ .type = N.errorHType(.TypeError), .span = span, .ctor = .TypeError, .arg = message });
    const body = l.block(span, l.dupe(Statement, &.{l.st(.throw_statement, .{ .type = H_UNDEFINED, .span = span, .value = thrown })}));
    return l.create(N.FunctionExpr{
        .type = t,
        .span = span,
        .name = name,
        .params = params.items,
        .body = body,
        .is_async = false,
        .is_generator = false,
        .env_vars = &.{},
        .captures = &.{},
        .needs_env = false,
        .provenance = functions.provenanceOf(f, params.items, t),
    });
}

const Nodes = std.ArrayList(*Node);

const Parts = struct {
    initializers: Nodes = .empty,
    ctor: ?*Node = null,
    methods: Nodes = .empty,
    static_accessors: Nodes = .empty,
    statics: Nodes = .empty,
    abstract_stubs: Nodes = .empty,
    static_blocks: Nodes = .empty,
    /// The static fields between static blocks, which run after the block before them.
    field_runs: std.ArrayList(Nodes) = .empty,
};

fn hasBody(member: *const Node) bool {
    return member.data.func.body != null;
}

fn isAccessor(member: *const Node) bool {
    return api.isGetAccessor(member) or api.isSetAccessor(member);
}

fn sortMembers(l: *Lower, node: *const Node) Parts {
    var parts: Parts = .{};
    var run: Nodes = .empty;
    for (node.data.class.members) |member| {
        if (member.data == .static_block) {
            l.push(&parts.field_runs, run);
            run = .empty;
        } else if (member.data == .property_decl and gt.isStaticMember(member)) {
            l.push(&run, member);
        }
    }
    l.push(&parts.field_runs, run);
    for (node.data.class.members) |member| {
        const is_method = api.isMethodDeclaration(member);
        if ((is_method or isAccessor(member)) and !hasBody(member) and gt.hasAbstractModifier(member)) {
            l.push(&parts.abstract_stubs, member);
            continue;
        }
        if (gt.isStaticMember(member) and isAccessor(member)) {
            l.push(&parts.static_accessors, member);
        } else if (gt.isStaticMember(member) and (member.data == .property_decl or is_method)) {
            l.push(&parts.statics, member);
        } else if (member.data == .property_decl) {
            if (member.data.property_decl.init != null) l.push(&parts.initializers, member);
        } else if (api.isConstructor(member)) {
            if (hasBody(member)) parts.ctor = member;
        } else if (member.data == .static_block) {
            l.push(&parts.static_blocks, member);
        } else if ((is_method and hasBody(member)) or isAccessor(member)) {
            l.push(&parts.methods, member);
        }
    }
    return parts;
}

fn selfType(l: *Lower, node: *Node) ?*c.Type {
    if (api.isClassExpression(node)) {
        const signatures = l.g.constructSignatures(l.g.typeAt(node));
        return if (signatures.len > 0) l.g.returnType(signatures[0]) else null;
    }
    if (node.data.class.name == null) return l.g.typeAt(node);
    return gt.declaredTypeOf(l.g, node);
}

fn renameBase(l: *Lower, node: *Node, name: []const u8) []const u8 {
    for (gt.ancestry(l.g, node)) |candidate| {
        const display = gt.classDisplayName(candidate) orelse continue;
        if (!c.eql(display, name)) continue;
        return l.hirNameOf(candidate) orelse name;
    }
    return name;
}

fn lowerStatics(l: *Lower, parts: *const Parts, self_name: []const u8, b: *Scope, statics: *std.ArrayList(*const N.Declaration)) E!void {
    for (parts.statics.items) |member| b.set(members.staticName(l, self_name, members.declaredMemberName(l, member)), typeAt(l, member, b));
    for (parts.static_accessors.items) |member| {
        const is_get = api.isGetAccessor(member);
        const key = l.accessorName(if (is_get) .get else .set, members.declaredMemberName(l, member));
        const t = if (is_get) l.hFunction(&.{}, H_UNDEFINED) else l.hFunction(l.dupe(*const HType, &.{typeAt(l, member, b)}), H_UNDEFINED);
        b.set(members.staticName(l, self_name, key), t);
    }
    const first_run = if (parts.field_runs.items.len > 0) parts.field_runs.items[0].items else &.{};
    for (parts.statics.items) |member| {
        const is_method = api.isMethodDeclaration(member);
        if (is_method and !hasBody(member)) continue;
        const name = members.staticName(l, self_name, members.declaredMemberName(l, member));
        const at = l.span(member);
        var value: Expression = undefined;
        if (is_method) {
            value = .{ .function = try functions.lowerFunction(l, member, b) };
        } else if (member.data.property_decl.init == null or std.mem.indexOfScalar(*Node, first_run, member) == null) {
            value = l.undef(at);
        } else {
            value = try lowerExpression(l, member.data.property_decl.init.?, b);
        }
        const declared = if (is_method) value.getType() else typeAt(l, member, b);
        l.push(statics, l.create(N.Declaration{ .type = declared, .span = at, .name = name, .decl_kind = if (is_method) .@"const" else .let, .value = value }));
        b.set(name, declared);
    }
    for (parts.static_accessors.items) |member| {
        const half: H.AccessorKind = if (api.isGetAccessor(member)) .get else .set;
        const name = members.staticName(l, self_name, l.accessorName(half, members.declaredMemberName(l, member)));
        const at = l.span(member);
        const value = try functions.lowerFunction(l, member, b);
        const param_types = l.a.alloc(*const HType, value.params.len) catch c.oom();
        for (value.params, param_types) |p, *slot| slot.* = p.type;
        const fn_type = l.hFunction(param_types, H_UNDEFINED);
        const copy = l.create(value.*);
        copy.type = fn_type;
        copy.provenance = functions.provenanceOf(member.data.func, value.params, fn_type);
        l.push(statics, l.create(N.Declaration{ .type = fn_type, .span = at, .name = name, .decl_kind = .@"const", .value = .{ .function = copy } }));
        b.set(name, fn_type);
    }
}

fn baseName(l: *Lower, node: *Node, spec: ?Spec) E!?[]const u8 {
    const base_decl = gt.baseClassOf(l.g, node) orelse return null;
    const base_text: ?[]const u8 = if (base_decl.data.class.name) |n| api.text(n) else null;
    if (specialize.isGenericClass(base_decl) and spec == null) {
        const tuple = gt.heritageTuple(l.g, base_decl, node) orelse return l.internal(node, "STA4062", "a generic base with no complete tuple reached the lowering");
        for (tuple) |t| if (H.hasTypeParam(t)) return l.internal(node, "STA4062", "a generic base with no complete tuple reached the lowering");
        return H.specializationName(l.a, base_text orelse "", tuple) catch c.oom();
    }
    return if (spec == null) members.hirClassName(l, base_decl) else base_text;
}

fn vtableOf(l: *Lower, node: *Node, layout: *const HType, spec: ?Spec, display_name: []const u8) []const N.VtableEntry {
    if (spec != null and spec.?.statics_only) return &.{};
    var out: std.ArrayList(N.VtableEntry) = .empty;
    for (layout.object.methods) |m| {
        if (members.isPrivateMemberName(m.name)) continue;
        var declaring = layout.object.name;
        if (gt.methodDeclaringClass(l.g, node, m.name)) |decl| {
            if (decl.data.class.type_params.items.len > 0 and api.isClassDeclaration(decl)) {
                declaring = gt.baseDescriptorName(l.g, decl, node);
            } else {
                declaring = l.hirNameOf(decl) orelse (if (decl.data.class.name) |n| api.text(n) orelse layout.object.name else layout.object.name);
            }
        }
        const specialized = spec != null and !spec.?.statics_only and c.eql(declaring, display_name);
        l.push(&out, N.VtableEntry{ .name = m.name, .class_name = if (specialized) spec.?.name else declaring });
    }
    return out.items;
}

fn constructorOf(l: *Lower, node: *Node, parts: *const Parts, layout: *const HType, base: ?[]const u8, display_name: []const u8, b: *Scope) E!N.ClassMethod {
    const info = l.capturesFor(l.sf).get(node);
    var receiver_needed = false;
    if (info) |x| for (x.env_vars) |name| {
        receiver_needed = receiver_needed or c.eql(name, RECEIVER);
    };
    const lowered = if (parts.ctor) |ctor| try functions.lowerFunctionWith(l, ctor, b, layout) else synthesizedConstructor(l, node, layout, base, receiver_needed);
    const prologue = try lowerFieldInitializers(l, parts.initializers.items, layout, b, display_name);
    const statements = lowered.body.statements;
    var after_super: usize = 0;
    for (statements, 0..) |statement, index| {
        if (statement == .super_call) {
            after_super = index + 1;
            break;
        }
    }
    var joined: StmtList = .empty;
    l.a_appendAll(&joined, statements[0..after_super]);
    l.a_appendAll(&joined, prologue);
    l.a_appendAll(&joined, statements[after_super..]);
    const body = l.create(lowered.body.*);
    body.statements = joined.items;
    const copy = l.create(lowered.*);
    copy.body = body;
    return .{ .name = "constructor", .@"fn" = copy };
}

pub fn lowerClass(l: *Lower, node: *Node, b: *Scope) E!Statement {
    return lowerClassAs(l, node, b, null);
}

fn lowerClassAs(l: *Lower, node: *Node, b: *Scope, spec: ?Spec) E!Statement {
    const span = l.span(node);
    const display = gt.classDisplayName(node);
    const self: ?*c.Type = if (display != null) selfType(l, node) else null;
    const t: ?*const HType = if (self) |x| gt.tsTypeToHType(l.g, x) else null;
    if (display == null or t == null or t.?.* != .object) return l.internal(node, "STA4062", "not a class instance the type model describes");
    const display_name = display.?;
    const declared = t.?;
    const statics_only = spec != null and spec.?.statics_only;
    if (spec == null) {
        const binding = if (api.isClassDeclaration(node)) module_names.declaredBindingName(node) orelse display_name else display_name;
        l.setHirName(node, b.declare(binding, declared));
    }
    const self_name = if (spec != null and !statics_only) spec.?.name else l.hirNameOf(node) orelse display_name;
    var layout: *const HType = declared;
    if (spec) |s| {
        if (!s.statics_only) layout = renamed(l, substituteObject(l, declared, s.substitution), s.name);
    } else {
        const o = declared.object;
        const bases = l.a.alloc([]const u8, o.bases.len) catch c.oom();
        for (o.bases, bases) |name, *slot| slot.* = renameBase(l, node, name);
        layout = l.hObject(self_name, o.fields, o.methods, bases, o.namespace);
    }
    var fields: std.ArrayList(N.Parameter) = .empty;
    if (!statics_only) for (layout.object.fields) |field| {
        var at: *const Node = node;
        for (node.data.class.members) |member| {
            if (members.memberDeclaresName(l, member, field.name, display_name)) {
                at = member;
                break;
            }
        }
        l.push(&fields, N.Parameter{ .name = field.name, .type = field.type, .span = l.span(at) });
    };
    var parts = sortMembers(l, node);
    if (spec != null and !statics_only) {
        parts.statics = .empty;
        parts.static_accessors = .empty;
    }
    if (statics_only) {
        parts.methods = .empty;
        parts.abstract_stubs = .empty;
        parts.static_blocks = .empty;
    }
    var statics: std.ArrayList(*const N.Declaration) = .empty;
    try lowerStatics(l, &parts, self_name, b, &statics);
    var methods: std.ArrayList(N.ClassMethod) = .empty;
    for (parts.methods.items) |method| {
        const lowered = try functions.lowerFunctionWith(l, method, b, layout);
        l.push(&methods, N.ClassMethod{ .name = members.memberFunctionName(l, method, display_name), .@"fn" = lowered });
    }
    for (parts.abstract_stubs.items) |member| {
        l.push(&methods, N.ClassMethod{ .name = members.memberFunctionName(l, member, display_name), .@"fn" = abstractMemberStub(l, member, layout, b) });
    }
    const base = try baseName(l, node, spec);
    var ctor: ?N.ClassMethod = null;
    if ((parts.ctor != null or parts.initializers.items.len > 0 or base != null) and !statics_only) {
        ctor = try constructorOf(l, node, &parts, layout, base, display_name, b);
    }
    const class_decl = l.st(.class_declaration, .{
        .type = H_UNDEFINED,
        .span = span,
        .name = self_name,
        .base = base,
        .fields = fields.items,
        .ctor = ctor,
        .methods = methods.items,
        .statics = statics.items,
        .vtable = vtableOf(l, node, layout, spec, display_name),
    });
    if (parts.static_blocks.items.len == 0) return class_decl;
    var statements: StmtList = .empty;
    l.push(&statements, class_decl);
    for (parts.static_blocks.items, 0..) |block, index| {
        const lowered = try assign.lowerBlock(l, block.data.static_block.body, b.child());
        l.push(&statements, Statement{ .block = lowered });
        if (index + 1 >= parts.field_runs.items.len) continue;
        for (parts.field_runs.items[index + 1].items) |field| {
            const init = field.data.property_decl.init orelse continue;
            const value = try lowerExpression(l, init, b);
            l.push(&statements, l.st(.assignment, .{
                .type = typeAt(l, field, b),
                .span = l.span(field),
                .target = members.staticName(l, self_name, members.declaredMemberName(l, field)),
                .value = value,
            }));
        }
    }
    return l.st(.block, .{ .type = H_UNDEFINED, .span = span, .flatten = true, .statements = statements.items });
}

pub fn lowerSuperCall(l: *Lower, call: *Node, statement: *Node, b: *Scope) E!Statement {
    const span = l.span(statement);
    const self = b.get(RECEIVER);
    const base: ?[]const u8 = if (self != null and self.?.* == .object and self.?.object.bases.len > 0) self.?.object.bases[0] else null;
    if (base == null) return l.internal(statement, "STA4064", "super call outside a derived constructor");
    const args = try calls.lowerArguments(l, call.data.call.args, b, call);
    return l.st(.super_call, .{ .type = H_UNDEFINED, .span = span, .class_name = base.?, .receiver = l.ident(self.?, span, RECEIVER), .args = args });
}

fn lowerFieldInitializers(l: *Lower, nodes: []const *Node, self: *const HType, b: *Scope, owner: []const u8) E![]const Statement {
    const inner = b.child();
    inner.set(RECEIVER, self);
    var statements: StmtList = .empty;
    for (nodes) |member| {
        const init = member.data.property_decl.init orelse continue;
        const span = l.span(member);
        const field = gt.privateMethodName(l.g, owner, members.declaredMemberName(l, member));
        const slot = H.fieldSlot(&self.object, field);
        const value = lowerExpression(l, init, inner);
        if (slot == null) {
            return l.internal(member, "STA4060", l.fmt("no field '{s}' on {s}", .{ field, self.object.name }));
        }
        const lowered = try value;
        l.push(&statements, l.st(.field_assignment, .{ .type = lowered.getType(), .span = span, .target = l.ident(self, span, RECEIVER), .field = field, .slot = @intCast(slot.?), .value = lowered }));
    }
    return statements.items;
}

fn nearestConstructor(l: *Lower, declaration: *Node) ?*Node {
    for (gt.lineage(l.g, declaration)) |class| {
        for (class.data.class.members) |member| {
            if (api.isConstructor(member) and hasBody(member)) return member;
        }
    }
    return null;
}

fn synthesizedConstructor(l: *Lower, node: *Node, self: *const HType, base: ?[]const u8, with_receiver: bool) *const N.FunctionExpr {
    const span = l.span(node);
    var forwarded: std.ArrayList(N.Parameter) = .empty;
    if (base != null) if (nearestConstructor(l, node)) |ctor| for (ctor.data.func.params, 0..) |p, index| {
        const pattern = p.data.param.name;
        const name = if (pattern.data == .identifier) pattern.data.identifier else l.fmt("_arg{d}", .{index});
        l.push(&forwarded, N.Parameter{ .name = name, .type = gt.tsTypeToHType(l.g, l.g.typeAt(p)), .span = span });
    };
    var statements: StmtList = .empty;
    if (base) |class_name| {
        const args = l.a.alloc(Expression, forwarded.items.len) catch c.oom();
        for (forwarded.items, args) |p, *slot| slot.* = l.ident(p.type, span, p.name);
        l.push(&statements, l.st(.super_call, .{ .type = H_UNDEFINED, .span = span, .class_name = class_name, .receiver = l.ident(self, span, RECEIVER), .args = args }));
    }
    var params: std.ArrayList(N.Parameter) = .empty;
    l.push(&params, N.Parameter{ .name = RECEIVER, .type = self, .span = span });
    l.a_appendAll(&params, forwarded.items);
    var dynamic = false;
    const param_types = l.a.alloc(*const HType, params.items.len) catch c.oom();
    for (params.items, param_types, 0..) |p, *slot, index| {
        slot.* = p.type;
        dynamic = dynamic or (index > 0 and H.hTypeHasUnknown(p.type));
    }
    return l.create(N.FunctionExpr{
        .type = l.hFunction(param_types, H_UNDEFINED),
        .span = span,
        .params = params.items,
        .body = l.block(span, statements.items),
        .is_async = false,
        .is_generator = false,
        .env_vars = if (with_receiver) l.dupe([]const u8, &.{RECEIVER}) else &.{},
        .captures = &.{},
        .needs_env = false,
        .provenance = if (dynamic) .dynamic else .typed,
    });
}
