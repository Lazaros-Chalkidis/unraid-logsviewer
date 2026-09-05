<?php
/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

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

if (!function_exists('lv_alert_save_json')) {
    // temp file in the same dir then rename, so a power cut can't leave a half-written json
    function lv_alert_save_json(string $path, $data): void {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) return;
        $tmp = $path . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $json, LOCK_EX) === false) { @unlink($tmp); return; }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) @unlink($tmp);
    }
}

if (!function_exists('lv_alert_is_allowed_path')) {
    // same path whitelist as the api, alerts can only scan known log locations
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
            $path  = (string)($entry['path']  ?? '');
            if ($label === '' || $path === '' || !lv_alert_is_allowed_path($path)) continue;
            $key = lv_alert_custom_key($label);
            if (isset($systemLogs[$key])) continue;
            $systemLogs[$key] = $path;
        }
        return $systemLogs;
    }
}

if (!function_exists('lv_alert_load_user_scripts')) {
    // paths come from folder names on disk, never from user input
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
    // drop expired mutes while loading so a muted rule re-fires once its window passes
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

if (!function_exists('lv_alert_safe_regex')) {
    // user-supplied pattern, run it with a time guard so a bad regex can't hang the scan
    function lv_alert_safe_regex(string $pattern, string $subject): bool {
        if (strlen($pattern) > 500) return false;
        $regex = '/' . str_replace('/', '\/', $pattern) . '/i';
        if (@preg_match($regex, '') === false) return false;
        $prevLimit = (int)ini_get('pcre.backtrack_limit');
        ini_set('pcre.backtrack_limit', '10000');
        $result = @preg_match($regex, $subject);
        ini_set('pcre.backtrack_limit', (string)$prevLimit);
        return ($result === 1);
    }
}

if (!function_exists('lv_alert_send_notify')) {
    // fires an unraid notification through the dynamix notify script
    function lv_alert_send_notify(string $severity, string $ruleName, string $source, string $matchedLine): void {
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
        @shell_exec("{$notifyCmd} -i " . escapeshellarg($nsev) . " -e 'Logs Viewer Alert' -s {$subject} -d {$detail}");
    }
}

if (!function_exists('lv_run_alerts_scan')) {
    // walk every enabled rule against the new tail of each log, notify on matches, return the count
    function lv_run_alerts_scan(): int {
        $rulesFile       = '/boot/config/plugins/logsviewer/alerts-rules.json';
        $historyFile     = '/boot/config/plugins/logsviewer/alerts-history.json';
        $mutesFile       = '/boot/config/plugins/logsviewer/alert-mutes.json';
        $customPathsFile = '/boot/config/plugins/logsviewer/custom-paths.json';
        // offsets change on every scan, keeping them on /boot would wear the flash
        $offsetsFile     = '/tmp/logsviewer_cache/alert-offsets.json';
        $cooldownFile    = '/tmp/logsviewer_cache/alert_cooldowns.json';
        $cfgFile         = '/boot/config/plugins/logsviewer/logsviewer.cfg';
        $maxHistory      = 500;

        $systemLogs = [
            'syslog'          => '/var/log/syslog',
            'dmesg'           => '/var/log/dmesg',
            'graphql-api.log' => '/var/log/graphql-api.log',
            'nginx-error'     => '/var/log/nginx/error.log',
            'phplog'          => '/var/log/phplog',
            'libvirt'         => '/var/log/libvirt/libvirtd.log',
        ];

        if (!is_dir('/tmp/logsviewer_cache')) @mkdir('/tmp/logsviewer_cache', 0700, true);

        // one-time migration from older versions that kept the offsets on flash
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
        $history   = lv_alert_load_json($historyFile, []);
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
                // no cursor yet, start at the end instead of replaying old lines
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
            @fseek($fh, $savedOffset);
            $newContent = @fread($fh, min($fileSize - $savedOffset, 1048576));
            @fclose($fh);

            if ($newContent === false || trim($newContent) === '') {
                $offsets[$srcKey] = ['inode' => $currentInode, 'offset' => $savedOffset];
                continue;
            }

            $newOffset = $savedOffset + strlen($newContent);
            $offsets[$srcKey] = ['inode' => $currentInode, 'offset' => $newOffset];
            $newLines = explode("\n", $newContent);

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

                lv_alert_send_notify($severity, $ruleName, $srcKey, $matched);
                $cooldowns[$cdKey] = $now;
                $newAlerts[] = [
                    'timestamp'    => $timestamp,
                    'rule'         => $ruleName,
                    'rule_id'      => $ruleId,
                    'severity'     => $severity,
                    'source'       => $srcKey,
                    'matched_line' => substr($matched, 0, 200),
                    'tags'         => $tags,
                ];
            }
        }

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
                    $tags     = is_array($rule['tags'] ?? null) ? array_values($rule['tags']) : [];
                    $cdKey    = $ruleId . '_docker_' . $container;

                    if ($cooldown > 0 && isset($cooldowns[$cdKey])) {
                        if (($now - (int)$cooldowns[$cdKey]) < $cooldown) continue;
                    }

                    $matched = null;
                    foreach ($lines as $line) {
                        $line = trim($line);
                        if ($line === '') continue;
                        if ($isRegex) {
                            if (lv_alert_safe_regex($pattern, $line)) { $matched = $line; break; }
                        } else {
                            if (stripos($line, $pattern) !== false) { $matched = $line; break; }
                        }
                    }

                    if ($matched === null) continue;

                    $srcLabel = 'Docker: ' . $container;
                    lv_alert_send_notify($severity, $ruleName, $srcLabel, $matched);
                    $cooldowns[$cdKey] = $now;
                    $newAlerts[] = [
                        'timestamp'    => $timestamp,
                        'rule'         => $ruleName,
                        'rule_id'      => $ruleId,
                        'severity'     => $severity,
                        'source'       => 'docker:' . $container,
                        'matched_line' => substr($matched, 0, 200),
                        'tags'         => $tags,
                    ];
                }
            }
        }

        lv_alert_save_json($offsetsFile, $offsets);
        lv_alert_save_json($cooldownFile, $cooldowns);

        if (!empty($newAlerts)) {
            $history = array_merge($newAlerts, $history);
            $history = array_slice($history, 0, $maxHistory);
            lv_alert_save_json($historyFile, $history);
        }

        return count($newAlerts);
    }
}

if (PHP_SAPI === 'cli' && !defined('LV_SCAN_LIBRARY_ONLY')) {
    // cron and the Scan Now button both land here, a second scan would re-notify the same lines
    if (!is_dir('/tmp/logsviewer_cache')) @mkdir('/tmp/logsviewer_cache', 0700, true);
    $lockFh = @fopen('/tmp/logsviewer_cache/alerts-scan.lock', 'c');
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
