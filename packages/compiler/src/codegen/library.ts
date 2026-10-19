/* Library emit (`--emit-header`): init, export stubs, and the C ABI.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import type { Module, Span } from '../hir/nodes.ts';
import {
  exportInitName,
  exportLastErrorName,
  type ExportedFunction,
  type UnitExports,
} from '../frontend/export.ts';
import type { Emitter } from './emitter.ts';

import * as cgClosure from './closures.ts';
import * as cgDriver from './module.ts';
import * as cgSeq from './sequence.ts';

/* The `--emit-header` object tail (plan.md §10 Task 7.2 steps 3–5): no `main` — linking is
 * the consumer's job — but the init contract, the error cell, the exported consts, and one
 * stub per exported function, in that file order. State reset mirrors `emitMain`: the
 * function units above saved and restored everything they touched, so the module level is
 * pristine here exactly as it is there. */
/** A `--emit-header` unit the object exposes to C (plan.md §10 Task 7.2 steps 3–5): the
 * sanitized unit name plus the C-visible set `collectUnitExports` decided. Present only in
 * library builds; an executable build passes none and keeps its `main`. */

export interface LibraryEmit {
  readonly unit: string;
  readonly exports: UnitExports;
}

export function emitLibrary(
  self: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  scratch: number,
): string[] {
  const produced: string[] = [];
  self.lines = produced;
  self.indent = 0;
  self.inFunction = false;
  self.slotMap = self.globalMap;
  self.slotCount = self.globalCount;
  self.padStack = [];
  self.unwindUsed = false;
  self.tryFinallyStack = [];
  self.tryCount = 0;

  emitExportConstDefs(self, library);
  emitErrorCell(self, library);
  if (module.isAsync) {
    const envSlots = cgDriver.countAsyncModule(self, module);
    emitInitDone(self, scratch);
    cgDriver.emitAsyncModuleForward(self);
    emitLibraryInitAsync(self, module, library, globalSlots, envSlots, scratch);
    cgDriver.emitAsyncModuleBody(self, module);
  } else {
    emitLibraryInitSync(self, module, library, globalSlots, scratch);
  }
  for (const fn of library.exports.functions) {
    emitExportStub(self, library, fn, scratch, module.span);
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
export function emitExportConstDefs(self: Emitter, library: LibraryEmit): void {
  if (library.exports.consts.length === 0) {
    return;
  }
  cgSeq.appendLine(
    self,
    '/* Exported consts: C views of module globals, stored by the init below. */',
  );
  for (const constant of library.exports.consts) {
    cgSeq.appendLine(self, `${constant.cType} ${constant.cName};`);
  }
  cgSeq.appendLine(self, '');
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
export function emitErrorCell(self: Emitter, library: LibraryEmit): void {
  const unit = library.unit;
  cgSeq.appendLine(self, `static _Thread_local char *_stator_${unit}_last_error_msg = NULL;`);
  cgSeq.appendLine(self, `static void _stator_${unit}_error_clear(void) {`);
  self.indent++;
  cgSeq.appendLine(self, `free(_stator_${unit}_last_error_msg);`);
  cgSeq.appendLine(self, `_stator_${unit}_last_error_msg = NULL;`);
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, `static void _stator_${unit}_error_capture(jsrt_value _stator_error) {`);
  self.indent++;
  cgSeq.appendLine(self, 'jsrt_value _stator_text = jsrt_to_string(_stator_error);');
  cgSeq.appendLine(self, 'if (jsrt_pending()) {');
  self.indent++;
  cgSeq.appendLine(self, '(void)jsrt_take_exception();');
  cgSeq.appendLine(self, '_stator_text = jsrt_builtin_to_string(_stator_error);');
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, `free(_stator_${unit}_last_error_msg);`);
  cgSeq.appendLine(self, `_stator_${unit}_last_error_msg = jsrt_string_to_cstr(_stator_text);`);
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, `const char *${exportLastErrorName(unit)}(void) {`);
  self.indent++;
  cgSeq.appendLine(self, `return _stator_${unit}_last_error_msg;`);
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

/* After the body (and the drain) populated the globals, publish the C views: each exported
 * const is stored from its module slot with Task 7.1's table read outwards — a
 * `const char *` is a fresh malloc copy that lives as long as the program (the borrower's
 * borrow, docs/FFI.md §3, made permanent), a `jsrt_value` stays rooted in the globals
 * frame it is copied out of. */
export function emitExportConstStores(self: Emitter, library: LibraryEmit, span: Span): void {
  for (const constant of library.exports.consts) {
    const slot = exportSlot(self, 'const', constant.name);
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
    cgSeq.appendLine(self, `${constant.cName} = ${stored};`, span);
  }
}

/* The module-global slot of a C-visible export. `collectUnitExports` accepted the name and
 * the DCE roots kept the declaration, so a miss is a pipeline disagreement — loud, never a
 * zero slot that would read a stranger's binding. */
export function exportSlot(self: Emitter, kind: string, name: string): number {
  const slot = self.globalMap.get(name);
  if (slot === undefined) {
    throw new Error(`exported ${kind} '${name}' has no module slot`);
  }
  return slot;
}

/* The `stator_init_<unit>` opening both inits share: the idempotency guard FIRST, set
 * before `jsrt_init()` — a second `JSRT_GLOBALS_ENTER` would wipe every global back to
 * `undefined`. `jsrt_init()` itself is idempotent (plan-notes 341), because two units linked
 * against one runtime each call it once. */
export function emitInitOpen(self: Emitter, unit: string, span: Span, globalSlots: number): void {
  cgSeq.appendLine(self, `static bool _stator_${unit}_initialized = false;`);
  cgSeq.appendLine(self, '');
  cgSeq.appendLine(self, `void ${exportInitName(unit)}(void) {`);
  self.indent++;
  cgSeq.appendLine(self, `if (_stator_${unit}_initialized) {`, span);
  self.indent++;
  cgSeq.appendLine(self, 'return;', span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  cgSeq.appendLine(self, `_stator_${unit}_initialized = true;`, span);
  cgSeq.appendLine(self, 'jsrt_init();', span);
  cgSeq.appendLine(self, `JSRT_GLOBALS_ENTER(${String(globalSlots)});`, span);
}

/* `stator_init_<unit>` for a synchronous module (plan.md §10 Task 7.2 step 3): the same
 * top-level side effects `main` runs, in the same order — GC, the globals frame, the
 * module environment, the statements, the microtask drain — then the exported consts,
 * which are C views of globals the body just populated. A top-level throw lands in the
 * error cell like any stub failure (step 4) instead of exiting the host: the unit is then
 * unusable, and further calls are undefined behavior. */
export function emitLibraryInitSync(
  self: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  scratch: number,
): void {
  emitInitOpen(self, library.unit, module.span, globalSlots);
  cgDriver.emitModuleEnv(self, module);
  cgDriver.emitSyncTopLevelStatements(self, module);
  cgDriver.emitMicrotaskDrain(self, module);
  emitExportConstStores(self, library, module.span);
  cgSeq.appendLine(self, 'return;', module.span);
  if (self.unwindUsed) {
    cgSeq.appendLine(self, '_jsrt_unwind: ;', module.span);
    cgSeq.appendLine(self, `JSRT_GLOBAL(${String(scratch)}) = jsrt_take_exception();`, module.span);
    cgSeq.appendLine(
      self,
      `_stator_${library.unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`,
      module.span,
    );
    cgSeq.appendLine(self, 'return;', module.span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

/* The library twin of `_jsrt_module_done`: a rejected top-level-await body parks its reason
 * in the rooted scratch global and raises the flag the init reads after the drain — instead
 * of throwing into the pending cell (whose setters would truncate the queue still draining)
 * and instead of `jsrt_uncaught`'s exit, which is `main`'s answer, not a library's. */
export function emitInitDone(self: Emitter, scratch: number): void {
  cgSeq.appendLine(self, 'static bool _jsrt_init_rejected = false;');
  cgSeq.appendLine(
    self,
    'static void _jsrt_init_done(void *state, jsrt_value value, bool rejected) {',
  );
  self.indent++;
  cgSeq.appendLine(self, '(void)state;');
  cgSeq.appendLine(self, 'if (rejected) {');
  self.indent++;
  cgSeq.appendLine(self, '_jsrt_init_rejected = true;');
  cgSeq.appendLine(self, `JSRT_GLOBAL(${String(scratch)}) = value;`);
  self.indent--;
  cgSeq.appendLine(self, '}');
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

/* The body of an async unit's entry, `main` or `stator_init_<unit>`: start the module's async
 * function in a fresh heap environment, subscribe `onDone` to its promise, and drain the
 * microtasks. The frame pushed here pops before the caller's own exit code. */
export function emitAsyncModuleRun(
  self: Emitter,
  module: Module,
  envSlots: number,
  onDone: string,
): void {
  cgClosure.emitHoistedFunctions(self, module.statements);
  cgSeq.appendLine(self, 'JSRT_FRAME(1);', module.span);
  cgSeq.appendLine(
    self,
    `JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(envSlots)});`,
    module.span,
  );
  cgSeq.appendLine(self, 'JSRT_FRAME_ENV(_jsrt_env);', module.span);
  cgSeq.appendLine(
    self,
    'JSRT_LOCAL(0) = jsrt_async_start(_jsrt_env, _jsrt_async_module);',
    module.span,
  );
  cgSeq.appendLine(self, `jsrt_promise_subscribe(JSRT_LOCAL(0), ${onDone}, NULL);`, module.span);
  cgSeq.appendLine(self, 'jsrt_run_microtasks();', module.span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', module.span);
}

/* `stator_init_<unit>` for a top-level-await module: `main`'s async startup with the exit
 * replaced by init semantics. A rejected module body captures into the error cell instead
 * of `jsrt_uncaught`'s exit(1): libraries must not exit their host. An unhandled rejection
 * from a QUEUED job still exits, exactly as in `main` — that fatality belongs to the promise
 * machinery, not to the init path. */
export function emitLibraryInitAsync(
  self: Emitter,
  module: Module,
  library: LibraryEmit,
  globalSlots: number,
  envSlots: number,
  scratch: number,
): void {
  emitInitOpen(self, library.unit, module.span, globalSlots);
  emitAsyncModuleRun(self, module, envSlots, '_jsrt_init_done');
  cgSeq.appendLine(self, 'if (_jsrt_init_rejected) {', module.span);
  self.indent++;
  cgSeq.appendLine(
    self,
    `_stator_${library.unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`,
    module.span,
  );
  cgSeq.appendLine(self, 'return;', module.span);
  self.indent--;
  cgSeq.appendLine(self, '}', module.span);
  emitExportConstStores(self, library, module.span);
  cgSeq.appendLine(self, 'return;', module.span);
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
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
  self: Emitter,
  library: LibraryEmit,
  fn: ExportedFunction,
  scratch: number,
  span: Span,
): void {
  const unit = library.unit;
  const slot = exportSlot(self, 'function', fn.name);
  const params = fn.params.map((param) => `${param.cType} ${param.name}`).join(', ');
  cgSeq.appendLine(self, `${fn.ret} ${fn.cName}(${fn.params.length === 0 ? 'void' : params}) {`);
  self.indent++;
  const frameSlots = Math.max(fn.params.length + (fn.ret === 'void' ? 0 : 1), 1);
  cgSeq.appendLine(self, `JSRT_FRAME(${String(frameSlots)});`, span);
  cgSeq.appendLine(self, `_stator_${unit}_error_clear();`, span);
  fn.params.forEach((param, index) => {
    if (param.cType === 'const char *') {
      // `from_cstr` asserts non-NULL, so the boundary refuses it first — as a catchable
      // TypeError in the cell, never an assert firing in a C caller's frame.
      cgSeq.appendLine(self, `if (${param.name} == NULL) {`, span);
      self.indent++;
      cgSeq.appendLine(
        self,
        'jsrt_throw_error(&jsrt_class_type_error, "stator: NULL for string parameter ' +
          `'${cgSeq.escapeCString(self, param.name)}' of exported function '${cgSeq.escapeCString(self, fn.name)}'");`,
        span,
      );
      cgSeq.appendLine(self, 'goto _jsrt_err;', span);
      self.indent--;
      cgSeq.appendLine(self, '}', span);
    }
    cgSeq.appendLine(
      self,
      `JSRT_LOCAL(${String(index)}) = ${exportArg(self, param.cType, param.name)};`,
      span,
    );
  });
  // `_jsrt_slots` doubles as argv: the frame roots every argument across the call's own
  // allocation, and the answer (when there is one) lands past them. argc 0 reads nothing.
  if (fn.ret === 'void') {
    cgSeq.appendLine(
      self,
      `jsrt_call(JSRT_GLOBAL(${String(slot)}), ${String(fn.params.length)}, _jsrt_slots);`,
      span,
    );
  } else {
    cgSeq.appendLine(
      self,
      `JSRT_LOCAL(${String(fn.params.length)}) = jsrt_call(JSRT_GLOBAL(${String(slot)}), ` +
        `${String(fn.params.length)}, _jsrt_slots);`,
      span,
    );
  }
  cgSeq.appendLine(self, 'if (jsrt_pending()) {', span);
  self.indent++;
  cgSeq.appendLine(self, 'goto _jsrt_err;', span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  if (fn.ret !== 'void') {
    cgSeq.appendLine(
      self,
      `${fn.ret} _jsrt_ret = ${exportRet(self, fn.ret, fn.params.length, scratch)};`,
      span,
    );
  }
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', span);
  if (fn.ret === 'void') {
    cgSeq.appendLine(self, 'return;', span);
  } else {
    cgSeq.appendLine(self, 'return _jsrt_ret;', span);
  }
  cgSeq.appendLine(self, '_jsrt_err: ;', span);
  cgSeq.appendLine(self, `JSRT_GLOBAL(${String(scratch)}) = jsrt_take_exception();`, span);
  cgSeq.appendLine(self, `_stator_${unit}_error_capture(JSRT_GLOBAL(${String(scratch)}));`, span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', span);
  if (fn.ret === 'void') {
    cgSeq.appendLine(self, 'return;', span);
  } else {
    cgSeq.appendLine(self, `return ${exportSentinel(self, fn.ret)};`, span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

/* One C argument into its frame slot, Task 7.1's table read outwards (plan §10 7.2.1):
 * scalars box, a `const char *` copies in (the caller's borrow — never freed here, never
 * stored past the call), a `void *` travels by bit pattern like every 7.1 borrow, and a
 * `jsrt_value` crosses untouched. Total over what the header can spell; anything else
 * throws rather than inventing a conversion. */
export function exportArg(_self: Emitter, cType: string, name: string): string {
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
export function exportRet(_self: Emitter, cType: string, slot: number, scratch: number): string {
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
export function exportSentinel(_self: Emitter, cType: string): string {
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
