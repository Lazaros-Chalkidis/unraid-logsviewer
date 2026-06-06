/* ═══════════════════════════════════════════════════════════════════════════
   Logs Viewer -- Tool Page :: Logs Tab
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   /plugins/logsviewer/js/logsviewer-tool-logs.js

   Source nav, log render, polling, mode toggle (Live, Merge),
   status bar. Sidebar dots reflect source state (server-side) and are not
   changed on selection.

   Binding strategy: document-level delegation for globals so events survive
   cached HTML swaps; local rebinds in onShow() for non-bubbling events like
   scroll.
   ═══════════════════════════════════════════════════════════════════════════ */
/* global $ */

(function () {
'use strict';

if (window.__lvtLogsLoaded) return;
window.__lvtLogsLoaded = true;

var _cfg     = window.lvToolConfig || {};
var _apiUrl  = _cfg.apiUrl  || '/plugins/logsviewer/include/logsviewer_api.php';
var _token   = _cfg.lvToken || '';
var _tokenRetried = false;  // guard: only refresh nonce once per failed fetch

// ── State ────────────────────────────────────────────────────────────────
var _active     = null;     // { category, name, label }
var _currentRow = null;     // last row returned by API (has file_size, total_lines)
var _rawLines   = [];       // string[] - log lines after unescape
var _sevs       = [];       // string[] - per-line severity (parallel to _rawLines)
var _counts     = { info: 0, warning: 0, error: 0, critical: 0, success: 0 };

var _mode        = 'live';   // 'live' | 'merge'
var _paused      = false;    // when true, live auto-refresh (polling) is suspended
var _filterText  = '';       // text filter (set via context-menu "Filter on selection" or a saved preset)
var _filterLevel = '';       // severity filter (set via the header pills / Filter dropdown)
var _filterTimer = null;

var _pollTimer   = null;
var _refreshSecs = (function () {
    var n = parseInt(_cfg.refreshSecs, 10);
    return (n === 3 || n === 5 || n === 10 || n === 20) ? n : 5;
})();
var _pollMs      = _refreshSecs * 1000;
var _exportFormat = (function () {
    var f = String(_cfg.exportFormat || 'txt').toLowerCase();
    return (f === 'txt' || f === 'json' || f === 'csv') ? f : 'txt';
})();
var _inFlight    = false;
var _lastHash    = null;
var _autoScroll  = true;
var _visible     = false;
var _lastUpdate  = null;     // Date object

// Context menu state (right-click on a log line)
var _ctxLine      = '';
var _ctxSelection = '';
var _ctxMenuOpen  = false;  // right-click menu is open: hold the hover-pause
var _pointerInLog = false;  // pointer is currently over the log area

// Merge mode state
var _mergeSources    = []; // [{ category, name, label }]
var _mergeApplyTimer = null;
var _mergeInFlight   = 0;  // count of pending source fetches



// Severity classifiers (first match wins)
var SEV_RULES = [
    { re: /\b(emerg(?:ency)?|critical|fatal|panic)\b/i, cls: 'critical' },
    { re: /\b(error|err)\b/i,                            cls: 'error'    },
    { re: /\b(warn(?:ing)?)\b/i,                         cls: 'warning'  },
    { re: /\bsuccessful (?:login|logout)\b/i,            cls: 'success'  },
    { re: /\b(info|notice)\b/i,                          cls: 'info'     }
];

// Level filter thresholds: which severities to KEEP for each option.
// Three families:
//   * "and above" composites (warning / error)       - critical implicitly included
//   * "only-X" single-severity filters               - one severity only
//   * legacy 'critical' / 'info'                     - 'critical' doubles as the
//     new "Critical" single-severity option; 'info' is kept so saved filters
//     created under the old "Info and above" label still load correctly even
//     after the dropdown lost that entry.
var LEVEL_KEEP = {
    'critical':     { critical: 1 },
    'error':        { critical: 1, error: 1 },
    'warning':      { critical: 1, error: 1, warning: 1 },
    'info':         { critical: 1, error: 1, warning: 1, info: 1, success: 1 },
    'only-info':    { info: 1 },
    'only-warning': { warning: 1 },
    'only-error':   { error: 1 }
};

// ── Register with the shell ──────────────────────────────────────────────
window.LVT_TAB = window.LVT_TAB || { _handlers: {}, register: function(t,h){ this._handlers[t]=h; } };
window.LVT_TAB.register('logs', {
    init:    function () { onShow(/*firstTime=*/true); },
    refresh: function () { onShow(/*firstTime=*/false); },
    hide:    function () { onHide(); }
});

// ── One-time global wiring (runs at script load) ─────────────────────────
bindGlobal();

function bindGlobal() {
    $(document)
      // Sidebar source selection
      .on('click',   '#lvtSidebar .lvt-source', function () { selectSourceFromEl(this); })
      .on('keydown', '#lvtSidebar .lvt-source', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectSourceFromEl(this);
          }
      })
      // Download current log -- same icon position the widget uses in its
      // tile header (refresh, download, tool-link, cog). On the Tool page
      // the tool-link slot is dropped (we are already here), so download
      // sits right between refresh and settings. Pulls from _rawLines so
      // it always reflects what is loaded in the current mode.
      .on('click', '#lvtLogsDownload', function (e) {
          e.preventDefault();
          downloadCurrentLog();
      })
      // Mode toggle (Live / Merge).
      .on('click', '.lvt-mode:not(:disabled)', function () {
          var m = $(this).data('mode');
          if (m === _mode) return;
          setMode(m);
      })
      // Auto-pause: hovering the log area suspends live auto-refresh so the
      // newest lines do not scroll away while reading / selecting. Leaving
      // resumes. Only meaningful in live mode with an active source.
      .on('mouseenter', '#lvtLogContent', function () {
          _pointerInLog = true;
          setPaused(true);
      })
      .on('mouseleave', '#lvtLogContent', function () {
          _pointerInLog = false;
          // Do not resume while the right-click menu is open, even though the
          // pointer moved off the log onto the menu - otherwise new lines
          // could scroll in and shift what the user is about to copy/filter.
          if (!_ctxMenuOpen) setPaused(false);
      })
      // Severity pill click: toggle a single-severity filter on/off
      .on('click', '.lvt-sev-count[data-sev-filter]', function () {
          var lvl = String($(this).data('sev-filter') || '');
          setSeverityFilter(_filterLevel === lvl ? '' : lvl);
      })
      // Filter dropdown: open / close
      .on('click', '#lvtFilterDdBtn', function (e) {
          e.stopPropagation();
          var $menu = $('#lvtFilterDdMenu');
          var willOpen = $menu.prop('hidden');
          $menu.prop('hidden', !willOpen);
          $('#lvtFilterDdBtn').attr('aria-expanded', willOpen ? 'true' : 'false');
      })
      // Filter dropdown: pick a cumulative level (toggles off if re-picked)
      .on('click', '.lvt-filter-dd__item', function (e) {
          e.stopPropagation();
          var lvl = String($(this).data('level') || '');
          setSeverityFilter(_filterLevel === lvl ? '' : lvl);
          $('#lvtFilterDdMenu').prop('hidden', true);
          $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
      })
      // Text filter input (bar is shown only when a text filter is active)
      .on('input',  '#lvtFilterSearch', function () {
          _filterText = String(this.value || '');
          syncSearchInputs(_filterText, this.id);
          scheduleFilterApply();
      })
      .on('click',  '#lvtFilterClear', function () {
          clearTextFilter();
          applyFilter();
      })
      // Persistent footer search box (mirrors the filter-bar search)
      .on('input', '#lvtFooterSearch', function () {
          _filterText = String(this.value || '');
          syncSearchInputs(_filterText, this.id);
          scheduleFilterApply();
      })
      .on('click', '#lvtFooterSearchClear', function () {
          clearTextFilter();
          applyFilter();
      })
      // Merge bar: clear all selected sources
      .on('click', '#lvtMergeClear', function (e) {
          e.preventDefault();
          clearMergeSelection();
      })
      // Merge bar: remove a single source chip
      .on('click', '.lvt-merge-chip__x', function (e) {
          e.preventDefault();
          var key = String($(this).data('key') || '');
          if (key) removeMergeSourceByKey(key);
      });

    // Pause polling when the browser tab is hidden
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopPolling();
        else if (_visible && _active) startPolling();
    });

    // Build the context menu element (lives at body level so it floats above everything)
    buildContextMenu();

    // Right-click on a log line → show context menu
    $(document).on('contextmenu', '#lvtLogContent .lvt-log-line', function (e) {
        e.preventDefault();
        _ctxLine = $(this).text();
        var sel  = (window.getSelection && String(window.getSelection() || '').trim()) || '';
        _ctxSelection = sel;
        showContextMenu(e.clientX, e.clientY, $(this));
    });

    // Any click outside the menu closes it
    $(document).on('click', function (e) {
        var $tgt = $(e.target);
        if (!$tgt.closest('#lvtLogCtxMenu').length) hideContextMenu();
        // Close the Filter dropdown when clicking outside it
        if (!$tgt.closest('#lvtFilterDd').length) {
            $('#lvtFilterDdMenu').prop('hidden', true);
            $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
        }
    });

    // Escape closes the menu
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && !$('#lvtLogCtxMenu').prop('hidden')) hideContextMenu();
        if (e.key === 'Escape' && !$('#lvtFilterDdMenu').prop('hidden')) {
            $('#lvtFilterDdMenu').prop('hidden', true);
            $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
        }
    });

    // Menu item clicks
    $(document).on('click', '#lvtLogCtxMenu .lvt-ctxmenu__item:not(.lvt-ctxmenu__item--disabled)', function (e) {
        e.preventDefault();
        var act = $(this).data('action');
        hideContextMenu();
        if      (act === 'copy')   copyCurrentLine();
        else if (act === 'filter') filterOnSelection();
    });
}

// ── Local bindings (DOM is swapped between tab views, so rebind each show) ──
function bindLocal() {
    var el = document.getElementById('lvtLogContent');
    if (!el) return;
    el.onscroll = function () {
        var atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;
        _autoScroll = atBottom;
    };
}

// ── Show / hide hooks ────────────────────────────────────────────────────
function onShow(firstTime) {
    _visible = true;
    bindLocal();

    // Pull per-source file sizes into the sidebar (one lightweight call).
    fetchSidebarSizes();

    applyModeUI();
    applySevFilterUI();

    // In merge mode, restore selection visuals and re-fetch (no single-source flow)
    if (_mode === 'merge') {
        applyMergeSelectionUI();
        if (_mergeSources.length) scheduleMergeFetch();
        else                       renderMergeEmpty();
        return;
    }

    if (_active) {
        // Returning to the tab — restore visual state in the (possibly fresh) DOM
        $('#lvtSidebar .lvt-source').removeClass('is-active');
        $('#lvtSidebar .lvt-source[data-cat="' + _active.category + '"][data-name="' + cssEsc(_active.name) + '"]')
            .addClass('is-active');
        $('#lvtBreadcrumbCategory').text(prettyCategory(_active.category));
        $('#lvtBreadcrumbSource').text(_active.label);
        _paused = false;
        updatePollIndicator();

        // Restore the text filter bar if a text filter is active (set earlier
        // via context-menu or preset), and reflect the current severity
        // filter on the header pills / Filter dropdown.
        if (_filterText) {
            $('#lvtFilterSearch').val(_filterText);
            $('#lvtFilterBar').prop('hidden', false);
        }
        applySevFilterUI();

        // If we already have data in memory, render it immediately while a fresh
        // fetch is in flight — avoids a "Loading…" flash on tab re-entry.
        if (_rawLines.length) {
            renderVisible();
            updateStatusbar();
        }

        fetchOnce(/*resetHash=*/true);
        startPolling();
    } else {
        // No source chosen yet — auto-select the first one in the sidebar.
        var $first = $('#lvtSidebar .lvt-source').first();
        if ($first.length) selectSourceFromEl($first[0]);
    }
}

function onHide() {
    _visible = false;
    stopPolling();
}

// ── Mode toggle ──────────────────────────────────────────────────────────
function setMode(m) {
    if (m !== 'live' && m !== 'merge') return;
    _mode = m;
    _paused = false; // a view-mode switch always starts a fresh (un-paused) view
    applyModeUI();

    if (m === 'merge') {
        stopPolling();
        clearTextFilter();
        applyMergeSelectionUI();
        if (_mergeSources.length === 0) renderMergeEmpty();
        else scheduleMergeFetch();
    } else {
        // 'live' — clear text filter, drop selection visuals, resume polling.
        // The severity filter (_filterLevel) is intentionally preserved across
        // mode switches so a chosen Info/Warning/etc. filter survives a trip
        // through Merge and back.
        clearTextFilter();
        $('#lvtSidebar .lvt-source').removeClass('is-merge-selected');
        if (_active) {
            // Merge repurposes the shared single-source buffers
            // (_rawLines / _sevs / _counts) for its merged payload, and
            // renderMergeEmpty clears them outright. So on the way back to
            // Live the buffer is often empty even though a source is still
            // active, which left the log pane blank until the user manually
            // hit Refresh. If the buffer is gone, re-fetch from scratch (same
            // as the Refresh button); if it survived, just re-render in place
            // with no network round-trip.
            if (_rawLines.length === 0) {
                _lastHash = null;
                $('#lvtLogContent').html(
                    '<div class="lvt-log-empty">' +
                      '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
                      '<div>Loading…</div>' +
                    '</div>'
                );
                fetchOnce(/*resetHash=*/true);
            } else {
                renderVisible();
            }
            startPolling();
        } else if (_rawLines.length === 0) {
            $('#lvtLogContent').html(
                '<div class="lvt-log-placeholder">' +
                  '<i class="fa fa-list-alt" aria-hidden="true"></i>' +
                  '<p>Choose a source from the left to start viewing logs.</p>' +
                '</div>'
            );
        }
    }
}

// ── Auto-pause (hover over the log area) ─────────────────────────────────
// Pause is no longer a button: it engages while the pointer is over the log
// area and releases when it leaves. The footer badge reflects the state,
// flipping to an amber "PAUSE" while held and back to green "live" on release.
function setPaused(paused) {
    // Only meaningful in live mode with an active source.
    if (_mode !== 'live' || !_active) return;
    if (paused === _paused) return;
    _paused = paused;
    updatePollIndicator();
    if (_paused) {
        stopPolling();
    } else {
        // Resume: pull once immediately so the user is not staring at stale
        // content, then resume the polling interval.
        fetchOnce(/*resetHash=*/false);
        startPolling();
    }
}

// Footer live/pause badge. Hidden unless we are in live mode with an active
// source; green "live" while polling, amber "PAUSE" while hover-paused.
function updatePollIndicator() {
    var $ind = $('#lvtPollIndicator');
    if (_mode !== 'live' || !_active) {
        $ind.prop('hidden', true);
        return;
    }
    $ind.prop('hidden', false).toggleClass('lvt-poll-indicator--paused', _paused);
    // Dot pulses once per refresh interval (via a CSS custom property), so the
    // blink visually matches the chosen cadence.
    $ind.css('--lvt-poll-pulse', _refreshSecs + 's');
    $('#lvtPollLabel').text(_paused ? 'paused' : (_refreshSecs + 'sec · LIVE'));
}

// ── Severity filter (header pills + Filter dropdown) ─────────────────────
function setSeverityFilter(lvl) {
    _filterLevel = String(lvl || '');
    applySevFilterUI();
    // Severity filtering applies to the single-source live view; merge
    // has its own rendering path.
    if (_mode === 'live') {
        // Picking a filter is a deliberate action: jump to the newest matching
        // lines at the bottom even if the user had scrolled up earlier.
        _autoScroll = true;
        renderVisible();
    }
}

function applySevFilterUI() {
    // Single-severity pills: only-info / only-warning / only-error / critical
    $('.lvt-sev-count[data-sev-filter]').each(function () {
        var $b = $(this);
        var on = _filterLevel !== '' && String($b.data('sev-filter')) === _filterLevel;
        $b.toggleClass('is-active', on).attr('aria-pressed', on ? 'true' : 'false');
    });
    // Cumulative levels live in the dropdown: info / warning / error
    var isCumulative = (_filterLevel === 'info' || _filterLevel === 'warning' || _filterLevel === 'error');
    $('#lvtFilterDdBtn').toggleClass('is-active', isCumulative);
    $('.lvt-filter-dd__item').each(function () {
        var $i = $(this);
        $i.toggleClass('is-active', isCumulative && String($i.data('level')) === _filterLevel);
    });
}

function clearTextFilter() {
    _filterText = '';
    var $s = $('#lvtFilterSearch'); if ($s.length) $s.val('');
    var $f = $('#lvtFooterSearch'); if ($f.length) $f.val('');
    $('#lvtFooterSearchClear').prop('hidden', true);
    $('#lvtFilterBar').prop('hidden', true);
    $('#lvtFilterCount').prop('hidden', true);
}

// Keep the filter-bar search and the persistent footer search in lockstep.
// `originId` is the input the user is typing in, so we skip writing back to it
// (avoids cursor jumps). Also toggles the footer clear (x) button.
function syncSearchInputs(text, originId) {
    if (originId !== 'lvtFilterSearch') {
        var $b = $('#lvtFilterSearch'); if ($b.length) $b.val(text);
    }
    if (originId !== 'lvtFooterSearch') {
        var $f = $('#lvtFooterSearch'); if ($f.length) $f.val(text);
    }
    $('#lvtFooterSearchClear').prop('hidden', !text);
}

function applyModeUI() {
    $('.lvt-mode').each(function () {
        var $b = $(this);
        var on = $b.data('mode') === _mode;
        $b.toggleClass('is-active', on).attr('aria-pressed', on ? 'true' : 'false');
    });
    $('#lvtMergeBar').prop('hidden',  _mode !== 'merge');
    // Filter bar visibility is driven by _filterText (text filter), not mode.
    updatePollIndicator();
}

function scheduleFilterApply() {
    if (_filterTimer) clearTimeout(_filterTimer);
    _filterTimer = setTimeout(applyFilter, 150);
}

function applyFilter() {
    if (_mode === 'live') renderVisible();
}

// ── Source selection ─────────────────────────────────────────────────────
function selectSourceFromEl(el) {
    var $el = $(el);
    var cat   = $el.data('cat');
    var name  = $el.data('name');
    var label = $el.data('label') || name;
    if (!cat || !name) return;

    // In merge mode, sidebar clicks toggle a source in/out of the merge set
    if (_mode === 'merge') {
        toggleMergeSource(String(cat), String(name), String(label));
        return;
    }

    if (_active && _active.category === cat && _active.name === name) return;

    _active = { category: String(cat), name: String(name), label: String(label) };
    _lastHash = null;
    _autoScroll = true;
    _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    _currentRow = null;
    _lastUpdate = null;

    $('#lvtSidebar .lvt-source').removeClass('is-active');
    $el.addClass('is-active');

    $('#lvtBreadcrumbCategory').text(prettyCategory(cat));
    $('#lvtBreadcrumbSource').text(label);
    // A source pick is a fresh start: clear any hover-pause and show the live
    // badge. The pointer is on the sidebar at this point, not the log area, so
    // auto-pause re-engages naturally if the user moves back over the log.
    _paused = false;
    updatePollIndicator();

    $('#lvtLogContent').html(
        '<div class="lvt-log-empty">' +
          '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
          '<div>Loading…</div>' +
        '</div>'
    );
    updateStatusbar(); // reset counters to zero

    fetchOnce(/*resetHash=*/true);
    startPolling();
}

function prettyCategory(cat) {
    return ({ system:'System', docker:'Docker Containers', vm:'VMs', custom:'Custom' })[cat] || cat;
}

// ── Polling ──────────────────────────────────────────────────────────────
function startPolling() {
    stopPolling();
    if (!_active) return;
    _pollTimer = setInterval(function () { fetchOnce(/*resetHash=*/false); }, _pollMs);
}
function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ── Fetch ────────────────────────────────────────────────────────────────
function fetchOnce(resetHash) {
    if (!_active || _inFlight) return;
    _inFlight = true;

    var data = {
        action:   'get_script_states',
        category: _active.category,
        source:   _active.name,
        context:  'tool',
        _lvt:     _token
    };
    if (!resetHash && _lastHash) data._since_hash = _lastHash;

    $.ajax({
        url: _apiUrl,
        data: data,
        type: 'GET',
        dataType: 'json',
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .done(function (resp, _status, xhr) {
        _tokenRetried = false;
        if (resp && resp.unchanged === true) {
            _lastUpdate = new Date();
            updateStatusbar();
            return;
        }
        var rows  = Array.isArray(resp) ? resp : [];
        var match = null;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].name === _active.name) { match = rows[i]; break; }
        }
        if (!match) { renderEmpty('No data returned for this source.'); return; }

        var hashHeader = xhr.getResponseHeader('X-LV-Hash');
        if (hashHeader) _lastHash = hashHeader;
        _lastUpdate = new Date();

        ingestRow(match);
        renderVisible();
        updateStatusbar();
    })
    .fail(function (xhr) {
        // Nonce TTL is 1h on the server; expired tokens come back as 403
        // (the API never emits 401). Refresh once and retry the original
        // fetch so the user does not see a transient "HTTP 403" when the
        // Tool page sat idle past the token's lifetime.
        if (xhr && xhr.status === 403 && !_tokenRetried) {
            _tokenRetried = true;
            refreshTokenAndRetry();
            return;
        }
        var msg = (xhr && xhr.status) ? ('HTTP ' + xhr.status) : 'network error';
        renderError('Failed to fetch logs (' + msg + ').');
    })
    .always(function () { _inFlight = false; });
}

function refreshTokenAndRetry() {
    $.ajax({
        url: _apiUrl,
        data: { action: 'refresh_nonce', _lvt: _token },
        type: 'GET',
        dataType: 'json',
        timeout: 8000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).done(function (resp) {
        if (resp && resp.token) {
            _token = resp.token;
            if (_cfg) _cfg.lvToken = resp.token;
            fetchOnce(true);
        }
    });
}

// ── Ingest a row from the API into our parallel arrays ──────────────────
function ingestRow(row) {
    _currentRow = row;
    var raw = unescapeHtml(String(row.log || ''));
    var lines = raw.split('\n');
    // Drop a trailing empty line that the server-side trim()+split can produce
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    _rawLines = lines;
    _sevs = new Array(lines.length);
    _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    for (var i = 0; i < lines.length; i++) {
        var s = classify(lines[i]);
        _sevs[i] = s;
        if (s && _counts.hasOwnProperty(s)) _counts[s]++;
    }
}

// ── Render: single-source view with severity + text filters applied ────
function renderVisible() {
    var $log = $('#lvtLogContent');
    if (!_rawLines.length) {
        if (_currentRow) renderEmpty('Log is empty.');
        return;
    }

    var ftext     = _filterText.trim().toLowerCase();
    var keep      = _filterLevel ? LEVEL_KEEP[_filterLevel] : null;
    var filtering = !!(keep || ftext);
    var html      = '';
    var shown     = 0;

    for (var i = 0; i < _rawLines.length; i++) {
        var line = _rawLines[i];
        var sev  = _sevs[i] || '';

        // Severity filter (pills / Filter dropdown) and text filter
        // (context-menu / preset) both apply here, in every view, not just a
        // dedicated filter mode.
        if (keep && !(sev && keep[sev])) continue;
        if (ftext && line.toLowerCase().indexOf(ftext) === -1) continue;

        var inner = ftext ? highlightMatches(line, ftext) : escapeHtml(line);
        html += '<div class="lvt-log-line' + (sev ? ' lvt-log-line--' + sev : '') + '">'
             +  inner + '</div>';
        shown++;
    }

    if (filtering && shown === 0) {
        $log.html(
            '<div class="lvt-log-empty">' +
              '<i class="fa fa-search-minus" aria-hidden="true"></i>' +
              '<div>No lines match the current filter.</div>' +
            '</div>'
        );
    } else {
        $log.html(html);
    }

    // The count chip only belongs to the text-filter bar; show it when a
    // text filter is active so the user sees how many lines matched.
    if (ftext) {
        $('#lvtFilterCount').prop('hidden', false)
            .text(shown + ' of ' + _rawLines.length + ' lines');
    } else {
        $('#lvtFilterCount').prop('hidden', true);
    }

    if (_autoScroll) {
        var el = $log[0];
        if (el) el.scrollTop = el.scrollHeight;
    }
}

function highlightMatches(line, needle) {
    if (!needle) return escapeHtml(line);
    var lower = line.toLowerCase();
    var out = '';
    var pos = 0;
    var n = needle.length;
    while (true) {
        var idx = lower.indexOf(needle, pos);
        if (idx === -1) { out += escapeHtml(line.substring(pos)); break; }
        out += escapeHtml(line.substring(pos, idx));
        out += '<span class="lvt-log-match">' + escapeHtml(line.substring(idx, idx + n)) + '</span>';
        pos = idx + n;
    }
    return out;
}

function renderEmpty(msg) {
    $('#lvtLogContent').html(
        '<div class="lvt-log-empty">' +
          '<i class="fa fa-inbox" aria-hidden="true"></i>' +
          '<div>' + escapeHtml(msg) + '</div>' +
        '</div>'
    );
}
function renderError(msg) {
    $('#lvtLogContent').html(
        '<div class="lvt-log-error">' +
          '<i class="fa fa-exclamation-triangle" aria-hidden="true"></i>' +
          '<div>' + escapeHtml(msg) + '</div>' +
        '</div>'
    );
}

// ── Status bar ───────────────────────────────────────────────────────────
function updateStatusbar() {
    var total = (_currentRow && _currentRow.total_lines != null) ? _currentRow.total_lines : _rawLines.length;
    $('#lvtTotalLines').text(formatNumber(total));
    $('#lvtCountInfo').text(formatNumber(_counts.info));
    $('#lvtCountWarn').text(formatNumber(_counts.warning));
    $('#lvtCountErr').text(formatNumber(_counts.error));
    $('#lvtCountCrit').text(formatNumber(_counts.critical));

    // Highlight the critical chip only when there are any
    $('.lvt-sev-count--critical').toggleClass('has-count', _counts.critical > 0);

    // File size moved out of the footer and onto each sidebar row. When the
    // active source reports a fresh size, update its row so the open log stays
    // current without waiting for the next bulk discover_sources sweep.
    if (_active && _currentRow && _currentRow.file_size != null) {
        setSidebarSize(_active.category, _active.name, _currentRow.file_size);
    }
}

// ── Sidebar per-source file size ─────────────────────────────────────────
// The file size used to live in the footer for the active log only. It now
// shows on the right of every sidebar row. fetchSidebarSizes() pulls all
// sizes in one lightweight call (discover_sources returns sizes without log
// bodies); setSidebarSize() keeps the active row fresh between sweeps.
function setSidebarSize(cat, name, bytes) {
    if (bytes == null) return;
    var $row = $('#lvtSidebar .lvt-source[data-cat="' + cssEsc(String(cat)) + '"][data-name="' + cssEsc(String(name)) + '"]');
    if (!$row.length) return;
    var $sz = $row.find('.lvt-source__size');
    if (!$sz.length) {
        $sz = $('<span class="lvt-source__size" aria-hidden="true"></span>');
        $row.append($sz);
    }
    $sz.text(bytes > 0 ? formatBytes(bytes) : '');
}

function applySidebarSizes(states) {
    if (!states || typeof states !== 'object') return;
    ['system', 'docker', 'vm', 'custom'].forEach(function (cat) {
        var group = states[cat];
        if (!group || !group.sources || !group.sources.length) return;
        group.sources.forEach(function (s) {
            // System / custom rows carry the key in data-name; docker / vm carry
            // the name. Match on either so we do not need per-category logic.
            // System / custom report the file size as "size"; docker / vm report
            // it as "log_size" (their log files live under /var/lib/docker, etc).
            var bytes = (s.size != null) ? s.size : s.log_size;
            $('#lvtSidebar .lvt-source[data-cat="' + cat + '"]').each(function () {
                var dn = String($(this).data('name'));
                if (dn !== String(s.key || '') && dn !== String(s.name || '')) return;
                var $sz = $(this).find('.lvt-source__size');
                if (!$sz.length) {
                    $sz = $('<span class="lvt-source__size" aria-hidden="true"></span>');
                    $(this).append($sz);
                }
                $sz.text((bytes != null && bytes > 0) ? formatBytes(bytes) : '');
            });
        });
    });
}

function fetchSidebarSizes() {
    $.ajax({
        url: _apiUrl,
        data: { action: 'discover_sources', context: 'tool', _lvt: _token },
        type: 'GET',
        dataType: 'json',
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).done(function (resp) {
        applySidebarSizes(resp);
    });
}

// ── Sidebar dot for the active source ────────────────────────────────────
// Recent activity rule: if any of the last 10 lines is error/critical, dot is
// red; else if there's a warning in the last 10, dot is stale (amber); else
// dot is active (green).
// ── Merge mode ───────────────────────────────────────────────────────────
function mergeKey(cat, name) { return String(cat) + ':' + String(name); }

function toggleMergeSource(cat, name, label) {
    var key = mergeKey(cat, name);
    var idx = -1;
    for (var i = 0; i < _mergeSources.length; i++) {
        if (mergeKey(_mergeSources[i].category, _mergeSources[i].name) === key) { idx = i; break; }
    }
    if (idx >= 0) _mergeSources.splice(idx, 1);
    else          _mergeSources.push({ category: cat, name: name, label: label });

    applyMergeSelectionUI();
    if (_mergeSources.length === 0) renderMergeEmpty();
    else scheduleMergeFetch();
}

function removeMergeSourceByKey(key) {
    for (var i = 0; i < _mergeSources.length; i++) {
        if (mergeKey(_mergeSources[i].category, _mergeSources[i].name) === key) {
            _mergeSources.splice(i, 1);
            break;
        }
    }
    applyMergeSelectionUI();
    if (_mergeSources.length === 0) renderMergeEmpty();
    else scheduleMergeFetch();
}

function clearMergeSelection() {
    _mergeSources = [];
    applyMergeSelectionUI();
    renderMergeEmpty();
}

function applyMergeSelectionUI() {
    var $rows = $('#lvtSidebar .lvt-source');
    $rows.removeClass('is-merge-selected');
    var keys = {};
    for (var i = 0; i < _mergeSources.length; i++) {
        keys[mergeKey(_mergeSources[i].category, _mergeSources[i].name)] = true;
    }
    $rows.each(function () {
        var $r = $(this);
        var k  = mergeKey(String($r.data('cat')), String($r.data('name')));
        if (keys[k]) $r.addClass('is-merge-selected');
    });

    var $chips = $('#lvtMergeBarChips');
    var $text  = $('#lvtMergeBarText');
    var $clear = $('#lvtMergeClear');
    if (!_mergeSources.length) {
        $chips.empty();
        $text.text('Pick 2+ sources from the sidebar to merge them by timestamp');
        $clear.prop('hidden', true);
        return;
    }

    var html = '';
    for (var j = 0; j < _mergeSources.length; j++) {
        var s = _mergeSources[j];
        var k = mergeKey(s.category, s.name);
        var c = sourceColor(k);
        html += '<span class="lvt-merge-chip">' +
                  '<span class="lvt-merge-chip__dot" style="background:' + c + '"></span>' +
                  escapeHtml(s.label) +
                  '<button type="button" class="lvt-merge-chip__x" data-key="' + escapeHtml(k) + '" title="Remove">&times;</button>' +
                '</span>';
    }
    $chips.html(html);
    $text.text(_mergeSources.length + (_mergeSources.length === 1 ? ' source' : ' sources') + ' merged');
    $clear.prop('hidden', false);
}

function renderMergeEmpty() {
    $('#lvtLogContent').html(
        '<div class="lvt-log-placeholder">' +
          '<i class="fa fa-link" aria-hidden="true"></i>' +
          '<p>Pick two or more sources from the sidebar to view a timestamp-ordered merged log.</p>' +
        '</div>'
    );
    // Status reset
    _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    _currentRow = null;
    updateStatusbar();
}

function scheduleMergeFetch() {
    if (_mergeApplyTimer) clearTimeout(_mergeApplyTimer);
    _mergeApplyTimer = setTimeout(fetchMerge, 600);
}

function fetchMerge() {
    if (!_mergeSources.length) return;

    var sources = _mergeSources.slice(); // snapshot — selection may change while we wait
    $('#lvtBreadcrumbCategory').text('Merge');
    $('#lvtBreadcrumbSource').text(sources.length + ' sources');
    $('#lvtPollIndicator').prop('hidden', true);

    $('#lvtLogContent').html(
        '<div class="lvt-log-empty">' +
          '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
          '<div>Fetching ' + sources.length + ' source' + (sources.length === 1 ? '' : 's') + '…</div>' +
        '</div>'
    );

    _mergeInFlight = sources.length;
    var results = [];
    var anyFailed = false;

    sources.forEach(function (src) {
        $.ajax({
            url: _apiUrl,
            data: {
                action:   'get_script_states',
                category: src.category,
                source:   src.name,
                context:  'tool',
                _normts:  '1',
                _lvt:     _token
            },
            type: 'GET',
            dataType: 'json',
            timeout: 15000,
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        })
        .done(function (resp) {
            if (_mode !== 'merge') return; // user switched modes mid-fetch
            var rows = Array.isArray(resp) ? resp : [];
            var match = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].name === src.name) { match = rows[i]; break; }
            }
            if (match) {
                var raw = unescapeHtml(String(match.log || ''));
                var lines = raw.split('\n');
                if (lines.length && lines[lines.length - 1] === '') lines.pop();
                var srcKey   = mergeKey(src.category, src.name);
                var srcColor = sourceColor(srcKey);
                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];
                    if (!line) continue;
                    results.push({
                        src:    src,
                        srcKey: srcKey,
                        color:  srcColor,
                        line:   line,
                        ts:     parseLineTimestampJS(line),
                        sev:    classify(line),
                        idx:    li, // stable secondary sort key per source
                    });
                }
            }
        })
        .fail(function () { anyFailed = true; })
        .always(function () {
            _mergeInFlight--;
            if (_mergeInFlight === 0 && _mode === 'merge') {
                renderMerged(results, anyFailed, sources);
            }
        });
    });
}

function renderMerged(items, anyFailed, sources) {
    // Sort: timestamped lines by ts; untimestamped float to the top (oldest first within source)
    items.sort(function (a, b) {
        if (a.ts == null && b.ts == null) return a.idx - b.idx;
        if (a.ts == null) return -1;
        if (b.ts == null) return 1;
        if (a.ts !== b.ts) return a.ts - b.ts;
        return a.idx - b.idx;
    });

    if (!items.length) {
        $('#lvtLogContent').html(
            '<div class="lvt-log-empty">' +
              '<i class="fa fa-inbox" aria-hidden="true"></i>' +
              '<div>No content returned for the selected sources.</div>' +
            '</div>'
        );
        _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
        updateStatusbar();
        return;
    }

    // Fill the parallel state used by the status bar
    _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    var html = '';
    var totalSize = 0;
    var totalLines = 0;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        _rawLines.push(it.line);
        _sevs.push(it.sev);
        if (it.sev && _counts.hasOwnProperty(it.sev)) _counts[it.sev]++;
        totalLines++;

        html += '<div class="lvt-log-line' + (it.sev ? ' lvt-log-line--' + it.sev : '') + '">' +
                  '<span class="lvt-merge-badge" style="' + sourceBadgeStyle(it.color) + '">' +
                    escapeHtml(it.src.label) +
                  '</span>' +
                  escapeHtml(it.line) +
                '</div>';
    }

    var $log = $('#lvtLogContent');
    $log.html(html);

    // Synthesize a row-like object so the status bar shows merged totals
    _currentRow = { total_lines: totalLines, file_size: totalSize };
    _lastUpdate = new Date();
    updateStatusbar();

    if (_autoScroll) {
        var el = $log[0];
        if (el) el.scrollTop = el.scrollHeight;
    }

    if (anyFailed) {
        // Append a small warning at the top
        var $warn = $(
            '<div class="lvt-log-empty" style="padding:.5rem;color:var(--lvt-sev-warn);justify-content:flex-start">' +
              '<i class="fa fa-exclamation-triangle"></i>' +
              '<div style="margin-left:.4rem">Some sources failed to load. Showing partial results.</div>' +
            '</div>'
        );
        $log.prepend($warn);
    }
}

function truncateLabel(s, n) {
    s = String(s);
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Deterministic color per source from a small palette
function sourceColor(key) {
    var palette = ['#378ADD', '#4caf50', '#EF9F27', '#9c27b0', '#00bcd4', '#ff5722', '#e91e63', '#607d8b'];
    var h = 0;
    for (var i = 0; i < key.length; i++) { h = (h << 5) - h + key.charCodeAt(i); h |= 0; }
    return palette[Math.abs(h) % palette.length];
}

// Build a readable source-badge style: a soft tint of the source color as the
// background with the full color as the text. This stays legible across the
// whole palette (including light greens/cyans) where solid fills with white
// text washed out, and matches the tag look used elsewhere in the tool.
function sourceBadgeStyle(hex) {
    var c = String(hex).replace('#', '');
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
    return 'background:rgba(' + r + ',' + g + ',' + b + ',.16);' +
           'color:' + hex + ';' +
           'border:1px solid rgba(' + r + ',' + g + ',' + b + ',.45)';
}

// Client-side timestamp parser used by Merge mode to order lines from
// multiple sources before display. Since the plugin is public and users wire
// up arbitrary custom logs, this recognizes several common shapes, not just
// the Unraid syslog: BSD syslog, ISO 8601 / RFC3339 (bracketed or not, with
// or without a Z/offset, timezone-aware), slash-separated dates, and the
// Apache/nginx common log format. Docker lines are normalized server-side
// into the BSD shape. Anything unrecognized returns null and floats to the
// top of the merge rather than landing in a wrong position.
function parseLineTimestampJS(line) {
    if (!line) return null;
    var months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    var m;

    // Helper: build epoch from local wall-clock components (no timezone info).
    function localEpoch(y, mo0, d, h, mi, s) {
        return new Date(y, mo0, d, h, mi, s).getTime();
    }
    // Helper: syslog-style year inference (formats with no year). Pick the
    // current year, but if that lands in the future, it belongs to last year.
    function inferYearEpoch(mo0, d, h, mi, s) {
        var y = new Date().getFullYear();
        var t = localEpoch(y, mo0, d, h, mi, s);
        if (t > Date.now() + 86400000) t = localEpoch(y - 1, mo0, d, h, mi, s);
        return t;
    }

    // 1. BSD syslog: "May 15 14:03:29" (no year). Used by the Unraid system
    //    log and by Docker lines after server-side normalization.
    m = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m && months[m[1]] != null) {
        return inferYearEpoch(months[m[1]], parseInt(m[2],10), parseInt(m[3],10), parseInt(m[4],10), parseInt(m[5],10));
    }

    // 2. ISO 8601 / RFC3339, optionally bracketed: "2026-05-15T14:03:29",
    //    "2026-05-15 14:03:29", "[2026-05-15 14:03:29]", with optional
    //    fractional seconds and Z / +hh:mm timezone. Timezone-aware.
    m = line.match(/^\[?(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
    if (m) {
        if (m[8]) {
            var iso = m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+m[6] +
                      (m[7]||'') + m[8].replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
            var t = Date.parse(iso);
            if (!isNaN(t)) return t;
        }
        return localEpoch(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10),
                          parseInt(m[4],10), parseInt(m[5],10), parseInt(m[6],10));
    }

    // 3. Slash-separated date, optionally bracketed: "2026/05/15 14:03:29".
    //    Common in some application logs. Treated as local.
    m = line.match(/^\[?(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
        return localEpoch(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10),
                          parseInt(m[4],10), parseInt(m[5],10), parseInt(m[6],10));
    }

    // 4. Apache / nginx common log format: "[15/May/2026:14:03:29 +0200]".
    //    May appear after a leading client-IP prefix, so this one is not
    //    anchored to the start of the line. Honors the offset if present.
    m = line.match(/\[(\d{1,2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{4}))?\]/);
    if (m && months[m[2]] != null) {
        if (m[7]) {
            var iso2 = m[3]+'-'+pad2(months[m[2]]+1)+'-'+pad2(parseInt(m[1],10))+'T'+m[4]+':'+m[5]+':'+m[6] +
                       m[7].replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
            var t2 = Date.parse(iso2);
            if (!isNaN(t2)) return t2;
        }
        return localEpoch(parseInt(m[3],10), months[m[2]], parseInt(m[1],10),
                          parseInt(m[4],10), parseInt(m[5],10), parseInt(m[6],10));
    }

    return null;
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }

// ── Context menu (right-click on a log line) ─────────────────────────────
function buildContextMenu() {
    if (document.getElementById('lvtLogCtxMenu')) return;
    var html =
      '<div class="lvt-ctxmenu" id="lvtLogCtxMenu" hidden role="menu">' +
        '<div class="lvt-ctxmenu__item" data-action="copy" role="menuitem">' +
          '<i class="fa fa-copy" aria-hidden="true"></i> Copy line' +
        '</div>' +
        '<div class="lvt-ctxmenu__sep"></div>' +
        '<div class="lvt-ctxmenu__item" data-action="filter" role="menuitem" id="lvtCtxFilter">' +
          '<i class="fa fa-filter" aria-hidden="true"></i> Filter on selection' +
        '</div>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
}

function showContextMenu(x, y, $line) {
    var $m = $('#lvtLogCtxMenu');
    if (!$m.length) return;

    // Filter-on-selection only works when there's a non-empty text selection
    var $f = $('#lvtCtxFilter');
    if (_ctxSelection) {
        $f.removeClass('lvt-ctxmenu__item--disabled')
          .html('<i class="fa fa-filter" aria-hidden="true"></i> Filter on &ldquo;' +
                escapeHtml(truncate(_ctxSelection, 30)) + '&rdquo;');
    } else {
        $f.addClass('lvt-ctxmenu__item--disabled')
          .html('<i class="fa fa-filter" aria-hidden="true"></i> Filter on selection');
    }

    // Reveal first so we can measure size
    $m.prop('hidden', false).css({ left: '-9999px', top: '-9999px' });

    var menuW = $m.outerWidth();
    var menuH = $m.outerHeight();
    var vw = window.innerWidth, vh = window.innerHeight;
    var px = Math.min(x, vw - menuW - 6);
    var py = Math.min(y, vh - menuH - 6);
    $m.css({ left: Math.max(4, px) + 'px', top: Math.max(4, py) + 'px' });

    // Remember the clicked line element for the success flash
    $m.data('source-line', $line);

    // Hold the live view still while the menu is open so nothing scrolls away.
    _ctxMenuOpen = true;
    setPaused(true);
}

function hideContextMenu() {
    var $m = $('#lvtLogCtxMenu');
    if ($m.length) $m.prop('hidden', true).removeData('source-line');
    // Menu closed: release the hold. Stay paused only if the pointer is still
    // over the log (normal hover-pause); resume if it has moved away.
    _ctxMenuOpen = false;
    setPaused(_pointerInLog);
}

function copyCurrentLine() {
    // If the user has a text selection (one or many lines), copy that;
    // otherwise fall back to the single right-clicked line.
    var sel = '';
    try { sel = String(window.getSelection ? window.getSelection().toString() : ''); } catch (e) { sel = ''; }
    var text = sel.replace(/\u00a0/g, ' ').trim() ? sel : _ctxLine;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { copyFallback(text); });
    } else {
        copyFallback(text);
    }
}

function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
}

function filterOnSelection() {
    if (!_ctxSelection) return;
    // Right-click "Filter on selection" only sets a text filter now - there
    // is no separate filter mode. It applies on top of whatever view/severity
    // filter is active. Only meaningful on the single-source live view.
    if (_mode !== 'live') return;
    _filterText = _ctxSelection;
    var $s = $('#lvtFilterSearch');
    if ($s.length) $s.val(_filterText);
    syncSearchInputs(_filterText, 'lvtFilterSearch');
    $('#lvtFilterBar').prop('hidden', false);
    renderVisible();
}

function bumpPinnedBadge() {
    // Pinned tab removed; no-op kept defensively in case anything still calls it.
}

function truncate(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

// ── Severity classification ──────────────────────────────────────────────
function classify(line) {
    if (!line) return '';
    for (var i = 0; i < SEV_RULES.length; i++) {
        if (SEV_RULES[i].re.test(line)) return SEV_RULES[i].cls;
    }
    return '';
}

// ── Download ─────────────────────────────────────────────────────────────
// Mirrors the widget's export feature (Logsviewer.page header icon) but
// keeps things plain: a single .log file containing what is loaded in
// _rawLines (Live, Filter, Merge modes will all have meaningful content
// there). No format toggle, no JSON variant -- the widget already covers
// that case; the Tool-page button is for quickly grabbing the on-screen
// log as a file.
function sanitizeFilenamePart(s) {
    return String(s || 'log')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80) || 'log';
}

function downloadTextFile(text, filename) {
    var blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function downloadCurrentLog() {
    if (!_rawLines.length) return;  // nothing loaded yet -- silent no-op like the widget

    // Filename: prefer the active source's label; fall back to mode name in
    // merge mode where there's no single active source.
    var base;
    if (_mode === 'merge' && _mergeSources && _mergeSources.length) {
        base = 'merge_' + _mergeSources.length + '_sources';
    } else if (_active && _active.label) {
        base = _active.label;
    } else {
        base = 'log';
    }

    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    var stamp = '_' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());

    var fmt = _exportFormat;
    var ext = (fmt === 'json') ? '.json' : (fmt === 'csv') ? '.csv' : '.log';
    var text;
    if (fmt === 'json') {
        var rows = _rawLines.map(function (ln, i) {
            return { severity: _sevs[i] || 'info', line: ln };
        });
        text = JSON.stringify(rows, null, 2) + '\n';
    } else if (fmt === 'csv') {
        var esc = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
        var out = ['severity,line'];
        for (var i = 0; i < _rawLines.length; i++) {
            out.push(esc(_sevs[i] || 'info') + ',' + esc(_rawLines[i]));
        }
        text = out.join('\n') + '\n';
    } else {
        text = _rawLines.join('\n') + '\n';
    }

    var filename = sanitizeFilenamePart(base) + stamp + ext;
    downloadTextFile(text, filename);
}

// ── Utilities ────────────────────────────────────────────────────────────
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]);
    });
}
function unescapeHtml(s) {
    // PHP htmlspecialchars(..., ENT_QUOTES) emits the apostrophe as the numeric
    // entity &#039; (with the leading zero) since PHP 5.4. Older PHP and our own
    // escapeHtml above use &#39; (no leading zero). The regex matches both so
    // the round-trip from PHP → JS rawLines → JS escapeHtml → DOM works for
    // either source. &amp; is decoded LAST so we don't accidentally re-decode
    // any ampersand that was part of a pre-encoded entity.
    return String(s)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&');
}
function cssEsc(s) {
    return String(s).replace(/(["\\\]])/g, '\\$1');
}
function formatNumber(n) {
    if (n == null) return '0';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatBytes(b) {
    if (b == null || b < 0) return '—';
    if (b < 1024)        return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function formatTime(d) {
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

})();
