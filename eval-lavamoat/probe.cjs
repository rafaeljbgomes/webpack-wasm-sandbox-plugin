const path = require("path"); const fs = require("fs");
const webpack = require("webpack"); const LavaMoatPlugin = require("@lavamoat/webpack");
const repo = path.resolve(__dirname, ".."); const app = path.join(repo, "lib-test/security/app");
const outRoot = path.join(__dirname, "out", "lodash--lavamoat-probe");
const c = { context: app, entry: "./src/zz-lodash-probe.js", mode: "development", devtool: false, target: ["web","es2022"],
  output: { filename: "bundle.js", path: path.join(outRoot, "dist"), publicPath: "/dist/", clean: true },
  resolve: { modules: [path.join(app, "node_modules")] },
  plugins: [new LavaMoatPlugin({ generatePolicy: true, policyLocation: path.join(outRoot, "policy"), readableResourceIds: true })], stats: "errors-warnings" };
webpack(c, (e, s) => { if (e || s.hasErrors()) { console.log(e || s.toString({all:false,errors:true})); process.exit(1); }
  fs.writeFileSync(path.join(outRoot, "index.html"), fs.readFileSync(path.join(repo, "index.html"), "utf8").replace('<script src="/dist/bundle.js"></script>', '<script src="/dist/lockdown"></script><script src="/dist/bundle.js"></script>'));
  const rep = JSON.parse(fs.readFileSync(path.join(__dirname, "out/build-report.json"), "utf8")); rep["lodash--lavamoat-probe"] = { built: true }; fs.writeFileSync(path.join(__dirname, "out/build-report.json"), JSON.stringify(rep, null, 1));
  console.log("built"); process.exit(0); });
