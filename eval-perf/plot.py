import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
s = json.load(open(sys.argv[1]))
names = {"strip-ansi": "strip-ansi", "mime": "MIME", "date-fns": "date-fns", "image-js": "ImageJS", "marked": "Marked", "yup": "Yup",
         "tweetnacl": "TweetNaCl", "zod": "Zod", "lodash": "Lodash", "luxon": "Luxon",
         "lodash-adapter": "Lodash (adapter)", "zod-adapter": "Zod (adapter)", "luxon-adapter": "Luxon (adapter)", "image-js-adapter": "ImageJS (adapter)"}
order = sorted([k for k in s if not k.endswith("adapter")], key=lambda k: s[k]["sandbox_ratio"]) + ["image-js-adapter", "luxon-adapter", "zod-adapter", "lodash-adapter"]
fig, ax = plt.subplots(figsize=(7.2, 4.6))
y = list(range(len(order)))[::-1]
h = 0.38
for off, mode, color, label in [(h / 2, "sandbox", "#2a6fbb", "This work (QuickJS/Wasm)"), (-h / 2, "lavamoat", "#d08a2c", "LavaMoat (SES)")]:
    v = [s[k][f"{mode}_ratio"] for k in order]
    lo = [s[k][f"{mode}_ratio"] - s[k][f"{mode}_ci"][0] for k in order]
    hi = [s[k][f"{mode}_ci"][1] - s[k][f"{mode}_ratio"] for k in order]
    ax.barh([yy + off for yy in y], v, height=h, color=color, label=label, xerr=[lo, hi], error_kw=dict(lw=0.8, capsize=2))
    # Place each label past the upper end of its error bar so it never overlaps it.
    for yy, val, up in zip(y, v, hi):
        ax.text((val + up) * 1.1, yy + off, f"{val:.1f}×" if val < 10 else f"{val:.0f}×", va="center", fontsize=7)
ax.axvline(1, color="#555", lw=0.8)
ax.axhline(3.5, color="#999", lw=0.6, ls="--")
ax.set_xscale("log")
ax.set_xlim(0.8, 600)
ax.set_yticks(y)
ax.set_yticklabels([names[k] for k in order], fontsize=8)
ax.set_xlabel("Median time per workload call, relative to native (log scale)", fontsize=8)
ax.tick_params(axis="x", labelsize=8)
ax.legend(fontsize=8, loc="lower right", frameon=False)
for side in ["top", "right"]: ax.spines[side].set_visible(False)
fig.tight_layout()
fig.savefig(sys.argv[2])
print("ok")
