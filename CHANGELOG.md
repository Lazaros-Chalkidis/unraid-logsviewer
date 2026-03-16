# Changelog

## Version 2026.03.16

### Performance
- Fixed browser freezing during auto-refresh on large logs (render skip when content unchanged)
- Docker logs now load in parallel instead of one-by-one (faster with multiple containers)
- Reduced unnecessary server requests during polling
- Faster line counting for large log files
- Improved server-side response caching
- Google Fonts no longer block page loading
- Fixed incorrect mobile detection on low-core servers (Celeron, J-series, i3)
- Removed redundant background timer

### Fixes
- Single quotes in logs now display correctly instead of showing as &#039;

## Version 2026.03.14

### Improvements
- Plugin: added Title display in Plugins page
- Plugin: minimum Unraid version updated to 7.2.0
- Security: support URL corrected to official forum thread
- Plugin: file permissions corrected (page files 644 instead of 755)


## Version 2026.03.07

### First release
- Dashboard Widget for real-time log monitoring directly from the Unraid dashboard.
- Dedicated Tools page for full screen log viewing.
- Support for System logs: Syslog, Dmesg, GraphQL API, Nginx Errors, Libvirt.
- Support for Docker container logs with automatic container discovery.
- Support for VM logs with automatic VM discovery.
- Active log highlight in dropdowns, selected item is visually marked across all tabs.
- Search functionality with real time match counter and toast feedback.
- Log level filters: Info, Warnings, Errors, Critical with color coded badges.
- Status badges in footer showing live count of Info, Warnings, Errors and Critical entries.
- Optional syntax highlighting via Highlight.js or Prism (beta), two selectable engines.
- Performance safeguards for large logs: auto trim with "Large log" toast notification.
- Autoscroll toggle with smooth scroll to bottom behavior.
- Export log to file action (log, txt, json).
- Login toast notifications (success / failed) with IP detection.
- Tail lines presets: full log, 200, 500, 800, 1500 lines.
- Automatic refresh with configurable interval.
- Settings page with full configuration options.
- Dark theme with custom color support and CSS variable theming.
- Fully responsive layout compatible with all screen sizes, including mobile devices introduced in Unraid 7.2.x
- Resizable Widget: Adjustable height for the dashboard widget and tool