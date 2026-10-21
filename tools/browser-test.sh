#!/bin/sh
# Loads the page in headless Chromium against each simulated radio, lets the
# in-page self-test (tests/browser/selftest.js) connect, read, edit and
# write through the real UI, and checks its verdict. Also saves a
# screenshot of the finished page per firmware for a human to look at.
#
#   tools/browser-test.sh [screenshot-dir]
#
# Uses its own port and a private Chromium profile; everything it creates
# goes in a temporary directory that is removed on exit.
set -eu
cd "$(dirname "$0")/.."
CHROMIUM=${CHROMIUM:-/usr/bin/chromium}
SHOTS=${1:-}
PORT=${GD77_TEST_PORT:-$(( 18000 + $$ % 2000 ))}
WORK=$(mktemp -d "${HOME}/build/gd77-browser-XXXXXX" 2>/dev/null || mktemp -d)
cleanup() { if [ -n "${SERVER:-}" ]; then kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; fi; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# The page and its report endpoint, laid out as on openhamshack.com (PHP in a
# container, or a stand-in when there is no PHP image).
sh tools/dev-server.sh "$WORK/site" "$PORT" 2>"$WORK/http.log" &
SERVER=$!
i=0; until python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PORT/gd77/index.html')" 2>/dev/null; do
  i=$((i+1)); [ $i -gt 100 ] && { echo "http server did not start"; cat "$WORK/http.log"; exit 1; }; sleep 0.1
done

chrome() {
  "$CHROMIUM" --headless=new --no-sandbox --disable-gpu --no-first-run --disable-extensions \
    --user-data-dir="$WORK/profile" --window-size=1440,1000 --virtual-time-budget=30000 \
    --enable-logging=stderr --v=0 "$@" 2>>"$WORK/chrome.log"
}

fail=0
for sim in stock opengd77 uv380 uv380dfu; do
  url="http://127.0.0.1:$PORT/gd77/index.html?sim=$sim&selftest"
  chrome --dump-dom "$url" >"$WORK/dom-$sim.html" || true
  result=$(sed -n 's:.*<pre id="selftest-result" hidden="">\(.*\)</pre>.*:\1:p' "$WORK/dom-$sim.html")
  if printf '%s' "$result" | grep -q '"ok":true'; then
    echo "PASS browser $sim: $result"
  else
    echo "FAIL browser $sim: ${result:-no result in page}"
    fail=1
  fi
  if grep -E 'CONSOLE.*(Uncaught|Error)' "$WORK/chrome.log" >/dev/null 2>&1; then
    echo "FAIL browser $sim: console errors:"; grep -E 'CONSOLE.*(Uncaught|Error)' "$WORK/chrome.log" | head -5
    fail=1
  fi
  : >"$WORK/chrome.log"
  # The report the page sent must be on the server, marked simulated.
  ref=$(printf '%s' "$result" | sed -n 's/.*report sent: \([0-9TZa-f-]*\).*/\1/p')
  if [ -n "$ref" ] && gzip -dc "$WORK/site/gd77-reports/$ref.json.gz" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["simulated"] and (r["codeplug"]["read"] or r["firmware"]), r.keys()'; then
    echo "PASS browser $sim: report $ref stored on the server"
  else
    echo "FAIL browser $sim: report ${ref:-?} not stored"; fail=1
  fi
  if [ -n "$SHOTS" ]; then
    mkdir -p "$SHOTS"
    chrome --screenshot="$SHOTS/gd77-$sim.png" "$url" >/dev/null || true
    chrome --screenshot="$SHOTS/gd77-$sim-dark.png" --force-dark-mode --blink-settings=preferredColorScheme=0 "$url" >/dev/null || true
    echo "screenshots: $SHOTS/gd77-$sim.png $SHOTS/gd77-$sim-dark.png"
  fi
done
exit $fail
