/** plan.md §8 step 40: lowering diagnostics must carry the BUILD's mode in their label.
 *
 * Every `lower/` diagnostic is an internal STA4xxx raised after the gate, so lowering takes no
 * mode for behavior (plan §0.8) -- but the diagnostic's `mode` field is what `renderDiagnostic`
 * prints as `[ts]`/`[js]`, and it was hardcoded to `'ts'` at every call site. A js-mode build
 * that died in lowering therefore blamed `[ts]`.
 *
 * The pin below uses rest-in-pattern (`const [a, ...rest] = arr`): the declaration gate helper
 * `isSimpleBindingPattern` rejects it in lowering with STA4032, a path no other open step
 * touches (step 39 owns spread, not patterns), and one that fires identically in both modes when
 * the gate is bypassed -- so the only thing under test is the label. The gate is bypassed
 * deliberately: these are labeling tests, not accepted input. (Nested patterns landed in H1;
 * rest-in-pattern remains the STA4032 vehicle.)
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { lowerSourceFile } from '../../compiler/src/lower/index.ts';
import { createProgram } from './helpers.ts';

const REST_PATTERN =
  'const arr: number[] = [1, 2, 3];\nconst [a, ...rest] = arr;\n';

function lowerModes(): { tsMode: string | undefined; jsMode: string | undefined } {
  let tsMode: string | undefined;
  let jsMode: string | undefined;
  for (const mode of ['ts', 'js'] as const) {
    const { program, sourceFile } = createProgram(REST_PATTERN, '/t.ts');
    const { diagnostics } = lowerSourceFile(sourceFile, program.getTypeChecker(), mode);
    assert.equal(diagnostics.length, 1, `expected one diagnostic in ${mode} mode`);
    const diagnostic = diagnostics[0];
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.code, 'STA4032', `expected STA4032 in ${mode} mode`);
    if (mode === 'ts') {
      tsMode = diagnostic.mode;
    } else {
      jsMode = diagnostic.mode;
    }
  }
  return { tsMode, jsMode };
}

test('lowering labels its diagnostic [ts] under ts mode', () => {
  assert.equal(lowerModes().tsMode, 'ts');
});

test('lowering labels the same diagnostic [js] under js mode', () => {
  assert.equal(lowerModes().jsMode, 'js');
});
