// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Uint8Array and ArrayBuffer
// An instance field on a class extending `Uint8Array`: a view has no field slots to hold it
// (plan/T11.6a).
class Tagged extends Uint8Array {
  tag = 'x';
}
console.log(new Tagged(1).tag);
