// Shared ABI of the `std` backings (docs/STD.md §6, packages/std/zig/jsrt_std.zig). A module
// declaration file, not a global script: `CString` and every `jsrt_std_*` binding are imported by
// name, so nothing here leaks into the program's global scope — a user binding file that declares
// its own global `CString` (docs/FFI.md §2) cannot collide with these.

/** Borrowed NUL-terminated UTF-8 at the FFI boundary (docs/FFI.md §3). */
export type CString = string & { readonly __statorCstr: 'CString' };

/** The string a backing parked by its last successful call; copied out at this call. */
/** @statorExtern jsrt_std_result */
export declare function jsrtStdResult(): CString;

/** The error code (docs/STD.md §3) a backing recorded by its last failing call. */
/** @statorExtern jsrt_std_last_error */
export declare function jsrtStdLastError(): CString;

/** @statorExtern jsrt_std_thread_cleanup */
export declare function jsrtStdThreadCleanup(): void;
