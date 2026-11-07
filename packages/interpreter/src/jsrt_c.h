/* Input of the build's translate-c step: the runtime's C ABI as the VM sees it (jsrt_value.h is
 * the contract compiled code includes, so the interpreter calls exactly what compiled code calls).
 * jsrt_env_copy_slots is renamed on the way in for the reason packages/runtime/src/jsrt_c.h gives:
 * translate-c derives a `slots` method from it that collides with JSRTEnv's `slots` member. */
#define jsrt_env_copy_slots jsrt_env_copy_slots_translate_c_alias
#include "jsrt.h"
#include "jsrt_value.h"
