# T16. Closing report

**Compare-only shape keys are freed; stores still intern**

`jsrt_shape_key` interned every UTF-8 conversion. A second lookup of the same bytes was freed (plan-notes 353), but a miss never stores the pointer, so each distinct computed read, `in`, `delete`, `Object.hasOwn`, array-index check, print/`JSON.stringify` get, and error-message rendering kept `3·len+1` bytes plus an intern node for the life of the process. A named-group `exec` malloc'd the group name and passed it to `jsrt_set_prop`; the second match reused the existing transition and leaked that malloc. Reproduced before the call-site change: `print_shapes` reported `compare-only key lookup interned 32 keys`.

Compare-only sites now go through `jsrt_shape_key_ephemeral` (`jsrt_get_prop_value` / `jsrt_has_prop_value` free it). Stores (`jsrt_set_prop`, `JSON.parse` keys, `console.count` labels) still intern. Named-group names go through `jsrt_shape_intern`. The leak harness covers 2M distinct computed-key reads (`packages/tests/leak/keys.js`, `--mode=js`).

Check: `just -f packages/runtime/justfile -d packages/runtime runtime-test` — `runtime: print corpus matches Node` (32 misses leave `jsrt_shape_intern_count` unchanged; one stored key adds one; two named-group execs in `print_regexp` add the two names and nothing on the second exec). `pnpm run test:leak` — `leak: 2M computed-key reads — peak RSS 2956 KB of a 65536 KB cap, 114 samples, plateau` (the 10M object and FFI rows still plateau).
