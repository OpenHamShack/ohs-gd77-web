#!/bin/sh
# Runs every test: the node unit and session tests, then the headless
# browser check against both simulated radios.
#   tools/test.sh               all tests
#   tools/test.sh --no-browser  node tests only
#   SHOTS=dir tools/test.sh     also save screenshots in dir
set -eu
cd "$(dirname "$0")/.."
NODE=${NODE:-node}
echo "== node tests"
"$NODE" --test tests/
if [ "${1:-}" != "--no-browser" ]; then
  echo "== browser test (headless Chromium)"
  sh tools/browser-test.sh ${SHOTS:-}
fi
echo "== all tests passed"
