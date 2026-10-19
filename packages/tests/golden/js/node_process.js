// @args: one two
// node:process (plan.md §11c T11.6) in js mode: the global `process` with no import, the
// default import, `require("process")`, and `nextTick`'s extra arguments. The runner passes the
// `@args` line to both runs.
import { createRequire } from "node:module";
import proc from "node:process";

const require = createRequire(import.meta.url);
console.log(process === proc, require("process") === process, require("node:process") === process);
console.log(process.argv.slice(2), process.argv.length);
process.env.STATOR_NODE_PROCESS_JS = "js";
console.log(process.env.STATOR_NODE_PROCESS_JS, typeof process.env.TZ);
delete process.env.STATOR_NODE_PROCESS_JS;
console.log(process.env.STATOR_NODE_PROCESS_JS);
process.nextTick((a, b) => console.log("tick", a, b), 1, "two");
process.nextTick(() => console.log("exit code", process.exitCode));
process.exitCode = 0;
console.log(typeof process.memoryUsage().heapUsed, process.stdout.write("w\n"));
