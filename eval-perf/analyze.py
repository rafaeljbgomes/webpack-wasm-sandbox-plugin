import json, random, statistics as st, sys
d = json.load(open(sys.argv[1]))
rows = [r for r in d['rows'] if not r.get('warmup') and not r.get('error') and r.get('completed', 0) == d['reps']]
bad = [ (r['id'], r['mode'], r.get('error')) for r in d['rows'] if r.get('error') or (r.get('completed') is not None and r.get('completed') != d['reps'])]
print('chrome', d['chrome'], 'bad', bad)
def med(xs): return st.median(xs)
rng = random.Random(20261119)
def boot(a, b, n=10000):
    rs = []
    for _ in range(n):
        ma = med([rng.choice(a) for _ in a]); mb = med([rng.choice(b) for _ in b])
        rs.append(ma / mb if mb > 0 else float('inf'))
    rs.sort(); return rs[int(0.025*n)], rs[int(0.975*n)-1]
ids = sorted(set(r['id'] for r in rows))
out = {}
for i in ids:
    g = {m: [r for r in rows if r['id'] == i and r['mode'] == m] for m in ['native', 'sandbox', 'lavamoat']}
    s = {m: [r['scenarioMs'] for r in g[m]] for m in g}
    o = {'n': {m: len(s[m]) for m in s}}
    for m in s:
        if s[m]: o[m + '_ms'] = med(s[m])
    for m in ['sandbox', 'lavamoat']:
        if s[m] and s['native']:
            o[m + '_ratio'] = o[m + '_ms'] / o['native_ms'] if o['native_ms'] > 0 else None
            o[m + '_ci'] = boot(s[m], s['native']) if o['native_ms'] > 0 else None
            o[m + '_delta_ms'] = o[m + '_ms'] - o['native_ms']
    for m in g:
        if g[m]:
            o[m + '_ready_ms'] = med([r['readyAtMs'] for r in g[m]])
            o[m + '_heap_mb'] = med([r['jsHeapReadyBytes'] for r in g[m]]) / 2**20
    if g['sandbox']:
        t = [r['sandboxTimings'] for r in g['sandbox'] if r.get('sandboxTimings')]
        o['sb_wasm_ms'] = med([sum(x['wasmInstantiateMs'] for x in tt) for tt in t])
        o['sb_ctx_ms'] = med([sum(x['contextMs'] for x in tt) for tt in t])
        o['sb_bundle_ms'] = med([sum(x['bundleAndMembraneMs'] for x in tt) for tt in t])
        o['sb_wasm_mem_mb'] = med([sum(x['wasmMemoryBytes'] for x in tt) for tt in t]) / 2**20
        o['sb_contexts'] = len(t[0])
    out[i] = o
json.dump(out, open(sys.argv[2], 'w'), indent=1)
f = lambda x, p=2: ('%.*f' % (p, x)) if isinstance(x, (int, float)) and x is not None else str(x)
print('%-17s %8s %9s %9s %9s %18s %9s %16s' % ('id','native','sandbox','lavamoat','sb x','sb CI','lm x','lm CI'))
for i, o in out.items():
    print('%-17s %8s %9s %9s %9s %18s %9s %16s' % (i, f(o.get('native_ms'),3), f(o.get('sandbox_ms')), f(o.get('lavamoat_ms'),3), f(o.get('sandbox_ratio'),1), '[%s, %s]' % tuple(f(x,1) for x in o['sandbox_ci']) if o.get('sandbox_ci') else '-', f(o.get('lavamoat_ratio'),2), '[%s, %s]' % tuple(f(x,2) for x in o['lavamoat_ci']) if o.get('lavamoat_ci') else '-'))
print()
print('%-17s %9s %9s %9s | %7s %7s %8s %7s | heap MB n/s/l' % ('id','ready n','ready sb','ready lm','wasm','ctx','bundle','wasmMB'))
for i, o in out.items():
    print('%-17s %9s %9s %9s | %7s %7s %8s %7s | %s %s %s' % (i, f(o.get('native_ready_ms'),1), f(o.get('sandbox_ready_ms'),1), f(o.get('lavamoat_ready_ms'),1), f(o.get('sb_wasm_ms'),1), f(o.get('sb_ctx_ms'),1), f(o.get('sb_bundle_ms'),1), f(o.get('sb_wasm_mem_mb'),0), f(o.get('native_heap_mb'),1), f(o.get('sandbox_heap_mb'),1), f(o.get('lavamoat_heap_mb'),1)))
