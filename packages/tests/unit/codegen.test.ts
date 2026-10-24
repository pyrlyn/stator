import { strict as assert } from 'node:assert';
import { test } from 'vitest';

import { emitC } from '../../compiler/src/codegen/index.ts';
import { H_BOOLEAN, H_NUMBER, H_STRING, hUnknown } from '../../compiler/src/hir/types.ts';
import {
  assign,
  binary,
  block,
  bool,
  call,
  consoleLog,
  decl,
  exprStmt,
  fnDecl,
  id,
  ifStmt,
  makeModule,
  num,
  ret,
  span,
  str,
  throwStmt,
  tryStmt,
  whileStmt,
} from './helpers.ts';

test('prologue includes jsrt_init and the globals frame', () => {
  const module = makeModule([]);
  const c = emitC(module);

  assert.match(c, /#include "jsrt_value.h"/);
  assert.match(c, /int main\(int argc, char \*\*argv\)/);
  // `#line` markers may sit between the two calls.
  assert.match(c, /jsrt_init\(\);\n(?:#line [^\n]*\n)?\s*jsrt_process_args\(argc, argv\);/);
  assert.match(c, /return \(int\)jsrt_process_exit_code\(\);/);
  // A zero-length array is not valid C11, and a program with no module-level binding is.
  assert.match(c, /JSRT_GLOBALS\(1\);/);
  assert.match(c, /JSRT_GLOBALS_ENTER\(1\);/);
});

test('console.log(1 + 2 * 3) emits correct calls', () => {
  const module = makeModule([
    exprStmt(consoleLog([binary('+', num(1), binary('*', num(2), num(3)))]), H_NUMBER),
  ]);

  const c = emitC(module);

  // Must use jsrt_print, not plain printf
  assert.match(c, /jsrt_print/);
  // Must use jsrt_number for number literals
  assert.match(c, /jsrt_number/);
  // Must not have raw == comparisons of jsrt_values
  assert.ok(!c.includes(' == ') || c.includes('jsrt_strict_equals'));
});

test('=== operator uses jsrt_strict_equals', () => {
  const module = makeModule([exprStmt(binary('===', num(1), num(1), H_BOOLEAN), H_BOOLEAN)]);

  const c = emitC(module);
  assert.match(c, /jsrt_strict_equals/);
});

test('!== operator uses jsrt_strict_equals with negation', () => {
  const module = makeModule([exprStmt(binary('!==', num(1), num(2), H_BOOLEAN), H_BOOLEAN)]);

  const c = emitC(module);
  assert.match(c, /jsrt_strict_equals/);
  assert.match(c, /!\s*jsrt_strict_equals/);
});

test('#line directives appear with correct line numbers', () => {
  const module = makeModule([decl('x', num(42, 5), 'let', H_NUMBER, 5)]);

  const c = emitC(module);
  assert.match(c, /#line 5 "\/test\.ts"/);
});

test('#line directives escape backslashes in filenames', () => {
  const module = makeModule([decl('x', num(1), 'let')]);
  // Override fileName to test backslash escaping
  const backslashModule = {
    ...module,
    fileName: '/path\\with\\backslash.ts',
  };

  const c = emitC(backslashModule);
  assert.match(c, /#line 1 "\/path\\\\with\\\\backslash\.ts"/);
});

test('slot allocation for declarations', () => {
  const module = makeModule([
    decl('x', num(1), 'let', H_NUMBER, 1),
    decl('y', num(2), 'let', H_NUMBER, 2),
  ]);

  const c = emitC(module);

  assert.match(c, /JSRT_GLOBALS\(2\);/);

  // Both x (slot 0) and y (slot 1) should be assigned
  assert.match(c, /JSRT_GLOBAL\(0\)/);
  assert.match(c, /JSRT_GLOBAL\(1\)/);
});

test('arithmetic operators convert with jsrt_to_number and rewrap with jsrt_number', () => {
  // `-` and not `+`: `+` concatenates when given a string, so it dispatches in the runtime and
  // emits no conversion of its own. The other four are numeric unconditionally.
  const module = makeModule([exprStmt(binary('-', num(1), num(2)), H_NUMBER)]);

  const c = emitC(module);

  // ToNumber, NOT jsrt_to_double: the latter reinterprets the bits as an IEEE double, which is
  // only correct when the value already is one. On a boxed boolean or string it reads the tag
  // and payload as a mantissa and yields garbage.
  assert.match(c, /jsrt_to_number/);
  assert.doesNotMatch(c, /jsrt_to_double/);
  // Must use jsrt_number to rewrap result
  assert.match(c, /jsrt_number/);
});

test('+ dispatches to the runtime, because a string operand makes it concatenation', () => {
  const module = makeModule([exprStmt(binary('+', num(1), num(2)), H_NUMBER)]);

  const c = emitC(module);

  assert.match(c, /jsrt_op_add/);
  // The emitter must NOT decide this is addition: whether `+` adds or concatenates depends on the
  // runtime types of the operands, which are not known here.
  assert.doesNotMatch(c, /jsrt_to_number\(.*\) \+ /);
});

test('string literals use jsrt_string_from_utf8 with byte length', () => {
  const module = makeModule([decl('s', str('hello'), 'const', H_STRING)]);

  const c = emitC(module);

  assert.match(c, /jsrt_string_from_utf8\("hello", 5\)/);
});

// Conditions run ToBoolean, not `jsrt_as_bool`. `jsrt_as_bool` reads bit 0 of the value, which
// is the payload only for a boxed boolean; for a boxed double it is a mantissa bit, so `if (1)`
// took the ELSE branch while these tests asserted the old spelling.
test('if statement uses jsrt_truthy on condition', () => {
  const module = makeModule([ifStmt(bool(true), block([]), undefined, H_NUMBER)]);

  const c = emitC(module);
  assert.match(c, /if \(jsrt_truthy/);
  assert.doesNotMatch(c, /jsrt_as_bool/);
});

test('while statement uses jsrt_truthy on condition', () => {
  const module = makeModule([whileStmt(bool(true), block([]), H_NUMBER)]);

  const c = emitC(module);
  assert.match(c, /while \(jsrt_truthy/);
  assert.doesNotMatch(c, /jsrt_as_bool/);
});

test('main does not pop the globals frame, but an emitted function pops its own', () => {
  // The globals frame is pushed once and outlives every call, because a function body may read a
  // module-level binding. Popping it in main would unroot values still reachable from a callee.
  const mainOnly = emitC(makeModule([decl('x', num(1), 'let')]));
  assert.ok(!mainOnly.includes('JSRT_FRAME_POP()'), 'main must not pop the globals frame');
  assert.match(mainOnly, /return \(int\)jsrt_process_exit_code\(\);/);

  // A function frame is the opposite: it must pop on every exit path, the explicit return
  // included, and the value has to be read out of a rooted slot before the pop happens.
  const withFn = emitC(makeModule([fnDecl('f', ['n'], block([ret(id('n', H_NUMBER))]))]));
  assert.match(withFn, /JSRT_FRAME\(\d+\);/);
  assert.match(withFn, /JSRT_LOCAL\(\d+\) = .*\), JSRT_FRAME_POP\(\), JSRT_LOCAL\(\d+\)\);/);
});

test('a call dispatches to jsrt_call with its own argc, and passes NULL when there are none', () => {
  // argc is the CALL SITE's argument count, not the callee's declared arity: JavaScript drops
  // extras and fills missing parameters with undefined, so the emitter must not pad or truncate
  // to match the function it thinks it is calling (docs/HIR.md, HFunction).
  const declareF = fnDecl('f', [], block([]));

  const noArgs = emitC(makeModule([declareF, exprStmt(call(id('f', H_NUMBER)), H_NUMBER)]));
  assert.match(noArgs, /jsrt_call_at\([^,]+, 0, NULL, "/);

  // With arguments, argv points into the rooted slot run rather than at a C array literal, whose
  // storage the collector would not know about.
  const twoArgs = emitC(
    makeModule([declareF, exprStmt(call(id('f', H_NUMBER), [num(1), num(2)]), H_NUMBER)]),
  );
  assert.match(twoArgs, /jsrt_call_at\([^,]+, 2, &/);
  assert.doesNotMatch(twoArgs, /jsrt_call_at\([^,]+, 2, \(jsrt_value\[\]\)/);
});

test('a call evaluates arguments left to right, and dispatches only once all are rooted', () => {
  // C leaves argument evaluation order unspecified, so the emitter imposes the language's order
  // itself. Distinctive literals make the emitted positions readable without pinning how any
  // individual operand is spelled.
  const c = emitC(
    makeModule([
      fnDecl('callee', [], block([])),
      exprStmt(call(id('callee', H_NUMBER), [num(111), num(222)]), H_NUMBER),
    ]),
  );

  const firstArg = c.indexOf('111');
  const secondArg = c.indexOf('222');
  const dispatch = c.indexOf('jsrt_call');

  assert.ok(firstArg > -1 && secondArg > -1 && dispatch > -1, 'all three must appear');
  assert.ok(firstArg < secondArg, 'arguments are evaluated left to right');
  // Every operand is written to its rooted slot before the call happens; a collection triggered
  // inside a later argument must not be able to sweep an earlier one.
  assert.ok(secondArg < dispatch, 'dispatch comes after every argument is evaluated and rooted');
});

test('console.log at any width reaches a runtime entry point', () => {
  // The five printing methods are variadic (plan.md §8 step 18): one argument keeps the
  // positional entry point, and any other width takes `(count, argv)` over the rooted slots —
  // `console.log()` is `(0, NULL)`. A width with no entry point throws instead.
  const one = emitC(makeModule([exprStmt(consoleLog([num(1)]), H_NUMBER)]));
  assert.match(one, /jsrt_print\(/);
  assert.doesNotMatch(one, /jsrt_print_many\(/);

  const two = emitC(makeModule([exprStmt(consoleLog([num(1), num(2)]), H_NUMBER)]));
  assert.match(two, /jsrt_print_many\(2, &/);

  const none = emitC(makeModule([exprStmt(consoleLog([]), H_NUMBER)]));
  assert.match(none, /jsrt_print_many\(0, NULL\)/);
});

test('relational operators dispatch to the runtime and wrap in jsrt_bool', () => {
  const module = makeModule([exprStmt(binary('<', num(1), num(2), H_BOOLEAN), H_BOOLEAN)]);

  const c = emitC(module);

  // Text order vs numeric order is a runtime decision -- `"10" < "9"` is true while `"10" < 9`
  // is false -- so the emitter names the operation and does not inline a C comparison.
  assert.match(c, /jsrt_bool\(jsrt_op_lt\(/);
});

test('boolean literals emit jsrt_bool(true) or jsrt_bool(false)', () => {
  const moduleTrue = makeModule([exprStmt(bool(true), H_BOOLEAN)]);

  const cTrue = emitC(moduleTrue);
  assert.match(cTrue, /jsrt_bool\(true\)/);

  const moduleFalse = makeModule([exprStmt(bool(false), H_BOOLEAN)]);

  const cFalse = emitC(moduleFalse);
  assert.match(cFalse, /jsrt_bool\(false\)/);
});

test('assignment updates correct slot', () => {
  const module = makeModule([
    decl('x', num(1), 'let', H_NUMBER, 1),
    assign('x', num(2), H_NUMBER, 2),
  ]);

  const c = emitC(module);

  assert.match(c, /JSRT_GLOBALS\(1\);/);

  // Both declaration and assignment should use JSRT_GLOBAL(0)
  const matches = c.match(/JSRT_GLOBAL\(0\)/g);
  assert.ok(matches && matches.length >= 2, 'x should be declared and assigned in slot 0');
});

test('modulo operator uses fmod', () => {
  const module = makeModule([exprStmt(binary('%', num(10), num(3)), H_NUMBER)]);

  const c = emitC(module);
  assert.match(c, /fmod/);
});

test('string escaping handles special characters', () => {
  const module = makeModule([
    decl('s', str('line1\nline2\ttab"quote\\backslash'), 'const', H_STRING),
  ]);

  const c = emitC(module);

  // Check for proper escaping in the C output
  assert.match(c, /line1\\nline2\\ttab\\"quote\\\\backslash/);
});

test('string literals travel as WTF-8 octal escapes', () => {
  // An unpaired surrogate is a legal UTF-16 code unit that UTF-8 cannot carry, so the emitter must
  // spell it rather than write it: raw, the .c file's UTF-8 encoding replaced it with U+FFFD and
  // `charCodeAt(0)` answered 65533 instead of 55296 (plan-notes 178). Octal and not `\x`, because a
  // C hex escape swallows every hex digit that follows it.
  const lone = emitC(makeModule([decl('s', str('a\ud800'), 'const', H_STRING)]));
  assert.match(lone, /jsrt_string_from_utf8\("a\\355\\240\\200", 4\)/);

  // A well-formed pair still becomes ONE four-byte sequence -- the byte count is the encoding's,
  // never the code-unit count.
  const pair = emitC(makeModule([decl('s', str('\ud83d\udc4d'), 'const', H_STRING)]));
  assert.match(pair, /jsrt_string_from_utf8\("\\360\\237\\221\\215", 4\)/);
});

test('identifier reference uses allocated slot', () => {
  const module = makeModule([
    decl('x', num(5), 'let', H_NUMBER, 1),
    decl('y', id('x', H_NUMBER, 2), 'let', H_NUMBER, 2),
  ]);

  const c = emitC(module);

  // x should be in slot 0, y in slot 1
  // The second declaration should reference JSRT_LOCAL(0)
  assert.match(c, /JSRT_GLOBALS\(2\);/);
  const lines = c.split('\n');
  let foundYDecl = false;
  for (const line of lines) {
    if (line.includes('JSRT_GLOBAL(1)') && line.includes('JSRT_GLOBAL(0)')) {
      foundYDecl = true;
    }
  }
  assert.ok(foundYDecl, 'y declaration should reference x via slot 0');
});

test('binary operands are sequenced into rooted slots before the operation', () => {
  const c = emitC(
    makeModule([
      fnDecl('f', ['n'], block([ret(id('n', H_NUMBER))])),
      exprStmt(
        binary(
          '+',
          call(id('f', H_NUMBER), [num(111)]),
          call(id('f', H_NUMBER), [num(222)]),
          H_NUMBER,
        ),
        H_NUMBER,
      ),
    ]),
  );

  // C function argument order is unspecified. The two calls must instead be placed in comma-
  // sequenced rooted slots, and the final operation must consume only those slots.
  const first = c.indexOf('jsrt_number(111.0)');
  const second = c.indexOf('jsrt_number(222.0)');
  const operation = c.lastIndexOf('jsrt_op_add(');
  assert.ok(first > -1 && second > -1 && operation > -1, 'both operands and the operation exist');
  assert.ok(
    first < second && second < operation,
    'left operand, then right operand, then operator',
  );
  assert.doesNotMatch(c, /jsrt_op_add\(\(JSRT_(?:GLOBAL|LOCAL).*jsrt_call/);
});

/* --- Task 3.10: exception unwinding ------------------------------------------------------- */

test('an uncaught throw in main lands on an unwind pad that calls jsrt_uncaught', () => {
  const c = emitC(makeModule([throwStmt(str('boom'))]));
  assert.match(c, /jsrt_throw\(/);
  assert.match(c, /goto _jsrt_unwind;/);
  // The pad sits after main's normal return, so a program that does not throw never reaches it.
  const ret0 = c.indexOf('return (int)jsrt_process_exit_code();');
  const pad = c.indexOf('_jsrt_unwind: ;');
  assert.ok(ret0 > -1 && pad > ret0, 'the unwind pad follows the normal return');
  assert.match(c, /jsrt_uncaught\(\);/);
});

test('a function unwind pad pops the frame before returning', () => {
  const c = emitC(makeModule([fnDecl('f', [], block([throwStmt(num(1))]))]));
  // The pad is inside the function unit and must pop -- the rooting discipline requires a pop on
  // EVERY exit path, landing pads included.
  const fnStart = c.indexOf('_jsrt_fn_0');
  const pad = c.indexOf('_jsrt_unwind: ;', fnStart);
  const mainStart = c.indexOf('int main');
  assert.ok(pad > fnStart && pad < mainStart, 'the pad belongs to the function unit');
  const afterPad = c.slice(pad, pad + 200);
  assert.match(afterPad, /JSRT_FRAME_POP\(\);/);
  // Main itself throws nothing, so main gets no pad.
  assert.ok(!c.slice(mainStart).includes('_jsrt_unwind'), 'main has no unwind pad');
});

test('every call is followed by a pending-exception check', () => {
  const c = emitC(
    makeModule([fnDecl('f', [], block([])), exprStmt(call(id('f', H_NUMBER)), H_NUMBER)]),
  );
  const dispatch = c.indexOf('jsrt_call');
  const check = c.indexOf('if (jsrt_pending()) { goto _jsrt_unwind; }', dispatch);
  assert.ok(dispatch > -1 && check > dispatch, 'the check follows the dispatch');
});

test('try/catch takes the exception into the binding slot and skips the catch normally', () => {
  const c = emitC(
    makeModule([
      fnDecl('f', [], block([throwStmt(num(1))])),
      tryStmt(block([exprStmt(call(id('f', H_NUMBER)), H_NUMBER)]), {
        catchBinding: 'e',
        catchBlock: block([]),
      }),
    ]),
  );
  // The pending check inside the try targets the catch pad, not the unit unwind.
  assert.match(c, /if \(jsrt_pending\(\)\) \{ goto _jsrt_cat_0; \}/);
  // Normal completion jumps over the handler; the handler re-arms the cell by taking.
  const skip = c.indexOf('goto _jsrt_try_end_0;');
  const pad = c.indexOf('_jsrt_cat_0: ;');
  const take = c.indexOf('= jsrt_take_exception();');
  assert.ok(skip > -1 && pad > skip && take > pad, 'skip, pad, take -- in that order');
});

test('a catch whose try body cannot throw is not emitted at all', () => {
  const c = emitC(
    makeModule([
      tryStmt(block([decl('x', num(1), 'let')]), {
        catchBinding: 'e',
        catchBlock: block([assign('x', num(2))]),
      }),
    ]),
  );
  assert.ok(!c.includes('_jsrt_cat_0'), 'no landing pad for an unthrowing try');
  assert.ok(!c.includes('jsrt_take_exception'), 'no handler body either');
});

test('try/finally stashes the exception, runs the finally, then rethrows', () => {
  const c = emitC(
    makeModule([
      fnDecl('f', [], block([throwStmt(num(1))])),
      tryStmt(block([exprStmt(call(id('f', H_NUMBER)), H_NUMBER)]), {
        finallyBlock: block([exprStmt(consoleLog([num(9)]), H_NUMBER)]),
      }),
    ]),
  );
  // Completion protocol: 0 normal, 1 throw, stored in a counted slot as a boxed number so a
  // suspension between the route and the dispatch cannot drop it. The take happens BEFORE the
  // finally body -- its own throw must find the cell empty -- and the rethrow AFTER it.
  assert.match(c, /= jsrt_number\(0\);/);
  const stash = c.indexOf('= jsrt_take_exception();');
  const body = c.indexOf('jsrt_print');
  const rethrow = c.search(/if \(jsrt_number_value\(.*\) == 1\) \{ jsrt_throw\(/);
  assert.ok(stash > -1 && body > stash && rethrow > body, 'stash, finally body, rethrow');
});

test('a return through a finally routes via the completion dispatch', () => {
  const c = emitC(
    makeModule([
      fnDecl(
        'f',
        [],
        block([
          tryStmt(block([ret(num(1))]), {
            finallyBlock: block([exprStmt(consoleLog([num(9)]), H_NUMBER)]),
          }),
        ]),
      ),
    ]),
  );
  // The return parks its value, records jump code 2, and enters the finally; the dispatch after
  // the finally body performs the actual return, popping the frame.
  assert.match(c, /= jsrt_number\(2\);/);
  assert.match(c, /goto _jsrt_fin_0;/);
  const dispatch = c.search(/if \(jsrt_number_value\(.*\) == 2\) \{/);
  const realReturn = c.indexOf('return (JSRT_FRAME_POP(), JSRT_LOCAL(', dispatch);
  assert.ok(dispatch > -1 && realReturn > dispatch, 'the dispatch re-performs the return');
});

test('a break out of a try inside a loop routes through the finally first', () => {
  const brk = {
    kind: 'break-statement',
    type: H_NUMBER,
    span: span(1),
  } as const;
  const c = emitC(
    makeModule([
      whileStmt(
        bool(true),
        block([
          tryStmt(block([brk]), {
            finallyBlock: block([exprStmt(consoleLog([num(9)]), H_NUMBER)]),
          }),
        ]),
      ),
    ]),
  );
  // The break records a jump code instead of jumping; the dispatch performs the goto.
  assert.match(c, /= jsrt_number\(2\);/);
  const dispatch = c.search(/if \(jsrt_number_value\(.*\) == 2\) \{/);
  const jump = c.indexOf('goto brk_0;', dispatch);
  assert.ok(dispatch > -1 && jump > dispatch, 'the dispatch performs the break');
});

test('a break inside try/finally that targets a loop inside the same try does not route', () => {
  const brk = {
    kind: 'break-statement',
    type: H_NUMBER,
    span: span(1),
  } as const;
  const c = emitC(
    makeModule([
      tryStmt(block([whileStmt(bool(true), block([brk]))]), {
        finallyBlock: block([exprStmt(consoleLog([num(9)]), H_NUMBER)]),
      }),
    ]),
  );
  // The jump never leaves the protected code, so no completion code is allocated for it.
  assert.ok(!c.includes('= jsrt_number(2);'), 'no route for a jump that stays inside the try');
  assert.match(c, /goto brk_0;/);
});

// Task 4.1: the dynamic residue. A dyn-object-literal allocates through jsrt_dynobj_new and fills
// with NULL caches (construction transitions every time — the case the cache does not serve);
// every ACCESS site gets its own static JSRTIC, zero-initialized at file scope.
test('dynamic objects emit shape-table calls with per-site inline caches', () => {
  const unknown = hUnknown(false);
  const s = span(1);
  const module = makeModule([
    decl(
      'o',
      {
        kind: 'dyn-object-literal',
        type: unknown,
        span: s,
        entries: [{ name: 'x', value: num(1) }],
      },
      'const',
      unknown,
    ),
    {
      kind: 'dyn-field-assignment',
      type: H_NUMBER,
      span: s,
      target: id('o', unknown),
      field: 'y',
      value: num(2),
    },
    exprStmt(
      consoleLog([
        { kind: 'dyn-field-access', type: unknown, span: s, target: id('o', unknown), field: 'y' },
      ]),
      H_NUMBER,
    ),
  ]);
  const c = emitC(module);

  assert.match(c, /jsrt_dynobj_new\(\)/);
  // The literal's own store carries no cache; the assignment and the read each claim their own.
  assert.match(c, /jsrt_set_prop\([^\n]*"x"[^\n]*NULL\)/);
  assert.match(c, /jsrt_set_prop\([^\n]*"y"[^\n]*&_jsrt_ic_0\)/);
  assert.match(c, /jsrt_get_prop\([^\n]*"y"[^\n]*&_jsrt_ic_1\)/);
  // File-scope, static, zero-initialized: a NULL shape IS the empty cache.
  assert.match(c, /static _Thread_local JSRTIC _jsrt_ic_0;/);
  assert.match(c, /static _Thread_local JSRTIC _jsrt_ic_1;/);
});

test('an Unknown index site emits jsrt_dyn_index_* with a per-site cache', () => {
  const unknown = hUnknown(false);
  const s = span(1);
  const target = id('o', unknown);
  const index = str('x');
  const module = makeModule([
    decl(
      'o',
      {
        kind: 'dyn-object-literal',
        type: unknown,
        span: s,
        entries: [],
      },
      'let',
      unknown,
    ),
    exprStmt(
      {
        kind: 'index-access',
        type: unknown,
        span: s,
        target,
        index,
      },
      unknown,
    ),
    {
      kind: 'index-assignment',
      type: H_NUMBER,
      span: s,
      target,
      index,
      value: num(1),
    },
  ]);
  const c = emitC(module);
  assert.match(c, /jsrt_dyn_index_get\([^\n]*NULL\)/);
  assert.match(c, /jsrt_dyn_index_set\([^\n]*NULL\)/);
  assert.doesNotMatch(c, /jsrt_array_get\(/);
  assert.doesNotMatch(c, /jsrt_array_set\(/);
});
