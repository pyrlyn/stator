/* closures emission for the C emitter (T24 split). */

import type { AwaitExpr, FunctionExpr, Span, Statement, YieldExpr } from '../hir/nodes.ts';
import type { Emitter } from './emitter.ts';
import type { FunctionUnit } from './types.ts';
import { cNameLiteral, closureMeta } from './helpers.ts';

const UNIT_STATE_KEYS = [
  'lines',
  'indent',
  'slotMap',
  'slotCount',
  'inFunction',
  'enclosing',
  'usedLabels',
  'returnSlot',
  'returnsValue',
  'envMap',
  'captureMap',
  'padStack',
  'unwindUsed',
  'tryFinallyStack',
  'tryCount',
  'inAsync',
  'inGenerator',
  'awaitStates',
] as const;

type UnitStateKey = (typeof UNIT_STATE_KEYS)[number];
type UnitState = Record<UnitStateKey, unknown>;

/** Unit-local emission state stashed around one function body so the module level resumes intact. */
function snapshotUnitState(emitter: Emitter): UnitState {
  const saved: Record<string, unknown> = {};
  for (const key of UNIT_STATE_KEYS) {
    saved[key] = emitter[key];
  }
  return saved as UnitState;
}

function restoreUnitState(emitter: Emitter, saved: UnitState): void {
  for (const key of UNIT_STATE_KEYS) {
    (emitter as unknown as Record<string, unknown>)[key] = saved[key];
  }
}

export function emitFunctionUnits(emitter: Emitter): string[] {
  const out: string[] = [];
  for (let i = 0; i < emitter.functions.length; i++) {
    const unit = emitter.functions[i];
    if (unit === undefined) {
      continue;
    }
    for (const line of emitter.emitFunctionUnit(unit)) {
      out.push(line);
    }
  }
  return out;
}

export function emitFunctionUnit(emitter: Emitter, unit: FunctionUnit): string[] {
  const saved = snapshotUnitState(emitter);

  const produced: string[] = [];
  emitter.lines = produced;
  emitter.indent = 0;
  emitter.slotMap = new Map();
  emitter.inFunction = true;
  emitter.enclosing = [];
  emitter.usedLabels = new Set();
  emitter.padStack = [];
  emitter.unwindUsed = false;
  emitter.tryFinallyStack = [];
  emitter.tryCount = 0;

  const { fn } = unit;
  emitter.envMap = new Map(fn.envVars.map((name, index) => [name, index]));
  emitter.captureMap = new Map(fn.captures.map((c) => [c.name, c]));
  emitter.inAsync = fn.isAsync;
  emitter.inGenerator = fn.isGenerator;
  emitter.awaitStates = new Map();
  if (fn.isAsync && fn.isGenerator) {
    throw new Error('async generators are not in this landing');
  }
  // An async or generator unit's locals live in the SAME environment array as its captured
  // bindings, which already own indices 0..envVars.length-1 -- so numbering starts past them.
  // One array, one allocation, and `slotRef`'s existing precedence keeps a captured name out of
  // the local run.
  emitter.slotCount = fn.isAsync || fn.isGenerator ? fn.envVars.length : 0;

  for (const param of fn.params) {
    // `function f(a, a)` is legal in sloppy JavaScript and the later parameter wins; reusing the
    // slot rather than allocating a second one is exactly that rule, and `bindSlot` is where it
    // lives along with the captured-binding rule.
    emitter.bindSlot(param.name);
  }
  if (fn.selfBinding !== undefined) {
    emitter.bindSlot(fn.selfBinding);
  }
  for (const param of fn.params) {
    if (param.default !== undefined) {
      emitter.countExpression(param.default);
    }
  }
  // The return slot is claimed AFTER counting, and only if the body actually returns a value:
  // it holds the result across JSRT_FRAME_POP(), and a function that never produces one would
  // otherwise root a slot nothing ever writes.
  emitter.returnsValue = false;
  emitter.countBindings(fn.body.statements);
  // An async unit always parks its result: every exit settles the promise, and the value has to
  // be in a rooted slot while `jsrt_async_return` allocates the microtask that delivers it. A
  // generator parks the same way: `jsrt_generator_return` writes the completion into the object.
  if (fn.isAsync || fn.isGenerator) {
    emitter.returnsValue = true;
  }
  if (emitter.returnsValue) {
    emitter.returnSlot = emitter.slotCount;
    emitter.slotCount++;
  }

  if (fn.isAsync) {
    emitter.emitAsyncUnit(unit);
  } else if (fn.isGenerator) {
    emitter.emitGeneratorUnit(unit);
  } else {
    emitter.emitSyncUnit(unit);
  }

  restoreUnitState(emitter, saved);
  return produced;
}

/* Every place a list of statements is a SCOPE: hoist its function declarations, then run it.
 *
 * A module is always strict, so a function declared in a block belongs to that block and is
 * initialized when the block is entered -- not when the enclosing function was (plan.md §8
 * step 12(e)). Routing every block, branch, loop body and clause list through here is what makes
 * `{ f(); function f() {} }` resolve instead of calling `undefined`, and re-running it per
 * iteration is what gives a loop body's declaration the iteration's own captures. */
export function emitScope(emitter: Emitter, statements: readonly Statement[]): void {
  emitter.emitHoistedFunctions(statements);
  for (const stmt of statements) {
    emitter.emitStatement(stmt);
  }
}

/* Function declarations bind at the top of their unit, not where they are written, so `f();
 * function f() {}` works. The binding is what hoists; the body is emitted once, elsewhere. */

export function emitNamedFunctionSelfBinding(emitter: Emitter, fn: FunctionExpr): void {
  if (fn.selfBinding === undefined) {
    return;
  }
  emitter.appendLine(`${emitter.slotRef(fn.selfBinding)} = ${emitter.closureValue(fn)};`, fn.span);
}

export function emitHoistedFunctions(emitter: Emitter, statements: readonly Statement[]): void {
  for (const stmt of statements) {
    if (stmt.kind !== 'function-declaration') {
      continue;
    }
    emitter.appendLine(
      `${emitter.slotRef(stmt.name)} = ${emitter.closureValue(stmt.fn)};`,
      stmt.span,
    );
  }
}

/* Gives a function its id the first time it is counted, and hands back the same id afterwards.
 * The id is what ties `jsrt_closure(&_jsrt_closure_N)` to the definition of `_jsrt_fn_N`. */

export function registerFunction(emitter: Emitter, fn: FunctionExpr, name: string): number {
  const existing = emitter.functionIds.get(fn);
  if (existing !== undefined) {
    return existing;
  }
  const id = emitter.functions.length;
  emitter.functionIds.set(fn, id);
  emitter.functions.push({ id, fn, name });
  return id;
}

export function functionId(emitter: Emitter, fn: FunctionExpr): number {
  const id = emitter.functionIds.get(fn);
  if (id === undefined) {
    throw new Error('function was not registered during counting');
  }
  return id;
}

/* Storage for one named binding, at most once. A binding this function CAPTURES already has a
 * home -- its heap environment -- and `slotRef` reads that one, so a frame slot of the same name
 * would be a slot the frame roots and nothing ever reads. One variable, one home; the frame-vs-
 * locals audit in tests/unit/frames.test.ts is what holds this to exactly that. */

export function emitSyncUnit(emitter: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  emitter.appendLine(
    `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
  );
  emitter.indent++;
  // Before the frame, so the overflow return has nothing to pop (plan.md §9 Task 6.23).
  emitter.appendLine('JSRT_STACK_CHECK();', fn.span);
  // A zero-length array is not valid C11 and a function that roots nothing is valid TypeScript,
  // so the frame has a floor of one slot -- the same rule JSRT_GLOBALS(n) follows.
  emitter.appendLine(`JSRT_FRAME(${Math.max(1, emitter.slotCount)});`, fn.span);
  if (fn.envVars.length > 0) {
    // Rooted through the frame, not through a closure: nothing points at this environment until
    // a closure is built from it, and the function reads its own captured locals before then
    // and after every such closure has died (docs/VALUE.md §4.3).
    emitter.appendLine(`JSRTEnv *_jsrt_env = jsrt_env_new(env, ${fn.envVars.length});`, fn.span);
    emitter.appendLine('JSRT_FRAME_ENV(_jsrt_env);', fn.span);
  } else if (fn.captures.length === 0) {
    // Nothing reads the incoming environment here. The ABI passes one regardless so `jsrt_call`
    // need not know which kind of closure it holds, so silence it for -Werror.
    emitter.appendLine('(void)env;', fn.span);
  }
  emitter.emitParameterPrologue(fn);
  emitter.emitNamedFunctionSelfBinding(fn);
  emitter.emitHoistedFunctions(fn.body.statements);
  for (const stmt of fn.body.statements) {
    emitter.emitStatement(stmt);
  }
  // Falling off the end of a JavaScript function returns `undefined` -- and still has to pop.
  emitter.appendLine('JSRT_FRAME_POP();', fn.span);
  emitter.appendLine('return JSRT_UNDEFINED;', fn.span);
  if (emitter.unwindUsed) {
    // The landing pad when no try encloses a throw point: the frame still pops -- the rooting
    // discipline demands it on EVERY exit path -- and the exception stays pending for the
    // caller's own check after jsrt_call to observe.
    emitter.appendLine('_jsrt_unwind: ;', fn.span);
    emitter.appendLine('JSRT_FRAME_POP();', fn.span);
    emitter.appendLine('return JSRT_UNDEFINED;', fn.span);
  }
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* An async unit is TWO C functions. The entry point keeps the closure ABI: it builds the heap
 * environment that will outlive every suspension, stores the arguments there, and hands both to
 * `jsrt_async_start`, which runs the body's prefix synchronously (as the spec requires) and
 * answers the promise. The resume function holds the body itself, so each `await` can pop the
 * frame and return, and each resumption re-enters from the top -- rebuilding the frame, then
 * jumping to the suspension point. Nothing lives in the C frame across a suspension, which is
 * exactly what makes a `goto` into the middle of a loop or a try block correct here. */

export function emitAsyncUnit(emitter: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  const resume = `_jsrt_async_${unit.id}`;
  emitter.usedAsync = true;
  emitter.appendLine(
    `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);`,
  );
  emitter.appendLine('');
  // One frame slot, used for nothing but carrying the environment: JSRT_FRAME_ENV is what roots
  // it while `jsrt_async_start` allocates the promise and the frame that holds it.
  emitter.emitSuspendEntry(unit, `jsrt_async_start(_jsrt_env, ${resume})`);
  emitter.appendLine(
    `static void ${resume}(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {`,
  );
  emitter.indent++;
  // Enclosing environments are reached through the parent link rather than a parameter: the
  // scheduler calls this function, and it has no environment to pass. `(void)` unconditionally
  // -- a body that captures nothing still declares it, and -Werror would object.
  // The dispatch sits AFTER the prologue so it never jumps over a declaration, and before the
  // body so every `_jsrt_res_N:` it names is defined further down. State 0 is the first entry,
  // which falls through into the body's prefix.
  emitter.emitResumeOpen(fn.span, ['_jsrt_v', '_jsrt_err']);
  emitter.emitResumeBody(fn);
  emitter.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', fn.span);
  if (emitter.unwindUsed) {
    // An exception that reached the top of an async body REJECTS the promise rather than
    // staying pending: the caller observes it through `.then`/`await`, not through the mailbox.
    emitter.appendLine('_jsrt_unwind: ;', fn.span);
    emitter.appendLine(`${emitter.slotAt(emitter.returnSlot)} = jsrt_take_exception();`, fn.span);
    emitter.emitAsyncSettle('jsrt_async_throw', emitter.slotAt(emitter.returnSlot), fn.span);
  }
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* A generator unit is TWO C functions, like an async unit, with three differences: the entry
 * point ALLOCATES and returns without running the body (the first `next()` is what starts it);
 * resume is synchronous on `next()`'s stack rather than a microtask; and an uncaught throw
 * stays pending for the call site of `next()` instead of rejecting a promise. Locals still live
 * in the heap environment because a `yield` pops the C frame. */

export function emitGeneratorUnit(emitter: Emitter, unit: FunctionUnit): void {
  const { fn } = unit;
  const resume = `_jsrt_gen_${unit.id}`;
  emitter.appendLine(`static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v);`);
  emitter.appendLine('');
  emitter.emitSuspendEntry(unit, `jsrt_generator_new(_jsrt_env, ${resume})`);
  emitter.appendLine(`static void ${resume}(JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v) {`);
  emitter.indent++;
  emitter.emitResumeOpen(fn.span, ['_jsrt_v']);
  emitter.emitResumeBody(fn);
  emitter.emitGeneratorSettle('JSRT_UNDEFINED', fn.span);
  if (emitter.unwindUsed) {
    // Leave the exception pending: `next()`'s call site observes it. Mark done so a later
    // `next()` after the throw answers `{ value: undefined, done: true }` rather than re-entering.
    emitter.appendLine('_jsrt_unwind: ;', fn.span);
    emitter.appendLine('_jsrt_self->done = true;', fn.span);
    emitter.appendLine('JSRT_FRAME_POP();', fn.span);
    emitter.appendLine('return;', fn.span);
  }
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

/* Entry point shared by async and generator units: allocate the heap environment, store the
 * arguments, produce the promise or generator object, pop, return. The body lives in resume. */

export function emitSuspendEntry(emitter: Emitter, unit: FunctionUnit, produce: string): void {
  const { fn } = unit;
  emitter.appendLine(
    `static jsrt_value _jsrt_fn_${unit.id}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {`,
  );
  emitter.indent++;
  emitter.appendLine('JSRT_STACK_CHECK();', fn.span);
  emitter.appendLine('JSRT_FRAME(1);', fn.span);
  emitter.appendLine(
    `JSRTEnv *_jsrt_env = jsrt_env_new(env, ${Math.max(1, emitter.slotCount)});`,
    fn.span,
  );
  emitter.appendLine('JSRT_FRAME_ENV(_jsrt_env);', fn.span);
  emitter.emitParameterPrologue(fn);
  emitter.appendLine(`jsrt_value _jsrt_r = ${produce};`, fn.span);
  emitter.appendLine('JSRT_FRAME_POP();', fn.span);
  emitter.appendLine('return _jsrt_r;', fn.span);
  emitter.indent--;
  emitter.appendLine('}');
  emitter.appendLine('');
}

export function emitResumeOpen(
  emitter: Emitter,
  span: Span,
  unusedWhenEmpty: readonly string[],
): void {
  emitter.appendLine('JSRT_FRAME(1);', span);
  emitter.appendLine('JSRTEnv *_jsrt_env = _jsrt_self->env;', span);
  emitter.appendLine('JSRT_FRAME_ENV(_jsrt_env);', span);
  emitter.appendLine('JSRTEnv *env = _jsrt_env->parent;', span);
  emitter.appendLine('(void)env;', span);
  if (emitter.awaitStates.size > 0) {
    emitter.appendLine('switch (_jsrt_self->state) {', span);
    emitter.indent++;
    for (const state of emitter.awaitStates.values()) {
      emitter.appendLine(`case ${state}: goto _jsrt_res_${state};`, span);
    }
    emitter.appendLine('default: break;');
    emitter.indent--;
    emitter.appendLine('}', span);
    return;
  }
  for (const name of unusedWhenEmpty) {
    emitter.appendLine(`(void)${name};`, span);
  }
}

export function emitResumeBody(emitter: Emitter, fn: FunctionExpr): void {
  emitter.emitNamedFunctionSelfBinding(fn);
  emitter.emitHoistedFunctions(fn.body.statements);
  for (const stmt of fn.body.statements) {
    emitter.emitStatement(stmt);
  }
}

/* Slot holding a suspension's operand / resume value. Shared by await and yield so the park
 * sequence is one function rather than two copies of the same six lines. */

export function suspendSlot(emitter: Emitter, expr: AwaitExpr | YieldExpr): string {
  const slot = emitter.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error(`${expr.kind} was not registered during counting`);
  }
  return emitter.slotAt(slot);
}

export function emitPark(emitter: Emitter, expr: AwaitExpr | YieldExpr, parkCall: string): string {
  const state = emitter.awaitStates.get(expr);
  if (state === undefined) {
    throw new Error(`${expr.kind} was not registered during counting`);
  }
  const at = emitter.suspendSlot(expr);
  emitter.appendLine(`${at} = ${emitter.emitExpression(expr.value)};`, expr.span);
  emitter.appendLine(`_jsrt_self->state = ${state};`, expr.span);
  // The resume prologue re-reads `_jsrt_self->env`, so the CURRENT environment has to be parked
  // there before the frame disappears -- otherwise a resume inside a per-iteration loop would
  // come back on the loop's base environment while the body's remaining code reads and writes
  // the iteration's clone (measured: `i` stuck at its last value and the loop never exiting,
  // plan-notes 226). For a unit whose env never changes this stores the same pointer it already
  // holds, which is why nothing observed it before.
  emitter.appendLine('_jsrt_self->env = _jsrt_env;', expr.span);
  emitter.appendLine(parkCall, expr.span);
  emitter.appendLine('JSRT_FRAME_POP();', expr.span);
  emitter.appendLine('return;', expr.span);
  emitter.appendLine(`_jsrt_res_${state}: ;`, expr.span);
  return at;
}

/* Settle THEN pop: settling enqueues a microtask, which allocates, and the value being settled
 * with must still be rooted while it does. */

export function emitAsyncSettle(emitter: Emitter, fn: string, value: string, span: Span): void {
  emitter.appendLine(`${fn}(_jsrt_self, ${value});`, span);
  emitter.appendLine('JSRT_FRAME_POP();', span);
  emitter.appendLine('return;', span);
}

export function emitGeneratorSettle(emitter: Emitter, value: string, span: Span): void {
  emitter.appendLine(`jsrt_generator_return(_jsrt_self, ${value});`, span);
  emitter.appendLine('JSRT_FRAME_POP();', span);
  emitter.appendLine('return;', span);
}

export function emitParameterPrologue(emitter: Emitter, fn: FunctionExpr): void {
  if (fn.params.length === 0) {
    emitter.appendLine('(void)argc;');
    emitter.appendLine('(void)argv;');
  }
  fn.params.forEach((param, index) => {
    // A call site may pass fewer or more arguments than the function declares. `jsrt_arg` makes
    // both a value -- `undefined` and "dropped" -- rather than a read past the end of `argv`.
    // A rest parameter packs the extras the call already passed.
    // A default runs when the argument is undefined, including an explicit `undefined`.
    emitter.appendLine(
      param.rest === true
        ? `${emitter.slotRef(param.name)} = jsrt_args_rest(argc, argv, ${index});`
        : `${emitter.slotRef(param.name)} = jsrt_arg(argc, argv, ${index});`,
      param.span,
    );
    if (param.default !== undefined) {
      const slot = emitter.slotRef(param.name);
      emitter.appendLine(`if (jsrt_is(${slot}, JSRT_TAG_UNDEFINED)) {`, param.span);
      emitter.indent++;
      const value = emitter.emitExpression(param.default);
      emitter.appendLine(`${slot} = ${value};`, param.span);
      emitter.indent--;
      emitter.appendLine('}', param.span);
    }
  });
}

/** A literal's shape becomes a class with no constructor, no methods and no table -- which is
 * all a descriptor needs. Two literals of the same shape share the name, so they share the
 * descriptor, which is what makes them one type rather than two. */
/** Claims the next inline-cache site and returns its C name. Every dynamic property site gets
 * its own -- sharing one between two sites would make them evict each other on every
 * alternation, which is the pathology caches exist to avoid. */

export function currentEnv(emitter: Emitter): string {
  if (emitter.envMap.size > 0) {
    return '_jsrt_env';
  }
  return emitter.inFunction ? 'env' : 'NULL';
}

/* A function that captures nothing stays rung 4a's file-static constant -- no allocation. One
 * that does is built per evaluation, which is what makes two evaluations of the same function
 * expression close over different variables. */

export function closureValue(emitter: Emitter, fn: FunctionExpr): string {
  const id = emitter.functionId(fn);
  if (!fn.needsEnv) {
    return `jsrt_closure(&_jsrt_closure_${id})`;
  }
  const name = cNameLiteral(fn.name ?? '');
  const meta = closureMeta(fn);
  const closure = `jsrt_closure_new(_jsrt_fn_${id}, ${meta.arity}, ${name}, ${emitter.currentEnv()}, ${meta.hasReceiver ? 'true' : 'false'})`;
  return fn.constructible === true ? `jsrt_closure_constructible(${closure})` : closure;
}
