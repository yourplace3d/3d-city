<?php
/**
 * Your Place: the optional print counter.
 *
 * When someone presses "Yes, I'm printing it" after "Order a print online", the app sends one
 * request here with the print size and the number of tiles. This script adds 1 to a total for
 * that size. It stores nothing else: no IP address, no place, no time, no cookie. Nothing reaches
 * it unless the visitor presses the button.
 *
 * The totals are in counts/print-counts.json, which the web can't read (counts/.htaccess).
 * Read them in the hosting file manager. Setup: see README.md next to this file.
 */

// browsers send it with sendBeacon (no reply is read), but allow the app's origins for plain fetches too
$origins = ['https://yourplace3d.github.io', 'https://yourplace3d.com'];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $origins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    header('Access-Control-Allow-Methods: POST');
    header('Access-Control-Allow-Headers: Content-Type');
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit;
}

// {"size":15,"tiles":1}: a size of 10, 15 or 20 cm, and 1 to 8 tiles per side
$data = json_decode((string) file_get_contents('php://input', false, null, 0, 200), true);
$size = is_array($data) && is_int($data['size'] ?? null) ? $data['size'] : 0;
$tiles = is_array($data) && is_int($data['tiles'] ?? null) ? $data['tiles'] : 0;
if (!in_array($size, [10, 15, 20], true) || $tiles < 1 || $tiles > 8) {
    http_response_code(400);
    exit;
}
$key = $tiles > 1 ? "{$size} cm, {$tiles} × {$tiles} tiles" : "{$size} cm";

// a cap on all counts together, so a script can't flood the totals (nothing about the sender is kept)
const PER_MINUTE = 30;

$dir = __DIR__ . '/counts';
if (!is_dir($dir)) {
    mkdir($dir, 0700, true);
}
// keep the totals private even if the folder was uploaded without its .htaccess
if (!file_exists($dir . '/.htaccess')) {
    file_put_contents($dir . '/.htaccess', "Require all denied\n");
}
$fh = fopen($dir . '/print-counts.json', 'c+');
if (!$fh || !flock($fh, LOCK_EX)) {
    http_response_code(503);
    exit;
}
$counts = json_decode((string) stream_get_contents($fh), true) ?: ['total' => 0, 'by_size' => [], 'minute' => '', 'in_minute' => 0];
$minute = gmdate('Y-m-d H:i');
if ($counts['minute'] !== $minute) {
    $counts['minute'] = $minute;
    $counts['in_minute'] = 0;
}
if ($counts['in_minute'] >= PER_MINUTE) {
    flock($fh, LOCK_UN);
    fclose($fh);
    http_response_code(429);
    exit;
}
$counts['in_minute']++;
$counts['total']++;
$counts['by_size'][$key] = ($counts['by_size'][$key] ?? 0) + 1;
ftruncate($fh, 0);
rewind($fh);
fwrite($fh, json_encode($counts, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);
http_response_code(204);
