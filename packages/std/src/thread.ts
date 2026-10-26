import { threadSpawn, threadJoin, threadRunOnMain } from './native/concurrency.js';
import { cleanup } from './internal/thread.ts';
import { cpuCount } from './os.ts';

/** An OS thread; its result and exception are delivered on the main microtask queue. */
export class Thread<T> {
  private handle: unknown;

  constructor(work: () => T) {
    this.handle = threadSpawn(work, cleanup, false);
  }

  join(): Promise<T> {
    return threadJoin(this.handle) as Promise<T>;
  }
}

export function spawn<T>(work: () => T): Thread<T> {
  return new Thread<T>(work);
}

export function join<T>(thread: Thread<T>): Promise<T> {
  return thread.join();
}

export function availableParallelism(): number {
  return cpuCount();
}

/** Posts a synchronous callback; only main may touch Promise reactions. */
export function runOnMain(work: () => void): void {
  threadRunOnMain(work);
}
