/* expressions emission for the C emitter (T24 split). */

import type { Emitter } from './emitter.ts';
import type { CallSlotted } from './types.ts';
import type {
  BinaryOp,
  ClassDeclaration,
  ClassMethod,
  ConditionalExpr,
  DynFieldAssignment,
  Expression,
  FieldAssignment,
  LogicalOp,
  MethodCall,
  MethodCopy,
  MethodValue,
  ObjectLiteral,
  OptionalChain,
  Span,
  TemplateLiteral,
  UpdateExpr,
  VtableEntry,
} from '../hir/nodes.ts';
import {
  consoleMayThrow,
  DATE_OPS,
  NUMBER_OPS,
  DATE_STATICS,
  GLOBAL_CALLS,
  errorDescriptor,
  isAccessorEntry,
  isComputedEntry,
  REGEXP_FIELDS,
  REGEXP_OPS,
  stringOpCanThrow,
  TYPED_OPS,
} from '../hir/nodes.ts';
import { hTypeConversionRunsUserCode, type HType } from '../hir/types.ts';
import {
  BINARY_EMITTERS,
  NUMERIC_BINARY_OPERATORS,
  CHECK_FUNCTIONS,
  UNARY_EMITTERS,
} from './tables.ts';
import {
  compoundConverts,
  argsConvert,
  cDoubleLiteral,
  cNameLiteral,
  snakeCase,
  shapeNameOf,
  shapeFieldsOf,
  keyOrderOf,
  hiddenMethodField,
  dynLiteralBaseSlots,
  spreadScratchKey,
  spreadScratches,
  spreadSnapshots,
  wtf8Bytes,
  escapeBytes,
  indexGetCall,
  indexSetCall,
  mayRefuseWeakKey,
  iteratorBoxCall,
  collectionCall,
} from './helpers.ts';

/** Rooted slot pair for an index-shaped node, claimed at counting time. */
function requireIndexBase(
  emitter: Emitter,
  key: Parameters<Emitter['indexSlots']['get']>[0],
  missing: string,
): { readonly target: string; readonly second: string; readonly parts: string[] } {
  const base = emitter.indexSlots.get(key);
  if (base === undefined) {
    throw new Error(missing);
  }
  return {
    target: emitter.slotAt(base),
    second: emitter.slotAt(base + 1),
    parts: [],
  };
}

/** Contiguous call-slot base for a call-shaped node (calle/receiver + args). */
function requireCallBase(
  emitter: Emitter,
  expr: Parameters<Emitter['callSlots']['get']>[0],
): number {
  const base = emitter.callSlots.get(expr);
  if (base === undefined) {
    throw new Error(`${expr.kind} was not registered during counting`);
  }
  return base;
}

/** Emits one captured arm into `temp`. `closeWith` is the line that ends the arm's block:
 * `}` for a standalone if, `} else {` when an else-arm body follows. */
function emitBranchArm(
  emitter: Emitter,
  span: Span,
  temp: string,
  open: string | undefined,
  arm: { readonly lines: readonly string[]; readonly value: string },
  closeWith = '}',
): void {
  if (open !== undefined) {
    emitter.appendLine(open, span);
  }
  emitter.indent++;
  emitter.lines.push(...arm.lines);
  emitter.appendLine(`${temp} = ${arm.value};`, span);
  emitter.indent--;
  emitter.appendLine(closeWith, span);
}

/** Rooted temp for a short-circuit / conditional / optional node, claimed at counting time. */
function requireTempSlot(
  emitter: Emitter,
  expr: Parameters<Emitter['tempSlots']['get']>[0],
  what: string,
): string {
  const slot = emitter.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error(`${what} has no frame slot; countExpression missed a node`);
  }
  return emitter.slotAt(slot);
}

/** Sequences a call's args after its lead slot and returns the operand string. */
function sequenceCallOperands(
  emitter: Emitter,
  expr: CallSlotted & { readonly args: readonly Expression[] },
  span: Span,
): {
  readonly base: number;
  readonly parts: string[];
  readonly flushed: boolean;
  readonly operands: string;
} {
  const base = requireCallBase(emitter, expr);
  const parts: string[] = [];
  const flushed = emitter.sequenceArgs(parts, expr.args, span, base, 0);
  const operands = expr.args
    .map((_arg: Expression, index: number) => emitter.slotAt(base + index))
    .join(', ');
  return { base, parts, flushed, operands };
}

export function emitFieldWrite(
  emitter: Emitter,
  stmt: FieldAssignment | DynFieldAssignment,
  write: (target: string, value: string) => string,
  missing: string,
): void {
  const { target, second: value, parts } = requireIndexBase(emitter, stmt, missing);
  emitter.sequencePart(parts, stmt.target, stmt.span, (v) => `${target} = ${v}`);
  emitter.sequencePart(parts, stmt.value, stmt.span, (v) => `${value} = ${v}`);
  parts.push(write(target, value));
  emitter.flushParts(parts, stmt.span);
  emitter.emitPendingCheck(stmt.span);
}

export function emitExpression(emitter: Emitter, expr: Expression): string {
  switch (expr.kind) {
    case 'number-literal': {
      return `jsrt_number(${cDoubleLiteral(expr.value)})`;
    }

    case 'string-literal': {
      return emitter.emitStringLiteral(expr.value);
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
      return emitter.slotRef(expr.name);
    }

    case 'binary-op': {
      return emitter.emitBinaryOp(expr);
    }

    case 'unary-op': {
      const slot = emitter.tempSlots.get(expr);
      if (slot === undefined) {
        return UNARY_EMITTERS[expr.operator](emitter.emitExpression(expr.operand));
      }
      const temp = emitter.slotAt(slot);
      const operand = emitter.emitExpression(expr.operand);
      emitter.appendLine(`${temp} = jsrt_number(jsrt_to_number(${operand}));`, expr.span);
      emitter.emitPendingCheck(expr.span);
      return UNARY_EMITTERS[expr.operator](temp);
    }

    case 'typeof': {
      return `jsrt_typeof(${emitter.emitExpression(expr.operand)})`;
    }

    // The one expression whose value never reaches its consumer. The call always throws, so the
    // pending check on the very next line always jumps to the landing pad; `JSRT_UNDEFINED` is
    // emitted only because C needs the expression to HAVE a value, and nothing ever reads it.
    // Appending lines here is what makes it correct inside a larger expression: `sequencePart`
    // sees a non-empty buffer and flushes the operands evaluated so far out as a statement first,
    // which keeps the language's evaluation order across the throw.
    case 'reference-error': {
      emitter.appendLine(`jsrt_reference_error("${emitter.escapeCString(expr.name)}");`, expr.span);
      emitter.emitPendingCheck(expr.span);
      return 'JSRT_UNDEFINED';
    }

    case 'type-error': {
      emitter.appendLine(
        `jsrt_throw_error(&jsrt_class_type_error, "${emitter.escapeCString(expr.message)}");`,
        expr.span,
      );
      emitter.emitPendingCheck(expr.span);
      return 'JSRT_UNDEFINED';
    }

    // The location is a string literal in the emitted C rather than something reconstructed at
    // failure time: the emitter is the only party that still knows where this value came from,
    // and a check that could not say where it failed would be nearly useless in a compiled
    // binary with no source map at runtime.
    case 'boundary-check': {
      const check = CHECK_FUNCTIONS[expr.type.kind];
      if (check === undefined) {
        throw new Error(`no boundary check for type kind: ${expr.type.kind}`);
      }
      return `${check}(${emitter.emitExpression(expr.value)}, "${emitter.escapeCString(expr.where)}")`;
    }

    case 'logical-op': {
      return emitter.emitLogicalOp(expr);
    }

    case 'conditional': {
      return emitter.emitConditional(expr);
    }

    case 'optional-chain': {
      return emitter.emitOptionalChain(expr);
    }

    case 'optional-base': {
      return emitter.emitOptionalBase();
    }

    case 'update': {
      return emitter.emitUpdate(expr);
    }

    case 'template-literal': {
      return emitter.emitTemplateLiteral(expr);
    }

    case 'string-length': {
      return `jsrt_number((double)jsrt_string_length(${emitter.emitExpression(expr.operand)}))`;
    }

    case 'function-length': {
      return `jsrt_number((double)jsrt_closure_arity(${emitter.emitExpression(expr.operand)}))`;
    }

    // Every console entry point returns `void` in C, but the call's JS value is `undefined` --
    // the verifier pins the HIR type to it. In VALUE position that gap is a hard error, not a
    // style question: `const r = console.log(x)` emitted `JSRT_LOCAL(0) = jsrt_print(...)` and
    // clang refused the file. The comma supplies the value the type promised. Statement position
    // takes `consoleCall` bare instead, because `(jsrt_print(x), JSRT_UNDEFINED);` is a
    // -Wunused-value warning on every console.log in the program.
    case 'console-log': {
      if (consoleMayThrow(expr)) {
        emitter.appendLine(`${emitter.consoleCall(expr)};`, expr.span);
        emitter.emitPendingCheck(expr.span);
        return 'JSRT_UNDEFINED';
      }
      return `(${emitter.consoleCall(expr)}, JSRT_UNDEFINED)`;
    }

    case 'function': {
      return emitter.closureValue(expr);
    }

    case 'array-length': {
      const slot = emitter.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('array length was not registered during counting');
      }
      const result = emitter.slotAt(slot);
      emitter.appendLine(
        `${result} = jsrt_array_length(${emitter.emitExpression(expr.operand)});`,
        expr.span,
      );
      emitter.emitPendingCheck(expr.span);
      return result;
    }

    case 'array-literal': {
      const base = emitter.arraySlots.get(expr);
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
          emitter.sequencePart(
            parts,
            element,
            expr.span,
            (v) => `${emitter.slotAt(base + i)} = ${v}`,
          ) || flushed;
      });
      const alloc = `jsrt_array_new(${expr.elements.length}, &${emitter.slotAt(base)})`;
      if (!flushed) {
        parts.push(alloc);
        return `(${parts.join(', ')})`;
      }
      emitter.flushParts(parts, expr.span);
      return alloc;
    }

    case 'index-access': {
      const {
        target,
        second: index,
        parts,
      } = requireIndexBase(emitter, expr, 'index access was not registered during counting');
      emitter.sequencePart(parts, expr.target, expr.span, (v) => `${target} = ${v}`);
      emitter.sequencePart(parts, expr.index, expr.span, (v) => `${index} = ${v}`);
      const read = indexGetCall(expr.target.type, target, index);
      // Both arms land as statements: the dynamic read throws on a nullish receiver, and the
      // static one degrades to it on a statically-typed array that arrives as something else
      // (plan.md §8 step 20). The answer reuses the receiver's slot, which is dead by then --
      // the delete-prop discipline.
      emitter.flushParts(parts, expr.span);
      emitter.appendLine(`${target} = ${read};`, expr.span);
      emitter.emitPendingCheck(expr.span);
      return target;
    }

    case 'delete-prop': {
      const {
        target,
        second: key,
        parts,
      } = requireIndexBase(emitter, expr, 'delete was not registered during counting');
      emitter.sequencePart(parts, expr.target, expr.span, (v) => `${target} = ${v}`);
      emitter.sequencePart(parts, expr.key, expr.span, (v) => `${key} = ${v}`);
      emitter.flushParts(parts, expr.span);
      // The answer lands in the receiver's slot before the pending check, so a delete that threw
      // (a frozen object, a nullish receiver) jumps to the landing pad with nothing half-read.
      emitter.appendLine(`${target} = jsrt_bool(jsrt_delete(${target}, ${key}));`, expr.span);
      emitter.emitPendingCheck(expr.span);
      return target;
    }

    case 'call': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('call was not registered during counting');
      }
      // Callee first, then arguments left to right -- the evaluation order the language
      // specifies, each landing in its rooted slot before the next runs. The call itself lands
      // as a STATEMENT, never inside the consumer's expression, so the pending-check can sit
      // between it and whatever consumes the result -- which waits in the callee's slot.
      const parts: string[] = [];
      emitter.beginCall(parts, expr.callee, expr.args, expr.span, base);
      const argv = expr.args.length === 0 ? 'NULL' : `&${emitter.slotAt(base + 1)}`;
      const loc = emitter.callLocation(expr.span);
      // A spread call's one argument is the folded list (verifier STA4104).
      const call =
        expr.spread === true
          ? `jsrt_call_spread_at(${emitter.slotAt(base)}, NULL, ${emitter.slotAt(base + 1)}, ${loc})`
          : `jsrt_call_at(${emitter.slotAt(base)}, ${expr.args.length}, ${argv}, ${loc})`;
      return emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = ${call}`,
        emitter.slotAt(base),
        expr.span,
      );
    }

    // An extern call: the one arm that never touches `jsrt_value` on the way out. Arguments
    // land in rooted slots first (their own pending checks run before any temporary exists),
    // then straight-line statements do the rest — see `emitExternCall` for the order the
    // string lifetimes and the error conventions depend on.
    case 'extern-call': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('extern call was not registered during counting');
      }
      return emitter.emitExternCall(expr, base);
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
      const read = emitter.emitExpression(expr.operand);
      return expr.inner === 'pointer' ? read : `jsrt_string_from_cstr((char *)jsrt_ptr(${read}))`;
    }

    case 'field-access': {
      return `jsrt_object_get_field(${emitter.emitExpression(expr.target)}, ${expr.slot}, ${cNameLiteral(expr.field)})`;
    }

    case 'iterator-next': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('iterator-next was not registered during counting');
      }
      const parts: string[] = [];
      emitter.sequencePart(parts, expr.target, expr.span, (v) => `${emitter.slotAt(base)} = ${v}`);
      emitter.sequencePart(
        parts,
        expr.sent,
        expr.span,
        (v) => `${emitter.slotAt(base + 1)} = ${v}`,
      );
      emitter.flushParts(parts, expr.span);
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
      emitter.appendLine(
        `${emitter.slotAt(base)} = ${step}(${emitter.slotAt(base)}, ${emitter.slotAt(base + 1)});`,
        expr.span,
      );
      emitter.emitPendingCheck(expr.span);
      return emitter.slotAt(base);
    }

    // Dynamic GetIterator dispatch (plan.md §8 step 2a(c)): the operand stays rooted in its
    // own slot across the call, which boxes collections and runs the resolved
    // `__@iterator` method -- both of which allocate -- and a non-iterable leaves the
    // catchable TypeError pending for the check below, exactly like a dynamic property read.
    case 'get-iterator': {
      const slot = emitter.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('get-iterator was not registered during counting');
      }
      const result = emitter.slotAt(slot);
      emitter.appendLine(`${result} = ${emitter.emitExpression(expr.target)};`, expr.span);
      emitter.appendLine(`${result} = jsrt_get_iterator(${result});`, expr.span);
      emitter.emitPendingCheck(expr.span);
      return result;
    }

    // The site's cache is a static JSRTIC: a hit is one pointer compare and one load, a miss
    // walks the shape chain and refills it (docs/VALUE.md §4.10). A getter or nullish receiver
    // can throw: root the result and unwind before any consumer or later operand executes.
    case 'dyn-field-access': {
      const slot = emitter.tempSlots.get(expr);
      if (slot === undefined) {
        throw new Error('dynamic property read was not registered during counting');
      }
      const result = emitter.slotAt(slot);
      emitter.appendLine(`${result} = ${emitter.emitExpression(expr.target)};`, expr.span);
      emitter.appendLine(
        `${result} = jsrt_get_prop(${result}, ${cNameLiteral(expr.field)}, &${emitter.icSite()});`,
        expr.span,
      );
      emitter.emitPendingCheck(expr.span);
      return result;
    }

    // `index`, `input` and `groups` are PROPERTIES of the match array, so they read through the
    // same shape chain and the same per-site cache any dynamic property does. `length` is not:
    // it is the array header's own field, and reading it through the table would answer
    // `undefined`. A receiver that is not a match panics inside the runtime either way.
    case 'match-read': {
      const target = emitter.emitExpression(expr.target);
      return expr.field === 'length'
        ? `jsrt_array_length(${target})`
        : `jsrt_get_prop(${target}, ${cNameLiteral(expr.field)}, &${emitter.icSite()})`;
    }

    // Eleven reads off the compiled struct, none of them allocating and none of them a property
    // in the shape-table sense: `source` and `flags` are the strings the runtime normalized at
    // construction, `lastIndex` is a header field, and the eight predicates are one bit test
    // each -- passed the flag's LETTER, because the LRE_FLAG_* constants belong to the vendored
    // engine's header and generated C does not include it.
    case 'regexp-read': {
      const target = emitter.emitExpression(expr.target);
      const spec = REGEXP_FIELDS[expr.field];
      return 'flag' in spec
        ? `jsrt_bool(jsrt_regexp_flag(${target}, '${spec.flag}'))`
        : `jsrt_regexp_${snakeCase(expr.field)}(${target})`;
    }

    case 'new': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('new was not registered during counting');
      }
      const cls = emitter.classAt(expr.className);
      const object = emitter.slotAt(base);
      // The object is created first and lands in the slot the constructor will receive as
      // argument zero, so it is rooted before any argument -- which may allocate -- is
      // evaluated. The whole expression yields that slot, not the constructor's return value:
      // `new` in JavaScript ignores what a constructor returns unless it returns an object,
      // and this subset's constructors cannot return one.
      const parts = [
        `${object} = jsrt_object_new(&_jsrt_class_${String(emitter.classIds.get(expr.className))})`,
      ];
      emitter.sequenceArgs(parts, expr.args, expr.span, base, 1);
      if (cls.ctor === undefined) {
        emitter.flushParts(parts, expr.span);
        return object;
      }
      return emitter.finishStatement(
        parts,
        `jsrt_call(${emitter.closureValue(cls.ctor.fn)}, ${1 + expr.args.length}, &${object})`,
        object,
        expr.span,
      );
    }

    case 'method-value': {
      // Virtual: the receiver picks the entry. Direct: the named closure is the value, but
      // the receiver expression still runs -- `new C().m` must construct C even though the
      // extracted function does not capture it.
      if (expr.dispatch === 'virtual') {
        return `jsrt_method(${emitter.emitExpression(expr.target)}, ${expr.slot})`;
      }
      const callee = emitter.closureValue(emitter.methodOf(expr).fn);
      const captured = emitter.capture(() => emitter.emitExpression(expr.target));
      if (captured.lines.length === 0) {
        return `(${captured.value}, ${callee})`;
      }
      emitter.lines.push(...captured.lines);
      return callee;
    }

    case 'method-call': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('method call was not registered during counting');
      }
      // Receiver first, then arguments left to right -- the same order and the same contiguous
      // argv as a plain call, with the receiver where the callee slot would be.
      const parts: string[] = [];
      emitter.beginCall(parts, expr.target, expr.args, expr.span, base);
      // A direct call names the function; a virtual one loads the entry the RECEIVER's own class
      // holds at this slot. The receiver is already in its slot, so the load reads the value the
      // call is about to pass, not a second evaluation of the target expression.
      const callee =
        expr.dispatch === 'virtual'
          ? `jsrt_method(${emitter.slotAt(base)}, ${expr.slot})`
          : emitter.methodCallee(expr, emitter.slotAt(base));
      return emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = jsrt_call(${callee}, ${1 + expr.args.length}, &${emitter.slotAt(base)})`,
        emitter.slotAt(base),
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
      const base = requireCallBase(emitter, expr);
      const method = emitter.slotAt(base + 1 + expr.args.length);
      const parts: string[] = [];
      emitter.beginCall(parts, expr.target, expr.args, expr.span, base);
      parts.push(
        expr.kind === 'field-call'
          ? `${method} = jsrt_object_get_field(${emitter.slotAt(base)}, ${expr.slot}, ${cNameLiteral(expr.field)})`
          : `${method} = jsrt_get_prop(${emitter.slotAt(base)}, ${cNameLiteral(expr.method)}, &${emitter.icSite()})`,
      );
      emitter.flushParts(parts, expr.span);
      if (expr.kind === 'dyn-method-call') {
        emitter.emitPendingCheck(expr.span);
        if (expr.notFunction !== undefined) {
          emitter.appendLine(
            `if (!jsrt_is(${method}, JSRT_TAG_CLOSURE)) { jsrt_throw_error(&jsrt_class_type_error, "${emitter.escapeCString(`${expr.notFunction} is not a function`)}"); }`,
            expr.span,
          );
          emitter.emitPendingCheck(expr.span);
        }
      }
      const argv = expr.args.length === 0 ? 'NULL' : `&${emitter.slotAt(base + 1)}`;
      const loc = emitter.callLocation(expr.span);
      if (expr.kind === 'dyn-method-call' && expr.spread === true) {
        return emitter.finishStatement(
          [],
          `${emitter.slotAt(base)} = jsrt_call_spread_at(${method}, &${emitter.slotAt(base)}, ${emitter.slotAt(base + 1)}, ${loc})`,
          emitter.slotAt(base),
          expr.span,
        );
      }
      const withReceiver = `jsrt_call_at(${method}, ${String(1 + expr.args.length)}, &${emitter.slotAt(base)}, ${loc})`;
      const withoutReceiver = `jsrt_call_at(${method}, ${String(expr.args.length)}, ${argv}, ${loc})`;
      return emitter.finishStatement(
        [],
        `${emitter.slotAt(base)} = (jsrt_is(${method}, JSRT_TAG_CLOSURE) && jsrt_as_closure(${method})->has_receiver) ? ${withReceiver} : ${withoutReceiver}`,
        emitter.slotAt(base),
        expr.span,
      );
    }

    // Allocate, then fill left to right. The object is in its own rooted slot first, so an entry
    // that allocates cannot collect the object it is being stored into. A spread with a
    // non-trivial source runs once into its scratch slot at its own position in this order,
    // and every field reads out of that (`spreadScratches`); anything else evaluates inline.
    case 'object-literal': {
      const slot = emitter.callSlots.get(expr);
      if (slot === undefined) {
        throw new Error('object literal was not registered during counting');
      }
      const layout = shapeFieldsOf(expr);
      const order = keyOrderOf(expr, layout);
      const name = `${shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
      const id = String(emitter.classIds.get(name));
      const scratches = spreadScratches(expr.entries, expr.methodCopies);
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
      const snaps = spreadSnapshots(expr.entries);
      const snapAt = new Map(
        snaps.map(({ key }, index) => [key, slot + 1 + scratches.length + index]),
      );
      const snapTarget = new Map(snaps.map(({ key, target }) => [key, target]));
      const snapDone = new Set<string>();
      const orderId = emitter.spreadOrderCount;
      if (needsOrder) {
        emitter.spreadOrderCount++;
      }
      const parts = [`${emitter.slotAt(slot)} = jsrt_object_new(&_jsrt_class_${id})`];
      let flushed = false;
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
          const rendered = emitter.capture(() => emitter.emitExpression(receiver));
          if (rendered.lines.length > 0) {
            throw new Error('spread copy source produced statements');
          }
          from = rendered.value;
        } else {
          const key = spreadScratchKey(copy.value.span);
          const resolved = emitter.spreadSource(
            parts,
            key,
            scratchAt,
            scratchTarget,
            scratchDone,
            expr.span,
            flushed,
          );
          flushed = resolved.flushed;
          if (resolved.slot === null) {
            throw new Error('spread copy source has no slot');
          }
          from = resolved.slot;
        }
        parts.push(
          `jsrt_object_set(${emitter.slotAt(slot)}, ${String(dst)}, jsrt_object_get_field(${from}, ${String(src)}, ${cNameLiteral(copy.name)}))`,
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
          const key = spreadScratchKey(entry.value.span);
          if (!snapDone.has(key)) {
            snapDone.add(key);
            const snap = snapAt.get(key);
            const source = snapTarget.get(key);
            if (snap === undefined || source === undefined) {
              throw new Error('spread snapshot has no slot');
            }
            const rendered = emitter.capture(() => emitter.emitExpression(source));
            if (rendered.lines.length > 0) {
              throw new Error('spread snapshot source produced statements');
            }
            parts.push(`${emitter.slotAt(snap)} = ${rendered.value}`);
          }
        }
        if (entry.value.kind === 'field-access' && entry.value.target.kind !== 'identifier') {
          const key = spreadScratchKey(entry.value.span);
          const resolved = emitter.spreadSource(
            parts,
            key,
            scratchAt,
            scratchTarget,
            scratchDone,
            expr.span,
            flushed,
          );
          flushed = resolved.flushed;
          if (resolved.slot !== null) {
            parts.push(
              `jsrt_object_set(${emitter.slotAt(slot)}, ${String(target)}, jsrt_object_get_field(${resolved.slot}, ${String(entry.value.slot)}, ${cNameLiteral(entry.name)}))`,
            );
            continue;
          }
        }
        flushed =
          emitter.sequencePart(
            parts,
            entry.value,
            expr.span,
            (v) => `jsrt_object_set(${emitter.slotAt(slot)}, ${String(target)}, ${v})`,
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
          `jsrt_object_set(${emitter.slotAt(slot)}, ${String(dst)}, ${emitter.closureValue(method.fn)})`,
        );
      });
      if (needsOrder) {
        // The repair runs after every value, as statements: the declaration opens here -- past
        // any suspension, so no park can strand it indeterminate (plan.md §8 step 15) -- and
        // every contribution reads a rooted slot (a scratch, a snapshot, or nothing at all for
        // an own key), in fragment order. Forcing the statement form is what makes that true.
        emitter.flushParts(parts, expr.span);
        emitter.appendLine(`uint32_t _jsrt_order_${orderId}[${String(layout.length)}];`, expr.span);
        emitter.appendLine(`uint32_t _jsrt_ordn_${orderId} = 0;`, expr.span);
        const orderSeen = new Set<string>();
        for (const entry of expr.entries) {
          if (entry.spread === true) {
            if (entry.value.kind !== 'field-access') {
              throw new Error('spread order entry is not a field read');
            }
            const key = spreadScratchKey(entry.value.span);
            if (!orderSeen.has(key)) {
              orderSeen.add(key);
              const scratch = scratchAt.get(key);
              const snap = snapAt.get(key);
              const src =
                scratch !== undefined
                  ? emitter.slotAt(scratch)
                  : snap !== undefined
                    ? emitter.slotAt(snap)
                    : null;
              if (src === null) {
                throw new Error('spread order source has no slot');
              }
              emitter.appendLine(
                `jsrt_spread_order_src(_jsrt_order_${orderId}, &_jsrt_ordn_${orderId}, ${String(layout.length)}, ${emitter.slotAt(slot)}, ${src});`,
                expr.span,
              );
            }
          } else {
            const dst = layout.findIndex((field) => field.name === entry.name);
            if (dst < 0) {
              throw new Error(`object literal key ${entry.name} is not in its own shape`);
            }
            emitter.appendLine(
              `jsrt_spread_order_key(_jsrt_order_${orderId}, &_jsrt_ordn_${orderId}, ${String(layout.length)}, ${String(dst)});`,
              expr.span,
            );
          }
        }
        // The values are right; only the descriptor's key order is the type's instead of the
        // object's. Stamp the repaired order and keep the answer in its slot for the consumer.
        emitter.appendLine(
          `${emitter.slotAt(slot)} = jsrt_object_set_order(${emitter.slotAt(slot)}, _jsrt_order_${orderId}, _jsrt_ordn_${orderId});`,
          expr.span,
        );
        return emitter.slotAt(slot);
      }
      return emitter.finishSequenced(parts, emitter.slotAt(slot), expr.span, flushed);
    }

    // Allocate, then fill left to right through the rooted scratch slot. No inline cache on
    // construction: each entry is a fresh key on a fresh object, so every store transitions --
    // exactly the case the cache deliberately does not serve (docs/VALUE.md §4.10). A spread
    // with a non-trivial source runs once into its own scratch past the value scratch, like the
    // fixed arm's, and the whole fragment copies out of that in one call.
    case 'dyn-object-literal': {
      const slot = emitter.callSlots.get(expr);
      if (slot === undefined) {
        throw new Error('dynamic object literal was not registered during counting');
      }
      const scratch = emitter.slotAt(slot + 1);
      const scratches = spreadScratches(expr.entries);
      const base = slot + dynLiteralBaseSlots(expr);
      const scratchAt = new Map(scratches.map(({ key }, index) => [key, base + index]));
      const scratchTarget = new Map(scratches.map(({ key, target }) => [key, target]));
      const scratchDone = new Set<string>();
      const parts = [`${emitter.slotAt(slot)} = jsrt_dynobj_new()`];
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
            const into = emitter.slotAt(next);
            next += 1;
            flushed =
              emitter.sequencePart(parts, fn, expr.span, (v) => `${into} = ${v}`) || flushed;
            return into;
          };
          const get = half(entry.get);
          const set = half(entry.set);
          parts.push(
            `jsrt_define_accessor(${emitter.slotAt(slot)}, ${cNameLiteral(entry.name)}, ${get}, ${set})`,
          );
          continue;
        }
        if (isComputedEntry(entry)) {
          const keyScratch = emitter.slotAt(slot + 1);
          const valueScratch = emitter.slotAt(slot + 2);
          flushed =
            emitter.sequencePart(parts, entry.key, expr.span, (v) => `${keyScratch} = ${v}`) ||
            flushed;
          flushed =
            emitter.sequencePart(parts, entry.value, expr.span, (v) => `${valueScratch} = ${v}`) ||
            flushed;
          parts.push(
            `jsrt_dyn_index_set(${emitter.slotAt(slot)}, ${keyScratch}, ${valueScratch}, NULL)`,
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
            emitter.sequencePart(parts, entry.value, expr.span, (v) => `${scratch} = ${v}`) ||
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
          const key = spreadScratchKey(entry.value.span);
          if (!scratchDone.has(key)) {
            scratchDone.add(key);
            const scratchSlot = scratchAt.get(key);
            if (scratchSlot !== undefined) {
              const source = scratchTarget.get(key);
              if (source === undefined) {
                throw new Error('spread source has no scratch target');
              }
              flushed =
                emitter.sequencePart(
                  parts,
                  source,
                  expr.span,
                  (v) => `${emitter.slotAt(scratchSlot)} = ${v}`,
                ) || flushed;
              parts.push(
                `${emitter.slotAt(slot)} = jsrt_dynobj_spread(${emitter.slotAt(slot)}, ${emitter.slotAt(scratchSlot)})`,
              );
            } else {
              if (entry.value.target.kind !== 'identifier') {
                throw new Error('spread source has no scratch slot');
              }
              const inlineSource = entry.value.target;
              const rendered = emitter.capture(() => emitter.emitExpression(inlineSource));
              if (rendered.lines.length > 0) {
                throw new Error('spread source produced statements');
              }
              parts.push(
                `${emitter.slotAt(slot)} = jsrt_dynobj_spread(${emitter.slotAt(slot)}, ${rendered.value})`,
              );
            }
          }
          continue;
        }
        flushed =
          emitter.sequencePart(parts, entry.value, expr.span, (v) => `${scratch} = ${v}`) ||
          flushed;
        parts.push(
          `jsrt_set_prop(${emitter.slotAt(slot)}, ${cNameLiteral(entry.name)}, ${scratch}, NULL)`,
        );
      }
      return emitter.finishSequenced(parts, emitter.slotAt(slot), expr.span, flushed);
    }

    case 'collection-new':
      return expr.weak
        ? `jsrt_weak_collection_new(${expr.collection === 'map' ? 'true' : 'false'})`
        : `jsrt_${expr.collection}_new()`;

    // Compiled at EVERY evaluation, never hoisted: §22.2.4.1 makes each evaluation a fresh
    // object, and it has to be, because `lastIndex` is mutable state on it. The pattern rides in
    // its slot so it survives the flag string's allocation.
    case 'regexp-literal': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('regexp literal was not registered during counting');
      }
      const source = `${emitter.slotAt(base)} = ${emitter.emitStringLiteral(expr.source)}`;
      return `(${source}, jsrt_regexp_new(${emitter.slotAt(base)}, ${emitter.emitStringLiteral(expr.flags)}))`;
    }

    // A single-operand runtime walk: the argument rides in its rooted slot across the call.
    case 'date-new':
    case 'error-new':
    case 'json-parse':
    case 'json-stringify':
    case 'promise-static': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error(`${expr.kind} call was not registered during counting`);
      }
      const parts: string[] = [];
      const flushed = emitter.sequencePart(
        parts,
        expr.arg,
        expr.span,
        (v) => `${emitter.slotAt(base)} = ${v}`,
      );
      if (expr.kind === 'promise-static') {
        emitter.usedAsync = true;
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
      const opCall = `${runtimeCall}(${leading}${emitter.slotAt(base)})`;
      return emitter.finishOp(
        parts,
        base,
        opCall,
        expr.span,
        flushed,
        expr.kind === 'json-stringify',
      );
    }

    case 'promise-construct': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('promise-construct was not registered during counting');
      }
      emitter.usedAsync = true;
      const parts: string[] = [];
      emitter.sequencePart(
        parts,
        expr.executor,
        expr.span,
        (v) => `${emitter.slotAt(base)} = ${v}`,
      );
      return emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = jsrt_promise_construct(${emitter.slotAt(base)})`,
        emitter.slotAt(base),
        expr.span,
      );
    }

    case 'promise-method': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('promise-method was not registered during counting');
      }
      emitter.usedAsync = true;
      const parts: string[] = [];
      emitter.beginCall(parts, expr.target, expr.args, expr.span, base);
      const fn =
        expr.method === 'then'
          ? 'jsrt_promise_then'
          : expr.method === 'catch'
            ? 'jsrt_promise_catch'
            : 'jsrt_promise_finally';
      const operands = [
        emitter.slotAt(base),
        ...expr.args.map((_, index) => emitter.slotAt(base + 1 + index)),
      ].join(', ');
      // No pending check: subscribing a reaction neither runs user code nor fails, so nothing
      // can be pending here -- unlike construction, whose executor runs synchronously.
      parts.push(`${emitter.slotAt(base)} = ${fn}(${operands})`);
      emitter.flushParts(parts, expr.span);
      return emitter.slotAt(base);
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
      const base = requireCallBase(emitter, expr);
      const parts: string[] = [];
      let flushed = emitter.sequencePart(
        parts,
        expr.target,
        expr.span,
        (v) => `${emitter.slotAt(base)} = ${v}`,
      );
      flushed = emitter.sequenceArgs(parts, expr.args, expr.span, base, 1) || flushed;
      // `concat` is the receiver-plus-argument form of `+`, and its argument is an arbitrary
      // value: `''.concat(42)` is "42" because §22.1.3.4 runs ToString on each argument, while
      // `jsrt_string_concat` is the PRIMITIVE and asserts both sides are strings -- so the
      // conversion belongs here, exactly as it does for a template literal's holes. Without it
      // the assertion fired on `''.concat(true)` and on every other non-string argument
      // (plan-notes 222). One argument, so one coercion; the receiver of a method call is
      // already a string.
      const coercingConcat = expr.kind === 'string-op' && expr.op === 'concat';
      const operands = [
        emitter.slotAt(base),
        ...expr.args.map((_, index) =>
          coercingConcat
            ? `jsrt_to_string(${emitter.slotAt(base + 1 + index)})`
            : emitter.slotAt(base + 1 + index),
        ),
      ].join(', ');
      // A date op names its C function from the table rather than deriving it: snakeCase would
      // turn `getUTCFullYear` into `get_u_t_c_full_year`.
      const boxed =
        expr.kind === 'array-op' || expr.kind === 'collection-op'
          ? iteratorBoxCall(expr, operands)
          : undefined;
      const opCall =
        boxed !== undefined
          ? boxed
          : expr.kind === 'collection-op'
            ? collectionCall(expr.op, expr.collection, operands)
            : expr.kind === 'date-op'
              ? `${DATE_OPS[expr.op].fn}(${operands})`
              : expr.kind === 'number-op'
                ? `${NUMBER_OPS[expr.op].fn}(${operands})`
                : expr.kind === 'regexp-op'
                  ? // `test` is the one op that answers a C bool rather than a jsrt_value -- the engine
                    // has no notion of our values, so the boxing is the bridge's job (jsrt_regexp.c).
                    // `exec` already answers a value: the match array, or null.
                    REGEXP_OPS[expr.op].result === 'boolean'
                    ? `jsrt_bool(jsrt_regexp_${snakeCase(expr.op)}(${operands}))`
                    : `jsrt_regexp_${snakeCase(expr.op)}(${operands})`
                  : expr.kind === 'array-op'
                    ? emitter.arrayOpCall(expr, base)
                    : `jsrt_string_${snakeCase(expr.op)}(${operands})`;
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
        (expr.kind === 'collection-op' && mayRefuseWeakKey(expr)) ||
        (expr.kind === 'date-op' && expr.op === 'toISOString') ||
        expr.kind === 'number-op' ||
        (expr.kind === 'string-op' && stringOpCanThrow(expr.op)) ||
        // ToString/ToNumber of an argument that may be an object runs its own
        // `toString`/`valueOf` (plan.md §9 Task 6.27); a collection keeps its values as they are.
        (expr.kind !== 'collection-op' && argsConvert(expr.args));
      return emitter.finishOp(parts, base, opCall, expr.span, flushed, canThrow);
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
                  : `jsrt_object_${snakeCase(expr.method)}`;
      // Math takes immediates, so a lone argument has neither an order to fix nor anything to
      // keep rooted and nests directly. An Object walk always uses its slots (see counting).
      if (expr.kind === 'math-call' && emitter.callSlots.get(expr) === undefined) {
        const operands = expr.args.map((arg) => emitter.emitExpression(arg)).join(', ');
        return `${name}(${operands})`;
      }
      const { base, parts, flushed, operands } = sequenceCallOperands(emitter, expr, expr.span);
      const opCall = `${name}(${operands})`;
      // Every typed op can throw: a RangeError for a length or bound, or the TypeError a lying
      // receiver gets (golden rule 4) -- so each one is a statement with its pending check.
      return emitter.finishOp(
        parts,
        base,
        opCall,
        expr.span,
        flushed,
        expr.kind === 'object-static' ||
          expr.kind === 'typed-op' ||
          (expr.kind === 'global-call' && GLOBAL_CALLS[expr.name].throws) ||
          argsConvert(expr.args),
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
      if (emitter.callSlots.get(expr) === undefined) {
        const operands = expr.args.map((arg) => emitter.emitExpression(arg)).join(', ');
        return operands === '' ? `${name}(0)` : `${name}(${String(expr.args.length)}, ${operands})`;
      }
      const { base, parts, flushed, operands } = sequenceCallOperands(emitter, expr, expr.span);
      return emitter.finishOp(
        parts,
        base,
        `${name}(${String(expr.args.length)}, ${operands})`,
        expr.span,
        flushed,
        argsConvert(expr.args),
      );
    }

    // A suspension point, emitted where the expression sits: park the resume state, subscribe,
    // pop the frame and leave. The `goto` that comes back lands in the middle of whatever loop
    // or try block this sits inside, which is legal C here specifically because no state lives
    // in the C frame -- every local is in the environment the reaction holds.
    case 'await': {
      if (!emitter.inAsync) {
        throw new Error('await outside an async function; the gate should have caught it');
      }
      const at = emitter.emitPark(expr, `jsrt_await(_jsrt_self, ${emitter.suspendSlot(expr)});`);
      // A rejected awaited promise resumes with its reason: put it back in the pending cell so
      // an enclosing try -- or this unit's own pad -- treats it exactly like a `throw`.
      emitter.appendLine(
        `if (_jsrt_err) { jsrt_throw(_jsrt_v); goto ${emitter.currentPad()}; }`,
        expr.span,
      );
      emitter.appendLine(`${at} = _jsrt_v;`, expr.span);
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
      if (!emitter.inGenerator) {
        throw new Error('yield outside a generator; the gate should have caught it');
      }
      const at = emitter.emitPark(
        expr,
        `jsrt_generator_yield(_jsrt_self, ${emitter.suspendSlot(expr)});`,
      );
      emitter.appendLine(`if (_jsrt_self->inject == JSRT_GEN_INJECT_THROW) {`, expr.span);
      emitter.indent++;
      emitter.appendLine('_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
      emitter.appendLine('jsrt_throw(_jsrt_v);', expr.span);
      emitter.appendLine(`goto ${emitter.currentPad()};`, expr.span);
      emitter.indent--;
      emitter.appendLine('}', expr.span);
      emitter.appendLine(`if (_jsrt_self->inject == JSRT_GEN_INJECT_RETURN) {`, expr.span);
      emitter.indent++;
      emitter.appendLine('_jsrt_self->inject = JSRT_GEN_INJECT_NONE;', expr.span);
      emitter.appendLine(`${emitter.slotAt(emitter.returnSlot)} = _jsrt_v;`, expr.span);
      emitter.emitReturnJump(expr.span);
      emitter.indent--;
      emitter.appendLine('}', expr.span);
      emitter.appendLine(`${at} = _jsrt_v;`, expr.span);
      return at;
    }

    // One descriptor exists per class in the whole program, so class identity IS descriptor
    // identity and the test is a pointer comparison. `classAt` is called for its check alone:
    // it throws if counting and emission disagree about which classes exist.
    case 'instanceof': {
      if (expr.builtin === true) {
        return `jsrt_bool(jsrt_instanceof_builtin(${emitter.emitExpression(expr.target)}, ${cNameLiteral(expr.className)}))`;
      }
      emitter.classAt(expr.className);
      const id = String(emitter.classIds.get(expr.className));
      return `jsrt_bool(jsrt_instanceof(${emitter.emitExpression(expr.target)}, &_jsrt_class_${id}))`;
    }

    // `new v(...)` where `v` is a class object or a constructible function: allocation and the
    // constructor both dispatch through the value (one runtime entry) because what it builds is
    // a run-time fact. The constructor's slot receives the result, the arguments after it are
    // the `argv`, and the call lands as a statement so a throwing constructor (or a
    // non-constructor's TypeError) meets its pending check before anything consumes it.
    case 'new-value': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('new-value was not registered during counting');
      }
      const parts: string[] = [];
      emitter.beginCall(parts, expr.target, expr.args, expr.span, base);
      const argv = expr.args.length === 0 ? 'NULL' : `&${emitter.slotAt(base + 1)}`;
      return emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = jsrt_construct(${emitter.slotAt(base)}, ${expr.args.length}, ${argv})`,
        emitter.slotAt(base),
        expr.span,
      );
    }

    // `o instanceof v` where `v` is a class-object value: the chain walk against the
    // descriptor the value carries, or Node's TypeError when it carries no constructor.
    case 'instanceof-value': {
      const base = emitter.callSlots.get(expr);
      if (base === undefined) {
        throw new Error('instanceof-value was not registered during counting');
      }
      const parts: string[] = [];
      emitter.beginCall(parts, expr.target, [expr.ctor], expr.span, base);
      return emitter.finishStatement(
        parts,
        `${emitter.slotAt(base)} = jsrt_bool(jsrt_instanceof_ctor(${emitter.slotAt(base)}, ${emitter.slotAt(base + 1)}))`,
        emitter.slotAt(base),
        expr.span,
      );
    }

    // One file-scope constant per class (docs/VALUE.md §4.17): the closure-shaped class
    // object `classAt` registered, whose `fn` is the constructor `jsrt_construct` calls.
    case 'class-value': {
      emitter.classAt(expr.className);
      const id = String(emitter.classIds.get(expr.className));
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

/* The ordinary function unit: one C function, one stack frame, one exit protocol. */

export function registerShape(emitter: Emitter, expr: ObjectLiteral): void {
  const layout = shapeFieldsOf(expr);
  const order = keyOrderOf(expr, layout);
  // Two literals of the same TYPE can still have different insertion orders, so the descriptor
  // is keyed by both -- one shape name would otherwise print the second literal in the first's
  // order.
  const name = `${shapeNameOf(expr)}${order === undefined ? '' : `#${order.join(',')}`}`;
  if (emitter.classIds.has(name)) {
    return;
  }
  const id = emitter.classes.length;
  emitter.classIds.set(name, id);
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
    emitter.classKeyOrders.set(id, full);
    emitter.classHiddenMethods.set(shapeName, hidden);
  } else if (order !== undefined) {
    emitter.classKeyOrders.set(id, order);
  }
  emitter.classes.push({
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

function findClassMethod(emitter: Emitter, className: string, methodName: string): ClassMethod {
  const method = emitter.classAt(className).methods.find((m) => m.name === methodName);
  if (method === undefined) {
    throw new Error(`class ${className} has no method ${methodName}`);
  }
  return method;
}

export function methodOf(emitter: Emitter, expr: MethodCall | MethodValue): ClassMethod {
  return findClassMethod(emitter, expr.className, expr.method);
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

export function methodCallee(emitter: Emitter, expr: MethodCall, receiver: string): string {
  const hidden = emitter.classHiddenMethods.get(expr.className)?.get(expr.method);
  if (hidden !== undefined) {
    return `jsrt_object_get_field(${receiver}, ${String(hidden)}, ${cNameLiteral(expr.method)})`;
  }
  return emitter.closureValue(emitter.methodOf(expr).fn);
}

/** The closure constant a method-table entry names: the implementing class's own function.
 *
 * A table entry must be a file-scope constant to name one, so a method that captures has none:
 * the entry is NULL and the dynamic get skips it, leaving the instance's hidden `#method:`
 * slot -- which carries the construction-site environment -- as the hit. The gate guarantees
 * a virtual family never captures (overriding outside module scope is refused), so a NULL
 * entry is never loaded through `jsrt_method`; it is only skipped by name lookup. A missing
 * method still throws: the lowering proved it exists, so absence is a compiler bug. */

export function methodIdOrNull(emitter: Emitter, entry: VtableEntry): number | null {
  const method = findClassMethod(emitter, entry.className, entry.name);
  if (method.fn.needsEnv) {
    return null;
  }
  return emitter.functionId(method.fn);
}

/** `&_jsrt_class_N` for the base class, or `NULL` at the root of a chain. Throws when the base
 * has no descriptor yet, which would mean classes were emitted out of declaration order. */

export function baseDescriptor(emitter: Emitter, cls: ClassDeclaration, id: number): string {
  if (cls.base === undefined) {
    return 'NULL';
  }
  const baseId = emitter.classIds.get(cls.base);
  if (baseId === undefined || baseId >= id) {
    throw new Error(`class ${cls.name} is emitted before its base ${cls.base}`);
  }
  return `&_jsrt_class_${baseId}`;
}

/* The declaration a class name refers to. A miss means counting and emission disagree about
 * which classes exist, which is an emitter bug rather than anything the program did. */

export function classAt(emitter: Emitter, name: string): ClassDeclaration {
  const id = emitter.classIds.get(name);
  const cls = id === undefined ? undefined : emitter.classes[id];
  if (cls === undefined) {
    throw new Error(`class ${name} was not registered during counting`);
  }
  return cls;
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

export function emitTemplateLiteral(emitter: Emitter, expr: TemplateLiteral): string {
  const slots = emitter.templateSlots.get(expr);
  if (slots === undefined) {
    throw new Error('template literal has no frame slots; countExpression missed a node');
  }

  const sequence: string[] = [];
  let flushed = false;
  let partIndex = 0;
  expr.quasis.forEach((quasi, i) => {
    if (quasi !== '') {
      sequence.push(
        `${emitter.slotAt(slots.base + partIndex)} = ${emitter.emitStringLiteral(quasi)}`,
      );
      partIndex++;
    }
    const hole = expr.expressions[i];
    if (hole !== undefined) {
      const holeSlot = emitter.slotAt(slots.base + partIndex);
      flushed =
        emitter.sequencePart(
          sequence,
          hole,
          expr.span,
          (v) => `${holeSlot} = jsrt_to_string(${v})`,
        ) || flushed;
      // A hole whose ToString may run the program's `toString` may throw, and a later hole must
      // not run after it did (plan.md §9 Task 6.27): the check sits right behind this one.
      if (hTypeConversionRunsUserCode(hole.type)) {
        emitter.flushParts(sequence, expr.span);
        emitter.emitPendingCheck(expr.span);
        flushed = true;
      }
      partIndex++;
    }
  });

  if (partIndex !== slots.count) {
    throw new Error('template literal part count disagrees with its frame-slot count');
  }
  const first = emitter.slotAt(slots.base);
  for (let index = 1; index < partIndex; index++) {
    sequence.push(`${first} = jsrt_string_concat(${first}, ${emitter.slotAt(slots.base + index)})`);
  }
  // Concatenating can throw past the maximum string length (see emitBinaryOp).
  if (partIndex > 1) {
    emitter.flushParts(sequence, expr.span);
    emitter.emitPendingCheck(expr.span);
    return first;
  }
  if (!flushed) {
    sequence.push(first);
    return `(${sequence.join(', ')})`;
  }
  emitter.flushParts(sequence, expr.span);
  return first;
}

/* ToNumber of a rooted slot whose value may be an object, in place, behind its own check: the
 * object's `valueOf` may throw, and nothing after it may run if it does (plan.md §9 Task 6.27). */

export function emitToNumber(emitter: Emitter, slot: string, type: HType, span: Span): void {
  if (hTypeConversionRunsUserCode(type)) {
    emitter.appendLine(`${slot} = jsrt_number(jsrt_to_number(${slot}));`, span);
    emitter.emitPendingCheck(span);
  }
}

export function emitBinaryOp(emitter: Emitter, expr: BinaryOp): string {
  const base = emitter.binarySlots.get(expr);
  if (base === undefined) {
    throw new Error('binary operator has no frame slots; countExpression missed a node');
  }
  const left = emitter.slotAt(base);
  const right = emitter.slotAt(base + 1);
  // The comma operator sequences the assignments. Calling jsrt_op_* directly with the emitted
  // child expressions would revive C's unspecified argument order and could collect a temporary
  // from the left while evaluating the right.
  const parts: string[] = [];
  emitter.sequencePart(parts, expr.left, expr.span, (v) => `${left} = ${v}`);
  emitter.sequencePart(parts, expr.right, expr.span, (v) => `${right} = ${v}`);
  // `in` is the one binary operator whose runtime raises: the right operand must be an object
  // (§13.10.1 step 6), so `"length" in "abc"` is a TypeError. The answer lands in the left slot
  // before the check, exactly as `delete` does it, so a throw reaches the landing pad with the
  // operands already sequenced and nothing half-read. Without this line the exception was set
  // and never observed -- and `emitTryCatch` DROPPED the catch block, because nothing had jumped
  // to its pad (plan-notes 220).
  if (expr.operator === 'in') {
    emitter.flushParts(parts, expr.span);
    emitter.appendLine(`${left} = jsrt_bool(jsrt_in(${left}, ${right}));`, expr.span);
    emitter.emitPendingCheck(expr.span);
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
  if (converts && NUMERIC_BINARY_OPERATORS.includes(expr.operator)) {
    emitter.flushParts(parts, expr.span);
    emitter.emitToNumber(left, expr.left.type, expr.span);
    emitter.emitToNumber(right, expr.right.type, expr.span);
    return BINARY_EMITTERS[expr.operator](left, right);
  }
  // A `+` that may concatenate can throw too: past the maximum string length the runtime leaves
  // `RangeError: Invalid string length` pending (plan.md §9 Task 6.23, F12). A `+` typed number
  // adds and never throws, so it stays an expression.
  if ((expr.operator === '+' && expr.type.kind !== 'number') || converts) {
    emitter.flushParts(parts, expr.span);
    emitter.appendLine(`${left} = ${BINARY_EMITTERS[expr.operator](left, right)};`, expr.span);
    emitter.emitPendingCheck(expr.span);
    return left;
  }
  const result = BINARY_EMITTERS[expr.operator](left, right);
  if (parts.length === 2) {
    return `(${parts.join(', ')}, ${result})`;
  }
  // An operand carried statements of its own (a call and its pending check): everything is
  // already sequenced into the slots, so only the operation remains for the consumer.
  emitter.flushParts(parts, expr.span);
  return result;
}

export function emitStringLiteral(_emitter: Emitter, value: string): string {
  const bytes = wtf8Bytes(value);
  return `jsrt_string_from_utf8("${escapeBytes(bytes)}", ${String(bytes.length)})`;
}

export function emitLogicalOp(emitter: Emitter, expr: LogicalOp): string {
  const temp = requireTempSlot(emitter, expr, 'short-circuit operator');
  const left = emitter.emitExpression(expr.left);
  emitter.indent++;
  const captured = emitter.capture(() => emitter.emitExpression(expr.right));
  emitter.indent--;

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
  emitter.appendLine(`${temp} = ${left};`, expr.span);
  const enter =
    expr.operator === '&&'
      ? `jsrt_truthy(${temp})`
      : expr.operator === '||'
        ? `!jsrt_truthy(${temp})`
        : `jsrt_is_nullish(${temp})`;
  emitBranchArm(emitter, expr.span, temp, `if (${enter}) {`, captured);
  return temp;
}

export function emitConditional(emitter: Emitter, expr: ConditionalExpr): string {
  const temp = requireTempSlot(emitter, expr, 'conditional');
  const cond = emitter.emitExpression(expr.condition);
  emitter.indent++;
  const thenCap = emitter.capture(() => emitter.emitExpression(expr.consequent));
  const elseCap = emitter.capture(() => emitter.emitExpression(expr.alternate));
  emitter.indent--;
  if (thenCap.lines.length === 0 && elseCap.lines.length === 0) {
    emitter.appendLine(
      `${temp} = jsrt_truthy(${cond}) ? (${thenCap.value}) : (${elseCap.value});`,
      expr.span,
    );
    return temp;
  }
  emitBranchArm(emitter, expr.span, temp, `if (jsrt_truthy(${cond})) {`, thenCap, '} else {');
  emitBranchArm(emitter, expr.span, temp, undefined, elseCap);
  return temp;
}

export function emitOptionalChain(emitter: Emitter, expr: OptionalChain): string {
  const slot = emitter.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('optional chain has no frame slot; countExpression missed a node');
  }
  const temp = emitter.slotAt(slot);
  const base = emitter.emitExpression(expr.base);
  emitter.optionalBaseStack.push(temp);
  let consequent: { readonly lines: string[]; readonly value: string };
  try {
    consequent = emitter.capture(() => emitter.emitExpression(expr.consequent));
  } finally {
    emitter.optionalBaseStack.pop();
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
  emitter.appendLine(`${temp} = ${base};`, expr.span);
  emitBranchArm(
    emitter,
    expr.span,
    temp,
    `if (jsrt_is_nullish(${temp})) {`,
    { lines: [], value: 'JSRT_UNDEFINED' },
    '} else {',
  );
  emitBranchArm(emitter, expr.span, temp, undefined, consequent);
  return temp;
}

export function emitOptionalBase(emitter: Emitter): string {
  const temp = emitter.optionalBaseStack.at(-1);
  if (temp === undefined) {
    throw new Error('optional-base outside an optional chain; the lowering builds one only');
  }
  return temp;
}

export function emitUpdate(emitter: Emitter, expr: UpdateExpr): string {
  const slot = emitter.tempSlots.get(expr);
  if (slot === undefined) {
    throw new Error('update has no frame slot; countExpression missed a node');
  }
  const result = emitter.slotAt(slot);
  const place = expr.target;
  let read: string;
  let write: (value: string) => string;
  switch (place.kind) {
    case 'identifier': {
      const ref = emitter.slotRef(place.name);
      read = ref;
      write = (value: string) => `${ref} = ${value}`;
      break;
    }
    case 'index-access': {
      const base = emitter.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update index place was not registered during counting');
      }
      const target = emitter.slotAt(base);
      const index = emitter.slotAt(base + 1);
      emitter.appendLine(`${target} = ${emitter.emitExpression(place.target)};`, expr.span);
      emitter.appendLine(`${index} = ${emitter.emitExpression(place.index)};`, expr.span);
      const targetType = place.target.type;
      read = indexGetCall(targetType, target, index);
      write = (value: string) => indexSetCall(targetType, target, index, value);
      break;
    }
    case 'field-access': {
      const base = emitter.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update field place was not registered during counting');
      }
      const target = emitter.slotAt(base);
      emitter.appendLine(`${target} = ${emitter.emitExpression(place.target)};`, expr.span);
      read = `jsrt_object_get(${target}, ${place.slot})`;
      write = (value: string) => `jsrt_object_set(${target}, ${place.slot}, ${value})`;
      break;
    }
    case 'dyn-field-access': {
      const base = emitter.indexSlots.get(expr);
      if (base === undefined) {
        throw new Error('update dynamic field place was not registered during counting');
      }
      const target = emitter.slotAt(base);
      emitter.appendLine(`${target} = ${emitter.emitExpression(place.target)};`, expr.span);
      const ic = emitter.icSite();
      read = `jsrt_get_prop(${target}, ${cNameLiteral(place.field)}, &${ic})`;
      write = (value: string) =>
        `jsrt_set_prop(${target}, ${cNameLiteral(place.field)}, ${value}, &${ic})`;
      break;
    }
  }
  const op = expr.operator;
  if (op === '=') {
    const value = expr.value;
    if (value === undefined) {
      throw new Error('assignment update is missing its right-hand side');
    }
    const rhs = emitter.emitExpression(value);
    emitter.appendLine(`${result} = ${rhs};`, expr.span);
    emitter.appendLine(`${write(result)};`, expr.span);
  } else {
    emitter.appendLine(`${result} = ${read};`, expr.span);
    // A dynamic read throws on a nullish receiver, and a static index read degrades to it on
    // a statically-typed array that arrives as something else (plan.md §8 step 20) -- either
    // unwinds before the arithmetic below consumes the value. (The write has the blanket
    // check at the end of this function.)
    if (place.kind === 'dyn-field-access' || place.kind === 'index-access') {
      emitter.emitPendingCheck(expr.span);
    }
    if (op === '++' || op === '--') {
      // ToNumeric first (§13.4.2.1 step 2): the old value a postfix update answers is the
      // number, not the string or object the place held, and an object's `valueOf` may throw
      // before anything is written (plan.md §9 Task 6.27).
      if (place.type.kind !== 'number') {
        emitter.appendLine(`${result} = jsrt_number(jsrt_to_number(${result}));`, expr.span);
        if (hTypeConversionRunsUserCode(place.type)) {
          emitter.emitPendingCheck(expr.span);
        }
      }
      const next = `jsrt_number(jsrt_to_number(${result}) ${op === '++' ? '+' : '-'} 1.0)`;
      if (expr.prefix) {
        emitter.appendLine(`${result} = ${next};`, expr.span);
        emitter.appendLine(`${write(result)};`, expr.span);
      } else {
        emitter.appendLine(`${write(next)};`, expr.span);
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
      emitter.appendLine(`if (${takeRight}) {`, expr.span);
      emitter.indent++;
      const rhs = emitter.emitExpression(value);
      emitter.appendLine(`${result} = ${rhs};`, expr.span);
      emitter.appendLine(`${write(result)};`, expr.span);
      emitter.indent--;
      emitter.appendLine('}', expr.span);
    } else {
      const value = expr.value;
      if (value === undefined) {
        throw new Error('compound update is missing its right-hand side');
      }
      let rhs = emitter.emitExpression(value);
      // Both operands are read before either converts (§13.15.2 step 7), so the right one waits
      // rooted in the next slot while the left one's `valueOf` runs, each behind its own check.
      if (compoundConverts(expr)) {
        const right = emitter.slotAt(slot + 1);
        emitter.appendLine(`${right} = ${rhs};`, expr.span);
        emitter.emitToNumber(result, place.type, expr.span);
        emitter.emitToNumber(right, value.type, expr.span);
        rhs = right;
      }
      emitter.appendLine(`${result} = ${BINARY_EMITTERS[op](result, rhs)};`, expr.span);
      // Before the write: a `+=` past the maximum string length throws and leaves the target as
      // it was (see emitBinaryOp).
      if (op === '+' && expr.type.kind !== 'number') {
        emitter.emitPendingCheck(expr.span);
      }
      emitter.appendLine(`${write(result)};`, expr.span);
    }
  }
  if (place.kind !== 'identifier') {
    emitter.emitPendingCheck(expr.span);
  }
  return result;
}

/* The C lvalue for a slot of the unit being emitted. Same slot number, different array: a
 * function's slots are its stack frame, the module's are the file-static globals. */
