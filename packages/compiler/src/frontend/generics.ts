/* Generic instantiation — the half of Task 3.4 that has to ask the checker.
 *
 * Monomorphization needs one thing from TypeScript that HType cannot supply on its own: for a call
 * `box(42)`, which concrete type each of `box`'s type parameters stands for. The checker already
 * computed it — that is what type inference IS — but it exposes the answer only as the RESOLVED
 * signature, with the substitution already applied and thrown away.
 *
 * So the substitution is recovered by unifying the two signatures the checker will hand over: the
 * DECLARED one, whose types still mention `T`, against the RESOLVED one, whose types do not. That
 * is a public-API route to the private type mapper, and it is exact rather than a heuristic: the
 * two signatures have the same shape by construction, because one is the other instantiated.
 *
 * Unification runs on HType rather than on `ts.Type`, which is deliberate. A tuple is the identity
 * of a specialization, and two calls share one specialization exactly when their tuples are equal —
 * so the tuple must be expressed in the model the rest of the compiler compares with. It also
 * collapses literal types for free: the checker infers `T = 42` for `box(42)` and `T = 1` for
 * `box(1)`, and both map to `number`, so those two calls share one specialization instead of
 * emitting the same C twice.
 */

import * as ts from 'typescript';
import type { HType } from '../hir/types.ts';
import { hUnknown, substituteHType } from '../hir/types.ts';
// Moved to `hir/types.ts` so the type model can ground heritage arguments without an import
// cycle; re-exported here so every existing import site keeps working.
export { specializationName, substituteHType } from '../hir/types.ts';
import { tsTypeToHType } from './types.ts';

/** What a call to a generic function resolves to.
 *
 * Every parameter binds something: unification first, then the declared default in order,
 * then `Unknown` when nothing determines it (a parameter no argument and no return position
 * mentions is dynamically represented, not refused). There is no unresolvable case — the
 * tuple is always complete, which is what lets the gate and the lowering share one path. */
export type Instantiation =
  | {
      readonly kind: 'generic';
      readonly declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
      /** The specialization key: the declared name, or the variable for an arrow/expression. */
      readonly key: string;
      readonly typeArguments: readonly HType[];
      /** Every binding the tuple was recovered with: the caller's parameters plus any nested
       * class parameters reference arguments grounded (`Box<T>` contributing `T := number`).
       * Specializations scope all of them, not just the tuple — a body can surface a nested
       * parameter where no tuple element names it. */
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | { readonly kind: 'not-generic' };

/** The instantiation a call expression names, if its callee is generic: a function
 * declaration under its own name, or an arrow or function expression under its variable's.
 *
 * An unassigned generic arrow has no home to specialize under and answers `not-generic` here;
 * the gate refuses it before lowering ever asks, so this is the backstop, not the rule. */
export function genericCallInstantiation(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Instantiation {
  const resolved = checker.getResolvedSignature(call);
  const declaration = resolved?.getDeclaration();
  if (resolved === undefined || declaration === undefined) {
    return { kind: 'not-generic' };
  }
  let target: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let key: string | undefined;
  if (ts.isFunctionDeclaration(declaration)) {
    target = declaration;
    key = declaration.name?.text ?? '';
  } else if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
    target = declaration;
    key = genericArrowKey(declaration, checker);
  }
  if (target === undefined || key === undefined) {
    return { kind: 'not-generic' };
  }
  const declared = checker.getSignatureFromDeclaration(target);
  const typeParameters = declared?.getTypeParameters();
  if (declared === undefined || typeParameters === undefined || typeParameters.length === 0) {
    return { kind: 'not-generic' };
  }

  const substitution = new Map<string, HType>();
  // Reference arguments ground nested class parameters before unification runs, so first-wins
  // keeps them: `f<T>(x: Box<T>)` called with a `Box<number>` binds `T` to `number` here, and
  // the object walk below — which can only pair names, never read a reference — cannot then
  // overwrite it with the unbound parameter. The walker's names are the CLASSES' parameters;
  // where a caller's own parameter shares a name the call forces them to agree (the checker
  // inferred both from this call), so grounding first is what makes them agree here too.
  bindReferenceArguments(argumentTypesOf(call, checker), checker, substitution);
  unifyCallArguments(
    call.arguments,
    declared.getParameters(),
    resolved.getParameters(),
    target,
    call,
    checker,
    substitution,
  );
  // The return type as well as the parameters: `function make<T>(n: number): T[]` binds `T` from
  // nothing the arguments say, and the call site's own type is where the answer is.
  unify(
    tsTypeToHType(declared.getReturnType(), checker),
    tsTypeToHType(resolved.getReturnType(), checker),
    substitution,
    new Set<string>(),
  );

  // No argument (and no return position) determined this parameter. The checker falls back
  // to the declared default, and to nothing when there is none — so this does the same;
  // see `finishTuple` for why the default (never the constraint) and why `Unknown`.
  const typeArguments = finishTuple(parameterDefaults(typeParameters, checker), substitution);
  return { kind: 'generic', declaration: target, key, typeArguments, substitution };
}

/** Finishes a tuple: every parameter still unbound after unification takes its declared
 * default, in order (so a later default sees the earlier bindings), or `Unknown` when it has
 * none. See the call-site comment for why the default — a value type the checker instantiates
 * itself — and never the constraint, and why `Unknown` is the honest element when nothing
 * determines the parameter. Always complete: every parameter is set before it is read. */
function finishTuple(
  parameters: readonly { readonly name: string; readonly defaultType: HType | undefined }[],
  substitution: Map<string, HType>,
): HType[] {
  const typeArguments: HType[] = [];
  for (const parameter of parameters) {
    if (substitution.get(parameter.name) === undefined) {
      substitution.set(
        parameter.name,
        parameter.defaultType === undefined
          ? hUnknown(false)
          : substituteHType(parameter.defaultType, (n) => substitution.get(n)),
      );
    }
    // Set above when missing, so this read cannot miss — but `Map.get` types force the check,
    // and the honest `Unknown` keeps the tuple aligned whatever happens.
    const bound = substitution.get(parameter.name) ?? hUnknown(false);
    // Nested class parameters surface here still naming the class (`Box<T>` in the tuple for a
    // `Box<number>` argument); the walker's grounding rewrites them to what the reference said.
    typeArguments.push(substituteHType(bound, (n) => substitution.get(n)));
  }
  return typeArguments;
}

/** The `{ name, defaultType }` list every `finishTuple` call builds from type parameters. */
function parameterDefaults(
  typeParameters: readonly ts.TypeParameter[],
  checker: ts.TypeChecker,
): { name: string; defaultType: HType | undefined }[] {
  return typeParameters.map((typeParameter) => ({
    name: typeParameter.getSymbol()?.getName() ?? '',
    defaultType: typeParameterDefault(typeParameter, checker),
  }));
}

/** A `const` declaration list with exactly one declarator — the shape a named generic
 * function/arrow must sit in to have a stable key. */
function isSingleConstList(list: ts.Node | undefined): list is ts.VariableDeclarationList {
  return (
    list !== undefined &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    list.declarations.length === 1
  );
}

/** Whether a `let`/`var` declarator's binding is written exactly once — its initializer.
 *
 * A later reassignment would change which function a collected tuple stands for, so the
 * single-assignment rule (docs/HIR.md §7.2) is what lets a non-`const` home specialize.
 * Walks the enclosing source for writes to the same symbol; the declaration's own name is
 * not a write. */
function isSingleAssignmentBinding(decl: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) {
    return false;
  }
  let writes = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node !== decl.name) {
      const parent = node.parent;
      const isWriteTarget =
        (ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        (ts.isPrefixUnaryExpression(parent) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isPostfixUnaryExpression(parent) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isForInStatement(parent) && parent.initializer === node) ||
        (ts.isForOfStatement(parent) && parent.initializer === node);
      if (isWriteTarget && checker.getSymbolAtLocation(node) === symbol) {
        writes += 1;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(decl.getSourceFile(), visit);
  return writes === 0;
}

/** Unify same-named members of two object layouts (fields against fields, methods against
 * methods). Shared by the two halves of object unification. */
function unifyNamedMembers<T extends { readonly name: string; readonly type: HType }>(
  declared: readonly T[],
  concrete: readonly T[],
  out: Map<string, HType>,
  seen: Set<string>,
): void {
  for (const member of declared) {
    const match = concrete.find((m) => m.name === member.name);
    if (match !== undefined) {
      unify(member.type, match.type, out, seen);
    }
  }
}

/** What a `new` expression resolves to, when its class is generic.
 *
 * Mirrors `genericCallInstantiation` through the CONSTRUCT signature: the tuple comes from the
 * constructor's parameters, explicit type arguments included (they are already applied in the
 * resolved signature, so no special case reads them). The type parameters live on the class,
 * not on the constructor, which is the only structural difference. */
export type ClassInstantiation =
  | {
      readonly kind: 'generic';
      readonly declaration: ts.ClassDeclaration;
      readonly typeArguments: readonly HType[];
      /** Every binding the tuple was recovered with — the class's parameters plus any nested
       * ones reference arguments grounded. Specializations scope all of them. */
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | { readonly kind: 'not-generic' };

/** The instantiation a `new` expression names, if its class is generic. */
export function genericNewInstantiation(
  created: ts.NewExpression,
  checker: ts.TypeChecker,
): ClassInstantiation {
  if (created.expression === undefined) {
    return { kind: 'not-generic' };
  }
  const resolved = checker.getResolvedSignature(created);
  const declaration = resolved?.getDeclaration();
  // A class with no declared constructor resolves with no declaration at all: the class comes
  // from the callee's own symbol instead. There are no declared parameters to unify then — the
  // tuple comes from explicit type arguments, if written, or from the default/Unknown fallback.
  let classDeclaration: ts.ClassDeclaration | undefined;
  let constructor: ts.ConstructorDeclaration | undefined;
  if (declaration !== undefined && ts.isConstructorDeclaration(declaration)) {
    const parent = declaration.parent;
    classDeclaration = ts.isClassDeclaration(parent) ? parent : undefined;
    constructor = declaration;
  } else {
    const symbol = ts.isIdentifier(created.expression)
      ? checker.getSymbolAtLocation(created.expression)
      : undefined;
    const valueDeclaration = symbol?.valueDeclaration;
    classDeclaration =
      valueDeclaration !== undefined && ts.isClassDeclaration(valueDeclaration)
        ? valueDeclaration
        : undefined;
  }
  if (classDeclaration === undefined) {
    return { kind: 'not-generic' };
  }
  const typeParameters = classDeclaration.typeParameters ?? [];
  if (typeParameters.length === 0) {
    return { kind: 'not-generic' };
  }
  const substitution = new Map<string, HType>();
  bindReferenceArguments(argumentTypesOf(created, checker), checker, substitution);
  if (created.typeArguments !== undefined) {
    // Explicit arguments are authoritative: the checker resolved the construction with them,
    // so they bind before unification (which would recover the same values through the
    // resolved signature) and before the fallback (which must not shadow them).
    created.typeArguments.forEach((argument, index) => {
      const parameter = typeParameters[index];
      if (parameter !== undefined && !substitution.has(parameter.name.text)) {
        substitution.set(
          parameter.name.text,
          tsTypeToHType(checker.getTypeFromTypeNode(argument), checker),
        );
      }
    });
  }
  if (constructor !== undefined) {
    const declared = checker.getSignatureFromDeclaration(constructor);
    if (declared !== undefined) {
      unifyCallArguments(
        created.arguments,
        declared.getParameters(),
        resolved?.getParameters() ?? [],
        constructor,
        created,
        checker,
        substitution,
      );
    }
  }
  const typeArguments = finishTuple(
    typeParameters.map((parameter) => ({
      name: parameter.name.text,
      defaultType: defaultTypeOf(parameter, checker),
    })),
    substitution,
  );
  return { kind: 'generic', declaration: classDeclaration, typeArguments, substitution };
}

/** What a generic passed as an argument resolves to: `run(box, 1)` specializes `box` at the
 * parameter's function type.
 *
 * The tuple unifies the generic's declared signature against the PARAMETER (not a call): the
 * parameter is the only static description of how the value will be used. A named generic in a
 * positional argument, or an inline generic arrow or function expression passed directly (which
 * names its own call site and takes a position-derived key) — a spread element has no single
 * parameter to read, and a rest parameter's element type is not the value's type — and the
 * parameter must itself be function-typed (anything else is a checker error first). Raw like
 * every other instantiation: the caller substitutes the enclosing scope. */
export function genericArgumentTuple(
  argument: ts.Expression,
  outerCall: ts.CallExpression,
  checker: ts.TypeChecker,
):
  | {
      readonly declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
      readonly key: string;
      readonly typeArguments: readonly HType[];
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | undefined {
  if (!ts.isIdentifier(argument)) {
    return inlineGenericTuple(argument, checker);
  }
  const generic = genericAliasTarget(argument, checker);
  if (generic === undefined) {
    return undefined;
  }
  const key = ts.isFunctionDeclaration(generic)
    ? (generic.name?.text ?? '')
    : genericArrowKey(generic, checker);
  if (key === undefined) {
    return undefined;
  }
  return instantiateAtParameter(generic, key, argument, outerCall, checker);
}

/** The tuple a generic argument takes at its parameter's function type, shared by the named
 * and inline paths: the parameter must exist, must not be a rest parameter, and must itself
 * be function-typed (anything else is a checker error first). Raw like every other
 * instantiation: the caller substitutes the enclosing scope. */
function instantiateAtParameter(
  generic: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  key: string,
  argument: ts.Expression,
  outerCall: ts.CallExpression,
  checker: ts.TypeChecker,
):
  | {
      readonly declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
      readonly key: string;
      readonly typeArguments: readonly HType[];
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | undefined {
  const outer = checker.getResolvedSignature(outerCall);
  if (outer === undefined) {
    return undefined;
  }
  const index = outerCall.arguments.indexOf(argument);
  const parameter = outer.getParameters()[index];
  const parameterDeclaration = parameter === undefined ? undefined : parameter.valueDeclaration;
  if (
    parameter === undefined ||
    parameterDeclaration === undefined ||
    !ts.isParameter(parameterDeclaration) ||
    parameterDeclaration.dotDotDotToken !== undefined
  ) {
    return undefined;
  }
  const signature = checker.getSignatureFromDeclaration(generic);
  const typeParameters = signature?.getTypeParameters() ?? [];
  if (typeParameters.length === 0) {
    return undefined;
  }
  const declaredFn = tsTypeToHType(checker.getTypeAtLocation(generic), checker);
  const parameterFn = tsTypeToHType(
    checker.getTypeOfSymbolAtLocation(parameter, argument),
    checker,
  );
  if (declaredFn.kind !== 'fn' || parameterFn.kind !== 'fn') {
    return undefined;
  }
  const substitution = new Map<string, HType>();
  bindReferenceArguments(
    [checker.getTypeAtLocation(argument), checker.getTypeOfSymbolAtLocation(parameter, argument)],
    checker,
    substitution,
  );
  unify(declaredFn, parameterFn, substitution, new Set<string>());
  const typeArguments = finishTuple(
    typeParameters.map((typeParameter) => ({
      name: typeParameter.getSymbol()?.getName() ?? '',
      defaultType: typeParameterDefault(typeParameter, checker),
    })),
    substitution,
  );
  if (typeArguments === undefined) {
    return undefined;
  }
  return { declaration: generic, key, typeArguments, substitution };
}

/** What an inline generic arrow or function expression passed directly as a call argument
 * resolves to: `[1].map(<T>(x: T): T => x)` specializes the arrow at the callback parameter's
 * function type, exactly as a named generic would.
 *
 * The arrow literal IS its own use site, so one tuple suffices and the key is the position
 * rather than a variable: `arrow@<file>#<offset>`, unspellable from source like every other
 * specialization key. The file base rides along because collection merges specializations
 * across files by name — two files can hold an arrow at one offset, and sharing one body
 * between them would be a miscompile, not a saving.
 *
 * Three refusals, each a shape no module-level specialization could honour. A callee, a
 * conditional branch, a `new` argument, or any other non-argument position has no single
 * parameter type to read. A body that reads an enclosing scope — a parameter or local of an
 * enclosing function, `this`, `super`, a `new.target`, or a binding a block scopes away from
 * the module top level — would resolve to no binding in a module-level function (STA4035),
 * so the gate refuses it here rather than manufacture that internal error. `let`-held and
 * nested arrows stay refused with it: reassignment could change the value under a collected
 * tuple, and a nesting's scope the module-level specializations would leak. */
export function inlineGenericTuple(
  argument: ts.Expression,
  checker: ts.TypeChecker,
):
  | {
      readonly declaration: ts.FunctionExpression | ts.ArrowFunction;
      readonly key: string;
      readonly typeArguments: readonly HType[];
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | undefined {
  // Through parentheses to the function: `f((<T>(x: T): T => x))` specializes the arrow, not
  // the parenthesized expression. Anything else — a conditional, a satisfaction, a nested
  // call — is not a direct argument and has no single parameter type.
  let unwrapped: ts.Expression = argument;
  while (ts.isParenthesizedExpression(unwrapped)) {
    unwrapped = unwrapped.expression;
  }
  if (
    (!ts.isFunctionExpression(unwrapped) && !ts.isArrowFunction(unwrapped)) ||
    unwrapped.typeParameters === undefined ||
    unwrapped.typeParameters.length === 0
  ) {
    return undefined;
  }
  let current: ts.Node = unwrapped;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  // Sound: the walk starts at an expression and steps only through parenthesized
  // expressions, which are expressions too — so the chain's top is the argument the call
  // holds, and the parameter lookup below pairs by that position.
  const raw = current as ts.Expression;
  if (
    parent === undefined ||
    !ts.isCallExpression(parent) ||
    parent.expression === current ||
    parent.arguments.indexOf(raw) === -1
  ) {
    return undefined;
  }
  if (capturesEnclosingScope(unwrapped, checker)) {
    return undefined;
  }
  // `raw`, not `argument`: the parameter lookup pairs by the argument's own position,
  // and through parentheses that position is the chain's top, which is what the call holds.
  const instantiated = instantiateAtParameter(
    unwrapped,
    positionGenericKey(unwrapped),
    raw,
    parent,
    checker,
  );
  if (instantiated === undefined) {
    return undefined;
  }
  return { ...instantiated, declaration: unwrapped };
}

/** The position-derived specialization key: `<home>@<file>#<offset>` (docs/HIR.md §7).
 *
 * `home` is the variable's name for a block-homed generic (`id@app.ts#128`) and the
 * anonymous kind for an inline one (`arrow@app.ts#128` / `fn@app.ts#128`). The offset is
 * content-derived, so identical input keys identically (plan.md §9 Task 6.9); `@` and `#`
 * are unspellable in identifiers, so the key can never collide with a variable the way two
 * same-named block bindings could. */
function positionGenericKey(fn: ts.FunctionExpression | ts.ArrowFunction, home?: string): string {
  const sourceFile = fn.getSourceFile();
  const base = sourceFile.fileName.split('/').pop() ?? sourceFile.fileName;
  const kind = home ?? (ts.isArrowFunction(fn) ? 'arrow' : 'fn');
  return `${kind}@${base}#${String(fn.getStart(sourceFile))}`;
}

/** The name a specialization prints under: the variable's own name, never the position
 * suffix (`id` from `id@app.ts#128`). Identifiers cannot spell `@`, so the split cannot
 * collide with a source name. */
export function genericArrowPrintName(key: string): string {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** Whether the function's body reads anything a module-level specialization could not see.
 *
 * Every free reference in the body resolves by symbol; a reference is safe exactly when its
 * declaration is the function's own or is visible from module scope. Types erase, so type
 * positions are skipped whole — a type argument mentioning an enclosing `T` is a substitution
 * the enclosing specialization applies, not a value the body reads. `this`, `super`, and
 * `new.target` are always captures: an arrow's `this` is its encloser's by definition, and
 * for named functions treating them as captures over-refuses a compilable program rather
 * than accepting an uncompilable one. Shared by the inline path and the named-declaration
 * path (plan.md §8 step 12(f)): specialization bodies lower before their file's statements,
 * so both shapes refuse the same reads. */
export function capturesEnclosingScope(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  checker: ts.TypeChecker,
): boolean {
  let captured = false;
  const visit = (node: ts.Node): void => {
    if (captured || ts.isTypeNode(node)) {
      return;
    }
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword)
    ) {
      captured = true;
      return;
    }
    if (ts.isMetaProperty(node)) {
      return;
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (
        declaration !== undefined &&
        (!isModuleVisible(declaration, fn) || isSpecializationBlindSpot(declaration, fn))
      ) {
        captured = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return captured;
}

/** Declaration and member forms whose `name` is the spelling the node BINDS (so that name is
 * not a value read). Property access / property assignment names are member labels and are
 * excluded by the caller. */
const SELF_NAMED_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.EnumMember,
]);

function bindsOwnName(parent: ts.Node, child: ts.Node): boolean {
  return SELF_NAMED_KINDS.has(parent.kind) && (parent as ts.NamedDeclaration).name === child;
}

/** Whether an identifier in the arrow reads a value, rather than naming a member or declaring
 * one. Member names (`o.y`, `{ y: 1 }`, `class C { y() {} }`) resolve to declarations the
 * object — not the arrow — owns, so only the object side can be a capture; declaration names
 * resolve to themselves. Defaults to a read: an unlisted position may over-refuse a
 * compilable program, never accept an uncompilable one. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  // A shorthand `{ y }` reads its binding — it is a value, not a member name. Checked
  // before the property-assignment arm below so the two can never overlap.
  if (ts.isShorthandPropertyAssignment(parent)) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  // A declaration binds its own name: the name resolves to itself, contained wherever the
  // declaration sits, so it can never be a capture of an enclosing scope.
  if (bindsOwnName(parent, node)) {
    return false;
  }
  if (ts.isLabeledStatement(parent)) {
    return false;
  }
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
  return true;
}

/** Whether a declaration is visible from a module-level specialization: the arrow's own, or
 * a binding whose scope chain to its file's top level crosses nothing opaque. Function and
 * class bodies, namespaces, enums, and — the reason blocks are here — block scopes all hide
 * their bindings from the module top level: `if (c) { const y = 1; run(<T>(x: T): T => y); }`
 * would otherwise resolve `y` to no binding (STA4035). Imports, globals, and statement-level
 * bindings reach their file's top level untouched. */
function isModuleVisible(declaration: ts.Node, fn: ts.Node): boolean {
  if (containsNode(fn, declaration)) {
    return true;
  }
  let current: ts.Node | undefined = declaration.parent;
  while (current !== undefined) {
    if (ts.isSourceFile(current)) {
      return true;
    }
    if (isScopeBoundary(current)) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

/** Whether a module-visible binding is nevertheless unreadable from a specialization body.
 *
 * Specialization bodies lower before their own file's statements — and verify before those
 * statements' bindings exist — so only hoisted bindings are reachable in time: function and
 * class declarations, imports, and globals. A same-file `let`, `const`, or `var` resolves to
 * no binding there (`STA4035` from the lowering for the first two, `STA4002` from the
 * verifier for the third, whose hoist feeds one stage but not the other), so the gate refuses
 * the read here rather than manufacture those internal errors. Cross-file bindings are
 * already registered — dependencies lower before their importers — as are ambient globals.
 * The inline path and the named-declaration path share this rule through
 * `capturesEnclosingScope` (plan.md §8 step 12(f)). */
function isSpecializationBlindSpot(declaration: ts.Node, fn: ts.Node): boolean {
  if (!ts.isVariableDeclaration(declaration)) {
    return false;
  }
  // The function's own bindings lower with it: a `let` inside the body is part of the
  // specialization, not a module-order read. Only an outer same-file variable is blind.
  if (containsNode(fn, declaration)) {
    return false;
  }
  return declaration.getSourceFile() === fn.getSourceFile();
}

/** Whether `ancestor` textually contains `descendant`. Positions, not identity: two bindings
 * sharing a spelling are two nodes, and only containment tells which scope owns which. */
function containsNode(ancestor: ts.Node, descendant: ts.Node): boolean {
  return descendant.getStart() >= ancestor.getStart() && descendant.getEnd() <= ancestor.getEnd();
}

/** Scopes a module-level specialization cannot read through: every function shape, every
 * class shape, every block shape, and the declaration forms that scope their contents. Loop
 * statements are here for their headers — `for (const y of …)` scopes `y` to the loop, not
 * to any block under it. */
const SCOPE_BOUNDARY_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.ModuleBlock,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
]);

function isScopeBoundary(node: ts.Node): boolean {
  return SCOPE_BOUNDARY_KINDS.has(node.kind);
}

/** What a named generic resolves to where it is READ as a value: `console.log(box)`,
 * `take(box)` for an untyped parameter, a rest argument.
 *
 * The tuple is what no call site determines: every parameter takes its declared default,
 * in order, or `Unknown` when it has none — the same `finishTuple` a call with no
 * information takes, so the value shares its specialization with an undetermined call
 * rather than inventing a second answer. The caller applies the enclosing substitution,
 * as for every other instantiation; at the top level there is nothing to apply and the
 * tuple is closed.
 *
 * Only a generic with a home to specialize under qualifies — a declaration, an assigned
 * arrow or function expression, or a `const` alias chain to either (all through
 * `genericAliasTarget`). An unassigned arrow anywhere else has nowhere to build even one copy
 * for and stays refused at the gate; at a direct call argument it takes the parameter's tuple
 * instead (`inlineGenericTuple`). `undefined` for anything else. */
export function genericValueInstantiation(
  node: ts.Identifier,
  checker: ts.TypeChecker,
):
  | {
      readonly declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
      readonly key: string;
      readonly typeArguments: readonly HType[];
      readonly substitution: ReadonlyMap<string, HType>;
    }
  | undefined {
  const target = genericAliasTarget(node, checker);
  if (target === undefined) {
    return undefined;
  }
  const signature = checker.getSignatureFromDeclaration(target);
  const typeParameters = signature?.getTypeParameters() ?? [];
  if (typeParameters.length === 0) {
    return undefined;
  }
  const key = ts.isFunctionDeclaration(target)
    ? (target.name?.text ?? '')
    : genericArrowKey(target, checker);
  if (key === undefined) {
    return undefined;
  }
  const substitution = new Map<string, HType>();
  const typeArguments = finishTuple(parameterDefaults(typeParameters, checker), substitution);
  return { declaration: target, key, typeArguments, substitution };
}

/** The tuple a class reference already carries: `Box<number>` names `[number]` without asking
 * any call site.
 *
 * Used where no signature is being unified — a method call or field read on an instance whose
 * type the checker resolved to a reference. The arguments map through the HType model like any
 * annotation; anything still mentioning a type parameter (a reference inside an enclosing
 * specialization, `Box<T>`) is left for the caller to substitute. `undefined` when the type is
 * not a reference to this class, or its arity disagrees — both are the caller'sordinary paths,
 * not errors. */
export function classReferenceTuple(
  declaration: ts.ClassDeclaration,
  type: ts.Type,
  checker: ts.TypeChecker,
): HType[] | undefined {
  // The reference's own symbol is the class: an instantiation of anything else — or a bare
  // `this`-type with no arguments — is the caller's ordinary path, not an error.
  if (type.getSymbol()?.valueDeclaration !== declaration) {
    return undefined;
  }
  const parameters = declaration.typeParameters ?? [];
  const args = (type as ts.TypeReference).typeArguments;
  if (parameters.length === 0 || args === undefined || args.length !== parameters.length) {
    return undefined;
  }
  return args.map((arg) => tsTypeToHType(arg, checker));
}

/** The variable a generic arrow or function expression is aliased to, if it is one
 * (docs/HIR.md §7).
 *
 * Monomorphization needs a declaration to lower a second time, and for an expression that is
 * the variable holding it: `const id = <T>(x: T): T => x` specializes `id` per tuple, exactly
 * as a declaration specializes its own name. A block-homed `const` (or a `let`/`var` whose
 * only write is its initializer) qualifies under a **position-derived key** `name@file#offset`,
 * because two blocks can bind the same name and sharing one body would be a miscompile
 * (§7.1). A module-scope `const` keeps its plain name as the key — module-level names are
 * unique per file, and cross-file collection already disambiguates by dependency ordinal.
 *
 * Anything else — an inline arrow, a callback, a reassignable `let`, a nesting whose body
 * captures an enclosing scope — has no home to specialize under and answers `undefined`.
 * The gate refuses those shapes except an inline arrow at a direct call argument, which takes
 * the parameter's tuple under a position-derived key (`inlineGenericTuple`). Returns the key,
 * which identifies the specializations; `genericArrowPrintName` recovers the printable name. */
export function genericArrowKey(node: ts.Expression, checker?: ts.TypeChecker): string | undefined {
  let fn: ts.Expression = node;
  while (ts.isParenthesizedExpression(fn)) {
    fn = fn.expression;
  }
  if (
    (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) ||
    fn.typeParameters === undefined ||
    fn.typeParameters.length === 0
  ) {
    return undefined;
  }
  let parent = fn.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  if (parent === undefined || !ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) {
    return undefined;
  }
  const list = parent.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list) || list.declarations.length !== 1) {
    return undefined;
  }
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  if (!isConst) {
    // A `let`/`var` qualifies only when the initializer is its sole write (§7.2). The
    // checker counts the writes; without one, only `const` has the guarantee by construction.
    if (checker === undefined || !isSingleAssignmentBinding(parent, checker)) {
      return undefined;
    }
  }
  const statement = list.parent;
  if (statement === undefined || !ts.isVariableStatement(statement)) {
    return undefined;
  }
  const name = parent.name.text;
  // Module-scope `const` keeps the plain name (existing key form, §7.1). Every other home
  // takes the position form so two blocks cannot share one specialization body.
  if (isConst && ts.isSourceFile(statement.parent)) {
    return name;
  }
  return positionGenericKey(fn, name);
}

/** The generic a value position names, following `const` aliases and imports.
 *
 * `box` itself (a generic declaration), `id` for `const id = <T…>…` (an assigned generic
 * arrow, validated), `f` for `const f = box` and `g` for `const g = f` (aliases, transitively).
 * Only `const` links are followed — a `let`/`var` could be reassigned under a collected tuple —
 * and cycles terminate the walk (a self-referential initializer is dead code anyway). Import
 * aliases resolve through to the declaration, so an imported generic behaves like a local one.
 * `undefined` for anything else: a non-generic value, an unassigned arrow, a broken chain. */
export function genericAliasTarget(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  const seen = new Set<ts.Symbol>();
  let current: ts.Node | undefined = node;
  while (current !== undefined && ts.isIdentifier(current)) {
    let symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined) {
      return undefined;
    }
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (seen.has(symbol)) {
      return undefined;
    }
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (declaration === undefined) {
      return undefined;
    }
    if (
      (ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration)) &&
      declaration.typeParameters !== undefined &&
      declaration.typeParameters.length > 0
    ) {
      // An arrow or function expression is only a generic value where it is assigned (the same
      // rule that lets it specialize); anywhere else it is the unassigned shape the gate
      // refuses, not an alias source.
      if (
        !ts.isFunctionDeclaration(declaration) &&
        genericArrowKey(declaration, checker) === undefined
      ) {
        return undefined;
      }
      return declaration;
    }
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined
    ) {
      return undefined;
    }
    // Through an assigned generic arrow: `const j = id` aliases what `id` holds, so the chain
    // continues at the arrow rather than stopping at the variable.
    let init: ts.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(init)) {
      init = init.expression;
    }
    if (
      (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) &&
      init.typeParameters !== undefined &&
      init.typeParameters.length > 0
    ) {
      return genericArrowKey(declaration.initializer, checker) === undefined ? undefined : init;
    }
    if (!ts.isIdentifier(init)) {
      return undefined;
    }
    const list = declaration.parent;
    if (!isSingleConstList(list)) {
      return undefined;
    }
    current = declaration.initializer;
  }
  return undefined;
}

/** The HType of a declared default (`<T = string>`), if the parameter has one.
 *
 * Read through the checker's `getTypeFromTypeNode` so the default resolves in scope — a default
 * is an ordinary type annotation, and this is the same mapping every other annotation takes. */
function defaultTypeOf(
  declaration: ts.TypeParameterDeclaration | undefined,
  checker: ts.TypeChecker,
): HType | undefined {
  if (declaration?.default === undefined) {
    return undefined;
  }
  return tsTypeToHType(checker.getTypeFromTypeNode(declaration.default), checker);
}

/** The HType of a type parameter's declared default, via its declaration. */
function typeParameterDefault(
  parameter: ts.TypeParameter,
  checker: ts.TypeChecker,
): HType | undefined {
  const declaration = parameter.getSymbol()?.getDeclarations()?.[0];
  if (declaration === undefined || !ts.isTypeParameterDeclaration(declaration)) {
    return undefined;
  }
  return defaultTypeOf(declaration, checker);
}

/** Whether a value parameter may be omitted or fall back to its initializer (`x?: T`,
 * `x: T = ...`). Its apparent type carries `| undefined` for the missing case, which is
 * missingness, not information about any type argument. */
function isOmissibleParameter(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isParameter(declaration) &&
    (declaration.questionToken !== undefined || declaration.initializer !== undefined)
  );
}

/** The HType to unify a declared parameter from: the annotation itself for an omissible
 * parameter (so `x?: T` unifies `T` rather than the collapsed `unknown` its `T | undefined`
 * apparent type maps to), the apparent type otherwise. */
function declaredParamType(param: ts.Symbol, location: ts.Node, checker: ts.TypeChecker): HType {
  const declaration = param.valueDeclaration;
  if (
    declaration !== undefined &&
    ts.isParameter(declaration) &&
    (declaration.questionToken !== undefined || declaration.initializer !== undefined) &&
    declaration.type !== undefined
  ) {
    const annotated = checker.getTypeFromTypeNode(declaration.type);
    if (annotated.isUnion()) {
      const concrete = annotated.types.filter((t) => (t.flags & ts.TypeFlags.Undefined) === 0);
      const [only] = concrete;
      if (concrete.length === 1 && only !== undefined) {
        return tsTypeToHType(only, checker);
      }
    } else {
      return tsTypeToHType(annotated, checker);
    }
  }
  return tsTypeToHType(checker.getTypeOfSymbolAtLocation(param, location), checker);
}

/** The ts.Types a tuple can be grounded from: every argument's type, plus the resolved
 * return type (a `make<T>(): Box<T>` binds through its answer, not its parameters). */
function argumentTypesOf(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): ts.Type[] {
  const args = [...(call.arguments ?? [])].map((arg) => checker.getTypeAtLocation(arg));
  const resolved = checker.getResolvedSignature(call);
  if (resolved !== undefined) {
    args.push(resolved.getReturnType());
  }
  return args;
}

/** Grounds nested class parameters from reference type arguments: `Box<number>` anywhere in an
 * argument or answer binds `T := number` for `Box<T>`.
 *
 * The HType model erases the arguments — a reference maps through its declaration, whose
 * parameters are unbound — so unification alone can only pair names, never read a reference.
 * Without this walk, `f<T>(x: Box<T>)` called with a `Box<number>` binds `T` to the unbound
 * parameter and the specialization fails verification downstream. The walk runs first so
 * first-wins keeps grounded values over paired names; structural recursion (arrays, unions,
 * signatures) finds references nested inside other types. Cyclic types stop at the revisit —
 * the first visit bound everything the cycle can say.
 *
 * Only fills UNBOUND names: a caller's own parameter keeps whatever unification binds, and a
 * second, different reference to the same name cannot overwrite the first. */
function bindReferenceArguments(
  types: readonly ts.Type[],
  checker: ts.TypeChecker,
  out: Map<string, HType>,
): void {
  const seen = new Set<ts.Type>();
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) {
      return;
    }
    seen.add(type);
    const declaration = type.getSymbol()?.valueDeclaration;
    const args = (type as ts.TypeReference).typeArguments;
    if (declaration !== undefined && ts.isClassDeclaration(declaration) && args !== undefined) {
      const parameters = declaration.typeParameters ?? [];
      parameters.forEach((parameter, index) => {
        const arg = args[index];
        if (arg !== undefined && !out.has(parameter.name.text)) {
          out.set(parameter.name.text, tsTypeToHType(arg, checker));
          visit(arg);
        }
      });
    }
    if (type.isUnion()) {
      for (const constituent of type.types) {
        visit(constituent);
      }
      return;
    }
    // Arrays, tuples, maps and sets nest references in their own arguments (`Box<number>[]`
    // grounds through its element). Function types need no walk: a reference in a declared
    // parameter or return position carries no arguments to bind.
    const nested = (type as ts.TypeReference).typeArguments;
    if (nested !== undefined) {
      for (const arg of nested) {
        visit(arg);
      }
    }
  };
  for (const type of types) {
    visit(type);
  }
}

/** Unifies one call's (or construction's) arguments against the declared parameters.
 *
 * Shared by calls and `new`: both pair positional arguments with parameters, both skip a missing
 * optional (its absence is the default-or-nothing fallback's business, not unification's), and
 * both read a present argument's own type rather than the parameter's — whose apparent
 * `T | undefined` would collapse and hide the argument. */
function unifyCallArguments(
  args: readonly ts.Expression[] | undefined,
  declaredParams: readonly ts.Symbol[],
  resolvedParams: readonly ts.Symbol[],
  declaration: ts.Node,
  call: ts.Node,
  checker: ts.TypeChecker,
  substitution: Map<string, HType>,
): void {
  const seen = new Set<string>();
  for (let i = 0; i < declaredParams.length; i++) {
    const declaredParam = declaredParams[i];
    const resolvedParam = resolvedParams[i];
    if (declaredParam === undefined || resolvedParam === undefined) {
      continue;
    }
    const omissible = isOmissibleParameter(declaredParam);
    const passed = omissible ? args?.[i] : undefined;
    const argument = passed === undefined || ts.isSpreadElement(passed) ? undefined : passed;
    if (omissible && argument === undefined) {
      continue;
    }
    unify(
      declaredParamType(declaredParam, declaration, checker),
      argument === undefined
        ? tsTypeToHType(checker.getTypeOfSymbolAtLocation(resolvedParam, call), checker)
        : tsTypeToHType(checker.getTypeAtLocation(argument), checker),
      substitution,
      seen,
    );
  }
}

/** Binds every type parameter in `declared` to the type standing in its place in `concrete`.
 *
 * First binding wins. A second, different one cannot happen for a well-typed call — the checker
 * unified these two signatures itself before either reached here — and silently preferring the
 * later one would hide the day that stops being true.
 *
 * Objects unify pairwise by field and method when they lay out the same class: `f<T>(x: Box<T>)`
 * called with a `Box<number>` binds `T` to `number`, which is what makes functions over generic
 * instances specialize statically rather than fall back to the dynamic representation. Different
 * layouts do not unify — the binding, if any, comes from elsewhere. The `seen` set stops the
 * walk on cyclic layouts (`class C { self: C }` would otherwise recurse forever): revisiting a
 * pair binds nothing new, because the first visit already bound everything the pair can say. */
function unify(declared: HType, concrete: HType, out: Map<string, HType>, seen: Set<string>): void {
  if (declared.kind === 'type-param') {
    if (!out.has(declared.name)) {
      out.set(declared.name, concrete);
    }
    return;
  }
  if (declared.kind === 'array' && concrete.kind === 'array') {
    unify(declared.element, concrete.element, out, seen);
    return;
  }
  if (declared.kind === 'set' && concrete.kind === 'set') {
    unify(declared.element, concrete.element, out, seen);
    return;
  }
  if (declared.kind === 'map' && concrete.kind === 'map') {
    unify(declared.key, concrete.key, out, seen);
    unify(declared.value, concrete.value, out, seen);
    return;
  }
  if (declared.kind === 'fn' && concrete.kind === 'fn') {
    for (let i = 0; i < declared.params.length; i++) {
      const d = declared.params[i];
      const c = concrete.params[i];
      if (d !== undefined && c !== undefined) {
        unify(d, c, out, seen);
      }
    }
    unify(declared.ret, concrete.ret, out, seen);
    return;
  }
  if (declared.kind === 'object' && concrete.kind === 'object') {
    if (declared.name !== concrete.name || declared.namespace !== concrete.namespace) {
      return;
    }
    const pair = `${declared.name}◊${fieldNames(declared)}◊${fieldNames(concrete)}`;
    if (seen.has(pair)) {
      return;
    }
    seen.add(pair);
    unifyNamedMembers(declared.fields, concrete.fields, out, seen);
    unifyNamedMembers(declared.methods, concrete.methods, out, seen);
  }
  // Anything else — a scalar against anything, or two layouts that never agreed — binds nothing.
  // The fallback (default, then `Unknown`) decides those parameters, not this walk.
}

/** The field names of a layout, in order: what identifies one side of an object-unification pair
 * for the cycle guard. Names, not types — two visits to the same pair of layouts bind the same
 * names to the same types, so the second visit has nothing to add. */
function fieldNames(type: {
  readonly fields: readonly { readonly name: string }[];
  readonly methods: readonly { readonly name: string }[];
}): string {
  return [...type.fields, ...type.methods].map((f) => f.name).join(',');
}
