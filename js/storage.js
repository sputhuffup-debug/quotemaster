/* storage.js — localStorage settings, draft autosave, JSON import/export.
 * Exposes window.RqbStorage (not window.Storage, which is a built-in browser class). */
(function (global) {
  'use strict';

  var SETTINGS_KEY = 'rqb.settings.v1';
  var DRAFT_KEY = 'rqb.draft.v1';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /** Deep-merge `over` onto `base`: objects merge, arrays and scalars replace. */
  function merge(base, over) {
    var out = clone(base);
    if (!isPlainObject(over)) return out;
    Object.keys(over).forEach(function (k) {
      if (isPlainObject(out[k]) && isPlainObject(over[k])) out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = clone(over[k]);
    });
    return out;
  }

  /** Fill in anything missing from DEFAULTS and upgrade legacy field names. */
  function normalizeSettings(s) {
    var fromVersion = s && s.version ? s.version : 1;
    var out = merge(global.DEFAULTS, s || {});
    // v1 -> v2: quantities are no longer rounded up to 100 by default. Only the old default is changed;
    // a rounding value someone chose themselves (anything but 100) is kept.
    if (fromVersion < 2 && out.quantity && +out.quantity.roundTo === 100) out.quantity.roundTo = 0;
    // v2 -> v3: the Universal Plastics letterhead became the default. Browsers that never filled in
    // company details get it; anything someone entered is left alone.
    if (fromVersion < 3) {
      var inC = (s && s.company) || {};
      var blank = !inC.name && !inC.logoDataUrl && !inC.address && !inC.license && !inC.phone && !inC.email;
      if (blank) out.company = clone(global.DEFAULTS.company);
      else if (!inC.logoLayout) out.company.logoLayout = 'beside';   // an earlier upload was a small logo
    }
    // v3 -> v4: one hourly rate became Local + Bay Area. The old default $148 was the Bay Area rate;
    // a rate someone set themselves is kept as their Local rate.
    if (fromVersion < 4) {
      var inL = (s && s.labor) || {};
      if (inL.bayAreaHourlyRate === undefined) {
        out.labor.bayAreaHourlyRate = global.DEFAULTS.labor.bayAreaHourlyRate;
        if (inL.hourlyRate === undefined || +inL.hourlyRate === 148) out.labor.hourlyRate = global.DEFAULTS.labor.hourlyRate;
      }
    }
    // v4 -> v5: one running nextNumber became a counter per year (Q-26-1001, Q-27-1001 ...).
    // The current number carries on for this year, so nothing already used is handed out again.
    var inQ = (s && s.quote) || {};
    if (fromVersion < 5 && inQ.nextNumber !== undefined && !(inQ.counters && Object.keys(inQ.counters).length)) {
      var nn = parseInt(inQ.nextNumber, 10);
      if (isFinite(nn)) {
        out.quote.counters = {};
        out.quote.counters[String(new Date().getFullYear())] = nn;
        out.quote.counters.all = nn;
      }
    }
    delete out.quote.nextNumber;
    out.version = global.DEFAULTS.version;
    out.catalog = (out.catalog || []).map(global.Pricing.normalizeCatalogItem);
    if (!Array.isArray(out.terms.notes)) out.terms.notes = String(out.terms.notes || '').split(/\r?\n/).filter(Boolean);
    if (!isPlainObject(out.subjectMap)) out.subjectMap = {};
    return out;
  }

  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function lsRemove(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    var raw = lsGet(SETTINGS_KEY);
    var parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } }
    var s = normalizeSettings(parsed);
    if (!raw) saveSettings(s);
    return s;
  }

  function saveSettings(s) {
    return lsSet(SETTINGS_KEY, JSON.stringify(s));
  }

  function resetSettings() {
    var s = normalizeSettings(null);
    saveSettings(s);
    return s;
  }

  function saveDraft(quote) { return lsSet(DRAFT_KEY, JSON.stringify(quote)); }
  function loadDraft() {
    var raw = lsGet(DRAFT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function clearDraft() { lsRemove(DRAFT_KEY); }

  /** Read a File as text. */
  function readText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('Could not read ' + file.name)); };
      fr.readAsText(file);
    });
  }

  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('Could not read ' + file.name)); };
      fr.readAsArrayBuffer(file);
    });
  }

  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('Could not read ' + file.name)); };
      fr.readAsDataURL(file);
    });
  }

  function readJson(file) {
    return readText(file).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error(file.name + ' is not a valid JSON file.'); }
    });
  }

  function safeFileName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
  }

  /**
   * Save JSON to disk. Uses the File System Access API when available (lets the user pick the folder),
   * otherwise falls back to a normal download.  Resolves to true if saved, false if the user cancelled.
   */
  function saveJsonFile(obj, suggestedName) {
    var text = JSON.stringify(obj, null, 2);
    var name = safeFileName(suggestedName);
    if (!/\.json$/i.test(name)) name += '.json';
    if (typeof global.showSaveFilePicker === 'function') {
      return global.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      }).then(function (handle) {
        return handle.createWritable().then(function (w) {
          return w.write(text).then(function () { return w.close(); });
        });
      }).then(function () { return true; }, function (err) {
        if (err && err.name === 'AbortError') return false;
        downloadText(text, name, 'application/json');
        return true;
      });
    }
    downloadText(text, name, 'application/json');
    return Promise.resolve(true);
  }

  function downloadText(text, name, type) {
    downloadBlob(new Blob([text], { type: type || 'text/plain' }), name);
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  global.RqbStorage = {
    SETTINGS_KEY: SETTINGS_KEY,
    DRAFT_KEY: DRAFT_KEY,
    clone: clone,
    merge: merge,
    normalizeSettings: normalizeSettings,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    resetSettings: resetSettings,
    saveDraft: saveDraft,
    loadDraft: loadDraft,
    clearDraft: clearDraft,
    readText: readText,
    readDataUrl: readDataUrl,
    readArrayBuffer: readArrayBuffer,
    downloadBlob: downloadBlob,
    readJson: readJson,
    saveJsonFile: saveJsonFile,
    downloadText: downloadText,
    safeFileName: safeFileName
  };
})(window);
