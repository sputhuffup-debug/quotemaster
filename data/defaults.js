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
  quantity: { source: "wasteSqFt", roundTo: 100, wastePct: 7 },
  company: { name: "", address: "", phone: "", email: "", license: "", logoDataUrl: "" },
  terms: { validDays: 30, notes: ["No Spec"], taxPct: 0 },
  proposal: { showSplit: false, lumpSum: false, showUnitQty: true },
  quote: { nextNumber: 1001, prefix: "Q-" }
};
