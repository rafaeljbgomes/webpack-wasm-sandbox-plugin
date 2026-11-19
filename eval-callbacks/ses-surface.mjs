// Shared-realm surface of an SES compartment: objects reachable from a fresh
// Compartment's globalThis that are SHARED with the host realm (the same
// identities the application uses). Isolation in a compartment depends on all
// of these being correctly hardened by lockdown().
// Run from this directory: node ses-surface.mjs
import "ses";

lockdown();
const compartment = new Compartment();
const start = compartment.globalThis;

// Everything reachable from the host realm's own intrinsics, to decide sharing.
function reachable(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const value = stack.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (proto) stack.push(proto);
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d) continue;
      if ("value" in d) stack.push(d.value);
      if (d.get) stack.push(d.get);
      if (d.set) stack.push(d.set);
    }
  }
  return seen;
}

const fromCompartment = reachable([start]);
const fromHost = reachable([globalThis]);
const shared = [...fromCompartment].filter((v) => fromHost.has(v) && v !== start);
const functions = shared.filter((v) => typeof v === "function");
const notFrozen = shared.filter((v) => !Object.isFrozen(v));
console.log(JSON.stringify({
  sesVersion: "2.3.0",
  compartmentGlobalOwnKeys: Reflect.ownKeys(start).length,
  reachableFromCompartment: fromCompartment.size,
  sharedWithHostRealm: shared.length,
  sharedFunctions: functions.length,
  sharedNotFrozen: notFrozen.length,
}, null, 1));
