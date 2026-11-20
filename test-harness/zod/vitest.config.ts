// Native mode: the upstream test files against the installed zod@4.3.6.
// Type-checking is off (the comparison is about runtime behaviour), and
// fix-json-issue.test.ts is excluded in both modes because it tests the
// separate zod/mini entry point, which is not configured for sandboxing.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/zod/src/v4/classic/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/fix-json-issue.test.ts", "**/coalesce.test.ts", "**/json.test.ts"],
    isolate: true,
    setupFiles: [resolve(import.meta.dirname, "scripts/fail-on-console.ts")],
    silent: true,
  },
});
