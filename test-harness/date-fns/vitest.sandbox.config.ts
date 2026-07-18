import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/test.ts"],
    alias: {
      "./index.ts": resolve(
        import.meta.dirname,
        "../../.sandbox/proxys/date-fns-proxy.js",
      ),
      "quickjs-emscripten-sync": resolve(
        import.meta.dirname,
        "../../node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
      ),
    },
    isolate: false,
    browser: {
      name: "chromium",
      provider: "playwright",
      headless: true,
    },
  },
});
