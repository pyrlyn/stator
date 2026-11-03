//! The emitter's state and the small helpers every family shares. Each family of emission lives in
//! its own file as free functions over `*Emitter`, forwarded here so a call reads `e.x(...)` the way
//! `emitter.x(...)` reads in `packages/compiler/src/codegen/emitter.ts`.
//!
//! Every string is allocated in `arena`. A failure here is a compiler bug the walk surfaced, never
//! something a source file can provoke past the gate, so it stops emission with a message
//! (`error.InternalError` plus `failure`) and the driver reports it as an STA4xxx diagnostic.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const slots = @import("slots.zig");
const closures = @import("closures.zig");
const statements = @import("statements.zig");
const expressions = @import("expressions.zig");
const runtime_calls = @import("runtime_calls.zig");
const module = @import("module.zig");

const Span = nodes.Span;

pub const Error = error{ OutOfMemory, InternalError };

/// A value plus the statements that must run ahead of it. The entries stay as they were appended,
/// so splicing them keeps the indent they were captured at.
pub const Captured = struct { lines: []const []const u8, value: []const u8 };

pub const Parts = std.ArrayList([]const u8);
pub const StringSet = std.StringArrayHashMapUnmanaged(void);
pub const SlotMap = std.StringArrayHashMapUnmanaged(usize);
pub const HiddenMethods = std.StringArrayHashMapUnmanaged(usize);

/// Node identity, as a TS `Map` keyed by object. A re-`put` overwrites: an inlined body is one node
/// emitted once per call site, and the last count wins there too.
pub const SlotIds = std.AutoHashMapUnmanaged(*const anyopaque, usize);

pub const TemplateSlots = struct { base: usize, count: usize };

pub const SpreadState = struct {
    at: std.StringArrayHashMapUnmanaged(usize) = .empty,
    target: std.StringArrayHashMapUnmanaged(nodes.Expression) = .empty,
    done: StringSet = .empty,
};

pub const SpreadRead = struct { slot: ?[]const u8, flushed: bool };

pub const FunctionUnit = struct {
    id: usize,
    @"fn": *const nodes.FunctionExpr,
    name: []const u8,
};

pub const RouteAction = union(enum) {
    loop_jump: struct { name: []const u8, target_index: usize, span: Span },
    return_jump: Span,
};

pub const Route = struct { code: usize, action: RouteAction };

pub const TryFinallyScope = struct {
    comp_var: []const u8,
    comp_boxed: bool,
    fin_label: []const u8,
    enclosing_depth: usize,
    routes: std.StringArrayHashMapUnmanaged(Route) = .empty,
};

pub const Enclosing = struct {
    id: usize,
    is_loop: bool,
    label: ?[]const u8 = null,
    iter_env: bool = false,
};

pub const Emitter = @This();

arena: Allocator,
/// The message behind the last `error.InternalError`.
failure: []const u8 = "",

lines: std.ArrayList([]const u8) = .empty,
indent: usize = 0,
slot_map: *SlotMap,
temp_slots: SlotIds = .empty,
optional_base_stack: std.ArrayList([]const u8) = .empty,
binary_slots: SlotIds = .empty,
template_slots: std.AutoHashMapUnmanaged(*const anyopaque, TemplateSlots) = .empty,
switch_slots: SlotIds = .empty,
call_slots: SlotIds = .empty,
ic_count: usize = 0,
extern_decls: std.StringArrayHashMapUnmanaged([]const u8) = .empty,
extern_errno: bool = false,
extern_stdlib: bool = false,
extern_headers: std.ArrayList([]const u8) = .empty,
extern_header_covered: StringSet = .empty,
classes: std.ArrayList(*const nodes.ClassDeclaration) = .empty,
class_ids: std.StringArrayHashMapUnmanaged(usize) = .empty,
class_key_orders: std.AutoArrayHashMapUnmanaged(usize, []const usize) = .empty,
class_hidden_methods: std.StringArrayHashMapUnmanaged(HiddenMethods) = .empty,
array_slots: SlotIds = .empty,
index_slots: SlotIds = .empty,
for_of_slots: SlotIds = .empty,
for_of_close_slots: SlotIds = .empty,
slot_count: usize = 0,
global_map: *SlotMap,
global_count: usize = 0,
in_function: bool = false,
env_map: SlotMap = .empty,
capture_map: std.StringArrayHashMapUnmanaged(nodes.EnvCapture) = .empty,
return_slot: usize = 0,
returns_value: bool = false,
in_async: bool = false,
module_async: bool = false,
in_generator: bool = false,
await_states: std.AutoArrayHashMapUnmanaged(*const anyopaque, usize) = .empty,
used_async: bool = false,
functions: std.ArrayList(FunctionUnit) = .empty,
function_ids: SlotIds = .empty,
file_name: []const u8 = "",
enclosing: std.ArrayList(Enclosing) = .empty,
loop_count: usize = 0,
iter_env_slots: SlotIds = .empty,
iter_env_base: std.AutoHashMapUnmanaged(usize, usize) = .empty,
spread_order_count: usize = 0,
extern_site_count: usize = 0,
used_labels: StringSet = .empty,
pad_stack: std.ArrayList([]const u8) = .empty,
unwind_used: bool = false,
try_finally_stack: std.ArrayList(*TryFinallyScope) = .empty,
try_count: usize = 0,
try_slots: SlotIds = .empty,

pub fn init(arena: Allocator) Allocator.Error!Emitter {
    const slot_map = try arena.create(SlotMap);
    slot_map.* = .empty;
    return .{ .arena = arena, .slot_map = slot_map, .global_map = slot_map };
}

pub fn newSlotMap(e: *Emitter) Error!*SlotMap {
    const map = try e.arena.create(SlotMap);
    map.* = .empty;
    return map;
}

pub fn fail(e: *Emitter, comptime format: []const u8, args: anytype) Error {
    e.failure = std.fmt.allocPrint(e.arena, format, args) catch return error.OutOfMemory;
    return error.InternalError;
}

pub fn fmt(e: *Emitter, comptime format: []const u8, args: anytype) Error![]const u8 {
    return std.fmt.allocPrint(e.arena, format, args);
}

pub fn join(e: *Emitter, items: []const []const u8) Error![]const u8 {
    return std.mem.join(e.arena, ", ", items);
}

pub fn line(e: *Emitter, span: ?Span, comptime format: []const u8, args: anytype) Error!void {
    return e.appendLine(try e.fmt(format, args), span);
}

pub fn openBlock(e: *Emitter, opener: []const u8, span: ?Span) Error!void {
    try e.appendLine(opener, span);
    e.indent += 1;
}

pub fn closeBlock(e: *Emitter, span: ?Span) Error!void {
    e.indent -= 1;
    try e.appendLine("}", span);
}

/// A top-level C definition ends with a blank line before the next one.
pub fn closeDefinition(e: *Emitter) Error!void {
    try e.closeBlock(null);
    try e.appendLine("", null);
}

pub fn pushLines(e: *Emitter, lines: []const []const u8) Error!void {
    try e.lines.appendSlice(e.arena, lines);
}

pub fn useLabel(e: *Emitter, name: []const u8) Error!void {
    try e.used_labels.put(e.arena, name, {});
}

pub fn labelUsed(e: *const Emitter, name: []const u8) bool {
    return e.used_labels.contains(name);
}

pub fn slotOf(e: *Emitter, map: anytype, key: *const anyopaque, message: []const u8) Error!usize {
    return map.get(key) orelse e.fail("{s}", .{message});
}

pub fn threaded(e: *const Emitter) bool {
    return e.extern_decls.contains("jsrt_thread_spawn");
}

pub const bindSlot = slots.bindSlot;
pub const countBindings = slots.countBindings;
pub const spreadSource = slots.spreadSource;
pub const countEntryValue = slots.countEntryValue;
pub const countRooted = slots.countRooted;
pub const countExpression = slots.countExpression;
pub const countIterEnvSlots = slots.countIterEnvSlots;
pub const slotAt = slots.slotAt;
pub const slotRef = slots.slotRef;
pub const appendLine = slots.appendLine;

pub const emitFunctionUnits = closures.emitFunctionUnits;
pub const emitFunctionUnit = closures.emitFunctionUnit;
pub const emitScope = closures.emitScope;
pub const emitNamedFunctionSelfBinding = closures.emitNamedFunctionSelfBinding;
pub const emitHoistedFunctions = closures.emitHoistedFunctions;
pub const registerFunction = closures.registerFunction;
pub const functionId = closures.functionId;
pub const emitSyncUnit = closures.emitSyncUnit;
pub const emitAsyncUnit = closures.emitAsyncUnit;
pub const emitGeneratorUnit = closures.emitGeneratorUnit;
pub const emitSuspendEntry = closures.emitSuspendEntry;
pub const emitResumeOpen = closures.emitResumeOpen;
pub const emitResumeBody = closures.emitResumeBody;
pub const suspendSlot = closures.suspendSlot;
pub const emitPark = closures.emitPark;
pub const emitAsyncSettle = closures.emitAsyncSettle;
pub const emitGeneratorSettle = closures.emitGeneratorSettle;
pub const emitParameterPrologue = closures.emitParameterPrologue;
pub const currentEnv = closures.currentEnv;
pub const closureValue = closures.closureValue;

pub const emitStatement = statements.emitStatement;
pub const emitMapSetForOf = statements.emitMapSetForOf;
pub const emitArrayForOfYield = statements.emitArrayForOfYield;
pub const emitMapSetForOfYield = statements.emitMapSetForOfYield;
pub const forOfIsBoxed = statements.forOfIsBoxed;
pub const emitBoxedIteratorForOf = statements.emitBoxedIteratorForOf;
pub const enterLoop = statements.enterLoop;
pub const enterBreakable = statements.enterBreakable;
pub const iterEnvOf = statements.iterEnvOf;
pub const frameEnvLine = statements.frameEnvLine;
pub const iterEnvState = statements.iterEnvState;
pub const emitIterEnvOpen = statements.emitIterEnvOpen;
pub const emitIterEnvSwap = statements.emitIterEnvSwap;
pub const commitIterEnvs = statements.commitIterEnvs;
pub const emitJumpTarget = statements.emitJumpTarget;
pub const currentPad = statements.currentPad;
pub const emitLoopJump = statements.emitLoopJump;
pub const emitReturnJump = statements.emitReturnJump;
pub const runRoute = statements.runRoute;
pub const routeJump = statements.routeJump;
pub const emitTry = statements.emitTry;
pub const emitTryCatch = statements.emitTryCatch;
pub const emitTryFinally = statements.emitTryFinally;
pub const emitCatchEntry = statements.emitCatchEntry;
pub const emitSwitch = statements.emitSwitch;

pub const emitFieldWrite = expressions.emitFieldWrite;
pub const emitExpression = expressions.emitExpression;
pub const registerShape = expressions.registerShape;
pub const methodOf = expressions.methodOf;
pub const methodCallee = expressions.methodCallee;
pub const methodIdOrNull = expressions.methodIdOrNull;
pub const baseDescriptor = expressions.baseDescriptor;
pub const classAt = expressions.classAt;
pub const emitTemplateLiteral = expressions.emitTemplateLiteral;
pub const emitToNumber = expressions.emitToNumber;
pub const emitBinaryOp = expressions.emitBinaryOp;
pub const emitStringLiteral = expressions.emitStringLiteral;
pub const emitLogicalOp = expressions.emitLogicalOp;
pub const emitConditional = expressions.emitConditional;
pub const emitOptionalChain = expressions.emitOptionalChain;
pub const emitOptionalBase = expressions.emitOptionalBase;
pub const emitUpdate = expressions.emitUpdate;

pub const emitPendingCheck = runtime_calls.emitPendingCheck;
pub const captureExpression = runtime_calls.captureExpression;
pub const sequencePart = runtime_calls.sequencePart;
pub const sequenceAssign = runtime_calls.sequenceAssign;
pub const flushParts = runtime_calls.flushParts;
pub const arrayOpCall = runtime_calls.arrayOpCall;
pub const sequenceArgs = runtime_calls.sequenceArgs;
pub const finishSequenced = runtime_calls.finishSequenced;
pub const beginCall = runtime_calls.beginCall;
pub const finishOp = runtime_calls.finishOp;
pub const finishStatement = runtime_calls.finishStatement;
pub const emitExternCall = runtime_calls.emitExternCall;
pub const consoleSlots = runtime_calls.consoleSlots;
pub const consoleCall = runtime_calls.consoleCall;
pub const icSite = runtime_calls.icSite;
pub const callLocation = runtime_calls.callLocation;
pub const recordExternDecl = runtime_calls.recordExternDecl;

pub const emitModuleEnv = module.emitModuleEnv;
pub const emitSyncTopLevelStatements = module.emitSyncTopLevelStatements;
pub const emitMicrotaskDrain = module.emitMicrotaskDrain;
pub const emitMain = module.emitMain;
pub const emitMainEntry = module.emitMainEntry;
pub const emitAsyncModule = module.emitAsyncModule;
pub const countAsyncModule = module.countAsyncModule;
pub const emitModuleDoneMain = module.emitModuleDoneMain;
pub const emitAsyncModuleForward = module.emitAsyncModuleForward;
pub const emitAsyncModuleBody = module.emitAsyncModuleBody;
pub const emitLibrary = module.emitLibrary;
pub const emitExportConstDefs = module.emitExportConstDefs;
pub const emitErrorCell = module.emitErrorCell;
pub const emitExportConstStores = module.emitExportConstStores;
pub const exportSlot = module.exportSlot;
pub const emitInitOpen = module.emitInitOpen;
pub const emitLibraryInitSync = module.emitLibraryInitSync;
pub const emitInitDone = module.emitInitDone;
pub const emitAsyncModuleRun = module.emitAsyncModuleRun;
pub const emitLibraryInitAsync = module.emitLibraryInitAsync;
pub const emitExportStub = module.emitExportStub;
