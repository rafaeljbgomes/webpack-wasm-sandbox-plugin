/**
 * Registers the unit-test runtime alias hook.
 *
 *   node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs --test <files>
 */

import { register } from "node:module";

register("./runtime-alias-hooks.mjs", import.meta.url);
