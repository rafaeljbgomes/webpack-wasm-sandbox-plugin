#!/bin/sh
# Reconstructs the upstream test suites for strip-ansi, MIME, TweetNaCl,
# Lodash, Luxon, Zod, and ImageJS under test-harness/<library>/, at the release
# installed in the repository. The committed harness files (configs, shims)
# stay in place; this script adds the upstream tests and their runners.
#
# Where tests import the library's source tree, the committed shims point
# those imports at the installed release, so native and sandbox modes test the
# same code. Run from the repository root; needs git and npm.
set -eu
ROOT=$(pwd)
TMP=$(mktemp -d)
clone() { git clone -q "$1" "$TMP/$2" && git -C "$TMP/$2" checkout -q "$3"; }

# strip-ansi 7.2.0 (ava): test.js becomes test-original.js.
clone https://github.com/chalk/strip-ansi strip-ansi v7.2.0
cp "$TMP/strip-ansi/test.js" test-harness/strip-ansi/test-original.js

# MIME 4.1.0 (node:test): tests and the CLI wrapper; dist/src/* are shims.
clone https://github.com/broofa/mime mime v4.1.0
cp -r "$TMP/mime/test" test-harness/mime/ && rm -f test-harness/mime/test/exports_test.sh
cp "$TMP/mime/bin/cli.js" test-harness/mime/bin/
cp node_modules/mime/dist/src/mime_cli.js test-harness/mime/dist/src/
(cd test-harness/mime && npm install --no-audit --no-fund --ignore-scripts chalk@5.6.2 mime-types@3.0.1 mime-score@2.0.4)

# TweetNaCl 1.0.3 (tape): commit 5bf1ff5 is the 1.0.3 release (no tag).
clone https://github.com/dchest/tweetnacl-js tweetnacl-js 5bf1ff5
mkdir -p test-harness/tweetnacl-js/test
cp "$TMP/tweetnacl-js"/test/*.js test-harness/tweetnacl-js/test/
cp -r "$TMP/tweetnacl-js/test/data" test-harness/tweetnacl-js/test/
cp "$TMP/tweetnacl-js/package.json" "$TMP/tweetnacl-js/package-lock.json" test-harness/tweetnacl-js/
(cd test-harness/tweetnacl-js && npm install --no-audit --no-fund --ignore-scripts)

# Lodash 4.18.1 (QUnit): lodash.js and fp helpers are identical to the
# installed package. qunit-extras is patched so that printing a value that
# cannot be converted to a string does not crash the reporter mid-suite.
clone https://github.com/lodash/lodash lodash 4.18.1
mkdir -p test-harness/lodash/test test-harness/lodash/fp
cp "$TMP/lodash/test/test.js" "$TMP/lodash/test/test-fp.js" test-harness/lodash/test/
cp node_modules/lodash/lodash.js test-harness/lodash/
cp node_modules/lodash/fp/_baseConvert.js node_modules/lodash/fp/_mapping.js node_modules/lodash/fp/placeholder.js test-harness/lodash/fp/
(cd test-harness/lodash && npm install --no-audit --no-fund --ignore-scripts lodash@4.17.20 qunit-extras@3 qunitjs@2)
node -e '
const fs = require("fs"); const p = "test-harness/lodash/node_modules/qunit-extras/qunit-extras.js";
let s = fs.readFileSync(p, "utf8");
s = s.replace("    return (value + \x27\x27);\n  }", "    try {\n      return (value + \x27\x27);\n    } catch (e) {\n      return Object.prototype.toString.call(value);\n    }\n  }");
fs.writeFileSync(p, s);'

# Luxon 3.7.2 (Jest): src/ is identical to the installed package's src/.
clone https://github.com/moment/luxon luxon 3.7.2
cp -r "$TMP/luxon/src" "$TMP/luxon/test" "$TMP/luxon/package.json" "$TMP/luxon/package-lock.json" "$TMP/luxon/babel.config.js" test-harness/luxon/
(cd test-harness/luxon && npm ci --no-audit --no-fund --ignore-scripts)

# Zod 4.3.6 (Vitest): the v4 classic tests; ../index.js is a shim.
clone https://github.com/colinhacks/zod zod v4.3.6
mkdir -p test-harness/zod/packages/zod/src/v4/classic test-harness/zod/scripts
cp -r "$TMP/zod/packages/zod/src/v4/classic/tests" test-harness/zod/packages/zod/src/v4/classic/
cp "$TMP/zod/scripts/fail-on-console.ts" test-harness/zod/scripts/
(cd test-harness/zod && npm install --no-audit --no-fund --ignore-scripts vitest@4 recheck@4 @web-std/file@3 @seriousme/openapi-schema-validator@2.5.0)

# ImageJS 1.5.0 (Vitest): the whole repository; public-api-tests.json lists
# the test files that use only the public API (select-public-api-tests.mjs).
clone https://github.com/image-js/image-js image-js v1.5.0
(cd "$TMP/image-js" && tar cf - --exclude=.git .) | (cd test-harness/image-js && tar xf -)
git checkout -- test-harness/image-js/vitest.native.config.ts test-harness/image-js/vitest.sandbox.config.ts
(cd test-harness/image-js && npm ci --no-audit --no-fund --ignore-scripts)

rm -rf "$TMP"
echo "Upstream suites in place. Run: compatibility-harness/run-final-campaign.sh"
