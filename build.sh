#!/bin/bash
PLUGIN_NAME="logsviewer"
# Copyright (C) 2026 Lazaros Chalkidis - License: GPLv3
AUTHOR="Lazaros Chalkidis"
GITHUB_USER="Lazaros-Chalkidis"
GIT_URL="https://github.com/Lazaros-Chalkidis/unraid-logsviewer"
PACKAGE_DIR_FINAL="packages"
PACKAGE_DIR_TEMP="package-temp"

BASE_VERSION=$(date +'%Y.%m.%d')
LETTER_SUFFIX="$1"
STAGE_INPUT="$2"
STAGE_SUFFIX=""

if [[ -n "$STAGE_INPUT" && "$STAGE_INPUT" != "release" ]]; then
    STAGE_SUFFIX="-${STAGE_INPUT}"
fi

VERSION="${BASE_VERSION}${LETTER_SUFFIX}${STAGE_SUFFIX}"

LOCAL_INSTALL="${3:-}"

if [[ "$LOCAL_INSTALL" == "local" ]]; then
  BRANCH="local"
  PLUGIN_URL_STRUCTURE=""
  CHANGES_TEXT="- Local build (embedded package inside PLG; no URL download)."
elif [[ "$STAGE_INPUT" == "dev" ]]; then
  BRANCH="dev"
  PLUGIN_URL_STRUCTURE="&gitURL;/raw/&branch;/packages/&name;-&version;.txz"
  CHANGES_TEXT="- Development build from the 'dev' branch. For testing purposes only."
else
  BRANCH="main"
  PLUGIN_URL_STRUCTURE="&gitURL;/releases/download/&version;/&name;-&version;.txz"
  CHANGES_TEXT="- Automated main build release."
fi

CHANGELOG_MD_FILE="CHANGELOG.md"
if [[ -f "${CHANGELOG_MD_FILE}" ]]; then
  CHANGES_BLOCK="$(cat "${CHANGELOG_MD_FILE}")"

  # the plg ships the whole file, a stale top entry misleads users
  TOP_ENTRY=$(grep -m1 '^## ' "${CHANGELOG_MD_FILE}" | sed 's/^##[[:space:]]*//')
  if [[ "${TOP_ENTRY}" != "${VERSION}" ]]; then
    if [[ "$BRANCH" == "main" ]]; then
      echo "Error: CHANGELOG.md starts with '${TOP_ENTRY}' but this build is '${VERSION}'."
      echo "       Add the entry, or build with 'dev' while you work."
      exit 1
    fi
    echo "Warning: CHANGELOG.md starts with '${TOP_ENTRY}', building '${VERSION}'"
  fi
else
  CHANGES_BLOCK=$'### ${VERSION}\n${CHANGES_TEXT}'
fi

# "]]>" is the one string that would close the CDATA early
CHANGES_BLOCK="${CHANGES_BLOCK//]]>/]]]]><![CDATA[>}"

echo "Starting build for version ${VERSION} on branch ${BRANCH}..."

rm -rf ${PACKAGE_DIR_TEMP}
rm -rf ${PACKAGE_DIR_FINAL}
mkdir -p ${PACKAGE_DIR_TEMP}
mkdir -p ${PACKAGE_DIR_FINAL}

PLUGIN_DEST_PATH="${PACKAGE_DIR_TEMP}/usr/local/emhttp/plugins/${PLUGIN_NAME}"
mkdir -p "${PLUGIN_DEST_PATH}"
cp -R source/* "${PLUGIN_DEST_PATH}/"

# the settings page reads this at runtime for the footer badge and credits
echo "${VERSION}" > "${PLUGIN_DEST_PATH}/VERSION"

cat > "${PLUGIN_DEST_PATH}/branch.meta" << METAEOF
BRANCH="${BRANCH}"
IS_MAIN_BRANCH=$([[ "$BRANCH" == "main" ]] && echo "1" || echo "0")
METAEOF

find "${PLUGIN_DEST_PATH}" -type d -exec chmod 755 {} \;
find "${PLUGIN_DEST_PATH}" -type f -exec chmod 644 {} \;
find "${PLUGIN_DEST_PATH}" -name '*.sh' -exec chmod 755 {} \;

FILENAME="${PLUGIN_NAME}-${VERSION}"
PACKAGE_PATH="${PACKAGE_DIR_FINAL}/${FILENAME}.txz"

echo "Creating package: ${FILENAME}.txz"
tar -C ${PACKAGE_DIR_TEMP} -cJf "${PACKAGE_PATH}" usr

if [ ! -f "${PACKAGE_PATH}" ]; then
    echo "❌ Error: Package creation failed!"
    exit 1
fi

echo "✅ Package created: $(du -h ${PACKAGE_PATH} | cut -f1)"

if command -v md5sum &>/dev/null; then
    PACKAGE_MD5="$(md5sum "${PACKAGE_PATH}" | cut -d' ' -f1)"
elif command -v md5 &>/dev/null; then
    PACKAGE_MD5="$(md5 -q "${PACKAGE_PATH}")"
else
    echo "Warning: md5sum/md5 not found, MD5 will be empty in PLG"
    PACKAGE_MD5=""
fi
echo "MD5: ${PACKAGE_MD5}"

b64_nolf() {
  if base64 --help 2>/dev/null | grep -q -- "-w"; then
    base64 -w 0 "$1"
  else
    base64 "$1" | tr -d '\n'
  fi
}

echo "Generating ${PLUGIN_NAME}.plg for '${BRANCH}' target..."

if [[ "$LOCAL_INSTALL" == "local" ]]; then
  PACKAGE_B64="$(b64_nolf "${PACKAGE_PATH}")"

  cat > "${PLUGIN_NAME}.plg" << EOF
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
 <!ENTITY name "${PLUGIN_NAME}">
 <!ENTITY author "${AUTHOR}">
 <!ENTITY version "${VERSION}">
 <!ENTITY branch "${BRANCH}">
 <!ENTITY gitURL "${GIT_URL}">
 <!ENTITY selfURL "&gitURL;/raw/&branch;/&name;.plg">
 <!ENTITY launch "Settings/LogsviewerSettings">
]>

<PLUGIN name="&name;" Title="Logs Viewer" author="&author;" version="&version;" pluginURL="&selfURL;" launch="&launch;" icon="img/logsviewerplugin.png" min="7.2.0" support="https://github.com/Lazaros-Chalkidis/unraid-logsviewer/issues">

<DESCRIPTION>
Real-time system, Docker and VM log viewer with dashboard widget and dedicated Tools page - Log Backups and System Alerts. Live auto-refresh, severity badges, search, filtering, syntax highlighting and export.
</DESCRIPTION>


<CHANGES><![CDATA[
${CHANGES_BLOCK}
]]></CHANGES>

<!-- Local install: embed package as base64, decode on the Unraid flash, then install -->
<FILE Name="/boot/config/plugins/&name;/&name;-&version;.txz.b64">
  <INLINE>${PACKAGE_B64}</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
mkdir -p /boot/config/plugins/&name;
base64 -d /boot/config/plugins/&name;/&name;-&version;.txz.b64 > /boot/config/plugins/&name;/&name;-&version;.txz 2>/dev/null || \
  base64 -D /boot/config/plugins/&name;/&name;-&version;.txz.b64 > /boot/config/plugins/&name;/&name;-&version;.txz
rm -f /boot/config/plugins/&name;/&name;-&version;.txz.b64

upgradepkg --install-new /boot/config/plugins/&name;/&name;-&version;.txz
</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
# Default config only on first install, an existing user config is never touched
CFG=/boot/config/plugins/&name;/&name;.cfg
if [ ! -f "\$CFG" ]; then
  mkdir -p /boot/config/plugins/&name;
  printf '%s\n' 'REFRESH_ENABLED="1"' 'REFRESH_INTERVAL="10"' 'ENABLED_SCRIPTS=""' 'SHOW_IDLE_LOGS="0"' 'VERSION_OVERRIDE="auto"' > "\$CFG.tmp"
  mv "\$CFG.tmp" "\$CFG"
fi
</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
# upgradepkg keeps whatever modes the archive had, so set them here
chown -R root:root /usr/local/emhttp/plugins/&name;
chmod -R 755 /usr/local/emhttp/plugins/&name;
find /usr/local/emhttp/plugins/&name; -type f -exec chmod 644 {} \;
find /usr/local/emhttp/plugins/&name; -name '*.sh' -exec chmod 755 {} \;

# versions up to 2026.09.10 kept the schedule in a .conf that update_cron never reads
if [ -f /boot/config/plugins/&name;/logsviewer-cron.conf ]; then
  mv /boot/config/plugins/&name;/logsviewer-cron.conf /boot/config/plugins/&name;/logsviewer.cron
fi
rm -f /etc/cron.d/logsviewer-backup /etc/cron.d/logsviewer-alerts /boot/config/plugins/&name;/logsviewer-backup.cron /boot/config/plugins/&name;/logsviewer-alerts.cron

# covers updates; at boot we are not registered yet and event/driver_loaded takes over
if [ -x /usr/local/sbin/update_cron ]; then
  /usr/local/sbin/update_cron
fi

echo ""
echo "----------------------------------------------------"
echo " &name; (&branch; build) has been installed."
echo " Version: &version;"
# our lines or dynamix headers in root's own crontab mean an older version copied the system table there
if crontab -l 2>/dev/null | grep -q 'logsviewer-\|^# Generated'; then
  echo ""
  echo " Please reboot once when convenient. Older versions"
  echo " of this plugin changed root's cron table, so some"
  echo " tasks may run twice and hourly, daily, weekly or"
  echo " monthly User Scripts may not run. A reboot puts"
  echo " the original back."
fi
echo "----------------------------------------------------"
echo ""
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
# runtime and install artifacts go, user config and backups stay
BPATH=\$(grep '^BACKUP_STORAGE=' /boot/config/plugins/&name;/&name;.cfg 2>/dev/null | cut -d'"' -f2)

removepkg &name;-&version;
rm -rf /usr/local/emhttp/plugins/&name;
rm -f /boot/config/plugins/&name;/&name;-*.txz /boot/config/plugins/&name;/&name;-*.txz.b64 /boot/config/plugins/&name;/&name;-*.md5

rm -rf /tmp/logsviewer_cache /tmp/logsviewer-backup-*
rm -f /etc/cron.d/logsviewer-backup /etc/cron.d/logsviewer-alerts
# logsviewer.cron stays with the config, the manager runs update_cron after remove and skips us by then

echo ""
echo "----------------------------------------------------"
echo " &name; has been removed."
echo ""
echo " Kept on purpose, delete by hand if you want them gone:"
echo "   settings, alert rules and history:"
echo "     /boot/config/plugins/&name;"
if [ -d "\$BPATH" ]; then
  echo "   log backups:"
  echo "     \$BPATH"
fi
echo "----------------------------------------------------"
echo ""
</INLINE>
</FILE>

</PLUGIN>
EOF

else

  cat > "${PLUGIN_NAME}.plg" << EOF
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
 <!ENTITY name "${PLUGIN_NAME}">
 <!ENTITY author "${AUTHOR}">
 <!ENTITY version "${VERSION}">
 <!ENTITY branch "${BRANCH}">
 <!ENTITY gitURL "${GIT_URL}">
 <!ENTITY pluginURL "${PLUGIN_URL_STRUCTURE}">
 <!ENTITY selfURL "&gitURL;/raw/&branch;/&name;.plg">
 <!ENTITY md5 "${PACKAGE_MD5}">
 <!ENTITY launch "Settings/LogsviewerSettings">
]>

<PLUGIN name="&name;" Title="Logs Viewer" author="&author;" version="&version;" pluginURL="&selfURL;" launch="&launch;" icon="img/logsviewerplugin.png" min="7.2.0" support="https://github.com/Lazaros-Chalkidis/unraid-logsviewer/issues">

<DESCRIPTION>
Real-time system, Docker and VM log viewer with dashboard widget and dedicated Tools page - Log Backups and System Alerts. Live auto-refresh, severity badges, search, filtering, syntax highlighting and export.
</DESCRIPTION>

<CHANGES><![CDATA[
${CHANGES_BLOCK}
]]></CHANGES>

<FILE Name="/boot/config/plugins/&name;/&name;-&version;.txz" Run="upgradepkg --install-new">
<URL>&pluginURL;</URL>
<MD5>&md5;</MD5>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
# Default config only on first install, an existing user config is never touched
CFG=/boot/config/plugins/&name;/&name;.cfg
if [ ! -f "\$CFG" ]; then
  mkdir -p /boot/config/plugins/&name;
  printf '%s\n' 'REFRESH_ENABLED="1"' 'REFRESH_INTERVAL="10"' 'ENABLED_SCRIPTS=""' 'SHOW_IDLE_LOGS="0"' 'VERSION_OVERRIDE="auto"' > "\$CFG.tmp"
  mv "\$CFG.tmp" "\$CFG"
fi
</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
# upgradepkg keeps whatever modes the archive had, so set them here
chown -R root:root /usr/local/emhttp/plugins/&name;
chmod -R 755 /usr/local/emhttp/plugins/&name;
find /usr/local/emhttp/plugins/&name; -type f -exec chmod 644 {} \;
find /usr/local/emhttp/plugins/&name; -name '*.sh' -exec chmod 755 {} \;

# versions up to 2026.09.10 kept the schedule in a .conf that update_cron never reads
if [ -f /boot/config/plugins/&name;/logsviewer-cron.conf ]; then
  mv /boot/config/plugins/&name;/logsviewer-cron.conf /boot/config/plugins/&name;/logsviewer.cron
fi
rm -f /etc/cron.d/logsviewer-backup /etc/cron.d/logsviewer-alerts /boot/config/plugins/&name;/logsviewer-backup.cron /boot/config/plugins/&name;/logsviewer-alerts.cron

# covers updates; at boot we are not registered yet and event/driver_loaded takes over
if [ -x /usr/local/sbin/update_cron ]; then
  /usr/local/sbin/update_cron
fi

echo ""
echo "----------------------------------------------------"
echo " &name; (&branch; build) has been installed."
echo " Version: &version;"
# our lines or dynamix headers in root's own crontab mean an older version copied the system table there
if crontab -l 2>/dev/null | grep -q 'logsviewer-\|^# Generated'; then
  echo ""
  echo " Please reboot once when convenient. Older versions"
  echo " of this plugin changed root's cron table, so some"
  echo " tasks may run twice and hourly, daily, weekly or"
  echo " monthly User Scripts may not run. A reboot puts"
  echo " the original back."
fi
echo "----------------------------------------------------"
echo ""
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
# runtime and install artifacts go, user config and backups stay
BPATH=\$(grep '^BACKUP_STORAGE=' /boot/config/plugins/&name;/&name;.cfg 2>/dev/null | cut -d'"' -f2)

removepkg &name;-&version;
rm -rf /usr/local/emhttp/plugins/&name;
rm -f /boot/config/plugins/&name;/&name;-*.txz /boot/config/plugins/&name;/&name;-*.txz.b64 /boot/config/plugins/&name;/&name;-*.md5

rm -rf /tmp/logsviewer_cache /tmp/logsviewer-backup-*
rm -f /etc/cron.d/logsviewer-backup /etc/cron.d/logsviewer-alerts
# logsviewer.cron stays with the config, the manager runs update_cron after remove and skips us by then

echo ""
echo "----------------------------------------------------"
echo " &name; has been removed."
echo ""
echo " Kept on purpose, delete by hand if you want them gone:"
echo "   settings, alert rules and history:"
echo "     /boot/config/plugins/&name;"
if [ -d "\$BPATH" ]; then
  echo "   log backups:"
  echo "     \$BPATH"
fi
echo "----------------------------------------------------"
echo ""
</INLINE>
</FILE>

</PLUGIN>
EOF

fi

rm -rf ${PACKAGE_DIR_TEMP}

echo ""
echo "🎉 Build completed successfully!"
echo "📦 Version: ${VERSION}"
echo "📁 Package: ${PACKAGE_PATH}"
echo "📄 PLG file: ${PLUGIN_NAME}.plg"