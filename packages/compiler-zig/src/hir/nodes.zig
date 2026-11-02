//! Typed HIR. Mirrors `packages/compiler/src/hir/nodes.ts`, which keeps the reasoning behind each
//! node; only the invariants a Zig reader needs right here are repeated.
//!
//! Spelling rules, so a pass ports line by line:
//! - A TS interface keeps its name; a field is the snake_case of its TS name; `x?: T` is `?T`.
//! - A `kind` is the union field of the kebab name in snake_case: `'binary-op'` is `.binary_op`.
//! - A union of string literals is an enum whose tags ARE the strings (`.@"+"`, `.forEach`,
//!   `.@"cstring-owned"`), so `@tagName` is the spelling the C names and diagnostics derive from.
//! - `Expression` and `Statement` hold one pointer: a node's identity is that pointer, a list of
//!   them is cheap to rebuild, and `Block` or `FunctionExpr` turn into either union without a copy.
//! - Strings are WTF-8: JavaScript strings may hold lone surrogates, and a literal must keep them.
//!
//! Nodes and strings live in the module's arena; nothing frees individually.

const std = @import("std");
const Allocator = std.mem.Allocator;
const types = @import("types.zig");
const keyof = @import("keyof.zig");

pub const HType = types.HType;
pub const HObject = types.HObject;
const H_ARRAYBUFFER = types.H_ARRAYBUFFER;
const H_BOOLEAN = types.H_BOOLEAN;
const H_NUMBER = types.H_NUMBER;
const H_STRING = types.H_STRING;
const H_UINT8ARRAY = types.H_UINT8ARRAY;
const H_UNDEFINED = types.H_UNDEFINED;
const hUnknown = types.hUnknown;

/// `start`/`length` are 0-indexed UTF-16 offsets, TypeScript's own coordinates. `line` is 1-indexed
/// for `#line`, and is carried so the emitter never needs the source text.
pub const Span = struct {
    start: u32,
    length: u32,
    line: u32,
    /// Absent only in hand-built HIR; the emitter falls back to the module's file name.
    file: ?[]const u8 = null,
};

// ---------------------------------------------------------------------------------------------
// Expressions

/// A method on a receiver, named by a key of that receiver's table.
fn ReceiverOp(comptime Op: type) type {
    return struct {
        type: *const HType,
        span: Span,
        op: Op,
        target: Expression,
        args: []const Expression,
    };
}

/// A call on a global namespace such as `Math` or `Object`, named by a key of its table.
fn StaticCall(comptime Method: type) type {
    return struct {
        type: *const HType,
        span: Span,
        method: Method,
        args: []const Expression,
    };
}

/// A property read whose name is a key of the receiver's field table.
fn FieldRead(comptime Field: type) type {
    return struct {
        type: *const HType,
        span: Span,
        field: Field,
        target: Expression,
    };
}

pub const NumberLiteral = struct { type: *const HType, span: Span, value: f64 };
pub const StringLiteral = struct { type: *const HType, span: Span, value: []const u8 };
pub const BooleanLiteral = struct { type: *const HType, span: Span, value: bool };
pub const NullLiteral = struct { type: *const HType, span: Span };
pub const UndefinedLiteral = struct { type: *const HType, span: Span };
pub const Identifier = struct { type: *const HType, span: Span, name: []const u8 };

/// Both operands are always evaluated, exactly once, left to right. `&&`, `||` and `??` are not
/// here because a pass may assume that of every BinaryOp.
pub const BinaryOperator = enum {
    @"+",
    @"-",
    @"*",
    @"/",
    @"%",
    @"<",
    @">",
    @"<=",
    @">=",
    @"===",
    @"!==",
    @"==",
    @"!=",
    @"&",
    @"|",
    @"^",
    @"<<",
    @">>",
    @">>>",
    @"**",
    @",",
    in,
};

pub const BinaryOp = struct { type: *const HType, span: Span, operator: BinaryOperator, left: Expression, right: Expression };

pub const UnaryOperator = enum { @"-", @"+", @"!", @"~", void };

/// `-` must never be optimized away as identity: it is the only way to get `-0` from `+0`.
pub const UnaryOp = struct { type: *const HType, span: Span, operator: UnaryOperator, operand: Expression };

pub const TypeOf = struct { type: *const HType, span: Span, operand: Expression };

pub const DeleteProp = struct { type: *const HType, span: Span, target: Expression, key: Expression };

/// `where` is `file:line:col`: a column needs the source text, which the emitter does not have.
pub const BoundaryCheck = struct { type: *const HType, span: Span, value: Expression, where: []const u8 };

pub const LogicalOperator = enum { @"&&", @"||", @"??" };

pub const LogicalOp = struct { type: *const HType, span: Span, operator: LogicalOperator, left: Expression, right: Expression };

/// `quasis.len == expressions.len + 1`.
pub const TemplateLiteral = struct {
    type: *const HType,
    span: Span,
    quasis: []const []const u8,
    expressions: []const Expression,
};

pub const StringLength = struct { type: *const HType, span: Span, operand: Expression };
pub const ArrayLength = struct { type: *const HType, span: Span, operand: Expression };
pub const FunctionLength = struct { type: *const HType, span: Span, operand: Expression };
pub const ArrayLiteral = struct { type: *const HType, span: Span, elements: []const Expression };

pub const IndexAccess = struct { type: *const HType, span: Span, target: Expression, index: Expression };

pub const NewExpr = struct { type: *const HType, span: Span, class_name: []const u8, args: []const Expression };

pub const NewValue = struct { type: *const HType, span: Span, target: Expression, args: []const Expression };

pub const InstanceOf = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    class_name: []const u8,
    builtin: ?bool = null,
};

pub const InstanceOfValue = struct { type: *const HType, span: Span, target: Expression, ctor: Expression };

pub const ClassValue = struct { type: *const HType, span: Span, class_name: []const u8 };

/// `slot` is stored rather than recomputed so the verifier can check it.
pub const FieldAccess = struct { type: *const HType, span: Span, target: Expression, field: []const u8, slot: i32 };

pub const DynFieldAccess = struct { type: *const HType, span: Span, target: Expression, field: []const u8 };

pub const Dispatch = enum { direct, virtual };

/// `target` is the receiver and is not in `args`; it becomes argument zero. `slot` is meaningful
/// only for a `virtual` call.
pub const MethodCall = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    class_name: []const u8,
    method: []const u8,
    slot: i32,
    dispatch: Dispatch,
    args: []const Expression,
};

pub const DynMethodCall = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    method: []const u8,
    args: []const Expression,
    /// `args` is then one array holding every argument, spreads expanded.
    spread: ?bool = null,
    not_function: ?[]const u8 = null,
};

pub const FieldCall = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    field: []const u8,
    slot: i32,
    args: []const Expression,
};

pub const MethodValue = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    class_name: []const u8,
    method: []const u8,
    slot: i32,
    dispatch: Dispatch,
};

/// `entries` is in slot order, which is also source order.
pub const ObjectLiteral = struct {
    type: *const HType,
    span: Span,
    entries: []const ObjectEntry,
    methods: []const ClassMethod,
    method_copies: []const MethodCopy,
};

/// `at` is the index into the literal's `entries` where this fragment starts.
pub const MethodCopy = struct { name: []const u8, value: *const MethodValue, at: u32 };

pub const ObjectEntry = struct { name: []const u8, value: Expression, spread: ?bool = null, proto_setter: ?bool = null };

pub const DynObjectLiteral = struct { type: *const HType, span: Span, entries: []const DynEntry };

/// A pair, not two entries: one key holds both halves and either may be absent.
pub const AccessorEntry = struct { name: []const u8, get: ?Expression = null, set: ?Expression = null };

pub const ComputedEntry = struct { key: Expression, value: Expression };

/// In written order, which is the order keys are inserted and printed.
pub const DynEntry = union(enum) {
    object_entry: ObjectEntry,
    accessor_entry: AccessorEntry,
    computed_entry: ComputedEntry,
};

pub fn isAccessorEntry(entry: DynEntry) bool {
    return entry == .accessor_entry;
}

pub fn isComputedEntry(entry: DynEntry) bool {
    return entry == .computed_entry;
}

pub const CollectionKind = enum { map, set };

pub const CollectionNew = struct { type: *const HType, span: Span, collection: CollectionKind, weak: bool };

/// The last seven are `SET_OPS`: they take another Set rather than an element.
pub const CollectionOperation = keyof.Union(&.{
    enum { get, set, has, delete, clear, add, size, forEach, keys, values, entries },
    SetOperation,
});

pub const SetOpResult = enum { set, boolean };

/// Their argument is a Set the runtime reads as a `JSRTMap`, so anything else is memory corruption
/// rather than a wrong answer; both the gate and the verifier consult this table.
pub const SET_OPS = keyof.table(SetOpResult, .{
    .@"union" = .set,
    .intersection = .set,
    .difference = .set,
    .symmetricDifference = .set,
    .isSubsetOf = .boolean,
    .isSupersetOf = .boolean,
    .isDisjointFrom = .boolean,
});
pub const SetOperation = @TypeOf(SET_OPS).Key;

pub fn isSetOperation(op: []const u8) bool {
    return std.meta.stringToEnum(SetOperation, op) != null;
}

pub const CollectionOp = struct {
    type: *const HType,
    span: Span,
    collection: CollectionKind,
    op: CollectionOperation,
    target: Expression,
    args: []const Expression,
};

pub const StringOpResult = enum { boolean, element, iterator, match, number, string, @"string-array" };

pub const StringOpInfo = struct {
    arity: u8,
    result: StringOpResult,
    /// The runtime can leave a catchable error pending, so the emitter gives the op its own
    /// statement and a pending check after it.
    throws: bool = false,
};

pub const STRING_OPS = keyof.table(StringOpInfo, .{
    .at = .{ .arity = 1, .result = .element },
    .charAt = .{ .arity = 1, .result = .string },
    .charCodeAt = .{ .arity = 1, .result = .number },
    .codePointAt = .{ .arity = 1, .result = .element },
    .concat = .{ .arity = 1, .result = .string, .throws = true },
    .endsWith = .{ .arity = 2, .result = .boolean },
    .includes = .{ .arity = 2, .result = .boolean },
    .indexOf = .{ .arity = 2, .result = .number },
    .lastIndexOf = .{ .arity = 2, .result = .number },
    .localeCompare = .{ .arity = 2, .result = .number },
    .normalize = .{ .arity = 1, .result = .string },
    .padEnd = .{ .arity = 2, .result = .string, .throws = true },
    .padStart = .{ .arity = 2, .result = .string, .throws = true },
    .repeat = .{ .arity = 1, .result = .string, .throws = true },
    .match = .{ .arity = 1, .result = .match },
    .matchAll = .{ .arity = 1, .result = .iterator },
    .search = .{ .arity = 1, .result = .number },
    .replace = .{ .arity = 2, .result = .string },
    .replaceAll = .{ .arity = 2, .result = .string },
    .slice = .{ .arity = 2, .result = .string },
    .split = .{ .arity = 1, .result = .@"string-array" },
    .startsWith = .{ .arity = 2, .result = .boolean },
    .substring = .{ .arity = 2, .result = .string },
    .toLocaleLowerCase = .{ .arity = 1, .result = .string },
    .toLocaleUpperCase = .{ .arity = 1, .result = .string },
    .toLowerCase = .{ .arity = 0, .result = .string },
    .toString = .{ .arity = 0, .result = .string },
    .toUpperCase = .{ .arity = 0, .result = .string },
    .trim = .{ .arity = 0, .result = .string },
    .trimEnd = .{ .arity = 0, .result = .string },
    .trimStart = .{ .arity = 0, .result = .string },
    .valueOf = .{ .arity = 0, .result = .string },
});
pub const StringOpName = @TypeOf(STRING_OPS).Key;

pub fn stringOpCanThrow(op: StringOpName) bool {
    return STRING_OPS.get(op).throws;
}

pub const StringOp = ReceiverOp(StringOpName);

pub const StringStaticMethod = enum { fromCharCode };

pub const StringStaticCall = StaticCall(StringStaticMethod);

pub const GlobalCallResult = enum { number, boolean, regexp, array, unknown };

pub const GlobalCallInfo = struct { arity: u8, @"fn": []const u8, result: GlobalCallResult, throws: bool };

pub const GLOBAL_CALLS = keyof.table(GlobalCallInfo, .{
    .parseInt = .{ .arity = 2, .@"fn" = "jsrt_global_parse_int", .result = .number, .throws = false },
    .parseFloat = .{ .arity = 1, .@"fn" = "jsrt_global_parse_float", .result = .number, .throws = false },
    .isNaN = .{ .arity = 1, .@"fn" = "jsrt_global_is_nan", .result = .boolean, .throws = false },
    .isFinite = .{ .arity = 1, .@"fn" = "jsrt_global_is_finite", .result = .boolean, .throws = false },
    .@"Number.isFinite" = .{ .arity = 1, .@"fn" = "jsrt_number_is_finite", .result = .boolean, .throws = false },
    .@"Number.isNaN" = .{ .arity = 1, .@"fn" = "jsrt_number_is_nan", .result = .boolean, .throws = false },
    .@"ArrayBuffer.isView" = .{ .arity = 1, .@"fn" = "jsrt_arraybuffer_is_view", .result = .boolean, .throws = false },
    .@"%ctor" = .{ .arity = 1, .@"fn" = "jsrt_builtin_ctor_value", .result = .unknown, .throws = false },
    .@"%proto" = .{ .arity = 1, .@"fn" = "jsrt_builtin_proto_value", .result = .unknown, .throws = false },
    .@"%objectProto" = .{ .arity = 1, .@"fn" = "jsrt_object_proto_method_value", .result = .unknown, .throws = false },
    .RegExp = .{ .arity = 2, .@"fn" = "jsrt_regexp_construct", .result = .regexp, .throws = true },
    .Array = .{ .arity = 1, .@"fn" = "jsrt_array_construct", .result = .array, .throws = true },
    .@"Array.from" = .{ .arity = 1, .@"fn" = "jsrt_array_from", .result = .array, .throws = true },
    .@"..." = .{ .arity = 1, .@"fn" = "jsrt_spread_operand", .result = .array, .throws = true },
});
pub const GlobalCallName = @TypeOf(GLOBAL_CALLS).Key;

pub const GlobalCall = struct { type: *const HType, span: Span, name: GlobalCallName, args: []const Expression };

pub const ArrayOpResult = enum { boolean, checker, element, iterator, mapped, number, self, string, undefined };

pub const ArrayOpInfo = struct {
    arity: u8,
    result: ArrayOpResult,
    /// Calls back into compiled code, which is what lets the walk see a pending exception.
    calls: bool = false,
    /// Takes any count from `arity` up.
    variadic: bool = false,
    /// A bounded range `arity..max_arity` instead of `variadic`.
    max_arity: ?u8 = null,
};

pub const ARRAY_OPS = keyof.table(ArrayOpInfo, .{
    .at = .{ .arity = 1, .result = .element },
    .concat = .{ .arity = 0, .result = .self, .variadic = true },
    .copyWithin = .{ .arity = 3, .result = .self },
    .every = .{ .arity = 1, .result = .boolean, .calls = true },
    .fill = .{ .arity = 3, .result = .self },
    .filter = .{ .arity = 1, .result = .mapped, .calls = true },
    .find = .{ .arity = 1, .result = .element, .calls = true },
    .findIndex = .{ .arity = 1, .result = .number, .calls = true },
    .findLast = .{ .arity = 1, .result = .element, .calls = true },
    .findLastIndex = .{ .arity = 1, .result = .number, .calls = true },
    .flat = .{ .arity = 1, .result = .mapped },
    .flatMap = .{ .arity = 1, .result = .mapped, .calls = true },
    .forEach = .{ .arity = 1, .result = .undefined, .calls = true },
    .includes = .{ .arity = 2, .result = .boolean },
    .indexOf = .{ .arity = 2, .result = .number },
    .join = .{ .arity = 1, .result = .string },
    .lastIndexOf = .{ .arity = 1, .result = .number, .max_arity = 2 },
    .map = .{ .arity = 1, .result = .mapped, .calls = true },
    .pop = .{ .arity = 0, .result = .element },
    .push = .{ .arity = 0, .result = .number, .variadic = true },
    .reduce = .{ .arity = 2, .result = .checker, .calls = true },
    .reduceRight = .{ .arity = 2, .result = .checker, .calls = true },
    .reverse = .{ .arity = 0, .result = .self },
    .shift = .{ .arity = 0, .result = .element },
    .slice = .{ .arity = 2, .result = .self },
    .sort = .{ .arity = 1, .result = .self, .calls = true },
    .some = .{ .arity = 1, .result = .boolean, .calls = true },
    .splice = .{ .arity = 0, .result = .self, .variadic = true },
    .toReversed = .{ .arity = 0, .result = .self },
    .toSorted = .{ .arity = 1, .result = .self },
    .toSpliced = .{ .arity = 2, .result = .self },
    .toString = .{ .arity = 0, .result = .string },
    .unshift = .{ .arity = 0, .result = .number, .variadic = true },
    .with = .{ .arity = 2, .result = .self },
    .keys = .{ .arity = 0, .result = .iterator },
    .values = .{ .arity = 0, .result = .iterator },
    .entries = .{ .arity = 0, .result = .iterator },
});
pub const ArrayOpName = @TypeOf(ARRAY_OPS).Key;

pub fn arrayOpCallsBack(op: ArrayOpName) bool {
    return ARRAY_OPS.get(op).calls;
}

pub const ArrayOp = struct {
    type: *const HType,
    span: Span,
    op: ArrayOpName,
    target: Expression,
    args: []const Expression,
    /// A spread iterates its operand, so a hole becomes `undefined` where a `concat` keeps it.
    spread: ?bool = null,
};

pub const ObjectStaticMethod = enum {
    assign,
    entries,
    forInKeys,
    freeze,
    fromEntries,
    getOwnPropertyNames,
    hasOwn,
    isFrozen,
    keys,
    values,
};

pub const ObjectStaticCall = StaticCall(ObjectStaticMethod);

pub const PromiseStaticMethod = enum { all, reject, resolve };

pub const PromiseStaticCall = struct { type: *const HType, span: Span, method: PromiseStaticMethod, arg: Expression };

pub const PromiseInstanceMethod = enum { @"catch", finally, then };

pub const PromiseMethodCall = struct {
    type: *const HType,
    span: Span,
    method: PromiseInstanceMethod,
    target: Expression,
    args: []const Expression,
};

pub const PromiseConstruct = struct { type: *const HType, span: Span, executor: Expression };
pub const JsonStringify = struct { type: *const HType, span: Span, arg: Expression };
pub const JsonParse = struct { type: *const HType, span: Span, arg: Expression };

/// Arity is fixed per method once lowering has folded the variadic `min`/`max` into binary nodes,
/// so the table is what the verifier holds every `math-call` to.
pub const MATH_METHODS = keyof.table(u8, .{
    .abs = 1,
    .acos = 1,
    .acosh = 1,
    .asin = 1,
    .asinh = 1,
    .atan = 1,
    .atan2 = 2,
    .atanh = 1,
    .cbrt = 1,
    .ceil = 1,
    .clz32 = 1,
    .cos = 1,
    .cosh = 1,
    .exp = 1,
    .expm1 = 1,
    .floor = 1,
    .fround = 1,
    .hypot = 2,
    .imul = 2,
    .log = 1,
    .log10 = 1,
    .log1p = 1,
    .log2 = 1,
    .max = 2,
    .min = 2,
    .pow = 2,
    .random = 0,
    .round = 1,
    .sign = 1,
    .sin = 1,
    .sinh = 1,
    .sqrt = 1,
    .tan = 1,
    .tanh = 1,
    .trunc = 1,
});
pub const MathMethod = @TypeOf(MATH_METHODS).Key;

pub const MathCall = StaticCall(MathMethod);

/// Where a function's SIGNATURE types came from. An annotation is a claim a boundary must check; an
/// inference is already true inside the checked world.
pub const Provenance = enum { typed, inferred, dynamic };

/// A declaration, a function expression and an arrow all lower to this. `name` is for diagnostics
/// and is not the binding: `FunctionDeclaration.name` is.
pub const FunctionExpr = struct {
    type: *const HType,
    span: Span,
    name: ?[]const u8 = null,
    self_binding: ?[]const u8 = null,
    params: []const Parameter,
    body: *const Block,
    /// The array position IS the environment slot index. A name here gets no frame slot.
    env_vars: []const []const u8,
    captures: []const EnvCapture,
    needs_env: bool,
    is_async: bool,
    is_generator: bool,
    constructible: ?bool = null,
    provenance: Provenance,
};

pub const AwaitExpr = struct { type: *const HType, span: Span, value: Expression };
pub const YieldExpr = struct { type: *const HType, span: Span, value: Expression };

/// `levels` counts from the environment the referencing function receives; both numbers are
/// compile-time constants, so a capture is an indexed load, never a search.
pub const EnvCapture = struct { name: []const u8, levels: u32, index: u32 };

/// Not a node: a binding site, not a value.
pub const Parameter = struct {
    name: []const u8,
    type: *const HType,
    span: Span,
    rest: ?bool = null,
    default: ?Expression = null,
};

pub const CallExpr = struct {
    type: *const HType,
    span: Span,
    callee: Expression,
    args: []const Expression,
    /// `args` is then one array holding every argument, spreads expanded.
    spread: ?bool = null,
};

pub const ExternAbiKind = enum {
    value,
    number,
    boolean,
    cstring,
    @"cstring-owned",
    pointer,
    @"out-pointer",
    bytes,
    void,
};

pub const ExternErrorConvention = enum { nonzero, negative, null, errno };

pub fn isExternErrorConvention(name: []const u8) bool {
    return std.meta.stringToEnum(ExternErrorConvention, name) != null;
}

/// Why a convention does not fit a return kind, or null when it does. The gate and the verifier
/// read the same matrix so the two cannot disagree about which declarations compile.
pub fn externConventionMismatch(arena: Allocator, ret: ExternAbiKind, convention: ExternErrorConvention) Allocator.Error!?[]const u8 {
    switch (convention) {
        .errno => return null,
        .null => {
            if (ret == .cstring or ret == .pointer) return null;
            return try std.fmt.allocPrint(arena, "the null convention guards a pointer return, not '{s}'", .{@tagName(ret)});
        },
        .nonzero, .negative => {
            if (ret == .number) return null;
            return try std.fmt.allocPrint(arena, "the {s} convention reads a numeric return, not '{s}'", .{ @tagName(convention), @tagName(ret) });
        },
    }
}

/// A pointer is Unknown because the HIR has no vocabulary for a brand, and it must never take a
/// boundary check: there is no runtime test for "is this pointer honest".
pub fn externKindHType(kind: ExternAbiKind) *const HType {
    return switch (kind) {
        .number => H_NUMBER,
        .boolean => H_BOOLEAN,
        .cstring, .@"cstring-owned" => H_STRING,
        .pointer, .value, .@"out-pointer" => hUnknown(false),
        .bytes => H_UINT8ARRAY,
        .void => H_UNDEFINED,
    };
}

/// `arg_kinds` and `arg_tags` are parallel to `args`, and arity is exact: a C call has no
/// missing-means-undefined.
pub const ExternCall = struct {
    type: *const HType,
    span: Span,
    c_name: []const u8,
    ts_name: []const u8,
    args: []const Expression,
    arg_kinds: []const ExternAbiKind,
    arg_tags: []const ?[]const u8,
    ret_kind: ExternAbiKind,
    @"error": ?ExternErrorConvention = null,
    header: ?[]const u8 = null,
};

pub const OutNew = struct { type: *const HType, span: Span };

pub const OutInner = enum { pointer, cstring };

pub const OutGet = struct { type: *const HType, span: Span, operand: Expression, inner: OutInner };

pub const ConsoleInfo = struct {
    arity: u8,
    optional: u8,
    @"fn": []const u8,
    /// Where the omitted form is observably different output, it has its own entry point.
    bare: ?[]const u8 = null,
    variadic: ?[]const u8 = null,
};

pub const CONSOLE_METHODS = keyof.table(ConsoleInfo, .{
    .assert = .{ .arity = 2, .optional = 1, .@"fn" = "jsrt_console_assert", .bare = "jsrt_console_assert_bare" },
    .count = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_count" },
    .countReset = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_count_reset" },
    .debug = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_print", .variadic = "jsrt_print_many" },
    .dir = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_console_dir" },
    .@"error" = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_eprint", .variadic = "jsrt_eprint_many" },
    .group = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_group", .bare = "jsrt_console_group_bare" },
    .groupEnd = .{ .arity = 0, .optional = 0, .@"fn" = "jsrt_console_group_end" },
    .info = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_print", .variadic = "jsrt_print_many" },
    .log = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_print", .variadic = "jsrt_print_many" },
    .table = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_console_table" },
    .time = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_time" },
    .timeEnd = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_time_end" },
    .trace = .{ .arity = 1, .optional = 1, .@"fn" = "jsrt_console_trace", .bare = "jsrt_console_trace_bare" },
    .warn = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_eprint", .variadic = "jsrt_eprint_many" },
});
pub const ConsoleMethod = @TypeOf(CONSOLE_METHODS).Key;

/// Any width but the declared arity, on a method with a variadic entry point.
pub fn isConsoleVariadicWidth(method: ConsoleMethod, given: usize) bool {
    const shape = CONSOLE_METHODS.get(method);
    return shape.variadic != null and given != shape.arity;
}

/// `table` reads each row's properties, and a variadic call of two or more arguments may apply
/// util.format, whose conversions can run user code.
pub fn consoleMayThrow(call: *const ConsoleLogCall) bool {
    return call.method == .table or
        (call.args.len >= 2 and isConsoleVariadicWidth(call.method, call.args.len));
}

/// The C entry point for a call of this width, or null if the method has no such form.
pub fn consoleEntryPoint(method: ConsoleMethod, given: usize) ?[]const u8 {
    const shape = CONSOLE_METHODS.get(method);
    if (given == shape.arity) return shape.@"fn";
    if (shape.variadic) |variadic| return variadic;
    if (shape.bare) |bare| {
        if (given == shape.arity - shape.optional) return bare;
    }
    return null;
}

pub const ConsoleLogCall = StaticCall(ConsoleMethod);

/// A literal but not a constant: every evaluation is a new object because `lastIndex` is mutable
/// state on it. The pattern travels as text so nothing above the runtime can disagree with the
/// engine about what it means.
pub const RegExpLiteral = struct { type: *const HType, span: Span, source: []const u8, flags: []const u8 };

pub const RegExpOpResult = enum { boolean, match, string };
pub const RegExpOpInfo = struct { arity: u8, result: RegExpOpResult };

pub const REGEXP_OPS = keyof.table(RegExpOpInfo, .{
    .@"test" = .{ .arity = 1, .result = .boolean },
    .exec = .{ .arity = 1, .result = .match },
    .toString = .{ .arity = 0, .result = .string },
});
pub const RegExpOperation = @TypeOf(REGEXP_OPS).Key;

pub const DateOpResult = enum { number, string };

pub const DateOpInfo = struct { arity: u8, optional: u8, @"fn": []const u8, result: DateOpResult };

fn dateOp(arity: u8, optional: u8, c_name: []const u8, result: DateOpResult) DateOpInfo {
    return .{ .arity = arity, .optional = optional, .@"fn" = c_name, .result = result };
}

pub const DATE_OPS = keyof.table(DateOpInfo, .{
    .getTime = dateOp(0, 0, "jsrt_date_get_time", .number),
    .valueOf = dateOp(0, 0, "jsrt_date_get_time", .number),
    .getUTCFullYear = dateOp(0, 0, "jsrt_date_get_utc_full_year", .number),
    .getUTCMonth = dateOp(0, 0, "jsrt_date_get_utc_month", .number),
    .getUTCDate = dateOp(0, 0, "jsrt_date_get_utc_date", .number),
    .getUTCDay = dateOp(0, 0, "jsrt_date_get_utc_day", .number),
    .getUTCHours = dateOp(0, 0, "jsrt_date_get_utc_hours", .number),
    .getUTCMinutes = dateOp(0, 0, "jsrt_date_get_utc_minutes", .number),
    .getUTCSeconds = dateOp(0, 0, "jsrt_date_get_utc_seconds", .number),
    .getUTCMilliseconds = dateOp(0, 0, "jsrt_date_get_utc_milliseconds", .number),
    .setTime = dateOp(1, 0, "jsrt_date_set_time", .number),
    .setUTCFullYear = dateOp(3, 2, "jsrt_date_set_utc_full_year", .number),
    .setUTCMonth = dateOp(2, 1, "jsrt_date_set_utc_month", .number),
    .setUTCDate = dateOp(1, 0, "jsrt_date_set_utc_date", .number),
    .setUTCHours = dateOp(4, 3, "jsrt_date_set_utc_hours", .number),
    .setUTCMinutes = dateOp(3, 2, "jsrt_date_set_utc_minutes", .number),
    .setUTCSeconds = dateOp(2, 1, "jsrt_date_set_utc_seconds", .number),
    .setUTCMilliseconds = dateOp(1, 0, "jsrt_date_set_utc_milliseconds", .number),
    .getFullYear = dateOp(0, 0, "jsrt_date_get_full_year", .number),
    .getMonth = dateOp(0, 0, "jsrt_date_get_month", .number),
    .getDate = dateOp(0, 0, "jsrt_date_get_date", .number),
    .getDay = dateOp(0, 0, "jsrt_date_get_day", .number),
    .getHours = dateOp(0, 0, "jsrt_date_get_hours", .number),
    .getMinutes = dateOp(0, 0, "jsrt_date_get_minutes", .number),
    .getSeconds = dateOp(0, 0, "jsrt_date_get_seconds", .number),
    .getMilliseconds = dateOp(0, 0, "jsrt_date_get_milliseconds", .number),
    .getTimezoneOffset = dateOp(0, 0, "jsrt_date_get_timezone_offset", .number),
    .setFullYear = dateOp(3, 2, "jsrt_date_set_full_year", .number),
    .setMonth = dateOp(2, 1, "jsrt_date_set_month", .number),
    .setDate = dateOp(1, 0, "jsrt_date_set_date", .number),
    .setHours = dateOp(4, 3, "jsrt_date_set_hours", .number),
    .setMinutes = dateOp(3, 2, "jsrt_date_set_minutes", .number),
    .setSeconds = dateOp(2, 1, "jsrt_date_set_seconds", .number),
    .setMilliseconds = dateOp(1, 0, "jsrt_date_set_milliseconds", .number),
    .toISOString = dateOp(0, 0, "jsrt_date_to_iso_string", .string),
    .toJSON = dateOp(0, 0, "jsrt_date_to_json", .string),
    .toDateString = dateOp(0, 0, "jsrt_date_to_date_string", .string),
    .toUTCString = dateOp(0, 0, "jsrt_date_to_utc_string", .string),
});
pub const DateOperation = @TypeOf(DATE_OPS).Key;

pub const TypedResult = enum { number, undefined, uint8array, arraybuffer };
pub const TypedForm = enum { new, get, call };
pub const TypedReceiver = enum { uint8array, arraybuffer };

pub const TypedOpInfo = struct {
    form: TypedForm,
    receiver: ?TypedReceiver,
    arity: u8,
    required: u8,
    @"fn": []const u8,
    result: TypedResult,
};

pub const TYPED_OPS = keyof.table(TypedOpInfo, .{
    .@"new ArrayBuffer" = .{ .form = .new, .receiver = null, .arity = 1, .required = 0, .@"fn" = "jsrt_arraybuffer_new", .result = .arraybuffer },
    .@"new Uint8Array" = .{ .form = .new, .receiver = null, .arity = 3, .required = 0, .@"fn" = "jsrt_uint8array_new", .result = .uint8array },
    .@"ArrayBuffer.prototype.byteLength" = .{ .form = .get, .receiver = .arraybuffer, .arity = 0, .required = 0, .@"fn" = "jsrt_arraybuffer_byte_length", .result = .number },
    .@"ArrayBuffer.prototype.slice" = .{ .form = .call, .receiver = .arraybuffer, .arity = 2, .required = 0, .@"fn" = "jsrt_arraybuffer_slice", .result = .arraybuffer },
    .@"Uint8Array.prototype.length" = .{ .form = .get, .receiver = .uint8array, .arity = 0, .required = 0, .@"fn" = "jsrt_uint8array_length", .result = .number },
    .@"Uint8Array.prototype.byteLength" = .{ .form = .get, .receiver = .uint8array, .arity = 0, .required = 0, .@"fn" = "jsrt_uint8array_byte_length", .result = .number },
    .@"Uint8Array.prototype.byteOffset" = .{ .form = .get, .receiver = .uint8array, .arity = 0, .required = 0, .@"fn" = "jsrt_uint8array_byte_offset", .result = .number },
    .@"Uint8Array.prototype.buffer" = .{ .form = .get, .receiver = .uint8array, .arity = 0, .required = 0, .@"fn" = "jsrt_uint8array_buffer", .result = .arraybuffer },
    .@"Uint8Array.prototype.subarray" = .{ .form = .call, .receiver = .uint8array, .arity = 2, .required = 0, .@"fn" = "jsrt_uint8array_subarray", .result = .uint8array },
    .@"Uint8Array.prototype.slice" = .{ .form = .call, .receiver = .uint8array, .arity = 2, .required = 0, .@"fn" = "jsrt_uint8array_slice", .result = .uint8array },
    .@"Uint8Array.prototype.set" = .{ .form = .call, .receiver = .uint8array, .arity = 2, .required = 1, .@"fn" = "jsrt_uint8array_set", .result = .undefined },
});
pub const TypedOperation = @TypeOf(TYPED_OPS).Key;

pub fn typedResultType(result: TypedResult) *const HType {
    return switch (result) {
        .number => H_NUMBER,
        .undefined => H_UNDEFINED,
        .uint8array => H_UINT8ARRAY,
        .arraybuffer => H_ARRAYBUFFER,
    };
}

pub fn typedClassName(receiver: TypedReceiver) []const u8 {
    return switch (receiver) {
        .uint8array => "Uint8Array",
        .arraybuffer => "ArrayBuffer",
    };
}

/// The table row `receiver.member` names, or null for a member that has not landed.
pub fn typedMember(receiver: TypedReceiver, member: []const u8) ?TypedOperation {
    const class = typedClassName(receiver);
    const infix = ".prototype.";
    for (std.enums.values(TypedOperation)) |op| {
        const key = @tagName(op);
        if (key.len == class.len + infix.len + member.len and
            std.mem.startsWith(u8, key, class) and
            std.mem.eql(u8, key[class.len..][0..infix.len], infix) and
            std.mem.eql(u8, key[class.len + infix.len ..], member)) return op;
    }
    return null;
}

pub const DateStaticInfo = struct { arity: u8, optional: u8, @"fn": []const u8 };

pub const DATE_STATICS = keyof.table(DateStaticInfo, .{
    .UTC = .{ .arity = 7, .optional = 6, .@"fn" = "jsrt_date_utc" },
    .parse = .{ .arity = 1, .optional = 0, .@"fn" = "jsrt_date_parse" },
    .now = .{ .arity = 0, .optional = 0, .@"fn" = "jsrt_date_now" },
});
pub const DateStatic = @TypeOf(DATE_STATICS).Key;

pub const ErrorClass = enum { Error, TypeError, RangeError, ReferenceError, SyntaxError };

pub const ERROR_CLASSES = std.enums.values(ErrorClass);

/// The `JSRTClass` descriptor a given error class is emitted against.
pub fn errorDescriptor(ctor: ErrorClass) []const u8 {
    return switch (ctor) {
        .Error => "jsrt_class_error",
        .TypeError => "jsrt_class_type_error",
        .RangeError => "jsrt_class_range_error",
        .ReferenceError => "jsrt_class_reference_error",
        .SyntaxError => "jsrt_class_syntax_error",
    };
}

const error_fields = [_]types.HField{
    .{ .name = "name", .type = H_STRING },
    .{ .name = "message", .type = H_STRING },
};

const error_types = blk: {
    var out: std.EnumArray(ErrorClass, HType) = undefined;
    for (std.enums.values(ErrorClass)) |ctor| {
        out.set(ctor, .{ .object = .{
            .name = @tagName(ctor),
            .fields = &error_fields,
            .methods = &.{},
            .bases = if (ctor == .Error) &.{} else &.{"Error"},
        } });
    }
    const frozen = out;
    break :blk frozen;
};

/// A fixed-shape object whose slots mirror the runtime layout in `jsrt_error.c`: slot 0 `name`,
/// slot 1 `message`.
pub fn errorHType(ctor: ErrorClass) *const HType {
    return error_types.getPtrConst(ctor);
}

pub const ErrorNew = struct { type: *const HType, span: Span, ctor: ErrorClass, arg: Expression };

/// The name is a string because there is no binding to point at, which is the condition modelled.
pub const ReferenceErrorRead = struct { type: *const HType, span: Span, name: []const u8 };
pub const TypeErrorThrow = struct { type: *const HType, span: Span, message: []const u8 };
pub const DateNew = struct { type: *const HType, span: Span, arg: Expression };
pub const DateComponents = struct { type: *const HType, span: Span, args: []const Expression };
pub const TypedOp = struct { type: *const HType, span: Span, op: TypedOperation, args: []const Expression };

pub const NumberOpInfo = struct { @"fn": []const u8 };

pub const NUMBER_OPS = keyof.table(NumberOpInfo, .{
    .toString = .{ .@"fn" = "jsrt_number_to_string_radix" },
    .toFixed = .{ .@"fn" = "jsrt_number_to_fixed" },
});
pub const NumberOperation = @TypeOf(NUMBER_OPS).Key;

pub const NumberOp = ReceiverOp(NumberOperation);

pub const DateOp = ReceiverOp(DateOperation);

pub const DateStaticCall = StaticCall(DateStatic);

pub const RegExpFieldResult = enum { string, number, boolean };
pub const RegExpFieldInfo = struct { result: RegExpFieldResult, flag: ?u8 = null };

/// `flag` carries the letter because the `LRE_FLAG_*` constants belong to the vendored engine's
/// header, which generated C never includes.
pub const REGEXP_FIELDS = keyof.table(RegExpFieldInfo, .{
    .source = .{ .result = .string },
    .flags = .{ .result = .string },
    .lastIndex = .{ .result = .number },
    .hasIndices = .{ .result = .boolean, .flag = 'd' },
    .global = .{ .result = .boolean, .flag = 'g' },
    .ignoreCase = .{ .result = .boolean, .flag = 'i' },
    .multiline = .{ .result = .boolean, .flag = 'm' },
    .dotAll = .{ .result = .boolean, .flag = 's' },
    .unicode = .{ .result = .boolean, .flag = 'u' },
    .unicodeSets = .{ .result = .boolean, .flag = 'v' },
    .sticky = .{ .result = .boolean, .flag = 'y' },
});
pub const RegExpField = @TypeOf(REGEXP_FIELDS).Key;

pub const RegExpFieldRead = FieldRead(RegExpField);

pub const MatchFieldResult = enum { number, string, unknown };

pub const MATCH_FIELDS = keyof.table(MatchFieldResult, .{
    .index = .number,
    .input = .string,
    .groups = .unknown,
    .length = .number,
});
pub const MatchField = @TypeOf(MATCH_FIELDS).Key;

pub const MatchRead = FieldRead(MatchField);

pub const RegExpOp = ReceiverOp(RegExpOperation);

pub const ConditionalExpr = struct {
    type: *const HType,
    span: Span,
    condition: Expression,
    consequent: Expression,
    alternate: Expression,
};

/// `base` is evaluated exactly once into a rooted frame slot; `consequent` reads it through
/// `optional_base` leaves and never runs when it is nullish.
pub const OptionalChain = struct { type: *const HType, span: Span, base: Expression, consequent: Expression };

/// Only meaningful inside an `optional_chain`; the emitter refuses one elsewhere.
pub const OptionalBase = struct { type: *const HType, span: Span };

/// `get_slot` is -1 when the property has only a setter.
pub const AccessorPlace = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    owner: []const u8,
    property: []const u8,
    get_slot: i32,
    set_slot: i32,
    dispatch: Dispatch,
    has_get: bool,
};

/// A place `++`/`--`/`+=`/`=` may read and write in expression position.
pub const UpdatePlace = union(enum) {
    identifier: *const Identifier,
    index_access: *const IndexAccess,
    field_access: *const FieldAccess,
    dyn_field_access: *const DynFieldAccess,
    accessor_place: *const AccessorPlace,

    pub fn expression(self: UpdatePlace) Expression {
        return switch (self) {
            inline else => |node, tag| @unionInit(Expression, @tagName(tag), node),
        };
    }
    /// The place an expression names, or null when it names none.
    pub fn of(expr: Expression) ?UpdatePlace {
        return switch (expr) {
            inline .identifier, .index_access, .field_access, .dyn_field_access, .accessor_place => |node, tag| @unionInit(UpdatePlace, @tagName(tag), node),
            else => null,
        };
    }
};

pub const UpdateOperator = keyof.Union(&.{ enum { @"++", @"--", @"=" }, BinaryOperator, LogicalOperator });

pub const UpdateExpr = struct {
    type: *const HType,
    span: Span,
    operator: UpdateOperator,
    prefix: bool,
    target: UpdatePlace,
    value: ?Expression = null,
};

pub const IteratorNextOp = enum { next, @"return", throw };

/// `sent` is the resume value, completion value or injected exception; absent pads `undefined`.
pub const IteratorNext = struct { type: *const HType, span: Span, target: Expression, op: IteratorNextOp, sent: Expression };

pub const GetIterator = struct { type: *const HType, span: Span, target: Expression };

pub const Expression = union(enum) {
    match_read: *const MatchRead,
    regexp_read: *const RegExpFieldRead,
    date_components: *const DateComponents,
    date_new: *const DateNew,
    error_new: *const ErrorNew,
    reference_error: *const ReferenceErrorRead,
    type_error: *const TypeErrorThrow,
    date_op: *const DateOp,
    typed_op: *const TypedOp,
    date_static: *const DateStaticCall,
    number_literal: *const NumberLiteral,
    string_literal: *const StringLiteral,
    boolean_literal: *const BooleanLiteral,
    null_literal: *const NullLiteral,
    undefined_literal: *const UndefinedLiteral,
    identifier: *const Identifier,
    binary_op: *const BinaryOp,
    unary_op: *const UnaryOp,
    typeof: *const TypeOf,
    delete_prop: *const DeleteProp,
    conditional: *const ConditionalExpr,
    optional_chain: *const OptionalChain,
    optional_base: *const OptionalBase,
    update: *const UpdateExpr,
    boundary_check: *const BoundaryCheck,
    logical_op: *const LogicalOp,
    template_literal: *const TemplateLiteral,
    string_length: *const StringLength,
    array_length: *const ArrayLength,
    function_length: *const FunctionLength,
    array_literal: *const ArrayLiteral,
    array_op: *const ArrayOp,
    json_stringify: *const JsonStringify,
    json_parse: *const JsonParse,
    object_static: *const ObjectStaticCall,
    index_access: *const IndexAccess,
    new: *const NewExpr,
    new_value: *const NewValue,
    instanceof: *const InstanceOf,
    instanceof_value: *const InstanceOfValue,
    class_value: *const ClassValue,
    field_access: *const FieldAccess,
    method_call: *const MethodCall,
    dyn_method_call: *const DynMethodCall,
    field_call: *const FieldCall,
    number_op: *const NumberOp,
    method_value: *const MethodValue,
    object_literal: *const ObjectLiteral,
    dyn_object_literal: *const DynObjectLiteral,
    dyn_field_access: *const DynFieldAccess,
    accessor_place: *const AccessorPlace,
    collection_new: *const CollectionNew,
    collection_op: *const CollectionOp,
    math_call: *const MathCall,
    string_op: *const StringOp,
    string_static: *const StringStaticCall,
    global_call: *const GlobalCall,
    regexp_literal: *const RegExpLiteral,
    regexp_op: *const RegExpOp,
    function: *const FunctionExpr,
    call: *const CallExpr,
    extern_call: *const ExternCall,
    out_new: *const OutNew,
    out_get: *const OutGet,
    await: *const AwaitExpr,
    yield: *const YieldExpr,
    promise_static: *const PromiseStaticCall,
    promise_method: *const PromiseMethodCall,
    promise_construct: *const PromiseConstruct,
    console_log: *const ConsoleLogCall,
    iterator_next: *const IteratorNext,
    get_iterator: *const GetIterator,

    pub const getType = NodeUnion(Expression).getType;
    pub const getSpan = NodeUnion(Expression).getSpan;
    pub const id = NodeUnion(Expression).id;
};

/// What `Expression` and `Statement` answer whichever node they hold: every node carries `type`
/// and `span`, and its identity is the address of the payload.
fn NodeUnion(comptime Union: type) type {
    return struct {
        pub fn getType(self: Union) *const HType {
            return switch (self) {
                inline else => |node| node.type,
            };
        }

        pub fn getSpan(self: Union) Span {
            return switch (self) {
                inline else => |node| node.span,
            };
        }

        pub fn id(self: Union) *const anyopaque {
            return switch (self) {
                inline else => |node| node,
            };
        }
    };
}

// ---------------------------------------------------------------------------------------------
// Statements

/// `while` and `do-while` differ only in their kind, which the `Statement` tag carries. `kind` is
/// kept as a declaration so each is still its own type: `json.zig` finds a node's kind by its type.
fn Loop(comptime kind: enum { @"while", do_while }) type {
    return struct {
        type: *const HType,
        span: Span,
        label: ?[]const u8 = null,
        per_iteration_env: ?bool = null,
        condition: Expression,
        body: *const Block,

        const loop = kind;
    };
}

/// `break` and `continue`, kept apart the way `Loop` keeps its two kinds apart.
fn Jump(comptime kind: enum { @"break", @"continue" }) type {
    return struct {
        type: *const HType,
        span: Span,
        label: ?[]const u8 = null,
        per_iteration_env: ?bool = null,

        const jump = kind;
    };
}

pub const SwitchClause = struct {
    /// Absent is `default`.
    @"test": ?Expression = null,
    /// Not a Block: a clause opens no scope, and its statements fall through.
    statements: []const Statement,
};

/// Tests use strict equality and `default` is tried last wherever it is written, neither of which
/// a C `switch` provides, so this lowers to a test chain plus gotos.
pub const SwitchStatement = struct {
    type: *const HType,
    span: Span,
    label: ?[]const u8 = null,
    per_iteration_env: ?bool = null,
    discriminant: Expression,
    clauses: []const SwitchClause,
};

pub const BreakStatement = Jump(.@"break");

pub const ContinueStatement = Jump(.@"continue");

pub const ThrowStatement = struct { type: *const HType, span: Span, value: Expression };

/// At least one of `catch_block`/`finally_block` is present; the verifier re-checks it.
pub const TryStatement = struct {
    type: *const HType,
    span: Span,
    try_block: *const Block,
    catch_binding: ?[]const u8 = null,
    catch_block: ?*const Block = null,
    finally_block: ?*const Block = null,
};

/// `type` equals `fn.type`: the binding and the value it holds cannot disagree.
pub const FunctionDeclaration = struct { type: *const HType, span: Span, name: []const u8, @"fn": *const FunctionExpr };

/// An absent `value` is not `value: UndefinedLiteral`: the two return the same thing but a
/// diagnostic must not point at a `return` the user did not write.
pub const ReturnStatement = struct { type: *const HType, span: Span, value: ?Expression = null };

pub const Block = struct {
    type: *const HType,
    span: Span,
    statements: []const Statement,
    /// A desugaring sequence, whose bindings leak to the enclosing statement list.
    flatten: ?bool = null,
    label: ?[]const u8 = null,
};

pub const DeclKind = enum { let, @"const" };

pub const SuperCall = struct {
    type: *const HType,
    span: Span,
    class_name: []const u8,
    receiver: Expression,
    args: []const Expression,
};

pub const Declaration = struct {
    type: *const HType,
    span: Span,
    name: []const u8,
    decl_kind: DeclKind,
    value: ?Expression = null,
};

pub const Assignment = struct { type: *const HType, span: Span, target: []const u8, value: Expression };

pub const IndexAssignment = struct { type: *const HType, span: Span, target: Expression, index: Expression, value: Expression };

pub const FieldAssignment = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    field: []const u8,
    slot: i32,
    value: Expression,
};

pub const DynFieldAssignment = struct {
    type: *const HType,
    span: Span,
    target: Expression,
    field: []const u8,
    value: Expression,
};

/// `fn`'s parameter list begins with the receiver, under a name no source can spell.
pub const ClassMethod = struct { name: []const u8, @"fn": *const FunctionExpr };

/// `fields` is in slot order and is the single source of that order.
pub const ClassDeclaration = struct {
    type: *const HType,
    span: Span,
    name: []const u8,
    base: ?[]const u8 = null,
    fields: []const Parameter,
    ctor: ?ClassMethod = null,
    methods: []const ClassMethod,
    statics: []const *const Declaration = &.{},
    static_props: []const StaticProp = &.{},
    vtable: []const VtableEntry = &.{},
};

pub const VtableEntry = struct { name: []const u8, class_name: []const u8 };

pub const StaticPropKind = enum { field, method, get, set };

pub const StaticProp = struct { name: []const u8, binding: []const u8, kind: StaticPropKind };

pub const ExpressionStatement = struct { type: *const HType, span: Span, expression: Expression };

pub const IfStatement = struct {
    type: *const HType,
    span: Span,
    condition: Expression,
    consequent: *const Block,
    alternate: ?*const Block = null,
};

pub const WhileStatement = Loop(.@"while");

pub const DoWhileStatement = Loop(.do_while);

/// An absent `condition` means `true`, not `undefined`.
pub const ForStatement = struct {
    type: *const HType,
    span: Span,
    label: ?[]const u8 = null,
    per_iteration_env: ?bool = null,
    init: ?Statement = null,
    condition: ?Expression = null,
    update: ?Statement = null,
    body: *const Block,
};

pub const IteratorView = enum { identity, keys, values, entries };

pub const ForOfStatement = struct {
    type: *const HType,
    span: Span,
    label: ?[]const u8 = null,
    per_iteration_env: ?bool = null,
    binding: []const u8,
    decl_kind: DeclKind,
    iterable: Expression,
    view: IteratorView,
    body: *const Block,
};

/// What one step of a `for-of` binds, from the iterable's HIR type and never the checker's answer
/// at the binding name: the two disagree on an evolving array that js mode widened to Unknown.
pub fn forOfElementType(iterable: *const HType, view: IteratorView) *const HType {
    switch (iterable.*) {
        .iterator => |x| return x.element,
        .string => return H_STRING,
        else => {},
    }
    if (view == .entries) return hUnknown(false); // a two-element array; the HIR has no tuple
    return switch (iterable.*) {
        .array => |x| if (view == .keys) H_NUMBER else x.element,
        .map => |x| if (view == .keys) x.key else if (view == .values) x.value else hUnknown(false),
        .set => |x| x.element,
        else => hUnknown(false),
    };
}

pub const Statement = union(enum) {
    declaration: *const Declaration,
    assignment: *const Assignment,
    index_assignment: *const IndexAssignment,
    field_assignment: *const FieldAssignment,
    dyn_field_assignment: *const DynFieldAssignment,
    super_call: *const SuperCall,
    class_declaration: *const ClassDeclaration,
    expression_statement: *const ExpressionStatement,
    if_statement: *const IfStatement,
    while_statement: *const WhileStatement,
    do_while_statement: *const DoWhileStatement,
    for_statement: *const ForStatement,
    for_of_statement: *const ForOfStatement,
    switch_statement: *const SwitchStatement,
    break_statement: *const BreakStatement,
    continue_statement: *const ContinueStatement,
    throw_statement: *const ThrowStatement,
    try_statement: *const TryStatement,
    function_declaration: *const FunctionDeclaration,
    return_statement: *const ReturnStatement,
    block: *const Block,

    pub const getType = NodeUnion(Statement).getType;
    pub const getSpan = NodeUnion(Statement).getSpan;
    pub const id = NodeUnion(Statement).id;
};

// ---------------------------------------------------------------------------------------------
// Module root

pub const Module = struct {
    type: *const HType,
    span: Span,
    /// Absolute, so the emitter can write `#line` without reaching back to a source file.
    file_name: []const u8,
    statements: []const Statement,
    /// The module body is an async unit: named bindings stay globals, temps live in a heap
    /// environment so they survive a suspension.
    is_async: bool,
    /// Laid out like a function's `env_vars`: the array position IS the slot index.
    env_vars: []const []const u8,
};

test "tables answer the way the TS tables do" {
    try std.testing.expect(stringOpCanThrow(.repeat));
    try std.testing.expect(!stringOpCanThrow(.at));
    try std.testing.expect(arrayOpCallsBack(.map));
    try std.testing.expect(!arrayOpCallsBack(.push));
    try std.testing.expectEqual(@as(?u8, 2), ARRAY_OPS.get(.lastIndexOf).max_arity);
    try std.testing.expect(isSetOperation("union"));
    try std.testing.expect(!isSetOperation("toString"));
    try std.testing.expectEqualStrings("jsrt_spread_operand", GLOBAL_CALLS.get(.@"...").@"fn");
    try std.testing.expectEqualStrings("jsrt_class_range_error", errorDescriptor(.RangeError));
}

test "console entry points map width to function" {
    try std.testing.expectEqualStrings("jsrt_print", consoleEntryPoint(.log, 1).?);
    try std.testing.expectEqualStrings("jsrt_print_many", consoleEntryPoint(.log, 3).?);
    try std.testing.expectEqualStrings("jsrt_console_group_bare", consoleEntryPoint(.group, 0).?);
    try std.testing.expect(consoleEntryPoint(.dir, 2) == null);
    try std.testing.expect(isConsoleVariadicWidth(.log, 0));
    try std.testing.expect(!isConsoleVariadicWidth(.dir, 0));
}

test "typed members resolve by class and name" {
    try std.testing.expectEqual(@as(?TypedOperation, .@"Uint8Array.prototype.set"), typedMember(.uint8array, "set"));
    try std.testing.expect(typedMember(.arraybuffer, "set") == null);
    try std.testing.expect(typedMember(.uint8array, "") == null);
}

test "error types lay out name then message and chain to Error" {
    const t = errorHType(.TypeError).object;
    try std.testing.expectEqualStrings("TypeError", t.name);
    try std.testing.expectEqualStrings("message", t.fields[1].name);
    try std.testing.expectEqualStrings("Error", t.bases[0]);
    try std.testing.expectEqual(@as(usize, 0), errorHType(.Error).object.bases.len);
}

test "for-of binds from the iterable's type" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const numbers = try types.hArray(state.allocator(), H_STRING);
    try std.testing.expect(forOfElementType(numbers, .identity).* == .string);
    try std.testing.expect(forOfElementType(numbers, .keys).* == .number);
    try std.testing.expect(forOfElementType(numbers, .entries).* == .unknown);
    try std.testing.expect(forOfElementType(H_STRING, .entries).* == .string);
}

test "extern convention matrix" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try std.testing.expect(try externConventionMismatch(arena, .void, .errno) == null);
    try std.testing.expect(try externConventionMismatch(arena, .pointer, .null) == null);
    try std.testing.expectEqualStrings(
        "the nonzero convention reads a numeric return, not 'void'",
        (try externConventionMismatch(arena, .void, .nonzero)).?,
    );
}

test "a node reads its type and span through either union" {
    const literal: NumberLiteral = .{ .type = H_NUMBER, .span = .{ .start = 1, .length = 2, .line = 3 }, .value = 0 };
    const expression: Expression = .{ .number_literal = &literal };
    try std.testing.expect(expression.getType().* == .number);
    try std.testing.expectEqual(@as(u32, 3), expression.getSpan().line);

    const identifier: Identifier = .{ .type = H_NUMBER, .span = .{ .start = 0, .length = 1, .line = 1 }, .name = "x" };
    const place: UpdatePlace = .{ .identifier = &identifier };
    try std.testing.expectEqualStrings("x", place.expression().identifier.name);
}

test "kinds that share a shape stay apart" {
    try std.testing.expect(WhileStatement != DoWhileStatement);
    try std.testing.expect(BreakStatement != ContinueStatement);
}

test "every declaration compiles" {
    std.testing.refAllDecls(@This());
    inline for (@typeInfo(Expression).@"union".field_types) |field| _ = @sizeOf(@typeInfo(field).pointer.child);
    inline for (@typeInfo(Statement).@"union".field_types) |field| _ = @sizeOf(@typeInfo(field).pointer.child);
}
