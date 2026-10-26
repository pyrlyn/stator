/* The lowering's lexical scope (plan.md §8 step 14, plan-notes 215).
 *
 * HIR names are SOURCE names, and that is not a shorthand -- it is the contract every consumer
 * downstream relies on: the verifier's binding map, the emitter's slot table, the capture analysis
 * and the passes all key bindings by the name written in the program. The one place it breaks is
 * SHADOWING. `const x = 1; { const x = 2; }` is two bindings and one name, so all of those
 * consumers give the two one home: the block's write lands in the outer slot and the outer `x`
 * reads back 2, where the pinned Node says 1 (plan-notes 209).
 *
 * The fix is alpha-renaming at the lowering: a declaration that would SHADOW a visible binding is
 * emitted under a fresh name no source can spell, and every reference inside that scope resolves
 * to the fresh name. Nothing downstream learns about scopes -- it only ever sees names that are
 * already distinct, which is what makes this correct by construction for all of them at once.
 *
 * Two facts are kept apart on purpose. `ownTypes` is what a name means; `ownHirNames` is what
 * it is CALLED in the HIR. They differ only for a renamed binding, and every declaration records
 * both, so a reference can ask for the spelling without knowing whether a rename happened. */

import type { HType } from '../hir/types.ts';

/** A HIR name no source can spell: no identifier may contain U+0000, so this can never collide
 * with a binding the user wrote, and the source name rides along for anything that prints it.
 * The counter is global rather than per scope, for the same reason `nextBindTemp`'s is: two
 * sibling scopes cannot then mint the same name for two different bindings, which keeps "one name,
 * one binding" true for the whole module instead of only within a scope. */
let shadowCounter = 0;

function shadowName(source: string): string {
  shadowCounter += 1;
  return `\u0000shadow:${source}#${String(shadowCounter)}`;
}

/** Reset per-program naming state. `lowerProgram` calls this so an in-process caller compiling
 * several programs in one process (golden/subset/test262 runners) sees the same names as
 * spawn-per-fixture callers, for whom the module state was fresh every time. */
export function resetShadowCounter(): void {
  shadowCounter = 0;
}

/** The tag inside a shadow HIR name: the full form is NUL + `shadow:<source>#<counter>` (see
 * `shadowName` above). Kept as a named constant so no other module must spell the NUL byte. */
const SHADOW_TAG = 'shadow:';

/** The source name a shadow HIR name was minted for, or `undefined` when `name` is not one.
 *
 * No source identifier may contain U+0000, so a leading NUL is unambiguous, and the counter is
 * cut at the last `#`. Class descriptors are keyed by HIR name (plan.md §8 step 23) but PRINT
 * under this source name, and the override question is asked of source-level families, so both
 * need the way back. */
export function shadowSource(name: string): string | undefined {
  if (name.charCodeAt(0) !== 0 || !name.startsWith(SHADOW_TAG, 1)) {
    return undefined;
  }
  const hash = name.lastIndexOf('#');
  if (hash < 1 + SHADOW_TAG.length) {
    return undefined;
  }
  return name.slice(1 + SHADOW_TAG.length, hash);
}

export class Scope {
  /** Bindings this scope itself holds. A lookup walks the parent chain; a write never leaves
   * home, so a block's declaration cannot touch its parent's map the way a copy-then-write
   * could only avoid by copying everything first (plan.md §12). */
  private readonly ownTypes: Map<string, HType>;
  private readonly ownHirNames: Map<string, string>;
  /** Names this scope itself declared, as opposed to ones it inherited. A re-declaration in the
   * SAME scope shares its home (that is `var`, and it is a duplicate function declaration, where
   * the last one wins); a declaration that shadows an ANCESTOR's name gets a fresh one. This is
   * the own-map half of that distinction: `has`/`hirName` see the chain, `declaredHere` sees
   * only this scope. */
  private readonly declaredHere: Set<string>;

  /** Every name declared anywhere in this FUNCTION unit so far -- shared by every block of the
   * unit, fresh at each function and at the module.
   *
   * Visibility alone is not enough to decide a rename, and this set is the reason. Two sibling
   * blocks both declaring `let value` share no visible binding, but they DO share the unit's slot
   * space: the emitter allocates one global (or frame) slot per HIR name. Sharing is harmless
   * while both blocks are transient -- and wrong the moment a closure from the first outlives it,
   * because the second declaration overwrites the slot the closure still reads. `{ const value =
   * 'block'; push(() => value); } const value = 'module';` printed `module` twice for exactly
   * that reason (plan-notes 216). */
  private readonly unitDeclared: Set<string>;

  /** Spellings this scope owns at the top of the unit even though another scope of the same unit
   * may declare them first (plan.md §11c T11.5a). Only the program entry's module scope has any:
   * every module shares the module unit's slot space, and the entry keeps its source names so a
   * dependency's same-spelled top-level binding is the one that takes a fresh name. */
  private readonly claimed = new Set<string>();

  /** The enclosing scope, or null at the module root. `child()` and `functionScope()` link here
   * instead of duplicating the visible maps, which is what keeps per-block scope creation O(1)
   * in the size of the program rather than O(visible bindings). */
  private readonly parent: Scope | null;

  private constructor(parent: Scope | null, unitDeclared: Set<string>) {
    this.parent = parent;
    this.unitDeclared = unitDeclared;
    this.ownTypes = new Map();
    this.ownHirNames = new Map();
    this.declaredHere = new Set();
  }

  /** The module scope: `bindings` used to start as a bare `new Map()`. */
  static root(): Scope {
    return new Scope(null, new Set());
  }

  /** A nested BLOCK scope -- a block, a loop body, a switch's clause list, a catch clause. It
   * sees every visible binding through the parent link, adds its own without touching the
   * parent, and shares the unit's slot space, because the emitter gives every HIR name one slot
   * per function either way. */
  child(): Scope {
    return new Scope(this, this.unitDeclared);
  }

  /** A FUNCTION scope -- a nested function, a method, an accessor, the module body. Its frame (or
   * globals section) is a slot space of its own, so the unit is new even though the names are
   * inherited. */
  functionScope(): Scope {
    return new Scope(this, new Set());
  }

  /** Reserve `names` for this scope before any module of the unit declares them: a sibling
   * module scope that declares one of them later gets a fresh name, and this scope keeps the
   * source spelling. */
  claim(names: Iterable<string>): void {
    for (const name of names) {
      this.claimed.add(name);
      this.unitDeclared.add(name);
    }
  }

  /** Bind `name` in this scope to a binding another scope owns (an import, plan.md §11c T11.5a):
   * a reference here resolves to `hir` with `type`, and nothing new is allocated. */
  alias(name: string, hir: string, type: HType): void {
    this.ownTypes.set(name, type);
    this.ownHirNames.set(name, hir);
  }

  /** Whether this function unit (this frame's slot space) declared `name` anywhere -- a
   * parameter, a hoisted function, a binding of any block of the same function. A binding only
   * an ENCLOSING function owns is not here. */
  declaredInUnit(name: string): boolean {
    return this.unitDeclared.has(name);
  }

  has(name: string): boolean {
    return this.ownTypes.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name: string): HType | undefined {
    return this.ownTypes.get(name) ?? this.parent?.get(name);
  }

  /** The HIR name a reference to `name` must use. The source name itself unless the binding was
   * renamed, which is why every reference site goes through here rather than reading `name.text`.
   * The own map shadows the parent's, so a `set` in this scope hides an ancestor's rename exactly
   * as overwriting a copied map did. */
  hirName(name: string): string {
    return this.ownHirNames.get(name) ?? this.parent?.hirName(name) ?? name;
  }

  /** Declare a binding that must SHARE whatever already owns its name: a `var` (function-scoped,
   * and the spec's "already instantiated" case), a compiler temporary, a static. Never renames.
   * Writes the innermost scope only and never walks up: a `var` hoisted into a block scope must
   * not leak into the enclosing one, and the chain lookup is what still finds an ancestor's
   * binding from below. */
  set(name: string, type: HType): void {
    this.ownTypes.set(name, type);
    this.ownHirNames.set(name, name);
  }

  /** Declare a NEW binding of this scope and return the HIR name to emit it under.
   *
   * A name this scope already declared keeps its home (the spec's last-one-wins for duplicate
   * function declarations, and `var` sharing). A name inherited from an enclosing scope is a
   * SHADOW, and that is the one case that renames: the fresh name is what gives the block's `x` a
   * slot of its own instead of overwriting the outer `x`. */
  declare(name: string, type: HType): string {
    // A re-declaration in the same scope keeps the binding it already made (last one wins).
    // `declaredHere` is the own-map half of that test and `has` is the chain half: a name this
    // scope declared is same-scope even when an ancestor declares it too, and every other case
    // with a visible binding -- or a second declaration anywhere else in this unit -- needs a
    // name of its own or the two share a slot.
    const sameScope = this.declaredHere.has(name);
    const secondHome =
      !sameScope && !this.claimed.has(name) && (this.has(name) || this.unitDeclared.has(name));
    const hir = secondHome ? shadowName(name) : this.hirName(name);
    this.declaredHere.add(name);
    this.unitDeclared.add(name);
    this.ownTypes.set(name, type);
    this.ownHirNames.set(name, hir);
    return hir;
  }
}
