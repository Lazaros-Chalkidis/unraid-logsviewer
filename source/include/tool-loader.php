<?php
/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

require_once __DIR__ . '/logsviewer_api.php';

// ajax only, the tab html is never served on a direct hit
if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
    http_response_code(403);
    echo '<div class="lvt-error">Direct access denied.</div>';
    exit;
}

$allowed = ['logs'];  // whitelist the tab names so $tab can't be used to include an arbitrary file
$tab     = (string)($_GET['tab'] ?? '');

if (!in_array($tab, $allowed, true)) {
    http_response_code(400);
    echo '<div class="lvt-error">Unknown tab: ' . htmlspecialchars($tab, ENT_QUOTES) . '</div>';
    exit;
}

$template = __DIR__ . '/tool-tab-' . $tab . '.php';
if (!is_file($template)) {
    http_response_code(404);
    echo '<div class="lvt-error">Template missing for tab: ' . htmlspecialchars($tab, ENT_QUOTES) . '</div>';
    exit;
}

$cfg = parse_plugin_cfg('logsviewer', true) ?: [];

include $template;
