"""Per-library breakdown of tests (Lodash: assertions) that pass natively and fail
or do not run in the sandbox. Five libraries are classified by the rule files in
this directory; date-fns and Marked by the earlier manual classification; Yup by
yup_rules.py; TweetNaCl from its 46 tape failures (below)."""
import json, collections, csv
CATS = ['identity', 'representation', 'state', 'grant', 'env', 'defect', 'engine', 'other']
def tally(f, w=None):
    c = collections.Counter()
    for x in json.load(open(f)):
        cat = x['category'] if x['category'] != 'unclassified' else 'other'
        c[cat] += x.get('lost', 1) if w else 1
    return c
T = {
  'strip-ansi': collections.Counter(), 'MIME': collections.Counter(),
  'Marked (spec)': collections.Counter(engine=5),            # ReDoS cases over the time limit
  'TweetNaCl': collections.Counter(identity=42, state=4),     # 42 throws(TypeError) across realms; 4 out-parameter arrays
  'Yup': tally('yup-classified.json'),
  'Luxon': tally('luxon-classified.json'),
  'Zod': tally('zod-classified.json'),
  'Lodash': tally('lodash-classified.json', w=True),
  'Marked (unit)': collections.Counter(env=8, state=36),     # CLI tests; lexer out-parameter arrays
  'ImageJS': tally('imagejs-classified.json'),
  'date-fns': collections.Counter(identity=751, representation=84, env=45),
}
rows = []
for lib, c in T.items():
    rows.append({'library': lib, 'total': sum(c.values()), **{k: c.get(k, 0) for k in CATS}})
tot = {'library': 'Total', 'total': sum(r['total'] for r in rows), **{k: sum(r[k] for r in rows) for k in CATS}}
rows.append(tot)
for r in rows: print(f"{r['library']:14} {r['total']:5} " + ' '.join(f'{r[k]:5}' for k in CATS))
with open('summary.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['library', 'total'] + CATS); w.writeheader(); w.writerows(rows)
