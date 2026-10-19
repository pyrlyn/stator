/* Shared sequencing: slots, frames, pending checks, and argument order.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import {
  isAccessorEntry,
  isComputedEntry,
  type Expression,
  type Span,
  type Statement,
} from '../hir/nodes.ts';
import {
  escapeCString as escapeCStringLiteral,
  argsConvert,
  compoundConverts,
  dynLiteralBaseSlots,
  spreadScratchKey,
  spreadScratches,
  spreadSnapshots,
  unaryConverts,
  type CallSlotted,
} from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgClass from './classes.ts';
import * as cgClosure from './closures.ts';
import * as cgExpr from './expr.ts';
import * as cgRuntime from './runtime-calls.ts';
import * as cgStmt from './stmt.ts';

/* Storage for one named binding, at most once. A binding this function CAPTURES already has a
 * home -- its heap environment -- and `slotRef` reads that one, so a frame slot of the same name
 * would be a slot the frame roots and nothing ever reads. One variable, one home; the frame-vs-
 * locals audit in tests/unit/frames.test.ts is what holds this to exactly that. */

export function bindSlot(self: Emitter, name: string): void {
  if (self.envMap.has(name) || self.slotMap.has(name)) {
    return;
  }
  // A top-level name already lives in the globals array; the async module body must not grow a
  // second home for it in the heap environment (temps still bind, they have no global name).
  if (self.moduleAsync && self.globalMap.has(name)) {
    return;
  }
  self.slotMap.set(name, self.slotCount);
  self.slotCount++;
}

/* Assigns every frame slot before a single line of body is emitted, because JSRT_FRAME(n) is
 * written once at the top and n has to be final by then. Named bindings and short-circuit
 * temporaries share one counter and one frame: both hold jsrt_values the GC must see. */
export function countBindings(self: Emitter, statements: readonly Statement[]): void {
  for (const stmt of statements) {
    switch (stmt.kind) {
      case 'declaration':
        bindSlot(self, stmt.name);
        if (stmt.value !== undefined && stmt.value.kind === 'function') {
          // The FUNCTION's display name, falling back to the binding's. They differ for exactly
          // one thing: a shadow-renamed binding (`\0shadow:f#4`) whose declarator spelled `f` --
          // the emitter prints the display name, never the slot name (plan.md §8 step 17). Node
          // names a function after the binding it is assigned to: `const mul = () => {}` prints
          // as `[Function: mul]`, not `[Function (anonymous)]`.
          cgClosure.registerFunction(self, stmt.value, stmt.value.name ?? stmt.name);
        } else if (stmt.value !== undefined) {
          countExpression(self, stmt.value);
        }
        break;
      case 'assignment':
        countExpression(self, stmt.value);
        break;
      case 'expression-statement':
        countExpression(self, stmt.expression);
        break;
      case 'block':
        countBindings(self, stmt.statements);
        break;
      case 'if-statement':
        countExpression(self, stmt.condition);
        countBindings(self, stmt.consequent.statements);
        if (stmt.alternate) {
          countBindings(self, stmt.alternate.statements);
        }
        break;
      case 'while-statement':
      case 'do-while-statement':
        cgStmt.countIterEnvSlots(self, stmt);
        countExpression(self, stmt.condition);
        countBindings(self, stmt.body.statements);
        break;
      case 'for-statement':
        cgStmt.countIterEnvSlots(self, stmt);
        if (stmt.init) {
          countBindings(self, [stmt.init]);
        }
        if (stmt.condition) {
          countExpression(self, stmt.condition);
        }
        if (stmt.update) {
          countBindings(self, [stmt.update]);
        }
        countBindings(self, stmt.body.statements);
        break;
      case 'switch-statement': {
        // The discriminant needs a slot of its own: it is evaluated ONCE and then compared
        // against every clause, so it has to survive as a rooted value across those tests.
        self.switchSlots.set(stmt, self.slotCount);
        self.slotCount++;
        countExpression(self, stmt.discriminant);
        for (const clause of stmt.clauses) {
          if (clause.test) {
            countExpression(self, clause.test);
          }
          countBindings(self, clause.statements);
        }
        break;
      }
      case 'function-declaration':
        bindSlot(self, stmt.name);
        // The FUNCTION's own name, falling back to the declaration's. They differ for exactly one
        // thing: a monomorphized specialization is bound as `box<number>` but is still the `box`
        // the user wrote, and `[Function: box]` is what Node prints for it.
        cgClosure.registerFunction(self, stmt.fn, stmt.fn.name ?? stmt.name);
        break;
      case 'return-statement':
        if (stmt.value) {
          self.returnsValue = true;
          countExpression(self, stmt.value);
        }
        break;
      case 'index-assignment':
        self.indexSlots.set(stmt, self.slotCount);
        self.slotCount += 3;
        countExpression(self, stmt.target);
        countExpression(self, stmt.index);
        countExpression(self, stmt.value);
        break;
      case 'for-of-statement':
        cgStmt.countIterEnvSlots(self, stmt);
        self.forOfSlots.set(stmt, self.slotCount);
        self.slotCount++;
        // A boxed walk closes its iterator on abrupt exit (plan.md §8 step 34): the fin
        // reads the iterator, the stashed exception and the completion code from slots
        // the body cannot overwrite. A bare `return` parks `undefined` in slot 0, which
        // is this loop's iterable slot when the function returns no value, so the fin
        // must not read the iterable slot itself.
        if (cgStmt.forOfIsBoxed(self, stmt)) {
          self.forOfCloseSlots.set(stmt, self.slotCount);
          self.slotCount += 3;
        }
        countExpression(self, stmt.iterable);
        bindSlot(self, stmt.binding);
        countBindings(self, stmt.body.statements);
        break;
      case 'field-assignment':
      // The dynamic variant needs the same two slots for a stronger reason: jsrt_set_prop can
      // GROW the object's slot storage, which allocates, so both operands must be rooted
      // across the call itself, not only across each other's evaluation.
      case 'dyn-field-assignment':
        // Target and value each get a rooted slot: C does not fix the order in which it
        // evaluates the arguments to jsrt_object_set, and the target has to stay reachable
        // while the value -- which may allocate -- is computed.
        self.indexSlots.set(stmt, self.slotCount);
        self.slotCount += 2;
        countExpression(self, stmt.target);
        countExpression(self, stmt.value);
        break;
      case 'super-call':
        // A base with no constructor to run emits nothing (the matching skip in the
        // class-declaration emission): reserving argv slots for a call that never happens roots
        // slots nothing writes. The lookup is partial on purpose -- a base the collection has
        // not seen yet keeps the reservation, which is today's behavior, never less.
        if (self.classes.find((c) => c.name === stmt.className)?.ctor !== undefined) {
          // The same contiguous, rooted argv every call uses: receiver in slot zero, then the
          // base constructor's arguments. It is a CALL, so every operand must be reachable across
          // the allocations the later ones may perform.
          self.callSlots.set(stmt, self.slotCount);
          self.slotCount += 1 + stmt.args.length;
          countExpression(self, stmt.receiver);
          for (const arg of stmt.args) {
            countExpression(self, arg);
          }
        }
        break;
      case 'class-declaration':
        // A class occupies no frame slot: it is not a value in this subset. What counting does
        // here is claim the descriptor's identity and register the member functions, which are
        // emitted as ordinary units with the receiver as parameter zero.
        if (!self.classIds.has(stmt.name)) {
          self.classIds.set(stmt.name, self.classes.length);
          self.classes.push(stmt);
        }
        if (stmt.ctor !== undefined) {
          cgClosure.registerFunction(self, stmt.ctor.fn, stmt.name);
        }
        for (const method of stmt.methods) {
          cgClosure.registerFunction(self, method.fn, method.name);
        }
        // A static is a binding in the ENCLOSING scope, so it takes a slot there exactly as a
        // `let` would -- which is what makes `C.count` an ordinary slot read downstream.
        countBindings(self, stmt.statics);
        break;
      case 'break-statement':
      case 'continue-statement':
        break;
      case 'throw-statement':
        countExpression(self, stmt.value);
        break;
      case 'try-statement':
        // A try with a finally claims TWO slots of its own: where the dispatch stashes a
        // caught exception while the finally body (which may allocate) runs, and the
        // completion code as a boxed number. Both must outlive a suspension: a yield/await
        // inside the try or the finally pops the C frame, and the resume's goto jumps over
        // whatever initializer a local would have had (plan-notes 153).
        if (stmt.catchBinding !== undefined) {
          bindSlot(self, stmt.catchBinding);
        }
        if (stmt.finallyBlock !== undefined) {
          self.trySlots.set(stmt, self.slotCount);
          self.slotCount += 2;
        }
        countBindings(self, stmt.tryBlock.statements);
        if (stmt.catchBlock !== undefined) {
          countBindings(self, stmt.catchBlock.statements);
        }
        if (stmt.finallyBlock !== undefined) {
          countBindings(self, stmt.finallyBlock.statements);
        }
        break;
      default: {
        const _exhaustive: never = stmt;
        throw new Error(
          `Unknown statement kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
        );
      }
    }
  }
}

/* One object-literal entry value for the counting pass. A spread's reads share one source
 * subtree, which emission evaluates once into a scratch slot: the first read counts it and
 * the rest count nothing, or every extra field reserves slots (a whole call frame, for a
 * call source) that emission never writes. `spreadKeys`/`countedSpread` are the literal's
 * own group state, built from the same `spreadScratches` the slot reservation used. Spread
 * method copies read through the same scratch, so they count the same way. */
/** The rooted slot holding a spread fragment's source, evaluating it once on first use.
 *
 * The field reads and the method copies of one fragment share one source subtree; the first
 * read evaluates it into the scratch slot the counting pass reserved, and every later read
 * loads out of that. `flushed` threads through because the evaluation may need statements,
 * exactly as the caller's own `sequencePart` accounting does. A null slot means the fragment
 * keeps no scratch -- an identifier source stays inline -- so the caller reads the binding
 * itself. */
export function spreadSource(
  self: Emitter,
  parts: string[],
  key: string,
  scratchAt: ReadonlyMap<string, number>,
  scratchTarget: ReadonlyMap<string, Expression>,
  scratchDone: Set<string>,
  span: Span,
  flushed: boolean,
): { readonly slot: string | null; readonly flushed: boolean } {
  const scratch = scratchAt.get(key);
  const source = scratchTarget.get(key);
  if (scratch === undefined || source === undefined) {
    return { slot: null, flushed };
  }
  let next = flushed;
  if (!scratchDone.has(key)) {
    scratchDone.add(key);
    next =
      sequencePart(self, parts, source, span, (v) => `${slotAt(self, scratch)} = ${v}`) || next;
  }
  return { slot: slotAt(self, scratch), flushed: next };
}

export function countEntryValue(
  self: Emitter,
  value: Expression,
  spreadKeys: ReadonlySet<string>,
  countedSpread: Set<string>,
): void {
  if (
    (value.kind === 'field-access' || value.kind === 'method-value') &&
    value.target.kind !== 'identifier'
  ) {
    const key = spreadScratchKey(value.span);
    if (spreadKeys.has(key)) {
      if (!countedSpread.has(key)) {
        countedSpread.add(key);
        countExpression(self, value);
      }
      return;
    }
  }
  countExpression(self, value);
}

/** One contiguous run of rooted slots for `expr`: the leading operand (a callee or receiver)
 * when there is one, then each argument -- so every operand already evaluated stays rooted
 * while the rest run, and source order is pinned against C's unspecified argument order. */
export function countRooted(
  self: Emitter,
  expr: CallSlotted,
  lead: Expression | undefined,
  args: readonly Expression[],
): void {
  self.callSlots.set(expr, self.slotCount);
  self.slotCount += (lead === undefined ? 0 : 1) + args.length;
  if (lead !== undefined) {
    countExpression(self, lead);
  }
  for (const arg of args) {
    countExpression(self, arg);
  }
}

export function countExpression(self: Emitter, expr: Expression): void {
  switch (expr.kind) {
    case 'logical-op':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount++;
      countExpression(self, expr.left);
      countExpression(self, expr.right);
      break;
    case 'binary-op':
      self.binarySlots.set(expr, self.slotCount);
      self.slotCount += 2;
      countExpression(self, expr.left);
      countExpression(self, expr.right);
      break;
    // A numeric unary operator on what may be an object runs its `valueOf` (plan.md §9 Task
    // 6.27): the converted operand lands in a rooted slot so the check can follow it.
    case 'unary-op':
      if (unaryConverts(expr)) {
        self.tempSlots.set(expr, self.slotCount++);
      }
      countExpression(self, expr.operand);
      break;
    case 'typeof':
    case 'string-length':
    case 'function-length':
      countExpression(self, expr.operand);
      break;
    // One rooted slot for the answer: the length read can throw (a statically-typed array
    // that arrives as something else degrades to the dynamic read, plan.md §8 step 20), so
    // the call lands as a statement with a pending check after it, never nested inline.
    case 'array-length':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount++;
      countExpression(self, expr.operand);
      break;
    case 'conditional':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount++;
      countExpression(self, expr.condition);
      countExpression(self, expr.consequent);
      countExpression(self, expr.alternate);
      break;
    // One rooted slot for the guarded base: the consequent reads it through the leaf, so it
    // must outlive the consequent's own allocations exactly like a condition's operands do.
    case 'optional-chain':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount++;
      countExpression(self, expr.base);
      countExpression(self, expr.consequent);
      break;
    // A leaf: no allocation, no slot — it resolves to the enclosing chain's temp at emission.
    case 'optional-base':
      break;
    case 'update':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount++;
      // The right operand of a numeric compound assignment waits in the slot after the result
      // while the left one's `valueOf` runs (see emitUpdate).
      if (compoundConverts(expr)) {
        self.slotCount++;
      }
      if (expr.target.kind === 'index-access') {
        self.indexSlots.set(expr, self.slotCount);
        self.slotCount += 2;
        countExpression(self, expr.target.target);
        countExpression(self, expr.target.index);
      } else if (expr.target.kind === 'field-access' || expr.target.kind === 'dyn-field-access') {
        self.indexSlots.set(expr, self.slotCount);
        self.slotCount++;
        countExpression(self, expr.target.target);
      }
      if (expr.value !== undefined) {
        countExpression(self, expr.value);
      }
      break;
    // A check allocates nothing on the passing path and does not return on the failing one, so
    // the value it guards needs no slot beyond whatever building it already claimed.
    case 'boundary-check':
      countExpression(self, expr.value);
      break;
    case 'array-literal':
      self.arraySlots.set(expr, self.slotCount);
      self.slotCount += expr.elements.length;
      for (const element of expr.elements) {
        countExpression(self, element);
      }
      break;
    case 'index-access':
      self.indexSlots.set(expr, self.slotCount);
      self.slotCount += 2;
      countExpression(self, expr.target);
      countExpression(self, expr.index);
      break;
    // Two rooted slots for the same reason an index access takes two: `jsrt_delete` allocates
    // (it replays the receiver's shape chain) and can throw, so both operands must be visible to
    // the collector across the call rather than live in C temporaries.
    case 'delete-prop':
      self.indexSlots.set(expr, self.slotCount);
      self.slotCount += 2;
      countExpression(self, expr.target);
      countExpression(self, expr.key);
      break;
    case 'template-literal':
      {
        const count = expr.expressions.length + expr.quasis.filter((quasi) => quasi !== '').length;
        // TemplateExpression always has a substitution, so count cannot be zero; keep the
        // guard to make a hand-built invalid HIR fail in the emitter rather than emit slot -1.
        if (count === 0) {
          throw new Error('template literal has no parts; verifier should have caught it');
        }
        self.templateSlots.set(expr, { base: self.slotCount, count });
        self.slotCount += count;
      }
      for (const part of expr.expressions) {
        countExpression(self, part);
      }
      break;
    case 'console-log':
      // TWO OR MORE arguments get one contiguous rooted slot each, for the same reason a call
      // takes them: C's argument order is unspecified, so each has to be evaluated -- in source
      // order -- into a slot that outlives the next one's evaluation. Fewer than two take no
      // slot: there is no order to fix, nothing can run between the evaluation and the call, and
      // claiming one anyway was a frame slot nothing wrote.
      if (expr.args.length >= 2) {
        self.callSlots.set(expr, self.slotCount);
        self.slotCount += expr.args.length;
      }
      for (const arg of expr.args) {
        countExpression(self, arg);
      }
      break;
    case 'function':
      // Registered, not descended into: the body's slots belong to its own frame and are counted
      // when its unit is emitted.
      cgClosure.registerFunction(self, expr, expr.name ?? '');
      break;
    case 'call':
      // 1 + argc CONTIGUOUS slots -- the callee, then each argument -- so `argv` can point at the
      // first argument slot and every operand already evaluated stays rooted while the rest run.
      countRooted(self, expr, expr.callee, expr.args);
      break;
    // An extern call takes the call layout minus the callee: there is no function value, only
    // a C symbol, so the arguments start where a plain call keeps its callee and the result —
    // a fresh box the call allocates — sits ahead of them for every non-`void` return. A
    // `void` call takes no result slot: nothing is boxed, and the statement is the call.
    case 'extern-call': {
      const resultSlots = expr.retKind === 'void' ? 0 : 1;
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += resultSlots + expr.args.length;
      for (const arg of expr.args) {
        countExpression(self, arg);
      }
      cgRuntime.recordExternDecl(self, expr);
      break;
    }
    // `new` and a method call share the call layout: the RECEIVER occupies the slot a plain
    // call gives the callee, so `argv` still points at one contiguous run and the callee's
    // parameter zero is the object. For `new` that slot is also the result. A dynamic method
    // call is the same layout with one more slot: the loaded method lands between the
    // receiver and the arguments, so both call shapes below read contiguous runs.
    case 'new':
    case 'method-call':
    case 'dyn-method-call':
    case 'field-call':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount +=
        (expr.kind === 'method-call' || expr.kind === 'new' ? 1 : 2) + expr.args.length;
      if (expr.kind !== 'new') {
        countExpression(self, expr.target);
      }
      for (const arg of expr.args) {
        countExpression(self, arg);
      }
      break;
    // One rooted slot for the object itself, claimed BEFORE any entry is evaluated: an entry may
    // allocate, and the half-built object has to survive that. The shape's descriptor is
    // registered here for the same reason a class's is -- emission only ever looks one up.
    // After it, one scratch slot per spread with a non-trivial source (`spreadScratches`): the
    // scratch is written once at the spread's position and read inline by every field, so the
    // slots counted here and the ones emission writes agree exactly.
    case 'object-literal': {
      const scratches = spreadScratches(expr.entries, expr.methodCopies);
      // Snapshots for identifier-fragment sources (spreadSnapshots): the order repair runs
      // after every value, past any suspension, so a source a later entry reassigns would
      // read back wrong -- each one is retained at its own fragment's position instead.
      // Spread method copies need none: the emitter stores them at the fragment's own
      // position, so an inline identifier read is already the fragment-time value.
      const snaps = spreadSnapshots(expr.entries);
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 1 + scratches.length + snaps.length;
      cgClass.registerShape(self, expr);
      // A spread's reads share one source subtree, which emission evaluates once: count it
      // once too, or every extra field reserves a call frame nothing ever writes.
      const spreadKeys = new Set(scratches.map(({ key }) => key));
      const countedSpread = new Set<string>();
      for (const entry of expr.entries) {
        countEntryValue(self, entry.value, spreadKeys, countedSpread);
      }
      for (const copy of expr.methodCopies) {
        countEntryValue(self, copy.value, spreadKeys, countedSpread);
      }
      for (const method of expr.methods) {
        cgClosure.registerFunction(self, method.fn, method.name);
      }
      break;
    }
    // The object slot plus ONE value scratch slot, reused entry by entry: jsrt_set_prop may
    // grow the slot storage, which allocates, so the value being stored must be rooted across
    // the call -- unlike jsrt_object_set, which only writes. `{}` has no entry to store and
    // therefore no scratch: a slot the emitter never writes is one the frame roots for nothing.
    // After those, one slot per spread with a non-trivial source (`spreadScratches`), written
    // once at the spread's position like the fixed arm's.
    case 'dyn-object-literal': {
      self.callSlots.set(expr, self.slotCount);
      // A get/set PAIR needs two scratch slots, not one: both closures are live when
      // jsrt_define_accessor is called, and building the second may allocate. One half alone
      // needs no more than an ordinary value does -- and the frame must be exactly as large as
      // what it roots, so a slot nothing writes is a test failure, not slack.
      const scratches = spreadScratches(expr.entries);
      self.slotCount += dynLiteralBaseSlots(expr) + scratches.length;
      // Like the fixed arm: a spread's shared source counts once, not once per field.
      const spreadKeys = new Set(scratches.map(({ key }) => key));
      const countedSpread = new Set<string>();
      for (const entry of expr.entries) {
        if (isAccessorEntry(entry)) {
          if (entry.get !== undefined) {
            countExpression(self, entry.get);
          }
          if (entry.set !== undefined) {
            countExpression(self, entry.set);
          }
          continue;
        }
        if (isComputedEntry(entry)) {
          countExpression(self, entry.key);
          countExpression(self, entry.value);
          continue;
        }
        countEntryValue(self, entry.value, spreadKeys, countedSpread);
      }
      break;
    }
    // Target first, then each argument, each in its own rooted slot. The runtime functions take
    // positional C arguments rather than an argv, so the run does not have to be contiguous --
    // but the SEQUENCING does have to exist: C leaves argument evaluation order unspecified, and
    // `m.set(f(), g())` must run f before g (plan-notes 55).
    // One rooted slot for the argument: the runtime walk allocates its result while the
    // argument must stay reachable, and a slot is the frame discipline's way to promise that.
    // `new Date(x)` is the same shape: the argument (a string, or another Date) must stay
    // reachable across the JSRTDate allocation.
    case 'date-new':
    case 'error-new':
    case 'json-parse':
    case 'json-stringify':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 1;
      countExpression(self, expr.arg);
      break;
    // One rooted slot for the awaited value: it has to survive the subscribe allocation on the
    // way out, and it holds the resumed result on the way back in. The state number is assigned
    // here too, because the dispatch switch is emitted ahead of the labels it jumps to.
    case 'await':
    case 'yield':
      self.tempSlots.set(expr, self.slotCount);
      self.slotCount += 1;
      self.awaitStates.set(expr, self.awaitStates.size + 1);
      countExpression(self, expr.value);
      break;
    // The same one-slot promise json-parse makes: jsrt_promise_* allocates its result while the
    // argument must stay reachable.
    case 'promise-static':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 1;
      countExpression(self, expr.arg);
      break;
    case 'promise-construct':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 1;
      countExpression(self, expr.executor);
      break;
    case 'promise-method':
      countRooted(self, expr, expr.target, expr.args);
      break;
    // The same reachability promise, one slot per argument: an Object walk allocates its
    // result, and `Object.hasOwn(o, k)` must hold BOTH operands across the call.
    // `Date.UTC(y, m, ...)` sequences for the same reason, even though every operand is an
    // immediate: C would otherwise pick the order of the calls that produce them.
    // A typed-array op (plan.md T11.1) roots its receiver and arguments the same way: a
    // `subarray` allocates the view while the bounds it was given are still live.
    case 'date-components':
    case 'date-static':
    case 'global-call':
    case 'object-static':
    case 'typed-op':
      countRooted(self, expr, undefined, expr.args);
      break;
    // Same discipline for a string or array op: the receiver and every argument stay rooted
    // while the rest are evaluated, and evaluation order is pinned against C's unspecified
    // argument order.
    // A regexp op is the same shape: `re.test(s)` holds the compiled pattern rooted while the
    // subject is evaluated, and the subject rooted while the engine allocates.
    // A date op is the same shape again: `d.setUTCHours(f(), g())` must run f before g, and
    // the receiver stays rooted while a string-producing op (toISOString) allocates.
    case 'array-op':
    case 'collection-op':
    case 'date-op':
    case 'number-op':
    case 'regexp-op':
    case 'string-op':
      countRooted(self, expr, expr.target, expr.args);
      break;
    case 'iterator-next':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 2;
      countExpression(self, expr.target);
      countExpression(self, expr.sent);
      break;
    // Numbers are immediates -- nothing to root -- so the slots exist for SEQUENCING alone:
    // `Math.pow(f(), g())` must run f before g, and C leaves argument order unspecified. A
    // single argument has no order to fix and takes no slot at all. `String.fromCharCode`
    // is the same shape: a namespace call with no receiver, one runtime function per method.
    case 'math-call':
    case 'string-static':
      // An argument that may be an object also takes the slots: its `valueOf` may throw, so the
      // call becomes a statement with a pending check (plan.md §9 Task 6.27).
      if (expr.args.length > 1 || argsConvert(expr.args)) {
        self.callSlots.set(expr, self.slotCount);
        self.slotCount += expr.args.length;
      }
      for (const arg of expr.args) {
        countExpression(self, arg);
      }
      break;
    // No slot: the read is a dereference with nothing allocated between evaluating the target
    // and using it, so there is no window in which the object could go unrooted.
    case 'field-access':
    case 'method-value':
    // A match read is a property load or a header read -- same story, nothing allocated. So is
    // a regexp read: a struct field or a bit test.
    case 'match-read':
    case 'regexp-read':
    // Same as a field read: the test is a pointer comparison against a static descriptor, with
    // nothing allocated between evaluating the target and using it.
    case 'instanceof':
      countExpression(self, expr.target);
      break;
    // `new v(...)` takes the call layout: the constructor value, then each argument, rooted in
    // one contiguous run that is also the `argv` the runtime reads (plan-notes 310).
    case 'new-value':
      countRooted(self, expr, expr.target, expr.args);
      break;
    // The walk can throw (a right side with no object `prototype`), so it lands as a statement
    // with its pending check, and both operands wait in rooted slots like a call's.
    case 'instanceof-value':
      countRooted(self, expr, expr.target, [expr.ctor]);
      break;
    case 'class-value':
      break;
    case 'dyn-field-access':
      self.tempSlots.set(expr, self.slotCount++);
      countExpression(self, expr.target);
      break;
    // The dispatch allocates (it boxes collections) and can throw (a non-iterable leaves a
    // catchable TypeError pending), so the operand and the result each need a rooted slot for
    // the same reason a dynamic property read does.
    case 'get-iterator':
      self.tempSlots.set(expr, self.slotCount++);
      countExpression(self, expr.target);
      break;
    // One allocator call with no operands: nothing is evaluated between the allocation and the
    // use of its result, so there is no window to root against.
    // One rooted slot for the pattern text, claimed before the FLAG string is allocated: the
    // two are two allocations, and the first has to survive the second.
    case 'regexp-literal':
      self.callSlots.set(expr, self.slotCount);
      self.slotCount += 1;
      break;
    case 'collection-new':
    case 'number-literal':
    case 'string-literal':
    case 'boolean-literal':
    case 'null-literal':
    case 'undefined-literal':
    case 'identifier':
    // No slot: the name is a C string literal in the emitted call, not a rooted value.
    case 'reference-error':
    case 'type-error':
    // An out-slot creation needs no slot: it answers the pure zero-handle inline, and the
    // binding (or argument slot) that receives it is counted where it is declared.
    case 'out-new':
      break;
    // A slot read allocates nothing: the bits are already rooted where they sit.
    case 'out-get':
      countExpression(self, expr.operand);
      break;
    default: {
      const _exhaustive: never = expr;
      throw new Error(
        `Unknown expression kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
      );
    }
  }
}

/* Where control goes when an exception is pending: the innermost try's landing pad, or the
 * unit's own unwind tail when no try is open. Asking marks the pad used, which is what decides
 * whether the tail -- or a catch that nothing in its try body can reach -- is emitted at all. */
export function currentPad(self: Emitter): string {
  const pad = self.padStack.at(-1);
  if (pad === undefined) {
    self.unwindUsed = true;
    return '_jsrt_unwind';
  }
  self.usedLabels.add(pad);
  return pad;
}

export function emitPendingCheck(self: Emitter, span: Span): void {
  appendLine(self, `if (jsrt_pending()) { goto ${currentPad(self)}; }`, span);
}

export function capture(
  self: Emitter,
  f: () => string,
): { readonly lines: string[]; readonly value: string } {
  const saved = self.lines;
  const buffer: string[] = [];
  self.lines = buffer;
  const value = f();
  self.lines = saved;
  return { lines: buffer, value };
}

/* Evaluates one operand of a comma sequence under construction. A call-free operand joins the
 * sequence via `use` and keeps the compact single-line shape. One that produced statements of
 * its own (a call and its pending check) forces the sequence so far out as a statement FIRST:
 * the language already evaluated those operands, so their values must be sitting in their
 * rooted slots before this operand's calls run -- and then lands its own `use` line after its
 * statements. Returns whether it flushed, which tells the caller the compact shape is gone. */
export function sequencePart(
  self: Emitter,
  parts: string[],
  operand: Expression,
  span: Span,
  use: (value: string) => string,
): boolean {
  const captured = capture(self, () => cgExpr.emitExpression(self, operand));
  if (captured.lines.length === 0) {
    parts.push(use(captured.value));
    return false;
  }
  flushParts(self, parts, span);
  self.lines.push(...captured.lines);
  appendLine(self, `${use(captured.value)};`, span);
  return true;
}

export function flushParts(self: Emitter, parts: string[], span: Span): void {
  if (parts.length > 0) {
    appendLine(self, `${parts.join(', ')};`, span);
    parts.length = 0;
  }
}

export function sequenceArgs(
  self: Emitter,
  parts: string[],
  args: readonly Expression[],
  span: Span,
  base: number,
  start: number,
): boolean {
  let flushed = false;
  args.forEach((arg, index) => {
    flushed =
      sequencePart(self, parts, arg, span, (v) => `${slotAt(self, base + start + index)} = ${v}`) ||
      flushed;
  });
  return flushed;
}

/* The shared tail of a sequenced op that nests inline when nothing forced a flush: with no
 * flushed statements the whole sequence -- parts plus the final computation -- is one comma
 * expression answering `result`; otherwise the parts already left as statements and the
 * answer is `result` itself. Arms that always land as statements (a pending check has
 * nowhere to stand inside a comma expression) share `finishStatement` instead. */
export function finishSequenced(
  self: Emitter,
  parts: string[],
  result: string,
  span: Span,
  flushed: boolean,
): string {
  if (!flushed) {
    parts.push(result);
    return `(${parts.join(', ')})`;
  }
  flushParts(self, parts, span);
  return result;
}

/* Opens a call-shaped arm: the callee (or the receiver, which occupies the callee's slot)
 * first, then the arguments left to right -- the evaluation order the language specifies,
 * each landing in its rooted slot before the next runs. The arms that track flushing keep
 * their own target sequencing and share only the argument half. */
export function beginCall(
  self: Emitter,
  parts: string[],
  first: Expression,
  args: readonly Expression[],
  span: Span,
  base: number,
): void {
  sequencePart(self, parts, first, span, (v) => `${slotAt(self, base)} = ${v}`);
  sequenceArgs(self, parts, args, span, base, 1);
}

/* The shared tail of a call-shaped arm that always lands as statements: `assignment`
 * computes the answer into its rooted slot as a STATEMENT (never inside the consumer's
 * expression), so the pending check can sit between the call and whatever consumes the
 * result. Which arms take this tail -- always, or only when they can throw -- stays with
 * each arm; only the landing is shared. */
/* The tail of an op whose answer lands in its first rooted slot: an op that can throw becomes a
 * statement followed by its pending check (the check has to sit between the op and whatever
 * consumes the result, which a comma expression gives it nowhere to stand); any other op stays
 * the sequenced expression. */
export function finishOp(
  self: Emitter,
  parts: string[],
  base: number,
  opCall: string,
  span: Span,
  flushed: boolean,
  canThrow: boolean,
): string {
  return canThrow
    ? finishStatement(self, parts, `${slotAt(self, base)} = ${opCall}`, slotAt(self, base), span)
    : finishSequenced(self, parts, opCall, span, flushed);
}

export function finishStatement(
  self: Emitter,
  parts: string[],
  assignment: string,
  result: string,
  span: Span,
): string {
  parts.push(assignment);
  flushParts(self, parts, span);
  emitPendingCheck(self, span);
  return result;
}

/* The C lvalue for a slot of the unit being emitted. Same slot number, different array: a
 * function's slots are its stack frame, the module's are the file-static globals. */
export function slotAt(self: Emitter, slot: number): string {
  // An async or generator unit keeps every local in its heap environment instead: the frame it
  // would otherwise sit in is popped at each suspension and rebuilt on each resume, so a C frame
  // slot would not survive a single `await` or `yield`.
  if (self.inAsync || self.inGenerator) {
    return `_jsrt_env->slots[${slot}]`;
  }
  return self.inFunction ? `JSRT_LOCAL(${slot})` : `JSRT_GLOBAL(${slot})`;
}

/* Where a name lives, in the order storage is assigned to it: this function's own environment,
 * an enclosing environment, this function's frame, or the module's globals. The environment
 * cases come FIRST -- a captured binding was deliberately kept out of the frame, so a frame slot
 * of the same name would be a second, silently divergent copy of one variable. */
export function slotRef(self: Emitter, name: string): string {
  const owned = self.envMap.get(name);
  if (owned !== undefined) {
    return `_jsrt_env->slots[${owned}]`;
  }
  const captured = self.captureMap.get(name);
  if (captured !== undefined) {
    return `JSRT_ENV_AT(env, ${captured.levels}, ${captured.index})`;
  }
  const own = self.slotMap.get(name);
  if (own !== undefined) {
    return slotAt(self, own);
  }
  const global = self.globalMap.get(name);
  if (global === undefined) {
    throw new Error(`Undefined identifier: ${name}`);
  }
  return `JSRT_GLOBAL(${global})`;
}

/* The environment a closure created HERE should capture: this function's own if it has one,
 * otherwise the one it was handed. NULL at module level, where bindings are globals already. */
export function currentEnv(self: Emitter): string {
  if (self.envMap.size > 0) {
    return '_jsrt_env';
  }
  return self.inFunction ? 'env' : 'NULL';
}

export function appendLine(self: Emitter, line: string, span?: Span): void {
  const indentStr = '  '.repeat(self.indent);
  let fullLine = indentStr + line;

  // Add #line directive before statements (but not for braces/empty lines)
  if (span && line && !line.startsWith('}')) {
    const escapedFile = escapeCString(self, span.file ?? self.fileName);
    fullLine = `#line ${span.line} "${escapedFile}"\n${fullLine}`;
  }

  self.lines.push(fullLine);
}

/** Escapes for a C string literal. Named for the job, not for its first caller: file paths
 * and the identifier a `reference-error` carries both go through it. */
/** The free function of the same name: kept as a method so the emitter's many call sites read
 * the same as they always did. */
export function escapeCString(_self: Emitter, text: string): string {
  return escapeCStringLiteral(text);
}
