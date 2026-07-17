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
      if (
        normalId.includes("/getMaskFromCannyEdge.") ||
        normalId.includes("/point/operations.") ||
        normalId.includes("/greyAlgorithms.") ||
        normalId.includes("/sampleBackgroundPoints.")
      ) {
        return;
      }
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
    include: ["src/maskAnalysis/__tests__/**/*.ts"],
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

