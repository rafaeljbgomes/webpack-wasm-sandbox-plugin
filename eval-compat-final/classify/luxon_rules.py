import re, json, collections, sys
from jest_common import failures, classify
R = lambda pat, *keys: (lambda h: any(re.search(pat, h[k]) for k in keys))
RULES = [
  ('env', 'test-removes-host-Intl-API', R(r'With no (RelativeTimeFormat|Intl)', 'name')),
  ('identity', 'error-class-crosses-as-QuickJSUnwrapError', R(r'Received constructor: QuickJSUnwrapError', 'block')),
  ('state', 'host-writes-library-Settings', R(r'throwOnInvalid', 'name')),
  ('state', 'host-writes-library-Settings', R(r'Settings\.\w+\s*=|with(Default\w+|Now|ThrowOnInvalid|TwoDigit\w*)\(|Helpers\.with\w+|withDefault|withNow|setUnset|Settings\.(defaultZone|defaultLocale|now|twoDigitCutoffYear|throwOnInvalid|defaultWeekSettings)', 'body', 'name')),
  ('identity', 'subclass-of-library-class', R(r'Zone is an abstract class', 'msg', 'block')),
  ('identity', 'cross-realm-iterator', R(r'Array Iterator\.prototype\.next called on incompatible receiver', 'msg', 'block')),
  ('identity', 'instanceof', R(r'toBeInstanceOf', 'msg')),
  ('identity', 'same-value-different-reference', R(r'serializes to the same string', 'block')),
  ('defect', 'getter-on-object-read-through-property', lambda h: re.search(r'>\s*\d+ \|.*(\.(start|end|zone)\.\w+|utcInstance\.\w+|\.zone\.name)', h['block']) or re.search(r'utc[+-]\d|setZone accepts "utc|adopts the UTC offset|ordinalTtime\+offset|fromISO accepts a zone argument', h['name'])),
  ('representation', 'host-Date-argument', lambda h: 'info.test.js' == h['file'] and 'toObject' in h['name']),
  ('representation', 'host-Date-argument', R(r'Received: (NaN|"UTC-NaN")|this is not a Date object', 'block', 'msg')),
  ('representation', 'host-Date-argument', lambda h: re.search(r'^const \w+ = DateTime\.fromJSDate\(new Date|DateTime\.fromJSDate\(new Date', h['filetext'], re.M) and re.search(r'Received: (null|"invalid input")|toThrow\(\)', h['block'] + h['msg'])),
  ('representation', 'week-data-of-granted-Intl.Locale', R(r'localeWeek|useLocaleWeeks|localWeek|isWeekend|toFormat\(.(n|ii|iiii|nn).\)', 'file', 'name', 'body')),
]
rows = classify(failures('luxon'), RULES)
c = collections.Counter(x['category'] for x in rows); r = collections.Counter((x['category'], x['rule']) for x in rows)
print(len(rows), dict(c)); [print(v, k) for k, v in r.most_common()]
json.dump([{k: x[k] for k in ('file', 'test', 'message', 'category', 'rule')} for x in rows], open('luxon-classified.json', 'w'), indent=1)
if len(sys.argv) > 1:
    for x in rows:
        if x['category'] == 'unclassified':
            code = [l.strip() for l in x['block'].split('\n') if l.strip().startswith('>')][:1]
            rec = re.findall(r'(Expected|Received): (.*)', x['block'])[:2]
            print('U', x['file'].split('/test/')[-1], '|', x['test'][:70], '|', x['message'][:60].replace('\n', ' '), rec, code)
