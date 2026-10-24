/**
 * Package aliases required to load the sandbox runtime under Node.js.
 *
 * Mirrors the resolve.alias used by the Webpack configurations. Shared by the
 * compatibility loader and the unit-test hook so the mapping has one source.
 */

import { resolve as pathResolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Maps bare specifiers whose published exports point at missing files to the
 * build that actually ships in the package.
 */
export const RUNTIME_PACKAGE_ALIASES = Object.freeze({
  // The package's "import" export names a .mjs build that is not published.
  "quickjs-emscripten-sync": pathToFileURL(
    pathResolve(
      projectRoot,
      "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js"
    )
  ).href,
});
