<?php
// LogsViewer Alerts - Scan Engine
// Copyright (C) 2026 Lazaros Chalkidis - License: GPLv3
// Called by logsviewer-alerts.sh via cron

declare(strict_types=1);

// Paths
$rulesFile    = '/boot/config/plugins/logsviewer/alerts-rules.json';
$historyFile  = '/boot/config/plugins/logsviewer/alerts-history.json';
$offsetsFile  = '/tmp/logsviewer_cache/alert_offsets.json';
$cooldownFile = '/tmp/logsviewer_cache/alert_cooldowns.json';
$cfgFile      = '/boot/config/plugins/logsviewer/logsviewer.cfg';
$notifyCmd    = '/usr/local/emhttp/webGui/scripts/notify';
$maxHistory   = 500;

// System log map
$systemLogs = [
    'syslog'          => '/var/log/syslog',
    'dmesg'           => '/var/log/dmesg',
    'graphql-api.log' => '/var/log/graphql-api.log',
    'nginx-error'     => '/var/log/nginx/error.log',
    'phplog'          => '/var/log/phplog',
    'libvirt'         => '/var/log/libvirt/libvirtd.log',
];

// Load config
function getCfgValue(string $file, string $key): string {
    if (!is_file($file)) return '';
    $lines = @file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) return '';
    foreach ($lines as $line) {
        if (strpos($line, $key . '=') === 0) {
            return trim(str_replace('"', '', substr($line, strlen($key) + 1)));
        }
    }
    return '';
}

function loadJson(string $path, $default = []) {
    if (!is_file($path)) return $default;
    $data = @json_decode((string)@file_get_contents($path), true);
    return is_array($data) ? $data : $default;
}

function saveJson(string $path, $data): void {
    @file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

/**
 * Safe regex match with ReDoS protection.
 * Caps pattern length, lowers backtrack limit, validates before use.
 */
function safeRegexMatch(string $pattern, string $subject): bool {
    if (strlen($pattern) > 500) return false;
    $regex = '/' . str_replace('/', '\/', $pattern) . '/i';
    // Validate regex syntax with empty string (no backtracking cost)
    if (@preg_match($regex, '') === false) return false;
    // Lower backtrack limit to prevent catastrophic backtracking
    $prevLimit = (int)ini_get('pcre.backtrack_limit');
    ini_set('pcre.backtrack_limit', '10000');
    $result = @preg_match($regex, $subject);
    ini_set('pcre.backtrack_limit', (string)$prevLimit);
    return ($result === 1);
}

function sendNotify(string $severity, string $ruleName, string $source, string $matchedLine): void {
    global $notifyCmd;
    $nsev = match($severity) {
        'critical' => 'alert',
        'warning'  => 'warning',
        default    => 'normal',
    };
    $prefix = match($severity) {
        'critical' => 'Critical alert:',
        'warning'  => 'Warning detected:',
        default    => 'Info:',
    };
    // Format source name for display
    $sourceNames = [
        'syslog' => 'Syslog', 'syslog-previous' => 'Syslog Previous', 'dmesg' => 'Dmesg',
        'graphql-api.log' => 'GraphQL API', 'nginx-error' => 'Nginx', 'phplog' => 'PHP Log', 'libvirt' => 'Libvirt',
    ];
    $displaySource = $sourceNames[$source] ?? ucfirst($source);
    // Strip known timestamp prefixes from all log formats
    $cleanLine = $matchedLine;
    $cleanLine = preg_replace('/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+/', '', $cleanLine);  // syslog
    $cleanLine = preg_replace('/^\[\s*[\d.]+\]\s*/', '', $cleanLine);                                         // dmesg
    $cleanLine = preg_replace('/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/', '', $cleanLine);              // nginx
    $cleanLine = preg_replace('/^\[\d{2}-[A-Z][a-z]{2}-\d{4}\s+\d{2}:\d{2}:\d{2}[^\]]*\]\s*/', '', $cleanLine); // php log
    $subject = escapeshellarg("{$prefix} {$ruleName} | {$displaySource}");
    $detail = escapeshellarg(substr(trim($cleanLine), 0, 200));
    @shell_exec("{$notifyCmd} -i " . escapeshellarg($nsev) . " -e 'Logs Viewer Alert' -s {$subject} -d {$detail}");
}

// Ensure cache dir
if (!is_dir('/tmp/logsviewer_cache')) @mkdir('/tmp/logsviewer_cache', 0755, true);

// Load state
$rules     = loadJson($rulesFile, []);
$offsets   = loadJson($offsetsFile, []);
$cooldowns = loadJson($cooldownFile, []);
$history   = loadJson($historyFile, []);

if (empty($rules)) exit(0);

$now       = time();
$timestamp = date('Y-m-d H:i:s');
$interval  = (int)(getCfgValue($cfgFile, 'ALERTS_INTERVAL') ?: 5);
$newAlerts = [];

// Filter only enabled rules
$activeRules = array_filter($rules, fn($r) => !empty($r['enabled']));
if (empty($activeRules)) exit(0);

// --- Scan system logs ---

foreach ($systemLogs as $srcKey => $logPath) {
    if (!is_file($logPath) || !is_readable($logPath)) continue;
    $fileSize = (int)@filesize($logPath);
    if ($fileSize === 0) continue;

    // Get saved offset
    $savedOffset = (int)($offsets[$srcKey] ?? 0);
    if ($savedOffset > $fileSize) $savedOffset = 0; // File rotated
    if ($savedOffset >= $fileSize) continue; // No new content

    // Read new content
    $fh = @fopen($logPath, 'rb');
    if (!$fh) continue;
    @fseek($fh, $savedOffset);
    $newContent = @fread($fh, min($fileSize - $savedOffset, 1048576)); // Cap at 1MB
    @fclose($fh);

    if ($newContent === false || trim($newContent) === '') {
        $offsets[$srcKey] = $savedOffset;
        continue;
    }

    $offsets[$srcKey] = $savedOffset + strlen($newContent);
    $newLines = explode("\n", $newContent);

    // Check each rule that includes this specific log source
    foreach ($activeRules as $rule) {
        $sources = $rule['sources'] ?? [];
        if (!in_array($srcKey, $sources, true)) continue;

        $pattern  = $rule['pattern'] ?? '';
        if ($pattern === '') continue;

        $ruleId   = $rule['id'] ?? '';
        $ruleName = $rule['name'] ?? 'Unnamed';
        $severity = $rule['severity'] ?? 'info';
        $cooldown = (int)($rule['cooldown'] ?? 0);
        $isRegex  = !empty($rule['is_regex']);
        $cdKey    = $ruleId . '_' . $srcKey;

        // Cooldown check
        if ($cooldown > 0 && isset($cooldowns[$cdKey])) {
            if (($now - (int)$cooldowns[$cdKey]) < $cooldown) continue;
        }

        // Pattern match
        $matched = null;
        foreach ($newLines as $line) {
            $line = trim($line);
            if ($line === '') continue;
            if ($isRegex) {
                if (safeRegexMatch($pattern, $line)) {
                    $matched = $line;
                    break;
                }
            } else {
                if (stripos($line, $pattern) !== false) {
                    $matched = $line;
                    break;
                }
            }
        }

        if ($matched === null) continue;

        sendNotify($severity, $ruleName, $srcKey, $matched);
        $cooldowns[$cdKey] = $now;
        $newAlerts[] = [
            'timestamp'    => $timestamp,
            'rule'         => $ruleName,
            'severity'     => $severity,
            'source'       => $srcKey,
            'matched_line' => substr($matched, 0, 200),
        ];
    }
}

// --- Scan Docker logs ---

$dockerNeeded = false;
foreach ($activeRules as $rule) {
    if (in_array('docker', $rule['sources'] ?? [], true)) { $dockerNeeded = true; break; }
}

if ($dockerNeeded && !empty(trim((string)@shell_exec('which docker 2>/dev/null')))) {
    $containers = array_filter(explode("\n", trim((string)@shell_exec('docker ps --format "{{.Names}}" 2>/dev/null'))));

    foreach ($containers as $container) {
        $container = trim($container);
        if ($container === '' || !preg_match('/^[a-zA-Z0-9._-]+$/', $container)) continue;

        $recentLogs = (string)@shell_exec('docker logs --since "' . $interval . 'm" ' . escapeshellarg($container) . ' 2>/dev/null');
        if (trim($recentLogs) === '') continue;

        $lines = explode("\n", $recentLogs);

        foreach ($activeRules as $rule) {
            if (!in_array('docker', $rule['sources'] ?? [], true)) continue;

            $pattern  = $rule['pattern'] ?? '';
            if ($pattern === '') continue;

            $ruleId   = $rule['id'] ?? '';
            $ruleName = $rule['name'] ?? 'Unnamed';
            $severity = $rule['severity'] ?? 'info';
            $cooldown = (int)($rule['cooldown'] ?? 0);
            $isRegex  = !empty($rule['is_regex']);
            $cdKey    = $ruleId . '_docker_' . $container;

            if ($cooldown > 0 && isset($cooldowns[$cdKey])) {
                if (($now - (int)$cooldowns[$cdKey]) < $cooldown) continue;
            }

            $matched = null;
            foreach ($lines as $line) {
                $line = trim($line);
                if ($line === '') continue;
                if ($isRegex) {
                    if (safeRegexMatch($pattern, $line)) { $matched = $line; break; }
                } else {
                    if (stripos($line, $pattern) !== false) { $matched = $line; break; }
                }
            }

            if ($matched === null) continue;

            $srcLabel = 'Docker: ' . $container;
            sendNotify($severity, $ruleName, $srcLabel, $matched);
            $cooldowns[$cdKey] = $now;
            $newAlerts[] = [
                'timestamp'    => $timestamp,
                'rule'         => $ruleName,
                'severity'     => $severity,
                'source'       => 'docker:' . $container,
                'matched_line' => substr($matched, 0, 200),
            ];
        }
    }
}

// --- Save state ---

saveJson($offsetsFile, $offsets);
saveJson($cooldownFile, $cooldowns);

// Append new alerts to history
if (!empty($newAlerts)) {
    $history = array_merge($newAlerts, $history);
    $history = array_slice($history, 0, $maxHistory);
    saveJson($historyFile, $history);
}
