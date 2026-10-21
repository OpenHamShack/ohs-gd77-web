#!/bin/bash
# Fetches new GD-77 web CPS diagnostic reports from openhamshack.com to
# ~/build/gd77-reports/<id>.json.gz and notifies Brian's phone once per new
# report. Run hourly by tools/systemd/gd77-reports.timer, or by hand.
#
#   key:      ~/.config/gd77-reports/key   (mode 0600; the admin_key from
#             gd77-config.php on the server)
#   env:      GD77_REPORTS_URL  (default https://openhamshack.com/gd77/api/report.php)
#             GD77_NOTIFY       (default ~/.config/claude-account/notify)
#
# A report already listed in ~/build/gd77-reports/.seen is never fetched or
# announced again, even if its file has been deleted locally.
set -euo pipefail

URL=${GD77_REPORTS_URL:-https://openhamshack.com/gd77/api/report.php}
NOTIFY=${GD77_NOTIFY:-$HOME/.config/claude-account/notify}
KEYFILE=$HOME/.config/gd77-reports/key
OUT=$HOME/build/gd77-reports
SEEN=$OUT/.seen

[ -r "$KEYFILE" ] || { echo "fetch-reports: no key at $KEYFILE" >&2; exit 1; }
if [ "$(stat -c %a "$KEYFILE")" != 600 ]; then echo "fetch-reports: $KEYFILE must be mode 0600" >&2; exit 1; fi
KEY=$(tr -d '\r\n' < "$KEYFILE")
mkdir -p "$OUT"; chmod 700 "$OUT"; touch "$SEEN"

# The key goes in a header file, not on the command line, so it never
# shows in the process list.
HDR=$(mktemp); trap 'rm -f "$HDR"' EXIT
chmod 600 "$HDR"; printf 'X-Report-Key: %s\n' "$KEY" > "$HDR"

ids=$(curl -fsS --max-time 60 -H @"$HDR" "$URL?list" | python3 -c 'import json,sys; [print(r["id"]) for r in json.load(sys.stdin)["reports"]]')

new=0
for id in $ids; do
  [[ $id =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || continue
  grep -qxF "$id" "$SEEN" && continue
  tmp="$OUT/.$id.tmp"
  curl -fsS --max-time 120 -H @"$HDR" -o "$tmp" "$URL?get=$id"
  chmod 600 "$tmp"; mv "$tmp" "$OUT/$id.json.gz"
  echo "$id" >> "$SEEN"
  line=$(gzip -dc "$OUT/$id.json.gz" | python3 -c '
import json, sys
r = json.load(sys.stdin)
i = (r.get("radio") or {}).get("identified") or {}
e = r.get("error")
parts = [i.get("model") or "no radio", i.get("firmware") or "", ("ERROR: " + (e.get("message") or ""))[:120] if e else "ok"]
print(" ".join(p for p in parts if p) + (" (simulated)" if r.get("simulated") else ""))
' 2>/dev/null || echo "unreadable report")
  "$NOTIFY" "GD-77 report $id: $line" || echo "fetch-reports: notify failed for $id" >&2
  new=$((new + 1))
done
echo "fetch-reports: $new new report(s)"
