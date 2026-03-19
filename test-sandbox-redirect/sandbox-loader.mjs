/**
 * Node.js Custom ESM Loader — Sandbox Import Redirector
 *
 * Intercepts imports of any library configured in .sandbox/sandbox.config.js
 * and redirects them to the corresponding .sandbox/{lib}-proxy.js file.
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
import { resolve as pathResolve, basename as pathBasename } from "path";
import { pathToFileURL } from "url";

const require = createRequire(import.meta.url);

// Load sandbox.config.js to discover which libraries are sandboxed
const configPath = pathResolve(".sandbox/sandbox.config.js");
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
 * Package aliases — mirrors the resolve.alias in webpack.config.cjs.
 * Maps bare specifiers that have broken/missing exports to their actual paths.
 */
const PACKAGE_ALIASES = {
  "quickjs-emscripten-sync": pathToFileURL(
    pathResolve(
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

  try {
    // 2. Let Node resolve the specifier normally
    const result = await nextResolve(specifier, context);

    // 3. Check if the resolved URL corresponds to any sandboxed library entry point
    for (const lib of sandboxedLibs) {
      try {
        // Find the real entry point URL for this library
        const entryPath = require.resolve(lib);
        const entryUrl = pathToFileURL(entryPath).href;

        if (result.url === entryUrl) {
          const proxyPath = pathResolve(`.sandbox/${lib}-proxy.js`);
          const proxyUrl = pathToFileURL(proxyPath).href;
          
          if (specifier !== lib) {
              console.log(`[sandbox-loader] Redirecting matching import: ${specifier} (${result.url}) → ${proxyPath}`);
          } else {
              console.log(`[sandbox-loader] ${specifier} → ${proxyPath}`);
          }
          
          return { url: proxyUrl, shortCircuit: true };
        }
      } catch (e) {
        // Could not resolve library entry point, skip
      }
    }

    return result;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL) {
      // 4. Handle relative imports in test-harness that point to non-existent files
      // Pattern: .../test-harness/{libName}/...
      const match = context.parentURL.match(/\/test-harness\/([^/]+)\//);
      if (match) {
        const libName = match[1];
        if (sandboxedLibs.includes(libName)) {
          // If it's a relative import like './index.js' or './lib/index.js'
          if (specifier.startsWith('.') || specifier.startsWith('..')) {
            try {
              const entryPath = require.resolve(libName);
              const entryFilename = pathBasename(entryPath);
              
              // If the specifier targets the same filename as the entry point
              if (specifier === `./${entryFilename}` || specifier.endsWith(`/${entryFilename}`)) {
                const proxyPath = pathResolve(`.sandbox/${libName}-proxy.js`);
                const proxyUrl = pathToFileURL(proxyPath).href;
                console.log(`[sandbox-loader] INTERCEPTED MISSING RELATIVE IMPORT: ${specifier} in ${libName} test-harness → ${proxyPath}`);
                return { url: proxyUrl, shortCircuit: true };
              }
            } catch (e) {
              // Ignore resolve errors
            }
          }
        }
      }
    }
    throw err;
  }
}
