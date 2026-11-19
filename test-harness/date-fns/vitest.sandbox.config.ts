import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/test.ts"],
    // Each test imports its function from "./index.js" (date-fns 4.x source);
    // redirect both spellings to the generated proxy.
    alias: [
      {
        find: /^\.\/index\.(ts|js)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../.sandbox/proxys/date-fns-proxy.js",
        ),
      },
      {
        find: "quickjs-emscripten-sync",
        replacement: resolve(
          import.meta.dirname,
          "../../node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
        ),
      },
    ],
    isolate: false,
    browser: {
      name: "chromium",
      provider: "playwright",
      headless: true,
    },
  },
});
