/* Input of `zig translate-c`, Boehm builds only: jsrt_gc.zig's view of the collector. */
#define GC_THREADS 1
#include "gc.h"
#include "gc/gc_mark.h"
