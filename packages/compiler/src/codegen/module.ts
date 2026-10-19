/* Module driver: main, top-level statements, and async module startup.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import type { Module } from '../hir/nodes.ts';
import type { Emitter } from './emitter.ts';

import * as cgClosure from './closures.ts';
import * as cgLibrary from './library.ts';
import * as cgSeq from './sequence.ts';
import * as cgStmt from './stmt.ts';

/* The module's own environment, when a top-level loop declares a `let`/`const` a closure
 * captures (docs/VALUE.md §4.3). Rooted through the globals frame, which is pushed once and
 * never popped -- the module environment has to outlive main's locals for the same reason
 * the globals array does. Shared by `main` and the library init: the body they both run
 * reads the same bindings (plan.md §10 Task 7.2 step 3 reuses this path, never a second). */

export function emitModuleEnv(self: Emitter, module: Module): void {
  if (module.envVars.length > 0) {
    cgSeq.appendLine(
      self,
      `JSRTEnv *_jsrt_env = jsrt_env_new(NULL, ${String(module.envVars.length)});`,
      module.span,
    );
    cgSeq.appendLine(self, 'JSRT_GLOBALS_ENV(_jsrt_env);', module.span);
  }
}

/* The merged module's top-level statements in Task 3.11 order, hoisted functions first
 * (so `f(); function f() {}` resolves). The one body both `main` and `stator_init_<unit>`
 * run: a library init is the same side effects in the same order, not a second copy. */
export function emitSyncTopLevelStatements(self: Emitter, module: Module): void {
  cgClosure.emitHoistedFunctions(self, module.statements);
  for (const stmt of module.statements) {
    cgStmt.emitStatement(self, stmt);
  }
}

/* Everything a promise queued runs before the program exits -- that is the whole of the job
 * queue's observable behaviour for a program with no other event source. Emitted only when
 * the module actually promised, so a program that never did does not link the driver in.
 * Shared by `main` and the library init, which drains what the top level queued the same way. */
export function emitMicrotaskDrain(self: Emitter, module: Module): void {
  if (self.usedAsync) {
    cgSeq.appendLine(self, 'jsrt_run_microtasks();', module.span);
  }
}

export function emitMain(self: Emitter, module: Module, globalSlots: number): string[] {
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

  if (module.isAsync) {
    emitAsyncModule(self, module, globalSlots);
    return produced;
  }

  emitMainEntry(self, module, globalSlots);
  emitModuleEnv(self, module);
  emitSyncTopLevelStatements(self, module);
  emitMicrotaskDrain(self, module);
  // No pop: the globals frame is pushed once and lives as long as the program does.
  cgSeq.appendLine(self, 'return (int)jsrt_process_exit_code();', module.span);
  if (self.unwindUsed) {
    // An exception no try caught: report on stderr and exit(1), which is what Node does.
    cgSeq.appendLine(self, '_jsrt_unwind: ;', module.span);
    cgSeq.appendLine(self, 'jsrt_uncaught();', module.span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}');

  return produced;
}

/* The program entry both module shapes share. `main` keeps its argument vector for
 * `std/process.argv` before any module code runs, and returns the status `std/process`'s
 * `setExitCode` left (0 unless a program set one; docs/STD.md §5). */
export function emitMainEntry(self: Emitter, module: Module, globalSlots: number): void {
  cgSeq.appendLine(self, 'int main(int argc, char **argv) {');
  self.indent++;
  cgSeq.appendLine(self, 'jsrt_init();', module.span);
  cgSeq.appendLine(self, 'jsrt_process_args(argc, argv);', module.span);
  cgSeq.appendLine(self, `JSRT_GLOBALS_ENTER(${globalSlots});`, module.span);
}

/* A module with a top-level await is an async unit (Phase 5 step 9). Named bindings stay in
 * the globals array so the rest of the program still reads JSRT_GLOBAL; temps and await state
 * live in a heap environment because a suspension pops main's C frame. Init runs in Task 3.11's
 * topological order — Stator does not interleave sibling subgraphs the way Node does. */
export function emitAsyncModule(self: Emitter, module: Module, globalSlots: number): void {
  const envSlots = countAsyncModule(self, module);
  emitModuleDoneMain(self);
  emitAsyncModuleForward(self);

  emitMainEntry(self, module, globalSlots);
  cgLibrary.emitAsyncModuleRun(self, module, envSlots, '_jsrt_module_done');
  cgSeq.appendLine(self, 'return (int)jsrt_process_exit_code();', module.span);
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');

  emitAsyncModuleBody(self, module);
}

/* The async module's counting half: the heap-environment layout the resume body reads, with
 * the suspension-surviving locals numbered past the module's captured per-iteration bindings
 * (see the layout note it keeps). Split out because the library init counts the same module
 * before running `main`'s startup sequence with init semantics instead. */
export function countAsyncModule(self: Emitter, module: Module): number {
  self.usedAsync = true;
  self.moduleAsync = true;
  self.inAsync = true;
  self.inFunction = true;
  self.slotMap = new Map();
  // Same layout an async FUNCTION uses (see emitFunctionUnit): the module's captured
  // per-iteration bindings own env indices 0..envVars.length-1, and the suspension-surviving
  // locals are numbered past them into the same environment. One env, two tenants -- which is
  // why the per-iteration clone works here unchanged.
  self.envMap = new Map(module.envVars.map((name, index) => [name, index]));
  self.slotCount = module.envVars.length;
  self.captureMap = new Map();
  self.awaitStates = new Map();
  self.returnsValue = true;
  cgSeq.countBindings(self, module.statements);
  self.returnSlot = self.slotCount;
  self.slotCount++;
  return Math.max(1, self.slotCount);
}

/* `main`'s settlement observer: a rejected module body rethrows into the pending cell and
 * exits(1) via `jsrt_uncaught` — the process answer, not a library's (compare
 * `emitInitDone`, which parks the reason for the init to capture instead). */
export function emitModuleDoneMain(self: Emitter): void {
  cgSeq.appendLine(
    self,
    'static void _jsrt_module_done(void *state, jsrt_value value, bool rejected) {',
  );
  self.indent++;
  cgSeq.appendLine(self, '(void)state;');
  cgSeq.appendLine(self, 'if (rejected) {');
  self.indent++;
  cgSeq.appendLine(self, 'jsrt_throw(value);');
  cgSeq.appendLine(self, 'jsrt_uncaught();');
  self.indent--;
  cgSeq.appendLine(self, '}');
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

export function emitAsyncModuleForward(self: Emitter): void {
  cgSeq.appendLine(
    self,
    'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);',
  );
  cgSeq.appendLine(self, '');
}

/* The resume function holding the module body itself, shared by `main` and the library
 * init: each `await` pops the frame and each resumption re-enters from the top. */
export function emitAsyncModuleBody(self: Emitter, module: Module): void {
  cgSeq.appendLine(
    self,
    'static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {',
  );
  self.indent++;
  cgClosure.emitResumeOpen(self, module.span, ['_jsrt_v', '_jsrt_err']);
  for (const stmt of module.statements) {
    cgStmt.emitStatement(self, stmt);
  }
  cgClosure.emitAsyncSettle(self, 'jsrt_async_return', 'JSRT_UNDEFINED', module.span);
  if (self.unwindUsed) {
    cgSeq.appendLine(self, '_jsrt_unwind: ;', module.span);
    cgSeq.appendLine(
      self,
      `${cgSeq.slotAt(self, self.returnSlot)} = jsrt_take_exception();`,
      module.span,
    );
    cgClosure.emitAsyncSettle(
      self,
      'jsrt_async_throw',
      cgSeq.slotAt(self, self.returnSlot),
      module.span,
    );
  }
  self.indent--;
  cgSeq.appendLine(self, '}');
}
