# APP_BLUEPRINT.md — Appraisal Workbench

Self-hosted web application for commercial real estate appraisal and relational
data tracking (Riverside County). C# / .NET 10 backend, vanilla JS + custom CSS
frontend, SQLite persistence.

---

## 1. Directory Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 web project (excludes `share/`, `storage/`, `output/` from build) |
| `Program.cs` | Backend entry point: minimal API routes + SQLite document store |
| `Rule2.cs` | Rule 2 (Full Cash Value) transfer-screening batch (`RivCo.Rule2`) |
| `Models/` | **Typed C# data structures** (Property, Appraisal, Comp, Tenant) — `RivCo.Models` |
| `start.bat` | Launcher (`dotnet run`) |
| `wwwroot/index.html` | SPA shell (boot-error boundary + module entry) |
| `wwwroot/css/app.css` | Single custom stylesheet — design system via CSS custom properties |
| `wwwroot/js/core.js` | Calculations, data model (`createEmptyParcel`), API client, state, multi-parcel workspace |
| `wwwroot/js/main.js` | Top bar, list view, multi-parcel tabs, split-pane appraisal view |
| `wwwroot/js/form.js` | 5-tab appraisal form (Subject, Sales, Income, Cost, Reconciliation) + comp repository |
| `wwwroot/js/report.js` | Print-ready report sheets + browser-print PDF export |
| `wwwroot/img/` | County seal assets |
| `data/appraisal.db` | SQLite database (created at first run; not in repo) |
| `input/` | County source files (master parcel list, transfer lists, work-queue files) |
| `output/` | Generated deliverables + `parcel_data.json` (rivcoview API cache) |
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
- **Premium SaaS accents (implemented)**: emerald token family
  (`--accent #10b981`, `--accent-dark #059669`, `--accent-deep #047857`,
  `--accent-bright #34d399` on dark surfaces, `--accent-soft-green`),
  indigo secondary (`--indigo #4f46e5`), and a shared `--focus-ring`
  (`0 0 0 3px rgba(16,185,129,.22)`). Emerald drives all financial
  metrics: top-bar total, final-value field, report-sheet `.final-value`
  callout, emphasized computed chips, and sales-grid hover/bold rows.
- **Typography**: dense 9–12px base, `font-feature-settings: 'tnum'` for
  tabular numerals; final appraised values rendered large + `font-weight: 700`
  (17px in-form, 26px on the report sheet).
- **Layout**: CSS Grid for property metadata (year built, SF, lot size) with
  responsive collapse breakpoints (1100/860/560px); flex multi-column
  containers for the sales-comparison grid.
- **Inputs**: explicit `:hover` / `:focus` states with `transition: all 0.2s
  ease-in-out` (emerald border + `--focus-ring` box-shadow) on every text
  input, select, number wrapper, weight input, and repo filter.
- **Roadmap**: dark-mode theme via `:root` variable overrides + theme picker.

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
- [ ] Comp similarity scoring (rank repository by similarity to subject)
- [ ] Validation layer over the appraisal/comp model (mirrors Zod schemas)
- [ ] Dark-mode theme via `:root` variable overrides + theme picker
