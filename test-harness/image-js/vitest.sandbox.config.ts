import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const srcDir = `${resolve(import.meta.dirname, "src").replaceAll("\\", "/")}/`;
const proxyPath = resolve(
  import.meta.dirname,
  "../../.sandbox/proxys/image-js-proxy.js",
).replaceAll("\\", "/");

function sandboxSourceRedirect(): Plugin {
  const shim = `export * from ${JSON.stringify(proxyPath)};\n`;

  return {
    name: "sandbox-source-redirect",
    enforce: "pre",
    load(id) {
      const normalId = id.replaceAll("\\", "/");
      if (normalId === proxyPath) return;
      if (normalId.includes("/__tests__/") || normalId.endsWith(".test.ts")) return;
      if (normalId.startsWith(srcDir)) {
        return { code: shim, map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [sandboxSourceRedirect()],
  resolve: {
    alias: [
      { find: "image-js", replacement: proxyPath },
      {
        find: "quickjs-emscripten-sync",
        replacement: resolve(
          import.meta.dirname,
          "../../node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
        ),
      },
    ],
  },
  test: {
    // Test files whose imports from the library are all names the package
    // exports (selected by select-public-api-tests.mjs); the others test
    // internal functions that no consumer, sandboxed or not, can import.
    include: JSON.parse(readFileSync(resolve(import.meta.dirname, "public-api-tests.json"), "utf8")),
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 10_000,
    coverage: {
      include: ["src/**/*.ts"],
    },
    reporters: [
      "default",
      "jest-image-snapshot/src/outdated-snapshot-reporter.js",
    ],
  },
});

