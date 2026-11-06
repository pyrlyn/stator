// node:perf_hooks (plan.md §11c T11.6): `performance` as `tsc` uses it — `now`, `mark`,
// `measure`, `clearMarks`, `clearMeasures` — and the global `performance` under `--node`. Times
// are host-dependent, so they print as shapes.
import perfHooks, { Performance, PerformanceEntry, performance as perf } from "node:perf_hooks";

console.log(perf === performance, perfHooks.performance === perf);
console.log(typeof perf.timeOrigin, perf.timeOrigin > 1.7e12, perf.timeOrigin <= Date.now());
const t0 = performance.now();
console.log(typeof t0, t0 >= 0);
const before = perf.mark("before");
console.log(before.name, before.entryType, before.duration, before.startTime >= t0);
console.log(perf instanceof Performance, before instanceof PerformanceEntry);
let sum = 0;
for (let i = 0; i < 100000; i++) sum += i;
console.log(sum);
perf.mark("after");
const between = perf.measure("work", "before", "after");
console.log(between.name, between.entryType, between.duration >= 0, between.startTime === before.startTime);
const sinceStart = perf.measure("total");
console.log(sinceStart.startTime, sinceStart.duration >= between.duration);
const toNow = perf.measure("tail", "after");
console.log(toNow.duration >= 0);
console.log(perf.getEntries().map((e) => `${e.entryType}:${e.name}`).join(" "));
console.log(perf.getEntriesByType("mark").length, perf.getEntriesByType("measure").length);
console.log(perf.getEntriesByName("work").length, perf.getEntriesByName("work", "mark").length);
perf.mark("before");
console.log(perf.getEntriesByName("before").length);
perf.clearMarks("before");
console.log(perf.getEntriesByType("mark").map((e) => e.name).join(","));
perf.clearMeasures("work");
console.log(perf.getEntriesByType("measure").map((e) => e.name).join(","));
perf.clearMarks();
perf.clearMeasures();
console.log(perf.getEntries().length);
try {
  perf.measure("broken", "missing");
} catch (e) {
  console.log((e as Error).message);
}
console.log(performance.now() >= t0);
