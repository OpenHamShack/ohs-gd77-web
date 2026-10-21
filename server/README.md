# Diagnostic report endpoint (openhamshack.com)

Users can choose to send a diagnostic report from the page. The page POSTs it
to the relative URL `api/report.php`, which is this script.

## Where the files go

On the 20i host, beside `public_html` (shown here as `~`):

| File | Deployed to | Notes |
|---|---|---|
| the page (`index.html`, `css/`, `js/`) | `~/public_html/gd77/` | stamp `js/version.js` first: `tools/stamp-version.sh <staging-dir>` |
| `server/gd77-report.php` | `~/public_html/gd77/api/report.php` | |
| `server/gd77-config.example.php` | `~/gd77-config.php` | **outside** `public_html`; set `admin_key`; never commit the real one |
| (created by the script) | `~/gd77-reports/` | mode 0700, reports `<id>.json.gz` mode 0600, rate-limit state in `.limits/` |

No `.htaccess` is needed, and none should add an HTTPS redirect: the CDN
reaches the origin over plain HTTP, so a redirect there loops.

## Config file format

`~/gd77-config.php` returns a PHP array. Only `admin_key` has to be set:

```php
<?php
return [
    'admin_key' => '<32+ random characters>',   // X-Report-Key for list/get/delete; under 16 chars disables them
    // optional, defaults shown:
    // 'reports_dir' => '<parent of public_html>/gd77-reports',
    // 'max_bytes' => 3 * 1024 * 1024,
    // 'uploads_per_hour_per_ip' => 10,
    // 'uploads_per_hour_total' => 200,
    // 'max_total_bytes' => 500 * 1024 * 1024,
    // 'retention_days' => 90,
];
```

The same key goes in `~/.config/gd77-reports/key` (mode 0600) on shack, for
`tools/fetch-reports.sh`.

## API

- `POST` with `Content-Type: application/json`, up to 3 MB: stores a report
  and returns `201 {"id":"20261021T120000Z-1a2b3c4d"}`. Answers 400 for
  bad JSON, 415 for the wrong content type, 413 if too large, 422 if not a
  GD-77 report, 429 at the rate limit and 507 when storage is full.
  Each upload also deletes reports older than `retention_days`.
- `GET ?list`, `GET ?get=<id>` (raw `.json.gz`), `POST ?delete=<id>`: need
  `X-Report-Key`; a wrong key gets 403, and after 10 wrong keys an hour, 429.

Errors are always `{"error": "..."}`; PHP's own messages go to the server's
error log only.

## Testing locally

`tools/dev-server.sh <workdir> <port>` lays everything out as above and runs
it under the local `php:8.3-cli` container image; `tests/server.test.mjs`
and the headless browser check use it. Rate limiting counts the
`X-Forwarded-For` address too, because behind the CDN every request comes
from the CDN; which header the 20i CDN really sets is not yet checked.
