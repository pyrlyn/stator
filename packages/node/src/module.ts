// `node:module` — `createRequire`, `isBuiltin` and `builtinModules` (plan.md §11c T11.5), after
// Node v26.7.0 lib/internal/modules. The `require` it makes resolves BUILT-INS only: a project's
// own CommonJS files and its packages go through the bundler at build time (docs/BUNDLER.md §4),
// so at run time there is nothing else to load, and any other id throws Node's
// `MODULE_NOT_FOUND`. A built-in Stator has not landed yet throws `ERR_UNKNOWN_BUILTIN_MODULE`
// with a message naming T11.6. Two subset gaps: `require` is a plain function, so
// `require.resolve`, `require.cache` and `require.main` are absent (a function with properties
// is not-yet), and the errors do not extend `Error` (internal/errors.ts).

import assert from './assert.ts';
import { NodeError } from './internal/errors.ts';
import fs from './fs.ts';
import { fileHrefToPath } from './internal/url.ts';
import path from './path.ts';
import process from './process.ts';

/** The pinned Node's `require('node:module').builtinModules` (v26.7.0, checked 2026-10-02):
 * every bare id, then the four that exist only with the `node:` prefix. */
export const builtinModules: readonly string[] = [
  '_http_agent',
  '_http_client',
  '_http_common',
  '_http_incoming',
  '_http_outgoing',
  '_http_server',
  '_tls_common',
  '_tls_wrap',
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'node:sea',
  'node:sqlite',
  'node:test',
  'node:test/reporters',
];

/** Whether `id` names a built-in, with or without the `node:` prefix (`test` needs it). */
export function isBuiltin(id: string): boolean {
  if (builtinModules.includes(id)) return true;
  return id.startsWith('node:') && builtinModules.includes(id.slice('node:'.length));
}

/** The default export: Node's `Module` (minus the class itself, see the header). */
export class ModuleModule {
  readonly builtinModules = builtinModules;
  readonly createRequire = createRequire;
  readonly isBuiltin = isBuiltin;
}

const moduleObject = new ModuleModule();

/** The landed built-ins, by bare id. A module `packages/node` lands joins this table in the same
 * change (`unit/node-module.test.ts` checks that every one is here). */
function landed(id: string): unknown {
  switch (id) {
    case 'assert':
      return assert;
    case 'fs':
      return fs;
    case 'module':
      return moduleObject;
    case 'path':
    case 'path/posix':
      return path;
    case 'process':
      return process;
    default:
      return undefined;
  }
}

function requireFrom(filename: string, id: string): unknown {
  const bare = id.startsWith('node:') ? id.slice('node:'.length) : id;
  if (!isBuiltin(id)) {
    if (id.startsWith('node:')) {
      throw new NodeError('Error', 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${id}`);
    }
    throw new NodeError(
      'Error',
      'MODULE_NOT_FOUND',
      `Cannot find module '${id}'\nRequire stack:\n- ${filename}`,
    );
  }
  const found = landed(bare);
  if (found === undefined) {
    throw new NodeError(
      'Error',
      'ERR_UNKNOWN_BUILTIN_MODULE',
      `No such built-in module: ${id} (not yet supported by Stator; planned for Phase 11, T11.6)`,
    );
  }
  return found;
}

/** A `require` for the module at `filename`: a `file:` URL (`import.meta.url`) or an absolute
 * path. The path only names the requirer in a `MODULE_NOT_FOUND` message. */
export function createRequire(filename: string): NodeRequire {
  let from = filename;
  if (filename.startsWith('file:')) {
    from = fileHrefToPath(filename);
  } else if (!filename.startsWith('/')) {
    throw new NodeError(
      'TypeError',
      'ERR_INVALID_ARG_VALUE',
      "The argument 'filename' must be a file URL object, file URL string, or absolute path " +
        `string. Received '${filename}'`,
    );
  }
  return (id: string): unknown => requireFrom(from, id);
}

export default moduleObject;
