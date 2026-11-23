// The same count as ses-surface.mjs, in a browser realm (Chrome, Firefox,
// WebKit): SES 2.3.0's browser build is loaded into a blank page, lockdown()
// runs, and the objects reachable from a fresh Compartment that are shared
// with the page's realm are counted.
// Run from the repository root: node eval-callbacks/ses-surface-browser.mjs
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright-core";
const ses = fs.readFileSync(new URL("../node_modules/ses/dist/ses.umd.js", import.meta.url), "utf8");
const count = () => {
  lockdown();
  const start = new Compartment().globalThis;
  function reachable(roots) {
    const seen = new Set(); const stack = [...roots];
    while (stack.length) {
      const value = stack.pop();
      if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
      seen.add(value);
      const proto = Object.getPrototypeOf(value); if (proto) stack.push(proto);
      for (const key of Reflect.ownKeys(value)) {
        const d = Object.getOwnPropertyDescriptor(value, key); if (!d) continue;
        if ("value" in d) stack.push(d.value); if (d.get) stack.push(d.get); if (d.set) stack.push(d.set);
      }
    }
    return seen;
  }
  const fromCompartment = reachable([start]);
  const fromHost = reachable([globalThis]);
  const shared = [...fromCompartment].filter((v) => fromHost.has(v) && v !== start);
  return { reachableFromCompartment: fromCompartment.size, sharedWithHostRealm: shared.length,
    sharedFunctions: shared.filter((v) => typeof v === "function").length, sharedNotFrozen: shared.filter((v) => !Object.isFrozen(v)).length };
};
const out = {};
for (const [name, launch] of [["chrome", () => chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true })], ["firefox", () => firefox.launch()], ["webkit", () => webkit.launch()]]) {
  const b = await launch(); const p = await b.newPage();
  await p.setContent("<!doctype html><title>x</title>");
  await p.addScriptTag({ content: ses });
  out[name] = { version: b.version(), ...(await p.evaluate(count)) };
  await b.close();
}
fs.writeFileSync(new URL("./ses-surface-browser.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
