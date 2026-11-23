"""Production dependency closure of a browser app from its npm lockfile (v2/v3).
Starts from the app's package.json `dependencies` (not dev), resolves each
name the way Node does (nearest node_modules up the tree), and follows
`dependencies`, `optionalDependencies` and non-optional `peerDependencies`."""
import json, sys, os, posixpath
SEPT_2025 = ["ansi-regex", "ansi-styles", "backslash", "chalk", "chalk-template", "color-convert", "color-name", "color-string",
             "debug", "error-ex", "has-ansi", "is-arrayish", "simple-swizzle", "slice-ansi", "strip-ansi", "supports-color",
             "supports-hyperlinks", "wrap-ansi", "proto-tinker-wc", "color"]
def closure(lock_path, pkg_path, workspace=""):
    lock = json.load(open(lock_path)); pk = lock["packages"]; app = json.load(open(pkg_path))
    def resolve(name, frm):
        cur = frm
        while True:
            cand = posixpath.join(cur, "node_modules", name) if cur else "node_modules/" + name
            if cand in pk:
                e = pk[cand]
                if e.get("link"): return e["resolved"], pk.get(e["resolved"], {})
                return cand, e
            if not cur: return None, None
            # step up past the enclosing node_modules/<pkg>
            parts = cur.split("/")
            if "node_modules" in parts:
                i = len(parts) - 1 - parts[::-1].index("node_modules")
                cur = "/".join(parts[:i])
                if cur.endswith("/"): cur = cur[:-1]
            else:
                cur = posixpath.dirname(cur)
    seen = {}; missing = set()
    stack = [(n, workspace) for n in app.get("dependencies", {})]
    while stack:
        n, frm = stack.pop()
        path, e = resolve(n, frm)
        if path is None: missing.add(n); continue
        if path in seen: continue
        seen[path] = n
        deps = dict(e.get("dependencies", {})); deps.update(e.get("optionalDependencies", {}))
        for p, v in e.get("peerDependencies", {}).items():
            if not e.get("peerDependenciesMeta", {}).get(p, {}).get("optional"): deps[p] = v
        for d in deps: stack.append((d, path))
    names = {}
    for path, n in seen.items():
        names.setdefault(n, set()).add(pk[path].get("version") if path in pk else "?")
    return app, names, missing
if __name__ == "__main__":
    D = sys.argv[1]
    apps = [("Jitsi Meet", "jitsi.lock.json", "jitsi.package.json", ""),
            ("Mattermost", "mattermost.lock.json", "mattermost.package.json", "channels"),
            ("Bitwarden clients", "bitwarden.lock.json", "bitwarden.package.json", ""),
            ("Nextcloud server", "nextcloud.lock.json", "nextcloud.package.json", ""),
            ("Jellyfin web", "jellyfin.lock.json", "jellyfin.package.json", "")]
    out = {}
    for label, lf, pf, ws in apps:
        app, names, missing = closure(os.path.join(D, lf), os.path.join(D, pf), ws)
        sept = {s: sorted(names[s]) for s in SEPT_2025 if s in names}
        out[label] = {"direct": sorted(app.get("dependencies", {})), "closure": len(names), "unresolved": sorted(missing), "sept2025": sept}
        print(f"{label:18} direct={len(app.get('dependencies', {})):4} prod-closure={len(names):5} unresolved={len(missing)} sept2025={sept}")
    json.dump(out, open(os.path.join(os.path.dirname(__file__), "closures.json"), "w"), indent=1)
