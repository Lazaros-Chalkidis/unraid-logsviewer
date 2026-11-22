/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

(function () {
'use strict';

if (window.__lvtLogsLoaded) return;
window.__lvtLogsLoaded = true;

var _cfg     = window.lvToolConfig || {};
var _apiUrl  = _cfg.apiUrl  || '/plugins/logsviewer/include/logsviewer_api.php';
var _token   = _cfg.lvToken || '';

var _active     = null;
var _currentRow = null;
var _rawLines   = [];
var _sevs       = [];
var _counts     = { info: 0, warning: 0, error: 0, critical: 0, success: 0 };

var _mode        = 'live';
var _paused      = false;
var _filterText  = '';
var _filterLevel = '';
var _filterTimer = null;

var _pollTimer   = null;
var _refreshSecs = (function () {
    var n = parseInt(_cfg.refreshSecs, 10);
    return (n === 3 || n === 5 || n === 10 || n === 20) ? n : 5;
})();
var _pollMs      = _refreshSecs * 1000;
var _refreshOn   = _cfg.refreshOn !== false;
var _follow      = _cfg.autoScroll !== false;
var _hoverPause  = _cfg.pauseOnHover !== false;
var _exportFormat = (function () {
    var f = String(_cfg.exportFormat || 'txt').toLowerCase();
    return (f === 'txt' || f === 'json' || f === 'csv') ? f : 'txt';
})();
var _inFlight    = false;
var _fetchGen    = 0;
var _lastHash    = null;
var _autoScroll  = true;
var _visible     = false;
var _lastUpdate  = null;

var _ctxLine      = '';
var _ctxSelection = '';
var _ctxMenuOpen  = false;
var _pointerInLog = false;
var _touchAt      = 0;
var _dragHeld     = false;

var _mergeSources    = [];
var _mergeApplyTimer = null;
var _mergeInFlight   = 0;
var _mergeGen        = 0;

var SEV_RULES = [
    { re: /\b(emerg(?:ency)?|crit(?:ical)?|alert|fatal|panic)\b/i, cls: 'critical' },
    { re: /\b(error|err)\b/i,                                  cls: 'error'    },
    { re: /\b(warn(?:ing)?)\b/i,                               cls: 'warning'  },
    { re: /\bsuccessful (?:login|logout)\b/i,                  cls: 'success'  },
    { re: /\b(info|notice)\b/i,                                cls: 'info'     }
];

var LEVEL_KEEP = {
    'critical':     { critical: 1 },
    'error':        { critical: 1, error: 1 },
    'warning':      { critical: 1, error: 1, warning: 1 },
    'info':         { critical: 1, error: 1, warning: 1, info: 1, success: 1 },
    'only-info':    { info: 1 },
    'only-warning': { warning: 1 },
    'only-error':   { error: 1 }
};

window.LVT_TAB = window.LVT_TAB || { _handlers: {}, register: function(t,h){ this._handlers[t]=h; } };
window.LVT_TAB.register('logs', {
    init:    function () { onShow(true); },
    refresh: function () { onShow(false); },
    hide:    function () { onHide(); }
});

bindGlobal();

function bindGlobal() {
    $(document)

      .on('click',   '#lvtSidebar .lvt-source', function () { selectSourceFromEl(this); })
      .on('keydown', '#lvtSidebar .lvt-source', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectSourceFromEl(this);
          }
      })

      .on('click', '#lvtLogsDownload', function (e) {
          e.preventDefault();
          downloadCurrentLog();
      })

      .on('click', '#lvtLogsRefresh', function (e) {
          e.preventDefault();
          refreshNow();
      })

      .on('click', '.lvt-mode:not(:disabled)', function () {
          var m = $(this).data('mode');
          if (m === _mode) return;
          setMode(m);
      })

      .on('mousedown', '#lvtLogContent', function (e) { if (e.button === 0 && !_dragHeld && !justTouched()) holdDrag(); })
      .on('mouseenter', '#lvtLogContent', function () { if (!justTouched()) pointerAt(true); })
      .on('mouseleave', '#lvtLogContent', function () { if (!justTouched() && !_dragHeld) pointerAt(false); })

      .on('click', '.lvt-sev-count[data-sev-filter]', function () {
          var lvl = String($(this).data('sev-filter') || '');
          setSeverityFilter(_filterLevel === lvl ? '' : lvl);
      })

      .on('click', '#lvtFilterDdBtn', function (e) {
          e.stopPropagation();
          var $menu = $('#lvtFilterDdMenu');
          var willOpen = $menu.prop('hidden');
          $menu.prop('hidden', !willOpen);
          $('#lvtFilterDdBtn').attr('aria-expanded', willOpen ? 'true' : 'false');
      })

      .on('click', '.lvt-filter-dd__item', function (e) {
          e.stopPropagation();
          var lvl = String($(this).data('level') || '');
          setSeverityFilter(_filterLevel === lvl ? '' : lvl);
          $('#lvtFilterDdMenu').prop('hidden', true);
          $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
      })

      .on('input',  '#lvtFilterSearch', function () {
          _filterText = String(this.value || '');
          syncSearchInputs(_filterText, this.id);
          scheduleFilterApply();
      })
      .on('click',  '#lvtFilterClear', function () {
          clearTextFilter();
          applyFilter();
      })

      .on('input', '#lvtFooterSearch', function () {
          _filterText = String(this.value || '');
          syncSearchInputs(_filterText, this.id);
          scheduleFilterApply();
      })
      .on('click', '#lvtFooterSearchClear', function () {
          clearTextFilter();
          applyFilter();
      })

      .on('click', '#lvtMergeClear', function (e) {
          e.preventDefault();
          clearMergeSelection();
      })

      .on('click', '.lvt-merge-chip__x', function (e) {
          e.preventDefault();
          var key = String($(this).data('key') || '');
          if (key) removeMergeSourceByKey(key);
      });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopPolling();
        else if (_visible && _active && _mode === 'live' && !_paused) startPolling();
    });

    document.addEventListener('touchstart', function (e) {
        _touchAt = Date.now();
        var $t = $(e.target);
        if (!$t.closest('#lvtLogCtxMenu').length) pointerAt($t.closest('#lvtLogContent').length > 0);
    }, { passive: true });
    document.addEventListener('touchend', function () { _touchAt = Date.now(); }, { passive: true });

    buildContextMenu();

    $(document).on('contextmenu', '#lvtLogContent .lvt-log-line', function (e) {
        e.preventDefault();
        _ctxLine = $(this).text();
        var sel  = (window.getSelection && String(window.getSelection() || '').trim()) || '';
        _ctxSelection = sel;
        showContextMenu(e.clientX, e.clientY, $(this));
    });

    $(document).on('click', function (e) {
        var $tgt = $(e.target);
        if (!$tgt.closest('#lvtLogCtxMenu').length) hideContextMenu(e);

        if (!$tgt.closest('#lvtFilterDd').length) {
            $('#lvtFilterDdMenu').prop('hidden', true);
            $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
        }
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && !$('#lvtLogCtxMenu').prop('hidden')) hideContextMenu();
        if (e.key === 'Escape' && !$('#lvtFilterDdMenu').prop('hidden')) {
            $('#lvtFilterDdMenu').prop('hidden', true);
            $('#lvtFilterDdBtn').attr('aria-expanded', 'false');
        }
    });

    $(document).on('click', '#lvtLogCtxMenu .lvt-ctxmenu__item:not(.lvt-ctxmenu__item--disabled)', function (e) {
        e.preventDefault();
        var act = $(this).data('action');
        hideContextMenu(e);
        if      (act === 'copy')   copyCurrentLine();
        else if (act === 'filter') filterOnSelection();
    });
}

function onShow(firstTime) {
    _visible = true;

    fetchSidebarSizes();

    applyModeUI();
    applySevFilterUI();

    if (_mode === 'merge') {
        applyMergeSelectionUI();
        if (_mergeSources.length) scheduleMergeFetch();
        else                       renderMergeEmpty();
        return;
    }

    if (_active) {

        $('#lvtSidebar .lvt-source').removeClass('is-active');
        $('#lvtSidebar .lvt-source[data-cat="' + _active.category + '"][data-name="' + cssEsc(_active.name) + '"]')
            .addClass('is-active');
        _paused = false;
        updatePollIndicator();

        if (_filterText) {
            $('#lvtFilterSearch').val(_filterText);
            $('#lvtFilterBar').prop('hidden', false);
        }
        applySevFilterUI();

        if (_rawLines.length) {
            renderVisible();
            updateStatusbar();
        }

        fetchOnce(true);
        startPolling();
    } else {

        var $first = $('#lvtSidebar .lvt-source').first();
        if ($first.length) selectSourceFromEl($first[0]);
    }
}

function onHide() {
    _visible = false;
    stopPolling();
}

function setMode(m) {
    if (m !== 'live' && m !== 'merge') return;
    _mode = m;
    _paused = false;
    applyModeUI();

    if (m === 'merge') {
        _fetchGen++;
        _inFlight = false;
        stopPolling();
        clearTextFilter();
        applyMergeSelectionUI();
        if (_mergeSources.length === 0) renderMergeEmpty();
        else scheduleMergeFetch();
    } else {
        if (_mergeApplyTimer) clearTimeout(_mergeApplyTimer);
        clearTextFilter();
        $('#lvtSidebar .lvt-source').removeClass('is-merge-selected');
        _lastHash = null;
        _autoScroll = true;
        _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
        _currentRow = null;
        updateStatusbar();
        if (_active) {
            $('#lvtLogContent').html(
                '<div class="lvt-log-empty">' +
                  '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
                  '<div>Loading…</div>' +
                '</div>'
            );
            fetchOnce(true);
            startPolling();
        } else {
            $('#lvtLogContent').html(
                '<div class="lvt-log-placeholder">' +
                  '<i class="fa fa-list-alt" aria-hidden="true"></i>' +
                  '<p>Choose a source from the left to start viewing logs.</p>' +
                '</div>'
            );
        }
    }
}

function justTouched() {
    return Date.now() - _touchAt < 700;
}

function pointerAt(inLog) {
    _pointerInLog = inLog;
    if (inLog) {
        if (_hoverPause) setPaused(true);
    } else if (!_ctxMenuOpen) {
        setPaused(false);
    }
}

function holdDrag() {
    var parked = null;
    _dragHeld = true;
    $(document).on('mousedown.lvtDrag mouseup.lvtDrag mousemove.lvtDrag mouseout.lvtDrag', function (e) {
        var gone = e.type === 'mouseout';
        if (gone && e.relatedTarget) return;
        if (e.buttons && (gone || e.type === 'mousemove')) return;
        var d = gone ? Infinity : awayFromLog(e);
        if (e.type === 'mousedown' && d === 0) {
            parked = null;
            return;
        }
        if (e.type !== 'mousedown' && d > 0 && d < Infinity) {
            if (parked === null) parked = d;
            if (d <= parked + 16) return;
        }
        $(document).off('.lvtDrag');
        _dragHeld = false;
        pointerAt(d === 0);
    });
}

function awayFromLog(e) {
    var el = document.getElementById('lvtLogContent');
    if (!el) return Infinity;
    var r = el.getBoundingClientRect();
    return Math.max(r.left - e.clientX, e.clientX - r.right, r.top - e.clientY, e.clientY - r.bottom, 0);
}

function setPaused(paused) {

    if (_mode !== 'live' || !_active || !_refreshOn) return;
    if (paused === _paused) return;
    _paused = paused;
    updatePollIndicator();
    if (_paused) {
        stopPolling();
    } else {
        if (_follow) toNewest();
        fetchOnce(false);
        startPolling();
    }
}

function updatePollIndicator() {
    var $ind = $('#lvtPollIndicator');
    if (_mode !== 'live' || !_active) {
        $ind.prop('hidden', true);
        return;
    }
    $ind.prop('hidden', false)
        .toggleClass('lvt-poll-indicator--paused', _paused)
        .toggleClass('lvt-poll-indicator--off', !_refreshOn);

    $ind.css('--lvt-poll-pulse', _refreshSecs + 's');
    $('#lvtPollLabel').text(!_refreshOn ? 'auto-refresh off' : (_paused ? 'paused' : (_refreshSecs + 'sec · LIVE')));
}

function toNewest() {
    var el = document.getElementById('lvtLogContent');
    if (el) el.scrollTop = el.scrollHeight;
}

function settleScroll() {
    if (_autoScroll || (_follow && !_paused)) toNewest();
    _autoScroll = false;
}

function refreshNow() {
    if (_mode === 'merge') {
        if (!_mergeSources.length || _mergeInFlight > 0) return;
        if (_mergeApplyTimer) clearTimeout(_mergeApplyTimer);
        fetchMerge();
        return;
    }
    var req = fetchOnce(false);
    if (!req) return;
    var $icon = $('#lvtLogsRefresh .fa').addClass('fa-spin');
    req.always(function () { $icon.removeClass('fa-spin'); });
}

function setSeverityFilter(lvl) {
    _filterLevel = String(lvl || '');
    applySevFilterUI();

    if (_mode === 'live') {

        _autoScroll = true;
        renderVisible();
    }
}

function applySevFilterUI() {

    $('.lvt-sev-count[data-sev-filter]').each(function () {
        var $b = $(this);
        var on = _filterLevel !== '' && String($b.data('sev-filter')) === _filterLevel;
        $b.toggleClass('is-active', on).attr('aria-pressed', on ? 'true' : 'false');
    });

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

    updatePollIndicator();
}

function scheduleFilterApply() {
    if (_filterTimer) clearTimeout(_filterTimer);
    _filterTimer = setTimeout(applyFilter, 150);
}

function applyFilter() {
    if (_mode === 'live') renderVisible();
}

function selectSourceFromEl(el) {
    var $el = $(el);
    var cat   = $el.attr('data-cat');
    var name  = $el.attr('data-name');
    var label = $el.attr('data-label') || name;
    if (!cat || !name) return;

    if (_mode === 'merge') {
        toggleMergeSource(cat, name, label);
        return;
    }

    if (_active && _active.category === cat && _active.name === name) return;

    _active = { category: cat, name: name, label: label };
    _lastHash = null;
    _autoScroll = true;
    _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    _currentRow = null;
    _lastUpdate = null;

    $('#lvtSidebar .lvt-source').removeClass('is-active');
    $el.addClass('is-active');

    _paused = _refreshOn && _hoverPause && _pointerInLog;
    updatePollIndicator();

    $('#lvtLogContent').html(
        '<div class="lvt-log-empty">' +
          '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
          '<div>Loading…</div>' +
        '</div>'
    );
    updateStatusbar();

    fetchOnce(true);
    if (!_paused) startPolling();
}

function startPolling() {
    stopPolling();
    if (!_active || !_refreshOn) return;
    _pollTimer = setInterval(function () { fetchOnce(false); }, _pollMs);
}
function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function fetchOnce(resetHash, retried) {
    if (!_active) return;
    if (resetHash) _fetchGen++;
    else if (_inFlight) return;
    _inFlight = true;
    var gen = _fetchGen;

    var data = {
        action:   'get_script_states',
        category: _active.category,
        source:   _active.name,
        context:  'tool',
        _lvt:     _token
    };
    if (!resetHash && _lastHash) data._since_hash = _lastHash;

    return $.ajax({
        url: _apiUrl,
        data: data,
        type: 'GET',
        dataType: 'json',
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .done(function (resp, _status, xhr) {
        if (gen !== _fetchGen) return;
        if (_paused && !resetHash) return;
        if (resp && resp.unchanged === true) {
            _lastUpdate = new Date();
            if ($('#lvtLogContent .lvt-log-error').length) renderVisible();
            else if (_follow && !_paused) toNewest();
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
        if (gen !== _fetchGen) return;
        if (_paused && !resetHash) return;
        var failed = function () {
            var msg = (xhr && xhr.status) ? ('HTTP ' + xhr.status) : 'network error';
            renderError('Failed to fetch logs (' + msg + ').');
        };

        if (xhr && xhr.status === 403 && !retried) {
            refreshToken(function (ok) {
                if (gen !== _fetchGen) return;
                if (ok) fetchOnce(true, true);
                else failed();
            });
            return;
        }
        failed();
    })
    .always(function () { if (gen === _fetchGen) _inFlight = false; });
}

function refreshToken(cb) {
    $.ajax({
        url: _apiUrl,
        data: { action: 'refresh_nonce', _lvt: _token },
        type: 'GET',
        dataType: 'json',
        timeout: 8000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).done(function (resp) {
        var ok = !!(resp && resp.token);
        if (ok) {
            _token = resp.token;
            if (_cfg) _cfg.lvToken = resp.token;
        }
        cb(ok);
    }).fail(function () { cb(false); });
}

function ingestRow(row) {
    _currentRow = row;
    var raw = unescapeHtml(String(row.log || ''));
    var lines = raw.split('\n');

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

    if (ftext) {
        $('#lvtFilterCount').prop('hidden', false)
            .text(shown + ' of ' + _rawLines.length + ' lines');
    } else {
        $('#lvtFilterCount').prop('hidden', true);
    }

    settleScroll();
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

function updateStatusbar() {
    var total = (_currentRow && _currentRow.total_lines != null) ? _currentRow.total_lines : _rawLines.length;
    $('#lvtTotalLines').text(formatNumber(total));
    $('#lvtCountInfo').text(formatNumber(_counts.info));
    $('#lvtCountWarn').text(formatNumber(_counts.warning));
    $('#lvtCountErr').text(formatNumber(_counts.error));
    $('#lvtCountCrit').text(formatNumber(_counts.critical));

    $('.lvt-sev-count--critical').toggleClass('has-count', _counts.critical > 0);

    if (_active && _currentRow && _currentRow.file_size != null) {
        setSidebarSize(_active.category, _active.name, _currentRow.file_size);
    }
}

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
    ['system', 'docker', 'vm', 'script', 'custom'].forEach(function (cat) {
        var group = states[cat];
        if (!group || !group.sources || !group.sources.length) return;
        group.sources.forEach(function (s) {

            var bytes = (s.size != null) ? s.size : s.log_size;
            $('#lvtSidebar .lvt-source[data-cat="' + cat + '"]').each(function () {
                var dn = $(this).attr('data-name');
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
        var k  = mergeKey($r.attr('data-cat'), $r.attr('data-name'));
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

    _rawLines = []; _sevs = []; _counts = { info:0, warning:0, error:0, critical:0, success:0 };
    _currentRow = null;
    _mergeGen++;
    _mergeInFlight = 0;
    updateStatusbar();
}

function scheduleMergeFetch() {
    if (_mergeApplyTimer) clearTimeout(_mergeApplyTimer);
    _mergeGen++;
    _mergeInFlight = 0;
    _mergeApplyTimer = setTimeout(fetchMerge, 600);
}

function fetchMerge(retried) {
    if (!_mergeSources.length) return;

    var sources = _mergeSources.slice();
    var gen     = ++_mergeGen;
    var left    = sources.length;
    _autoScroll = true;
    $('#lvtPollIndicator').prop('hidden', true);

    $('#lvtLogContent').html(
        '<div class="lvt-log-empty">' +
          '<i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>' +
          '<div>Fetching ' + sources.length + ' source' + (sources.length === 1 ? '' : 's') + '…</div>' +
        '</div>'
    );

    _mergeInFlight = left;
    var results = [];
    var anyFailed = false;
    var denied = false;

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
            if (gen !== _mergeGen || _mode !== 'merge') return;
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
                        idx:    li,
                    });
                }
            }
        })
        .fail(function (xhr) {
            anyFailed = true;
            if (xhr && xhr.status === 403) denied = true;
        })
        .always(function () {
            left--;
            if (gen !== _mergeGen) return;
            _mergeInFlight = left;
            if (left !== 0 || _mode !== 'merge') return;
            if (denied && retried !== true) {
                refreshToken(function (ok) {
                    if (gen !== _mergeGen || _mode !== 'merge') return;
                    if (ok) fetchMerge(true);
                    else renderMerged(results, anyFailed, sources);
                });
                return;
            }
            renderMerged(results, anyFailed, sources);
        });
    });
}

function renderMerged(items, anyFailed, sources) {

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

    _currentRow = { total_lines: totalLines, file_size: totalSize };
    _lastUpdate = new Date();
    updateStatusbar();

    settleScroll();

    if (anyFailed) {

        var $warn = $(
            '<div class="lvt-log-empty" style="padding:.5rem;color:var(--lvt-sev-warn);justify-content:flex-start">' +
              '<i class="fa fa-exclamation-triangle"></i>' +
              '<div style="margin-left:.4rem">Some sources failed to load. Showing partial results.</div>' +
            '</div>'
        );
        $log.prepend($warn);
    }
}

function sourceColor(key) {
    var palette = ['#378ADD', '#4caf50', '#EF9F27', '#9c27b0', '#00bcd4', '#ff5722', '#e91e63', '#607d8b'];
    var h = 0;
    for (var i = 0; i < key.length; i++) { h = (h << 5) - h + key.charCodeAt(i); h |= 0; }
    return palette[Math.abs(h) % palette.length];
}

function sourceBadgeStyle(hex) {
    var c = String(hex).replace('#', '');
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
    return 'background:rgba(' + r + ',' + g + ',' + b + ',.16);' +
           'color:' + hex + ';' +
           'border:1px solid rgba(' + r + ',' + g + ',' + b + ',.45)';
}

function parseLineTimestampJS(line) {
    if (!line) return null;
    var months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    var m;

    function localEpoch(y, mo0, d, h, mi, s) {
        return new Date(y, mo0, d, h, mi, s).getTime();
    }

    function inferYearEpoch(mo0, d, h, mi, s) {
        var y = new Date().getFullYear();
        var t = localEpoch(y, mo0, d, h, mi, s);
        if (t > Date.now() + 86400000) t = localEpoch(y - 1, mo0, d, h, mi, s);
        return t;
    }

    m = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m && months[m[1]] != null) {
        return inferYearEpoch(months[m[1]], parseInt(m[2],10), parseInt(m[3],10), parseInt(m[4],10), parseInt(m[5],10));
    }

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

    m = line.match(/^\[?(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
        return localEpoch(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10),
                          parseInt(m[4],10), parseInt(m[5],10), parseInt(m[6],10));
    }

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

    var $f = $('#lvtCtxFilter');
    if (_ctxSelection) {
        $f.removeClass('lvt-ctxmenu__item--disabled')
          .html('<i class="fa fa-filter" aria-hidden="true"></i> Filter on &ldquo;' +
                escapeHtml(truncate(_ctxSelection, 30)) + '&rdquo;');
    } else {
        $f.addClass('lvt-ctxmenu__item--disabled')
          .html('<i class="fa fa-filter" aria-hidden="true"></i> Filter on selection');
    }

    $m.prop('hidden', false).css({ left: '-9999px', top: '-9999px' });

    var menuW = $m.outerWidth();
    var menuH = $m.outerHeight();
    var vw = window.innerWidth, vh = window.innerHeight;
    var px = Math.min(x, vw - menuW - 6);
    var py = Math.min(y, vh - menuH - 6);
    $m.css({ left: Math.max(4, px) + 'px', top: Math.max(4, py) + 'px' });

    $m.data('source-line', $line);

    _ctxMenuOpen = true;
    setPaused(true);
}

function hideContextMenu(e) {
    var $m = $('#lvtLogCtxMenu');
    var onMenu = _ctxMenuOpen && $m.is(':hover');
    if ($m.length) $m.prop('hidden', true).removeData('source-line');

    _ctxMenuOpen = false;
    if (onMenu) {
        var under = (e && e.detail) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        _pointerInLog = !under || $(under).closest('#lvtLogContent').length > 0;
    }
    setPaused(_hoverPause && _pointerInLog);
}

function copyCurrentLine() {

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
    try { document.execCommand('copy'); } catch (e) {  }
    document.body.removeChild(ta);
}

function filterOnSelection() {
    if (!_ctxSelection) return;

    if (_mode !== 'live') return;
    _filterText = _ctxSelection;
    var $s = $('#lvtFilterSearch');
    if ($s.length) $s.val(_filterText);
    syncSearchInputs(_filterText, 'lvtFilterSearch');
    $('#lvtFilterBar').prop('hidden', false);
    renderVisible();
}

function truncate(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

function classify(line) {
    if (!line) return '';
    for (var i = 0; i < SEV_RULES.length; i++) {
        if (SEV_RULES[i].re.test(line)) return SEV_RULES[i].cls;
    }
    return '';
}

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
    if (!_rawLines.length) return;

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
        var esc = function (s) {
            s = String(s);
            if (/^[\t\r]*[=+\-@]/.test(s)) s = "'" + s;
            return '"' + s.replace(/"/g, '""') + '"';
        };
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

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]);
    });
}
function unescapeHtml(s) {

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
    if (b == null || b < 0) return '-';
    if (b < 1024)        return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

})();
