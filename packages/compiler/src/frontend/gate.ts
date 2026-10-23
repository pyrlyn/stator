import * as ts from 'typescript';
import { ambiguousStarExports, namespaceModule } from './modules.ts';
import { hasTypeScriptAnnotation } from './annotation.ts';
import type {
  ConsoleMethod,
  DateOperation,
  DateStatic,
  ErrorClass,
  RegExpOperation,
} from '../hir/nodes.ts';
import { GLOBAL_CALLS, NUMBER_OPS } from '../hir/nodes.ts';
import type { GlobalCallName } from '../hir/nodes.ts';
import type { HType } from '../hir/types.ts';
import { accessorName, hTypeName, objectFieldsPrefix } from '../hir/types.ts';
import { callableFieldSlot } from '../hir/types.ts';
import {
  ARRAY_OPS,
  CONSOLE_METHODS,
  DATE_OPS,
  DATE_STATICS,
  ERROR_CLASSES,
  isSetOperation,
  MATCH_FIELDS,
  REGEXP_FIELDS,
  REGEXP_OPS,
  STRING_OPS,
  STRING_STATICS,
  TYPED_OPS,
  typedClassName,
  typedMember,
} from '../hir/nodes.ts';
import type { Diagnostic } from '../support/diagnostics.ts';
import { diagnosticFromFile, diagnosticFromNode, syntaxKindName } from '../support/diagnostics.ts';
import { intlEnabled } from '../support/features.ts';
import {
  capturesEnclosingScope,
  genericAliasTarget,
  genericArrowKey,
  genericCallInstantiation,
  genericNewInstantiation,
  genericValueInstantiation,
  inlineGenericTuple,
} from './generics.ts';
import { assertedBy, isCheckable } from './narrowing.ts';
import * as frontendTypes from './types.ts';
import { classDeclarationOf, accessorDeclaringClass, classDisplayName } from './types.ts';
import { isClassFormationDeclarator } from './types.ts';
import {
  classifyExternDeclaration,
  classifyOutSlotCall,
  isOutSlotCallee,
  outSlotDeclarationOf,
  externDeclarationOfCall,
  externDeclarationOfSymbol,
  fileHasExternDeclaration,
  isDirectCalleePosition,
  isExternDeclaration,
  linkPragmasOf,
} from './extern.ts';
import { isFreeCommonJsName, isPackageSpecifier, isSyntaxFreeEsModule } from './vendor.ts';
import {
  type CommonJsBinding,
  commonJsVerdict,
  isNodeSourceFile,
  nodeBuiltinId,
  nodeLocationModule,
} from './node.ts';
import { classifyStdSpecifier } from './std.ts';

type Mode = 'ts' | 'js';

/** The mode policy gate: enforces subset acceptance and typing rules.
 * In ts mode: rejects untyped code entirely.
 * In js mode: accepts both .ts and .js files; untyped becomes Unknown/dynamic.
 * Gating decisions produce diagnostics; nothing below the gate knows the mode exists.
 */
export function gateProgram(program: ts.Program, mode: Mode, onNode = false): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();
  const classNameCounts = countClassNames(program, mode);

  // Check each source file
  for (const sourceFile of program.getSourceFiles()) {
    // Declaration files describe an interface; they never execute, so there is no construct here
    // to accept or defer. This covers the TypeScript libs, Stator's own globals, and any `.d.ts`
    // the user brings.
    if (sourceFile.isDeclarationFile || program.isSourceFileDefaultLibrary(sourceFile)) {
      // The one exception is the extern surface (docs/FFI.md §1): an `@statorExtern` declaration
      // IS the contract, so its signature is validated where it is written — refusals at the
      // declaration's span, in the same commit that lands the call-site verdicts. Lib files carry
      // no marker and are untouched by the walk.
      gateExternDeclarations(sourceFile, typeChecker, mode, diagnostics);
      continue;
    }

    // In ts mode: reject .js files entirely
    if (mode === 'ts' && sourceFile.fileName.endsWith('.js')) {
      diagnostics.push(
        diagnosticFromFile(
          sourceFile.fileName,
          1,
          1,
          'STA1002',
          'never',
          mode,
          '.js files are not allowed in ts mode; use `--mode=js` or convert to .ts',
        ),
      );
      continue;
    }

    // Walk the AST and gate each node
    visitNode(sourceFile, sourceFile, typeChecker, mode, diagnostics, classNameCounts, onNode);
  }

  return diagnostics;
}

/** The file of every named class declaration and expression, by spelling, across the program. */
type ClassNameFiles = ReadonlyMap<string, readonly ts.SourceFile[]>;

/** Where each named class spelling is declared across the program, one entry per declaration.
 *
 * A generic class specializes under its source name, so two declarations sharing one would share
 * one mangled tuple. The gate holds that boundary by name uniqueness (`nestedGenericIsScoped`
 * program-wide, `genericNameIsModuleLocal` across modules), counted once here over exactly the
 * files the walk below gates, so the two cannot disagree about which files count. */
function countClassNames(program: ts.Program, mode: Mode): ClassNameFiles {
  const counts = new Map<string, ts.SourceFile[]>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || program.isSourceFileDefaultLibrary(sourceFile)) {
      continue;
    }
    if (mode === 'ts' && sourceFile.fileName.endsWith('.js')) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined) {
        const files = counts.get(node.name.text) ?? [];
        files.push(sourceFile);
        counts.set(node.name.text, files);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return counts;
}

/** Recursively visit and gate all nodes in the tree. */
function visitNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  mode: Mode,
  diagnostics: Diagnostic[],
  classNameCounts: ClassNameFiles,
  onNode: boolean,
): void {
  // Check for explicit `any` in ts mode (STA1001)
  if (mode === 'ts' && frontendTypes.hasExplicitAny(node)) {
    diagnostics.push(
      diagnosticFromNode(
        node,
        sourceFile,
        'STA1001',
        'never',
        mode,
        "explicit 'any' is not allowed in ts mode; use 'unknown' instead",
      ),
    );
  }

  // Check for implicit `any` in ts mode (STA1003)
  if (mode === 'ts' && frontendTypes.isImplicitAny(node, typeChecker)) {
    diagnostics.push(
      diagnosticFromNode(
        node,
        sourceFile,
        'STA1003',
        'never',
        mode,
        "implicit 'any' is not allowed in ts mode; add a type annotation",
      ),
    );
  }

  // Type annotations are the checker's business, not the gate's. They carry no runtime construct
  // to accept or defer, and running them through gateConstruct would reject `let x: number = 1`
  // -- the NumberKeyword node is not in any value-level accept list. The `any` checks above still
  // apply, and we still recurse so a nested `any` (e.g. `Array<any>`) is found.
  if (ts.isTypeNode(node)) {
    ts.forEachChild(node, (child) =>
      visitNode(child, sourceFile, typeChecker, mode, diagnostics, classNameCounts, onNode),
    );
    return;
  }

  // Gate specific constructs: accept the micro-subset, reject the rest
  const gateResult = gateConstruct(node, mode, typeChecker, classNameCounts, onNode);
  if (gateResult.kind === 'not-yet') {
    diagnostics.push(
      diagnosticFromNode(
        node,
        sourceFile,
        gateResult.code,
        'not-yet',
        mode,
        gateResult.message,
        gateResult.phase,
      ),
    );
    // A rejected construct's children add nothing: one diagnostic per construct beats a cascade
    // naming every subexpression of a function body the user already knows is unsupported.
    return;
  }
  if (gateResult.kind === 'never') {
    diagnostics.push(
      diagnosticFromNode(node, sourceFile, gateResult.code, 'never', mode, gateResult.message),
    );
    return;
  }

  // Recurse
  ts.forEachChild(node, (child) =>
    visitNode(child, sourceFile, typeChecker, mode, diagnostics, classNameCounts, onNode),
  );
}

type GateResult =
  | { kind: 'accept' }
  /** Rejected by design and forever -- STA10xx/STA11xx, and never a phase (plan §1.3). */
  | { kind: 'never'; code: string; message: string }
  /** Outside the current subset but scheduled -- STA12xx, and the phase is part of the message.
   *
   * `phase` is OPTIONAL because some blockers are not phases: a build flag is not a release to
   * wait for, it is a flag to turn on (src/support/phases.ts). Omit it there rather than writing a
   * number the user cannot act on. */
  | { kind: 'not-yet'; code: string; message: string; phase?: number };

/** Decide whether one construct is in the Phase 2 micro-subset.
 *
 * THE INVARIANT: this accept set must equal the vocabulary of `src/hir/nodes.ts`, exactly. A
 * construct accepted here but absent from the HIR reaches the lowering, which can only answer
 * with an STA4xxx internal error -- the compiler blaming itself for source it chose to accept.
 * Widening the HIR and widening this function are the same change; do them together.
 *
 * Accepts today: number/string/boolean literals, `null` and `undefined`, identifiers, `let`/`const`
 * with an initializer, plain `=` assignment, the nineteen binary operators and three
 * short-circuiting operators the HIR models, prefix `- + ! ~`, parentheses, `console.log(x)` with
 * exactly one argument, expression statements, blocks, `if`/`else`, and `while`.
 */
function gateConstruct(
  node: ts.Node,
  mode: Mode,
  typeChecker: ts.TypeChecker,
  classNameCounts: ClassNameFiles,
  onNode: boolean,
): GateResult {
  const kind = node.kind;

  // Before the token skip below: a BigInt literal IS a token, and skipping it handed `1n` to the
  // lowering, which can only answer STA4031 (plan.md §9 Task 6.25).
  if (isBigIntUse(node, typeChecker)) {
    return {
      kind: 'not-yet',
      code: 'STA1213',
      message: 'BigInt is not yet supported; planned for Phase 5',
      phase: 5,
    };
  }

  // Tokens carry no independent meaning: an operator token, keyword, or punctuation is only ever
  // reached as a child of a construct this function already ruled on. Gating them separately
  // would reject `1 + 2` for containing a PlusToken.
  //
  // THREE tokens are exempt, because they are not punctuation -- they are expressions that read
  // something, and the something differs by where they are written. `this`, `super` and an
  // identifier each have a case below, and each would be silently dead code without this list:
  // that is exactly what happened to `this` and `super`, whose cases never ran until the exemption
  // was widened past `Identifier`.
  if (
    kind <= ts.SyntaxKind.LastToken &&
    kind !== ts.SyntaxKind.Identifier &&
    kind !== ts.SyntaxKind.ThisKeyword &&
    kind !== ts.SyntaxKind.SuperKeyword
  ) {
    return { kind: 'accept' };
  }

  const moduleSyntax = gateModuleSyntax(node, typeChecker);
  if (moduleSyntax !== undefined) {
    return moduleSyntax;
  }

  switch (kind) {
    // Structure that maps 1:1 onto HIR statements.
    case ts.SyntaxKind.SourceFile:
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.ForStatement:
    // A switch and its parts. CaseBlock/CaseClause/DefaultClause are nodes rather than tokens, so
    // each needs a case of its own -- the same trap TemplateSpan sprang (plan-notes 37).
    case ts.SyntaxKind.SwitchStatement:
    case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.DefaultClause:
      return { kind: 'accept' };

    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
      return { kind: 'accept' };

    // Task 3.10: `throw e;` and `try/catch/finally` lower to landing pads in the emitter.
    case ts.SyntaxKind.ThrowStatement:
    case ts.SyntaxKind.TryStatement:
      return { kind: 'accept' };

    // `catch (e)` / `catch {`. The binding must be a plain name -- `catch ({ message })`
    // destructures, and the HIR has one name per binding, the same rule gateDeclaration applies.
    // The binding's TYPE needs no rule here: unannotated it is `unknown` (strict mode's
    // useUnknownInCatchVariables), `: unknown` is the same thing written out, and `: any` is
    // caught by the mode-wide STA1001 walk like any other explicit any.
    case ts.SyntaxKind.CatchClause: {
      const clause = node as ts.CatchClause;
      const binding = clause.variableDeclaration;
      return binding === undefined || isSimpleBindingPattern(binding.name)
        ? { kind: 'accept' }
        : notYet('destructuring a caught value is not yet supported', 5);
    }

    // The three function spellings share one HIR node (`FunctionExpr`), so they share one gate.
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
      return gateFunction(
        node as ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
        typeChecker,
      );

    case ts.SyntaxKind.ObjectBindingPattern:
    case ts.SyntaxKind.ArrayBindingPattern:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.OmittedExpression:
      return { kind: 'accept' };

    case ts.SyntaxKind.Parameter:
      return gateParameter(node as ts.ParameterDeclaration);

    // `<T>` itself. It is not a type NODE -- it DECLARES one -- so it reaches this switch rather
    // than the annotation skip above. A constraint is enforced by the checker at every call site
    // and a default supplies the tuple element no call site wrote, so neither needs a rule here
    // beyond the method case below: monomorphization substitutes the resolved tuple, whatever
    // constrained or defaulted it (plan.md §8 step 12(f)).
    case ts.SyntaxKind.TypeParameter:
      return gateTypeParameter(node as ts.TypeParameterDeclaration);

    // `interface X { ... }` and `type X = ...` erase: they bind no value and emit no code
    // (docs/SUBSET.md). Accepted so the declaration is not a diagnostic; the lowering drops
    // them, and uses of the name are ordinary annotations the checker resolves. `enum` and
    // `namespace` stay refused below: unlike these two, they HAVE runtime meaning the HIR
    // does not model.
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
      return { kind: 'accept' };

    // `return;` and `return e;`. That a return sits inside a function is a structural fact the
    // HIR verifier checks; the gate only decides the construct is in the subset. Out-slots
    // are the one value ruled on here: a slot is a call-local cell, so returning one would
    // hand the caller bits for a frame that is already gone — STA1125 in both modes (the
    // checker cannot see it: the annotation agrees with the value).
    case ts.SyntaxKind.ReturnStatement: {
      const returned = (node as ts.ReturnStatement).expression;
      if (
        returned !== undefined &&
        frontendTypes.outSlotInner(typeChecker.getTypeAtLocation(returned), typeChecker) !==
          undefined
      ) {
        return {
          kind: 'never',
          code: 'STA1125',
          message: 'returning an out-slot is outside the out-slot contract (docs/FFI.md)',
        };
      }
      // A constructor's `return e` makes `new` yield `e` when it is an object (Node:
      // `new C()` answers the returned `{...}`, not the instance), and this subset's `new`
      // yields the allocated object and ignores what a constructor returns
      // (`codegen/`), so accepting one would compile a program that silently
      // answers differently. A bare `return;` returns no value and is ruled on by the
      // constructor-super coverage rule instead.
      if (returned !== undefined && enclosingFunctionIsConstructor(node)) {
        return notYet('a constructor that returns a value is not yet supported', 5);
      }
      return { kind: 'accept' };
    }

    // `outer: for (…)`. Only a loop or switch may carry a label here, because those are the only
    // HIR nodes with a place to put one. `foo: { … }` is legal JavaScript but would need a label
    // that is not attached to anything the HIR models.
    case ts.SyntaxKind.LabeledStatement:
      return { kind: 'accept' };

    // `;` on its own lowers to nothing at all -- accepted so it is not a diagnostic, dropped by
    // the lowering rather than given an HIR node.
    case ts.SyntaxKind.EmptyStatement:
      return { kind: 'accept' };

    // Parentheses are pure grouping: the HIR tree already encodes the precedence they expressed,
    // so the lowering unwraps them instead of modelling them.
    case ts.SyntaxKind.ParenthesizedExpression:
      return { kind: 'accept' };

    case ts.SyntaxKind.Identifier:
      return gateIdentifier(node as ts.Identifier, typeChecker, mode, onNode);

    case ts.SyntaxKind.VariableDeclarationList:
      return gateDeclarationList(node as ts.VariableDeclarationList, mode);

    case ts.SyntaxKind.VariableDeclaration:
      return gateDeclaration(node as ts.VariableDeclaration, typeChecker);

    case ts.SyntaxKind.BinaryExpression:
      return gateBinary(node as ts.BinaryExpression, typeChecker, mode);

    case ts.SyntaxKind.PrefixUnaryExpression:
      return gatePrefixUnary(node as ts.PrefixUnaryExpression, typeChecker, mode);

    case ts.SyntaxKind.PostfixUnaryExpression:
      return gateUpdate(node, typeChecker, mode);

    case ts.SyntaxKind.TypeOfExpression:
      return { kind: 'accept' };

    case ts.SyntaxKind.DeleteExpression:
      return gateDelete(node as ts.DeleteExpression, typeChecker, mode);

    case ts.SyntaxKind.AsExpression:
      return { kind: 'accept' };

    case ts.SyntaxKind.CallExpression:
      return gateCall(node as ts.CallExpression, typeChecker, mode);

    // `super` never denotes a value of its own: it is a marker on the forms that mention
    // it. `super(...)` is the base constructor run against this constructor's own receiver,
    // `super.m()` is a call on this same receiver that skips the override, and `super.m` as a
    // value is the base's method as an unbound closure (gateMemberAccess vets the read itself).
    // Anywhere else -- passed, returned, compared -- there is no object for it to be.
    case ts.SyntaxKind.SuperKeyword:
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        return { kind: 'accept' };
      }
      return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        ? { kind: 'accept' }
        : notYet('super as a value is not yet supported', 5);

    // `extends A` / `implements I`. gateClass vetted the whole clause -- that there is one base,
    // that it is a class declaration, and that nothing is overridden -- and these two nodes are
    // what the walker then descends through on its way to the base's NAME.
    case ts.SyntaxKind.HeritageClause:
    case ts.SyntaxKind.ExpressionWithTypeArguments:
    // Template literals. The no-substitution form is just a string; the substitution form is
    // TemplateLiteral, whose children (spans, head, middles, tail) are tokens and accepted above.
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    // A TemplateSpan is the pairing of one hole with the literal chunk that follows it. It is a
    // node rather than a token, so it needs an explicit case; its children are gated normally.
    case ts.SyntaxKind.TemplateSpan:
      return { kind: 'accept' };

    // Three shapes only: the callee of an accepted `console.log` (gateCall already vetted the whole
    // call, and this node is its child), and `.length` on a string, an array, or a function.
    case ts.SyntaxKind.PropertyAccessExpression: {
      const access = node as ts.PropertyAccessExpression;
      // `globalThis.eval` / `globalThis.Function` as VALUES — the call/`new` forms are decided
      // on those nodes, but aliasing (`const e = globalThis.eval`) is the same construct and
      // must not fall through to "property access is not yet supported".
      const dynamic = dynamicCodeGeneration(access, typeChecker);
      if (dynamic === 'eval') {
        return evalResult(mode);
      }
      if (dynamic === 'function') {
        return functionCtorResult(mode);
      }
      if (
        isConsoleLog(access) ||
        isStringLength(access, typeChecker) ||
        isArrayLength(access, typeChecker) ||
        isFunctionLength(access, typeChecker)
      ) {
        return { kind: 'accept' };
      }
      return gateMemberAccess(access, typeChecker, mode);
    }

    case ts.SyntaxKind.ArrayLiteralExpression:
      return gateArrayLiteral(node as ts.ArrayLiteralExpression, typeChecker);

    case ts.SyntaxKind.ElementAccessExpression:
      return gateElementAccess(node as ts.ElementAccessExpression, typeChecker, mode);

    case ts.SyntaxKind.ForOfStatement:
      return gateForOf(node as ts.ForOfStatement, mode, typeChecker);

    // `class C { … }` and `const C = class { … }` share one gate: the declaration lowers to
    // a descriptor plus bindings, while the expression is a VALUE and needs the class object
    // rung 6b never allocated (plan.md §8 step 12e) -- so the same member vetting runs for both
    // and only the expression takes the final not-yet below.
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return gateClass(
        node as ts.ClassDeclaration | ts.ClassExpression,
        typeChecker,
        classNameCounts,
      );

    case ts.SyntaxKind.ObjectLiteralExpression:
      return gateObjectLiteral(node as ts.ObjectLiteralExpression, typeChecker);

    // A `name: value` pair of an accepted literal. gateObjectLiteral vetted the whole literal --
    // these are its children, reached on the way down, and the values are gated normally.
    case ts.SyntaxKind.PropertyAssignment:
    // `{ x }`, whose name IS its value. Same reasoning: the literal was vetted above, and the
    // identifier underneath is gated as the ordinary identifier it desugars to.
    case ts.SyntaxKind.ShorthandPropertyAssignment:
    // `{ ...a }`. gateObjectLiteral already held the operand to a variable of fixed shape; the
    // identifier underneath is gated as the ordinary read the expansion makes of it.
    case ts.SyntaxKind.SpreadAssignment:
    // `...x` in an array literal. gateArrayLiteral vetted the operand type; the expression
    // underneath is gated normally.
    case ts.SyntaxKind.SpreadElement:
    // A member of a TYPE literal (`let p: { x: number }`, `{ [k: string]: n }`). The enclosing
    // TypeLiteral is a type node and skipped as one, but its members are not type nodes themselves,
    // so the walk reaches them; they carry no runtime construct, exactly as the annotation around
    // them does not. A class index signature is refused in gateClass instead.
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.IndexSignature:
      return { kind: 'accept' };

    // The members of an accepted class. gateClass already vetted the class as a whole -- these are
    // its children, reached on the way down, and their own children are gated normally. A static
    // block's statements are gated as the ordinary statements they lower to.
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return { kind: 'accept' };

    // `/ab+c/gi` -- pattern and flags travel to the runtime as TEXT, so nothing here parses them
    // and nothing here can disagree with the vendored engine about what they mean. An invalid
    // pattern is settled where it is compiled: at run time, loudly (STA2005 pattern).
    case ts.SyntaxKind.RegularExpressionLiteral:
      return { kind: 'accept' };

    case ts.SyntaxKind.NewExpression:
      return gateNew(node as ts.NewExpression, typeChecker, mode);

    case ts.SyntaxKind.ThisKeyword:
      return gateThis(node, typeChecker);

    // Permanently rejected in BOTH modes, by design -- ESM is always strict and `with`
    // is illegal in strict mode, so this is the language's restriction, not Stator's
    // (docs/SUBSET.md, docs/DIAGNOSTICS.md STA1109). STA1107 is prototype mutation;
    // `with` must never report that number.
    case ts.SyntaxKind.WithStatement:
      return {
        kind: 'never',
        code: 'STA1109',
        message: 'with statements are not allowed — ESM is always strict mode',
      };

    // Scheduled features that already own a code: the message must name the same phase the
    // diagnostics table does, or `stator explain` and docs/DIAGNOSTICS.md disagree.
    case ts.SyntaxKind.AwaitExpression:
      return gateAwait(node);
    case ts.SyntaxKind.YieldExpression:
      return gateYield(node);

    // `[Symbol.iterator]` on a class method, or `[key]` on an object literal member.
    // gateObjectLiteral / gateClass vetted the enclosing literal or class; this node is their
    // child, reached on the way down. A literal-typed computed class member name (`[k]` with
    // `k: "m"`) is the name the direct spelling writes, so it rides the class's verdict the
    // same way; anything wider is refused where the member is.
    case ts.SyntaxKind.ComputedPropertyName:
      if (isObjectLiteralComputedKey(node as ts.ComputedPropertyName)) {
        return { kind: 'accept' };
      }
      if (
        isClassMemberComputedKey(node as ts.ComputedPropertyName) &&
        frontendTypes.computedKeyStaticName(node as ts.ComputedPropertyName, typeChecker) !== null
      ) {
        return { kind: 'accept' };
      }
      return frontendTypes.isGlobalSymbolIteratorName(node as ts.ComputedPropertyName, typeChecker)
        ? { kind: 'accept' }
        : notYet('a computed property name is not yet supported', 5);

    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.ForInStatement:
      return { kind: 'accept' };

    default:
      return notYet(`${describeKind(kind)} is not yet supported`, 5);
  }
}

/** Task 3.11 + plan.md §11c T11.5a: the module syntax, or `undefined` for any other node. Every
 * module has its own top-level namespace; an import binds its local name to the exporting
 * module's binding, resolved through the checker's alias chain in the lowering, so every
 * renaming shape (`x as y`, a default, a namespace, a re-export) names the binding it aliases
 * rather than a spelling. */
function gateModuleSyntax(node: ts.Node, typeChecker: ts.TypeChecker): GateResult | undefined {
  if (MODULE_CLAUSE_KINDS.has(node.kind)) {
    return { kind: 'accept' };
  }
  if (ts.isImportDeclaration(node)) {
    return gateImport(node, typeChecker);
  }
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    return gateSpecifier(node, typeChecker);
  }
  // `export { x }`, `export { x as y }`, and the re-exports `export … from`, `export * from`,
  // `export * as ns from`: a re-export's specifier is held to the import rules.
  if (ts.isExportDeclaration(node)) {
    return node.moduleSpecifier === undefined || node.isTypeOnly
      ? { kind: 'accept' }
      : gateModuleSpecifier(node.moduleSpecifier, typeChecker);
  }
  // `export default <expression>` evaluates its expression once, into the module's hidden
  // `*default*` binding (ES §16.2.3.7), which a default import then reads.
  if (ts.isExportAssignment(node)) {
    return node.isExportEquals ? notYet('export = is not yet supported', 5) : { kind: 'accept' };
  }
  return undefined;
}

/** The clauses that only hold an import's or an export's names; each name is gated on its own. */
const MODULE_CLAUSE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamedImports,
  ts.SyntaxKind.NamedExports,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.NamespaceExport,
]);

/** `import(s)`. A string literal names a file already in the whole-program graph. Anything
 * else needs runtime resolution, which is Phase 8 (plan.md §8 step 10c). */
function gateImportCall(call: ts.CallExpression): GateResult {
  const spec = call.arguments[0];
  if (call.arguments.length !== 1 || spec === undefined) {
    return {
      kind: 'not-yet',
      code: 'STA1207',
      message:
        'dynamic import() is not yet supported; planned for Phase 5 (module namespace objects)',
      phase: 5,
    };
  }
  if (!ts.isStringLiteral(spec)) {
    return {
      kind: 'not-yet',
      code: 'STA1207',
      message:
        'import() with a computed specifier is not yet supported; planned for Phase 8 (runtime module resolution)',
      phase: 8,
    };
  }
  // A package's namespace object lives in the vendor bundle, where Rolldown builds it with
  // `__exportAll` (`Object.defineProperty` getters and `Symbol.toStringTag`); until that helper
  // compiles, the call has no module to load (plan.md §11d T12.3).
  if (isPackageSpecifier(spec.text)) {
    return {
      kind: 'not-yet',
      code: 'STA1214',
      message:
        "import() of a package is not yet supported; planned for Phase 12 (Rolldown's __exportAll)",
      phase: 12,
    };
  }
  return { kind: 'accept' };
}

/** One name an import or a re-export takes from another module by name. A name two `export *`
 * re-exports of that module bind differently is ambiguous, and naming it is the SyntaxError ES
 * raises at link time (§16.2.1.6.3, plan-notes 302); js mode drops the checker's TS2308 so that
 * this is where the program is refused, and the namespace merely leaves the name out. */
function gateSpecifier(
  spec: ts.ImportSpecifier | ts.ExportSpecifier,
  typeChecker: ts.TypeChecker,
): GateResult {
  const declaration = ts.isImportSpecifier(spec) ? spec.parent.parent.parent : spec.parent.parent;
  const moduleSpecifier = declaration.moduleSpecifier;
  if (moduleSpecifier === undefined) {
    return { kind: 'accept' };
  }
  const target = typeChecker.getSymbolAtLocation(moduleSpecifier)?.valueDeclaration;
  const name = (spec.propertyName ?? spec.name).text;
  if (target === undefined || !ts.isSourceFile(target)) {
    return { kind: 'accept' };
  }
  if (name === 'default') {
    return missingDefault(target) ?? { kind: 'accept' };
  }
  return ambiguousStarExports(target, typeChecker).has(name)
    ? {
        kind: 'never',
        code: 'STA3003',
        message:
          `'${name}' is ambiguous in ${target.fileName}: two \`export *\` re-exports bind it ` +
          'differently, so it cannot be imported by name',
      }
    : { kind: 'accept' };
}

/** A default import of a module with no default export is the SyntaxError ES raises at link time
 * (ResolveExport answers null, §16.2.1.6.3). TypeScript reports it (TS1192) for every module it
 * knows to be one; the gap is a syntax-free `.js` ES module, which it takes for CommonJS and gives a
 * synthesized default (plan.md §9 Task 6.29). */
function missingDefault(target: ts.SourceFile): GateResult | undefined {
  return isSyntaxFreeEsModule(target)
    ? {
        kind: 'never',
        code: 'STA3004',
        message:
          `${target.fileName} has no default export: it is an ES module ("type": "module") ` +
          'with no export statement',
      }
    : undefined;
}

/** `ns.x` where `ns` is a module namespace: a member the lowering resolves to the export's own
 * binding. */
function isNamespaceMember(
  node: ts.PropertyAccessExpression,
  typeChecker: ts.TypeChecker,
): boolean {
  return namespaceModule(typeChecker.getTypeAtLocation(node.expression)) !== undefined;
}

/** An import declaration. `import './x'` contributes an edge to the module graph and nothing
 * else; `import type` is erased whole; every binding shape -- named, renamed, default,
 * namespace -- aliases the exporting module's binding (plan.md §11c T11.5a). */
function gateImport(node: ts.ImportDeclaration, typeChecker: ts.TypeChecker): GateResult {
  if (node.importClause?.isTypeOnly === true) {
    return { kind: 'accept' };
  }
  const specifier = gateModuleSpecifier(node.moduleSpecifier, typeChecker);
  if (specifier.kind !== 'accept') {
    return specifier;
  }
  const target = typeChecker.getSymbolAtLocation(node.moduleSpecifier)?.valueDeclaration;
  if (node.importClause?.name !== undefined && target !== undefined && ts.isSourceFile(target)) {
    const missing = missingDefault(target);
    if (missing !== undefined) return missing;
  }
  // A namespace of a declaration file has no module behind it: its bindings are extern C
  // functions (docs/FFI.md §1), called by name, with no slot a namespace object could read.
  const bindings = node.importClause?.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    if (target !== undefined && ts.isSourceFile(target) && target.isDeclarationFile) {
      return notYet('a namespace import of a declaration file is not yet supported', 5);
    }
  }
  return { kind: 'accept' };
}

/** The specifier rules every module edge obeys, an import's and a re-export's alike: a bare
 * specifier is a package, a relative one names its extension, and `std/` is a reserved prefix. */
function gateModuleSpecifier(spec: ts.Expression, typeChecker: ts.TypeChecker): GateResult {
  if (ts.isStringLiteral(spec)) {
    // `std/…` is a reserved prefix, not a package (docs/STD.md §1): a known module is an ordinary
    // edge into the std sources, judged by the clause rules below like any relative import. A
    // refused specifier that resolved to no file was already refused, with this same code, where
    // the checker's "cannot find module" is mapped (program.ts `stdImportRefusal`); the gate
    // answers only the ones the `paths` mapping did reach (`std/internal/error`), so each
    // refusal is reported once.
    const std = classifyStdSpecifier(spec.text);
    if (
      std !== undefined &&
      std.kind !== 'module' &&
      typeChecker.getSymbolAtLocation(spec) !== undefined
    ) {
      return std.kind === 'unknown'
        ? { kind: 'never', code: std.code, message: std.message }
        : { kind: 'not-yet', code: std.code, message: std.message, phase: std.phase };
    }
    // A Node built-in is never a package (docs/BUNDLER.md §1). Under `--node` a landed one
    // resolved into `packages/node` and is an ordinary edge; every other one resolved to nothing
    // and was refused where the checker's "cannot find module" is mapped (program.ts
    // `edgeRefusal`), with the platform's answer.
    if (nodeBuiltinId(spec.text) !== undefined) {
      const target = typeChecker.getSymbolAtLocation(spec)?.valueDeclaration;
      if (target === undefined || (ts.isSourceFile(target) && isNodeSourceFile(target.fileName))) {
        return { kind: 'accept' };
      }
    }
    // The `--node` location rewrite's own import of its helpers, spelled absolute where no
    // relative path reaches them (`nodeLocationModule`). Not a package, and the same file a
    // relative import of it already reaches.
    if (spec.text === nodeLocationModule()) {
      return { kind: 'accept' };
    }
    // Bare specifier: a package. In js mode the bundler takes it (plan.md §11d T12.1), and the
    // vendor rewrite turns every import declaration and re-export of one into an import of the
    // vendor module, so a package specifier left here is ts mode, `--bundler=none`, or a form
    // the rewrite does not take: `import()`, `export * from` a second package (the bundle cannot
    // say which star a name came from), or the deprecated `assert` attributes (plan.md T12.3).
    if (std === undefined && !spec.text.startsWith('./') && !spec.text.startsWith('../')) {
      // No `phase`: ts mode never bundles (a bundler strips the types it compiles), and no open
      // phase owns the remaining forms — a phase number here would tell the user to wait for a
      // release that has no card for the work (src/support/phases.ts).
      return {
        kind: 'not-yet',
        code: 'STA1214',
        message:
          'importing a package is not yet supported here (a package reaches a program only ' +
          'through the js-mode bundler, which takes import declarations, re-exports and ' +
          "one package's `export *`; " +
          'docs/BUNDLER.md)',
      };
    }
    // Node ESM never resolves an extensionless relative specifier, and Node is the ground truth
    // the golden tests hold this compiler to. The Bundler-style resolution the checker runs
    // WOULD resolve it, which is exactly why the gate has to say no here.
    if (std === undefined && !/\.[cm]?[tj]s$/.test(spec.text)) {
      return {
        kind: 'never',
        code: 'STA1113',
        message:
          "a relative import must name the file's extension (./x.ts, ./x.js) — " +
          'Node ESM does not resolve extensionless specifiers',
      };
    }
  }
  return { kind: 'accept' };
}

/** Which CommonJS binding a free identifier reads or writes (plan-notes 315, 316): `require`,
 * `__filename`, `__dirname`, `module` as the base of `module.exports`, or `exports` itself.
 * `typeof module` / `typeof exports` is a probe, not a use: a UMD wrapper asks it in every
 * environment, and it answers `'undefined'`. */
function commonJsBinding(
  node: ts.Identifier,
  typeChecker: ts.TypeChecker,
): CommonJsBinding | undefined {
  for (const name of ['__filename', '__dirname'] as const) {
    if (isFreeCommonJsName(node, name, typeChecker)) return name;
  }
  if (isFreeCommonJsName(node, 'require', typeChecker)) {
    return 'require()';
  }
  if (ts.isTypeOfExpression(node.parent)) {
    return undefined;
  }
  if (isFreeCommonJsName(node, 'exports', typeChecker)) {
    return 'exports';
  }
  const parent = node.parent;
  const exportsOf =
    (ts.isPropertyAccessExpression(parent) && parent.name.text === 'exports') ||
    (ts.isElementAccessExpression(parent) &&
      ts.isStringLiteralLike(parent.argumentExpression) &&
      parent.argumentExpression.text === 'exports');
  return exportsOf && parent.expression === node && isFreeCommonJsName(node, 'module', typeChecker)
    ? 'module.exports'
    : undefined;
}

/** One code for the whole Phase 2 boundary. These constructs are not deferred for six different
 * reasons -- they are deferred for one, the walking skeleton, and they all arrive together. The
 * message names the construct; the code names the boundary. */
function notYet(message: string, phase: number): GateResult {
  return {
    kind: 'not-yet',
    code: 'STA1214',
    message: `${message}; planned for Phase ${phase}`,
    phase,
  };
}

/** A BigInt literal, or a value whose type may be a bigint (plan.md §9 Task 6.25).
 *
 * A name is judged by its DECLARED type, not the narrowed one: `typeof u === 'bigint'` narrows an
 * `unknown` to bigint in a branch no compiled program can enter, because every way to make a
 * bigint is refused here (node:assert's `inspect` has exactly that branch). A declaration's own
 * name is not a value read; its uses are. */
function isBigIntUse(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isBigIntLiteral(node)) {
    return true;
  }
  if (!ts.isExpression(node) || ts.getNameOfDeclaration(node.parent as ts.Declaration) === node) {
    return false;
  }
  const named = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node)
      ? node.name
      : undefined;
  const symbol = named === undefined ? undefined : checker.getSymbolAtLocation(named);
  const type =
    symbol === undefined ? checker.getTypeAtLocation(node) : checker.getTypeOfSymbol(symbol);
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => (part.flags & ts.TypeFlags.BigIntLike) !== 0);
}

function symbolNotYet(): GateResult {
  return {
    kind: 'not-yet',
    code: 'STA1212',
    message: 'Symbol is not yet supported; planned for Phase 5',
    phase: 5,
  };
}

/** `Symbol` as the base of a `[Symbol.iterator]` computed class-method name. */
function isSymbolIteratorComputedBase(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    ts.isComputedPropertyName(parent.parent) &&
    frontendTypes.isGlobalSymbolIteratorName(parent.parent, checker)
  );
}

/** One not-yet for both dynamic-code-generation constructs — they land together in Phase 8. */
function jsDynamicCode(): GateResult {
  return {
    kind: 'not-yet',
    code: 'STA1206',
    message:
      'eval() and new Function() are not yet supported in js mode; planned for Phase 8 (dynamic tier)',
    phase: 8,
  };
}

/** `eval` in ts mode is a permanent never; in js mode it waits on Phase 8's interpreter tier. */
function evalResult(mode: Mode): GateResult {
  return mode === 'ts'
    ? {
        kind: 'never',
        code: 'STA1101',
        message:
          'eval() is not allowed in ts mode — it prevents static analysis and is a permanent design choice',
      }
    : jsDynamicCode();
}

/** `new Function` / `Function(...)` — same split, different ts-mode code. */
function functionCtorResult(mode: Mode): GateResult {
  return mode === 'ts'
    ? {
        kind: 'never',
        code: 'STA1103',
        message: 'new Function() is not allowed in ts mode — code generation is not supported',
      }
    : jsDynamicCode();
}

/** The two spellings of dynamic code generation: a bare/`globalThis` `eval`, or the `Function` ctor.
 *
 * `Function` is identified through the same declaration-file test `Date` uses, so a user
 * `class Function` stays on the ordinary class path. `eval` is the same test; it is also recognized
 * as `globalThis.eval`, which is the other form DIAGNOSTICS.md names. A user method named `eval`
 * is not this — only `globalThis` as the receiver. */
function dynamicCodeGeneration(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): 'eval' | 'function' | undefined {
  if (isGlobalNamed(expression, checker, 'eval')) {
    return 'eval';
  }
  if (isGlobalNamed(expression, checker, 'Function')) {
    return 'function';
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'globalThis'
  ) {
    if (expression.name.text === 'eval') {
      return 'eval';
    }
    if (expression.name.text === 'Function') {
      return 'function';
    }
  }
  return undefined;
}

/** `Date`'s residue code, as `STA1211` is `RegExp`'s: a Date member outside the landed tables is
 * refused under its own number rather than the generic `STA1214`, so a program can tell "this
 * builtin is partly here" from "this construct is not".
 *
 * Slices A and B landed the whole surface Phase 4 owns, so the ten sites that reach here split two
 * ways and the helper takes the phase rather than hardcoding one (plan-notes 136). ARITY and
 * SPREAD refusals are ordinary lowering work and name Phase 5; the MEMBER catch-all is now exactly
 * the ICU-dependent family -- `toString`/`toTimeString`, whose output carries the zone's long
 * display name, and the three `toLocale*` -- whose blocker is the FEATURE BUILD and therefore no
 * phase at all (src/support/phases.ts), so it omits `phase` and names the flag. */
function dateNotYet(message: string, phase?: number): GateResult {
  return phase === undefined
    ? {
        kind: 'not-yet',
        code: 'STA1210',
        message:
          `${message} needs the ICU feature build: rebuild with ` +
          '`just runtime-intl` and compile with STATOR_RUNTIME=intl',
      }
    : {
        kind: 'not-yet',
        code: 'STA1210',
        message: `${message} is not yet supported; planned for Phase ${String(phase)}`,
        phase,
      };
}

/** Readable construct names for the catch-all message. `ts.SyntaxKind[kind]` gives the enum name
 * ("ForStatement"), which is accurate but reads like an internal error to a user. */
function describeKind(kind: ts.SyntaxKind): string {
  switch (kind) {
    // The C-style `for` is lowered; these two are not, and they are deferred for a reason of
    // their own -- both iterate a collection, so they arrive with arrays and the object model
    // rather than with control flow.
    case ts.SyntaxKind.ForOfStatement:
      return 'for...of loops';
    case ts.SyntaxKind.ForInStatement:
      return 'for...in loops';
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return 'classes';
    case ts.SyntaxKind.ArrayLiteralExpression:
      return 'array literals';
    case ts.SyntaxKind.ElementAccessExpression:
      return 'index access';
    case ts.SyntaxKind.ConditionalExpression:
      return 'the conditional (?:) operator';
    case ts.SyntaxKind.ImportDeclaration:
    case ts.SyntaxKind.ExportDeclaration:
    case ts.SyntaxKind.ExportAssignment:
      return 'modules';
    default:
      return `this construct (${syntaxKindName(kind)})`;
  }
}

/** The declaration an import specifier names, for constructs that answer for the target
 * rather than the spelling: an imported generic reads its declaration's tuple rules, not the
 * importer's. Falls back to the node's own declaration for anything but an alias. */
function aliasedDeclaration(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol?.valueDeclaration;
  }
  return checker.getAliasedSymbol(symbol).valueDeclaration;
}

/** Re-exported for the lowering, which skips exactly the formations the gate accepts, so the
 * two cannot disagree about which declarators bind nothing. Defined in `./types.ts`, where the
 * alias resolution that also asks this question lives. */
export { isSingleConstDeclarator } from './types.ts';

/** Whether every constituent of `type` is a class CONSTRUCTOR type (`typeof K`): exactly one
 * construct signature, whose result is a named class's instance. A built-in constructor
 * interface (`typeof TypeError`) is not one -- its value has no class object in this subset (the
 * error constructors are runtime entries, not descriptors) -- and neither is a plain function,
 * which constructs nothing the checker can name (TS7009 asks for `new` on one). */
function classConstructorTypeOf(type: ts.Type): boolean {
  const kinds = type.isUnion() ? type.types : [type];
  return kinds.every((constituent) => {
    const signatures = constituent.getConstructSignatures();
    const signature = signatures.length === 1 ? signatures[0] : undefined;
    if (signature === undefined) {
      return false;
    }
    const like = frontendTypes.classLikeOf(signature.getReturnType());
    return like !== undefined && classDisplayName(like) !== undefined;
  });
}

function isModuleClauseName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isNamespaceExport(parent)
  );
}

/** Cross-function references are what rung 4b implements, so an identifier is accepted on its own.
 * The one shape held back: a binding declared inside a loop is a FRESH binding per iteration, and
 * rung 4b gives a function one environment per call, so every iteration's closure would share the
 * one slot and read the last iteration's value. Reject the capture rather than emit that program. */
function gateIdentifier(
  node: ts.Identifier,
  typeChecker: ts.TypeChecker,
  mode: Mode,
  onNode: boolean,
): GateResult {
  // A name in an import or export clause is a boundary spelling, never evaluated: it names the
  // binding the lowering aliases (plan.md §11c T11.5a), whatever that binding is.
  if (isModuleClauseName(node)) {
    return { kind: 'accept' };
  }
  const binding = commonJsBinding(node, typeChecker);
  if (binding !== undefined) {
    return commonJsVerdict(binding, mode, onNode);
  }
  const symbol = typeChecker.getSymbolAtLocation(node);
  const decl = symbol?.valueDeclaration;
  // A class NAME is not a value here. Five spellings are not uses of the value and must pass: the
  // declaration's own name, the callee of `new`, the right operand of `instanceof`, the base of an
  // `extends` clause (each consumes the whole construct, and the emitter names the descriptor), and
  // a type annotation -- `x: Point` mentions the class as a TYPE, which erases. What is left is a class being passed, stored or
  // compared, which needs the class object rung 6b allocates.
  if (
    decl !== undefined &&
    ts.isClassDeclaration(decl) &&
    ts.getNameOfDeclaration(decl) !== node &&
    !ts.isTypeNode(node.parent) &&
    !namesAClassInPlace(node, typeChecker) &&
    !isClassAliasFormation(node)
  ) {
    return notYet('using a class as a value is not yet supported', 5);
  }
  // `const K = C` binds no value (see `aliasedClassDeclaration` in `./types.ts`): every use
  // that reads the alias as a value is the same class-as-value construct the arm above refuses
  // and stays STA1214 under the same message. Three shapes read no value at all -- a type
  // annotation (which erases), a heritage base (which names a layout; the heritage rule gives
  // its own verdict for an alias there), and an import/export specifier (a boundary spelling
  // that is never evaluated) -- and the formation's own right-hand side and the three in-place
  // spellings erase to the target declaration (`const J = K`, `new K`, `K.static`,
  // `o instanceof K`).
  if (frontendTypes.isClassAliasUse(node, typeChecker)) {
    return isClassAliasNonValueUse(node) ||
      isClassAliasFormation(node) ||
      isClassAliasUseInPlace(node, typeChecker)
      ? { kind: 'accept' }
      : notYet('using a class as a value is not yet supported', 5);
  }
  // The inner name of a class expression declares, exactly like a declaration's own name
  // above: `D` in `const C = class D { … }` binds the class body, not a value.
  if (ts.isClassExpression(node.parent) && node.parent.name === node) {
    return { kind: 'accept' };
  }
  // `const C = class …` binds no value either (see `classExpressionTarget` in `./types.ts`):
  // the formation emits the descriptor, and every in-place use erases to the expression —
  // `new C`, `C.static`, `o instanceof C`, and (through `baseClassOf`) `extends C`. The
  // same in-place spellings pass here as for declarations and aliases, and anything else
  // reads the class object and stays STA1214 under the same message. An import/export
  // specifier is a boundary spelling that is never evaluated, exactly as for aliases.
  if (
    (frontendTypes.classExpressionTarget(node, typeChecker) ??
      frontendTypes.innerClassExpression(node, typeChecker)) !== undefined
  ) {
    return ts.isImportSpecifier(node.parent) ||
      ts.isExportSpecifier(node.parent) ||
      namesAClassInPlace(node, typeChecker)
      ? { kind: 'accept' }
      : notYet('using a class as a value is not yet supported', 5);
  }
  // The constructor has no VALUE (docs/FFI.md §2): aliasing it (`const f = outSlot`)
  // would smuggle calls past the shape the call arm proves, and the lowering has no closure
  // to load for one — which used to be a silent STA4021. Asked ahead of the generic-alias
  // formation below, which would otherwise accept the spelling as a specialization alias.
  // Refused where the use sits, so the diagnostic names the aliasing, not a downstream
  // disagreement.
  if (node.text === 'outSlot' && !isOutSlotCallee(node, typeChecker)) {
    const aliasSymbol = typeChecker.getSymbolAtLocation(node);
    const aliasDecl = aliasSymbol?.valueDeclaration;
    if (
      aliasDecl !== undefined &&
      ts.isFunctionDeclaration(aliasDecl) &&
      aliasDecl.body === undefined &&
      aliasDecl.name?.text === 'outSlot'
    ) {
      return {
        kind: 'never',
        code: 'STA1125',
        message:
          'outSlot has no value to alias — only direct outSlot<T>() calls construct slots (docs/FFI.md)',
      };
    }
  }
  // `const f = box` aliases the generic under a name calls specialize by: the read forms no
  // value (the tuple always comes from a call), but the single-const-declarator spelling is how
  // a specialization earns a second name. Anything else stays on the refusals below.
  if (
    genericAliasTarget(node, typeChecker) !== undefined &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node &&
    frontendTypes.isSingleConstDeclarator(node.parent)
  ) {
    return { kind: 'accept' };
  }
  // A generic passed as an argument: a determinable one specializes at the parameter's
  // function type — the only static description of how the value will be used — and anything
  // else takes the canonical value tuple (defaults, else Unknown), which the lowering
  // collects beside the static ones. Either way the position names a specialization, so this
  // carves every non-spread argument position out of the refusal below; a spread element has
  // no single parameter to read, and what escapes further (returned, stored) still waits on
  // the dynamic tier.
  if (
    ts.isCallExpression(node.parent) &&
    node.parent.expression !== node &&
    genericAliasTarget(node, typeChecker) !== undefined
  ) {
    return { kind: 'accept' };
  }
  // `typeof id` answers "function" for every specialization, so it folds without naming one:
  // the lowering answers the literal directly and no value is ever built.
  if (
    ts.isTypeOfExpression(node.parent) &&
    node.parent.expression === node &&
    genericValueInstantiation(node, typeChecker) !== undefined
  ) {
    return { kind: 'accept' };
  }
  // A generic function has no value: monomorphization replaces it with one specialization per
  // tuple, and `const f = box` names none of them. The declaration's own name is exempt, and so is
  // a callee, which is the one position where a tuple exists to pick a specialization by. An
  // imported generic resolves through its alias, so it answers for the declaration, not the
  // specifier — except the specifier's own spelling, which merely binds the name.
  const aliased =
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? aliasedDeclaration(symbol, typeChecker)
      : decl;
  if (
    aliased !== undefined &&
    ts.isFunctionDeclaration(aliased) &&
    aliased.typeParameters !== undefined &&
    aliased.typeParameters.length > 0 &&
    ts.getNameOfDeclaration(aliased) !== node &&
    !ts.isImportSpecifier(node.parent) &&
    !(ts.isCallExpression(node.parent) && node.parent.expression === node)
  ) {
    return notYet('using a generic function as a value is not yet supported', 5);
  }
  // A `const` holding a generic arrow has no value either — only its specializations do. The
  // declarator's own name is exempt, and so is a callee, the one position with a tuple.
  if (
    aliased !== undefined &&
    ts.isVariableDeclaration(aliased) &&
    aliased.initializer !== undefined &&
    genericArrowKey(aliased.initializer) !== undefined &&
    aliased.name !== node &&
    !ts.isImportSpecifier(node.parent) &&
    !(ts.isCallExpression(node.parent) && node.parent.expression === node)
  ) {
    return notYet('using a generic function as a value is not yet supported', 5);
  }
  // An alias has no value either — only the calls through it do. The declarator's own name is
  // exempt, and so is a callee; formation and argument positions were accepted above, so what
  // reaches here escapes (returned, stored, branched on) and has no tuple to specialize to.
  if (
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.name !== node &&
    !ts.isImportSpecifier(node.parent) &&
    !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
    genericAliasTarget(node, typeChecker) !== undefined
  ) {
    return notYet('using a generic function as a value is not yet supported', 5);
  }
  // An extern name (docs/FFI.md §1): the call arm already decided the direct call, so the
  // callee position accepts here and every other position is refused — an extern has no VALUE
  // to alias, pass, or read. An import specifier only BINDS the name, so it stays on the
  // specifier arm's verdict rather than earning a value-use refusal for being spelled.
  if (
    externDeclarationOfSymbol(symbol, typeChecker) !== undefined &&
    !ts.isImportSpecifier(node.parent)
  ) {
    // No `phase`: v0 has no C value representation for an extern (docs/FFI.md §6), and no
    // open phase owns one — a phase number here would tell the user to wait for a release
    // that has no card for the work (src/support/phases.ts).
    return isDirectCalleePosition(node)
      ? { kind: 'accept' }
      : {
          kind: 'not-yet',
          code: 'STA1217',
          message:
            'using an extern function as a value is not yet supported (v0 has no C value ' +
            'representation for externs; docs/FFI.md section 6)',
        };
  }
  // The slot constructor's callee (docs/FFI.md §2): the call arm already decided the direct
  // call, so the callee position accepts here — mirroring the extern carve-out above. Any
  // other position falls through to the ordinary global/binding arms below.
  if (node.text === 'outSlot' && isOutSlotCallee(node, typeChecker)) {
    return { kind: 'accept' };
  }
  // A global the compiler does not model -- `JSON`, `Math`, `globalThis`, `console` as a value, a
  // global function read rather than called, and everything else that resolves outside the
  // module being compiled. The lowering creates bindings only for declarations it lowers, so every
  // one of these used to be ACCEPTED here and then hit `STA4035 identifier used before
  // declaration` -- an INTERNAL error, for legal source. The accept set has to equal the HIR's
  // vocabulary (plan §0), and the HIR has no vocabulary for the global object.
  //
  // `undefined` is the one exception, and it is exempted by name here because the lowering
  // special-cases it by name too: it answers with an undefined-literal, and both sides have to
  // agree or the invariant above is broken again in the other direction.
  // `NaN` and `Infinity` join `undefined` in the by-name exemption: the lowering answers each
  // with a number literal, and cDoubleLiteral already spells both in C.
  if (
    symbol !== undefined &&
    node.text !== 'undefined' &&
    node.text !== 'NaN' &&
    node.text !== 'Infinity' &&
    isGlobalReference(node)
  ) {
    // Declared in a declaration file (`lib.es5.d.ts`, `stator.globals.d.ts`) -- an ambient value
    // with no body to lower -- or declared nowhere at all, which is how the checker models
    // `globalThis`. `every` rather than `some`: a name that IS declared in user code is a
    // user binding, whatever else merges into it.
    const declarations = symbol.declarations ?? [];
    if (declarations.every((d) => d.getSourceFile().isDeclarationFile)) {
      // `eval` and `Function` as VALUES are the same constructs as the call/`new` forms — aliasing
      // them (`const e = eval`) is how a program hides a dynamic-code site from a callee check.
      if (node.text === 'eval') {
        return evalResult(mode);
      }
      if (node.text === 'Function') {
        return functionCtorResult(mode);
      }
      if (
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        node.parent.right === node &&
        INSTANCEOF_BUILTINS.has(node.text)
      ) {
        return { kind: 'accept' };
      }
      if (node.text === 'Symbol') {
        // `[Symbol.iterator]` as a class method name is the well-known iterator, not the primitive.
        // Every other use (`Symbol("id")`, `Symbol.iterator` as a stored value, `Symbol.for`) stays
        // STA1212 until the primitive lands — except `u[Symbol.iterator]` as an element key, which
        // the element gate owns (static dispatch or the precise GetIterator refusal), so the
        // identifier is never the refusal there either.
        if (isSymbolIteratorComputedBase(node, typeChecker)) {
          return { kind: 'accept' };
        }
        const keyUse = node.parent;
        if (
          ts.isPropertyAccessExpression(keyUse) &&
          keyUse.expression === node &&
          ts.isElementAccessExpression(keyUse.parent) &&
          keyUse.parent.argumentExpression === keyUse &&
          frontendTypes.isSymbolIteratorKey(keyUse, typeChecker) &&
          acceptsSymbolKeyBase(keyUse.parent.expression, typeChecker)
        ) {
          return { kind: 'accept' };
        }
        return symbolNotYet();
      }
      // A global function as a CALLEE: gateCall already vetted the call (plan.md §11c T11.4), and
      // the lowering answers it with one node -- the function itself is never a value.
      if (
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        globalFunctionOf(node, typeChecker) !== undefined
      ) {
        return { kind: 'accept' };
      }
      // `typeof JSON`, `typeof parseInt`: a global the language defines has a fixed `typeof`,
      // which the lowering folds to its string -- the feature test `typeof JSON !== "undefined"`
      // reads no value at all.
      if (ts.isTypeOfExpression(node.parent) && globalTypeofOf(node, typeChecker) !== undefined) {
        return { kind: 'accept' };
      }
      // A catch-all keeps the phase that owns MOST of what it refuses (plan §7 Task 4.7 step 5).
      // What is left of the global surface is `Symbol` and the iterator protocol around it, which
      // is Phase 5 step 8; `globalThis` and `Reflect` are Phase 8's, and `Proxy` is a `never` the
      // ts-mode table answers before this arm is reached, so neither moves the majority.
      return notYet(`the global '${node.text}' is not yet supported`, 5);
    }
  }
  if (decl === undefined || enclosingFunction(decl) === enclosingFunction(node)) {
    return { kind: 'accept' };
  }
  // No phase: the refusal waits on a run-time TDZ check, which no open phase has a card for.
  if (mayRunInOwnInitializer(node, decl)) {
    return {
      kind: 'not-yet',
      code: 'STA1214',
      message: `reading '${node.text}' from a function that may run during its own initializer is not yet supported (no run-time TDZ check)`,
    };
  }
  // `var` is function-scoped even when its spelling sits inside a loop, so capturing it is the
  // ordinary shared-binding case — every closure sees one slot, which is already what env
  // capture implements. `let`/`const` in a loop are the ones that still need per-iteration
  // bindings, and those stay not-yet.
  return { kind: 'accept' };
}

/** `x as T` and `typeof x`.
 *
 * Both are accepted unconditionally, and the interesting one is `as`. A cast is the program
 * overruling the checker, so it is exactly where golden rule 4 applies — but "refuse what cannot be
 * checked" would be the wrong reading of that rule here. Where the asserted type is one a tag
 * settles, the lowering inserts a `jsrt_check_*` and the claim becomes true. Where it is not, the
 * lowering keeps the value `unknown`: the cast is DROPPED rather than believed, and every operation
 * downstream stays on the dynamic path it would have taken without the cast. Nothing trusts an
 * unproven type either way, which is what the rule actually asks for.
 *
 * Refusing instead would also be a regression: `m.get(k) ?? d` and every other narrowing the
 * compiler already handles dynamically would stop compiling in exchange for no soundness at all.
 *
 * `<T>x`, the older angle-bracket spelling, is a different node and is not accepted here: it is
 * ambiguous with JSX, banned in `.tsx`, and adds a second syntax for a construct that has one. */

/** The two expressions that name a class without reading it as a value: `new C(...)` and
 * `x instanceof C`. Each is one HIR node carrying the class NAME, so the emitter reaches the
 * `JSRTClass` descriptor directly and no class object has to exist. */
export const INSTANCEOF_BUILTINS: ReadonlySet<string> = new Set([
  'Array',
  'Object',
  'Function',
  'Date',
  'Map',
  'WeakMap',
  'Set',
  'WeakSet',
  'RegExp',
  'Promise',
  'Uint8Array',
  'ArrayBuffer',
  ...ERROR_CLASSES,
  'Boolean',
  'Number',
  'String',
]);

/** `C` in `const K = C`: the formation `aliasedClassDeclaration` erases, so the initializer
 * is never evaluated and needs no class object -- the same reason a type annotation is exempt
 * in `gateIdentifier`. Only the single-`const` spelling qualifies, mirroring the lowering's
 * skip exactly so the two cannot disagree about which formations bind nothing. */
function isClassAliasFormation(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    frontendTypes.isSingleConstDeclarator(parent)
  );
}

/** An alias where no value is read, mirroring the class arm's own exemptions: a type
 * annotation erases, a heritage base names a layout rather than reading one, and an
 * import/export specifier is a boundary spelling that is never evaluated. */
function isClassAliasNonValueUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isTypeNode(parent) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  );
}

/** The alias uses that erase to the target declaration: construction, static access, and the
 * `instanceof` right operand. (A heritage base erases too, but through `isClassAliasNonValueUse`
 * above plus `baseClassOf` resolving the alias -- not here.) */
function isClassAliasUseInPlace(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent;
  if (ts.isNewExpression(parent) && parent.expression === node) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node
  ) {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    frontendTypes.staticMemberOf(parent, checker, undefined) !== undefined
  );
}

function namesAClassInPlace(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent;
  if (ts.isNewExpression(parent)) {
    return parent.expression === node;
  }
  // `class B extends A` -- the base of a heritage clause, which names a layout rather than reading
  // a value. It is not a type NODE, so the type-position exemption does not cover it.
  if (ts.isExpressionWithTypeArguments(parent)) {
    return parent.expression === node;
  }
  // `C` in `class D extends NS.C` -- the name half of a member-expression heritage base, which
  // names a layout exactly as the bare base does above. The heritage rule judges the base; this
  // only keeps the walker from double-reporting the spelling. Any other member access keeps its
  // verdict: `o.m` still needs the method-value machinery and `C.prototype` the class object.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isExpressionWithTypeArguments(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return true;
  }
  // `C.count` -- the class NAME on the left of a static member access. It is not a value being
  // read: a static is one binding for the whole program, and the class name is half of its name.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return frontendTypes.staticMemberOf(parent, checker, undefined) !== undefined;
  }
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node
  );
}

/** Whether this identifier is a scope reference — a program actually READING the binding — as
 * opposed to a spelling that merely mentions the name. Three mentions reach the walker and none of
 * them is a use of the global they resolve to:
 *
 *   - a type position: `x: String` erases, and there is nothing to lower;
 *   - the NAME half of a property access: `s.length` and `p.x` are answered by the object's shape,
 *     never by scope, so the fact that `length` resolves to a lib declaration is an accident;
 *   - `console` in `console.log(x)`: the whole call is one HIR node that `gateCall` already vetted,
 *     and the walker descends into its children anyway;
 *   - the callee of `new`: `new Map()` is one HIR node naming a constructor, never a read of the
 *     binding. `gateNew` decides which constructors exist, and refuses the rest by itself — so
 *     answering "global" here would only add a second diagnostic to the same span.
 */
function isGlobalReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeNode(parent)) {
    return false;
  }
  // The property NAME in an object binding pattern (`const { length: n } = xs`) names a key of
  // the value being destructured. The checker resolves it to that property's declaration, which
  // for a lib type lives in a `.d.ts` -- but it reads no binding (plan-notes 310).
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  if (ts.isNewExpression(parent) && parent.expression === node) {
    return false;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent)) {
    // `Math` on the LEFT of a member access is exempt the way `console` is in `console.log`:
    // gateMemberAccess and gateCall judge the member itself, with a sharper message than a
    // blanket "the global 'Math'" — and the declaration-file test in isGlobalMath keeps a user
    // binding named Math on the ordinary identifier path. `String` is exempt the same way for
    // its namespace calls (`String.fromCharCode`, plan.md §8 step 19), and `Array` for
    // `Array.isArray` and `Number` for `Number.parseInt` (plan.md §11c T11.4).
    return !(
      parent.name === node ||
      (parent.expression === node &&
        (isConsoleLog(parent) ||
          node.text === 'Array' ||
          node.text === 'Number' ||
          node.text === 'Date' ||
          node.text === 'Uint8Array' ||
          node.text === 'ArrayBuffer' ||
          node.text === 'Math' ||
          node.text === 'Object' ||
          node.text === 'Promise' ||
          node.text === 'String' ||
          node.text === 'JSON'))
    );
  }
  return true;
}

/** The nearest enclosing function, never the node itself: a nested `function g` lives in the scope
 * of the function around it, and a parameter lives in the scope of the function it belongs to. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent as ts.Node | undefined; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      return n;
    }
  }
  return undefined;
}

/** Whether a read of a `let`/`const` binding sits in that binding's own initializer, inside a
 * function that may run before the binding exists (plan.md §9 Task 6.28).
 *
 * A closure in the initializer captures the binding, not its value, so `const g = (n) => g(n - 1)`
 * reads an initialized `g` whenever it is called afterwards. Called sooner -- an IIFE, a callback
 * the initializer hands to a call, a method a coercion invokes -- Node throws a TDZ
 * `ReferenceError`, and the compiled program has no TDZ check to throw it with: the slot would be
 * read before anything was stored in it. A read outside every function is TS2448, already fatal.
 * So the read passes only when the outermost function around it reaches the initializer through
 * containers that hand a function on without calling it. */
function mayRunInOwnInitializer(node: ts.Identifier, decl: ts.Declaration): boolean {
  if (
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    isVarDeclarationList(decl.parent)
  ) {
    return false;
  }
  const initializer = decl.initializer;
  let outermost: ts.Node | undefined;
  for (let n: ts.Node | undefined = node.parent; n !== initializer; n = n.parent) {
    if (n === undefined) {
      return false;
    }
    if (ts.isFunctionLike(n)) {
      outermost = n;
    }
  }
  if (ts.isFunctionLike(initializer)) {
    outermost = initializer;
  }
  if (outermost === undefined) {
    return true;
  }
  for (let n: ts.Node = outermost; n !== initializer; n = n.parent) {
    if (!passesOnUncalled(n.parent, n)) {
      return true;
    }
  }
  return false;
}

/** Whether evaluating `parent` yields `child`'s value, or stores it, without calling it. A
 * spread, a coercion (`'' + { toString() {…} }`) and a call are what this keeps out. */
function passesOnUncalled(parent: ts.Node, child: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isArrayLiteralExpression(parent)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent)) {
    return child !== parent.condition;
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.CommaToken
    );
  }
  if (ts.isPropertyAssignment(parent)) {
    return child === parent.initializer;
  }
  return ts.isObjectLiteralExpression(parent) && !ts.isSpreadAssignment(child);
}

/** The loop giving `decl` a fresh binding each iteration. Searched no further out than the function
 * that owns the declaration -- a loop outside that function re-runs the call, not the binding. */
export function loopScopeOf(decl: ts.Node): ts.Node | undefined {
  for (let n = decl.parent as ts.Node | undefined; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      return undefined;
    }
    if (ts.isIterationStatement(n, false)) {
      return n;
    }
  }
  return undefined;
}

function gateDeclarationList(list: ts.VariableDeclarationList, mode: Mode): GateResult {
  if ((list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.Const) !== 0) {
    return { kind: 'accept' };
  }
  // `var` is rejected in ts mode by DESIGN, not by schedule: function-scoped hoisting with
  // `undefined` initialization (no TDZ) is exactly the dynamic-scoping behaviour the strict
  // mode exists to exclude. It carries a never code and therefore no phase (plan §1.3). js
  // mode accepts it; the lowering desugars each binding to a function-scoped `let` initialized
  // `undefined`, then an assignment at the original site (plan.md §8 step 3).
  if (mode === 'ts') {
    return {
      kind: 'never',
      code: 'STA1104',
      message: 'var is not allowed in ts mode; use let or const instead',
    };
  }
  return { kind: 'accept' };
}

/** Identifier, or a shallow object/array pattern of identifiers with no rest, default, or nest. */
export function isSimpleBindingPattern(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) {
    return true;
  }
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.every(
      (el) =>
        el.dotDotDotToken === undefined &&
        el.initializer === undefined &&
        ts.isIdentifier(el.name) &&
        (el.propertyName === undefined || ts.isIdentifier(el.propertyName)),
    );
  }
  if (ts.isArrayBindingPattern(name)) {
    return name.elements.every(
      (el) =>
        ts.isOmittedExpression(el) ||
        (ts.isBindingElement(el) &&
          el.dotDotDotToken === undefined &&
          el.initializer === undefined &&
          ts.isIdentifier(el.name)),
    );
  }
  return false;
}

/** `({ a, b: c } = rhs)` / `[a, , b] = rhs`: the assignment twin of isSimpleBindingPattern, whose
 * targets are variables rather than new bindings (plan-notes 310). */
function isSimpleAssignmentPattern(
  pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): boolean {
  if (ts.isObjectLiteralExpression(pattern)) {
    return pattern.properties.every(
      (p) =>
        (ts.isShorthandPropertyAssignment(p) && p.objectAssignmentInitializer === undefined) ||
        (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isIdentifier(p.initializer)),
    );
  }
  return pattern.elements.every((el) => ts.isOmittedExpression(el) || ts.isIdentifier(el));
}

/** Whether the value of `node` is discarded: the whole of an expression statement, parentheses
 * aside. */
function isStatementPosition(node: ts.Expression): boolean {
  let at: ts.Node = node;
  while (ts.isParenthesizedExpression(at.parent)) {
    at = at.parent;
  }
  return ts.isExpressionStatement(at.parent);
}

function gateDeclaration(decl: ts.VariableDeclaration, checker: ts.TypeChecker): GateResult {
  if (!isSimpleBindingPattern(decl.name)) {
    return notYet('destructuring declarations are not yet supported', 5);
  }
  // Out-slot annotations must agree with the initializer (docs/FFI.md §2): an `Out<T>`
  // name holding anything else — or a non-`Out` name initialized by a slot — is a
  // representation lie the emitter cannot see, so the gate answers it. Unannotated names
  // infer from the initializer and need no rule; the checker already refuses the `ts`-mode
  // mistypings, which leaves `any` flows and `js`-suppressed mismatches to this arm.
  if (decl.type !== undefined && decl.initializer !== undefined) {
    const announced =
      frontendTypes.outSlotInner(checker.getTypeFromTypeNode(decl.type), checker) !== undefined;
    const held =
      frontendTypes.outSlotInner(checker.getTypeAtLocation(decl.initializer), checker) !==
      undefined;
    if (announced !== held) {
      return {
        kind: 'never',
        code: 'STA1125',
        message:
          'an Out<T> annotation must agree with its initializer — a slot is not a value ' +
          'of any other type (docs/FFI.md)',
      };
    }
  }
  return { kind: 'accept' };
}

/** The class whose body declares the private name `#n`, or `undefined` when the name does not
 * resolve to one. The checker's symbol for a private use is the declaration itself, so this is
 * lexical scoping, not a type query: an inherited brand resolves to the ancestor that declares
 * it, which is exactly the class `instanceof` must name. Shared by the gate's `in` arm and the
 * lowering's desugar, so the two cannot disagree about which class a brand means. */
export function brandDeclaringClass(
  name: ts.PrivateIdentifier,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  const member = checker.getSymbolAtLocation(name)?.valueDeclaration;
  if (
    member === undefined ||
    (!ts.isPropertyDeclaration(member) &&
      !ts.isMethodDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member))
  ) {
    return undefined;
  }
  // Declarations and bound expressions alike: a `#private` name is lexically scoped to the
  // class body that writes it, whichever spelling the body takes (plan.md §8 step 12(d)).
  // The display-name check is what keeps an unbound expression (no identity) resolving
  // nowhere, exactly as an unnamed declaration does.
  const parent = member.parent;
  return parent !== undefined &&
    (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) &&
    classDisplayName(parent) !== undefined
    ? parent
    : undefined;
}

function gateBinary(bin: ts.BinaryExpression, typeChecker: ts.TypeChecker, mode: Mode): GateResult {
  // Arithmetic that coerces (`- * / % **` and the compounds that fold to them): a composite
  // operand reaches ToPrimitive, which runs user `valueOf`/`toString` — the dynamic tier's work,
  // not the emitter's `jsrt_to_number` (which only answers NaN there). Primitives coerce without
  // user code (`"5" * 1` is 5, `true * 2` is 2, `null * 2` is 0, `undefined * 1` is NaN), so the
  // verifier admits them and they never reach this refusal; `+` is exempt because it concatenates
  // rather than coerces (plan.md §8 step 37). In `ts` mode the checker's own TS2362/TS2363 owns
  // every one of these programs, so refusing here too would report one mistake twice — and
  // `explain` would answer not-yet where the build answers error.
  if (
    mode === 'js' &&
    (bin.operatorToken.kind === ts.SyntaxKind.MinusToken ||
      bin.operatorToken.kind === ts.SyntaxKind.AsteriskToken ||
      bin.operatorToken.kind === ts.SyntaxKind.SlashToken ||
      bin.operatorToken.kind === ts.SyntaxKind.PercentToken ||
      bin.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
      bin.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
      bin.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken ||
      bin.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken ||
      bin.operatorToken.kind === ts.SyntaxKind.PercentEqualsToken ||
      bin.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
  ) {
    for (const operand of [bin.left, bin.right]) {
      const operandType = frontendTypes.tsTypeToHType(
        typeChecker.getTypeAtLocation(operand),
        typeChecker,
      );
      if (
        operandType.kind === 'object' ||
        operandType.kind === 'array' ||
        operandType.kind === 'map' ||
        operandType.kind === 'set' ||
        operandType.kind === 'iterator' ||
        operandType.kind === 'regexp' ||
        operandType.kind === 'date' ||
        operandType.kind === 'uint8array' ||
        operandType.kind === 'arraybuffer' ||
        operandType.kind === 'promise' ||
        operandType.kind === 'fn'
      ) {
        return notYet(`arithmetic on a ${hTypeName(operandType)} operand is not yet supported`, 8);
      }
    }
  }
  // Every compound assignment, `+=` through `??=`, which TypeScript numbers as one contiguous range.
  // `x += e` on an identifier folds to `x = x + e`, sound because a bare identifier cannot have
  // side effects. An element target cannot use that fold -- `a[i()] += 1` must call `i` ONCE --
  // so the lowering hoists the target and the index into temporaries and reads the element from
  // those (the promise rung 3 made in plan-notes 43, kept here).
  const op = bin.operatorToken.kind;
  if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) {
    if (!isAssignableTarget(bin.left, typeChecker, mode)) {
      return notYet('compound assignment to anything but a variable is not yet supported', 5);
    }
    return gateUpdate(bin, typeChecker, mode);
  }
  switch (bin.operatorToken.kind) {
    // Every operator BinaryOp and LogicalOp model, plus plain assignment. Loose equality is here
    // rather than deferred because docs/NUMERIC.md §6.3 defines it for primitives without any
    // object model: the `ToPrimitive` half of the table is unreachable while the only values are
    // primitives, and the lowering emits a runtime call that will grow that half in place.
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.QuestionQuestionToken:
      return { kind: 'accept' };

    // `x instanceof C`, and only where `C` is a class this compiler modelled. The right operand is
    // a class NAME, not a value: the emitter compares against a specific `JSRTClass` descriptor,
    // and `x instanceof (cond ? A : B)` has no descriptor to name. The left operand is anything at
    // all -- `1 instanceof C` is `false`, not an error.
    //
    // A generic class has one descriptor per tuple, so its bare name identifies nothing to
    // compare against. (There is no `instanceof Box<number>` spelling — the right operand is an
    // expression, and type arguments are not expressions.)
    case ts.SyntaxKind.InstanceOfKeyword: {
      // `x instanceof F` against an ordinary function or an untyped value answers through the
      // value's `prototype` at run time (`jsrt_instanceof_ctor`, plan-notes 310).
      if (mode === 'js' && frontendTypes.isFunctionValueCallee(bin.right, typeChecker)) {
        return { kind: 'accept' };
      }
      if (!ts.isIdentifier(bin.right)) {
        return notYet('instanceof against anything but a class name is not yet supported', 5);
      }
      const declaration = classDeclarationOf(typeChecker.getTypeAtLocation(bin.right));
      // A bound class expression — or an anonymous default export — names its descriptor
      // like a declaration does (plan.md §8 step 12(d)). Generic expressions have one
      // descriptor per tuple exactly like generic declarations, so the bare name identifies
      // nothing in both cases.
      const like =
        declaration ??
        frontendTypes.classLikeOf(typeChecker.getTypeAtLocation(bin.right)) ??
        (ts.isIdentifier(bin.right)
          ? (frontendTypes.classExpressionTarget(bin.right, typeChecker) ??
            frontendTypes.innerClassExpression(bin.right, typeChecker))
          : undefined);
      const typeParameters =
        declaration?.typeParameters ??
        (like !== undefined && ts.isClassExpression(like) ? like.typeParameters : undefined);
      if (typeParameters !== undefined && typeParameters.length > 0) {
        return notYet('instanceof against a generic class is not yet supported', 5);
      }
      return like !== undefined || INSTANCEOF_BUILTINS.has(bin.right.text)
        ? { kind: 'accept' }
        : notYet('instanceof against anything but a class name is not yet supported', 5);
    }

    case ts.SyntaxKind.AsteriskAsteriskToken:
    case ts.SyntaxKind.CommaToken:
      return { kind: 'accept' };

    case ts.SyntaxKind.InKeyword:
      // `#n in o` is the brand check, not a property `in`: true exactly when `o` is an instance
      // of a class declaring the private name. It lowers to `instanceof` against the
      // lexically-resolved declaring class, so the name must resolve to one.
      if (ts.isPrivateIdentifier(bin.left)) {
        return brandDeclaringClass(bin.left, typeChecker) !== undefined
          ? { kind: 'accept' }
          : notYet('the #brand-in-object test is not yet supported', 5);
      }
      return { kind: 'accept' };

    case ts.SyntaxKind.EqualsToken:
      // A bare name is HIR Assignment, `a[i] = v` is IndexAssignment, `o.x = v` is FieldAssignment.
      // Neither member form is re-checked here for what it is a member OF: this node's child is
      // gated in its own right, and gateElementAccess and gateMemberAccess are where that lives.
      // A dynamic-shape or Unknown member is a fourth target, DynFieldAssignment, for every
      // assignment form: the key is static, so the read-once machinery need only hoist the
      // receiver, and the fold reads and writes the shape-table entry through it.
      // So is a name the receiver's fixed layout never declared, `o.extra = v`: the write grows
      // the object's overflow table (docs/VALUE.md §4.24). Only the ELEMENT spelling over a class,
      // `c["extra"] = v`, is still refused, first. In `ts` mode the checker's own TS2339 owns the
      // program, so refusing here too would report one mistake twice — and `explain` would answer
      // not-yet where the build answers error.
      if (
        mode === 'js' &&
        ts.isElementAccessExpression(bin.left) &&
        isAbsentClassMemberWrite(bin.left, typeChecker)
      ) {
        return notYet('assigning a new property on a class instance is not yet supported', 8);
      }
      if (ts.isObjectLiteralExpression(bin.left) || ts.isArrayLiteralExpression(bin.left)) {
        return isStatementPosition(bin) && isSimpleAssignmentPattern(bin.left)
          ? { kind: 'accept' }
          : notYet(
              'destructuring assignment is supported only as a statement whose targets are ' +
                'variables, with no default, rest or nesting',
              5,
            );
      }
      // An Out-bound name takes only slots: anything else stored would read back as a handle
      // the callee never wrote (docs/FFI.md §2). Property targets hold copied bits and are
      // sound by construction, so only bare names are ruled here.
      if (ts.isIdentifier(bin.left)) {
        const bound = frontendTypes.outSlotInner(
          typeChecker.getTypeAtLocation(bin.left),
          typeChecker,
        );
        if (bound !== undefined) {
          const stored = bin.right;
          const storesSlot =
            frontendTypes.outSlotInner(typeChecker.getTypeAtLocation(stored), typeChecker) !==
            undefined;
          if (!storesSlot) {
            return {
              kind: 'never',
              code: 'STA1125',
              message:
                'an Out<T> binding takes only out-slots — anything else stored would read ' +
                'back as a handle the callee never wrote (docs/FFI.md)',
            };
          }
        }
      }
      if (isAssignableTarget(bin.left, typeChecker, mode)) {
        return { kind: 'accept' };
      }
      // `f.count = 0` in ts mode: the same property-table write js mode accepts above.
      if (
        ts.isPropertyAccessExpression(bin.left) &&
        frontendTypes.isFunctionValueMember(bin.left.expression, bin.left.name.text, typeChecker)
      ) {
        return functionMemberResult(mode);
      }
      // A name an object's type never declared: in `js` mode isAssignableTarget accepted it above
      // (the write grows the overflow table, docs/VALUE.md §4.24); in `ts` mode the checker's
      // TS2339 owns the program, and refusing here too would report one mistake twice.
      if (
        mode === 'ts' &&
        ts.isPropertyAccessExpression(bin.left) &&
        frontendTypes.tsTypeToHType(typeChecker.getTypeAtLocation(bin.left.expression), typeChecker)
          .kind === 'object'
      ) {
        return { kind: 'accept' };
      }
      return notYet('assignment to anything but a variable is not yet supported', 5);

    default:
      return notYet('this operator is not yet supported', 5);
  }
}

function gatePrefixUnary(
  unary: ts.PrefixUnaryExpression,
  typeChecker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  switch (unary.operator) {
    // `-x`, `+x`, `!x`, `~x` all map onto UnaryOp. `-<numeric literal>` additionally gets folded
    // into a single NumberLiteral by the lowering, but that is an optimization, not the reason
    // the operator is accepted.
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.ExclamationToken:
    case ts.SyntaxKind.TildeToken:
      return { kind: 'accept' };

    // `++x` reads AND writes; it is an assignment wearing an operator's clothes, so it is subject
    // to the same positional rule as compound assignment.
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
      if (!isAssignableTarget(unary.operand, typeChecker, mode)) {
        return notYet('++ and -- on anything but a variable are not yet supported', 5);
      }
      return gateUpdate(unary, typeChecker, mode);

    default:
      return notYet('this unary operator is not yet supported', 5);
  }
}

/** What a read-modify-write may be applied to: a variable, an array element, a layout field, an
 * array's `length`, a member of a dynamic-shape or Unknown receiver, or -- in `js` mode -- an own
 * property of an ordinary function (`f.count = 0`, `F.prototype.m = …`; plan-notes 310).
 *
 * Each is the HIR's vocabulary -- `Assignment`, `IndexAssignment`, `FieldAssignment` and
 * `DynFieldAssignment` -- and the gate's accept set
 * must equal that vocabulary exactly, which is why this is one predicate rather than a check
 * duplicated at each operator. The element case is admitted here and vetted for real by
 * gateElementAccess when the child node is reached. */
function isAssignableTarget(node: ts.Expression, checker: ts.TypeChecker, mode: Mode): boolean {
  if (ts.isIdentifier(node) || ts.isElementAccessExpression(node)) {
    return true;
  }
  if (!ts.isPropertyAccessExpression(node)) {
    return false;
  }
  // A class or constraint layout field.
  if (
    frontendTypes.classLikeOf(checker.getTypeAtLocation(node.expression)) !== undefined ||
    constraintDeclaration(checker.getTypeAtLocation(node.expression), checker) !== undefined
  ) {
    return true;
  }
  // A field through `T`: the constraint declares the layout, the checker proved the access
  // against it, and the lowering substitutes the concrete type per specialization. Method slots
  // take the same rule here classes do — a write replaces whatever the slot holds.
  const receiver = checker.getTypeAtLocation(node.expression);
  const constraint = typeParameterConstraint(receiver, checker);
  if (
    constraint !== undefined &&
    checker.getPropertyOfType(constraint, node.name.text) !== undefined
  ) {
    return true;
  }
  // A dynamic-shape or Unknown receiver: the shape table is the place, read and written by name
  // through the receiver the lowering evaluates once (plan-notes 310).
  if (frontendTypes.isDynamicShape(receiver, checker)) {
    return true;
  }
  if (
    mode === 'js' &&
    (frontendTypes.isFunctionValueMember(node.expression, node.name.text, checker) ||
      frontendTypes.isFunctionMemberRead(node.expression, checker) ||
      frontendTypes.isUndeclaredMemberRead(node, checker))
  ) {
    return true;
  }
  const shape = frontendTypes.tsTypeToHType(receiver, checker);
  // `a.length = n` resizes an array (ECMA-262 §10.4.2.4): shrinking drops the tail, a non-uint32
  // is a RangeError, and growing would create holes, which the runtime refuses (STA2002) as it
  // refuses a write past the end (plan-notes 310).
  return (
    shape.kind === 'unknown' ||
    (shape.kind === 'array' && node.name.text === 'length') ||
    (shape.kind === 'object' && shape.fields.some((f) => f.name === node.name.text))
  );
}

/** A write to a name a class never declared (`c.missing = 1`): JavaScript grows the object,
 * but a fixed layout has no slot to grow into — the symmetric "cannot grow" case STA2004 names
 * for reads, owned by Phase 8's dictionary mode (plan.md §8 step 37; the delete gate states the
 * same rule for the symmetric removal). Reads of the same name answer `undefined` through the
 * dynamic path; only writes refuse. Private names are excluded: `this.#x` is always declared
 * where it may be written, and anything else the checker refuses first. */
function isAbsentClassMemberWrite(target: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isElementAccessExpression(target)) {
    // The element twin of the property rule below: `c[k] = v` where `k` statically names a
    // member the class never declared grows the fixed layout, which waits on Phase 8's
    // dictionary mode. A runtime key is not absent, just dynamic -- gateElementAccess decides
    // it -- and a non-class receiver never reaches the layout question at all.
    const key = frontendTypes.elementStaticKey(target.argumentExpression, checker);
    if (key === null) {
      return false;
    }
    if (classDeclarationOf(checker.getTypeAtLocation(target.expression)) === undefined) {
      return false;
    }
    return (
      checker.getPropertyOfType(checker.getTypeAtLocation(target.expression), key) === undefined
    );
  }
  if (!ts.isPropertyAccessExpression(target) || ts.isPrivateIdentifier(target.name)) {
    return false;
  }
  if (classDeclarationOf(checker.getTypeAtLocation(target.expression)) === undefined) {
    return false;
  }
  return (
    checker.getPropertyOfType(checker.getTypeAtLocation(target.expression), target.name.text) ===
    undefined
  );
}

/** `++`/`--`/`+=`/`=` in any position: statement form folds to Assignment; value form is UpdateExpr. */
function gateUpdate(node: ts.Node, checker: ts.TypeChecker, mode: Mode): GateResult {
  // An absent member's read-modify-write grows the object: `c.missing += 1` reads `undefined` and
  // stores into the overflow table (docs/VALUE.md §4.24). Only the element spelling over a class,
  // `c["missing"] += 1`, is still refused. One predicate covers the compound, logical and update
  // spellings alike — plain `=` is decided in gateBinary, the one assignment form that does not
  // route through here. In `ts` mode the checker's own TS2339 owns the program (see gateBinary's
  // `=` arm for why the refusal is js-only).
  const target = ts.isBinaryExpression(node)
    ? node.left
    : ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? node.operand
      : undefined;
  if (
    mode === 'js' &&
    target !== undefined &&
    ts.isElementAccessExpression(target) &&
    isAbsentClassMemberWrite(target, checker)
  ) {
    return notYet('assigning a new property on a class instance is not yet supported', 8);
  }
  return { kind: 'accept' };
}

/** `delete o.a`, `delete o[e]`.
 *
 * Only the two access forms compile. `delete f()` is legal JavaScript that evaluates its operand
 * and answers `true`, but nothing is removed, so it is a statement wearing an operator's clothes
 * and stays on the catch-all until something asks for it.
 *
 * The receiver decides the rest. A FIXED shape has no encoding for a missing slot: in `ts` mode
 * the only one that can reach here is a class field (an optional property is what sends an
 * anonymous shape to the dynamic path, and a required one is TS2790), which §1.1 refuses
 * permanently as STA1108; in `js` mode the same receiver waits on Phase 8's dictionary mode, the
 * owner STA2004 already names for the symmetric "cannot grow" case. An ARRAY element needs a HOLE
 * the dense representation cannot express -- the gap `gateArrayLiteral` names for `[1, , 3]` -- so
 * a statically known array is refused here and an Unknown one aborts in the runtime (STA2007). */
function gateDelete(node: ts.DeleteExpression, checker: ts.TypeChecker, mode: Mode): GateResult {
  let operand: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(operand)) {
    operand = operand.expression;
  }
  if (!ts.isPropertyAccessExpression(operand) && !ts.isElementAccessExpression(operand)) {
    return notYet('delete of anything but a property access is not yet supported', 5);
  }
  const target = frontendTypes.tsTypeToHType(
    checker.getTypeAtLocation(operand.expression),
    checker,
  );
  // A name the layout never declared lives in the overflow table, which can lose it
  // (docs/VALUE.md §4.24); only a DECLARED slot has no encoding for absence.
  if (mode === 'js' && frontendTypes.isUndeclaredMemberRead(operand, checker)) {
    return { kind: 'accept' };
  }
  if (target.kind === 'object') {
    return mode === 'ts'
      ? {
          kind: 'never',
          code: 'STA1108',
          message:
            'delete on class fields is not supported in ts mode — classes have fixed shape at compile time',
        }
      : {
          kind: 'not-yet',
          code: 'STA1205',
          message:
            'delete on a statically-shaped object is not yet supported in js mode; planned for Phase 8 (dynamic tier)',
          phase: 8,
        };
  }
  // An array of an Unknown element may hold holes (docs/VALUE.md §4.4), so deleting one of its
  // elements leaves a hole; a typed element has no value that could stand for one.
  if (target.kind === 'array' && target.element.kind !== 'unknown') {
    return notYet('delete of an element of an array with a typed element is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/** The extern surface inside a `.d.ts` (docs/FFI.md §1): every marked declaration is
 * classified where it is written, so a bad signature fails at its own span rather than at some
 * call site in another file. Unmarked declarations are skipped — the file is still skipped. */
function gateExternDeclarations(
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  mode: Mode,
  diagnostics: Diagnostic[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && isExternDeclaration(node)) {
      const classified = classifyExternDeclaration(node, typeChecker);
      if (!classified.ok) {
        pushExternRefusal(node, classified, sourceFile, mode, diagnostics);
      }
    } else if (
      ts.isVariableStatement(node) &&
      ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'statorExtern')
    ) {
      // The marker on something that is not a function declaration: there is no call to lower
      // and no signature to classify, so the declaration itself is outside the table.
      diagnostics.push(
        diagnosticFromNode(
          node,
          sourceFile,
          'STA1119',
          'never',
          mode,
          '@statorExtern marks a function declaration only (docs/FFI.md)',
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  gateLinkPragmas(sourceFile, mode, diagnostics);
}

/** The `@statorLink` lines in one `.d.ts` (docs/FFI.md §9): malformed lines are refused where
 * they are written, and a pragma in a file with no extern declaration is refused rather than
 * linked silently or dropped silently — flags belong to the binding they link. At most one
 * `#include` per file: one binding file wraps one library, so a second header names a second
 * binding the file does not contain. All three are `never`: the pragma's shape is a permanent
 * surface rule, not a schedule. */
function gateLinkPragmas(sourceFile: ts.SourceFile, mode: Mode, diagnostics: Diagnostic[]): void {
  const pragmas = linkPragmasOf(sourceFile);
  if (pragmas.length === 0) {
    return;
  }
  const refuse = (line: number, col: number, message: string): void => {
    diagnostics.push(
      diagnosticFromFile(sourceFile.fileName, line, col, 'STA1119', 'never', mode, message),
    );
  };
  if (!fileHasExternDeclaration(sourceFile)) {
    const [first] = pragmas;
    refuse(
      first?.line ?? 1,
      first?.col ?? 1,
      '@statorLink has no effect in a file with no @statorExtern declaration; ' +
        'move it to the binding file (docs/FFI.md)',
    );
    return;
  }
  let headers = 0;
  for (const pragma of pragmas) {
    if (pragma.kind === 'invalid') {
      refuse(pragma.line, pragma.col, `refused @statorLink pragma: ${pragma.reason}`);
    } else if (pragma.kind === 'header') {
      headers += 1;
      if (headers > 1) {
        refuse(
          pragma.line,
          pragma.col,
          'one @statorLink #include per declaration file; a second header names a ' +
            'second binding this file does not contain (docs/FFI.md)',
        );
      }
    }
  }
}

/** One classified extern declaration as a gate diagnostic: never-codes stay never. Shared by
 * the declaration walk above and the call-site arm below, so the two cannot disagree about
 * which code a signature earns. (`phase` survives on the shape but no caller sets it: the
 * never refusals have none, and the remaining STA1217 position — extern-as-value — is emitted
 * directly by the identifier arm, phaseless, since no open phase owns it.) */
function pushExternRefusal(
  node: ts.Node,
  classified: { readonly code: string; readonly message: string; readonly phase?: number },
  sourceFile: ts.SourceFile,
  mode: Mode,
  diagnostics: Diagnostic[],
): void {
  if (classified.phase === undefined) {
    diagnostics.push(
      diagnosticFromNode(node, sourceFile, classified.code, 'never', mode, classified.message),
    );
  } else {
    diagnostics.push(
      diagnosticFromNode(
        node,
        sourceFile,
        classified.code,
        'not-yet',
        mode,
        classified.message,
        classified.phase,
      ),
    );
  }
}

/** An extern call (docs/FFI.md §1): a direct C call, decided before the property-access arms
 * because the callee is a bare identifier and the bottom fallthrough would accept it as an
 * ordinary call to a binding that does not exist. */
/** `outSlot<T>()` (docs/FFI.md §2): zero arguments and an unambiguous inner — the call
 * answers the pure zero-handle, so every position is sound and no position rule exists. An
 * optional call is not a call the lowering models (like externs, STA1217's reasoning): a
 * conditional slot creation has no unconditional cell to name. */
function gateOutSlotCall(call: ts.CallExpression, typeChecker: ts.TypeChecker): GateResult {
  if (call.questionDotToken !== undefined) {
    return {
      kind: 'never',
      code: 'STA1125',
      message: 'an optional outSlot() call is outside the out-slot contract (docs/FFI.md)',
    };
  }
  if (call.arguments.length !== 0) {
    return {
      kind: 'never',
      code: 'STA1125',
      message: 'outSlot() takes no arguments — the slot type rides the type argument (docs/FFI.md)',
    };
  }
  const inner = classifyOutSlotCall(call, typeChecker);
  return inner.ok ? { kind: 'accept' } : { kind: 'never', code: 'STA1125', message: inner.message };
}

function gateExternCall(
  call: ts.CallExpression,
  decl: ts.FunctionDeclaration,
  typeChecker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  // Placement first: the marker is only read in a `.d.ts` (docs/FFI.md §1). The DECLARATION's
  // file decides, never the caller's — which is also what makes Task 7.3's generator output a
  // drop-in. The declaration's own FunctionDeclaration earns the same code in gateFunction.
  if (!decl.getSourceFile().isDeclarationFile) {
    return {
      kind: 'never',
      code: 'STA1121',
      message: 'extern declaration is only legal in a .d.ts file; move it there (docs/FFI.md)',
    };
  }
  // An optional call IS a direct call: the callee always links (a missing C symbol fails
  // the build, so there is no binary in which `?.` could short-circuit), which makes `?.` a
  // proven no-op rather than a conditional the lowering must model. The identifier arm agrees
  // (`isDirectCalleePosition` accepts the `?.` callee for the same reason).
  return gateExternSignature(call, decl, typeChecker, mode);
}

/** The signature and shape half of `gateExternCall`, shared with nothing else: the call must
 * match the declared ABI tuple exactly. */
function gateExternSignature(
  call: ts.CallExpression,
  decl: ts.FunctionDeclaration,
  typeChecker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  // A spread's count is not its arity, and a C call's arity is exact — there is no tuple form
  // to spread into (docs/FFI.md §2).
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) {
    return {
      kind: 'never',
      code: 'STA1119',
      message: 'a spread argument to an extern call is outside the ABI table (docs/FFI.md)',
    };
  }
  const classified = classifyExternDeclaration(decl, typeChecker);
  if (!classified.ok) {
    return classified.phase === undefined
      ? { kind: 'never', code: classified.code, message: classified.message }
      : {
          kind: 'not-yet',
          code: classified.code,
          message: classified.message,
          phase: classified.phase,
        };
  }
  // A C call has no missing-means-`undefined` and no drop-extras (unlike `CallExpr`, whose
  // arity the language leaves open): the count is exact, permanently, so a mismatch is a never
  // rather than a schedule. In `ts` mode the checker already rejects it (arity, STA0012 — the
  // same passthrough an ordinary mismatched call earns), so firing here too would report one
  // mistake twice; this arm is what refuses it in `js` mode, where that diagnostic is
  // suppressed. Either way the lowering never sees a mismatch: its exact-length indexing is
  // guarded by an STA4031, not by trust.
  if (mode === 'js') {
    const want = classified.signature.params.length;
    const got = call.arguments.length;
    if (got !== want) {
      const plural = want === 1 ? '' : 's';
      return {
        kind: 'never',
        code: 'STA1119',
        message:
          `extern call '${classified.signature.tsName}' takes ${String(want)} argument${plural}, ` +
          `not ${String(got)} — C calls have fixed arity (docs/FFI.md)`,
      };
    }
  }
  // Out-pointer parameters take only proven slots (docs/FFI.md §2): the slot's own name, or
  // a fresh inline slot — an out-param WRITES through the pointer, so unlike a `T*` read no
  // runtime check can verify an address and only provenance is sound. In `ts` mode the
  // checker already refuses mistyped arguments (so firing here too would report one mistake
  // twice — the arity precedent above), which leaves `any`-typed flows and all of `js` mode
  // to this arm. Either way the lowering never sees a bad shape: its address-taking is
  // guarded by an STA4031, not by trust.
  const outParams = classified.signature.params;
  for (let index = 0; index < outParams.length; index += 1) {
    // The mirror refusal: a slot where a handle is required. Reading the handle spells
    // `.value` — passing the slot itself would hand the callee a cell address where it
    // reads a value. Same mode discipline as the out-pointer twin (the checker owns `ts`,
    // this arm owns `any` flows and `js`).
    if (outParams[index] === 'pointer') {
      const argument = call.arguments[index];
      if (argument === undefined) {
        continue;
      }
      const argType = typeChecker.getTypeAtLocation(argument);
      const slotWhereHandle = frontendTypes.outSlotInner(argType, typeChecker) !== undefined;
      const anyFlow = (argType.flags & ts.TypeFlags.Any) !== 0;
      if (slotWhereHandle && (mode === 'js' || anyFlow)) {
        return {
          kind: 'never',
          code: 'STA1125',
          message:
            `extern call '${classified.signature.tsName}' argument ${String(index + 1)} is ` +
            'an out-slot where a handle is required — read the handle through .value first ' +
            '(docs/FFI.md)',
        };
      }
      continue;
    }
    if (outParams[index] !== 'out-pointer') {
      continue;
    }
    const argument = call.arguments[index];
    if (argument === undefined) {
      continue;
    }
    const bare = skipParens(argument);
    const shapeOk =
      ts.isIdentifier(bare) ||
      (ts.isCallExpression(bare) &&
        outSlotDeclarationOf(bare, typeChecker) !== undefined &&
        classifyOutSlotCall(bare, typeChecker).ok);
    const argType = typeChecker.getTypeAtLocation(argument);
    const typedOk = frontendTypes.outSlotInner(argType, typeChecker) !== undefined;
    const anyFlow = (argType.flags & ts.TypeFlags.Any) !== 0;
    if ((shapeOk && typedOk) || (!typedOk && !anyFlow && mode === 'ts')) {
      continue;
    }
    return {
      kind: 'never',
      code: 'STA1125',
      message:
        `extern call '${classified.signature.tsName}' argument ${String(index + 1)} is not ` +
        'a proven out-slot — bind outSlot<T>() to a name first (docs/FFI.md)',
    };
  }
  return { kind: 'accept' };
}

/** The non-nullish constituents of a possibly-nullable type: what an optional chain's
 * else-branch holds. A non-union is its own remainder; an all-nullish union has none, which is
 * unreachable past the checker (no member access typechecks on one) and reads as vacuous here. */
function nonNullishConstituents(type: ts.Type): readonly ts.Type[] {
  if (!type.isUnion()) {
    return [type];
  }
  return type.types.filter(
    (t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
  );
}

/** The one class every non-nullish constituent of an optional-chain receiver names, when they do:
 * the static-dispatch case the chain can lower without the shape table. `undefined` for anything
 * else — an `any`/`unknown` constituent (the value may be anything), a non-class, a generic, a
 * second layout, or a name no class in the chain declares as a method — where the existing
 * accept/refuse rules stand. Mirrors the lowering's `nullableMethodInfo`; the two must agree, or
 * the gate accepts what the lowering cannot build. */
function singleClassMethod(
  live: readonly ts.Type[],
  name: string,
  typeChecker: ts.TypeChecker,
): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;
  for (const constituent of live) {
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
    if (found === undefined) {
      found = declaration;
    } else if (found !== declaration) {
      return undefined;
    }
  }
  if (found === undefined) {
    return undefined;
  }
  return frontendTypes.methodDeclaringClass(found, name, typeChecker) === undefined
    ? undefined
    : found;
}

/** Whether `u[Symbol.iterator]`'s key refusal is the element gate's to make: a known
 * user-iterable base (static dispatch lands) or an unknown one (the precise GetIterator refusal
 * lands). Any other base keeps the key's own STA1212 — mirrors the element gate's symbol arm, so
 * the two cannot disagree about which brackets reach it. */
function acceptsSymbolKeyBase(base: ts.Expression, typeChecker: ts.TypeChecker): boolean {
  const hir = frontendTypes.tsTypeToHType(typeChecker.getTypeAtLocation(base), typeChecker);
  return frontendTypes.userIteratorMethod(hir) !== undefined || hir.kind === 'unknown';
}

/** The G1 half of optional chaining (plan.md §8 step 24): `o?.m()` where every static-dispatch
 * arm declined the receiver. Returns the refusal, or `undefined` when the dynamic path the
 * fallthrough takes is one that works — a genuinely dynamic receiver (pre-existing accept) or
 * a plain object/interface remainder (function-valued fields read as closures). See the call
 * site for why only a class instance or a builtin receiver is refused. */
function optionalChainMethodReceiver(
  receiver: ts.Expression,
  name: string,
  typeChecker: ts.TypeChecker,
): GateResult | undefined {
  const live = nonNullishConstituents(typeChecker.getTypeAtLocation(receiver));
  // Vacuously true on an all-nullish union (which the checker never lets through, since no
  // member access typechecks on one): the guard below always skips, and the consequent is dead
  // but well-formed, so accepting is both safe and unreachable.
  if (live.every((t) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) {
    return undefined;
  }
  // A nullable single-class receiver dispatches statically (a method value/call with the guarded
  // base retyped to the non-nullish class), not through the shape table — so the refusal below
  // does not apply. All live constituents must be that one class carrying the method (no `any`
  // mixed in, no second layout); the lowering re-checks the same shape before building the node.
  if (singleClassMethod(live, name, typeChecker) !== undefined) {
    return undefined;
  }
  for (const constituent of live) {
    const mapped = frontendTypes.tsTypeToHType(constituent, typeChecker);
    if (mapped.kind === 'unknown') {
      continue;
    }
    if (mapped.kind === 'object') {
      const declaration = constituent.getSymbol()?.valueDeclaration;
      if (declaration === undefined || !ts.isClassDeclaration(declaration)) {
        continue;
      }
    }
    return notYet(
      `calling '${name}' through an optional chain on this receiver is not yet supported`,
      5,
    );
  }
  return undefined;
}

/** The G2 half of optional chaining (plan.md §8 step 24): `s?.[0]` on a string. Indexing a
 * string (or a number, or a boolean) is the same syntax reaching a different runtime operation
 * than an array index, and neither has an HIR node yet (gateElementAccess). Plain code never
 * reaches the lowering with one — the checker rejects it, or the gate's non-array refusal
 * does — but `?.` makes the nullable union legal, so the chain must refuse what the receiver
 * cannot do. Anything else flows through unchanged: arrays, matches, dynamic and fixed shapes
 * index the way their plain twins do. */
function optionalChainElementReceiver(
  access: ts.ElementAccessExpression,
  typeChecker: ts.TypeChecker,
): GateResult | undefined {
  if (access.questionDotToken === undefined) {
    return undefined;
  }
  const live = nonNullishConstituents(typeChecker.getTypeAtLocation(access.expression));
  const blocked = live.find((t) => {
    const mapped = frontendTypes.tsTypeToHType(t, typeChecker);
    return mapped.kind === 'string' || mapped.kind === 'number' || mapped.kind === 'boolean';
  });
  if (blocked === undefined) {
    return undefined;
  }
  return notYet(
    `indexing a ${hTypeName(frontendTypes.tsTypeToHType(blocked, typeChecker))} through an optional chain is not yet supported`,
    5,
  );
}

function gateCall(call: ts.CallExpression, typeChecker: ts.TypeChecker, mode: Mode): GateResult {
  // Dynamic code generation — `eval(...)` and `Function(...)` — own dedicated codes that split by
  // mode (STA1101/STA1103 never in ts, STA1206 not-yet Phase 8 in js). Asked before anything else
  // because the identifier `eval` is also a GLOBAL, and the global catch-all would otherwise
  // swallow it as STA1214 "the global 'eval'" (plan.md §8 step 2, plan-notes 141).
  const dynamicCode = dynamicCodeGeneration(call.expression, typeChecker);
  if (dynamicCode !== undefined) {
    return dynamicCode === 'eval' ? evalResult(mode) : functionCtorResult(mode);
  }

  if (skipParens(call.expression).kind === ts.SyntaxKind.ImportKeyword) {
    return gateImportCall(call);
  }

  // Asked first, because it is what decides whether the type arguments below are a feature or a
  // refusal: `box<string>('a')` and `box('a')` name the same specialization, and the difference
  // between them is a spelling the checker has already erased by the time it answers.
  // Undetermined parameters are already defaulted or dynamic inside the instantiation, so there
  // is no unresolved case left to refuse.
  const generic = genericCallInstantiation(call, typeChecker);
  if (generic.kind === 'not-generic' && call.typeArguments !== undefined) {
    return notYet('explicit type arguments on a call are not yet supported', 5);
  }
  // A generic call whose tuple still mentions a type parameter names no specialization: the
  // checker inferred a generic type for an argument (self-application `box(box)`), which no
  // monomorphic copy can spell. Refused here rather than lowered into the collection's
  // STA4070 canary, which exists for compiler bugs, not user programs. Parameters bound by
  // an enclosing generic are fine — the enclosing specialization substitutes them — so only
  // what nothing binds refuses.
  if (
    generic.kind === 'generic' &&
    generic.typeArguments.some((type) =>
      mentionsUnboundParameter(type, enclosingTypeParameterNames(call)),
    )
  ) {
    return notYet('a generic call at a generic type is not yet supported', 5);
  }
  const callee = skipParens(call.expression);

  // An extern call (docs/FFI.md §1): a direct C call, not a closure — decided before the
  // property-access arms, because the callee is a bare identifier and the bottom fallthrough
  // would accept it as an ordinary call to a binding that does not exist.
  const externDecl = externDeclarationOfCall(call, typeChecker);
  if (externDecl !== undefined) {
    return gateExternCall(call, externDecl, typeChecker, mode);
  }

  // The slot constructor (docs/FFI.md §2): decided before the property-access arms for the
  // same reason extern calls are — the callee is a bare identifier the fallthrough would
  // accept as an ordinary call to a binding that does not exist.
  if (outSlotDeclarationOf(call, typeChecker) !== undefined) {
    return gateOutSlotCall(call, typeChecker);
  }

  // A global function called by name (plan.md §11c T11.4): `String(x)`, `Number(x)`,
  // `Boolean(x)`, `parseInt(s, r)`, `parseFloat(s)`, `isNaN(x)`, `isFinite(x)`. Each lowers to
  // one fixed-arity node, so a spread (whose count is not its arity) and an argument past the
  // last parameter (evaluated, then ignored) are refused rather than lowered wrong. Any argument
  // type is accepted -- every one of these coerces.
  const globalFunction = globalFunctionOf(callee, typeChecker);
  if (globalFunction !== undefined) {
    return gateGlobalArguments(globalFunction, call, typeChecker);
  }

  // Two property-access callees, each its own HIR node: `console.log`, and a method of a class
  // this subset lays out. Anything else -- a method on a built-in, on an object literal, on an
  // interface-typed value -- needs the shape lookup the dynamic path will bring.
  // `ns.f(…)` on a module namespace calls the export's own binding, exactly as `f(…)` would
  // (plan.md §11c T11.5a): it is no method call, so it takes the ordinary-call rules below.
  if (ts.isPropertyAccessExpression(callee) && !isNamespaceMember(callee, typeChecker)) {
    if (isConsoleLog(callee)) {
      const method = callee.name.text as ConsoleMethod;
      const shape = CONSOLE_METHODS[method];
      const given = call.arguments.length;
      // A spread argument is refused here rather than counted: the lowering pads and the emitter
      // picks an entry point by COUNT, and a spread's count is not its arity.
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet(`a spread argument to console.${method} is not yet supported`, 5);
      }
      const placeholder = 'variadic' in shape ? formatRefusal(call, typeChecker) : undefined;
      if (placeholder !== undefined) {
        return notYet(
          `console.${method} ${placeholder.what} is not yet supported`,
          placeholder.phase,
        );
      }
      // The five printing methods are variadic (plan.md §8 step 18): any width reaches the
      // `(count, argv)` entry point, so neither bound applies — `console.log()` prints the bare
      // newline. `dir` stays unary — its second argument in Node is an options object, not a
      // second value.
      if (!('variadic' in shape) && (given > shape.arity || given < shape.arity - shape.optional)) {
        return notYet(`console.${method} with ${String(given)} arguments is not yet supported`, 5);
      }
      // `console.table` is the one console method whose ARGUMENT changes the output shape. Node
      // draws a Map or a Set with an `(iteration index)` column -- and a Map with a second `Key`
      // column -- which is a different table, not a wider one. Refusing it keeps the runtime from
      // drawing something Node does not; the array and object forms are what landed.
      const first = call.arguments[0];
      return method !== 'table' ||
        first === undefined ||
        collectionOf(first, typeChecker) === undefined
        ? { kind: 'accept' }
        : notYet('console.table on a Map or a Set is not yet supported', 5);
    }
    // A Math method: one runtime function per operation, like a collection op. Spread arguments
    // are refused here rather than lowered wrong -- `Math.min(...xs)` has no fixed arity to fold.
    if (isGlobalMath(callee.expression, typeChecker)) {
      if (!MATH_METHODS.has(callee.name.text)) {
        return notYet(`Math.${callee.name.text} is not yet supported`, 5);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to a Math method is not yet supported', 5);
      }
      // hypot is the one variadic Math method the lowering CANNOT fold, because it is not
      // associative: V8 computes the three-argument form with a Kahan compensation term, so
      // folding it into nested binary calls would agree with Node on easy inputs and disagree
      // exactly where the compensation is doing work. Refused rather than approximated.
      if (callee.name.text === 'hypot' && call.arguments.length > 2) {
        return notYet('Math.hypot with more than two arguments is not yet supported', 5);
      }
      return { kind: 'accept' };
    }
    // JSON.stringify and JSON.parse, single-argument forms. A replacer, an indent, or a reviver
    // changes the whole shape of the operation and stays deferred.
    if (isGlobalJson(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (method !== 'stringify' && method !== 'parse') {
        return notYet(`JSON.${method} is not yet supported`, 5);
      }
      const [argument] = call.arguments;
      if (call.arguments.length !== 1 || argument === undefined) {
        return notYet(`JSON.${method} with other than one argument is not yet supported`, 5);
      }
      if (ts.isSpreadElement(argument)) {
        return notYet(`a spread argument to JSON.${method} is not yet supported`, 5);
      }
      // parse reads TEXT. A value the checker types as something OTHER than a string is the
      // program leaning on ToString, a conversion the runtime parser does not do, and the
      // compiler can say so here rather than at run time. An untyped value is the js-mode norm
      // and is accepted: the tag check the runtime performs is the honest place to settle it,
      // and it aborts loudly rather than reading a non-string as text.
      if (method === 'parse') {
        const argumentType = typeChecker.getTypeAtLocation(argument);
        const untyped = (argumentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
        return untyped || isStringReceiver(argument, typeChecker)
          ? { kind: 'accept' }
          : notYet('JSON.parse of a value that is not a string is not yet supported', 5);
      }
      return admitsUnserializable(typeChecker.getTypeAtLocation(argument), typeChecker)
        ? notYet(
            'JSON.stringify of a value that may be undefined or a function is not yet supported',
            5,
          )
        : { kind: 'accept' };
    }
    // The Object namespace calls. A walking method's argument must be something whose keys the
    // runtime CAN walk — a fixed shape (its class descriptor lists the fields) or a dynamic shape
    // (its shape chain does). An array, a Map, or a primitive at that position answers
    // differently in Node than either walk would, so each stays deferred rather than
    // approximated. `fromEntries` is the mirror: it iterates, so it wants the array.
    if (isGlobalObject(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (!Object.hasOwn(OBJECT_STATICS, method)) {
        return notYet(`Object.${method} is not yet supported`, OBJECT_STATIC_OWNER[method] ?? 5);
      }
      const shape = OBJECT_STATICS[method as keyof typeof OBJECT_STATICS];
      const [argument, second] = call.arguments;
      if (call.arguments.length !== shape.arity || argument === undefined) {
        return notYet(
          `Object.${method} with other than ${String(shape.arity)} arguments is not yet supported`,
          5,
        );
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to an Object method is not yet supported', 5);
      }
      if (!acceptsObjectArgument(shape.receiver, argument, typeChecker)) {
        return notYet(`Object.${method} on this argument type is not yet supported`, 5);
      }
      if (shape.second === 'none') {
        return { kind: 'accept' };
      }
      if (second === undefined) {
        return notYet(`Object.${method} without a second argument is not yet supported`, 5);
      }
      // The key is a runtime string: a symbol or a number reads a property neither layout holds,
      // and converting one is the ToPropertyKey the object model owns.
      if (shape.second === 'key') {
        return isStringReceiver(second, typeChecker)
          ? { kind: 'accept' }
          : notYet(`Object.${method} with a key that is not a string is not yet supported`, 5);
      }
      return acceptsObjectArgument('shaped', second, typeChecker)
        ? { kind: 'accept' }
        : notYet(`Object.${method} from this source type is not yet supported`, 5);
    }
    // The `Date` namespace calls slice A lands: `Date.UTC` and `Date.parse`. `now` reads the
    // clock and is refused here by name -- it proves through Task 4.2's determinism carve-out,
    // not a golden test. Trailing components may be omitted (the lowering pads them); an argument
    // count ABOVE the table's arity is the spec's own "extra arguments are ignored", which this
    // compiler does not silently perform.
    if (isGlobalDate(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (!Object.hasOwn(DATE_STATICS, method)) {
        return dateNotYet(`Date.${method}`, 5);
      }
      const shape = DATE_STATICS[method as DateStatic];
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return dateNotYet('a spread argument to a Date method', 5);
      }
      return call.arguments.length > shape.arity ||
        call.arguments.length < shape.arity - shape.optional
        ? dateNotYet(`Date.${method} with ${String(call.arguments.length)} arguments`, 5)
        : { kind: 'accept' };
    }
    // The Promise namespace calls. `all` wants an ARRAY specifically -- the runtime walks one,
    // and every other iterable is the Symbol.iterator protocol -- while `resolve` and `reject`
    // take any value at all, which is why neither checks the argument's type.
    if (isGlobalPromise(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (!Object.hasOwn(PROMISE_STATICS, method)) {
        return notYet(`Promise.${method} is not yet supported`, 5);
      }
      if (call.arguments.length !== 1) {
        return notYet(`Promise.${method} with other than one argument is not yet supported`, 5);
      }
      const [argument] = call.arguments;
      if (argument === undefined || ts.isSpreadElement(argument)) {
        return notYet('a spread argument to a Promise method is not yet supported', 5);
      }
      if (
        PROMISE_STATICS[method as keyof typeof PROMISE_STATICS].array &&
        !isArrayOrTuple(typeChecker.getTypeAtLocation(argument), typeChecker)
      ) {
        return notYet('Promise.all over a non-array is not yet supported', 5);
      }
      return { kind: 'accept' };
    }
    // The `String` namespace call (plan.md §8 step 19): `String.fromCharCode(...codes)` lands
    // with any count — the node is variadic and the runtime coerces each argument — while any
    // other member is deferred BY NAME, so a named built-in is never answered by the catch-all
    // below. `String(x)` the converter is a different surface (the global-as-function) and is
    // not decided here.
    if (isGlobalString(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (!Object.hasOwn(STRING_STATICS, method)) {
        return notYet(`String.${method} is not yet supported`, 5);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to String.fromCharCode is not yet supported', 5);
      }
      return { kind: 'accept' };
    }
    // `Array.isArray(x)` (plan.md §11c T11.4) is the builtin `x instanceof Array` -- one realm and
    // no Proxy is where the two agree -- so it takes that node's one operand. Every other member
    // is deferred by name rather than by the method-call catch-all.
    // `Number.parseInt` and `Number.parseFloat` were accepted above as the global functions
    // they are; every other `Number` member is deferred by name here.
    if (isGlobalNamed(callee.expression, typeChecker, 'Number')) {
      return notYet(`Number.${callee.name.text} is not yet supported`, 5);
    }
    // `Number.prototype.toString(radix)` and `toFixed(digits)` (plan-notes 310): one runtime
    // function each over a number receiver. Every other member is deferred by name.
    if (
      frontendTypes.tsTypeToHType(typeChecker.getTypeAtLocation(callee.expression), typeChecker)
        .kind === 'number'
    ) {
      const method = callee.name.text;
      if (!Object.hasOwn(NUMBER_OPS, method)) {
        return notYet(`Number.prototype.${method} is not yet supported`, 5);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet(`a spread argument to Number.prototype.${method} is not yet supported`, 5);
      }
      return call.arguments.length > 1
        ? notYet(
            `${method} with ${String(call.arguments.length)} arguments is not yet supported`,
            5,
          )
        : { kind: 'accept' };
    }
    if (isGlobalArray(callee.expression, typeChecker)) {
      const method = callee.name.text;
      if (method !== 'isArray') {
        return notYet(`Array.${method} is not yet supported`, 5);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to Array.isArray is not yet supported', 5);
      }
      return call.arguments.length > 1
        ? notYet(
            `Array.isArray with ${String(call.arguments.length)} arguments is not yet supported`,
            5,
          )
        : { kind: 'accept' };
    }
    // A method ON a promise. then/catch/finally land via jsrt_call_protected (Phase 5 step 11).
    if (
      frontendTypes.tsTypeToHType(typeChecker.getTypeAtLocation(callee.expression), typeChecker)
        .kind === 'promise'
    ) {
      const method = callee.name.text;
      if (method === 'then' || method === 'catch' || method === 'finally') {
        if (call.arguments.some((a) => ts.isSpreadElement(a))) {
          return notYet(`a spread argument to Promise.prototype.${method} is not yet supported`, 5);
        }
        return { kind: 'accept' };
      }
      return {
        kind: 'not-yet',
        code: 'STA1216',
        message:
          `Promise.prototype.${method} is not yet supported: use an async function, ` +
          'whose await and return do the same work',
        phase: 5,
      };
    }
    // The landed String.prototype surface. The extra argument checks close the two union-typed
    // holes the closed set cannot see: a RegExp pattern (Task 4.3) and a replacer FUNCTION are
    // both legal TypeScript at these positions, and each needs machinery no string op has.
    if (
      isStringReceiver(callee.expression, typeChecker) ||
      constraintMatches(callee.expression, typeChecker, 'string')
    ) {
      const op = callee.name.text;
      if (!Object.hasOwn(STRING_OPS, op)) {
        return notYet(`String.prototype.${op} is not yet supported`, 5);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to a string method is not yet supported', 5);
      }
      // `concat` takes any count now (plan.md §8 step 19): zero arguments answer the
      // receiver, one the single form, and more fold left into nested singles at lowering —
      // pure string concatenation, so no runtime entry point is involved.
      if (op === 'split' && call.arguments.length > 1) {
        return notYet('split with a limit is not yet supported', 5);
      }
      // The two argument shapes a closed op set cannot express, both of which are legal
      // TypeScript at these positions. A PATTERN may be a string or a regexp -- the runtime
      // dispatches on the tag, because a regexp pattern is a scan and a string one is a substring
      // search. Everything else in an argument position must be a string: a replacer FUNCTION runs
      // user code per match, which is machinery no string op has.
      if (op === 'split' || op === 'replace' || op === 'replaceAll' || op === 'search') {
        for (const [index, argument] of call.arguments.entries()) {
          const kind = frontendTypes.tsTypeToHType(
            typeChecker.getTypeAtLocation(argument),
            typeChecker,
          ).kind;
          const patternPosition = index === 0;
          if (kind === 'regexp' ? !patternPosition : kind !== 'string') {
            return notYet(`${op} with this argument type is not yet supported`, 5);
          }
        }
        // `search` has no string form at all: the spec builds a RegExp out of whatever it is
        // given, and `new RegExp(...)` is a constructor this compiler does not have.
        const pattern = call.arguments[0];
        if (op === 'search' && (pattern === undefined || !isRegExpReceiver(pattern, typeChecker))) {
          return notYet('search with anything but a regular expression is not yet supported', 5);
        }
      }
      // `matchAll` answers an iterator of match arrays. A non-regexp argument is RegExpCreate,
      // which this compiler does not have — the same floor `search` sits on.
      if (op === 'matchAll') {
        const pattern = call.arguments[0];
        if (pattern === undefined || !isRegExpReceiver(pattern, typeChecker)) {
          return notYet('matchAll with anything but a regular expression is not yet supported', 5);
        }
      }
      // The locale-sensitive trio is the one part of this surface that Unicode's own tables cannot
      // answer: collation is a per-locale ORDER and tailored casing a per-locale EXCEPTION, both
      // of them CLDR data. They land only in the ICU feature build (Task 4.4), and only with an
      // EXPLICIT locale -- the spec's absent-locales form reads the HOST's default, which would
      // make a compiled program's output depend on the machine that runs it rather than on its
      // source, and every golden test in this repo rests on that not being true.
      if (op === 'localeCompare' || op === 'toLocaleLowerCase' || op === 'toLocaleUpperCase') {
        if (!intlEnabled()) {
          // No `phase`: the blocker is a BUILD FLAG, not a release (src/support/phases.ts). The
          // feature is available right now to anyone who rebuilds; a phase number here would tell
          // the user to wait for something that has already shipped.
          return {
            kind: 'not-yet',
            code: 'STA1215',
            message:
              `String.prototype.${op} needs the ICU feature build: rebuild with ` +
              '`just runtime-intl` and compile with STATOR_RUNTIME=intl',
          };
        }
        if (call.arguments.length !== STRING_OPS[op].arity) {
          // No padding here, unlike every other op in the table: an absent locale is not the same
          // request with a default filled in, it is the host-dependent form refused above.
          return notYet(`${op} without an explicit locale is not yet supported`, 5);
        }
        for (const argument of call.arguments) {
          const kind = frontendTypes.tsTypeToHType(
            typeChecker.getTypeAtLocation(argument),
            typeChecker,
          ).kind;
          if (kind !== 'string') {
            // `locales` is also legally a string[] and `options` an object; both are Intl
            // negotiation this compiler does not model.
            return notYet(`${op} with this argument type is not yet supported`, 5);
          }
        }
      }
      return { kind: 'accept' };
    }
    // The landed Array.prototype surface — the non-callback methods. The variadic forms
    // (`push`/`unshift` runs, insertion `splice`, multi-argument `concat`) land with any count
    // (plan.md §8 step 19): the node carries the arguments and the emitter picks the runtime
    // entry point by count. `lastIndexOf` takes one argument or two — an explicit position
    // means something DIFFERENT than an absent one (so the padding that is sound everywhere
    // else would change the answer), and a third argument stays deferred.
    if (
      isArrayReceiver(callee.expression, typeChecker) ||
      constraintMatches(callee.expression, typeChecker, 'array')
    ) {
      const op = callee.name.text;
      if (!Object.hasOwn(ARRAY_OPS, op)) {
        return notYet(`Array.prototype.${op} is not yet supported`, 5);
      }
      // A spread calls the bound method (`jsrt_array_method`) with the drained argument list, which
      // reads `push`/`unshift`/`splice`/`concat` by COUNT the way the specification does (step 5).
      // The callback ops stay refused: the callback rule below cannot see an argument a spread
      // carries, and `reduce` tells an absent initial value from an `undefined` one by count the
      // bound entry does not keep. `toSpliced` reads a fixed pair and drops its insertion tail.
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return Object.hasOwn(CALLBACK_ARRAY_OPS, op) || op === 'toSpliced'
          ? notYet(`a spread argument to Array.prototype.${op} is not yet supported`, 5)
          : { kind: 'accept' };
      }
      if (op === 'lastIndexOf' && call.arguments.length > 2) {
        return notYet('lastIndexOf with more than two arguments is not yet supported', 5);
      }
      if (op === 'toSpliced' && call.arguments.length !== 2) {
        // `splice` takes any count now; `toSpliced` keeps its two-argument form — the
        // insertion variant that returns a new array is still deferred.
        return notYet(`${op} with other than two arguments is not yet supported`, 5);
      }
      if ((op === 'sort' || op === 'toSorted') && call.arguments.length === 0) {
        return { kind: 'accept' }; // the ToString default; an explicit undefined means the same
      }
      if (op === 'reduce' || op === 'reduceRight') {
        // The zero-initial form seeds from the first element and cannot share the padded
        // signature: an explicit `undefined` initial IS an initial.
        if (call.arguments.length !== 2) {
          return notYet(`${op} without an initial value is not yet supported`, 5);
        }
      } else if (Object.hasOwn(CALLBACK_ARRAY_OPS, op) && call.arguments.length !== 1) {
        return notYet(`${op} with a thisArg is not yet supported`, 5);
      }
      if (Object.hasOwn(CALLBACK_ARRAY_OPS, op)) {
        const cb = call.arguments[0];
        // A callback the checker cannot type as callable would reach jsrt_call as a non-closure
        // and die there; in js mode an `any`-typed callback lands here too, and refusing it is
        // the honest answer until the dynamic tier can carry it.
        if (
          cb === undefined ||
          typeChecker.getSignaturesOfType(typeChecker.getTypeAtLocation(cb), ts.SignatureKind.Call)
            .length === 0
        ) {
          return notYet(`${op} with a non-function callback is not yet supported`, 5);
        }
      }
      return { kind: 'accept' };
    }
    // `RegExp.prototype`'s METHODS -- `test`, `exec`, `toString`. The one member left under
    // STA1211 is `compile`: Annex B B.2.4 legacy that RE-INITIALIZES an existing RegExp in place,
    // which is the mutate-a-built-object surface Phase 8 owns with STA1204, not a builtin this
    // phase declined to write (plan-notes 121, 136).
    if (
      isRegExpReceiver(callee.expression, typeChecker) ||
      constraintMatches(callee.expression, typeChecker, 'regexp')
    ) {
      const op = callee.name.text;
      if (!Object.hasOwn(REGEXP_OPS, op)) {
        return {
          kind: 'not-yet',
          code: 'STA1211',
          message: `RegExp.prototype.${op} is not yet supported; planned for Phase 8`,
          phase: 8,
        };
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet('a spread argument to a RegExp method is not yet supported', 5);
      }
      const arity = REGEXP_OPS[op as RegExpOperation].arity;
      if (call.arguments.length !== arity) {
        return notYet(`${op} with other than ${String(arity)} arguments is not yet supported`, 5);
      }
      const subject = call.arguments[0];
      if (subject === undefined) {
        return { kind: 'accept' }; // `toString`, the one nullary method: no subject to vet
      }
      // The JSON.parse rule: a value the checker types as something OTHER than a string is the
      // program leaning on ToString, which the bridge does not perform, and the compiler can say
      // so here. An untyped one is the js-mode norm and is accepted -- the runtime's tag check is
      // the honest place to settle it, and it aborts loudly rather than reading a non-string.
      const subjectType = typeChecker.getTypeAtLocation(subject);
      const untyped = (subjectType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      return untyped || isStringReceiver(subject, typeChecker)
        ? { kind: 'accept' }
        : notYet(`${op} of a value that is not a string is not yet supported`, 5);
    }
    // A Uint8Array / ArrayBuffer method: a landed row is vetted for the argument count it allows;
    // any other member is the rest of the family's surface, refused by its qualified name (the
    // refusal stops the walk, so the member gate never gets to say it).
    const typedReceiver = typedReceiverKind(callee.expression, typeChecker);
    const typedOp =
      typedReceiver === undefined ? undefined : typedMember(typedReceiver, callee.name.text);
    if (typedReceiver !== undefined && typedOp === undefined) {
      return notYet(
        `${typedClassName(typedReceiver)}.prototype.${callee.name.text} is not yet supported`,
        11,
      );
    }
    if (typedOp !== undefined) {
      const shape = TYPED_OPS[typedOp];
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return notYet(`a spread argument to ${typedOp} is not yet supported`, 11);
      }
      return call.arguments.length > shape.arity || call.arguments.length < shape.required
        ? notYet(
            `${typedOp} with ${String(call.arguments.length)} arguments is not yet supported`,
            11,
          )
        : { kind: 'accept' };
    }
    // `Date.prototype`'s methods. Slice A is the TZ-independent core: the UTC getters and setters,
    // the three string forms, and the two time-value reads. Every LOCAL-time member (getFullYear,
    // toString, getTimezoneOffset, ...) is refused by name here and lands in slice B, where the
    // golden runner's TZ pin makes it provable.
    if (
      isDateReceiver(callee.expression, typeChecker) ||
      constraintMatches(callee.expression, typeChecker, 'date')
    ) {
      const op = callee.name.text;
      if (!Object.hasOwn(DATE_OPS, op)) {
        return dateNotYet(`Date.prototype.${op}`);
      }
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        return dateNotYet('a spread argument to a Date method', 5);
      }
      const shape = DATE_OPS[op as DateOperation];
      return call.arguments.length > shape.arity ||
        call.arguments.length < shape.arity - shape.optional
        ? dateNotYet(`${op} with ${String(call.arguments.length)} arguments`, 5)
        : { kind: 'accept' };
    }
    // A Map or a Set: one runtime function per operation, and no user declaration anywhere, so
    // this is decided before anything that looks for a class.
    const collection = gateCollectionCall(call, callee, typeChecker);
    if (collection !== undefined) {
      return collection;
    }
    // The builtin namespaces refuse their own spreads above with their own messages; what reaches
    // here is a user function or method, which a spread calls through the shape table (step 5).
    if (call.arguments.some((argument) => ts.isSpreadElement(argument))) {
      return gateSpreadMethodCall(call, callee, typeChecker, mode);
    }
    // `C.m(…)` -- a static method, which is an ordinary function with no receiver. It is decided
    // before the instance case because the receiver's type answers the same for both.
    if (frontendTypes.staticMemberOf(callee, typeChecker, true) !== undefined) {
      return { kind: 'accept' };
    }
    if (
      callee.name.text === 'next' ||
      callee.name.text === 'return' ||
      callee.name.text === 'throw'
    ) {
      const receiver = frontendTypes.tsTypeToHType(
        typeChecker.getTypeAtLocation(callee.expression),
        typeChecker,
      );
      if (receiver.kind === 'iterator') {
        // `next` steps any iterator. `return`/`throw` are Generator.prototype's closing pair: a
        // boxed specialized iterator (`arr.keys()`) carries the names in its IterableIterator
        // TYPE but not on the object, where Node throws a TypeError the runtime cannot raise
        // yet -- so only a generator receiver is admitted (Phase 5 step 8).
        // TODO: not supported — `return`/`throw` on a specialized iterator (needs a raisable
        // TypeError; jsrt_throw feeds generated code only).
        if (callee.name.text !== 'next' && !isGeneratorReceiver(callee.expression, typeChecker)) {
          return notYet(
            `Iterator.${callee.name.text} on a specialized iterator is not yet supported`,
            5,
          );
        }
        return call.arguments.length <= 1
          ? { kind: 'accept' }
          : notYet(
              `Iterator.${callee.name.text} with more than one argument is not yet supported`,
              5,
            );
      }
    }
    const declaration =
      classDeclarationOf(typeChecker.getTypeAtLocation(callee.expression)) ??
      constraintDeclaration(typeChecker.getTypeAtLocation(callee.expression), typeChecker);
    if (declaration === undefined) {
      // A match array is Unknown in HIR; its methods are not the dynamic-call path.
      if (isMatchReceiver(callee.expression, typeChecker)) {
        return notYet(`${callee.name.text} on a RegExp match is not yet supported`, 5);
      }
      // A method call through `?.` on a receiver the static arms declined (plan.md §8 step
      // 24): `s?.toUpperCase()` with s: string|undefined, `c?.m()` with c: C|undefined. The
      // checker approves (the `?.` is the nullish check it wanted) and every static-dispatch
      // arm above declined the union, so without this rule the call falls through to the
      // Unknown-receiver accept below and the lowering aims a shape-table read at a layout —
      // a runtime panic for typed code. A genuinely dynamic (any) receiver keeps that accept
      // (its panic predates chains; plan.md §8 step 20 owns it), as does a plain object or
      // interface remainder, whose function-valued fields read as closures and call cleanly.
      // Only a class instance or a builtin receiver is refused: the two whose members the
      // shape table does not hold.
      if (callee.questionDotToken !== undefined) {
        const refused = optionalChainMethodReceiver(
          callee.expression,
          callee.name.text,
          typeChecker,
        );
        if (refused !== undefined) {
          return refused;
        }
      }
      // `o.m()` on an Unknown receiver: get the name through the shape table, then call.
      const shape = frontendTypes.tsTypeToHType(
        typeChecker.getTypeAtLocation(callee.expression),
        typeChecker,
      );
      if (readsAsUnknown(callee.expression, shape, typeChecker, mode)) {
        return { kind: 'accept' };
      }
      if (shape.kind === 'object' && shape.methods.some((m) => m.name === callee.name.text)) {
        return { kind: 'accept' };
      }
      // `o.f()` where `f` is a field holding a closure -- an object literal's `{ f: () => … }`
      // or `{ scan }` (plan-notes 310): the callee loads from its slot and the receiver rides
      // along exactly as a dynamic method call passes it.
      if (callableFieldSlot(shape, callee.name.text) !== undefined) {
        return { kind: 'accept' };
      }
      // `assert.sameValue(a, b)`: a function stored on a function, called with the function as
      // its receiver through the closure's own properties (plan-notes 310).
      if (frontendTypes.isFunctionValueMember(callee.expression, callee.name.text, typeChecker)) {
        return functionMemberResult(mode);
      }
      // `info.cb()` where `cb` was grown onto the object (docs/VALUE.md §4.24): get the name
      // through the overflow table, then call it with the object as receiver.
      if (mode === 'js' && frontendTypes.isUndeclaredMemberRead(callee, typeChecker)) {
        return { kind: 'accept' };
      }
      return notYet('method calls are not yet supported', 5);
    }
    return { kind: 'accept' };
  }

  // `c?.[k]()` on a class instance or builtin receiver: the element spelling of the
  // optional-chain method refusal above, asked in exactly the position the dot spelling asks
  // it -- only when the receiver resolves to no class declaration. A class instance takes
  // the OptionalChain path like its dot twin; anything else is decided by the element-access
  // gate when the child node is reached.
  if (ts.isElementAccessExpression(callee) && callee.questionDotToken !== undefined) {
    const key = frontendTypes.elementStaticKey(callee.argumentExpression, typeChecker);
    if (key !== null) {
      const declaration =
        classDeclarationOf(typeChecker.getTypeAtLocation(callee.expression)) ??
        constraintDeclaration(typeChecker.getTypeAtLocation(callee.expression), typeChecker);
      if (declaration === undefined) {
        const refused = optionalChainMethodReceiver(callee.expression, key, typeChecker);
        if (refused !== undefined) {
          return refused;
        }
      }
    }
  }

  // `super(...)`, which the gate reaches only after gateClass proved it is the first statement of a
  // derived constructor: it is the base constructor run against the receiver this one was handed.
  // A spread would run the base constructor through `jsrt_call_spread_at`, which passes no `this`
  // a constructor call can bind; it waits with the spread `new` (`gateNew`).
  if (callee.kind === ts.SyntaxKind.SuperKeyword) {
    return call.arguments.some((argument) => ts.isSpreadElement(argument))
      ? notYet('a spread argument to a super call is not yet supported', 5)
      : { kind: 'accept' };
  }

  // Any expression may be the callee. `CallExpr.callee` is an ordinary Expression, the emitter
  // evaluates it into its own rooted slot ahead of the arguments, and the verifier already requires
  // its type to be `fn` or Unknown -- so a conditional, an element of an array of functions, or the
  // result of another call needs nothing this arm could add. Whatever refusal the callee's own
  // shape deserves comes from gating that expression, which the walk does anyway; deciding it a
  // second time here is what made `(up ? inc : dec)(x)` a not-yet with no blocker behind it
  // (plan.md §8 step 12(e)).
  //
  // The argument count is deliberately unchecked: JavaScript drops extras and fills missing ones
  // with `undefined`, and the calling convention does that at runtime rather than making it a gate
  // decision. A spread is the one argument form with no fixed count at all: its list is built at
  // run time and called through `jsrt_call_spread_at` (step 5).
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) {
    return spreadCallRefusal(call, typeChecker, mode) ?? { kind: 'accept' };
  }
  return { kind: 'accept' };
}

/** What every spread call is still refused for (plan.md §11c T11.4 step 5): a call inside an
 * optional chain, whose short-circuit the spread lowering does not build, and -- in js mode -- a
 * callee with a TypeScript-annotated parameter. That annotation is a claim the edge check keeps
 * (`STA2001`, plan-notes 308), and a spread's elements reach parameters by position only at run
 * time, where no check stands. ts mode's checker proved the spread against the parameters itself. */
function spreadCallRefusal(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  mode: Mode,
): GateResult | undefined {
  if (ts.isOptionalChain(call)) {
    return notYet('a spread argument in an optional chain is not yet supported', 5);
  }
  if (mode !== 'js') {
    return undefined;
  }
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return declaration !== undefined &&
    !ts.isJSDocSignature(declaration) &&
    declaration.parameters.some((parameter) => hasTypeScriptAnnotation(parameter))
    ? notYet(
        'a spread argument to a function with annotated TypeScript parameters is not yet supported in js mode',
        5,
      )
    : undefined;
}

/** `o.m(...xs)`: the method read through the shape table and called with `o` as its receiver
 * (`jsrt_call_spread_at`). That read answers an Unknown or plain-object receiver, a class instance
 * (its methods are the class's closures), an array, and a function's own property; the other
 * receivers the static arms own -- iterators, collections, RegExp matches -- stay refused, as does
 * `super.m(...)`, which names no value to read through. */
function gateSpreadMethodCall(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  const refused = spreadCallRefusal(call, checker, mode);
  if (refused !== undefined) {
    return refused;
  }
  if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return notYet('a spread argument to a super method call is not yet supported', 5);
  }
  if (frontendTypes.staticMemberOf(callee, checker, true) !== undefined) {
    return { kind: 'accept' };
  }
  if (frontendTypes.isFunctionValueMember(callee.expression, callee.name.text, checker)) {
    return functionMemberResult(mode);
  }
  const receiver = frontendTypes.tsTypeToHType(
    checker.getTypeAtLocation(callee.expression),
    checker,
  );
  return (receiver.kind === 'unknown' || receiver.kind === 'object') &&
    !isMatchReceiver(callee.expression, checker)
    ? { kind: 'accept' }
    : notYet('a spread argument to a method call is not yet supported', 5);
}

/** Whether `fn` is an overload signature with a runnable implementation: bodiless, named,
 * non-generic, with a same-name bodied non-generic implementation in its own statement list.
 *
 * Takes the whole function union because the caller cannot narrow it: `isExternDeclaration`
 * above is typed as a `node is FunctionDeclaration` guard, so its false branch excluded
 * FunctionDeclaration from the caller's `fn` for the rest of that function — sound for the
 * extern question, wrong for everything below it. Fresh parameter, fresh narrowing.
 *
 * Overload signatures must be adjacent to their implementation, so siblings are the whole
 * search; a `declare function` ambient (no implementation by design) answers false and stays
 * not-yet. Generic families stay not-yet too — monomorphization specializes the
 * implementation, and a call resolving to a bodiless signature has no body to specialize. */
function hasFunctionImplementation(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  // Only a declaration can be an overload signature; an expression or arrow never lacks a body.
  if (!ts.isFunctionDeclaration(fn) || fn.body !== undefined) {
    return false;
  }
  const name = fn.name?.text;
  if (name === undefined || fn.typeParameters !== undefined) {
    return false;
  }
  const parent = fn.parent;
  const statements: readonly ts.Statement[] | undefined =
    ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent)
      ? parent.statements
      : ts.isCaseClause(parent) || ts.isDefaultClause(parent)
        ? parent.statements
        : undefined;
  if (statements === undefined) {
    return false;
  }
  return statements.some(
    (s): s is ts.FunctionDeclaration =>
      s !== fn &&
      ts.isFunctionDeclaration(s) &&
      s.name?.text === name &&
      s.body !== undefined &&
      s.typeParameters === undefined,
  );
}

/** Rung 4a: functions with no captured environment. Each rejection below is a feature whose
 * binding form the HIR has no node for, not a judgement about the function itself. */
function gateFunction(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  typeChecker: ts.TypeChecker,
): GateResult {
  // The extern marker outside a `.d.ts` (docs/FFI.md §1): placement is refused before the body
  // check below, so a bodiless `declare function` with the tag reads as misplaced (STA1121)
  // rather than as an overload. `.d.ts` files never reach this function — the program walk
  // skips them — so no placement test is needed here, only the marker.
  if (ts.isFunctionDeclaration(fn) && isExternDeclaration(fn)) {
    return {
      kind: 'never',
      code: 'STA1121',
      message: 'extern declaration is only legal in a .d.ts file; move it there (docs/FFI.md)',
    };
  }
  // A generator's asterisk is checked here as well as at YieldExpression, because a generator
  // with no `yield` in it is still a generator and still returns an iterator.
  if (
    !ts.isArrowFunction(fn) &&
    fn.asteriskToken !== undefined &&
    fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
  ) {
    // Async generators need both machines at once. Ordinary `function*` falls through to the
    // named-expression / nested-declaration checks below, then accepts.
    return generatorNotYet();
  }
  // A generic is compiled by MONOMORPHIZATION: one specialization per concrete type tuple a call
  // asks for (Task 3.4). That needs a home to specialize under — a named, hoisted declaration the
  // lowering can lower again with a substitution in scope, or a `const` at module scope holding
  // the arrow, which names the specializations the same way. An inline arrow or function
  // expression passed directly as a call argument is its own use site: it takes the parameter's
  // tuple under a position-derived key (`inlineGenericTuple`). Any other homeless shape (a
  // `let`, a nesting, a branch, a body that reads an enclosing scope) has nowhere to build a
  // second copy for.
  if (
    fn.typeParameters !== undefined &&
    fn.typeParameters.length > 0 &&
    !ts.isFunctionDeclaration(fn) &&
    genericArrowKey(fn) === undefined &&
    inlineGenericTuple(fn, typeChecker) === undefined
  ) {
    return notYet('a generic function expression or arrow is not yet supported', 5);
  }
  if (fn.body === undefined) {
    // An overload signature declares nothing to emit; the implementation runs. Mirror the
    // class arms: accept when a same-name implementation shares the statement list, refuse
    // when alone (a `declare function` ambient included). The predicate takes the whole
    // union — the caller cannot narrow past the extern guard above (see its comment).
    if (hasFunctionImplementation(fn)) {
      return { kind: 'accept' };
    }
    return notYet('overload signatures are not yet supported', 5);
  }
  // A specialization is a module-level function lowered before its file's statements, so a
  // generic whose body reads an enclosing scope or a same-file `let`/`const`/`var` has no
  // binding to read there (plan.md §8 step 12(f)): the inline path refuses those reads in
  // `inlineGenericTuple`, and named declarations and homed arrows refused nothing — they
  // accepted and failed downstream as `STA4035`/`STA4002`. Refuse here instead, with the
  // same owner. Functions, classes, imports, and globals hoist or pre-register and stay
  // accepted; only the blind-spot and out-of-module reads refuse.
  if (
    fn.typeParameters !== undefined &&
    fn.typeParameters.length > 0 &&
    capturesEnclosingScope(fn, typeChecker)
  ) {
    return notYet(
      'a generic function that reads an enclosing scope or a same-file binding is not yet supported',
      5,
    );
  }
  // An arrow's expression body (`(x) => x * 2`) is a Block in the HIR with a single return; the
  // lowering synthesises it, so nothing is gated here beyond what the expression itself gates.
  // A function declared in a block belongs to that block and is initialised when the block is
  // entered (plan.md §8 step 12(e)); a block-level `f` that shadows an enclosing `f` gets a name of
  // its own at the lowering (plan.md §8 step 14), so the narrow `shadowsEnclosingBinding` refusal
  // step 12(e) shipped with is gone, together with the defect it named.
  return { kind: 'accept' };
}

/** Shared by the generator spellings this landing did not take: generator methods, async
 * generators, and `for await`. `function*` declarations and unnamed expressions compile. */
function generatorNotYet(): GateResult {
  return {
    kind: 'not-yet',
    code: 'STA1201',
    message: 'generators are not yet supported; planned for Phase 5 (the iterator protocol)',
    phase: 5,
  };
}

function gateYield(node: ts.Node): GateResult {
  if (!ts.isYieldExpression(node)) {
    return generatorNotYet();
  }
  if (node.asteriskToken !== undefined) {
    return notYet('yield* is not yet supported', 5);
  }
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) {
      return n.asteriskToken !== undefined
        ? { kind: 'accept' }
        : notYet('yield outside a generator is not yet supported', 5);
    }
    if (ts.isArrowFunction(n) || ts.isConstructorDeclaration(n)) {
      return notYet('yield outside a generator is not yet supported', 5);
    }
  }
  return notYet('yield outside a generator is not yet supported', 5);
}

/** `await e`, admitted inside an async function's body or at module top-level.
 *
 * A top-level await compiles into the same resume machinery as an async function: the module
 * body is itself an async unit (Phase 5 step 9). Await in a non-async function is still not-yet. */
function gateAwait(node: ts.Node): GateResult {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      return ts.canHaveModifiers(n) &&
        ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
        ? { kind: 'accept' }
        : notYet('await outside an async function is not yet supported', 5);
    }
  }
  // The module body is itself an async unit (Phase 5 step 9): resume points live on that unit
  // the same way they live on an async function.
  return { kind: 'accept' };
}

/** `<T>`, `<T extends Constraint>`, `<T = Default>`.
 *
 * A constraint is enforced by the checker at every call site, so there is nothing for the
 * lowering to check: monomorphization substitutes the concrete tuple the call resolved to, and
 * a member the body reads through `T` lowers per specialization exactly as it would for the
 * concrete type (the member-access gate admits it on the same terms). A default supplies the
 * tuple element no call site wrote, and an undetermined parameter without one is `Unknown` —
 * both recovered in `genericCallInstantiation`, in declaration order.
 *
 * A method's OWN type parameter is narrower: a method shares its instance's dispatch slot across
 * every tuple, so a per-tuple body has nowhere to live. A parameter the method never mentions in
 * a type position needs no body at all and stays accepted; one it does mention is refused. */
function gateTypeParameter(parameter: ts.TypeParameterDeclaration): GateResult {
  const owner = parameter.parent;
  if (
    ts.isMethodDeclaration(owner) &&
    owner.typeParameters?.includes(parameter) === true &&
    mentionsTypeParameter(owner, parameter.name.text)
  ) {
    return notYet('a generic method is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/** Whether `name` — a type parameter declared by `root` itself, not by anything around it —
 * appears in any type position under `root`: a parameter or return annotation, or a type
 * reference anywhere in the body. Annotations erase, but the values they type do not: a mention
 * is what puts the parameter into an HType the lowering would have to specialize. */
function mentionsTypeParameter(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node.kind === ts.SyntaxKind.TypeParameter) {
      return;
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  // The declaration's own `<T>` is not a use of `T`: skipping the type-parameter list keeps a
  // bound like `<T extends Box<T>>` from reading as a mention (whether the bound itself lowers
  // is the constraint rule's business, decided where the parameter is gated, not here).
  ts.forEachChild(root, (child) => {
    if (!ts.isTypeParameterDeclaration(child)) {
      visit(child);
    }
  });
  return found;
}

/** A value parameter the HIR can bind: one plain identifier. Rest packs extras; a default runs
 * when the argument is `undefined`. Destructuring patterns stay not-yet. */
function gateParameter(param: ts.ParameterDeclaration): GateResult {
  if (param.dotDotDotToken !== undefined) {
    if (!ts.isIdentifier(param.name) || param.initializer !== undefined) {
      return notYet('rest parameters are not yet supported', 5);
    }
    return { kind: 'accept' };
  }
  if (!isSimpleBindingPattern(param.name)) {
    return notYet('destructuring parameters are not yet supported', 5);
  }
  if (ts.isIdentifier(param.name) && param.name.text === 'this') {
    return notYet('a `this` parameter is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/* Rung 4b gave captures a representation -- a heap environment chained through enclosing scopes
 * (docs/VALUE.md §4.3) -- so a reference to an enclosing function's local is no longer refused.
 * `gateIdentifier` and its declaration-site test are gone with it: every identifier the checker
 * resolves is now expressible, and the accept set matches the HIR's vocabulary again. */

/** Whether this expression's type is an `Out<T>` slot (docs/FFI.md §2): the one test
 * every flow arm shares. `unknown` (even slot-flavored) is not `Out` — only the spelling
 * counts, so a dynamic value never smuggles itself into a slot position. */
function isOutSlotValue(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return frontendTypes.outSlotInner(checker.getTypeAtLocation(expression), checker) !== undefined;
}

/** An out-slot stored where only values live (docs/FFI.md §2): array elements, object
 * fields, and spreads. Slots are call-local cells, not values — copying one's bits into a
 * heap object or another call's argument divorces the bits from the cell the callee writes,
 * so every one of these positions is STA1125 and only the slot's own name (or a fresh
 * inline slot at an out-pointer parameter) ever crosses. */
function outSlotInValuePosition(what: string): GateResult {
  return {
    kind: 'never',
    code: 'STA1125',
    message:
      `${what} cannot hold an out-slot — slots live in locals, pass to Out<T> ` +
      'parameters, and read through .value (docs/FFI.md)',
  };
}

function skipParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `.length` on something the checker says is a string.
 *
 * The type test is what keeps the gate honest: `arr.length` and `fn.length` are the same syntax
 * and neither has an HIR node, so accepting `.length` on syntax alone would let them through to
 * an internal error. Any string-ish type qualifies — a literal type like `'ab'` is a String too,
 * and `StringLike` also covers a union of string literals. */
function isStringLength(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  if (access.name.text !== 'length') {
    return false;
  }
  const objectType = checker.getTypeAtLocation(access.expression);
  return (objectType.flags & ts.TypeFlags.StringLike) !== 0;
}

/** The checker says the receiver is a string — literal types and unions of literals included,
 * exactly the test isStringLength uses. */
export function isStringReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return (checker.getTypeAtLocation(expression).flags & ts.TypeFlags.StringLike) !== 0;
}

/** The checker says the receiver is an array — the test isArrayLength uses, shared with the
 * lowering so both decide "array method" identically. A tuple answers false, with everything
 * else. */
export function isArrayReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return checker.isArrayType(checker.getTypeAtLocation(expression));
}

/** The checker says the receiver is a RegExp — the same shape as isArrayReceiver, decided through
 * the HType mapping so the gate and the lowering agree on what a regexp receiver is. */
export function isRegExpReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return (
    frontendTypes.tsTypeToHType(checker.getTypeAtLocation(expression), checker).kind === 'regexp'
  );
}

/** Is this the MATCH ARRAY `exec` or a non-global `match` answered?
 *
 * The checker is the only thing that can say so: the value's HIR type is Unknown, because the call
 * answers a match OR null and the HIR has no union — so a `RegExpExecArray` here is a narrowing the
 * checker performed and this compiler trusts, exactly as it trusts `isStringReceiver`. The lib
 * declares two names for one runtime shape: `exec` answers the first, `String.prototype.match` the
 * second, and they differ only in whether `index`/`input` are optional. */
export function isMatchReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(expression);
  const name = type.getSymbol()?.getName();
  if (name !== 'RegExpExecArray' && name !== 'RegExpMatchArray') {
    return false;
  }
  const declarations = type.getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** The checker says the receiver is the lib `Generator` interface — the object `function*`
 * answers. This is what separates it from a boxed specialized iterator (`arr.keys()`), whose
 * IterableIterator type SPELLS `return`/`throw` that the object itself does not carry, so the
 * closing pair is admitted only here (Phase 5 step 8). A user-declared `Generator` shape in the
 * program's own sources is not the declaration-file interface and answers false — the
 * isMatchReceiver test. */
export function isGeneratorReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getTypeAtLocation(expression).getSymbol();
  if (symbol?.getName() !== 'Generator') {
    return false;
  }
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** A `var` binding: neither `let` nor `const` on the enclosing list.
 *
 * Exported so the lowering can desugar the same set the gate just accepted, rather than
 * re-deriving the flag test and drifting. */
export function isVarDeclarationList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.Let) === 0 && (list.flags & ts.NodeFlags.Const) === 0;
}

/** `.length` on something the checker says is an array. The same reasoning as isStringLength: the
 * syntax alone does not say which runtime function the read becomes. A TUPLE is excluded with
 * everything else, because `checker.isArrayType` is false for one and its `.length` is a literal
 * type this model does not carry. */
function isArrayLength(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  return (
    access.name.text === 'length' &&
    checker.isArrayType(checker.getTypeAtLocation(access.expression))
  );
}

/** `.length` on something the checker says is a function. The same reasoning as
 * isStringLength: the syntax alone does not say which runtime function the read becomes, and
 * accepting it on syntax alone would let a non-function through to the closure read. A CALLABLE
 * type -- declared, inferred, or a method value's -- qualifies; a construct-only signature (a
 * class name) does not, because a class is not a value here. An untyped receiver never reaches
 * this test, taking the dynamic path instead (plan.md §8 step 21b). */
function isFunctionLength(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  if (access.name.text !== 'length') {
    return false;
  }
  const objectType = checker.getTypeAtLocation(access.expression);
  return checker.getSignaturesOfType(objectType, ts.SignatureKind.Call).length > 0;
}

/** An array literal, minus the spellings whose elements are not simply "the elements".
 *
 * A hole (`[1, , 3]`) is a real hole in ECMA-262 — it is `undefined` on read but absent to
 * iteration — and the dense runtime array has no way to be absent. A spread needs the iterator
 * protocol. Both are rejected rather than approximated. */
function gateArrayLiteral(literal: ts.ArrayLiteralExpression, checker: ts.TypeChecker): GateResult {
  // The left side of `[a, , b] = rhs` builds no array: its hole skips an index of the right side,
  // and the `=` arm rules on the pattern (plan-notes 310).
  if (
    ts.isBinaryExpression(literal.parent) &&
    literal.parent.left === literal &&
    literal.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return { kind: 'accept' };
  }
  for (const element of literal.elements) {
    if (!ts.isOmittedExpression(element) && isOutSlotValue(element, checker)) {
      return outSlotInValuePosition('an array literal');
    }
  }
  // A spread of any operand is accepted (plan.md §11c T11.4 step 5): the lowering spreads an array
  // through the concat and drains anything else at run time, where a non-iterable is Node's
  // `TypeError` (docs/VALUE.md §4.23).
  if (literal.elements.some((element) => ts.isOmittedExpression(element))) {
    return notYet('a hole in an array literal is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/** The HType a spread operand lowers to — the asserted type only when the lowering proves it.
 *
 * The lowering drops an `as` cast to any type no tag check can settle (an array or an object
 * shape never is: `isCheckable` in `src/frontend/narrowing.ts` admits only number, string and
 * boolean), so `...(u as number[])` lowers to the UNKNOWN `u`, not to the asserted array. Judging
 * the asserted type here would accept a program the verifier rejects as STA4082 — and STA4068 for
 * the object twin — the gate-verifier gap plan.md §8 step 39 exists to close. Parentheses express
 * only precedence and unwrap in the lowering too. The one case that keeps the asserted type is the
 * BoundaryCheck the lowering inserts for a checkable assertion off an unknown operand, which this
 * mirrors through the same `assertedBy`/`isCheckable` pair so the two cannot disagree about what a
 * spread reads. Recursion judges a stacked assertion (`x as unknown as T[]`) by what the last drop
 * leaves rather than by the spelling on top. Anything but `as` and parentheses is answered from
 * the checker's own type, exactly as before. */
function spreadOperandType(expression: ts.Expression, checker: ts.TypeChecker): HType {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (ts.isAsExpression(current)) {
    const assertion = assertedBy(current, checker);
    if (assertion !== null && isCheckable(assertion.asserted)) {
      const inner = spreadOperandType(current.expression, checker);
      if (inner.kind === 'unknown') {
        // The lowering wraps this operand in a BoundaryCheck: the assertion is settled by a tag
        // test at run time, so the spread reads the asserted type, not the operand's.
        return assertion.asserted;
      }
    }
    return spreadOperandType(current.expression, checker);
  }
  return frontendTypes.tsTypeToHType(checker.getTypeAtLocation(current), checker);
}

/** Whether `name` is a key a FIXED layout can carry.
 *
 * An identifier always is. A string literal is too — the slot is found by the name the source
 * wrote, and the only thing that ever needed the name to be spellable was the PRINTER, which now
 * quotes a key like `util.inspect` does rather than assuming one (`append_key`).
 *
 * An integer index is the exception, and not for a layout reason: OrdinaryOwnPropertyKeys puts
 * integer indices first in ASCENDING NUMERIC order, ahead of the string keys in insertion order, so
 * `{ b: 1, "0": 2 }` prints `{ '0': 2, b: 1 }` while a fixed layout is declaration order by
 * definition. The dynamic shape table already implements that ordering, so such a literal belongs
 * on the dynamic path, not in a slot table that would have to re-implement it. */
function isLayoutKey(name: ts.PropertyName): boolean {
  if (ts.isIdentifier(name)) {
    return true;
  }
  return ts.isStringLiteral(name) && !isIntegerIndex(name.text);
}

function propertyNameIsLayoutKey(name: ts.PropertyName, checker: ts.TypeChecker): boolean {
  if (ts.isComputedPropertyName(name)) {
    // A computed key with a static name (`computedKeyStaticName`) is the name the direct
    // spelling writes -- `[k]` with `k: "dyn"` is `dyn` -- so it answers the same way. Only a
    // runtime key is not a name until there is a shape table to look it up in.
    return frontendTypes.computedKeyStaticName(name, checker) !== null;
  }
  return isLayoutKey(name);
}

function isObjectLiteralComputedKey(name: ts.ComputedPropertyName): boolean {
  const parent = name.parent;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  ) {
    const grand = parent.parent;
    return grand !== undefined && ts.isObjectLiteralExpression(grand);
  }
  return false;
}

/** A computed name written on a class member (`[k]` on a method, field, or accessor). The
 * declaration's own verdict lives in gateClass; this only tells the child-node walk that the
 * spelling belongs to a class, so a statically-known key can ride the class's verdict instead
 * of earning a second diagnostic of its own. */
function isClassMemberComputedKey(name: ts.ComputedPropertyName): boolean {
  const parent = name.parent;
  const isMember =
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent);
  return (
    isMember &&
    parent.name === name &&
    parent.parent !== undefined &&
    (ts.isClassDeclaration(parent.parent) || ts.isClassExpression(parent.parent))
  );
}

/** ECMA-262's array-index test on a property key: the canonical decimal spelling of a number below
 * 2^32-1. `"01"` and `"1.0"` are ordinary string keys — only the canonical form is an index. */
function isIntegerIndex(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 0xffffffff;
}

/** `{ x: 1, y: f() }`, admitted only where the shape is a layout.
 *
 * The key set must be known: a computed key without a static name is not a name until there is
 * a shape table to look one up in, a spread copies a shape this one does not know, and a method or
 * an accessor in a literal has no class to hang a member function on. A key that is merely not an
 * IDENTIFIER is fine (`isLayoutKey`) -- the printer quotes it.
 *
 * The TYPE has to be a shape too, and that is the load-bearing check: `tsTypeToHType` refuses an
 * optional property, an index signature and anything with a call signature, so accepting a literal
 * whose type it refuses would hand the lowering a literal with no layout to build. */
function gateObjectLiteral(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): GateResult {
  for (const property of literal.properties) {
    // A method or accessor body is not stored: its returns are their own nodes.
    if (
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      continue;
    }
    const stored = ts.isSpreadAssignment(property)
      ? property.expression
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name;
    if (isOutSlotValue(stored, checker)) {
      return outSlotInValuePosition('an object literal');
    }
  }
  for (const property of literal.properties) {
    // `{ x }` is `{ x: x }` -- the same key, the same value, and a name the checker has already
    // resolved. It gets no layout question of its own, so it is accepted here and desugared in the
    // lowering rather than carried into HIR as a second member kind.
    if (ts.isShorthandPropertyAssignment(property)) {
      continue;
    }
    // `{ ...a, b: 1 }`: the spread's own type names the keys it contributes, so the result is a
    // fixed slot list after all -- the lowering expands it into one read per field. The operand is
    // any expression of fixed-shape object type: the emitter evaluates it once into a rooted
    // scratch slot and reads each field out of that, so a call or member access runs its effect
    // exactly once (plan.md §8 step 12 family c; plan-notes 181).
    if (ts.isSpreadAssignment(property)) {
      const spread = spreadOperandType(property.expression, checker);
      // `{ ...a }` over an array: indices first, then named extras through the array's own
      // shape table (the step-38 walk), copied onto a dynamic result. The lowering folds every
      // run around such a spread through `object-static assign`, so the result is dynamic BY
      // CONSTRUCTION and needs no layout decision here -- which is why this accepts before the
      // fixed-shape test below rather than inside it. No method check either: an HType array
      // carries no methods, and `Array.prototype` members are not own properties, so there is
      // nothing to copy and no slot layout for a copy to depend on (the S-C prefix rule answers
      // only for literal-shaped sources). A tuple stays refused below: it maps to Unknown, and
      // its statically-known length belongs to the unknown-spread owner, not this arm.
      //
      // Accepted only when the literal takes the dynamic path (`objectLiteralIsDynamic`): an
      // array spread materializes the Array interface as named members in the checker's type
      // while dropping the index signature as soon as an own key joins it (`{...a, x}` types
      // `{x, length, pop, ...}` with no index), so a fixed-shape binding would promise slots
      // the dynamic value never builds -- and every static read of one would miscompile
      // (`o.length` answers `undefined` in Node and garbage from a slot load). A dynamic
      // literal binds Unknown, and Unknown reads go through the shape table, which answers
      // what the copy actually holds. Bare (`{...a}`), multi-array (`{...a, ...b}`) and
      // dynamically-annotated spreads keep their index signature and stay dynamic; anything
      // else stays on the refusal below.
      if (spread.kind === 'array' && frontendTypes.objectLiteralIsDynamic(literal, checker)) {
        continue;
      }
      // `{ ...v }` over an Unknown value folds the same way, through the same shape-table
      // `assign`: CopyDataProperties copies whatever own enumerable keys the run-time value has,
      // and skips `undefined`, `null` and the primitives that have none (plan-notes 297). The
      // dynamic-literal requirement holds here by construction whenever the operand is `any`
      // (the literal types `any` with it); a narrowed-to-`never` operand rides on the checker's
      // TS2698, which js mode drops and which leaves the literal `any` too. A dropped `as`
      // assertion joins this arm (`{ ...(o as { x: number }) }`): the assertion names a shape
      // the value need not have, so the result takes the dynamic path and `assign` copies what
      // the run-time value actually holds (`objectLiteralIsDynamic` marks the literal).
      if (spread.kind === 'unknown' && frontendTypes.objectLiteralIsDynamic(literal, checker)) {
        continue;
      }
      if (spread.kind !== 'object') {
        return notYet('an object spread of a value with no fixed shape is not yet supported', 5);
      }
      // A method on an object LITERAL is an own enumerable property, so spreading copies it
      // as data: the lowering expands one bound-closure read per method into the result's
      // hidden slot (plan.md §8 step 12c S-C). A method on a CLASS instance is the opposite:
      // it lives on the prototype, is not own, and must NOT be copied, which the field-only
      // expansion gets right without asking. (An accessor never reaches the fixed path: one
      // forces its whole shape dynamic, which the `object` check above refuses as having no
      // fixed shape.)
      //
      // The copy is sound only when the result preserves the source's slots: a copied method
      // body reads `this` through the SOURCE's slot layout, while the call passes the RESULT
      // as the receiver. TypeScript orders a spread result's members last-group-first, so an
      // appended own key shifts the source's fields and stays not-yet -- spreading the
      // methods-carrying value last preserves them. A dynamic result needs no such rule: it
      // copies the whole source object by name through the shape table. A methods-only source
      // needs none either: its methods read no `this` slots.
      //
      // One dynamic result is still refused: a literal that WRITES an accessor. The checker
      // types a spread result's properties without accessor flags (a spread-copied getter
      // answers as a plain property, verified against the pinned checker), so such a literal
      // routes fixed while holding an accessor pair no layout can hold -- invoking the getter
      // needs step 39's dynamic spread, not this slice's.
      if (spread.methods.length > 0 && spread.name.startsWith('{')) {
        if (
          literal.properties.some(
            (p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p),
          )
        ) {
          return notYet(
            'an object spread of a value with methods into an object literal with an accessor is not yet supported',
            5,
          );
        }
        const contextual = checker.getContextualType(literal);
        const contextualType =
          contextual === undefined ? undefined : frontendTypes.tsTypeToHType(contextual, checker);
        // Mirrors the lowering's layout choice (contextual when it is a shape, else the
        // literal's own): substitution preserves order, so skipping it here cannot change the
        // prefix answer the layout actually gets.
        const own = frontendTypes.tsTypeToHType(checker.getTypeAtLocation(literal), checker);
        const dest = contextualType?.kind === 'object' ? contextualType : own;
        if (
          dest.kind === 'object' &&
          !frontendTypes.objectLiteralIsDynamic(literal, checker) &&
          !objectFieldsPrefix(dest.fields, spread.fields)
        ) {
          return notYet(
            'an object spread of a value with methods that does not preserve its field order is not yet supported',
            5,
          );
        }
      }
      continue;
    }
    // `{ get x() {…}, set x(v) {…} }`. An accessor has no slot to lay out -- it is a get/set pair
    // in the object's slot (docs/VALUE.md §4.15) -- so it never has a fixed shape, and
    // objectLiteralIsDynamic answers that below. A METHOD member rides the same hidden-class
    // descriptor and method table as a class instance (docs/VALUE.md §4.5).
    const accessor = ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property);
    const method = ts.isMethodDeclaration(property);
    if (!accessor && !method && !ts.isPropertyAssignment(property)) {
      return notYet('an object literal with a method member is not yet supported', 5);
    }
    // An accessor under a runtime-computed name has nowhere to go: the lowering keys accessor
    // pairs by name, and a key known only at run time cannot be one. A statically-known
    // computed name (`get ["x"]`, `get [k]` with `k: "x"`) resolves like a value key below.
    if (
      accessor &&
      ts.isComputedPropertyName(property.name) &&
      frontendTypes.computedKeyStaticName(property.name, checker) === null
    ) {
      return notYet('an object literal accessor with a computed name is not yet supported', 5);
    }
    if (!propertyNameIsLayoutKey(property.name, checker)) {
      continue;
    }
  }
  // The CONTEXTUAL type decides the dynamic question, and the order matters: in
  // `const o: { x?: number } = { x: 1 }` the literal's own type is `{ x: number }` -- a perfectly
  // good layout -- but the binding's type is the annotation, and every later read of `o` sees THAT.
  // Building a fixed object here would make each of those reads a runtime not-yet; honoring the
  // annotation builds the dynamic object the reads expect (docs/VALUE.md §4.10).
  if (frontendTypes.objectLiteralIsDynamic(literal, checker)) {
    // `const o: { at: number } = { get at() {…} }`. TypeScript calls that assignable, and it is --
    // structurally. It is not REPRESENTATIONALLY: the literal must be a JSRTDynObject to hold the
    // pair, while every later `o.at` is typed by the annotation and would compile to a slot load
    // on it. There is no conversion to insert (a slot cannot hold "call this on read"), so the
    // mismatch is refused here rather than emitted and read back as garbage.
    const context = checker.getContextualType(literal);
    if (
      context !== undefined &&
      !frontendTypes.isDynamicShape(context, checker) &&
      frontendTypes.tsTypeToHType(context, checker).kind === 'object' &&
      literal.properties.some(
        (p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p),
      )
    ) {
      return notYet(
        'an object literal with an accessor in a position typed as a fixed shape is not yet supported',
        5,
      );
    }
    return { kind: 'accept' };
  }
  return frontendTypes.tsTypeToHType(checker.getTypeAtLocation(literal), checker).kind === 'object'
    ? { kind: 'accept' }
    : // What remains is a shape neither path takes: an interface, or an anonymous shape with a
      // method or accessor member. Both need calling through the shape table, which is Phase 5.
      notYet('an object literal whose shape is not a layout is not yet supported', 5);
}

/** `class C { … }`, minus every member kind whose semantics the fixed-slot layout cannot express.
 *
 * Each rejection below is a real property of the layout, not a scheduling accident: a static
 * initialization block and a static accessor need the class OBJECT, which a plain binding is not;
 * a re-declared FIELD would be two declarations of one slot; an instance `#private` FIELD an
 * ancestor also declares under the SAME class name would be two fields sharing one mangled slot
 * (`#x@A` twice -- per-class mangling holds every other redeclare apart); and a computed member
 * name is not a name at all until there is a shape to look it up in. */
function gateClass(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
  classNameCounts: ClassNameFiles,
): GateResult {
  // A class needs an identity to key its descriptor on: the declared name, Node's `.name`
  // for a bound expression (inner name, else the variable), or `default` for the anonymous
  // `export default class {}`. An unbound expression — a heritage base, a call argument, a
  // parenthesized expression — has no layout key, and nominal equality has nothing to hold
  // onto (plan-notes 278; default imports landed with plan.md §11c T11.5a).
  if (classDisplayName(declaration) === undefined) {
    return ts.isClassExpression(declaration)
      ? notYet('an anonymous class expression is not yet supported', 5)
      : notYet('an anonymous class is not yet supported', 5);
  }
  // A generic expression has nowhere to specialize under: tuple descriptors key on the
  // declaration's source name, and an expression's identity is its binding, not a scope
  // the monomorphizer owns (plan.md §8 step 12(f)).
  if (
    ts.isClassExpression(declaration) &&
    declaration.typeParameters !== undefined &&
    declaration.typeParameters.length > 0
  ) {
    return notYet('a generic class expression is not yet supported', 5);
  }
  // A generic class specializes per tuple, and every tuple shares one descriptor: a nested
  // declaration emits its carrier and tuples where it sits, so the descriptor is scoped to that
  // evaluation exactly like a nested ordinary class's. Sound while the name is unique across
  // the program (two same-named declarations would share one mangled tuple) and nothing above
  // binds a type parameter the tuple would have to close over (an enclosing generic's `T` has
  // no home in a shared descriptor). A generic base from a nested subclass stays held in
  // `gateHeritage` below, and a nested ordinary class stays accepted as before.
  if (
    declaration.typeParameters !== undefined &&
    declaration.typeParameters.length > 0 &&
    !isClassAtModuleScope(declaration)
  ) {
    if (!nestedGenericIsScoped(declaration, classNameCounts)) {
      return notYet('a nested generic class is not yet supported', 5);
    }
  }
  if (
    declaration.typeParameters !== undefined &&
    declaration.typeParameters.length > 0 &&
    !genericNameIsModuleLocal(declaration, classNameCounts)
  ) {
    return notYet(
      "a generic class sharing its name with another module's class is not yet supported",
      11,
    );
  }
  const heritage = gateHeritage(declaration, checker);
  if (heritage.kind !== 'accept') {
    return heritage;
  }
  const inheritedInstance = ancestorMembers(declaration, checker, false);
  const inheritedStatic = ancestorMembers(declaration, checker, true);
  // The one `#private` shape per-class mangling cannot hold apart: an instance FIELD re-declared
  // under one class NAME twice in a chain would mangle to one slot (`#x@A` twice) that two
  // initializers write and two bodies read. Every other re-declare -- fields, methods and
  // accessors across distinct class names, and all statics, whose bindings already carry the
  // declaring class -- has distinct storage and is accepted in the member loop below.
  const collidingPrivate = privateNameCollision(declaration, checker);
  if (collidingPrivate !== undefined) {
    return notYet(
      `a #private member named '${collidingPrivate}' that an ancestor also declares is not yet supported`,
      5,
    );
  }

  let constructors = 0;
  for (const member of declaration.members) {
    // An accessor is a pair of METHODS under a name no source can spell, so it needs nothing the
    // layout does not already have -- which is why the limits below are about the class object and
    // the name, not about accessors as such.
    if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
      // An `abstract` accessor declares; a subclass implementation runs (plan.md §8 step 12(d)),
      // and the lowering gives it the throw-stub plan-notes 275 established for abstract members.
      // Without `abstract`, a bodiless accessor has no implementation anywhere (`declare`).
      if (member.body === undefined && !frontendTypes.hasAbstractModifier(member)) {
        return notYet('an accessor with no body is not yet supported', 5);
      }
      // A computed name with a static name (`get [k]` with `k: "x"`) IS the name the direct
      // spelling writes -- the step-22 computed-literal rule -- so it takes the ordinary
      // accessor path below. A #private name is a name too, scoped to this class body, and
      // lowers as a mangled member function like any other accessor. Anything wider is not a
      // name until there is a shape table to look it up in, and a class layout has none.
      if (
        !ts.isIdentifier(member.name) &&
        !ts.isPrivateIdentifier(member.name) &&
        classMemberStaticName(member, checker) === undefined
      ) {
        return notYet('a computed accessor name is not yet supported', 5);
      }
      if (frontendTypes.isStaticMember(member)) {
        // A static accessor is a pair of plain functions under mangled static bindings (`C.get x`
        // reads through the getter). There is no class object, so only identifier names lower.
        // Shadowing an inherited static follows the shared same-kind rule below: a complete pair
        // over anything keeps one working pair per class, while a lone half would split the pair
        // across the chain.
        const staticOk = classMemberStaticName(member, checker);
        if (staticOk === undefined) {
          return notYet('a static #private accessor name is not yet supported', 5);
        }
        if (ts.isPrivateIdentifier(member.name)) {
          // A static `#private` pair is per-class like any static binding (`C.get #x` vs
          // `D.get #x`), so re-declaring one is shadowing, not overriding -- held to the same
          // complete-pair rule as the identifier spelling: a lone half over an ancestor's pair
          // would resolve its missing half to a binding the subclass never emitted.
          if (!privateStaticPairComplete(member, declaration, checker)) {
            return notYet(`overriding the inherited member '${staticOk}' is not yet supported`, 5);
          }
          continue;
        }
        if (
          inheritedStatic.has(staticOk) &&
          !inheritedShadowIsSameKind(member, declaration, checker)
        ) {
          return notYet(`overriding the inherited member '${staticOk}' is not yet supported`, 5);
        }
        continue;
      }
      if (ts.isPrivateIdentifier(member.name)) {
        // A #private accessor re-declaring an ancestor's #private accessor would be two member
        // functions under one mangled name. A #private FIELD underneath is no collision (a slot
        // is not a method), and neither is a #private method -- only the accessor pair collides.
        const base = frontendTypes.baseClassOf(declaration, checker);
        if (
          base !== undefined &&
          accessorDeclaringClass(base, member.name.text, checker) !== undefined
        ) {
          return notYet(
            `overriding the inherited member '${member.name.text}' is not yet supported`,
            5,
          );
        }
        continue;
      }
      // An accessor re-declaring an inherited name is overriding: each half joins the method
      // table under its mangled name (`get x`, `set x`) exactly like a method -- one slot, one
      // entry per class, virtual dispatch wherever the family declares the half twice (plan.md
      // §8 step 12(d)). The pair must stay WHOLE across the override, and the family needs one
      // table per class, which is the method rule's module-scope limit.
      {
        const overrideName = classMemberStaticName(member, checker);
        if (overrideName !== undefined && inheritedInstance.has(overrideName)) {
          if (!accessorOverrideKeepsPair(overrideName, declaration, checker)) {
            return notYet(
              `overriding the inherited member '${overrideName}' is not yet supported`,
              5,
            );
          }
          if (!isClassAtModuleScope(declaration)) {
            return notYet(
              'overriding a method in a class declared inside a function is not yet supported',
              5,
            );
          }
        }
      }
      continue;
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      // An index signature adds no slot: the layout holds the declared members, which take the
      // ordinary paths. A DYNAMIC key through it waits on dictionary mode, and the member-access
      // rule below refuses exactly those uses.
      continue;
    }
    if (ts.isSemicolonClassElement(member)) {
      continue; // a stray `;` between members declares nothing
    }
    // A static initialization block runs at class-definition time against the statics, which
    // are plain bindings initialized where the class declaration sits. Field initializers and
    // blocks execute in source order (plan.md §8 step 12(d)): the declaration carries every
    // static binding, the fields before the first block initialize with it, and each later
    // field run assigns after its block. One limit keeps that honest: a `super` that does not
    // name a base static would read the class object through a base it has no receiver for
    // (`this` is refused separately, by the `this` rule, as for static methods).
    if (ts.isClassStaticBlockDeclaration(member)) {
      if (staticBlockUsesSuper(member, checker)) {
        return notYet('super in a static initialization block is not yet supported', 5);
      }
      continue;
    }
    if (
      member.name !== undefined &&
      !ts.isIdentifier(member.name) &&
      !ts.isPrivateIdentifier(member.name)
    ) {
      // `[Symbol.iterator]()` is the well-known iterator method, stored under TypeScript's
      // `__@iterator`. A literal-typed computed key (`[k]` with `k: "m"`) is the name the
      // direct spelling writes -- the step-22 computed-literal rule -- so it takes the ordinary
      // member path below. Anything wider is not a name until there is a shape table to look
      // it up in, and a class layout has none: fully dynamic keys stay `STA1214`.
      //
      // Integer-like static names stay refused too: `OrdinaryOwnPropertyKeys` sorts those
      // ahead of the string keys in ascending numeric order, while a fixed layout is
      // declaration order by definition -- the same reason an integer-like object-literal key
      // takes the dynamic path, which a class instance has no form of.
      const staticName =
        ts.isComputedPropertyName(member.name) &&
        !frontendTypes.isGlobalSymbolIteratorName(member.name, checker)
          ? frontendTypes.computedKeyStaticName(member.name, checker)
          : null;
      const isIteratorMethod =
        ts.isMethodDeclaration(member) &&
        !frontendTypes.isStaticMember(member) &&
        frontendTypes.isGlobalSymbolIteratorName(member.name, checker);
      if (!isIteratorMethod && (staticName === null || isIntegerIndex(staticName))) {
        return notYet('a computed class member name is not yet supported', 5);
      }
    }
    // Two `#x` in one chain are TWO fields in JavaScript -- a private name is scoped to the class
    // body that writes it, so a subclass's `#x` does not override its base's, and an instance
    // carries both. Each declaring class gets its own slot under a per-class name (`#x@A` vs
    // `#x@B`), so a re-declaration adds storage instead of colliding -- accepted here and
    // resolved lexically in the lowering. The one shape that still shares one slot (an instance
    // field re-declared under one class name twice in a chain) was refused before the loop,
    // where the whole chain is visible.
    if (ts.isConstructorDeclaration(member)) {
      // An overload signature has no body and declares nothing to emit; the implementation
      // below is what runs, so the signature is skipped once one exists. Two BODIES would be
      // two constructors for one layout, which the checker rejects anyway.
      if (member.body === undefined) {
        const implemented = declaration.members.some(
          (m): m is ts.ConstructorDeclaration =>
            ts.isConstructorDeclaration(m) && m.body !== undefined,
        );
        if (!implemented) {
          return notYet('a constructor overload signature is not yet supported', 5);
        }
        continue;
      }
      constructors++;
      // A derived constructor must call `super(...)` exactly once on every path before
      // touching `this`. JavaScript forbids the touch, and the lowering splices the field
      // initializers right after the call -- which is only a fixed position when the call is
      // one, so a class WITH initializers keeps the top-level rule while a class WITHOUT may
      // call from `if`/`else` arms or `switch` clauses instead (one call per path, every
      // path covered). Statements before it may validate or transform the parameters, which
      // is the shape real constructors take; a `super()` nested in an arrow, a loop, or any
      // other uncountable position does not count.
      if (
        frontendTypes.baseClassOf(declaration, checker) !== undefined &&
        !derivedConstructorOrderOk(member, declaration)
      ) {
        return notYet(
          'a derived constructor that does not open with super(...) is not yet supported',
          5,
        );
      }
      continue;
    }
    // Re-declaring an inherited name. A METHOD over a method is overriding, which the method table
    // handles: same name, same slot, a different entry per class. A FIELD over a field shares one
    // slot, and the initializer order already implements it: the base's run in `super(...)` and
    // the subclass's overwrite after. A static over a same-kind static keeps one binding per
    // declaring class, which is what JavaScript does (`D.n` and `C.n` are independent once both
    // declare it). Anything else -- a slot and a method under one name, or half an accessor
    // pair -- is not expressible and stays refused.
    const inheritedName = frontendTypes.instanceMethodName(member, checker);
    // An overload signature declares nothing to emit -- the same-name implementation carries
    // the override, so the signature itself skips this check and is vetted by the method arm
    // below. (Constructors never reach here; their arm continues first.)
    const isBodilessOverload =
      ts.isMethodDeclaration(member) && member.body === undefined && inheritedName !== undefined;
    if (
      !isBodilessOverload &&
      inheritedName !== undefined &&
      (frontendTypes.isStaticMember(member) ? inheritedStatic : inheritedInstance).has(
        inheritedName,
      )
    ) {
      if (!inheritedShadowIsSameKind(member, declaration, checker)) {
        const base = frontendTypes.baseClassOf(declaration, checker);
        const overridesMethod =
          !frontendTypes.isStaticMember(member) &&
          ts.isMethodDeclaration(member) &&
          base !== undefined &&
          frontendTypes.methodDeclaringClass(base, inheritedName, checker) !== undefined;
        if (!overridesMethod) {
          return notYet(
            `overriding the inherited member '${inheritedName}' is not yet supported`,
            5,
          );
        }
        // A method table is one file-scope constant per class, so no method in an overriding family
        // may capture. A class at module scope has nothing to capture; a class inside a function may,
        // and there is no per-instantiation table to hold what it captured.
        if (!isClassAtModuleScope(declaration)) {
          return notYet(
            'overriding a method in a class declared inside a function is not yet supported',
            5,
          );
        }
      }
    }
    if (ts.isMethodDeclaration(member)) {
      if (member.body === undefined) {
        // An `abstract` method declares; a subclass implementation runs (plan.md §8 step
        // 12(d)). Without `abstract`, the implementation must share this class — the
        // overload rule below, or refused there when no implementation exists.
        if (frontendTypes.hasAbstractModifier(member)) {
          continue;
        }
        // An overload signature declares nothing to emit; the same-name implementation below
        // runs. With no implementation in the class there is nothing to run (`declare` members).
        const name = frontendTypes.instanceMethodName(member, checker);
        const implemented = declaration.members.some(
          (m) =>
            m !== member &&
            ts.isMethodDeclaration(m) &&
            m.body !== undefined &&
            frontendTypes.instanceMethodName(m, checker) === name,
        );
        if (!implemented) {
          return notYet('a method overload signature is not yet supported', 5);
        }
        continue;
      }
      if (member.asteriskToken !== undefined) {
        return generatorNotYet();
      }
      if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) {
        // The async lowering gives a function one heap environment holding every binding it has.
        // A method also has a receiver, which arrives as a parameter and would have to join them;
        // that is a second question, and it lands with the second slice rather than by accident.
        return notYet('an async method is not yet supported', 5);
      }
      // An optional method WITH a body is always present at runtime -- the `?` only narrows
      // assignability, so it lowers as a plain method. (A signature without a body was skipped by
      // the overload rule above, or refused there when no implementation exists.)
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      // `x?: number = 1` is always present too: the initializer runs for every instance, so the
      // slot behaves exactly like a required field's. An UNINITIALIZED optional (`x?: number;`)
      // lands on the same fixed-shape slot with nothing emitted: every slot starts `undefined`
      // in `jsrt_object_new`, and a static without an initializer lowers to an `undefined`
      // binding, so the read answers what Node answers. The `in`-vs-absent distinction is not
      // kept -- but neither is it for a required field with no initializer, which already takes
      // this path. Only a plain data field (an identifier or `#private` name) lands here: any
      // other spelling keeps its STA1214, as do accessors and computed members via their own
      // arms above (which fire first; this guard holds the boundary if that order ever moves).
      // A literal-typed computed field (`[k]?: number` with `k: "x"`) is a plain data field
      // under the step-22 rule, so it joins the identifier path rather than this refusal.
      if (
        member.questionToken !== undefined &&
        member.initializer === undefined &&
        !ts.isIdentifier(member.name) &&
        !ts.isPrivateIdentifier(member.name) &&
        classMemberStaticName(member, checker) === undefined
      ) {
        return notYet('an optional class field is not yet supported', 5);
      }
      continue;
    }
    return notYet('this class member is not yet supported', 5);
  }
  if (constructors > 1) {
    return notYet('more than one constructor is not yet supported', 5);
  }
  // A class expression is a VALUE where a declaration is a binding: it compiles only as
  // the initializer of a single-`const` identifier (`const C = class …`), which binds no value
  // — every in-place use erases to the expression, whose descriptor the lowering emits under
  // the variable's name (plan.md §8 step 12(d)). Any other position (`let`, a call argument,
  // a heritage base) has no identity to key the layout on, and reads as the expression it is.
  // Member-specific refusals above still fire first, so a broken member reads as broken
  // rather than as deferred.
  if (ts.isClassExpression(declaration)) {
    const parent = declaration.parent;
    const bound =
      parent !== undefined &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === declaration &&
      isClassFormationDeclarator(parent, checker);
    if (!bound) {
      const name = declaration.name?.text;
      return name === undefined
        ? notYet('an anonymous class expression is not yet supported', 5)
        : notYet(`a class expression '${name}' is not yet supported`, 5);
    }
  }
  return { kind: 'accept' };
}

/** Whether a class sits at module scope: a declaration directly under the source file, or an
 * expression whose whole statement does. `const C = class …` nests the class inside the
 * declaration that binds it, so reading the direct parent would call every top-level expression
 * "nested" -- the walk passes through the binding and statement wrappers (and an
 * `export default (…)` around one) to the statement that is, or is not, at the top level. */
function isClassAtModuleScope(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
  let current: ts.Node = node;
  while (
    ts.isVariableDeclaration(current.parent) ||
    ts.isVariableDeclarationList(current.parent) ||
    ts.isVariableStatement(current.parent) ||
    ts.isExpressionStatement(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isExportAssignment(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isSourceFile(current.parent);
}

/** The `extends`/`implements` clauses. `implements` is type-only and erases, so it contributes
 * nothing to a layout and is simply allowed. `extends` must name a class this compiler lays out:
 * extending an expression, a built-in, or an ambient declaration reaches a layout that was never
 * emitted. */
function gateHeritage(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): GateResult {
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      continue;
    }
    if (clause.types.length !== 1) {
      return notYet('extending other than exactly one class is not yet supported', 5);
    }
    const base = frontendTypes.baseClassOf(declaration, checker);
    if (base === undefined) {
      return notYet('extending anything but a class declaration is not yet supported', 5);
    }
    // A generic base lays out per tuple: `extends Box<number>` threads the base's substituted
    // layout through the ancestry the type model builds once per declaration. That grounding is
    // exact while the subclass names one complete tuple — a non-generic subclass at module scope
    // extending a module-scope base with explicit, fully concrete arguments — and the descriptor,
    // method owner, vtable and super-call all name that tuple's specialization. Anything wider
    // (a generic subclass, which would need per-tuple bases; a raw or partial bound; an argument
    // nothing binds) keeps the refusal, as does a nested subclass, whose descriptors are
    // function-scoped. A generic subclass of an ordinary base is unaffected — only the base
    // position is held.
    if (base.typeParameters !== undefined && base.typeParameters.length > 0) {
      if (!genericBaseArgumentsAreConcrete(declaration, base, checker)) {
        return notYet('extending a generic class is not yet supported', 5);
      }
    }
  }
  return { kind: 'accept' };
}

/** Whether `extends Base<...>` on `declaration` names one complete tuple the layout can ground
 * once: a non-generic subclass at module scope extending a module-scope base with explicit,
 * full-arity, fully concrete arguments. A generic subclass would need its base re-grounded per
 * tuple, and a nested subclass would need function-scoped descriptors — both later slices, both
 * refused with the same message. */
function genericBaseArgumentsAreConcrete(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  base: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): boolean {
  if (
    (declaration.typeParameters !== undefined && declaration.typeParameters.length > 0) ||
    !isClassAtModuleScope(declaration) ||
    !isClassAtModuleScope(base)
  ) {
    return false;
  }
  const clause = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const args = clause?.types[0]?.typeArguments ?? [];
  const parameters = base.typeParameters ?? [];
  if (args.length !== parameters.length) {
    return false;
  }
  // Concrete in the scope the subclass is written in: any type parameter nothing binds would
  // survive into the layout the type model builds once per declaration. The deep walk matters —
  // `Box<Bag<T>>` mentions `T` inside an object the shallow check cannot see — and the bound set
  // is the enclosing declarations', which for the accepted shape is empty.
  const bound = enclosingTypeParameterNames(declaration);
  return args.every((arg) => {
    const type = frontendTypes.tsTypeToHType(checker.getTypeFromTypeNode(arg), checker);
    return !mentionsUnboundParameter(type, bound);
  });
}

/** Whether a nested generic class is scoped tightly enough to specialize in place: nothing
 * above binds a type parameter the tuple would have to close over, and the name is unique
 * across the program, so the one mangled tuple names one declaration. */
function nestedGenericIsScoped(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  classNameCounts: ClassNameFiles,
): boolean {
  const name = declaration.name?.text;
  if (name === undefined) {
    return false;
  }
  if (enclosingTypeParameterNames(declaration).size > 0) {
    return false;
  }
  return (classNameCounts.get(name)?.length ?? 0) === 1;
}

/** Whether no OTHER module declares a class under a generic class's name. Every module keeps its
 * own namespace (plan.md §11c T11.5a), and an ordinary class takes a fresh HIR name when another
 * module's class shares its spelling, but a generic one specializes under the bare source name
 * (`Box<number>`) -- which the frontend also spells for generic bases, before any module scope
 * exists -- so a second module's `Box` would share its descriptors. */
function genericNameIsModuleLocal(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  classNameCounts: ClassNameFiles,
): boolean {
  const name = declaration.name?.text;
  const file = declaration.getSourceFile();
  return (
    name === undefined ||
    (classNameCounts.get(name) ?? []).every((declaredIn) => declaredIn === file)
  );
}

/** Every member name declared by any ANCESTOR -- fields and methods alike, because the two collide
 * with each other: a subclass field shadowing an inherited field would need two slots for one name,
 * and a subclass method shadowing an inherited field would need a slot and no slot at once. */
function ancestorMembers(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
  wantStatic: boolean,
): Set<string> {
  const names = new Set<string>();
  for (const base of frontendTypes.ancestry(declaration, checker).reverse().slice(1)) {
    for (const member of base.members) {
      // Statics and instance members are separate namespaces: `C.count` and `c.count` can coexist
      // and name different things, so a shadowing check that merged them would refuse legal code.
      // A literal-typed computed key (`[k]` with `k: "m"`) declares the name the direct
      // spelling writes, so it joins the set its spelling would have; anything wider declares
      // no static name and stays out of it. `#private` names stay out too -- they never shadow:
      // each declaring class owns its spelling under a per-class name, and
      // `privateNameCollision` holds the one boundary that mangling cannot express.
      const declared =
        member.name !== undefined &&
        !ts.isPrivateIdentifier(member.name) &&
        frontendTypes.isStaticMember(member) === wantStatic
          ? ts.isIdentifier(member.name)
            ? member.name.text
            : classMemberStaticName(member, checker)
          : undefined;
      if (declared !== undefined) {
        names.add(declared);
      } else if (
        !wantStatic &&
        ts.isMethodDeclaration(member) &&
        !frontendTypes.isStaticMember(member) &&
        frontendTypes.instanceMethodName(member, checker) === frontendTypes.ITERATOR_METHOD_NAME
      ) {
        names.add(frontendTypes.ITERATOR_METHOD_NAME);
      }
    }
  }
  return names;
}

/** Whether re-declaring the inherited `member.name` shares rather than collides.
 *
 * Instance methods are never same-kind here: an override needs the method table (and its
 * module-scope rule), which the caller checks separately. What shares: an instance field over
 * an instance field (one slot, subclass initializers overwrite), and a static over a same-kind
 * static (one binding per declaring class). A static accessor pair counts only when the
 * subclass declares BOTH halves -- a lone half would split the pair across the chain, with the
 * missing half resolving to a binding the subclass never emitted. */
function inheritedShadowIsSameKind(
  member: ts.ClassElement,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): boolean {
  const name = frontendTypes.instanceMethodName(member, checker);
  // An identifier or a literal-typed computed key declares a name; anything wider never reaches
  // here (the member arms refused it), and a string/numeric literal spelling keeps its old
  // verdict by failing this test exactly as before. `#private` names never share -- a subclass
  // `#x` is a second slot even over an ancestor's public `"#x"` -- so they fail it too, and the
  // per-class mangling (`privateNameCollision` holding its one boundary) owns them instead.
  if (
    name === undefined ||
    member.name === undefined ||
    ts.isPrivateIdentifier(member.name) ||
    (!ts.isIdentifier(member.name) && classMemberStaticName(member, checker) === undefined)
  ) {
    return false;
  }
  const wantStatic = frontendTypes.isStaticMember(member);
  const seen = new Set<ts.ClassDeclaration | ts.ClassExpression>();
  for (
    let current: ts.ClassDeclaration | ts.ClassExpression | undefined = frontendTypes.baseClassOf(
      declaration,
      checker,
    );
    current !== undefined && !seen.has(current);
    current = frontendTypes.baseClassOf(current, checker)
  ) {
    seen.add(current);
    const found = current.members.find(
      (m) =>
        frontendTypes.isStaticMember(m) === wantStatic &&
        m.name !== undefined &&
        !ts.isPrivateIdentifier(m.name) &&
        (ts.isIdentifier(m.name) ? m.name.text : classMemberStaticName(m, checker)) === name,
    );
    if (found === undefined) {
      continue;
    }
    if (!wantStatic) {
      return ts.isPropertyDeclaration(member) && ts.isPropertyDeclaration(found);
    }
    if (ts.isPropertyDeclaration(member) && ts.isPropertyDeclaration(found)) {
      return true;
    }
    if (ts.isMethodDeclaration(member) && ts.isMethodDeclaration(found)) {
      return true;
    }
    if (
      (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      (ts.isGetAccessorDeclaration(found) || ts.isSetAccessorDeclaration(found))
    ) {
      return (
        declaration.members.some(
          (m) =>
            ts.isGetAccessorDeclaration(m) &&
            frontendTypes.isStaticMember(m) &&
            classMemberStaticName(m, checker) === name,
        ) &&
        declaration.members.some(
          (m) =>
            ts.isSetAccessorDeclaration(m) &&
            frontendTypes.isStaticMember(m) &&
            classMemberStaticName(m, checker) === name,
        )
      );
    }
    return false;
  }
  return false;
}

/** The name a class member declares when it is an identifier, a `#private` name, or a
 * literal-typed computed key (`[k]` with `k: "m"` -- the step-22 computed-literal rule).
 * `undefined` for anything wider, and for string/numeric literal spellings, which keep their
 * own verdict: this helper learns exactly the computed case, never a second spelling for
 * what the member arms already refuse. */
function classMemberStaticName(
  member: ts.ClassElement,
  checker: ts.TypeChecker,
): string | undefined {
  if (member.name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) {
    return member.name.text;
  }
  if (ts.isComputedPropertyName(member.name)) {
    return frontendTypes.computedKeyStaticName(member.name, checker) ?? undefined;
  }
  return undefined;
}

/** Whether `declaration` (or any ancestor) declares an index signature.
 *
 * A class with one still has a fixed layout of its declared members; only the dynamic keys wait
 * on dictionary mode, and the member-access rule refuses exactly those uses. */
function classHasIndexSignature(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): boolean {
  for (const current of frontendTypes.ancestry(declaration, checker).reverse()) {
    if (current.members.some((m) => ts.isIndexSignatureDeclaration(m))) {
      return true;
    }
  }
  return false;
}

/** An instance `#private` FIELD spelling the chain cannot hold apart, if any.
 *
 * Per-class mangling (`#x` in `A` is `#x@A`) gives every re-declare distinct storage -- except
 * two instance fields under one class NAME in one chain, which mangle alike and would share a
 * slot two initializers write. Only instance FIELDS collide: methods and accessors are looked up
 * by (lexical owner, name) rather than by slot, and statics already carry the declaring class in
 * the binding name, so neither shares storage however the names repeat. A get/set pair is one
 * property, not two declarations, so the halves share one entry here. */
function privateNameCollision(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): string | undefined {
  const seen = new Set<string>();
  for (const current of frontendTypes.ancestry(declaration, checker).reverse()) {
    const owner = current.name?.text;
    if (owner === undefined) {
      continue;
    }
    for (const member of current.members) {
      if (
        member.name === undefined ||
        !ts.isPrivateIdentifier(member.name) ||
        !ts.isPropertyDeclaration(member) ||
        frontendTypes.isStaticMember(member)
      ) {
        continue;
      }
      const key = `${owner}
${member.name.text}`;
      if (seen.has(key)) {
        return member.name.text;
      }
      seen.add(key);
    }
  }
  return undefined;
}

/** Whether a static `#private` accessor re-declaration keeps a working pair: the subclass
 * declares BOTH halves, or no ancestor declares either. A lone half over an ancestor's pair
 * would split the pair across the chain -- the private twin of the identifier rule
 * `inheritedShadowIsSameKind` states for the same shape. */
function privateStaticPairComplete(
  member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): boolean {
  if (member.name === undefined || !ts.isPrivateIdentifier(member.name)) {
    return true;
  }
  const name = member.name.text;
  const own = (half: 'get' | 'set'): boolean =>
    declaration.members.some(
      (m) =>
        frontendTypes.isStaticMember(m) &&
        m.name !== undefined &&
        ts.isPrivateIdentifier(m.name) &&
        m.name.text === name &&
        (half === 'get' ? ts.isGetAccessorDeclaration(m) : ts.isSetAccessorDeclaration(m)),
    );
  if (own('get') && own('set')) {
    return true;
  }
  for (const base of frontendTypes.ancestry(declaration, checker).reverse().slice(1)) {
    if (
      base.members.some(
        (m) =>
          (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) &&
          frontendTypes.isStaticMember(m) &&
          m.name !== undefined &&
          ts.isPrivateIdentifier(m.name) &&
          m.name.text === name,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Whether an accessor re-declaring an inherited accessor keeps the pair WHOLE: this class
 * declares exactly the halves the inherited declaration does (get-only over get-only, set-only
 * over set-only, pair over pair).
 *
 * A dropped half is where the method table would disagree with Node: the derived accessor
 * SHADOWS the inherited pair, so a write to a get-only shadow throws (compiled modules are
 * strict) and a read of a set-only one answers `undefined`, while the table would dispatch the
 * missing half to the base's body. An ADDED half has no slot in a base-typed layout for a
 * base-typed site to index (the checker types a read of a set-only base, and refuses a write to
 * a get-only one). Half-for-half the VARIANCE is the checker's (get covariant, set
 * contravariant -- its TS2416 is the refusal); what is decided here is only the shape.
 */
function accessorOverrideKeepsPair(
  name: string,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): boolean {
  const base = frontendTypes.baseClassOf(declaration, checker);
  const inherited = base === undefined ? undefined : accessorDeclaringClass(base, name, checker);
  if (inherited === undefined) {
    return false; // a field or method owns the name; the kind mismatch is its own refusal
  }
  let get = false;
  let set = false;
  for (const m of declaration.members) {
    if (frontendTypes.isStaticMember(m) || classMemberStaticName(m, checker) !== name) {
      continue;
    }
    if (ts.isGetAccessorDeclaration(m)) {
      get = true;
    } else if (ts.isSetAccessorDeclaration(m)) {
      set = true;
    }
  }
  return get === inherited.get && set === inherited.set;
}

/** Whether a derived constructor calls `super(...)` exactly once on every completion path
 * before touching `this` — and, when the class declares instance field initializers, from a
 * single fixed position.
 *
 * Field initializers splice right after the super call, which is only a fixed position when
 * the call is a top-level statement: a class WITH initializers keeps the old rule (one
 * top-level `super(...)`, nothing nested). A class with NONE has nothing to splice, so the
 * call may sit in `if`/`else` arms or `switch` clauses instead — one call per path, every
 * path covered, no reads before it on any path — which is the shape real validating
 * constructors take. Anything with no fixed count (loops, a second call on a path that
 * already ran one — Node answers `ReferenceError: Super constructor may only be called
 * once` on a re-run) or no fixed position (arrows, nested functions, `try`, a `super` in a
 * condition) stays refused: skipping the call leaves `this` unbound — Node answers
 * `ReferenceError` when such a constructor completes, which this runtime does not, so the
 * gate refuses rather than compile a program that silently answers differently — and
 * re-running the base constructor re-initializes its fields. Completion is what owes the
 * call: a path that leaves by `throw` propagates exactly as Node's does and owes nothing,
 * while a `return` completes the construction (`new` yields the receiver), so a return
 * before the call is the skipped-call shape. A VALUE return is refused one level up, at the
 * ReturnStatement arm — `new` cannot honor one at all. */
function derivedConstructorOrderOk(
  ctor: ts.ConstructorDeclaration,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): boolean {
  // Instance field initializers (public and `#private` alike) splice after the call, so only
  // their absence frees the call from one fixed position. Uninitialized fields need no
  // splicing — every slot starts `undefined` — and statics never enter the constructor.
  const flexible = !declaration.members.some(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      !frontendTypes.isStaticMember(member) &&
      member.initializer !== undefined,
  );
  const exits = checkCtorList(ctor.body?.statements ?? [], flexible, 'zero');
  return exits !== null && exits.brk === null && (exits.fall === null || exits.fall === 'one');
}

/** How many `super(...)` calls the surviving paths have run: none, one (the base is
 * initialized), or both — the merge of paths that disagree, where a further call or a
 * receiver read is indistinguishable from a re-run or a pre-call read and refused as such. */
type SuperCount = 'zero' | 'one' | 'mixed';

/** Where the paths through a statement list leave it, or `null` when the rule refuses.
 * `fall` holds the call count of the paths falling out the bottom (`null`: every path left
 * earlier); `brk` the count of the paths a `break` carried out toward the nearest enclosing
 * `switch` (`null`: none). Return and throw paths are checked where they leave and then
 * dropped: both exit the constructor, one owing exactly one call and the other at most one. */
type CtorFlow = { readonly fall: SuperCount | null; readonly brk: SuperCount | null } | null;

/** Join the call counts of two path sets. `null` is the empty set — the identity — because
 * a merge only constrains the paths that exist. */
function mergeSuper(a: SuperCount | null, b: SuperCount | null): SuperCount | null {
  if (a === null || b === null) {
    return a === null ? b : a;
  }
  return a === b ? a : 'mixed';
}

/** The straight-line rule, plus `if`/`else` arms and `switch` clauses when `flexible` (see
 * above). Arms and clause chains are checked by the same rule recursively at the count the
 * surrounding paths carry in, so nesting costs nothing extra; a missing `else` (or
 * `default`) passes its uncovered paths through at that count, which a later call then
 * covers — or a later read refuses. */
function checkCtorList(
  statements: readonly ts.Statement[],
  flexible: boolean,
  entry: SuperCount,
): CtorFlow {
  let count = entry;
  let breaks: SuperCount | null = null;
  for (const stmt of statements) {
    if (isTopLevelSuperCall(stmt)) {
      // A call on a path that already ran one re-runs the base constructor; Node answers
      // ReferenceError, so the gate answers no. Straight-line double calls
      // (`super(); super();`) land here too — same re-run, same refusal.
      if (count !== 'zero') {
        return null;
      }
      // Arguments evaluate before the call binds `this`, so a receiver read among them is a
      // read before the call — and a nested `super(...)` among them is the re-run above.
      const call = stmt.expression;
      if (ts.isCallExpression(call) && call.arguments.some((arg) => readsThisOrSuper(arg))) {
        return null;
      }
      count = 'one';
      continue;
    }
    // A `break` leaves for the enclosing `switch`, where the clause-chain analysis joins it
    // with the other continuing exits. It truncates: nothing after it runs on these paths.
    if (ts.isBreakStatement(stmt)) {
      // A labeled break names a jump whose target sits outside every list this analysis
      // sees; only a checker-missed label can spell one here.
      if (stmt.label !== undefined) {
        return null;
      }
      return { fall: null, brk: mergeSuper(breaks, count) };
    }
    if (ts.isContinueStatement(stmt)) {
      return null;
    }
    // `return` COMPLETES the construction — `new` yields the receiver — so a return before
    // the call is exactly the skipped-call path Node answers ReferenceError for, and a
    // return after it retires the path with its one call spent.
    if (ts.isReturnStatement(stmt)) {
      if (count !== 'one') {
        return null;
      }
      return { fall: null, brk: breaks };
    }
    // A `throw` propagates out of the construction exactly as Node's does, so the path owes
    // no call at all and retires with whatever count it holds (never above one).
    if (ts.isThrowStatement(stmt)) {
      return { fall: null, brk: breaks };
    }
    // A bare block groups statements without branching them: its exits merge like
    // straight-line code. Like an `if` arm, a block hides the call from the splicer's
    // top-level scan, so it counts only when there is nothing to splice (`flexible`).
    if (flexible && ts.isBlock(stmt)) {
      const inner = checkCtorList(stmt.statements, flexible, count);
      if (inner === null) {
        return null;
      }
      breaks = mergeSuper(breaks, inner.brk);
      if (inner.fall === null) {
        return { fall: null, brk: breaks };
      }
      count = inner.fall;
      continue;
    }
    if (flexible && ts.isIfStatement(stmt) && !nestedSuperCall(stmt.expression)) {
      // A `super` in the condition runs unconditionally but in expression position, where
      // the initializers cannot follow it; a `this` there reads before any call. Both are
      // the nested shapes below wearing a condition's clothes.
      if (count !== 'one' && readsThisOrSuper(stmt.expression)) {
        return null;
      }
      const thenFlow = checkCtorList([stmt.thenStatement], flexible, count);
      if (thenFlow === null) {
        return null;
      }
      // A missing `else` is a path straight through at the count the arms were entered
      // with — the uncovered path the end criterion later refuses unless a call covers it.
      const elseFlow =
        stmt.elseStatement === undefined
          ? { fall: count, brk: null }
          : checkCtorList([stmt.elseStatement], flexible, count);
      if (elseFlow === null) {
        return null;
      }
      breaks = mergeSuper(mergeSuper(breaks, thenFlow.brk), elseFlow.brk);
      const merged = mergeSuper(thenFlow.fall, elseFlow.fall);
      if (merged === null) {
        return { fall: null, brk: breaks };
      }
      count = merged;
      continue;
    }
    if (flexible && ts.isSwitchStatement(stmt)) {
      // The discriminant and every case test evaluate at the entry count, before any clause
      // body runs; a `super(...)` among them would run mid-dispatch.
      const tests: ts.Expression[] = [stmt.expression];
      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          tests.push(clause.expression);
        }
      }
      for (const test of tests) {
        if (nestedSuperCall(test) || (count !== 'one' && readsThisOrSuper(test))) {
          return null;
        }
      }
      // Execution enters exactly one clause body (or the `default`, wherever it sits) and
      // falls through every body below it until a `break`, `return` or `throw` leaves. So
      // each clause ENTRY is a path of its own — the concatenation of the bodies from that
      // clause down, which is what makes a fall-through re-run visible: a case that ran
      // `super(...)` and falls into another case's call concatenates two calls and is
      // refused by the straight-line rule. A break or the end of the last body both leave
      // for the statement after the switch, so each chain's continuing exits join there.
      const clauses = stmt.caseBlock.clauses;
      let fall: SuperCount | null = null;
      for (const [index] of clauses.entries()) {
        const chain: ts.Statement[] = [];
        for (const later of clauses.slice(index)) {
          chain.push(...later.statements);
        }
        const flow = checkCtorList(chain, flexible, count);
        if (flow === null) {
          return null;
        }
        fall = mergeSuper(fall, mergeSuper(flow.fall, flow.brk));
      }
      // With no `default` the unmatched path runs no body at all: it leaves at the entry
      // count, so a super-carrying switch without one never certifies coverage. An empty
      // `default` is no cover either — its path leaves just as uncovered.
      if (!clauses.some((clause) => ts.isDefaultClause(clause))) {
        fall = mergeSuper(fall, count);
      }
      if (fall === null) {
        return { fall: null, brk: breaks };
      }
      count = fall;
      continue;
    }
    // A `super()` nested anywhere but a nested class (whose own constructor owns it) re-runs
    // the base constructor from a position the initializers cannot follow.
    if (nestedSuperCall(stmt)) {
      return null;
    }
    // Loops and the remaining compound statements are opaque here: a receiver read or a
    // `return` buried in one fires before the statement retires on the paths that reach it,
    // so the entry count governs both — and `one` is spent before the first iteration.
    if (count !== 'one' && (readsThisOrSuper(stmt) || containsReturn(stmt))) {
      return null;
    }
  }
  return { fall: count, brk: breaks };
}

/** `super(...)` as a statement of its own, rather than nested in another expression. */
function isTopLevelSuperCall(stmt: ts.Statement): stmt is ts.ExpressionStatement {
  return (
    ts.isExpressionStatement(stmt) &&
    ts.isCallExpression(stmt.expression) &&
    stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

/** Whether `node` hides a `return` that completes the enclosing function — the one this
 * constructor analysis stands in. Every function-like bounds the walk (arrows included:
 * their `return` completes the arrow), as does a nested class body, whose members return
 * from their own functions. */
function containsReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      found ||
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(node);
  return found;
}

/** Whether this node's nearest enclosing function-like is a constructor. A return inside a
 * nested function or arrow completes THAT body and is no constructor return. */
function enclosingFunctionIsConstructor(node: ts.Node): boolean {
  for (let owner: ts.Node = node; owner.kind !== ts.SyntaxKind.SourceFile; owner = owner.parent) {
    if (ts.isFunctionLike(owner)) {
      return ts.isConstructorDeclaration(owner);
    }
  }
  return false;
}

/** Whether `node` hides a `super(...)` call in a nested position. Nested class bodies are
 * skipped: a `super()` there belongs to the inner class, which the gate vets on its own. */
function nestedSuperCall(node: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(node);
  return found;
}

/** Whether `node` reads `this` or `super` outside a nested function or class body, whose own
 * `this`/`super` the gate vets where they stand. Arrows do not bound the walk: an arrow's `this`
 * IS the enclosing constructor's, and a `super()` nested in one has no fixed position for the
 * initializers, so neither counts as "before". */
function readsThisOrSuper(node: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      found ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(node);
  return found;
}

/** `new C(…)`, admitted only when `C` resolves to a class this subset models. `new (pick())()` and
 * `new Date()` are the same syntax reaching something the emitter cannot name. */
/** The Map and Set surface the subset compiles, with the argument count each operation takes.
 *
 * A closed list, not a lookup on the lib declarations: everything here is one runtime function, and
 * `keys`/`values`/`entries` box a JSRTIterator (Phase 5 step 8). Reading the list off the lib
 * would turn a missing name into an internal error instead of a `not-yet`.
 *
 * `forEach` IS here, and was previously grouped with them by mistake: it takes a callback, not an
 * iterator, and the runtime calls it through `jsrt_call` exactly as the `Array.prototype` callback
 * methods already do — no protocol the subset lacks (plan-notes 97). */
const COLLECTION_OPS: Readonly<Record<'map' | 'set', Readonly<Record<string, number>>>> = {
  map: { get: 1, set: 2, has: 1, delete: 1, clear: 0, forEach: 1, keys: 0, values: 0, entries: 0 },
  set: {
    add: 1,
    has: 1,
    delete: 1,
    clear: 0,
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

/** `'map'`, `'set'`, or undefined for anything that is not one — the receiver test every rule
 * below shares. It asks the TYPE, so a `Map` the checker resolved through an alias or a type
 * parameter answers the same as one written out. */
function collectionOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): 'map' | 'set' | undefined {
  const type = frontendTypes.tsTypeToHType(checker.getTypeAtLocation(expression), checker);
  return type.kind === 'map' || type.kind === 'set' ? type.kind : undefined;
}

/** The name as the source spells it, for a message a reader can match to their own code. */
function collectionName(collection: 'map' | 'set'): string {
  return collection === 'map' ? 'Map' : 'Set';
}

/** `m.get(k)`, `s.add(v)` and the rest: a call on a Map or a Set, or undefined if this is not one.
 *
 * The argument count IS checked here, unlike an ordinary call, and for a reason that does not apply
 * there: a user function tolerates extra and missing arguments because JavaScript does, but these
 * lower to a runtime function with a fixed C signature. `m.set(k)` with the value missing has no
 * `undefined` to pass — there is no argv to pad. */
function gateCollectionCall(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): GateResult | undefined {
  const collection =
    collectionOf(callee.expression, checker) ?? constraintCollection(callee.expression, checker);
  if (collection === undefined) {
    return undefined;
  }
  const arity = COLLECTION_OPS[collection][callee.name.text];
  if (arity === undefined) {
    return notYet(`${callee.name.text} on a ${collectionName(collection)} is not yet supported`, 5);
  }
  // Each op is one fixed-arity node, and a spread's count is not its arity.
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) {
    return notYet(
      `a spread argument to a ${collectionName(collection)} method is not yet supported`,
      5,
    );
  }
  if (call.arguments.length !== arity) {
    return notYet(
      `${collectionName(collection)}.${callee.name.text} with ${String(call.arguments.length)} arguments is not yet supported`,
      5,
    );
  }
  if (isSetOperation(callee.name.text)) {
    // The spec takes a SET-LIKE object here -- anything with a `size`, a `has` and a `keys` -- and
    // reads it by calling `keys()` on a user object, which is still the user-iterable protocol. A
    // real Set is read straight out of the table instead, so that is the whole of what is accepted:
    // the runtime reads this argument as a JSRTMap, and a wrong one is not a wrong answer.
    const other = call.arguments[0];
    if (other === undefined || collectionOf(other, checker) !== 'set') {
      return notYet(
        `Set.${callee.name.text} with an argument that is not a Set is not yet supported`,
        5,
      );
    }
    return { kind: 'accept' };
  }
  if (callee.name.text === 'forEach') {
    // The same rule the array callback ops follow: a callback the checker cannot type as callable
    // would reach jsrt_call as a non-closure and die there, and an `any` callback in js mode lands
    // here too. Refusing it is the honest answer until the dynamic tier can carry one.
    const cb = call.arguments[0];
    if (
      cb === undefined ||
      checker.getSignaturesOfType(checker.getTypeAtLocation(cb), ts.SignatureKind.Call).length === 0
    ) {
      return notYet(
        `${collectionName(collection)}.forEach with a non-function callback is not yet supported`,
        5,
      );
    }
  }
  return { kind: 'accept' };
}

/** Whether a member's receiver goes through the shape table the way an Unknown one does: its
 * HType is Unknown, or -- in `js` mode -- it reads a function's own property (`F.prototype`),
 * whose checker type is no layout (plan-notes 310). */
function readsAsUnknown(
  receiver: ts.Expression,
  shape: HType,
  checker: ts.TypeChecker,
  mode: Mode,
): boolean {
  return (
    shape.kind === 'unknown' ||
    (mode === 'js' && frontendTypes.isFunctionMemberRead(receiver, checker))
  );
}

/** An own property of an ordinary function (`f.count`, `F.prototype`): the closure's property
 * table in `js` mode (plan-notes 310). `ts` mode would need the member typed, and the property
 * table is untyped, so it waits on Phase 8's descriptor surface. */
function functionMemberResult(mode: Mode): GateResult {
  return mode === 'js'
    ? { kind: 'accept' }
    : notYet('a property of a function value is not yet supported in ts mode', 8);
}

function gateNew(node: ts.NewExpression, checker: ts.TypeChecker, mode: Mode): GateResult {
  if (dynamicCodeGeneration(node.expression, checker) === 'function') {
    return functionCtorResult(mode);
  }
  // Checked before the type-argument rejection below, because `new Map<string, number>()` is how a
  // typed Map is spelled: the arguments fill K and V, which the checker resolves and the HType
  // carries, rather than asking for the generic instantiation the rejection is about.
  const collection = collectionOf(node, checker);
  if (collection !== undefined) {
    // An argument is an ITERABLE of entries -- `new Map([['a', 1]])` -- and iterating one is the
    // Symbol.iterator protocol, not a constructor detail.
    return node.arguments === undefined || node.arguments.length === 0
      ? { kind: 'accept' }
      : notYet(
          `constructing a ${collectionName(collection)} from an iterable is not yet supported`,
          5,
        );
  }
  if (isGlobalPromise(node.expression, checker)) {
    const args = node.arguments ?? [];
    const executor = args[0];
    if (args.length === 1 && executor !== undefined && !ts.isSpreadElement(executor)) {
      return { kind: 'accept' };
    }
    return {
      kind: 'not-yet',
      code: 'STA1216',
      message:
        'new Promise(executor) is not yet supported: the executor is a JS callback whose throw ' +
        'must become a rejection, which needs a runtime-level catch',
      phase: 5,
    };
  }
  // `new Date(...)` in each of its three forms: the zero-argument clock read, the one-argument time
  // value / ISO string / Date copy (slice A), and the component list read as LOCAL time (slice B).
  // Every one of them is accepted; the arity ceiling is the spec's own seven.
  if (isGlobalDate(node.expression, checker)) {
    const args = node.arguments ?? [];
    // The zero-argument form is ACCEPTED: it reads a clock, and nondeterminism is a proof problem
    // rather than an acceptance problem (plan §7's determinism carve-out). It proves through a
    // monotonicity unit test instead of a golden fixture.
    if (args.length === 0) {
      return { kind: 'accept' };
    }
    if (args.some((argument) => ts.isSpreadElement(argument))) {
      return dateNotYet('a spread argument to new Date', 5);
    }
    // Seven is the whole component list (§21.4.2.1); the checker's own overloads already reject
    // more, so this only guards against a lib that does not.
    if (args.length > 7) {
      return dateNotYet(`new Date with ${String(args.length)} arguments`, 5);
    }
    return { kind: 'accept' };
  }
  // `new Uint8Array(...)` / `new ArrayBuffer(n)` (plan.md T11.1). Every argument form the
  // checker accepts is one the runtime dispatches on by tag -- a length, a buffer with an offset
  // and a length, a typed array, an array, an iterable, an array-like -- so the arity ceiling is
  // the only test. `new ArrayBuffer(n, { maxByteLength })` is the resizable buffer, which has not
  // landed.
  const typedCtor = typedConstructorOf(node.expression, checker);
  if (typedCtor !== undefined) {
    const args = node.arguments ?? [];
    const op = typedCtor === 'uint8array' ? 'new Uint8Array' : 'new ArrayBuffer';
    if (args.some((argument) => ts.isSpreadElement(argument))) {
      return notYet(`a spread argument to ${op} is not yet supported`, 11);
    }
    return args.length <= TYPED_OPS[op].arity
      ? { kind: 'accept' }
      : notYet(`${op} with ${String(args.length)} arguments is not yet supported`, 11);
  }
  // `new TypeError('x')`. The descriptor lives in the runtime rather than being emitted from a
  // class declaration, so this never reaches the classDeclarationOf test below (plan.md §8 step
  // 2a(c)). At most one argument: `options` (the `cause` bag, ES2022) is a second slot this layout
  // does not have, and silently dropping it would lose data the program passed.
  if (errorCtorName(node.expression, checker) !== undefined) {
    const args = node.arguments ?? [];
    if (args.some((argument) => ts.isSpreadElement(argument))) {
      return notYet('a spread argument to an Error constructor is not yet supported', 5);
    }
    return args.length <= 1
      ? { kind: 'accept' }
      : notYet('the Error constructor options argument is not yet supported', 5);
  }
  // `new RegExp(p, f)` and `new Array(n)` answer what the call without `new` answers (§22.2.4.1,
  // §23.1.1.1), so they are the same node. `new String(x)` and its siblings are wrapper OBJECTS,
  // not the conversions, and keep their refusal below.
  const global = globalFunctionOf(node.expression, checker);
  if (global === 'RegExp' || global === 'Array') {
    return gateGlobalArguments(global, node, checker);
  }
  // `new F(...)` on an ordinary function, or on a value of unknown type -- tsc's
  // `new (NodeConstructor || (NodeConstructor = getNodeConstructor()))(kind)` -- constructs
  // through the value at run time (`jsrt_construct`, plan-notes 310). In `ts` mode the checker
  // refuses `new` on a function (TS7009), and an untyped callee is `any`.
  if (mode === 'js' && frontendTypes.isFunctionValueCallee(node.expression, checker)) {
    return node.arguments?.some((argument) => ts.isSpreadElement(argument)) === true
      ? notYet('a spread argument to a constructor is not yet supported', 5)
      : { kind: 'accept' };
  }
  if (node.typeArguments !== undefined) {
    // Explicit type arguments on a generic class are the tuple spelled out: the checker applies
    // them in the resolved construct signature, which is what the instantiation unifies from —
    // the same erasure calls already enjoy. Anything else keeps the refusal.
    if (genericNewInstantiation(node, checker).kind !== 'generic') {
      return notYet('explicit type arguments on a constructor call are not yet supported', 5);
    }
  }
  if (!ts.isIdentifier(node.expression)) {
    return notYet('new on anything but a named class is not yet supported', 5);
  }
  if (classDeclarationOf(checker.getTypeAtLocation(node)) === undefined) {
    // A bound class expression — or an anonymous default export, whose identity is Node's
    // `.name` — constructs its descriptor like a named declaration does (plan.md §8 step
    // 12(d)); anything without an identity has no descriptor to construct.
    const like = frontendTypes.classLikeOf(checker.getTypeAtLocation(node));
    if (like === undefined || classDisplayName(like) === undefined) {
      return notYet('new on this type is not yet supported', 5);
    }
  }
  // A spread needs a dynamic argv no constructor call builds (plan.md §8 step 37) — the same
  // missing feature as a spread function call, refused rather than STA4031'd in the lowering.
  if (node.arguments?.some((argument) => ts.isSpreadElement(argument)) === true) {
    return notYet('a spread argument to a constructor is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/** `this`, admitted inside a class member, an object literal method/accessor, or a plain
 * function — the places the lowering has a receiver to bind it to, by making the receiver
 * parameter zero. A method's receiver is its layout (or Unknown for a dynamic object); a plain
 * function's is Unknown/dynamic, and the call site passes its receiver or nothing (docs/VALUE.md
 * §4.16 `has_receiver`; a bare call answers `undefined`, which is the honest answer because
 * emitted modules are always strict ESM, never sloppy-global). In ts mode the checker still
 * refuses an unannotated `this` (STA0012) before lowering runs, so accepting here changes
 * nothing there — the construct is supported, the typing is not.
 * At the top level of a module `this` is `undefined` but there is no function to own it, and in
 * a static member it is the class object, which does not exist here — both stay refused. */
/** These class members establish the receiver used by both `this` and `super` reads. */
function isReceiverMember(node: ts.Node): node is ts.ClassElement {
  return (
    ts.isConstructorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  );
}

function gateThis(node: ts.Node, checker: ts.TypeChecker): GateResult {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    // A field INITIALIZER is a `this` position too, though it is lexically inside no function:
    // the lowering moves it into the constructor, where the receiver is a parameter. A STATIC
    // member's `this` is the class object, which this subset does not build — so a `this.x`
    // in a static FIELD initializer or BLOCK (where `this` is always the class being defined)
    // erases to that class's static binding and is accepted; in a static METHOD `this` depends
    // on how the method was reached (a subclass may have overridden the static), so that stays
    // refused. Bare `this` in any static stays refused.
    if (isReceiverMember(n)) {
      if (!frontendTypes.isStaticMember(n)) {
        return { kind: 'accept' };
      }
      // A static FIELD initializer runs with `this` bound to the class being defined, so
      // erasure is exact. A static METHOD's `this` is whoever the method was reached through.
      const defining = ts.isPropertyDeclaration(n);
      return defining && isStaticThisMemberUse(node, checker)
        ? { kind: 'accept' }
        : notYet('this in a static class member is not yet supported', 5);
    }
    if (ts.isClassStaticBlockDeclaration(n)) {
      return isStaticThisMemberUse(node, checker)
        ? { kind: 'accept' }
        : notYet('this in a static initialization block is not yet supported', 5);
    }
    // An arrow does NOT stop the walk: it has no `this` of its own and sees the enclosing one,
    // which is the whole reason arrows are used inside methods. A plain `function` DOES stop it,
    // but it stops it as an owner, not as a refusal: its `this` is the caller's (dynamic), which
    // the lowering binds as parameter zero, so the walk accepts here rather than breaking out.
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) {
      return { kind: 'accept' };
    }
  }
  return notYet('this outside a method or function is not yet supported', 5);
}

/** Whether `this` is the receiver of a member access that names a static of the enclosing
 * class — the narrow `static x = this.y` / `this.m()` path (plan.md §8 step 12(d)). Bare `this`
 * in a static, or a member that is not a static, stays the class-object refusal. */
function isStaticThisMemberUse(node: ts.Node, checker: ts.TypeChecker): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    frontendTypes.staticMemberOf(parent, checker, undefined) !== undefined
  );
}

/** The constraint of a type-parameter-typed value, if it is declared with one.
 *
 * `T` itself declares no members and has no layout: every member question a gate asks of a
 * `T`-typed receiver is answered by what `T` is bounded by instead. The checker already proved
 * the access against that bound — anything it did not prove is a checker error (`STA0012`)
 * before any gate below runs — so the gate only re-asks far enough to route to the right rule.
 * The declaration test mirrors `declaredTypeParameterName` in `types.ts`: a polymorphic `this`
 * carries the same flag with a class for a symbol, and it is not a parameter. */
function typeParameterConstraint(receiver: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  const declarations = receiver.getSymbol()?.declarations ?? [];
  if (
    (receiver.flags & ts.TypeFlags.TypeParameter) === 0 ||
    declarations.length === 0 ||
    !declarations.every(ts.isTypeParameterDeclaration)
  ) {
    return undefined;
  }
  const [declaration] = declarations;
  return declaration?.constraint === undefined
    ? undefined
    : checker.getTypeFromTypeNode(declaration.constraint);
}

/** Whether a `T`-typed receiver's constraint belongs to a builtin family, for the call and
 * member dispatches that read the checker's static `T` and match none of their families.
 *
 * The gate admitted the operation against the constraint, and the lowering substitutes the
 * call's concrete type per specialization — so vetting the call against the family's own table
 * (arity, op set, callback shape) is exactly as sound as vetting it on the concrete receiver.
 * `undefined` for anything but a constrained type parameter: the common path pays one flag test
 * and no mapping. */
function constraintMatches(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  family: 'string' | 'array' | 'date' | 'regexp',
): boolean {
  const constraint = typeParameterConstraint(checker.getTypeAtLocation(expression), checker);
  if (constraint === undefined) {
    return false;
  }
  switch (family) {
    case 'string':
      return (constraint.flags & ts.TypeFlags.StringLike) !== 0;
    case 'array':
      return checker.isArrayType(constraint);
    case 'date':
      return frontendTypes.tsTypeToHType(constraint, checker).kind === 'date';
    case 'regexp':
      return frontendTypes.tsTypeToHType(constraint, checker).kind === 'regexp';
  }
}

/** The collection a `T`-typed receiver's constraint is, if it is one — the `Map`/`Set` member
 * and call rules keyed off the constraint instead of the static `T`. */
function constraintCollection(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): 'map' | 'set' | undefined {
  const constraint = typeParameterConstraint(checker.getTypeAtLocation(expression), checker);
  if (constraint === undefined) {
    return undefined;
  }
  const kind = frontendTypes.tsTypeToHType(constraint, checker).kind;
  return kind === 'map' || kind === 'set' ? kind : undefined;
}

/** Names of type parameters in scope at `node`: every enclosing generic function, arrow,
 * method, or class contributes its own. A parameter type mentioning only these can still be
 * determined per specialization, when the enclosing tuple binds them. */
function enclosingTypeParameterNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    const parameters =
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isClassDeclaration(current)
        ? current.typeParameters
        : undefined;
    for (const parameter of parameters ?? []) {
      names.add(parameter.name.text);
    }
  }
  return names;
}

/** Whether an HType mentions a type parameter nothing in scope will bind: one the enclosing
 * declarations never declared. Such a parameter type cannot determine a tuple — no call site
 * supplies it — so a generic passed at it has nowhere to specialize to. Terminates because
 * every HType the mapper builds is finite (cyclic layouts are cut at its depth cap). */
function mentionsUnboundParameter(type: HType, bound: ReadonlySet<string>): boolean {
  switch (type.kind) {
    case 'type-param':
      return !bound.has(type.name);
    case 'array':
    case 'set':
    case 'iterator':
      return mentionsUnboundParameter(type.element, bound);
    case 'map':
      return (
        mentionsUnboundParameter(type.key, bound) || mentionsUnboundParameter(type.value, bound)
      );
    case 'fn':
      return (
        type.params.some((parameter) => mentionsUnboundParameter(parameter, bound)) ||
        mentionsUnboundParameter(type.ret, bound)
      );
    case 'object':
      return (
        type.fields.some((field) => mentionsUnboundParameter(field.type, bound)) ||
        type.methods.some((method) => mentionsUnboundParameter(method.type, bound))
      );
    default:
      return false;
  }
}

/** The class a type-parameter-typed value is bounded by, if it is bounded by a class.
 *
 * Lets a `T`-typed receiver gate exactly as its constraint does: `c.m()` with `c: T extends C`
 * takes the class branch, because per specialization it IS a call on a `C`. Anything else —
 * an array, a shape, a string — is answered by the constraint's HType or members below.
 *
 * Exported: the lowering resolves generic owners through the same declaration, so the two
 * cannot disagree about which class a bound means. */
export function constraintDeclaration(
  receiver: ts.Type,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | undefined {
  const constraint = typeParameterConstraint(receiver, checker);
  if (constraint === undefined) {
    return undefined;
  }
  const declaration = classDeclarationOf(constraint);
  // A generic class bounds nothing its specializations share: `Box<number>` and `Box<string>`
  // are different layouts, so a `T` bounded by one has no single class branch to take. Those
  // receivers stay on the member rule below — fields, whose slots align across specializations.
  if (declaration?.typeParameters !== undefined && declaration.typeParameters.length > 0) {
    return undefined;
  }
  return declaration;
}

/** Whether a static block mentions `super` outside a nested class body.
 *
 * `super` in a block would read the class object through a base with no receiver to run it
 * against (`lowerSuperCall` needs the receiver binding only constructors and methods have). A
 * nested class body is skipped: `super` there belongs to the inner class, which the gate vets
 * on its own. (`this` needs no walk: the `this` rule refuses it node by node.)
 * `super.x` naming a static of the base is the one admitted shape (plan.md §8 step 12(d)):
 * it erases to the base's static binding, which needs no receiver. */
function staticBlockUsesSuper(
  block: ts.ClassStaticBlockDeclaration,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return;
    }
    if (node.kind === ts.SyntaxKind.SuperKeyword) {
      const parent = node.parent;
      const resolved =
        parent !== undefined &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        frontendTypes.staticMemberOf(parent, checker, undefined) !== undefined;
      if (!resolved) {
        found = true;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(block.body);
  return found;
}

/** Whether a value-position `super.m` sits where the lowering can read the receiver.
 *
 * Mirrors `gateThis`'s walk, minus its plain-function arm: an arrow is transparent (it shares
 * the enclosing method's home object), but a plain `function` boundary ends the chain -- and
 * the checker's own error gets there first anyway, so refusing here is only the safe default,
 * never a new diagnostic. A field initializer counts: the lowering moves it into the
 * constructor, where the receiver is a parameter. */
function superValueHasReceiver(access: ts.PropertyAccessExpression): boolean {
  for (let n: ts.Node | undefined = access.parent; n !== undefined; n = n.parent) {
    if (isReceiverMember(n)) {
      return !frontendTypes.isStaticMember(n);
    }
    if (ts.isClassStaticBlockDeclaration(n)) {
      return false;
    }
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n)
    ) {
      return false;
    }
  }
  return false;
}

/** `o.x` and `o.m` on a class instance. A name the class does not declare cannot reach here — the
 * checker rejects it first — so the only question is whether the class itself is one this subset
 * lays out. */
function gateMemberAccess(
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  // `Symbol.iterator` as a computed class-method name is the well-known iterator, not a stored
  // symbol value. Any other property of `Symbol` (and `Symbol.iterator` as a value) is STA1212 —
  // except `u[Symbol.iterator]` as an element key, which the element gate owns: a known
  // user-iterable base dispatches statically there, and an unknown one earns the precise
  // GetIterator refusal there, so the key itself is never the refusal in either case.
  if (ts.isIdentifier(access.expression) && access.expression.text === 'Symbol') {
    if (
      ts.isElementAccessExpression(access.parent) &&
      access.parent.argumentExpression === access &&
      frontendTypes.isSymbolIteratorKey(access, checker) &&
      acceptsSymbolKeyBase(access.parent.expression, checker)
    ) {
      return { kind: 'accept' };
    }
    return ts.isComputedPropertyName(access.parent) &&
      frontendTypes.isGlobalSymbolIteratorName(access.parent, checker)
      ? { kind: 'accept' }
      : symbolNotYet();
  }
  // `super.m` is a call on this same receiver that skips the override -- or, since plan.md
  // §8 step 42, the base's method as an UNBOUND closure: `const f = super.m; f()` drops the
  // receiver per `has_receiver` (docs/VALUE.md §4.16), exactly as `const g = o.m; g()` does.
  // Either way the owner is the class declaring the method and the dispatch is direct.
  // `super.x` on a FIELD stays refused -- a field has one slot per name, so `super.x` and
  // `this.x` are the same slot and the spelling would promise a distinction the layout cannot
  // make. Bare `super` never reaches here (the SuperKeyword case owns it) and stays refused
  // there.
  if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
    // In a STATIC context `super.x` names a static of the base class — the one binding `Base.x`
    // reads (plan.md §8 step 12(d)). The class object does not exist here, so the access erases
    // to that binding exactly as `this.x` does in a static of the same class.
    if (frontendTypes.staticMemberOf(access, checker, undefined) !== undefined) {
      return { kind: 'accept' };
    }
    // Declarations and bound-expression bases alike (plan.md §8 step 12(d)): `super.m` in a
    // subclass of `const C = class …` skips to the expression's method the same way.
    const base = frontendTypes.classLikeOf(checker.getTypeAtLocation(access.expression));
    const method =
      base !== undefined && ts.isIdentifier(access.name)
        ? frontendTypes.methodDeclaringClass(base, access.name.text, checker)
        : undefined;
    if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
      return method !== undefined
        ? { kind: 'accept' }
        : notYet('super on anything but an inherited method is not yet supported', 5);
    }
    // Value position needs what the call gets for free: an instance receiver in scope for the
    // lowering to read. In a static member (or block) `super.m` is the base CLASS's member
    // with no receiver to run it against, so it stays refused there.
    if (method !== undefined && superValueHasReceiver(access)) {
      return { kind: 'accept' };
    }
    return notYet('super as a value is not yet supported', 5);
  }
  // `Math.floor` and `Math.PI` -- decided before anything that looks for a class, because Math
  // resolves to no declaration this compiler models. A constant is a plain read the lowering
  // folds to a literal; a method exists only as a callee (there is no function VALUE to bind);
  // anything else on Math is a real member of the real global that has not landed.
  if (isGlobalMath(access.expression, checker)) {
    const member = access.name.text;
    if (MATH_CONSTANTS.has(member)) {
      return { kind: 'accept' };
    }
    if (MATH_METHODS.has(member)) {
      return calleeOnlyMember(access, 'a Math method');
    }
    return notYet(`Math.${member} is not yet supported`, 5);
  }

  // Object namespace members follow Math's rules: a method exists only as a callee, and a member
  // outside the landed set is deferred by name.
  if (isGlobalObject(access.expression, checker)) {
    const member = access.name.text;
    if (Object.hasOwn(OBJECT_STATICS, member)) {
      return calleeOnlyMember(access, 'an Object method');
    }
    return notYet(`Object.${member} is not yet supported`, OBJECT_STATIC_OWNER[member] ?? 5);
  }

  // The Date namespace, by Math's rules. `now` is named separately from an unlanded member
  // because its blocker is a proof method, not an implementation (Task 4.2's carve-out).
  if (isGlobalDate(access.expression, checker)) {
    const member = access.name.text;
    if (Object.hasOwn(DATE_STATICS, member)) {
      return calleeOnlyMember(access, 'a Date method');
    }
    return dateNotYet(`Date.${member}`, 5);
  }

  // A Number.prototype method follows the same rule (plan-notes 310). A number has no data
  // properties, so any other member is a method of the real prototype that has not landed.
  if (
    frontendTypes.tsTypeToHType(checker.getTypeAtLocation(access.expression), checker).kind ===
    'number'
  ) {
    const member = access.name.text;
    if (Object.hasOwn(NUMBER_OPS, member)) {
      return calleeOnlyMember(access, 'a Number method');
    }
    return notYet(`Number.prototype.${member} is not yet supported`, 5);
  }

  // A Date.prototype method exists only as a callee, the rule every builtin receiver follows.
  // `Date` has no data properties at all -- its time value is internal -- so a non-method member
  // read here is a member of the real prototype that has not landed.
  if (isDateReceiver(access.expression, checker)) {
    const member = access.name.text;
    if (Object.hasOwn(DATE_OPS, member)) {
      return calleeOnlyMember(access, 'a Date method');
    }
    return dateNotYet(`Date.prototype.${member}`);
  }

  // The Promise namespace, same rules again. `.then`/`.catch`/`.finally` are NOT here: they are
  // members of a promise VALUE, not of the namespace, and are refused where a method call on a
  // promise receiver is decided.
  if (isGlobalPromise(access.expression, checker)) {
    const member = access.name.text;
    if (Object.hasOwn(PROMISE_STATICS, member)) {
      return calleeOnlyMember(access, 'a Promise method');
    }
    return notYet(`Promise.${member} is not yet supported`, 5);
  }

  if (
    frontendTypes.tsTypeToHType(checker.getTypeAtLocation(access.expression), checker).kind ===
    'promise'
  ) {
    const member = access.name.text;
    if (member === 'then' || member === 'catch' || member === 'finally') {
      return calleeOnlyMember(access, `Promise.prototype.${member}`);
    }
    return {
      kind: 'not-yet',
      code: 'STA1216',
      message:
        `Promise.prototype.${member} is not yet supported: use an async function, ` +
        'whose await and return do the same work',
      phase: 5,
    };
  }

  // JSON follows the same rules: stringify and parse exist only as callees; the rest are
  // deferred by name.
  if (isGlobalJson(access.expression, checker)) {
    const member = access.name.text;
    if (member === 'stringify' || member === 'parse') {
      return calleeOnlyMember(access, `JSON.${member}`);
    }
    return notYet(`JSON.${member} is not yet supported`, 5);
  }

  // The `String` namespace follows the same rules: `fromCharCode` exists only as a callee
  // (there is no function value to bind), and any other member is deferred by name rather
  // than by the catch-all below.
  if (isGlobalString(access.expression, checker)) {
    const member = access.name.text;
    if (Object.hasOwn(STRING_STATICS, member)) {
      return calleeOnlyMember(access, `String.${member}`);
    }
    return notYet(`String.${member} is not yet supported`, 5);
  }

  // `Array` and `Number` follow them too: `Array.isArray`, `Number.parseInt` and
  // `Number.parseFloat` exist only as callees (plan.md §11c T11.4).
  if (numberConstant(access, checker) !== undefined) {
    return { kind: 'accept' }; // the lowering folds it to a literal
  }
  for (const [base, members] of Object.entries(CALLEE_ONLY_STATICS)) {
    if (isGlobalNamed(access.expression, checker, base)) {
      const member = access.name.text;
      if (members.includes(member)) {
        return calleeOnlyMember(access, `${base}.${member}`);
      }
      return notYet(`${base}.${member} is not yet supported`, 5);
    }
  }

  // A String.prototype method exists only as a callee -- there is no function value to bind, the
  // same rule a collection method follows. `.length` is handled by its own node and never gets
  // here; any other string member is a real property of the real String.prototype that has not
  // landed.
  if (
    isStringReceiver(access.expression, checker) &&
    access.name.text !== 'length' &&
    !ts.isCallExpression(access.parent)
  ) {
    return Object.hasOwn(STRING_OPS, access.name.text)
      ? notYet('using a string method as a value is not yet supported', 5)
      : notYet(`String.prototype.${access.name.text} is not yet supported`, 5);
  }
  if (
    isStringReceiver(access.expression, checker) &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  ) {
    return { kind: 'accept' }; // gateCall vets the operation itself
  }

  // Array.prototype members follow the same two rules as String's: a method exists only as a
  // callee, and a member outside the landed set is deferred by name. `.length` has its own node
  // and never gets here.
  if (
    isArrayReceiver(access.expression, checker) &&
    access.name.text !== 'length' &&
    !(ts.isCallExpression(access.parent) && access.parent.expression === access)
  ) {
    return Object.hasOwn(ARRAY_OPS, access.name.text)
      ? notYet('using an array method as a value is not yet supported', 5)
      : notYet(`Array.prototype.${access.name.text} is not yet supported`, 5);
  }
  if (
    isArrayReceiver(access.expression, checker) &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  ) {
    return { kind: 'accept' }; // gateCall vets the operation itself
  }

  // `Uint8Array.from`, `ArrayBuffer.isView` and the rest of the two namespaces: none has landed
  // (plan.md T11.1 lands the instances; the statics follow the corpus).
  const typedNamespace = typedConstructorOf(access.expression, checker);
  if (typedNamespace !== undefined) {
    return notYet(`${typedClassName(typedNamespace)}.${access.name.text} is not yet supported`, 11);
  }
  // A Uint8Array / ArrayBuffer member: the TYPED_OPS rows, a method only as a callee and a data
  // property only as a read (the assignment gate refuses a write into a builtin, as it does for
  // `re.lastIndex`). Everything else on the prototype is the rest of the family's surface.
  const typedReceiver = typedReceiverKind(access.expression, checker);
  if (typedReceiver !== undefined) {
    const member = access.name.text;
    const qualified = `${typedClassName(typedReceiver)}.prototype.${member}`;
    const op = typedMember(typedReceiver, member);
    if (op === undefined) {
      return notYet(`${qualified} is not yet supported`, 11);
    }
    const isCallee = ts.isCallExpression(access.parent) && access.parent.expression === access;
    return TYPED_OPS[op].form !== 'call' || isCallee
      ? { kind: 'accept' }
      : notYet(`using ${qualified} as a value is not yet supported`, 11);
  }

  // RegExp.prototype follows String's and Array's rule for its METHODS: one is a CALLEE and
  // nothing else. Its DATA properties are the other half of the surface -- `REGEXP_FIELDS` is the
  // closed set of them -- and they are reads, so they are admitted here and nowhere else.
  if (isRegExpReceiver(access.expression, checker)) {
    if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
      return { kind: 'accept' }; // gateCall vets the operation itself
    }
    // A READ. `re.lastIndex = 0` is a write into a builtin -- not a read spelled backwards -- and
    // is refused by the assignment gate above, which admits a field of a CLASS and nothing else
    // (plan-notes 121).
    if (Object.hasOwn(REGEXP_FIELDS, access.name.text)) {
      return { kind: 'accept' };
    }
    // The data properties are closed, so what reaches here is the rest of the prototype object --
    // Phase 8's surface, the same as `compile` above. `unicodeSets` is the one name a user might
    // reasonably write, and it never gets this far: it is declared in lib.es2024 and this project
    // pins `lib: ["es2023"]`, so the checker refuses the read first (plan-notes 136).
    return {
      kind: 'not-yet',
      code: 'STA1211',
      message: `RegExp.prototype.${access.name.text} is not yet supported; planned for Phase 8`,
      phase: 8,
    };
  }

  // `C.count` -- the receiver is a class NAME, so this reads a static, not an instance field.
  // `classDeclarationOf` cannot tell the two apart: the type of the expression `C` is the class's
  // STATIC side, whose symbol is still the class declaration, so a value read and a static read
  // would both answer with the same declaration. Asking whether the receiver resolves to a class
  // declaration is what separates them.
  const asStatic = frontendTypes.staticMemberOf(access, checker, undefined);
  if (asStatic !== undefined) {
    return { kind: 'accept' };
  }
  // `v.count` where the receiver is a class OBJECT (docs/VALUE.md §4.17): it would dispatch
  // at run time through the class object's table, but the lowering has no value-receiver arm
  // yet -- so every member read through a constructor-typed receiver stays refused here, with
  // the prototype surface keeping its Phase-8 code.
  if (classConstructorTypeOf(checker.getTypeAtLocation(access.expression))) {
    return access.name.text === 'prototype'
      ? notYet('the prototype surface is not yet supported', 8)
      : notYet('a member read through a class object is not yet supported', 5);
  }
  // `m.size`, and the method names that are only ever callees. `size` is a READ of a count the
  // structure keeps, so it is accepted as a value; a method is not, for the reason a class method is
  // not -- `const f = m.get` needs a bound closure nothing here builds.
  const iterator = frontendTypes.tsTypeToHType(
    checker.getTypeAtLocation(access.expression),
    checker,
  );
  if (iterator.kind === 'iterator') {
    // As a call's callee the gateCall arm decides (it is where generator-vs-specialized is
    // answered); everything else is a VALUE position (`const f = it.next`), which is the
    // bound-closure work of step 12(e).
    // TODO: not supported — iterator methods as values (needs a bound-closure representation,
    // plan.md §8 step 12(e)).
    return ts.isCallExpression(access.parent) &&
      access.parent.expression === access &&
      (access.name.text === 'next' || access.name.text === 'return' || access.name.text === 'throw')
      ? { kind: 'accept' }
      : notYet(`Iterator.${access.name.text} as a value is not yet supported`, 5);
  }
  const collection =
    collectionOf(access.expression, checker) ?? constraintCollection(access.expression, checker);
  if (collection !== undefined) {
    if (access.name.text === 'size') {
      return { kind: 'accept' };
    }
    return ts.isCallExpression(access.parent) && access.parent.expression === access
      ? { kind: 'accept' } // gateCall decides it; reaching here means it already did
      : notYet(
          `${collectionName(collection)}.${access.name.text} as a value is not yet supported`,
          5,
        );
  }
  const declaration =
    frontendTypes.classLikeOf(checker.getTypeAtLocation(access.expression)) ??
    constraintDeclaration(checker.getTypeAtLocation(access.expression), checker);
  if (declaration === undefined) {
    // A member read through `T`: the constraint is what declares it, the checker already proved
    // it there, and the lowering substitutes the call's concrete type per specialization — so the
    // only gate question left is which value rule applies. A method exists only as a callee (the
    // bound-closure rule every other receiver follows); a field, an accessor, or a closure-valued
    // slot reads as a value. Anything the constraint does not declare falls through to the
    // refusal below, which valid code never reaches — the checker rejects it first.
    const constraint = typeParameterConstraint(
      checker.getTypeAtLocation(access.expression),
      checker,
    );
    const member =
      constraint === undefined
        ? undefined
        : checker.getPropertyOfType(constraint, access.name.text);
    if (member !== undefined) {
      const isMethod =
        member.declarations?.some((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) ===
        true;
      // A method through a generic class bound has no single implementation to name: the owner
      // depends on type arguments no use site of `T` determines, and the class branch above
      // declined generic bounds for the same reason. Fields and accessors do not need an
      // owner — slots align across specializations — so only the method case is refused here.
      const bound = constraint === undefined ? undefined : classDeclarationOf(constraint);
      if (isMethod && bound?.typeParameters !== undefined && bound.typeParameters.length > 0) {
        return notYet(
          'a method call on an instance of a generic class with undetermined type arguments is not yet supported',
          5,
        );
      }
      if (
        !isMethod ||
        (ts.isCallExpression(access.parent) && access.parent.expression === access)
      ) {
        return { kind: 'accept' };
      }
    }
    // `p.x` on an object literal's shape. A shape has fields and nothing else -- no methods, no
    // accessors, no statics -- so the whole rule is that the name is one of them.
    // A match array's HIR type is Unknown, so this has to win before the Unknown arm or
    // `m.slice` would look like a dynamic method call (plan.md §8 step 4) instead of the
    // union-work not-yet the match row records.
    if (isMatchReceiver(access.expression, checker)) {
      return Object.hasOwn(MATCH_FIELDS, access.name.text)
        ? { kind: 'accept' }
        : notYet(`${access.name.text} on a RegExp match is not yet supported`, 5);
    }
    const shape = frontendTypes.tsTypeToHType(
      checker.getTypeAtLocation(access.expression),
      checker,
    );
    if (readsAsUnknown(access.expression, shape, checker, mode)) {
      return { kind: 'accept' };
    }
    // Dynamic shapes (optional fields, index signatures, empty `{}`) must be asked BEFORE the
    // fixed-layout arm. The shape table answers an absent name `undefined`. A CALL through the
    // table needs a bound method object nothing here builds yet — except an Unknown receiver,
    // which is a get-then-call and is accepted above.
    const receiver = checker.getTypeAtLocation(access.expression);
    if (frontendTypes.isDynamicShape(receiver, checker)) {
      if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
        return notYet('calling a method through a dynamic shape is not yet supported', 5);
      }
      return { kind: 'accept' };
    }
    if (shape.kind === 'object') {
      if (shape.fields.some((f) => f.name === access.name.text)) {
        return { kind: 'accept' };
      }
      if (shape.methods.some((m) => m.name === access.name.text)) {
        return calleeOnlyMember(access, 'a method');
      }
      // A name the layout never declared: `js` mode reads it from the overflow table, which
      // answers `undefined` until a write grows it (docs/VALUE.md §4.24). Calling it is a
      // get-then-call on the Unknown that read answers.
      if (mode === 'js' && frontendTypes.isUndeclaredMemberRead(access, checker)) {
        return { kind: 'accept' };
      }
      return notYet('a property that is not a field of the shape is not yet supported', 5);
    }
    if (frontendTypes.isFunctionValueMember(access.expression, access.name.text, checker)) {
      return functionMemberResult(mode);
    }
    return notYet('property access is not yet supported', 5);
  }
  // A class name reaching here with no static of that name is a member the subset cannot resolve
  // -- `C.prototype`, `C.name` and the rest of the class object, which does not exist here.
  if (
    ts.isIdentifier(access.expression) &&
    checker.getSymbolAtLocation(access.expression)?.valueDeclaration === declaration
  ) {
    return notYet('using a class as a value is not yet supported', 5);
  }
  // `o.x` on an accessor is a CALL, so a read is fine, and so is a read-modify-write in
  // either position: the member place machinery evaluates the receiver once and threads it
  // through the get and the set. Statement position folds into a write statement; value
  // position (`y = o.x++`) is an `accessor-place` update that answers the fold's value.
  if (accessorDeclaringClass(declaration, access.name.text, checker) !== undefined) {
    return { kind: 'accept' };
  }
  // A method used as a VALUE (`const f = o.m`) would have to build a bound closure, which is a
  // per-instance allocation this rung does not make. As the callee of a call it is fine, and that
  // is the shape gateCall sees. The search runs up the chain: an inherited method is a method.
  // A DYNAMIC key on a class with an index signature has nowhere to go: the layout holds the
  // declared members only, and growing it at run time is dictionary mode. The checker proved the
  // key against the signature, so this is scheduled, not wrong.
  if (
    ts.isIdentifier(access.name) &&
    classHasIndexSignature(declaration, checker) &&
    checker.getPropertyOfType(checker.getTypeAtLocation(access.expression), access.name.text) ===
      undefined
  ) {
    return notYet('a dynamic key on a class with an index signature is not yet supported', 8);
  }
  return { kind: 'accept' };
}

/** `a[i]`, admitted only when `a` is an array. Indexing a string (`s[0]`) or an object is the same
 * syntax reaching a different runtime operation, and neither has an HIR node yet. */
function gateElementAccess(
  access: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  mode: Mode,
): GateResult {
  const chained = optionalChainElementReceiver(access, checker);
  if (chained !== undefined) {
    return chained;
  }
  if (
    !checker.isArrayType(checker.getTypeAtLocation(access.expression)) &&
    !isMatchReceiver(access.expression, checker)
  ) {
    // A match array indexes like any array at run time -- it IS a dense jsrt array, carrying a
    // property table beside its elements -- so `m[0]` is admitted even though its HIR type is the
    // Unknown a match-or-null has to be. The verifier already accepts an Unknown index target.
    // Untyped receivers (plan.md §8 step 4) take the same path.
    const receiver = checker.getTypeAtLocation(access.expression);
    const hir = frontendTypes.tsTypeToHType(receiver, checker);
    // `u[i]` on a Uint8Array (plan.md T11.1): an element read or a ToUint8 write. A string key
    // (`u['0']`, `u['length']`) is a property NAME on the dynamic path, which the static index
    // node does not model, so only a numeric key is the element access.
    if (hir.kind === 'uint8array') {
      const key = checker.getTypeAtLocation(access.argumentExpression);
      return (key.flags & ts.TypeFlags.NumberLike) !== 0
        ? { kind: 'accept' }
        : notYet('a non-numeric key on a Uint8Array is not yet supported', 11);
    }
    // An index into `T`: the bound is what is indexed (almost always an array), and the lowering
    // substitutes the call's concrete element type per specialization, under which this is the
    // same node as an index into the bound itself.
    const constraint = typeParameterConstraint(receiver, checker);
    if (constraint !== undefined && checker.isArrayType(constraint)) {
      return { kind: 'accept' };
    }
    // `[Symbol.iterator]` as an element key: static dispatch for a known user-iterable class
    // (the read is the method's value, the call its invocation — both name `__@iterator` in the
    // lowering), and a precise GetIterator refusal for an unknown receiver (the value may be any
    // iterable, and resolving the well-known symbol needs runtime dispatch no layout has). A
    // known base without the method keeps the non-array refusal below.
    if (frontendTypes.isSymbolIteratorKey(access.argumentExpression, checker)) {
      if (frontendTypes.userIteratorMethod(hir) !== undefined) {
        return { kind: 'accept' };
      }
      if (hir.kind === 'unknown') {
        return notYet(
          `resolving '[Symbol.iterator]' on this receiver needs runtime GetIterator dispatch`,
          8,
        );
      }
    }
    // `o["a-b"]` on a fixed shape: the key is a literal, so the slot is known at compile time and
    // this is a field read spelled the only way TypeScript allows a non-identifier key to be
    // spelled. A literal-typed key (`o[k]` with `k: "m"`) is the same name by the step-22 rule,
    // so it answers the same way: a field reads, a method exists only as a callee (the
    // bound-closure rule the dot spelling follows), and an accessor read runs the getter --
    // while anything else, or a key naming no member, is still an index.
    const key = frontendTypes.elementStaticKey(access.argumentExpression, checker);
    if (hir.kind === 'object' && key !== null) {
      if (hir.fields.some((field) => field.name === key)) {
        return { kind: 'accept' };
      }
      if (hir.methods.some((m) => m.name === key)) {
        return calleeOnlyMember(access, 'a method');
      }
      // An accessor read is a call to the getter, so a read is fine; a read-modify-write
      // takes the same place machinery in either position (see gateMemberAccess).
      if (
        hir.methods.some((m) => m.name === accessorName('get', key)) ||
        hir.methods.some((m) => m.name === accessorName('set', key))
      ) {
        return { kind: 'accept' };
      }
      return notYet('index access on a non-array is not yet supported', 5);
    }
    // An object-typed key on a fixed shape coerces via ToPropertyKey (plan.md §8 step 44b): the
    // read-side twin of the suppressed-2464 write coercion. The verifier admits the shape (an
    // object target under an object-or-Unknown key) and the runtime degrades through the
    // coercing entry points, while every static-key spelling above keeps its slot. Custom
    // `toString` dispatch is the shared Phase-8 ceiling both sides name; ts mode keeps the
    // checker's own refusal (STA0012). The broad `object` annotation carries NonPrimitive, not
    // Object, so both flags admit — anything narrower the checker already refused or names.
    if (
      hir.kind === 'object' &&
      key === null &&
      (checker.getTypeAtLocation(access.argumentExpression).flags &
        (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !==
        0
    ) {
      return { kind: 'accept' };
    }
    // `table[node.kind]` in `js` mode: a computed key on a fixed shape reads and writes by NAME,
    // through the same coercing entry points -- a declared name answers its slot, any other the
    // overflow table, or `undefined` (docs/VALUE.md §4.24). A module namespace is no object.
    if (mode === 'js' && hir.kind === 'object' && hir.namespace !== true && key === null) {
      return { kind: 'accept' };
    }
    // A string's exotic index (ECMA-262 §10.4.3): `s[0]` answers the UTF-16 unit at that
    // position, `undefined` past the end. The runtime's `jsrt_get_prop` string arm is the
    // same entry an Unknown receiver takes (plan-notes 372 residue).
    return hir.kind === 'unknown' ||
      hir.kind === 'string' ||
      frontendTypes.isDynamicShape(receiver, checker)
      ? { kind: 'accept' }
      : notYet('index access on a non-array is not yet supported', 5);
  }
  return { kind: 'accept' };
}

/** `for (const x of a)`, admitted over an array, a string, a Map, a Set, a boxed iterator, or a
 * user class whose `[Symbol.iterator]()` returns an iterator.
 *
 * The four collections compile to specialized loops (docs/VALUE.md §4.13). A user iterable calls
 * the compile-time-known method and then drives the returned iterator with the existing walk. In
 * js mode anything else is admitted too -- an Unknown value, a union the model widens to one, or
 * a statically-known non-iterable the checker refused via the suppressed TS2488 -- and the
 * lowering wraps it in `get-iterator`, so the runtime's GetIterator dispatch answers what the
 * static walks cannot (plan.md §8 step 2a(c)). ts mode keeps the refusal: there an unresolvable
 * iterable is a type error, not a runtime question.
 * The binding must be a plain `let`/`const` name: `for (x of a)` assigns to an existing binding, and
 * destructuring needs a pattern the subset cannot lower. */
function gateForOf(statement: ts.ForOfStatement, mode: Mode, checker: ts.TypeChecker): GateResult {
  if (statement.awaitModifier !== undefined) {
    // `for await` drives the ASYNC iterator protocol, which is the generator machinery under
    // another name -- not the await that landed with async functions.
    return generatorNotYet();
  }
  const iterableType = checker.getTypeAtLocation(statement.expression);
  // Iteration over `T` iterates its bound: the lowering substitutes the call's concrete element
  // type per specialization, under which this is the same loop as over the bound itself.
  const constraint = typeParameterConstraint(iterableType, checker);
  const target = constraint ?? iterableType;
  const hir =
    constraint === undefined
      ? frontendTypes.tsTypeToHType(iterableType, checker)
      : frontendTypes.tsTypeToHType(constraint, checker);
  if (
    !checker.isArrayType(target) &&
    (target.flags & ts.TypeFlags.StringLike) === 0 &&
    hir.kind !== 'map' &&
    hir.kind !== 'set' &&
    hir.kind !== 'iterator' &&
    hir.kind !== 'uint8array' &&
    frontendTypes.userIteratorMethod(hir) === undefined
  ) {
    if (mode === 'js') {
      // Fall through to the binding checks: the operand takes the dynamic dispatch.
    } else if (
      target
        .getProperties()
        .some(
          (s) =>
            frontendTypes.hirPropertyName(ts.unescapeLeadingUnderscores(s.escapedName)) ===
            frontendTypes.ITERATOR_METHOD_NAME,
        )
    ) {
      // The checker ACCEPTED this (it has `[Symbol.iterator]`), so no STA0012 speaks for it and
      // the gate's refusal is the only diagnostic: a custom `{ next() }` object, or an interface
      // like `Iterable<T>` whose method the HType mapping drops (so the HType alone cannot tell
      // acceptance from refusal — the checker's own property list can). Every other shape
      // reaching here was refused by the checker first (TS2488/TS2571, unsuppressed in ts mode),
      // and returning accept there leaves that STA0012 speaking alone — which matters because
      // `explain` ranks a not-yet above an error-class diagnostic.
      return notYet('for-of over a user iterable is not yet supported', 5);
    }
  }
  const initializer = statement.initializer;
  if (!ts.isVariableDeclarationList(initializer)) {
    return notYet('for-of over an existing binding is not yet supported', 5);
  }
  const [declaration] = initializer.declarations;
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
    return notYet('destructuring in a for-of binding is not yet supported', 6);
  }
  return { kind: 'accept' };
}

/** The whole Math surface (§21.3.2), complete as of plan-notes 119. The approximated
 * transcendentals used to be absent because the host libm disagrees with Node in the last ulp;
 * they now come from the vendored fdlibm — the same code V8 runs — so the agreement is structural.
 * `random` is here too, under plan.md §7 Task 4.2's determinism carve-out: it is proved by
 * range/distribution assertions rather than by a golden test, because no golden test can pin it. */
export const MATH_METHODS: ReadonlySet<string> = new Set([
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'random',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
]);

/** Folded to number literals by the lowering — the compiler runs on the pinned Node, so these are
 * bit-for-bit the doubles the golden tests diff against. */
export const MATH_CONSTANTS: ReadonlySet<string> = new Set([
  'E',
  'LN10',
  'LN2',
  'LOG10E',
  'LOG2E',
  'PI',
  'SQRT1_2',
  'SQRT2',
]);

/** `Number`'s constants (§21.1.2), folded the same way: each is non-writable and
 * non-configurable, so no program can observe a different value (plan-notes 310). */
const NUMBER_CONSTANTS: ReadonlyMap<string, number> = new Map(
  (
    [
      'EPSILON',
      'MAX_SAFE_INTEGER',
      'MAX_VALUE',
      'MIN_SAFE_INTEGER',
      'MIN_VALUE',
      'NaN',
      'NEGATIVE_INFINITY',
      'POSITIVE_INFINITY',
    ] as const
  ).map((name) => [name, Number[name]]),
);

/** The value a `Number.MAX_VALUE` read folds to, or undefined for any other access. */
export function numberConstant(
  node: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): number | undefined {
  const value = NUMBER_CONSTANTS.get(node.name.text);
  return value !== undefined && isGlobalNamed(node.expression, checker, 'Number')
    ? value
    : undefined;
}

/** `Math` the GLOBAL, not a user binding that borrowed the name: every declaration behind the
 * symbol is ambient. A local `const Math = …` shadows the global at runtime and must win here
 * too, which is what the declaration-file test buys over matching the text alone. */
export function isGlobalMath(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'Math');
}

/** The `String` CONSTRUCTOR read as a namespace -- `String.fromCharCode`, and whatever lands
 * next to it. The same declaration-file test, which is what keeps a user `class String` on the
 * ordinary class path. */
export function isGlobalString(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'String');
}

/** The `Object` namespace, by the same test. */
export function isGlobalObject(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'Object');
}

/** The `Date` CONSTRUCTOR read as a namespace -- `Date.UTC`, `Date.parse`, `Date.now`. The same
 * declaration-file test, which is what keeps a user `class Date` on the ordinary class path. */
export function isGlobalDate(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'Date');
}

/** The checker says the receiver is a Date -- decided through the HType mapping, so the gate and
 * the lowering agree on what a date receiver is, exactly as they do for a regexp. */
export function isDateReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return (
    frontendTypes.tsTypeToHType(checker.getTypeAtLocation(expression), checker).kind === 'date'
  );
}

/** The typed-array class this expression names when it is the GLOBAL constructor (plan.md
 * T11.1), by the declaration-file test every other global uses. */
export function typedConstructorOf(
  node: ts.Expression,
  checker: ts.TypeChecker,
): 'uint8array' | 'arraybuffer' | undefined {
  if (isGlobalNamed(node, checker, 'Uint8Array')) {
    return 'uint8array';
  }
  return isGlobalNamed(node, checker, 'ArrayBuffer') ? 'arraybuffer' : undefined;
}

/** The checker says the receiver is a Uint8Array or an ArrayBuffer -- through the HType mapping,
 * so the gate and the lowering agree on it the way they do for a Date. */
export function typedReceiverKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): 'uint8array' | 'arraybuffer' | undefined {
  const kind = frontendTypes.tsTypeToHType(checker.getTypeAtLocation(expression), checker).kind;
  return kind === 'uint8array' || kind === 'arraybuffer' ? kind : undefined;
}

/** The standard error constructor this expression names, or undefined. The same declaration-file
 * test every other global uses, so a user `class TypeError` stays on the ordinary class path. */
export function errorCtorName(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ErrorClass | undefined {
  const hit = ERROR_CLASSES.find((name) => isGlobalNamed(node, checker, name));
  return hit;
}

function isGlobalNamed(node: ts.Expression, checker: ts.TypeChecker, name: string): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) {
    return false;
  }
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** The Object namespace calls that lower, and what each takes.
 *
 * `arity` is exact — none of these is variadic in the landed form. `receiver` says what the FIRST
 * argument must be: `shaped` is an object whose keys a walk can enumerate (a fixed shape, whose
 * class descriptor lists its fields, or a dynamic shape, whose chain does), `pairs` is an array,
 * which is the only `fromEntries` input the runtime iterates, and `dynamic` is the strictest --
 * a shape that looks keys up through its shape table, which is the only kind `assign` may WRITE
 * to, because a fixed shape's reads are slot indices decided at build time. `second` says the same
 * about the second argument, `none` meaning there is not one.
 *
 * Everything else on `Object` stays deferred, and each for a reason rather than a backlog:
 * `freeze`/`isFrozen` cannot be honest until the RUNTIME can throw -- a write to a frozen object
 * is a TypeError in strict mode, which every module here is, and `jsrt_throw` is reachable only
 * from generated code holding a landing pad (plan-notes 125); `create`, `defineProperty`,
 * `getPrototypeOf` and `setPrototypeOf` are prototype machinery, which ts mode bans by design and
 * js mode leaves to the object model. */
/** Whether an argument matches an `OBJECT_STATICS` receiver kind. `dynamic` is not a subset of
 * `shaped` by accident: a fixed shape enumerates fine but cannot be WRITTEN to, which is the whole
 * difference between reading a shape and growing one. */
function acceptsObjectArgument(
  want: 'dynamic' | 'pairs' | 'shaped',
  argument: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const type = checker.getTypeAtLocation(argument);
  if (want === 'pairs') {
    return frontendTypes.tsTypeToHType(type, checker).kind === 'array';
  }
  if (want === 'dynamic') {
    return frontendTypes.isDynamicShape(type, checker);
  }
  return (
    frontendTypes.tsTypeToHType(type, checker).kind === 'object' ||
    frontendTypes.isDynamicShape(type, checker)
  );
}

export const OBJECT_STATICS = {
  assign: { arity: 2, receiver: 'dynamic', second: 'shaped' },
  entries: { arity: 1, receiver: 'shaped', second: 'none' },
  freeze: { arity: 1, receiver: 'shaped', second: 'none' },
  fromEntries: { arity: 1, receiver: 'pairs', second: 'none' },
  getOwnPropertyNames: { arity: 1, receiver: 'shaped', second: 'none' },
  hasOwn: { arity: 2, receiver: 'shaped', second: 'key' },
  isFrozen: { arity: 1, receiver: 'shaped', second: 'none' },
  keys: { arity: 1, receiver: 'shaped', second: 'none' },
  values: { arity: 1, receiver: 'shaped', second: 'none' },
} as const satisfies Record<
  string,
  {
    readonly arity: number;
    readonly receiver: 'dynamic' | 'pairs' | 'shaped';
    readonly second: 'key' | 'none' | 'shaped';
  }
>;

/** Which phase owns each `Object` static that has NOT landed. One hardcoded number cannot be right
 * for this namespace: the six unlanded members wait on two different mechanisms in two different
 * phases (plan §7 Task 4.7 step 5, plan-notes 125 and 136).
 *
 * `freeze`/`isFrozen` landed in Phase 5 step 11. `seal`/`isSealed` still need a [[Sealed]] bit
 * distinct from frozen. The prototype/descriptor four are STA1204's surface, in Phase 8.
 * A name in neither list is one `lib.es5.d.ts` declares and nothing here models yet, and member
 * growth lands with the language surface, so Phase 5 is the honest default. */
const OBJECT_STATIC_OWNER: Readonly<Record<string, number>> = {
  create: 8,
  defineProperties: 8,
  defineProperty: 8,
  getOwnPropertyDescriptor: 8,
  getOwnPropertyDescriptors: 8,
  getPrototypeOf: 8,
  seal: 5,
  isSealed: 5,
  setPrototypeOf: 8,
};

/** The `Promise` namespace calls that lower as `promise-static`. `all` additionally requires an
 * ARRAY: the runtime walks one, and any other iterable is the Symbol.iterator protocol.
 * `.then`/`.catch`/`.finally` and `new Promise` are gated separately (Phase 5 step 11). */
export const PROMISE_STATICS = {
  all: { array: true },
  reject: { array: false },
  resolve: { array: false },
} as const satisfies Record<string, { readonly array: boolean }>;

/** An array literal written straight into `Promise.all([...])` types as a TUPLE, not an array --
 * the contextual parameter is an iterable, and the checker keeps the more precise answer. Both
 * are one contiguous run of elements at run time, which is the only property this asks about. */
function isArrayOrTuple(type: ts.Type, checker: ts.TypeChecker): boolean {
  return checker.isArrayType(type) || checker.isTupleType(type);
}

/** `Promise` the GLOBAL, by the same declaration-file test `Math` and `Object` use. */
export function isGlobalPromise(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'Promise');
}

/** The `ARRAY_OPS` entries whose FIRST argument is a callback: the gate holds that argument to a
 * function type, refuses the thisArg form of the single-callback methods, and requires
 * `reduce`/`reduceRight`'s explicit initial value. */
export const CALLBACK_ARRAY_OPS = {
  every: true,
  sort: true,
  reduce: true,
  reduceRight: true,
  filter: true,
  flatMap: true,
  find: true,
  findIndex: true,
  findLast: true,
  findLastIndex: true,
  toSorted: true,
  forEach: true,
  map: true,
  some: true,
} as const;

/** The `JSON` namespace, by the same test. */
export function isGlobalJson(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'JSON');
}

/** The `Array` constructor read as a namespace -- `Array.isArray`. The same declaration-file
 * test, so a user `class Array` stays on the ordinary class path. */
export function isGlobalArray(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return isGlobalNamed(node, checker, 'Array');
}

/** A builtin member that exists only as a callee -- there is no function value to bind -- is
 * accepted as one and refused by name anywhere else; `gateCall` vets the arguments. */
function calleeOnlyMember(access: ts.Expression, what: string): GateResult {
  return ts.isCallExpression(access.parent) && access.parent.expression === access
    ? { kind: 'accept' }
    : notYet(`using ${what} as a value is not yet supported`, 5);
}

/** The namespace members that exist only as callees, by namespace. `Array.from` is a global-call
 * row (step 5); `Number.parseInt` and `Number.parseFloat` are the global functions themselves
 * (§21.1.2.12-13). */
const CALLEE_ONLY_STATICS: Readonly<Record<string, readonly string[]>> = {
  Array: ['isArray', 'from'],
  Number: ['parseInt', 'parseFloat'],
};

/** The three conversion functions: each lowers to the operation it is (`String(x)` to a template
 * hole, `Number(x)` to unary `+`, `Boolean(x)` to `!!x`), so they have no `GLOBAL_CALLS` row. */
const GLOBAL_CONVERSIONS: ReadonlySet<string> = new Set(['String', 'Number', 'Boolean']);

export type GlobalFunction = GlobalCallName | 'String' | 'Number' | 'Boolean';

/** The global function this callee names, by the declaration-file test, or undefined. */
export function globalFunctionOf(
  node: ts.Expression,
  checker: ts.TypeChecker,
): GlobalFunction | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    (node.name.text === 'parseInt' || node.name.text === 'parseFloat')
  ) {
    return isGlobalNamed(node.expression, checker, 'Number') ? node.name.text : undefined;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'from') {
    return isGlobalArray(node.expression, checker) ? 'Array.from' : undefined;
  }
  if (!ts.isIdentifier(node)) {
    return undefined;
  }
  const name = node.text;
  if (!Object.hasOwn(GLOBAL_CALLS, name) && !GLOBAL_CONVERSIONS.has(name)) {
    return undefined;
  }
  return isGlobalNamed(node, checker, name) ? (name as GlobalFunction) : undefined;
}

/** The argument list of a global function called by name or, for `RegExp` and `Array`, `new`ed
 * (plan.md §11c T11.4). Each lowers to one fixed-arity node, so a spread (whose count is not its
 * arity) and an argument past the last parameter (evaluated, then ignored) are refused rather than
 * lowered wrong. Any argument type is accepted -- every one of these coerces. `Array` is the
 * exception both ways: any count but one is an array literal, and one argument may be a LENGTH,
 * whose array is all holes (docs/VALUE.md §4.4). A hole reads as `undefined`, which only an
 * Unknown element type admits: `new Array<string>(n)` would hand typed code an `undefined` its
 * element type says cannot be there. */
function gateGlobalArguments(
  name: GlobalFunction,
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): GateResult {
  const args = node.arguments ?? [];
  if (args.some((a) => ts.isSpreadElement(a))) {
    return notYet(`a spread argument to ${name} is not yet supported`, 5);
  }
  if (name === 'Array') {
    // Only a lone argument that may be a number is a LENGTH, and only a length leaves holes;
    // `Array('a')` is `['a']`.
    const [only] = args;
    if (
      args.length !== 1 ||
      only === undefined ||
      !mayBeArrayLength(checker.getTypeAtLocation(only))
    ) {
      return { kind: 'accept' };
    }
    const created = frontendTypes.tsTypeToHType(checker.getTypeAtLocation(node), checker);
    return created.kind === 'array' && created.element.kind === 'unknown'
      ? { kind: 'accept' }
      : notYet(
          'Array(n) with a typed element is not yet supported: its holes read as undefined',
          5,
        );
  }
  const arity = globalFunctionArity(name);
  return args.length > arity
    ? notYet(`${name} with ${String(args.length)} arguments is not yet supported`, 5)
    : { kind: 'accept' };
}

/** Whether `Array(x)` may read `x` as a length (§23.1.1.1 step 4): a number, or a type that
 * does not rule one out. */
function mayBeArrayLength(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.some(mayBeArrayLength);
  }
  const open =
    ts.TypeFlags.NumberLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
  return (type.flags & open) !== 0;
}

/** The most arguments a global function's node holds: a conversion reads one. */
export function globalFunctionArity(name: GlobalFunction): number {
  return name === 'String' || name === 'Number' || name === 'Boolean'
    ? 1
    : GLOBAL_CALLS[name].arity;
}

/** `typeof` of the ECMAScript globals (ECMA-262 §19), which no program can change without
 * shadowing the name -- and a shadowing binding fails the declaration-file test. The namespace
 * objects answer "object" and every constructor and function "function". `Symbol` is absent on
 * purpose: its identifier keeps its own refusal until the primitive lands. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(
  'globalThis JSON Math Reflect Atomics Intl'.split(' '),
);
const GLOBAL_CALLABLES: ReadonlySet<string> = new Set(
  (
    'Object Function Array String Number Boolean BigInt Date RegExp Map Set WeakMap WeakSet ' +
    'WeakRef FinalizationRegistry Promise Proxy ArrayBuffer SharedArrayBuffer DataView ' +
    'Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array ' +
    'Float32Array Float64Array BigInt64Array BigUint64Array Error EvalError RangeError ' +
    'ReferenceError SyntaxError TypeError URIError AggregateError parseInt parseFloat isNaN ' +
    'isFinite encodeURI encodeURIComponent decodeURI decodeURIComponent'
  ).split(' '),
);

/** The folded `typeof` of a global this identifier names, or undefined. */
export function globalTypeofOf(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): 'object' | 'function' | undefined {
  const answer = GLOBAL_OBJECTS.has(node.text)
    ? 'object'
    : GLOBAL_CALLABLES.has(node.text)
      ? 'function'
      : undefined;
  if (answer === undefined) {
    return undefined;
  }
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  // `globalThis` has no declaration at all -- the checker models it that way -- and is still
  // the global; every other name must be declared, and only in declaration files.
  return declarations.every((d) => d.getSourceFile().isDeclarationFile) &&
    (declarations.length > 0 || node.text === 'globalThis')
    ? answer
    : undefined;
}

/** True when `type` (or any union arm of it) admits `undefined` or a function — the values
 * JSON.stringify answers `undefined` FOR at the top level, where the call's type promises a
 * string. Checked at the gate so the runtime's loud abort is a compiler bug, not a user path. */
function admitsUnserializable(type: ts.Type, checker: ts.TypeChecker): boolean {
  const arms = type.isUnion() ? type.types : [type];
  return arms.some(
    (arm) =>
      (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
      checker.getSignaturesOfType(arm, ts.SignatureKind.Call).length > 0,
  );
}

/** The placeholders util.format applies to a format string, each with the index of the argument it
 * consumes: the runtime's `format_into` loop (Node's `formatWithOptionsInternal`), restated so the
 * gate can see which value each placeholder meets. `%%` consumes nothing, and once the arguments
 * run out no placeholder applies (plan.md §9 Task 6.24). */
function formatPlaceholders(
  format: string,
  count: number,
): readonly { readonly spec: string; readonly index: number }[] {
  const applied: { spec: string; index: number }[] = [];
  let consumed = 0;
  for (let i = 0; i < format.length - 1; i++) {
    if (format[i] !== '%') {
      continue;
    }
    i += 1;
    const spec = format[i] ?? '';
    if (consumed + 1 !== count && spec !== '' && 'sjdOoifc'.includes(spec)) {
      consumed += 1;
      applied.push({ spec, index: consumed });
    }
  }
  return applied;
}

/** The placeholder a console call's literal format string applies to a value the runtime cannot
 * print as Node does, or `undefined`. A format only the run sees is the runtime's to refuse, and
 * it does so loudly (STA2005, `format_refused` in jsrt_print.c); this is the same rule, reported
 * at compile time wherever the checker knows the format and the argument's type. */
function formatRefusal(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): { readonly what: string; readonly phase: number } | undefined {
  const [first] = call.arguments;
  const format = first === undefined ? undefined : checker.getTypeAtLocation(first);
  if (call.arguments.length < 2 || format === undefined || !format.isStringLiteral()) {
    return undefined;
  }
  for (const { spec, index } of formatPlaceholders(format.value, call.arguments.length)) {
    const argument = call.arguments[index];
    const type = argument === undefined ? undefined : checker.getTypeAtLocation(argument);
    for (const arm of type === undefined ? [] : type.isUnion() ? type.types : [type]) {
      // An untyped value is the run's to settle, like every other unknown argument.
      const primitive =
        (arm.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Void |
            ts.TypeFlags.Null |
            ts.TypeFlags.Any |
            ts.TypeFlags.Unknown)) !==
        0;
      if (spec === 'o' && !primitive) {
        return { what: '%o of an object', phase: 5 };
      }
      // A function or a class: String() of either is its source text, which no binary carries.
      if (
        spec === 's' &&
        (checker.getSignaturesOfType(arm, ts.SignatureKind.Call).length > 0 ||
          checker.getSignaturesOfType(arm, ts.SignatureKind.Construct).length > 0)
      ) {
        return { what: '%s of a function', phase: 5 };
      }
    }
  }
  return undefined;
}

/** A console call the HIR can spell. The method table lives with the node it configures
 * (`CONSOLE_METHODS` in `src/hir/nodes.ts`); what stays deferred is deferred for a reason rather
 * than a backlog: `time`/`timeEnd` print an ELAPSED DURATION and `trace` a stack, neither of
 * which a golden test can hold to Node byte-for-byte, and `table` is a column-layout algorithm
 * of its own. */
function isConsoleLog(access: ts.PropertyAccessExpression): boolean {
  return (
    ts.isIdentifier(access.expression) &&
    access.expression.text === 'console' &&
    Object.hasOwn(CONSOLE_METHODS, access.name.text)
  );
}
