/* ============================================================================
   LOGS VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

let logsviewer_cfg = {};
let logsviewer_searchState = { term: '', hits: [], idx: -1 };
let logsviewer_pauseHoverActive = false;
let logsviewer_lastRenderKey = '';
let logsviewer_systemFetchCounter = 0;

const logsviewer_dom = {
    get logs()       { return this._logs       || (this._logs       = document.getElementById('logsviewer-logs')); },
    get container()  { return this._container  || (this._container  = document.getElementById('logsviewer-container')); },
    get autoscroll() { return this._autoscroll || (this._autoscroll = document.getElementById('logsviewer-autoscroll')); },
    get timestamp()  { return this._timestamp  || (this._timestamp  = document.getElementById('logsviewer-timestamp')); },
    get toastLine()  { return this._toastLine  || (this._toastLine  = document.getElementById('logsviewer-toast-line')); },
    get toastRight() { return this._toastRight || (this._toastRight = document.getElementById('logsviewer-toast-right')); },
    get totalLines() { return this._totalLines || (this._totalLines = document.getElementById('logsviewer-total-lines')); },
    clear() { this._logs = this._container = this._autoscroll = this._timestamp = this._toastLine = this._toastRight = this._totalLines = null; }
};

let logsviewer_activeCategory = 'system';
let logsviewer_categoryData = {};
let logsviewer_contentHashes = {};
let logsviewer_activeLogContent = '';
let logsviewer_activeLogTotalLines = 0;

let logsviewer_lastShown = { category: null, source: null };

const LV_RE_HEADER = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^:]+:)/gm;
const LV_RE_LEVELS_COMBINED = /\b(emergency|critical|alert|fatal|panic|error|err|warning|warn|info|notice|trace|debug)\b/gi;
const LV_RE_LEVELS_KEYWORDS = /\b(emergency|critical|alert|fatal|panic|error|err|warning|warn|info)\b/gi;
const LV_LEVEL_CLASS = {
    emergency: 'logsviewer-lvl-emergency', critical: 'logsviewer-lvl-critical',
    alert: 'logsviewer-lvl-alert', fatal: 'logsviewer-lvl-fatal', panic: 'logsviewer-lvl-panic',
    error: 'logsviewer-lvl-error', err: 'logsviewer-lvl-error',
    warning: 'logsviewer-lvl-warning', warn: 'logsviewer-lvl-warn',
    info: 'logsviewer-lvl-info', notice: 'logsviewer-lvl-notice',
    trace: 'logsviewer-lvl-trace', debug: 'logsviewer-lvl-debug',
};
// precompiled so the render path doesn't rebuild these on every poll
const LV_RE_COUNT = {
    critical: /\b(?:emergency|critical|alert|fatal|panic)\b/i,
    error:    /\b(?:error|err)\b/i,
    warning:  /\b(?:warning|warn)\b/i,
    info:     /\b(?:info|notice)\b/i,
};
const LV_RE_FILTER = {
    info:     /\b(?:info|notice)\b/i,
    errors:   /\b(?:error|err|critical|fatal|panic|emerg(?:ency)?|alert)\b/i,
    warnings: /\b(?:warning|warn)\b/i,
    critical: /\b(?:emergency|critical|fatal|panic|alert|emerg(?:ency)?)\b/i,
    auth:     /\b(?:auth|authentication|login|logout|oidc|token|jwt|sso)\b/i,
};

let logsviewer_lightThemeCache = null;
function logsviewer_isLightTheme() {
    if (logsviewer_lightThemeCache !== null) return logsviewer_lightThemeCache;

    var el = document.querySelector('.logsviewer-body, .logsviewer-tool-wrapper');
    if (el && el.classList.contains('lv-light')) { logsviewer_lightThemeCache = true; return true; }

    try {
        var bg = getComputedStyle(document.body).backgroundColor;
        var m = bg.match(/(\d+)/g);
        if (m && m.length >= 3) {
            var lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
            logsviewer_lightThemeCache = (lum > 0.5);
            return logsviewer_lightThemeCache;
        }
    } catch (_) {}
    logsviewer_lightThemeCache = false;
    return false;
}

// php injects .lv-light when it can, this is the luminance fallback when it can't
function logsviewer_detectTheme() {
    if (!logsviewer_isLightTheme()) return;
    document.querySelectorAll('.logsviewer-body, .logsviewer-tool-wrapper').forEach(function(el) {
        if (!el.classList.contains('lv-light')) el.classList.add('lv-light');
    });
}

let logsviewer_lastLoginEventId = null;

function logsviewer_getActiveSource() {
    var btn = $('.logsviewer-cat-btn[data-category="' + logsviewer_activeCategory + '"]');
    return btn.attr('data-selected') || '';
}

function logsviewer_findLogData(category, sourceName) {
    var data = logsviewer_categoryData[category];
    if (!Array.isArray(data)) return null;
    for (var i = 0; i < data.length; i++) {
        if (data[i].name === sourceName) return data[i];
    }
    return null;
}

// merge a single-source refresh back into the cached full set
function logsviewer_mergeSourceData(category, scripts, singleSource) {
    if (singleSource && logsviewer_categoryData[category]) {
        var existing = logsviewer_categoryData[category];
        for (var si = 0; si < scripts.length; si++) {
            var merged = false;
            for (var ei = 0; ei < existing.length; ei++) {
                if (existing[ei].name === scripts[si].name) {
                    existing[ei] = scripts[si];
                    merged = true;
                    break;
                }
            }
            if (!merged) existing.push(scripts[si]);
        }
    } else {
        logsviewer_categoryData[category] = scripts;
    }
}

function logsviewer_showLog(entry) {
    var logDisplay = $(logsviewer_dom.logs);
    if (!entry || !logDisplay.length) return;
    logsviewer_activeLogContent = entry.log || '';
    logsviewer_activeLogTotalLines = entry.total_lines || 0;
    logsviewer_lastShown = { category: entry.category || logsviewer_activeCategory || null, source: entry.name || entry.display_name || null };
    logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
    logsviewer_updateToastRight(entry, logsviewer_lastBadgeCounts);
    logsviewer_updateSelectedToast();
    logsviewer_layoutToasts();

    try{
        const name = String(entry.name || entry.display_name || '').toLowerCase();
        const cat  = String(entry.category || logsviewer_activeCategory || '').toLowerCase();
        if(cat === 'system' && name === 'syslog'){
            logsviewer_checkLoginToast(logsviewer_activeLogContent);
        }
    }catch(_){ }

    if (logsviewer_cfg.searchEnabled && String(logsviewer_searchState.term || '').trim()) {
        var count = logsviewer_countMatches(logsviewer_activeLogContent, logsviewer_searchState.term);
        logsviewer_updateSearchToast(count);

        logsviewer_searchTypingTimer = setTimeout(() => {
            logsviewer_searchTyping = false;
            const perf = document.getElementById('logsviewer-perf-toast');
            if (perf) perf.dataset.lvSuppressedBySearch = '1';
            logsviewer_layoutToasts();
        }, 700);

    }
}

let logsviewer_forceLoginUntil = 0;
let logsviewer_perfToastTimer   = null;
let logsviewer_perfToastSetThisRender = false;

let logsviewer_prevTotalLines = null;
let logsviewer_prevErrorCount = null;
let logsviewer_prevCriticalCount = null;
let logsviewer_lastBadgeCounts = null;
let logsviewer_toastRightSource = null;

function logsviewer_formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function logsviewer_updateToastRight(entry, badgeCounts) {
    var right = logsviewer_dom.toastRight;
    if (!right) return;

    var sourceKey = String(entry && entry.source || '') + '|' + String(entry && entry.name || '');
    if (sourceKey !== logsviewer_toastRightSource) {
        logsviewer_prevTotalLines = null;
        logsviewer_prevErrorCount = null;
        logsviewer_prevCriticalCount = null;
        logsviewer_toastRightSource = sourceKey;
        logsviewer_perfToastDismissed = false;
    }

    var parts = [];
    var totalLines = Number(entry && entry.total_lines || 0);
    var fileSize = Number(entry && entry.file_size || 0);
    var errCount = Number(badgeCounts && badgeCounts.error || 0);
    var critCount = Number(badgeCounts && badgeCounts.critical || 0);

    if (logsviewer_prevTotalLines !== null && totalLines > logsviewer_prevTotalLines) {
        var diff = totalLines - logsviewer_prevTotalLines;
        parts.push('<span class="lv-toast-newlines">+' + diff + ' new lines</span>');
    }

    if (logsviewer_prevErrorCount !== null && errCount > logsviewer_prevErrorCount) {
        var errDiff = errCount - logsviewer_prevErrorCount;
        if (parts.length) parts.push('<span class="lv-toast-sep"></span>');
        parts.push('<span class="lv-toast-newerrors">+' + errDiff + ' err</span>');
    }

    if (logsviewer_prevCriticalCount !== null && critCount > logsviewer_prevCriticalCount) {
        var critDiff = critCount - logsviewer_prevCriticalCount;
        if (parts.length) parts.push('<span class="lv-toast-sep"></span>');
        parts.push('<span class="lv-toast-newcritical">+' + critDiff + ' crit</span>');
    }

    if (fileSize > 0) {
        if (parts.length) parts.push('<span class="lv-toast-sep"></span>');
        parts.push('<span class="lv-toast-size">' + logsviewer_formatFileSize(fileSize) + '</span>');
    }

    logsviewer_prevTotalLines = totalLines;
    logsviewer_prevErrorCount = errCount;
    logsviewer_prevCriticalCount = critCount;

    right.innerHTML = parts.join('');

    var panel = document.querySelector('.logsviewer-toast-panel');
    if (panel && parts.length) panel.style.display = '';
}

function logsviewer_showLoginToast(message){

  try{
    const line = $(logsviewer_dom.toastLine);
    if(!line.length) return;

    let el = document.getElementById('logsviewer-login-toast');
    if(!el){
      el = document.createElement('div');
      el.id = 'logsviewer-login-toast';
      el.className = 'logsviewer-login-toast';
      el.style.display = 'none';
      el.setAttribute('aria-live','polite');
      line.append(el);
    }

    if(!message){
      el.textContent = '';
      el.style.display = 'none';
      try{ localStorage.removeItem(logsviewer_storageKey('logsviewer_last_login_msg')); }catch(_){ }
      logsviewer_layoutToasts();
      return;
    }

    el.textContent = message;
    el.style.display = '';
    try{ localStorage.setItem(logsviewer_storageKey('logsviewer_last_login_msg'), message); }catch(_){ }
    logsviewer_layoutToasts();
  }catch(_){ }
}

function logsviewer_getSelectedLabel() {

    try {
        var cat  = String((logsviewer_lastShown && logsviewer_lastShown.category) || logsviewer_activeCategory || '');
        var src  = String((logsviewer_lastShown && logsviewer_lastShown.source)   || '');
        if (!src) return '';

        var catLabel = cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();

        var srcLabel = src.replace(/[-_]/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });

        return catLabel + ' → ' + srcLabel;
    } catch(_) { return ''; }
}

function logsviewer_ensureSelectedToast() {
    var line = document.getElementById('logsviewer-toast-line');
    if (!line) return null;
    var el = document.getElementById('logsviewer-selected-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'logsviewer-selected-toast';
        el.className = 'logsviewer-selected-toast';
        el.style.display = 'none';
        line.appendChild(el);
    }
    return el;
}

function logsviewer_updateSelectedToast() {
    var el = logsviewer_ensureSelectedToast();
    if (!el) return;
    var label = logsviewer_getSelectedLabel();
    if (label) {
        el.textContent = 'Selected: ' + label;
    }
}

function logsviewer_restoreLoginToast(){
  try{
    const msg = localStorage.getItem(logsviewer_storageKey('logsviewer_last_login_msg'));
    if(msg) logsviewer_showLoginToast(msg);
  }catch(_){ }
}

// pull the most recent ssh / webgui / pam login line out of the tail
function logsviewer_extractLoginEvent(text){
    const t = String(text || '');
    if(!t) return null;

    const lines = t.split(/\r?\n/);
    const start = Math.max(0, lines.length - 250);

    const reSuccess = [

        /\bSuccessful\s+login\s+user\s+(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,

        /Accepted\s+(?:password|publickey)\s+for\s+(?<user>[^\s]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,

        /\bSuccessful\s+login\s+(?:for\s+user\s+)?(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i,

        /user\s+(?<user>[^\s,;]+)\s+logged\s+in.*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i
    ];
    const reFail = [

        /Unsuccessful\s+login(?:\s+attempt)?\s+(?:for\s+)?(?:user\s+)?(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /Unsuccessful\s+login(?:\s+attempt)?.*?user[:\s]+(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i,

        /Failed\s+login\s+user\s+(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /Failed\s+password\s+for\s+(?:invalid\s+user\s+)?(?<user>[^\s]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /authentication\s+failure.*?user=(?<user>[^\s]+).*?(?:rhost=(?<ip>[0-9a-fA-F:\.]+))?/i,
        /Failed\s+login.*?(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i
    ];

    for(let i = lines.length - 1; i >= start; i--){
        const line = lines[i];
        if(!line) continue;

        for(const r of reFail){
            const m = line.match(r);
            if(m){
                const user = (m.groups && m.groups.user) ? String(m.groups.user) : 'user';
                const ip = (m.groups && m.groups.ip) ? String(m.groups.ip) : '';
                return { type:'fail', id: line.trim(), user, ip };
            }
        }
        for(const r of reSuccess){
            const m = line.match(r);
            if(m){
                const user = (m.groups && m.groups.user) ? String(m.groups.user) : 'user';
                const ip = (m.groups && m.groups.ip) ? String(m.groups.ip) : '';
                return { type:'success', id: line.trim(), user, ip };
            }
        }
    }
    return null;
}

function logsviewer_checkLoginToast(rawText){
    try{
        const ev = logsviewer_extractLoginEvent(rawText);
        if(!ev) return;

        if(!logsviewer_lastLoginEventId){
            logsviewer_lastLoginEventId = localStorage.getItem(logsviewer_storageKey('logsviewer_last_login_event')) || null;
        }
        if(ev.id && ev.id === logsviewer_lastLoginEventId) return;

        logsviewer_lastLoginEventId = ev.id;
        localStorage.setItem(logsviewer_storageKey('logsviewer_last_login_event'), ev.id);

        const who = ev.user || 'user';
        const ip  = ev.ip || 'unknown';
        const msg = (ev.type === 'success')
            ? `Login successful: ${who} IP: ${ip}`
            : `Login failed: ${who} IP: ${ip}`;

        logsviewer_forceLoginUntil = Date.now() + 6500;
        logsviewer_showLoginToast(msg);
    }catch(_){ }
}

function logsviewer_markActiveItem(cat, sourceName) {
    $('.logsviewer-cat-dropdown li').removeClass('lv-item--active');
    if (cat && sourceName) {
        var $drop = $('#logsviewer-cat-' + cat);
        $drop.find('li[data-value="' + sourceName + '"]').addClass('lv-item--active');
    }
}

// main poll: fetch a category (or one source), update the view and the badges
function logsviewer_fetchCategory(category, callback, opts) {
    opts = opts || {};
    var autoShow = (opts.autoShow !== false);
    var singleSource = opts.source || null;
    var params = { category: category };
    if (singleSource) params.source = singleSource;

    var hashKey = category + '|' + (singleSource || '*');
    if (!opts.skipHash) {
        var knownHash = logsviewer_contentHashes[hashKey] || '';
        if (knownHash) params._since_hash = knownHash;
    }

    var url = logsviewer_apiUrl('get_script_states', params);

    $.ajax({ url: url, dataType: 'json', timeout: 15000 })
        .done(function(data, textStatus, jqXHR) {

            var newHash = jqXHR.getResponseHeader('X-LV-Hash') || (data && data._hash) || '';
            if (newHash) logsviewer_contentHashes[hashKey] = newHash;

            if (data && data.unchanged === true) {

                if (autoShow && category === logsviewer_activeCategory) {
                    var timestampDisplay = $(logsviewer_dom.timestamp);
                    if (timestampDisplay.length && logsviewer_cfg.showTimestamp) {
                        timestampDisplay.text(new Date().toLocaleTimeString([], {hour12: false}));
                    }
                }
                if (callback) callback(logsviewer_categoryData[category] || []);
                return;
            }

            var scripts = Array.isArray(data) ? data : [];
            logsviewer_mergeSourceData(category, scripts, singleSource);

            if (!singleSource && category !== 'system' && category !== 'custom') {
                var $drop = $('#logsviewer-cat-' + category);
                var $tabBtn = $('.logsviewer-cat-btn[data-category="' + category + '"]');
                var prevVal = $tabBtn.attr('data-selected') || '';
                $drop.empty();
                scripts.forEach(function(s) {
                    var name = s.display_name || s.name;
                    var $li = $('<li>').attr('data-value', s.name);

                    if (category === 'docker' || category === 'vm') {
                        var dotClass = (s.status === 'running') ? 'lv-drop-dot--running' : 'lv-drop-dot--stopped';
                        $li.append($('<span>').addClass('lv-drop-dot ' + dotClass));
                    }
                    $li.append(document.createTextNode(name));
                    $drop.append($li);
                });

                if (prevVal && $drop.find('li[data-value="' + prevVal + '"]').length) {
                    $tabBtn.attr('data-selected', prevVal);

                    logsviewer_markActiveItem(category, prevVal);
                } else {
                    $tabBtn.attr('data-selected', '');
                }
            }

            var tab = $('.logsviewer-cat-btn[data-category="' + category + '"]');
            if (scripts.length > 0) {
                tab.removeClass('logsviewer-cat-btn--hidden');
            }

            if (autoShow) {
            if (category === logsviewer_activeCategory) {
                var $tabNow = $('.logsviewer-cat-btn[data-category="' + category + '"]');
                var sourceName = $tabNow.attr('data-selected') || '';
                var entry = logsviewer_findLogData(category, sourceName);

                if (entry) {
                    logsviewer_showLog(entry);
                    logsviewer_markActiveItem(category, sourceName);

                    var $nativeSel = $tabNow.find('.logsviewer-cat-native');
                    try { $nativeSel[0].value = sourceName; } catch(_) {}
                } else if (scripts.length > 0 && !sourceName) {

                    $tabNow.attr('data-selected', scripts[0].name);
                    logsviewer_showLog(scripts[0]);
                    logsviewer_markActiveItem(category, scripts[0].name);

                    var $nativeSelFb = $tabNow.find('.logsviewer-cat-native');
                    try { $nativeSelFb[0].value = scripts[0].name; } catch(_) {}
                }

                logsviewer_updateCompactIndicators(logsviewer_categoryData[category] || scripts);

                var timestampDisplay = $(logsviewer_dom.timestamp);
                if (timestampDisplay.length && logsviewer_cfg.showTimestamp) {
                    timestampDisplay.text(new Date().toLocaleTimeString([], {hour12: false}));
                }
            }

            }

            if (callback) callback(scripts);
        })
        .fail(function(jqXHR) {

            if (jqXHR && jqXHR.status === 403) {
                logsviewer_refreshNonce(function(ok) {
                    if (ok) {

                        var retryUrl = logsviewer_apiUrl('get_script_states', params);
                        $.ajax({ url: retryUrl, dataType: 'json', timeout: 15000 })
                            .done(function(data, textStatus, jqXHR2) {
                                var rh = jqXHR2.getResponseHeader('X-LV-Hash') || (data && data._hash) || '';
                                if (rh) logsviewer_contentHashes[hashKey] = rh;
                                if (data && data.unchanged === true) {
                                    if (callback) callback(logsviewer_categoryData[category] || []);
                                    return;
                                }
                                var scripts = Array.isArray(data) ? data : [];
                                logsviewer_mergeSourceData(category, scripts, singleSource);
                                if (callback) callback(scripts);
                            })
                            .fail(function() {
                                if (callback) callback([]);
                            });
                    } else {
                        if (callback) callback([]);
                    }
                });
                return;
            }
            if (callback) callback([]);
        });
}

function logsviewer_storageKey(base) {
    const ctx = (logsviewer_cfg && logsviewer_cfg.apiContext) || 'dashboard';
    return base + '_' + ctx;
}

function logsviewer_apiUrl(action, extraParams) {
    let url = '/plugins/logsviewer/include/logsviewer_api.php?action=' + encodeURIComponent(action);
    if (logsviewer_cfg.apiContext) {
        url += '&context=' + encodeURIComponent(logsviewer_cfg.apiContext);
    }

    if (logsviewer_cfg.lvToken) {
        url += '&_lvt=' + encodeURIComponent(logsviewer_cfg.lvToken);
    }
    if (extraParams) {
        Object.keys(extraParams).forEach(function(k) {
            url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]);
        });
    }
    return url;
}

let logsviewer_nonceRefreshing = false;

function logsviewer_refreshNonce(callback) {
    if (logsviewer_nonceRefreshing) return;
    logsviewer_nonceRefreshing = true;

    var url = '/plugins/logsviewer/include/logsviewer_api.php?action=refresh_nonce';
    if (logsviewer_cfg.apiContext) {
        url += '&context=' + encodeURIComponent(logsviewer_cfg.apiContext);
    }

    $.ajax({ url: url, dataType: 'json', timeout: 5000 })
        .done(function(data) {
            if (data && data.token) {
                logsviewer_cfg.lvToken = data.token;
            }
            logsviewer_nonceRefreshing = false;
            if (callback) callback(true);
        })
        .fail(function() {
            logsviewer_nonceRefreshing = false;
            if (callback) callback(false);
        });
}

function logsviewer_updateCompactIndicators(scripts) {
    const compactContainer = $('#logsviewer-compact-indicators');
    if (!compactContainer.length) return;

    compactContainer.empty();

    let runningCount = 0;

    if (Array.isArray(scripts) && scripts.length > 0) {
        scripts.forEach(script => {
            const indicator = $('<span>')
                .addClass('logsviewer-compact-indicator')
                .toggleClass('logsviewer-compact-indicator--running', script.status === 'running')
                .text(script.name);

            compactContainer.append(indicator);

            if (script.status === 'running') {
                runningCount += 1;
            }
        });
    }

    const summaryText = $('#logsviewer-head-summary-text');
    if (summaryText.length) {
        summaryText.text(
            runningCount > 0
                ? `${runningCount} running`
                : 'No scripts running'
        );
    }
}

function logsviewer_getFilterValue() {
    const sel = $('#logsviewer-filter-select');
    return sel.length ? sel.val() : 'none';
}

function logsviewer_setFilterValue(filterValue) {

    const sel = $('#logsviewer-filter-select');
    if (!sel.length) return;
    sel.val(filterValue).trigger('change');
}

function logsviewer_getFilterLabel(filter) {
    const labels = {
        none: 'none',
        info: 'info',
        errors: 'errors',
        warnings: 'warnings',
        critical: 'critical',
        auth: 'auth',
    };
    return labels[filter] || String(filter || 'none');
}

function logsviewer_applyFilterToText(raw) {
    const filter = logsviewer_getFilterValue();
    const text = String(raw || '');
    if (filter === 'none') return text;

    const re = LV_RE_FILTER[filter];
    if (!re) return text;

    const lines = text.split('\n');
    return lines.filter(function(l) { return re.test(l); }).join('\n');
}

function logsviewer_countLevels(text) {
    const t = String(text || '');
    const lines = t.split('\n');
    const counts = { critical: 0, error: 0, warning: 0, info: 0 };
    for (var i = 0, len = lines.length; i < len; i++) {
        var line = lines[i];
        if (!line) continue;
        if (LV_RE_COUNT.critical.test(line)) { counts.critical++; continue; }
        if (LV_RE_COUNT.error.test(line))    { counts.error++;    continue; }
        if (LV_RE_COUNT.warning.test(line))  { counts.warning++;  continue; }
        if (LV_RE_COUNT.info.test(line))     { counts.info++;     }
    }
    return counts;
}

function logsviewer_syncBadgeSelection(filterValue) {
    var badges = document.querySelectorAll('.logsviewer-badge');
    badges.forEach(function(el) {
        var df = el.getAttribute('data-filter') || '';
        if (filterValue && filterValue !== 'none' && df === filterValue) {
            el.classList.add('logsviewer-badge--selected');
        } else {
            el.classList.remove('logsviewer-badge--selected');
        }
    });
}

function logsviewer_updateBadges(counts) {
    const badges = [
        { key: 'info',     id: '#logsviewer-badge-info',     label: 'Info',     filter: 'info',     numClass: 'logsviewer-count--info' },
        { key: 'error',    id: '#logsviewer-badge-errors',   label: 'Errors',   filter: 'errors',   numClass: 'logsviewer-count--error' },
        { key: 'warning',  id: '#logsviewer-badge-warnings', label: 'Warnings', filter: 'warnings', numClass: 'logsviewer-count--warning' },
        { key: 'critical', id: '#logsviewer-badge-critical', label: 'Critical', filter: 'critical', numClass: 'logsviewer-count--critical' },
    ];

    badges.forEach(b => {
        const el = logsviewer_dom['_badge_' + b.key] || (logsviewer_dom['_badge_' + b.key] = document.querySelector(b.id));
        if (!el) return;

        const v = Number(counts[b.key] || 0);

        el.innerHTML = `<span class="logsviewer-badge-label">${b.label}</span> <span class="logsviewer-badge-count ${b.numClass}">${v}</span>`;
        el.classList.toggle('is-zero', v === 0);
        el.dataset.filter = b.filter;
        el.title = `Set filter: ${b.filter} (${b.label} = ${v})`;
    });

    logsviewer_updateProportionStrip(counts);
}

function logsviewer_updateProportionStrip(counts) {
    var i = Math.max(0, Number(counts.info || 0));
    var w = Math.max(0, Number(counts.warning || 0));
    var e = Math.max(0, Number(counts.error || 0));
    var c = Math.max(0, Number(counts.critical || 0));
    var total = i + w + e + c;
    if (total <= 0) total = 1;

    var si = logsviewer_dom._stripI || (logsviewer_dom._stripI = document.getElementById('logsviewer-strip-info'));
    var sw = logsviewer_dom._stripW || (logsviewer_dom._stripW = document.getElementById('logsviewer-strip-warn'));
    var se = logsviewer_dom._stripE || (logsviewer_dom._stripE = document.getElementById('logsviewer-strip-error'));
    var sc = logsviewer_dom._stripC || (logsviewer_dom._stripC = document.getElementById('logsviewer-strip-crit'));
    var so = logsviewer_dom._stripO || (logsviewer_dom._stripO = document.getElementById('logsviewer-strip-ok'));
    if (!si || !sw || !se || !sc) return;

    var colorTotal = i + w + e + c;
    var okFlex = Math.max(0, 100 - colorTotal);
    si.style.flex = String(Math.max(i > 0 ? 0.5 : 0, i));
    sw.style.flex = String(Math.max(w > 0 ? 0.5 : 0, w));
    se.style.flex = String(Math.max(e > 0 ? 0.5 : 0, e));
    sc.style.flex = String(Math.max(c > 0 ? 0.5 : 0, c));
    if (so) so.style.flex = String(okFlex);
}

function logsviewer_tailText(text, n) {
    const N = Number(n) || 0;
    if (!N || N <= 0) return String(text || '');
    var raw = String(text || '');

    var count = 0, pos = raw.length;
    while (pos > 0 && count < N) {
        pos = raw.lastIndexOf('\n', pos - 1);
        if (pos === -1) break;
        count++;
    }
    if (pos <= 0) return raw;
    return raw.substring(pos + 1);
}

function logsviewer_escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logsviewer_countMatches(raw, term) {
    const t = String(term || '').trim();
    if (!t) return 0;
    const text = String(raw || '');
    try {
        const re = new RegExp(logsviewer_escapeRegExp(t), 'gi');
        const m = text.match(re);
        return m ? m.length : 0;
    } catch (e) {

        return 0;
    }
}

const LV_RE_TAG_SPLIT = /(<[^>]+>)|([^<]+)/g;

function logsviewer_applySearchHighlight(text) {
    if (!logsviewer_cfg.searchEnabled) return String(text || '');
    const term = String(logsviewer_searchState.term || '').trim();
    if (!term) return String(text || '');

    const cls = logsviewer_cfg.searchHighlight
        ? 'logsviewer-search-hit logsviewer-search-hit--visible'
        : 'logsviewer-search-hit';

    const re = new RegExp(logsviewer_escapeRegExp(term), 'gi');

    LV_RE_TAG_SPLIT.lastIndex = 0;
    return String(text || '').replace(LV_RE_TAG_SPLIT, function(match, tag, txt) {
        if (tag) return tag;
        return txt.replace(re, (m) => `<span class="${cls}">${m}</span>`);
    });
}

function logsviewer_collectSearchHits() {
    const term = String(logsviewer_searchState.term || '').trim();
    if (!term) {
        logsviewer_searchState.hits = [];
        logsviewer_searchState.idx = -1;
        logsviewer_updateSearchToast(0);
        return;
    }

    const hits = $('#logsviewer-logs .logsviewer-search-hit').toArray();
    logsviewer_searchState.hits = hits;
    logsviewer_searchState.idx = hits.length ? 0 : -1;
    logsviewer_updateSearchToast(hits.length);
}

function logsviewer_scrollToHit(idx) {
    const hits = logsviewer_searchState.hits || [];
    if (!hits.length) return;
    const i = Math.max(0, Math.min(idx, hits.length - 1));
    logsviewer_searchState.idx = i;

    const node = hits[i];
    const container = $(logsviewer_dom.container).get(0);
    if (!container || !node) return;

    const nodeTop = node.getBoundingClientRect().top;
    const contTop = container.getBoundingClientRect().top;
    container.scrollTop += (nodeTop - contTop) - 40;
}

function logsviewer_searchNext() {
    const hits = logsviewer_searchState.hits || [];
    if (!hits.length) return;
    const next = (logsviewer_searchState.idx + 1) % hits.length;
    logsviewer_scrollToHit(next);
}

function logsviewer_searchPrev() {
    const hits = logsviewer_searchState.hits || [];
    if (!hits.length) return;
    const prev = (logsviewer_searchState.idx - 1 + hits.length) % hits.length;
    logsviewer_scrollToHit(prev);
}

function logsviewer_ensureSearchToast() {
    if ($('#logsviewer-search-toast').length) return;
    const line = $(logsviewer_dom.toastLine);
    if (!line.length) return;
    line.append('<div id="logsviewer-search-toast" class="logsviewer-search-toast" aria-live="polite"></div>');
}

function logsviewer_updateSearchToast(count) {
    logsviewer_ensureSearchToast();
    const toast = $('#logsviewer-search-toast');
    if (!toast.length) return;
    const term = String(logsviewer_searchState.term || '').trim();
    if (!term) {
        toast.hide().text('');
        logsviewer_layoutToasts();
        return;
    }
    const num = Number(count) || 0;
    const label = (num === 1) ? 'match' : 'matches';

    toast.html(`<span class="lv-toast-num">${num}</span> <span class="lv-toast-label">${label}</span>`).show();

    logsviewer_layoutToasts();
}

let logsviewer_searchTyping = false;
let logsviewer_searchTypingTimer = null;

let logsviewer_layoutToastsRaf = null;
function logsviewer_layoutToasts(){

    if (logsviewer_layoutToastsRaf) return;
    logsviewer_layoutToastsRaf = requestAnimationFrame(function(){
        logsviewer_layoutToastsRaf = null;
        logsviewer_layoutToastsImpl();
    });
}
function logsviewer_layoutToastsImpl(){
    const line = $(logsviewer_dom.toastLine);

    if(!line.length) return;

    const searchToast = $('#logsviewer-search-toast');
    const perfToast = $('#logsviewer-perf-toast');
    const loginToast = $('#logsviewer-login-toast');

    const searchVisible = searchToast.length && searchToast.is(':visible') && String(searchToast.text() || '').trim() !== '';
    const perfHasText = perfToast.length && String(perfToast.text() || '').trim() !== '';
    const loginHasText = loginToast.length && String(loginToast.text() || '').trim() !== '';

    const panel = $('.logsviewer-toast-panel');
    const forceLogin = (Date.now() < (logsviewer_forceLoginUntil || 0));

    if (logsviewer_searchTyping) {

        if (perfToast.length) {
            perfToast[0].dataset.lvSuppressedBySearch = '1';
            perfToast.hide();
        }
        if (loginToast.length) loginToast.hide();
        var selToastS = document.getElementById('logsviewer-selected-toast');
        if (selToastS) selToastS.style.display = 'none';
        if (searchToast.length) {
            if (searchVisible) searchToast.show(); else searchToast.hide();
        }
        if(panel.length) panel.show();
        return;
    }

    if (searchVisible) {

        if (searchToast.length) searchToast.show();
        if (perfToast.length) perfToast.hide();
        if (loginToast.length) loginToast.hide();
        var selToastSV = document.getElementById('logsviewer-selected-toast');
        if (selToastSV) selToastSV.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    if (forceLogin && loginToast.length && loginHasText) {
        loginToast.show();
        if (perfToast.length) perfToast.hide();
        if (searchToast.length) searchToast.hide();
        var selToastF = document.getElementById('logsviewer-selected-toast');
        if (selToastF) selToastF.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    if (perfToast.length && perfHasText) {
        perfToast.show();

        if (perfToast[0].dataset.lvSuppressedBySearch === '1') {
            perfToast[0].dataset.lvSuppressedBySearch = '0';
            logsviewer_startPerfFlash(perfToast[0], 2);
        }
    } else if (perfToast.length) {
        perfToast.hide();
    }

    if (searchToast.length) searchToast.hide();

    if (perfToast.length && perfHasText) {
        if (loginToast.length) loginToast.hide();
        var selToastA = document.getElementById('logsviewer-selected-toast');
        if (selToastA) selToastA.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    logsviewer_updateSelectedToast();
    var selToast = document.getElementById('logsviewer-selected-toast');
    var selLabel = logsviewer_getSelectedLabel();
    if (selToast && selLabel) {
        selToast.style.display = 'block';
        if (loginToast.length) loginToast.hide();
        if(panel.length) panel.show();
        return;
    }

    if (loginToast.length && loginHasText) {
        loginToast.show();
        if(panel.length) panel.show();
        return;
    }

    if (perfToast.length) perfToast.hide();
    if (loginToast.length) loginToast.hide();
    if (searchToast.length) searchToast.hide();
    var rightSlot = logsviewer_dom.toastRight;
    var rightHasContent = rightSlot && rightSlot.innerHTML.trim() !== '';
    if(panel.length) { if (rightHasContent) panel.show(); else panel.hide(); }
}

function logsviewer_ensureSearchUi() {
    if (!logsviewer_cfg.searchEnabled) return;
    if ($('#logsviewer-search-input').length) return;

    let headerRight = $('.logsviewer-header__right');
    const isLegacy = !headerRight.length;
    if (isLegacy) {
        headerRight = $('.logsviewer-legacy-controls');
    }
    if (!headerRight.length) return;

    let inputsRow = headerRight.find('.logsviewer-header__inputs').first();
    if (!inputsRow.length) {
        inputsRow = $('<div class="logsviewer-header__inputs"></div>');
        const controls = headerRight.find(isLegacy ? '.logsviewer-legacy-controls__controls' : '.logsviewer-header__controls').first();
        if (controls.length) {
            inputsRow.insertAfter(controls);
        } else {
            headerRight.append(inputsRow);
        }
    }

    const ui = $(`
      <div class="logsviewer-search logsviewer-search--header" aria-label="Search logs">
        <input id="logsviewer-search-input" type="text" placeholder="Search..." autocomplete="off" />
      </div>
    `);

    inputsRow.append(ui);

    logsviewer_ensureSearchToast();

    let logsviewer_searchRenderTimer = null;
    $('#logsviewer-search-input').on('input', function() {
        const term = String(this.value || '');
        logsviewer_searchState.term = term;
        logsviewer_ensureSearchToast();

        logsviewer_searchTyping = true;
        if (logsviewer_searchTypingTimer) clearTimeout(logsviewer_searchTypingTimer);
        logsviewer_searchTypingTimer = setTimeout(() => {
            logsviewer_searchTyping = false;
            logsviewer_layoutToasts();
        }, 700);
        logsviewer_layoutToasts();

        if (logsviewer_searchRenderTimer) clearTimeout(logsviewer_searchRenderTimer);
        logsviewer_searchRenderTimer = setTimeout(() => {
            const logDisplay = $(logsviewer_dom.logs);
            if (!logsviewer_activeLogContent || !logDisplay.length) {
                logsviewer_updateSearchToast(0);
                return;
            }
            const raw   = logsviewer_activeLogContent;
            const total = logsviewer_activeLogTotalLines;
            logsviewer_renderLog(logDisplay, raw, total);
            const count = logsviewer_countMatches(raw, logsviewer_searchState.term);
            logsviewer_updateSearchToast(count);
            logsviewer_collectSearchHits();
            if (logsviewer_searchState.hits.length > 0) logsviewer_scrollToHit(0);
        }, 200);
    });

    $('#logsviewer-search-input').on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                logsviewer_searchPrev();
            } else {
                logsviewer_searchNext();
            }
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            this.value = '';
            $(this).trigger('input');
        }
    });
}

function logsviewer_highlightLevels(text) {
    let t = String(text || '');
    if (!logsviewer_cfg.highlightEnabled) return t;

    const mode = logsviewer_cfg.highlightMode || 'full';

    t = t.replace(LV_RE_HEADER, '<span class="logsviewer-hdr">$1</span>');

    var re = (mode === 'keywords') ? LV_RE_LEVELS_KEYWORDS : LV_RE_LEVELS_COMBINED;
    re.lastIndex = 0;
    t = t.replace(re, function(m) {
        var cls = LV_LEVEL_CLASS[m.toLowerCase()];
        return cls ? '<span class="' + cls + '">' + m + '</span>' : m;
    });
    return t;
}

function logsviewer_countLines(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!raw.trim()) return 0;

    const endsWithNewline = raw.endsWith('\n');
    const parts = raw.split('\n');
    return endsWithNewline ? (parts.length - 1) : parts.length;
}

var logsviewer_lastTotalLines = -1;

function logsviewer_setTotalLinesValue(n) {
    const out = logsviewer_dom.totalLines;
    if (!out) return;
    var val = Math.max(0, Number(n) || 0);
    out.textContent = String(val);

    if (logsviewer_lastTotalLines >= 0 && val > logsviewer_lastTotalLines) {
        var pulse = logsviewer_dom._pulse || (logsviewer_dom._pulse = document.querySelector('.logsviewer-pulse'));
        if (pulse) {
            pulse.classList.remove('logsviewer-pulse--flash');

            void pulse.offsetWidth;
            pulse.classList.add('logsviewer-pulse--flash');
        }
    }
    logsviewer_lastTotalLines = val;
}

let logsviewer_hljsLoaded = false;
let logsviewer_currentSyntax = 'plaintext';

// highlight.js is loaded on demand, only when a log actually needs it
function logsviewer_loadHighlightJs(callback) {

    if (logsviewer_hljsLoaded || window.hljs) {
        logsviewer_hljsLoaded = true;
        if (callback) callback();
        return;
    }

    if (!document.querySelector('link[data-logsviewer-hljs-css]')) {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';

        cssLink.href = '/plugins/logsviewer/vendor/hljs/' + (logsviewer_isLightTheme() ? 'github' : 'github-dark') + '.min.css';
        cssLink.setAttribute('data-logsviewer-hljs-css', '1');
        document.head.appendChild(cssLink);
    }

    if (document.querySelector('script[data-logsviewer-hljs-js]')) {

        const t0 = Date.now();
        const wait = () => {
            if (window.hljs) {
                logsviewer_hljsLoaded = true;
                if (callback) callback();
            } else if (Date.now() - t0 < 8000) {
                setTimeout(wait, 50);
            }
        };
        wait();
        return;
    }

    const script = document.createElement('script');
    script.src = '/plugins/logsviewer/vendor/hljs/highlight.min.js';
    script.setAttribute('data-logsviewer-hljs-js', '1');
    script.onload = function () {
        logsviewer_hljsLoaded = true;
        if (callback) callback();
    };
    script.onerror = function () {

        logsviewer_hljsLoaded = false;
        if (callback) callback();
    };
    document.head.appendChild(script);
}

let logsviewer_prismLoaded = false;

function logsviewer_loadPrism(callback) {
    if (logsviewer_prismLoaded || window.Prism) {
        logsviewer_prismLoaded = true;
        if (callback) callback();
        return;
    }

    if (!document.querySelector('link[data-logsviewer-prism-css]')) {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = '/plugins/logsviewer/vendor/prism/' + (logsviewer_isLightTheme() ? 'prism' : 'prism-okaidia') + '.css';
        cssLink.setAttribute('data-logsviewer-prism-css', '1');
        document.head.appendChild(cssLink);
    }

    if (document.querySelector('script[data-logsviewer-prism-js]')) {

        const t0 = Date.now();
        const wait = () => {
            if (window.Prism) {
                logsviewer_prismLoaded = true;
                if (callback) callback();
            } else if (Date.now() - t0 < 8000) {
                setTimeout(wait, 50);
            }
        };
        wait();
        return;
    }

    const script = document.createElement('script');
    script.src = '/plugins/logsviewer/vendor/prism/prism.min.js';
    script.setAttribute('data-logsviewer-prism-js', '1');
    script.onload = function () {
        logsviewer_prismLoaded = true;
        if (callback) callback();
    };
    script.onerror = function () {
        logsviewer_prismLoaded = false;
        if (callback) callback();
    };
    document.head.appendChild(script);
}

function logsviewer_getSyntaxSelection() {
    try {
        return localStorage.getItem(logsviewer_storageKey('logsviewer_syntax_v4')) || 'plaintext';
    } catch (e) {
        return 'plaintext';
    }
}

function logsviewer_setSyntaxSelection(syntax) {
    try {
        localStorage.setItem(logsviewer_storageKey('logsviewer_syntax_v4'), syntax);
    } catch (e) {}
}

function logsviewer_applySyntaxHighlightToText(text, syntax) {
    if (!window.hljs || syntax === 'plaintext') {
        return text;
    }

    try {

        var plain = logsviewer_decodeHtmlEntities(text);
        var result = window.hljs.highlight(plain, { language: syntax, ignoreIllegals: true });
        return result.value;
    } catch (e) {
        console.warn('Syntax highlighting failed:', e);
        return text;
    }
}

let logsviewer_entityDecoder = null;
function logsviewer_decodeHtmlEntities(text) {
    if (!logsviewer_entityDecoder) logsviewer_entityDecoder = document.createElement('textarea');
    logsviewer_entityDecoder.innerHTML = String(text || '');
    return logsviewer_entityDecoder.value;
}

const LOGSVIEWER_PRISM_LANG_URLS = {

    'clike': '/plugins/logsviewer/vendor/prism/components/prism-clike.min.js',
    'markup-templating': '/plugins/logsviewer/vendor/prism/components/prism-markup-templating.min.js',

    'bash': '/plugins/logsviewer/vendor/prism/components/prism-bash.min.js',
    'json': '/plugins/logsviewer/vendor/prism/components/prism-json.min.js',
    'yaml': '/plugins/logsviewer/vendor/prism/components/prism-yaml.min.js',
    'php':  '/plugins/logsviewer/vendor/prism/components/prism-php.min.js',
    'nginx': '/plugins/logsviewer/vendor/prism/components/prism-nginx.min.js',
    'docker': '/plugins/logsviewer/vendor/prism/components/prism-docker.min.js',
    'sql': '/plugins/logsviewer/vendor/prism/components/prism-sql.min.js'
};

function logsviewer_prismLanguageDeps(lang) {

    if (lang === 'php') return ['clike', 'markup-templating', 'php'];
    return [lang];
}

function logsviewer_loadScriptOnce(url, dataAttr, callback) {
    if (document.querySelector('script[' + dataAttr + ']')) {
        if (callback) callback();
        return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.setAttribute(dataAttr, '1');
    s.onload = function () { if (callback) callback(); };
    s.onerror = function () { if (callback) callback(); };
    document.head.appendChild(s);
}

// load prism plus whatever grammars the language depends on, once
function logsviewer_ensurePrismLanguage(lang, callback) {
    const cb = callback || function () {};

    if (!lang || lang === 'plaintext') { cb(true); return; }

    logsviewer_loadPrism(function () {
        if (!window.Prism || !Prism.languages) { cb(false); return; }

        if (Prism.languages[lang]) { cb(true); return; }

        const deps = logsviewer_prismLanguageDeps(lang);
        let i = 0;

        const next = function () {
            if (!window.Prism || !Prism.languages) { cb(false); return; }
            if (i >= deps.length) {
                cb(!!Prism.languages[lang]);
                return;
            }
            const dep = deps[i++];

            const alreadyLoaded = (dep === 'markup-templating')
                ? !!window.__lvPrismMarkupTemplating
                : !!Prism.languages[dep];
            if (alreadyLoaded) { next(); return; }

            const url = LOGSVIEWER_PRISM_LANG_URLS[dep];
            if (!url) { next(); return; }

            logsviewer_loadScriptOnce(url, 'data-logsviewer-prism-lang-' + dep, function () {
                if (dep === 'markup-templating') window.__lvPrismMarkupTemplating = true;

                setTimeout(next, 0);
            });
        };

        next();
    });
}

function logsviewer_applyPrismHighlightToText(text, syntax) {
    if (!window.Prism || !Prism.languages || !Prism.languages[syntax] || syntax === 'plaintext') {
        return text;
    }
    try {
        var plain = logsviewer_decodeHtmlEntities(text);
        return Prism.highlight(plain, Prism.languages[syntax], syntax);
    } catch (e) {
        console.warn('Prism highlighting failed:', e);
        return text;
    }
}

function logsviewer_isMobileish() {
    try {
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        const narrow = typeof window.innerWidth === 'number' && window.innerWidth <= 768;

        return Boolean(coarse || narrow);
    } catch (e) {
        return false;
    }
}

// caps on how much text we'll syntax-highlight, lower on mobile and for php (the heavy grammar)
function logsviewer_getPrismBudgets(lang) {
    const mobile = logsviewer_isMobileish();
    const heavy = (String(lang || '').toLowerCase() === 'php');

    let budget = mobile
        ? { maxChars: 40000, maxLines: 400, autoTailLines: 800 }
        : { maxChars: 80000, maxLines: 800, autoTailLines: 800 };

    if (heavy) {
        budget = mobile
            ? { maxChars: 25000, maxLines: 250, autoTailLines: 800 }
            : { maxChars: 50000, maxLines: 500, autoTailLines: 800 };
    }

    return budget;
}

function logsviewer_startPerfFlash(el, flashes){
    try{
        if(!el) return;
        const maxFlashes = Math.max(0, Number(flashes)||0);
        if(maxFlashes === 0) return;

        if(el.dataset.lvFlashing === '1') return;

        el.dataset.lvFlashing = '1';
        el.dataset.lvFlashDone = '0';

        if(el.__lvFlashInterval) clearInterval(el.__lvFlashInterval);

        let count = 0;
        const runOnce = () => {
            el.classList.remove('logsviewer-toast-flash');
            void el.offsetWidth;
            el.classList.add('logsviewer-toast-flash');
        };

        runOnce();
        count++;

        el.__lvFlashInterval = setInterval(() => {
            if(count >= maxFlashes){
                clearInterval(el.__lvFlashInterval);
                el.__lvFlashInterval = null;
                el.classList.remove('logsviewer-toast-flash');
                el.dataset.lvFlashing = '0';
                el.dataset.lvFlashDone = '1';
                return;
            }
            runOnce();
            count++;
        }, 2600);
    }catch(_){}
}

let logsviewer_lastPerfMessage = null;
let logsviewer_perfToastDismissed = false;

function logsviewer_showPerfToast(message){
  try{
    const line = $(logsviewer_dom.toastLine);
    if(!line.length) return;

    let el = document.getElementById('logsviewer-perf-toast');
    if(!el){
      el = document.createElement('div');
      el.id = 'logsviewer-perf-toast';
      el.className = 'logsviewer-perf-toast';
      el.style.display = 'none';
      line.append(el);
    }

    if(!message){
      el.textContent = '';
      el.style.display = 'none';
      logsviewer_lastPerfMessage = null;
      if (logsviewer_perfToastTimer) { clearTimeout(logsviewer_perfToastTimer); logsviewer_perfToastTimer = null; }
      return;
    }

    if (logsviewer_perfToastDismissed && message === logsviewer_lastPerfMessage) {
      logsviewer_perfToastSetThisRender = true;
      return;
    }

    if (message === logsviewer_lastPerfMessage && logsviewer_perfToastTimer) {
      logsviewer_perfToastSetThisRender = true;
      return;
    }
    logsviewer_lastPerfMessage = message;
    logsviewer_perfToastSetThisRender = true;
    logsviewer_perfToastDismissed = false;

    el.textContent = message;
    el.style.display = '';

    if (logsviewer_searchTyping) {
        el.dataset.lvSuppressedBySearch = '1';
        el.style.display = 'none';
        return;
    }

    if (el.dataset.lvFlashDone !== '1' && el.dataset.lvFlashing !== '1') {
        logsviewer_startPerfFlash(el, 2);
    }

    if (logsviewer_perfToastTimer) { clearTimeout(logsviewer_perfToastTimer); }
    logsviewer_perfToastTimer = setTimeout(function() {
        logsviewer_perfToastTimer = null;
        logsviewer_perfToastDismissed = true;
        el.textContent = '';
        el.style.display = 'none';
        el.dataset.lvFlashDone = '0';
        logsviewer_layoutToasts();
    }, 6000);

    logsviewer_layoutToasts();
  }catch(_){}
}
function logsviewer_setupSyntaxDropdown() {
    var dropdown = $('#logsviewer-syntax-select');
    if (!dropdown.length) return;

    var savedSyntax = logsviewer_getSyntaxSelection();
    logsviewer_currentSyntax = savedSyntax;
    dropdown.val(savedSyntax);

    dropdown.off('change.lvsyntax');

    dropdown.on('change.lvsyntax', function() {
        var newSyntax = String(this.value || 'plaintext');
        logsviewer_currentSyntax = newSyntax;
        logsviewer_setSyntaxSelection(newSyntax);

        logsviewer_lastRenderKey = '';

        var cat = logsviewer_activeCategory;
        var src = logsviewer_getActiveSource();
        if (cat && src) {
            var entry = logsviewer_findLogData(cat, src);
            if (entry) {
                logsviewer_showLog(entry);
                return;
            }
        }

        var logDisplay = $(logsviewer_dom.logs);
        if (logsviewer_activeLogContent && logDisplay.length) {
            logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
        }
    });

    if (savedSyntax !== 'plaintext' && logsviewer_activeLogContent) {
        logsviewer_lastRenderKey = '';
        var cat = logsviewer_activeCategory;
        var src = logsviewer_getActiveSource();
        if (cat && src) {
            var entry = logsviewer_findLogData(cat, src);
            if (entry) logsviewer_showLog(entry);
        }
    }
}

function logsviewer_quickHash(str) {
    var s = String(str || ''), len = s.length, h = 0;
    if (len === 0) return '0|0';
    for (var i = 0; i < Math.min(256, len); i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    if (len > 512) {
        var mid = (len >>> 1);
        for (var i = mid; i < Math.min(mid + 256, len); i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
    }
    for (var i = Math.max(0, len - 256); i < len; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return len + '|' + h;
}

const LV_RE_SANITIZE_TAGS = /<\/?(?!span[\s>\/])[a-zA-Z][^>]*>/g;
const LV_RE_SANITIZE_SPAN = /<span\s+([^>]*)>/gi;
const LV_RE_SANITIZE_CLASS_DQ = /class\s*=\s*"([^"]*)"/i;
const LV_RE_SANITIZE_CLASS_SQ = /class\s*=\s*'([^']*)'/i;
const LV_RE_SANITIZE_CLASSVAL = /[^a-zA-Z0-9\s_-]/g;

function logsviewer_sanitizeHTML(html) {

    LV_RE_SANITIZE_TAGS.lastIndex = 0;
    html = html.replace(LV_RE_SANITIZE_TAGS, function(tag) {
        return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    });

    LV_RE_SANITIZE_SPAN.lastIndex = 0;
    html = html.replace(LV_RE_SANITIZE_SPAN, function(match, attrs) {
        var classMatch = attrs.match(LV_RE_SANITIZE_CLASS_DQ) || attrs.match(LV_RE_SANITIZE_CLASS_SQ);
        if (classMatch) {
            var safeClass = classMatch[1].replace(LV_RE_SANITIZE_CLASSVAL, '');
            return '<span class="' + safeClass + '">';
        }
        return '<span>';
    });

    html = html.replace(/&lt;/g, '&amp;lt;').replace(/&gt;/g, '&amp;gt;');

    return html;
}

function logsviewer_renderLog(logDisplay, rawText, totalLinesFromApi) {
    const filter = logsviewer_getFilterValue();
    const searchTerm = String(logsviewer_searchState.term || '').trim();

    var renderKey = logsviewer_quickHash(rawText) + '|' + filter + '|' + logsviewer_currentSyntax + '|' + searchTerm;
    if (renderKey === logsviewer_lastRenderKey) {
        return;
    }
    logsviewer_lastRenderKey = renderKey;

    logsviewer_perfToastSetThisRender = false;

    let base = logsviewer_tailText(rawText || '', logsviewer_cfg.tailLines || 0);

    base = base.replace(/^([A-Z][a-z]{2})  (\d )/gm, '$1 $2');

    let filtered = logsviewer_applyFilterToText(base);

    if (filter !== 'none' && String(filtered).trim() === '') {
        const label = logsviewer_getFilterLabel(filter);
        filtered = `[info] No matching lines for '${label}' filter.`;
    }

    if (logsviewer_cfg.showTotalLines) {
        if (filter === 'none' && Number.isFinite(Number(totalLinesFromApi)) && (!logsviewer_cfg.tailLines || logsviewer_cfg.tailLines <= 0)) {
            logsviewer_setTotalLinesValue(Number(totalLinesFromApi));
        } else {
            logsviewer_setTotalLinesValue(logsviewer_countLines(filtered));
        }
        $('.logsviewer-title-meta').show();
    } else {
        $('.logsviewer-title-meta').hide();
    }

if (logsviewer_cfg.syntaxEnabled && logsviewer_currentSyntax !== 'plaintext') {
    const engine = String(logsviewer_cfg.syntaxEngine || 'hljs');

    if (engine === 'prism') {

        const budget = logsviewer_getPrismBudgets(logsviewer_currentSyntax);
        const lineCount = logsviewer_countLines(filtered);
        const charCount = (filtered || '').length;
        const userTailLines = Number(logsviewer_cfg.tailLines) || 0;
        const tooBigByChars = (userTailLines <= 0) && (charCount > budget.maxChars);
        const tooBigByLines = (lineCount > budget.maxLines);
	    const tooBig = tooBigByLines || tooBigByChars;

	    const showPerfToastAllowed = tooBigByLines;

	    let prismCanHighlight = true;

        if (tooBig) {

            const tailN = Number(budget.autoTailLines) || 0;

            if (tailN > 0 && tooBigByLines && (lineCount > tailN)) {
                filtered = logsviewer_tailText(filtered, tailN);
                if (showPerfToastAllowed) logsviewer_showPerfToast(`Large log • Syntax: last ${tailN}`);
            } else if (tooBigByChars) {

                const avgCharsPerLine = Math.max(1, Math.ceil(charCount / Math.max(1, lineCount)));
                let maxSafeLines = Math.floor(budget.maxChars / avgCharsPerLine);

                maxSafeLines = Math.max(50, maxSafeLines);

                if (lineCount > maxSafeLines) {
                    filtered = logsviewer_tailText(filtered, maxSafeLines);
                    if (showPerfToastAllowed) logsviewer_showPerfToast(`Large log • Syntax: last ${maxSafeLines}`);
                } else {

                    if (showPerfToastAllowed) logsviewer_showPerfToast('Syntax disabled for performance');
	                    prismCanHighlight = false;
                }
            } else {

                logsviewer_showPerfToast(null);
            }
        } else {
            logsviewer_showPerfToast(null);
        }

	        const trimmedByCharsPath = tooBigByChars && prismCanHighlight && (lineCount > 0) && ((filtered || '').length <= budget.maxChars);
	        if (prismCanHighlight && (!tooBig || tooBigByLines || trimmedByCharsPath)) {

            if (!window.Prism || !Prism.languages || !Prism.languages[logsviewer_currentSyntax]) {
                logsviewer_ensurePrismLanguage(logsviewer_currentSyntax, function () {

                    logsviewer_lastRenderKey = '';
                    const logDisplay = $(logsviewer_dom.logs);
                    if (logsviewer_activeLogContent && logDisplay.length) {
                        logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
                    }
                });
            } else {
                filtered = logsviewer_applyPrismHighlightToText(filtered, logsviewer_currentSyntax);
            }
        }
    } else {

        const hljsLineCount = logsviewer_countLines(filtered);
        const hljsMaxLines  = 800;

        if (hljsLineCount > hljsMaxLines) {

            filtered = logsviewer_tailText(filtered, hljsMaxLines);
            logsviewer_showPerfToast(`Large log • Syntax: last ${hljsMaxLines}`);
        }

        if (window.hljs) {
            filtered = logsviewer_applySyntaxHighlightToText(filtered, logsviewer_currentSyntax);
        }
    }
}

    var badgeCounts = logsviewer_countLevels(filtered);
    logsviewer_lastBadgeCounts = badgeCounts;

    filtered = logsviewer_highlightLevels(filtered);

    filtered = logsviewer_applySearchHighlight(filtered);

    if (!logsviewer_perfToastSetThisRender) {
        logsviewer_showPerfToast(null);
    }

    requestAnimationFrame(function() {
        const el = logDisplay[0];
        if (!el) return;

        filtered = logsviewer_sanitizeHTML(filtered);

        el.innerHTML = filtered;

        if (logsviewer_cfg.syntaxEnabled && window.hljs && logsviewer_currentSyntax !== 'plaintext') {
            logDisplay.addClass('hljs');
        } else {
            logDisplay.removeClass('hljs');
        }

        if (logsviewer_cfg.showBadges && badgeCounts) {
            logsviewer_updateBadges(badgeCounts);
            $('.logsviewer-badges').show();
        } else {
            $('.logsviewer-badges').hide();
        }

        if (logsviewer_cfg.searchEnabled) {
            logsviewer_collectSearchHits();
        }
    });
}

function logsviewer_applyAutoscrollUiState(isOn) {
    const title = $('.logsviewer-autoscroll-title');
    if (!title.length) return;

    const stateClass = isOn ? 'logsviewer-autoscroll-state--on' : 'logsviewer-autoscroll-state--off';
    const stateText  = isOn ? 'On' : 'Off';

    title.html(`Autoscroll <span class="logsviewer-autoscroll-state ${stateClass}">${stateText}</span>`);
}

function logsviewer_getSelectedScriptName() {
    var source = logsviewer_getActiveSource();
    return source ? String(source).trim() : 'log';
}

function logsviewer_sanitizeFilename(name) {
    return String(name || 'log')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[\/\\?%*:|"<>]/g, '-')

        .slice(0, 80) || 'log';
}

function logsviewer_downloadTextFile(text, filename, mime) {
    const blob = new Blob([String(text || '')], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function logsviewer_exportCurrentLog() {
    if (!logsviewer_activeLogContent) return;

    const scriptName = logsviewer_getSelectedScriptName();
    const text = String(logsviewer_activeLogContent || '');
    if (!text.trim()) return;

    const fmt = (logsviewer_cfg.exportFormat || 'log').toLowerCase();
    const includeStamp = !!logsviewer_cfg.exportIncludeTimestamp;

    let stamp = '';
    if (includeStamp) {
        const d = new Date();
        stamp =
            '_' + d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + '_' +
            String(d.getHours()).padStart(2, '0') + '-' +
            String(d.getMinutes()).padStart(2, '0') + '-' +
            String(d.getSeconds()).padStart(2, '0');
    }

    const base = logsviewer_sanitizeFilename(scriptName) + stamp;

    if (fmt === 'json') {

        const reSyslog = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s*(.*)$/;

        const reIso    = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/;

        const levelMap = [
            [/\bemergency\b/i, 'emergency'],
            [/\bpanic\b/i,     'emergency'],
            [/\bcritical\b/i,  'critical'],
            [/\bfatal\b/i,     'critical'],
            [/\balert\b/i,     'alert'],
            [/\berror\b/i,     'error'],
            [/\bwarning\b/i,   'warning'],
            [/\bwarn\b/i,      'warning'],
            [/\bnotice\b/i,    'notice'],
            [/\binfo\b/i,      'info'],
            [/\bdebug\b/i,     'debug'],
            [/\btrace\b/i,     'trace'],
        ];

        function detectLevel(msg) {
            for (const [re, lvl] of levelMap) {
                if (re.test(msg)) return lvl;
            }
            return 'info';
        }

        const lines = text.split('\n');
        const entries = [];
        for (const raw of lines) {
            const line = raw.trimEnd();
            if (!line) continue;

            let timestamp = null, hostname = null, service = null, message = line;

            const mSys = line.match(reSyslog);
            if (mSys) {
                timestamp = mSys[1].replace(/\s+/, ' ');
                hostname  = mSys[2];
                service   = mSys[3].trim();
                message   = mSys[4];
            } else {
                const mIso = line.match(reIso);
                if (mIso) {
                    timestamp = mIso[1];
                    message   = mIso[2];
                }
            }

            const entry = { timestamp, level: detectLevel(message), message };
            if (hostname) entry.hostname = hostname;
            if (service)  entry.service  = service;
            entries.push(entry);
        }

        const payload = {
            source:      scriptName,
            exported_at: new Date().toISOString(),
            total_lines: entries.length,
            entries
        };
        logsviewer_downloadTextFile(JSON.stringify(payload, null, 2), `${base}.json`, 'application/json;charset=utf-8');
        return;
    }

    const ext = (fmt === 'txt') ? 'txt' : 'log';
    logsviewer_downloadTextFile(text, `${base}.${ext}`, 'text/plain;charset=utf-8');
}

function logsviewer_applyThemePreset(target, preset) {

    const p = String(preset || 'default').toLowerCase();
    if (!target) return;

    if (p === 'default') {
        target.style.removeProperty('--logsviewer-log-bg');
        target.style.removeProperty('--logsviewer-border');
        target.style.removeProperty('--logsviewer-tab-border');
        target.style.removeProperty('--logsviewer-tab-hover-border');
        target.style.removeProperty('--logsviewer-text-primary');
        target.style.removeProperty('--logsviewer-text-secondary');
        target.style.removeProperty('--logsviewer-text-muted');
        return;
    }

    const set = (k, v) => target.style.setProperty(k, v);

    const _light = logsviewer_isLightTheme();
    if (p === 'terminal') {
        set('--logsviewer-log-bg',           _light ? '#f0f4f8' : '#12161c');
        set('--logsviewer-border',           _light ? '#b8c9dc' : '#2c3a52');
        set('--logsviewer-tab-border',       _light ? '#b8c9dc' : '#2c3a52');
        set('--logsviewer-tab-hover-border', _light ? '#8fa4bd' : '#3b4d6c');
        set('--logsviewer-text-primary',     _light ? '#1a2a3a' : '#e6edf6');
        set('--logsviewer-text-secondary',   _light ? '#3d5066' : '#b7c3d6');
        set('--logsviewer-text-muted',       _light ? '#7a8ea2' : '#7e8aa2');
    } else if (p === 'dim') {
        set('--logsviewer-log-bg',           _light ? '#f5f5f5' : '#171717');
        set('--logsviewer-border',           _light ? '#ccc'    : '#3a3a3a');
        set('--logsviewer-tab-border',       _light ? '#c0c0c0' : '#343434');
        set('--logsviewer-tab-hover-border', _light ? '#aaa'    : '#4a4a4a');
        set('--logsviewer-text-primary',     _light ? '#2a2a2a' : '#d7d7d7');
        set('--logsviewer-text-secondary',   _light ? '#555'    : '#bdbdbd');
        set('--logsviewer-text-muted',       _light ? '#888'    : '#8d8d8d');
    } else if (p === 'contrast') {
        set('--logsviewer-log-bg',           _light ? '#ffffff' : '#0f0f0f');
        set('--logsviewer-border',           _light ? '#999'    : '#5a5a5a');
        set('--logsviewer-tab-border',       _light ? '#aaa'    : '#4a4a4a');
        set('--logsviewer-tab-hover-border', _light ? '#777'    : '#6a6a6a');
        set('--logsviewer-text-primary',     _light ? '#000000' : '#ffffff');
        set('--logsviewer-text-secondary',   _light ? '#222'    : '#e0e0e0');
        set('--logsviewer-text-muted',       _light ? '#555'    : '#b0b0b0');
    } else if (p === 'midnight') {
        set('--logsviewer-log-bg',           _light ? '#eef0f7' : '#0e1225');
        set('--logsviewer-border',           _light ? '#b0b8d4' : '#1e2a4a');
        set('--logsviewer-tab-border',       _light ? '#b0b8d4' : '#1e2a4a');
        set('--logsviewer-tab-hover-border', _light ? '#8890b0' : '#2e3d6a');
        set('--logsviewer-text-primary',     _light ? '#1a1e3a' : '#c8cde8');
        set('--logsviewer-text-secondary',   _light ? '#3a4070' : '#8b92c0');
        set('--logsviewer-text-muted',       _light ? '#6a6e96' : '#5c6290');
    } else if (p === 'ocean') {
        set('--logsviewer-log-bg',           _light ? '#ecf5f5' : '#0c1a1e');
        set('--logsviewer-border',           _light ? '#a0c8c8' : '#1a3a3f');
        set('--logsviewer-tab-border',       _light ? '#a0c8c8' : '#1a3a3f');
        set('--logsviewer-tab-hover-border', _light ? '#78aaaa' : '#285558');
        set('--logsviewer-text-primary',     _light ? '#122a2e' : '#c4dfe2');
        set('--logsviewer-text-secondary',   _light ? '#2e5458' : '#7eb8be');
        set('--logsviewer-text-muted',       _light ? '#5d8488' : '#4e8a90');
    } else if (p === 'monokai') {
        set('--logsviewer-log-bg',           _light ? '#f7f3ee' : '#1c1810');
        set('--logsviewer-border',           _light ? '#d4c8b0' : '#3a3020');
        set('--logsviewer-tab-border',       _light ? '#d4c8b0' : '#3a3020');
        set('--logsviewer-tab-hover-border', _light ? '#b8a880' : '#544430');
        set('--logsviewer-text-primary',     _light ? '#2e2816' : '#e8dcc8');
        set('--logsviewer-text-secondary',   _light ? '#5a4e30' : '#b8a880');
        set('--logsviewer-text-muted',       _light ? '#8a7e60' : '#7a6e50');
    }
}

function logsviewer_applyFontFamily(root, familyKey) {
    const k = String(familyKey || 'system').toLowerCase();
    if (!root) return;

    const map = {
        system: {
            family: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
            ligatures: 'none',
            letterSpacing: '0',
            weight: '400',
        },
        monospace: {
            family: 'monospace',
            ligatures: 'none',
            letterSpacing: '0',
            weight: '400',
        },
        jetbrains: {
            family: '"JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ligatures: 'none',
            letterSpacing: '0.01em',
            weight: '500',
        },
        fira: {
            family: '"Fira Code", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ligatures: 'contextual',
            letterSpacing: '0',
            weight: '400',
        },
        sourcecodepro: {
            family: '"Source Code Pro", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ligatures: 'none',
            letterSpacing: '0.02em',
            weight: '350',
        },
        ibmplex: {
            family: '"IBM Plex Mono", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ligatures: 'none',
            letterSpacing: '0.015em',
            weight: '450',
        },
    };

    const cfg = map[k] || map.system;

    root.style.setProperty('--logsviewer-font-family', cfg.family);
    root.style.setProperty('--logsviewer-font-ligatures', cfg.ligatures);
    root.style.setProperty('--logsviewer-font-letter-spacing', cfg.letterSpacing);
    root.style.setProperty('--logsviewer-font-weight', cfg.weight || '400');
}

function logsviewer_applyConfig() {

    const logPanel = document.querySelector('#logsviewer-container');
    if (!logPanel) return;

    document.querySelectorAll('.logsviewer-body').forEach((el) => {
        el.style.removeProperty('--logsviewer-bg');
        el.style.removeProperty('--logsviewer-tab-bg');
        el.style.removeProperty('--logsviewer-tab-border');
        el.style.removeProperty('--logsviewer-tab-hover-border');
        el.style.removeProperty('--logsviewer-border');
        el.style.removeProperty('--logsviewer-text-primary');
        el.style.removeProperty('--logsviewer-text-secondary');
        el.style.removeProperty('--logsviewer-text-muted');
        el.style.removeProperty('--logsviewer-log-bg');
    });

    logsviewer_applyThemePreset(logPanel, logsviewer_cfg.themePreset);

    const preset = String(logsviewer_cfg.themePreset || 'default');
    const bgColor = String(logsviewer_cfg.bgColor || '').trim();
    if (preset === 'default') {

        logPanel.style.setProperty('--logsviewer-log-bg', bgColor || (logsviewer_isLightTheme() ? '#ffffff' : '#1b1b1b'));
    }

    if (!logsviewer_isLightTheme() && preset === 'default' && bgColor) {
        var _toastEl = document.querySelector('.logsviewer-toast-panel');
        if (_toastEl) _toastEl.style.background = bgColor;
    }

    document.documentElement.style.removeProperty('--logsviewer-log-bg');

    logsviewer_applyFontFamily(logPanel, logsviewer_cfg.fontFamily);
    const preElement = document.getElementById('logsviewer-logs');
    if (preElement) {
        logsviewer_applyFontFamily(preElement, logsviewer_cfg.fontFamily);
    }

    if (logsviewer_cfg.wrapLines) {
        logPanel.style.setProperty('--logsviewer-white-space', 'pre-wrap');
        $(logsviewer_dom.container).removeClass('logsviewer-nowarp');
    } else {
        logPanel.style.setProperty('--logsviewer-white-space', 'pre');
        $(logsviewer_dom.container).addClass('logsviewer-nowarp');
    }

    $('.logsviewer-badges')[logsviewer_cfg.showBadges ? 'show' : 'hide']();
    $('.logsviewer-title-meta')[logsviewer_cfg.showTotalLines ? 'show' : 'hide']();
    $('.logsviewer-timestamp-container')[logsviewer_cfg.showTimestamp ? 'show' : 'hide']();
    $('.logsviewer-filter')[logsviewer_cfg.showFilter ? 'show' : 'hide']();

    logsviewer_ensureSearchUi();

    logsviewer_restoreLoginToast();

    if (logsviewer_cfg.syntaxEnabled) {
        $('.logsviewer-syntax').show();
        logsviewer_loadHighlightJs(function() {
            logsviewer_setupSyntaxDropdown();
        });
    } else {
        $('.logsviewer-syntax').hide();
    }
}

let logsviewer_manualRefreshInProgress = false;

function logsviewer_manualRefresh() {
    if (logsviewer_manualRefreshInProgress) return;

    var refreshLink = $('#logsviewer-manual-refresh');
    if (!refreshLink.length) return;

    logsviewer_manualRefreshInProgress = true;
    var icon = refreshLink.find('i.fa-refresh');
    icon.removeClass('fa-refresh').addClass('fa-hourglass');
    refreshLink.addClass('disabled');

    var config = logsviewer_cfg || {};
    var logContainer = $(logsviewer_dom.container);
    var scrollTarget = logContainer.length ? logContainer.get(0) : null;

    logsviewer_fetchCategory(logsviewer_activeCategory, function() {

        var autoscrollNow = $(logsviewer_dom.autoscroll).prop('checked');
        var allowNow = autoscrollNow && !(config.pauseOnHover && logsviewer_pauseHoverActive);
        if (allowNow && scrollTarget) {
            requestAnimationFrame(function(){
            scrollTarget.scrollTop = scrollTarget.scrollHeight;
            });
        }

        logsviewer_manualRefreshInProgress = false;
        var iconBack = refreshLink.find('i.fa-hourglass');
        iconBack.removeClass('fa-hourglass').addClass('fa-refresh');
        refreshLink.removeClass('disabled');
    }, { skipHash: true, source: logsviewer_getActiveSource() || null });
}

function logsviewer_status() {
    var config = logsviewer_cfg || {};

    var logContainer = $(logsviewer_dom.container);
    var scrollTarget = logContainer.length ? logContainer.get(0) : null;
    var autoscrollEnabled = $(logsviewer_dom.autoscroll).prop('checked');
    var allowAutoscroll = autoscrollEnabled && !(config.pauseOnHover && logsviewer_pauseHoverActive);

    logsviewer_fetchCategory(logsviewer_activeCategory, function(scripts) {

        if (allowAutoscroll && scrollTarget) {
            requestAnimationFrame(function() {
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
            });
        }
    }, { source: logsviewer_getActiveSource() || null });

    try{
        if (logsviewer_activeCategory === 'system') {

            var sys = logsviewer_findLogData('system', 'syslog');
            if (sys && typeof sys.log === 'string' && sys.log.length) {
                logsviewer_checkLoginToast(sys.log);
            }
        } else {
            logsviewer_systemFetchCounter++;
            if (logsviewer_systemFetchCounter >= 3) {
                logsviewer_systemFetchCounter = 0;
                logsviewer_fetchCategory('system', function(sysScripts){
                    if (!Array.isArray(sysScripts) || !sysScripts.length) return;
                    var sys = logsviewer_findLogData('system', 'syslog');
                    if (sys && typeof sys.log === 'string' && sys.log.length) {
                        logsviewer_checkLoginToast(sys.log);
                    }
                }, { autoShow: false, source: 'syslog' });
            }
        }
    }catch(_){ }
}

$(function() {
    logsviewer_cfg = window.logsviewerConfig || {};
    const config = logsviewer_cfg;

    const widgetRoot = $('.logsviewer-body');
    if (widgetRoot.length) {
        widgetRoot.toggleClass('logsviewer-body--responsive', !!config.isResponsive);
        widgetRoot.toggleClass('logsviewer-body--legacy', !config.isResponsive);
    }

    logsviewer_detectTheme();

    logsviewer_applyConfig();

    if (config.fontSize) {
        const logContainer = $(logsviewer_dom.container);
        const logPre = $(logsviewer_dom.logs);
        if (logContainer.length) logContainer.css('font-size', config.fontSize);
        if (logPre.length) logPre.css('font-size', config.fontSize);
    }

    if (config.pauseOnHover) {
        $(document).on('mouseenter', '#logsviewer-container', function(){
            logsviewer_pauseHoverActive = true;
            var right = logsviewer_dom.toastRight;
            if (right && config.pauseOnHover) {
                var existing = right.querySelector('.lv-toast-paused');
                if (!existing) {
                    var sep = right.children.length ? '<span class="lv-toast-sep"></span>' : '';
                    right.insertAdjacentHTML('afterbegin', '<span class="lv-toast-paused">Paused</span>' + sep);
                }
            }
        });
        $(document).on('mouseleave', '#logsviewer-container', function(){
            logsviewer_pauseHoverActive = false;
            var right = logsviewer_dom.toastRight;
            if (right) {
                var paused = right.querySelector('.lv-toast-paused');
                if (paused) {
                    var nextSep = paused.nextElementSibling;
                    if (nextSep && nextSep.classList.contains('lv-toast-sep')) nextSep.remove();
                    paused.remove();
                }
            }
        });
    }

    const compactWrapper = $('#logsviewer-compact-wrapper');
    const collapsibleRow = $('.dash_logsviewer_toggle');

    if (compactWrapper.length && collapsibleRow.length) {
        function updateCompactVisibility() {
            const isHidden = collapsibleRow.css('display') === 'none';
            compactWrapper.css('display', isHidden ? 'flex' : 'none');
        }

        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
                    updateCompactVisibility();
                }
            });
        });

        observer.observe(collapsibleRow[0], {
            attributes: true,
            attributeFilter: ['style', 'class']
        });

        updateCompactVisibility();

        if (window.__logsviewerCompactInterval) { clearInterval(window.__logsviewerCompactInterval); window.__logsviewerCompactInterval = null; }
    }

    $(document).on('click', '.logsviewer-badge', function() {
        const filter = $(this).attr('data-filter');
        if (!filter) return;
        logsviewer_setFilterValue(filter);
        logsviewer_syncBadgeSelection(filter);
    });

    $(document).on('keydown', '.logsviewer-badge', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    $(document).on('change', '#logsviewer-filter-select', function() {
        var filterVal = $(this).val() || 'none';
        logsviewer_syncBadgeSelection(filterVal);
        var logDisplay = $(logsviewer_dom.logs);
        if (!logsviewer_activeLogContent || !logDisplay.length) return;
        logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
    });

    $(document).on('change', '#logsviewer-autoscroll', function() {
        const isOn = !!this.checked;
        logsviewer_applyAutoscrollUiState(isOn);

        try { localStorage.setItem(logsviewer_storageKey('logsviewer_autoscroll'), isOn ? '1' : '0'); } catch (_) {}

        if (!isOn) return;

        const logContainer = $(logsviewer_dom.container);
        const scrollTarget = logContainer.length ? logContainer.get(0) : null;
        if (scrollTarget && !(config.pauseOnHover && logsviewer_pauseHoverActive)) {
            requestAnimationFrame(function() {
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
            });
        }
    });

    $(document).on('click', '#logsviewer-export-icon, [data-action="export-log"]', function(e) {
        e.preventDefault();
        logsviewer_exportCurrentLog();
    });

    $(document).on('click', '#logsviewer-manual-refresh', function(e) {
        e.preventDefault();
        logsviewer_manualRefresh();
    });

    (function initAutoscrollState(){
        const cb = $(logsviewer_dom.autoscroll);
        if (!cb.length) return;

        let saved = null;
        try { saved = localStorage.getItem(logsviewer_storageKey('logsviewer_autoscroll')); } catch (_) {}

        const isOn = (saved === null) ? !!config.autoscrollDefault : (saved === '1');
        cb.prop('checked', isOn);
        logsviewer_applyAutoscrollUiState(isOn);
    })();

    (function initResizeMemory(){
        const container = document.getElementById('logsviewer-container');
        if (!container) return;

        const ctx = (logsviewer_cfg && logsviewer_cfg.apiContext) ||
                    (window.location.pathname.indexOf('Tool') !== -1 ? 'tool' : 'dashboard');
        const storageKey = 'logsviewer_panel_height_' + ctx;

        const defaultHeight = (ctx === 'tool')
            ? (logsviewer_isMobileish() ? 200 : 400)
            : 300;

        var resetFlagKey = 'logsviewer_panel_height_reset_' + (ctx === 'tool' ? 'tool' : 'dash');
        try {
            if (localStorage.getItem(resetFlagKey) === '1') {
                localStorage.removeItem(resetFlagKey);
                localStorage.removeItem(storageKey);
            }

            if (localStorage.getItem('logsviewer_panel_height_reset') === '1') {
                localStorage.removeItem('logsviewer_panel_height_reset');
                localStorage.removeItem(storageKey);
            }
        } catch(_) {}

        try {
            const saved = parseInt(localStorage.getItem(storageKey), 10);
            if (saved === 600) localStorage.removeItem(storageKey);
        } catch(_) {}

        try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const h = parseInt(saved, 10);
                if (h >= 100 && h <= 2000) container.style.height = h + 'px';
            } else {
                container.style.height = defaultHeight + 'px';
            }
        } catch(_) {
            container.style.height = defaultHeight + 'px';
        }

        let saveTimeout = null;
        let resizeEnabled = true;
        const observer = new ResizeObserver(function(entries) {
            if (!resizeEnabled) return;
            for (const entry of entries) {
                const h = Math.round(entry.contentRect.height);
                if (h >= 200) {
                    clearTimeout(saveTimeout);
                    saveTimeout = setTimeout(function() {
                        try { localStorage.setItem(storageKey, String(h)); } catch(_) {}
                    }, 300);
                }
            }
        });
        observer.observe(container);

        window.logsviewer_resetPanelHeight = function(context) {
            try {

                localStorage.removeItem(storageKey);
                var flagKey = 'logsviewer_panel_height_reset_' + (ctx === 'tool' ? 'tool' : 'dash');
                localStorage.setItem(flagKey, '1');
            } catch(_) {}

            resizeEnabled = false;
            clearTimeout(saveTimeout);
            const resetDefault = (ctx === 'tool') ? (logsviewer_isMobileish() ? 200 : 400) : 300;
            container.style.height = resetDefault + 'px';
            setTimeout(function() { resizeEnabled = true; }, 400);
        };
    })();

(function initCategoryTabs() {

    function isMobile() {
        return typeof logsviewer_isMobileish === 'function'
            ? logsviewer_isMobileish()
            : window.matchMedia('(max-width:768px)').matches;
    }

    function closeAllCatDropdowns() {
        $('.logsviewer-cat-dropdown').removeClass('logsviewer-cat-dropdown--open');
    }

    function toggleCatDropdown($tabBtn) {
        var $drop = $tabBtn.find('.logsviewer-cat-dropdown');
        if (!$drop.length) return;
        var isOpen = $drop.hasClass('logsviewer-cat-dropdown--open');
        closeAllCatDropdowns();
        if (!isOpen) {
            $drop.addClass('logsviewer-cat-dropdown--open');
        }
    }

    function loadSource(cat, sourceName) {
        logsviewer_activeCategory = cat;
        $('.logsviewer-cat-btn').removeClass('logsviewer-cat-btn--active');
        var $tabBtn = $('.logsviewer-cat-btn[data-category="' + cat + '"]');
        $tabBtn.attr('data-selected', sourceName).addClass('logsviewer-cat-btn--active');

        logsviewer_markActiveItem(cat, sourceName);

        (function(c, sn) {
            setTimeout(function() {
                $('.logsviewer-cat-native').each(function() {
                    var thisCat = $(this).closest('.logsviewer-cat-btn').attr('data-category');
                    try { this.value = (thisCat === c) ? sn : ''; } catch(_) {}
                });
            }, 50);
        })(cat, sourceName);

        var entry = logsviewer_findLogData(cat, sourceName);
        if (entry) logsviewer_showLog(entry);

        logsviewer_fetchCategory(cat);
    }

    $(document).off('click.lvcattab', '.logsviewer-cat-btn');
    $(document).on('click.lvcattab', '.logsviewer-cat-btn', function(e) {
        if ($(e.target).closest('.logsviewer-cat-dropdown').length) return;
        if ($(e.target).is('select, option')) return;
        if (isMobile()) return;
        e.stopPropagation();
        toggleCatDropdown($(this));
    });

    $(document).off('click.lvcatitem', '.logsviewer-cat-dropdown li');
    $(document).on('click.lvcatitem', '.logsviewer-cat-dropdown li', function(e) {
        e.stopPropagation();
        var sourceName = $(this).attr('data-value');
        var $tabBtn    = $(this).closest('.logsviewer-cat-btn');
        var cat        = $tabBtn.attr('data-category');
        if (!cat || !sourceName) return;
        closeAllCatDropdowns();
        loadSource(cat, sourceName);
    });

    $(document).off('change.lvcatnative', '.logsviewer-cat-native');
    $(document).on('change.lvcatnative', '.logsviewer-cat-native', function(e) {
        var sourceName = this.value;
        if (!sourceName) return;
        var $tabBtn = $(this).closest('.logsviewer-cat-btn');
        var cat     = $tabBtn.attr('data-category');
        if (!cat) return;
        loadSource(cat, sourceName);

    });

    $(document).off('click.lvcatoutside');
    $(document).on('click.lvcatoutside', function(e) {
        if (!$(e.target).closest('.logsviewer-cat-btn').length) {
            closeAllCatDropdowns();
        }
    });

})();

    logsviewer_fetchCategory('system', function() {

        var autoscrollNow = $(logsviewer_dom.autoscroll).prop('checked');
        if (autoscrollNow) {
            var logContainer = $(logsviewer_dom.container);
            var scrollTarget = logContainer.length ? logContainer.get(0) : null;
            if (scrollTarget) {
                requestAnimationFrame(function(){
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
                });
            }
        }
    });

    if (config.enabledDockerContainers && config.enabledDockerContainers.length > 0) {
        logsviewer_fetchCategory('docker');
    }
    if (config.enabledVms && config.enabledVms.length > 0) {
        logsviewer_fetchCategory('vm');
    }
    if (config.enabledCustomLogs && config.enabledCustomLogs.length > 0) {
        logsviewer_fetchCategory('custom');
    }

    if (config.refreshEnabled && config.refreshInterval > 0) {
        if (window.__logsviewerStatusInterval) { clearInterval(window.__logsviewerStatusInterval); }
        window.__logsviewerStatusInterval = setInterval(logsviewer_status, config.refreshInterval);
    }
});
