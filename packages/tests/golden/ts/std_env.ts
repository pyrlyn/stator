// `std/env` (docs/STD.md §5): the process environment through `libjsrt_std.a`. The read key is
// `TZ`, which the golden runner pins to `UTC` on both sides (run.ts PINNED_ENV); the
// write/read/unset cycle uses a `STATOR_`-prefixed scratch name the runner never sets. The
// oracle side is golden/std-oracle/env.ts. `names()` is checked by membership and a filtered
// sort, never by the full list: libc `environ` order and Node's key order differ.
import { cwd, get, has, names, set, unset } from "std/env";
import { isAbsolute } from "std/path";

// Environment names use Node's default UTF-16 order, independent of the host locale.
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

console.log(get("TZ"), has("TZ"));
console.log(names().includes("TZ"), names().includes("STATOR_STD_ENV_SCRATCH"));
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
set("STATOR_STD_ENV_SCRATCH", "hello-std");
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
set("STATOR_STD_ENV_SCRATCH", "");
console.log("[" + (get("STATOR_STD_ENV_SCRATCH") ?? "unset") + "]", has("STATOR_STD_ENV_SCRATCH"));
console.log(names().includes("STATOR_STD_ENV_SCRATCH"), names().filter((n) => n.startsWith("STATOR_")).sort(compareNames).join(","));
unset("STATOR_STD_ENV_SCRATCH");
unset("STATOR_STD_ENV_SCRATCH");
console.log(get("STATOR_STD_ENV_SCRATCH"), has("STATOR_STD_ENV_SCRATCH"));
console.log(names().includes("STATOR_STD_ENV_SCRATCH"), names().filter((n) => n.startsWith("STATOR_")).sort(compareNames).join(","));
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
