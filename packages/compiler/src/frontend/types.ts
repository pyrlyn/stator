import * as ts from 'typescript';
import { ERROR_CLASSES, errorHType } from '../hir/nodes.ts';
import type { HField, HType } from '../hir/types.ts';
import {
  ambiguousStarExports,
  DEFAULT_EXPORT_BINDING,
  isDefaultExportDeclaration,
  namespaceModule,
} from './modules.ts';
import {
  accessorName,
  accessorProperty,
  H_BOOLEAN,
  H_DATE,
  H_NULL,
  H_NUMBER,
  H_REGEXP,
  H_STRING,
  H_UNDEFINED,
  hArray,
  hFunction,
  hIterator,
  hMap,
  hObject,
  hPromise,
  hSet,
  hasTypeParam,
  hTypeEquals,
  hTypeName,
  hTypeParam,
  hUnknown,
  specializationName,
  substituteHType,
} from '../hir/types.ts';

/** A function type may refer to itself (`type F = () => F`), so the descent needs a stop. Four is
 * past anything a real signature nests and cheap enough to never think about again; beyond it the
 * answer is Unknown, which is always a safe answer, never a wrong one. */
const MAX_SIGNATURE_DEPTH = 4;

/** An opaque branded-pointer handle (`{ readonly __brand: 'sqlite3' }`, docs/FFI.md §2):
 * library-owned, crossing as `void *` — never dereferenced and never retained past the call.
 * Only object types qualify, and only the documented single-literal shape: a wider object is
 * a different type, whatever it names its fields. (Moved here from `extern.ts`: `tsTypeToHType`
 * below must recognize `Out<T>` inners, and `extern.ts` already imports from this module —
 * the reverse import would be a cycle.) */
export function isBrandedPointer(type: ts.Type, checker: ts.TypeChecker): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return false;
  }
  const properties = checker.getPropertiesOfType(type);
  if (properties.length !== 1 || properties[0]?.name !== '__brand') {
    return false;
  }
  const prop = properties[0];
  const at = prop.valueDeclaration ?? prop.declarations?.[0];
  if (at === undefined) {
    return false;
  }
  const propType = checker.getTypeOfSymbolAtLocation(prop, at);
  return (propType.flags & ts.TypeFlags.StringLiteral) !== 0;
}

/** Whether this type spells the `Out` alias (`type Out<T> = { readonly value: T }`,
 * docs/FFI.md §2): the structural half of the out-slot contract. The alias is required, not
 * just the shape — like `CString`, the spelling is the contract, and a coincidental
 * `{ readonly value: Brand }` without the alias is a plain heap object, not a slot. */
export function isOutAlias(type: ts.Type): boolean {
  return type.aliasSymbol?.getName() === 'Out';
}

/** The inner type of an `Out<T>` spelling, or `undefined` when this type is not one: the
 * alias must read `Out` with exactly one type argument, and the object must hold exactly
 * one property named `value` (readonly is the checker's own business — a write is TS2540
 * before Stator ever sees it). A malformed `Out` (wrong inner, wrong shape) is NOT an
 * out-slot: it falls through to whatever its structure earns (usually the object row and
 * STA1115 in signatures), while the gate refuses the alias-with-bad-inner explicitly as
 * STA1125 where a precise message matters. */
export function outSlotInner(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  if (!isOutAlias(type)) {
    return undefined;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }
  const properties = checker.getPropertiesOfType(type);
  if (properties.length !== 1 || properties[0]?.name !== 'value') {
    return undefined;
  }
  const args = type.aliasTypeArguments ?? checker.getTypeArguments(type as ts.TypeReference);
  if (args.length !== 1) {
    return undefined;
  }
  const inner = args[0];
  if (inner === undefined || (!isBrandedPointer(inner, checker) && !isCStringType(inner))) {
    return undefined;
  }
  return inner;
}

/** `CString` / `CStringOwned` (docs/FFI.md §2): the documented wrapper spelling only — a bare
 * `string` is not one (the same discipline that refuses bare `string` in signatures with
 * STA1118), so the alias is required here exactly as `cstringKindOf` in `extern.ts` requires
 * it there. It is an `Out<CString>` inner (`const char**`) and, as a value, a string. Kept
 * diagnostic-free for `tsTypeToHType`; that module owns the surface's diagnostics. */
function isCStringType(type: ts.Type): boolean {
  const alias = type.aliasSymbol?.getName();
  if (alias !== 'CString' && alias !== 'CStringOwned') {
    return false;
  }
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return true;
  }
  return type.isIntersection() && type.types.some((t) => (t.flags & ts.TypeFlags.StringLike) !== 0);
}

/** The ONLY module allowed to map ts.Type -> HType (AGENTS.md).
 * Scope: number, string, boolean, undefined, null, and single-signature function types.
 * Anything else becomes hUnknown, never a guess.
 */
export function tsTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth = 0): HType {
  const f = type.flags;

  // Each primitive must match its LITERAL flag too. `1` has type `1`, not `number` -- TypeFlags
  // .Number alone maps every literal in the program to Unknown, which is a compiler that cannot
  // type `console.log(1)`. Enum is deliberately excluded from the number case even though
  // TypeFlags.NumberLike includes it: `erasableSyntaxOnly` bans enums outright, and silently
  // treating one as a number would hide that.
  if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
    return H_NUMBER;
  }
  if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) {
    return H_STRING;
  }
  // A `CString` VALUE is a runtime string on this side of the extern edge: an argument is copied
  // out by the call and a return was copied in at it (docs/FFI.md §3), so the brand is a phantom
  // that only the extern signature reads. Without this, `const v = native()` and an arrow whose
  // return is inferred from an extern call are Unknown, and the module explains dynamic
  // (plan-notes 322).
  if (isCStringType(type)) {
    return H_STRING;
  }
  if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) {
    return H_BOOLEAN;
  }
  // `void` is a distinct type to TypeScript but the same value at runtime: a function that
  // returns nothing evaluates to undefined, and the HIR models values, not intentions.
  if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return H_UNDEFINED;
  }
  if (f & ts.TypeFlags.Null) {
    return H_NULL;
  }

  // Both flavours of `any` land here, and this function cannot tell them apart -- a ts.Type has no
  // memory of whether an annotation was written. `isImplicitAny` answers that from the AST, so
  // the conservative flag is the safe one: the gate rejects implicit any in ts mode either way,
  // and claiming "explicit" for an inferred any would let an untyped value through silently.
  if (f & ts.TypeFlags.Any) {
    return hUnknown(true);
  }

  // Before every structural test below, because a type parameter has no structure to test: `T` is
  // a name standing in for a type the call site supplies, and monomorphization is what replaces it.
  // Mapping it to Unknown instead would be a silent decision to BOX every generic value, which is
  // exactly the "compile a typed subset" rule the project exists to keep (plan §0.1).
  //
  // The declaration test is not decoration. Polymorphic `this` -- the type of `this` inside a class
  // method -- carries `TypeFlags.TypeParameter` too, and its symbol is the CLASS, declared by a
  // ClassDeclaration. Reading the flag alone types every `this.x` receiver as a type parameter,
  // which turns every field read in every method into an unlowerable expression.
  const typeParameter = declaredTypeParameterName(type);
  if (f & ts.TypeFlags.TypeParameter && typeParameter !== undefined) {
    return hTypeParam(typeParameter);
  }

  const fn = functionTypeToHType(type, checker, depth);
  if (fn !== null) {
    return fn;
  }

  const array = arrayTypeToHType(type, checker, depth);
  if (array !== null) {
    return array;
  }

  const collection = collectionTypeToHType(type, checker, depth);
  if (collection !== null) {
    return collection;
  }

  const iterator = iteratorTypeToHType(type, checker, depth);
  if (iterator !== null) {
    return iterator;
  }

  if (isLibInterface(type, 'RegExp')) {
    return H_REGEXP;
  }

  if (isLibInterface(type, 'Date')) {
    return H_DATE;
  }

  // `Uint8Array<TArrayBuffer>` is one runtime layout whatever buffer type it is instantiated over,
  // and `ArrayBufferLike` (what `.buffer` answers on an unparameterized `Uint8Array`) is the union
  // `ArrayBuffer | SharedArrayBuffer` -- whose second member no program here can construct (the
  // gate refuses `SharedArrayBuffer`), so it is the buffer type (plan.md T11.1).
  if (isLibInterface(type, 'Uint8Array')) {
    return { kind: 'uint8array' };
  }
  if (isBufferType(type)) {
    return { kind: 'arraybuffer' };
  }

  /* The five standard error interfaces are their runtime LAYOUT, not an unknown. `new Error('x')`
   * lowers to `error-new` typed `errorHType`, so a binding declared from one -- `const e = new
   * Error('x')` -- has to have the same HType as the value it holds. It did not: the interface fell
   * through to Unknown, so `e.message` on an INLINE `new Error('x').message` was a dynamic read
   * whose target the lowering had concretely typed, which the verifier rejects (STA4059, plan-notes
   * 223). Matching by name, exactly as Date and RegExp above, because the type IS that lib
   * interface -- there is no user declaration to inspect. */
  for (const ctor of ERROR_CLASSES) {
    if (isLibInterface(type, ctor)) {
      return errorHType(ctor);
    }
  }

  // An `Out<T>` out-slot (docs/FFI.md §2) never boxes — ahead of the object row on purpose:
  // the slot is a frame-local `void *` cell, not a heap object, so the shape mapping below
  // would invent a layout for bits. Like a brand it takes the opaque HType, while the nodes
  // that create, pass, and read it still carry the slot, which is what the emitter reads.
  if (outSlotInner(type, checker) !== undefined) {
    return hUnknown(false);
  }

  // An instance of a JavaScript constructor function: the checker gives `new P()` a class-like
  // type listing what P's body assigns to `this`, but the value is a dynamic object
  // `jsrt_construct` built (plan-notes 310) -- no layout exists, so no slot may be read.
  if (isFunctionConstructorInstance(type)) {
    return hUnknown(false);
  }

  const object = classTypeToHType(type, checker, depth);
  if (object !== null) {
    return object;
  }

  // A union whose constituents all map to ONE HType is that type -- `"a" | "b"` is a string, and
  // `typeof x` is a union of eight string literals, which is why this rule is what makes `typeof`
  // usable at all rather than a value the compiler has to box. This is widening, not guessing: the
  // answer is the same for every constituent, so no information is being invented.
  //
  // A union that maps to more than one HType stays Unknown. That is the real union case (`string |
  // number`), the HIR has no node for it, and narrowing one is what a boundary check is for.
  if (type.isUnion()) {
    const constituents = type.types.map((t) => tsTypeToHType(t, checker, depth));
    const [first] = constituents;
    if (first !== undefined && constituents.every((c) => hTypeEquals(first, c))) {
      return first;
    }
    return hUnknown(false);
  }

  const moduleNs = moduleNamespaceToHType(type, checker, depth);
  if (moduleNs !== null) {
    return moduleNs;
  }

  const shape = shapeTypeToHType(type, checker, depth);
  if (shape !== null) {
    return shape;
  }

  // Everything else -- unions, tuples, objects -- is a type the HIR has no representation for
  // yet. It is Unknown, not a guess, and not an implicit any.
  return hUnknown(false);
}

/** `null` means "not a class instance this model can describe" — the caller falls through to
 * Unknown.
 *
 * Only a CLASS. An interface or a bare object type describes a shape without describing an
 * allocation, and `HObject` is a layout: it names the `JSRTClass` descriptor the emitter emitted
 * for a class declaration. A value typed by an interface may be an instance of any of several
 * classes with different layouts, so it stays Unknown until the object model can dispatch on shape.
 *
 * Declaration order is slot order, and the CHECKER's property list is what fixes it -- see the
 * comment on the loop for why `declaration.members` is not.
 *
 * The depth cap does double duty here. `class C { self: C }` is a cyclic type, and the cap is what
 * stops the descent -- deep inside, a self-reference becomes Unknown. That costs nothing real:
 * nested field types are never used to resolve a slot, because `o.a.b` asks the checker for the
 * type of `o.a` at that site, at depth zero. */
function classTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth: number): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH) {
    return null;
  }
  const symbol = type.getSymbol();
  const declaration = symbol?.valueDeclaration;
  if (symbol === undefined || declaration === undefined) {
    return null;
  }
  // An anonymous class DECLARATION (`export default class {}`) takes Node's `.name` —
  // `default` — the same way a bound EXPRESSION takes the inner name or the variable
  // (`const C = class D {}` is `D`, `const C = class {}` is `C`), so nominal equality holds
  // onto the same spelling every use resolves through (plan.md §8 step 12(d)). Any other
  // unnamed declaration or an unbound expression has no identity and stays Unknown.
  let className: string | undefined;
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    className = classDisplayName(declaration);
    if (className === undefined) {
      return null;
    }
  } else {
    return null;
  }

  const fields: HField[] = [];
  const methods: HField[] = [];
  // The checker's property list, not `declaration.members`, is the source of the slot order. In a
  // `.ts` class the two agree; in a `.js` one they do not, because a field is declared by
  // `this.x = …` in the constructor and has no member node at all. Asking the checker is what
  // makes js mode's classes have the same layout as ts mode's -- with `unknown` field types,
  // which is the dynamic path, not a missing one.
  //
  // ORDER is a second question, and the checker answers it wrongly for a subclass: it lists own
  // properties first and inherited ones after (`class B extends A` gives `b1, a1`). A subclass's
  // layout has to START with its base's, in the base's own slot order, or a base-typed read of a
  // subclass instance lands on the wrong slot -- which is the fact `hTypeAssignable` rests on.
  //
  // So the list is rebuilt from the chain, ROOT FIRST, asking each class for its own properties
  // and skipping names an ancestor already claimed. Each class's list is own-first-then-inherited,
  // and by the time it is reached every inherited name is claimed, so what survives is exactly
  // that class's own properties in its own declaration order. Sorting the subclass's flat list
  // cannot do this: a `.js` field assigned in BOTH the base and the subclass has a declaration in
  // each, and it must take the BASE's slot -- one slot, at the base's index -- which falls out of
  // "first claim wins" and does not fall out of any ranking of the merged list.
  const chain = ancestry(declaration, checker); // root ancestor first, this class last
  // A generic base's members arrive with its parameters unbound (`value: T | undefined` for
  // `Box`), so the layout grounds each ancestor's properties in THIS declaration's context
  // (`value: number | undefined` for `class Sub extends Box<number>`). Ordinary chains ground
  // nothing and read exactly what they read before.
  const heritage = heritageSubstitution(declaration, checker);
  const claimed = new Set<string>();
  for (const ancestor of chain) {
    // An expression leaf has no declared instance type of its own (its inner name, if any,
    // binds the class body, and the variable binds the static side), so the leaf grounds
    // from the use-site type every caller was compiled against. Declaration leaves keep the
    // declared type, exactly as before.
    const ancestorType =
      ancestor === declaration && ts.isClassExpression(ancestor)
        ? type
        : declaredTypeOf(ancestor, checker);
    if (ancestorType === undefined) {
      continue;
    }
    for (const property of checker.getPropertiesOfType(ancestorType)) {
      const at = property.valueDeclaration ?? property.declarations?.[0];
      // A `#private` name is scoped to the class body that writes it, so each declaring class
      // gets its own slot under a per-class name (`#x@A` vs `#x@B`): the claimed set keys the
      // MANGLED name, which is what lets a re-declaration add a slot instead of colliding with
      // (or shadowing) the ancestor's. The gate holds the one boundary this cannot express: two
      // classes in one chain sharing both the class name and the private name mangle alike.
      const rawName = hirPropertyName(property.name);
      const owner = rawName.startsWith('#')
        ? privateOwnerName(property, at, chain, ancestor)
        : undefined;
      const name = owner === undefined ? rawName : privateSlotName(owner, rawName);
      if (at === undefined || claimed.has(name)) {
        continue;
      }
      claimed.add(name);
      const declarations = property.declarations ?? [];
      // The substitution belongs to the class that DECLARED the property, not to the loop's
      // ancestor: the checker's per-class list is own-first-then-inherited, so a base member
      // surfaces here again under its descendant, and grounding it with the descendant's map
      // would read a same-spelled parameter as the wrong declaration's. A non-class parent
      // (a `.js` assignment in a constructor) keeps the loop ancestor, as before.
      const ownerDecl =
        at.parent !== undefined && ts.isClassDeclaration(at.parent) ? at.parent : ancestor;
      const ground = heritage.get(ownerDecl);
      const declared = tsTypeToHType(
        checker.getTypeOfSymbolAtLocation(property, at),
        checker,
        depth + 1,
      );
      // The ancestor's own spelling, grounded where the heritage binds it: `Box`'s `T` is
      // `number` in `Sub`'s layout and stays `T` in `Box`'s own. Skipped wholesale without a
      // map, so an ordinary ancestor pays no walk for a substitution that would change nothing.
      const valueType =
        ground === undefined ? declared : substituteHType(declared, (param) => ground.get(param));
      // An accessor is not a slot and never was: `x` names a pair of functions, and the checker's
      // property type is what the GETTER returns. So it contributes one method per half, under a
      // name no source can spell, and the property name claims no field. A class with a getter
      // therefore keeps the fixed-slot layout of its actual fields -- only `x` itself is a call.
      const getter = declarations.some(ts.isGetAccessorDeclaration);
      const setter = declarations.some(ts.isSetAccessorDeclaration);
      if (getter || setter) {
        if (getter) {
          methods.push({
            name:
              owner === undefined
                ? accessorName('get', property.name)
                : privateMethodName(owner, accessorName('get', property.name)),
            type: hFunction([], valueType),
          });
        }
        if (setter) {
          methods.push({
            name:
              owner === undefined
                ? accessorName('set', property.name)
                : privateMethodName(owner, accessorName('set', property.name)),
            type: hFunction([valueType], H_UNDEFINED),
          });
        }
        continue;
      }
      const member: HField = { name, type: valueType };
      // Split by what the member's DECLARATION is, not by what its type is: a field holding a
      // closure (`onClick: () => void`) is a slot, and a method is not, though both are functions.
      if (declarations.some(ts.isMethodDeclaration)) {
        methods.push(member);
      } else {
        fields.push(member);
      }
    }
  }
  // Nearest ancestor first, which is the order `hTypeAssignable` and `instanceof` read it in.
  // A generic ancestor names its tuple (`Box<number>`), not the declaration: the descriptor
  // that owns the inherited members IS the specialization, and every receiver check reads
  // these names. An incomplete tuple (a refused program's) keeps the source name, exactly as
  // before, so this stays total where the gate still refuses.
  const bases = chain
    .slice(0, -1)
    .reverse()
    // Bases stay declarations, except through `extends C` on a bound expression (plan.md §8
    // step 12(d)), which names its descriptor by binding. An unbound base has no descriptor
    // and answers `''`, filtered below like an incomplete tuple.
    .map((c) => baseDescriptorName(c, declaration, checker))
    .filter((n) => n !== '');
  return hObject(className, fields, methods, bases);
}

/** `null` means "not an object literal's shape" — the caller falls through to Unknown.
 *
 * An object literal has no declaration to be a layout OF, so its layout comes from the type: the
 * properties in declaration order, which for a literal type IS the order they were written.
 *
 * The name is the shape itself (`{x: number, y: string}`), which does three things at once. It is
 * unspellable -- no class may be called that -- so it can never collide with a class name; it is
 * structural, so two literals with the same keys and types share one layout and are assignable to
 * each other, which is what a literal type MEANS; and the leading brace is the emitter's signal
 * that this descriptor prints no name, because `console.log({x: 1})` shows `{ x: 1 }`.
 *
 * Only an anonymous shape. An INTERFACE is excluded deliberately: a value typed by one may be an
 * instance of any of several classes with different layouts, and giving it a layout of its own
 * would let a class instance be read through the wrong one. Anything with a call signature, a
 * construct signature, an index signature, a method or an optional property is excluded too --
 * each needs something a fixed slot list cannot hold. */
/** `typeof import("x")` / a source-file module type. Field reads are live bindings onto the
 * merged globals (docs/VALUE.md §4.14). */
function moduleNamespaceToHType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH) {
    return null;
  }
  // TypeScript puts Module bits on a fresh `let o = {}` binding (ValueModule|NamespaceModule
  // plus BlockScopedVariable). A namespace is a SourceFile, never a value binding: matching
  // those would mark `{ x: number }` as `namespace: true` (`namespaceModule` refuses them).
  const file = namespaceModule(type);
  if (file === undefined) {
    return null;
  }
  // A name two `export *` re-exports bind differently is no export at all (ES drops it from the
  // namespace); the checker still lists it, under js mode's dropped TS2308 (plan-notes 302).
  const ambiguous = ambiguousStarExports(file, checker);
  const fields: HField[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const atDecl = property.valueDeclaration ?? property.declarations?.[0];
    if (
      atDecl === undefined ||
      (property.flags & ts.SymbolFlags.Method) !== 0 ||
      ambiguous.has(property.name)
    ) {
      continue;
    }
    const propertyType = checker.getTypeOfSymbolAtLocation(property, atDecl);
    // A class has no value in this subset (a class object is rung 6b's), so an exported class is
    // no namespace field: `ns.C` reads a class object and the gate holds it (plan.md §11c T11.5a).
    if (propertyType.getConstructSignatures().length > 0) {
      continue;
    }
    fields.push({ name: property.name, type: tsTypeToHType(propertyType, checker, depth + 1) });
  }
  if (fields.length === 0) {
    return null;
  }
  return hObject(shapeName(fields), fields, [], [], true);
}

function shapeTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth: number): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH) {
    return null;
  }
  const symbol = type.getSymbol();
  const anonymous =
    symbol !== undefined &&
    (symbol.flags & (ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.TypeLiteral)) !== 0;
  if (
    !anonymous ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0 ||
    checker.getIndexInfosOfType(type).length > 0
  ) {
    return null;
  }
  const fields: HField[] = [];
  const methods: HField[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    // A `__proto__` data property is never a layout slot: the definition spelling
    // `{ __proto__: v }` is the prototype setter, not an own property (plan.md §8 step
    // 33), so a shape carrying one takes the shape table, where the lowering drops the
    // setter entry. A METHOD named `__proto__` is an own property and keeps its table.
    if (isProtoDataProperty(property)) {
      return null;
    }
    const at = property.valueDeclaration ?? property.declarations?.[0];
    // An ACCESSOR is not a slot: `o.x` on it must RUN the getter, and a layout would compile that
    // read to a slot load. Refusing the layout here is what sends the whole shape to the dynamic
    // path, where the get/set pair lives in the object's slot (docs/VALUE.md §4.15).
    if (
      at === undefined ||
      (property.flags & ts.SymbolFlags.Optional) !== 0 ||
      (property.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0
    ) {
      return null;
    }
    const declarations = property.declarations ?? [];
    const valueType = tsTypeToHType(
      checker.getTypeOfSymbolAtLocation(property, at),
      checker,
      depth + 1,
    );
    if (declarations.some(ts.isMethodDeclaration)) {
      methods.push({ name: property.name, type: valueType });
    } else if ((property.flags & ts.SymbolFlags.Method) !== 0) {
      methods.push({ name: property.name, type: valueType });
    } else {
      fields.push({ name: property.name, type: valueType });
    }
  }
  // Zero members is not a layout: `{}` has to grow (plan.md §8 step 4), so it is Unknown and
  // takes the shape table. An all-required shape with at least one field or method stays fixed.
  if (fields.length === 0 && methods.length === 0) {
    return null;
  }
  return hObject(shapeName(fields, methods), fields, methods, []);
}

/** Whether `property` is an own data property spelled `__proto__`.
 *
 * Only the definition spelling `{ __proto__: v }` / `{ "__proto__": v }` (a non-computed
 * PropertyAssignment) is the prototype setter; a method, an accessor pair, a shorthand and a
 * computed key are all own properties. The checker type does not record which spelling
 * introduced the property, so this answers the conservative half: anything that is not
 * plainly a method forces the shape table (plan.md §8 step 33), where the lowering keeps
 * exactly the own spellings and drops the setter one. An accessor overlaps the existing
 * Get/SetAccessor trigger below and answers the same way either way. */
function isProtoDataProperty(property: ts.Symbol): boolean {
  if (property.name !== '__proto__') {
    return false;
  }
  const declarations = property.declarations ?? [];
  return (
    !declarations.some(ts.isMethodDeclaration) && (property.flags & ts.SymbolFlags.Method) === 0
  );
}

/** Whether `type` is an anonymous object shape that goes to the DYNAMIC representation -- a shape
 * table plus inline caches (docs/VALUE.md §4.10) -- rather than a fixed layout.
 *
 * The line between the two paths is drawn here and nowhere else. A shape qualifies when it is
 * anonymous (interfaces stay refused: a value typed by one may be an instance of any class, and
 * Phase 5 owns that), callable in no way, and carries one of the triggers: an ACCESSOR, an
 * OPTIONAL property, an index signature, or no properties at all. An empty `{}` has to grow
 * (plan.md §8 step 4); an all-required anonymous shape with at least one field stays on the
 * fixed path, because making those dynamic too would silently deoptimize every literal in the
 * program.
 *
 * A METHOD is neither a trigger nor a veto: on a fixed shape it rides the method table, and on
 * a dynamic one it is an own data property holding the method's closure, called through the
 * shape table (`dyn-method-call`, plan.md §8 step 22). The veto this used to carry dated from
 * when no such call existed.
 *
 * An accessor is a trigger and not a refusal because there IS a representation for it — a get/set
 * pair in the object's slot (docs/VALUE.md §4.15) — and only the dynamic path has one. It
 * deoptimizes its whole shape, siblings included: `{ val: 1, get x() {…} }` resolves `val` through
 * the shape table too, because one object cannot be half a layout. */
export function isDynamicShape(type: ts.Type, checker: ts.TypeChecker): boolean {
  /* Arrays (and tuples, which are arrays at run time) are never shape-table objects, however
   * many methods the Array interface declares: with the method veto gone (plan.md §8 step 22 --
   * an object literal's method is an own closure, not a refusal) an array now falls through to
   * the index-signature trigger below and every `arr.length` lowers to a dynamic read the
   * verifier rejects (STA4059: a dynamic target must be Unknown). This keeps step 22's method
   * work while restoring the array path step 20's receiver checks stand on. */
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return false;
  }
  /* The standard error interfaces are their runtime LAYOUT, not a shape (see `tsTypeToHType`), and
   * their lib declaration carries an optional `stack` -- so the trigger below would read them as
   * "this shape can lose a key" and send every `e.message` through the shape table, which is the
   * STA4059 the layout mapping exists to fix (plan-notes 223). */
  for (const ctor of ERROR_CLASSES) {
    if (isLibInterface(type, ctor)) {
      return false;
    }
  }
  const symbol = type.getSymbol();
  /* An INTERFACE is the same shape as its anonymous twin: `interface O { x?: number }` and
   * `{ x?: number }` describe one type, and `docs/SUBSET.md`'s row sends a literal with an optional
   * property to the shape table whichever spelling introduced it. Leaving the interface out made
   * the literal a fixed layout while its HType was Unknown -- so `delete o.x` passed the gate
   * (Unknown reads as dynamic) and then aborted at run time against a layout that cannot lose a
   * slot (plan-notes 223). A CLASS is deliberately not on this list: a class instance has a
   * declared layout, and that layout is the point of ts mode. */
  const structural =
    symbol !== undefined &&
    (symbol.flags &
      (ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.Interface)) !==
      0;
  if (
    !structural ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
  ) {
    return false;
  }
  let trigger = false;
  for (const property of checker.getPropertiesOfType(type)) {
    trigger =
      trigger ||
      (property.flags &
        (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !==
        0 ||
      isProtoDataProperty(property);
  }
  return (
    trigger ||
    checker.getIndexInfosOfType(type).length > 0 ||
    checker.getPropertiesOfType(type).length === 0
  );
}

/** Whether an object literal should take the shape-table path.
 *
 * The contextual type wins when it is itself a dynamic shape (`const o: { x?: number } = { x: 1 }`).
 * Otherwise the literal's own type decides: empty `{}` is dynamic even when the context is `any`
 * (an untyped parameter), which is not a shape `isDynamicShape` would recognize.
 *
 * An ACCESSOR member needs no case here: `isDynamicShape` treats one as a trigger, so a literal
 * that writes `get x()` is dynamic by its own type. A computed key whose value is not known until
 * runtime is the same: it has no layout slot until `jsrt_dyn_index_set` runs. A computed key
 * WITH a static name (`computedKeyStaticName`) is the opposite -- it is the name the direct
 * spelling writes, so the literal takes the same path the direct spelling does. */

/** The compile-time name of a computed key, or `null` when the key is a runtime value.
 *
 * A string literal in source is its own name. Anything else is answered by the checker's TYPE:
 * `const k = "dyn"` has the literal type `"dyn"`, so `[k]` is the name `dyn` -- the same key the
 * direct spelling writes -- while `k: string` is not a name at all. A number literal answers
 * `String(value)`, which is the spelling TypeScript itself uses for the property it declares
 * (`const k = 0x10` declares `16`), so the resolved name always agrees with the shape the
 * literal's type carries. A union of literals, a symbol, or anything wider is `null`: the key
 * is genuinely not known until the program runs. */
export function computedKeyStaticName(
  name: ts.ComputedPropertyName,
  checker: ts.TypeChecker,
): string | null {
  return elementStaticKey(name.expression, checker);
}

/** The compile-time name of an element-access key expression, or `null` when the key is a
 * runtime value. The same rule `computedKeyStaticName` answers for a `ComputedPropertyName`,
 * asked of the bare expression instead: a string literal in source is its own name, anything
 * else is answered by the checker's TYPE (`const k = "m"` has the literal type `"m"`, so
 * `c[k]` is the name `m` -- the same member the dot spelling reads -- while `k: string` is
 * not a name at all). A number literal answers `String(value)`, the spelling TypeScript itself
 * uses for the property it declares. A union of literals, a symbol, or anything wider is
 * `null`: the key is genuinely not known until the program runs. */
export function elementStaticKey(expr: ts.Expression, checker: ts.TypeChecker): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  const type = checker.getTypeAtLocation(expr);
  if (type.isStringLiteral()) {
    return type.value;
  }
  if (type.isNumberLiteral()) {
    return String(type.value);
  }
  return null;
}

function computedKeyIsLayoutKey(name: ts.ComputedPropertyName, checker: ts.TypeChecker): boolean {
  return computedKeyStaticName(name, checker) !== null;
}

function literalHasRuntimeComputedKey(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): boolean {
  for (const property of literal.properties) {
    if (
      (ts.isPropertyAssignment(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)) &&
      ts.isComputedPropertyName(property.name) &&
      !computedKeyIsLayoutKey(property.name, checker)
    ) {
      return true;
    }
  }
  return false;
}

export function objectLiteralIsDynamic(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): boolean {
  const own = checker.getTypeAtLocation(literal);
  const contextual = checker.getContextualType(literal);
  return (
    // The checker typed the literal `any`: a spread of an `any` value, or one it refused (TS2698,
    // a js-mode runtime code). Its key set is then a run-time question, and only the shape table
    // can answer it (plan-notes 297).
    (own.flags & ts.TypeFlags.Any) !== 0 ||
    literalHasRuntimeComputedKey(literal, checker) ||
    // A spread whose operand is a run-time key set (Unknown, or a dropped `as` whose VALUE is
    // unknown): CopyDataProperties enumerates at run time, so the result cannot be a fixed slot
    // list (plan-notes 375 / F3).
    literalHasRuntimeKeySpread(literal, checker) ||
    (contextual !== undefined && isDynamicShape(contextual, checker)) ||
    isDynamicShape(own, checker)
  );
}

/** Whether any spread operand's VALUE is dynamic (Unknown), including through a dropped `as`
 * whose asserted shape is not the value's. The asserted type is checked elsewhere; this asks
 * only whether the key set is known at compile time. */
function literalHasRuntimeKeySpread(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): boolean {
  for (const property of literal.properties) {
    if (!ts.isSpreadAssignment(property)) {
      continue;
    }
    let expr: ts.Expression = property.expression;
    while (ts.isParenthesizedExpression(expr)) {
      expr = expr.expression;
    }
    if (ts.isAsExpression(expr)) {
      expr = expr.expression;
      while (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
      }
    }
    const value = tsTypeToHType(checker.getTypeAtLocation(expr), checker);
    if (value.kind === 'unknown' || isDynamicShape(checker.getTypeAtLocation(expr), checker)) {
      return true;
    }
  }
  return false;
}

/** The structural name of a shape: what makes two identical literals one layout. */
export function shapeName(fields: readonly HField[], methods: readonly HField[] = []): string {
  const parts = [
    ...fields.map((f) => `${f.name}: ${hTypeName(f.type)}`),
    ...methods.map((m) => `${m.name}: ${hTypeName(m.type)}`),
  ];
  return `{${parts.join(', ')}}`;
}
/** The instance type a class declaration declares, or `undefined` when no symbol resolves.
 * Going through the name's symbol is what makes this answerable for any class in a chain, not
 * just the one whose `ts.Type` the caller happened to start from. The anonymous `export default
 * class {}` has no name symbol; its declaration's own type is already the instance type. */
function declaredTypeOf(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (declaration.name === undefined) {
    return ts.isClassDeclaration(declaration) && isDefaultExportDeclaration(declaration)
      ? checker.getTypeAtLocation(declaration)
      : undefined;
  }
  const symbol = checker.getSymbolAtLocation(declaration.name);
  return symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
}

/** The inheritance chain ending at `declaration`, ROOT ANCESTOR FIRST. Member lookups want the
 * other order -- an override must be found before what it overrides -- and reverse it themselves;
 * layout construction wants this one, so a base's fields keep their slots in every subclass. A class with no base is a
 * one-element chain. Stops at anything that is not a class declaration -- extending an expression
 * or an ambient class is rejected at the gate, and stopping quietly here rather than throwing keeps
 * this function total. */
export function ancestry(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): (ts.ClassDeclaration | ts.ClassExpression)[] {
  const chain: (ts.ClassDeclaration | ts.ClassExpression)[] = [];
  let current: ts.ClassDeclaration | ts.ClassExpression | undefined = declaration;
  // A cycle is impossible in well-formed source and the checker has already rejected one, but the
  // seen-set makes that a property of this loop rather than of its input.
  const seen = new Set<ts.ClassDeclaration | ts.ClassExpression>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = baseClassOf(current, checker);
  }
  return chain;
}

/** The class a declaration extends, or `undefined`. `implements` clauses are skipped: they are
 * type-only and erase, so they contribute nothing to a layout. Takes an expression as well as a
 * declaration -- the gate vets both through one path, and only the heritage CLAUSE is read here,
 * which the two spell identically. The BASE is still always a declaration: extending an
 * expression reaches a layout that was never emitted. A bare-identifier base additionally
 * resolves through `const K = C` alias erasure (possibly chained): the alias binds no value,
 * so the heritage names the target's layout directly, and every consumer of this function
 * (ancestry, the HType bases, the lowering's base name, the vtable owner, the generic tuple)
 * grounds to the same declaration. A member-expression base (`NS.C`) resolves through the
 * checker's own symbol, exactly as the direct spelling does. A variable bound to a class
 * expression (`extends C` on `const C = class …`) grounds to the expression the same way an
 * alias does (plan.md §8 step 12(d)). Anything else -- a call, a
 * static field holding a class, a `let` -- resolves nowhere. */
export function baseClassOf(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  const clause = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (expression === undefined) {
    return undefined;
  }
  const base = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (base !== undefined && ts.isClassDeclaration(base)) {
    return base;
  }
  if (ts.isIdentifier(expression)) {
    return (
      aliasedClassDeclaration(expression, checker) ??
      classExpressionTarget(expression, checker) ??
      innerClassExpression(expression, checker)
    );
  }
  return undefined;
}

/** The `extends` type node of a declaration (`Box<number>` in `class Sub extends Box<number>`),
 * or `undefined` for no base. Only the heritage CLAUSE is read here, like `baseClassOf` — an
 * `implements` clause is type-only and erased, so it never contributes a substitution. */
function extendsTypeNode(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): ts.ExpressionWithTypeArguments | undefined {
  const clause = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  return clause?.types[0];
}

/** Every generic ancestor's type parameters grounded in `leaf`'s context: `Box.T := number`
 * for `class Sub extends Box<number>`.
 *
 * The walk runs LEAF-UP, threading each edge's written arguments through the maps already
 * grounded below it, so `class Mid<U> extends Box<U[]>` under `class Sub extends Mid<string>`
 * grounds `Box.T := string[]` — while a same-named parameter at two levels never collides,
 * because each level's map is keyed by its own declaration rather than by the spelling. An
 * argument mentioning a parameter nothing grounds (an enclosing generic's, which the gate
 * refuses for the accepted shapes) is left as a type parameter: total on refused programs,
 * concrete on accepted ones. Ordinary ancestors take no entry, so a chain without a generic
 * base grounds nothing and every existing caller reads exactly what it read before. */
export function heritageSubstitution(
  leaf: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): ReadonlyMap<ts.ClassDeclaration | ts.ClassExpression, ReadonlyMap<string, HType>> {
  const grounded = new Map<ts.ClassDeclaration | ts.ClassExpression, Map<string, HType>>();
  const chain = ancestry(leaf, checker);
  const leafIndex = chain.indexOf(leaf);
  if (leafIndex < 0) {
    return grounded;
  }
  for (let i = leafIndex; i > 0; i--) {
    const child = chain[i];
    const parent = chain[i - 1];
    if (child === undefined || parent === undefined) {
      continue;
    }
    const parameters = parent.typeParameters ?? [];
    if (parameters.length === 0) {
      continue;
    }
    const args = extendsTypeNode(child)?.typeArguments ?? [];
    // A raw bound (`extends Box` with no arguments) grounds nothing: the checker owns that
    // spelling in ts mode, and the gate refuses it in js mode. Leaving the parent ungrounded
    // reads downstream as an incomplete tuple rather than a wrong one.
    if (args.length !== parameters.length) {
      continue;
    }
    const childMap = grounded.get(child);
    const parentMap = new Map<string, HType>();
    parameters.forEach((parameter, index) => {
      const arg = args[index];
      if (arg === undefined) {
        return;
      }
      const raw = tsTypeToHType(checker.getTypeFromTypeNode(arg), checker);
      parentMap.set(
        parameter.name.text,
        substituteHType(raw, (name) => childMap?.get(name)),
      );
    });
    grounded.set(parent, parentMap);
  }
  return grounded;
}

/** The tuple a generic `base` is instantiated at as seen from `leaf`: `[number]` for `Box` in
 * `class Sub extends Box<number>`. May still mention a type parameter (a generic leaf, which
 * the gate holds for a later slice) — the caller decides what is concrete enough. `undefined`
 * when `base` is ordinary (no tuple to name), outside `leaf`'s ancestry, or not groundable
 * (a raw bound, an arity mismatch): all ordinary paths, never errors. */
export function heritageTuple(
  base: ts.ClassDeclaration | ts.ClassExpression,
  leaf: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): HType[] | undefined {
  const parameters = base.typeParameters ?? [];
  if (parameters.length === 0) {
    return undefined;
  }
  if (!ancestry(leaf, checker).includes(base)) {
    return undefined;
  }
  const grounded = heritageSubstitution(leaf, checker).get(base);
  if (grounded === undefined) {
    return undefined;
  }
  const tuple: HType[] = [];
  for (const parameter of parameters) {
    const element = grounded.get(parameter.name.text);
    if (element === undefined) {
      return undefined;
    }
    tuple.push(element);
  }
  return tuple;
}

/** The descriptor name for ancestor `base` as seen from `leaf`: the mangled tuple
 * (`Box<number>`) for a generic base grounded completely, the source name otherwise. The
 * otherwise covers two shapes that never reach the lowering together — an ordinary base, and
 * a refused program's incomplete tuple — so both read exactly what they read before. */
export function baseDescriptorName(
  base: ts.ClassDeclaration | ts.ClassExpression,
  leaf: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
): string {
  // An expression base is named by its binding (Node's `.name`), not by a source name it does
  // not have; an unbound one has no descriptor, and the empty string filters it out at every
  // call site, exactly as an incomplete tuple does.
  const name = ts.isClassExpression(base)
    ? (expressionClassName(base) ?? '')
    : (base.name?.text ?? '');
  if (name === '') {
    return '';
  }
  const tuple = heritageTuple(base, leaf, checker);
  if (tuple === undefined || tuple.some(hasTypeParam)) {
    return name;
  }
  return specializationName(name, tuple);
}

/** The class declaration a type came from, or `undefined` if the type is not a class instance
 * this subset models. This must stay in step with `classTypeToHType` below: the gate's accept set
 * is the HIR's vocabulary, so a shape accepted on the strength of this that maps to Unknown there
 * would be a construct the lowering cannot lower. */
export function classDeclarationOf(type: ts.Type): ts.ClassDeclaration | undefined {
  const declaration = type.getSymbol()?.valueDeclaration;
  return declaration !== undefined &&
    ts.isClassDeclaration(declaration) &&
    declaration.name !== undefined
    ? declaration
    : undefined;
}

/** Whether a class member carries `static`. */
export function isStaticMember(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true
  );
}

/** Whether a class member carries `abstract`: it declares, and a subclass implementation
 * runs. Bodiless abstract members need no lowering of their own — the stub the lowering
 * emits in their place throws if it ever runs, which no checked program does (an abstract
 * class is never constructed, a concrete subclass always overrides). */
export function hasAbstractModifier(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true
  );
}

/** TypeScript's name for a class's `[Symbol.iterator]()` method — `getPropertiesOfType` spells
 * well-known symbols as `__@` plus the spec name, and HObject.methods has to match that so a
 * MethodCall slot and a vtable entry name the same row. */
export const ITERATOR_METHOD_NAME = '__@iterator';

/** TypeScript unique-ifies well-known symbol properties as `__@iterator@<id>`. HIR uses one
 * spelling so a MethodCall slot matches `instanceMethodName`. */
export function hirPropertyName(name: string): string {
  return name === ITERATOR_METHOD_NAME || name.startsWith(`${ITERATOR_METHOD_NAME}@`)
    ? ITERATOR_METHOD_NAME
    : name;
}

/** Whether an HIR member name is a `#private` one: a field (`#x@A`), or an accessor half
 * (`get #x@A`, `set #x@A`). Public names can never take these shapes -- an identifier holds no
 * `#` or space -- so the test is exact, on both the raw (`#x`) and the mangled spellings. */
export function isPrivateMemberName(name: string): boolean {
  return name.startsWith('#') || name.startsWith('get #') || name.startsWith('set #');
}

/** The slot an instance `#private` member lives under: the raw name qualified by the class that
 * declares it (`#x` in `A` is `#x@A`).
 *
 * Two `#x` in one chain are TWO fields in JavaScript -- a private name is scoped to the class
 * body that writes it -- so one spelling needs one slot per declaring class. The `@owner`
 * suffix is unspellable (a PrivateIdentifier holds no `@`), and the leading `#` is kept so
 * every reflective walk that already filters `#private` storage (`is_private_field` in the
 * runtime, the spread skip, print) keeps filtering it without learning a second spelling. */
export function privateSlotName(owner: string, raw: string): string {
  return `#${raw.slice(1)}@${owner}`;
}

/** The member-function name an instance `#private` method or accessor lowers under: the same
 * per-class qualification applied to the whole mangled method name, so `get #x` in `A` is
 * `get #x@A` and `#m` in `A` is `#m@A`. Public names pass through unchanged. */
export function privateMethodName(owner: string, raw: string): string {
  if (raw.startsWith('get #') || raw.startsWith('set #')) {
    const space = raw.indexOf(' ');
    return `${raw.slice(0, space + 1)}${privateSlotName(owner, raw.slice(space + 1))}`;
  }
  return raw.startsWith('#') ? privateSlotName(owner, raw) : raw;
}

/** The source name of the class that declares `property`, or `undefined` when no declaration in
 * `chain` claims it. The checker's property list is per TYPE -- an inherited `#x` appears on the
 * subclass's list under the ancestor's declaration -- so the owner is read off the declaration,
 * never off the type being built. Falls back to the ancestor whose list carries the symbol, for
 * a `.js` field the checker attributes without a member node. */
function privateOwnerName(
  property: ts.Symbol,
  at: ts.Declaration | undefined,
  chain: readonly (ts.ClassDeclaration | ts.ClassExpression)[],
  ancestor: ts.ClassDeclaration | ts.ClassExpression,
): string | undefined {
  const parent =
    at !== undefined && (ts.isClassDeclaration(at.parent) || ts.isClassExpression(at.parent))
      ? at.parent
      : undefined;
  const owner =
    parent !== undefined && classDisplayName(parent) !== undefined
      ? parent
      : (chain.find((candidate) =>
          (property.declarations ?? []).some((d) => d.parent === candidate),
        ) ?? ancestor);
  return classDisplayName(owner);
}

/** `[Symbol.iterator]` as a computed name. Does not ask whether `Symbol` is the global — the
 * caller that admits the spelling as the well-known method does. */
export function symbolIteratorAccess(
  name: ts.PropertyName,
): ts.PropertyAccessExpression | undefined {
  if (!ts.isComputedPropertyName(name)) {
    return undefined;
  }
  const expr = name.expression;
  if (
    !ts.isPropertyAccessExpression(expr) ||
    expr.questionDotToken !== undefined ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== 'Symbol' ||
    !ts.isIdentifier(expr.name) ||
    expr.name.text !== 'iterator'
  ) {
    return undefined;
  }
  return expr;
}

/** The HIR method name a class member goes under.
 *
 * `[Symbol.iterator]` is a name: the well-known iterator method, stored under
 * `ITERATOR_METHOD_NAME`. Any other computed key with a static name (`const k = "m"` makes
 * `[k]` the name `m`, the step-22 computed-literal rule) is the name the direct spelling
 * writes, so it resolves the same way. A computed key without one is not a name until there
 * is a shape table to look it up in -- a class layout has none, so fully dynamic keys stay
 * `STA1214` (the gate records the boundary). */
export function instanceMethodName(
  member: ts.NamedDeclaration,
  checker: ts.TypeChecker,
): string | undefined {
  if (member.name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) {
    return member.name.text;
  }
  if (ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text;
  }
  if (!ts.isComputedPropertyName(member.name)) {
    return undefined;
  }
  if (symbolIteratorAccess(member.name) !== undefined) {
    return ITERATOR_METHOD_NAME;
  }
  return computedKeyStaticName(member.name, checker) ?? undefined;
}

/** True when `name` is a global `[Symbol.iterator]` computed name — the well-known method, not a
 * shadowed `const Symbol`. */
export function isGlobalSymbolIteratorName(
  name: ts.PropertyName,
  checker: ts.TypeChecker,
): boolean {
  const access = symbolIteratorAccess(name);
  if (access === undefined) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(access.expression);
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** True when `arg` is a global `Symbol.iterator` element key (`u[Symbol.iterator]`) — the
 * well-known iterator, not a shadowed `const Symbol` and not an optional `u?.[Symbol.iterator]`
 * (which the optional-chain element rule owns). The use-site twin of `isGlobalSymbolIteratorName`
 * (which answers for a computed member NAME); the gate and the lowering share this so the two
 * cannot disagree about which brackets name the protocol. */
export function isSymbolIteratorKey(arg: ts.Expression, checker: ts.TypeChecker): boolean {
  if (
    !ts.isPropertyAccessExpression(arg) ||
    arg.questionDotToken !== undefined ||
    !ts.isIdentifier(arg.expression) ||
    arg.expression.text !== 'Symbol' ||
    !ts.isIdentifier(arg.name) ||
    arg.name.text !== 'iterator'
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(arg.expression);
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** An object type whose `[Symbol.iterator]()` returns an iterator (a Generator, or a boxed
 * specialized iterator). That is the user-iterable case docs/VALUE.md §4.13 admits: the frontend
 * can see the method, and the existing iterator for-of drives what it returns. */
export function userIteratorMethod(type: HType): HField | undefined {
  if (type.kind !== 'object') {
    return undefined;
  }
  const method = type.methods.find((m) => m.name === ITERATOR_METHOD_NAME);
  return method !== undefined && method.type.kind === 'fn' && method.type.ret.kind === 'iterator'
    ? method
    : undefined;
}

/** Whether a declarator is the only one in a `const` list: the one shape an alias formation
 * takes, mirroring the lowering's one-binding-per-declaration limit.
 *
 * Exported: the lowering skips exactly the formations the gate accepts, so the two cannot
 * disagree about which declarators bind nothing. Lives here rather than in the gate because
 * the alias resolution below asks the same question, and the gate re-exports it for its
 * existing importers. */
export function isSingleConstDeclarator(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return (
    list !== undefined &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    list.declarations.length === 1 &&
    ts.isIdentifier(declaration.name)
  );
}

/** The identifiers an assignment target writes: a name, or every name a destructuring pattern
 * spreads into (`[a, { b, c: d = 1 }, ...e] = …`). */
function writtenIdentifiers(target: ts.Expression, out: ts.Identifier[]): void {
  let inner = target;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (ts.isIdentifier(inner)) {
    out.push(inner);
  } else if (ts.isArrayLiteralExpression(inner)) {
    for (const element of inner.elements) writtenIdentifiers(element, out);
  } else if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      if (ts.isShorthandPropertyAssignment(property)) out.push(property.name);
      else if (ts.isPropertyAssignment(property)) writtenIdentifiers(property.initializer, out);
      else if (ts.isSpreadAssignment(property)) writtenIdentifiers(property.expression, out);
    }
  } else if (ts.isSpreadElement(inner)) {
    writtenIdentifiers(inner.expression, out);
  } else if (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // A pattern element's default: `[a = 1] = xs` writes `a`.
    writtenIdentifiers(inner.left, out);
  }
}

const neverWritten = new WeakMap<ts.VariableDeclaration, boolean>();

/** Whether nothing in the declaring file writes the binding after its initializer: no
 * assignment, compound or logical assignment, `++`/`--`, destructuring target or `for-in`/`for-of`
 * head names it. A module's bindings are read-only to every importer, so the file is the whole
 * program as far as writes go. */
function isNeverWritten(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const cached = neverWritten.get(declaration);
  if (cached !== undefined) return cached;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  let written = symbol === undefined;
  const visit = (node: ts.Node): void => {
    if (written) return;
    const targets: ts.Identifier[] = [];
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      writtenIdentifiers(node.left, targets);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      writtenIdentifiers(node.operand, targets);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      writtenIdentifiers(node.initializer, targets);
    }
    if (targets.some((id) => checker.getSymbolAtLocation(id) === symbol)) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  neverWritten.set(declaration, !written);
  return !written;
}

/** Whether a declarator binds a class expression the way a single `const` does: the only
 * declarator in its list, an identifier, and a binding that never changes — `const`, or a `let`
 * or `var` nothing writes. Rolldown spells every top-level class `var X = class { … }` (plan.md
 * §11d T12.3), and a binding nothing repoints erases exactly as a `const` one. One hazard stays,
 * as with a class declaration under `var` semantics: a `var` read that RUNS before the
 * declaration is `undefined` in Node, and a TypeError at `new`; here it names the class. */
export function isClassFormationDeclarator(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const list = declaration.parent;
  if (
    list === undefined ||
    !ts.isVariableDeclarationList(list) ||
    list.declarations.length !== 1 ||
    !ts.isIdentifier(declaration.name)
  ) {
    return false;
  }
  return (list.flags & ts.NodeFlags.Const) !== 0 || isNeverWritten(declaration, checker);
}

/** The class declaration an identifier names, directly or through `const K = C` aliases.
 *
 * A class used as a value is erased, not built (plan.md §8 step 12e): `const K = C` binds no
 * value -- the class object rung 6b never allocated -- so every in-place use (`new K`,
 * `K.static`, `o instanceof K`) rewrites to the target declaration. There is therefore no
 * heap object to root and no tag to spend (docs/VALUE.md §1.1 is full). Only single-`const`
 * links resolve: a `let` can be reassigned, so erasing it would compile a different program.
 * An `import`/`export` specifier resolves through the checker's alias to the local declaration
 * it names, so `export { K }` reads as the alias use it is (accepted as a boundary spelling,
 * like the class's own name), while an imported class answers for its declaration wherever a
 * direct name would. Answers `undefined`
 * for anything else, including the binding's own name (a declaration, not a use) and anything
 * circular. An opaque use (`foo(K)`) is the real class object, which is family 12(d)'s, not
 * this erasure's -- the gate refuses those with the same STA1214. */
export function aliasedClassDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | undefined {
  const seen = new Set<ts.Symbol>();
  let current: ts.Identifier | undefined = node;
  while (current !== undefined) {
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seen.has(symbol)) {
      return undefined;
    }
    seen.add(symbol);
    // An import or export specifier is not the binding: the alias it names is.
    const declaration: ts.Declaration | undefined =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol).valueDeclaration
        : symbol.valueDeclaration;
    if (declaration === undefined) {
      return undefined;
    }
    if (ts.isClassDeclaration(declaration)) {
      // The anonymous `export default class {}` has no name node but does have an identity
      // (`*default*`, plan.md §8 step 12(d)); anything else without a name does not.
      return classDisplayName(declaration) !== undefined ? declaration : undefined;
    }
    // The binding's own name declares rather than uses: without this the formation
    // `const K = C` would resolve its own `K` to `C` and read as a use of itself.
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.name === current ||
      declaration.initializer === undefined ||
      !ts.isIdentifier(declaration.initializer) ||
      !isSingleConstDeclarator(declaration)
    ) {
      return undefined;
    }
    current = declaration.initializer;
  }
  return undefined;
}

/** The class expression a `const C = class …` formation binds, or `undefined`.
 *
 * The expression twin of the alias erasure above (plan.md §8 step 12(d)): the formation binds
 * no value — every in-place use (`new C`, `C.static`, `o instanceof C`, `extends C`) erases
 * to the expression, whose descriptor the lowering emits under the variable's name. Only
 * single-`const` identifier bindings resolve, for the same reassignability reason aliases
 * give: a `let` can be repointed, so erasing it would compile a different program. An
 * `import`/`export` specifier resolves through the checker's alias first, exactly as above.
 * Answers `undefined` for the binding's own name (a declaration, not a use) and anything
 * circular. An opaque use (`foo(C)`) is the real class object, refused at the gate under
 * the same STA1214 as the class itself. */
export function classExpressionTarget(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ClassExpression | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  const declaration: ts.Declaration | undefined =
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol).valueDeclaration
      : symbol?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.name === node ||
    declaration.initializer === undefined ||
    !ts.isClassExpression(declaration.initializer) ||
    !isClassFormationDeclarator(declaration, checker)
  ) {
    return undefined;
  }
  return declaration.initializer;
}

/** The class expression whose INNER name `node` spells (`D` in `const C = class D { … }`),
 * when `node` sits inside that expression but is not the name itself: the inner binding is
 * visible only in the class body, and every in-place use of it erases to the expression like
 * any other spelling of it. Outside the body the name resolves nowhere (a checker error in
 * ts mode, a runtime ReferenceError in js), so no scope work is needed — uses carry their
 * own containment proof. */
export function innerClassExpression(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ClassExpression | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  const expression =
    declaration !== undefined && ts.isClassExpression(declaration)
      ? declaration
      : declaration !== undefined &&
          ts.isIdentifier(declaration) &&
          ts.isClassExpression(declaration.parent)
        ? declaration.parent
        : undefined;
  if (
    expression === undefined ||
    expression.name === undefined ||
    expression.name.text !== node.text ||
    node === expression.name
  ) {
    return undefined;
  }
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (current === expression) {
      return expression;
    }
    current = current.parent;
  }
  return undefined;
}

/** The spelling Node gives a class expression's `.name`: the inner name, else the bound
 * variable. An unbound expression (a heritage base, a call argument, a default export) has
 * no identity this subset keys on — the type model answers Unknown for those, and the gate
 * refuses them where a value would be read. */
export function expressionClassName(expression: ts.ClassExpression): string | undefined {
  if (expression.name !== undefined) {
    return expression.name.text;
  }
  const parent = expression.parent;
  if (
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.initializer === expression
  ) {
    return parent.name.text;
  }
  return undefined;
}

/** The spelling a class-like answers to in source positions: the declared name for a
 * declaration, Node's `.name` (inner name, else bound variable) for an expression, and
 * `*default*` for the anonymous `export default class {}` — ES's own binding name, which
 * the descriptor keys on and `descriptorName` prints as Node's `.name` (`default`).
 * `undefined` for any other anonymous declaration or an unbound expression — shapes with
 * no identity, which the gate refuses before any consumer asks. */
export function classDisplayName(
  node: ts.ClassDeclaration | ts.ClassExpression,
): string | undefined {
  if (ts.isClassExpression(node)) {
    return expressionClassName(node);
  }
  if (node.name !== undefined) {
    return node.name.text;
  }
  return isDefaultExportDeclaration(node) ? DEFAULT_EXPORT_BINDING : undefined;
}

/** The type of `new P()` for a JavaScript constructor function `P`: TypeScript gives the
 * function's symbol the Class flag in a `.js` file whose body assigns to `this`, with no class
 * declaration behind it. */
function isFunctionConstructorInstance(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) === 0) {
    return false;
  }
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && !declarations.some((d) => ts.isClassLike(d));
}

/** True for a symbol only declaration files declare: a builtin (`RegExp`, `Function.prototype.call`,
 * `console.log`) rather than something the program wrote. */
function declaredOnlyInDeclarationFiles(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** Whether `new callee(...)` and `x instanceof callee` dispatch through a function VALUE at run
 * time (`jsrt_construct`, `jsrt_instanceof_ctor`; plan-notes 310): an ordinary function the
 * program wrote, or a value of unknown type. A class keeps its descriptor path, and a builtin
 * constructor (declared only in a declaration file) keeps its own rules. */
export function isFunctionValueCallee(callee: ts.Expression, checker: ts.TypeChecker): boolean {
  if (declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(callee))) {
    return false;
  }
  const type = checker.getTypeAtLocation(callee);
  if (classLikeOf(type) !== undefined || declaredOnlyInDeclarationFiles(type.getSymbol())) {
    return false;
  }
  const shape = tsTypeToHType(type, checker);
  return shape.kind === 'fn' || shape.kind === 'unknown';
}

/** A member of an ordinary function value -- `f.count`, `F.prototype`, `assert.sameValue` -- which
 * lives in the closure's own properties at run time (plan-notes 310), not in any layout. The
 * receiver is a function the program wrote: a class object has its descriptor's statics, and a
 * builtin function has no property table. `length` keeps its static arity read, and the other
 * `Function.prototype` members (`call`, `apply`, `bind`, ...) are not own properties at all. */
export function isFunctionValueMember(
  receiver: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
): boolean {
  if (name === 'length') {
    return false;
  }
  const type = checker.getTypeAtLocation(receiver);
  if (classLikeOf(type) !== undefined || tsTypeToHType(type, checker).kind !== 'fn') {
    return false;
  }
  if (declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(receiver))) {
    return false;
  }
  if (name === 'prototype' || name === 'name') {
    return true;
  }
  return !declaredOnlyInDeclarationFiles(checker.getPropertyOfType(type, name));
}

/** A member the receiver's fixed layout does not declare -- `host.configFileName` on an object
 * literal's type, `c.extra` on a class instance. Only a `js`-mode program reaches the lowering with
 * one (in `ts` mode it is the checker's TS2339): the write grows the object's overflow table and
 * the read answers from it, or `undefined`, through the shape-table entries (docs/VALUE.md §4.24).
 * A module namespace is no object at run time, so its absent export is no such member. */
export function isUndeclaredMember(
  receiver: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
): boolean {
  const type = checker.getTypeAtLocation(receiver);
  const shape = tsTypeToHType(type, checker);
  return (
    shape.kind === 'object' &&
    shape.namespace !== true &&
    checker.getPropertyOfType(type, name) === undefined
  );
}

/** Whether `expr` READS a member its receiver's layout does not declare (isUndeclaredMember). */
export function isUndeclaredMemberRead(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    !ts.isPrivateIdentifier(expr.name) &&
    isUndeclaredMember(expr.expression, expr.name.text, checker)
  );
}

/** Whether `expr` READS a member of an ordinary function value (`F.prototype`, `f.cache`). The
 * value is whatever the program last stored there, so the checker's type for it -- inferred from
 * one assignment such as `F.prototype = { … }` -- is no layout, and every use of it goes through
 * the shape table like an Unknown receiver (plan-notes 310). */
export function isFunctionMemberRead(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    isFunctionValueMember(expr.expression, expr.name.text, checker)
  );
}

/** The class-like (declaration or expression) a type came from, or `undefined` for anything
 * else. Beside `classDeclarationOf`: existing declaration-only consumers keep their shape,
 * and only the use sites class expressions newly reach migrate to this one. */
export function classLikeOf(type: ts.Type): ts.ClassDeclaration | ts.ClassExpression | undefined {
  const declaration = type.getSymbol()?.valueDeclaration;
  return declaration !== undefined &&
    (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
    ? declaration
    : undefined;
}

/** Whether `node` uses a `const K = C` alias: it resolves to a class, but is not the class's
 * own name. The gate accepts exactly the uses that erase and refuses the rest; the capture
 * analysis skips these references, since an erased name needs no environment slot.
 *
 * An `import`/`export` specifier carries the Alias flag with no `valueDeclaration` of its own,
 * so the direct-declaration test below resolves through the alias first: only a name that
 * reaches a class declaration WITHOUT passing through a variable is the class's own. */
export function isClassAliasUse(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (aliasedClassDeclaration(node, checker) === undefined) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node);
  const direct =
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) === 0
      ? symbol.valueDeclaration
      : undefined;
  return direct === undefined || !ts.isClassDeclaration(direct);
}

/** The static member `C.name` names, walking the chain -- statics are inherited in JavaScript, so
 * `D.count` on `class D extends C` reads the ONE binding `C` declared. `wantMethod` narrows to a
 * method (`true`), a field (`false`), or either (`undefined`).
 *
 * Returns the member together with the class that declares it, because the declaring class is half
 * the binding's name: mangling by the receiver's spelling would give `D.count` and `C.count` two
 * bindings for one static. */
export function staticMemberOf(
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  wantMethod: boolean | undefined,
):
  | {
      owner: ts.ClassDeclaration | ts.ClassExpression;
      member: ts.ClassElement;
    }
  | undefined {
  // `this.x` / `super.x` inside a STATIC context name a static of the class (or its base),
  // the same binding `C.x` reads (plan.md §8 step 12(d)). The receiver is the class object,
  // which this subset does not build -- so the access erases to the declaration, exactly as
  // a bound class expression's in-place use does. An INSTANCE context's `this` is the
  // receiver parameter and takes the ordinary member path below.
  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = staticThisClass(access);
    return owner === undefined
      ? undefined
      : staticMemberIn(owner, access.name.text, wantMethod, checker);
  }
  if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const owner = staticSuperClass(access, checker);
    return owner === undefined
      ? undefined
      : staticMemberIn(owner, access.name.text, wantMethod, checker);
  }
  if (!ts.isIdentifier(access.expression)) {
    return undefined;
  }
  // A class alias names the same declaration its target does: `K.sm` on `const K = C` is the
  // one binding `C.sm`, so the direct check below keeps its exact shape and the alias resolves
  // beside it. A class expression's binding names the expression the same way (`C.sm` on
  // `const C = class …`), through `classExpressionTarget` (or the inner name). Anything
  // else -- including the binding's own formation -- resolves nowhere.
  const direct = checker.getSymbolAtLocation(access.expression)?.valueDeclaration;
  const declaration =
    direct !== undefined && ts.isClassDeclaration(direct)
      ? direct
      : (classExpressionTarget(access.expression, checker) ??
        innerClassExpression(access.expression, checker) ??
        aliasedClassDeclaration(access.expression, checker));
  if (declaration === undefined) {
    return undefined;
  }
  return staticMemberIn(declaration, access.name.text, wantMethod, checker);
}

/** The static `name` of `declaration`, walking the chain -- statics are inherited, so `D.count`
 * on `class D extends C` reads the ONE binding `C` declared. Shared by the identifier path and
 * the `this`/`super` erasure above. */
function staticMemberIn(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  wantMethod: boolean | undefined,
  checker: ts.TypeChecker,
):
  | {
      owner: ts.ClassDeclaration | ts.ClassExpression;
      member: ts.ClassElement;
    }
  | undefined {
  for (const current of ancestry(declaration, checker).reverse()) {
    // An identifier names itself; a literal-typed computed key (`static [k]` with `k: "m"`)
    // is the name the direct spelling writes, so it matches the same read. String/numeric
    // literal spellings keep their old verdict -- this predicate only learns the computed
    // case, never a second spelling for what is already refused.
    const member = current.members.find(
      (m) =>
        isStaticMember(m) &&
        m.name !== undefined &&
        (((ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) && m.name.text === name) ||
          (ts.isComputedPropertyName(m.name) && computedKeyStaticName(m.name, checker) === name)),
    );
    if (member !== undefined) {
      return wantMethod === undefined || ts.isMethodDeclaration(member) === wantMethod
        ? { owner: current, member }
        : undefined;
    }
  }
  return undefined;
}

/** The class whose statics `this.x` names inside a STATIC context: the enclosing class body's
 * owner. `undefined` outside one, or in an INSTANCE context where `this` is the receiver
 * parameter and takes the ordinary member path. Bare `this` in a static is the class object,
 * which stays refused (plan.md §8 step 12(d)). */
export function staticThisClass(
  access: ts.PropertyAccessExpression,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  for (let n: ts.Node | undefined = access.parent; n !== undefined; n = n.parent) {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      return n;
    }
    // An instance member's `this` is the receiver, not the class object — stop here.
    // A static member continues the walk: its `this` is the class being defined.
    if (
      ts.isConstructorDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isPropertyDeclaration(n)
    ) {
      if (!isStaticMember(n)) {
        return undefined;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) {
      return undefined;
    }
  }
  return undefined;
}

/** The class whose statics `super.x` names inside a static context: the base of the enclosing
 * class. `undefined` when there is no enclosing class or no base -- bare `super` in a static is
 * a JavaScript SyntaxError and stays refused. */
export function staticSuperClass(
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  const self = staticThisClass(access);
  return self === undefined ? undefined : baseClassOf(self, checker);
}

/** Which class in `declaration`'s ancestry declares the method `name` that `declaration` responds
 * to -- the MOST DERIVED one, since the walk starts at `declaration` itself.
 *
 * That is the implementation a receiver of this exact class runs, which is what both a direct call
 * and a method-table entry need. It is not necessarily the only declaration: an override means two
 * classes in one chain declare the name, and the call site is direct only where no such second
 * declaration exists anywhere in the family (see `isOverridden` in the lowering). */
export function methodDeclaringClass(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  // An accessor is a method under a mangled name (`get x`), and every walk of an HType's method
  // list meets those names -- the class table does, which is where this used to answer `undefined`
  // and the caller fell back to the class it was asked about: the emitter then looked for an
  // INHERITED accessor in a subclass that never declared it and threw STA4072. The walk below can
  // only match a method declaration, so the mangled form is routed to the accessor resolver, which
  // speaks the source name. `accessorDeclaringClass` answers the most derived declaration, which
  // is the implementation this class's receivers run -- the same answer the method walk below
  // gives for methods, override family or not.
  const property = accessorProperty(name);
  if (property !== undefined) {
    return accessorDeclaringClass(declaration, property, checker)?.owner;
  }
  for (const current of ancestry(declaration, checker).toReversed()) {
    if (
      current.members.some(
        (m) => ts.isMethodDeclaration(m) && instanceMethodName(m, checker) === name,
      )
    ) {
      return current;
    }
  }
  return undefined;
}

/** Which class in `declaration`'s ancestry declares the accessor `name`, and which halves it has.
 *
 * `undefined` means the name is not an accessor at all -- a field or a method, which take the
 * ordinary paths. */
export function accessorDeclaringClass(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  checker: ts.TypeChecker,
): { owner: ts.ClassDeclaration | ts.ClassExpression; get: boolean; set: boolean } | undefined {
  for (const current of ancestry(declaration, checker).toReversed()) {
    // Identifiers and #private names alike: a private accessor (`get #x`) is a member function
    // under a mangled name exactly as a public one is (plan.md §8 step 12(d)). A literal-typed
    // computed name (`get [k]` with `k: "x"`) is the name the direct spelling writes, so it
    // matches the same read; anything wider has no name to match under.
    const named = current.members.filter(
      (m) =>
        (ts.isGetAccessor(m) || ts.isSetAccessor(m)) &&
        (((ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) && m.name.text === name) ||
          (ts.isComputedPropertyName(m.name) && computedKeyStaticName(m.name, checker) === name)),
    );
    if (named.length > 0) {
      return {
        owner: current,
        get: named.some(ts.isGetAccessor),
        set: named.some(ts.isSetAccessor),
      };
    }
  }
  return undefined;
}

/** The name of the `<T>` this type IS, or `undefined` for a type-parameter-flagged type that no
 * `<…>` list declares — which is how TypeScript models polymorphic `this`. */
function declaredTypeParameterName(type: ts.Type): string | undefined {
  const declarations = type.getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(ts.isTypeParameterDeclaration)
    ? type.getSymbol()?.getName()
    : undefined;
}

/** `null` means "not an array this model can describe" — the caller falls through to Unknown.
 *
 * `checker.isArrayType` is true for `T[]` and `Array<T>` and false for a TUPLE, which is the
 * distinction that matters: a tuple has a different type per position, and `HArray` holds one
 * element type for every position. Treating `[number, string]` as an array would silently type
 * `t[1]` as `number`.
 *
 * The recursion depth is shared with function types on purpose. `type T = T[]` is legal and would
 * otherwise descend forever, and an array of functions of arrays can nest through both. */
function arrayTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth: number): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH || !checker.isArrayType(type)) {
    return null;
  }
  const [element] = checker.getTypeArguments(type as ts.TypeReference);
  if (element === undefined) {
    return null;
  }
  return hArray(tsTypeToHType(element, checker, depth + 1));
}

/** `Map<K, V>` and `Set<T>` — the two builtin collections the subset compiles (rung 7).
 *
 * The name alone is not the test, and the difference matters: `class Map { … }` in user code is a
 * perfectly ordinary class, and typing it as the builtin would hand the emitter a `jsrt_map_*` call
 * against an object that has no table. The builtin is DECLARED, never defined: every one of its
 * declarations — the lib splits `Map` across four, three interfaces and the `var Map` that carries
 * the constructor — lives in a `.d.ts`, while a user's class has a body, and a body only exists in
 * a source file. (`hasNoDefaultLib` looks like the test for this and is not: it is false for every
 * split lib file, `lib.es2015.collection.d.ts` included.) A `declare class Map` in the user's own
 * `.d.ts` cannot sneak past: it collides with the lib's interface and is a TypeScript error before
 * it reaches here.
 *
 * A missing type argument is `null` rather than a guess: `Map` written bare is `Map<any, any>` to
 * the checker, and that reaches here as Unknown through the ordinary argument mapping — it is not
 * this function's business to decide what an unresolved key type means. */
/** Is this the lib's `X`, rather than a user's class or interface of the same name?
 *
 * The name alone is not the test: `class Map { … }` in user code is an ordinary class, and typing
 * it as the builtin would hand the emitter a `jsrt_map_*` call against an object with no table. The
 * builtin is DECLARED and never defined — every one of its declarations lives in a `.d.ts` — while
 * a user's class has a body, and a body only exists in a source file. (`hasNoDefaultLib` looks like
 * the test for this and is not: it is false for every split lib file.) */
function isBufferType(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every(
      (t) => isLibInterface(t, 'ArrayBuffer') || isLibInterface(t, 'SharedArrayBuffer'),
    );
  }
  return isLibInterface(type, 'ArrayBuffer');
}

function isLibInterface(type: ts.Type, name: string): boolean {
  const symbol = type.getSymbol();
  if (symbol?.getName() !== name) {
    return false;
  }
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** Whether `node` is typed as the lib's WeakMap or WeakSet, which the HType model folds into Map
 * and Set (see collectionTypeToHType): the one bit a `collection-new` records. */
export function isWeakCollection(node: ts.Node, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node);
  return isLibInterface(type, 'WeakMap') || isLibInterface(type, 'WeakSet');
}

function iteratorTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth: number): HType | null {
  const name = type.getSymbol()?.getName();
  if (
    name !== 'ArrayIterator' &&
    name !== 'MapIterator' &&
    name !== 'SetIterator' &&
    name !== 'RegExpStringIterator' &&
    name !== 'Generator'
  ) {
    return null;
  }
  if (!isLibInterface(type, name)) {
    return null;
  }
  const [element] = checker.getTypeArguments(type as ts.TypeReference);
  return hIterator(
    element !== undefined ? tsTypeToHType(element, checker, depth + 1) : hUnknown(false),
  );
}

function collectionTypeToHType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH) {
    return null;
  }
  const name = type.getSymbol()?.getName();
  if (
    name !== 'Map' &&
    name !== 'Set' &&
    name !== 'WeakMap' &&
    name !== 'WeakSet' &&
    name !== 'Promise'
  ) {
    return null;
  }
  if (!isLibInterface(type, name)) {
    return null;
  }
  const args = checker.getTypeArguments(type as ts.TypeReference);
  if (name === 'Promise') {
    // `Promise<void>` is the return type of every async function that returns nothing, and `void`
    // is not a kind: it is `undefined` everywhere else the model meets it.
    const [value] = args;
    return value === undefined ? null : hPromise(tsTypeToHType(value, checker, depth + 1));
  }
  // A WeakMap/WeakSet is a Map/Set the checker keeps every walk off (docs/VALUE.md §4.22).
  if (name === 'Set' || name === 'WeakSet') {
    const [element] = args;
    return element === undefined ? null : hSet(tsTypeToHType(element, checker, depth + 1));
  }
  const [key, value] = args;
  if (key === undefined || value === undefined) {
    return null;
  }
  return hMap(tsTypeToHType(key, checker, depth + 1), tsTypeToHType(value, checker, depth + 1));
}

/** `null` means "not a function this model can describe" — the caller falls through to Unknown.
 *
 * OVERLOADS ARE DELIBERATELY EXCLUDED. A type with two call signatures is two functions sharing a
 * name, and `HFunction` holds one signature; picking the first would silently compile every call
 * as if the other overload did not exist. Overload resolution belongs at the call site, where the
 * checker already did it, and arrives with the pass that asks the checker per call. */
function functionTypeToHType(type: ts.Type, checker: ts.TypeChecker, depth: number): HType | null {
  if (depth >= MAX_SIGNATURE_DEPTH) {
    return null;
  }
  const signatures = type.getCallSignatures();
  const signature = signatures.length === 1 ? signatures[0] : undefined;
  // A class CONSTRUCTOR type (`typeof K`) never calls -- it constructs -- so its one construct
  // signature is its callable shape, and the return is the INSTANCE a `new` through the value
  // builds (docs/VALUE.md §4.17). Multi-signature refusal is the rule for both halves alike: an
  // overloaded constructor is two functions sharing a name exactly as an overloaded call is.
  const chosen =
    signature ??
    (type.getConstructSignatures().length === 1 ? type.getConstructSignatures()[0] : undefined);
  if (chosen === undefined) {
    return null;
  }
  const params = chosen.getParameters().map((symbol) => {
    const declaration = symbol.valueDeclaration;
    if (declaration === undefined) {
      return hUnknown(false);
    }
    return tsTypeToHType(
      checker.getTypeOfSymbolAtLocation(symbol, declaration),
      checker,
      depth + 1,
    );
  });
  return hFunction(params, tsTypeToHType(chosen.getReturnType(), checker, depth + 1));
}

/** Check if a type is implicitly any (no annotation, inferred as any).
 * Used by the gate to distinguish STA1001 (explicit any) from STA1003 (implicit any).
 */
export function isImplicitAny(node: ts.Node, typeChecker: ts.TypeChecker): boolean {
  // Only a node that COULD have carried an annotation can have an *implicit* any. Asking the
  // checker about anything else is both meaningless and unsafe: getTypeAtLocation walks
  // `node.parent`, which a SourceFile does not have, and throws.
  const annotation = annotationSiteOf(node);
  if (annotation === null || annotation !== undefined) {
    return false; // not an annotation site, or annotated explicitly
  }
  // `const x = 1 as any` has no annotation on the BINDING — the `any` is on the initializer —
  // so this would otherwise fire STA1003 (implicit) while the AsExpression child also fires
  // STA1001 (explicit). The explicit one is the truth: the author wrote `any`. Skip here so
  // the child is the only diagnostic (plan.md §8 step 2).
  if (initializerIsExplicitAny(node)) {
    return false;
  }
  // A destructuring declaration's own node is often `any` even when every binding is typed
  // (`const { x } = p` with `p: Point`). Ask the initializer, which is the value being split.
  // A catch pattern has no initializer; the binding is Unknown by decree, not implicit any.
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
    if (ts.isCatchClause(node.parent)) {
      return false;
    }
    if (node.initializer !== undefined) {
      return (typeChecker.getTypeAtLocation(node.initializer).flags & ts.TypeFlags.Any) !== 0;
    }
  }
  return (typeChecker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0;
}

function initializerIsExplicitAny(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node) && !ts.isParameter(node) && !ts.isPropertyDeclaration(node)) {
    return false;
  }
  const initializer = node.initializer;
  if (initializer === undefined) {
    return false;
  }
  return (
    (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)) &&
    isAnyKeyword(initializer.type)
  );
}

function isAnyKeyword(typeNode: ts.TypeNode): boolean {
  return ts.isToken(typeNode) && typeNode.kind === ts.SyntaxKind.AnyKeyword;
}

/** `null` = this node is not a place an annotation can go. `undefined` = it is, and there is none.
 * Otherwise the annotation itself. The three-way answer is what lets the caller tell "annotated
 * with something else" apart from "nothing to annotate". */
function annotationSiteOf(node: ts.Node): ts.TypeNode | null | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    // A `for-of` binding cannot carry an annotation (`for (const x: T of ...)` is a grammar
    // error), so it can never be *implicit* any in the sense this question asks: when iteration
    // itself is refused (TS2488/TS2571, plan.md §8 step 2a(c)) the checker types the binding `any`
    // as error recovery, and reporting STA1003 for it would bury the STA0012 that names the real
    // refusal (`explain` ranks the never above the error). Every other any-binding has a
    // companion diagnostic -- explicit `any` is STA1001 even in ambient declarations, an untyped
    // source is STA1003 on its own site -- so nothing goes silent here.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isForOfStatement(node.parent.parent)
    ) {
      return null;
    }
    return node.type;
  }
  return null;
}

/** Check if a type annotation is explicitly `any`.
 * Used by the gate to emit STA1001 for explicit `any` in ts mode.
 */
export function hasExplicitAny(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    const typeNode = (node as ts.VariableDeclaration | ts.ParameterDeclaration).type;
    if (typeNode && isAnyKeyword(typeNode)) {
      return true;
    }
  }
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const typeNode = (node as ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression)
      .type;
    if (typeNode && isAnyKeyword(typeNode)) {
      return true;
    }
  }
  // `as any` and `<any>x` — the latter is the same claim in the angle-bracket spelling.
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return isAnyKeyword(node.type);
  }
  return false;
}
