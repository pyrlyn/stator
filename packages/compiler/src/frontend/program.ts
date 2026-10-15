import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type { Diagnostic } from '../support/diagnostics.ts';
import { BuildError, diagnosticFromFile, renderDiagnostic } from '../support/diagnostics.ts';
import { hasTypeScriptAnnotation } from './annotation.ts';
import { strictReservedImports } from './modules.ts';
import { isCheckable } from './narrowing.ts';
import {
  classifyNodeMember,
  classifyNodeSpecifier,
  type NodeNotYet,
  nodeGlobalsFile,
  nodePathMapping,
} from './node.ts';
import {
  classifyStdMember,
  classifyStdSpecifier,
  type StdSpecifier,
  stdPathMapping,
} from './std.ts';
import { tsTypeToHType } from './types.ts';

type Mode = 'ts' | 'js';

function identifierAt(source: ts.SourceFile, position: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    if (ts.isIdentifier(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The checker codes for an undeclared name — plain, with the `@types/node` hint (two spellings),
 * and as a shorthand property — when the name is one of Node's two CommonJS path globals. */
const UNDECLARED_NAME_CODES: ReadonlySet<number> = new Set([2304, 2580, 2591, 18004]);

function isNodePathGlobalRead(diag: ts.Diagnostic): boolean {
  if (
    !UNDECLARED_NAME_CODES.has(diag.code) ||
    diag.file === undefined ||
    diag.start === undefined
  ) {
    return false;
  }
  const name = identifierAt(diag.file, diag.start)?.text;
  return name === '__filename' || name === '__dirname';
}

/** A TS1117 duplicate-key diagnostic that must NOT be swallowed by the js-mode carve-out:
 * two or more `__proto__` DATA properties (`PropertyName : AssignmentExpression`) in one
 * object literal — an early SyntaxError per spec B.3.1 that Node rejects, so js mode refuses it
 * as STA0012 like every other checker refusal. Only that form counts: a computed key
 * (`{ ['__proto__']: 1 }`), a shorthand (`{ __proto__ }`), a method, an accessor, or a spread
 * beside a data `__proto__` is legal JavaScript (last wins) and stays suppressed. The
 * diagnostic sits on one of the duplicate names; whichever occurrence it is, walking up to the
 * enclosing literal and counting data `__proto__` entries answers the question. */
function isDuplicateProtoDataProperty(source: ts.SourceFile, position: number): boolean {
  let literal: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    if (ts.isObjectLiteralExpression(node)) {
      literal = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (literal === undefined) {
    return false;
  }
  let count = 0;
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || property.name === undefined) {
      continue;
    }
    const { name } = property;
    if (ts.isComputedPropertyName(name)) {
      continue;
    }
    if (name.text === '__proto__') {
      count += 1;
    }
  }
  return count >= 2;
}

/** Whether a TS2630 diagnostic writes a function DECLARATION's binding -- mutable, like a `var`
 * (§10.2.11) -- rather than a named function expression's own name, which is immutable. The
 * declaration must have a body: an ambient one is a library global (`eval = 1` is an early
 * SyntaxError in strict code, Test262 `id-eval-strict.js`), not a binding this program owns. */
function assignsFunctionDeclaration(
  source: ts.SourceFile,
  position: number,
  checker: ts.TypeChecker,
): boolean {
  const token = identifierAt(source, position);
  const symbol = token === undefined ? undefined : checker.getSymbolAtLocation(token);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.body !== undefined
  );
}

/** A TS2416 override-incompatibility diagnostic js mode may drop (plan.md §8 step 12(d),
 * plan-notes 68/272): both members are bodied METHODS neither side annotated, so the
 * disagreement comes from inference over unannotated code rather than from a type the user
 * wrote. Anything else keeps STA0012: a field or accessor on either side (a field shares one
 * slot for two types, which no call-widening can defend; an accessor pair has no call
 * widening at all — a getter READ is not a call the method marks cover), an explicit
 * annotation (TS or JSDoc) anywhere on either member, a
 * computed name (the lowering keys call marks by declared name), a missing body (overload,
 * abstract, or ambient — each with its own gate story), or an unresolvable base. Fail closed:
 * the suppression admits a hierarchy the checker proved inconsistent, and only the
 * method-method shape has a lowering defense (per-class vtable entries + widened calls). */
function isInferredMethodOverrideMismatch(
  source: ts.SourceFile,
  position: number,
  checker: ts.TypeChecker,
): { derived: ts.Symbol; base: ts.Symbol } | undefined {
  const member = identifierAt(source, position)?.parent;
  if (member === undefined || !ts.isMethodDeclaration(member)) {
    return undefined;
  }
  const name = member.name;
  if (name === undefined || !ts.isIdentifier(name) || !methodIsUnannotated(member)) {
    return undefined;
  }
  const classDecl = member.parent;
  if (
    classDecl === undefined ||
    (!ts.isClassDeclaration(classDecl) && !ts.isClassExpression(classDecl))
  ) {
    return undefined;
  }
  const baseMember = findBaseMethod(classDecl, name.text, checker);
  if (baseMember === undefined || !methodIsUnannotated(baseMember)) {
    return undefined;
  }
  const baseName = baseMember.name;
  if (baseName === undefined || !ts.isIdentifier(baseName)) {
    return undefined;
  }
  const derivedSymbol = checker.getSymbolAtLocation(name);
  const baseSymbol = checker.getSymbolAtLocation(baseName);
  if (derivedSymbol === undefined || baseSymbol === undefined) {
    return undefined;
  }
  return { derived: derivedSymbol, base: baseSymbol };
}

/** Whether a method declaration carries no user-written type: no return annotation, no
 * parameter annotation, no JSDoc `@returns`/`@param` type. A doc comment with no type is not
 * an annotation — only a type makes the disagreement about something the user wrote. */
function methodIsUnannotated(member: ts.MethodDeclaration): boolean {
  if (member.body === undefined || member.type !== undefined) {
    return false;
  }
  if (member.parameters.some((param) => param.type !== undefined)) {
    return false;
  }
  if (ts.getJSDocReturnType(member) !== undefined) {
    return false;
  }
  return !ts
    .getJSDocCommentsAndTags(member)
    .some((doc) => ts.isJSDocParameterTag(doc) && doc.typeExpression !== undefined);
}

/** The same-named method declaration up the `extends` chain (through aliases), or `undefined`.
 * Only declarations with identifier names qualify — a computed name has no stable spelling for
 * the lowering's call marks. A same-named FIELD or accessor is not a method and does not
 * qualify either (the caller keeps STA0012 for those shapes). */
function findBaseMethod(
  classDecl: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  checker: ts.TypeChecker,
): ts.MethodDeclaration | undefined {
  const heritage = classDecl.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  const baseExpr = heritage?.types[0]?.expression;
  if (baseExpr === undefined) {
    return undefined;
  }
  const baseSymbol = checker.getSymbolAtLocation(baseExpr);
  const baseDecls = baseSymbol?.declarations ?? [];
  for (const baseDecl of baseDecls) {
    if (!ts.isClassDeclaration(baseDecl) && !ts.isClassExpression(baseDecl)) {
      continue;
    }
    for (const baseMember of baseDecl.members) {
      if (
        ts.isMethodDeclaration(baseMember) &&
        baseMember.name !== undefined &&
        ts.isIdentifier(baseMember.name) &&
        baseMember.name.text === name
      ) {
        return baseMember;
      }
    }
    const higher = findBaseMethod(baseDecl, name, checker);
    if (higher !== undefined) {
      return higher;
    }
  }
  return undefined;
}

/** The coercing compound operators: `-=`, `*=`, `/=`, `%=`, `**=`. `+=` concatenates rather
 * than coerces, and the logical and nullish forms assign their right side as-is. */
function isCoercingCompound(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken
  );
}

/** Whether a js-mode 2322 against `symbol` keeps the binding's annotation, so the lowering checks
 * the value at the edge (`STA2001`) instead of widening the binding to Unknown (golden rule 4,
 * plan-notes 301). Only a variable a TypeScript file annotated with a type a tag settles: the
 * annotation is the author's claim, and widening silently discards it, so `const n: number =
 * jsLabel(10)` printed `"10"` from a `number` binding. A `.js` binding keeps the widening -- there
 * the disagreement is ordinary JavaScript (`let x = 1; x = 'a'`) -- and so does an annotation no
 * tag can settle (an object, a union), which only the shape-table path can honor. */
function keepsCheckedAnnotation(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.type !== undefined &&
    hasTypeScriptAnnotation(declaration) &&
    isCheckable(tsTypeToHType(checker.getTypeFromTypeNode(declaration.type), checker))
  );
}

/** Whether a 2322 whose leading identifier is `token` spans an arrow's concise body -- the return
 * edge spelled without `return` (`(): number => jsLabel(4)`). That identifier is a callee or an
 * operand, not an assignment target, so it must not widen: `jsLabel` itself would turn dynamic.
 * The span must be the whole body, because an assignment body (`() => x = v`) starts at the same
 * identifier and its own 2322 spans only `x`. A `return` statement's 2322 starts at the keyword,
 * where `identifierAt` finds nothing (plan-notes 308). */
function isConciseReturnAt(token: ts.Identifier, source: ts.SourceFile, length: number): boolean {
  const start = token.getStart(source);
  let node: ts.Node = token;
  while (
    !ts.isSourceFile(node.parent) &&
    !ts.isArrowFunction(node.parent) &&
    node.parent.getStart(source) === start
  ) {
    node = node.parent;
  }
  while (ts.isParenthesizedExpression(node.parent)) {
    node = node.parent;
  }
  if (!ts.isArrowFunction(node.parent) || node.parent.body !== node) {
    return false;
  }
  let body: ts.Node = node;
  while (ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }
  return body.getEnd() === start + length;
}

/** The identifier a suppressed 2362/2363 assigns through, or `undefined` when the diagnostic is
 * not on a coercing compound assignment's left. `s *= 2` widens `s` (the number result lands in
 * its slot); `s * 2` widens nothing (a read leaves the binding alone); `o.x *= 2` and
 * `a[i] *= 2` widen nothing (a member is not a binding — the place machinery, not the scope,
 * owns its type). Parentheses and `!` are transparent, as they are everywhere else. */
function compoundAssignTarget(token: ts.Identifier): ts.Identifier | undefined {
  let node: ts.Node = token;
  for (;;) {
    const parent = node.parent;
    if (parent === undefined) {
      return undefined;
    }
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) {
      node = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isCoercingCompound(parent.operatorToken.kind)
    ) {
      let target: ts.Expression = parent.left;
      while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target)) {
        target = target.expression;
      }
      return ts.isIdentifier(target) ? target : undefined;
    }
    return undefined;
  }
}

/* The checker refusals js mode drops, because each one refuses an operation the DYNAMIC RUNTIME
 * settles at run time -- not untyped code, which §1.2 already promises never to reject, but valid
 * JavaScript whose answer is a value rather than a type (plan.md §8 steps 2, 2a).
 *
 * Suppressing the CODE and not the OPTION is the whole design. `strictNullChecks: false` (or
 * `noUncheckedIndexedAccess: false`) is program-wide, so in a mixed graph it would strip null
 * safety from the `.ts` half and delete the boundary checks §0.4 requires. Leaving `T | undefined`
 * in the type is the point: the union lowers to the dynamic path and the check still happens, at
 * run time, which is where a dynamic value's check belongs.
 *
 * Nothing in here is a free pass for a REAL refusal — an operation no runtime could settle stays a
 * hard error in both modes, and that is why the list is enumerated rather than ranged.
 *
 * Which refusals stay fatal in js mode (plan-notes 297): every syntactic diagnostic and every
 * JavaScript EARLY error -- the binder and grammar groups of TypeScript's own `plainJSErrors`,
 * which no code here may name (tests/unit/js-early-errors.test.ts reads that list out of the
 * pinned `typescript` and holds this set clear of it). A type-level refusal degrades to the
 * dynamic path only by being listed here, with its run-time answer and a test. Ranging the rule
 * over every semantic code was measured and refused: the lowering trusts JSDoc types and the
 * checker's control flow, so an unlisted refusal compiles to an internal error at best and to a
 * silent miscompile at worst (`const c = 1; c = 2` printed 2 where Node throws a TypeError). */
export const JS_MODE_RUNTIME_CODES: ReadonlySet<number> = new Set([
  // JSDoc's optional-parameter spelling is checker metadata; JavaScript has no corresponding
  // function-signature restriction, so a required parameter may follow it at runtime.
  1016, // A required parameter cannot follow an optional parameter.
  2554, // Expected N arguments, but got M.
  // A spread into fixed parameters: the call passes whatever count the list holds at run time
  // (`jsrt_call_spread_at`), and a parameter past its end reads `undefined`. A TypeScript callee's
  // annotated parameters keep the refusal in the gate instead (plan.md §11c T11.4 step 5).
  2556, // A spread argument must either have a tuple type or be passed to a rest parameter.
  2322, // Type 'X' is not assignable to type 'Y'.
  2345, // Argument of type 'X' is not assignable to parameter of type 'Y'.
  // No overload matches: JavaScript runs the implementation with the runtime value, so in
  // js mode the call dispatches to it dynamically (its signature — a union or `unknown` in
  // practice, hence Unknown — accepts anything the overloads refused; a dynamic argument
  // reaching a checkable parameter takes the existing boundary path). ts mode keeps the
  // refusal (STA0012). Non-overloaded mismatches already run via the 2345 path above.
  2769, // No overload matches this call.
  // Member access and calls through a value the checker could not resolve.
  2339, // Property 'x' does not exist on type 'T'.
  2551, // Property 'x' does not exist on type 'T'. Did you mean 'y'?
  2353, // Object literal may only specify known properties.
  2349, // This expression is not callable.
  // `"" == 0` is not a mistake in JavaScript, it is the coercion table, and running that table is
  // most of what js mode is for. ts mode keeps it: there both operand types are known and disjoint
  // (plan-notes 177).
  2367, // This comparison appears to be unintentional because the types have no overlap.
  2362, // Left-hand side of arithmetic operation must be numeric.
  2363, // Right-hand side of arithmetic operation must be numeric.
  // Same table, spelled for one operand: `1 + undefined` is NaN, not a mistake. Test262 asserts
  // exactly that in `language/expressions/addition/S11.6.1_A3.1_*` (plan-notes 194).
  18050, // The value 'undefined' cannot be used here.
  // `var x = 1; var x = 'a'` is one binding assigned twice -- legal JavaScript, and a redeclaration
  // TypeScript refuses only because it wants one type per name.
  2403, // Subsequent variable declarations must have the same type.
  // A style lint, not a refusal: the comma operator's answer is its right operand either way.
  2695, // Left side of comma operator is unused and has no side effects.
  // A COMMENT cannot refuse a program. JSDoc is checker metadata; the parameter list is the code.
  8024, // JSDoc '@param' tag has name 'X', but there is no parameter with that name.
  8029, // JSDoc '@param' tag has name 'X', ... It would match 'arguments' if it had an array type.
  // Writing through a read-only reference IS the operation `Object.freeze` exists to define, and
  // its answer is a TypeError the runtime now raises as a real Error object -- catchable, with
  // Node's wording and a working `instanceof` (plan.md §8 step 2a(c), plan-notes 195). Before that
  // model existed these two had to stay: a refusal whose runtime answer the runtime could not build
  // is not a refusal js mode may drop.
  // A name nothing declares is not a type error, it is a RUNTIME question, and now that the Error
  // model exists the runtime can answer it: `ReferenceError: x is not defined`, catchable, with
  // Node's wording (plan.md §8 step 2a(c)). This is the largest bucket the sweep left, and it is
  // the one that needed no runtime it did not have -- only somewhere for the answer to come from.
  // 2552 is the same refusal with a spelling suggestion attached.
  2304, // Cannot find name 'X'.
  2552, // Cannot find name 'X'. Did you mean 'Y'?
  2540, // Cannot assign to 'X' because it is a read-only property.
  2704, // The operand of a 'delete' operator cannot be a read-only property.
  // TypeScript refuses `delete` on a REQUIRED property because deleting one would falsify the
  // type; JavaScript's answer is a boolean and a key that is gone. Both codes could only be
  // dropped once the operator existed to answer them (plan.md §8 step 2a(c)): 2704's answer is the
  // frozen-object TypeError `jsrt_delete` raises with Node's wording, and 2790's is the ordinary
  // removal. In `ts` mode 2790 stays a refusal, and that is not an inconsistency -- it is the
  // rule that keeps a fixed shape from being asked to lose a slot it has no encoding for.
  2790, // The operand of a 'delete' operator must be optional.
  // The exactOptionalPropertyTypes family. The option stays ON in both modes -- turning it off is
  // program-wide and would strip the .ts half of a mixed graph of the same guarantee -- but in js
  // mode these three codes refuse ordinary JavaScript: `{ value: undefined }` for a `value?: string`
  // parameter is how Test262's own propertyHelper writes a descriptor, and 2340 of the 7276
  // remaining Test262 failures say it. Unlike 2322/2345 this needs no widening and no coercion,
  // because the disagreement is only over whether `undefined` is a permitted VALUE for an optional
  // property, and `undefined` is a value the runtime already represents in the slot. The absent /
  // present-as-undefined distinction EOPT exists to police survives: the shape model tracks presence,
  // so `{}` and `{ value: undefined }` still differ in `Object.keys` and in `console.log`
  // (tests/golden/js/optional_undefined.js pins exactly that, not just the reads).
  2375, // Type 'X' is not assignable to type 'Y' with 'exactOptionalPropertyTypes: true' (target's properties).
  2379, // Argument of type 'X' is not assignable to parameter of type 'Y' with 'exactOptionalPropertyTypes: true'.
  2412, // Type 'X' is not assignable to type 'Y' with 'exactOptionalPropertyTypes: true' (the target).
  // A computed key of a type that is not string/number/symbol is still a key at run time:
  // Node applies ToPropertyKey coercion (`{ [{}]: 1 }` holds `"[object Object]"`), and the
  // dynamic literal stores through `jsrt_dyn_index_set`, which coerces the same way through
  // `jsrt_to_string` (plan.md §8 step 2a(b)). ts mode keeps the refusal (STA0012).
  2464, // A computed property name must be of type 'string', 'number', 'symbol', or 'any'.
  // An object-typed element key is the READ-side twin of 2464 (plan.md §8 step 44b): `o[kObj]`
  // coerces the key the same way and reads through the dynamic index path, which answers
  // Node's value for every key the runtime can spell (plain objects, arrays, functions all
  // miss to `undefined` unless the coerced name exists; custom `toString` dispatch is the
  // shared Phase-8 ceiling both sides name). Array receivers keep their gate acceptance; fixed
  // shapes route dynamic (the gate + lowering pair beside this). ts mode keeps the refusal
  // (STA0012). Boolean/null keys fire this code too, and stay loud on arrays only through the
  // runtime's canonical-index read, which misses where `jsrt_to_number` used to hit.
  2538, // Type 'X' cannot be used as an index type.
  // Duplicate data-property keys in an object literal are legal JavaScript — last wins — and
  // §1.2 says js mode never rejects untyped code; the diagnostic is tsc's grammar check, not a
  // type error (plan.md §8 step 26). The lowering pushes one entry per written property and the
  // emitter stores in source order into one slot, so the last write wins on its own; the verifier
  // covers the shape by name, not by position. ts mode keeps the refusal (STA0012). Duplicate
  // METHODS, duplicate accessors, and mixed property/accessor duplicates are different checker
  // codes (2300, 1118, 1119) and stay refused in both modes. One shape stays refused in js mode
  // too: duplicate `__proto__` DATA properties are an early SyntaxError (spec B.3.1 — Node
  // answers "Duplicate __proto__ fields are not allowed in object literals"), so 1117 on a
  // `__proto__` name is never swallowed — see isDuplicateProtoDataProperty at the suppression
  // site below. A computed key, a shorthand, a method, or a spread beside a data `__proto__`
  // is legal (last wins) and stays on the dynamic path.
  1117, // An object literal cannot have multiple properties with the same name.
  // A spread overwriting an explicit key (`{ b: 9, ...o }` where `o` has `b`) is legal
  // JavaScript — last wins — and the lowering already expands the spread into one read per
  // field stored in source order into one slot, so the spread's write wins on its own exactly
  // as Node answers it. The reverse order (`{ ...o, a: 7 }`) never errored: only the
  // OVERWRITTEN usage is diagnosed, never the winner. ts mode keeps the refusal (STA0012).
  2783, // 'X' is specified more than once, so this usage will be overwritten.
  // The possibly-null family: 3855 of Task 6.1's 10,513 Test262 failures, the largest bucket by a
  // factor of three, and every one of them ordinary JavaScript that runs (plan-notes 176, 180).
  // `xs[i].toFixed(2)` is how JavaScript indexes an array; the spec's answer for the miss is a
  // TypeError at run time, which is a fact about the value and not a reason to refuse the program.
  2531, // Object is possibly 'null'.
  2532, // Object is possibly 'undefined'.
  2533, // Object is possibly 'null' or 'undefined'.
  2721, // Cannot invoke an object which is possibly 'null'.
  2722, // Cannot invoke an object which is possibly 'undefined'.
  2723, // Cannot invoke an object which is possibly 'null' or 'undefined'.
  18047, // 'x' is possibly 'null'.
  18048, // 'x' is possibly 'undefined'.
  18049, // 'x' is possibly 'null' or 'undefined'.
  // Definite assignment (slice 2454): an uninitialized annotated binding's runtime value
  // IS `undefined` -- this is not TDZ (true syntactic TDZ is 2448, unmodelled). The binding is
  // widened to Unknown below so no use trusts the annotation; every use then takes the dynamic
  // path (reads, index, calls) or a null-validated static one (array ops via STA2008).
  2454, // Variable 'X' is used before being assigned.
  // Unknown-iterable `for-of` (slice 2488, plan.md §8 step 2a(c)): `for (const x of u)` where `u`
  // is Unknown, a union, or any other type without a static walk is ordinary JavaScript with an
  // exact runtime answer -- the GetIterator dispatch (`jsrt_get_iterator`) boxes collections,
  // drives generators and stored iterators, calls a user-iterable method, and throws Node's
  // catchable `TypeError` for the rest. Like the suppressed-2349 call of plan.md §8 step 37, a
  // statically-known non-iterable (a number, `undefined`) compiles to that same runtime throw
  // rather than a compile error. ts mode keeps the refusal (STA0012).
  2488, // Type 'X' must have a '[Symbol.iterator]()' method that returns an iterator.
  // A function declaration's binding is as writable as a `var` (§10.2.11 step 36 instantiates it
  // with a mutable binding), and assigning it is how compiled namespace IIFEs publish their
  // object: `function log() {}` then `(function (log2) { ... })(log = Debug.log || (Debug.log =
  // {}))`, the shape TypeScript's own `_tsc.js` emits (plan-notes 297). The binding is widened
  // below like a 2322 target, so its slot holds the function and then whatever replaces it. ts
  // mode keeps the refusal (STA0012).
  2630, // Cannot assign to 'X' because it is a function.
  // `{ ...v }` where `v` is not an object type: §13.2.5.5 CopyDataProperties skips `undefined`
  // and `null` and copies a primitive's own enumerable keys (a string's indices, nothing for a
  // number or boolean), so every operand has an answer. The checker refuses it, and the literal
  // then types as `any`; a dynamic literal folds such an operand through the shape-table
  // `assign` that already copies an array spread (plan.md §8 step 12(c)). ts mode keeps the
  // refusal (STA0012).
  2698, // Spread types may only be created from object types.
  // An ordinary function is a constructor (§10.2.4 MakeConstructor), and `new F()` where `F`
  // returns an object answers that object (§10.2.2 [[Construct]] step 10), so a non-void return
  // is how a factory-style constructor is written. Replacing `F.prototype` after reading it is
  // the same idiom's other half: the read sees the auto-created prototype, the write replaces
  // it for later `new F()` -- both have exact runtime answers (`construct_function`,
  // docs/VALUE.md §4.20). ts mode keeps the refusal (STA0012; plan-notes 310, family 4).
  2350, // Only a void function can be called with the 'new' keyword.
  2565, // Property 'X' is used before being assigned.
  // Two `export *` re-exports binding one name differently: ES makes the name AMBIGUOUS, which
  // drops it from the namespace and makes importing it by name a SyntaxError -- not an error at
  // the `export *` itself (§16.2.1.6.3 ResolveExport). The namespace type drops the name
  // (`ambiguousStarExports`) and the gate refuses a by-name import of it (STA3003), so nothing
  // the checker would have caught gets through. ts mode keeps the refusal (STA0012;
  // plan-notes 302).
  2308, // Module 'X' has already exported a member named 'Y'. Consider explicitly re-exporting...
]);

/** Checker refusals Stator answers with exact runtime semantics in BOTH modes, unlike the
 * js-only set above. A `for-in` enumerates keys, and strings and arrays HAVE keys: tsc's 2407
 * is a lint-grade refusal of programs with exact runtime answers (plan.md §8 step 38). The
 * `for-in` desugar reads through the total `forInKeys` entry — objects, arrays and strings
 * enumerate, every other primitive answers an empty list — so no suppressed diagnostic can
 * resurface as a runtime abort, and a statically-unknown receiver is dynamic rather than
 * refused (§1.2). The ts-mode contract tension (tsc rejects what Stator compiles) is recorded
 * in plan-notes 257. */
export const BOTH_MODES_RUNTIME_CODES: ReadonlySet<number> = new Set([
  2407, // The right-hand side of a 'for...in' statement must be of type 'any', an object type...
]);

/** Source text the program reads instead of the disk (plan.md §11d T12.1 step 3): the vendor
 * bundle as one virtual module, and the project files whose package imports were rewritten to
 * name it. `key` is the sha256 of the bundle's code, so the program cache (Task 6.9, T12.1 step 6)
 * misses when a bundle changed even though the entry did not. On-disk imports are a separate
 * hash (T20): an edit to a local dependency misses too. */
export interface ProgramOverlay {
  readonly files: ReadonlyMap<string, string>;
  readonly key: string;
  /** A file whose type-checker errors are not reported: the vendor module (plan-notes 320 Q4).
   * It is package code, untyped JavaScript on the dynamic path that the user cannot edit, so a
   * checker complaint there must not fail the build (`isUncheckedVendorError`). Every Stator
   * verdict -- the gate, the edges, the lowering -- still applies to it. */
  readonly unchecked?: string;
}

/** The sha256 the cache keys on: entry bytes, and a vendor bundle's code. */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Last in-process `createProgram` results for an unchanged entry.
 *
 * Keyed by absolute entry path + mode + platform + entry CONTENT hash + the overlay's key (the
 * vendor bundle's sha256, empty without one) + a hash of every other on-disk source file the
 * program loaded. v0 invalidates on bytes, not mtime: test262 stages thousands of tests through
 * a handful of slot-reused temp paths, so (path, mtime) can repeat for different contents on a
 * coarse-tick filesystem and serve a stale program under the wrong test's name (plan-notes 245).
 * A dependency edit misses even when the entry is untouched. That dependency hash is the key a
 * later watch mode must keep using; default libs are omitted (they are the compiler's, not the
 * program's) and overlay files are omitted (their bytes are the overlay key, and a vendor module
 * is not on disk). Custom `host` (in-memory CompilerHost tests) always bypasses the cache.
 *
 * Two slots: a graph that imports a package loads twice per build — once to find the imports,
 * once over the bundle — and one slot would evict each with the other. */
interface ProgramCacheEntry {
  readonly absEntry: string;
  readonly mode: Mode;
  readonly node: boolean;
  readonly contentHash: string;
  readonly overlayKey: string;
  /** On-disk source files folded into `dependencyHash`, entry and overlay files excluded. */
  readonly dependencyPaths: readonly string[];
  readonly dependencyHash: string;
  readonly result: LoadedProgram;
}

export interface LoadedProgram {
  readonly program: ts.Program;
  readonly diagnostics: Diagnostic[];
  /** The PARSE-phase subset of `diagnostics`: the parser's, the binder's (a duplicate or
   * strict-mode-reserved binding) and Stator's own early errors (`STA3005`). Test262 calls these
   * phase `parse`; a build that has one reports them before any bundle step runs, because no
   * bundle can make the source parse (plan.md §9 Task 6.29). */
  readonly parseDiagnostics: readonly Diagnostic[];
  readonly runtimeDynamicSymbols: ReadonlySet<ts.Symbol>;
}

/** `file:start:code` of every parser and binder diagnostic in the program. The binder's list is
 * internal to `typescript` (`SourceFile.bindDiagnostics`, filled once the checker has bound the
 * file); tests/unit/bundler.test.ts pins that the pinned release still keeps it there, and a
 * release without it degrades to the parser's list rather than failing. */
function parsePhaseKeys(program: ts.Program): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const file of program.getSourceFiles()) {
    const bound: unknown = Reflect.get(file, 'bindDiagnostics');
    const binder = Array.isArray(bound) ? bound.filter(isTsDiagnostic) : [];
    for (const diag of [...program.getSyntacticDiagnostics(file), ...binder]) {
      keys.add(diagnosticKey(diag));
    }
  }
  return keys;
}

function isTsDiagnostic(value: unknown): value is ts.Diagnostic {
  return typeof value === 'object' && value !== null && 'code' in value && 'messageText' in value;
}

function diagnosticKey(diag: ts.Diagnostic): string {
  return `${diag.file?.fileName ?? ''}:${String(diag.start ?? -1)}:${String(diag.code)}`;
}

/** Absolute forward-slash path, the form TypeScript stores on `SourceFile.fileName`. */
function cachePath(name: string): string {
  return resolve(name).replace(/\\/g, '/');
}

/** True when `overlay` already supplies this file's text, so its disk bytes are not a key. */
function coveredByOverlay(fileName: string, overlay: ProgramOverlay | undefined): boolean {
  if (overlay === undefined) {
    return false;
  }
  return overlay.files.has(fileName) || overlay.files.has(cachePath(fileName));
}

/** Source files whose bytes must participate in the cache key: everything the program loaded
 * except the entry (its own hash), default libs, and overlay files. Sorted so the hash does
 * not depend on compiler iteration order. */
function dependencyPathsOf(
  program: ts.Program,
  absEntry: string,
  overlay: ProgramOverlay | undefined,
): readonly string[] {
  const paths: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) {
      continue;
    }
    const name = cachePath(file.fileName);
    if (name === absEntry || coveredByOverlay(file.fileName, overlay)) {
      continue;
    }
    paths.push(name);
  }
  paths.sort();
  return paths;
}

/** sha256 of `path + content` for each path, or `undefined` when any file cannot be read
 * (a deleted dependency is a cache miss, never a stale hit). */
function hashDependencyFiles(paths: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      parts.push(`${path}\0${sha256(readFileSync(path))}`);
    } catch {
      return undefined;
    }
  }
  return sha256(parts.join('\n'));
}

const PROGRAM_CACHE_SLOTS = 2;
let programCache: ProgramCacheEntry[] = [];

/** Drop the cached `ts.Program` (tests that mutate files under a reused entry need this). */
export function clearProgramCache(): void {
  programCache = [];
}

/** Build a ts.Program from an entry file, using Stator-owned compilerOptions.
 * Stator owns strict family + noEmit; user's tsconfig.json is ignored for these.
 * Returns the program and any diagnostics emitted during program construction.
 *
 * `host` is the seam for tests (plan-notes 187): unit suites can back programs with an
 * in-memory CompilerHost through it. Omitted means ts.sys against the real disk — the ONLY
 * mode the shipped compiler runs in, since every production call passes no host. `overlay`
 * lays virtual text over either.
 *
 * `node` is the `--node` platform (plan.md §11c T11.5): Node built-ins resolve to `packages/node`
 * (`./node.ts`). Like the mode, it is a frontend policy nothing below the gate reads.
 *
 * Unchanged re-builds of the same absolute entry+mode+platform+overlay reuse the previous `ts.Program`
 * when the entry's bytes and every on-disk dependency's bytes are unchanged (see `clearProgramCache`). */
export function createProgram(
  entryFile: string,
  mode: Mode,
  host?: ts.CompilerHost,
  overlay?: ProgramOverlay,
  node = false,
): LoadedProgram {
  // Custom hosts (in-memory) have no meaningful disk mtime; never cache those.
  if (host === undefined) {
    const absEntry = cachePath(entryFile);
    const overlayKey = overlay?.key ?? '';
    // Hash, not mtime: one small-file read is noise against a ~380 ms frontend, and it closes
    // the stale-hit hole for slot-reused temp paths airtightly instead of by timestamp luck.
    let contentHash: string | undefined;
    try {
      contentHash = sha256(readFileSync(absEntry));
    } catch {
      contentHash = undefined;
    }
    const hit = programCache.find(
      (entry) =>
        entry.absEntry === absEntry &&
        entry.mode === mode &&
        entry.node === node &&
        entry.contentHash === contentHash &&
        entry.overlayKey === overlayKey &&
        hashDependencyFiles(entry.dependencyPaths) === entry.dependencyHash,
    );
    if (contentHash !== undefined && hit !== undefined) {
      return hit.result;
    }
    const result = createProgramUncached(entryFile, mode, host, overlay, node);
    if (contentHash !== undefined) {
      const dependencyPaths = dependencyPathsOf(result.program, absEntry, overlay);
      const dependencyHash = hashDependencyFiles(dependencyPaths);
      // An unreadable dependency is not cached: the next call rebuilds rather than replaying
      // a program whose graph we could not re-check.
      if (dependencyHash !== undefined) {
        programCache = [
          {
            absEntry,
            mode,
            node,
            contentHash,
            overlayKey,
            dependencyPaths,
            dependencyHash,
            result,
          },
          ...programCache,
        ].slice(0, PROGRAM_CACHE_SLOTS);
      }
    }
    return result;
  }
  return createProgramUncached(entryFile, mode, host, overlay, node);
}

/** `base`, with `files` served from memory: the vendor module exists nowhere on disk, and a
 * rewritten project file must be read as rewritten. Everything else passes through. */
function overlayHost(base: ts.CompilerHost, files: ReadonlyMap<string, string>): ts.CompilerHost {
  const normal = (name: string): string => resolve(name).replace(/\\/g, '/');
  return {
    ...base,
    fileExists: (name) => files.has(normal(name)) || base.fileExists(name),
    readFile: (name) => files.get(normal(name)) ?? base.readFile(name),
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      const text = files.get(normal(name));
      return text === undefined
        ? base.getSourceFile(name, languageVersion, onError, shouldCreate)
        : ts.createSourceFile(name, text, languageVersion, true);
    },
  };
}

/** `ts.getPreEmitDiagnostics`, with the checker's stack overflow named as STA0013 instead of
 * falling through to the CLI's STA4072 catch-all. TypeScript infers an unannotated return type on
 * demand, nesting one inference (about thirty JS frames) per link, and re-enters functions whose
 * inference is still in progress. A long enough chain exhausts the default V8 stack: TypeScript
 * 6.0.3's own `_tsc.js` in js mode peaks at 360 nested inferences, and plain `tsc` dies on it too
 * (plan-notes 287, which also measures why no order of pre-computing return types bounds it). The
 * checker's state is unusable after the throw, so this ends the build rather than skipping files.
 * Matched on the call-stack message so any other RangeError stays a compiler bug. */
function preEmitDiagnostics(program: ts.Program): readonly ts.Diagnostic[] {
  try {
    return ts.getPreEmitDiagnostics(program);
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      throw new BuildError(
        'STA0013',
        'the TypeScript checker ran out of stack type-checking this program (plain `tsc` fails on ' +
          'it too) — return-type annotations on long chains of functions that infer their return ' +
          'types from each other shorten its inference',
      );
    }
    throw error;
  }
}

function createProgramUncached(
  entryFile: string,
  mode: Mode,
  host: ts.CompilerHost | undefined,
  overlay: ProgramOverlay | undefined,
  node: boolean,
): LoadedProgram {
  // Stator owns these options — strict family on, noEmit true
  const compilerOptions: ts.CompilerOptions = {
    // Strict mode (Stator's policy)
    strict: true,
    // js mode's whole contract is that untyped code is never rejected -- an unannotated parameter
    // is not an error there, it is the request for a dynamic value. `strict` would turn it into a
    // hard error before the gate ever runs, so js mode opts back out; ts mode keeps it, and the
    // gate reports implicit any as STA1001 with a mode-aware message instead of tsc's.
    noImplicitAny: mode === 'ts',
    // `this` in a plain function is per-function dynamic, not program-wide: in js mode the call
    // site passes its receiver or nothing, and the lowering binds it as an Unknown parameter zero
    // (docs/VALUE.md §4.16 `has_receiver`; a bare call answers `undefined`, which is the honest
    // answer because emitted modules are always strict ESM, never sloppy-global). Flipping the
    // OPTION is correct here, beside `noImplicitAny` above, rather than suppressing code 2683:
    // suppressing the code would silence the checker but leave `this: any` for the gate to
    // reclassify as STA1214, while the option gives the lowering the dynamic type to work with.
    // ts mode keeps it: there an unannotated `this` is a compile error (STA0012).
    noImplicitThis: mode === 'ts',
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    // Same contract, one rung further along: in js mode `noImplicitOverride` would demand a JSDoc
    // `@override` tag on every overriding method, which rejects ordinary JavaScript for having no
    // annotation. ts mode keeps it -- there the modifier is real syntax, and an accidental override
    // is exactly the mistake a vtable makes silent.
    noImplicitOverride: mode === 'ts',
    // Same contract again, for two checks that reject VALID JavaScript rather than untyped
    // JavaScript. Deliberate switch fallthrough is a JS idiom, and `catch (e) { e.name }` reads a
    // property off a value the language hands you untyped; in js mode the catch variable is a
    // dynamic value like any other and the read is settled at run time. ts mode keeps both -- there
    // a fallthrough is almost always a missing `break`, and an `unknown` catch is the boundary rule
    // of §0.2. Found by the Test262 harness, which is ordinary ES5 and used both (plan-notes 175).
    noFallthroughCasesInSwitch: mode === 'ts',
    useUnknownInCatchVariables: mode === 'ts',
    // Deliberately NOT noUnusedLocals/noUnusedParameters. Those are style checks: they change
    // nothing about what a type means, so nothing downstream depends on them, and switching them
    // on would make Stator reject correct programs -- `function f(a, b) { return a; }` is valid
    // TypeScript. The locked tsconfig in plan §4 that carries them governs Stator's own source,
    // not the source Stator compiles; the two are different policies (notes #47).
    isolatedModules: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,

    // Module system (ESM only, plan §1). NOT NodeNext: NodeNext classifies a file by the nearest
    // package.json's "type" field and calls it CommonJS by default, so a bare directory of .ts
    // files could not use `import` at all. Stator compiles ESM regardless of packaging metadata --
    // Force makes every file a module, Bundler resolves relative specifiers without consulting
    // package.json, and the gate holds Node's own rule that a relative specifier names its file
    // extension (STA1113), which Bundler alone would not enforce.
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    // `std/<name>` resolves to the std package's own source (plan.md §11c T11.2). On the options
    // rather than in a custom host so every resolution reads one mapping (the module graph asks
    // the checker, T12.1); an unknown name is refused by `classifyStdSpecifier`, never here.
    // `--node` adds the Node built-ins the same way (`./node.ts`).
    paths: node ? { ...stdPathMapping(), ...nodePathMapping() } : stdPathMapping(),

    // Target and libs. `lib` takes FILE names, not the tsconfig shorthand: "es2025" resolves to
    // nothing and silently leaves the program without Array, Object, or any other global type.
    //
    // The lib describes the JAVASCRIPT the differential ground truth implements -- the pinned Node
    // in `.node-version` -- and NOT the subset Stator has landed. Those are different jobs: the
    // gate is what states the subset, and its answer for a member the compiler does not do yet is
    // `STA1214`, which names the delivering phase. Under too low a lib the same program gets a type
    // error telling the user to change a `lib` option they do not own (plan-notes 99).
    target: ts.ScriptTarget.ES2025,
    lib: ['lib.es2025.d.ts'],

    // No emit — we generate our own C
    noEmit: true,

    // `allowJs` is on in BOTH modes so a `.js` file actually enters the program. ts mode still
    // rejects every one at the gate (`STA1002`); without this, tsc DROPS the file and answers
    // `STA0012` "enable the 'allowJs' option", which is the wrong code and the wrong hint — the
    // user does not want a compiler flag, they want `--mode=js` (plan.md §8 step 2). `checkJs`
    // stays js-mode-only: ts mode must not type-check a file it is about to refuse.
    allowJs: true,
    checkJs: mode === 'js',

    // Utility options
    sourceMap: true,
    skipLibCheck: true,
  };

  // Stator's globals are a root file, not a `lib`: they describe what `libjsrt.a` provides, and a
  // compiled program has neither Node's globals nor the DOM's.
  const globals = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'stator.globals.d.ts');
  // The entry is made absolute BEFORE the program sees it: with a relative root, the file's
  // `fileName` stays relative while `ts.resolveModuleName` answers with absolute paths, so every
  // import edge silently fails the `getSourceFile` lookup and the module graph loses its
  // dependencies -- legal multi-file source then dies as STA4035 in the lowering. Forward slashes
  // because that is the separator TypeScript normalizes every fileName to.
  const nodeGlobals = node ? nodeGlobalsFile() : undefined;
  const program = ts.createProgram(
    [
      globals,
      ...(nodeGlobals === undefined ? [] : [nodeGlobals]),
      resolve(entryFile).replace(/\\/g, '/'),
    ],
    compilerOptions,
    overlay === undefined
      ? host
      : overlayHost(host ?? ts.createCompilerHost(compilerOptions), overlay.files),
  );
  const diagnostics: Diagnostic[] = [];
  const parseDiagnostics: Diagnostic[] = [];
  const runtimeDynamicSymbols = new Set<ts.Symbol>();

  // Surface TypeScript's own diagnostics as Stator diagnostics
  const tsDiagnostics = preEmitDiagnostics(program);
  const parsePhase = parsePhaseKeys(program);
  for (const diag of tsDiagnostics) {
    // A free `__filename` or `__dirname` is the gate's STA1110 (plan-notes 316), in both modes:
    // the checker's "cannot find name" would make it an STA0012 type error in ts mode and silent
    // in js mode, where Node either defines it (CommonJS) or throws. The vendor module's reads
    // never get here: under `--node` the frontend rewrites them (`location.ts`).
    if (isNodePathGlobalRead(diag)) {
      continue;
    }
    // Duplicate `__proto__` data properties are the one 1117 js mode keeps: an early
    // SyntaxError (spec B.3.1), not last-wins JavaScript — see isDuplicateProtoDataProperty.
    const keepProtoRefusal =
      mode === 'js' &&
      diag.code === 1117 &&
      diag.file !== undefined &&
      diag.start !== undefined &&
      isDuplicateProtoDataProperty(diag.file, diag.start);
    // TS2630 also names a named function EXPRESSION's own name (`function imm() { imm = 1; }`),
    // whose binding is immutable (§15.2.5): the write is a TypeError in strict code and is
    // ignored in sloppy code, so widening it would compile a write JavaScript never performs.
    // Only a function DECLARATION's binding is writable, so only that one drops (plan-notes 297).
    const keepFunctionNameRefusal =
      diag.code === 2630 &&
      !(
        diag.file !== undefined &&
        diag.start !== undefined &&
        assignsFunctionDeclaration(diag.file, diag.start, program.getTypeChecker())
      );
    // TS2416 override widening (plan.md §8 step 12(d), plan-notes 272): an inferred
    // method-method disagreement is legal JavaScript with per-class vtable entries, so js mode
    // drops the refusal — but both declarations' CALLS must stop trusting one side's return,
    // or a base-typed read of a derived instance answers garbage. Seeding names the
    // declarations; the lowering's returns edge widens the calls (the step-45 shape, which
    // leaves the declarations — the overload and vtable contracts — untouched). Any other
    // 2416 shape keeps STA0012.
    let overrideWidened = false;
    if (
      mode === 'js' &&
      diag.code === 2416 &&
      diag.file !== undefined &&
      diag.start !== undefined
    ) {
      const pair = isInferredMethodOverrideMismatch(
        diag.file,
        diag.start,
        program.getTypeChecker(),
      );
      if (pair !== undefined) {
        runtimeDynamicSymbols.add(pair.derived);
        runtimeDynamicSymbols.add(pair.base);
        overrideWidened = true;
      }
    }
    if (
      !keepProtoRefusal &&
      !keepFunctionNameRefusal &&
      (overrideWidened ||
        BOTH_MODES_RUNTIME_CODES.has(diag.code) ||
        (mode === 'js' && JS_MODE_RUNTIME_CODES.has(diag.code)))
    ) {
      // An inferred binding that TypeScript says has an incompatible assignment must be dynamic
      // throughout lowering. The diagnostic starts at the assignment target, whose symbol is the
      // one binding the HIR verifier otherwise (correctly) keeps monomorphic. 2403 is the same
      // disagreement spelled as a redeclaration (`var x = 1; var x = 'a'`) rather than as an
      // assignment, and it needs the same widening -- without it the suppression turns a checker
      // refusal into an STA4004 internal error (plan-notes 194).
      // 2630 is the same widening for a function declaration's binding (plan-notes 297).
      if (
        (diag.code === 2322 ||
          diag.code === 2403 ||
          diag.code === 2630 ||
          diag.code === 2362 ||
          diag.code === 2363 ||
          diag.code === 2454) &&
        diag.file !== undefined &&
        diag.start !== undefined
      ) {
        const token = identifierAt(diag.file, diag.start);
        // A plain incompatible assignment widens its target; a coercing compound assignment
        // (`s *= 2` — the result is a number whatever `s` held) must widen its target the same
        // way, or the lowering's number-typed value meets a string-typed slot as STA4004
        // (plan.md §8 step 37). A pure binary (`s * 2`) only READS `s`, so only a diagnostic on
        // the compound's left widens; anything else keeps the binding it declared.
        // A 2454 use-before-assignment widens the USED binding itself: the diagnostic sits on a
        // read, and its symbol is the declaration's -- the slot starts as `undefined`
        // (JSRT_FRAME fills every slot with it), so every use must go dynamic rather than trust
        // the annotation (the 2403 rule: the admitted program must still compile).
        const target =
          diag.code === 2322 || diag.code === 2403 || diag.code === 2454 || diag.code === 2630
            ? token
            : token === undefined
              ? undefined
              : compoundAssignTarget(token);
        const checker = program.getTypeChecker();
        const symbol =
          target === undefined ||
          (diag.code === 2322 && isConciseReturnAt(target, diag.file, diag.length ?? 0))
            ? undefined
            : checker.getSymbolAtLocation(target);
        if (
          symbol !== undefined &&
          !(diag.code === 2322 && keepsCheckedAnnotation(symbol, checker))
        ) {
          runtimeDynamicSymbols.add(symbol);
        }
      }
      continue;
    }
    const edge = edgeRefusal(diag, mode, node);
    if (edge === 'gate') {
      continue;
    }
    if (edge !== undefined) {
      diagnostics.push(edge);
      continue;
    }
    const file = diag.file;
    if (file === undefined) {
      // File-less diagnostic (e.g., "tsconfig.json not found")
      diagnostics.push(
        diagnosticFromFile(
          '<unknown>',
          1,
          1,
          'STA0012',
          'error',
          mode,
          ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
        ),
      );
    } else if (isUncheckedVendorError(diag, file, overlay)) {
      // The binding the complaint is about stops trusting its inferred type, the 2322 widening
      // above: skipping the error alone would hand the lowering a type the code breaks (STA4004).
      const token = identifierAt(file, diag.start ?? 0);
      const symbol =
        token === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(token);
      if (symbol !== undefined) runtimeDynamicSymbols.add(symbol);
    } else {
      // Diagnostic has a location
      const { line, character } = file.getLineAndCharacterOfPosition(diag.start ?? 0);
      const located = diagnosticFromFile(
        file.fileName,
        line + 1,
        character + 1,
        'STA0012',
        'error',
        mode,
        ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
        {
          start: diag.start ?? 0,
          length: (diag.length ?? 0) > 0 ? (diag.length ?? 0) : 1,
        },
      );
      diagnostics.push(located);
      if (parsePhase.has(diagnosticKey(diag))) parseDiagnostics.push(located);
    }
  }
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    for (const name of strictReservedImports(file)) {
      const { line, character } = file.getLineAndCharacterOfPosition(name.getStart(file));
      const early = diagnosticFromFile(
        file.fileName,
        line + 1,
        character + 1,
        'STA3005',
        'error',
        mode,
        `'${name.text}' cannot be an imported binding: a module is strict code`,
        { start: name.getStart(file), length: name.text.length },
      );
      diagnostics.push(early);
      parseDiagnostics.push(early);
    }
  }

  return { program, diagnostics, parseDiagnostics, runtimeDynamicSymbols };
}

/** Checker codes in the vendor module that stay reported: where the checker sees one, Node
 * throws at run time (a binding read in its temporal dead zone, an assignment to a `const`), and
 * the compiled program would not -- the lowering refuses the first and would silently perform the
 * second. Measured on the pinned Node (plan-notes 320 Q4). */
const VENDOR_THROW_CODES: ReadonlySet<number> = new Set([
  2448, // Block-scoped variable 'x' used before its declaration.
  2449, // Class 'X' used before its declaration.
  2450, // Enum 'X' used before its declaration.
  2588, // Cannot assign to 'x' because it is a constant.
]);

/** A type-checker complaint about the vendor module that is not reported (plan-notes 320 Q4,
 * docs/BUNDLER.md §6): package code is untyped JavaScript on the dynamic path. Codes below 2000
 * are syntax and grammar errors, which Node raises too. */
function isUncheckedVendorError(
  diag: ts.Diagnostic,
  file: ts.SourceFile,
  overlay: ProgramOverlay | undefined,
): boolean {
  return (
    file.fileName === overlay?.unchecked && diag.code >= 2000 && !VENDOR_THROW_CODES.has(diag.code)
  );
}

/** Checker codes for a name or module nothing declares. TypeScript answers a Node built-in
 * specifier and the name `require` with the two "install type definitions for node" spellings
 * (2580, 2591) rather than 2307/2304. */
const UNRESOLVED_MODULE_CODES: ReadonlySet<number> = new Set([2307, 2580, 2591]);
const UNRESOLVED_NAME_CODES: ReadonlySet<number> = new Set([2304, 2580, 2591]);

/** The module-edge refusals a checker diagnostic stands for, or `'gate'` when the gate owns the
 * answer and the checker's must not be reported beside it.
 *
 * TS2307 ("cannot find module") on a `std/…` specifier is the std edge's refusal, not a checker
 * error: `std/foo` resolves to no file because no such module exists (STA3002), or because it is
 * a threads module that has not landed (STA1214, Phase 10) — the same answer the gate gives a
 * specifier that did resolve (gate.ts `gateImport`), so the code never depends on whether a
 * stray file happens to sit where the mapping looked. TS2305/TS2724/TS2614 ("has no exported
 * member") on a std module's Promise twin (`readTextAsync` from `std/fs`) is the same kind of refusal:
 * the member waits for T10.2 (T10.1 step 5). A Node built-in is the platform edge's (`./node.ts`):
 * without `--node` it names the flag, and under it an unlanded module or member names T11.6.
 *
 * An unresolved `require` is the gate's: it rules on `require` in every file, including the `.js`
 * ones where the checker binds the name itself and reports nothing. */
function edgeRefusal(
  diag: ts.Diagnostic,
  mode: Mode,
  node: boolean,
): Diagnostic | 'gate' | undefined {
  const file = diag.file;
  if (file === undefined || diag.start === undefined) {
    return undefined;
  }
  const start = diag.start;
  if (
    UNRESOLVED_NAME_CODES.has(diag.code) &&
    file.text.slice(start, start + (diag.length ?? 0)) === 'require'
  ) {
    return 'gate';
  }
  const std = edgeRefusalFor(diag.code, file, start, diag.length ?? 0, node);
  if (std === undefined || std.kind === 'module') {
    return undefined;
  }
  const { line, character } = file.getLineAndCharacterOfPosition(start);
  const span = { start, length: diag.length ?? 1 };
  const notYet = std.kind === 'not-yet';
  return diagnosticFromFile(
    file.fileName,
    line + 1,
    character + 1,
    std.code,
    notYet ? 'not-yet' : 'error',
    mode,
    std.message,
    span,
    notYet ? std.phase : undefined,
  );
}

/** "Module has no exported member": TS2305 plainly, TS2724 with a near-miss name, TS2614 when the
 * module has a default export the name might have meant (`node:path`'s module object does). */
const MISSING_MEMBER_CODES: ReadonlySet<number> = new Set([2305, 2724, 2614]);

/** What the std and Node edges say about a checker diagnostic at `start`: an unresolved-module
 * code names a specifier, a missing-member code a member of one. */
function edgeRefusalFor(
  code: number,
  file: ts.SourceFile,
  start: number,
  length: number,
  node: boolean,
): StdSpecifier | NodeNotYet | undefined {
  const literal = file.text.slice(start, start + length);
  if (UNRESOLVED_MODULE_CODES.has(code) && /^["']/.test(literal)) {
    const specifier = literal.slice(1, -1);
    return classifyStdSpecifier(specifier) ?? classifyNodeSpecifier(specifier, node);
  }
  if (MISSING_MEMBER_CODES.has(code)) {
    const specifier = moduleSpecifierAt(file, start);
    return specifier === undefined
      ? undefined
      : (classifyStdMember(specifier, literal) ?? classifyNodeMember(specifier, literal, node));
  }
  return undefined;
}

/** The module specifier of the top-level import or re-export whose text holds `position`. */
function moduleSpecifierAt(file: ts.SourceFile, position: number): string | undefined {
  for (const statement of file.statements) {
    if (position < statement.pos || position >= statement.end) continue;
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return statement.moduleSpecifier.text;
    }
    return undefined;
  }
  return undefined;
}

/** Format and print diagnostics for user output. */
export function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diag of diagnostics) {
    process.stderr.write(`${renderDiagnostic(diag)}\n`);
  }
}
