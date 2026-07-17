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

