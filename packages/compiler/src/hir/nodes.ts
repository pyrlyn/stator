/** Typed HIR node definitions for Phase 2 micro-subset (plan.md §5 Task 2.3).
 *
 * Every node carries an HType and a source span {start, length} for error reporting
 * and #line source mapping in the C emitter.
 *
 * Expressions and statements are separate unions — statements are not expressions
 * in this IR.
 */

import type { HObject, HType } from './types.ts';
import {
  H_ARRAYBUFFER,
  H_BOOLEAN,
  H_NUMBER,
  H_STRING,
  H_UINT8ARRAY,
  H_UNDEFINED,
  hUnknown,
} from './types.ts';

/* jscpd:ignore-start
 *
 * Everything below is DECLARATION, not code: this file holds the HIR's discriminated union and
 * nothing else -- no function, no constant, nothing a copy/paste detector can be right about. A
 * union member is `interface X extends Node { readonly kind: '...'; ... }` by construction, and
 * the `kind` is what makes the union discriminated, so the repetition cannot be factored out
 * without deleting the thing that makes the IR type-safe. jscpd charges that similarity by LINE,
 * so a 50-token structural match here was billed as 623 duplicated lines (plan-notes 71). The
 * markers cover the declarations only; a function added to this file would still be checked. */

/** Source span for diagnostics and #line maps.
 *
 * `start`/`length` are 0-indexed UTF-16 offsets, matching TypeScript's own coordinate system so
 * the frontend can copy them across without conversion. `line` is 1-indexed, because it exists
 * for `#line` directives in emitted C and clang counts from 1 — the emitter must never have to
 * recompute it, since that would mean carrying the source text below the frontend. */
export interface Span {
  readonly start: number;
  readonly length: number;
  readonly line: number;
  /** The file this span points into. Absent only in hand-built HIR (tests); the lowering always
   * sets it, and the emitter falls back to the module's fileName when it is missing. */
  readonly file?: string;
}

/** Base interface for all HIR nodes. */
interface Node {
  readonly type: HType;
  readonly span: Span;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expressions

export interface NumberLiteral extends Node {
  readonly kind: 'number-literal';
  readonly value: number;
}

export interface StringLiteral extends Node {
  readonly kind: 'string-literal';
  readonly value: string;
}

export interface BooleanLiteral extends Node {
  readonly kind: 'boolean-literal';
  readonly value: boolean;
}

/** `null`. A keyword, so it is unambiguous in the source. */
export interface NullLiteral extends Node {
  readonly kind: 'null-literal';
}

/** `undefined`. Not a keyword — it is a global binding, which is why the lowering has to resolve
 * the identifier rather than pattern-match a token, and why a local named `undefined` shadows it
 * exactly as any other global would. */
export interface UndefinedLiteral extends Node {
  readonly kind: 'undefined-literal';
}

export interface Identifier extends Node {
  readonly kind: 'identifier';
  readonly name: string;
}

/** The operators BinaryOp models: both operands are always evaluated, exactly once, left to right.
 *
 * `&&`, `||` and `??` are absent on purpose — see LogicalOp. */
export type BinaryOperator =
  // Arithmetic. `/` is always f64 division and `%` is fmod, never C's integer forms
  // (docs/NUMERIC.md §3).
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  // Relational. All four are false when either operand is NaN (docs/NUMERIC.md §6.1).
  | '<'
  | '>'
  | '<='
  | '>='
  // Equality. `==` coerces per the docs/NUMERIC.md §6.3 table; `===` never coerces.
  | '==='
  | '!=='
  | '=='
  | '!='
  // Bitwise. Every operand goes through ToInt32/ToUint32 first, and the result is a NUMBER,
  // not an integer type — `>>>` can exceed int32 range (docs/NUMERIC.md §4).
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '>>>'
  // Exponentiation. Same helper as `Math.pow` (docs/NUMERIC.md §3): C `pow` is wrong on
  // `±1 ** ±Infinity` and `1 ** NaN`.
  | '**'
  // Comma: evaluate left for effects, yield right.
  | ','
  // `prop in obj`. The left operand is ToString'd; the right must be an object.
  | 'in';

export interface BinaryOp extends Node {
  readonly kind: 'binary-op';
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

/** Prefix unary operators.
 *
 * `-` is here even though the lowering folds `-<numeric literal>` into a NumberLiteral: that fold
 * is a spelling convenience for constants, and `-x` on a variable is a real operation. Note that
 * `-` is the only way to produce `-0` from a positive zero (docs/NUMERIC.md §3.4), so it must
 * never be optimized away as identity. */
export interface UnaryOp extends Node {
  readonly kind: 'unary-op';
  readonly operator: '-' | '+' | '!' | '~' | 'void';
  readonly operand: Expression;
}

/** `typeof x` — not a UnaryOp, for two reasons that both matter downstream.
 *
 * It does not coerce: every other prefix operator runs ToNumber or ToBoolean on its operand and so
 * constrains what may reach it, while `typeof` is total on every value there is and constrains
 * nothing. And its result is a `string`, where UnaryOp's is fixed to `number` or `boolean` by the
 * verifier's own rule — folding this in would mean weakening that rule for all four.
 *
 * The `type` is always `string`. What the operand's type is has no bearing on it: `typeof` asks the
 * VALUE, and a value whose static type is `number` can still be an unchecked `unknown` underneath,
 * which is precisely why the guard `typeof x === 'string'` is worth compiling at all. */
export interface TypeOf extends Node {
  readonly kind: 'typeof';
  readonly operand: Expression;
}

/** `delete o.a` / `delete o[e]` — the one expression that REMOVES a property rather than reading
 * or writing one.
 *
 * `key` is always an expression, and for `o.a` the lowering builds the StringLiteral itself. The
 * literal form could have passed a C string the way DynFieldAccess does, but delete is neither hot
 * (it rebuilds the receiver's shape chain, which is already O(keys)) nor cacheable, so one node and
 * one runtime entry point buy more than a second spelling of the same operation would.
 *
 * The receiver is never a fixed shape here in `ts` mode: TypeScript refuses `delete` on a required
 * property (TS2790), and an OPTIONAL property is exactly what sends an anonymous shape to the
 * dynamic path (`isDynamicShape`), so the two rules meet. What survives that is a class field,
 * which §1.1 refuses permanently (STA1108). A fixed shape can still ARRIVE here through an Unknown
 * receiver, and that is the runtime's STA2007.
 *
 * The `type` is always `boolean`: the operator answers whether the key is gone, and it answers
 * `true` for a key that was never there. */
export interface DeleteProp extends Node {
  readonly kind: 'delete-prop';
  readonly target: Expression;
  readonly key: Expression;
}

/** A runtime check that a value is what the program says it is — STA2001 if it is not.
 *
 * This is golden rule 4 made executable. TypeScript's types are unsound at exactly the places this
 * node appears: an `unknown` narrowed by a guard, an `as` cast, a value arriving from untyped code.
 * At each, the program ASSERTS a type it has not proven, and everything the compiler emits after
 * that point is entitled to trust the assertion completely — so the assertion is settled here,
 * once, rather than defended by every later operation.
 *
 * `type` is the checked type, which is what the node's consumers see; `value.type` is what it was
 * before, which is `unknown`. A check whose two types already agree is not built at all: the
 * lowering emits this node only where the narrowing is real, so its presence in the HIR IS the
 * statement that a boundary was crossed.
 *
 * `where` is `file:line:col`, carried on the node rather than derived from `span` at emission. A
 * column needs the source text to compute, the emitter does not have it, and adding one to `Span`
 * would grow every node in the IR to serve the one that reports a location to a human. */
export interface BoundaryCheck extends Node {
  readonly kind: 'boundary-check';
  readonly value: Expression;
  readonly where: string;
}

/** `&&`, `||`, `??` — separate from BinaryOp because they differ in both ways that matter to a
 * compiler: the right operand is evaluated CONDITIONALLY, and the result is one of the operands
 * rather than a fresh value. `a && b` is not `and(a, b)`; it is `let t = a; t ? b : t`. Modelling
 * them as BinaryOp would license every pass that assumes "both children are evaluated" to hoist
 * work out of a branch that may never run. */
export interface LogicalOp extends Node {
  readonly kind: 'logical-op';
  readonly operator: '&&' | '||' | '??';
  readonly left: Expression;
  readonly right: Expression;
}

/** A template literal: `` `a${x}b` ``.
 *
 * Modelled in its own node rather than desugared to `+`, even though the two agree on every
 * primitive. They stop agreeing at objects: `` `${o}` `` calls ToString directly, while `"" + o`
 * runs ToPrimitive with hint *default*, which tries `valueOf` FIRST. An object with both methods
 * takes different branches. Desugaring now would bake that difference in as a bug that only
 * surfaces once objects land, in code no longer being looked at.
 *
 * INVARIANT: `quasis.length === expressions.length + 1`. The literal chunks bracket the holes, so
 * a template always begins and ends with a chunk — an empty one where the source has nothing. */
export interface TemplateLiteral extends Node {
  readonly kind: 'template-literal';
  readonly quasis: readonly string[];
  readonly expressions: readonly Expression[];
}

/** `s.length` on a string.
 *
 * A dedicated node, not general property access, for the same reason ConsoleLogCall is: the
 * subset admits exactly one property today, and giving it its own node keeps the gate's accept
 * set equal to this vocabulary. General property access arrives with the object model.
 *
 * The value is a count of UTF-16 CODE UNITS, matching JavaScript — an astral character counts
 * twice (docs/VALUE.md §2). */
export interface StringLength extends Node {
  readonly kind: 'string-length';
  readonly operand: Expression;
}

/** `a.length` on an array.
 *
 * Separate from StringLength rather than one node that inspects its operand, because the two
 * dispatch to different runtime functions and the choice is made here, where the operand's type is
 * known, rather than in the emitter where an `Unknown` operand would leave it with no answer. */
export interface ArrayLength extends Node {
  readonly kind: 'array-length';
  readonly operand: Expression;
}

/** `fn.length` on a function value.
 *
 * The third of the length family, for the same reason the other two are separate nodes: the
 * operand's type is known here. The answer is the closure's declared arity, which never counts
 * a method's receiver (docs/VALUE.md §4.16) -- `jsrt_closure_arity` reads that field directly.
 * An `Unknown`-typed receiver never reaches this node: it takes the dynamic path and answers
 * through `jsrt_get_prop` instead (plan.md §8 step 21b). */
export interface FunctionLength extends Node {
  readonly kind: 'function-length';
  readonly operand: Expression;
}

/** `[a, b, c]`. Elements are evaluated left to right, before the array exists. */
export interface ArrayLiteral extends Node {
  readonly kind: 'array-literal';
  readonly elements: readonly Expression[];
}

/** `a[i]` as a READ.
 *
 * `index` is an arbitrary expression, not a number: `a[f()]` is legal, and the side effect happens
 * whether or not the index turns out to be in range.
 *
 * This node's `type` is what the checker says the read produces, which under
 * `noUncheckedIndexedAccess` is `T | undefined` and therefore Unknown — NOT the array's element
 * type. An out-of-range read really does yield `undefined`, so narrowing it here would be the
 * compiler asserting something the runtime cannot honour. */
export interface IndexAccess extends Node {
  readonly kind: 'index-access';
  readonly target: Expression;
  readonly index: Expression;
}

/** `new C(a, b)`.
 *
 * `className` names the class, not an expression: the emitter has to reach a specific `JSRTClass`
 * descriptor and a specific constructor. The node's `type` is the resulting HObject.
 *
 * `args` are the CONSTRUCTOR's arguments and do not include the receiver. The object is allocated
 * before the constructor runs -- it has to be, because the constructor's whole job is to assign
 * into it -- and the emitter is what puts it in front of `args`.
 *
 * The callee a NAME resolves is this node; a callee that is a VALUE -- `new v()` where `v` holds
 * a class object -- is `NewValue`, which dispatches at run time and cannot name a descriptor. */
export interface NewExpr extends Node {
  readonly kind: 'new';
  readonly className: string;
  readonly args: readonly Expression[];
}

/** `new v(a, b)` where `v` is a class-object VALUE rather than a name (docs/VALUE.md §4.17), or
 * an ordinary function the program wrote -- `new P(1)` for `function P(x) { this.x = x; }`, or an
 * Unknown callee -- which builds a dynamic object through `P.prototype` (§4.20, plan-notes 310).
 *
 * The instance's CLASS is a run-time fact: `v` may name one class statically and hold another
 * (a `typeof Base` parameter receiving a subclass's object constructs the subclass in
 * JavaScript), so the allocation and the constructor dispatch through the value -- one runtime
 * entry (`jsrt_construct`) instead of the descriptor pair `NewExpr` emits. `type` is the
 * checker's construct result (an Unknown when the callee was untyped), exactly as `NewExpr`'s
 * is its class's layout.
 *
 * `args` do not include the receiver, exactly as on `NewExpr`. */
export interface NewValue extends Node {
  readonly kind: 'new-value';
  readonly target: Expression;
  readonly args: readonly Expression[];
}

/** `x instanceof C`.
 *
 * `className` names the class for the same reason `new` does: the emitter reaches a specific
 * `JSRTClass` descriptor, and there is one per class in the whole program, so the test is a pointer
 * comparison against it. A right operand that is a VALUE rather than a name is `InstanceOfValue`.
 *
 * `target` is any expression at all, including a primitive: `1 instanceof C` is `false`, not an
 * error, so nothing about this node requires the target to be an object. The node's `type` is
 * always `boolean`.
 *
 * Built-in constructors (`Array`, `Object`, `Function`, …) set `builtin` and name the constructor
 * rather than a `JSRTClass` descriptor — those objects have tags, not descriptors. */
export interface InstanceOf extends Node {
  readonly kind: 'instanceof';
  readonly target: Expression;
  readonly className: string;
  readonly builtin?: true;
}

/** `x instanceof v` where the right operand is a class-object VALUE rather than a name
 * (docs/VALUE.md §4.17), or an ordinary function (§4.20).
 *
 * The class being tested against is a run-time fact for exactly the reason `NewValue` exists:
 * `v` may hold a subclass's object where its type names the base, and the prototype question is
 * about the VALUE. The emitter answers through one runtime entry (`jsrt_instanceof_ctor`), which
 * raises Node's TypeError for a right operand that is not a constructor and walks the left side's
 * prototype chain against `f.prototype` for an ordinary function. The node's `type` is always
 * `boolean`, and `target` may be any expression at all, exactly as on `InstanceOf`. */
export interface InstanceOfValue extends Node {
  readonly kind: 'instanceof-value';
  readonly target: Expression;
  readonly ctor: Expression;
}

/** The class object a class evaluates to (`docs/VALUE.md` §4.17) -- `K` in a value position.
 *
 * One file-scope constant per class: the same closure-shaped value `typeof` answers "function"
 * for, `.name` and `.length` read, `jsrt_construct` builds through, and `jsrt_call` refuses with
 * Node's `Class constructor K cannot be invoked without 'new'`. `className` is the HIR name (the
 * key `ClassDeclaration` registers under), never the source spelling a shadow rename displaced.
 *
 * The node has no subexpression and captures nothing: the value is a constant wherever the gate
 * admits one, which is why a class whose evaluation can repeat (a class inside a function or a
 * loop) is refused at the gate rather than lowered here -- one constant per program cannot carry
 * per-evaluation identity. */
export interface ClassValue extends Node {
  readonly kind: 'class-value';
  readonly className: string;
}

/** `o.x` as a READ.
 *
 * `slot` is the field's index in its class's field list, resolved once during lowering. It is
 * stored rather than recomputed because it is then CHECKABLE: the verifier confirms that the slot
 * still names `field` in the target's type, which an emitter that recomputed it silently could not
 * be caught doing wrong.
 *
 * Unlike an array read, this node's `type` really is the field's type. A field always exists -- the
 * checker proved the name is declared, and the slot is allocated whether or not the constructor
 * assigned it -- so there is no `| undefined` and no boundary to check. An unassigned field reads
 * as `undefined` because that is what the slot HOLDS, which is a value, not a missing one. */
export interface FieldAccess extends Node {
  readonly kind: 'field-access';
  readonly target: Expression;
  readonly field: string;
  readonly slot: number;
}

/** `o.x` where `o`'s type has no layout to resolve a slot against — the dynamic half of Task 4.1.
 *
 * No `slot`: the offset is the shape table's answer at runtime, cached per SITE in a static
 * `JSRTIC` the emitter allocates. The node's `type` is always Unknown — an optional property
 * reads `undefined` when absent, and that possibility is the whole reason this node exists.
 * `jsrt_get_prop` runs no user code and cannot throw, so no pending check follows it. */
export interface DynFieldAccess extends Node {
  readonly kind: 'dyn-field-access';
  readonly target: Expression;
  readonly field: string;
}

/** `o.m(a)`.
 *
 * A method is not a field: no instance holds a closure for it, and one function is shared by every
 * instance of the class that declares it. `className` records which class -- for a `direct` call
 * that is the function the emitter names, and for a `virtual` one it is the class the SLOT was
 * resolved against.
 *
 * `dispatch` is the whole of overriding. A method nothing overrides has exactly one implementation
 * for every receiver in the chain, so the call is `direct` and costs nothing; a method some
 * descendant overrides is `virtual` and loads its entry from the receiver's own class at `slot`.
 * The distinction is a fact about the whole program, not about the call site, which is why the
 * lowering decides it once per method rather than the emitter guessing per call. `super.m()` is
 * `direct` even when `m` is overridden -- skipping the override is what `super` MEANS.
 *
 * `target` is the receiver and is NOT in `args`; it becomes argument zero, which is where a method
 * body's `this` parameter reads it from. */
export interface MethodCall extends Node {
  readonly kind: 'method-call';
  readonly target: Expression;
  readonly className: string;
  readonly method: string;
  /** Index into the class's method table. Meaningful only for a `virtual` call, and correct for
   * every descendant because a subclass's table begins with its base's, in the base's order. */
  readonly slot: number;
  readonly dispatch: 'direct' | 'virtual';
  readonly args: readonly Expression[];
}

/** `o.m(a)` where `o`'s type is Unknown -- the dynamic half of a method call.
 *
 * A `MethodCall` would be wrong twice over: there is no `JSRTClass` method table to index, and
 * the callee the shape table holds may be a plain closure rather than a method at all. The
 * emitter loads the name through the shape table with a per-site cache (`jsrt_get_prop`) and
 * passes the receiver as argument zero when -- and only when -- the loaded closure declares
 * one (`has_receiver`, docs/VALUE.md §4.16). A plain closure is called as-is (`this` is
 * `undefined`, as for a method value called bare); a non-function callee panics exactly as an
 * ordinary `call` does (`STA2006` with the site's `file:line`).
 *
 * `target` is the receiver and is NOT in `args`; when the callee wants a receiver it becomes
 * argument zero, which is where a method body's `this` parameter reads it from. */
export interface DynMethodCall extends Node {
  readonly kind: 'dyn-method-call';
  readonly target: Expression;
  readonly method: string;
  readonly args: readonly Expression[];
  /** `o.m(a, ...xs)` (plan.md §11c T11.4 step 5): `args` is ONE array holding every argument,
   * spreads expanded, and the receiver is passed by name rather than by count
   * (`jsrt_call_spread_at`). A spread call takes this node whatever the receiver's type: the
   * shape-table read answers a layout's methods and a builtin's bound ones as well. */
  readonly spread?: true;
  /** Node's `TypeError` subject (`c.missing`) when the loaded value is not callable, instead of
   * the STA2006 abort. Set for a name a fixed object's layout does not declare, whose call
   * answered that `TypeError` statically before growth could store a function there
   * (docs/VALUE.md §4.24, plan.md §8 step 37). */
  readonly notFunction?: string;
}

/** `o.f(a)` where `o` has a layout and `f` is one of its FIELDS holding a closure -- an object
 * literal's `{ f: () => …, g }` rather than a method (plan-notes 310).
 *
 * The callee loads from the field's slot (`slot`, as in a `FieldAccess`), and the call follows
 * `DynMethodCall`'s receiver rule: the receiver becomes argument zero when -- and only when --
 * the loaded closure declares one (docs/VALUE.md §4.16). That is what `o.f()` means: a plain
 * `function` stored in a field sees `o` as `this`, an arrow ignores it, and a non-function
 * field value aborts with `STA2006` exactly as an ordinary call does.
 *
 * `target` is the receiver and is NOT in `args`. */
export interface FieldCall extends Node {
  readonly kind: 'field-call';
  readonly target: Expression;
  readonly field: string;
  readonly slot: number;
  readonly args: readonly Expression[];
}

/** `o.m` — a method taken as a value, not called.
 *
 * The closure is the method's own, with `has_receiver` set so a later bare call shifts arguments
 * correctly (docs/VALUE.md §4.16). Virtual dispatch loads the receiver's entry, not the statically
 * named one; a direct call names the declaring class's function. */
export interface MethodValue extends Node {
  readonly kind: 'method-value';
  readonly target: Expression;
  readonly className: string;
  readonly method: string;
  readonly slot: number;
  readonly dispatch: 'direct' | 'virtual';
}

/** `{ x: 1, y: f() }`.
 *
 * The same allocation a class instance is -- a descriptor pointer followed by slots -- with the
 * descriptor derived from the TYPE rather than from a declaration. `type` is the shape, whose name
 * is the shape itself, so two literals written with the same keys and types share one descriptor.
 *
 * `entries` is in slot order and is the same order the source wrote, which is what makes
 * `console.log` print the keys in the order JavaScript prints them. Each value is evaluated in
 * that order, left to right, exactly once. */
export interface ObjectLiteral extends Node {
  readonly kind: 'object-literal';
  readonly entries: readonly ObjectEntry[];
  /** Method members, lowered like a class's -- one shared function per name, receiver as param 0. */
  readonly methods: readonly ClassMethod[];
  /** Methods a `{ ...src }` expansion copied (plan.md §8 step 12c S-C): one `method-value`
   * read of the spread source per method the source's shape carries. The read loads the
   * source's BOUND closure out of its hidden slot, so the copy keeps the source's
   * construction-site environment and its identity (`c.m === o.m` for a non-capturing
   * method, as in Node) -- while a later `c.m()` still goes through the method-call path
   * and passes the COPY as the receiver, which is what makes `this === c`. Only the
   * lowering sets it, and only for a source whose shape is an object literal's (its name
   * starts with `{`): a method on a class instance rides the prototype, is not own, and
   * is never copied, which the field-only expansion already gets right. An accessor can
   * never appear here -- one forces its whole shape dynamic, so a fixed-shape source has
   * plain methods only. */
  readonly methodCopies: readonly MethodCopy[];
}

/** One method a `{ ...src }` expansion copied (see `ObjectLiteral.methodCopies`).
 *
 * `value` is a `method-value` read of the spread source, stamped with the spread's own span
 * so the emitter's scratch machinery evaluates a shared non-trivial source once no matter
 * how many fields and methods read it. `at` is the index into the literal's `entries` where
 * this fragment starts -- the count of entries expanded before it -- so the emitter stores
 * the copy at the fragment's own position in source order, exactly as the field reads are.
 * A later writer of the same name (another spread, or an own method) overwrites the slot,
 * which is the `{ ...a, ...b }` last-wins rule; the lowering drops a losing copy unless its
 * source would otherwise never evaluate (a methods-only source that is not an identifier),
 * in which case the duplicate store is what runs it. */
export interface MethodCopy {
  readonly name: string;
  readonly value: MethodValue;
  readonly at: number;
}

export interface ObjectEntry {
  readonly name: string;
  readonly value: Expression;
  /** Set on entries a `{ ...src }` expansion produced (plan.md §8 step 21a): the expansion
   * order is the source TYPE's field order, while the result must enumerate in the SOURCE
   * OBJECT's key order, so the emitter repairs the order at run time from exactly these
   * entries. Only the lowering sets it -- an own value reading the same shape is
   * indistinguishable by shape alone, and passes preserve it with the entry. */
  readonly spread?: true;
  /** Set on a `{ __proto__: v }` / `{ "__proto__": v }` definition (plan.md §8 step 33):
   * the spelling is the prototype setter, not an own data property, so the dynamic emitter
   * evaluates the value in written position for its effects and stores nothing. Only the
   * lowering sets it, and only for the non-computed PropertyAssignment spelling -- a
   * shorthand, a method, an accessor and a computed key (even a statically-known one) are
   * all own properties and stay unmarked. A marked entry never reaches the fixed path: the
   * spelling puts a `__proto__` data property in the checker's type, which is exactly what
   * sends the literal to the shape table. */
  readonly protoSetter?: true;
}

/** An object literal whose type is NOT a layout — an optional property or an index signature
 * (docs/VALUE.md §4.10, Task 4.1). There is no descriptor and no slot order: the object is a
 * `JSRTDynObject`, each entry is a `jsrt_set_prop`, and WHICH slot a key landed in is the shape
 * table's business at runtime, not this node's.
 *
 * The literal's fate is decided by its CONTEXTUAL type when one exists: `const o: {x?: n} =
 * {x: 1}` must build a dynamic object even though the initializer's own type has no optional
 * property, or every later `o.x` — typed by the binding — would aim a dynamic site at a
 * fixed-shape object.
 *
 * A METHOD member is an ordinary entry whose value is the method's closure: on a dynamic object
 * a method IS an own data property (it enumerates, `typeof o.m` is `"function"`, and two reads
 * are `===`), with the receiver as parameter zero exactly as on the fixed path -- so a call
 * through the shape table (`dyn-method-call`) is what passes `this`. The closure is lowered
 * inline, at the position the method was written, which is what keeps the insertion order a
 * separate method table could not. */
export interface DynObjectLiteral extends Node {
  readonly kind: 'dyn-object-literal';
  readonly entries: readonly DynEntry[];
}

/** `get x() { … }` / `set x(v) { … }` on an object literal (docs/VALUE.md §4.15).
 *
 * A pair, not two entries, because one key holds both halves and either may be absent. Each half is
 * an ordinary `FunctionExpr` with the receiver as parameter zero — the method ABI unchanged — so
 * capture analysis, rooting and the emitter need nothing new to build a getter that closes over a
 * local, which is precisely the case that forced the pair into the object's slot rather than onto
 * the shape it shares with its siblings.
 *
 * An accessor member makes its WHOLE literal dynamic: a fixed layout would store the getter's
 * result once instead of calling it per read. */
export interface AccessorEntry {
  readonly name: string;
  readonly get: Expression | undefined;
  readonly set: Expression | undefined;
}

/** `{ [expr]: v }` on a dynamic object literal. The key is evaluated at runtime and passed to
 * `jsrt_dyn_index_set`, which canonicalizes it the same way an element assignment does. */
export interface ComputedEntry {
  readonly key: Expression;
  readonly value: Expression;
}

/** One member of a dynamic object literal: a value, an accessor pair, or a computed key, in
 * written order — the order matters, because it is the order the keys are inserted and therefore
 * printed. */
export type DynEntry = ObjectEntry | AccessorEntry | ComputedEntry;

export function isAccessorEntry(entry: DynEntry): entry is AccessorEntry {
  return 'get' in entry;
}

export function isComputedEntry(entry: DynEntry): entry is ComputedEntry {
  return 'key' in entry;
}

/** `new Map()` and `new Set()`, and their weak twins.
 *
 * Not a `NewExpr`: that names a class the emitter emitted a descriptor for, and these are
 * runtime structures with no declaration in the program. The `collection` field is the whole
 * difference between them below this point -- one allocator call each. A WeakMap is typed as a
 * Map (the checker keeps every walk off it), so `weak` is the one place its weakness is recorded:
 * it picks the allocator whose `set`/`add` refuses a non-object key (docs/VALUE.md §4.22). */
export interface CollectionNew extends Node {
  readonly kind: 'collection-new';
  readonly collection: 'map' | 'set';
  readonly weak: boolean;
}

/** Every operation the subset performs on a Map or a Set.
 *
 * `size` is here despite being a property rather than a call, because it is the same question asked
 * of the same structure and giving it a node of its own would buy nothing -- exactly the reasoning
 * that keeps `ArrayLength` separate from a general property access, seen from the other side.
 *
 * `forEach` is the one operation here that runs USER CODE, so it carries the same consequences an
 * `ARRAY_OPS` entry with `calls` does: the emitter follows it with a pending check, and the
 * runtime's walk stops the moment an exception is pending (plan-notes 96). `keys`/`values`/`entries`
 * box a JSRTIterator when stored, and inline as a specialized for-of when they are the loop operand.
 *
 * The last seven are the ES2025 set operations, which are `SET_OPS` below: they take another SET
 * rather than an element, which is a contract neither the arity check nor the receiver check would
 * catch on its own. */
export type CollectionOperation =
  | 'get'
  | 'set'
  | 'has'
  | 'delete'
  | 'clear'
  | 'add'
  | 'size'
  | 'forEach'
  | 'keys'
  | 'values'
  | 'entries'
  | SetOperation;

/** The ES2025 set operations, mapped to what each ANSWERS.
 *
 * They differ from every other collection operation in their argument: it is a Set, not an element,
 * and the runtime reads it as a `JSRTMap` -- so passing anything else is memory corruption rather
 * than a wrong answer. That is why this table exists at all, and why both the gate and the verifier
 * consult it rather than trusting an arity count.
 *
 * The spec accepts any SET-LIKE object (a `size`, a `has` and a `keys`), which the gate refuses:
 * reading one means calling its `keys()` on a user object, which is still the user-iterable protocol. */
export const SET_OPS = {
  union: 'set',
  intersection: 'set',
  difference: 'set',
  symmetricDifference: 'set',
  isSubsetOf: 'boolean',
  isSupersetOf: 'boolean',
  isDisjointFrom: 'boolean',
} as const satisfies Record<string, 'set' | 'boolean'>;

export type SetOperation = keyof typeof SET_OPS;

/** Whether an operation is one of the seven — the membership test every stage shares. `Object.hasOwn`
 * rather than `in`, so a name like `toString` cannot answer true off the prototype (plan-notes 91). */
export function isSetOperation(op: string): op is SetOperation {
  return Object.hasOwn(SET_OPS, op);
}

/** `m.get(k)`, `s.add(v)`, `m.size` — one node for the whole method surface of both collections.
 *
 * A `MethodCall` would be wrong twice over: there is no `JSRTClass` method table to index and no
 * user function to name, and the operations are not virtual in any sense -- `get` on a Map is one
 * runtime function for every Map in the program. The verifier is what pins each operation to the
 * collection it belongs to, so `s.get(k)` cannot survive lowering by accident. */
export interface CollectionOp extends Node {
  readonly kind: 'collection-op';
  readonly collection: 'map' | 'set';
  readonly op: CollectionOperation;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

/** The String.prototype surface Task 4.2 has landed, with each operation's post-lowering arity
 * (optional arguments are PADDED with undefined-literals by the lowering — for every method here
 * the spec gives an explicit undefined the same meaning as an absent argument) and its result
 * kind, which the verifier holds the node's type to (`STA4081`); `element` is Unknown, the
 * IndexAccess rule — `at`/`codePointAt` really answer `undefined` out of range, where `charAt`
 * answers "" and `charCodeAt` NaN. `concat` is the receiver-plus-one-argument form of `+`, and
 * its C name IS the concatenation primitive. Absent deliberately: `normalize` and
 * `localeCompare` (Unicode tables), and everything regex-shaped (Task 4.3). */
export const STRING_OPS = {
  at: { arity: 1, result: 'element' },
  charAt: { arity: 1, result: 'string' },
  charCodeAt: { arity: 1, result: 'number' },
  codePointAt: { arity: 1, result: 'element' },
  concat: { arity: 1, result: 'string', throws: true },
  endsWith: { arity: 2, result: 'boolean' },
  includes: { arity: 2, result: 'boolean' },
  indexOf: { arity: 2, result: 'number' },
  lastIndexOf: { arity: 2, result: 'number' },
  localeCompare: { arity: 2, result: 'number' },
  normalize: { arity: 1, result: 'string' },
  padEnd: { arity: 2, result: 'string', throws: true },
  padStart: { arity: 2, result: 'string', throws: true },
  repeat: { arity: 1, result: 'string', throws: true },
  match: { arity: 1, result: 'match' },
  matchAll: { arity: 1, result: 'iterator' },
  search: { arity: 1, result: 'number' },
  replace: { arity: 2, result: 'string' },
  replaceAll: { arity: 2, result: 'string' },
  slice: { arity: 2, result: 'string' },
  split: { arity: 1, result: 'string-array' },
  startsWith: { arity: 2, result: 'boolean' },
  substring: { arity: 2, result: 'string' },
  toLocaleLowerCase: { arity: 1, result: 'string' },
  toLocaleUpperCase: { arity: 1, result: 'string' },
  toLowerCase: { arity: 0, result: 'string' },
  toString: { arity: 0, result: 'string' },
  toUpperCase: { arity: 0, result: 'string' },
  trim: { arity: 0, result: 'string' },
  trimEnd: { arity: 0, result: 'string' },
  trimStart: { arity: 0, result: 'string' },
  valueOf: { arity: 0, result: 'string' },
} as const satisfies Record<
  string,
  {
    arity: number;
    result: 'boolean' | 'element' | 'iterator' | 'match' | 'number' | 'string' | 'string-array';
    /** Present on the ops whose runtime raises a catchable error (`repeat`/`padStart`/`padEnd`
     * throw RangeError for a count/length the spec rejects, `concat` past the maximum string
     * length). The emitter gives such an op its own
     * statement and a pending check after it, the same discipline as {@link arrayOpCallsBack}. */
    throws?: true;
  }
>;

export type StringOpName = keyof typeof STRING_OPS;

/** Whether this string op's runtime can leave a pending exception (see the `throws` marker). */
export function stringOpCanThrow(op: StringOpName): boolean {
  return 'throws' in STRING_OPS[op];
}

/** `s.indexOf(t)` and the rest of the landed String.prototype surface — the CollectionOp shape
 * exactly: a closed op set, one runtime function per operation, no method value anywhere. The
 * receiver is typed `string`, and the result type comes from the table above. */
export interface StringOp extends Node {
  readonly kind: 'string-op';
  readonly op: StringOpName;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

/** The `String` namespace calls the HIR can spell — `String.fromCharCode(...codes)`, one UTF-16
 * unit per argument (plan.md §8 step 19). On the `MathCall` precedent: no namespace object
 * exists at run time, each method is one runtime function, and there is no function value to
 * bind. Variadic in the source and variadic in the node — the emitter passes the count, and
 * the runtime (`jsrt_string_from_char_code`) coerces each argument with ToNumber then ToUint16,
 * so every argument type is already admitted at the gate. */
export const STRING_STATICS = {
  fromCharCode: { result: 'string' },
} as const satisfies Record<string, { result: 'string' }>;

export type StringStaticMethod = keyof typeof STRING_STATICS;

export interface StringStaticCall extends Node {
  readonly kind: 'string-static';
  readonly method: StringStaticMethod;
  readonly args: readonly Expression[];
}

/** The global functions that are calls rather than conversions (§19.2, plan.md §11c T11.4):
 * `parseInt`, `parseFloat`, `isNaN`, `isFinite`, and the two constructors that answer the same
 * object called or `new`ed -- `RegExp(p, f)` (§22.2.4.1) and the one-argument `Array(n)`
 * (§23.1.1.1). On the `DateStaticCall` precedent -- no function value exists, each name is one
 * runtime function over boxed operands, and the lowering pads an omitted argument with
 * `undefined`, so `arity` is exact below the gate. `throws` marks the rows whose entry can leave an
 * exception pending (a SyntaxError for a bad pattern, a RangeError for a bad length), which the
 * emitter checks as a statement. `String(x)`, `Number(x)` and `Boolean(x)` are not here: each IS
 * an existing operation (a template hole, unary `+`, `!!`) and lowers to that node instead of to a
 * second spelling of it. `Array()` and `Array(a, b)` are array literals for the same reason.
 *
 * Two rows are not identifiers, so no global name reaches them: `Array.from(items)` with one
 * argument (§23.1.2.1), and `...`, the operand of a spread that is not statically an array
 * (`[...map.keys()]`, `f(...args)` with `args` Unknown), which the lowering wraps so the array
 * concat that builds the list receives an array (step 5; docs/VALUE.md §4.23). */
export const GLOBAL_CALLS = {
  parseInt: { arity: 2, fn: 'jsrt_global_parse_int', result: 'number', throws: false },
  parseFloat: { arity: 1, fn: 'jsrt_global_parse_float', result: 'number', throws: false },
  isNaN: { arity: 1, fn: 'jsrt_global_is_nan', result: 'boolean', throws: false },
  isFinite: { arity: 1, fn: 'jsrt_global_is_finite', result: 'boolean', throws: false },
  'Number.isFinite': { arity: 1, fn: 'jsrt_number_is_finite', result: 'boolean', throws: false },
  'Number.isNaN': { arity: 1, fn: 'jsrt_number_is_nan', result: 'boolean', throws: false },
  'ArrayBuffer.isView': {
    arity: 1,
    fn: 'jsrt_arraybuffer_is_view',
    result: 'boolean',
    throws: false,
  },
  // Builtin constructors and prototypes read as VALUES (docs/VALUE.md §4.24): the one argument
  // is the builtin's name as a string literal, and the runtime interns one value per name, so
  // `ctor === Date` and `o === Object.prototype` compare identities exactly.
  '%ctor': { arity: 1, fn: 'jsrt_builtin_ctor_value', result: 'unknown', throws: false },
  '%proto': { arity: 1, fn: 'jsrt_builtin_proto_value', result: 'unknown', throws: false },
  '%objectProto': {
    arity: 1,
    fn: 'jsrt_object_proto_method_value',
    result: 'unknown',
    throws: false,
  },
  RegExp: { arity: 2, fn: 'jsrt_regexp_construct', result: 'regexp', throws: true },
  Array: { arity: 1, fn: 'jsrt_array_construct', result: 'array', throws: true },
  'Array.from': { arity: 1, fn: 'jsrt_array_from', result: 'array', throws: true },
  '...': { arity: 1, fn: 'jsrt_spread_operand', result: 'array', throws: true },
} as const satisfies Record<
  string,
  {
    readonly arity: number;
    readonly fn: string;
    readonly result: 'number' | 'boolean' | 'regexp' | 'array' | 'unknown';
    readonly throws: boolean;
  }
>;

export type GlobalCallName = keyof typeof GLOBAL_CALLS;

export interface GlobalCall extends Node {
  readonly kind: 'global-call';
  readonly name: GlobalCallName;
  readonly args: readonly Expression[];
}

/** The `Array.prototype` methods the HIR can spell, with their POST-LOWERING arity and result
 * kind — the same single-vocabulary contract as `STRING_OPS`, read by the gate, the lowering, the
 * verifier, and the emitter (C names derive mechanically: `jsrt_array_` + snake_case, with the
 * variadic forms calling the `_many`/`_from`/`_insert` entry points the emitter picks by count).
 *
 * The set is the non-callback surface: `map`/`filter`/`forEach` and the rest that take a function
 * wait on a protocol for the runtime to call back into compiled code. Omitted optional arguments
 * are padded with `undefined` literals where ECMA-262 makes explicit `undefined` and absent
 * indistinguishable — which is every op here EXCEPT `lastIndexOf`, whose absent `fromIndex` means
 * `length - 1` while an explicit `undefined` means `0`; it therefore lands with arity 1..2 and an
 * explicit position calls its own entry point. The variadic ops (`push`, `unshift`, `splice`,
 * `concat`) land with `arity` as their MINIMUM and any larger count: `push`/`unshift` append or
 * prepend the whole run, `splice` removes the span and inserts the run at its start (with the
 * one-argument form deleting to the end on its own entry point, and zero arguments spelling the
 * two-argument form over `undefined`), and `concat` spreads each array argument while appending
 * each non-array one as a single element.
 *
 * Result kinds: `self` is the RECEIVER's array type (`slice`/`concat`/`fill`/`reverse` — the last
 * two mutate in place and return the receiver); `element` is `T | undefined` and therefore
 * Unknown, the IndexAccess precedent (`pop` on an empty array really answers `undefined`);
 * `mapped` keeps the CHECKER's answer when it is an array (degrading its element to Unknown
 * otherwise) — for `map` because the element is the callback's to choose, and for `filter`
 * because a type-guard predicate legitimately narrows it below the receiver's; `undefined` is
 * `forEach`'s only answer; `checker` is the checker's answer with NOTHING pinned — `reduce`'s
 * accumulator type is whatever the callback and initial value agreed on.
 *
 * The callback-taking ops carry `calls: true`: they run user code through `jsrt_call`, so
 * the runtime's walks stop as soon as `jsrt_pending()` is set (plan-notes 96). Since plan.md §8
 * step 20 every array op ALSO validates its receiver first (STA2008) and lands as its own
 * statement with a pending check after it, `calls` no longer drives emission -- it records
 * which ops can reenter compiled code. They hold their single argument to a
 * function TYPE at the gate; the runtime
 * calls it through jsrt_call, the same closure ABI compiled callers use, with the spec's
 * (element, index, array) triple — `reduce`/`reduceRight` prepend the accumulator and land in
 * their WITH-initial form only, because an explicit `undefined` initial is an initial and so the
 * two forms cannot share an undefined-padded signature. `sort` is a stable merge (stability is
 * normative), and an ABSENT comparator equals an explicit `undefined` one in the spec, so the
 * padding rule holds and both spell the ToString default -- [10, 9] stays [10, 9]. */
export const ARRAY_OPS = {
  at: { arity: 1, result: 'element' },
  concat: { arity: 0, result: 'self', variadic: true },
  copyWithin: { arity: 3, result: 'self' },
  every: { arity: 1, result: 'boolean', calls: true },
  fill: { arity: 3, result: 'self' },
  filter: { arity: 1, result: 'mapped', calls: true },
  find: { arity: 1, result: 'element', calls: true },
  findIndex: { arity: 1, result: 'number', calls: true },
  findLast: { arity: 1, result: 'element', calls: true },
  findLastIndex: { arity: 1, result: 'number', calls: true },
  flat: { arity: 1, result: 'mapped' },
  flatMap: { arity: 1, result: 'mapped', calls: true },
  forEach: { arity: 1, result: 'undefined', calls: true },
  includes: { arity: 2, result: 'boolean' },
  indexOf: { arity: 2, result: 'number' },
  join: { arity: 1, result: 'string' },
  lastIndexOf: { arity: 1, result: 'number', maxArity: 2 },
  map: { arity: 1, result: 'mapped', calls: true },
  pop: { arity: 0, result: 'element' },
  push: { arity: 0, result: 'number', variadic: true },
  reduce: { arity: 2, result: 'checker', calls: true },
  reduceRight: { arity: 2, result: 'checker', calls: true },
  reverse: { arity: 0, result: 'self' },
  shift: { arity: 0, result: 'element' },
  slice: { arity: 2, result: 'self' },
  sort: { arity: 1, result: 'self', calls: true },
  some: { arity: 1, result: 'boolean', calls: true },
  splice: { arity: 0, result: 'self', variadic: true },
  toReversed: { arity: 0, result: 'self' },
  toSorted: { arity: 1, result: 'self' },
  toSpliced: { arity: 2, result: 'self' },
  toString: { arity: 0, result: 'string' },
  unshift: { arity: 0, result: 'number', variadic: true },
  with: { arity: 2, result: 'self' },
  keys: { arity: 0, result: 'iterator' },
  values: { arity: 0, result: 'iterator' },
  entries: { arity: 0, result: 'iterator' },
} as const satisfies Record<
  string,
  {
    arity: number;
    result:
      | 'boolean'
      | 'checker'
      | 'element'
      | 'iterator'
      | 'mapped'
      | 'number'
      | 'self'
      | 'string'
      | 'undefined';
    /* Present exactly on the ops that call back into compiled code, which is what makes them able
     * to THROW. The emitter reads it to decide whether the call needs its own statement and a
     * pending check after it; the runtime's walks read the same fact as `!jsrt_pending()` in their
     * loop guards. */
    calls?: true;
    /* Present on the ops that take any count from `arity` up: the verifier holds the node to
     * that range instead of the exact count, the lowering passes the arguments through
     * unpadded, and the emitter picks the runtime entry point by count. */
    variadic?: true;
    /* Present instead of `variadic` on the ops whose range is bounded above: the verifier holds
     * the node to `arity..maxArity`. */
    maxArity?: number;
  }
>;

export type ArrayOpName = keyof typeof ARRAY_OPS;

/** Whether this op calls back into compiled code. Every array op -- callback-taking or not --
 * lands as its own statement with a pending check after it, because each runtime entry validates
 * its receiver first (STA2008, plan.md §8 step 20); the runtime's walks read this same fact as
 * `!jsrt_pending()` in their loop guards. */
export function arrayOpCallsBack(op: ArrayOpName): boolean {
  return 'calls' in ARRAY_OPS[op];
}

/** `xs.push(v)`, `xs.slice(1, -1)` — an `ARRAY_OPS` operation on an array-typed receiver. */
export interface ArrayOp extends Node {
  readonly kind: 'array-op';
  readonly op: ArrayOpName;
  readonly target: Expression;
  readonly args: readonly Expression[];
  /** Set on the `concat` an array-literal spread lowers to: a spread ITERATES its operand, so a
   * hole becomes `undefined` where a source-level `concat` keeps it (docs/VALUE.md §4.4). */
  readonly spread?: true;
}

/** The `Object` namespace calls the HIR can spell — `Object.keys(o)` and its two siblings, each
 * one runtime function over a fixed-shape or dynamic object (the gate restricts the argument to
 * those). `keys` is `string[]`; `values`/`entries` carry the checker's answer, with an Unknown
 * element where the shape makes the element genuinely mixed. Enumeration order is field
 * declaration order (fixed shapes) or insertion order (dynamic shapes), which IS the spec's
 * string-key order because every key here is an identifier — integer-like keys cannot be spelled
 * through the property syntax these objects are built from.
 *
 * `assign` is the one that WRITES: it copies the source's own keys onto the target and returns the
 * target, so its target argument is restricted to a dynamic shape (see OBJECT_STATICS) and its
 * result type is Unknown -- the checker answers `T & S`, an intersection this type model does not
 * carry, and every read of the merged object is therefore a boundary.
 *
 * `forInKeys` is not a source-level `Object` member: it is the `for-in` desugar's private entry
 * into the keys walk (plan.md §8 step 38). It answers exactly what `for-in` visits -- the own
 * enumerable keys of objects, arrays and strings -- and an empty list for every other primitive,
 * where `Object.keys` on a non-object stays a loud STA4084. Sharing the walk would turn a
 * compile-time refusal (`for (const k in 5)`) into a runtime abort. */
export type ObjectStaticMethod =
  | 'assign'
  | 'entries'
  | 'forInKeys'
  | 'freeze'
  | 'fromEntries'
  | 'getOwnPropertyNames'
  | 'hasOwn'
  | 'isFrozen'
  | 'keys'
  | 'values';

/** A call on the `Object` namespace. Arity is fixed per method by the gate's own table, so the
 * arguments are a plain list and the verifier checks the count against that same table. */
export interface ObjectStaticCall extends Node {
  readonly kind: 'object-static';
  readonly method: ObjectStaticMethod;
  readonly args: readonly Expression[];
}

/** The `Promise` namespace calls the subset can spell. `all` takes an ARRAY -- the only iterable
 * the runtime walks -- and settles with an array of the same length in INPUT order; `resolve` and
 * `reject` are the two one-argument constructors that need no executor.
 *
 * `.then` / `.catch` / `.finally` / `new Promise(executor)` are `PromiseMethodCall` and
 * `PromiseConstruct`: a handler throw is a completion from `jsrt_call_protected` (docs/VALUE.md
 * §4.9), not an unwind into library C. */
export type PromiseStaticMethod = 'all' | 'reject' | 'resolve';

export interface PromiseStaticCall extends Node {
  readonly kind: 'promise-static';
  readonly method: PromiseStaticMethod;
  readonly arg: Expression;
  /** What the resulting promise settles with — `T` for `resolve`/`reject`, `T[]` for `all`. */
  readonly type: HType;
}

export type PromiseInstanceMethod = 'catch' | 'finally' | 'then';

/** `p.then(f, r)` / `.catch` / `.finally`. Args are padded with `undefined` to the runtime arity. */
export interface PromiseMethodCall extends Node {
  readonly kind: 'promise-method';
  readonly method: PromiseInstanceMethod;
  readonly target: Expression;
  readonly args: readonly Expression[];
  readonly type: HType;
}

/** `new Promise(executor)`. The executor runs now; a throw rejects the constructed promise. */
export interface PromiseConstruct extends Node {
  readonly kind: 'promise-construct';
  readonly executor: Expression;
  readonly type: HType;
}

/** `JSON.stringify(v)`, single-argument form — always a `string`. The gate refuses argument
 * types that admit `undefined` or a function at the TOP level, because there the spec returns
 * `undefined` where this type promises a string; inside a structure both serialize per spec
 * (skipped in objects, `null` in arrays), and a cycle aborts loudly at run time. */
export interface JsonStringify extends Node {
  readonly kind: 'json-stringify';
  readonly arg: Expression;
}

/** `JSON.parse(text)`, single-argument form. The result is genuinely untyped — the text is data,
 * not something the checker can see into — so it lowers typed Unknown, exactly like a dynamic
 * property read, and every use below it is a boundary the program must check. The reviver form
 * is gate-refused; malformed text aborts loudly at run time (the spec throws SyntaxError). */
export interface JsonParse extends Node {
  readonly kind: 'json-parse';
  readonly arg: Expression;
}

/** The Math methods the HIR can spell. After lowering, arity is FIXED and per-method (the table
 * lives in the verifier): most take one argument, `pow`/`min`/`max`/`imul`/`atan2`/`hypot` take
 * exactly two, and `random` takes none. The variadic `Math.min(a, b, c)` was folded into nested
 * binary nodes by the lowering, and the zero-argument forms into their identity literals
 * (`Infinity` / `-Infinity`), so no node below the gate is variadic.
 *
 * `hypot` is the one that does NOT get the min/max folding treatment, because it is not
 * associative: `hypot(a, b, c)` is a different computation from `hypot(hypot(a, b), c)` (V8 adds a
 * Kahan compensation term for it). Above two arguments it stays gated rather than approximated. */
export type MathMethod =
  | 'abs'
  | 'acos'
  | 'acosh'
  | 'asin'
  | 'asinh'
  | 'atan'
  | 'atan2'
  | 'atanh'
  | 'cbrt'
  | 'ceil'
  | 'clz32'
  | 'cos'
  | 'cosh'
  | 'exp'
  | 'expm1'
  | 'floor'
  | 'fround'
  | 'hypot'
  | 'imul'
  | 'log'
  | 'log10'
  | 'log1p'
  | 'log2'
  | 'max'
  | 'min'
  | 'pow'
  | 'random'
  | 'round'
  | 'sign'
  | 'sin'
  | 'sinh'
  | 'sqrt'
  | 'tan'
  | 'tanh'
  | 'trunc';

/** `Math.floor(x)` and friends — one node for the Math surface, on the CollectionOp precedent.
 *
 * Not a `CallExpr`: there is no function value anywhere — `Math` is not an object the program
 * built, and each method is one runtime function for the whole program. Not per-method nodes: the
 * ten differ only in which C function the emitter names, and the verifier pins arity and the
 * number-in/number-out contract once for all of them (`STA4080`). Constants (`Math.PI`) need no
 * node at all — the lowering folds them to number literals, the same doubles Node holds. */
export interface MathCall extends Node {
  readonly kind: 'math-call';
  readonly method: MathMethod;
  readonly args: readonly Expression[];
}

/** A function VALUE: a declaration, a function expression and an arrow all lower to this.
 *
 * The three spellings differ in JavaScript over `this`, `arguments` and hoisting. None of those
 * exists in the subset — `this` and `arguments` are gated out, and hoisting is a property of the
 * *binding*, which FunctionDeclaration carries — so below the gate they are one node. When `this`
 * arrives, an arrow's captured receiver becomes a field here, and the node splits or grows a flag
 * at that point rather than in anticipation of it.
 *
 * `name` is present for a declaration and for a named function expression, absent for an arrow. It
 * exists for diagnostics and for the emitter's C symbol; it is NOT the binding — a declaration's
 * binding is FunctionDeclaration.name, and the two are the same string only by convention. */
export interface FunctionExpr extends Node {
  readonly kind: 'function';
  readonly name?: string;
  readonly selfBinding?: string;
  readonly params: readonly Parameter[];
  readonly body: Block;
  /** Own bindings that something nested reads, so they live in this function's heap environment
   * rather than its frame. The array position IS the environment slot index (docs/VALUE.md §4.3).
   * A name here must NOT also get a frame slot: one variable, one home. */
  readonly envVars: readonly string[];
  /** Free variables, each resolved against the environment chain this function is handed. */
  readonly captures: readonly EnvCapture[];
  /** This function, or something nested in it, reads an enclosing environment — so it must carry
   * the incoming one and its closure is heap-allocated. False leaves rung 4a's file-static
   * constant with `env = NULL`, which is why a non-capturing function still costs no allocation. */
  readonly needsEnv: boolean;
  /** An `async` function. It returns a promise rather than its body's value, and every one of its
   * bindings — including the emitter's own temporaries — lives in the heap environment, because a
   * suspended body's C frame is gone by the time it resumes. */
  readonly isAsync: boolean;
  /** A `function*`. It returns a generator (an iterator) rather than its body's value, and every
   * one of its bindings lives in the heap environment for the same reason an async function's do:
   * a `yield` pops the C frame. Mutually exclusive with `isAsync` in this landing. */
  readonly isGenerator: boolean;
  /** A `function` declaration or expression that is neither async nor a generator: the one kind
   * of function JavaScript constructs (`new f()`), and therefore the one with a `prototype`
   * (plan-notes 310). Absent for an arrow, a method, an accessor and a constructor. */
  readonly constructible?: true;
  /** Where this function's SIGNATURE types came from (plan.md §8 step 1). About the signature
   * alone, not the body: the signature is what a caller — and therefore a boundary — can see. */
  readonly provenance: Provenance;
}

/** How much of a function's signature the author asserted, and how much the checker worked out.
 *
 * The distinction exists for boundary insertion, and it runs the way rule 4 does — an ANNOTATION is
 * a claim, so it is the thing that can lie and the thing a boundary must check; an INFERENCE is
 * derived from the code itself, so within the checked world it is already true. A JSDoc `@param`
 * in a `.js` file is an annotation exactly as a `.ts` one is: same claim, same untrusted status
 * when an untyped caller reaches it.
 *
 *   typed     every parameter and the return carry an explicit annotation (TS syntax or JSDoc)
 *   inferred  no Unknown anywhere, but at least one type came from the checker rather than the
 *             author — a contextually typed arrow (`xs.map((x) => x + 1)`) is the common case
 *   dynamic   some parameter or the return is Unknown, so calls go through the dynamic
 *             representation
 *
 * `dynamic` is a fact about the signature and NOT about the whole function: a fully typed signature
 * whose body holds an Unknown is still `typed` here, because callers are unaffected by it. The
 * file-level verdict `stator explain` prints alongside the per-function rows is the one that counts
 * bodies, so nothing hides -- the two answer different questions and both are reported. */
export type Provenance = 'typed' | 'inferred' | 'dynamic';

/** `await e`.
 *
 * `type` is what the awaited promise settles WITH, which is one level inside the awaited
 * expression's type — and is the type of this expression, since awaiting is the only thing that
 * takes a value back out of a promise. Awaiting a non-promise is legal and still suspends for a
 * tick, so the operand is NOT required to be one; the runtime wraps whatever it gets.
 *
 * An await appears inside an async function's body, or at module top-level once the module itself
 * is an async unit (Phase 5 step 9). Nothing below the gate re-checks the non-async-function case,
 * because the emitter's resume machinery is what an await compiles into. */
export interface AwaitExpr extends Node {
  readonly kind: 'await';
  readonly value: Expression;
  readonly type: HType;
}

/** `yield e` (and bare `yield`, whose value is `undefined`).
 *
 * `type` is what a later `next(v)` injects as this expression's value -- TNext, typically Unknown.
 * A yield may only appear inside a generator's body; the emitter's resume machinery is what it
 * compiles into. `yield*` is a separate not-yet (it drives another iterator). */
export interface YieldExpr extends Node {
  readonly kind: 'yield';
  readonly value: Expression;
  readonly type: HType;
}

/** One captured variable. `levels` counts from the environment the referencing function receives:
 * 0 is the nearest enclosing env-bearing scope. Both numbers are compile-time constants, so a
 * capture is an indexed load, never a search. */
export interface EnvCapture {
  readonly name: string;
  readonly levels: number;
  readonly index: number;
}

/** One declared parameter. Not a Node: a parameter is a binding site, not a value, and giving it
 * a `kind` would put it in the expression union where nothing may evaluate it. */
export interface Parameter {
  readonly name: string;
  readonly type: HType;
  readonly span: Span;
  /** `...rest`. Collects argv[i..] into an array. Callers already pass extras; the callee packs them. */
  readonly rest?: true;
  /** `a = expr`. Evaluated when the argument is `undefined` (missing or explicit). */
  readonly default?: Expression;
}

/** A call: `f(x)`.
 *
 * `callee` is an arbitrary expression, not a name, because `(cond ? f : g)(x)` is a call too. The
 * arity of `args` is INDEPENDENT of the callee's declared parameter count — JavaScript pads
 * missing arguments with `undefined` and drops extra ones, in both modes, so nothing downstream
 * may assume the two agree. In `ts` mode the type checker has already rejected the mismatch; the
 * emitter still must not depend on that, because `js` mode reaches the same emitter.
 *
 * Evaluation order is callee first, then arguments left to right. */
export interface CallExpr extends Node {
  readonly kind: 'call';
  readonly callee: Expression;
  readonly args: readonly Expression[];
  /** `f(a, ...xs)` (plan.md §11c T11.4 step 5): `args` is ONE array holding every argument,
   * spreads expanded, and the call passes its elements (`jsrt_call_spread_at`). */
  readonly spread?: true;
}

/** One C-ABI slot of an extern signature (docs/FFI.md §2): the TS type a parameter or return
 * position held, reduced to what the generated call passes. `cstring` borrows its UTF-8 copy
 * for the call (the emitter frees it); `cstring-owned` transfers it (never freed). `pointer`
 * is a branded opaque handle (docs/FFI.md §2 `T*`, step 6): borrow-only, passed as `void *`
 * and never dereferenced — there is no transfer spelling in v0, so every pointer is a borrow.
 * `bytes` is a `Uint8Array` (plan.md §11c T11.3a): parameter-only, it crosses as TWO C arguments,
 * `uint8_t *` and `size_t`, pointing into the view's own storage for the call — no copy.
 * `void` is a return position only — a `void` parameter is STA1119, and `cstring-owned` or
 * `bytes` as a return is STA1119, all refused where the signature is classified, never here. */
export type ExternAbiKind =
  | 'value' // Private runtime bridge: already boxed and rooted.
  | 'number'
  | 'boolean'
  | 'cstring'
  | 'cstring-owned'
  | 'pointer'
  | 'out-pointer'
  | 'bytes'
  | 'void';

/** The closed `@statorError` vocabulary (docs/FFI.md §4): the only conventions a declaration
 * may opt into. A misspelling is a gate error (STA1119), never a silent default. */
export type ExternErrorConvention = 'nonzero' | 'negative' | 'null' | 'errno';

export const EXTERN_ERROR_CONVENTIONS: ReadonlySet<string> = new Set([
  'nonzero',
  'negative',
  'null',
  'errno',
]);

export function isExternErrorConvention(name: string): name is ExternErrorConvention {
  return EXTERN_ERROR_CONVENTIONS.has(name);
}

/** Why an error convention does not fit a return kind, or `undefined` when it does
 * (docs/FFI.md §4). `nonzero`/`negative` read the return VALUE, so only a number carries one;
 * `null` reads the return POINTER, so only a `const char*` return (`cstring`) or an opaque
 * handle (`pointer`) does; `errno` is orthogonal to the return and fits anything, including
 * `void`. The gate and the verifier read the same matrix so the two cannot disagree about
 * which declarations compile. */
export function externConventionMismatch(
  ret: ExternAbiKind,
  convention: ExternErrorConvention,
): string | undefined {
  if (convention === 'errno') {
    return undefined;
  }
  if (convention === 'null') {
    return ret === 'cstring' || ret === 'pointer'
      ? undefined
      : `the null convention guards a pointer return, not '${ret}'`;
  }
  return ret === 'number'
    ? undefined
    : `the ${convention} convention reads a numeric return, not '${ret}'`;
}

/** The HType a value of one ABI kind carries on the Stator side of the boundary: the boxed
 * return the program sees, and the type a checked argument narrows to at the call edge
 * (`void` is `undefined` everywhere the model meets it, so the one mapping serves parameters
 * and the return alike). The lowering, the verifier, and the gate's boundary insertion read
 * the same function so the three cannot disagree about what a kind MEANS.
 *
 * A `pointer` is `unknown`: the HIR has no vocabulary for a brand (a TS alias, not a layout),
 * so a handle-typed value takes the dynamic HType — while the EXTERN node still carries the
 * `pointer` kind, which is what the emitter, the verifier, and `explain` read instead. The
 * `unknown` here must never be given a boundary check (it is not checkable, and there is no
 * runtime test for "is this pointer honest"), so `maybeBoundary` passes it through untouched:
 * the bits travel from the returning call to the next call's slot with no conversion. */
export function externKindHType(kind: ExternAbiKind): HType {
  switch (kind) {
    case 'number':
      return H_NUMBER;
    case 'boolean':
      return H_BOOLEAN;
    case 'cstring':
    case 'cstring-owned':
      return H_STRING;
    case 'pointer':
    case 'value':
      return hUnknown(false);
    case 'out-pointer':
      // Same opaque bits as a `pointer`: the HIR has no vocabulary for an out-slot either,
      // and the slot address must never take a boundary check (there is no runtime test for
      // "is this a proven slot"), so it rides the same `maybeBoundary` passthrough — while
      // the EXTERN node still carries `out-pointer`, which is what the emitter, the verifier,
      // and `explain` read instead. The gate admits only proven `Out<T>` values here (a
      // dynamically-typed argument is STA1125): an out-param WRITES through the pointer, so
      // unlike a `T*` read it cannot trust bits.
      return hUnknown(false);
    case 'bytes':
      // A real HType, unlike a handle: the view is a value the program owns, and the runtime
      // CAN test it (`jsrt_check_uint8array`), so a dynamic argument takes a boundary check.
      return H_UINT8ARRAY;
    case 'void':
      return H_UNDEFINED;
  }
}

/** A call to an `@statorExtern` C function (docs/FFI.md §1, plan.md §10 Task 7.1 step 5).
 *
 * Not a `CallExpr`: there is no function VALUE anywhere — the callee is a C symbol, so the
 * emitter makes a direct call instead of loading a closure, and no `jsrt_value` crosses in
 * either direction. `cName` is the C symbol (the `@statorExtern` override, or the TS name);
 * `tsName` is what the program spelled, and is what the error-convention throw reports.
 *
 * `argKinds` is parallel to `args` and carries the DECLARATION's parameter kinds: the emitter
 * unboxes each argument slot to its C type (`jsrt_to_number`, `jsrt_as_bool`,
 * `jsrt_string_to_cstr`, `jsrt_ptr` for an opaque handle) rather than routing anything through
 * `jsrt_value`. The node's `type`
 * is the boxed return the program sees (`number`, `boolean`, `undefined` for `void`,
 * `string` for `cstring`, `unknown` for a `pointer` — opaque bits, not a dynamic value),
 * so consumers need no extern-specific rule beyond `explain`'s verdict, which reads kinds.
 *
 * Arity is EXACT, unlike `CallExpr`: a C call has no missing-means-`undefined` and no
 * drop-extras — the gate refuses a mismatch (STA1119) and the verifier restates the count.
 * Evaluation order is arguments left to right; there is no callee to evaluate first.
 *
 * `error` is the opted-in `@statorError` convention, if any. Absent means a plain value: a
 * failing call is not an exception. Present means the emitter checks the raw C return (or
 * `errno`, read immediately after the call, before any other runtime call) and throws an
 * `Error` naming the function and the convention.
 *
 * `header` is the declaration file's `@statorLink #include` header (docs/FFI.md §9), if it
 * names one. Present means the prologue includes that header and emits NO forward declaration
 * for this symbol — the header's real prototype governs the call. Absent means the prologue
 * declares the symbol from the ABI kinds (`void *` for a pointer), which links wherever the
 * true signature agrees at the ABI level and fails loudly at the clang line where it does
 * not. */
export interface ExternCall extends Node {
  readonly kind: 'extern-call';
  readonly cName: string;
  readonly tsName: string;
  readonly args: readonly Expression[];
  readonly argKinds: readonly ExternAbiKind[];
  /** Parallel to `args`/`argKinds`: the C struct tag an out-pointer argument casts through
   * under a binding header (the brand literal, or `'char'` for `Out<CString>`), `undefined`
   * elsewhere. The fallback declaration needs no tag (`void **`), so this exists only for
   * the header case — stamped by the lowering from the parameter's `Out<T>` spelling. */
  readonly argTags: readonly (string | undefined)[];
  readonly retKind: ExternAbiKind;
  readonly error?: ExternErrorConvention;
  readonly header?: string;
}

/** A fresh `Out<T>` out-slot (`outSlot<T>()`, docs/FFI.md §2): a rooted `void *` cell the
 * callee writes a `T*` into through the `T**` parameter.
 *
 * Not a call: there is no function VALUE anywhere (like `ExternCall`, the callee is a
 * mechanism, not a value). The emitter answers the pure zero-handle `(jsrt_value)0` — a slot
 * cell starts NULL and the callee overwrites it through the `T**` parameter, so creation
 * allocates nothing and needs no target. The node's `type` is `unknown` — opaque bits, not
 * a dynamic value — and the creation discipline (name, arity, inner) is the gate's STA1125
 * contract, restated by the lowering as STA4031. */
export interface OutNew extends Node {
  readonly kind: 'out-new';
}

/** A `.value` read on an `Out<T>` slot: what the callee stored, as the program sees it.
 * `operand` is always an `Out<T>`-typed identifier — the gate refuses every other receiver
 * (inline slots, non-slot values), so any other shape here is the lowering disagreeing with
 * the gate. `inner` is the slot's content kind, stamped by the lowering from the `Out<T>`
 * spelling: a brand reads as opaque bits in the same representation a branded-pointer
 * return travels in (docs/FFI.md §6), while a `CString` inner copies the stored `char *`
 * into a fresh runtime string exactly like a `cstring` return. */
export interface OutGet extends Node {
  readonly kind: 'out-get';
  readonly operand: Expression;
  readonly inner: 'pointer' | 'cstring';
}

/** What each console method takes, and the runtime function that serves it. The five printing
 * methods differ only in stream and in whether a top-level string prints bare, so they share
 * `jsrt_print`/`jsrt_eprint`; the rest each have their own entry point because each carries its
 * own state (the group indent, the per-label tallies) or its own output rule.
 *
 * `log`/`info`/`debug`/`warn`/`error` are VARIADIC (plan.md §8 step 18): Node inspects every
 * argument and joins the forms with one space, and `console.log()` prints the bare newline.
 * Their `fn` serves the one-argument call exactly as before; any other count goes to `variadic`,
 * which takes `(count, argv)` over the caller's rooted slots on the `jsrt_array_new` discipline.
 * `dir` stays unary: its second argument in Node is an options object, not a second value.
 *
 * `optional` marks a trailing argument the method may omit, and `bare` is how the omission
 * reaches the runtime. Where `bare` is ABSENT the lowering pads the argument with `undefined`,
 * which is sound only because the spec's own absent case IS undefined there: `count()` and
 * `count(undefined)` both tally under "default". Where `bare` is present the two forms are
 * genuinely different output — Node prints `console.group(undefined)` as "undefined" and
 * `console.assert(c, undefined)` as "Assertion failed undefined", where the omitted forms print
 * nothing — so the short form gets its own C entry point rather than a sentinel the runtime
 * would have to mistake for absence. This is the `lastIndexOf` rule (plan-notes 83) with a second
 * answer available: refuse the form, or give it its own call. */
export const CONSOLE_METHODS = {
  assert: { arity: 2, optional: 1, fn: 'jsrt_console_assert', bare: 'jsrt_console_assert_bare' },
  count: { arity: 1, optional: 1, fn: 'jsrt_console_count' },
  countReset: { arity: 1, optional: 1, fn: 'jsrt_console_count_reset' },
  debug: { arity: 1, optional: 0, fn: 'jsrt_print', variadic: 'jsrt_print_many' },
  dir: { arity: 1, optional: 0, fn: 'jsrt_console_dir' },
  error: { arity: 1, optional: 0, fn: 'jsrt_eprint', variadic: 'jsrt_eprint_many' },
  group: { arity: 1, optional: 1, fn: 'jsrt_console_group', bare: 'jsrt_console_group_bare' },
  groupEnd: { arity: 0, optional: 0, fn: 'jsrt_console_group_end' },
  info: { arity: 1, optional: 0, fn: 'jsrt_print', variadic: 'jsrt_print_many' },
  log: { arity: 1, optional: 0, fn: 'jsrt_print', variadic: 'jsrt_print_many' },
  table: { arity: 1, optional: 0, fn: 'jsrt_console_table' },
  time: { arity: 1, optional: 1, fn: 'jsrt_console_time' },
  timeEnd: { arity: 1, optional: 1, fn: 'jsrt_console_time_end' },
  trace: { arity: 1, optional: 1, fn: 'jsrt_console_trace', bare: 'jsrt_console_trace_bare' },
  warn: { arity: 1, optional: 0, fn: 'jsrt_eprint', variadic: 'jsrt_eprint_many' },
} as const satisfies Record<
  string,
  {
    readonly arity: number;
    readonly optional: number;
    readonly fn: string;
    readonly bare?: string;
    readonly variadic?: string;
  }
>;

export type ConsoleMethod = keyof typeof CONSOLE_METHODS;

/** Whether this width reaches the method's `(count, argv)` variadic entry point rather than a
 * positional one: any width but the declared arity on a method with `variadic`. The emitter
 * reads this, not the table, so the width-to-entry-point rule stays next to `consoleEntryPoint`. */
export function isConsoleVariadicWidth(method: ConsoleMethod, given: number): boolean {
  const shape = CONSOLE_METHODS[method];
  return 'variadic' in shape && given !== shape.arity;
}

/** Whether the call can leave an exception pending, so the emitter follows it with a check:
 * `table` reads each row's properties, and a variadic call of two or more arguments may apply
 * util.format, whose `%j` reads properties too (plan.md §9 Task 6.24) -- a getter there throws --
 * and whose `%s`/`%d`/`%i`/`%f` run the value's own `toString`/`valueOf` (Task 6.27). */
export function consoleMayThrow(call: ConsoleLogCall): boolean {
  return (
    call.method === 'table' ||
    (call.args.length >= 2 && isConsoleVariadicWidth(call.method, call.args.length))
  );
}

/** The C entry point for a call of this width, or `null` if the method has no such form. A method
 * without `bare` is always called at full arity because the lowering padded it there; a method
 * with `variadic` takes any other width at its `(count, argv)` entry point. */
export function consoleEntryPoint(method: ConsoleMethod, given: number): string | null {
  const shape = CONSOLE_METHODS[method];
  if (given === shape.arity) {
    return shape.fn;
  }
  if ('variadic' in shape) {
    return shape.variadic;
  }
  return 'bare' in shape && given === shape.arity - shape.optional ? shape.bare : null;
}

/** A console call. The method survives lowering because the runtime entry points are no longer
 * one function and a stream flag: `dir` suppresses the bare-string exception, `group`/`groupEnd`
 * move an indent every other console write then honours, and `count` keeps per-label tallies.
 * `args` is either the method's full arity or, for the two methods whose omitted tail is its own
 * C entry point, the arity minus its optional tail — except on the five variadic methods, where
 * it is any width at all — `consoleEntryPoint` maps the width to the
 * call, and nothing downstream branches on the method itself. */
export interface ConsoleLogCall extends Node {
  readonly kind: 'console-log';
  readonly method: ConsoleMethod;
  readonly args: readonly Expression[];
}

/** `/ab+c/gi` — a regular-expression literal, carried as the two strings the runtime compiles it
 * from: the pattern without its delimiting slashes, and the flag letters as written.
 *
 * A literal, but NOT a constant, and the difference is normative: §22.2.4.1 makes every evaluation
 * of a regexp literal a new object, and it has to, because `lastIndex` is mutable state ON that
 * object — hoisting one out of a loop would let one iteration's match position leak into the next.
 * So the emitter compiles the pattern at each evaluation rather than once at startup.
 *
 * The engine is vendored (quickjs-ng's libregexp, plan.md golden rule 5), which is why the pattern
 * travels as TEXT all the way to the runtime: nothing above the C boundary parses it, so nothing
 * above the C boundary can disagree with the engine about what it means. */
export interface RegExpLiteral extends Node {
  readonly kind: 'regexp-literal';
  readonly source: string;
  readonly flags: string;
}

/** The `RegExp.prototype` surface, on the `COLLECTION_OPS` discipline: a closed set of methods,
 * each one runtime function with a fixed C signature, never a function value.
 *
 * `result` is what the C function hands back, and the two entries differ: `test` answers a C `bool`
 * the emitter has to box, `exec` answers a `jsrt_value` already. `exec`'s HIR type is Unknown
 * rather than an array because the checker's own answer is `RegExpExecArray | null` — the null is
 * real, and a node typed `array` would be the compiler asserting a match it has not made. */
export const REGEXP_OPS = {
  test: { arity: 1, result: 'boolean' },
  exec: { arity: 1, result: 'match' },
  toString: { arity: 0, result: 'string' },
} as const satisfies Record<string, { arity: number; result: 'boolean' | 'match' | 'string' }>;

export type RegExpOperation = keyof typeof REGEXP_OPS;

/** `Date.prototype`, SLICE A: everything that is a pure function of the time value (plan.md §7
 * Task 4.2). The local-time getters and `getTimezoneOffset` are slice B; `toString`, the call form
 * `Date()`, and every `toLocale*` need CLDR names and belong to the intl feature build.
 *
 * `fn` is written out rather than derived. The mechanical camelCase-to-snake_case rule the string
 * and array tables use turns `getUTCFullYear` into `get_u_t_c_full_year`, and a special case for
 * runs of capitals would be a rule invented to serve one table -- naming the C function is both
 * shorter and greppable from either side.
 *
 * `optional` counts TRAILING arguments the caller may omit. The spec gives an omitted component the
 * meaning "keep the current value", which an explicitly passed `undefined` also has, so the
 * lowering pads to full arity and the runtime reads absence off `JSRT_UNDEFINED` -- the
 * `CONSOLE_METHODS` rule, on the side where padding IS observably identical.
 *
 * `toJSON` is declared `(): string` by `lib.es5.d.ts`, but §21.4.4.37 answers `null` for an Invalid
 * Date and Node agrees. The result is typed as the checker sees it; the divergence is the lib's,
 * is documented in docs/SUBSET.md, and is what makes `JSON.stringify(new Date(NaN))` the string
 * "null" rather than an abort. */
export const DATE_OPS = {
  getTime: { arity: 0, optional: 0, fn: 'jsrt_date_get_time', result: 'number' },
  valueOf: { arity: 0, optional: 0, fn: 'jsrt_date_get_time', result: 'number' },
  getUTCFullYear: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_full_year', result: 'number' },
  getUTCMonth: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_month', result: 'number' },
  getUTCDate: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_date', result: 'number' },
  getUTCDay: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_day', result: 'number' },
  getUTCHours: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_hours', result: 'number' },
  getUTCMinutes: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_minutes', result: 'number' },
  getUTCSeconds: { arity: 0, optional: 0, fn: 'jsrt_date_get_utc_seconds', result: 'number' },
  getUTCMilliseconds: {
    arity: 0,
    optional: 0,
    fn: 'jsrt_date_get_utc_milliseconds',
    result: 'number',
  },
  setTime: { arity: 1, optional: 0, fn: 'jsrt_date_set_time', result: 'number' },
  setUTCFullYear: { arity: 3, optional: 2, fn: 'jsrt_date_set_utc_full_year', result: 'number' },
  setUTCMonth: { arity: 2, optional: 1, fn: 'jsrt_date_set_utc_month', result: 'number' },
  setUTCDate: { arity: 1, optional: 0, fn: 'jsrt_date_set_utc_date', result: 'number' },
  setUTCHours: { arity: 4, optional: 3, fn: 'jsrt_date_set_utc_hours', result: 'number' },
  setUTCMinutes: { arity: 3, optional: 2, fn: 'jsrt_date_set_utc_minutes', result: 'number' },
  setUTCSeconds: { arity: 2, optional: 1, fn: 'jsrt_date_set_utc_seconds', result: 'number' },
  setUTCMilliseconds: {
    arity: 1,
    optional: 0,
    fn: 'jsrt_date_set_utc_milliseconds',
    result: 'number',
  },
  // The LOCAL family (slice B). Same calendar arithmetic as the UTC rows over a reading shifted by
  // the host zone -- so they share `set_fields`/`field_of` in the runtime and differ only in one
  // bit. `getTimezoneOffset` is the odd one out: it reports MINUTES WEST, so UTC+2 answers -120.
  getFullYear: { arity: 0, optional: 0, fn: 'jsrt_date_get_full_year', result: 'number' },
  getMonth: { arity: 0, optional: 0, fn: 'jsrt_date_get_month', result: 'number' },
  getDate: { arity: 0, optional: 0, fn: 'jsrt_date_get_date', result: 'number' },
  getDay: { arity: 0, optional: 0, fn: 'jsrt_date_get_day', result: 'number' },
  getHours: { arity: 0, optional: 0, fn: 'jsrt_date_get_hours', result: 'number' },
  getMinutes: { arity: 0, optional: 0, fn: 'jsrt_date_get_minutes', result: 'number' },
  getSeconds: { arity: 0, optional: 0, fn: 'jsrt_date_get_seconds', result: 'number' },
  getMilliseconds: { arity: 0, optional: 0, fn: 'jsrt_date_get_milliseconds', result: 'number' },
  getTimezoneOffset: {
    arity: 0,
    optional: 0,
    fn: 'jsrt_date_get_timezone_offset',
    result: 'number',
  },
  setFullYear: { arity: 3, optional: 2, fn: 'jsrt_date_set_full_year', result: 'number' },
  setMonth: { arity: 2, optional: 1, fn: 'jsrt_date_set_month', result: 'number' },
  setDate: { arity: 1, optional: 0, fn: 'jsrt_date_set_date', result: 'number' },
  setHours: { arity: 4, optional: 3, fn: 'jsrt_date_set_hours', result: 'number' },
  setMinutes: { arity: 3, optional: 2, fn: 'jsrt_date_set_minutes', result: 'number' },
  setSeconds: { arity: 2, optional: 1, fn: 'jsrt_date_set_seconds', result: 'number' },
  setMilliseconds: { arity: 1, optional: 0, fn: 'jsrt_date_set_milliseconds', result: 'number' },
  toISOString: { arity: 0, optional: 0, fn: 'jsrt_date_to_iso_string', result: 'string' },
  toJSON: { arity: 0, optional: 0, fn: 'jsrt_date_to_json', result: 'string' },
  toDateString: { arity: 0, optional: 0, fn: 'jsrt_date_to_date_string', result: 'string' },
  toUTCString: { arity: 0, optional: 0, fn: 'jsrt_date_to_utc_string', result: 'string' },
} as const satisfies Record<
  string,
  {
    readonly arity: number;
    readonly optional: number;
    readonly fn: string;
    readonly result: 'number' | 'string';
  }
>;

export type DateOperation = keyof typeof DATE_OPS;

/** What a {@link TYPED_OPS} row's result is. A kind name rather than an HType so the table stays a
 * plain constant the gate, the lowering and the verifier read alike; `typedResultType` maps it. */
export type TypedResult = 'number' | 'undefined' | 'uint8array' | 'arraybuffer';

/** `ArrayBuffer` and `Uint8Array` (plan.md T11.1, docs/VALUE.md §4.19): every landed member, one
 * runtime function each, keyed by the spelling a diagnostic uses.
 *
 * `form` is how the source reaches it: `new` (no receiver), `get` (a data property read off the
 * receiver) or `call` (a method, which exists only as a callee). `receiver` is the HType kind the
 * first argument must have -- the verifier pins it because the runtime reads the layout after a
 * class test that turns a lie into a TypeError, and a wrong kind here is a lowering bug, not a
 * user error. `arity` counts the source arguments after the receiver, and the lowering pads to it
 * with `undefined`, which every runtime entry point reads as absence, exactly what the spec's
 * defaults do; `required` is how many the source must pass.
 *
 * `.buffer` answers `arraybuffer` whatever the checker says: an unparameterized `Uint8Array` types
 * it `ArrayBufferLike`, whose `SharedArrayBuffer` half no program here can construct. */
export const TYPED_OPS = {
  'new ArrayBuffer': {
    form: 'new',
    receiver: null,
    arity: 1,
    required: 0,
    fn: 'jsrt_arraybuffer_new',
    result: 'arraybuffer',
  },
  'new Uint8Array': {
    form: 'new',
    receiver: null,
    arity: 3,
    required: 0,
    fn: 'jsrt_uint8array_new',
    result: 'uint8array',
  },
  'ArrayBuffer.prototype.byteLength': {
    form: 'get',
    receiver: 'arraybuffer',
    arity: 0,
    required: 0,
    fn: 'jsrt_arraybuffer_byte_length',
    result: 'number',
  },
  'ArrayBuffer.prototype.slice': {
    form: 'call',
    receiver: 'arraybuffer',
    arity: 2,
    required: 0,
    fn: 'jsrt_arraybuffer_slice',
    result: 'arraybuffer',
  },
  'Uint8Array.prototype.length': {
    form: 'get',
    receiver: 'uint8array',
    arity: 0,
    required: 0,
    fn: 'jsrt_uint8array_length',
    result: 'number',
  },
  'Uint8Array.prototype.byteLength': {
    form: 'get',
    receiver: 'uint8array',
    arity: 0,
    required: 0,
    fn: 'jsrt_uint8array_byte_length',
    result: 'number',
  },
  'Uint8Array.prototype.byteOffset': {
    form: 'get',
    receiver: 'uint8array',
    arity: 0,
    required: 0,
    fn: 'jsrt_uint8array_byte_offset',
    result: 'number',
  },
  'Uint8Array.prototype.buffer': {
    form: 'get',
    receiver: 'uint8array',
    arity: 0,
    required: 0,
    fn: 'jsrt_uint8array_buffer',
    result: 'arraybuffer',
  },
  'Uint8Array.prototype.subarray': {
    form: 'call',
    receiver: 'uint8array',
    arity: 2,
    required: 0,
    fn: 'jsrt_uint8array_subarray',
    result: 'uint8array',
  },
  'Uint8Array.prototype.slice': {
    form: 'call',
    receiver: 'uint8array',
    arity: 2,
    required: 0,
    fn: 'jsrt_uint8array_slice',
    result: 'uint8array',
  },
  'Uint8Array.prototype.set': {
    form: 'call',
    receiver: 'uint8array',
    arity: 2,
    required: 1,
    fn: 'jsrt_uint8array_set',
    result: 'undefined',
  },
} as const satisfies Record<
  string,
  {
    readonly form: 'new' | 'get' | 'call';
    readonly receiver: 'uint8array' | 'arraybuffer' | null;
    readonly arity: number;
    readonly required: number;
    readonly fn: string;
    readonly result: TypedResult;
  }
>;

export type TypedOperation = keyof typeof TYPED_OPS;

export function typedResultType(result: TypedResult): HType {
  switch (result) {
    case 'number':
      return H_NUMBER;
    case 'undefined':
      return H_UNDEFINED;
    case 'uint8array':
      return H_UINT8ARRAY;
    case 'arraybuffer':
      return H_ARRAYBUFFER;
  }
}

/** The class a typed receiver kind prints as, which is also the first half of its table keys. */
export function typedClassName(
  receiver: 'uint8array' | 'arraybuffer',
): 'Uint8Array' | 'ArrayBuffer' {
  return receiver === 'uint8array' ? 'Uint8Array' : 'ArrayBuffer';
}

/** The table row `receiver.member` names, or undefined for a member that has not landed. */
export function typedMember(
  receiver: 'uint8array' | 'arraybuffer',
  member: string,
): TypedOperation | undefined {
  const key = `${typedClassName(receiver)}.prototype.${member}`;
  return Object.hasOwn(TYPED_OPS, key) ? (key as TypedOperation) : undefined;
}

/** The `Date` namespace calls slice A lands. `parse` accepts the §21.4.1.32 Date Time String
 * Format only -- a documented divergence from Node, whose non-ISO heuristics are TZ-dependent and
 * implementation-defined (docs/SUBSET.md).
 *
 * `now` reads a clock. Nondeterminism is a PROOF problem, not an acceptance problem (plan §7's
 * determinism carve-out), so it is an ordinary table row here and proves through a unit test
 * instead of a golden fixture. */
export const DATE_STATICS = {
  UTC: { arity: 7, optional: 6, fn: 'jsrt_date_utc' },
  parse: { arity: 1, optional: 0, fn: 'jsrt_date_parse' },
  now: { arity: 0, optional: 0, fn: 'jsrt_date_now' },
} as const satisfies Record<
  string,
  { readonly arity: number; readonly optional: number; readonly fn: string }
>;

export type DateStatic = keyof typeof DATE_STATICS;

/** The standard Error constructors, mirroring `ERROR_CTORS` in the gate and the descriptors in
 * `runtime/src/jsrt_error.c`. */
export const ERROR_CLASSES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** The `JSRTClass` descriptor a given error class is emitted against. One per class, defined in the
 * runtime rather than by the emitter -- which is the only thing that distinguishes this from a
 * `new` on a user class. */
export function errorDescriptor(ctor: ErrorClass): string {
  const snake = ctor === 'Error' ? 'error' : `${ctor.slice(0, -5).toLowerCase()}_error`;
  return `jsrt_class_${snake}`;
}

/** What an error VALUE is typed as: a fixed-shape object whose slots mirror the runtime layout in
 * `jsrt_error.c` exactly — slot 0 `name`, slot 1 `message` — so `e.message` is the ordinary
 * fixed-shape read and no downstream pass needs to know an error from any other object.
 *
 * `bases` carries `Error` for a subclass, which is what makes `e instanceof Error` assignable the
 * way the runtime's `parent` link makes it true. */
export function errorHType(ctor: ErrorClass): HObject {
  return {
    kind: 'object',
    name: ctor,
    fields: [
      { name: 'name', type: H_STRING },
      { name: 'message', type: H_STRING },
    ],
    methods: [],
    bases: ctor === 'Error' ? [] : ['Error'],
  };
}

/** `new TypeError(message)` and its four siblings.
 *
 * Not a `NewExpr`: there is no class DECLARATION to take a descriptor from, because the descriptor
 * lives in the runtime. Not a `CollectionNew` either -- this one takes an argument. The message is
 * always present: the lowering supplies an empty-string literal for `new Error()`, which is what
 * §20.5.1.1 step 3 leaves `message` as when the argument is undefined. */
export interface ErrorNew extends Node {
  readonly kind: 'error-new';
  readonly ctor: ErrorClass;
  readonly arg: Expression;
}

/** Reading a name that nothing in the program declares.
 *
 * This is the ONLY node whose value never reaches its consumer: evaluating it throws
 * `ReferenceError: <name> is not defined`, and the emitter follows it with the same pending check
 * every throwing call gets. It exists as an EXPRESSION rather than a statement because that is
 * where the language puts it -- `x + 1` and `f(x)` are the failing programs, and neither has a
 * statement position to hoist the throw into.
 *
 * The name is carried as a string because there is no binding to point at, which is the whole
 * condition being modelled. The checker either has no symbol or only an expando namespace whose
 * declarations are identifiers from JS property assignments, not runtime bindings. A name with a
 * real declaration but no lowered binding is still `STA4035`, an internal error; keeping those two
 * apart stops this node from swallowing compiler bugs.
 *
 * ts mode never builds one: `TS2304` is not in the js-mode suppression list, so the program is
 * already refused with `STA0012` before lowering runs. */
export interface ReferenceErrorRead extends Node {
  readonly kind: 'reference-error';
  readonly name: string;
}

/** Throwing `TypeError` with a fixed message. Used when assigning to a named function expression
 * identifier, which is immutable in strict mode (plan.md §8 step 12(e)). */
export interface TypeErrorThrow extends Node {
  readonly kind: 'type-error';
  readonly message: string;
}

/** `new Date(x)` for a given x -- a number of milliseconds, an ISO string, or another Date.
 *
 * Not a `NewExpr` (no descriptor, no constructor body) and not a `CollectionNew` (that one takes no
 * argument). The ZERO-argument form does not need a node of its own: §21.4.2.1 step 2 defines it as
 * the current time value, so the lowering desugars `new Date()` to `new Date(Date.now())` -- which
 * is a `date-static` argument here and identical in every observable way. */
export interface DateNew extends Node {
  readonly kind: 'date-new';
  readonly arg: Expression;
}

/** A `Date.prototype` call: one runtime function per operation, over the receiver's time value.
 * `args` is always the table's full arity -- the lowering pads an omitted trailing component with
 * an undefined-literal, which is what the spec's "if the argument is present" step reads. */
/** `new Date(y, m, d?, h?, mi?, s?, ms?)` -- §21.4.2.1 steps 4-11, which is `Date.UTC`'s arithmetic
 * read as LOCAL time. It is a separate node from {@link DateNew} rather than a flag on it because
 * the two have different shapes: one value in, versus seven components the lowering pads. Omitted
 * trailing components arrive as `undefined`, which the runtime reads as the spec's default. */
export interface DateComponents extends Node {
  readonly kind: 'date-components';
  readonly args: readonly Expression[];
}

/** One {@link TYPED_OPS} row applied: the receiver first (for a `get` or a `call`), then the
 * source arguments padded to the row's arity. */
export interface TypedOp extends Node {
  readonly kind: 'typed-op';
  readonly op: TypedOperation;
  readonly args: readonly Expression[];
}

/** `Number.prototype`'s landed methods (plan-notes 310): one runtime function each, the receiver
 * first and the one argument padded with `undefined`, which both read as the spec's default
 * (radix 10, zero digits). Both answer a string and may leave a RangeError pending. */
export const NUMBER_OPS = {
  toString: { fn: 'jsrt_number_to_string_radix' },
  toFixed: { fn: 'jsrt_number_to_fixed' },
} as const satisfies Record<string, { readonly fn: string }>;

export type NumberOperation = keyof typeof NUMBER_OPS;

export interface NumberOp extends Node {
  readonly kind: 'number-op';
  readonly op: NumberOperation;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

export interface DateOp extends Node {
  readonly kind: 'date-op';
  readonly op: DateOperation;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

/** `Date.UTC(...)` or `Date.parse(s)`. Padded to full arity for the same reason `DateOp` is. */
export interface DateStaticCall extends Node {
  readonly kind: 'date-static';
  readonly method: DateStatic;
  readonly args: readonly Expression[];
}

/** `RegExp.prototype`'s DATA properties (§22.2.6), which are reads and not calls -- the other half
 * of the surface `REGEXP_OPS` covers.
 *
 * Every one is DERIVED from the compiled regexp, so none of them is state this compiler has to keep
 * in step: `source` and `flags` are the two strings the runtime normalized at construction, and the
 * eight predicates are one bit test each. `flag` carries the letter rather than a bit because the
 * `LRE_FLAG_*` constants belong to the vendored engine's header, which generated C never includes.
 *
 * `lastIndex` is READ-ONLY here. The spec makes it a writable property and `re.lastIndex = 0` is
 * how a program restarts a /g scan, but a WRITE is an assignment target, and the object model has
 * no node for assigning into a builtin -- so the gate refuses it by name rather than lowering a
 * read into a store (plan-notes 121). */
export const REGEXP_FIELDS = {
  source: { result: 'string' },
  flags: { result: 'string' },
  lastIndex: { result: 'number' },
  hasIndices: { result: 'boolean', flag: 'd' },
  global: { result: 'boolean', flag: 'g' },
  ignoreCase: { result: 'boolean', flag: 'i' },
  multiline: { result: 'boolean', flag: 'm' },
  dotAll: { result: 'boolean', flag: 's' },
  unicode: { result: 'boolean', flag: 'u' },
  unicodeSets: { result: 'boolean', flag: 'v' },
  sticky: { result: 'boolean', flag: 'y' },
} as const satisfies Record<
  string,
  { result: 'string' | 'number' | 'boolean'; flag?: 'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y' }
>;

export type RegExpField = keyof typeof REGEXP_FIELDS;

/** `re.source`, `re.global` and their nine siblings.
 *
 * Unlike a `MatchRead`, the target here is CONCRETELY typed -- a regexp is a regexp, the checker
 * says so and the HIR carries it -- so the verifier pins the receiver's type the way it pins a
 * `RegExpOp`'s, and the read is a struct load behind a fixed C signature. */
export interface RegExpFieldRead extends Node {
  readonly kind: 'regexp-read';
  readonly field: RegExpField;
  readonly target: Expression;
}

/** What a MATCH ARRAY -- the answer of `exec` and of a non-global `match` -- exposes beyond its
 * elements. `index`, `input` and `groups` are ECMA-262 §22.2.7.2's properties of the result, which
 * is why a jsrt array has a property table at all; `length` is the array's own and reads through
 * the array header, not the table. The result types are the RUNTIME's, not a user annotation: this
 * compiler built the value, so there is no claim here for a boundary check to doubt.
 *
 * `groups` is Unknown because it is an object or `undefined` depending on the pattern, which is a
 * union the HIR does not model. */
export const MATCH_FIELDS = {
  index: 'number',
  input: 'string',
  groups: 'unknown',
  length: 'number',
} as const satisfies Record<string, 'number' | 'string' | 'unknown'>;

export type MatchField = keyof typeof MATCH_FIELDS;

/** `m.index` and its three siblings, where `m` is the match a `RegExp.prototype.exec` or a
 * `String.prototype.match` answered.
 *
 * The target's HIR type is Unknown -- `exec` answers a match OR null, and the HIR has no union --
 * so the CHECKER is what proved this receiver is a match, exactly as it proves a string receiver
 * for a StringOp. The runtime settles it a second time: a wrong tag reaching `jsrt_get_prop` is a
 * loud panic, never a silent misread. */
export interface MatchRead extends Node {
  readonly kind: 'match-read';
  readonly field: MatchField;
  readonly target: Expression;
}

export interface RegExpOp extends Node {
  readonly kind: 'regexp-op';
  readonly op: RegExpOperation;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

/** `c ? t : f`. Both branches are expressions; the condition is ToBoolean. */
export interface ConditionalExpr extends Node {
  readonly kind: 'conditional';
  readonly condition: Expression;
  readonly consequent: Expression;
  readonly alternate: Expression;
}

/** `base?.rest` — optional chaining (plan.md §8 step 24).
 *
 * `base` is evaluated exactly once, into a rooted frame slot. When it is nullish the node
 * answers `undefined` and `consequent` never runs — not the accesses in it, and not the
 * computed keys or call arguments either, which is the short-circuit the syntax promises.
 * Otherwise `consequent` runs, reading the guarded value through `optional-base` leaves.
 *
 * The consequent is an ordinary expression tree built by the plain lowering arms: a `?.`
 * guards only its own base, and every link above it — plain or optional — lowers the way it
 * would without the guard, bottoming out at the leaf. A nested `?.` is a nested node testing
 * its own base, which is why `a?.b?.c` answers `undefined` for a nullish `a.b` while
 * `a?.b.c` throws there. A base whose type cannot be nullish never builds this node: the
 * lowering emits the plain access instead, so `C?.x` and `s?.length` are today's code. */
export interface OptionalChain extends Node {
  readonly kind: 'optional-chain';
  readonly base: Expression;
  readonly consequent: Expression;
}

/** The guarded value of the enclosing `optional-chain` — the base, known non-nullish.
 *
 * A leaf, not a binding: it names no Scope entry and captures nothing, so capture analysis
 * never sees it. It is only ever built where the lowering holds the base's value in the
 * chain's frame slot, and the emitter resolves it to that slot; outside a chain it has no
 * meaning, and the emitter refuses one. The `type` is the base's type narrowed by the
 * non-nullish test — what the consequent's arms dispatch on. */
export interface OptionalBase extends Node {
  readonly kind: 'optional-base';
}

/** An accessor property as a `++`/`--`/`+=`/`=` place: the read calls `get <key>`, the write
 * calls `set <key>`. The receiver is already evaluated once into the update's slot (the
 * read-once rule, plan-notes 43), so the get and the set share it. Each half is its own
 * method-table slot (`get x` vs `set x`); `getSlot` is `-1` when the property has only a
 * setter, which the compound forms answer `undefined` for. */
export interface AccessorPlace extends Node {
  readonly kind: 'accessor-place';
  readonly target: Expression;
  readonly owner: string;
  readonly property: string;
  readonly getSlot: number;
  readonly setSlot: number;
  readonly dispatch: 'direct' | 'virtual';
  readonly hasGet: boolean;
}

/** A place `++`/`--`/`+=`/`=` may read and write in expression position. */
export type UpdatePlace = Identifier | IndexAccess | FieldAccess | DynFieldAccess | AccessorPlace;

/** `++x`, `x++`, `x += e`, and `x = e` as expressions. Statement position still folds to Assignment. */
export interface UpdateExpr extends Node {
  readonly kind: 'update';
  readonly operator: '++' | '--' | '=' | BinaryOperator | LogicalOp['operator'];
  readonly prefix: boolean;
  readonly target: UpdatePlace;
  readonly value?: Expression;
}

export type Expression =
  | MatchRead
  | RegExpFieldRead
  | DateComponents
  | DateNew
  | ErrorNew
  | ReferenceErrorRead
  | TypeErrorThrow
  | DateOp
  | TypedOp
  | DateStaticCall
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | UndefinedLiteral
  | Identifier
  | BinaryOp
  | UnaryOp
  | TypeOf
  | DeleteProp
  | ConditionalExpr
  | OptionalChain
  | OptionalBase
  | UpdateExpr
  | BoundaryCheck
  | LogicalOp
  | TemplateLiteral
  | StringLength
  | ArrayLength
  | FunctionLength
  | ArrayLiteral
  | ArrayOp
  | JsonStringify
  | JsonParse
  | ObjectStaticCall
  | IndexAccess
  | NewExpr
  | NewValue
  | InstanceOf
  | InstanceOfValue
  | ClassValue
  | FieldAccess
  | MethodCall
  | DynMethodCall
  | FieldCall
  | NumberOp
  | MethodValue
  | ObjectLiteral
  | DynObjectLiteral
  | DynFieldAccess
  | AccessorPlace
  | CollectionNew
  | CollectionOp
  | MathCall
  | StringOp
  | StringStaticCall
  | GlobalCall
  | RegExpLiteral
  | RegExpOp
  | FunctionExpr
  | CallExpr
  | ExternCall
  | OutNew
  | OutGet
  | AwaitExpr
  | YieldExpr
  | PromiseStaticCall
  | PromiseMethodCall
  | PromiseConstruct
  | ConsoleLogCall
  | IteratorNext
  | GetIterator;

// ─────────────────────────────────────────────────────────────────────────────
// Statements

/** `super(a, b)` — the base constructor, run against THIS constructor's receiver.
 *
 * A statement, not an expression, because that is all it can ever be: the gate admits it only as
 * the first statement of a derived constructor, and JavaScript gives it no value. Making it a
 * statement is also what lets the lowering place the class's own field initializers, which run
 * after the base constructor and before the rest of the body — a fixed position only because the
 * call is in a fixed position.
 *
 * `receiver` is named rather than implied: one object is being constructed, the base constructor
 * fills its lower slots and this one fills the rest, and an implicit receiver would be the one part
 * of that story the HIR did not say out loud. `className` is the BASE, for the same reason
 * `MethodCall` names a class — the emitter reaches a specific constructor.
 *
 * A base with no constructor to run emits nothing. It can have no parameters either (the checker
 * would reject the arguments), so there is nothing whose side effects could be skipped. */
export interface SuperCall extends Node {
  readonly kind: 'super-call';
  readonly className: string;
  readonly receiver: Expression;
  readonly args: readonly Expression[];
}

/** let or const binding. An absent `value` is `let x;` — the slot starts as `undefined`
 * (docs/VALUE.md). TypeScript's definite-assignment errors still reject a typed read before a
 * write; the HIR does not track that itself.
 *
 * `var` is not a third declKind. The lowering hoists it to a function-scoped `let` initialized
 * `undefined` and emits an assignment at the original site (plan.md §8 step 3). */
export interface Declaration extends Node {
  readonly kind: 'declaration';
  readonly name: string;
  readonly declKind: 'let' | 'const';
  readonly value?: Expression;
}

/** Assignment to an existing binding (no destructuring). */
export interface Assignment extends Node {
  readonly kind: 'assignment';
  readonly target: string; // identifier name
  readonly value: Expression;
}

/** `a[i] = v`.
 *
 * A statement, like Assignment, and separate from it because the destination is not a name: it is
 * two expressions that must both be evaluated, in source order and before the value, and either
 * can have side effects. Compound forms (`a[i] += 1`, `a[i]++`) lower to this with the read folded
 * into `value`, which is why `index` must be evaluated exactly once — see plan-notes 43. */
export interface IndexAssignment extends Node {
  readonly kind: 'index-assignment';
  readonly target: Expression;
  readonly index: Expression;
  readonly value: Expression;
}

/** `o.x = v`, including `this.x = v` in a constructor.
 *
 * Same `slot` contract as FieldAccess, and the same evaluation order as IndexAssignment: target,
 * then value. */
export interface FieldAssignment extends Node {
  readonly kind: 'field-assignment';
  readonly target: Expression;
  readonly field: string;
  readonly slot: number;
  readonly value: Expression;
}

/** `o.x = v` against a dynamic object: overwrite in place when the key exists, shape transition
 * when it does not. Same evaluation order as FieldAssignment (target, then value), and both land
 * in rooted slots first — `jsrt_set_prop` may grow the slot array, which allocates. `xs.length = n`
 * on an array-typed target is this node too: the same entry resizes the array (plan-notes 310). */
export interface DynFieldAssignment extends Node {
  readonly kind: 'dyn-field-assignment';
  readonly target: Expression;
  readonly field: string;
  readonly value: Expression;
}

/** One method or constructor. `fn`'s parameter list begins with the RECEIVER, under a name no
 * source can spell, and `this` in the body lowers to a read of it.
 *
 * That reduction is the reason methods needed no new machinery: a method is an ordinary function
 * with one extra parameter, so it inherits the closure ABI, arity padding, capture analysis and the
 * static-closure fast path unchanged — and an arrow inside a method that closes over `this` is just
 * an arrow that captures a parameter, which rung 4b already knows how to do. */
export interface ClassMethod {
  readonly name: string;
  readonly fn: FunctionExpr;
}

/** `class C { … }`.
 *
 * Not hoisted: a class is in its temporal dead zone until its declaration is reached, so this is an
 * ordinary statement in source order and the binding is not visible before it. What the emitter
 * lifts to file scope is only the STATIC part — the `JSRTClass` descriptor and the method closures
 * — which no program can observe the timing of.
 *
 * `fields` is in slot order and is the single source of that order: `HObject.fields`, the emitted
 * descriptor, and every `slot` in a FieldAccess all have to agree with it. */
export interface ClassDeclaration extends Node {
  readonly kind: 'class-declaration';
  readonly name: string;
  /** The immediate base class's name, absent at the root of a chain. `fields` already includes the
   * inherited ones (base-first, which is what makes a derived instance readable as a base one), so
   * this is not needed for layout -- it is needed for `instanceof`, which asks about the chain. */
  readonly base?: string;
  readonly fields: readonly Parameter[];
  readonly ctor?: ClassMethod;
  readonly methods: readonly ClassMethod[];
  /** Static members, as ordinary bindings under a name no source can spell (`C.count`).
   *
   * A static belongs to the class OBJECT, not to any instance: it is not a slot in the layout, it
   * is ONE binding for the whole program, and `C.count` reads it by name. A static method is the
   * same thing with a function for a value -- whose parameter zero is the class object, so a
   * `this` inside one reads the receiver a call threads (`docs/VALUE.md` §4.17). Modelling them
   * this way is why they needed no node and no verifier case of their own -- a static read is an
   * `Identifier`, a static write is an `Assignment`, and a static call is a `CallExpr` with the
   * class object as its first argument.
   *
   * They ride on the class rather than being spliced into the enclosing statement list so that a
   * class stays one statement in source order; the enclosing scope reaches them by walking here,
   * which is also what fixes WHEN they are initialized -- where the class declaration sits. */
  readonly statics: readonly Declaration[];
  /** The class's own static members as the class OBJECT's table sees them (docs/VALUE.md §4.17):
   * property name as written, the `statics` binding each resolves to, and what kind of member it
   * is. This is how a run-time class value answers `v.count` / `v.m()` where no name resolves --
   * the emitter builds the `JSRTStaticEntry` table from it. Parallel to `statics`, which carries
   * the bindings' VALUES; an accessor contributes one entry per half. */
  readonly staticProps: readonly StaticProp[];
  /** The method table, in slot order: one entry per method this class responds to, inherited ones
   * first and in the base's own order. Each entry names the class whose body IMPLEMENTS the method
   * for THIS class, which is where an override differs from its base -- same name, same slot,
   * different implementor.
   *
   * Empty for a class that participates in no overriding: such a class needs no table, because
   * every call to its methods is direct. That is not only an optimization -- a table is a
   * file-scope constant, and a class declared inside a function may have methods that capture,
   * which have no one constant form. Overriding is refused there for exactly that reason. */
  readonly vtable: readonly VtableEntry[];
}

/** One method-table entry: the name at this slot, and the class whose body implements it. */
export interface VtableEntry {
  readonly name: string;
  readonly className: string;
}

/** One row of a class object's statics table (docs/VALUE.md §4.17).
 *
 * `name` is the property name as JavaScript spells it; `binding` is the unspellable HIR binding
 * (`C.count`, `C get x`) whose storage the row points at. `kind` distinguishes what the runtime
 * does with it: a field or method loads the slot, an accessor half CALLS it with the class
 * object as receiver, and `console.log` prints fields only (Node's class inspector skips
 * methods and accessors). */
export interface StaticProp {
  readonly name: string;
  readonly binding: string;
  readonly kind: 'field' | 'method' | 'get' | 'set';
}

/** Expression statement (wraps an expression). */
export interface ExpressionStatement extends Node {
  readonly kind: 'expression-statement';
  readonly expression: Expression;
}

/** if statement (else branch is optional). */
export interface IfStatement extends Node {
  readonly kind: 'if-statement';
  readonly condition: Expression;
  readonly consequent: Block;
  readonly alternate?: Block;
}

/** A loop's optional source label.
 *
 * The label is carried ON the loop rather than in a wrapping LabeledStatement node. A label in
 * JavaScript exists only to be named by `break`/`continue`, and `continue` can only name a loop —
 * so the label is a property of the loop, and a wrapper node would sit between `break outer` and
 * the loop it has to leave for no gain. Labels on other statements become a labelled Block
 * (`foo: { … break foo; }`); `continue` still names only a loop.
 *
 * INVARIANT: every label named by a BreakStatement or ContinueStatement is the label of an
 * enclosing loop (or, for `break`, an enclosing switch or labelled block). The verifier checks it, because a label
 * that resolves to nothing becomes a `goto` to a C label that was never emitted — a failure that
 * would surface as a clang error against generated code rather than as a diagnostic. */
type Labelled = { readonly label?: string; readonly perIterationEnv?: true };

/** while statement. */
export interface WhileStatement extends Node, Labelled {
  readonly kind: 'while-statement';
  readonly condition: Expression;
  readonly body: Block;
}

/** do/while: the body runs before the first test, which is the whole difference. */
export interface DoWhileStatement extends Node, Labelled {
  readonly kind: 'do-while-statement';
  readonly condition: Expression;
  readonly body: Block;
}

/** C-style `for`. All three header slots are optional — `for (;;)` is a legal infinite loop.
 *
 * `init` and `update` are Statements rather than Expressions because `for (let i = 0; …)` declares
 * a binding, which is not an expression. An absent `condition` means `true`, not `undefined`: the
 * emitter must not confuse "no test" with "a test that yields undefined". */
export interface ForStatement extends Node, Labelled {
  readonly kind: 'for-statement';
  readonly init?: Statement;
  readonly condition?: Expression;
  readonly update?: Statement;
  readonly body: Block;
}

/** `for (const x of a)` over an array, a string, a Map or a Set.
 *
 * Not sugar for a counting `for`, even though an array/string lowers to one: the binding is fresh
 * per iteration, and — unlike `a[i]` — its type is the element type with no `| undefined`, because
 * the loop only ever visits indices that exist. That is what keeps a typed iteration on the static
 * path.
 *
 * `iterable` is an array, a string, a Map, a Set, a boxed iterator, or a MethodCall of a user
 * class's `[Symbol.iterator]()` (docs/VALUE.md §4.13). A Map yields a `[key, value]` pair, which
 * the HIR has no tuple for, so that binding is Unknown. */
/** Which specialized walk a for-of uses. `identity` is the collection itself; the other three
 * are the `keys`/`values`/`entries` views inlined when the call is the loop operand. */
export type IteratorView = 'identity' | 'keys' | 'values' | 'entries';

export interface ForOfStatement extends Node, Labelled {
  readonly kind: 'for-of-statement';
  readonly binding: string;
  readonly declKind: 'let' | 'const';
  readonly iterable: Expression;
  readonly view: IteratorView;
  readonly body: Block;
}

/** What one step of a `for-of` binds, given the ITERABLE'S HIR TYPE.
 *
 * The HIR type, never the checker's answer at the binding name, and that distinction is the whole
 * point of this living here rather than at either call site. The two can disagree: `const xs = []`
 * followed by `xs.push(1)` is an evolving array the checker resolves to `number[]`, while js mode
 * has deliberately widened the binding to Unknown — so the checker types the loop variable
 * `number` and the emitted loop yields a tagged value. Lowering it from the checker produced HIR
 * whose binding claimed `number` and whose verifier, reading the iterable, said `unknown`
 * (STA4010). Both callers ask this one function so the answer cannot diverge again.
 *
 * Separate from the indexing rule because the emitted loop is different, not just the message: a
 * for-of over an array, a string, a Map or a Set compiles to a specialized loop
 * (docs/VALUE.md §4.13). */
export function forOfElementType(iterable: HType, view: IteratorView): HType {
  if (iterable.kind === 'iterator') {
    return iterable.element;
  }
  if (iterable.kind === 'string') {
    return H_STRING;
  }
  if (view === 'entries') {
    return hUnknown(false); /* a two-element array; the HIR has no tuple */
  }
  if (iterable.kind === 'array') {
    return view === 'keys' ? H_NUMBER : iterable.element;
  }
  if (iterable.kind === 'map') {
    return view === 'keys' ? iterable.key : view === 'values' ? iterable.value : hUnknown(false);
  }
  if (iterable.kind === 'set') {
    return iterable.element;
  }
  return hUnknown(false);
}

/** `it.next()` / `it.return(v)` / `it.throw(e)` on an iterator VALUE.
 *
 * `next` is the ordinary step; it exists for boxed specialized iterators (`arr.keys()`) and for
 * generators alike. `return`/`throw` are the generator-closing pair (Phase 5 step 8): they are
 * admitted by the gate only when the receiver is a generator, and the runtime answers
 * `{ value, done }` exactly as `next` does. All three answer an ordinary two-field dynamic
 * object, typed Unknown because IteratorResult is an interface this model does not layout. */
export interface IteratorNext extends Node {
  readonly kind: 'iterator-next';
  readonly target: Expression;
  readonly op: 'next' | 'return' | 'throw';
  /** The value sent into a waiting `yield` (`next(v)`), the completion value (`return(v)`), or
   * the injected exception (`throw(e)`). An absent argument pads `undefined`. Specialized
   * iterators ignore it; generators use it as the resume value. */
  readonly sent: Expression;
}

/** Runtime GetIterator dispatch for `for-of` over a statically-unknown iterable (plan.md §8
 * step 2a(c)): the `jsrt_get_iterator` call the lowering wraps any operand in that no static
 * walk covers. The node's own type is always `iterator` with an Unknown element -- whatever the
 * runtime answers, `jsrt_iterator_step` drives it, and the yielded values are dynamically typed
 * -- so the existing boxed for-of walk takes it with no new emission arm. */
export interface GetIterator extends Node {
  readonly kind: 'get-iterator';
  readonly target: Expression;
}

/** One `case` or `default` arm. An absent `test` is `default`.
 *
 * `statements` is NOT a Block: a switch clause does not open a scope of its own, and its
 * statements fall through into the next clause unless something jumps. Modelling it as a Block
 * would suggest both of those are false. */
export interface SwitchClause {
  readonly test?: Expression;
  readonly statements: readonly Statement[];
}

/** `switch`.
 *
 * Two facts the lowering and emitter must both honour, neither of which C's `switch` provides:
 * clause tests use **strict equality** (so `case '1'` does not match `1`, and cases need not be
 * constants), and `default` is tried **last regardless of where it is written**. That is why this
 * lowers to a test chain plus gotos rather than to a C switch — see the emitter. */
export interface SwitchStatement extends Node, Labelled {
  readonly kind: 'switch-statement';
  readonly discriminant: Expression;
  readonly clauses: readonly SwitchClause[];
}

/** `break` / `break label`. An absent label means the innermost enclosing loop *or switch*. */
export interface BreakStatement extends Node, Labelled {
  readonly kind: 'break-statement';
}

/** `continue` / `continue label`. Unlike `break`, this never targets a switch — an absent label
 * means the innermost enclosing LOOP, skipping any switch in between. */
export interface ContinueStatement extends Node, Labelled {
  readonly kind: 'continue-statement';
}

/** `throw e;`.
 *
 * The value is ANY value — JavaScript throws strings and numbers as happily as Error objects, and
 * Error objects landed with plan.md §8 step 2a(c), so a fixture that throws throws a primitive. The
 * statement never completes: control transfers to the nearest enclosing catch, running every
 * `finally` on the way, or unwinds out of `main` as an uncaught exception (exit code 1, message on
 * stderr — matching Node's observable behaviour, which is what the golden runner compares). */
export interface ThrowStatement extends Node {
  readonly kind: 'throw-statement';
  readonly value: Expression;
}

/** `try { … } catch (e) { … } finally { … }`.
 *
 * INVARIANT: at least one of `catchBlock`/`finallyBlock` is present — `try {}` alone is a syntax
 * error in JavaScript, and the verifier re-checks it because an emitter handed neither would emit
 * a block that catches nothing and cleans up nothing while claiming to.
 *
 * `catchBinding` is the caught name, absent both for `catch {` (the binding-less form) and when
 * there is no catch at all — `catchBlock` is what distinguishes those two. The binding is typed
 * `Unknown` always: anything can be thrown, so `useUnknownInCatchVariables` is not a strictness
 * flag here but the only sound answer, and a narrowing of the caught value goes through the same
 * BoundaryCheck machinery as any other `unknown` (§3.2.1).
 *
 * `finally` runs on EVERY exit from the try/catch — normal completion, a thrown value, a `return`,
 * a `break`/`continue` crossing the statement — and its own completion wins over the one it
 * interrupted. The emitter implements that with a per-try completion code and a dispatch after the
 * finally body; see the emitter, and docs/HIR.md §1.3. */
export interface TryStatement extends Node {
  readonly kind: 'try-statement';
  readonly tryBlock: Block;
  readonly catchBinding?: string;
  readonly catchBlock?: Block;
  readonly finallyBlock?: Block;
}

/** `function f(...) {...}` as a statement.
 *
 * Separate from Declaration, and not sugar for `const f = function f(){}`, because the binding is
 * HOISTED: it holds the function from the moment its scope is entered, so `f(); function f(){}`
 * runs. A `const` would be in its temporal dead zone at that point. The emitter honours this by
 * initializing every function-declaration binding at the top of the STATEMENT LIST it is declared
 * in, ahead of those statements in source order — which is only sound because a FunctionExpr's
 * value depends on nothing that has run yet. The list, not the enclosing body: a module is always
 * strict, so a function declared in a block belongs to that block and is initialized when the
 * block is entered (plan.md §8 step 12(e)). A `switch`'s clause list is one such list in total,
 * because a clause is not a scope of its own.
 *
 * INVARIANT: `type` is the function's type and equals `fn.type`; the binding and the value it
 * holds cannot disagree. */
export interface FunctionDeclaration extends Node {
  readonly kind: 'function-declaration';
  readonly name: string;
  readonly fn: FunctionExpr;
}

/** `return e;` or bare `return;`.
 *
 * An absent `value` means `undefined`, and is NOT the same as `value: UndefinedLiteral`: the two
 * agree on the value returned but not on the source, and a diagnostic that points at a `return`
 * the user did not write is a bad diagnostic. The emitter treats them identically. */
export interface ReturnStatement extends Node {
  readonly kind: 'return-statement';
  readonly value?: Expression;
}

/** Block: a sequence of statements. */
export interface Block extends Node {
  readonly kind: 'block';
  readonly statements: readonly Statement[];
  /** Desugaring sequence (destructure). Bindings leak to the enclosing statement list. */
  readonly flatten?: true;
  /** `foo: { … break foo; }`. `continue` cannot target this. */
  readonly label?: string;
}

export type Statement =
  | Declaration
  | Assignment
  | IndexAssignment
  | FieldAssignment
  | DynFieldAssignment
  | SuperCall
  | ClassDeclaration
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForOfStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | ThrowStatement
  | TryStatement
  | FunctionDeclaration
  | ReturnStatement
  | Block;

// ─────────────────────────────────────────────────────────────────────────────
// Module root

/** Module: the top-level container holding all statements.
 *
 * `fileName` is the absolute path of the source, kept here so the C emitter can write
 * `#line N "path"` without reaching back to a `ts.SourceFile`. */
export interface Module extends Node {
  readonly kind: 'module';
  readonly fileName: string;
  readonly statements: readonly Statement[];
  /** True when a top-level `await` appears in the merged program. The module body is then an
   * async unit (docs/MODES.md): named bindings stay globals; temps live in a heap environment so
   * they survive a suspension. */
  readonly isAsync: boolean;
  /** The module's own bindings that a nested function reads and the globals array cannot hold: a
   * `let`/`const` declared inside a top-level loop, which JavaScript re-creates every iteration.
   * They live in a module environment instead, laid out exactly like a function's `envVars` — the
   * array position IS the slot index — so the loop's per-iteration clone gives each iteration its
   * own copy. Empty for the overwhelming majority of modules. */
  readonly envVars: readonly string[];
}

/* jscpd:ignore-end */
