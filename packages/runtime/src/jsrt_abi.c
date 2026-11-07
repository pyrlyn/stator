/* Minimal translation unit so runtime/build/libjsrt.a exists and links from Phase 1.
 * The real runtime (values, strings, Ryu printing, the collector) lands in plan.md §5 Task 2.5.
 */
#include "jsrt.h"

int jsrt_abi_version(void) {
  return JSRT_ABI_VERSION;
}
