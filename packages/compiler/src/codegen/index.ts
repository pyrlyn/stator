/* C emitter: #line source maps, JSRT_FRAME/JSRT_LOCAL rooting discipline from the first
 * emitted line, landing-pad error propagation. Generated C is never hand-edited. */

import type { Module } from '../hir/nodes.ts';
import { Emitter } from './emitter.ts';
import { installEmitterMethods } from './install.ts';
import type { LibraryEmit } from './types.ts';

export type { LibraryEmit } from './types.ts';

installEmitterMethods();

export function emitC(module: Module, library?: LibraryEmit): string {
  const emitter = new Emitter();
  return emitter.emit(module, library);
}
