#!/bin/bash
# ============================================================================
# LOGS VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

# daily cron: zips the selected logs into the backup folder, prunes old ones

CFG="/boot/config/plugins/logsviewer/logsviewer.cfg"
[ ! -f "$CFG" ] && exit 0

get_cfg() { grep "^$1=" "$CFG" 2>/dev/null | cut -d'"' -f2; }

ENABLED=$(get_cfg BACKUP_ENABLED)
[ "$ENABLED" != "1" ] && exit 0

STORAGE=$(get_cfg BACKUP_STORAGE)
[ -z "$STORAGE" ] && exit 1
# uninstall and retention delete inside this path, so refuse anything outside the share
case "$STORAGE" in /mnt/user/*) ;; *) exit 1 ;; esac

RETENTION=$(get_cfg BACKUP_RETENTION)
case "$RETENTION" in ''|*[!0-9]*) RETENTION=3 ;; esac

INTERVAL=$(get_cfg BACKUP_INTERVAL_DAYS)
case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=1 ;; esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=1

BACKUP_DIR="$STORAGE"
mkdir -p "$BACKUP_DIR" || exit 1
# Prevent Samba access - logs contain sensitive data
chmod 700 "$BACKUP_DIR"

DATE=$(date +%Y-%m-%d)

# measured here because */N in cron restarts every month
if [ "$INTERVAL" -gt 1 ]; then
    LAST=""
    for f in "$BACKUP_DIR"/*.zip; do
        [ -f "$f" ] || continue
        b=$(basename "$f" .zip)
        [[ "$b" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
        [[ "$b" > "$LAST" ]] && LAST="$b"
    done
    if [ -n "$LAST" ]; then
        LAST_TS=$(date -d "$LAST" +%s 2>/dev/null)
        NOW_TS=$(date -d "$DATE" +%s 2>/dev/null)
        if [ -n "$LAST_TS" ] && [ -n "$NOW_TS" ] && [ "$NOW_TS" -ge "$LAST_TS" ]; then
            [ $(( (NOW_TS - LAST_TS) / 86400 )) -lt "$INTERVAL" ] && exit 0
        fi
    fi
fi

TMPDIR=$(mktemp -d /tmp/logsviewer-backup-XXXXXX)
trap "rm -rf '$TMPDIR'" EXIT

HAS_FILES=0

# php parses the custom paths json, so the script needs no jq
PHP=""
for p in /usr/bin/php /usr/local/bin/php /usr/local/emhttp/plugins/dynamix/scripts/php; do
    [ -x "$p" ] && PHP="$p" && break
done

declare -A CUSTOM_PATHS_MAP
CUSTOM_FILE="/boot/config/plugins/logsviewer/custom-paths.json"
if [ -n "$PHP" ] && [ -f "$CUSTOM_FILE" ]; then
    while IFS=$'\t' read -r slug fpath; do
        [ -z "$slug" ] && continue
        case "$fpath" in
            /var/log/*|/mnt/user/*|/mnt/cache/*) ;;
            *) continue ;;
        esac
        case "$fpath" in *..*) continue ;; esac
        CUSTOM_PATHS_MAP["$slug"]="$fpath"
    done < <("$PHP" -r '
        $f = "/boot/config/plugins/logsviewer/custom-paths.json";
        if (!is_file($f)) exit(0);
        $a = @json_decode(@file_get_contents($f), true);
        if (!is_array($a)) exit(0);
        foreach ($a as $e) {
            if (!is_array($e)) continue;
            $label = (string)($e["label"] ?? "");
            $path  = (string)($e["path"]  ?? "");
            if ($label === "" || $path === "") continue;
            $slug = strtolower(preg_replace("/[^a-z0-9]+/", "-", strtolower($label)));
            $slug = trim((string)$slug, "-");
            if ($slug === "") continue;
            echo $slug . "\t" . $path . "\n";
        }
    ' 2>/dev/null)
fi

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
    rmdir "$TMPDIR/system" 2>/dev/null
fi

# custom logs go in their own folder, a user label could collide with a system log name
CUSTOM_LOGS=$(get_cfg BACKUP_ENABLED_CUSTOM_LOGS)
if [ -n "$CUSTOM_LOGS" ]; then
    mkdir -p "$TMPDIR/custom"
    IFS=',' read -ra CLOGS <<< "$CUSTOM_LOGS"
    for clog in "${CLOGS[@]}"; do
        case "$clog" in
            custom:*)
                slug="${clog#custom:}"
                fpath="${CUSTOM_PATHS_MAP[$slug]:-}"
                [ -z "$fpath" ] && continue
                [ -f "$fpath" ] || continue
                # resolve symlinks so a link can't pull files from outside the whitelist
                rpath=$(readlink -f "$fpath" 2>/dev/null)
                [ -z "$rpath" ] && continue
                case "$rpath" in /var/log/*|/mnt/user/*|/mnt/cache/*) ;; *) continue ;; esac
                safe=$(echo "$slug" | tr -cd 'a-zA-Z0-9._-')
                [ -z "$safe" ] && continue
                cp "$rpath" "$TMPDIR/custom/${safe}.log" && HAS_FILES=1
                ;;
        esac
    done
    rmdir "$TMPDIR/custom" 2>/dev/null
fi

# the tmp path comes from the script folder name
SCRIPT_LOGS=$(get_cfg BACKUP_ENABLED_USER_SCRIPTS)
if [ -n "$SCRIPT_LOGS" ]; then
    mkdir -p "$TMPDIR/scripts"
    IFS=',' read -ra SLOGS <<< "$SCRIPT_LOGS"
    for slog in "${SLOGS[@]}"; do
        case "$slog" in
            script:*)
                folder="${slog#script:}"
                [ -z "$folder" ] && continue
                case "$folder" in *..*|*/*) continue ;; esac
                [ -f "/boot/config/plugins/user.scripts/scripts/${folder}/script" ] || continue
                fpath="/tmp/user.scripts/tmpScripts/${folder}/log.txt"
                [ -f "$fpath" ] || continue
                rpath=$(readlink -f "$fpath" 2>/dev/null)
                [ -z "$rpath" ] && continue
                case "$rpath" in /tmp/user.scripts/tmpScripts/*) ;; *) continue ;; esac
                safe=$(echo "$folder" | tr -cd 'a-zA-Z0-9._-')
                [ -z "$safe" ] && continue
                cp "$rpath" "$TMPDIR/scripts/${safe}.log" && HAS_FILES=1
                ;;
        esac
    done
    rmdir "$TMPDIR/scripts" 2>/dev/null
fi

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

[ "$HAS_FILES" -eq 0 ] && exit 0

cd "$TMPDIR"
zip -r "$BACKUP_DIR/${DATE}.zip" . -x ".*" > /dev/null 2>&1

CUTOFF=$(date -d "-${RETENTION} months" +%Y-%m-%d 2>/dev/null)
if [ -n "$CUTOFF" ]; then
    for f in "$BACKUP_DIR"/*.zip; do
        [ ! -f "$f" ] && continue
        FDATE=$(basename "$f" .zip)
        # only touch our own YYYY-MM-DD.zip, the folder may hold unrelated archives
        [[ "$FDATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
        if [[ "$FDATE" < "$CUTOFF" ]]; then
            rm -f "$f"
        fi
    done
fi
