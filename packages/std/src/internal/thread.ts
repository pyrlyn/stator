import { threadSpawn, threadJoin } from '../native/concurrency.js';
import { jsrtStdThreadCleanup } from '../native/core.js';

export function submit<T>(work: () => T): Promise<T> {
  return threadJoin(threadSpawn(work, cleanup, true)) as Promise<T>;
}

export function cleanup(): void {
  jsrtStdThreadCleanup();
}
