/* units.js — number, feet-inch and money helpers.  Exposes window.Units. */
(function (global) {
  'use strict';

  var EPS = 1e-9;

  /** "2,041" -> 2041, " 612 " -> 612, "" / null / "abc" -> null.  Never returns 0 for blank. */
  function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var s = String(value).trim().replace(/[,\s$]/g, '');
    if (s === '') return null;
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /**
   * Feet-inch string -> decimal feet.
   *   8'  -> 8      8'-6" -> 8.5     8' 6" -> 8.5     8'6" -> 8.5
   *   6"  -> 0.5    8.5   -> 8.5     8 ft 6 in -> 8.5  8' 6 1/2" -> 8.5417
   * Blank or unparseable -> null.
   */
  function parseFeet(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var s = String(value).trim()
      .replace(/[′’‘`]/g, "'")   // prime / curly quotes -> '
      .replace(/[″“”]|''/g, '"') // double prime / curly double -> "
      .replace(/\bfeet\b|\bfoot\b|\bft\b\.?/gi, "'")
      .replace(/\binches\b|\binch\b|\bin\b\.?/gi, '"')
      .replace(/,/g, '')
      .trim();
    if (s === '') return null;

    // plain number -> feet
    var plain = parseNumber(s);
    if (plain !== null) return plain;

    var m = s.match(/^([-+]?\d+(?:\.\d+)?)\s*'\s*-?\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"?)?$/);
    if (m) {
      var feet = parseFloat(m[1]);
      var inches = m[2] ? parseFloat(m[2]) : 0;
      if (m[3] && m[4] && +m[4] !== 0) inches += (+m[3]) / (+m[4]);
      return feet < 0 ? feet - inches / 12 : feet + inches / 12;
    }
    // inches only: 6"  or 6 1/2"
    m = s.match(/^(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"$/);
    if (m) {
      var inch = parseFloat(m[1]);
      if (m[2] && m[3] && +m[3] !== 0) inch += (+m[2]) / (+m[3]);
      return inch / 12;
    }
    return null;
  }

  /** 8.5 -> 8'-6"   8 -> 8' */
  function formatFeet(ft) {
    if (ft === null || ft === undefined || !isFinite(ft)) return '';
    var neg = ft < 0;
    ft = Math.abs(ft);
    var whole = Math.floor(ft + EPS);
    var inches = Math.round((ft - whole) * 12 * 4) / 4;
    if (inches >= 12) { whole += 1; inches = 0; }
    var out = whole + "'";
    if (inches > 0) out += '-' + (+inches.toFixed(2)) + '"';
    return (neg ? '-' : '') + out;
  }

  /** Round x up to the next multiple of `to` (to <= 0 / null -> no rounding). */
  function roundUp(x, to) {
    if (x === null || x === undefined) return null;
    if (!to || to <= 0) return x;
    return Math.ceil(x / to - EPS) * to;
  }

  /** Round x up to a multiple of `step` ("none" | "half" | "whole"). */
  function roundDays(days, mode) {
    if (mode === 'whole') return Math.ceil(days - EPS);
    if (mode === 'half') return Math.ceil(days * 2 - EPS) / 2;
    return days;
  }

  /** Round to cents, half away from zero, tolerant of 0.1+0.2 noise. */
  function roundMoney(x) {
    if (x === null || x === undefined || !isFinite(x)) return 0;
    var sign = x < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(x) * 100 + 1e-7) / 100;
  }

  function formatMoney(x) {
    var n = roundMoney(x || 0);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatNumber(x, decimals) {
    if (x === null || x === undefined || !isFinite(x)) return '';
    var d = decimals === undefined ? 0 : decimals;
    return x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  /** Date -> "mm-dd-yy" */
  function formatDateShort(d) {
    if (!(d instanceof Date)) d = parseISODate(d);
    if (!d) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getFullYear() % 100);
  }

  /** Date -> "yyyy-mm-dd" (local) */
  function toISODate(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function parseISODate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  global.Units = {
    parseNumber: parseNumber,
    parseFeet: parseFeet,
    formatFeet: formatFeet,
    roundUp: roundUp,
    roundDays: roundDays,
    roundMoney: roundMoney,
    formatMoney: formatMoney,
    formatNumber: formatNumber,
    formatDateShort: formatDateShort,
    toISODate: toISODate,
    parseISODate: parseISODate
  };
})(window);
