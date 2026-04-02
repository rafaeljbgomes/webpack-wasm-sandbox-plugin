/**
 * register-sandbox-cjs.mjs
 *
 * Loaded via --import. Pre-loads all async ESM sandbox proxies and injects
 * them into Node's CJS require.cache, then patches Module._resolveFilename
 * to redirect sandboxed library requires to the pre-loaded cache entries.
 *
 * This bridges the CJS ↔ async-ESM gap: CJS test files can require() sandboxed
 * libraries even though the proxies use top-level await.
 *
 * Interception mirrors sandbox-loader.mjs — four cases:
 *   1. Bare specifiers:                    require('tweetnacl')
 *   2. Resolves into node_modules/<lib>/   require('./index') → node_modules/tweetnacl/...
 *   3. Relative import from test-harness/<lib>/ resolving back into test-harness/<lib>/
 *      (sibling source files, e.g. nacl.min.js next to the test directory)
 *   4. MODULE_NOT_FOUND relative imports from test-harness/<lib>/
 *      (source files not present locally)
 *
 * Usage:
 *   node --import ./test-sandbox-redirect/register-sandbox-cjs.mjs --test <test-files>
 */

import { createRequire, register } from 'module';
import { resolve as pathResolve, sep, basename as pathBasename, extname as pathExtname } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readdirSync, readFileSync } from 'fs';

// Register the ESM loader hook so that its PACKAGE_ALIASES fix for
// quickjs-emscripten-sync is active before we start importing the proxies.
register('./sandbox-loader.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const Module = require('module');

// Load config (CJS variant so require() works without ESM interop)
const configPath = pathResolve('.sandbox/sandbox.config.cjs');
const config = require(configPath);
const sandboxedLibs = Object.keys(config);

console.log(`[sandbox-cjs] Pre-loading proxies for: ${sandboxedLibs.join(', ')}`);

// Helper: check whether filePath is directly inside dir (not a sibling with matching prefix)
function isInDir(filePath, dir) {
  return filePath.startsWith(dir + sep) || filePath.startsWith(dir + '/');
}

// Build a map from npm package name → actual test-harness directory path.
// The directory name often differs from the package name (e.g. tweetnacl-js vs tweetnacl),
// so we scan test-harness/ subdirectories and match via each one's package.json "name".
const testHarnessRoot = pathResolve('test-harness');
const libToTestHarnessDir = new Map();
try {
  for (const entry of readdirSync(testHarnessRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = pathResolve(testHarnessRoot, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const { name } = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (name) libToTestHarnessDir.set(name, pathResolve(testHarnessRoot, entry.name));
    } catch { /* malformed package.json — skip */ }
  }
} catch { /* test-harness directory absent — skip */ }

// Build per-library data
const libData = new Map();
for (const lib of sandboxedLibs) {
  const proxyPath = pathResolve(`.sandbox/${lib}-proxy.js`);
  libData.set(lib, {
    proxyPath,
    proxyUrl: pathToFileURL(proxyPath).href,
    // Prefer the directory discovered via package.json; fall back to test-harness/<lib>
    testHarnessLibPath: libToTestHarnessDir.get(lib) ?? pathResolve('test-harness', lib),
    nodeModulesLibPath: pathResolve('node_modules', lib),
  });
}

// Pre-load all proxies with top-level await — Node blocks here until every sandbox
// is initialised, so by the time any require() fires the cache entries are ready.
for (const [lib, data] of libData) {
  try {
    const ns = await import(data.proxyUrl);
    // Use the default export as CJS exports: it is the raw sandbox library object
    // (e.g. the full nacl namespace), matching what the original library exports.
    const cjsExports = ns.default ?? ns;

    require.cache[data.proxyPath] = {
      id: data.proxyPath,
      filename: data.proxyPath,
      loaded: true,
      exports: cjsExports,
      parent: null,
      children: [],
      paths: [],
    };
    // Store the namespace and create per-named-export virtual cache entries so
    // that modular requires like require('../bi-map.js') can be routed to the
    // correct named export instead of the entire namespace (ns.default ?? ns).
    data.ns = ns;
    for (const key of Object.keys(ns)) {
      if (key === 'default') continue;
      const virtualPath = `${data.proxyPath}\x00${key}`;
      require.cache[virtualPath] = {
        id: virtualPath,
        filename: virtualPath,
        loaded: true,
        exports: ns[key],
        parent: null,
        children: [],
        paths: [],
      };
    }
    console.log(`[sandbox-cjs] Ready: ${lib}`);
  } catch (err) {
    console.warn(`[sandbox-cjs] Failed to load proxy for ${lib}: ${err.message}`);
  }
}

// Convert a kebab-case file stem to PascalCase to match proxy named exports.
// e.g. "bi-map" → "BiMap", "circular-buffer" → "CircularBuffer"
function stemToExportName(stem) {
  return stem.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
             .replace(/^([a-z])/, c => c.toUpperCase());
}

// Patch Module._resolveFilename to redirect sandboxed library requires to the
// pre-populated cache entries.
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  // Case 1: bare specifier matching a sandboxed library name
  if (libData.has(request)) {
    return libData.get(request).proxyPath;
  }

  try {
    const resolved = original.call(this, request, parent, isMain, options);

    // Case 2: resolved path falls inside node_modules/<lib>/
    for (const [, data] of libData) {
      if (isInDir(resolved, data.nodeModulesLibPath)) {
        return data.proxyPath;
      }
    }

    // Case 3: relative import from test-harness/<lib>/ that resolves to a file
    // inside the same test-harness/<lib>/ tree (e.g. ../nacl.min.js, ../src/foo.js).
    // Excludes requires that originate from or resolve into a node_modules subtree
    // inside the test-harness directory — those belong to tape/mocha/etc., not the lib.
    if (parent?.filename && request.startsWith('../')) {
      for (const [, data] of libData) {
        const libNodeModules = pathResolve(data.testHarnessLibPath, 'node_modules');
        if (
          isInDir(parent.filename, data.testHarnessLibPath) &&
          !isInDir(parent.filename, libNodeModules) &&
          isInDir(resolved, data.testHarnessLibPath) &&
          !isInDir(resolved, libNodeModules)
        ) {
          const stem = pathBasename(resolved, pathExtname(resolved));
          const exportName = stemToExportName(stem);
          if (data.ns && exportName in data.ns) {
            return `${data.proxyPath}\x00${exportName}`;
          }
          return data.proxyPath;
        }
      }
    }

    return resolved;
  } catch (err) {
    // Case 4: MODULE_NOT_FOUND for relative imports whose parent lives inside
    // test-harness/<lib>/ — the source file doesn't exist locally, redirect to proxy.
    // Excludes parents inside node_modules (test runner deps like tape/mocha).
    if (err.code === 'MODULE_NOT_FOUND' && parent?.filename &&
        (request.startsWith('./') || request.startsWith('../'))) {
      for (const [, data] of libData) {
        const libNodeModules = pathResolve(data.testHarnessLibPath, 'node_modules');
        if (
          isInDir(parent.filename, data.testHarnessLibPath) &&
          !isInDir(parent.filename, libNodeModules)
        ) {
          const stem = pathBasename(request, pathExtname(request));
          const exportName = stemToExportName(stem);
          if (data.ns && exportName in data.ns) {
            return `${data.proxyPath}\x00${exportName}`;
          }
          return data.proxyPath;
        }
      }
    }
    throw err;
  }
};
