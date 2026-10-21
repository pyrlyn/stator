// Node-side bindings for the extern_strstr golden (packages/tests/golden/run.ts): the same
// calls the Stator side makes as direct C calls, spelled in JS. strstr IS indexOf+slice on
// ASCII — byte comparison, locale-independent — and the empty needle returns the haystack
// on both sides (C 7.24.5.7; indexOf("") is 0). The `@statorError null` mirror re-spells
// the convention check and its message, so a divergence in Stator's check — a missing
// throw, a different message — still fails the diff. A miss never reaches the plain
// binding: C returns NULL there, which the boundary asserts on instead of converting, so
// the shim throws rather than invent a value for an unrepresentable path.
globalThis.strstr2 = (haystack, needle) => {
  const at = haystack.indexOf(needle);
  if (at === -1) throw new Error('strstr2 shim: miss is unrepresentable — C returns NULL');
  return haystack.slice(at);
};
globalThis.strstrChecked = (haystack, needle) => {
  const at = haystack.indexOf(needle);
  if (at === -1) throw new Error("extern call 'strstrChecked' failed: NULL return");
  return haystack.slice(at);
};
