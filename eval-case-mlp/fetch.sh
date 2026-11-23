#!/bin/bash
# Fetches Markdown Live Preview at the two commits of the case study and
# installs their dependencies with install scripts disabled.
#   app      051369f (2026-11-13): measured; trusted-051369f.cjs
#   app-old  23d28c9 (2026-09-13): trusted list before the version bump
# Then: npm install (here), and
#   APP=$PWD/app node build.cjs native sandbox && APP=$PWD/app node measure.mjs
#   APP=$PWD/app-old TRUSTED=$PWD/trusted-empty.cjs node build.cjs sandbox   # flags 26
#   APP=$PWD/app TRUSTED=$PWD/trusted-23d28c9.cjs node build.cjs sandbox     # flags 2
set -e
cd "$(dirname "$0")"
git clone -q https://github.com/tanabe/markdown-live-preview.git app
git -C app checkout -q 051369fda6bd4fe6dd16f4b6f050ed5be24c1331
git -C app worktree add -q ../app-old 23d28c9
(cd app && npm ci --ignore-scripts --no-audit --no-fund)
(cd app-old && npm ci --ignore-scripts --no-audit --no-fund)
