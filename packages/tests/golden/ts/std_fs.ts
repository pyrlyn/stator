// `std/fs` (docs/STD.md §5): sync text and byte files, directories, and descriptors through
// `libjsrt_std.a`. Everything happens under one scratch directory named by the pid, so parallel
// runs never meet, and the fixture removes what it made. Every failure message carries the POSIX
// errno name the oracle reads off Node's `error.code` (golden/std-oracle/fs.ts).
import {
  close,
  exists,
  mkdir,
  open,
  read,
  readBytes,
  readdir,
  readText,
  realpath,
  rmdir,
  stat,
  unlink,
  utimes,
  write,
  writeText,
} from "std/fs";
import { join } from "std/path";
import { pid } from "std/process";

const dir = join("/tmp", `stator_std_fs_${pid()}`);

// The descriptor `open` answered, once there is one: its number differs between the two sides.
let openFd = -100;

function mask(text: string, needle: string, label: string): string {
  const at = text.indexOf(needle);
  return at < 0 ? text : text.slice(0, at) + label + text.slice(at + needle.length);
}

function attempt(label: string, body: () => void): void {
  try {
    body();
    console.log(label + ": no throw");
  } catch (e) {
    if (e instanceof Error) {
      // The scratch path holds the pid, which differs between the two sides.
      console.log(label + ": " + mask(mask(e.message, dir, "<dir>"), `(${openFd})`, "(<fd>)"));
    }
  }
}

mkdir(dir);
const file = join(dir, "note.txt");
writeText(file, "héllo, std\nline two\n");
console.log(JSON.stringify(readText(file)));
writeText(file, "");
console.log(JSON.stringify(readText(file)));
writeText(file, "€ and 😀");
const text = readText(file);
console.log(text, text.length);

const f = stat(file);
console.log(f.size, f.isFile, f.isDirectory, f.mtimeMs === Math.floor(f.mtimeMs), f.mtimeMs > 0);
const d = stat(dir);
console.log(d.isFile, d.isDirectory);

const missing = join(dir, "missing.txt");
attempt("read missing", () => readText(missing));
attempt("stat missing", () => stat(missing));
attempt("write into missing dir", () => writeText(join(missing, "x.txt"), "x"));
attempt("mkdir existing", () => mkdir(dir));
attempt("mkdir under missing", () => mkdir(join(missing, "sub")));
attempt("rmdir non-empty", () => rmdir(dir));
attempt("rmdir a file", () => rmdir(file));
attempt("unlink missing", () => unlink(missing));

// Descriptors: open, positional and sequential reads and writes, every byte including a NUL.
const bin = join(dir, "data.bin");
const fd = open(bin, "w+");
openFd = fd;
console.log(fd > 2, write(fd, new Uint8Array([104, 0, 105, 255, 10])));
console.log(read(fd, 16, 0), read(fd, 16));
console.log(write(fd, new Uint8Array([65, 66]), 1), read(fd, 3, 0));
close(fd);
attempt("close twice", () => close(fd));
attempt("read closed", () => read(fd, 1));
attempt("write closed", () => write(fd, new Uint8Array([1])));
attempt("read bad position", () => read(0, 1, -2));
attempt("read negative fd", () => read(-1, 1));
console.log(readBytes(bin), JSON.stringify(readText(bin)));
const appender = open(bin, "a");
write(appender, new Uint8Array([33]));
close(appender);
const reader = open(bin);
console.log(read(reader, 64));
close(reader);
attempt("open missing", () => open(missing));
attempt("open bad flags", () => open(bin, "rw"));
attempt("open exclusive", () => open(bin, "wx"));
attempt("readBytes missing", () => readBytes(missing));

// Directory listing in byte order, existence, canonical paths and timestamps.
writeText(join(dir, "b.txt"), "b");
writeText(join(dir, "C.txt"), "C");
writeText(join(dir, "a.txt"), "a");
writeText(join(dir, "é.txt"), "e");
console.log(readdir(dir));
attempt("readdir a file", () => readdir(file));
attempt("readdir missing", () => readdir(missing));
console.log(exists(dir), exists(file), exists(missing), exists(join(file, "x")));
const real = realpath(join(dir, "."));
console.log(real === realpath(dir), real.endsWith(dir.slice(dir.lastIndexOf("/"))));
attempt("realpath missing", () => realpath(missing));
utimes(file, 1000, 1700000000123);
console.log(stat(file).mtimeMs);
attempt("utimes missing", () => utimes(missing, 0, 0));
attempt("utimes out of range", () => utimes(file, 0, 1e16));
// A NUL in a path or a flag string is EINVAL, never a cut: the C string would end there and
// name another file, so `victim.txt\0.tmp` must not reach `victim.txt`. The message shows the
// NUL as `\0`, because a NUL in console output proves nothing either way.
const victim = join(dir, "victim.txt");
writeText(victim, "keep");
function attemptNul(label: string, body: () => void): void {
  try {
    body();
    console.log(label + ": no throw");
  } catch (e) {
    if (e instanceof Error) {
      console.log(label + ": " + mask(e.message, dir, "<dir>").replaceAll("\u0000", "\\0"));
    }
  }
}
const cut = victim + "\u0000.tmp";
attemptNul("unlink with NUL", () => unlink(cut));
attemptNul("writeText with NUL", () => writeText(cut, "gone"));
attemptNul("readText with NUL", () => readText(cut));
attemptNul("readBytes with NUL", () => readBytes(cut));
attemptNul("stat with NUL", () => stat(cut));
attemptNul("open with NUL", () => open(cut));
attemptNul("open NUL flags", () => open(victim, "r\u0000+"));
attemptNul("mkdir with NUL", () => mkdir(cut));
attemptNul("rmdir with NUL", () => rmdir(cut));
attemptNul("readdir with NUL", () => readdir(dir + "\u0000x"));
attemptNul("realpath with NUL", () => realpath(cut));
attemptNul("utimes with NUL", () => utimes(cut, 0, 0));
console.log(exists(cut), exists(victim), JSON.stringify(readText(victim)));
unlink(victim);

for (const name of ["b.txt", "C.txt", "a.txt", "é.txt", "data.bin"]) {
  unlink(join(dir, name));
}

const sub = join(dir, "sub");
mkdir(sub);
console.log(stat(sub).isDirectory, readdir(sub));
rmdir(sub);
unlink(file);
rmdir(dir);
attempt("stat removed", () => stat(dir));
