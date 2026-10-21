#!/bin/sh
# Writes the current git commit into js/version.js of a staged copy of the
# page, for deploying:   tools/stamp-version.sh <staging-dir>
# "-dirty" is appended when the working tree has uncommitted changes, so a
# report can never claim a commit it did not come from.
set -eu
cd "$(dirname "$0")/.."
dest=${1:?usage: tools/stamp-version.sh <staging-dir>}
v=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || v="$v-dirty"
printf "// Stamped by tools/stamp-version.sh.\nexport const VERSION = '%s';\n" "$v" > "$dest/js/version.js"
echo "$dest/js/version.js: $v"
