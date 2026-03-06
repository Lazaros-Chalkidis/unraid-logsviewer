/* ── Logsviewer Widget JS ────────────────────────────────────────────────────
   Drives polling and UI updates in the dashboard widget and Tool page.
   Configuration is injected via window.logsviewerConfig from Logsviewer.page.
   ────────────────────────────────────────────────────────────────────────── */
/* global $ */

// ---------------------------------------------------------------------------
let logsviewer_cfg = {};
let logsviewer_searchState = { term: '', hits: [], idx: -1 };
let logsviewer_pauseHoverActive = false;
let logsviewer_pollBackoffUntil = 0;

// Cached DOM references — populated on first use, cleared on re-init
const logsviewer_dom = {
    get logs()      { return this._logs      || (this._logs      = document.getElementById('logsviewer-logs')); },
    get container() { return this._container || (this._container = document.getElementById('logsviewer-container')); },
    get autoscroll(){ return this._autoscroll|| (this._autoscroll= document.getElementById('logsviewer-autoscroll')); },
    get timestamp() { return this._timestamp || (this._timestamp = document.getElementById('logsviewer-timestamp')); },
    clear() { this._logs = this._container = this._autoscroll = this._timestamp = null; }
};

// v4: Category state
let logsviewer_activeCategory = 'system';  // 'system' | 'docker' | 'vm'
let logsviewer_categoryData = {};          // { system: [...], docker: [...], vm: [...] }
let logsviewer_activeLogContent = '';       // Current displayed log raw content
let logsviewer_activeLogTotalLines = 0;    // Current displayed log total lines

let logsviewer_lastShown = { category: null, source: null }; // Track last rendered log

// Login event toast de-dupe (avoid repeating on each poll)
let logsviewer_lastLoginEventId = null;

/**
 * Get the currently selected source name from the active category dropdown.
 */
function logsviewer_getActiveSource() {
    var btn = $('.logsviewer-cat-btn[data-category="' + logsviewer_activeCategory + '"]');
    return btn.attr('data-selected') || '';
}

/**
 * Find log data for a given source name within a category's data array.
 */
function logsviewer_findLogData(category, sourceName) {
    var data = logsviewer_categoryData[category];
    if (!Array.isArray(data)) return null;
    for (var i = 0; i < data.length; i++) {
        if (data[i].name === sourceName) return data[i];
    }
    return null;
}

/**
 * Display a specific log entry in the log panel.
 */
function logsviewer_showLog(entry) {
    var logDisplay = $(logsviewer_dom.logs);
    if (!entry || !logDisplay.length) return;
    logsviewer_activeLogContent = entry.log || '';
    logsviewer_activeLogTotalLines = entry.total_lines || 0;
    logsviewer_lastShown = { category: entry.category || logsviewer_activeCategory || null, source: entry.name || entry.display_name || null };
    logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
    logsviewer_updateSelectedToast();
    logsviewer_layoutToasts();

    // Detect login attempts in syslog and show a transient toast.
    // We only scan when the displayed log is syslog to avoid extra work.
    try{
        const name = String(entry.name || entry.display_name || '').toLowerCase();
        const cat  = String(entry.category || logsviewer_activeCategory || '').toLowerCase();
        if(cat === 'system' && name === 'syslog'){
            logsviewer_checkLoginToast(logsviewer_activeLogContent);
        }
    }catch(_){ }

    // Update search if active
    if (logsviewer_cfg.searchEnabled && String(logsviewer_searchState.term || '').trim()) {
        var count = logsviewer_countMatches(logsviewer_activeLogContent, logsviewer_searchState.term);
        logsviewer_updateSearchToast(count);
        logsviewer_collectSearchHits();

        // When user stops typing, restore Syntax toast and re-flash (2x) once.
        logsviewer_searchTypingTimer = setTimeout(() => {
            logsviewer_searchTyping = false;
            const perf = document.getElementById('logsviewer-perf-toast');
            if (perf) perf.dataset.lvSuppressedBySearch = '1';
            logsviewer_layoutToasts();
        }, 700);

    }
}

// ---------------------------------------------------------------------------
let logsviewer_forceLoginUntil = 0; // temporary override to show login toast even when Syntax toast is active
let logsviewer_perfToastTimer   = null; // auto-dismiss timer for Large log toast

function logsviewer_showLoginToast(message){
  try{
    const line = $('#logsviewer-toast-line');
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

    // Persist the last login message (used as "idle" toast when no Search/Syntax toast exists).
    if(!message){
      el.textContent = '';
      el.style.display = 'none';
      try{ localStorage.removeItem('logsviewer_last_login_msg'); }catch(_){ }
      logsviewer_layoutToasts();
      return;
    }

    el.textContent = message;
    el.style.display = '';
    try{ localStorage.setItem('logsviewer_last_login_msg', message); }catch(_){ }
    logsviewer_layoutToasts();
  }catch(_){ }
}

function logsviewer_getSelectedLabel() {
    // Returns e.g. "System → Syslog" based on logsviewer_lastShown
    try {
        var cat  = String((logsviewer_lastShown && logsviewer_lastShown.category) || logsviewer_activeCategory || '');
        var src  = String((logsviewer_lastShown && logsviewer_lastShown.source)   || '');
        if (!src) return '';

        // Pretty-print category
        var catLabel = cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();

        // Pretty-print source: capitalise each word, replace dashes/underscores with spaces
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
    const msg = localStorage.getItem('logsviewer_last_login_msg');
    if(msg) logsviewer_showLoginToast(msg);
  }catch(_){ }
}

function logsviewer_extractLoginEvent(text){
    const t = String(text || '');
    if(!t) return null;

    // Scan the tail for the most recent event.
    const lines = t.split(/\r?\n/);
    const start = Math.max(0, lines.length - 250);

    // Common patterns (SSH + Unraid webGUI + PAM)
    const reSuccess = [
        // Unraid webgui — \b prevents matching "Unsuccessful login"
        /\bSuccessful\s+login\s+user\s+(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        // sshd
        /Accepted\s+(?:password|publickey)\s+for\s+(?<user>[^\s]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        // webgui-ish
        /\bSuccessful\s+login\s+(?:for\s+user\s+)?(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i,
        // generic
        /user\s+(?<user>[^\s,;]+)\s+logged\s+in.*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i
    ];
    const reFail = [
        // Unraid webgui — "Unsuccessful login" / "Unsuccessful login attempt"
        /Unsuccessful\s+login(?:\s+attempt)?\s+(?:for\s+)?(?:user\s+)?(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /Unsuccessful\s+login(?:\s+attempt)?.*?user[:\s]+(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i,
        // Unraid webgui "Failed login"
        /Failed\s+login\s+user\s+(?<user>[^\s,;]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /Failed\s+password\s+for\s+(?:invalid\s+user\s+)?(?<user>[^\s]+)\s+from\s+(?<ip>[0-9a-fA-F:\.]+)/i,
        /authentication\s+failure.*?user=(?<user>[^\s]+).*?(?:rhost=(?<ip>[0-9a-fA-F:\.]+))?/i,
        /Failed\s+login.*?(?<user>[^\s,;]+).*?(?:from\s+(?<ip>[0-9a-fA-F:\.]+))?/i
    ];

    for(let i = lines.length - 1; i >= start; i--){
        const line = lines[i];
        if(!line) continue;

        // Check fail BEFORE success — "Unsuccessful" contains "successful" so order matters
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

        // De-dupe across polls. Persist lightly so page reload won't re-toast.
        if(!logsviewer_lastLoginEventId){
            logsviewer_lastLoginEventId = localStorage.getItem('logsviewer_last_login_event') || null;
        }
        if(ev.id && ev.id === logsviewer_lastLoginEventId) return;

        logsviewer_lastLoginEventId = ev.id;
        localStorage.setItem('logsviewer_last_login_event', ev.id);

        const who = ev.user || 'user';
        const ip  = ev.ip || 'unknown';
        const msg = (ev.type === 'success')
            ? `Login successful: ${who} IP: ${ip}`
            : `Login failed: ${who} IP: ${ip}`;

        // If Syntax toast is currently visible (and Search isn't), briefly force showing the login toast.
        logsviewer_forceLoginUntil = Date.now() + 6500;
        logsviewer_showLoginToast(msg);
    }catch(_){ }
}

/**
 * Activate category (highlight tab + refresh data) WITHOUT auto-opening the last viewed log.
 * Used when the user clicks a tab just to open its dropdown.
 */
function logsviewer_activateCategory(category) {
    logsviewer_activeCategory = category;

    // Highlight active tab
    $('.logsviewer-cat-btn').removeClass('logsviewer-cat-btn--active');
    $('.logsviewer-cat-btn[data-category="' + category + '"]').addClass('logsviewer-cat-btn--active');

    // Fetch fresh data (no auto-display)
    logsviewer_fetchCategory(category, null, { autoShow: false });
}

/**
 * Switch active category, highlight tab, and fetch data.
 */
function logsviewer_switchCategory(category) {
    logsviewer_activeCategory = category;

    // Highlight active tab
    $('.logsviewer-cat-btn').removeClass('logsviewer-cat-btn--active');
    $('.logsviewer-cat-btn[data-category="' + category + '"]').addClass('logsviewer-cat-btn--active');

    // If we have cached data for this category, show it immediately
    var data = logsviewer_categoryData[category];
    if (data && data.length > 0) {
        var sourceName = $('.logsviewer-cat-btn[data-category="' + category + '"]').attr('data-selected') || '';
        var entry = logsviewer_findLogData(category, sourceName);
        if (entry) logsviewer_showLog(entry);
    }

    // Fetch fresh data
    logsviewer_fetchCategory(category);
}

/**
 * Fetch logs for a category and update the display.
 */
// Mark exactly one dropdown item as active (globally across all tabs)
// Must be global so logsviewer_fetchCategory can call it after async li rebuild
function logsviewer_markActiveItem(cat, sourceName) {
    $('.logsviewer-cat-dropdown li').removeClass('lv-item--active');
    if (cat && sourceName) {
        var $drop = $('#logsviewer-cat-' + cat);
        $drop.find('li[data-value="' + sourceName + '"]').addClass('lv-item--active');
    }
}

function logsviewer_fetchCategory(category, callback, opts) {
    opts = opts || {};
    var autoShow = (opts.autoShow !== false);
    var url = logsviewer_apiUrl('get_script_states', { category: category });

    $.ajax({ url: url, dataType: 'json', timeout: 15000 })
        .done(function(scripts) {
            if (!Array.isArray(scripts)) scripts = [];
            logsviewer_categoryData[category] = scripts;

            // Update dropdown options if needed (for docker/vm where containers may change)
            if (category !== 'system') {
                var $drop = $('#logsviewer-cat-' + category);
                var $tabBtn = $('.logsviewer-cat-btn[data-category="' + category + '"]');
                var prevVal = $tabBtn.attr('data-selected') || '';
                $drop.empty();
                scripts.forEach(function(s) {
                    var name = s.display_name || s.name;
                    $drop.append($('<li>').attr('data-value', s.name).text(name));
                });
                // Restore selection if still available, otherwise clear it
                if (prevVal && $drop.find('li[data-value="' + prevVal + '"]').length) {
                    $tabBtn.attr('data-selected', prevVal);
                    // Re-apply active highlight after li rebuild (Docker/VM async populate)
                    logsviewer_markActiveItem(category, prevVal);
                } else {
                    $tabBtn.attr('data-selected', '');
                }
            }

            // Show/hide category tab based on data availability
            var tab = $('.logsviewer-cat-btn[data-category="' + category + '"]');
            if (scripts.length > 0) {
                tab.removeClass('logsviewer-cat-btn--hidden');
            }

            // If this is the active category, display the selected source
            if (autoShow) {
            if (category === logsviewer_activeCategory) {
                var $tabNow = $('.logsviewer-cat-btn[data-category="' + category + '"]');
                var sourceName = $tabNow.attr('data-selected') || '';
                var entry = logsviewer_findLogData(category, sourceName);

                if (entry) {
                    logsviewer_showLog(entry);
                    logsviewer_markActiveItem(category, sourceName);
                    // Mobile: set native select value for visual checkmark
                    var $nativeSel = $tabNow.find('.logsviewer-cat-native');
                    try { $nativeSel[0].value = sourceName; } catch(_) {}
                } else if (scripts.length > 0 && !sourceName) {
                    // Fallback on initial load only (no user selection yet): show first item
                    $tabNow.attr('data-selected', scripts[0].name);
                    logsviewer_showLog(scripts[0]);
                    logsviewer_markActiveItem(category, scripts[0].name);
                    // Mobile: set native select value
                    var $nativeSelFb = $tabNow.find('.logsviewer-cat-native');
                    try { $nativeSelFb[0].value = scripts[0].name; } catch(_) {}
                }

                // Update compact indicators
                logsviewer_updateCompactIndicators(scripts);

                // Timestamp
                var timestampDisplay = $(logsviewer_dom.timestamp);
                if (timestampDisplay.length && logsviewer_cfg.showTimestamp) {
                    timestampDisplay.text(new Date().toLocaleTimeString());
                }
            }

            }

            if (callback) callback(scripts);
        })
        .fail(function() {
            console.error('Failed to fetch logs for category:', category);
            if (callback) callback([]);
        });
}

// Context-aware localStorage key: prevents Dashboard/Tool bleed
function logsviewer_storageKey(base) {
    const ctx = (logsviewer_cfg && logsviewer_cfg.apiContext) || 'dashboard';
    return base + '_' + ctx;
}

// ---------------------------------------------------------------------------
function logsviewer_apiUrl(action, extraParams) {
    let url = '/plugins/logsviewer/logsviewer_api.php?action=' + encodeURIComponent(action);
    if (logsviewer_cfg.apiContext) {
        url += '&context=' + encodeURIComponent(logsviewer_cfg.apiContext);
    }
    // CSRF token — generated server-side, rotated hourly
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
function logsviewer_cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(s));
    return String(s).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
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

    const lines = text.split('\n');

    const matchers = {
        info:     /(\binfo\b|\bnotice\b)/i,
        errors:   /(\berror\b|\berr\b|\bcritical\b|\bfatal\b|\bpanic\b|\bemerg(?:ency)?\b|\balert\b)/i,
        warnings: /(\bwarning\b|\bwarn\b)/i,
        critical: /(\bemergency\b|\bcritical\b|\bfatal\b|\bpanic\b|\balert\b|\bemerg(?:ency)?\b)/i,
        auth:     /(\bauth\b|\bauthentication\b|\blogin\b|\blogout\b|\boidc\b|\btoken\b|\bjwt\b|\bsso\b)/i,
    };

    const re = matchers[filter];
    if (!re) return text;

    return lines.filter(l => re.test(l)).join('\n');
}

// ---------------------------------------------------------------------------
function logsviewer_countLevels(text) {
    const t = String(text || '');
    const lines = t.split('\n').filter(Boolean);

    const re = {
        critical: /(\bemergency\b|\bcritical\b|\balert\b|\bfatal\b|\bpanic\b)/i,
        error:    /(\berror\b|\berr\b)/i,
        warning:  /(\bwarning\b|\bwarn\b)/i,
        info:     /(\binfo\b|\bnotice\b)/i,
    };

    const counts = { critical: 0, error: 0, warning: 0, info: 0 };

    for (const line of lines) {
        if (re.critical.test(line)) { counts.critical += 1; continue; }
        if (re.error.test(line))    { counts.error += 1;    continue; }
        if (re.warning.test(line))  { counts.warning += 1;  continue; }
        if (re.info.test(line))     { counts.info += 1;     continue; }
    }

    return counts;
}

function logsviewer_updateBadges(counts) {
    const badges = [
        { key: 'info',     id: '#logsviewer-badge-info',     label: 'Info',     filter: 'info',     numClass: 'logsviewer-count--info' },
        { key: 'error',    id: '#logsviewer-badge-errors',   label: 'Errors',   filter: 'errors',   numClass: 'logsviewer-count--error' },
        { key: 'warning',  id: '#logsviewer-badge-warnings', label: 'Warnings', filter: 'warnings', numClass: 'logsviewer-count--warning' },
        { key: 'critical', id: '#logsviewer-badge-critical', label: 'Critical', filter: 'critical', numClass: 'logsviewer-count--critical' },
    ];

    badges.forEach(b => {
        const $el = $(b.id);
        if (!$el.length) return;

        const v = Number(counts[b.key] || 0);

        $el.html(
            `<span class="logsviewer-badge-label">${b.label}</span>` +
            ` <span class="logsviewer-badge-count ${b.numClass}">${v}</span>`
        );

        $el.toggleClass('is-zero', v === 0);

        $el.attr('data-filter', b.filter);
        $el.attr('role', 'button');
        $el.attr('tabindex', '0');

        $el.attr('title', `Set filter: ${b.filter} (${b.label} = ${v})`);
        $el.attr('aria-label', `Set filter ${b.filter}. ${b.label} ${v}`);
    });
}

// ---------------------------------------------------------------------------
function logsviewer_tailText(text, n) {
    const N = Number(n) || 0;
    if (!N || N <= 0) return String(text || '');
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = raw.split('\n');
    if (parts.length <= N) return raw;
    return parts.slice(parts.length - N).join('\n');
}

// ---------------------------------------------------------------------------
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

function logsviewer_applySearchHighlight(text) {
    if (!logsviewer_cfg.searchEnabled) return String(text || '');
    const term = String(logsviewer_searchState.term || '').trim();
    if (!term) return String(text || '');

    // Always wrap matches in a span so we can scroll to them.
    // Add the visible highlight class only when the setting is on.
    const cls = logsviewer_cfg.searchHighlight
        ? 'logsviewer-search-hit logsviewer-search-hit--visible'
        : 'logsviewer-search-hit';

    const re = new RegExp(logsviewer_escapeRegExp(term), 'gi');
    // Only replace in text nodes (outside HTML tags) to avoid corrupting existing markup
    return String(text || '').replace(/(<[^>]+>)|([^<]+)/g, function(match, tag, txt) {
        if (tag) return tag; // Leave HTML tags untouched
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

    // Always use DOM spans for hit tracking (both highlight-on and highlight-off)
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
    const line = $('#logsviewer-toast-line');
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
    // Plain text styling via spans: number colored, label white.
    toast.html(`<span class="lv-toast-num">${num}</span> <span class="lv-toast-label">${label}</span>`).show();

    // Reflow toast rows so perf/syntax toast won't overlap.
    logsviewer_layoutToasts();
}

// Keep search + perf toasts in a stable 2-line footer area.
// If search toast is hidden/inactive, perf toast moves to row1.
// Toast layout rules (single-line panel)
// - When user is actively typing in Search, Search toast wins and Syntax toast is hidden.
// - When typing stops, Syntax toast returns and flashes (2x) once, then stays on.
let logsviewer_searchTyping = false;
let logsviewer_searchTypingTimer = null;

function logsviewer_layoutToasts(){
    const line = $('#logsviewer-toast-line');
    // If toast panel was not rendered (showToast=false in PHP), nothing to do
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
        // typing: hide perf, show search if available
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

    // not typing
    if (searchVisible) {
        // search wins when visible
        if (searchToast.length) searchToast.show();
        if (perfToast.length) perfToast.hide();
        if (loginToast.length) loginToast.hide();
        var selToastSV = document.getElementById('logsviewer-selected-toast');
        if (selToastSV) selToastSV.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    // No search -> if a new login event arrived, briefly force showing it even if Syntax toast exists.
    if (forceLogin && loginToast.length && loginHasText) {
        loginToast.show();
        if (perfToast.length) perfToast.hide();
        if (searchToast.length) searchToast.hide();
        var selToastF = document.getElementById('logsviewer-selected-toast');
        if (selToastF) selToastF.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    // no visible search -> show perf (Syntax) if it has text
    if (perfToast.length && perfHasText) {
        perfToast.show();
        // If it was suppressed by typing, re-flash once when returning.
        if (perfToast[0].dataset.lvSuppressedBySearch === '1') {
            perfToast[0].dataset.lvSuppressedBySearch = '0';
            logsviewer_startPerfFlash(perfToast[0], 2);
        }
    } else if (perfToast.length) {
        perfToast.hide();
    }

    if (searchToast.length) searchToast.hide();

    // If Syntax toast active, hide login and selected, show panel
    if (perfToast.length && perfHasText) {
        if (loginToast.length) loginToast.hide();
        var selToastA = document.getElementById('logsviewer-selected-toast');
        if (selToastA) selToastA.style.display = 'none';
        if(panel.length) panel.show();
        return;
    }

    // Idle fallback: show "Selected: Category → Source" if a log is already loaded
    logsviewer_updateSelectedToast();
    var selToast = document.getElementById('logsviewer-selected-toast');
    var selLabel = logsviewer_getSelectedLabel();
    if (selToast && selLabel) {
        selToast.style.display = 'block';
        if (loginToast.length) loginToast.hide();
        if(panel.length) panel.show();
        return;
    }

    // No log selected yet (initial load) → fall back to login toast if available
    if (loginToast.length && loginHasText) {
        loginToast.show();
        if(panel.length) panel.show();
        return;
    }

    // Nothing to show -> hide the panel
    if (perfToast.length) perfToast.hide();
    if (loginToast.length) loginToast.hide();
    if (searchToast.length) searchToast.hide();
    if(panel.length) panel.hide();
}


function logsviewer_ensureSearchUi() {
    if (!logsviewer_cfg.searchEnabled) return;
    if ($('#logsviewer-search-input').length) return;

    // Support both responsive (.logsviewer-header__right) and legacy (.logsviewer-legacy-controls)
    let headerRight = $('.logsviewer-header__right');
    const isLegacy = !headerRight.length;
    if (isLegacy) {
        headerRight = $('.logsviewer-legacy-controls');
    }
    if (!headerRight.length) return;

    // Ensure we have an inputs row
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

        // Hide Syntax toast while typing
        logsviewer_searchTyping = true;
        if (logsviewer_searchTypingTimer) clearTimeout(logsviewer_searchTypingTimer);
        logsviewer_searchTypingTimer = setTimeout(() => {
            logsviewer_searchTyping = false;
            logsviewer_layoutToasts();
        }, 700);
        logsviewer_layoutToasts();

        // Debounce the expensive render (200ms after last keystroke)
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

    // keyboard: Enter -> next, Shift+Enter -> prev
    $('#logsviewer-search-input').on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                logsviewer_searchPrev();
            } else {
                logsviewer_searchNext();
            }
        }
        // Escape clears
        if (e.key === 'Escape') {
            e.preventDefault();
            this.value = '';
            $(this).trigger('input');
        }
    });
}

// ---------------------------------------------------------------------------
function logsviewer_highlightLevels(text) {
    let t = String(text || '');

    // If highlighting disabled, return as-is (still safe: API already escapes)
    if (!logsviewer_cfg.highlightEnabled) return t;

    const mode = logsviewer_cfg.highlightMode || 'full';

    // Header highlight (kept)
    t = t.replace(
        /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^:]+:)/gm,
        '<span class="logsviewer-hdr">$1</span>'
    );

    // Always-highlight critical+error+warning+info in both modes
    t = t.replace(/\bemergency\b/gi, m => `<span class="logsviewer-lvl-emergency">${m}</span>`);
    t = t.replace(/\bcritical\b/gi,  m => `<span class="logsviewer-lvl-critical">${m}</span>`);
    t = t.replace(/\bwarning\b/gi,   m => `<span class="logsviewer-lvl-warning">${m}</span>`);
    t = t.replace(/\berror\b/gi,     m => `<span class="logsviewer-lvl-error">${m}</span>`);
    t = t.replace(/\binfo\b/gi,      m => `<span class="logsviewer-lvl-info">${m}</span>`);
    t = t.replace(/\bwarn\b/gi,      m => `<span class="logsviewer-lvl-warn">${m}</span>`);

    if (mode === 'keywords') {
        // Keep it tight: only the above + alert/fatal/panic
        t = t.replace(/\balert\b/gi,     m => `<span class="logsviewer-lvl-alert">${m}</span>`);
        t = t.replace(/\bfatal\b/gi,     m => `<span class="logsviewer-lvl-fatal">${m}</span>`);
        t = t.replace(/\bpanic\b/gi,     m => `<span class="logsviewer-lvl-panic">${m}</span>`);
        return t;
    }

    // full mode (your current behavior)
    t = t.replace(/\bnotice\b/gi,    m => `<span class="logsviewer-lvl-notice">${m}</span>`);
    t = t.replace(/\balert\b/gi,     m => `<span class="logsviewer-lvl-alert">${m}</span>`);
    t = t.replace(/\bfatal\b/gi,     m => `<span class="logsviewer-lvl-fatal">${m}</span>`);
    t = t.replace(/\bpanic\b/gi,     m => `<span class="logsviewer-lvl-panic">${m}</span>`);
    t = t.replace(/\btrace\b/gi,     m => `<span class="logsviewer-lvl-trace">${m}</span>`);
    t = t.replace(/\bdebug\b/gi,     m => `<span class="logsviewer-lvl-debug">${m}</span>`);
    return t;
}

// ---------------------------------------------------------------------------
function logsviewer_countLines(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!raw.trim()) return 0;

    const endsWithNewline = raw.endsWith('\n');
    const parts = raw.split('\n');
    return endsWithNewline ? (parts.length - 1) : parts.length;
}

var logsviewer_lastTotalLines = -1;

function logsviewer_setTotalLinesValue(n) {
    const out = document.getElementById('logsviewer-total-lines');
    if (!out) return;
    var val = Math.max(0, Number(n) || 0);
    out.textContent = String(val);

    // Flash pulse dot when new lines arrive
    if (logsviewer_lastTotalLines >= 0 && val > logsviewer_lastTotalLines) {
        var pulse = document.querySelector('.logsviewer-pulse');
        if (pulse) {
            pulse.classList.remove('logsviewer-pulse--flash');
            // Force reflow to restart animation
            void pulse.offsetWidth;
            pulse.classList.add('logsviewer-pulse--flash');
        }
    }
    logsviewer_lastTotalLines = val;
}

// ---------------------------------------------------------------------------
let logsviewer_hljsLoaded = false;
let logsviewer_currentSyntax = 'plaintext';

function logsviewer_loadHighlightJs(callback) {
    // Load Highlight.js from CDN (stable path). Guard against double-load.
    if (logsviewer_hljsLoaded || window.hljs) {
        logsviewer_hljsLoaded = true;
        if (callback) callback();
        return;
    }

    // CSS (only once)
    if (!document.querySelector('link[data-logsviewer-hljs-css]')) {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
        cssLink.setAttribute('data-logsviewer-hljs-css', '1');
        document.head.appendChild(cssLink);
    }

    // JS (only once)
    if (document.querySelector('script[data-logsviewer-hljs-js]')) {
        // Script is already in flight; poll until available.
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
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
    script.setAttribute('data-logsviewer-hljs-js', '1');
    script.onload = function () {
        logsviewer_hljsLoaded = true;
        if (callback) callback();
    };
    script.onerror = function () {
        // If CDN is blocked/offline, just disable highlighting gracefully.
        logsviewer_hljsLoaded = false;
        if (callback) callback();
    };
    document.head.appendChild(script);
}



// ---------------------------------------------------------------------------
// Prism.js (CDN) — assets loader (vNext). Not used yet; safe to keep as no-op.
// Step 1: only add assets for later use. Engine switch comes in Step 2.
// ---------------------------------------------------------------------------
let logsviewer_prismLoaded = false;

/**
 * Load Prism core + theme CSS from CDN (idempotent).
 * NOTE: This does NOT apply highlighting by itself.
 */
function logsviewer_loadPrism(callback) {
    if (logsviewer_prismLoaded || window.Prism) {
        logsviewer_prismLoaded = true;
        if (callback) callback();
        return;
    }

    // Theme CSS (only once)
    if (!document.querySelector('link[data-logsviewer-prism-css]')) {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        // Theme: okaidia (nice contrast on dark UIs). Can be swapped later.
        cssLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-okaidia.min.css';
        cssLink.setAttribute('data-logsviewer-prism-css', '1');
        document.head.appendChild(cssLink);
    }

    // Core JS (only once)
    if (document.querySelector('script[data-logsviewer-prism-js]')) {
        // Script is already in flight; poll until available.
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
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js';
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

function logsviewer_applySyntaxHighlight(logDisplay) {
    const syntax = logsviewer_currentSyntax;
    
    if (syntax === 'plaintext' || !window.hljs) {
        // Remove any previous syntax highlighting
        logDisplay.removeClass('hljs');
        return;
    }

    // Get the current HTML (already has level highlighting)
    const content = logDisplay.text();
    
    // Create a temporary code element for highlighting
    const tempCode = document.createElement('code');
    tempCode.className = `language-${syntax}`;
    tempCode.textContent = content;

    // Apply Highlight.js
    try {
        window.hljs.highlightElement(tempCode);
        // Replace the log display with highlighted content
        logDisplay.html(tempCode.innerHTML);
        logDisplay.addClass('hljs');
    } catch (e) {
        console.warn('Syntax highlighting failed:', e);
    }
}

function logsviewer_applySyntaxHighlightToText(text, syntax) {
    if (!window.hljs || syntax === 'plaintext') {
        return text;
    }

    try {
        // Use Highlight.js to highlight the text
        const result = window.hljs.highlight(text, { language: syntax, ignoreIllegals: true });
        return result.value;
    } catch (e) {
        console.warn('Syntax highlighting failed:', e);
        return text;
    }
}

// Prism helpers (beta engine)
// We load a small set of Prism language components on-demand via CDNJS.
const LOGSVIEWER_PRISM_LANG_URLS = {
    // Base deps for some languages
    'clike': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-clike.min.js',
    'markup-templating': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markup-templating.min.js',

    // Common languages for logsviewer
    'bash': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js',
    'json': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js',
    'yaml': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-yaml.min.js',
    'php':  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-php.min.js',
    'nginx': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-nginx.min.js',
    'docker': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-docker.min.js',
    'sql': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-sql.min.js'
};

function logsviewer_prismLanguageDeps(lang) {
    // PHP requires clike + markup-templating (which itself needs markup from core).
    // markup-templating does NOT register in Prism.languages — we track it via
    // a window sentinel (window.__lvPrismMarkupTemplating) set in loadScriptOnce.
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

function logsviewer_ensurePrismLanguage(lang, callback) {
    const cb = callback || function () {};

    if (!lang || lang === 'plaintext') { cb(true); return; }

    logsviewer_loadPrism(function () {
        if (!window.Prism || !Prism.languages) { cb(false); return; }

        // If already present
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
            // markup-templating doesn't register in Prism.languages — use sentinel
            const alreadyLoaded = (dep === 'markup-templating')
                ? !!window.__lvPrismMarkupTemplating
                : !!Prism.languages[dep];
            if (alreadyLoaded) { next(); return; }

            const url = LOGSVIEWER_PRISM_LANG_URLS[dep];
            if (!url) { next(); return; }  // skip unknown dep, don't abort chain

            logsviewer_loadScriptOnce(url, 'data-logsviewer-prism-lang-' + dep, function () {
                if (dep === 'markup-templating') window.__lvPrismMarkupTemplating = true;
                // Give Prism a tick to register language
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
        return Prism.highlight(text, Prism.languages[syntax], syntax);
    } catch (e) {
        console.warn('Prism highlighting failed:', e);
        return text;
    }
}

// ---------------------------------------------------------------------------
function logsviewer_isMobileish() {
    try {
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        const narrow = typeof window.innerWidth === 'number' && window.innerWidth <= 768;
        const cores = Number(navigator && navigator.hardwareConcurrency);
        const lowCores = Number.isFinite(cores) && cores > 0 && cores <= 4;
        return Boolean(coarse || narrow || lowCores);
    } catch (e) {
        return false;
    }
}

function logsviewer_getPrismBudgets(lang) {
    const mobile = logsviewer_isMobileish();
    const heavy = (String(lang || '').toLowerCase() === 'php');

    // Budgets are conservative to avoid freezing on phones.
    // autoTailLines is used when the current view is "too big" for Prism.
    // NOTE: Per user request, autoTailLines is fixed to 800 everywhere.
    let budget = mobile
        ? { maxChars: 40000, maxLines: 400, autoTailLines: 800 }
        : { maxChars: 80000, maxLines: 800, autoTailLines: 800 };

    // Heavy grammars (PHP in particular) get stricter limits.
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

        // prevent restarting while already flashing
        if(el.dataset.lvFlashing === '1') return;

        el.dataset.lvFlashing = '1';
        el.dataset.lvFlashDone = '0';

        if(el.__lvFlashInterval) clearInterval(el.__lvFlashInterval);

        let count = 0;
        const runOnce = () => {
            el.classList.remove('logsviewer-toast-flash');
            void el.offsetWidth; // reflow
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


function logsviewer_showPerfToast(message){
  try{
    const line = $('#logsviewer-toast-line');
    if(!line.length) return;

    let el = document.getElementById('logsviewer-perf-toast');
    if(!el){
      el = document.createElement('div');
      el.id = 'logsviewer-perf-toast';
      el.className = 'logsviewer-perf-toast';
      el.style.display = 'none';
      line.append(el);
    }

    // Show/hide
    if(!message){
      el.textContent = '';
      el.style.display = 'none';
      if (logsviewer_perfToastTimer) { clearTimeout(logsviewer_perfToastTimer); logsviewer_perfToastTimer = null; }
      return;
    }

    el.textContent = message;
    el.style.display = '';

    // If user is typing search, suppress (will return after debounce)
    if (logsviewer_searchTyping) {
        el.dataset.lvSuppressedBySearch = '1';
        el.style.display = 'none';
        return;
    }

    // Flash exactly 2 times, then stay on briefly.
    if (el.dataset.lvFlashDone !== '1' && el.dataset.lvFlashing !== '1') {
        logsviewer_startPerfFlash(el, 2);
    }

    // Auto-dismiss after 6s → fall back to Selected toast
    if (logsviewer_perfToastTimer) { clearTimeout(logsviewer_perfToastTimer); }
    logsviewer_perfToastTimer = setTimeout(function() {
        logsviewer_perfToastTimer = null;
        el.textContent = '';
        el.style.display = 'none';
        el.dataset.lvFlashDone = '0';
        logsviewer_layoutToasts();
    }, 6000);

    logsviewer_layoutToasts();
  }catch(_){}
}
function logsviewer_setupSyntaxDropdown() {
    const dropdown = $('#logsviewer-syntax-select');
    if (!dropdown.length) return;

    // Load saved syntax preference
    const savedSyntax = logsviewer_getSyntaxSelection();
    logsviewer_currentSyntax = savedSyntax;
    dropdown.val(savedSyntax);

    // Listen for changes
    dropdown.on('change', function() {
        const newSyntax = String(this.value || 'plaintext');
        logsviewer_currentSyntax = newSyntax;
        logsviewer_setSyntaxSelection(newSyntax);

        // Re-render current log with new syntax
        const logDisplay = $(logsviewer_dom.logs);
        if (logsviewer_activeLogContent && logDisplay.length) {
            logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
        }
    });
}

// ---------------------------------------------------------------------------
function logsviewer_renderLog(logDisplay, rawText, totalLinesFromApi) {
    const filter = logsviewer_getFilterValue();

    // Always clear the perf toast at start of every render — it will only be
    // re-set below if THIS specific log actually exceeds the threshold.
    // Without this, a "Large log" from a previous log lingers when switching.
    logsviewer_showPerfToast(null);

    // Tail first (performance: render limit)
    let base = logsviewer_tailText(rawText || '', logsviewer_cfg.tailLines || 0);

    // Sanitize syslog date padding: RFC 3164 pads single-digit days with a space
    // e.g. "Feb  8 04:00:08" → "Feb 8 04:00:08"
    base = base.replace(/^([A-Z][a-z]{2})  (\d )/gm, '$1 $2');

    // Apply filter
    let filtered = logsviewer_applyFilterToText(base);

    if (filter !== 'none' && String(filtered).trim() === '') {
        const label = logsviewer_getFilterLabel(filter);
        filtered = `[info] No matching lines for '${label}' filter.`;
    }

    // Total lines display
    if (logsviewer_cfg.showTotalLines) {
        if (filter === 'none' && Number.isFinite(Number(totalLinesFromApi)) && (!logsviewer_cfg.tailLines || logsviewer_cfg.tailLines <= 0)) {
            logsviewer_setTotalLinesValue(Number(totalLinesFromApi)); // whole file total
        } else {
            logsviewer_setTotalLinesValue(logsviewer_countLines(filtered)); // filtered/tail view count
        }
        $('.logsviewer-title-meta').show();
    } else {
        $('.logsviewer-title-meta').hide();
    }


// Apply syntax highlighting BEFORE level highlighting (so levels can override)
// Engine can be switched via Settings (default: Highlight.js)
if (logsviewer_cfg.syntaxEnabled && logsviewer_currentSyntax !== 'plaintext') {
    const engine = String(logsviewer_cfg.syntaxEngine || 'hljs');

    if (engine === 'prism') {
        // Performance guard: Prism can freeze on huge logs (especially mobile / heavy grammars like PHP)
        const budget = logsviewer_getPrismBudgets(logsviewer_currentSyntax);
        const lineCount = logsviewer_countLines(filtered);
        const charCount = (filtered || '').length;
        const userTailLines = Number(logsviewer_cfg.tailLines) || 0;
        const tooBigByChars = (userTailLines <= 0) && (charCount > budget.maxChars);
        const tooBigByLines = (lineCount > budget.maxLines);
	    const tooBig = tooBigByLines || tooBigByChars;
	    // Only show the perf toast if lines actually exceeded the threshold.
	    // When only chars are large (long lines, e.g. nginx) we still trim silently.
	    const showPerfToastAllowed = tooBigByLines;
	    // We may trim content and still safely apply Prism. This flag controls whether
	    // highlighting should proceed after guards.
	    let prismCanHighlight = true;

        if (tooBig) {
            // Auto fallback: apply syntax only to the last N lines so we don't freeze
            const tailN = Number(budget.autoTailLines) || 0;

            if (tailN > 0 && tooBigByLines && (lineCount > tailN)) {
                filtered = logsviewer_tailText(filtered, tailN);
                if (showPerfToastAllowed) logsviewer_showPerfToast(`Large log • Syntax: last ${tailN}`);
            } else if (tooBigByChars) {
                // Too many characters can still freeze Prism. Instead of disabling outright,
                // try trimming by *lines* based on average line length.
                const avgCharsPerLine = Math.max(1, Math.ceil(charCount / Math.max(1, lineCount)));
                let maxSafeLines = Math.floor(budget.maxChars / avgCharsPerLine);

                // Keep a sane minimum so the output isn't useless.
                maxSafeLines = Math.max(50, maxSafeLines);

                if (lineCount > maxSafeLines) {
                    filtered = logsviewer_tailText(filtered, maxSafeLines);
                    if (showPerfToastAllowed) logsviewer_showPerfToast(`Large log • Syntax: last ${maxSafeLines}`);
                } else {
                    // Single very long lines (or already under maxSafeLines): safest is to skip syntax.
                    if (showPerfToastAllowed) logsviewer_showPerfToast('Syntax disabled for performance');
	                    prismCanHighlight = false;
                }
            } else {
                // Nothing to reduce (e.g. user already limited lines)
                logsviewer_showPerfToast(null);
            }
        } else {
            logsviewer_showPerfToast(null);
        }

	        // Apply Prism if either content is within budget, or it was safely trimmed.
	        // When tooBigByChars, we only allow Prism if we actually trimmed by lines.
	        const trimmedByCharsPath = tooBigByChars && prismCanHighlight && (lineCount > 0) && ((filtered || '').length <= budget.maxChars);
	        if (prismCanHighlight && (!tooBig || tooBigByLines || trimmedByCharsPath)) {
            // If Prism or the language component isn't loaded yet, load asynchronously and re-render.
            if (!window.Prism || !Prism.languages || !Prism.languages[logsviewer_currentSyntax]) {
                logsviewer_ensurePrismLanguage(logsviewer_currentSyntax, function () {
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
        // Highlight.js (default) — same line-count guard as Prism
        const hljsLineCount = logsviewer_countLines(filtered);
        const hljsMaxLines  = 800;

        if (hljsLineCount > hljsMaxLines) {
            // Trim to last 800 lines and show perf toast (auto-dismisses after 6s)
            filtered = logsviewer_tailText(filtered, hljsMaxLines);
            logsviewer_showPerfToast(`Large log • Syntax: last ${hljsMaxLines}`);
        }
        // (null case already handled by the showPerfToast(null) at top of renderLog)

        if (window.hljs) {
            filtered = logsviewer_applySyntaxHighlightToText(filtered, logsviewer_currentSyntax);
        }
    }
}

    // Highlight levels (optional)
    filtered = logsviewer_highlightLevels(filtered);

    // Search highlight LAST — uses tag-aware regex so it doesn't corrupt existing HTML spans
    filtered = logsviewer_applySearchHighlight(filtered);

    // Batch DOM writes in one rAF to avoid layout thrashing
    requestAnimationFrame(function() {
        const el = logDisplay[0];
        if (!el) return;

        // innerHTML write (single reflow)
        el.innerHTML = filtered;

        // hljs class toggle
        if (logsviewer_cfg.syntaxEnabled && window.hljs && logsviewer_currentSyntax !== 'plaintext') {
            logDisplay.addClass('hljs');
        } else {
            logDisplay.removeClass('hljs');
        }

        // Badges (optional)
        if (logsviewer_cfg.showBadges) {
            logsviewer_updateBadges(logsviewer_countLevels(filtered));
            $('.logsviewer-badges').show();
        } else {
            $('.logsviewer-badges').hide();
        }

        // Refresh search hit list (if enabled)
        if (logsviewer_cfg.searchEnabled) {
            logsviewer_collectSearchHits();
        }
    });
}

// ---------------------------------------------------------------------------
function logsviewer_applyAutoscrollUiState(isOn) {
    const title = $('.logsviewer-autoscroll-title');
    if (!title.length) return;

    const stateClass = isOn ? 'logsviewer-autoscroll-state--on' : 'logsviewer-autoscroll-state--off';
    const stateText  = isOn ? 'On' : 'Off';

    title.html(`Autoscroll <span class="logsviewer-autoscroll-state ${stateClass}">${stateText}</span>`);
}

// ---------------------------------------------------------------------------
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
        // Syslog:  "Mar  6 03:37:46 hostname service: message"
        const reSyslog = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s*(.*)$/;
        // ISO/Docker: "2026-03-06T03:37:46.123Z message"  or  "2026-03-06 03:37:46 message"
        const reIso    = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/;
        // Level keywords (priority order — most specific first)
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

// ---------------------------------------------------------------------------
function logsviewer_applyThemePreset(target, preset) {
    // IMPORTANT:
    // Theme presets should ONLY affect the log display skin (log panel), not the tabs/buttons.
    // So we apply CSS variables to the log container element (#logsviewer-container).
    const p = String(preset || 'default').toLowerCase();
    if (!target) return;

    // Default: clear any preset overrides
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

    // Log-panel-only palette (scoped to #logsviewer-container)
    if (p === 'terminal') {
        set('--logsviewer-log-bg', '#12161c');
        set('--logsviewer-border', '#2c3a52');
        set('--logsviewer-tab-border', '#2c3a52');
        set('--logsviewer-tab-hover-border', '#3b4d6c');
        set('--logsviewer-text-primary', '#e6edf6');
        set('--logsviewer-text-secondary', '#b7c3d6');
        set('--logsviewer-text-muted', '#7e8aa2');
    } else if (p === 'dim') {
        set('--logsviewer-log-bg', '#171717');
        set('--logsviewer-border', '#3a3a3a');
        set('--logsviewer-tab-border', '#343434');
        set('--logsviewer-tab-hover-border', '#4a4a4a');
        set('--logsviewer-text-primary', '#d7d7d7');
        set('--logsviewer-text-secondary', '#bdbdbd');
        set('--logsviewer-text-muted', '#8d8d8d');
    } else if (p === 'contrast') {
        set('--logsviewer-log-bg', '#0f0f0f');
        set('--logsviewer-border', '#5a5a5a');
        set('--logsviewer-tab-border', '#4a4a4a');
        set('--logsviewer-tab-hover-border', '#6a6a6a');
        set('--logsviewer-text-primary', '#ffffff');
        set('--logsviewer-text-secondary', '#e0e0e0');
        set('--logsviewer-text-muted', '#b0b0b0');
    }
}

function logsviewer_applyFontFamily(root, familyKey) {
    const k = String(familyKey || 'system').toLowerCase();
    if (!root) return;

    // We set a few CSS vars so the user sees a clear, consistent difference
    // even if a specific webfont can't be loaded in their environment.
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
    // Two separate bodies exist on the dashboard tile:
    // 1) Tabs body (UI)
    // 2) Log panel body (log display)
    // We only want theming to affect the LOG panel skin.
    const logPanel = document.querySelector('#logsviewer-container');
    if (!logPanel) return;

    // Backwards-compat cleanup: older versions applied theme vars to the first .logsviewer-body (tabs)
    // which causes buttons/tabs to change colors. Clear those vars if present.
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

    // Theme preset (log panel only)
    logsviewer_applyThemePreset(logPanel, logsviewer_cfg.themePreset);

    // Background color override (only when preset is Default)
    // IMPORTANT: presets *also* set --logsviewer-log-bg. We must NOT remove that variable
    // when a non-default preset is selected, otherwise only border/scrollbar colors change.
    const preset = String(logsviewer_cfg.themePreset || 'default');
    const bgColor = String(logsviewer_cfg.bgColor || '').trim();
    if (preset === 'default') {
        // Always set explicitly to ensure consistent background across Dashboard/Tool pages.
        // Unraid's --bg-elevation-* variables differ between page contexts, so we can't rely
        // on CSS variable fallback chains for consistency.
        logPanel.style.setProperty('--logsviewer-log-bg', bgColor || '#1b1b1b');
    }

    // Backwards-compat cleanup (in case an older version set it globally)
    document.documentElement.style.removeProperty('--logsviewer-log-bg');

    // Font family
    // Apply to BOTH container and the actual pre element for immediate visible effect
    logsviewer_applyFontFamily(logPanel, logsviewer_cfg.fontFamily);
    const preElement = document.getElementById('logsviewer-logs');
    if (preElement) {
        logsviewer_applyFontFamily(preElement, logsviewer_cfg.fontFamily);
    }

    // Wrap / no-wrap
    if (logsviewer_cfg.wrapLines) {
        logPanel.style.setProperty('--logsviewer-white-space', 'pre-wrap');
        $(logsviewer_dom.container).removeClass('logsviewer-nowarp');
    } else {
        logPanel.style.setProperty('--logsviewer-white-space', 'pre');
        $(logsviewer_dom.container).addClass('logsviewer-nowarp');
    }

    // Show/hide UI pieces
    $('.logsviewer-badges')[logsviewer_cfg.showBadges ? 'show' : 'hide']();
    $('.logsviewer-title-meta')[logsviewer_cfg.showTotalLines ? 'show' : 'hide']();
    $('.logsviewer-timestamp-container')[logsviewer_cfg.showTimestamp ? 'show' : 'hide']();
    $('.logsviewer-filter')[logsviewer_cfg.showFilter ? 'show' : 'hide']();
    // Toast visibility is controlled by PHP (panel is not rendered when showToast=false)

    // Search UI (inject only if enabled)
    logsviewer_ensureSearchUi();

    // Restore last login toast (idle message) if any.
    logsviewer_restoreLoginToast();

    // Syntax highlighting (load library and setup dropdown if enabled)
    if (logsviewer_cfg.syntaxEnabled) {
        $('.logsviewer-syntax').show();
        logsviewer_loadHighlightJs(function() {
            logsviewer_setupSyntaxDropdown();
        });
    } else {
        $('.logsviewer-syntax').hide();
    }
}

// ---------------------------------------------------------------------------
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
        // Auto-scroll after refresh
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
    });
}

function logsviewer_showErrorToast(message) {
    // Create or update error toast
    let toast = $('#logsviewer-error-toast');
    if (!toast.length) {
        const container = $(logsviewer_dom.container);
        if (!container.length) return;
        
        toast = $('<div id="logsviewer-error-toast" class="logsviewer-error-toast" aria-live="assertive"></div>');
        container.prepend(toast);
    }
    
    toast.text(message).fadeIn(200);
    
    // Auto-hide after 3 seconds
    setTimeout(function() {
        toast.fadeOut(300);
    }, 3000);
}

// ---------------------------------------------------------------------------
function logsviewer_status() {
    var config = logsviewer_cfg || {};

    // Safe backoff
    if (config.refreshEnabled && config.refreshOnlyWhenRunning && Date.now() < logsviewer_pollBackoffUntil) {
        return;
    }

    var logContainer = $(logsviewer_dom.container);
    var scrollTarget = logContainer.length ? logContainer.get(0) : null;
    var autoscrollEnabled = $(logsviewer_dom.autoscroll).prop('checked');
    var allowAutoscroll = autoscrollEnabled && !(config.pauseOnHover && logsviewer_pauseHoverActive);

    logsviewer_fetchCategory(logsviewer_activeCategory, function(scripts) {
        // refresh-only-when-running backoff
        if (config.refreshOnlyWhenRunning) {
            var anyRunning = Array.isArray(scripts) ? scripts.some(function(s) { return s && s.status === 'running'; }) : false;
            if (!anyRunning) {
                var base = Number(config.refreshInterval || 0);
                var backoff = Math.max(base || 10000, 10000) * 4;
                logsviewer_pollBackoffUntil = Date.now() + backoff;
            } else {
                logsviewer_pollBackoffUntil = 0;
            }
        }

        // Auto-scroll: always snap to bottom when autoscroll is active
        if (allowAutoscroll && scrollTarget) {
            requestAnimationFrame(function() {
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
            });
        }
    });

    // -------------------------------------------------------------------
    // Background login detection (always from syslog)
    // -------------------------------------------------------------------
    // The login toast is an "idle" message and must be available even when
    // the user is browsing docker/nginx/etc. We therefore poll syslog in the
    // background and only use it for extracting the latest login event.
    try{
        logsviewer_fetchCategory('system', function(sysScripts){
            if (!Array.isArray(sysScripts) || !sysScripts.length) return;
            var sys = logsviewer_findLogData('system', 'syslog');
            if (sys && typeof sys.log === 'string' && sys.log.length) {
                logsviewer_checkLoginToast(sys.log);
            }
        }, { autoShow: false });
    }catch(_){ }
}

// ---------------------------------------------------------------------------
$(function() {
    logsviewer_cfg = window.logsviewerConfig || {};
    const config = logsviewer_cfg;

    const widgetRoot = $('.logsviewer-body');
    if (widgetRoot.length) {
        widgetRoot.toggleClass('logsviewer-body--responsive', !!config.isResponsive);
        widgetRoot.toggleClass('logsviewer-body--legacy', !config.isResponsive);
    }

    // Apply config (theme/bg/wrap/font/search/ui visibility)
    logsviewer_applyConfig();

    // Font size (existing behavior)
    if (config.fontSize) {
        const logContainer = $(logsviewer_dom.container);
        const logPre = $(logsviewer_dom.logs);
        if (logContainer.length) logContainer.css('font-size', config.fontSize);
        if (logPre.length) logPre.css('font-size', config.fontSize);
    }

    // Pause on hover (optional)
    if (config.pauseOnHover) {
        $(document).on('mouseenter', '#logsviewer-container', function(){ logsviewer_pauseHoverActive = true; });
        $(document).on('mouseleave', '#logsviewer-container', function(){ logsviewer_pauseHoverActive = false; });
    }

    // Compact view handling (existing)
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
        if (window.__logsviewerCompactInterval) { clearInterval(window.__logsviewerCompactInterval); }
        window.__logsviewerCompactInterval = setInterval(updateCompactVisibility, 500);
    }

    // Badge click to filter (existing)
    $(document).on('click', '.logsviewer-badge', function() {
        const filter = $(this).attr('data-filter');
        if (!filter) return;
        logsviewer_setFilterValue(filter);
    });

    $(document).on('keydown', '.logsviewer-badge', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    // Filter change -> rerender
    $(document).on('change', '#logsviewer-filter-select', function() {
        var logDisplay = $(logsviewer_dom.logs);
        if (!logsviewer_activeLogContent || !logDisplay.length) return;
        logsviewer_renderLog(logDisplay, logsviewer_activeLogContent, logsviewer_activeLogTotalLines);
    });

    // Auto-scroll checkbox change -> scroll and update label/state (existing)
    $(document).on('change', '#logsviewer-autoscroll', function() {
        const isOn = !!this.checked;
        logsviewer_applyAutoscrollUiState(isOn);

        try { localStorage.setItem(logsviewer_storageKey('logsviewer_autoscroll'), isOn ? '1' : '0'); } catch (_) {}

        if (!isOn) return;

        // Snap to bottom immediately when toggled ON (rAF ensures DOM is ready)
        const logContainer = $(logsviewer_dom.container);
        const scrollTarget = logContainer.length ? logContainer.get(0) : null;
        if (scrollTarget && !(config.pauseOnHover && logsviewer_pauseHoverActive)) {
            requestAnimationFrame(function() {
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
            });
        }
    });

    // Export button (existing)
    $(document).on('click', '#logsviewer-export-icon, [data-action="export-log"]', function(e) {
        e.preventDefault();
        logsviewer_exportCurrentLog();
    });

    // Manual refresh button
    $(document).on('click', '#logsviewer-manual-refresh', function(e) {
        e.preventDefault();
        logsviewer_manualRefresh();
    });

    // Init auto-scroll from localStorage (default uses config.autoscrollDefault)
    (function initAutoscrollState(){
        const cb = $(logsviewer_dom.autoscroll);
        if (!cb.length) return;

        let saved = null;
        try { saved = localStorage.getItem(logsviewer_storageKey('logsviewer_autoscroll')); } catch (_) {}

        const isOn = (saved === null) ? !!config.autoscrollDefault : (saved === '1');
        cb.prop('checked', isOn);
        logsviewer_applyAutoscrollUiState(isOn);
    })();

    // Persist user-resized log panel height (per-context: dashboard vs tool)
    (function initResizeMemory(){
        const container = document.getElementById('logsviewer-container');
        if (!container) return;

        // Determine context explicitly (don't rely solely on config)
        const ctx = (logsviewer_cfg && logsviewer_cfg.apiContext) || 
                    (window.location.pathname.indexOf('Tool') !== -1 ? 'tool' : 'dashboard');
        const storageKey = 'logsviewer_panel_height_' + ctx;

        // Context + viewport default heights
        const defaultHeight = (ctx === 'tool')
            ? (logsviewer_isMobileish() ? 200 : 400)
            : 300;

        // If settings page requested a reset, clear all height keys and consume flag
        try {
            if (localStorage.getItem('logsviewer_panel_height_reset') === '1') {
                localStorage.removeItem('logsviewer_panel_height_reset');
                for (var i = localStorage.length - 1; i >= 0; i--) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('logsviewer_panel_height') === 0) {
                        localStorage.removeItem(k);
                    }
                }
            }
        } catch(_) {}

        // Clear stale 600px saved values so old installs get the new default
        try {
            const saved = parseInt(localStorage.getItem(storageKey), 10);
            if (saved === 600) localStorage.removeItem(storageKey);
        } catch(_) {}

        // Restore saved height, or apply context default
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

        // Observe resize via ResizeObserver
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

        // Expose reset function for Settings page
        window.logsviewer_resetPanelHeight = function(context) {
            try {
                // Delete all height keys + set flag for cross-page reset
                for (var i = localStorage.length - 1; i >= 0; i--) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('logsviewer_panel_height') === 0) {
                        localStorage.removeItem(k);
                    }
                }
                localStorage.setItem('logsviewer_panel_height_reset', '1');
            } catch(_) {}
            // Apply immediately on current page
            resizeEnabled = false;
            clearTimeout(saveTimeout);
            const resetDefault = (ctx === 'tool') ? (logsviewer_isMobileish() ? 200 : 400) : 300;
            container.style.height = resetDefault + 'px';
            setTimeout(function() { resizeEnabled = true; }, 400);
        };
    })();

    // ═══════════ Category dropdown-tabs wiring ═══════════
(function initCategoryTabs() {

    // Use the existing reliable mobile detector (pointer:coarse + narrow viewport)
    function isMobile() {
        return typeof logsviewer_isMobileish === 'function'
            ? logsviewer_isMobileish()
            : window.matchMedia('(max-width:768px)').matches;
    }

    // Close all open category dropdowns
    function closeAllCatDropdowns() {
        $('.logsviewer-cat-dropdown').removeClass('logsviewer-cat-dropdown--open');
    }

    // Toggle custom dropdown for the given tab button (desktop only).
    function toggleCatDropdown($tabBtn) {
        var $drop = $tabBtn.find('.logsviewer-cat-dropdown');
        if (!$drop.length) return;
        var isOpen = $drop.hasClass('logsviewer-cat-dropdown--open');
        closeAllCatDropdowns();
        if (!isOpen) {
            $drop.addClass('logsviewer-cat-dropdown--open');
        }
    }

    // Load a log source by category + source name
    function loadSource(cat, sourceName) {
        logsviewer_activeCategory = cat;
        $('.logsviewer-cat-btn').removeClass('logsviewer-cat-btn--active');
        var $tabBtn = $('.logsviewer-cat-btn[data-category="' + cat + '"]');
        $tabBtn.attr('data-selected', sourceName).addClass('logsviewer-cat-btn--active');

        // Mark active item in dropdown (clears all others across all tabs)
        logsviewer_markActiveItem(cat, sourceName);

        // Mobile: set native select value for visual checkmark (iOS/Android picker)
        // Done in a setTimeout so iOS picker closes before value is set.
        // Other tabs' native selects are reset so their checkmark doesn't linger.
        (function(c, sn) {
            setTimeout(function() {
                $('.logsviewer-cat-native').each(function() {
                    var thisCat = $(this).closest('.logsviewer-cat-btn').attr('data-category');
                    try { this.value = (thisCat === c) ? sn : ''; } catch(_) {}
                });
            }, 50);
        })(cat, sourceName);

        // Show from cache immediately if available
        var entry = logsviewer_findLogData(cat, sourceName);
        if (entry) logsviewer_showLog(entry);

        // Always refresh from server
        logsviewer_fetchCategory(cat);
    }

    // ── Tab button click → desktop: toggle custom dropdown / mobile: native select handles it ──
    $(document).off('click.lvcattab', '.logsviewer-cat-btn');
    $(document).on('click.lvcattab', '.logsviewer-cat-btn', function(e) {
        if ($(e.target).closest('.logsviewer-cat-dropdown').length) return;
        if ($(e.target).is('select, option')) return;
        if (isMobile()) return;
        e.stopPropagation();
        toggleCatDropdown($(this));
    });

    // ── Custom dropdown item click → load that log (desktop) ──
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

    // ── Native select change → load that log (mobile) ──
    $(document).off('change.lvcatnative', '.logsviewer-cat-native');
    $(document).on('change.lvcatnative', '.logsviewer-cat-native', function(e) {
        var sourceName = this.value;
        if (!sourceName) return;
        var $tabBtn = $(this).closest('.logsviewer-cat-btn');
        var cat     = $tabBtn.attr('data-category');
        if (!cat) return;
        loadSource(cat, sourceName);
        // Reset to placeholder AFTER loadSource sets the correct value via the
        // loadSource → $('.logsviewer-cat-native').each() path below.
        // This happens asynchronously so the value is already set before reset.
    });


    // ── Click anywhere outside → close custom dropdowns ──
    $(document).off('click.lvcatoutside');
    $(document).on('click.lvcatoutside', function(e) {
        if (!$(e.target).closest('.logsviewer-cat-btn').length) {
            closeAllCatDropdowns();
        }
    });

})();

    // Initial fetch: system category (always), then docker/vm if enabled
    logsviewer_fetchCategory('system', function() {
        // Scroll to bottom on initial load if autoscroll is enabled
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

    if (config.refreshEnabled && config.refreshInterval > 0) {
        if (window.__logsviewerStatusInterval) { clearInterval(window.__logsviewerStatusInterval); }
        window.__logsviewerStatusInterval = setInterval(logsviewer_status, config.refreshInterval);
    }
});