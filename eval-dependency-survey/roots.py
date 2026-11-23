"""For each September-2025 package in an app's production closure, the direct
dependencies through which it is reached."""
import json, os, sys, posixpath, collections
sys.path.insert(0, os.path.dirname(__file__))
from closure import SEPT_2025
D = sys.argv[1]
apps = [("Jitsi Meet", "jitsi", ""), ("Mattermost", "mattermost", "channels"), ("Bitwarden clients", "bitwarden", ""), ("Nextcloud server", "nextcloud", ""), ("Jellyfin web", "jellyfin", "")]
out = {}
for label, f, ws in apps:
    lock = json.load(open(f"{D}/{f}.lock.json")); pk = lock["packages"]; app = json.load(open(f"{D}/{f}.package.json"))
    def resolve(name, frm):
        cur = frm
        while True:
            cand = posixpath.join(cur, "node_modules", name) if cur else "node_modules/" + name
            if cand in pk:
                e = pk[cand]
                return (e["resolved"], pk.get(e["resolved"], {})) if e.get("link") else (cand, e)
            if not cur: return None, None
            parts = cur.split("/")
            if "node_modules" in parts:
                i = len(parts) - 1 - parts[::-1].index("node_modules"); cur = "/".join(parts[:i]).rstrip("/")
            else: cur = posixpath.dirname(cur)
    roots = collections.defaultdict(set)
    for root in app.get("dependencies", {}):
        seen = set(); stack = [(root, ws)]
        while stack:
            n, frm = stack.pop(); path, e = resolve(n, frm)
            if path is None or path in seen: continue
            seen.add(path)
            if n in SEPT_2025: roots[n].add(root)
            deps = dict(e.get("dependencies", {})); deps.update(e.get("optionalDependencies", {}))
            for p in e.get("peerDependencies", {}):
                if not e.get("peerDependenciesMeta", {}).get(p, {}).get("optional"): deps[p] = 1
            for d in deps: stack.append((d, path))
    out[label] = {k: sorted(v) for k, v in roots.items()}
    print(label); [print("   ", k, "<-", ", ".join(sorted(v))[:150]) for k, v in sorted(roots.items())]
json.dump(out, open(os.path.join(os.path.dirname(__file__), "sept2025-roots.json"), "w"), indent=1)
