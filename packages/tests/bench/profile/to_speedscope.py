#!/usr/bin/env python3
"""Convert a samply (Firefox Profiler, processed format) profile to speedscope JSON.

Usage: to_speedscope.py <profile.json.gz> <out.speedscope.json> [--summary <out.txt>] [--top N]
                       [--weight cpu|samples]

Symbol names come from the `<profile>.syms.json` sidecar that
`samply record --save-only --unstable-presymbolicate` writes next to the profile, so no
symbol server is needed. Frames that cannot be resolved stay as `lib+0xADDR`.
Each sampled thread becomes one speedscope "sampled" profile. The optional summary lists
the top functions by self and total (inclusive) sample share, with the library each
function lives in, so an agent can read hot spots without a GUI.
"""
import bisect, gzip, json, os, sys
from collections import Counter


def load_json(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt') as f:
        return json.load(f)


def sidecar_path(path):
    base = path[:-3] if path.endswith('.gz') else path
    base = base[:-5] if base.endswith('.json') else base
    return base + '.json.syms.json'


WEIGHT = 'cpu'  # 'cpu' (default) or 'samples'; set by --weight


class Symbolizer:
    def __init__(self, syms):
        self.libs = {}
        if not syms:
            return
        table = syms['string_table']
        for lib in syms['data']:
            entries = sorted((e['rva'], e.get('size') or 0, table[e['symbol']]) for e in lib['symbol_table'])
            known = {addr: table[lib['symbol_table'][i]['symbol']] for addr, i in lib.get('known_addresses', [])}
            self.libs[lib['debug_name']] = (entries, [e[0] for e in entries], known)

    def name(self, lib, addr):
        info = self.libs.get(lib)
        if info is None or addr is None:
            return None
        entries, starts, known = info
        if addr in known:
            return known[addr]
        i = bisect.bisect_right(starts, addr) - 1
        if i >= 0:
            rva, size, sym = entries[i]
            if size == 0 or addr < rva + size:
                return sym
        return None


def convert(profile, symbolizer):
    libs = profile['libs']
    frames, frame_index = [], {}
    out_profiles = []
    for thread in profile['threads']:
        strings = thread['stringArray']
        ft, fn, st, rt = thread['frameTable'], thread['funcTable'], thread['stackTable'], thread['resourceTable']
        samples = thread['samples']
        if samples['length'] == 0:
            continue

        def frame_key(fi):
            func = ft['func'][fi]
            res = fn['resource'][func]
            lib = None
            if res is not None and res >= 0 and rt['lib'][res] is not None:
                lib = libs[rt['lib'][res]]
            libname = (lib.get('debugName') or lib.get('name')) if lib else None
            addr = ft['address'][fi]
            raw = strings[fn['name'][func]]
            name = symbolizer.name(libname, addr) if libname else None
            if name is None:
                name = raw if not raw.startswith('0x') else f"{libname or '?'}+{raw}"
            return (name, libname or '')

        cache = {}

        def fid(fi):
            if fi in cache:
                return cache[fi]
            key = frame_key(fi)
            if key not in frame_index:
                frame_index[key] = len(frames)
                frames.append({'name': key[0], 'file': key[1]})
            cache[fi] = frame_index[key]
            return cache[fi]

        stack_cache = {}

        def stack_frames(si):
            if si in stack_cache:
                return stack_cache[si]
            chain = []
            s = si
            while s is not None:
                chain.append(fid(st['frame'][s]))
                s = st['prefix'][s]
            chain.reverse()
            stack_cache[si] = chain
            return chain

        # Weight by CPU time (threadCPUDelta, microseconds) so idle threads - e.g. Boehm GC's
        # parked marker threads - do not drown the profile; fall back to sample counts.
        cpu = samples.get('threadCPUDelta')
        if WEIGHT == 'cpu' and cpu and any(cpu):
            weights, unit = [c or 0 for c in cpu], 'microseconds'
        else:
            weights, unit = samples.get('weight') or [1] * samples['length'], 'none'
        out_samples, out_weights = [], []
        for si, w in zip(samples['stack'], weights):
            if si is None:
                continue
            out_samples.append(stack_frames(si))
            if unit == 'none':
                w = w or 1
            if w <= 0:
                continue
            out_weights.append(w)
        times = samples.get('time') or []
        out_profiles.append({
            'type': 'sampled',
            'name': f"{thread.get('processName', '')} {thread.get('name', '')} tid={thread.get('tid')}".strip(),
            'unit': unit,
            'startValue': 0,
            'endValue': sum(out_weights),
            'samples': out_samples,
            'weights': out_weights,
            'durationMs': (times[-1] - times[0]) if len(times) > 1 else 0,
        })
    return {
        '$schema': 'https://www.speedscope.app/file-format-schema.json',
        'shared': {'frames': frames},
        'profiles': out_profiles,
        'name': profile['meta'].get('product', 'samply'),
        'exporter': 'stator bench/profile/to_speedscope.py',
    }


def summary(doc, top):
    frames = doc['shared']['frames']
    self_c, total_c, lib_c = Counter(), Counter(), Counter()
    n = 0
    for p in doc['profiles']:
        for stack, w in zip(p['samples'], p['weights']):
            n += w
            if not stack:
                continue
            self_c[stack[-1]] += w
            lib_c[frames[stack[-1]]['file'] or '?'] += w
            for f in set(stack):
                total_c[f] += w
    pct = lambda c: 100.0 * c / n if n else 0.0
    lines = [f'weight: {WEIGHT} (total {n})', '', 'self time by library:']
    lines += [f'  {pct(c):6.2f}%  {lib}' for lib, c in lib_c.most_common()]
    lines += ['', f'top {top} by self:', '   self%  total%  function  [library]']
    for f, c in self_c.most_common(top):
        lines.append(f"  {pct(c):6.2f}  {pct(total_c[f]):6.2f}  {frames[f]['name']}  [{frames[f]['file']}]")
    lines += ['', f'top {top} by total (inclusive):', '  total%   self%  function  [library]']
    for f, c in total_c.most_common(top):
        lines.append(f"  {pct(c):6.2f}  {pct(self_c[f]):6.2f}  {frames[f]['name']}  [{frames[f]['file']}]")
    return '\n'.join(lines) + '\n'


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = argv[1], argv[2]
    summary_path = argv[argv.index('--summary') + 1] if '--summary' in argv else None
    global WEIGHT
    WEIGHT = argv[argv.index('--weight') + 1] if '--weight' in argv else 'cpu'
    top = int(argv[argv.index('--top') + 1]) if '--top' in argv else 25
    side = sidecar_path(src)
    symbolizer = Symbolizer(load_json(side) if os.path.exists(side) else None)
    doc = convert(load_json(src), symbolizer)
    with open(dst, 'w') as f:
        json.dump(doc, f)
    if summary_path:
        with open(summary_path, 'w') as f:
            f.write(summary(doc, top))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
