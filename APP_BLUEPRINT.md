# APP_BLUEPRINT.md — Appraisal Workbench

Self-hosted web application for commercial real estate appraisal and relational data tracking (Riverside County). C# / .NET 10 backend, vanilla JS + custom CSS frontend, SQLite persistence.

This is the single architecture reference for the app. `README.md` covers setup, features, and goals; this file covers how the system works and the contracts that must stay in sync. Any change to a contract listed here must update this file in the same change.

---

## 1. Architecture

| Layer | Technology | Location |
|---|---|---|
| Web host | ASP.NET Core minimal API, Kestrel, `http://127.0.0.1:5000` (loopback-only) | `Program.cs` |
| Persistence | SQLite (Microsoft.Data.Sqlite), JSON-document rows | `data/appraisal.db` |
| Domain models | Typed C# POCOs with explicit `[JsonPropertyName]` | `Models/*.cs` |
| Frontend | Vanilla ES-module JS (no framework, no build step) | `wwwroot/js/{core,form,report,main,mapimg}.js` |
| Styling | Single hand-maintained stylesheet, token-driven | `wwwroot/css/app.css` |
| Parcel source data | County JSON index (`input/master_parcel_list.json`, APN → record + geometry) | re-read on mtime change |
| Parcel data pipeline | `storage/build_master_json.py` (base/geo/assemble) — county CSVs + GIS geometry | weekly, offline |
| Interactive map | Leaflet (vendored) + Esri World Imagery tiles, client-side compositing | `wwwroot/js/mapimg.js` |
| Uploaded photos | Server-side files per APN | `storage/parcel_photos/{apn}/` |

### 1.1 Process model

- One process serves both the API and the static frontend (`UseStaticFiles` + `MapFallbackToFile("index.html")`).
- Static assets are served with `Cache-Control: no-store` — this is a local dev tool and heuristic caching has previously masked fixes. **Do not add caching headers.**
- The app binds to loopback only. There is no authentication; the trust boundary is the machine.

### 1.2 Data flow (write path)

```
form input → state.data (JS) → scheduleAutosave() → IndexedDB (local crash recovery ONLY)
           → "Save as WIP" / "Finalize" → POST/PUT /api/appraisals[/finalize]
           → AppraisalData.Normalize() → SQLite `data` blob + denormalized summary columns
```

**Critical invariant:** editing a form never writes to the server. The server row is created only by an explicit save. IndexedDB is refresh/crash recovery, not a copy.

---

## 2. Directory structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 web project (excludes `storage/`, `output/` from build) |
| `Program.cs` | Backend entry point: minimal API routes + SQLite document store + parcel index |
| `Rule2.cs` | Rule 2 (Full Cash Value) transfer-screening batch + its API routes (`RivCo.Rule2`) |
| `Models/` | Typed C# data structures (Property, Appraisal, Comp, Tenant) — `RivCo.Models` |
| `start.bat` | Launcher (`dotnet run` + open browser) |
| `wwwroot/index.html` | SPA shell (boot-error boundary + module entry) |
| `wwwroot/css/app.css` | Single custom stylesheet — design system via CSS custom properties |
| `wwwroot/js/core.js` | Calculations, data model (`createEmptyParcel`), API client, state, multi-parcel workspace |
| `wwwroot/js/main.js` | Top bar, list view, multi-parcel tabs, split-pane workspace, PIN page, work queues |
| `wwwroot/js/form.js` | 6-tab appraisal form (Cover, Subject, Sales, Income, Reconcile, Cost) + comp repository |
| `wwwroot/js/report.js` | Print-ready report sheets + browser-print export |
| `wwwroot/js/mapimg.js` | Interactive Leaflet parcel map (PIN page) + static report map; client-side satellite compositing |
| `wwwroot/lib/leaflet/` | Vendored Leaflet |
| `wwwroot/img/` | County seal assets |
| `test/core.test.js` | Unit tests for `core.js` (`node --test`) |
| `data/appraisal.db` | SQLite database (created at first run; not in repo) |
| `input/` | County source files: `master_parcel_list.json` (parcel index), `prior_year_transfer_list.csv`, `transfers_to_be_worked_list.csv`, optional `appeals_to_be_done*` |
| `output/` | Derived transfer files for the Rule 2 batch (e.g. `commercial_transfers.csv`) |
| `storage/` | Data-prep pipeline archive (scripts, caches, parcel maps, photos) — excluded from build |
| `storage/build_master_json.py` | Weekly pipeline: county CSVs + GIS geometry → `input/master_parcel_list.json` |
| `storage/build_input_files.py` | Builds the three canonical input CSVs (master list, prior-year transfers, transfers to be worked) |
| `storage/build/` | Pipeline artifacts (`geometry.json` cache, `build_log.txt`) |

---

## 3. Data model & round-trip contract

### 3.1 Serialization contract

All JSON crossing the C# ↔ JS boundary is governed by `AppraisalJson.Options` (`Models/AppraisalJson.cs`): camelCase naming, case-insensitive read, compact output, nulls omitted.

**Losslessness rules (normative):**

1. Every C# property carries an explicit `[JsonPropertyName]` matching the JS field name exactly. The camelCase policy is a fallback, never the source of truth.
2. C# reference-type defaults (`""`, `0`, `false`, `new List<T>()`) mirror the JS `createEmptyParcel` defaults field-for-field. A document serialized by C# and re-parsed by JS (and vice versa) must be deep-equal after `normalizeParcel` / `AppraisalData.Normalize`.
3. Dates are **ISO-8601 calendar strings** (`yyyy-MM-dd`), never epoch numbers or `DateTime` objects.
4. Unknown JSON properties are tolerated on read and must not be destroyed by a read-modify-write cycle of the *raw* node. The finalize content-hash therefore hashes the **raw request node**, not the normalized model — rows archived before model refactors keep deduplicating.
5. `PhotoRef.File` is the only nullable string in the model; it is omitted from JSON when null.

### 3.2 Root document — `AppraisalData`

One appraisal = one row in `appraisals` = one JSON document with exactly these eight top-level sections:

| JSON key | C# type | Notes |
|---|---|---|
| `property` | `PropertyInfo` | Subject ID + case metadata (APN, address, dates, appraiser, case type, photos) |
| `land` | `LandInfo` | Site characteristics + land value |
| `improvements` | `ImprovementsInfo` | `primary` + `outbuildings[]` |
| `cost` | `CostApproach` | Depreciation schedule |
| `income` | `IncomeApproach` | Rent/losses/cap rate |
| `sales` | `SalesApproach` | Method + `comparables[]` |
| `reconciliation` | `Reconciliation` | Weights + final value |
| `cover` | `CoverInfo` | Case-type-specific cover fields (transfer / appeal / stipulation) + `valueCategories` |

`AppraisalData.CreateEmpty(apn)` (C#) and `createEmptyParcel(apn)` (JS, `core.js`) are the single source of truth for defaults and must stay in lockstep. When a default changes, change both in the same commit and re-run the round-trip check (§8.3).

### 3.3 Comparable sale (`ComparableSale`)

Per-comp fields: parcel (APN), address, city, sale date, price, age, quality, condition, land/building area, clear height, zoning, property type, 12 adjustment values (`adjBuildingSize` … `adjConditionOfSale`), `selected`, `isArmsLength`, `photos: PhotoRef[]`.

Derived (never serialized): `TotalAdjustments` = sum of the 12 `adj*` fields; `IndicatedValue` = `price + TotalAdjustments`. JS computes the same via `computeSalesGridComp()`.

### 3.4 Comp repository record (`CompRecord`)

A permanent sale comp — the snapshot of a finalized appraisal's subject (or a Rule 2 transfer row). Three sources, never cross-written:

| Store | Written by | Mutability |
|-------|-----------|------------|
| `permanent_comps` | `/api/finalize` (finalized appraisals) | immutable |
| `transfer_comps` | Rule 2 batch only | read-only (no delete endpoint) |
| local CSV comps | browser localStorage | machine-local |

### 3.5 Photo references (`PhotoRef`)

`{ source: "gis" | "upload" | "none", file?: string }`. Photos are references, never base64 blobs. Resolution (JS `resolvePhotoUrl`): `gis` → `gis:{apn}` marker, composited in the browser by `mapimg.js` (parcel geometry + Esri imagery); `upload` → `/api/parcel-photos/{apn}/{file}`; `none`/absent → no image.

### 3.6 Tenant config (`TenantConfig`)

County branding: `county`, `countyName`, `officeName`, `sealUrl` — single row `id = 'config'` in the `tenant` table.

### 3.7 Normalization semantics

`AppraisalData.Normalize(doc)` (C#) and `normalizeParcel(parcel)` (JS) are equivalent and run on **every read** (GET `/api/appraisals/{id}`, workspace restore, WIP import):

1. Missing top-level section → replaced by the `CreateEmpty` default for that section.
2. `improvements` and `sales` merge field-by-field (their sub-objects/arrays are individually defaulted).
3. `cover.valueCategories` merges row-by-row by index; extra provided rows beyond the 6 defaults are appended.
4. Normalization is idempotent: `Normalize(Normalize(x)) == Normalize(x)`.

---

## 4. API surface

All routes are registered in `Program.cs` except the Rule 2 / transfer-comp / work-queue routes, which are registered by `Rule2.Map()` (`Rule2.cs`).

| Route | Purpose |
|---|---|
| `GET /api/appraisals` | List appraisals (denormalized summary columns) |
| `GET /api/appraisals/{id}` | Fetch one (normalized) |
| `POST /api/appraisals` | Create a WIP appraisal |
| `PUT /api/appraisals/{id}` | Update a WIP appraisal |
| `DELETE /api/appraisals/{id}` | Delete a WIP appraisal |
| `POST /api/finalize` | Finalize → immutable snapshot + permanent comp (SHA-256 dedup on the raw node) |
| `GET /api/permanent-comps` | Permanent comp repository |
| `GET /api/transfer-comps` | Rule 2 transfer comps (read-only store) |
| `GET /api/transfer-comps/search?q=` | Search transfer comps (backs the top-bar APN search) |
| `GET /api/tenant` · `PUT /api/tenant` | County branding config |
| `GET /api/parcel-data/{apn}` | Parcel record + geometry from the county index |
| `GET /api/parcel-search?q=` | APN/address search (appraisals + parcel index) |
| `GET /api/parcel-photos/{apn}` · `POST` | List / upload photos per APN |
| `GET /api/parcel-photos/{apn}/{name}` · `DELETE` | Fetch / delete one photo |
| `GET /api/rule2/status` | Rule 2 input files in `output/` + last run + comp count |
| `POST /api/rule2/run` | Run the Rule 2 screen against the latest `output/` transfer file |
| `GET /api/rule2/summary` | Latest run summary + bucket counts |
| `GET /api/rule2/buckets/{bucket}` | Bucket rows (with completion status) |
| `GET /api/rule2/bucket-rows/{bucket}` | Bucket rows (CSV export) |
| `GET /api/workqueue/{type}` | Work-queue rows: `transfers` → `transfers_to_be_worked*`, `appeals` → `appeals_to_be_done*` (latest `.xlsx`/`.csv` by mtime; empty result if no file) |

SQLite tables: `appraisals`, `permanent_comps`, `transfer_comps`, `rule2_runs`, `tenant`.

---

## 5. Rule 2 batch (`Rule2.cs`)

California Property Tax Rule 2 ("Full Cash Value") screening of commercial transfers.

- **Input:** the enriched commercial transfer CSV in `output/` (latest `.csv`/`.xlsx` by mtime), produced by the dev pipeline (`extractCommercial.cjs` + `fetchParcelSizes.cjs`). Commercial classes only (`Commercial` / `CommercialDE`).
- **Location tiers** (APN book-page-parcel; the book encodes location): 0 = same book, 1 = adjacent, 2 = 2–5 books away, 3 = distant/unparseable. Tier weights: 4 / 2 / 1 / 0.25.
- **Buckets:**
  - improved, ≥1 Tier 0/1 peer within 5% → `auto_enrolled`
  - improved, Tier 2 peer within 5% or closest Tier 0/1 peer within 15% → `borderline`
  - improved, otherwise → `below_market` / `above_market` (vs similarity-weighted peer average)
  - land, ≥2 Tier 0/1 peers within 2% → `auto_enrolled`; otherwise → `land_review`
  - no-value transfers (Consid = 0) → `no_value` (classified by `LocalRatioCd`)
- **Persistence:** the full raw commercial extract is written to `transfer_comps` (SHA-256 dedup guards intra-run dupes; the store always mirrors the latest input); each run is recorded in `rule2_runs`.
- **UI:** per-bucket "to complete" work queues; a row opens a pre-filled appraisal. `auto_enrolled` rows (and docs already completed in-app) show as completed.

---

## 6. Work queues

`GET /api/workqueue/{type}` reads a "to be worked" file from `input/` and returns its rows as JSON:

- `transfers` → latest `transfers_to_be_worked*.xlsx/.csv`
- `appeals` → latest `appeals_to_be_done*.xlsx/.csv`

Columns whose name contains "Date" are normalized to ISO (Excel serials and `M/d/yy`); the `RivCoViewJSON` column (raw county API blob) is excluded — parcel detail is served by `/api/parcel-data/{apn}` instead. The frontend renders a filterable, sortable table (column menu, dropdown filters); clicking a row opens a new appraisal pre-filled from that row. No file → empty state, no code change needed to add one.

---

## 7. UI architecture

- **Top bar** (`#topbar`): county seal, office name, date fields, APN search, case-type selector, headline value + actions.
- **Landing / list view**: appraisal table (APN, address, city, report date, final value) + work-queue cards (Transfer / Appeal).
- **Split-pane workspace**: multi-parcel tabs (left) · 6-tab appraisal form (center) · live report preview (right, drag-resizable).
- **6-tab form**: Cover → Subject → Sales Comparison (grid + comp form + repository) → Income → Reconciliation → Cost. The Cost tab is hidden until "Include Cost Approach" is checked.
- **PIN page**: per-parcel characteristics, interactive Leaflet satellite map with the parcel outline, transfer/tax history, past in-app valuations.
- **Report preview**: print-ready 8.5×11" sheets (cover → subject → sales → income → cost → reconciliation → certification), zoom + fit, `window.print()` export (no jsPDF).
- **Deep links**: `?view=list`, `?pin={apn}`, `?tab={cover|subject|sales|income|reconciliation|cost}`.

## 8. Design system & print engine (`wwwroot/css/app.css`)

Single stylesheet, all theming through `:root` custom properties.

- **Palette**: slate/charcoal enterprise base (`--navy #1e293b`, `--bg #f1f5f9`), white surfaces, gold institutional accent (`--gold #b8860b`), hairline borders.
- **Premium SaaS accents**: full emerald scale (`--em-50…800`) and indigo scale (`--ind-50…700`). Emerald drives all financial metrics (top-bar total, final-value field, report-sheet `.final-value` callout, sales-grid hover/subject rows); indigo is the secondary accent (hover borders, segmented-control hovers).
- **Tokens**: radius scale (UI only — report sheets stay sharp-cornered for print), elevation, spacing, type scale, motion (`--dur 0.18s`), dual focus rings.
- **Form grid & air**: uniform CSS Grid field clusters (`.field-grid`), 34px inputs, crisp 10px/600 uppercase labels; financial aggregates bold (700–800).
- **Financial hierarchy (normative)**: the final appraised value is the single most prominent number on screen — top bar 16px/700, Reconcile tab 18px/700 emerald, report sheet 28px/800 centered in a soft emerald feature card.
- **Print/PDF engine** (`@media print`): all interactive UI stripped; inputs collapse to static text underlined by a thin rule; strict `page-break-inside: avoid` on sections/grids/signatures; `thead` repeats; exact 8.5×11" sheets, one per page, `print-color-adjust: exact`. Verified: headless `--print-to-pdf` produces one clean sheet per page.

## 9. Edge cases & invariants

- **IndexedDB** is best-effort crash recovery only: a failed put (quota, private mode) never blocks the user; the server row (WIP/Final) is the only durable copy. `indexedDB.open` never resolves in headless browsers — the landing view renders blank in headless screenshots (test-harness artifact, not a defect); use deep links for visual verification.
- **Locked output DLL:** the running dev server holds `AppraisalWeb.exe`; `dotnet build` reports MSB3026 copy failures (not compile errors). Stop the server before a clean build, or treat MSB3026 as benign.
- **Parcel-index re-read:** `input/master_parcel_list.json` is re-read on mtime change (a fresh weekly build is picked up without restarting); a bad read retains the previous in-memory copy.
- **Dedup on finalize:** `contentHash` hashes the **raw request node**, not the normalized document. Do not "fix" this by hashing the normalized form.
- **Print:** `fitSheets()` writes an inline `width` on `.sheet`; the print rule must keep `!important`. A sheet that overflows 11in is clipped, never pushed to a second page — sheet boundaries in `report.js` are the control point.

## 10. Verification & change protocol

1. **Build gate:** `dotnet build AppraisalWeb.csproj` → 0 errors (MSB3026 file-lock warnings from the running server are benign).
2. **Unit tests:** `npm test` → `node --test` over `test/core.test.js` (calculations, comp ranking, formatters).
3. **Round-trip gate (data contract):** for any model change, POST a minimal `{ "property": { "apn": "TEST" } }` document, GET it back, and assert the response deep-equals `createEmptyParcel()` with the APN overridden. Then finalize a test row and assert the `CompRecord` snapshot fields. Delete the test rows afterward.
4. **Visual gate (CSS changes):** capture the form tabs + report preview via headless Edge deep links (`?tab=…`, `?view=list`) and verify no layout regressions and that print preview shows sheets only.
5. **Change protocol:** update this file in the same commit as any contract change (§3), token change (§8), or print-parameter change; run the gates in order.

## 11. Goals / roadmap

- Validation layer over the appraisal/comp model (a JS pass mirroring the reference app's Zod schemas)
- Theme system (dark mode via `:root` variable overrides + theme picker)
- Image compression/hashing for uploaded photos (resize + SHA-256 dedup)



