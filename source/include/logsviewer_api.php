<?php
// LogsViewer for Unraid - Copyright (C) 2026 Lazaros Chalkidis - License: GPLv3
declare(strict_types=1);

require_once '/usr/local/emhttp/plugins/dynamix/include/Helpers.php';

final class LogsViewerEndpoint
{
    // ── Constants ──────────────────────────────────────────────────────────
    private const HARD_MAX_LINES          = 5000;
    private const BACKREAD_CAP_BYTES      = 1048576; // 1 MB
    private const FORWARD_FALLBACK_CAP_BYTES = 1048576;
    private const COUNT_READ_BUF          = 65536;   // 64 KB
    private const MICRO_CACHE_MIN_MS      = 500;    // Fix #9: raised from 150ms
    private const MICRO_CACHE_MAX_MS      = 2000;   // Fix #9: raised from 800ms
    private const CACHE_DIR               = '/tmp/logsviewer_cache';
    private const NONCE_FILE              = '/tmp/logsviewer_cache/nonce';
    private const NONCE_TTL               = 3600; // 1 hour
    private const RATE_LIMIT_FILE         = '/tmp/logsviewer_cache/rl';
    private const RATE_LIMIT_MAX          = 60;   // max requests per minute per IP

    private const SYSTEM_LOGS = [
        'syslog'          => '/var/log/syslog',
        'syslog-previous' => '/boot/logs/syslog-previous',
        'dmesg'           => '/var/log/dmesg',
        'graphql-api.log' => '/var/log/graphql-api.log',
        'nginx-error'     => '/var/log/nginx/error.log',
        'phplog'          => '/var/log/phplog',
        'libvirt'         => '/var/log/libvirt/libvirtd.log',
    ];

    private const SYSTEM_LOG_NAMES = [
        'syslog'          => 'Syslog',
        'syslog-previous' => 'Syslog Previous',
        'dmesg'           => 'Dmesg',
        'graphql-api.log' => 'GraphQL API',
        'nginx-error'     => 'Nginx Errors',
        'phplog'          => 'PHP Log',
        'libvirt'         => 'Libvirt',
    ];

    private const CUSTOM_PATHS_FILE   = '/boot/config/plugins/logsviewer/custom-paths.json';
    private const ALERT_MUTES_FILE    = '/boot/config/plugins/logsviewer/alert-mutes.json';
    private const ALERTS_SCAN_LOCK    = '/tmp/logsviewer_cache/alerts-scan.lock';
    private const ALERTS_SCAN_SCRIPT  = '/usr/local/emhttp/plugins/logsviewer/include/logsviewer-alerts-scan.php';
    private const ALLOWED_CUSTOM_PREFIXES = ['/var/log/', '/mnt/user/', '/mnt/cache/'];

    public function __construct()
    {
        if (!is_dir(self::CACHE_DIR)) {
            @mkdir(self::CACHE_DIR, 0755, true);
        }
    }

    /**
     * Validate a custom log path against the allowed prefix whitelist.
     * Mirrors the rules enforced in the Settings page.
     */
    private static function isAllowedCustomPath(string $path): bool
    {
        if ($path === '' || $path[0] !== '/') return false;
        if (strpos($path, '..') !== false) return false;
        foreach (self::ALLOWED_CUSTOM_PREFIXES as $prefix) {
            if (strpos($path, $prefix) === 0) return true;
        }
        return false;
    }

    /**
     * Sanitize a custom source key derived from the user-supplied label.
     */
    private static function customKey(string $label): string
    {
        $slug = strtolower(trim($label));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug);
        $slug = trim((string)$slug, '-');
        if ($slug === '') $slug = 'custom';
        return 'custom:' . $slug;
    }

    /**
     * Load user-defined custom log paths (validated).
     * Returns array of ['key' => slug, 'label' => str, 'path' => abs] in input order.
     */
    private function getCustomLogs(): array
    {
        if (!is_file(self::CUSTOM_PATHS_FILE)) return [];
        $entries = @json_decode((string)@file_get_contents(self::CUSTOM_PATHS_FILE), true);
        if (!is_array($entries)) return [];
        $out = [];
        $seenKeys = [];
        foreach ($entries as $e) {
            if (!is_array($e)) continue;
            $label = (string)($e['label'] ?? '');
            $path  = (string)($e['path']  ?? '');
            if ($label === '' || $path === '' || !self::isAllowedCustomPath($path)) continue;
            $key = self::customKey($label);
            // Skip if it collides with built-in or duplicate user keys
            if (isset(self::SYSTEM_LOGS[$key]) || isset($seenKeys[$key])) continue;
            $seenKeys[$key] = true;
            $out[] = ['key' => $key, 'label' => $label, 'path' => $path];
        }
        return $out;
    }

    /**
     * Resolve a system-log label (built-in or custom) to its filesystem path.
     */
    private function resolveSystemLogPath(string $label): ?string
    {
        if (isset(self::SYSTEM_LOGS[$label])) return self::SYSTEM_LOGS[$label];
        if (strpos($label, 'custom:') === 0) {
            foreach ($this->getCustomLogs() as $c) {
                if ($c['key'] === $label) return $c['path'];
            }
        }
        return null;
    }

    /**
     * Resolve a system-log label to its display name (built-in or custom).
     */
    private function resolveSystemLogName(string $label): string
    {
        if (isset(self::SYSTEM_LOG_NAMES[$label])) return self::SYSTEM_LOG_NAMES[$label];
        if (strpos($label, 'custom:') === 0) {
            foreach ($this->getCustomLogs() as $c) {
                if ($c['key'] === $label) return $c['label'];
            }
        }
        return $label;
    }

    // ── Cached runtime state (avoid duplicate calls per request) ────────
    private ?array $_dockerStatesCache = null;
    private ?array $_vmStatesCache = null;
    private ?array $_cfgCache = null;
    private bool $_migrationDone = false;

    /** Cached config: read once per request instead of 6x */
    private function getCfg(): array
    {
        if ($this->_cfgCache === null) {
            $this->_cfgCache = parse_plugin_cfg('logsviewer', true);
        }
        return $this->_cfgCache;
    }

    private function getDockerStates(): array
    {
        if ($this->_dockerStatesCache !== null) return $this->_dockerStatesCache;
        $this->_dockerStatesCache = [];
        $raw = @shell_exec('docker ps -a --format "{{.Names}}\t{{.State}}" 2>/dev/null');
        if ($raw) {
            foreach (array_filter(explode("\n", trim($raw))) as $line) {
                $p = explode("\t", $line);
                if (count($p) >= 2) $this->_dockerStatesCache[trim($p[0])] = trim($p[1]);
            }
        }
        return $this->_dockerStatesCache;
    }

    private function getVmStates(): array
    {
        if ($this->_vmStatesCache !== null) return $this->_vmStatesCache;
        $this->_vmStatesCache = [];
        $raw = @shell_exec('virsh list --all 2>/dev/null');
        if ($raw) {
            foreach (array_filter(explode("\n", trim($raw))) as $line) {
                if (preg_match('/^\s*[-\d]+\s+(\S+)\s+(.+)$/', $line, $m)) {
                    $this->_vmStatesCache[trim($m[1])] = (stripos(trim($m[2]), 'running') !== false) ? 'running' : 'stopped';
                }
            }
        }
        return $this->_vmStatesCache;
    }

    // ── Nonce (CSRF token) ────────────────────────────────────────────────

    /** Generate or return existing nonce (stored in a temp file, rotated hourly) */
    public static function generateNonce(): string
    {
        if (!is_dir(self::CACHE_DIR)) @mkdir(self::CACHE_DIR, 0755, true);
        $file = self::NONCE_FILE;
        $now  = time();

        // Reuse valid nonce
        if (is_file($file)) {
            $data = @json_decode((string)@file_get_contents($file), true);
            if (is_array($data) && isset($data['token'], $data['ts'])
                && ($now - (int)$data['ts']) < self::NONCE_TTL) {
                return (string)$data['token'];
            }
        }

        // Generate new nonce
        $token = bin2hex(random_bytes(24));
        @file_put_contents($file, json_encode(['token' => $token, 'ts' => $now]), LOCK_EX);
        @chmod($file, 0600);
        return $token;
    }

    private function verifyNonce(): void
    {
        $provided = (string)(
            $_GET['_lvt'] ??
            $_SERVER['HTTP_X_LV_TOKEN'] ?? ''
        );
        if ($provided === '') { $this->json(['error' => 'Missing token'], 403); }

        $file = self::NONCE_FILE;
        if (!is_file($file)) { $this->json(['error' => 'Invalid token'], 403); }

        $data = @json_decode((string)@file_get_contents($file), true);
        if (!is_array($data) || !isset($data['token'], $data['ts'])) {
            $this->json(['error' => 'Invalid token'], 403);
        }
        if ((time() - (int)$data['ts']) > self::NONCE_TTL) {
            $this->json(['error' => 'Token expired'], 403);
        }
        if (!hash_equals((string)$data['token'], $provided)) {
            $this->json(['error' => 'Invalid token'], 403);
        }
    }

    // ── Rate limiting (per IP, file-based) ────────────────────────────────

    private function enforceRateLimit(): void
    {
        $ip   = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        $key  = hash('sha256', $ip);
        $file = self::RATE_LIMIT_FILE . '_' . $key;
        $now  = time();

        $data = ['count' => 0, 'window' => $now];
        if (is_file($file)) {
            $raw = @json_decode((string)@file_get_contents($file), true);
            if (is_array($raw)) $data = $raw;
        }

        // Reset window every 60 seconds
        if (($now - (int)$data['window']) >= 60) {
            $data = ['count' => 0, 'window' => $now];
        }

        $data['count']++;
        @file_put_contents($file, json_encode($data), LOCK_EX);

        if ((int)$data['count'] > self::RATE_LIMIT_MAX) {
            header('Retry-After: 60');
            $this->json(['error' => 'Rate limit exceeded'], 429);
        }
    }

    // ── Request entry point ────────────────────────────────────────────────

    public function run(): void
    {
        // Download bypass: direct browser request, no AJAX header required
        $action = (string)($_GET['action'] ?? '');
        if ($action === 'download_backup') {
            $this->enforceLocalOrigin();
            $this->verifyNonce();
            $this->enforceRateLimit();
            $this->replyDownloadBackup();
            return;
        }

        $this->enforceAjaxGet();

        // Nonce refresh must bypass nonce verification (the old one has expired)
        $action = (string)($_GET['action'] ?? '');
        if ($action === 'refresh_nonce') {
            $this->enforceRateLimit();
            $this->json(['token' => self::generateNonce()]);
        }

        $this->verifyNonce();
        $this->enforceRateLimit();

        $routes = [
            'get_script_states'     => fn() => $this->replyStates(),
            'discover_sources'      => fn() => $this->replyDiscoverSources(),
            'get_docker_containers' => fn() => $this->replyDockerContainers(),
            'get_docker_log'        => fn() => $this->replyDockerLog(),
            'get_vm_list'           => fn() => $this->replyVmList(),
            'get_vm_log'            => fn() => $this->replyVmLog(),
            'list_backups'          => fn() => $this->replyListBackups(),
            'get_alert_rules'       => fn() => $this->replyAlertRules(),
            'get_alert_history'     => fn() => $this->replyAlertHistory(),
            'clear_alert_history'   => fn() => $this->replyClearAlertHistory(),
            'run_alerts_scan'       => fn() => $this->replyRunAlertsScan(),
            'get_alert_mutes'       => fn() => $this->replyAlertMutes(),
            'set_alert_mute'        => fn() => $this->replySetAlertMute(),
            'unset_alert_mute'      => fn() => $this->replyUnsetAlertMute(),
            // Saved-filter and pinned-line endpoints removed with the Saved /
            // Pinned tabs. The backing functions remain below as dead code
            // because they are interleaved with the still-live alert helpers
            // (readAlertRules / writeAlertRules); they are simply no longer
            // routable from here.
        ];

        if (!isset($routes[$action])) {
            $this->json(['error' => 'Invalid action'], 400);
        }

        $routes[$action]();
    }

    // ── Context helpers ────────────────────────────────────────────────────

    private ?string $_contextCache = null;

    private function getContext(): string
    {
        if ($this->_contextCache === null) {
            $c = (string)($_GET['context'] ?? 'dash');
            $this->_contextCache = ($c === 'tool') ? 'tool' : 'dash';
        }
        return $this->_contextCache;
    }

    private function isToolContext(): bool
    {
        return $this->getContext() === 'tool';
    }

    // ── Config helpers ─────────────────────────────────────────────────────

    /** One-time migration from legacy global keys → DASH_* keys */
    private function migrateDashIfNeeded(array &$cfg): void
    {
        if ($this->_migrationDone) return;
        $this->_migrationDone = true;
        if (($cfg['MIGRATED_DASH_SOURCES'] ?? '0') === '1') return;
        if (array_key_exists('DASH_ENABLED_SYSTEM_LOGS', $cfg)) return;

        $legacySystem = (string)($cfg['ENABLED_SYSTEM_LOGS'] ?? ($cfg['ENABLED_SCRIPTS'] ?? ''));
        $legacyDocker = (string)($cfg['ENABLED_DOCKER_CONTAINERS'] ?? '');
        $legacyVm     = (string)($cfg['ENABLED_VMS'] ?? '');
        if ($legacySystem === '' && $legacyDocker === '' && $legacyVm === '') return;

        $cfg['DASH_ENABLED_SYSTEM_LOGS']       = $legacySystem;
        $cfg['DASH_ENABLED_DOCKER_CONTAINERS'] = $legacyDocker;
        $cfg['DASH_ENABLED_VMS']               = $legacyVm;
        $cfg['MIGRATED_DASH_SOURCES']          = '1';

        $ini = '';
        foreach ($cfg as $k => $v) {
            $v = str_replace('"', '\"', (string)$v);
            $ini .= "{$k}=\"{$v}\"\n";
        }
        @file_put_contents('/boot/config/plugins/logsviewer/logsviewer.cfg', $ini);
    }

    private function csvToArray(string $csv): array
    {
        return array_values(array_filter(array_map('trim', explode(',', $csv)), fn($v) => $v !== ''));
    }

    private function getEnabledSystem(array &$cfg, string $context): array
    {
        $default = ['syslog', 'dmesg', 'graphql-api.log', 'nginx-error'];
        $key = ($context === 'tool') ? 'TOOL_ENABLED_SYSTEM_LOGS' : 'DASH_ENABLED_SYSTEM_LOGS';
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        if (!array_key_exists($key, $cfg)) return $default;
        return $this->csvToArray((string)($cfg[$key] ?? ''));
    }

    private function getEnabledDocker(array &$cfg, string $context): array
    {
        $key = ($context === 'tool') ? 'TOOL_ENABLED_DOCKER_CONTAINERS' : 'DASH_ENABLED_DOCKER_CONTAINERS';
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        if (!array_key_exists($key, $cfg)) return [];
        return $this->csvToArray((string)($cfg[$key] ?? ''));
    }

    private function getEnabledVms(array &$cfg, string $context): array
    {
        $key = ($context === 'tool') ? 'TOOL_ENABLED_VMS' : 'DASH_ENABLED_VMS';
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        if (!array_key_exists($key, $cfg)) return [];
        return $this->csvToArray((string)($cfg[$key] ?? ''));
    }

    private function getEnabledCustom(array &$cfg, string $context): array
    {
        $key = ($context === 'tool') ? 'TOOL_ENABLED_CUSTOM_LOGS' : 'DASH_ENABLED_CUSTOM_LOGS';
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        if (!array_key_exists($key, $cfg)) return [];
        return $this->csvToArray((string)($cfg[$key] ?? ''));
    }

    private function getMaxLines(array $cfg): int
    {
        $key = $this->isToolContext() ? 'TOOL_TAIL_LINES' : 'TAIL_LINES';
        $n   = (int)($cfg[$key] ?? 0);
        if ($n <= 0 || $n > self::HARD_MAX_LINES) $n = self::HARD_MAX_LINES;
        return $n;
    }

    // ── Discovery (Settings page) ──────────────────────────────────────────

    private function replyDiscoverSources(): void
    {
        $cfg     = $this->getCfg();
        $context = $this->getContext();
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);

        $sysKey        = ($context === 'tool') ? 'TOOL_ENABLED_SYSTEM_LOGS' : 'DASH_ENABLED_SYSTEM_LOGS';
        $hasSystemCfg  = array_key_exists($sysKey, $cfg);
        $enabledSystem = $this->getEnabledSystem($cfg, $context);
        $enabledDocker = $this->getEnabledDocker($cfg, $context);
        $enabledVms    = $this->getEnabledVms($cfg, $context);
        $enabledCustom = $this->getEnabledCustom($cfg, $context);
        $defaultSystem = ['syslog', 'dmesg', 'graphql-api.log', 'nginx-error'];

        $systemLogs = [];
        foreach (self::SYSTEM_LOGS as $key => $path) {
            $exists       = is_file($path) && is_readable($path);
            $systemLogs[] = [
                'key'     => $key,
                'name'    => self::SYSTEM_LOG_NAMES[$key] ?? $key,
                'path'    => $path,
                'exists'  => $exists,
                'size'    => $exists ? (int)@filesize($path) : 0,
                'enabled' => $hasSystemCfg
                    ? in_array($key, $enabledSystem, true)
                    : in_array($key, $defaultSystem, true),
                'custom'  => false,
            ];
        }

        // Custom logs in their own group (no longer mixed with system)
        $customLogs = [];
        foreach ($this->getCustomLogs() as $c) {
            $exists       = is_file($c['path']) && is_readable($c['path']);
            $customLogs[] = [
                'key'     => $c['key'],
                'name'    => $c['label'],
                'path'    => $c['path'],
                'exists'  => $exists,
                'size'    => $exists ? (int)@filesize($c['path']) : 0,
                'enabled' => in_array($c['key'], $enabledCustom, true),
                'custom'  => true,
            ];
        }

        $dockerAvailable  = $this->isDockerAvailable();
        $dockerContainers = [];
        if ($dockerAvailable) {
            foreach ($this->getDockerContainerList() as $c) {
                $c['enabled']     = in_array($c['name'], $enabledDocker, true);
                $dockerContainers[] = $c;
            }
        }

        $vmAvailable = $this->isVirshAvailable();
        $vms = [];
        if ($vmAvailable) {
            foreach ($this->getVmList() as $vm) {
                $vm['enabled'] = in_array($vm['name'], $enabledVms, true);
                $vms[]         = $vm;
            }
        }

        $this->json([
            'system' => ['available' => true,             'sources' => $systemLogs],
            'docker' => ['available' => $dockerAvailable, 'sources' => $dockerContainers],
            'vm'     => ['available' => $vmAvailable,     'sources' => $vms],
            'custom' => ['available' => true,             'sources' => $customLogs],
        ]);
    }

    // ── Docker ─────────────────────────────────────────────────────────────

    private function isDockerAvailable(): bool
    {
        return !empty(trim((string)@shell_exec('which docker 2>/dev/null')));
    }

    private function getDockerContainerList(): array
    {
        // Pipe separator instead of \t throughout. Reason: the Go template engine
        // used by docker `--format` does not consistently interpret \t as an
        // actual tab character across shell/template combinations, which caused
        // the previous code path to silently produce literal "\t" sequences and
        // fail the subsequent explode(), making every log_size resolve to 0.
        $output = @shell_exec('docker ps -a --format "{{.Names}}|{{.State}}|{{.ID}}" 2>/dev/null');
        if (empty($output)) return [];

        // Batch: get every container's LogPath in one shell call.
        $logPaths = [];
        $pathsRaw = @shell_exec('docker inspect --format="{{.Name}}|{{.LogPath}}" $(docker ps -aq) 2>/dev/null');
        if ($pathsRaw) {
            foreach (array_filter(explode("\n", trim($pathsRaw))) as $pLine) {
                $pp = explode('|', $pLine, 2);
                if (count($pp) === 2) {
                    $nameKey = ltrim(trim($pp[0]), '/');
                    $pathVal = trim($pp[1]);
                    if ($nameKey !== '' && $pathVal !== '') {
                        $logPaths[$nameKey] = $pathVal;
                    }
                }
            }
        }

        // Batch: get size for every log path via a single shell `stat` call.
        // PHP's filesize() can return 0/false on /var/lib/docker/containers/...
        // paths depending on overlay-fs visibility and process credentials, so
        // shell stat (running as root under Unraid's nginx) is the primary
        // source. PHP filesize() is kept as a per-path fallback below.
        $logSizes = [];
        if (!empty($logPaths)) {
            $args = implode(' ', array_map('escapeshellarg', array_values($logPaths)));
            // "%n|%s" prints "fullpath|size", one line per file, missing files
            // emit a stderr line that gets swallowed by 2>/dev/null and produce
            // no stdout line so the keyed map naturally skips them.
            $sizesRaw = @shell_exec('stat -c "%n|%s" -- ' . $args . ' 2>/dev/null');
            if ($sizesRaw) {
                foreach (array_filter(explode("\n", trim($sizesRaw))) as $sLine) {
                    $sp = explode('|', $sLine, 2);
                    if (count($sp) === 2) {
                        $logSizes[trim($sp[0])] = (int)trim($sp[1]);
                    }
                }
            }
        }

        $containers = [];
        foreach (array_filter(explode("\n", trim($output))) as $line) {
            $parts = explode('|', $line);
            if (count($parts) < 3) continue;
            $name    = trim($parts[0]);
            $state   = trim($parts[1]);
            $id      = trim($parts[2]);
            $logPath = $logPaths[$name] ?? '';

            // Primary: shell stat result. Fallback: PHP filesize() if stat missed.
            $logSize = ($logPath !== '' && isset($logSizes[$logPath])) ? $logSizes[$logPath] : 0;
            if ($logSize === 0 && $logPath !== '' && is_file($logPath)) {
                $logSize = (int)@filesize($logPath);
            }

            $containers[] = [
                'name'     => $name,
                'status'   => $state,
                'id'       => $id,
                'log_size' => $logSize,
            ];
        }

        usort($containers, fn($a, $b) => strcasecmp($a['name'], $b['name']));
        return $containers;
    }

    private function replyDockerContainers(): void
    {
        if (!$this->isDockerAvailable()) {
            $this->json(['available' => false, 'containers' => []]);
        }
        $this->json(['available' => true, 'containers' => $this->getDockerContainerList()]);
    }

    private function replyDockerLog(): void
    {
        $container = (string)($_GET['container'] ?? '');
        if ($container === '' || !preg_match('/^[a-zA-Z0-9._-]{1,64}$/', $container)) {
            $this->json(['error' => 'Invalid container name'], 400);
        }
        if (empty(trim((string)@shell_exec('docker inspect --format="{{.Name}}" ' . escapeshellarg($container) . ' 2>/dev/null')))) {
            $this->json(['error' => 'Container not found'], 404);
        }

        $cfg      = $this->getCfg();
        $maxLines = $this->getMaxLines($cfg);
        $rawLog   = $this->forceValidUtf8((string)@shell_exec(
            'docker logs --tail ' . $maxLines . ' ' . escapeshellarg($container) . ' 2>&1'
        ));

        $cState = $this->getDockerStates()[$container] ?? 'unknown';
        $this->json([['name' => $container, 'display_name' => $container, 'status' => $cState,
            'log'         => htmlspecialchars(trim($rawLog), ENT_QUOTES, 'UTF-8'),
            'total_lines' => $this->countLinesInText($rawLog),
            'shown_lines' => $this->countLinesInText($rawLog),
            'max_lines'   => $maxLines, 'source' => 'docker', 'file_size' => strlen($rawLog),
        ]]);
    }

    // ── VMs ────────────────────────────────────────────────────────────────

    private function isVirshAvailable(): bool
    {
        return !empty(trim((string)@shell_exec('which virsh 2>/dev/null')));
    }

    private function getVmList(): array
    {
        $output = @shell_exec('virsh list --all --name 2>/dev/null');
        if (empty($output)) return [];

        $states = $this->getVmStates();
        $vms = [];
        foreach (array_filter(explode("\n", trim($output)), fn($v) => trim($v) !== '') as $name) {
            $name    = trim($name);
            $logPath = $this->safeVmLogPath($name) ?? '/dev/null';
            $vms[]   = [
                'name'     => $name,
                'status'   => $states[$name] ?? 'unknown',
                'log_path' => $logPath,
                'log_size' => is_file($logPath) ? (int)@filesize($logPath) : 0,
            ];
        }

        usort($vms, fn($a, $b) => strcasecmp($a['name'], $b['name']));
        return $vms;
    }

    private function replyVmList(): void
    {
        if (!$this->isVirshAvailable()) {
            $this->json(['available' => false, 'vms' => []]);
        }
        $this->json(['available' => true, 'vms' => $this->getVmList()]);
    }

    private function replyVmLog(): void
    {
        $vmName = (string)($_GET['vm'] ?? '');
        if ($vmName === '' || !preg_match('/^[a-zA-Z0-9 ._-]{1,64}$/', $vmName)) {
            $this->json(['error' => 'Invalid VM name'], 400);
        }

        $vState = $this->getVmStates()[$vmName] ?? 'unknown';

        $cfg      = $this->getCfg();
        $maxLines = $this->getMaxLines($cfg);
        $logPath  = $this->safeVmLogPath($vmName);

        if ($logPath === null) {
            $this->json(['error' => 'Invalid VM log path'], 400);
        }

        if (!is_file($logPath) || !is_readable($logPath)) {
            $this->json([['name' => $vmName, 'display_name' => $vmName, 'status' => $vState,
                'log' => 'No log file found for this VM.', 'total_lines' => 0, 'shown_lines' => 0, 'max_lines' => 0, 'source' => 'vm', 'file_size' => 0,
            ]]);
        }

        [$fh, $snapSize] = $this->openSnapshot($logPath);
        if ($fh === null) {
            $text = "VM log not readable: {$logPath}"; $total = null;
        } elseif ($snapSize === 0) {
            fclose($fh); $text = "VM log is empty."; $total = 0;
        } else {
            $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
            fclose($fh);
            $total = $this->fastCountLines($logPath); // Fix #1
        }

        $text = $this->forceValidUtf8($text);
        $this->json([['name' => $vmName, 'display_name' => $vmName, 'status' => $vState,
            'log'         => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
            'total_lines' => $total,
            'shown_lines' => $this->countLinesInText($text),
            'max_lines'   => $maxLines, 'source' => 'vm', 'file_size' => $snapSize,
        ]]);
    }

    // ── Main log fetch (category-aware) ────────────────────────────────────

    private function replyStates(): void
    {
        $cfg     = $this->getCfg();
        $cacheMs = $this->computeMicroCacheMs($cfg);

        if ($cacheMs > 0) {
            $cached = $this->cacheGet($cfg, $cacheMs);
            if ($cached !== null) {
                // Phase B: hash check on cached content too
                $cachedHash = md5($cached);
                $clientHash = (string)($_GET['_since_hash'] ?? '');
                if ($clientHash !== '' && preg_match('/^[a-f0-9]{32}$/', $clientHash) && $clientHash === $cachedHash) {
                    header('X-LV-Hash: ' . $cachedHash);
                    $this->json(['unchanged' => true, '_hash' => $cachedHash], 200);
                }
                http_response_code(200);
                header('Content-Type: application/json');
                header('Cache-Control: no-cache, must-revalidate');
                header('Expires: Mon, 26 Jul 1997 05:00:00 GMT');
                header('X-Content-Type-Options: nosniff');
                header('X-Frame-Options: SAMEORIGIN');
                header('Referrer-Policy: same-origin');
                header("Content-Security-Policy: default-src 'none'");
                header('X-LV-Hash: ' . $cachedHash);
                echo $cached;
                exit;
            }
        }

        $context  = $this->getContext();
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        $category = (string)($_GET['category'] ?? 'system');

        // Phase A: single-source polling (fetch only the log the user is viewing)
        $source = (string)($_GET['source'] ?? '');
        if ($source !== '' && !preg_match('/^[a-zA-Z0-9 ._-]{1,64}$/', $source)) {
            $source = '';
        }
        $singleSource = ($source !== '') ? $source : null;

        // Merge mode asks for normalized (docker --timestamps) output so lines
        // from every source carry a comparable, system-local timestamp.
        $normTs = (($_GET['_normts'] ?? '') === '1');

        if ($category === 'docker') {
            $rows = $this->fetchDockerLogs($cfg, $context, $singleSource, $normTs);
        } elseif ($category === 'vm') {
            $rows = $this->fetchVmLogs($cfg, $context, $singleSource);
        } elseif ($category === 'custom') {
            $rows = $this->fetchCustomLogs($cfg, $context, $singleSource);
        } else {
            $rows = $this->fetchSystemLogs($cfg, $context, $singleSource);
        }

        $jsonOut = json_encode($rows);
        if ($cacheMs > 0 && $jsonOut !== false) {
            $this->cachePut($cfg, (string)$jsonOut);
        }

        // Phase B: content hash for unchanged detection
        // Client sends _since_hash from the previous poll. If the content
        // hasn't changed, we return a tiny {"unchanged":true} response
        // instead of the full payload (saves 99%+ bandwidth on idle logs).
        if ($jsonOut !== false) {
            $contentHash = md5((string)$jsonOut);
            $clientHash  = (string)($_GET['_since_hash'] ?? '');

            if ($clientHash !== '' && preg_match('/^[a-f0-9]{32}$/', $clientHash) && $clientHash === $contentHash) {
                header('X-LV-Hash: ' . $contentHash);
                $this->json(['unchanged' => true, '_hash' => $contentHash], 200);
            }

            header('X-LV-Hash: ' . $contentHash);
        }

        $this->json($rows, 200);
    }

    private function fetchSystemLogs(array $cfg, string $context, ?string $singleSource = null): array
    {
        $labels   = $this->getEnabledSystem($cfg, $context);
        if ($singleSource !== null) {
            $labels = in_array($singleSource, $labels, true) ? [$singleSource] : [];
        }
        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        foreach ($labels as $label) {
            $path = $this->resolveSystemLogPath($label);
            if ($path === null) continue;

            [$fh, $snapSize] = $this->openSnapshot($path);
            if ($fh === null) {
                $text = "Log file not found or not readable: {$path}"; $total = null;
            } elseif ($snapSize === 0) {
                fclose($fh); $text = "Log is empty."; $total = 0;
            } else {
                $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
                fclose($fh);
                $total = $this->fastCountLines($path); // Fix #1: wc -l instead of full re-read
            }

            $text   = $this->forceValidUtf8($text);
            $rows[] = [
                'name'         => $label,
                'display_name' => $this->resolveSystemLogName($label),
                'status'       => 'idle',
                'log'          => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $total,
                'shown_lines'  => $this->countLinesInText($text),
                'max_lines'    => $maxLines,
                'source'       => 'system',
                'file_size'    => $snapSize,
            ];
        }

        return $rows;
    }

    private function fetchCustomLogs(array $cfg, string $context, ?string $singleSource = null): array
    {
        $labels   = $this->getEnabledCustom($cfg, $context);
        if ($singleSource !== null) {
            $labels = in_array($singleSource, $labels, true) ? [$singleSource] : [];
        }
        if (empty($labels)) return [];
        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        foreach ($labels as $label) {
            if (strpos($label, 'custom:') !== 0) continue;
            $path = $this->resolveSystemLogPath($label);
            if ($path === null) continue;

            [$fh, $snapSize] = $this->openSnapshot($path);
            if ($fh === null) {
                $text = "Log file not found or not readable: {$path}"; $total = null;
            } elseif ($snapSize === 0) {
                fclose($fh); $text = "Log is empty."; $total = 0;
            } else {
                $text = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
                fclose($fh);
                $total = $this->fastCountLines($path);
            }
            $text = $this->forceValidUtf8($text);
            $rows[] = [
                'name'         => $label,
                'display_name' => $this->resolveSystemLogName($label),
                'status'       => 'idle',
                'log'          => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $total,
                'shown_lines'  => $this->countLinesInText($text),
                'max_lines'    => $maxLines,
                'source'       => 'custom',
                'file_size'    => $snapSize,
            ];
        }

        return $rows;
    }

    private function fetchDockerLogs(array $cfg, string $context, ?string $singleSource = null, bool $normTs = false): array
    {
        $enabled = $this->getEnabledDocker($cfg, $context);
        if (empty($enabled) || !$this->isDockerAvailable()) return [];
        if ($singleSource !== null) {
            $enabled = in_array($singleSource, $enabled, true) ? [$singleSource] : [];
            if (empty($enabled)) return [];
        }

        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        // Get actual container states (cached per request)
        $containerStates = $this->getDockerStates();

        // Fix #3: Launch all docker log commands in parallel (proc_open)
        // instead of serial shell_exec which blocks N × 0.5-2s.
        $procs = [];
        $pipes = [];
        $validContainers = [];
        foreach ($enabled as $container) {
            if (!preg_match('/^[a-zA-Z0-9._-]{1,64}$/', $container)) continue;
            // In merge mode (normTs) we pull Docker's own RFC3339 UTC timestamp
            // per line via --timestamps. Container apps log in wildly different
            // formats (or none), so their inline timestamps cannot be relied on
            // for cross-source ordering; the docker-supplied one always can.
            $tsFlag = $normTs ? '--timestamps ' : '';
            $cmd = 'docker logs ' . $tsFlag . '--tail ' . $maxLines . ' ' . escapeshellarg($container) . ' 2>&1';
            $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
            $proc = @proc_open($cmd, $desc, $p);
            if (is_resource($proc)) {
                @fclose($p[0]); // close stdin
                $procs[]    = $proc;
                $pipes[]    = $p;
                $validContainers[] = $container;
            }
        }

        // Collect results (all ran in parallel, now just reading)
        foreach ($procs as $i => $proc) {
            $rawLog = (string)@stream_get_contents($pipes[$i][1]);
            @fclose($pipes[$i][1]);
            @fclose($pipes[$i][2]);
            @proc_close($proc);

            $rawLog = $this->forceValidUtf8($rawLog);
            if ($normTs) $rawLog = $this->normalizeDockerTimestamps($rawLog);
            $container = $validContainers[$i];
            $rows[] = [
                'name'         => $container,
                'display_name' => $container,
                'status'       => $containerStates[$container] ?? 'unknown',
                'log'          => htmlspecialchars(trim($rawLog), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $this->countLinesInText($rawLog),
                'shown_lines'  => $this->countLinesInText($rawLog),
                'max_lines'    => $maxLines,
                'source'       => 'docker',
                'file_size'    => strlen($rawLog),
            ];
        }

        return $rows;
    }

    /**
     * Rewrite Docker's RFC3339 (UTC) per-line timestamp prefix, produced by
     * `docker logs --timestamps`, into the same system-local "M j H:i:s" shape
     * the Unraid syslog uses. This makes Docker lines directly comparable and
     * visually consistent with system lines in Merge mode, and lets the single
     * client-side syslog timestamp parser order every source correctly.
     *
     * gmdate() with (epoch + system offset) is used deliberately so the result
     * does not depend on PHP's date_default_timezone, which on Unraid is often
     * UTC even though the syslog is written in local time.
     */
    private function normalizeDockerTimestamps(string $raw): string
    {
        if ($raw === '') return $raw;
        $offset = $this->systemTzOffsetSeconds();
        $out    = [];
        foreach (explode("\n", $raw) as $line) {
            if ($line === '') { $out[] = $line; continue; }
            // Docker prefix: 2026-05-15T14:03:29.123456789Z <original line>
            if (preg_match('/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})\s(.*)$/s', $line, $m)) {
                $epoch = strtotime($m[1] . $m[2]);
                if ($epoch !== false) {
                    $out[] = gmdate('M j H:i:s', $epoch + $offset) . ' ' . $m[3];
                    continue;
                }
            }
            $out[] = $line; // leave anything we cannot parse untouched
        }
        return implode("\n", $out);
    }

    /** System (kernel) UTC offset in seconds, e.g. +10800 for EEST. */
    private function systemTzOffsetSeconds(): int
    {
        $z = trim((string)@shell_exec('date +%z 2>/dev/null')); // "+0300"
        if (!preg_match('/^([+-])(\d{2})(\d{2})$/', $z, $m)) return 0;
        $sec = ((int)$m[2]) * 3600 + ((int)$m[3]) * 60;
        return ($m[1] === '-') ? -$sec : $sec;
    }

    private function fetchVmLogs(array $cfg, string $context, ?string $singleSource = null): array
    {
        $enabled = $this->getEnabledVms($cfg, $context);
        if (empty($enabled) || !$this->isVirshAvailable()) return [];
        if ($singleSource !== null) {
            $enabled = in_array($singleSource, $enabled, true) ? [$singleSource] : [];
            if (empty($enabled)) return [];
        }

        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        // Get actual VM states (cached per request)
        $vmStates = $this->getVmStates();

        foreach ($enabled as $vmName) {
            if (!preg_match('/^[a-zA-Z0-9 ._-]{1,64}$/', $vmName)) continue;
            $logPath = $this->safeVmLogPath($vmName);
            if ($logPath === null) continue;

            [$fh, $snapSize] = $this->openSnapshot($logPath);
            if ($fh === null) {
                $text = "No log file for VM: {$vmName}"; $total = null;
            } elseif ($snapSize === 0) {
                fclose($fh); $text = "VM log is empty."; $total = 0;
            } else {
                $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
                fclose($fh);
                $total = $this->fastCountLines($logPath); // Fix #1: wc -l instead of full re-read
            }

            $text   = $this->forceValidUtf8($text);
            $rows[] = [
                'name'         => $vmName,
                'display_name' => $vmName,
                'status'       => $vmStates[$vmName] ?? 'unknown',
                'log'          => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $total,
                'shown_lines'  => $this->countLinesInText($text),
                'max_lines'    => $maxLines,
                'source'       => 'vm',
                'file_size'    => $snapSize,
            ];
        }

        return $rows;
    }

    // ── Backup: List available backups ────────────────────────────────────

    private function replyListBackups(): void
    {
        $cfg         = $this->getCfg();
        $storagePath = (string)($cfg['BACKUP_STORAGE'] ?? '');

        if ($storagePath === '' || !is_dir($storagePath)) {
            $this->json(['backups' => []]);
        }

        $backupDir = rtrim($storagePath, '/');
        $backups = [];
        foreach (glob($backupDir . '/*.zip') as $file) {
            $name = basename($file, '.zip');
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $name)) continue;

            // Peek inside zip for summary
            $contents = ['system' => 0, 'docker' => 0, 'vms' => 0, 'custom' => 0];
            $za = new \ZipArchive();
            if ($za->open($file) === true) {
                for ($i = 0; $i < $za->numFiles; $i++) {
                    $entry = $za->getNameIndex($i);
                    if (str_starts_with($entry, 'system/') && !str_ends_with($entry, '/')) $contents['system']++;
                    elseif (str_starts_with($entry, 'docker/') && !str_ends_with($entry, '/')) $contents['docker']++;
                    elseif (str_starts_with($entry, 'vms/') && !str_ends_with($entry, '/')) $contents['vms']++;
                    elseif (str_starts_with($entry, 'custom/') && !str_ends_with($entry, '/')) $contents['custom']++;
                }
                $za->close();
            }

            $backups[] = [
                'date'     => $name,
                'size'     => (int)@filesize($file),
                'contents' => $contents,
            ];
        }

        usort($backups, fn($a, $b) => strcmp($b['date'], $a['date']));
        $this->json(['backups' => $backups]);
    }

    // ── Backup: Download a backup zip ─────────────────────────────────────

    private function replyDownloadBackup(): void
    {
        $date = (string)($_GET['date'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            http_response_code(400);
            exit('Invalid date');
        }

        $cfg         = $this->getCfg();
        $storagePath = (string)($cfg['BACKUP_STORAGE'] ?? '');
        if ($storagePath === '' || !is_dir($storagePath)) {
            http_response_code(404);
            exit('Storage not configured');
        }

        $backupDir = rtrim($storagePath, '/');
        $file      = $backupDir . '/' . $date . '.zip';

        // Security: verify resolved path stays in backup dir
        $real = @realpath($file);
        if ($real === false || !is_file($real) || strncmp($real, $backupDir, strlen($backupDir)) !== 0) {
            http_response_code(404);
            exit('Backup not found');
        }

        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="logsviewer-' . $date . '.zip"');
        header('Content-Length: ' . filesize($real));
        header('Cache-Control: no-cache');
        readfile($real);
        exit;
    }

    // ── Alerts: Get rules ─────────────────────────────────────────────────

    private function replyAlertRules(): void
    {
        $path = '/boot/config/plugins/logsviewer/alerts-rules.json';
        $rules = is_file($path) ? @json_decode((string)@file_get_contents($path), true) : [];
        $this->json(['rules' => is_array($rules) ? $rules : []]);
    }

    // ── Alerts: Get history ───────────────────────────────────────────────

    private function replyAlertHistory(): void
    {
        $path = '/boot/config/plugins/logsviewer/alerts-history.json';
        $history = is_file($path) ? @json_decode((string)@file_get_contents($path), true) : [];
        $this->json(['history' => is_array($history) ? $history : []]);
    }

    // ── Alerts: Clear history ─────────────────────────────────────────────

    private function replyClearAlertHistory(): void
    {
        $path = '/boot/config/plugins/logsviewer/alerts-history.json';
        @file_put_contents($path, '[]', LOCK_EX);
        // Also clear cooldowns so alerts can re-trigger
        $cdPath = '/tmp/logsviewer_cache/alert_cooldowns.json';
        if (is_file($cdPath)) @file_put_contents($cdPath, '{}', LOCK_EX);
        $this->json(['cleared' => true]);
    }

    // ── Alerts: Run on-demand scan ────────────────────────────────────────

    private function replyRunAlertsScan(): void
    {
        // Lock to prevent concurrent scans (cron + manual + multiple manual)
        $lockPath = self::ALERTS_SCAN_LOCK;
        $fh = @fopen($lockPath, 'c');
        if ($fh === false) {
            $this->json(['error' => 'Could not create scan lock'], 500);
        }
        if (!@flock($fh, LOCK_EX | LOCK_NB)) {
            @fclose($fh);
            $this->json(['busy' => true, 'message' => 'A scan is already running. Try again in a moment.'], 409);
        }

        // Locate PHP binary (mirror logic from logsviewer-alerts.sh)
        $phpBin = '';
        foreach (['/usr/bin/php', '/usr/local/bin/php', '/usr/local/emhttp/plugins/dynamix/scripts/php'] as $candidate) {
            if (is_executable($candidate)) { $phpBin = $candidate; break; }
        }
        if ($phpBin === '') {
            @flock($fh, LOCK_UN); @fclose($fh);
            $this->json(['error' => 'PHP binary not found'], 500);
        }

        $script = self::ALERTS_SCAN_SCRIPT;
        if (!is_file($script)) {
            @flock($fh, LOCK_UN); @fclose($fh);
            $this->json(['error' => 'Scan script not found'], 500);
        }

        $cmd    = escapeshellcmd($phpBin) . ' -f ' . escapeshellarg($script) . ' 2>/dev/null';
        $output = (string)@shell_exec($cmd);
        $count  = (int)trim($output);

        @flock($fh, LOCK_UN); @fclose($fh);

        $this->json(['success' => true, 'new_alerts' => $count]);
    }

    // ── Alerts: Mutes ──────────────────────────────────────────────────────

    private function loadAlertMutes(): array
    {
        if (!is_file(self::ALERT_MUTES_FILE)) return [];
        $data = @json_decode((string)@file_get_contents(self::ALERT_MUTES_FILE), true);
        if (!is_array($data)) return [];
        $now = time();
        $changed = false;
        foreach ($data as $rid => $info) {
            if (!is_array($info)) { unset($data[$rid]); $changed = true; continue; }
            $exp = $info['expires'] ?? null;
            if ($exp === 'permanent') continue;
            if (!is_numeric($exp) || (int)$exp <= $now) {
                unset($data[$rid]);
                $changed = true;
            }
        }
        if ($changed) {
            @file_put_contents(self::ALERT_MUTES_FILE, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
        }
        return $data;
    }

    private function saveAlertMutes(array $mutes): void
    {
        @file_put_contents(self::ALERT_MUTES_FILE, json_encode($mutes, JSON_PRETTY_PRINT), LOCK_EX);
    }

    private function replyAlertMutes(): void
    {
        $this->json(['mutes' => $this->loadAlertMutes()]);
    }

    private function replySetAlertMute(): void
    {
        $ruleId   = (string)($_GET['rule_id'] ?? '');
        $duration = (string)($_GET['duration'] ?? '');

        if ($ruleId === '' || !preg_match('/^[A-Za-z0-9_.-]{1,64}$/', $ruleId)) {
            $this->json(['error' => 'Invalid rule_id'], 400);
        }

        $allowedDurations = ['1h' => 3600, '24h' => 86400, '7d' => 604800, 'permanent' => 0];
        if (!array_key_exists($duration, $allowedDurations)) {
            $this->json(['error' => 'Invalid duration'], 400);
        }

        $mutes = $this->loadAlertMutes();
        if ($duration === 'permanent') {
            $mutes[$ruleId] = ['expires' => 'permanent', 'created' => time()];
        } else {
            $mutes[$ruleId] = ['expires' => time() + $allowedDurations[$duration], 'created' => time()];
        }
        $this->saveAlertMutes($mutes);
        $this->json(['muted' => true, 'rule_id' => $ruleId, 'duration' => $duration]);
    }

    private function replyUnsetAlertMute(): void
    {
        $ruleId = (string)($_GET['rule_id'] ?? '');
        if ($ruleId === '' || !preg_match('/^[A-Za-z0-9_.-]{1,64}$/', $ruleId)) {
            $this->json(['error' => 'Invalid rule_id'], 400);
        }
        $mutes = $this->loadAlertMutes();
        if (isset($mutes[$ruleId])) {
            unset($mutes[$ruleId]);
            $this->saveAlertMutes($mutes);
        }
        $this->json(['unmuted' => true, 'rule_id' => $ruleId]);
    }

    // ── HTTP helpers ───────────────────────────────────────────────────────

    private function enforceAjaxGet(): void
    {
        if (!$this->isAjax()) { header('HTTP/1.1 403 Forbidden'); exit('Direct access not allowed'); }
        if ((string)($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') { header('HTTP/1.1 405 Method Not Allowed'); exit('Only GET'); }
        $this->enforceLocalOrigin();
    }

    /** Reject requests whose Origin/Referer points to a different host (CSRF via foreign page) */
    private function enforceLocalOrigin(): void
    {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        if ($host === '') return; // CLI / no-host: allow

        foreach (['HTTP_ORIGIN', 'HTTP_REFERER'] as $key) {
            $val = $_SERVER[$key] ?? '';
            if ($val === '') continue;
            $parsed = parse_url($val);
            $reqHost = ($parsed['host'] ?? '') . (isset($parsed['port']) ? ':' . $parsed['port'] : '');
            if ($reqHost !== '' && $reqHost !== $host) {
                header('HTTP/1.1 403 Forbidden');
                exit('Cross-origin requests not allowed');
            }
        }
    }

    private function isAjax(): bool
    {
        $hdrs = function_exists('getallheaders') ? (getallheaders() ?: []) : [];
        $xrw  = $hdrs['X-Requested-With'] ?? $hdrs['x-requested-with'] ?? ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? null);
        return $xrw === 'XMLHttpRequest';
    }

    private function json($payload, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json');
        header('Cache-Control: no-cache, must-revalidate');
        header('Expires: Mon, 26 Jul 1997 05:00:00 GMT');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
        header("Content-Security-Policy: default-src 'none'");
        header('Permissions-Policy: geolocation=(), camera=(), microphone=()');
        echo json_encode($payload);
        exit;
    }

    // ── File I/O ───────────────────────────────────────────────────────────

    private function openSnapshot(string $path): array
    {
        if (!is_file($path) || !is_readable($path)) return [null, null];
        $fh = @fopen($path, 'rb');
        if (!$fh) return [null, null];
        $st   = @fstat($fh);
        $size = (is_array($st) && isset($st['size']) && is_int($st['size'])) ? max(0, $st['size']) : null;
        return [$fh, $size];
    }

    private function countLinesInText(string $text): int
    {
        $t = trim(str_replace(["\r\n", "\r"], "\n", $text));
        return ($t === '') ? 0 : substr_count($t, "\n") + 1;
    }

    private function tailFromSnapshot($fh, ?int $snapSize, int $lines): string
    {
        if ($snapSize === null) {
            @rewind($fh);
            $data = stream_get_contents($fh, self::FORWARD_FALLBACK_CAP_BYTES);
            if ($data === false || trim((string)$data) === '') return "Log is empty.";
            $data = str_replace(["\r\n", "\r"], "\n", (string)$data);
            $all  = explode("\n", $data);
            if (end($all) === '') array_pop($all);
            return implode("\n", array_slice($all, -$lines));
        }

        $pos = $snapSize; $readBytes = 0; $carry = ''; $collected = [];
        while ($pos > 0 && count($collected) <= $lines) {
            $take = min(8192, $pos); $pos -= $take;
            if (@fseek($fh, $pos, SEEK_SET) !== 0) break;
            $data = fread($fh, $take);
            if ($data === false) return "Log exists but could not be read.";
            $readBytes += $take;
            $block  = $data . $carry;
            $norm   = str_replace(["\r\n", "\r"], "\n", $block);
            $parts  = explode("\n", $norm);
            $carry  = array_shift($parts) ?? '';
            if ($parts) {
                $collected = array_merge($parts, $collected);
                if (count($collected) > $lines + 10) $collected = array_slice($collected, -($lines + 10));
            }
            if ($readBytes >= self::BACKREAD_CAP_BYTES) break;
        }

        while ($collected && end($collected) === '') array_pop($collected);
        if (!$collected) return "Log is empty.";
        return implode("\n", array_slice($collected, -$lines));
    }

    private function countLinesFromSnapshot($fh, ?int $snapSize): ?int
    {
        if ($snapSize === null) {
            @rewind($fh);
            $data = stream_get_contents($fh, self::FORWARD_FALLBACK_CAP_BYTES);
            if ($data === false) return null;
            $count   = substr_count($data, "\n");
            $trimmed = rtrim($data, "\r\n");
            if ($trimmed !== '' && substr($data, -1) !== "\n") $count++;
            elseif ($trimmed === '') $count = 0;
            return $count;
        }
        if ($snapSize === 0) return 0;

        $count = 0; $remaining = $snapSize; @rewind($fh);
        while ($remaining > 0) {
            $toRead = min(self::COUNT_READ_BUF, $remaining);
            $chunk  = fread($fh, $toRead);
            if ($chunk === false) return null;
            $count     += substr_count($chunk, "\n");
            $remaining -= strlen($chunk);
            if ($chunk === '' && $remaining > 0) break;
        }
        if (@fseek($fh, $snapSize - 1, SEEK_SET) === 0) {
            $last = fread($fh, 1);
            if ($last !== "\n") $count++;
        }
        return $count;
    }

    /**
     * Security: Build VM log path and verify it stays within the allowed directory.
     * Returns null if the path would escape /var/log/libvirt/qemu/.
     */
    private function safeVmLogPath(string $vmName): ?string
    {
        $base = '/var/log/libvirt/qemu/';
        $path = $base . $vmName . '.log';
        $real = @realpath($path);
        // If file doesn't exist yet, validate the directory component
        if ($real === false) {
            // Ensure no directory traversal characters snuck through
            if (strpos($vmName, '..') !== false || strpos($vmName, '/') !== false || strpos($vmName, '\\') !== false) {
                return null;
            }
            return $path;
        }
        // File exists: verify it resolves within the allowed directory
        if (strncmp($real, $base, strlen($base)) !== 0) return null;
        return $real;
    }

    /**
     * Fix #1: Fast line count using native wc -l (C-speed) for local files.
     * Falls back to PHP stream counting if wc is unavailable or fails.
     */
    private function fastCountLines(string $path, $fh = null, ?int $snapSize = null): ?int
    {
        if ($path !== '' && is_file($path) && is_readable($path)) {
            $out = @shell_exec('wc -l < ' . escapeshellarg($path) . ' 2>/dev/null');
            if ($out !== null && $out !== false) {
                $n = (int)trim($out);
                // wc -l counts newlines; if file doesn't end with \n, add 1
                $lastByte = @file_get_contents($path, false, null, max(0, filesize($path) - 1), 1);
                if ($lastByte !== false && $lastByte !== '' && $lastByte !== "\n") $n++;
                return max(0, $n);
            }
        }
        // Fallback: PHP stream counting (original method)
        if ($fh !== null) return $this->countLinesFromSnapshot($fh, $snapSize);
        return null;
    }

    // Cache function availability checks (called 5+ times per request)
    private static ?bool $_hasMbCheck = null;
    private static ?bool $_hasMbConvert = null;

    private function forceValidUtf8(string $s): string
    {
        if ($s === '') return $s;
        if (self::$_hasMbCheck === null) self::$_hasMbCheck = function_exists('mb_check_encoding');
        if (self::$_hasMbCheck && mb_check_encoding($s, 'UTF-8')) return $s;
        if (self::$_hasMbConvert === null) self::$_hasMbConvert = function_exists('mb_convert_encoding');
        if (self::$_hasMbConvert) return mb_convert_encoding($s, 'UTF-8', 'UTF-8');
        if (function_exists('iconv')) {
            $out = @iconv('UTF-8', 'UTF-8//IGNORE', $s);
            if ($out !== false && $out !== null) return (string)$out;
        }
        return preg_replace('/[^\P{C}\n\t\r]+/u', '', $s) ?? $s;
    }

    // ── Micro-cache ────────────────────────────────────────────────────────

    private function computeMicroCacheMs(array $cfg): int
    {
        if ((string)($cfg['REFRESH_ENABLED'] ?? '1') !== '1') return 0;
        $intervalS = (int)($cfg['REFRESH_INTERVAL'] ?? 0);
        $ms = ($intervalS <= 0) ? 500 : (int)round($intervalS * 1000 * 0.25);
        return max(self::MICRO_CACHE_MIN_MS, min(self::MICRO_CACHE_MAX_MS, $ms));
    }

    private function cacheKey(array $cfg): string
    {
        $category  = (string)($_GET['category'] ?? 'system');
        $ctx       = $this->isToolContext() ? 'tool' : 'dash';
        $sysKey    = $this->isToolContext() ? 'TOOL_ENABLED_SYSTEM_LOGS'       : 'DASH_ENABLED_SYSTEM_LOGS';
        $dockerKey = $this->isToolContext() ? 'TOOL_ENABLED_DOCKER_CONTAINERS' : 'DASH_ENABLED_DOCKER_CONTAINERS';
        $vmKey     = $this->isToolContext() ? 'TOOL_ENABLED_VMS'               : 'DASH_ENABLED_VMS';
        $customKey = $this->isToolContext() ? 'TOOL_ENABLED_CUSTOM_LOGS'       : 'DASH_ENABLED_CUSTOM_LOGS';
        $source    = (string)($_GET['source'] ?? '');
        $normTs    = (($_GET['_normts'] ?? '') === '1') ? '1' : '0';
        return hash('sha256', implode('|', [
            'states', $category, $ctx, $source, $normTs,
            (string)($cfg[$sysKey] ?? ''),
            (string)($cfg[$dockerKey] ?? ''),
            (string)($cfg[$vmKey] ?? ''),
            (string)($cfg[$customKey] ?? ''),
            (string)($cfg['REFRESH_ENABLED'] ?? ''),
            (string)($cfg['REFRESH_INTERVAL'] ?? ''),
        ]));
    }

    private function cachePath(string $key): string { return self::CACHE_DIR . '/resp_' . $key . '.json'; }

    private function cacheGet(array $cfg, int $cacheMs): ?string
    {
        $path = $this->cachePath($this->cacheKey($cfg));
        if (!is_dir(self::CACHE_DIR)) return null;
        $st = @stat($path);
        if (!is_array($st) || !isset($st['mtime'])) return null;
        if ((int)round((microtime(true) - (float)$st['mtime']) * 1000) > $cacheMs) return null;
        $json = @file_get_contents($path);
        return ($json === false || $json === '') ? null : $json;
    }

    private function cachePut(array $cfg, string $json): void
    {
        if (!is_dir(self::CACHE_DIR)) @mkdir(self::CACHE_DIR, 0755, true);
        $path = $this->cachePath($this->cacheKey($cfg));
        $tmp  = $path . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $json, LOCK_EX) !== false) @rename($tmp, $path);
        else @unlink($tmp);

        // Stale cache cleanup (1% chance per request)
        if (mt_rand(1, 100) !== 1) return;
        $now   = time();
        $files = @glob(self::CACHE_DIR . '/resp_*.json');
        if (!is_array($files)) return;
        foreach ($files as $f) {
            $st = @stat($f);
            if (is_array($st) && isset($st['mtime']) && ($now - (int)$st['mtime']) > 10) @unlink($f);
        }
    }

    // ── Saved Filters ──────────────────────────────────────────────────────
    // CRUD for filter presets stored in /boot/config/plugins/logsviewer/saved-filters.json.
    // Each filter:
    //   id, name, sources[], level, pattern, is_regex,
    //   created_at, updated_at, last_run_at, last_match_count, alert_rule_id

    private const SAVED_FILTERS_FILE = '/boot/config/plugins/logsviewer/saved-filters.json';
    private const ALERT_RULES_FILE   = '/boot/config/plugins/logsviewer/alerts-rules.json';

    private function readSavedFilters(): array
    {
        if (!is_file(self::SAVED_FILTERS_FILE)) return [];
        $raw = @file_get_contents(self::SAVED_FILTERS_FILE);
        $arr = @json_decode((string)$raw, true);
        return is_array($arr) ? $arr : [];
    }

    private function writeSavedFilters(array $filters): bool
    {
        $dir = dirname(self::SAVED_FILTERS_FILE);
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        $tmp = self::SAVED_FILTERS_FILE . '.tmp';
        $json = json_encode($filters, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) return false;
        if (@file_put_contents($tmp, $json, LOCK_EX) === false) return false;
        return @rename($tmp, self::SAVED_FILTERS_FILE);
    }

    private function readAlertRules(): array
    {
        if (!is_file(self::ALERT_RULES_FILE)) return [];
        $raw = @file_get_contents(self::ALERT_RULES_FILE);
        $arr = @json_decode((string)$raw, true);
        return is_array($arr) ? $arr : [];
    }

    private function writeAlertRules(array $rules): bool
    {
        $dir = dirname(self::ALERT_RULES_FILE);
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        $tmp = self::ALERT_RULES_FILE . '.tmp';
        $json = json_encode($rules, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) return false;
        if (@file_put_contents($tmp, $json, LOCK_EX) === false) return false;
        return @rename($tmp, self::ALERT_RULES_FILE);
    }

    private function genFilterId(): string
    {
        return 'lvf_' . substr(bin2hex(random_bytes(6)), 0, 10);
    }

    private function validateFilterInput(array $in): array
    {
        // Returns [valid?, errors[], cleaned[]]
        $errors = [];
        $name = trim((string)($in['name'] ?? ''));
        if ($name === '' || strlen($name) > 80) {
            $errors[] = 'Name is required (max 80 characters).';
        }

        $sources = $in['sources'] ?? [];
        if (!is_array($sources)) $sources = [];
        $sources = array_values(array_filter(array_map(function ($s) {
            $s = trim((string)$s);
            return preg_match('/^[a-zA-Z0-9 ._:-]{1,64}$/', $s) ? $s : null;
        }, $sources)));
        if (empty($sources)) $errors[] = 'Pick at least one source.';

        $level = (string)($in['level'] ?? 'all');
        if (!in_array($level, ['all', 'critical', 'error', 'warning', 'info', 'only-info', 'only-warning', 'only-error'], true)) {
            $level = 'all';
        }

        $pattern = (string)($in['pattern'] ?? '');
        if ($pattern === '' || strlen($pattern) > 500) {
            $errors[] = 'Pattern is required (max 500 characters).';
        }

        $isRegex = !empty($in['is_regex']);
        if ($isRegex && $pattern !== '') {
            // Validate the regex compiles
            $test = @preg_match('/' . str_replace('/', '\/', $pattern) . '/', '');
            if ($test === false) $errors[] = 'Regex pattern is invalid.';
        }

        return [
            empty($errors),
            $errors,
            [
                'name'     => $name,
                'sources'  => $sources,
                'level'    => $level,
                'pattern'  => $pattern,
                'is_regex' => $isRegex,
            ],
        ];
    }

    private function replyGetSavedFilters(): void
    {
        $filters = $this->readSavedFilters();
        // Decorate with whether the linked alert rule still exists
        if (!empty($filters)) {
            $ruleIds = array_column($this->readAlertRules(), 'id');
            $ruleSet = array_flip($ruleIds);
            foreach ($filters as &$f) {
                if (!empty($f['alert_rule_id']) && !isset($ruleSet[$f['alert_rule_id']])) {
                    $f['alert_rule_id'] = null; // orphan link cleaned up
                }
            }
            unset($f);
        }
        $this->json(['filters' => $filters]);
    }

    private function replySaveFilter(): void
    {
        // Accept POST or GET (GET kept simple for now since other actions use GET)
        $body = $_POST;
        if (empty($body) && !empty($_GET['payload'])) {
            $body = @json_decode((string)$_GET['payload'], true) ?: [];
        }
        if (empty($body)) {
            $raw = @file_get_contents('php://input');
            $body = @json_decode((string)$raw, true) ?: [];
        }

        [$ok, $errs, $clean] = $this->validateFilterInput($body);
        if (!$ok) $this->json(['error' => implode(' ', $errs)], 400);

        $id  = (string)($body['id'] ?? '');
        $now = time();

        $filters = $this->readSavedFilters();
        if ($id !== '') {
            // Update
            $found = false;
            foreach ($filters as &$f) {
                if (($f['id'] ?? '') === $id) {
                    $f['name']     = $clean['name'];
                    $f['sources']  = $clean['sources'];
                    $f['level']    = $clean['level'];
                    $f['pattern']  = $clean['pattern'];
                    $f['is_regex'] = $clean['is_regex'];
                    $f['updated_at'] = $now;
                    $found = true;
                    break;
                }
            }
            unset($f);
            if (!$found) $this->json(['error' => 'Filter not found.'], 404);
        } else {
            // Create
            $id = $this->genFilterId();
            $filters[] = array_merge($clean, [
                'id'                => $id,
                'created_at'        => $now,
                'updated_at'        => $now,
                'last_run_at'       => null,
                'last_match_count'  => null,
                'alert_rule_id'     => null,
            ]);
        }

        if (!$this->writeSavedFilters($filters)) {
            $this->json(['error' => 'Failed to write saved filters file.'], 500);
        }
        $this->json(['saved' => true, 'id' => $id]);
    }

    private function replyDeleteFilter(): void
    {
        $id = trim((string)($_GET['id'] ?? ''));
        if ($id === '' || !preg_match('/^lvf_[a-z0-9]{6,16}$/', $id)) {
            $this->json(['error' => 'Invalid filter id.'], 400);
        }
        $filters = $this->readSavedFilters();
        $out = [];
        $found = false;
        foreach ($filters as $f) {
            if (($f['id'] ?? '') === $id) { $found = true; continue; }
            $out[] = $f;
        }
        if (!$found) $this->json(['error' => 'Filter not found.'], 404);
        if (!$this->writeSavedFilters($out)) {
            $this->json(['error' => 'Failed to write saved filters file.'], 500);
        }
        $this->json(['deleted' => true]);
    }

    private function replyConvertFilterToAlert(): void
    {
        $id = trim((string)($_GET['id'] ?? ''));
        if ($id === '' || !preg_match('/^lvf_[a-z0-9]{6,16}$/', $id)) {
            $this->json(['error' => 'Invalid filter id.'], 400);
        }

        $filters = $this->readSavedFilters();
        $filter = null; $fIdx = -1;
        foreach ($filters as $i => $f) { if (($f['id'] ?? '') === $id) { $filter = $f; $fIdx = $i; break; } }
        if ($filter === null) $this->json(['error' => 'Filter not found.'], 404);

        if (!empty($filter['alert_rule_id'])) {
            // Already converted; verify the rule still exists
            $rules = $this->readAlertRules();
            foreach ($rules as $r) if (($r['id'] ?? '') === $filter['alert_rule_id']) {
                $this->json(['already' => true, 'rule_id' => $r['id']]);
            }
            // Stale link — clear and re-create below
        }

        // Build the alert rule. Level maps to severity; the "only-X" single-
        // severity filters map straight to their underlying severity, and the
        // catch-all 'all' falls back to 'warning' (alerts can't be all-levels).
        $levelToSev = [
            'all'          => 'warning',
            'critical'     => 'critical',
            'error'        => 'error',
            'warning'      => 'warning',
            'info'         => 'info',
            'only-info'    => 'info',
            'only-warning' => 'warning',
            'only-error'   => 'error',
        ];
        $sev = $levelToSev[$filter['level']] ?? 'warning';
        $newRule = [
            'id'        => 'lvr_' . substr(bin2hex(random_bytes(6)), 0, 10),
            'name'      => $filter['name'],
            'enabled'   => true,
            'pattern'   => $filter['pattern'],
            'is_regex'  => !empty($filter['is_regex']),
            'severity'  => $sev,
            'sources'   => $filter['sources'],
            'cooldown'  => 300, // sensible default: 5 minutes
            'tags'      => [],
            'created_at'=> time(),
            'origin'    => 'saved_filter:' . $filter['id'],
        ];

        $rules = $this->readAlertRules();
        $rules[] = $newRule;
        if (!$this->writeAlertRules($rules)) {
            $this->json(['error' => 'Failed to write alert rules file.'], 500);
        }

        // Link the filter back to the new rule
        $filters[$fIdx]['alert_rule_id'] = $newRule['id'];
        $filters[$fIdx]['updated_at']    = time();
        $this->writeSavedFilters($filters);

        $this->json(['created' => true, 'rule_id' => $newRule['id'], 'rule_name' => $newRule['name']]);
    }

    // ── Pinned Lines ───────────────────────────────────────────────────────
    // Bookmarked log lines from any source. Storage:
    //   /boot/config/plugins/logsviewer/pinned-lines.json
    // Schema per entry:
    //   id, category, source, source_label, line, note, pinned_at
    // Capped at 200 entries to keep the file small.

    private const PINNED_FILE     = '/boot/config/plugins/logsviewer/pinned-lines.json';
    private const PINNED_MAX      = 200;
    private const PINNED_LINE_MAX = 1500; // truncate very long lines

    private function readPinnedLines(): array
    {
        if (!is_file(self::PINNED_FILE)) return [];
        $raw = @file_get_contents(self::PINNED_FILE);
        $arr = @json_decode((string)$raw, true);
        return is_array($arr) ? $arr : [];
    }

    private function writePinnedLines(array $pins): bool
    {
        $dir = dirname(self::PINNED_FILE);
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        $tmp = self::PINNED_FILE . '.tmp';
        $json = json_encode($pins, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) return false;
        if (@file_put_contents($tmp, $json, LOCK_EX) === false) return false;
        return @rename($tmp, self::PINNED_FILE);
    }

    private function genPinId(): string
    {
        return 'lvp_' . substr(bin2hex(random_bytes(6)), 0, 10);
    }

    private function replyGetPinnedLines(): void
    {
        $pins = $this->readPinnedLines();
        // Newest first
        usort($pins, fn($a, $b) => ((int)($b['pinned_at'] ?? 0)) <=> ((int)($a['pinned_at'] ?? 0)));
        $this->json(['pins' => $pins]);
    }

    private function replyPinLine(): void
    {
        // Accept POST (preferred) or GET with payload
        $body = $_POST;
        if (empty($body)) {
            $raw = @file_get_contents('php://input');
            $body = @json_decode((string)$raw, true) ?: [];
        }

        $category    = strtolower(trim((string)($body['category'] ?? '')));
        $source      = trim((string)($body['source'] ?? ''));
        $sourceLabel = trim((string)($body['source_label'] ?? $source));
        $line        = (string)($body['line'] ?? '');
        $note        = trim((string)($body['note'] ?? ''));

        // Validate
        if (!in_array($category, ['system', 'docker', 'vm', 'custom'], true)) {
            $this->json(['error' => 'Invalid category.'], 400);
        }
        if ($source === '' || !preg_match('/^[a-zA-Z0-9 ._:-]{1,64}$/', $source)) {
            $this->json(['error' => 'Invalid source.'], 400);
        }
        if ($line === '') $this->json(['error' => 'Line cannot be empty.'], 400);

        // Truncate very long lines
        if (strlen($line) > self::PINNED_LINE_MAX) {
            $line = substr($line, 0, self::PINNED_LINE_MAX) . '…';
        }
        if (strlen($note) > 200) $note = substr($note, 0, 200);
        if (strlen($sourceLabel) > 80) $sourceLabel = substr($sourceLabel, 0, 80);

        $pins = $this->readPinnedLines();

        // Dedupe: same source + same line text → return existing
        foreach ($pins as $p) {
            if (($p['source'] ?? '') === $source && ($p['line'] ?? '') === $line) {
                $this->json(['already' => true, 'id' => $p['id']]);
            }
        }

        // Cap: drop oldest if at limit
        if (count($pins) >= self::PINNED_MAX) {
            usort($pins, fn($a, $b) => ((int)($a['pinned_at'] ?? 0)) <=> ((int)($b['pinned_at'] ?? 0)));
            array_shift($pins);
        }

        $entry = [
            'id'           => $this->genPinId(),
            'category'     => $category,
            'source'       => $source,
            'source_label' => $sourceLabel !== '' ? $sourceLabel : $source,
            'line'         => $line,
            'note'         => $note,
            'pinned_at'    => time(),
        ];
        $pins[] = $entry;

        if (!$this->writePinnedLines($pins)) {
            $this->json(['error' => 'Failed to write pinned lines file.'], 500);
        }
        $this->json(['pinned' => true, 'id' => $entry['id']]);
    }

    private function replyUnpinLine(): void
    {
        $id = trim((string)($_GET['id'] ?? ''));
        if ($id === '' || !preg_match('/^lvp_[a-z0-9]{6,16}$/', $id)) {
            $this->json(['error' => 'Invalid pin id.'], 400);
        }
        $pins = $this->readPinnedLines();
        $out = [];
        $found = false;
        foreach ($pins as $p) {
            if (($p['id'] ?? '') === $id) { $found = true; continue; }
            $out[] = $p;
        }
        if (!$found) $this->json(['error' => 'Pin not found.'], 404);
        if (!$this->writePinnedLines($out)) {
            $this->json(['error' => 'Failed to write pinned lines file.'], 500);
        }
        $this->json(['unpinned' => true]);
    }

    private function replyClearPinnedLines(): void
    {
        if (!$this->writePinnedLines([])) {
            $this->json(['error' => 'Failed to write pinned lines file.'], 500);
        }
        $this->json(['cleared' => true]);
    }
}

// Only execute when accessed directly (not when require_once'd by a page file)
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    (new LogsViewerEndpoint())->run();
}