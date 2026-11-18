/* xlsx.js — minimal .xlsx reader/writer for the material price list.  Exposes window.Xlsx.
 *
 * Reading: unzips with the browser's DecompressionStream('deflate-raw') (Chrome/Edge 103+) and reads
 * cell values (shared strings, inline strings, numbers, booleans, cached formula results) from every sheet.
 * Formatting, dates and merged cells are ignored; a price list only needs values.
 *
 * Writing: builds an uncompressed .xlsx (bold header row, frozen header, column widths, 0.00 number format)
 * that Excel opens normally.  Used for the "Download template" button.
 */
(function (global) {
  'use strict';

  /* ================= zip ================= */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** Parse the zip central directory. Returns { name: {method, compSize, size, offset} } */
  function zipEntries(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not an .xlsx file (no zip directory found). If it is an old .xls file, re-save it as .xlsx.');
    var count = u16(bytes, eocd + 10);
    var p = u32(bytes, eocd + 16);
    var dec = new TextDecoder('utf-8');
    var out = {};
    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('Damaged .xlsx file (bad zip directory).');
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var size = u32(bytes, p + 24);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var local = u32(bytes, p + 42);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      out[name] = { method: method, compSize: compSize, size: size, offset: local };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function inflateRaw(data) {
    if (typeof global.DecompressionStream !== 'function') {
      return Promise.reject(new Error('This browser cannot read .xlsx files. Use current Chrome or Edge, or save the price list as .csv.'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function zipRead(bytes, entries, name) {
    var e = entries[name];
    if (!e) return Promise.resolve(null);
    var nameLen = u16(bytes, e.offset + 26);
    var extraLen = u16(bytes, e.offset + 28);
    var start = e.offset + 30 + nameLen + extraLen;
    var data = bytes.subarray(start, start + e.compSize);
    var p = e.method === 0 ? Promise.resolve(data)
      : e.method === 8 ? inflateRaw(data)
        : Promise.reject(new Error('Unsupported compression in .xlsx file.'));
    return p.then(function (u8) { return new TextDecoder('utf-8').decode(u8); });
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** files: [{ name, text }] -> Uint8Array (stored, no compression) */
  function zipWrite(files) {
    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var d = new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    function header(size) { return { buf: new Uint8Array(size), view: null }; }

    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var data = enc.encode(f.text);
      var crc = crc32(data);
      var h = header(30);
      var v = new DataView(h.buf.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0800, true);      // UTF-8 names
      v.setUint16(8, 0, true);           // stored
      v.setUint16(10, dosTime, true);
      v.setUint16(12, dosDate, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, 0, true);
      parts.push(h.buf, name, data);

      var c = new Uint8Array(46);
      var cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.push(c, name);
      offset += 30 + name.length + data.length;
    });

    var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var all = parts.concat(central, [end]);
    var total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ================= reading ================= */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Damaged .xlsx file (unreadable XML).');
    return doc;
  }
  function byName(el, local) { return Array.prototype.slice.call(el.getElementsByTagNameNS('*', local)); }
  function attrLocal(el, local) {
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if ((a.localName || a.name) === local) return a.value;
    }
    return null;
  }

  /** "AB12" -> 27 (0-based column index) */
  function colIndex(ref) {
    var m = /^([A-Z]+)/i.exec(ref || '');
    if (!m) return -1;
    var s = m[1].toUpperCase(), n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }
  function colName(i) {
    var s = '';
    i += 1;
    while (i > 0) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  /** Text of a shared-string / inline-string item, ignoring phonetic runs. */
  function richText(el) {
    var out = '';
    byName(el, 't').forEach(function (t) {
      var p = t.parentNode;
      if (p && (p.localName === 'rPh')) return;
      out += t.textContent;
    });
    return out;
  }

  function resolveTarget(target) {
    if (!target) return null;
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = ('xl/' + target).split('/');
    var out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }

  /**
   * Read an .xlsx file.
   * @param {ArrayBuffer|Uint8Array} data
   * @returns Promise<{ sheets: [{ name, rows: [[value, ...], ...] }] }>   values are string | number | boolean | ''
   */
  function read(data) {
    var bytes;
    try {
      bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (e) { return Promise.reject(e); }
    var entries;
    try { entries = zipEntries(bytes); } catch (e) { return Promise.reject(e); }
    if (!entries['xl/workbook.xml']) return Promise.reject(new Error('This zip file is not an Excel workbook.'));

    return Promise.all([
      zipRead(bytes, entries, 'xl/workbook.xml'),
      zipRead(bytes, entries, 'xl/_rels/workbook.xml.rels'),
      zipRead(bytes, entries, 'xl/sharedStrings.xml')
    ]).then(function (res) {
      var wb = parseXml(res[0]);
      var rels = {};
      if (res[1]) {
        byName(parseXml(res[1]), 'Relationship').forEach(function (r) { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
      }
      var shared = res[2] ? byName(parseXml(res[2]), 'si').map(richText) : [];
      var sheetDefs = byName(wb, 'sheet').map(function (s, i) {
        var rid = attrLocal(s, 'id');
        var path = resolveTarget(rels[rid]) || ('xl/worksheets/sheet' + (i + 1) + '.xml');
        return { name: s.getAttribute('name') || ('Sheet' + (i + 1)), path: path };
      });
      return Promise.all(sheetDefs.map(function (sd) {
        return zipRead(bytes, entries, sd.path).then(function (xml) {
          return { name: sd.name, rows: xml ? sheetRows(parseXml(xml), shared) : [] };
        });
      }));
    }).then(function (sheets) { return { sheets: sheets }; });
  }

  function sheetRows(doc, shared) {
    var rows = [];
    byName(doc, 'row').forEach(function (rowEl, ri) {
      var rAttr = parseInt(rowEl.getAttribute('r'), 10);
      var rIdx = isFinite(rAttr) ? rAttr - 1 : (rows.length ? rows.length : ri);
      var row = [];
      var next = 0;
      byName(rowEl, 'c').forEach(function (c) {
        if (c.parentNode !== rowEl) return;
        var ci = colIndex(c.getAttribute('r'));
        if (ci < 0) ci = next;
        next = ci + 1;
        var t = c.getAttribute('t') || 'n';
        var vEl = byName(c, 'v')[0];
        var v = vEl ? vEl.textContent : '';
        var val;
        if (t === 's') val = shared[parseInt(v, 10)] || '';
        else if (t === 'inlineStr') { var is = byName(c, 'is')[0]; val = is ? richText(is) : ''; }
        else if (t === 'str') val = v;
        else if (t === 'b') val = v === '1';
        else if (t === 'e') val = '';
        else val = v === '' ? '' : (isFinite(+v) ? +v : v);
        while (row.length < ci) row.push('');
        row[ci] = val;
      });
      while (rows.length < rIdx) rows.push([]);
      rows[rIdx] = row;
    });
    return rows;
  }

  /* ================= writing ================= */

  function xmlEsc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  /*
   * sheets: [{ name, rows: [[...]], widths: [chars...], header: true, numberCols: [colIndex...] }]
   * Style ids: 0 normal, 1 bold header, 2 number 0.00, 3 wrapped text
   */
  function sheetXml(sh) {
    var cols = (sh.widths || []).map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('');
    var numCols = {};
    (sh.numberCols || []).forEach(function (i) { numCols[i] = true; });
    var wrapCols = {};
    (sh.wrapCols || []).forEach(function (i) { wrapCols[i] = true; });
    var rows = sh.rows.map(function (r, ri) {
      var cells = r.map(function (v, ci) {
        if (v === null || v === undefined || v === '') return '';
        var ref = colName(ci) + (ri + 1);
        var style = sh.header && ri === 0 ? 1 : (numCols[ci] ? 2 : (wrapCols[ci] ? 3 : 0));
        var s = style ? ' s="' + style + '"' : '';
        if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>';
        if (typeof v === 'boolean') return '<c r="' + ref + '"' + s + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
        return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (ri + 1) + '">' + cells + '</row>';
    }).join('');
    return XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
      (sh.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (cols ? '<cols>' + cols + '</cols>' : '') +
      '<sheetData>' + rows + '</sheetData></worksheet>';
  }

  /** Build an .xlsx file. Returns a Blob. */
  function write(sheets) {
    var files = [];
    files.push({ name: '[Content_Types].xml', text: XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>' });
    files.push({ name: '_rels/.rels', text: XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>' });
    files.push({ name: 'xl/workbook.xml', text: XML_HEAD +
      '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '"><sheets>' +
      sheets.map(function (s, i) {
        return '<sheet name="' + xmlEsc(String(s.name).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', text: XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>' });
    files.push({ name: 'xl/styles.xml', text: XML_HEAD +
      '<styleSheet xmlns="' + NS_MAIN + '">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>' });
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(s) }); });
    return new Blob([zipWrite(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  global.Xlsx = { read: read, write: write, colIndex: colIndex, colName: colName, crc32: crc32 };
})(window);
