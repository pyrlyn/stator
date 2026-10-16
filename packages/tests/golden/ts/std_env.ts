// `std/env` (docs/STD.md §5): the process environment through `libjsrt_std.a`. The read key is
// `TZ`, which the golden runner pins to `UTC` on both sides (run.ts PINNED_ENV); the
// write/read/unset cycle uses a `STATOR_`-prefixed scratch name the runner never sets. The
// oracle side is golden/std-oracle/env.ts.
import { cwd, get, has, names, set, unset } from "std/env";
import { isAbsolute } from "std/path";

console.log(get("TZ"), has("TZ"));
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
set("STATOR_STD_ENV_SCRATCH", "hello-std");
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
// The rest of the environment is the host's, so only membership is printed.
const listed = names();
console.log(listed.includes("TZ"), listed.includes("STATOR_STD_ENV_SCRATCH"), listed.length > 1);
set("STATOR_STD_ENV_SCRATCH", "");
console.log("[" + (get("STATOR_STD_ENV_SCRATCH") ?? "unset") + "]", has("STATOR_STD_ENV_SCRATCH"));
unset("STATOR_STD_ENV_SCRATCH");
unset("STATOR_STD_ENV_SCRATCH");
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
console.log(names().includes("STATOR_STD_ENV_SCRATCH"), names().every((name) => has(name)));
console.log(isAbsolute(cwd()));

function attempt(label: string, body: () => void): void {
  try {
    body();
    console.log(label + ": no throw");
  } catch (e) {
    if (e instanceof Error) {
      console.log(label + ": " + e.message);
    }
  }
}

attempt("empty name", () => set("", "x"));
attempt("name with =", () => set("A=B", "x"));
attempt("unset empty", () => unset(""));
