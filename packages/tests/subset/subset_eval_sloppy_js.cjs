// @mode: js
// @verdict: not-yet
// @code: STA1206
// SUBSET.md: eval() function — a direct eval in sloppy (CommonJS) code, whose `var`s would join
// the caller's scope; the interpreter runs only strict eval code yet.

eval("var leaked = 1");
