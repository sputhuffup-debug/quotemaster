/* defaults.js — seed settings used on first run and by "Reset to defaults".
 *
 * Catalog fields:
 *   subject       Bluebeam markup Subject this item prices (mapping key, case-insensitive)
 *   unit          "sf" | "lf" | "ea"
 *   materialRate  material $ per unit            (was materialRatePerSf in the first spec; still accepted)
 *   unitsPerDay   install production per crew-day (was sfPerDay; still accepted). 0 = no labor.
 *   roundTo       optional: round the priced quantity up to this multiple (default: quantity.roundTo for sf, 1 otherwise)
 */
window.DEFAULTS = {
  version: 3,   // settings format; see RqbStorage.normalizeSettings for upgrades
  catalog: [
    {
      subject: "FRP-8'",
      code: "FRP-C-S100-WHT",
      description: "FRP-CLASS C MARLITE S100 S2S WHITE SMOOTH PVC TRIM",
      scope: "FURNISH AND INSTALL STD CLASS C MARLITE S100 S2S SMOOTH WHITE FRP WITH PVC TRIM AT ALL EDGES AND SEAMS IN BOH",
      unit: "sf",
      materialRate: 2.85,
      unitsPerDay: 320
    }
  ],
  // Remembered Bluebeam Subject -> catalog subject mappings ("__ignore__" = leave off the quote).
  subjectMap: {},
  // Labor cost per crew-day = hourlyRate × hoursPerDay + dailyAdder (per diem + vehicle use) = $1,584.00
  labor: { hourlyRate: 148, hoursPerDay: 8, dailyAdder: 400, dayRounding: "none" },
  // source: "wasteSqFt" (Bluebeam Waste Sq FT. column) | "sqFt" (SQ. FT + wastePct) | "calc" (Measurement x Install Height + wastePct)
  // roundTo 0 = Total SQ is exactly the Waste Sq FT. sum; change it per line on the Pricing tab.
  quantity: { source: "wasteSqFt", roundTo: 0, wastePct: 7 },
  // "manual": type material $ and sf/day on each quote (lines start blank).  "catalog": pre-fill from the catalog above.
  rateEntry: "manual",
  // Last imported material price list (Settings -> Material price list): { fileName, sheetName, importedAt, itemCount }
  priceList: null,
  // logoDataUrl: an uploaded image (data: URL) or a path relative to index.html.
  // logoLayout: "banner" = the logo is a full letterhead (name, address, licenses) and replaces the text block;
  //             "beside" = a small logo next to the company details below.
  company: {
    name: "Universal Plastics, Inc.",
    address: "1020 Winding Creek Road #130, Roseville, CA 95678",
    phone: "",
    email: "",
    license: "CA Lic# 390876 • NV Lic# 0006651A",
    logoDataUrl: "img/universal-plastics-logo.png",
    logoLayout: "banner"
  },
  terms: { validDays: 30, notes: ["No Spec"], taxPct: 0 },
  proposal: { showSplit: false, lumpSum: false, showUnitQty: true },
  quote: { nextNumber: 1001, prefix: "Q-" }
};
