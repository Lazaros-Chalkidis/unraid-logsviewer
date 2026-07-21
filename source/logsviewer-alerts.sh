#!/bin/bash
# ============================================================================
# LOGS VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

# cron wrapper: runs the alert scan if alerts are enabled

CFG="/boot/config/plugins/logsviewer/logsviewer.cfg"
[ ! -f "$CFG" ] && exit 0

ENABLED=$(grep '^ALERTS_ENABLED=' "$CFG" 2>/dev/null | cut -d'"' -f2)
[ "$ENABLED" != "1" ] && exit 0

# Find PHP binary
PHP=""
for p in /usr/bin/php /usr/local/bin/php /usr/local/emhttp/plugins/dynamix/scripts/php; do
    [ -x "$p" ] && PHP="$p" && break
done
[ -z "$PHP" ] && exit 1

$PHP -f /usr/local/emhttp/plugins/logsviewer/include/logsviewer-alerts-scan.php
