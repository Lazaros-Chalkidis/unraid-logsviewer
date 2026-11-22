# Logs Viewer for Unraid

Real-time system, Docker, VM and User Scripts log viewer with dashboard widget and dedicated Tools page. Log backups and system alerts.
Live auto-refresh, severity badges, search, filtering, syntax highlighting and export.

<p align="center">
  <img src="https://img.shields.io/github/v/release/Lazaros-Chalkidis/unraid-logsviewer?label=Latest%20Version&color=blue" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/last-commit/Lazaros-Chalkidis/unraid-logsviewer?label=Last%20Update" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/issues/Lazaros-Chalkidis/unraid-logsviewer?label=Issues" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/downloads/Lazaros-Chalkidis/unraid-logsviewer/total?label=Downloads&color=brightgreen" style="margin: 4px;" />&nbsp
  <img src="https://img.shields.io/github/license/Lazaros-Chalkidis/unraid-logsviewer?label=License" style="margin: 4px;" />
</p>

## Features

- **Dashboard Widget** with live auto-refresh and severity proportion strip
- **Tools Page** for full-screen, focused log viewing
- **System Logs**: Syslog, Syslog Previous, Dmesg, GraphQL API, Nginx Errors, PHP Log, Libvirt
- **Docker Logs** with real-time running/stopped status indicators
- **VM Logs** with real-time running/stopped status indicators
- **User Scripts Logs**: finds the scripts in the User Scripts plugin and shows their output, no paths to type in
- **Custom Logs**: point the plugin at any log file under `/var/log`, `/mnt/user` or `/mnt/cache` and it shows up everywhere. A path can carry the date, for folders that change every day
- **Log Backups**: scheduled snapshots of every source you enable, daily or every 2 to 4 days, compressed to a path you choose, with retention control and calendar download
- **Alerts**: pattern-based rules that scan logs every 1/2/5 minutes and push notifications through Unraid's notification system when a match is found. Includes one-click presets for failed logins, disk errors, OOM, kernel panics, array errors and Docker crashes
- **Search**: match highlighting with next/prev navigation
- **Filtering**: by severity level (Info, Warnings, Errors, Critical) or login events
- **Severity Badges**: clickable counters that double as quick filters
- **Proportion Strip**: color bar in the footer showing the error/warning/info ratio at a glance
- **Syntax Highlighting**: Highlight.js and Prism.js bundled locally, no CDN calls
- **Fonts**: system monospace by default. The four named fonts are optional and load from Google Fonts, falling back to your system monospace if the server has no internet access
- **Autoscroll**: follows new entries as they arrive, with pause-on-hover option
- **Export**: `.log`, `.txt` or `.json` from the widget, `.log`, `.json` or `.csv` from the Tool page, with the level of each line in the structured formats
- **Responsive**: works from wide monitors down to phones
- **Theme Support**: Black, Gray, Azure and White
- **Independent Settings**: Dashboard widget and Tool page configured separately, each with its own Automatic refresh, Autoscroll and Pause on hover
- **Performance Friendly**: single-source polling, content hash detection, pre-compiled regex, smart tail limits

### Dashboard Widget PC Screen
![Dashboard with Syntax Highlighting](screenshots/pc-dashboard-full-settings-syntax-on.png)
![Dashboard with Docker Logs](screenshots/pc-dashboard-full-settings-syntax-on-docker.png)

### Tool Page PC Screen
![Tool Page](screenshots/pc-tool-page-full-settings-syntax-on.png)

## Installation

### Community Applications (recommended)
1. Open **Community Applications** in Unraid
2. Search for **Logs Viewer**
3. Click **Install**

### Manual
1. Go to **Plugins** in Unraid
2. Click **Install Plugin**
3. Paste the URL:
```
https://raw.githubusercontent.com/Lazaros-Chalkidis/unraid-logsviewer/main/logsviewer.plg
```
4. Click **Install**

## Configuration

Go to **Settings → Logs Viewer** after installing. Four tabs: Dashboard, Tool, Backup and Alerts, each with their own settings.
The full-screen viewer lives under **Tools → Viewers Suite → Logs Viewer**.

The [guide](GUIDE.md) walks through the parts that are not obvious the first time.

| Setting | What it does |
|---------|-------------|
| Auto Refresh | Enable/disable live polling. With it off, the Tool page gets a Refresh now button |
| Refresh Interval | Poll frequency in seconds |
| Tail Lines | Cap the number of lines shown |
| Font Size & Family | Adjust log readability |
| Theme Preset | Color scheme for the log panel (Default, Terminal, Dim, High Contrast, Midnight, Ocean, Monokai) |
| Syntax Highlighting | Pick Highlight.js or Prism.js |
| Search | Enable in-log search with highlighting |
| Filter Dropdown | Quick severity filter in the tabs rail |
| Badges / Timestamp / Toast | Toggle individual footer elements |
| Export Format | Default format for downloads (.log / .txt / .json on the widget, .log / .json / .csv on the Tool page) |
| Log Sources | Choose which System logs, Docker containers, VMs, user scripts and custom logs to show |
| Custom Log Paths | Add your own log files, shared across all four tabs |
| Backup Enabled | Turn scheduled backups on/off |
| Backup Schedule | Time of day the backup runs |
| Backup Frequency | Every day, or every 2, 3 or 4 days |
| Backup Storage | Path where backup archives are stored |
| Backup Retention | How many months of backups to keep (1 to 6) |
| Alerts Enabled | Turn log scanning on/off |
| Alerts Interval | How often the scanner runs (1, 2 or 5 minutes) |
| Alert Rules | Add, edit or remove pattern-based rules with severity, sources and cooldown |

## Log Sources

### System Logs
Syslog, Syslog Previous, Dmesg, Nginx Errors, GraphQL API, PHP Log, Libvirt. Selectable per page.

### Docker Logs
Automatically discovers all containers. Each entry shows a green or red dot for running/stopped state. Select which ones to monitor.

### VM Logs
Automatically discovers all VMs. Same status dots. Select which ones to monitor.

### User Scripts Logs
Reads the scripts installed in the User Scripts plugin and lists them with a checkbox. The log is the one User Scripts itself keeps, so it appears after a script has run in the background or on a schedule. A run started with **Run Script** streams to the browser and leaves no file behind. The section is hidden when User Scripts is not installed.

### Custom Logs
Add any log file under `/var/log`, `/mnt/user` or `/mnt/cache`. Paths are defined once and are then available on the Tool page, the widget, Alerts and Backup.

A path can carry the date. `{YYYY}`, `{MM}` and `{DD}` are replaced with today's year, month and day, so `/var/log/hosts/{YYYY}/{MM}/{DD}/nginx/access.log` always points at today's file. Alerts pick up the new file on their own, and a backup takes the file of the day it runs.

## Log Backups

Compressed backups of the log sources you enable (system, Docker, VMs, user scripts, custom) to a storage path of your choice.

Settings include:
- Backup time (configurable hour)
- Backup frequency: every day, or every 2, 3 or 4 days
- Storage path (defaults to `/mnt/user/appdata/Logs-Viewer-Backup`)
- Retention from 1 to 6 months, with automatic cleanup of older backups
- Calendar view in the Settings page showing available dates
- One-click ZIP download for any backup date

A backup folder the plugin creates is restricted to root (700) and every backup file is saved readable by root only (600), so backups are not exposed through Samba shares. A folder that already exists keeps its permissions.

Backups are put together inside the backup folder, not in RAM, so a large log cannot use up the server's memory. Nothing is backed up while the array is stopped.

## Alerts

The alert system scans log sources at regular intervals and sends notifications through Unraid's built-in notification system when a pattern match is found.

**How it works:**
- Define rules with a name, text or regex pattern, target sources and severity level. Any source can be targeted, including user script and custom logs
- Set a cooldown per rule to avoid repeated notifications for the same event
- The scanner runs as a cron job every 1, 2 or 5 minutes depending on your setting
- Matches are logged in the alert history (visible in the Settings page) and pushed as Unraid notifications

**Built-in presets (one click):**
- Failed Login (syslog)
- Disk Error (syslog, dmesg)
- Out of Memory (syslog, dmesg)
- Kernel Panic (syslog, dmesg)
- Array Error (syslog)
- Docker Crash (docker logs)

You can add your own rules on top of these.

## Export Formats

| Format | Where | What is in the file |
|--------|-------|---------------------|
| `.log` | Widget and Tool page | The log as plain text |
| `.txt` | Widget | The log as plain text |
| `.json` | Widget | `timestamp`, `level` and `message` for each line, with `hostname` and `service` when the line has them |
| `.json` | Tool page | `severity` and `line` for each line |
| `.csv` | Tool page | The same two columns, `severity` and `line`. A line starting with `=`, `+`, `-` or `@` gets an apostrophe in front, so a spreadsheet does not run it as a formula |

### Settings Page PC Screen
![Settings Page](screenshots/pc-settings-page.png)

## Development

### Requirements
- Unraid 7.2.0 or later
- Bash (for the build script)

### Build
```bash
./build.sh                  # release
./build.sh "" dev           # dev build
./build.sh "" "" local      # local build (embedded package, no internet)
```

### Project Structure
```
unraid-logsviewer/
├── source/
│   ├── css/                        # widget.css, tool.css, tool-logs.css, settings.css
│   ├── js/                         # widget and tool page scripts
│   ├── include/                    # api endpoint, alert scanner, tool page partials
│   ├── event/                      # cron reload at boot, alert history saved at array stop
│   ├── vendor/                     # hljs + prism (local bundles)
│   ├── Logsviewer.page             # Dashboard widget
│   ├── LogsviewerTool.page         # Tools page
│   ├── LogsviewerSettings.page     # Settings page
│   ├── logsviewer-alerts.sh        # Alert scanner cron wrapper
│   └── logsviewer-backup.sh        # Backup cron wrapper
├── screenshots/
├── mockups/                        # drawings used by the guide
├── tools/                          # make_mockups.py redraws them
├── build.sh
├── CHANGELOG.md
├── GUIDE.md
├── logsviewer.plg
└── logsviewer.xml
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md)

## Support

Bug reports, feature requests or general feedback:
- [GitHub Issues](https://github.com/Lazaros-Chalkidis/unraid-logsviewer/issues)

## Author

**Lazaros Chalkidis** - [@Lazaros-Chalkidis](https://github.com/Lazaros-Chalkidis)

## License

Copyright (C) 2026 Logs Viewer Unraid Plugin - Lazaros Chalkidis

Licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).
See the `LICENSE` file for the full text.
