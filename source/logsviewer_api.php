<?php
declare(strict_types=1);

require_once '/usr/local/emhttp/plugins/dynamix/include/Helpers.php';

final class LogsViewerEndpoint
{
    // ── Constants ──────────────────────────────────────────────────────────
    private const HARD_MAX_LINES          = 5000;
    private const BACKREAD_CAP_BYTES      = 1048576; // 1 MB
    private const FORWARD_FALLBACK_CAP_BYTES = 1048576;
    private const COUNT_READ_BUF          = 65536;   // 64 KB
    private const MICRO_CACHE_MIN_MS      = 150;
    private const MICRO_CACHE_MAX_MS      = 800;
    private const CACHE_DIR               = '/tmp/logsviewer_cache';
    private const NONCE_FILE              = '/tmp/logsviewer_cache/nonce';
    private const NONCE_TTL               = 3600; // 1 hour
    private const RATE_LIMIT_FILE         = '/tmp/logsviewer_cache/rl';
    private const RATE_LIMIT_MAX          = 60;   // max requests per minute per IP

    private const SYSTEM_LOGS = [
        'syslog'          => '/var/log/syslog',
        'dmesg'           => '/var/log/dmesg',
        'graphql-api.log' => '/var/log/graphql-api.log',
        'nginx-error'     => '/var/log/nginx/error.log',
        'phplog'          => '/var/log/phplog',
        'libvirt'         => '/var/log/libvirt/libvirtd.log',
    ];

    private const SYSTEM_LOG_NAMES = [
        'syslog'          => 'Syslog',
        'dmesg'           => 'Dmesg',
        'graphql-api.log' => 'GraphQL API',
        'nginx-error'     => 'Nginx Errors',
        'phplog'          => 'PHP Log',
        'libvirt'         => 'Libvirt',
    ];

    public function __construct()
    {
        if (!is_dir(self::CACHE_DIR)) {
            @mkdir(self::CACHE_DIR, 0700, true);
        }
    }

    // ── Nonce (CSRF token) ────────────────────────────────────────────────

    /** Generate or return existing nonce (stored in a temp file, rotated hourly) */
    public static function generateNonce(): string
    {
        if (!is_dir(self::CACHE_DIR)) @mkdir(self::CACHE_DIR, 0700, true);
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
        $this->enforceAjaxGet();
        $this->verifyNonce();
        $this->enforceRateLimit();

        $action = (string)($_GET['action'] ?? '');
        $routes = [
            'get_script_states'     => fn() => $this->replyStates(),
            'discover_sources'      => fn() => $this->replyDiscoverSources(),
            'get_docker_containers' => fn() => $this->replyDockerContainers(),
            'get_docker_log'        => fn() => $this->replyDockerLog(),
            'get_vm_list'           => fn() => $this->replyVmList(),
            'get_vm_log'            => fn() => $this->replyVmLog(),
        ];

        if (!isset($routes[$action])) {
            $this->json(['error' => 'Invalid action'], 400);
        }

        $routes[$action]();
    }

    // ── Context helpers ────────────────────────────────────────────────────

    private function getContext(): string
    {
        $c = (string)($_GET['context'] ?? 'dash');
        return ($c === 'tool') ? 'tool' : 'dash';
    }

    private function isToolContext(): bool
    {
        return $this->getContext() === 'tool';
    }

    // ── Config helpers ─────────────────────────────────────────────────────

    /** One-time migration from legacy global keys → DASH_* keys */
    private function migrateDashIfNeeded(array &$cfg): void
    {
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
        $cfg     = parse_plugin_cfg('logsviewer', true);
        $context = $this->getContext();
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);

        $sysKey        = ($context === 'tool') ? 'TOOL_ENABLED_SYSTEM_LOGS' : 'DASH_ENABLED_SYSTEM_LOGS';
        $hasSystemCfg  = array_key_exists($sysKey, $cfg);
        $enabledSystem = $this->getEnabledSystem($cfg, $context);
        $enabledDocker = $this->getEnabledDocker($cfg, $context);
        $enabledVms    = $this->getEnabledVms($cfg, $context);
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
        ]);
    }

    // ── Docker ─────────────────────────────────────────────────────────────

    private function isDockerAvailable(): bool
    {
        return !empty(trim((string)@shell_exec('which docker 2>/dev/null')));
    }

    private function getDockerContainerList(): array
    {
        $output = @shell_exec('docker ps -a --format "{{.Names}}\t{{.State}}\t{{.ID}}" 2>/dev/null');
        if (empty($output)) return [];

        $containers = [];
        foreach (array_filter(explode("\n", trim($output))) as $line) {
            $parts = explode("\t", $line);
            if (count($parts) < 3) continue;
            $name    = trim($parts[0]);
            $state   = trim($parts[1]);
            $id      = trim($parts[2]);
            $logPath = trim((string)@shell_exec('docker inspect --format=\'{{.LogPath}}\' ' . escapeshellarg($name) . ' 2>/dev/null'));
            $containers[] = [
                'name'     => $name,
                'status'   => $state,
                'id'       => $id,
                'log_size' => ($logPath && is_file($logPath)) ? (int)@filesize($logPath) : 0,
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

        $cfg      = parse_plugin_cfg('logsviewer', true);
        $maxLines = $this->getMaxLines($cfg);
        $rawLog   = $this->forceValidUtf8((string)@shell_exec(
            'docker logs --tail ' . $maxLines . ' ' . escapeshellarg($container) . ' 2>&1'
        ));

        $this->json([['name' => $container, 'display_name' => $container, 'status' => 'idle',
            'log'         => htmlspecialchars(trim($rawLog), ENT_QUOTES, 'UTF-8'),
            'total_lines' => $this->countLinesInText($rawLog),
            'shown_lines' => $this->countLinesInText($rawLog),
            'max_lines'   => $maxLines, 'source' => 'docker',
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

        $vms = [];
        foreach (array_filter(explode("\n", trim($output)), fn($v) => trim($v) !== '') as $name) {
            $name    = trim($name);
            $logPath = '/var/log/libvirt/qemu/' . $name . '.log';
            $vms[]   = [
                'name'     => $name,
                'status'   => trim((string)@shell_exec('virsh domstate ' . escapeshellarg($name) . ' 2>/dev/null')) ?: 'unknown',
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

        $cfg      = parse_plugin_cfg('logsviewer', true);
        $maxLines = $this->getMaxLines($cfg);
        $logPath  = '/var/log/libvirt/qemu/' . $vmName . '.log';

        if (!is_file($logPath) || !is_readable($logPath)) {
            $this->json([['name' => $vmName, 'display_name' => $vmName, 'status' => 'idle',
                'log' => 'No log file found for this VM.', 'total_lines' => 0, 'shown_lines' => 0, 'max_lines' => 0, 'source' => 'vm',
            ]]);
        }

        [$fh, $snapSize] = $this->openSnapshot($logPath);
        if ($fh === null) {
            $text = "VM log not readable: {$logPath}"; $total = null;
        } elseif ($snapSize === 0) {
            fclose($fh); $text = "VM log is empty."; $total = 0;
        } else {
            $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
            $total = $this->countLinesFromSnapshot($fh, $snapSize);
            fclose($fh);
        }

        $text = $this->forceValidUtf8($text);
        $this->json([['name' => $vmName, 'display_name' => $vmName, 'status' => 'idle',
            'log'         => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
            'total_lines' => $total,
            'shown_lines' => $this->countLinesInText($text),
            'max_lines'   => $maxLines, 'source' => 'vm',
        ]]);
    }

    // ── Main log fetch (category-aware) ────────────────────────────────────

    private function replyStates(): void
    {
        $cfg     = parse_plugin_cfg('logsviewer', true);
        $cacheMs = $this->computeMicroCacheMs($cfg);

        if ($cacheMs > 0) {
            $cached = $this->cacheGet($cfg, $cacheMs);
            if ($cached !== null) {
                http_response_code(200);
                header('Content-Type: application/json');
                header('Cache-Control: no-cache, must-revalidate');
                header('Expires: Mon, 26 Jul 1997 05:00:00 GMT');
                echo $cached;
                exit;
            }
        }

        $context  = $this->getContext();
        if ($context === 'dash') $this->migrateDashIfNeeded($cfg);
        $category = (string)($_GET['category'] ?? 'system');

        if ($category === 'docker') {
            $rows = $this->fetchDockerLogs($cfg, $context);
        } elseif ($category === 'vm') {
            $rows = $this->fetchVmLogs($cfg, $context);
        } else {
            $rows = $this->fetchSystemLogs($cfg, $context);
        }

        $jsonOut = json_encode($rows);
        if ($cacheMs > 0 && $jsonOut !== false) {
            $this->cachePut($cfg, (string)$jsonOut);
        }

        $this->json($rows, 200);
    }

    private function fetchSystemLogs(array $cfg, string $context): array
    {
        $labels   = $this->getEnabledSystem($cfg, $context);
        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        foreach ($labels as $label) {
            $path = self::SYSTEM_LOGS[$label] ?? null;
            if ($path === null) continue;

            [$fh, $snapSize] = $this->openSnapshot($path);
            if ($fh === null) {
                $text = "Log file not found or not readable: {$path}"; $total = null;
            } elseif ($snapSize === 0) {
                fclose($fh); $text = "Log is empty."; $total = 0;
            } else {
                $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
                $total = $this->countLinesFromSnapshot($fh, $snapSize);
                fclose($fh);
            }

            $text   = $this->forceValidUtf8($text);
            $rows[] = [
                'name'         => $label,
                'display_name' => self::SYSTEM_LOG_NAMES[$label] ?? $label,
                'status'       => 'idle',
                'log'          => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $total,
                'shown_lines'  => $this->countLinesInText($text),
                'max_lines'    => $maxLines,
                'source'       => 'system',
            ];
        }

        return $rows;
    }

    private function fetchDockerLogs(array $cfg, string $context): array
    {
        $enabled = $this->getEnabledDocker($cfg, $context);
        if (empty($enabled) || !$this->isDockerAvailable()) return [];

        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        foreach ($enabled as $container) {
            if (!preg_match('/^[a-zA-Z0-9._-]{1,64}$/', $container)) continue;
            $rawLog = $this->forceValidUtf8((string)@shell_exec(
                'docker logs --tail ' . $maxLines . ' ' . escapeshellarg($container) . ' 2>&1'
            ));
            $rows[] = [
                'name'         => $container,
                'display_name' => $container,
                'status'       => 'idle',
                'log'          => htmlspecialchars(trim($rawLog), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $this->countLinesInText($rawLog),
                'shown_lines'  => $this->countLinesInText($rawLog),
                'max_lines'    => $maxLines,
                'source'       => 'docker',
            ];
        }

        return $rows;
    }

    private function fetchVmLogs(array $cfg, string $context): array
    {
        $enabled = $this->getEnabledVms($cfg, $context);
        if (empty($enabled) || !$this->isVirshAvailable()) return [];

        $maxLines = $this->getMaxLines($cfg);
        $rows     = [];

        foreach ($enabled as $vmName) {
            if (!preg_match('/^[a-zA-Z0-9 ._-]{1,64}$/', $vmName)) continue;
            $logPath = '/var/log/libvirt/qemu/' . $vmName . '.log';

            [$fh, $snapSize] = $this->openSnapshot($logPath);
            if ($fh === null) {
                $text = "No log file for VM: {$vmName}"; $total = null;
            } elseif ($snapSize === 0) {
                fclose($fh); $text = "VM log is empty."; $total = 0;
            } else {
                $text  = $this->tailFromSnapshot($fh, $snapSize, $maxLines);
                $total = $this->countLinesFromSnapshot($fh, $snapSize);
                fclose($fh);
            }

            $text   = $this->forceValidUtf8($text);
            $rows[] = [
                'name'         => $vmName,
                'display_name' => $vmName,
                'status'       => 'idle',
                'log'          => htmlspecialchars(trim($text), ENT_QUOTES, 'UTF-8'),
                'total_lines'  => $total,
                'shown_lines'  => $this->countLinesInText($text),
                'max_lines'    => $maxLines,
                'source'       => 'vm',
            ];
        }

        return $rows;
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

    private function forceValidUtf8(string $s): string
    {
        if ($s === '') return $s;
        if (function_exists('mb_check_encoding') && mb_check_encoding($s, 'UTF-8')) return $s;
        if (function_exists('mb_convert_encoding')) return mb_convert_encoding($s, 'UTF-8', 'UTF-8');
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
        $ms = ($intervalS <= 0) ? 250 : (int)round($intervalS * 1000 * 0.15);
        return max(self::MICRO_CACHE_MIN_MS, min(self::MICRO_CACHE_MAX_MS, $ms));
    }

    private function cacheKey(array $cfg): string
    {
        $category  = (string)($_GET['category'] ?? 'system');
        $ctx       = $this->isToolContext() ? 'tool' : 'dash';
        $sysKey    = $this->isToolContext() ? 'TOOL_ENABLED_SYSTEM_LOGS'       : 'DASH_ENABLED_SYSTEM_LOGS';
        $dockerKey = $this->isToolContext() ? 'TOOL_ENABLED_DOCKER_CONTAINERS' : 'DASH_ENABLED_DOCKER_CONTAINERS';
        $vmKey     = $this->isToolContext() ? 'TOOL_ENABLED_VMS'               : 'DASH_ENABLED_VMS';
        return hash('sha256', implode('|', [
            'states', $category, $ctx,
            (string)($cfg[$sysKey] ?? ''),
            (string)($cfg[$dockerKey] ?? ''),
            (string)($cfg[$vmKey] ?? ''),
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
        if (!is_dir(self::CACHE_DIR)) @mkdir(self::CACHE_DIR, 0700, true);
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
            if (is_array($st) && isset($st['mtime']) && ($now - (int)$st['mtime']) > 5) @unlink($f);
        }
    }
}

// Only execute when accessed directly (not when require_once'd by a page file)
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    (new LogsViewerEndpoint())->run();
}