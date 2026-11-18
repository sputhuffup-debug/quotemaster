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
    var out = merge(global.DEFAULTS, s || {});
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
    var blob = new Blob([text], { type: type || 'text/plain' });
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
    readJson: readJson,
    saveJsonFile: saveJsonFile,
    downloadText: downloadText,
    safeFileName: safeFileName
  };
})(window);
