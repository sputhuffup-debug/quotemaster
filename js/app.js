/* app.js — UI wiring.  Depends on Units, Parse, Pricing, Quote, RqbStorage. */
(function (global) {
  'use strict';

  var U = global.Units;
  var P = global.Pricing;
  var Q = global.Quote;
  var S = global.RqbStorage;
  var esc = Q.esc;
  var doc = global.document;

  var state = {
    settings: null,
    quote: null,
    priced: null,
    tab: 'import',
    previewMode: 'proposal',
    dirty: false
  };

  /* ================= helpers ================= */

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o === null || o === undefined ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, value) {
    var keys = path.split('.');
    var o = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] === null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }

  function attr(name, value) { return ' ' + name + '="' + esc(value) + '"'; }

  function textInput(id, value, extra) {
    return '<input type="text" id="' + esc(id) + '"' + attr('value', value === null || value === undefined ? '' : value) + (extra || '') + '>';
  }
  function numInput(id, value, extra) {
    extra = extra || '';
    // Merge a caller-supplied class="..." into ours (a second class attribute would be ignored).
    var cls = 'num';
    extra = extra.replace(/\s*class="([^"]*)"/, function (m, c) { cls = c.indexOf('num') === -1 ? 'num ' + c : c; return ''; });
    return '<input type="text" inputmode="decimal" class="' + cls + '" id="' + esc(id) + '"' +
      attr('value', value === null || value === undefined ? '' : value) + extra + '>';
  }
  function field(label, html, cls) {
    return '<label class="field' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span>' + html + '</label>';
  }
  function options(list, selected) {
    return list.map(function (o) {
      return '<option' + attr('value', o[0]) + (String(o[0]) === String(selected) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
  }
  function messages(list) {
    if (!list.length) return '';
    return '<ul class="messages">' + list.map(function (m) {
      return '<li class="' + esc(m.level || 'info') + '">' + esc(m.message) + '</li>';
    }).join('') + '</ul>';
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (isError ? ' error' : ''); }, isError ? 6000 : 3000);
  }

  function parseNumOrRaw(v) {
    var n = U.parseNumber(v);
    return n === null ? v : n;
  }

  /* ================= state ================= */

  function rows() { return state.quote.source ? state.quote.source.rows : []; }

  function recompute() {
    state.priced = P.price(state.quote, rows());
    // Quotes saved before lines were split per Bluebeam subject keyed overrides by catalog item:
    // copy them to the new line keys so edits keep the typed rates.
    var ovs = state.quote.lineOverrides;
    state.priced.lines.forEach(function (l) {
      if (l.legacyKey && l.legacyKey !== l.key && !ovs[l.key] && ovs[l.legacyKey]) ovs[l.key] = JSON.parse(JSON.stringify(ovs[l.legacyKey]));
    });
  }

  function saveDraft() {
    S.saveDraft({ quote: state.quote, dirty: state.dirty, tab: state.tab, previewMode: state.previewMode });
  }

  /** Quote data changed. mode: "full" re-renders the active panel, "light" only refreshes previews/header. */
  function changed(mode) {
    state.dirty = true;
    recompute();
    saveDraft();
    if (mode === 'light') renderLight();
    else render();
  }

  function settingsChanged(mode) {
    S.saveSettings(state.settings);
    syncPristineQuote();
    if (mode === 'full') render();
    else renderLight();
  }

  /** A quote with nothing in it yet follows Settings, so first-run setup "just works". */
  function syncPristineQuote() {
    var q = state.quote;
    if (q.source || (q.manualLines && q.manualLines.length) || state.dirty) return;
    var fresh = Q.newQuote(state.settings);
    q.rates = fresh.rates;
    q.taxPct = fresh.taxPct;
    q.validDays = fresh.validDays;
    q.notes = fresh.notes;
    q.proposal = fresh.proposal;
    if (!q.numberCommitted) q.number = fresh.number;
    recompute();
    saveDraft();
  }

  function allCatalogItems() {
    var out = state.quote.rates.catalog.slice();
    state.settings.catalog.forEach(function (c) {
      if (!P.findCatalogItem(out, c.subject)) out.push(c);
    });
    return out;
  }

  /** Make sure the quote's rate snapshot contains a catalog item (copying it from Settings). */
  function ensureQuoteHasItem(subject) {
    if (P.findCatalogItem(state.quote.rates.catalog, subject)) return;
    var it = P.findCatalogItem(state.settings.catalog, subject);
    if (it) state.quote.rates.catalog.push(JSON.parse(JSON.stringify(it)));
  }

  /* ================= rendering ================= */

  function render() {
    var ae = doc.activeElement;
    var focusId = ae && ae.id;
    var sel = null;
    try { if (ae && typeof ae.selectionStart === 'number') sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; }
    var scrollY = global.scrollY;

    renderTopbar();
    renderTabs();
    var panel = state.tab;
    var el = $('#panel-' + panel);
    if (panel === 'import') el.innerHTML = renderImport();
    else if (panel === 'pricing') el.innerHTML = renderPricing();
    else if (panel === 'quote') el.innerHTML = renderQuotePanel();
    else if (panel === 'settings') el.innerHTML = renderSettings();
    $all('.panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === panel); });

    if (focusId) {
      var f = doc.getElementById(focusId);
      if (f && f !== ae) {
        f.focus({ preventScroll: true });
        if (sel) { try { f.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
      }
    }
    global.scrollTo(0, scrollY);
  }

  function renderLight() {
    renderTopbar();
    renderTabs();
    var prev = $('#preview');
    if (prev) prev.innerHTML = Q.render(state.quote, state.priced, state.settings, state.previewMode);
    var tot = $('#totals-bar');
    if (tot) tot.outerHTML = renderTotalsBar();
  }

  function renderTopbar() {
    var q = state.quote;
    var parts = [q.number + (q.numberCommitted ? '' : ' (draft)')];
    if (q.project.name) parts.push(q.project.name);
    if (q.gc.name) parts.push(q.gc.name);
    if (state.priced && state.priced.lines.length) parts.push(U.formatMoney(state.priced.totals.total));
    $('#current-quote').innerHTML = esc(parts.join('  ·  ')) + (state.dirty ? '<span class="dirty">● unsaved</span>' : '');
  }

  function renderTabs() {
    var nWarn = state.priced ? state.priced.unmapped.length : 0;
    $all('#tabs button').forEach(function (b) {
      var t = b.dataset.tab;
      b.setAttribute('aria-selected', t === state.tab ? 'true' : 'false');
      var label = { import: '1. Import', pricing: '2. Pricing', quote: '3. Quote', settings: 'Settings' }[t];
      b.innerHTML = esc(label) + (t === 'import' && nWarn ? '<span class="badge" title="Unmapped subjects">' + nWarn + '</span>' : '');
    });
  }

  function setTab(tab) {
    state.tab = tab;
    saveDraft();
    render();
    global.scrollTo(0, 0);
  }

  /* ---------- Import panel ---------- */

  function renderImport() {
    var src = state.quote.source;
    if (!src) {
      return '' +
        '<div class="card">' +
          '<h2>Import a Bluebeam Markups Summary CSV</h2>' +
          '<p class="muted">In Revu, open the Markups List, then choose <strong>Summary → CSV</strong>. Drop the file here or click to browse.</p>' +
          '<div class="dropzone" data-act="pick-csv"><strong>Drop CSV here</strong><span class="muted">or click to choose a file</span></div>' +
          '<input type="file" id="file-csv" accept=".csv,text/csv" hidden>' +
        '</div>';
    }
    var priced = state.priced;
    var lineByRow = {};
    priced.lines.forEach(function (l) { l.rowIds.forEach(function (id) { lineByRow[id] = l; }); });

    // messages
    var msgs = (src.warnings || []).concat(priced.warnings.filter(function (w) { return w.code !== 'unmapped'; }));
    var subtotalWarn = (src.warnings || []).some(function (w) { return w.code === 'subtotal'; });
    if (src.subtotals && src.subtotals.length && !subtotalWarn) {
      msgs.push({ level: 'ok', message: 'Detail rows match the Bluebeam group subtotal' + (src.subtotals.length > 1 ? 's' : '') + ' (' +
        src.subtotals.map(function (s) { return s.subject + ': ' + U.formatNumber(s.wasteSqFt !== null ? s.wasteSqFt : s.sqFt, 2) + (s.wasteSqFt !== null ? ' waste sf' : ' sf'); }).join(', ') + ').' });
    }
    if (src.autoFilled) msgs.push({ level: 'info', message: src.autoFilled });

    // subject mapping
    var subjects = [];
    var bySubject = {};
    src.rows.forEach(function (r) {
      if (!bySubject[r.baseSubject]) { bySubject[r.baseSubject] = { subject: r.baseSubject, rows: 0, waste: 0 }; subjects.push(bySubject[r.baseSubject]); }
      bySubject[r.baseSubject].rows++;
      bySubject[r.baseSubject].waste += r.wasteSqFt || 0;
    });
    var catalog = allCatalogItems();
    var mapRows = subjects.map(function (s, i) {
      var mapped = state.quote.rates.subjectMap[s.subject] || '';
      var direct = P.findCatalogItem(state.quote.rates.catalog, s.subject) || P.findCatalogItem(state.settings.catalog, s.subject);
      var res = P.resolveSubject(s.subject, state.quote.rates);
      var opts = [['', direct ? 'Auto: ' + direct.subject + ' — ' + (direct.description || '') : '— not mapped —']];
      catalog.forEach(function (c) { opts.push([c.subject, c.subject + ' — ' + (c.description || '')]); });
      opts.push([P.IGNORE, 'Ignore (leave off the quote)']);
      return '<tr' + (res.unmapped ? ' class="unmapped"' : '') + '>' +
        '<td><strong>' + esc(s.subject) + '</strong></td>' +
        '<td class="num">' + s.rows + '</td>' +
        '<td class="num">' + U.formatNumber(s.waste, 2) + '</td>' +
        '<td><select id="map-' + i + '" data-map="' + esc(s.subject) + '">' + options(opts, mapped) + '</select></td>' +
        '<td>' + (res.unmapped ? '<button type="button" class="small" data-act="new-cat" data-subject="' + esc(s.subject) + '">New catalog item…</button>' : '') + '</td>' +
        '</tr>';
    }).join('');

    // takeoff table (CSV order, subtotal rows greyed)
    var all = src.rows.concat(src.subtotals || []).sort(function (a, b) { return a.line - b.line; });
    var tot = { m: 0, sf: 0, w: 0 };
    var body = all.map(function (r) {
      if (r.isSubtotal) {
        return '<tr class="subtotal" title="Bluebeam group subtotal (not priced)">' +
          '<td></td><td>' + esc(r.subject) + '</td><td>' + esc(r.room) + '</td><td class="num"></td><td></td>' +
          '<td class="num">' + U.formatNumber(r.measurement, 4) + '</td><td class="num"></td><td class="num"></td>' +
          '<td class="num">' + U.formatNumber(r.sqFt, 2) + '</td><td class="num">' + U.formatNumber(r.wasteSqFt, 2) + '</td>' +
          '<td>Subtotal</td></tr>';
      }
      var excluded = !!state.quote.excludedRows[r.id];
      var l = lineByRow[r.id];
      var res = P.resolveSubject(r.baseSubject, state.quote.rates);
      if (!excluded) {
        tot.m += r.measurement || 0; tot.sf += r.sqFt || 0; tot.w += r.wasteSqFt || 0;
      }
      var status = excluded ? 'Excluded' : res.ignored ? 'Ignored' : res.unmapped ? 'Not mapped' : l ? esc(l.catalogSubject) : 'No quantity';
      var color = /^#[0-9a-f]{3,8}$/i.test(r.color) ? '<span class="swatch" style="background:' + r.color + '"></span>' : '';
      return '<tr class="' + (excluded ? 'excluded' : (res.unmapped ? 'unmapped' : '')) + '">' +
        '<td><input type="checkbox" id="row-' + esc(r.id) + '" data-row="' + esc(r.id) + '"' + (excluded ? '' : ' checked') + ' title="Include this markup"></td>' +
        '<td>' + color + esc(r.subject) + '</td>' +
        '<td>' + esc(r.room || r.space) + '</td>' +
        '<td class="num">' + esc(r.page) + '</td>' +
        '<td>' + esc(r.label || r.comments) + '</td>' +
        '<td class="num">' + U.formatNumber(r.measurement, 4) + '</td>' +
        '<td class="num">' + esc(r.installHeightText) + '</td>' +
        '<td class="num">' + (r.matHeight !== null ? U.formatNumber(r.matHeight, 2) : '') + '</td>' +
        '<td class="num">' + U.formatNumber(r.sqFt, 2) + '</td>' +
        '<td class="num">' + U.formatNumber(r.wasteSqFt, 2) + '</td>' +
        '<td>' + status + '</td></tr>';
    }).join('');

    return '' +
      '<div class="card">' +
        '<div class="card-head">' +
          '<div><h2 style="margin:0">' + esc(src.fileName || 'Takeoff') + '</h2>' +
          '<div class="hint">' + src.rows.length + ' markup row' + (src.rows.length === 1 ? '' : 's') +
            (src.subtotals && src.subtotals.length ? ', ' + src.subtotals.length + ' Bluebeam subtotal row' + (src.subtotals.length === 1 ? '' : 's') + ' (not priced)' : '') +
            (src.importedAt ? ' · imported ' + esc(new Date(src.importedAt).toLocaleString()) : '') + '</div></div>' +
          '<div class="row"><div class="dropzone compact" data-act="pick-csv">Replace CSV…</div>' +
          '<input type="file" id="file-csv" accept=".csv,text/csv" hidden>' +
          '<button type="button" class="primary" data-act="goto" data-tab="pricing">Continue to Pricing →</button></div>' +
        '</div>' +
        messages(msgs) +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><h3>Subject mapping</h3><span class="hint">Which catalog item each Bluebeam Subject is priced as. Choices are remembered for future imports.</span></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Bluebeam subject</th><th class="num">Rows</th><th class="num">Waste SF</th><th style="min-width:320px">Prices as</th><th></th></tr></thead>' +
        '<tbody>' + mapRows + '</tbody></table></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><h3>Takeoff rows</h3><span class="hint">Untick a row to leave it off the quote. Grey rows are Bluebeam subtotals.</span></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th></th><th>Subject</th><th>Room</th><th class="num">Page</th><th>Label</th><th class="num">Length (ft)</th><th class="num">Install ht</th>' +
          '<th class="num">Mat. ht</th><th class="num">SQ. FT</th><th class="num">Waste SF</th><th>Priced as</th></tr></thead>' +
          '<tbody>' + body + '</tbody>' +
          '<tfoot><tr><td></td><td colspan="4">Included rows</td><td class="num">' + U.formatNumber(tot.m, 4) + '</td><td></td><td></td>' +
          '<td class="num">' + U.formatNumber(tot.sf, 2) + '</td><td class="num">' + U.formatNumber(tot.w, 2) + '</td><td></td></tr></tfoot>' +
        '</table></div>' +
      '</div>';
  }

  /* ---------- Pricing panel ---------- */

  function renderTotalsBar() {
    var t = state.priced.totals;
    return '<div class="totals-bar" id="totals-bar">' +
      '<div><span>Material</span><strong>' + U.formatMoney(t.material) + '</strong></div>' +
      '<div><span>Labor</span><strong>' + U.formatMoney(t.labor) + '</strong></div>' +
      '<div><span>Labor days</span><strong>' + U.formatNumber(t.laborDays, 3) + '</strong></div>' +
      (t.tax ? '<div><span>Tax</span><strong>' + U.formatMoney(t.tax) + '</strong></div>' : '') +
      '<div class="grand"><span>Total' + (t.linesMissingRates ? ' <span class="pill warn">incomplete: ' + t.linesMissingRates + ' line' + (t.linesMissingRates === 1 ? ' needs' : 's need') + ' rates</span>' : '') + '</span><strong>' + U.formatMoney(t.total) + '</strong></div>' +
      '</div>';
  }

  function renderPricing() {
    var q = state.quote;
    var lab = q.rates.labor;
    var qty = q.rates.quantity;
    var priced = state.priced;

    var ratesCard = '' +
      '<div class="card">' +
        '<div class="card-head"><h3>Rates for this quote</h3>' +
          '<button type="button" data-act="reload-rates" title="Replace this quote\'s rates and catalog prices with the current Settings">Reload rates from Settings</button></div>' +
        '<div class="grid">' +
          field('Hourly rate ($)', numInput('r-hourly', lab.hourlyRate, ' data-q="rates.labor.hourlyRate"')) +
          field('Hours / day', numInput('r-hours', lab.hoursPerDay, ' data-q="rates.labor.hoursPerDay"')) +
          field('Per diem + vehicle ($/day)', numInput('r-adder', lab.dailyAdder, ' data-q="rates.labor.dailyAdder"')) +
          field('Labor cost / day (all-in)', '<input type="text" class="num" readonly tabindex="-1" title="Hourly × hours + per diem & vehicle" value="' + esc(U.formatMoney(priced.dayRate)) + '">') +
          field('Round labor days', '<select id="r-dayround" data-q="rates.labor.dayRounding">' +
            options([['none', 'No rounding'], ['half', 'Up to ½ day'], ['whole', 'Up to whole day']], lab.dayRounding) + '</select>') +
          field('SF quantity from', '<select id="r-source" data-q="rates.quantity.source">' +
            options([['wasteSqFt', 'Waste Sq FT. column'], ['sqFt', 'SQ. FT column + waste %'], ['calc', 'Length × Install Ht + waste %']], qty.source) + '</select>') +
          field('Round SF up to (0 = none)', numInput('r-roundto', qty.roundTo, ' data-q="rates.quantity.roundTo"')) +
          field('Waste % (if not using Waste col.)', numInput('r-waste', qty.wastePct, ' data-q="rates.quantity.wastePct"')) +
          field('Material $ & install rate', '<select id="r-rateentry" data-q="rates.rateEntry">' +
            options([['manual', 'Type in on each line'], ['catalog', 'Pre-fill from catalog']], q.rates.rateEntry || 'manual') + '</select>') +
          field('Sales tax on material (%)', numInput('r-tax', q.taxPct, ' data-q="taxPct"')) +
          '<label class="field"><span>Grouping</span><span class="check" style="padding:6px 0"><input type="checkbox" id="r-room" data-q="groupByRoom"' + (q.groupByRoom ? ' checked' : '') + '> Separate line per room</span></label>' +
        '</div>' +
      '</div>';

    var lines = priced.lines;
    var manualRates = q.rates.rateEntry !== 'catalog';
    var anyNonSf = lines.some(function (l) { return l.unit !== 'sf'; });
    function rateInput(l, ov, f, id) {
      var has = ov[f] !== undefined && ov[f] !== '';
      var catVal = (P.findCatalogItem(q.rates.catalog, l.catalogSubject) || {})[f];
      if (!manualRates && catVal !== null && catVal !== undefined) {
        var auto = String(catVal);
        return numInput(id, has ? ov[f] : '', ' data-line="' + esc(l.key) + '" data-ov="' + f + '" placeholder="' + esc(auto) + '"' +
          ' class="num w-xs' + (has ? ' overridden' : '') + '" title="Blank = catalog value ' + esc(auto) + '"');
      }
      var missing = !has && !l.excluded && !(f === 'unitsPerDay' && l.laborDaysOverridden);
      return numInput(id, has ? ov[f] : '', ' data-line="' + esc(l.key) + '" data-ov="' + f + '" placeholder="enter"' +
        ' class="num w-xs' + (missing ? ' required' : '') + '"' +
        ' title="' + (f === 'materialRate' ? 'Material cost per ' + l.unit : 'Installed ' + l.unit + ' per crew-day (0 = no labor)') + '"');
    }
    var body = lines.map(function (l, i) {
      var ov = q.lineOverrides[l.key] || {};
      function ovInput(f, id, val, auto, cls) {
        var has = ov[f] !== undefined && ov[f] !== '';
        return numInput(id, has ? ov[f] : '', ' data-line="' + esc(l.key) + '" data-ov="' + f + '" placeholder="' + esc(auto) + '"' +
          ' class="num ' + (cls || '') + (has ? ' overridden' : '') + '" title="Blank = ' + esc(auto) + '"');
      }
      var unitTxt = Q.unitLabel(l.unit).toLowerCase();
      function qtyInput(l, ov, id) {
        var has = ov.qty !== undefined && ov.qty !== '';
        var auto = U.formatNumber(l.autoQty, 2);
        var title = l.qtyBelowTakeoff
          ? 'Below the takeoff quantity (' + U.formatNumber(l.rawQty, 2) + '). Check this is not a typo.'
          : (has ? 'Entered by hand. Clear it to use the takeoff quantity (' + auto + ').' : 'Takeoff quantity. Type a different Total SQ for this quote.');
        return numInput(id, has ? ov.qty : '', ' data-line="' + esc(l.key) + '" data-ov="qty" placeholder="' + esc(auto) + '"' +
          ' class="num w-sm' + (has ? ' overridden' : '') + (l.qtyBelowTakeoff ? ' below' : '') + '" title="' + esc(title) + '"');
      }
      function roomsInput(l, ov, id) {
        var has = ov.rooms !== undefined && ov.rooms !== '';
        var attrs = ' data-line="' + esc(l.key) + '" data-ov="rooms" style="width:56px"';
        var need = l.needsRooms && !l.excluded;
        var hint = l.manual ? '' : ' Takeoff: ' + l.rowCount + ' markup' + (l.rowCount === 1 ? '' : 's') +
          (l.roomNames.length ? ' in ' + l.roomNames.join(', ') : '') + '.';
        return numInput(id, has ? ov.rooms : '', attrs + ' placeholder="' + (need ? '#' : '') + '" class="num' + (need ? ' required' : '') + '"' +
          ' title="' + esc('How many rooms / areas / soffits, for the scope of work: (3) ROOMS @ 8\' AFF.' + hint) + '"');
      }
      return '<tr class="' + (l.excluded ? 'excluded' : '') + '">' +
        '<td><input type="checkbox" id="ln-x-' + i + '" data-line="' + esc(l.key) + '" data-ov="excluded"' + (l.excluded ? '' : ' checked') + ' title="Include on quote"></td>' +
        '<td class="scope-cell"><div class="scope-edit">' + roomsInput(l, ov, 'ln-rooms-' + i) +
          '<select id="ln-noun-' + i + '" data-line="' + esc(l.key) + '" data-ov="roomNoun" title="What is being counted">' +
            options(Object.keys(P.NOUNS).map(function (n) { return [n, n]; }), l.roomNoun) + '</select>' +
          textInput('ln-note-' + i, ov.scopeNote !== undefined ? ov.scopeNote : '', ' data-line="' + esc(l.key) + '" data-ov="scopeNote" placeholder="' + esc(l.scopeNoteAuto || 'note') + '"' +
            ' title="Added after the height, e.g. o/ CMU" style="width:84px"') +
          '</div><div class="scope-preview' + (l.scopeLabelOverridden ? ' typed' : '') + '" title="' + (l.scopeLabelOverridden ? 'Typed on the Quote tab' : 'Printed as the scope of work') + '">' +
            esc(l.scopeLabel || '—') + '</div></td>' +
        '<td class="item-cell"><strong>' + esc(l.catalogSubject) + '</strong>' + (l.manual ? ' <span class="pill">manual</span>' : '') +
          (l.subject && l.subject.toLowerCase() !== l.catalogSubject.toLowerCase() ? ' <span class="pill" title="Bluebeam subject">' + esc(l.subject) + '</span>' : '') +
          (l.room ? ' <span class="pill">' + esc(l.room) + '</span>' : '') +
          '<div class="hint">' + esc(l.description) + '</div></td>' +
        '<td>' + (l.unit === 'sf' ? ovInput('height', 'ln-h-' + i, null, l.height !== null ? U.formatFeet(l.height) : '?', 'w-xs') : '') + '</td>' +
        '<td class="num">' + (l.manual ? '—' : U.formatNumber(l.rawQty, 2)) + (anyNonSf ? ' ' + esc(unitTxt) : '') + '</td>' +
        '<td>' + qtyInput(l, ov, 'ln-q-' + i) + '</td>' +
        '<td class="num">' + (l.linealFt !== null ? U.formatNumber(l.linealFt) : '') + '</td>' +
        '<td>' + rateInput(l, ov, 'materialRate', 'ln-mr-' + i) + '</td>' +
        '<td>' + rateInput(l, ov, 'unitsPerDay', 'ln-pd-' + i) + '</td>' +
        '<td>' + numInput('ln-days-' + i, l.laborDaysOverridden ? ov.laborDays : '', ' data-line="' + esc(l.key) + '" data-ov="laborDays"' +
          ' placeholder="' + (l.unitsPerDay === null ? '' : esc(U.formatNumber(l.laborDaysAuto, 3))) + '" class="num w-xs' + (l.laborDaysOverridden ? ' overridden' : '') + '"' +
          ' title="' + (l.laborDaysOverridden ? 'Labor entered as days. Clear it to use ' + l.unit + '/day instead.' : 'Calculated from ' + l.unit + '/day. Type a number of days to price labor by days instead.') + '"') + '</td>' +
        '<td class="num">' + U.formatMoney(l.material) + '</td>' +
        '<td class="num">' + U.formatMoney(l.labor) + '</td>' +
        '<td class="num strong">' + U.formatMoney(l.total) + '</td>' +
        '<td>' + (l.manual ? '<button type="button" class="small danger" data-act="del-manual" data-id="' + esc(l.manualId) + '" title="Remove line">✕</button>' :
          (Object.keys(ov).length ? '<button type="button" class="small link" data-act="reset-line" data-line="' + esc(l.key) + '" title="Clear overrides on this line">reset</button>' : '')) + '</td>' +
        '</tr>';
    }).join('');

    var t = priced.totals;
    var catalog = allCatalogItems();
    var addRow = '' +
      '<div class="row" style="margin-top:12px">' +
        field('Add a line', '<select id="add-item">' + options(catalog.map(function (c) { return [c.subject, c.subject + ' — ' + (c.description || '') + ' (' + c.unit + ')']; }), '') + '</select>') +
        field('Quantity', numInput('add-qty', '', ' style="width:110px"')) +
        field('Height (sf items)', textInput('add-height', '', ' style="width:90px" placeholder="8\'"')) +
        '<button type="button" data-act="add-manual"' + (catalog.length ? '' : ' disabled') + '>Add line</button>' +
        '<span class="hint">For items that are not in the Bluebeam takeoff.</span>' +
      '</div>';

    var warn = priced.warnings.filter(function (w) { return w.level !== 'info'; });
    var empty = !lines.length ? '<p class="muted">No line items yet. ' + (q.source ? 'Map the Bluebeam subjects on the Import tab, or add a line below.' : 'Import a CSV on the Import tab, or add a line below.') + '</p>' : '';

    return ratesCard +
      '<div class="card">' +
        '<div class="card-head"><h3>Line items</h3><span class="hint">' + (manualRates
          ? 'Type the material cost and install production for each line (red = still needed). Other grey values are automatic; typing over them overrides them for this quote (yellow).'
          : 'Grey values are automatic. Type in a field to override it for this quote only (it turns yellow); clear it to go back.') + '</span></div>' +
        messages(warn) +
        empty +
        (lines.length ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th></th><th>Scope of work <span class="hint">(count · type · note)</span></th><th>Item</th><th>Height</th><th class="num">' + (anyNonSf ? 'Takeoff qty' : 'Waste Sq Ft') + '</th><th>' + (anyNonSf ? 'Priced qty' : 'Total SQ') + '</th><th class="num">Lineal ft</th>' +
          '<th>' + (anyNonSf ? 'Material $ / unit' : 'Material $ / sf') + '</th><th>' + (anyNonSf ? 'Install units / day' : 'Install sf / day') + '</th><th class="num">Labor days</th><th class="num">Material</th><th class="num">Labor</th><th class="num">Total</th><th></th>' +
          '</tr></thead><tbody>' + body + '</tbody>' +
          '<tfoot><tr><td></td><td colspan="8">Totals</td><td class="num">' + U.formatNumber(t.laborDays, 3) + '</td>' +
          '<td class="num">' + U.formatMoney(t.material) + '</td><td class="num">' + U.formatMoney(t.labor) + '</td>' +
          '<td class="num">' + U.formatMoney(t.subtotal) + '</td><td></td></tr></tfoot></table></div>' : '') +
        addRow +
      '</div>' +
      renderTotalsBar() +
      '<div class="row" style="margin-top:16px"><span class="spacer"></span><button type="button" class="primary" data-act="goto" data-tab="quote">Continue to Quote →</button></div>';
  }

  /* ---------- Quote panel ---------- */

  function renderQuotePanel() {
    var q = state.quote;
    var lines = state.priced.lines.filter(function (l) { return !l.excluded; });
    var lineCards = lines.map(function (l, i) {
      var ov = q.lineOverrides[l.key] || {};
      var item = P.findCatalogItem(q.rates.catalog, l.catalogSubject) || {};
      return '<div class="card" style="background:#fafbfc">' +
        '<div class="card-head"><strong>' + esc(l.scopeLabel || l.catalogSubject) + '</strong><span class="hint">' + esc(l.catalogSubject) + ' · ' + U.formatMoney(l.total) + '</span></div>' +
        field('Scope of work', textInput('qd-label-' + i, l.scopeLabelOverridden ? l.scopeLabel : '', ' data-line="' + esc(l.key) + '" data-ov="scopeLabel" placeholder="' + esc(l.scopeLabelAuto) + '"' +
          (l.scopeLabelOverridden ? ' class="overridden"' : '')) +
          '<span class="hint">' + (l.scopeLabelOverridden ? 'Typed by hand. Clear it to go back to the automatic label.' : 'Automatic from the Pricing tab (count, type, height, note). Type here to replace it.') + '</span>') +
        field('Material description', textInput('qd-desc-' + i, l.description, ' data-line="' + esc(l.key) + '" data-ov="description"') +
          (ov.description !== undefined ? '<button type="button" class="link small" data-act="reset-ov" data-line="' + esc(l.key) + '" data-ov="description">use catalog text</button>' : '')) +
        field('Scope paragraph', '<textarea rows="3" id="qd-scope-' + i + '" data-line="' + esc(l.key) + '" data-ov="scope">' + esc(l.scope) + '</textarea>' +
          (ov.scope !== undefined && ov.scope !== item.scope ? '<button type="button" class="link small" data-act="reset-ov" data-line="' + esc(l.key) + '" data-ov="scope">use catalog text</button>' : '')) +
        '</div>';
    }).join('');

    var form = '' +
      '<div class="card">' +
        '<h3>Quote details</h3>' +
        '<div class="grid">' +
          field('Quote #', textInput('q-number', q.number, ' data-q="number"') + '<span class="hint">' + (q.numberCommitted ? 'Assigned' : 'Assigned when first saved') + '</span>') +
          field('Date', '<input type="date" id="q-date" data-q="date"' + attr('value', q.date) + '>') +
          field('Valid for (days)', numInput('q-valid', q.validDays, ' data-q="validDays"')) +
        '</div>' +
        '<div class="grid wide" style="margin-top:10px">' +
          field('General contractor', textInput('q-gc', q.gc.name, ' data-q="gc.name"')) +
          field('Attention', textInput('q-attn', q.gc.attention, ' data-q="gc.attention"')) +
          field('Project name', textInput('q-proj', q.project.name, ' data-q="project.name"')) +
          field('Project address', textInput('q-addr', q.project.address, ' data-q="project.address"')) +
        '</div>' +
        '<div class="field" style="margin-top:10px"><span>Construction type</span><div class="radio-group">' +
          ['new', 'remodel', ''].map(function (v) {
            var lbl = { 'new': 'New Const.', remodel: 'Remodel', '': 'Not specified' }[v];
            return '<label class="check"><input type="radio" name="ctype" id="q-ct-' + (v || 'none') + '" data-q="constructionType" value="' + v + '"' + (q.constructionType === v ? ' checked' : '') + '> ' + lbl + '</label>';
          }).join('') +
        '</div></div>' +
        field('Notes / exclusions (one per line)', '<textarea rows="4" id="q-notes" data-q="notes">' + esc(q.notes) + '</textarea>') +
      '</div>' +
      '<div class="card">' +
        '<h3>GC proposal options</h3>' +
        '<div class="row">' +
          '<label class="check"><input type="checkbox" id="q-lump" data-q="proposal.lumpSum"' + (q.proposal.lumpSum ? ' checked' : '') + '> Lump sum only (hide line prices)</label>' +
          '<label class="check"><input type="checkbox" id="q-split" data-q="proposal.showSplit"' + (q.proposal.showSplit ? ' checked' : '') + '> Show material / labor split</label>' +
          '<label class="check"><input type="checkbox" id="q-qty" data-q="proposal.showUnitQty"' + (q.proposal.showUnitQty !== false ? ' checked' : '') + '> Show quantities</label>' +
        '</div>' +
      '</div>' +
      (lineCards ? '<h3>Line descriptions</h3>' + lineCards : '');

    var preview = '' +
      '<div class="card">' +
        '<div class="preview-bar">' +
          '<div class="seg" role="group" aria-label="Preview">' +
            '<button type="button" data-act="preview" data-mode="proposal" aria-pressed="' + (state.previewMode === 'proposal') + '">GC proposal</button>' +
            '<button type="button" data-act="preview" data-mode="internal" aria-pressed="' + (state.previewMode === 'internal') + '">Internal take-off</button>' +
          '</div>' +
          '<span class="spacer"></span>' +
          '<button type="button" data-act="print" data-mode="internal">Print internal</button>' +
          '<button type="button" class="primary" data-act="print" data-mode="proposal">Print proposal</button>' +
        '</div>' +
        (state.priced.totals.linesMissingRates ? messages([{ level: 'error', message: state.priced.totals.linesMissingRates +
          ' line(s) still need material $ and/or install sf/day. Enter them on the Pricing tab before sending this quote.' }]) : '') +
        (state.priced.totals.linesMissingRooms ? messages([{ level: 'warn', message: state.priced.totals.linesMissingRooms +
          ' line(s) need a count for the scope of work, e.g. "(3) ROOMS @ 8\' AFF". Enter it under Scope of work on the Pricing tab.' }]) : '') +
        '<div class="preview" id="preview">' + Q.render(q, state.priced, state.settings, state.previewMode) + '</div>' +
        '<p class="hint">Print opens the browser print dialog — choose <strong>Save as PDF</strong> as the destination.</p>' +
      '</div>';

    return '<div class="quote-layout">' + form + preview + '</div>';
  }

  /* ---------- Settings panel ---------- */

  function fmtVal(field, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (field === 'materialRate') return U.formatMoney(v);
    if (field === 'unit') return String(v).toUpperCase();
    return String(v);
  }

  function renderPriceListCard() {
    var s = state.settings;
    var pl = s.priceList;
    var pend = state.pendingPriceList;
    var status = pl
      ? 'Last imported: <strong>' + esc(pl.fileName) + '</strong>' + (pl.sheetName && pl.sheetName !== pl.fileName ? ' (sheet “' + esc(pl.sheetName) + '”)' : '') +
        ' on ' + esc(new Date(pl.importedAt).toLocaleString()) + ' · ' + pl.itemCount + ' item' + (pl.itemCount === 1 ? '' : 's')
      : 'No price list imported yet. Click <strong>Download as Excel</strong> to get a spreadsheet in the right layout (it starts with your current catalog), fill in your materials and costs, then import it.';

    var modeHint = '';
    if (pl && s.rateEntry !== 'catalog') {
      modeHint = '<ul class="messages"><li class="info">New quotes are set to <strong>type in material $ and sf/day on each line</strong>, so the price list is not used yet. ' +
        '<button type="button" class="small" data-act="use-catalog-rates">Use price list on new quotes</button></li></ul>';
    }

    var preview = '';
    if (pend) {
      var rows = [];
      pend.added.forEach(function (it) {
        rows.push('<tr><td><strong>' + esc(it.subject) + '</strong></td><td><span class="pill">new</span></td><td>' + esc(it.description || '') + '</td>' +
          '<td>' + fmtVal('unit', it.unit || 'sf') + '</td><td class="num">' + fmtVal('materialRate', it.materialRate) + '</td><td class="num">' + fmtVal('unitsPerDay', it.unitsPerDay) + '</td></tr>');
      });
      pend.updated.forEach(function (u) {
        u.changes.forEach(function (ch, j) {
          rows.push('<tr><td>' + (j ? '' : '<strong>' + esc(u.subject) + '</strong>') + '</td><td>' + esc(ch.label) + '</td>' +
            '<td colspan="4">' + esc(fmtVal(ch.field, ch.from)) + ' &rarr; <strong>' + esc(fmtVal(ch.field, ch.to)) + '</strong></td></tr>');
        });
      });
      var nothing = !pend.added.length && !pend.updated.length;
      preview = '' +
        '<div class="card" style="background:#fafbfc;margin-top:12px">' +
          '<div class="card-head"><h3>Review: ' + esc(pend.fileName) + (pend.sheetName && pend.sheetName !== pend.fileName ? ' · sheet “' + esc(pend.sheetName) + '”' : '') + '</h3>' +
            '<div class="row"><button type="button" data-act="pricelist-cancel">Cancel</button>' +
            '<button type="button" class="primary" data-act="pricelist-apply"' + (nothing ? ' disabled' : '') + '>Apply to catalog</button></div></div>' +
          '<p>' + pend.itemCount + ' item' + (pend.itemCount === 1 ? '' : 's') + ' in the file: <strong>' + pend.added.length + ' new</strong>, <strong>' +
            pend.updated.length + ' changed</strong>, ' + pend.unchanged + ' unchanged.' +
            (pend.notInList.length ? ' ' + pend.notInList.length + ' catalog item' + (pend.notInList.length === 1 ? ' is' : 's are') + ' not in the file and will be kept (' + esc(pend.notInList.slice(0, 8).join(', ')) + (pend.notInList.length > 8 ? ', …' : '') + ').' : '') +
          '</p>' +
          messages(pend.warnings.map(function (w) { return { level: 'warn', message: w }; })) +
          (rows.length ? '<div class="table-wrap" style="max-height:420px;overflow:auto"><table class="data"><thead><tr><th>Item</th><th>Change</th><th>Description</th><th>Unit</th><th class="num">Material $</th><th class="num">Install rate</th></tr></thead><tbody>' +
            rows.join('') + '</tbody></table></div>' : '<p class="muted">Nothing to change — the catalog already matches this file.</p>') +
        '</div>';
    }

    return '' +
      '<div class="card">' +
        '<div class="card-head"><h3>Material price list (Excel)</h3>' +
          '<div class="row">' +
            '<button type="button" data-act="pricelist-template">Download as Excel…</button>' +
            '<button type="button" class="primary" data-act="pick-pricelist">Import price list…</button>' +
            '<input type="file" id="file-pricelist" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>' +
          '</div></div>' +
        '<p class="hint" style="margin:0">' + status + '</p>' +
        modeHint +
        preview +
      '</div>';
  }

  function renderSettings() {
    var s = state.settings;
    var c = s.company;
    var filt = String(state.catFilter || '').trim().toLowerCase();
    var shown = 0;
    var cat = s.catalog.map(function (it, i) {
      if (filt && [it.subject, it.code, it.description].join(' ').toLowerCase().indexOf(filt) === -1) return '';
      shown++;
      return '<tr>' +
        '<td>' + textInput('c-subj-' + i, it.subject, ' data-cat="' + i + '" data-f="subject" style="min-width:110px"') + '</td>' +
        '<td>' + textInput('c-code-' + i, it.code || '', ' data-cat="' + i + '" data-f="code" style="min-width:110px"') + '</td>' +
        '<td>' + textInput('c-desc-' + i, it.description || '', ' data-cat="' + i + '" data-f="description" style="min-width:220px"') + '</td>' +
        '<td><textarea rows="2" id="c-scope-' + i + '" data-cat="' + i + '" data-f="scope" style="min-width:240px">' + esc(it.scope || '') + '</textarea></td>' +
        '<td><select id="c-unit-' + i + '" data-cat="' + i + '" data-f="unit" style="min-width:68px">' + options([['sf', 'SF'], ['lf', 'LF'], ['ea', 'EA']], it.unit) + '</select></td>' +
        '<td>' + numInput('c-rate-' + i, it.materialRate, ' data-cat="' + i + '" data-f="materialRate" class="num w-xs"') + '</td>' +
        '<td>' + numInput('c-pd-' + i, it.unitsPerDay, ' data-cat="' + i + '" data-f="unitsPerDay" class="num w-xs"') + '</td>' +
        '<td>' + numInput('c-rt-' + i, it.roundTo === undefined ? '' : it.roundTo, ' data-cat="' + i + '" data-f="roundTo" class="num w-xs" placeholder="' + (it.unit === 'sf' ? 'default' : '1') + '"') + '</td>' +
        '<td><button type="button" class="small danger" data-act="del-cat" data-i="' + i + '" title="Delete item">✕</button></td>' +
        '</tr>';
    }).join('');

    var mapKeys = Object.keys(s.subjectMap).sort();
    var maps = mapKeys.map(function (k, i) {
      var opts = s.catalog.map(function (it) { return [it.subject, it.subject]; });
      opts.push([P.IGNORE, 'Ignore']);
      if (s.subjectMap[k] !== P.IGNORE && !P.findCatalogItem(s.catalog, s.subjectMap[k])) opts.unshift([s.subjectMap[k], s.subjectMap[k] + ' (missing)']);
      return '<tr><td>' + esc(k) + '</td><td><select id="sm-' + i + '" data-smap="' + esc(k) + '">' + options(opts, s.subjectMap[k]) + '</select></td>' +
        '<td><button type="button" class="small danger" data-act="del-smap" data-k="' + esc(k) + '">✕</button></td></tr>';
    }).join('');

    return '' +
      '<p class="muted">Settings are saved in this browser automatically. Rate and catalog changes apply to <strong>new</strong> quotes; to apply them to the open quote, use <em>Pricing → Reload rates from Settings</em>. Use <strong>Export settings</strong> to keep a backup file.</p>' +
      '<div class="card">' +
        '<div class="card-head"><h3>Backup</h3></div>' +
        '<div class="row">' +
          '<button type="button" data-act="export-settings">Export settings…</button>' +
          '<button type="button" data-act="import-settings">Import settings…</button>' +
          '<input type="file" id="file-settings" accept=".json,application/json" hidden>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="danger" data-act="reset-settings">Reset to defaults</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>Company</h3>' +
        '<div class="grid wide">' +
          field('Company name', textInput('s-cname', c.name, ' data-s="company.name"')) +
          field('Address', textInput('s-caddr', c.address, ' data-s="company.address"')) +
          field('Phone', textInput('s-cphone', c.phone, ' data-s="company.phone"')) +
          field('Email', textInput('s-cemail', c.email, ' data-s="company.email"')) +
          field('License #', textInput('s-clic', c.license, ' data-s="company.license"')) +
          '<div class="field"><span>Logo</span>' +
            (c.logoDataUrl ? '<img class="logo-preview" src="' + esc(c.logoDataUrl) + '" alt="Logo">' : '') +
            '<div class="row"><button type="button" data-act="pick-logo">' + (c.logoDataUrl ? 'Replace logo…' : 'Upload logo…') + '</button>' +
            (c.logoDataUrl ? '<button type="button" class="danger" data-act="del-logo">Remove</button>' : '') + '</div>' +
            '<input type="file" id="file-logo" accept="image/*" hidden></div>' +
        '</div>' +
      '</div>' +
      renderPriceListCard() +
      '<div class="card">' +
        '<div class="card-head"><h3>Catalog <span class="muted" style="font-weight:400">(' + s.catalog.length + ' item' + (s.catalog.length === 1 ? '' : 's') + ')</span></h3>' +
          '<div class="row"><input type="text" id="cat-filter" placeholder="Search items…" style="width:200px"' + attr('value', state.catFilter || '') + '>' +
          '<button type="button" data-act="add-cat">Add item</button></div></div>' +
        '<p class="hint">The <strong>Subject</strong> must match the Bluebeam markup Subject (without the “(2)” group count), or be mapped to it on the Import tab. ' +
          'The $ / unit and Units / day columns are only used when <em>Material $ &amp; install rate</em> (below) is set to <em>Pre-fill from catalog</em>. ' +
          'SF items: material $ per sf, sf installed per day. LF items use Measurement (ft). EA items count markups. Units/day 0 = material only.</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Subject</th><th>Code</th><th>Description</th><th>Scope paragraph</th><th>Unit</th><th>$ / unit</th><th>Units / day</th><th>Round up to</th><th></th></tr></thead>' +
        '<tbody>' + (cat || '<tr><td colspan="9" class="muted">' + (filt ? 'No items match “' + esc(state.catFilter) + '”.' : 'No catalog items.') + '</td></tr>') + '</tbody></table></div>' +
        (filt && shown ? '<p class="hint">Showing ' + shown + ' of ' + s.catalog.length + '.</p>' : '') +
      '</div>' +
      '<div class="card">' +
        '<h3>Labor &amp; quantities</h3>' +
        '<div class="grid">' +
          field('Hourly rate ($)', numInput('s-hourly', s.labor.hourlyRate, ' data-s="labor.hourlyRate"')) +
          field('Hours / day', numInput('s-hours', s.labor.hoursPerDay, ' data-s="labor.hoursPerDay"')) +
          field('Per diem + vehicle ($/day)', numInput('s-adder', s.labor.dailyAdder, ' data-s="labor.dailyAdder"')) +
          field('Labor cost / day (all-in)', '<input type="text" class="num" readonly tabindex="-1" id="s-dayrate" title="Hourly × hours + per diem & vehicle" value="' + esc(U.formatMoney(P.dayRate(s.labor))) + '">') +
          field('Round labor days', '<select id="s-dayround" data-s="labor.dayRounding">' + options([['none', 'No rounding'], ['half', 'Up to ½ day'], ['whole', 'Up to whole day']], s.labor.dayRounding) + '</select>') +
          field('SF quantity from', '<select id="s-source" data-s="quantity.source">' + options([['wasteSqFt', 'Waste Sq FT. column'], ['sqFt', 'SQ. FT column + waste %'], ['calc', 'Length × Install Ht + waste %']], s.quantity.source) + '</select>') +
          field('Round SF up to (0 = none)', numInput('s-roundto', s.quantity.roundTo, ' data-s="quantity.roundTo"')) +
          field('Waste %', numInput('s-waste', s.quantity.wastePct, ' data-s="quantity.wastePct"')) +
          field('Material $ & install rate', '<select id="s-rateentry" data-s="rateEntry">' +
            options([['manual', 'Type in on each quote'], ['catalog', 'Pre-fill from catalog']], s.rateEntry || 'manual') + '</select>') +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>Terms &amp; numbering</h3>' +
        '<div class="grid">' +
          field('Quote valid for (days)', numInput('s-valid', s.terms.validDays, ' data-s="terms.validDays"')) +
          field('Sales tax on material (%)', numInput('s-tax', s.terms.taxPct, ' data-s="terms.taxPct"')) +
          field('Quote # prefix', textInput('s-prefix', s.quote.prefix, ' data-s="quote.prefix"')) +
          field('Next quote #', numInput('s-next', s.quote.nextNumber, ' data-s="quote.nextNumber"')) +
        '</div>' +
        '<div style="margin-top:10px">' + field('Default notes / exclusions (one per line)', '<textarea rows="4" id="s-notes" data-s="terms.notes" data-lines="1">' + esc((s.terms.notes || []).join('\n')) + '</textarea>') + '</div>' +
        '<div class="row" style="margin-top:10px">' +
          '<span class="field"><span>GC proposal defaults</span></span>' +
          '<label class="check"><input type="checkbox" id="s-lump" data-s="proposal.lumpSum"' + (s.proposal.lumpSum ? ' checked' : '') + '> Lump sum only</label>' +
          '<label class="check"><input type="checkbox" id="s-split" data-s="proposal.showSplit"' + (s.proposal.showSplit ? ' checked' : '') + '> Show material / labor split</label>' +
          '<label class="check"><input type="checkbox" id="s-qty" data-s="proposal.showUnitQty"' + (s.proposal.showUnitQty !== false ? ' checked' : '') + '> Show quantities</label>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>Remembered subject mappings</h3>' +
        (maps ? '<div class="table-wrap"><table class="data"><thead><tr><th>Bluebeam subject</th><th>Prices as</th><th></th></tr></thead><tbody>' + maps + '</tbody></table></div>'
          : '<p class="muted">None yet. Mappings you choose on the Import tab are remembered here.</p>') +
      '</div>';
  }

  /* ================= actions ================= */

  function guessFromFileName(name) {
    // "Mels_Drive_in_-_San_Francisco_-_Generals.csv" -> project "Mels Drive in", GC "Generals"
    var base = String(name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    var parts = base.split(/\s+-\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return null;
    return { project: parts[0], gc: parts.length >= 3 ? parts[parts.length - 1] : '' };
  }

  function importCsvFile(file) {
    S.readText(file).then(function (text) {
      var parsed;
      try { parsed = global.Parse.parseCsvText(text); } catch (e) { toast(e.message, true); return; }
      var fatal = parsed.warnings.filter(function (w) { return w.level === 'error'; });
      if (!parsed.rows.length) { toast(fatal.length ? fatal[0].message : 'No markup rows found.', true); return; }
      var q = state.quote;
      if (q.source && !global.confirm('Replace the current takeoff (' + (q.source.fileName || 'CSV') + ') with ' + file.name + '?\nLine overrides on this quote will be cleared.')) return;

      q.source = {
        fileName: file.name,
        importedAt: new Date().toISOString(),
        headers: parsed.headers,
        rows: parsed.rows,
        subtotals: parsed.subtotals,
        warnings: parsed.warnings
      };
      q.excludedRows = {};
      q.lineOverrides = {};

      // Bring remembered mappings (and the catalog items they point at) into this quote.
      parsed.rows.forEach(function (r) {
        var m = state.settings.subjectMap[r.baseSubject];
        if (m && q.rates.subjectMap[r.baseSubject] === undefined) {
          q.rates.subjectMap[r.baseSubject] = m;
          if (m !== P.IGNORE) ensureQuoteHasItem(m);
        }
        if (!P.findCatalogItem(q.rates.catalog, r.baseSubject)) ensureQuoteHasItem(r.baseSubject);
      });

      var g = guessFromFileName(file.name);
      var filled = [];
      if (g) {
        if (!q.project.name && g.project) { q.project.name = g.project; filled.push('project "' + g.project + '"'); }
        if (!q.gc.name && g.gc) { q.gc.name = g.gc; filled.push('GC "' + g.gc + '"'); }
      }
      if (filled.length) q.source.autoFilled = 'Filled in ' + filled.join(' and ') + ' from the file name. Check them on the Quote tab.';

      state.tab = 'import';
      changed();
      toast('Imported ' + parsed.rows.length + ' markup rows from ' + file.name);
    }, function (e) { toast(e.message, true); });
  }

  function newQuote() {
    if (state.dirty && !global.confirm('Discard the unsaved changes to ' + state.quote.number + '?')) return;
    state.settings = S.loadSettings();
    state.quote = Q.newQuote(state.settings);
    state.dirty = false;
    recompute();
    state.tab = 'import';
    saveDraft();
    render();
  }

  function openQuoteFile(file) {
    S.readJson(file).then(function (json) {
      var q = Q.fromFile(json, state.settings);
      if (state.dirty && !global.confirm('Discard the unsaved changes to ' + state.quote.number + '?')) return;
      state.quote = q;
      state.dirty = false;
      recompute();
      state.tab = 'quote';
      saveDraft();
      render();
      toast('Opened ' + q.number);
    }).catch(function (e) { toast(e.message, true); });
  }

  function saveQuote() {
    var q = state.quote;
    var before = { number: q.number, committed: q.numberCommitted, next: state.settings.quote.nextNumber };
    Q.commitNumber(q, state.settings);
    S.saveJsonFile(Q.toFile(q), Q.fileName(q)).then(function (saved) {
      if (!saved) {
        q.number = before.number; q.numberCommitted = before.committed; state.settings.quote.nextNumber = before.next;
        return;
      }
      S.saveSettings(state.settings);
      state.dirty = false;
      saveDraft();
      render();
      toast('Saved ' + q.number);
    }).catch(function (e) {
      q.number = before.number; q.numberCommitted = before.committed; state.settings.quote.nextNumber = before.next;
      toast('Could not save: ' + e.message, true);
    });
  }

  function printDoc(mode) {
    var missing = state.priced.totals.linesMissingRates;
    var noRooms = state.priced.totals.linesMissingRooms;
    var problems = [];
    if (missing) problems.push(missing + ' line' + (missing === 1 ? ' is' : 's are') + ' missing material $ or install sf/day, so the total is too low.');
    if (noRooms) problems.push(noRooms + ' line' + (noRooms === 1 ? ' has' : 's have') + ' no count, so the scope of work won\'t say "(X) ROOMS / AREAS".');
    if (problems.length && !global.confirm(problems.join('\n') + '\nPrint anyway?')) return;
    var root = $('#print-root');
    root.innerHTML = Q.render(state.quote, state.priced, state.settings, mode);
    var oldTitle = doc.title;
    // Chrome uses the page title as the default PDF file name.
    doc.title = S.safeFileName(Q.fileName(state.quote) + (mode === 'proposal' ? ' Proposal' : ' Take-off'));
    var restore = function () { doc.title = oldTitle; global.removeEventListener('afterprint', restore); };
    global.addEventListener('afterprint', restore);
    global.print();
    setTimeout(restore, 1000);
  }

  function setMapping(subject, value) {
    var q = state.quote;
    if (value) {
      q.rates.subjectMap[subject] = value;
      state.settings.subjectMap[subject] = value;
      if (value !== P.IGNORE) ensureQuoteHasItem(value);
    } else {
      delete q.rates.subjectMap[subject];
      delete state.settings.subjectMap[subject];
      ensureQuoteHasItem(subject);
    }
    S.saveSettings(state.settings);
    changed();
  }

  function setLineOverride(key, f, value) {
    var ov = state.quote.lineOverrides[key] || (state.quote.lineOverrides[key] = {});
    // Clearing these fields goes back to the automatic value.
    var numeric = { qty: 1, height: 1, materialRate: 1, unitsPerDay: 1, rooms: 1, scopeLabel: 1, laborDays: 1 };
    // (scopeNote is NOT cleared on blank: an empty note is a deliberate "no note".)
    if (numeric[f] && String(value).trim() === '') delete ov[f];
    else ov[f] = value;
    if (!Object.keys(ov).length) delete state.quote.lineOverrides[key];
  }

  /* ================= events ================= */

  function onInput(e) {
    var t = e.target;
    var panel = t.closest('.panel');
    if (!panel) return;
    var isText = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio' && t.type !== 'date');
    // Text fields update on 'input'; selects/checkboxes/radios/dates on 'change'.
    if (e.type === 'input' && !isText) return;
    // Text fields were already applied on 'input'. Re-rendering again on blur would replace the
    // button the user is clicking, so do nothing here.
    if (e.type === 'change' && isText) return;
    var full = panel.dataset.panel === 'pricing' || panel.dataset.panel === 'import';

    if (t.dataset.q !== undefined) {
      var path = t.dataset.q;
      var v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.type === 'radio') { if (!t.checked) return; v = t.value; }
      setPath(state.quote, path, v);
      if (path === 'number') state.quote.numberCommitted = true;
      changed(full ? 'full' : 'light');
      return;
    }
    if (t.dataset.line !== undefined) {
      var key = t.dataset.line;
      var f = t.dataset.ov;
      if (f === 'excluded') setLineOverride(key, f, !t.checked ? true : '');
      else setLineOverride(key, f, t.value);
      if (f === 'excluded' && t.checked) { var o = state.quote.lineOverrides[key]; if (o) { delete o.excluded; if (!Object.keys(o).length) delete state.quote.lineOverrides[key]; } }
      changed(full ? 'full' : 'light');
      return;
    }
    if (t.dataset.row !== undefined) {
      if (t.checked) delete state.quote.excludedRows[t.dataset.row];
      else state.quote.excludedRows[t.dataset.row] = true;
      changed();
      return;
    }
    if (t.dataset.map !== undefined) { setMapping(t.dataset.map, t.value); return; }

    // ----- settings -----
    if (t.id === 'cat-filter') { state.catFilter = t.value; render(); return; }
    if (t.dataset.s !== undefined) {
      var sv;
      if (t.type === 'checkbox') sv = t.checked;
      else if (t.dataset.lines) sv = t.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      else if (t.classList.contains('num')) sv = parseNumOrRaw(t.value);
      else sv = t.value;
      setPath(state.settings, t.dataset.s, sv);
      settingsChanged();
      var dr = $('#s-dayrate');
      if (dr) dr.value = U.formatMoney(P.dayRate(state.settings.labor));
      return;
    }
    if (t.dataset.cat !== undefined) {
      var it = state.settings.catalog[+t.dataset.cat];
      if (!it) return;
      var cf = t.dataset.f;
      if (cf === 'roundTo') {
        if (t.value.trim() === '') delete it.roundTo; else it.roundTo = parseNumOrRaw(t.value);
      } else if (cf === 'materialRate' || cf === 'unitsPerDay') {
        it[cf] = parseNumOrRaw(t.value);
      } else {
        it[cf] = t.value;
      }
      settingsChanged(cf === 'unit' ? 'full' : 'light');
      return;
    }
    if (t.dataset.smap !== undefined) {
      state.settings.subjectMap[t.dataset.smap] = t.value;
      settingsChanged('full');
    }
  }

  function onClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    var q = state.quote;
    var s = state.settings;
    switch (act) {
      case 'pick-csv': $('#file-csv').click(); break;
      case 'goto': setTab(b.dataset.tab); break;
      case 'new-cat': {
        var subj = b.dataset.subject;
        if (!P.findCatalogItem(s.catalog, subj)) {
          s.catalog.push(P.normalizeCatalogItem({ subject: subj, code: '', description: subj, scope: '', unit: 'sf', materialRate: 0, unitsPerDay: 0 }));
          S.saveSettings(s);
        }
        ensureQuoteHasItem(subj);
        recompute();
        state.tab = 'settings';
        render();
        toast('Added "' + subj + '" to the catalog. Fill in its rates below, then use Pricing → Reload rates from Settings.');
        var idx = s.catalog.length - 1;
        var el = doc.getElementById('c-desc-' + idx);
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); }
        break;
      }
      case 'reload-rates':
        if (!global.confirm('Replace this quote\'s labor rates, quantity settings and catalog prices with the current Settings?')) return;
        q.rates = Q.ratesFromSettings(s);
        q.rates.subjectMap = Object.assign({}, s.subjectMap, q.rates.subjectMap);
        q.taxPct = s.terms.taxPct || 0;
        changed();
        toast('Rates reloaded from Settings');
        break;
      case 'reset-line': {
        var old = q.lineOverrides[b.dataset.line] || {};
        var keep = {};
        if (q.rates.rateEntry !== 'catalog') {   // typed-in rates are data, not overrides
          if (old.materialRate !== undefined) keep.materialRate = old.materialRate;
          if (old.unitsPerDay !== undefined) keep.unitsPerDay = old.unitsPerDay;
        }
        if (Object.keys(keep).length) q.lineOverrides[b.dataset.line] = keep;
        else delete q.lineOverrides[b.dataset.line];
        changed();
        break;
      }
      case 'reset-ov': {
        var ov = q.lineOverrides[b.dataset.line];
        if (ov) { delete ov[b.dataset.ov]; if (!Object.keys(ov).length) delete q.lineOverrides[b.dataset.line]; }
        changed();
        break;
      }
      case 'add-manual': {
        var subj2 = $('#add-item').value;
        var qtyV = U.parseNumber($('#add-qty').value);
        if (!subj2) return;
        if (qtyV === null) { toast('Enter a quantity for the new line.', true); $('#add-qty').focus(); return; }
        ensureQuoteHasItem(subj2);
        q.manualLines.push({ id: 'm' + Date.now().toString(36), catalogSubject: subj2, qty: qtyV, height: $('#add-height').value });
        changed();
        break;
      }
      case 'del-manual':
        q.manualLines = q.manualLines.filter(function (m) { return m.id !== b.dataset.id; });
        delete q.lineOverrides['manual|' + b.dataset.id];
        changed();
        break;
      case 'preview':
        state.previewMode = b.dataset.mode;
        saveDraft();
        render();
        break;
      case 'print': printDoc(b.dataset.mode); break;
      case 'add-cat':
        s.catalog.push(P.normalizeCatalogItem({ subject: '', code: '', description: '', scope: '', unit: 'sf', materialRate: 0, unitsPerDay: 0 }));
        settingsChanged('full');
        var nf = doc.getElementById('c-subj-' + (s.catalog.length - 1));
        if (nf) nf.focus();
        break;
      case 'del-cat': {
        var item = s.catalog[+b.dataset.i];
        if (item && global.confirm('Delete catalog item "' + (item.subject || item.description || 'untitled') + '"?')) {
          s.catalog.splice(+b.dataset.i, 1);
          settingsChanged('full');
        }
        break;
      }
      case 'del-smap':
        delete s.subjectMap[b.dataset.k];
        settingsChanged('full');
        break;
      case 'pick-pricelist': $('#file-pricelist').click(); break;
      case 'pricelist-template':
        S.downloadBlob(global.PriceList.templateBlob(s.catalog), 'Material Price List.xlsx');
        toast('Downloaded Material Price List.xlsx');
        break;
      case 'pricelist-cancel':
        state.pendingPriceList = null;
        render();
        break;
      case 'pricelist-apply': {
        var pend = state.pendingPriceList;
        if (!pend) return;
        global.PriceList.apply(s, pend);
        state.pendingPriceList = null;
        S.saveSettings(s);
        syncPristineQuote();
        render();
        toast('Price list applied: ' + pend.added.length + ' new, ' + pend.updated.length + ' changed. Open quotes keep their rates until you use Pricing → Reload rates.');
        break;
      }
      case 'use-catalog-rates':
        s.rateEntry = 'catalog';
        settingsChanged('full');
        toast('New quotes will pre-fill material $ and install rate from the catalog. Blank values still need typing in.');
        break;
      case 'pick-logo': $('#file-logo').click(); break;
      case 'del-logo':
        s.company.logoDataUrl = '';
        settingsChanged('full');
        break;
      case 'export-settings':
        S.saveJsonFile({ kind: 'revu-quote-builder/settings', version: 1, exportedAt: new Date().toISOString(), settings: s },
          'revu-quote-builder-settings ' + U.toISODate(new Date()))
          .then(function (ok) { if (ok) toast('Settings exported'); });
        break;
      case 'import-settings': $('#file-settings').click(); break;
      case 'reset-settings':
        if (!global.confirm('Reset ALL settings (catalog, rates, company info, mappings) to the defaults?\nExport a backup first if you may need them.')) return;
        state.settings = S.resetSettings();
        syncPristineQuote();
        render();
        toast('Settings reset to defaults');
        break;
    }
  }

  function importSettingsFile(file) {
    S.readJson(file).then(function (json) {
      var incoming = json && json.kind === 'revu-quote-builder/settings' ? json.settings : json;
      if (!incoming || !Array.isArray(incoming.catalog)) throw new Error(file.name + ' does not look like a settings export.');
      if (!global.confirm('Replace the current settings with ' + file.name + '?')) return;
      state.settings = S.normalizeSettings(incoming);
      S.saveSettings(state.settings);
      syncPristineQuote();
      render();
      toast('Settings imported');
    }).catch(function (e) { toast(e.message, true); });
  }

  function onFileChange(e) {
    var t = e.target;
    if (t.type !== 'file' || !t.files || !t.files[0]) return;
    var file = t.files[0];
    if (t.id === 'file-csv') importCsvFile(file);
    else if (t.id === 'file-open-quote') openQuoteFile(file);
    else if (t.id === 'file-settings') importSettingsFile(file);
    else if (t.id === 'file-pricelist') {
      global.PriceList.planFromFile(file, state.settings.catalog).then(function (pl) {
        state.pendingPriceList = pl;
        state.tab = 'settings';
        render();
      }).catch(function (err) { toast(err.message, true); });
    }
    else if (t.id === 'file-logo') {
      if (file.size > 600 * 1024) { toast('Please use a logo smaller than 600 KB (it is stored in the browser).', true); t.value = ''; return; }
      S.readDataUrl(file).then(function (url) {
        state.settings.company.logoDataUrl = url;
        settingsChanged('full');
      });
    }
    t.value = '';
  }

  function bindDragDrop() {
    var depth = 0;
    global.addEventListener('dragenter', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) { depth++; doc.body.classList.add('dragging'); }
    });
    global.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) doc.body.classList.remove('dragging'); });
    global.addEventListener('dragover', function (e) { e.preventDefault(); });
    global.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      doc.body.classList.remove('dragging');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/\.xlsx$/i.test(f.name)) {
        global.PriceList.planFromFile(f, state.settings.catalog).then(function (pl) {
          state.pendingPriceList = pl;
          state.tab = 'settings';
          render();
        }).catch(function (err) { toast(err.message, true); });
      } else if (/\.csv$/i.test(f.name) || f.type === 'text/csv') importCsvFile(f);
      else if (/\.json$/i.test(f.name)) {
        S.readJson(f).then(function (json) {
          if (json && json.kind === Q.FILE_KIND) openQuoteFile(f);
          else importSettingsFile(f);
        }).catch(function (err) { toast(err.message, true); });
      } else toast('Drop a Bluebeam .csv, a price list .xlsx, a saved quote .json, or a settings .json.', true);
    });
  }

  function init() {
    state.settings = S.loadSettings();
    var draft = S.loadDraft();
    if (draft && draft.quote) {
      try {
        state.quote = Q.normalizeQuote(draft.quote, state.settings);
        state.dirty = !!draft.dirty;
        state.tab = draft.tab || (state.quote.source ? 'pricing' : 'import');
        state.previewMode = draft.previewMode || 'proposal';
      } catch (e) { state.quote = null; }
    }
    if (!state.quote) state.quote = Q.newQuote(state.settings);
    recompute();

    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (b) setTab(b.dataset.tab);
    });
    $('#btn-new').addEventListener('click', newQuote);
    $('#btn-open').addEventListener('click', function () { $('#file-open-quote').click(); });
    $('#btn-save').addEventListener('click', saveQuote);
    var main = $('main');
    main.addEventListener('input', onInput);
    main.addEventListener('change', onInput);
    main.addEventListener('click', onClick);
    doc.addEventListener('change', onFileChange);
    bindDragDrop();
    global.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveQuote(); }
    });
    global.addEventListener('beforeunload', function () { saveDraft(); });

    render();
  }

  global.App = { state: state, init: init, importCsvFile: importCsvFile, guessFromFileName: guessFromFileName };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
