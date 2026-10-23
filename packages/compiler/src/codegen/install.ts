/* Installs family-module free functions onto Emitter.prototype (T24). Runs once before the
 * first emit(); mutual `this.` calls resolve through the prototype after this.
 *
 * Family modules take the emitter as a leading parameter (not `this`) so they stay ordinary
 * exported functions under oxlint's `no-this-in-exported-function`. `installMethod` is the
 * only place `this` is rebound onto that parameter.
 *
 * Each family module exports exactly its emitter methods (every export's first parameter is
 * the emitter). Installing by walking the module namespace avoids a per-method table that
 * jscpd would score as identifier-only clones.
 */

import { Emitter } from './emitter.ts';
import * as closures from './closures.ts';
import * as exprs from './expressions.ts';
import * as mod from './module.ts';
import * as rt from './runtime_calls.ts';
import * as slots from './slots.ts';
import * as stmts from './statements.ts';

type Method = (emitter: Emitter, ...args: never[]) => unknown;

/** Rebinds a family free function so `this` is the emitter instance. */
function installMethod<F extends Method>(
  fn: F,
): (this: Emitter, ...args: Tail<Parameters<F>>) => ReturnType<F> {
  return function (this: Emitter, ...args: unknown[]): ReturnType<F> {
    return (fn as unknown as (...a: unknown[]) => ReturnType<F>)(this, ...args);
  };
}

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : never;

function installFamily(family: Record<string, Method>): void {
  for (const [name, fn] of Object.entries(family)) {
    Object.defineProperty(Emitter.prototype, name, {
      value: installMethod(fn),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

let installed = false;

export function installEmitterMethods(): void {
  if (installed) {
    return;
  }
  installed = true;
  installFamily(mod);
  installFamily(closures);
  installFamily(slots);
  installFamily(stmts);
  installFamily(exprs);
  installFamily(rt);
}
