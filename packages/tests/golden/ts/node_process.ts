// node:process under --node (plan.md §11c T11.6): the members `tsc` reads, against the pinned
// Node byte for byte. Nothing printed is machine-unique: pid/ppid are compared as predicates,
// hrtime as a shape, and argv as its Node single-executable layout (docs/MODES.md §6). The
// memoryUsage heap fields stay 0 on Stator (subset gap), so the golden prints their type only.
import process, {
  arch,
  argv,
  cwd,
  env,
  hrtime,
  memoryUsage,
  pid,
  platform,
} from 'node:process';

console.log(platform, arch);
console.log(typeof pid, pid > 0, typeof process.pid, process.pid === pid);
console.log(process.argv === argv, argv.length >= 2, typeof argv[0], typeof argv[1]);
const a0 = argv[0] ?? '';
console.log(a0.length > 0, a0.startsWith('/'));
console.log(env === process.env, typeof env.PATH, env.TZ !== undefined);
console.log(cwd() === process.cwd(), cwd().startsWith('/'));
console.log(process.execPath.startsWith('/'));
console.log(process.exitCode);
process.exitCode = 1;
console.log(process.exitCode);
process.exitCode = 0;
console.log(process.exitCode);
process.exitCode = undefined;
console.log(process.exitCode);
const t = hrtime();
console.log(t.length, (t[0] ?? -1) >= 0, (t[1] ?? -1) >= 0 && (t[1] ?? -1) < 1e9);
const t2 = process.hrtime();
console.log(t2.length === 2, (t2[0] ?? -1) >= (t[0] ?? -1));
const m = memoryUsage();
const m2 = process.memoryUsage();
console.log(m.rss > 0, typeof m.heapTotal, typeof m.heapUsed, typeof m.external, typeof m.arrayBuffers);
console.log(m2.rss > 0);
console.log(typeof process.ppid, process.ppid >= 0);
// A write to env updates the snapshot the object holds, not the OS.
process.env.STATOR_NODE_PROCESS = 'snapshot';
console.log(process.env.STATOR_NODE_PROCESS, env.STATOR_NODE_PROCESS);
// Last: `process.exit` ends the process now (stdout is flushed first).
process.exit(0);
