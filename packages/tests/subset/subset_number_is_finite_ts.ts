// @mode: ts
// @verdict: dynamic
// SUBSET.md: `Number.isFinite(x)` and `Number.isNaN(x)` -- no ToNumber, unlike the globals

const loose: unknown = '3';
console.log(Number.isFinite(3), Number.isFinite(1 / 0), Number.isFinite(loose), isFinite(Number(loose)));
console.log(Number.isNaN(NaN), Number.isNaN(loose), Number.isNaN(0 / 0));
