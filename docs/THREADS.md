# Threads and synchronization

Runtime contract for plan.md T10.2.

`std/thread` runs synchronous Stator closures on POSIX OS threads sharing the managed heap.
Spawn and join are main-thread operations. The public surface is strict TypeScript; thread
creation, synchronization and completion transport are Zig over libc pthreads, reusing the runtime's allocator and Promise machinery.
No new third-party dependency is needed.

## API

- `spawn<T>(work: () => T): Thread<T>` captures arguments in the closure.
- `Thread<T>.join(): Promise<T>` and `join<T>(thread: Thread<T>): Promise<T>` return the same
  completion Promise on repeated calls. A thrown worker error rejects it.
- `availableParallelism(): number` reuses `std/os.cpuCount()`.
- `runOnMain(work: () => void): void` posts a callback to main. Worker callbacks must be
  synchronous; Promise operations belong to main. A posted callback may resolve a Promise.
- `Mutex`: `lock()`, `tryLock(): boolean`, `unlock()`, `destroy()`.
- `CondVar`: `wait(mutex)`, `signal()`, `broadcast()`, `destroy()`. Wait atomically releases
  the locked mutex and reacquires it before returning. Always test the predicate in a loop.
- `Channel<T>(capacity)`: bounded FIFO `send(value)`, `receive(): T`, `close()`.
  Send/receive block the calling OS thread. Closing is idempotent, wakes all waiters, permits
  draining buffered items, and makes further sends and an empty receive throw an Error.
  Capacity must be an integer in 1..2^20. Channel storage is collected with the handle.

Mutexes and conditions are explicitly destroyed after all users finish. Destroying a locked
mutex or a condition with waiters is an error. Destroyed handles stay recognizable, so later
use throws instead of dereferencing freed native memory. Recursive mutex locking and unlock
by a different thread are errors. Synchronization does not prevent application-level deadlocks.

## Example

```ts
import { spawn } from 'std/thread';

async function main(): Promise<void> {
  const worker = spawn(() => {
    let total = 0;
    for (let i = 0; i < 100000; i++) total += i;
    return total;
  });
  console.log(await worker.join());
}
main();
```

## Ownership and scheduling

Main alone drains `jsrt_run_microtasks`. Workers post completions and `runOnMain` callbacks to
one mutex-protected MPSC queue; the existing drain waits for live workers when its microtask
queue is empty. It reaps every worker before exit, including unjoined workers. Microtasks
already queued run before external completions. No ordering is promised between workers.
Joining is asynchronous; main must not block on a channel while its peer awaits a main callback.

A worker may allocate values, run synchronous TypeScript, use `std/sync`, and call sync `std/fs`.
Object reads/writes shared between threads require synchronization. Captured variable cells
are shared too. Publish shared state before spawn, under a mutex, or through a channel.
Do not use Promise APIs, console APIs, process environment access, process exit-status
mutation, or optional Intl from workers; post those operations to main. Use `std/io` for
worker descriptor I/O.
`Math.random` has thread-local state. Native strings remain immutable even when two workers
append to the same prefix; the backing serializes append-buffer mutations.

Worker bodies returning a Promise are rejected; use a synchronous body and await its join on
main. Cancellation, priorities, JS Worker/SharedArrayBuffer/Atomics and callbacks from arbitrary
foreign threads remain unsupported. The C export ABI remains main-thread-only (docs/FFI.md).

## GC and native boundary

Boehm must be built with threads (`GC_THREADS`; packaged bdw-gc builds support this).
Each worker explicitly registers its stack before invoking Stator, then unregisters on exit.
A registry records the address of every thread's TLS shadow-stack head and exception mailbox.
Registry mutations run under Boehm's allocation lock; its stop-the-world roots hook walks all
registered frames without acquiring application locks. Queue records, channel values and
closures use the existing masked-value GC allocation kind. Main's roots remain registered.
Because another thread can collect between a native return and its caller's frame store,
new allocations are temporarily rooted per thread until the next generated statement boundary.
Return values and destructive channel receives also use a registered handoff slot. These
transient roots are released at statement boundaries and on worker exit; collection is never
disabled while workers run. Programs that import the thread bridge emit these safepoints.
Without Boehm the existing malloc-only runtime remains supported, with its existing lack of GC.

The compiler admits a boxed `jsrt_value` ABI only for the library's exact
`src/native/concurrency.d.ts` declaration file and its closed symbol table. User FFI signatures
retain their existing restrictions. This internal bridge validates handles and closures before
reading layouts. It is not a public callback ABI.

## Filesystem offload

The six `std/fs` Promise twins run the corresponding sync function in a worker and await its
join. They share a lazy pool with at most four OS workers. Sequential operations reuse one
worker; overlapping work may grow the pool up to that limit. Excess jobs queue FIFO without
blocking main. Queue length is not capped, so callers should still bound large submissions.
Each job gets its own result/exception and runs std cleanup on both success and failure; idle
workers retain no transient allocation roots from the completed job. Promise continuations
reuse the same pool. Once the main drain has no microtasks, completions or active jobs left,
it stops and joins the idle workers. A later drain may create a fresh pool. Outstanding jobs
finish before program exit, even if their Promises were not awaited. Public `spawn` continues
to create a dedicated OS thread; its lifetime is independent of the filesystem pool.

## Verification

Thread-only native fixtures use explicit expected output and timeouts, not a Node mock that
pretends closures share a heap. Tests cover parallel workers, FIFO/backpressure, mutex and
condition contention, rejected joins, main callbacks, invalid handles, and allocation/collection
with live values held by other threads. ASan/UBSan instrument the C and generated code; Zig's
ReleaseSafe checks cover the primitive implementation.
