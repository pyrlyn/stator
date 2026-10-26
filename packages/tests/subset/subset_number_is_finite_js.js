// @mode: js
// @verdict: static
// SUBSET.md: `Number.isFinite(x)` and `Number.isNaN(x)` -- no ToNumber, unlike the globals

const loose = '3';
console.log(Number.isFinite(3), Number.isFinite(1 / 0), Number.isFinite(loose), isFinite(loose));
console.log(Number.isNaN(NaN), Number.isNaN('x'), Number.isNaN(0 / 0));
