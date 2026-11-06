// node:timers (plan.md §11c T11.6) in js mode: the global timer functions with no import,
// `require("timers")`, and the refresh/close members.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const timers = require("timers");
console.log(timers.setTimeout === setTimeout, require("node:timers") === timers);
const t = setTimeout(() => console.log("refreshed timer"), 5);
t.refresh();
const closed = setTimeout(() => console.log("never"), 1);
closed.close();
setImmediate(() => console.log("immediate"));
setTimeout(() => console.log("second"), 10);
console.log("sync");
