#!/bin/sh
# CC wrapper used by run.ts: the normal clang line plus frame pointers on every function
# (including leaves) so samply's frame-pointer unwinder sees complete stacks. Optimisation
# level and every other flag are left as the stator driver chose them; no behaviour change.
exec "${STATOR_PROFILE_REAL_CC:-clang}" -fno-omit-frame-pointer -mno-omit-leaf-frame-pointer "$@"
