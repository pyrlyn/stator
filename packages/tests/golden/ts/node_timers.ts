// node:timers (plan.md §11c T11.6): timeouts, intervals and immediates without an event loop,
// through the module and the globals `--node` imports from it. The order is what is checked:
// promise jobs and `nextTick` callbacks drain between any two timer callbacks, timers fire in
// due order, and an immediate queued from a timer runs before the next timer. Due times are
// spaced 6 ms or more apart, so a late wake-up cannot reorder them.
import timers, { clearTimeout as clear, setTimeout as later } from "node:timers";

const log: string[] = [];
const say = (line: string): void => {
  log.push(line);
  console.log(line);
};

console.log(later === setTimeout, timers.setTimeout === setTimeout, timers.clearTimeout === clear);
const start = Date.now();
setTimeout(() => say("60ms"), 60);
setTimeout(() => {
  say("10ms");
  void Promise.resolve(0).then(() => say("promise after 10ms"));
  setImmediate(() => say("immediate from 10ms"));
}, 10);
setTimeout((a: unknown, b: unknown) => say(`args ${String(a)} ${String(b)}`), 20, 1, "two");
const cancelled = setTimeout(() => say("never"), 5);
clearTimeout(cancelled);
clear(undefined);
clearTimeout(null);

let ticks = 0;
// A `const` read inside its own initializer's callback is a TDZ error in this subset.
let interval: ReturnType<typeof setInterval> | undefined;
interval = setInterval(() => {
  ticks++;
  say(`interval ${ticks}`);
  if (ticks === 3) clearInterval(interval);
}, 22);

const unrefed = setTimeout(() => say("unref'd but due early"), 1).unref();
console.log(unrefed.hasRef(), unrefed.ref().hasRef(), unrefed.unref().hasRef());
const lingering = setTimeout(() => say("left unref'd"), 1000);
lingering.unref();

const gone = setImmediate(() => say("cleared immediate"));
clearImmediate(gone);

setTimeout(() => {
  const elapsed = Date.now() - start;
  say(`last ${elapsed >= 90 ? "after 90ms" : `early: ${elapsed}`}`);
  console.log(log.length);
}, 90);
void Promise.resolve(0).then(() => say("first promise"));
console.log("sync done");
