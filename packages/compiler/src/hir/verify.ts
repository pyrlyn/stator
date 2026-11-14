/** HIR verifier (plan.md §5 Task 2.3).
 *
 * Checks at minimum:
 * - every node carries an HType (no missing/undefined types)
 * - operand agreement: arithmetic operands are `number`; comparison operands agree
 * - if/while conditions are `boolean`
 * - result type of each expression matches its operator
 * - assignment target type matches the assigned value's type
 * - every identifier reference resolves to a binding declared before use
 *
 * Returns a list of problems (does not throw). Each problem is actionable:
 * includes the offending node's kind and span.
 */

import type {
  Assignment,
  BinaryOp,
  Block,
  ConsoleLogCall,
  Declaration,
  Expression,
  ExpressionStatement,
  FunctionExpr,
  Identifier,
  IfStatement,
  Module,
  ObjectStaticMethod,
  Span,
  Statement,
} from './nodes.ts';
import {
  ARRAY_OPS,
  CONSOLE_METHODS,
  consoleEntryPoint,
  DATE_OPS,
  DATE_STATICS,
  errorHType,
  forOfElementType,
  isAccessorEntry,
  isSetOperation,
  MATCH_FIELDS,
  REGEXP_FIELDS,
  REGEXP_OPS,
  SET_OPS,
  STRING_OPS,
} from './nodes.ts';
import type { HType } from './types.ts';
import {
  fieldSlot,
  H_BOOLEAN,
  H_NUMBER,
  H_STRING,
  H_UNDEFINED,
  hasTypeParam,
  hTypeAssignable,
  hTypeEquals,
  hTypeName,
  hUnknown,
  methodOf,
} from './types.ts';

/** A verifier problem is always a compiler bug, never a user error: the gate accepted the source
 * and the lowering produced this HIR, so a failure here means one of them is wrong. Hence the
 * STA4xxx codes. The code is a field, not text inside the message, because tests reference codes
 * and message wording is free to change (docs/DIAGNOSTICS.md). */
export interface VerifyProblem {
  readonly kind: string; // node.kind for context
  readonly code: string;
  readonly span: Span;
  readonly message: string;
}

/** One enclosing loop or switch, innermost last.
 *
 * `isLoop` is what separates the two jumps: `break` may leave either, `continue` may only leave a
 * loop — so `continue` inside a `switch` inside a `for` targets the `for`, skipping the switch.
 * Getting this wrong does not produce a wrong answer, it produces a `goto` to a label the emitter
 * never wrote, which surfaces as a clang error against generated C. */
interface Enclosing {
  readonly label?: string;
  readonly isLoop: boolean;
  /** A function body's boundary, pushed as the sole entry when one is entered. It is not a jump
   * target -- it is a wall: `break` and `continue` skip it (and so find nothing, which is the
   * right answer), while `return` looks for exactly it. */
  readonly isFunction?: boolean;
}

export function verifyHir(module: Module): readonly VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const bindings = new Map<string, { kind: 'let' | 'const'; type: HType }>();

  verifyModule(module, problems, bindings);

  return problems;
}

function verifyModule(
  module: Module,
  problems: VerifyProblem[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
): void {
  // Check module itself has a type
  if (!module.type) {
    problems.push({
      kind: 'module',
      span: module.span,
      code: 'STA4020',
      message: 'module node missing HType',
    });
  }

  // Verify all statements
  hoistFunctions(module.statements, bindings);
  for (const stmt of module.statements) {
    verifyStatement(stmt, problems, bindings);
  }
}

/** Mirrors the lowering's hoist: a function declaration's binding exists for the whole body it is
 * declared in, not from its own line down. Without this a legal forward call is reported as an
 * undefined identifier (STA4002) by the verifier alone. */
function hoistFunctions(
  statements: readonly Statement[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
): void {
  for (const stmt of statements) {
    if (stmt.kind === 'function-declaration') {
      bindings.set(stmt.name, { kind: 'const', type: stmt.fn.type });
    }
  }
}

/** Only an array can be indexed, and only Unknown may pretend to be one.
 *
 * The Unknown exemption is the same one calls get (STA4041): in js mode indexing an unresolved
 * value is the whole point, and the runtime decides. A CONCRETE non-array target means the
 * lowering built an index the checker would already have rejected. */
function checkIndexable(
  target: Expression,
  kind: 'index-access' | 'index-assignment',
  code: 'STA4044',
  problems: VerifyProblem[],
): void {
  if (target.type.kind !== 'array' && target.type.kind !== 'unknown') {
    problems.push({
      kind,
      span: target.span,
      code,
      message: `index target has type '${hTypeName(target.type)}', which is not indexable`,
    });
  }
}

/** The stored slot still names `field` in the target's class.
 *
 * This is the whole reason FieldAccess carries a slot instead of the emitter recomputing one: a
 * recomputed index is right by construction and therefore unfalsifiable, while a stored one can be
 * checked against the layout it claims to index -- and a disagreement between the lowering's field
 * order and the type's is a silent read of the wrong field, which is the worst bug this pass can
 * catch. */
function checkField(
  target: Expression,
  field: string,
  slot: number,
  kind: 'field-access' | 'field-assignment',
  problems: VerifyProblem[],
): void {
  if (target.type.kind !== 'object') {
    problems.push({
      kind,
      span: target.span,
      code: 'STA4046',
      message: `field target has type '${hTypeName(target.type)}', which has no fields`,
    });
    return;
  }
  if (fieldSlot(target.type, field) !== slot) {
    problems.push({
      kind,
      span: target.span,
      code: 'STA4046',
      message: `field '${field}' is not slot ${String(slot)} of ${target.type.name}`,
    });
  }
}

function checkIterable(iterable: Expression, problems: VerifyProblem[]): void {
  if (
    iterable.type.kind !== 'array' &&
    iterable.type.kind !== 'string' &&
    iterable.type.kind !== 'map' &&
    iterable.type.kind !== 'set' &&
    iterable.type.kind !== 'iterator' &&
    iterable.type.kind !== 'unknown'
  ) {
    problems.push({
      kind: 'for-of-statement',
      span: iterable.span,
      code: 'STA4045',
      message: `for-of iterable has type '${hTypeName(iterable.type)}', which is not an array, string, Map, Set or iterator`,
    });
  }
}

function verifyStatement(
  stmt: Statement,
  problems: VerifyProblem[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
  enclosing: readonly Enclosing[] = [],
): void {
  // Check statement has a type
  if (!stmt.type) {
    problems.push({
      kind: stmt.kind,
      span: stmt.span,
      code: 'STA4020',
      message: `${stmt.kind} node missing HType`,
    });
    return; // can't continue without a type
  }

  switch (stmt.kind) {
    case 'declaration': {
      const decl = stmt as Declaration;
      if (decl.value !== undefined) {
        verifyExpression(decl.value, problems, bindings);
      }
      // Register the binding for future reference
      bindings.set(decl.name, { kind: decl.declKind, type: decl.type });
      break;
    }

    case 'assignment': {
      const assign = stmt as Assignment;
      verifyExpression(assign.value, problems, bindings);

      // Check that the target is a known binding
      const binding = bindings.get(assign.target);
      if (!binding) {
        problems.push({
          kind: 'assignment',
          span: assign.span,
          code: 'STA4003',
          message: `identifier '${assign.target}' assigned before declaration`,
        });
        break;
      }

      // Check that the value is ASSIGNABLE to the target -- not equal to it, since a `Dog` is a
      // legal value for an `Animal` binding and its prefix layout is what makes that sound.
      // `hTypeAssignable` also lets Unknown through in both directions, which is the dynamic path:
      // a binding declared `string | number` promises nothing, and a value the HIR cannot describe
      // is a boxed value like every other.
      if (!hTypeAssignable(assign.value.type, binding.type)) {
        problems.push({
          kind: 'assignment',
          span: assign.span,
          code: 'STA4004',
          message: `assignment target type ${hTypeName(binding.type)} does not match value type ${hTypeName(assign.value.type)}`,
        });
      }
      break;
    }

    case 'expression-statement': {
      const exprStmt = stmt as ExpressionStatement;
      verifyExpression(exprStmt.expression, problems, bindings);
      break;
    }

    case 'if-statement': {
      const ifStmt = stmt as IfStatement;
      verifyExpression(ifStmt.condition, problems, bindings);

      // No type rule on the condition. `if (x)` applies ToBoolean, which is total: every value
      // is either truthy or falsy, so there is nothing here for the verifier to reject. The
      // former "condition must be boolean" check (STA4005, retired) was an artifact of the
      // walking skeleton testing the boxed value's low bit instead.

      // Create a new scope for the if block
      const thenBindings = new Map(bindings);
      verifyBlock(ifStmt.consequent, problems, thenBindings, enclosing);

      if (ifStmt.alternate) {
        const elseBindings = new Map(bindings);
        verifyBlock(ifStmt.alternate, problems, elseBindings, enclosing);
      }
      break;
    }

    // The three loops share every rule: ToBoolean on the condition (see the if-statement case,
    // STA4006 retired with STA4005), body verified in the enclosing scope, and the loop itself
    // pushed so `break`/`continue` inside it resolve.
    case 'while-statement':
    case 'do-while-statement':
    case 'for-statement': {
      const inner = [...enclosing, { isLoop: true, ...(stmt.label && { label: stmt.label }) }];
      if (stmt.kind === 'for-statement') {
        // The header's own statements are inside the loop for `break`/`continue` purposes only in
        // the update slot; an init that jumps would be nonsense. Both are verified with the outer
        // scope's bindings, which is also where `let i = 0` registers `i`.
        if (stmt.init) {
          verifyStatement(stmt.init, problems, bindings, enclosing);
        }
        if (stmt.condition) {
          verifyExpression(stmt.condition, problems, bindings);
        }
        if (stmt.update) {
          verifyStatement(stmt.update, problems, bindings, inner);
        }
      } else {
        verifyExpression(stmt.condition, problems, bindings);
      }
      verifyBlock(stmt.body, problems, bindings, inner);
      break;
    }

    case 'switch-statement': {
      verifyExpression(stmt.discriminant, problems, bindings);

      // A switch is breakable but not continuable, so `continue` inside one still targets the
      // enclosing loop. That is the whole reason `isLoop` exists.
      const inner = [...enclosing, { isLoop: false, ...(stmt.label && { label: stmt.label }) }];

      // One scope for the whole clause list, so its function declarations hoist across clauses
      // too -- `case 0: f();` is legal with `function f(){}` written under a later `default:`.
      for (const clause of stmt.clauses) {
        hoistFunctions(clause.statements, bindings);
      }

      let defaults = 0;
      for (const clause of stmt.clauses) {
        if (clause.test === undefined) {
          defaults++;
        } else {
          verifyExpression(clause.test, problems, bindings);
        }
        // Clauses share one scope: they are not blocks, and a `let` in one is visible in the next.
        for (const child of clause.statements) {
          verifyStatement(child, problems, bindings, inner);
        }
      }
      if (defaults > 1) {
        problems.push({
          kind: 'switch-statement',
          span: stmt.span,
          code: 'STA4040',
          message: `switch has ${defaults} default clauses; at most one is legal`,
        });
      }
      break;
    }

    case 'break-statement':
    case 'continue-statement': {
      // `continue` may only target a loop; `break` may target either. An unlabelled jump takes the
      // innermost candidate, which is why this scans from the end.
      const wantsLoop = stmt.kind === 'continue-statement';
      const target = [...enclosing]
        .reverse()
        .find(
          (e) =>
            e.isFunction !== true &&
            (wantsLoop ? e.isLoop : true) &&
            (stmt.label === undefined || e.label === stmt.label),
        );
      if (target === undefined) {
        const what = stmt.label === undefined ? 'an enclosing' : `a labelled '${stmt.label}'`;
        problems.push({
          kind: stmt.kind,
          span: stmt.span,
          code: 'STA4029',
          message: `${stmt.kind === 'break-statement' ? 'break' : 'continue'} has no ${what} ${wantsLoop ? 'loop' : 'loop, switch, or labelled block'} to jump out of`,
        });
      }
      break;
    }

    case 'block': {
      const block = stmt as Block;
      const inner =
        block.label !== undefined
          ? [...enclosing, { isLoop: false, label: block.label }]
          : enclosing;
      if (block.flatten === true) {
        for (const child of block.statements) {
          verifyStatement(child, problems, bindings, inner);
        }
      } else {
        verifyBlock(block, problems, bindings, inner);
      }
      break;
    }

    case 'function-declaration': {
      // The binding was registered by hoistFunctions before this statement was reached; setting
      // it again here would be the only way a declaration could shadow itself.
      verifyFunction(stmt.fn, problems, bindings);
      break;
    }

    // `a[i] = v`. The three subexpressions are verified in evaluation order -- target, index,
    // value -- which is the order the lowering promised and the emitter must preserve.
    case 'index-assignment': {
      verifyExpression(stmt.target, problems, bindings);
      verifyExpression(stmt.index, problems, bindings);
      verifyExpression(stmt.value, problems, bindings);
      checkIndexable(stmt.target, 'index-assignment', 'STA4044', problems);
      // No element-type rule. `a[i] = v` on a `number[]` with a `v: unknown` is the dynamic path
      // doing its job; the runtime stores whatever it is given, and narrowing is Task 3.5's.
      break;
    }

    // A for-of opens a scope holding exactly one binding, whose type is the iterable's ELEMENT
    // type -- TypeScript models iteration as yielding `T`, not `T | undefined`, because the loop
    // never runs past the end. That is why typed iteration stays on the static path while `a[i]`
    // does not (plan-notes 53).
    case 'for-of-statement': {
      verifyExpression(stmt.iterable, problems, bindings);
      checkIterable(stmt.iterable, problems);
      const inner = [...enclosing, { isLoop: true, ...(stmt.label && { label: stmt.label }) }];
      const scope = new Map(bindings);
      scope.set(stmt.binding, {
        kind: stmt.declKind,
        type: forOfElementType(stmt.iterable.type, stmt.view),
      });
      verifyBlock(stmt.body, problems, scope, inner);
      break;
    }

    case 'field-assignment': {
      verifyExpression(stmt.target, problems, bindings);
      verifyExpression(stmt.value, problems, bindings);
      checkField(stmt.target, stmt.field, stmt.slot, 'field-assignment', problems);
      // No field-type rule, for the same reason index-assignment has none: narrowing a written
      // value against the slot's declared type is Task 3.5's boundary check, not this pass's.
      break;
    }

    // A class declares no binding this pass can see: the class NAME is not a value in the subset
    // (the gate rejects using one), so what is left to verify is the member functions -- each of
    // which must actually receive the instance it will read fields out of.
    case 'class-declaration': {
      // Statics are ordinary bindings in the ENCLOSING scope, declared where the class declaration
      // sits. Registering them here rather than at a `declaration` statement is the only thing the
      // class node does that an ordinary declaration would not -- everything downstream then reads
      // and writes them as identifiers.
      // Registered in one pass and verified in another, for the reason function declarations are
      // hoisted: one static method may call another written below it.
      for (const decl of stmt.statics) {
        bindings.set(decl.name, { kind: decl.declKind, type: decl.type });
      }
      for (const decl of stmt.statics) {
        if (decl.value !== undefined) {
          verifyExpression(decl.value, problems, bindings);
        }
      }
      const members = [...(stmt.ctor === undefined ? [] : [stmt.ctor]), ...stmt.methods];
      for (const member of members) {
        const receiver = member.fn.params[0]?.type;
        if (receiver === undefined || receiver.kind !== 'object' || receiver.name !== stmt.name) {
          problems.push({
            kind: 'class-declaration',
            span: member.fn.span,
            code: 'STA4049',
            message: `${stmt.name}.${member.name} does not take ${stmt.name} as its receiver`,
          });
        }
        verifyFunction(member.fn, problems, bindings);
      }
      break;
    }

    case 'return-statement': {
      // `enclosing` is reset to a lone 'function' marker when a body is entered, so a `return`
      // that is lexically inside a loop but outside any function is still caught here.
      if (!enclosing.some((e) => e.isFunction === true)) {
        problems.push({
          kind: 'return-statement',
          span: stmt.span,
          code: 'STA4042',
          message: 'return statement outside a function',
        });
      }
      if (stmt.value !== undefined) {
        verifyExpression(stmt.value, problems, bindings);
      }
      break;
    }

    case 'super-call': {
      verifyExpression(stmt.receiver, problems, bindings);
      for (const arg of stmt.args) {
        verifyExpression(arg, problems, bindings);
      }
      // The receiver must be an instance of a class that actually descends from the class being
      // called, or the base constructor writes slots this object does not have. Reading the chain
      // rather than the name alone is what makes `super` safe once the chain is more than one deep.
      const self = stmt.receiver.type;
      if (self.kind !== 'object' || !self.bases.includes(stmt.className)) {
        problems.push({
          kind: 'super-call',
          span: stmt.span,
          code: 'STA4051',
          message: `super call to '${stmt.className}' from a receiver of type '${hTypeName(self)}'`,
        });
      }
      break;
    }

    case 'throw-statement': {
      // Any value may be thrown -- strings and numbers as much as objects -- so there is no type
      // rule here, only the ordinary check that the expression itself is well-formed.
      verifyExpression(stmt.value, problems, bindings);
      break;
    }

    case 'try-statement': {
      // `try {}` with neither handler nor cleanup is a JavaScript syntax error, so an HIR carrying
      // one was built by a bug, not lowered from source.
      if (stmt.catchBlock === undefined && stmt.finallyBlock === undefined) {
        problems.push({
          kind: 'try-statement',
          span: stmt.span,
          code: 'STA4057',
          message: 'try statement with neither catch nor finally',
        });
      }
      // A binding with no block to be visible in is equally unbuildable from source.
      if (stmt.catchBinding !== undefined && stmt.catchBlock === undefined) {
        problems.push({
          kind: 'try-statement',
          span: stmt.span,
          code: 'STA4057',
          message: 'catch binding without a catch block',
        });
      }
      verifyBlock(stmt.tryBlock, problems, bindings, enclosing);
      if (stmt.catchBlock !== undefined) {
        // The caught value is Unknown by construction: anything can be thrown. The binding is
        // const-like -- assigning to a catch variable is legal JavaScript, but the lowering
        // declares it `let` inside the block scope, so an assignment verifies normally.
        const scope = new Map(bindings);
        if (stmt.catchBinding !== undefined) {
          scope.set(stmt.catchBinding, { kind: 'let', type: hUnknown(false) });
        }
        verifyBlock(stmt.catchBlock, problems, scope, enclosing);
      }
      if (stmt.finallyBlock !== undefined) {
        verifyBlock(stmt.finallyBlock, problems, bindings, enclosing);
      }
      break;
    }

    // The dynamic half of Task 4.1: no slot to cross-check -- the offset is the shape table's
    // answer at runtime. What CAN be checked is the reason the node exists: a dynamic site whose
    // target the frontend actually typed would mean the lowering picked the slow path for a
    // receiver the fast path owns, which is a lowering bug, not a program property.
    case 'dyn-field-assignment': {
      verifyExpression(stmt.target, problems, bindings);
      verifyExpression(stmt.value, problems, bindings);
      if (stmt.target.type.kind !== 'unknown') {
        problems.push({
          kind: 'dyn-field-assignment',
          span: stmt.span,
          code: 'STA4059',
          message: `dynamic assignment to '${stmt.field}' on a target typed '${hTypeName(stmt.target.type)}'`,
        });
      }
      break;
    }

    default: {
      const _exhaustive: never = stmt;
      throw new Error(`Exhaustiveness check failed: ${_exhaustive}`);
    }
  }
}

function verifyBlock(
  block: Block,
  problems: VerifyProblem[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
  enclosing: readonly Enclosing[] = [],
): void {
  // Check block has a type
  if (!block.type) {
    problems.push({
      kind: 'block',
      span: block.span,
      code: 'STA4020',
      message: 'block node missing HType',
    });
  }

  // Create a new scope for this block
  const blockBindings = new Map(bindings);
  hoistFunctions(block.statements, blockBindings);
  for (const stmt of block.statements) {
    verifyStatement(stmt, problems, blockBindings, enclosing);
  }
}

/** A function body is a scope of its own, not a nested block of the caller's.
 *
 * Bindings are copied in rather than shared because rung 4a has no captures: what the copy
 * carries is the module-level bindings the gate already proved are the only outer names the body
 * can name. `enclosing` restarts at ['function'] so a `break` cannot escape into the enclosing
 * function's loop, and a `return` inside the body is recognised as in-function. */
function verifyFunction(
  fn: FunctionExpr,
  problems: VerifyProblem[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
): void {
  const inner = new Map(bindings);
  for (const param of fn.params) {
    inner.set(param.name, { kind: 'let', type: param.type });
    if (param.default !== undefined) {
      verifyExpression(param.default, problems, inner);
      if (!hTypeAssignable(param.default.type, param.type)) {
        problems.push({
          kind: 'function',
          span: param.span,
          code: 'STA4004',
          message: `default parameter type ${hTypeName(param.type)} does not match value type ${hTypeName(param.default.type)}`,
        });
      }
    }
  }
  verifyBlock(fn.body, problems, inner, [{ isLoop: false, isFunction: true }]);
}

function verifyExpression(
  expr: Expression,
  problems: VerifyProblem[],
  bindings: Map<string, { kind: 'let' | 'const'; type: HType }>,
): void {
  // Check expression has a type
  if (!expr.type) {
    problems.push({
      kind: expr.kind,
      span: expr.span,
      code: 'STA4020',
      message: `${expr.kind} expression missing HType`,
    });
    return; // can't continue without a type
  }
  // Monomorphization is what removes type parameters, and it removes them by never building one:
  // `typeAt` substitutes where a `ts.Type` becomes an HType. So one surviving here is not a missing
  // pass but a call that was never specialized -- and there is no C to emit for "whatever the
  // caller had", so this must stop the build rather than reach the emitter.
  if (hasTypeParam(expr.type)) {
    problems.push({
      kind: expr.kind,
      span: expr.span,
      code: 'STA4054',
      message: `${expr.kind} has the unsubstituted type '${hTypeName(expr.type)}'`,
    });
    return;
  }

  switch (expr.kind) {
    case 'number-literal': {
      // Number literal must have type number
      if (!hTypeEquals(expr.type, H_NUMBER)) {
        problems.push({
          kind: 'number-literal',
          span: expr.span,
          code: 'STA4007',
          message: `number-literal must have type 'number', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'string-literal': {
      // String literal must have type string
      if (expr.type.kind !== 'string') {
        problems.push({
          kind: 'string-literal',
          span: expr.span,
          code: 'STA4008',
          message: `string-literal must have type 'string', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'boolean-literal': {
      // Boolean literal must have type boolean
      if (!hTypeEquals(expr.type, H_BOOLEAN)) {
        problems.push({
          kind: 'boolean-literal',
          span: expr.span,
          code: 'STA4009',
          message: `boolean-literal must have type 'boolean', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'null-literal': {
      if (expr.type.kind !== 'null') {
        problems.push({
          kind: 'null-literal',
          span: expr.span,
          code: 'STA4022',
          message: `null-literal must have type 'null', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'undefined-literal': {
      if (expr.type.kind !== 'undefined') {
        problems.push({
          kind: 'undefined-literal',
          span: expr.span,
          code: 'STA4023',
          message: `undefined-literal must have type 'undefined', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'identifier': {
      const id = expr as Identifier;
      // Check that the identifier is in scope
      if (!bindings.has(id.name)) {
        problems.push({
          kind: 'identifier',
          span: id.span,
          code: 'STA4002',
          message: `identifier '${id.name}' is not defined`,
        });
      }
      // Otherwise, type should match the binding's type — this is verified by lowering,
      // but we can check it for assurance
      const binding = bindings.get(id.name);
      if (binding) {
        if (!hTypeEquals(expr.type, binding.type)) {
          problems.push({
            kind: 'identifier',
            span: id.span,
            code: 'STA4010',
            message: `identifier '${id.name}' has type '${hTypeName(binding.type)}' but is used as '${hTypeName(expr.type)}'`,
          });
        }
      }
      break;
    }

    case 'binary-op': {
      const binOp = expr as BinaryOp;
      verifyExpression(binOp.left, problems, bindings);
      verifyExpression(binOp.right, problems, bindings);

      const op = binOp.operator;

      // Arithmetic operators: - * / %
      // `+` is deliberately absent. It is the one operator here that is not arithmetic: given a
      // string operand it concatenates, so neither "operands are numbers" nor "the result is a
      // number" holds for it. `"a" + "b"` is well-formed IR of type string.
      if (op === '-' || op === '*' || op === '/' || op === '%' || op === '**') {
        // Operands must be number, or `unknown` -- a value whose type is not known until it exists.
        // The emitter wraps every arithmetic operand in `jsrt_to_number`, which is ToNumber, which
        // is defined on every value there is: an object converts through ToPrimitive, a string
        // through the StringNumericLiteral grammar, anything unparseable to NaN. So `unknown` here
        // is a well-formed dynamic operand, not a lowering that lost a type. What the rule still
        // catches is a KNOWN non-number -- a `string` operand means the lowering built `-` out of
        // something the frontend had already typed, which no source can produce.
        const arithmeticOperand = (t: HType): boolean =>
          hTypeEquals(t, H_NUMBER) || t.kind === 'unknown';
        if (!arithmeticOperand(binOp.left.type)) {
          problems.push({
            kind: 'binary-op',
            span: binOp.left.span,
            code: 'STA4011',
            message: `arithmetic operand must be number, got ${hTypeName(binOp.left.type)}`,
          });
        }
        if (!arithmeticOperand(binOp.right.type)) {
          problems.push({
            kind: 'binary-op',
            span: binOp.right.span,
            code: 'STA4012',
            message: `arithmetic operand must be number, got ${hTypeName(binOp.right.type)}`,
          });
        }
        // Result must be number
        if (!hTypeEquals(expr.type, H_NUMBER)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4013',
            message: `arithmetic operator result must be number, got ${hTypeName(expr.type)}`,
          });
        }
      }

      // Relational operators: < > <= >=
      if (op === '<' || op === '>' || op === '<=' || op === '>=') {
        // No operand rules. Abstract Relational Comparison accepts any two primitives and picks
        // its algorithm from what it finds: text order when both are strings, ToNumber otherwise.
        // `"10" < 9` is legal and false; `true < 2` is legal and true. The old rules that operands
        // must agree (STA4014) and be number-or-string (STA4015) are retired — they described the
        // Phase 2 fragment, not the language.

        // Result must be boolean
        if (!hTypeEquals(expr.type, H_BOOLEAN)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4016',
            message: `comparison result must be boolean, got ${hTypeName(expr.type)}`,
          });
        }
      }

      // Bitwise: & | ^ << >> >>>
      // Deliberately no operand check. ToInt32 accepts any primitive, and the useful constraint
      // is on the RESULT: it must be a plain number, because `>>>` can produce a value larger
      // than int32 holds and a pass that assumed otherwise would be wrong (docs/NUMERIC.md §4.2).
      if (op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>' || op === '>>>') {
        if (!hTypeEquals(expr.type, H_NUMBER)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4024',
            message: `bitwise operator result must be number, got '${hTypeName(expr.type)}'`,
          });
        }
      }

      // Equality: == != === !==
      // All four share one rule and no other. Operand types are NOT required to agree, for
      // either flavour: coercion across types is the whole purpose of `==`, and `null ===
      // undefined` is legal code that simply answers false. The old same-type rule (STA4017,
      // retired) rejected correct IR — a verifier rule has to be an invariant of the language,
      // not of the fragment that happened to exist when it was written.
      if (op === '==' || op === '!=' || op === '===' || op === '!==') {
        if (!hTypeEquals(expr.type, H_BOOLEAN)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4018',
            message: `equality result must be boolean, got ${hTypeName(expr.type)}`,
          });
        }
      }

      if (op === 'in') {
        if (!hTypeEquals(expr.type, H_BOOLEAN)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4018',
            message: `'in' result must be boolean, got ${hTypeName(expr.type)}`,
          });
        }
      }

      if (op === ',') {
        if (!hTypeEquals(expr.type, binOp.right.type)) {
          problems.push({
            kind: 'binary-op',
            span: expr.span,
            code: 'STA4013',
            message: `comma operator result must match the right operand, got ${hTypeName(expr.type)}`,
          });
        }
      }

      break;
    }

    case 'unary-op': {
      verifyExpression(expr.operand, problems, bindings);
      // No operand constraint: ToNumber and ToBoolean are total on primitives. The result type,
      // however, is fixed by the operator and nothing else.
      const wanted =
        expr.operator === '!' ? H_BOOLEAN : expr.operator === 'void' ? H_UNDEFINED : H_NUMBER;
      if (!hTypeEquals(expr.type, wanted)) {
        problems.push({
          kind: 'unary-op',
          span: expr.span,
          code: 'STA4025',
          message: `unary operator '${expr.operator}' result must be ${hTypeName(wanted)}, got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'typeof': {
      verifyExpression(expr.operand, problems, bindings);
      // No operand constraint, unlike every other prefix operator: `typeof` is total on values.
      // The result, however, is a string and can be nothing else -- an emitter that believed
      // otherwise would compare a boxed string against a number and always take the false branch.
      if (!hTypeEquals(expr.type, H_STRING)) {
        problems.push({
          kind: 'typeof',
          span: expr.span,
          code: 'STA4055',
          message: `typeof result must be string, got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'get-iterator':
      verifyExpression(expr.operand, problems, bindings);
      if (expr.type.kind !== 'iterator') {
        problems.push({
          kind: 'get-iterator',
          span: expr.span,
          code: 'STA4059',
          message: `get-iterator typed '${hTypeName(expr.type)}', not iterator`,
        });
      }
      break;
    case 'delete-prop': {
      verifyExpression(expr.target, problems, bindings);
      verifyExpression(expr.key, problems, bindings);
      // The operator answers whether the key is gone, and it answers for keys that were never
      // there -- so the result is a boolean under every receiver, and an emitter that believed
      // otherwise would box the answer into a slot nothing reads as one.
      if (!hTypeEquals(expr.type, H_BOOLEAN)) {
        problems.push({
          kind: 'delete-prop',
          span: expr.span,
          code: 'STA4097',
          message: `delete result must be boolean, got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'boundary-check': {
      verifyExpression(expr.value, problems, bindings);
      // A check exists to turn an Unknown into something concrete. Both halves of that are checked
      // here, because both are ways the lowering could have inserted a check that does nothing: a
      // check on an already-concrete value is a runtime cost with no soundness gain, and a check
      // whose RESULT is Unknown has not narrowed anything and leaves the consumer no better off.
      if (expr.value.type.kind !== 'unknown') {
        problems.push({
          kind: 'boundary-check',
          span: expr.span,
          code: 'STA4056',
          message: `boundary check on a value of type '${hTypeName(expr.value.type)}', which is already concrete`,
        });
      }
      if (expr.type.kind === 'unknown') {
        problems.push({
          kind: 'boundary-check',
          span: expr.span,
          code: 'STA4056',
          message: 'boundary check narrows to unknown, which checks nothing',
        });
      }
      break;
    }

    case 'template-literal': {
      for (const part of expr.expressions) {
        verifyExpression(part, problems, bindings);
      }
      // The literal chunks bracket the holes, so there is always exactly one more chunk than
      // hole. A violation means the lowering built the node wrong, and the emitter would drop or
      // duplicate text without noticing.
      if (expr.quasis.length !== expr.expressions.length + 1) {
        problems.push({
          kind: 'template-literal',
          span: expr.span,
          code: 'STA4026',
          message: `template literal has ${expr.quasis.length} literal chunks for ${expr.expressions.length} substitutions; expected ${expr.expressions.length + 1}`,
        });
      }
      if (!hTypeEquals(expr.type, H_STRING)) {
        problems.push({
          kind: 'template-literal',
          span: expr.span,
          code: 'STA4027',
          message: `template literal must have type 'string', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'string-length': {
      verifyExpression(expr.operand, problems, bindings);
      if (!hTypeEquals(expr.type, H_NUMBER)) {
        problems.push({
          kind: 'string-length',
          span: expr.span,
          code: 'STA4028',
          message: `string length must have type 'number', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'logical-op': {
      verifyExpression(expr.left, problems, bindings);
      verifyExpression(expr.right, problems, bindings);
      // No result-type rule. The value of `a && b` is one of the OPERANDS, so its type is their
      // union -- which the HType lattice represents as Unknown until unions land. Asserting
      // anything narrower here would reject correct IR.
      break;
    }

    case 'function': {
      verifyFunction(expr, problems, bindings);
      break;
    }

    case 'call': {
      verifyExpression(expr.callee, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      // Unknown is callable by construction: in js mode that is the whole point, and the check
      // happens at runtime. A concrete non-function callee is a lowering bug -- the checker would
      // have rejected the source before the gate ever saw it.
      if (expr.callee.type.kind !== 'fn' && expr.callee.type.kind !== 'unknown') {
        problems.push({
          kind: 'call',
          span: expr.span,
          code: 'STA4041',
          message: `callee has type '${hTypeName(expr.callee.type)}', which is not callable`,
        });
      }
      break;
    }

    case 'array-length': {
      verifyExpression(expr.operand, problems, bindings);
      if (!hTypeEquals(expr.type, H_NUMBER)) {
        problems.push({
          kind: 'array-length',
          span: expr.span,
          code: 'STA4043',
          message: `array length must have type 'number', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'array-literal': {
      for (const element of expr.elements) {
        verifyExpression(element, problems, bindings);
      }
      // No rule relating element types to `expr.type.element`. The literal's type came from the
      // checker, which already widened `[1, 2]` to `number[]` and `[1, 'a']` to Unknown; asserting
      // invariant equality here would reject IR the checker built correctly.
      break;
    }

    case 'index-access': {
      verifyExpression(expr.target, problems, bindings);
      verifyExpression(expr.index, problems, bindings);
      checkIndexable(expr.target, 'index-access', 'STA4044', problems);
      // No rule on `expr.type` either. It is `T | undefined` -- Unknown -- until Task 3.5 narrows
      // it, and pinning it to Unknown here would have to be undone by that same pass.
      break;
    }

    case 'console-log': {
      const call = expr as ConsoleLogCall;
      for (const arg of call.args) {
        verifyExpression(arg, problems, bindings);
      }
      // Every console node is a width the runtime has an entry point for: full arity, or the short
      // form of the two methods whose omitted tail is its own C function. The verifier restates
      // this rather than trusting the lowering's padding.
      if (consoleEntryPoint(call.method, call.args.length) === null) {
        const arity = CONSOLE_METHODS[call.method].arity;
        problems.push({
          kind: 'console-log',
          span: expr.span,
          code: 'STA4019',
          message: `console.${call.method} takes ${String(arity)} arguments, not ${String(call.args.length)}`,
        });
      } else if (expr.type.kind !== 'undefined') {
        // Every console method is void: it is called for its output, never for a value.
        problems.push({
          kind: 'console-log',
          span: expr.span,
          code: 'STA4019',
          message: `console.${call.method} must have type 'undefined', got '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'field-access': {
      verifyExpression(expr.target, problems, bindings);
      checkField(expr.target, expr.field, expr.slot, 'field-access', problems);
      break;
    }

    case 'method-call': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      // The class is named on the node so the emitter can call the method directly. That name is
      // the class DECLARING the method, which for an inherited method is an ancestor rather than
      // the receiver's own class -- so the test is ancestry, not equality. It must still be an
      // ancestry the receiver has, or the emitted call reads a body belonging to another class.
      if (
        expr.target.type.kind !== 'object' ||
        (expr.target.type.name !== expr.className &&
          !expr.target.type.bases.includes(expr.className))
      ) {
        problems.push({
          kind: 'method-call',
          span: expr.span,
          code: 'STA4047',
          message: `receiver has type '${hTypeName(expr.target.type)}', not ${expr.className}`,
        });
      } else if (methodOf(expr.target.type, expr.method) === undefined) {
        problems.push({
          kind: 'method-call',
          span: expr.span,
          code: 'STA4047',
          message: `${expr.className} has no method '${expr.method}'`,
        });
      } else if (
        expr.dispatch === 'virtual' &&
        expr.target.type.methods.findIndex((m) => m.name === expr.method) !== expr.slot
      ) {
        // The slot is what a virtual call INDEXES, and it is resolved against the receiver's
        // static type. Checking it against that type's own method list is the same check a field
        // slot gets, for the same reason: an index that does not match the layout it claims to
        // index is a wrong call, not a wrong type.
        problems.push({
          kind: 'method-call',
          span: expr.span,
          code: 'STA4047',
          message: `method '${expr.method}' is at slot ${String(expr.target.type.methods.findIndex((m) => m.name === expr.method))}, not ${String(expr.slot)}`,
        });
      }
      break;
    }

    case 'new': {
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      if (expr.type.kind !== 'object' || expr.type.name !== expr.className) {
        problems.push({
          kind: 'new',
          span: expr.span,
          code: 'STA4048',
          message: `new ${expr.className} has type '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'instanceof': {
      verifyExpression(expr.target, problems, bindings);
      // The target is deliberately unconstrained -- `1 instanceof C` is false, not an error -- so
      // the only thing to check is the one the emitter depends on: the answer is a boolean.
      if (!hTypeEquals(expr.type, H_BOOLEAN)) {
        problems.push({
          kind: 'instanceof',
          span: expr.span,
          code: 'STA4050',
          message: `instanceof ${expr.className} has type '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    // Every entry is a slot in the literal's own shape, in the order it was written. The check is
    // the one a field access gets, run once per entry at construction: an entry whose position is
    // not the slot its name occupies would build an object every later read misindexes.
    case 'object-literal': {
      for (const entry of expr.entries) {
        verifyExpression(entry.value, problems, bindings);
      }
      const shape = expr.type;
      if (shape.kind !== 'object') {
        problems.push({
          kind: 'object-literal',
          span: expr.span,
          code: 'STA4052',
          message: `object literal has type '${hTypeName(expr.type)}', not a shape`,
        });
        break;
      }
      // Entries are in EVALUATION order and the shape is the LAYOUT; the two need not agree, since
      // a reordering annotation or a spread supplies the layout (plan-notes 181). What must hold is
      // that every entry names a field of the shape and the literal covers the shape exactly --
      // that is the invariant the emitter's slot lookup and the shape's key order both rest on.
      const named = new Set(expr.entries.map((entry) => entry.name));
      for (const entry of expr.entries) {
        if (!shape.fields.some((field) => field.name === entry.name)) {
          problems.push({
            kind: 'object-literal',
            span: expr.span,
            code: 'STA4052',
            message: `entry '${entry.name}' names no field of shape '${hTypeName(shape)}'`,
          });
        }
      }
      for (const field of shape.fields) {
        if (!named.has(field.name)) {
          problems.push({
            kind: 'object-literal',
            span: expr.span,
            code: 'STA4052',
            message: `shape '${hTypeName(shape)}' has field '${field.name}', which the literal does not write`,
          });
        }
      }
      break;
    }

    // See the dyn-field-assignment case for what these check and why there is no slot to verify.
    case 'dyn-object-literal': {
      for (const entry of expr.entries) {
        if (isAccessorEntry(entry)) {
          // Not two halves of nothing: a pair with neither half is a key the emitter would install
          // as an accessor that can be neither read nor written, which no source can spell.
          if (entry.get === undefined && entry.set === undefined) {
            problems.push({
              kind: 'dyn-object-literal',
              span: expr.span,
              code: 'STA4059',
              message: `accessor '${entry.name}' has neither a getter nor a setter`,
            });
          }
          if (entry.get !== undefined) {
            verifyExpression(entry.get, problems, bindings);
          }
          if (entry.set !== undefined) {
            verifyExpression(entry.set, problems, bindings);
          }
          continue;
        }
        verifyExpression(entry.value, problems, bindings);
      }
      if (expr.type.kind !== 'unknown') {
        problems.push({
          kind: 'dyn-object-literal',
          span: expr.span,
          code: 'STA4059',
          message: `dynamic object literal has type '${hTypeName(expr.type)}', not Unknown`,
        });
      }
      break;
    }

    case 'dyn-field-access': {
      verifyExpression(expr.target, problems, bindings);
      if (expr.target.type.kind !== 'unknown' || expr.type.kind !== 'unknown') {
        problems.push({
          kind: 'dyn-field-access',
          span: expr.span,
          code: 'STA4059',
          message: `dynamic read of '${expr.field}' with target '${hTypeName(expr.target.type)}' and result '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    case 'collection-new': {
      if (expr.type.kind !== expr.collection) {
        problems.push({
          kind: 'collection-new',
          span: expr.span,
          code: 'STA4053',
          message: `new ${expr.collection} has type '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    // The emitter turns each operation into ONE runtime function with a fixed C signature, so both
    // halves below are load-bearing rather than tidiness: an `add` on a Map would call an allocator
    // that reads a value argument that is not there, and a wrong argument count is a call with a
    // missing parameter -- neither of which the C compiler can catch, because every argument has
    // the same type.
    case 'collection-op': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const arity = COLLECTION_ARITY[expr.collection][expr.op];
      if (expr.target.type.kind !== expr.collection) {
        problems.push({
          kind: 'collection-op',
          span: expr.span,
          code: 'STA4053',
          message: `${expr.op} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      } else if (arity === undefined) {
        problems.push({
          kind: 'collection-op',
          span: expr.span,
          code: 'STA4053',
          message: `'${expr.op}' is not an operation of a ${expr.collection}`,
        });
      } else if (expr.args.length !== arity) {
        problems.push({
          kind: 'collection-op',
          span: expr.span,
          code: 'STA4053',
          message: `${expr.op} takes ${String(arity)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (isSetOperation(expr.op)) {
        // The one collection operation family whose ARGUMENT has a kind: the runtime reads it as a
        // JSRTMap, so anything else here is memory corruption rather than a wrong answer, and no
        // arity count would catch it. The result is pinned for the same reason it is worth pinning
        // anywhere -- a predicate that typed as a Set would flow into a `.has` the C never checks.
        const argument = expr.args[0];
        const answers = SET_OPS[expr.op];
        if (argument === undefined || argument.type.kind !== 'set') {
          problems.push({
            kind: 'collection-op',
            span: expr.span,
            code: 'STA4053',
            message: `${expr.op} takes a Set, not '${argument === undefined ? 'nothing' : hTypeName(argument.type)}'`,
          });
        } else if (expr.type.kind !== answers) {
          problems.push({
            kind: 'collection-op',
            span: expr.span,
            code: 'STA4053',
            message: `${expr.op} answers a ${answers}, not '${hTypeName(expr.type)}'`,
          });
        }
      }
      break;
    }

    // Number in, number out, exact arity — the three claims the C signatures rest on, and none of
    // which the C compiler can check across `jsrt_value`. First code of the verifier's third band.
    case 'math-call': {
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const arity = MATH_ARITY[expr.method];
      if (arity === undefined || expr.args.length !== arity) {
        problems.push({
          kind: 'math-call',
          span: expr.span,
          code: 'STA4080',
          message: `Math.${expr.method} takes ${String(arity ?? NaN)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (expr.type.kind !== 'number') {
        problems.push({
          kind: 'math-call',
          span: expr.span,
          code: 'STA4080',
          message: `Math.${expr.method} must return number, got ${hTypeName(expr.type)}`,
        });
      }
      break;
    }

    // The receiver is a string, the arity is the table's (the lowering PADDED optional arguments,
    // so a short count is a lowering bug), and the result type is the op's. Argument types are
    // deliberately unchecked: a padded slot is undefined where the source position was a number
    // or a string, and the checker already vetted what the source wrote.
    case 'string-op': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const shape = STRING_OPS[expr.op];
      // `element` is unchecked, the array-op rule: the honest answer is Unknown.
      const want: HType | undefined =
        shape.result === 'element' || shape.result === 'match' || shape.result === 'iterator'
          ? undefined
          : shape.result === 'string-array'
            ? { kind: 'array', element: H_STRING }
            : shape.result === 'number'
              ? H_NUMBER
              : shape.result === 'boolean'
                ? H_BOOLEAN
                : H_STRING;
      if (expr.target.type.kind !== 'string') {
        problems.push({
          kind: 'string-op',
          span: expr.span,
          code: 'STA4081',
          message: `${expr.op} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      } else if (expr.args.length !== shape.arity) {
        problems.push({
          kind: 'string-op',
          span: expr.span,
          code: 'STA4081',
          message: `${expr.op} takes ${String(shape.arity)} arguments after padding, not ${String(expr.args.length)}`,
        });
      } else if (want !== undefined && !hTypeEquals(expr.type, want)) {
        problems.push({
          kind: 'string-op',
          span: expr.span,
          code: 'STA4081',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not '${hTypeName(want)}'`,
        });
      } else if (shape.result === 'iterator' && expr.type.kind !== 'iterator') {
        problems.push({
          kind: 'string-op',
          span: expr.span,
          code: 'STA4081',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not an iterator`,
        });
      }
      break;
    }

    // The array counterpart of the case above (STA4082): array receiver, the table's exact
    // post-padding arity, and the table's result type — where `self` is the RECEIVER's own array
    // type (slice/concat/fill/reverse) and `element` is Unknown by the IndexAccess rule, so only
    // the three concrete kinds are pinned. Argument types stay unchecked for the same reason.
    case 'array-op': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const shape = ARRAY_OPS[expr.op];
      if (expr.target.type.kind !== 'array') {
        problems.push({
          kind: 'array-op',
          span: expr.span,
          code: 'STA4082',
          message: `${expr.op} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
        break;
      }
      const want: HType | undefined =
        shape.result === 'self'
          ? expr.target.type
          : shape.result === 'undefined'
            ? H_UNDEFINED
            : shape.result === 'number'
              ? H_NUMBER
              : shape.result === 'boolean'
                ? H_BOOLEAN
                : shape.result === 'string'
                  ? H_STRING
                  : undefined;
      if (expr.args.length !== shape.arity) {
        problems.push({
          kind: 'array-op',
          span: expr.span,
          code: 'STA4082',
          message: `${expr.op} takes ${String(shape.arity)} arguments after padding, not ${String(expr.args.length)}`,
        });
      } else if (want !== undefined && !hTypeEquals(expr.type, want)) {
        problems.push({
          kind: 'array-op',
          span: expr.span,
          code: 'STA4082',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not '${hTypeName(want)}'`,
        });
      } else if (shape.result === 'iterator' && expr.type.kind !== 'iterator') {
        problems.push({
          kind: 'array-op',
          span: expr.span,
          code: 'STA4082',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not an iterator`,
        });
      } else if (shape.result === 'mapped' && expr.type.kind !== 'array') {
        // Only the KIND is pinned: the element is the checker's answer (map) or a possibly
        // narrowed one (filter), the same latitude Object.values gets under STA4083.
        problems.push({
          kind: 'array-op',
          span: expr.span,
          code: 'STA4082',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not an array`,
        });
      }
      break;
    }

    // One argument, and a result that is an ARRAY: `keys` exactly `string[]`, `values`/`entries`
    // any array (their element follows the checker's answer, which may be Unknown for a mixed
    // shape). The argument's own type is deliberately unchecked — the gate restricted it to the
    // object layouts, and a fixed shape, a dynamic shape, and an Unknown-typed dynamic read all
    // spell differently here.
    case 'object-static': {
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const shape = OBJECT_STATIC_SHAPES[expr.method];
      const want = objectStaticWant(shape.result);
      if (expr.args.length !== shape.arity) {
        problems.push({
          kind: 'object-static',
          span: expr.span,
          code: 'STA4083',
          message: `Object.${expr.method} takes ${String(shape.arity)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (want !== undefined && !hTypeEquals(expr.type, want)) {
        problems.push({
          kind: 'object-static',
          span: expr.span,
          code: 'STA4083',
          message: `Object.${expr.method} results in '${hTypeName(expr.type)}', not '${hTypeName(want)}'`,
        });
      } else if (shape.result === 'array' && expr.type.kind !== 'array') {
        problems.push({
          kind: 'object-static',
          span: expr.span,
          code: 'STA4083',
          message: `Object.${expr.method} results in '${hTypeName(expr.type)}', not an array`,
        });
      }
      break;
    }

    // JSON.parse answers data: nothing about the result is pinned (the lowering types it
    // Unknown, and a pass that narrowed it to something real must be allowed to say so), and the
    // argument is a string the gate already checked.
    case 'json-parse': {
      verifyExpression(expr.arg, problems, bindings);
      break;
    }

    // JSON.stringify is pinned `string` by the lowering; anything else is a lowering bug. The
    // argument itself is unchecked -- any serializable value is legal, and the two values that
    // are not (undefined, a function) were refused by the gate at the top level and abort loudly
    // at run time when an Unknown smuggles one in deeper.
    case 'json-stringify': {
      verifyExpression(expr.arg, problems, bindings);
      if (!hTypeEquals(expr.type, H_STRING)) {
        problems.push({
          kind: 'json-stringify',
          span: expr.span,
          code: 'STA4085',
          message: `JSON.stringify results in '${hTypeName(expr.type)}', not a string`,
        });
      }
      break;
    }

    // A leaf whose only claim is its own kind: the pattern text is never read above the C
    // boundary (see RegExpLiteral), so there is nothing else here that could be wrong.
    case 'regexp-literal': {
      if (expr.type.kind !== 'regexp') {
        problems.push({
          kind: 'regexp-literal',
          span: expr.span,
          code: 'STA4086',
          message: `a regular-expression literal has type '${hTypeName(expr.type)}'`,
        });
      }
      break;
    }

    // `re.test(s)` is one runtime function with a fixed C signature, and its RECEIVER is a
    // JSRTRegExp the bridge dereferences without asking -- so a wrong kind here is memory
    // corruption rather than a wrong answer, which is why it is pinned where a string op's
    // receiver is. The ARGUMENT is deliberately unchecked, for STA4081's reason: an untyped value
    // is the js-mode norm, and the runtime's tag check is the honest place to settle it.
    case 'regexp-op': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      if (expr.target.type.kind !== 'regexp') {
        problems.push({
          kind: 'regexp-op',
          span: expr.span,
          code: 'STA4086',
          message: `${expr.op} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      } else if (expr.args.length !== REGEXP_OPS[expr.op].arity) {
        problems.push({
          kind: 'regexp-op',
          span: expr.span,
          code: 'STA4086',
          message: `${expr.op} takes ${String(REGEXP_OPS[expr.op].arity)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (REGEXP_OPS[expr.op].result === 'boolean' && !hTypeEquals(expr.type, H_BOOLEAN)) {
        problems.push({
          kind: 'regexp-op',
          span: expr.span,
          code: 'STA4086',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not a boolean`,
        });
      } else if (REGEXP_OPS[expr.op].result === 'string' && !hTypeEquals(expr.type, H_STRING)) {
        problems.push({
          kind: 'regexp-op',
          span: expr.span,
          code: 'STA4086',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not a string`,
        });
      } else if (REGEXP_OPS[expr.op].result === 'match' && expr.type.kind !== 'unknown') {
        // `exec` answers a match array OR null, and the HIR has no union: Unknown is the honest
        // type, and a node claiming `array` here would be a match the compiler has not made.
        problems.push({
          kind: 'regexp-op',
          span: expr.span,
          code: 'STA4086',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not the unknown a match-or-null is`,
        });
      }
      break;
    }

    // `new Date(x)`. The ARGUMENT is deliberately unchecked -- `jsrt_date_from_value` discriminates
    // number/string/Date by tag and answers an Invalid Date for anything else, which is what the
    // spec's ToPrimitive-then-ToNumber path amounts to. The RESULT is pinned: every consumer below
    // here (a `date-op` receiver, `inspect_date`) dereferences a JSRTDate without asking.
    case 'date-new': {
      verifyExpression(expr.arg, problems, bindings);
      if (expr.type.kind !== 'date') {
        problems.push({
          kind: 'date-new',
          span: expr.span,
          code: 'STA4092',
          message: `new Date results in '${hTypeName(expr.type)}', not a Date`,
        });
      }
      break;
    }

    // `new TypeError(x)`. The LAYOUT is what is pinned, not just the kind: `jsrt_error_new` writes
    // slot 0 and slot 1 by index, and every `e.message` read downstream resolves against the same
    // two fields, so a type that disagreed with jsrt_error.c would be a wrong slot rather than a
    // wrong answer. Comparing against errorHType checks the name, the field order and the base
    // chain in one place, which is the only place the two definitions can drift.
    case 'error-new': {
      verifyExpression(expr.arg, problems, bindings);
      if (!hTypeEquals(expr.type, errorHType(expr.ctor))) {
        problems.push({
          kind: 'error-new',
          span: expr.span,
          code: 'STA4095',
          message: `new ${expr.ctor} results in '${hTypeName(expr.type)}', not the ${expr.ctor} layout`,
        });
      }
      break;
    }

    // A `Date.prototype` call, pinned where a regexp op's receiver is and for the same reason: the
    // C accessors read a `JSRTDate` without a tag test, so a wrong receiver kind here is memory
    // corruption rather than a wrong answer. Arity is EXACT because the lowering pads omitted
    // trailing components to the table's full count -- a short list is a lowering bug, never a
    // source property.
    case 'date-op': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      const want = DATE_OPS[expr.op];
      if (expr.target.type.kind !== 'date') {
        problems.push({
          kind: 'date-op',
          span: expr.span,
          code: 'STA4092',
          message: `${expr.op} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      } else if (expr.args.length !== want.arity) {
        problems.push({
          kind: 'date-op',
          span: expr.span,
          code: 'STA4092',
          message: `${expr.op} takes ${String(want.arity)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (!hTypeEquals(expr.type, want.result === 'number' ? H_NUMBER : H_STRING)) {
        problems.push({
          kind: 'date-op',
          span: expr.span,
          code: 'STA4092',
          message: `${expr.op} results in '${hTypeName(expr.type)}', not a ${want.result}`,
        });
      }
      break;
    }

    // `new Date(y, m, ...)`. The component list is EXACTLY seven -- the lowering pads omitted
    // trailing components with `undefined`, which the runtime reads as the spec's defaults, so a
    // short list here is a lowering bug rather than a source property. The result is pinned for
    // `date-new`'s reason: consumers dereference a JSRTDate without a tag test.
    case 'date-components': {
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      if (expr.args.length !== 7) {
        problems.push({
          kind: 'date-components',
          span: expr.span,
          code: 'STA4092',
          message: `new Date takes 7 components, not ${String(expr.args.length)}`,
        });
      } else if (expr.type.kind !== 'date') {
        problems.push({
          kind: 'date-components',
          span: expr.span,
          code: 'STA4092',
          message: `new Date results in '${hTypeName(expr.type)}', not a Date`,
        });
      }
      break;
    }

    // `Date.UTC(...)` / `Date.parse(s)`: both answer a time value, so the result is pinned to
    // number. `parse`'s argument is unchecked for STA4081's reason -- an untyped string is the
    // js-mode norm and the runtime's tag check is the honest place to settle it.
    case 'date-static': {
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      if (expr.args.length !== DATE_STATICS[expr.method].arity) {
        problems.push({
          kind: 'date-static',
          span: expr.span,
          code: 'STA4092',
          message: `Date.${expr.method} takes ${String(DATE_STATICS[expr.method].arity)} arguments, not ${String(expr.args.length)}`,
        });
      } else if (!hTypeEquals(expr.type, H_NUMBER)) {
        problems.push({
          kind: 'date-static',
          span: expr.span,
          code: 'STA4092',
          message: `Date.${expr.method} results in '${hTypeName(expr.type)}', not a number`,
        });
      }
      break;
    }

    // `await e`. The one claim that holds for every operand: awaiting a PROMISE produces its
    // value type. Awaiting anything else is legal (`await 1` is a spec-sanctioned no-op that
    // still yields to the microtask queue), and its result type is the operand's own, so
    // nothing is pinned there -- peeling would get exactly that case wrong.
    case 'yield': {
      verifyExpression(expr.value, problems, bindings);
      break;
    }

    case 'await': {
      verifyExpression(expr.value, problems, bindings);
      if (expr.value.type.kind === 'promise' && !hTypeEquals(expr.type, expr.value.type.value)) {
        problems.push({
          kind: 'await',
          span: expr.span,
          code: 'STA4087',
          message: `await of '${hTypeName(expr.value.type)}' results in '${hTypeName(expr.type)}', not '${hTypeName(expr.value.type.value)}'`,
        });
      }
      break;
    }

    // The Promise statics. All three answer a promise -- `jsrt_promise_resolve` and its siblings
    // return one unconditionally -- and `Promise.all` reads its argument as an array without
    // asking, which is a wrong dereference rather than a wrong answer if the type is not one.
    // An Unknown argument is admitted: js mode's untyped array is the norm, and the runtime's
    // own tag check is the honest place to settle it.
    case 'promise-static': {
      verifyExpression(expr.arg, problems, bindings);
      if (expr.type.kind !== 'promise') {
        problems.push({
          kind: 'promise-static',
          span: expr.span,
          code: 'STA4088',
          message: `Promise.${expr.method} results in '${hTypeName(expr.type)}', not a promise`,
        });
      } else if (
        expr.method === 'all' &&
        expr.arg.type.kind !== 'array' &&
        expr.arg.type.kind !== 'unknown'
      ) {
        problems.push({
          kind: 'promise-static',
          span: expr.span,
          code: 'STA4088',
          message: `Promise.${expr.method} takes an array, not '${hTypeName(expr.arg.type)}'`,
        });
      }
      break;
    }

    case 'promise-method': {
      verifyExpression(expr.target, problems, bindings);
      for (const arg of expr.args) {
        verifyExpression(arg, problems, bindings);
      }
      if (expr.target.type.kind !== 'promise' && expr.target.type.kind !== 'unknown') {
        problems.push({
          kind: 'promise-method',
          span: expr.span,
          code: 'STA4094',
          message: `Promise.prototype.${expr.method} on '${hTypeName(expr.target.type)}', not a promise`,
        });
      } else if (expr.type.kind !== 'promise') {
        problems.push({
          kind: 'promise-method',
          span: expr.span,
          code: 'STA4094',
          message: `Promise.prototype.${expr.method} results in '${hTypeName(expr.type)}', not a promise`,
        });
      }
      break;
    }

    case 'promise-construct': {
      verifyExpression(expr.executor, problems, bindings);
      if (expr.type.kind !== 'promise') {
        problems.push({
          kind: 'promise-construct',
          span: expr.span,
          code: 'STA4094',
          message: `new Promise results in '${hTypeName(expr.type)}', not a promise`,
        });
      }
      break;
    }

    // A match read's receiver is Unknown by construction, and the FIELD is what fixes the result
    // type -- the StringOp rule with a one-entry table per field. A wrong receiver is settled by
    // the runtime (jsrt_get_prop panics on a tag it cannot walk), never silently misread.
    case 'match-read': {
      verifyExpression(expr.target, problems, bindings);
      const want = MATCH_FIELDS[expr.field];
      if (expr.target.type.kind !== 'unknown') {
        problems.push({
          kind: 'match-read',
          span: expr.span,
          code: 'STA4089',
          message: `${expr.field} on a receiver of type '${hTypeName(expr.target.type)}', not the unknown a match-or-null is`,
        });
      } else if (expr.type.kind !== want) {
        problems.push({
          kind: 'match-read',
          span: expr.span,
          code: 'STA4089',
          message: `${expr.field} results in '${hTypeName(expr.type)}', not '${want}'`,
        });
      }
      break;
    }

    // The mirror of `match-read`, with the receiver pinned the other way: a regexp IS concretely
    // typed, and the C accessors dereference a `JSRTRegExp` without asking -- so a wrong kind here
    // is memory corruption rather than a wrong answer, exactly as it is for a `regexp-op`.
    case 'regexp-read': {
      verifyExpression(expr.target, problems, bindings);
      const want = REGEXP_FIELDS[expr.field].result;
      if (expr.target.type.kind !== 'regexp') {
        problems.push({
          kind: 'regexp-read',
          span: expr.span,
          code: 'STA4090',
          message: `${expr.field} on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      } else if (expr.type.kind !== want) {
        problems.push({
          kind: 'regexp-read',
          span: expr.span,
          code: 'STA4090',
          message: `${expr.field} results in '${hTypeName(expr.type)}', not '${want}'`,
        });
      }
      break;
    }

    case 'iterator-next': {
      verifyExpression(expr.target, problems, bindings);
      verifyExpression(expr.sent, problems, bindings);
      if (expr.target.type.kind !== 'iterator') {
        problems.push({
          kind: 'iterator-next',
          span: expr.span,
          code: 'STA4045',
          message: `${expr.op}() on a receiver of type '${hTypeName(expr.target.type)}'`,
        });
      }
      break;
    }

    case 'conditional': {
      verifyExpression(expr.condition, problems, bindings);
      verifyExpression(expr.consequent, problems, bindings);
      verifyExpression(expr.alternate, problems, bindings);
      break;
    }

    case 'update': {
      verifyExpression(expr.target, problems, bindings);
      if (expr.value !== undefined) {
        verifyExpression(expr.value, problems, bindings);
      }
      if ((expr.operator === '++' || expr.operator === '--') && !hTypeEquals(expr.type, H_NUMBER)) {
        problems.push({
          kind: 'update',
          span: expr.span,
          code: 'STA4013',
          message: `update result must be number, got ${hTypeName(expr.type)}`,
        });
      }
      break;
    }

    // Unknown is not a default here, it is the contract. The node stands where a value of an
    // unknowable type would have been, and every consumer downstream -- boundary insertion above
    // all -- reads that type to decide whether a check is owed. Typing it `undefined` (the C value
    // the emitter returns) would let `const n: number = undeclared` through as a static assignment
    // of the wrong type instead of a boundary, which is the bug this pins shut.
    case 'reference-error': {
      if (expr.type.kind !== 'unknown') {
        problems.push({
          kind: 'reference-error',
          span: expr.span,
          code: 'STA4096',
          message: `reference-error must have type 'unknown', got '${hTypeName(expr.type)}'`,
        });
      }
      if (expr.name === '') {
        problems.push({
          kind: 'reference-error',
          span: expr.span,
          code: 'STA4096',
          message: 'reference-error must carry the name it failed to resolve',
        });
      }
      break;
    }

    default: {
      const _exhaustive: never = expr;
      throw new Error(`Exhaustiveness check failed: ${_exhaustive}`);
    }
  }
}

/** Which operations each collection answers, and with how many arguments. The emitter's C
 * signatures are the reason this is checked at all -- see the `collection-op` case. */
const COLLECTION_ARITY: Readonly<Record<'map' | 'set', Readonly<Record<string, number>>>> = {
  map: {
    get: 1,
    set: 2,
    has: 1,
    delete: 1,
    clear: 0,
    size: 0,
    forEach: 1,
    keys: 0,
    values: 0,
    entries: 0,
  },
  set: {
    add: 1,
    has: 1,
    delete: 1,
    clear: 0,
    size: 0,
    forEach: 1,
    keys: 0,
    values: 0,
    entries: 0,
    union: 1,
    intersection: 1,
    difference: 1,
    symmetricDifference: 1,
    isSubsetOf: 1,
    isSupersetOf: 1,
    isDisjointFrom: 1,
  },
};

/** Post-lowering arity is EXACT: the lowering folded variadic min/max into nested binary nodes,
 * so a wrong count here is a lowering bug, never a source property. */
/** What each `Object` namespace call takes and answers. `arity` is the count the gate already
 * enforced, restated here because the verifier trusts no earlier stage. The result kinds mirror
 * the collection tables': `strings` pins `string[]`, `boolean` pins a boolean, `array` pins only
 * "some array" (the element follows the checker, which may be Unknown for a mixed shape), and
 * `unknown` pins nothing -- `fromEntries` builds a dynamic shape, which every read must check. */
const OBJECT_STATIC_SHAPES = {
  assign: { arity: 2, result: 'unknown' },
  entries: { arity: 1, result: 'array' },
  freeze: { arity: 1, result: 'unknown' },
  fromEntries: { arity: 1, result: 'unknown' },
  getOwnPropertyNames: { arity: 1, result: 'strings' },
  hasOwn: { arity: 2, result: 'boolean' },
  isFrozen: { arity: 1, result: 'boolean' },
  keys: { arity: 1, result: 'strings' },
  values: { arity: 1, result: 'array' },
} as const satisfies Record<
  ObjectStaticMethod,
  { readonly arity: number; readonly result: 'array' | 'boolean' | 'strings' | 'unknown' }
>;

/** The type a result kind pins, or `undefined` where it pins nothing checkable here. */
function objectStaticWant(result: 'array' | 'boolean' | 'strings' | 'unknown'): HType | undefined {
  if (result === 'strings') {
    return { kind: 'array', element: H_STRING };
  }
  return result === 'boolean' ? H_BOOLEAN : undefined;
}

const MATH_ARITY: Readonly<Record<string, number>> = {
  abs: 1,
  acos: 1,
  acosh: 1,
  asin: 1,
  asinh: 1,
  atan: 1,
  atanh: 1,
  cbrt: 1,
  clz32: 1,
  cos: 1,
  cosh: 1,
  exp: 1,
  expm1: 1,
  fround: 1,
  log: 1,
  log10: 1,
  log1p: 1,
  log2: 1,
  sin: 1,
  sinh: 1,
  tan: 1,
  tanh: 1,
  ceil: 1,
  floor: 1,
  round: 1,
  sign: 1,
  sqrt: 1,
  trunc: 1,
  atan2: 2,
  hypot: 2,
  pow: 2,
  imul: 2,
  min: 2,
  max: 2,
  // Nondeterministic and nullary — the one Math node with no operand to type-check.
  random: 0,
};
