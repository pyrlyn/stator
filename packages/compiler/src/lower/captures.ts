/* Capture analysis — which variables a nested function reads from an enclosing one (rung 4b).
 *
 * Runs on the TypeScript AST rather than on HIR, because the question is about DECLARATION SITES
 * and the checker already answers that exactly: two variables named `x` in sibling scopes are
 * different symbols, and no amount of name matching on lowered HIR would tell them apart.
 *
 * The output is the two facts the emitter needs, per function:
 *   - `envVars`  — this function's own bindings that something nested reads, so they must live in
 *                  a heap environment instead of its frame (docs/VALUE.md §4.3).
 *   - `captures` — the names this function reads from an enclosing environment, each resolved to
 *                  (levels-up, index): the chain walk is over ENV-BEARING scopes only, so a
 *                  function that captures nothing adds no level to it.
 *
 * `needsEnv` is transitive on purpose. A function that captures nothing itself still has to carry
 * the incoming environment when something nested reads through it — otherwise the chain has a hole
 * exactly where the intermediate function sits. */

import * as ts from 'typescript';
import { isClassAliasUse, isStaticMember } from '../frontend/types.ts';

/** The receiver, as the lowering names it (`RECEIVER` in `src/lower/index.ts`): parameter zero of
 * a method, constructor or accessor, spelled with a space because no source identifier can be.
 *
 * It is a capture like any other -- an arrow inside a method reads it from an enclosing frame --
 * but it has no DECLARATION node for the symbol walk below to resolve a reference to, so `this`
 * is collected as its own kind of reference. The constant lives here because this is where the
 * capture is discovered; the lowering imports it rather than spelling the name twice. */
export const RECEIVER_NAME = ' this';

/** Every node that opens a new `var`/parameter scope in this subset. A method, a constructor and
 * an accessor are on the list because they ARE functions -- the lowering gives each an explicit
 * receiver parameter and emits it like any other function, so a local declared in one and read by
 * an arrow inside it is an ordinary capture, owned by that member. */
export type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** One free variable, resolved against the environment chain the referencing function receives.
 * `levels` counts from that incoming environment: 0 is the nearest enclosing env-bearing scope. */
export interface EnvCapture {
  readonly name: string;
  /** The declaration this reference resolved to, by SYMBOL. The lowering uses it to spell the HIR
   * name, which is the source name only when the binding was not renamed (plan.md §8 step 14):
   * two variables named `x` in nested scopes are one string and two symbols, and this node is what
   * tells them apart. `undefined` for the RECEIVER, which is a parameter the source never
   * declared -- see {@link RECEIVER_NAME}. */
  readonly decl: ts.Declaration | undefined;
  readonly levels: number;
  readonly index: number;
}

export interface CaptureInfo {
  /** Own bindings held in this function's environment; the array position IS the slot index. */
  readonly envVars: readonly string[];
  /** The declaration each `envVars` entry names, in the same order — see `EnvCapture.decl`. */
  readonly envDecls: readonly (ts.Declaration | undefined)[];
  readonly captures: readonly EnvCapture[];
  /** This function, or something nested inside it, reads an enclosing environment. */
  readonly needsEnv: boolean;
}

/** What can own a heap environment. Almost always a function — but the MODULE owns one too, for
 * the one kind of module-level binding the globals array cannot hold: see `isPerIterationBinding`.
 * And a CLASS owns one entry — the receiver — for the one kind of `this` no enclosing function
 * owns: an arrow inside a field initializer (see `enclosingThisOwner`). The source file sits at
 * the outer end of every environment chain, so a capture resolved against it needs no special
 * case in the `levels` walk — it is simply the last scope reached. */
export type EnvOwner = FunctionLike | ts.ClassLikeDeclaration | ts.SourceFile;

export type CaptureMap = ReadonlyMap<EnvOwner, CaptureInfo>;

const FUNCTION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

export function isFunctionLike(node: ts.Node): node is FunctionLike {
  return FUNCTION_KINDS.has(node.kind);
}

/** The scope that owns a `this` read: the nearest enclosing function that HAS a receiver of
 * its own — a method, a constructor, an accessor, a function declaration or expression,
 * everything but an arrow, which passes the receiver through — or, when the keyword sits in a
 * field initializer behind arrows, the enclosing class.
 *
 * A field initializer runs inside the constructor (the lowering moves it there), so an arrow's
 * `this` there reads the constructor's receiver, yet the walk finds no non-arrow function
 * ancestor for it — the parents are the arrow, the property, the class — and the receiver was
 * never captured (`undefined` at module level, where the old walk ended). The class stands in
 * for the constructor because there may not be one written; `lowerClass` merges the class's
 * receiver into whichever constructor runs the initializers, explicit or synthesized. A `this`
 * written DIRECTLY in an initializer takes no branch here — it lowers to the constructor body's
 * own receiver read and needs no capture — so only an arrow-crossing read names the class.
 * A static initializer is skipped: its `this` is the class object, which the gate refuses, so
 * there is no receiver to own. `undefined` at module level, where there is none. */
function enclosingThisOwner(node: ts.Node): FunctionLike | ts.ClassLikeDeclaration | undefined {
  let sawArrow = false;
  for (let current: ts.Node | undefined = node.parent; current !== undefined;) {
    if (ts.isArrowFunction(current)) {
      sawArrow = true;
      current = current.parent;
      continue;
    }
    if (isFunctionLike(current)) {
      return current;
    }
    if (
      sawArrow &&
      ts.isPropertyDeclaration(current) &&
      (ts.isClassDeclaration(current.parent) || ts.isClassExpression(current.parent)) &&
      !isStaticMember(current)
    ) {
      return current.parent;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/** The nearest function-like ancestor, or undefined when the node lives at module level. */
export function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined;) {
    if (isFunctionLike(current)) {
      return current;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/** The nearest ancestor that can own an environment: a function or a class. The class half
 * exists for the field-initializer receiver (see `enclosingThisOwner`): a capture chain that
 * starts at a class passes through arrows only, so this and `enclosingFunction` agree on every
 * chain that does not. */
function enclosingScope(node: ts.Node): FunctionLike | ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined;) {
    if (isFunctionLike(current)) {
      return current;
    }
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/** A declaration whose storage a capture can move into an environment. Anything else — a class, an
 * import, a property — is either not a binding or not yet in the subset, and is left alone. */
function isCapturableDeclaration(decl: ts.Declaration): boolean {
  return ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isFunctionDeclaration(decl);
}

/** The binding name a capturable declaration introduces, or undefined when it is destructured
 * (which the gate rejects before this runs). */
function declarationName(decl: ts.Declaration): string | undefined {
  if (ts.isFunctionDeclaration(decl)) {
    return decl.name?.text;
  }
  if (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) {
    return ts.isIdentifier(decl.name) ? decl.name.text : undefined;
  }
  return undefined;
}

/** Whether a MODULE-level declaration gets a fresh binding on every iteration of a loop, and so
 * cannot live in the globals array.
 *
 * The globals array gives a name one slot for the life of the program, which is exactly right for
 * a module-level binding — every function can reach it and there is only ever one of it. A
 * `let`/`const` declared inside a loop breaks that assumption: JavaScript gives each iteration its
 * own binding, so three closures made in three iterations must see three values. One global slot
 * holds the last one, and every closure reads it (`0 10 20` printed as `20 20 20`). Those bindings
 * therefore move into a module environment, where the loop's existing per-iteration clone/commit
 * (docs/VALUE.md §4.3) gives each iteration its own copy — the same machinery, and the same
 * layout rules, a function scope has always used.
 *
 * `var` is excluded because it is function-scoped even when spelled inside a loop: one binding
 * shared by every iteration IS its semantics, and the globals array already implements that. */
function isPerIterationBinding(decl: ts.Declaration): boolean {
  if (!ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent)) {
    return false;
  }
  const blockScoped = (decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  return blockScoped && loopScopeOf(decl) !== undefined;
}

/** The loop that gives `decl` a fresh binding each iteration, searched no further out than the
 * function owning the declaration — a loop outside that function re-runs the call, not the
 * binding. Mirrors `loopScopeOf` in the gate, which asks the same question of the same nodes. */
function loopScopeOf(decl: ts.Node): ts.Node | undefined {
  for (let n = decl.parent as ts.Node | undefined; n !== undefined; n = n.parent) {
    if (isFunctionLike(n)) {
      return undefined;
    }
    if (ts.isIterationStatement(n, false)) {
      return n;
    }
  }
  return undefined;
}

/** The identifier a declaration is NAMED by is not a reference to it. This matters for a nested
 * `function f`: its name sits inside `f`'s own subtree, so read as a reference it looks like `f`
 * capturing itself from the scope around it -- which would put every nested function declaration
 * in its parent's environment and cost it the static-closure path for nothing. */
function isDeclarationNameOf(node: ts.Identifier, decl: ts.Declaration): boolean {
  return ts.getNameOfDeclaration(decl) === node;
}

export function analyzeCaptures(sourceFile: ts.SourceFile, checker: ts.TypeChecker): CaptureMap {
  /* Pass 1: find every cross-function reference. A declaration is captured when some reference to
   * it sits in a different function than the one that declares it -- however it is spelled, and
   * regardless of how many scopes separate them. */
  /* Keyed by DECLARATION, not by name. Two loops at module level can each declare `let i`, and
   * they are two bindings that need two environment slots: one name would give them one slot, and
   * the second loop's iterations would overwrite what the first loop's closures still read. The
   * name is carried alongside for the sort and for the diagnostics. */
  const capturedByOwner = new Map<EnvOwner, Map<ts.Declaration | undefined, string>>();
  const references: {
    ref: ts.Node;
    declFn: EnvOwner;
    name: string;
    decl: ts.Declaration | undefined;
  }[] = [];

  const visit = (node: ts.Node): void => {
    // `this` crossed by an ARROW. An arrow has no receiver of its own -- that is what makes it an
    // arrow -- so a `this` inside one is a read of the nearest enclosing non-arrow function's
    // receiver parameter, which is a cross-function reference exactly like a local variable's.
    // Only the arrow case is a capture: inside the owner's own body the same keyword is the
    // ordinary parameter read, and a plain nested `function`'s `this` belongs to that function
    // (its dynamic receiver, `undefined` on a bare strict-mode call via `has_receiver`).
    // `super` reads the same receiver -- `super.m()` is a call on it that skips the override,
    // and `super.m` as a value takes it as the method-value target -- so it captures under the
    // same rule. Without this an arrow holding only a `super` use captured nothing and the
    // emitter failed the receiver read as STA4072 (plan.md §8 step 42).
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      const owner = enclosingThisOwner(node);
      if (owner !== undefined && owner !== enclosingFunction(node)) {
        let owned = capturedByOwner.get(owner);
        if (owned === undefined) {
          owned = new Map();
          capturedByOwner.set(owner, owned);
        }
        owned.set(undefined, RECEIVER_NAME);
        references.push({ ref: node, declFn: owner, name: RECEIVER_NAME, decl: undefined });
        // An explicit constructor runs the field initializers, so it needs the receiver in its
        // own environment too — the same slot the field arrows read. Recorded as owned, not as
        // referenced: no reference points at it, so passes 3–4 leave it alone, while pass 2 lays
        // it out first in both lists, which is what keeps the two index spaces agreeing at zero.
        // A synthesized constructor has no node to record against; `lowerClass` merges the
        // class's receiver into it when it builds it.
        if (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) {
          const ctor = owner.members.find(
            (m): m is ts.ConstructorDeclaration =>
              ts.isConstructorDeclaration(m) && m.body !== undefined,
          );
          if (ctor !== undefined) {
            let ctorOwned = capturedByOwner.get(ctor);
            if (ctorOwned === undefined) {
              ctorOwned = new Map();
              capturedByOwner.set(ctor, ctorOwned);
            }
            ctorOwned.set(undefined, RECEIVER_NAME);
          }
        }
      }
    }
    if (ts.isIdentifier(node)) {
      // A class alias binds no value -- every in-place use erases to the target declaration --
      // so a reference to one needs no environment slot. Without this a closure reading `new K()`
      // would mint storage for a binding the lowering never emits, and the emitter's slot lookup
      // would aim at a name with no home.
      if (isClassAliasUse(node, checker)) {
        return;
      }
      const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (decl !== undefined && isCapturableDeclaration(decl) && !isDeclarationNameOf(node, decl)) {
        const enclosing = enclosingFunction(decl);
        const name = declarationName(decl);
        // A module-level binding normally lives in the globals array, which every function can
        // already reach, so it is never a capture. The exception is the per-iteration one: it
        // needs an environment for the same reason a function-local capture does, and the module
        // is what owns it (`isPerIterationBinding`).
        const declFn: EnvOwner | undefined =
          enclosing ?? (isPerIterationBinding(decl) ? sourceFile : undefined);
        if (declFn !== undefined && name !== undefined && enclosingFunction(node) !== enclosing) {
          let owned = capturedByOwner.get(declFn);
          if (owned === undefined) {
            owned = new Map();
            capturedByOwner.set(declFn, owned);
          }
          owned.set(decl, name);
          references.push({ ref: node, declFn, name, decl });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  /* Pass 2: fix each environment's slot order. Sorted, so the layout depends only on the source
   * and not on the order the walk happened to encounter references in. Two same-named bindings
   * tie on the name and are ordered by position, which is what makes the order total rather than
   * dependent on the walk. */
  const envDeclsOf = new Map<EnvOwner, (ts.Declaration | undefined)[]>();
  const envVarsOf = new Map<EnvOwner, string[]>();
  for (const [fn, decls] of capturedByOwner) {
    const ordered = [...decls.entries()]
      .sort(([a, an], [b, bn]) => {
        if (an !== bn) {
          return an < bn ? -1 : 1;
        }
        // The receiver has no declaration node and sorts first, which is where a method's
        // parameter zero belongs.
        return (a?.getStart() ?? -1) - (b?.getStart() ?? -1);
      })
      .map(([decl]) => decl);
    envDeclsOf.set(fn, ordered);
    envVarsOf.set(
      fn,
      ordered.map((decl) => decls.get(decl) ?? ''),
    );
  }
  const hasEnv = (fn: FunctionLike): boolean => (envVarsOf.get(fn)?.length ?? 0) > 0;

  /* Pass 3: resolve every reference to (levels, index) against the chain its function receives,
   * and collect them per referencing function. */
  const capturesOf = new Map<EnvOwner, Map<string, EnvCapture>>();
  for (const { ref, declFn, name, decl } of references) {
    const refFn = enclosingFunction(ref);
    if (refFn === undefined) {
      // A module-level reference to a function-local cannot occur in well-formed source; the
      // checker would not have resolved it. Nothing to record.
      continue;
    }
    // By IDENTITY: two bindings can share a name, and `indexOf(name)` would send both references
    // to the first one's slot.
    const index = envDeclsOf.get(declFn)?.indexOf(decl) ?? -1;
    if (index < 0) {
      continue;
    }
    let levels = 0;
    if (ts.isClassDeclaration(declFn) || ts.isClassExpression(declFn)) {
      // A field-initializer receiver: at run time the arrow is created inside the constructor,
      // whose environment IS the class's, so the chain from the arrow reaches it through arrows
      // only — and only an arrow that owns an environment of its own adds a level.
      for (
        let a: FunctionLike | ts.ClassLikeDeclaration | undefined = enclosingScope(refFn);
        a !== undefined;
        a = enclosingScope(a)
      ) {
        if (a === declFn) {
          break;
        }
        if (isFunctionLike(a) && hasEnv(a)) {
          levels++;
        }
      }
    } else {
      for (let a = enclosingFunction(refFn); a !== undefined; a = enclosingFunction(a)) {
        if (a === declFn) {
          break;
        }
        if (hasEnv(a)) {
          levels++;
        }
      }
    }
    let own = capturesOf.get(refFn);
    if (own === undefined) {
      own = new Map();
      capturesOf.set(refFn, own);
    }
    own.set(name, { name, decl, levels, index });
  }

  /* Pass 4: propagate `needsEnv` outward. An intermediate function that captures nothing still
   * carries the environment when something nested reads through it. */
  const needsEnv = new Set<EnvOwner>();
  for (const { ref, declFn } of references) {
    const refFn = enclosingFunction(ref);
    if (refFn === undefined) {
      continue;
    }
    if (ts.isClassDeclaration(declFn) || ts.isClassExpression(declFn)) {
      // The constructor owns its environment rather than receiving one on this account, so the
      // chain stops at the class: every arrow strictly inside it carries the incoming one.
      for (
        let f: FunctionLike | ts.ClassLikeDeclaration | undefined = refFn;
        f !== undefined && f !== declFn;
        f = enclosingScope(f)
      ) {
        needsEnv.add(f);
      }
      continue;
    }
    // Stop AT the declaring function: it reaches the variable through its own environment, so it
    // needs no incoming one on this account. Everything strictly inside it is on the chain.
    for (
      let f: FunctionLike | undefined = refFn;
      f !== undefined && f !== declFn;
      f = enclosingFunction(f)
    ) {
      needsEnv.add(f);
    }
  }

  const result = new Map<EnvOwner, CaptureInfo>();
  const record = (fn: EnvOwner): void => {
    const envVars = envVarsOf.get(fn) ?? [];
    result.set(fn, {
      envVars,
      envDecls: envDeclsOf.get(fn) ?? [],
      captures: [...(capturesOf.get(fn)?.values() ?? [])],
      needsEnv: needsEnv.has(fn),
    });
  };
  const collect = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      record(node);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // A field-initializer receiver lives here (see `enclosingThisOwner`); `lowerClass` reads
      // it to size the constructor's environment. Usually empty, like most functions.
      record(node);
    }
    ts.forEachChild(node, collect);
  };
  // The module is recorded too, and unconditionally: its entry is what the emitter reads to size
  // the module environment, and "no per-iteration binding was captured" has to be answerable as an
  // empty list rather than as a missing key.
  record(sourceFile);
  collect(sourceFile);
  return result;
}
