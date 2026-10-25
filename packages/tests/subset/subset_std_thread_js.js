// @mode: js
// @verdict: dynamic
// docs/THREADS.md: OS threads and synchronization use the private boxed runtime bridge.
import { spawn } from 'std/thread';
import { Mutex } from 'std/sync';
const mutex = new Mutex();
const thread = spawn(() => { mutex.lock(); mutex.unlock(); return 42; });
thread.join().then((value) => console.log(value));
