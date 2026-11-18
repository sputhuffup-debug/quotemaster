# Revu Quote Builder

A local, offline browser app that turns a **Bluebeam Revu Markups Summary CSV** into a priced
**FRP / wall-panel quote** for general contractors. It replaces the current hand-filled Excel
"Official Material Take-Off" sheet.

---

## 1. Hard constraints

| Constraint | What it means for the code |
|---|---|
| No compilers, build tools, Node, Python, or scripting engines on the user's machine | Plain HTML + CSS + vanilla JavaScript only. No bundler, no TypeScript, no npm at runtime. |
| Runs from a local folder (`file://`) | **No ES modules** (`import` / `type="module"`): Chrome blocks them on `file://`. Use classic `<script src>` tags. **No `fetch()` of local files**: also blocked. Load data with `<input type="file">` / drag-drop, or ship it as `.js` files that assign globals (`window.DEFAULT_CATALOG = {...}`). |
| Must work offline | All third-party libraries are vendored into `/lib`. No CDNs. |
| Target browsers | Current Chrome and Edge on Windows. |

To run it, double-click `index.html`. To run the tests, double-click `test/tests.html`.

### Quick start

1. **Settings** tab: enter your company name, address and logo. Check the catalog and labor rates. Click **Export settings** to keep a backup.
2. **Import** tab: drop the Bluebeam Markups Summary CSV. Check the subtotal check and the subject mapping.
3. **Pricing** tab: type the **material $/sf** and **install sf/day** for each line. They start blank, and red fields still need a value. Any other rate or quantity can be adjusted for this quote only; changed fields turn yellow.
4. **Quote** tab: fill in the GC, project, construction type and notes. Then use **Print proposal** or **Print internal**, and choose **Save as PDF**.
5. **Save quote** (or Ctrl+S) writes a `.json` file. **Open quote…** re-opens it with its original rates.

You can also drop a `.csv` (import) or `.json` (saved quote or settings export) anywhere on the window.

---

## 2. Repo layout

```
revu-quote-builder/
├── index.html              # app shell, loads scripts in order
├── css/
│   ├── app.css             # screen styles
│   └── print.css           # quote layout for Print → Save as PDF
├── js/
│   ├── parse.js            # CSV → normalized takeoff rows
│   ├── units.js            # feet-inch / number / unit parsing
│   ├── pricing.js          # takeoff → priced line items
│   ├── quote.js            # quote model, numbering, rendering
│   ├── storage.js          # localStorage + JSON import/export (window.RqbStorage)
│   ├── xlsx.js             # minimal .xlsx reader/writer (no library; uses the browser's DecompressionStream)
│   ├── pricelist.js        # Excel/CSV material price list -> catalog
│   └── app.js              # UI wiring
├── data/
│   └── defaults.js         # window.DEFAULTS = { catalog, rates, company, terms }
├── lib/
│   ├── papaparse.min.js    # vendored CSV parser v5.4.1 (MIT)
│   └── papaparse.LICENSE
├── test/
│   ├── tests.html          # open in browser; runs plain-JS assertions
│   └── fixtures/
│       ├── price-list.js     # an Excel-written price list (.xlsx, base64) for the reader tests
│       ├── mels-drive-in.csv
│       └── mels-drive-in.js  # same CSV as a JS string; tests.html can't fetch() files on file://
└── README.md
```

Load order in `index.html`: `lib/papaparse` → `data/defaults` → `units` → `parse` → `pricing` → `quote` → `storage` → `xlsx` → `pricelist` → `app`.
Each file adds one namespace to `window`: `Units`, `Parse`, `Pricing`, `Quote`, `RqbStorage`, `Xlsx`, `PriceList` and `App`.
Storage uses `RqbStorage` because `window.Storage` is a built-in browser class.

---

## 3. Input: Bluebeam Markups Summary CSV

### 3.1 Sample (fixture: `test/fixtures/mels-drive-in.csv`)

```csv
Subject,Room,Color,Space,Page Index,Measurement,Measurement Unit,SQ. FT,Mat. Height,Install Height,Waste Sq FT.
FRP-8' (2),,,,,252.2279,"ft' in""","2,041",,,"2,184"
FRP-8',,#FFFF00,,16,181.6871,"ft' in""","1,469",16,8',"1,572"
FRP-8',,#FFFF00,,16,70.5407,"ft' in""",572,8,8',612

```

### 3.2 Columns

| Column | Meaning | Parsing notes |
|---|---|---|
| `Subject` | Markup tool name; this is the **mapping key** to the catalog | Group rows look like `FRP-8' (2)` (see 3.3) |
| `Room`, `Space` | Location (often blank) | Optional grouping |
| `Color` | Markup color | Ignore, or use for display only |
| `Page Index` | Drawing page | **Blank = group subtotal row** |
| `Measurement` | Length, in **decimal feet** | Plain float |
| `Measurement Unit` | e.g. `ft' in"` | Contains embedded quotes; PapaParse handles these |
| `SQ. FT` | Bluebeam custom column (wall sq ft) | Has thousands separators: `"2,041"` |
| `Mat. Height` | Bluebeam custom column | Meaning still to confirm (see §9) |
| `Install Height` | Wall height, e.g. `8'` | Feet-inch string → number |
| `Waste Sq FT.` | SQ FT with waste applied (≈ ×1.07) | Thousands separators. **This is the quantity that gets priced.** |

### 3.3 Parsing rules

1. Parse with PapaParse: `{ header: true, skipEmptyLines: 'greedy' }`.
2. Trim header names. Match columns by normalized name (lowercase, strip punctuation), not by position, because column order can change between export profiles.
3. **Drop group subtotal rows**: `Page Index` is blank **and** `Subject` matches `/\(\d+\)$/`. Keep them only to cross-check that the detail rows sum to the subtotal; show a warning if they don't.
4. Numbers: strip `,` before `parseFloat`. Blank → `null`, never `0`.
5. Feet-inch strings (`8'`, `8'-6"`, `8' 6"`, `6"`, `8.5`) → decimal feet in `Units.parseFeet()`.
6. Strip the base subject (`FRP-8' (2)` → `FRP-8'`) for catalog lookup.
7. The UTF-8 BOM that Revu writes is stripped. Any title lines above the header row are skipped: the header is the first row that has a `Subject` column.

**Expected result for the fixture:** 2 detail rows. Total Waste Sq Ft = 1,572 + 612 = **2,184**, which matches the subtotal row.

---

## 4. Pricing model

This is reverse-engineered from the current Excel template (`Template` sheet, rows 8–15).

### 4.1 Per line item

| Field | Excel source | Formula |
|---|---|---|
| Total SQ (priced) | `L9` = 2200 (typed in by hand) | `roundUp(sum(Waste Sq Ft), roundTo)`, with `roundTo = 100` *(assumed; confirm)* |
| Height | `K9` = 8 | Install Height |
| Lineal Ft | `J9 = ROUNDUP(L9/K9, 0)` | `ceil(totalSq / height)` |
| **Material (M)** | `H9 = L9 * 2.85` | `totalSq × materialRatePerSf` |
| **Labor (L)** | `H10 = L9 / 320 * A11` | `(totalSq / sfPerDay) × dayRate` |
| Day rate | `A11 = 148*8 + 400` | `hourlyRate × hoursPerDay + dailyAdder`. This is the all-in labor cost per crew-day: `dailyAdder` covers per diem and vehicle use. In Excel it can sit in any cell; the app computes it from Settings. |
| **Line total** | `D15 = SUM(H9:I12)` | `M + L` |

Labor days are **not** rounded in the current sheet (6.875 days). Make rounding a setting: `none | half | whole`, default `none` to match the current numbers.

**Implementation notes**

- **Line grouping:** takeoff rows are grouped into one line per *catalog item × install height*. A different height gives a separate line, because Lineal Ft = SQ ÷ height needs a single height. The optional "Separate line per room" setting also splits lines by room.
- **Quantity source** (`quantity.source`):
  - `wasteSqFt` (default) uses the Waste Sq FT. column.
  - `sqFt` uses SQ. FT × (1 + `wastePct`).
  - `calc` uses Measurement × Install Height × (1 + waste).
  - If the chosen column is blank on a row, the next option is used and a note is shown.
- **Units:** `sf` items price square feet as described above. `lf` items use Measurement (ft), rounded up to whole feet. `ea` items count markups, or use Measurement when the unit is "Count".
- **Manual rate entry (`rateEntry: "manual"`, the default):** material $ per unit and install units per day are typed in on each line of each quote. This stays until material costs can come from a database.
  - Until both values are entered, the line is flagged and the total is understated.
  - The Pricing tab shows red fields and an "incomplete" badge, the Quote tab shows a warning, printing asks for confirmation, and the internal take-off prints an INCOMPLETE banner.
  - Entering `0` for units/day means material only, with no labor.
  - Set `rateEntry` to `"catalog"` (Settings → Labor & quantities, or per quote on the Pricing tab) to pre-fill both values from the catalog instead.
  - Quotes saved before this option existed open in catalog mode, so their totals don't change.
- **Per-quote overrides:** each quote stores a snapshot of the catalog, labor and quantity settings. Any line can override its quantity, height, $/unit or units/day. Blank means automatic.
- **Manual lines** can be added for items that aren't in the takeoff. They are priced at the quantity typed, with no rounding.
- **Sales tax:** an optional % on material (`terms.taxPct`, default 0). The tax line is only shown when it is non-zero.
- Money is rounded to the cent per line. Totals are the sum of the line totals.

### 4.2 Default rates (`data/defaults.js`)

```js
window.DEFAULTS = {
  catalog: [
    {
      subject: "FRP-8'",
      code: "FRP-C-S100-WHT",
      description: "FRP-CLASS C MARLITE S100 S2S WHITE SMOOTH PVC TRIM",
      scope: "FURNISH AND INSTALL STD CLASS C MARLITE S100 S2S SMOOTH WHITE FRP WITH PVC TRIM AT ALL EDGES AND SEAMS IN BOH",
      unit: "sf",            // "sf" | "lf" | "ea"
      materialRate: 2.85,    // $ per unit   (old name materialRatePerSf is still accepted)
      unitsPerDay: 320       // per crew-day (old name sfPerDay is still accepted); 0 = no labor
      // roundTo: 100        // optional per-item quantity rounding
    }
  ],
  subjectMap: {},            // remembered Bluebeam Subject -> catalog subject ("__ignore__" = leave off)
  labor: { hourlyRate: 148, hoursPerDay: 8, dailyAdder: 400, dayRounding: "none" },
  quantity: { source: "wasteSqFt", roundTo: 100, wastePct: 7 },
  rateEntry: "manual",       // "manual" = type material $ and sf/day per quote | "catalog" = pre-fill from catalog
  company: { name: "", address: "", phone: "", email: "", license: "", logoDataUrl: "" },
  terms: { validDays: 30, notes: ["No Spec"], taxPct: 0 },
  proposal: { showSplit: false, lumpSum: false, showUnitQty: true },
  quote: { nextNumber: 1001, prefix: "Q-" }
};
```

### 4.3 Golden test (must match the Excel sheet to the penny)

| | Value |
|---|---|
| Waste Sq Ft (sum) | 2,184 |
| Total SQ (rounded up to 100) | 2,200 |
| Lineal Ft | 275 |
| Material | 2,200 × 2.85 = **$6,270.00** |
| Day rate | 148 × 8 + 400 = $1,584.00 |
| Labor | 2,200 / 320 × 1,584 = **$10,890.00** |
| **Total** | **$17,160.00** |

---

### 4.4 Material price list (Excel)

Material costs are kept in an Excel workbook, expected to hold around 150 items, and imported into the catalog from **Settings → Material price list**. Dropping an `.xlsx` file on the window does the same thing.

- **Download as Excel** writes `Material Price List.xlsx` in the expected layout, filled with the current catalog. It has a "How to use" sheet. This is the easiest way to start the spreadsheet.
- **Import price list** reads `.xlsx` or `.csv`:
  - Columns are matched by header name, in any order. Title rows above the header and extra columns are ignored, and the first sheet with a recognisable header row is used.
  - Columns: **Item** (required, or **Code**), Code, Description, Unit (SF/LF/EA), **Material Cost** ($/unit), **Install Rate** (units/day), Scope, Round To. Common alternative names such as "Price", "Unit Cost", "SF/Day" and "SKU" are also recognised.
  - Rows match catalog items by Item name (case-insensitive), then by Code. A changed name never renames a catalog item, so Bluebeam mappings keep working.
  - **Blank cells never erase existing values.** Catalog items missing from the sheet are kept.
- A review screen lists new items, changed fields (old → new) and warnings (unknown unit, non-numeric cost, rows without an item). Nothing is applied until you confirm.
- To have new quotes use these prices, set *Material $ & install rate* to **Pre-fill from catalog**. The card offers a button for this after an import.
  - In that mode, an item with a blank cost or install rate in the price list still has to be typed in on the quote. This lets the sheet hold material costs while sf/day stays a per-job entry.
- Open quotes keep the rates they were created with. **Pricing → Reload rates from Settings** applies a new price list to the open quote. The internal take-off shows which price list file was used, and when it was imported.
- `.xls` (Excel 97–2003) files are not read; re-save them as `.xlsx`. The reader needs Chrome or Edge 103 or later, for `DecompressionStream('deflate-raw')`.

## 5. Quote document

Header and fields mirror the current sheet:

- **Header:** company logo + name, title ("OFFICIAL MATERIAL TAKE-OFF" internally / "PROPOSAL" for the GC), date (today, `mm-dd-yy`), quote number
- **To:** General contractor name
- **Project:** name (e.g. *Mel's Drive In*) + address (e.g. *2165 Lombard St, San Francisco CA, 94123*)
- **Line items** (up to ~15, same as the template's row blocks):
  Scope of work (e.g. `(3) ROOMS @ 8' AFF`) · Material description · Lineal Ft · Height · Total SQ · Price
- **Scope paragraph** (from the catalog `scope`, editable)
- **Construction type:** ☐ New Const. ☐ Remodel
- **Notes / exclusions** (e.g. "No Spec")
- **Grand total**

Two print views from the same data:
1. **Internal take-off**: shows the M/L split, rates, labor days, and the waste-quantity check.
2. **GC proposal**: shows only line descriptions, quantities, and price (or lump sum). Hides the rates.

Output = `print.css` + `window.print()` → user picks "Save as PDF". No PDF library needed.

---

## 6. Screens

1. **Import:** drag-drop a CSV, then show the parsed table with subtotal rows greyed out, warnings (unmapped subject, subtotal mismatch, blank quantity), and a mapping dropdown for any unmapped Subject (remembered in settings).
2. **Pricing:** one editable row per catalog item, with every rate overridable per quote and live totals.
3. **Quote:** GC / project / address / construction type / notes, then a preview with "Print Internal" and "Print Proposal" buttons.
4. **Settings:** catalog editor, labor rates, rounding, company info + logo upload (stored as a data URL), terms, next quote number.

---

## 7. Persistence

- Settings live in `localStorage` under the key `rqb.settings.v1`, seeded from `DEFAULTS` on first run.
- The quote in progress is autosaved to `rqb.draft.v1`, so it survives a closed tab. That autosave is not a backup; use **Save quote**.
- **Export / Import Settings** buttons save and load a `.json` file. That file is the real backup, because browser storage can be cleared.
- **Save Quote / Open Quote** handles a `.json` file holding the quote, its source CSV rows, and the rates used, so an old quote re-opens with its original numbers. Use `showSaveFilePicker` when available; otherwise fall back to a Blob download.
- A new quote shows the next number marked "(draft)". The number is taken, and `nextNumber` incremented, on the quote's **first** save; later saves keep it. Typing a number by hand fixes it.

---

## 8. Milestones

All six milestones are implemented. `test/tests.html` covers milestones 1 and 2, plus the overrides, LF/EA items, numbering, save/open round-trip and rendering.

1. **Parse:** `units.js` + `parse.js`; `tests.html` passes on the fixture (2 rows, 2,184 sf).
2. **Price:** `pricing.js`; the golden test in §4.3 passes.
3. **UI:** import → pricing → quote screens, using the default settings.
4. **Print:** internal + proposal print layouts.
5. **Settings + persistence:** catalog editor, JSON import/export, quote save/open.
6. **Polish:** multiple subjects / multiple catalog items per quote, room grouping, logo.

---

## 9. Open questions

- [ ] **Rounding:** is "Total SQ" always the Waste Sq Ft rounded **up to the nearest 100**?
- [ ] **`SQ. FT` vs length × height:** the Bluebeam values don't exactly equal Measurement × 8 (181.69 × 8 = 1,453.5, but the CSV says 1,469). What formula does the Revu custom column use? Should the app trust it or recompute it?
- [ ] **`Mat. Height`** (16 and 8 in the sample): is this panel sheet height, and does it affect pricing?
- [x] **Day rate:** $1,584/day is the all-in labor cost per crew-day: $148/hr × 8 hrs plus $400 for per diem and vehicle use. The UI labels the $400 "Per diem + vehicle".
- [x] **Material $ and sf/day:** entered by hand on each quote for now. Material costs will come from an Excel price list (~150 items); the import is built (§4.4). Next step: build the real price list and switch to "Pre-fill from catalog".
- [ ] **Labor production:** is 320 sf/day still the usual figure? Is the day rate the same on every job? (It can be changed per quote on the Pricing tab.)
- [ ] **GC proposal:** show the material/labor split, or a lump sum only? Is tax included or excluded?
- [ ] Other products besides FRP (other subjects, other units such as LF trim or EA corners)?
- [ ] Standard exclusions / terms text to include on every proposal.
