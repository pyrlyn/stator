/* The accessor implementations: `stat(2)` into a stack `struct stat`, one field
 * out per function. Compiled through the fixture-C path (`-std=c11 -Wall
 * -Wextra -Werror`), linked through `--link=` — the same channel the golden
 * `extern_ptr` fixture's `ffi.c` rides.
 */
#include "stat_shim.h"

#include <stdbool.h>
#include <sys/stat.h>

/* The one `stat(2)` call both accessors share; -1 for a missing file. */
static double stat_field(const char *path, bool mtime) {
  struct stat st;
  if (stat(path, &st) != 0) {
    return -1.0;
  }
  return mtime ? (double)st.st_mtime : (double)st.st_size;
}

double stat_size(const char *path) { return stat_field(path, false); }

double stat_mtime(const char *path) { return stat_field(path, true); }
