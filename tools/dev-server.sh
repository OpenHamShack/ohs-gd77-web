#!/bin/sh
# Serves the page and the report endpoint exactly as they will be laid out
# on openhamshack.com, for tests and local trials:
#
#   <workdir>/public_html/gd77/            the page (copied, not linked)
#   <workdir>/public_html/gd77/api/report.php
#   <workdir>/gd77-config.php              admin key = $GD77_TEST_KEY
#   <workdir>/gd77-reports/                created by the endpoint
#
#   tools/dev-server.sh <workdir> <port>      (runs in the foreground)
#
# PHP comes from the local php:8.3-cli container image (podman); no PHP is
# installed on the host. Without it, tools/report-stub.py stands in so the
# page can still be exercised, and the script says so on stderr. Stop it
# with SIGTERM; the container is stopped too.
set -eu
cd "$(dirname "$0")/.."
WORK=${1:?usage: tools/dev-server.sh <workdir> <port>}
PORT=${2:?usage: tools/dev-server.sh <workdir> <port>}
KEY=${GD77_TEST_KEY:-test-key-0123456789abcdef}
IMAGE=${GD77_PHP_IMAGE:-docker.io/library/php:8.3-cli}

mkdir -p "$WORK/public_html/gd77/api"
cp -r index.html css js "$WORK/public_html/gd77/"
mkdir -p "$WORK/public_html/gd77/tests" && cp -r tests/browser "$WORK/public_html/gd77/tests/"
cp server/gd77-report.php "$WORK/public_html/gd77/api/report.php"
printf "<?php return ['admin_key' => '%s'];\n" "$KEY" > "$WORK/gd77-config.php"

if command -v podman >/dev/null 2>&1 && podman image exists "$IMAGE" 2>/dev/null; then
  NAME="gd77-php-$$"
  podman run -d --rm --init --name "$NAME" -p "127.0.0.1:$PORT:8000" -v "$WORK:/srv" \
    --entrypoint php "$IMAGE" -S 0.0.0.0:8000 -t /srv/public_html >/dev/null
  trap 'podman stop -t 1 "$NAME" >/dev/null 2>&1 || true; exit 0' INT TERM EXIT
  echo "dev-server: php (container $NAME) on 127.0.0.1:$PORT" >&2
  # In the background, because sh only runs the trap once a foreground
  # command returns, and podman wait would never return.
  podman wait "$NAME" >/dev/null 2>&1 &
  wait $! || true
else
  echo "dev-server: no PHP container image; using tools/report-stub.py instead" >&2
  exec python3 tools/report-stub.py "$WORK" "$PORT"
fi
