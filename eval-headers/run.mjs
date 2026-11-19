// Browser check of the deployment headers (sandbox-stage/headers.mjs) in
// headless Chrome, with and without them:
//   app      the sandboxed strip-ansi app runs (QuickJS, one .wasm file);
//   inject   a <script src> pointing at the sandbox bundle runs library code natively?
//   eval     host-page eval() is available?
//
// Run: node --import tsx eval-headers/run.mjs
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import webpack from "webpack";
import pluginModule from "../webpack-sandbox-plugin/src/plugin.ts";
import { deploymentHeaders } from "../sandbox-stage/headers.mjs";

const { WebpackSandboxPlugin } = pluginModule;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-headers-")));
fs.mkdirSync(path.join(work, ".sandbox", "core"), { recursive: true });
fs.writeFileSync(
  path.join(work, ".sandbox", "core", "sandbox-manager.js"),
  `export * from ${JSON.stringify(pathToFileURL(path.join(repo, ".sandbox/core/sandbox-manager.js")).pathname)};\n`,
);
fs.writeFileSync(path.join(work, "policy.cjs"), `module.exports = { "strip-ansi": { permissions: [] } };\n`);
fs.writeFileSync(path.join(work, "entry.js"), [
  'import stripAnsi from "strip-ansi";',
  'document.body.dataset.app = stripAnsi("\\u001b[31msandboxed-ok\\u001b[0m");',
  "",
].join("\n"));

const stats = await new Promise((resolve, reject) => webpack({
  context: repo,
  entry: path.join(work, "entry.js"),
  mode: "production",
  devtool: false,
  target: ["web", "es2022"],
  experiments: { topLevelAwait: true, asyncWebAssembly: true },
  output: { path: path.join(work, "dist"), filename: "bundle.js", publicPath: "/dist/" },
  resolve: {
    fallback: { fs: false, path: false, url: false },
    alias: { "quickjs-emscripten-sync": path.join(repo, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js") },
  },
  plugins: [new WebpackSandboxPlugin({ configPath: path.join(work, "policy.cjs"), proxyDirectory: path.join(work, ".sandbox", "proxys") })],
  infrastructureLogging: { level: "none" },
}, (error, s) => (error ? reject(error) : s.hasErrors() ? reject(new Error(s.toString({ all: false, errors: true }))) : resolve(s))));
void stats;

const dist = path.join(work, "dist");
const wasmFiles = fs.readdirSync(dist).filter((f) => f.endsWith(".wasm"));
fs.writeFileSync(path.join(work, "inject-probe.js"), "document.body.dataset.inject = typeof __SANDBOXED_LIB__ === 'undefined' ? 'blocked' : 'RAN-NATIVELY';\n");
fs.writeFileSync(path.join(work, "eval-probe.js"), "try { document.body.dataset.eval = String(eval('1+1')); } catch (e) { document.body.dataset.eval = 'blocked:' + e.name; }\n");
const page = (scripts) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${scripts.map((s) => `<script src="${s}"></script>`).join("")}</body></html>`;
const pages = {
  "/app.html": page(["/dist/bundle.js"]),
  "/inject.html": page(["/dist/strip-ansi.bundle.js", "/inject-probe.js"]),
  "/eval.html": page(["/eval-probe.js"]),
};

const headers = deploymentHeaders({ bundles: ["strip-ansi.bundle.js"], basePath: "/dist/" });
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8", ".json": "application/json" };

function serve(withHeaders) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost").pathname;
    let body;
    if (pages[url]) body = Buffer.from(pages[url]);
    else {
      const file = path.join(work, url);
      if (!file.startsWith(work) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      body = fs.readFileSync(file);
    }
    const set = { "Content-Type": TYPES[path.extname(url)] ?? "application/octet-stream" };
    if (withHeaders) {
      if (url.endsWith(".html")) Object.assign(set, headers.document);
      Object.assign(set, headers.paths[url] ?? {});
    }
    res.writeHead(200, set);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function visit(port, route) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-profile-"));
  try {
    // Async: the server answering Chrome runs on this process's event loop.
    const { stdout: dom } = await execFileAsync(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", `http://127.0.0.1:${port}${route}`,
    ], { encoding: "utf8", timeout: 60000, maxBuffer: 1 << 24 });
    const attrs = {};
    for (const [, k, v] of dom.matchAll(/data-([a-z]+)="([^"]*)"/g)) attrs[k] = v;
    return attrs;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const results = { chrome: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(), wasmFilesShipped: wasmFiles.length, headers };
for (const withHeaders of [false, true]) {
  const server = await serve(withHeaders);
  const { port } = server.address();
  results[withHeaders ? "withHeaders" : "withoutHeaders"] = {
    app: (await visit(port, "/app.html")).app ?? "(not run)",
    inject: (await visit(port, "/inject.html")).inject ?? "(probe not run)",
    eval: (await visit(port, "/eval.html")).eval ?? "(probe not run)",
  };
  server.close();
}
console.log(JSON.stringify(results, null, 1));
fs.rmSync(work, { recursive: true, force: true });
