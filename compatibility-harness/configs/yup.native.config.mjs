import path from "node:path";

const harnessRoot = path.resolve(import.meta.dirname, "../../test-harness/yup");

export default {
  root: harnessRoot,
  resolve: {
    alias: [
      {
        find: "quickjs-emscripten-sync",
        replacement: path.resolve(
          harnessRoot,
          "../../node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    setupFiles: [path.resolve(harnessRoot, "test-setup.mjs")],
    include: ["test/**/*.{js,ts}"],
    exclude: [
      "test/helpers.ts",
      "test/.eslintrc.js",
      "test/**/.eslintrc.js",
      "test/types/types.ts",
    ],
    globals: false,
    projects: [
      {
        extends: true,
        test: { name: "async" },
        define: { "global.YUP_USE_SYNC": false },
      },
      {
        extends: true,
        test: { name: "sync" },
        define: { "global.YUP_USE_SYNC": true },
      },
    ],
  },
};

