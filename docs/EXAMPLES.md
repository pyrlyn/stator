# Examples

Small programs and the commands to ask stator about them. The `explain` outputs below were run on
stator's `main` with Node 26 (`node packages/compiler/src/cli/main.ts` from the repository root,
after `pnpm install`); `explain` stops before code generation, so it needs no LLVM and no runtime
archive. Flags are in [MODES.md](MODES.md) and [CONFIG.md](CONFIG.md).

Below, `stator` stands for `node packages/compiler/src/cli/main.ts`.

## 1. A program that compiles fully typed

`hello.ts`:

```ts
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
const sizes: number[] = [10, 20, 30];
for (const n of sizes) {
  console.log(`fib(${n}) = ${fib(n)}`);
}
```

```console
$ stator explain hello.ts
hello.ts: static
  1: fib: static (typed)
```

`static` is the best verdict: everything compiled with known types. For a script, add `--json`:

```console
$ stator explain hello.ts --json
{"verdict":"static","functions":[{"name":"fib","line":1,"provenance":"typed","verdict":"static"}]}
```

To get a binary, `stator build hello.ts -o hello` and run `./hello`. `build` links against the
runtime archive, which you produce once with `pnpm run runtime` (it needs the pinned LLVM and just
from [TOOLCHAIN.md](TOOLCHAIN.md)); without it the build stops with `STA0011 runtime archive not
found` and the command to run.

## 2. Untyped JavaScript goes dynamic, not wrong

`add.js`:

```js
function add(a, b) {
  return a + b;
}
console.log(add(1, 2));
```

```console
$ stator explain add.js --mode=js
add.js: dynamic
  1: add: dynamic (dynamic)
```

In js mode untyped code compiles, with values boxed at run time. Write the same function with `a: number, b: number`
in a `.ts` file and `explain` reports `add: static (typed)`.

## 3. The two ways a program is refused

Explicit `any` is an error in the default ts mode (`bad.ts`: `function bad(x: any): any { return x; }`):

```console
$ stator explain bad.ts
bad.ts: error (STA1001)
  STA1001 x2
  bad.ts:1:1 STA1001 [ts] explicit 'any' is not allowed in ts mode; use 'unknown' instead
  bad.ts:1:14 STA1001 [ts] explicit 'any' is not allowed in ts mode; use 'unknown' instead
```

A `.js` file in ts mode is refused before anything else:

```console
$ stator explain add.js
add.js: error (STA1002)
  add.js:1:1 STA1002 [ts] .js files are not allowed in ts mode; use `--mode=js` or convert to .ts
```

`explain` exits 0 even for a refused program: the verdict is the answer. Every code is listed in
[DIAGNOSTICS.md](DIAGNOSTICS.md).

## 4. Put the options in a file

Every command-line option can live in `stator.config.json` next to your entry (`--config=<path>`
reads another file, `--no-config` reads none); the command line wins. Keys, precedence and discovery
are in [CONFIG.md](CONFIG.md). A misspelled key is an error (`/mdoe: unknown key`) rather than being
ignored.
