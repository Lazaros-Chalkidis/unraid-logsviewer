#!/bin/bash
# LogsViewer Backup - Daily cron script
# Copyright (C) 2026 Lazaros Chalkidis - License: GPLv3

CFG="/boot/config/plugins/logsviewer/logsviewer.cfg"
[ ! -f "$CFG" ] && exit 0

get_cfg() { grep "^$1=" "$CFG" 2>/dev/null | cut -d'"' -f2; }

ENABLED=$(get_cfg BACKUP_ENABLED)
[ "$ENABLED" != "1" ] && exit 0

STORAGE=$(get_cfg BACKUP_STORAGE)
[ -z "$STORAGE" ] && exit 1
# Validate path is under /mnt/user/
case "$STORAGE" in /mnt/user/*) ;; *) exit 1 ;; esac

RETENTION=$(get_cfg BACKUP_RETENTION)
[ -z "$RETENTION" ] && RETENTION=3

BACKUP_DIR="$STORAGE"
mkdir -p "$BACKUP_DIR" || exit 1
# Prevent Samba access - logs contain sensitive data
chmod 700 "$BACKUP_DIR"

DATE=$(date +%Y-%m-%d)
TMPDIR=$(mktemp -d /tmp/logsviewer-backup-XXXXXX)
trap "rm -rf '$TMPDIR'" EXIT

HAS_FILES=0

# System logs
SYS_LOGS=$(get_cfg BACKUP_ENABLED_SYSTEM_LOGS)
if [ -n "$SYS_LOGS" ]; then
    mkdir -p "$TMPDIR/system"
    IFS=',' read -ra LOGS <<< "$SYS_LOGS"
    for log in "${LOGS[@]}"; do
        case "$log" in
            syslog)          [ -f /var/log/syslog ] && cp /var/log/syslog "$TMPDIR/system/syslog.log" && HAS_FILES=1 ;;
            syslog-previous) [ -f /boot/logs/syslog-previous ] && cp /boot/logs/syslog-previous "$TMPDIR/system/syslog-previous.log" && HAS_FILES=1 ;;
            dmesg)           [ -f /var/log/dmesg ] && cp /var/log/dmesg "$TMPDIR/system/dmesg.log" && HAS_FILES=1 ;;
            graphql-api.log) [ -f /var/log/graphql-api.log ] && cp /var/log/graphql-api.log "$TMPDIR/system/graphql-api.log" && HAS_FILES=1 ;;
            nginx-error)     [ -f /var/log/nginx/error.log ] && cp /var/log/nginx/error.log "$TMPDIR/system/nginx-error.log" && HAS_FILES=1 ;;
            phplog)          [ -f /var/log/phplog ] && cp /var/log/phplog "$TMPDIR/system/phplog.log" && HAS_FILES=1 ;;
            libvirt)         [ -f /var/log/libvirt/libvirtd.log ] && cp /var/log/libvirt/libvirtd.log "$TMPDIR/system/libvirt.log" && HAS_FILES=1 ;;
        esac
    done
    # Remove system dir if empty
    rmdir "$TMPDIR/system" 2>/dev/null
fi

# Docker logs
DOCKER_CONTAINERS=$(get_cfg BACKUP_ENABLED_DOCKER_CONTAINERS)
if [ -n "$DOCKER_CONTAINERS" ] && command -v docker &>/dev/null; then
    mkdir -p "$TMPDIR/docker"
    IFS=',' read -ra CONTAINERS <<< "$DOCKER_CONTAINERS"
    for container in "${CONTAINERS[@]}"; do
        container=$(echo "$container" | tr -cd 'a-zA-Z0-9._-')
        [ -z "$container" ] && continue
        docker logs "$container" > "$TMPDIR/docker/${container}.log" 2>&1 && HAS_FILES=1
    done
    rmdir "$TMPDIR/docker" 2>/dev/null
fi

# VM logs
VMS=$(get_cfg BACKUP_ENABLED_VMS)
if [ -n "$VMS" ]; then
    mkdir -p "$TMPDIR/vms"
    IFS=',' read -ra VM_LIST <<< "$VMS"
    for vm in "${VM_LIST[@]}"; do
        vm=$(echo "$vm" | tr -cd 'a-zA-Z0-9 ._-')
        [ -z "$vm" ] && continue
        VMLOG="/var/log/libvirt/qemu/${vm}.log"
        [ -f "$VMLOG" ] && cp "$VMLOG" "$TMPDIR/vms/${vm}.log" && HAS_FILES=1
    done
    rmdir "$TMPDIR/vms" 2>/dev/null
fi

# Only create zip if we collected something
[ "$HAS_FILES" -eq 0 ] && exit 0

cd "$TMPDIR"
zip -r "$BACKUP_DIR/${DATE}.zip" . -x ".*" > /dev/null 2>&1

# Cleanup old backups beyond retention period
CUTOFF=$(date -d "-${RETENTION} months" +%Y-%m-%d 2>/dev/null)
if [ -n "$CUTOFF" ]; then
    for f in "$BACKUP_DIR"/*.zip; do
        [ ! -f "$f" ] && continue
        FDATE=$(basename "$f" .zip)
        if [[ "$FDATE" < "$CUTOFF" ]]; then
            rm -f "$f"
        fi
    done
fi
