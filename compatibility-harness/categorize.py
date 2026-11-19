# Classifies sandbox-only test failures into the categories used in the paper.
# Usage: python3 categorize.py <failures.csv> [category-to-list]
import csv, re, sys, collections, json
RULES = [
    ("class identity (instanceof)", r"instance of|instanceof"),
    ("reference identity (Object.is)", r"Object\.is equality|to be \[Function"),
    ("internal API not in declarations", r"is not a function|does not exist|is not defined"),
    ("host mocks/spies not seen by VM", r"to be called with|toHaveBeenCalled|spy"),
    ("value/representation differs", r"deeply equal|toEqual|Snapshot|to be '|expected '|Invalid Date"),
    ("error raised inside VM callback", r"eval\.js|<anonymous>"),
]
def cat(msg):
    for name, rx in RULES:
        if re.search(rx, msg or ""): return name
    return "other"
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["mode"] == "sandbox"]
uniq = {}
keyn = 0
for r in rows:
    keyn += 1; uniq[(r["file"], r["test"], keyn)] = r["message"] or ""
c = collections.Counter(cat(m) for m in uniq.values())
print(json.dumps({"total": len(uniq), **dict(c.most_common())}))
if len(sys.argv) > 2:
    for (f, t, _), m in uniq.items():
        if cat(m) == sys.argv[2]: print(" -", t[:70], "|", m[:110].replace("\n", " "))
