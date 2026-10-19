/* Class and object-shape descriptors, methods, and vtables.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import type {
  ClassDeclaration,
  ClassMethod,
  MethodCall,
  MethodValue,
  ObjectLiteral,
  VtableEntry,
} from '../hir/nodes.ts';
import {
  cNameLiteral,
  hiddenMethodField,
  keyOrderOf,
  shapeFieldsOf,
  shapeNameOf,
} from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgClosure from './closures.ts';

/** The layout is the TYPE's field order, because that is what a later `o.x` resolves against
 * (`slotOf` in the lowering indexes `type.fields`). The literal's own key order is a second,
 * independent fact -- enumeration order -- and the two differ whenever the annotation or a
 * spread listed the keys in another order, so the descriptor carries both (plan-notes 181). */

export function registerShape(self: Emitter, expr: ObjectLiteral): void {
  const layout = shapeFieldsOf(expr);
  const order = keyOrderOf(expr, layout);
  // Two literals of the same TYPE can still have different insertion orders, so the descriptor
  // is keyed by both -- one shape name would otherwise print the second literal in the first's
  // order.
  const name = `${shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
  if (self.classIds.has(name)) {
    return;
  }
  const id = self.classes.length;
  self.classIds.set(name, id);
  // A literal's methods ride in hidden trailing slots, bound per evaluation (plan.md §8 step 36):
  // one shared function cannot close over each instance's own environment. Every literal of one
  // shape lays the same methods out in the same order, so the indices are uniform however many
  // descriptors the shape has -- and the call sites resolve them by shape name for the same
  // reason. The order is the TYPE's method order: own members lower in written order, which is
  // that order, and spread copies (plan.md §8 step 12c S-C) have no function of their own to
  // order by -- so the type is the one order both agree on. A stored key order must cover
  // EVERY slot, hidden ones included: the runtime walks `field_count` entries through it, so
  // a user-only order would read past its end.
  const shapeName = shapeNameOf(expr);
  const fields = layout.map((field) => ({ name: field.name, type: field.type, span: expr.span }));
  const shapeMethods = expr.type.kind === 'object' ? expr.type.methods : [];
  const ownByName = new Map(expr.methods.map((method) => [method.name, method] as const));
  if (shapeMethods.length > 0) {
    const full = [...(order ?? layout.map((_, index) => index))];
    const hidden = new Map<string, number>();
    shapeMethods.forEach((method, index) => {
      hidden.set(method.name, layout.length + index);
      full.push(layout.length + index);
      fields.push({
        name: hiddenMethodField(method.name),
        type: ownByName.get(method.name)?.fn.type ?? method.type,
        span: expr.span,
      });
    });
    self.classKeyOrders.set(id, full);
    self.classHiddenMethods.set(shapeName, hidden);
  } else if (order !== undefined) {
    self.classKeyOrders.set(id, order);
  }
  self.classes.push({
    kind: 'class-declaration',
    type: expr.type,
    span: expr.span,
    name,
    fields,
    methods: expr.methods,
    statics: [],
    staticProps: [],
    vtable: [],
  });
}

/** The one function a direct call names: the class the lowering resolved, and that class's own
 * body. `classAt` is what turns a disagreement between counting and emission into a throw. */
export function methodOf(self: Emitter, expr: MethodCall | MethodValue): ClassMethod {
  const method = classAt(self, expr.className).methods.find((m) => m.name === expr.method);
  if (method === undefined) {
    throw new Error(`class ${expr.className} has no method ${expr.method}`);
  }
  return method;
}

/** The callee a direct method call invokes. Usually the method's own closure -- a shared constant
 * when it captures nothing, a fresh closure over the CALLER's environment otherwise. But a method
 * on an object literal was bound at CONSTRUCTION into a hidden instance slot (plan.md §8 step 36),
 * so rebuilding it here would close over the wrong environment: `counter().get()` read NULL and
 * segfaulted exactly this way. The slot holds the definition-site closure (or the shared constant
 * for a method that captures nothing), and the receiver below is still passed as argument zero.
 * `jsrt_object_get_field` is a pure slot load -- no allocation between the load and the call --
 * so nesting it in the call needs no extra rooted slot, exactly like the virtual arm's
 * `jsrt_method` above. Classes never hit the hidden arm: their instances carry no per-evaluation
 * state, so `classHiddenMethods` holds no class name. */
export function methodCallee(self: Emitter, expr: MethodCall, receiver: string): string {
  const hidden = self.classHiddenMethods.get(expr.className)?.get(expr.method);
  if (hidden !== undefined) {
    return `jsrt_object_get_field(${receiver}, ${String(hidden)}, ${cNameLiteral(expr.method)})`;
  }
  return cgClosure.closureValue(self, methodOf(self, expr).fn);
}

/** The closure constant a method-table entry names: the implementing class's own function.
 *
 * A table entry must be a file-scope constant to name one, so a method that captures has none:
 * the entry is NULL and the dynamic get skips it, leaving the instance's hidden `#method:`
 * slot -- which carries the construction-site environment -- as the hit. The gate guarantees
 * a virtual family never captures (overriding outside module scope is refused), so a NULL
 * entry is never loaded through `jsrt_method`; it is only skipped by name lookup. A missing
 * method still throws: the lowering proved it exists, so absence is a compiler bug. */
export function methodIdOrNull(self: Emitter, entry: VtableEntry): number | null {
  const method = classAt(self, entry.className).methods.find((m) => m.name === entry.name);
  if (method === undefined) {
    throw new Error(`class ${entry.className} has no method ${entry.name}`);
  }
  if (method.fn.needsEnv) {
    return null;
  }
  return cgClosure.functionId(self, method.fn);
}

/** `&_jsrt_class_N` for the base class, or `NULL` at the root of a chain. Throws when the base
 * has no descriptor yet, which would mean classes were emitted out of declaration order. */
export function baseDescriptor(self: Emitter, cls: ClassDeclaration, id: number): string {
  if (cls.base === undefined) {
    return 'NULL';
  }
  const baseId = self.classIds.get(cls.base);
  if (baseId === undefined || baseId >= id) {
    throw new Error(`class ${cls.name} is emitted before its base ${cls.base}`);
  }
  return `&_jsrt_class_${baseId}`;
}

/* The declaration a class name refers to. A miss means counting and emission disagree about
 * which classes exist, which is an emitter bug rather than anything the program did. */
export function classAt(self: Emitter, name: string): ClassDeclaration {
  const id = self.classIds.get(name);
  const cls = id === undefined ? undefined : self.classes[id];
  if (cls === undefined) {
    throw new Error(`class ${name} was not registered during counting`);
  }
  return cls;
}
