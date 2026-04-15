
# Logs Viewer

## 2026.04.15

### New Features
- Syslog Previous added as a selectable system log source in Dashboard and Tool page
- Three new theme presets: Midnight, Ocean and Monokai
- Log Backups: scheduled daily compressed backups of all enabled sources (system, Docker, VMs) with retention control, calendar view and one-click ZIP download
- Alert system: pattern-based rules that scan logs at configurable intervals and send notifications through Unraid's notification system, with built-in presets and alert history

## 2026.04.06

### Fixed
- Perf/syntax toast no longer gets stuck after using search, properly auto-dismisses after 6 seconds and does not reappear on the same log
- Hex color input was not accepting manual values
- Toast right side content was clipped on smaller widgets
- Theme preset selection (Terminal, Dim, Contrast) was not saving due to a mismatched validation whitelist
- Toast background no longer follows the log panel color when a theme preset is active, only when Default preset with a manual background color

### New Features
- Toast panel split into two slots: left side keeps existing messages (selected log, search, login, perf), right side shows contextual info
- File size displayed permanently on the right side of the toast bar
- New lines indicator: "+N new lines" in green when new lines are detected between polls
- Error spike indicator: "+N err" in orange when error count increases between polls
- Critical spike indicator: "+N crit" in red when critical count increases between polls
- Indicators persist until the next poll cycle brings new data
- "Paused" indicator appears on the right side of the toast when hovering over the log panel (requires pause on hover enabled)
- Toast background color in dark theme now follows the Log background color setting

### Improvements
- Default log background color changed to #1b1b1b
- Hex color input field now accepts manual typing (applied on blur or Enter, reverts if invalid)
- System Logs / Docker Logs / VM Logs sections in Settings redesigned to match the rest of the page (label column with checkbox and name on the left, path and size on the right, alternating row backgrounds, styled note and action rows)
- Toast separator lines made more visible
- File size added to all API responses with zero additional server overhead
- Settings page buttons (Apply, Reset to Defaults, Done) restyled to match StreamViewer design with color-coded variants (green for Apply, orange for Reset, neutral for Done)
- Log source action buttons (Select All, Deselect All, Scan) restyled to match the same design language

## 2026.03.31

### Bug Fixes
- Syntax dropdown not working on Unraid 7.2+ where tiles load after the page (switched to event delegation)
- HTML entities appearing literally in syntax highlighted output (added decode step before engine processing)
- Hover transition on buttons causing a diagonal fade out artifact (fixed across all stylesheets)
- Toast, hover backgrounds and toggle knob not adapting to Azure and White themes (replaced hardcoded colors with CSS variables)
- Log header highlight too faint on light theme backgrounds
- Critical badge staying dim when selected as active filter (added dedicated highlight class with proper specificity)
- Error badge color not matching the log level highlight used inside the log panel (changed to deep orange)
- Docker and VM dropdowns showing no running/stopped indicators (API was returning a generic placeholder instead of real states)
- Login toast shared between Dashboard and Tool pages (localStorage keys now prefixed with page context)
- Missing Syntax Engine and Show Toast entries in the reset to defaults maps for both Dashboard and Tool
- Section header accidentally placed inside a JS function body, breaking storageKey

### New Features
- Color coded proportion strip in the footer showing the ratio of info, warning, error and critical lines at a glance
- Colored category dots next to System (blue), Dockers (green) and VMs (orange) tab names
- Green or red status dot next to each Docker container and VM in dropdown menus based on running state
- Clicking a severity badge now activates that filter and highlights the badge so you can see which filter is active
- Five responsive breakpoints covering tablets down to small phones (1024, 768, 560, 480, 360px)
- Full support for all four Unraid themes: Black, Gray, Azure and White
- Single source polling: auto refresh fetches only the log you are viewing instead of every enabled source
- Content hash detection: when a log has not changed, the server returns a tiny "unchanged" response instead of the full payload
- Syntax highlighting libraries bundled locally, removing external CDN dependency
- VM log path protected against directory traversal with realpath validation
- Eight new whitelist validators for settings fields that previously accepted any input
- Security headers added to the cached API response path

### Improvements
- Redesigned footer layout with line count and pulse on the left, severity badges in the center, clock and timestamp on the right
- Severity badges restyled as colored pills with subtle borders and hover lift
- Syntax and Filter controls moved into the tabs rail as compact pill buttons
- Dropdown menus now fit their content width and have separator lines between items
- Clock icon replaced with a clean SVG matching the StreamViewer widget, timestamp switched to 24-hour format
- Default log font size changed from Medium to Large for better readability out of the box
- Critical badge color brightened for better visibility on dark backgrounds
- On tablets the header stacks vertically and the tabs row wraps; on phones the footer fully stacks and controls shrink
- Tool page goes full width on small screens with reduced padding
- Settings page compacts its form rows, fonts and buttons on narrow viewports
- Enable/Disable toggle thumb enlarged to fill the track properly
- Source action buttons sized to work through Unraid framework overrides
- Level highlighting regex compiled once at startup and collapsed from twelve passes into a single pass lookup
- Level counting, filter matching and tail trimming all optimized to avoid unnecessary string allocations
- Docker and VM state lookups cached per request so the same shell command never runs twice in one poll
- All htmlspecialchars calls switched to ENT_QUOTES so single quotes are escaped
- Control characters stripped from config values before writing the INI file
- Boolean toggle fields routed through the yes/no sanitizer
- Content hash parameter validated against a strict hex regex before comparison
- HTML sanitizer strips all span attributes except class and validates class values against a character whitelist
- Stylesheet reorganized into labeled sections with all responsive rules gathered at the end
- JavaScript reorganized into 18 labeled sections with a table of contents
- Every setting stored independently for Dashboard and Tool with separate config keys

## v2026.03.21

### New Features
- Theme Support: Full compatibility with Unraid Dark / White / Gray /Azure themes across Dashboard widget, Tool page, and Settings page

### Changes
- Prism syntax engine promoted from Beta to stable

## Version 2026.03.17

### Fixes
- Fixed widget stopping after ~1 hour (automatic CSRF token renewal)
- Reset to Defaults now works independently per tab (Dashboard and Tool no longer affect each other)
- Fixed syntax selection being lost when resetting the other tab
- Fixed panel height being reset on both pages when only one was reset
- Removed stray config key that could reset Dashboard syntax engine when resetting Tool

### Removed
- Removed "Refresh only when scripts are running" option (was ineffective and caused confusion)

## Version 2026.03.16

### Performance
- Fixed browser freezing during auto refresh on large logs (render skip when content unchanged)
- Docker logs now load in parallel instead of one by one (faster with multiple containers)
- Reduced unnecessary server requests during polling
- Faster line counting for large log files
- Improved server side response caching
- Google Fonts no longer block page loading
- Fixed incorrect mobile detection on low-core servers (Celeron, J series, i3)
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
- Dashboard Widget for real time log monitoring directly from the Unraid dashboard.
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