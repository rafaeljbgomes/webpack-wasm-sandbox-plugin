import path from "node:path";

const harnessRoot = path.resolve(import.meta.dirname, "../../test-harness/yup");

export default {
  root: harnessRoot,
  resolve: {
    // Tests import the library as "../src" and, in a few files, public
    // members by internal path; all resolve to the sandboxed library's public
    // exports. Any other import of library source fails, so no test can run
    // native library code in sandbox mode. "../src/types" is type-only.
    alias: [
      { find: /^(\.\.\/)+src\/util\/printValue$/, replacement: path.resolve(import.meta.dirname, "yup-shims/printValue.js") },
      { find: /^(\.\.\/)+src\/locale$/, replacement: path.resolve(import.meta.dirname, "yup-shims/locale.js") },
      { find: /^(\.\.\/)+src\/ValidationError$/, replacement: path.resolve(import.meta.dirname, "yup-shims/ValidationError.js") },
      { find: /^(\.\.\/)+src\/util\/reach$/, replacement: path.resolve(import.meta.dirname, "yup-shims/reach.js") },
      { find: /^(\.\.\/)+src\/object$/, replacement: path.resolve(import.meta.dirname, "yup-shims/object.js") },
      { find: /^(\.\.\/)+src\/(?!types$).+$/, replacement: path.resolve(import.meta.dirname, "yup-shims/tripwire.js") },
      {
        find: /^\.\.\/src$/,
        replacement: path.resolve(
          harnessRoot,
          "../../.sandbox/proxys/yup-proxy.js",
        ),
      },
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
      // Tests an internal helper the package does not export.
      "test/util/parseIsoDate.ts",
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

