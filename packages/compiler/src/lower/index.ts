/** Lowering: TypeScript AST -> typed HIR.
 *
 * Transforms a gate-approved SourceFile into a typed HIR Module.
 * The gate has already ensured only the Phase 2 micro-subset is present.
 * This module raises STA4xxx for any construct outside the subset, which is
 * an internal error (the gate should have caught it).
 */

import * as ts from 'typescript';
import {
  bindingElementKey,
  brandDeclaringClass,
  constraintDeclaration,
  errorCtorName,
  INSTANCEOF_BUILTINS,
  isArrayReceiver,
  isDateReceiver,
  isGeneratorReceiver,
  isGlobalDate,
  isGlobalJson,
  isGlobalMath,
  isGlobalObject,
  isGlobalPromise,
  isGlobalString,
  isMatchReceiver,
  isRegExpReceiver,
  isSimpleBindingPattern,
  isSingleConstDeclarator,
  isStringReceiver,
  isVarDeclarationList,
  loopScopeOf,
  MATH_CONSTANTS,
  MATH_METHODS,
  OBJECT_STATICS,
  PROMISE_STATICS,
} from '../frontend/gate.ts';
import { globalFunctionOf, globalTypeofOf, isGlobalArray } from '../frontend/gate.ts';
import { numberConstant } from '../frontend/gate.ts';
import type { GlobalFunction } from '../frontend/gate.ts';
import {
  classReferenceTuple,
  genericAliasTarget,
  genericArgumentTuple,
  genericArrowKey,
  genericCallInstantiation,
  genericNewInstantiation,
  genericValueInstantiation,
  specializationName,
  substituteHType,
} from '../frontend/generics.ts';
import { hasTypeScriptAnnotation } from '../frontend/annotation.ts';
import {
  classifyExternDeclaration,
  classifyOutSlotCall,
  externDeclarationOfCall,
  headerOf,
  outInnerTag,
  outSlotDeclarationOf,
} from '../frontend/extern.ts';
import {
  DEFAULT_EXPORT_BINDING,
  declaredBindingName,
  exportTarget,
  namespaceModule,
  type ExportTarget,
} from '../frontend/modules.ts';
import { assertedBy, isCheckable, narrowedTo, sourceLocation } from '../frontend/narrowing.ts';
import * as frontendTypes from '../frontend/types.ts';
import { classDeclarationOf, accessorDeclaringClass, classDisplayName } from '../frontend/types.ts';
import { isClassFormationDeclarator } from '../frontend/types.ts';
import type {
  AccessorPlace,
  ArrayLength,
  ArrayLiteral,
  ArrayOp,
  ArrayOpName,
  BinaryOp,
  BinaryOperator,
  Block,
  CallExpr,
  ClassDeclaration,
  ClassMethod,
  CollectionNew,
  CollectionOp,
  CollectionOperation,
  ConsoleLogCall,
  ConsoleMethod,
  DateOperation,
  NumberOperation,
  DateStatic,
  Declaration,
  DynEntry,
  DynFieldAccess,
  DynMethodCall,
  DynObjectLiteral,
  ExternCall,
  Expression,
  OutGet,
  OutNew,
  FieldAccess,
  GlobalCallName,
  FieldCall,
  FunctionDeclaration,
  FunctionExpr,
  FunctionLength,
  Identifier,
  IfStatement,
  IndexAccess,
  InstanceOf,
  InstanceOfValue,
  IteratorView,
  LogicalOp,
  MatchField,
  MathMethod,
  MethodCall,
  MethodCopy,
  MethodValue,
  Module,
  NewExpr,
  NewValue,
  ObjectEntry,
  ObjectLiteral,
  ObjectStaticCall,
  ObjectStaticMethod,
  Parameter,
  PromiseInstanceMethod,
  PromiseStaticMethod,
  Provenance,
  RegExpField,
  RegExpOperation,
  ReturnStatement,
  Span,
  Statement,
  StringLength,
  StringOpName,
  StringStaticMethod,
  SuperCall,
  SwitchClause,
  TemplateLiteral,
  TypedOp,
  TypedOperation,
  UnaryOp,
  UpdateExpr,
  UpdatePlace,
} from '../hir/nodes.ts';
import {
  ARRAY_OPS,
  CONSOLE_METHODS,
  DATE_OPS,
  NUMBER_OPS,
  DATE_STATICS,
  errorHType,
  externKindHType,
  forOfElementType,
  isAccessorEntry,
  isComputedEntry,
  isSetOperation,
  MATCH_FIELDS,
  REGEXP_FIELDS,
  REGEXP_OPS,
  STRING_OPS,
  STRING_STATICS,
  TYPED_OPS,
  typedMember,
  typedResultType,
} from '../hir/nodes.ts';
import { GLOBAL_CALLS } from '../hir/nodes.ts';
import type { HField, HObject, HType } from '../hir/types.ts';
import {
  accessorName,
  accessorProperty,
  callableFieldSlot,
  fieldSlot,
  H_BOOLEAN,
  H_NUMBER,
  H_REGEXP,
  H_STRING,
  H_UNDEFINED,
  hArray,
  hasTypeParam,
  hFunction,
  hObject,
  hIterator,
  hPromise,
  hTypeAssignable,
  hTypeCanBeNullish,
  hTypeEquals,
  hTypeHasUnknown,
  hTypeName,
  hUnknown,
  objectFieldsPrefix,
} from '../hir/types.ts';
import type { Diagnostic } from '../support/diagnostics.ts';
import { UNMAPPED_FILE, type PositionMapper } from '../support/sourcemap.ts';
import { diagnosticFromNode, syntaxKindName } from '../support/diagnostics.ts';
import type { CaptureMap, FunctionLike } from './captures.ts';
import { analyzeCaptures, enclosingFunction, isFunctionLike, RECEIVER_NAME } from './captures.ts';
import { Scope, resetShadowCounter } from './scope.ts';

/* What HIR name each source declaration ended up with (plan.md §8 step 14).
 *
 * Normally the source name, so nothing needs this map. It exists for the one case where it is not:
 * a declaration that SHADOWS a visible binding is emitted under a fresh name, and the capture
 * analysis -- which resolves references by SYMBOL, before any of that has happened -- has to be
 * told what the declaration is called in the HIR. Keyed by the declaration NODE, because that is
 * the one thing both sides know: two variables named `x` are one string and two nodes.
 *
 * A WeakMap, not a Map: a program's worth of declarations is reached only through these nodes, and
 * a compile that lowers several files should not keep them alive behind the caller's back. */
const hirNameOfDeclaration = new WeakMap<ts.Declaration, string>();

/** The HIR spelling of a declaration, or `undefined` when it was never declared through a Scope
 * (a class, an import, a name outside this subset) -- the caller keeps the source name then. */
function hirNameOf(decl: ts.Declaration | undefined): string | undefined {
  return decl === undefined ? undefined : hirNameOfDeclaration.get(decl);
}

/** Token -> HIR operator. A table rather than a chain of `if`s so that the gate's accept set and
 * the HIR's vocabulary can be compared against it by eye: a token the gate lets through and this
 * map does not name is the invariant break that produces an STA4036. */
const BINARY_OPERATORS = new Map<ts.SyntaxKind, BinaryOperator>([
  [ts.SyntaxKind.PlusToken, '+'],
  [ts.SyntaxKind.MinusToken, '-'],
  [ts.SyntaxKind.AsteriskToken, '*'],
  [ts.SyntaxKind.SlashToken, '/'],
  [ts.SyntaxKind.PercentToken, '%'],
  [ts.SyntaxKind.LessThanToken, '<'],
  [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.LessThanEqualsToken, '<='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '==='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.EqualsEqualsToken, '=='],
  [ts.SyntaxKind.ExclamationEqualsToken, '!='],
  [ts.SyntaxKind.AmpersandToken, '&'],
  [ts.SyntaxKind.BarToken, '|'],
  [ts.SyntaxKind.CaretToken, '^'],
  [ts.SyntaxKind.LessThanLessThanToken, '<<'],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, '>>'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, '>>>'],
  [ts.SyntaxKind.AsteriskAsteriskToken, '**'],
  [ts.SyntaxKind.CommaToken, ','],
  [ts.SyntaxKind.InKeyword, 'in'],
]);

const LOGICAL_OPERATORS = new Map<ts.SyntaxKind, LogicalOp['operator']>([
  [ts.SyntaxKind.AmpersandAmpersandToken, '&&'],
  [ts.SyntaxKind.BarBarToken, '||'],
  [ts.SyntaxKind.QuestionQuestionToken, '??'],
]);

const UNARY_OPERATORS = new Map<ts.SyntaxKind, UnaryOp['operator']>([
  [ts.SyntaxKind.MinusToken, '-'],
  [ts.SyntaxKind.PlusToken, '+'],
  [ts.SyntaxKind.ExclamationToken, '!'],
  [ts.SyntaxKind.TildeToken, '~'],
  [ts.SyntaxKind.VoidKeyword, 'void'],
]);

type Mode = 'ts' | 'js';

/* plan.md §8 step 40 (plan §0.8): the build's mode, threaded in from the CLI entry points for
 * diagnostic LABELING only. Lowering never branches on this value -- no `mode ===` check may
 * appear anywhere below except inside `lowerDiagnostic`, which copies it into the diagnostic's
 * `mode` field. Set once per `lowerProgram` call; lowering is synchronous, so no call can
 * observe another's value. */
let lowerDiagMode: Mode = 'ts';

/** `diagnosticFromNode` with the current build's mode already filled in (see `lowerDiagMode`).
 * Every lowering diagnostic goes through here, so a `--mode=js` build labels its STA4xxx `[js]`
 * instead of the hardcoded `[ts]` step 40 found. Label-only: the arguments are the same ones
 * the call sites always passed, and nothing here (or below) branches on the mode. */
function lowerDiagnostic(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  code: string,
  diagClass: 'error' | 'never' | 'not-yet' | 'runtime' | 'internal',
  message: string,
): Diagnostic {
  return diagnosticFromNode(node, sourceFile, code, diagClass, lowerDiagMode, message);
}

/** The vendor module and its source map (plan.md §11d T12.1 step 5, docs/BUNDLER.md §6): spans
 * in that one file name the original package file and line, so `#line` and the runtime's
 * call-site strings point where the code was written. Set once per `lowerProgram` call. */
export interface SpanRemap {
  /** The vendor module's fileName, as the program holds it. */
  readonly file: string;
  readonly map: PositionMapper;
}

let spanRemap: SpanRemap | undefined;

/** Where `start` in `sourceFile` came from: itself, or through the vendor map. A position the
 * bundler mapped to nothing (a runtime helper it wrote) answers `<package bundle>` and the
 * bundle's own line, never a user file. */
function remapPosition(
  start: number,
  sourceFile: ts.SourceFile,
): { readonly file: string; readonly line: number; readonly column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  if (spanRemap === undefined || sourceFile.fileName !== spanRemap.file) {
    return { file: sourceFile.fileName, line: line + 1, column: character + 1 };
  }
  return (
    spanRemap.map(line + 1, character + 1) ?? {
      file: UNMAPPED_FILE,
      line: line + 1,
      column: character + 1,
    }
  );
}

/** `sourceLocation`, through the vendor map: the `file:line:col` a failed check reports. */
function checkLocation(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (spanRemap === undefined || sourceFile.fileName !== spanRemap.file) {
    return sourceLocation(node, sourceFile);
  }
  const at = remapPosition(node.getStart(sourceFile), sourceFile);
  return `${at.file}:${String(at.line)}:${String(at.column)}`;
}

export function lowerSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  mode: Mode = 'ts',
): { readonly module: Module | null; readonly diagnostics: readonly Diagnostic[] } {
  return lowerProgram([sourceFile], checker, new Set(), mode);
}

/* Lowers a whole program -- the module-graph files in topological order, entry LAST -- into ONE
 * merged Module (plan.md §5 Task 3.11). The merge is the binding map: it is shared across files,
 * so a dependency's top-level names are already registered when its importers lower, and an
 * imported identifier resolves to the exporting file's own binding by name. The graph walk has
 * already refused what would make that unsound: cycles (STA3001) and cross-file name collisions. */
/** Nesting of functions being lowered. Zero means module top-level: an `await` there makes
 * the merged program an async module (Phase 5 step 9). */
let functionNesting = 0;

/** The operators that coerce both operands through ToNumber (docs/NUMERIC.md §6.3): `-`
 * `*` `/` `%` and `**`. `+` concatenates on strings and the relational, equality and bitwise
 * operators dispatch at runtime — none of them is a coercion, so none of them comes here. */
const COERCING_ARITHMETIC: ReadonlySet<BinaryOperator> = new Set(['-', '*', '/', '%', '**']);

/** A `binary-op` whose result the checker could not type, because js mode declined to refuse
 * the program (plan.md §8 step 37): on a suppressed TS2362/TS2363 the checker's error type maps
 * to Unknown, which the verifier's STA4013 would report as an internal error, while arithmetic on
 * coerced operands always answers a number. The operands keep their true types — the verifier
 * admits the coercible primitives (`string`, `boolean`, `null`, `undefined`) there, since the
 * emitter coerces every arithmetic operand through `jsrt_to_number` regardless of its static
 * type, and that coercion is spec-exact for exactly those four (step 27's StringNumericLiteral
 * grammar, `true`→1, `null`→0, `undefined`→NaN; a primitive cannot carry a `valueOf` to run, so
 * no user code hides behind them). Restamping an operand instead would break the verifier's
 * STA4010 identifier rule, which pins every identifier use to its binding's type. The gate
 * refuses every composite operand (an object reaches ToPrimitive, which runs user code), and
 * bigint never reaches here (the checker's TS2365 is not suppressed). In ts mode the checker
 * stops the build before lowering, so the repair branch never fires there. */
function arithmeticBinOp(
  operator: BinaryOperator,
  left: Expression,
  right: Expression,
  span: Expression['span'],
  fallback: HType,
): BinaryOp {
  return {
    kind: 'binary-op',
    type: COERCING_ARITHMETIC.has(operator) && fallback.kind === 'unknown' ? H_NUMBER : fallback,
    span,
    operator,
    left,
    right,
  };
}

/** HIR names of named-function-expression self bindings; assignment is a TypeError. */
const immutableSelfBindings = new Set<string>();
/** Optional-chain cut points (plan.md §8 step 24): the TS node whose lowered value the enclosing
 * chain holds in its frame temp, mapped to the leaf type the consequent reads it at. Installed
 * around one consequent lowering and restored after, so nesting is a disciplined stack and
 * nothing leaks across expressions — each TS node is lowered once, so a stale entry could only
 * be hit by lowering the same node twice, which is the re-lowering the map exists to prevent.
 * Cleared per `lowerProgram` with the module state beside it. */
const optionalChainCuts = new Map<ts.Node, HType>();
/** Whether the current `lowerProgram` seeded any `\u0000dynamic:` bindings. Set alongside the
 * seeding from the same `runtimeDynamicSymbols`, so the two cannot disagree; reset per
 * `lowerProgram` like the module state beside it (in-process callers reuse this module). */
let hasRuntimeDynamicSymbols = false;
/** Whether the current `lowerProgram` seeded any `\u0000dynamic-return:` bindings (plan.md §8
 * step 45). Set alongside that seeding the same way; reset per `lowerProgram` with the rest. */
let hasDynamicReturnSymbols = false;
/** Set when an await is lowered at functionNesting === 0. Reset per lowerProgram. */
let moduleAwaits = false;
/** The current file's class specializations, for generic declarations nested inside function
 * and block bodies: `lowerStatement` emits a nested generic's carrier and tuples at its own
 * position, and looks them up here by declaration node. Set per file beside the collection
 * that computes it, reset per `lowerProgram` with the module state above — lowering is
 * synchronous, so no nested lowering can observe another file's list. */
let currentFileClassSpecs: readonly ClassSpecialization[] = [];
/** Each module's own top-level scope (plan.md §11c T11.5a), recorded as `lowerProgram` reaches
 * the file. An import resolves through the EXPORTER's scope, which topological order has always
 * finished lowering by then. Reset per `lowerProgram` with the module state above. */
const moduleScopes = new Map<ts.SourceFile, Scope>();
/** The hidden global holding each module's namespace object (`import * as ns`, `export * as ns
 * from`, a literal `import()`), created once, at the first importer that needs it. */
const namespaceObjects = new Map<ts.SourceFile, string>();
/** Each dependency module's position in the program order, which qualifies the specializations
 * of its generic functions (`functionSpecializationName`). The entry has none. Reset per
 * `lowerProgram` with the module state above. */
const dependencyOrdinals = new Map<ts.SourceFile, number>();
/** Every module of the program being lowered, in program order (the override question spans
 * them all; see `isOverridden`). */
let programModules: readonly ts.SourceFile[] = [];

/** The name a generic FUNCTION's specialization binds under: `pick<number>` for the entry's own
 * generics, `pick<number>@1` for a dependency's (plan.md §11c T11.5a).
 *
 * Two modules may each declare a generic `pick`, and the tuple alone would give both one
 * specialization. The qualifier rides after the tuple, so the name stays unspellable and every
 * reader that strips the tuple for printing still finds the source name; the printable name a
 * closure carries is the declaration's own either way. Generic CLASSES do not need it: the
 * gate keeps a module-level generic class name unique across the program. */
function functionSpecializationName(
  declaration: ts.Node,
  key: string,
  typeArguments: readonly HType[],
): string {
  const name = specializationName(key, typeArguments);
  const ordinal = dependencyOrdinals.get(declaration.getSourceFile());
  return ordinal === undefined ? name : `${name}@${String(ordinal)}`;
}

export function lowerProgram(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  runtimeDynamicSymbols: ReadonlySet<ts.Symbol> = new Set(),
  mode: Mode = 'ts',
  remap?: SpanRemap,
): { readonly module: Module | null; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  lowerDiagMode = mode;
  spanRemap = remap;
  const bindings = Scope.root();
  // Steps 44c/45/46 run before anything is lowered: an Unknown (or mismatched) value reaching
  // a fixed-shape slot widens the receiving binding, and the widening must be visible to the
  // declaration itself, not only to later uses. Unioned with `runtimeDynamicSymbols` — which
  // also feeds the walk as `knownDynamic`, so an already-widened binding counts as dynamic.
  // Step 46 drives the slots edge and the returns edge as ONE joint fixpoint
  // (`collectDynamicWidening`): a marked call feeding a fixed-annotated declaration
  // (`const y: Fixed = f()`) widened neither edge when the two ran blind, miscompiling to
  // silent garbage. Return marks now feed the slots pass as `knownReturn`, slot marks feed
  // the returns pass as `knownDynamic`, and the two keyspaces stay disjoint — identifier
  // probes consult only the `dynamic:` marks, call probes only the `dynamic-return:` ones.
  const dynamicFqns = new Set<string>();
  for (const symbol of runtimeDynamicSymbols) {
    dynamicFqns.add(checker.getFullyQualifiedName(symbol));
  }
  const dynamicReturnFqns = collectDynamicWidening(files, checker, dynamicFqns);
  hasRuntimeDynamicSymbols = dynamicFqns.size > 0;
  for (const fqn of dynamicFqns) {
    bindings.set(`\u0000dynamic:${fqn}`, hUnknown(false));
  }
  // Step 45's twin: a dynamic value RETURNED where a fixed object/array type is declared
  // widens the CALL, not the declaration — the declared return type is an overload and
  // vtable contract callers were compiled against, so the declaration keeps its shape and
  // every call result answers Unknown, routing uses through the shape table.
  hasDynamicReturnSymbols = dynamicReturnFqns.size > 0;
  for (const fqn of dynamicReturnFqns) {
    bindings.set(`\u0000dynamic-return:${fqn}`, hUnknown(false));
  }
  const statements: Statement[] = [];
  functionNesting = 0;
  moduleAwaits = false;
  // Fresh-process parity: spawn-per-fixture callers got new module state for free, but in-process
  // callers (golden/subset/test262 runners) reuse this module across programs. A leaked
  // `immutableSelfBindings` entry miscompiled `block_scope.js` after `named_function_expression.js`
  // (spurious STA4020 on `inner += 1`); the counters only rename temps, and resetting them keeps
  // emitted C identical for identical input either way.
  immutableSelfBindings.clear();
  optionalChainCuts.clear();
  bindTempId = 0;
  resetShadowCounter();
  currentFileClassSpecs = [];
  moduleScopes.clear();
  namespaceObjects.clear();
  dependencyOrdinals.clear();
  const entry = files.at(-1);
  if (entry === undefined) {
    throw new Error('lowerProgram requires at least one file');
  }
  files.slice(0, -1).forEach((file, ordinal) => dependencyOrdinals.set(file, ordinal));
  programModules = files;
  let current = entry;
  // Every module is a scope of its own under the shared root (plan.md §11c T11.5a): a module sees
  // its own top-level names and its imports, never another module's. All of them share the
  // module unit's slot space, so a spelling two modules declare gets a fresh name in the second;
  // the entry claims its spellings first, so it is a dependency's binding that is renamed.
  const entryScope = bindings.child();
  entryScope.claim(topLevelNames(entry));

  try {
    for (const sourceFile of files) {
      current = sourceFile;
      // Monomorphization runs before anything is lowered, because a specialization is a FUNCTION
      // the module contains and the module's own statements may call it. Nothing is cloned: a
      // specialization is the generic's own AST lowered a second time with a substitution in
      // scope. Two files instantiating one generic at the same tuple produce one specialization:
      // the name (`box<number>`) is unspellable from source, so a binding under it can only be an
      // earlier file's copy of the same function.
      const collected = collectSpecializations(sourceFile, checker, diagnostics);
      if (collected === null) {
        return { module: null, diagnostics };
      }
      const specializations = collected.functions.filter((spec) => !bindings.has(spec.name));
      // Class tuples and carriers bind under their mangled names for the same reason functions
      // do: a second file instantiating one at the same tuple reuses the first file's copy.
      const classSpecializations = collected.classes.filter((spec) => !bindings.has(spec.name));
      // The nested-generic lookup below reads this file's list while its statements lower.
      currentFileClassSpecs = collected.classes;
      const scope = sourceFile === entry ? entryScope : bindings.child();
      moduleScopes.set(sourceFile, scope);
      // Import bindings exist before the module body runs (ES module instantiation), so they are
      // bound before anything hoists; a namespace object an import needs is built here too.
      if (!bindImports(sourceFile, scope, bindings, statements, checker, diagnostics)) {
        return { module: null, diagnostics };
      }
      hoistFunctionDeclarations(sourceFile.statements, checker, scope);
      for (const specialization of specializations) {
        bindings.set(specialization.name, specializationType(specialization, checker));
      }
      for (const specialization of classSpecializations) {
        bindings.set(specialization.name, classSpecType(specialization, checker));
      }
      // Functions first, then `var`: a `var x` that shares a name with a function declaration
      // does not reinitialize the slot to `undefined` (the spec instantiates the function, then
      // skips the var). Registering functions above and skipping already-bound names in the
      // hoist is that order.
      const hoistedVars = hoistVarDeclarations(sourceFile, sourceFile, checker, scope, diagnostics);
      if (hoistedVars === null) {
        return { module: null, diagnostics };
      }

      // A generic's body reads ITS module's names, wherever it was instantiated from.
      const homeScope = (declaration: ts.Node): Scope =>
        moduleScopes.get(declaration.getSourceFile()) ?? scope;
      for (const specialization of specializations) {
        const declaration = lowerSpecialization(
          specialization,
          sourceFile,
          checker,
          homeScope(specialization.declaration),
          diagnostics,
        );
        if (declaration === null) {
          return { module: null, diagnostics };
        }
        statements.push(declaration);
      }
      // Specializations of classes declared in ANOTHER file: they have no declaration site
      // here, and their nodes emit no runtime code (only carriers do, and the declaring file
      // always emits those) — so they go above with the functions, in collection order.
      for (const specialization of classSpecializations) {
        if (specialization.declaration.getSourceFile() === sourceFile) {
          continue;
        }
        const declaration = lowerClassSpecialization(
          specialization,
          sourceFile,
          checker,
          homeScope(specialization.declaration),
          diagnostics,
        );
        if (declaration === null) {
          return { module: null, diagnostics };
        }
        statements.push(declaration);
      }
      statements.push(...hoistedVars);
      for (const node of sourceFile.statements) {
        // A generic declaration lowers to nothing: its specializations are already above, and the
        // name itself binds no value (the gate refuses reading one).
        if (ts.isFunctionDeclaration(node) && isGenericDeclaration(node)) {
          continue;
        }
        // A generic class lowers to its carrier and specializations at its own position
        // (not above, where functions go): static initializers are runtime code, and their order
        // against the surrounding statements is observable. The carrier — statics and static
        // blocks, emitted for every declaration whether used or not, exactly as for an ordinary
        // class — comes first, so a tuple's method bodies read bound statics.
        if (ts.isClassDeclaration(node) && isGenericClass(node)) {
          const lowered = lowerGenericClassDeclaration(
            node,
            classSpecializations.filter((spec) => spec.declaration === node),
            sourceFile,
            checker,
            scope,
            diagnostics,
          );
          if (lowered === null) {
            return { module: null, diagnostics };
          }
          statements.push(...lowered);
          continue;
        }
        // `export default <expression>` evaluates once, into the module's `*default*` binding.
        if (ts.isExportAssignment(node)) {
          const declared = lowerExportAssignment(node, sourceFile, checker, scope, diagnostics);
          if (declared === null) {
            return { module: null, diagnostics };
          }
          statements.push(declared);
          continue;
        }
        // The rest of module syntax lowers to nothing: an import was bound above, to the
        // exporter's own binding, and `export { x }` / `export … from` are metadata about
        // bindings that already exist.
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          continue;
        }
        // Type-only declarations erase: `interface` and `type` bind no value and emit no code
        // (docs/SUBSET.md), so there is no HIR to build for them. The gate accepts them; the
        // lowering drops them here, and uses of the name are ordinary annotations the checker
        // already resolved to a shape.
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
          continue;
        }
        const stmt = lowerStatement(node, sourceFile, checker, scope, diagnostics);
        if (stmt === null) {
          return { module: null, diagnostics };
        }
        statements.push(stmt);
      }
    }

    // Unioned across the graph, because the program has ONE module environment and each file
    // contributes its own per-iteration top-level bindings to it. Concatenation is safe without a
    // dedupe: the files share the module unit's slot space, so a spelling two files declare has
    // two HIR names (plan.md §11c T11.5a).
    //
    // Each file's list is already in the analysis's slot order, and that order is what the
    // captures' `index` fields mean -- so this MUST NOT re-sort. It used to, back when every name
    // was its own source spelling and sorting the union was idempotent; a renamed binding's HIR
    // name starts with U+0000, so a second sort moves it to the front and every index after it
    // points one slot off (plan-notes 216).
    const envVars = files.flatMap((file) => {
      const info = capturesFor(file, checker).get(file);
      return (info?.envVars ?? []).map((v, i) => hirNameOf(info?.envDecls[i]) ?? v);
    });

    const module: Module = {
      kind: 'module',
      type: H_UNDEFINED,
      span: makeSpan(0, entry.getEnd(), entry),
      fileName: entry.fileName,
      statements,
      isAsync: moduleAwaits,
      envVars,
    };

    return { module, diagnostics };
  } catch (error) {
    // Ensure no exception escapes — all errors must be diagnostics
    diagnostics.push(
      lowerDiagnostic(
        current,
        current,
        'STA4030',
        'internal',
        `internal error during lowering: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { module: null, diagnostics };
  }
}

/** `label` is set only when re-entering from a LabeledStatement, and is meaningful only for the
 * loop and switch cases — every other statement ignores it, because the gate has already ensured
 * a label never reaches one. */
function lowerStatement(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  label?: string,
): Statement | null {
  // Variable declaration (let/const)
  if (ts.isVariableStatement(node)) {
    return lowerDeclarationList(
      node.declarationList,
      node,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
  }

  // Expression statement (including assignments and console.log)
  // `super(...)`. The base class comes from the RECEIVER's own type rather than from threaded
  // context: `bases[0]` is the immediate base, and the receiver is in scope for exactly the
  // constructor bodies where a super call is legal. The gate proved the position.
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return lowerSuperCall(node.expression, node, sourceFile, checker, bindings, diagnostics);
  }

  if (ts.isExpressionStatement(node)) {
    return lowerExpressionAsStatement(
      node.expression,
      node,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
  }

  // If statement
  if (ts.isIfStatement(node)) {
    const condition = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!condition) {
      return null;
    }

    const consequent = lowerBody(node.thenStatement, sourceFile, checker, bindings, diagnostics);
    if (!consequent) {
      return null;
    }

    // `else if` needs no special case: an `else` whose statement is an IfStatement wraps that if
    // in a Block exactly as any other single statement, and the emitter's nesting reproduces it.
    let alternate: Block | undefined;
    if (node.elseStatement) {
      const result = lowerBody(node.elseStatement, sourceFile, checker, bindings, diagnostics);
      if (!result) {
        return null;
      }
      alternate = result;
    }

    const stmt: IfStatement = {
      kind: 'if-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      condition,
      consequent,
      ...(alternate && { alternate }),
    };
    return stmt;
  }

  // `while` and `do/while` differ only in which node kind they are and whether the test runs
  // before the first iteration -- everything else about lowering them is identical.
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    const condition = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!condition) {
      return null;
    }
    const body = lowerBody(node.statement, sourceFile, checker, bindings, diagnostics);
    if (!body) {
      return null;
    }
    return {
      kind: ts.isWhileStatement(node) ? 'while-statement' : 'do-while-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      condition,
      body,
      ...(label && { label }),
      ...(loopNeedsPerIterationEnv(node, checker) && { perIterationEnv: true as const }),
    };
  }

  if (ts.isForStatement(node)) {
    return lowerFor(node, sourceFile, checker, bindings, diagnostics, label);
  }

  if (ts.isForOfStatement(node)) {
    return lowerForOf(node, sourceFile, checker, bindings, diagnostics, label);
  }

  if (ts.isForInStatement(node)) {
    return lowerForIn(node, sourceFile, checker, bindings, diagnostics, label);
  }

  if (ts.isSwitchStatement(node)) {
    return lowerSwitch(node, sourceFile, checker, bindings, diagnostics, label);
  }

  if (ts.isClassDeclaration(node)) {
    // A nested generic class lowers to its carrier and specializations at its own position,
    // exactly as a module-scope one does above: the method bodies close over this scope, so
    // captures resolve like any nested ordinary class's. The gate kept the name unique across
    // the program, so the mangled tuples name this declaration alone. One statement position
    // holds several declarations, so they are wrapped flat — the same wrapper static blocks use.
    if (isGenericClass(node)) {
      const mine = currentFileClassSpecs.filter((spec) => spec.declaration === node);
      const lowered = lowerGenericClassDeclaration(
        node,
        mine,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      if (lowered === null) {
        return null;
      }
      const [only] = lowered;
      if (lowered.length === 1 && only !== undefined) {
        return only;
      }
      return {
        kind: 'block',
        type: H_UNDEFINED,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        flatten: true,
        statements: lowered,
      };
    }
    return lowerClass(node, sourceFile, checker, bindings, diagnostics);
  }

  if (ts.isThrowStatement(node)) {
    const value = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!value) {
      return null;
    }
    return {
      kind: 'throw-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value,
    };
  }

  if (ts.isTryStatement(node)) {
    const tryBlock = lowerBlock(node.tryBlock, sourceFile, checker, bindings.child(), diagnostics);
    if (!tryBlock) {
      return null;
    }
    let catchBinding: string | undefined;
    let catchBlock: Block | undefined;
    if (node.catchClause !== undefined) {
      // The caught value is Unknown by decree, not by inference: anything can be thrown, so the
      // binding enters scope as an unchecked value and a narrowing of it goes through the same
      // BoundaryCheck machinery as any other unknown (Task 3.5). The scope copy is what confines
      // it to the catch block.
      const scope = bindings.child();
      const declared = node.catchClause.variableDeclaration?.name;
      if (declared !== undefined && ts.isIdentifier(declared)) {
        // `catch (e)` is a block-scoped binding, so it shadows like any other: the copy above is
        // what ends its scope at the block, and the rename is what keeps `catch (e)` from
        // overwriting an outer `e` for the length of the handler.
        catchBinding = scope.declare(declared.text, hUnknown(false));
        hirNameOfDeclaration.set(declared, catchBinding);
      } else if (declared !== undefined) {
        catchBinding = CATCH_VALUE;
        scope.set(CATCH_VALUE, hUnknown(false));
        bindPatternNames(declared, checker, scope);
      }
      const lowered = lowerBlock(node.catchClause.block, sourceFile, checker, scope, diagnostics);
      if (!lowered) {
        return null;
      }
      if (declared !== undefined && !ts.isIdentifier(declared) && catchBinding !== undefined) {
        const src: Identifier = {
          kind: 'identifier',
          type: hUnknown(false),
          span: makeSpan(declared.getStart(sourceFile), declared.getWidth(sourceFile), sourceFile),
          name: catchBinding,
        };
        const parts = lowerBindingPattern(
          declared,
          src,
          'let',
          declared,
          sourceFile,
          checker,
          scope,
          diagnostics,
        );
        if (parts === null) {
          return null;
        }
        catchBlock = { ...lowered, statements: [...parts, ...lowered.statements] };
      } else {
        catchBlock = lowered;
      }
    }
    let finallyBlock: Block | undefined;
    if (node.finallyBlock !== undefined) {
      const lowered = lowerBlock(
        node.finallyBlock,
        sourceFile,
        checker,
        bindings.child(),
        diagnostics,
      );
      if (!lowered) {
        return null;
      }
      finallyBlock = lowered;
    }
    return {
      kind: 'try-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      tryBlock,
      ...(catchBinding !== undefined && { catchBinding }),
      ...(catchBlock !== undefined && { catchBlock }),
      ...(finallyBlock !== undefined && { finallyBlock }),
    };
  }

  if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
    const target = node.label?.text;
    return {
      kind: ts.isBreakStatement(node) ? 'break-statement' : 'continue-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      ...(target !== undefined && { label: target }),
    };
  }

  // A label on a loop or switch is handed to that node. Anything else becomes a labelled block
  // so `break foo` has somewhere to land (plan.md §8 step 12 family b).
  if (ts.isLabeledStatement(node)) {
    const inner = node.statement;
    const loopOrSwitch =
      ts.isForStatement(inner) ||
      ts.isForOfStatement(inner) ||
      ts.isForInStatement(inner) ||
      ts.isWhileStatement(inner) ||
      ts.isDoStatement(inner) ||
      ts.isSwitchStatement(inner);
    if (loopOrSwitch) {
      return lowerStatement(inner, sourceFile, checker, bindings, diagnostics, node.label.text);
    }
    const lowered = lowerStatement(inner, sourceFile, checker, bindings, diagnostics);
    if (lowered === null) {
      return null;
    }
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    if (lowered.kind === 'block' && lowered.label === undefined) {
      return { ...lowered, label: node.label.text };
    }
    return {
      kind: 'block',
      type: H_UNDEFINED,
      span,
      label: node.label.text,
      statements: [lowered],
    };
  }

  // Block
  if (ts.isBlock(node)) {
    return lowerBlock(node, sourceFile, checker, bindings.child(), diagnostics);
  }

  // `function f(...) { ... }`. The binding is already in `bindings` -- hoisting put it there
  // before the first statement of this body was lowered, which is what makes a call that appears
  // above the declaration resolve.
  if (ts.isFunctionDeclaration(node)) {
    // `export default function () {}` binds the module's `*default*` and prints as `default`.
    const name = declaredBindingName(node);
    if (name === undefined) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4031',
          'internal',
          'function declaration without a name',
        ),
      );
      return null;
    }
    // An overload signature declares nothing to emit; the implementation runs. The gate vetted
    // that one exists, so this skips unconditionally — a lone signature never reaches lowering.
    // (The class arms skip the same way; hoisting already bound the name to the implementation.)
    if (node.body === undefined) {
      return emptyBlockAt(node, sourceFile);
    }
    const lowered = lowerFunction(node, sourceFile, checker, bindings, diagnostics);
    if (lowered === null) {
      return null;
    }
    const fn = node.name === undefined ? { ...lowered, name: lowered.name ?? 'default' } : lowered;
    const declaration: FunctionDeclaration = {
      kind: 'function-declaration',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      // The name hoisting gave it, which is the source's own unless the declaration shadows one
      // (plan.md §8 step 14). `fn.name` keeps the SOURCE spelling, because that is what a
      // function's `name` is and what prints.
      name: bindings.hirName(name),
      fn,
    };
    return declaration;
  }

  // `return;` / `return e;`
  if (ts.isReturnStatement(node)) {
    let value: Expression | undefined;
    if (node.expression !== undefined) {
      const lowered = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      value = returnBoundary(lowered, node.expression, sourceFile, checker);
    }
    const statement: ReturnStatement = {
      kind: 'return-statement',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      ...(value !== undefined && { value }),
    };
    return statement;
  }

  // Empty statement (semicolon)
  if (ts.isEmptyStatement(node)) {
    // Empty statements are acceptable but we don't generate an HIR node for them
    // Instead, return a no-op block
    return emptyBlockAt(node, sourceFile);
  }

  // A nested type-only declaration (block or function scope) erases the same way a top-level
  // one does -- the top-level loop skips those outright, but a nested one reaches this
  // function, so it lowers to the same nothing `;` does rather than an internal error.
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return emptyBlockAt(node, sourceFile);
  }

  // Anything else is an internal error
  diagnostics.push(
    lowerDiagnostic(
      node,
      sourceFile,
      'STA4031',
      'internal',
      `unexpected statement kind: ${syntaxKindName(node.kind)}`,
    ),
  );
  return null;
}

/** Check each argument against the callee's parameter types — a dynamic value reaching an
 * annotated parameter is the call-shaped form of the same edge `maybeBoundary` wraps. A parameter
 * a TypeScript file annotated also checks a CONCRETE argument of another type (`edgeBoundary`):
 * js mode suppresses the checker's TS2345, and `inc(jsLabel(1))` passed a string into a `number`
 * parameter (plan-notes 308). A `.js` callee's JSDoc keeps Node's coercion. `signature` is the
 * callee's (or method's) type when the HIR has one; a constructor has none, so its parameters
 * answer from their annotations. A spread argument shifts every later slot, so a call with one
 * keeps the dynamic-value check alone, and so does a callee resolved to a declaration with no body:
 * an overload signature need not be the one the call selected (`calleeParameters` answers the
 * first), and a `.d.ts` has nothing to protect. */
function checkCallArgs(
  signature: HType | undefined,
  args: Expression[],
  node: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Expression[] {
  const sites = node.arguments ?? [];
  const callee = sites.some(ts.isSpreadElement) ? undefined : calleeParameters(node, checker);
  const declared =
    callee !== undefined &&
    isFunctionLike(callee.declaration) &&
    callee.declaration.body !== undefined
      ? callee.parameters
      : undefined;
  return args.map((arg, i) => {
    const site = sites[i];
    const param = declared?.[i];
    const annotation = param?.type;
    const expected =
      signature?.kind === 'fn'
        ? signature.params[i]
        : annotation === undefined
          ? undefined
          : frontendTypes.tsTypeToHType(checker.getTypeFromTypeNode(annotation), checker);
    if (expected === undefined || site === undefined) {
      return arg;
    }
    return param !== undefined &&
      param.dotDotDotToken === undefined &&
      hasTypeScriptAnnotation(param)
      ? edgeBoundary(arg, expected, site, sourceFile)
      : maybeBoundary(arg, expected, site, sourceFile);
  });
}

/** The return edge: a returned value checked against the type its context expects. A dynamic value
 * meets `maybeBoundary`; a concrete value of ANOTHER type is checked too (`edgeBoundary`) when a
 * TypeScript file annotated the enclosing function's return -- js mode suppresses the checker's
 * TS2322, and `function g(): number { return jsLabel(2) }` returned a string as a `number`
 * (plan-notes 308). Async functions and generators are left out: their annotation is a `Promise`
 * or a generator, not the type a returned value must have. */
function returnBoundary(
  value: Expression,
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Expression {
  const contextual = checker.getContextualType(expression);
  if (contextual === undefined) {
    return value;
  }
  const expected = frontendTypes.tsTypeToHType(contextual, checker);
  const fn = enclosingFunction(expression);
  return fn !== undefined &&
    fn.asteriskToken === undefined &&
    fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
    hasTypeScriptAnnotation(fn)
    ? edgeBoundary(value, expected, expression, sourceFile)
    : maybeBoundary(value, expected, expression, sourceFile);
}

/** Wrap `value` in a BoundaryCheck when it is Unknown and `expected` is a tag the runtime
 * can settle (plan.md §8 step 5). This is the EDGE: a dynamic value reaching an annotated
 * binding. A lying JSDoc never gets here — checkJs makes that a compile error. */
function maybeBoundary(
  value: Expression,
  expected: HType,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): Expression {
  if (value.type.kind !== 'unknown' || !isCheckable(expected)) {
    return value;
  }
  return boundaryCheck(value, expected, node, sourceFile);
}

/** `maybeBoundary` for the declaration and assignment edges, which also check a CONCRETE value
 * of another type reaching a checkable binding. Only js mode gets here: the checker's 2322 is
 * suppressed, and the frontend keeps an annotated `.ts` binding's type rather than widening it
 * (`keepsCheckedAnnotation`, plan-notes 301). `const n: number = jsLabel(10)` then fails with
 * `STA2001` at run time instead of binding a string as a `number`. */
function edgeBoundary(
  value: Expression,
  expected: HType,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): Expression {
  if (
    value.type.kind !== 'unknown' &&
    isCheckable(expected) &&
    !hTypeAssignable(value.type, expected)
  ) {
    return boundaryCheck(value, expected, node, sourceFile);
  }
  return maybeBoundary(value, expected, node, sourceFile);
}

function boundaryCheck(
  value: Expression,
  expected: HType,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): Expression {
  return {
    kind: 'boundary-check',
    type: expected,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    value,
    where: checkLocation(node, sourceFile),
  };
}

/** Whether a value of HType `value` can inhabit a fixed-shape slot of HType `target` without
 * widening the slot to Unknown: only a slot-EXACT layout. Static reads load `fields[slot]`
 * directly, so even the same field set in a different order reads the wrong field — and a
 * generic target (`Box<number>`) grounds its type arguments per specialization, which a
 * declaration-name prefix test cannot see. Unknown, a primitive, a union, a reordered or
 * mismatched shape: all may arrive in a representation the slot's static reads do not describe.
 * A subclass value into a NON-generic base is safe by the prefix rule `hTypeAssignable` states
 * (the layout starts with the base's, in the base's slot order), and identical names are the
 * same layout by construction. Arrays are slot-exact when their elements agree exactly: a
 * static index read hands the element to a consumer compiled for the declared element type,
 * so a mismatched element is the same hole one level down. */
function staticallySafeValue(value: HType, target: HType): boolean {
  if (value.kind === 'array' && target.kind === 'array') {
    return hTypeEquals(value.element, target.element);
  }
  return (
    value.kind === 'object' &&
    target.kind === 'object' &&
    (value.name === target.name ||
      (!target.name.includes('<') && value.bases.includes(target.name)))
  );
}

/** Empty mark set for `effectiveValueType` callers with no return marks to consult —
 * a shared frozen empty rather than an allocation per call on this hot path. */
const NO_RETURN_MARKS: ReadonlySet<string> = new Set<string>();

/** The HType a value expression delivers where a fixed-shape slot reads it, mirroring the
 * lowering's own erasures rather than the checker's spelling. A non-checkable `as` assertion
 * lowers to its operand (`x as T` below), parentheses and `!` are transparent, and an identifier
 * answers its DECLARED type: a narrowing the compiler cannot check is not a fact about the value
 * (the `typeAt` rule), and a narrowing it can check settles a tag, never a layout. When the
 * declaration cannot be found the checker's own answer stands. Biased toward Unknown: a missed
 * widening is silent garbage, an extra one is a dynamic read. A call to a step-45-marked
 * function delivers Unknown whatever the checker spells (its declared return is the contract,
 * not the value); `knownReturn` carries those marks, empty when the caller has none to consult
 * — which keeps every pre-45 call site answering exactly what it answered before. */
function effectiveValueType(
  node: ts.Expression,
  checker: ts.TypeChecker,
  knownDynamic: ReadonlySet<string>,
  knownReturn: ReadonlySet<string> = NO_RETURN_MARKS,
): HType {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      const assertion = ts.isAsExpression(current) ? assertedBy(current, checker) : null;
      const operandType = effectiveValueType(
        current.expression,
        checker,
        knownDynamic,
        knownReturn,
      );
      if (assertion !== null && isCheckable(assertion.asserted) && operandType.kind === 'unknown') {
        return assertion.asserted;
      }
      current = current.expression;
      continue;
    }
    if (ts.isArrayLiteralExpression(current)) {
      const contextual = emptyArrayContextType(current, checker);
      if (contextual !== undefined) {
        return contextual;
      }
    }
    if (ts.isCallExpression(current)) {
      if (knownReturn.size > 0) {
        const fqn = calledFunctionFQN(current, checker);
        if (fqn !== undefined && knownReturn.has(fqn)) {
          return hUnknown(false);
        }
      }
      return frontendTypes.tsTypeToHType(checker.getTypeAtLocation(current), checker);
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol !== undefined && knownDynamic.has(checker.getFullyQualifiedName(symbol))) {
        return hUnknown(false);
      }
      const declaration = symbol?.valueDeclaration;
      if (symbol !== undefined && declaration !== undefined) {
        const declared = frontendTypes.tsTypeToHType(
          checker.getTypeOfSymbolAtLocation(symbol, declaration),
          checker,
        );
        if (declared.kind !== 'unknown') {
          return declared;
        }
        return hUnknown(false);
      }
    }
    return frontendTypes.tsTypeToHType(checker.getTypeAtLocation(current), checker);
  }
}

/** Whether the body of `fn` reads a METHOD through parameter `param` (plan.md §8 step 44c).
 *
 * Widening a fixed-shape parameter routes every use through the shape table, and shape-table
 * reads resolve FIELDS by name but cannot reach a class instance's methods (they live on the
 * prototype, not in a slot — calling one through an untyped parameter aborts STA2006 today).
 * A field-only body is always safe to widen; a method-touching one keeps its static dispatch,
 * which is exactly right for the class values that reach it and the pre-existing behavior for
 * the rest. Element reads with a statically-known key answer the same question by name; a
 * runtime key is already dynamic and never blocks. */
function paramTouchesMethod(fn: ts.Node, param: ts.Symbol, checker: ts.TypeChecker): boolean {
  // Compared by qualified name, not identity: two lookups of one declaration answer the same
  // symbol in practice, but the name is the contract the seeding loop already keeps.
  const paramName = checker.getFullyQualifiedName(param);
  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) {
      return;
    }
    if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name)) {
      const receiver = node.expression;
      const symbol =
        ts.isIdentifier(receiver) || ts.isPropertyAccessExpression(receiver)
          ? checker.getSymbolAtLocation(receiver)
          : undefined;
      if (symbol !== undefined && checker.getFullyQualifiedName(symbol) === paramName) {
        const member = checker.getPropertyOfType(
          checker.getTypeAtLocation(receiver),
          node.name.text,
        );
        const declarations = member?.declarations ?? [];
        if (
          member === undefined ||
          declarations.some(
            (declaration) =>
              ts.isMethodDeclaration(declaration) ||
              ts.isGetAccessorDeclaration(declaration) ||
              ts.isSetAccessorDeclaration(declaration),
          )
        ) {
          touched = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return touched;
}

/** The declaration a call's arguments map onto, with its user parameters.
 *
 * Plain calls resolve through the callee's symbol (one-hop aliases included); method calls
 * resolve through the method. An explicit `this` parameter is skipped: it names the receiver
 * the call syntax does not pass, so every user argument sits one slot later in the source
 * than in `node.arguments`. Anything without a static declaration (a dynamic call, an
 * element-access callee, a builtin) has no parameters to widen. */
function calleeParameters(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
):
  | { readonly declaration: ts.Node; readonly parameters: readonly ts.ParameterDeclaration[] }
  | undefined {
  const callee = node.expression;
  if (isFunctionLike(callee)) {
    return { declaration: callee, parameters: callee.parameters };
  }
  const symbol =
    ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
      ? checker.getSymbolAtLocation(callee)
      : undefined;
  const resolved = calleeTargetDeclaration(symbol, checker, 0);
  // `new C(v)` maps onto the constructor: a declared one names its parameters, while an
  // implicit one forwards to the base — a chain the source never spells, so it stays a
  // follow-up rather than a guess.
  const declaration =
    resolved !== undefined || !ts.isNewExpression(node) ? resolved : constructorOfClass(symbol);
  if (declaration === undefined || !isFunctionLike(declaration)) {
    return undefined;
  }
  const [firstParam] = declaration.parameters;
  const parameters =
    firstParam !== undefined && ts.isIdentifier(firstParam.name) && firstParam.name.text === 'this'
      ? declaration.parameters.slice(1)
      : declaration.parameters;
  return { declaration, parameters };
}

/** The constructor a `new` expression's class declares, or `undefined` for an implicit one
 * (which forwards to the base through no syntax this walk can see). */
function constructorOfClass(symbol: ts.Symbol | undefined): ts.ConstructorDeclaration | undefined {
  const declaration = symbol?.valueDeclaration;
  if (declaration !== undefined && ts.isClassDeclaration(declaration)) {
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member)) {
        return member;
      }
    }
  }
  return undefined;
}

/** Follow a callee symbol to the function-like declaration it names: directly, through a
 * variable holding one (`const f = () => …; f(v)`), or through one variable hop
 * (`const g = getX; g(v)`). Deeper chains stay dynamic. */
function calleeTargetDeclaration(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  depth: number,
): ts.Node | undefined {
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined || depth > 1) {
    return undefined;
  }
  if (isFunctionLike(declaration)) {
    return declaration;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    if (isFunctionLike(declaration.initializer)) {
      return declaration.initializer;
    }
    if (ts.isIdentifier(declaration.initializer)) {
      return calleeTargetDeclaration(
        checker.getSymbolAtLocation(declaration.initializer),
        checker,
        depth + 1,
      );
    }
  }
  return undefined;
}

/** Fixed-shape bindings a dynamic value can reach (plan.md §8 steps 44c, 45, 46).
 *
 * In js mode the checker no longer refuses Unknown-into-object flows (2322/2345 suppressed) and
 * `maybeBoundary` only settles tags, so an Unknown holding a dynamic object that lands in a
 * fixed-layout slot reads garbage — `jsrt_object_get_field` on a shape-table value, silent
 * wrong answers down to SIGSEGV. The fix widens the RECEIVING binding to Unknown through the
 * same NUL-dynamic channel 2322/2454 use, so every later read goes through the shape table. A
 * statically slot-exact value needs no widening; a method-touching parameter body keeps its
 * static dispatch (`paramTouchesMethod`), which class values already answer correctly.
 *
 * Covers parameters (call/new edges), `let`/`const`/`var` declarations, and plain `x = v`
 * assignments — all three share one fixpoint, so a widened binding is itself a dynamic source
 * for the next edge. Object-literal values are excluded: they are built into the contextual
 * layout at the edge, so even a reordered field set is safe (spread_key_order), while a truly
 * mismatched literal already carries a 2322 the program-wide channel widens on. Returns are
 * the sibling edge and live in `collectDynamicReturnsPass` below: a return cannot widen the
 * declaration (an overload and vtable contract), so it widens each call result instead — and
 * since step 46 that mark feeds BACK here as `knownReturn`, so a declaration initialized
 * from a marked call (`const x: Fixed = f()`) probes the call dynamic and widens too.
 *
 * Gate coherence: the gate's spread arm still judges a spread source by its annotation, so a
 * widened variable that is ALSO spread would be accepted statically at the gate and meet no
 * shape in the lowering (STA4068). No binding widened here is spread anywhere in the current
 * corpus — spread_key_order's sources are all literals, which this pass excludes — so the two
 * agree everywhere they are both asked. Spreading a widened binding stays a known gap (honest
 * not-yet, not silent garbage) for the dynamic-spread owner.
 *
 * Slot marks accumulate into `dynamicFqns` (the caller's set, which seeds the `dynamic:`
 * bindings); the sibling return marks are returned for the `dynamic-return:` seeding. */
function collectDynamicWidening(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  dynamicFqns: Set<string>,
): Set<string> {
  // To a JOINT fixpoint: a widened binding is a dynamic source for the returns edge
  // (`return` of a widened binding reads dynamic and marks the function), and a marked
  // call is a dynamic source for the slots edge (`const y: Fixed = f()` widens `y`),
  // so each edge's news is the other's next round whatever order the syntax comes in.
  // Both sets only ever grow, so the loop terminates.
  const returnFqns = new Set<string>();
  const seenReturn = new Set<string>();
  for (;;) {
    const beforeSlots = dynamicFqns.size;
    const beforeReturns = returnFqns.size;
    collectDynamicSlotsPass(files, checker, dynamicFqns, seenReturn, dynamicFqns);
    collectDynamicReturnsPass(files, checker, dynamicFqns, seenReturn, returnFqns);
    for (const fqn of returnFqns) {
      seenReturn.add(fqn);
    }
    if (dynamicFqns.size === beforeSlots && returnFqns.size === beforeReturns) {
      return returnFqns;
    }
  }
}

function collectDynamicSlotsPass(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  knownDynamic: ReadonlySet<string>,
  knownReturn: ReadonlySet<string>,
  fqns: Set<string>,
): void {
  const paramDeclaredType = (param: ts.ParameterDeclaration): HType | undefined => {
    if (!ts.isIdentifier(param.name)) {
      return undefined;
    }
    const symbol = checker.getSymbolAtLocation(param.name);
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || declaration === undefined) {
      return undefined;
    }
    return frontendTypes.tsTypeToHType(
      checker.getTypeOfSymbolAtLocation(symbol, declaration),
      checker,
    );
  };
  // A `let`/`const`/`var` binding (or a plain `x = v` target) whose declared type is a fixed
  // shape but whose value may arrive dynamic widens the same way a parameter does, so every
  // later read goes through the shape table. An object-literal value is excluded: it is built
  // into the contextual layout at the edge, so even a reordered field set is safe (the
  // spread_key_order rule), while any genuinely mismatched literal already carries a 2322 the
  // program-wide channel widens on. Destructured bindings have no single symbol and stay out.
  const widenVariableIfUnsafe = (name: ts.Identifier, value: ts.Expression): void => {
    if (ts.isObjectLiteralExpression(value)) {
      return;
    }
    const symbol = checker.getSymbolAtLocation(name);
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || declaration === undefined) {
      return;
    }
    const declared = frontendTypes.tsTypeToHType(
      checker.getTypeOfSymbolAtLocation(symbol, declaration),
      checker,
    );
    if (declared.kind !== 'object') {
      return;
    }
    if (
      !staticallySafeValue(effectiveValueType(value, checker, knownDynamic, knownReturn), declared)
    ) {
      fqns.add(checker.getFullyQualifiedName(symbol));
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      widenVariableIfUnsafe(node.name, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      widenVariableIfUnsafe(node.left, node.right);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // `new C(v)` maps its arguments onto the constructor's parameters exactly as a call
      // maps onto its callee's — the same fixed-shape/dynamic-value hole in the same shape.
      const callee = calleeParameters(node, checker);
      if (callee !== undefined) {
        // A `new C` without an argument list has no arguments to map.
        (node.arguments ?? []).forEach((argument, index) => {
          if (ts.isSpreadElement(argument)) {
            return;
          }
          const param = callee.parameters[index];
          if (param === undefined || !ts.isIdentifier(param.name)) {
            return;
          }
          const declared = paramDeclaredType(param);
          if (declared?.kind !== 'object') {
            return;
          }
          const paramSymbol = checker.getSymbolAtLocation(param.name);
          if (paramSymbol === undefined) {
            return;
          }
          if (
            !staticallySafeValue(
              effectiveValueType(argument, checker, knownDynamic, knownReturn),
              declared,
            ) &&
            !paramTouchesMethod(callee.declaration, paramSymbol, checker)
          ) {
            fqns.add(checker.getFullyQualifiedName(paramSymbol));
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    visit(file);
  }
}

/** The symbol a call site resolves to `fn` through, as a fully-qualified name: a declared
 * function's own name, a method's name, or the variable an expression-bodied function is
 * assigned to (`const f = () => …` is called as `f`). `undefined` for everything without a
 * callable name — constructors, accessors, anonymous callbacks, computed method names — whose
 * returns this edge does not mark and whose calls it does not widen. */
function markingFQNOfFunction(fn: FunctionLike, checker: ts.TypeChecker): string | undefined {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    const name = fn.name;
    if (name === undefined || !ts.isIdentifier(name)) {
      return undefined;
    }
    const symbol = checker.getSymbolAtLocation(name);
    return symbol === undefined ? undefined : checker.getFullyQualifiedName(symbol);
  }
  if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
    const parent = fn.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const symbol = checker.getSymbolAtLocation(parent.name);
      return symbol === undefined ? undefined : checker.getFullyQualifiedName(symbol);
    }
    return undefined;
  }
  return undefined;
}

/** The declared return layout of `fn`, or `undefined` when the edge has nothing to protect:
 * constructors build their instance (never a returned value), non-function types cannot
 * occur here, an Unknown or primitive return already routes every caller dynamically, and a
 * type-parameter-mentioning return grounds per specialization rather than widening the
 * generic (class_generic_base's `get(): T` returns a field through `T` and must keep its
 * static dispatch). Only fixed object and array layouts qualify. */
function declaredReturnOf(fn: FunctionLike, checker: ts.TypeChecker): HType | undefined {
  if (ts.isConstructorDeclaration(fn)) {
    return undefined;
  }
  const type = frontendTypes.tsTypeToHType(checker.getTypeAtLocation(fn), checker);
  if (type.kind !== 'fn' || hasTypeParam(type.ret)) {
    return undefined;
  }
  if (type.ret.kind !== 'object' && type.ret.kind !== 'array') {
    return undefined;
  }
  return type.ret;
}

/** Every value `fn` can return: each `return e;` expression in its body, where a bare
 * `return;` counts as an unsafe (undefined) value. Nested function-likes own their returns
 * and are never descended into; an arrow's expression body is its implicit return. */
function functionReturnValues(fn: FunctionLike): {
  readonly values: readonly ts.Expression[];
  readonly bare: boolean;
} {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    return { values: [fn.body], bare: false };
  }
  const body = fn.body;
  if (body === undefined) {
    return { values: [], bare: false };
  }
  const values: ts.Expression[] = [];
  let bare = false;
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      if (node.expression === undefined) {
        bare = true;
      } else {
        values.push(node.expression);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return { values, bare };
}

/** The marking name of the function a call resolves to, following the same one-hop alias the
 * argument edge follows (`const g = f; g(v)`). `undefined` for calls with no static target —
 * dynamic calls, builtins, unresolvable callees — which have no declaration to mark. */
function calledFunctionFQN(node: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const callee = node.expression;
  const symbol =
    ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
      ? checker.getSymbolAtLocation(callee)
      : undefined;
  const resolved = calleeTargetDeclaration(symbol, checker, 0);
  if (resolved === undefined || !isFunctionLike(resolved)) {
    return undefined;
  }
  return markingFQNOfFunction(resolved, checker);
}

/** Fixed-shape function returns a dynamic value can reach (plan.md §8 step 45).
 *
 * The return edge of the same hole the slots pass closes on bindings: in js mode the
 * checker no longer refuses Unknown-into-object flows and `maybeBoundary` only settles tags,
 * so `return JSON.parse(...)` from an object-typed function hands every caller a shape-table
 * value behind a fixed-layout promise — `jsrt_object_get_field` on it is silent garbage.
 * Widening the DECLARED return type would rewrite overload and vtable contracts the call
 * sites were compiled against, so the declaration keeps its shape and each CALL result widens
 * to Unknown instead (`typeAt` consults these marks), routing every use through the shape
 * table. A statically slot-exact return needs no widening, by the same `staticallySafeValue`
 * rule the binding edge uses; only the callers change, never the callee.
 *
 * Marks name the callable's symbol, so overloads resolve together (every signature shares
 * one symbol) and one-hop aliases resolve through `calleeTargetDeclaration` exactly as the
 * argument edge resolves them. Constructors, accessors, anonymous callbacks and generic
 * (type-parameter-mentioning) returns stay out: a construction always builds the fixed
 * layout, an accessor read is not a call this probe sees, an unassigned callback names no
 * call site, and a generic grounds per specialization. Marks seed under the sibling
 * `dynamic-return:` prefix — the same NUL-key Scope channel, a disjoint key space so
 * identifier probes never see function marks and call probes never see binding marks. */
function collectDynamicReturnsPass(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  knownDynamic: ReadonlySet<string>,
  knownReturn: ReadonlySet<string>,
  fqns: Set<string>,
): void {
  const visitFn = (fn: FunctionLike): void => {
    const fqn = markingFQNOfFunction(fn, checker);
    if (fqn === undefined || fqns.has(fqn)) {
      return;
    }
    // A suppressed-2416 override pair (program.ts): the hierarchy is inconsistent, so a call
    // resolving to either declaration answers Unknown instead of trusting one side's return —
    // or a base-typed read of a derived instance answers garbage. Seeding names the
    // declarations; this names the calls, leaving overload and vtable contracts (the
    // declarations) untouched. Methods only: variable and parameter seeds name bindings,
    // never callables, so no existing seed can reach this arm.
    if (ts.isMethodDeclaration(fn) && knownDynamic.has(fqn)) {
      fqns.add(fqn);
      return;
    }
    const target = declaredReturnOf(fn, checker);
    if (target === undefined) {
      return;
    }
    const returned = functionReturnValues(fn);
    if (returned.bare) {
      fqns.add(fqn);
      return;
    }
    for (const value of returned.values) {
      if (
        !staticallySafeValue(effectiveValueType(value, checker, knownDynamic, knownReturn), target)
      ) {
        fqns.add(fqn);
        return;
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      visitFn(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    visit(file);
  }
}

/** `let x = 1` / `const x = 1`, from either a statement or a `for` header's first slot.
 *
 * `at` is the node the span comes from — the whole VariableStatement at statement level, and the
 * declaration list itself inside a `for` header, where there is no statement wrapping it. Passing
 * it in rather than synthesising a VariableStatement matters: a factory-made node has no source
 * position, and asking one for its start is a hard failure inside the TypeScript API. */

/** `x.length` on a value that answers it without a shape: an array, a function, or (anything
 * else the gate let through) a string. The three are different nodes because they become
 * different runtime calls. A function's `length` -- a method value (`const f = o.m`) included,
 * whose closure already excludes the receiver from its arity (docs/VALUE.md §4.16). An
 * Unknown-typed receiver never reaches here: it takes the dynamic path and answers through
 * `jsrt_get_prop` (plan.md §8 step 21b). */
function lengthRead(operand: Expression, span: Span): Expression {
  if (operand.type.kind === 'array') {
    const length: ArrayLength = { kind: 'array-length', type: H_NUMBER, span, operand };
    return length;
  }
  if (operand.type.kind === 'fn') {
    const length: FunctionLength = { kind: 'function-length', type: H_NUMBER, span, operand };
    return length;
  }
  const length: StringLength = { kind: 'string-length', type: H_NUMBER, span, operand };
  return length;
}

function lowerPatternRead(
  target: Expression,
  field: string | number,
  name: ts.BindingName,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  overrideType?: HType,
): Expression | null {
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);
  const type = overrideType ?? typeAt(name, checker, bindings);
  if (typeof field === 'number') {
    const index: Expression = { kind: 'number-literal', type: H_NUMBER, span, value: field };
    return { kind: 'index-access', type, span, target, index };
  }
  const member = namespaceObjectField(target, field, checker, bindings);
  if (member !== undefined) {
    return { kind: 'identifier', type: member.type, span, name: member.name };
  }
  // `const { length: n } = xs` reads what `xs.length` reads (plan-notes 310).
  if (
    field === 'length' &&
    (target.type.kind === 'array' || target.type.kind === 'fn' || target.type.kind === 'string')
  ) {
    return lengthRead(target, span);
  }
  if (target.type.kind === 'unknown') {
    const access: DynFieldAccess = {
      kind: 'dyn-field-access',
      type: hUnknown(false),
      span,
      target,
      field,
    };
    return access;
  }
  const slot = slotOf(target, field, at, sourceFile, diagnostics);
  if (slot === null) {
    return null;
  }
  const access: FieldAccess = { kind: 'field-access', type, span, target, field, slot };
  return access;
}

/** Evaluate `value` once into a scratch binding and return the identifier that reads it, so a
 * later read (a default test, a rest copy, a delete walk) never re-evaluates the source. */
function holdInTemp(
  value: Expression,
  span: Span,
  bindings: Scope,
  statements: Statement[],
): Identifier {
  const tmp = nextBindTemp();
  const type = value.type;
  bindings.set(tmp, type);
  statements.push({
    kind: 'declaration',
    type,
    span,
    name: tmp,
    declKind: 'const',
    value,
  });
  return { kind: 'identifier', type, span, name: tmp };
}

/** Bind one pattern element's already-evaluated source: recurse when the target is a nested
 * pattern, else declare the identifier. A destructured element is a binding like any other, so
 * it can shadow — and then it needs a name of its own for the same reason a plain `let` does.
 * `value` is what the identifier declares (already boundary-checked when needed); `type` is the
 * binding's declared type, which a default's conditional does not carry. */
function finishPatternBind(
  el: ts.BindingElement,
  source: Expression,
  value: Expression,
  type: HType,
  declKind: 'let' | 'const',
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  statements: Statement[],
): boolean {
  if (!ts.isIdentifier(el.name)) {
    // Nested pattern: the field read becomes the source the inner pattern destructures.
    const parts = lowerBindingPattern(
      el.name,
      source,
      declKind,
      el,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
    if (parts === null) {
      return false;
    }
    statements.push(...parts);
    return true;
  }
  const span = makeSpan(el.getStart(sourceFile), el.getWidth(sourceFile), sourceFile);
  const hirName = bindings.declare(el.name.text, type);
  hirNameOfDeclaration.set(el, hirName);
  statements.push({
    kind: 'declaration',
    type,
    span,
    name: hirName,
    declKind,
    value,
  });
  return true;
}

function bindPatternElement(
  source: Expression,
  key: string | number,
  el: ts.BindingElement,
  declKind: 'let' | 'const',
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  statements: Statement[],
): boolean {
  const read = lowerPatternRead(
    source,
    key,
    el.name,
    el,
    sourceFile,
    checker,
    bindings,
    diagnostics,
  );
  if (read === null) {
    return false;
  }
  // A default runs when the read is `undefined` (missing or explicit), like a parameter's.
  // The read is evaluated once into a scratch so the conditional never re-reads it; the
  // default expression itself stays lazy behind the alternate arm.
  let bound = read;
  if (el.initializer !== undefined) {
    const fallback = lowerExpression(el.initializer, sourceFile, checker, bindings, diagnostics);
    if (fallback === null) {
      return false;
    }
    const span = makeSpan(el.getStart(sourceFile), el.getWidth(sourceFile), sourceFile);
    const held = holdInTemp(read, span, bindings, statements);
    const isUndef: BinaryOp = {
      kind: 'binary-op',
      operator: '===',
      type: H_BOOLEAN,
      span,
      left: held,
      right: { kind: 'undefined-literal', type: H_UNDEFINED, span },
    };
    bound = {
      kind: 'conditional',
      type: fallback.type,
      span,
      condition: isUndef,
      consequent: fallback,
      alternate: held,
    };
  }
  const type = typeAt(el.name, checker, bindings);
  return finishPatternBind(
    el,
    bound,
    maybeBoundary(bound, type, el, sourceFile),
    type,
    declKind,
    sourceFile,
    checker,
    bindings,
    diagnostics,
    statements,
  );
}

/** What a pattern reads its parts from: `rhs` itself when it is a variable, a temporary holding it
 * otherwise, so the right side runs once however many targets read it. */
function patternSource(
  rhs: Expression,
  span: Span,
  bindings: Scope,
  statements: Statement[],
): Expression {
  if (rhs.kind === 'identifier') {
    return rhs;
  }
  return holdInTemp(rhs, span, bindings, statements);
}

function lowerBindingPattern(
  name: ts.BindingName,
  rhs: Expression,
  declKind: 'let' | 'const',
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement[] | null {
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);
  const statements: Statement[] = [];
  const source = patternSource(rhs, span, bindings, statements);
  if (ts.isIdentifier(name)) {
    diagnostics.push(
      lowerDiagnostic(name, sourceFile, 'STA4031', 'internal', 'expected a binding pattern'),
    );
    return null;
  }
  if (ts.isObjectBindingPattern(name)) {
    const bound = new Set<string>();
    for (const el of name.elements) {
      if (el.dotDotDotToken === undefined) {
        const field = bindingElementKey(el, checker);
        if (field !== null) {
          bound.add(field);
        }
      }
    }
    for (const el of name.elements) {
      if (el.dotDotDotToken !== undefined) {
        if (
          !bindObjectRest(
            source,
            bound,
            el,
            declKind,
            sourceFile,
            checker,
            bindings,
            diagnostics,
            statements,
          )
        ) {
          return null;
        }
        continue;
      }
      const field = bindingElementKey(el, checker);
      if (field === null) {
        diagnostics.push(
          lowerDiagnostic(
            el,
            sourceFile,
            'STA1214',
            'not-yet',
            'a computed key with a runtime name in a destructuring pattern is not yet supported',
          ),
        );
        return null;
      }
      if (
        !bindPatternElement(
          source,
          field,
          el,
          declKind,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          statements,
        )
      ) {
        return null;
      }
    }
    return statements;
  }
  let index = 0;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) {
      index += 1;
      continue;
    }
    if (ts.isBindingElement(el) && el.dotDotDotToken !== undefined) {
      if (
        !bindArrayRest(
          source,
          index,
          el,
          declKind,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          statements,
        )
      ) {
        return null;
      }
      break;
    }
    if (
      !bindPatternElement(
        source,
        index,
        el,
        declKind,
        sourceFile,
        checker,
        bindings,
        diagnostics,
        statements,
      )
    ) {
      return null;
    }
    index += 1;
  }
  return statements;
}

/** `const [x, ...rest] = a` / a nested array's `...rest`: the rest binds `a.slice(i)`, where `i`
 * is the element index the rest starts at. The rest is last by syntax, so the walk stops here.
 * The checker's rest type is `T[]`; `slice` answers the target's own type, which for a dense
 * array is that same `T[]`. A rest PATTERN (`...[a, b]`) destructures that slice further. */
function bindArrayRest(
  source: Expression,
  index: number,
  el: ts.BindingElement,
  declKind: 'let' | 'const',
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  statements: Statement[],
): boolean {
  const span = makeSpan(el.getStart(sourceFile), el.getWidth(sourceFile), sourceFile);
  const type = ts.isIdentifier(el.name)
    ? typeAt(el.name, checker, bindings)
    : typeAt(el, checker, bindings);
  const start: Expression = { kind: 'number-literal', type: H_NUMBER, span, value: index };
  const end: Expression = { kind: 'undefined-literal', type: H_UNDEFINED, span };
  const sliced: ArrayOp = {
    kind: 'array-op',
    op: 'slice',
    type,
    span,
    target: source,
    args: [start, end],
  };
  return finishPatternBind(
    el,
    sliced,
    sliced,
    type,
    declKind,
    sourceFile,
    checker,
    bindings,
    diagnostics,
    statements,
  );
}

/** `const { a, ...rest } = o` / a nested object's `...rest`: the rest binds a fresh plain object
 * of the remaining own fields. A fixed source expands the SOURCE layout minus the bound keys —
 * `Omit<T, K>`, computed here rather than read from the checker's mapped type, whose symbol is
 * the binding itself and so is not a layout `shapeTypeToHType` would accept. An Unknown source
 * (no layout to subtract from) copies through the shape table: `Object.assign({}, src)` then
 * `delete` of each bound key, the same shape-table walk a dynamic object spread takes. A class
 * instance whose rest type carries methods, or an array source, stay not-yet. A rest PATTERN
 * (`...{ a }`) destructures the remainder further. */
function bindObjectRest(
  source: Expression,
  bound: ReadonlySet<string>,
  el: ts.BindingElement,
  declKind: 'let' | 'const',
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  statements: Statement[],
): boolean {
  const span = makeSpan(el.getStart(sourceFile), el.getWidth(sourceFile), sourceFile);
  const src = source.type;
  let restValue: Expression;
  if (src.kind === 'object' && src.methods.length > 0) {
    diagnostics.push(
      lowerDiagnostic(
        el,
        sourceFile,
        'STA1214',
        'not-yet',
        'an object rest over a type with methods is not yet supported',
      ),
    );
    return false;
  }
  if (src.kind === 'object') {
    const fields = src.fields.filter((f) => !bound.has(f.name));
    const type = hObject(frontendTypes.shapeName(fields), fields, []);
    const entries: ObjectEntry[] = [];
    for (const field of fields) {
      // Type the read from the SOURCE layout, not `typeAt(el.name)`: the rest binding's
      // checker type is `Omit<T, K>`, a mapped type `shapeTypeToHType` answers Unknown for,
      // and every entry would inherit that Unknown and drag the file dynamic.
      const read = lowerPatternRead(
        source,
        field.name,
        el.name,
        el,
        sourceFile,
        checker,
        bindings,
        diagnostics,
        field.type,
      );
      if (read === null) {
        return false;
      }
      entries.push({ name: field.name, value: read });
    }
    restValue = {
      kind: 'object-literal',
      type,
      span,
      entries,
      methods: [],
      methodCopies: [],
    };
  } else if (src.kind === 'unknown') {
    // Dynamic/unknown source: copy own keys through the shape table, then drop the bound ones.
    // `Object.assign` is the spread twin's copy; `delete` is the exclusion. The result is a
    // dynamic object (Unknown), which is exactly what `Omit` over an unknown source is.
    const empty: DynObjectLiteral = {
      kind: 'dyn-object-literal',
      type: hUnknown(false),
      span,
      entries: [],
    };
    const assign: ObjectStaticCall = {
      kind: 'object-static',
      method: 'assign',
      type: hUnknown(false),
      span,
      args: [empty, source],
    };
    const held = holdInTemp(assign, span, bindings, statements);
    for (const key of bound) {
      statements.push({
        kind: 'expression-statement',
        type: H_BOOLEAN,
        span,
        expression: {
          kind: 'delete-prop',
          type: H_BOOLEAN,
          span,
          target: held,
          key: { kind: 'string-literal', type: H_STRING, span, value: key },
        },
      });
    }
    restValue = held;
  } else {
    diagnostics.push(
      lowerDiagnostic(
        el,
        sourceFile,
        'STA1214',
        'not-yet',
        'an object rest over a value with no fixed layout is not yet supported',
      ),
    );
    return false;
  }
  return finishPatternBind(
    el,
    restValue,
    restValue,
    restValue.type,
    declKind,
    sourceFile,
    checker,
    bindings,
    diagnostics,
    statements,
  );
}

/** Step 17's rule, shared by every position that can name a function (plan.md §8 step 17 and
 * its follow-up): an anonymous function takes the SOURCE spelling of the binding it is
 * assigned to as its display name, while the binding itself takes the HIR name. A named
 * function expression keeps its own name, which is what Node prints for it. Applies only
 * where the spelling is unambiguous -- a declaration, a `var` initializer, a simple
 * identifier assignment. A chain (`x = y = () => {}`) needs no special case: the outer
 * assignment's value is the inner assignment's HIR rather than a function literal, so only
 * the innermost spelling applies -- which is exactly what Node prints (`y` for both). */
function withDisplayName(value: Expression, name: string): Expression {
  return value.kind === 'function' && value.name === undefined ? { ...value, name } : value;
}

/** The class expression a declarator forms (`const|let|var X = class { … }`, the binding never
 * repointed), or `undefined`. The formation emits the class's descriptor under the variable's
 * name and binds no value; the gate accepts exactly these (`isClassFormationDeclarator`). */
function classFormation(
  decl: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): ts.ClassExpression | undefined {
  const init = decl.initializer;
  return init !== undefined &&
    ts.isClassExpression(init) &&
    isClassFormationDeclarator(decl, checker) &&
    frontendTypes.expressionClassName(init) !== undefined
    ? init
    : undefined;
}

function lowerDeclarationList(
  list: ts.VariableDeclarationList,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null {
  const fail = (target: ts.Node, message: string): null => {
    diagnostics.push(lowerDiagnostic(target, sourceFile, 'STA4032', 'internal', message));
    return null;
  };

  if (!list.declarations || list.declarations.length === 0) {
    return fail(at, 'empty variable declaration list');
  }
  // A `var X = class {}` formation (Rolldown's spelling of a top-level class) binds no value,
  // exactly like the `const` one, so it takes the declarator path and is never hoisted.
  const single = list.declarations.length === 1 ? list.declarations[0] : undefined;
  if (single !== undefined && classFormation(single, checker) !== undefined) {
    return lowerDeclarator(single, 'let', at, sourceFile, checker, bindings, diagnostics, fail);
  }
  if (isVarDeclarationList(list)) {
    return lowerVarList(list, at, sourceFile, checker, bindings, diagnostics, fail);
  }

  const declKind: 'let' | 'const' = list.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const only = list.declarations.length === 1 ? list.declarations[0] : undefined;
  if (only !== undefined) {
    return lowerDeclarator(only, declKind, at, sourceFile, checker, bindings, diagnostics, fail);
  }
  // `let a = 1, b;` is its declarators in order, one Declaration each, in a sequence that binds
  // into the enclosing statement list (plan-notes 310). Each spans its own declarator.
  const statements: Statement[] = [];
  for (const decl of list.declarations) {
    const lowered = lowerDeclarator(
      decl,
      declKind,
      decl,
      sourceFile,
      checker,
      bindings,
      diagnostics,
      fail,
    );
    if (lowered === null) {
      return null;
    }
    statements.push(lowered);
  }
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);
  return { kind: 'block', type: H_UNDEFINED, span, statements, flatten: true };
}

/** One declarator of a `let`/`const` list; `at` is what its spans cover. */
function lowerDeclarator(
  decl: ts.VariableDeclaration,
  declKind: 'let' | 'const',
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  fail: (target: ts.Node, message: string) => null,
): Statement | null {
  if (!ts.isIdentifier(decl.name)) {
    if (!isSimpleBindingPattern(decl.name, checker) || decl.initializer === undefined) {
      return fail(decl, 'destructuring declaration without initializer');
    }
    const lowered = lowerExpression(decl.initializer, sourceFile, checker, bindings, diagnostics);
    if (!lowered) {
      return null;
    }
    const parts = lowerBindingPattern(
      decl.name,
      lowered,
      declKind,
      at,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
    if (parts === null) {
      return null;
    }
    const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);
    if (parts.length === 1) {
      const only = parts[0];
      return only === undefined
        ? { kind: 'block', type: H_UNDEFINED, span, statements: [], flatten: true }
        : only;
    }
    return { kind: 'block', type: H_UNDEFINED, span, statements: parts, flatten: true };
  }

  const name = decl.name.text;
  // An alias that binds no value lowers to nothing: a generic alias (`const f = box`), whose
  // calls rewrite to specializations by resolved signature, and a class alias (`const K = C`),
  // whose in-place uses erase to the target declaration (see `aliasedClassDeclaration` in
  // `../frontend/types.ts`). Every other read of either is refused at the gate, so the name
  // binds no value, exactly as a generic declaration itself binds none. Only the formation
  // spelling is skipped (single `const`, mirroring the gate): anything else lowers as written
  // and fails where it always did.
  if (
    decl.initializer !== undefined &&
    ts.isIdentifier(decl.initializer) &&
    isSingleConstDeclarator(decl) &&
    (genericAliasTarget(decl.initializer, checker) !== undefined ||
      frontendTypes.aliasedClassDeclaration(decl.initializer, checker) !== undefined)
  ) {
    return {
      kind: 'block',
      type: H_UNDEFINED,
      span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
      statements: [],
      flatten: true,
    };
  }
  // A class expression bound by a single `const` emits its descriptor under the variable's
  // name and binds no value — the expression twin of the alias skip above (plan.md §8 step
  // 12(d); see `classExpressionTarget` in `../frontend/types.ts`). Every in-place use erases
  // to the expression, so the name needs no slot; every other read is refused at the gate.
  // Only the formation spelling qualifies, mirroring the gate exactly: anything else lowers
  // as written and fails where it always did.
  const formation = classFormation(decl, checker);
  if (formation !== undefined) {
    return lowerClass(formation, sourceFile, checker, bindings, diagnostics);
  }
  // A generic arrow or function expression assigned to a `const` lowers to nothing: its
  // specializations are already above (collected by tuple), and the name itself binds no value
  // (the gate refuses reading one outside a call). Only the assigned shape reaches here — the
  // gate refuses every other generic arrow, so this is the backstop, not the rule.
  if (decl.initializer !== undefined && genericArrowKey(decl.initializer) !== undefined) {
    return {
      kind: 'block',
      type: H_UNDEFINED,
      span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
      statements: [],
      flatten: true,
    };
  }
  // The BINDING's type, not the initializer's. They differ whenever an annotation is wider than
  // what it was initialized with -- `let x: string | number = 1` binds a union, and taking the
  // initializer's `number` would make the perfectly legal `x = 'a'` an internal error, and would
  // let a later pass unbox a slot that can hold a string.
  const type = typeAt(decl.name, checker, bindings);
  // The HIR name, which differs from the source's exactly when this declaration SHADOWS a visible
  // binding: the fresh name is what gives the block's `x` a slot of its own (plan.md §8 step 14).
  const hirName = bindings.declare(name, type);
  hirNameOfDeclaration.set(decl, hirName);

  // An `Out<T>`-annotated declaration without an initializer is an implicit slot
  // construction (docs/FFI.md §2): the cell starts NULL exactly as `outSlot<T>()` would
  // leave it, so the lowering injects the node rather than inventing a second spelling.
  // The gate already refused every annotation/initializer mismatch, so reaching here with
  // a non-`Out` initializer is impossible — and an unannotated name infers from its
  // initializer through the ordinary path below.
  let injectedOutNew = false;
  if (decl.initializer === undefined && decl.type !== undefined) {
    const announced = checker.getTypeFromTypeNode(decl.type);
    if (frontendTypes.outSlotInner(announced, checker) !== undefined) {
      injectedOutNew = true;
    }
  }

  let value: Expression | undefined;
  if (injectedOutNew) {
    value = {
      kind: 'out-new',
      type: hUnknown(false),
      span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
    };
  } else if (decl.initializer !== undefined) {
    const lowered = lowerExpression(decl.initializer, sourceFile, checker, bindings, diagnostics);
    if (!lowered) {
      return null;
    }
    // A declaration's anonymous function carries the DECLARATOR's source spelling as its display
    // name, while the binding takes the HIR name (plan.md §8 step 17): `const f = () => ...`
    // prints `[Function: f]` even when this `f` shadows an outer one, following the rule function
    // declarations already keep (`fn.name` holds the source spelling).
    const named = withDisplayName(lowered, name);
    value = edgeBoundary(named, type, decl.initializer, sourceFile);
  }

  const stmt: Declaration = {
    kind: 'declaration',
    type,
    span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
    name: hirName,
    declKind,
    ...(value !== undefined ? { value } : {}),
  };
  return stmt;
}

/** C-style `for`. Every header slot is optional; an absent condition means the loop runs until
 * something jumps out of it, which the HIR records as an absent `condition` rather than as a
 * literal `true` so the emitter can drop the test entirely. */
/** `for (const x of a)`.
 *
 * The binding's type comes from the checker at the binding site. For an array or a Set that is the
 * ELEMENT type with no `| undefined` — the loop visits only members that exist, so unlike `a[i]`
 * this read cannot miss. A Map yields a `[key, value]` tuple the HIR has no member for, so that
 * binding is Unknown. */
function lowerForOf(
  node: ts.ForOfStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  label?: string,
): Statement | null {
  const peeled = peelIteratorView(node.expression, checker, bindings);
  const iterableExpr = peeled === undefined ? node.expression : peeled.inner;
  const lowered = lowerExpression(iterableExpr, sourceFile, checker, bindings, diagnostics);
  if (!lowered) {
    return null;
  }
  const iterable =
    peeled === undefined
      ? wrapUserIterator(lowered, iterableExpr, node, sourceFile, checker, diagnostics)
      : lowered;
  if (!iterable) {
    return null;
  }
  const dispatched = wrapDynamicIterator(iterable);

  const list = node.initializer;
  const declaration = ts.isVariableDeclarationList(list) ? list.declarations[0] : undefined;
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4035',
        'internal',
        'for-of binding must be a single named declaration',
      ),
    );
    return null;
  }

  const binding = declaration.name.text;
  // In scope for the body, and only for the body: a fresh binding each iteration is exactly what
  // `let`/`const` in a for-of header means.
  //
  // Typed from the LOWERED iterable, not from the checker at the binding name. What the loop
  // actually yields is decided by the HIR type of the thing being walked, and where the two
  // disagree -- an evolving `const xs = []` that js mode widened to Unknown, which the checker
  // still resolves to `number[]` -- the checker's answer would put a type on the binding that the
  // emitted loop does not produce (STA4010). `forOfElementType` is the verifier's own rule.
  const inner = bindings.child();
  // The header binding is a declaration of the loop's scope, so it shadows the enclosing name (if
  // there is one) rather than sharing its slot -- and the HIR's own `binding` is the renamed name,
  // because that is what the emitter allocates the slot under.
  const hirBinding = inner.declare(
    binding,
    forOfElementType(dispatched.type, peeled === undefined ? 'identity' : peeled.view),
  );
  hirNameOfDeclaration.set(declaration, hirBinding);

  const body = lowerBody(node.statement, sourceFile, checker, inner, diagnostics);
  if (!body) {
    return null;
  }

  return {
    kind: 'for-of-statement',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    binding: hirBinding,
    declKind: (list.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'let',
    iterable: dispatched,
    view: peeled === undefined ? 'identity' : peeled.view,
    body,
    ...(label !== undefined && { label }),
    ...(loopNeedsPerIterationEnv(node, checker) && { perIterationEnv: true as const }),
  };
}

/** `for (const x of user)` where `user` declares `[Symbol.iterator]()`: call that method and let
 * the existing iterator walk drive what it returns. Specialized collections never reach here. */
function wrapUserIterator(
  iterable: Expression,
  receiver: ts.Expression,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): Expression | null {
  const method = frontendTypes.userIteratorMethod(iterable.type);
  if (method === undefined || method.type.kind !== 'fn') {
    return iterable;
  }
  const owner = declaringClassName(receiver, frontendTypes.ITERATOR_METHOD_NAME, checker);
  if (owner === null) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4065',
        'internal',
        `no class in the receiver's ancestry declares method '${frontendTypes.ITERATOR_METHOD_NAME}'`,
      ),
    );
    return null;
  }
  const slot =
    iterable.type.kind === 'object'
      ? iterable.type.methods.findIndex((m) => m.name === frontendTypes.ITERATOR_METHOD_NAME)
      : -1;
  if (slot < 0) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4067',
        'internal',
        `method '${frontendTypes.ITERATOR_METHOD_NAME}' has no slot in the layout of ${hTypeName(iterable.type)}`,
      ),
    );
    return null;
  }
  const call: MethodCall = {
    kind: 'method-call',
    type: method.type.ret,
    span: iterable.span,
    target: iterable,
    className: owner,
    method: frontendTypes.ITERATOR_METHOD_NAME,
    slot,
    dispatch:
      iterable.type.kind === 'object' &&
      isOverridden(iterable.type.name, frontendTypes.ITERATOR_METHOD_NAME, checker)
        ? 'virtual'
        : 'direct',
    args: [],
  };
  return call;
}

/** `for (const x of u)` where no static walk covers `u`: wrap the operand in the runtime
 * GetIterator dispatch (plan.md §8 step 2a(c)). The gate admits exactly these operands in js
 * mode -- an Unknown value, a union the model widened to one, or a statically-known
 * non-iterable the suppressed TS2488 let through -- so reaching here with one is the policy
 * working, and the wrapper is its lowering half rather than a second policy. Everything a
 * static walk covers (arrays, strings, Maps, Sets, stored iterators, user-iterable objects)
 * passes through untouched, which is also why a peeled view can never meet the wrapper:
 * `peelIteratorView` only peels statically-typed receivers. */
function wrapDynamicIterator(iterable: Expression): Expression {
  const kind = iterable.type.kind;
  if (
    kind === 'array' ||
    kind === 'string' ||
    kind === 'map' ||
    kind === 'set' ||
    kind === 'iterator' ||
    frontendTypes.userIteratorMethod(iterable.type) !== undefined
  ) {
    return iterable;
  }
  // A Uint8Array has no inlined walk; the runtime dispatch boxes its element walk, whose every
  // step is a byte -- so the element is `number`, the one concrete element this node may carry.
  return {
    kind: 'get-iterator',
    type: hIterator(iterable.type.kind === 'uint8array' ? H_NUMBER : hUnknown(false)),
    span: iterable.span,
    target: iterable,
  };
}

function peelIteratorView(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  bindings: Scope,
): { view: Exclude<IteratorView, 'identity'>; inner: ts.Expression } | undefined {
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 0) {
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(expr.expression)) {
    return undefined;
  }
  const name = expr.expression.name.text;
  if (name !== 'keys' && name !== 'values' && name !== 'entries') {
    return undefined;
  }
  const receiver = typeAt(expr.expression.expression, checker, bindings);
  if (receiver.kind !== 'array' && receiver.kind !== 'map' && receiver.kind !== 'set') {
    return undefined;
  }
  return { view: name, inner: expr.expression.expression };
}

function lowerFor(
  node: ts.ForStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  label?: string,
): Statement | null {
  // `for (let i = 0; ...)`: the header binding belongs to the LOOP, not to the statement list the
  // loop sits in. Sharing the caller's map leaked it, so `typeof i` after the loop read the loop's
  // slot and answered `"number"` where Node answers `"undefined"` (plan-notes 213) -- and the body
  // gets its own scope on top of this one, through `lowerBody`.
  const inner = bindings.child();
  let init: Statement | undefined;
  if (node.initializer !== undefined) {
    // The initializer is either a declaration list (`let i = 0`) or an expression (`i = 0`). The
    // declaration form is NOT wrapped in a VariableStatement here as it is at statement level,
    // which is why the list is lowered directly.
    const lowered = ts.isVariableDeclarationList(node.initializer)
      ? lowerDeclarationList(
          node.initializer,
          node.initializer,
          sourceFile,
          checker,
          inner,
          diagnostics,
        )
      : lowerExpressionAsStatement(
          node.initializer,
          node.initializer,
          sourceFile,
          checker,
          inner,
          diagnostics,
        );
    if (!lowered) {
      return null;
    }
    init = lowered;
  }

  let condition: Expression | undefined;
  if (node.condition !== undefined) {
    const lowered = lowerExpression(node.condition, sourceFile, checker, inner, diagnostics);
    if (!lowered) {
      return null;
    }
    condition = lowered;
  }

  let update: Statement | undefined;
  if (node.incrementor !== undefined) {
    const lowered = lowerExpressionAsStatement(
      node.incrementor,
      node.incrementor,
      sourceFile,
      checker,
      inner,
      diagnostics,
    );
    if (!lowered) {
      return null;
    }
    update = lowered;
  }

  const body = lowerBody(node.statement, sourceFile, checker, inner, diagnostics);
  if (!body) {
    return null;
  }

  return {
    kind: 'for-statement',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    ...(init && { init }),
    ...(condition && { condition }),
    ...(update && { update }),
    body,
    ...(label && { label }),
    ...(loopNeedsPerIterationEnv(node, checker) && { perIterationEnv: true as const }),
  };
}

/** `switch`. The clauses keep their source order, `default` included: its position matters for
 * fall-through even though it is tried last. Both facts are the emitter's problem, and it can only
 * honour them if the lowering preserves the order rather than hoisting `default` to the end. */
function lowerSwitch(
  node: ts.SwitchStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  label?: string,
): Statement | null {
  const discriminant = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
  if (!discriminant) {
    return null;
  }

  // The clause list is ONE block scope (see `SwitchClause`), so it gets one map: the hoist, every
  // clause test and every clause's statements share it, and the discriminant does not -- it is
  // evaluated before the switch's scope exists.
  const inner = bindings.child();
  for (const clause of node.caseBlock.clauses) {
    hoistFunctionDeclarations(clause.statements, checker, inner);
  }

  const clauses: SwitchClause[] = [];
  for (const clause of node.caseBlock.clauses) {
    let test: Expression | undefined;
    if (ts.isCaseClause(clause)) {
      const lowered = lowerExpression(clause.expression, sourceFile, checker, inner, diagnostics);
      if (!lowered) {
        return null;
      }
      test = lowered;
    }
    const statements: Statement[] = [];
    for (const child of clause.statements) {
      const stmt = lowerStatement(child, sourceFile, checker, inner, diagnostics);
      if (!stmt) {
        return null;
      }
      statements.push(stmt);
    }
    clauses.push({ ...(test && { test }), statements });
  }

  return {
    kind: 'switch-statement',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    discriminant,
    clauses,
    ...(label && { label }),
  };
}

/** Compound-assignment token -> the binary operator it folds to. */
const COMPOUND_OPERATORS = new Map<ts.SyntaxKind, BinaryOperator>([
  [ts.SyntaxKind.PlusEqualsToken, '+'],
  [ts.SyntaxKind.MinusEqualsToken, '-'],
  [ts.SyntaxKind.AsteriskEqualsToken, '*'],
  [ts.SyntaxKind.SlashEqualsToken, '/'],
  [ts.SyntaxKind.PercentEqualsToken, '%'],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, '**'],
  [ts.SyntaxKind.AmpersandEqualsToken, '&'],
  [ts.SyntaxKind.BarEqualsToken, '|'],
  [ts.SyntaxKind.CaretEqualsToken, '^'],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, '<<'],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, '>>'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, '>>>'],
]);

const LOGICAL_ASSIGN_OPERATORS = new Map<ts.SyntaxKind, LogicalOp['operator']>([
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, '&&'],
  [ts.SyntaxKind.BarBarEqualsToken, '||'],
  [ts.SyntaxKind.QuestionQuestionEqualsToken, '??'],
]);

/** An expression used for its effect and not its value: the whole of an expression statement, or
 * a `for` header's third slot. The gate has already established that any assignment-like form
 * reaching here has its value discarded, which is what makes the folds below sound.
 *
 * `span` comes from `at` rather than from `expr` so a `for` incrementor is reported at the header
 * position a reader would point to. */
function lowerExpressionAsStatement(
  expr: ts.Expression,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null {
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);

  let bare = expr;
  while (ts.isParenthesizedExpression(bare)) {
    bare = bare.expression;
  }
  if (
    ts.isBinaryExpression(bare) &&
    bare.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isObjectLiteralExpression(bare.left) || ts.isArrayLiteralExpression(bare.left))
  ) {
    return lowerDestructuringAssignment(
      bare.left,
      bare.right,
      span,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
  }

  // A member target is a different statement shape, so it is tried first: assignmentParts would
  // otherwise report `a[i] = v` as an internal "target must be an identifier" error.
  const member = memberAssignment(expr, at, sourceFile, checker, bindings, diagnostics);
  if (member !== undefined) {
    return member;
  }

  // Writing to a name nothing declares. This used to be STA4034 -- an INTERNAL error for a program
  // the language has a perfectly good answer for -- and it stayed invisible until js mode dropped
  // TS2304 and the checker stopped refusing these first (plan-notes 197).
  const undeclared = undeclaredWriteTarget(expr, checker, bindings);
  if (undeclared !== undefined) {
    const thrown: Statement = {
      kind: 'expression-statement',
      type: hUnknown(false),
      span,
      expression: {
        kind: 'reference-error',
        type: hUnknown(false),
        span: makeSpan(
          undeclared.node.getStart(sourceFile),
          undeclared.node.getWidth(sourceFile),
          sourceFile,
        ),
        name: undeclared.node.text,
      },
    };
    if (undeclared.rhs === undefined) {
      return thrown;
    }
    // A simple `=` runs its right side first, so its side effects survive the throw. `flatten`
    // keeps this a desugaring sequence rather than a scope: it introduces no binding of its own.
    const value = lowerExpression(undeclared.rhs, sourceFile, checker, bindings, diagnostics);
    if (!value) {
      return null;
    }
    return {
      kind: 'block',
      type: hUnknown(false),
      span,
      flatten: true,
      statements: [
        { kind: 'expression-statement', type: value.type, span: value.span, expression: value },
        thrown,
      ],
    };
  }

  const assignment = assignmentParts(expr, sourceFile, checker, bindings, diagnostics);
  if (assignment === null) {
    return null;
  }
  if (assignment !== undefined) {
    return assignmentStatement(assignment, span);
  }

  const exp = lowerExpression(expr, sourceFile, checker, bindings, diagnostics);
  if (!exp) {
    return null;
  }
  return { kind: 'expression-statement', type: exp.type, span, expression: exp };
}

/** Expando assignments can give an undeclared JS name a checker namespace, but no runtime slot.
 * Real declarations may merge into that symbol too, so Assignment flags alone are not enough. */
function isUnresolvableIdentifier(
  node: ts.Identifier,
  checker: ts.TypeChecker,
  bindings: Scope,
): boolean {
  if (bindings.has(node.text)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node);
  return (
    symbol === undefined ||
    ((symbol.flags & ts.SymbolFlags.Assignment) !== 0 &&
      symbol.declarations !== undefined &&
      symbol.declarations.length > 0 &&
      symbol.declarations.every(ts.isIdentifier))
  );
}

/** An assignment or update whose TARGET is a name nothing declares.
 *
 * In strict mode -- which §1.2 makes every module, both modes -- PutValue on an unresolvable
 * reference throws a ReferenceError rather than creating a global, so this is a runtime answer and
 * not an internal error. `rhs` is present for exactly one form, and the distinction is observable:
 * a simple `=` evaluates its right side BEFORE the throw (`missing = side()` runs `side`), while a
 * compound assignment or an update reads the target first and throws before the right side runs.
 *
 * A synthesized namespace from a sibling property assignment is not a real declaration either. */
function undeclaredWriteTarget(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  bindings: Scope,
): { node: ts.Identifier; rhs?: ts.Expression } | undefined {
  const unresolved = (node: ts.Expression): ts.Identifier | undefined =>
    ts.isIdentifier(node) && isUnresolvableIdentifier(node, checker, bindings) ? node : undefined;
  if (ts.isBinaryExpression(expr)) {
    const target = unresolved(expr.left);
    if (target === undefined) {
      return undefined;
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return { node: target, rhs: expr.right };
    }
    return COMPOUND_OPERATORS.has(expr.operatorToken.kind) ||
      LOGICAL_ASSIGN_OPERATORS.has(expr.operatorToken.kind)
      ? { node: target }
      : undefined;
  }
  const update = updateOperator(expr);
  if (update === undefined) {
    return undefined;
  }
  const target = unresolved(update.operand);
  return target === undefined ? undefined : { node: target };
}

/** The binding an assignment TARGET names, or `undefined` if it names no binding at all.
 *
 * Two spellings reach one binding: a plain identifier, and `C.count` on a static. Resolving both
 * here is what lets `C.count += 1` and `C.count++` reuse the identifier machinery unchanged --
 * a static is a plain binding, so there is no place to evaluate once and nothing to hoist. */
function placeName(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.getText(sourceFile);
  }
  if (!ts.isPropertyAccessExpression(node)) {
    return undefined;
  }
  const found = frontendTypes.staticMemberOf(node, checker, false);
  return found === undefined || classDisplayName(found.owner) === undefined
    ? undefined
    : staticName(hirClassName(found.owner), node.name.text);
}

/** The parameter a method's `this` reads from. The leading space makes it unspellable in source,
 * so it can never collide with a user binding, and it is the SAME key the emitter maps to a frame
 * slot -- `this` is an ordinary identifier from here down (see ClassMethod in src/hir/nodes.ts). */
/** Parameter zero of a method, constructor or accessor. Spelled once, in captures.ts, because the
 * capture analysis has to name the same binding when an arrow reads it. */
const RECEIVER = RECEIVER_NAME;
const CATCH_VALUE = ' catch';

let bindTempId = 0;
function nextBindTemp(): string {
  bindTempId += 1;
  return ` bind${String(bindTempId)}`;
}

function bindPatternNames(name: ts.BindingName, checker: ts.TypeChecker, bindings: Scope): void {
  if (ts.isIdentifier(name)) {
    // A destructuring pattern's names are declarations of the scope they appear in, so they go
    // through the same shadow-aware path: `catch ({ e })` under an outer `e` renames.
    bindings.declare(name.text, typeAt(name, checker, bindings));
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      bindPatternNames(el.name, checker, bindings);
    }
    return;
  }
  for (const el of name.elements) {
    if (!ts.isOmittedExpression(el)) {
      bindPatternNames(el.name, checker, bindings);
    }
  }
}

/** The binding name a static member gets: `C.count`.
 *
 * A dot is what makes it unspellable, the same trick `RECEIVER` uses with a leading space -- no
 * source identifier can contain one, so a static can never collide with a user binding. The
 * DECLARING class is the half that matters: statics are inherited, so `D.count` on a subclass and
 * `C.count` on its base must produce the same name or one static would become two bindings. */
function staticName(className: string, member: string): string {
  return `${className}.${member}`;
}

/** The HIR name of a class declaration: the alpha-renamed binding when the declaration shadows a
 * visible one (plan.md §8 step 23), otherwise the source name it was declared under.
 *
 * Every site that names a class -- a `new`, a method call's owner, a static's prefix, an
 * `instanceof`, a base -- resolves through the DECLARATION rather than the spelling, because two
 * declarations may share one spelling and only the declaration knows which HIR name it got. A
 * declaration that has not been lowered yet (a forward reference, which is TDZ the compiler does
 * not model) falls back to the source name, which is what the descriptor will carry too: the
 * declaration site renames only against bindings already made. */
function hirClassName(declaration: ts.ClassDeclaration | ts.ClassExpression): string {
  return hirNameOf(declaration) ?? classDisplayName(declaration) ?? '';
}

/** The class a `C.name` receiver names — a declaration, a `const K = C` alias chain, or a bound
 * class expression (docs/VALUE.md §4.26). `undefined` for anything else, including an unbound
 * expression, which the gate refused before the lowering asked. */
function classObjectOwner(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  if (!ts.isIdentifier(receiver)) {
    return undefined;
  }
  return (
    frontendTypes.aliasedClassDeclaration(receiver, checker) ??
    frontendTypes.classExpressionTarget(receiver, checker)
  );
}

/** The storage a `#private` USE resolves to: the mangled slot/property plus the class that
 * declares it.
 *
 * A private name is lexically scoped -- the checker's symbol for the use IS the declaration, so
 * the owner is read off it, never off the receiver's type. That distinction is the whole fix for
 * re-declared names: `o.#x` written in `A` means `A`'s slot (`#x@A`) even when `o` is typed `B`,
 * where the most-derived lookup the public paths use would answer `#x@B`. Shared by every
 * instance-`#private` path (reads, writes, calls, updates), so no two can disagree about which
 * slot a spelling means. `undefined` when the name resolves to nothing the gate accepted -- the
 * caller reports the internal error, since the gate admits a private use only then. */
function privateUse(
  name: ts.PrivateIdentifier,
  checker: ts.TypeChecker,
): { owner: ts.ClassDeclaration | ts.ClassExpression; property: string } | undefined {
  const owner = brandDeclaringClass(name, checker);
  const ownerName = owner === undefined ? undefined : classDisplayName(owner);
  if (owner === undefined || ownerName === undefined) {
    return undefined;
  }
  return { owner, property: frontendTypes.privateSlotName(ownerName, name.text) };
}

/** Which halves of the instance `#private` accessor `raw` the LEXICAL owner declares.
 *
 * Unlike the public `hasAccessorHalf`/`accessorOwner` pair, this never walks the receiver's
 * chain: each class owns an independent pair (`get #x@A` vs `get #x@B`), so the halves that
 * matter are the owner's own. */
function privateAccessorHalves(
  owner: ts.ClassDeclaration | ts.ClassExpression,
  raw: string,
): { get: boolean; set: boolean } {
  let get = false;
  let set = false;
  for (const member of owner.members) {
    if (
      member.name === undefined ||
      !ts.isPrivateIdentifier(member.name) ||
      member.name.text !== raw
    ) {
      continue;
    }
    if (ts.isGetAccessorDeclaration(member)) {
      get = true;
    }
    if (ts.isSetAccessorDeclaration(member)) {
      set = true;
    }
  }
  return { get, set };
}

/** Whether the lexical owner's `#private` member is an accessor pair (either half). */
function privateIsAccessor(owner: ts.ClassDeclaration | ts.ClassExpression, raw: string): boolean {
  return owner.members.some(
    (m) =>
      m.name !== undefined &&
      ts.isPrivateIdentifier(m.name) &&
      m.name.text === raw &&
      (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)),
  );
}

/** Whether a member write targets an instance `#private` accessor: routed by the lexical
 * owner's declaration (see `privateUse`), never by the receiver's type. Element accesses are
 * never private, so they answer false without asking the checker anything. */
function privateWriteIsAccessor(
  targetNode: ts.ElementAccessExpression | ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isPropertyAccessExpression(targetNode) || !ts.isPrivateIdentifier(targetNode.name)) {
    return false;
  }
  const priv = privateUse(targetNode.name, checker);
  return priv !== undefined && privateIsAccessor(priv.owner, targetNode.name.text);
}

/** The member declaration a `#private` use's lexical owner holds for it, if it holds one as a
 * member node (a `.js` field assigned in the constructor has none -- the slot still exists). */
function privateOwnerMember(
  owner: ts.ClassDeclaration | ts.ClassExpression,
  raw: string,
): ts.ClassElement | undefined {
  return owner.members.find(
    (m) => m.name !== undefined && ts.isPrivateIdentifier(m.name) && m.name.text === raw,
  );
}

/** Whether `o.x` must resolve through the SHAPE TABLE rather than a slot — the one question the
 * read path and the write path both have to answer the same way, which is why it is one function.
 *
 * `this` is decided by the receiver BINDING, not by the checker. Inside an object literal's
 * accessor the checker types `this` as the literal's structural shape, which looks exactly like a
 * layout — but the object is a `JSRTDynObject` (docs/VALUE.md §4.15), and the binding is the only
 * place that is recorded. Inside a class member the binding is the layout, so this answers false
 * and the fixed-slot path takes over, unchanged. */
/** A method receiver's type as its lowering will carry it. A property read through a dynamic
 * target lowers to a `dyn-field-access`, which is Unknown whatever the checker says: `this.name`
 * in an object literal's `function` reads through an Unknown receiver, while the checker types it
 * from the literal. Asking the checker instead sent `this.name.toUpperCase()` to the string-op
 * arm with an Unknown target, an internal STA4081 (plan-notes 310); the dynamic method call is
 * what runs it, `jsrt_get_prop` answering the bound String.prototype method. */
function receiverTypeAt(obj: ts.Expression, checker: ts.TypeChecker, bindings: Scope): HType {
  // `Math.PI` and `Number.EPSILON` read through a global with no HType, but they fold to number
  // literals before any dynamic read is considered, so they keep the checker's `number`.
  const folds =
    ts.isPropertyAccessExpression(obj) &&
    ((isGlobalMath(obj.expression, checker) && MATH_CONSTANTS.has(obj.name.text)) ||
      numberConstant(obj, checker) !== undefined);
  return ts.isPropertyAccessExpression(obj) &&
    !folds &&
    (targetIsDynamic(obj.expression, checker, bindings) ||
      frontendTypes.isFunctionValueMember(obj.expression, obj.name.text, checker) ||
      frontendTypes.isUndeclaredMemberRead(obj, checker))
    ? hUnknown(false)
    : typeAt(obj, checker, bindings);
}

function targetIsDynamic(target: ts.Expression, checker: ts.TypeChecker, bindings: Scope): boolean {
  if (target.kind === ts.SyntaxKind.ThisKeyword) {
    return bindings.get(RECEIVER)?.kind === 'unknown';
  }
  return (
    frontendTypes.isFunctionMemberRead(target, checker) ||
    frontendTypes.isUndeclaredMemberRead(target, checker) ||
    frontendTypes.isDynamicShape(checker.getTypeAtLocation(target), checker) ||
    typeAt(target, checker, bindings).kind === 'unknown'
  );
}

/** The slot `field` occupies in `target`'s class, or `null` after reporting an internal error.
 *
 * A miss is never a user error: the checker proved the name is declared and the gate proved the
 * target is a class this subset lays out, so the only way to get here is for `classTypeToHType` and
 * the gate to disagree about what a class IS -- which is the load-bearing invariant, and an
 * internal bug when it breaks. */
function slotOf(
  target: Expression,
  field: string,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
): number | null {
  const slot = target.type.kind === 'object' ? fieldSlot(target.type, field) : undefined;
  if (slot === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4060',
        'internal',
        `no field '${field}' on ${hTypeName(target.type)}`,
      ),
    );
    return null;
  }
  return slot;
}

/** The statement writing `assignment`: a TypeError for a named function expression's own name,
 * which is immutable inside its body, and the assignment otherwise. */
function assignmentStatement(
  assignment: { target: string; value: Expression },
  span: Span,
): Statement {
  if (immutableSelfBindings.has(assignment.target)) {
    return {
      kind: 'expression-statement',
      type: H_UNDEFINED,
      span,
      expression: {
        kind: 'type-error',
        type: H_UNDEFINED,
        span,
        message: 'Assignment to constant variable.',
      },
    };
  }
  return { kind: 'assignment', type: assignment.value.type, span, ...assignment };
}

/** `({ a, b: c } = rhs)` / `[a, , b] = rhs` as a statement: the right side once, then one
 * assignment per target, each reading what the declaration form `const { a, b: c } = rhs` reads
 * (plan-notes 310). The gate admitted only variable targets with no default, rest or nesting. */
function lowerDestructuringAssignment(
  pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  rhsNode: ts.Expression,
  span: Span,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null {
  const rhs = lowerExpression(rhsNode, sourceFile, checker, bindings, diagnostics);
  if (rhs === null) {
    return null;
  }
  const statements: Statement[] = [];
  const source = patternSource(rhs, span, bindings, statements);
  const targets: { key: string | number; name: ts.Expression; at: ts.Node }[] = [];
  if (ts.isObjectLiteralExpression(pattern)) {
    for (const p of pattern.properties) {
      if (ts.isShorthandPropertyAssignment(p)) {
        targets.push({ key: p.name.text, name: p.name, at: p });
      } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        targets.push({ key: p.name.text, name: p.initializer, at: p });
      }
    }
  } else {
    pattern.elements.forEach((el, index) => {
      if (!ts.isOmittedExpression(el)) {
        targets.push({ key: index, name: el, at: el });
      }
    });
  }
  for (const { key, name, at } of targets) {
    if (!ts.isIdentifier(name)) {
      diagnostics.push(
        lowerDiagnostic(
          name,
          sourceFile,
          'STA4033',
          'internal',
          'assignment target must be an identifier',
        ),
      );
      return null;
    }
    const parts = identifierAssignment(
      name,
      () => lowerPatternRead(source, key, name, at, sourceFile, checker, bindings, diagnostics),
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
    if (parts === null) {
      return null;
    }
    statements.push(assignmentStatement(parts, span));
  }
  return { kind: 'block', type: H_UNDEFINED, span, flatten: true, statements };
}

/** The `{ target, value }` of an assignment to the variable `targetNode` names, `make` building the
 * value from the variable's current reading. Shared by `x = e` and its folds (assignmentParts) and
 * by each target of a destructuring assignment (plan-notes 310). */
function identifierAssignment(
  targetNode: ts.Expression,
  make: (current: Identifier) => Expression | null,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { target: string; value: Expression } | null {
  const target = placeName(targetNode, sourceFile, checker);
  if (target === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        targetNode,
        sourceFile,
        'STA4033',
        'internal',
        'assignment target must be an identifier',
      ),
    );
    return null;
  }
  const binding = bindings.get(target);
  if (!binding) {
    diagnostics.push(
      lowerDiagnostic(
        targetNode,
        sourceFile,
        'STA4034',
        'internal',
        `identifier '${target}' assigned before declaration`,
      ),
    );
    return null;
  }
  const current: Identifier = {
    kind: 'identifier',
    type: binding,
    span: makeSpan(targetNode.getStart(sourceFile), targetNode.getWidth(sourceFile), sourceFile),
    // The HIR name: a shadowing binding writes to its own slot, not the outer one it shadows
    // (plan.md §8 step 14).
    name: bindings.hirName(target),
  };
  const raw = make(current);
  if (raw === null) {
    return null;
  }
  // Step 17's rule, extended to assignment: `h = () => ...` prints `[Function: h]`. Only a
  // simple identifier target names its value -- a static member write (`C.f = ...`) keeps
  // today's output, matching Node, which prints those anonymous. The display spelling is the
  // target's SOURCE text, never the HIR name a shadowed binding writes under.
  const value = ts.isIdentifier(targetNode) ? withDisplayName(raw, targetNode.text) : raw;
  return {
    target: bindings.hirName(target),
    value: edgeBoundary(value, binding, targetNode, sourceFile),
  };
}

/** The target and value of `x = e`, `x += e`, `x++` and `--x`, or `undefined` if `expr` is none of
 * those. `null` means it was one and lowering it failed.
 *
 * `x += e` folds to `x = x + e` and `x++` to `x = (+x) + 1`. Those two are NOT the same shape, and
 * the difference is the reason for the explicit unary `+`: `+=` uses the `+` OPERATOR, which
 * concatenates when either side is a string, while `++` is defined to run ToNumber first. For
 * `x = '5'` the language says `x += 1` is `'51'` and `x++` is `6`, and only the unary `+` keeps
 * those apart. It is written on the `--` path too, where `-` would have coerced anyway, so the
 * pair reads as one rule rather than two. */
function assignmentParts(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { target: string; value: Expression } | null | undefined {
  const build = (
    targetNode: ts.Expression,
    make: (current: Identifier) => Expression | null,
  ): { target: string; value: Expression } | null =>
    identifierAssignment(targetNode, make, sourceFile, checker, bindings, diagnostics);

  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return build(expr.left, () =>
        lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics),
      );
    }
    const operator = COMPOUND_OPERATORS.get(expr.operatorToken.kind);
    if (operator !== undefined) {
      return build(expr.left, (current) => {
        const right = lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics);
        if (right === null) {
          return null;
        }
        // NOT H_NUMBER: `+=` is the `+` operator, so `s += 1` on a string is a string. Asking the
        // checker for the type of the whole `x += e` is the only answer that holds for all five
        // compound operators — the verifier rejected the hardcoded number, correctly.
        // `arithmeticBinOp` repairs the coercing four (`-=`, `*=`, `/=`, `%=`, `**=`): a suppressed
        // TS2362 lets a statically-known primitive reach them, and the emitter coerces it through
        // `jsrt_to_number` exactly as the binary spelling does (plan.md §8 step 37).
        return arithmeticBinOp(
          operator,
          current,
          right,
          current.span,
          typeAt(expr, checker, bindings),
        );
      });
    }
    const logicalAssign = LOGICAL_ASSIGN_OPERATORS.get(expr.operatorToken.kind);
    if (logicalAssign !== undefined) {
      return build(expr.left, (current) => {
        const right = lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics);
        if (right === null) {
          return null;
        }
        return {
          kind: 'logical-op',
          type: typeAt(expr, checker, bindings),
          span: current.span,
          operator: logicalAssign,
          left: current,
          right,
        };
      });
    }
    return undefined;
  }

  const update = updateOperator(expr);
  if (update === undefined) {
    return undefined;
  }
  // H_NUMBER is right here and nowhere else in this function: `++` runs ToNumber first, so its
  // result is a number even when the variable held a string.
  return build(update.operand, (current) => ({
    kind: 'binary-op',
    type: H_NUMBER,
    span: current.span,
    operator: update.operator,
    left: { kind: 'unary-op', type: H_NUMBER, span: current.span, operator: '+', operand: current },
    right: { kind: 'number-literal', type: H_NUMBER, span: current.span, value: 1 },
  }));
}

/** Can this expression be re-read without re-running anything? An identifier and a literal can:
 * evaluating either twice is indistinguishable from evaluating it once. Anything else -- a call, a
 * nested index, an assignment -- has to be hoisted into a temporary so the read and the write of
 * `a[i()] += 1` share ONE evaluation (plan-notes 43). Erring toward hoisting is always correct;
 * this predicate only avoids spending a frame slot where it would buy nothing. */
function isSideEffectFree(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Assignment to a MEMBER of something: `a[i] = v`, `o.x = v`, and the `op=`, `++` and `--` forms
 * of each. `undefined` when `expr` is none of those; `null` when it was one and lowering it failed.
 *
 * The two places are one function because they differ in exactly two lines — how the place is read
 * and how it is written — and agree on everything expensive: which operator folds to which, and
 * THE READ-ONCE RULE (plan-notes 43), which says a compound form must evaluate each part of the
 * place exactly ONCE. `a[i()] += 1` calls `i` a single time, and `f().x++` calls `f` a single time;
 * the fold `a[i] = a[i] + 1` names the parts twice, so anything not already re-readable is bound to
 * a temporary and the fold refers to that. */
function memberAssignment(
  expr: ts.Expression,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null | undefined {
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);

  const { compound, logical: logicalAssign } = assignOperatorKinds(expr);
  const update = updateOperator(expr);
  const plain =
    ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken;

  const targetNode = ts.isBinaryExpression(expr)
    ? expr.left
    : update !== undefined
      ? update.operand
      : undefined;
  if (
    targetNode === undefined ||
    !(ts.isElementAccessExpression(targetNode) || ts.isPropertyAccessExpression(targetNode))
  ) {
    return undefined;
  }
  if (!plain && compound === undefined && logicalAssign === undefined && update === undefined) {
    return undefined; // a binary operator that is not an assignment at all
  }
  // `C.count = …` looks like a member write and is not one: a static is a plain binding, so it
  // belongs to the identifier path, which `assignmentParts` reaches once this declines it. A
  // static ACCESSOR is the exception: `C.value = v` RUNS the setter, so it takes the place
  // path with two plain calls and no receiver to hoist.
  const staticFound = ts.isPropertyAccessExpression(targetNode)
    ? frontendTypes.staticMemberOf(targetNode, checker, undefined)
    : undefined;
  const staticAccessor =
    staticFound !== undefined &&
    classDisplayName(staticFound.owner) !== undefined &&
    ts.isPropertyAccessExpression(targetNode) &&
    (ts.isGetAccessorDeclaration(staticFound.member) ||
      ts.isSetAccessorDeclaration(staticFound.member))
      ? {
          owner: hirClassName(staticFound.owner),
          property: targetNode.name.text,
          halves: staticAccessorHalves(staticFound.owner, targetNode.name.text, checker),
        }
      : undefined;
  if (staticAccessor === undefined) {
    if (
      ts.isPropertyAccessExpression(targetNode) &&
      frontendTypes.staticMemberOf(targetNode, checker, false) !== undefined
    ) {
      return undefined;
    }
  }

  // The folds a place supports -- plain, compound, update, logical -- applied to a read and a
  // write. Shared by the member path below (whose receiver hoists into `prefix`) and the static
  // accessor path (two plain calls, nothing to hoist), so the two agree on every operator.
  const finishPlace = (
    current: Expression,
    write: (value: Expression) => Statement,
    prefix: Statement[],
  ): Statement | null | undefined => {
    let value: Expression | null;
    if (update !== undefined) {
      // `++` runs ToNumber first, so the result is a number even when the place held a string --
      // the same distinction assignmentParts spells out for `x++` versus `x += 1`.
      value = {
        kind: 'binary-op',
        type: H_NUMBER,
        span,
        operator: update.operator,
        left: { kind: 'unary-op', type: H_NUMBER, span, operator: '+', operand: current },
        right: { kind: 'number-literal', type: H_NUMBER, span, value: 1 },
      };
    } else if (!ts.isBinaryExpression(expr)) {
      return undefined;
    } else if (compound !== undefined) {
      const right = lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics);
      // The identifier path's `arithmeticBinOp`, for the same suppressed TS2362: a member holding
      // a statically-known primitive coerces through `jsrt_to_number` (plan.md §8 step 37).
      value =
        right === null
          ? null
          : arithmeticBinOp(compound, current, right, span, typeAt(expr, checker, bindings));
    } else if (logicalAssign !== undefined) {
      const right = lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics);
      value =
        right === null
          ? null
          : {
              kind: 'logical-op',
              type: typeAt(expr, checker, bindings),
              span,
              operator: logicalAssign,
              left: current,
              right,
            };
    } else {
      value = lowerExpression(expr.right, sourceFile, checker, bindings, diagnostics);
    }
    if (value === null) {
      return null;
    }

    const stmt = write(value);
    if (prefix.length === 0) {
      return stmt;
    }
    // The temporaries and the write are one statement, so this fits anywhere a statement does --
    // including a `for` update clause, which the emitter emits as a statement after the body.
    prefix.push(stmt);
    return { kind: 'block', type: H_UNDEFINED, span, statements: prefix };
  };

  if (staticAccessor !== undefined) {
    // A set-only static has no read, mirroring the instance path: the only forms that read are
    // the compound ones, and those answer `undefined` for the missing half.
    const placeType = typeAt(targetNode, checker, bindings);
    const read = staticAccessor.halves.get
      ? staticAccessorCall(
          'get',
          staticAccessor.owner,
          staticAccessor.property,
          [],
          placeType,
          span,
          targetNode,
          sourceFile,
          bindings,
          diagnostics,
        )
      : { kind: 'undefined-literal' as const, type: H_UNDEFINED, span };
    if (read === null) {
      return null;
    }
    const write = (value: Expression): Statement => {
      const call = staticAccessorCall(
        'set',
        staticAccessor.owner,
        staticAccessor.property,
        [value],
        H_UNDEFINED,
        span,
        targetNode,
        sourceFile,
        bindings,
        diagnostics,
      );
      // `staticAccessorCall` already reported; a null here would be the same miss the read
      // survived.
      return call === null
        ? { kind: 'expression-statement', type: H_UNDEFINED, span, expression: value }
        : { kind: 'expression-statement', type: H_UNDEFINED, span, expression: call };
    };
    return finishPlace(read, write, []);
  }

  // A compound form reads the place and writes it back, so every part of the PLACE must be
  // evaluated exactly once: `a[i()] += 1` calls `i` a single time, and the value it returned is
  // both the slot read and the slot written. The fold names each part twice, so anything that is
  // not already re-readable is bound to a temporary and the fold refers to that. A plain `=` reads
  // nothing and needs none of it -- which is what `plain` short-circuits below.
  const statements: Statement[] = [];
  const hoisted = (node: ts.Expression, slot: number): Expression | null => {
    const lowered = lowerExpression(node, sourceFile, checker, bindings, diagnostics);
    if (lowered === null || plain || isSideEffectFree(node)) {
      return lowered;
    }
    // The name is unspellable in source, so it can never shadow a user binding. It stays a
    // compile-time key: the emitter maps every binding to a frame slot and emits the slot.
    const name = ` index${String(slot)}`;
    bindings.set(name, lowered.type);
    statements.push({
      kind: 'declaration',
      type: lowered.type,
      span: lowered.span,
      name,
      declKind: 'const',
      value: lowered,
    });
    return { kind: 'identifier', type: lowered.type, span: lowered.span, name };
  };

  const target = hoisted(targetNode.expression, 0);
  if (target === null) {
    return null;
  }

  // The place, in the two forms it can take: what reading it looks like, and what writing it is.
  // The read is only used by the compound and update folds; a plain `=` discards it.
  let current: Expression;
  let write: (value: Expression) => Statement;
  const placeType = typeAt(targetNode, checker, bindings);
  if (ts.isElementAccessExpression(targetNode)) {
    // `o["a-b"] = v` on a FIXED shape is `o.a = v` written the only way a key that is not an
    // identifier can be spelled -- the same reduction the READ path makes (plan.md §8 step 12
    // family c). A literal-typed key (`o[k] = v` with `k: "m"`) is the same name by the
    // step-22 rule, so an accessor under one RUNS its setter exactly as the dot spelling does;
    // anything else keeps the field-or-index split below. Building an index node here instead
    // made the write the one spelling of a fixed-shape property that did not compile: the
    // verifier rejects an index write on a layout, so `o["n"] = 5` was STA4044 while the
    // value-position `(o["n"] += 1)` -- which goes through the read path -- worked
    // (plan-notes 222).
    const literalKey = frontendTypes.elementStaticKey(targetNode.argumentExpression, checker);
    const placeOwner =
      literalKey !== null && target.type.kind === 'object'
        ? accessorOwner(targetNode.expression, literalKey, checker, bindings, sourceFile)
        : undefined;
    if (placeOwner !== undefined && literalKey !== null) {
      const place = accessorPlace(
        placeOwner,
        target,
        literalKey,
        hasAccessorHalf(targetNode.expression, literalKey, 'get', checker, bindings, sourceFile),
        placeType,
        span,
        targetNode,
        sourceFile,
        checker,
        diagnostics,
      );
      if (place === null) {
        return null;
      }
      ({ current, write } = place);
    } else if (literalKey !== null && target.type.kind === 'object') {
      const slot = slotOf(target, literalKey, targetNode, sourceFile, diagnostics);
      if (slot === null) {
        return null;
      }
      current = { kind: 'field-access', type: placeType, span, target, field: literalKey, slot };
      write = (value) => ({
        kind: 'field-assignment',
        type: value.type,
        span,
        target,
        field: literalKey,
        slot,
        value,
      });
    } else {
      const index = hoisted(targetNode.argumentExpression, 1);
      if (index === null) {
        return null;
      }
      current = { kind: 'index-access', type: placeType, span, target, index };
      write = (value) => ({
        kind: 'index-assignment',
        type: value.type,
        span,
        target,
        index,
        value,
      });
    }
  } else if (
    ts.isPropertyAccessExpression(targetNode) &&
    ts.isPrivateIdentifier(targetNode.name) &&
    privateUse(targetNode.name, checker) === undefined
  ) {
    // A `#private` use the checker cannot resolve to a declaration is a program the gate
    // refused -- every `#private` lookup below assumes a lexical owner exists.
    diagnostics.push(
      lowerDiagnostic(
        targetNode,
        sourceFile,
        'STA4060',
        'internal',
        `no private '${targetNode.name.text}' the gate accepted`,
      ),
    );
    return null;
  } else if (
    privateWriteIsAccessor(targetNode, checker) ||
    accessorOwner(targetNode.expression, targetNode.name.text, checker, bindings, sourceFile) !==
      undefined
  ) {
    // `o.x = v` RUNS the setter. The gate refused the compound forms, so `current` is never read
    // here -- it is built anyway so the two halves of a place stay one shape.
    // A `#private` place resolves lexically (see the read arm): the mangled slot plus lexical
    // owner, preferred here over the receiver-based lookups below.
    const writePriv = ts.isPrivateIdentifier(targetNode.name)
      ? privateUse(targetNode.name, checker)
      : undefined;
    const writeRaw = targetNode.name.text;
    const lexicalOwner =
      writePriv !== undefined
        ? mangleClassName(writePriv.owner, targetNode.expression, checker, bindings)
        : undefined;
    if (writePriv !== undefined && lexicalOwner === null) {
      diagnostics.push(
        lowerDiagnostic(
          targetNode,
          sourceFile,
          'STA4067',
          'internal',
          `private '${writeRaw}' names no descriptor the lowering can reach`,
        ),
      );
      return null;
    }
    const field = writePriv?.property ?? targetNode.name.text;
    const owner =
      lexicalOwner ??
      accessorOwner(targetNode.expression, field, checker, bindings, sourceFile) ??
      '';
    // A set-only property has no read at all, which is legal and is why this is conditional: the
    // only forms that would read it are the compound ones, and the gate refused those.
    const writeHasGet =
      writePriv !== undefined
        ? privateAccessorHalves(writePriv.owner, writeRaw).get
        : hasAccessorHalf(targetNode.expression, field, 'get', checker, bindings, sourceFile);
    const place = accessorPlace(
      owner,
      target,
      field,
      writeHasGet,
      placeType,
      span,
      targetNode,
      sourceFile,
      checker,
      diagnostics,
    );
    if (place === null) {
      return null;
    }
    ({ current, write } = place);
  } else if (
    targetIsDynamic(targetNode.expression, checker, bindings) ||
    frontendTypes.isFunctionValueMember(targetNode.expression, targetNode.name.text, checker) ||
    frontendTypes.isUndeclaredMemberRead(targetNode, checker) ||
    (target.type.kind === 'array' && targetNode.name.text === 'length')
  ) {
    // A dynamic-shape write goes through the shape table (docs/VALUE.md §4.10). The compound and
    // update forms read `current` through the same receiver, which `hoisted` evaluated once, so
    // `f().n += 1` calls `f` a single time (plan-notes 310). An array's `length` is written by the
    // same runtime entry, which resizes the array instead of touching a table (ECMA-262
    // §10.4.2.4), and read as any `xs.length` is. So is an ordinary function's own property
    // (`f.count += 1`), which lives in the closure's property table.
    const field = targetNode.name.text;
    current =
      target.type.kind === 'array'
        ? lengthRead(target, span)
        : { kind: 'dyn-field-access', type: hUnknown(false), span, target, field };
    write = (value) => ({
      kind: 'dyn-field-assignment',
      type: value.type,
      span,
      target,
      field,
      value,
    });
  } else {
    const writeFieldPriv = ts.isPrivateIdentifier(targetNode.name)
      ? privateUse(targetNode.name, checker)
      : undefined;
    const field = writeFieldPriv?.property ?? targetNode.name.text;
    const slot = slotOf(target, field, targetNode, sourceFile, diagnostics);
    if (slot === null) {
      return null;
    }
    current = { kind: 'field-access', type: placeType, span, target, field, slot };
    write = (value) => ({
      kind: 'field-assignment',
      type: value.type,
      span,
      target,
      field,
      slot,
      value,
    });
  }

  return finishPlace(current, write, statements);
}

/** `a[i]` as a read. Shared by the expression case and by the compound-assignment fold, so both
 * agree on the node's type — which comes from the checker, and is `T | undefined` under
 * `noUncheckedIndexedAccess`, not the array's element type. */
function lowerIndexAccess(
  node: ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): IndexAccess | null {
  const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
  if (!target) {
    return null;
  }
  const index = lowerExpression(
    node.argumentExpression,
    sourceFile,
    checker,
    bindings,
    diagnostics,
  );
  if (!index) {
    return null;
  }
  return {
    kind: 'index-access',
    type: typeAt(node, checker, bindings),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    target,
    index,
  };
}

/** `x++`, `x--`, `++x`, `--x` — prefix and postfix are the same statement once the value is
 * discarded, which the gate has already guaranteed. */
function updateOperator(
  expr: ts.Expression,
): { operand: ts.Expression; operator: '+' | '-' } | undefined {
  if (!ts.isPostfixUnaryExpression(expr) && !ts.isPrefixUnaryExpression(expr)) {
    return undefined;
  }
  if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
    return { operand: expr.operand, operator: '+' };
  }
  if (expr.operator === ts.SyntaxKind.MinusMinusToken) {
    return { operand: expr.operand, operator: '-' };
  }
  return undefined;
}

function loopNeedsPerIterationEnv(loop: ts.IterationStatement, checker: ts.TypeChecker): boolean {
  let captured = false;
  const visit = (node: ts.Node, nested: boolean): void => {
    if (captured) {
      return;
    }
    if (isFunctionLike(node)) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (nested && ts.isIdentifier(node)) {
      const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (
        decl !== undefined &&
        loopScopeOf(decl) === loop &&
        !(
          ts.isVariableDeclaration(decl) &&
          ts.isVariableDeclarationList(decl.parent) &&
          isVarDeclarationList(decl.parent)
        )
      ) {
        captured = true;
      }
    }
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(loop, false);
  return captured;
}

function lowerUpdateExpression(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null | undefined {
  const parent = node.parent;
  if (
    ts.isExpressionStatement(parent) ||
    (ts.isForStatement(parent) && parent.incrementor === node)
  ) {
    return undefined;
  }
  const update = updateOperator(node);
  const plain =
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  const { compound, logical } = assignOperatorKinds(node);
  if (update === undefined && compound === undefined && logical === undefined && !plain) {
    return undefined;
  }
  const targetNode =
    update !== undefined ? update.operand : ts.isBinaryExpression(node) ? node.left : undefined;
  if (targetNode === undefined) {
    return undefined;
  }
  const target = lowerUpdatePlace(targetNode, sourceFile, checker, bindings, diagnostics);
  if (target === null) {
    return null;
  }
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  if (update !== undefined) {
    const prefix = ts.isPrefixUnaryExpression(node);
    return {
      kind: 'update',
      type: H_NUMBER,
      span,
      operator: update.operator === '+' ? '++' : '--',
      prefix,
      target,
    };
  }
  const assignOp: UpdateExpr['operator'] | undefined =
    compound ?? logical ?? (plain ? '=' : undefined);
  if (assignOp !== undefined && ts.isBinaryExpression(node)) {
    const raw = lowerExpression(node.right, sourceFile, checker, bindings, diagnostics);
    if (raw === null) {
      return null;
    }
    // Step 17's rule, extended to assignment expressions: `console.log((h = () => ...))` prints
    // `[Function: h]`. Only the simple `=` names its value -- a compound form never sees a bare
    // function here -- and only a simple identifier target, for the same static-member reason
    // the statement path states. The inner assignment of a chain is what fires (`y` in
    // `x = y = () => {}`); the outer sees an update node, not a literal, so it cannot rename.
    const value = plain && ts.isIdentifier(node.left) ? withDisplayName(raw, node.left.text) : raw;
    return {
      kind: 'update',
      type: typeAt(node, checker, bindings),
      span,
      operator: assignOp,
      prefix: true,
      target,
      value,
    };
  }
  return undefined;
}

function lowerUpdatePlace(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): UpdatePlace | null {
  // An accessor place is a CALL pair, not a slot: `c.x += 1` in value position runs the getter,
  // folds, and runs the setter — the statement-position rule's twin (`memberAssignment`'s
  // `accessorPlace`), with the fold's answer as the expression value (plan.md §8 step 12b).
  const accessorTarget = accessorUpdateTarget(node, checker, bindings, sourceFile, diagnostics);
  if (accessorTarget !== undefined) {
    return accessorTarget;
  }
  const expr = lowerExpression(node, sourceFile, checker, bindings, diagnostics);
  if (expr === null) {
    return null;
  }
  if (
    expr.kind === 'identifier' ||
    expr.kind === 'index-access' ||
    expr.kind === 'field-access' ||
    expr.kind === 'dyn-field-access'
  ) {
    return expr;
  }
  // `(xs.length = n)` in value position: the place is the array's `length`, which the runtime's
  // property entries read and resize (plan-notes 310) -- the dynamic place over a typed array.
  if (expr.kind === 'array-length') {
    const place: DynFieldAccess = {
      kind: 'dyn-field-access',
      type: hUnknown(false),
      span: expr.span,
      target: expr.operand,
      field: 'length',
    };
    return place;
  }
  diagnostics.push(
    lowerDiagnostic(
      node,
      sourceFile,
      'STA4033',
      'internal',
      'update target must be a variable or member',
    ),
  );
  return null;
}

/** An accessor `++`/`--`/`+=`/`=` place, or `undefined` when `node` is not one. Shared by the
 * value-position path above and nothing else: the statement path goes through `memberAssignment`
 *'s `accessorPlace`, which folds into a write statement rather than an expression. */
function accessorUpdateTarget(
  node: ts.Expression,
  checker: ts.TypeChecker,
  bindings: Scope,
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
): AccessorPlace | undefined {
  const property = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node)
      ? frontendTypes.elementStaticKey(node.argumentExpression, checker)
      : null;
  if (property === null || property === undefined) {
    return undefined;
  }
  const receiver = ts.isPropertyAccessExpression(node)
    ? node.expression
    : ts.isElementAccessExpression(node)
      ? node.expression
      : undefined;
  if (receiver === undefined) {
    return undefined;
  }
  const owner = accessorOwner(receiver, property, checker, bindings, sourceFile);
  if (owner === undefined) {
    return undefined;
  }
  const target = lowerExpression(receiver, sourceFile, checker, bindings, diagnostics);
  if (target === null || target.type.kind !== 'object') {
    return undefined;
  }
  const getSlot = target.type.methods.findIndex((m) => m.name === accessorName('get', property));
  const setSlot = target.type.methods.findIndex((m) => m.name === accessorName('set', property));
  if (getSlot < 0 && setSlot < 0) {
    return undefined;
  }
  const hasGet = hasAccessorHalf(receiver, property, 'get', checker, bindings, sourceFile);
  return {
    kind: 'accessor-place',
    type: typeAt(node, checker, bindings),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    target,
    owner,
    property,
    getSlot,
    setSlot,
    dispatch: isOverridden(target.type.name, accessorName('get', property), checker)
      ? 'virtual'
      : 'direct',
    hasGet,
  };
}

function lowerForIn(
  node: ts.ForInStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  label?: string,
): Statement | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const source = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
  if (source === null) {
    return null;
  }
  const keysName = nextBindTemp();
  const indexName = nextBindTemp();
  const keysType = hArray(H_STRING);
  // The binding and the loop's own temporaries belong to the loop, not to the list it sits in --
  // and the walk in `lowerFor`'s comment applies here for the same measured reason.
  const inner = bindings.child();
  inner.set(keysName, keysType);
  inner.set(indexName, H_NUMBER);
  let binding: string;
  let hirBinding: string;
  let declKind: 'let' | 'const' = 'let';
  if (ts.isVariableDeclarationList(node.initializer)) {
    const decl = node.initializer.declarations[0];
    if (decl === undefined || !ts.isIdentifier(decl.name)) {
      diagnostics.push(
        lowerDiagnostic(
          node.initializer,
          sourceFile,
          'STA4031',
          'internal',
          'for-in binding must be a name',
        ),
      );
      return null;
    }
    binding = decl.name.text;
    declKind = (node.initializer.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'let';
    hirBinding = inner.declare(binding, H_STRING);
    hirNameOfDeclaration.set(decl, hirBinding);
  } else if (ts.isIdentifier(node.initializer)) {
    // `for (x in o)` assigns an existing binding; the HIR still writes through a declaration, and
    // it must write to the name that binding actually has.
    binding = node.initializer.text;
    hirBinding = inner.hirName(binding);
  } else {
    diagnostics.push(
      lowerDiagnostic(
        node.initializer,
        sourceFile,
        'STA4031',
        'internal',
        'for-in binding must be a name',
      ),
    );
    return null;
  }
  const body = lowerBody(node.statement, sourceFile, checker, inner, diagnostics);
  if (body === null) {
    return null;
  }
  const keysId: Identifier = { kind: 'identifier', type: keysType, span, name: keysName };
  const indexId: Identifier = { kind: 'identifier', type: H_NUMBER, span, name: indexName };
  const keysDecl: Statement = {
    kind: 'declaration',
    type: keysType,
    span,
    name: keysName,
    declKind: 'const',
    // The for-in entry, not `Object.keys`: total over every primitive (empty list where the
    // namespace call panics), so a suppressed 2407 can never surface as a runtime abort
    // (plan.md §8 step 38).
    value: { kind: 'object-static', type: keysType, span, method: 'forInKeys', args: [source] },
  };
  const indexDecl: Statement = {
    kind: 'declaration',
    type: H_NUMBER,
    span,
    name: indexName,
    declKind: 'let',
    value: { kind: 'number-literal', type: H_NUMBER, span, value: 0 },
  };
  const length: Expression = { kind: 'array-length', type: H_NUMBER, span, operand: keysId };
  const cond: Expression = {
    kind: 'binary-op',
    type: H_BOOLEAN,
    span,
    operator: '<',
    left: indexId,
    right: length,
  };
  const inc: Statement = {
    kind: 'assignment',
    type: H_NUMBER,
    span,
    target: indexName,
    value: {
      kind: 'binary-op',
      type: H_NUMBER,
      span,
      operator: '+',
      left: indexId,
      right: { kind: 'number-literal', type: H_NUMBER, span, value: 1 },
    },
  };
  const keyRead: Expression = {
    kind: 'index-access',
    type: H_STRING,
    span,
    target: keysId,
    index: indexId,
  };
  const bindStmt: Statement = {
    kind: 'declaration',
    type: H_STRING,
    span,
    name: hirBinding,
    declKind,
    value: keyRead,
  };
  const loopBody: Block = {
    kind: 'block',
    type: H_UNDEFINED,
    span,
    statements: [bindStmt, ...body.statements],
  };
  const loop: Statement = {
    kind: 'for-statement',
    type: H_UNDEFINED,
    span,
    init: indexDecl,
    condition: cond,
    update: inc,
    body: loopBody,
    ...(label !== undefined && { label }),
    ...(loopNeedsPerIterationEnv(node, checker) && { perIterationEnv: true as const }),
  };
  return { kind: 'block', type: H_UNDEFINED, span, statements: [keysDecl, loop] };
}

/** The body of an `if`, loop, or labelled statement, as a Block.
 *
 * A body is a Block in the HIR whether or not it was one in the source, because `while (c) x++;`
 * and `while (c) { x++; }` differ only in punctuation. Wrapping here rather than at each call site
 * keeps that fact in one place — it was previously spelled out four times, and each new loop
 * would have spelled it again. */
function lowerBody(
  node: ts.Statement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Block | null {
  if (ts.isBlock(node)) {
    return lowerBlock(node, sourceFile, checker, bindings.child(), diagnostics);
  }
  const single = lowerStatement(node, sourceFile, checker, bindings, diagnostics);
  if (!single) {
    return null;
  }
  return {
    kind: 'block',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    statements: [single],
  };
}

/** Lower a block's statement list in a scope the CALLER owns.
 *
 * A block is a scope, and the scope object is a parameter rather than something created here for
 * one reason: a function body is hoisted twice by design -- once so `var`s can see the function
 * declarations they share a name with, once by this function -- and two hoists must land in the
 * SAME scope, where the second is a re-declaration that keeps its home. Creating a child here made
 * the second hoist a shadow of the first, which renamed every hoisted function in every function
 * body (`\u0000shadow:g#1` for a plain `function g(){}`) and cost it the name it prints.
 *
 * Every scope a caller opens is a `bindings.child()` -- a block, a loop body, a clause list, a
 * catch clause, a function body -- so a name still stops resolving where its scope ends
 * (plan-notes 215) and a shadow still gets a slot of its own (plan-notes 216). */
function lowerBlock(
  node: ts.Block,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  scope: Scope,
  diagnostics: Diagnostic[],
): Block | null {
  hoistFunctionDeclarations(node.statements, checker, scope);
  const statements: Statement[] = [];
  for (const child of node.statements) {
    const stmt = lowerStatement(child, sourceFile, checker, scope, diagnostics);
    if (stmt === null) {
      return null;
    }
    statements.push(stmt);
  }

  const block: Block = {
    kind: 'block',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    statements,
  };
  return block;
}

/** `receiver.concat(other)` as an HIR node — the lowering for array-literal spread, marked so
 * the holes it copies read as `undefined`. */
function arrayConcatExpr(target: Expression, other: Expression, span: Span): Expression {
  const shape = ARRAY_OPS.concat;
  const type: HType = shape.result === 'self' ? target.type : hUnknown(false);
  return { kind: 'array-op', type, span, op: 'concat', target, args: [other], spread: true };
}

function emptyArrayLiteral(type: HType, span: Span): ArrayLiteral {
  return { kind: 'array-literal', type, span, elements: [] };
}

/** One run of a spread list: literal elements, or a spread's operand. */
type SpreadSegment = { readonly elems: Expression[] } | { readonly spread: Expression };

/** A spread operand as the array the building concat spreads (plan.md §11c T11.4 step 5): an
 * array as it is, and anything else -- Unknown, a string, a Map, an iterator, a union of arrays --
 * through the `...` row, which drains it at run time and throws `X is not iterable` for a value
 * that is not (docs/VALUE.md §4.23). The concat alone would APPEND a non-array whole. */
function spreadOperand(operand: Expression, span: Span): Expression {
  return operand.type.kind === 'array'
    ? operand
    : globalCallNode('...', [operand], hArray(hUnknown(false)), span);
}

/** Fold literal runs and spread operands into nested `concat` calls: `[a, ...b, c]`, and a spread
 * call's argument list. The first piece is the receiver when it is a literal run or an array of
 * `listType`; any other operand rides as the argument of an empty literal of `listType` instead,
 * so the result keeps the list's own type. */
function foldSpreadList(
  segments: readonly SpreadSegment[],
  listType: HType,
  span: Span,
): Expression {
  const emptyType = listType.kind === 'array' ? listType : hArray(hUnknown(false));
  let result: Expression | null = null;
  for (const [index, segment] of segments.entries()) {
    if ('elems' in segment) {
      const run: Expression = {
        kind: 'array-literal',
        type: listType,
        span,
        elements: segment.elems,
      };
      result = result === null ? run : arrayConcatExpr(result, run, span);
      continue;
    }
    const piece = spreadOperand(segment.spread, span);
    if (result !== null) {
      result = arrayConcatExpr(result, piece, span);
    } else if (hTypeEquals(piece.type, emptyType)) {
      // A leading array of the list's own type is copied by the concat the NEXT piece builds;
      // alone, it copies here. One of another element type rides an empty literal instead, so
      // the concat chain (typed by its receiver) answers the list's type, never the operand's.
      result =
        index < segments.length - 1
          ? piece
          : arrayConcatExpr(piece, emptyArrayLiteral(emptyType, span), span);
    } else {
      result = arrayConcatExpr(emptyArrayLiteral(emptyType, span), piece, span);
    }
  }
  return result ?? emptyArrayLiteral(emptyType, span);
}

/** Fold `[a, ...b, c]` into nested `concat` calls over literal runs and spread operands. */
function lowerArrayLiteralExpression(
  node: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const literalType = arrayLiteralType(node, checker, bindings);
  const hasSpread = node.elements.some((element) => ts.isSpreadElement(element));
  if (!hasSpread) {
    const elements: Expression[] = [];
    for (const element of node.elements) {
      const lowered = lowerExpression(element, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      elements.push(lowered);
    }
    return { kind: 'array-literal', type: literalType, span, elements };
  }
  const segments = lowerSpreadSegments(node.elements, (element) =>
    lowerExpression(element, sourceFile, checker, bindings, diagnostics),
  );
  return segments === null ? null : foldSpreadList(segments, literalType, span);
}

/** A list with spreads, lowered left to right into its segments: each spread's operand on its
 * own, every other element through `lower`. `null` when an element pushed a diagnostic. */
function lowerSpreadSegments(
  elements: readonly ts.Expression[],
  lower: (element: ts.Expression) => Expression | null,
): SpreadSegment[] | null {
  const segments: Array<{ elems: Expression[] } | { spread: Expression }> = [];
  for (const element of elements) {
    const lowered = lower(ts.isSpreadElement(element) ? element.expression : element);
    if (lowered === null) {
      return null;
    }
    if (ts.isSpreadElement(element)) {
      segments.push({ spread: lowered });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last !== undefined && 'elems' in last) {
      last.elems.push(lowered);
    } else {
      segments.push({ elems: [lowered] });
    }
  }
  return segments;
}

/** The checker's type for an array literal -- except `[]`, which has no element to type it, so
 * the checker answers `never[]`, whose element is Unknown, and one Unknown makes the module and
 * every importer dynamic. The CONTEXT is the type the empty array will be read as
 * (`const out: string[] = []`, `[] as string[]`, `return []` under a `string[]` return), so an
 * array context is the literal's type. A context still naming a type parameter is a generic
 * callee's, not this scope's, and keeps the checker's answer (plan-notes 322). */
function arrayLiteralType(
  node: ts.ArrayLiteralExpression,
  checker: ts.TypeChecker,
  bindings: Scope,
): HType {
  return (
    emptyArrayContextType(node, checker, (type) =>
      substituteHType(type, (name) => bindings.get(typeParameterKey(name))),
    ) ?? typeAt(node, checker, bindings)
  );
}

/** The array type an empty `[]` takes from its context, or undefined when the context is not an
 * array this scope can name. The lowering (`arrayLiteralType`) and the step-45 return marks
 * (`effectiveValueType`) both ask, so a `return []` under `number[]` is the same array to both. */
function emptyArrayContextType(
  node: ts.ArrayLiteralExpression,
  checker: ts.TypeChecker,
  ground: (type: HType) => HType = (type) => type,
): HType | undefined {
  const contextual = node.elements.length === 0 ? checker.getContextualType(node) : undefined;
  if (contextual === undefined) {
    return undefined;
  }
  const type = ground(frontendTypes.tsTypeToHType(contextual, checker));
  return type.kind === 'array' && !hasTypeParam(type) ? type : undefined;
}

/** Whether `name` is the prototype-setter spelling: a non-computed `__proto__` written as an
 * identifier or a string literal (plan.md §8 step 33). A computed key -- even one whose
 * static name is `__proto__` -- is an own data property, as are shorthand, method and
 * accessor members under the name, so none of those answers true here. */
function isProtoSetterName(name: ts.PropertyName): boolean {
  return (
    !ts.isComputedPropertyName(name) &&
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === '__proto__'
  );
}

/** A link of an optional chain: `.x`, `[k]` or `(args)`, each optionally `?.`. `new` never
 * appears — `new a?.b()` is a grammar error — and a parenthesized chain is a closed value, so
 * the spine walk below stops at one. */
type ChainLink = ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression;

function isChainLink(node: ts.Node): node is ChainLink {
  return (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  );
}

/** The deepest `?.` on this link's `.expression` spine, or `undefined` for a chain-free link.
 * The node's OWN `?.` counts — the returned link is the one whose base is tested — and the walk
 * looks through `!` (which erases) but stops at parentheses (which end the chain: `(a?.b).c`
 * throws where `a?.b.c` answers `undefined`) and at every other node. Computed keys and call
 * arguments are never walked: they are independent roots, not links of this chain. */
function firstOptionalLink(node: ChainLink): ChainLink | undefined {
  let current: ts.Expression = node;
  for (;;) {
    if (isChainLink(current)) {
      if (current.questionDotToken !== undefined) {
        return current;
      }
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

function lowerOptionalChain(
  node: ChainLink,
  link: ChainLink,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  // The guarded base: everything from the first `?.`'s receiver down. Its spine holds no `?.`
  // (this IS the first), so it lowers through the plain arms exactly once — whatever side
  // effects it has run a single time, before the test.
  const prefix = link.expression;
  // A base that cannot be nullish makes the guard dead: lower plainly, which is today's code
  // exactly (and keeps non-nullable chains — `C?.x`, `s?.length` — on their current verdicts).
  // The type read is the checker's, not a lowering's, so nothing is evaluated and discarded.
  if (!hTypeCanBeNullish(typeAt(prefix, checker, bindings))) {
    return lowerExpression(node, sourceFile, checker, bindings, diagnostics, true);
  }
  const base = lowerExpression(prefix, sourceFile, checker, bindings, diagnostics);
  if (base === null) {
    return null;
  }
  // The consequent is the chain node lowered by the PLAIN arms — every link above the cut keeps
  // the lowering (and the runtime behavior, including which TypeErrors it throws) it would have
  // without the guard — with the cut bottoming out at the leaf instead of re-lowering the base.
  // A nested `?.` on the way down builds its own node testing its own base, which is why
  // `a?.b?.c` answers `undefined` for a nullish `a.b` while `a?.b.c` throws there. The leaf
  // carries the base's own type deliberately: the arms above dispatch on the checker's types
  // (which still see the union) and their nodes pin the target types they always did, so a
  // narrowed leaf would manufacture verifier failures for nodes the plain lowering builds
  // cleanly — while `.length` on an Unknown operand is layout-sound at run time either way.
  const previous = optionalChainCuts.get(prefix);
  optionalChainCuts.set(prefix, base.type);
  const consequent = lowerExpression(node, sourceFile, checker, bindings, diagnostics, true);
  if (previous === undefined) {
    optionalChainCuts.delete(prefix);
  } else {
    optionalChainCuts.set(prefix, previous);
  }
  if (consequent === null) {
    return null;
  }
  return {
    kind: 'optional-chain',
    type: typeAt(node, checker, bindings),
    span,
    base,
    consequent,
  };
}

/** ToPrimitive of a class instance, named statically (plan.md §9 Task 6.27): when the receiver's
 * class declares the method the hint tries FIRST (§7.1.1.1 OrdinaryToPrimitive -- `toString` for
 * a template hole or `String(x)`, `valueOf` for `+`), takes no parameter and answers a primitive,
 * the conversion IS that call, so it is lowered to the call and the hole sees its primitive.
 * Anything else -- no such method, an object answer the next rung would have to handle, an
 * interface or a literal's type a subclass cannot be traced through -- keeps the value, and the
 * runtime's ToPrimitive asks the object itself (docs/NUMERIC.md §7). The first rung cannot be
 * skipped by a subclass: an override dispatches virtually, and the hint never reaches the other
 * method while this one answers a primitive. */
function userConversion(
  node: ts.Expression,
  value: Expression,
  method: 'toString' | 'valueOf',
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
): Expression {
  const type = value.type;
  if (
    type.kind !== 'object' ||
    receiverClassLike(checker.getTypeAtLocation(node)) === undefined ||
    !isClassInstance(node, checker, bindings)
  ) {
    return value;
  }
  const slot = type.methods.findIndex((m) => m.name === method);
  const signature = type.methods[slot]?.type;
  if (
    signature?.kind !== 'fn' ||
    signature.params.length !== 0 ||
    (signature.ret.kind !== 'string' &&
      signature.ret.kind !== 'number' &&
      signature.ret.kind !== 'boolean')
  ) {
    return value;
  }
  const owner = declaringClassName(node, method, checker, bindings, sourceFile);
  if (owner === null) {
    return value;
  }
  const call: MethodCall = {
    kind: 'method-call',
    type: signature.ret,
    span: value.span,
    target: value,
    className: owner,
    method,
    slot,
    dispatch: isOverridden(type.name, method, checker) ? 'virtual' : 'direct',
    args: [],
  };
  return call;
}

/** `o.m(a)` on a class instance: the receiver is lowered, the method is named, not loaded.
 *
 * One function is shared by every instance, so naming its class here is what lets the emitter
 * make a direct call instead of loading a per-instance closure out of a slot. `undefined`
 * means the name is no method of the receiver -- the caller falls through to the ordinary
 * get-then-call path, exactly as the dot spelling does when the checker says the property
 * exists but the table holds no method under it.
 *
 * Shared by the dot spelling and the literal-typed element spelling (`o[k](a)` with
 * `k: "m"`), which the gate resolved to the same name. `privName` carries the `#private`
 * callee the dot spelling alone can write; `viaSuper` the `super.m()` receiver the element
 * spelling has no form of. */
function lowerClassMethodCall(
  obj: ts.Expression,
  propName: string,
  privName: ts.PrivateIdentifier | undefined,
  viaSuper: boolean,
  node: ts.CallExpression,
  at: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null | undefined {
  // `c.grown()`: a name the class never declared may have been grown onto this instance, so the
  // dot spelling falls through to the get-then-call the overflow table answers
  // (docs/VALUE.md §4.24), and to Node's TypeError when nothing was stored there.
  if (
    !viaSuper &&
    ts.isPropertyAccessExpression(at) &&
    frontendTypes.isUndeclaredMemberRead(at, checker)
  ) {
    return undefined;
  }
  // `super.m()` is a call on THIS receiver that skips the override -- the object is the same
  // one, only the function differs. So the target is the receiver parameter, not an
  // evaluation of `super`, which names no value at all.
  const target = viaSuper
    ? receiverIdentifier(obj, sourceFile, bindings, diagnostics)
    : lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
  if (target === null) {
    return null;
  }
  if (target.type.kind !== 'object') {
    diagnostics.push(
      lowerDiagnostic(at, sourceFile, 'STA4049', 'internal', 'receiver is not an object'),
    );
    return null;
  }
  const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics, node);
  if (args === null) {
    return null;
  }
  // The DECLARING class, not the receiver's -- `d.describe()` on a `Dog` names `Animal` when
  // `Animal` is where `describe` is written. Naming the receiver's class here would make the
  // emitter look for a method that class does not own. A `#private` method names its
  // LEXICAL owner instead: `o.#m` written in `A` runs `A`'s body even when `o` is a `B`,
  // and re-declaring never overrides, so the call is always direct.
  const callPriv = privName !== undefined && !viaSuper ? privateUse(privName, checker) : undefined;
  if (privName !== undefined && !viaSuper && callPriv === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4067',
        'internal',
        `private '${privName.text}' names no class the gate accepted`,
      ),
    );
    return null;
  }
  if (callPriv !== undefined) {
    const privateOwner = mangleClassName(callPriv.owner, obj, checker, bindings);
    const privateSlot = target.type.methods.findIndex((m) => m.name === callPriv.property);
    if (privateOwner === null || privateSlot < 0) {
      return missingMethodSlot(at, sourceFile, diagnostics, callPriv.property, target);
    }
    return methodCallAtSlot(
      node,
      sourceFile,
      checker,
      bindings,
      target,
      privateOwner,
      callPriv.property,
      privateSlot,
      'direct',
      args,
    );
  }
  const owner = declaringClassName(obj, propName, checker, bindings, sourceFile);
  if (owner !== null) {
    // The slot is resolved against the receiver's STATIC type and read from its DYNAMIC one,
    // which is sound for the same reason a field slot is: a subclass's method table begins
    // with its base's, in the base's order.
    const slot = target.type.methods.findIndex((m) => m.name === propName);
    if (slot < 0) {
      return missingMethodSlot(at, sourceFile, diagnostics, propName, target);
    }
    // Skipping the override is what `super` MEANS, so this one call stays direct even where
    // every other call to the same method is virtual.
    return methodCallAtSlot(
      node,
      sourceFile,
      checker,
      bindings,
      target,
      owner,
      propName,
      slot,
      !viaSuper && isOverridden(target.type.name, propName, checker) ? 'virtual' : 'direct',
      args,
    );
  }
  // A name the class does not declare at all is js mode's suppressed TS2339, not a method
  // the table lost: `c.missing()` answers Node's catchable `TypeError` (plan.md §8 step
  // 37), the call twin of the dynamic read the property arm builds. The receiver still
  // evaluates (it may run user code), then the arguments, then the throw — `nonFunctionCall`
  // with the receiver in the callee's seat. A name the checker SAYS exists falls through:
  // a present method the table lacks is the STA4067 disagreement below, not a suppression.
  if (checker.getPropertyOfType(checker.getTypeAtLocation(obj), propName) === undefined) {
    return nonFunctionCall(node, at, target, args, sourceFile);
  }
  return undefined;
}

/** A method on a nullable single-class receiver (`c?.m` with `c: C | null`).
 *
 * The HIR has no nullable object: `C | null` maps to Unknown, so the ordinary arms take the
 * dynamic path and aim a shape-table read at a layout whose methods live in no shape — answering
 * `undefined` where Node answers the closure (and aborting `STA2006` for the call twin). Inside
 * an optional chain the base is already guarded (a nullish base short-circuits before the
 * consequent runs), so the consequent may dispatch statically against the non-nullish class,
 * with the guarded base retyped to it for the verifier's receiver check (the emitter ignores
 * the leaf's type). Only methods: a field read already answers through the descriptor, so it
 * needs nothing here; an accessor, a second layout, an `any` constituent, a generic or a
 * shadowed declaration all return `undefined` and keep the existing arms. */
function nullableMethodInfo(
  receiver: ts.Expression,
  field: string,
  checker: ts.TypeChecker,
  bindings: Scope,
):
  | {
      readonly className: string;
      readonly slot: number;
      readonly dispatch: 'direct' | 'virtual';
      readonly objectType: HObject;
    }
  | undefined {
  const receiverType = checker.getTypeAtLocation(receiver);
  const live = receiverType.isUnion()
    ? receiverType.types.filter(
        (t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
      )
    : [receiverType];
  if (live.length === 0) {
    return undefined;
  }
  const declarations: ts.ClassDeclaration[] = [];
  for (const constituent of live) {
    // An `any`/`unknown` constituent means the value may be anything — static dispatch would be
    // unsound, so the dynamic path (and its refusal for calls) stands.
    if ((constituent.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return undefined;
    }
    const declaration = classDeclarationOf(constituent);
    if (declaration === undefined || declaration.name === undefined) {
      return undefined;
    }
    if (declaration.typeParameters !== undefined && declaration.typeParameters.length > 0) {
      return undefined;
    }
    if (!declarations.includes(declaration)) {
      declarations.push(declaration);
    }
  }
  if (declarations.length !== 1) {
    return undefined;
  }
  const declaration = declarations[0];
  if (declaration === undefined) {
    return undefined;
  }
  // A shadowed declaration is emitted under an HIR name the checker's type does not spell;
  // resolving the slot against the source-named type while naming the HIR class would fail the
  // verifier's ancestry check, so this declines and keeps the existing path. Merely registered
  // is not shadowed: `declare` returns the source name when nothing renames it.
  const hir = hirNameOf(declaration);
  if (hir !== undefined && hir !== declaration.name?.text) {
    return undefined;
  }
  const owner = frontendTypes.methodDeclaringClass(declaration, field, checker);
  if (owner === undefined) {
    return undefined;
  }
  const className = mangleClassName(owner, receiver, checker, bindings);
  if (className === null) {
    return undefined;
  }
  const [first] = live;
  if (first === undefined) {
    return undefined;
  }
  const objectType = frontendTypes.tsTypeToHType(first, checker);
  if (objectType.kind !== 'object') {
    return undefined;
  }
  const slot = objectType.methods.findIndex((m) => m.name === field);
  if (slot < 0) {
    return undefined;
  }
  return {
    className,
    slot,
    dispatch: isOverridden(objectType.name, field, checker) ? 'virtual' : 'direct',
    objectType,
  };
}

/** A method read as a value (`o.m`, `super.m`): the receiver's slot for `method` in `layout`,
 * bound to `target`. A method with no slot is the gate and the lowering disagreeing (STA4067). */
function methodValue(
  node: ts.Node,
  target: Expression,
  layout: HObject,
  method: string,
  className: string,
  context: {
    readonly virtual: boolean;
    readonly sourceFile: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly bindings: Scope;
    readonly diagnostics: Diagnostic[];
  },
): MethodValue | null {
  const { sourceFile, diagnostics } = context;
  const slot = layout.methods.findIndex((m) => m.name === method);
  if (slot < 0) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4067',
        'internal',
        `method '${method}' has no slot in the layout of ${hTypeName(layout)}`,
      ),
    );
    return null;
  }
  return {
    kind: 'method-value',
    type: typeAt(node, context.checker, context.bindings),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    target,
    className,
    method,
    slot,
    dispatch: context.virtual ? 'virtual' : 'direct',
  };
}

/** A member read on a class instance once the receiver is lowered.
 *
 * A method is its value (a `MethodValue` naming the declaring class, virtual where the family
 * overrides); an accessor read RUNS the getter; a field is a slot load. A miss the checker
 * also sees as absent is js mode's suppressed TS2339 and answers `undefined` through the
 * receiver's own descriptor, while a miss the checker says exists is a layout disagreement
 * (an internal error).
 *
 * Shared by the dot spelling (`o.x`) and the literal-typed element spelling (`o[k]` with
 * `k: "m"`), which the gate resolved to the same name -- so both answer the same way, and a
 * later change to one cannot silently diverge from the other. */
function lowerClassMemberRead(
  target: Expression,
  field: string,
  receiver: ts.Expression,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const member = namespaceObjectField(target, field, checker, bindings);
  if (member !== undefined) {
    return { kind: 'identifier', type: member.type, span, name: member.name };
  }
  // An accessor is not a slot: reading `o.x` RUNS the getter, which is what the property means.
  const methodOwner = declaringClassName(receiver, field, checker, bindings, sourceFile);
  if (methodOwner !== null) {
    if (target.type.kind !== 'object') {
      diagnostics.push(
        lowerDiagnostic(node, sourceFile, 'STA4049', 'internal', 'receiver is not an object'),
      );
      return null;
    }
    return methodValue(node, target, target.type, field, methodOwner, {
      virtual: isOverridden(target.type.name, field, checker),
      sourceFile,
      checker,
      bindings,
      diagnostics,
    });
  }
  const owner = accessorOwner(receiver, field, checker, bindings, sourceFile);
  if (owner !== undefined) {
    return accessorCall(
      'get',
      owner,
      target,
      field,
      [],
      typeAt(node, checker, bindings),
      makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      node,
      sourceFile,
      checker,
      diagnostics,
    );
  }
  // A miss the checker ALSO sees as absent is js mode's suppressed TS2339, not a layout
  // disagreement: `c.missing` on a class instance answers `undefined` in JavaScript
  // (plan.md §8 step 37). The dynamic read resolves through the receiver's OWN descriptor at
  // run time (`fixed_get` misses to `undefined`), so a subclass value's added field still
  // answers — a static `undefined` would lie about those. A receiver the edge widened to
  // Unknown takes the same path even when the checker still names a layout for it: `x.a.b`
  // where `x` holds dynamic has a fixed static type for `x.a` but a dynamic lowered value,
  // and a slot load off that value is garbage (step 45 nested). A miss the checker says EXISTS
  // keeps the STA4060 below: the checker proved the name is declared, so the layout lacking it
  // is a real lowering bug. In ts mode the checker stops the build before lowering, so the
  // dynamic branch never fires there.
  if (
    target.type.kind === 'unknown' ||
    ((target.type.kind === 'object' ? fieldSlot(target.type, field) : undefined) === undefined &&
      checker.getPropertyOfType(checker.getTypeAtLocation(receiver), field) === undefined)
  ) {
    return {
      kind: 'dyn-field-access',
      type: hUnknown(false),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      target,
      field,
    };
  }
  const slot = slotOf(target, field, node, sourceFile, diagnostics);
  if (slot === null) {
    return null;
  }
  const access: FieldAccess = {
    kind: 'field-access',
    type: typeAt(node, checker, bindings),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    target,
    field,
    slot,
  };
  return access;
}

/** A `.value` (or `["value"]`) read on an `Out<T>` slot (docs/FFI.md §2): the `T*` the
 * callee stored, read as the program sees it. The receiver's spelling decides the content
 * kind — a brand reads as opaque bits, a `CString` inner copies through `from_cstr` — so the
 * lowering stamps it from the type and no later stage re-derives it. A non-`Out` receiver
 * (including `s?.value`, whose `?.` is vacuous — a slot binding is never nullish) is not a
 * slot read at all: `undefined` sends the caller back to the ordinary access path. */
function lowerOutGet(
  receiver: ts.Expression,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): OutGet | null | undefined {
  const receiverType = checker.getTypeAtLocation(receiver);
  const inner = frontendTypes.outSlotInner(receiverType, checker);
  if (inner === undefined) {
    return undefined;
  }
  const operand = lowerExpression(receiver, sourceFile, checker, bindings, diagnostics);
  if (operand === null) {
    return null;
  }
  return {
    kind: 'out-get',
    type: hUnknown(false),
    span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
    operand,
    inner: frontendTypes.isBrandedPointer(inner, checker) ? 'pointer' : 'cstring',
  };
}

function lowerExpression(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  chainBypass = false,
): Expression | null {
  // An optional-chain cut: this node is the guarded base the enclosing chain holds in its frame
  // temp. Answer the leaf — re-lowering it here would evaluate the base a second time. Checked
  // before parentheses because a cut may itself be parenthesized (`(f())?.x`).
  const cut = optionalChainCuts.get(node);
  if (cut !== undefined) {
    return {
      kind: 'optional-base',
      type: cut,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    };
  }
  // Parentheses only expressed precedence, and the tree already encodes it. Unwrapping here
  // rather than modelling them is why the HIR has no grouping node -- and it must happen before
  // every other case, since a parenthesized anything can appear wherever an expression can.
  if (ts.isParenthesizedExpression(node)) {
    return lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
  }

  // `delete o.a` / `delete o[e]`. The gate already refused every operand that is not one of the
  // two access forms, and every receiver with a layout, so what arrives is a dynamic receiver and
  // a key. The `.a` form builds its own StringLiteral: the runtime takes one key expression, and
  // `o.a` is `o["a"]` with the quotes left out.
  if (ts.isDeleteExpression(node)) {
    let operand: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(operand)) {
      operand = operand.expression;
    }
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    if (!ts.isPropertyAccessExpression(operand) && !ts.isElementAccessExpression(operand)) {
      return null;
    }
    const target = lowerExpression(operand.expression, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    const key: Expression | null = ts.isPropertyAccessExpression(operand)
      ? {
          kind: 'string-literal',
          type: H_STRING,
          span: makeSpan(
            operand.name.getStart(sourceFile),
            operand.name.getWidth(sourceFile),
            sourceFile,
          ),
          value: operand.name.text,
        }
      : lowerExpression(operand.argumentExpression, sourceFile, checker, bindings, diagnostics);
    if (key === null) {
      return null;
    }
    return { kind: 'delete-prop', type: H_BOOLEAN, span, target, key };
  }

  if (ts.isVoidExpression(node)) {
    const operand = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (operand === null) {
      return null;
    }
    return {
      kind: 'unary-op',
      type: H_UNDEFINED,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      operator: 'void',
      operand,
    };
  }

  if (ts.isConditionalExpression(node)) {
    const condition = lowerExpression(node.condition, sourceFile, checker, bindings, diagnostics);
    const consequent = lowerExpression(node.whenTrue, sourceFile, checker, bindings, diagnostics);
    const alternate = lowerExpression(node.whenFalse, sourceFile, checker, bindings, diagnostics);
    if (condition === null || consequent === null || alternate === null) {
      return null;
    }
    return {
      kind: 'conditional',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      condition,
      consequent,
      alternate,
    };
  }

  const asUpdate = lowerUpdateExpression(node, sourceFile, checker, bindings, diagnostics);
  if (asUpdate !== undefined) {
    return asUpdate;
  }

  // Optional chaining `?.` (plan.md §8 step 24): any link whose spine passes through a `?.`
  // lowers as one guarded chain. Skipped under `chainBypass` — that is the consequent path,
  // which lowers the same node by the plain arms with the cut installed. An assignment to an
  // optional access (`a?.b = c`) never reaches here: the checker rejects it (TS2779) and the
  // build stops at the frontend.
  if (!chainBypass && isChainLink(node)) {
    const optionalLink = firstOptionalLink(node);
    if (optionalLink !== undefined) {
      return lowerOptionalChain(node, optionalLink, sourceFile, checker, bindings, diagnostics);
    }
  }

  // `-1` parses as a prefix minus applied to the literal 1, but it is one negative number to a
  // reader and to the emitted C. Folding it keeps the HIR free of a unary node it would otherwise
  // need for this single case; the gate accepts prefix minus ONLY on a numeric literal, so
  // anything else here is real negation and falls through to the unsupported-kind path.
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return {
      kind: 'number-literal',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value: -Number(node.operand.text),
    };
  }

  // Number literal
  if (ts.isNumericLiteral(node)) {
    const value = parseFloat(node.text);
    const type = typeAt(node, checker, bindings);
    return {
      kind: 'number-literal',
      type,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value,
    };
  }

  // String literal
  if (ts.isStringLiteral(node)) {
    const value = node.text;
    const type = typeAt(node, checker, bindings);
    return {
      kind: 'string-literal',
      type,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value,
    };
  }

  // `/ab+c/gi`. The AST hands the whole literal back as ONE token, so the split is here: the last
  // `/` ends the pattern (an inner one is escaped or inside a class, and neither can be the last
  // character -- the grammar requires the closing delimiter after it). Neither half is parsed; the
  // vendored engine is the only thing that reads them, which is what keeps them from disagreeing.
  if (ts.isRegularExpressionLiteral(node)) {
    const text = node.text;
    const end = text.lastIndexOf('/');
    return {
      kind: 'regexp-literal',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      source: text.slice(1, end),
      flags: text.slice(end + 1),
    };
  }

  // `` `no holes` `` carries no substitutions, so it IS a string literal -- distinguishing it
  // from one below the frontend would be preserving syntax, not meaning.
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      kind: 'string-literal',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value: node.text,
    };
  }

  // `` `a${x}b` `` -- head, then one (expression, literal) pair per span.
  if (ts.isTemplateExpression(node)) {
    const quasis: string[] = [node.head.text];
    const expressions: Expression[] = [];
    for (const span of node.templateSpans) {
      const value = lowerExpression(span.expression, sourceFile, checker, bindings, diagnostics);
      if (!value) {
        return null;
      }
      expressions.push(
        userConversion(span.expression, value, 'toString', sourceFile, checker, bindings),
      );
      quasis.push(span.literal.text);
    }
    const template: TemplateLiteral = {
      kind: 'template-literal',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      quasis,
      expressions,
    };
    return template;
  }

  // `ns.x` on a module namespace: the export's own binding, resolved here (plan.md §11c T11.5a).
  const namespaceMember = namespaceMemberRead(node, sourceFile, checker, bindings);
  if (namespaceMember !== undefined) {
    return namespaceMember;
  }

  // `C.count` on a class NAME. Tested before the instance case because the receiver's type answers
  // the same for both -- the type of the expression `C` is the class's static side, whose symbol is
  // still the class declaration. A static is one binding, so this is an ordinary identifier read --
  // unless the static IS an accessor, in which case reading it RUNS the getter.
  if (ts.isPropertyAccessExpression(node)) {
    // An out-slot read rides the ordinary member syntax (`s.value`, and the vacuous
    // `s?.value` — a slot binding is never nullish, so the check answers nothing): the
    // receiver's `Out` spelling, not the property machinery, decides what it means.
    if (node.name.text === 'value') {
      const read = lowerOutGet(node.expression, node, sourceFile, checker, bindings, diagnostics);
      if (read !== undefined) {
        return read;
      }
    }
    const found = frontendTypes.staticMemberOf(node, checker, undefined);
    if (found !== undefined && classDisplayName(found.owner) !== undefined) {
      if (ts.isGetAccessorDeclaration(found.member) || ts.isSetAccessorDeclaration(found.member)) {
        // A static accessor is not a binding: reading `C.value` RUNS the getter. A missing half
        // is the static twin of the instance hole (STA4067 there) -- the call below reports
        // which binding the class never emitted.
        return staticAccessorCall(
          'get',
          hirClassName(found.owner),
          node.name.text,
          [],
          typeAt(node, checker, bindings),
          makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
          node,
          sourceFile,
          bindings,
          diagnostics,
        );
      }
      const name = staticName(hirClassName(found.owner), node.name.text);
      const type = bindings.get(name);
      if (type === undefined) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4066',
            'internal',
            `static '${name}' read before its class declaration was lowered`,
          ),
        );
        return null;
      }
      return {
        kind: 'identifier',
        type,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        name,
      };
    }
  }

  // `Math.PI` and the other Math constants fold to number literals HERE: the compiler runs on
  // the pinned Node, so the double it holds is bit-for-bit the one the golden tests diff against,
  // and no runtime representation of Math has to exist.
  if (
    ts.isPropertyAccessExpression(node) &&
    isGlobalMath(node.expression, checker) &&
    MATH_CONSTANTS.has(node.name.text)
  ) {
    const constants: Record<string, number> = {
      E: Math.E,
      LN10: Math.LN10,
      LN2: Math.LN2,
      LOG10E: Math.LOG10E,
      LOG2E: Math.LOG2E,
      PI: Math.PI,
      SQRT1_2: Math.SQRT1_2,
      SQRT2: Math.SQRT2,
    };
    return {
      kind: 'number-literal',
      type: H_NUMBER,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value: constants[node.name.text] ?? Number.NaN,
    };
  }
  // `Number.MAX_VALUE` and the other Number constants fold the same way (plan-notes 310).
  const numberValue = ts.isPropertyAccessExpression(node)
    ? numberConstant(node, checker)
    : undefined;
  if (numberValue !== undefined) {
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    return { kind: 'number-literal', type: H_NUMBER, span, value: numberValue };
  }

  // `C.name` / `K.name` on a class NAME or alias folds to Node's display name (docs/VALUE.md
  // §4.26, T27 narrow slice): the declared name, a class expression's inner name, else the bound
  // variable, and `default` for the anonymous default export. No class object is built. The gate
  // admitted exactly this spelling; `C.prototype` and the rest of the surface stay refused there.
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'name') {
    const owner = classObjectOwner(node.expression, checker);
    const display = owner === undefined ? undefined : classDisplayName(owner);
    if (display !== undefined) {
      return {
        kind: 'string-literal',
        type: H_STRING,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        value: display === DEFAULT_EXPORT_BINDING ? 'default' : display,
      };
    }
  }

  // `c?.m` on a nullable single-class receiver: the static twin of the dynamic read below.
  // Without it the union maps to Unknown and the shape-table read misses (methods live in no
  // shape), answering `undefined` where Node answers the closure. Only this `?.` link: a plain
  // link above the cut must still throw on a nullish base, which the dynamic path does and a
  // static load would not. Only methods: fields already answer through the descriptor.
  if (
    ts.isPropertyAccessExpression(node) &&
    node.questionDotToken !== undefined &&
    !ts.isPrivateIdentifier(node.name) &&
    optionalChainCuts.has(node.expression)
  ) {
    const info = nullableMethodInfo(node.expression, node.name.text, checker, bindings);
    if (info !== undefined) {
      const raw = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (raw === null) {
        return null;
      }
      const target: Expression = {
        kind: 'optional-base',
        type: info.objectType,
        span: raw.span,
      };
      const value: MethodValue = {
        kind: 'method-value',
        type: typeAt(node, checker, bindings),
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        target,
        className: info.className,
        method: node.name.text,
        slot: info.slot,
        dispatch: info.dispatch,
      };
      return value;
    }
  }

  // `u.length`, `u.buffer`, `b.byteLength` and their siblings: the TYPED_OPS `get` rows. Keyed on
  // the BINDING's type, not the checker's, so a receiver widened to Unknown keeps the dynamic read
  // (which answers the same properties through `jsrt_typed_get_prop`). Ahead of the dynamic-shape
  // arm, because the lib interface's numeric index signature makes the checker's type look dynamic.
  if (ts.isPropertyAccessExpression(node)) {
    const receiverKind = typeAt(node.expression, checker, bindings).kind;
    const op =
      receiverKind === 'uint8array' || receiverKind === 'arraybuffer'
        ? typedMember(receiverKind, node.name.text)
        : undefined;
    if (op !== undefined && TYPED_OPS[op].form === 'get') {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (target === null) {
        return null;
      }
      return typedOpNode(
        op,
        target,
        [],
        makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      );
    }
  }

  // `o.x` on a DYNAMIC shape: no slot exists, so the read resolves the NAME through the shape
  // table with a per-site cache (docs/VALUE.md §4.10). The result is Unknown -- an absent optional
  // property reads as `undefined`, and narrowing it back is the caller's job, like a Map get.
  if (
    ts.isPropertyAccessExpression(node) &&
    !isMatchReceiver(node.expression, checker) &&
    (targetIsDynamic(node.expression, checker, bindings) ||
      frontendTypes.isFunctionValueMember(node.expression, node.name.text, checker) ||
      frontendTypes.isUndeclaredMemberRead(node, checker))
  ) {
    const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    return {
      kind: 'dyn-field-access',
      type: hUnknown(false),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      target,
      field: node.name.text,
    };
  }

  // `super.m` as a value: the base's method as an unbound closure -- the value twin of the
  // `super.m()` call `lowerClassMethodCall` builds. The target is the receiver parameter, not
  // an evaluation of `super`, which names no value at all; the owner is the class declaring
  // the method (an ancestor, never the receiver's own); the dispatch is always direct,
  // because skipping the override is what `super` means. A bare call drops the receiver per
  // `has_receiver` (docs/VALUE.md §4.16), exactly as `const g = o.m; g()` does. The gate
  // admitted only identifier-named methods with an instance receiver in scope, so anything
  // else reaching here is the gate and the lowering disagreeing.
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const target = receiverIdentifier(node.expression, sourceFile, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    if (target.type.kind !== 'object') {
      diagnostics.push(
        lowerDiagnostic(node, sourceFile, 'STA4049', 'internal', 'receiver is not an object'),
      );
      return null;
    }
    if (ts.isPrivateIdentifier(node.name)) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4067',
          'internal',
          `private '${node.name.text}' has no method value the lowering can reach`,
        ),
      );
      return null;
    }
    const field = node.name.text;
    const owner = declaringClassName(node.expression, field, checker, bindings, sourceFile);
    if (owner === null) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4067',
          'internal',
          `method '${field}' names no class the lowering can reach`,
        ),
      );
      return null;
    }
    return methodValue(node, target, target.type, field, owner, {
      virtual: false,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    });
  }

  // `o.x` on a class instance. This is tested BEFORE `.length` because a class may declare a field
  // called `length`, and that field is a slot -- the array and string intrinsics of the same name
  // belong to those types, not to every object that borrows the word.
  if (ts.isPropertyAccessExpression(node) && isClassInstance(node.expression, checker, bindings)) {
    const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    // An instance `#private` use resolves LEXICALLY -- the slot belongs to the class whose body
    // spells it, not to the receiver's most-derived declaration -- so it takes its own path with
    // the mangled name, and never the receiver-based method/accessor/slot lookups below.
    if (ts.isPrivateIdentifier(node.name)) {
      const priv = privateUse(node.name, checker);
      if (priv === undefined) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4060',
            'internal',
            `no private '${node.name.text}' the gate accepted`,
          ),
        );
        return null;
      }
      return lowerPrivateRead(priv, node, target, sourceFile, checker, bindings, diagnostics);
    }
    const field = node.name.text;
    return lowerClassMemberRead(
      target,
      field,
      node.expression,
      node,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
  }

  // `m.size` -- a count the structure keeps, so a read rather than a walk, and the reason it is a
  // `CollectionOp` with no arguments instead of a node of its own.
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'size') {
    const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    if (target.type.kind === 'map' || target.type.kind === 'set') {
      const size: CollectionOp = {
        kind: 'collection-op',
        type: H_NUMBER,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        collection: target.type.kind,
        op: 'size',
        target,
        args: [],
      };
      return size;
    }
  }

  // `m.index`, `m.input`, `m.groups`, `m.length` -- the match array's own surface. It sits ahead of
  // the `.length` arm below because a match's `.length` is an ARRAY length read through a receiver
  // the HIR types Unknown, which that arm's array check would refuse.
  if (ts.isPropertyAccessExpression(node) && isMatchReceiver(node.expression, checker)) {
    const field = node.name.text;
    if (Object.hasOwn(MATCH_FIELDS, field)) {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (target === null) {
        return null;
      }
      const result = MATCH_FIELDS[field as MatchField];
      return {
        kind: 'match-read',
        type: result === 'number' ? H_NUMBER : result === 'string' ? H_STRING : hUnknown(false),
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        field: field as MatchField,
        target,
      };
    }
  }

  // `re.source`, `re.global` and their nine siblings. Ahead of the `.length` arm for no reason of
  // its own -- a regexp has no `.length` -- but beside the match read it mirrors.
  if (ts.isPropertyAccessExpression(node) && isRegExpReceiver(node.expression, checker)) {
    const field = node.name.text;
    if (Object.hasOwn(REGEXP_FIELDS, field)) {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (target === null) {
        return null;
      }
      const result = REGEXP_FIELDS[field as RegExpField].result;
      return {
        kind: 'regexp-read',
        type: result === 'number' ? H_NUMBER : result === 'string' ? H_STRING : H_BOOLEAN,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        field: field as RegExpField,
        target,
      };
    }
  }

  // `s.length` and `a.length`. The gate already confirmed the object is a string or an array; a
  // property access that is neither never reaches here, and `console.log` is the call case. The
  // two produce different nodes because they become different runtime calls, and this is the last
  // point at which the operand's type is known.
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'length') {
    const operand = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!operand) {
      return null;
    }
    return lengthRead(
      operand,
      makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    );
  }

  if (ts.isArrayLiteralExpression(node)) {
    return lowerArrayLiteralExpression(node, sourceFile, checker, bindings, diagnostics);
  }

  if (ts.isElementAccessExpression(node)) {
    // The bracket spelling of the same read (`s["value"]`, including literal-typed keys):
    // anything else keeps the index path below.
    if (frontendTypes.elementStaticKey(node.argumentExpression, checker) === 'value') {
      const read = lowerOutGet(node.expression, node, sourceFile, checker, bindings, diagnostics);
      if (read !== undefined) {
        return read;
      }
    }
    // `c[Symbol.iterator]` on a known user-iterable class is `c.m` written the only way the
    // well-known symbol can be spelled: the method's value, resolved statically to
    // `__@iterator` exactly as the dot spelling resolves a name. Anything the gate let through
    // but this declines (no object target, no iterator method) falls through to the index path,
    // which reports the disagreement rather than miscompiling it.
    if (frontendTypes.isSymbolIteratorKey(node.argumentExpression, checker)) {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (target === null) {
        return null;
      }
      if (
        target.type.kind === 'object' &&
        frontendTypes.userIteratorMethod(target.type) !== undefined
      ) {
        return lowerClassMemberRead(
          target,
          frontendTypes.ITERATOR_METHOD_NAME,
          node.expression,
          node,
          sourceFile,
          checker,
          bindings,
          diagnostics,
        );
      }
    }
    // `o["a-b"]` on a fixed shape is `o.a` written the only way TypeScript allows a key that is not
    // an identifier to be spelled. A literal-typed key (`o[k]` with `k: "m"`) is the same name by
    // the step-22 rule, so both spellings share the member-read path below -- a method is its
    // value, an accessor runs its getter, a field is a slot load -- and not an index at all.
    // Without it, `{ "a-b": 1 }` would be a literal nothing could read back (plan.md §8 step 12
    // family c), and a computed accessor read would miss the slot it never had (STA4060).
    const literalKey = frontendTypes.elementStaticKey(node.argumentExpression, checker);
    if (literalKey !== null) {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      if (target === null) {
        return null;
      }
      if (target.type.kind === 'object') {
        return lowerClassMemberRead(
          target,
          literalKey,
          node.expression,
          node,
          sourceFile,
          checker,
          bindings,
          diagnostics,
        );
      }
    }
    return lowerIndexAccess(node, sourceFile, checker, bindings, diagnostics);
  }

  // Boolean literal (true/false)
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    const value = node.kind === ts.SyntaxKind.TrueKeyword;
    const type = typeAt(node, checker, bindings);
    return {
      kind: 'boolean-literal',
      type,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value,
    };
  }

  // `this` is a read of the receiver parameter, and nothing more: the gate admits it only
  // where the lowering binds one — a class member, an object literal method/accessor, or a plain
  // function that reads it (whose parameter zero is the dynamic receiver) — and every such
  // parameter list starts with that parameter. There is no `this` node in the HIR because there
  // is nothing left for one to mean.
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return receiverIdentifier(node, sourceFile, bindings, diagnostics);
  }

  // `{ x: 1 }`. The gate proved every key is an identifier and that the type is a shape, so the
  // entries are the slots -- in the order written, which is the order the shape lists them and the
  // order `console.log` prints them.
  if (ts.isObjectLiteralExpression(node)) {
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    const entries: DynEntry[] = [];
    // Methods wait with the entry count at their written position: the fixed path lowers them
    // into the method table, while the dynamic path splices their closures back into `entries`
    // at exactly these positions, which is what keeps the insertion order. `order` is the
    // property index, which the fixed path needs to resolve an own method against a spread
    // copy of the same name: the last writer in source order wins (see the assembly below).
    const methodNodes: { at: number; order: number; node: ts.MethodDeclaration }[] = [];
    // One record per spread fragment, in property order: which methods it contributes, whether
    // it pushed any field entry, and whether its source is a bare identifier. The fixed path
    // resolves each method name to its last writer; a losing copy is dropped, unless dropping
    // it would drop its source's only evaluation (a methods-only source that is not an
    // identifier runs nowhere else). `fields` is the source's field list, for the prefix check
    // below: a copied method body reads `this` through the source's slots.
    const spreadFragments: {
      order: number;
      pushedFields: boolean;
      targetIsIdentifier: boolean;
      methods: readonly string[];
      fields: readonly HField[];
    }[] = [];
    // Methods a `{ ...src }` expansion copied (see `MethodCopy`): one bound-closure read per
    // method of a literal-shaped source, stored at the fragment's own `at` like the field
    // reads are, so evaluation order is source order however the emitter walks them.
    const methodCopies: { at: number; order: number; name: string; value: MethodValue }[] = [];
    // `{ ...a }` over an array or an untyped value, in property order: the entry count before the
    // fragment (runs of own entries split here), the fragment's own property index (runs bucket
    // the methods they enclose by it), the lowered source, and the spread's span (the fold's
    // `assign` sites).
    // The gate accepted the array kind, and an Unknown operand of a dynamic literal, on this arm,
    // so every record here folds through `assign` below; any other non-object source still
    // reports on its own arm.
    const foldedSpreads: { at: number; order: number; source: Expression; span: Span }[] = [];
    for (const [propIndex, property] of node.properties.entries()) {
      // `{ x }` is `{ x: x }`. The desugaring lives here and not in HIR: the value is the ordinary
      // identifier expression, so every later pass sees a name/value pair like any other.
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = lowerExpression(property.name, sourceFile, checker, bindings, diagnostics);
        if (value === null) {
          return null;
        }
        entries.push({ name: property.name.text, value });
        continue;
      }
      // `{ ...a }` expands to one read per field of `a`'s shape, plus one bound-closure
      // read per method when `a`'s shape is an object literal's. The gate held the operand to
      // a fixed shape, so both the key set and each slot are known now (plan.md §8 step 12
      // family c). The N reads share one source subtree; the emitter evaluates a shared
      // non-trivial source once into a scratch slot (codegen `spreadScratches`), so this sharing
      // is a single evaluation, not N. A later key of the same name overwrites this entry,
      // which is the `{ ...a, x: 1 }` rule -- the emitter stores in source order into one slot,
      // so the last write wins on its own. `#private` fields are skipped: they are not own
      // properties, so spreading never copies them. A method on a CLASS instance rides the
      // prototype for the same reason and is never copied either -- only a method on a
      // literal IS own (the shape name starts with `{`), and the copy below is what carries
      // it: a `method-value` read stamped with the spread's span, so it joins the fragment's
      // single evaluation and lands in the result's hidden slot with the source's bound
      // closure -- the construction-site environment with the call-site receiver, exactly as
      // Node copies the function object and calls it against the copy (plan.md §8 step 12c
      // S-C). An accessor can never ride this path: one forces its whole shape dynamic, so
      // a fixed-shape source carries plain methods only -- spreading a value WITH an
      // accessor stays refused at the gate (`no fixed shape`), which is step 39's dynamic
      // spread to land, not this slice's.
      if (ts.isSpreadAssignment(property)) {
        const source = lowerExpression(
          property.expression,
          sourceFile,
          checker,
          bindings,
          diagnostics,
        );
        if (source === null) {
          return null;
        }
        const spreadSpan = makeSpan(
          property.getStart(sourceFile),
          property.getWidth(sourceFile),
          sourceFile,
        );
        // An array has no static key set to expand -- its indices are a run-time count -- so
        // the fragment is recorded for the assign fold below rather than expanded here. Own
        // entries around it stay in `entries` (and enclosing methods in `methodNodes`); the
        // fold splits both at each fragment's `at` and combines the runs left to right.
        if (source.type.kind === 'array') {
          foldedSpreads.push({ at: entries.length, order: propIndex, source, span: spreadSpan });
          continue;
        }
        // A value the checker promised a shape for but the lowering typed dynamic — a call to
        // a step-45-marked function (its declared return is the contract, not the value).
        // Expanding slots off it would be silent garbage; the shape-table enumeration a
        // dynamic spread needs is the unknown-spread owner's, so this names it exactly as the
        // gate names the checker-unknown twin (an honest not-yet, never an internal error).
        // A non-object operand of a dynamic literal folds like an array: the gate accepted an
        // operand the CHECKER types Unknown there (plan-notes 297), and `assign` copies whatever
        // keys the run-time value holds. The lowered type may be narrower than Unknown -- a
        // `never`-narrowed operand lowers at its binding's static type -- and says nothing about
        // that value, so any non-object kind takes the fold.
        if (source.type.kind !== 'object' && frontendTypes.objectLiteralIsDynamic(node, checker)) {
          foldedSpreads.push({ at: entries.length, order: propIndex, source, span: spreadSpan });
          continue;
        }
        if (source.type.kind === 'unknown') {
          diagnostics.push(
            lowerDiagnostic(
              property,
              sourceFile,
              'STA1214',
              'not-yet',
              'an object spread of an unknown value is not yet supported',
            ),
          );
          return null;
        }
        if (source.type.kind !== 'object') {
          diagnostics.push(
            lowerDiagnostic(
              property,
              sourceFile,
              'STA4068',
              'internal',
              'object spread of a value with no shape',
            ),
          );
          return null;
        }
        // Every read below is stamped with the spread's own span, not the operand's: the span is
        // the identity the emitter groups by, and the operand's span belongs to an expression
        // that now evaluates once no matter how many fields read it. Each entry is also marked
        // `spread`: the expansion order is the TYPE's field order, while the result must
        // enumerate in the SOURCE OBJECT's key order, so the emitter repairs the order at run
        // time -- and only a mark tells these reads apart from an own value that happens to
        // read the same shape (plan.md §8 step 21a).
        const fieldsBefore = entries.length;
        source.type.fields.forEach((field, slot) => {
          if (field.name.startsWith('#')) {
            return;
          }
          const read: FieldAccess = {
            kind: 'field-access',
            type: field.type,
            span: spreadSpan,
            target: source,
            field: field.name,
            slot,
          };
          entries.push({ name: field.name, value: read, spread: true });
        });
        // A method on a literal-shaped source is an own enumerable property, so the spread
        // copies it as data: the source's bound closure, read out of its hidden slot. A
        // method on a class instance is skipped -- it lives on the prototype and spreading
        // must not copy it, which the field-only expansion above already gets right.
        // Hoisted for the closure below: narrowing on `source.type` does not survive into it.
        const sourceName = source.type.name;
        const copiedMethods: string[] = sourceName.startsWith('{')
          ? source.type.methods.map((method, slot) => {
              const read: MethodValue = {
                kind: 'method-value',
                type: method.type,
                span: spreadSpan,
                target: source,
                className: sourceName,
                method: method.name,
                slot,
                dispatch: isOverridden(sourceName, method.name, checker) ? 'virtual' : 'direct',
              };
              methodCopies.push({
                at: fieldsBefore,
                order: propIndex,
                name: method.name,
                value: read,
              });
              return method.name;
            })
          : [];
        spreadFragments.push({
          order: propIndex,
          pushedFields: entries.length > fieldsBefore,
          targetIsIdentifier: source.kind === 'identifier',
          methods: copiedMethods,
          fields: source.type.fields,
        });
        continue;
      }
      // `get x() {…}` / `set x(v) {…}`. Both halves of one key become ONE entry, so a literal that
      // writes get and set adjacently -- the only spelling TypeScript allows -- inserts the key
      // once and in the position the first half was written (docs/VALUE.md §4.15). The body is an
      // ordinary function with the receiver as parameter zero; the receiver is Unknown because the
      // gate made this literal dynamic, so `this.x` inside is a shape-table read.
      if (ts.isMethodDeclaration(property)) {
        if (!(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          diagnostics.push(
            lowerDiagnostic(
              property,
              sourceFile,
              'STA4068',
              'internal',
              'object literal method with a key that is not a name',
            ),
          );
          return null;
        }
        methodNodes.push({ at: entries.length, order: propIndex, node: property });
        continue;
      }
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        // A statically-known computed name resolves like a value key (`get ["x"]`, `get [k]`
        // with `k: "x"`); a runtime one never reaches here, refused at the gate.
        const accessorKey =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : ts.isComputedPropertyName(property.name)
              ? frontendTypes.computedKeyStaticName(property.name, checker)
              : null;
        if (accessorKey === null) {
          diagnostics.push(
            lowerDiagnostic(
              property,
              sourceFile,
              'STA4068',
              'internal',
              'object literal accessor with a key that is not a name',
            ),
          );
          return null;
        }
        const fn = lowerFunction(
          property,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          hUnknown(false),
        );
        if (fn === null) {
          return null;
        }
        const name = accessorKey;
        const half = ts.isGetAccessorDeclaration(property) ? 'get' : 'set';
        const existing = entries.find((e) => isAccessorEntry(e) && e.name === name);
        if (existing !== undefined && isAccessorEntry(existing)) {
          entries[entries.indexOf(existing)] =
            half === 'get' ? { ...existing, get: fn } : { ...existing, set: fn };
          continue;
        }
        entries.push(
          half === 'get' ? { name, get: fn, set: undefined } : { name, get: undefined, set: fn },
        );
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        diagnostics.push(
          lowerDiagnostic(
            property,
            sourceFile,
            'STA4068',
            'internal',
            'object literal member is not a name/value pair',
          ),
        );
        return null;
      }
      const value = lowerExpression(
        property.initializer,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      if (value === null) {
        return null;
      }
      const staticKey = frontendTypes.staticPropertyName(property.name, checker);
      if (staticKey !== null) {
        // `{ __proto__: v }` (and the quoted spelling) is the prototype setter, not an own
        // data property (plan.md §8 step 33): the entry keeps its written position so the
        // value still evaluates in order, and the dynamic emitter stores nothing for it. A
        // computed key -- even `["__proto__"]` -- stays an own data property and is unmarked.
        if (isProtoSetterName(property.name)) {
          entries.push({ name: staticKey, value, protoSetter: true });
        } else {
          entries.push({ name: staticKey, value });
        }
        continue;
      }
      if (!ts.isComputedPropertyName(property.name)) {
        diagnostics.push(
          lowerDiagnostic(
            property,
            sourceFile,
            'STA4068',
            'internal',
            'object literal member is not a name/value pair',
          ),
        );
        return null;
      }
      const key = lowerExpression(
        property.name.expression,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      if (key === null) {
        return null;
      }
      entries.push({ key, value });
    }
    // The CONTEXTUAL type decides fixed-versus-dynamic, and it must be asked FIRST: in
    // `const o: { x?: number } = { x: 1 }` the literal's own type is a layout, but every later
    // read of `o` goes through the annotation -- so the object must be the dynamic one those
    // reads resolve against (same reasoning, same order, as gateObjectLiteral).
    // One dynamic run: `runEntries` with the run's own methods spliced at their written
    // positions (`at` values are run-local: the fold rebases each run's methods when it splits
    // them out of `methodNodes`). Shared by the spread-free literal below and every run of the
    // array-spread fold: the same entries mean the same object whichever path assembles them.
    const assembleDynRun = (
      runEntries: DynEntry[],
      runMethods: { at: number; order: number; node: ts.MethodDeclaration }[],
    ): DynObjectLiteral | null => {
      const ordered: DynEntry[] = [];
      let cursor = 0;
      for (const { at, node: methodNode } of runMethods) {
        for (; cursor < at; cursor++) {
          const entry = runEntries[cursor];
          if (entry === undefined) {
            diagnostics.push(
              lowerDiagnostic(
                node,
                sourceFile,
                'STA4068',
                'internal',
                'object literal method position is past its entries',
              ),
            );
            return null;
          }
          ordered.push(entry);
        }
        const fn = lowerFunction(
          methodNode,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          hUnknown(false),
        );
        if (fn === null) {
          return null;
        }
        ordered.push({ name: memberFunctionName(methodNode, sourceFile, checker), value: fn });
      }
      for (; cursor < runEntries.length; cursor++) {
        const entry = runEntries[cursor];
        if (entry === undefined) {
          diagnostics.push(
            lowerDiagnostic(
              node,
              sourceFile,
              'STA4068',
              'internal',
              'object literal method position is past its entries',
            ),
          );
          return null;
        }
        ordered.push(entry);
      }
      return { kind: 'dyn-object-literal', type: hUnknown(false), span, entries: ordered };
    };
    // An array spread anywhere in the literal forces the dynamic fold: indices are a run-time
    // count no static expansion can name. Runs of own entries around the array fragments
    // assemble as dynamic literals above -- methods, accessors, computed keys and proto-setters
    // keep their meaning, and a fixed-object spread inside a run keeps its whole-fragment copy
    // through `jsrt_dynobj_spread` -- and the runs combine left to right with `assign`, which
    // copies each array fragment's indices out of its elements and its named extras through
    // the shape table. Later keys overwrite in place, which is the `{ ...a, x: 1 }` rule the
    // single-literal store order already gives. Each `assign` answers Unknown, so the whole
    // fold is Unknown: the honest type of a key set nothing lists.
    //
    // Only a dynamic literal may reach the fold: the gate accepted this spread exactly when
    // `objectLiteralIsDynamic` holds, which is what binds Unknown alongside the Unknown value.
    // A fixed path here would promise slots the value never builds, so reaching one is the
    // gate and the lowering disagreeing about the layout -- a compiler bug, not a program error.
    if (foldedSpreads.length > 0 && !frontendTypes.objectLiteralIsDynamic(node, checker)) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4068',
          'internal',
          'object literal with a folded spread took the fixed-shape path',
        ),
      );
      return null;
    }
    if (foldedSpreads.length > 0) {
      const assignNode = (target: Expression, source: Expression, at: Span): Expression => ({
        kind: 'object-static',
        type: hUnknown(false),
        span: at,
        method: 'assign',
        args: [target, source],
      });
      let folded: Expression | null = null;
      const foldRun = (run: DynObjectLiteral): void => {
        folded = folded === null ? run : assignNode(folded, run, run.span);
      };
      const foldArray = (source: Expression, at: Span): void => {
        if (folded === null) {
          folded = { kind: 'dyn-object-literal', type: hUnknown(false), span, entries: [] };
        }
        folded = assignNode(folded, source, at);
      };
      let runStart = 0;
      let runStartOrder = -1;
      for (const fragment of foldedSpreads) {
        const runEntries = entries.slice(runStart, fragment.at);
        const runMethods = methodNodes
          .filter((method) => method.order > runStartOrder && method.order < fragment.order)
          .map((method) => ({ ...method, at: method.at - runStart }));
        runStart = fragment.at;
        runStartOrder = fragment.order;
        if (runEntries.length > 0 || runMethods.length > 0) {
          const run = assembleDynRun(runEntries, runMethods);
          if (run === null) {
            return null;
          }
          foldRun(run);
        }
        foldArray(fragment.source, fragment.span);
      }
      const tailEntries = entries.slice(runStart);
      const tailMethods = methodNodes
        .filter((method) => method.order > runStartOrder)
        .map((method) => ({ ...method, at: method.at - runStart }));
      if (tailEntries.length > 0 || tailMethods.length > 0) {
        const tail = assembleDynRun(tailEntries, tailMethods);
        if (tail === null) {
          return null;
        }
        foldRun(tail);
      }
      if (folded === null) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4068',
            'internal',
            'object literal with a folded spread folded to nothing',
          ),
        );
        return null;
      }
      return folded;
    }
    if (frontendTypes.objectLiteralIsDynamic(node, checker)) {
      // A method on a dynamic object is an own data property holding the method's closure, with
      // the receiver as parameter zero exactly as on the fixed path. The closures splice back
      // into `entries` at their written positions, so the shape table records the insertion
      // order the source wrote -- a side table could not. The receiver is Unknown because the
      // object is dynamic, so `this.x` inside is a shape-table read, as for accessors above.
      return assembleDynRun(entries, methodNodes);
    }
    // The CONTEXTUAL type is the layout when there is one, because every later read of this object
    // goes through it: `const o: { y: number; x: string } = { x: "s", y: 2 }` resolves `o.x`
    // against the ANNOTATION's field order, so the literal must store to those same slots. Taking
    // the literal's own type here stored `"s"` in y's slot and read it back as `o.y`, silently
    // (plan-notes 181). Enumeration order stays the literal's -- the emitter carries it separately.
    const contextual = checker.getContextualType(node);
    const contextualType =
      contextual === undefined
        ? undefined
        : substituteHType(frontendTypes.tsTypeToHType(contextual, checker), (name) =>
            bindings.get(typeParameterKey(name)),
          );
    const own = typeAt(node, checker, bindings);
    const type = contextualType?.kind === 'object' ? contextualType : own;
    if (type.kind !== 'object') {
      diagnostics.push(
        lowerDiagnostic(node, sourceFile, 'STA4068', 'internal', 'object literal has no shape'),
      );
      return null;
    }
    // A fixed layout has no accessor entry to hold: objectLiteralIsDynamic answers `true` for any
    // literal that writes one, so this narrowing can only fail if that rule and this one drifted
    // apart -- which is a compiler bug, not a program error.
    const fixed: ObjectEntry[] = [];
    for (const entry of entries) {
      if (isAccessorEntry(entry)) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4068',
            'internal',
            'object literal with an accessor took the fixed-shape path',
          ),
        );
        return null;
      }
      if (isComputedEntry(entry)) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4068',
            'internal',
            'object literal with a computed key took the fixed-shape path',
          ),
        );
        return null;
      }
      fixed.push(entry);
    }
    const methods: ClassMethod[] = [];
    // One hidden slot per method name, so writers of one name share it and the last writer in
    // source order wins (§13.2.5.5, the `{ ...a, ...b }` and `{ ...o, m() {} }` rules). Writers
    // are own methods and spread fragments, compared by property index. A losing own method is
    // dropped outright -- binding a fresh closure runs no user code, so there is nothing to
    // preserve. A losing copy is dropped too, UNLESS its source would otherwise never run: a
    // fragment that pushed no field entry and whose source is not an identifier evaluates
    // nowhere else, so the duplicate store is what runs it (a later writer overwrites the
    // slot, which is exactly as correct as it is cheap).
    const lastWriter = new Map<string, number>();
    const considerWriter = (name: string, order: number): void => {
      const prev = lastWriter.get(name);
      if (prev === undefined || order >= prev) {
        lastWriter.set(name, order);
      }
    };
    for (const { order, node: method } of methodNodes) {
      considerWriter(memberFunctionName(method, sourceFile, checker), order);
    }
    for (const fragment of spreadFragments) {
      for (const name of fragment.methods) {
        considerWriter(name, fragment.order);
      }
    }
    // The gate refused every spread the result does not preserve (plan.md §8 step 12c S-C):
    // a copied method body reads `this` through the source's slots, so a fragment whose
    // fields are not a prefix of the result's would misread them. Reaching here with one
    // means the gate and the lowering disagree about the layout, which is a compiler bug.
    for (const fragment of spreadFragments) {
      if (fragment.methods.length > 0 && !objectFieldsPrefix(type.fields, fragment.fields)) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4068',
            'internal',
            'object spread of a value with methods that does not preserve its field order',
          ),
        );
        return null;
      }
    }
    const copies: MethodCopy[] = [];
    for (const copy of methodCopies) {
      const winner = lastWriter.get(copy.name);
      if (winner === copy.order) {
        copies.push({ name: copy.name, value: copy.value, at: copy.at });
        continue;
      }
      const fragment = spreadFragments.find(
        (candidate) => candidate.order === copy.order && candidate.methods.includes(copy.name),
      );
      if (fragment !== undefined && !fragment.pushedFields && !fragment.targetIsIdentifier) {
        copies.push({ name: copy.name, value: copy.value, at: copy.at });
      }
    }
    for (const { order, node: method } of methodNodes) {
      if (lastWriter.get(memberFunctionName(method, sourceFile, checker)) !== order) {
        continue;
      }
      const fn = lowerFunction(method, sourceFile, checker, bindings, diagnostics, type);
      if (fn === null) {
        return null;
      }
      methods.push({ name: memberFunctionName(method, sourceFile, checker), fn });
    }
    // Every method of the shape needs exactly the writers above: one winner, plus evaluation
    // keepers that a later writer overwrites. A method with no writer at all means the gate
    // and the checker agreed it exists while the literal never defines or spreads it -- a
    // compiler bug, not a program error.
    for (const method of type.methods) {
      const written =
        methods.some((own) => own.name === method.name) ||
        copies.some((copy) => copy.name === method.name);
      if (!written) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4068',
            'internal',
            `object literal method '${method.name}' has no definition or spread source`,
          ),
        );
        return null;
      }
    }
    const literal: ObjectLiteral = {
      kind: 'object-literal',
      type,
      span,
      entries: fixed,
      methods,
      methodCopies: copies,
    };
    return literal;
  }

  // `new C(...)`. The class is named, not evaluated: the gate accepted only an identifier callee,
  // and what the emitter needs is the descriptor that identifier resolves to.
  if (ts.isNewExpression(node)) {
    // `new F(...)` through a function value, or through an untyped one: the runtime constructs
    // (`jsrt_construct`), and the result is a dynamic object whatever the checker infers from F's
    // body (plan-notes 310).
    if (frontendTypes.isFunctionValueCallee(node.expression, checker)) {
      const target = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
      const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics);
      if (target === null || args === null) {
        return null;
      }
      const created: NewValue = {
        kind: 'new-value',
        type: hUnknown(false),
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        target,
        args,
      };
      return created;
    }
    const type = typeAt(node, checker, bindings);
    // `new RegExp(p, f)` and `new Array(n)` are the calls without `new` (§22.2.4.1, §23.1.1.1);
    // the gate admitted no other global function here.
    const globalFunction = globalFunctionOf(node.expression, checker);
    if (globalFunction === 'RegExp' || globalFunction === 'Array') {
      const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
      return prologue === null ? null : globalFunctionNode(globalFunction, prologue, type);
    }
    // A Map and a Set are allocated, not constructed: there is no descriptor to name and no
    // constructor to run, so the node carries which of the two it is and nothing else.
    if (type.kind === 'map' || type.kind === 'set') {
      const created: CollectionNew = {
        kind: 'collection-new',
        type,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        collection: type.kind,
        weak: frontendTypes.isWeakCollection(node, checker),
      };
      return created;
    }
    // `new TypeError('x')`. The class name comes from the CALLEE rather than from the checker's
    // type: TypeScript types every error as the structural `Error` interface, so the type would
    // lose which of the five was written -- and that is exactly what `instanceof` has to answer.
    const errorCtor = errorCtorName(node.expression, checker);
    if (errorCtor !== undefined) {
      const lowered = lowerNewCallArgs(node, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      const { span, args } = lowered;
      // §20.5.1.1 step 3 sets `message` only when the argument is not undefined, leaving it the
      // empty string otherwise -- so the omitted form is `''`, not `undefined`.
      const arg: Expression = args[0] ?? {
        kind: 'string-literal',
        type: H_STRING,
        span,
        value: '',
      };
      return { kind: 'error-new', type: errorHType(errorCtor), span, ctor: errorCtor, arg };
    }
    // `new Uint8Array(...)` / `new ArrayBuffer(n)`: one TYPED_OPS row each, padded to the row's
    // arity -- every constructor form reads an absent argument as `undefined` (plan.md T11.1).
    // The gate admitted only the global constructors, so the result type names the row.
    if (type.kind === 'uint8array' || type.kind === 'arraybuffer') {
      const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics);
      return args === null
        ? null
        : typedOpNode(
            type.kind === 'uint8array' ? 'new Uint8Array' : 'new ArrayBuffer',
            undefined,
            args,
            makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
          );
    }
    // A Date is allocated too, but unlike a collection it takes an ARGUMENT: the one-argument form
    // is the only one the gate let through, and `jsrt_date_from_value` discriminates its three
    // shapes -- a time value, an ISO string, another Date -- by tag.
    if (type.kind === 'date') {
      const lowered = lowerNewCallArgs(node, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      const { span, args } = lowered;
      // `new Date()` is `new Date(Date.now())`: §21.4.2.1 step 2 defines the zero-argument form as
      // the current time value, so desugaring it here costs the HIR no second node kind and keeps
      // the clock read in exactly one place. It is NOT `new Date(undefined)`, which is an Invalid
      // Date -- which is why the desugaring is to an explicit `now` call and not to padding.
      const arg: Expression = args[0] ?? {
        kind: 'date-static',
        type: H_NUMBER,
        span,
        method: 'now',
        args: [],
      };
      // The COMPONENT form is a different node: seven operands rather than one, and local-time
      // semantics rather than a time value. Omitted trailing components are padded with
      // `undefined`, which the runtime reads as the spec's defaults (day 1, the rest 0) -- the
      // same padding convention every `date-op` setter uses.
      if (args.length >= 2) {
        const padded = [...args];
        while (padded.length < 7) {
          padded.push({ kind: 'undefined-literal', type: H_UNDEFINED, span });
        }
        return { kind: 'date-components', type, span, args: padded };
      }
      return {
        kind: 'date-new',
        type,
        span,
        arg,
      };
    }
    if (type.kind === 'promise') {
      const lowered = lowerNewCallArgs(node, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      const { span, args } = lowered;
      const executor = args[0];
      if (executor === undefined) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4031',
            'internal',
            'new Promise without an executor reached lowering',
          ),
        );
        return null;
      }
      return { kind: 'promise-construct', type, span, executor };
    }
    if (type.kind !== 'object') {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4062',
          'internal',
          `new produced ${hTypeName(type)}, which is not a class instance`,
        ),
      );
      return null;
    }
    const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics);
    if (args === null) {
      return null;
    }
    // A construction of a generic class names a SPECIALIZATION, not the declaration:
    // `new Box(1)` is a `new Box<number>`, collected up front like every other tuple.
    const specialized = specializedClassName(node, sourceFile, checker, bindings, diagnostics);
    if (specialized === null) {
      return null;
    }
    // The node's type names the descriptor it constructs: the verifier matches every use
    // against it, so a declared name here would fail the specialization's own construction —
    // and its fields must agree too, or the constructed value would not assign to its own
    // declared type. Normalization answers both from the same tuple the name came from.
    const instanceType =
      specialized === undefined ? type : normalizeClassInstance(node, type, checker, bindings);
    const created: NewExpr = {
      kind: 'new',
      type: instanceType,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      className: specialized ?? type.name,
      args: checkCallArgs(undefined, args, node, sourceFile, checker),
    };
    return created;
  }

  // null
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return {
      kind: 'null-literal',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    };
  }

  // Identifier
  if (ts.isIdentifier(node)) {
    const name = node.text;
    const binding = bindings.get(name);
    // `undefined` is a global binding, not a keyword, so it arrives here as an ordinary
    // identifier. The `bindings` lookup comes first deliberately: a local named `undefined` is
    // legal JavaScript and must win, exactly as it does at runtime.
    if (binding === undefined && name === 'undefined') {
      return {
        kind: 'undefined-literal',
        type: H_UNDEFINED,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      };
    }
    // `NaN` and `Infinity` are globals too, exempted by name at the gate exactly like
    // `undefined` -- and like it, a user binding of the same name wins first, above.
    if (binding === undefined && (name === 'NaN' || name === 'Infinity')) {
      return {
        kind: 'number-literal',
        type: H_NUMBER,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        value: name === 'NaN' ? Number.NaN : Number.POSITIVE_INFINITY,
      };
    }
    // A generic read as a value (`console.log(box)`, `take(f)` through an alias) names
    // the canonical specialization, not the binding above: a declaration binds its raw
    // generic type (which the verifier refuses as unsubstituted) and an alias binds
    // nothing at all. Asked before either is read, so an accepted value-use never reaches
    // the miss below as an internal error; anything else falls through untouched.
    const canonical = canonicalValueReference(node, sourceFile, checker, bindings, diagnostics);
    if (canonical !== undefined) {
      return canonical;
    }
    if (!binding) {
      // Two different failures wear the same shape here, and telling them apart is the whole point.
      // An unresolved name (including an expando-only namespace) is a catchable `ReferenceError`.
      // A name with a real declaration, arriving with no binding, is a compiler bug: the gate is
      // supposed to have refused every global the HIR has no vocabulary for, so reaching here means
      // the accept set and the lowering disagree, which is what STA4035 exists to report.
      if (isUnresolvableIdentifier(node, checker, bindings)) {
        return {
          kind: 'reference-error',
          type: hUnknown(false),
          span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
          name,
        };
      }
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4035',
          'internal',
          `identifier '${name}' used before declaration`,
        ),
      );
      return null;
    }

    const ident: Identifier = {
      kind: 'identifier',
      type: binding,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      // The HIR name, not `node.text`: a shadowing block binding lives under a name of its own, and
      // this is the one place a reference turns a source name into the name the emitter allocates
      // (plan.md §8 step 14). For every binding that was not renamed the two are the same string.
      name: bindings.hirName(name),
    };
    // A narrowed read of an `unknown` is a boundary: the checker's claim about this use is settled
    // here, once, and every operation downstream may then trust the type completely. The gate has
    // already refused any narrowing this cannot check (`isCheckable`), so an unhandled one reaching
    // the emitter would be the accept-set invariant breaking, not a missing feature.
    const narrowing = narrowedTo(node, checker);
    if (narrowing !== null && isCheckable(narrowing.narrowed) && binding.kind === 'unknown') {
      return {
        kind: 'boundary-check',
        type: narrowing.narrowed,
        span: ident.span,
        value: ident,
        where: checkLocation(node, sourceFile),
      };
    }
    return ident;
  }

  // `typeof x`. The operand is lowered as an ordinary expression and constrains nothing: this is
  // the one operator that is total on every value the runtime has.
  if (ts.isTypeOfExpression(node)) {
    // `typeof undeclared` is the one position where reading an unresolved name is NOT an error:
    // §13.5.1.1 short-circuits before the reference is resolved, which is why
    // `typeof x === 'undefined'` is the idiom for asking whether a global exists at all. The
    // exception belongs on the OPERATOR, which is why it is answered here rather than by teaching
    // the identifier branch about its parent.
    let operandNode: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(operandNode)) {
      operandNode = operandNode.expression;
    }
    // `typeof id` on a named generic answers "function" for every specialization, so it folds
    // without naming one: no value is built, and the gate accepts exactly this position.
    if (
      ts.isIdentifier(operandNode) &&
      genericValueInstantiation(operandNode, checker) !== undefined
    ) {
      return {
        kind: 'string-literal',
        type: H_STRING,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        value: 'function',
      };
    }
    // `typeof JSON`: a global the language defines answers a fixed string, so the read folds and
    // no value is built (plan.md §11c T11.4). The gate accepted exactly the names this folds.
    const globalTypeof = ts.isIdentifier(operandNode)
      ? globalTypeofOf(operandNode, checker)
      : undefined;
    if (globalTypeof !== undefined) {
      return {
        kind: 'string-literal',
        type: H_STRING,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        value: globalTypeof,
      };
    }
    if (ts.isIdentifier(operandNode) && isUnresolvableIdentifier(operandNode, checker, bindings)) {
      return {
        kind: 'string-literal',
        type: H_STRING,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        value: 'undefined',
      };
    }
    const operand = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!operand) {
      return null;
    }
    return {
      kind: 'typeof',
      type: H_STRING,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      operand,
    };
  }

  // `await e`. The result type is the promise's value type, taken from the checker's own answer
  // for the await expression rather than by peeling the operand -- `await 1` is legal and its
  // operand is not a promise at all, which is exactly the case peeling would get wrong.
  if (ts.isAwaitExpression(node)) {
    if (functionNesting === 0) {
      moduleAwaits = true;
    }
    const value = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!value) {
      return null;
    }
    return {
      kind: 'await',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value,
    };
  }

  if (ts.isYieldExpression(node)) {
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    const value =
      node.expression === undefined
        ? { kind: 'undefined-literal' as const, type: H_UNDEFINED, span }
        : lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (value === null) {
      return null;
    }
    return {
      kind: 'yield',
      type: typeAt(node, checker, bindings),
      span,
      value,
    };
  }

  // `x as T`. A widening or identity cast asserts nothing and lowers to its operand alone; anything
  // else is the program overruling the checker, and the check is what makes that safe.
  if (ts.isAsExpression(node)) {
    const operand = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
    if (!operand) {
      return null;
    }
    const assertion = assertedBy(node, checker);
    if (assertion === null || !isCheckable(assertion.asserted)) {
      return operand;
    }
    // A cast off a value the compiler already types concretely needs no check -- the checker
    // rejects `1 as string` outright, so what remains is a widening the operand already satisfies.
    if (operand.type.kind !== 'unknown') {
      return operand;
    }
    return {
      kind: 'boundary-check',
      type: assertion.asserted,
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      value: operand,
      where: checkLocation(node, sourceFile),
    };
  }

  // Binary and short-circuiting expressions
  // `#x in o` -- the brand check: true exactly when `o` carries the private name's brand, i.e.
  // when it is an instance of the class that declares it. A private name is scoped to the class
  // body that writes it, so the test IS an `instanceof` against the lexically-resolved declaring
  // class, and the descriptor chain walk is what makes a subclass instance carry its base's
  // brand. One deliberate edge, stated so it is not discovered later: a primitive right operand
  // throws in JavaScript but answers `false` here, because `jsrt_instanceof` on a non-object is
  // `false` (the same answer `1 instanceof C` gives). The checker rejects a statically primitive
  // operand, so only a lying cast or an Unknown reaches it.
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    ts.isPrivateIdentifier(node.left)
  ) {
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    const target = lowerExpression(node.right, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    const brandOwner = brandDeclaringClass(node.left, checker);
    const ownerName = brandOwner === undefined ? undefined : hirClassName(brandOwner);
    if (ownerName === undefined) {
      diagnostics.push(
        lowerDiagnostic(
          node.left,
          sourceFile,
          'STA4073',
          'internal',
          'the #brand-in-object test names no class the gate accepted',
        ),
      );
      return null;
    }
    const test: InstanceOf = {
      kind: 'instanceof',
      type: H_BOOLEAN,
      span,
      target,
      className: ownerName,
    };
    return test;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    // The right operand is a class NAME, and the name is taken from the DECLARATION rather than
    // from the reference: `import { C as D }` would spell the reference `D`, and the emitter's
    // descriptor is keyed by what the class calls itself.
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    const target = lowerExpression(node.left, sourceFile, checker, bindings, diagnostics);
    if (target === null) {
      return null;
    }
    if (ts.isIdentifier(node.right) && INSTANCEOF_BUILTINS.has(node.right.text)) {
      const test: InstanceOf = {
        kind: 'instanceof',
        type: H_BOOLEAN,
        span,
        target,
        className: node.right.text,
        builtin: true,
      };
      return test;
    }
    // Against an ordinary function or an untyped value, the prototype question is the VALUE's,
    // answered at run time (`jsrt_instanceof_ctor`, plan-notes 310).
    if (frontendTypes.isFunctionValueCallee(node.right, checker)) {
      const ctor = lowerExpression(node.right, sourceFile, checker, bindings, diagnostics);
      if (ctor === null) {
        return null;
      }
      const test: InstanceOfValue = {
        kind: 'instanceof-value',
        type: H_BOOLEAN,
        span,
        target,
        ctor,
      };
      return test;
    }
    const direct = checker.getSymbolAtLocation(node.right)?.valueDeclaration;
    // A class alias names the same descriptor its target does: `o instanceof K` on
    // `const K = C` is the pointer comparison against `C`, so the direct check keeps its exact
    // shape and the alias resolves beside it. A bound class expression names its own
    // descriptor the same way (`o instanceof C` on `const C = class …`; plan.md §8 step 12(d)).
    const declaration =
      direct !== undefined && (ts.isClassDeclaration(direct) || ts.isClassExpression(direct))
        ? direct
        : ts.isIdentifier(node.right)
          ? (frontendTypes.aliasedClassDeclaration(node.right, checker) ??
            frontendTypes.classExpressionTarget(node.right, checker) ??
            frontendTypes.innerClassExpression(node.right, checker))
          : undefined;
    if (declaration === undefined || classDisplayName(declaration) === undefined) {
      diagnostics.push(
        lowerDiagnostic(
          node.right,
          sourceFile,
          'STA4063',
          'internal',
          'instanceof right operand is not a class the gate accepted',
        ),
      );
      return null;
    }
    const test: InstanceOf = {
      kind: 'instanceof',
      // Always boolean, whatever the checker narrowed the expression to at this position.
      type: H_BOOLEAN,
      span,
      target,
      className: hirClassName(declaration),
    };
    return test;
  }

  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    const operator = BINARY_OPERATORS.get(opKind);
    const logical = LOGICAL_OPERATORS.get(opKind);
    if (operator === undefined && logical === undefined) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4036',
          'internal',
          `unsupported binary operator: ${syntaxKindName(opKind)}`,
        ),
      );
      return null;
    }

    const left = lowerExpression(node.left, sourceFile, checker, bindings, diagnostics);
    if (!left) {
      return null;
    }

    const right = lowerExpression(node.right, sourceFile, checker, bindings, diagnostics);
    if (!right) {
      return null;
    }

    const type = typeAt(node, checker, bindings);
    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);

    if (logical !== undefined) {
      const logicalOp: LogicalOp = {
        kind: 'logical-op',
        type,
        span,
        operator: logical,
        left,
        right,
      };
      return logicalOp;
    }
    if (operator === ',') {
      // The comma operator's value IS its right operand, so its type is the lowered right's type.
      // Asking the checker again can disagree: an Unknown binding narrowed by an assignment on
      // the left (`(mod = { exports: {} }, mod.exports)`, Rolldown's `__commonJSMin`) types the
      // whole expression from the declared Unknown while the right lowers through the narrowing.
      return { kind: 'binary-op', type: right.type, span, operator, left, right };
    }
    if (operator === '+') {
      // `+` asks each operand's `valueOf` first (§13.15.3 step 1.a, hint default).
      return arithmeticBinOp(
        operator,
        userConversion(node.left, left, 'valueOf', sourceFile, checker, bindings),
        userConversion(node.right, right, 'valueOf', sourceFile, checker, bindings),
        span,
        type,
      );
    }
    if (operator !== undefined) {
      return arithmeticBinOp(operator, left, right, span, type);
    }
    return null;
  }

  // Prefix unary. The `-<numeric literal>` fold above already returned; anything reaching here is
  // a real operation on a computed operand.
  if (ts.isPrefixUnaryExpression(node)) {
    const operator = UNARY_OPERATORS.get(node.operator);
    if (operator === undefined) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4036',
          'internal',
          `unsupported unary operator: ${syntaxKindName(node.operator)}`,
        ),
      );
      return null;
    }

    const operand = lowerExpression(node.operand, sourceFile, checker, bindings, diagnostics);
    if (!operand) {
      return null;
    }

    const unaryOp: UnaryOp = {
      kind: 'unary-op',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      operator,
      operand,
    };
    return unaryOp;
  }

  // A function literal used as a value: `const f = (x: number) => x * 2`.
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return lowerFunction(node, sourceFile, checker, bindings, diagnostics);
  }

  // Call expression (console.log)
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return lowerImportCall(node, sourceFile, checker, bindings, diagnostics);
    }
    if (node.arguments.some((argument) => ts.isSpreadElement(argument))) {
      return lowerSpreadCall(node, sourceFile, checker, bindings, diagnostics);
    }
    const expr = node.expression;

    // A global function called by name (plan.md §11c T11.4). The gate proved the name, the
    // absence of a spread and the arity bound; the function itself is never lowered.
    const globalFunction = globalFunctionOf(expr, checker);
    if (globalFunction !== undefined) {
      const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
      if (prologue === null) {
        return null;
      }
      // `String(x)` is a template hole, and converts the same way.
      const first = prologue.args[0];
      const firstNode = node.arguments[0];
      const converted =
        globalFunction === 'String' && first !== undefined && firstNode !== undefined
          ? {
              ...prologue,
              args: [
                userConversion(firstNode, first, 'toString', sourceFile, checker, bindings),
                ...prologue.args.slice(1),
              ],
            }
          : prologue;
      return globalFunctionNode(globalFunction, converted, typeAt(node, checker, bindings));
    }

    // Check if this is a property access (console.log)
    if (ts.isPropertyAccessExpression(expr)) {
      const obj = expr.expression;
      const propName = expr.name.text;

      // A console call. The gate allowed the method to omit its optional trailing argument. Where
      // the spec's own absent case IS undefined (`count()` counts under "default") the list is
      // padded here and one C entry point serves both forms; where it is not (`group`, `assert`,
      // whose explicit-undefined output differs from their omitted output) the list stays short
      // and `consoleEntryPoint` picks the runtime function that means absence. The five variadic
      // methods take any width at their `(count, argv)` entry point, so they are never padded —
      // `console.log()` must reach the runtime empty, not carrying one `undefined`.
      if (
        ts.isIdentifier(obj) &&
        obj.text === 'console' &&
        Object.hasOwn(CONSOLE_METHODS, propName)
      ) {
        const given = lowerArguments(
          node.arguments,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          node,
        );
        if (given === null) {
          return null;
        }
        const method = propName as ConsoleMethod;
        const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
        const shape = CONSOLE_METHODS[method];
        const args = [...given];
        if (!('bare' in shape) && !('variadic' in shape)) {
          while (args.length < shape.arity) {
            args.push({ kind: 'undefined-literal', type: H_UNDEFINED, span });
          }
        }
        const call: ConsoleLogCall = {
          kind: 'console-log',
          type: typeAt(node, checker, bindings),
          span,
          method,
          args,
        };
        return call;
      }

      // The Object namespace calls. `keys`/`getOwnPropertyNames` are `string[]` by construction
      // and `hasOwn` a boolean; for `values`/`entries` the checker's answer is kept when it maps
      // to an array, and the element degrades to Unknown when it does not (a mixed shape makes
      // the element genuinely a union this type model does not carry). `fromEntries` builds a
      // DYNAMIC shape and `assign` returns a target that just GREW one, so both are Unknown outright — the same honest answer `JSON.parse` gives,
      // and every read of it is a boundary.
      if (isGlobalObject(obj, checker) && Object.hasOwn(OBJECT_STATICS, propName)) {
        const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { args, span } = prologue;
        const method = propName as ObjectStaticMethod;
        const checkerType = typeAt(node, checker, bindings);
        let type: HType;
        if (method === 'keys' || method === 'getOwnPropertyNames') {
          type = { kind: 'array', element: H_STRING };
        } else if (method === 'hasOwn' || method === 'isFrozen') {
          type = H_BOOLEAN;
        } else if (method === 'fromEntries' || method === 'assign') {
          type = hUnknown(false);
        } else if (method === 'freeze') {
          type = args[0]?.type ?? checkerType;
        } else {
          type =
            checkerType.kind === 'array'
              ? checkerType
              : { kind: 'array', element: hUnknown(false) };
        }
        return { kind: 'object-static', type, span, method, args };
      }

      // `Date.UTC(...)` and `Date.parse(s)`. Both answer a time VALUE, so the type is pinned to
      // number here rather than taken from the node -- the checker agrees, and the verifier holds
      // it either way. Omitted trailing components are padded with undefined-literals: §21.4.3.4
      // reads absence off the argument list and the runtime reads it off JSRT_UNDEFINED, which is
      // the same question asked one layer down.
      if (isGlobalDate(obj, checker) && Object.hasOwn(DATE_STATICS, propName)) {
        const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const span = prologue.span;
        const method = propName as DateStatic;
        const padded = padToArity(prologue.args, DATE_STATICS[method].arity, span);
        return { kind: 'date-static', type: H_NUMBER, span, method, args: padded };
      }

      // The two JSON calls, both single-argument. `stringify` is always a string: the gate
      // already refused arguments whose type admits `undefined` or a function at the top level,
      // the two cases where the spec's answer is `undefined` rather than a string. `parse` is
      // Unknown by construction -- the checker types it `any` because the text is data, and the
      // honest HIR type for data nobody has checked yet is the one every use must narrow.
      if (isGlobalJson(obj, checker)) {
        const prologue = lowerSoleCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { arg, span } = prologue;
        return propName === 'parse'
          ? { kind: 'json-parse', type: hUnknown(false), span, arg }
          : { kind: 'json-stringify', type: H_STRING, span, arg };
      }

      // The three Promise statics the subset carries. `resolve`/`reject` take one value of any
      // type and `all` an array; the result is always a promise, and its value type comes from
      // the checker -- which knows `Promise.resolve(1)` is `Promise<number>` and, for `all`, the
      // tuple-or-array element the awaited result carries. Where the checker's answer does not
      // map to a promise (an untyped argument in js mode) the value degrades to Unknown, which
      // is what every read of the awaited result must narrow anyway.
      if (isGlobalPromise(obj, checker) && Object.hasOwn(PROMISE_STATICS, propName)) {
        const prologue = lowerSoleCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { arg, span } = prologue;
        const checkerType = typeAt(node, checker, bindings);
        const type = checkerType.kind === 'promise' ? checkerType : hPromise(hUnknown(false));
        return {
          kind: 'promise-static',
          type,
          span,
          method: propName as PromiseStaticMethod,
          arg,
        };
      }

      // `String.fromCharCode(...codes)` (plan.md §8 step 19): the one `String` namespace call.
      // Variadic in the source and variadic in the node — the arguments lower left to right
      // through the shared global prologue, and the emitter passes the count the runtime
      // iterates. The gate proved the name; anything else on `String` never reaches here.
      if (isGlobalString(obj, checker) && Object.hasOwn(STRING_STATICS, propName)) {
        const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        return {
          kind: 'string-static',
          type: H_STRING,
          span: prologue.span,
          method: propName as StringStaticMethod,
          args: prologue.args,
        };
      }

      // `Array.isArray(x)` is the builtin `x instanceof Array` (plan.md §11c T11.4): in one realm
      // and without Proxy the two agree on every value, so it takes that node rather than a
      // second spelling of the same tag test. `Array.isArray()` asks about `undefined`.
      if (isGlobalArray(obj, checker) && propName === 'isArray') {
        const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { span } = prologue;
        const target: Expression = prologue.args[0] ?? {
          kind: 'undefined-literal',
          type: H_UNDEFINED,
          span,
        };
        const test: InstanceOf = {
          kind: 'instanceof',
          type: H_BOOLEAN,
          span,
          target,
          className: 'Array',
          builtin: true,
        };
        return test;
      }

      const receiverType = receiverTypeAt(obj, checker, bindings);
      if (
        receiverType.kind === 'promise' &&
        (propName === 'then' || propName === 'catch' || propName === 'finally')
      ) {
        const given = lowerArguments(
          node.arguments,
          sourceFile,
          checker,
          bindings,
          diagnostics,
          node,
        );
        if (given === null) {
          return null;
        }
        const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
        const target = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
        if (target === null) {
          return null;
        }
        const want = propName === 'then' ? 2 : 1;
        const args = padToArity(given, want, span);
        const checkerType = typeAt(node, checker, bindings);
        const type = checkerType.kind === 'promise' ? checkerType : hPromise(hUnknown(false));
        return {
          kind: 'promise-method',
          type,
          span,
          method: propName as PromiseInstanceMethod,
          target,
          args,
        };
      }

      // `Math.floor(x)` and the rest of the Math surface. Variadic min/max are folded to nested
      // BINARY nodes here -- left fold, so `Math.min(a, b, c)` compares a to b first, which is
      // the order the spec's own loop uses and the order side effects already ran in. The
      // zero-argument forms are their identity literals, and one argument passes through: every
      // argument is typed number, and min/max of one number is that number (NaN included).
      if (isGlobalMath(obj, checker) && MATH_METHODS.has(propName)) {
        const prologue = lowerGlobalCall(node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { args, span } = prologue;
        if (propName === 'min' || propName === 'max') {
          if (args.length === 0) {
            return {
              kind: 'number-literal',
              type: H_NUMBER,
              span,
              value: propName === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
            };
          }
          let folded = args[0];
          if (folded === undefined) {
            return null;
          }
          for (const next of args.slice(1)) {
            folded = {
              kind: 'math-call',
              type: H_NUMBER,
              span,
              method: propName,
              args: [folded, next],
            };
          }
          return folded;
        }
        // hypot's degenerate arities, which the runtime entry point (binary, like min/max) cannot
        // express. These two are not folds of a binary hypot -- they are what the spec says the
        // answer IS: hypot() is +0, and hypot(x) is |x|. Three or more arguments never reach here;
        // the gate refuses them, because hypot is not associative (see the gate's note).
        if (propName === 'hypot' && args.length < 2) {
          const [only] = args;
          if (only === undefined) {
            return { kind: 'number-literal', type: H_NUMBER, span, value: 0 };
          }
          return { kind: 'math-call', type: H_NUMBER, span, method: 'abs', args: [only] };
        }
        return {
          kind: 'math-call',
          type: H_NUMBER,
          span,
          method: propName as MathMethod,
          args,
        };
      }

      // `n.toString(radix)` and `n.toFixed(digits)` (plan-notes 310): the one argument padded
      // with `undefined`, which the runtime reads as the spec's default.
      if (receiverType.kind === 'number' && Object.hasOwn(NUMBER_OPS, propName)) {
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { target, span } = prologue;
        const op = propName as NumberOperation;
        const args = padToArity(prologue.args, 1, span);
        return { kind: 'number-op', type: H_STRING, span, op, target, args };
      }

      // The landed `Date.prototype` surface, on the string ops' padding discipline and for the
      // same reason: every setter's spec text reads an omitted trailing component exactly as it
      // reads an explicitly-passed undefined. The result type comes from the table.
      // A receiver the bindings type Unknown never takes a specialized arm, however the checker
      // spells it: the value may be `undefined` (an uninitialized annotated binding widened off
      // its 2454, a `var` read before its assignment), and the static op would trust the
      // annotation straight into memory-unsafe code. The dynamic method call below answers
      // Node's catchable TypeError for the nullish case instead (the 2454 rule).
      if (
        receiverType.kind !== 'unknown' &&
        (isDateReceiver(obj, checker) ||
          substitutedReceiverKind(obj, checker, bindings) === 'date') &&
        Object.hasOwn(DATE_OPS, propName)
      ) {
        const op = propName as DateOperation;
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { target, span } = prologue;
        const padded = padToArity(prologue.args, DATE_OPS[op].arity, span);
        const type = DATE_OPS[op].result === 'number' ? H_NUMBER : H_STRING;
        return { kind: 'date-op', type, span, op, target, args: padded };
      }

      // The landed Uint8Array / ArrayBuffer METHODS (plan.md T11.1), padded to the row's arity --
      // every one reads an omitted bound as `undefined`, the spec's own default. Unknown
      // receivers take the dynamic path (the 2454 rule above).
      const typedOp =
        receiverType.kind === 'uint8array' || receiverType.kind === 'arraybuffer'
          ? typedMember(receiverType.kind, propName)
          : undefined;
      if (typedOp !== undefined && TYPED_OPS[typedOp].form === 'call') {
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        return typedOpNode(typedOp, prologue.target, prologue.args, prologue.span);
      }

      // The landed RegExp.prototype METHODS. The result is taken from the node rather than the
      // table because the verifier pins it either way, and this keeps a checker that says
      // otherwise visible instead of overwritten. Unknown receivers take the dynamic path
      // (the 2454 rule above).
      if (
        receiverType.kind !== 'unknown' &&
        (isRegExpReceiver(obj, checker) ||
          substitutedReceiverKind(obj, checker, bindings) === 'regexp') &&
        Object.hasOwn(REGEXP_OPS, propName)
      ) {
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        return {
          kind: 'regexp-op',
          type: typeAt(node, checker, bindings),
          span: prologue.span,
          op: propName as RegExpOperation,
          target: prologue.target,
          args: prologue.args,
        };
      }

      // The landed String.prototype surface. Missing optional arguments are PADDED with
      // undefined-literals up to the table's arity -- for every op in the set the spec gives an
      // explicitly-passed undefined the same meaning as an absent argument, which is what makes
      // the padding observably identical to the source. The node's type comes from the table,
      // the same table the verifier holds it to. Unknown receivers take the dynamic path
      // (the 2454 rule above).
      if (
        receiverType.kind !== 'unknown' &&
        (isStringReceiver(obj, checker) ||
          substitutedReceiverKind(obj, checker, bindings) === 'string') &&
        Object.hasOwn(STRING_OPS, propName)
      ) {
        const op = propName as StringOpName;
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { target, span } = prologue;
        // Variadic `concat` folds left into nested singles (plan.md §8 step 19) — the min/max
        // precedent, and sound for the same reason: concatenation is associative, each argument
        // is evaluated once in source order, and the receiver is evaluated once as the
        // innermost target. Zero arguments answer the receiver itself. One argument is the
        // single form below, untouched.
        if (op === 'concat' && prologue.args.length !== 1) {
          let folded: Expression = target;
          for (const next of prologue.args) {
            folded = {
              kind: 'string-op',
              type: H_STRING,
              span,
              op: 'concat',
              target: folded,
              args: [next],
            };
          }
          return folded;
        }
        const shape = STRING_OPS[op];
        const padded = padToArity(prologue.args, shape.arity, span);
        const checkerType = typeAt(node, checker, bindings);
        const type: HType =
          shape.result === 'element' || shape.result === 'match'
            ? hUnknown(false)
            : shape.result === 'string-array'
              ? { kind: 'array', element: H_STRING }
              : shape.result === 'number'
                ? H_NUMBER
                : shape.result === 'boolean'
                  ? H_BOOLEAN
                  : shape.result === 'iterator'
                    ? checkerType.kind === 'iterator'
                      ? checkerType
                      : hIterator(hUnknown(false))
                    : H_STRING;
        return { kind: 'string-op', type, span, op, target, args: padded };
      }

      const iteratorMethod =
        propName === 'next' || propName === 'return' || propName === 'throw' ? propName : null;
      if (iteratorMethod !== null && typeAt(obj, checker, bindings).kind === 'iterator') {
        // `return`/`throw` exist on Generator.prototype and land here as generator closing calls.
        // A boxed specialized iterator (`arr.keys()`) also has the names in its TypeScript
        // interface, but the runtime has no closing semantic for it yet, so the gate refuses the
        // two there and the lowering only ever sees them on a Generator.
        if (iteratorMethod !== 'next' && !isGeneratorReceiver(obj, checker)) {
          diagnostics.push(
            lowerDiagnostic(
              expr,
              sourceFile,
              'STA4071',
              'internal',
              `Iterator.${iteratorMethod} reached the lowering on a non-generator receiver`,
            ),
          );
          return null;
        }
        const target = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
        if (target === null) {
          return null;
        }
        const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
        const sentArg = node.arguments[0];
        const sent =
          sentArg === undefined
            ? { kind: 'undefined-literal' as const, type: H_UNDEFINED, span }
            : lowerExpression(sentArg, sourceFile, checker, bindings, diagnostics);
        if (sent === null) {
          return null;
        }
        return {
          kind: 'iterator-next',
          type: typeAt(node, checker, bindings),
          span,
          target,
          op: iteratorMethod,
          sent,
        };
      }

      // The landed Array.prototype surface, on the same table discipline: pad optional positions
      // with `undefined` (sound for every op the table holds — `lastIndexOf` lands without its
      // position for exactly the case where it would not be), and take the result type from the
      // table, where `self` is the RECEIVER's own array type and `element` is Unknown by the
      // IndexAccess rule (`pop` on an empty array really answers `undefined`). Unknown receivers
      // take the dynamic path (the 2454 rule above): the shape table resolves Array.prototype
      // methods there, and a nullish receiver throws Node's catchable TypeError.
      if (
        receiverType.kind !== 'unknown' &&
        (isArrayReceiver(obj, checker) ||
          substitutedReceiverKind(obj, checker, bindings) === 'array') &&
        Object.hasOwn(ARRAY_OPS, propName)
      ) {
        const op = propName as ArrayOpName;
        const prologue = lowerReceiverCall(obj, node, sourceFile, checker, bindings, diagnostics);
        if (prologue === null) {
          return null;
        }
        const { target, span } = prologue;
        const shape = ARRAY_OPS[op];
        const padded = padToArity(prologue.args, shape.arity, span);
        // `mapped` keeps the checker's answer -- map's element is the callback's to choose and a
        // type-guard filter legitimately narrows below the receiver -- degrading to Unknown when
        // the answer is not an array this model can spell.
        const checkerType = typeAt(node, checker, bindings);
        const type: HType =
          shape.result === 'self'
            ? target.type
            : shape.result === 'checker'
              ? checkerType
              : shape.result === 'mapped'
                ? checkerType.kind === 'array'
                  ? checkerType
                  : { kind: 'array', element: hUnknown(false) }
                : shape.result === 'undefined'
                  ? H_UNDEFINED
                  : shape.result === 'number'
                    ? H_NUMBER
                    : shape.result === 'boolean'
                      ? H_BOOLEAN
                      : shape.result === 'string'
                        ? H_STRING
                        : shape.result === 'iterator'
                          ? checkerType
                          : hUnknown(false);
        return { kind: 'array-op', type, span, op, target, args: padded };
      }

      // `m.get(k)`, `s.add(v)` and the rest. Decided before the class case because a Map has no
      // class declaration at all: the receiver's TYPE is the whole test, and each operation is one
      // runtime function shared by every collection in the program.
      const receiver = receiverTypeAt(obj, checker, bindings);
      if (receiver.kind === 'map' || receiver.kind === 'set') {
        // Asked of the TYPE before anything is lowered: `super.m()` reaches this same branch, and
        // `super` names no value, so lowering the receiver to find out what it is would report an
        // error on a call that is perfectly fine.
        const target = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
        if (target === null) {
          return null;
        }
        {
          const args = lowerArguments(
            node.arguments,
            sourceFile,
            checker,
            bindings,
            diagnostics,
            node,
          );
          if (args === null) {
            return null;
          }
          const op = collectionOperation(propName);
          if (op === undefined) {
            diagnostics.push(
              lowerDiagnostic(
                expr,
                sourceFile,
                'STA4069',
                'internal',
                `'${propName}' is not an operation of a ${hTypeName(receiver)}`,
              ),
            );
            return null;
          }
          const call: CollectionOp = {
            kind: 'collection-op',
            type: typeAt(node, checker, bindings),
            span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
            collection: receiver.kind,
            op,
            target,
            args,
          };
          return call;
        }
      }

      // `o.m(a)`. The receiver is lowered; the method is NOT -- one function is shared by every
      // instance, so naming its class here is what lets the emitter make a direct call instead of
      // loading a per-instance closure out of a slot.
      if (isClassInstance(obj, checker, bindings)) {
        // `super.m()` is a call on THIS receiver that skips the override -- the object is the same
        // one, only the function differs, which is the one `viaSuper` the helper takes.
        const viaSuper = obj.kind === ts.SyntaxKind.SuperKeyword;
        const lowered = lowerClassMethodCall(
          obj,
          propName,
          ts.isPrivateIdentifier(expr.name) ? expr.name : undefined,
          viaSuper,
          node,
          expr,
          sourceFile,
          checker,
          bindings,
          diagnostics,
        );
        if (lowered !== undefined) {
          return lowered;
        }
      }

      // `c?.m(a)` on a nullable single-class receiver: the call twin of the method-value read in
      // `lowerExpression`. The chain guards the base, so the consequent calls statically with the
      // guarded base retyped to the non-nullish class. Only this `?.` link, only non-super
      // non-private (those never carry `?.` past the gate); anything the helper declines keeps the
      // dynamic call below, which the gate still refuses for layouts.
      if (
        expr.questionDotToken !== undefined &&
        obj.kind !== ts.SyntaxKind.SuperKeyword &&
        !ts.isPrivateIdentifier(expr.name) &&
        optionalChainCuts.has(obj)
      ) {
        const info = nullableMethodInfo(obj, propName, checker, bindings);
        if (info !== undefined) {
          const raw = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
          if (raw === null) {
            return null;
          }
          const args = lowerArguments(
            node.arguments,
            sourceFile,
            checker,
            bindings,
            diagnostics,
            node,
          );
          if (args === null) {
            return null;
          }
          const target: Expression = {
            kind: 'optional-base',
            type: info.objectType,
            span: raw.span,
          };
          const call: MethodCall = {
            kind: 'method-call',
            type: typeAt(node, checker, bindings),
            span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
            target,
            className: info.className,
            method: propName,
            slot: info.slot,
            dispatch: info.dispatch,
            args,
          };
          return call;
        }
      }
    }

    // `o[k](a)` where `k` statically names a method: the element spelling of the method call
    // above, and the twin the computed-name fixtures prove (`new C()[k]()` answers what
    // `new C().m()` does). The key is compile-time, so the call names the declaring class
    // exactly as the dot spelling does; anything the helper declines (a field holding a
    // closure, an accessor result) falls through to the ordinary get-then-call path below,
    // mirroring what the dot forms lower to.
    if (ts.isElementAccessExpression(expr) && isClassInstance(expr.expression, checker, bindings)) {
      const key = frontendTypes.elementStaticKey(expr.argumentExpression, checker);
      if (key !== null) {
        const lowered = lowerClassMethodCall(
          expr.expression,
          key,
          undefined,
          false,
          node,
          expr,
          sourceFile,
          checker,
          bindings,
          diagnostics,
        );
        if (lowered !== undefined) {
          return lowered;
        }
      }
    }

    // `c[Symbol.iterator]()` on a known user-iterable class: the element spelling of the
    // iterator call, naming `__@iterator` exactly as the dot spelling names a method. The gate
    // admitted only the object whose HType carries the method, so reaching here without one is
    // the gate and the lowering disagreeing — and `lowerClassMethodCall` reports that itself.
    if (
      ts.isElementAccessExpression(expr) &&
      frontendTypes.isSymbolIteratorKey(expr.argumentExpression, checker) &&
      isClassInstance(expr.expression, checker, bindings)
    ) {
      const lowered = lowerClassMethodCall(
        expr.expression,
        frontendTypes.ITERATOR_METHOD_NAME,
        undefined,
        false,
        node,
        expr,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      if (lowered !== undefined) {
        return lowered;
      }
    }

    // A slot construction (docs/FFI.md §2): the gate proved the blessed shape and a
    // resolvable inner — so a refusal here is the gate and the lowering disagreeing (STA4031),
    // never a user-facing diagnostic. Answers the pure zero-handle: creation allocates
    // nothing, and every use resolves its meaning from its own context.
    if (ts.isCallExpression(node) && outSlotDeclarationOf(node, checker) !== undefined) {
      const classified = classifyOutSlotCall(node, checker);
      if (!classified.ok) {
        diagnostics.push(
          lowerDiagnostic(
            node,
            sourceFile,
            'STA4031',
            'internal',
            `outSlot call the gate refused reached the lowering (${classified.message})`,
          ),
        );
        return null;
      }
      const made: OutNew = {
        kind: 'out-new',
        type: hUnknown(false),
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      };
      return made;
    }

    // An extern call (docs/FFI.md §1): a direct C call, not a closure. The gate proved the
    // declaration is in a `.d.ts`, classified its signature, and pinned the arity — so a refusal
    // here is the gate and the lowering disagreeing (STA4031), never a user-facing diagnostic.
    const externDecl = externDeclarationOfCall(node, checker);
    if (externDecl !== undefined) {
      return lowerExternCall(node, externDecl, sourceFile, checker, bindings, diagnostics);
    }

    // A call to a generic names a SPECIALIZATION, not the generic: `box(1)` is a call to
    // `box<number>`, which `collectSpecializations` has already put in `bindings` under that
    // mangled name. The callee is not lowered as an expression, because the name it would lower to
    // binds nothing -- a generic function has no value (the gate says so, in the same words).
    const specialized = specializedCallee(node, sourceFile, checker, bindings, diagnostics);
    if (specialized === null) {
      return null;
    }

    // `o.m(a)` on an Unknown receiver: the name resolves through the shape table at run time,
    // and the call passes the receiver when the loaded closure declares one. Every specialized
    // arm above (arrays, collections, strings, class instances, ...) keeps priority -- what
    // reaches here is genuinely dynamic, which the gate accepted in those exact words.
    if (specialized === undefined) {
      const dynCall = lowerDynMethodCall(node, expr, sourceFile, checker, bindings, diagnostics);
      if (dynCall !== undefined) {
        return dynCall;
      }
    }

    // An ordinary call's callee is evaluated as a value like any other expression -- the gate has
    // already restricted it to shapes whose value the emitter can produce.
    const callee = specialized ?? lowerExpression(expr, sourceFile, checker, bindings, diagnostics);
    if (callee === null) {
      return null;
    }
    // A generic passed as an argument names a SPECIALIZATION too: `run(box, 1)` passes
    // `box<number>`, resolved against the parameter's function type. Anything else lowers as
    // an ordinary argument expression. Shared with the dynamic method call below, whose
    // arguments lower exactly as an ordinary call's do.
    const args = lowerCallArguments(node, sourceFile, checker, bindings, diagnostics);
    if (args === null) {
      return null;
    }
    // A callee of concrete non-function type: js mode suppressed the checker's TS2349, so this
    // call reaches lowering with a type the verifier's STA4041 would report. `fn` and Unknown
    // call through `jsrt_call_at` (a non-function there is the documented STA2006 abort); anything
    // else throws Node's catchable TypeError after evaluating callee and arguments in order.
    if (callee.type.kind !== 'fn' && callee.type.kind !== 'unknown') {
      return nonFunctionCall(node, expr, callee, args, sourceFile);
    }
    const call: CallExpr = {
      kind: 'call',
      type: typeAt(node, checker, bindings),
      span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
      callee,
      args: checkCallArgs(callee.type, args, node, sourceFile, checker),
    };
    return call;
  }

  // Anything else is an internal error
  diagnostics.push(
    lowerDiagnostic(
      node,
      sourceFile,
      'STA4031',
      'internal',
      `unexpected expression kind: ${syntaxKindName(node.kind)}`,
    ),
  );
  return null;
}

/** The two calls whose callee loads off the receiver at run time. */
type ReceiverCall = DynMethodCall | FieldCall;

/** `o.m(a)` where `o`'s HIR type is Unknown, or `o.f(a)` where `f` is a layout FIELD holding a
 * closure (`FieldCall`, plan-notes 310).
 *
 * `undefined` means "not this shape" and the ordinary call path applies; `null` means a
 * diagnostic was pushed. Every typed receiver took a specialized arm before this point, so a
 * receiver that still has a layout here is a field holding a closure; the two calls differ only
 * in where the callee loads from. `super` and match receivers are excluded the same way: neither
 * is a shape-table read. */
function lowerDynMethodCall(
  node: ts.CallExpression,
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): ReceiverCall | null | undefined {
  if (!ts.isPropertyAccessExpression(expr)) {
    return undefined;
  }
  const obj = expr.expression;
  if (obj.kind === ts.SyntaxKind.SuperKeyword || isMatchReceiver(obj, checker)) {
    return undefined;
  }
  const receiver = receiverTypeAt(obj, checker, bindings);
  const slot = callableFieldSlot(receiver, expr.name.text);
  // `assert.sameValue(a, b)`: a function's own property, called with the function as receiver.
  // Its result is Unknown: the checker types it from whatever was assigned, which no layout holds
  // the program to (plan-notes 310).
  const functionMember = frontendTypes.isFunctionValueMember(obj, expr.name.text, checker);
  // `info.cb()` where `cb` was grown onto a fixed object: the overflow table holds it, and its
  // result is Unknown for the same reason (docs/VALUE.md §4.24).
  const grown = frontendTypes.isUndeclaredMemberRead(expr, checker);
  if (receiver.kind !== 'unknown' && slot === undefined && !functionMember && !grown) {
    return undefined;
  }
  const target = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
  if (target === null) {
    return null;
  }
  const args = lowerCallArguments(node, sourceFile, checker, bindings, diagnostics);
  if (args === null) {
    return null;
  }
  const type = functionMember || grown ? hUnknown(false) : typeAt(node, checker, bindings);
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const field = expr.name.text;
  if (slot !== undefined) {
    return { kind: 'field-call', type, span, target, field, slot, args };
  }
  /* Every dynamic method call carries `notFunction`: a name the shape table and the prototype
   * walk both miss must throw Node's `TypeError: x.m is not a function` rather than fall into
   * `jsrt_call_at`'s STA2006 abort (plan-notes 372). The check is a no-op when the load found
   * a closure. */
  return {
    kind: 'dyn-method-call',
    type,
    span,
    target,
    method: field,
    args,
    notFunction: notFunctionSubject(expr, sourceFile),
  };
}

/** A call with a spread argument (plan.md §11c T11.4 step 5): the arguments fold into ONE array
 * (`foldSpreadList`, the array literal's own building) and the call passes it whole through
 * `jsrt_call_spread_at`. `o.m(...xs)` reads `m` through the shape table and passes `o` as the
 * receiver; a static method, a module namespace's member and any other callee are values called
 * without one. The gate refused the forms this does not build (optional chains, `super`, the
 * builtin namespaces, js-mode calls into annotated TypeScript parameters). */
function lowerSpreadCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const expr = node.expression;
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const lowerArgs = (): Expression[] | null => {
    const segments = lowerSpreadSegments(node.arguments, (argument) => {
      const specialized = specializedArgument(
        argument,
        node,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      return specialized !== undefined
        ? specialized
        : lowerExpression(argument, sourceFile, checker, bindings, diagnostics);
    });
    return segments === null ? null : [foldSpreadList(segments, spreadListType(segments), span)];
  };
  if (
    ts.isPropertyAccessExpression(expr) &&
    frontendTypes.staticMemberOf(expr, checker, true) === undefined &&
    !isNamespaceReceiver(expr.expression, checker)
  ) {
    const target = lowerExpression(expr.expression, sourceFile, checker, bindings, diagnostics);
    const args = target === null ? null : lowerArgs();
    if (target === null || args === null) {
      return null;
    }
    const functionMember = frontendTypes.isFunctionValueMember(
      expr.expression,
      expr.name.text,
      checker,
    );
    const type = functionMember ? hUnknown(false) : typeAt(node, checker, bindings);
    return {
      kind: 'dyn-method-call',
      type,
      span,
      target,
      method: expr.name.text,
      args,
      spread: true,
    };
  }
  const specialized = specializedCallee(node, sourceFile, checker, bindings, diagnostics);
  const callee =
    specialized === null
      ? null
      : (specialized ?? lowerExpression(expr, sourceFile, checker, bindings, diagnostics));
  const args = callee === null ? null : lowerArgs();
  if (callee === null || args === null) {
    return null;
  }
  if (callee.type.kind !== 'fn' && callee.type.kind !== 'unknown') {
    return nonFunctionCall(node, expr, callee, args, sourceFile);
  }
  return { kind: 'call', type: typeAt(node, checker, bindings), span, callee, args, spread: true };
}

/** A spread call's argument list type: the one element type every piece shares (`f(...xs, 1)` over
 * `number[]` is a `number[]`, which keeps a typed call typed), and Unknown elements otherwise. */
function spreadListType(segments: readonly SpreadSegment[]): HType {
  const elements = segments.flatMap((segment) =>
    'elems' in segment
      ? segment.elems.map((elem) => elem.type)
      : [segment.spread.type.kind === 'array' ? segment.spread.type.element : hUnknown(false)],
  );
  const [first] = elements;
  return first !== undefined && elements.every((element) => hTypeEquals(element, first))
    ? hArray(first)
    : hArray(hUnknown(false));
}

/** Whether `o` in `o.m(...)` is a module namespace (`import * as ns`, plan-notes 302) rather than a
 * value: its member is a binding, called without a receiver. */
function isNamespaceReceiver(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = ts.isIdentifier(receiver) ? checker.getSymbolAtLocation(receiver) : undefined;
  if (symbol === undefined) {
    return false;
  }
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (resolved.flags & ts.SymbolFlags.ValueModule) !== 0;
}

/** A call's arguments, lowered left to right: spread elements as expressions, generic arguments
 * as their specializations, everything else ordinarily. Shared by the ordinary call and
 * the receiver calls above, whose arguments are the same list. */
function lowerCallArguments(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression[] | null {
  const args: Expression[] = [];
  for (const argument of node.arguments) {
    if (ts.isSpreadElement(argument)) {
      const lowered = lowerExpression(argument, sourceFile, checker, bindings, diagnostics);
      if (lowered === null) {
        return null;
      }
      args.push(lowered);
      continue;
    }
    const specializedArg = specializedArgument(
      argument,
      node,
      sourceFile,
      checker,
      bindings,
      diagnostics,
    );
    if (specializedArg === null) {
      return null;
    }
    if (specializedArg !== undefined) {
      args.push(specializedArg);
      continue;
    }
    const lowered = lowerExpression(argument, sourceFile, checker, bindings, diagnostics);
    if (lowered === null) {
      return null;
    }
    args.push(lowered);
  }
  return args;
}

/** How V8 spells a non-function callee (verified against the pinned Node): a nameable
 * callee — identifier, property or element — by its source text (`x`, `o.m`, `fns[0]`);
 * a call by its inner callee plus `(...)` (`getX(...)`); anything else is
 * `(intermediate value)`. Parentheses and `!` are transparent, as they are nowhere at run
 * time. Exotic nestings (`(c ? f : g)()()` — V8 repeats the marker per layer) fall back to one
 * marker rather than three; the type (`TypeError`) is what programs observe. */
function notFunctionSubject(callee: ts.Expression, sourceFile: ts.SourceFile): string {
  let node = callee;
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  if (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return node.getText(sourceFile);
  }
  // A literal or keyword callee is named by its spelling (`"s"`, `` `t` ``, `5`, `true`, `null` —
  // verified against the pinned Node, quotes included).
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return node.getText(sourceFile);
  }
  if (ts.isCallExpression(node)) {
    return `${notFunctionSubject(node.expression, sourceFile)}(...)`;
  }
  return '(intermediate value)';
}

/** A call whose callee the HIR types as a concrete non-function (plan.md §8 step 37): js mode
 * suppresses the checker's TS2349, so `const x = 5; x()` reaches lowering, where the verifier's
 * STA4041 would report it as an internal error. The honest HIR is the dynamic answer: evaluate
 * the callee, evaluate the arguments left to right (each may run user code, and the spec runs
 * them before the callability check), then throw Node's catchable `TypeError` through the
 * existing `type-error` node. Sequencing is nested `,` — the same shape a source comma folds
 * to, so every pass already treats both sides as evaluated. The verifier's STA4041 stays as the
 * lowering invariant: mirroring its `fn`-or-Unknown rule here is what makes that code
 * unreachable rather than merely untested. */
function nonFunctionCall(
  node: ts.CallExpression,
  calleeNode: ts.Expression,
  callee: Expression,
  args: readonly Expression[],
  sourceFile: ts.SourceFile,
): Expression {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  let sequenced: Expression = {
    kind: 'type-error',
    type: hUnknown(false),
    span,
    message: `${notFunctionSubject(calleeNode, sourceFile)} is not a function`,
  };
  const parts = [callee, ...args];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }
    // The comma's type IS the right operand's: the verifier's comma rule demands equality with
    // it (not with the call's own type, whose implicit-any flag may differ), and every consumer
    // reads only the unknown kind.
    sequenced = {
      kind: 'binary-op',
      type: sequenced.type,
      span,
      operator: ',',
      left: part,
      right: sequenced,
    };
  }
  return sequenced;
}

/** Binds every function declared directly in `statements` before any of them is lowered.
 *
 * This is hoisting, and it is not optional: `f(); function f() {}` is legal and must resolve. The
 * emitter mirrors it by initialising the same bindings in the enclosing body's prologue.
 *
 * A declaration goes through `declare`, so a block-level `f` that shadows an outer `f` gets a name
 * of its own HERE, before any reference to it is lowered (plan.md §8 step 14). Two declarations of
 * one name in ONE list keep one home, which is the spec's last-one-wins. */
function hoistFunctionDeclarations(
  statements: readonly ts.Statement[],
  checker: ts.TypeChecker,
  bindings: Scope,
): void {
  for (const statement of statements) {
    if (!ts.isFunctionDeclaration(statement)) {
      continue;
    }
    const name = declaredBindingName(statement);
    if (name !== undefined) {
      hirNameOfDeclaration.set(
        statement,
        bindings.declare(name, typeAt(statement, checker, bindings)),
      );
    }
  }
}

/** Every `var` in `root` that belongs to this function/module, as hoisted `let`s.
 *
 * Nested functions are skipped: each one hoists its own vars when it is lowered. Names already
 * in `bindings` (a parameter, a function declaration) are the spec's "already instantiated"
 * case — the var shares that slot, so there is no second declaration and no `undefined` init.
 * The original site still becomes an assignment when it has an initializer. */
function hoistVarDeclarations(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement[] | null {
  const seen = new Set<string>();
  const hoisted: Statement[] = [];

  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) {
      return;
    }
    if (ts.isVariableDeclarationList(node) && isVarDeclarationList(node)) {
      for (const decl of node.declarations) {
        if (classFormation(decl, checker) !== undefined) continue;
        if (!ts.isIdentifier(decl.name)) {
          diagnostics.push(
            lowerDiagnostic(
              decl,
              sourceFile,
              'STA4032',
              'internal',
              'var binding is not an identifier',
            ),
          );
          return;
        }
        const name = decl.name.text;
        if (seen.has(name) || bindings.has(name)) {
          seen.add(name);
          continue;
        }
        seen.add(name);
        const type = typeAt(decl.name, checker, bindings);
        // A module's top-level `var` is a binding of the module unit like a `let` is: a spelling
        // another module declared too takes a fresh name (plan.md §11c T11.5a). Inside a
        // function the var keeps sharing what is visible, as before.
        let hir = name;
        if (root === sourceFile) {
          hir = bindings.declare(name, type);
        } else {
          bindings.set(name, type);
        }
        const span = makeSpan(decl.getStart(sourceFile), decl.getWidth(sourceFile), sourceFile);
        const stmt: Declaration = {
          kind: 'declaration',
          type,
          span,
          name: hir,
          declKind: 'let',
          value: { kind: 'undefined-literal', type: H_UNDEFINED, span },
        };
        hoisted.push(stmt);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return hoisted;
}

/** A `var` list at its original site: assignments for initializers, a no-op otherwise.
 *
 * The slot already exists — `hoistVarDeclarations` created it, or a parameter/function of the
 * same name already owns it. Multiple names in one statement become a block of assignments
 * because HIR Declaration is one name; `var a = 1, b = 2` is two writes, not two slots. */
function lowerVarList(
  list: ts.VariableDeclarationList,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  fail: (target: ts.Node, message: string) => null,
): Statement | null {
  const span = makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile);
  const parts: Statement[] = [];
  for (const decl of list.declarations) {
    if (!ts.isIdentifier(decl.name)) {
      return fail(decl, 'var binding is not an identifier');
    }
    const name = decl.name.text;
    if (!bindings.has(name)) {
      return fail(decl, `var '${name}' was not hoisted`);
    }
    if (decl.initializer === undefined) {
      continue;
    }
    const lowered = lowerExpression(decl.initializer, sourceFile, checker, bindings, diagnostics);
    if (!lowered) {
      return null;
    }
    const expected = bindings.get(name);
    // Step 17's rule, extended to `var`: `var f = () => ...` prints `[Function: f]`, exactly
    // as the `let`/`const` form does. The spelling is the declarator's own, so a repeated
    // `var f` that reuses the slot names it the same way.
    const named = withDisplayName(lowered, name);
    const value =
      expected === undefined ? named : maybeBoundary(named, expected, decl.initializer, sourceFile);
    parts.push({
      kind: 'assignment',
      type: value.type,
      span: makeSpan(decl.getStart(sourceFile), decl.getWidth(sourceFile), sourceFile),
      target: bindings.hirName(name),
      value,
    });
  }
  if (parts.length === 1) {
    const only = parts[0];
    return only === undefined ? { kind: 'block', type: H_UNDEFINED, span, statements: [] } : only;
  }
  return { kind: 'block', type: H_UNDEFINED, span, statements: parts };
}

/** The one lowering for all three function spellings.
 *
 * The body is lowered against a COPY of the enclosing bindings. Copying is sound only because the
 * gate rejects any reference to a binding local to an enclosing function (rung 4a has no
 * environment structs): what survives the copy is module-level, which the emitter roots for the
 * program's lifetime. Copying also stops a local of this function leaking back into the caller's
 * scope, which a shared map would do. */
function lowerImportCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const spec = node.arguments[0];
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const target =
    spec !== undefined && ts.isStringLiteral(spec)
      ? checker.getSymbolAtLocation(spec)?.valueDeclaration
      : undefined;
  const resultType = typeAt(node, checker, bindings);
  const nsType =
    resultType.kind === 'promise' && resultType.value.kind === 'object'
      ? resultType.value
      : resultType.kind === 'object'
        ? resultType
        : undefined;
  // `bindImports` built the namespace object of every literal `import()` target when this file
  // began, so the promise resolves to the SAME object `import * as ns` binds, as in Node.
  const object =
    target !== undefined && ts.isSourceFile(target) ? namespaceObjects.get(target) : undefined;
  const objectType = object === undefined ? undefined : bindings.get(object);
  if (nsType?.namespace !== true || object === undefined || objectType === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4031',
        'internal',
        `import('${spec !== undefined && ts.isStringLiteral(spec) ? spec.text : ''}') did not resolve to a module namespace`,
      ),
    );
    return null;
  }
  return {
    kind: 'promise-static',
    type: resultType.kind === 'promise' ? resultType : hPromise(nsType),
    span,
    method: 'resolve',
    arg: { kind: 'identifier', name: object, type: objectType, span },
  };
}

/** Every spelling `file` declares at its top level -- the names the entry claims (see
 * `Scope.claim`) so that it is a dependency's same-spelled binding that is renamed. */
function topLevelNames(file: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = declaredBindingName(statement);
      if (name !== undefined) {
        names.push(name);
      }
    } else if (ts.isExportAssignment(statement)) {
      names.push(DEFAULT_EXPORT_BINDING);
    }
  }
  return names;
}

/** The binding an exported name resolves to (plan.md §11c T11.5a): its HIR name and type in the
 * exporting module's own scope, or the namespace object of a whole module. `undefined` when the
 * name has no runtime binding this program lowered -- a type, an ambient extern declaration. */
function exportedBinding(
  target: ExportTarget | undefined,
  root: Scope,
): { readonly name: string; readonly type: HType } | undefined {
  if (target === undefined) {
    return undefined;
  }
  if (target.kind === 'namespace') {
    const name = namespaceObjects.get(target.file);
    const type = name === undefined ? undefined : root.get(name);
    return name === undefined || type === undefined ? undefined : { name, type };
  }
  const scope = moduleScopes.get(target.file);
  const type = scope?.get(target.name);
  return scope === undefined || type === undefined
    ? undefined
    : { name: scope.hirName(target.name), type };
}

/** Bind every import of `file` in its module scope, before its body hoists anything.
 *
 * A named, renamed or default import aliases the exporter's binding -- the same HIR name, so a
 * read is the export's live binding and a renamed import costs nothing. A namespace import, an
 * imported `export * as ns`, and a literal `import()` need the target's namespace OBJECT, which
 * is built here, once per module, into a hidden global of the root scope: the target's body has
 * already run (topological order), so every export it reads is initialized. Answers `false`
 * after reporting an internal error. */
function bindImports(
  file: ts.SourceFile,
  scope: Scope,
  root: Scope,
  statements: Statement[],
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): boolean {
  const fail = (node: ts.Node, message: string): false => {
    diagnostics.push(lowerDiagnostic(node, file, 'STA4031', 'internal', message));
    return false;
  };
  // Builds `module`'s namespace object (and, first, every nested one it holds) unless it exists.
  const ensureNamespace = (module: ts.SourceFile, at: ts.Node): boolean => {
    if (namespaceObjects.has(module)) {
      return true;
    }
    const moduleSymbol = checker.getSymbolAtLocation(module);
    const nsType =
      moduleSymbol === undefined
        ? undefined
        : frontendTypes.tsTypeToHType(checker.getTypeOfSymbolAtLocation(moduleSymbol, at), checker);
    // A module with no value exports has no namespace HType (`moduleNamespaceToHType`): nothing
    // can read a member of it, so it gets no object, and its importer's `ns` binds nothing.
    if (moduleSymbol === undefined || nsType?.kind !== 'object' || nsType.namespace !== true) {
      return true;
    }
    const entries: ObjectEntry[] = [];
    const span = makeSpan(at.getStart(file), at.getWidth(file), file);
    for (const field of nsType.fields) {
      const target = moduleExportTarget(module, field.name, checker);
      if (target?.kind === 'namespace' && !ensureNamespace(target.file, at)) {
        return false;
      }
      const binding = exportedBinding(target, root);
      if (binding === undefined) {
        return fail(at, `export '${field.name}' of '${module.fileName}' has no binding`);
      }
      entries.push({
        name: field.name,
        value: { kind: 'identifier', name: binding.name, type: binding.type, span },
      });
    }
    return declareNamespace(module, nsType, entries, at);
  };
  const declareNamespace = (
    module: ts.SourceFile,
    type: HObject,
    entries: readonly ObjectEntry[],
    at: ts.Node,
  ): true => {
    const name = `\u0000namespace:${module.fileName}`;
    const span = makeSpan(at.getStart(file), at.getWidth(file), file);
    root.set(name, type);
    namespaceObjects.set(module, name);
    statements.push({
      kind: 'declaration',
      type,
      span,
      name,
      declKind: 'const',
      value: { kind: 'object-literal', type, span, entries, methods: [], methodCopies: [] },
    });
    return true;
  };
  const bindName = (local: ts.Identifier): boolean => {
    const target = exportTarget(checker.getSymbolAtLocation(local), checker);
    if (target?.kind === 'namespace' && !ensureNamespace(target.file, local)) {
      return false;
    }
    // An extern declaration or a type binds nothing here: the call site resolves an extern by
    // its declaration (docs/FFI.md §1), and a type erases.
    const binding = exportedBinding(target, root);
    if (binding !== undefined) {
      scope.alias(local.text, binding.name, binding.type);
    }
    return true;
  };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) {
      continue;
    }
    if (clause.name !== undefined && !bindName(clause.name)) {
      return false;
    }
    const named = clause.namedBindings;
    if (named === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(named)) {
      if (!bindName(named.name)) {
        return false;
      }
      continue;
    }
    for (const element of named.elements) {
      if (!element.isTypeOnly && !bindName(element.name)) {
        return false;
      }
    }
  }
  return importCallTargets(file, checker).every((target) => ensureNamespace(target, file));
}

/** The modules a literal `import()` in `file` names, in source order. */
function importCallTargets(file: ts.SourceFile, checker: ts.TypeChecker): ts.SourceFile[] {
  const targets: ts.SourceFile[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const target = checker.getSymbolAtLocation(node.arguments[0])?.valueDeclaration;
      if (target !== undefined && ts.isSourceFile(target) && !target.isDeclarationFile) {
        targets.push(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return targets;
}

/** `export default <expression>`: the expression evaluated once into the module's hidden
 * `*default*` binding (ES §16.2.3.7), which a default import aliases. An anonymous function or
 * class takes the name `default`, as in Node. */
function lowerExportAssignment(
  node: ts.ExportAssignment,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null {
  const value = lowerExpression(node.expression, sourceFile, checker, bindings, diagnostics);
  if (value === null) {
    return null;
  }
  const name = bindings.declare(DEFAULT_EXPORT_BINDING, value.type);
  return {
    kind: 'declaration',
    type: value.type,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    name,
    declKind: 'const',
    value: withDisplayName(value, 'default'),
  };
}

/** `ns.x` where `ns` statically names a module namespace -- an import, an `import()` result in a
 * binding, a nested `ns.inner` -- resolved at compile time to the export's own binding: a live
 * read with no object in between (plan.md §11c T11.5a). `undefined` for anything else, including
 * a namespace computed by an expression with effects, which reads its object instead. */
function namespaceMemberRead(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
): Identifier | undefined {
  if (!ts.isPropertyAccessExpression(node) || !isStaticNamespacePath(node.expression, checker)) {
    return undefined;
  }
  const member = exportedBinding(
    exportTarget(checker.getSymbolAtLocation(node.name), checker),
    bindings,
  );
  return member === undefined
    ? undefined
    : {
        kind: 'identifier',
        type: member.type,
        span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
        name: member.name,
      };
}

/** A read of `field` off a lowered expression that IS a module's namespace object (the hidden
 * global `bindImports` built): the export's own binding, exactly as `namespaceMemberRead`
 * resolves the dot spelling. The object is a snapshot taken when the importer started, so a
 * destructuring (`const { x } = ns`) or a literal-keyed read (`ns[k]`, `k: "x"`) must not read it
 * when the binding behind it can still change. `undefined` for any other target. */
function namespaceObjectField(
  target: Expression,
  field: string,
  checker: ts.TypeChecker,
  bindings: Scope,
): { readonly name: string; readonly type: HType } | undefined {
  if (target.kind !== 'identifier') {
    return undefined;
  }
  for (const [module, name] of namespaceObjects) {
    if (name === target.name) {
      return exportedBinding(moduleExportTarget(module, field, checker), bindings);
    }
  }
  return undefined;
}

/** What `module` exports under `name`, through the checker's alias chain. */
function moduleExportTarget(
  module: ts.SourceFile,
  name: string,
  checker: ts.TypeChecker,
): ExportTarget | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(module);
  if (moduleSymbol === undefined) {
    return undefined;
  }
  return exportTarget(
    checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name),
    checker,
  );
}

function isStaticNamespacePath(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (namespaceModule(checker.getTypeAtLocation(node)) === undefined) {
    return false;
  }
  return (
    ts.isIdentifier(node) ||
    (ts.isPropertyAccessExpression(node) && isStaticNamespacePath(node.expression, checker))
  );
}

/** An explicit `this` parameter (`function f(this: Foo)`): the gate refuses it (STA1214), so
 * lowering never synthesizes a second receiver beside it. Asked here so a refused program cannot
 * reach the synthesized path and mask the gate's diagnostic with a duplicate parameter. */
function hasExplicitThisParam(node: FunctionLike): boolean {
  const [first] = node.parameters;
  return first !== undefined && ts.isIdentifier(first.name) && first.name.text === 'this';
}

/** Whether a plain function owns a `this` that needs binding: some `this` in its subtree whose
 * nearest non-arrow function is this node. Arrows pass the read through (they own nothing), so
 * the walk descends through them; any other nested function owns its subtree, so the walk prunes
 * it — a `this` in there resolves inward, never here. A `this` with no function owner at all
 * (module top level, or an arrow in a field initializer, whose owner is the class) is not ours.
 * Structural, never modal: in ts mode the gate already refused nothing here — the checker owns
 * that refusal (STA0012) — and the lowering supports the construct either way. */
function functionNeedsDynamicThis(node: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) {
      return;
    }
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      for (let c: ts.Node | undefined = n.parent; c !== undefined; c = c.parent) {
        if (ts.isArrowFunction(c)) {
          continue;
        }
        if (
          ts.isFunctionDeclaration(c) ||
          ts.isFunctionExpression(c) ||
          ts.isMethodDeclaration(c) ||
          ts.isConstructorDeclaration(c) ||
          ts.isGetAccessorDeclaration(c) ||
          ts.isSetAccessorDeclaration(c)
        ) {
          if (c === node) {
            found = true;
          }
          break;
        }
        if (
          ts.isSourceFile(c) ||
          ts.isClassDeclaration(c) ||
          ts.isClassExpression(c) ||
          ts.isPropertyDeclaration(c)
        ) {
          break;
        }
      }
      return;
    }
    // A nested non-arrow function owns its subtree (see above); an arrow does not, so only the
    // arrow case recurses. The node itself is the sought owner, never a reason to prune.
    if (
      n !== node &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isConstructorDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n))
    ) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function lowerFunction(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  // An HObject for a class member, whose receiver has a layout; Unknown for an object literal's
  // accessor, whose receiver is a JSRTDynObject and whose `this.x` is therefore a dynamic read.
  // Plain functions (declarations and expressions, never arrows) arrive without one: those that
  // need a dynamic `this` get an Unknown receiver below, decided structurally, never by mode.
  receiver?: HType,
): FunctionExpr | null {
  functionNesting++;
  try {
    // A function's own frame is a slot space of its own: names declared in it cannot collide with
    // the enclosing function's slots, so the unit's "already declared" set starts fresh here.
    const inner = bindings.functionScope();
    const params: Parameter[] = [];
    // A method's receiver is parameter zero under a name no source can spell. Everything downstream
    // -- arity padding, the closure ABI, capture analysis, the emitter -- then treats `this` as an
    // ordinary parameter, which is why methods needed no machinery of their own.
    //
    // A plain function that reads `this` gets the same parameter zero, typed Unknown: the call
    // site passes its receiver or nothing, and `jsrt_call` shifts a bare call's arguments so slot
    // zero reads `undefined` (docs/VALUE.md §4.16 `has_receiver` — reused, not reinvented; emitted
    // modules are always strict ESM, so `undefined` is the honest answer, never the sloppy
    // global). Only functions that need it pay for it: an unconditional receiver would make
    // `f(1, 2)` on `function f(a)` look like a receiver call (argc meets the shifted width) and
    // bind `this = 1, a = 2`. Arrows never own one — they capture the enclosing receiver through
    // the environment, which the capture analysis already records against plain functions.
    const isPlainFunction = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
    let effectiveReceiver = receiver;
    if (
      effectiveReceiver === undefined &&
      isPlainFunction &&
      !hasExplicitThisParam(node) &&
      functionNeedsDynamicThis(node)
    ) {
      effectiveReceiver = hUnknown(false);
    }
    if (effectiveReceiver !== undefined) {
      const at = makeSpan(node.getStart(sourceFile), 0, sourceFile);
      params.push({ name: RECEIVER, type: effectiveReceiver, span: at });
      inner.set(RECEIVER, effectiveReceiver);
    }
    const destructured: { name: ts.BindingName; tmp: string }[] = [];
    for (const param of node.parameters) {
      const type = typeAt(param, checker, bindings);
      let defaultExpr: Expression | undefined;
      if (param.initializer !== undefined) {
        const lowered = lowerExpression(param.initializer, sourceFile, checker, inner, diagnostics);
        if (lowered === null) {
          return null;
        }
        defaultExpr = lowered;
      }
      if (ts.isIdentifier(param.name)) {
        // A parameter is a declaration of the function's scope, and it shadows: a parameter named
        // after a module-level binding takes a name of its own, so the two cannot be confused for
        // one slot by anything downstream (plan.md §8 step 14).
        const hirName = inner.declare(param.name.text, type);
        hirNameOfDeclaration.set(param, hirName);
        params.push({
          name: hirName,
          type,
          span: makeSpan(param.getStart(sourceFile), param.getWidth(sourceFile), sourceFile),
          ...(param.dotDotDotToken !== undefined ? { rest: true as const } : {}),
          ...(defaultExpr !== undefined ? { default: defaultExpr } : {}),
        });
        continue;
      }
      const tmp = nextBindTemp();
      inner.set(tmp, type);
      params.push({
        name: tmp,
        type,
        span: makeSpan(param.getStart(sourceFile), param.getWidth(sourceFile), sourceFile),
        ...(defaultExpr !== undefined ? { default: defaultExpr } : {}),
      });
      destructured.push({ name: param.name, tmp });
      bindPatternNames(param.name, checker, inner);
    }

    const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
    const declared = typeAt(node, checker, bindings);
    // A plain function's TYPE never names its dynamic receiver: the checker's signature already
    // describes what callers pass (user arguments only), and the receiver is ABI, not arity —
    // exactly like a method VALUE's type, which names user parameters while its closure carries
    // `has_receiver`. Including Unknown in the type would shift every `checkCallArgs` boundary by
    // one (`f("s")` checked against Unknown instead of `number`). Methods keep the receiver in
    // the type: their calls pass it explicitly (`method-call`) or conditionally (`dyn-method-call`),
    // never through the plain-call boundary path.
    const type =
      effectiveReceiver === undefined || isPlainFunction
        ? declared
        : hFunction(
            params.map((p) => p.type),
            declared.kind === 'fn' ? declared.ret : H_UNDEFINED,
          );
    let selfBinding: string | undefined;
    if (ts.isFunctionExpression(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
      selfBinding = inner.declare(node.name.text, type);
      immutableSelfBindings.add(selfBinding);
      hirNameOfDeclaration.set(node.name, selfBinding);
    }
    // Unpack destructured parameters BEFORE the body: a rest binding's type is the source
    // layout minus the bound keys (the checker's `Omit` is not a layout), so the body must see
    // that type when it lowers, not the Unknown `typeAt` answers for the mapped type.
    const unpacked: Statement[] = [];
    for (const item of destructured) {
      const src: Identifier = {
        kind: 'identifier',
        type: inner.get(item.tmp) ?? hUnknown(false),
        span,
        name: item.tmp,
      };
      const parts = lowerBindingPattern(
        item.name,
        src,
        'let',
        item.name,
        sourceFile,
        checker,
        inner,
        diagnostics,
      );
      if (parts === null) {
        return null;
      }
      unpacked.push(...parts);
    }
    const body = lowerFunctionBody(node.body, sourceFile, checker, inner, diagnostics);
    if (body === null) {
      return null;
    }
    const bodyWithParams =
      unpacked.length === 0 ? body : { ...body, statements: [...unpacked, ...body.statements] };

    const info = capturesFor(sourceFile, checker).get(node);
    // Without a receiver the checker's own type is the answer. With one, the emitted function has a
    // parameter the source did not write, so the type has to describe what is actually called --
    // and for a constructor the checker has no function type to offer at all.
    const name = ts.isConstructorDeclaration(node)
      ? undefined
      : node.name !== undefined && ts.isIdentifier(node.name)
        ? node.name.text
        : undefined;
    const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    const isGenerator =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
        ? node.asteriskToken !== undefined
        : false;
    const constructible =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && !isAsync && !isGenerator;
    const fn: FunctionExpr = {
      kind: 'function',
      type,
      span,
      ...(name !== undefined && { name }),
      ...(selfBinding !== undefined && { selfBinding }),
      params,
      body: bodyWithParams,
      isAsync,
      isGenerator,
      ...(constructible && { constructible: true }),
      // The capture analysis resolved references by SYMBOL, so a name it reports is the one the
      // SOURCE wrote; the HIR may have renamed the declaration it points at. Both lists are
      // spelled in HIR names here, which is the only form the emitter's environment layout and
      // its `slotRef` lookup understand (plan.md §8 step 14).
      envVars: (info?.envVars ?? []).map((v, i) => hirNameOf(info?.envDecls[i]) ?? v),
      captures: (info?.captures ?? []).map((c) => ({
        name: hirNameOf(c.decl) ?? c.name,
        levels: c.levels,
        index: c.index,
      })),
      needsEnv: info?.needsEnv ?? false,
      provenance: provenanceOf(node, params, type),
    };
    return fn;
  } finally {
    functionNesting--;
  }
}

/** Where a function's signature types came from (docs/HIR.md, plan.md §8 step 1).
 *
 * The question is about the SIGNATURE only. A fully annotated function whose body holds an Unknown
 * is still `typed`: its callers see the signature, and the signature is what a boundary checks.
 *
 * Unknown is asked first because it outranks the other two -- an Unknown parameter is not an
 * un-annotated one the checker happened to solve, it is the request for a dynamic value, and no
 * amount of annotation elsewhere makes the call site static. */
function provenanceOf(node: FunctionLike, params: readonly Parameter[], type: HType): Provenance {
  const ret = type.kind === 'fn' ? type.ret : H_UNDEFINED;
  if (params.some((p) => hTypeHasUnknown(p.type)) || hTypeHasUnknown(ret)) {
    return 'dynamic';
  }
  return node.parameters.every(isAnnotated) && returnIsAnnotated(node) ? 'typed' : 'inferred';
}

/** An explicit type annotation, in either spelling. `x: number` and `@param {number} x` are the
 * same claim by the same author, which is the whole of js mode's JSDoc freebie: annotated
 * JavaScript buys exactly what annotated TypeScript does, and is trusted exactly as little at a
 * boundary. `node.parameters` is the SOURCE's list, so the synthesized receiver never reaches
 * here -- no author wrote it and its type comes from the class layout, not from a claim. */
function isAnnotated(param: ts.ParameterDeclaration): boolean {
  return param.type !== undefined || ts.getJSDocType(param) !== undefined;
}

/** A constructor's return is not writable in either spelling, so it cannot be the missing
 * annotation that demotes one to `inferred`. */
function returnIsAnnotated(node: FunctionLike): boolean {
  return (
    ts.isConstructorDeclaration(node) ||
    node.type !== undefined ||
    ts.getJSDocReturnType(node) !== undefined
  );
}

/** The substituted kind of a `T`-typed receiver, for the call dispatches that read the
 * checker's static `T` and match none of their families.
 *
 * The gate admitted the call against the constraint, and `typeAt` substitutes the call's
 * concrete type — so a family arm also matches the substituted kind, under which this is the
 * same node as a call on the concrete receiver. `undefined` for anything but a type parameter:
 * the common path pays one memoized checker hit and no mapping. */
function substitutedReceiverKind(
  obj: ts.Expression,
  checker: ts.TypeChecker,
  bindings: Scope,
): HType['kind'] | undefined {
  if ((checker.getTypeAtLocation(obj).flags & ts.TypeFlags.TypeParameter) === 0) {
    return undefined;
  }
  return typeAt(obj, checker, bindings).kind;
}

/** The tuple a generic class is instantiated at for this use: the reference's own arguments
 * where the use site has them (`b` with `b: Box<number>`), the heritage edge's where the use is
 * inherited (`s.get()` on `s: Sub` for `get` declared in `Box`, grounded in `Sub`'s context by
 * the same substitution the type model builds the subclass layout with), and the enclosing
 * specialization's substitution where the receiver's type is unbound (`this`, or a `T` the
 * caller is specializing). `undefined` when none names a complete tuple. */
function classTupleFor(
  declaration: ts.ClassDeclaration,
  receiverType: ts.Type,
  checker: ts.TypeChecker,
  bindings: Scope,
): HType[] | undefined {
  const parameters = declaration.typeParameters ?? [];
  if (parameters.length === 0) {
    return [];
  }
  const reference = classReferenceTuple(declaration, receiverType, checker);
  const leaf = classDeclarationOf(receiverType);
  const heritage =
    leaf === undefined || leaf === declaration
      ? undefined
      : frontendTypes.heritageTuple(declaration, leaf, checker);
  const lookup = (name: string): HType | undefined => bindings.get(typeParameterKey(name));
  const tuple: HType[] = [];
  for (let i = 0; i < parameters.length; i++) {
    const name = parameters[i]?.name.text;
    const argument = reference?.[i] ?? heritage?.[i];
    const fromReference = argument === undefined ? undefined : substituteHType(argument, lookup);
    const element = fromReference ?? (name === undefined ? undefined : lookup(name));
    if (element === undefined || hasTypeParam(element)) {
      return undefined;
    }
    tuple.push(element);
  }
  return tuple;
}

/** The descriptor name for an owner class: plain for an ordinary class, mangled with the
 * recovered tuple for a generic one. `null` when the class is generic and no tuple exists —
 * the internal-error backstop for a use the gate should have refused. */
function mangleClassName(
  owner: ts.ClassDeclaration | ts.ClassExpression,
  receiver: ts.Expression,
  checker: ts.TypeChecker,
  bindings: Scope | undefined,
): string | null {
  if (ts.isClassExpression(owner)) {
    // An expression class is reached through its HIR identity, recorded when the formation
    // lowered (plan.md §8 step 12(d)); its display name is only the fallback for a use the
    // formation does not precede. Generic expressions never reach here (the gate refuses
    // them), so there is no tuple to specialize.
    return hirNameOf(owner) ?? frontendTypes.expressionClassName(owner) ?? null;
  }
  const name = classDisplayName(owner);
  if (name === undefined || name === '') {
    return null;
  }
  if (owner.typeParameters === undefined || owner.typeParameters.length === 0) {
    // An ordinary (non-generic) class is reached through its binding, which a shadowing
    // declaration renames (plan.md §8 step 23); a generic one through its mangled tuple, whose
    // source name the gate keeps unique across the program where shadowing could confuse it
    // (module scope, or the nested-generic uniqueness rule).
    return hirClassName(owner);
  }
  if (bindings === undefined) {
    return null;
  }
  const tuple = classTupleFor(owner, checker.getTypeAtLocation(receiver), checker, bindings);
  return tuple === undefined ? null : specializationName(name, tuple);
}

/** The class-like a receiver's type resolves to for owner/dispatch questions: declarations
 * through the existing path, bound expressions through their descriptor identity
 * (plan.md §8 step 12(d)). A shadowed expression resolves to its HIR name downstream via
 * `mangleClassName`, exactly like a shadowed declaration. `undefined` for anything else —
 * the caller falls back to constraint, shape, or dynamic dispatch as before. */
function receiverClassLike(
  receiverType: ts.Type,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  const declaration = classDeclarationOf(receiverType);
  if (declaration !== undefined) {
    return declaration;
  }
  const like = frontendTypes.classLikeOf(receiverType);
  return like !== undefined &&
    ts.isClassExpression(like) &&
    frontendTypes.expressionClassName(like) !== undefined
    ? like
    : undefined;
}

/** Does this expression evaluate to an instance of a class this subset lays out?
 *
 * Asked of the checker's type rather than of a lowered node, because it decides WHICH lowering to
 * run -- and it must give the same answer `tsTypeToHType` will, since that is what produces the
 * HObject the slot is resolved against. */
function declaringClassName(
  receiver: ts.Expression,
  method: string,
  checker: ts.TypeChecker,
  bindings?: Scope,
  sourceFile?: ts.SourceFile,
): string | null {
  const receiverType = checker.getTypeAtLocation(receiver);
  // A `T`-typed receiver answers through its constraint: per specialization the call runs on
  // the bound class, so the owner comes from there.
  const declaration =
    receiverClassLike(receiverType) ?? constraintDeclaration(receiverType, checker);
  if (declaration !== undefined) {
    const owner = frontendTypes.methodDeclaringClass(declaration, method, checker);
    if (owner === undefined) {
      return null;
    }
    return mangleClassName(owner, receiver, checker, bindings);
  }
  const shape = frontendTypes.tsTypeToHType(receiverType, checker);
  if (shape.kind === 'object' && shape.methods.some((m) => m.name === method)) {
    return shape.name;
  }
  // A call through `T` bounded by something without a class: the substituted shape — the
  // concrete receiver per specialization — still names the layout whose descriptor must own
  // the method. The generic namesake is found by name: generic classes live at module scope
  // (the gate refuses nesting), where a name identifies one declaration.
  if (bindings !== undefined && sourceFile !== undefined) {
    const substituted = typeAt(receiver, checker, bindings);
    if (substituted.kind === 'object' && substituted.methods.some((m) => m.name === method)) {
      const namesake = genericNamesakeOf(substituted.name, sourceFile);
      if (namesake !== undefined) {
        return mangleClassName(namesake, receiver, checker, bindings);
      }
      return substituted.name;
    }
  }
  return null;
}

/* Overriding, and the two questions it raises.
 *
 * A method call is direct -- a named C function, no table, no load -- exactly while the method has
 * ONE implementation for every receiver that can reach the call site. That stops being true the
 * moment two classes in one chain declare the same name, and it stops being true for the whole
 * FAMILY, not just for the pair: a call through a base-typed reference may land on any descendant.
 * So the question is asked of the program, not of the call: does any chain that contains this
 * class declare this method twice? A `yes` makes every call to that name on that family virtual, which
 * is why a class that is never overridden keeps rung 6a's zero-cost direct call unchanged.
 *
 * Scanning per call site is quadratic in the program's classes and linear in its chains (the class
 * list itself is collected once per file). It is also exact, needs no plumbing through the
 * lowering, and a program with enough classes for that to matter has a much larger emitter cost
 * -- memoize the answers when a measurement says to. */
const classesInCache = new WeakMap<
  ts.SourceFile,
  readonly (ts.ClassDeclaration | ts.ClassExpression)[]
>();

function classesIn(
  sourceFile: ts.SourceFile,
): readonly (ts.ClassDeclaration | ts.ClassExpression)[] {
  const cached = classesInCache.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const found: (ts.ClassDeclaration | ts.ClassExpression)[] = [];
  const visit = (node: ts.Node): void => {
    // Declarations and bound expressions alike: an override family may span the spelling
    // boundary (`const C = class extends B { m() … }` overrides `B.m`), and the direct-vs-
    // virtual question is asked of the file, not of the spelling.
    if (
      ts.isClassDeclaration(node) ||
      (ts.isClassExpression(node) && frontendTypes.expressionClassName(node) !== undefined)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  classesInCache.set(sourceFile, found);
  return found;
}

function declaresMethod(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  checker: ts.TypeChecker,
): boolean {
  // A `#private` method never overrides: each class owns its spelling under a per-class name, and
  // every call to one resolves lexically to direct dispatch. Letting a re-declared `#m` count
  // here would make the whole family's calls virtual for a second implementation no call reaches.
  if (frontendTypes.isPrivateMemberName(name)) {
    return false;
  }
  // An accessor half declares under its mangled name (`get x`), which no method declaration can
  // carry -- so a mangled name asks about halves and a plain name keeps asking about methods,
  // and the two families never share an override question.
  const property = accessorProperty(name);
  return declaration.members.some((m) => {
    if (frontendTypes.isStaticMember(m) || m.name === undefined) {
      return false;
    }
    const declared = frontendTypes.instanceMethodName(m, checker);
    if (declared === undefined) {
      return false;
    }
    if (ts.isGetAccessorDeclaration(m)) {
      return accessorName('get', declared) === name;
    }
    if (ts.isSetAccessorDeclaration(m)) {
      return accessorName('set', declared) === name;
    }
    return property === undefined && ts.isMethodDeclaration(m) && declared === name;
  });
}

/** Is `method` declared twice in some chain that contains the class `name`?
 *
 * Asked of the whole PROGRAM, not of the calling file: a family may span modules (a base here, its
 * override in a dependent module), and a call through the base must dispatch virtually either way.
 * A class is matched by its HIR name, so two modules' same-spelled classes (plan.md §11c T11.5a)
 * and a nested class that shadows an outer one (plan.md §8 step 23) are separate families. A
 * declaration not lowered yet answers its source name, the name every reference to it carries
 * until then too. */
function isOverridden(name: string, method: string, checker: ts.TypeChecker): boolean {
  // A `#private` name never overrides (see `declaresMethod`): re-declaring one adds a per-class
  // slot, and every use resolves lexically, so no call is ever virtual on its account.
  if (frontendTypes.isPrivateMemberName(method)) {
    return false;
  }
  for (const file of programModules) {
    for (const declaration of classesIn(file)) {
      const chain = frontendTypes.ancestry(declaration, checker);
      if (!chain.some((c) => hirClassName(c) === name)) {
        continue;
      }
      if (chain.filter((c) => declaresMethod(c, method, checker)).length > 1) {
        return true;
      }
    }
  }
  return false;
}

/** An accessor property as an assignment place: the read calls `get <key>` (or is `undefined`
 * when the property has only a setter, which only the compound forms ever read), the write calls
 * `set <key>`. One helper for the dot and the literal-key spellings, which name the same place. */
function accessorPlace(
  owner: string,
  target: Expression,
  key: string,
  hasGet: boolean,
  placeType: HType,
  span: Span,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): { current: Expression; write: (value: Expression) => Statement } | null {
  const call = (kind: 'get' | 'set', args: readonly Expression[], type: HType): MethodCall | null =>
    accessorCall(kind, owner, target, key, args, type, span, at, sourceFile, checker, diagnostics);
  const current = hasGet
    ? call('get', [], placeType)
    : { kind: 'undefined-literal' as const, type: H_UNDEFINED, span };
  if (current === null) {
    return null;
  }
  const write = (value: Expression): Statement => {
    const set = call('set', [value], H_UNDEFINED);
    // `accessorCall` already reported; a null here would be the same miss the read survived.
    return { kind: 'expression-statement', type: H_UNDEFINED, span, expression: set ?? value };
  };
  return { current, write };
}

/** `o.x` and `o.x = v` on an accessor: a call to the member function the mangled name holds.
 *
 * Each half is its own slot and its own table entry (`get x`, `set x`), so an accessor override
 * dispatches exactly like a method override -- virtual where any chain containing the receiver's
 * class declares the half twice, direct where one body serves the whole family. `#private`
 * halves never virtualize (`isOverridden` excludes the mangled private spelling: each class's
 * pair is its own), and `super.x` never reaches here (the gate admits `super` only on an
 * inherited method), so no call needs super's skip-the-override rule. The slot is resolved
 * anyway, so that the node is a well-formed method call and the verifier's check on it
 * means the same thing it means everywhere else. */
function accessorCall(
  kind: 'get' | 'set',
  owner: string,
  target: Expression,
  property: string,
  args: readonly Expression[],
  type: HType,
  span: Span,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): MethodCall | null {
  const method = accessorName(kind, property);
  const objectType = target.type.kind === 'object' ? target.type : undefined;
  const slot =
    objectType === undefined ? -1 : objectType.methods.findIndex((m) => m.name === method);
  if (objectType === undefined || slot < 0) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4067',
        'internal',
        `method '${method}' has no slot in the layout of ${hTypeName(target.type)}`,
      ),
    );
    return null;
  }
  return {
    kind: 'method-call',
    type,
    span,
    target,
    className: owner,
    method,
    slot,
    dispatch: isOverridden(objectType.name, method, checker) ? 'virtual' : 'direct',
    args,
  };
}

/** `this.#v` / `this.#m` / `this.#x` on an instance: the lexically-resolved counterpart of
 * the public read arm above.
 *
 * The KIND comes from the lexical owner's declaration, not from the receiver's type: a field is
 * a slot load of the mangled name, an accessor a direct call to the mangled pair, and a method
 * a direct method value -- all under the owner's descriptor, which is the one that emitted them.
 * Dispatch is always direct: a private name never overrides, it re-declares, so there is exactly
 * one implementation per (owner, name). */
function lowerPrivateRead(
  priv: { owner: ts.ClassDeclaration | ts.ClassExpression; property: string },
  node: ts.PropertyAccessExpression,
  target: Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const raw = node.name.text;
  const ownerName = mangleClassName(priv.owner, node.expression, checker, bindings);
  if (ownerName === null) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4067',
        'internal',
        `private '${raw}' names no descriptor the lowering can reach`,
      ),
    );
    return null;
  }
  const member = privateOwnerMember(priv.owner, raw);
  if (member !== undefined && ts.isMethodDeclaration(member)) {
    if (target.type.kind !== 'object') {
      diagnostics.push(
        lowerDiagnostic(node, sourceFile, 'STA4049', 'internal', 'receiver is not an object'),
      );
      return null;
    }
    const slot = target.type.methods.findIndex((m) => m.name === priv.property);
    if (slot < 0) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4067',
          'internal',
          `method '${priv.property}' has no slot in the layout of ${hTypeName(target.type)}`,
        ),
      );
      return null;
    }
    const value: MethodValue = {
      kind: 'method-value',
      type: typeAt(node, checker, bindings),
      span,
      target,
      className: ownerName,
      method: priv.property,
      slot,
      dispatch: 'direct',
    };
    return value;
  }
  if (
    member !== undefined &&
    (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
  ) {
    return accessorCall(
      'get',
      ownerName,
      target,
      priv.property,
      [],
      typeAt(node, checker, bindings),
      span,
      node,
      sourceFile,
      checker,
      diagnostics,
    );
  }
  const slot = slotOf(target, priv.property, node, sourceFile, diagnostics);
  if (slot === null) {
    return null;
  }
  const access: FieldAccess = {
    kind: 'field-access',
    type: typeAt(node, checker, bindings),
    span,
    target,
    field: priv.property,
    slot,
  };
  return access;
}

/** `C.x` and `C.x = v` on a static accessor: a plain call to the mangled static binding.
 *
 * The instance `accessorCall` passes the receiver; a static has none, so the getter takes no
 * arguments and the setter takes the value. A missing half is the static twin of the instance
 * hole (STA4067 there): the gate accepted the access and the class emitted no function for it.
 * Dispatch is direct by construction -- statics are inherited by NAME (one binding, resolved
 * through `staticMemberOf`), never dispatched on a receiver, which is also why overriding one
 * stays refused at the gate. */
function staticAccessorCall(
  kind: 'get' | 'set',
  owner: string,
  property: string,
  args: readonly Expression[],
  type: HType,
  span: Span,
  at: ts.Node,
  sourceFile: ts.SourceFile,
  bindings: Scope,
  diagnostics: Diagnostic[],
): CallExpr | null {
  const name = staticName(owner, accessorName(kind, property));
  const fnType = bindings.get(name);
  if (fnType === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4066',
        'internal',
        `static '${name}' has no function the class emitted`,
      ),
    );
    return null;
  }
  const callee: Identifier = { kind: 'identifier', type: fnType, span, name };
  return { kind: 'call', type, span, callee, args };
}

/** Which halves of the static accessor `property` the class `owner` (and its bases) declare.
 *
 * The walk starts at the declaring class `staticMemberOf` resolved, because a static is one
 * binding reached by name: `D.value` on `class D extends C` runs `C`'s pair. Needed only for
 * the read half a compound fold builds -- a set-only static, like a set-only instance
 * property, has no read, which is legal. */
function staticAccessorHalves(
  owner: ts.ClassDeclaration | ts.ClassExpression,
  property: string,
  checker: ts.TypeChecker,
): { get: boolean; set: boolean } {
  let get = false;
  let set = false;
  const seen = new Set<ts.ClassDeclaration | ts.ClassExpression>();
  for (
    let current: ts.ClassDeclaration | ts.ClassExpression | undefined = owner;
    current !== undefined && !seen.has(current);
    current = frontendTypes.baseClassOf(current, checker)
  ) {
    seen.add(current);
    for (const member of current.members) {
      // A literal-typed computed accessor (`static get [k]` with `k: "m"`) declares the name
      // the direct spelling writes, so the halves are found under the resolved name; anything
      // wider declares no static name and keeps the old skip. A `#private` name declares its
      // own spelling too -- and only its own class's: an ancestor's pair is a different
      // property that shares the spelling, so the walk stops after the owner for one.
      const declared =
        !frontendTypes.isStaticMember(member) || member.name === undefined
          ? undefined
          : ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)
            ? member.name.text
            : ts.isComputedPropertyName(member.name)
              ? (frontendTypes.computedKeyStaticName(member.name, checker) ?? undefined)
              : undefined;
      if (declared !== property) {
        continue;
      }
      if (ts.isGetAccessorDeclaration(member)) {
        get = true;
      }
      if (ts.isSetAccessorDeclaration(member)) {
        set = true;
      }
    }
    if (property.startsWith('#')) {
      break;
    }
  }
  return { get, set };
}

/** The class that declares `property` as an accessor for this receiver, or `undefined`. */
function accessorOwner(
  receiver: ts.Expression,
  property: string,
  checker: ts.TypeChecker,
  bindings?: Scope,
  sourceFile?: ts.SourceFile,
): string | undefined {
  const found = declaringClassOfProperty(receiver, property, checker);
  if (found?.owner !== undefined && classDisplayName(found.owner) !== undefined) {
    return mangleClassName(found.owner, receiver, checker, bindings) ?? undefined;
  }
  // An accessor through `T` bounded by something without a class: same namesake rule as a
  // method call — the substituted shape names the layout whose descriptor owns the pair.
  if (bindings !== undefined && sourceFile !== undefined) {
    const substituted = typeAt(receiver, checker, bindings);
    const isAccessor =
      substituted.kind === 'object' &&
      substituted.methods.some(
        (m) => m.name === accessorName('get', property) || m.name === accessorName('set', property),
      );
    if (isAccessor) {
      const namesake = genericNamesakeOf(substituted.name, sourceFile);
      if (namesake !== undefined) {
        return mangleClassName(namesake, receiver, checker, bindings) ?? undefined;
      }
      return substituted.name;
    }
  }
  return undefined;
}

/** Does this receiver's accessor for `property` have the given half? A property may be read-only
 * or write-only, and each half is a separate member function. */
function hasAccessorHalf(
  receiver: ts.Expression,
  property: string,
  half: 'get' | 'set',
  checker: ts.TypeChecker,
  bindings?: Scope,
  sourceFile?: ts.SourceFile,
): boolean {
  const found = declaringClassOfProperty(receiver, property, checker);
  if (found !== undefined) {
    return found[half];
  }
  if (bindings !== undefined && sourceFile !== undefined) {
    const substituted = typeAt(receiver, checker, bindings);
    if (
      substituted.kind === 'object' &&
      substituted.methods.some((m) => m.name === accessorName(half, property))
    ) {
      return true;
    }
  }
  return false;
}

/** The source name a class member declares: a literal-typed computed key (`[k]` with
 * `k: "m"`) through the checker, anything else as written. The fallback is today's behavior on
 * exactly the spellings the gate still refuses, which keeps this total on programs the gate
 * never lets through. */
function declaredMemberName(
  member:
    | ts.PropertyDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string {
  return frontendTypes.instanceMethodName(member, checker) ?? member.name.getText(sourceFile);
}

/** Whether `member` declares the layout name `name`. The source-text comparison the slot
 * lookup used would miss a literal-typed computed key (`[k]` declaring `m`), so the checker
 * resolves those; the fallback is the same comparison as before. An instance `#private` member
 * declares its PER-CLASS name (`owner`), so the mangled spelling matches too. */
function memberDeclaresName(
  member: ts.ClassElement,
  name: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  owner?: string,
): boolean {
  if (member.name === undefined) {
    return false;
  }
  const declared =
    frontendTypes.instanceMethodName(member, checker) ?? member.name.getText(sourceFile);
  return (
    declared === name ||
    (owner !== undefined && frontendTypes.privateMethodName(owner, declared) === name)
  );
}

/** The name a member function goes under: its own for a method, the mangled one for an
 * accessor. A literal-typed computed key (`[k]` with `k: "m"`) resolves through the checker to
 * the name the direct spelling writes; anything wider never reaches here (the gate refused
 * it), so the source-text fallback below is dead on accepted programs but keeps this total.
 * An instance `#private` member additionally qualifies by its declaring class (`owner`), so a
 * re-declared name emits under the same per-class name the layout carries. */
function memberFunctionName(
  member: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  owner?: string,
): string {
  const method = frontendTypes.instanceMethodName(member, checker);
  const spelled = method ?? member.name.getText(sourceFile);
  const raw = ts.isGetAccessorDeclaration(member)
    ? accessorName('get', spelled)
    : ts.isSetAccessorDeclaration(member)
      ? accessorName('set', spelled)
      : spelled;
  return owner === undefined ? raw : frontendTypes.privateMethodName(owner, raw);
}

/** A read of the receiver parameter, which is what both `this` and the object of `super.m()` are.
 *
 * The gate admits either only where the lowering binds a receiver — a class member, an object
 * literal method/accessor, or a plain function reading its dynamic `this` — and every such
 * parameter list starts with that parameter, so there is nothing left for a `this` node in the
 * HIR to mean. */
function receiverIdentifier(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Identifier | null {
  const binding = bindings.get(RECEIVER);
  if (binding === undefined) {
    diagnostics.push(
      lowerDiagnostic(node, sourceFile, 'STA4061', 'internal', 'this with no receiver in scope'),
    );
    return null;
  }
  return {
    kind: 'identifier',
    type: binding,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    name: RECEIVER,
  };
}

function isClassInstance(node: ts.Expression, checker: ts.TypeChecker, bindings: Scope): boolean {
  // A class NAME is not an instance of itself, and the checker's type cannot say so: the type of
  // the expression `C` is the class's STATIC side, whose symbol is still the class declaration, so
  // `tsTypeToHType` answers with the very layout `new C()` produces. Only the spelling separates
  // them, which is why this asks the AST and not the type. A class ALIAS (`const K = C`) names
  // the same static side through its target declaration, so it takes the same exemption — as
  // does a class EXPRESSION's binding (`const C = class …`), whose static side maps to the
  // layout through the expression (plan.md §8 step 12(d)).
  if (
    ts.isIdentifier(node) &&
    (frontendTypes.aliasedClassDeclaration(node, checker) ??
      frontendTypes.classExpressionTarget(node, checker) ??
      frontendTypes.innerClassExpression(node, checker)) !== undefined
  ) {
    return false;
  }
  return typeAt(node, checker, bindings).kind === 'object';
}

/** An object layout with its member types substituted: same name, bases, and slot order —
 * only what each slot holds changes. Slot indices resolved anywhere else stay valid because
 * substitution never reorders, and assignability still reads the (unchanged) names. */
function substituteObject(type: HObject, substitution: ReadonlyMap<string, HType>): HObject {
  const lookup = (name: string): HType | undefined => substitution.get(name);
  return {
    ...type,
    fields: type.fields.map((field) => ({ ...field, type: substituteHType(field.type, lookup) })),
    methods: type.methods.map((method) => ({
      ...method,
      type: substituteHType(method.type, lookup),
    })),
  };
}

/** Lowers one class specialization: the generic's members a second time, with its type
 * parameters bound, under a mangled name — the class twin of `lowerSpecialization`.
 *
 * The carrier (`staticsOnly`) lowers with the enclosing bindings directly: statics never
 * mention a type parameter, so there is nothing to bind, and their bindings must land in the
 * enclosing scope where later statements read them. */
function lowerClassSpecialization(
  spec: ClassSpecialization,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): ClassDeclaration | Block | null {
  if (spec.staticsOnly) {
    return lowerClass(spec.declaration, sourceFile, checker, bindings, diagnostics, {
      name: spec.name,
      substitution: spec.substitution,
      staticsOnly: true,
    });
  }
  const inner = bindings.child();
  for (const [parameter, type] of spec.substitution) {
    inner.set(typeParameterKey(parameter), type);
  }
  return lowerClass(spec.declaration, sourceFile, checker, inner, diagnostics, {
    name: spec.name,
    substitution: spec.substitution,
    staticsOnly: false,
  });
}

/** A generic class declaration lowered at its own position: the statics-only carrier first,
 * then one specialization per collected tuple, in collection order.
 *
 * Shared by the module-scope statement loop and the nested arm of `lowerStatement`: static
 * initializers are runtime code, and their order against the surrounding statements is
 * observable wherever the declaration sits. The carrier binds in the ENCLOSING scope (not up
 * front): a static read before this position fails exactly as for an ordinary class. The
 * tuples were bound up front with everything else, so a construction before this position
 * still resolves. `null` when any lowering failed, with a diagnostic already pushed. */
function lowerGenericClassDeclaration(
  node: ts.ClassDeclaration,
  mine: readonly ClassSpecialization[],
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): (ClassDeclaration | Block)[] | null {
  const carrier: ClassSpecialization = {
    name: node.name?.text ?? '',
    declaration: node,
    substitution: new Map<string, HType>(),
    staticsOnly: true,
  };
  bindings.set(carrier.name, classSpecType(carrier, checker));
  const ordered = [carrier, ...mine.filter((item) => !item.staticsOnly)];
  const lowered: (ClassDeclaration | Block)[] = [];
  for (const spec of ordered) {
    const declaration = lowerClassSpecialization(spec, sourceFile, checker, bindings, diagnostics);
    if (declaration === null) {
      return null;
    }
    lowered.push(declaration);
  }
  return lowered;
}

/** The HType a class specialization is bound under: the declaration's layout with the tuple
 * applied. Nothing reads these bindings today — `new` and member access name descriptors by
 * string — but cross-file deduplication filters on their presence, and an honest type beats a
 * placeholder if anything ever does read one. */
function classSpecType(spec: ClassSpecialization, checker: ts.TypeChecker): HType {
  const symbol =
    spec.declaration.name === undefined
      ? undefined
      : checker.getSymbolAtLocation(spec.declaration.name);
  const self = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
  const type = self === undefined ? undefined : frontendTypes.tsTypeToHType(self, checker);
  if (type === undefined || type.kind !== 'object') {
    return hUnknown(false);
  }
  return substituteObject(type, spec.substitution);
}

/** `class C { … }`.
 *
 * Three things happen here and nowhere else. The field ORDER is fixed -- declaration order is slot
 * order, and `HObject.fields` was built from the same list, so the two agree by construction rather
 * than by coincidence. Each member becomes an ordinary function with the receiver prepended. And a
 * field INITIALIZER is moved into the constructor: `class C { n = 0 }` runs `this.n = 0` before the
 * constructor body, in declaration order, which is what the language specifies and what lets the
 * emitter have exactly one place that populates an object. A class with initializers but no
 * constructor gets an empty one to hold them. */
/** The stand-in for a bodiless `abstract` member: a function with the declaration's shape
 * (receiver parameter zero, mirrored parameter list) whose body throws Node's TypeError.
 *
 * The stub exists so the base class has a complete method table and direct-call target: a
 * virtual call always lands on the runtime class's entry (the concrete override), and a
 * direct call to an abstract method has no instantiable receiver in any checked program
 * (an abstract class is never constructed, a concrete subclass always overrides — both
 * checker-enforced), so the stub never runs. If it ever does — `super.m()` on an abstract
 * base included — a catchable TypeError is Node's answer too (`A.prototype.m` is
 * `undefined` there). Async and generator flags stay false: the throw transfers before any
 * promise or iterator could be built, exactly as a synchronous throw in a real body would.
 *
 * Parameters mirror the declaration (names, types, rest-ness) for arity's sake; defaults
 * are dropped, because a default that runs means the call reached a body that never runs.
 * Bindings are declared in a fresh function scope like `lowerFunction` does, so a verifier
 * that resolves parameter names the way it resolves any function's finds them. */
function abstractMemberStub(
  member: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  receiver: HType,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
): FunctionExpr {
  const span = makeSpan(member.getStart(sourceFile), member.getWidth(sourceFile), sourceFile);
  const inner = bindings.functionScope();
  const params: Parameter[] = [];
  params.push({
    name: RECEIVER,
    type: receiver,
    span: makeSpan(member.getStart(sourceFile), 0, sourceFile),
  });
  inner.set(RECEIVER, receiver);
  for (const param of member.parameters) {
    const type = typeAt(param, checker, bindings);
    const at = makeSpan(param.getStart(sourceFile), param.getWidth(sourceFile), sourceFile);
    if (ts.isIdentifier(param.name)) {
      const hirName = inner.declare(param.name.text, type);
      hirNameOfDeclaration.set(param, hirName);
      params.push({
        name: hirName,
        type,
        span: at,
        ...(param.dotDotDotToken !== undefined ? { rest: true as const } : {}),
      });
      continue;
    }
    const tmp = nextBindTemp();
    inner.set(tmp, type);
    params.push({
      name: tmp,
      type,
      span: at,
      ...(param.dotDotDotToken !== undefined ? { rest: true as const } : {}),
    });
  }
  const declared = typeAt(member, checker, bindings);
  const type = hFunction(
    params.map((p) => p.type),
    declared.kind === 'fn' ? declared.ret : H_UNDEFINED,
  );
  const display =
    member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : 'anonymous';
  const message: Expression = {
    kind: 'string-literal',
    type: H_STRING,
    span,
    value: `abstract method '${display}' has no implementation`,
  };
  const body: Block = {
    kind: 'block',
    type: H_UNDEFINED,
    span,
    statements: [
      {
        kind: 'throw-statement',
        type: H_UNDEFINED,
        span,
        value: {
          kind: 'error-new',
          type: errorHType('TypeError'),
          span,
          ctor: 'TypeError',
          arg: message,
        },
      },
    ],
  };
  const name =
    member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : undefined;
  return {
    kind: 'function',
    type,
    span,
    ...(name !== undefined && { name }),
    params,
    body,
    isAsync: false,
    isGenerator: false,
    envVars: [],
    captures: [],
    needsEnv: false,
    provenance: provenanceOf(member, params, type),
  };
}

function lowerClass(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  spec?: {
    readonly name: string;
    readonly substitution: ReadonlyMap<string, HType>;
    readonly staticsOnly: boolean;
  },
): ClassDeclaration | Block | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  // A class's identity is Node's `.name` for the spelling — the declared name, the inner
  // name or bound variable of an expression (see `expressionClassName`), or `default` for
  // the anonymous `export default class {}` — which doubles as the scope registration below
  // (shadowing renames exactly like a declaration's) and as the `#private` owner and
  // span-lookup name. The BINDING is `declaredBindingName` where one exists: `*default*` for
  // the anonymous default export, which is the name the module's export table looks up
  // (plan.md §11c T11.5a). Its instance type comes from the construct signature's return for
  // a spelling with no name node, and from the declared type otherwise.
  const displayName = classDisplayName(node);
  let self: ts.Type | undefined;
  if (displayName !== undefined) {
    if (ts.isClassExpression(node)) {
      // An expression's type is the constructor; the instance is its construct return.
      self = checker.getTypeAtLocation(node).getConstructSignatures()[0]?.getReturnType();
    } else if (node.name === undefined) {
      // The anonymous `export default class {}`: the declaration's own type IS the instance
      // type (the checker gives a named declaration's name symbol the same answer).
      self = checker.getTypeAtLocation(node);
    } else {
      const symbol = checker.getSymbolAtLocation(node.name);
      self = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
    }
  }
  const type = self === undefined ? undefined : frontendTypes.tsTypeToHType(self, checker);
  if (displayName === undefined || type === undefined || type.kind !== 'object') {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4062',
        'internal',
        'not a class instance the type model describes',
      ),
    );
    return null;
  }
  // A specialization lays out substituted member types under a mangled name; the carrier lays
  // out nothing at all (it owns statics only, which never mention a type parameter). Slot
  // ORDER is untouched either way, so field indices resolved anywhere else still land. The
  // receiver type carries the mangled name too: every use checks a receiver against it, so a
  // declared name here would fail the specialization's own methods. Bases stay declared —
  // ancestry is a property of declarations.
  //
  // An ordinary declaration is ALSO a binding of its scope, declared here before anything it
  // contains is lowered: a block that re-declares an outer class gets a HIR name of its own
  // instead of sharing the outer descriptor (plan.md §8 step 23). `declare` (not `set`) is what
  // makes shadowing rename. The binding is `declaredBindingName` where one exists (`*default*`
  // for the anonymous default export, which is what the module's export table looks up) and the
  // display name otherwise. Specializations skip this -- a generic class lives at module scope
  // by gate rule, so its source name is already unique, and the tuple lowerings share one
  // declaration node whose HIR name belongs to the carrier.
  if (spec === undefined) {
    const bindingName = ts.isClassDeclaration(node)
      ? (declaredBindingName(node) ?? displayName)
      : displayName;
    hirNameOfDeclaration.set(node, bindings.declare(bindingName, type));
  }
  // The HIR identity of this declaration: the mangled tuple for a specialization, the renamed
  // binding for a shadowing class, the source name otherwise. Every use site resolves to the
  // same string through `hirClassName`, which is what keeps `new`, method owners, statics,
  // `instanceof` and bases naming one descriptor.
  const selfName =
    spec !== undefined && !spec.staticsOnly ? spec.name : (hirNameOf(node) ?? displayName);
  // The layout answers under the HIR identity too: the verifier matches every member function's
  // receiver against the declaration's name, and every `super` against its bases, so a renamed
  // class whose layout still spelled the source name would fail its own checks. Each base name
  // resolves through its own declaration, which recorded its own HIR name at its own site --
  // the base is always lowered first, source order being what makes the descriptor's forward
  // reference to it legal.
  const renameBase = (name: string): string => {
    // Bases match by display name (Node's `.name`): the declared name, an expression's
    // inner name or variable, or `default` for the anonymous default export.
    const owner = frontendTypes
      .ancestry(node, checker)
      .find((candidate) => classDisplayName(candidate) === name);
    const renamed = owner === undefined ? undefined : hirNameOf(owner);
    return renamed ?? name;
  };
  const layout = (() => {
    if (spec !== undefined) {
      if (spec.staticsOnly) {
        return type;
      }
      const substituted = substituteObject(type, spec.substitution);
      return { ...substituted, name: spec.name };
    }
    return { ...type, name: selfName, bases: type.bases.map(renameBase) };
  })();

  // The slot list comes from the TYPE, not from a second walk of the members: HObject.fields is
  // what every FieldAccess slot was resolved against, so re-deriving the order here would be a
  // chance for the emitted descriptor to disagree with the indices written into it. A `.js` class
  // has fields with no member node at all, which is the case that makes this not merely tidier.
  const fields: Parameter[] =
    spec?.staticsOnly === true
      ? []
      : layout.fields.map((field) => {
          const at =
            node.members.find((m) =>
              memberDeclaresName(m, field.name, sourceFile, checker, displayName),
            ) ?? node;
          return {
            name: field.name,
            type: field.type,
            span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
          };
        });
  const initializers: ts.PropertyDeclaration[] = [];
  let ctorNode: ts.ConstructorDeclaration | undefined;
  // An accessor is a member function under a mangled name, so it joins the method list rather
  // than getting a list of its own -- which is what makes the table, dispatch and the receiver
  // parameter apply to it unchanged. A STATIC accessor is the same pair without a receiver: two
  // plain functions under mangled static bindings, emitted with the other statics.
  const methodNodes: (
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
  )[] = [];
  const staticAccessors: (ts.GetAccessorDeclaration | ts.SetAccessorDeclaration)[] = [];
  const staticNodes: (ts.PropertyDeclaration | ts.MethodDeclaration)[] = [];
  // Bodiless `abstract` members declare but never run: the subclass implementation carries the
  // behavior, while the declaration still needs a table entry and a direct-call target in THIS
  // class (plan.md §8 step 12(d)). They collect here and lower to throw-stubs beside the real
  // methods below — reachable in no checked program (an abstract class is never constructed,
  // a concrete subclass always overrides), so the stub's only job is to exist with the right
  // shape and throw Node's TypeError if it ever runs.
  const abstractStubs: (
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
  )[] = [];
  // Static initialization blocks run at class-definition time. They lower after the declaration
  // (which initializes every static) into the same scope, so a block observes exactly the
  // bindings the class statement established.
  const staticBlocks: ts.ClassStaticBlockDeclaration[] = [];
  // Static FIELD initializers execute in source order relative to the blocks (plan.md §8 step
  // 12(d)): the run before the first block initializes with the class, each later run assigns
  // after its block. Static METHODS stay hoisted with the class — defining one runs nothing,
  // so their forward references keep working exactly as they do today. Runs past the first
  // hold the fields whose declaration below carries `undefined` and whose assignment the tail
  // emits after its block.
  const staticFieldRuns: ts.PropertyDeclaration[][] = [];
  {
    let run: ts.PropertyDeclaration[] = [];
    for (const member of node.members) {
      if (ts.isClassStaticBlockDeclaration(member)) {
        staticFieldRuns.push(run);
        run = [];
      } else if (ts.isPropertyDeclaration(member) && frontendTypes.isStaticMember(member)) {
        run.push(member);
      }
    }
    staticFieldRuns.push(run);
  }
  const firstRunFields = new Set<ts.PropertyDeclaration>(staticFieldRuns[0] ?? []);
  for (const member of node.members) {
    // An `abstract` member without a body is a declaration only: it joins neither the static
    // lists (a `static abstract` is a checker error the gate never lets through, so reaching
    // here one is already refused) nor the method lists below — the stub loop emits it.
    if (
      (ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      member.body === undefined &&
      frontendTypes.hasAbstractModifier(member)
    ) {
      abstractStubs.push(member);
      continue;
    }
    // A static belongs to the class object, not to the layout: it is neither a slot nor a member
    // function, so it leaves both lists before either is built.
    if (
      frontendTypes.isStaticMember(member) &&
      (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
    ) {
      staticAccessors.push(member);
    } else if (
      frontendTypes.isStaticMember(member) &&
      (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member))
    ) {
      staticNodes.push(member);
    } else if (ts.isPropertyDeclaration(member)) {
      if (member.initializer !== undefined) {
        initializers.push(member);
      }
    } else if (ts.isConstructorDeclaration(member)) {
      // An overload signature is a declaration without a body; the implementation (vetted by the
      // gate to exist) is what runs.
      if (member.body !== undefined) {
        ctorNode = member;
      }
    } else if (ts.isClassStaticBlockDeclaration(member)) {
      staticBlocks.push(member);
    } else if (
      (ts.isMethodDeclaration(member) && member.body !== undefined) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      methodNodes.push(member);
    }
  }

  // Statics are lowered BEFORE the members, and their bindings are registered in the enclosing
  // scope: a static method's body may read another static (`C.count`), and so may an instance
  // method's, so the names have to exist by the time any body is lowered.
  //
  // Every name is registered BEFORE any value is lowered, for the reason function declarations are
  // hoisted: one static method may call another written below it, and a forward reference is legal
  // source that must not reach an internal error.
  //
  // A tuple specialization emits no statics at all: they are type-parameter-free, so the
  // carrier owns them and every tuple would otherwise define one binding twice. Clearing the
  // lists (rather than guarding each loop below) keeps the four static loops — pre-registration
  // and lowering, fields and accessors — byte-identical for everyone else. The carrier runs
  // before every tuple at the declaration site, so a tuple's method bodies still read bound
  // statics.
  // A tuple specialization emits no statics at all: they are type-parameter-free, so the
  // carrier owns them and every tuple would otherwise define one binding twice. Clearing the
  // lists (rather than guarding each loop below) keeps the four static loops — pre-registration
  // and lowering, fields and accessors — byte-identical for everyone else. The carrier runs
  // before every tuple at the declaration site, so a tuple's method bodies still read bound
  // statics.
  const statics: Declaration[] = [];
  if (spec !== undefined && !spec.staticsOnly) {
    staticNodes.length = 0;
    staticAccessors.length = 0;
  }
  if (spec?.staticsOnly === true) {
    // The carrier owns statics only: no layout, no members, no constructor — anything else
    // would lower a type parameter no substitution binds, and none of it can run (the class
    // is never constructed under its own name).
    methodNodes.length = 0;
    abstractStubs.length = 0;
    staticBlocks.length = 0;
  }
  for (const member of staticNodes) {
    bindings.set(
      staticName(selfName, declaredMemberName(member, sourceFile, checker)),
      typeAt(member, checker, bindings),
    );
  }
  // The mangled names the static accessors' getter/setter functions are emitted under. Registered
  // with the other statics so a body -- static or instance -- may read them. The placeholder is a
  // function kind, not the property type `typeAt` answers for an accessor: a use lowered before
  // the accessor's own emission must still see something callable, and the emission overwrites it
  // with the real signature below. A setter's placeholder already takes the property type: a
  // static method body lowering before the emission (static methods lower first below) captures
  // the placeholder into its call nodes, and the verifier holds those against the final
  // signature -- which takes exactly the property type, the setter's one parameter.
  for (const member of staticAccessors) {
    const half = ts.isGetAccessorDeclaration(member) ? 'get' : 'set';
    bindings.set(
      staticName(selfName, accessorName(half, declaredMemberName(member, sourceFile, checker))),
      half === 'get'
        ? hFunction([], H_UNDEFINED)
        : hFunction([typeAt(member, checker, bindings)], H_UNDEFINED),
    );
  }
  for (const member of staticNodes) {
    // A static overload signature declares nothing to emit; the implementation runs.
    if (ts.isMethodDeclaration(member) && member.body === undefined) {
      continue;
    }
    const name = staticName(selfName, declaredMemberName(member, sourceFile, checker));
    const at = makeSpan(member.getStart(sourceFile), member.getWidth(sourceFile), sourceFile);
    let value: Expression | null;
    if (ts.isMethodDeclaration(member)) {
      // No receiver: a static method is an ordinary function that happens to be written inside a
      // class. `this` inside one is refused at the gate, which is what makes that true.
      value = lowerFunction(member, sourceFile, checker, bindings, diagnostics);
    } else if (member.initializer === undefined || !firstRunFields.has(member)) {
      // A declared-but-uninitialized static reads `undefined`, exactly as a field slot does —
      // and so does a field whose run sits past a static block: its slot is `undefined` until
      // the tail's assignment after its block runs (plan.md §8 step 12(d)).
      value = { kind: 'undefined-literal', type: H_UNDEFINED, span: at };
    } else {
      value = lowerExpression(member.initializer, sourceFile, checker, bindings, diagnostics);
    }
    if (value === null) {
      return null;
    }
    const declared = ts.isMethodDeclaration(member)
      ? value.type
      : typeAt(member, checker, bindings);
    statics.push({
      kind: 'declaration',
      type: declared,
      span: at,
      name,
      // `const`: a static method is a function that cannot be reassigned. A static FIELD can be
      // (`C.count++`), which is what makes the two differ here and nowhere else.
      declKind: ts.isMethodDeclaration(member) ? 'const' : 'let',
      value,
    });
    bindings.set(name, declared);
  }
  // A static accessor is an ordinary function pair that happens to be written inside a class --
  // no receiver, `const` like a static method, under the mangled static name. The function type
  // mirrors an instance accessor's (`lowerFunction` with a receiver): the return lives on the
  // CALL node the read lowers to, not on the function, so the signature carries `undefined` here
  // exactly as it does there.
  for (const member of staticAccessors) {
    const half = ts.isGetAccessorDeclaration(member) ? 'get' : 'set';
    const name = staticName(
      selfName,
      accessorName(half, declaredMemberName(member, sourceFile, checker)),
    );
    const at = makeSpan(member.getStart(sourceFile), member.getWidth(sourceFile), sourceFile);
    const value = lowerFunction(member, sourceFile, checker, bindings, diagnostics);
    if (value === null) {
      return null;
    }
    const fnType = hFunction(
      value.params.map((p) => p.type),
      H_UNDEFINED,
    );
    statics.push({
      kind: 'declaration',
      type: fnType,
      span: at,
      name,
      declKind: 'const',
      // The type AND its grade mirror an instance accessor's: `lowerFunction` graded the
      // property type, not the function, so the grade is recomputed against the signature the
      // same way the receiver path builds it.
      value: { ...value, type: fnType, provenance: provenanceOf(member, value.params, fnType) },
    });
    bindings.set(name, fnType);
  }

  const methods: ClassMethod[] = [];
  for (const method of methodNodes) {
    const fn = lowerFunction(method, sourceFile, checker, bindings, diagnostics, layout);
    if (fn === null) {
      return null;
    }
    methods.push({ name: memberFunctionName(method, sourceFile, checker, displayName), fn });
  }
  for (const member of abstractStubs) {
    methods.push({
      name: memberFunctionName(member, sourceFile, checker, displayName),
      fn: abstractMemberStub(member, layout, sourceFile, checker, bindings),
    });
  }

  // A derived class always needs a constructor even with nothing of its own to do, because the
  // BASE's has to run. That is JavaScript's implicit `constructor(...args) { super(...args) }`,
  // and it is why `base !== undefined` joins the two reasons a constructor was needed before.
  // The base is named by its own HIR identity for the same reason the class itself is: a
  // shadowing block may have renamed it, and the descriptor reference must follow. A generic
  // base names its tuple's specialization instead (`Box<number>`): the descriptor that owns
  // the inherited members and runs the base constructor IS the specialization, and the carrier
  // owns statics only. The gate grounded exactly one complete tuple here; anything else is a
  // gate/lowering disagreement, refused rather than emitted against the carrier.
  const baseDecl = frontendTypes.baseClassOf(node, checker);
  let baseTuple: HType[] | undefined;
  if (baseDecl !== undefined && isGenericClass(baseDecl) && spec === undefined) {
    const tuple = frontendTypes.heritageTuple(baseDecl, node, checker);
    if (tuple === undefined || tuple.some(hasTypeParam)) {
      diagnostics.push(
        lowerDiagnostic(
          node,
          sourceFile,
          'STA4062',
          'internal',
          'a generic base with no complete tuple reached the lowering',
        ),
      );
      return null;
    }
    baseTuple = tuple;
  }
  const base =
    baseDecl === undefined
      ? undefined
      : baseTuple !== undefined
        ? specializationName(baseDecl.name?.text ?? '', baseTuple)
        : spec === undefined
          ? hirClassName(baseDecl)
          : baseDecl.name?.text;
  let ctor: ClassMethod | undefined;
  // The carrier builds no constructor: it is never constructed, and its body would lower a
  // type parameter no substitution binds.
  if (
    (ctorNode !== undefined || initializers.length > 0 || base !== undefined) &&
    spec?.staticsOnly !== true
  ) {
    // A field-initializer arrow reads the constructor's receiver through the class's capture
    // entry (see `enclosingThisOwner`): an explicit constructor already carries it in its own
    // environment, and a synthesized one is built with it here.
    const receiverNeeded =
      capturesFor(sourceFile, checker).get(node)?.envVars.includes(RECEIVER) ?? false;
    const fn =
      ctorNode === undefined
        ? synthesizedConstructor(node, sourceFile, checker, layout, base, receiverNeeded)
        : lowerFunction(ctorNode, sourceFile, checker, bindings, diagnostics, layout);
    if (fn === null) {
      return null;
    }
    const prologue = lowerFieldInitializers(
      initializers,
      layout,
      sourceFile,
      checker,
      bindings,
      diagnostics,
      displayName,
    );
    if (prologue === null) {
      return null;
    }
    // Field initializers run AFTER `super(...)`, never before it: an initializer may read a field
    // the base constructor wrote (`doubled = this.sides * 2`), and in JavaScript `this` does not
    // even exist until super returns. The gate proved the call is a top-level statement whenever
    // initializers exist, so "after it" is the statement after it, wherever it stands; a class
    // whose supers sit in `if`/`else` arms has no initializers by the same rule, and the empty
    // prologue splices nowhere.
    const statements = fn.body.statements;
    const superIndex = statements.findIndex((s) => s.kind === 'super-call');
    const afterSuper = superIndex >= 0 ? superIndex + 1 : 0;
    ctor = {
      name: 'constructor',
      fn: {
        ...fn,
        body: {
          ...fn.body,
          statements: [
            ...statements.slice(0, afterSuper),
            ...prologue,
            ...statements.slice(afterSuper),
          ],
        },
      },
    };
  }

  // A table only where a PUBLIC method is overridden. Its entries are file-scope constants,
  // so a class whose methods capture could not have one -- which is why the gate refuses
  // overriding for a class that is not at module scope, and why the empty table here is a real
  // answer rather than a missing one. `#private` methods never join it: each class owns its
  // spelling under a per-class name and every call to one is direct (see `declaresMethod`).
  //
  // An entry names the descriptor that implements it: the mangled specialization when the most
  // derived declaration is the generic being specialized, the tuple's specialization when the
  // implementer is a generic BASE (`Box<number>` owns the inherited method `Sub` overrides),
  // the plain name otherwise. Overriding is asked of the DECLARED name: ancestry is
  // declaration-level, and the mangled name appears in no chain. The carrier has no
  // methods to tabulate.
  // A table for every class with public methods -- not only overridden families. Virtual
  // dispatch needs it only where a method is overridden (the old `some(isOverridden)` gate),
  // but dynamic dispatch through Unknown needs it everywhere: `o.m` where `o` is Unknown
  // holding a class instance resolves the NAME at run time, and without the table the read
  // missed to `undefined` (plan.md §8 step 45). The order is still the layout's method order,
  // so virtual slots resolved against the static type keep indexing the right entry on every
  // descendant; an always-emitted table is a superset of the old conditional one, never a
  // reordering. `#private` methods never join it (lexical dispatch, see `declaresMethod`).
  // Capturing methods join by NAME with a NULL entry at emission (no one constant form);
  // the dynamic get skips NULLs for the hidden slot. The carrier has no methods to tabulate.
  const declaredName = displayName;
  const vtableMethods = layout.methods.filter((m) => !frontendTypes.isPrivateMemberName(m.name));
  const vtable =
    spec?.staticsOnly === true
      ? []
      : vtableMethods.map((m) => {
          const declaringDecl = frontendTypes.methodDeclaringClass(node, m.name, checker);
          const declaring =
            declaringDecl === undefined
              ? layout.name
              : declaringDecl.typeParameters !== undefined &&
                  declaringDecl.typeParameters.length > 0 &&
                  ts.isClassDeclaration(declaringDecl)
                ? frontendTypes.baseDescriptorName(declaringDecl, node, checker)
                : (hirNameOf(declaringDecl) ?? declaringDecl.name?.text ?? layout.name);
          return {
            name: m.name,
            className:
              spec !== undefined && !spec.staticsOnly && declaring === declaredName
                ? spec.name
                : declaring,
          };
        });

  const classDecl: ClassDeclaration = {
    kind: 'class-declaration',
    type: H_UNDEFINED,
    span,
    name: selfName,
    ...(base !== undefined && { base }),
    fields,
    ...(ctor !== undefined && { ctor }),
    methods,
    statics,
    staticProps: [],
    vtable,
  };

  if (staticBlocks.length === 0) {
    return classDecl;
  }
  // Static initialization blocks run where the class declaration sits, after every static
  // initialized -- which is the textual order the gate enforced (no static field follows a
  // block). Each body lowers in a child scope, so a block's locals never leak; the flattened
  // wrapper keeps the declaration and its blocks one statement in source order, and every pass
  // sees the ordinary statements it already knows.
  const statements: Statement[] = [classDecl];
  for (const [index, block] of staticBlocks.entries()) {
    const lowered = lowerBlock(block.body, sourceFile, checker, bindings.child(), diagnostics);
    if (lowered === null) {
      return null;
    }
    statements.push(lowered);
    // The field run after this block: each initialized field assigns its source-order value
    // now, into the `undefined` slot the declaration carried (plan.md §8 step 12(d)). Same
    // shape as the declaration's own value — no boundary, exactly as if it had initialized
    // with the class — only later. Uninitialized fields need nothing: `undefined` is already
    // what they are.
    for (const field of staticFieldRuns[index + 1] ?? []) {
      if (field.initializer === undefined) {
        continue;
      }
      const value = lowerExpression(field.initializer, sourceFile, checker, bindings, diagnostics);
      if (value === null) {
        return null;
      }
      statements.push({
        kind: 'assignment',
        type: typeAt(field, checker, bindings),
        span: makeSpan(field.getStart(sourceFile), field.getWidth(sourceFile), sourceFile),
        target: staticName(selfName, declaredMemberName(field, sourceFile, checker)),
        value,
      });
    }
  }
  return {
    kind: 'block',
    type: H_UNDEFINED,
    span,
    flatten: true,
    statements,
  };
}

/** `super(a, b)` -> the base constructor run against this constructor's receiver.
 *
 * Everything this needs is already in scope: the receiver is a parameter, and its HObject carries
 * the ancestor names. Nothing is threaded down from `lowerClass`, so the rule "a super call is the
 * base constructor applied to my own receiver" is stated once, here. */
function lowerSuperCall(
  call: ts.CallExpression,
  statement: ts.ExpressionStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Statement | null {
  const span = makeSpan(statement.getStart(sourceFile), statement.getWidth(sourceFile), sourceFile);
  const self = bindings.get(RECEIVER);
  const base = self !== undefined && self.kind === 'object' ? self.bases[0] : undefined;
  if (self === undefined || self.kind !== 'object' || base === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        statement,
        sourceFile,
        'STA4064',
        'internal',
        'super call outside a derived constructor',
      ),
    );
    return null;
  }
  const args = lowerArguments(call.arguments, sourceFile, checker, bindings, diagnostics, call);
  if (args === null) {
    return null;
  }
  const superCall: SuperCall = {
    kind: 'super-call',
    type: H_UNDEFINED,
    span,
    className: base,
    receiver: { kind: 'identifier', type: self, span, name: RECEIVER },
    args,
  };
  return superCall;
}

/** `this.x = <init>` for each initialized field, in declaration order.
 *
 * These run against a scope holding only the receiver: a field initializer may not see the
 * constructor's parameters, which is why they are lowered here rather than inside the constructor's
 * own bindings. */
function lowerFieldInitializers(
  members: readonly ts.PropertyDeclaration[],
  self: HObject,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  owner: string,
): Statement[] | null {
  const inner = bindings.child();
  inner.set(RECEIVER, self);
  const statements: Statement[] = [];
  for (const member of members) {
    if (member.initializer === undefined) {
      continue;
    }
    const span = makeSpan(member.getStart(sourceFile), member.getWidth(sourceFile), sourceFile);
    // An instance `#private` field initializes its PER-CLASS slot (`#x@A`, never `#x`), the same
    // name every read and write of it resolves to.
    const declared = declaredMemberName(member, sourceFile, checker);
    const field = frontendTypes.privateMethodName(owner, declared);
    const slot = fieldSlot(self, field);
    const value = lowerExpression(member.initializer, sourceFile, checker, inner, diagnostics);
    if (slot === undefined || value === null) {
      if (slot === undefined) {
        diagnostics.push(
          lowerDiagnostic(
            member,
            sourceFile,
            'STA4060',
            'internal',
            `no field '${field}' on ${self.name}`,
          ),
        );
      }
      return null;
    }
    statements.push({
      kind: 'field-assignment',
      type: value.type,
      span,
      target: { kind: 'identifier', type: self, span, name: RECEIVER },
      field,
      slot,
      value,
    });
  }
  return statements;
}

/** The constructor a class that writes none gets. Built rather than lowered because there is no
 * declaration to lower.
 *
 * At the root of a chain it is `constructor() {}` -- the receiver in, nothing done, the field
 * initializers the caller prepends being the whole point. In a derived class it is JavaScript's
 * implicit `constructor(...args) { super(...args) }`, so it takes the parameters it forwards. It
 * takes the NEAREST DECLARED ancestor constructor's, since an ancestor that writes none forwards
 * in exactly the same way; that keeps the synthesized arity equal to the arity every caller and
 * the checker already agree on.
 *
 * `withReceiver` holds the receiver in the heap environment rather than the frame: a field
 * initializer behind an arrow reads it as a capture (plan.md §8 step 25), and the arrows the
 * caller prepends resolve that capture against this environment. */
function synthesizedConstructor(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  self: HObject,
  base: string | undefined,
  withReceiver: boolean,
): FunctionExpr {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const forwarded =
    base === undefined
      ? []
      : (nearestConstructor(node, checker)?.parameters ?? []).map((p, index) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : `_arg${index}`,
          type: frontendTypes.tsTypeToHType(checker.getTypeAtLocation(p), checker),
          span,
        }));
  const receiver: Identifier = { kind: 'identifier', type: self, span, name: RECEIVER };
  const statements: Statement[] =
    base === undefined
      ? []
      : [
          {
            kind: 'super-call',
            type: H_UNDEFINED,
            span,
            className: base,
            receiver,
            args: forwarded.map((p) => ({
              kind: 'identifier' as const,
              type: p.type,
              span,
              name: p.name,
            })),
          },
        ];
  return {
    kind: 'function',
    type: hFunction([self, ...forwarded.map((p) => p.type)], H_UNDEFINED),
    span,
    params: [{ name: RECEIVER, type: self, span }, ...forwarded],
    body: { kind: 'block', type: H_UNDEFINED, span, statements },
    isAsync: false,
    isGenerator: false,
    envVars: withReceiver ? [RECEIVER] : [],
    captures: [],
    needsEnv: false,
    // Nothing here was written, so nothing here was inferred either: every type was copied from a
    // declaration that already had one, and the synthesized constructor is exactly as typed as the
    // ancestor whose parameters it forwards.
    provenance: forwarded.some((p) => hTypeHasUnknown(p.type)) ? 'dynamic' : 'typed',
  };
}

/** The nearest constructor actually written in a class's ancestry, or `undefined` if none is. */
function nearestConstructor(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): ts.ConstructorDeclaration | undefined {
  for (const current of frontendTypes.ancestry(declaration, checker).toReversed()) {
    // The implementation, not an overload signature: only a body has parameters to forward.
    const ctor = current.members.find(
      (m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined,
    );
    if (ctor !== undefined) {
      return ctor;
    }
  }
  return undefined;
}

/* Capture analysis is a whole-file question, so it runs once per source file rather than once per
 * function. Cached on the file itself: `lowerFunction` already receives both the file and the
 * checker, so nothing has to be threaded through the twenty lowering functions between them. */
const captureCache = new WeakMap<ts.SourceFile, CaptureMap>();

function capturesFor(sourceFile: ts.SourceFile, checker: ts.TypeChecker): CaptureMap {
  const cached = captureCache.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const computed = analyzeCaptures(sourceFile, checker);
  captureCache.set(sourceFile, computed);
  return computed;
}

/** An arrow's expression body is a return in disguise; giving it one here means the HIR has a
 * single body shape and neither the verifier nor the emitter has to know arrows exist. */
function lowerFunctionBody(
  body: ts.Block | ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Block | null {
  if (body === undefined) {
    return null;
  }
  if (ts.isBlock(body)) {
    // ONE scope for the two hoists and the block: functions first, then `var`, so a `var x` that
    // shares a name with a function declaration does not reinitialize it -- and `lowerBlock`'s own
    // hoist lands in this same scope, where re-declaring a name keeps its home instead of renaming
    // it (see the note on `lowerBlock`).
    const bodyScope = bindings.child();
    hoistFunctionDeclarations(body.statements, checker, bodyScope);
    const hoistedVars = hoistVarDeclarations(body, sourceFile, checker, bodyScope, diagnostics);
    if (hoistedVars === null) {
      return null;
    }
    const lowered = lowerBlock(body, sourceFile, checker, bodyScope, diagnostics);
    if (lowered === null) {
      return null;
    }
    if (hoistedVars.length === 0) {
      return lowered;
    }
    return { ...lowered, statements: [...hoistedVars, ...lowered.statements] };
  }
  const lowered = lowerExpression(body, sourceFile, checker, bindings, diagnostics);
  if (lowered === null) {
    return null;
  }
  // The return edge, for an arrow whose return a TypeScript file annotated (`returnBoundary`).
  const value =
    ts.isArrowFunction(body.parent) && hasTypeScriptAnnotation(body.parent)
      ? returnBoundary(lowered, body, sourceFile, checker)
      : lowered;
  const span = makeSpan(body.getStart(sourceFile), body.getWidth(sourceFile), sourceFile);
  return {
    kind: 'block',
    type: H_UNDEFINED,
    span,
    statements: [{ kind: 'return-statement', type: H_UNDEFINED, span, value }],
  };
}

function makeSpan(start: number, width: number, sourceFile: ts.SourceFile): Span {
  const { file, line } = remapPosition(start, sourceFile); // 1-indexed
  return {
    start,
    length: width,
    line,
    // The file, per span rather than per module: a merged program's statements come from many
    // files, and a #line directive naming the wrong one would point every debugger at it.
    file,
  };
}

/** The no-op block an empty statement, a type-only declaration, or a bodiless overload
 * signature lowers to. */
function emptyBlockAt(at: ts.Node, sourceFile: ts.SourceFile): Block {
  return {
    kind: 'block',
    type: H_UNDEFINED,
    span: makeSpan(at.getStart(sourceFile), at.getWidth(sourceFile), sourceFile),
    statements: [],
  };
}

/** Compound and logical assignment operators on an expression, if any. Shared by the two
 * assignment paths that must recognize the same operator set. */
function assignOperatorKinds(expr: ts.Expression): {
  compound: BinaryOperator | undefined;
  logical: LogicalOp['operator'] | undefined;
} {
  const compound =
    ts.isBinaryExpression(expr) && expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      ? COMPOUND_OPERATORS.get(expr.operatorToken.kind)
      : undefined;
  const logical = ts.isBinaryExpression(expr)
    ? LOGICAL_ASSIGN_OPERATORS.get(expr.operatorToken.kind)
    : undefined;
  return { compound, logical };
}

/** Type arguments with the enclosing specialization's substitution applied. Every
 * `request*` collector maps through the same substitution before enqueueing. */
function substitutedTypeArguments(
  typeArguments: readonly HType[],
  substitution: ReadonlyMap<string, HType>,
): HType[] {
  return typeArguments.map((t) => substituteHType(t, (name) => substitution.get(name)));
}

/** The generic class whose name matches a substituted object shape, if any. Shared by the
 * method-call and accessor nameake rules. */
function genericNamesakeOf(
  shapeName: string,
  sourceFile: ts.SourceFile,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  return classesIn(sourceFile).find(
    (candidate) => candidate.name?.text === shapeName && isGenericClass(candidate),
  );
}

/** The class declaration that owns `property` as an accessor on this receiver, or `undefined`.
 * Shared by `accessorOwner` and `hasAccessorHalf`. */
function declaringClassOfProperty(
  receiver: ts.Expression,
  property: string,
  checker: ts.TypeChecker,
): { owner: ts.ClassDeclaration | ts.ClassExpression; get: boolean; set: boolean } | undefined {
  const receiverType = checker.getTypeAtLocation(receiver);
  const declaration =
    receiverClassLike(receiverType) ?? constraintDeclaration(receiverType, checker);
  return declaration === undefined
    ? undefined
    : accessorDeclaringClass(declaration, property, checker);
}

/** The `method-call` node both the private-field and named-method paths build after resolving
 * a slot. One constructor so span, type and argument checking cannot drift. */
function methodCallAtSlot(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  target: Expression,
  className: string,
  method: string,
  slot: number,
  dispatch: 'direct' | 'virtual',
  args: Expression[],
): MethodCall {
  const methods = target.type.kind === 'object' ? target.type.methods : [];
  return {
    kind: 'method-call',
    type: typeAt(node, checker, bindings),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    target,
    className,
    method,
    slot,
    dispatch,
    args: checkCallArgs(methods[slot]?.type, args, node, sourceFile, checker),
  };
}

/** The STA4067 a resolved class name with no slot in the receiver layout produces. Always
 * answers `null` so a call site can `return missingMethodSlot(...)`. */
function missingMethodSlot(
  at: ts.Node,
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
  method: string,
  target: Expression,
): null {
  diagnostics.push(
    lowerDiagnostic(
      at,
      sourceFile,
      'STA4067',
      'internal',
      `method '${method}' has no slot in the layout of ${hTypeName(target.type)}`,
    ),
  );
  return null;
}

/** One function to emit: a generic declaration — or a generic arrow or function expression
 * under its variable's name — plus the tuple it is being built for.
 *
 * The tuple is CONCRETE by construction — `collectSpecializations` refuses to enqueue one that is
 * not — which is what makes the mangled name a complete identity: two calls agree on a
 * specialization exactly when they agree on the tuple, so `box(1)` and `box(2)` share one function
 * and `box('a')` gets its own. */
interface Specialization {
  readonly name: string;
  /** The printable name: the declared name, or the variable for an arrow/expression. */
  readonly key: string;
  readonly declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
  readonly substitution: ReadonlyMap<string, HType>;
}

/** How deep a chain of instantiations may go before the compiler stops rather than hangs.
 *
 * `function deeper<T>(x: T): void { deeper([x]); }` instantiates `deeper<T[]>`, then
 * `deeper<T[][]>`, forever: each instantiation is a new tuple, so nothing ever repeats and no
 * dedupe can end it. This is the halting problem in miniature and the answer is a cap, not
 * cleverness — 16 is far past any real generic and small enough that the refusal is instant. */
const MAX_INSTANTIATION_DEPTH = 16;

function isGenericDeclaration(node: ts.FunctionDeclaration): boolean {
  return node.typeParameters !== undefined && node.typeParameters.length > 0;
}

/** Every specialization the file needs, in an order where a caller follows what it calls.
 *
 * The walk is a worklist over TUPLES, not over declarations: the seeds are the generic calls in
 * ordinary code, where every tuple is concrete already, and processing one specialization looks
 * inside the body it is about to emit for further generic calls — whose tuples may mention the type
 * parameters this specialization is substituting, and are made concrete by doing exactly that.
 *
 * `null` means a diagnostic was pushed and the file cannot be lowered. */
/** One class to emit: a generic declaration plus the tuple it is being built for, or the
 * statics-only carrier (`staticsOnly`) that owns a used class's statics when no tuple does.
 *
 * Specializations never emit statics and the carrier never emits anything else: exactly one
 * place per class ever emits statics, so two tuples cannot define one binding twice. */
interface ClassSpecialization {
  readonly name: string;
  readonly declaration: ts.ClassDeclaration;
  readonly substitution: ReadonlyMap<string, HType>;
  readonly staticsOnly: boolean;
}

function isGenericClass(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
  return node.typeParameters !== undefined && node.typeParameters.length > 0;
}

function collectSpecializations(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): { readonly functions: Specialization[]; readonly classes: ClassSpecialization[] } | null {
  const emitted = new Map<string, Specialization>();
  const classesEmitted = new Map<string, ClassSpecialization>();
  const queue: {
    readonly specialization: Specialization | ClassSpecialization;
    readonly depth: number;
  }[] = [];
  let failed = false;

  /** Queues one specialization — function or class — from an already-recovered tuple.
   *
   * The three walks (calls, constructions, generic arguments) differ only in how they recover
   * `(key, declaration, tuple, map)`; everything after — the leftover-parameter canary, the
   * depth cap, the dedupe, the queue — is one function so the three cannot drift. `subject`
   * names the site in the canary message.
   *
   * The substitution scoped is the FULL recovery map, not just the tuple: nested class
   * parameters the reference walk grounded (`T` inside a `Box<number>` argument) surface in
   * bodies where no tuple element names them. The tuple wins for the declaration's own
   * parameters. */
  const enqueueSpecialization = (
    at: ts.Node,
    subject: 'call' | 'construction' | 'argument' | 'value',
    key: string,
    declaration:
      | ts.FunctionDeclaration
      | ts.FunctionExpression
      | ts.ArrowFunction
      | ts.ClassDeclaration,
    typeArguments: HType[],
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    if (typeArguments.some(hasTypeParam)) {
      // Unreachable for a well-formed program: the enclosing specialization substitutes every type
      // parameter in scope, so a leftover means the two walks disagree about which are in scope.
      diagnostics.push(
        lowerDiagnostic(
          at,
          sourceFile,
          'STA4070',
          'internal',
          `generic ${subject} still mentions a type parameter after substitution: ${typeArguments.map(hTypeName).join(', ')}`,
        ),
      );
      failed = true;
      return;
    }
    const name = ts.isClassDeclaration(declaration)
      ? specializationName(key, typeArguments)
      : functionSpecializationName(declaration, key, typeArguments);
    if (ts.isClassDeclaration(declaration) ? classesEmitted.has(name) : emitted.has(name)) {
      return;
    }
    if (depth > MAX_INSTANTIATION_DEPTH) {
      diagnostics.push(
        lowerDiagnostic(
          at,
          sourceFile,
          'STA2003',
          'error',
          `generic instantiation is more than ${String(MAX_INSTANTIATION_DEPTH)} deep at '${name}'; it does not terminate`,
        ),
      );
      failed = true;
      return;
    }
    const parameters = declaration.typeParameters ?? [];
    const substitutionFor = new Map<string, HType>(substitution);
    parameters.forEach((parameter, index) => {
      const argument = typeArguments[index];
      if (argument !== undefined) {
        substitutionFor.set(parameter.name.text, argument);
      }
    });
    const specialization: Specialization | ClassSpecialization = ts.isClassDeclaration(declaration)
      ? { name, declaration, substitution: substitutionFor, staticsOnly: false }
      : { name, key, declaration, substitution: substitutionFor };
    if (ts.isClassDeclaration(declaration)) {
      classesEmitted.set(name, specialization as ClassSpecialization);
    } else {
      emitted.set(name, specialization as Specialization);
    }
    queue.push({ specialization, depth });
  };

  /** Records one call's instantiation, with `substitution` — the enclosing specialization's, empty
   * at the top level — applied to the tuple the checker inferred. */
  const request = (
    call: ts.CallExpression,
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    // The blessed slot constructor is generic in spelling only: it lowers to a zero-handle,
    // never to a closure, so no specialization exists to collect. Without this skip the
    // collector would try to lower an ambient body that does not exist and fail silently.
    if (outSlotDeclarationOf(call, checker) !== undefined) {
      return;
    }
    const instantiation = genericCallInstantiation(call, checker);
    if (instantiation.kind !== 'generic') {
      return;
    }
    const typeArguments = substitutedTypeArguments(instantiation.typeArguments, substitution);
    enqueueSpecialization(
      call,
      'call',
      instantiation.key,
      instantiation.declaration,
      typeArguments,
      instantiation.substitution,
      depth,
    );
  };

  /** Records one construction's instantiation, with the enclosing substitution applied. */
  const requestClass = (
    created: ts.NewExpression,
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    const instantiation = genericNewInstantiation(created, checker);
    if (instantiation.kind !== 'generic') {
      return;
    }
    const typeArguments = substitutedTypeArguments(instantiation.typeArguments, substitution);
    enqueueSpecialization(
      created,
      'construction',
      instantiation.declaration.name?.text ?? '',
      instantiation.declaration,
      typeArguments,
      instantiation.substitution,
      depth,
    );
  };

  /** Records one generic argument's instantiation: `run(box, 1)` specializes `box` at the
   * parameter's function type, with the enclosing substitution applied. */
  const requestArgument = (
    argument: ts.Expression,
    outerCall: ts.CallExpression,
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    const instantiation = genericArgumentTuple(argument, outerCall, checker);
    if (instantiation === undefined) {
      return;
    }
    const typeArguments = substitutedTypeArguments(instantiation.typeArguments, substitution);
    enqueueSpecialization(
      argument,
      'argument',
      instantiation.key,
      instantiation.declaration,
      typeArguments,
      instantiation.substitution,
      depth,
    );
  };

  /** Records one generic read as a value: `console.log(box)`, `take(box)`, a rest
   * argument — anywhere the gate accepts the read but no parameter type determines a
   * tuple. The canonical tuple (defaults, else `Unknown`) is what an undetermined call
   * takes too, so the two share one specialization. Skips what the static argument path
   * owns, and anything that is not a named generic at all. */
  const requestValue = (
    argument: ts.Expression,
    outerCall: ts.CallExpression,
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    if (!ts.isIdentifier(argument)) {
      return;
    }
    if (genericArgumentTuple(argument, outerCall, checker) !== undefined) {
      return;
    }
    const value = genericValueInstantiation(argument, checker);
    if (value === undefined) {
      return;
    }
    const typeArguments = substitutedTypeArguments(value.typeArguments, substitution);
    enqueueSpecialization(
      argument,
      'value',
      value.key,
      value.declaration,
      typeArguments,
      value.substitution,
      depth,
    );
  };

  /** Every call and construction in `root`, skipping the bodies of generic declarations — those
   * are reached through the worklist instead, once there is a tuple to read them under. */
  const walkCalls = (
    root: ts.Node,
    substitution: ReadonlyMap<string, HType>,
    depth: number,
  ): void => {
    const visit = (node: ts.Node): void => {
      if (
        node !== root &&
        ((ts.isFunctionDeclaration(node) && isGenericDeclaration(node)) ||
          (ts.isClassDeclaration(node) && isGenericClass(node)) ||
          ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
            node.typeParameters !== undefined &&
            node.typeParameters.length > 0))
      ) {
        // A generic arrow's body is reached through the worklist once a call names a tuple —
        // lowering it here would build the parameters with nothing bound. (Whether the arrow
        // is assigned, and so collectible at all, is the gate's question, not this walk's.)
        return;
      }
      if (ts.isCallExpression(node)) {
        request(node, substitution, depth);
        // A generic passed as an argument specializes at the parameter's function type, in the
        // same pass: spread elements have no single parameter to read. What no parameter
        // determines takes the canonical value tuple instead, in the same pass for the same
        // reason — the lowering must have a specialization for every read the gate accepted.
        for (const argument of node.arguments) {
          if (!ts.isSpreadElement(argument)) {
            requestArgument(argument, node, substitution, depth);
            requestValue(argument, node, substitution, depth);
          }
        }
      }
      if (ts.isNewExpression(node)) {
        requestClass(node, substitution, depth);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && isGenericDeclaration(statement)) {
      continue;
    }
    if (ts.isClassDeclaration(statement) && isGenericClass(statement)) {
      continue;
    }
    walkCalls(statement, new Map(), 1);
  }
  // A subclass of a generic base needs the base's tuple descriptor even when nothing constructs
  // the base directly: `new Sub()` runs `Box<number>`'s constructor and reads its methods, but
  // no `new Box<number>` appears to seed it. One specialization per heritage edge whose tuple is
  // already complete, queued like any construction so the worklist still reaches indefinitely
  // deeper nests. Incomplete tuples (a generic subclass, a raw bound) belong to refused programs
  // — the gate holds them — so they seed nothing here.
  for (const declaration of classesIn(sourceFile)) {
    if (declaration.name === undefined) {
      continue;
    }
    const base = frontendTypes.baseClassOf(declaration, checker);
    // A generic expression base belongs to a refused program (the gate holds generic class
    // expressions); the specialization queue below only knows declarations, so it seeds
    // nothing here rather than misshaping the tuple.
    if (
      base === undefined ||
      !ts.isClassDeclaration(base) ||
      base.name === undefined ||
      !isGenericClass(base)
    ) {
      continue;
    }
    const tuple = frontendTypes.heritageTuple(base, declaration, checker);
    if (tuple === undefined || tuple.some(hasTypeParam)) {
      continue;
    }
    const substitution =
      frontendTypes.heritageSubstitution(declaration, checker).get(base) ?? new Map();
    enqueueSpecialization(
      declaration,
      'construction',
      base.name.text,
      base,
      tuple,
      substitution,
      1,
    );
  }
  // A plain index rather than `shift()`: the queue only grows, and the order it grows in is the
  // order the specializations are emitted in, which keeps the output stable across runs.
  // `failed` is set inside `walkCalls`, which this loop calls, so the read here is not stale.
  // oxlint-disable-next-line no-unmodified-loop-condition
  for (let i = 0; i < queue.length && !failed; i++) {
    const item = queue[i];
    if (item === undefined) {
      continue;
    }
    walkCalls(item.specialization.declaration, item.specialization.substitution, item.depth + 1);
  }
  if (failed) {
    return null;
  }
  return { functions: [...emitted.values()], classes: [...classesEmitted.values()] };
}

/** The function specialization `instantiation` names once the enclosing substitution in
 * `bindings` is applied: its HIR name and the type collection registered for it. Recomputed from
 * the inputs `collectSpecializations` used, so a miss means the two disagree about `at` (STA4070,
 * naming the `what` it was looked up for), and the identifier reads it at `spanned`. */
function collectedSpecialization(
  instantiation: {
    readonly declaration: ts.Node;
    readonly key: string;
    readonly typeArguments: readonly HType[];
  },
  at: ts.Node,
  what: string,
  sourceFile: ts.SourceFile,
  bindings: Scope,
  diagnostics: Diagnostic[],
  spanned: ts.Node = at,
): Identifier | null {
  const typeArguments = instantiation.typeArguments.map((t) =>
    substituteHType(t, (name) => bindings.get(typeParameterKey(name))),
  );
  const name = functionSpecializationName(
    instantiation.declaration,
    instantiation.key,
    typeArguments,
  );
  const type = bindings.get(name);
  if (type === undefined) {
    diagnostics.push(
      lowerDiagnostic(
        at,
        sourceFile,
        'STA4070',
        'internal',
        `no specialization '${name}' was collected for this ${what}`,
      ),
    );
    return null;
  }
  const span = makeSpan(spanned.getStart(sourceFile), spanned.getWidth(sourceFile), sourceFile);
  return { kind: 'identifier', type, span, name };
}

/** The identifier naming the specialization this call resolves to.
 *
 * `undefined` means the call is not to a generic and the ordinary path applies; `null` means it is
 * and something went wrong, with a diagnostic already pushed. The mangled name is recomputed here
 * from the same inputs `collectSpecializations` used — the call and the enclosing substitution — so
 * the two cannot name different functions without disagreeing about the call itself. */
function specializedCallee(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Identifier | null | undefined {
  const instantiation = genericCallInstantiation(node, checker);
  if (instantiation.kind !== 'generic') {
    return undefined;
  }
  return collectedSpecialization(
    instantiation,
    node,
    'call',
    sourceFile,
    bindings,
    diagnostics,
    node.expression,
  );
}

/** The class name the construction resolves to: the specialization's mangled name.
 *
 * `undefined` means the construction is not of a generic class and the ordinary path applies;
 * `null` means it is and something went wrong, with a diagnostic already pushed. The name is
 * recomputed here from the same inputs collection used, so the two cannot disagree. */
function specializedClassName(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): string | null | undefined {
  const instantiation = genericNewInstantiation(node, checker);
  if (instantiation.kind !== 'generic') {
    return undefined;
  }
  const typeArguments = instantiation.typeArguments.map((t) =>
    substituteHType(t, (name) => bindings.get(typeParameterKey(name))),
  );
  if (typeArguments.some(hasTypeParam)) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4070',
        'internal',
        `generic construction still mentions a type parameter after substitution: ${typeArguments.map(hTypeName).join(', ')}`,
      ),
    );
    return null;
  }
  const name = specializationName(instantiation.declaration.name?.text ?? '', typeArguments);
  if (!bindings.has(name)) {
    diagnostics.push(
      lowerDiagnostic(
        node,
        sourceFile,
        'STA4070',
        'internal',
        `no specialization '${name}' was collected for this construction`,
      ),
    );
    return null;
  }
  return name;
}

/** The identifier naming the specialization a generic argument resolves to.
 *
 * Mirrors `specializedCallee` for argument position: `undefined` means the argument is not a
 * passable generic (or not positional/determinable) and the ordinary path applies; `null`
 * means it is and something went wrong, with a diagnostic already pushed. */
function specializedArgument(
  argument: ts.Expression,
  outerCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Identifier | null | undefined {
  const instantiation = genericArgumentTuple(argument, outerCall, checker);
  if (instantiation === undefined) {
    return undefined;
  }
  return collectedSpecialization(
    instantiation,
    argument,
    'argument',
    sourceFile,
    bindings,
    diagnostics,
  );
}

/** The identifier naming the specialization a generic read as a value resolves to.
 *
 * Mirrors `specializedArgument` for the positions no parameter type determines:
 * `console.log(box)`, `take(box)`, a rest argument. `undefined` means the read is not a
 * generic value-use and the ordinary path applies; `null` means it is and something went
 * wrong, with a diagnostic already pushed. Reads the canonical tuple (defaults, else
 * `Unknown`) the collection enqueued beside the static ones, so the value shares its
 * specialization with an undetermined call. */
function canonicalValueReference(
  node: ts.Identifier,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Identifier | null | undefined {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || parent.expression === node) {
    return undefined;
  }
  if (genericArgumentTuple(node, parent, checker) !== undefined) {
    // The static argument path owns this read: every argument-lowering caller rewrites it
    // before the identifier branch runs, so reaching here means the two disagree — fall
    // through to the ordinary read rather than mask the gap with a second answer.
    return undefined;
  }
  const value = genericValueInstantiation(node, checker);
  if (value === undefined) {
    return undefined;
  }
  return collectedSpecialization(value, node, 'value', sourceFile, bindings, diagnostics);
}

/** The specialization's own function type: the generic's signature with the substitution applied. */
function specializationType(specialization: Specialization, checker: ts.TypeChecker): HType {
  const declared = frontendTypes.tsTypeToHType(
    checker.getTypeAtLocation(specialization.declaration),
    checker,
  );
  return substituteHType(declared, (name) => specialization.substitution.get(name));
}

/** Lowers the generic's body a second time, with its type parameters bound.
 *
 * This is the whole of monomorphization: no HIR is cloned and no type is rewritten after the fact,
 * because `typeAt` reads the substitution out of the binding map at the one point a `ts.Type`
 * becomes an HType. The emitted function keeps the SOURCE's name for printing (`[Function: box]`,
 * as Node prints it) — only the binding it is reached through is mangled. */
function lowerSpecialization(
  specialization: Specialization,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): FunctionDeclaration | null {
  const inner = bindings.child();
  for (const [parameter, type] of specialization.substitution) {
    inner.set(typeParameterKey(parameter), type);
  }
  const fn = lowerFunction(specialization.declaration, sourceFile, checker, inner, diagnostics);
  if (fn === null) {
    return null;
  }
  // An arrow or function expression carries no name of its own; the variable's is what Node
  // prints (`[Function: id]`), following the rule declarations already keep.
  const node = specialization.declaration;
  // An inline generic arrow or function expression has no home whose name it could print: the
  // key is a position (`arrow@test.ts#128`), not a name. A named function expression keeps its
  // own name (what Node prints for it); an anonymous arrow keeps none (what Node prints for a
  // callback-position arrow), exactly as a non-generic inline arrow lowers today. Every other
  // specialization prints its home, as before.
  const homeless = !ts.isFunctionDeclaration(node) && genericArrowKey(node) === undefined;
  return {
    kind: 'function-declaration',
    type: H_UNDEFINED,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    name: specialization.name,
    fn: fn.name === undefined && !homeless ? { ...fn, name: specialization.key } : fn,
  };
}

/** A type parameter's binding key inside `bindings`: `<T>`.
 *
 * The same unspellable-name trick the receiver parameter plays with a leading space and a static
 * with a dot. No identifier may contain an angle bracket, so a substitution can share the binding
 * map with the program's own names without either being able to reach the other — and the map is
 * already threaded through every function in this file, which is why the substitution needs no
 * parameter of its own and no mutable state to leak between specializations. */
function typeParameterKey(name: string): string {
  return `<${name}>`;
}

/** The HType of a node, with the enclosing specialization's substitution applied.
 *
 * EVERY type read in the lowering goes through here rather than calling `tsTypeToHType` directly,
 * and that is what keeps a type parameter out of the HIR: substitution happens at the one point a
 * `ts.Type` becomes an HType, so no node is ever built carrying a `T` that a later pass would have
 * to find and rewrite. Outside a specialization the lookup finds nothing and this is `tsTypeToHType`
 * exactly. */
/** The checker's type for `node`. One position needs a detour: the expression of `export default
 * <expression>` is an alias position to the checker, which types a literal there `any`; the
 * default export's own symbol carries the expression's type (plan.md §11c T11.5a). */
function checkerTypeAt(node: ts.Node, checker: ts.TypeChecker): ts.Type {
  const parent = node.parent as ts.Node | undefined;
  if (parent !== undefined && ts.isExportAssignment(parent) && parent.expression === node) {
    const moduleSymbol = checker.getSymbolAtLocation(parent.getSourceFile());
    const exported = moduleSymbol?.exports?.get(ts.InternalSymbolName.Default);
    if (exported !== undefined) {
      return checker.getTypeOfSymbol(exported);
    }
  }
  return checker.getTypeAtLocation(node);
}

function typeAt(node: ts.Node, checker: ts.TypeChecker, bindings: Scope): HType {
  // Parameters join identifiers here: step 44c widens a fixed-shape parameter that may receive
  // a dynamic value, and the widening must reach the declaration (which `lowerFunction` types
  // through here), not only later uses. A parameter declaration carries no symbol of its own —
  // only its name does — so it probes through that; a binding pattern has neither and falls
  // through.
  if (ts.isIdentifier(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) {
    // An expando namespace has a checker shape, but its runtime read throws instead of producing
    // an object with that layout. Property consumers must agree with the reference-error's type.
    // Parameters skip this: the test names an identifier position, and a parameter has none.
    if (ts.isIdentifier(node) && isUnresolvableIdentifier(node, checker, bindings)) {
      return hUnknown(false);
    }
    // Fast path: with nothing seeded the probe below always misses, so skip the symbol lookup,
    // the qualified-name computation and the key allocation entirely (plan-notes 249: ~26% of
    // checker time on big files). `hasRuntimeDynamicSymbols` is set from the same set the
    // seeding loop reads, so skipping here agrees with probing there by construction.
    if (hasRuntimeDynamicSymbols) {
      const symbol =
        ts.isParameter(node) && ts.isIdentifier(node.name)
          ? checker.getSymbolAtLocation(node.name)
          : ts.isFunctionDeclaration(node) && node.name !== undefined
            ? checker.getSymbolAtLocation(node.name)
            : checker.getSymbolAtLocation(node);
      if (
        symbol !== undefined &&
        bindings.has(`\u0000dynamic:${checker.getFullyQualifiedName(symbol)}`)
      ) {
        return hUnknown(false);
      }
    }
  }
  // Step 45: a call to a function whose declared object/array return can arrive dynamic
  // answers Unknown, so every use of the result reads through the shape table. The callee
  // keeps its declared type — only the call widens, which is what leaves overloads and
  // vtables untouched. Gated like the binding probe above: with no marks anywhere the
  // resolution below always misses, so well-formed programs skip it entirely.
  if (hasDynamicReturnSymbols && ts.isCallExpression(node)) {
    const fqn = calledFunctionFQN(node, checker);
    if (fqn !== undefined && bindings.has(`\u0000dynamic-return:${fqn}`)) {
      return hUnknown(false);
    }
  }
  const type = substituteHType(
    frontendTypes.tsTypeToHType(checkerTypeAt(node, checker), checker),
    (name) => bindings.get(typeParameterKey(name)),
  );
  // A narrowing the compiler does not CHECK is not a fact about the value. `getTypeAtLocation`
  // answers with the checker's narrowed type at this use, but an identifier lowers to its BINDING,
  // and the boundary-check that would reconcile them is only inserted for the three types a tag can
  // settle (`isCheckable`). For every other narrowing the value stays dynamic at run time, so this
  // has to say so: `/** @type {{a:number}|undefined} */ var box = {a:7}; box.a` narrows to an object
  // shape, and a caller that believed the narrowing asked for a field SLOT on a value that has no
  // layout (STA4060, plan-notes 180). Every branch selection reads this one answer, so agreeing here
  // is what keeps them agreeing with each other.
  // The binding itself, not a fresh `hUnknown`: an `Unknown` carries whether it came from an
  // implicit `any`, and the verifier compares the two for equality.
  const binding = ts.isIdentifier(node) ? bindings.get(node.text) : undefined;
  const narrowed = binding?.kind === 'unknown' && !isCheckable(type) ? binding : type;
  const normalized = normalizeClassInstance(node, narrowed, checker, bindings);
  return renameShadowedClass(node, normalized, checker);
}

/** A class instance whose declaration was alpha-renamed takes the HIR name.
 *
 * The type model spells every class by its source name, but two declarations may share one
 * spelling while owning two descriptors (plan.md §8 step 23). The checker's type still knows
 * which declaration this use came from, so the declaration -- not the spelling, and not the
 * scope visible here, which a value may have crossed -- decides the rename. Bases follow their
 * own declarations the same way. Anything but a renamed class passes through untouched, which
 * is why no accepted program without one can observe this function at all. */
function renameShadowedClass(node: ts.Node, type: HType, checker: ts.TypeChecker): HType {
  if (type.kind !== 'object') {
    return type;
  }
  // Declarations and bound expressions alike: a shadowed `const C = class …` owns a
  // descriptor per spelling exactly like a shadowed declaration (plan.md §8 step 23).
  const declaration = frontendTypes.classLikeOf(checker.getTypeAtLocation(node));
  if (declaration === undefined) {
    return type;
  }
  // Only an alpha-renamed declaration rewrites anything: a generic class never records one
  // (specializations skip the declaration site by design, and their mangled names must survive
  // this function untouched), and neither does a declaration this use precedes (a forward
  // reference, which is TDZ the compiler does not model -- the descriptor carries the source
  // name there too, since the site renames only against bindings already made).
  const hir = hirNameOf(declaration);
  if (hir === undefined) {
    return type;
  }
  // Bases are remapped even when the class itself kept its source name: a subclass declared
  // beside its shadowed base (`class E extends B` inside the block that re-declared `B`) still
  // descends from the RENAMED descriptor, and every receiver check reads the bases.
  const chain = frontendTypes.ancestry(declaration, checker);
  const hirOf = (name: string): string => {
    const owner = chain.find((candidate) => candidate.name?.text === name);
    const renamed = owner === undefined ? undefined : hirNameOf(owner);
    return renamed ?? name;
  };
  const bases = type.bases.map(hirOf);
  if (hir === type.name && bases.every((base, index) => base === type.bases[index])) {
    return type;
  }
  return { ...type, name: hir, bases };
}

/** An instance of a generic class, named for its tuple: `Box<number>`, not `Box`.
 *
 * The verifier matches every use against the descriptor by name — a `new`, a method call, a
 * receiver — so all of them must spell the specialization, not the declaration. The HType the
 * mapper builds names the declaration (it cannot know the call site), and the tuple comes from
 * the reference's own arguments, or from the enclosing specialization where the type is unbound
 * (`this`). Bases stay declared: ancestry is a property of declarations, and `D<string>` is
 * still a `B`. Anything but a generic-class instance passes through untouched, which is why no
 * accepted program without one can observe this function at all. */
function normalizeClassInstance(
  node: ts.Node,
  type: HType,
  checker: ts.TypeChecker,
  bindings: Scope,
): HType {
  if (type.kind !== 'object') {
    return type;
  }
  const tsType = checker.getTypeAtLocation(node);
  const declaration = tsType.getSymbol()?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isClassDeclaration(declaration) ||
    !isGenericClass(declaration)
  ) {
    return type;
  }
  const tuple = classTupleFor(declaration, tsType, checker, bindings);
  if (tuple === undefined) {
    return type;
  }
  const lookup = (name: string): HType | undefined => {
    const parameters = declaration.typeParameters ?? [];
    for (let i = 0; i < parameters.length; i++) {
      if (parameters[i]?.name.text === name) {
        return tuple[i];
      }
    }
    return bindings.get(typeParameterKey(name));
  };
  const name = specializationName(declaration.name?.text ?? '', tuple);
  return {
    ...type,
    name,
    fields: type.fields.map((field) => ({ ...field, type: substituteHType(field.type, lookup) })),
    methods: type.methods.map((method) => ({
      ...method,
      type: substituteHType(method.type, lookup),
    })),
  };
}

/** Every argument of a call, lowered left to right, or `null` if any of them failed.
 *
 * Six call shapes lower arguments — `new`, `console.log`, a collection operation, a method call, an
 * ordinary call and `super(...)` — and every one of them lowers left to right and abandons the whole
 * call on the first failure. That is not a coincidence to be factored for tidiness: argument order
 * IS evaluation order, and a copy of this loop that drifted would reorder a user's side effects. */
/** The sole argument of a one-argument namespace call, lowered -- `null` when lowering failed.
 * The gate already pinned the arity, so a missing argument here is unreachable, not a diagnostic. */
function lowerOnlyArgument(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics, node);
  return args?.[0] ?? null;
}

/** The span and lowered arguments of a `new` call, or `null` when any argument failed. Shared
 * by every constructor form that reads `node.arguments` (Error, Date, …). */
function lowerNewCallArgs(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { readonly span: Span; readonly args: Expression[] } | null {
  const span = makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile);
  const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics);
  if (args === null) {
    return null;
  }
  return { span, args };
}

function lowerArguments(
  nodes: readonly ts.Expression[] | undefined,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
  outerCall?: ts.CallExpression,
): Expression[] | null {
  const args: Expression[] = [];
  for (const node of nodes ?? []) {
    // A generic passed as an argument names a specialization, exactly as in an ordinary call:
    // `arr.map(box)` passes `box<number>`, resolved against the callback's type. Receiver-op
    // paths reach here instead of `lowerCallArguments`, and without this hook an accepted
    // program lowers the raw generic and dies in the verifier. Spread elements have no single
    // parameter to read and lower as ordinary expressions; `new` never passes its call, so its
    // arguments keep the ordinary path (the gate refuses a generic there first).
    if (outerCall !== undefined && !ts.isSpreadElement(node)) {
      const specialized = specializedArgument(
        node,
        outerCall,
        sourceFile,
        checker,
        bindings,
        diagnostics,
      );
      if (specialized === null) {
        return null;
      }
      if (specialized !== undefined) {
        args.push(specialized);
        continue;
      }
    }
    const lowered = lowerExpression(node, sourceFile, checker, bindings, diagnostics);
    if (lowered === null) {
      return null;
    }
    args.push(lowered);
  }
  return args;
}

/** The shared prologue of every global-static call (`Object.*`, `Date.*`, `Math.*`): the
 * arguments lowered left to right plus the span the node hangs off. `null` when lowering
 * failed. The namespace object itself is never lowered -- it names the table, not a value. */
function lowerGlobalCall(
  node: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { args: Expression[]; span: Span } | null {
  const args = lowerArguments(
    node.arguments,
    sourceFile,
    checker,
    bindings,
    diagnostics,
    ts.isCallExpression(node) ? node : undefined,
  );
  if (args === null) {
    return null;
  }
  return { args, span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile) };
}

/** The shared prologue of every single-argument namespace call (`JSON.*`, the `Promise.*`
 * statics): the one lowered argument plus the span. `null` when lowering failed. */
function lowerSoleCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { arg: Expression; span: Span } | null {
  const arg = lowerOnlyArgument(node, sourceFile, checker, bindings, diagnostics);
  if (arg === null) {
    return null;
  }
  return { arg, span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile) };
}

/** The shared prologue of every receiver-op call (`date-op`, `regexp-op`, `string-op`,
 * `array-op`): the receiver first, then the arguments left to right, then the span everything
 * hangs off. `null` when either lowering failed. `promise-method` keeps its own order (its
 * arguments lower before the receiver), so it does not share this. */
function lowerReceiverCall(
  obj: ts.Expression,
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): { target: Expression; args: Expression[]; span: Span } | null {
  const target = lowerExpression(obj, sourceFile, checker, bindings, diagnostics);
  if (target === null) {
    return null;
  }
  const args = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics, node);
  if (args === null) {
    return null;
  }
  return {
    target,
    args,
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
  };
}

/** Pads omitted trailing arguments with undefined-literals up to the table's arity. For every
 * op in these tables the spec gives an explicitly-passed undefined the same meaning as an
 * absent argument, which is what makes the padding observably identical to the source. */
/** A `typed-op` for one TYPED_OPS row: the receiver first (none for a constructor), then the
 * arguments padded to the row's arity, typed by the row's result (plan.md §11c T11.1). */
function typedOpNode(
  op: TypedOperation,
  receiver: Expression | undefined,
  args: readonly Expression[],
  span: Span,
): TypedOp {
  const shape = TYPED_OPS[op];
  const padded = padToArity(args, shape.arity, span);
  return {
    kind: 'typed-op',
    type: typedResultType(shape.result),
    span,
    op,
    args: receiver === undefined ? padded : [receiver, ...padded],
  };
}

/** A global function call's node (plan.md §11c T11.4). The three conversions ARE existing
 * operations -- `String(x)` is a template hole (ToString, never the `valueOf`-first ToPrimitive
 * `"" + x` runs), `Number(x)` is unary `+`, `Boolean(x)` is `!!x` -- and with no argument each is
 * its constant. `Array()` and `Array(a, b, ...)` are the array literal of their arguments
 * (§23.1.1.1 steps 4 and 6); the one-argument form may be a length and stays a call. The rest are
 * one `global-call` each, padded to their row's arity because an omitted argument is `undefined`
 * to the runtime. `created` is the checker's type of the whole call: the array an `Array` call
 * builds. */
function globalFunctionNode(
  name: GlobalFunction,
  prologue: { readonly args: readonly Expression[]; readonly span: Span },
  created: HType,
): Expression {
  const { args, span } = prologue;
  const [arg] = args;
  switch (name) {
    case 'String':
      return arg === undefined
        ? { kind: 'string-literal', type: H_STRING, span, value: '' }
        : { kind: 'template-literal', type: H_STRING, span, quasis: ['', ''], expressions: [arg] };
    case 'Number':
      return arg === undefined
        ? { kind: 'number-literal', type: H_NUMBER, span, value: 0 }
        : { kind: 'unary-op', type: H_NUMBER, span, operator: '+', operand: arg };
    case 'Boolean': {
      if (arg === undefined) {
        return { kind: 'boolean-literal', type: H_BOOLEAN, span, value: false };
      }
      const not: Expression = {
        kind: 'unary-op',
        type: H_BOOLEAN,
        span,
        operator: '!',
        operand: arg,
      };
      return { kind: 'unary-op', type: H_BOOLEAN, span, operator: '!', operand: not };
    }
    case 'Array':
      if (args.length !== 1) {
        return { kind: 'array-literal', type: created, span, elements: args };
      }
      return globalCallNode(name, args, created, span);
    case 'Array.from':
    case '...':
      return globalCallNode(
        name,
        args,
        created.kind === 'array' ? created : hArray(hUnknown(false)),
        span,
      );
    case 'RegExp':
      return globalCallNode(name, args, H_REGEXP, span);
    case 'parseInt':
    case 'parseFloat':
      return globalCallNode(name, args, H_NUMBER, span);
    case 'isNaN':
    case 'isFinite':
      return globalCallNode(name, args, H_BOOLEAN, span);
  }
}

function globalCallNode(
  name: GlobalCallName,
  args: readonly Expression[],
  type: HType,
  span: Span,
): Expression {
  return {
    kind: 'global-call',
    type,
    span,
    name,
    args: padToArity(args, GLOBAL_CALLS[name].arity, span),
  };
}

function padToArity(args: readonly Expression[], arity: number, span: Span): Expression[] {
  const padded: Expression[] = [...args];
  while (padded.length < arity) {
    padded.push({ kind: 'undefined-literal', type: H_UNDEFINED, span });
  }
  return padded;
}

/** An extern call (docs/FFI.md §1, plan.md §10 Task 7.1 step 5): the declaration's ABI tuple
 * with the lowered arguments, each dynamic one wrapped in the call-edge boundary check the
 * mixed-graph rule already owns (`maybeBoundary` — STA2001 at run time on mismatch, the
 * existing trap doing its existing job, not a new mechanism).
 *
 * The gate proved three things before this runs: the declaration lives in a `.d.ts`, its
 * signature classifies into the ABI table, and — in `js` mode — the arity is exact (in `ts`
 * mode the checker's own arity diagnostic owns that refusal, and the build stops there). A C
 * call has no missing-means-`undefined`, so each is re-asserted as an STA4031 rather than
 * trusted, because a gate/lowering disagreement here would otherwise emit a C call against
 * the wrong signature — memory corruption, not a diagnostic. The callee is never lowered as
 * an expression: an extern has no value, so there is no binding for it. */
function lowerExternCall(
  node: ts.CallExpression,
  decl: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: Scope,
  diagnostics: Diagnostic[],
): Expression | null {
  const fail = (message: string): null => {
    diagnostics.push(lowerDiagnostic(node, sourceFile, 'STA4031', 'internal', message));
    return null;
  };
  const classified = classifyExternDeclaration(decl, checker);
  if (!classified.ok) {
    return fail(`extern call the gate refused reached the lowering (${classified.code})`);
  }
  // The gate accepts an optional chain on an extern (`ext?.()`): the callee always links,
  // so `?.` is a proven no-op and the call lowers to the same direct C call — there is no
  // conditional for the HIR to model and no flag for ExternCall to carry.
  const signature = classified.signature;
  if (node.arguments.length !== signature.params.length) {
    return fail('extern call with an arity the gate refused reached the lowering');
  }
  const lowered = lowerArguments(node.arguments, sourceFile, checker, bindings, diagnostics);
  if (lowered === null) {
    return null;
  }
  const args: Expression[] = [];
  const argTags: (string | undefined)[] = [];
  for (const [index, arg] of lowered.entries()) {
    const kind = signature.params[index];
    const site = node.arguments[index];
    if (kind === undefined || site === undefined) {
      return fail('extern call with an arity the gate refused reached the lowering');
    }
    if (kind === 'out-pointer') {
      // Only a slot name (or a fresh inline slot) has a cell whose address the emitter can
      // take: the gate proved the shape, so anything else is the two disagreeing (STA4031).
      // The cast tag rides from the PARAMETER's spelling, never the argument's — a lying
      // argument still links (or fails loudly at the clang line), exactly like any other
      // uncheckable boundary value (docs/FFI.md §5).
      const unwrapped = ts.isParenthesizedExpression(site) ? site.expression : site;
      const isSlotName = ts.isIdentifier(unwrapped);
      const isFreshSlot =
        ts.isCallExpression(unwrapped) && outSlotDeclarationOf(unwrapped, checker) !== undefined;
      if (!isSlotName && !isFreshSlot) {
        return fail('extern call with a non-slot out-pointer argument reached the lowering');
      }
      const param = decl.parameters[index];
      if (param === undefined) {
        return fail('extern call with an arity the gate refused reached the lowering');
      }
      const tag = outInnerTag(checker.getTypeAtLocation(param), checker);
      if (tag === undefined) {
        return fail('extern call with an unspellable out-pointer parameter reached the lowering');
      }
      argTags.push(tag);
    } else {
      argTags.push(undefined);
    }
    // A `bytes` argument is checked whenever it is not PROVEN a view: the emitter reads the
    // view's layout straight after the check, so a dynamic value or a js-mode value of another
    // type must fail as STA2001 here, never reach C as a misread struct (docs/FFI.md §2).
    args.push(
      kind === 'bytes' && arg.type.kind !== 'uint8array'
        ? boundaryCheck(arg, externKindHType(kind), site, sourceFile)
        : maybeBoundary(arg, externKindHType(kind), site, sourceFile),
    );
  }
  // The declaration file's header, if it names one: the prologue includes it and skips the
  // forward declaration, so the header's real prototype governs the call (docs/FFI.md §9).
  const header = headerOf(decl.getSourceFile());
  const call: ExternCall = {
    kind: 'extern-call',
    // `void` is `undefined` everywhere the model meets it — the same collapse `tsTypeToHType`
    // performs — so the one mapping serves parameters and the return alike.
    type: externKindHType(signature.ret),
    span: makeSpan(node.getStart(sourceFile), node.getWidth(sourceFile), sourceFile),
    cName: signature.cName,
    tsName: signature.tsName,
    args,
    argKinds: signature.params,
    argTags,
    retKind: signature.ret,
    ...(signature.error !== undefined ? { error: signature.error } : {}),
    ...(header !== undefined ? { header } : {}),
  };
  return call;
}

/** The operation a Map or Set method name denotes, or undefined for a name that is not one.
 *
 * The gate has already refused every other name, so `undefined` here is an internal error rather
 * than a user-facing refusal -- which is exactly why this returns rather than throwing: the caller
 * reports it with a span, and the compiler does not stack-trace at the CLI. */
function collectionOperation(name: string): CollectionOperation | undefined {
  switch (name) {
    case 'get':
    case 'set':
    case 'has':
    case 'delete':
    case 'clear':
    case 'add':
    case 'size':
    case 'forEach':
    case 'keys':
    case 'values':
    case 'entries':
      return name;
    default:
      // The ES2025 set operations, which are a table rather than seven more cases -- the gate and
      // the verifier read the same one.
      return isSetOperation(name) ? name : undefined;
  }
}
