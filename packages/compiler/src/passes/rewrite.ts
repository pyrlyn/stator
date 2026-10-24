/* The one HIR walker — every pass in this directory rebuilds the tree through it.
 *
 * Written once, exhaustively, rather than once per pass. A pass supplies two functions and gets a
 * transformed module; it never enumerates node kinds itself, so adding a pass costs the rules it
 * cares about and nothing else, and adding a NODE kind costs one clause here rather than one per
 * pass that quietly forgot it.
 *
 * The switches are exhaustive on purpose, and the `never` fallthrough is the point of them: a new
 * node kind is a type error in this file the day it is added. A reflective walker that rebuilt
 * objects generically would have handled every future kind silently — which sounds like the same
 * thing and is the opposite, because a node with special evaluation rules (LogicalOp's conditional
 * right operand, above all) would be rewritten by a pass that never decided it was safe to.
 *
 * REWRITING IS BOTTOM-UP. Children are transformed first, then the parent is offered to the
 * caller's function with its new children already in place. Const-folding depends on it — `1 + 2 + 3`
 * only folds because `1 + 2` became `3` before the outer `+` was asked — and so does every pass that
 * asks a question about its operands.
 *
 * A returned node is IDENTICAL (===) to its input when nothing under it changed. Not an
 * optimization: it is how a fixpoint loop knows it has converged without comparing trees.
 */

import type {
  Block,
  ClassMethod,
  DynEntry,
  Expression,
  FunctionExpr,
  Module,
  ObjectEntry,
  Statement,
  SwitchClause,
} from '../hir/nodes.ts';
import { isAccessorEntry, isComputedEntry } from '../hir/nodes.ts';

/** What a pass supplies. All three are called with children already rewritten; all three may return
 * their argument unchanged, and returning it by identity is how "nothing happened" is expressed.
 *
 * A statement rewrite returns a LIST, because the two useful answers a statement pass has are
 * "replace it" and "delete it", and a list says both. `[stmt]` is the identity.
 *
 * `statements` sees a whole sequence at once, and exists because the per-statement hook structurally
 * cannot express the most ordinary statement-level fact there is: that a `return` makes its
 * FOLLOWING SIBLINGS unreachable. A statement can only ever speak for itself, so a pass reasoning
 * about a run of them needs the run. */
export interface Rewriter {
  readonly expression?: (expr: Expression) => Expression;
  readonly statement?: (stmt: Statement) => readonly Statement[];
  readonly statements?: (statements: readonly Statement[]) => readonly Statement[];
}

export function rewriteModule(module: Module, rewriter: Rewriter): Module {
  const statements = rewriteStatements(module.statements, rewriter);
  return statements === module.statements ? module : { ...module, statements };
}

/** `===` to the input array when every statement came back identical and none was deleted. */
export function rewriteStatements(
  statements: readonly Statement[],
  rewriter: Rewriter,
): readonly Statement[] {
  const out: Statement[] = [];
  let changed = false;
  for (const stmt of statements) {
    const replacement = rewriteStatement(stmt, rewriter);
    changed = changed || replacement.length !== 1 || replacement[0] !== stmt;
    out.push(...replacement);
  }
  const rebuilt = changed ? out : statements;
  return rewriter.statements === undefined ? rebuilt : rewriter.statements(rebuilt);
}

function rewriteBlock(block: Block, rewriter: Rewriter): Block {
  const statements = rewriteStatements(block.statements, rewriter);
  return statements === block.statements ? block : { ...block, statements };
}

/** An optional child: absent stays absent, and identity is preserved so the parent can tell. */
function rewriteOptional<T>(value: T | undefined, f: (v: T) => T): T | undefined {
  return value === undefined ? undefined : f(value);
}

function rewriteFunction(fn: FunctionExpr, rewriter: Rewriter): FunctionExpr {
  const body = rewriteBlock(fn.body, rewriter);
  const params = rewriteEach(fn.params, (param) => {
    if (param.default === undefined) {
      return param;
    }
    const next = rewriteExpression(param.default, rewriter);
    return next === param.default ? param : { ...param, default: next };
  });
  return body === fn.body && params === fn.params ? fn : { ...fn, body, params };
}

function rewriteMethod(method: ClassMethod, rewriter: Rewriter): ClassMethod {
  const fn = rewriteFunction(method.fn, rewriter);
  return fn === method.fn ? method : { ...method, fn };
}

/** `===` to the input array when every element came back identical. */
function rewriteEach<T>(items: readonly T[], f: (item: T) => T): readonly T[] {
  let changed = false;
  const out = items.map((item) => {
    const next = f(item);
    changed = changed || next !== item;
    return next;
  });
  return changed ? out : items;
}

export function rewriteStatement(stmt: Statement, rewriter: Rewriter): readonly Statement[] {
  const rebuilt = rebuildStatement(stmt, rewriter);
  return rewriter.statement === undefined ? [rebuilt] : rewriter.statement(rebuilt);
}

function rebuildStatement(stmt: Statement, rewriter: Rewriter): Statement {
  const expr = (e: Expression): Expression => rewriteExpression(e, rewriter);
  const block = (b: Block): Block => rewriteBlock(b, rewriter);

  switch (stmt.kind) {
    case 'declaration': {
      if (stmt.value === undefined) {
        return stmt;
      }
      const value = expr(stmt.value);
      return value === stmt.value ? stmt : { ...stmt, value };
    }
    case 'assignment': {
      const value = expr(stmt.value);
      return value === stmt.value ? stmt : { ...stmt, value };
    }
    case 'index-assignment': {
      const target = expr(stmt.target);
      const index = expr(stmt.index);
      const value = expr(stmt.value);
      return target === stmt.target && index === stmt.index && value === stmt.value
        ? stmt
        : { ...stmt, target, index, value };
    }
    case 'field-assignment':
    case 'dyn-field-assignment': {
      const target = expr(stmt.target);
      const value = expr(stmt.value);
      return target === stmt.target && value === stmt.value ? stmt : { ...stmt, target, value };
    }
    case 'super-call': {
      const receiver = expr(stmt.receiver);
      const args = rewriteEach(stmt.args, expr);
      return receiver === stmt.receiver && args === stmt.args ? stmt : { ...stmt, receiver, args };
    }
    // A class's own parts are functions and initializers; its layout (fields, slots, vtable) is
    // resolved by the lowering and is not a tree to walk.
    case 'class-declaration': {
      const ctor = rewriteOptional(stmt.ctor, (c) => rewriteMethod(c, rewriter));
      const methods = rewriteEach(stmt.methods, (m) => rewriteMethod(m, rewriter));
      const statics = rewriteEach(stmt.statics, (s) => {
        if (s.value === undefined) {
          return s;
        }
        const value = expr(s.value);
        return value === s.value ? s : { ...s, value };
      });
      return ctor === stmt.ctor && methods === stmt.methods && statics === stmt.statics
        ? stmt
        : { ...stmt, ...(ctor === undefined ? {} : { ctor }), methods, statics };
    }
    case 'expression-statement': {
      const expression = expr(stmt.expression);
      return expression === stmt.expression ? stmt : { ...stmt, expression };
    }
    case 'if-statement': {
      const condition = expr(stmt.condition);
      const consequent = block(stmt.consequent);
      const alternate = rewriteOptional(stmt.alternate, block);
      return condition === stmt.condition &&
        consequent === stmt.consequent &&
        alternate === stmt.alternate
        ? stmt
        : {
            ...stmt,
            condition,
            consequent,
            ...(alternate === undefined ? {} : { alternate }),
          };
    }
    case 'while-statement':
    case 'do-while-statement': {
      const condition = expr(stmt.condition);
      const body = block(stmt.body);
      return condition === stmt.condition && body === stmt.body
        ? stmt
        : { ...stmt, condition, body };
    }
    case 'for-statement': {
      // `init` and `update` are STATEMENTS, and a statement rewrite may return zero or many. A for
      // header has room for exactly one of each, so a rewrite that changes the count is refused
      // rather than silently dropping the loop's counter -- a pass that wants to delete a for's
      // update must delete the whole loop.
      const init = rewriteOptional(stmt.init, (s) => oneStatement(s, rewriter, 'for init'));
      const condition = rewriteOptional(stmt.condition, expr);
      const update = rewriteOptional(stmt.update, (s) => oneStatement(s, rewriter, 'for update'));
      const body = block(stmt.body);
      return init === stmt.init &&
        condition === stmt.condition &&
        update === stmt.update &&
        body === stmt.body
        ? stmt
        : {
            ...stmt,
            ...(init === undefined ? {} : { init }),
            ...(condition === undefined ? {} : { condition }),
            ...(update === undefined ? {} : { update }),
            body,
          };
    }
    case 'for-of-statement': {
      const iterable = expr(stmt.iterable);
      const body = block(stmt.body);
      return iterable === stmt.iterable && body === stmt.body ? stmt : { ...stmt, iterable, body };
    }
    case 'switch-statement': {
      const discriminant = expr(stmt.discriminant);
      const clauses = rewriteEach(stmt.clauses, (clause): SwitchClause => {
        const test = rewriteOptional(clause.test, expr);
        const statements = rewriteStatements(clause.statements, rewriter);
        return test === clause.test && statements === clause.statements
          ? clause
          : { ...(test === undefined ? {} : { test }), statements };
      });
      return discriminant === stmt.discriminant && clauses === stmt.clauses
        ? stmt
        : { ...stmt, discriminant, clauses };
    }
    case 'function-declaration': {
      const fn = rewriteFunction(stmt.fn, rewriter);
      return fn === stmt.fn ? stmt : { ...stmt, fn };
    }
    case 'return-statement': {
      const value = rewriteOptional(stmt.value, expr);
      return value === stmt.value ? stmt : { ...stmt, ...(value === undefined ? {} : { value }) };
    }
    case 'block':
      return rewriteBlock(stmt, rewriter);
    // Neither carries a child expression: a jump's only operand is its label, which is a name.
    case 'break-statement':
    case 'continue-statement':
      return stmt;
    case 'throw-statement': {
      const value = expr(stmt.value);
      return value === stmt.value ? stmt : { ...stmt, value };
    }
    case 'try-statement': {
      const tryBlock = rewriteBlock(stmt.tryBlock, rewriter);
      const catchBlock = rewriteOptional(stmt.catchBlock, (b) => rewriteBlock(b, rewriter));
      const finallyBlock = rewriteOptional(stmt.finallyBlock, (b) => rewriteBlock(b, rewriter));
      return tryBlock === stmt.tryBlock &&
        catchBlock === stmt.catchBlock &&
        finallyBlock === stmt.finallyBlock
        ? stmt
        : {
            ...stmt,
            tryBlock,
            ...(catchBlock === undefined ? {} : { catchBlock }),
            ...(finallyBlock === undefined ? {} : { finallyBlock }),
          };
    }
    default: {
      const exhaustive: never = stmt;
      throw new Error(`rewriteStatement: unhandled kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A statement in a position that holds exactly one. Throws rather than guessing, because both
 * wrong answers are silent: dropping a for-loop's update makes an infinite loop, and splicing two
 * statements into a header does not parse in the C the emitter would write. */
function oneStatement(stmt: Statement, rewriter: Rewriter, position: string): Statement {
  const replacement = rewriteStatement(stmt, rewriter);
  const only = replacement[0];
  if (replacement.length !== 1 || only === undefined) {
    throw new Error(`a pass rewrote one ${position} statement into ${replacement.length}`);
  }
  return only;
}

export function rewriteExpression(expr: Expression, rewriter: Rewriter): Expression {
  const rebuilt = rebuildExpression(expr, rewriter);
  return rewriter.expression === undefined ? rebuilt : rewriter.expression(rebuilt);
}

function rebuildExpression(expr: Expression, rewriter: Rewriter): Expression {
  const sub = (e: Expression): Expression => rewriteExpression(e, rewriter);

  switch (expr.kind) {
    // Leaves: a literal has no children, and an identifier's only content is its name.
    // A regexp literal carries TEXT, not expressions: there is nothing inside it to rewrite.
    case 'regexp-literal':
    case 'number-literal':
    case 'string-literal':
    case 'boolean-literal':
    case 'null-literal':
    case 'undefined-literal':
    case 'identifier':
    case 'collection-new':
    // Carries a NAME, not an expression -- there is no binding to point at, which is the condition
    // it models. Nothing inside to rewrite.
    case 'reference-error':
    case 'type-error':
      return expr;
    case 'binary-op':
    // LogicalOp's right operand may not be evaluated at all. Rewriting it is still sound -- a
    // rewrite replaces an expression with an equivalent one, it does not run it -- but a pass that
    // MOVES work must consult the node kind, which is why this is a separate case in every pass.
    case 'logical-op': {
      const left = sub(expr.left);
      const right = sub(expr.right);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    case 'unary-op':
    case 'typeof':
    case 'string-length':
    case 'array-length':
    case 'function-length': {
      const operand = sub(expr.operand);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case 'delete-prop': {
      const target = sub(expr.target);
      const key = sub(expr.key);
      return target === expr.target && key === expr.key ? expr : { ...expr, target, key };
    }
    case 'conditional': {
      const condition = sub(expr.condition);
      const consequent = sub(expr.consequent);
      const alternate = sub(expr.alternate);
      return condition === expr.condition &&
        consequent === expr.consequent &&
        alternate === expr.alternate
        ? expr
        : { ...expr, condition, consequent, alternate };
    }
    // The consequent runs conditionally (only when the base is non-nullish), but rewriting it
    // is still sound for the reason the logical-op case states: a rewrite replaces an
    // expression with an equivalent one, it does not run it. A pass that MOVES work must
    // consult the kind, like every other conditional-evaluation node.
    case 'optional-chain': {
      const base = sub(expr.base);
      const consequent = sub(expr.consequent);
      return base === expr.base && consequent === expr.consequent
        ? expr
        : { ...expr, base, consequent };
    }
    // The guarded value: a leaf with nothing inside to rewrite.
    case 'optional-base':
      return expr;
    case 'update': {
      const target = sub(expr.target);
      if (
        target.kind !== 'identifier' &&
        target.kind !== 'index-access' &&
        target.kind !== 'field-access' &&
        target.kind !== 'dyn-field-access' &&
        target.kind !== 'accessor-place'
      ) {
        throw new Error(`rewriteExpression: update target became ${target.kind}`);
      }
      const value = expr.value !== undefined ? sub(expr.value) : undefined;
      return target === expr.target && value === expr.value
        ? expr
        : { ...expr, target, ...(value !== undefined ? { value } : {}) };
    }
    case 'boundary-check': {
      const value = sub(expr.value);
      return value === expr.value ? expr : { ...expr, value };
    }
    case 'template-literal': {
      const expressions = rewriteEach(expr.expressions, sub);
      return expressions === expr.expressions ? expr : { ...expr, expressions };
    }
    case 'array-literal': {
      const elements = rewriteEach(expr.elements, sub);
      return elements === expr.elements ? expr : { ...expr, elements };
    }
    case 'index-access': {
      const target = sub(expr.target);
      const index = sub(expr.index);
      return target === expr.target && index === expr.index ? expr : { ...expr, target, index };
    }
    case 'new':
    case 'console-log': {
      const args = rewriteEach(expr.args, sub);
      return args === expr.args ? expr : { ...expr, args };
    }
    case 'new-value': {
      const target = sub(expr.target);
      const args = rewriteEach(expr.args, sub);
      return target === expr.target && args === expr.args ? expr : { ...expr, target, args };
    }
    case 'instanceof-value': {
      const target = sub(expr.target);
      const ctor = sub(expr.ctor);
      return target === expr.target && ctor === expr.ctor ? expr : { ...expr, target, ctor };
    }
    case 'class-value': {
      return expr;
    }
    case 'instanceof':
    case 'field-access':
    case 'match-read':
    case 'regexp-read':
    case 'get-iterator':
    case 'dyn-field-access':
    case 'accessor-place': {
      const target = sub(expr.target);
      return target === expr.target ? expr : { ...expr, target };
    }
    case 'iterator-next': {
      const target = sub(expr.target);
      const sent = sub(expr.sent);
      return target === expr.target && sent === expr.sent ? expr : { ...expr, target, sent };
    }

    case 'method-value': {
      const target = sub(expr.target);
      return target === expr.target ? expr : { ...expr, target };
    }
    case 'array-op':
    case 'method-call':
    case 'dyn-method-call':
    case 'field-call':
    case 'number-op':
    case 'collection-op':
    case 'date-op':
    case 'regexp-op':
    case 'string-op': {
      const target = sub(expr.target);
      const args = rewriteEach(expr.args, sub);
      return target === expr.target && args === expr.args ? expr : { ...expr, target, args };
    }
    case 'date-components':
    case 'date-static':
    case 'global-call':
    case 'math-call':
    case 'object-static':
    case 'string-static':
    case 'typed-op': {
      const args = rewriteEach(expr.args, sub);
      return args === expr.args ? expr : { ...expr, args };
    }
    case 'date-new':
    case 'error-new':
    case 'json-parse':
    case 'json-stringify':
    case 'promise-static': {
      const arg = sub(expr.arg);
      return arg === expr.arg ? expr : { ...expr, arg };
    }
    case 'promise-method': {
      const target = sub(expr.target);
      const args = rewriteEach(expr.args, sub);
      return target === expr.target && args === expr.args ? expr : { ...expr, target, args };
    }
    case 'promise-construct': {
      const executor = sub(expr.executor);
      return executor === expr.executor ? expr : { ...expr, executor };
    }
    case 'await':
    case 'yield': {
      const value = sub(expr.value);
      return value === expr.value ? expr : { ...expr, value };
    }
    case 'object-literal': {
      const entries = rewriteEach(expr.entries, (entry): ObjectEntry => {
        const value = sub(entry.value);
        return value === entry.value ? entry : { ...entry, value };
      });
      const methods = rewriteEach(expr.methods, (method): ClassMethod => {
        const fn = rewriteFunction(method.fn, rewriter);
        return fn === method.fn ? method : { ...method, fn };
      });
      const methodCopies = rewriteEach(expr.methodCopies, (copy) => {
        const value = sub(copy.value);
        if (value.kind !== 'method-value') {
          throw new Error(`rewriteExpression: spread method copy became ${value.kind}`);
        }
        return value === copy.value ? copy : { ...copy, value };
      });
      return entries === expr.entries &&
        methods === expr.methods &&
        methodCopies === expr.methodCopies
        ? expr
        : { ...expr, entries, methods, methodCopies };
    }
    case 'dyn-object-literal': {
      const entries = rewriteEach(expr.entries, (entry): DynEntry => {
        if (isAccessorEntry(entry)) {
          const get = entry.get === undefined ? undefined : sub(entry.get);
          const set = entry.set === undefined ? undefined : sub(entry.set);
          return get === entry.get && set === entry.set ? entry : { ...entry, get, set };
        }
        if (isComputedEntry(entry)) {
          const key = sub(entry.key);
          const value = sub(entry.value);
          return key === entry.key && value === entry.value ? entry : { ...entry, key, value };
        }
        const value = sub(entry.value);
        return value === entry.value ? entry : { ...entry, value };
      });
      return entries === expr.entries ? expr : { ...expr, entries };
    }
    case 'function':
      return rewriteFunction(expr, rewriter);
    case 'extern-call': {
      const args = rewriteEach(expr.args, sub);
      return args === expr.args ? expr : { ...expr, args };
    }
    // A slot creation has no children to rewrite; a slot read rewrites its operand (which is
    // never itself a slot node — the gate admits only names and fresh slots as receivers —
    // so one level suffices and no fixpoint is owed).
    case 'out-new': {
      return expr;
    }
    case 'out-get': {
      const operand = sub(expr.operand);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case 'call': {
      const callee = sub(expr.callee);
      const args = rewriteEach(expr.args, sub);
      return callee === expr.callee && args === expr.args ? expr : { ...expr, callee, args };
    }
    default: {
      const exhaustive: never = expr;
      throw new Error(`rewriteExpression: unhandled kind ${JSON.stringify(exhaustive)}`);
    }
  }
}
