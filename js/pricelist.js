/* pricelist.js — import the material price list (Excel .xlsx or .csv) into the catalog.  Exposes window.PriceList.
 *
 * The spreadsheet needs a header row; columns are matched by name (any order, extra columns ignored):
 *   Item         the name used in the app. Use the Bluebeam markup Subject (e.g. FRP-8') to match automatically,
 *                or map Bluebeam subjects to items on the Import tab.                         (required, or Code)
 *   Code         SKU / part number                                                             (optional)
 *   Description  material description printed on quotes                                        (optional)
 *   Unit         SF, LF or EA                                                                  (optional, default SF)
 *   Material Cost   $ per unit                                                                 (optional)
 *   Install Rate    units installed per crew-day, e.g. sf/day                                  (optional)
 *   Scope        scope paragraph                                                               (optional)
 *   Round To     round quantity up to this multiple                                            (optional)
 * Blank cells leave the existing catalog value unchanged.
 */
(function (global) {
  'use strict';

  var U = global.Units;
  var P = global.Pricing;

  /** "Material Cost ($/unit)" -> "materialcost" */
  function normHeader(h) {
    return String(h === null || h === undefined ? '' : h)
      .replace(/^﻿/, '')
      .replace(/\([^)]*\)/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  var FIELDS = {
    subject: ['item', 'itemname', 'subject', 'bluebeamsubject', 'markupsubject', 'name'],
    code: ['code', 'itemcode', 'sku', 'partnumber', 'partno', 'part', 'productcode', 'itemno', 'itemnumber'],
    description: ['description', 'desc', 'materialdescription', 'itemdescription', 'material', 'product'],
    unit: ['unit', 'units', 'uom', 'unitofmeasure'],
    materialRate: ['materialcost', 'cost', 'unitcost', 'price', 'unitprice', 'materialprice', 'materialrate',
      'costperunit', 'materialcostperunit', 'materialperunit', 'materialunit', 'materialsf', 'costsf', 'pricesf', 'costunit'],
    unitsPerDay: ['installrate', 'unitsperday', 'sfperday', 'sqftperday', 'sfday', 'perday', 'installperday',
      'productionperday', 'production', 'productionrate', 'unitsday', 'lfperday', 'eaperday'],
    scope: ['scope', 'scopeofwork', 'scopeparagraph', 'scopetext'],
    roundTo: ['roundto', 'roundupto', 'rounding']
  };
  var LABELS = {
    subject: 'Item', code: 'Code', description: 'Description', unit: 'Unit',
    materialRate: 'Material cost', unitsPerDay: 'Install rate', scope: 'Scope', roundTo: 'Round to'
  };

  function mapHeader(row) {
    var norm = (row || []).map(normHeader);
    var cols = {};
    Object.keys(FIELDS).forEach(function (f) {
      for (var i = 0; i < FIELDS[f].length; i++) {
        var idx = norm.indexOf(FIELDS[f][i]);
        if (idx !== -1 && !taken(cols, idx)) { cols[f] = idx; return; }
      }
    });
    return cols;
  }
  function taken(cols, idx) { for (var k in cols) if (cols[k] === idx) return true; return false; }

  function normUnit(u) {
    var s = String(u || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s === '') return null;
    if (['sf', 'sqft', 'sqfeet', 'squarefeet', 'squarefoot', 'ft2', 'sqf', 'sft'].indexOf(s) !== -1) return 'sf';
    if (['lf', 'linft', 'linealft', 'linearft', 'linealfeet', 'linearfeet', 'lnft', 'ft', 'feet'].indexOf(s) !== -1) return 'lf';
    if (['ea', 'each', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'count', 'ct'].indexOf(s) !== -1) return 'ea';
    return undefined; // unknown
  }

  function cellText(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  /**
   * Parse one sheet (array of rows). Returns null if no header row is found,
   * else { headerRow, columns, items, warnings }.
   */
  function parseRows(rows) {
    var headerIdx = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 30); i++) {
      var c = mapHeader(rows[i]);
      var known = Object.keys(c).length;
      if ((c.subject !== undefined || c.code !== undefined) && known >= 2) { headerIdx = i; cols = c; break; }
    }
    if (headerIdx === -1) return null;

    var warnings = [];
    var items = [];
    var seen = {};
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var get = function (f) { return cols[f] === undefined ? '' : cellText(row[cols[f]]); };
      var subject = get('subject');
      var code = get('code');
      if (!subject && !code) {
        if (row.some(function (v) { return cellText(v) !== ''; })) {
          warnings.push('Row ' + (r + 1) + ' has no Item or Code and was skipped.');
        }
        continue;
      }
      var it = { line: r + 1, subject: subject || code };
      if (code) it.code = code;
      ['description', 'scope'].forEach(function (f) { var v = get(f); if (v) it[f] = v; });
      var unitRaw = get('unit');
      if (unitRaw) {
        var u = normUnit(unitRaw);
        if (u === undefined) {
          warnings.push('Row ' + (r + 1) + ' (' + it.subject + '): unit "' + unitRaw + '" is not SF, LF or EA, so it was treated as EA.');
          it.unit = 'ea';
        } else if (u) it.unit = u;
      }
      ['materialRate', 'unitsPerDay', 'roundTo'].forEach(function (f) {
        var raw = cols[f] === undefined ? '' : row[cols[f]];
        if (cellText(raw) === '') return;
        var n = U.parseNumber(raw);
        if (n === null || n < 0) warnings.push('Row ' + (r + 1) + ' (' + it.subject + '): ' + LABELS[f] + ' "' + cellText(raw) + '" is not a number and was ignored.');
        else it[f] = n;
      });
      var key = it.subject.toLowerCase();
      if (seen[key]) warnings.push('"' + it.subject + '" appears more than once (rows ' + seen[key] + ' and ' + (r + 1) + '); the last one is used.');
      seen[key] = r + 1;
      items.push(it);
    }
    return { headerRow: headerIdx + 1, columns: cols, items: items, warnings: warnings };
  }

  /** Pick the first sheet with a recognizable header row. sheets: [{ name, rows }] */
  function parseSheets(sheets) {
    for (var i = 0; i < sheets.length; i++) {
      var res = parseRows(sheets[i].rows);
      if (res) { res.sheetName = sheets[i].name; return res; }
    }
    throw new Error('No price list header row found. The sheet needs a header row with at least an "Item" (or "Code") column and a "Material Cost" or "Description" column. Use "Download template" for the expected layout.');
  }

  function same(a, b) {
    if (typeof a === 'number' || typeof b === 'number') return U.parseNumber(a) === U.parseNumber(b);
    return String(a === undefined || a === null ? '' : a) === String(b === undefined || b === null ? '' : b);
  }

  /** Work out what an import would change. Does not modify the catalog. */
  function plan(catalog, parsed, fileName) {
    var bySubject = {}, byCode = {};
    catalog.forEach(function (c, i) {
      bySubject[c.subject.toLowerCase()] = i;
      if (c.code) byCode[String(c.code).toLowerCase()] = i;
    });
    var matched = {};
    var added = [], updated = [], unchanged = 0;
    var last = {};
    parsed.items.forEach(function (it) { last[it.subject.toLowerCase()] = it; });   // duplicates: last wins
    Object.keys(last).forEach(function (k) {
      var it = last[k];
      var idx = bySubject[k];
      if (idx === undefined && it.code) idx = byCode[it.code.toLowerCase()];
      if (idx === undefined) { added.push(it); return; }
      matched[idx] = true;
      var cur = catalog[idx];
      var changes = [];
      ['code', 'description', 'unit', 'materialRate', 'unitsPerDay', 'scope', 'roundTo'].forEach(function (f) {
        if (it[f] === undefined) return;
        if (!same(cur[f], it[f])) changes.push({ field: f, label: LABELS[f], from: cur[f], to: it[f] });
      });
      if (changes.length) updated.push({ index: idx, subject: cur.subject, changes: changes });
      else unchanged++;
    });
    var notInList = catalog.filter(function (c, i) { return !matched[i]; }).map(function (c) { return c.subject; });
    return {
      fileName: fileName || '',
      sheetName: parsed.sheetName || '',
      itemCount: Object.keys(last).length,
      added: added,
      updated: updated,
      unchanged: unchanged,
      notInList: notInList,
      warnings: parsed.warnings
    };
  }

  /** Apply a plan to settings (mutates settings.catalog and records settings.priceList). */
  function apply(settings, pl) {
    pl.updated.forEach(function (u) {
      var cur = settings.catalog[u.index];
      u.changes.forEach(function (ch) { cur[ch.field] = ch.to; });
      settings.catalog[u.index] = P.normalizeCatalogItem(cur);
    });
    pl.added.forEach(function (it) {
      settings.catalog.push(P.normalizeCatalogItem({
        subject: it.subject, code: it.code || '', description: it.description || it.subject, scope: it.scope || '',
        unit: it.unit || 'sf', materialRate: it.materialRate, unitsPerDay: it.unitsPerDay, roundTo: it.roundTo
      }));
    });
    settings.priceList = {
      fileName: pl.fileName,
      sheetName: pl.sheetName,
      importedAt: new Date().toISOString(),
      itemCount: pl.itemCount
    };
    return settings;
  }

  /** Read a File (.xlsx or .csv) and return a plan against the catalog. */
  function planFromFile(file, catalog) {
    var isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    var isXls = /\.xls$/i.test(file.name);
    if (isXls) return Promise.reject(new Error('Old .xls files are not supported. In Excel, use File → Save As → Excel Workbook (.xlsx).'));
    var sheetsP = isCsv
      ? global.RqbStorage.readText(file).then(function (t) {
        var res = global.Papa.parse(String(t).replace(/^﻿/, ''), { skipEmptyLines: false });
        return [{ name: file.name, rows: res.data }];
      })
      : global.RqbStorage.readArrayBuffer(file).then(function (buf) { return global.Xlsx.read(buf); }).then(function (wb) { return wb.sheets; });
    return sheetsP.then(function (sheets) { return plan(catalog, parseSheets(sheets), file.name); });
  }

  var TEMPLATE_HEADERS = ['Item', 'Code', 'Description', 'Unit', 'Material Cost ($/unit)', 'Install Rate (units/day)', 'Scope'];

  /** Build an .xlsx Blob holding the current catalog in the import layout. */
  function templateBlob(catalog) {
    var rows = [TEMPLATE_HEADERS].concat(catalog.map(function (c) {
      return [c.subject, c.code || '', c.description || '', String(c.unit || 'sf').toUpperCase(),
        c.materialRate === null || c.materialRate === undefined ? '' : c.materialRate,
        c.unitsPerDay === null || c.unitsPerDay === undefined ? '' : c.unitsPerDay,
        c.scope || ''];
    }));
    var help = [
      ['How to use this price list'],
      [''],
      ['Keep one row per material on the "Price List" sheet. Columns can be in any order; extra columns are ignored.'],
      ['Item: the name used in the quote builder. Use the Bluebeam markup Subject (e.g. FRP-8\') so takeoffs match automatically, or map Bluebeam subjects to items on the Import tab.'],
      ['Code: optional SKU / part number. Description: printed on quotes. Scope: optional scope paragraph.'],
      ['Unit: SF, LF or EA. Material Cost: dollars per unit. Install Rate: units installed per crew-day (e.g. sf/day). 0 = material only.'],
      ['Leave Material Cost or Install Rate blank to type it on each quote instead.'],
      ['Blank cells do not erase values already in the app. Items that are not in this sheet are kept.'],
      [''],
      ['To update prices: edit this file in Excel, save it, then in the app open Settings → Material price list → Import price list.']
    ];
    return global.Xlsx.write([
      { name: 'Price List', header: true, rows: rows, widths: [16, 18, 50, 7, 22, 22, 70], numberCols: [4, 5], wrapCols: [6] },
      { name: 'How to use', rows: help, widths: [120] }
    ]);
  }

  global.PriceList = {
    FIELDS: FIELDS,
    normHeader: normHeader,
    mapHeader: mapHeader,
    normUnit: normUnit,
    parseRows: parseRows,
    parseSheets: parseSheets,
    plan: plan,
    apply: apply,
    planFromFile: planFromFile,
    templateBlob: templateBlob,
    TEMPLATE_HEADERS: TEMPLATE_HEADERS
  };
})(window);
