"""Fetches description/keywords of each direct dependency's latest release
from the public npm registry (package names only)."""
import json, os, sys, urllib.request, urllib.parse, concurrent.futures
here = os.path.dirname(__file__)
c = json.load(open(os.path.join(here, "closures.json")))
names = sorted({n for a in c.values() for n in a["direct"]})
def get(n):
    url = "https://registry.npmjs.org/" + n.replace("/", "%2F") + "/latest"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dependency-survey"}), timeout=30) as r:
            d = json.load(r)
        return n, {"description": (d.get("description") or "")[:200], "keywords": (d.get("keywords") or [])[:12] if isinstance(d.get("keywords"), list) else [],
                   "peer": sorted((d.get("peerDependencies") or {}).keys()), "browser": "browser" in d}
    except Exception as e:
        return n, {"error": str(e)[:80]}
with concurrent.futures.ThreadPoolExecutor(8) as ex:
    meta = dict(ex.map(get, names))
json.dump(meta, open(os.path.join(here, "meta.json"), "w"), indent=1)
print(len(names), sum(1 for v in meta.values() if "error" in v))
