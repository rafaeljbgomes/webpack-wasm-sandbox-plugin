// Which usage pattern retains memory per call? 300 marked.parse calls on the
// app's default document, three ways; reports QuickJS heap use and the number
// of pinned host-visible objects (__SANDBOX_TEMP__ entries).
import fs from "node:fs"; import path from "node:path";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";
const app = process.env.APP;
const md = new Function("return " + fs.readFileSync(path.join(app, "src/main.js"), "utf8").match(/const defaultInput = (`[\s\S]*?`);/)[1])();
const code = fs.readFileSync("dist/marked.bundle.js", "utf8");
for (const variant of ["plain", "renderer", "renderer+override"]) {
  const sb = await SandboxManager.createSandbox("marked", code, { permissions: [] });
  const m = sb.exports;
  let opts = {};
  if (variant !== "plain") {
    const renderer = new m.marked.Renderer();
    if (variant === "renderer+override") {
      const renderCode = renderer.code.bind(renderer);
      renderer.code = (token) => (token.lang === "mermaid" ? `<pre class="mermaid">${token.text}</pre>\n` : renderCode(token));
    }
    opts = { renderer };
  }
  const usage = () => { const h = sb.vm.runtime.computeMemoryUsage(); const d = sb.vm.dump(h); h.dispose(); return `${(d.memory_used_size / 1e6).toFixed(2)}MB/${d.obj_count}obj`; };
  const temp = () => sb.vm.dump(sb.vm.unwrapResult(sb.vm.evalCode("globalThis.__SANDBOX_TEMP__.size")));
  const before = { mem: usage(), temp: temp() };
  let out;
  for (let i = 0; i < 300; i++) out = m.marked.parse(md, { headerIds: false, mangle: false, ...opts });
  const after = { mem: usage(), temp: temp() };
  console.log(variant, "html", out.length, "QuickJS memory", before.mem, "->", after.mem, "pinned", before.temp, "->", after.temp);
}
process.exit(0);
