/* ═══════════════════════════════════════════════════════════════════════════
   Logs Viewer -- Tool Page Shell
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   /plugins/logsviewer/js/logsviewer-tool.js

   Phase 1a: AJAX loader shell. The Saved and Pinned tabs were removed, so
   there is no longer a tab strip or hash routing; the shell just loads the
   single Logs view (logsviewer-tool-logs.js) into the panel.
   Depends on: jQuery (Unraid)
   ═══════════════════════════════════════════════════════════════════════════ */
/* global $ */

(function () {
'use strict';

// Guard against double-init (e.g. partial page reloads)
if (window.__lvtLoaded) return;
window.__lvtLoaded = true;

// ── State & Configuration ─────────────────────────────────────────────────
var _cfg          = window.lvToolConfig || {};
var _tabLoaderUrl = _cfg.tabLoaderUrl || '/plugins/logsviewer/include/tool-loader.php';
var _currentTab   = null;
var _loadingTab   = null; // tab id currently being fetched (for race-condition guard)
var _tabCache     = {};   // tab id -> HTML (cached after first load)
var _tabInitDone  = {};   // tab id -> bool (init callback fired once per tab)

// ── DOM refs ──────────────────────────────────────────────────────────────
var $panel;

// ── Init ──────────────────────────────────────────────────────────────────
// The Saved and Pinned tabs were removed, so there is no tab strip and no
// hash routing any more. The shell simply loads the single Logs view into the
// panel on startup. The loadTab/renderTab/notifyTabReady machinery is kept
// (the Logs tab still arrives as an AJAX fragment and registers itself via
// window.LVT_TAB), just without the navigation around it.
$(function () {
    $panel = $('#lvtPanel');
    if (!$panel.length) return;
    loadTab('logs');
});

// ── Tab loader ────────────────────────────────────────────────────────────
function loadTab(tab) {
    if (_loadingTab === tab) return; // already fetching
    _loadingTab = tab;

    // Serve from cache when available (saves a roundtrip on tab revisits)
    if (_tabCache[tab]) {
        renderTab(tab, _tabCache[tab]);
        return;
    }

    // Show loading state
    $panel.html(
        '<div class="lvt-loading">' +
          '<div class="lvt-loading__spinner"><i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i></div>' +
          '<div class="lvt-loading__text">Loading…</div>' +
        '</div>'
    );

    // Fetch via AJAX
    $.ajax({
        url: _tabLoaderUrl,
        data: { tab: tab },
        type: 'GET',
        dataType: 'html',
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .done(function (html) {
        if (_loadingTab !== tab) return; // another tab clicked meanwhile
        _tabCache[tab] = html;
        renderTab(tab, html);
    })
    .fail(function (xhr) {
        if (_loadingTab !== tab) return;
        var status = xhr && xhr.status ? xhr.status : 0;
        $panel.html(
            '<div class="lvt-error">' +
              '<strong>Failed to load tab "' + escHtml(tab) + '"</strong>' +
              (status ? ' &middot; HTTP ' + status : '') +
              '<div style="margin-top:.4rem;font-size:.85rem;opacity:.75;">' +
                'Refresh the page or check the server log.' +
              '</div>' +
            '</div>'
        );
        _loadingTab = null;
    });
}

function renderTab(tab, html) {
    // Notify outgoing tab so it can pause timers, save state, etc.
    if (_currentTab && _currentTab !== tab) {
        var prevH = window.LVT_TAB._handlers[_currentTab];
        if (prevH && typeof prevH.hide === 'function') {
            try { prevH.hide(); } catch (e) { console.error('[LVT] hide error:', e); }
        }
    }

    // Fade out → swap → fade in
    $panel.addClass('lvt-panel--fade-out');
    setTimeout(function () {
        $panel.html(html);
        $panel.removeClass('lvt-panel--fade-out').addClass('lvt-panel--fade-in');
        setTimeout(function () { $panel.removeClass('lvt-panel--fade-in'); }, 200);

        _currentTab = tab;
        _loadingTab = null;
        notifyTabReady(tab);
    }, 120);
}

// ── Tab-ready hook ────────────────────────────────────────────────────────
// Each tab's own JS (loaded in later phases) can register itself via:
//   window.LVT_TAB.register('logs', { init: function(){...}, refresh: function(){...} });
// We call init() the first time the tab is shown, refresh() on subsequent shows.
window.LVT_TAB = window.LVT_TAB || {
    _handlers: {},
    register: function (tab, handlers) {
        this._handlers[tab] = handlers || {};
        // If this tab is currently visible, fire its init now
        if (_currentTab === tab && !_tabInitDone[tab]) {
            try { handlers.init && handlers.init(); } catch (e) { console.error(e); }
            _tabInitDone[tab] = true;
        }
    }
};

function notifyTabReady(tab) {
    var h = window.LVT_TAB._handlers[tab];
    if (!h) return; // no handler registered yet (tab JS may load later)
    try {
        if (!_tabInitDone[tab]) {
            h.init && h.init();
            _tabInitDone[tab] = true;
        } else {
            h.refresh && h.refresh();
        }
    } catch (e) {
        console.error('[LVT] tab handler error for "' + tab + '":', e);
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]);
    });
}

})();
