# Recommendations: faster, leaner stator binaries

Grounded in the recording in [`RESULTS.md`](RESULTS.md) (Apple M3 Max, median of 5 runs). Wall times were taken on a
loaded machine and are directional; the RSS and size gaps are stable across recordings.
Each item names the measurement that motivates it, in priority order.

1. **Scalar-replace non-escaping objects (escape analysis).** `objects-churn` takes
   1066 ms in stator vs 85 ms scriptc, 89 ms shermes, 115 ms Perry — the `{a,b}` object never
   escapes the loop body, so the others never really allocate it. This is ladder item 2 in
   plan.md §12 (escape analysis → stack/arena allocation); the benchmark gives it a concrete
   ~10× target. RSS is already flat (4.28 MB), so the gain is time, not memory.

2. **Unboxed typed calls on the hot path.** `fib` takes 1369 ms vs 50 ms scriptc, 65 ms Perry
   and 337 ms shermes, and is even slower than the QuickJS interpreter (706 ms). A fully typed
   `(number) => number` recursion should compile to a plain C function on doubles/int32 with no
   `JSRT_FRAME` shadow-stack push per call. Audit what the generated C for `fib.ts` does per
   call (frame push, NaN-box/unbox, GC safepoint) and drop everything the type proves
   unnecessary; add an int32 specialization when the range is provable.

3. **Typed fixed-layout objects instead of shape+slot NaN-boxed records.** `objects-retained`
   (1M live `{id:number,name:string}`) peaks at 131 MB in stator vs 72 MB in scriptc and
   114 MB in Porffor — ~60 B/object more than scriptc. For a TS object type with known fields,
   emit a C struct (unboxed `double` + one pointer), skip per-object shape pointers/slot
   arrays, and allocate number-only parts with `GC_MALLOC_ATOMIC` so Boehm does not scan them.

4. **Cache/intern small strings produced by template literals and number→string.**
   `objects-retained` builds only 1000 distinct names (`item-${i % 1000}`) but each is a fresh
   heap string. Interning short template results or caching small-integer `toString` would
   cut both RSS and the 909 ms build-and-sum loop; `string-churn` (4.30 MB vs 1.98 MB scriptc) points the
   same way.

5. **Link Boehm statically (and enable LTO).** stator's 0.3 MB binary still loads Homebrew's
   `libgc.1.dylib` at run time — the only tool in the set besides shermes that is not
   self-contained — so it fails on a Mac without `bdw-gc` installed. Static linking makes the
   output really standalone; the runtime build also prints "no LTO (the linker cannot read
   bitcode archives)", and a static, LTO-able archive lets clang inline `jsrt_*` helpers into
   generated code (helps items 2 and 3).

6. **Shrink the startup footprint.** `hello` peaks at 3.19 MB vs 1.83 MB scriptc, 1.91 MB
   Porffor, 2.23 MB qjsc. Most of the gap is collector start-up (Boehm initial heap, mark
   stacks, dyld of libgc). Set a small initial heap (`GC_set_initial_heap_size`/
   `GC_INITIAL_HEAP_SIZE`), initialise the collector lazily on first allocation, and keep
   static tables in `const` data so they stay shared clean pages.

7. **Move toward the precise generational GC (plan.md §12).** Conservative scanning retains
   anything that looks like a pointer and cannot compact; the `objects-retained` gap to
   scriptc and the slower `objects-churn` both shrink with a precise nursery where short-lived
   objects die without being marked.

What stator already does well (keep it): 3.2–3.4 MB peak RSS on `fib`/`nbody`/`json-roundtrip`
(behind only scriptc, Porffor and qjsc; ahead of Perry and shermes, and 7–17× below the 22–58 MB
of Bun, Deno, Node SEA and pkg), and a 0.27 MB binary (+0.19 MB libgc) vs 58–137 MB for the
runtime-embedding packagers and 14 MB for Perry.
