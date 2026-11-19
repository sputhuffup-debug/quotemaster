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

  /*
   * Scope-of-work label, as on the Excel sheet:
   *   (6) AREAS @ 10' AFF      (7) AREAS @ 10' AFF o/ CMU      (4) SOFFITS @ 2'      (3) ROOMS @ 8' AFF
   * Overhead nouns (soffits, ceilings) give a depth, not a height above the floor, so they get no "AFF".
   */
  var NOUNS = {
    ROOMS: { one: 'ROOM', aff: true },
    AREAS: { one: 'AREA', aff: true },
    WALLS: { one: 'WALL', aff: true },
    COLUMNS: { one: 'COLUMN', aff: true },
    SOFFITS: { one: 'SOFFIT', aff: false },
    CEILINGS: { one: 'CEILING', aff: false }
  };

  /** Guess the noun / note from the Bluebeam subject: "FRP-SOFFIT" -> SOFFITS, "FRP-10' CMU" -> "o/ CMU". */
  function guessNoun(subject) {
    var s = String(subject || '');
    if (/soffit/i.test(s)) return 'SOFFITS';
    if (/ceiling|clg/i.test(s)) return 'CEILINGS';
    if (/column|col\b/i.test(s)) return 'COLUMNS';
    return 'ROOMS';
  }
  function guessNote(subject) {
    return /\bcmu\b/i.test(String(subject || '')) ? 'o/ CMU' : '';
  }

  function defaultScopeLabel(line) {
    var noun = NOUNS[line.roomNoun] || { one: line.roomNoun, aff: true };
    var parts = [];
    if (line.roomCount) parts.push('(' + line.roomCount + ') ' + (line.roomCount === 1 ? noun.one : line.roomNoun));
    if (line.unit === 'sf' && line.height) parts.push('@ ' + U.formatFeet(line.height) + (noun.aff ? ' AFF' : ''));
    if (line.scopeNote) parts.push(line.scopeNote);
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

    // One line per Bluebeam subject × install height (× room). Two subjects priced as the same catalog
    // item stay separate lines (e.g. "FRP-10'" and "FRP-10' CMU": same material, different sf/day).
    var subjectOrder = {};
    function groupFor(item, subject, height, room) {
      var hKey = item.unit === 'sf' ? (height === null ? '?' : String(+height.toFixed(4))) : '';
      var roomKey = quote.groupByRoom ? '|' + (room || '') : '';
      var key = subject + '|' + hKey + roomKey;
      if (!groups[key]) {
        if (subjectOrder[subject] === undefined) subjectOrder[subject] = Object.keys(subjectOrder).length;
        groups[key] = {
          key: key,
          legacyKey: item.subject + '|' + hKey + roomKey,   // key format before per-subject lines
          item: item, subject: subject, height: item.unit === 'sf' ? height : null,
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
      var g = groupFor(item, row.baseSubject, row.installHeight, row.room || row.space);
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
      d = subjectOrder[A.subject] - subjectOrder[B.subject];   // takeoff order within an item
      if (d) return d;
      d = (A.height || 0) - (B.height || 0);
      if (d) return d;
      return String(A.room || '').localeCompare(String(B.room || ''));
    });

    var lines = order.map(function (key) {
      var g = groups[key];
      var item = g.item;
      // Quotes saved before per-subject lines keyed overrides by catalog item; still honour those.
      var ov = overrides[key] || (g.legacyKey && overrides[g.legacyKey]) || {};
      var line = {
        key: key,
        manual: g.manual,
        manualId: g.manualId,
        catalogSubject: item.subject,
        legacyKey: g.legacyKey || null,
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
      // A Total SQ typed below what the takeoff measured is probably a mistake: flag it (not an error).
      line.qtyBelowTakeoff = line.qtyOverridden && !g.manual && line.qty < g.rawQty - 1e-9;
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
      // Labor can be entered as a number of days instead (e.g. 9 days for custom work).
      var daysOv = ov.laborDays !== undefined && ov.laborDays !== '' ? U.parseNumber(ov.laborDays) : null;
      line.laborDaysOverridden = daysOv !== null && daysOv >= 0;
      if (line.unitsPerDay === null && !line.laborDaysOverridden) line.missingRates.push(item.unit + '/day');
      line.description = ov.description !== undefined ? ov.description : (item.description || item.subject);
      line.scope = ov.scope !== undefined ? ov.scope : (item.scope || '');
      // Room count: typed on the Pricing tab, else the number of distinct Room/Space values in the takeoff.
      // Room/Space names from the takeoff are shown as a hint only: in real exports one Room ("SALES")
      // can hold 4 rooms or 9 signs, so the count is always typed in.
      line.roomNames = g.rooms.slice();
      line.roomsAuto = null;
      line.roomsOverridden = parseRooms(ov.rooms) !== null;
      line.roomCount = line.roomsOverridden ? parseRooms(ov.rooms) : line.roomsAuto;
      line.subject = g.subject || null;
      line.roomNounAuto = guessNoun(g.subject || item.subject);
      line.roomNoun = ov.roomNoun ? String(ov.roomNoun).toUpperCase() : line.roomNounAuto;
      line.scopeNoteAuto = guessNote(g.subject || item.subject);
      line.scopeNote = ov.scopeNote !== undefined ? String(ov.scopeNote).trim() : line.scopeNoteAuto;
      line.scopeLabelAuto = defaultScopeLabel(line);
      line.scopeLabelOverridden = ov.scopeLabel !== undefined;
      line.scopeLabel = line.scopeLabelOverridden ? ov.scopeLabel : line.scopeLabelAuto;
      // Wall (sf) lines read "(X) ROOMS @ X' AFF"; flag them until the room count is known.
      line.needsRooms = item.unit === 'sf' && line.roomCount === null && !line.scopeLabelOverridden;
      line.dayRate = dr;
      line.laborDaysAuto = line.unitsPerDay > 0 ? U.roundDays(line.qty / line.unitsPerDay, rates.labor.dayRounding) : 0;   // 0 sf/day = no labor
      line.laborDaysRaw = line.laborDaysOverridden ? daysOv : (line.unitsPerDay > 0 ? line.qty / line.unitsPerDay : 0);
      line.laborDays = line.laborDaysOverridden ? daysOv : line.laborDaysAuto;
      line.material = U.roundMoney(line.qty * (line.materialRate || 0));
      line.labor = U.roundMoney(line.laborDays * dr);
      line.total = U.roundMoney(line.material + line.labor);
      return line;
    });

    var totals = { material: 0, labor: 0, laborDays: 0, subtotal: 0, tax: 0, total: 0, taxPct: num(quote.taxPct, 0), linesMissingRates: 0, linesMissingRooms: 0 };
    lines.forEach(function (l) {
      if (l.excluded) return;
      if (l.qtyBelowTakeoff) {
        warnings.push({ level: 'warn', code: 'qtybelow', lineKey: l.key,
          message: (l.scopeLabel || l.catalogSubject) + ' (' + (l.subject || l.catalogSubject) + '): Total SQ ' + U.formatNumber(l.qty, 2) +
            ' is less than the takeoff ' + U.formatNumber(l.rawQty, 2) + '. Check it is not a typo.' });
      }
      if (l.needsRooms) {
        totals.linesMissingRooms++;
        warnings.push({ level: 'warn', code: 'needsrooms', lineKey: l.key,
          message: (l.scopeLabel || l.catalogSubject) + ' (' + (l.subject || l.catalogSubject) + '): enter the count for the scope of work, e.g. "(3) ' + l.roomNoun + ' ' + (l.scopeLabel || '') + '".' });
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
    NOUNS: NOUNS,
    IGNORE: IGNORE,
    price: price,
    dayRate: dayRate,
    rowQuantity: rowQuantity,
    resolveSubject: resolveSubject,
    findCatalogItem: findCatalogItem,
    normalizeCatalogItem: normalizeCatalogItem
  };
})(window);
