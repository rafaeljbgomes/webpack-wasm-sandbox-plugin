"""Extract per-test failure blocks (Jest/Vitest '●'/'FAIL' sections) from a run log."""
import re, sys
def jest_blocks(text):
    out = {}
    cur = None
    for line in text.splitlines():
        m = re.match(r'\s{2}● (.*)$', line)
        if m:
            cur = m.group(1).strip(); out.setdefault(cur, []); continue
        if re.match(r'^(PASS|FAIL) ', line) or line.startswith('Test Suites:'):
            cur = None; continue
        if cur is not None: out[cur].append(line)
    return {k: '\n'.join(v) for k, v in out.items()}
if __name__ == '__main__':
    b = jest_blocks(open(sys.argv[1], errors='replace').read())
    print(len(b))

def vitest_blocks(text):
    """' FAIL  file > name' sections of a Vitest log, keyed by 'name' (last part)."""
    out = {}
    cur = None
    for line in text.splitlines():
        m = re.match(r'^ FAIL  (\S+) > (.*)$', line)
        if m:
            cur = m.group(1).split('/')[-1] + ' >> ' + m.group(2).strip(); out.setdefault(cur, []); continue
        if line.startswith('⎯⎯') or line.startswith(' Test Files') or line.startswith('⎯⎯⎯'):
            cur = None; continue
        if cur is not None: out[cur].append(line)
    return {k: '\n'.join(v) for k, v in out.items()}
