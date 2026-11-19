// Probe: can sandboxed code mutate host objects it can reach (granted APIs,
// objects passed as arguments) through the proxy write-back dispatcher?
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-callbacks/granted-mutation.mjs
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

const attackerLibrary = `
var __SANDBOXED_LIB__ = {
  patchGranted() {
    const out = {};
    try { Intl.DateTimeFormat = function () { return "pwned"; }; out.assign = "ok"; } catch (e) { out.assign = "threw: " + e.message; }
    try { Intl.__injected = 1; out.add = "ok"; } catch (e) { out.add = "threw: " + e.message; }
    try { delete Intl.NumberFormat; out.del = "ok"; } catch (e) { out.del = "threw: " + e.message; }
    try { Object.getPrototypeOf(new Intl.Collator()).compare = () => 0; out.proto = "ok"; } catch (e) { out.proto = "threw: " + e.message; }
    try { TextEncoder.prototype.encode = () => "pwned"; out.textEncoderProto = "ok"; } catch (e) { out.textEncoderProto = "threw: " + e.message; }
    return out;
  },
  mutateArgument(o) {
    o.added = "from-sandbox";
    o.nested.value = "changed";
    try { o.__proto__.polluted = "yes"; } catch (e) {}
    delete o.removeMe;
    return true;
  },
  callbackProbe(cb) {
    // What can a callback reveal? Try to reach host globals through it.
    const out = {};
    try { out.ctorName = cb.constructor && cb.constructor.name; } catch (e) { out.ctorName = "threw"; }
    try { out.fetchViaCtor = cb.constructor("return typeof fetch")(); } catch (e) { out.fetchViaCtor = "threw: " + e.message; }
    try { out.processViaCtor = cb.constructor("return typeof process")(); } catch (e) { out.processViaCtor = "threw: " + e.message; }
    try { out.ctorIsVmFunction = cb.constructor === Function; } catch (e) { out.ctorIsVmFunction = "threw"; }
    try { out.callerOrArgs = String(cb.caller) + "/" + String(cb.arguments); } catch (e) { out.callerOrArgs = "threw: " + e.message.slice(0, 40); }
    try { out.cbResult = cb(); } catch (e) { out.cbResult = "threw"; }
    try { cb.injected = 1; out.setProp = "ok"; } catch (e) { out.setProp = "threw: " + e.message; }
    return out;
  },
};`;

const originalEncode = TextEncoder.prototype.encode;
const snapshot = () => ({
  dtfIsNative: Intl.DateTimeFormat.toString().includes("[native code]"),
  injected: Intl.__injected,
  numberFormat: typeof Intl.NumberFormat,
  collatorCompareUnchanged: typeof Object.getOwnPropertyDescriptor(Intl.Collator.prototype, "compare").get === "function",
  textEncoderSame: TextEncoder.prototype.encode === originalEncode,
});

const sandbox = await SandboxManager.createSandbox("attacker", attackerLibrary, {
  permissions: ["Intl", "TextEncoder"],
});
const before = snapshot();
const inside = sandbox.exports.patchGranted();
const after = snapshot();
console.log("granted-API mutation:", JSON.stringify({ inside, before, after }, null, 1));
console.log("host Intl.DateTimeFormat still works:", new Intl.DateTimeFormat("en-US").format(new Date(0)) !== "pwned");

const arg = { nested: { value: "orig" }, removeMe: true };
sandbox.exports.mutateArgument(arg);
console.log("argument mutation seen by host:", JSON.stringify({
  added: arg.added, nested: arg.nested.value, removeMe: "removeMe" in arg, protoPolluted: ({}).polluted,
}));

function hostCallback() { return 1; }
const probe = sandbox.exports.callbackProbe(hostCallback);
probe.hostSawInjectedProp = hostCallback.injected;
console.log("callback probe:", JSON.stringify(probe));

sandbox.dispose();
process.exit(0);
