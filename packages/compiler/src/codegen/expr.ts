/* Expression emission: operators, literals, calls, and chains.
 * Each function takes the emitter as `self`. A call into another family goes
 * through that family's namespace; a call in this file is direct.
 */

import {
  DATE_OPS,
  DATE_STATICS,
  GLOBAL_CALLS,
  NUMBER_OPS,
  REGEXP_FIELDS,
  REGEXP_OPS,
  TYPED_OPS,
  consoleMayThrow,
  errorDescriptor,
  isAccessorEntry,
  isComputedEntry,
  stringOpCanThrow,
  type BinaryOp,
  type ConditionalExpr,
  type Expression,
  type LogicalOp,
  type MethodCopy,
  type OptionalChain,
  type Span,
  type TemplateLiteral,
  type UpdateExpr,
} from '../hir/nodes.ts';
import { hTypeConversionRunsUserCode, type HType } from '../hir/types.ts';
import * as sup from './support.ts';
import type { Emitter } from './emitter.ts';

import * as cgClass from './classes.ts';
import * as cgClosure from './closures.ts';
import * as cgRuntime from './runtime-calls.ts';
import * as cgSeq from './sequence.ts';
import * as cgStmt from './stmt.ts';

export function emitExpression(self: Emitter, expr: Expression): string {
  switch (expr.kind) {
    case 'number-literal': {
      return `jsrt_number(${sup.cDoubleLiteral(expr.value)})`;
    }

    case 'string-literal': {
      return emitStringLiteral(self, expr.value);
    }

    case 'boolean-literal': {
      return `jsrt_bool(${expr.value ? 'true' : 'false'})`;
    }

    case 'null-literal': {
      return 'JSRT_NULL';
    }

    case 'undefined-literal': {
      return 'JSRT_UNDEFINED';
    }

    case 'identifier': {
      return cgSeq.slotRef(self, expr.name);
    }

    case 'binary-op': {
      return emitBinaryOp(self, expr);
    }

    case 'unary-op': {
      const slot = self.tempSlots.get(expr);
      if (slot === undefined) {
        return sup.UNARY_EMITTERS[expr.operator](emitExpression(self, expr.operand));
      }
      const temp = cgSeq.slotAt(self, slot);
      const operand = emitExpression(self, expr.operand);
      cgSeq.appendLine(self, `${temp} = jsrt_number(jsrt_to_number(${operand}));`, expr.span);
      cgSeq.emitPendingCheck(self, expr.span);
      return sup.UNARY_EMITTERS[expr.operator](temp);
    }

    case 'typeof': {
      return `jsrt_typeof(${emitExpression(self, expr.operand)})`;
    }

    // The one expression whose value never reaches its consumer. The call always throws, so the
    // pending check on the very next line always jumps to the landing pad; `JSRT_UNDEFINED` is
    // emitted only because C needs the expression to HAVE a value, and nothing ever reads it.
    // Appending lines here is what makes it correct inside a larger expression: `sequencePart`
    // sees a non-empty buffer and flushes the operands evaluated so far out as a statement first,
    // which keeps the language's evaluation order across the throw.
    case 'reference-error': {
      cgSeq.appendLine(
        self,
        `jsrt_reference_error("${cgSeq.escapeCString(self, expr.name)}");`,
        expr.span,
      );
      cgSeq.emitPendingCheck(self, expr.span);
      return 'JSRT_UNDEFINED';
    }

    case 'type-error': {
      cgSeq.appendLine(
        self,
        `jsrt_throw_error(&jsrt_class_type_error, "${cgSeq.escapeCString(self, expr.message)}");`,
        expr.span,
      );
      cgSeq.emitPendingCheck(self, expr.span);
      return 'JSRT_UNDEFINED';
    }

    // The location is a string literal in the emitted C rather than something reconstructed at
    // failure time: the emitter is the only party that still knows where this value came from,
    // and a check that could not say where it failed would be nearly useless in a compiled
    // binary with no source map at runtime.
    case 'boundary-check': {
      const check = sup.CHECK_FUNCTIONS[expr.type.kind];
      if (check === undefined) {
        throw new Error(`no boundary check for type kind: ${expr.type.kind}`);
      }
      return `${check}(${emitExpression(self, expr.value)}, "${cgSeq.escapeCString(self, expr.where)}")`;
    }

    case 'logical-op': {
      return emitLogicalOp(self, expr);
    }

    case 'conditional': {
      return emitConditional(self, expr);
    }

    case 'optional-chain': {
      return emitOptionalChain(self, expr);
    }

    case 'optional-base': {
      return emitOptionalBase(self);
    }

    case 'update': {
      return emitUpdate(self, expr);
    }

    case 'template-literal': {
      return emitTemplateLiteral(self, expr);
    }

    case 'string-length': {
      return `jsrt_number((double)jsrt_string_length(${emitExpression(self, expr.operand)}))`;
    }

    case 'function-length': {
      return `jsrt_number((double)jsrt_closure_arity(${emitExpression(self, expr.operand)}))`;
    }

    // Every console entry point returns `void` in C, but the call's JS value is `undefined` --
    // the verifier pins the HIR type to it. In VALUE position that gap is a hard error, not a
    // style question: `const r = console.log(x)` emitted `JSRT_LOCAL(0) = jsrt_print(...)` and
    // clang refused the file. The comma supplies the value the type promised. Statement position
    // takes `consoleCall` bare instead, because `(jsrt_print(x), JSRT_UNDEFINED);` is a
    // -Wunused-value warning on every console.log in the program.
    case 'console-log': {
      if (consoleMayThrow(expr)) {
        cgSeq.appendLine(self, `${cgRuntime.consoleCall(self, expr)};`, expr.span);
        cgSeq.emitPendingCheck(self, expr.span);
        return 'JSRT_UNDEFINED';
      }
      return `(${cgRuntime.consoleCall(self, expr)}, JSRT_UNDEFINED)`;
    }

    case 'function': {
      return cgClosure.closureValue(self, expr);
    }

    case 'array-length': {
      const slot = self.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('array length was not registered during counting');
      }
      const result = cgSeq.slotAt(self, slot);
      cgSeq.appendLine(
        self,
        `${result} = jsrt_array_length(${emitExpression(self, expr.operand)});`,
        expr.span,
      );
      cgSeq.emitPendingCheck(self, expr.span);
      return result;
    }

    case 'array-literal': {
      const base = self.arraySlots.get(expr);
      if (base === undefined) {
        throw new Error('array literal was not registered during counting');
      }
      if (expr.elements.length === 0) {
        return 'jsrt_array_new(0, NULL)';
      }
      const parts: string[] = [];
      let flushed = false;
      expr.elements.forEach((element, i) => {
        flushed =
          cgSeq.sequencePart(
            self,
            parts,
            element,
            expr.span,
            (v) => `${cgSeq.slotAt(self, base + i)} = ${v}`,
          ) || flushed;
      });
      const alloc = `jsrt_array_new(${expr.elements.length}, &${cgSeq.slotAt(self, base)})`;
      if (!flushed) {
        parts.push(alloc);
        return `(${parts.join(', ')})`;
      }
      cgSeq.flushParts(self, parts, expr.span);
      return alloc;
    }

    case 'index-access': {
      const base = self.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('index access was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      const index = cgSeq.slotAt(self, base + 1);
      const parts: string[] = [];
      cgSeq.sequencePart(self, parts, expr.target, expr.span, (v) => `${target} = ${v}`);
      cgSeq.sequencePart(self, parts, expr.index, expr.span, (v) => `${index} = ${v}`);
      const read = sup.indexGetCall(expr.target.type, target, index);
      // Both arms land as statements: the dynamic read throws on a nullish receiver, and the
      // static one degrades to it on a statically-typed array that arrives as something else
      // (plan.md §8 step 20). The answer reuses the receiver's slot, which is dead by then --
      // the delete-prop discipline.
      cgSeq.flushParts(self, parts, expr.span);
      cgSeq.appendLine(self, `${target} = ${read};`, expr.span);
      cgSeq.emitPendingCheck(self, expr.span);
      return target;
    }

    case 'delete-prop': {
      const base = self.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('delete was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      const key = cgSeq.slotAt(self, base + 1);
      const parts: string[] = [];
      cgSeq.sequencePart(self, parts, expr.target, expr.span, (v) => `${target} = ${v}`);
      cgSeq.sequencePart(self, parts, expr.key, expr.span, (v) => `${key} = ${v}`);
      cgSeq.flushParts(self, parts, expr.span);
      // The answer lands in the receiver's slot before the pending check, so a delete that threw
      // (a frozen object, a nullish receiver) jumps to the landing pad with nothing half-read.
      cgSeq.appendLine(self, `${target} = jsrt_bool(jsrt_delete(${target}, ${key}));`, expr.span);
      cgSeq.emitPendingCheck(self, expr.span);
      return target;
    }

    case 'call': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('call was not registered during counting');
      }
      // Callee first, then arguments left to right -- the evaluation order the language
      // specifies, each landing in its rooted slot before the next runs. The call itself lands
      // as a STATEMENT, never inside the consumer's expression, so the pending-check can sit
      // between it and whatever consumes the result -- which waits in the callee's slot.
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.callee, expr.args, expr.span, base);
      const argv = expr.args.length === 0 ? 'NULL' : `&${cgSeq.slotAt(self, base + 1)}`;
      const loc = cgRuntime.callLocation(self, expr.span);
      // A spread call's one argument is the folded list (verifier STA4104).
      const call =
        expr.spread === true
          ? `jsrt_call_spread_at(${cgSeq.slotAt(self, base)}, NULL, ${cgSeq.slotAt(self, base + 1)}, ${loc})`
          : `jsrt_call_at(${cgSeq.slotAt(self, base)}, ${expr.args.length}, ${argv}, ${loc})`;
      return cgSeq.finishStatement(
        self,
        parts,
        `${cgSeq.slotAt(self, base)} = ${call}`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    // An extern call: the one arm that never touches `jsrt_value` on the way out. Arguments
    // land in rooted slots first (their own pending checks run before any temporary exists),
    // then straight-line statements do the rest — see `emitExternCall` for the order the
    // string lifetimes and the error conventions depend on.
    case 'extern-call': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('extern call was not registered during counting');
      }
      return cgRuntime.emitExternCall(self, expr, base);
    }

    // A fresh slot answers the pure zero-handle: the cell starts NULL and the callee
    // overwrites it through the `T**` parameter, so creation is one constant store with no
    // target to know and no allocation to root (docs/FFI.md §2).
    case 'out-new': {
      return '(jsrt_value)0';
    }

    // A slot read: a brand is opaque bits in exactly the representation a branded-pointer
    // return travels in, so the operand already IS the answer; a `CString` inner copies
    // the stored `char *` through `from_cstr` exactly like a `cstring` return (including
    // its NULL assert — a NULL read belongs to the error convention guarding the call).
    case 'out-get': {
      const read = emitExpression(self, expr.operand);
      return expr.inner === 'pointer' ? read : `jsrt_string_from_cstr((char *)jsrt_ptr(${read}))`;
    }

    case 'field-access': {
      return `jsrt_object_get_field(${emitExpression(self, expr.target)}, ${expr.slot}, ${sup.cNameLiteral(expr.field)})`;
    }

    case 'iterator-next': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('iterator-next was not registered during counting');
      }
      const parts: string[] = [];
      cgSeq.sequencePart(
        self,
        parts,
        expr.target,
        expr.span,
        (v) => `${cgSeq.slotAt(self, base)} = ${v}`,
      );
      cgSeq.sequencePart(
        self,
        parts,
        expr.sent,
        expr.span,
        (v) => `${cgSeq.slotAt(self, base + 1)} = ${v}`,
      );
      cgSeq.flushParts(self, parts, expr.span);
      // A generator's next() can throw: the resume left the exception pending. Specialized
      // iterators never do, and the same check is then a no-op. `return`/`throw` reach only a
      // generator (the gate refuses them on a boxed specialized iterator), and their uncaught
      // throw takes the same pending path.
      const step =
        expr.op === 'next'
          ? 'jsrt_iterator_next'
          : expr.op === 'return'
            ? 'jsrt_generator_close'
            : 'jsrt_generator_throw';
      cgSeq.appendLine(
        self,
        `${cgSeq.slotAt(self, base)} = ${step}(${cgSeq.slotAt(self, base)}, ${cgSeq.slotAt(self, base + 1)});`,
        expr.span,
      );
      cgSeq.emitPendingCheck(self, expr.span);
      return cgSeq.slotAt(self, base);
    }

    // Dynamic GetIterator dispatch (plan.md §8 step 2a(c)): the operand stays rooted in its
    // own slot across the call, which boxes collections and runs the resolved
    // `__@iterator` method -- both of which allocate -- and a non-iterable leaves the
    // catchable TypeError pending for the check below, exactly like a dynamic property read.
    case 'get-iterator': {
      const slot = self.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('get-iterator was not registered during counting');
      }
      const result = cgSeq.slotAt(self, slot);
      cgSeq.appendLine(self, `${result} = ${emitExpression(self, expr.target)};`, expr.span);
      cgSeq.appendLine(self, `${result} = jsrt_get_iterator(${result});`, expr.span);
      cgSeq.emitPendingCheck(self, expr.span);
      return result;
    }

    // The site's cache is a static JSRTIC: a hit is one pointer compare and one load, a miss
    // walks the shape chain and refills it (docs/VALUE.md §4.10). A getter or nullish receiver
    // can throw: root the result and unwind before any consumer or later operand executes.
    case 'dyn-field-access': {
      const slot = self.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('dynamic property read was not registered during counting');
      }
      const result = cgSeq.slotAt(self, slot);
      cgSeq.appendLine(self, `${result} = ${emitExpression(self, expr.target)};`, expr.span);
      cgSeq.appendLine(
        self,
        `${result} = jsrt_get_prop(${result}, ${sup.cNameLiteral(expr.field)}, &${cgRuntime.icSite(self)});`,
        expr.span,
      );
      cgSeq.emitPendingCheck(self, expr.span);
      return result;
    }

    // `index`, `input` and `groups` are PROPERTIES of the match array, so they read through the
    // same shape chain and the same per-site cache any dynamic property does. `length` is not:
    // it is the array header's own field, and reading it through the table would answer
    // `undefined`. A receiver that is not a match panics inside the runtime either way.
    case 'match-read': {
      const target = emitExpression(self, expr.target);
      return expr.field === 'length'
        ? `jsrt_array_length(${target})`
        : `jsrt_get_prop(${target}, ${sup.cNameLiteral(expr.field)}, &${cgRuntime.icSite(self)})`;
    }

    // Eleven reads off the compiled struct, none of them allocating and none of them a property
    // in the shape-table sense: `source` and `flags` are the strings the runtime normalized at
    // construction, `lastIndex` is a header field, and the eight predicates are one bit test
    // each -- passed the flag's LETTER, because the LRE_FLAG_* constants belong to the vendored
    // engine's header and generated C does not include it.
    case 'regexp-read': {
      const target = emitExpression(self, expr.target);
      const spec = REGEXP_FIELDS[expr.field];
      return 'flag' in spec
        ? `jsrt_bool(jsrt_regexp_flag(${target}, '${spec.flag}'))`
        : `jsrt_regexp_${sup.snakeCase(expr.field)}(${target})`;
    }

    case 'new': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('new was not registered during counting');
      }
      const cls = cgClass.classAt(self, expr.className);
      const object = cgSeq.slotAt(self, base);
      // The object is created first and lands in the slot the constructor will receive as
      // argument zero, so it is rooted before any argument -- which may allocate -- is
      // evaluated. The whole expression yields that slot, not the constructor's return value:
      // `new` in JavaScript ignores what a constructor returns unless it returns an object,
      // and this subset's constructors cannot return one.
      const parts = [
        `${object} = jsrt_object_new(&_jsrt_class_${String(self.classIds.get(expr.className))})`,
      ];
      cgSeq.sequenceArgs(self, parts, expr.args, expr.span, base, 1);
      if (cls.ctor === undefined) {
        cgSeq.flushParts(self, parts, expr.span);
        return object;
      }
      return cgSeq.finishStatement(
        self,
        parts,
        `jsrt_call(${cgClosure.closureValue(self, cls.ctor.fn)}, ${1 + expr.args.length}, &${object})`,
        object,
        expr.span,
      );
    }

    case 'method-value': {
      // Virtual: the receiver picks the entry. Direct: the named closure is the value, but
      // the receiver expression still runs -- `new C().m` must construct C even though the
      // extracted function does not capture it.
      if (expr.dispatch === 'virtual') {
        return `jsrt_method(${emitExpression(self, expr.target)}, ${expr.slot})`;
      }
      const callee = cgClosure.closureValue(self, cgClass.methodOf(self, expr).fn);
      const captured = cgSeq.capture(self, () => emitExpression(self, expr.target));
      if (captured.lines.length === 0) {
        return `(${captured.value}, ${callee})`;
      }
      self.lines.push(...captured.lines);
      return callee;
    }

    case 'method-call': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('method call was not registered during counting');
      }
      // Receiver first, then arguments left to right -- the same order and the same contiguous
      // argv as a plain call, with the receiver where the callee slot would be.
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.target, expr.args, expr.span, base);
      // A direct call names the function; a virtual one loads the entry the RECEIVER's own class
      // holds at this slot. The receiver is already in its slot, so the load reads the value the
      // call is about to pass, not a second evaluation of the target expression.
      const callee =
        expr.dispatch === 'virtual'
          ? `jsrt_method(${cgSeq.slotAt(self, base)}, ${expr.slot})`
          : cgClass.methodCallee(self, expr, cgSeq.slotAt(self, base));
      return cgSeq.finishStatement(
        self,
        parts,
        `${cgSeq.slotAt(self, base)} = jsrt_call(${callee}, ${1 + expr.args.length}, &${cgSeq.slotAt(self, base)})`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    // A method call through the shape table: the receiver evaluates into the base slot,
    // the arguments contiguously after it, and the loaded method lands past them, keeping the
    // receiver-plus-arguments run contiguous for both call shapes below. One load through the
    // site's own cache (`jsrt_get_prop` -- which may run a getter, hence the pending check
    // before the call), then the call passes the receiver as argument zero when -- and only
    // when -- the loaded closure declares one (`has_receiver`, docs/VALUE.md §4.16). A
    // non-function callee panics exactly as an ordinary `call` does (`STA2006` with the site's
    // `file:line`).
    // A field call is the same call with the callee loaded from its slot rather than through
    // the shape table: a slot load cannot throw, so no pending check follows it.
    case 'dyn-method-call':
    case 'field-call': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} was not registered during counting`);
      }
      const method = cgSeq.slotAt(self, base + 1 + expr.args.length);
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.target, expr.args, expr.span, base);
      parts.push(
        expr.kind === 'field-call'
          ? `${method} = jsrt_object_get_field(${cgSeq.slotAt(self, base)}, ${expr.slot}, ${sup.cNameLiteral(expr.field)})`
          : `${method} = jsrt_get_prop(${cgSeq.slotAt(self, base)}, ${sup.cNameLiteral(expr.method)}, &${cgRuntime.icSite(self)})`,
      );
      cgSeq.flushParts(self, parts, expr.span);
      if (expr.kind === 'dyn-method-call') {
        cgSeq.emitPendingCheck(self, expr.span);
        if (expr.notFunction !== undefined) {
          cgSeq.appendLine(
            self,
            `if (!jsrt_is(${method}, JSRT_TAG_CLOSURE)) { jsrt_throw_error(&jsrt_class_type_error, "${cgSeq.escapeCString(self, `${expr.notFunction} is not a function`)}"); }`,
            expr.span,
          );
          cgSeq.emitPendingCheck(self, expr.span);
        }
      }
      const argv = expr.args.length === 0 ? 'NULL' : `&${cgSeq.slotAt(self, base + 1)}`;
      const loc = cgRuntime.callLocation(self, expr.span);
      if (expr.kind === 'dyn-method-call' && expr.spread === true) {
        return cgSeq.finishStatement(
          self,
          [],
          `${cgSeq.slotAt(self, base)} = jsrt_call_spread_at(${method}, &${cgSeq.slotAt(self, base)}, ${cgSeq.slotAt(self, base + 1)}, ${loc})`,
          cgSeq.slotAt(self, base),
          expr.span,
        );
      }
      const withReceiver = `jsrt_call_at(${method}, ${String(1 + expr.args.length)}, &${cgSeq.slotAt(self, base)}, ${loc})`;
      const withoutReceiver = `jsrt_call_at(${method}, ${String(expr.args.length)}, ${argv}, ${loc})`;
      return cgSeq.finishStatement(
        self,
        [],
        `${cgSeq.slotAt(self, base)} = (jsrt_is(${method}, JSRT_TAG_CLOSURE) && jsrt_as_closure(${method})->has_receiver) ? ${withReceiver} : ${withoutReceiver}`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    // Allocate, then fill left to right. The object is in its own rooted slot first, so an entry
    // that allocates cannot collect the object it is being stored into. A spread with a
    // non-trivial source runs once into its scratch slot at its own position in this order,
    // and every field reads out of that (`spreadScratches`); anything else evaluates inline.
    case 'object-literal': {
      const slot = self.callSlots.get(expr);
      if (slot === undefined) {
        throw new Error('object literal was not registered during counting');
      }
      const layout = sup.shapeFieldsOf(expr);
      const order = sup.keyOrderOf(expr, layout);
      const name = `${sup.shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
      const id = String(self.classIds.get(name));
      const scratches = sup.spreadScratches(expr.entries, expr.methodCopies);
      const scratchAt = new Map(scratches.map(({ key }, index) => [key, slot + 1 + index]));
      const scratchTarget = new Map(scratches.map(({ key, target }) => [key, target]));
      const scratchDone = new Set<string>();
      // A spread copies the right values but bakes the TYPE's field order into the result, so
      // a literal that spreads repairs its enumeration order at run time (plan.md §8 step 21a).
      // Literals without a spread keep the compile-time descriptor untouched below.
      const needsOrder = layout.length > 0 && expr.entries.some((entry) => entry.spread === true);
      // Snapshot slots for identifier-fragment sources (`spreadSnapshots`, past the scratch
      // slots): the repair runs after every value -- past any suspension, where the C frame
      // is gone and a later entry may have reassigned the binding -- so each source is
      // retained at its own fragment's position here in the walk instead.
      const snaps = sup.spreadSnapshots(expr.entries);
      const snapAt = new Map(
        snaps.map(({ key }, index) => [key, slot + 1 + scratches.length + index]),
      );
      const snapTarget = new Map(snaps.map(({ key, target }) => [key, target]));
      const snapDone = new Set<string>();
      const orderId = self.spreadOrderCount;
      if (needsOrder) {
        self.spreadOrderCount++;
      }
      const parts = [`${cgSeq.slotAt(self, slot)} = jsrt_object_new(&_jsrt_class_${id})`];
      let flushed = false;
      const resolveSpread = (key: string) =>
        cgSeq.spreadSource(
          self,
          parts,
          key,
          scratchAt,
          scratchTarget,
          scratchDone,
          expr.span,
          flushed,
        );
      // Hidden-slot indices by method name, in the TYPE's method order -- the same order
      // `registerShape` laid out, so every literal of one shape agrees however its own and
      // copied members interleave.
      const hiddenAt = new Map(
        (expr.type.kind === 'object' ? expr.type.methods : []).map((method, index) => [
          method.name,
          layout.length + index,
        ]),
      );
      // Spread method copies grouped by the entry index their fragment starts at, in source
      // order within a group: the emitter stores each group at its fragment's own position
      // in the walk below, so a non-trivial source evaluates once at that position and an
      // identifier source reads the fragment-time binding even when a later entry reassigns
      // it (`{ ...b, y: (b = c) }`).
      const copiesAt = new Map<number, MethodCopy[]>();
      for (const copy of expr.methodCopies) {
        const group = copiesAt.get(copy.at);
        if (group === undefined) {
          copiesAt.set(copy.at, [copy]);
        } else {
          group.push(copy);
        }
      }
      // One spread method copy: the source's bound closure out of its hidden slot into the
      // result's. The source renders through the fragment's scratch when it has one --
      // shared with the field reads through `scratchDone`, so one evaluation serves both --
      // and inline when the source is a bare identifier, which is side-effect-free.
      const emitCopy = (copy: MethodCopy): void => {
        if (copy.value.kind !== 'method-value') {
          throw new Error('spread method copy is not a method read');
        }
        const dst = hiddenAt.get(copy.name);
        if (dst === undefined) {
          throw new Error(`spread method ${copy.name} is not in its own shape`);
        }
        const receiver = copy.value.target;
        const receiverType = receiver.type;
        if (receiverType.kind !== 'object') {
          throw new Error(`spread method ${copy.name} has no source shape`);
        }
        const methodIndex = receiverType.methods.findIndex((method) => method.name === copy.name);
        if (methodIndex < 0) {
          throw new Error(`spread method ${copy.name} is not in its source shape`);
        }
        const src = receiverType.fields.length + methodIndex;
        let from: string;
        if (receiver.kind === 'identifier') {
          const rendered = cgSeq.capture(self, () => emitExpression(self, receiver));
          if (rendered.lines.length > 0) {
            throw new Error('spread copy source produced statements');
          }
          from = rendered.value;
        } else {
          const key = sup.spreadScratchKey(copy.value.span);
          const resolved = resolveSpread(key);
          flushed = resolved.flushed;
          if (resolved.slot === null) {
            throw new Error('spread copy source has no slot');
          }
          from = resolved.slot;
        }
        parts.push(
          `jsrt_object_set(${cgSeq.slotAt(self, slot)}, ${String(dst)}, jsrt_object_get_field(${from}, ${String(src)}, ${sup.cNameLiteral(copy.name)}))`,
        );
      };
      // Source order is the EVALUATION order (§13.2.5.5 runs the initializers left to right);
      // the slot each value lands in comes from the layout, which need not agree.
      for (let index = 0; index < expr.entries.length; index++) {
        for (const copy of copiesAt.get(index) ?? []) {
          emitCopy(copy);
        }
        const entry = expr.entries[index];
        if (entry === undefined) {
          throw new Error('object literal entry vanished during emission');
        }
        const target = layout.findIndex((field) => field.name === entry.name);
        if (target < 0) {
          throw new Error(`object literal key ${entry.name} is not in its own shape`);
        }
        // An identifier spread source is snapshotted at its fragment's position: the value
        // walk below re-reads the binding per field (correct under reassignment), but the
        // repair runs last and must see the fragment's own value. The store is pure, so it
        // joins the sequence at exactly this position however the parts flush around it.
        if (
          needsOrder &&
          entry.spread === true &&
          entry.value.kind === 'field-access' &&
          entry.value.target.kind === 'identifier'
        ) {
          const key = sup.spreadScratchKey(entry.value.span);
          if (!snapDone.has(key)) {
            snapDone.add(key);
            const snap = snapAt.get(key);
            const source = snapTarget.get(key);
            if (snap === undefined || source === undefined) {
              throw new Error('spread snapshot has no slot');
            }
            const rendered = cgSeq.capture(self, () => emitExpression(self, source));
            if (rendered.lines.length > 0) {
              throw new Error('spread snapshot source produced statements');
            }
            parts.push(`${cgSeq.slotAt(self, snap)} = ${rendered.value}`);
          }
        }
        if (entry.value.kind === 'field-access' && entry.value.target.kind !== 'identifier') {
          const key = sup.spreadScratchKey(entry.value.span);
          const resolved = resolveSpread(key);
          flushed = resolved.flushed;
          if (resolved.slot !== null) {
            parts.push(
              `jsrt_object_set(${cgSeq.slotAt(self, slot)}, ${String(target)}, jsrt_object_get_field(${resolved.slot}, ${String(entry.value.slot)}, ${sup.cNameLiteral(entry.name)}))`,
            );
            continue;
          }
        }
        flushed =
          cgSeq.sequencePart(
            self,
            parts,
            entry.value,
            expr.span,
            (v) => `jsrt_object_set(${cgSeq.slotAt(self, slot)}, ${String(target)}, ${v})`,
          ) || flushed;
      }
      for (const copy of copiesAt.get(expr.entries.length) ?? []) {
        emitCopy(copy);
      }
      // A literal's methods are bound HERE, over the definition environment (plan.md §8 step 36):
      // each evaluation stores its own closures into the hidden trailing slots, which is what
      // makes two `counter()` calls read two different `n`s. A method that captures nothing
      // stores the shared constant -- the same value every instance would load -- so identity
      // (`o.m === o.m`) is unchanged. `closureValue` is pure, so joining `parts` is exact, and
      // the object is already in its rooted slot, so the fresh closures cannot collect it.
      // Spread copies were already stored at their fragments' positions above; what remains
      // here are the own members, which the lowering kept only when no later writer -- a
      // spread, or another own member -- overwrites them, so this last write wins outright.
      expr.methods.forEach((method) => {
        const dst = hiddenAt.get(method.name);
        if (dst === undefined) {
          throw new Error(`object literal method ${method.name} is not in its own shape`);
        }
        parts.push(
          `jsrt_object_set(${cgSeq.slotAt(self, slot)}, ${String(dst)}, ${cgClosure.closureValue(self, method.fn)})`,
        );
      });
      if (needsOrder) {
        // The repair runs after every value, as statements: the declaration opens here -- past
        // any suspension, so no park can strand it indeterminate (plan.md §8 step 15) -- and
        // every contribution reads a rooted slot (a scratch, a snapshot, or nothing at all for
        // an own key), in fragment order. Forcing the statement form is what makes that true.
        cgSeq.flushParts(self, parts, expr.span);
        cgSeq.appendLine(
          self,
          `uint32_t _jsrt_order_${orderId}[${String(layout.length)}];`,
          expr.span,
        );
        cgSeq.appendLine(self, `uint32_t _jsrt_ordn_${orderId} = 0;`, expr.span);
        const orderSeen = new Set<string>();
        for (const entry of expr.entries) {
          if (entry.spread === true) {
            if (entry.value.kind !== 'field-access') {
              throw new Error('spread order entry is not a field read');
            }
            const key = sup.spreadScratchKey(entry.value.span);
            if (!orderSeen.has(key)) {
              orderSeen.add(key);
              const scratch = scratchAt.get(key);
              const snap = snapAt.get(key);
              const src =
                scratch !== undefined
                  ? cgSeq.slotAt(self, scratch)
                  : snap !== undefined
                    ? cgSeq.slotAt(self, snap)
                    : null;
              if (src === null) {
                throw new Error('spread order source has no slot');
              }
              cgSeq.appendLine(
                self,
                `jsrt_spread_order_src(_jsrt_order_${orderId}, &_jsrt_ordn_${orderId}, ${String(layout.length)}, ${cgSeq.slotAt(self, slot)}, ${src});`,
                expr.span,
              );
            }
          } else {
            const dst = layout.findIndex((field) => field.name === entry.name);
            if (dst < 0) {
              throw new Error(`object literal key ${entry.name} is not in its own shape`);
            }
            cgSeq.appendLine(
              self,
              `jsrt_spread_order_key(_jsrt_order_${orderId}, &_jsrt_ordn_${orderId}, ${String(layout.length)}, ${String(dst)});`,
              expr.span,
            );
          }
        }
        // The values are right; only the descriptor's key order is the type's instead of the
        // object's. Stamp the repaired order and keep the answer in its slot for the consumer.
        cgSeq.appendLine(
          self,
          `${cgSeq.slotAt(self, slot)} = jsrt_object_set_order(${cgSeq.slotAt(self, slot)}, _jsrt_order_${orderId}, _jsrt_ordn_${orderId});`,
          expr.span,
        );
        return cgSeq.slotAt(self, slot);
      }
      return cgSeq.finishSequenced(self, parts, cgSeq.slotAt(self, slot), expr.span, flushed);
    }

    // Allocate, then fill left to right through the rooted scratch slot. No inline cache on
    // construction: each entry is a fresh key on a fresh object, so every store transitions --
    // exactly the case the cache deliberately does not serve (docs/VALUE.md §4.10). A spread
    // with a non-trivial source runs once into its own scratch past the value scratch, like the
    // fixed arm's, and the whole fragment copies out of that in one call.
    case 'dyn-object-literal': {
      const slot = self.callSlots.get(expr);
      if (slot === undefined) {
        throw new Error('dynamic object literal was not registered during counting');
      }
      const scratch = cgSeq.slotAt(self, slot + 1);
      const scratches = sup.spreadScratches(expr.entries);
      const base = slot + sup.dynLiteralBaseSlots(expr);
      const scratchAt = new Map(scratches.map(({ key }, index) => [key, base + index]));
      const scratchTarget = new Map(scratches.map(({ key, target }) => [key, target]));
      const scratchDone = new Set<string>();
      const parts = [`${cgSeq.slotAt(self, slot)} = jsrt_dynobj_new()`];
      let flushed = false;
      for (const entry of expr.entries) {
        // An accessor installs the pair instead of storing a value, and it must not go through
        // jsrt_set_prop: on a key that already holds an accessor that would CALL the setter
        // rather than replace it (docs/VALUE.md §4.15). A missing half is JSRT_UNDEFINED, which
        // is what makes a get-only property read-only and a set-only one read `undefined`.
        if (isAccessorEntry(entry)) {
          // Scratches are handed out per HALF and restart at each entry, so a one-sided accessor
          // uses the same slot an ordinary value would and the second is reserved only for the
          // literal that actually writes a pair.
          let next = slot + 1;
          const half = (fn: Expression | undefined): string => {
            if (fn === undefined) {
              return 'JSRT_UNDEFINED';
            }
            const into = cgSeq.slotAt(self, next);
            next += 1;
            flushed =
              cgSeq.sequencePart(self, parts, fn, expr.span, (v) => `${into} = ${v}`) || flushed;
            return into;
          };
          const get = half(entry.get);
          const set = half(entry.set);
          parts.push(
            `jsrt_define_accessor(${cgSeq.slotAt(self, slot)}, ${sup.cNameLiteral(entry.name)}, ${get}, ${set})`,
          );
          continue;
        }
        if (isComputedEntry(entry)) {
          const keyScratch = cgSeq.slotAt(self, slot + 1);
          const valueScratch = cgSeq.slotAt(self, slot + 2);
          flushed =
            cgSeq.sequencePart(self, parts, entry.key, expr.span, (v) => `${keyScratch} = ${v}`) ||
            flushed;
          flushed =
            cgSeq.sequencePart(
              self,
              parts,
              entry.value,
              expr.span,
              (v) => `${valueScratch} = ${v}`,
            ) || flushed;
          parts.push(
            `jsrt_dyn_index_set(${cgSeq.slotAt(self, slot)}, ${keyScratch}, ${valueScratch}, NULL)`,
          );
          continue;
        }
        // `{ __proto__: v }` is the prototype setter, not an own data property (plan.md §8
        // step 33): the value evaluates in written position for its effects and nothing is
        // stored, so the shape table never gains the key and every enumeration agrees with
        // Node. Installing an object or null prototype would need a [[Prototype]] slot
        // neither layout has -- that is Phase 8's prototype surface -- and own-only reads
        // cannot observe one either way.
        if (entry.protoSetter === true) {
          flushed =
            cgSeq.sequencePart(self, parts, entry.value, expr.span, (v) => `${scratch} = ${v}`) ||
            flushed;
          continue;
        }
        // A spread fragment copies its whole source in the SOURCE's enumeration order, in one
        // call at the fragment's position (plan.md §8 step 21a): insertion order IS enumeration
        // order on a fresh shape table, so the fragment's keys land as the object has them, not
        // as the type lists them. Only the fragment's FIRST entry emits the call; the rest of
        // its entries are already copied and emit nothing. An identifier source reads inline at
        // its position (still correct when a later entry reassigns the binding); anything else
        // ran once into its scratch above, exactly like the fixed arm's.
        if (!isAccessorEntry(entry) && !isComputedEntry(entry) && entry.spread === true) {
          if (entry.value.kind !== 'field-access') {
            throw new Error('spread entry is not a field read');
          }
          const key = sup.spreadScratchKey(entry.value.span);
          if (!scratchDone.has(key)) {
            scratchDone.add(key);
            const scratchSlot = scratchAt.get(key);
            if (scratchSlot !== undefined) {
              const source = scratchTarget.get(key);
              if (source === undefined) {
                throw new Error('spread source has no scratch target');
              }
              flushed =
                cgSeq.sequencePart(
                  self,
                  parts,
                  source,
                  expr.span,
                  (v) => `${cgSeq.slotAt(self, scratchSlot)} = ${v}`,
                ) || flushed;
              parts.push(
                `${cgSeq.slotAt(self, slot)} = jsrt_dynobj_spread(${cgSeq.slotAt(self, slot)}, ${cgSeq.slotAt(self, scratchSlot)})`,
              );
            } else {
              if (entry.value.target.kind !== 'identifier') {
                throw new Error('spread source has no scratch slot');
              }
              const inlineSource = entry.value.target;
              const rendered = cgSeq.capture(self, () => emitExpression(self, inlineSource));
              if (rendered.lines.length > 0) {
                throw new Error('spread source produced statements');
              }
              parts.push(
                `${cgSeq.slotAt(self, slot)} = jsrt_dynobj_spread(${cgSeq.slotAt(self, slot)}, ${rendered.value})`,
              );
            }
          }
          continue;
        }
        flushed =
          cgSeq.sequencePart(self, parts, entry.value, expr.span, (v) => `${scratch} = ${v}`) ||
          flushed;
        parts.push(
          `jsrt_set_prop(${cgSeq.slotAt(self, slot)}, ${sup.cNameLiteral(entry.name)}, ${scratch}, NULL)`,
        );
      }
      return cgSeq.finishSequenced(self, parts, cgSeq.slotAt(self, slot), expr.span, flushed);
    }

    case 'collection-new':
      return expr.weak
        ? `jsrt_weak_collection_new(${expr.collection === 'map' ? 'true' : 'false'})`
        : `jsrt_${expr.collection}_new()`;

    // Compiled at EVERY evaluation, never hoisted: §22.2.4.1 makes each evaluation a fresh
    // object, and it has to be, because `lastIndex` is mutable state on it. The pattern rides in
    // its slot so it survives the flag string's allocation.
    case 'regexp-literal': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('regexp literal was not registered during counting');
      }
      const source = `${cgSeq.slotAt(self, base)} = ${emitStringLiteral(self, expr.source)}`;
      return `(${source}, jsrt_regexp_new(${cgSeq.slotAt(self, base)}, ${emitStringLiteral(self, expr.flags)}))`;
    }

    // A single-operand runtime walk: the argument rides in its rooted slot across the call.
    case 'date-new':
    case 'error-new':
    case 'json-parse':
    case 'json-stringify':
    case 'promise-static': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} call was not registered during counting`);
      }
      const parts: string[] = [];
      const flushed = cgSeq.sequencePart(
        self,
        parts,
        expr.arg,
        expr.span,
        (v) => `${cgSeq.slotAt(self, base)} = ${v}`,
      );
      if (expr.kind === 'promise-static') {
        self.usedAsync = true;
      }
      // One C function covers all three `new Date(x)` argument forms -- number, string and
      // Date -- because the discrimination is a tag test the runtime already has to make.
      const runtimeCall =
        expr.kind === 'promise-static'
          ? `jsrt_promise_${expr.method}`
          : expr.kind === 'date-new'
            ? 'jsrt_date_from_value'
            : expr.kind === 'error-new'
              ? 'jsrt_error_new'
              : `jsrt_json_${expr.kind === 'json-parse' ? 'parse' : 'stringify'}`;
      // The only one of these that names a DESCRIPTOR as well as its operand: the error class is
      // a runtime constant, not an emitted one, so it rides in front of the rooted slot.
      const leading = expr.kind === 'error-new' ? `&${errorDescriptor(expr.ctor)}, ` : '';
      const opCall = `${runtimeCall}(${leading}${cgSeq.slotAt(self, base)})`;
      return cgSeq.finishOp(
        self,
        parts,
        base,
        opCall,
        expr.span,
        flushed,
        expr.kind === 'json-stringify',
      );
    }

    case 'promise-construct': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('promise-construct was not registered during counting');
      }
      self.usedAsync = true;
      const parts: string[] = [];
      cgSeq.sequencePart(
        self,
        parts,
        expr.executor,
        expr.span,
        (v) => `${cgSeq.slotAt(self, base)} = ${v}`,
      );
      return cgSeq.finishStatement(
        self,
        parts,
        `${cgSeq.slotAt(self, base)} = jsrt_promise_construct(${cgSeq.slotAt(self, base)})`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    case 'promise-method': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('promise-method was not registered during counting');
      }
      self.usedAsync = true;
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.target, expr.args, expr.span, base);
      const fn =
        expr.method === 'then'
          ? 'jsrt_promise_then'
          : expr.method === 'catch'
            ? 'jsrt_promise_catch'
            : 'jsrt_promise_finally';
      const operands = [
        cgSeq.slotAt(self, base),
        ...expr.args.map((_, index) => cgSeq.slotAt(self, base + 1 + index)),
      ].join(', ');
      // No pending check: subscribing a reaction neither runs user code nor fails, so nothing
      // can be pending here -- unlike construction, whose executor runs synchronously.
      parts.push(`${cgSeq.slotAt(self, base)} = ${fn}(${operands})`);
      cgSeq.flushParts(self, parts, expr.span);
      return cgSeq.slotAt(self, base);
    }

    // One runtime function per operation, receiver and arguments riding in rooted slots. The
    // collection ops name their C function through a table (there is no descriptor to index --
    // these calls are direct in a way even a non-overridden method is not); string and array
    // ops derive it mechanically, camelCase op to snake_case suffix (charCodeAt ->
    // jsrt_string_char_code_at, indexOf -> jsrt_array_index_of).
    case 'collection-op':
    case 'array-op':
    case 'date-op':
    case 'number-op':
    case 'regexp-op':
    case 'string-op': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} was not registered during counting`);
      }
      const parts: string[] = [];
      let flushed = cgSeq.sequencePart(
        self,
        parts,
        expr.target,
        expr.span,
        (v) => `${cgSeq.slotAt(self, base)} = ${v}`,
      );
      flushed = cgSeq.sequenceArgs(self, parts, expr.args, expr.span, base, 1) || flushed;
      // `concat` is the receiver-plus-argument form of `+`, and its argument is an arbitrary
      // value: `''.concat(42)` is "42" because §22.1.3.4 runs ToString on each argument, while
      // `jsrt_string_concat` is the PRIMITIVE and asserts both sides are strings -- so the
      // conversion belongs here, exactly as it does for a template literal's holes. Without it
      // the assertion fired on `''.concat(true)` and on every other non-string argument
      // (plan-notes 222). One argument, so one coercion; the receiver of a method call is
      // already a string.
      const coercingConcat = expr.kind === 'string-op' && expr.op === 'concat';
      const operands = [
        cgSeq.slotAt(self, base),
        ...expr.args.map((_, index) =>
          coercingConcat
            ? `jsrt_to_string(${cgSeq.slotAt(self, base + 1 + index)})`
            : cgSeq.slotAt(self, base + 1 + index),
        ),
      ].join(', ');
      // A date op names its C function from the table rather than deriving it: snakeCase would
      // turn `getUTCFullYear` into `get_u_t_c_full_year`.
      const boxed =
        expr.kind === 'array-op' || expr.kind === 'collection-op'
          ? sup.iteratorBoxCall(expr, operands)
          : undefined;
      const opCall =
        boxed !== undefined
          ? boxed
          : expr.kind === 'collection-op'
            ? sup.collectionCall(expr.op, expr.collection, operands)
            : expr.kind === 'date-op'
              ? `${DATE_OPS[expr.op].fn}(${operands})`
              : expr.kind === 'number-op'
                ? `${NUMBER_OPS[expr.op].fn}(${operands})`
                : expr.kind === 'regexp-op'
                  ? // `test` is the one op that answers a C bool rather than a jsrt_value -- the engine
                    // has no notion of our values, so the boxing is the bridge's job (jsrt_regexp.c).
                    // `exec` already answers a value: the match array, or null.
                    REGEXP_OPS[expr.op].result === 'boolean'
                    ? `jsrt_bool(jsrt_regexp_${sup.snakeCase(expr.op)}(${operands}))`
                    : `jsrt_regexp_${sup.snakeCase(expr.op)}(${operands})`
                  : expr.kind === 'array-op'
                    ? cgRuntime.arrayOpCall(self, expr, base)
                    : `jsrt_string_${sup.snakeCase(expr.op)}(${operands})`;
      // An op that calls back into compiled code can throw, so it gets its own STATEMENT and a
      // pending check -- the same discipline `call` follows, and for the same reason: the check
      // has to sit between the op and whatever consumes its result, which a comma expression
      // gives it nowhere to stand. The receiver's slot takes the answer; it is dead by then.
      // Every array op takes the statement tail, callback-taking or not: each entry validates
      // its receiver first (STA2008, plan.md §8 step 20), so a statically-typed array that
      // arrives as `undefined` throws a catchable TypeError instead of segfaulting.
      const canThrow =
        expr.kind === 'array-op' ||
        (expr.kind === 'collection-op' && expr.op === 'forEach') ||
        (expr.kind === 'collection-op' && sup.mayRefuseWeakKey(expr)) ||
        (expr.kind === 'date-op' && expr.op === 'toISOString') ||
        expr.kind === 'number-op' ||
        (expr.kind === 'string-op' && stringOpCanThrow(expr.op)) ||
        // ToString/ToNumber of an argument that may be an object runs its own
        // `toString`/`valueOf` (plan.md §9 Task 6.27); a collection keeps its values as they are.
        (expr.kind !== 'collection-op' && sup.argsConvert(expr.args));
      return cgSeq.finishOp(self, parts, base, opCall, expr.span, flushed, canThrow);
    }

    // One runtime function per method, number -> number. The single-argument form nests
    // directly; the binary form sequences its arguments through slots because C would otherwise
    // pick the order (`Math.pow(f(), g())` must run f first).
    case 'date-components':
    case 'date-static':
    case 'global-call':
    case 'math-call':
    case 'object-static':
    case 'typed-op': {
      const name =
        expr.kind === 'math-call'
          ? `jsrt_math_${expr.method}`
          : expr.kind === 'date-components'
            ? 'jsrt_date_from_components'
            : expr.kind === 'date-static'
              ? DATE_STATICS[expr.method].fn
              : expr.kind === 'global-call'
                ? GLOBAL_CALLS[expr.name].fn
                : expr.kind === 'typed-op'
                  ? TYPED_OPS[expr.op].fn
                  : `jsrt_object_${sup.snakeCase(expr.method)}`;
      // Math takes immediates, so a lone argument has neither an order to fix nor anything to
      // keep rooted and nests directly. An Object walk always uses its slots (see counting).
      if (expr.kind === 'math-call' && self.callSlots.get(expr) === undefined) {
        const operands = expr.args.map((arg) => emitExpression(self, arg)).join(', ');
        return `${name}(${operands})`;
      }
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} was not registered during counting`);
      }
      const parts: string[] = [];
      const flushed = cgSeq.sequenceArgs(self, parts, expr.args, expr.span, base, 0);
      const operands = expr.args.map((_, index) => cgSeq.slotAt(self, base + index)).join(', ');
      const opCall = `${name}(${operands})`;
      // Every typed op can throw: a RangeError for a length or bound, or the TypeError a lying
      // receiver gets (golden rule 4) -- so each one is a statement with its pending check.
      return cgSeq.finishOp(
        self,
        parts,
        base,
        opCall,
        expr.span,
        flushed,
        expr.kind === 'object-static' ||
          expr.kind === 'typed-op' ||
          (expr.kind === 'global-call' && GLOBAL_CALLS[expr.name].throws) ||
          sup.argsConvert(expr.args),
      );
    }

    // `String.fromCharCode(...codes)` (plan.md §8 step 19): the one `String` namespace call.
    // The runtime takes the count first, then the codes, and coerces each one — so the call
    // is `from_char_code(n, ...)` with `n` spliced in, on the math-call sequencing discipline:
    // up to one argument nests directly, more ride rooted slots in source order. It cannot
    // throw (allocation failure panics, it does not leave a pending exception), so the
    // sequenced tail serves and no statement is needed.
    case 'string-static': {
      const name = 'jsrt_string_from_char_code';
      if (self.callSlots.get(expr) === undefined) {
        const operands = expr.args.map((arg) => emitExpression(self, arg)).join(', ');
        return operands === '' ? `${name}(0)` : `${name}(${String(expr.args.length)}, ${operands})`;
      }
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} was not registered during counting`);
      }
      const parts: string[] = [];
      const flushed = cgSeq.sequenceArgs(self, parts, expr.args, expr.span, base, 0);
      const operands = expr.args.map((_, index) => cgSeq.slotAt(self, base + index)).join(', ');
      return cgSeq.finishOp(
        self,
        parts,
        base,
        `${name}(${String(expr.args.length)}, ${operands})`,
        expr.span,
        flushed,
        sup.argsConvert(expr.args),
      );
    }

    // A suspension point, emitted where the expression sits: park the resume state, subscribe,
    // pop the frame and leave. The `goto` that comes back lands in the middle of whatever loop
    // or try block this sits inside, which is legal C here specifically because no state lives
    // in the C frame -- every local is in the environment the reaction holds.
    case 'await': {
      if (!self.inAsync) {
        throw new Error('await outside an async function; the gate should have caught it');
      }
      const at = cgClosure.emitPark(
        self,
        expr,
        `jsrt_await(_jsrt_self, ${cgClosure.suspendSlot(self, expr)});`,
      );
      // A rejected awaited promise resumes with its reason: put it back in the pending cell so
      // an enclosing try -- or this unit's own pad -- treats it exactly like a `throw`.
      cgSeq.appendLine(
        self,
        `if (_jsrt_err) { jsrt_throw(_jsrt_v); goto ${cgSeq.currentPad(self)}; }`,
        expr.span,
      );
      cgSeq.appendLine(self, `${at} = _jsrt_v;`, expr.span);
      return at;
    }

    // Same suspension as await, answering the caller rather than the scheduler: park the
    // resume state, write the yielded value, pop the frame and leave. The next `next(v)`
    // re-enters at the label and the yield expression becomes `v`.
    //
    // A closing `gen.return(v)` / `gen.throw(e)` resumes the SAME label with an injection
    // instead of a value. THROW rethrows at the yield's own landing pad — the enclosing
    // catch/finally sees it exactly as if the yield threw. RETURN parks the value in the
    // return slot and runs emitReturnJump, which routes through every enclosing finally the
    // way a real `return` statement at this point would — so a finally that yields suspends
    // again, and the later resume finds the injection already cleared and just continues.
    case 'yield': {
      if (!self.inGenerator) {
        throw new Error('yield outside a generator; the gate should have caught it');
      }
      const at = cgClosure.emitPark(
        self,
        expr,
        `jsrt_generator_yield(_jsrt_self, ${cgClosure.suspendSlot(self, expr)});`,
      );
      cgSeq.appendLine(self, `if (_jsrt_self->inject == JSRT_GEN_INJECT_THROW) {`, expr.span);
      self.indent++;
      cgSeq.appendLine(self, '_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
      cgSeq.appendLine(self, 'jsrt_throw(_jsrt_v);', expr.span);
      cgSeq.appendLine(self, `goto ${cgSeq.currentPad(self)};`, expr.span);
      self.indent--;
      cgSeq.appendLine(self, '}', expr.span);
      cgSeq.appendLine(self, `if (_jsrt_self->inject == JSRT_GEN_INJECT_RETURN) {`, expr.span);
      self.indent++;
      cgSeq.appendLine(self, '_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
      cgSeq.appendLine(self, `${cgSeq.slotAt(self, self.returnSlot)} = _jsrt_v;`, expr.span);
      cgStmt.emitReturnJump(self, expr.span);
      self.indent--;
      cgSeq.appendLine(self, '}', expr.span);
      cgSeq.appendLine(self, `${at} = _jsrt_v;`, expr.span);
      return at;
    }

    // One descriptor exists per class in the whole program, so class identity IS descriptor
    // identity and the test is a pointer comparison. `classAt` is called for its check alone:
    // it throws if counting and emission disagree about which classes exist.
    case 'instanceof': {
      if (expr.builtin === true) {
        return `jsrt_bool(jsrt_instanceof_builtin(${emitExpression(self, expr.target)}, ${sup.cNameLiteral(expr.className)}))`;
      }
      cgClass.classAt(self, expr.className);
      const id = String(self.classIds.get(expr.className));
      return `jsrt_bool(jsrt_instanceof(${emitExpression(self, expr.target)}, &_jsrt_class_${id}))`;
    }

    // `new v(...)` where `v` is a class object or a constructible function: allocation and the
    // constructor both dispatch through the value (one runtime entry) because what it builds is
    // a run-time fact. The constructor's slot receives the result, the arguments after it are
    // the `argv`, and the call lands as a statement so a throwing constructor (or a
    // non-constructor's TypeError) meets its pending check before anything consumes it.
    case 'new-value': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('new-value was not registered during counting');
      }
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.target, expr.args, expr.span, base);
      const argv = expr.args.length === 0 ? 'NULL' : `&${cgSeq.slotAt(self, base + 1)}`;
      return cgSeq.finishStatement(
        self,
        parts,
        `${cgSeq.slotAt(self, base)} = jsrt_construct(${cgSeq.slotAt(self, base)}, ${expr.args.length}, ${argv})`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    // `o instanceof v` where `v` is a class-object value: the chain walk against the
    // descriptor the value carries, or Node's TypeError when it carries no constructor.
    case 'instanceof-value': {
      const base = self.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('instanceof-value was not registered during counting');
      }
      const parts: string[] = [];
      cgSeq.beginCall(self, parts, expr.target, [expr.ctor], expr.span, base);
      return cgSeq.finishStatement(
        self,
        parts,
        `${cgSeq.slotAt(self, base)} = jsrt_bool(jsrt_instanceof_ctor(${cgSeq.slotAt(self, base)}, ${cgSeq.slotAt(self, base + 1)}))`,
        cgSeq.slotAt(self, base),
        expr.span,
      );
    }

    // One file-scope constant per class (docs/VALUE.md §4.17): the closure-shaped class
    // object `classAt` registered, whose `fn` is the constructor `jsrt_construct` calls.
    case 'class-value': {
      cgClass.classAt(self, expr.className);
      const id = String(self.classIds.get(expr.className));
      return `jsrt_closure(&_jsrt_class_object_${id})`;
    }

    default: {
      const _exhaustive: never = expr;
      throw new Error(
        `Unknown expression kind: ${(_exhaustive as unknown as { kind?: string }).kind}`,
      );
    }
  }
}

/* `a && b` is `let t = a; t ? b : t` -- the result is an OPERAND, not a boolean, and the right
 * side runs only sometimes. Both facts force a temporary: the left operand is tested and then
 * possibly returned, and evaluating it twice would duplicate its side effects.
 *
 * The temporary is a frame slot rather than a C local because C has no expression-level
 * declaration, and because a value the GC cannot see is a value it can collect. The comma
 * operator sequences the store before the test, so evaluation order is left-then-branch. */
/* Folds to a left-nested chain of `jsrt_string_concat`. Each hole goes through `jsrt_to_string`
 * explicitly rather than through `+`: template substitution is defined as ToString, whereas `+`
 * would run ToPrimitive with hint default and consult `valueOf` first once objects exist.
 *
 * Empty literal chunks are dropped -- `` `${a}${b}` `` has three of them and concatenating with
 * "" is a no-op -- except when that would leave nothing at all, since `` `` `` is the empty
 * string and still has to produce a value. */
export function emitTemplateLiteral(self: Emitter, expr: TemplateLiteral): string {
  const slots = self.templateSlots.get(expr);
  if (slots === undefined) {
    throw new Error('template literal has no frame slots; countExpression missed a node');
  }

  const sequence: string[] = [];
  let flushed = false;
  let partIndex = 0;
  expr.quasis.forEach((quasi, i) => {
    if (quasi !== '') {
      sequence.push(
        `${cgSeq.slotAt(self, slots.base + partIndex)} = ${emitStringLiteral(self, quasi)}`,
      );
      partIndex++;
    }
    const hole = expr.expressions[i];
    if (hole !== undefined) {
      const holeSlot = cgSeq.slotAt(self, slots.base + partIndex);
      flushed =
        cgSeq.sequencePart(
          self,
          sequence,
          hole,
          expr.span,
          (v) => `${holeSlot} = jsrt_to_string(${v})`,
        ) || flushed;
      // A hole whose ToString may run the program's `toString` may throw, and a later hole must
      // not run after it did (plan.md §9 Task 6.27): the check sits right behind this one.
      if (hTypeConversionRunsUserCode(hole.type)) {
        cgSeq.flushParts(self, sequence, expr.span);
        cgSeq.emitPendingCheck(self, expr.span);
        flushed = true;
      }
      partIndex++;
    }
  });

  if (partIndex !== slots.count) {
    throw new Error('template literal part count disagrees with its frame-slot count');
  }
  const first = cgSeq.slotAt(self, slots.base);
  for (let index = 1; index < partIndex; index++) {
    sequence.push(
      `${first} = jsrt_string_concat(${first}, ${cgSeq.slotAt(self, slots.base + index)})`,
    );
  }
  // Concatenating can throw past the maximum string length (see emitBinaryOp).
  if (partIndex > 1) {
    cgSeq.flushParts(self, sequence, expr.span);
    cgSeq.emitPendingCheck(self, expr.span);
    return first;
  }
  if (!flushed) {
    sequence.push(first);
    return `(${sequence.join(', ')})`;
  }
  cgSeq.flushParts(self, sequence, expr.span);
  return first;
}

/* ToNumber of a rooted slot whose value may be an object, in place, behind its own check: the
 * object's `valueOf` may throw, and nothing after it may run if it does (plan.md §9 Task 6.27). */
export function emitToNumber(self: Emitter, slot: string, type: HType, span: Span): void {
  if (hTypeConversionRunsUserCode(type)) {
    cgSeq.appendLine(self, `${slot} = jsrt_number(jsrt_to_number(${slot}));`, span);
    cgSeq.emitPendingCheck(self, span);
  }
}

export function emitBinaryOp(self: Emitter, expr: BinaryOp): string {
  const base = self.binarySlots.get(expr);
  if (base === undefined) {
    throw new Error('binary operator has no frame slots; countExpression missed a node');
  }
  const left = cgSeq.slotAt(self, base);
  const right = cgSeq.slotAt(self, base + 1);
  // The comma operator sequences the assignments. Calling jsrt_op_* directly with the emitted
  // child expressions would revive C's unspecified argument order and could collect a temporary
  // from the left while evaluating the right.
  const parts: string[] = [];
  cgSeq.sequencePart(self, parts, expr.left, expr.span, (v) => `${left} = ${v}`);
  cgSeq.sequencePart(self, parts, expr.right, expr.span, (v) => `${right} = ${v}`);
  // `in` is the one binary operator whose runtime raises: the right operand must be an object
  // (§13.10.1 step 6), so `"length" in "abc"` is a TypeError. The answer lands in the left slot
  // before the check, exactly as `delete` does it, so a throw reaches the landing pad with the
  // operands already sequenced and nothing half-read. Without this line the exception was set
  // and never observed -- and `emitTryCatch` DROPPED the catch block, because nothing had jumped
  // to its pad (plan-notes 220).
  if (expr.operator === 'in') {
    cgSeq.flushParts(self, parts, expr.span);
    cgSeq.appendLine(self, `${left} = jsrt_bool(jsrt_in(${left}, ${right}));`, expr.span);
    cgSeq.emitPendingCheck(self, expr.span);
    return left;
  }
  // An operand that may be an object reaches ToPrimitive, which runs the program's own
  // `valueOf`/`toString` and may throw (plan.md §9 Task 6.27). The numeric operators convert
  // here, left then right, each behind its own check (§13.15.3 steps 3-4: C would pick the
  // order of two conversions nested in one expression); `+`, the comparisons and `==` convert
  // inside the runtime, which keeps the order and stops at a throw, so only the check follows.
  const converts =
    expr.operator !== ',' &&
    expr.operator !== '===' &&
    expr.operator !== '!==' &&
    (hTypeConversionRunsUserCode(expr.left.type) || hTypeConversionRunsUserCode(expr.right.type));
  if (converts && sup.NUMERIC_BINARY_OPERATORS.includes(expr.operator)) {
    cgSeq.flushParts(self, parts, expr.span);
    emitToNumber(self, left, expr.left.type, expr.span);
    emitToNumber(self, right, expr.right.type, expr.span);
    return sup.BINARY_EMITTERS[expr.operator](left, right);
  }
  // A `+` that may concatenate can throw too: past the maximum string length the runtime leaves
  // `RangeError: Invalid string length` pending (plan.md §9 Task 6.23, F12). A `+` typed number
  // adds and never throws, so it stays an expression.
  if ((expr.operator === '+' && expr.type.kind !== 'number') || converts) {
    cgSeq.flushParts(self, parts, expr.span);
    cgSeq.appendLine(
      self,
      `${left} = ${sup.BINARY_EMITTERS[expr.operator](left, right)};`,
      expr.span,
    );
    cgSeq.emitPendingCheck(self, expr.span);
    return left;
  }
  const result = sup.BINARY_EMITTERS[expr.operator](left, right);
  if (parts.length === 2) {
    return `(${parts.join(', ')}, ${result})`;
  }
  // An operand carried statements of its own (a call and its pending check): everything is
  // already sequenced into the slots, so only the operation remains for the consumer.
  cgSeq.flushParts(self, parts, expr.span);
  return result;
}

/** One arm of a branched value: the captured statements, then the arm's result in `temp`. */
function emitCapturedArm(
  self: Emitter,
  span: Span,
  temp: string,
  captured: { readonly lines: readonly string[]; readonly value: string },
): void {
  self.indent++;
  self.lines.push(...captured.lines);
  cgSeq.appendLine(self, `${temp} = ${captured.value};`, span);
  self.indent--;
}

export function emitStringLiteral(_self: Emitter, value: string): string {
  const bytes = sup.wtf8Bytes(value);
  return `jsrt_string_from_utf8("${sup.escapeBytes(bytes)}", ${String(bytes.length)})`;
}

export function emitLogicalOp(self: Emitter, expr: LogicalOp): string {
  const slot = self.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('short-circuit operator has no frame slot; countExpression missed a node');
  }
  const temp = cgSeq.slotAt(self, slot);
  const left = emitExpression(self, expr.left);
  self.indent++;
  const captured = cgSeq.capture(self, () => emitExpression(self, expr.right));
  self.indent--;

  if (captured.lines.length === 0) {
    const right = captured.value;
    // `??` tests nullish, NOT falsy: `0 ?? 1` is 0 while `0 || 1` is 1.
    // `||` is the odd one out: it is the only operator here whose test passing means "keep the
    // left operand". `&&` and `??` both mean "the left operand was unsatisfying, take the right".
    const test = expr.operator === '??' ? `jsrt_is_nullish(${temp})` : `jsrt_truthy(${temp})`;
    const whenTrue = expr.operator === '||' ? temp : right;
    const whenFalse = expr.operator === '||' ? right : temp;
    return `(${temp} = ${left}, ${test} ? (${whenTrue}) : (${whenFalse}))`;
  }

  // The right operand needed statements of its own (a call and its pending check), and it only
  // runs when the operator says so -- so its statements sit inside a branch, and the node's
  // value is whatever `temp` holds afterwards.
  cgSeq.appendLine(self, `${temp} = ${left};`, expr.span);
  const enter =
    expr.operator === '&&'
      ? `jsrt_truthy(${temp})`
      : expr.operator === '||'
        ? `!jsrt_truthy(${temp})`
        : `jsrt_is_nullish(${temp})`;
  cgSeq.appendLine(self, `if (${enter}) {`, expr.span);
  emitCapturedArm(self, expr.span, temp, captured);
  cgSeq.appendLine(self, '}', expr.span);
  return temp;
}

export function emitConditional(self: Emitter, expr: ConditionalExpr): string {
  const slot = self.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('conditional has no frame slot; countExpression missed a node');
  }
  const temp = cgSeq.slotAt(self, slot);
  const cond = emitExpression(self, expr.condition);
  self.indent++;
  const thenCap = cgSeq.capture(self, () => emitExpression(self, expr.consequent));
  const elseCap = cgSeq.capture(self, () => emitExpression(self, expr.alternate));
  self.indent--;
  if (thenCap.lines.length === 0 && elseCap.lines.length === 0) {
    cgSeq.appendLine(
      self,
      `${temp} = jsrt_truthy(${cond}) ? (${thenCap.value}) : (${elseCap.value});`,
      expr.span,
    );
    return temp;
  }
  cgSeq.appendLine(self, `if (jsrt_truthy(${cond})) {`, expr.span);
  emitCapturedArm(self, expr.span, temp, thenCap);
  cgSeq.appendLine(self, '} else {', expr.span);
  emitCapturedArm(self, expr.span, temp, elseCap);
  cgSeq.appendLine(self, '}', expr.span);
  return temp;
}

export function emitOptionalChain(self: Emitter, expr: OptionalChain): string {
  const slot = self.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('optional chain has no frame slot; countExpression missed a node');
  }
  const temp = cgSeq.slotAt(self, slot);
  const base = emitExpression(self, expr.base);
  self.optionalBaseStack.push(temp);
  let consequent: { readonly lines: string[]; readonly value: string };
  try {
    consequent = cgSeq.capture(self, () => emitExpression(self, expr.consequent));
  } finally {
    self.optionalBaseStack.pop();
  }
  // `?.` tests nullish, NOT falsy: `0?.toString()` is `"0"` while `0 || x` is `x`. The base
  // is evaluated once into the rooted temp; the consequent reads it through the leaf, so a
  // nullish base skips the accesses AND the keys and arguments inside them.
  if (consequent.lines.length === 0) {
    return `(${temp} = ${base}, jsrt_is_nullish(${temp}) ? JSRT_UNDEFINED : (${consequent.value}))`;
  }
  // The consequent needed statements of its own (a call and its pending check), and it only
  // runs when the base is non-nullish — so its statements sit inside the else branch, and the
  // node's value is whatever `temp` holds afterwards.
  cgSeq.appendLine(self, `${temp} = ${base};`, expr.span);
  cgSeq.appendLine(self, `if (jsrt_is_nullish(${temp})) {`, expr.span);
  self.indent++;
  cgSeq.appendLine(self, `${temp} = JSRT_UNDEFINED;`, expr.span);
  self.indent--;
  cgSeq.appendLine(self, '} else {', expr.span);
  emitCapturedArm(self, expr.span, temp, consequent);
  cgSeq.appendLine(self, '}', expr.span);
  return temp;
}

export function emitOptionalBase(self: Emitter): string {
  const temp = self.optionalBaseStack.at(-1);
  if (temp === undefined) {
    throw new Error('optional-base outside an optional chain; the lowering builds one only');
  }
  return temp;
}

export function emitUpdate(self: Emitter, expr: UpdateExpr): string {
  const slot = self.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('update has no frame slot; countExpression missed a node');
  }
  const result = cgSeq.slotAt(self, slot);
  const place = expr.target;
  let read: string;
  let write: (value: string) => string;
  switch (place.kind) {
    case 'identifier': {
      const ref = cgSeq.slotRef(self, place.name);
      read = ref;
      write = (value: string) => `${ref} = ${value}`;
      break;
    }
    case 'index-access': {
      const base = self.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update index place was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      const index = cgSeq.slotAt(self, base + 1);
      cgSeq.appendLine(self, `${target} = ${emitExpression(self, place.target)};`, expr.span);
      cgSeq.appendLine(self, `${index} = ${emitExpression(self, place.index)};`, expr.span);
      const targetType = place.target.type;
      read = sup.indexGetCall(targetType, target, index);
      write = (value: string) => sup.indexSetCall(targetType, target, index, value);
      break;
    }
    case 'field-access': {
      const base = self.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update field place was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      cgSeq.appendLine(self, `${target} = ${emitExpression(self, place.target)};`, expr.span);
      read = `jsrt_object_get(${target}, ${place.slot})`;
      write = (value: string) => `jsrt_object_set(${target}, ${place.slot}, ${value})`;
      break;
    }
    case 'dyn-field-access': {
      const base = self.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update dynamic field place was not registered during counting');
      }
      const target = cgSeq.slotAt(self, base);
      cgSeq.appendLine(self, `${target} = ${emitExpression(self, place.target)};`, expr.span);
      const ic = cgRuntime.icSite(self);
      read = `jsrt_get_prop(${target}, ${sup.cNameLiteral(place.field)}, &${ic})`;
      write = (value: string) =>
        `jsrt_set_prop(${target}, ${sup.cNameLiteral(place.field)}, ${value}, &${ic})`;
      break;
    }
  }
  const op = expr.operator;
  if (op === '=') {
    const value = expr.value;
    if (value === undefined) {
      throw new Error('assignment update is missing its right-hand side');
    }
    const rhs = emitExpression(self, value);
    cgSeq.appendLine(self, `${result} = ${rhs};`, expr.span);
    cgSeq.appendLine(self, `${write(result)};`, expr.span);
  } else {
    cgSeq.appendLine(self, `${result} = ${read};`, expr.span);
    // A dynamic read throws on a nullish receiver, and a static index read degrades to it on
    // a statically-typed array that arrives as something else (plan.md §8 step 20) -- either
    // unwinds before the arithmetic below consumes the value. (The write has the blanket
    // check at the end of this function.)
    if (place.kind === 'dyn-field-access' || place.kind === 'index-access') {
      cgSeq.emitPendingCheck(self, expr.span);
    }
    if (op === '++' || op === '--') {
      // ToNumeric first (§13.4.2.1 step 2): the old value a postfix update answers is the
      // number, not the string or object the place held, and an object's `valueOf` may throw
      // before anything is written (plan.md §9 Task 6.27).
      if (place.type.kind !== 'number') {
        cgSeq.appendLine(self, `${result} = jsrt_number(jsrt_to_number(${result}));`, expr.span);
        if (hTypeConversionRunsUserCode(place.type)) {
          cgSeq.emitPendingCheck(self, expr.span);
        }
      }
      const next = `jsrt_number(jsrt_to_number(${result}) ${op === '++' ? '+' : '-'} 1.0)`;
      if (expr.prefix) {
        cgSeq.appendLine(self, `${result} = ${next};`, expr.span);
        cgSeq.appendLine(self, `${write(result)};`, expr.span);
      } else {
        cgSeq.appendLine(self, `${write(next)};`, expr.span);
      }
    } else if (op === '&&' || op === '||' || op === '??') {
      const value = expr.value;
      if (value === undefined) {
        throw new Error('logical update is missing its right-hand side');
      }
      const takeRight =
        op === '||'
          ? `!jsrt_truthy(${result})`
          : op === '&&'
            ? `jsrt_truthy(${result})`
            : `jsrt_is_nullish(${result})`;
      cgSeq.appendLine(self, `if (${takeRight}) {`, expr.span);
      self.indent++;
      const rhs = emitExpression(self, value);
      cgSeq.appendLine(self, `${result} = ${rhs};`, expr.span);
      cgSeq.appendLine(self, `${write(result)};`, expr.span);
      self.indent--;
      cgSeq.appendLine(self, '}', expr.span);
    } else {
      const value = expr.value;
      if (value === undefined) {
        throw new Error('compound update is missing its right-hand side');
      }
      let rhs = emitExpression(self, value);
      // Both operands are read before either converts (§13.15.2 step 7), so the right one waits
      // rooted in the next slot while the left one's `valueOf` runs, each behind its own check.
      if (sup.compoundConverts(expr)) {
        const right = cgSeq.slotAt(self, slot + 1);
        cgSeq.appendLine(self, `${right} = ${rhs};`, expr.span);
        emitToNumber(self, result, place.type, expr.span);
        emitToNumber(self, right, value.type, expr.span);
        rhs = right;
      }
      cgSeq.appendLine(self, `${result} = ${sup.BINARY_EMITTERS[op](result, rhs)};`, expr.span);
      // Before the write: a `+=` past the maximum string length throws and leaves the target as
      // it was (see emitBinaryOp).
      if (op === '+' && expr.type.kind !== 'number') {
        cgSeq.emitPendingCheck(self, expr.span);
      }
      cgSeq.appendLine(self, `${write(result)};`, expr.span);
    }
  }
  if (place.kind !== 'identifier') {
    cgSeq.emitPendingCheck(self, expr.span);
  }
  return result;
}
