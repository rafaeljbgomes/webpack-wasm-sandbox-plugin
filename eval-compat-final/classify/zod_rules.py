import re, json, collections, sys
from jest_common import failures, classify
R = lambda pat, *keys: (lambda h: any(re.search(pat, h[k]) for k in keys))
RULES = [
  ('grant', 'File-not-granted', R(r"'File' is not defined", 'msg', 'block')),
  ('grant', 'URL-not-granted', R(r'"format": "url"|Invalid URL|url validations|httpurl|url (preserves|trims|normalize|error overrides)|IPv6|CIDR v6|stringToURL|stringToHttpURL', 'block', 'name')),
  ('grant', 'atob-btoa-TextEncoder-not-granted', R(r'base64|jwt|utf8ToBytes|bytesToUtf8|hexToBytes', 'name')),
  ('representation', 'BigInt-does-not-cross', R(r'[Bb]ig[Ii]nt|\d+n\b', 'name', 'block')),
  ('representation', 'symbol-description-lost', R(r'Symbol\(undefined\)', 'msg', 'block')),
  ('identity', 'schema-identity-as-map-key', R(r"cannot set property 'ref' of undefined|globalRegistry|registry|metadata|captured as meta|describe\(\) check|z\.meta\(\)|combined usage|description with", 'msg', 'name')),
  ('identity', 'error-class-instanceof', R(r'to be an instance of|toBeInstanceOf|instance of ZodError|inheritance', 'msg', 'block', 'name')),
  ('representation', 'error-methods-not-on-copy', R(r'error\.(format|flatten) is not a function|treeifyError', 'msg', 'name')),
  ('representation', 'Map-Set-cross-by-value', R(r'(Map|Set|Map Iterator) object expected|z\.map|_values', 'msg', 'name')),
  ('identity', 'typed-array-instanceof', R(r'expected Uint8Array, received Uint8Array', 'block')),
  ('representation', 'frozen-state-not-preserved', R(r'freezing', 'name')),
  ('representation', 'snapshot-of-crossed-error-or-schema', R(r'Snapshot', 'msg')),
  ('identity', 'schema-identity-as-map-key', R(r'toJSONSchema (throws on duplicate id|allows same schema)', 'name')),
  ('representation', 'BigInt-or-Symbol-literal-does-not-cross', R(r'various primitive types|\^\(undefined\)\$', 'name', 'block')),
  ('representation', 'symbol-keyed-properties-dropped', R(r'Symbol\.for\(', 'block')),
  ('representation', 'error-methods-not-on-copy', R(r'reported issues with nested usage', 'name')),
  ('state', 'host-extends-library-prototype', R(r'prototype extension', 'name')),
]
rows = classify(failures('zod'), RULES)
c = collections.Counter(x['category'] for x in rows); r = collections.Counter((x['category'], x['rule']) for x in rows)
print(len(rows), dict(c)); [print(v, k) for k, v in r.most_common()]
json.dump([{k: x[k] for k in ('file', 'test', 'message', 'category', 'rule')} for x in rows], open('zod-classified.json', 'w'), indent=1)
if len(sys.argv) > 1:
    for x in rows:
        if x['category'] == 'unclassified':
            print('U', x['file'].split('/tests/')[-1], '|', x['test'][:60], '|', re.sub(r'/private\S+', '', x['block'])[:600].replace('\n', ' / '))
