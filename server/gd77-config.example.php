<?php
// Copy to <parent of public_html>/gd77-config.php (NOT inside public_html,
// never into the repository) and set admin_key. Every key is optional;
// these are the defaults except admin_key, which has none: without it the
// admin calls (list/get/delete) answer 503.
return [
    // Shared secret for the X-Report-Key header; at least 16 characters.
    // Generate with: head -c 32 /dev/urandom | base64
    'admin_key' => 'CHANGE-ME',
    // Where reports are stored (outside public_html). Default:
    // <parent of public_html>/gd77-reports
    // 'reports_dir' => '/home/sites/.../gd77-reports',
    'max_bytes' => 3 * 1024 * 1024,
    'uploads_per_hour_per_ip' => 10,
    'uploads_per_hour_total' => 200,
    'max_total_bytes' => 500 * 1024 * 1024,
    'retention_days' => 90,
];
