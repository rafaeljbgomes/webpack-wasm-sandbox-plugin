import re, json, collections, sys
from jest_common import failures, classify
R = lambda pat, *keys: (lambda h: any(re.search(pat, h[k]) for k in keys))
RULES = [
  ('env', 'internal-helper-import', R(r'Cannot find module|tripwire|internal', 'msg', 'name')),
  ('env', 'spy-on-host', R(r'"spy" to be called|toHaveBeenCalled|console', 'msg', 'block')),
  ('engine', 'synchronous-completion-of-promise-jobs', R(r'Did not execute synchronously', 'msg', 'block')),
  ('state', 'host-sets-library-state', R(r'setLocale|Custom locale|disable stacks|is extensible|addMethod', 'name', 'file', 'msg')),
  ('state', 'callback-mutates-library-object', R(r'withMutation|mapper > should allow meta', 'name')),
  ('identity', 'error-class-instanceof', R(r'instance of (TypeError|ValidationError)|to throw error matching', 'msg')),
  ('identity', 'same-value-different-reference', R(r'Object\.is equality|to be <Anonymous Class|not to be <Anonymous', 'msg')),
  ('representation', 'Set-crosses-by-value', R(r'Set object expected', 'msg')),
  ('representation', 'boxed-or-host-value-type-check', R(r'not a boolean|should type check', 'msg', 'name')),
  ('representation', 'error-or-schema-copy', R(r'ValidationError|Snapshot|_cast does not exist', 'msg')),
]
rows = classify(failures('yup'), RULES)
c = collections.Counter(x['category'] for x in rows); r = collections.Counter((x['category'], x['rule']) for x in rows)
print(len(rows), dict(c)); [print(v, k) for k, v in r.most_common()]
json.dump([{k: x[k] for k in ('file', 'test', 'message', 'category', 'rule', 'unit')} for x in rows], open('yup-classified.json', 'w'), indent=1)
if len(sys.argv) > 1:
    for x in rows:
        if x['category'] == 'unclassified': print('U', x['unit'][:6], x['file'].split('/test/')[-1], '|', x['test'][:60], '|', x['message'][:200].replace('\n', ' / '))
