/* statements emission for the C emitter (T24 split). */

import type { Emitter } from './emitter.ts';
import type {
  Block,
  ForOfStatement,
  Span,
  Statement,
  SwitchStatement,
  TryStatement,
} from '../hir/nodes.ts';
import { consoleMayThrow } from '../hir/nodes.ts';
import type { TryFinallyScope } from './types.ts';
import { cNameLiteral, ITER_KINDS, indexSetCall } from './helpers.ts';

/** Opens a `while`-shaped loop with `cond` already captured. A compact condition stays on the
 * `while (...)` line; one that needed statements becomes `while (1)` plus a goto test. */
function openCapturedWhile(
  emitter: Emitter,
  id: number,
  span: Span,
  cond: { readonly lines: readonly string[]; readonly value: string } | undefined,
  infiniteHeader = 'while (1) {',
): void {
  if (cond === undefined || cond.lines.length === 0) {
    const test = cond === undefined ? '1' : `jsrt_truthy(${cond.value})`;
    emitter.appendLine(`while (${test}) {`, span);
    emitter.indent++;
    return;
  }
  emitter.appendLine(infiniteHeader, span);
  emitter.indent++;
  emitter.lines.push(...cond.lines);
  emitter.usedLabels.add(`brk_${id}`);
  emitter.appendLine(`if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, span);
}

/** Body + continue target + per-iteration commit shared by while/for and the for-of arms. */
function emitLoopBody(
  emitter: Emitter,
  id: number,
  span: Span,
  statements: readonly Statement[],
): void {
  emitter.emitIterEnvEnter(id, span);
  emitter.emitScope(statements);
  emitter.emitJumpTarget(`cont_${id}`, span);
  emitter.emitIterEnvCommit(id, span);
}

/** Closes a loop jump scope: close the body block, place the break target, drop the env. */
function closeLoopScope(emitter: Emitter, id: number, span: Span): void {
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.emitJumpTarget(`brk_${id}`, span);
  emitter.emitIterEnvClose(id, span);
  emitter.enclosing.pop();
}

/** Constructs the try/finally completion scope both cleanup shapes push. */
function pushFinallyScope(
  emitter: Emitter,
  fin: string,
  compVar: string,
  compBoxed: boolean,
): TryFinallyScope {
  const scope: TryFinallyScope = {
    compVar,
    compBoxed,
    finLabel: fin,
    enclosingDepth: emitter.enclosing.length - 1,
    routes: new Map(),
  };
  emitter.tryFinallyStack.push(scope);
  return scope;
}

/** Runs every recorded jump action against a C `int` completion variable. */
function emitFinallyDispatch(
  emitter: Emitter,
  comp: string,
  routes: ReadonlyMap<string, { readonly code: number; readonly action: () => void }>,
  span: Span,
): void {
  for (const route of routes.values()) {
    emitter.appendLine(`if (${comp} == ${route.code}) {`, span);
    emitter.indent++;
    route.action();
    emitter.indent--;
    emitter.appendLine('}', span);
  }
}

/** Same dispatch against a boxed (number) completion slot — the suspendable cleanup shape. */
function emitFinallyDispatchBoxed(
  emitter: Emitter,
  comp: string,
  routes: ReadonlyMap<string, { readonly code: number; readonly action: () => void }>,
  span: Span,
): void {
  for (const route of routes.values()) {
    emitter.appendLine(`if (jsrt_number_value(${comp}) == ${String(route.code)}) {`, span);
    emitter.indent++;
    route.action();
    emitter.indent--;
    emitter.appendLine('}', span);
  }
}

export function emitStatement(emitter: Emitter, stmt: Statement): void {
  switch (stmt.kind) {
    case 'declaration': {
      if (stmt.value !== undefined) {
        const value = emitter.emitExpression(stmt.value);
        emitter.appendLine(`${emitter.slotRef(stmt.name)} = ${value};`, stmt.span);
      }
      break;
    }

    case 'assignment': {
      const value = emitter.emitExpression(stmt.value);
      emitter.appendLine(`${emitter.slotRef(stmt.target)} = ${value};`, stmt.span);
      break;
    }

    case 'expression-statement': {
      // The console call's own statement form: bare, without the `undefined` that value position
      // has to append. See the `console-log` case in emitExpression for why the two differ.
      if (stmt.expression.kind === 'console-log') {
        emitter.appendLine(`${emitter.consoleCall(stmt.expression)};`, stmt.span);
        if (consoleMayThrow(stmt.expression)) {
          emitter.emitPendingCheck(stmt.span);
        }
        break;
      }
      // An extern call already ran as its own statements (the call, the frees, the checks);
      // what comes back is only the result slot, and a bare line for it would be the same
      // no-op clang warns about for calls below.
      if (stmt.expression.kind === 'extern-call') {
        emitter.emitExpression(stmt.expression);
        break;
      }
      const expr = emitter.emitExpression(stmt.expression);
      // A call already ran as its own statements; what came back is only the slot its result
      // sits in, and a bare `JSRT_LOCAL(3);` line would be a no-op -- one clang warns about.
      // An async unit spells its slots as environment reads, so both forms are matched.
      if (!/^(?:JSRT_(?:LOCAL|GLOBAL)\(\d+\)|_jsrt_env->slots\[\d+\])$/.test(expr)) {
        emitter.appendLine(`${expr};`, stmt.span);
      }
      break;
    }

    case 'if-statement': {
      const cond = emitter.emitExpression(stmt.condition);
      // ToBoolean, not the bool payload: `jsrt_as_bool` reads bit 0, which for a boxed double
      // is a mantissa bit. `if (1)` took the else branch until this was `jsrt_truthy`.
      emitter.appendLine(`if (jsrt_truthy(${cond})) {`, stmt.span);
      emitter.indent++;
      emitter.emitScope(stmt.consequent.statements);
      emitter.indent--;
      if (stmt.alternate) {
        emitter.appendLine('} else {', stmt.span);
        emitter.indent++;
        emitter.emitScope(stmt.alternate.statements);
        emitter.indent--;
      }
      emitter.appendLine('}', stmt.span);
      break;
    }

    case 'while-statement': {
      const id = emitter.enterLoop(stmt);
      emitter.emitIterEnvOpen(id, stmt.span);
      // The condition is captured, not emitted in place: it re-runs every iteration, so any
      // statements it needs (a call and its pending check) must land INSIDE the loop, and a
      // statement cannot sit inside `while (...)`. With none, the compact form survives.
      emitter.indent++;
      const cond = emitter.capture(() => emitter.emitExpression(stmt.condition));
      emitter.indent--;
      openCapturedWhile(emitter, id, stmt.span, cond);
      emitLoopBody(emitter, id, stmt.span, stmt.body.statements);
      closeLoopScope(emitter, id, stmt.span);
      break;
    }

    case 'do-while-statement': {
      const id = emitter.enterLoop(stmt);
      emitter.emitIterEnvOpen(id, stmt.span);
      emitter.appendLine('do {', stmt.span);
      emitter.indent++;
      emitter.emitIterEnvEnter(id, stmt.span);
      emitter.emitScope(stmt.body.statements);
      // `continue` in a do/while jumps to the TEST, not past it -- the loop still gets to decide
      // whether to run again. Placing the target at the end of the body is what achieves that.
      emitter.emitJumpTarget(`cont_${id}`, stmt.span);
      emitter.emitIterEnvCommit(id, stmt.span);
      const cond = emitter.capture(() => emitter.emitExpression(stmt.condition));
      if (cond.lines.length === 0) {
        emitter.indent--;
        emitter.appendLine(`} while (jsrt_truthy(${cond.value}));`, stmt.span);
      } else {
        // The condition needed statements of its own, and `} while (...)` cannot hold them:
        // the test moves into the body's tail, still after the continue target.
        emitter.lines.push(...cond.lines);
        emitter.usedLabels.add(`brk_${id}`);
        emitter.appendLine(`if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
        emitter.indent--;
        emitter.appendLine('} while (1);', stmt.span);
      }
      emitter.emitJumpTarget(`brk_${id}`, stmt.span);
      emitter.emitIterEnvClose(id, stmt.span);
      emitter.enclosing.pop();
      break;
    }

    case 'for-statement': {
      if (stmt.init) {
        emitter.emitStatement(stmt.init);
      }
      const id = emitter.enterLoop(stmt);
      emitter.emitIterEnvOpen(id, stmt.span);
      // An absent condition is an infinite loop, not a false one. `while (1)` rather than
      // synthesising a `true` literal, so nothing downstream has to evaluate a fake node. A
      // present one is captured like while's: its statements must re-run every iteration.
      emitter.indent++;
      const condition = stmt.condition;
      const cond =
        condition === undefined
          ? undefined
          : emitter.capture(() => emitter.emitExpression(condition));
      emitter.indent--;
      openCapturedWhile(emitter, id, stmt.span, cond);
      emitter.emitIterEnvEnter(id, stmt.span);
      emitter.emitScope(stmt.body.statements);
      // The continue target sits BEFORE the update, which is the one thing a `for` gets wrong if
      // it is lowered naively: `continue` skips the rest of the body but must still run `i++`,
      // or the loop never terminates.
      emitter.emitJumpTarget(`cont_${id}`, stmt.span);
      // Commit before the update so `i++` mutates the CONTROL env, not the clone the body
      // captured — otherwise `() => i` would see the post-increment value (1, 2, 3).
      emitter.emitIterEnvCommit(id, stmt.span);
      if (stmt.update) {
        emitter.emitStatement(stmt.update);
      }
      closeLoopScope(emitter, id, stmt.span);
      break;
    }

    case 'switch-statement': {
      emitter.emitSwitch(stmt);
      break;
    }

    case 'break-statement':
    case 'continue-statement': {
      const wantsLoop = stmt.kind === 'continue-statement';
      const target = [...emitter.enclosing]
        .reverse()
        .find(
          (e) =>
            (wantsLoop ? e.isLoop : true) && (stmt.label === undefined || e.label === stmt.label),
        );
      if (target === undefined) {
        // The verifier rejects this as STA4029, so reaching it means the verifier was skipped.
        // Emitting a goto to a label that does not exist would fail in clang instead, against
        // generated C the user never wrote.
        throw new Error(`${stmt.kind} has no enclosing target; verifier should have caught it`);
      }
      const name = `${wantsLoop ? 'cont' : 'brk'}_${target.id}`;
      emitter.emitLoopJump(name, emitter.enclosing.indexOf(target), stmt.span);
      break;
    }

    case 'block': {
      if (stmt.label !== undefined) {
        const id = emitter.enterBreakable(stmt.label);
        emitter.emitScope(stmt.statements);
        emitter.emitJumpTarget(`brk_${id}`, stmt.span);
        emitter.enclosing.pop();
        break;
      }
      emitter.emitScope(stmt.statements);
      break;
    }

    case 'function-declaration':
      // Nothing here: the binding was emitted at the top of the unit (see emitHoistedFunctions)
      // and the body is a separate C function.
      break;

    case 'index-assignment': {
      const base = emitter.indexSlots.get(stmt);
      if (base === undefined) {
        throw new Error('index assignment was not registered during counting');
      }
      const target = emitter.slotAt(base);
      const index = emitter.slotAt(base + 1);
      const value = emitter.slotAt(base + 2);
      // Target, index, value -- the order the language evaluates them, spelled out so C cannot
      // choose another, and each landing in a rooted slot before the next one runs.
      emitter.appendLine(`${target} = ${emitter.emitExpression(stmt.target)};`, stmt.span);
      emitter.appendLine(`${index} = ${emitter.emitExpression(stmt.index)};`, stmt.span);
      emitter.appendLine(`${value} = ${emitter.emitExpression(stmt.value)};`, stmt.span);
      const set = indexSetCall(stmt.target.type, target, index, value);
      emitter.appendLine(`${set};`, stmt.span);
      // Both arms can throw: the dynamic set on a nullish receiver, the static one on a
      // statically-typed array that arrives as something else (STA2008's degrade-to-dynamic
      // read/write, plan.md §8 step 20).
      emitter.emitPendingCheck(stmt.span);
      break;
    }

    case 'for-of-statement': {
      const slot = emitter.forOfSlots.get(stmt);
      if (slot === undefined) {
        throw new Error('for-of has no iterable slot; countBindings missed a node');
      }
      const iterable = emitter.slotAt(slot);
      emitter.appendLine(`${iterable} = ${emitter.emitExpression(stmt.iterable)};`, stmt.span);
      // A statically-typed array that arrives as anything else (`var` hoisting hands the loop
      // `undefined`) used to segfault in the header read below. Validate once up front (STA2009,
      // plan.md §8 step 20), so the sync walk and the boxed async/generator one below are both
      // safe. Only the array kind: every other static kind has its own walk and its own step.
      if (stmt.iterable.type.kind === 'array') {
        emitter.appendLine(`jsrt_require_array_iterable(${iterable});`, stmt.span);
        emitter.emitPendingCheck(stmt.span);
      }
      const id = emitter.enterLoop(stmt);
      emitter.emitIterEnvOpen(id, stmt.span);
      // One predicate for both halves of the decision: counting claims the cleanup
      // triple exactly when emission takes this arm (plan.md §8 step 34).
      const boxed = emitter.forOfIsBoxed(stmt);
      if (boxed && stmt.iterable.type.kind !== 'iterator') {
        // A suspendable unit cannot hold loop state in its C frame: a yield/await in the body
        // pops the frame and the resume's goto jumps over the initializer, so a C-local cursor
        // reads back as garbage. Box the walk instead — the cursor then lives in the heap
        // iterator, the same object a stored `arr.values()` already drives (plan-notes 153).
        const kind = stmt.iterable.type.kind;
        if (kind === 'map' || kind === 'set' || kind === 'array' || kind === 'string') {
          const box =
            kind === 'map'
              ? ITER_KINDS.map.entries
              : kind === 'set'
                ? ITER_KINDS.set.values
                : kind === 'string'
                  ? ITER_KINDS.string
                  : ITER_KINDS.array.values;
          emitter.appendLine(
            `${iterable} = jsrt_iterator_new(${iterable}, ${String(box)});`,
            stmt.span,
          );
        }
      }
      if (boxed) {
        emitter.emitBoxedIteratorForOf(stmt, iterable, id);
        break;
      }
      if (stmt.iterable.type.kind === 'map' || stmt.iterable.type.kind === 'set') {
        emitter.emitMapSetForOf(stmt, iterable, id);
        break;
      }
      const cursor = `jsrt_iter_${id}`;
      if (stmt.iterable.type.kind === 'string') {
        // Strings are immutable, so bounding on length is safe. The cursor advances 1 or 2
        // units per step — one code point, matching String.prototype[@@iterator].
        emitter.appendLine(
          `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_string_length(${iterable}); ) {`,
          stmt.span,
        );
        emitter.indent++;
        emitter.appendLine(
          `${emitter.slotRef(stmt.binding)} = jsrt_string_iter_next(${iterable}, &${cursor});`,
          stmt.span,
        );
      } else {
        // The length is re-read every iteration, not hoisted: the array iterator compares the
        // cursor against the CURRENT length on each step, so a body that shortens the array must
        // stop early. Hoisting it would walk off the end of a shrunk array.
        emitter.appendLine(
          `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_as_array(${iterable})->length; ${cursor}++) {`,
          stmt.span,
        );
        emitter.indent++;
        emitter.emitArrayForOfYield(stmt, iterable, cursor);
      }
      emitter.emitIterEnvEnter(id, stmt.span);
      emitter.emitScope(stmt.body.statements);
      emitter.emitJumpTarget(`cont_${id}`, stmt.span);
      emitter.emitIterEnvCommit(id, stmt.span);
      emitter.indent--;
      emitter.appendLine('}', stmt.span);
      emitter.emitJumpTarget(`brk_${id}`, stmt.span);
      emitter.emitIterEnvClose(id, stmt.span);
      emitter.enclosing.pop();
      break;
    }

    case 'return-statement': {
      if (!emitter.inFunction) {
        throw new Error('return outside a function; verifier should have caught it');
      }
      const slot = emitter.slotAt(emitter.returnSlot);
      if (stmt.value === undefined) {
        if (emitter.tryFinallyStack.length === 0) {
          if (emitter.inAsync) {
            emitter.emitAsyncSettle('jsrt_async_return', 'JSRT_UNDEFINED', stmt.span);
            break;
          }
          if (emitter.inGenerator) {
            emitter.emitGeneratorSettle('JSRT_UNDEFINED', stmt.span);
            break;
          }
          emitter.appendLine('JSRT_FRAME_POP();', stmt.span);
          emitter.appendLine('return JSRT_UNDEFINED;', stmt.span);
          break;
        }
        // An enclosing finally must run first: park the value, route only the jump.
        emitter.appendLine(`${slot} = JSRT_UNDEFINED;`, stmt.span);
        emitter.emitReturnJump(stmt.span);
        break;
      }
      const value = emitter.emitExpression(stmt.value);
      if (emitter.tryFinallyStack.length !== 0) {
        emitter.appendLine(`${slot} = ${value};`, stmt.span);
        emitter.emitReturnJump(stmt.span);
        break;
      }
      // Evaluate into a rooted slot FIRST, pop SECOND, read THIRD. Popping before evaluating
      // would run the expression -- and any allocation in it -- with this frame's locals
      // invisible to the collector. An async return settles instead of returning, and settling
      // allocates, so it sits inside the same window.
      if (emitter.inAsync) {
        emitter.appendLine(`${slot} = ${value};`, stmt.span);
        emitter.emitAsyncSettle('jsrt_async_return', slot, stmt.span);
        break;
      }
      if (emitter.inGenerator) {
        emitter.appendLine(`${slot} = ${value};`, stmt.span);
        emitter.emitGeneratorSettle(slot, stmt.span);
        break;
      }
      emitter.appendLine(`return (${slot} = ${value}, JSRT_FRAME_POP(), ${slot});`, stmt.span);
      break;
    }

    case 'field-assignment': {
      emitter.emitFieldWrite(
        stmt,
        (target, value) => `jsrt_object_set(${target}, ${stmt.slot}, ${value})`,
        'field assignment was not registered during counting',
      );
      break;
    }

    // Same shape as field-assignment; the differences are the slow-path entry point, the KEY
    // (a string, not a slot -- the shape table resolves it), and the per-site cache. A frozen
    // object throws, so a pending check follows.
    case 'dyn-field-assignment': {
      emitter.emitFieldWrite(
        stmt,
        (target, value) =>
          `jsrt_set_prop(${target}, ${cNameLiteral(stmt.field)}, ${value}, &${emitter.icSite()})`,
        'dynamic field assignment was not registered during counting',
      );
      break;
    }

    case 'super-call': {
      // A base with nothing to run emits nothing -- and reserves nothing at counting time, by
      // the matching guard there -- so this check comes before the slot lookup, not after it.
      const ctor = emitter.classAt(stmt.className).ctor;
      // A base with nothing to run emits nothing. It can take no arguments either -- the checker
      // rejects arguments to a constructor that does not exist -- so no side effect is skipped.
      if (ctor === undefined) {
        break;
      }
      const base = emitter.callSlots.get(stmt);
      if (base === undefined) {
        throw new Error('super call was not registered during counting');
      }
      const parts: string[] = [];
      emitter.sequencePart(
        parts,
        stmt.receiver,
        stmt.span,
        (v) => `${emitter.slotAt(base)} = ${v}`,
      );
      stmt.args.forEach((arg, index) => {
        emitter.sequencePart(
          parts,
          arg,
          stmt.span,
          (v) => `${emitter.slotAt(base + 1 + index)} = ${v}`,
        );
      });
      parts.push(
        `jsrt_call(${emitter.closureValue(ctor.fn)}, ${1 + stmt.args.length}, &${emitter.slotAt(base)})`,
      );
      emitter.flushParts(parts, stmt.span);
      emitter.emitPendingCheck(stmt.span);
      break;
    }

    // Nothing runs here. A class's descriptor and its member functions are file-scope, and the
    // name is not a binding -- so the declaration's whole effect happened at compile time.
    case 'class-declaration':
      // The class itself emits nothing -- its descriptor is file-scope and its members are
      // function units. Its statics DO emit, here, which is what puts their initializers in
      // source order: a static is live from the class declaration onward, not before.
      for (const decl of stmt.statics) {
        emitter.emitStatement(decl);
      }
      break;

    case 'throw-statement': {
      const value = emitter.emitExpression(stmt.value);
      // Overwrite-on-throw is the pending cell's contract (runtime/src/jsrt_throw.c): a throw
      // inside a finally REPLACES whatever completion was pending, which is the language rule.
      emitter.appendLine(`jsrt_throw(${value});`, stmt.span);
      emitter.appendLine(`goto ${emitter.currentPad()};`, stmt.span);
      break;
    }

    case 'try-statement': {
      emitter.emitTry(stmt);
      break;
    }

    default: {
      const _exhaustive: never = stmt;
      throw new Error(
        `Unknown statement kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
      );
    }
  }
}

/* Map/Set for-of holds `iterating` for the walk so compaction cannot renumber the cursor.
 * Return, throw, and a break out of THIS loop must drop that count; continue must not.
 *
 * The cleanup is a try/finally with no catch: throw jumps to a pad that ends the walk and
 * re-enters the enclosing pad with the exception still pending, and return/outer-break route
 * through `fin` the way a real finally does. `enclosingDepth` is the parent of this loop, so
 * continue (and a break that lands on `brk` just before `fin`) stay inside. */

/** Leaves the protected body for the finally: pop the throw pad, jump to fin, and place the
 * thr label when the body actually registered it. */
function openFinallyTail(emitter: Emitter, fin: string, finThr: string, span: Span): boolean {
  emitter.padStack.pop();
  emitter.usedLabels.add(fin);
  emitter.appendLine(`goto ${fin};`, span);
  if (!emitter.usedLabels.has(finThr)) {
    return false;
  }
  emitter.appendLine(`${finThr}: ;`, span);
  return true;
}

/** Break target + scope pop + block close shared by the two for-of cleanup shapes. */
function closeFinallyLoop(emitter: Emitter, id: number, span: Span): void {
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.emitIterEnvClose(id, span);
  emitter.enclosing.pop();
}

/** Body then close the C block the loop wrote. */
function emitLoopBodyAndClose(
  emitter: Emitter,
  id: number,
  span: Span,
  statements: readonly Statement[],
): void {
  emitLoopBody(emitter, id, span, statements);
  emitter.indent--;
  emitter.appendLine('}', span);
}

export function emitMapSetForOf(
  emitter: Emitter,
  stmt: ForOfStatement,
  iterable: string,
  id: number,
): void {
  const span = stmt.span;
  const cursor = `jsrt_iter_${id}`;
  const key = `_jsrt_k_${id}`;
  const val = `_jsrt_v_${id}`;
  const coll = `_jsrt_coll_${id}`;
  // A bare `return` through this cleanup parks `undefined` in `returnSlot`, which is slot 0 when
  // the function never returns a value — the same index as the iterable. Hold the collection in
  // a C local so `iter_end` cannot decrement through that overwrite.
  emitter.appendLine(`jsrt_value ${coll} = ${iterable};`, span);
  emitter.appendLine(`jsrt_map_iter_begin(${coll});`, span);

  const tryId = emitter.tryCount++;
  const comp = `_jsrt_mapcomp_${tryId}`;
  const fin = `_jsrt_mapfin_${tryId}`;
  const finThr = `_jsrt_mapfinthr_${tryId}`;
  emitter.appendLine('{', span);
  emitter.indent++;
  emitter.appendLine(`int ${comp} = 0;`, span);
  const scope = pushFinallyScope(emitter, fin, comp, false);
  emitter.padStack.push(finThr);

  emitter.appendLine(`jsrt_value ${key};`, span);
  emitter.appendLine(`jsrt_value ${val};`, span);
  emitter.appendLine(
    `for (uint32_t ${cursor} = 0; jsrt_map_iter_step(${coll}, &${cursor}, &${key}, &${val}); ) {`,
    span,
  );
  emitter.indent++;
  emitter.emitMapSetForOfYield(stmt, key, val);
  emitLoopBodyAndClose(emitter, id, span, stmt.body.statements);

  if (openFinallyTail(emitter, fin, finThr, span)) {
    emitter.appendLine(`jsrt_map_iter_end(${coll});`, span);
    emitter.appendLine(`goto ${emitter.currentPad()};`, span);
  }
  emitter.emitJumpTarget(`brk_${id}`, span);
  emitter.tryFinallyStack.pop();
  emitter.appendLine(`${fin}: ;`, span);
  emitter.appendLine(`jsrt_map_iter_end(${coll});`, span);
  emitFinallyDispatch(emitter, comp, scope.routes, span);
  closeFinallyLoop(emitter, id, span);
}

export function emitArrayForOfYield(
  emitter: Emitter,
  stmt: ForOfStatement,
  iterable: string,
  cursor: string,
): void {
  const bind = emitter.slotRef(stmt.binding);
  if (stmt.view === 'keys') {
    emitter.appendLine(`${bind} = jsrt_number((double)${cursor});`, stmt.span);
    return;
  }
  // A hole reads as undefined (an array of an Unknown element may be sparse; docs/VALUE.md §4.4).
  const element = `jsrt_unhole(jsrt_as_array(${iterable})->elements[${cursor}])`;
  if (stmt.view === 'entries') {
    const pair = `_jsrt_pair_${cursor}`;
    emitter.appendLine(
      `jsrt_value ${pair}[2] = { jsrt_number((double)${cursor}), ${element} };`,
      stmt.span,
    );
    emitter.appendLine(`${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
    return;
  }
  emitter.appendLine(`${bind} = ${element};`, stmt.span);
}

export function emitMapSetForOfYield(
  emitter: Emitter,
  stmt: ForOfStatement,
  key: string,
  val: string,
): void {
  const bind = emitter.slotRef(stmt.binding);
  const map = stmt.iterable.type.kind === 'map';
  if (stmt.view === 'keys' || (!map && stmt.view !== 'entries')) {
    emitter.appendLine(`${bind} = ${key};`, stmt.span);
    return;
  }
  if (stmt.view === 'values' && map) {
    emitter.appendLine(`${bind} = ${val};`, stmt.span);
    return;
  }
  const pair = `_jsrt_pair_${key}`;
  const second = map ? val : key;
  emitter.appendLine(`jsrt_value ${pair}[2] = { ${key}, ${second} };`, stmt.span);
  emitter.appendLine(`${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
}

/* Whether this for-of drives a boxed iterator rather than an inlined walk: a generator
 * (or stored iterator) always does, and a collection walk does when the unit can suspend
 * across it. Counting and emission both ask this one predicate, so the cleanup triple is
 * claimed exactly when the boxed arm below takes it. */

export function forOfIsBoxed(emitter: Emitter, stmt: ForOfStatement): boolean {
  if (stmt.iterable.type.kind === 'iterator') {
    return true;
  }
  if (!emitter.inAsync && !emitter.inGenerator) {
    return false;
  }
  const kind = stmt.iterable.type.kind;
  return kind === 'map' || kind === 'set' || kind === 'array' || kind === 'string';
}

/* A boxed-iterator walk with IteratorClose on abrupt exit (plan.md §8 step 34).
 *
 * A `break`, `return` or `throw` out of the body must run the iterator's `return()` — a
 * generator's `finally` — while `continue` and exhaustion must not. The cleanup is a
 * try/finally with no catch on the `emitMapSetForOf` shape, but with the completion code
 * BOXED in a counted slot: unlike that loop this one suspends, so a C-local comp would not
 * survive a yield/await between the route and the dispatch.
 *
 * `brk` lands just before the fin and flows through the close; `cont` sits inside the loop
 * and never reaches it. A throw (including a throwing step, which closes too) parks its
 * completion in the fin-throw pad, where the exception is stashed BEFORE the close runs:
 * the close itself can throw — a throwing `finally` — and its exception must find the cell
 * empty to overwrite while the original waits rooted. The fin then gives the ORIGINAL
 * exception precedence (ECMA-262 IteratorClose); on the break/return path a throwing close
 * propagates instead. */

export function emitBoxedIteratorForOf(
  emitter: Emitter,
  stmt: ForOfStatement,
  iterable: string,
  id: number,
): void {
  const span = stmt.span;
  const closeBase = emitter.forOfCloseSlots.get(stmt);
  if (closeBase === undefined) {
    throw new Error('boxed for-of has no close slots; countBindings missed a node');
  }
  const iterCopy = emitter.slotAt(closeBase);
  const exc = emitter.slotAt(closeBase + 1);
  const comp = emitter.slotAt(closeBase + 2);
  const item = `_jsrt_item_${id}`;
  // The fin must not read the iterable slot itself: see the counting arm.
  emitter.appendLine(`${iterCopy} = ${iterable};`, span);

  const tryId = emitter.tryCount++;
  const fin = `_jsrt_forfin_${tryId}`;
  const finThr = `_jsrt_forfinthr_${tryId}`;
  emitter.appendLine('{', span);
  emitter.indent++;
  emitter.appendLine(`${comp} = jsrt_number(0);`, span);
  const scope = pushFinallyScope(emitter, fin, comp, true);
  emitter.padStack.push(finThr);

  emitter.appendLine(`jsrt_value ${item};`, span);
  emitter.appendLine(`for (;;) {`, span);
  emitter.indent++;
  emitter.appendLine(`if (!jsrt_iterator_step(${iterable}, &${item})) {`, span);
  emitter.indent++;
  // A generator's step can throw: false then means "stop AND unwind", not "exhausted".
  // The pad on top is the fin-throw below, so the close runs on this path too.
  emitter.appendLine(`if (jsrt_pending()) { goto ${emitter.currentPad()}; }`, span);
  emitter.appendLine('break;', span);
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.appendLine(`${emitter.slotRef(stmt.binding)} = ${item};`, span);
  emitLoopBodyAndClose(emitter, id, span, stmt.body.statements);

  if (openFinallyTail(emitter, fin, finThr, span)) {
    emitter.appendLine(`${comp} = jsrt_number(1);`, span);
    // Take BEFORE the close runs, for the reason the header comment gives.
    emitter.appendLine(`${exc} = jsrt_take_exception();`, span);
    emitter.appendLine(`goto ${fin};`, span);
  }
  emitter.emitJumpTarget(`brk_${id}`, span);
  emitter.tryFinallyStack.pop();
  emitter.appendLine(`${fin}: ;`, span);
  emitter.appendLine(`jsrt_iterator_close(${iterCopy});`, span);
  emitter.appendLine(`if (jsrt_pending()) {`, span);
  emitter.indent++;
  emitter.appendLine(`if (jsrt_number_value(${comp}) == 1) {`, span);
  emitter.indent++;
  emitter.appendLine(`(void)jsrt_take_exception();`, span);
  emitter.appendLine(`jsrt_throw(${exc});`, span);
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.appendLine(`goto ${emitter.currentPad()};`, span);
  emitter.indent--;
  emitter.appendLine('}', span);
  emitter.appendLine(
    `if (jsrt_number_value(${comp}) == 1) { jsrt_throw(${exc}); goto ${emitter.currentPad()}; }`,
    span,
  );
  emitFinallyDispatchBoxed(emitter, comp, scope.routes, span);
  closeFinallyLoop(emitter, id, span);
}

/** Opens a loop's jump scope. `stmt` is what ties the loop to the two suspension slots counted
 * for it (`iterEnvSlots`): the id is minted here, at emission time, and the slots had to exist
 * before it, so the statement is the only key both passes share. */

export function enterLoop(
  emitter: Emitter,
  stmt: { label?: string; perIterationEnv?: true },
): number {
  const id = emitter.loopCount++;
  const iterEnv = stmt.perIterationEnv === true && emitter.envMap.size > 0;
  if (iterEnv) {
    const base = emitter.iterEnvSlots.get(stmt as unknown as Statement);
    if (base === undefined) {
      throw new Error('per-iteration loop was not counted; countBindings missed a node');
    }
    emitter.iterEnvBase.set(id, base);
  }
  emitter.enclosing.push({
    id,
    isLoop: true,
    ...(stmt.label !== undefined && { label: stmt.label }),
    ...(iterEnv && { iterEnv: true }),
  });
  return id;
}

/** Claims the two slots a per-iteration loop needs when it can be suspended across: nothing when
 * the loop has no environment to clone, so an ordinary `for` pays no slot. */

export function enterBreakable(emitter: Emitter, label: string): number {
  const id = emitter.loopCount++;
  emitter.enclosing.push({ id, isLoop: false, label });
  return id;
}

export function iterEnvOf(emitter: Emitter, id: number): boolean {
  return emitter.enclosing.some((e) => e.id === id && e.iterEnv === true);
}

/* Re-roots the live frame at a new environment. Which frame that IS depends on scope: inside a
 * function it is the `JSRT_FRAME(n)` the unit opened, and at module top level it is the globals
 * frame, which is the only one a sync `main` has. Both spellings assign the same field. */

export function frameEnvLine(emitter: Emitter, env: string): string {
  return emitter.inFunction ? `JSRT_FRAME_ENV(${env});` : `JSRT_GLOBALS_ENV(${env});`;
}

/** The two slots a per-iteration loop keeps its environment state in, as lvalues. */

export function iterEnvState(emitter: Emitter, id: number): { saved: string; iter: string } {
  const base = emitter.iterEnvBase.get(id);
  if (base === undefined) {
    throw new Error('per-iteration loop has no suspension slots; countBindings missed a node');
  }
  return { saved: emitter.slotAt(base), iter: emitter.slotAt(base + 1) };
}

/* Opening, entering, committing and closing a loop that clones its environment per iteration.
 *
 * The state lives in two SLOTS rather than two C locals -- see `iterEnvSlots` for why, and note
 * what that buys: the same four emitters serve a sync unit (frame slots) and an async or
 * generator unit (environment slots, which survive a suspension), so a loop body can `await`
 * without a second code path. The slots hold raw `JSRTEnv *` bit-cast into `jsrt_value`; nothing
 * reads them as values, and the collector's mark procedure traces the pointer. */

export function emitIterEnvOpen(emitter: Emitter, id: number, span: Span): void {
  if (!emitter.iterEnvOf(id)) {
    return;
  }
  const { saved, iter } = emitter.iterEnvState(id);
  emitter.appendLine(`${saved} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
  emitter.appendLine(`${iter} = (jsrt_value)0;`, span);
}

function withLiveIterEnv(
  emitter: Emitter,
  id: number,
  span: Span,
  slot: 'saved' | 'iter',
  body: (state: { readonly saved: string; readonly iter: string }, name: string) => void,
): void {
  if (!emitter.iterEnvOf(id)) {
    return;
  }
  const state = emitter.iterEnvState(id);
  const name = state[slot];
  emitter.appendLine(`if (${name} != (jsrt_value)0) {`, span);
  emitter.indent++;
  body(state, name);
  emitter.indent--;
  emitter.appendLine('}', span);
}

export function emitIterEnvEnter(emitter: Emitter, id: number, span: Span): void {
  withLiveIterEnv(emitter, id, span, 'saved', (state, saved) => {
    emitter.appendLine(`_jsrt_env = jsrt_env_clone((JSRTEnv *)(uintptr_t)${saved});`, span);
    emitter.appendLine(`${state.iter} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
    emitter.appendLine(emitter.frameEnvLine('_jsrt_env'), span);
  });
}

export function emitIterEnvCommit(emitter: Emitter, id: number, span: Span): void {
  withLiveIterEnv(emitter, id, span, 'iter', (state, iter) => {
    emitter.appendLine(
      `jsrt_env_copy_slots((JSRTEnv *)(uintptr_t)${state.saved}, (JSRTEnv *)(uintptr_t)${iter});`,
      span,
    );
    emitter.appendLine(`_jsrt_env = (JSRTEnv *)(uintptr_t)${state.saved};`, span);
    emitter.appendLine(emitter.frameEnvLine('_jsrt_env'), span);
  });
}

export function emitIterEnvClose(_emitter: Emitter, _id: number, _span: Span): void {
  // Nothing to close: the state is slots, not a C block's locals. The method stays because its
  // call sites sit beside `emitJumpTarget('brk_…')` and read as the pair they are.
}

export function commitIterEnvs(emitter: Emitter, fromIndexInclusive: number, span: Span): void {
  for (let i = emitter.enclosing.length - 1; i >= fromIndexInclusive; i--) {
    const e = emitter.enclosing[i];
    if (e !== undefined && e.iterEnv === true) {
      emitter.emitIterEnvCommit(e.id, span);
    }
  }
}

/* A `label: ;` line, written only if something jumps to it. The trailing `;` is not cosmetic:
 * before C23 a label must be followed by a statement, and a label at the end of a block is not. */

export function emitJumpTarget(emitter: Emitter, name: string, span: Span): void {
  if (emitter.usedLabels.has(name)) {
    emitter.appendLine(`${name}: ;`, span);
  }
}

/* Where control goes when an exception is pending: the innermost try's landing pad, or the
 * unit's own unwind tail when no try is open. Asking marks the pad used, which is what decides
 * whether the tail -- or a catch that nothing in its try body can reach -- is emitted at all. */

export function currentPad(emitter: Emitter): string {
  const pad = emitter.padStack.at(-1);
  if (pad === undefined) {
    emitter.unwindUsed = true;
    return '_jsrt_unwind';
  }
  emitter.usedLabels.add(pad);
  return pad;
}

/* The check after every operation that can throw. Throwing operations are emitted as their own
 * STATEMENTS -- never inside a consumer's expression -- precisely so this line can sit between
 * the operation and whatever consumes its result: a callee that threw left `undefined` behind,
 * and nothing may observe it. */

export function emitLoopJump(
  emitter: Emitter,
  name: string,
  targetIndex: number,
  span: Span,
): void {
  const scope = emitter.tryFinallyStack.at(-1);
  if (scope !== undefined && scope.enclosingDepth > targetIndex) {
    emitter.routeJump(scope, name, span, () => emitter.emitLoopJump(name, targetIndex, span));
    return;
  }
  const continuing = name.startsWith('cont_');
  emitter.commitIterEnvs(continuing ? targetIndex + 1 : targetIndex, span);
  emitter.usedLabels.add(name);
  emitter.appendLine(`goto ${name};`, span);
}

/* A `return` whose enclosing finally bodies must run first. The value already sits in the
 * (rooted) return slot; only the JUMP routes, and the same chaining as emitLoopJump applies. */

export function emitReturnJump(emitter: Emitter, span: Span): void {
  const scope = emitter.tryFinallyStack.at(-1);
  if (scope === undefined) {
    emitter.commitIterEnvs(0, span);
    const slot = emitter.slotAt(emitter.returnSlot);
    if (emitter.inAsync) {
      emitter.emitAsyncSettle('jsrt_async_return', slot, span);
      return;
    }
    if (emitter.inGenerator) {
      emitter.emitGeneratorSettle(slot, span);
      return;
    }
    emitter.appendLine(`return (JSRT_FRAME_POP(), ${slot});`, span);
    return;
  }
  emitter.routeJump(scope, 'return', span, () => emitter.emitReturnJump(span));
}

/* Records the jump in the completion variable and enters the finally. One code per DISTINCT
 * jump, allocated on first use: two `break`s to the same loop share a code and a dispatch arm,
 * a `break` and a `return` do not. Codes 0 (normal) and 1 (throw) are reserved. */

export function routeJump(
  emitter: Emitter,
  scope: TryFinallyScope,
  key: string,
  span: Span,
  action: () => void,
): void {
  let route = scope.routes.get(key);
  if (route === undefined) {
    route = { code: 2 + scope.routes.size, action };
    scope.routes.set(key, route);
  }
  emitter.appendLine(
    scope.compBoxed
      ? `${scope.compVar} = jsrt_number(${String(route.code)});`
      : `${scope.compVar} = ${String(route.code)};`,
    span,
  );
  emitter.appendLine(`goto ${scope.finLabel};`, span);
}

/* Landing-pad lowering, the shape plan.md Task 3.10 and docs/VALUE.md §6 prescribe: no setjmp,
 * no unwinder -- a throwing call is followed by `if (jsrt_pending()) goto pad;`, and this emits
 * the pads those checks target. */

export function emitTry(emitter: Emitter, stmt: TryStatement): void {
  const id = emitter.tryCount++;
  if (stmt.finallyBlock === undefined) {
    emitter.emitTryCatch(stmt, id);
  } else {
    emitter.emitTryFinally(stmt, stmt.finallyBlock, id);
  }
}

export function emitTryCatch(emitter: Emitter, stmt: TryStatement, id: number): void {
  const catchPad = `_jsrt_cat_${id}`;
  emitter.padStack.push(catchPad);
  emitter.emitStatement(stmt.tryBlock);
  emitter.padStack.pop();
  if (!emitter.usedLabels.has(catchPad)) {
    // No operation in the try body jumped to the pad, so the catch is unreachable and emitting it
    // would put dead C behind an unconditional goto. That is an OPTIMIZATION resting on an
    // invariant: every runtime call that can leave a pending exception is followed by a
    // `emitPendingCheck`, and that check is what both reports the failure and keeps this pad
    // alive. A throwing operation without the check does not merely lose its own diagnostic --
    // it takes the whole catch block with it, which is how `"length" in "abc"` came to print
    // `false` instead of a caught TypeError (plan-notes 220).
    return;
  }
  const end = `_jsrt_try_end_${id}`;
  emitter.usedLabels.add(end);
  emitter.appendLine(`goto ${end};`, stmt.span);
  emitter.appendLine(`${catchPad}: ;`, stmt.span);
  emitter.emitCatchEntry(stmt);
  if (stmt.catchBlock !== undefined) {
    emitter.emitStatement(stmt.catchBlock);
  }
  emitter.appendLine(`${end}: ;`, stmt.span);
}

/* The completion-code protocol: 0 falls through the dispatch (normal completion), 1 rethrows
 * the stashed exception, 2+ re-perform a recorded jump. The dispatch sits AFTER the finally
 * body, so a finally that itself throws or jumps never reaches it -- which is the language
 * rule: the finally's own completion replaces the one on the way through. */

export function emitTryFinally(
  emitter: Emitter,
  stmt: TryStatement,
  finallyBlock: Block,
  id: number,
): void {
  const finThr = `_jsrt_finthr_${id}`;
  const fin = `_jsrt_fin_${id}`;
  const excIndex = emitter.trySlots.get(stmt);
  if (excIndex === undefined) {
    throw new Error('try/finally has no exception slot; countBindings missed a node');
  }
  const exc = emitter.slotAt(excIndex);
  // The completion code is a counted slot, boxed as a number: a suspension between the route
  // and the dispatch pops the C frame, and only a slot survives that (countBindings claims the
  // pair -- exc, then comp -- so they sit adjacently).
  const comp = emitter.slotAt(excIndex + 1);
  emitter.appendLine('{', stmt.span);
  emitter.indent++;
  emitter.appendLine(`${comp} = jsrt_number(0);`, stmt.span);
  const scope: TryFinallyScope = {
    compVar: comp,
    compBoxed: true,
    finLabel: fin,
    enclosingDepth: emitter.enclosing.length,
    routes: new Map(),
  };
  emitter.tryFinallyStack.push(scope);
  const catchPad = stmt.catchBlock === undefined ? finThr : `_jsrt_cat_${id}`;
  emitter.padStack.push(catchPad);
  emitter.emitStatement(stmt.tryBlock);
  emitter.padStack.pop();
  emitter.usedLabels.add(fin);
  emitter.appendLine(`goto ${fin};`, stmt.span);
  if (stmt.catchBlock !== undefined && emitter.usedLabels.has(catchPad)) {
    emitter.appendLine(`${catchPad}: ;`, stmt.span);
    emitter.emitCatchEntry(stmt);
    emitter.padStack.push(finThr);
    emitter.emitStatement(stmt.catchBlock);
    emitter.padStack.pop();
    emitter.appendLine(`goto ${fin};`, stmt.span);
  }
  // The scope pops HERE: a return/break/throw inside the finally body itself does not route
  // through this finally again -- it replaces the pending completion, which is exactly what
  // leaving comp undispatched does.
  emitter.tryFinallyStack.pop();
  if (emitter.usedLabels.has(finThr)) {
    emitter.appendLine(`${finThr}: ;`, stmt.span);
    emitter.appendLine(`${comp} = jsrt_number(1);`, stmt.span);
    // Take BEFORE the finally body runs: the body may itself throw, and its exception must
    // find the cell empty to overwrite, while this one waits in a rooted slot.
    emitter.appendLine(`${exc} = jsrt_take_exception();`, stmt.span);
  }
  emitter.appendLine(`${fin}: ;`, stmt.span);
  emitter.emitStatement(finallyBlock);
  if (emitter.usedLabels.has(finThr)) {
    emitter.appendLine(
      `if (jsrt_number_value(${comp}) == 1) { jsrt_throw(${exc}); goto ${emitter.currentPad()}; }`,
      stmt.span,
    );
  }
  for (const route of scope.routes.values()) {
    emitter.appendLine(`if (jsrt_number_value(${comp}) == ${String(route.code)}) {`, stmt.span);
    emitter.indent++;
    route.action();
    emitter.indent--;
    emitter.appendLine('}', stmt.span);
  }
  emitter.indent--;
  emitter.appendLine('}', stmt.span);
}

/* Taking the exception is what re-arms the cell for the next throw; a binding-less catch still
 * takes, it just has nowhere to put the value. */

export function emitCatchEntry(emitter: Emitter, stmt: TryStatement): void {
  if (stmt.catchBinding !== undefined) {
    emitter.appendLine(`${emitter.slotRef(stmt.catchBinding)} = jsrt_take_exception();`, stmt.span);
  } else {
    emitter.appendLine('(void)jsrt_take_exception();', stmt.span);
  }
}

/* A JavaScript switch is not a C switch and cannot be emitted as one. C requires integer
 * constant cases; JS compares with STRICT EQUALITY against arbitrary expressions, so
 * `case 'x'` and `case n + 1` are both legal. JS also tries `default` LAST no matter where it
 * appears, while still falling through from whatever clause precedes it textually.
 *
 * All three fall out of one shape: run every case test in source order, jump to the matching
 * clause, and lay the clause bodies out in source order so fall-through is simply not jumping. */

export function emitSwitch(emitter: Emitter, stmt: SwitchStatement): void {
  const id = emitter.loopCount++;
  // A switch is breakable but not continuable: `continue` inside one belongs to the enclosing
  // loop, which is why this pushes isLoop: false rather than reusing enterLoop.
  emitter.enclosing.push({
    id,
    isLoop: false,
    ...(stmt.label !== undefined && { label: stmt.label }),
  });

  const slot = emitter.switchSlots.get(stmt);
  if (slot === undefined) {
    throw new Error('switch has no discriminant slot; countBindings missed a node');
  }
  const disc = emitter.slotAt(slot);
  emitter.appendLine(`${disc} = ${emitter.emitExpression(stmt.discriminant)};`, stmt.span);

  // The clause list is ONE block scope, not one per clause (docs on SwitchClause say so), so the
  // function declarations of every clause hoist together and ahead of the dispatch. Hoisting
  // per clause instead would leave a declaration uninitialized whenever the jump lands past it.
  for (const clause of stmt.clauses) {
    emitter.emitHoistedFunctions(clause.statements);
  }

  let defaultIndex: number | undefined;
  stmt.clauses.forEach((clause, i) => {
    if (clause.test === undefined) {
      defaultIndex = i;
      return;
    }
    const test = emitter.emitExpression(clause.test);
    emitter.appendLine(
      `if (jsrt_strict_equals(${disc}, ${test})) goto case_${id}_${i};`,
      stmt.span,
    );
  });

  // Every test failed. `default` is the fallback wherever it was written; with no default at
  // all, the whole statement is skipped.
  if (defaultIndex === undefined) {
    emitter.usedLabels.add(`brk_${id}`);
    emitter.appendLine(`goto brk_${id};`, stmt.span);
  } else {
    emitter.appendLine(`goto case_${id}_${defaultIndex};`, stmt.span);
  }

  stmt.clauses.forEach((clause, i) => {
    // Unconditional: every clause label is the target of either its own test or the default
    // jump above, so none of them can be unused.
    emitter.appendLine(`case_${id}_${i}: ;`, stmt.span);
    emitter.indent++;
    for (const s of clause.statements) {
      emitter.emitStatement(s);
    }
    emitter.indent--;
  });

  emitter.emitJumpTarget(`brk_${id}`, stmt.span);
  emitter.enclosing.pop();
}

/** The bare C call behind a console node — no value appended.
 *
 * The operand list is positional; the WIDTH picks the entry point, which is the only thing the
 * two short forms need from it. Both call sites (value position and statement position) go
 * through here so the width-to-entry-point rule is stated once.
 *
 * With TWO OR MORE arguments each one is evaluated into its own rooted slot, in source order,
 * BEFORE the call: C evaluates function arguments in an unspecified order, so
 * `console.assert(a[0] === 1, f(a))` ran `f` first and then read the array it had just mutated
 * -- the assertion reported a failure Node never sees (plan-notes 221). The slots also keep
 * every argument alive across the next one's evaluation. One argument needs neither: there is no
 * order to fix and nothing can run between its evaluation and the call. */
/** The first slot of a console call's contiguous rooted run, after evaluating every
 * argument into its slot in source order. Shared by the positional and the `(count, argv)`
 * forms, which differ only in what call string they build over the run. */
