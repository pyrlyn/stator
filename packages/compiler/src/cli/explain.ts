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

import { resolve } from 'node:path';
import { gateProgram } from '../frontend/gate.ts';
import { moduleOrder } from '../frontend/graph.ts';
import type { Expression, FunctionExpr, Module, Provenance, Statement } from '../hir/nodes.ts';
import type { ExternCall } from '../hir/nodes.ts';
import { hTypeHasUnknown } from '../hir/types.ts';
import { rewriteModule } from '../passes/rewrite.ts';
import { type Diagnostic, type DiagnosticSite, renderDiagnostic } from '../support/diagnostics.ts';
import { withSpan } from '../support/telemetry.ts';
import { BuildError } from './build.ts';
import {
  type BundlerChoice,
  DEFAULT_BUNDLER,
  loadFrontend,
  lowerFrontend,
  reportedDiagnostics,
} from './bundler.ts';
import { diagnosticLines, INK_COLORS, type InkColor, type Line, print } from './render.ts';

type Mode = 'ts' | 'js';

export type Verdict = 'static' | 'dynamic' | 'error' | 'not-yet';

export interface Explanation {
  readonly verdict: Verdict;
  readonly code?: string;
  /** Every diagnostic of the stage that decided an `error` or `not-yet` verdict, in source order
   * (plan-notes 291). `code` names one; this names all of them, which is what sizing a large
   * input needs — one code says only that a file fails, not how far it is from compiling. Later
   * stages never ran, so their diagnostics cannot be here. Present exactly when `code` is. */
  readonly diagnostics?: readonly DiagnosticReport[];
  /** The static/dynamic split, one row per compiled function (plan.md §8 step 1). Absent when the
   * file earned a verdict before lowering ran -- a program that was rejected has no functions to
   * report, and an empty array would claim it had none. */
  readonly functions?: readonly FunctionReport[];
  /** Every extern call the module compiles (docs/FFI.md §5): the unchecked-boundary mark. A C
   * return cannot be runtime-checked (§0 rule 2's one exception), so an audit enumerates these
   * rows rather than trusting the verdict alone. The mark rides ALONGSIDE the verdict — the
   * four-verdict vocabulary is unchanged — and is absent when the module makes no extern call,
   * which keeps every non-extern report byte-identical. */
  readonly externCalls?: readonly ExternCallReport[];
}

/** One diagnostic as `explain` reports it: the fields of its rendered line. `--json` consumers
 * key on `code`, never on `message` (AGENTS.md, Diagnostics conventions). */
export type DiagnosticReport = DiagnosticSite;

/** One unchecked boundary: the C symbol called and the source line that calls it. The TS name
 * is the declaration's business; the audit question is which FOREIGN code runs, so the C
 * symbol is what the row names. */
export interface ExternCallReport {
  readonly name: string;
  readonly line: number;
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

export async function explain(
  entry: string,
  mode: Mode,
  json: boolean,
  bundler: BundlerChoice = DEFAULT_BUNDLER,
  node = false,
): Promise<number> {
  const result = await explainFile(entry, mode, bundler, node);

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
    // A tally first, so a large input reads as how far it is from compiling, then every site.
    const report = result.diagnostics ?? [];
    if (report.length > 1) {
      for (const [code, count] of tally(report)) {
        lines.push({ text: `  ${code} x${count}` });
      }
    }
    for (const d of report) {
      lines.push({ text: `  ${renderDiagnostic(d)}` });
    }
    for (const fn of result.functions ?? []) {
      lines.push({ text: `  ${fn.line}: ${fn.name}: ${fn.verdict} (${fn.provenance})` });
    }
    // The unchecked-boundary mark in human form: every extern call the file compiles, so the
    // audit `stator explain` exists to serve works on a terminal too, not only on `--json`.
    for (const call of result.externCalls ?? []) {
      lines.push({ text: `  unchecked boundary: extern call '${call.name}' (line ${call.line})` });
    }
    await print(lines, process.stdout);
  }
  return 0;
}

/** `node` is the `--node` platform (docs/MODES.md §6): under it a Node built-in `packages/node`
 * has not landed is a `not-yet` naming T11.6, so `diagnostics` lists the platform gaps the same
 * way it lists the language ones. */
export async function explainFile(
  entry: string,
  mode: Mode,
  bundler: BundlerChoice = DEFAULT_BUNDLER,
  node = false,
): Promise<Explanation> {
  const frontend = await loadFrontend(entry, mode, bundler, node);
  const { program } = frontend;
  // The same mapping `build` applies (T12.1 step 5): a vendor diagnostic names the package file.
  const classify = (diagnostics: readonly Diagnostic[]): Explanation | null =>
    classifyDiagnostics(reportedDiagnostics(diagnostics, frontend.vendor));
  const verdictFromDiagnostics = classify([
    ...frontend.diagnostics,
    ...withSpan('frontend/gate', {}, () => gateProgram(program, mode, node)),
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

  const { module, diagnostics } = withSpan('lower', {}, () => lowerFrontend(frontend, order, mode));
  const verdictFromLowering = classify(diagnostics);
  if (verdictFromLowering !== null) {
    return verdictFromLowering;
  }
  if (module === null) {
    // Lowering gave up without saying why. That is a bug, and reporting `static` here would be a
    // false claim about a program that does not compile.
    const reported = reportedDiagnostics(diagnostics, frontend.vendor);
    await print(diagnosticLines(reported), process.stderr);
    return { verdict: 'error', code: 'STA4021', diagnostics: diagnosticReports(reported) };
  }

  return {
    verdict: hasUnknown(module) ? 'dynamic' : 'static',
    functions: functionReports(module),
    ...externCallsField(module),
  };
}

/** The unchecked-boundary mark (docs/FFI.md §5): one row per extern call the module compiles,
 * in source order. Absent — not empty — when the module makes no extern call, so reports for
 * programs without one are unchanged. A rejected program never reaches here (its verdict
 * returned above), which is correct: a call that does not compile is not a boundary, it is a
 * refusal, and its code already names it. */
function externCallsField(module: Module): { externCalls?: readonly ExternCallReport[] } {
  const found: ExternCall[] = [];
  rewriteModule(module, {
    expression: (expr) => {
      if (expr.kind === 'extern-call') {
        found.push(expr);
      }
      return expr;
    },
  });
  if (found.length === 0) {
    return {};
  }
  return {
    externCalls: found
      .map((call) => ({ name: call.cName, line: call.span.line }))
      .sort((a, b) => a.line - b.line),
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
      // A bare arrow has no name of its own and the binding it is assigned to is a
      // different node, so the line is what identifies it — except arrows assigned to a
      // declaration, `var` initializer, or simple assignment, whose declarator spelling the
      // lowering back-fills as the display name (step 17 and follow-up). Reporting a guessed
      // name beyond that would be worse than none.
      name: fn.name ?? '<anonymous>',
      line: fn.span.line,
      provenance: fn.provenance,
      verdict: fn.provenance === 'dynamic' ? ('dynamic' as const) : ('static' as const),
    }))
    .sort((a, b) => a.line - b.line);
}

/** null means "nothing here decides the verdict" — carry on to the typed answer. */
function classifyDiagnostics(diagnostics: readonly Diagnostic[]): Explanation | null {
  const decided = (verdict: 'error' | 'not-yet', code: string): Explanation => ({
    verdict,
    code,
    diagnostics: diagnosticReports(diagnostics),
  });
  const never = diagnostics.find((d) => d.class === 'never');
  if (never !== undefined) {
    return decided('error', never.code);
  }
  const notYet = diagnostics.find((d) => d.class === 'not-yet');
  if (notYet !== undefined) {
    return decided('not-yet', notYet.code);
  }
  const error = diagnostics.find((d) => d.class === 'error' || d.class === 'internal');
  if (error !== undefined) {
    return decided('error', error.code);
  }
  return null;
}

/** Source order: file, then line, then column — the order a reader walks the program in, and
 * one that does not depend on which pass happened to find a site first. */
function diagnosticReports(diagnostics: readonly Diagnostic[]): readonly DiagnosticReport[] {
  return diagnostics
    .map(({ file, line, column, code, mode, message }) => ({
      file,
      line,
      column,
      code,
      mode,
      message,
    }))
    .sort(
      (a, b) =>
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.column - b.column,
    );
}

/** Count per code, most frequent first (ties by code, so the order is stable). */
function tally(report: readonly DiagnosticReport[]): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const d of report) {
    counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** One Unknown anywhere -- in a signature or buried in a body -- makes the whole FILE dynamic.
 *
 * This deliberately outranks the per-function rows, which see signatures only: a file whose every
 * function is `static` can still be dynamic, and that is the honest reading. The rows say where the
 * dynamic representation crosses a call; this says whether the file uses it at all. */
/** The HIR names bound to out-slots (docs/FFI.md §2): `outSlot()` constructions and
 * aliases of them, to fixpoint for chains. Statement nesting only — aliases inside function
 * bodies read dynamic (conservative): slot discipline is function-local for verdicts, and HIR
 * binding names are unique program-wide (plan.md §8 step 14), so no scope threading is owed.
 * Verdicts only: the gate, not this set, decides legality — misuses never reach this walk. */
function collectOutSlots(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  const considerDeclaration = (name: string, value: Expression | undefined): void => {
    if (value === undefined) {
      return;
    }
    if (value.kind === 'out-new') {
      names.add(name);
    } else if (value.kind === 'identifier' && names.has(value.name)) {
      names.add(name);
    }
  };
  const walkStatements = (list: readonly Statement[]): void => {
    for (const stmt of list) {
      switch (stmt.kind) {
        case 'declaration':
          considerDeclaration(stmt.name, stmt.value);
          break;
        case 'assignment':
          considerDeclaration(stmt.target, stmt.value);
          break;
        case 'block':
          walkStatements(stmt.statements);
          break;
        case 'if-statement':
          walkStatements(stmt.consequent.statements);
          if (stmt.alternate !== undefined) {
            walkStatements(stmt.alternate.statements);
          }
          break;
        case 'while-statement':
        case 'do-while-statement':
        case 'for-of-statement':
          walkStatements(stmt.body.statements);
          break;
        case 'for-statement':
          if (stmt.init !== undefined) {
            walkStatements([stmt.init]);
          }
          if (stmt.update !== undefined) {
            walkStatements([stmt.update]);
          }
          walkStatements(stmt.body.statements);
          break;
        case 'switch-statement':
          for (const clause of stmt.clauses) {
            walkStatements(clause.statements);
          }
          break;
        case 'try-statement':
          walkStatements(stmt.tryBlock.statements);
          if (stmt.catchBlock !== undefined) {
            walkStatements(stmt.catchBlock.statements);
          }
          if (stmt.finallyBlock !== undefined) {
            walkStatements(stmt.finallyBlock.statements);
          }
          break;
        default:
          break;
      }
    }
  };
  for (;;) {
    const before = names.size;
    walkStatements(statements);
    if (names.size === before) {
      return names;
    }
  }
}

/** Out-slot-bound HIR names for the current `hasUnknown` walk (docs/FFI.md §2) — module
 * state for pass context, the `lowerDiagMode` precedent in `lower/index.ts`. Set once per
 * walk; the walk is single-threaded and never re-enters. */
let outSlotVerdictNames: ReadonlySet<string> = new Set<string>();

function hasUnknown(module: Module): boolean {
  outSlotVerdictNames = collectOutSlots(module.statements);
  return module.statements.some(statementHasUnknown);
}

/** Whether this declaration binds an out-slot (docs/FFI.md §2): constructed by
 * `outSlot()` or aliased from one (the `collectOutSlots` set). Such bindings read `unknown`
 * without touching the dynamic representation, so the unknown-type rule above exempts them —
 * exactly the declarations the gate proved legal, restated for verdicts. */
function isOutSlotBinding(stmt: Statement): boolean {
  if (stmt.kind !== 'declaration' || stmt.value === undefined) {
    return false;
  }
  return (
    stmt.value.kind === 'out-new' ||
    (stmt.value.kind === 'identifier' && outSlotVerdictNames.has(stmt.value.name))
  );
}

function statementHasUnknown(stmt: Statement): boolean {
  if (stmt.type.kind === 'unknown' && !isOutSlotBinding(stmt)) {
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
  // An extern call is a direct C call whatever it returns: a pointer result is opaque BITS,
  // not a dynamic value, and pointer arguments cross unboxed with no check to fail — so the
  // call is static unless a CHECKABLE argument is dynamic (docs/FFI.md §§5, 9). The kind, not
  // the HType, decides: every handle-typed value reads `unknown`, which would otherwise paint
  // every honest round-trip dynamic. A `bytes` argument is checkable (`jsrt_check_uint8array`),
  // so it reads like a number: static when proven, dynamic when the call checks it.
  if (expr.kind === 'extern-call') {
    return expr.args.some(
      (arg, index) =>
        expr.argKinds[index] !== 'pointer' &&
        expr.argKinds[index] !== 'out-pointer' &&
        (arg.kind === 'boundary-check' || expressionHasUnknown(arg)),
    );
  }
  // An out-slot is opaque `unknown` the same way a handle is, and the same way not dynamic:
  // creating, passing, and reading a slot never touches the dynamic representation (the
  // positions are the gate's STA1125 contract, not a verdict). Ahead of the type check like
  // `extern-call` — below it this case is dead code, since every slot node reads `unknown`.
  if (expr.kind === 'out-new' || expr.kind === 'out-get') {
    return false;
  }
  // A slot-bound name reads static wherever it appears (the `collectOutSlots` set): the
  // binding holds a cell address or a handle, never a dynamic value. Verdicts only — legality
  // stays the gate's STA1125 contract, so a misused slot is `error`, never `dynamic`.
  if (expr.kind === 'identifier' && outSlotVerdictNames.has(expr.name)) {
    return false;
  }
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
    case 'type-error':
      return false;
    case 'binary-op':
    case 'logical-op':
      return expressionHasUnknown(expr.left) || expressionHasUnknown(expr.right);
    case 'unary-op':
    case 'string-length':
    case 'array-length':
    case 'function-length':
      return expressionHasUnknown(expr.operand);
    case 'conditional':
      return (
        expressionHasUnknown(expr.condition) ||
        expressionHasUnknown(expr.consequent) ||
        expressionHasUnknown(expr.alternate)
      );
    // A guarded base is still a value the chain reads: a nullishable Unknown base is the
    // dynamic site, and the consequent's accesses report as their plain twins do.
    case 'optional-chain':
      return expressionHasUnknown(expr.base) || expressionHasUnknown(expr.consequent);
    // The guarded value, read where the chain holds it. Its type is the base's narrowed by
    // the nullish test, which the check at the top of this function has already read.
    case 'optional-base':
      return false;
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
    // A class-object value is never Unknown-typed, so both value spellings answer through
    // their operands, exactly like the named `new`.
    case 'new-value':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    // A file-scope constant per class (docs/VALUE.md §4.17): no subexpression can be dynamic.
    case 'class-value':
      return false;
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
    // A field call loads its callee from a typed slot: only the operands can be dynamic.
    case 'method-call':
    case 'field-call':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    // Dynamic by construction: the receiver is Unknown, which the check at the top of this
    // function has already answered for the node itself; the arguments may add more.
    case 'dyn-method-call':
      return true;
    case 'method-value':
      return expressionHasUnknown(expr.target);
    // The answer is a boolean whatever the target is, so only the target can be dynamic. A regexp
    // read is the same shape and, unlike a match read, has a target the HIR types concretely --
    // so recursing into it says what the code does rather than the opposite.
    case 'regexp-read':
    case 'instanceof':
      return expressionHasUnknown(expr.target);
    // The answer is a boolean whatever the operands are, so only the operands can be dynamic.
    case 'instanceof-value':
      return expressionHasUnknown(expr.target) || expressionHasUnknown(expr.ctor);
    // A literal's own type stops the deep walk for the same reason a class's does, so what makes
    // one dynamic is a value it was built from -- which is exactly what a read of it will find.
    case 'object-literal':
      return (
        expr.entries.some((e) => expressionHasUnknown(e.value)) ||
        expr.methodCopies.some((copy) => expressionHasUnknown(copy.value))
      );
    // Dynamic by definition -- their type is Unknown, which the check at the top of this function
    // has already answered; these arms only complete the switch.
    case 'dyn-object-literal':
    case 'dyn-field-access':
    // JSON.parse answers data the checker cannot see into: the result is Unknown whatever the
    // argument was, so the call site is where the program becomes dynamic.
    case 'json-parse':
      return true;
    // An accessor place is as dynamic as its receiver: the get/set pair runs against whatever
    // arrived. Its own type is concrete (the property's), so only the target can be dynamic.
    case 'accessor-place':
      return expressionHasUnknown(expr.target);
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
    case 'number-op':
    case 'string-op':
      return expressionHasUnknown(expr.target) || expr.args.some(expressionHasUnknown);
    case 'iterator-next':
      return expressionHasUnknown(expr.target) || expressionHasUnknown(expr.sent);
    // The dispatch answers an iterator over Unknown elements, which the type check at the top
    // of this function has already answered; this arm completes the switch and reports the
    // operand for the same reason `iterator-next` reports its own.
    case 'get-iterator':
      return expressionHasUnknown(expr.target);
    case 'date-new':
    case 'error-new':
    case 'json-stringify':
      return expressionHasUnknown(expr.arg);
    // A namespace walk answers what its argument holds, so an Unknown ARGUMENT carries through --
    // except for `fromEntries`, whose result is a dynamic shape and therefore Unknown outright,
    // which the check at the top of this function has already answered.
    case 'date-components':
    case 'date-static':
    case 'global-call':
    case 'object-static':
    case 'typed-op':
    case 'string-static':
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
