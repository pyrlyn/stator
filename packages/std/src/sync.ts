import {
  mutexNew,
  mutexLock,
  mutexTryLock,
  mutexUnlock,
  mutexDestroy,
  condNew,
  condWait,
  condSignal,
  condDestroy,
  channelNew,
  channelSend,
  channelReceive,
  channelClose,
} from './native/concurrency.js';

/** Non-recursive OS mutex. Destroy only after every user has finished. */
export class Mutex {
  readonly handle: unknown;
  constructor() {
    this.handle = mutexNew();
  }
  lock(): void {
    mutexLock(this.handle);
  }
  tryLock(): boolean {
    return mutexTryLock(this.handle);
  }
  unlock(): void {
    mutexUnlock(this.handle);
  }
  destroy(): void {
    mutexDestroy(this.handle);
  }
}

/** Always wait in a predicate loop while holding the associated mutex. */
export class CondVar {
  private handle: unknown;
  constructor() {
    this.handle = condNew();
  }
  wait(mutex: Mutex): void {
    condWait(this.handle, mutex.handle);
  }
  signal(): void {
    condSignal(this.handle, false);
  }
  broadcast(): void {
    condSignal(this.handle, true);
  }
  destroy(): void {
    condDestroy(this.handle);
  }
}

/** Bounded FIFO with blocking backpressure. Close wakes senders and receivers. */
export class Channel<T> {
  private handle: unknown;
  constructor(capacity: number) {
    this.handle = channelNew(capacity);
  }
  send(value: T): void {
    channelSend(this.handle, value);
  }
  receive(): T {
    return channelReceive(this.handle) as T;
  }
  close(): void {
    channelClose(this.handle);
  }
}
