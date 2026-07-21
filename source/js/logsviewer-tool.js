/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

(function () {
'use strict';

if (window.__lvtLoaded) return;
window.__lvtLoaded = true;

var _cfg          = window.lvToolConfig || {};
var _tabLoaderUrl = _cfg.tabLoaderUrl || '/plugins/logsviewer/include/tool-loader.php';
var _currentTab   = null;
var _loadingTab   = null;
var _tabCache     = {};
var _tabInitDone  = {};

var $panel;

$(function () {
    $panel = $('#lvtPanel');
    if (!$panel.length) return;
    loadTab('logs');
});

// fetch the tab html over ajax, cache it so re-opening is instant
function loadTab(tab) {
    if (_loadingTab === tab) return;
    _loadingTab = tab;

    if (_tabCache[tab]) {
        renderTab(tab, _tabCache[tab]);
        return;
    }

    $panel.html(
        '<div class="lvt-loading">' +
          '<div class="lvt-loading__spinner"><i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i></div>' +
          '<div class="lvt-loading__text">Loading…</div>' +
        '</div>'
    );

    $.ajax({
        url: _tabLoaderUrl,
        data: { tab: tab },
        type: 'GET',
        dataType: 'html',
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .done(function (html) {
        if (_loadingTab !== tab) return;
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

    if (_currentTab && _currentTab !== tab) {
        var prevH = window.LVT_TAB._handlers[_currentTab];
        if (prevH && typeof prevH.hide === 'function') {
            try { prevH.hide(); } catch (e) { console.error('[LVT] hide error:', e); }
        }
    }

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

window.LVT_TAB = window.LVT_TAB || {
    _handlers: {},
    register: function (tab, handlers) {
        this._handlers[tab] = handlers || {};

        if (_currentTab === tab && !_tabInitDone[tab]) {
            try { handlers.init && handlers.init(); } catch (e) { console.error(e); }
            _tabInitDone[tab] = true;
        }
    }
};

// tell the tab's own script it's now in the dom and visible
function notifyTabReady(tab) {
    var h = window.LVT_TAB._handlers[tab];
    if (!h) return;
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

function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]);
    });
}

})();
