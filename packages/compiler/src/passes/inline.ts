/* Inlining (plan.md §5 Tasks 3.8–3.9) — replace a call to a small, non-recursive function with the
 * expression it returns.
 *
 * The HIR has no block-expression, so a general inliner would have to restructure statements:
 * temporaries for the arguments, a result binding, and every `return` in the body rewritten to an
 * assignment plus a jump. That machinery is worth building against a measurement, and there is none
 * yet (§13). What is built here is the case that needs none of it — a body that is exactly one
 * `return <expr>`, which substitutes into the call's own position.
 *
 * Four conditions, each closing one way substitution can change meaning:
 *
 *  1. **The body is a single `return <expr>`.** No statements to place, and no assignment to a
 *     parameter, so substituting an argument for a parameter name cannot be observed as aliasing.
 *  2. **The body names nothing but its own parameters.** This is the condition that does the most
 *     work. It makes recursion impossible by construction — a recursive body must name itself —
 *     and it closes the capture hazard that has nothing to do with closures: a body reading a
 *     module-level `g` moved into a caller that has its OWN `g` would silently start reading the
 *     caller's. There is no scope information in the HIR to rule that out, so the pass declines to
 *     move any free name at all.
 *  3. **Every argument is a literal or an identifier.** A parameter used twice duplicates its
 *     argument, and one used zero times drops it — both fine for a value that cannot have a side
 *     effect, both wrong for a call. This also makes evaluation ORDER a non-question, which
 *     matters because substitution reorders arguments relative to the body's own operations.
 *  4. **Types agree exactly** — argument to parameter, and the returned expression to the call.
 *     `Unknown` preservation is this condition: a `js`-mode call whose argument is a `number` but
 *     whose parameter is `Unknown` does NOT inline, because splicing the argument in would quietly
 *     replace an unknown-typed subtree with a typed one and cancel the boundary check that
 *     unknown-ness exists to require.
 *
 * Arity must match too. JavaScript pads missing arguments with `undefined` and drops extra ones,
 * and while the `ts`-mode checker has already rejected a mismatch, `js` mode reaches this pass as
 * well — so the agreement is checked rather than assumed.
 */

import type {
  Block,
  Expression,
  FunctionDeclaration,
  FunctionExpr,
  Module,
  ReturnStatement,
} from '../hir/nodes.ts';
import { H_UNDEFINED, hTypeEquals } from '../hir/types.ts';
import { rewriteExpression, rewriteModule, rewriteStatements } from './rewrite.ts';

export function inlineCalls(module: Module): Module {
  const bindings = bindingCounts(module);
  const candidates = new Map<string, Candidate>();
  for (const stmt of module.statements) {
    // A name bound more than once in the module is bound somewhere other than here, and the second
    // binding may be the one a given call site sees. The HIR resolves identifiers by name alone, so
    // there is no way to tell a call of THIS `f` from a call of a local `f` that shadows it —
    // and inlining the wrong one is not a missed optimization, it is a wrong program.
    if (stmt.kind === 'function-declaration' && (bindings.get(stmt.name) ?? 0) === 1) {
      const candidate = candidateOf(stmt);
      if (candidate !== null) {
        candidates.set(stmt.name, candidate);
      }
    }
  }
  return candidates.size === 0
    ? module
    : rewriteModule(module, { expression: (expr) => inlineCall(expr, candidates) });
}

/** How many times each name is BOUND anywhere in the module — declarations, parameters, loop
 * bindings, classes and nested functions. A module-level function declaration contributes its own
 * one, so a count above one is exactly "this name is also bound elsewhere". */
function bindingCounts(module: Module): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const bind = (name: string): void => void counts.set(name, (counts.get(name) ?? 0) + 1);
  const bindParams = (fn: FunctionExpr): void => {
    for (const param of fn.params) {
      bind(param.name);
    }
  };
  rewriteModule(module, {
    expression: (expr) => {
      if (expr.kind === 'function') {
        bindParams(expr);
      }
      return expr;
    },
    statement: (stmt) => {
      switch (stmt.kind) {
        case 'declaration':
          bind(stmt.name);
          break;
        case 'for-of-statement':
          bind(stmt.binding);
          break;
        case 'function-declaration':
          bind(stmt.name);
          break;
        case 'class-declaration':
          bind(stmt.name);
          // A method's parameters are bound too, and its FunctionExpr is not an expression the
          // walk above reaches — a method hangs off the class, not off an expression slot.
          for (const method of [...stmt.methods, ...(stmt.ctor === undefined ? [] : [stmt.ctor])]) {
            bindParams(method.fn);
          }
          break;
        default:
          break;
      }
      return [stmt];
    },
  });
  return counts;
}

interface Candidate {
  readonly params: readonly { readonly name: string; readonly type: Expression['type'] }[];
  readonly result: Expression;
}

/** The function reduced to what inlining needs, or `null` when it fails any structural condition. */
function candidateOf(declaration: FunctionDeclaration): Candidate | null {
  const { fn } = declaration;
  // A capturing function's body reads an environment that does not exist at the call site. The
  // three flags are checked rather than inferred from `captures` alone: `needsEnv` is also set when
  // something NESTED captures, and a body that allocates an environment is not a one-liner anyway.
  if (fn.needsEnv || fn.captures.length > 0 || fn.envVars.length > 0) {
    return null;
  }
  // A rest or default is applied at the callee. Substituting the body would drop both.
  if (fn.params.some((param) => param.rest === true || param.default !== undefined)) {
    return null;
  }
  const [only, ...rest] = fn.body.statements;
  if (rest.length > 0 || only === undefined || only.kind !== 'return-statement') {
    return null;
  }
  const result = (only as ReturnStatement).value;
  if (result === undefined) {
    return null;
  }
  const params = fn.params.map((p) => ({ name: p.name, type: p.type }));
  const names = new Set(params.map((p) => p.name));
  if (!freeNames(result).every((name) => names.has(name))) {
    return null;
  }
  // Condition 2 asks whether the body names anything but its own parameters. A nested function
  // that REBINDS one of those names answers "no" and is not: `[1,2].map(function (x) { return x; })`
  // inside `function shift(x) { ... }` names only `x`, but that `x` is the callback's own
  // parameter, and substituting the argument for it turned `shift(7)` into `70` where Node says
  // `10` (plan-notes 219). Substitution is textual over the whole result, so the only safe answer
  // is to decline when a nested scope binds a name being substituted.
  if (rebindsNested(result, names)) {
    return null;
  }
  return { params, result };
}

/** Every identifier name in an expression. The rewriter serves as the visitor so this walk cannot
 * fall behind the one in rewrite.ts when a node kind is added. */
function freeNames(expr: Expression): readonly string[] {
  const names: string[] = [];
  rewriteExpression(expr, {
    expression: (e) => {
      if (e.kind === 'identifier') {
        names.push(e.name);
      }
      return e;
    },
  });
  return names;
}

/** True when something nested inside `expr` declares one of `names` for itself -- a nested
 * function's parameter, or any declaration in a nested body.
 *
 * Over-approximates in the direction that costs an inlining rather than a wrong answer: a
 * declaration in a nested BLOCK counts even though it could not capture a reference outside it. */
function rebindsNested(expr: Expression, names: ReadonlySet<string>): boolean {
  let found = false;
  const holder: Block = {
    kind: 'block',
    type: H_UNDEFINED,
    span: expr.span,
    statements: [
      { kind: 'expression-statement', type: expr.type, span: expr.span, expression: expr },
    ],
  };
  rewriteStatements(holder.statements, {
    expression: (e) => {
      if (e.kind === 'function' && e.params.some((p) => names.has(p.name))) {
        found = true;
      }
      return e;
    },
    statement: (stmt) => {
      if (stmt.kind === 'declaration' && names.has(stmt.name)) {
        found = true;
      }
      return [stmt];
    },
  });
  return found;
}

/** Duplicable and effect-free: exactly the arguments condition 3 admits. */
function isSubstitutable(expr: Expression): boolean {
  switch (expr.kind) {
    case 'number-literal':
    case 'string-literal':
    case 'boolean-literal':
    case 'null-literal':
    case 'undefined-literal':
    case 'identifier':
      return true;
    default:
      return false;
  }
}

function inlineCall(expr: Expression, candidates: ReadonlyMap<string, Candidate>): Expression {
  // A spread call's one argument is the whole list, not the first parameter.
  if (expr.kind !== 'call' || expr.spread === true || expr.callee.kind !== 'identifier') {
    return expr;
  }
  const candidate = candidates.get(expr.callee.name);
  if (candidate === undefined || candidate.params.length !== expr.args.length) {
    return expr;
  }

  const substitution = new Map<string, Expression>();
  for (const [i, param] of candidate.params.entries()) {
    const arg = expr.args[i];
    if (arg === undefined || !isSubstitutable(arg) || !hTypeEquals(arg.type, param.type)) {
      return expr;
    }
    substitution.set(param.name, arg);
  }
  // The call's type is what the checker said the call produces; the body's is what the function
  // returns. They can differ (a literal return type widening at the call), and a mismatch here
  // would hand the verifier a subtree whose type contradicts its parent.
  if (!hTypeEquals(candidate.result.type, expr.type)) {
    return expr;
  }

  // The body is substituted, never the surrounding tree: only identifiers naming a parameter are
  // replaced, and condition 2 guarantees there are no others. Every other node is COPIED, so each
  // call site owns its tree: the emitter keys a call's frame slots by node identity, and a body
  // node shared with the function itself (or another site) took whichever slot was counted last,
  // in the wrong frame -- a module's top level wrote a callee's local slot into a live global
  // (plan-notes 324).
  return rewriteExpression(candidate.result, {
    expression: (e) => (e.kind === 'identifier' ? (substitution.get(e.name) ?? { ...e }) : { ...e }),
  });
}
