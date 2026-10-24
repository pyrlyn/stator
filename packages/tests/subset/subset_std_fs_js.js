// @mode: js
// @verdict: static
// SUBSET.md: std/* imports — sync, path-only `std/fs` (docs/STD.md §5); proved by the `std_fs`
// golden.
import { readText, stat } from "std/fs";

const s = stat("/");
console.log(s.isDirectory, readText.length);
