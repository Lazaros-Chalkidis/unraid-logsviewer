#!/bin/bash
# ============================================================================
# LOGS VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

CFG="/boot/config/plugins/logsviewer/logsviewer.cfg"
SCAN="/usr/local/emhttp/plugins/logsviewer/include/logsviewer-alerts-scan.php"
[ ! -f "$CFG" ] && exit 0

PHP=""
for p in /usr/bin/php /usr/local/bin/php /usr/local/emhttp/plugins/dynamix/scripts/php; do
    [ -x "$p" ] && PHP="$p" && break
done
[ -z "$PHP" ] && exit 1

if [ "$1" = "flush" ]; then
    $PHP -f "$SCAN" flush
    exit 0
fi

ENABLED=$(grep '^ALERTS_ENABLED=' "$CFG" 2>/dev/null | cut -d'"' -f2)
[ "$ENABLED" != "1" ] && exit 0

$PHP -f "$SCAN"
