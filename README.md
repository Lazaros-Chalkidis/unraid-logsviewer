# Logs Viewer for Unraid

A fast, full featured log viewer plugin for Unraid. System, Docker and VM logs on your dashboard or a dedicated Tools page. No terminal needed.

<p align="center">
  <img src="https://img.shields.io/github/v/release/Lazaros-Chalkidis/unraid-logsviewer?label=Latest%20Version&color=blue" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/last-commit/Lazaros-Chalkidis/unraid-logsviewer?label=Last%20Update" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/downloads/Lazaros-Chalkidis/unraid-logsviewer/total?label=Downloads&color=brightgreen" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/issues/Lazaros-Chalkidis/unraid-logsviewer?label=Issues" style="margin: 4px;" />&nbsp;
  <img src="https://img.shields.io/github/license/Lazaros-Chalkidis/unraid-logsviewer?label=License" style="margin: 4px;" />
</p>

---

## Features

- **Dashboard Widget** with live auto-refresh and severity proportion strip
- **Tools Page** for full-screen, focused log viewing
- **System Logs**: Syslog, Dmesg, GraphQL API, Nginx Errors, PHP Log, Libvirt
- **Docker Logs** with real-time running/stopped status indicators
- **VM Logs** with real-time running/stopped status indicators
- **Search**: match highlighting with next/prev navigation
- **Filtering**: by severity level (Info, Warnings, Errors, Critical) or login events
- **Severity Badges**: clickable counters that double as quick filters
- **Proportion Strip**: color bar in the footer showing the error/warning/info ratio at a glance
- **Syntax Highlighting**: Highlight.js and Prism.js bundled locally, no CDN calls
- **Autoscroll**: follows new entries as they arrive, with pause-on-hover option
- **Export**: `.log`, `.txt` or structured `.json` with parsed timestamps and levels
- **Responsive**: works from wide monitors down to phones (five breakpoints)
- **Theme Support**: Black, Gray, Azure and White
- **Independent Settings**: Dashboard widget and Tool page configured separately
- **Performance Friendly**: single-source polling, content hash detection, pre-compiled regex, smart tail limits

---

### Dashboard Widget PC Screen
![Dashboard with Syntax Highlighting](screenshots/pc/pc-dashboard-full-settings-syntax-on.png)
![Dashboard with Docker Logs](screenshots/pc/pc-dashboard-full-settings-syntax-on-docker.png)

### Tool Page PC Screen
![Tool Page](screenshots/pc/pc-tool-page-full-settings-syntax-on.png)

---

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

---

## Configuration

Go to **Settings → Logs Viewer** after installing. The Dashboard and Tool page have their own tabs with independent settings.

| Setting | What it does |
|---------|-------------|
| Auto Refresh | Enable/disable live polling |
| Refresh Interval | Poll frequency in seconds |
| Tail Lines | Cap the number of lines shown |
| Font Size & Family | Adjust log readability (default: Large) |
| Syntax Highlighting | Pick Highlight.js or Prism.js (beta) |
| Search | Enable in-log search with highlighting |
| Filter Dropdown | Quick severity filter in the tabs rail |
| Badges / Timestamp / Toast | Toggle individual footer elements |
| Export Format | Default format for downloads (.log / .txt / .json) |
| Log Sources | Choose which System logs, Docker containers and VMs to show |

---

## Log Sources

### System Logs
Syslog, Dmesg, Nginx Errors, GraphQL API, PHP Log, Libvirt. Selectable per page.

### Docker Logs
Automatically discovers all containers. Each entry shows a green or red dot for running/stopped state. Select which ones to monitor.

### VM Logs
Automatically discovers all VMs. Same status dots. Select which ones to monitor.

---

## Export Formats

| Format | Description |
|--------|-------------|
| `.log` | Plain text |
| `.txt` | Plain text |
| `.json` | Structured: parsed timestamp, level, hostname and service per line |

---

### Settings Page PC Screen
![Settings Page](screenshots/pc/pc-settings-page.png)

---

## Security

- CSRF nonce on every API request (hourly rotation, stored in /tmp)¹
- Rate limiting: 60 requests/minute per IP
- Origin validation blocks cross-origin requests
- XSS sanitizer strips all span attributes except class, validates values against a character whitelist
- All htmlspecialchars calls use ENT_QUOTES
- INI writes strip control characters to block injection
- Whitelist validators on all settings fields (interval, theme, engine, format, font size, etc.)
- VM log paths checked with realpath to prevent directory traversal
- Content-hash parameter validated against a strict hex regex
- Security headers on all API responses (X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy)
- MD5 package integrity check on install

**File permissions:**
- Plugin directory: 755
- PHP / Page / Asset files: 644
- Config file and directory: 600 / 700
- Cache directory: 700
- No world-writable files

¹ Custom nonce instead of Unraid's built-in csrf_token. Deliberate choice to keep the API self-contained.

---

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
│   ├── css/                        # widget.css, tool.css, settings.css
│   ├── js/                         # logsviewer.js (18 sections, TOC at top)
│   ├── vendor/                     # hljs + prism (local bundles)
│   ├── Logsviewer.page             # Dashboard widget
│   ├── LogsviewerTool.page         # Tools page
│   ├── LogsviewerSettings.page     # Settings page
│   └── logsviewer_api.php          # Backend API
├── screenshots/
├── build.sh
├── CHANGELOG.md
├── logsviewer.plg
└── logsviewer.xml
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md)

---

## Issues & Support

Bug reports, feature requests or general feedback:
- [GitHub Issues](https://github.com/Lazaros-Chalkidis/unraid-logsviewer/issues)
- [Unraid Forum Thread](https://forums.unraid.net/topic/197621-plugin-logs-viewer-real-time-log-viewer-dashboard-widget-for-unraid/)

---

## Author

**Lazaros Chalkidis** — [@Lazaros-Chalkidis](https://github.com/Lazaros-Chalkidis)

---

## License

Copyright (C) 2026 Logs Viewer Unraid Plugin - Lazaros Chalkidis

Licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).
See the `LICENSE` file for the full text.