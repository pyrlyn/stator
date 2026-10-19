/* Statement emission: blocks, loops, try, switch, and jumps.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import {
  consoleMayThrow,
  type Block,
  type DynFieldAssignment,
  type FieldAssignment,
  type ForOfStatement,
  type Span,
  type Statement,
  type SwitchStatement,
  type TryStatement,
} from '../hir/nodes.ts';
import { ITER_KINDS, cNameLiteral, indexSetCall, type TryFinallyScope } from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgClass from './classes.ts';
import * as cgClosure from './closures.ts';
import * as cgExpr from './expr.ts';
import * as cgRuntime from './runtime-calls.ts';
import * as cgSeq from './sequence.ts';

/* Every place a list of statements is a SCOPE: hoist its function declarations, then run it.
 *
 * A module is always strict, so a function declared in a block belongs to that block and is
 * initialized when the block is entered -- not when the enclosing function was (plan.md §8
 * step 12(e)). Routing every block, branch, loop body and clause list through here is what makes
 * `{ f(); function f() {} }` resolve instead of calling `undefined`, and re-running it per
 * iteration is what gives a loop body's declaration the iteration's own captures. */

export function emitScope(self: Emitter, statements: readonly Statement[]): void {
  cgClosure.emitHoistedFunctions(self, statements);
  for (const stmt of statements) {
    emitStatement(self, stmt);
  }
}

export function emitStatement(self: Emitter, stmt: Statement): void {
  switch (stmt.kind) {
    case 'declaration': {
      if (stmt.value !== undefined) {
        const value = cgExpr.emitExpression(self, stmt.value);
        cgSeq.appendLine(self, `${cgSeq.slotRef(self, stmt.name)} = ${value};`, stmt.span);
      }
      break;
    }

    case 'assignment': {
      const value = cgExpr.emitExpression(self, stmt.value);
      cgSeq.appendLine(self, `${cgSeq.slotRef(self, stmt.target)} = ${value};`, stmt.span);
      break;
    }

    case 'expression-statement': {
      // The console call's own statement form: bare, without the `undefined` that value position
      // has to append. See the `console-log` case in emitExpression for why the two differ.
      if (stmt.expression.kind === 'console-log') {
        cgSeq.appendLine(self, `${cgRuntime.consoleCall(self, stmt.expression)};`, stmt.span);
        if (consoleMayThrow(stmt.expression)) {
          cgSeq.emitPendingCheck(self, stmt.span);
        }
        break;
      }
      // An extern call already ran as its own statements (the call, the frees, the checks);
      // what comes back is only the result slot, and a bare line for it would be the same
      // no-op clang warns about for calls below.
      if (stmt.expression.kind === 'extern-call') {
        cgExpr.emitExpression(self, stmt.expression);
        break;
      }
      const expr = cgExpr.emitExpression(self, stmt.expression);
      // A call already ran as its own statements; what came back is only the slot its result
      // sits in, and a bare `JSRT_LOCAL(3);` line would be a no-op -- one clang warns about.
      // An async unit spells its slots as environment reads, so both forms are matched.
      if (!/^(?:JSRT_(?:LOCAL|GLOBAL)\(\d+\)|_jsrt_env->slots\[\d+\])$/.test(expr)) {
        cgSeq.appendLine(self, `${expr};`, stmt.span);
      }
      break;
    }

    case 'if-statement': {
      const cond = cgExpr.emitExpression(self, stmt.condition);
      // ToBoolean, not the bool payload: `jsrt_as_bool` reads bit 0, which for a boxed double
      // is a mantissa bit. `if (1)` took the else branch until this was `jsrt_truthy`.
      cgSeq.appendLine(self, `if (jsrt_truthy(${cond})) {`, stmt.span);
      self.indent++;
      emitScope(self, stmt.consequent.statements);
      self.indent--;
      if (stmt.alternate) {
        cgSeq.appendLine(self, '} else {', stmt.span);
        self.indent++;
        emitScope(self, stmt.alternate.statements);
        self.indent--;
      }
      cgSeq.appendLine(self, '}', stmt.span);
      break;
    }

    case 'while-statement': {
      const id = enterLoop(self, stmt);
      emitIterEnvOpen(self, id, stmt.span);
      // The condition is captured, not emitted in place: it re-runs every iteration, so any
      // statements it needs (a call and its pending check) must land INSIDE the loop, and a
      // statement cannot sit inside `while (...)`. With none, the compact form survives.
      self.indent++;
      const cond = cgSeq.capture(self, () => cgExpr.emitExpression(self, stmt.condition));
      self.indent--;
      if (cond.lines.length === 0) {
        cgSeq.appendLine(self, `while (jsrt_truthy(${cond.value})) {`, stmt.span);
        self.indent++;
      } else {
        cgSeq.appendLine(self, 'while (1) {', stmt.span);
        self.indent++;
        self.lines.push(...cond.lines);
        self.usedLabels.add(`brk_${id}`);
        cgSeq.appendLine(self, `if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
      }
      emitIterEnvEnter(self, id, stmt.span);
      emitScope(self, stmt.body.statements);
      emitJumpTarget(self, `cont_${id}`, stmt.span);
      emitIterEnvCommit(self, id, stmt.span);
      self.indent--;
      cgSeq.appendLine(self, '}', stmt.span);
      emitJumpTarget(self, `brk_${id}`, stmt.span);
      emitIterEnvClose(self, id, stmt.span);
      self.enclosing.pop();
      break;
    }

    case 'do-while-statement': {
      const id = enterLoop(self, stmt);
      emitIterEnvOpen(self, id, stmt.span);
      cgSeq.appendLine(self, 'do {', stmt.span);
      self.indent++;
      emitIterEnvEnter(self, id, stmt.span);
      emitScope(self, stmt.body.statements);
      // `continue` in a do/while jumps to the TEST, not past it -- the loop still gets to decide
      // whether to run again. Placing the target at the end of the body is what achieves that.
      emitJumpTarget(self, `cont_${id}`, stmt.span);
      emitIterEnvCommit(self, id, stmt.span);
      const cond = cgSeq.capture(self, () => cgExpr.emitExpression(self, stmt.condition));
      if (cond.lines.length === 0) {
        self.indent--;
        cgSeq.appendLine(self, `} while (jsrt_truthy(${cond.value}));`, stmt.span);
      } else {
        // The condition needed statements of its own, and `} while (...)` cannot hold them:
        // the test moves into the body's tail, still after the continue target.
        self.lines.push(...cond.lines);
        self.usedLabels.add(`brk_${id}`);
        cgSeq.appendLine(self, `if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
        self.indent--;
        cgSeq.appendLine(self, '} while (1);', stmt.span);
      }
      emitJumpTarget(self, `brk_${id}`, stmt.span);
      emitIterEnvClose(self, id, stmt.span);
      self.enclosing.pop();
      break;
    }

    case 'for-statement': {
      if (stmt.init) {
        emitStatement(self, stmt.init);
      }
      const id = enterLoop(self, stmt);
      emitIterEnvOpen(self, id, stmt.span);
      // An absent condition is an infinite loop, not a false one. `while (1)` rather than
      // synthesising a `true` literal, so nothing downstream has to evaluate a fake node. A
      // present one is captured like while's: its statements must re-run every iteration.
      self.indent++;
      const condition = stmt.condition;
      const cond =
        condition === undefined
          ? undefined
          : cgSeq.capture(self, () => cgExpr.emitExpression(self, condition));
      self.indent--;
      if (cond === undefined || cond.lines.length === 0) {
        cgSeq.appendLine(
          self,
          `while (${cond === undefined ? '1' : `jsrt_truthy(${cond.value})`}) {`,
          stmt.span,
        );
        self.indent++;
      } else {
        cgSeq.appendLine(self, 'while (1) {', stmt.span);
        self.indent++;
        self.lines.push(...cond.lines);
        self.usedLabels.add(`brk_${id}`);
        cgSeq.appendLine(self, `if (!jsrt_truthy(${cond.value})) { goto brk_${id}; }`, stmt.span);
      }
      emitIterEnvEnter(self, id, stmt.span);
      emitScope(self, stmt.body.statements);
      // The continue target sits BEFORE the update, which is the one thing a `for` gets wrong if
      // it is lowered naively: `continue` skips the rest of the body but must still run `i++`,
      // or the loop never terminates.
      emitJumpTarget(self, `cont_${id}`, stmt.span);
      // Commit before the update so `i++` mutates the CONTROL env, not the clone the body
      // captured — otherwise `() => i` would see the post-increment value (1, 2, 3).
      emitIterEnvCommit(self, id, stmt.span);
      if (stmt.update) {
        emitStatement(self, stmt.update);
      }
      self.indent--;
      cgSeq.appendLine(self, '}', stmt.span);
      emitJumpTarget(self, `brk_${id}`, stmt.span);
      emitIterEnvClose(self, id, stmt.span);
      self.enclosing.pop();
      break;
    }

    case 'switch-statement': {
      emitSwitch(self, stmt);
      break;
    }

    case 'break-statement':
    case 'continue-statement': {
      const wantsLoop = stmt.kind === 'continue-statement';
      const target = [...self.enclosing]
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
      emitLoopJump(self, name, self.enclosing.indexOf(target), stmt.span);
      break;
    }

    case 'block': {
      if (stmt.label !== undefined) {
        const id = enterBreakable(self, stmt.label);
        emitScope(self, stmt.statements);
        emitJumpTarget(self, `brk_${id}`, stmt.span);
        self.enclosing.pop();
        break;
      }
      emitScope(self, stmt.statements);
      break;
    }

    case 'function-declaration':
      // Nothing here: the binding was emitted at the top of the unit (see emitHoistedFunctions)
      // and the body is a separate C function.
      break;

    case 'index-assignment': {
      const base = self.indexSlots.get(stmt);
      if (base === undefined) {
        throw new Error('index assignment was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      const index = cgSeq.slotAt(self, base + 1);
      const value = cgSeq.slotAt(self, base + 2);
      // Target, index, value -- the order the language evaluates them, spelled out so C cannot
      // choose another, and each landing in a rooted slot before the next one runs.
      cgSeq.appendLine(self, `${target} = ${cgExpr.emitExpression(self, stmt.target)};`, stmt.span);
      cgSeq.appendLine(self, `${index} = ${cgExpr.emitExpression(self, stmt.index)};`, stmt.span);
      cgSeq.appendLine(self, `${value} = ${cgExpr.emitExpression(self, stmt.value)};`, stmt.span);
      const set = indexSetCall(stmt.target.type, target, index, value);
      cgSeq.appendLine(self, `${set};`, stmt.span);
      // Both arms can throw: the dynamic set on a nullish receiver, the static one on a
      // statically-typed array that arrives as something else (STA2008's degrade-to-dynamic
      // read/write, plan.md §8 step 20).
      cgSeq.emitPendingCheck(self, stmt.span);
      break;
    }

    case 'for-of-statement': {
      const slot = self.forOfSlots.get(stmt);
      if (slot === undefined) {
        throw new Error('for-of has no iterable slot; countBindings missed a node');
      }
      const iterable = cgSeq.slotAt(self, slot);
      cgSeq.appendLine(
        self,
        `${iterable} = ${cgExpr.emitExpression(self, stmt.iterable)};`,
        stmt.span,
      );
      // A statically-typed array that arrives as anything else (`var` hoisting hands the loop
      // `undefined`) used to segfault in the header read below. Validate once up front (STA2009,
      // plan.md §8 step 20), so the sync walk and the boxed async/generator one below are both
      // safe. Only the array kind: every other static kind has its own walk and its own step.
      if (stmt.iterable.type.kind === 'array') {
        cgSeq.appendLine(self, `jsrt_require_array_iterable(${iterable});`, stmt.span);
        cgSeq.emitPendingCheck(self, stmt.span);
      }
      const id = enterLoop(self, stmt);
      emitIterEnvOpen(self, id, stmt.span);
      // One predicate for both halves of the decision: counting claims the cleanup
      // triple exactly when emission takes this arm (plan.md §8 step 34).
      const boxed = forOfIsBoxed(self, stmt);
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
          cgSeq.appendLine(
            self,
            `${iterable} = jsrt_iterator_new(${iterable}, ${String(box)});`,
            stmt.span,
          );
        }
      }
      if (boxed) {
        emitBoxedIteratorForOf(self, stmt, iterable, id);
        break;
      }
      if (stmt.iterable.type.kind === 'map' || stmt.iterable.type.kind === 'set') {
        emitMapSetForOf(self, stmt, iterable, id);
        break;
      }
      const cursor = `jsrt_iter_${id}`;
      if (stmt.iterable.type.kind === 'string') {
        // Strings are immutable, so bounding on length is safe. The cursor advances 1 or 2
        // units per step — one code point, matching String.prototype[@@iterator].
        cgSeq.appendLine(
          self,
          `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_string_length(${iterable}); ) {`,
          stmt.span,
        );
        self.indent++;
        cgSeq.appendLine(
          self,
          `${cgSeq.slotRef(self, stmt.binding)} = jsrt_string_iter_next(${iterable}, &${cursor});`,
          stmt.span,
        );
      } else {
        // The length is re-read every iteration, not hoisted: the array iterator compares the
        // cursor against the CURRENT length on each step, so a body that shortens the array must
        // stop early. Hoisting it would walk off the end of a shrunk array.
        cgSeq.appendLine(
          self,
          `for (uint32_t ${cursor} = 0; ${cursor} < jsrt_as_array(${iterable})->length; ${cursor}++) {`,
          stmt.span,
        );
        self.indent++;
        emitArrayForOfYield(self, stmt, iterable, cursor);
      }
      emitIterEnvEnter(self, id, stmt.span);
      emitScope(self, stmt.body.statements);
      emitJumpTarget(self, `cont_${id}`, stmt.span);
      emitIterEnvCommit(self, id, stmt.span);
      self.indent--;
      cgSeq.appendLine(self, '}', stmt.span);
      emitJumpTarget(self, `brk_${id}`, stmt.span);
      emitIterEnvClose(self, id, stmt.span);
      self.enclosing.pop();
      break;
    }

    case 'return-statement': {
      if (!self.inFunction) {
        throw new Error('return outside a function; verifier should have caught it');
      }
      const slot = cgSeq.slotAt(self, self.returnSlot);
      if (stmt.value === undefined) {
        if (self.tryFinallyStack.length === 0) {
          if (self.inAsync) {
            cgClosure.emitAsyncSettle(self, 'jsrt_async_return', 'JSRT_UNDEFINED', stmt.span);
            break;
          }
          if (self.inGenerator) {
            cgClosure.emitGeneratorSettle(self, 'JSRT_UNDEFINED', stmt.span);
            break;
          }
          cgSeq.appendLine(self, 'JSRT_FRAME_POP();', stmt.span);
          cgSeq.appendLine(self, 'return JSRT_UNDEFINED;', stmt.span);
          break;
        }
        // An enclosing finally must run first: park the value, route only the jump.
        cgSeq.appendLine(self, `${slot} = JSRT_UNDEFINED;`, stmt.span);
        emitReturnJump(self, stmt.span);
        break;
      }
      const value = cgExpr.emitExpression(self, stmt.value);
      if (self.tryFinallyStack.length !== 0) {
        cgSeq.appendLine(self, `${slot} = ${value};`, stmt.span);
        emitReturnJump(self, stmt.span);
        break;
      }
      // Evaluate into a rooted slot FIRST, pop SECOND, read THIRD. Popping before evaluating
      // would run the expression -- and any allocation in it -- with this frame's locals
      // invisible to the collector. An async return settles instead of returning, and settling
      // allocates, so it sits inside the same window.
      if (self.inAsync) {
        cgSeq.appendLine(self, `${slot} = ${value};`, stmt.span);
        cgClosure.emitAsyncSettle(self, 'jsrt_async_return', slot, stmt.span);
        break;
      }
      if (self.inGenerator) {
        cgSeq.appendLine(self, `${slot} = ${value};`, stmt.span);
        cgClosure.emitGeneratorSettle(self, slot, stmt.span);
        break;
      }
      cgSeq.appendLine(self, `return (${slot} = ${value}, JSRT_FRAME_POP(), ${slot});`, stmt.span);
      break;
    }

    case 'field-assignment': {
      emitFieldWrite(
        self,
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
      emitFieldWrite(
        self,
        stmt,
        (target, value) =>
          `jsrt_set_prop(${target}, ${cNameLiteral(stmt.field)}, ${value}, &${cgRuntime.icSite(self)})`,
        'dynamic field assignment was not registered during counting',
      );
      break;
    }

    case 'super-call': {
      // A base with nothing to run emits nothing -- and reserves nothing at counting time, by
      // the matching guard there -- so this check comes before the slot lookup, not after it.
      const ctor = cgClass.classAt(self, stmt.className).ctor;
      // A base with nothing to run emits nothing. It can take no arguments either -- the checker
      // rejects arguments to a constructor that does not exist -- so no side effect is skipped.
      if (ctor === undefined) {
        break;
      }
      const base = self.callSlots.get(stmt);
      if (base === undefined) {
        throw new Error('super call was not registered during counting');
      }
      const parts: string[] = [];
      cgSeq.sequencePart(
        self,
        parts,
        stmt.receiver,
        stmt.span,
        (v) => `${cgSeq.slotAt(self, base)} = ${v}`,
      );
      stmt.args.forEach((arg, index) => {
        cgSeq.sequencePart(
          self,
          parts,
          arg,
          stmt.span,
          (v) => `${cgSeq.slotAt(self, base + 1 + index)} = ${v}`,
        );
      });
      parts.push(
        `jsrt_call(${cgClosure.closureValue(self, ctor.fn)}, ${1 + stmt.args.length}, &${cgSeq.slotAt(self, base)})`,
      );
      cgSeq.flushParts(self, parts, stmt.span);
      cgSeq.emitPendingCheck(self, stmt.span);
      break;
    }

    // Nothing runs here. A class's descriptor and its member functions are file-scope, and the
    // name is not a binding -- so the declaration's whole effect happened at compile time.
    case 'class-declaration':
      // The class itself emits nothing -- its descriptor is file-scope and its members are
      // function units. Its statics DO emit, here, which is what puts their initializers in
      // source order: a static is live from the class declaration onward, not before.
      for (const decl of stmt.statics) {
        emitStatement(self, decl);
      }
      break;

    case 'throw-statement': {
      const value = cgExpr.emitExpression(self, stmt.value);
      // Overwrite-on-throw is the pending cell's contract (runtime/src/jsrt_throw.c): a throw
      // inside a finally REPLACES whatever completion was pending, which is the language rule.
      cgSeq.appendLine(self, `jsrt_throw(${value});`, stmt.span);
      cgSeq.appendLine(self, `goto ${cgSeq.currentPad(self)};`, stmt.span);
      break;
    }

    case 'try-statement': {
      emitTry(self, stmt);
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
export function emitMapSetForOf(
  self: Emitter,
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
  cgSeq.appendLine(self, `jsrt_value ${coll} = ${iterable};`, span);
  cgSeq.appendLine(self, `jsrt_map_iter_begin(${coll});`, span);

  const tryId = self.tryCount++;
  const comp = `_jsrt_mapcomp_${tryId}`;
  const fin = `_jsrt_mapfin_${tryId}`;
  const finThr = `_jsrt_mapfinthr_${tryId}`;
  cgSeq.appendLine(self, '{', span);
  self.indent++;
  cgSeq.appendLine(self, `int ${comp} = 0;`, span);
  const scope: TryFinallyScope = {
    compVar: comp,
    compBoxed: false,
    finLabel: fin,
    enclosingDepth: self.enclosing.length - 1,
    routes: new Map(),
  };
  self.tryFinallyStack.push(scope);
  self.padStack.push(finThr);

  cgSeq.appendLine(self, `jsrt_value ${key};`, span);
  cgSeq.appendLine(self, `jsrt_value ${val};`, span);
  cgSeq.appendLine(
    self,
    `for (uint32_t ${cursor} = 0; jsrt_map_iter_step(${coll}, &${cursor}, &${key}, &${val}); ) {`,
    span,
  );
  self.indent++;
  emitMapSetForOfYield(self, stmt, key, val);
  emitIterEnvEnter(self, id, span);
  emitScope(self, stmt.body.statements);
  emitJumpTarget(self, `cont_${id}`, span);
  emitIterEnvCommit(self, id, span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);

  self.padStack.pop();
  self.usedLabels.add(fin);
  cgSeq.appendLine(self, `goto ${fin};`, span);
  if (self.usedLabels.has(finThr)) {
    cgSeq.appendLine(self, `${finThr}: ;`, span);
    cgSeq.appendLine(self, `jsrt_map_iter_end(${coll});`, span);
    cgSeq.appendLine(self, `goto ${cgSeq.currentPad(self)};`, span);
  }
  emitJumpTarget(self, `brk_${id}`, span);
  self.tryFinallyStack.pop();
  cgSeq.appendLine(self, `${fin}: ;`, span);
  cgSeq.appendLine(self, `jsrt_map_iter_end(${coll});`, span);
  for (const route of scope.routes.values()) {
    cgSeq.appendLine(self, `if (${comp} == ${route.code}) {`, span);
    self.indent++;
    route.action();
    self.indent--;
    cgSeq.appendLine(self, '}', span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  emitIterEnvClose(self, id, span);
  self.enclosing.pop();
}

export function emitArrayForOfYield(
  self: Emitter,
  stmt: ForOfStatement,
  iterable: string,
  cursor: string,
): void {
  const bind = cgSeq.slotRef(self, stmt.binding);
  if (stmt.view === 'keys') {
    cgSeq.appendLine(self, `${bind} = jsrt_number((double)${cursor});`, stmt.span);
    return;
  }
  // A hole reads as undefined (an array of an Unknown element may be sparse; docs/VALUE.md §4.4).
  const element = `jsrt_unhole(jsrt_as_array(${iterable})->elements[${cursor}])`;
  if (stmt.view === 'entries') {
    const pair = `_jsrt_pair_${cursor}`;
    cgSeq.appendLine(
      self,
      `jsrt_value ${pair}[2] = { jsrt_number((double)${cursor}), ${element} };`,
      stmt.span,
    );
    cgSeq.appendLine(self, `${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
    return;
  }
  cgSeq.appendLine(self, `${bind} = ${element};`, stmt.span);
}

export function emitMapSetForOfYield(
  self: Emitter,
  stmt: ForOfStatement,
  key: string,
  val: string,
): void {
  const bind = cgSeq.slotRef(self, stmt.binding);
  const map = stmt.iterable.type.kind === 'map';
  if (stmt.view === 'keys' || (!map && stmt.view !== 'entries')) {
    cgSeq.appendLine(self, `${bind} = ${key};`, stmt.span);
    return;
  }
  if (stmt.view === 'values' && map) {
    cgSeq.appendLine(self, `${bind} = ${val};`, stmt.span);
    return;
  }
  const pair = `_jsrt_pair_${key}`;
  const second = map ? val : key;
  cgSeq.appendLine(self, `jsrt_value ${pair}[2] = { ${key}, ${second} };`, stmt.span);
  cgSeq.appendLine(self, `${bind} = jsrt_array_new(2, ${pair});`, stmt.span);
}

/* Whether this for-of drives a boxed iterator rather than an inlined walk: a generator
 * (or stored iterator) always does, and a collection walk does when the unit can suspend
 * across it. Counting and emission both ask this one predicate, so the cleanup triple is
 * claimed exactly when the boxed arm below takes it. */
export function forOfIsBoxed(self: Emitter, stmt: ForOfStatement): boolean {
  if (stmt.iterable.type.kind === 'iterator') {
    return true;
  }
  if (!self.inAsync && !self.inGenerator) {
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
  self: Emitter,
  stmt: ForOfStatement,
  iterable: string,
  id: number,
): void {
  const span = stmt.span;
  const closeBase = self.forOfCloseSlots.get(stmt);
  if (closeBase === undefined) {
    throw new Error('boxed for-of has no close slots; countBindings missed a node');
  }
  const iterCopy = cgSeq.slotAt(self, closeBase);
  const exc = cgSeq.slotAt(self, closeBase + 1);
  const comp = cgSeq.slotAt(self, closeBase + 2);
  const item = `_jsrt_item_${id}`;
  // The fin must not read the iterable slot itself: see the counting arm.
  cgSeq.appendLine(self, `${iterCopy} = ${iterable};`, span);

  const tryId = self.tryCount++;
  const fin = `_jsrt_forfin_${tryId}`;
  const finThr = `_jsrt_forfinthr_${tryId}`;
  cgSeq.appendLine(self, '{', span);
  self.indent++;
  cgSeq.appendLine(self, `${comp} = jsrt_number(0);`, span);
  const scope: TryFinallyScope = {
    compVar: comp,
    compBoxed: true,
    finLabel: fin,
    enclosingDepth: self.enclosing.length - 1,
    routes: new Map(),
  };
  self.tryFinallyStack.push(scope);
  self.padStack.push(finThr);

  cgSeq.appendLine(self, `jsrt_value ${item};`, span);
  cgSeq.appendLine(self, `for (;;) {`, span);
  self.indent++;
  cgSeq.appendLine(self, `if (!jsrt_iterator_step(${iterable}, &${item})) {`, span);
  self.indent++;
  // A generator's step can throw: false then means "stop AND unwind", not "exhausted".
  // The pad on top is the fin-throw below, so the close runs on this path too.
  cgSeq.appendLine(self, `if (jsrt_pending()) { goto ${cgSeq.currentPad(self)}; }`, span);
  cgSeq.appendLine(self, 'break;', span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  cgSeq.appendLine(self, `${cgSeq.slotRef(self, stmt.binding)} = ${item};`, span);
  emitIterEnvEnter(self, id, span);
  emitScope(self, stmt.body.statements);
  emitJumpTarget(self, `cont_${id}`, span);
  emitIterEnvCommit(self, id, span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);

  self.padStack.pop();
  self.usedLabels.add(fin);
  cgSeq.appendLine(self, `goto ${fin};`, span);
  if (self.usedLabels.has(finThr)) {
    cgSeq.appendLine(self, `${finThr}: ;`, span);
    cgSeq.appendLine(self, `${comp} = jsrt_number(1);`, span);
    // Take BEFORE the close runs, for the reason the header comment gives.
    cgSeq.appendLine(self, `${exc} = jsrt_take_exception();`, span);
    cgSeq.appendLine(self, `goto ${fin};`, span);
  }
  emitJumpTarget(self, `brk_${id}`, span);
  self.tryFinallyStack.pop();
  cgSeq.appendLine(self, `${fin}: ;`, span);
  cgSeq.appendLine(self, `jsrt_iterator_close(${iterCopy});`, span);
  cgSeq.appendLine(self, `if (jsrt_pending()) {`, span);
  self.indent++;
  cgSeq.appendLine(self, `if (jsrt_number_value(${comp}) == 1) {`, span);
  self.indent++;
  cgSeq.appendLine(self, `(void)jsrt_take_exception();`, span);
  cgSeq.appendLine(self, `jsrt_throw(${exc});`, span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  cgSeq.appendLine(self, `goto ${cgSeq.currentPad(self)};`, span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  cgSeq.appendLine(
    self,
    `if (jsrt_number_value(${comp}) == 1) { jsrt_throw(${exc}); goto ${cgSeq.currentPad(self)}; }`,
    span,
  );
  for (const route of scope.routes.values()) {
    cgSeq.appendLine(self, `if (jsrt_number_value(${comp}) == ${String(route.code)}) {`, span);
    self.indent++;
    route.action();
    self.indent--;
    cgSeq.appendLine(self, '}', span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}', span);
  emitIterEnvClose(self, id, span);
  self.enclosing.pop();
}

/** Opens a loop's jump scope. `stmt` is what ties the loop to the two suspension slots counted
 * for it (`iterEnvSlots`): the id is minted here, at emission time, and the slots had to exist
 * before it, so the statement is the only key both passes share. */
export function enterLoop(self: Emitter, stmt: { label?: string; perIterationEnv?: true }): number {
  const id = self.loopCount++;
  const iterEnv = stmt.perIterationEnv === true && self.envMap.size > 0;
  if (iterEnv) {
    const base = self.iterEnvSlots.get(stmt as unknown as Statement);
    if (base === undefined) {
      throw new Error('per-iteration loop was not counted; countBindings missed a node');
    }
    self.iterEnvBase.set(id, base);
  }
  self.enclosing.push({
    id,
    isLoop: true,
    ...(stmt.label !== undefined && { label: stmt.label }),
    ...(iterEnv && { iterEnv: true }),
  });
  return id;
}

/** Claims the two slots a per-iteration loop needs when it can be suspended across: nothing when
 * the loop has no environment to clone, so an ordinary `for` pays no slot. */
export function countIterEnvSlots(self: Emitter, stmt: Statement): void {
  if (!('perIterationEnv' in stmt) || !stmt.perIterationEnv) {
    return;
  }
  if (self.envMap.size === 0) {
    return;
  }
  self.iterEnvSlots.set(stmt, self.slotCount);
  self.slotCount += 2;
}

export function enterBreakable(self: Emitter, label: string): number {
  const id = self.loopCount++;
  self.enclosing.push({ id, isLoop: false, label });
  return id;
}

export function iterEnvOf(self: Emitter, id: number): boolean {
  return self.enclosing.some((e) => e.id === id && e.iterEnv === true);
}

/* Re-roots the live frame at a new environment. Which frame that IS depends on scope: inside a
 * function it is the `JSRT_FRAME(n)` the unit opened, and at module top level it is the globals
 * frame, which is the only one a sync `main` has. Both spellings assign the same field. */
export function frameEnvLine(self: Emitter, env: string): string {
  return self.inFunction ? `JSRT_FRAME_ENV(${env});` : `JSRT_GLOBALS_ENV(${env});`;
}

/** The two slots a per-iteration loop keeps its environment state in, as lvalues. */
export function iterEnvState(self: Emitter, id: number): { saved: string; iter: string } {
  const base = self.iterEnvBase.get(id);
  if (base === undefined) {
    throw new Error('per-iteration loop has no suspension slots; countBindings missed a node');
  }
  return { saved: cgSeq.slotAt(self, base), iter: cgSeq.slotAt(self, base + 1) };
}

/* Opening, entering, committing and closing a loop that clones its environment per iteration.
 *
 * The state lives in two SLOTS rather than two C locals -- see `iterEnvSlots` for why, and note
 * what that buys: the same four emitters serve a sync unit (frame slots) and an async or
 * generator unit (environment slots, which survive a suspension), so a loop body can `await`
 * without a second code path. The slots hold raw `JSRTEnv *` bit-cast into `jsrt_value`; nothing
 * reads them as values, and the collector's mark procedure traces the pointer. */
export function emitIterEnvOpen(self: Emitter, id: number, span: Span): void {
  if (!iterEnvOf(self, id)) {
    return;
  }
  const { saved, iter } = iterEnvState(self, id);
  cgSeq.appendLine(self, `${saved} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
  cgSeq.appendLine(self, `${iter} = (jsrt_value)0;`, span);
}

export function emitIterEnvEnter(self: Emitter, id: number, span: Span): void {
  if (!iterEnvOf(self, id)) {
    return;
  }
  const { saved, iter } = iterEnvState(self, id);
  cgSeq.appendLine(self, `if (${saved} != (jsrt_value)0) {`, span);
  self.indent++;
  cgSeq.appendLine(self, `_jsrt_env = jsrt_env_clone((JSRTEnv *)(uintptr_t)${saved});`, span);
  cgSeq.appendLine(self, `${iter} = (jsrt_value)(uintptr_t)_jsrt_env;`, span);
  cgSeq.appendLine(self, frameEnvLine(self, '_jsrt_env'), span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
}

export function emitIterEnvCommit(self: Emitter, id: number, span: Span): void {
  if (!iterEnvOf(self, id)) {
    return;
  }
  const { saved, iter } = iterEnvState(self, id);
  cgSeq.appendLine(self, `if (${iter} != (jsrt_value)0) {`, span);
  self.indent++;
  cgSeq.appendLine(
    self,
    `jsrt_env_copy_slots((JSRTEnv *)(uintptr_t)${saved}, (JSRTEnv *)(uintptr_t)${iter});`,
    span,
  );
  cgSeq.appendLine(self, `_jsrt_env = (JSRTEnv *)(uintptr_t)${saved};`, span);
  cgSeq.appendLine(self, frameEnvLine(self, '_jsrt_env'), span);
  self.indent--;
  cgSeq.appendLine(self, '}', span);
}

export function emitIterEnvClose(_self: Emitter, _id: number, _span: Span): void {
  // Nothing to close: the state is slots, not a C block's locals. The method stays because its
  // call sites sit beside `emitJumpTarget('brk_…')` and read as the pair they are.
}

export function commitIterEnvs(self: Emitter, fromIndexInclusive: number, span: Span): void {
  for (let i = self.enclosing.length - 1; i >= fromIndexInclusive; i--) {
    const e = self.enclosing[i];
    if (e !== undefined && e.iterEnv === true) {
      emitIterEnvCommit(self, e.id, span);
    }
  }
}

/* A `label: ;` line, written only if something jumps to it. The trailing `;` is not cosmetic:
 * before C23 a label must be followed by a statement, and a label at the end of a block is not. */
export function emitJumpTarget(self: Emitter, name: string, span: Span): void {
  if (self.usedLabels.has(name)) {
    cgSeq.appendLine(self, `${name}: ;`, span);
  }
}

/* The check after every operation that can throw. Throwing operations are emitted as their own
 * STATEMENTS -- never inside a consumer's expression -- precisely so this line can sit between
 * the operation and whatever consumes its result: a callee that threw left `undefined` behind,
 * and nothing may observe it. */
export function emitFieldWrite(
  self: Emitter,
  stmt: FieldAssignment | DynFieldAssignment,
  write: (target: string, value: string) => string,
  missing: string,
): void {
  const base = self.indexSlots.get(stmt);
  if (base === undefined) {
    throw new Error(missing);
  }
  const target = cgSeq.slotAt(self, base);
  const value = cgSeq.slotAt(self, base + 1);
  const parts: string[] = [];
  cgSeq.sequencePart(self, parts, stmt.target, stmt.span, (v) => `${target} = ${v}`);
  cgSeq.sequencePart(self, parts, stmt.value, stmt.span, (v) => `${value} = ${v}`);
  parts.push(write(target, value));
  cgSeq.flushParts(self, parts, stmt.span);
  cgSeq.emitPendingCheck(self, stmt.span);
}

/* `goto` to a loop/switch label, routed through any finally standing between here and the
 * target. The innermost try decides: if the target construct opened BEFORE the try did, the
 * jump leaves the protected code and the finally must run first. The dispatch re-invokes this
 * with that scope popped, which chains the jump through the next finally outward in turn. */
export function emitLoopJump(self: Emitter, name: string, targetIndex: number, span: Span): void {
  const scope = self.tryFinallyStack.at(-1);
  if (scope !== undefined && scope.enclosingDepth > targetIndex) {
    routeJump(self, scope, name, span, () => emitLoopJump(self, name, targetIndex, span));
    return;
  }
  const continuing = name.startsWith('cont_');
  commitIterEnvs(self, continuing ? targetIndex + 1 : targetIndex, span);
  self.usedLabels.add(name);
  cgSeq.appendLine(self, `goto ${name};`, span);
}

/* A `return` whose enclosing finally bodies must run first. The value already sits in the
 * (rooted) return slot; only the JUMP routes, and the same chaining as emitLoopJump applies. */
export function emitReturnJump(self: Emitter, span: Span): void {
  const scope = self.tryFinallyStack.at(-1);
  if (scope === undefined) {
    commitIterEnvs(self, 0, span);
    const slot = cgSeq.slotAt(self, self.returnSlot);
    if (self.inAsync) {
      cgClosure.emitAsyncSettle(self, 'jsrt_async_return', slot, span);
      return;
    }
    if (self.inGenerator) {
      cgClosure.emitGeneratorSettle(self, slot, span);
      return;
    }
    cgSeq.appendLine(self, `return (JSRT_FRAME_POP(), ${slot});`, span);
    return;
  }
  routeJump(self, scope, 'return', span, () => emitReturnJump(self, span));
}

/* Records the jump in the completion variable and enters the finally. One code per DISTINCT
 * jump, allocated on first use: two `break`s to the same loop share a code and a dispatch arm,
 * a `break` and a `return` do not. Codes 0 (normal) and 1 (throw) are reserved. */
export function routeJump(
  self: Emitter,
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
  cgSeq.appendLine(
    self,
    scope.compBoxed
      ? `${scope.compVar} = jsrt_number(${String(route.code)});`
      : `${scope.compVar} = ${String(route.code)};`,
    span,
  );
  cgSeq.appendLine(self, `goto ${scope.finLabel};`, span);
}

/* Landing-pad lowering, the shape plan.md Task 3.10 and docs/VALUE.md §6 prescribe: no setjmp,
 * no unwinder -- a throwing call is followed by `if (jsrt_pending()) goto pad;`, and this emits
 * the pads those checks target. */
export function emitTry(self: Emitter, stmt: TryStatement): void {
  const id = self.tryCount++;
  if (stmt.finallyBlock === undefined) {
    emitTryCatch(self, stmt, id);
  } else {
    emitTryFinally(self, stmt, stmt.finallyBlock, id);
  }
}

export function emitTryCatch(self: Emitter, stmt: TryStatement, id: number): void {
  const catchPad = `_jsrt_cat_${id}`;
  self.padStack.push(catchPad);
  emitStatement(self, stmt.tryBlock);
  self.padStack.pop();
  if (!self.usedLabels.has(catchPad)) {
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
  self.usedLabels.add(end);
  cgSeq.appendLine(self, `goto ${end};`, stmt.span);
  cgSeq.appendLine(self, `${catchPad}: ;`, stmt.span);
  emitCatchEntry(self, stmt);
  if (stmt.catchBlock !== undefined) {
    emitStatement(self, stmt.catchBlock);
  }
  cgSeq.appendLine(self, `${end}: ;`, stmt.span);
}

/* The completion-code protocol: 0 falls through the dispatch (normal completion), 1 rethrows
 * the stashed exception, 2+ re-perform a recorded jump. The dispatch sits AFTER the finally
 * body, so a finally that itself throws or jumps never reaches it -- which is the language
 * rule: the finally's own completion replaces the one on the way through. */
export function emitTryFinally(
  self: Emitter,
  stmt: TryStatement,
  finallyBlock: Block,
  id: number,
): void {
  const finThr = `_jsrt_finthr_${id}`;
  const fin = `_jsrt_fin_${id}`;
  const excIndex = self.trySlots.get(stmt);
  if (excIndex === undefined) {
    throw new Error('try/finally has no exception slot; countBindings missed a node');
  }
  const exc = cgSeq.slotAt(self, excIndex);
  // The completion code is a counted slot, boxed as a number: a suspension between the route
  // and the dispatch pops the C frame, and only a slot survives that (countBindings claims the
  // pair -- exc, then comp -- so they sit adjacently).
  const comp = cgSeq.slotAt(self, excIndex + 1);
  cgSeq.appendLine(self, '{', stmt.span);
  self.indent++;
  cgSeq.appendLine(self, `${comp} = jsrt_number(0);`, stmt.span);
  const scope: TryFinallyScope = {
    compVar: comp,
    compBoxed: true,
    finLabel: fin,
    enclosingDepth: self.enclosing.length,
    routes: new Map(),
  };
  self.tryFinallyStack.push(scope);
  const catchPad = stmt.catchBlock === undefined ? finThr : `_jsrt_cat_${id}`;
  self.padStack.push(catchPad);
  emitStatement(self, stmt.tryBlock);
  self.padStack.pop();
  self.usedLabels.add(fin);
  cgSeq.appendLine(self, `goto ${fin};`, stmt.span);
  if (stmt.catchBlock !== undefined && self.usedLabels.has(catchPad)) {
    cgSeq.appendLine(self, `${catchPad}: ;`, stmt.span);
    emitCatchEntry(self, stmt);
    self.padStack.push(finThr);
    emitStatement(self, stmt.catchBlock);
    self.padStack.pop();
    cgSeq.appendLine(self, `goto ${fin};`, stmt.span);
  }
  // The scope pops HERE: a return/break/throw inside the finally body itself does not route
  // through this finally again -- it replaces the pending completion, which is exactly what
  // leaving comp undispatched does.
  self.tryFinallyStack.pop();
  if (self.usedLabels.has(finThr)) {
    cgSeq.appendLine(self, `${finThr}: ;`, stmt.span);
    cgSeq.appendLine(self, `${comp} = jsrt_number(1);`, stmt.span);
    // Take BEFORE the finally body runs: the body may itself throw, and its exception must
    // find the cell empty to overwrite, while this one waits in a rooted slot.
    cgSeq.appendLine(self, `${exc} = jsrt_take_exception();`, stmt.span);
  }
  cgSeq.appendLine(self, `${fin}: ;`, stmt.span);
  emitStatement(self, finallyBlock);
  if (self.usedLabels.has(finThr)) {
    cgSeq.appendLine(
      self,
      `if (jsrt_number_value(${comp}) == 1) { jsrt_throw(${exc}); goto ${cgSeq.currentPad(self)}; }`,
      stmt.span,
    );
  }
  for (const route of scope.routes.values()) {
    cgSeq.appendLine(self, `if (jsrt_number_value(${comp}) == ${String(route.code)}) {`, stmt.span);
    self.indent++;
    route.action();
    self.indent--;
    cgSeq.appendLine(self, '}', stmt.span);
  }
  self.indent--;
  cgSeq.appendLine(self, '}', stmt.span);
}

/* Taking the exception is what re-arms the cell for the next throw; a binding-less catch still
 * takes, it just has nowhere to put the value. */
export function emitCatchEntry(self: Emitter, stmt: TryStatement): void {
  if (stmt.catchBinding !== undefined) {
    cgSeq.appendLine(
      self,
      `${cgSeq.slotRef(self, stmt.catchBinding)} = jsrt_take_exception();`,
      stmt.span,
    );
  } else {
    cgSeq.appendLine(self, '(void)jsrt_take_exception();', stmt.span);
  }
}

/* A JavaScript switch is not a C switch and cannot be emitted as one. C requires integer
 * constant cases; JS compares with STRICT EQUALITY against arbitrary expressions, so
 * `case 'x'` and `case n + 1` are both legal. JS also tries `default` LAST no matter where it
 * appears, while still falling through from whatever clause precedes it textually.
 *
 * All three fall out of one shape: run every case test in source order, jump to the matching
 * clause, and lay the clause bodies out in source order so fall-through is simply not jumping. */
export function emitSwitch(self: Emitter, stmt: SwitchStatement): void {
  const id = self.loopCount++;
  // A switch is breakable but not continuable: `continue` inside one belongs to the enclosing
  // loop, which is why this pushes isLoop: false rather than reusing enterLoop.
  self.enclosing.push({
    id,
    isLoop: false,
    ...(stmt.label !== undefined && { label: stmt.label }),
  });

  const slot = self.switchSlots.get(stmt);
  if (slot === undefined) {
    throw new Error('switch has no discriminant slot; countBindings missed a node');
  }
  const disc = cgSeq.slotAt(self, slot);
  cgSeq.appendLine(self, `${disc} = ${cgExpr.emitExpression(self, stmt.discriminant)};`, stmt.span);

  // The clause list is ONE block scope, not one per clause (docs on SwitchClause say so), so the
  // function declarations of every clause hoist together and ahead of the dispatch. Hoisting
  // per clause instead would leave a declaration uninitialized whenever the jump lands past it.
  for (const clause of stmt.clauses) {
    cgClosure.emitHoistedFunctions(self, clause.statements);
  }

  let defaultIndex: number | undefined;
  stmt.clauses.forEach((clause, i) => {
    if (clause.test === undefined) {
      defaultIndex = i;
      return;
    }
    const test = cgExpr.emitExpression(self, clause.test);
    cgSeq.appendLine(
      self,
      `if (jsrt_strict_equals(${disc}, ${test})) goto case_${id}_${i};`,
      stmt.span,
    );
  });

  // Every test failed. `default` is the fallback wherever it was written; with no default at
  // all, the whole statement is skipped.
  if (defaultIndex === undefined) {
    self.usedLabels.add(`brk_${id}`);
    cgSeq.appendLine(self, `goto brk_${id};`, stmt.span);
  } else {
    cgSeq.appendLine(self, `goto case_${id}_${defaultIndex};`, stmt.span);
  }

  stmt.clauses.forEach((clause, i) => {
    // Unconditional: every clause label is the target of either its own test or the default
    // jump above, so none of them can be unused.
    cgSeq.appendLine(self, `case_${id}_${i}: ;`, stmt.span);
    self.indent++;
    for (const s of clause.statements) {
      emitStatement(self, s);
    }
    self.indent--;
  });

  emitJumpTarget(self, `brk_${id}`, stmt.span);
  self.enclosing.pop();
}
