#!/bin/sh
# Publishes the page and the report endpoint to openhamshack.com/gd77/.
#   tools/deploy.sh
# Uses the standing 20i deploy key in ~/.config/ohs-site-deploy (Brian keeps it
# until he says to drop it; a fresh key takes ~30 minutes to be accepted, so
# the old mint-a-key-per-upload route made every small fix a half-hour wait).
# The new copy is unpacked beside the live one and swapped in with two renames,
# so a failed upload never leaves a half-written page. The server config
# (~/gd77-config.php, holding the report key) is never touched here.
#
# css/ and js/ go under r/<commit>/, and index.html is rewritten to point
# there. 20i's CDN caches the gzip variant of static files and ignores
# Cache-Control: on 21/10 it kept serving the pre-Firmware-tab app.js to every
# browser (curl without gzip saw the new one, which hid it). A path that
# changes with every release can't be served stale; index.html itself is not
# cached by the CDN. Old r/ folders are kept (a page loaded just before a
# release still finds its modules) and pruned to the newest five.
set -eu
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "commit first: the stamped version must name a real commit" >&2; exit 1; }
key=$HOME/.config/ohs-site-deploy/id_ed25519
v=$(git rev-parse --short HEAD)
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
# Archive named entries, never ".": a "." entry carries the 0700 of mktemp onto
# the live directory, and 20i keeps serving 403 even after a chmod.
mkdir -p "$stage/r/$v" "$stage/api"
cp -r css js "$stage/r/$v/"
tools/stamp-version.sh "$stage/r/$v"
sed -e "s|href=\"css/app.css\"|href=\"r/$v/css/app.css\"|" -e "s|from './js/app.js'|from './r/$v/js/app.js'|" index.html > "$stage/index.html"
grep -q "r/$v/js/app.js" "$stage/index.html" && grep -q "r/$v/css/app.css" "$stage/index.html" || { echo "index.html asset paths not rewritten" >&2; exit 1; }
cp server/gd77-report.php "$stage/api/report.php"
cp server/htaccess "$stage/.htaccess"
tar -czf "$stage.tgz" -C "$stage" index.html r api .htaccess && trap 'rm -rf "$stage" "$stage.tgz"' EXIT
ssh -i "$key" -o IdentitiesOnly=yes -o ConnectTimeout=20 user@ssh.example-host "
  set -e; cd public_html
  rm -rf gd77.new gd77.old; mkdir gd77.new; tar -xzf - -C gd77.new
  php -l gd77.new/api/report.php >/dev/null
  if [ -d gd77/r ]; then for d in \$(ls -t gd77/r | head -5); do [ -e gd77.new/r/\$d ] || cp -r gd77/r/\$d gd77.new/r/; done; fi
  [ -d gd77 ] && mv gd77 gd77.old; mv gd77.new gd77; rm -rf gd77.old
  echo \"live: $v (\$(ls gd77/r | wc -l) asset versions kept)\"" < "$stage.tgz"
