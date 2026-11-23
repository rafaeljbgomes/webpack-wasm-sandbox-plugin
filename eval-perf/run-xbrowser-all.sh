#!/bin/bash
# Runs the cross-browser campaign sequentially (one browser at a time).
cd "$(dirname "$0")/.."
for spec in "chrome steady" "firefox cold" "webkit cold" "firefox steady" "webkit steady"; do
  set -- $spec
  echo "=== $1 $2"
  node eval-perf/run-xbrowser.mjs "$1" "$2"
done
# ImageJS did not load in Firefox and WebKit before the constructor-message
# fix (sb-utils.js); its cold runs are repeated with the rebuilt pages.
for b in firefox webkit; do
  echo "=== $b cold rerun"
  RESULTS_SUFFIX=-rerun node eval-perf/run-xbrowser.mjs "$b" cold image-js image-js-adapter
done
echo finished
