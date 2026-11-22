#!/bin/bash
# ============================================================================
# LOGS VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

CFG="/boot/config/plugins/logsviewer/logsviewer.cfg"
[ ! -f "$CFG" ] && exit 0

get_cfg() { grep "^$1=" "$CFG" 2>/dev/null | cut -d'"' -f2; }

own_backup() {
    local names
    names=$(unzip -Z1 "$1" 2>/dev/null) || return 1
    LC_ALL=C grep -qE '^(system|custom|scripts|docker|vms)/[^/]+\.log$' <<< "$names" &&
        ! LC_ALL=C grep -qvE '^(system|custom|scripts|docker|vms)/([^/]+\.log)?$' <<< "$names"
}

ENABLED=$(get_cfg BACKUP_ENABLED)
[ "$ENABLED" != "1" ] && exit 0

CACHE=/tmp/logsviewer_cache
mkdir -m 700 "$CACHE" 2>/dev/null
if [ "$(LC_ALL=C stat -c '%F %a %u' "$CACHE" 2>/dev/null)" != "directory 700 0" ]; then
    logger -t logsviewer "backup not written: logsviewer_cache in /tmp is not a folder of root with mode 700"
    exit 1
fi
exec 9>"$CACHE/backup.lock"
flock -n 9 || exit 0

STORAGE=$(get_cfg BACKUP_STORAGE)
[ -z "$STORAGE" ] && exit 1
case "$STORAGE" in /mnt/user/*) ;; *) exit 1 ;; esac
case "$STORAGE/" in */../*) exit 1 ;; esac

RETENTION=$(get_cfg BACKUP_RETENTION)
case "$RETENTION" in ''|*[!0-9]*) RETENTION=3 ;; esac

INTERVAL=$(get_cfg BACKUP_INTERVAL_DAYS)
case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=1 ;; esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=1

BACKUP_DIR="$STORAGE"
mountpoint -q /mnt/user || exit 0
if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR" || exit 1
    chmod 700 "$BACKUP_DIR"
fi

DATE=$(date +%Y-%m-%d)

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

for d in "$BACKUP_DIR"/.staging-??????; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ -f "$d/.logsviewer-staging" ] && rm -rf "$d"
done
TMPDIR=$(mktemp -d "$BACKUP_DIR/.staging-XXXXXX") || exit 1
trap 'rm -rf "$TMPDIR"' EXIT
: > "$TMPDIR/.logsviewer-staging"

HAS_FILES=0

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
        require "/usr/local/emhttp/plugins/logsviewer/include/logsviewer-datepath.php";
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
            echo $slug . "\t" . lv_expand_date_path($path) . "\n";
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
                cp "$rpath" "$TMPDIR/scripts/${folder}.log" && HAS_FILES=1
                ;;
        esac
    done
    rmdir "$TMPDIR/scripts" 2>/dev/null
fi

DOCKER_CONTAINERS=$(get_cfg BACKUP_ENABLED_DOCKER_CONTAINERS)
if [ -n "$DOCKER_CONTAINERS" ] && command -v docker &>/dev/null && timeout 10 docker version &>/dev/null; then
    mkdir -p "$TMPDIR/docker"
    IFS=',' read -ra CONTAINERS <<< "$DOCKER_CONTAINERS"
    for container in "${CONTAINERS[@]}"; do
        container=$(echo "$container" | tr -cd 'a-zA-Z0-9._-')
        case "$container" in [a-zA-Z0-9]*) ;; *) continue ;; esac
        if timeout 300 docker logs "$container" > "$TMPDIR/docker/${container}.log" 2>&1; then
            HAS_FILES=1
        else
            rm -f "$TMPDIR/docker/${container}.log"
        fi
    done
    rmdir "$TMPDIR/docker" 2>/dev/null
fi

VMS=$(get_cfg BACKUP_ENABLED_VMS)
if [ -n "$VMS" ]; then
    mkdir -p "$TMPDIR/vms"
    IFS=',' read -ra VM_LIST <<< "$VMS"
    for vm in "${VM_LIST[@]}"; do
        case "$vm" in ''|*/*) continue ;; esac
        VMLOG=$(readlink -f "/var/log/libvirt/qemu/${vm}.log" 2>/dev/null)
        case "$VMLOG" in /var/log/libvirt/qemu/*) ;; *) continue ;; esac
        [ -f "$VMLOG" ] && cp "$VMLOG" "$TMPDIR/vms/${vm}.log" && HAS_FILES=1
    done
    rmdir "$TMPDIR/vms" 2>/dev/null
fi

[ "$HAS_FILES" -eq 0 ] && exit 0

ZIP="$BACKUP_DIR/${DATE}.zip"
if [ -n "$PHP" ] && [ -s "$ZIP" ]; then
    "$PHP" -r '
        $ticked = ["system" => $argv[2], "custom" => $argv[3], "scripts" => $argv[4], "docker" => $argv[5], "vms" => $argv[6]];
        $prefix = ["custom" => "custom:", "scripts" => "script:"];
        $za = class_exists("ZipArchive") ? new ZipArchive() : null;
        if (!$za || $za->open($argv[1]) !== true) exit(1);
        for ($i = 0; $i < $za->numFiles; $i++) {
            $entry = (string)$za->getNameIndex($i, ZipArchive::FL_ENC_RAW);
            if (!preg_match("#^(system|custom|scripts|docker|vms)/([^/]+)\.log$#D", $entry, $m)) continue;
            $key = $entry === "system/graphql-api.log" ? "graphql-api.log" : ($prefix[$m[1]] ?? "") . $m[2];
            if (!in_array($key, explode(",", $ticked[$m[1]]), true)) $za->deleteIndex($i);
        }
        @$za->close();
    ' -- "$ZIP" "$SYS_LOGS" "$CUSTOM_LOGS" "$SCRIPT_LOGS" "$DOCKER_CONTAINERS" "$VMS" 2>/dev/null
fi

cd "$TMPDIR" || exit 1
(umask 077; zip -r "$ZIP" . -x ".*" > /dev/null 2>&1)
ZIP_RC=$?
if [ "$ZIP_RC" -eq 3 ]; then
    logger -t logsviewer "backup not written: ${DATE}.zip in the backup folder is not a zip archive"
elif [ "$ZIP_RC" -ne 0 ]; then
    logger -t logsviewer "backup not written: zip exited $ZIP_RC"
fi

CUTOFF=$(date -d "-${RETENTION} months" +%Y-%m-%d 2>/dev/null)
if [ -n "$CUTOFF" ]; then
    for f in "$BACKUP_DIR"/*.zip; do
        [ ! -f "$f" ] && continue
        FDATE=$(basename "$f" .zip)
        [[ "$FDATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
        if [[ "$FDATE" < "$CUTOFF" ]] && own_backup "$f"; then
            rm -f "$f"
        fi
    done
fi

[ "$ZIP_RC" -eq 0 ] || exit 1
