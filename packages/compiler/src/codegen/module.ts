/* module emission for the C emitter (T24 split). */

import type { Emitter } from './emitter.ts';
import type { Module, Span } from '../hir/nodes.ts';
import type { LibraryEmit } from './types.ts';
import { cNameLiteral, closureMeta, descriptorName } from './helpers.ts';
import type { ExportedFunction } from '../frontend/export.ts';
import { exportInitName, exportLastErrorName } from '../frontend/export.ts';

export function emit(emitter: Emitter, module: Module, library?: LibraryEmit): string {
  emitter.fileName = module.fileName;
  emitter.slotMap = new Map();
  emitter.tempSlots.clear();
  emitter.binarySlots.clear();
  emitter.templateSlots.clear();
  emitter.switchSlots.clear();
  emitter.callSlots.clear();
  emitter.classes = [];
  emitter.classIds.clear();
  emitter.classHiddenMethods.clear();
  emitter.slotCount = 0;
  emitter.globalMap = new Map();
  emitter.globalCount = 0;
  emitter.inFunction = false;
  emitter.moduleAsync = false;
  emitter.envMap = new Map();
  emitter.captureMap = new Map();
  emitter.returnSlot = 0;
  emitter.functions = [];
  emitter.functionIds.clear();
  emitter.externDecls.clear();
  emitter.externErrno = false;
  emitter.externStdlib = false;
  emitter.externHeaders = [];
  emitter.externHeaderCovered.clear();
  emitter.enclosing = [];
  emitter.loopCount = 0;
  emitter.spreadOrderCount = 0;
  emitter.externSiteCount = 0;
  emitter.usedLabels.clear();
  emitter.padStack = [];
  emitter.unwindUsed = false;
  emitter.tryFinallyStack = [];
  emitter.tryCount = 0;
  emitter.trySlots.clear();
  emitter.lines = [];
  emitter.indent = 0;

  // Seeded BEFORE counting, because `bindSlot` skips a name that already has an environment
  // home: a per-iteration top-level binding must not also get a global slot, or the loop would
  // update one copy while every closure read the other.
  emitter.envMap = new Map(module.envVars.map((name, index) => [name, index]));
  // The module's own bindings are counted first and become the globals; counting also assigns
  // every function its id, which the closure references below depend on.
  emitter.countBindings(module.statements);
  emitter.globalMap = emitter.slotMap;
  emitter.globalCount = emitter.slotCount;
  // A library build roots one scratch global past the module's own bindings (steps 3–5):
  // the init error stash and every `jsrt_value`-returning stub's last result share it —
  // init runs once before any stub, so the two uses never overlap. It starts UNDEFINED,
  // a valid non-pointer value, so the collector never reads garbage through it.
  const exportScratch = library === undefined ? 0 : emitter.globalCount;
  // A zero-length array is not valid C11, and a program with no module-level binding is.
  const globalSlots = Math.max(emitter.globalCount + (library === undefined ? 0 : 1), 1);

  const functionLines = emitter.emitFunctionUnits();
  const mainLines =
    library === undefined
      ? emitter.emitMain(module, globalSlots)
      : emitter.emitLibrary(module, library, globalSlots, exportScratch);

  const out: string[] = ['#include "jsrt_value.h"'];
  // The extern prologue, if the module called out (docs/FFI.md §§1, 9): `<errno.h>` only for
  // the convention that reads it, `<stdlib.h>` only for the borrow the emitter frees, then
  // the binding headers step 7's pragma names — runtime headers FIRST, so a binding header
  // can rely on the standard types — and one forward declaration per C symbol without one.
  // A symbol WITH a header gets no declaration here: the header's real prototype governs the
  // call, and a second, `void *`-based spelling next to it would be a conflicting-types
  // error rather than a declaration.
  if (emitter.externErrno) {
    out.push('#include <errno.h>');
  }
  // `<stdlib.h>` for the borrow the emitter frees — and always in a library build, where
  // the error cell is freed; `<stdbool.h>` for the init guard a library build always emits.
  // An executable build includes each only for the extern call that needs it, so its
  // prologue stays byte-identical when no externs are in play.
  if (emitter.externStdlib || library !== undefined) {
    out.push('#include <stdlib.h>');
  }
  if (library !== undefined) {
    out.push('#include <stdbool.h>');
  }
  for (const header of emitter.externHeaders) {
    out.push(`#include ${header}`);
  }
  out.push('', `JSRT_GLOBALS(${globalSlots});`, '');
  // Forward declarations ahead of every definition, so a function can call itself, or one
  // declared further down the file.
  for (const unit of emitter.functions) {
    out.push(
      `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);`,
    );
    // Not `const`: an ordinary function's `prototype` and own properties are written into its
    // closure on first use (plan-notes 310), and writing a `const` object is undefined behavior.
    out.push(
      `static JSRTClosure _jsrt_closure_${unit.id} = {_jsrt_fn_${unit.id}, ` +
        `${closureMeta(unit.fn).arity}, ${cNameLiteral(unit.name)}, NULL, ${closureMeta(unit.fn).hasReceiver ? 'true' : 'false'}, NULL, ${unit.fn.constructible === true ? 'true' : 'false'}};`,
    );
  }
  if (emitter.functions.length > 0) {
    out.push('');
  }
  // One descriptor per class, shared by every instance: the name printed by console.log, the
  // slot count, the field names in slot order, the base's descriptor, and the method table.
  // `const` and file-scope, so it costs nothing per object and `instanceof` is a pointer
  // comparison. It follows the closure constants because a method table names them.
  //
  // A descriptor takes the ADDRESS of its base's, so the base's must already be declared. It
  // always is, and not by luck: `emitter.classes` is in source order, and a base whose declaration
  // followed its subclass would be a temporal-dead-zone error the frontend never accepts. The
  // lookup below asserts that rather than assuming it.
  for (const [id, cls] of emitter.classes.entries()) {
    // A zero-length array is not valid C11, and a class with no fields is valid TypeScript. The
    // count is what readers use, so the unread placeholder is harmless.
    const names =
      cls.fields.length === 0 ? '""' : cls.fields.map((f) => cNameLiteral(f.name)).join(', ');
    out.push(`static const char *const _jsrt_fields_${id}[] = {${names}};`);
    if (cls.vtable.length > 0) {
      const entries = cls.vtable.map((entry) => {
        const id = emitter.methodIdOrNull(entry);
        return id === null ? 'NULL' : `&_jsrt_closure_${id}`;
      });
      out.push(`static const JSRTClosure *const _jsrt_methods_${id}[] = {${entries.join(', ')}};`);
      const methodNames = cls.vtable.map((entry) => cNameLiteral(entry.name)).join(', ');
      out.push(`static const char *const _jsrt_method_names_${id}[] = {${methodNames}};`);
    }
    const table =
      cls.vtable.length === 0
        ? '0, NULL, NULL'
        : `${cls.vtable.length}, _jsrt_methods_${id}, _jsrt_method_names_${id}`;
    // Absent unless the literal's key order differs from its layout: a class declaration lays
    // its fields out in the order it writes them, so identity is the overwhelming case.
    const keyOrder = emitter.classKeyOrders.get(id);
    if (keyOrder !== undefined) {
      out.push(`static const uint32_t _jsrt_keys_${id}[] = {${keyOrder.map(String).join(', ')}};`);
    }
    out.push(
      `static const JSRTClass _jsrt_class_${id} = {${cNameLiteral(descriptorName(cls.name))}, ` +
        `${cls.fields.length}, _jsrt_fields_${id}, ${emitter.baseDescriptor(cls, id)}, ${table}, ` +
        `${keyOrder === undefined ? 'NULL' : `_jsrt_keys_${id}`}, NULL};`,
    );
    // The class OBJECT (docs/VALUE.md §4.17): the closure-shaped value a class evaluates
    // to. Its `fn` is the constructor (NULL when the class declares none), reachable only
    // through `jsrt_construct`; its `klass` is this descriptor, which is how the runtime
    // answers `.name`/`.length`/`typeof`, statics, and value dispatch. A capturing ctor
    // has no file-static `_jsrt_closure_N` — but the gate refuses class values for classes
    // whose evaluation can repeat, which is exactly the surface that could capture here.
    out.push(
      `static const JSRTClosure _jsrt_class_object_${id} = {${cls.ctor === undefined ? 'NULL' : `_jsrt_fn_${String(emitter.functionId(cls.ctor.fn))}`}, ` +
        `${cls.ctor === undefined ? 0 : String(closureMeta(cls.ctor.fn).arity)}, ${cNameLiteral(descriptorName(cls.name))}, NULL, false, &_jsrt_class_${id}};`,
    );
  }
  if (emitter.classes.length > 0) {
    out.push('');
  }
  // One static cache per dynamic property site, zero-initialized: a NULL shape is the empty
  // cache, so no runtime setup is needed and the first access at each site fills it.
  for (let i = 0; i < emitter.icCount; i++) {
    out.push(`static JSRTIC _jsrt_ic_${String(i)};`);
  }
  if (emitter.icCount > 0) {
    out.push('');
  }
  // One forward declaration per extern C symbol the module calls, derived from the kinds the
  // counting pass recorded — argument C types left to right, `(void)` for an empty list. A
  // duplicate C name keeps its first declaration: two inconsistent declarations of one symbol
  // would already have failed the gate, so what survives here agrees.
  for (const decl of emitter.externDecls.values()) {
    out.push(decl);
  }
  if (emitter.externDecls.size > 0) {
    out.push('');
  }
  // Appended one line at a time, never spread: `functionLines` is the whole program's emitted
  // code, and `push(...arr)` passes every element as an argument — which blows the engine's
  // argument limit (RangeError) somewhere around a 100k-line input, in the emitter, on a program
  // the front end accepted. Same reason as the loop in `emitFunctionUnits`.
  for (const line of functionLines) {
    out.push(line);
  }
  for (const line of mainLines) {
    out.push(line);
  }

  return `${out.join('\n')}\n`;
}

/* The module's own environment, when a top-level loop declares a `let`/`const` a closure
 * captures (docs/VALUE.md §4.3). Rooted through the globals frame, which is pushed once and
 * never popped -- the module environment has to outlive main's locals for the same reason
 * the globals array does. Shared by `main` and the library init: the body they both run
 * reads the same bindings (plan.md §10 Task 7.2 step 3 reuses this path, never a second). */

export function emitModuleEnv(emitter: Emitter, module: Module): void {
  if (module.envVars.length > 0) {
    emitter.appendLine(
      `JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(module.envVars.length)});`,
      module.span,
    );
    emitter.appendLine('JSRT_GLOBALS_ENV(_jsrt_env);', module.span);
  }
}

/* The merged module's top-level statements in Task 3.11 order, hoisted functions first
 * (so `f(); function f() {}` resolves). The one body both `main` and `stator_init_<unit>`
 * run: a library init is the same side effects in the same order, not a second copy. */

export function emitSyncTopLevelStatements(emitter: Emitter, module: Module): void {
  emitter.emitHoistedFunctions(module.statements);
  for (const stmt of module.statements) {
    emitter.emitStatement(stmt);
  }
}

/* Everything a promise queued runs before the program exits -- that is the whole of the job
 * queue's observable behaviour for a program with no other event source. Emitted only when
 * the module actually promised, so a program that never did does not link the driver in.
 * Shared by `main` and the library init, which drains what the top level queued the same way. */

export function emitMicrotaskDrain(emitter: Emitter, module: Module): void {
  if (emitter.usedAsync) {
    emitter.appendLine('jsrt_run_microtasks();', module.span);
  }
}

/** Resets module-level emission state and returns the buffer `main` / a library init will fill. */
function beginModuleUnits(emitter: Emitter): string[] {
  const produced: string[] = [];
  emitter.lines = produced;
  emitter.indent = 0;
  emitter.inFunction = false;
  emitter.slotMap = emitter.globalMap;
  emitter.slotCount = emitter.globalCount;
  emitter.padStack = [];
  emitter.unwindUsed = false;
  emitter.tryFinallyStack = [];
  emitter.tryCount = 0;
  return produced;
}

export function emitMain(emitter: Emitter, module: Module, globalSlots: number): string[] {
  const produced = beginModuleUnits(emitter);

  if (module.isAsync) {
    emitter.emitAsyncModule(module, globalSlots);
    return produced;
  }

  emitter.emitMainEntry(module, globalSlots);
  emitter.emitModuleEnv(module);
  emitter.emitSyncTopLevelStatements(module);
  emitter.emitMicrotaskDrain(module);
  // No pop: the globals frame is pushed once and lives as long as the program does.
  emitter.appendLine('return (int)jsrt_process_exit_code();', module.span);
  if (emitter.unwindUsed) {
    // An exception no try caught: report on stderr and exit(1), which is what Node does.
    emitter.appendLine('_jsrt_unwind: ;', module.span);
    emitter.appendLine('jsrt_uncaught();', module.span);
  }
  emitter.indent--;
  emitter.appendLine('}');

  return produced;
}

/* The program entry both module shapes share. `main` keeps its argument vector for
 * `std/process.argv` before any module code runs, and returns the status `std/process`'s
 * `setExitCode` left (0 unless a program set one; docs/STD.md §5). */

export function emitMainEntry(emitter: Emitter, module: Module, globalSlots: number): void {
  emitter.appendLine('int main(int argc, char **argv) {');
  emitter.indent++;
  emitter.appendLine('jsrt_init();', module.span);
  emitter.appendLine('jsrt_process_args(argc, argv);', module.span);
  emitter.appendLine(`JSRT_GLOBALS_ENTER(${globalSlots});`, module.span);
}

/* A module with a top-level await is an async unit (Phase 5 step 9). Named bindings stay in
 * the globals array so the rest of the program still reads JSRT_GLOBAL; temps and await state
 * live in a heap environment because a suspension pops main's C frame. Init runs in Task 3.11's
 * topological order — Stator does not interleave sibling subgraphs the way Node does. */

export function emitAsyncModule(emitter: Emitter, module: Module, globalSlots: number): void {
  const envSlots = emitter.countAsyncModule(module);
  emitter.emitModuleDoneMain();
  emitter.emitAsyncModuleForward();

  emitter.emitMainEntry(module, globalSlots);
  emitter.emitAsyncModuleRun(module, envSlots, '_jsrt_module_done');
  emitter.appendLine('return (int)jsrt_process_exit_code();', module.span);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');

  emitter.emitAsyncModuleBody(module);
}

/* The async module's counting half: the heap-environment layout the resume body reads, with
 * the suspension-surviving locals numbered past the module's captured per-iteration bindings
 * (see the layout note it keeps). Split out because the library init counts the same module
 * before running `main`'s startup sequence with init semantics instead. */

export function countAsyncModule(emitter: Emitter, module: Module): number {
  emitter.usedAsync = true;
  emitter.moduleAsync = true;
  emitter.inAsync = true;
  emitter.inFunction = true;
  emitter.slotMap = new Map();
  // Same layout an async FUNCTION uses (see emitFunctionUnit): the module's captured
  // per-iteration bindings own env indices 0..envVars.length-1, and the suspension-surviving
  // locals are numbered past them into the same environment. One env, two tenants -- which is
  // why the per-iteration clone works here unchanged.
  emitter.envMap = new Map(module.envVars.map((name, index) => [name, index]));
  emitter.slotCount = module.envVars.length;
  emitter.captureMap = new Map();
  emitter.awaitStates = new Map();
  emitter.returnsValue = true;
  emitter.countBindings(module.statements);
  emitter.returnSlot = emitter.slotCount;
  emitter.slotCount++;
  return Math.max(1, emitter.slotCount);
}

/* `main`'s settlement observer: a rejected module body rethrows into the pending cell and
 * exits(1) via `jsrt_uncaught` — the process answer, not a library's (compare
 * `emitInitDone`, which parks the reason for the init to capture instead). */

export function emitModuleDoneMain(emitter: Emitter): void {
  emitter.appendLine(
    'static void _jsrt_module_done(void *state, jsrt_value value, bool rejected) {',
  );
  emitter.indent++;
  emitter.appendLine('(void)state;');
  emitter.appendLine('if (rejected) {');
  emitter.indent++;
  emitter.appendLine('jsrt_throw(value);');
  emitter.appendLine('jsrt_uncaught();');
  emitter.indent--;
  emitter.appendLine('}');
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

export function emitAsyncModuleForward(emitter: Emitter): void {
  emitter.appendLine(
    'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);',
  );
  emitter.appendLine('');
}

/* The resume function holding the module body itself, shared by `main` and the library
 * init: each `await` pops the frame and each resumption re-enters from the top. */

export function emitAsyncModuleBody(emitter: Emitter, module: Module): void {
  emitter.appendLine(
    'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {',
  );
  emitter.indent++;
  emitter.emitResumeOpen(module.span, ['_jsrt_v', '_jsrt_err']);
  for (const stmt of module.statements) {
    emitter.emitStatement(stmt);
  }
  emitter.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', module.span);
  if (emitter.unwindUsed) {
    emitter.appendLine('_jsrt_unwind: ;', module.span);
    emitter.appendLine(
      `${emitter.slotAt(emitter.returnSlot)} = jsrt_take_exception();`,
      module.span,
    );
    emitter.emitAsyncSettle('jsrt_async_throw', emitter.slotAt(emitter.returnSlot), module.span);
  }
  emitter.indent--;
  emitter.appendLine('}');
}

/* The `--emit-header` object tail (plan.md §10 Task 7.2 steps 3–5): no `main` — linking is
 * the consumer's job — but the init contract, the error cell, the exported consts, and one
 * stub per exported function, in that file order. State reset mirrors `emitMain`: the
 * function units above saved and restored everything they touched, so the module level is
 * pristine here exactly as it is there. */

export function emitLibrary(
  emitter: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  scratch: number,
): string[] {
  const produced = beginModuleUnits(emitter);

  emitter.emitExportConstDefs(library);
  emitter.emitErrorCell(library);
  if (module.isAsync) {
    const envSlots = emitter.countAsyncModule(module);
    emitter.emitInitDone(scratch);
    emitter.emitAsyncModuleForward();
    emitter.emitLibraryInitAsync(module, library, globalSlots, envSlots, scratch);
    emitter.emitAsyncModuleBody(module);
  } else {
    emitter.emitLibraryInitSync(module, library, globalSlots, scratch);
  }
  for (const fn of library.exports.functions) {
    emitter.emitExportStub(library, fn, scratch, module.span);
  }
  return produced;
}

/* One file-scope definition per exported const. Mutable here and stored by init AFTER the
 * body populated the globals — a `const`-qualified definition could not be stored at all,
 * and a literals-only rule would refuse computed primitives the gate accepts. The header
 * stays `extern const`: that is the consumer's view (never write through it), and reading
 * through a qualified version of the effective type is sound (C11 6.5p7). No TU ever sees
 * both spellings, so `-Werror` stays silent. Zero-initialized until init stores: calling
 * before init is UB by the header, so no path reads these first. */

export function emitExportConstDefs(emitter: Emitter, library: LibraryEmit): void {
  if (library.exports.consts.length === 0) {
    return;
  }
  emitter.appendLine('/* Exported consts: C views of module globals, stored by the init below. */');
  for (const constant of library.exports.consts) {
    emitter.appendLine(`${constant.cType} ${constant.cName};`);
  }
  emitter.appendLine('');
}

/* The step-4 error cell (plan.md §10 Task 7.2 step 4): what C sees when TS throws. One
 * malloc-owned message per unit, thread-local like the pending cell it renders from, NULL
 * when the last call succeeded. Cleared on every stub entry; captured on every stub
 * failure. Capture is total: the value arrives already rooted in the caller's frame (a
 * frame slot or the scratch global — never a bare C local across the `to_string`
 * allocation). `jsrt_to_string` runs the thrown object's own `toString` (plan.md §9 Task
 * 6.27), which may throw in turn: that second exception is dropped and the message falls back
 * to the builtin form, so nothing on this path can throw past the stub. The accessor
 * hands out the cell WITHOUT transferring it: valid until the next exported call, which
 * clears or replaces it — the same rule a `const char *` answer's ownership does NOT
 * follow (that one is malloc-owned per call and the caller frees it). */

export function emitErrorCell(emitter: Emitter, library: LibraryEmit): void {
  const unit = library.unit;
  emitter.appendLine(`static _Thread_local char *_stator_${unit}_last_error_msg = NULL;`);
  emitter.appendLine(`static void _stator_${unit}_error_clear(void) {`);
  emitter.indent++;
  emitter.appendLine(`free(_stator_${unit}_last_error_msg);`);
  emitter.appendLine(`_stator_${unit}_last_error_msg = NULL;`);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine(`static void _stator_${unit}_error_capture(jsrt_value _stator_error) {`);
  emitter.indent++;
  emitter.appendLine('jsrt_value _stator_text = jsrt_to_string(_stator_error);');
  emitter.appendLine('if (jsrt_pending()) {');
  emitter.indent++;
  emitter.appendLine('(void)jsrt_take_exception();');
  emitter.appendLine('_stator_text = jsrt_builtin_to_string(_stator_error);');
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine(`free(_stator_${unit}_last_error_msg);`);
  emitter.appendLine(`_stator_${unit}_last_error_msg = jsrt_string_to_cstr(_stator_text);`);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine(`const char *${exportLastErrorName(unit)}(void) {`);
  emitter.indent++;
  emitter.appendLine(`return _stator_${unit}_last_error_msg;`);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* After the body (and the drain) populated the globals, publish the C views: each exported
 * const is stored from its module slot with Task 7.1's table read outwards — a
 * `const char *` is a fresh malloc copy that lives as long as the program (the borrower's
 * borrow, docs/FFI.md §3, made permanent), a `jsrt_value` stays rooted in the globals
 * frame it is copied out of. */

export function emitExportConstStores(emitter: Emitter, library: LibraryEmit, span: Span): void {
  for (const constant of library.exports.consts) {
    const slot = emitter.exportSlot('const', constant.name);
    const global = `JSRT_GLOBAL(${String(slot)})`;
    let stored: string;
    if (constant.cType === 'double') {
      stored = `jsrt_to_number(${global})`;
    } else if (constant.cType === 'bool') {
      stored = `jsrt_as_bool(${global})`;
    } else if (constant.cType === 'const char *') {
      stored = `jsrt_string_to_cstr(${global})`;
    } else if (constant.cType === 'jsrt_value') {
      stored = global;
    } else {
      throw new Error(`exported const has no C store: ${constant.cType}`);
    }
    emitter.appendLine(`${constant.cName} = ${stored};`, span);
  }
}

/* The module-global slot of a C-visible export. `collectUnitExports` accepted the name and
 * the DCE roots kept the declaration, so a miss is a pipeline disagreement — loud, never a
 * zero slot that would read a stranger's binding. */

export function exportSlot(emitter: Emitter, kind: string, name: string): number {
  const slot = emitter.globalMap.get(name);
  if (slot === undefined) {
    throw new Error(`exported ${kind} '${name}' has no module slot`);
  }
  return slot;
}

/* The `stator_init_<unit>` opening both inits share: the idempotency guard FIRST, set
 * before `jsrt_init()` — a second `JSRT_GLOBALS_ENTER` would wipe every global back to
 * `undefined`. `jsrt_init()` itself is idempotent (plan-notes 341), because two units linked
 * against one runtime each call it once. */

export function emitInitOpen(
  emitter: Emitter,
  unit: string,
  span: Span,
  globalSlots: number,
): void {
  emitter.appendLine(`static bool _stator_${unit}_initialized = false;`);
  emitter.appendLine('');
  emitter.appendLine(`void ${exportInitName(unit)}(void) {`);
  emitter.indent++;
  emitter.appendLine(`if (_stator_${unit}_initialized) {`, span);
  emitter.indent++;
  emitter.appendLine('return;', span);
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.appendLine(`_stator_${unit}_initialized = true;`, span);
  emitter.appendLine('jsrt_init();', span);
  emitter.appendLine(`JSRT_GLOBALS_ENTER(${String(globalSlots)});`, span);
}

/* `stator_init_<unit>` for a synchronous module (plan.md §10 Task 7.2 step 3): the same
 * top-level side effects `main` runs, in the same order — GC, the globals frame, the
 * module environment, the statements, the microtask drain — then the exported consts,
 * which are C views of globals the body just populated. A top-level throw lands in the
 * error cell like any stub failure (step 4) instead of exiting the host: the unit is then
 * unusable, and further calls are undefined behavior. */

export function emitLibraryInitSync(
  emitter: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  scratch: number,
): void {
  emitter.emitInitOpen(library.unit, module.span, globalSlots);
  emitter.emitModuleEnv(module);
  emitter.emitSyncTopLevelStatements(module);
  emitter.emitMicrotaskDrain(module);
  emitter.emitExportConstStores(library, module.span);
  emitter.appendLine('return;', module.span);
  if (emitter.unwindUsed) {
    emitter.appendLine('_jsrt_unwind: ;', module.span);
    emitter.appendLine(`JSRT_GLOBAL(${String(scratch)}) = jsrt_take_exception();`, module.span);
    emitter.appendLine(
      `_stator_${library.unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`,
      module.span,
    );
    emitter.appendLine('return;', module.span);
  }
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* The library twin of `_jsrt_module_done`: a rejected top-level-await body parks its reason
 * in the rooted scratch global and raises the flag the init reads after the drain — instead
 * of throwing into the pending cell (whose setters would truncate the queue still draining)
 * and instead of `jsrt_uncaught`'s exit, which is `main`'s answer, not a library's. */

export function emitInitDone(emitter: Emitter, scratch: number): void {
  emitter.appendLine('static bool _jsrt_init_rejected = false;');
  emitter.appendLine('static void _jsrt_init_done(void *state, jsrt_value value, bool rejected) {');
  emitter.indent++;
  emitter.appendLine('(void)state;');
  emitter.appendLine('if (rejected) {');
  emitter.indent++;
  emitter.appendLine('_jsrt_init_rejected = true;');
  emitter.appendLine(`JSRT_GLOBAL(${String(scratch)}) = value;`);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* The body of an async unit's entry, `main` or `stator_init_<unit>`: start the module's async
 * function in a fresh heap environment, subscribe `onDone` to its promise, and drain the
 * microtasks. The frame pushed here pops before the caller's own exit code. */

export function emitAsyncModuleRun(
  emitter: Emitter,
  module: Module,
  envSlots: number,
  onDone: string,
): void {
  emitter.emitHoistedFunctions(module.statements);
  emitter.appendLine('JSRT_FRAME(1);', module.span);
  emitter.appendLine(`JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(envSlots)});`, module.span);
  emitter.appendLine('JSRT_FRAME_ENV(_jsrt_env);', module.span);
  emitter.appendLine(
    'JSRT_LOCAL(0) = jsrt_async_start(_jsrt_env, _jsrt_async_module);',
    module.span,
  );
  emitter.appendLine(`jsrt_promise_subscribe(JSRT_LOCAL(0), ${onDone}, NULL);`, module.span);
  emitter.appendLine('jsrt_run_microtasks();', module.span);
  emitter.appendLine('JSRT_FRAME_POP();', module.span);
}

/* `stator_init_<unit>` for a top-level-await module: `main`'s async startup with the exit
 * replaced by init semantics. A rejected module body captures into the error cell instead
 * of `jsrt_uncaught`'s exit(1): libraries must not exit their host. An unhandled rejection
 * from a QUEUED job still exits, exactly as in `main` — that fatality belongs to the promise
 * machinery, not to the init path. */

export function emitLibraryInitAsync(
  emitter: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  envSlots: number,
  scratch: number,
): void {
  emitter.emitInitOpen(library.unit, module.span, globalSlots);
  emitter.emitAsyncModuleRun(module, envSlots, '_jsrt_init_done');
  emitter.appendLine('if (_jsrt_init_rejected) {', module.span);
  emitter.indent++;
  emitter.appendLine(
    `_stator_${library.unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`,
    module.span,
  );
  emitter.appendLine('return;', module.span);
  emitter.indent--;
  emitter.appendLine('}', module.span);
  emitter.emitExportConstStores(library, module.span);
  emitter.appendLine('return;', module.span);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* One exported function as C sees it (plan.md §10 Task 7.2 steps 4–5): convert the C
 * arguments into frame slots, call the closure the init left in its global, convert the
 * answer back. The stub opens the frame a call from C otherwise lacks (Boehm scans the
 * init thread's C stack itself since `jsrt_init`; a second thread is UB, header says so),
 * and pops it on EVERY exit: the normal return and the `_jsrt_err` epilogue every throw
 * path — including a NULL `const char *` argument — funnels through. An exception never
 * unwinds into the C caller: the pending cell is taken into a rooted slot, rendered into
 * the error cell, and the stub answers its zero-value sentinel. */

export function emitExportStub(
  emitter: Emitter,
  library: LibraryEmit,
  fn: ExportedFunction,
  scratch: number,
  span: Span,
): void {
  const unit = library.unit;
  const slot = emitter.exportSlot('function', fn.name);
  const params = fn.params.map((param) => `${param.cType} ${param.name}`).join(', ');
  emitter.appendLine(`${fn.ret} ${fn.cName}(${fn.params.length === 0 ? 'void' : params}) {`);
  emitter.indent++;
  const frameSlots = Math.max(fn.params.length + (fn.ret === 'void' ? 0 : 1), 1);
  emitter.appendLine(`JSRT_FRAME(${String(frameSlots)});`, span);
  emitter.appendLine(`_stator_${unit}_error_clear();`, span);
  fn.params.forEach((param, index) => {
    if (param.cType === 'const char *') {
      // `from_cstr` asserts non-NULL, so the boundary refuses it first — as a catchable
      // TypeError in the cell, never an assert firing in a C caller's frame.
      emitter.appendLine(`if (${param.name} == NULL) {`, span);
      emitter.indent++;
      emitter.appendLine(
        'jsrt_throw_error(&jsrt_class_type_error, "stator: NULL for string parameter ' +
          `'${emitter.escapeCString(param.name)}' of exported function '${emitter.escapeCString(fn.name)}'");`,
        span,
      );
      emitter.appendLine('goto _jsrt_err;', span);
      emitter.indent--;
      emitter.appendLine('}', span);
    }
    emitter.appendLine(
      `JSRT_LOCAL(${String(index)}) = ${emitter.exportArg(param.cType, param.name)};`,
      span,
    );
  });
  // `_jsrt_slots` doubles as argv: the frame roots every argument across the call's own
  // allocation, and the answer (when there is one) lands past them. argc 0 reads nothing.
  if (fn.ret === 'void') {
    emitter.appendLine(
      `jsrt_call(JSRT_GLOBAL(${String(slot)}), ${String(fn.params.length)}, _jsrt_slots);`,
      span,
    );
  } else {
    emitter.appendLine(
      `JSRT_LOCAL(${String(fn.params.length)}) = jsrt_call(JSRT_GLOBAL(${String(slot)}), ` +
        `${String(fn.params.length)}, _jsrt_slots);`,
      span,
    );
  }
  emitter.appendLine('if (jsrt_pending()) {', span);
  emitter.indent++;
  emitter.appendLine('goto _jsrt_err;', span);
  emitter.indent--;
  emitter.appendLine('}', span);
  if (fn.ret !== 'void') {
    emitter.appendLine(
      `${fn.ret} _jsrt_ret = ${emitter.exportRet(fn.ret, fn.params.length, scratch)};`,
      span,
    );
  }
  emitter.appendLine('JSRT_FRAME_POP();', span);
  if (fn.ret === 'void') {
    emitter.appendLine('return;', span);
  } else {
    emitter.appendLine('return _jsrt_ret;', span);
  }
  emitter.appendLine('_jsrt_err: ;', span);
  emitter.appendLine(`JSRT_GLOBAL(${String(scratch)}) = jsrt_take_exception();`, span);
  emitter.appendLine(`_stator_${unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`, span);
  emitter.appendLine('JSRT_FRAME_POP();', span);
  if (fn.ret === 'void') {
    emitter.appendLine('return;', span);
  } else {
    emitter.appendLine(`return ${emitter.exportSentinel(fn.ret)};`, span);
  }
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* One C argument into its frame slot, Task 7.1's table read outwards (plan §10 7.2.1):
 * scalars box, a `const char *` copies in (the caller's borrow — never freed here, never
 * stored past the call), a `void *` travels by bit pattern like every 7.1 borrow, and a
 * `jsrt_value` crosses untouched. Total over what the header can spell; anything else
 * throws rather than inventing a conversion. */

export function exportArg(_emitter: Emitter, cType: string, name: string): string {
  if (cType === 'double') {
    return `jsrt_number(${name})`;
  }
  if (cType === 'bool') {
    return `jsrt_bool(${name})`;
  }
  if (cType === 'const char *') {
    return `jsrt_string_from_cstr(${name})`;
  }
  if (cType === 'void *') {
    return `(jsrt_value)(uintptr_t)(${name})`;
  }
  if (cType === 'jsrt_value') {
    return name;
  }
  throw new Error(`exported parameter has no C passing: ${cType}`);
}

/* The answer out of its slot, the mirror image: a `const char *` answer is a fresh malloc
 * copy the CALLER owns (the transfer direction of docs/FFI.md §3 — free it), a `void *`
 * unboxes by bit pattern, and a `jsrt_value` is additionally parked in the scratch global
 * so "live until the next call" is a mechanism, not a promise. */

export function exportRet(_emitter: Emitter, cType: string, slot: number, scratch: number): string {
  const value = `JSRT_LOCAL(${String(slot)})`;
  if (cType === 'double') {
    return `jsrt_to_number(${value})`;
  }
  if (cType === 'bool') {
    return `jsrt_as_bool(${value})`;
  }
  if (cType === 'const char *') {
    return `jsrt_string_to_cstr(${value})`;
  }
  if (cType === 'void *') {
    return `jsrt_ptr(${value})`;
  }
  if (cType === 'jsrt_value') {
    return `JSRT_GLOBAL(${String(scratch)}) = ${value}`;
  }
  throw new Error(`exported return has no C answer: ${cType}`);
}

/* The zero-value sentinel an error path answers instead (plan §10 Task 7.2 step 4,
 * documented in the header): 0.0, false, NULL, JSRT_UNDEFINED — one per C spelling,
 * generated uniformly for every stub. */

export function exportSentinel(_emitter: Emitter, cType: string): string {
  if (cType === 'double') {
    return '0.0';
  }
  if (cType === 'bool') {
    return 'false';
  }
  if (cType === 'const char *' || cType === 'void *') {
    return 'NULL';
  }
  if (cType === 'jsrt_value') {
    return 'JSRT_UNDEFINED';
  }
  throw new Error(`exported return has no sentinel: ${cType}`);
}

/* Emits every function unit, counting each body immediately before emitting it. The list grows
 * while it is walked, so this is an index loop rather than a `for..of` over a snapshot. */
