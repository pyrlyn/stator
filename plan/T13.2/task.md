---
status: todo
priority: P3
complexity: 4
readiness: 0%
agent:
---

# T13.2. `packages/webapi`: CSS

Depends on T13.1. Parsing, selector matching, cascade, inheritance and computed style for the
T13.0 §4 subset; `getComputedStyle`; `<style>` and inline `style`.

**Check:** the T13.0 CSS oracle slice passes (computed values byte-for-byte); a selector-matching
benchmark over a 10 000-element tree is recorded in `packages/tests/bench/`.
