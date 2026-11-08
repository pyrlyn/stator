// @mode: js
// @verdict: dynamic
// SUBSET.md: eval() function — a direct eval in CommonJS code under "use strict" is strict eval
// code, which the interpreter runs.

"use strict";
console.log(eval("1 + 1"));
