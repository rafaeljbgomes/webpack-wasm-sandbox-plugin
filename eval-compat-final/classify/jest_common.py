import re, csv, glob, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from blocks import jest_blocks, vitest_blocks
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def norm(s): return re.sub(r'\s+', ' ', s.replace('›', '>')).strip()
def failures(lib):
    L = sorted(glob.glob(f'{ROOT}/compatibility-results-final/{lib}/*/sandbox'))[-1]
    blocks = {norm(k): v for k, v in jest_blocks(open(f'{L}/run.log', errors='replace').read()).items()}
    for u in sorted(glob.glob(f'{L}/units/*/run.log')):
        for k, v in vitest_blocks(open(u, errors='replace').read()).items():
            blocks.setdefault(norm(k), v)
    r = list(csv.DictReader(open(f'{ROOT}/eval-compat-final/{lib}/failures.csv')))
    nat = {(x['file'], x['test']) for x in r if x['mode'] == 'native'}
    out = []
    for x in r:
        if x['mode'] != 'sandbox' or (x['file'], x['test']) in nat: continue
        t = norm(x['test']); fk = norm(os.path.basename(x['file']) + ' >> ' + x['test'])
        k = [fk] if fk in blocks else [k for k in blocks if ' >> ' not in k and k.endswith(t)]
        blk = blocks[k[0]] if k else ''
        body = test_body(x['file'], x['test'].split(' > ')[-1])
        out.append({**x, 'block': blk, 'body': body})
    return out
_src = {}
def test_body(file, name):
    if not file or not os.path.exists(file): return ''
    s = _src.setdefault(file, open(file, errors='replace').read())
    i = s.find(name[:60])
    if i < 0: return ''
    j = s.find('\ntest(', i + 1); k = s.find('\n  test(', i + 1); l = s.find('\n  it(', i + 1); m = s.find('\nit(', i + 1)
    ends = [e for e in (j, k, l, m) if e > 0]
    return s[i: min(ends) if ends else i + 3000]
def classify(rows, rules):
    for x in rows:
        hay = {'msg': x['message'], 'block': x['block'], 'body': x['body'], 'name': x['test'], 'file': os.path.basename(x['file']), 'filetext': _src.get(x['file']) or (open(x['file'], errors='replace').read() if x['file'] and os.path.exists(x['file']) else '')}
        x['category'], x['rule'] = 'unclassified', None
        for c, rid, p in rules:
            if p(hay): x['category'], x['rule'] = c, rid; break
    return rows
