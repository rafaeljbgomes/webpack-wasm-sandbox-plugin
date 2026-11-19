import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
for (const [lim, code] of [[64*2**20, "const a=[]; for(;;) a.push(new Array(1e5).fill(1.5));"], [64*2**20, "const a=[]; for(;;) a.push({x:Math.random(), y:[1,2,3]});"], [64*2**20, "const a=[]; for(;;) a.push(new ArrayBuffer(1e6));"],[64*2**20, "const a=[]; for(;;) a.push('x'.repeat(1e6)+Math.random());"]]) {
const qjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
const vm = qjs.newContext(); vm.runtime.setMemoryLimit(lim);
const t0=performance.now();
const r = vm.evalCode(code);
const err = r.error ? vm.dump(r.error) : null;
console.log(code.slice(20,50), err && err.message, Math.round(performance.now()-t0)+'ms', qjs.getWasmMemory().buffer.byteLength/2**20+'MB');
}
process.exit(0)
