/**
 * Node ESM resolve hook for unit tests.
 *
 * Applies only the runtime package aliases. Unlike the compatibility loader it
 * never redirects configured libraries, so unit tests stay independent of the
 * example sandbox policy and of generated proxies.
 */

import { RUNTIME_PACKAGE_ALIASES } from "../../../test-sandbox-redirect/runtime-aliases.mjs";

/**
 * Resolves aliased runtime packages and defers everything else.
 *
 * @param {string} specifier Requested module specifier.
 * @param {object} context Node resolution context.
 * @param {Function} nextResolve Next hook in the resolution chain.
 * @returns {Promise<object>} Resolution result.
 */
export async function resolve(specifier, context, nextResolve) {
  const alias = RUNTIME_PACKAGE_ALIASES[specifier];
  if (alias) {
    return { url: alias, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
