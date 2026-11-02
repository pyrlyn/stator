/* Input of `zig translate-c`: the C view the Zig memory core compiles against.
 * jsrt_env_copy_slots is renamed on the way in because translate-c derives a `slots` method from
 * it that collides with JSRTEnv's flexible `slots` member; jsrt_alloc.zig defines the symbol under
 * its real name. */
#define jsrt_env_copy_slots jsrt_env_copy_slots_translate_c_alias
#include "jsrt.h"
#include "jsrt_value.h"
#include "jsrt_mem.h"
