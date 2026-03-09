/**
 * Tocic – content.js (v6.0)
 *
 * New in v6:
 *   - Bot responses scanned for h1/h2/h3 headings
 *   - Headings shown as indented sub-items under each query row
 *   - Active heading highlighted as user scrolls through the response
 *   - Heading list collapses when another query becomes active
 */

(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────
  var adapter       = null;
  var pairs         = [];
  var activeIndex   = -1;
  var activeHeading = null;   // { pairIdx, headingEl }
  var collapsed     = false;
  var settingsOpen  = false;
  var ioObserver    = null;
  var moObserver    = null;
  var root          = null;
  var listEl        = null;
  var countEl       = null;
  var initialized   = false;
  var rebuildTimer  = null;
  var renderedItems = {};     // pairIndex → { text, botEl, userEl, headingEls[] }

  var DRAG_THRESHOLD = 4;

  // ── Adapter selection ───────────────────────────────────────────────────────
  function pickAdapter() {
    if (!window.TocicAdapters) return null;
    for (var i = 0; i < window.TocicAdapters.length; i++) {
      if (window.TocicAdapters[i].matches()) return window.TocicAdapters[i];
    }
    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function truncate(text, max) {
    max = max || 72;
    text = (text || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max).trimRight() + '\u2026' : text;
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Extract h1/h2/h3 elements from a bot response element.
  // Returns array of { el, level (1|2|3), text }
  function extractHeadings(botEl) {
    if (!botEl) return [];

    var elements;
    if (botEl._isDocSection) {
      // Custom URL adapter: botEl is a proxy wrapping live DOM heading elements.
      // querySelectorAll() returns the actual elements directly — no clones.
      elements = Array.from(botEl.querySelectorAll());
    } else {
      elements = Array.from(botEl.querySelectorAll('h1, h2, h3'));
    }

    var raw = elements.map(function (el) {
      return {
        el:    el,
        level: parseInt(el.tagName[1], 10),
        text:  (el.innerText || el.textContent || '').trim()
      };
    }).filter(function (h) { return h.text.length > 0; });

    if (adapter && typeof adapter.filterHeading === 'function') {
      raw = raw.filter(adapter.filterHeading);
    }

    if (raw.length === 0) return [];

    // Promote headings so the shallowest level in this section becomes level 1.
    // e.g. if only h2/h3 are present, h2→effectiveLevel 1, h3→effectiveLevel 2.
    var minLevel = raw.reduce(function (m, h) { return Math.min(m, h.level); }, 4);
    var shift = minLevel - 1;

    raw.forEach(function (h) {
      h.effectiveLevel = h.level - shift;
    });

    return raw;
  }

  // ── Widget construction ─────────────────────────────────────────────────────
  function buildWidget() {
    if (root) root.remove();

    var S = window.TocicSettings;
    var siteLabel = adapter ? (adapter.getLabel ? adapter.getLabel() : adapter.id) : 'Chat';
    root = document.createElement('div');
    root.id = 'tocic-root';
    if (collapsed) root.classList.add('collapsed');

    // Use the shared builder from settings.js, excluding 'enabled' which lives
    // in the popup toolbar rather than the in-widget settings panel.
    var controlsHtml = S.buildSettingsControlsHtml(['enabled']);

    root.innerHTML =
      '<button id="tocic-toggle" title="Toggle query navigator">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3 4h10M3 8h7M3 12h4"/>' +
          '<path d="M12 10l2 2-2 2" stroke-width="1.5"/>' +
        '</svg>' +
      '</button>' +

      '<div id="tocic-panel" role="navigation" aria-label="Query navigator">' +
        '<div id="tocic-header">' +
          '<span id="tocic-drag-handle" title="Drag to reposition">' +
            '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" width="12" height="12">' +
              '<circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/>' +
              '<circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/>' +
              '<circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/>' +
            '</svg>' +
          '</span>' +
          '<svg class="tn-logo" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
              'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="10" cy="10" r="8"/>' +
            '<path d="M7 7h6M7 10h4M7 13h5"/>' +
          '</svg>' +
          '<button id="tocic-settings-btn" title="Settings" aria-label="Open settings">' +
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
                'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<circle cx="8" cy="8" r="2.5"/>' +
              '<path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15' +
                'M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06' +
                'M2.93 13.07l1.06-1.06M12.01 3.99l1.06-1.06"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +

        '<div id="tocic-settings-panel">' +
          '<div class="tn-settings-title">Settings</div>' +
          '<div class="tn-settings-controls">' + controlsHtml + '</div>' +
          '<div class="tn-settings-footer">' +
            '<button id="tocic-reset-btn">Reset to defaults</button>' +
          '</div>' +
          '<div class="tn-settings-title tn-urls-title">Custom URL patterns</div>' +
          '<div id="tocic-url-list"></div>' +
          '<div class="tn-url-add-row">' +
            '<input id="tocic-url-input" type="text" placeholder="regex, e.g. https://x\.com/.+/article/\\d+" spellcheck="false">' +
            '<input id="tocic-url-label" type="text" placeholder="label (optional)">' +
            '<button id="tocic-url-add">Add</button>' +
          '</div>' +
          '<div class="tn-settings-title tn-hotkeys-title">Hotkeys</div>' +
          '<div class="tn-hotkeys-list">' +
            '<div class="tn-hotkey-row">' +
              '<span class="tn-hotkey-label">Toggle widget</span>' +
              '<input class="tn-hotkey-input" data-action="toggleWidget" type="text" placeholder="click to record">' +
            '</div>' +
            '<div class="tn-hotkey-row">' +
              '<span class="tn-hotkey-label">Add page &amp; enable</span>' +
              '<input class="tn-hotkey-input" data-action="addAndEnable" type="text" placeholder="click to record">' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div id="tocic-list-wrap">' +
          '<ul id="tocic-list"></ul>' +
          '<p id="tocic-empty">No content found yet.</p>' +
        '</div>' +

        '<div id="tocic-footer"></div>' +

        '<div class="tn-resize-handle" data-corner="bl" title="Drag to resize"></div>' +
        '<div class="tn-resize-handle" data-corner="br" title="Drag to resize"></div>' +
      '</div>';

    document.body.appendChild(root);
    listEl  = root.querySelector('#tocic-list');

    S.applyToDOM(root);
    applyPersistedGeometry();

    // Toggle: fires only if mousedown didn't become a drag
    root.querySelector('#tocic-toggle').addEventListener('click', function (e) {
      if (e._tocic_wasDrag) return;
      togglePanel();
    });
    root.querySelector('#tocic-settings-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleSettings();
    });

    wireSettingControls();
    wireDrag();
    wireResize();
    wireResetButton();
    wireUrlPatterns();
    wireHotkeyInputs();
  }

  // ── Settings controls ───────────────────────────────────────────────────────
  function wireSettingControls() {
    var S = window.TocicSettings;
    root.querySelectorAll('[data-setting]').forEach(function (control) {
      var key = control.dataset.setting;
      var def = S.DEFINITIONS[key];
      if (!def) return;

      if (control.type === 'checkbox') {
        // toggle type
        control.addEventListener('change', function () {
          S.set(key, control.checked);
          S.applyToDOM(root);
        });
      } else if (control.type === 'range') {
        control.addEventListener('input', function () {
          var val = Number(control.value);
          var valEl = root.querySelector('[data-for="' + key + '"]');
          if (valEl) valEl.textContent = val + (def.unit || '');
          S.set(key, val);
          S.applyToDOM(root);
        });
        control.addEventListener('change', function () {
          S.set(key, Number(control.value));
          S.applyToDOM(root);
        });
      } else if (control.type === 'color') {
        control.addEventListener('input', function () {
          S.set(key, control.value);
          S.applyToDOM(root);
        });
        control.addEventListener('change', function () {
          S.set(key, control.value);
          S.applyToDOM(root);
        });
      } else {
        control.addEventListener('change', function () {
          var val = control.value;
          S.set(key, val);
          S.applyToDOM(root);
          if (key === 'side') snapToEdge(val);
        });
      }
    });
  }

  // ── Snap to edge ────────────────────────────────────────────────────────────
  function wireResetButton() {
    var btn = root.querySelector('#tocic-reset-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var S = window.TocicSettings;
      S.resetAll();
      // Re-load from storage (now empty) to repopulate cache with defaults
      S.loadAll().then(function () {
        S.applyToDOM(root);
        // Sync every control back to its default value
        root.querySelectorAll('[data-setting]').forEach(function (control) {
          var key = control.dataset.setting;
          var val = S.get(key);
          if (control.type === 'range') {
            control.value = val;
            var valEl = root.querySelector('[data-for="' + key + '"]');
            var def   = S.DEFINITIONS[key];
            if (valEl) valEl.textContent = val + (def.unit || '');
          } else {
            control.value = val;
          }
        });
        // Clear inline position/size overrides so CSS defaults take over
        root.style.left   = '';
        root.style.right  = '';
        root.style.top    = '';
        root.style.bottom = '';
        root.style.width  = '';
        var panel = root.querySelector('#tocic-panel');
        if (panel) {
          panel.style.width  = '';
          panel.style.height = '';
          panel.style.flex   = '';
        }
      });
    });
  }

  // ── Custom URL pattern manager ─────────────────────────────────────────────
  function renderUrlList() {
    var S    = window.TocicSettings;
    var list = root.querySelector('#tocic-url-list');
    if (!list) return;
    var urls = S.getCustomUrls();
    if (urls.length === 0) {
      list.innerHTML = '<div class="tn-url-empty">No patterns yet.</div>';
      return;
    }
    list.innerHTML = urls.map(function (entry, i) {
      return '<div class="tn-url-row" data-idx="' + i + '">' +
        '<div class="tn-url-info">' +
          '<span class="tn-url-pattern">' + escapeHtml(entry.pattern) + '</span>' +
          (entry.label ? '<span class="tn-url-label-tag">' + escapeHtml(entry.label) + '</span>' : '') +
        '</div>' +
        '<button class="tn-url-remove" data-idx="' + i + '" title="Remove">×</button>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.tn-url-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx  = Number(btn.dataset.idx);
        var urls = S.getCustomUrls();
        urls.splice(idx, 1);
        S.setCustomUrls(urls);
        renderUrlList();
      });
    });

    list.querySelectorAll('.tn-url-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.classList.contains('tn-url-remove')) return;
        var idx   = Number(row.dataset.idx);
        var urls  = S.getCustomUrls();
        var entry = urls[idx];
        openUrlEditor(list, row, idx, entry.pattern, entry.label || '');
      });
    });
  }

  function openUrlEditor(list, row, idx, currentPattern, currentLabel) {
    var S = window.TocicSettings;
    // Replace the row content with edit inputs in-place
    row.classList.add('tn-url-row--editing');
    row.innerHTML =
      '<div class="tn-url-edit">' +
        '<input class="tn-url-edit-pattern" type="text" value="' + escapeHtml(currentPattern) + '" spellcheck="false">' +
        '<input class="tn-url-edit-label" type="text" value="' + escapeHtml(currentLabel) + '" placeholder="label (optional)">' +
        '<div class="tn-url-edit-actions">' +
          '<button class="tn-url-save" title="Save">✓</button>' +
          '<button class="tn-url-cancel" title="Cancel">✕</button>' +
        '</div>' +
      '</div>';

    var patternInput = row.querySelector('.tn-url-edit-pattern');
    var labelInput   = row.querySelector('.tn-url-edit-label');
    var saveBtn      = row.querySelector('.tn-url-save');
    var cancelBtn    = row.querySelector('.tn-url-cancel');

    // Focus pattern input and select all
    patternInput.focus();
    patternInput.select();

    function save() {
      var pattern = patternInput.value.trim();
      if (!pattern) return;
      try { new RegExp(pattern); }
      catch(e) {
        patternInput.style.borderColor = 'var(--tn-accent)';
        setTimeout(function () { patternInput.style.borderColor = ''; }, 1500);
        return;
      }
      var urls = S.getCustomUrls();
      urls[idx] = { pattern: pattern, label: labelInput.value.trim() };
      S.setCustomUrls(urls);
      renderUrlList();
    }

    function cancel() { renderUrlList(); }

    saveBtn.addEventListener('click', function (e) { e.stopPropagation(); save(); });
    cancelBtn.addEventListener('click', function (e) { e.stopPropagation(); cancel(); });

    patternInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
    labelInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
  }

  function wireUrlPatterns() {
    var S      = window.TocicSettings;
    var addBtn = root.querySelector('#tocic-url-add');
    var input  = root.querySelector('#tocic-url-input');
    var label  = root.querySelector('#tocic-url-label');
    if (!addBtn || !input) return;

    renderUrlList();

    addBtn.addEventListener('click', function () {
      var pattern = input.value.trim();
      if (!pattern) return;

      // Validate regex before saving
      try { new RegExp(pattern); }
      catch(e) {
        input.style.borderColor = 'red';
        input.title = 'Invalid regex: ' + e.message;
        setTimeout(function () {
          input.style.borderColor = '';
          input.title = '';
        }, 2000);
        return;
      }

      var urls = S.getCustomUrls();
      urls.push({ pattern: pattern, label: label.value.trim() });
      S.setCustomUrls(urls);
      input.value = '';
      label.value = '';
      renderUrlList();
    });

    // Allow Enter key in the pattern input to add
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });
  }

  // ── Hotkey input recorder ────────────────────────────────────────────────────
  function comboFromEvent(e) {
    var parts = [];
    if (e.ctrlKey  || e.metaKey) parts.push('Ctrl');
    if (e.altKey)                 parts.push('Alt');
    if (e.shiftKey)               parts.push('Shift');

    // Use e.code (physical key, layout-independent) so that modifier combos
    // like Option+Shift+E don't produce the Unicode character the OS generates
    // (e.g. "`") but always show the labelled key ("E").
    // e.code values: "KeyE" → "E", "Digit3" → "3", "Space" → "Space", etc.
    var k;
    if (e.code) {
      if (/^Key([A-Z])$/.test(e.code)) {
        k = e.code.slice(3);                   // "KeyE" → "E"
      } else if (/^Digit(\d)$/.test(e.code)) {
        k = e.code.slice(5);                   // "Digit3" → "3"
      } else if (/^Numpad(.+)$/.test(e.code)) {
        k = 'Num' + e.code.slice(6);           // "Numpad0" → "Num0"
      } else if (/^F(\d+)$/.test(e.code)) {
        k = e.code;                            // "F12" → "F12"
      } else {
        // Arrow, Space, Backquote, Minus, etc. — use e.key as display label
        // but only if it's a single printable char; otherwise use e.code
        k = (e.key && e.key.length === 1) ? e.key.toUpperCase() : e.code;
      }
    } else {
      // Fallback for browsers without e.code
      k = e.key;
    }

    // Ignore bare modifier keypresses
    if (['Control','Alt','Shift','Meta'].indexOf(k) !== -1) return null;
    if (['Control','Alt','Shift','Meta'].indexOf(e.key) !== -1) return null;

    parts.push(k);
    return parts.join('+');
  }

  function wireHotkeyInputs() {
    var S = window.TocicSettings;
    var hotkeys = S.getHotkeys();
    root.querySelectorAll('.tn-hotkey-input').forEach(function (input) {
      var action = input.dataset.action;
      input.value = hotkeys[action] || '';

      // Block all text-mutation events — this is a recorder, not a text field
      ['keypress', 'keyup', 'input', 'paste', 'cut'].forEach(function (ev) {
        input.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); });
      });

      input.addEventListener('focus', function () {
        input.value = '';
        input.placeholder = 'press combo\u2026';
      });

      input.addEventListener('keydown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Backspace') {
          S.setHotkey(action, null);
          input.value = '';
          input.placeholder = 'click to record';
          input.blur();
          return;
        }
        var combo = comboFromEvent(e);
        if (!combo) return;
        S.setHotkey(action, combo);
        input.value = combo;
        input.placeholder = 'click to record';
        input.blur();
      });

      input.addEventListener('blur', function () {
        var saved = S.getHotkeys()[action] || '';
        input.value = saved;
        if (!saved) input.placeholder = 'click to record';
      });
    });
  }

  function snapToEdge(side) {
    var S = window.TocicSettings;
    var geo = S.getGeometry();
    S.setGeometry({ x: null, y: geo.y, width: geo.width, height: geo.height });
    root.style.left  = '';
    root.style.right = '';
    if (geo.y === null) root.style.top = '';
  }

  // ── Geometry persistence ────────────────────────────────────────────────────
  function applyPersistedGeometry() {
    var S = window.TocicSettings;
    var geo = S.getGeometry();
    var panel = root.querySelector('#tocic-panel');

    if (geo.x !== null) { root.style.left = geo.x + 'px'; root.style.right = 'auto'; }
    if (geo.y !== null) { root.style.top  = geo.y + 'px'; root.style.bottom = 'auto'; }
    if (geo.width !== null) {
      root.style.width = geo.width + 'px';
      if (panel) panel.style.width = geo.width + 'px';
    }
    if (geo.height !== null && panel) {
      panel.style.height = geo.height + 'px';
      panel.style.flex   = 'none';
    }
  }

  // ── Drag ────────────────────────────────────────────────────────────────────
  var currentDragSide = null;

  function wireDrag() {
    var dragTargets = [
      root.querySelector('#tocic-drag-handle'),
      root.querySelector('#tocic-toggle'),
      root.querySelector('#tocic-header')
    ].filter(Boolean);

    var startX, startY, startLeft, startTop;
    var dragging = false;
    var didDrag  = false;

    dragTargets.forEach(function (handle) {
      handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        var rect  = root.getBoundingClientRect();
        startLeft = rect.left;
        startTop  = rect.top;
        startX    = e.clientX;
        startY    = e.clientY;
        dragging  = true;
        didDrag   = false;
        root.style.left   = startLeft + 'px';
        root.style.top    = startTop  + 'px';
        root.style.right  = 'auto';
        root.style.bottom = 'auto';
        document.body.style.userSelect = 'none';
      });
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;

      if (!didDrag && Math.sqrt(dx*dx + dy*dy) > DRAG_THRESHOLD) {
        didDrag = true;
        currentDragSide = window.TocicSettings.get('side');
        root.classList.add('tn-dragging');
      }
      if (!didDrag) return;

      var newLeft = Math.max(0, Math.min(window.innerWidth  - root.offsetWidth,  startLeft + dx));
      var newTop  = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, startTop  + dy));
      root.style.left = newLeft + 'px';
      root.style.top  = newTop  + 'px';

      var snapZone = Math.max(root.offsetWidth, Math.round(window.innerWidth * 0.25));
      var newSide  = newLeft < snapZone
        ? 'left'
        : newLeft + root.offsetWidth > window.innerWidth - snapZone
          ? 'right'
          : currentDragSide;

      if (newSide !== currentDragSide) {
        currentDragSide = newSide;
        var S = window.TocicSettings;
        S.set('side', newSide);
        S.applyToDOM(root);
        var sel = root.querySelector('select[data-setting="side"]');
        if (sel) sel.value = newSide;
      }
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      root.classList.remove('tn-dragging');
      document.body.style.userSelect = '';
      if (didDrag) {
        window.TocicSettings.setGeometry({
          x: parseFloat(root.style.left),
          y: parseFloat(root.style.top)
        });
        document.addEventListener('click', function suppressClick(ev) {
          ev._tocic_wasDrag = true;
          document.removeEventListener('click', suppressClick, true);
        }, true);
      }
      didDrag = false;
    });
  }

  // ── Resize ───────────────────────────────────────────────────────────────────
  function wireResize() {
    var panel = root.querySelector('#tocic-panel');
    if (!panel) return;

    root.querySelectorAll('.tn-resize-handle').forEach(function (handle) {
      var corner = handle.dataset.corner;
      var startX, startY, startW, startH, startLeft;
      var resizing = false;

      handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        resizing  = true;
        startX    = e.clientX;
        startY    = e.clientY;
        startW    = panel.offsetWidth;
        startH    = panel.offsetHeight;
        startLeft = parseFloat(root.style.left) || root.getBoundingClientRect().left;
        root.classList.add('tn-resizing');
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', function (e) {
        if (!resizing) return;
        var dx   = e.clientX - startX;
        var dy   = e.clientY - startY;
        var newH = Math.max(150, Math.min(window.innerHeight - 80, startH + dy));
        var newW, newLeft;

        if (corner === 'br') {
          newW = Math.max(180, Math.min(600, startW + dx));
          panel.style.width = newW + 'px';
          root.style.width  = newW + 'px';
        } else {
          newW    = Math.max(180, Math.min(600, startW - dx));
          newLeft = Math.max(0, startLeft + dx);
          panel.style.width = newW + 'px';
          root.style.width  = newW + 'px';
          root.style.left   = newLeft + 'px';
          root.style.right  = 'auto';
        }
        panel.style.height = newH + 'px';
        panel.style.flex   = 'none';
      });

      document.addEventListener('mouseup', function () {
        if (!resizing) return;
        resizing = false;
        root.classList.remove('tn-resizing');
        document.body.style.userSelect = '';
        var geo = { width: panel.offsetWidth, height: panel.offsetHeight };
        if (corner === 'bl') geo.x = parseFloat(root.style.left);
        window.TocicSettings.setGeometry(geo);
      });
    });
  }

  // ── Toggle ──────────────────────────────────────────────────────────────────
  function togglePanel() {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
    if (collapsed && settingsOpen) { settingsOpen = false; root.classList.remove('settings-open'); }
  }

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    root.classList.toggle('settings-open', settingsOpen);
  }

  // ── Populate TOC (diffing) ──────────────────────────────────────────────────
  function populateTOC() {
    if (!root || !adapter) return;

    try { pairs = adapter.pairs(); }
    catch (e) { console.warn('[Tocic] adapter.pairs() threw:', e); pairs = []; }

    var emptyEl = root.querySelector('#tocic-empty');

    if (pairs.length === 0) {
      emptyEl.style.display = '';
      listEl.innerHTML = '';
      renderedItems = {};
      return;
    }

    emptyEl.style.display = 'none';

    // Pass 1: add new / update changed items
    pairs.forEach(function (pair, i) {
      var existing = renderedItems[i];
      var headings = extractHeadings(pair.botEl);

      if (!existing) {
        var li = createItem(i, pair, headings);
        listEl.appendChild(li);
        renderedItems[i] = { text: pair.text, botEl: pair.botEl, userEl: pair.userEl, headings: headings };

      } else {
        var li = listEl.querySelector('.tn-item[data-index="' + i + '"]');
        if (!li) return;

        if (existing.text !== pair.text) {
          var textEl = li.querySelector('.tn-text');
          if (textEl) textEl.textContent = truncate(pair.text);
          li.title = pair.text;
          existing.text = pair.text;
        }

        if (existing.botEl !== pair.botEl) {
          attachClick(li, i, pair.botEl, pair.userEl);
          existing.botEl  = pair.botEl;
          existing.userEl = pair.userEl;
        }

        // Rebuild heading sub-list if headings changed (count or identity)
        var existingIds = existing.headings.map(function (h) { return h.el; });
        var newIds      = headings.map(function (h) { return h.el; });
        var headingsChanged = existingIds.length !== newIds.length ||
          existingIds.some(function (el, k) { return el !== newIds[k]; });

        if (headingsChanged) {
          rebuildHeadings(li, i, headings);
          existing.headings = headings;
        }
      }
    });

    // Pass 2: remove stale items
    Object.keys(renderedItems).forEach(function (key) {
      var idx = Number(key);
      if (idx >= pairs.length) {
        var stale = listEl.querySelector('.tn-item[data-index="' + idx + '"]');
        if (stale) stale.remove();
        delete renderedItems[idx];
      }
    });

    setupIntersectionObserver();
    if (activeIndex >= pairs.length) activeIndex = -1;
    if (activeIndex >= 0) setActive(activeIndex, false);
  }

  // ── Build a heading sub-list <ul> inside a query <li> ─────────────────────
  function buildHeadingList(pairIdx, headings) {
    if (!headings || headings.length === 0) return null;
    var ul = document.createElement('ul');
    ul.className = 'tn-heading-list';

    headings.forEach(function (h, hi) {
      var hLi = document.createElement('li');
      // tn-hl{1|2|3} = effective (promoted) level used for indentation
      hLi.className = 'tn-heading tn-hl' + (h.effectiveLevel || h.level);
      hLi.dataset.pairIndex    = String(pairIdx);
      hLi.dataset.headingIndex = String(hi);
      hLi.title = h.text;
      hLi.innerHTML = '<span class="tn-heading-text">' + escapeHtml(truncate(h.text, 60)) + '</span>';
      hLi.addEventListener('click', function (e) {
        e.stopPropagation();
        h.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActive(pairIdx, false);
        setActiveHeading(pairIdx, hi);
      });
      ul.appendChild(hLi);
    });

    return ul;
  }

  function rebuildHeadings(li, pairIdx, headings) {
    var old = li.querySelector('.tn-heading-list');
    if (old) old.remove();
    var ul = buildHeadingList(pairIdx, headings);
    if (ul) li.appendChild(ul);
  }

  // ── Create a query row <li> ─────────────────────────────────────────────────
  function createItem(i, pair, headings) {
    var li = document.createElement('li');
    li.className = 'tn-item';
    li.dataset.index = String(i);
    li.title = pair.text;
    li.innerHTML =
      '<div class="tn-item-row">' +
          '<span class="tn-text">' + escapeHtml(truncate(pair.text)) + '</span>' +
      '</div>';

    (function (idx, botEl, userEl) {
      li.addEventListener('click', function () {
        var target = botEl || userEl;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActive(idx, true);
        if (settingsOpen) toggleSettings();
      });
    })(i, pair.botEl, pair.userEl);

    var ul = buildHeadingList(i, headings);
    if (ul) li.appendChild(ul);

    return li;
  }

  function attachClick(li, idx, botEl, userEl) {
    var fresh = li.cloneNode(true);
    fresh.addEventListener('click', function () {
      var target = botEl || userEl;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(idx, true);
      if (settingsOpen) toggleSettings();
    });
    // Re-wire heading clicks after clone (cloneNode copies DOM but not listeners)
    var cached = renderedItems[idx];
    if (cached && cached.headings) {
      fresh.querySelectorAll('.tn-heading').forEach(function (hLi) {
        var hi = Number(hLi.dataset.headingIndex);
        var h  = cached.headings[hi];
        if (!h) return;
        hLi.addEventListener('click', function (e) {
          e.stopPropagation();
          h.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setActive(idx, false);
          setActiveHeading(idx, hi);
        });
      });
    }
    li.parentNode.replaceChild(fresh, li);
    return fresh;
  }

  // ── Active state ─────────────────────────────────────────────────────────────
  function setActive(index, _unused) {
    var changed = index !== activeIndex;
    activeIndex   = index;
    activeHeading = null;

    listEl.querySelectorAll('.tn-item').forEach(function (li, i) {
      li.classList.toggle('active', i === index);
      var ul = li.querySelector('.tn-heading-list');
      if (ul) ul.classList.toggle('tn-expanded', i === index);
      if (i !== index) {
        li.querySelectorAll('.tn-heading').forEach(function (h) {
          h.classList.remove('active');
        });
      }
    });

    // Scroll the widget's own list container to bring the active item into view.
    // We use manual scrollTop arithmetic instead of scrollIntoView() because
    // scrollIntoView() walks up to the nearest scrollable ancestor and may
    // also scroll the page — here we want to scroll only #tocic-list-wrap.
    if (changed) {
      var wrap = root.querySelector('#tocic-list-wrap');
      var activeLi = listEl.querySelector('.tn-item[data-index="' + index + '"]');
      if (wrap && activeLi) {
        // Use getBoundingClientRect so positions are in the same coordinate space
        // regardless of offset-parent chains inside the widget DOM.
        var itemRect = activeLi.getBoundingClientRect();
        var wrapRect = wrap.getBoundingClientRect();
        var itemTop    = itemRect.top  - wrapRect.top  + wrap.scrollTop;
        var itemBottom = itemRect.bottom - wrapRect.top + wrap.scrollTop;
        var wrapTop    = wrap.scrollTop;
        var wrapBottom = wrapTop + wrap.clientHeight;
        if (itemTop < wrapTop) {
          wrap.scrollTop = itemTop;
        } else if (itemBottom > wrapBottom) {
          wrap.scrollTop = itemBottom - wrap.clientHeight;
        }
      }
    }
  }

  function setActiveHeading(pairIdx, headingIdx) {
    activeHeading = { pairIdx: pairIdx, headingIdx: headingIdx };
    listEl.querySelectorAll('.tn-heading').forEach(function (hLi) {
      var matches = Number(hLi.dataset.pairIndex)    === pairIdx &&
                    Number(hLi.dataset.headingIndex) === headingIdx;
      hLi.classList.toggle('active', matches);
    });
  }

  // ── Intersection observer ───────────────────────────────────────────────────
  // Tracks both bot response containers AND individual headings within them.
  function setupIntersectionObserver() {
    if (ioObserver) ioObserver.disconnect();

    // Build a flat list of all observable elements with their type + index info
    var targets = [];
    pairs.forEach(function (p, i) {
      var el = p.botEl || p.userEl;
      if (el) targets.push({ el: el, type: 'pair', pairIdx: i });

      var cached = renderedItems[i];
      if (cached && cached.headings) {
        cached.headings.forEach(function (h, hi) {
          targets.push({ el: h.el, type: 'heading', pairIdx: i, headingIdx: hi });
        });
      }
    });

    if (targets.length === 0) return;

    var elToTarget = new Map(targets.map(function (t) { return [t.el, t]; }));
    var visibleTops = new Map();

    ioObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          visibleTops.set(entry.target, entry.boundingClientRect.top);
        } else {
          visibleTops.delete(entry.target);
        }
      });

      if (visibleTops.size === 0) return;

      // Find the element whose top edge is nearest the top of the viewport
      var best = null, bestDist = Infinity;
      visibleTops.forEach(function (top, el) {
        var dist = Math.abs(top);
        if (dist < bestDist) { bestDist = dist; best = el; }
      });
      if (!best) return;

      var t = elToTarget.get(best);
      if (!t) return;

      if (t.type === 'pair') {
        if (t.pairIdx !== activeIndex) setActive(t.pairIdx, false);
      } else if (t.type === 'heading') {
        // Switch to the parent query if needed, then highlight the heading
        if (t.pairIdx !== activeIndex) setActive(t.pairIdx, false);
        setActiveHeading(t.pairIdx, t.headingIdx);
      }
    }, {
      root: null,
      threshold: [0, 0.05, 0.1, 0.25, 0.5],
      rootMargin: '-5% 0px -5% 0px'
    });

    targets.forEach(function (t) { ioObserver.observe(t.el); });
  }

  // ── Mutation observer ───────────────────────────────────────────────────────
  function setupMutationObserver() {
    if (moObserver) moObserver.disconnect();
    moObserver = new MutationObserver(function () {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(populateTOC, 600);
    });
    moObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init / teardown ─────────────────────────────────────────────────────────
  function init() {
    if (initialized) return;
    initialized = true;
    window.TocicSettings.loadAll().then(function () {
      var S = window.TocicSettings;
      adapter = pickAdapter();
      var adapterMatched = !!adapter;

      if (!S.isEnabledForPage(adapterMatched)) {
        // Disabled for this page (natural default or user override) — inject nothing.
        initialized = false;
        return;
      }

      if (!adapterMatched) {
        buildWidget();
        var emptyEl = root && root.querySelector('#tocic-empty');
        if (emptyEl) emptyEl.textContent = 'No content detected on this page.';
        return;
      }

      console.log('[Tocic] Using adapter:', adapter.id);
      buildWidget();
      populateTOC();
      setupMutationObserver();
    });
  }

  function teardown() {
    if (ioObserver) { ioObserver.disconnect(); ioObserver = null; }
    if (moObserver) { moObserver.disconnect(); moObserver = null; }
    if (root) { root.remove(); root = null; }
    pairs = []; activeIndex = -1; activeHeading = null;
    initialized = false; adapter = null; settingsOpen = false; renderedItems = {};
  }

  // ── Single persistent hotkey listener ────────────────────────────────────────
  // Registered once at module load. Reads hotkeys from the in-memory cache
  // (populated by loadAll) so it never fires before settings are ready.
  // Works on all pages regardless of whether the widget has initialised.
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.activeElement && document.activeElement.isContentEditable) return;
    if (!window.TocicSettings) return;

    var S = window.TocicSettings;
    var hotkeys = S.getHotkeys();
    var combo = comboFromEvent(e);
    if (!combo) return;

    if (hotkeys.toggleWidget && combo === hotkeys.toggleWidget) {
      e.preventDefault();
      if (root) togglePanel();
      return;
    }

    if (hotkeys.addAndEnable && combo === hotkeys.addAndEnable) {
      e.preventDefault();
      var escapedUrl = location.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var urls = S.getCustomUrls();
      var already = urls.some(function (u) { return u.pattern === escapedUrl; });
      if (!already) {
        urls.push({ pattern: escapedUrl, label: document.title || location.hostname });
        S.setCustomUrls(urls);
      }
      S.setSiteOverride(location.hostname, true);
      if (!initialized) {
        teardown();
        setTimeout(init, 100);
      }
    }
  }, true);

  if (document.readyState === 'complete') {
    setTimeout(init, 1200);
  } else {
    window.addEventListener('load', function () { setTimeout(init, 1200); });
  }

  // ── Runtime message listener (from popup) ──────────────────────────────────
  // The popup sends messages when the user toggles enabled or changes settings,
  // so the content script can react without a page reload.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.source !== 'tocic-popup') return;

      if (msg.type === 'enabled-changed') {
        // msg.value: true = force on, false = force off, null = restore natural default
        window.TocicSettings.setSiteOverride(location.hostname, msg.value);
        if (msg.value === false) {
          teardown();
        } else {
          // true or null — re-evaluate. Teardown first so init() runs clean.
          teardown();
          setTimeout(init, 100);
        }
      } else if (msg.type === 'hotkeys-changed') {
        // Update the in-memory cache immediately so the keydown listener
        // picks up the new bindings without needing a page reload.
        var S = window.TocicSettings;
        if (msg.hotkeys) {
          S.HOTKEY_ACTIONS.forEach(function (action) {
            S.setHotkey(action, msg.hotkeys[action] || null);
          });
        }
        // Also re-sync any visible hotkey inputs in the widget panel
        if (root) {
          var hotkeys = S.getHotkeys();
          root.querySelectorAll('.tn-hotkey-input').forEach(function (input) {
            input.value = hotkeys[input.dataset.action] || '';
          });
        }
      } else if (msg.type === 'settings-changed') {
        if (root) {
          var S = window.TocicSettings;
          S.loadAll().then(function () {
            S.applyToDOM(root);
            root.querySelectorAll('[data-setting]').forEach(function (control) {
              var key = control.dataset.setting;
              var val = S.get(key);
              if (control.type === 'checkbox') {
                control.checked = !!val;
              } else if (control.type === 'range') {
                control.value = val;
                var valEl = root.querySelector('[data-for="' + key + '"]');
                var def = S.DEFINITIONS[key];
                if (valEl) valEl.textContent = val + (def.unit || '');
              } else {
                control.value = val;
              }
            });
          });
        }
      }
    });
  }

  var lastUrl = location.href;
  new MutationObserver(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      teardown();
      setTimeout(init, 1500);
    }
  }).observe(document, { subtree: true, childList: true });

})();
