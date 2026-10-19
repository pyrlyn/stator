// Re-vendor tool: mechanically convert V8's src/base/ieee754.cc (C++) to the C11
// fdlibm.c that sits next to this file. plan.md §7 Task 4.2; plan-notes 117.
//
//   node port.ts <path-to-v8-ieee754.cc> fdlibm.c
//
// This exists so a version bump is "re-download upstream, re-run this script",
// never a hand-edit — AGENTS.md forbids hand-editing runtime/vendor/, and this
// script is how that rule stays satisfiable. Every rewrite below is mechanical:
// none of them touches an algorithm, a polynomial constant, or control flow.
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
const out = process.argv[3];
if (src === undefined || out === undefined || src === '' || out === '') {
  process.stderr.write('usage: node port.ts <v8 ieee754.cc> <out.c>\n');
  process.exit(2);
}

// ECMA entry points renamed so they can never bind to the host libm. Longest
// first (atan2 before atan, log10/log1p/log2 before log) so the shorter name
// does not consume the prefix of the longer one.
const ENTRIES = [
  'acosh', 'acos', 'asinh', 'asin', 'atan2', 'atanh', 'atan', 'cbrt',
  'cosh', 'cos', 'expm1', 'exp', 'log10', 'log1p', 'log2', 'log',
  'sinh', 'sin', 'tanh', 'tan', 'pow',
];

let text = readFileSync(src, 'utf8');

// --- Line-level: drop V8 includes, namespace scaffolding, and the libm-trig arm.
const kept: string[] = [];
type DropMode = 'drop-if' | 'drop-endif' | 'drop-all';
let mode: DropMode | null = null;
for (const line of text.split('\n')) {
  const s = line.trim();
  if (s.startsWith('#include "src/base/')) continue;
  if (s === '#include <cmath>' || s === '#include <limits>') continue;
  if (/^namespace (v8|base|ieee754|legacy)? ?\{$/.test(s)) continue;
  if (/^\}\s*\/\/\s*(namespace.*|legacy)$/.test(s)) continue;
  // V8_USE_LIBM_TRIG_FUNCTIONS is never defined here: keep the #else (fdlibm)
  // arm of the two-arm form, and drop the guarded-only form entirely.
  if (s === '#if defined(V8_USE_LIBM_TRIG_FUNCTIONS)') { mode = 'drop-if'; continue; }
  if (mode === 'drop-if') { if (s === '#else') mode = 'drop-endif'; continue; }
  if (mode === 'drop-endif') { if (s === '#endif') { mode = null; continue; } }
  if (s.startsWith('#if defined(V8_USE_LIBM_TRIG_FUNCTIONS) && defined(')) { mode = 'drop-all'; continue; }
  if (mode === 'drop-all') { if (s === '#endif') mode = null; continue; }
  kept.push(line);
}
text = kept.join('\n');

// --- Token-level: C++ constructs to their C equivalents.
text = text.replaceAll('base::bit_cast<uint64_t>', 'fdlibm_bits');
text = text.replaceAll('base::bit_cast<double>', 'fdlibm_dbl');
text = text.replace(/static_cast<([A-Za-z0-9_ ]+)>/g, (_m: string, type: string) => `(${type})`);
text = text.replace(/const_cast<([A-Za-z0-9_ *]+)>/g, (_m: string, type: string) => `(${type})`);
text = text.replace(/0x[0-9A-Fa-f']+/g, (m: string) => m.replaceAll("'", ''));
text = text.replaceAll(' V8_WARN_UNUSED_RESULT', '');
text = text.replaceAll('V8_INLINE ', 'static inline ');
text = text.replaceAll('std::numeric_limits<double>::signaling_NaN()', 'fdlibm_snan()');
text = text.replaceAll('std::numeric_limits<double>::quiet_NaN()', 'fdlibm_qnan()');
text = text.replaceAll('std::numeric_limits<double>::infinity()', '((double)INFINITY)');
// V8's overflowing-math helpers: arithmetic with defined int32 wraparound.
text = text.replace(
  /NegateWithWraparound<int32_t>\(([A-Za-z0-9_]+)\)/g,
  (_m: string, a: string) => `((int32_t)(0u - (uint32_t)(${a})))`,
);
const WRAP = { Add: '+', Sub: '-', Mul: '*' } as const;
function wrapOp(op: string): keyof typeof WRAP {
  if (op === 'Add' || op === 'Sub' || op === 'Mul') return op;
  throw new Error(`unexpected wraparound op ${op}`);
}
text = text.replace(
  /(Add|Sub|Mul)WithWraparound(?:<int32_t>)?\(([A-Za-z0-9_]+), ([A-Za-zx0-9_]+)\)/g,
  (_m: string, op: string, a: string, b: string) =>
    `((int32_t)((uint32_t)(${a}) ${WRAP[wrapOp(op)]} (uint32_t)(${b})))`,
);
// base::Divide is plain IEEE division; V8 wraps it only to dodge an MSVC warning.
text = text.replace(
  /base::Divide\(([^,]+), ([^)]+)\)/g,
  (_m: string, left: string, right: string) => `((${left}) / (${right}))`,
);
// The kernels are file-local upstream (anonymous namespace); their forward
// declarations must carry the same linkage as their definitions.
text = text.replace(/^double (__kernel_(?:cos|sin|tan)|__ieee754_rem_pio2)\(/gm, 'static double $1(');
text = text.replace(/^int (__kernel_rem_pio2)\(/gm, 'static int $1(');

// --- Rename entry points (definitions and internal cross-calls alike). The \b
// guard leaves __kernel_cos and fdlibm_cos alone: an underscore is a word char,
// so there is no boundary before the name in either.
for (const name of ENTRIES) {
  text = text.replace(new RegExp(`\\b${name}\\(`, 'g'), `fdlibm_${name}(`);
}

const PREAMBLE = `/* fdlibm, as ported by V8 (src/base/ieee754.cc) and mechanically converted to C11.
 *
 * WHY THIS IS VENDORED (plan.md §7 Task 4.2, plan-notes 117): golden tests diff
 * against the pinned Node byte-for-byte, and the host libm does NOT agree with
 * V8 on the transcendentals. Measured over 380,000 random inputs on macOS
 * arm64: the host libm differs from Node on every one of the 19 unary
 * transcendentals, from 0.09% of inputs (log2) to 41.38% (tan). This file
 * differs on 0 of 400,000. Calling the host libm would have made the golden
 * suite hostage to whichever libm happened to build the runtime.
 *
 * GENERATED — DO NOT HAND-EDIT (AGENTS.md, Don'ts). Regenerate with:
 *   node port.ts <upstream ieee754.cc> fdlibm.c
 * Every rewrite that script performs is mechanical (namespaces, casts,
 * bit_cast, digit separators, entry-point renaming). No algorithm, polynomial
 * constant, or branch was changed.
 *
 * Upstream provenance and license follow, unmodified.
 */

#include "fdlibm.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

static inline uint64_t fdlibm_bits(double d) {
  uint64_t b;
  memcpy(&b, &d, sizeof b);
  return b;
}
static inline double fdlibm_dbl(uint64_t b) {
  double d;
  memcpy(&d, &b, sizeof d);
  return d;
}
/* fdlibm hands back a signaling NaN on a domain error; returning it through a
 * double quiets it, which is exactly what V8 observes and prints as NaN. */
static inline double fdlibm_snan(void) { return fdlibm_dbl(0x7FF4000000000000ULL); }
static inline double fdlibm_qnan(void) { return fdlibm_dbl(0x7FF8000000000000ULL); }

`;

writeFileSync(out, PREAMBLE + text);
process.stdout.write(`wrote ${out}\n`);
