// node:os (plan.md §11c T11.6): the members over `std/os`, through named imports and the default
// export. Every answer is printed as a value: Node runs on the same machine, so the two agree.
import os, {
  EOL,
  arch,
  availableParallelism,
  devNull,
  endianness,
  homedir,
  hostname,
  machine,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  version,
} from "node:os";

console.log(JSON.stringify(EOL), JSON.stringify(os.EOL), devNull, endianness());
console.log(platform(), os.platform() === platform(), arch(), os.arch() === arch());
console.log(type(), machine(), release());
console.log(version() === os.version(), version().length > 0);
console.log(hostname() === os.hostname(), homedir() === os.homedir(), tmpdir() === os.tmpdir());
console.log(hostname(), homedir(), tmpdir());
console.log(availableParallelism() >= 1, availableParallelism() === os.availableParallelism());
console.log(totalmem() > 0, totalmem() === Math.floor(totalmem()), os.totalmem() === totalmem());
console.log(version());
