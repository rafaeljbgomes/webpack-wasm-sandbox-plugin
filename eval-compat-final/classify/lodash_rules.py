"""Rule-based classification of Lodash tests that lose assertions in the sandbox.
Each test is weighted by the assertions it loses (native total - sandbox passed),
so the categories sum to the 1,374-assertion deficit."""
import json, re, collections, sys
norm = lambda m: 'BASENAME' if m.endswith('.js') else m
nt = lambda t: t.replace('lodash-proxy.js', 'lodash.js')
n = {(norm(x['module']), nt(x['test'])): x for x in json.load(open('lodash-native-assertions.json'))['tests']}
s = {(norm(x['module']), nt(x['test'])): x for x in json.load(open('lodash-sandbox-assertions.json'))['tests']}

def died(m):
    m = str(m).strip()
    i = m.rfind('): ')
    return 'DIED: ' + (m[i + 3:] if i >= 0 else m[-200:])
def text(t):
    return ' || '.join(died(a.get('message')) if str(a.get('message')).startswith('Died') else f"{a.get('message')} E={a.get('expected')} A={a.get('actual')}" for a in t['assertions'])

MUTATORS = r'assign|merge|defaults|set\b|setWith|update|unset|fill|pull|remove|reverse|mixin|bindAll|transform'
RULES = [
  ('engine', 'quickjs-parse-error', lambda m, t, x: 'DIED: unexpected token' in x or 'DIED: SyntaxError' in x),
  ('grant', 'buffer-not-granted', lambda m, t, x: "'Buffer' is not defined" in x),
  ('grant', 'timers', lambda m, t, x: re.search(r'debounce|throttle|delay|defer', m + t)),
  ('representation', 'boxed-or-builtin-crosses-as-proxy', lambda m, t, x: re.search(r"requires that 'this' be a|incompatible receiver|DIED: not a (symbol|string|number)", x)),
  ('defect', 'proxy-invariant-violation', lambda m, t, x: 'proxy did not return its actual value' in x),
  ('identity', 'class-across-boundary', lambda m, t, x: 'non-object prototype' in x),
  ('defect', 'arguments-marker-visible', lambda m, t, x: '__qjsArguments__' in x),
  ('defect', 'arguments-object-marshalling', lambda m, t, x: re.search(r'`arguments` objects', t)),
  ('identity', 'new-instance-of-proxied-function', lambda m, t, x: re.search(r'is an instance of|inherits from', t)),
  ('identity', 'placeholder-identity', lambda m, t, x: re.search(r'placeholder', t)),
  ('identity', 'error-class', lambda m, t, x: re.search(r'E="\[Function \w*Error\]"', x) or re.search(r'custom errors|caught error', t)),
  ('state', 'wrapper-mutates-host-array', lambda m, t, x: m.startswith('lodash(...).') and re.search(r'pop|push|shift|unshift|splice|sort|reverse|value|commit|plant', m)),
  ('representation', 'boxed-or-primitive', lambda m, t, x: re.search(r'string object|primitive|numbers and|`true` for (booleans|numbers|strings|NaNs)|non-arrays', t)),
  # (category, rule id, predicate(module, test, assertions-text))
  ('env', 'load-environments', lambda m, t, x: re.search(r'web worker|Require\.js|"underscore" module|"lodash" module|another document|from another realm|non-native built-ins|overwritten', t)),
  ('grant', 'timers', lambda m, t, x: re.search(r'debounce|throttle|delay|defer', m + t) ),
  ('grant', 'buffers', lambda m, t, x: re.search(r'buffer', t, re.I)),
  ('state', 'host-sets-library-state', lambda m, t, x: re.search(r'custom `_\.iteratee`|templateSettings|_\.memoize\.Cache|lodash\.mixin|mixin', m + ' ' + t)),
  ('identity', 'wrapper-instanceof', lambda m, t, x: re.search(r'(return|be) (a |an )?(new )?wrapped value|should chain|lodash constructor|return an unwrapped|`_\.chain`|implicit(ly)? chain|explicit(ly)? chain', t + ' ' + m) or re.search(r'lodash\(\.\.\.\) methods', m)),
  ('identity', 'alias-identity', lambda m, t, x: re.search(r'should be aliased', t)),
  ('identity', 'symbol-identity', lambda m, t, x: re.search(r'E=Symbol\((\w*)\) A=Symbol\(\1\)', x) or re.search(r'symbol', t, re.I) and 'clone' not in m),
  ('state', 'host-argument-mutation', lambda m, t, x: re.search(MUTATORS, m) or m == 'strict mode checks' or re.search(r'should (mutate|modify|assign|merge)', t)),
  ('representation', 'boxed-primitives', lambda m, t, x: re.search(r'(string|number|boolean|symbol) objects|Object\(|boxed|coerce', t)),
  ('identity', 'clone-of-host-values', lambda m, t, x: m == 'clone methods'),
  ('identity', 'same-text-different-reference', lambda m, t, x: all(str(a.get('expected')) == str(a.get('actual')) for a in [a for a in x if a])),
]
def classify():
    rows = []
    for k, nx in n.items():
        sx = s[k]
        lost = nx['total'] - sx['passed']
        if lost <= 0: continue
        x = text(sx)
        cat = rid = None
        for c, r, p in RULES:
            if c == 'identity' and r == 'same-text-different-reference':
                ok = sx['assertions'] and all(str(a.get('expected')) == str(a.get('actual')) and a.get('expected') not in (None,) for a in sx['assertions'])
            else:
                ok = p(k[0], k[1], x)
            if ok: cat, rid = c, r; break
        rows.append({'module': k[0], 'test': k[1], 'lost': lost, 'category': cat or 'unclassified', 'rule': rid, 'evidence': x[:300]})
    return rows
if __name__ == '__main__':
    rows = classify()
    c = collections.Counter(); r = collections.Counter()
    for x in rows: c[x['category']] += x['lost']; r[(x['category'], x['rule'])] += x['lost']
    print(sum(c.values()), dict(c)); [print(v, k) for k, v in r.most_common()]
    json.dump(rows, open('lodash-classified.json', 'w'), indent=1)
    if len(sys.argv) > 1:
        u = [x for x in rows if x['category'] == 'unclassified']
        bym = collections.Counter(x['module'] for x in u)
        for m, v in bym.most_common(60): print(v, m, '|', [ (x['test'][:50], x['evidence'][:120]) for x in u if x['module']==m][:2])
