// @mode: js
// @verdict: dynamic
import { writeTextAsync } from "std/fs";

async function main() {
  await writeTextAsync("/tmp/stator-subset-never-written.txt", "x");
}

main();
