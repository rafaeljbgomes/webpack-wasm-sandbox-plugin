#!/bin/sh
# Final compatibility campaign for the seven libraries re-run in the revision,
# each followed by a negative control in which the library's sandbox cannot be
# created (SANDBOX_POISON_LIBRARY): tests that still pass there do not depend
# on the sandbox. Luxon runs in the time zone and locale its upstream CI uses.
set -u
cd "$(dirname "$0")/.."
OUT=compatibility-results-final
for lib in ${LIBS:-strip-ansi mime tweetnacl lodash luxon zod image-js date-fns marked yup}; do
  env_prefix=""
  [ "$lib" = luxon ] && env_prefix="TZ=America/New_York LANG=en_US.utf8"
  echo "== $lib"
  env $env_prefix node compatibility-harness/run-compat.mjs --library "$lib" --out-dir "$OUT" > /dev/null 2>&1
  echo "== $lib (poisoned sandbox)"
  env $env_prefix SANDBOX_POISON_LIBRARY="$lib" node compatibility-harness/run-compat.mjs --library "$lib" --mode sandbox --out-dir "$OUT-poison" > /dev/null 2>&1
done
echo done
