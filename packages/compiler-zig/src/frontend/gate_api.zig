//! The gate's questions, phrased the way `packages/compiler/src/frontend/gate.ts` asks them, answered
//! by stator-ts. The TypeScript compiler has one node per token and a `getTypeAtLocation` that means
//! something at every node; stator-ts folds several kinds into one and only types what it has to, so
//! the difference is absorbed here and the rules above read like their TypeScript originals.

const std = @import("std");
const Allocator = std.mem.Allocator;
const stator_ts = @import("stator_ts");

pub const ast = stator_ts.ast;
pub const binder = stator_ts.binder;
pub const decls = stator_ts.decls;
pub const expr = stator_ts.expr;
pub const project = stator_ts.project;
pub const T = stator_ts.types;
pub const F = binder.F;
pub const Tok = ast.Tok;
pub const Node = ast.Node;
pub const Symbol = binder.Symbol;
pub const Type = T.Type;
pub const Sig = T.Sig;
pub const Prop = T.Prop;
pub const File = ast.File;

const core = @import("gate.zig");
const extern_ = @import("gate_extern.zig");
const program = @import("program.zig");
const support = @import("../support/root.zig");
pub const Mode = support.diagnostics.Mode;
pub const Diagnostic = support.diagnostics.Diagnostic;

pub fn oom() noreturn {
    @panic("out of memory");
}

pub const Refusal = struct {
    code: []const u8,
    message: []const u8,
    phase: ?u32 = null,
};

pub const Result = union(enum) {
    accept,
    never: Refusal,
    not_yet: Refusal,
};

pub const accept: Result = .accept;

pub fn never(code: []const u8, message: []const u8) Result {
    return .{ .never = .{ .code = code, .message = message } };
}

pub fn notYetCode(code: []const u8, message: []const u8, phase: ?u32) Result {
    return .{ .not_yet = .{ .code = code, .message = message, .phase = phase } };
}

/// Files that declare a class of a given name; a name in two files needs a module prefix.
pub const ClassNames = std.StringHashMapUnmanaged(std.ArrayList(*File));

pub const Gate = struct {
    a: Allocator,
    c: *T.Checker,
    mode: Mode,
    on_node: bool,
    /// The STATOR_RUNTIME the build asked for: the ICU refusals depend on it.
    runtime: ?[]const u8 = null,
    /// Null only for the program loader's own type questions, which never ask about a module.
    paths: ?*const program.Paths = null,
    /// One verdict per construct, when a tool asks for more than the diagnostics.
    trace: ?core.Trace = null,
    link_pragmas: std.AutoHashMapUnmanaged(*File, []const extern_.LinkPragma) = .empty,
    class_names: ClassNames = .empty,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    /// Names a JS file declares by assigning to their members at its top level (`collectJsGlobals`).
    js_globals: std.StringHashMapUnmanaged(void) = .empty,
    /// `isNeverWritten` scans a whole file per declaration, so its answer is kept.
    never_written: std.AutoHashMapUnmanaged(*Node, bool) = .empty,
    /// Guards the mutual recursion of the HType conversion on self-referential classes.
    converting: std.AutoHashMapUnmanaged(*Type, void) = .empty,

    pub fn fmt(g: *const Gate, comptime format: []const u8, args: anytype) []const u8 {
        return std.fmt.allocPrint(g.a, format, args) catch oom();
    }

    pub fn notYet(g: *const Gate, message: []const u8, phase: u32) Result {
        return notYetCode("STA1214", g.fmt("{s}; planned for Phase {d}", .{ message, phase }), phase);
    }

    pub fn fileOf(g: *const Gate, n: *Node) ?*File {
        return decls.fileOf(g.c, n);
    }

    /// `checker.getTypeAtLocation`. Its declared meaning differs by the kind of node it is handed, and
    /// asking stator-ts to check a name that is no expression would resolve the wrong thing.
    /// `getTypeAtLocation` on a binding pattern is the type of what it destructures, and stator-ts
    /// reaches that through an element. An empty pattern reads nothing, so its type never matters.
    fn patternType(c: *T.Checker, elements: []const *Node) *Type {
        if (elements.len == 0) return c.t_err;
        return decls.bindingParentType(c, elements[0]);
    }

    /// The gate asks for itself, so the checker answers without reporting: what is diagnosed is the
    /// gate's decision alone.
    fn quiet(g: *const Gate, comptime query: anytype, args: anytype) @typeInfo(@TypeOf(query)).@"fn".return_type.? {
        g.c.silent += 1;
        defer g.c.silent -= 1;
        return @call(.auto, query, args);
    }

    /// A checker query `(checker, x)` as the gate method `g.name(x)`, asked quietly.
    fn quietly(comptime query: anytype) fn (*const Gate, Arg(query)) Answer(query) {
        return struct {
            fn ask(g: *const Gate, x: Arg(query)) Answer(query) {
                return g.quiet(query, .{ g.c, x });
            }
        }.ask;
    }

    fn Arg(comptime query: anytype) type {
        return @typeInfo(@TypeOf(query)).@"fn".param_types[1].?;
    }

    fn Answer(comptime query: anytype) type {
        return @typeInfo(@TypeOf(query)).@"fn".return_type.?;
    }

    pub fn typeAt(g: *const Gate, n: *Node) *Type {
        return g.quiet(typeAtNode, .{ g, n });
    }

    fn typeAtNode(g: *const Gate, n: *Node) *Type {
        const c = g.c;
        switch (n.data) {
            .identifier, .private_name => if (n.parent) |p| {
                if (p.data == .prop_access and p.data.prop_access.name == n) return regular(g.typeAt(p));
                if (p.data == .shorthand_assign and p.data.shorthand_assign.name == n) return g.typeAt(p);
                if (declarationName(p) == n) {
                    const sym = p.symbol() orelse return c.t_err;
                    return g.typeOfSymbol(sym);
                }
                if (isTypeNode(p)) return g.typeOfEntity(n);
                if (isNameOnly(p)) return c.t_err;
            },
            .class => |x| {
                if (!x.is_expr) {
                    const sym = n.symbol() orelse return c.t_err;
                    return decls.declaredType(c, sym.resolve());
                }
            },
            // A literal's property is what its value widens to, which only the expression knows.
            .property_assign => |x| return expr.widenInit(c, x.value, expr.checkExpression(c, x.value), false),
            .shorthand_assign => |x| return expr.widenInit(c, x.name, expr.checkExpression(c, x.name), false),
            // A destructured parameter binds its names, not a symbol of its own.
            .param => return if (n.symbol()) |sym| g.typeOfSymbol(sym) else decls.typeOfParam(c, n),
            .binding_elem => return if (n.symbol()) |sym| g.typeOfSymbol(sym) else decls.bindingElemFrom(c, n, decls.bindingParentType(c, n)),
            .var_decl, .property_decl, .property_sig, .enum_member => {
                const sym = n.symbol() orelse return c.t_err;
                return g.typeOfSymbol(sym);
            },
            .func => |x| switch (x.kind) {
                .decl, .method, .getter, .setter, .ctor, .method_sig, .getter_sig, .setter_sig => {
                    // An object literal's method has a symbol, but only the node carries its signature.
                    const in_literal = x.kind == .method and n.parent != null and n.parent.?.data == .object_lit;
                    const sym = (if (in_literal) null else n.symbol()) orelse return expr.checkExpression(c, n);
                    return g.typeOfSymbol(sym);
                },
                .function_type, .constructor_type, .call_sig, .construct_sig => return decls.typeFromNode(c, n),
                else => {},
            },
            .interface, .type_alias, .type_param => {
                const sym = n.symbol() orelse return c.t_err;
                return decls.declaredType(c, sym.resolve());
            },
            .expr_with_type_args => |x| return regular(g.typeAt(x.expr)),
            .object_pattern => |x| return patternType(c, x.elems),
            .array_pattern => |x| return patternType(c, x.elems),
            else => if (isTypeNode(n)) return decls.typeFromNode(c, n),
        }
        return regular(expr.checkExpression(c, n));
    }

    fn typeOfEntity(g: *const Gate, n: *Node) *Type {
        const sym = decls.entitySymbol(g.c, n, F.type | F.namespace | F.alias) orelse return g.c.t_err;
        const target = decls.targetOf(g.c, sym) orelse return g.c.t_err;
        return decls.declaredType(g.c, target);
    }

    pub const typeFromNode = quietly(decls.typeFromNode);

    /// `checker.getTypeOfSymbol`. Only values have one; TypeScript answers the error type otherwise.
    pub const typeOfSymbol = quietly(valueTypeOf);

    fn valueTypeOf(c: *T.Checker, s: *Symbol) *Type {
        const r = s.resolve();
        if (r.flags & (F.value | F.alias) == 0) return c.t_err;
        return decls.typeOfSymbol(c, r);
    }

    /// `checker.getTypeOfSymbolAtLocation` on a property: leaving it out is no value it can hold.
    pub const propType = quietly(presentPropType);

    fn presentPropType(c: *T.Checker, p: *Prop) *Type {
        const t = decls.propType(c, p);
        return if (p.optional) decls.removeMissing(c, t) else t;
    }

    /// `checker.getTypeOfSymbolAtLocation` on a parameter: the type its body sees, without the
    /// `undefined` a caller of a defaulted parameter may pass, unless the annotation says so.
    pub fn parameterType(g: *const Gate, sig: *Sig, i: usize) *Type {
        return g.quiet(bodyParameterType, .{ g, sig, i });
    }

    fn bodyParameterType(g: *const Gate, sig: *Sig, i: usize) *Type {
        const c = g.c;
        const p = sig.params[i];
        const sym = p.sym orelse return decls.paramTypeAt(c, sig, i);
        if (p.ty == null and sig.decl == null and sig.target == null) return g.typeOfSymbol(sym);
        const t = decls.paramTypeAt(c, sig, i);
        const decl = sym.resolve().value_decl orelse return t;
        if (decl.data != .param or decl.data.param.init == null) return t;
        const own = decls.typeOfParam(c, decl);
        const says_undefined = own.data == .undefined or
            (own.data == .union_ and std.mem.indexOfScalar(*Type, own.data.union_, c.t_undefined) != null);
        return if (says_undefined) t else expr.removeUndefined(c, t);
    }

    pub const aliased = quietly(decls.targetOf);

    /// `checker.getSymbolAtLocation`.
    pub fn symbolAt(g: *const Gate, n: *Node) ?*Symbol {
        return g.quiet(symbolAtNode, .{ g, n });
    }

    fn symbolAtNode(g: *const Gate, n: *Node) ?*Symbol {
        const c = g.c;
        switch (n.data) {
            .identifier, .private_name => {
                const p = n.parent orelse return null;
                if (declarationName(p) == n) return p.symbol();
                switch (p.data) {
                    .prop_access => |x| if (x.name == n) return g.memberSymbol(x.expr, n),
                    .qualified_name => |x| if (x.right == n) return decls.entitySymbol(c, p, F.type | F.value | F.namespace | F.alias),
                    .import_spec, .export_spec => return p.symbol(),
                    .type_query => return decls.entitySymbol(c, n, F.value | F.alias),
                    .expr_with_type_args => {
                        const class_extends = if (p.parent) |h| h.data == .heritage_clause and h.data.heritage_clause.tok == .kw_extends and h.parent != null and h.parent.?.data == .class else false;
                        const meaning: u32 = if (class_extends) F.type | F.value | F.alias else F.type | F.alias;
                        return decls.entitySymbol(c, n, meaning);
                    },
                    .labeled, .break_stmt, .continue_stmt, .meta_property => return null,
                    else => {},
                }
                if (isTypeNode(p)) return decls.entitySymbol(c, n, F.type | F.namespace | F.alias);
                if (isNameOnly(p)) return null;
                if (n.data == .private_name) return null;
                return expr.symbolOf(c, n);
            },
            .prop_access => |x| return g.memberSymbol(x.expr, x.name),
            .string_lit, .no_subst_template => |literal| {
                const p = n.parent orelse return null;
                const is_module = switch (p.data) {
                    .import_decl => |x| x.specifier == n,
                    .export_decl => |x| x.specifier == n,
                    .external_module_ref => true,
                    .call => |x| x.callee.data == .import_kw and x.args.len > 0 and x.args[0] == n,
                    else => false,
                };
                if (!is_module) return null;
                return g.moduleSymbol(n, literal);
            },
            else => return null,
        }
    }

    pub const contextualType = quietly(expr.contextualType);
    pub const resolvedSignature = quietly(expr.resolvedSig);

    /// `symbol.valueDeclaration`, which for a module is its source file: stator-ts keeps that link
    /// on the file, so the path the symbol is named after finds it.
    pub fn declarationOf(g: *const Gate, s: ?*Symbol) ?*Node {
        const sym = (s orelse return null).resolve();
        if (sym.value_decl) |declaration| return declaration;
        const source = g.c.prog.by_path.get(sym.name) orelse return null;
        const module = source.file.symbol orelse return null;
        return if (module.resolve() == sym) source.file.root else null;
    }

    pub fn moduleSymbol(g: *const Gate, from: *Node, spec: []const u8) ?*Symbol {
        const file = g.fileOf(from) orelse return null;
        const sf = g.c.prog.sourceOf(file) orelse return null;
        return g.c.prog.resolveModuleName(sf, spec);
    }

    fn memberSymbol(g: *const Gate, receiver: *Node, name: *Node) ?*Symbol {
        const prop = decls.getProp(g.c, g.typeAt(receiver), ast.memberText(name)) orelse return null;
        return propSymbol(prop);
    }

    pub fn property(g: *const Gate, t: *Type, name: []const u8) ?*Prop {
        return g.quiet(decls.getProp, .{ g.c, t, name });
    }

    pub const properties = quietly(decls.propsOf);
    pub const indexInfos = quietly(decls.indexesOf);

    /// `checker.getSignaturesOfType`, which reads through to the apparent type.
    pub fn callSignatures(g: *const Gate, t: *Type) []*Sig {
        return g.quiet(apparentSignatures, .{ g.c, t, .call });
    }

    pub fn constructSignatures(g: *const Gate, t: *Type) []*Sig {
        return g.quiet(apparentSignatures, .{ g.c, t, .construct });
    }

    fn apparentSignatures(c: *T.Checker, t: *Type, kind: enum { call, construct }) []*Sig {
        const apparent = decls.getApparent(c, t);
        return switch (kind) {
            .call => decls.callSigs(c, apparent),
            .construct => decls.ctorSigs(c, apparent),
        };
    }

    pub const signatureOf = quietly(decls.sigOfDecl);
    pub const returnType = quietly(decls.returnOf);

    pub fn isArrayType(g: *const Gate, t: *Type) bool {
        return g.c.isArrayType(t);
    }

    /// `checker.getTypeArguments`. A generic type's own declaration has no argument list of its own
    /// here; TypeScript answers with its parameters.
    pub fn typeArguments(g: *const Gate, t: *Type) []*Type {
        _ = g;
        if (t.data != .obj) return &.{};
        const o = t.data.obj;
        if (o.kind == .tuple) return o.tuple.elems;
        if (o.args) |args| return args;
        if (o.iface) |i| return i.tparams;
        return &.{};
    }

    /// `declarations.every(d => d.getSourceFile().isDeclarationFile)`, on a non-empty list.
    /// Vacuously true for a symbol with no declarations, unlike `declaredOnlyInDeclarationFiles`.
    pub fn allDeclaredInDeclarationFiles(g: *const Gate, s: *Symbol) bool {
        if (g.js_globals.contains(s.resolve().name)) return false;
        for (s.resolve().decls) |d| {
            if (!g.inDeclarationFile(d)) return false;
        }
        return true;
    }

    pub fn declaredOnlyInDeclarationFiles(g: *const Gate, s: ?*Symbol) bool {
        const sym = s orelse return false;
        return sym.resolve().decls.len > 0 and g.allDeclaredInDeclarationFiles(sym);
    }

    pub fn inDeclarationFile(g: *const Gate, n: *Node) bool {
        const f = g.fileOf(n) orelse return false;
        return f.is_dts;
    }
};

pub fn regular(t: *Type) *Type {
    return t.regular orelse t;
}

pub fn propSymbol(p: *Prop) ?*Symbol {
    if (p.sym) |s| return s;
    if (p.origin) |o| return propSymbol(o);
    return null;
}

/// `property.valueDeclaration ?? property.declarations?.[0]`.
pub fn propDeclaration(p: *Prop) ?*Node {
    if (p.decl) |d| return d;
    if (propSymbol(p)) |s| {
        const r = s.resolve();
        if (r.value_decl) |d| return d;
        if (r.decls.len > 0) return r.decls[0];
    }
    return null;
}

pub fn propDeclarations(p: *Prop) []const *Node {
    if (propSymbol(p)) |s| return s.resolve().decls;
    if (p.decl) |*d| return @as(*const [1]*Node, @ptrCast(d));
    return &.{};
}

pub fn propHasAccessor(p: *Prop) bool {
    for (propDeclarations(p)) |d| if (isGetAccessor(d) or isSetAccessor(d)) return true;
    return false;
}

pub fn valueDeclaration(s: ?*Symbol) ?*Node {
    const sym = s orelse return null;
    return sym.resolve().value_decl;
}

/// `symbol.flags & Alias`.
pub fn isAlias(s: *Symbol) bool {
    return s.resolve().flags & F.alias != 0;
}

/// `type.getSymbol()`.
pub fn typeSymbol(t: *Type) ?*Symbol {
    return switch (t.data) {
        .obj => |o| o.sym orelse if (o.target) |target| typeSymbol(target) else null,
        // A class's `this` type carries the class's symbol, as `Type.getSymbol()` answers.
        .param => |p| p.sym orelse if (p.is_this) (if (p.constraint) |class| typeSymbol(class) else null) else null,
        .enum_ => |s| s,
        .enum_lit => |e| e.sym,
        .unique => |s| s,
        else => null,
    };
}

pub fn symbolName(s: ?*Symbol) ?[]const u8 {
    return if (s) |x| x.resolve().name else null;
}

pub fn eql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

/// `node.text`, on what has one.
pub fn text(n: *const Node) ?[]const u8 {
    return switch (n.data) {
        .identifier, .private_name, .string_lit, .numeric_lit, .bigint_lit, .no_subst_template => |v| v,
        else => null,
    };
}

pub fn isIdentifier(n: *const Node) bool {
    return n.data == .identifier;
}

pub fn identifierIs(n: *const Node, name: []const u8) bool {
    return n.data == .identifier and eql(n.data.identifier, name);
}

pub fn isStringLiteralLike(n: *const Node) bool {
    return n.data == .string_lit or n.data == .no_subst_template;
}

fn funcKind(n: *const Node) ?ast.FuncKind {
    return if (n.data == .func) n.data.func.kind else null;
}

/// A `ts.isX` that is one node kind in TypeScript and one or more `FuncKind`s here.
pub fn funcKindIn(comptime kinds: []const ast.FuncKind) fn (*const Node) bool {
    return struct {
        fn check(n: *const Node) bool {
            const k = funcKind(n) orelse return false;
            return std.mem.indexOfScalar(ast.FuncKind, kinds, k) != null;
        }
    }.check;
}

pub const isFunctionDeclaration = funcKindIn(&.{.decl});
pub const isFunctionExpression = funcKindIn(&.{.expr});
pub const isArrowFunction = funcKindIn(&.{.arrow});
/// The kinds that run a body of their own, as opposed to signatures.
pub const hasOwnBody = funcKindIn(&.{ .decl, .expr, .arrow, .method, .ctor, .getter, .setter });
pub const isMethodDeclaration = funcKindIn(&.{.method});
pub const isConstructor = funcKindIn(&.{.ctor});
/// In an object type a getter is still a `GetAccessor` to TypeScript.
pub const isGetAccessor = funcKindIn(&.{ .getter, .getter_sig });
pub const isSetAccessor = funcKindIn(&.{ .setter, .setter_sig });

/// `ts.isFunctionLike`.
pub fn isFunctionLike(n: *const Node) bool {
    return n.data == .func;
}

pub fn isClassDeclaration(n: *const Node) bool {
    return n.data == .class and !n.data.class.is_expr;
}

pub fn isClassExpression(n: *const Node) bool {
    return n.data == .class and n.data.class.is_expr;
}

pub fn isClassLike(n: *const Node) bool {
    return n.data == .class;
}

pub fn isSourceFile(n: *const Node) bool {
    return n.data == .source_file;
}

pub fn isIterationStatement(n: *const Node) bool {
    return switch (n.data) {
        .do_stmt, .while_stmt, .for_stmt, .for_in, .for_of => true,
        else => false,
    };
}

/// `ts.isTypeNode`, which counts `ExpressionWithTypeArguments` as one.
pub fn isTypeNode(n: *const Node) bool {
    return switch (n.data) {
        .kw_type, .this_type, .type_ref, .type_query, .type_literal, .array_type, .tuple_type, .named_tuple_member, .optional_type, .rest_type, .union_type, .intersection_type, .conditional_type, .infer_type, .paren_type, .type_operator, .indexed_access, .mapped_type, .literal_type, .template_literal_type, .template_type_span, .import_type, .type_predicate, .expr_with_type_args => true,
        .func => |x| x.kind == .function_type or x.kind == .constructor_type,
        else => false,
    };
}

/// `ts.isExpression`, by kind.
pub fn isExpression(n: *const Node) bool {
    return switch (n.data) {
        .conditional, .yield_expr, .binary, .spread_elem, .as_expr, .omitted_expr, .satisfies_expr, .prefix, .postfix, .delete_expr, .typeof_expr, .void_expr, .await_expr, .type_assertion, .prop_access, .elem_access, .new_expr, .call, .jsx_element, .jsx_self_closing, .jsx_fragment, .tagged_template, .array_lit, .paren, .object_lit, .identifier, .private_name, .regex_lit, .numeric_lit, .bigint_lit, .string_lit, .no_subst_template, .template_expr, .false_lit, .true_lit, .null_lit, .this_expr, .super_expr, .non_null, .expr_with_type_args, .meta_property, .import_kw => true,
        .func => |x| x.kind == .arrow or x.kind == .expr,
        .class => |x| x.is_expr,
        else => false,
    };
}

/// A kind at or below `LastToken` in TypeScript, where the gate has nothing to say.
pub fn isToken(n: *const Node) bool {
    return switch (n.data) {
        .string_lit, .numeric_lit, .bigint_lit, .regex_lit, .no_subst_template, .null_lit, .true_lit, .false_lit, .import_kw, .private_name, .kw_type, .jsx_text => true,
        else => false,
    };
}

/// `declaration.name`, for everything `ts.getNameOfDeclaration` can reach.
pub fn declarationName(n: *const Node) ?*Node {
    return switch (n.data) {
        inline .func, .class, .interface, .type_alias, .enum_decl, .enum_member, .module_decl, .var_decl, .param, .binding_elem, .property_decl, .property_sig, .property_assign, .shorthand_assign, .type_param, .import_clause, .namespace_import, .namespace_export, .import_equals, .namespace_export_decl, .import_spec, .export_spec => |x| x.name,
        else => null,
    };
}

/// `ts.getNameOfDeclaration(n.parent as Declaration)`: the cast is a lie TypeScript tolerates, and
/// `.name` then also finds the member of a property access.
pub fn nameOfParent(n: *const Node) ?*Node {
    const p = n.parent orelse return null;
    if (p.data == .prop_access) return p.data.prop_access.name;
    return declarationName(p);
}

/// Positions where an identifier is a name, not a reference. Resolving one as a value would find an
/// unrelated binding of the same spelling.
fn isNameOnly(p: *const Node) bool {
    return support.node_field.isAny(p, .{ .labeled, .break_stmt, .continue_stmt, .meta_property, .named_tuple_member, .jsx_attr });
}

pub fn skipParens(n0: *Node) *Node {
    var n = n0;
    while (n.data == .paren) n = n.data.paren.expr;
    return n;
}

/// The outermost parentheses around `n`, or `n` itself: the node its real parent holds.
pub fn outermostParen(n0: *Node) *Node {
    var n = n0;
    while (n.parent) |p| {
        if (p.data != .paren) break;
        n = p;
    }
    return n;
}

pub fn isCallee(n: *const Node) bool {
    const p = n.parent orelse return false;
    return p.data == .call and p.data.call.callee == n;
}

/// Type flag questions. TypeScript answers them from a bit set; stator-ts from the tag.
pub fn isStringLike(t: *const Type) bool {
    return switch (t.data) {
        .string, .str_lit, .tmpl, .strmap => true,
        .enum_lit => |e| e.value == .str,
        else => false,
    };
}

pub fn isNumberLike(t: *const Type) bool {
    return switch (t.data) {
        .number, .num_lit => true,
        .enum_lit => |e| e.value == .num,
        .enum_ => true,
        else => false,
    };
}

pub fn isBooleanLike(t: *const Type) bool {
    return t.is_boolean or t.data == .bool_lit;
}

/// A flag question whose answer is a set of tags.
fn typeTagIn(comptime tags: anytype) fn (*const Type) bool {
    return struct {
        fn check(t: *const Type) bool {
            inline for (tags) |tag| if (t.data == tag) return true;
            return false;
        }
    }.check;
}

pub const isBigIntLike = typeTagIn(.{ .bigint, .big_lit });
pub const isAnyFlag = typeTagIn(.{ .any, .err });
pub const isUnionType = typeTagIn(.{.union_});

/// `type.isUnion() ? type.types : [type]`.
pub fn parts(g: *const Gate, t: *Type) []*Type {
    if (t.data == .union_) return t.data.union_;
    const one = g.a.alloc(*Type, 1) catch oom();
    one[0] = t;
    return one;
}

pub fn isObjectFlag(t: *const Type) bool {
    return t.data == .obj;
}

/// `symbol.flags & (ObjectLiteral | TypeLiteral)`. A literal's type has no symbol here and a mapped
/// type's symbol has neither flag, though both have them in TypeScript.
/// A destructured parameter is named by its position: TypeScript gives it a symbol of its own with
/// the parameter as its declaration, stator-ts one with no declaration.
pub fn isPatternParameter(sig: *const Sig, i: usize) bool {
    const decl = sig.decl orelse return false;
    if (decl.data != .func) return false;
    const params = decl.data.func.params;
    const first_is_this = params.len > 0 and params[0].data.param.name.data == .identifier and eql(params[0].data.param.name.data.identifier, "this");
    const at = i + @intFromBool(first_is_this);
    return at < params.len and params[at].data.param.name.data != .identifier;
}

pub fn isAnonymousShape(t: *const Type) bool {
    if (t.data != .obj) return false;
    const o = t.data.obj;
    if (o.lit or o.was_lit or o.kind == .mapped) return true;
    if (o.node) |n| if (n.data == .type_literal or n.data == .func) return true;
    if (typeSymbol(@constCast(t))) |s| return s.resolve().flags & (F.object_literal | F.type_literal) != 0;
    return false;
}

/// Argument lists are plain slices and type-argument lists carry a span too.
pub fn nodes(list: anytype) []const *Node {
    return if (@TypeOf(list) == ast.TypeList) list.items else list;
}

pub fn typeArgs(list: ast.TypeList) []const *Node {
    return list.items;
}

/// Whether the angle brackets were written at all: `f<>()` still counts in TypeScript.
pub fn typeArgsPresent(list: ast.TypeList) bool {
    return list.items.len > 0 or list.span.end != list.span.start;
}

pub fn isOptionalChain(n: *const Node) bool {
    var at = n;
    while (true) {
        switch (at.data) {
            inline .prop_access, .elem_access => |x| {
                if (x.optional) return true;
                at = x.expr;
            },
            .call => |x| {
                if (x.optional) return true;
                at = x.callee;
            },
            .non_null => |x| at = x.expr,
            else => return false,
        }
    }
}

pub fn sourceText(g: *const Gate, n: *Node) []const u8 {
    const file = g.fileOf(n) orelse return "";
    return file.src[n.start..n.end];
}

pub fn identifierOrPrivateIs(n: *const Node, name: []const u8) bool {
    return (n.data == .identifier and eql(n.data.identifier, name)) or (n.data == .private_name and eql(n.data.private_name, name));
}
