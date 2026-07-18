import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const ESM_LOADER = "../../test-sandbox-redirect/register-sandbox.mjs";
const CJS_LOADER = "../../test-sandbox-redirect/register-sandbox-cjs.mjs";

function nodeCommand(args, options = {}) {
  return {
    executable: process.execPath,
    args,
    ...options,
  };
}

function npmCommand(script) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `npm run ${script}`],
    };
  }
  return {
    executable: "npm",
    args: ["run", script],
  };
}

function vitestCommand(configFile) {
  return ({ harnessDir, reportPath, testFiles = [] }) =>
    nodeCommand([
      resolve(harnessDir, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      configFile,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...testFiles,
    ]);
}

function zodCommand(configFile) {
  return ({ harnessDir, reportPath, testFiles = [] }) =>
    nodeCommand([
      resolve(harnessDir, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      configFile,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...testFiles,
    ]);
}

function markedTestFiles(harnessDir) {
  return readdirSync(resolve(harnessDir, "test/unit"))
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => `test/unit/${file}`);
}

export const compatibilityManifest = [
  {
    name: "date-fns",
    runner: "vitest",
    harness: "test-harness/date-fns",
    proxy: ".sandbox/proxys/date-fns-proxy.js",
    strategy: "suite",
    modeStrategies: {
      sandbox: {
        strategy: "batch",
        batchSize: 10,
        fallback: "per-file",
      },
    },
    discovery: {
      root: "src",
      fileName: "test.ts",
    },
    testFilePattern: "src/**/test.ts",
    parser: "vitest-json",
    commands: {
      native: [vitestCommand("./vitest.native.config.ts")],
      sandbox: [vitestCommand("./vitest.sandbox.config.ts")],
    },
  },
  {
    name: "image-js",
    runner: "vitest",
    harness: "test-harness/image-js",
    proxy: ".sandbox/proxys/image-js-proxy.js",
    strategy: "suite",
    testFilePattern: "src/maskAnalysis/__tests__/**/*.ts",
    parser: "vitest-json",
    commands: {
      native: [vitestCommand("./vitest.native.config.ts")],
      sandbox: [vitestCommand("./vitest.sandbox.config.ts")],
    },
  },
  {
    name: "lodash",
    runner: "qunit",
    harness: "test-harness/lodash",
    proxy: ".sandbox/proxys/lodash-proxy.js",
    strategy: "suite",
    testFilePattern: "test/test.js,test/test-fp.js",
    parser: "qunit",
    commands: {
      native: [
        () => npmCommand("test:main"),
        () => npmCommand("test:fp"),
      ],
      sandbox: [
        () => npmCommand("test:sandbox"),
        () => npmCommand("test:sandbox-fp"),
      ],
    },
  },
  {
    name: "luxon",
    runner: "jest",
    harness: "test-harness/luxon",
    proxy: ".sandbox/proxys/luxon-proxy.js",
    strategy: "suite",
    testFilePattern: "test/**/*.test.js",
    parser: "jest-json",
    commands: {
      native: [
        ({ harnessDir, reportPath }) =>
          nodeCommand([
            resolve(harnessDir, "node_modules/jest/bin/jest.js"),
            "--config",
            "./jest.native.config.js",
            "--coverage=false",
            "--json",
            `--outputFile=${reportPath}`,
          ]),
      ],
      sandbox: [
        ({ harnessDir, reportPath }) =>
          nodeCommand([
            "--experimental-vm-modules",
            resolve(harnessDir, "node_modules/jest/bin/jest.js"),
            "--config",
            "./jest.sandbox.config.js",
            "--coverage=false",
            "--runInBand",
            "--json",
            `--outputFile=${reportPath}`,
          ]),
      ],
    },
  },
  {
    name: "marked",
    runner: "node:test",
    harness: "test-harness/marked",
    proxy: ".sandbox/proxys/marked-proxy.js",
    strategy: "suite",
    testFilePattern: "test/unit/*.test.js",
    parser: "tap",
    commands: {
      native: [
        ({ harnessDir }) =>
          nodeCommand(["--test", "--test-reporter=tap", ...markedTestFiles(harnessDir)]),
      ],
      sandbox: [
        ({ harnessDir }) =>
          nodeCommand([
            "--import",
            ESM_LOADER,
            "--test",
            "--test-reporter=tap",
            ...markedTestFiles(harnessDir),
          ]),
      ],
    },
  },
  {
    name: "mime",
    runner: "node:test",
    harness: "test-harness/mime",
    proxy: ".sandbox/proxys/mime-proxy.js",
    strategy: "suite",
    testFilePattern: "test/**/*.test.js",
    parser: "tap",
    commands: {
      native: [() => nodeCommand(["--test", "--test-reporter=tap"])],
      sandbox: [
        () =>
          nodeCommand([
            "--import",
            ESM_LOADER,
            "--test",
            "--test-reporter=tap",
          ]),
      ],
    },
  },
  {
    name: "strip-ansi",
    runner: "ava",
    harness: "test-harness/strip-ansi",
    proxy: ".sandbox/proxys/strip-ansi-proxy.js",
    strategy: "suite",
    testFilePattern: "test-original.js",
    parser: "tap",
    commands: {
      native: [
        ({ repoRoot }) =>
          nodeCommand([
            resolve(repoRoot, "node_modules/ava/entrypoints/cli.mjs"),
            "--tap",
            "test-original.js",
          ]),
      ],
      sandbox: [
        ({ repoRoot }) =>
          nodeCommand([
            "--import",
            ESM_LOADER,
            resolve(repoRoot, "node_modules/ava/entrypoints/cli.mjs"),
            "--tap",
            "test-original.js",
          ]),
      ],
    },
  },
  {
    name: "tweetnacl",
    runner: "tape",
    harness: "test-harness/tweetnacl-js",
    proxy: ".sandbox/proxys/tweetnacl-proxy.js",
    strategy: "suite",
    testFilePattern: "test/*.js",
    parser: "tap",
    commands: {
      native: [
        ({ harnessDir }) =>
          nodeCommand([
            resolve(harnessDir, "node_modules/tape/bin/tape"),
            "test/*.js",
          ]),
      ],
      sandbox: [
        ({ harnessDir }) =>
          nodeCommand([
            "--import",
            CJS_LOADER,
            resolve(harnessDir, "node_modules/tape/bin/tape"),
            "test/*.js",
          ]),
      ],
    },
  },
  {
    name: "yup",
    runner: "vitest",
    harness: "test-harness/yup",
    proxy: ".sandbox/proxys/yup-proxy.js",
    strategy: "suite",
    modeStrategies: {
      sandbox: {
        strategy: "batch",
        batchSize: 5,
        fallback: "per-file",
      },
    },
    discovery: {
      root: "test",
      suffixes: [".js", ".ts"],
      exclude: [
        "test/helpers.ts",
        "test/types/.eslintrc.js",
        "test/types/types.ts",
      ],
    },
    testFilePattern: "test/**/*.{js,ts}",
    parser: "vitest-json",
    commands: {
      native: [
        vitestCommand("../../compatibility-harness/configs/yup.native.config.mjs"),
      ],
      sandbox: [
        vitestCommand("../../compatibility-harness/configs/yup.sandbox.config.mjs"),
      ],
    },
  },
  {
    name: "zod",
    runner: "vitest",
    harness: "test-harness/zod",
    proxy: ".sandbox/proxys/zod-proxy.js",
    strategy: "per-file",
    discovery: {
      root: "packages/zod/src/v4/classic/tests",
      suffix: ".test.ts",
    },
    testFilePattern: "packages/zod/src/v4/classic/tests/**/*.test.ts",
    parser: "vitest-json",
    commands: {
      native: [zodCommand("./vitest.config.ts")],
      sandbox: [zodCommand("./vitest-sandbox.config.ts")],
    },
  },
];
