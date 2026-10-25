/* runtime calls emission for the C emitter (T24 split). */

import type { Emitter } from './emitter.ts';
import type {
  ArrayOp,
  ConsoleLogCall,
  ExternAbiKind,
  ExternCall,
  Expression,
  Span,
} from '../hir/nodes.ts';
import { consoleEntryPoint, isConsoleVariadicWidth } from '../hir/nodes.ts';
import { snakeCase } from './helpers.ts';

export function emitPendingCheck(emitter: Emitter, span: Span): void {
  emitter.appendLine(`if (jsrt_pending()) { goto ${emitter.currentPad()}; }`, span);
}

/* Runs `f` against a private buffer and hands back what it appended plus its value. Loop
 * conditions and short-circuit right operands need this: they are re-evaluated somewhere other
 * than where the emitter is currently appending, so any statements the operand needs (a call
 * and its pending check) must be captured and replayed at the evaluation point. */

export function capture(
  emitter: Emitter,
  f: () => string,
): { readonly lines: string[]; readonly value: string } {
  const saved = emitter.lines;
  const buffer: string[] = [];
  emitter.lines = buffer;
  const value = f();
  emitter.lines = saved;
  return { lines: buffer, value };
}

/* Evaluates one operand of a comma sequence under construction. A call-free operand joins the
 * sequence via `use` and keeps the compact single-line shape. One that produced statements of
 * its own (a call and its pending check) forces the sequence so far out as a statement FIRST:
 * the language already evaluated those operands, so their values must be sitting in their
 * rooted slots before this operand's calls run -- and then lands its own `use` line after its
 * statements. Returns whether it flushed, which tells the caller the compact shape is gone. */

export function sequencePart(
  emitter: Emitter,
  parts: string[],
  operand: Expression,
  span: Span,
  use: (value: string) => string,
): boolean {
  const captured = emitter.capture(() => emitter.emitExpression(operand));
  if (captured.lines.length === 0) {
    parts.push(use(captured.value));
    return false;
  }
  emitter.flushParts(parts, span);
  emitter.lines.push(...captured.lines);
  emitter.appendLine(`${use(captured.value)};`, span);
  return true;
}

export function flushParts(emitter: Emitter, parts: string[], span: Span): void {
  if (parts.length > 0) {
    emitter.appendLine(`${parts.join(', ')};`, span);
    parts.length = 0;
  }
}

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

export function arrayOpCall(emitter: Emitter, expr: ArrayOp, base: number): string {
  const target = emitter.slotAt(base);
  const arg = (index: number): string => emitter.slotAt(base + 1 + index);
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

export function sequenceArgs(
  emitter: Emitter,
  parts: string[],
  args: readonly Expression[],
  span: Span,
  base: number,
  start: number,
): boolean {
  let flushed = false;
  args.forEach((arg, index) => {
    flushed =
      emitter.sequencePart(
        parts,
        arg,
        span,
        (v) => `${emitter.slotAt(base + start + index)} = ${v}`,
      ) || flushed;
  });
  return flushed;
}

/* The shared tail of a sequenced op that nests inline when nothing forced a flush: with no
 * flushed statements the whole sequence -- parts plus the final computation -- is one comma
 * expression answering `result`; otherwise the parts already left as statements and the
 * answer is `result` itself. Arms that always land as statements (a pending check has
 * nowhere to stand inside a comma expression) share `finishStatement` instead. */

export function finishSequenced(
  emitter: Emitter,
  parts: string[],
  result: string,
  span: Span,
  flushed: boolean,
): string {
  if (!flushed) {
    parts.push(result);
    return `(${parts.join(', ')})`;
  }
  emitter.flushParts(parts, span);
  return result;
}

/* Opens a call-shaped arm: the callee (or the receiver, which occupies the callee's slot)
 * first, then the arguments left to right -- the evaluation order the language specifies,
 * each landing in its rooted slot before the next runs. The arms that track flushing keep
 * their own target sequencing and share only the argument half. */

export function beginCall(
  emitter: Emitter,
  parts: string[],
  first: Expression,
  args: readonly Expression[],
  span: Span,
  base: number,
): void {
  emitter.sequencePart(parts, first, span, (v) => `${emitter.slotAt(base)} = ${v}`);
  emitter.sequenceArgs(parts, args, span, base, 1);
}

/* The shared tail of a call-shaped arm that always lands as statements: `assignment`
 * computes the answer into its rooted slot as a STATEMENT (never inside the consumer's
 * expression), so the pending check can sit between the call and whatever consumes the
 * result. Which arms take this tail -- always, or only when they can throw -- stays with
 * each arm; only the landing is shared. */
/* The tail of an op whose answer lands in its first rooted slot: an op that can throw becomes a
 * statement followed by its pending check (the check has to sit between the op and whatever
 * consumes the result, which a comma expression gives it nowhere to stand); any other op stays
 * the sequenced expression. */

export function finishOp(
  emitter: Emitter,
  parts: string[],
  base: number,
  opCall: string,
  span: Span,
  flushed: boolean,
  canThrow: boolean,
): string {
  return canThrow
    ? emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = ${opCall}`,
        emitter.slotAt(base),
        span,
      )
    : emitter.finishSequenced(parts, opCall, span, flushed);
}

export function finishStatement(
  emitter: Emitter,
  parts: string[],
  assignment: string,
  result: string,
  span: Span,
): string {
  parts.push(assignment);
  emitter.flushParts(parts, span);
  emitter.emitPendingCheck(span);
  return result;
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

export function emitExternCall(emitter: Emitter, expr: ExternCall, base: number): string {
  const site = String(emitter.externSiteCount++);
  const argStart = expr.retKind === 'void' ? 0 : 1;
  const parts: string[] = [];
  emitter.sequenceArgs(parts, expr.args, expr.span, base, argStart);
  emitter.flushParts(parts, expr.span);
  const cArgs: string[] = [];
  const outWrites: { name: string; slot: string }[] = [];
  for (let index = 0; index < expr.args.length; index++) {
    const slot = emitter.slotAt(base + argStart + index);
    const kind = expr.argKinds[index];
    if (kind === 'cstring' || kind === 'cstring-owned') {
      const temp = `_jsrt_exc_${site}_${String(index)}`;
      emitter.appendLine(`char *${temp} = jsrt_string_to_cstr(${slot});`, expr.span);
      cArgs.push(temp);
    } else if (kind === 'value') {
      cArgs.push(slot);
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
        emitter.appendLine(
          `(void)jsrt_check_uint8array(${slot}, ${emitter.callLocation(expr.span)});`,
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
    emitter.appendLine('errno = 0;', expr.span);
  }
  const call = `${expr.cName}(${cArgs.join(', ')})`;
  // The raw C result travels in a C local, never through a converted expression: for a
  // `cstring` return it is the library's pointer, NULL-checked below before the copy.
  const raw = `_jsrt_exr_${site}`;
  if (expr.retKind === 'void') {
    emitter.appendLine(`${call};`, expr.span);
  } else {
    // `char *` for a string return (see `externCReturnType`): the library's pointer,
    // NULL-checked below before the copy. The explicit cast absorbs spelling drift in
    // real prototypes (`const unsigned char *` from `<sqlite3.h>`): same address, and
    // nothing written through it before the copy.
    const rawType = expr.retKind === 'cstring' ? 'char *' : emitter.externCType(expr.retKind);
    const rawCall = expr.retKind === 'cstring' ? `(char *)(${call})` : call;
    emitter.appendLine(`${rawType} ${raw} = ${rawCall};`, expr.span);
  }
  // Slot write-back: what the callee stored through an out-pointer lands in the
  // argument's frame slot, and a NAMED slot must see it — the caller's `.value` reads its
  // own cell, not the argument's. Slot copies, never addresses, so no dangling is possible;
  // reading through any other name than the written one answers a stale cell (docs/FFI.md
  // §2: read through the name you wrote through). Before the errno read, the boxing, and
  // the convention check: the slot reflects whatever C wrote even when the call throws.
  for (const write of outWrites) {
    emitter.appendLine(`${emitter.slotRef(write.name)} = ${write.slot};`, expr.span);
  }
  if (expr.error === 'errno') {
    emitter.appendLine(`int _jsrt_exe_${site} = errno;`, expr.span);
  }
  // Box the result BEFORE freeing borrows (see the order note above): the copy-out
  // must precede the frees, while frees and the throw check still follow for every
  // return kind. `void` calls have nothing to box and fall through to frees + check.
  const result = expr.retKind === 'void' ? 'JSRT_UNDEFINED' : emitter.slotAt(base);
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
      expr.retKind === 'value'
        ? raw
        : expr.retKind === 'number'
          ? `jsrt_number(${raw})`
          : expr.retKind === 'boolean'
            ? `jsrt_bool(${raw})`
            : expr.retKind === 'pointer'
              ? `(jsrt_value)(uintptr_t)${raw}`
              : copyOut;
    emitter.appendLine(`${result} = ${boxed};`, expr.span);
  }
  // Borrows freed before any throw below: the only `goto`s past this point are the
  // error-convention check's own, taken with nothing outstanding. A transferred
  // (`cstring-owned`) copy is the callee's now and is never freed here.
  for (let index = 0; index < expr.args.length; index++) {
    if (expr.argKinds[index] === 'cstring') {
      emitter.appendLine(`free(_jsrt_exc_${site}_${String(index)});`, expr.span);
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
    emitter.appendLine(
      `if (${failed}) { jsrt_throw_error(&jsrt_class_error, ` +
        `"extern call '${emitter.escapeCString(expr.tsName)}' failed: ${detail}"); }`,
      expr.span,
    );
    emitter.emitPendingCheck(expr.span);
  }
  return result;
}

/* `goto` to a loop/switch label, routed through any finally standing between here and the
 * target. The innermost try decides: if the target construct opened BEFORE the try did, the
 * jump leaves the protected code and the finally must run first. The dispatch re-invokes this
 * with that scope popped, which chains the jump through the next finally outward in turn. */

export function consoleSlots(emitter: Emitter, expr: ConsoleLogCall): number {
  const base = emitter.callSlots.get(expr);
  if (base === undefined) {
    throw new Error('console arguments were not registered during counting');
  }
  const parts: string[] = [];
  expr.args.forEach((arg, index) => {
    emitter.sequencePart(parts, arg, expr.span, (v) => `${emitter.slotAt(base + index)} = ${v}`);
  });
  emitter.flushParts(parts, expr.span);
  return base;
}

export function consoleCall(emitter: Emitter, expr: ConsoleLogCall): string {
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
    const base = emitter.consoleSlots(expr);
    return `${fn}(${String(expr.args.length)}, &${emitter.slotAt(base)})`;
  }
  if (expr.args.length < 2) {
    const operands = expr.args.map((arg) => emitter.emitExpression(arg)).join(', ');
    return `${fn}(${operands})`;
  }
  const base = emitter.consoleSlots(expr);
  const operands = expr.args.map((_, index) => emitter.slotAt(base + index)).join(', ');
  return `${fn}(${operands})`;
}

export function icSite(emitter: Emitter): string {
  const name = `_jsrt_ic_${String(emitter.icCount)}`;
  emitter.icCount += 1;
  return name;
}

/** `file:line` baked into `jsrt_call_at` so a non-function callee names the site (STA2006).
 * Column is not on `Span` by design (docs/HIR.md BoundaryCheck): the emitter has no source
 * text, and growing every node for one human-facing trap is the trade the IR already refused. */

export function callLocation(emitter: Emitter, span: Span): string {
  const file = emitter.escapeCString(span.file ?? emitter.fileName);
  return `"${file}:${String(span.line)}"`;
}

/* The C type one ABI kind crosses as (docs/FFI.md §2): the forward declaration and the call
 * read the same function so the two cannot disagree about what a kind MEANS. A pointer
 * crosses as `void *`: every object pointer converts to and from it without a cast, so one
 * spelling serves every brand, and a definition whose true type differs only in the pointed-to
 * struct still links at the ABI level. */

export function externCType(_emitter: Emitter, kind: ExternAbiKind): string {
  switch (kind) {
    case 'value':
      return 'jsrt_value';
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

export function externCReturnType(emitter: Emitter, kind: ExternAbiKind): string {
  return kind === 'cstring' ? 'char *' : emitter.externCType(kind);
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

export function recordExternDecl(emitter: Emitter, expr: ExternCall): void {
  if (expr.error === 'errno') {
    emitter.externErrno = true;
  }
  if (expr.argKinds.some((kind) => kind === 'cstring')) {
    emitter.externStdlib = true;
  }
  if (expr.header !== undefined) {
    if (!emitter.externHeaders.includes(expr.header)) {
      emitter.externHeaders.push(expr.header);
    }
    // Covered means covered however the calls interleave: a headerless call before this one
    // recorded a declaration that must go, and one after must not record a new one — the
    // outcome cannot depend on which file counting visited first.
    emitter.externHeaderCovered.add(expr.cName);
    emitter.externDecls.delete(expr.cName);
    return;
  }
  if (emitter.externHeaderCovered.has(expr.cName) || emitter.externDecls.has(expr.cName)) {
    return;
  }
  const params = expr.argKinds.map((kind) => emitter.externCType(kind)).join(', ');
  const decl =
    `${emitter.externCReturnType(expr.retKind)} ${expr.cName}` +
    `(${expr.argKinds.length === 0 ? 'void' : params});`;
  emitter.externDecls.set(expr.cName, decl);
  // A `cstring` RETURN needs no header: `jsrt_string_from_cstr` is already declared, and the
  // `char *` result travels in a C local, never through a converted expression.
}

/** The layout is the TYPE's field order, because that is what a later `o.x` resolves against
 * (`slotOf` in the lowering indexes `type.fields`). The literal's own key order is a second,
 * independent fact -- enumeration order -- and the two differ whenever the annotation or a
 * spread listed the keys in another order, so the descriptor carries both (plan-notes 181). */
