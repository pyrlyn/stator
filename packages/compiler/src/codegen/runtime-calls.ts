/* Runtime calls: extern, console, collections, and call sites.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import {
  consoleEntryPoint,
  isConsoleVariadicWidth,
  type ArrayOp,
  type ConsoleLogCall,
  type ExternAbiKind,
  type ExternCall,
  type Span,
} from '../hir/nodes.ts';
import { snakeCase } from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgExpr from './expr.ts';
import * as cgSeq from './sequence.ts';

/* Sequences a call-shaped node's arguments left to right into consecutive rooted slots
 * starting at `base + start`: slot `start` is the callee's -- or the receiver's, or the
 * constructed object's -- so the first argument lands one past it. Evaluation order IS
 * source order (each operand lands in its rooted slot before the next runs), which is why
 * every call-shaped arm shares this loop rather than copying it. Returns whether any
 * operand flushed, for the arms whose tail nests inline when nothing did. */
/* The C call for an `array-op` node: the fixed-arity ops derive it mechanically
 * (`jsrt_array_` + snake_case), while the variadic ones (plan.md §8 step 19) pick the entry
 * point by count. The single-argument (and two-argument splice) forms keep their existing
 * entry points; every other count calls the `_many`/`_from`/`_insert` variant with the count
 * spliced in after the receiver. `concat` with one ARRAY argument keeps its entry point too —
 * a single non-array (or Unknown-typed) argument rides `concat_many`, which spreads arrays
 * and appends anything else, where the one-array function would read a non-array as one. */

export function arrayOpCall(self: Emitter, expr: ArrayOp, base: number): string {
  const target = cgSeq.slotAt(self, base);
  const arg = (index: number): string => cgSeq.slotAt(self, base + 1 + index);
  const rest = (from: number): string =>
    expr.args
      .slice(from)
      .map((_, index) => arg(from + index))
      .join(', ');
  if (expr.op === 'push' || expr.op === 'unshift') {
    if (expr.args.length === 1) {
      return `jsrt_array_${expr.op}(${target}, ${arg(0)})`;
    }
    const items = rest(0);
    return items === ''
      ? `jsrt_array_${expr.op}_many(${target}, 0)`
      : `jsrt_array_${expr.op}_many(${target}, ${String(expr.args.length)}, ${items})`;
  }
  if (expr.op === 'splice') {
    if (expr.args.length === 0) {
      // Zero arguments spell the two-argument form over `undefined` (an absent start is 0
      // and an absent deleteCount is 0), so the existing entry point serves unchanged.
      return `jsrt_array_splice(${target}, JSRT_UNDEFINED, JSRT_UNDEFINED)`;
    }
    if (expr.args.length === 1) {
      return `jsrt_array_splice_from(${target}, ${arg(0)})`;
    }
    if (expr.args.length === 2) {
      return `jsrt_array_splice(${target}, ${arg(0)}, ${arg(1)})`;
    }
    return (
      `jsrt_array_splice_insert(${target}, ${arg(0)}, ${arg(1)}, ` +
      `${String(expr.args.length - 2)}, ${rest(2)})`
    );
  }
  if (expr.op === 'concat') {
    const items = rest(0);
    const call =
      expr.args.length === 1 && expr.args[0]?.type.kind === 'array'
        ? `jsrt_array_concat(${target}, ${arg(0)})`
        : items === ''
          ? `jsrt_array_concat_many(${target}, 0)`
          : `jsrt_array_concat_many(${target}, ${String(expr.args.length)}, ${items})`;
    return expr.spread === true ? `jsrt_array_fill_holes(${call})` : call;
  }
  if (expr.op === 'lastIndexOf' && expr.args.length === 2) {
    return `jsrt_array_last_index_of_from(${target}, ${arg(0)}, ${arg(1)})`;
  }
  const operands = [target, ...expr.args.map((_, index) => arg(index))].join(', ');
  return `jsrt_array_${snakeCase(expr.op)}(${operands})`;
}

/* An extern call as statements (docs/FFI.md §§3–4, plan.md §10 Task 7.1 step 5): arguments
 * left to right into rooted slots, string copies beside them, one direct C call, the boxed result, frees, and
 * the error-convention check — in that order, never nested inside a
 * consumer's expression.
 *
 * The order is the whole design:
 * - arguments evaluate FIRST: their own pending checks run before any temporary exists, so a
 *   throwing argument unwinds with nothing to free;
 * - the boxed result, including the `from_cstr` copy-out, is stored BEFORE the
 *   frees: a `cstring` return may alias a borrow (`strstr` into its haystack), so
 *   copying after freeing is a use-after-free. For non-aliasing returns the order
 *   is unobservable;
 * - the UTF-8 copies (`jsrt_string_to_cstr`, malloc memory the caller owns) are freed BEFORE
 *   the error-convention throw: no pending check and no `goto` stands between an allocation
 *   and its free, so every exit path — landing pads included — is already clean when taken;
 * - the C call itself cannot set the pending cell (it runs no Stator code, and v0 has no
 *   callback trampoline), so reaching it means no exception is in flight and none can cross
 *   it — the never-unwind-through-C absolute, by construction rather than by audit;
 * - `errno` is zeroed before the call and read into a C local immediately after, before the
 *   frees: the read precedes every other runtime call, exactly as §4's sequence demands.
 *
 * Temporary names carry an emission-unique site number, not the slot base: inlining emits one
 * node — one base — at every call site, and those sites can share a C scope. */
export function emitExternCall(self: Emitter, expr: ExternCall, base: number): string {
  const site = String(self.externSiteCount++);
  const argStart = expr.retKind === 'void' ? 0 : 1;
  const parts: string[] = [];
  cgSeq.sequenceArgs(self, parts, expr.args, expr.span, base, argStart);
  cgSeq.flushParts(self, parts, expr.span);
  const cArgs: string[] = [];
  const outWrites: { name: string; slot: string }[] = [];
  for (let index = 0; index < expr.args.length; index++) {
    const slot = cgSeq.slotAt(self, base + argStart + index);
    const kind = expr.argKinds[index];
    if (kind === 'cstring' || kind === 'cstring-owned') {
      const temp = `_jsrt_exc_${site}_${String(index)}`;
      cgSeq.appendLine(self, `char *${temp} = jsrt_string_to_cstr(${slot});`, expr.span);
      cArgs.push(temp);
    } else if (kind === 'number') {
      cArgs.push(`jsrt_to_number(${slot})`);
    } else if (kind === 'boolean') {
      cArgs.push(`jsrt_as_bool(${slot})`);
    } else if (kind === 'pointer') {
      // Borrow-only (docs/FFI.md §9): the handle is read from its rooted slot and passed
      // untouched — never dereferenced, never stored anywhere but the callee's parameter.
      // The slot stays live across the call (the frame pops only at return and landing-pad
      // dispatch, neither of which this direct call can reach), so the collector sees the
      // handle for exactly as long as C may.
      cArgs.push(`jsrt_ptr(${slot})`);
    } else if (kind === 'bytes') {
      // Two C arguments for one TS parameter (docs/FFI.md §2): the view's bytes in place and
      // its length. No copy -- the callee reads or writes the buffer's own block. Stable for
      // the call: the view stays in its rooted slot (the buffer edge keeps the block alive),
      // neither collector moves memory, a buffer never resizes, and the C call runs no Stator
      // code, so nothing can collect or detach it mid-call (docs/VALUE.md §4.19). The `void *`
      // cast lets a binding header spell the pointee its own way (`char *`, `unsigned char *`).
      // The layout read is guarded EVEN for a statically proven view: a `.ts` parameter
      // annotated `Uint8Array` is reachable from js-mode code with anything in it (only the
      // number/string/boolean call edges are checked, plan-notes 308), and here a lie would
      // be a wild pointer in C, not a wrong value. One tag and class compare per call; a
      // dynamic argument already carries the lowering's check, so it is not checked twice.
      if (expr.args[index]?.kind !== 'boundary-check') {
        cgSeq.appendLine(
          self,
          `(void)jsrt_check_uint8array(${slot}, ${callLocation(self, expr.span)});`,
          expr.span,
        );
      }
      cArgs.push(`(void *)jsrt_uint8array_bytes(${slot})`, `jsrt_uint8array_count(${slot})`);
    } else if (kind === 'out-pointer') {
      // A slot address, not a value (docs/FFI.md §2): the callee writes the `T*` through it
      // into the argument's own frame slot, which stays rooted across the call exactly like
      // any other argument slot. Under a binding header the real prototype governs, so the
      // address casts through the parameter's brand tag (`char` for an `Out<CString>` tail);
      // the fallback declaration takes `void **` and the same cast matches it exactly.
      const tag = expr.argTags[index];
      if (tag === undefined) {
        throw new Error(`extern call out-pointer argument ${String(index)} has no cast tag`);
      }
      // A `CString` inner crosses as `const char **` under a header (`char **` would
      // discard qualifiers in nested pointer types); a brand casts through its struct
      // tag. The fallback declaration takes `void **` either way.
      const cast =
        expr.header !== undefined ? (tag === 'char' ? '(const char**)' : `(${tag}**)`) : '(void**)';
      cArgs.push(`${cast}&${slot}`);
      const arg = expr.args[index];
      if (arg !== undefined && arg.kind === 'identifier') {
        outWrites.push({ name: arg.name, slot });
      }
    } else {
      throw new Error(`extern call argument has no C passing: ${kind ?? 'missing'}`);
    }
  }
  if (expr.error === 'errno') {
    cgSeq.appendLine(self, 'errno = 0;', expr.span);
  }
  const call = `${expr.cName}(${cArgs.join(', ')})`;
  // The raw C result travels in a C local, never through a converted expression: for a
  // `cstring` return it is the library's pointer, NULL-checked below before the copy.
  const raw = `_jsrt_exr_${site}`;
  if (expr.retKind === 'void') {
    cgSeq.appendLine(self, `${call};`, expr.span);
  } else {
    // `char *` for a string return (see `externCReturnType`): the library's pointer,
    // NULL-checked below before the copy. The explicit cast absorbs spelling drift in
    // real prototypes (`const unsigned char *` from `<sqlite3.h>`): same address, and
    // nothing written through it before the copy.
    const rawType = expr.retKind === 'cstring' ? 'char *' : externCType(self, expr.retKind);
    const rawCall = expr.retKind === 'cstring' ? `(char *)(${call})` : call;
    cgSeq.appendLine(self, `${rawType} ${raw} = ${rawCall};`, expr.span);
  }
  // Slot write-back: what the callee stored through an out-pointer lands in the
  // argument's frame slot, and a NAMED slot must see it — the caller's `.value` reads its
  // own cell, not the argument's. Slot copies, never addresses, so no dangling is possible;
  // reading through any other name than the written one answers a stale cell (docs/FFI.md
  // §2: read through the name you wrote through). Before the errno read, the boxing, and
  // the convention check: the slot reflects whatever C wrote even when the call throws.
  for (const write of outWrites) {
    cgSeq.appendLine(self, `${cgSeq.slotRef(self, write.name)} = ${write.slot};`, expr.span);
  }
  if (expr.error === 'errno') {
    cgSeq.appendLine(self, `int _jsrt_exe_${site} = errno;`, expr.span);
  }
  // Box the result BEFORE freeing borrows (see the order note above): the copy-out
  // must precede the frees, while frees and the throw check still follow for every
  // return kind. `void` calls have nothing to box and fall through to frees + check.
  const result = expr.retKind === 'void' ? 'JSRT_UNDEFINED' : cgSeq.slotAt(self, base);
  if (expr.retKind !== 'void') {
    // A pointer result is boxed by BIT PATTERN, never by value: the raw `void *` becomes the
    // slot's 64 bits, exactly as the loop state keeps a raw `JSRTEnv *` in a slot — the
    // collector masks every word, so an unboxed pointer in a slot is traced, where a NaN-boxed
    // value would be invisible. No GC allocation stands between the call and this store (the
    // frees are libc, the errno read is an int), so no collection can observe the handle
    // anywhere but its slot.
    // A NULL C return never reaches the copy-out: under the `null` convention (or
    // `errno` on a string return) the throw below handles it, so the copy is guarded
    // and the sentinel is dead on every path that throws. A bare NULL with no
    // convention is a contract violation and still asserts inside `from_cstr`.
    const copyOut =
      expr.error === 'null' || expr.error === 'errno'
        ? `(${raw} == NULL ? JSRT_UNDEFINED : jsrt_string_from_cstr(${raw}))`
        : `jsrt_string_from_cstr(${raw})`;
    const boxed =
      expr.retKind === 'number'
        ? `jsrt_number(${raw})`
        : expr.retKind === 'boolean'
          ? `jsrt_bool(${raw})`
          : expr.retKind === 'pointer'
            ? `(jsrt_value)(uintptr_t)${raw}`
            : copyOut;
    cgSeq.appendLine(self, `${result} = ${boxed};`, expr.span);
  }
  // Borrows freed before any throw below: the only `goto`s past this point are the
  // error-convention check's own, taken with nothing outstanding. A transferred
  // (`cstring-owned`) copy is the callee's now and is never freed here.
  for (let index = 0; index < expr.args.length; index++) {
    if (expr.argKinds[index] === 'cstring') {
      cgSeq.appendLine(self, `free(_jsrt_exc_${site}_${String(index)});`, expr.span);
    }
  }
  if (expr.error !== undefined) {
    // The wording is step-5 lowering detail (docs/FFI.md §7): an `Error` naming the function
    // and the failed convention, through the runtime's own literal-message throw.
    const detail =
      expr.error === 'nonzero'
        ? 'nonzero return'
        : expr.error === 'negative'
          ? 'negative return'
          : expr.error === 'null'
            ? 'NULL return'
            : 'errno set';
    const failed =
      expr.error === 'nonzero'
        ? `${raw} != 0`
        : expr.error === 'negative'
          ? `${raw} < 0`
          : expr.error === 'null'
            ? `${raw} == NULL`
            : `_jsrt_exe_${site} != 0`;
    cgSeq.appendLine(
      self,
      `if (${failed}) { jsrt_throw_error(&jsrt_class_error, ` +
        `"extern call '${cgSeq.escapeCString(self, expr.tsName)}' failed: ${detail}"); }`,
      expr.span,
    );
    cgSeq.emitPendingCheck(self, expr.span);
  }
  return result;
}

/** The bare C call behind a console node — no value appended.
 *
 * The operand list is positional; the WIDTH picks the entry point, which is the only thing the
 * two short forms need from it. Both call sites (value position and statement position) go
 * through here so the width-to-entry-point rule is stated once.
 *
 * With TWO OR MORE arguments each one is evaluated into its own rooted slot, in source order,
 * BEFORE the call: C evaluates function arguments in an unspecified order, so
 * `console.assert(a[0] === 1, f(a))` ran `f` first and then read the array it had just mutated
 * -- the assertion reported a failure Node never sees (plan-notes 221). The slots also keep
 * every argument alive across the next one's evaluation. One argument needs neither: there is no
 * order to fix and nothing can run between its evaluation and the call. */
/** The first slot of a console call's contiguous rooted run, after evaluating every
 * argument into its slot in source order. Shared by the positional and the `(count, argv)`
 * forms, which differ only in what call string they build over the run. */
export function consoleSlots(self: Emitter, expr: ConsoleLogCall): number {
  const base = self.callSlots.get(expr);
  if (base === undefined) {
    throw new Error('console arguments were not registered during counting');
  }
  const parts: string[] = [];
  expr.args.forEach((arg, index) => {
    cgSeq.sequencePart(
      self,
      parts,
      arg,
      expr.span,
      (v) => `${cgSeq.slotAt(self, base + index)} = ${v}`,
    );
  });
  cgSeq.flushParts(self, parts, expr.span);
  return base;
}

export function consoleCall(self: Emitter, expr: ConsoleLogCall): string {
  const fn = consoleEntryPoint(expr.method, expr.args.length);
  if (fn === null) {
    throw new Error(
      `console.${expr.method} has no entry point for ${String(expr.args.length)} arguments`,
    );
  }
  // A variadic width takes `(count, argv)` on the `jsrt_array_new` discipline: no arguments is
  // `(0, NULL)`, and two or more evaluate into slots in source order under the same C-ordering
  // rule as every other multi-argument call. The one-argument call keeps its positional entry
  // point below, so its generated C is exactly what it was.
  if (isConsoleVariadicWidth(expr.method, expr.args.length)) {
    if (expr.args.length === 0) {
      return `${fn}(0, NULL)`;
    }
    const base = consoleSlots(self, expr);
    return `${fn}(${String(expr.args.length)}, &${cgSeq.slotAt(self, base)})`;
  }
  if (expr.args.length < 2) {
    const operands = expr.args.map((arg) => cgExpr.emitExpression(self, arg)).join(', ');
    return `${fn}(${operands})`;
  }
  const base = consoleSlots(self, expr);
  const operands = expr.args.map((_, index) => cgSeq.slotAt(self, base + index)).join(', ');
  return `${fn}(${operands})`;
}

/** A literal's shape becomes a class with no constructor, no methods and no table -- which is
 * all a descriptor needs. Two literals of the same shape share the name, so they share the
 * descriptor, which is what makes them one type rather than two. */
/** Claims the next inline-cache site and returns its C name. Every dynamic property site gets
 * its own -- sharing one between two sites would make them evict each other on every
 * alternation, which is the pathology caches exist to avoid. */
export function icSite(self: Emitter): string {
  const name = `_jsrt_ic_${String(self.icCount)}`;
  self.icCount += 1;
  return name;
}

/** `file:line` baked into `jsrt_call_at` so a non-function callee names the site (STA2006).
 * Column is not on `Span` by design (docs/HIR.md BoundaryCheck): the emitter has no source
 * text, and growing every node for one human-facing trap is the trade the IR already refused. */
export function callLocation(self: Emitter, span: Span): string {
  const file = cgSeq.escapeCString(self, span.file ?? self.fileName);
  return `"${file}:${String(span.line)}"`;
}

/* The C type one ABI kind crosses as (docs/FFI.md §2): the forward declaration and the call
 * read the same function so the two cannot disagree about what a kind MEANS. A pointer
 * crosses as `void *`: every object pointer converts to and from it without a cast, so one
 * spelling serves every brand, and a definition whose true type differs only in the pointed-to
 * struct still links at the ABI level. */
export function externCType(_self: Emitter, kind: ExternAbiKind): string {
  switch (kind) {
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'cstring':
    case 'cstring-owned':
      return 'const char *';
    case 'pointer':
      return 'void *';
    case 'out-pointer':
      // A slot address crosses as an untyped out-param: the fallback declaration cannot
      // name the pointee (that spelling lives in the binding header, when one governs),
      // so it takes `void **` and every argument arrives with an explicit cast to match.
      return 'void **';
    case 'bytes':
      // One TS parameter, two C parameters: the parameter list is joined from these, so
      // the pair lands in place (docs/FFI.md §2).
      return 'uint8_t *, size_t';
    case 'void':
      return 'void';
  }
}

/* The C type an extern RETURN is declared with: the same table, except a string return is
 * spelled `char *` rather than `const char *`. C headers declare string-returning functions
 * mutable (`char *getenv(const char *)`), and a forward declaration that is not IDENTICAL to
 * a visible one is a clang error — so `const char *getenv(...)` fails the build while
 * `char *getenv(...)` links. The ABI is identical either way (a pointer), the value is
 * copied by `jsrt_string_from_cstr` before anything can observe the spelling, and nothing
 * the emitter writes through it mutates: the contract's `const` lives in docs/FFI.md §2,
 * this spelling lives at the linkage line. */
export function externCReturnType(self: Emitter, kind: ExternAbiKind): string {
  return kind === 'cstring' ? 'char *' : externCType(self, kind);
}

/** Records one extern C symbol's forward declaration, derived from the node's own kinds.
 * Runs at COUNTING time so the prologue — emitted before any unit — already knows every
 * symbol. First declaration wins: the gate admits one signature per C symbol, so a second
 * spelling reaching here agrees with the first. The header flags accumulate per NODE, not
 * per symbol: one C function called plain in one place and with `@statorError errno` in
 * another still needs `<errno.h>`, and the declaration's early return must not swallow that.
 *
 * A call compiling under a binding header contributes the header but no declaration: the
 * header declares the symbol itself, with its real prototype — and deletes a forward
 * declaration an earlier headerless call recorded, so one symbol never gets two spellings.
 * (Two binding files for one C symbol is user error the docs refuse; whatever order the
 * calls arrive in, the header governs and clang judges the rest.) */
export function recordExternDecl(self: Emitter, expr: ExternCall): void {
  if (expr.error === 'errno') {
    self.externErrno = true;
  }
  if (expr.argKinds.some((kind) => kind === 'cstring')) {
    self.externStdlib = true;
  }
  if (expr.header !== undefined) {
    if (!self.externHeaders.includes(expr.header)) {
      self.externHeaders.push(expr.header);
    }
    // Covered means covered however the calls interleave: a headerless call before this one
    // recorded a declaration that must go, and one after must not record a new one — the
    // outcome cannot depend on which file counting visited first.
    self.externHeaderCovered.add(expr.cName);
    self.externDecls.delete(expr.cName);
    return;
  }
  if (self.externHeaderCovered.has(expr.cName) || self.externDecls.has(expr.cName)) {
    return;
  }
  const params = expr.argKinds.map((kind) => externCType(self, kind)).join(', ');
  const decl =
    `${externCReturnType(self, expr.retKind)} ${expr.cName}` +
    `(${expr.argKinds.length === 0 ? 'void' : params});`;
  self.externDecls.set(expr.cName, decl);
  // A `cstring` RETURN needs no header: `jsrt_string_from_cstr` is already declared, and the
  // `char *` result travels in a C local, never through a converted expression.
}
