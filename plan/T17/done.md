# T17. Closing report

**`"".repeat` with a huge count no longer hangs or runs an undefined cast**

`packages/runtime/src/jsrt_string_ops.c` `jsrt_string_repeat` checked only `count * str->length > JSRT_MAX_STRING_LENGTH`: an empty receiver makes that product zero for any count, so `"".repeat(4294967295)` fell into a 4294967295-iteration loop over zero bytes (Node answers `""` instantly) and a count past UINT32_MAX reached `(uint32_t)count`, undefined by C11 §6.3.1.4. Found by the 2026-10-07 audit (task T17 of the audit set; the plan-table rows ride the in-flight plan restructure). Fix: an empty receiver returns itself before anything else, and a count past UINT32_MAX throws the spec's `Invalid string length` before the cast — keeping the length cap's coverage of the cast true by construction.
Model: ZCode / GLM-5.3 · Status: done 2026-10-07 · Priority: P1 · Complexity: 1 · Files: `packages/runtime/src/jsrt_string_ops.c`, `packages/tests/golden/{js,ts}/string_range_error.ts`
Check: `moon run tests:golden -- --filter string_range_error` — both fixtures' full outputs match Node, including the new `"".repeat(4294967295)` and `"".repeat(2**53)` cases (the full golden pass: 463/463).
