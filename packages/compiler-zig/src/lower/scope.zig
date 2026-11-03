//! Lexical bindings during lowering. A name's HIR spelling and its type are kept apart so two
//! JavaScript scopes that reuse a name stay two storage locations in one C scope.
const std = @import("std");
const Allocator = std.mem.Allocator;
const hir = @import("../hir/types.zig");
const HType = hir.HType;

fn oom() noreturn {
    @panic("out of memory");
}

const NameSet = std.StringHashMapUnmanaged(void);

pub const SHADOW_TAG = "shadow:";

/// The source name a shadow HIR name was minted for, or null for a name `declare` did not shadow.
/// No identifier holds U+0000, so a leading NUL is unambiguous; the counter is cut at the last `#`.
pub fn shadowSource(name: []const u8) ?[]const u8 {
    if (name.len == 0 or name[0] != 0 or !std.mem.startsWith(u8, name[1..], SHADOW_TAG)) return null;
    const hash = std.mem.lastIndexOfScalar(u8, name, '#') orelse return null;
    if (hash < 1 + SHADOW_TAG.len) return null;
    return name[1 + SHADOW_TAG.len .. hash];
}

pub const Scope = struct {
    a: Allocator,
    own_types: std.StringHashMapUnmanaged(*const HType) = .empty,
    own_hir_names: std.StringHashMapUnmanaged([]const u8) = .empty,
    declared_here: NameSet = .empty,
    /// Shared by every block of one function: C has no block-level redeclaration across hoists.
    unit_declared: *NameSet,
    claimed: NameSet = .empty,
    parent: ?*Scope,
    shadow_counter: *u32,

    fn make(a: Allocator, parent: ?*Scope, unit: *NameSet, counter: *u32) *Scope {
        const s = a.create(Scope) catch oom();
        s.* = .{ .a = a, .unit_declared = unit, .parent = parent, .shadow_counter = counter };
        return s;
    }

    fn newUnit(a: Allocator) *NameSet {
        const unit = a.create(NameSet) catch oom();
        unit.* = .empty;
        return unit;
    }

    pub fn root(a: Allocator, counter: *u32) *Scope {
        return make(a, null, newUnit(a), counter);
    }

    pub fn child(s: *Scope) *Scope {
        return make(s.a, s, s.unit_declared, s.shadow_counter);
    }

    pub fn functionScope(s: *Scope) *Scope {
        return make(s.a, s, newUnit(s.a), s.shadow_counter);
    }

    pub fn claim(s: *Scope, names: []const []const u8) void {
        for (names) |name| {
            s.claimed.put(s.a, name, {}) catch oom();
            s.unit_declared.put(s.a, name, {}) catch oom();
        }
    }

    pub fn alias(s: *Scope, name: []const u8, hir_name: []const u8, t: *const HType) void {
        s.own_types.put(s.a, name, t) catch oom();
        s.own_hir_names.put(s.a, name, hir_name) catch oom();
    }

    pub fn declaredInUnit(s: *const Scope, name: []const u8) bool {
        return s.unit_declared.contains(name);
    }

    pub fn has(s: *const Scope, name: []const u8) bool {
        var at: ?*const Scope = s;
        while (at) |x| : (at = x.parent) if (x.own_types.contains(name)) return true;
        return false;
    }

    pub fn get(s: *const Scope, name: []const u8) ?*const HType {
        var at: ?*const Scope = s;
        while (at) |x| : (at = x.parent) if (x.own_types.get(name)) |t| return t;
        return null;
    }

    pub fn hirName(s: *const Scope, name: []const u8) []const u8 {
        var at: ?*const Scope = s;
        while (at) |x| : (at = x.parent) if (x.own_hir_names.get(name)) |h| return h;
        return name;
    }

    pub fn set(s: *Scope, name: []const u8, t: *const HType) void {
        s.alias(name, name, t);
    }

    pub fn declare(s: *Scope, name: []const u8, t: *const HType) []const u8 {
        const same_scope = s.declared_here.contains(name);
        const second_home = !same_scope and !s.claimed.contains(name) and (s.has(name) or s.unit_declared.contains(name));
        const hir_name = if (second_home) s.shadowName(name) else s.hirName(name);
        s.declared_here.put(s.a, name, {}) catch oom();
        s.unit_declared.put(s.a, name, {}) catch oom();
        s.alias(name, hir_name, t);
        return hir_name;
    }

    fn shadowName(s: *Scope, source: []const u8) []const u8 {
        s.shadow_counter.* += 1;
        return std.fmt.allocPrint(s.a, "\x00" ++ SHADOW_TAG ++ "{s}#{d}", .{ source, s.shadow_counter.* }) catch oom();
    }
};
