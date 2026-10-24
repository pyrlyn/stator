# Roadmap

Approved work that is not in `plan.md` yet.

**Nothing is waiting here (swept 2026-10-24).** Everything the previous roadmap pointed at has
either landed or been promoted to a task card:

- Phase 5 step 12 (c)–(f) residue → **T27** (class object / static-`this`), **T28** (generics
  remainder), **T29** (nested rest/computed-key patterns), **T32** (abstract accessors),
  **T34** (`Function.prototype.bind`).
- Phase 6 leftovers → **T30** (Task 6.16 clone baseline to zero), **T31** (Task 6.3 noise
  floor on the weekly runner). The nightly fuzzing clause is now cited in `plan-notes.md`
  (nightly `40072874719`: 1h11m, 5177 cases, 0 divergences) — Phase 6 stays open only on
  those two cards and standing Test262 tracking.
- §12 Ryū → **T33** (vendor Ryū; number printing).
- Phase 7 FFI is complete (spec stays in `plan.md` §10).
- Phase 8 stays **gated** on a named user — not carded; "do not build speculatively."
- Phases 9–14 stay open where their task headings are not struck through (T10.2, T11.4,
  T11.6, T11.7, T12.3, T13.x, T14.x). Phase 9's T9.1 and T10.1/T10.3's C1 have landed.
- The cloud-review table rows are struck (T21–T26); T15–T20 are in `done.md`.

`todo.md` lists open cloud-review rows only. Struck-through tasks stay in `plan.md` as
one-line stubs; their evidence is in `done.md`.
