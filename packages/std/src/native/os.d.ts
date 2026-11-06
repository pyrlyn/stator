// `std/os` bindings (packages/std/zig/os.zig). Status returns: 0 success, 1 failure with the code
// in `jsrtStdLastError`; a string answer is read back through `jsrtStdResult`.
import type { CString } from './core.js';

/** @statorExtern jsrt_std_os_platform */
export declare function jsrtStdOsPlatform(): CString;

/** @statorExtern jsrt_std_os_arch */
export declare function jsrtStdOsArch(): CString;

/** @statorExtern jsrt_std_os_release */
export declare function jsrtStdOsRelease(): number;

/** `field`: 0 sysname, 1 release, 2 version, 3 machine. */
/** @statorExtern jsrt_std_os_uname */
export declare function jsrtStdOsUname(field: number): number;

/** @statorExtern jsrt_std_os_hostname */
export declare function jsrtStdOsHostname(): number;

/** @statorExtern jsrt_std_os_homedir */
export declare function jsrtStdOsHomedir(): number;

/** @statorExtern jsrt_std_os_tmpdir */
export declare function jsrtStdOsTmpdir(): number;

/** @statorExtern jsrt_std_os_cpu_count */
export declare function jsrtStdOsCpuCount(): number;

/** Bytes, or -1 on failure (with the code recorded). */
/** @statorExtern jsrt_std_os_total_memory */
export declare function jsrtStdOsTotalMemory(): number;
