/* Stator's Test262 host adapter: `$DONE` only.
 *
 * INTERPRETING.md makes `$DONE` the HOST's job and everything else the corpus's. This file is
 * `done.ts` (Task 6.15) and is concatenated raw into the test source, so it stays valid JavaScript:
 * no type annotations. It was once called `sta.js`, which reads as "the corpus's sta.js" while
 * actually replacing it, so `Test262Error` did not exist and every harnessed test failed to compile
 * on a defect of the runner's own (plan-notes 175). Never define a corpus name here. */
// The concatenated Test262 body calls this global; the harness never reads it itself.
// oxlint-disable-next-line no-unused-vars
var $DONE = (error) => {
  if (error !== undefined) throw error;
  console.log('Test262:AsyncTestComplete');
};
