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

  /* ---------- union wage area: Local vs Bay Area ---------- */

  function normCity(s) {
    return String(s || '').toLowerCase().replace(/^st\.?\s+/, 'saint ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * City from a project address:
   *   "2165 Lombard St, San Francisco CA, 94123" -> "San Francisco"
   *   "123 Main St, Oakland, CA 94607"           -> "Oakland"
   *   "123 Main St San Jose CA 95112"            -> "San Jose" (no commas: matched against knownCities)
   */
  function cityFromAddress(address, knownCities) {
    var parts = String(address || '').replace(/\r?\n/g, ',').split(',').map(function (p) {
      return p.replace(/\b\d{5}(-\d{4})?\b/g, ' ')
        .replace(/\b(california|calif\.?)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim()
        .replace(/(^|\s)ca\.?$/i, '')            // state: CA / ca
        .replace(/(^|\s)[A-Z]{2}\.?$/, '')        // other states, upper-case only (NV, OR ...)
        .trim();
    }).filter(Boolean);
    if (!parts.length) return null;
    var last = parts[parts.length - 1];
    if (parts.length >= 2 || !/\d/.test(last)) return last;
    // One chunk with a street number: look for a known city at the end.
    var hay = ' ' + normCity(last);
    var best = null;
    (knownCities || []).forEach(function (c) {
      var n = normCity(c);
      if (n && hay.slice(-(n.length + 1)) === ' ' + n && (!best || n.length > normCity(best).length)) best = c;
    });
    return best;
  }

  /**
   * Which union rate a quote uses.
   * quote.laborZone: "auto" (from the project city) | "local" | "bay"
   * Returns { mode, zone: "local"|"bay", city, inList }
   */
  function laborArea(quote) {
    var cities = (quote.rates && quote.rates.bayAreaCities) || (global.DEFAULTS && global.DEFAULTS.bayAreaCities) || [];
    var city = cityFromAddress(quote.project && quote.project.address, cities);
    var set = {};
    cities.forEach(function (c) { set[normCity(c)] = true; });
    var inList = !!(city && set[normCity(city)]);
    var mode = quote.laborZone === 'local' || quote.laborZone === 'bay' ? quote.laborZone : 'auto';
    return { mode: mode, zone: mode === 'auto' ? (inList ? 'bay' : 'local') : mode, city: city, inList: inList };
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
  /** Unit a row is priced in: what the CSV says (Count -> EA, Install Height "LF" -> LF), else the catalog item's. */
  function rowUnit(row, item) {
    var u = global.Parse && global.Parse.rowUnit ? global.Parse.rowUnit(row) : null;
    return u || item.unit;
  }

  function rowQuantity(row, unitOrItem, qtySettings) {
    var unit = typeof unitOrItem === 'string' ? unitOrItem : unitOrItem.unit;
    var item = { unit: unit };
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
    EA: { one: 'EA', aff: false },
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
    var area = laborArea(quote);
    var hourly = area.zone === 'bay' ? rates.labor.bayAreaHourlyRate : rates.labor.hourlyRate;
    var hourlyMissing = U.parseNumber(hourly) === null;
    var dr = dayRate(Object.assign({}, rates.labor, { hourlyRate: hourly }));
    var warnings = [];
    var groups = {};
    var order = [];
    var unmapped = {};
    var ignored = {};

    // One line per Bluebeam subject × install height (× room). Two subjects priced as the same catalog
    // item stay separate lines (e.g. "FRP-10'" and "FRP-10' CMU": same material, different sf/day).
    var subjectOrder = {};
    // Default scope count = Bluebeam's group count, e.g. 2 from "104-FRP-10' (2)".
    var groupCount = {};
    ((quote.source && quote.source.subtotals) || []).forEach(function (st) {
      if (st.count) groupCount[st.baseSubject] = st.count;
    });
    var subjectRows = {};     // all detail rows per subject, ticked or not
    var subjectLines = {};    // how many lines each subject is split into
    rows.forEach(function (r) { subjectRows[r.baseSubject] = (subjectRows[r.baseSubject] || 0) + 1; });
    function groupFor(item, unit, subject, height, room) {
      // sf lines split by height; LF/EA rows of an sf item (from the CSV) get their own line.
      var hKey = unit === 'sf' ? (height === null ? '?' : String(+height.toFixed(4))) : (unit === item.unit ? '' : unit);
      var roomKey = quote.groupByRoom ? '|' + (room || '') : '';
      var key = subject + '|' + hKey + roomKey;
      if (!groups[key]) {
        if (subjectOrder[subject] === undefined) subjectOrder[subject] = Object.keys(subjectOrder).length;
        subjectLines[subject] = (subjectLines[subject] || 0) + 1;
        groups[key] = {
          key: key,
          legacyKey: item.subject + '|' + hKey + roomKey,   // key format before per-subject lines
          item: item, unit: unit, subject: subject, height: unit === 'sf' ? height : null,
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
      var unit = rowUnit(row, item);
      var q = rowQuantity(row, unit, rates.quantity);
      if (q.qty === null) {
        warnings.push({ level: 'warn', code: 'blankqty', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ', page ' + (row.page || '?') + ') has no usable quantity and was not priced.' });
        return;
      }
      if (q.fallback) {
        warnings.push({ level: 'info', code: 'fallback', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ') has no ' + (rates.quantity.source === 'sqFt' ? 'SQ. FT' : 'Waste Sq FT.') + ' value; used ' + q.basis + ' instead.' });
      }
      if (unit === 'sf' && row.installHeight === null) {
        warnings.push({ level: 'warn', code: 'noheight', rowId: row.id, message: 'Row ' + row.line + ' (' + row.subject + ') has no Install Height.' });
      }
      var g = groupFor(item, unit, row.baseSubject, row.installHeight, row.room || row.space);
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
        key: key, item: item, unit: item.unit, height: item.unit === 'sf' ? U.parseFeet(ml.height) : null, room: null,
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
      var RANK = { sf: 0, lf: 1, ea: 2 };
      d = (RANK[A.unit] || 0) - (RANK[B.unit] || 0);          // walls, then LF, then EA
      if (d) return d;
      d = (A.height || 0) - (B.height || 0);
      if (d) return d;
      return String(A.room || '').localeCompare(String(B.room || ''));
    });

    var lines = order.map(function (key) {
      var g = groups[key];
      var item = g.item;
      var unit = g.unit || item.unit;
      var sameUnit = unit === item.unit;   // catalog rates are per the item's unit; don't reuse $/sf for EA
      // Quotes saved before per-subject lines keyed overrides by catalog item; still honour those.
      var ov = overrides[key] || (g.legacyKey && overrides[g.legacyKey]) || {};
      var line = {
        key: key,
        manual: g.manual,
        manualId: g.manualId,
        catalogSubject: item.subject,
        legacyKey: g.legacyKey || null,
        code: item.code || '',
        unit: unit,
        unitFromCsv: !sameUnit,
        rowIds: g.rowIds,
        rowCount: g.rowIds.length,
        rooms: g.rooms,
        room: g.room,
        excluded: !!ov.excluded
      };
      line.height = unit === 'sf' ? (ov.height !== undefined && ov.height !== '' ? U.parseFeet(ov.height) : g.height) : null;
      line.rawQty = g.rawQty;
      // Quantities are used as measured unless a rounding is set (catalog item, or "Round SF up to" for sf).
      var roundTo = g.manual ? 0 : (sameUnit && item.roundTo !== undefined ? item.roundTo : (unit === 'sf' ? num(rates.quantity.roundTo, 0) : 0));
      line.roundTo = roundTo;
      line.autoQty = U.roundUp(g.rawQty, roundTo);
      line.qtyOverridden = ov.qty !== undefined && ov.qty !== '' && U.parseNumber(ov.qty) !== null;
      line.qty = line.qtyOverridden ? U.parseNumber(ov.qty) : line.autoQty;
      // A Total SQ typed below what the takeoff measured is probably a mistake: flag it (not an error).
      line.qtyBelowTakeoff = line.qtyOverridden && !g.manual && line.qty < g.rawQty - 1e-9;
      line.linealFt = unit === 'sf'
        ? (line.height ? Math.ceil(line.qty / line.height - 1e-9) : null)
        : (unit === 'lf' ? line.qty : null);
      function rate(f) {
        var v = ov[f] !== undefined && ov[f] !== '' ? U.parseNumber(ov[f]) : null;
        if (v !== null) return v;
        return manualRates || !sameUnit ? null : item[f];
      }
      line.materialRate = rate('materialRate');     // null = not entered yet (manual mode)
      line.unitsPerDay = rate('unitsPerDay');
      line.missingRates = [];
      line.missingHourly = false;
      if (line.materialRate === null) line.missingRates.push('material $/' + unit);
      // Labor can be entered as a number of days instead (e.g. 9 days for custom work).
      var daysOv = ov.laborDays !== undefined && ov.laborDays !== '' ? U.parseNumber(ov.laborDays) : null;
      line.laborDaysOverridden = daysOv !== null && daysOv >= 0;
      if (line.unitsPerDay === null && !line.laborDaysOverridden) line.missingRates.push(unit + '/day');
      // The union hourly rate for this area isn't set: any line with labor is incomplete.
      if (hourlyMissing && !(line.unitsPerDay === 0 && !line.laborDaysOverridden)) line.missingHourly = true;
      line.description = ov.description !== undefined ? ov.description : (item.description || item.subject);
      line.scope = ov.scope !== undefined ? ov.scope : (item.scope || '');
      // Scope count default: the Bluebeam group count ("(15)") when this line holds all of that subject's
      // markups; otherwise (rows unticked, or the subject split by height/room) the markups on this line.
      // Room/Space names are only a hint: one Room ("SALES") can hold many rooms.
      line.roomNames = g.rooms.slice();
      if (g.manual || !g.rowIds.length) {
        line.roomsAuto = null; line.roomsSource = null;
      } else if (unit === 'ea') {
        line.roomsAuto = Math.round(line.qty) || null; line.roomsSource = 'qty';   // "(12) EA"
      } else if (groupCount[g.subject] && subjectLines[g.subject] === 1 && g.rowIds.length === subjectRows[g.subject]) {
        line.roomsAuto = groupCount[g.subject]; line.roomsSource = 'group';
      } else {
        line.roomsAuto = g.rowIds.length; line.roomsSource = 'markups';
      }
      line.roomsOverridden = parseRooms(ov.rooms) !== null;
      line.roomCount = line.roomsOverridden ? parseRooms(ov.rooms) : line.roomsAuto;
      line.subject = g.subject || null;
      line.roomNounAuto = unit === 'ea' ? 'EA' : guessNoun(g.subject || item.subject);
      line.roomNoun = ov.roomNoun ? String(ov.roomNoun).toUpperCase() : line.roomNounAuto;
      line.scopeNoteAuto = guessNote(g.subject || item.subject);
      line.scopeNote = ov.scopeNote !== undefined ? String(ov.scopeNote).trim() : line.scopeNoteAuto;
      line.scopeLabelAuto = defaultScopeLabel(line);
      line.scopeLabelOverridden = ov.scopeLabel !== undefined;
      line.scopeLabel = line.scopeLabelOverridden ? ov.scopeLabel : line.scopeLabelAuto;
      // Wall (sf) lines read "(X) ROOMS @ X' AFF"; flag them until the room count is known.
      line.needsRooms = unit === 'sf' && line.roomCount === null && !line.scopeLabelOverridden;
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
      if (l.missingHourly && !l.missingRates.length) totals.linesMissingRates++;
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

    if (lines.some(function (l) { return l.missingHourly && !l.excluded; })) {
      warnings.unshift({ level: 'warn', code: 'needshourly',
        message: 'This job uses the ' + (area.zone === 'bay' ? 'Bay Area' : 'Local') + ' rate' + (area.city ? ' (' + area.city + ')' : '') +
          ', but that hourly rate is not set. Enter it under Rates for this quote, or in Settings.' });
    }
    Object.keys(unmapped).forEach(function (s) {
      warnings.unshift({ level: 'warn', code: 'unmapped', subject: s, message: 'Subject "' + s + '" (' + unmapped[s].rows + ' row' + (unmapped[s].rows === 1 ? '' : 's') + ') is not mapped to a catalog item and is not priced.' });
    });

    return {
      lines: lines,
      totals: totals,
      dayRate: dr,
      laborArea: area,
      hourlyRate: U.parseNumber(hourly),
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
    cityFromAddress: cityFromAddress,
    laborArea: laborArea,
    rowQuantity: rowQuantity,
    rowUnit: rowUnit,
    resolveSubject: resolveSubject,
    findCatalogItem: findCatalogItem,
    normalizeCatalogItem: normalizeCatalogItem
  };
})(window);
