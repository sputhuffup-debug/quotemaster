/* parse.js — Bluebeam Revu "Markups Summary" CSV -> normalized takeoff rows.  Exposes window.Parse. */
(function (global) {
  'use strict';

  var U = global.Units;

  /** lowercase, strip BOM / punctuation / whitespace: "Waste Sq FT." -> "wastesqft" */
  function normalizeHeader(h) {
    return String(h === null || h === undefined ? '' : h)
      .replace(/^﻿/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /* Field -> accepted normalized header names (first match wins). */
  var COLUMNS = {
    subject:         ['subject'],
    label:           ['label'],
    room:            ['room'],
    space:           ['space'],
    layer:           ['layer'],
    color:           ['color', 'colour'],
    comments:        ['comments', 'comment'],
    pageIndex:       ['pageindex'],
    pageLabel:       ['pagelabel', 'page'],
    measurement:     ['measurement', 'length'],
    measurementUnit: ['measurementunit', 'unit', 'units'],
    sqFt:            ['sqft', 'sqfeet', 'area'],
    matHeight:       ['matheight', 'materialheight'],
    installHeight:   ['installheight', 'wallheight', 'height'],
    wasteSqFt:       ['wastesqft', 'wastesf', 'sqftwithwaste', 'wastesqfeet']
  };

  var GROUP_RE = /\s*\((\d+)\)\s*$/;

  /**
   * Unit a takeoff row is measured in, from the CSV itself:
   *   Measurement Unit "Count"  -> "ea"  (Bluebeam Count tool: Measurement is the number counted)
   *   Install Height "LF"       -> "lf"  (lineal footage: Measurement is the length in feet)
   *   otherwise                 -> null  (use the catalog item's unit, normally square feet)
   */
  function rowUnit(row) {
    if (/\bcount\b/i.test(row.measurementUnit || '')) return 'ea';
    if (/\bLF\b|\blin(eal|ear)?\.?\s*f(oo)?t\b/i.test(row.installHeightText || '')) return 'lf';
    return null;
  }

  /** "FRP-8' (2)" -> "FRP-8'" */
  function baseSubject(subject) {
    return String(subject || '').replace(GROUP_RE, '').trim();
  }

  /** Map normalized header row -> { field: columnIndex } */
  function mapColumns(headerRow) {
    var norm = headerRow.map(normalizeHeader);
    var map = {};
    Object.keys(COLUMNS).forEach(function (field) {
      var names = COLUMNS[field];
      for (var i = 0; i < names.length; i++) {
        var idx = norm.indexOf(names[i]);
        if (idx !== -1 && !isTaken(map, idx)) { map[field] = idx; return; }
      }
    });
    return map;
  }
  function isTaken(map, idx) {
    for (var k in map) if (map[k] === idx) return true;
    return false;
  }

  function cell(row, idx) {
    if (idx === undefined || idx === null) return '';
    var v = row[idx];
    return v === undefined || v === null ? '' : String(v).trim();
  }

  /** Parse raw CSV text. */
  function parseCsvText(text, opts) {
    if (!global.Papa) throw new Error('PapaParse (lib/papaparse.min.js) is not loaded.');
    var res = global.Papa.parse(String(text || '').replace(/^﻿/, ''), { header: false, skipEmptyLines: 'greedy' });
    var out = parseTable(res.data, opts);
    (res.errors || []).forEach(function (e) {
      if (e.type === 'Delimiter') return; // single-column files etc.
      out.warnings.push({ level: 'warn', code: 'csv', message: 'CSV row ' + ((e.row || 0) + 1) + ': ' + e.message });
    });
    return out;
  }

  /**
   * Parse an array-of-arrays table (first row containing a "Subject" header is the header row).
   * Returns { columns, headers, rows, subtotals, warnings }.
   *   rows      — detail rows (what gets priced)
   *   subtotals — Bluebeam group rows ("FRP-8' (2)" with blank Page Index), kept for cross-checking
   */
  function parseTable(table, opts) {
    opts = opts || {};
    var warnings = [];
    var headerIdx = -1;
    for (var i = 0; i < Math.min(table.length, 20); i++) {
      if ((table[i] || []).map(normalizeHeader).indexOf('subject') !== -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      return {
        columns: {}, headers: [], rows: [], subtotals: [],
        warnings: [{ level: 'error', code: 'noheader', message: 'No "Subject" column found. Is this a Bluebeam Markups Summary CSV?' }]
      };
    }
    var headers = table[headerIdx].map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
    var columns = mapColumns(headers);

    if (columns.wasteSqFt === undefined && columns.sqFt === undefined) {
      warnings.push({ level: 'warn', code: 'nocolumn', message: 'No "Waste Sq FT." or "SQ. FT" column found. Square-foot items will be computed from Measurement × Install Height.' });
    } else if (columns.wasteSqFt === undefined) {
      warnings.push({ level: 'warn', code: 'nocolumn', message: 'No "Waste Sq FT." column found. Quantities will use "SQ. FT" plus the waste % from settings.' });
    }

    var rows = [];
    var subtotals = [];
    var rowNo = 0;

    for (var r = headerIdx + 1; r < table.length; r++) {
      var raw = table[r];
      if (!raw || raw.every(function (c) { return String(c || '').trim() === ''; })) continue;
      rowNo++;
      var subject = cell(raw, columns.subject);
      var pageIndex = cell(raw, columns.pageIndex);
      var pageLabel = cell(raw, columns.pageLabel);
      var page = pageIndex !== '' ? pageIndex : pageLabel;
      var rec = {
        id: 'r' + rowNo,
        line: r + 1,
        subject: subject,
        baseSubject: baseSubject(subject),
        label: cell(raw, columns.label),
        room: cell(raw, columns.room),
        space: cell(raw, columns.space),
        layer: cell(raw, columns.layer),
        color: cell(raw, columns.color),
        comments: cell(raw, columns.comments),
        page: page,
        measurement: U.parseNumber(cell(raw, columns.measurement)),
        measurementUnit: cell(raw, columns.measurementUnit),
        sqFt: U.parseNumber(cell(raw, columns.sqFt)),
        matHeight: U.parseFeet(cell(raw, columns.matHeight)),
        installHeight: U.parseFeet(cell(raw, columns.installHeight)),
        installHeightText: cell(raw, columns.installHeight),
        wasteSqFt: U.parseNumber(cell(raw, columns.wasteSqFt))
      };
      // "12 ea" / "12 Count" in the Measurement cell itself
      if (rec.measurement === null) {
        var mNum = /^\s*([\d,]*\.?\d+)/.exec(cell(raw, columns.measurement));
        if (mNum) rec.measurement = U.parseNumber(mNum[1]);
      }
      rec.rowUnit = rowUnit(rec);

      var groupMatch = GROUP_RE.exec(subject);
      var hasPageColumn = columns.pageIndex !== undefined || columns.pageLabel !== undefined;
      if (groupMatch && (!hasPageColumn || page === '')) {
        rec.count = parseInt(groupMatch[1], 10);
        rec.isSubtotal = true;
        subtotals.push(rec);
        continue;
      }
      if (subject === '') {
        warnings.push({ level: 'warn', code: 'nosubject', rowId: rec.id, message: 'CSV line ' + rec.line + ' has no Subject and was skipped.' });
        continue;
      }
      rows.push(rec);
    }

    crossCheck(rows, subtotals, warnings);

    if (rows.length === 0) {
      warnings.push({ level: 'error', code: 'norows', message: 'No markup rows found in this file.' });
    }
    return { columns: columns, headers: headers, rows: rows, subtotals: subtotals, warnings: warnings };
  }

  /* Detail rows must add up to the Bluebeam group subtotal rows. */
  function crossCheck(rows, subtotals, warnings) {
    subtotals.forEach(function (st) {
      var members = rows.filter(function (r) { return r.baseSubject === st.baseSubject; });
      st.detailCount = members.length;
      if (members.length !== st.count) {
        warnings.push({
          level: 'warn', code: 'subtotal', subject: st.baseSubject,
          message: 'Group "' + st.subject + '" says ' + st.count + ' markups but ' + members.length + ' detail rows were found.'
        });
      }
      ['wasteSqFt', 'sqFt', 'measurement'].forEach(function (f) {
        if (st[f] === null) return;
        var sum = 0, any = false;
        members.forEach(function (m) { if (m[f] !== null) { sum += m[f]; any = true; } });
        if (!any) return;
        st['detail_' + f] = sum;
        // Bluebeam rounds each displayed value, so allow half a unit per row (+ a little float slack).
        var tol = f === 'measurement' ? 0.001 * Math.max(1, members.length) + 1e-6 : 0.5 * Math.max(1, members.length) + 1e-6;
        if (Math.abs(sum - st[f]) > tol) {
          warnings.push({
            level: 'warn', code: 'subtotal', subject: st.baseSubject,
            message: 'Group "' + st.subject + '" ' + FIELD_LABELS[f] + ' subtotal is ' + U.formatNumber(st[f], 2) +
              ' but the detail rows add up to ' + U.formatNumber(sum, 2) + '.'
          });
        }
      });
    });
  }

  var FIELD_LABELS = { wasteSqFt: 'Waste Sq Ft', sqFt: 'SQ. FT', measurement: 'Measurement' };

  global.Parse = {
    normalizeHeader: normalizeHeader,
    baseSubject: baseSubject,
    rowUnit: rowUnit,
    mapColumns: mapColumns,
    parseCsvText: parseCsvText,
    parseTable: parseTable,
    COLUMNS: COLUMNS
  };
})(window);
