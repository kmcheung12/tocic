/**
 * Tocic – settings.js
 *
 * Single source of truth for all user-configurable settings AND widget geometry.
 *
 * Storage: browser.storage.local — extension-scoped, shared across all sites
 * (claude.ai, grok.com, etc.) and across tabs. This replaces the old
 * localStorage approach which was sandboxed per origin.
 *
 * API design: synchronous-looking surface backed by an in-memory cache.
 * The cache is populated once at startup via loadAll() (async). After that,
 * get/set/getGeometry/setGeometry are all synchronous cache reads/writes;
 * writes fire-and-forget the async storage.local.set in the background.
 * This means no call-site changes are needed in content.js.
 *
 * Call TocicSettings.loadAll().then(callback) before using any other method.
 *
 * ── Adding a new setting ────────────────────────────────────────────────────
 * 1. Add an entry to DEFINITIONS.
 * 2. If it needs a CSS effect, add one style.setProperty() call in applyToDOM().
 * 3. The settings panel UI generates itself — no HTML changes needed.
 * ────────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  var SETTINGS_KEY      = 'tocic_settings_v1';
  var GEOMETRY_KEY      = 'tocic_geometry_v1';
  var CUSTOM_URLS_KEY   = 'tocic_custom_urls_v1';
  var SITE_OVERRIDES_KEY = 'tocic_site_overrides_v1';
  var HOTKEYS_KEY        = 'tocic_hotkeys_v1';

  // ── Setting definitions ─────────────────────────────────────────────────────
  var DEFINITIONS = {
    side: {
      type: 'select',
      label: 'Position',
      default: 'right',
      options: [
        { value: 'right', label: 'Right' },
        { value: 'left',  label: 'Left'  }
      ]
    },
    fontSize: {
      type: 'range',
      label: 'Font size',
      default: 12,
      min: 10,
      max: 18,
      step: 1,
      unit: 'px'
    },
    fontColor: {
      type: 'color',
      label: 'Text color',
      default: '#aaaaaa'
    },
    bgColor: {
      type: 'color',
      label: 'Background',
      default: '#0f0f0f'
    },
    accentColor: {
      type: 'color',
      label: 'Accent color',
      default: '#cccccc'
    },
    settingsFontSize: {
      type: 'range',
      label: 'Settings font size',
      default: 11,
      min: 9,
      max: 16,
      step: 1,
      unit: 'px'
    },
    settingsFontColor: {
      type: 'color',
      label: 'Settings text color',
      default: '#666666'
    }
  };

  // ── In-memory cache ─────────────────────────────────────────────────────────
  var _settings     = {};   // keyed by setting key
  var _pageDefaults = {};   // detected from host page, used when user has no saved value
  var _geometry     = { x: null, y: null, width: null, height: null };
  var _customUrls    = [];   // Array<{ pattern: string, label: string }>
  var _siteOverrides = {};   // { hostname: true|false } — user per-site overrides
  var _hotkeys       = {};   // { toggleWidget: string|null, addAndEnable: string|null }

  // ── Storage helpers ─────────────────────────────────────────────────────────
  // Priority: browser.storage.local (Firefox) → chrome.storage.local (Chrome)
  // → localStorage fallback (dev/unsupported environments).
  //
  // chrome.storage uses callbacks rather than Promises; we wrap it so the
  // rest of the code can always use .then() uniformly.

  function storageGet(key) {
    // Firefox (browser.storage — native Promise API)
    if (typeof browser !== 'undefined' && browser.storage) {
      return browser.storage.local.get(key).then(function (result) {
        return result[key] !== undefined ? result[key] : null;
      });
    }
    // Chrome (chrome.storage — callback API, wrapped in Promise)
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise(function (resolve) {
        chrome.storage.local.get(key, function (result) {
          resolve(result[key] !== undefined ? result[key] : null);
        });
      });
    }
    // localStorage fallback
    return Promise.resolve(localStorage.getItem(key));
  }

  function storageSet(key, value) {
    var obj = {};
    obj[key] = value;
    // Firefox
    if (typeof browser !== 'undefined' && browser.storage) {
      return browser.storage.local.set(obj);
    }
    // Chrome
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise(function (resolve) {
        chrome.storage.local.set(obj, resolve);
      });
    }
    // localStorage fallback
    try { localStorage.setItem(key, value); } catch(e) {}
    return Promise.resolve();
  }

  // ── Detect host page colors ────────────────────────────────────────────────
  // Samples computed styles from document.body to pick up the page's own
  // background and text color. Returned as hex strings, or null if detection
  // fails (e.g. transparent background — we walk up to <html> as fallback).
  function detectPageColors() {
    function rgbToHex(rgb) {
      var m = (rgb || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      // Reject fully transparent
      if (rgb.indexOf('rgba') !== -1) {
        var a = parseFloat((rgb.match(/,\s*([\d.]+)\)/) || [0, 1])[1]);
        if (a === 0) return null;
      }
      return '#' + [r, g, b].map(function (v) {
        return ('0' + v.toString(16)).slice(-2);
      }).join('');
    }

    function getBackground(el) {
      var bg = getComputedStyle(el).backgroundColor;
      var hex = rgbToHex(bg);
      // Walk up if transparent
      if (!hex && el.parentElement) return getBackground(el.parentElement);
      return hex;
    }

    try {
      var bg   = getBackground(document.body) || '#0f0f0f';
      var text = rgbToHex(getComputedStyle(document.body).color) || '#aaaaaa';
      return { bgColor: bg, fontColor: text };
    } catch(e) {
      return null;
    }
  }

  // ── Load all from storage into cache (call once at init) ────────────────────
  function loadAll() {
    return Promise.all([
      storageGet(SETTINGS_KEY),
      storageGet(GEOMETRY_KEY),
      storageGet(CUSTOM_URLS_KEY),
      storageGet(SITE_OVERRIDES_KEY),
      storageGet(HOTKEYS_KEY)
    ]).then(function (results) {
      // Settings
      try {
        var raw = results[0];
        var parsed = (typeof raw === 'string') ? JSON.parse(raw) : (raw || {});
        _settings = parsed || {};
      } catch(e) { _settings = {}; }

      // Detect host page colors and store as page-level defaults.
      // These are used by get() only when the user has no saved value.
      var detected = detectPageColors();
      if (detected) {
        _pageDefaults = {
          bgColor:   detected.bgColor,
          fontColor: detected.fontColor
        };
      }

      // Geometry
      try {
        var rawG = results[1];
        var parsedG = (typeof rawG === 'string') ? JSON.parse(rawG) : (rawG || {});
        _geometry = {
          x:      (typeof parsedG.x      === 'number') ? parsedG.x      : null,
          y:      (typeof parsedG.y      === 'number') ? parsedG.y      : null,
          width:  (typeof parsedG.width  === 'number') ? parsedG.width  : null,
          height: (typeof parsedG.height === 'number') ? parsedG.height : null
        };
      } catch(e) { _geometry = { x: null, y: null, width: null, height: null }; }

      // Custom URL patterns
      try {
        var rawU = results[2];
        var parsedU = (typeof rawU === 'string') ? JSON.parse(rawU) : (rawU || []);
        _customUrls = Array.isArray(parsedU) ? parsedU : [];
      } catch(e) { _customUrls = []; }

      // Site overrides
      try {
        var rawO = results[3];
        var parsedO = (typeof rawO === 'string') ? JSON.parse(rawO) : (rawO || {});
        _siteOverrides = (parsedO && typeof parsedO === 'object') ? parsedO : {};
      } catch(e) { _siteOverrides = {}; }

      // Hotkeys
      try {
        var rawH = results[4];
        var parsedH = (typeof rawH === 'string') ? JSON.parse(rawH) : (rawH || {});
        _hotkeys = (parsedH && typeof parsedH === 'object') ? parsedH : {};
      } catch(e) { _hotkeys = {}; }
    });
  }

  // ── Custom URL patterns ─────────────────────────────────────────────────────
  function loadCustomUrls() {
    return storageGet(CUSTOM_URLS_KEY).then(function (raw) {
      try {
        var parsed = (typeof raw === 'string') ? JSON.parse(raw) : (raw || []);
        _customUrls = Array.isArray(parsed) ? parsed : [];
      } catch(e) { _customUrls = []; }
    });
  }

  function getCustomUrls() { return _customUrls.slice(); }

  function setCustomUrls(list) {
    _customUrls = Array.isArray(list) ? list : [];
    storageSet(CUSTOM_URLS_KEY, JSON.stringify(_customUrls));
  }

  // Test current page URL against all saved patterns.
  // Returns the first matching entry or null.
  function matchCustomUrl(href) {
    href = href || location.href;
    for (var i = 0; i < _customUrls.length; i++) {
      var entry = _customUrls[i];
      try {
        if (new RegExp(entry.pattern).test(href)) return entry;
      } catch(e) { /* invalid regex — skip */ }
    }
    return null;
  }

  // ── Per-site enabled overrides ─────────────────────────────────────────────
  // The widget is "naturally on" on pages where an adapter matches (chatbots +
  // custom URL patterns) and "naturally off" everywhere else.
  // getSiteOverride(hostname) returns true/false/null:
  //   true  = user forced ON  (show even on unrecognised pages)
  //   false = user forced OFF (hide even on chatbot/configured pages)
  //   null  = no override, use natural default
  function getSiteOverride(hostname) {
    hostname = hostname || location.hostname;
    var v = _siteOverrides[hostname];
    return (v === true || v === false) ? v : null;
  }

  function setSiteOverride(hostname, value) {
    // value: true | false | null (null removes the override)
    hostname = hostname || location.hostname;
    if (value === null || value === undefined) {
      delete _siteOverrides[hostname];
    } else {
      _siteOverrides[hostname] = !!value;
    }
    storageSet(SITE_OVERRIDES_KEY, JSON.stringify(_siteOverrides));
  }

  // Determine whether the widget should be shown on the current page.
  // adapterMatched: boolean — whether a named or custom-URL adapter matched.
  function isEnabledForPage(adapterMatched, hostname) {
    var override = getSiteOverride(hostname || location.hostname);
    if (override !== null) return override;   // user override wins
    return !!adapterMatched;                  // natural default
  }

  // ── Hotkeys get / set ──────────────────────────────────────────────────────
  // Each hotkey is stored as a combo string like "Ctrl+Shift+T" or null (unbound).
  var HOTKEY_ACTIONS = ['toggleWidget', 'addAndEnable'];

  function getHotkeys() {
    return {
      toggleWidget: _hotkeys.toggleWidget || null,
      addAndEnable: _hotkeys.addAndEnable || null
    };
  }

  function setHotkey(action, combo) {
    // combo: string like "Ctrl+Shift+T", or null to unbind
    if (HOTKEY_ACTIONS.indexOf(action) === -1) return;
    if (combo) {
      _hotkeys[action] = combo;
    } else {
      delete _hotkeys[action];
    }
    storageSet(HOTKEYS_KEY, JSON.stringify(_hotkeys));
  }

  // ── Settings get / set (synchronous, hits cache) ────────────────────────────
  function get(key) {
    if (_settings[key] !== undefined) return _settings[key];
    if (_pageDefaults[key] !== undefined) return _pageDefaults[key];
    return DEFINITIONS[key].default;
  }

  function set(key, value) {
    _settings[key] = value;
    // Persist in background — don't block the UI
    storageSet(SETTINGS_KEY, JSON.stringify(_settings));
  }

  function getAll() {
    var result = {};
    Object.keys(DEFINITIONS).forEach(function (key) {
      result[key] = get(key);
    });
    return result;
  }

  // ── Geometry get / set (synchronous, hits cache) ────────────────────────────
  function getGeometry() {
    return {
      x:      _geometry.x,
      y:      _geometry.y,
      width:  _geometry.width,
      height: _geometry.height
    };
  }

  function setGeometry(partial) {
    if (partial.x      !== undefined) _geometry.x      = partial.x;
    if (partial.y      !== undefined) _geometry.y      = partial.y;
    if (partial.width  !== undefined) _geometry.width  = partial.width;
    if (partial.height !== undefined) _geometry.height = partial.height;
    storageSet(GEOMETRY_KEY, JSON.stringify(_geometry));
  }

  // ── Apply settings CSS variables to any root element ──────────────────────
  // Used by both the widget (#tocic-root) and the popup (document.body).
  // The data-side attribute is widget-specific and only set when the element
  // is the widget root (not document.body).
  function applyToDOM(rootEl) {
    if (!rootEl) return;
    var s = getAll();

    // Only set data-side on the widget root, not on document.body (popup)
    if (rootEl.id === 'tocic-root') {
      rootEl.setAttribute('data-side', s.side);
    }

    var style = rootEl.style;
    style.setProperty('--cn-font-size',           s.fontSize + 'px');
    style.setProperty('--cn-text-color',          s.fontColor);
    style.setProperty('--cn-bg',                  s.bgColor);
    style.setProperty('--cn-surface',             lighten(s.bgColor, 10));
    style.setProperty('--cn-accent',              s.accentColor);
    style.setProperty('--cn-accent-glow',         hexToRgba(s.accentColor, 0.18));
    style.setProperty('--cn-active-bg',           hexToRgba(s.accentColor, 0.12));
    style.setProperty('--cn-active-border',       s.accentColor);
    style.setProperty('--cn-settings-font-size',  s.settingsFontSize + 'px');
    style.setProperty('--cn-settings-font-color', s.settingsFontColor);
  }

  // ── Color utilities ─────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    hex = (hex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    return {
      r: parseInt(hex.slice(0,2), 16) || 0,
      g: parseInt(hex.slice(2,4), 16) || 0,
      b: parseInt(hex.slice(4,6), 16) || 0
    };
  }

  function hexToRgba(hex, alpha) {
    try {
      var c = hexToRgb(hex);
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    } catch(e) { return 'transparent'; }
  }

  function lighten(hex, amount) {
    try {
      var c = hexToRgb(hex);
      return '#' + [c.r, c.g, c.b].map(function (v) {
        return ('0' + Math.min(255, v + amount).toString(16)).slice(-2);
      }).join('');
    } catch(e) { return hex; }
  }

  // ── Reset all settings and geometry to defaults ────────────────────────────
  function resetAll() {
    _settings     = {};
    _pageDefaults = {};
    _geometry     = { x: null, y: null, width: null, height: null };
    // Note: custom URL patterns are NOT reset — they are user configuration,
    // not appearance settings.
    storageSet(SETTINGS_KEY, JSON.stringify(_settings));
    storageSet(GEOMETRY_KEY, JSON.stringify(_geometry));
  }

  // ── Shared settings controls HTML builder ──────────────────────────────────
  // Used by both the in-widget settings panel and the popup page so they
  // render identical controls from the same DEFINITIONS schema.
  function buildSettingsControlsHtml(excludeKeys) {
    excludeKeys = excludeKeys || [];
    function escHtml(str) {
      return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    return Object.keys(DEFINITIONS).filter(function (key) {
      return excludeKeys.indexOf(key) === -1;
    }).map(function (key) {
      var def = DEFINITIONS[key];
      var currentVal = (_settings[key] !== undefined) ? _settings[key]
                     : (_pageDefaults[key] !== undefined) ? _pageDefaults[key]
                     : def.default;
      var controlHtml = '';
      if (def.type === 'toggle') {
        controlHtml = '<label class="tn-toggle-wrap">' +
          '<input type="checkbox" data-setting="' + key + '"' +
          (currentVal ? ' checked' : '') + '>' +
          '<span class="tn-toggle-track"><span class="tn-toggle-thumb"></span></span>' +
          '</label>';
      } else if (def.type === 'select') {
        var opts = def.options.map(function (o) {
          return '<option value="' + escHtml(o.value) + '"' +
            (currentVal === o.value ? ' selected' : '') + '>' +
            escHtml(o.label) + '</option>';
        }).join('');
        controlHtml = '<select data-setting="' + key + '">' + opts + '</select>';
      } else if (def.type === 'color') {
        controlHtml = '<input type="color" data-setting="' + key + '" value="' + escHtml(currentVal) + '">';
      } else if (def.type === 'range') {
        controlHtml = '<div class="tn-range-wrap">' +
          '<input type="range" data-setting="' + key + '"' +
          ' min="' + def.min + '" max="' + def.max + '" step="' + def.step + '"' +
          ' value="' + currentVal + '">' +
          '<span class="tn-range-val" data-for="' + key + '">' + currentVal + (def.unit || '') + '</span>' +
          '</div>';
      }
      return '<label class="tn-setting-row">' +
        '<span class="tn-setting-label">' + escHtml(def.label) + '</span>' +
        controlHtml + '</label>';
    }).join('');
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  global.TocicSettings = {
    DEFINITIONS:  DEFINITIONS,
    loadAll:      loadAll,   // ← must be awaited before first use
    get:          get,
    set:          set,
    getAll:       getAll,
    getGeometry:  getGeometry,
    setGeometry:  setGeometry,
    applyToDOM:      applyToDOM,
    resetAll:        resetAll,
    getCustomUrls:   getCustomUrls,
    setCustomUrls:   setCustomUrls,
    matchCustomUrl:            matchCustomUrl,
    getSiteOverride:           getSiteOverride,
    setSiteOverride:           setSiteOverride,
    isEnabledForPage:          isEnabledForPage,
    buildSettingsControlsHtml: buildSettingsControlsHtml,
    HOTKEY_ACTIONS:            HOTKEY_ACTIONS,
    getHotkeys:                getHotkeys,
    setHotkey:                 setHotkey
  };

})(window);
