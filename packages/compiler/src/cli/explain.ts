/** `stator explain` — the verdict for one file: what will the compiler DO with this program?
 *
 * This is the interface the decision tests in `tests/subset/` assert against (plan.md §5 Task 2.6),
 * which is why it reports a verdict and a code rather than prose: a test that matched on message
 * text would break every time the wording improved.
 *
 * Four verdicts, and their precedence when a file earns more than one:
 *   error    a `never` diagnostic — rejected by design, and no phase will change that
 *   not-yet  a `STA12xx` diagnostic — outside today's subset, but scheduled
 *   dynamic  compiles, but some value is Unknown and goes through the dynamic representation
 *   static   compiles fully typed, which is where the speed comes from
 * `error` outranks `not-yet` because a permanent rejection is a fact about the program, while a
 * not-yet is a fact about the compiler's current progress.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gateProgram } from '../frontend/gate.ts';
import { moduleOrder } from '../frontend/graph.ts';
import { createProgram } from '../frontend/program.ts';
import type { Expression, FunctionExpr, Module, Provenance, Statement } from '../hir/nodes.ts';
import { hTypeHasUnknown } from '../hir/types.ts';
import { lowerProgram } from '../lower/index.ts';
import { rewriteModule } from '../passes/rewrite.ts';
import type { Diagnostic } from '../support/diagnostics.ts';
import { withSpan } from '../support/telemetry.ts';
import { BuildError } from './build.ts';
import { diagnosticLines, INK_COLORS, type InkColor, type Line, print } from './render.ts';

type Mode = 'ts' | 'js';

export type Verdict = 'static' | 'dynamic' | 'error' | 'not-yet';

export interface Explanation {
  readonly verdict: Verdict;
  readonly code?: string;
  /** The static/dynamic split, one row per compiled function (plan.md §8 step 1). Absent when the
   * file earned a verdict before lowering ran -- a program that was rejected has no functions to
   * report, and an empty array would claim it had none. */
  readonly functions?: readonly FunctionReport[];
}

/** One function's row. `provenance` is the HIR fact (where the SIGNATURE's types came from);
 * `verdict` is that fact in the vocabulary the rest of this tool speaks.
 *
 * Both are about the signature, not the body, and that is the honest scope for a per-function row:
 * a nested function is a separate compilation unit with a row of its own, and everything the
 * enclosing one can see about it -- its type, the calls it makes -- is in the enclosing one's own
 * signature or the file verdict. The FILE verdict above still counts every Unknown anywhere,
 * bodies included, so a typed function full of `any` cannot hide behind a `static` row. */
export interface FunctionReport {
  readonly name: string;
  readonly line: number;
  readonly provenance: Provenance;
  readonly verdict: 'static' | 'dynamic';
}

/** Returns the process exit code. A rejected program is still a SUCCESSFUL explain: the user asked
 * what would happen and got a true answer, so exit 0 unless explain itself could not run. */
/** What a verdict looks like on a terminal: the byte text never changes; the color does. */
const VERDICT_COLOR: Record<Verdict, InkColor> = {
  static: INK_COLORS.staticVerdict,
  dynamic: INK_COLORS.dynamic,
  error: INK_COLORS.error,
  'not-yet': INK_COLORS.notYet,
};

export async function explain(entry: string, mode: Mode, json: boolean): Promise<number> {
  const result = await explainFile(entry, mode);

  if (json) {
    // The machine path NEVER goes through ink (decision tests parse this verbatim).
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const lines: Line[] = [
      {
        text:
          result.code === undefined
            ? `${entry}: ${result.verdict}`
            : `${entry}: ${result.verdict} (${result.code})`,
        color: VERDICT_COLOR[result.verdict],
      },
    ];
    // The file line first, then its functions indented under it: the file verdict is the stronger
    // claim (it counts bodies), so a `dynamic` file over all-`static` rows reads as the narrowing
    // it is rather than as a contradiction.
    for (const fn of result.functions ?? []) {
      lines.push({ text: `  ${fn.line}: ${fn.name}: ${fn.verdict} (${fn.provenance})` });
    }
    await print(lines, process.stdout);
  }
  return 0;
}

export async function explainFile(entry: string, mode: Mode): Promise<Explanation> {
  if (!existsSync(entry)) {
    throw new BuildError('STA0007', `entry file "${entry}" does not exist`);
  }

  const {
    program,
    diagnostics: programDiagnostics,
    runtimeDynamicSymbols,
  } = withSpan('frontend/program', {}, () => createProgram(entry, mode));
  const verdictFromDiagnostics = classify([
    ...programDiagnostics,
    ...withSpan('frontend/gate', {}, () => gateProgram(program, mode)),
  ]);
  if (verdictFromDiagnostics !== null) {
    return verdictFromDiagnostics;
  }

  // Mirrors createProgram's normalization: the program stores the entry under its ABSOLUTE
  // forward-slash name, whatever spelling the command line used.
  const entryFile = program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  if (entryFile === undefined) {
    throw new BuildError('STA0007', `entry file "${entry}" does not exist`);
  }

  // The verdict covers the whole module graph, exactly as the build does: a cycle or a
  // cross-file collision decides the entry's verdict, and a dependency's Unknown makes the
  // program dynamic -- per-file verdicts would claim `static` for an entry whose import graph
  // cannot compile.
  const { order, diagnostics: graphDiagnostics } = withSpan('frontend/module-graph', {}, () =>
    moduleOrder(program, entryFile, mode),
  );
  const graphVerdict = classify(graphDiagnostics);
  if (graphVerdict !== null) {
    return graphVerdict;
  }

  const { module, diagnostics } = withSpan('lower', {}, () =>
    lowerProgram(order, program.getTypeChecker(), runtimeDynamicSymbols),
  );
  const verdictFromLowering = classify(diagnostics);
  if (verdictFromLowering !== null) {
    return verdictFromLowering;
  }
  if (module === null) {
    // Lowering gave up without saying why. That is a bug, and reporting `static` here would be a
    // false claim about a program that does not compile.
    await print(diagnosticLines(diagnostics), process.stderr);
    return { verdict: 'error', code: 'STA4021' };
  }

  return {
    verdict: hasUnknown(module) ? 'dynamic' : 'static',
    functions: functionReports(module),
  };
}

/** Every function the module compiles, in source order.
 *
 * The walk is `rewriteModule` with an identity rewriter rather than a walk of its own: that file is
 * the one place that enumerates HIR node kinds exhaustively, so a collector written on top of it
 * keeps working when a kind is added, and a collector written beside it would silently stop
 * reporting the new kind's functions. Both hooks are needed because a declaration's and a method's
 * function is rewritten directly rather than as an expression, so the expression hook never sees
 * it -- and for the same reason neither is reported twice. */
function functionReports(module: Module): readonly FunctionReport[] {
  const found: FunctionExpr[] = [];
  rewriteModule(module, {
    expression: (expr) => {
      if (expr.kind === 'function') {
        found.push(expr);
      }
      return expr;
    },
    statement: (stmt) => {
      if (stmt.kind === 'function-declaration') {
        found.push(stmt.fn);
      } else if (stmt.kind === 'class-declaration') {
        if (stmt.ctor !== undefined) {
          found.push(stmt.ctor.fn);
        }
        found.push(...stmt.methods.map((m) => m.fn));
      }
      return [stmt];
    },
  });
  return found
    .map((fn) => ({
      // An arrow has no name of its own and the binding it is assigned to is a different node, so
      // the line is what identifies it. Reporting a guessed name would be worse than none.
      name: fn.name ?? '<anonymous>',
      line: fn.span.line,
      provenance: fn.provenance,
      verdict: fn.provenance === 'dynamic' ? ('dynamic' as const) : ('static' as const),
    }))
    .sort((a, b) => a.line - b.line);
}

/** null means "nothing here decides the verdict" — carry on to the typed answer. */
function classify(diagnostics: readonly Diagnostic[]): Explanation | null {
  const never = diagnostics.find((d) => d.class === 'never');
  if (never !== undefined) {
    return { verdict: 'error', code: never.code };
  }
  const notYet = diagnostics.find((d) => d.class === 'not-yet');
  if (notYet !== undefined) {
    return { verdict: 'not-yet', code: notYet.code };
  }
  const error = diagnostics.find((d) => d.class === 'error' || d.class === 'internal');
  if (error !== undefined) {
    return { verdict: 'error', code: error.code };
  }
  return null;
}

/** One Unknown anywhere -- in a signature or buried in a body -- makes the whole FILE dynamic.
 *
 * This deliberately outranks the per-function rows, which see signatures only: a file whose every
 * function is `static` can still be dynamic, and that is the honest reading. The rows say where the
 * dynamic representation crosses a call; this says whether the file uses it at all. */
function hasUnknown(module: Module): boolean {
  return module.statements.some(statementHasUnknown);
}

function statementHasUnknown(stmt: Statement): boolean {
  if (stmt.type.kind === 'unknown') {
    return true;
  }
  switch (stmt.kind) {
    case 'declaration':
      return stmt.value !== undefined && expressionHasUnknown(stmt.value);
    case 'assignment':
      return expressionHasUnknown(stmt.value);
    case 'expression-statement':
      return expressionHasUnknown(stmt.expression);
    case 'if-statement':
      return (
        expressionHasUnknown(stmt.condition) ||
        statementHasUnknown(stmt.consequent) ||
        (stmt.alternate !== undefined && statementHasUnknown(stmt.alternate))
      );
    case 'while-statement':
    case 'do-while-statement':
      return expressionHasUnknown(stmt.condition) || statementHasUnknown(stmt.body);
    case 'for-statement':
      return (
        (stmt.init !== undefined && statementHasUnknown(stmt.init)) ||
        (stmt.condition !== undefined && expressionHasUnknown(stmt.condition)) ||
        (stmt.update !== undefined && statementHasUnknown(stmt.update)) ||
        statementHasUnknown(stmt.body)
      );
    case 'switch-statement':
      return (
        expressionHasUnknown(stmt.discriminant) ||
        stmt.clauses.some(
          (c) =>
            (c.test !== undefined && expressionHasUnknown(c.test)) ||
            c.statements.some(statementHasUnknown),
        )
      );
    // A jump carries no value, so it can never be the reason a file is dynamic.
    case 'break-statement':
    case 'continue-statement':
      return false;
    case 'block':
      return stmt.statements.some(statementHasUnknown);
    // A function's body is part of the file, so an Unknown inside it makes the file dynamic even
    // when the signature is fully typed.
    case 'function-declaration':
      return expressionHasUnknown(stmt.fn);
    case 'return-statement':
      return stmt.value !== undefined && expressionHasUnknown(stmt.value);
    case 'index-assignment':
      return (
        expressionHasUnknown(stmt.target) ||
        expressionHasUnknown(stmt.index) ||
        expressionHasUnknown(stmt.value)
      );
    // The loop binding is not an Expression, so its type is not reached by recursion. It is the
    // ELEMENT type of the iterable -- TypeScript models iteration as yielding `T`, not
    // `T | undefined` -- and `expressionHasUnknown(iterable)` already covers it via the deep
    // check, so the iterable and the body are the whole question.
    case 'for-of-statement':
      return expressionHasUnknown(stmt.iterable) || statementHasUnknown(stmt.body);
    case 'field-assignment':
      return expressionHasUnknown(stmt.target) || expressionHasUnknown(stmt.value);
    // Dynamic BY DEFINITION: the node exists because the receiver's type has no layout, so the
    // walk of its operands is for completeness, not for the verdict.
    case 'dyn-field-assignment':
      return true;
    // A field's type is not reached by recursion -- fields are Parameters, not Expressions -- so a
    // class holding an `any` field is dynamic at its DECLARATION, not only where it is read.
    case 'class-declaration':
      return (
        stmt.fields.some((f) => hTypeHasUnknown(f.type)) ||
        (stmt.ctor !== undefined && expressionHasUnknown(stmt.ctor.fn)) ||
        stmt.methods.some((m) => expressionHasUnknown(m.fn))
      );
    // A super call is a call: its receiver and arguments are where dynamic values can appear.
    case 'super-call':
      return expressionHasUnknown(stmt.receiver) || stmt.args.some(expressionHasUnknown);
    case 'throw-statement':
      return expressionHasUnknown(stmt.value);
    // The catch binding is ALWAYS Unknown — anything can be thrown — but that alone must not make
    // the statement dynamic, or every try/catch in ts mode would be. Only the blocks' contents
    // count, exactly as an unused `unknown` parameter does not taint its function.
    case 'try-statement':
      return (
        stmt.tryBlock.statements.some(statementHasUnknown) ||
        (stmt.catchBlock?.statements.some(statementHasUnknown) ?? false) ||
        (stmt.finallyBlock?.statements.some(statementHasUnknown) ?? false)
      );
    default: {
      const exhaustive: never = stmt;
      return exhaustive;
    }
  }
}

function expressionHasUnknown(expr: Expression): boolean {
  if (hTypeHasUnknown(expr.type)) {
    return true;
  }
  switch (expr.kind) {
    case 'number-literal':
    case 'string-literal':
    case 'boolean-literal':
    case 'null-literal':
    case 'undefined-literal':
    case 'identifier':
    // Unreachable in practice: its type IS Unknown, so the check above already answered true.
    // Listed so the switch stays exhaustive rather than relying on that.
    case 'reference-error':
      return false;
    case 'binary-op':
    case 'logical-op':
      return expressionHasUnknown(expr.left) || expressionHasUnknown(expr.right);
    case 'unary-op':
    case 'string-length':
    case 'array-length':
      return expressionHasUnknown(expr.operand);
    case 'conditional':
      return (
        expressionHasUnknown(expr.condition) ||
        expressionHasUnknown(expr.consequent) ||
        expressionHasUnknown(expr.alternate)
      );
    case 'update':
      return (
        expressionHasUnknown(expr.target) ||
        (expr.value !== undefined && expressionHasUnknown(expr.value))
      );
    // The literal's own type came from the checker, so a `number[]` stays static even though each
    // element is inspected here -- what this catches is an element whose *subexpression* is
    // dynamic, e.g. `[f()]` where `f` returns `any`.
    case 'array-literal':
      return expr.elements.some(expressionHasUnknown);
    // Unreachable in practice: under `noUncheckedIndexedAccess` an indexed read is `T | undefined`,
    // so the type check above already returned true (plan-notes 53). Written out anyway, because
    // Task 3.5's narrowing is what makes it reachable.
    case 'index-access':
      return expressionHasUnknown(expr.target) || expressionHasUnknown(expr.index);
    case 'template-literal':
      return expr.expressions.some(expressionHasUnknown);
    case 'console-log':
      return expr.args.some(expressionHasUnknown);
    // A parameter is not an Expression, so its type is checked here rather than by recursion.
    case 'function':
      return expr.params.some((p) => p.type.kind === 'unknown') || statementHasUnknown(expr.body);
    case 'call':
      return expressionHasUnknown(expr.callee) || expr.args.some(expressionHasUnknown);
    case 'new':
      return expr.args.some(expressionHasUnknown);
    // The object's own type stops the deep walk (hTypeHasUnknown does not recurse into a class,
    // since it can be cyclic), so the READ is where a dynamic field surfaces -- and the type check
    // at the top of this function has already answered it for this node.
    case 'field-access':
      return expressionHasUnknown(expr.target);
    // A match read is STATIC even though its target is Unknown: `exec` answers a match or null, so
    // the receiver cannot be typed, but the read itself is one fixed runtime call whose result type
    // this compiler chose. Recursing into the target would report every one of them dynamic and say
    // the opposite of what the code does -- the `boundary-check` reasoning below, one node over.
    // `groups` is the exception and needs no arm: its own type is Unknown, which the type check at
    // the top of this function has already answered.
    case 'match-read':
      return false;
    case 'method-call':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    // The answer is a boolean whatever the target is, so only the target can be dynamic. A regexp
    // read is the same shape and, unlike a match read, has a target the HIR types concretely --
    // so recursing into it says what the code does rather than the opposite.
    case 'regexp-read':
    case 'instanceof':
      return expressionHasUnknown(expr.target);
    // A literal's own type stops the deep walk for the same reason a class's does, so what makes
    // one dynamic is a value it was built from -- which is exactly what a read of it will find.
    case 'object-literal':
      return expr.entries.some((e) => expressionHasUnknown(e.value));
    // Dynamic by definition -- their type is Unknown, which the check at the top of this function
    // has already answered; these arms only complete the switch.
    case 'dyn-object-literal':
    case 'dyn-field-access':
    // JSON.parse answers data the checker cannot see into: the result is Unknown whatever the
    // argument was, so the call site is where the program becomes dynamic.
    case 'json-parse':
      return true;
    // A fresh collection is as static as its type argument, which the check at the top of this
    // function already read: `new Map<string, number>()` is static, `new Map()` -- which the
    // checker types `Map<any, any>` -- is not.
    case 'collection-new':
      return false;
    case 'collection-op':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    // A pattern is TEXT with a type of its own, and `test` answers a boolean whatever it was asked
    // about -- so neither is a place a program becomes dynamic. The SUBJECT can be Unknown, and
    // that is what the argument walk below reports.
    case 'regexp-literal':
      return false;
    case 'regexp-op':
      return expr.args.some(expressionHasUnknown);
    // Number in, number out, checked by the verifier -- only an argument can carry an Unknown.
    case 'math-call':
      return expr.args.some(expressionHasUnknown);
    case 'array-op':
    case 'date-op':
    case 'string-op':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    case 'iterator-next':
      return expressionHasUnknown(expr.target) || expressionHasUnknown(expr.sent);
    case 'date-new':
    case 'error-new':
    case 'json-stringify':
      return expressionHasUnknown(expr.arg);
    // A namespace walk answers what its argument holds, so an Unknown ARGUMENT carries through --
    // except for `fromEntries`, whose result is a dynamic shape and therefore Unknown outright,
    // which the check at the top of this function has already answered.
    case 'date-components':
    case 'date-static':
    case 'object-static':
      return expr.args.some(expressionHasUnknown);
    // A promise's own value type is what makes the awaited result dynamic or not, and that type
    // is on the node -- the check at the top of this function has already read it. What remains
    // is the operand: `await someUnknown` is a dynamic site, as is `Promise.all(dynamic)`.
    case 'await':
    case 'yield':
      return expressionHasUnknown(expr.value);
    case 'promise-static':
      return expressionHasUnknown(expr.arg);
    case 'promise-method':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    case 'promise-construct':
      return expressionHasUnknown(expr.executor);
    // `typeof` is a string whatever it asked about, so an Unknown OPERAND does not make the result
    // dynamic -- asking an unknown value what it is is exactly how a program stops being dynamic.
    case 'typeof':
      return false;
    // `delete` answers a boolean, but unlike `typeof` it OPERATES on the receiver: removing a key
    // is the shape table's work, and a construct that only compiles against a dynamic receiver is
    // exactly what this report exists to name.
    case 'get-iterator':
      return expressionHasUnknown(expr.operand);
    case 'delete-prop':
      return true;
    // Likewise a check: it is the point where an Unknown becomes concrete, so it reports the type
    // it produced, not the one it consumed. Recursing into `value` would report every narrowing
    // site as dynamic and make `explain` say the opposite of what the code does.
    case 'boundary-check':
      return false;
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}
