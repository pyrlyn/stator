---
status: todo
priority: P3
complexity: 2
readiness: 0%
agent:
---

# T13.5. `docs/WEBAPI.md`: generated Web API coverage

Depends on T13.0; lands before T13.1 claims its first member. The Web-platform counterpart of
`docs/NODE.md` (AGENTS.md rule 11): coverage in % per area, interface and member, generated, and
checked in `ci`.

- **The denominator comes from a pinned source, not a hand list.** Every interface in
  `lib.dom.d.ts` from the pinned `typescript` (6.0.3 ships it: 1 520 top-level `interface`
  declarations), with its constructor, static and instance members, read through the TypeScript
  API. No new dependency, and a `typescript` bump moves the denominator visibly. As with
  `NODE.md`, forgetting a member cannot raise the percentage.
- **Grouped by area.** DOM and CSSOM (CSSOM View included) come first, because those are the rows
  this phase delivers; everything else sits under one "other Web APIs" heading. The interface →
  area map is checked in next to the claims, and an interface missing from it is a generator
  error, not a silent "other". If that map cannot be kept honest by hand, T13.0 may pick
  `@webref/idl` (W3C Webref's per-spec IDL) as the source instead: a new dev dependency with its
  own plan-notes entry.
- **The numerator comes from claims.** `packages/tests/golden/webapi_coverage.json` maps interface
  → member → the fixtures that prove it against T13.0 §8's oracle, or to `{ "not-yet": "T13.x" }`.
  A claim whose fixture is missing or never mentions the member fails the generator, as
  `coverage-claims.ts` already does for Node.
- **One generator, not two.** Table rendering, the staleness check and claim validation are shared
  with `node-coverage.ts` through one extracted helper (`pnpm run dupes`); only the denominator
  readers differ.
- `pnpm run docs:webapi` writes the file; `pnpm run test:webapi-coverage` (in `ci`, and a moon
  task beside `node-coverage`) fails when it is stale. AGENTS.md gains rule 12 mirroring rule 11;
  `docs/README.md` lists the file as generated.

**Check:** `pnpm run test:webapi-coverage` passes on a fresh tree and fails after a hand edit of
`docs/WEBAPI.md`; before T13.1 the doc shows 0% over the full denominator; a claim naming a
missing fixture fails with the claim's path.
