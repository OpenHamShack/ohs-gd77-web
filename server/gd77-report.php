<?php
// Diagnostic reports from the GD-77 web CPS.
// Deployed as public_html/gd77/api/report.php on openhamshack.com (20i,
// Apache + PHP 8). Plain PHP, no framework, no composer.
//
//   POST (application/json, <= 3 MB)   store a report      -> 201 {"id": "..."}
//   GET  ?list                          list reports        -> {"reports": [...]}
//   GET  ?get=<id>                      one report, gzipped (application/gzip)
//   POST ?delete=<id>                   delete one report   -> {"deleted": "<id>"}
// The last three need the header X-Report-Key, compared in constant time
// with the admin_key from the config file.
//
// Config: <parent of public_html>/gd77-config.php, outside the web root and
// outside the repository, returning an array; see server/README.md. Reports
// are stored gzipped, mode 0600, in a directory outside public_html (default
// <parent of public_html>/gd77-reports, mode 0700), and anything older than
// the retention period is deleted on each upload.
//
// No .htaccess and no HTTPS redirect: the CDN reaches this origin over
// plain HTTP, and a redirect there loops.

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
set_error_handler(function (int $no, string $msg, string $file, int $line): bool {
    throw new ErrorException($msg, 0, $no, $file, $line);
});

const REPORT_FORMAT = 'gd77-web-diagnostic-report';
const ID_PATTERN = '/^\d{8}T\d{6}Z-[0-9a-f]{8}$/';

function respond(int $status, array $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function config(): array {
    // public_html/gd77/api/report.php -> the directory holding public_html
    $base = dirname(__DIR__, 3);
    $file = $base . '/gd77-config.php';
    $cfg = is_file($file) ? require $file : [];
    if (!is_array($cfg)) $cfg = [];
    return $cfg + [
        'admin_key' => '',
        'reports_dir' => $base . '/gd77-reports',
        'max_bytes' => 3 * 1024 * 1024,
        'uploads_per_hour_per_ip' => 10,
        'uploads_per_hour_total' => 200,
        'max_total_bytes' => 500 * 1024 * 1024,
        'retention_days' => 90,
    ];
}

function reports_dir(array $cfg): string {
    $dir = rtrim((string)$cfg['reports_dir'], '/');
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    @chmod($dir, 0700);
    if (!is_dir($dir . '/.limits')) mkdir($dir . '/.limits', 0700);
    return $dir;
}

// The client address. Behind the CDN REMOTE_ADDR is the CDN's, so the
// forwarded address is used as well; it can be forged, which is why there
// is also a site-wide hourly cap and a disk cap.
function client_key(): string {
    $parts = [$_SERVER['REMOTE_ADDR'] ?? ''];
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR'] as $h) {
        if (!empty($_SERVER[$h])) { $parts[] = trim(explode(',', (string)$_SERVER[$h])[0]); break; }
    }
    return hash('sha256', implode('|', $parts));
}

// Sliding one-hour window in a small JSON file per key, under flock.
// Returns false when the limit is reached; records the attempt otherwise.
function rate_ok(string $dir, string $key, int $limit): bool {
    $fh = fopen("$dir/.limits/$key.json", 'c+');
    if (!$fh) return false;
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $times = json_decode($raw ?: '[]', true);
        if (!is_array($times)) $times = [];
        $now = time();
        $times = array_values(array_filter($times, fn($t) => is_int($t) && $t > $now - 3600));
        if (count($times) >= $limit) return false;
        $times[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($times));
        return true;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function purge(string $dir, int $days): void {
    $cutoff = time() - $days * 86400;
    foreach (glob("$dir/*.json.gz") ?: [] as $f) {
        if (filemtime($f) < $cutoff) @unlink($f);
    }
    foreach (glob("$dir/.limits/*.json") ?: [] as $f) {
        if (filemtime($f) < time() - 7200) @unlink($f);
    }
}

function require_key(array $cfg, string $dir): void {
    $want = (string)$cfg['admin_key'];
    $got = (string)($_SERVER['HTTP_X_REPORT_KEY'] ?? '');
    if (strlen($want) < 16) respond(503, ['error' => 'admin access is not configured']);
    // Wrong keys count against the same hourly limit, so guessing is slow.
    if (!hash_equals($want, $got)) {
        if (!rate_ok($dir, 'badkey-' . client_key(), (int)$cfg['uploads_per_hour_per_ip'])) respond(429, ['error' => 'too many attempts']);
        respond(403, ['error' => 'forbidden']);
    }
}

function report_path(string $dir, string $id): string {
    if (!preg_match(ID_PATTERN, $id)) respond(400, ['error' => 'bad id']);
    return "$dir/$id.json.gz";
}

function upload(array $cfg, string $dir): never {
    $type = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    if (!str_starts_with($type, 'application/json')) respond(415, ['error' => 'expected application/json']);
    $max = (int)$cfg['max_bytes'];
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $max) respond(413, ['error' => 'report too large']);
    $body = file_get_contents('php://input', false, null, 0, $max + 1);
    if ($body === false || strlen($body) > $max) respond(413, ['error' => 'report too large']);

    try { $r = json_decode($body, true, 64, JSON_THROW_ON_ERROR); }
    catch (JsonException) { respond(400, ['error' => 'not JSON']); }
    if (!is_array($r) || ($r['format'] ?? null) !== REPORT_FORMAT || !is_int($r['formatVersion'] ?? null)
        || !is_string($r['createdAt'] ?? null) || !is_array($r['page'] ?? null)
        || !is_array($r['environment'] ?? null) || !is_array($r['session'] ?? null)) {
        respond(422, ['error' => 'not a GD-77 diagnostic report']);
    }

    if (!rate_ok($dir, 'ip-' . client_key(), (int)$cfg['uploads_per_hour_per_ip'])) respond(429, ['error' => 'too many reports from this address; try again in an hour']);
    if (!rate_ok($dir, 'all', (int)$cfg['uploads_per_hour_total'])) respond(429, ['error' => 'too many reports right now; try again later']);

    purge($dir, (int)$cfg['retention_days']);
    $used = 0;
    foreach (glob("$dir/*.json.gz") ?: [] as $f) $used += filesize($f);
    if ($used > (int)$cfg['max_total_bytes']) respond(507, ['error' => 'report storage is full']);

    $id = gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(4));
    $gz = gzencode($body, 9);
    $tmp = "$dir/.$id.tmp";
    $old = umask(0077);
    try {
        file_put_contents($tmp, $gz, LOCK_EX);
        chmod($tmp, 0600);
        rename($tmp, "$dir/$id.json.gz");
    } finally {
        umask($old);
    }
    respond(201, ['id' => $id]);
}

try {
    $cfg = config();
    $dir = reports_dir($cfg);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET' && isset($_GET['list'])) {
        require_key($cfg, $dir);
        $out = [];
        foreach (glob("$dir/*.json.gz") ?: [] as $f) {
            $out[] = ['id' => basename($f, '.json.gz'), 'bytes' => filesize($f), 'stored' => gmdate('c', filemtime($f))];
        }
        usort($out, fn($a, $b) => strcmp($a['id'], $b['id']));
        respond(200, ['reports' => $out]);
    }
    if ($method === 'GET' && isset($_GET['get'])) {
        require_key($cfg, $dir);
        $path = report_path($dir, (string)$_GET['get']);
        if (!is_file($path)) respond(404, ['error' => 'no such report']);
        header('Content-Type: application/gzip');
        header('Cache-Control: no-store');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }
    if ($method === 'POST' && isset($_GET['delete'])) {
        require_key($cfg, $dir);
        $path = report_path($dir, (string)$_GET['delete']);
        if (!is_file($path)) respond(404, ['error' => 'no such report']);
        unlink($path);
        respond(200, ['deleted' => (string)$_GET['delete']]);
    }
    if ($method === 'POST' && empty($_GET)) upload($cfg, $dir);
    respond(405, ['error' => 'method not allowed']);
} catch (Throwable $e) {
    // Details go to the server log, never to the client.
    error_log('gd77 report: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    respond(500, ['error' => 'server error']);
}
