/* The Node oracle path (plan.md §9 Task 6.5).
 *
 * Invariant: oracle spawns (running a fixture under Node for ground truth) MUST use
 * `nodePath()`; compiler-host spawns (running `packages/compiler/src/cli/main.ts`, a `.ts`
 * file the host type-strips) keep `process.execPath`. Eight sites used `process.execPath`
 * for both, so under any non-Node host the ground truth silently became that host instead
 * of the pinned Node — which is the whole point `scripts/check-node.ts` guards.
 */
export function nodePath(): string {
  const override = process.env['STATOR_NODE'];
  return override !== undefined && override !== '' ? override : process.execPath;
}
