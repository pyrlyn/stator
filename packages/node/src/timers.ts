// `node:timers` (plan.md §11c T11.6), and the global timer functions under `--node`, without an
// event loop (N2). The loop is a chain of `std/thread.runOnMain` callbacks: the runtime runs one
// only when the microtask queue is empty, so each step is a macrotask, and promise jobs and
// `nextTick` callbacks drain between any two timer or immediate callbacks, as on Node. One step
// runs one callback and posts the next step, in libuv's phase order: every timer due at the
// phase's loop time in due order, then the immediates queued before the check phase began. When
// nothing is due, the step sleeps until the earliest timer. Gaps, each an N2 limit:
// - the sleep blocks the main thread, so a `std/thread` result that arrives during it waits for
//   the timer; without I/O there is nothing else a sleep could miss;
// - from the main module, a zero-delay timer runs before an immediate whenever its millisecond
//   has passed, which on Node depends on how long startup took (the order is unspecified there);
// - a delay over 2^31-1 becomes 1 without Node's `TimeoutOverflowWarning`, the callback is not
//   type-checked (`ERR_INVALID_ARG_TYPE`), and a timer is not a primitive id (`clearTimeout`
//   takes the object), since the subset has no `Symbol.toPrimitive`;
// - `timers.promises` and `timers/promises` have not landed.

import { hrtimeNs } from 'std/process';
import { runOnMain } from 'std/thread';
import { sleepMs } from 'std/time';

const TIMEOUT_MAX = 2147483647;

type Callback = (...args: unknown[]) => void;

/** Milliseconds on the monotonic clock, whole as libuv's loop time is. */
function loopNow(): number {
  return Math.floor(hrtimeNs() / 1e6);
}

/** Node's delay rule: anything that is not a number in `1..2^31-1` is 1. */
function delayOf(delay: number | undefined): number {
  const after = delay ?? 1;
  return after >= 1 && after <= TIMEOUT_MAX ? after : 1;
}

let sequence = 0;
/** Active timers, kept in due order; equal due times keep insertion order. */
let timers: Timeout[] = [];
/** Immediates waiting for the next check phase. */
let immediates: Immediate[] = [];
/** The immediates this check phase runs: the ones queued before it began. */
let checking: Immediate[] = [];
let inCheck = false;
let phaseTime = 0;
let stepPosted = false;

/** A timer: `setTimeout` and `setInterval` answer one, and `clearTimeout` takes it. */
export class Timeout {
  /** When the timer is due, on `loopNow()`'s clock; meaningless while inactive. */
  due = 0;
  /** Insertion order, the tiebreak between timers due at the same millisecond. */
  order = 0;
  active = false;
  private refed = true;
  private readonly callback: Callback;
  private readonly args: unknown[];
  private readonly after: number;
  private readonly repeat: boolean;

  constructor(callback: Callback, after: number, args: unknown[], repeat: boolean) {
    this.callback = callback;
    this.after = after;
    this.args = args;
    this.repeat = repeat;
  }

  /** Arms the timer `after` milliseconds from now, behind every timer already due then. */
  arm(): void {
    unschedule(this);
    this.due = loopNow() + this.after;
    this.order = sequence++;
    this.active = true;
    let at = timers.length;
    while (at > 0) {
      const before = timers[at - 1];
      if (before === undefined || before.due <= this.due) break;
      at--;
    }
    timers.splice(at, 0, this);
    postStep();
  }

  /** Runs the callback; an interval re-arms first, so `clearInterval` inside it still wins. */
  fire(): void {
    if (this.repeat) {
      this.arm();
    } else {
      this.active = false;
    }
    this.callback(...this.args);
  }

  ref(): Timeout {
    this.refed = true;
    return this;
  }

  /** The timer no longer keeps the program alive: it still fires if something else does. */
  unref(): Timeout {
    this.refed = false;
    return this;
  }

  hasRef(): boolean {
    return this.refed;
  }

  /** Restarts the countdown from now with the same delay. */
  refresh(): Timeout {
    if (this.active) this.arm();
    return this;
  }

  close(): Timeout {
    unschedule(this);
    return this;
  }
}

/** A queued `setImmediate` callback; `clearImmediate` takes it. */
export class Immediate {
  active = true;
  private refed = true;
  private readonly callback: Callback;
  private readonly args: unknown[];

  constructor(callback: Callback, args: unknown[]) {
    this.callback = callback;
    this.args = args;
  }

  fire(): void {
    this.active = false;
    this.callback(...this.args);
  }

  ref(): Immediate {
    this.refed = true;
    return this;
  }

  unref(): Immediate {
    this.refed = false;
    return this;
  }

  hasRef(): boolean {
    return this.refed;
  }
}

function unschedule(timer: Timeout): void {
  if (!timer.active) return;
  timer.active = false;
  timers = timers.filter((other) => other !== timer);
}

/** Whether a ref'd timer or immediate is still waiting: Node's loop is alive only then. */
function alive(): boolean {
  return (
    timers.some((timer) => timer.hasRef()) ||
    immediates.some((immediate) => immediate.hasRef()) ||
    checking.some((immediate) => immediate.active && immediate.hasRef())
  );
}

function postStep(): void {
  if (stepPosted) return;
  stepPosted = true;
  runOnMain(step);
}

/** One loop step: one callback, then the next step is posted (see the header). */
function step(): void {
  stepPosted = false;
  if (inCheck) {
    const next = checking.shift();
    if (next === undefined) {
      inCheck = false;
    } else {
      postStep();
      if (next.active) next.fire();
      return;
    }
  }
  const due = timers[0];
  if (due !== undefined && due.due <= phaseTime) {
    timers.shift();
    postStep();
    due.fire();
    return;
  }
  if (immediates.length > 0) {
    inCheck = true;
    checking = immediates;
    immediates = [];
    postStep();
    return;
  }
  if (!alive() || due === undefined) return;
  const wait = due.due - loopNow();
  if (wait > 0) sleepMs(wait);
  phaseTime = loopNow();
  postStep();
}

/** Runs `callback(...args)` once, `delay` milliseconds from now (at least 1). */
export function setTimeout(callback: Callback, delay?: number, ...args: unknown[]): Timeout {
  const timer = new Timeout(callback, delayOf(delay), args, false);
  timer.arm();
  return timer;
}

/** Runs `callback(...args)` every `delay` milliseconds until cleared. */
export function setInterval(callback: Callback, delay?: number, ...args: unknown[]): Timeout {
  const timer = new Timeout(callback, delayOf(delay), args, true);
  timer.arm();
  return timer;
}

/** Runs `callback(...args)` in the next check phase, after the timers due by then. */
export function setImmediate(callback: Callback, ...args: unknown[]): Immediate {
  const immediate = new Immediate(callback, args);
  immediates.push(immediate);
  postStep();
  return immediate;
}

export function clearTimeout(timer?: Timeout | null): void {
  if (timer !== undefined && timer !== null) unschedule(timer);
}

export function clearInterval(timer?: Timeout | null): void {
  clearTimeout(timer);
}

export function clearImmediate(immediate?: Immediate | null): void {
  if (immediate === undefined || immediate === null) return;
  immediate.active = false;
  immediates = immediates.filter((other) => other !== immediate);
}

/** The default export: Node's module object. */
export class TimersModule {
  readonly setTimeout = setTimeout;
  readonly clearTimeout = clearTimeout;
  readonly setInterval = setInterval;
  readonly clearInterval = clearInterval;
  readonly setImmediate = setImmediate;
  readonly clearImmediate = clearImmediate;
}

export default new TimersModule();
