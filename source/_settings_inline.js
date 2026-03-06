(function () {
      // ═══════════ Accordion logic ═══════════
      // Each panel: first lv-card expanded, rest collapsed
      function lvInitAccordions(panelId) {
        var panel = document.getElementById(panelId);
        if (!panel) return;
        // Only bind to TOP-LEVEL cards to avoid nested cards (e.g. Sources subsections)
        var cards = Array.prototype.filter.call(panel.children || [], function(el){
          return el && el.classList && el.classList.contains('lv-card');
        });
        cards.forEach(function(card, idx) {
          var hd = card.querySelector('.lv-card-hd');
          if (!hd) return;
          // Nested accordions use data-accordion; don't bind the generic toggler
          if (hd.hasAttribute('data-accordion')) return;
          // Collapse all except first
          if (idx > 0) card.classList.add('lv-collapsed');
          hd.addEventListener('click', function(e) {
            // Don't toggle if clicking a button/link inside header
            if (e.target.closest('button, a, input, select')) return;
            card.classList.toggle('lv-collapsed');
          });
        });
      }

      // Sub-accordion toggles (used inside Sources Dashboard/Tool cards)
      document.addEventListener('click', function(e){
        var hd = e.target.closest && e.target.closest('.lv-card-hd[data-accordion]');
        if (!hd) return;
        if (e.target.closest('button, a, input, select')) return;
        var sel = hd.getAttribute('data-accordion');
        if (!sel) return;
        var bd = document.querySelector(sel);
        if (!bd) return;
        var isHidden = (bd.style.display === 'none') || (window.getComputedStyle && window.getComputedStyle(bd).display === 'none');
        bd.style.display = isHidden ? '' : 'none';
      });

      // Init accordions for all 3 panels (Sources inits on first show)
      lvInitAccordions('lvDashboardPanel');
      lvInitAccordions('lvToolPanel');
      window.lvInitSourcesAccordion = function() { lvInitAccordions('lvDashboardPanel'); lvInitAccordions('lvToolPanel'); };


      // Color picker sync (picker <-> hex <-> hidden)
      function normalizeHex(v){
        v = (v || '').trim();
        if (!v) return '';
        if (v[0] !== '#') v = '#' + v;
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return '';
        if (v.length === 4){
          v = '#' + v[1]+v[1] + v[2]+v[2] + v[3]+v[3];
        }
        return v.toLowerCase();
      }

      const picker = document.getElementById('lvBgColorPicker');
      const hex = document.getElementById('lvBgColorHex');
      const hidden = document.getElementById('lvBgColorHidden');
      const preview = document.getElementById('lvBgPreview');

      if (picker && hex && hidden && preview){
        const form = (picker.closest && picker.closest('form')) || document.forms['scriptlogs_settings'] || document.querySelector('form');

        function forceEnableApply(){
          // Some Unraid/Dynamix pages don't track hidden fields as "dirty".
          // So on user-initiated color change we also force-enable Apply.
          const applyBtn = document.querySelector('input[name="#apply"], button[name="#apply"], #apply');
          if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.removeAttribute('disabled');
            applyBtn.classList.remove('disabled');
            applyBtn.setAttribute('aria-disabled', 'false');
            if (window.jQuery) {
              try { window.jQuery(applyBtn).prop('disabled', false).removeClass('disabled'); } catch (_) {}
            }
          }
          // And dispatch a generic change on the form as a fallback
          if (form) {
            try { form.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
          }
          if (typeof window.checkChanges === 'function') {
            try { window.checkChanges(); } catch (_) {}
          }
        }
        function applyColor(val, userInitiated){
          const normalized = normalizeHex(val);
          const display = normalized || '#0b0f14';

          // Update visible controls / preview
          picker.value = display;
          hex.value = display;
          preview.style.background = display;
          preview.style.borderColor = 'rgba(255,255,255,.14)';
          preview.style.color = 'rgba(255,255,255,.9)';

          // IMPORTANT:
          // - Only the hidden field submits (name="LOG_BG_COLOR").
          // - When there's no saved override, hidden should stay empty,
          //   otherwise "Reset to defaults" will still carry a color override.
          if (userInitiated) {
            hidden.value = display;

            // If user picks a manual background color while a Theme Preset is selected,
            // switch preset back to "default" so the manual color can take effect.
            const presetSel = document.querySelector('select[name="THEME_PRESET"]');
            if (presetSel && presetSel.value !== 'default') {
              presetSel.value = 'default';
              try {
                presetSel.dispatchEvent(new Event('input', { bubbles: true }));
                presetSel.dispatchEvent(new Event('change', { bubbles: true }));
              } catch (e) {}
            }

            try {
              hidden.dispatchEvent(new Event('input', { bubbles: true }));
              hidden.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
            if (typeof window.checkChanges === 'function') {
              try { window.checkChanges(); } catch (e) {}
            }
            forceEnableApply();
          } else {
            // Initial load/reset visual sync: keep empty overrides empty.
            if (!hidden.value) hidden.value = '';
          }
        }

        picker.addEventListener('input', () => applyColor(picker.value, true));
        hex.addEventListener('input', () => {
          const n = normalizeHex(hex.value);
          if (n) applyColor(n, true);
        });

        // Initial sync (do NOT mark dirty)
        applyColor(hidden.value || picker.value || '#0b0f14', false);
      }

      // TOOL TAB color picker handler (identical logic)
      const toolPicker = document.getElementById('lvToolBgColorPicker');
      const toolHex = document.getElementById('lvToolBgColorHex');
      const toolHidden = document.getElementById('lvToolBgColorHidden');
      const toolPreview = document.getElementById('lvToolBgPreview');

      if (toolPicker && toolHex && toolHidden){
        const form = (toolPicker.closest && toolPicker.closest('form')) || document.forms['scriptlogs_settings'] || document.querySelector('form');

        function forceEnableApplyTool(){
          const applyBtn = document.querySelector('input[name="#apply"], button[name="#apply"], #apply');
          if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.removeAttribute('disabled');
            applyBtn.classList.remove('disabled');
            applyBtn.setAttribute('aria-disabled', 'false');
            if (window.jQuery) {
              try { window.jQuery(applyBtn).prop('disabled', false).removeClass('disabled'); } catch (_) {}
            }
          }
          if (form) {
            try { form.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
          }
          if (typeof window.checkChanges === 'function') {
            try { window.checkChanges(); } catch (_) {}
          }
        }
        
        function applyColorTool(val, userInitiated){
          const normalized = normalizeHex(val);
          const display = normalized || '#1b1b1b';

          toolPicker.value = display;
          toolHex.value = display;
          if (toolPreview) {
            toolPreview.style.background = display;
            toolPreview.style.borderColor = 'rgba(255,255,255,.14)';
            toolPreview.style.color = 'rgba(255,255,255,.9)';
          }

          if (userInitiated) {
            toolHidden.value = display;

            const presetSel = document.querySelector('select[name="TOOL_THEME_PRESET"]');
            if (presetSel && presetSel.value !== 'default') {
              presetSel.value = 'default';
              try {
                presetSel.dispatchEvent(new Event('input', { bubbles: true }));
                presetSel.dispatchEvent(new Event('change', { bubbles: true }));
              } catch (e) {}
            }

            try {
              toolHidden.dispatchEvent(new Event('input', { bubbles: true }));
              toolHidden.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
            if (typeof window.checkChanges === 'function') {
              try { window.checkChanges(); } catch (e) {}
            }
            forceEnableApplyTool();
          } else {
            if (!toolHidden.value) toolHidden.value = '';
          }
        }

        toolPicker.addEventListener('input', () => applyColorTool(toolPicker.value, true));
        toolHex.addEventListener('input', () => {
          const n = normalizeHex(toolHex.value);
          if (n) applyColorTool(n, true);
        });

        // Initial sync
        applyColorTool(toolHidden.value || toolPicker.value || '#1b1b1b', false);
      }
    })();

    // FIX #2: Reset to Defaults functionality
    (function() {

      const resetBtn = document.getElementById('lvResetDefaults');
      if (!resetBtn) return;

      function enableApplyAndMarkDirty(form){
        // Unraid/Dynamix enables Apply when it detects a change event.
        // Our reset sets values programmatically, so we force-enable Apply
        // and dispatch events to trigger the built-in dirty tracking.
        const applyBtn = document.querySelector('input[name="#apply"], button[name="#apply"], #apply');
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.removeAttribute('disabled');
          applyBtn.classList.remove('disabled');
          // Some themes use aria-disabled
          applyBtn.setAttribute('aria-disabled', 'false');
          if (window.jQuery) {
            try { window.jQuery(applyBtn).prop('disabled', false).removeClass('disabled'); } catch (_) {}
          }
        }

        // Dispatch input/change events for Dynamix change detection.
        // IMPORTANT: Dynamix tracks changes on named form controls.
        // Some UI helpers (like the color picker/hex inputs) are *unnamed*
        // and only mirror into a named hidden input. Triggering events on the
        // unnamed helpers can cause unintended side effects.
        const fields = form.querySelectorAll('input, select, textarea');
        fields.forEach((el) => {
          // Skip submit/buttons
          if (el.type === 'submit' || el.type === 'button') return;
          // Only dispatch on named controls (the ones that actually submit)
          if (!el.getAttribute('name')) return;
          try {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_) {}
        });

        // If Dynamix exposes a change checker, ask it to re-evaluate
        if (typeof window.checkChanges === 'function') {
          try { window.checkChanges(); } catch (_) {}
        }
      }
      
      // Default values matching PHP defaults — Dashboard
      const dashDefaults = {
        REFRESH_ENABLED: '1',
        REFRESH_INTERVAL: '10',
        REFRESH_ONLY_WHEN_RUNNING: '0',
        ENABLED_SCRIPTS: ['syslog'],
        LOG_FONT_SIZE: '1rem',
        LOG_BG_COLOR: '',
        LOG_FONT_FAMILY: 'system',
        THEME_PRESET: 'default',
        HIGHLIGHT_ENABLED: '1',
        HIGHLIGHT_MODE: 'full',
        SYNTAX_HIGHLIGHTING: '0',
        SEARCH_ENABLED: '0',
        SEARCH_HIGHLIGHT: '0',
        AUTO_SCROLL_DEFAULT: '1',
        PAUSE_ON_HOVER: '0',
        TAIL_LINES: '0',
        SHOW_BADGES: '1',
        SHOW_TOTAL_LINES: '1',
        SHOW_TIMESTAMP: '1',
        SHOW_FILTER_DROPDOWN: '1',
        EXPORT_FORMAT: 'log',
        EXPORT_INCLUDE_TIMESTAMP: '1',
        VERSION_OVERRIDE: 'auto',

        // Independent Sources (Dashboard)
        DASH_ENABLED_SYSTEM_LOGS: 'syslog,dmesg,graphql-api.log,nginx-error',
        DASH_ENABLED_DOCKER_CONTAINERS: '',
        DASH_ENABLED_VMS: ''
      };

      // Default values matching PHP defaults — Tool (identical values, TOOL_ prefix)
      const toolDefaults = {
        TOOL_REFRESH_ENABLED: '1',
        TOOL_REFRESH_INTERVAL: '10',
        TOOL_REFRESH_ONLY_WHEN_RUNNING: '0',
        TOOL_ENABLED_SCRIPTS: ['syslog'],
        TOOL_LOG_FONT_SIZE: '1rem',
        TOOL_LOG_BG_COLOR: '',
        TOOL_LOG_FONT_FAMILY: 'system',
        TOOL_THEME_PRESET: 'default',
        TOOL_HIGHLIGHT_ENABLED: '1',
        TOOL_HIGHLIGHT_MODE: 'full',
        TOOL_SYNTAX_HIGHLIGHTING: '0',
        TOOL_SEARCH_ENABLED: '0',
        TOOL_SEARCH_HIGHLIGHT: '0',
        TOOL_AUTO_SCROLL_DEFAULT: '1',
        TOOL_PAUSE_ON_HOVER: '0',
        TOOL_TAIL_LINES: '0',
        TOOL_SHOW_BADGES: '1',
        TOOL_SHOW_TOTAL_LINES: '1',
        TOOL_SHOW_TIMESTAMP: '1',
        TOOL_SHOW_FILTER_DROPDOWN: '1',
        TOOL_EXPORT_FORMAT: 'log',
        TOOL_EXPORT_INCLUDE_TIMESTAMP: '1',

        // Independent Sources (Tool)
        TOOL_ENABLED_SYSTEM_LOGS: 'syslog,dmesg,graphql-api.log,nginx-error',
        TOOL_ENABLED_DOCKER_CONTAINERS: '',
        TOOL_ENABLED_VMS: ''
      };

      // Generic reset function for a given defaults map + color picker IDs + scripts counter ID
      function resetFieldsFromDefaults(form, defs, colorIds, scriptsName, counterEl) {
        Object.keys(defs).forEach(function(fieldName) {
          const value = defs[fieldName];

          // Handle ENABLED_SCRIPTS / TOOL_ENABLED_SCRIPTS checkboxes
          if (fieldName === 'ENABLED_SCRIPTS' || fieldName === 'TOOL_ENABLED_SCRIPTS') {
            const cbName = fieldName + '[]';
            const checkboxes = form.querySelectorAll('input[name="' + cbName + '"]');
            checkboxes.forEach(function(cb) { cb.checked = value.includes(cb.value); });
            if (counterEl) counterEl.textContent = value.length + ' selected';
            return;
          }

          // Checkbox
          const checkbox = form.querySelector('input[type="checkbox"][name="' + fieldName + '"]');
          if (checkbox) { checkbox.checked = (value === '1'); return; }

          // Select
          const select = form.querySelector('select[name="' + fieldName + '"]');
          if (select) { select.value = value; return; }

          // Text input
          const input = form.querySelector('input[type="text"][name="' + fieldName + '"]');
          if (input) { input.value = value; }

          // Hidden input
          const hidden = form.querySelector('input[type="hidden"][name="' + fieldName + '"]');
          if (hidden) { hidden.value = value; }
        });

        // Color picker sync
        if (colorIds) {
          const picker  = document.getElementById(colorIds.picker);
          const hex     = document.getElementById(colorIds.hex);
          const hidden  = document.getElementById(colorIds.hidden);
          const preview = document.getElementById(colorIds.preview);
          if (picker && hex && hidden && preview) {
            const defaultColor = colorIds.defaultColor || '#1b1b1b';
            picker.value = defaultColor;
            hex.value = defaultColor;
            hidden.value = '';
            preview.style.background = defaultColor;
            preview.style.borderColor = 'rgba(255,255,255,.14)';
            preview.style.color = 'rgba(255,255,255,.9)';
          }
        }
      }

      // Detect which tab is active
      function isToolTabActive() {
        const tabTool = document.getElementById('lvTabTool');
        return tabTool && tabTool.classList.contains('active');
      }

      resetBtn.addEventListener('click', function() {
        const form = document.querySelector('form[name="scriptlogs_settings"]');
        if (!form) return;

        if (isToolTabActive()) {
          // Reset ONLY Tool fields
          resetFieldsFromDefaults(form, toolDefaults,
            { picker: 'lvToolBgColorPicker', hex: 'lvToolBgColorHex', hidden: 'lvToolBgColorHidden', preview: 'lvToolBgPreview' },
            'TOOL_ENABLED_SCRIPTS',
            document.getElementById('lvToolSelectedCount')
          );

          // Refresh independent sources UI for Tool
          try { if (typeof lvLoadSourcesScoped === 'function') lvLoadSourcesScoped('Tool'); } catch (_) {}
        } else {
          // Reset ONLY Dashboard fields
          resetFieldsFromDefaults(form, dashDefaults,
            { picker: 'lvBgColorPicker', hex: 'lvBgColorHex', hidden: 'lvBgColorHidden', preview: 'lvBgPreview' },
            'ENABLED_SCRIPTS',
            document.getElementById('lvSelectedCount')
          );

          // Refresh independent sources UI for Dashboard
          try { if (typeof lvLoadSourcesScoped === 'function') lvLoadSourcesScoped('Dash'); } catch (_) {}
        }

        // Clear localStorage (autoscroll + per-context resized panel heights)
        try { localStorage.removeItem('logsviewer_autoscroll'); } catch (_) {}
        try { localStorage.removeItem('logsviewer_panel_height_dash'); } catch (_) {}
        try { localStorage.removeItem('logsviewer_panel_height_tool'); } catch (_) {}

        // Make sure Apply becomes clickable and Dynamix sees changes
        enableApplyAndMarkDirty(form);

        // Show friendly message
        alert(<?php echo json_encode(_('Settings have been reset to default values. Click "Apply" to save these changes.')); ?>);
      });

      // Top tabs: Dashboard vs Tool vs Sources
      (function(){
        const tabDash = document.getElementById('lvTabDashboard');
        const tabTool = document.getElementById('lvTabTool');
                const dashPanel = document.getElementById('lvDashboardPanel');
        const toolPanel = document.getElementById('lvToolPanel');
        		const resetDefaultsBtn = document.getElementById('lvResetDefaults');

        function setActive(which){
          tabDash.classList.toggle('active', which === 'dash');
          tabTool.classList.toggle('active', which === 'tool');
          dashPanel.style.display = (which === 'dash') ? '' : 'none';
          toolPanel.style.display = (which === 'tool') ? '' : 'none';
		  
		  // No Logs Source tab anymore — keep Reset visible for both Dashboard & Tool
          if (resetDefaultsBtn) resetDefaultsBtn.style.display = '';

          // Load independent sources for Dashboard/Tool on first visit
          if (which === 'dash' && !dashPanel._sourcesLoaded) {
            dashPanel._sourcesLoaded = true;
            lvLoadSourcesScoped('Dash');
          }
          if (which === 'tool' && !toolPanel._sourcesLoaded) {
            toolPanel._sourcesLoaded = true;
            lvLoadSourcesScoped('Tool');
          }

          // Persist active tab for POST survival + page reload
          try {
            sessionStorage.setItem('logsviewer_active_tab', which);
          } catch(e) {}
          var tabInput = document.getElementById('lvActiveTabInput');
          if (tabInput) tabInput.value = which;
        }

        function onKey(e, which){
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(which); }
        }

        if (tabDash) {
          tabDash.addEventListener('click', () => setActive('dash'));
          tabDash.addEventListener('keydown', (e)=>onKey(e,'dash'));
        }
        if (tabTool) {
          tabTool.addEventListener('click', () => setActive('tool'));
          tabTool.addEventListener('keydown', (e)=>onKey(e,'tool'));
        }
        
        // Restore tab state after page reload/Apply
        // PHP already rendered the correct panel visibility via $active_tab.
        // JS needs to sync its internal state (sessionStorage, source loading, etc.)
        try {
          var hash = (window.location.hash || '').replace('#', '');
          var postTab = (document.getElementById('lvActiveTabInput') || {}).value || 'dash';
          var savedTab = '';
          try { savedTab = sessionStorage.getItem('logsviewer_active_tab') || ''; } catch(e){}

          // Priority: URL hash > POST hidden input > sessionStorage > default
          var target = 'dash';
          if (hash === 'tool' || hash === 'dash' || hash === 'dashboard') {
            target = (hash === 'dashboard') ? 'dash' : hash;
          } else if (postTab === 'tool' || postTab === 'dash') {
            target = postTab;
          } else if (savedTab === 'tool' || savedTab === 'dash') {
            target = savedTab;
          }

          // Always call setActive to sync JS state (loads sources, sets sessionStorage etc.)
          setActive(target);
        } catch(e) {}
      })();

      // ═══════════ Tab Persistence: Ensure hidden input is set on form submit ═══════════
      (function(){
        var form = document.querySelector('form[name="scriptlogs_settings"]');
        if (!form) return;
        form.addEventListener('submit', function() {
          // Ensure the hidden input reflects current tab right before POST
          var tabInput = document.getElementById('lvActiveTabInput');
          if (!tabInput) return;
          var current = sessionStorage.getItem('logsviewer_active_tab') || 'dash';
          tabInput.value = current;
        });
      })();

      // ═══════════ Log Sources discovery ═══════════
      function lvFormatSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
      }

      function lvRenderSourceRow(key, name, extraInfo, size, checked, disabled, statusHtml) {
        var dis = disabled ? ' lv-source-disabled' : '';
        var chk = checked ? ' checked' : '';
        var disAttr = disabled ? ' disabled' : '';
        return '<div class="lv-source-row' + dis + '">' +
          '<input type="checkbox" class="lv-source-check" data-key="' + key + '"' + chk + disAttr + '>' +
          '<div><span class="lv-source-name">' + name + '</span>' +
            (extraInfo ? '<br><span class="lv-source-path">' + extraInfo + '</span>' : '') +
          '</div>' +
          (statusHtml || '') +
          '<span class="lv-source-size">' + lvFormatSize(size) + '</span>' +
        '</div>';
      }

      function lvLoadSources() {
        $.ajax({
          url: '/plugins/logsviewer/logsviewer_api.php',
          data: { action: 'discover_sources', _lvt: window.lvToken || '' },
          dataType: 'json',
          timeout: 15000,
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          success: function(data) {
            // ── System Logs ──
            var sysHtml = '';
            if (data.system && data.system.sources) {
              data.system.sources.forEach(function(s) {
                sysHtml += lvRenderSourceRow(
                  s.key, s.name, s.path, s.size,
                  s.enabled, !s.exists, ''
                );
              });
            }
            $('#lvSystemLogsList').html(sysHtml || '<div class="lv-sources-loading">No system logs found.</div>');
            // Show Select All/Deselect All for system logs
            if (sysHtml) {
              $('#lvSystemActions').css('display', 'flex');
            }

            // ── Docker ──
            if (data.docker && data.docker.available) {
              var dkHtml = '';
              if (data.docker.sources.length > 0) {
                data.docker.sources.forEach(function(c) {
                  var dotClass = (c.status === 'running') ? 'running' : (c.status === 'exited' ? 'exited' : 'stopped');
                  var statusHtml = '<span class="lv-source-status"><span class="lv-status-dot ' + dotClass + '"></span>' + c.status + '</span>';
                  dkHtml += lvRenderSourceRow(c.name, c.name, '', c.log_size, c.enabled, false, statusHtml);
                });
              } else {
                dkHtml = '<div class="lv-sources-loading">No Docker containers found.</div>';
              }
              $('#lvDockerActions').css('display', 'flex');
              $('#lvDockerLogsList').html(dkHtml);
              $('#lvDockerUnavailable').hide();
            } else {
              $('#lvDockerLogsList').empty();
              $('#lvDockerUnavailable').show();
              $('#lvDockerActions').hide();
            }

            // ── VMs ──
            if (data.vm && data.vm.available) {
              var vmHtml = '';
              if (data.vm.sources.length > 0) {
                data.vm.sources.forEach(function(v) {
                  var dotClass = (v.status === 'running') ? 'running' : 'shut';
                  var statusHtml = '<span class="lv-source-status"><span class="lv-status-dot ' + dotClass + '"></span>' + v.status + '</span>';
                  vmHtml += lvRenderSourceRow(v.name, v.name, v.log_path, v.log_size, v.enabled, false, statusHtml);
                });
              } else {
                vmHtml = '<div class="lv-sources-loading">No VMs found on this system.</div>';
                $('#lvVmUnavailable').show();
              }
              $('#lvVmLogsList').html(vmHtml);
              // Always show actions when VM is available (Scan always useful)
              $('#lvVmActions').css('display', 'flex');
            } else {
              $('#lvVmLogsList').empty();
              $('#lvVmUnavailable').show();
            }

            // Sync hidden inputs
            lvSyncSourceInputs();
          },
          error: function() {
            $('#lvSystemLogsList').html('<div class="lv-sources-loading" style="color:#e74c3c;">Failed to load sources.</div>');
          }
        });
      }



      // ── Independent Sources (Dashboard/Tool) ──
      function lvCsvToSet(csv) {
        var set = {};
        (csv || '').split(',').map(function(x){ return (x||'').trim(); }).filter(Boolean).forEach(function(k){ set[k]=true; });
        return set;
      }

      function lvSyncScopedInputs(scope) {
        var sys = [], docker = [], vms = [];
        $('#lv' + scope + 'SystemLogsList .lv-source-check:checked').each(function(){ sys.push($(this).data('key')); });
        $('#lv' + scope + 'DockerLogsList .lv-source-check:checked').each(function(){ docker.push($(this).data('key')); });
        $('#lv' + scope + 'VmLogsList .lv-source-check:checked').each(function(){ vms.push($(this).data('key')); });

        $('#lv' + scope + 'EnabledSystemLogs').val(sys.join(','));
        $('#lv' + scope + 'EnabledDockerContainers').val(docker.join(','));
        $('#lv' + scope + 'EnabledVms').val(vms.join(','));
      }

      function lvLoadSourcesScoped(scope, doneCb) {
        var sysSet = lvCsvToSet($('#lv' + scope + 'EnabledSystemLogs').val());
        var dkSet  = lvCsvToSet($('#lv' + scope + 'EnabledDockerContainers').val());
        var vmSet  = lvCsvToSet($('#lv' + scope + 'EnabledVms').val());

        $.ajax({
          url: '/plugins/logsviewer/logsviewer_api.php',
          data: { action: 'discover_sources', _lvt: window.lvToken || '' },
          dataType: 'json',
          timeout: 15000,
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          success: function(data) {
            // System
            var sysHtml = '';
            if (data.system && data.system.sources) {
              data.system.sources.forEach(function(s) {
                var checked = !!sysSet[s.key];
                sysHtml += lvRenderSourceRow(s.key, s.name, s.path, s.size, checked, !s.exists, '');
              });
            }
            $('#lv' + scope + 'SystemLogsList').html(sysHtml || '<div class="lv-sources-loading">No system logs found.</div>');
            if (sysHtml) $('#lv' + scope + 'SystemActions').css('display','flex');

            // Docker
            if (data.docker && data.docker.available) {
              var dkHtml = '';
              if (data.docker.sources.length > 0) {
                data.docker.sources.forEach(function(c){
                  var dotClass = (c.status === 'running') ? 'running' : (c.status === 'exited' ? 'exited' : 'stopped');
                  var statusHtml = '<span class="lv-source-status"><span class="lv-status-dot ' + dotClass + '"></span>' + c.status + '</span>';
                  var checked = !!dkSet[c.name];
                  dkHtml += lvRenderSourceRow(c.name, c.name, '', c.log_size, checked, false, statusHtml);
                });
              } else {
                dkHtml = '<div class="lv-sources-loading">No Docker containers found.</div>';
              }
              $('#lv' + scope + 'DockerActions').css('display','flex');
              $('#lv' + scope + 'DockerLogsList').html(dkHtml);
              $('#lv' + scope + 'DockerUnavailable').hide();
            } else {
              $('#lv' + scope + 'DockerLogsList').empty();
              $('#lv' + scope + 'DockerUnavailable').show();
              $('#lv' + scope + 'DockerActions').hide();
            }

            // VMs
            if (data.vm && data.vm.available) {
              var vmHtml = '';
              if (data.vm.sources.length > 0) {
                data.vm.sources.forEach(function(v){
                  var dotClass = (v.status === 'running') ? 'running' : 'shut';
                  var statusHtml = '<span class="lv-source-status"><span class="lv-status-dot ' + dotClass + '"></span>' + v.status + '</span>';
                  var checked = !!vmSet[v.name];
                  vmHtml += lvRenderSourceRow(v.name, v.name, v.log_path, v.log_size, checked, false, statusHtml);
                });
              } else {
                vmHtml = '<div class="lv-sources-loading">No VMs found on this system.</div>';
                $('#lv' + scope + 'VmUnavailable').show();
              }
              $('#lv' + scope + 'VmLogsList').html(vmHtml);
              $('#lv' + scope + 'VmActions').css('display','flex');
            } else {
              $('#lv' + scope + 'VmLogsList').empty();
              $('#lv' + scope + 'VmUnavailable').show();
            }

            lvSyncScopedInputs(scope);
            if (typeof doneCb === 'function') doneCb();
          },
          error: function(){
            $('#lv' + scope + 'SystemLogsList').html('<div class="lv-sources-loading" style="color:#e74c3c;">Failed to load sources.</div>');
            if (typeof doneCb === 'function') doneCb();
          }
        });
      }
      function lvSyncSourceInputs() {
        var sys = [], docker = [], vms = [];
        $('#lvSystemLogsList .lv-source-check:checked').each(function() { sys.push($(this).data('key')); });
        $('#lvDockerLogsList .lv-source-check:checked').each(function() { docker.push($(this).data('key')); });
        $('#lvVmLogsList .lv-source-check:checked').each(function() { vms.push($(this).data('key')); });

        $('#lvEnabledSystemLogs').val(sys.join(','));
        $('#lvEnabledDockerContainers').val(docker.join(','));
        $('#lvEnabledVms').val(vms.join(','));
      }

      // Delegate checkbox changes
      $(document).on('change', '.lv-source-check', function() {
        lvSyncSourceInputs();
        // Mark form as dirty so Apply button activates
        var form = document.forms['scriptlogs_settings'];
        if (form && typeof enableApplyAndMarkDirty === 'function') {
          enableApplyAndMarkDirty(form);
        }
      });

      // Independent (Dashboard) checkbox changes
      $(document).on('change', '#lvDashSystemLogsList .lv-source-check, #lvDashDockerLogsList .lv-source-check, #lvDashVmLogsList .lv-source-check', function() {
        lvSyncScopedInputs('Dash');
        var form = document.forms['scriptlogs_settings'];
        if (form && typeof enableApplyAndMarkDirty === 'function') enableApplyAndMarkDirty(form);
      });

      // Independent (Tool) checkbox changes
      $(document).on('change', '#lvToolSystemLogsList .lv-source-check, #lvToolDockerLogsList .lv-source-check, #lvToolVmLogsList .lv-source-check', function() {
        lvSyncScopedInputs('Tool');
        var form = document.forms['scriptlogs_settings'];
        if (form && typeof enableApplyAndMarkDirty === 'function') enableApplyAndMarkDirty(form);
      });

      // Dashboard Sources: Select All / Deselect All / Scan
      $('#lvDashDockerSelectAll').on('click', function(){ $('#lvDashDockerLogsList .lv-source-check').prop('checked', true); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashDockerDeselectAll').on('click', function(){ $('#lvDashDockerLogsList .lv-source-check').prop('checked', false); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashSystemSelectAll').on('click', function(){ $('#lvDashSystemLogsList .lv-source-check:not(:disabled)').prop('checked', true); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashSystemDeselectAll').on('click', function(){ $('#lvDashSystemLogsList .lv-source-check:not(:disabled)').prop('checked', false); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashVmSelectAll').on('click', function(){ $('#lvDashVmLogsList .lv-source-check:not(:disabled)').prop('checked', true); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashVmDeselectAll').on('click', function(){ $('#lvDashVmLogsList .lv-source-check:not(:disabled)').prop('checked', false); lvSyncScopedInputs('Dash'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvDashDockerScan').on('click', function(){
        var $ico = $(this).find('i.fa');
        var started = Date.now();
        $ico.addClass('fa-spin');
        lvLoadSourcesScoped('Dash', function(){
          var wait = Math.max(0, 400 - (Date.now() - started));
          setTimeout(function(){ $ico.removeClass('fa-spin'); }, wait);
        });
      });
      $('#lvDashVmScan').on('click', function(){
        var $ico = $(this).find('i.fa');
        var started = Date.now();
        $ico.addClass('fa-spin');
        lvLoadSourcesScoped('Dash', function(){
          var wait = Math.max(0, 400 - (Date.now() - started));
          setTimeout(function(){ $ico.removeClass('fa-spin'); }, wait);
        });
      });

      // Tool Sources: Select All / Deselect All / Scan
      $('#lvToolDockerSelectAll').on('click', function(){ $('#lvToolDockerLogsList .lv-source-check').prop('checked', true); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolDockerDeselectAll').on('click', function(){ $('#lvToolDockerLogsList .lv-source-check').prop('checked', false); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolSystemSelectAll').on('click', function(){ $('#lvToolSystemLogsList .lv-source-check:not(:disabled)').prop('checked', true); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolSystemDeselectAll').on('click', function(){ $('#lvToolSystemLogsList .lv-source-check:not(:disabled)').prop('checked', false); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolVmSelectAll').on('click', function(){ $('#lvToolVmLogsList .lv-source-check:not(:disabled)').prop('checked', true); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolVmDeselectAll').on('click', function(){ $('#lvToolVmLogsList .lv-source-check:not(:disabled)').prop('checked', false); lvSyncScopedInputs('Tool'); var f=document.forms['scriptlogs_settings']; if(f) enableApplyAndMarkDirty(f); });
      $('#lvToolDockerScan').on('click', function(){
        var $ico = $(this).find('i.fa');
        var started = Date.now();
        $ico.addClass('fa-spin');
        lvLoadSourcesScoped('Tool', function(){
          var wait = Math.max(0, 400 - (Date.now() - started));
          setTimeout(function(){ $ico.removeClass('fa-spin'); }, wait);
        });
      });
      $('#lvToolVmScan').on('click', function(){
        var $ico = $(this).find('i.fa');
        var started = Date.now();
        $ico.addClass('fa-spin');
        lvLoadSourcesScoped('Tool', function(){
          var wait = Math.max(0, 400 - (Date.now() - started));
          setTimeout(function(){ $ico.removeClass('fa-spin'); }, wait);
        });
      });

// Docker Select All / Deselect All
      $('#lvDockerSelectAll').on('click', function() {
        $('#lvDockerLogsList .lv-source-check').prop('checked', true);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });
      $('#lvDockerDeselectAll').on('click', function() {
        $('#lvDockerLogsList .lv-source-check').prop('checked', false);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });

      // System Logs Select All / Deselect All
      $('#lvSystemSelectAll').on('click', function() {
        $('#lvSystemLogsList .lv-source-check:not(:disabled)').prop('checked', true);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });
      $('#lvSystemDeselectAll').on('click', function() {
        $('#lvSystemLogsList .lv-source-check:not(:disabled)').prop('checked', false);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });

      // VM Logs Select All / Deselect All
      $('#lvVmSelectAll').on('click', function() {
        $('#lvVmLogsList .lv-source-check:not(:disabled)').prop('checked', true);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });
      $('#lvVmDeselectAll').on('click', function() {
        $('#lvVmLogsList .lv-source-check:not(:disabled)').prop('checked', false);
        lvSyncSourceInputs();
        var form = document.forms['scriptlogs_settings'];
        if (form) enableApplyAndMarkDirty(form);
      });

      // Scan buttons (re-run discovery)
      $('#lvDockerScan, #lvVmScan').on('click', function() {
        $(this).find('.fa-refresh').addClass('fa-spin');
        var btn = $(this);
        lvLoadSources();
        setTimeout(function() { btn.find('.fa-refresh').removeClass('fa-spin'); }, 1000);
      });

      // Credits popup - square dialog with OK button
      (function(){
        const link = document.getElementById('lvCreditsLink');
        if (!link) return;
        link.addEventListener('click', function(e){
          e.preventDefault();
          if (window.jQuery && jQuery.fn && typeof jQuery.fn.dialog === 'function') {
            jQuery('#lvCreditsDialog').dialog({
              modal: true,
              width: 620,
              height: 'auto',
              minHeight: 520,
              resizable: false,
              draggable: false,
              dialogClass: 'lv-credits-dialog',
              buttons: [
                {
                  text: 'OK',
                  class: 'lv-ok-btn',
                  click: function() {
                    jQuery(this).dialog('close');
                  }
                }
              ],
              open: function() {
			    // Force remove titlebar/close button
                jQuery(this).closest('.ui-dialog').find('.ui-dialog-titlebar').remove();
				// Force portrait dimensions (override Dynamix CSS)
                var $dlg = jQuery(this).closest('.ui-dialog');
                $dlg.css({
                  'width': '620px',
                  'max-width': '92vw',
                  'min-width': '0',
                  'left': '50%',
                  'right': 'auto',
                  'margin-left': '0',
                  'transform': 'translateX(-50%)'
                });
                // Center OK button inside dialog
                $dlg.find('.ui-dialog-buttonpane').css({
                  'text-align': 'center',
                  'border-top': '1px solid rgba(255,255,255,0.1)',
                  'padding': '0.75rem 0 1.25rem'
                });
                $dlg.find('.ui-dialog-buttonset').css('float', 'none');				
                // Click outside to close
                jQuery('.ui-widget-overlay').on('click', function() {
                  jQuery('#lvCreditsDialog').dialog('close');
                });
                // Fun stat: count lines of code
                var el = document.getElementById('lvCreditsLineCount');
                if (el && !el.textContent) {
                  var lines = document.documentElement.outerHTML.split('\n').length;
                  el.textContent = lines + ' Lines of code and counting!';
                }
              }
            });
          } else {
            // Fallback
            alert('Credits');
          }
        });
      })();
    })();
  