/* pricing.js — takeoff rows + rates -> priced line items.  Exposes window.Pricing.
 *
 * Mirrors the Excel "Template" sheet:
 *   Total SQ  L9 = roundUp(sum(Waste Sq Ft), 100)
 *   Lineal Ft J9 = ROUNDUP(L9 / K9, 0)
 *   Material  H9 = L9 * 2.85
 *   Labor     H10 = L9 / 320 * A11,  A11 = 148*8 + 400
 *   Total     D15 = M + L
 */
(function (global) {
  'use strict';

  var U = global.Units;
  var IGNORE = '__ignore__';

  function num(v, dflt) {
    var n = U.parseNumber(v);
    return n === null ? dflt : n;
  }

  /** Accept legacy field names from the original spec. */
  function normalizeCatalogItem(item) {
    var it = Object.assign({}, item);
    if (it.materialRate === undefined && it.materialRatePerSf !== undefined) it.materialRate = it.materialRatePerSf;
    if (it.unitsPerDay === undefined && it.sfPerDay !== undefined) it.unitsPerDay = it.sfPerDay;
    delete it.materialRatePerSf;
    delete it.sfPerDay;
    it.subject = String(it.subject || '').trim();
    it.unit = (it.unit || 'sf').toLowerCase();
    // Blank = not known yet (typed in on each quote). 0 is a real value (free / no labor).
    it.materialRate = num(it.materialRate, null);
    it.unitsPerDay = num(it.unitsPerDay, null);
    if (it.roundTo !== undefined && it.roundTo !== null && it.roundTo !== '') it.roundTo = num(it.roundTo, null);
    else delete it.roundTo;
    return it;
  }

  function dayRate(labor) {
    return num(labor.hourlyRate, 0) * num(labor.hoursPerDay, 0) + num(labor.dailyAdder, 0);
  }

  function findCatalogItem(catalog, subject) {
    var key = String(subject || '').trim().toLowerCase();
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].subject.toLowerCase() === key) return catalog[i];
    }
    return null;
  }

  /**
   * Which catalog item does a Bluebeam base subject price as?
   * Returns { item } | { ignored: true } | { unmapped: true }
   */
  function resolveSubject(baseSubject, rates) {
    var map = rates.subjectMap || {};
    var mapped = map[baseSubject];
    if (mapped === IGNORE) return { ignored: true };
    if (mapped) {
      var m = findCatalogItem(rates.catalog, mapped);
      if (m) return { item: m };
    }
    var direct = findCatalogItem(rates.catalog, baseSubject);
    if (direct) return { item: direct };
    return { unmapped: true };
  }

  /** Quantity contributed by one takeoff row, and how it was derived. */
  function rowQuantity(row, item, qtySettings) {
    var waste = 1 + num(qtySettings.wastePct, 0) / 100;
    if (item.unit === 'lf') {
      return row.measurement !== null ? { qty: row.measurement, basis: 'measurement' } : { qty: null, basis: 'missing' };
    }
    if (item.unit === 'ea') {
      if (/count|ea|each/i.test(row.measurementUnit || '') && row.measurement !== null) return { qty: row.measurement, basis: 'count' };
      return { qty: 1, basis: 'markup' };
    }
    // square feet
    var calc = (row.measurement !== null && row.installHeight !== null) ? row.measurement * row.installHeight * waste : null;
    var src = qtySettings.source || 'wasteSqFt';
    if (src === 'wasteSqFt') {
      if (row.wasteSqFt !== null) return { qty: row.wasteSqFt, basis: 'wasteSqFt' };
      if (row.sqFt !== null) return { qty: row.sqFt * waste, basis: 'sqFt+waste', fallback: true };
      if (calc !== null) return { qty: calc, basis: 'calc+waste', fallback: true };
    } else if (src === 'sqFt') {
      if (row.sqFt !== null) return { qty: row.sqFt * waste, basis: 'sqFt+waste' };
      if (calc !== null) return { qty: calc, basis: 'calc+waste', fallback: true };
    } else if (calc !== null) {
      return { qty: calc, basis: 'calc+waste' };
    }
    return { qty: null, basis: 'missing' };
  }

  /** "(3) ROOMS @ 8' AFF" — the scope-of-work label from the Excel sheet. */
  function defaultScopeLabel(line) {
    var parts = [];
    if (line.roomCount) parts.push('(' + line.roomCount + ') ' + (line.roomCount === 1 ? 'ROOM' : 'ROOMS'));
    if (line.unit === 'sf' && line.height) parts.push('@ ' + U.formatFeet(line.height) + ' AFF');
    return parts.join(' ');
  }

  /** Whole number of rooms >= 1, or null. */
  function parseRooms(v) {
    var n = U.parseNumber(v);
    return n !== null && n >= 1 ? Math.round(n) : null;
  }

  /**
   * Price a quote.
   * @param quote  { rates:{catalog,labor,quantity,subjectMap}, lineOverrides, excludedRows, manualLines, groupByRoom, taxPct }
   * @param rows   detail rows from Parse
   * @returns { lines, totals, unmapped, ignored, warnings, dayRate }
   */
  function price(quote, rows) {
    rows = rows || [];
    var rates = {
      catalog: (quote.rates.catalog || []).map(normalizeCatalogItem),
      labor: quote.rates.labor || {},
      quantity: quote.rates.quantity || {},
      subjectMap: quote.rates.subjectMap || {},
      // "manual": material $ and units/day are typed in on each quote (blank until entered).
      // "catalog": they default to the catalog item's rates.
      rateEntry: quote.rates.rateEntry === 'catalog' ? 'catalog' : 'manual'
    };
    var manualRates = rates.rateEntry === 'manual';
    var overrides = quote.lineOverrides || {};
    var excluded = quote.excludedRows || {};
    var dr = dayRate(rates.labor);
    var warnings = [];
    var groups = {};
    var order = [];
    var unmapped = {};
    var ignored = {};

    function groupFor(item, height, room) {
      var hKey = item.unit === 'sf' ? (height === null ? '?' : String(+height.toFixed(4))) : '';
      var key = item.subject + '|' + hKey + (quote.groupByRoom ? '|' + (room || '') : '');
      if (!groups[key]) {
        groups[key] = {
          key: key, item: item, height: item.unit === 'sf' ? height : null,
          room: quote.groupByRoom ? (room || '') : null,
          rowIds: [], rooms: [], rawQty: 0, hasQty: false, manual: false
        };
        order.push(key);
      }
      return groups[key];
    }

    rows.forEach(function (row) {
      if (excluded[row.id]) return;
      var res = resolveSubject(row.baseSubject, rates);
      if (res.ignored) { ignored[row.baseSubject] = (ignored[row.baseSubject] || 0) + 1; return; }
      if (res.unmapped) {
        var u = unmapped[row.baseSubject] || (unmapped[row.baseSubject] = { subject: row.baseSubject, rows: 0 });
        u.rows++;
        return;
      }
      var item = res.item;
      var q = rowQuantity(row, item, rates.quantity);
      if (q.qty === null) {
        warnings.push({ level: 'warn', code: 'blankqty', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ', page ' + (row.page || '?') + ') has no usable quantity and was not priced.' });
        return;
      }
      if (q.fallback) {
        warnings.push({ level: 'info', code: 'fallback', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ') has no ' + (rates.quantity.source === 'sqFt' ? 'SQ. FT' : 'Waste Sq FT.') + ' value; used ' + q.basis + ' instead.' });
      }
      if (item.unit === 'sf' && row.installHeight === null) {
        warnings.push({ level: 'warn', code: 'noheight', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ') has no Install Height.' });
      }
      var g = groupFor(item, row.installHeight, row.room || row.space);
      g.rowIds.push(row.id);
      g.rawQty += q.qty;
      g.hasQty = true;
      var roomName = row.room || row.space;
      if (roomName && g.rooms.indexOf(roomName) === -1) g.rooms.push(roomName);
    });

    // Manual lines (added on the Pricing screen, not from the takeoff)
    (quote.manualLines || []).forEach(function (ml) {
      var item = findCatalogItem(rates.catalog, ml.catalogSubject);
      if (!item) {
        warnings.push({ level: 'warn', code: 'manual', message: 'Manual line uses catalog item "' + ml.catalogSubject + '", which is not in this quote\'s catalog.' });
        return;
      }
      var key = 'manual|' + ml.id;
      groups[key] = {
        key: key, item: item, height: item.unit === 'sf' ? U.parseFeet(ml.height) : null, room: null,
        rowIds: [], rooms: [], rawQty: num(ml.qty, 0), hasQty: true, manual: true, manualId: ml.id
      };
      order.push(key);
    });

    // Stable order: catalog order, then height, then room; manual lines last.
    var catIndex = {};
    rates.catalog.forEach(function (c, i) { catIndex[c.subject] = i; });
    order.sort(function (a, b) {
      var A = groups[a], B = groups[b];
      if (A.manual !== B.manual) return A.manual ? 1 : -1;
      if (A.manual) return 0;
      var d = catIndex[A.item.subject] - catIndex[B.item.subject];
      if (d) return d;
      d = (A.height || 0) - (B.height || 0);
      if (d) return d;
      return String(A.room || '').localeCompare(String(B.room || ''));
    });

    var lines = order.map(function (key) {
      var g = groups[key];
      var item = g.item;
      var ov = overrides[key] || {};
      var line = {
        key: key,
        manual: g.manual,
        manualId: g.manualId,
        catalogSubject: item.subject,
        code: item.code || '',
        unit: item.unit,
        rowIds: g.rowIds,
        rowCount: g.rowIds.length,
        rooms: g.rooms,
        room: g.room,
        excluded: !!ov.excluded
      };
      line.height = item.unit === 'sf' ? (ov.height !== undefined && ov.height !== '' ? U.parseFeet(ov.height) : g.height) : null;
      line.rawQty = g.rawQty;
      // Manual lines are priced exactly as typed; takeoff lines round up like the Excel sheet.
      var roundTo = g.manual ? 0 : (item.roundTo !== undefined ? item.roundTo : (item.unit === 'sf' ? num(rates.quantity.roundTo, 0) : 1));
      line.roundTo = roundTo;
      line.autoQty = U.roundUp(g.rawQty, roundTo);
      line.qtyOverridden = ov.qty !== undefined && ov.qty !== '' && U.parseNumber(ov.qty) !== null;
      line.qty = line.qtyOverridden ? U.parseNumber(ov.qty) : line.autoQty;
      line.linealFt = item.unit === 'sf'
        ? (line.height ? Math.ceil(line.qty / line.height - 1e-9) : null)
        : (item.unit === 'lf' ? line.qty : null);
      function rate(f) {
        var v = ov[f] !== undefined && ov[f] !== '' ? U.parseNumber(ov[f]) : null;
        if (v !== null) return v;
        return manualRates ? null : item[f];
      }
      line.materialRate = rate('materialRate');     // null = not entered yet (manual mode)
      line.unitsPerDay = rate('unitsPerDay');
      line.missingRates = [];
      if (line.materialRate === null) line.missingRates.push('material $/' + item.unit);
      if (line.unitsPerDay === null) line.missingRates.push(item.unit + '/day');
      line.description = ov.description !== undefined ? ov.description : (item.description || item.subject);
      line.scope = ov.scope !== undefined ? ov.scope : (item.scope || '');
      // Room count: typed on the Pricing tab, else the number of distinct Room/Space values in the takeoff.
      line.roomsAuto = g.rooms.length || null;
      line.roomsOverridden = parseRooms(ov.rooms) !== null;
      line.roomCount = line.roomsOverridden ? parseRooms(ov.rooms) : line.roomsAuto;
      line.scopeLabelAuto = defaultScopeLabel(line);
      line.scopeLabelOverridden = ov.scopeLabel !== undefined;
      line.scopeLabel = line.scopeLabelOverridden ? ov.scopeLabel : line.scopeLabelAuto;
      // Wall (sf) lines read "(X) ROOMS @ X' AFF"; flag them until the room count is known.
      line.needsRooms = item.unit === 'sf' && line.roomCount === null && !line.scopeLabelOverridden;
      line.dayRate = dr;
      line.laborDaysRaw = line.unitsPerDay > 0 ? line.qty / line.unitsPerDay : 0;   // 0 sf/day = no labor
      line.laborDays = U.roundDays(line.laborDaysRaw, rates.labor.dayRounding);
      line.material = U.roundMoney(line.qty * (line.materialRate || 0));
      line.labor = U.roundMoney(line.laborDays * dr);
      line.total = U.roundMoney(line.material + line.labor);
      return line;
    });

    var totals = { material: 0, labor: 0, laborDays: 0, subtotal: 0, tax: 0, total: 0, taxPct: num(quote.taxPct, 0), linesMissingRates: 0, linesMissingRooms: 0 };
    lines.forEach(function (l) {
      if (l.excluded) return;
      if (l.needsRooms) {
        totals.linesMissingRooms++;
        warnings.push({ level: 'warn', code: 'needsrooms', lineKey: l.key,
          message: (l.scopeLabel || l.catalogSubject) + ' (' + l.catalogSubject + '): enter the number of rooms for the scope of work, e.g. "(3) ROOMS ' + (l.scopeLabel || '') + '".' });
      }
      if (l.missingRates.length) {
        totals.linesMissingRates++;
        warnings.push({ level: 'warn', code: 'needsrate', lineKey: l.key,
          message: (l.scopeLabel || l.catalogSubject) + ' (' + l.catalogSubject + '): enter ' + l.missingRates.join(' and ') + '.' });
      }
      totals.material += l.material;
      totals.labor += l.labor;
      totals.laborDays += l.laborDays;
    });
    totals.material = U.roundMoney(totals.material);
    totals.labor = U.roundMoney(totals.labor);
    totals.subtotal = U.roundMoney(totals.material + totals.labor);
    totals.tax = U.roundMoney(totals.material * totals.taxPct / 100);
    totals.total = U.roundMoney(totals.subtotal + totals.tax);

    Object.keys(unmapped).forEach(function (s) {
      warnings.unshift({ level: 'warn', code: 'unmapped', subject: s, message: 'Subject "' + s + '" (' + unmapped[s].rows + ' row' + (unmapped[s].rows === 1 ? '' : 's') + ') is not mapped to a catalog item and is not priced.' });
    });

    return {
      lines: lines,
      totals: totals,
      dayRate: dr,
      unmapped: Object.keys(unmapped).map(function (k) { return unmapped[k]; }),
      ignored: ignored,
      warnings: warnings
    };
  }

  global.Pricing = {
    IGNORE: IGNORE,
    price: price,
    dayRate: dayRate,
    rowQuantity: rowQuantity,
    resolveSubject: resolveSubject,
    findCatalogItem: findCatalogItem,
    normalizeCatalogItem: normalizeCatalogItem
  };
})(window);
