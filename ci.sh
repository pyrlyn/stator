#!/bin/sh
# What CI runs, runnable locally (plan.md §4 Task 1.0 step 10).
# The local mirror of .github/workflows/ci.yml, which runs the same steps FANNED OUT across
# platforms and jobs. Serial here on purpose: locally the first failure is the interesting one.
# Local clang is the LLVM 21.1.8 pin from mise.toml; CI uses the runner's clang.
set -eu

echo "node:  $(node --version)"
echo "clang: $(clang --version | head -1)"
echo "os:    $(uname -srm)"
echo

# Fail fast when bare `node` is not the pinned ground truth (plan.md Task 6.2a) — every
# suite below diffs against `.node-version`, so a run on another major proves nothing.
node scripts/check-node.ts

pnpm install --frozen-lockfile
pnpm run ci

# Zig suites (pyrlyn/stator#339): core, interp and zigdiff belong on every run; engine:test is
# nightly (GC-stress is too long for the PR job). `pnpm run ci` already built the runtime archive
# interp and zigdiff need.
pnpm run zig-core:test
pnpm run interp:test
zig build --build-file packages/compiler-zig/build.zig
pnpm run test:zigdiff

# Second job: the sanitized runtime build. Golden tests run against this once Phase 2
# lands them (plan.md §5 Task 2.7).
just -f packages/runtime/justfile -d packages/runtime runtime-asan
