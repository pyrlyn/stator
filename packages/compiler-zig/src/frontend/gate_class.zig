//! Classes: formation, heritage, member kinds, and the derived-constructor flow rule.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const fn_ = @import("gate_function.zig");
const literal = @import("gate_literal.zig");
const member_ = @import("gate_member.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const accept = api.accept;
const eql = api.eql;
const oom = api.oom;

const NameSet = std.StringHashMapUnmanaged(void);

fn classOf(declaration: *const Node) *const api.ast.Class {
    return declaration.data.class;
}

fn isGeneric(declaration: *const Node) bool {
    return classOf(declaration).type_params.items.len > 0;
}

fn isAccessor(n: *const Node) bool {
    return api.isGetAccessor(n) or api.isSetAccessor(n);
}

fn memberName(m: *const Node) ?*Node {
    return api.declarationName(m);
}

fn isNamed(name: *const Node) bool {
    return api.isIdentifier(name) or name.data == .private_name;
}

fn isPrivate(name: ?*const Node) bool {
    return name != null and name.?.data == .private_name;
}

fn classMemberStaticName(g: *Gate, m: *const Node) ?[]const u8 {
    const name = memberName(m) orelse return null;
    if (isNamed(name)) return api.text(name);
    if (name.data == .computed_name) return types.computedKeyStaticName(g, name);
    return null;
}

/// The class first, then its bases: a reported collision names the most derived class.
fn reversedAncestry(g: *Gate, declaration: *Node) []*Node {
    const chain = types.ancestry(g, declaration);
    std.mem.reverse(*Node, chain);
    return chain;
}

fn ancestorMembers(g: *Gate, declaration: *Node, want_static: bool) NameSet {
    var names: NameSet = .empty;
    for (reversedAncestry(g, declaration)[1..]) |base| {
        for (classOf(base).members) |m| {
            const name = memberName(m);
            const declared: ?[]const u8 = if (name != null and !isPrivate(name) and types.isStaticMember(m) == want_static)
                (if (api.isIdentifier(name.?)) api.text(name.?) else classMemberStaticName(g, m))
            else
                null;
            if (declared) |d| {
                names.put(g.a, d, {}) catch oom();
            } else if (!want_static and api.isMethodDeclaration(m) and !types.isStaticMember(m)) {
                const method = types.instanceMethodName(g, m);
                if (method != null and eql(method.?, types.iterator_method_name)) {
                    names.put(g.a, types.iterator_method_name, {}) catch oom();
                }
            }
        }
    }
    return names;
}

fn sameStaticName(g: *Gate, m: *const Node, name: []const u8) bool {
    const other = classMemberStaticName(g, m);
    return other != null and eql(other.?, name);
}

fn inheritedShadowIsSameKind(g: *Gate, m: *Node, declaration: *Node) bool {
    const name = types.instanceMethodName(g, m) orelse return false;
    const member_name = memberName(m) orelse return false;
    if (isPrivate(member_name) or (!api.isIdentifier(member_name) and classMemberStaticName(g, m) == null)) return false;
    const want_static = types.isStaticMember(m);
    var seen: std.ArrayList(*Node) = .empty;
    var cursor = types.baseClassOf(g, declaration);
    while (cursor) |current| : (cursor = types.baseClassOf(g, current)) {
        if (std.mem.indexOfScalar(*Node, seen.items, current) != null) break;
        seen.append(g.a, current) catch oom();
        var found: ?*Node = null;
        for (classOf(current).members) |candidate| {
            const candidate_name = memberName(candidate) orelse continue;
            if (types.isStaticMember(candidate) != want_static or isPrivate(candidate_name)) continue;
            const spelled = if (api.isIdentifier(candidate_name)) api.text(candidate_name) else classMemberStaticName(g, candidate);
            if (spelled != null and eql(spelled.?, name)) {
                found = candidate;
                break;
            }
        }
        const target = found orelse continue;
        if (!want_static) return m.data == .property_decl and target.data == .property_decl;
        if (m.data == .property_decl and target.data == .property_decl) return true;
        if (api.isMethodDeclaration(m) and api.isMethodDeclaration(target)) return true;
        if (isAccessor(m) and isAccessor(target)) {
            var get = false;
            var set = false;
            for (classOf(declaration).members) |own| {
                if (!types.isStaticMember(own) or !sameStaticName(g, own, name)) continue;
                if (api.isGetAccessor(own)) get = true;
                if (api.isSetAccessor(own)) set = true;
            }
            return get and set;
        }
        return false;
    }
    return false;
}

pub fn classHasIndexSignature(g: *Gate, declaration: *Node) bool {
    for (reversedAncestry(g, declaration)) |current| {
        for (classOf(current).members) |m| if (m.data == .index_sig) return true;
    }
    return false;
}

fn privateNameCollision(g: *Gate, declaration: *Node) ?[]const u8 {
    var seen: NameSet = .empty;
    for (reversedAncestry(g, declaration)) |current| {
        const owner = if (classOf(current).name) |n| api.text(n) else null;
        const owner_name = owner orelse continue;
        for (classOf(current).members) |m| {
            const name = memberName(m);
            if (!isPrivate(name) or m.data != .property_decl or types.isStaticMember(m)) continue;
            const text = api.text(name.?) orelse continue;
            const key = g.fmt("{s}\n{s}", .{ owner_name, text });
            if (seen.contains(key)) return text;
            seen.put(g.a, key, {}) catch oom();
        }
    }
    return null;
}

fn privateStaticPairComplete(g: *Gate, m: *Node, declaration: *Node) bool {
    const m_name = memberName(m);
    if (!isPrivate(m_name)) return true;
    const name = api.text(m_name.?) orelse "";
    var get = false;
    var set = false;
    for (classOf(declaration).members) |own| {
        const own_name = memberName(own);
        if (!types.isStaticMember(own) or !isPrivate(own_name) or !api.identifierOrPrivateIs(own_name.?, name)) continue;
        if (api.isGetAccessor(own)) get = true;
        if (api.isSetAccessor(own)) set = true;
    }
    if (get and set) return true;
    const chain = reversedAncestry(g, declaration);
    if (chain.len < 2) return true;
    for (chain[0 .. chain.len - 1]) |base| {
        for (classOf(base).members) |candidate| {
            const candidate_name = memberName(candidate);
            if (isAccessor(candidate) and types.isStaticMember(candidate) and isPrivate(candidate_name) and api.identifierOrPrivateIs(candidate_name.?, name)) return false;
        }
    }
    return true;
}

fn accessorOverrideKeepsPair(g: *Gate, name: []const u8, declaration: *Node) bool {
    const base = types.baseClassOf(g, declaration) orelse return false;
    const inherited = types.accessorDeclaringClass(g, base, name) orelse return false;
    var get = false;
    var set = false;
    for (classOf(declaration).members) |m| {
        if (types.isStaticMember(m) or !sameStaticName(g, m, name)) continue;
        if (api.isGetAccessor(m)) get = true;
        if (api.isSetAccessor(m)) set = true;
    }
    return get == inherited.get and set == inherited.set;
}

const SuperCount = enum { zero, one, mixed };
const Flow = struct { fall: ?SuperCount, brk: ?SuperCount };

fn mergeSuper(a: ?SuperCount, b: ?SuperCount) ?SuperCount {
    if (a == null or b == null) return a orelse b;
    return if (a.? == b.?) a else .mixed;
}

fn isTopLevelSuperCall(stmt: *const Node) bool {
    if (stmt.data != .expr_stmt) return false;
    const e = stmt.data.expr_stmt.expr;
    return e.data == .call and e.data.call.callee.data == .super_expr;
}

const Scan = struct {
    found: bool = false,
    kind: enum { @"return", super_call, this_or_super },

    fn visit(s: *Scan, node: *Node) void {
        if (s.found) return;
        switch (s.kind) {
            .@"return" => {
                if (api.isFunctionLike(node) or api.isClassLike(node)) return;
                if (node.data == .return_stmt) {
                    s.found = true;
                    return;
                }
            },
            .super_call => {
                if (api.isClassLike(node)) return;
                if (node.data == .call and node.data.call.callee.data == .super_expr) {
                    s.found = true;
                    return;
                }
            },
            .this_or_super => {
                if (api.isFunctionDeclaration(node) or api.isFunctionExpression(node) or api.isClassLike(node)) return;
                if (node.data == .this_expr or node.data == .super_expr) {
                    s.found = true;
                    return;
                }
            },
        }
        api.ast.forEachChild(node, s, visit);
    }
};

fn contains(node: *Node, kind: @TypeOf(@as(Scan, undefined).kind)) bool {
    var scan = Scan{ .kind = kind };
    Scan.visit(&scan, node);
    return scan.found;
}

fn containsReturn(node: *Node) bool {
    return contains(node, .@"return");
}

fn nestedSuperCall(node: *Node) bool {
    return contains(node, .super_call);
}

pub fn readsThisOrSuper(node: *Node) bool {
    return contains(node, .this_or_super);
}

pub fn enclosingFunctionIsConstructor(node: *Node) bool {
    var cursor: ?*Node = node;
    while (cursor) |owner| : (cursor = owner.parent) {
        if (api.isSourceFile(owner)) return false;
        if (api.isFunctionLike(owner)) return api.isConstructor(owner);
    }
    return false;
}

fn checkCtorList(g: *Gate, statements: []const *Node, flexible: bool, entry: SuperCount) ?Flow {
    var count = entry;
    var breaks: ?SuperCount = null;
    for (statements) |stmt| {
        if (isTopLevelSuperCall(stmt)) {
            if (count != .zero) return null;
            for (api.nodes(stmt.data.expr_stmt.expr.data.call.args)) |arg| if (readsThisOrSuper(arg)) return null;
            count = .one;
            continue;
        }
        switch (stmt.data) {
            .break_stmt => |x| {
                if (x.label != null) return null;
                return .{ .fall = null, .brk = mergeSuper(breaks, count) };
            },
            .continue_stmt => return null,
            .return_stmt => {
                if (count != .one) return null;
                return .{ .fall = null, .brk = breaks };
            },
            .throw_stmt => return .{ .fall = null, .brk = breaks },
            else => {},
        }
        if (flexible and stmt.data == .block) {
            const inner = checkCtorList(g, stmt.data.block.stmts, flexible, count) orelse return null;
            breaks = mergeSuper(breaks, inner.brk);
            count = inner.fall orelse return .{ .fall = null, .brk = breaks };
            continue;
        }
        if (flexible and stmt.data == .if_stmt and !nestedSuperCall(stmt.data.if_stmt.cond)) {
            const x = stmt.data.if_stmt;
            if (count != .one and readsThisOrSuper(x.cond)) return null;
            const then_flow = checkCtorList(g, &.{x.then}, flexible, count) orelse return null;
            const else_flow: Flow = if (x.els) |els|
                checkCtorList(g, &.{els}, flexible, count) orelse return null
            else
                .{ .fall = count, .brk = null };
            breaks = mergeSuper(mergeSuper(breaks, then_flow.brk), else_flow.brk);
            count = mergeSuper(then_flow.fall, else_flow.fall) orelse return .{ .fall = null, .brk = breaks };
            continue;
        }
        if (flexible and stmt.data == .switch_stmt) {
            const x = stmt.data.switch_stmt;
            if (nestedSuperCall(x.expr) or (count != .one and readsThisOrSuper(x.expr))) return null;
            var has_default = false;
            for (x.clauses) |clause| {
                if (clause.data == .case_clause) {
                    const test_ = clause.data.case_clause.expr;
                    if (nestedSuperCall(test_) or (count != .one and readsThisOrSuper(test_))) return null;
                } else {
                    has_default = true;
                }
            }
            var fall: ?SuperCount = null;
            for (x.clauses, 0..) |_, index| {
                var chain: std.ArrayList(*Node) = .empty;
                for (x.clauses[index..]) |later| {
                    const body = if (later.data == .case_clause) later.data.case_clause.stmts else later.data.default_clause.stmts;
                    chain.appendSlice(g.a, body) catch oom();
                }
                const flow = checkCtorList(g, chain.items, flexible, count) orelse return null;
                fall = mergeSuper(fall, mergeSuper(flow.fall, flow.brk));
            }
            if (!has_default) fall = mergeSuper(fall, count);
            count = fall orelse return .{ .fall = null, .brk = breaks };
            continue;
        }
        if (nestedSuperCall(stmt)) return null;
        if (count != .one and (readsThisOrSuper(stmt) or containsReturn(stmt))) return null;
    }
    return .{ .fall = count, .brk = breaks };
}

fn derivedConstructorOrderOk(g: *Gate, ctor: *Node, declaration: *Node) bool {
    var flexible = true;
    for (classOf(declaration).members) |m| {
        if (m.data == .property_decl and !types.isStaticMember(m) and m.data.property_decl.init != null) flexible = false;
    }
    const body = ctor.data.func.body;
    const statements: []const *Node = if (body != null and body.?.data == .block) body.?.data.block.stmts else &.{};
    const exits = checkCtorList(g, statements, flexible, .zero) orelse return false;
    return exits.brk == null and (exits.fall == null or exits.fall.? == .one);
}

pub fn isClassAtModuleScope(node: *const Node) bool {
    var current = node;
    while (current.parent) |parent| {
        switch (parent.data) {
            .var_decl, .var_list, .var_stmt, .expr_stmt, .paren, .export_assign => current = parent,
            else => break,
        }
    }
    return current.parent != null and api.isSourceFile(current.parent.?);
}

fn genericBaseArgumentsAreConcrete(g: *Gate, declaration: *Node, base: *Node) bool {
    if (isGeneric(declaration) or !isClassAtModuleScope(declaration) or !isClassAtModuleScope(base)) return false;
    var arguments: []const *Node = &.{};
    for (classOf(declaration).heritage) |clause| {
        const h = clause.data.heritage_clause;
        if (h.tok == .kw_extends) {
            if (h.types.len > 0) arguments = api.typeArgs(h.types[0].data.expr_with_type_args.type_args);
            break;
        }
    }
    if (arguments.len != classOf(base).type_params.items.len) return false;
    const bound = member_.enclosingTypeParameterNames(g, declaration);
    for (arguments) |arg| {
        if (member_.mentionsUnboundParameter(g, types.tsTypeToHType(g, g.typeFromNode(arg)), bound)) return false;
    }
    return true;
}

fn gateHeritage(g: *Gate, declaration: *Node) Result {
    for (classOf(declaration).heritage) |clause| {
        const h = clause.data.heritage_clause;
        if (h.tok == .kw_implements) continue;
        if (h.types.len != 1) return g.notYet("extending other than exactly one class is not yet supported", 5);
        const base = types.baseClassOf(g, declaration) orelse {
            return g.notYet("extending anything but a class declaration is not yet supported", 5);
        };
        if (isGeneric(base) and !genericBaseArgumentsAreConcrete(g, declaration, base)) {
            return g.notYet("extending a generic class is not yet supported", 5);
        }
    }
    return accept;
}

fn nestedGenericIsScoped(g: *Gate, declaration: *Node) bool {
    const name_node = classOf(declaration).name orelse return false;
    const name = api.text(name_node) orelse return false;
    if (member_.enclosingTypeParameterNames(g, declaration).count() > 0) return false;
    const files = g.class_names.get(name) orelse return false;
    return files.items.len == 1;
}

fn genericNameIsModuleLocal(g: *Gate, declaration: *Node) bool {
    const name_node = classOf(declaration).name orelse return true;
    const name = api.text(name_node) orelse return true;
    const file = g.fileOf(declaration);
    const files = g.class_names.get(name) orelse return true;
    for (files.items) |declared_in| if (declared_in != file) return false;
    return true;
}

const Context = struct {
    declaration: *Node,
    inherited_instance: NameSet,
    inherited_static: NameSet,
};

fn gateAccessorMember(g: *Gate, m: *Node, ctx: *const Context) ?Result {
    const declaration = ctx.declaration;
    const name = memberName(m) orelse return null;
    const f = m.data.func;
    if (f.body == null and !types.hasAbstractModifier(m)) return g.notYet("an accessor with no body is not yet supported", 5);
    if (!isNamed(name) and classMemberStaticName(g, m) == null) return g.notYet("a computed accessor name is not yet supported", 5);
    if (types.isStaticMember(m)) {
        const static_ok = classMemberStaticName(g, m) orelse return g.notYet("a static #private accessor name is not yet supported", 5);
        const refusal = g.fmt("overriding the inherited member '{s}' is not yet supported", .{static_ok});
        if (name.data == .private_name) {
            return if (privateStaticPairComplete(g, m, declaration)) null else g.notYet(refusal, 5);
        }
        if (ctx.inherited_static.contains(static_ok) and !inheritedShadowIsSameKind(g, m, declaration)) return g.notYet(refusal, 5);
        return null;
    }
    if (name.data == .private_name) {
        const text = api.text(name) orelse "";
        const base = types.baseClassOf(g, declaration);
        if (base != null and types.accessorDeclaringClass(g, base.?, text) != null) {
            return g.notYet(g.fmt("overriding the inherited member '{s}' is not yet supported", .{text}), 5);
        }
        return null;
    }
    if (classMemberStaticName(g, m)) |override_name| {
        if (ctx.inherited_instance.contains(override_name)) {
            if (!accessorOverrideKeepsPair(g, override_name, declaration)) {
                return g.notYet(g.fmt("overriding the inherited member '{s}' is not yet supported", .{override_name}), 5);
            }
            if (!isClassAtModuleScope(declaration)) {
                return g.notYet("overriding a method in a class declared inside a function is not yet supported", 5);
            }
        }
    }
    return null;
}

fn gateMethodMember(g: *Gate, m: *Node, declaration: *Node) ?Result {
    const f = m.data.func;
    if (f.body == null) {
        if (types.hasAbstractModifier(m)) return null;
        const name = types.instanceMethodName(g, m);
        for (classOf(declaration).members) |other| {
            if (other == m or !api.isMethodDeclaration(other) or other.data.func.body == null) continue;
            const other_name = types.instanceMethodName(g, other);
            if ((name == null and other_name == null) or (name != null and other_name != null and eql(name.?, other_name.?))) return null;
        }
        return g.notYet("a method overload signature is not yet supported", 5);
    }
    if (f.asterisk) return fn_.generatorNotYet(g);
    if (m.mods.async) return g.notYet("an async method is not yet supported", 5);
    return null;
}

fn gateOneMember(g: *Gate, m: *Node, ctx: *const Context, constructors: *u32) ?Result {
    const declaration = ctx.declaration;
    if (isAccessor(m)) return gateAccessorMember(g, m, ctx);
    if (m.data == .index_sig or m.data == .semicolon_member) return null;
    if (m.data == .static_block) {
        return if (member_.staticBlockUsesSuper(g, m)) g.notYet("super in a static initialization block is not yet supported", 5) else null;
    }
    const name = memberName(m);
    if (name != null and !isNamed(name.?)) {
        const n = name.?;
        const global_iterator = n.data == .computed_name and types.isGlobalSymbolIteratorName(g, n);
        const static_name = if (n.data == .computed_name and !global_iterator) types.computedKeyStaticName(g, n) else null;
        const iterator_method = api.isMethodDeclaration(m) and !types.isStaticMember(m) and global_iterator;
        if (!iterator_method and (static_name == null or literal.isIntegerIndex(static_name.?))) {
            return g.notYet("a computed class member name is not yet supported", 5);
        }
    }
    if (api.isConstructor(m)) {
        if (m.data.func.body == null) {
            for (classOf(declaration).members) |other| {
                if (api.isConstructor(other) and other.data.func.body != null) return null;
            }
            return g.notYet("a constructor overload signature is not yet supported", 5);
        }
        constructors.* += 1;
        if (types.baseClassOf(g, declaration) != null and !derivedConstructorOrderOk(g, m, declaration)) {
            return g.notYet("a derived constructor that does not open with super(...) is not yet supported", 5);
        }
        return null;
    }
    const inherited_name = types.instanceMethodName(g, m);
    const bodiless_overload = api.isMethodDeclaration(m) and m.data.func.body == null and inherited_name != null;
    if (!bodiless_overload and inherited_name != null) {
        const static = types.isStaticMember(m);
        const inherited = if (static) &ctx.inherited_static else &ctx.inherited_instance;
        if (inherited.contains(inherited_name.?) and !inheritedShadowIsSameKind(g, m, declaration)) {
            const base = types.baseClassOf(g, declaration);
            const overrides_method = !static and api.isMethodDeclaration(m) and base != null and types.methodDeclaringClass(g, base.?, inherited_name.?) != null;
            if (!overrides_method) return g.notYet(g.fmt("overriding the inherited member '{s}' is not yet supported", .{inherited_name.?}), 5);
            if (!isClassAtModuleScope(declaration)) {
                return g.notYet("overriding a method in a class declared inside a function is not yet supported", 5);
            }
        }
    }
    if (api.isMethodDeclaration(m)) return gateMethodMember(g, m, declaration);
    if (m.data == .property_decl) {
        const p = m.data.property_decl;
        if (p.question and p.init == null and !isNamed(p.name) and classMemberStaticName(g, m) == null) {
            return g.notYet("an optional class field is not yet supported", 5);
        }
        return null;
    }
    return g.notYet("this class member is not yet supported", 5);
}

pub fn gateClass(g: *Gate, declaration: *Node) Result {
    const expression = api.isClassExpression(declaration);
    if (types.classDisplayName(declaration) == null) {
        return g.notYet(if (expression) "an anonymous class expression is not yet supported" else "an anonymous class is not yet supported", 5);
    }
    const generic = isGeneric(declaration);
    if (expression and generic) return g.notYet("a generic class expression is not yet supported", 5);
    if (generic and !isClassAtModuleScope(declaration) and !nestedGenericIsScoped(g, declaration)) {
        return g.notYet("a nested generic class is not yet supported", 5);
    }
    if (generic and !genericNameIsModuleLocal(g, declaration)) {
        return g.notYet("a generic class sharing its name with another module's class is not yet supported", 11);
    }
    const heritage = gateHeritage(g, declaration);
    if (heritage != .accept) return heritage;
    const ctx = Context{
        .declaration = declaration,
        .inherited_instance = ancestorMembers(g, declaration, false),
        .inherited_static = ancestorMembers(g, declaration, true),
    };
    if (privateNameCollision(g, declaration)) |colliding| {
        return g.notYet(g.fmt("a #private member named '{s}' that an ancestor also declares is not yet supported", .{colliding}), 5);
    }
    var constructors: u32 = 0;
    for (classOf(declaration).members) |m| {
        if (gateOneMember(g, m, &ctx, &constructors)) |refused| return refused;
    }
    if (constructors > 1) return g.notYet("more than one constructor is not yet supported", 5);
    if (expression) {
        const parent = declaration.parent;
        const bound = parent != null and parent.?.data == .var_decl and parent.?.data.var_decl.init == declaration and types.isClassFormationDeclarator(g, parent.?);
        if (!bound) {
            const name = classOf(declaration).name;
            return if (name == null)
                g.notYet("an anonymous class expression is not yet supported", 5)
            else
                g.notYet(g.fmt("a class expression '{s}' is not yet supported", .{api.text(name.?) orelse ""}), 5);
        }
    }
    return accept;
}
