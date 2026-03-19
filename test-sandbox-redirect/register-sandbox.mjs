/**
 * register-sandbox.mjs
 *
 * Registers the sandbox-loader.mjs ESM hook using Node's modern
 * module.register() API (Node 20.6+).
 *
 * Must be used with --import (not --loader) so that hooks are properly
 * registered on the main thread and propagated to worker threads:
 *
 *   node --import ./register-sandbox.mjs --test <test-files>
 *   node --import ./register-sandbox.mjs <script.js>
 */

import { register } from "node:module";

register("./sandbox-loader.mjs", import.meta.url);
