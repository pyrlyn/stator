/* The shadow-frame audit (plan.md §7 Task 4.5): the emitted C is diffed against itself.
 *
 * `JSRT_FRAME(n)` declares n rooted slots and is written ONCE, at the top of a function, before a
 * line of the body exists — so n is decided by a counting pass and the body is emitted against
 * whatever that pass decided. Nothing in the C compiler checks the two agree. The collector also
 * scans the C stack conservatively (plan/T66), so they can disagree for a long time without a
 * symptom: it finds the value anyway. It stops being invisible when §12's precise GC lands, which is exactly
 * the moment the discipline exists to survive (docs/VALUE.md §4, AGENTS.md).
 *
 * So this test reads the generated C for every golden fixture and holds it to three invariants:
 *
 *   1. Every `JSRT_LOCAL(i)` a function emits is inside its own frame. A slot past the end is a
 *      buffer overrun on the C stack — the one failure here that is memory corruption, not waste.
 *   2. The slots a function uses are exactly 0..n-1, with a floor of one slot for a function that
 *      roots nothing (a zero-length array is not valid C11). A gap is a slot the frame roots and
 *      nothing writes; it is harmless today and is how a counting pass drifts out of step with the
 *      emitter it is supposed to describe.
 *   3. Every path leaving a framed function pops it — every `return`, and the fallthrough. A
 *      missed pop leaves `jsrt_frame_top` pointing at dead stack.
 *
 * The corpus is the golden fixtures rather than hand-built HIR: they are the programs whose OUTPUT
 * is already proven against Node, so a frame bug found here is a frame bug in code that runs.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { emitC } from '../../compiler/src/codegen/index.ts';
import { assertReturnsPopFrame, lowerSource, splitEmittedFunctions } from './helpers.ts';
import type { EmittedFunction } from './helpers.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'ts');

/* Splits the emitted C into function bodies: the internal units and `main`, which is the
 * corpus the three invariants below hold over. */
function functionsIn(c: string): EmittedFunction[] {
  return splitEmittedFunctions(c, (line) => {
    const start =
      /^(?:static jsrt_value (_jsrt_fn_\d+)\(uint32_t|(int main)\(int argc, char \*\*argv\))/.exec(
        line,
      );
    if (start === null) {
      return undefined;
    }
    return start[1] ?? 'main';
  });
}

function indices(body: string, macro: string): number[] {
  return [...body.matchAll(new RegExp(`${macro}\\((\\d+)\\)`, 'g'))].map((m) => Number(m[1]));
}

/* The one slot the counting pass MUST reserve without knowing whether it will be written: a
 * try/finally's exception stash. Whether the finally can be entered by a throw is decided while
 * EMITTING the try body — a label is marked used or it is not — which is long after JSRT_FRAME(n)
 * has to be final. Predicting it at counting time would mean a second copy of the unwind analysis
 * drifting from the first, which is the failure this test exists to catch. So it is counted here
 * instead: one allowance per finally whose throw path never armed. */
function conservativeSlots(body: string): number {
  const finallies = (body.match(/^\s*_jsrt_fin_\d+: ;$/gm) ?? []).length;
  const armed = (body.match(/^\s*_jsrt_finthr_\d+: ;$/gm) ?? []).length;
  return finallies - armed;
}

/** Every fixture that lowers on its own — the multi-file ones are directories and the class-heavy
 * ones need the whole-program path this helper does not take; what is left is still 40+ programs
 * covering closures, exceptions, loops, generics and every builtin family. */
function corpus(): { name: string; c: string }[] {
  const out: { name: string; c: string }[] = [];
  for (const name of readdirSync(GOLDEN).sort()) {
    const path = join(GOLDEN, name);
    if (!name.endsWith('.ts') || statSync(path).isDirectory()) {
      continue;
    }
    try {
      out.push({ name, c: emitC(lowerSource(readFileSync(path, 'utf8')).module) });
    } catch {}
  }
  assert.ok(out.length > 20, `expected the golden corpus, got ${String(out.length)} fixtures`);
  return out;
}

const EMITTED = corpus();

test('every emitted slot is inside the frame that roots it', () => {
  for (const { name, c } of EMITTED) {
    for (const fn of functionsIn(c)) {
      const frame = /JSRT_FRAME\((\d+)\)/.exec(fn.body);
      const used = indices(fn.body, 'JSRT_LOCAL');
      if (frame === null) {
        assert.deepEqual(used, [], `${name}:${fn.name} uses JSRT_LOCAL without a frame`);
        continue;
      }
      const size = Number(frame[1]);
      for (const slot of used) {
        assert.ok(
          slot < size,
          `${name}:${fn.name} writes JSRT_LOCAL(${String(slot)}) into a frame of ${String(size)}`,
        );
      }
    }
  }
});

test('a frame is exactly as large as the locals it roots', () => {
  for (const { name, c } of EMITTED) {
    for (const fn of functionsIn(c)) {
      const frame = /JSRT_FRAME\((\d+)\)/.exec(fn.body);
      if (frame === null) {
        continue;
      }
      const size = Number(frame[1]);
      const used = new Set(indices(fn.body, 'JSRT_LOCAL'));
      if (used.size === 0) {
        // The floor: a function that roots nothing still declares one slot, because C11 has no
        // zero-length array — the same rule JSRT_GLOBALS(n) follows.
        assert.equal(size, 1, `${name}:${fn.name} declares ${String(size)} slots and roots none`);
        continue;
      }
      // Every unwritten slot beyond the try/finally allowance is a bug.
      const unwritten = [...Array(size).keys()].filter((slot) => !used.has(slot));
      assert.equal(
        unwritten.length,
        conservativeSlots(fn.body),
        `${name}:${fn.name} roots slots [${unwritten.join(', ')}] that nothing writes`,
      );
    }
  }
});

test('the module frame is exactly as large as the globals it roots', () => {
  for (const { name, c } of EMITTED) {
    // An async module keeps named bindings in the globals array and temps in a heap environment
    // (Phase 5 step 9). Slot accounting is not "every declared global is written in main".
    if (c.includes('jsrt_async_start')) {
      continue;
    }
    const declared = [...c.matchAll(/JSRT_GLOBALS(?:_ENTER)?\((\d+)\)/g)].map((m) => Number(m[1]));
    // Declared once and entered once, with the same count: two macros, one array.
    assert.equal(declared.length, 2, `${name} declares ${String(declared.length)} globals frames`);
    assert.equal(declared[0], declared[1], `${name} enters a globals frame of a different size`);
    // Globals are read from every function, so the used set is the whole file's; the allowance is
    // main's, because a module-level try/finally stashes its exception in a global.
    const size = declared[0] ?? 0;
    const used = new Set(indices(c, 'JSRT_GLOBAL'));
    if (used.size === 0) {
      assert.equal(size, 1, `${name} declares ${String(size)} globals and roots none`);
      continue;
    }
    const main = functionsIn(c).find((fn) => fn.name === 'main');
    assert.ok(main !== undefined, `${name} emits no main`);
    const unwritten = [...Array(size).keys()].filter((slot) => !used.has(slot));
    assert.equal(
      unwritten.length,
      conservativeSlots(main.body),
      `${name} roots globals [${unwritten.join(', ')}] that nothing writes`,
    );
  }
});

test('every path out of a framed function pops its frame', () => {
  for (const { name, c } of EMITTED) {
    for (const fn of functionsIn(c)) {
      if (!fn.body.includes('JSRT_FRAME(')) {
        continue;
      }
      assertReturnsPopFrame(fn.body, `${name}:${fn.name}`);
    }
  }
});
