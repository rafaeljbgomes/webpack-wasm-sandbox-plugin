import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
for (const code of ["const a=[]; for(;;) a.push(new Array(1e5).fill(1.5));", "const a=[]; for(;;) a.push({x:Math.random(), y:[1,2,3]});", "const a=[]; for(;;) a.push(new ArrayBuffer(1e6));", "const a=[]; for(;;) a.push('x'.repeat(1e6)+Math.random());"]) {
const mem = new WebAssembly.Memory({ initial: 256, maximum: 4096 }); // 16 MB .. 256 MB
const qjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: mem }));
const vm = qjs.newContext();
const t0=performance.now(); let out;
try { const r = vm.evalCode(code); out = r.error ? 'QuickJS ' + vm.dump(r.error).message : 'ok'; } catch (e) { out = 'host ' + e.name + ' ' + e.message.slice(0,60); }
let after; try { const r2 = vm.evalCode("1+1"); after = r2.error ? 'err' : vm.dump(r2.value); } catch(e) { after = 'host ' + e.name; }
console.log(code.slice(20,50), out, Math.round(performance.now()-t0)+'ms', mem.buffer.byteLength/2**20+'MB', 'after:', after, 'same mem', qjs.getWasmMemory()===mem);
}
process.exit(0)
