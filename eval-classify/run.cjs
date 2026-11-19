// Builds one entry per documented deep import, with classification off and on.
require("tsx/cjs");
const path = require("path"), fs = require("fs"), webpack = require("webpack");
const { WebpackSandboxPlugin } = require("../webpack-sandbox-plugin/src/plugin.ts");
const root = path.resolve(__dirname, "..");
const cases = {
  "date-fns/locale": "import { ptBR } from 'date-fns/locale'; export default ptBR.code;",
  "lodash/get": "import get from 'lodash/get.js'; export default get({a:1}, 'a');",
  "zod/mini": "import * as z from 'zod/mini'; export default z.string();",
  "mime/lite": "import mime from 'mime/lite'; export default mime.getType('a.txt');",
  "root-only (control)": "import { format } from 'date-fns'; import _ from 'lodash'; import * as z from 'zod'; import mime from 'mime'; export default [format, _, z, mime];",
};
function build(name, src, mode) {
  const dir = path.join(__dirname, "out", name.replace(/[^a-z0-9]+/gi, "_"), mode);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, "entry.js"); fs.writeFileSync(entry, src);
  const t0 = process.hrtime.bigint();
  return new Promise((res) => webpack({
    context: root, entry, mode: "development", devtool: false, target: ["web", "es2022"],
    experiments: { topLevelAwait: true },
    output: { path: path.join(dir, "dist"), filename: "bundle.js" },
    resolve: { fallback: { fs: false, path: false, url: false }, alias: { "quickjs-emscripten-sync": path.resolve(root, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js") } },
    plugins: [new WebpackSandboxPlugin({ configPath: "eval-classify/sandbox.config.cjs",
      proxyDirectory: path.join(root, ".sandbox", "proxys"), classification: { mode } })],
    infrastructureLogging: { level: "none" },
  }, (err, stats) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const host = stats.toJson({ all: false, modules: true, modulesSpace: Infinity }).modules.map((m) => m.name || "");
    const native = Object.fromEntries(["date-fns", "lodash", "zod", "mime"].map((p) =>
      [p, host.filter((n) => n.startsWith(`./node_modules/${p}/`)).length]));
    res({ name, mode, ok: !stats.hasErrors(), ms: Math.round(ms), nativeModulesInHost: native,
      firstError: stats.hasErrors() ? stats.toJson({ all: false, errors: true }).errors[0].message.slice(0, 160) : "" });
  }));
}
(async () => {
  const origLog = console.log; console.log = () => {};
  const rows = [];
  for (const [n, s] of Object.entries(cases)) for (const m of ["off", "error"]) rows.push(await build(n, s, m));
  console.log = origLog;
  console.log(JSON.stringify(rows, null, 1));
})();
