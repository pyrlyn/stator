// node:os (plan.md §11c T11.6) in js mode: the default export, `require("os")`, and the
// members `tsc` reads (`EOL`, `platform`).
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
console.log(require("os") === os, require("node:os") === os);
console.log(JSON.stringify(os.EOL), os.platform(), os.type(), os.machine());
console.log(os.homedir() === require("os").homedir(), os.availableParallelism() > 0);
