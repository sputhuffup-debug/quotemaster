/* quote.js — quote model, numbering, save-file format and printable rendering.  Exposes window.Quote. */
(function (global) {
  'use strict';

  var U = global.Units;
  var FILE_KIND = 'revu-quote-builder/quote';
  var FILE_VERSION = 2;   // 2: adds the read-only "summary" block (see docs/json-format.md)

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

  /* ---------- quote numbers: Q-26-1001 ---------- */

  /** Which counter a quote date uses: its year ("2026"), or "all" when the year is not in the number. */
  function counterKey(settings, isoDate) {
    var d = U.parseISODate(isoDate) || new Date();
    return (settings.quote || {}).includeYear !== false ? String(d.getFullYear()) : 'all';
  }

  /** Next number for that counter: each year starts again at startNumber (1001). */
  function nextNumberFor(settings, isoDate) {
    var qs = settings.quote || {};
    var c = (qs.counters || {})[counterKey(settings, isoDate)];
    var n = parseInt(c, 10);
    return isFinite(n) ? n : (parseInt(qs.startNumber, 10) || 1001);
  }

  /** "Q-26-1001": prefix + last two digits of the quote date's year + number. */
  function formatQuoteNumber(settings, isoDate, n) {
    var qs = settings.quote || {};
    var d = U.parseISODate(isoDate) || new Date();
    var num = n !== undefined ? n : nextNumberFor(settings, isoDate);
    var yy = String(d.getFullYear()).slice(-2);
    return (qs.prefix || '') + (qs.includeYear !== false ? yy + '-' : '') + num;
  }

  function newQuote(settings) {
    return {
      number: formatQuoteNumber(settings, U.toISODate(new Date())),
      numberCommitted: false,
      date: U.toISODate(new Date()),
      gc: { name: '', attention: '' },
      project: { name: '', address: '' },
      constructionType: '',
      notes: (settings.terms.notes || []).join('\n'),
      validDays: settings.terms.validDays,
      taxPct: settings.terms.taxPct || 0,
      proposal: clone(settings.proposal || { showSplit: false, lumpSum: false, showUnitQty: true }),
      internal: clone(settings.internal || { showCalc: false }),
      groupByRoom: false,
      laborZone: 'auto',     // union rate: "auto" (from the project city) | "local" | "bay"
      source: null,          // { fileName, importedAt, headers, rows, subtotals, warnings }
      excludedRows: {},
      manualLines: [],
      alternates: [],        // ADD / DEDUCT alternates (not in the base bid); see Pricing.priceAlternates
      addenda: [],           // reviewed addenda: [{ id, number, date (yyyy-mm-dd, optional) }]
      addendaNone: false,    // "No addenda issued"
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
    out.internal = Object.assign({ showCalc: false }, out.internal || {});
    out.excludedRows = out.excludedRows || {};
    out.manualLines = out.manualLines || [];
    out.alternates = Array.isArray(out.alternates) ? out.alternates : [];
    out.addenda = Array.isArray(out.addenda) ? out.addenda : [];
    out.addendaNone = !!out.addendaNone;
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
    var n = nextNumberFor(settings, quote.date);
    quote.number = formatQuoteNumber(settings, quote.date, n);
    quote.numberCommitted = true;
    noteUsed(settings, counterKey(settings, quote.date), n);
    settings.quote.counters = settings.quote.counters || {};
    settings.quote.counters[counterKey(settings, quote.date)] = n + 1;
    return true;
  }

  /** "Q-26-1047" -> { head: "Q-26-", n: 1047 }; null if the number does not end in digits. */
  function splitNumber(number) {
    var m = /^(.*?)(\d+)$/.exec(String(number || ''));
    return m ? { head: m[1], n: parseInt(m[2], 10) } : null;
  }

  /** Highest number saved for a counter on this computer (settings.quote.highest), or null. */
  function highestUsed(settings, key) {
    var h = parseInt(((settings.quote || {}).highest || {})[key], 10);
    return isFinite(h) ? h : null;
  }
  function noteUsed(settings, key, n) {
    var h = highestUsed(settings, key);
    settings.quote.highest = settings.quote.highest || {};
    if (h === null || n > h) settings.quote.highest[key] = n;
  }

  /**
   * Set the number part of a quote's number (Quote tab box / − + buttons).
   *   Unsaved quote: sets that year's next number (the counter), and the draft shows it.
   *   Saved quote:   renumbers this quote only; the counter moves past it if needed, so it is never reused.
   */
  function setNumberPart(quote, settings, n) {
    n = Math.max(1, Math.round(n));
    var key = counterKey(settings, quote.date);
    settings.quote.counters = settings.quote.counters || {};
    if (!quote.numberCommitted) {
      settings.quote.counters[key] = n;
      quote.number = formatQuoteNumber(settings, quote.date, n);
    } else {
      var parts = splitNumber(quote.number);
      quote.number = (parts ? parts.head : '') + n;
      noteUsed(settings, key, n);
      if (n >= nextNumberFor(settings, quote.date)) settings.quote.counters[key] = n + 1;
    }
    return quote.number;
  }

  /** Warning text if an unsaved quote would get a number already saved on this computer this year. */
  function numberWarning(settings, isoDate, n) {
    var h = highestUsed(settings, counterKey(settings, isoDate));
    if (h === null || n > h) return '';
    return 'Numbers up to ' + formatQuoteNumber(settings, isoDate, h) + ' have already been saved on this computer, so ' +
      formatQuoteNumber(settings, isoDate, n) + ' may already be in use.';
  }

  /**
   * Saved quote file. "quote" holds everything needed to reopen and re-price the quote; "summary" is a
   * read-only copy of the calculated results for other programs (ignored when the file is opened).
   */
  function toFile(quote) {
    return {
      kind: FILE_KIND,
      version: FILE_VERSION,
      savedAt: new Date().toISOString(),
      summary: buildSummary(quote),
      quote: quote
    };
  }

  function round2(v) { return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 100) / 100; }

  /** Calculated results, as printed: lines, totals, alternates, scope, addenda. */
  function buildSummary(quote) {
    var rows = quote.source && quote.source.rows ? quote.source.rows : [];
    var priced = global.Pricing.price(quote, rows);
    var lab = (quote.rates && quote.rates.labor) || {};
    var t = priced.totals;
    var area = priced.laborArea || {};
    return {
      note: 'Read-only results calculated by Revu Quote Builder when this file was saved. Ignored when the file is opened; edit "quote" instead.',
      currency: 'USD',
      quoteNumber: quote.number,
      date: quote.date,
      generalContractor: { name: quote.gc.name, attention: quote.gc.attention },
      project: { name: quote.project.name, address: quote.project.address },
      constructionType: quote.constructionType || null,
      laborRate: {
        area: area.zone === 'bay' ? 'bayArea' : 'local',
        areaSource: area.mode === 'auto' ? 'projectCity' : 'pickedOnQuote',
        city: area.city || null,
        hourlyRate: priced.hourlyRate,
        hoursPerDay: U.parseNumber(lab.hoursPerDay),
        perDiemVehiclePerDay: U.parseNumber(lab.dailyAdder),
        dayRate: round2(priced.dayRate)
      },
      lines: priced.lines.filter(function (l) { return !l.excluded; }).map(function (l) {
        return {
          key: l.key,
          scopeOfWork: l.scopeLabel,
          description: l.description,
          code: l.code || null,
          catalogItem: l.catalogSubject,
          bluebeamSubject: l.subject || null,
          manual: !!l.manual,
          unit: l.unit,
          takeoffQty: l.manual ? null : round2(l.rawQty),
          qty: round2(l.qty),
          qtyEnteredBelowTakeoff: !!l.qtyBelowTakeoff,
          heightFt: l.height,
          linealFt: l.linealFt,
          count: l.roomCount,
          countType: l.roomNoun,
          materialRate: l.materialRate,
          unitsPerDay: l.unitsPerDay,
          laborDays: round2(l.laborDays),
          material: l.material,
          labor: l.labor,
          total: l.total,
          markupColor: l.color || null,
          bluebeamRowIds: l.rowIds.slice()
        };
      }),
      totals: {
        material: t.material,
        labor: t.labor,
        laborDays: round2(t.laborDays),
        subtotal: t.subtotal,
        salesTaxPct: t.taxPct,
        salesTax: t.tax,
        baseBid: t.total
      },
      alternates: (priced.alternates || []).map(function (a) {
        return {
          number: a.number,
          name: (a.direction === 'deduct' ? 'DEDUCT' : 'ADD') + ' ALTERNATE #' + a.number,
          direction: a.direction,
          kind: a.kind,
          title: a.title,
          description: a.description || null,
          appliesToLine: a.kind === 'swap' && a.baseLine ? a.baseLine.key : null,
          unit: a.unit || null,
          qty: a.qty === undefined ? null : round2(a.qty),
          material: a.material,
          labor: a.labor,
          salesTax: a.tax || 0,
          amount: a.amount,
          signedAmount: a.signed,
          incomplete: a.missing.length ? a.missing.slice() : null
        };
      }),
      scopeOfWork: scopeText(quote, priced),
      notes: notesList(quote),
      addendaReviewed: addendaText(quote) || null,
      incomplete: {
        linesMissingRates: t.linesMissingRates || 0,
        linesMissingCount: t.linesMissingRooms || 0,
        alternatesIncomplete: t.alternatesIncomplete || 0
      }
    };
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

  /**
   * "No. 1 (10-15-26), No. 2 (10-22-26)" / "None issued" / "" (nothing entered).
   */
  function addendaText(quote) {
    var list = (quote.addenda || []).filter(function (a) { return String(a.number || '').trim() || a.date; });
    if (list.length) {
      return list.map(function (a) {
        var n = String(a.number || '').trim().replace(/^(no\.?|#|addendum)\s*/i, '');
        return 'No. ' + (n || '?') + (a.date ? ' (' + U.formatDateShort(a.date) + ')' : '');
      }).join(', ');
    }
    return quote.addendaNone ? 'None issued' : '';
  }

  function renderAddenda(quote, internal) {
    var t = addendaText(quote);
    if (!t && !internal) return '';
    return '<div class="doc-addenda"><span class="doc-label">Addenda reviewed:</span> ' +
      (t ? '<span class="doc-strong">' + esc(t) + '</span>' : '<em class="doc-flag">not entered</em>') + '</div>';
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

  var LOGO_PLACEHOLDER = 'img/letterhead-placeholder.png';

  /** Logo <img>; a file path that is missing (e.g. img/letterhead.png not copied yet) falls back to the placeholder. */
  function logoImg(cls, src, alt) {
    var fallback = /^data:/i.test(src) ? '' : ' onerror="this.onerror=null;this.src=\'' + LOGO_PLACEHOLDER + '\'"';
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="' + esc(alt || '') + '"' + fallback + '>';
  }

  function renderHeader(quote, settings, title) {
    var c = settings.company || {};
    var contact = [c.phone, c.email].filter(Boolean).map(esc).join(' &middot; ');
    var exp = expiryDate(quote);
    var banner = c.logoDataUrl && c.logoLayout === 'banner';
    var license = c.license ? (/lic/i.test(c.license) ? esc(c.license) : 'Lic. ' + esc(c.license)) : '';
    // A letterhead logo already shows name, address and licenses: print only the phone / email under it.
    var company = banner
      ? '<div class="doc-company doc-company-banner">' + logoImg('doc-banner', c.logoDataUrl, c.name) +
          (contact ? '<div class="doc-banner-contact">' + contact + '</div>' : '') + '</div>'
      : '<div class="doc-company">' +
          (c.logoDataUrl ? logoImg('doc-logo', c.logoDataUrl, '') : '') +
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

  /** Scope text built from the lines' catalog scope paragraphs (each once, blank line between). */
  function scopeTextAuto(priced) {
    var seen = {};
    var paras = [];
    (priced.lines || []).forEach(function (l) {
      if (l.excluded) return;
      var s = String(l.scope || '').trim();
      if (s && !seen[s]) { seen[s] = true; paras.push(s); }
    });
    return paras.join('\n\n');
  }

  /** The quote's scope of work: typed on the Quote tab (quote.scopeText), else built from the lines. */
  function scopeText(quote, priced) {
    return typeof quote.scopeText === 'string' ? quote.scopeText : scopeTextAuto(priced);
  }

  function renderScope(quote, priced) {
    var text = scopeText(quote, priced).trim();
    if (!text) return '';
    return '<section class="doc-scope"><div class="doc-label doc-section">Scope of work</div>' +
      text.split(/\n\s*\n/).map(function (p) { return '<p>' + escMultiline(p.trim()) + '</p>'; }).join('') + '</section>';
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
    var hasAlts = priced.alternates && priced.alternates.length;
    totalsRows += '<tr class="doc-grand"><th>' + (hasAlts ? (opts.lumpSum ? 'Base bid (lump sum)' : 'Base bid') : (opts.lumpSum ? 'Lump sum total' : 'Total')) +
      '</th><td>' + U.formatMoney(t.total) + '</td></tr>';
    return '' +
      '<section class="doc-foot">' +
        '<div class="doc-foot-left">' +
          '<div class="doc-label doc-section">Construction type</div>' +
          '<div class="doc-checks">' +
            '<span>' + (ct === 'new' ? '&#9746;' : '&#9744;') + ' New Const.</span>' +
            '<span>' + (ct === 'remodel' ? '&#9746;' : '&#9744;') + ' Remodel</span>' +
          '</div>' +
          (notes.length ? '<div class="doc-label doc-section">Notes / exclusions</div><ul class="doc-notes">' +
            notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>' +
        '<table class="doc-totals">' + totalsRows + '</table>' +
      '</section>';
  }

  /* ---------- alternates ---------- */

  function altName(a) { return (a.direction === 'deduct' ? 'DEDUCT' : 'ADD') + ' ALTERNATE #' + a.number; }
  function altPrice(a) {
    return a.direction === 'deduct' ? 'DEDUCT (' + U.formatMoney(a.amount) + ')' : 'ADD ' + U.formatMoney(a.amount);
  }
  function altQty(a) {
    if (a.kind === 'lump' || a.qty === undefined || a.qty === null) return '';
    if (a.kind === 'swap' && (!a.baseLine || a.qty === a.baseLine.qty)) return '';
    return U.formatNumber(a.qty, 2) + (a.unit && a.unit !== 'sf' ? ' ' + unitLabel(a.unit) : '');
  }
  function altDetail(a) {
    if (a.kind === 'line') return esc(a.description);
    if (a.kind === 'swap' && !a.baseLine) return '';
    if (a.kind === 'swap') return 'Applies to: ' + scopeLabelHtml(a.baseLine.scopeLabel) + ' &mdash; ' + esc(a.baseLine.description);
    return '';
  }

  /** "ALTERNATES (not included in base bid)" under the base bid total. internal = with M / L split and the changes. */
  function renderAlternates(quote, priced, opts) {
    var alts = priced.alternates || [];
    if (!alts.length) return '';
    var showQty = opts.internal || (quote.proposal || {}).showUnitQty !== false;
    var head = '<th>Alternate</th><th>Description</th>' + (showQty ? '<th class="num">Qty</th>' : '') +
      (opts.internal ? '<th class="num">M</th><th class="num">L</th>' : '') + '<th class="num">Price</th>';
    var rows = alts.map(function (a) {
      var detail = altDetail(a);
      var calc = '';
      if (opts.internal) {
        var bits = [];
        if (a.kind === 'swap' && a.changes && a.changes.length) bits.push(a.changes.map(esc).join(', '));
        if (a.kind === 'line' && a.materialRate !== null && a.materialRate !== undefined) {
          bits.push(U.formatMoney(a.materialRate) + '/' + a.unit + (a.laborDaysEntered ? ', ' + U.formatNumber(a.laborDays, 3) + ' days (entered)'
            : (a.unitsPerDay ? ', ' + U.formatNumber(a.unitsPerDay, 2) + ' ' + a.unit + '/day = ' + U.formatNumber(a.laborDays, 3) + ' days' : '')));
        }
        if (a.tax) bits.push('incl. sales tax ' + U.formatMoney(a.tax));
        if (a.missing.length) bits.push('<strong class="doc-flag">INCOMPLETE: enter ' + esc(a.missing.join(', ')) + '</strong>');
        if (bits.length) calc = '<div class="doc-code">' + bits.join(' &nbsp;|&nbsp; ') + '</div>';
      }
      var signed = function (v) { return v ? (v < 0 ? '(' + U.formatMoney(-v) + ')' : U.formatMoney(v)) : ''; };
      return '<tr>' +
        '<td class="doc-alt-name">' + altName(a) + '</td>' +
        '<td><div class="doc-alt-title">' + (esc(a.title) || '&nbsp;') + '</div>' + (detail ? '<div class="doc-code">' + detail + '</div>' : '') + calc + '</td>' +
        (showQty ? '<td class="num">' + altQty(a) + '</td>' : '') +
        (opts.internal ? '<td class="num">' + signed(a.material) + '</td><td class="num">' + signed(a.labor) + '</td>' : '') +
        '<td class="num doc-strong">' + altPrice(a) + '</td></tr>';
    }).join('');
    return '<section class="doc-alts"><div class="doc-label"><span class="doc-section">Alternates</span> (not included in base bid)</div>' +
      '<table class="doc-lines doc-alt-table"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></section>';
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
      var showCalc = !!(quote.internal && quote.internal.showCalc);
      // Without the calculation row, still flag a Total SQ typed below the takeoff.
      var belowFlag = !showCalc && l.qtyBelowTakeoff
        ? '<div class="doc-flag doc-flag-small">below takeoff (' + U.formatNumber(l.rawQty, 2) + ')</div>' : '';
      return '' +
        '<tbody class="doc-line' + (showCalc ? '' : ' nocalc') + '"' + (U.tint(l.color) ? ' style="background:' + U.tint(l.color) + '"' : '') + '>' +
        '<tr>' +
          '<td class="doc-scope-label">' + scopeLabelHtml(l.scopeLabel) + '</td>' +
          '<td>' + esc(l.description) + (l.code ? '<div class="doc-code">' + esc(l.code) + '</div>' : '') + '</td>' +
          '<td class="num">' + (l.linealFt !== null ? U.formatNumber(l.linealFt, l.unit === 'lf' ? 2 : 0) : '') + '</td>' +
          '<td class="num">' + (l.height ? esc(U.formatFeet(l.height)) : '') + '</td>' +
          '<td class="num">' + qtyCell(l) + belowFlag + '</td>' +
          '<td class="num">' + U.formatMoney(l.material) + '</td>' +
          '<td class="num">' + U.formatMoney(l.labor) + '</td>' +
          '<td class="num doc-strong">' + U.formatMoney(l.total) + '</td>' +
        '</tr>' +
        (showCalc ? '<tr class="doc-calc"><td colspan="8">' + detail.join(' &nbsp;|&nbsp; ') + '</td></tr>' : '') +
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
        renderAddenda(quote, true) +
        (priced.totals.linesMissingRates ? '<p class="doc-alert">INCOMPLETE: ' + priced.totals.linesMissingRates + ' line' +
          (priced.totals.linesMissingRates === 1 ? ' is' : 's are') + ' missing material $ or install rate. Totals below are understated.</p>' : '') +
        '<table class="doc-lines">' +
          '<thead><tr><th>Scope of work</th><th>Material</th><th class="num">Lineal ft</th><th class="num">Height</th>' +
          '<th class="num">' + (allSf ? 'Total SQ' : 'Qty') + '</th><th class="num">M</th><th class="num">L</th><th class="num">Price</th></tr></thead>' +
          (body || '<tbody><tr><td colspan="8" class="doc-empty">No priced line items.</td></tr></tbody>') +
        '</table>' +
        '<p class="doc-rates">' + rateLine + '</p>' +
        renderScope(quote, priced) +
        renderFooter(quote, priced, { split: true, lumpSum: false }) +
        renderAlternates(quote, priced, { internal: true }) +
        renderTakeoffDetail(quote, priced) +
      '</article>';
  }

  /*
   * Take-off detail: every Bluebeam row the quote is built from, with the material it is priced as.
   * Printed on its own page(s) after the internal take-off (see .doc-takeoff in print.css).
   */
  function renderTakeoffDetail(quote, priced) {
    var src = quote.source;
    if (!src || !src.rows || !src.rows.length) return '';
    var lineByRow = {};
    priced.lines.forEach(function (l) { l.rowIds.forEach(function (id) { lineByRow[id] = l; }); });
    var unitSuffix = { ea: ' ea', lf: ' lf' };
    // CSV order, Bluebeam subtotal rows where they were in the export
    var all = src.rows.concat(src.subtotals || []).slice().sort(function (a, b) { return (a.line || 0) - (b.line || 0); });
    var body = all.map(function (r) {
      if (r.isSubtotal) {
        return '<tr class="doc-subtotal"><td>' + esc(r.subject) + '</td><td></td><td></td>' +
          '<td class="num">' + U.formatNumber(r.measurement, 2) + '</td><td></td>' +
          '<td class="num">' + U.formatNumber(r.sqFt, 2) + '</td>' +
          '<td class="num">' + U.formatNumber(r.wasteSqFt, 2) + '</td><td>Bluebeam subtotal</td></tr>';
      }
      var excluded = quote.excludedRows[r.id];
      var l = lineByRow[r.id];
      var rowBg = U.tint(r.color);
      var unit = global.Parse && global.Parse.rowUnit ? global.Parse.rowUnit(r) : null;
      var material = excluded ? '<em>Excluded</em>'
        : (l ? esc(l.description) : '<em>Not priced</em>');
      return '<tr' + (excluded || !l ? ' class="doc-muted"' : '') + (rowBg ? ' style="background:' + rowBg + '"' : '') + '>' +
        '<td>' + esc(r.subject) + '</td><td>' + esc(r.room || r.space) + '</td><td class="num">' + esc(r.page) + '</td>' +
        '<td class="num">' + U.formatNumber(r.measurement, 2) + (unitSuffix[unit] || '') + '</td>' +
        '<td class="num">' + esc(r.installHeightText) + '</td>' +
        '<td class="num">' + U.formatNumber(r.sqFt, 2) + '</td>' +
        '<td class="num">' + U.formatNumber(r.wasteSqFt, 2) + '</td>' +
        '<td>' + material + '</td></tr>';
    }).join('');
    var warnings = (src.warnings || []).concat(priced.warnings || []).filter(function (w) { return w.level !== 'info'; });
    var meta = [quote.number, quote.project && quote.project.name, U.formatDateShort(quote.date)].filter(Boolean).map(esc).join(' &middot; ');
    return '' +
      '<section class="doc-takeoff">' +
        '<div class="doc-takeoff-head">' +
          '<h2>Take-off detail</h2>' +
          '<div>' + meta + (src.fileName ? '<div class="doc-code">' + esc(src.fileName) + '</div>' : '') + '</div>' +
        '</div>' +
        '<table class="doc-small">' +
        '<colgroup><col style="width:1.3in"><col style="width:0.55in"><col style="width:0.35in"><col style="width:0.6in">' +
        '<col style="width:0.45in"><col style="width:0.45in"><col style="width:0.55in"><col></colgroup>' +
        '<thead><tr><th>Subject</th><th>Room</th><th class="num">Page</th><th class="num">Meas.</th>' +
        '<th class="num">Inst. ht</th><th class="num">SQ FT</th><th class="num">Waste SF</th><th>Material</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table>' +
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
        renderAddenda(quote, false) +
        '<table class="doc-lines">' +
          '<thead><tr>' + head + '</tr></thead>' +
          '<tbody>' + (body || '<tr><td colspan="' + cols + '" class="doc-empty">No line items.</td></tr>') + '</tbody>' +
        '</table>' +
        renderScope(quote, priced) +
        renderFooter(quote, priced, { split: split, lumpSum: lump }) +
        renderAlternates(quote, priced, { internal: false }) +
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
    splitNumber: splitNumber,
    setNumberPart: setNumberPart,
    numberWarning: numberWarning,
    highestUsed: highestUsed,
    formatQuoteNumber: formatQuoteNumber,
    nextNumberFor: nextNumberFor,
    counterKey: counterKey,
    toFile: toFile,
    logoImg: logoImg,
    buildSummary: buildSummary,
    FILE_VERSION: FILE_VERSION,
    fromFile: fromFile,
    fileName: fileName,
    unitLabel: unitLabel,
    scopeText: scopeText,
    addendaText: addendaText,
    scopeTextAuto: scopeTextAuto,
    render: render,
    esc: esc
  };
})(window);
