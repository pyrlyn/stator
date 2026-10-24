// @mode: ts
// @verdict: static
// SUBSET.md: std/* imports — `std/fs`'s T11.3 members: descriptors and bytes (docs/STD.md §5);
// proved by the `std_fs` golden.
import { close, exists, open, read, readBytes, readdir, realpath, utimes, write } from "std/fs";

const fd = open("/dev/null", "r+");
console.log(write(fd, new Uint8Array([1, 2])), read(fd, 4).length, readBytes("/dev/null").length);
close(fd);
console.log(exists("/"), realpath("/").length, readdir("/").length > 0, utimes.length);
