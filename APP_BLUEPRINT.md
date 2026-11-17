# APP_BLUEPRINT.md — Appraisal Workbench

Self-hosted web application for commercial real estate appraisal and relational
data tracking (Riverside County). C# / .NET 10 backend, vanilla JS + custom CSS
frontend, SQLite persistence.

---

## 1. Directory Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 web project (excludes `share/`, `storage/`, `output/` from build) |
| `Program.cs` | Backend entry point: minimal API routes + SQLite document store + parcel index |
| `Rule2.cs` | Rule 2 (Full Cash Value) transfer-screening batch (`RivCo.Rule2`) |
| `Models/` | **Typed C# data structures** (Property, Appraisal, Comp, Tenant) — `RivCo.Models` |
| `start.bat` | Launcher (`dotnet run`) |
| `wwwroot/index.html` | SPA shell (boot-error boundary + module entry) |
| `wwwroot/css/app.css` | Single custom stylesheet — design system via CSS custom properties |
| `wwwroot/js/core.js` | Calculations, data model (`createEmptyParcel`), API client, state, multi-parcel workspace |
| `wwwroot/js/main.js` | Top bar, list view, multi-parcel tabs, split-pane appraisal view, PIN page |
| `wwwroot/js/form.js` | 5-tab appraisal form (Subject, Sales, Income, Cost, Reconciliation) + comp repository |
| `wwwroot/js/report.js` | Print-ready report sheets + browser-print PDF export |
| `wwwroot/js/mapimg.js` | Interactive Leaflet parcel map (PIN page) + static report map |
| `wwwroot/lib/leaflet/` | Vendored Leaflet (interactive map) |
| `wwwroot/img/` | County seal assets |
| `data/appraisal.db` | SQLite database (created at first run; not in repo) |
| `input/master_parcel_list.json` | County parcel index (APN → record + geometry); the search universe |
| `input/` | County source files (master parcel list JSON, transfer lists, work-queue files) |
| `output/` | Generated deliverables (empty in the current build) |
| `storage/build_master_json.py` | Weekly pipeline: county CSVs + GIS geometry → `input/master_parcel_list.json` |
| `storage/build/` | Pipeline artifacts (`geometry.json` cache, `build_log.txt`) |
| `storage/` | Data-prep pipeline archive (scripts, parcel maps, PDFs) — excluded from build |
| `share/` | Distribution copy for IT — excluded from build |

---

## 2. Core Data Structures

### 2.1 Appraisal document (root: `AppraisalData`)

Stored in SQLite `appraisals.data` as a JSON blob (camelCase); summary columns
(`apn`, `address`, `city`, `report_date`, `final_value`) are denormalized for
the list view. The C# model in `Models/` mirrors the JS `createEmptyParcel`
shape 1:1 so both sides round-trip losslessly.

```
AppraisalData
├── property: PropertyInfo        — APN, address, city, zip, county, legal,
│                                   dates, appraiser, case type, photos
├── land: LandInfo                — site area, acres, zoning, topography,
│                                   frontage/depth, utilities, land value
├── improvements: ImprovementsInfo
│   ├── primary: Improvement      — type, year built, GFA, NLA, quality,
│   │                               construction, stories, condition, unit cost
│   └── outbuildings: Improvement[]
├── cost: CostApproach            — physical/functional/economic depreciation
├── income: IncomeApproach        — rent type, PGI/SF, vacancy, cap rate
├── sales: SalesApproach          — method, remarks, comparables: ComparableSale[]
├── reconciliation: Reconciliation — cost/income/sales weights, final value
└── cover: CoverInfo              — case-specific cover fields (transfer /
                                    appeal / stipulation) + valueCategories
```

### 2.2 Comparable sale (`ComparableSale`)

Per-comp fields: parcel (APN), address, city, sale date, price, age, quality,
condition, land/building area, clear height, zoning, property type, 12
adjustment values (`adjBuildingSize` … `adjConditionOfSale`), `selected`,
`isArmsLength`, `photos: PhotoRef[]`.

### 2.3 Comp repository record (`CompRecord`)

Permanent sale comp served by the comp repository. Three sources, never
cross-written:

| Store | Written by | Mutability |
|-------|-----------|------------|
| `permanent_comps` | `/api/finalize` (finalized appraisals) | immutable |
| `transfer_comps` | Rule 2 batch only | read-only (no delete endpoint) |
| local CSV comps | browser localStorage | machine-local |

### 2.4 Photo references (`PhotoRef`)

`{ source: "gis" }` → `/api/parcel-image/{apn}` ·
`{ source: "upload", file }` → `/api/parcel-photos/{apn}/{file}` ·
`{ source: "none" }` → explicit no-image. Replaces legacy base64 data URLs.

### 2.5 Tenant config (`TenantConfig`)

County branding: `county`, `countyName`, `officeName`, `sealUrl` — server-side
`tenant` table.


---

## 3. UI Layout Architecture

- **Top bar** (`#topbar`): county seal, office name, date fields, APN search,
  case-type selector, headline value + actions.
- **List view**: appraisal table (APN, address, city, report date, final value)
  + work-queue cards (Transfer / Appeal).
- **Split-pane workspace**: multi-parcel tabs (left) · 5-tab appraisal form
  (center) · live report preview (right, drag-resizable).
- **5-tab form**: Subject → Sales Comparison (grid + comp form) → Income →
  Cost → Reconciliation. Grouped field grids, step-by-step layout.
- **Report preview**: print-ready 8.5×11" sheets, zoom + fit, `window.print()`
  export (no jsPDF).

## 4. CSS Design System (`wwwroot/css/app.css`)

Single stylesheet, all theming through `:root` custom properties:

- **Palette**: slate/charcoal enterprise base (`--navy #1e293b`, `--bg #f1f5f9`),
  white surfaces (`--surface #ffffff`), gold accent (`--gold #b8860b`),
  hairline borders (`--line #e2e8f0`), danger `#dc2626`.
- **Premium SaaS accents (implemented)**: full emerald scale
  (`--em-50 … --em-800`) and indigo scale (`--ind-50 … --ind-700`);
  `--accent` = emerald 500, `--indigo` = indigo 600. Emerald drives all
  financial metrics (top-bar total, final-value field, report-sheet
  `.final-value` callout, emphasized chips, sales-grid hover/subject rows);
  indigo is the secondary accent (hover borders, segmented-control hovers,
  cost-toggle hover).
- **Design tokens (expanded)**: radius scale (`--r-sm 4 / --r-md 6 /
  --r-lg 10` — UI only; report sheets stay sharp-cornered for print),
  elevation (`--shadow-sm/md/lg`), spacing scale (`--sp-1 … --sp-6`),
  type scale (`--fs-xs … --fs-3xl`), motion (`--ease`, `--dur 0.18s`),
  and dual focus rings (`--focus-ring` emerald, `--focus-ring-indigo`).
- **Form grid & air**: uniform CSS Grid field clusters (`.field-grid`
  gap 14px 18px, `.ps-group-grid` auto-fit minmax(160px,1fr)); section
  bodies padded 16px 18px; tab content 14px 16px with 14px section gaps;
  inputs standardized at 34px height with 10px horizontal padding.
- **Typography & labels**: labels are crisp 10px / `font-weight: 600` /
  uppercase / 0.06em tracking in `--muted` so they never blend into data;
  financial aggregates and final appraised numbers are bold
  (`font-weight: 700–800`): schedule values 14px/700, weight values
  14px/700, sales-correlated total 22px/800, in-form final value 18px/700,
  report-sheet `.final-value` 28px/800 centered in a soft emerald feature
  card, `.value-callout` 28px/800.
- **Interactive feedback**: every `<input>`, `<select>`, number wrapper,
  weight input, repo filter, date field, and button transitions
  (`var(--dur) var(--ease)`) — indigo border on hover
  (`--hover-border`), emerald border + soft two-layer blur focus ring
  (`--focus-ring`) on focus. Buttons/tabs/segmented controls carry
  matching micro-transitions (lift + shadow on landing cards, inset ring
  on active tab, indigo tint on segmented hovers).
- **Print/PDF engine** (`@media print`): all interactive UI stripped
  (`display: none !important` — top bar, tabs, control bar, repo filters,
  buttons, image actions, overlays); inputs collapse to static text
  underlined by `border-bottom: 1px solid #e4e4e7`; strict
  `page-break-inside: avoid` on sections, comp grids, value cards,
  signatures, schedules, and photos; `page-break-after: avoid` keeps
  headings attached to content; `thead` repeats across pages;
  `orphans/widows: 3` on narrative text; exact 8.5×11" sheets, one per
  page, `print-color-adjust: exact`. Verified: headless `--print-to-pdf`
  produces a 5-page PDF (one clean sheet per page, no splits).
- **Roadmap**: dark-mode theme via `:root` variable overrides + theme
  picker.

---

## 5. Task Checklist

- [x] Phase 1 — Blueprint initialized (this file)
- [x] Phase 3 — Core C# data structures (`Models/`): `AppraisalData`,
      `PropertyInfo`, `LandInfo`, `ImprovementsInfo`/`Improvement`,
      `CostApproach`, `IncomeApproach`, `SalesApproach`, `Reconciliation`,
      `CoverInfo`/`ValueCategory`, `ComparableSale`, `CompRecord`,
      `PhotoRef`, `TenantConfig`, `AppraisalJson` serializer
- [x] Phase 4 — `dotnet build` validation (0 errors; round-trip + normalize
      verified against the JS model shape via a throwaway test harness)
- [x] Task 1 — Core API & backend integration (`Program.cs`): appraisal
      GET/POST/PUT now parse into `AppraisalData` + `Normalize()` before
      returning/committing; `ExtractSummary` typed; `SnapshotToCompRecord`
      returns a typed `CompRecord`; `/api/permanent-comps` returns
      `List<CompRecord>`; tenant endpoints use `TenantConfig`. Live-verified
      end-to-end (normalize-on-read, normalize-on-write, finalize → comp
      record, dedup hash preserved on the raw node).
- [x] Task 2 — Premium SaaS CSS refactor (`wwwroot/css/app.css`): emerald
      `--accent` token family + `--focus-ring`; emerald focus/hover states
      with `transition: all 0.2s ease-in-out` on all inputs; emerald
      final-value field + report-sheet `.final-value` callout (26px/700);
      emerald top-bar total; responsive `field-grid` collapse breakpoints.
- [x] Task 3 — Automated visual verification: headless-Edge screenshots of
      Subject / Reconcile / Sales / list views confirm the premium theme
      (emerald final-value field, sales grid, report preview). Landing view
      is blank only in headless (IndexedDB `open` never resolves without a
      real profile) — renders normally in a real browser.
- [x] Task 4 — SaaS Premium UI/UX overhaul (all 5 form tabs): expanded
      design tokens (emerald/indigo scales, radius/elevation/spacing/type
      scales, dual focus rings, motion tokens); uniform 34px inputs in
      14/18px-gap CSS Grid clusters with 16px section padding; crisp
      10px/600 uppercase labels; bold financial aggregates (700–800);
      indigo-hover → emerald-focus micro-interactions on every input,
      button, tab, and segmented control; rounded section cards with
      elevation; emerald tab-completion checks.
- [x] Task 5 — High-tier print/PDF styling: `@media print` strips all
      interactive UI, converts inputs to static text underlined by
      `1px solid #e4e4e7`, enforces `page-break-inside: avoid` on
      sections/grids/signatures, keeps headings with content, repeats
      `thead`, and centers the Final Reconciled Value in a 28px/800 soft
      emerald feature card. Verified via headless `--print-to-pdf`:
      5-page PDF, one clean sheet per page.
- [x] Comp similarity scoring (rank repository by similarity to subject) —
      `scoreComp` / `rankCompsBySimilarity` in `core.js`
- [x] Image clipboard (paste + drag-drop) — `form.js` image panel
- [x] JSON parcel pipeline — `storage/build_master_json.py` (base/geo/assemble)
      → `input/master_parcel_list.json`; backend `LoadParcelIndex()`
- [x] Interactive Leaflet parcel map — `wwwroot/js/mapimg.js` (PIN page)
- [ ] Validation layer over the appraisal/comp model (mirrors Zod schemas)
- [ ] Dark-mode theme via `:root` variable overrides + theme picker
