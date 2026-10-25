// Private boxed runtime ABI (docs/THREADS.md); never a user FFI extension.
/** @statorExtern jsrt_thread_spawn */
export declare function threadSpawn(
  work: () => unknown,
  cleanup: () => void,
  pooled: boolean,
): unknown;
/** @statorExtern jsrt_thread_join */
export declare function threadJoin(handle: unknown): unknown;
/** @statorExtern jsrt_thread_run_on_main */
export declare function threadRunOnMain(work: () => void): void;
/** @statorExtern jsrt_sync_mutex_new */
export declare function mutexNew(): unknown;
/** @statorExtern jsrt_sync_mutex_lock */
export declare function mutexLock(handle: unknown): void;
/** @statorExtern jsrt_sync_mutex_try_lock */
export declare function mutexTryLock(handle: unknown): boolean;
/** @statorExtern jsrt_sync_mutex_unlock */
export declare function mutexUnlock(handle: unknown): void;
/** @statorExtern jsrt_sync_mutex_destroy */
export declare function mutexDestroy(handle: unknown): void;
/** @statorExtern jsrt_sync_cond_new */
export declare function condNew(): unknown;
/** @statorExtern jsrt_sync_cond_wait */
export declare function condWait(condition: unknown, mutex: unknown): void;
/** @statorExtern jsrt_sync_cond_signal */
export declare function condSignal(condition: unknown, all: boolean): void;
/** @statorExtern jsrt_sync_cond_destroy */
export declare function condDestroy(condition: unknown): void;
/** @statorExtern jsrt_sync_channel_new */
export declare function channelNew(capacity: number): unknown;
/** @statorExtern jsrt_sync_channel_send */
export declare function channelSend(channel: unknown, value: unknown): void;
/** @statorExtern jsrt_sync_channel_receive */
export declare function channelReceive(channel: unknown): unknown;
/** @statorExtern jsrt_sync_channel_close */
export declare function channelClose(channel: unknown): void;
