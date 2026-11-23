import json, glob, os, re, collections, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def load(m):
    d = sorted(glob.glob(f'{ROOT}/compatibility-results-final/image-js/*/{m}'))[-1]
    r = json.load(open(glob.glob(d + '/units/*/runner-report.json')[0]))
    out = collections.defaultdict(list)
    for f in r['testResults']:
        fn = os.path.basename(f['name'])
        for a in f['assertionResults']:
            out[(fn, a['fullName'])].append((a['status'], re.sub(r'/private\S+', '', '\n'.join(a.get('failureMessages') or []))[:600]))
        if not f['assertionResults']:
            out[(fn, '__FILE__')].append(('file-failed', f.get('message', '')[:300]))
    return out
n, s = load('native'), load('sandbox')
lost = []
for k, v in n.items():
    sv = s.get(k, [])
    for i, (st, _) in enumerate(v):
        if st != 'passed': continue
        if i >= len(sv): lost.append((k, 'NOT EXECUTED (file failed to load: ' + s.get((k[0], '__FILE__'), [('', '?')])[0][1][:80] + ')'))
        elif sv[i][0] != 'passed': lost.append((k, sv[i][1]))
R = lambda pat: (lambda k, m: re.search(pat, m))
RULES = [
  ('grant', 'node-file-system', R(r'readSync|writeSync|only implemented for Node|NOT EXECUTED|getNodeApiOrThrow|at fetchURL|on Node\.js requires')),
  ('grant', 'Buffer-not-granted', R(r"'Buffer' is not defined")),
  ('identity', 'private-field-brand-check', R(r'invalid brand on object')),
  ('identity', 'thrown-error-class', R(r'expected a thrown error to be|to throw error including')),
  ('identity', 'instanceof-library-class', R(r'to be an instance of')),
  ('identity', 'same-value-different-reference', R(r'to strictly equal|Object\.is equality')),
  ('representation', 'generator-crosses-as-object', R(r'not a generator')),
  ('representation', 'snapshot-of-crossed-value', R(r'Snapshot')),
]
rows = []
for k, m in lost:
    cat = rid = None
    for c, r, p in RULES:
        if p(k, m): cat, rid = c, r; break
    rows.append({'file': k[0], 'test': k[1], 'message': m[:300], 'category': cat or 'unclassified', 'rule': rid})
c = collections.Counter(x['category'] for x in rows); r = collections.Counter((x['category'], x['rule']) for x in rows)
print(len(rows), dict(c)); [print(v, k) for k, v in r.most_common()]
json.dump(rows, open('imagejs-classified.json', 'w'), indent=1)
if len(sys.argv) > 1:
    for x in rows:
        if x['category'] == 'unclassified': print('U', x['file'], '|', x['test'][:60], '|', x['message'][:400].replace('\n', ' / '))
