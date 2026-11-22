<?php
/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

require_once __DIR__ . '/logsviewer-datepath.php';
require_once __DIR__ . '/logsviewer-shell.php';

defined('LV_ALERT_HISTORY')       || define('LV_ALERT_HISTORY', '/tmp/logsviewer_cache/alerts-history.json');
defined('LV_ALERT_HISTORY_FLASH') || define('LV_ALERT_HISTORY_FLASH', '/boot/config/plugins/logsviewer/alerts-history.json');

if (!function_exists('lv_alert_get_cfg')) {
    function lv_alert_get_cfg(string $file, string $key): string {
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
}

if (!function_exists('lv_alert_load_json')) {
    function lv_alert_load_json(string $path, $default = []) {
        if (!is_file($path)) return $default;
        $data = @json_decode((string)@file_get_contents($path), true);
        return is_array($data) ? $data : $default;
    }
}

if (!function_exists('lv_alert_write')) {
    function lv_alert_write(string $path, string $data): void {
        $tmp = $path . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $data, LOCK_EX) === false) { @unlink($tmp); return; }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) @unlink($tmp);
    }
}

if (!function_exists('lv_alert_save_json')) {
    function lv_alert_save_json(string $path, $data): void {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json !== false) lv_alert_write($path, $json);
    }
}

if (!function_exists('lv_alert_load_history')) {
    function lv_alert_load_history(): array {
        return lv_alert_load_json(is_file(LV_ALERT_HISTORY) ? LV_ALERT_HISTORY : LV_ALERT_HISTORY_FLASH, []);
    }
}

if (!function_exists('lv_alert_flush_history')) {
    function lv_alert_flush_history(): void {
        if (lv_cache_dir() === null || !is_file(LV_ALERT_HISTORY) || !is_dir(dirname(LV_ALERT_HISTORY_FLASH))) return;
        $json = @file_get_contents(LV_ALERT_HISTORY);
        $data = is_string($json) ? json_decode($json, true) : null;
        if (!is_array($data)) return;
        $saved = is_file(LV_ALERT_HISTORY_FLASH) ? @file_get_contents(LV_ALERT_HISTORY_FLASH) : null;
        if ($saved === $json || ($saved === null && !$data)) return;
        lv_alert_write(LV_ALERT_HISTORY_FLASH, $json);
    }
}

if (!function_exists('lv_alert_clear_history')) {
    function lv_alert_clear_history(): void {
        if (lv_cache_dir() === null) return;
        lv_alert_write(LV_ALERT_HISTORY, '[]');
        lv_alert_flush_history();
    }
}

if (!function_exists('lv_alert_is_allowed_path')) {
    function lv_alert_is_allowed_path(string $path): bool {
        $allowedPrefixes = ['/var/log/', '/mnt/user/', '/mnt/cache/'];
        if ($path === '' || $path[0] !== '/') return false;
        if (strpos($path, '..') !== false) return false;
        $real = @realpath($path);
        $check = ($real !== false) ? $real : $path;
        foreach ($allowedPrefixes as $prefix) {
            if (strpos($check, $prefix) === 0) return true;
        }
        return false;
    }
}

if (!function_exists('lv_alert_custom_key')) {
    function lv_alert_custom_key(string $label): string {
        $slug = strtolower(trim($label));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug);
        $slug = trim((string)$slug, '-');
        if ($slug === '') $slug = 'custom';
        return 'custom:' . $slug;
    }
}

if (!function_exists('lv_alert_load_custom_logs')) {
    function lv_alert_load_custom_logs(string $customPathsFile, array $systemLogs): array {
        $custom = lv_alert_load_json($customPathsFile, []);
        if (!is_array($custom) || empty($custom)) return $systemLogs;
        foreach ($custom as $entry) {
            if (!is_array($entry)) continue;
            $label = (string)($entry['label'] ?? '');
            $path  = lv_expand_date_path((string)($entry['path'] ?? ''));
            if ($label === '' || $path === '' || !lv_alert_is_allowed_path($path)) continue;
            $key = lv_alert_custom_key($label);
            if (isset($systemLogs[$key])) continue;
            $systemLogs[$key] = $path;
        }
        return $systemLogs;
    }
}

if (!function_exists('lv_alert_load_user_scripts')) {
    function lv_alert_load_user_scripts(array $systemLogs): array {
        foreach ((array)@glob('/boot/config/plugins/user.scripts/scripts/*/script') as $scriptFile) {
            $folder = basename(dirname($scriptFile));
            if ($folder === '' || strpos($folder, '..') !== false) continue;
            $key = 'script:' . $folder;
            if (isset($systemLogs[$key])) continue;
            $systemLogs[$key] = '/tmp/user.scripts/tmpScripts/' . $folder . '/log.txt';
        }
        return $systemLogs;
    }
}

if (!function_exists('lv_alert_load_active_mutes')) {
    function lv_alert_load_active_mutes(string $mutesFile): array {
        $mutes = lv_alert_load_json($mutesFile, []);
        if (!is_array($mutes) || empty($mutes)) return [];
        $now = time();
        $changed = false;
        foreach ($mutes as $ruleId => $info) {
            if (!is_array($info)) { unset($mutes[$ruleId]); $changed = true; continue; }
            $exp = $info['expires'] ?? null;
            if ($exp === 'permanent') continue;
            if (!is_numeric($exp) || (int)$exp <= $now) {
                unset($mutes[$ruleId]);
                $changed = true;
            }
        }
        if ($changed) lv_alert_save_json($mutesFile, $mutes);
        return $mutes;
    }
}

if (!function_exists('lv_alert_regex')) {
    function lv_alert_regex(string $pattern): ?string {
        if (strlen($pattern) > 500 || strpos($pattern, "\x01") !== false) return null;
        $regex = "\x01" . $pattern . "\x01i";
        return @preg_match($regex, '') === false ? null : $regex;
    }
}

if (!function_exists('lv_alert_safe_regex')) {
    function lv_alert_safe_regex(string $pattern, string $subject): bool {
        $regex = lv_alert_regex($pattern);
        if ($regex === null) return false;
        $prevLimit = (int)ini_get('pcre.backtrack_limit');
        ini_set('pcre.backtrack_limit', '10000');
        $result = @preg_match($regex, $subject);
        ini_set('pcre.backtrack_limit', (string)$prevLimit);
        return ($result === 1);
    }
}

if (!function_exists('lv_alert_send_notify')) {
    function lv_alert_send_notify(string $severity, string $ruleName, string $source, string $matchedLine, int $sent): void {
        [$ruleName, $matchedLine] = str_replace("\0", '', [$ruleName, $matchedLine]);
        $notifyCmd = '/usr/local/emhttp/webGui/scripts/notify';
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
        $sourceNames = [
            'syslog' => 'Syslog', 'syslog-previous' => 'Syslog Previous', 'dmesg' => 'Dmesg',
            'graphql-api.log' => 'GraphQL API', 'nginx-error' => 'Nginx', 'phplog' => 'PHP Log', 'libvirt' => 'Libvirt',
        ];
        if (strpos($source, 'script:') === 0) {
            $displaySource = 'User Script: ' . substr($source, 7);
        } elseif (strpos($source, 'custom:') === 0) {
            $displaySource = 'Custom: ' . ucwords(str_replace(['custom:', '-'], ['', ' '], $source));
        } else {
            $displaySource = $sourceNames[$source] ?? ucfirst($source);
        }
        $cleanLine = $matchedLine;
        $cleanLine = preg_replace('/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+/', '', $cleanLine);
        $cleanLine = preg_replace('/^\[\s*[\d.]+\]\s*/', '', $cleanLine);
        $cleanLine = preg_replace('/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/', '', $cleanLine);
        $cleanLine = preg_replace('/^\[\d{2}-[A-Z][a-z]{2}-\d{4}\s+\d{2}:\d{2}:\d{2}[^\]]*\]\s*/', '', $cleanLine);
        $subject = escapeshellarg("{$prefix} {$ruleName} | {$displaySource}");
        $detail  = escapeshellarg(substr(trim($cleanLine), 0, 200));
        $event   = escapeshellarg('Logs Viewer Alert' . ($sent > 0 ? ' (' . ($sent + 1) . ')' : ''));
        @shell_exec("{$notifyCmd} -i " . escapeshellarg($nsev) . " -e {$event} -s {$subject} -d {$detail}");
    }
}

if (!function_exists('lv_run_alerts_scan')) {
    function lv_run_alerts_scan(): int {
        $rulesFile       = '/boot/config/plugins/logsviewer/alerts-rules.json';
        $mutesFile       = '/boot/config/plugins/logsviewer/alert-mutes.json';
        $customPathsFile = '/boot/config/plugins/logsviewer/custom-paths.json';
        $offsetsFile     = '/tmp/logsviewer_cache/alert-offsets.json';
        $cooldownFile    = '/tmp/logsviewer_cache/alert_cooldowns.json';
        $cfgFile         = '/boot/config/plugins/logsviewer/logsviewer.cfg';
        $maxHistory      = 500;
        $maxChunks       = 16;

        $systemLogs = [
            'syslog'          => '/var/log/syslog',
            'dmesg'           => '/var/log/dmesg',
            'graphql-api.log' => '/var/log/graphql-api.log',
            'nginx-error'     => '/var/log/nginx/error.log',
            'phplog'          => '/var/log/phplog',
            'libvirt'         => '/var/log/libvirt/libvirtd.log',
        ];

        if (lv_cache_dir() === null) return 0;

        $legacyOffsets = '/boot/config/plugins/logsviewer/alert-offsets.json';
        if (is_file($legacyOffsets)) {
            if (!is_file($offsetsFile)) @copy($legacyOffsets, $offsetsFile);
            @unlink($legacyOffsets);
        }

        $systemLogs = lv_alert_load_custom_logs($customPathsFile, $systemLogs);
        $systemLogs = lv_alert_load_user_scripts($systemLogs);

        $rules     = lv_alert_load_json($rulesFile, []);
        $offsets   = lv_alert_load_json($offsetsFile, []);
        $cooldowns = lv_alert_load_json($cooldownFile, []);
        $mutes     = lv_alert_load_active_mutes($mutesFile);

        if (empty($rules)) return 0;

        $now       = time();
        $timestamp = date('Y-m-d H:i:s');
        $interval  = (int)(lv_alert_get_cfg($cfgFile, 'ALERTS_INTERVAL') ?: 5);
        $newAlerts = [];

        $activeRules = array_filter($rules, function($r) use ($mutes) {
            if (empty($r['enabled'])) return false;
            $rid = (string)($r['id'] ?? '');
            return $rid === '' || !isset($mutes[$rid]);
        });
        if (empty($activeRules)) return 0;

        $stored = 0;
        $store = function () use (&$offsets, &$cooldowns, &$newAlerts, &$stored, $offsetsFile, $cooldownFile, $maxHistory): void {
            lv_alert_save_json($offsetsFile, $offsets);
            lv_alert_save_json($cooldownFile, $cooldowns);
            if (count($newAlerts) === $stored) return;
            $history = array_merge($newAlerts, array_slice(lv_alert_load_history(), $stored));
            lv_alert_save_json(LV_ALERT_HISTORY, array_slice($history, 0, $maxHistory));
            $stored = count($newAlerts);
        };

        foreach ($systemLogs as $srcKey => $logPath) {
            if (!is_file($logPath) || !is_readable($logPath)) continue;
            $fileSize = (int)@filesize($logPath);
            if ($fileSize === 0) continue;
            $currentInode = (int)@fileinode($logPath);

            $cursor = $offsets[$srcKey] ?? null;
            if (is_int($cursor) || (is_string($cursor) && is_numeric($cursor))) {
                $savedInode  = $currentInode;
                $savedOffset = (int)$cursor;
            } elseif (is_array($cursor)) {
                $savedInode  = (int)($cursor['inode']  ?? 0);
                $savedOffset = (int)($cursor['offset'] ?? 0);
            } else {
                $savedInode  = $currentInode;
                $savedOffset = $fileSize;
            }

            if ($savedInode !== 0 && $savedInode !== $currentInode) {
                $savedOffset = 0;
            }
            if ($savedOffset > $fileSize) $savedOffset = 0;
            if ($savedOffset >= $fileSize) {
                $offsets[$srcKey] = ['inode' => $currentInode, 'offset' => $savedOffset];
                continue;
            }

            $fh = @fopen($logPath, 'rb');
            if (!$fh) continue;
            $fired = [];

            for ($chunk = 0; $chunk < $maxChunks && $savedOffset < $fileSize; $chunk++) {
                @fseek($fh, $savedOffset);
                $newContent = @fread($fh, min($fileSize - $savedOffset, 1048576));
                if ($newContent === false || $newContent === '') break;
                if ($savedOffset + strlen($newContent) < $fileSize) {
                    $cut = strrpos($newContent, "\n");
                    if ($cut !== false) $newContent = substr($newContent, 0, $cut + 1);
                }

                $savedOffset += strlen($newContent);
                if (trim($newContent) === '') continue;
                $newLines = explode("\n", $newContent);

                foreach ($activeRules as $ruleKey => $rule) {
                    if (isset($fired[$ruleKey])) continue;
                    $sources = $rule['sources'] ?? [];
                    if (!in_array($srcKey, $sources, true)) continue;

                    $pattern  = $rule['pattern'] ?? '';
                    if ($pattern === '') continue;

                    $ruleId   = $rule['id'] ?? '';
                    $ruleName = $rule['name'] ?? 'Unnamed';
                    $severity = $rule['severity'] ?? 'info';
                    $cooldown = (int)($rule['cooldown'] ?? 0);
                    $isRegex  = !empty($rule['is_regex']);
                    $tags     = is_array($rule['tags'] ?? null) ? array_values($rule['tags']) : [];
                    $cdKey    = $ruleId . '_' . $srcKey;

                    if ($cooldown > 0 && isset($cooldowns[$cdKey])) {
                        if (($now - (int)$cooldowns[$cdKey]) < $cooldown) continue;
                    }

                    $matched = null;
                    foreach ($newLines as $line) {
                        $line = trim($line);
                        if ($line === '') continue;
                        if ($isRegex) {
                            if (lv_alert_safe_regex($pattern, $line)) { $matched = $line; break; }
                        } else {
                            if (stripos($line, $pattern) !== false) { $matched = $line; break; }
                        }
                    }

                    if ($matched === null) continue;

                    $fired[$ruleKey] = true;
                    lv_alert_send_notify($severity, $ruleName, $srcKey, $matched, count($newAlerts));
                    $cooldowns[$cdKey] = $now;
                    $newAlerts[] = [
                        'timestamp'    => $timestamp,
                        'rule'         => $ruleName,
                        'rule_id'      => $ruleId,
                        'severity'     => $severity,
                        'source'       => $srcKey,
                        'matched_line' => mb_strcut($matched, 0, 200, 'UTF-8'),
                        'tags'         => $tags,
                    ];
                }
            }
            @fclose($fh);
            $offsets[$srcKey] = ['inode' => $currentInode, 'offset' => $savedOffset];
        }

        $store();

        $dockerRules = array_filter($activeRules, function($r) {
            return in_array('docker', $r['sources'] ?? [], true);
        });

        if ($dockerRules) {
            $docker = lv_bin('docker');
            @exec(lv_cmd('sh', '-c ' . escapeshellarg($docker . ' inspect --format="{{.Name}}|{{.State.Status}}|{{.State.FinishedAt}}" $(' . $docker . ' ps -aq)') . ' 2>/dev/null'), $rows);

            foreach ($rows as $row) {
                $fields = explode('|', trim($row));
                if (count($fields) !== 3) continue;
                [$container, $state, $finished] = $fields;
                $container = ltrim($container, '/');
                if (!preg_match('/^[a-zA-Z0-9._-]+$/', $container)) continue;

                $live  = in_array($state, ['running', 'paused', 'restarting'], true);
                $place = isset($offsets['docker:' . $container]) ? (int)$offsets['docker:' . $container] : null;
                if (!$live && (int)strtotime($finished) < ($place ?? $now - $interval * 60)) continue;

                $until = time() - ($live ? 1 : 0);
                $since = max($place ?? $until - $interval * 60, $until - 2 * $interval * 60);
                $out = @popen(lv_cmd('docker', 'logs --since ' . escapeshellarg(gmdate('Y-m-d\TH:i:s\Z', $since)) . ' --until ' . escapeshellarg(gmdate('Y-m-d\TH:i:s\Z', $until)) . ' ' . escapeshellarg($container) . ' 2>&1', 30), 'r');
                if (!$out) continue;
                $hits = [];
                while (($line = fgets($out, 1048576)) !== false) {
                    $line = trim($line);
                    if ($line === '') continue;
                    foreach ($dockerRules as $ruleKey => $rule) {
                        $pattern = $rule['pattern'] ?? '';
                        if ($pattern === '' || isset($hits[$ruleKey])) continue;
                        if (!empty($rule['is_regex'])) {
                            if (lv_alert_safe_regex($pattern, $line)) $hits[$ruleKey] = $line;
                        } else {
                            if (stripos($line, $pattern) !== false) $hits[$ruleKey] = $line;
                        }
                    }
                }
                if (pclose($out) !== 0) continue;
                $offsets['docker:' . $container] = $until;

                foreach ($dockerRules as $ruleKey => $rule) {
                    if (!isset($hits[$ruleKey])) continue;

                    $ruleId   = $rule['id'] ?? '';
                    $ruleName = $rule['name'] ?? 'Unnamed';
                    $severity = $rule['severity'] ?? 'info';
                    $cooldown = (int)($rule['cooldown'] ?? 0);
                    $tags     = is_array($rule['tags'] ?? null) ? array_values($rule['tags']) : [];
                    $cdKey    = $ruleId . '_docker_' . $container;

                    if ($cooldown > 0 && isset($cooldowns[$cdKey])) {
                        if (($now - (int)$cooldowns[$cdKey]) < $cooldown) continue;
                    }

                    $matched  = $hits[$ruleKey];
                    $srcLabel = 'Docker: ' . $container;
                    lv_alert_send_notify($severity, $ruleName, $srcLabel, $matched, count($newAlerts));
                    $cooldowns[$cdKey] = $now;
                    $newAlerts[] = [
                        'timestamp'    => $timestamp,
                        'rule'         => $ruleName,
                        'rule_id'      => $ruleId,
                        'severity'     => $severity,
                        'source'       => 'docker:' . $container,
                        'matched_line' => mb_strcut($matched, 0, 200, 'UTF-8'),
                        'tags'         => $tags,
                    ];
                }
                $store();
            }
        }

        return count($newAlerts);
    }
}

if (PHP_SAPI === 'cli' && !defined('LV_SCAN_LIBRARY_ONLY')) {
    if (($argv[1] ?? '') === 'flush') {
        lv_alert_flush_history();
        exit(0);
    }
    $lockFh = lv_cache_dir() === null ? false : @fopen('/tmp/logsviewer_cache/alerts-scan.lock', 'c');
    if ($lockFh === false || !@flock($lockFh, LOCK_EX | LOCK_NB)) {
        echo '0';
        exit(0);
    }
    $count = lv_run_alerts_scan();
    @flock($lockFh, LOCK_UN);
    @fclose($lockFh);
    echo (string)$count;
    exit(0);
}
