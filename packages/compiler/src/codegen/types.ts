/** Shared codegen types for the C emitter (T24 split). */

import type {
  ArrayOp,
  CallExpr,
  CollectionOp,
  ConsoleLogCall,
  DateComponents,
  DateNew,
  DateOp,
  DateStaticCall,
  DynMethodCall,
  DynObjectLiteral,
  ErrorNew,
  ExternCall,
  FieldCall,
  FunctionExpr,
  GlobalCall,
  InstanceOfValue,
  IteratorNext,
  JsonParse,
  JsonStringify,
  MathCall,
  MethodCall,
  NewExpr,
  NewValue,
  NumberOp,
  ObjectLiteral,
  ObjectStaticCall,
  PromiseConstruct,
  PromiseMethodCall,
  PromiseStaticCall,
  RegExpLiteral,
  RegExpOp,
  StringOp,
  StringStaticCall,
  SuperCall,
  TypedOp,
} from '../hir/nodes.ts';
import type { UnitExports } from '../frontend/export.ts';

export interface FunctionUnit {
  readonly id: number;
  readonly fn: FunctionExpr;
  readonly name: string;
}

/* One open try-with-finally during emission. A jump (return/break/continue) out of the protected
 * code cannot simply `goto` its target -- the finally body must run first -- so it records WHICH
 * jump in the completion variable and gotos the finally instead; `routes` maps each distinct jump
 * (keyed by its goto label, or 'return') to the completion code that selects it in the dispatch
 * and the emitter action that re-performs it there. The action runs with this scope already
 * popped, so a jump crossing two finallys routes through both, innermost first. */
export interface TryFinallyScope {
  readonly compVar: string;
  /** A try's completion code lives in a counted slot, boxed as a number, so it survives a
   * suspension between the route and the dispatch; the Map/Set for-of cleanup's comp is a raw
   * C int, which is safe only because that loop never suspends (the suspendable units box the
   * walk into a heap iterator instead). The boxed-iterator cleanup below is that boxed walk,
   * so its comp is a counted slot too. */
  readonly compBoxed: boolean;
  readonly finLabel: string;
  /** `this.enclosing.length` when the try opened: a break/continue leaves the try exactly when
   * its target construct's index in `enclosing` is below this depth. */
  readonly enclosingDepth: number;
  readonly routes: Map<string, { readonly code: number; readonly action: () => void }>;
}

/** Every node that claims a contiguous run of rooted call slots (see `callSlots`). */
export type CallSlotted =
  | ArrayOp
  | InstanceOfValue
  | NewValue
  | CallExpr
  | ConsoleLogCall
  | JsonParse
  | JsonStringify
  | CollectionOp
  | DateComponents
  | DateNew
  | DateOp
  | NumberOp
  | DateStaticCall
  | GlobalCall
  | DynMethodCall
  | DynObjectLiteral
  | FieldCall
  | ErrorNew
  | ExternCall
  | MathCall
  | MethodCall
  | NewExpr
  | ObjectLiteral
  | ObjectStaticCall
  | PromiseConstruct
  | PromiseMethodCall
  | PromiseStaticCall
  | RegExpLiteral
  | RegExpOp
  | StringOp
  | StringStaticCall
  | SuperCall
  | TypedOp
  | IteratorNext;

/** A `--emit-header` unit the object exposes to C (plan.md §10 Task 7.2 steps 3–5): the
 * sanitized unit name plus the C-visible set `collectUnitExports` decided. Present only in
 * library builds; an executable build passes none and keeps its `main`. */
export interface LibraryEmit {
  readonly unit: string;
  readonly exports: UnitExports;
}
