// Sandbox mode: every import of zod resolves to the generated proxy, so the
// tests (unmodified) call the library inside QuickJS. zod/v4/core is served
// from the sandboxed library's z.core. Any other zod subpath fails to load.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(import.meta.dirname, "../..");
const proxy = resolve(root, ".sandbox/proxys/zod-proxy.js");
const coreShim = resolve(import.meta.dirname, "sandbox-core-shim.js");
const tripwire = resolve(import.meta.dirname, "sandbox-tripwire.js");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^zod\/v4\/core$/, replacement: coreShim },
      { find: /^zod(\/v4)?$/, replacement: proxy },
      { find: /^zod\/.*$/, replacement: tripwire },
      {
        find: "quickjs-emscripten-sync",
        replacement: resolve(root, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js"),
      },
    ],
  },
  test: {
    include: ["packages/zod/src/v4/classic/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/fix-json-issue.test.ts", "**/coalesce.test.ts", "**/json.test.ts"],
    isolate: true,
    setupFiles: [resolve(import.meta.dirname, "scripts/fail-on-console.ts")],
    silent: true,
  },
});
