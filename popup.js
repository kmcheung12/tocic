/**
 * Tocic – popup.js
 */

(function () {
  'use strict';

  var S = window.TocicSettings;

  // ── Notify active tab ───────────────────────────────────────────────────────
  function notify(msg) {
    msg.source = 'tocic-popup';
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, function () {
        void chrome.runtime.lastError;
      });
    });
  }

  // ── Wire a single settings control ─────────────────────────────────────────
  function wireControl(control) {
    var key = control.dataset.setting;
    var def = S.DEFINITIONS[key];
    if (!def) return;

    if (control.type === 'checkbox') {
      control.addEventListener('change', function () {
        S.set(key, control.checked);
        S.applyToDOM(document.body);
        notify({ type: 'settings-changed' });
      });
    } else if (control.type === 'range') {
      control.addEventListener('input', function () {
        var val = Number(control.value);
        var valEl = document.querySelector('[data-for="' + key + '"]');
        if (valEl) valEl.textContent = val + (def.unit || '');
        S.set(key, val);
        S.applyToDOM(document.body);
        notify({ type: 'settings-changed' });
      });
    } else if (control.type === 'color') {
      control.addEventListener('input', function () {
        S.set(key, control.value);
        S.applyToDOM(document.body);
        notify({ type: 'settings-changed' });
      });
      control.addEventListener('change', function () {
        S.set(key, control.value);
        S.applyToDOM(document.body);
        notify({ type: 'settings-changed' });
      });
    } else {
      control.addEventListener('change', function () {
        S.set(key, control.value);
        S.applyToDOM(document.body);
        notify({ type: 'settings-changed' });
      });
    }
  }

  function esc(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── URL pattern list ────────────────────────────────────────────────────────
  function renderUrlList() {
    var list = document.getElementById('popup-url-list');
    if (!list) return;
    var urls = S.getCustomUrls();
    if (urls.length === 0) {
      list.innerHTML = '<div class="tn-url-empty">No patterns yet.</div>';
      return;
    }
    list.innerHTML = urls.map(function (entry, i) {
      return '<div class="tn-url-row" data-idx="' + i + '">' +
        '<div class="tn-url-info">' +
          '<span class="tn-url-pattern">' + esc(entry.pattern) + '</span>' +
          (entry.label ? '<span class="tn-url-label-tag">' + esc(entry.label) + '</span>' : '') +
        '</div>' +
        '<button class="tn-url-remove" data-idx="' + i + '" title="Remove">\u00d7</button>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.tn-url-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var urls = S.getCustomUrls();
        urls.splice(Number(btn.dataset.idx), 1);
        S.setCustomUrls(urls);
        renderUrlList();
        notify({ type: 'settings-changed' });
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
    row.classList.add('tn-url-row--editing');
    row.innerHTML =
      '<div class="tn-url-edit">' +
        '<input class="tn-url-edit-pattern" type="text" value="' + esc(currentPattern) + '" spellcheck="false">' +
        '<input class="tn-url-edit-label" type="text" value="' + esc(currentLabel) + '" placeholder="label (optional)">' +
        '<div class="tn-url-edit-actions">' +
          '<button class="tn-url-save" title="Save">\u2713</button>' +
          '<button class="tn-url-cancel" title="Cancel">\u2715</button>' +
        '</div>' +
      '</div>';

    var patternInput = row.querySelector('.tn-url-edit-pattern');
    var labelInput   = row.querySelector('.tn-url-edit-label');
    var saveBtn      = row.querySelector('.tn-url-save');
    var cancelBtn    = row.querySelector('.tn-url-cancel');

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
      notify({ type: 'settings-changed' });
      renderUrlList();
    }

    function cancel() { renderUrlList(); }

    saveBtn.addEventListener('click', function (e) { e.stopPropagation(); save(); });
    cancelBtn.addEventListener('click', function (e) { e.stopPropagation(); cancel(); });

    patternInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
    labelInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
  }

  function renderControls() {
    var el = document.getElementById('popup-controls');
    if (!el) return;
    el.innerHTML = S.buildSettingsControlsHtml([]);
    el.querySelectorAll('[data-setting]').forEach(wireControl);
  }

  // ── Hotkey recorder ─────────────────────────────────────────────────────────
  function comboFromEvent(e) {
    var parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey)                parts.push('Alt');
    if (e.shiftKey)              parts.push('Shift');

    var k;
    if (e.code) {
      if (/^Key([A-Z])$/.test(e.code)) {
        k = e.code.slice(3);
      } else if (/^Digit(\d)$/.test(e.code)) {
        k = e.code.slice(5);
      } else if (/^Numpad(.+)$/.test(e.code)) {
        k = 'Num' + e.code.slice(6);
      } else if (/^F(\d+)$/.test(e.code)) {
        k = e.code;
      } else {
        k = (e.key && e.key.length === 1) ? e.key.toUpperCase() : e.code;
      }
    } else {
      k = e.key;
    }

    if (['Control','Alt','Shift','Meta'].indexOf(k) !== -1) return null;
    if (['Control','Alt','Shift','Meta'].indexOf(e.key) !== -1) return null;

    parts.push(k);
    return parts.join('+');
  }

  function wireHotkeyInputs() {
    var hotkeys = S.getHotkeys();
    document.querySelectorAll('.tn-hotkey-input').forEach(function (input) {
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
          notify({ type: 'hotkeys-changed', hotkeys: S.getHotkeys() });
          return;
        }
        var combo = comboFromEvent(e);
        if (!combo) return;
        S.setHotkey(action, combo);
        input.value = combo;
        input.placeholder = 'click to record';
        input.blur();
        notify({ type: 'hotkeys-changed', hotkeys: S.getHotkeys() });
      });

      input.addEventListener('blur', function () {
        var saved = S.getHotkeys()[action] || '';
        input.value = saved;
        if (!saved) input.placeholder = 'click to record';
      });
    });
  }

  // ── Natural-page detection (mirrors adapter match logic) ────────────────────
  function isNaturalPage(url) {
    if (!url) return false;
    try {
      var u = new URL(url);
      var h = u.hostname;
      var p = u.pathname;
      if (h === 'claude.ai'         && /^\/chat\//.test(p))  return true;
      if (h === 'grok.com'          && /^\/c\//.test(p))     return true;
      if (h === 'chatgpt.com'       && /^\/c\//.test(p))     return true;
      if (h === 'chat.openai.com'   && /^\/c\//.test(p))     return true;
      if (h === 'gemini.google.com' && /^\/app/.test(p))     return true;
      if (S.matchCustomUrl(url)) return true;
    } catch(e) {}
    return false;
  }

  // ── Main init ───────────────────────────────────────────────────────────────
  S.loadAll().then(function () {
    S.applyToDOM(document.body);

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab      = tabs && tabs[0];
      var tabUrl   = tab ? tab.url : '';
      var hostname = '';
      try { hostname = new URL(tabUrl).hostname; } catch(e) {}

      var natural   = isNaturalPage(tabUrl);
      var override  = S.getSiteOverride(hostname);
      var effective = (override !== null) ? override : natural;

      // ── Enabled toggle ────────────────────────────────────────────────────
      var toggle     = document.getElementById('popup-enabled-toggle');
      var toggleHint = document.getElementById('popup-toggle-hint');
      toggle.checked = effective;

      function updateHint() {
        if (override === null) {
          toggleHint.textContent = natural ? 'Active on this page by default'
                                           : 'Inactive on this page by default';
          toggleHint.dataset.state = 'natural';
        } else {
          toggleHint.textContent = toggle.checked
            ? 'Forced on for ' + (hostname || 'this page')
            : 'Forced off for ' + (hostname || 'this page');
          toggleHint.dataset.state = 'override';
        }
      }
      updateHint();

      toggle.addEventListener('change', function () {
        var val = toggle.checked;
        var newOverride = (val === natural) ? null : val;
        S.setSiteOverride(hostname, newOverride);
        override = newOverride;
        updateHint();
        notify({ type: 'enabled-changed', value: newOverride });
      });

      // ── Settings controls ──────────────────────────────────────────────────
      renderControls();

      // ── Hotkeys ───────────────────────────────────────────────────────────
      wireHotkeyInputs();

      // ── Reset button ──────────────────────────────────────────────────────
      document.getElementById('popup-reset-btn').addEventListener('click', function () {
        S.resetAll();
        S.loadAll().then(function () {
          S.applyToDOM(document.body);
          renderControls();
          wireHotkeyInputs();
          notify({ type: 'settings-changed' });
        });
      });

      // ── URL patterns ──────────────────────────────────────────────────────
      var urlInput  = document.getElementById('popup-url-input');
      var urlLabel  = document.getElementById('popup-url-label');
      var urlAddBtn = document.getElementById('popup-url-add');

      renderUrlList();

      function addPattern() {
        var pattern = urlInput.value.trim();
        if (!pattern) return;
        try { new RegExp(pattern); }
        catch (e) {
          urlInput.style.borderColor = 'var(--tn-accent)';
          setTimeout(function () { urlInput.style.borderColor = ''; }, 2000);
          return;
        }
        var urls = S.getCustomUrls();
        urls.push({ pattern: pattern, label: urlLabel.value.trim() });
        S.setCustomUrls(urls);
        urlInput.value = '';
        urlLabel.value = '';
        renderUrlList();
        notify({ type: 'settings-changed' });
      }

      urlAddBtn.addEventListener('click', addPattern);
      urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addPattern(); }
      });
    });
  });

})();
