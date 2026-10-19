/* C emitter: #line source maps, JSRT_FRAME/JSRT_LOCAL rooting discipline from the first
 * emitted line, landing-pad error propagation. Generated C is never hand-edited.
 *
 * Split by HIR family (plan.md cloud-review T24): expressions, statements, classes,
 * closures, and runtime calls, plus the library ABI and the shared sequencer.
 * `emitC` is the only entry the rest of the compiler imports.
 */

import type { Module } from '../hir/nodes.ts';
import { Emitter } from './emitter.ts';
import type { LibraryEmit } from './library.ts';

export type { LibraryEmit } from './library.ts';

export function emitC(module: Module, library?: LibraryEmit): string {
  const emitter = new Emitter();
  return emitter.emit(module, library);
}
