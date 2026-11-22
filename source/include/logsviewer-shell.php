<?php
/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

if (!function_exists('lv_bin')) {
    function lv_bin(string $name): string {
        static $found = [];
        if (!isset($found[$name])) {
            $found[$name] = '/usr/bin/' . $name;
            foreach (['/usr/local/sbin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/bin', '/bin'] as $dir) {
                $path = $dir . '/' . $name;
                if (is_file($path) && is_executable($path)) { $found[$name] = $path; break; }
            }
        }
        return $found[$name];
    }
}

if (!function_exists('lv_cmd')) {
    function lv_cmd(string $name, string $args, int $seconds = 5): string {
        return lv_bin('timeout') . ' ' . $seconds . ' ' . lv_bin($name) . ' ' . $args;
    }
}

if (!function_exists('lv_cache_dir')) {
    function lv_cache_dir(): ?string {
        static $dir = false;
        if ($dir === false) {
            $path = '/tmp/logsviewer_cache';
            $st = @lstat($path);
            if ($st === false) { @mkdir($path, 0700); $st = @lstat($path); }
            $own = is_array($st) && ($st['mode'] & 0170000) === 0040000 && $st['uid'] === 0;
            if ($own && ($st['mode'] & 0777) !== 0700) @chmod($path, 0700);
            $dir = $own ? $path : null;
        }
        return $dir;
    }
}
