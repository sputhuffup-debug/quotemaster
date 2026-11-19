/* quote.js — quote model, numbering, save-file format and printable rendering.  Exposes window.Quote. */
(function (global) {
  'use strict';

  var U = global.Units;
  var FILE_KIND = 'revu-quote-builder/quote';
  var FILE_VERSION = 1;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escMultiline(s) { return esc(s).replace(/\r?\n/g, '<br>'); }

  /** Scope label that only wraps between chunks: "(7) AREAS" | "@ 10' AFF" | "o/ CMU". */
  function scopeLabelHtml(s) {
    return esc(s)
      .replace(/^\((\d+)\) /, '($1)&nbsp;')
      .replace(/ @ /g, ' @&nbsp;')
      .replace(/ AFF\b/g, '&nbsp;AFF')
      .replace(/\bo\/ /g, 'o/&nbsp;');
  }

  /** Snapshot of the rates a quote is priced with (so a saved quote re-opens with its original numbers). */
  function ratesFromSettings(settings) {
    return {
      catalog: clone(settings.catalog),
      labor: clone(settings.labor),
      quantity: clone(settings.quantity),
      subjectMap: clone(settings.subjectMap || {}),
      rateEntry: settings.rateEntry === 'catalog' ? 'catalog' : 'manual',
      bayAreaCities: clone(settings.bayAreaCities || []),
      priceList: settings.priceList ? clone(settings.priceList) : null
    };
  }

  function newQuote(settings) {
    return {
      number: (settings.quote.prefix || '') + settings.quote.nextNumber,
      numberCommitted: false,
      date: U.toISODate(new Date()),
      gc: { name: '', attention: '' },
      project: { name: '', address: '' },
      constructionType: '',
      notes: (settings.terms.notes || []).join('\n'),
      validDays: settings.terms.validDays,
      taxPct: settings.terms.taxPct || 0,
      proposal: clone(settings.proposal || { showSplit: false, lumpSum: false, showUnitQty: true }),
      groupByRoom: false,
      laborZone: 'auto',     // union rate: "auto" (from the project city) | "local" | "bay"
      source: null,          // { fileName, importedAt, headers, rows, subtotals, warnings }
      excludedRows: {},
      manualLines: [],
      lineOverrides: {},
      rates: ratesFromSettings(settings)
    };
  }

  /** Fill in fields an older/partial quote file may be missing. */
  function normalizeQuote(q, settings) {
    var base = newQuote(settings);
    var out = Object.assign(base, q || {});
    out.gc = Object.assign({ name: '', attention: '' }, out.gc || {});
    out.project = Object.assign({ name: '', address: '' }, out.project || {});
    out.proposal = Object.assign({ showSplit: false, lumpSum: false, showUnitQty: true }, out.proposal || {});
    out.excludedRows = out.excludedRows || {};
    out.manualLines = out.manualLines || [];
    out.lineOverrides = out.lineOverrides || {};
    out.rates = out.rates || ratesFromSettings(settings);
    out.rates.catalog = (out.rates.catalog || []).map(global.Pricing.normalizeCatalogItem);
    out.rates.subjectMap = out.rates.subjectMap || {};
    // Quotes saved before manual rate entry existed were priced from the catalog; keep their numbers.
    if (out.rates.rateEntry !== 'manual' && out.rates.rateEntry !== 'catalog') out.rates.rateEntry = 'catalog';
    out.rates.labor = Object.assign({}, settings.labor, out.rates.labor || {});
    if (!Array.isArray(out.rates.bayAreaCities)) out.rates.bayAreaCities = clone(settings.bayAreaCities || []);
    // Quotes saved before the two union rates existed were priced at the one (local) rate: keep that.
    if (q && q.laborZone === undefined) out.laborZone = 'local';
    out.rates.quantity = Object.assign({}, settings.quantity, out.rates.quantity || {});
    if (Array.isArray(out.notes)) out.notes = out.notes.join('\n');
    return out;
  }

  /**
   * Called on save: the first save of a quote takes the next number from settings and bumps it.
   * Returns true when settings changed (caller should persist them).
   */
  function commitNumber(quote, settings) {
    if (quote.numberCommitted) return false;
    quote.number = (settings.quote.prefix || '') + settings.quote.nextNumber;
    quote.numberCommitted = true;
    settings.quote.nextNumber = (parseInt(settings.quote.nextNumber, 10) || 0) + 1;
    return true;
  }

  function toFile(quote) {
    return { kind: FILE_KIND, version: FILE_VERSION, savedAt: new Date().toISOString(), quote: quote };
  }

  function fromFile(json, settings) {
    if (!json || json.kind !== FILE_KIND || !json.quote) {
      throw new Error('This file is not a saved quote from Revu Quote Builder.');
    }
    return normalizeQuote(json.quote, settings);
  }

  function fileName(quote) {
    var parts = [quote.number, quote.project && quote.project.name].filter(Boolean);
    return parts.join(' ') || 'quote';
  }

  function unitLabel(unit) {
    return { sf: 'SQ FT', lf: 'LF', ea: 'EA' }[unit] || String(unit || '').toUpperCase();
  }

  function notesList(quote) {
    return String(quote.notes || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function expiryDate(quote) {
    var d = U.parseISODate(quote.date);
    if (!d || !quote.validDays) return null;
    d.setDate(d.getDate() + (parseInt(quote.validDays, 10) || 0));
    return d;
  }

  /* ---------- rendering ---------- */

  function renderHeader(quote, settings, title) {
    var c = settings.company || {};
    var contact = [c.phone, c.email].filter(Boolean).map(esc).join(' &middot; ');
    var exp = expiryDate(quote);
    var banner = c.logoDataUrl && c.logoLayout === 'banner';
    var license = c.license ? (/lic/i.test(c.license) ? esc(c.license) : 'Lic. ' + esc(c.license)) : '';
    // A letterhead logo already shows name, address and licenses: print only the phone / email under it.
    var company = banner
      ? '<div class="doc-company doc-company-banner"><img class="doc-banner" src="' + esc(c.logoDataUrl) + '" alt="' + esc(c.name) + '">' +
          (contact ? '<div class="doc-banner-contact">' + contact + '</div>' : '') + '</div>'
      : '<div class="doc-company">' +
          (c.logoDataUrl ? '<img class="doc-logo" src="' + esc(c.logoDataUrl) + '" alt="">' : '') +
          '<div>' +
            (c.name ? '<div class="doc-company-name">' + esc(c.name) + '</div>' : '') +
            (c.address ? '<div>' + escMultiline(c.address) + '</div>' : '') +
            (contact ? '<div>' + contact + '</div>' : '') +
            (license ? '<div>' + license + '</div>' : '') +
          '</div>' +
        '</div>';
    return '' +
      '<header class="doc-head">' +
        company +
        '<div class="doc-title">' +
          '<h1>' + esc(title) + '</h1>' +
          '<table class="doc-meta">' +
            '<tr><th>Date</th><td>' + esc(U.formatDateShort(quote.date)) + '</td></tr>' +
            '<tr><th>Quote #</th><td>' + esc(quote.number) + '</td></tr>' +
            (exp && title !== 'OFFICIAL MATERIAL TAKE-OFF' ? '<tr><th>Valid until</th><td>' + esc(U.formatDateShort(exp)) + '</td></tr>' : '') +
          '</table>' +
        '</div>' +
      '</header>' +
      '<section class="doc-parties">' +
        '<div><div class="doc-label">To</div>' +
          '<div class="doc-strong">' + (esc(quote.gc.name) || '&nbsp;') + '</div>' +
          (quote.gc.attention ? '<div>Attn: ' + esc(quote.gc.attention) + '</div>' : '') +
        '</div>' +
        '<div><div class="doc-label">Project</div>' +
          '<div class="doc-strong">' + (esc(quote.project.name) || '&nbsp;') + '</div>' +
          (quote.project.address ? '<div>' + escMultiline(quote.project.address) + '</div>' : '') +
        '</div>' +
      '</section>';
  }

  function qtyCell(line) {
    return U.formatNumber(line.qty, 2) + (line.unit !== 'sf' ? ' ' + unitLabel(line.unit) : '');
  }

  function renderScopeParagraphs(lines) {
    var seen = {};
    var paras = [];
    lines.forEach(function (l) {
      var s = String(l.scope || '').trim();
      if (s && !seen[s]) { seen[s] = true; paras.push(s); }
    });
    if (!paras.length) return '';
    return '<section class="doc-scope"><div class="doc-label">Scope of work</div>' +
      paras.map(function (p) { return '<p>' + escMultiline(p) + '</p>'; }).join('') + '</section>';
  }

  function renderFooter(quote, priced, opts) {
    var t = priced.totals;
    var ct = quote.constructionType;
    var notes = notesList(quote);
    var totalsRows = '';
    if (opts.split) {
      totalsRows += '<tr><th>Material</th><td>' + U.formatMoney(t.material) + '</td></tr>';
      totalsRows += '<tr><th>Labor</th><td>' + U.formatMoney(t.labor) + '</td></tr>';
    }
    if (t.tax) {
      if (!opts.split) totalsRows += '<tr><th>Subtotal</th><td>' + U.formatMoney(t.subtotal) + '</td></tr>';
      totalsRows += '<tr><th>Sales tax on material (' + U.formatNumber(t.taxPct, 3) + '%)</th><td>' + U.formatMoney(t.tax) + '</td></tr>';
    }
    totalsRows += '<tr class="doc-grand"><th>' + (opts.lumpSum ? 'Lump sum total' : 'Total') + '</th><td>' + U.formatMoney(t.total) + '</td></tr>';
    return '' +
      '<section class="doc-foot">' +
        '<div class="doc-foot-left">' +
          '<div class="doc-label">Construction type</div>' +
          '<div class="doc-checks">' +
            '<span>' + (ct === 'new' ? '&#9746;' : '&#9744;') + ' New Const.</span>' +
            '<span>' + (ct === 'remodel' ? '&#9746;' : '&#9744;') + ' Remodel</span>' +
          '</div>' +
          (notes.length ? '<div class="doc-label">Notes / exclusions</div><ul class="doc-notes">' +
            notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>' +
        '<table class="doc-totals">' + totalsRows + '</table>' +
      '</section>';
  }

  function renderInternal(quote, priced, settings) {
    var lines = priced.lines.filter(function (l) { return !l.excluded; });
    var allSf = lines.every(function (l) { return l.unit === 'sf'; });
    var body = lines.map(function (l) {
      var detail = [];
      if (!l.manual) {
        detail.push('Takeoff ' + U.formatNumber(l.rawQty, 2) + ' ' + unitLabel(l.unit).toLowerCase() +
          (l.qtyOverridden ? ' &rarr; entered ' : (l.roundTo ? ' &rarr; rounded up to ' + U.formatNumber(l.roundTo) + ' = ' : ' = ')) +
          U.formatNumber(l.qty, 2) + ' (' + l.rowCount + ' markup' + (l.rowCount === 1 ? '' : 's') + ')' +
          (l.qtyBelowTakeoff ? ' <strong class="doc-flag">BELOW TAKEOFF</strong>' : ''));
      } else {
        detail.push('Manual line');
      }
      detail.push(l.materialRate === null ? '<strong>Material $/' + l.unit + ' not entered</strong>'
        : 'Material ' + U.formatNumber(l.qty, 2) + ' &times; ' + U.formatMoney(l.materialRate) + '/' + l.unit);
      if (l.laborDaysOverridden) {
        detail.push('Labor ' + U.formatNumber(l.laborDays, 3) + ' days (entered) &times; ' + U.formatMoney(l.dayRate) + '/day');
      } else if (l.unitsPerDay === null) {
        detail.push('<strong>Install ' + l.unit + '/day not entered</strong>');
      } else if (l.unitsPerDay > 0) {
        detail.push('Labor ' + U.formatNumber(l.qty, 2) + ' &divide; ' + U.formatNumber(l.unitsPerDay, 2) + ' ' + l.unit + '/day = ' +
          U.formatNumber(l.laborDaysRaw, 3) + ' days' + (l.laborDays !== l.laborDaysRaw ? ' &rarr; ' + U.formatNumber(l.laborDays, 1) : '') +
          ' &times; ' + U.formatMoney(l.dayRate) + '/day');
      }
      if (l.rooms.length) detail.push('Rooms: ' + l.rooms.map(esc).join(', '));
      return '' +
        '<tbody class="doc-line">' +
        '<tr>' +
          '<td class="doc-scope-label">' + scopeLabelHtml(l.scopeLabel) + '</td>' +
          '<td>' + esc(l.description) + (l.code ? '<div class="doc-code">' + esc(l.code) + '</div>' : '') + '</td>' +
          '<td class="num">' + (l.linealFt !== null ? U.formatNumber(l.linealFt, l.unit === 'lf' ? 2 : 0) : '') + '</td>' +
          '<td class="num">' + (l.height ? esc(U.formatFeet(l.height)) : '') + '</td>' +
          '<td class="num">' + qtyCell(l) + '</td>' +
          '<td class="num">' + U.formatMoney(l.material) + '</td>' +
          '<td class="num">' + U.formatMoney(l.labor) + '</td>' +
          '<td class="num doc-strong">' + U.formatMoney(l.total) + '</td>' +
        '</tr>' +
        '<tr class="doc-calc"><td colspan="8">' + detail.join(' &nbsp;|&nbsp; ') + '</td></tr>' +
        '</tbody>';
    }).join('');

    var lab = quote.rates.labor;
    var ar = priced.laborArea || { zone: 'local' };
    var rateLine = 'Labor cost/day: ' + (ar.zone === 'bay' ? 'Bay Area' : 'Local') + ' rate' + (ar.city ? ' (' + esc(ar.city) + ')' : '') + ' ' +
      (priced.hourlyRate === null || priced.hourlyRate === undefined ? '<strong>not set</strong>' : U.formatMoney(priced.hourlyRate)) + '/hr &times; ' + U.formatNumber(+lab.hoursPerDay, 2) + ' hrs + ' +
      U.formatMoney(lab.dailyAdder) + ' per diem &amp; vehicle = <strong>' + U.formatMoney(priced.dayRate) + '</strong>' +
      ' &nbsp;|&nbsp; Labor days: ' + U.formatNumber(priced.totals.laborDays, 3) +
      ' (rounding: ' + esc(lab.dayRounding || 'none') + ')' +
      (quote.rates.rateEntry === 'catalog' && quote.rates.priceList
        ? ' &nbsp;|&nbsp; Material prices: ' + esc(quote.rates.priceList.fileName) + ' (imported ' + esc(U.formatDateShort(new Date(quote.rates.priceList.importedAt))) + ')'
        : (quote.rates.rateEntry !== 'catalog' ? ' &nbsp;|&nbsp; Material $ and install rates entered by hand' : '')) +
      ' &nbsp;|&nbsp; Quantity source: ' + esc({ wasteSqFt: 'Waste Sq FT.', sqFt: 'SQ. FT + ' + quote.rates.quantity.wastePct + '% waste', calc: 'Length × Height + ' + quote.rates.quantity.wastePct + '% waste' }[quote.rates.quantity.source] || quote.rates.quantity.source);

    return '' +
      '<article class="doc doc-internal">' +
        renderHeader(quote, settings, 'OFFICIAL MATERIAL TAKE-OFF') +
        (priced.totals.linesMissingRates ? '<p class="doc-alert">INCOMPLETE: ' + priced.totals.linesMissingRates + ' line' +
          (priced.totals.linesMissingRates === 1 ? ' is' : 's are') + ' missing material $ or install rate. Totals below are understated.</p>' : '') +
        '<table class="doc-lines">' +
          '<thead><tr><th>Scope of work</th><th>Material</th><th class="num">Lineal ft</th><th class="num">Height</th>' +
          '<th class="num">' + (allSf ? 'Total SQ' : 'Qty') + '</th><th class="num">M</th><th class="num">L</th><th class="num">Price</th></tr></thead>' +
          (body || '<tbody><tr><td colspan="8" class="doc-empty">No priced line items.</td></tr></tbody>') +
        '</table>' +
        '<p class="doc-rates">' + rateLine + '</p>' +
        renderScopeParagraphs(lines) +
        renderFooter(quote, priced, { split: true, lumpSum: false }) +
        renderTakeoffDetail(quote, priced) +
      '</article>';
  }

  function renderTakeoffDetail(quote, priced) {
    var src = quote.source;
    if (!src || !src.rows || !src.rows.length) return '';
    var lineByRow = {};
    priced.lines.forEach(function (l) { l.rowIds.forEach(function (id) { lineByRow[id] = l; }); });
    var rows = src.rows.map(function (r) {
      var excluded = quote.excludedRows[r.id];
      var l = lineByRow[r.id];
      return '<tr' + (excluded || !l ? ' class="doc-muted"' : '') + '>' +
        '<td>' + esc(r.subject) + '</td><td>' + esc(r.room || r.space) + '</td><td class="num">' + esc(r.page) + '</td>' +
        '<td class="num">' + U.formatNumber(r.measurement, 2) + '</td>' +
        '<td class="num">' + esc(r.installHeightText) + '</td>' +
        '<td class="num">' + U.formatNumber(r.sqFt, 2) + '</td>' +
        '<td class="num">' + U.formatNumber(r.wasteSqFt, 2) + '</td>' +
        '<td>' + (excluded ? 'excluded' : (l ? esc(l.catalogSubject) : 'not priced')) + '</td></tr>';
    }).join('');
    var subs = (src.subtotals || []).map(function (s) {
      return '<tr class="doc-subtotal"><td>' + esc(s.subject) + '</td><td></td><td></td>' +
        '<td class="num">' + U.formatNumber(s.measurement, 2) + '</td><td></td>' +
        '<td class="num">' + U.formatNumber(s.sqFt, 2) + '</td>' +
        '<td class="num">' + U.formatNumber(s.wasteSqFt, 2) + '</td><td>Bluebeam subtotal</td></tr>';
    }).join('');
    var warnings = (src.warnings || []).concat(priced.warnings || []).filter(function (w) { return w.level !== 'info'; });
    return '' +
      '<section class="doc-takeoff">' +
        '<div class="doc-label">Take-off detail' + (src.fileName ? ' &mdash; ' + esc(src.fileName) : '') + '</div>' +
        '<table class="doc-small"><thead><tr><th>Subject</th><th>Room</th><th class="num">Page</th><th class="num">Length (ft)</th>' +
        '<th class="num">Install ht</th><th class="num">SQ. FT</th><th class="num">Waste SF</th><th>Priced as</th></tr></thead>' +
        '<tbody>' + rows + subs + '</tbody></table>' +
        (warnings.length ? '<ul class="doc-warnings">' + warnings.map(function (w) { return '<li>' + esc(w.message) + '</li>'; }).join('') + '</ul>' : '') +
      '</section>';
  }

  function renderProposal(quote, priced, settings) {
    var lines = priced.lines.filter(function (l) { return !l.excluded; });
    var p = quote.proposal || {};
    var lump = !!p.lumpSum;
    var split = !!p.showSplit && !lump;
    var showQty = p.showUnitQty !== false;
    var allSf = lines.every(function (l) { return l.unit === 'sf'; });

    var head = '<th>Scope of work</th><th>Description</th>';
    if (showQty) head += '<th class="num">Lineal ft</th><th class="num">Height</th><th class="num">' + (allSf ? 'Total SQ' : 'Qty') + '</th>';
    if (split) head += '<th class="num">Material</th><th class="num">Labor</th>';
    if (!lump) head += '<th class="num">Price</th>';

    var body = lines.map(function (l) {
      var r = '<tr><td class="doc-scope-label">' + scopeLabelHtml(l.scopeLabel) + '</td><td>' + esc(l.description) + '</td>';
      if (showQty) {
        r += '<td class="num">' + (l.linealFt !== null ? U.formatNumber(l.linealFt, l.unit === 'lf' ? 2 : 0) : '') + '</td>' +
          '<td class="num">' + (l.height ? esc(U.formatFeet(l.height)) : '') + '</td>' +
          '<td class="num">' + qtyCell(l) + '</td>';
      }
      if (split) r += '<td class="num">' + U.formatMoney(l.material) + '</td><td class="num">' + U.formatMoney(l.labor) + '</td>';
      if (!lump) r += '<td class="num doc-strong">' + U.formatMoney(l.total) + '</td>';
      return r + '</tr>';
    }).join('');
    var cols = 2 + (showQty ? 3 : 0) + (split ? 2 : 0) + (lump ? 0 : 1);

    var c = settings.company || {};
    return '' +
      '<article class="doc doc-proposal">' +
        renderHeader(quote, settings, 'PROPOSAL') +
        '<table class="doc-lines">' +
          '<thead><tr>' + head + '</tr></thead>' +
          '<tbody>' + (body || '<tr><td colspan="' + cols + '" class="doc-empty">No line items.</td></tr>') + '</tbody>' +
        '</table>' +
        renderScopeParagraphs(lines) +
        renderFooter(quote, priced, { split: split, lumpSum: lump }) +
        (quote.validDays ? '<p class="doc-fine">This proposal is valid for ' + esc(quote.validDays) + ' days from the date above.</p>' : '') +
        '<section class="doc-sign">' +
          '<div><div class="doc-sign-line"></div>Accepted by (' + (esc(quote.gc.name) || 'General Contractor') + ')</div>' +
          '<div><div class="doc-sign-line"></div>Date</div>' +
          '<div><div class="doc-sign-line"></div>' + (esc(c.name) || 'Contractor') + '</div>' +
        '</section>' +
      '</article>';
  }

  function render(quote, priced, settings, mode) {
    return mode === 'proposal' ? renderProposal(quote, priced, settings) : renderInternal(quote, priced, settings);
  }

  global.Quote = {
    FILE_KIND: FILE_KIND,
    newQuote: newQuote,
    normalizeQuote: normalizeQuote,
    ratesFromSettings: ratesFromSettings,
    commitNumber: commitNumber,
    toFile: toFile,
    fromFile: fromFile,
    fileName: fileName,
    unitLabel: unitLabel,
    render: render,
    esc: esc
  };
})(window);
