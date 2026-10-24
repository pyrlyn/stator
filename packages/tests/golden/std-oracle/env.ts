/* Node twin of packages/std/src/env.ts. */

import { failure, quote } from './failure.ts';

/** POSIX `setenv` refuses these names; Node's `process.env` would accept them. */
function invalidName(name: string): boolean {
  return name === '' || name.includes('=');
}

export function has(name: string): boolean {
  return Object.hasOwn(process.env, name);
}

export function get(name: string): string | undefined {
  return process.env[name];
}

export function set(name: string, value: string): void {
  if (invalidName(name)) {
    throw failure('std/env.set', quote(name), 'EINVAL');
  }
  process.env[name] = value;
}

export function unset(name: string): void {
  if (invalidName(name)) {
    throw failure('std/env.unset', quote(name), 'EINVAL');
  }
  delete process.env[name];
}

export function cwd(): string {
  return process.cwd();
}

/** Node's `Object.keys(process.env)`: the live key list, names only. */
export function names(): string[] {
  return Object.keys(process.env);
}
