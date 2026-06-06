<?php
/**
 * Logs Viewer Tool — AJAX tab loader
 * Copyright (C) 2026 Lazaros Chalkidis
 * License: GPLv3
 * /plugins/logsviewer/include/tool-loader.php
 *
 * Loads the Logs tab content for the Tool page via AJAX so the page shell is
 * cheap. (Saved and Pinned tabs were removed, so Logs is the only tab.)
 */

require_once __DIR__ . '/logsviewer_api.php';

// Same-origin check via X-Requested-With header
if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
    http_response_code(403);
    echo '<div class="lvt-error">Direct access denied.</div>';
    exit;
}

// Allowed tabs (whitelist — no path traversal possible). Saved and Pinned
// were removed, so only the Logs view remains.
$allowed = ['logs'];
$tab     = (string)($_GET['tab'] ?? '');

if (!in_array($tab, $allowed, true)) {
    http_response_code(400);
    echo '<div class="lvt-error">Unknown tab: ' . htmlspecialchars($tab, ENT_QUOTES) . '</div>';
    exit;
}

// Build the template path and include it
$template = __DIR__ . '/tool-tab-' . $tab . '.php';
if (!is_file($template)) {
    http_response_code(404);
    echo '<div class="lvt-error">Template missing for tab: ' . htmlspecialchars($tab, ENT_QUOTES) . '</div>';
    exit;
}

// Shared config the templates may need
$cfg = parse_plugin_cfg('logsviewer', true) ?: [];

// Include the template (it outputs HTML directly)
include $template;
