<?php
/**
 * Tool tab: Logs
 * /plugins/logsviewer/include/tool-tab-logs.php
 *
 * Sidebar (source navigation), main pane (log content), breadcrumb, mode
 * toggle and status bar. Severity sparkline / density bar removed.
 */

// Pull enabled sources from plugin config (TOOL_ prefixed keys)
$enabledSystemLogs       = array_values(array_filter(array_map('trim', explode(',', $cfg['TOOL_ENABLED_SYSTEM_LOGS'] ?? ''))));
$enabledDockerContainers = array_values(array_filter(array_map('trim', explode(',', $cfg['TOOL_ENABLED_DOCKER_CONTAINERS'] ?? ''))));
$enabledVms              = array_values(array_filter(array_map('trim', explode(',', $cfg['TOOL_ENABLED_VMS'] ?? ''))));
$enabledCustomLogs       = array_values(array_filter(array_map('trim', explode(',', $cfg['TOOL_ENABLED_CUSTOM_LOGS'] ?? ''))));

if (!$enabledSystemLogs) $enabledSystemLogs = ['syslog', 'dmesg', 'graphql-api.log', 'nginx-error'];

// "Hide empty logs" rule, applied server-side so it holds from the very first
// page load (the dashboard widget applies the same rule). A system source
// whose file is missing, unreadable, or 0 bytes is dropped from the sidebar.
// This is why e.g. dmesg does not show: /var/log/dmesg is 0B on a standard
// Unraid box, so it would otherwise render a "log not found" error. Custom
// logs keep their own keys and are left untouched here.
$systemLogPaths = [
    'syslog'          => '/var/log/syslog',
    'syslog-previous' => '/boot/logs/syslog-previous',
    'dmesg'           => '/var/log/dmesg',
    'graphql-api.log' => '/var/log/graphql-api.log',
    'nginx-error'     => '/var/log/nginx/error.log',
    'phplog'          => '/var/log/phplog',
    'libvirt'         => '/var/log/libvirt/libvirtd.log',
];
$enabledSystemLogs = array_values(array_filter($enabledSystemLogs, function ($key) use ($systemLogPaths) {
    if (!isset($systemLogPaths[$key])) return true; // unknown/custom key: leave as-is
    $p = $systemLogPaths[$key];
    return @is_file($p) && @is_readable($p) && (int)@filesize($p) > 0;
}));

// Friendly labels for system log identifiers
$systemLogNames = [
    'syslog'          => 'Syslog',
    'syslog-previous' => 'Syslog Previous',
    'dmesg'           => 'Dmesg',
    'graphql-api.log' => 'GraphQL API',
    'nginx-error'     => 'Nginx Errors',
    'phplog'          => 'PHP Log',
    'libvirt'         => 'Libvirt',
];

// Merge user-defined custom log paths (label only — JS doesn't need the path)
$_customFile = '/boot/config/plugins/logsviewer/custom-paths.json';
$customLogLabels = []; // slug -> label
if (is_file($_customFile)) {
    $_arr = @json_decode((string)@file_get_contents($_customFile), true);
    if (is_array($_arr)) {
        foreach ($_arr as $_e) {
            if (!is_array($_e)) continue;
            $lbl = (string)($_e['label'] ?? '');
            $pth = (string)($_e['path']  ?? '');
            if ($lbl === '' || $pth === '') continue;
            $allowed = false;
            foreach (['/var/log/', '/mnt/user/', '/mnt/cache/'] as $px) {
                if (strpos($pth, $px) === 0) { $allowed = true; break; }
            }
            if (!$allowed || strpos($pth, '..') !== false) continue;
            $slug = strtolower(preg_replace('/[^a-z0-9]+/', '-', strtolower($lbl)));
            $slug = trim((string)$slug, '-');
            if ($slug !== '') $customLogLabels['custom:' . $slug] = $lbl;
        }
    }
}

// Docker container states (running/exited/stopped) for visual indication
$dockerStates = [];
if (!empty($enabledDockerContainers)) {
    $raw = @shell_exec('docker ps -a --format "{{.Names}}\t{{.State}}" 2>/dev/null');
    if ($raw) {
        foreach (array_filter(explode("\n", trim($raw))) as $line) {
            $p = explode("\t", $line);
            if (count($p) >= 2) $dockerStates[trim($p[0])] = trim($p[1]);
        }
    }
}

// VM states
$vmStates = [];
if (!empty($enabledVms)) {
    $raw = @shell_exec('virsh list --all 2>/dev/null');
    if ($raw) {
        foreach (array_filter(explode("\n", trim($raw))) as $line) {
            if (preg_match('/^\s*\d+\s+(\S+)\s+(.+)$/', $line, $m)) {
                $vmStates[trim($m[1])] = (stripos(trim($m[2]), 'running') !== false) ? 'running' : 'stopped';
            }
        }
    }
}

// Helper to render a single source row
$renderSource = function(string $category, string $name, string $label, string $stateClass = 'lvt-dot--idle', string $stateTitle = ''): string {
    $nameAttr  = htmlspecialchars($name,  ENT_QUOTES);
    $labelHtml = htmlspecialchars($label, ENT_QUOTES);
    $catAttr   = htmlspecialchars($category, ENT_QUOTES);
    $title     = $stateTitle !== '' ? ' title="' . htmlspecialchars($stateTitle, ENT_QUOTES) . '"' : '';
    return '<div class="lvt-source" role="button" tabindex="0"'
         . ' data-cat="' . $catAttr . '" data-name="' . $nameAttr . '" data-label="' . $labelHtml . '"' . $title . '>'
         . '<span class="lvt-source__dot ' . $stateClass . '" aria-hidden="true"></span>'
         . '<span class="lvt-source__label">' . $labelHtml . '</span>'
         . '<span class="lvt-source__size" aria-hidden="true"></span>'
         . '</div>';
};

// Total counts per group for badges
$systemCount = count($enabledSystemLogs);
$dockerCount = count($enabledDockerContainers);
$vmCount     = count($enabledVms);
$customCount = count($enabledCustomLogs);
?>
<div class="lvt-tab-panel" id="lvtPanelLogs">

  <!-- Tab header -->
  <div class="lvt-header">
    <div class="lvt-header__left">
      <img src="/plugins/logsviewer/img/logsviewermain.png" class="lvt-header__icon" alt="">
      <div>
        <h2 class="lvt-header__title">Logs</h2>
        <span class="lvt-header__sub">Browse log sources from your server</span>
      </div>
    </div>
    <div class="lvt-header__right">
      <div class="lvt-header__icons">
        <a href="#" id="lvtLogsDownload" title="Download current log" aria-label="Download current log"><i class="fa fa-fw fa-arrow-down" aria-hidden="true"></i></a>
        <a href="/Settings/LogsviewerSettings" title="Logs Viewer Settings" aria-label="Logs Viewer Settings"><i class="fa fa-fw fa-cog" aria-hidden="true"></i></a>
      </div>
    </div>
  </div>

  <!-- Layout: sidebar + main pane -->
  <div class="lvt-logs-layout">

    <!-- Sidebar -->
    <aside class="lvt-sidebar" id="lvtSidebar" aria-label="Log sources">

      <?php if ($systemCount > 0): ?>
      <div class="lvt-sidebar__group" data-group="system">
        <div class="lvt-sidebar__group-header">
          <span><i class="fa fa-server" aria-hidden="true"></i> System</span>
          <span class="lvt-sidebar__group-count"><?= $systemCount ?></span>
        </div>
        <?php foreach ($enabledSystemLogs as $name):
          $label = $systemLogNames[$name] ?? ($customLogLabels[$name] ?? ucfirst($name));
          // Default to "active" (green) so every source ships with a coloured
          // indicator from page-load. The JS updateActiveSourceDot() refines
          // this to amber/red after the first fetch if severity warrants it.
          echo $renderSource('system', $name, $label, 'lvt-dot--active', 'Available');
        endforeach; ?>
      </div>
      <?php endif; ?>

      <?php if ($dockerCount > 0): ?>
      <div class="lvt-sidebar__group" data-group="docker">
        <div class="lvt-sidebar__group-header">
          <span><i class="fa fa-cube" aria-hidden="true"></i> Docker Containers</span>
          <span class="lvt-sidebar__group-count"><?= $dockerCount ?></span>
        </div>
        <?php foreach ($enabledDockerContainers as $name):
          $state = strtolower($dockerStates[$name] ?? 'unknown');
          $dotClass = 'lvt-dot--idle';
          $title    = 'Unknown state';
          if ($state === 'running')             { $dotClass = 'lvt-dot--active'; $title = 'Running'; }
          elseif (in_array($state, ['exited','dead','created','restarting','paused'], true))
                                                { $dotClass = 'lvt-dot--error';  $title = ucfirst($state); }
          echo $renderSource('docker', $name, $name, $dotClass, $title);
        endforeach; ?>
      </div>
      <?php endif; ?>

      <?php if ($vmCount > 0): ?>
      <div class="lvt-sidebar__group" data-group="vm">
        <div class="lvt-sidebar__group-header">
          <span><i class="fa fa-desktop" aria-hidden="true"></i> VMs</span>
          <span class="lvt-sidebar__group-count"><?= $vmCount ?></span>
        </div>
        <?php foreach ($enabledVms as $name):
          $state    = $vmStates[$name] ?? 'unknown';
          $dotClass = ($state === 'running') ? 'lvt-dot--active' : 'lvt-dot--error';
          $title    = ucfirst($state);
          echo $renderSource('vm', $name, $name, $dotClass, $title);
        endforeach; ?>
      </div>
      <?php endif; ?>

      <?php if ($customCount > 0): ?>
      <div class="lvt-sidebar__group" data-group="custom">
        <div class="lvt-sidebar__group-header">
          <span><i class="fa fa-file-text-o" aria-hidden="true"></i> Custom</span>
          <span class="lvt-sidebar__group-count"><?= $customCount ?></span>
        </div>
        <?php foreach ($enabledCustomLogs as $name):
          $label = $customLogLabels['custom:' . $name] ?? $customLogLabels[$name] ?? $name;
          // Same "default to active" treatment as system logs above.
          echo $renderSource('custom', $name, $label, 'lvt-dot--active', 'Available');
        endforeach; ?>
      </div>
      <?php endif; ?>

      <?php if (!$systemCount && !$dockerCount && !$vmCount && !$customCount): ?>
      <div class="lvt-sidebar__empty">
        <i class="fa fa-info-circle" aria-hidden="true"></i>
        <p>No sources enabled.<br><a href="/Settings/LogsviewerSettings">Open Settings</a> to enable some.</p>
      </div>
      <?php endif; ?>

    </aside>

    <!-- Main pane -->
    <main class="lvt-main">

      <div class="lvt-main__header">
        <div class="lvt-sev-bar" id="lvtSevBar" aria-label="Severity filters">
          <button type="button" class="lvt-sev-count lvt-sev-count--info"     data-sev="info"     data-sev-filter="only-info">Info <strong id="lvtCountInfo">0</strong></button>
          <button type="button" class="lvt-sev-count lvt-sev-count--warning"  data-sev="warning"  data-sev-filter="only-warning">Warnings <strong id="lvtCountWarn">0</strong></button>
          <button type="button" class="lvt-sev-count lvt-sev-count--error"    data-sev="error"    data-sev-filter="only-error">Errors <strong id="lvtCountErr">0</strong></button>
          <button type="button" class="lvt-sev-count lvt-sev-count--critical" data-sev="critical" data-sev-filter="critical">Critical <strong id="lvtCountCrit">0</strong></button>
          <div class="lvt-filter-dd" id="lvtFilterDd">
            <button type="button" class="lvt-filter-dd__btn" id="lvtFilterDdBtn" aria-haspopup="true" aria-expanded="false" title="Cumulative severity filter">
              <i class="fa fa-filter" aria-hidden="true"></i> Filter <i class="fa fa-caret-down" aria-hidden="true"></i>
            </button>
            <div class="lvt-filter-dd__menu" id="lvtFilterDdMenu" role="menu" hidden>
              <button type="button" class="lvt-filter-dd__item" role="menuitemradio" data-level="info">Info and above</button>
              <button type="button" class="lvt-filter-dd__item" role="menuitemradio" data-level="warning">Warning and above</button>
              <button type="button" class="lvt-filter-dd__item" role="menuitemradio" data-level="error">Error and Critical</button>
            </div>
          </div>
        </div>
        <div class="lvt-modes" role="tablist" aria-label="View mode">
          <button type="button" class="lvt-mode is-active" data-mode="live" aria-pressed="true">Live</button>
          <button type="button" class="lvt-mode" data-mode="merge" aria-pressed="false">Merge</button>
        </div>
      </div>

      <!-- Text filter bar: shown only while a text filter is active (set via
           right-click "Filter on selection" or a saved preset). Severity
           filtering now lives in the header pills + Filter dropdown, so the
           old level <select> was removed from here. -->
      <div class="lvt-filter-bar" id="lvtFilterBar" hidden>
        <div class="lvt-filter-bar__input">
          <i class="fa fa-search" aria-hidden="true"></i>
          <input type="text" id="lvtFilterSearch" placeholder="Filter text in current log…" aria-label="Search">
        </div>
        <span class="lvt-filter-bar__count" id="lvtFilterCount" hidden></span>
        <button type="button" class="lvt-filter-bar__clear" id="lvtFilterClear" title="Clear text filter" aria-label="Clear text filter">
          <i class="fa fa-times" aria-hidden="true"></i>
        </button>
      </div>

      <!-- Merge bar (hidden by default; shown when Merge mode is active) -->
      <div class="lvt-merge-bar" id="lvtMergeBar" hidden>
        <div class="lvt-merge-bar__info">
          <i class="fa fa-link" aria-hidden="true"></i>
          <span id="lvtMergeBarText">Pick 2+ sources from the sidebar to merge them by timestamp</span>
        </div>
        <div class="lvt-merge-bar__chips" id="lvtMergeBarChips"></div>
        <button type="button" class="lvt-iconbtn" id="lvtMergeClear" title="Clear merge selection" aria-label="Clear">
          <i class="fa fa-times" aria-hidden="true"></i>
        </button>
      </div>

      <div class="lvt-log-content" id="lvtLogContent" tabindex="0">
        <div class="lvt-log-placeholder">
          <i class="fa fa-list-alt" aria-hidden="true"></i>
          <p>Choose a source from the left to start viewing logs.</p>
        </div>
      </div>

      <!-- Status bar -->
      <div class="lvt-statusbar" id="lvtStatusbar">
        <div class="lvt-statusbar__left">
          <span class="lvt-statusbar__item"><i class="fa fa-list-ol" aria-hidden="true"></i> <strong id="lvtTotalLines">0</strong> lines</span>
        </div>
        <div class="lvt-statusbar__center">
          <div class="lvt-statusbar__search">
            <i class="fa fa-search" aria-hidden="true"></i>
            <input type="text" id="lvtFooterSearch" placeholder="Search current log..." autocomplete="off" spellcheck="false">
            <button type="button" class="lvt-statusbar__search-clear" id="lvtFooterSearchClear" title="Clear search" aria-label="Clear search" hidden><i class="fa fa-times" aria-hidden="true"></i></button>
          </div>
        </div>
        <div class="lvt-statusbar__right">
          <span class="lvt-poll-indicator" id="lvtPollIndicator" hidden>
            <span class="lvt-poll-dot"></span>
            <span id="lvtPollLabel">5sec · LIVE</span>
          </span>
        </div>
      </div>

    </main>

  </div>
</div>
