"""Summaries of the cross-browser runs: per (workload, mode) the median time
per call over iterations, the ratio of medians to native with a 95% bootstrap
interval (10,000 resamplings of the iterations of each mode, seed 7), and for
steady state the median over iterations of the per-iteration p95/p99."""
import json, sys, random, statistics as st, os
here = os.path.dirname(os.path.abspath(__file__))
def load(b, phase):
    f = os.path.join(here, f"results-xbrowser-{b}-{phase}.json")
    if not os.path.exists(f): return None
    d = json.load(open(f))
    # Re-runs after the Firefox/WebKit constructor fix replace the rows of the
    # workloads they cover.
    g = os.path.join(here, f"results-xbrowser-{b}-{phase}-rerun.json")
    if os.path.exists(g):
        r = json.load(open(g)); ids = {x["id"] for x in r["rows"]}
        d["rows"] = [x for x in d["rows"] if x["id"] not in ids] + r["rows"]
    return d
def boot(a, b, n=10000, seed=7):
    r = random.Random(seed); out = []
    for _ in range(n):
        out.append(st.median([r.choice(a) for _ in a]) / st.median([r.choice(b) for _ in b]))
    out.sort(); return out[int(0.025 * n)], out[int(0.975 * n)]
def summarize(b, phase):
    d = load(b, phase)
    if not d: return None
    key = "scenarioMs" if phase == "cold" else "steadyMs"
    rows = {}
    for x in d["rows"]:
        if x.get("error") or x.get("warmup"): continue
        rows.setdefault((x["id"], x["mode"]), []).append(x)
    res = {"version": d["version"], "workloads": {}}
    for (wid, mode), xs in rows.items():
        v = [x[key] for x in xs]
        e = {"n": len(v), "median": st.median(v)}
        if phase == "cold": e["readyMedian"] = st.median([x["readyAtMs"] for x in xs])
        else:
            e["p95"] = st.median([x["p95"] for x in xs]); e["p99"] = st.median([x["p99"] for x in xs]); e["calls"] = xs[0]["measuredCalls"]
        res["workloads"].setdefault(wid, {})[mode] = e
    for wid, m in res["workloads"].items():
        if "native" not in m: continue
        nv = [x[key] for x in rows[(wid, "native")]]
        for mode in ("sandbox", "lavamoat"):
            if mode in m:
                mv = [x[key] for x in rows[(wid, mode)]]
                m[mode]["ratio"] = st.median(mv) / st.median(nv)
                m[mode]["ci"] = boot(mv, nv)
    errs = [x for x in d["rows"] if x.get("error")]
    res["errors"] = [(x["id"], x["mode"], x["error"][:120]) for x in errs]
    return res
out = {}
for b in ("chrome", "firefox", "webkit"):
    for ph in ("cold", "steady"):
        s = summarize(b, ph)
        if s: out[f"{b}-{ph}"] = s
json.dump(out, open(os.path.join(here, "summary-xbrowser.json"), "w"), indent=1)
for k, s in out.items():
    print("==", k, s["version"], "errors:", s["errors"])
    for wid, m in s["workloads"].items():
        line = f"  {wid:17}"
        for mode in ("native", "sandbox", "lavamoat"):
            if mode in m:
                e = m[mode]
                line += f" {mode[:3]} {e['median']:9.4f}"
                if "ratio" in e: line += f" x{e['ratio']:7.1f} [{e['ci'][0]:.1f},{e['ci'][1]:.1f}]"
                if "p95" in e: line += f" p95 {e['p95']:.3f} p99 {e['p99']:.3f} M={e['calls']}"
        print(line)
