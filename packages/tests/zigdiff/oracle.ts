// What the TypeScript compiler answers for one fixture beyond its verdict and its C: the HIR at both
// ends of the passes, what its verifier says of each, and two mutants its verifier must reject.
//
// The mutants are what make the verifier stage mean anything. The corpus compiles, so every honest
// dump is clean, and a verifier that accepted everything would agree on all of them. They break the
// tree in ways the lowering never would, and the Zig verifier has to name the same problems in the
// same order.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Expression, Module, NumberLiteral, Statement } from '../../compiler/src/hir/nodes.ts';
import { isAccessorEntry, isSetOperation, REGEXP_OPS } from '../../compiler/src/hir/nodes.ts';
import { H_NUMBER, H_STRING, hUnknown, type HType } from '../../compiler/src/hir/types.ts';
import { verifyHir } from '../../compiler/src/hir/verify.ts';
import { optimize } from '../../compiler/src/passes/index.ts';
import { rewriteModule } from '../../compiler/src/passes/rewrite.ts';
import type { CorpusFixture } from '../support/corpus.ts';
import { dumpHir, hirJson } from './dump-hir.ts';
import { foldProbe } from './folds.ts';

/** One line per problem. The span is included because a verifier that found the right problem at
 * the wrong node has not agreed. */
function problemText(module: Module): string {
  return verifyHir(module)
    .map(
      (p) =>
        `${p.code}\t${p.kind}\t${String(p.span.start)}:${String(p.span.length)}:${String(p.span.line)}\t${p.message}\n`,
    )
    .join('');
}

function wrongType(type: HType): HType {
  return type.kind === 'number' ? H_STRING : H_NUMBER;
}

const WRONG_NAME = 'Mutant$Missing';

/** The structural break for a node kind: a name, slot or list the verifier cross-checks against
 * the types. Kinds with nothing of the sort fall back to a wrong type. */
function structural(expr: Expression): Expression {
  switch (expr.kind) {
    case 'identifier':
      return { ...expr, name: `${expr.name}$missing` };
    case 'field-access':
    case 'field-call':
    case 'method-call':
    case 'method-value':
      return { ...expr, slot: expr.slot + 1 };
    case 'math-call':
    case 'string-op':
    case 'array-op':
    case 'collection-op':
    case 'regexp-op':
    case 'date-op':
    case 'date-static':
    case 'date-components':
    case 'typed-op':
    case 'global-call':
    case 'object-static':
    case 'console-log':
    case 'number-op':
      return { ...expr, args: expr.args.slice(0, -1) };
    case 'template-literal':
      return { ...expr, quasis: expr.quasis.slice(1) };
    case 'new':
    case 'instanceof':
      return { ...expr, className: WRONG_NAME };
    case 'extern-call':
      return { ...expr, argKinds: expr.argKinds.slice(1) };
    case 'accessor-place':
      return { ...expr, getSlot: -1, setSlot: -1 };
    case 'object-literal':
      return { ...expr, entries: expr.entries.slice(1) };
    case 'type-error':
      return { ...expr, message: '' };
    case 'reference-error':
      return { ...expr, name: '' };
    default:
      return { ...expr, type: wrongType(expr.type) };
  }
}

function brokenStatement(stmt: Statement): Statement {
  switch (stmt.kind) {
    case 'assignment':
      return { ...stmt, target: `${stmt.target}$missing` };
    case 'break-statement':
    case 'continue-statement':
      return { ...stmt, label: 'mutant$label' };
    case 'field-assignment':
      return { ...stmt, slot: stmt.slot + 1 };
    case 'try-statement': {
      const { catchBlock: _catch, finallyBlock: _finally, ...rest } = stmt;
      return rest;
    }
    case 'switch-statement':
      return { ...stmt, clauses: [...stmt.clauses, { statements: [] }, { statements: [] }] };
    case 'super-call':
      return { ...stmt, className: WRONG_NAME };
    default:
      return stmt;
  }
}

/** Rules that fire only on a node's own rare shape, or only once every operand is sound. The broad
 * mutant cannot reach them: it breaks a receiver first, and the rule behind it never runs. So this
 * one breaks nothing else, and `n` walks each kind through its own list. */
function targetedExpression(expr: Expression, n: number): Expression {
  const stray: NumberLiteral = {
    kind: 'number-literal',
    type: H_NUMBER,
    span: expr.span,
    value: 0,
  };
  const pick = (choices: readonly Expression[]): Expression => choices[n % choices.length] ?? expr;
  switch (expr.kind) {
    case 'method-call':
    case 'method-value':
      return { ...expr, method: `${expr.method}$missing` };
    case 'object-literal': {
      const first = expr.entries[0];
      return pick([
        expr.methods.length > 0
          ? {
              ...expr,
              methods: expr.methods.map((m, i) =>
                i === 0 ? { ...m, name: `${m.name}$missing` } : m,
              ),
            }
          : expr,
        first === undefined
          ? expr
          : { ...expr, entries: [...expr.entries, { ...first, name: `${first.name}$missing` }] },
        {
          ...expr,
          methodCopies: expr.methodCopies.map((copy) => ({ ...copy, at: expr.entries.length + 1 })),
        },
      ]);
    }
    case 'dyn-object-literal':
      return {
        ...expr,
        entries: expr.entries.map((entry) =>
          isAccessorEntry(entry) ? { name: entry.name, get: undefined, set: undefined } : entry,
        ),
      };
    case 'boundary-check':
      return { ...expr, type: hUnknown(false) };
    case 'extern-call':
      return { ...expr, error: expr.retKind === 'number' ? 'null' : 'negative' };
    case 'collection-op':
      return isSetOperation(expr.op)
        ? pick([
            { ...expr, args: [stray] },
            { ...expr, type: H_NUMBER },
          ])
        : { ...expr, op: expr.collection === 'map' ? 'add' : 'get' };
    case 'regexp-op':
      return REGEXP_OPS[expr.op].result === 'match' ? { ...expr, type: H_NUMBER } : expr;
    case 'match-read':
      return { ...expr, target: stray };
    case 'type-error':
      return { ...expr, message: '' };
    default:
      return expr;
  }
}

function targetedStatement(stmt: Statement): Statement {
  if (stmt.kind !== 'class-declaration') return stmt;
  const [first, ...rest] = stmt.methods;
  if (first === undefined) return stmt;
  const fn = { ...first.fn, params: first.fn.params.slice(1) };
  return { ...stmt, methods: [{ ...first, fn }, ...rest] };
}

function mutateTargeted(module: Module): Module {
  const seen = new Map<string, number>();
  const rewritten = rewriteModule(module, {
    expression(expr) {
      const n = seen.get(expr.kind) ?? 0;
      seen.set(expr.kind, n + 1);
      return targetedExpression(expr, n);
    },
    statement: (stmt) => [targetedStatement(stmt)],
  });
  const stray: Statement = { kind: 'return-statement', type: module.type, span: module.span };
  return { ...rewritten, statements: [...rewritten.statements, stray] };
}

/** Counted by kind, so a program with one rare node breaks that node on its first occurrence. The
 * first three of a kind each get a different break, and the rest stay honest: a tree broken
 * everywhere stops at its first node, and the checks below it never run. */
function mutate(module: Module): Module {
  const seen = new Map<string, number>();
  const occurrence = (kind: string): number => {
    const count = seen.get(kind) ?? 0;
    seen.set(kind, count + 1);
    return count;
  };
  return rewriteModule(module, {
    expression(expr) {
      switch (occurrence(expr.kind)) {
        case 0:
          return { ...expr, type: wrongType(expr.type) };
        case 1:
          return structural(expr);
        case 2:
          return { ...expr, type: { kind: 'type-param', name: 'T' } };
        default:
          return expr;
      }
    },
    statement(stmt) {
      return [occurrence(stmt.kind) < 3 ? brokenStatement(stmt) : stmt];
    },
  });
}

function writeMutant(dir: string, name: string, module: Module): void {
  writeFileSync(join(dir, `${name}.json`), hirJson(module));
  writeFileSync(join(dir, `${name}.verify.txt`), problemText(module));
}

/** `lowered`, `optimized`, `mutant` and `targeted`, each a dump and a `.verify.txt`. A fixture the
 * gate refuses has no HIR, and leaves none of them. */
export async function dumpFixture(fixture: CorpusFixture, dir: string): Promise<void> {
  const result = await dumpHir(fixture.path, fixture.mode, fixture.node, dir);
  if (result.kind !== 'dumped') return;
  writeFileSync(join(dir, 'lowered.verify.txt'), problemText(result.lowered));
  writeFileSync(join(dir, 'optimized.verify.txt'), problemText(result.optimized));
  writeMutant(dir, 'mutant', mutate(result.lowered));
  writeMutant(dir, 'targeted', mutateTargeted(result.lowered));
}

/** The corpus folds what programs happen to write, which is mostly small integers; a wrong sign on
 * `-7 % 2` went unnoticed by all of it. This is the rest of the domain. */
export function dumpFoldProbe(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const module = foldProbe();
  writeMutant(dir, 'lowered', module);
  writeMutant(dir, 'optimized', optimize(module, []));
}
