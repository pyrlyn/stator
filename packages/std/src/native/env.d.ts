// `std/env` bindings (packages/std/zig/env.zig). Status returns: 0 success, 1 failure with the
// code in `jsrtStdLastError`.
import type { CString } from './core.js';

/** @statorExtern jsrt_std_env_has */
export declare function jsrtStdEnvHas(name: CString): number;

/** @statorExtern jsrt_std_env_get */
export declare function jsrtStdEnvGet(name: CString): CString;

/** @statorExtern jsrt_std_env_set */
export declare function jsrtStdEnvSet(name: CString, value: CString): number;

/** @statorExtern jsrt_std_env_unset */
export declare function jsrtStdEnvUnset(name: CString): number;

/** @statorExtern jsrt_std_env_count */
export declare function jsrtStdEnvCount(): number;

/** @statorExtern jsrt_std_env_name */
export declare function jsrtStdEnvName(index: number): number;

/** @statorExtern jsrt_std_env_cwd */
export declare function jsrtStdEnvCwd(): number;

/** @statorExtern jsrt_std_env_count */
export declare function jsrtStdEnvCount(): number;

/** @statorExtern jsrt_std_env_name */
export declare function jsrtStdEnvName(index: number): number;
