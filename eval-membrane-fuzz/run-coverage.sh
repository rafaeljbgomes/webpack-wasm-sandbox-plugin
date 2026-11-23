#!/bin/bash
# Coverage of the three membrane fuzzers, per component: our membranes, our
# marshallers, and quickjs-emscripten-sync's Arena (dist build, which is what
# runs). Part A: decoder; Part B: VM->host data; Part C: the other channels.
set -e
cd "$(dirname "$0")/.."
OUT=eval-membrane-fuzz/coverage/all
rm -rf "$OUT"; mkdir -p "$OUT/tmp"
C8="npx c8 --temp-directory $OUT/tmp --clean=false --reporter=none --include=.sandbox/membrane/** --include=.sandbox/marshallers/** --include=.sandbox/core/** --include=node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js --exclude-after-remap=false --exclude-node-modules=false"
RT="node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs"
$C8 $RT eval-membrane-fuzz/fuzz-decode.mjs > "$OUT/decode.log" 2>&1 || echo "decode exit $?"
$C8 $RT eval-membrane-fuzz/fuzz-boundary.mjs > "$OUT/boundary.log" 2>&1 || echo "boundary exit $?"
$C8 $RT eval-membrane-fuzz/fuzz-channels.mjs ${CHANNELS_N:-5000} > "$OUT/channels.log" 2>&1 || echo "channels exit $?"
npx c8 report --exclude-node-modules=false --temp-directory "$OUT/tmp" --reporter=json-summary --reporter=text --report-dir "$OUT" --include=.sandbox/membrane/** --include=.sandbox/marshallers/** --include=.sandbox/core/** --include=node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js > "$OUT/report.txt"
rm -rf "$OUT/tmp"
echo done
