---
status: todo
priority: P3
complexity: 4
readiness: 0%
agent:
---

# T13.0. Design: the render API and the DOM/CSS subset

Docs first (§15.6): `docs/WEBAPI-DESIGN.md`, settled with a measured spike. The spike renders one fixture
(a flex row, text, a border, a scroll container) through `renderer-clay` and dumps Clay's render
commands. Questions it must answer:

1. **Where layout lives.** Clay is a layout engine: it takes a tree of sized boxes and returns
   positioned render commands (rectangle, border, text, image, scissor start/end, custom). Either
   `webapi` hands the renderer a styled box tree and the renderer lays it out, or `webapi` lays out
   and the renderer only draws. Pick one, and say how `getBoundingClientRect` and hit testing get
   their geometry back.
2. **The render API.** The `Renderer` interface (`webapi` owns it; renderers implement it):
   frame begin/end, the tree or command format, text measurement (Clay asks for it through
   `Clay_SetMeasureTextFunction`), images and fonts as resources, input events coming back, and
   damage tracking (Clay commands carry element ids so unchanged ones can be skipped). A renderer
   is chosen at **build** time (`--renderer=clay|<package>`, default `clay`) and linked statically,
   because typed code has no run-time plugin loading. A missing renderer package is a `STA0xxx`
   naming it, allocated in `docs/DIAGNOSTICS.md`.
3. **The DOM subset.** First: `Node`, `Element`, `Text`, `Document`, tree mutation, attributes,
   `classList`, `textContent`, `querySelector(All)`, events with capture and bubble, `style`,
   `getBoundingClientRect`. What is a `not-yet` diagnostic (the T11.5 pattern, so `explain` lists
   the gap) and what is never planned.
4. **The CSS subset and its Clay mapping.** Selectors (type, class, id, descendant, child),
   specificity, cascade, inheritance, computed values. Layout properties map onto Clay's model:
   `display: flex` direction, `gap` → `childGap`, `padding`, `width`/`height` → fixed / percent /
   grow (`flex-grow`) / fit (`auto`), alignment, `overflow: scroll` → Clay scroll containers,
   `position: absolute` → Clay floating elements. Plus colors, borders, `border-radius`, fonts.
   Write the table of properties Clay cannot express, and what each one does instead.
5. **How a program reaches it.** Explicit imports (`import { document } from 'webapi'`) or a
   platform flag that makes `document`/`window` global, parallel to `--node` (§11c). Both modes.
6. **The drawing backend.** Clay does not draw. Its repository ships renderers for raylib, SDL2,
   SDL3, sokol, cairo, GLES3, win32 GDI, termbox2, terminal, web and Playdate. Pick the first one
   for macOS, Linux and Windows (§0.5's cross-platform rule), what it adds to the toolchain, and
   whether a terminal backend serves as the headless test target.
7. **The frame loop.** Input events and redraw need a loop. Either wait for N2's own loop
   (§11c, Zig) or run a frame loop inside the renderer first, and say how it hands events to the
   promise/microtask machinery (Task 4.6) without becoming a second event loop.
8. **The oracle.** Node has no DOM. DOM semantics: a web-platform-tests (WPT) slice, pinned the
   way Test262 is (Task 6.1, `packages/tests/test262/pin.json`), or a DOM implementation run under Node as a **dev-only** oracle
   (allowed: an oracle is not our source, §0.10). Layout: box geometry compared with a headless
   browser, with the tolerance written down, because Clay's model is not CSS layout.
9. **Parsing CSS.** An existing parser is JavaScript and cannot ship in `webapi` (§0.10). Confirm
   there is no strict-TS one that Stator compiles; otherwise write one per CSS Syntax Level 3 and
   say why in plan-notes.

**Check:** `docs/WEBAPI-DESIGN.md` answers 1–9 with the spike's numbers; plan-notes records the choices;
T13.1–T13.5 are edited to match; `docs/README.md` lists the new doc.
