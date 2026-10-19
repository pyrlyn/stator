/* Function units, closures, async functions, and generators.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import type { AwaitExpr, FunctionExpr, Span, Statement, YieldExpr } from '../hir/nodes.ts';
import { cNameLiteral, closureMeta, type FunctionUnit } from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgExpr from './expr.ts';
import * as cgSeq from './sequence.ts';
import * as cgStmt from './stmt.ts';

function closeBody(self: Emitter): void {
  self.indent--;
  cgSeq.appendLine(self, '}');
  cgSeq.appendLine(self, '');
}

/* Emits every function unit, counting each body immediately before emitting it. The list grows
 * while it is walked, so this is an index loop rather than a `for..of` over a snapshot. */

export function emitFunctionUnits(self: Emitter): string[] {
  const out: string[] = [];
  for (let i = 0; i < self.functions.length; i++) {
    const unit = self.functions[i];
    if (unit === undefined) {
      continue;
    }
    for (const line of emitFunctionUnit(self, unit)) {
      out.push(line);
    }
  }
  return out;
}

export function emitFunctionUnit(self: Emitter, unit: FunctionUnit): string[] {
  const savedLines = self.lines;
  const savedIndent = self.indent;
  const savedSlotMap = self.slotMap;
  const savedSlotCount = self.slotCount;
  const savedInFunction = self.inFunction;
  const savedEnclosing = self.enclosing;
  const savedLabels = self.usedLabels;
  const savedReturnSlot = self.returnSlot;
  const savedReturnsValue = self.returnsValue;
  const savedEnvMap = self.envMap;
  const savedCaptureMap = self.captureMap;
  const savedPadStack = self.padStack;
  const savedUnwindUsed = self.unwindUsed;
  const savedTryFinallyStack = self.tryFinallyStack;
  const savedTryCount = self.tryCount;
  const savedInAsync = self.inAsync;
  const savedInGenerator = self.inGenerator;
  const savedAwaitStates = self.awaitStates;

  const produced: string[] = [];
  self.lines = produced;
  self.indent = 0;
  self.slotMap = new Map();
  self.inFunction = true;
  self.enclosing = [];
  self.usedLabels = new Set();
  self.padStack = [];
  self.unwindUsed = false;
  self.tryFinallyStack = [];
  self.tryCount = 0;

  const { fn } = unit;
  self.envMap = new Map(fn.envVars.map((name, index) => [name, index]));
  self.captureMap = new Map(fn.captures.map((c) => [c.name, c]));
  self.inAsync = fn.isAsync;
  self.inGenerator = fn.isGenerator;
  self.awaitStates = new Map();
  if (fn.isAsync && fn.isGenerator) {
    throw new Error('async generators are not in this landing');
  }
  // An async or generator unit's locals live in the SAME environment array as its captured
  // bindings, which already own indices 0..envVars.length-1 -- so numbering starts past them.
  // One array, one allocation, and `slotRef`'s existing precedence keeps a captured name out of
  // the local run.
  self.slotCount = fn.isAsync || fn.isGenerator ? fn.envVars.length : 0;

  for (const param of fn.params) {
    // `function f(a, a)` is legal in sloppy JavaScript and the later parameter wins; reusing the
    // slot rather than allocating a second one is exactly that rule, and `bindSlot` is where it
    // lives along with the captured-binding rule.
    cgSeq.bindSlot(self, param.name);
  }
  if (fn.selfBinding !== undefined) {
    cgSeq.bindSlot(self, fn.selfBinding);
  }
  for (const param of fn.params) {
    if (param.default !== undefined) {
      cgSeq.countExpression(self, param.default);
    }
  }
  // The return slot is claimed AFTER counting, and only if the body actually returns a value:
  // it holds the result across JSRT_FRAME_POP(), and a function that never produces one would
  // otherwise root a slot nothing ever writes.
  self.returnsValue = false;
  cgSeq.countBindings(self, fn.body.statements);
  // An async unit always parks its result: every exit settles the promise, and the value has to
  // be in a rooted slot while `jsrt_async_return` allocates the microtask that delivers it. A
  // generator parks the same way: `jsrt_generator_return` writes the completion into the object.
  if (fn.isAsync || fn.isGenerator) {
    self.returnsValue = true;
  }
  if (self.returnsValue) {
    self.returnSlot = self.slotCount;
    self.slotCount++;
  }

  if (fn.isAsync) {
    emitAsyncUnit(self, unit);
  } else if (fn.isGenerator) {
    emitGeneratorUnit(self, unit);
  } else {
    emitSyncUnit(self, unit);
  }

  self.lines = savedLines;
  self.indent = savedIndent;
  self.slotMap = savedSlotMap;
  self.slotCount = savedSlotCount;
  self.inFunction = savedInFunction;
  self.enclosing = savedEnclosing;
  self.usedLabels = savedLabels;
  self.returnSlot = savedReturnSlot;
  self.returnsValue = savedReturnsValue;
  self.envMap = savedEnvMap;
  self.captureMap = savedCaptureMap;
  self.padStack = savedPadStack;
  self.unwindUsed = savedUnwindUsed;
  self.inAsync = savedInAsync;
  self.inGenerator = savedInGenerator;
  self.awaitStates = savedAwaitStates;
  self.tryFinallyStack = savedTryFinallyStack;
  self.tryCount = savedTryCount;

  return produced;
}

/* Function declarations bind at the top of their unit, not where they are written, so `f();
 * function f() {}` works. The binding is what hoists; the body is emitted once, elsewhere. */
export function emitNamedFunctionSelfBinding(self: Emitter, fn: FunctionExpr): void {
  if (fn.selfBinding === undefined) {
    return;
  }
  cgSeq.appendLine(
    self,
    `${cgSeq.slotRef(self, fn.selfBinding)} = ${closureValue(self, fn)};`,
    fn.span,
  );
}

export function emitHoistedFunctions(self: Emitter, statements: readonly Statement[]): void {
  for (const stmt of statements) {
    if (stmt.kind !== 'function-declaration') {
      continue;
    }
    cgSeq.appendLine(
      self,
      `${cgSeq.slotRef(self, stmt.name)} = ${closureValue(self, stmt.fn)};`,
      stmt.span,
    );
  }
}

/* Gives a function its id the first time it is counted, and hands back the same id afterwards.
 * The id is what ties `jsrt_closure(&_jsrt_closure_N)` to the definition of `_jsrt_fn_N`. */
export function registerFunction(self: Emitter, fn: FunctionExpr, name: string): number {
  const existing = self.functionIds.get(fn);
  if (existing !== undefined) {
    return existing;
  }
  const id = self.functions.length;
  self.functionIds.set(fn, id);
  self.functions.push({ id, fn, name });
  return id;
}

export function functionId(self: Emitter, fn: FunctionExpr): number {
  const id = self.functionIds.get(fn);
  if (id === undefined) {
    throw new Error('function was not registered during counting');
  }
  return id;
}

/* The ordinary function unit: one C function, one stack frame, one exit protocol. */
export function emitSyncUnit(self: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  cgSeq.appendLine(
    self,
    `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
  );
  self.indent++;
  // Before the frame, so the overflow return has nothing to pop (plan.md §9 Task 6.23).
  cgSeq.appendLine(self, 'JSRT_STACK_CHECK();', fn.span);
  // A zero-length array is not valid C11 and a function that roots nothing is valid TypeScript,
  // so the frame has a floor of one slot -- the same rule JSRT_GLOBALS(n) follows.
  cgSeq.appendLine(self, `JSRT_FRAME(${Math.max(1, self.slotCount)});`, fn.span);
  if (fn.envVars.length > 0) {
    // Rooted through the frame, not through a closure: nothing points at this environment until
    // a closure is built from it, and the function reads its own captured locals before then
    // and after every such closure has died (docs/VALUE.md §4.3).
    cgSeq.appendLine(
      self,
      `JSRTEnv *_jsrt_env = jsrt_env_new(env, ${fn.envVars.length});`,
      fn.span,
    );
    cgSeq.appendLine(self, 'JSRT_FRAME_ENV(_jsrt_env);', fn.span);
  } else if (fn.captures.length === 0) {
    // Nothing reads the incoming environment here. The ABI passes one regardless so `jsrt_call`
    // need not know which kind of closure it holds, so silence it for -Werror.
    cgSeq.appendLine(self, '(void)env;', fn.span);
  }
  emitParameterPrologue(self, fn);
  emitNamedFunctionSelfBinding(self, fn);
  emitHoistedFunctions(self, fn.body.statements);
  for (const stmt of fn.body.statements) {
    cgStmt.emitStatement(self, stmt);
  }
  // Falling off the end of a JavaScript function returns `undefined` -- and still has to pop.
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', fn.span);
  cgSeq.appendLine(self, 'return JSRT_UNDEFINED;', fn.span);
  if (self.unwindUsed) {
    // The landing pad when no try encloses a throw point: the frame still pops -- the rooting
    // discipline demands it on EVERY exit path -- and the exception stays pending for the
    // caller's own check after jsrt_call to observe.
    cgSeq.appendLine(self, '_jsrt_unwind: ;', fn.span);
    cgSeq.appendLine(self, 'JSRT_FRAME_POP();', fn.span);
    cgSeq.appendLine(self, 'return JSRT_UNDEFINED;', fn.span);
  }
  closeBody(self);
}

/* An async unit is TWO C functions. The entry point keeps the closure ABI: it builds the heap
 * environment that will outlive every suspension, stores the arguments there, and hands both to
 * `jsrt_async_start`, which runs the body's prefix synchronously (as the spec requires) and
 * answers the promise. The resume function holds the body itself, so each `await` can pop the
 * frame and return, and each resumption re-enters from the top -- rebuilding the frame, then
 * jumping to the suspension point. Nothing lives in the C frame across a suspension, which is
 * exactly what makes a `goto` into the middle of a loop or a try block correct here. */
export function emitAsyncUnit(self: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  const resume = `_jsrt_async_${unit.id}`;
  self.usedAsync = true;
  cgSeq.appendLine(
    self,
    `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);`,
  );
  cgSeq.appendLine(self, '');
  // One frame slot, used for nothing but carrying the environment: JSRT_FRAME_ENV is what roots
  // it while `jsrt_async_start` allocates the promise and the frame that holds it.
  emitSuspendEntry(self, unit, `jsrt_async_start(_jsrt_env, ${resume})`);
  cgSeq.appendLine(
    self,
    `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {`,
  );
  self.indent++;
  // Enclosing environments are reached through the parent link rather than a parameter: the
  // scheduler calls this function, and it has no environment to pass. `(void)` unconditionally
  // -- a body that captures nothing still declares it, and -Werror would object.
  // The dispatch sits AFTER the prologue so it never jumps over a declaration, and before the
  // body so every `_jsrt_res_N:` it names is defined further down. State 0 is the first entry,
  // which falls through into the body's prefix.
  emitResumeOpen(self, fn.span, ['_jsrt_v', '_jsrt_err']);
  emitResumeBody(self, fn);
  emitAsyncSettle(self, 'jsrt_async_return', 'JSRT_UNDEFINED', fn.span);
  if (self.unwindUsed) {
    // An exception that reached the top of an async body REJECTS the promise rather than
    // staying pending: the caller observes it through `.then`/`await`, not through the mailbox.
    cgSeq.appendLine(self, '_jsrt_unwind: ;', fn.span);
    cgSeq.appendLine(
      self,
      `${cgSeq.slotAt(self, self.returnSlot)} = jsrt_take_exception();`,
      fn.span,
    );
    emitAsyncSettle(self, 'jsrt_async_throw', cgSeq.slotAt(self, self.returnSlot), fn.span);
  }
  closeBody(self);
}

/* A generator unit is TWO C functions, like an async unit, with three differences: the entry
 * point ALLOCATES and returns without running the body (the first `next()` is what starts it);
 * resume is synchronous on `next()`'s stack rather than a microtask; and an uncaught throw
 * stays pending for the call site of `next()` instead of rejecting a promise. Locals still live
 * in the heap environment because a `yield` pops the C frame. */
export function emitGeneratorUnit(self: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  const resume = `_jsrt_gen_${unit.id}`;
  cgSeq.appendLine(self, `static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v);`);
  cgSeq.appendLine(self, '');
  emitSuspendEntry(self, unit, `jsrt_generator_new(_jsrt_env, ${resume})`);
  cgSeq.appendLine(self, `static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v) {`);
  self.indent++;
  emitResumeOpen(self, fn.span, ['_jsrt_v']);
  emitResumeBody(self, fn);
  emitGeneratorSettle(self, 'JSRT_UNDEFINED', fn.span);
  if (self.unwindUsed) {
    // Leave the exception pending: `next()`'s call site observes it. Mark done so a later
    // `next()` after the throw answers `{ value: undefined, done: true }` rather than re-entering.
    cgSeq.appendLine(self, '_jsrt_unwind: ;', fn.span);
    cgSeq.appendLine(self, '_jsrt_self->done = true;', fn.span);
    cgSeq.appendLine(self, 'JSRT_FRAME_POP();', fn.span);
    cgSeq.appendLine(self, 'return;', fn.span);
  }
  closeBody(self);
}

/* Entry point shared by async and generator units: allocate the heap environment, store the
 * arguments, produce the promise or generator object, pop, return. The body lives in resume. */
export function emitSuspendEntry(self: Emitter, unit: FunctionUnit, produce: string): void {
  const { fn } = unit;
  cgSeq.appendLine(
    self,
    `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
  );
  self.indent++;
  cgSeq.appendLine(self, 'JSRT_STACK_CHECK();', fn.span);
  cgSeq.appendLine(self, 'JSRT_FRAME(1);', fn.span);
  cgSeq.appendLine(
    self,
    `JSRTEnv *_jsrt_env = jsrt_env_new(env, ${Math.max(1, self.slotCount)});`,
    fn.span,
  );
  cgSeq.appendLine(self, 'JSRT_FRAME_ENV(_jsrt_env);', fn.span);
  emitParameterPrologue(self, fn);
  cgSeq.appendLine(self, `jsrt_value _jsrt_r = ${produce};`, fn.span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', fn.span);
  cgSeq.appendLine(self, 'return _jsrt_r;', fn.span);
  closeBody(self);
}

export function emitResumeOpen(
  self: Emitter,
  span: Span,
  unusedWhenEmpty: readonly string[],
): void {
  cgSeq.appendLine(self, 'JSRT_FRAME(1);', span);
  cgSeq.appendLine(self, 'JSRTEnv *_jsrt_env = _jsrt_self->env;', span);
  cgSeq.appendLine(self, 'JSRT_FRAME_ENV(_jsrt_env);', span);
  cgSeq.appendLine(self, 'JSRTEnv *env = _jsrt_env->parent;', span);
  cgSeq.appendLine(self, '(void)env;', span);
  if (self.awaitStates.size > 0) {
    cgSeq.appendLine(self, 'switch (_jsrt_self->state) {', span);
    self.indent++;
    for (const state of self.awaitStates.values()) {
      cgSeq.appendLine(self, `case ${state}: goto _jsrt_res_${state};`, span);
    }
    cgSeq.appendLine(self, 'default: break;');
    self.indent--;
    cgSeq.appendLine(self, '}', span);
    return;
  }
  for (const name of unusedWhenEmpty) {
    cgSeq.appendLine(self, `(void)${name};`, span);
  }
}

export function emitResumeBody(self: Emitter, fn: FunctionExpr): void {
  emitNamedFunctionSelfBinding(self, fn);
  emitHoistedFunctions(self, fn.body.statements);
  for (const stmt of fn.body.statements) {
    cgStmt.emitStatement(self, stmt);
  }
}

/* Slot holding a suspension's operand / resume value. Shared by await and yield so the park
 * sequence is one function rather than two copies of the same six lines. */
export function suspendSlot(self: Emitter, expr: AwaitExpr | YieldExpr): string {
  const slot = self.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error(`${expr.kind} was not registered during counting`);
  }
  return cgSeq.slotAt(self, slot);
}

export function emitPark(self: Emitter, expr: AwaitExpr | YieldExpr, parkCall: string): string {
  const state = self.awaitStates.get(expr);
  if (state === undefined) {
    throw new Error(`${expr.kind} was not registered during counting`);
  }
  const at = suspendSlot(self, expr);
  cgSeq.appendLine(self, `${at} = ${cgExpr.emitExpression(self, expr.value)};`, expr.span);
  cgSeq.appendLine(self, `_jsrt_self->state = ${state};`, expr.span);
  // The resume prologue re-reads `_jsrt_self->env`, so the CURRENT environment has to be parked
  // there before the frame disappears -- otherwise a resume inside a per-iteration loop would
  // come back on the loop's base environment while the body's remaining code reads and writes
  // the iteration's clone (measured: `i` stuck at its last value and the loop never exiting,
  // plan-notes 226). For a unit whose env never changes this stores the same pointer it already
  // holds, which is why nothing observed it before.
  cgSeq.appendLine(self, '_jsrt_self->env = _jsrt_env;', expr.span);
  cgSeq.appendLine(self, parkCall, expr.span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', expr.span);
  cgSeq.appendLine(self, 'return;', expr.span);
  cgSeq.appendLine(self, `_jsrt_res_${state}: ;`, expr.span);
  return at;
}

/* Settle THEN pop: settling enqueues a microtask, which allocates, and the value being settled
 * with must still be rooted while it does. */
export function emitAsyncSettle(self: Emitter, fn: string, value: string, span: Span): void {
  cgSeq.appendLine(self, `${fn}(_jsrt_self, ${value});`, span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', span);
  cgSeq.appendLine(self, 'return;', span);
}

export function emitGeneratorSettle(self: Emitter, value: string, span: Span): void {
  cgSeq.appendLine(self, `jsrt_generator_return(_jsrt_self, ${value});`, span);
  cgSeq.appendLine(self, 'JSRT_FRAME_POP();', span);
  cgSeq.appendLine(self, 'return;', span);
}

export function emitParameterPrologue(self: Emitter, fn: FunctionExpr): void {
  if (fn.params.length === 0) {
    cgSeq.appendLine(self, '(void)argc;');
    cgSeq.appendLine(self, '(void)argv;');
  }
  fn.params.forEach((param, index) => {
    // A call site may pass fewer or more arguments than the function declares. `jsrt_arg` makes
    // both a value -- `undefined` and "dropped" -- rather than a read past the end of `argv`.
    // A rest parameter packs the extras the call already passed.
    // A default runs when the argument is undefined, including an explicit `undefined`.
    cgSeq.appendLine(
      self,
      param.rest === true
        ? `${cgSeq.slotRef(self, param.name)} = jsrt_args_rest(argc, argv, ${index});`
        : `${cgSeq.slotRef(self, param.name)} = jsrt_arg(argc, argv, ${index});`,
      param.span,
    );
    if (param.default !== undefined) {
      const slot = cgSeq.slotRef(self, param.name);
      cgSeq.appendLine(self, `if (jsrt_is(${slot}, JSRT_TAG_UNDEFINED)) {`, param.span);
      self.indent++;
      const value = cgExpr.emitExpression(self, param.default);
      cgSeq.appendLine(self, `${slot} = ${value};`, param.span);
      self.indent--;
      cgSeq.appendLine(self, '}', param.span);
    }
  });
}

/* A function that captures nothing stays rung 4a's file-static constant -- no allocation. One
 * that does is built per evaluation, which is what makes two evaluations of the same function
 * expression close over different variables. */
export function closureValue(self: Emitter, fn: FunctionExpr): string {
  const id = functionId(self, fn);
  if (!fn.needsEnv) {
    return `jsrt_closure(&_jsrt_closure_${id})`;
  }
  const name = cNameLiteral(fn.name ?? '');
  const meta = closureMeta(fn);
  const closure = `jsrt_closure_new(_jsrt_fn_${id}, ${meta.arity}, ${name}, ${cgSeq.currentEnv(self)}, ${meta.hasReceiver ? 'true' : 'false'})`;
  return fn.constructible === true ? `jsrt_closure_constructible(${closure})` : closure;
}
