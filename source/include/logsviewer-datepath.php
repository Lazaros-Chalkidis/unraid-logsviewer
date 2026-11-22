<?php
/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

if (!function_exists('lv_expand_date_path')) {
    function lv_expand_date_path(string $path): string {
        static $map = null;
        if (strpos($path, '{') === false) return $path;
        if ($map === null) {
            $link = @readlink('/etc/localtime');
            $zone = (is_string($link) && strpos($link, '/usr/share/zoneinfo/') === 0) ? substr($link, 20) : '';
            try {
                $now = new DateTime('now', $zone !== '' ? new DateTimeZone($zone) : null);
            } catch (Throwable $e) {
                $now = new DateTime('now');
            }
            $map = ['{YYYY}' => $now->format('Y'), '{MM}' => $now->format('m'), '{DD}' => $now->format('d')];
        }
        return strtr($path, $map);
    }
}
