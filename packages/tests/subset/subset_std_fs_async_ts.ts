// @mode: ts
// @verdict: static
import { readTextAsync } from "std/fs";

async function main(): Promise<void> {
  console.log(await readTextAsync("/etc/hosts"));
}

void main();
