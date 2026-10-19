// @args: alpha --beta=2 gamma
// node:process (plan.md §11c T11.6): the members `tsc` reads, through the module and through the
// global `process`, which the frontend imports from `node:process` under `--node`. The runner
// passes the `@args` line to both runs. Host-dependent values (paths, pids, the environment
// beyond TZ) are printed as shapes, not values.
import { isAbsolute } from "node:path";
import proc, { argv, cwd, env, memoryUsage, nextTick, platform } from "node:process";

console.log(process === proc, argv === process.argv);
console.log(process.argv.slice(2));
console.log(process.argv.length, isAbsolute(process.argv[0] ?? ""), process.execPath === process.argv[0]);
console.log(typeof process.argv0, Array.isArray(process.execArgv));
console.log(isAbsolute(cwd()), process.cwd() === cwd());
console.log(platform === process.platform, process.platform, process.arch);
console.log(typeof process.pid, process.pid > 0, process.ppid > 0, process.pid !== process.ppid);

console.log(env["TZ"], "TZ" in env, Object.keys(env).includes("TZ"));
console.log(env["STATOR_NODE_PROCESS"], "STATOR_NODE_PROCESS" in process.env);
process.env["STATOR_NODE_PROCESS"] = "set";
console.log(env["STATOR_NODE_PROCESS"], Object.keys(process.env).includes("STATOR_NODE_PROCESS"));
delete process.env["STATOR_NODE_PROCESS"];
console.log(env["STATOR_NODE_PROCESS"], "STATOR_NODE_PROCESS" in env);

const usage = memoryUsage();
console.log(Object.keys(usage).join(","), usage.rss > 0, process.memoryUsage().rss > 0);

console.log(process.exitCode);
process.exitCode = 7;
console.log(process.exitCode);
process.exitCode = 0;

console.log(process.stdout.write("written\n"), process.stdout.isTTY, process.stdout.columns);
process.stdout.write(new Uint8Array([98, 121, 116, 101, 115, 10]));
process.stderr.write("to stderr\n");
console.log(process.stdout.fd, process.stderr.fd);

nextTick(() => console.log("tick one"));
process.nextTick(() => {
  console.log("tick two");
  process.exit(0);
  console.log("never printed");
});
console.log("sync done");
