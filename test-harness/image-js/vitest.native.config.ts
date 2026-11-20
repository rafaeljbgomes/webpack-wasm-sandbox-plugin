import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
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

