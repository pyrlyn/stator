# HIR — the typed intermediate representation

This document is **normative**. The Stator compiler produces and transforms one intermediate representation: a typed, structurally-scoped HIR with explicit type information on every node. Lower passes and the code generator speak HIR and nothing else; `ts.Type` never leaks past the frontend gate (`src/frontend/`).

Per plan.md §6 Task 3.1, this document is read before implementing any phase beyond the skeleton; where this document and the code disagree, this file is right and the code is a bug.

## Table of contents

1. [Shape of the IR](#1-shape-of-the-ir)
2. [The HType lattice](#2-the-htype-lattice)
3. [Unknown is first-class](#3-unknown-is-first-class)
4. [TypeScript types map to HType](#4-typescript-types-map-to-htype)
5. [The HIR verifier](#5-the-hir-verifier)
6. [The optimization passes](#6-the-optimization-passes)

---

## 1. Shape of the IR

The HIR is **structured control flow, not SSA**. Every node has an explicit `HType` and a source `Span`. Expressions and statements are separate unions—statements are not expressions.

### 1.1 Why structured, not SSA?

The compiler emits C, and C has its own `if`/`while`/`goto` control structures. An SSA form would need to be lowered back to structured control flow to emit C correctly. The cost—constructing SSA, then un-SSA'ing it—is paid twice with no optimization benefit when the target is a structured language. Keeping the IR structured from the start means C emission is **the identity transformation on control flow**: an `if-statement` HIR node becomes an `if()` in C directly.

### 1.2 Span — source location

Every node carries a `Span`:

```typescript
interface Span {
  readonly start: number;        // 0-indexed UTF-16 offset
  readonly length: number;       // span length in UTF-16 units
  readonly line: number;         // 1-indexed line for #line directives
}
```

These are UTF-16 offsets because the TypeScript API uses them; the frontend copies them directly from `ts.Node` without conversion. The `line` field is 1-indexed and is computed once during lowering—the emitter never has to recompute it from source text, so source never leaks below the frontend.

### 1.3 Expressions and statements

Expressions produce values; statements do not. An expression-statement wraps an expression and discards its value.

**Expression union** (current scope):
- `NumberLiteral` — a numeric value
- `StringLiteral` — a string value
- `BooleanLiteral` — `true` or `false`
- `NullLiteral` — `null`
- `UndefinedLiteral` — `undefined`. Not a keyword but a global binding, so the lowering resolves it through the binding table first: a local named `undefined` shadows it, exactly as at runtime
- `Identifier` — reference to a binding
- `BinaryOp` — the nineteen operators whose operands are **both** evaluated, exactly once, left to right: `+ - * / %`, `< > <= >=`, `=== !== == !=`, `& | ^ << >> >>>`
- `UnaryOp` — prefix `-`, `+`, `!`, `~`
- `TypeOf` — `typeof x`. Not a `UnaryOp`: it runs no conversion (it is total on every value, where the other four run ToNumber or ToBoolean) and its type is `string`, where `UnaryOp`'s is fixed to `number` or `boolean` by the verifier's own rule (`STA4055`)
- `DeleteProp` — `delete o.a` and `delete o[e]`, as one node: the `key` is always an `Expression`, so the property-access form lowers to a synthesized `StringLiteral` rather than a second node kind. Not a `UnaryOp` for the same reason `TypeOf` is not — its operand is a REFERENCE, not a value, and its type is fixed to `boolean` by the verifier's own rule (`STA4097`), never the removed value's. The receiver is never a fixed-shape `HObject`: the gate refuses that first (`STA1108`/`STA1205`), and in ts mode it is unreachable anyway, because TS2790 requires an optional property and an optional property is what makes a shape dynamic
- `BoundaryCheck` — the one node where an `Unknown` becomes concrete, carrying the checked type and a `file:line:col`. Its presence in the HIR IS the statement that a boundary was crossed; see §3.2.1 for where the lowering builds one (`STA4056`)
- `LogicalOp` — `&&`, `||`, `??`
- `TemplateLiteral` — `` `a${x}b` ``, as `quasis` and `expressions` with the invariant `quasis.length === expressions.length + 1`
- `StringLength` — `.length` on a string, in **UTF-16 code units** (an astral character counts twice)
- `FunctionLength` — `.length` on a statically-typed function value: the closure's declared arity, which never counts a method's receiver (docs/VALUE.md §4.16). An `Unknown`-typed receiver never reaches this node; it takes the dynamic property path instead (plan.md §8 step 21b)
- `ConsoleLogCall` — builtin console call. `method` names one of the eleven members of `CONSOLE_METHODS` (`src/hir/nodes.ts`), the single table the gate, the lowering, the verifier and the emitter all read: it gives each member its arity, how many trailing arguments are optional, and the C entry point the emitter calls. `args` is therefore either exactly `arity` long or, for the two members whose omitted tail is its own C entry point (`group`, `assert`), that minus its optional tail: the lowering pads an omitted optional with an `undefined` literal only where explicit `undefined` means what absence means. `consoleEntryPoint(method, width)` maps a width to the C call, and `STA4019` holds every node to a width it answers
- `FunctionExpr` — a function expression or arrow function; `params`, a `body` Block, an
  optional `name` (a declaration's name, or the binding a function expression is assigned to, so
  `[Function: name]` survives to the runtime), `constructible: true` on a `function` declaration
  or expression that is neither async nor a generator (the closures `new` may build through,
  docs/VALUE.md §4.20; absent on an arrow, a method, an accessor and a constructor), and a `provenance` grade (plan.md §8 step 1). The
  grade is about the SIGNATURE and answers where its types came from: `typed` if the author
  annotated it whole — `x: number` and `@param {number} x` are the same claim in two spellings —
  `inferred` if the checker finished it, and `dynamic` if an `Unknown` is anywhere in it, which
  outranks the other two because an un-annotated `js` parameter is a request for a dynamic value
  rather than an omission. A fully annotated function whose BODY holds an `Unknown` is still
  `typed`: callers see the signature, and the signature is what a boundary checks. `stator explain`
  prints it per function; it is not a trust ordering (see plan-notes 140)
- `CallExpr` — a call to an arbitrary callee expression

`TemplateLiteral` is a node rather than sugar for `+`, and this is the same kind of decision as
`LogicalOp` below. The two agree on every primitive and diverge at objects: `` `${o}` `` is defined
as ToString, while `"" + o` runs ToPrimitive with hint *default* and therefore consults `valueOf`
**first**. Desugaring while only primitives exist would bake that difference in as a bug that first
appears when objects land, in code nobody is looking at any more.

`StringLength` is a dedicated node for the same reason `ConsoleLogCall` is: the subset admits
exactly one property, and giving it a node keeps the gate's accept set equal to this vocabulary.
The gate tests the *type* of the receiver, not the syntax — `arr.length` and a statically-typed
`fn.length` are spelled identically and lower to different nodes (`ArrayLength`,
`FunctionLength`), while an untyped `fn.length` takes the dynamic property path. General
property access arrives with the object model.

`LogicalOp` is deliberately **not** a `BinaryOp`, and the separation is load-bearing rather than
cosmetic. The two differ in both ways a compiler cares about: the right operand is evaluated
*conditionally*, and the result is one of the operands rather than a fresh value. `a && b` is not
`and(a, b)`; it is `let t = a; t ? b : t`. Folding it into `BinaryOp` would license any pass that
assumes "both children are evaluated" to hoist work out of a branch that may never run.

For the same reason the emitter gives each `LogicalOp` its own **frame slot** for the left
operand: the value is tested and then possibly returned, so evaluating it twice would duplicate
its side effects, and a value the GC cannot see is a value it can collect. Nested short-circuits
therefore need distinct slots — in `(a && b) && c` the outer operand stays live while the inner
one is evaluated.

- `OptionalChain` — `base?.rest` (plan.md §8 step 24). `base` is evaluated exactly once, into
  its own rooted frame slot like a `LogicalOp` left operand; when it is nullish the node answers
  `undefined` and `consequent` never runs — not the accesses in it, and not the computed keys
  or call arguments either. Otherwise `consequent` runs, reading the guarded value through
  `OptionalBase` leaves. The consequent is built by the plain lowering arms, so every link above
  the cut keeps the lowering (and the TypeErrors) it would have without the guard; a nested `?.`
  is a nested node testing its own base. A base whose type cannot be nullish never builds this
  node — the lowering emits the plain access instead. Two links the dynamic path cannot run stay
  at the gate (`STA1214`): a method call on a class instance or a builtin receiver, which needs
  the dynamic method dispatch of step 20, and an index into a string, number or boolean, which
  has no HIR node yet.
- `OptionalBase` — the guarded value of the enclosing `OptionalChain`: a leaf resolving to the
  chain's frame temp. It names no binding and captures nothing; outside a chain it has no
  meaning, and the emitter refuses one.

**Statement union** (current scope):
- `Declaration` — `let` or `const` binding with required initializer. `var` is desugared by the lowering into a hoisted `let` initialized `undefined` plus an assignment at the original site (plan.md §8 step 3); it is not a third `declKind`.
- `Assignment` — assignment to an existing binding
- `ExpressionStatement` — wraps an expression
- `IfStatement` — `if` (optionally with `else`)
- `WhileStatement` — `while` loop
- `DoWhileStatement` — `do`/`while`; the body runs before the first test
- `ForStatement` — C-style `for`; all three header slots optional, `init`/`update` are Statements
- `SwitchStatement` — a discriminant and clauses in **source order**, `default` included
- `BreakStatement` / `ContinueStatement` — optionally labelled
- `FunctionDeclaration` — a named function; the binding is established at the **top of its unit**,
  not where the statement appears, so `f(); function f() {}` works
- `ReturnStatement` — `return`, with an optional value
- `Block` — sequence of statements

Phase 5 step 2a(c) added `ReferenceErrorRead`: an expression typed `Unknown` carrying an
undeclared name, not a binding. It throws through the existing pending-cell protocol. An inferred
JS expando namespace (such as the checker symbol from `missing.a = 1`) supplies no runtime binding
or fixed layout either; its reads and receiver types therefore use this same dynamic path. Real
declarations merged into an expando symbol are not unresolvable. The `typeof` operator alone
short-circuits a bare unresolvable identifier to the string `"undefined"` before lowering its read.

Rung 5 added `ArrayLiteral`, `ArrayLength`, `IndexAccess` (a read), `IndexAssignment` (a write) and `ForOfStatement`.

Rung 6a added classes: `ClassDeclaration` (a statement, in source order — a class is in its temporal dead zone until its declaration is reached), `NewExpr`, `FieldAccess` (a read), `FieldAssignment` (a write) and `MethodCall`. Three decisions in that set are load-bearing:

- **There is no `this` node.** A constructor or method's `params` begins with a receiver under a name no source can spell, and `this` lowers to an ordinary `Identifier` reading it. That reduction is why methods needed no machinery of their own: they inherit the closure ABI, arity padding, capture analysis and the static-closure path unchanged, and an arrow inside a method that closes over `this` is just an arrow capturing a parameter.
- **`FieldAccess` and `FieldAssignment` store a `slot`, resolved once during lowering.** The point is not speed — the emitter could recompute it — but *checkability*: a recomputed index is correct by construction and therefore unfalsifiable, while a stored one is verified against the layout it claims to index (`STA4046`).
- **A method has no slot and is not in `HObject.fields`.** One function is shared by every instance, so `MethodCall` names the class and the emitter makes a direct call, rather than every object carrying one closure per method.

Rung 6b added `InstanceOf`. It carries a class **name** and an ordinary target expression, for the same reason `NewExpr` does: the emitter reaches one file-scope descriptor, and `x instanceof (cond ? A : B)` has none to reach. The target is deliberately unconstrained — `1 instanceof C` is `false`, not an error — so the node's only invariant is that its type is `boolean` (`STA4050`). Inheritance did not change this node: the parent-link walk went inside the runtime helper, which is what "the emitter names the class, never the offset" buys.

Rung 6b then added inheritance: `HObject` grew a `bases` list (nearest ancestor first), `ClassDeclaration` grew an optional `base` name, and `SuperCall` joined the statements. Four decisions there are load-bearing:

- **`HObject.fields` is the WHOLE layout, base fields first.** A subclass's field list is not "its own fields, plus a pointer to its base's" — it is one flat list that starts with its base's, in the base's own slot order. Every existing node keeps working unchanged: `FieldAccess` resolves a slot against the flat list, and a base-typed read of a subclass instance resolves the same index it would on a base instance. That prefix property, and nothing else, is what makes `hTypeAssignable` sound — a `Dog` is a legal value for an `Animal` binding because the first N slots of a `Dog` *are* an `Animal`.
- **`MethodCall.className` is the DECLARING class, not the receiver's.** `d.describe()` on a `Dog` names `Animal` when `Animal` is where `describe` is written, because that is the function a direct call reaches. The verifier checks ancestry rather than equality (`STA4047`).
- **`MethodCall.dispatch` is a fact about the program, not about the call site.** A method is `virtual` exactly when some chain containing the receiver's class declares it twice — which the lowering asks of the whole file, because a call through a base-typed reference may land on any descendant. Everything else stays `direct` and costs exactly what rung 6a's call cost. `super.m()` is `direct` even where the same method is virtual everywhere else: skipping the override is what `super` means, and a virtual call there would find the override again and recur.
- **`ClassDeclaration.vtable` is empty for a class that participates in no overriding.** That is a real answer rather than a missing one: a table's entries are file-scope constants, so a class whose methods capture could not have one, which is why the gate refuses overriding for a class declared inside a function.
- **`SuperCall` is a statement, not an expression.** It names the BASE, carries the receiver explicitly, and evaluates to nothing: it is the base constructor run against the receiver this constructor was handed, not an allocation. Making it a statement is what lets the field-initializer prologue be *inserted after it* — initializers must run once the base has written its fields, since one may read them.
- **A derived class always has a constructor in the HIR, even when the source writes none.** The lowering synthesizes JavaScript's implicit `constructor(...args) { super(...args) }`, taking the parameters of the nearest ancestor that actually declares one. Without it a `new Blob(…)` would allocate the slots and run nothing.

Rung 6b then added statics, as `ClassDeclaration.statics` — a list of ordinary `Declaration`
statements, not a node kind. A static belongs to the class OBJECT rather than to any instance, so it
is not a slot: it is one binding for the whole program, under a name no source can spell (`C.count`,
where the dot does what the receiver parameter's leading space does). That reduction is the whole
design — a static read is an `Identifier`, a write is an `Assignment`, and `C.m()` is a `CallExpr` —
and it is why statics needed no verifier case and no emitter case of their own. Two details are
load-bearing: the name carries the **declaring** class, because statics are inherited and `Sub.count`
must be the same binding as `Base.count`; and the declarations ride on the class node rather than
being spliced into the enclosing statement list, so a class stays one statement in source order and
its statics initialize exactly where it sits.

`#private` members added no HIR surface at all. A `#count` is a field like any other, `#step()` is a
member function like any other, and `static #next` is a static binding like any other — the name
simply keeps its `#`. Privacy is a *checker* fact: every access from outside the class body is
already an error before the gate runs, so no node below it has anything left to enforce. The one
place the `#` still matters is printing, and it matters in the runtime rather than here: the printer
skips a descriptor field whose name starts with `#`. An instance `#private` re-declared down a
chain qualifies by declaring class (`#x` in `A` is the field `#x@A`), so each class keeps its own
slot and every use resolves to the slot of the class whose body spells it; a static `#private`
accessor is one pair per declaring class under the usual static bindings, and `#x in o` is an
`instanceof` against the class that declares the brand. The layout is what forces the remaining
deferral: an instance field re-declared under one class name twice in a chain is two slots
sharing one mangled spelling.

Accessors added no HIR surface either, for the reason `#private` did not: a getter is a method under
the name `get x` and a setter one under `set x`, where the space is unspellable exactly as the
static's dot is. `o.x` lowers to a `MethodCall` with no arguments and `o.x = v` to one with a single
argument, wrapped in an `ExpressionStatement` — the property occupies no slot, so nothing in the
layout, the printer or the verifier had to learn what an accessor is.

`ObjectLiteral` is the one node the object work did add, and it is deliberately thin: a list of
`{name, value}` entries whose `type` is the shape they build. There is no descriptor in the node and
no key in the emitted code — the entries ARE the slots, in written order, and the verifier's job is
only to check that that order matches the shape's field list. Everything else a literal needs is the
class machinery it borrows: the same allocation, the same `FieldAccess` for a read, and a descriptor
whose name is empty so the printer omits the prefix a class instance gets. Entries a `{ ...src }`
expansion produced carry `spread: true`: the expansion order is the source type's field order while
the result must enumerate in the source object's key order, so the emitter repairs the order at run
time from exactly those entries (plan.md §8 step 21a).

Task 4.1 added the dynamic residue's three nodes — `DynObjectLiteral`, `DynFieldAccess`,
`DynFieldAssignment` — for a literal whose contextual type has an optional property or an index
signature, and therefore no fixed slot list. They mirror their fixed-path twins minus the `slot`:
the property is a NAME resolved through the shape table at run time, with a per-site inline cache
(docs/VALUE.md §4.10). Two invariants carry the design:

- **Everything dynamic types `Unknown`, and the verifier enforces it (`STA4059`).** A
  `DynFieldAccess` result and its target are Unknown by definition — an absent optional property
  reads as `undefined`, so any concrete type on the node is a narrowing nothing proved. The
  consumer narrows the value back the way it narrows a `Map.get`. One typed target is admitted:
  an array's `length`, which `DynFieldAssignment` writes (and, in value position, `DynFieldAccess`
  reads) through the same runtime entries, because writing it resizes the array rather than
  touching a slot (ECMA-262 §10.4.2.4, plan-notes 310). The other is a FUNCTION target
  (`kind: 'fn'`): an ordinary function's own properties and its `prototype` live in a table on
  its closure (`f.count`, `F.prototype`, `assert.same(…)`), so `DynFieldAccess`,
  `DynFieldAssignment` and `DynMethodCall` reach them by name exactly as on an Unknown receiver
  (docs/VALUE.md §4.20). The third is a fixed OBJECT target under a name its type does not
  declare (plan.md §11c T11.4 step 7): the name lives in the object's overflow table
  (docs/VALUE.md §4.24), so the same three nodes reach it; a DECLARED name on an object target is
  still `STA4059`, because it has a slot. Such a `DynMethodCall` carries `notFunction`, the source
  subject of Node's `TypeError` when nothing callable was stored under the name, where every
  other dynamic call aborts `STA2006`. An `IndexAccess`/`IndexAssignment` on an object target
  takes a string or number index too, besides step 44b's object key: `js` mode's computed key on
  a fixed shape, read and written by name through the same degrading entry points.
- **No pending check follows a dynamic access.** `jsrt_get_prop` allocates nothing and runs no
  user code; `jsrt_set_prop` can grow slot storage — which is why its operands sit in rooted
  frame slots. A nullish receiver is a TypeError; a primitive read answers `undefined`; a
  primitive write is a TypeError; growing a *new* key on a fixed-layout object fills its
  overflow table (docs/VALUE.md §4.24). Reads and writes of an existing field on an aliased fixed object walk the class
  descriptor. An Unknown (or empty `{}`) receiver uses the same three nodes; a computed index
  on one emits `jsrt_dyn_index_get`/`set`, which dispatches arrays to the dense path and
  everything else through the property table. Calling a non-function is `STA2006` at `file:line`.

`CollectionNew` and `CollectionOp` are the two nodes rung 7 added for `Map` and `Set`. Each names a
`collection` (`'map'` or `'set'`) and, for the operation, one of a closed set of `op`s —
`get`, `set`, `has`, `delete`, `clear`, `add`, `size`, `forEach`, `keys`, `values`, `entries` — with a target and an argument
list. The
closed set is the point: an operation is not a general method call that happens to land on a builtin,
it is one HIR node the emitter turns into one runtime function with a fixed C signature. `.size` is
an `op` with no arguments rather than a `FieldAccess`, so nothing below reads the struct field. The
verifier checks the receiver's type kind and the argument count for both, because every `jsrt_value`
argument has the same C type and the C compiler cannot catch either mistake. A `WeakMap`/`WeakSet` is
a Map/Set HType (the checker keeps every walk off it), and `CollectionNew.weak` is the one bit that
records it: it picks the allocator whose `set`/`add` refuses a non-object key (docs/VALUE.md §4.22).

`GlobalCall` (plan.md §11c T11.4) is one row of `GLOBAL_CALLS` called with boxed operands padded to
the row's arity: `parseInt`, `parseFloat`, `isNaN`, `isFinite`, and since step 4b `RegExp`
(`new RegExp(p, f)` and `RegExp(p, f)`, result `regexp`) and `Array` (`Array(n)` / `new Array(n)`
with one argument, result an array of an Unknown element). A row with `throws` gets a pending check
after the call. `Array()` and `Array(a, b, …)` are not calls at all: they lower to the array literal
they equal. An `ArrayOp` with `spread` set is the `concat` an array-literal spread lowers to; its
answer has its holes filled with `undefined`, because a spread iterates (docs/VALUE.md §4.4).
Since step 5 two rows are not callee names: `Array.from` (`jsrt_array_from`) and `...`
(`jsrt_spread_operand`), which the lowering wraps around any spread operand that is not an array,
so the `concat` receives the drained iterable rather than appending it whole (docs/VALUE.md §4.23).

A `CallExpr` or `DynMethodCall` with `spread` set (step 5) has exactly ONE argument: the array the
lowering folded the whole argument list into, exactly as it folds an array literal's. The emitter
calls `jsrt_call_spread_at`, which calls with the list's own count; the verifier holds the one
array (`STA4104`), a spread `DynMethodCall` may have any receiver type (the method read is the
shape table's, `STA4059` does not apply), and the inline pass never inlines one.

The seven ES2025 set operations are `op`s too, and they are the only ones whose ARGUMENT is a
collection: the emitter passes it to a runtime function that reads it as a `JSRTMap`, so the
verifier checks the argument's type kind (`STA4053`) rather than trusting the arity count, and pins
the result — a Set for the four combining forms, a boolean for the three predicates. The `SET_OPS`
table in `src/hir/nodes.ts` is the one place that membership and those answers are written down;
the gate, the verifier and the emitter all read it.

`forEach` is the one collection op that runs USER CODE: the runtime calls the callback through
`jsrt_call`, exactly as the `Array.prototype` callback ops do, so the emitter gives it the same
treatment those get — the call is emitted as its own STATEMENT and a pending check follows it, so a
`throw` from the callback reaches its landing pad instead of being read as a result. The iterator
forms (`keys`, `values`, `entries`) land as a result kind `iterator` (Phase 5 step 8): a for-of
operand peels to an inlined walk, and a stored result is a boxed `JSRTIterator` whose `next()` is
the `IteratorNext` node. `function*` is the same `iterator` type wrapping a `JSRTGenerator`:
`YieldExpr` is the suspension, and `IteratorNext.sent` is what a later `next(v)` injects.
`for-of` over an operand no static walk covers wraps it in `GetIterator` (plan.md §8 step
2a(c)): one target, always typed `iterator` with an Unknown element, emitting a single
`jsrt_get_iterator` call ahead of the existing boxed walk. The verifier pins that contract
(`STA4045`) because the for-of case copies the node's type onto the loop binding with no
further check -- a concrete element would be a silent narrowing of values the runtime never
promised.

Task 4.2 added `MathCall` on the CollectionOp precedent: a closed method set, exact arity, one
runtime function per operation, no function value anywhere. Post-lowering arity is FIXED at one or
two — the lowering folds variadic `min`/`max` into nested binary nodes and the zero-argument forms
into their identity literals — and the verifier pins arity plus the number-in/number-out contract
(`STA4080`), because every `jsrt_value` argument looks alike to the C compiler. `Math.PI` and the
other constants need no node: they fold to number literals during lowering, bit-for-bit the doubles
the pinned Node holds.

The String slice added `StringOp` the same way, with one structural difference: the closed set lives in a TABLE (`STRING_OPS` in `nodes.ts`, op → {arity, result}) rather than in per-op code, and the gate, the lowering, the verifier, and the emitter all read it — the emitter derives each C name mechanically (`camelCase` → `jsrt_string_snake_case`), so adding an op is one table row plus one C function. The lowering pads omitted optional arguments with `undefined` literals, which is sound because ECMA-262 treats explicit `undefined` as absent for every op in the set; the verifier (`STA4081`) then pins the string receiver, the exact post-padding arity, and the table's result type, while leaving argument types unchecked — the runtime coerces per spec, and `indexOf(1)` is legal JavaScript the gate already admitted.

The Array slice added `ArrayOp` on the identical pattern (`ARRAY_OPS`, verifier `STA4082`, C names `jsrt_array_*`), with two result kinds `STRING_OPS` never needed: `self` — the RECEIVER's own array type, for the ops that slice, copy, or mutate-and-return it — and `element`, which is Unknown by the IndexAccess rule, because `pop` on an empty array really answers `undefined` and a narrower type would be the compiler asserting what the runtime cannot honour. The callback methods (`forEach map filter some every find findIndex`) joined the same table: their single argument is a closure the runtime calls through `jsrt_call` — the compiled world's own ABI — and two result kinds came with them: `mapped` (the CHECKER's answer, for `map`'s free element choice and `filter`'s type-guard narrowing; pinned only to "some array") and `undefined` (`forEach`). `reduce`/`reduceRight` (with-initial form) brought a third: `checker` — the checker's answer with nothing pinned, because the accumulator's type is whatever the callback and the initial value agreed on.

The Object slice added `ObjectStaticCall` — `Object.keys/values/entries`, a NAMESPACE call like `MathCall` rather than a method on a receiver, one argument in one rooted slot. `keys` is pinned to `string[]` (`STA4083`); `values`/`entries` are pinned only to "some array", because their element follows the checker's answer and `entries` produces `[string, T]` pairs the HType model has no tuple for — that element is honestly Unknown, and an `entries` call is what makes an otherwise fully-typed file report `dynamic`. The node carries an argument LIST rather than a single argument, because the namespace is not uniformly unary: `hasOwn` takes an object and a key. Arity is fixed per method by the gate's `OBJECT_STATICS` table and restated in the verifier's `OBJECT_STATIC_SHAPES`, whose result kinds pin what each method can be pinned to — `string[]` for `keys`/`getOwnPropertyNames`, a boolean for `hasOwn`, “some array” for `values`/`entries`, and nothing at all for `fromEntries`, which builds a dynamic shape and is therefore Unknown outright.

The JSON slice added `JsonStringify` — `JSON.stringify(v)` in its single-argument form, the same one-argument-one-slot namespace shape as `ObjectStaticCall`, pinned to `string` (`STA4085`). The pin is why the gate refuses argument types that admit `undefined` or a function at the TOP level: there the spec answers `undefined`, not a string. Inside a structure both serialize per spec (skipped as object values, `null` as array elements), and a cycle aborts loudly at run time on the STA2005 pattern.

`JsonParse` is its mirror and the same single-slot shape, but the opposite of pinned: nothing about its result is checked. The lowering types it `Unknown` — the argument is text, and a type annotation on data nobody has read yet is a claim, not a fact — so `explain` reports the call as the point where the program becomes dynamic, and the boundary machinery from Task 3.5 (`typeof` narrowing, an `as` cast) is what settles each use. The verifier leaves the type alone rather than pinning it, so a later pass that proves something concrete about a parsed value is free to say so.

Task 4.3 added `RegExpLiteral` and `RegExpOp`. The literal carries the pattern and the flags as two
STRINGS, split at the last `/` of the token, and neither is parsed anywhere above the C boundary —
the vendored engine (quickjs-ng's libregexp) is the only thing that reads them, which is what keeps
this compiler from disagreeing with it about what a pattern means. It is a literal but NOT a
constant: §22.2.4.1 makes every evaluation a fresh object, and it has to be, because `lastIndex` is
mutable state ON that object, so the emitter compiles the pattern at each evaluation rather than
hoisting it. The verifier's only claim about the node is its own kind (`STA4086`).

`RegExpOp` is `StringOp`'s shape over the `REGEXP_OPS` table, with one difference in what the
verifier pins: the receiver kind is load-bearing in a way a string op's is not, because
`jsrt_regexp_test` dereferences it as a `JSRTRegExp` without asking — a wrong kind there is memory
corruption, not a wrong answer. The argument is deliberately unchecked for `STA4081`'s reason: an
untyped subject is the js-mode norm, and the bridge's own tag check is the honest place to settle
it. `test` is the whole table for now; `exec` is absent because it answers an ARRAY WITH PROPERTIES
(`index`, `input`, `groups` hang off the match array) and a jsrt array is dense with no property
table, so landing it would mean either a wrong answer or a representation change.

Task 4.2's Date slice added three nodes on the same table discipline, and one of them is
interesting for what it does NOT need. `DateOp` is `StringOp`'s shape over `DATE_OPS`, with the
receiver kind pinned the way `RegExpOp`'s is (`STA4092`) — the `jsrt_date_*` accessors read a
`JSRTDate` without a tag test. The table writes each C name out explicitly rather than deriving
it, because the mechanical `camelCase → snake_case` rule the string and array ops use turns
`getUTCFullYear` into `get_u_t_c_full_year`; that is the whole reason `DATE_OPS` carries an `fn`
field where `STRING_OPS` carries none. `DateStaticCall` is `ObjectStaticCall`'s namespace shape
over `DATE_STATICS`, pinned to `number` because both `Date.UTC` and `Date.parse` answer a time
value.

`DateNew` is the interesting one. It is neither a `NewExpr` (there is no descriptor and no
constructor body) nor a `CollectionNew` (that one never takes an argument), and it carries exactly
one argument for three source forms — a time value, an ISO string, another Date — because the
discrimination is a tag test the runtime has to make anyway, so hoisting it into three node kinds
would buy the compiler nothing it could then check. The ZERO-argument form gets no node at all:
§21.4.2.1 step 2 defines `new Date()` as the current time value, so the lowering desugars it to
`new Date(Date.now())` — a `date-static` sitting in the `arg` slot. That is not padding, and the
distinction matters: `new Date(undefined)` is an Invalid Date, so an absent argument and an
explicit `undefined` are different programs, which is why the desugaring is to an explicit `now`
call rather than to the undefined-literal every other optional position gets.

Task 3.10 added exceptions, as two statements:

- **`ThrowStatement`** carries the thrown expression. Its type is `undefined`, but nothing consumes
  it: a throw completes abruptly. The emitter turns it into `jsrt_throw(v); goto <pad>;` where the
  pad is the innermost enclosing try's landing pad, or the unit's own unwind pad (docs/VALUE.md
  §4.9).
- **`TryStatement`** has a `tryBlock` plus at least one of `catchBlock` and `finallyBlock` — a try
  with neither is unbuildable from source and the verifier rejects it (`STA4057`), as it does a
  `catchBinding` without a `catchBlock`. The binding, when present, is typed **`Unknown`
  always**: anything can be thrown, so the catch variable is a narrowing point like any other
  boundary (§3.2.1), which is why `explain` does not count the binding itself as dynamic — only
  reads of it in the blocks.

Two decisions there are load-bearing:

- **The blocks are `Block` nodes, not statement lists**, because a catch binding is scoped to its
  block and DCE's scope-preservation argument (§6.3) applies to them unchanged.
- **There is no landing-pad node.** Which pad a throw reaches, the order finally bodies run in,
  and how a `return`/`break`/`continue` routes THROUGH a finally are all decided by the emitter,
  which lowers a try-with-finally to an `int` completion code (0 normal, 1 rethrow, 2+ one per
  distinct jump) dispatched after the finally body. Encoding that routing in the HIR would force
  every pass to preserve a control structure none of them can improve.

A loop or switch carries its own optional `label`; a labelled block stores `Block.label`. There is no LabeledStatement wrapper. A label exists only to be named by `break`/`continue`, so it belongs to the thing being jumped out of. `continue` cannot target a block.

`for-in` desugars in lowering to `Object.keys` plus a counting `for`. Value-position `++`/`--`/`+=`/`=` is `UpdateExpr`; `c ? t : f` is `ConditionalExpr`. Loops that capture a binding they declare set `perIterationEnv`, and the emitter clones the heap environment each iteration.

Three shapes here exist to stop the emitter from being clever:

- **`ForStatement.condition` is optional, not defaulted to `true`.** `for (;;)` has no test, and a synthesised literal would make "no test" and "a test that happens to be true" indistinguishable.
- **`SwitchClause.statements` is not a `Block`.** A clause opens no scope and falls through into the next one; a Block would imply both are false.
- **Clauses keep source order, `default` in place.** `default` is *tried* last but still falls through from whatever clause precedes it textually, so hoisting it changes which statements run.

`switch` does not lower to a C `switch`, and cannot: C requires integer constant cases, while JavaScript compares with **strict equality** against arbitrary expressions. It becomes a chain of tests plus `goto`s into clause labels laid out in source order — which delivers fall-through by simply not jumping.

Jumps are always `goto`, never C's `break`/`continue`, so that a `break` inside a `switch` inside a loop cannot be silently captured by the wrong construct. The emitter writes a label only where a `goto` targets it: the runtime builds with `-Wall -Wextra -Werror`, and an unused label is an error there.

**The invariant that governs every addition:** the gate's accept set (`src/frontend/gate.ts`) must equal this vocabulary *exactly*. A construct accepted above but unrepresentable below is not a missing feature — it is an `STA4xxx` internal error waiting to happen, the compiler blaming itself for source it chose to accept. Widening the HIR and widening the gate are the same change; make them in the same commit. This has been violated twice already (plan-notes 30 and 37), both times by constructs that reached the gate through a fast path rather than an explicit `case`.

### 1.4 Module root

A `Module` is the top-level container:

```typescript
interface Module {
  readonly kind: 'module';
  readonly fileName: string;      // absolute path, for #line directives
  readonly statements: readonly Statement[];
  readonly type: HType;           // usually undefined or the type of the last statement
}
```

---

## 2. The HType lattice

Stator's internal type model is small and structural. It is produced by exactly one module (`src/frontend/types.ts`) and is the only type vocabulary every pass and the emitter see.

### 2.1 Phase 2 types — the skeleton

The walking skeleton recognizes six kinds:

| Kind | Meaning | Example |
|---|---|---|
| `number` | 64-bit IEEE double (all numbers, all numeric literals) | `1`, `1.5`, `Infinity` |
| `string` | UTF-16 string | `"hello"`, `` `template` `` |
| `boolean` | logical truth value | `true`, `false` |
| `undefined` | absence of a value | `undefined`, return-less function |
| `null` | the null singleton | `null` |
| `unknown` | unknown type, unknowable statically | `any`, `unknown`, untyped variable in js mode |

Each is a singleton (except `unknown`, which carries a flag—see §3).

### 2.2 Phase 3+ types — planned

`fn(params, ret)` landed with rung 4, `array<T>` with rung 5, and `object` — a class instance: a name, fields in slot order, and method signatures — with rung 6a. `object` is compared **nominally**, unlike every other kind: two classes that declare the same fields are still two classes, which matches what the emitter allocated (one descriptor per declaration) and is also the only comparison that terminates, since `class C { self: C }` is a cyclic type. Rung 7 added `map<K, V>` and `set<T>`. Phase 5 step 8 added `iterator<T>` — a boxed specialized cursor (`arr.keys()` stored), distinct from the inlined for-of walk that allocates nothing.

Task 3.4 added one more, `type-param`, which is the single HType kind that must NEVER reach the HIR: it lives only inside `src/frontend/`, as the thing unification binds and substitution replaces. Monomorphization happens at the lowering, so a node carrying a `type-param` means a specialization was built outside its own substitution — the verifier refuses it as `STA4054`.

The following kinds **do not yet exist** in the code and are mentioned here only to state the plan explicitly. Do not implement them early and do not describe them as if they work:

- **`i32`** — refinement of `number` to 32-bit integers (Phase 3 optimization; all arithmetic promotes overflows back to `number`)
- **`union<T1 | T2 | ...>`** — union of concrete types (replaces implicit unions via widening)
- **`generic-instance<G, [A1, A2, ...]>`** — a generic type applied to concrete arguments. Not needed by Task 3.4 and possibly never: monomorphization erases the generic rather than representing it, so `box<number>` is a FunctionDeclaration named `box<number>` whose type is the ordinary `(number) => number`. A `generic-instance` kind becomes necessary only if a generic ever has to survive to runtime — a generic class stored in an `Unknown`, say

---

## 3. Unknown is first-class

`Unknown` is not an error state. It represents a type unknowable at compile time. In `ts` mode, `Unknown` from an implicit `any` is rejected at the gate; in `js` mode, `Unknown` is the dynamic path.

```typescript
interface HUnknown {
  readonly kind: 'unknown';
  readonly fromImplicitAny: boolean;  // gate-set flag
}
```

### 3.1 Where Unknown comes from

- Source `any` annotation (in `js` mode; in `ts` mode the gate rejects it first with `STA1001`)
- `unknown` type annotation
- Untyped code in `js` mode (inferred as `unknown`, not rejected)
- Union types whose constituents map to more than one HType. `string | number` is `Unknown`; `"a" | "b"` is NOT, because every constituent gives the same answer and widening to `string` invents nothing (Task 3.5). That widening is what makes `typeof` usable: TypeScript types it as a union of eight string literals
- `JSON.parse()` return value (always `unknown`)
- FFI boundary (`declare function` imports)
- `.js`→`.ts` imports (the imported value is runtime-typed, not statically typed)

### 3.2 The Unknown preservation rule

**This is the single most important rule in this document.** Every pass—const-fold, DCE, tree-shake, inline, any future optimization—must preserve `Unknown` exactly as it appears in the input. You may never:

- Elide a check on an `Unknown` value by proving it redundant
- Replace `Unknown` with a more specific type without a runtime check
- Propagate a type assumption across an `Unknown` boundary
- Constant-fold an operation whose operand is `Unknown`

**Why?** `Unknown` exists because the type is unknowable *at compile time*. If an optimizer "proves" it is redundant, it has proved something false: the source program has no type information to prove it. A boundary check is not optional; it is a **property of the type system itself** — the only way the compiled code can be correct when the type system has admitted we don't know the type.

**Invariant (enforced by the verifier):** Every value of type `Unknown` in the HIR must remain `Unknown` through lowering, optimization, and codegen. Codegen emits it as a tagged `jsrt_value` with a runtime check at every narrowing site.

### 3.2.1 What a narrowing site is (Task 3.5)

An `Unknown` becomes concrete in exactly one node, `BoundaryCheck`, and the lowering is the only thing that builds one — a later pass could not, because by then the HIR has already forgotten which type the checker narrowed to. Four spellings produce it: a read of an `Unknown` binding at a point where the checker has narrowed it (a `typeof` guard, an `instanceof`, an `!== undefined`); an `as` cast off an `Unknown`; a dynamic value flowing into an annotated binding, parameter, or return (plan.md §8 step 5 — the mixed-graph edge); and the same edge written in JSDoc (`/** @type {number} */ const n = produce()`). A fifth exists only in js mode: a value of ANOTHER concrete type reaching a `.ts` variable annotated with a checkable type, at a declaration or assignment the checker refused with `TS2322`. js mode suppresses that refusal but keeps the annotation, so the check's operand is concrete and the check is what fails it (plan-notes 301). The verifier still refuses a check whose operand already has the checked type (`STA4056`), because that check can never fail. The emitted C is `jsrt_check_number/string/boolean(v, "file:line:col")`, which returns `v` or raises `STA2001`.

Three rules follow from the preservation rule above rather than from convenience:

- **Per use, not per binding.** Three reads inside one guard emit three checks. Hoisting to one would assert that the value did not change between them, which is a type assumption propagated across an `Unknown` boundary — the third bullet in the list above.
- **A narrowing to a type no TAG settles is dropped, not refused.** An object's shape, an array's element type and a function's signature cannot be checked in constant time, so those narrowings leave the value `Unknown` and it stays on the dynamic path. That IS the preservation rule; refusing instead would reject programs that already compile, in exchange for no soundness (see plan-notes 74).
- **An unnarrowed `Unknown` gets no check.** `console.log(x)` asks nothing of `x`. A check is inserted where a claim is made, not where a value is used.

### 3.2.2 How each pass satisfies the rule (Tasks 3.6–3.9)

The rule above is stated as a prohibition, which invites a pass to satisfy it with a check that a
reviewer has to trust. None of the three passes does that. Each satisfies it through the condition
that admits a rewrite at all, so violating it is not something the code could be edited into doing
without changing what the pass is:

- **Const-fold** folds only when every operand is a **literal node**. A literal is never `Unknown`,
  so the fourth bullet above is unreachable — and a literal has no side effect, so folding never
  deletes one either. One restriction, two properties.
- **DCE** reasons only about **control flow**: what follows a jump, which branch a literal condition
  takes, what can reach a function. It never asks what a value is, so it has no way to elide a check.
- **Inlining** requires the argument's HType to **equal** the parameter's. A `js`-mode call passing a
  `number` to an `Unknown` parameter therefore does not inline: substituting would replace an
  unknown-typed subtree with a typed one and cancel the check that unknown-ness requires.

### 3.3 Example

```typescript
// ts mode
const x: unknown = JSON.parse('1');  // type is unknown
const y = (x as number) + 1;         // jsrt_check_number: STA2001 at runtime if x is not a number

// js mode
const x = JSON.parse('1');           // type is unknown (inferred)
const y = x + 1;                     // dynamic path: operator overload on jsrt_value
```

In both cases, `Unknown` is preserved; the difference is the route (explicit boundary check vs. dynamic operator).

---

## 4. TypeScript types map to HType

`src/frontend/types.ts` is the **only** module that maps `ts.Type` → `HType`. It is called once per expression/statement in the frontend, immediately after the type checker assigns a type. Nothing below the gate sees `ts.Type`.

### 4.1 The mapping algorithm

```typescript
export function tsTypeToHType(type: ts.Type): HType {
  const f = type.flags;

  // Primitives must match their LITERAL flag too.
  if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
    return H_NUMBER;
  }
  if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) {
    return H_STRING;
  }
  if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) {
    return H_BOOLEAN;
  }
  // void is distinct in TypeScript but undefined at runtime.
  if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return H_UNDEFINED;
  }
  if (f & ts.TypeFlags.Null) {
    return H_NULL;
  }

  // Both explicit and implicit `any` are Unknown.
  if (f & ts.TypeFlags.Any) {
    return hUnknown(true);  // conservative: set flag for gate to reject if implicit
  }

  // Everything Phase 2 cannot represent: union, array, function, etc.
  return hUnknown(false);
}
```

**Key invariant:** If the type checker produced a type, and this function returns `Unknown`, it is because Phase 2 has no representation for it. This is never a guess; `Unknown` here means the type is *representable but not yet implemented*.

### 4.2 Worked examples

Each example shows a TypeScript snippet, what `ts.Type` the checker produces, the resulting `HType`, and the reason.

#### Example 1: Number literal

**TypeScript:**
```typescript
const x = 1;
```

**`ts.Type`:** `Type { isNumberLiteral: true, value: 1 }` — the literal type `1`, not the general `number` type.

**`HType`:** `{ kind: 'number' }`

**Why:** `tsTypeToHType` checks `TypeFlags.Number | TypeFlags.NumberLiteral` and both match. **Critical detail from plan-notes #32:** TypeScript's `NumberLiteral` flag includes the general `Number` flag; we must check both and map them all to the single `number` HType. An early version mapped only the `NumberLiteral` flag and broke on bare `number` annotations. The `| TypeFlags.Number` part is the fix.

#### Example 2: String literal

**TypeScript:**
```typescript
const s = "hello";
```

**`ts.Type`:** `Type { isStringLiteral: true, value: "hello" }`

**`HType`:** `{ kind: 'string' }`

**Why:** Same as above; both `StringLiteral` and `String` flags are checked.

#### Example 3: Boolean literal type

**TypeScript:**
```typescript
const b: true = true;
```

**`ts.Type`:** `Type { isBooleanLiteral: true, value: true }` — the literal type `true`.

**`HType`:** `{ kind: 'boolean' }`

**Why:** `BooleanLiteral` and `Boolean` flags both match. The HIR has one `boolean` type; `true` and `false` are runtime values, not compile-time constants at the type level.

#### Example 4: Generic boolean type

**TypeScript:**
```typescript
let b: boolean;
b = true;
```

**`ts.Type`:** `Type { flags: TypeFlags.Boolean }` — the general `boolean` type, not a literal.

**`HType`:** `{ kind: 'boolean' }`

**Why:** The check `TypeFlags.Boolean` alone matches, same `HType`. All three — the literal type `true`, the literal type `false`, and the general `boolean` type — map to one `boolean` HType because the HIR tracks type, not specific values.

#### Example 5: The `void` keyword

**TypeScript:**
```typescript
function f(): void { }
```

**`ts.Type`:** `Type { flags: TypeFlags.Void }` — TypeScript's way of saying "no return value."

**`HType`:** `{ kind: 'undefined' }`

**Why:** `void` is a TypeScript compile-time concept meaning "you can ignore the return." At runtime, a function that doesn't return anything returns `undefined`. The HIR models *values*, not compile-time intent, so `void` and `undefined` are the same.

#### Example 6: Explicit `any` in js mode

**TypeScript (js mode):**
```typescript
const x: any = 1;
```

**`ts.Type`:** `Type { flags: TypeFlags.Any }`

**`HType`:** `{ kind: 'unknown', fromImplicitAny: true }`

**Why:** The check `TypeFlags.Any` matches. The `fromImplicitAny` flag is set `true` conservatively (see §4.1 comment). The gate later checks `isImplicitAny()` on the actual TS AST node; if it finds the annotation was explicit, the gate still keeps the flag set because:
1. `tsTypeToHType` does not have access to the AST, only the type.
2. The gate's job is to filter; the conservative flag makes the gate safe: if unsure, reject in `ts` mode.
3. In `js` mode, the flag is ignored; `Unknown` compiles as dynamic either way.

#### Example 7: Implicit `any` in ts mode

**TypeScript (ts mode):**
```typescript
let x;  // no initializer, no annotation
```

**`ts.Type`:** `Type { flags: TypeFlags.Any }` — inferred as `any` because nothing narrows it.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: true }`

**Why:** Identical to example 6 at the type level. The gate calls `isImplicitAny(node, typeChecker)` on the actual `VariableDeclaration` node; if it returns `true`, the gate emits `STA1003` and the declaration is rejected in `ts` mode.

#### Example 8: Unknown type annotation (ts mode)

**TypeScript (ts mode):**
```typescript
const x: unknown = 1;
```

**`ts.Type`:** `Type { flags: TypeFlags.Unknown }` — the `unknown` keyword.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: false }`

**Why:** TypeScript has two type flags for "don't know": `Any` (implicit or explicit `any`) and `Unknown` (the `unknown` keyword). We map both to `unknown` HType, but the `fromImplicitAny` flag is `true` only if `TypeFlags.Any` was set. Since `unknown` is an explicit annotation, the flag is `false`, and the gate does not reject it in `ts` mode—`unknown` is the approved way to say "I don't know the type."

#### Example 9: Union type

**TypeScript:**
```typescript
const x: number | string = 1;
```

**`ts.Type`:** `Type { flags: TypeFlags.Union, types: [Type{Number}, Type{String}] }` — a union of two types.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: false }`

**Why:** Phase 2 has no `union` HType. The union exists in the type system but not in the HIR. When the lowering sees this, it must insert a runtime check (boundary-check insertion, Phase 3 Task 3.5) to narrow the union before using the value. Until then, it is `Unknown`, which triggers:
- In `ts` mode: the gate rejects it as unsupported (STA1214, "not yet").
- In `js` mode: it is the dynamic path.

#### Example 10: Function type

**TypeScript:**
```typescript
const f: (x: number) => string = ...;
```

**`ts.Type`:** `Type { flags: TypeFlags.Object, objectFlags: ObjectFlags.ClassOrInterface, ... }` — internally represents function types as interface-like objects.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: false }`

**Why:** Phase 2 has no `fn` HType. Functions arrive in Phase 3. The gate rejects this as not-yet (STA1214).

#### Example 11: Array type

**TypeScript:**
```typescript
const arr: number[] = [1, 2];
```

**`ts.Type`:** `Type { flags: TypeFlags.Object, ... }` — arrays are objects with special properties.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: false }`

**Why:** implemented in Phase 3 Task 3.3 rung 5. `checker.isArrayType` maps `T[]` and `Array<T>` to `HArray`; a TUPLE is deliberately excluded, since it has a different type per position and `HArray` holds one element type for all of them.

#### Example 12: Enum (ts mode)

**TypeScript (ts mode):**
```typescript
enum Color { Red = 0, Green = 1 }
const c: Color = Color.Red;
```

**`ts.Type`:** `Type { flags: TypeFlags.Number | TypeFlags.Enum, ... }` — enums are number-like.

**`HType`:** `{ kind: 'unknown', fromImplicitAny: false }`

**Why:** Enums are **deliberately excluded**, even though `TypeFlags.NumberLike` includes them. The gate (via `gateConstruct`) rejects enum declarations outright with `STA1104` (a never code: `erasableSyntaxOnly` bans them, and the enum AST node never reaches lowering). If lowering did see one, mapping it to `number` would hide the gate's rejection. The `tsTypeToHType` function and lowering are not the gate's agents; they assume the gate has already filtered the input. **Envelope principle:** the gate's accept set must equal the HIR's vocabulary exactly.

---

## 5. The HIR verifier

The verifier is a post-transform invariant checker. It runs after every pass that modifies the HIR (lowering, const-folding, DCE, inline) to ensure the pass produced valid HIR.

### 5.1 What the verifier checks

Each check is a compiler invariant. If it fails, the compiler has contradicted itself—the gate accepted a construct and the pass produced invalid HIR for it.

**Type presence:** Every node has an `HType`. Missing `type` → `STA4020`.

**Binding scope:** Every `Identifier` reference refers to a binding declared before use. Using a name never declared → `STA4002`. Assigning to a name never declared → `STA4003`. A `let`/`const` binding is in scope during its own initializer, because a closure there captures the binding rather than its value (`const g = (n) => … g(n - 1)`), but only from inside a function body: a read on the initializer's own evaluation path would run before the binding exists, and stays `STA4002`/`STA4003` (plan.md §9 Task 6.28). That read never reaches the HIR from source: a direct one is TS2448, and the gate refuses a function the initializer may call before it finishes (`STA1214`, docs/SUBSET.md).

**Type agreement:** The type of each expression matches the operation that produced it:
- `NumberLiteral` must have type `number` → `STA4007`
- `StringLiteral` must have type `string` → `STA4008`
- `BooleanLiteral` must have type `boolean` → `STA4009`
- `Identifier` must have the type of the binding it refers to → `STA4010`
- Arithmetic operators (`+`, `-`, `*`, `/`, `%`) must have both operands of type `number` and result type `number` → `STA4011`, `STA4012`, `STA4013`
- Comparison operators (`<`, `>`, `<=`, `>=`) must have operands of matching type (number or string, not mixed) and result type `boolean` → `STA4014`, `STA4015`, `STA4016`
- Strict equality (`===`, `!==`) must have operands of matching type and result type `boolean` → `STA4017`, `STA4018`
- An `ArrayOp` whose `ARRAY_OPS` entry carries `calls` is emitted as its own statement followed by
  `if (jsrt_pending()) goto pad;` — it runs compiled code and can therefore throw, and the check has
  to sit between the op and whatever consumes its result. Every other array op is a walk over the
  backing store that cannot unwind, and nests directly.
- A console call must have type `undefined`, and exactly as many arguments as `CONSOLE_METHODS` gives its method → `STA4019`

**Control flow:** `IfStatement` and `WhileStatement` conditions must have type `boolean` → `STA4005`, `STA4006`.

**Assignment compatibility:** An assignment's value type must match the target binding's type → `STA4004`.

### 5.2 Verifier output

The verifier returns a list of problems (not thrown exceptions). Each problem includes:
- `kind`: the HIR node kind (e.g., `'binary-op'`)
- `code`: the STA code (all codes in `STA4xxx`)
- `span`: the node's source location
- `message`: human-readable explanation

Example:
```
{
  kind: 'binary-op',
  code: 'STA4011',
  span: { start: 42, length: 1, line: 5 },
  message: 'arithmetic operand must be number, got string'
}
```

### 5.3 Verifier discipline

**When:** Once per build, on the OPTIMIZED module — `build.ts` lowers, optimizes, verifies, emits.

That ordering is the point rather than an implementation detail. What reaches the emitter is the
optimized module, so that is what has to be checked; verifying the lowering's output instead would
check a tree nothing emits and leave the one that does unchecked, turning a pass bug into a clang
error against generated C rather than an `STA4xxx`. In all builds, for now — §6 may add a flag to
skip it in release builds if measurements ever show it is a bottleneck.

**What counts as a verifier failure:** Always a compiler bug (`STA4xxx`), never a user error. The gate has already accepted the source and the lowering has already produced the HIR. A verifier failure means one of them violated an invariant—either the gate let through a construct it shouldn't have, or the pass produced invalid HIR. The verifier's job is to **catch bugs early**, before they cascade into wrong code.

**Envelope principle:** The invariant that holds the design together is simple:

> The set of constructs the gate accepts (`gateConstruct` in `src/frontend/gate.ts`) must equal the set of constructs the HIR can represent exactly. No more, no fewer.

If the gate accepts a construct but the HIR has no node type for it, lowering fails. If the HIR has a node type but the gate rejects it, the gate is wrong. A verifier problem always points to one of these disagreements.

---

## 6. The optimization passes

`src/passes/` holds the transformations that operate on a complete HIR. Two of the passes this plan
originally listed are **not** here — monomorphization (Task 3.4) and boundary-check insertion
(Task 3.5) both happen at the lowering, because each needs a fact that lives in the `ts.Type` world
and is gone by the time an HIR exists. A pass would have to reconstruct from the output what the
input already knew. See plan-notes.md entries 73 and 74.

### 6.1 The shared rewriter

`rewrite.ts` is a bottom-up, identity-preserving walk over every node kind, with exhaustive
switches. Exhaustive rather than reflective on purpose: a reflective walker handles a node kind
added later *silently*, which is the opposite of what is wanted for nodes with special evaluation
rules — `LogicalOp`'s right operand is conditional, and a walker that treated it as an ordinary
child would license hoisting work into a branch that may never run.

A `Rewriter` supplies up to three hooks, all called with children already rewritten:

| Hook | Signature | Why it exists |
|---|---|---|
| `expression` | `Expression => Expression` | The common case. |
| `statement` | `Statement => Statement[]` | A list says both useful answers: replace (`[s]`) and delete (`[]`). |
| `statements` | `Statement[] => Statement[]` | A statement can only speak for itself, so a pass reasoning about a **run** of them needs the run — `return` making its following siblings unreachable is the case. |

Returning a node by identity (`===`) is how a pass says "nothing happened", and the walk propagates
that upward, so an unoptimizable module comes back as the same object.
Child lists are copied only at their first changed element. Unchanged lists allocate no replacement
array; statement-list walks without a `statement` hook also avoid singleton result arrays. Hooks still
run once per visited node, bottom-up and in the original order, including whole-list hooks on empty
or unchanged lists.

To measure traversal throughput and heap growth independently of parsing/type checking, run
`node --expose-gc --max-semi-space-size=128 packages/tests/bench/hir-rewrite.ts` from the repository
root. An optional checkout path compares another implementation in the same process, alternating
their order and checking equal results. The fixture contains 10,000 statements with eight numeric
arguments each; it covers identity, sparse and full expression
rewrites, plus an identity statement hook. Timing is the median of 15 batches of 25 walks, including
any collection during a batch; process CPU time is also reported. Heap growth is measured separately
across a single walk after an explicit collection; it is not process RSS or retained memory.
Compare on the same pinned Node and
idle host. These measurements describe the walker, not end-to-end compilation or native execution.

### 6.2 The three passes, and their order

`optimize()` applies them once, in an order that is a chain rather than a preference:

1. **`inlineCalls`** — replaces a call to a one-`return` function with the expression it returns.
   Exposes constants: `double(2)` becomes `2 * 2`.
2. **`constFold`** — evaluates operations over literal operands, using JavaScript's own operators.
   Decides branches: `if (1 < 2)` is not a literal condition until `1 < 2` is `true`.
3. **`eliminateDeadCode`** — drops statements after a jump, selects a literal-conditioned branch,
   removes `while (false)`, and shakes module-level functions nothing can reach. Runs last because
   eliminating a branch is what finally makes a function unreachable.

Once, not to a fixpoint: iterating would find a little more, at the cost of compile time and the
risk of an oscillating pass pair — a trade that wants a measurement (plan §13).

### 6.3 Where the passes decline

Every pass is defined as much by what it refuses, and each refusal names the thing that would
otherwise break:

- A `function` declaration after a `return` **survives** — it is hoisted, so it holds its binding
  for the code above it. Nothing else in the subset is: `let`, `const` and `class` all have a
  temporal dead zone starting where they are written.
- A selected branch stays a **`Block`**, not statements spliced into the parent list. A branch is
  its own scope, and splicing would promote its `let` bindings into the enclosing one.
- The shake covers functions, **not classes**: `new C()` names its class by string rather than by an
  identifier the reference walk would see.
- Inlining declines a body that names anything but its own parameters. The HIR resolves identifiers
  by **name**, so a body reading a module-level `g` moved into a caller with its own `g` would
  silently read the wrong one — and the same condition makes recursion impossible by construction.

---

## Notes

- **HIR stability:** The Phase 2 skeleton HIR (expressions, statements, control flow) is stable. Phases 3+ add new node kinds (arrays, objects, etc.) and new HType kinds (fn, array, object-shape, etc.). All existing nodes remain valid; new passes only have to handle new cases in their switch statements.

- **Scope and binding:** Phase 2 is expression-level and block-scoped only. Function scopes, function parameters and closure capture arrived with Phase 3 rung 4; Task 3.4 is monomorphization.

- **Type narrowing:** `typeof` guards and `as` casts became `BoundaryCheck` nodes in Task 3.5 (§3.2.1). Discriminated unions keyed on a tag still wait for a union the HType model can see the constituents of; until then `unknown` and unions stay wide.

- **Unknown is forever:** `Unknown` does not narrow during optimization — §3.2.2 records how each of the three passes makes that a property of its admission rule rather than a check. A type inference pass that "learns" a better type must emit a runtime check to validate it; without a check, `Unknown` stays.
