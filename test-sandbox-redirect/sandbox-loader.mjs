/**
 * Node.js Custom ESM Loader — Sandbox Import Redirector
 *
 * Intercepts imports of any library configured in .sandbox/sandbox.config.js
 * and redirects them to the corresponding .sandbox/{lib}-proxy.js file.
 *
 * Interception covers four cases:
 *   1. Bare package imports:      import 'image-js'
 *   2. Any import resolving to a file inside node_modules/<lib>/
 *      (e.g. subpath exports, or deep relative imports that Node can resolve)
 *   3. Relative imports referencing /src/ from a test-harness/<lib>/ directory
 *      (e.g. ../src/Mask.js or ../../src/Mask.js — intercepted before resolution)
 *   4. Relative imports from test-harness/<lib>/ that fail to resolve
 *      (e.g. ../../src/Mask.js pointing at library source not present locally)
 *
 * This allows running a library's own test suite against the sandboxed version
 * without modifying any test files.
 *
 * Usage with any test framework:
 *   node --import ./sandbox-loader.mjs --test <test-files>
 *   ava --import ./sandbox-loader.mjs
 *   npx mocha --import ./sandbox-loader.mjs <test-files>
 */

import { createRequire } from "module";
import { resolve as pathResolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const require = createRequire(import.meta.url);

// All paths are resolved relative to the project root derived from this file's
// own location (test-sandbox-redirect/../), making the loader CWD-independent.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

// Load sandbox.config.js to discover which libraries are sandboxed
const configPath = pathResolve(projectRoot, ".sandbox/sandbox.config.js");
let sandboxedLibs = [];

try {
  // Support both CJS default export and ESM default export shapes
  const config = require(configPath);
  const configData = config.default ?? config;
  sandboxedLibs = Object.keys(configData);
  console.log(`[sandbox-loader] Intercepting imports for: ${sandboxedLibs.join(", ")}`);
} catch (err) {
  console.warn(`[sandbox-loader] Could not load sandbox.config.js: ${err.message}`);
}

/**
 * Pre-computed per-library data: proxy URL and package root URL prefix.
 * libRootUrl ends with '/' so startsWith() matches only files inside the package,
 * not a sibling package that shares a name prefix (e.g. image-js-utils).
 */
const libData = new Map();
for (const lib of sandboxedLibs) {
  const proxyUrl = pathToFileURL(pathResolve(projectRoot, `.sandbox/${lib}-proxy.js`)).href;
  const libRootUrl = pathToFileURL(pathResolve(projectRoot, "node_modules", lib)).href + "/";
  const testHarnessLibUrl = pathToFileURL(pathResolve(projectRoot, "test-harness", lib)).href + "/";
  libData.set(lib, { proxyUrl, libRootUrl, testHarnessLibUrl });
}

/**
 * Package aliases — mirrors the resolve.alias in webpack.config.cjs.
 * Maps bare specifiers that have broken/missing exports to their actual paths.
 */
const PACKAGE_ALIASES = {
  "quickjs-emscripten-sync": pathToFileURL(
    pathResolve(
      projectRoot,
      "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js"
    )
  ).href,
};

/**
 * Node ESM resolve hook — fires for every import specifier.
 * Redirects sandboxed library imports to their proxy files.
 */
export async function resolve(specifier, context, nextResolve) {
  // 1. Resolve package aliases (e.g., fix missing .mjs builds)
  if (PACKAGE_ALIASES[specifier]) {
    return { url: PACKAGE_ALIASES[specifier], shortCircuit: true };
  }

  // 2. Intercept relative imports referencing /src/ from a test-harness/<lib>/ directory.
  //    Mirrors the vitest resolve.alias rules for ../src/*.js and ../../src/*.js.
  //    Caught before resolution so it works whether or not the file exists locally.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    /\/src\//.test(specifier) &&
    context.parentURL
  ) {
    const match = context.parentURL.match(/\/test-harness\/([^/]+)\//);
    if (match) {
      const libName = match[1];
      const data = libData.get(libName);
      if (data) {
        console.log(`[sandbox-loader] src/ relative import: ${specifier} in ${libName} test-harness → proxy`);
        return { url: data.proxyUrl, shortCircuit: true };
      }
    }
  }

  try {
    // 3. Let Node resolve the specifier normally
    const result = await nextResolve(specifier, context);

    // 4. Check if the resolved URL falls inside any sandboxed library's package directory.
    //    This catches bare imports ('image-js'), subpath exports ('image-js/filters'),
    //    and any relative import that Node resolves into node_modules/<lib>/.
    for (const [lib, { proxyUrl, libRootUrl }] of libData) {
      if (result.url.startsWith(libRootUrl)) {
        console.log(`[sandbox-loader] ${specifier} → ${lib} proxy`);
        return { url: proxyUrl, shortCircuit: true };
      }
    }

    // 4b. Check if the resolved URL falls inside a test-harness/<lib>/ directory and the
    //     import originates from within the same library's test-harness tree.
    //     Handles libraries (e.g. image-js) that place tests inside src/ — test files
    //     import sibling source files with relative paths that contain no '/src/' segment,
    //     so case 2 cannot catch them. Both parent and resolved URL must be inside the
    //     same test-harness/<lib>/ subtree so that test entry points are never redirected.
    for (const [lib, { proxyUrl, testHarnessLibUrl }] of libData) {
      if (
        result.url.startsWith(testHarnessLibUrl) &&
        !result.url.slice(testHarnessLibUrl.length).includes('node_modules') &&
        context.parentURL?.startsWith(testHarnessLibUrl) &&
        specifier.includes('..')
      ) {
        console.log(`[sandbox-loader] ${specifier} → ${lib} proxy (test-harness source)`);
        return { url: proxyUrl, shortCircuit: true };
      }
    }

    return result;
  } catch (err) {
    // 5. ERR_MODULE_NOT_FOUND for relative imports inside a test-harness/<lib>/ directory.
    //    These point at library source files (e.g. ../../src/Mask.js) that don't exist
    //    locally — redirect them all to the library's proxy regardless of filename.
    if (err.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL) {
      const match = context.parentURL.match(/\/test-harness\/([^/]+)\//);
      if (match) {
        const libName = match[1];
        const data = libData.get(libName);
        if (data && (specifier.startsWith('.') || specifier.startsWith('..'))) {
          console.log(`[sandbox-loader] Missing relative import: ${specifier} in ${libName} test-harness → proxy`);
          return { url: data.proxyUrl, shortCircuit: true };
        }
      }
    }

    throw err;
  }
}
