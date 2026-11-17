# SYSTEM SPECIFICATION — Appraisal Workbench

**Document:** `SYSTEM_SPECIFICATION.md` (master spec, v1.0)
**Scope:** C# backend (`Program.cs`, `Models/`), SQLite persistence, vanilla-JS frontend (`wwwroot/js/`), and the `app.css` design system.
**Audience:** Principal engineers and UI/UX designers extending the system. This document is normative: any change to a contract listed here must update this file in the same change.

---

## 1. System Overview

The Appraisal Workbench is a single-process, local-first web application for California
Board of Equalization (BOE) certified local government appraisers. It produces
transfer-valuation, appeal, and stipulation reports as print-ready letter-size sheets.

### 1.1 Architecture

| Layer | Technology | Location |
|---|---|---|
| Web host | ASP.NET Core minimal API, Kestrel, `http://127.0.0.1:5000` | `Program.cs` |
| Persistence | SQLite (Microsoft.Data.Sqlite), JSON-document rows | `data/appraisal.db` |
| Domain models | Typed C# POCOs with explicit `[JsonPropertyName]` | `Models/*.cs` |
| Frontend | Vanilla ES-module JS (no framework, no build step) | `wwwroot/js/{core,form,report,main}.js` |
| Styling | Single hand-maintained stylesheet, token-driven | `wwwroot/css/app.css` |
| Parcel source data | County JSON index (`input/master_parcel_list.json`, APN → record + geometry) | re-read on mtime change |
| Parcel data pipeline | `storage/build_master_json.py` (base/geo/assemble) — county CSVs + GIS geometry | weekly, offline |
| Interactive map | Leaflet (vendored) + Esri World Imagery tiles, client-side | `wwwroot/js/mapimg.js` |
| Satellite imagery (report) | ArcGIS World Imagery, server-side cached PNGs | `storage/parcel_maps/` |
| Uploaded photos | Server-side files per APN | `storage/parcel_photos/{apn}/` |

### 1.2 Process model

- One process serves both the API and the static frontend (`app.UseStaticFiles` +
  `MapFallbackToFile("index.html")`).
- Static assets are served with `Cache-Control: no-store` — this is a local dev tool and
  heuristic caching has previously masked fixes. **Do not add caching headers.**
- The app binds to loopback only. There is no authentication; the trust boundary is the
  machine.

### 1.3 Data flow (write path)

```
form input → state.data (JS) → scheduleAutosave() → IndexedDB (local crash recovery ONLY)
           → "Save as WIP" / "Finalize" → POST/PUT /api/appraisals[/finalize]
           → AppraisalData.Normalize() → SQLite `data` blob + denormalized summary columns
```

**Critical invariant:** editing a form never writes to the server. The server row is
created only by an explicit save. IndexedDB is refresh/crash recovery, not a copy.

---

## 2. Data Models & 1:1 Round-Trip Contract

### 2.1 Serialization contract

All JSON crossing the C# ↔ JS boundary is governed by `AppraisalJson.Options`
(`Models/AppraisalJson.cs`):

| Option | Value | Rationale |
|---|---|---|
| `PropertyNamingPolicy` | `CamelCase` | Matches the JS data model and persisted blobs |
| `PropertyNameCaseInsensitive` | `true` | Tolerates legacy/external casing |
| `WriteIndented` | `false` | Compact storage in SQLite |
| `DefaultIgnoreCondition` | `WhenWritingNull` | Nulls are omitted, not written |

**Losslessness rules (normative):**

1. Every C# property carries an explicit `[JsonPropertyName]` matching the JS field name
   exactly. The camelCase policy is a fallback, never the source of truth.
2. C# reference-type defaults (`""`, `0`, `false`, `new List<T>()`) mirror the JS
   `createEmptyParcel` defaults field-for-field. A document serialized by C# and
   re-parsed by JS (and vice versa) must be deep-equal after `normalizeParcel` /
   `AppraisalData.Normalize`.
3. `double` values serialize in shortest round-trip form (`R` format in canonical
   hashing). JS `Number` is IEEE-754 double on both sides; no decimal strings.
4. Dates are **ISO-8601 calendar strings** (`yyyy-MM-dd`), never epoch numbers or
   `DateTime` objects. `reportDate`/`effectiveDate`/`saleDate`/`hearingDate` are all
   strings. Timestamps in SQLite (`created_at`, `updated_at`) are `DateTime.UtcNow`
   in round-trip `"o"` format.
5. Unknown JSON properties are tolerated on read (case-insensitive binding ignores
   them) and must not be destroyed by a read-modify-write cycle of the *raw* node.
   The finalize content-hash therefore hashes the **raw request node**, not the
   normalized model (see §2.8).
6. `PhotoRef.File` is the only nullable string in the model (`string?` / JS `null`);
   it is omitted from JSON when null per rule 4.

### 2.2 Root document — `AppraisalData`

One appraisal = one row in `appraisals` = one JSON document with exactly these eight
top-level sections (order is conventional, not significant):

| JSON key | C# type | JS origin | Notes |
|---|---|---|---|
| `property` | `PropertyInfo` | `createEmptyParcel().property` | Subject ID + case metadata |
| `land` | `LandInfo` | `.land` | Site characteristics + land value |
| `improvements` | `ImprovementsInfo` | `.improvements` | `primary` + `outbuildings[]` |
| `cost` | `CostApproach` | `.cost` | Depreciation schedule |
| `income` | `IncomeApproach` | `.income` | Rent/losses/cap rate |
| `sales` | `SalesApproach` | `.sales` | Method + `comparables[]` |
| `reconciliation` | `Reconciliation` | `.reconciliation` | Weights + final value |
| `cover` | `CoverInfo` | `.cover` | Case-type-specific cover fields |

`AppraisalData.CreateEmpty(apn)` and JS `createEmptyParcel(apn)` are the single source
of truth for defaults and must stay in lockstep (see §2.5).

### 2.3 Section property tables

#### 2.3.1 `property` — `PropertyInfo`

| JSON field | C# type | Default | UI tab |
|---|---|---|---|
| `apn` | string | `""` | Cover (top bar) |
| `parcelId` | string | `""` | Subject |
| `address`, `city`, `zip`, `county` | string | `""` | Cover / Subject |
| `intersection`, `legalDescription` | string | `""` | Subject |
| `effectiveDate` | string (ISO date) | `"2025-01-01"` | Cover |
| `reportDate` | string (ISO date) | today at creation | Cover |
| `appraiser`, `appraiserLicense`, `reportType`, `purpose`, `client` | string | `""` | Subject |
| `transferDocumentNumber`, `ratioCode` | string | `""` | Cover (transfer) |
| `salePrice` | double | `0` | Cover (transfer) |
| `appraiserId`, `section`, `appraiserNotes` | string | `""` | Cover (transfer) |
| `caseType` | string | `"transfer"` | Cover segmented control; `"transfer" \| "appeal" \| "stipulation"` (legacy `"general"` tolerated) |
| `subjectImage` | `PhotoRef?` | `null` | **Legacy** — migrated to `subjectPhotos` by `migrateSubjectImage()`; kept for old documents |
| `subjectPhotos` | `PhotoRef[]` | `[]` | Cover photo well |

#### 2.3.2 `land` — `LandInfo`

| JSON field | C# type | Default |
|---|---|---|
| `siteAreaSqFt`, `acres`, `frontageFt`, `depthFt` | double | `0` |
| `lotCount` | int | `0` |
| `zoning`, `topography`, `shape` | string | `""` |
| `utilities` | string[] | `[]` |
| `landValue` | double | `0` |
| `landValueMethod`, `landValueNotes` | string | `""` |

#### 2.3.3 `improvements` — `ImprovementsInfo`

`primary` and each `outbuildings[]` entry are `Improvement`:

| JSON field | C# type | Default |
|---|---|---|
| `id` | string | `"imp-{unix-ms}"` (primary only, at creation) |
| `name` | string | `"Building 1"` (primary) |
| `type`, `quality`, `constructionType`, `condition` | string | `""` |
| `yearBuilt` | int | `0` |
| `grossFloorArea`, `nla`, `unitCost` | double | `0` |
| `stories` | int | `0` |

#### 2.3.4 `cost` — `CostApproach`

| JSON field | C# type | Default |
|---|---|---|
| `physicalDepreciationPct` | double | `0` |
| `functionalDepreciation`, `economicDepreciation` | double | `0` |
| `costNotes` | string | `""` |
| `includeInReport` | bool | `false` |

#### 2.3.5 `income` — `IncomeApproach`

| JSON field | C# type | Default |
|---|---|---|
| `rentType` | string | `"NNN"` (`"NNN" \| "gross" \| "modified"`) |
| `pgiPerSf` | double | `0` |
| `vacancyPct`, `collectionLossPct`, `operatingExpensePct` | double | `5` |
| `capRate` | double | `6` |
| `incomeNotes` | string | `""` |

#### 2.3.6 `sales` — `SalesApproach`

| JSON field | C# type | Default |
|---|---|---|
| `method` | string | `"average"` (`"average" \| "weighted" \| "range"`) |
| `remarks` | string | `""` |
| `comparables` | `ComparableSale[]` | `[]` |

#### 2.3.7 `reconciliation` — `Reconciliation`

| JSON field | C# type | Default |
|---|---|---|
| `costWeight` | int | `0` |
| `incomeWeight` | int | `25` |
| `salesWeight` | int | `75` |
| `finalValue` | double | `0` |
| `rationale` | string | `""` |

#### 2.3.8 `cover` — `CoverInfo`

Cover fields are grouped by case type; all are always present in the document (unused
groups simply stay at defaults).

| Group | JSON fields | C# type | Default |
|---|---|---|---|
| transfer | `totalPosted` | double | `0` |
| appeal | `hearingDate`, `caseNumber`, `applicant`, `agent`, `presentedBy` | string | `""` |
| appeal | `currentRollValue`, `applicantOpinionValue`, `assessorOpinionValue` | double | `0` |
| stipulation | `applicationNumber`, `applicantName`, `applicantAddress`, `agentName`, `agentAddress`, `tra`, `assessmentNo`, `arbNo`, `yearArbCreated`, `location`, `supplementalNo`, `acreage`, `use`, `factsJustifying` | string | `""` |
| stipulation | `valueCategories` | `ValueCategory[]` | 6 default rows (below) |

`ValueCategory` rows: `{ category: string, code: string, rollValue: double, stipulatedValue: double }`.
Default rows (index-ordered, mirrors JS): `Land/01`, `Structures/02`, `Fixtures/03`,
`Trees & Vines/05`, `Business Pers. Prop./08`, `Other/""`.

#### 2.3.9 `ComparableSale` (within `sales.comparables[]`)

| JSON field | C# type | Default |
|---|---|---|
| `id` | string | `""` |
| `parcel`, `address`, `city` | string | `""` |
| `saleDate` | string (ISO date) | `""` |
| `price` | double | `0` |
| `age` | int | `0` |
| `quality`, `condition`, `zoning`, `propertyType` | string | `""` |
| `landArea`, `buildingArea`, `clearHeight` | double | `0` |
| `adjBuildingSize`, `adjLocation`, `adjCornerSite`, `adjAge`, `adjQuality`, `adjCondition`, `adjTenantsUse`, `adjOccupancy`, `adjLandBldgRatio`, `adjFreeway`, `adjMarketConditions`, `adjConditionOfSale` | double (12 grid adjustments, dollars) | `0` |
| `selected` | bool | `true` |
| `isArmsLength` | bool | `true` |
| `photos` | `PhotoRef[]` | `[]` |

Derived (never serialized): `TotalAdjustments` = sum of the 12 `adj*` fields;
`IndicatedValue` = `price + TotalAdjustments`. JS computes the same via
`computeSalesGridComp()` / `ADJ_FIELDS`.

#### 2.3.10 `CompRecord` (comp repository)

A permanent sale comp — the *snapshot* of a finalized appraisal's subject (or a Rule 2
transfer row). Fields: `apn`, `address`, `city`, `saleDate`, `price`, `age`, `quality`,
`condition`, `landArea`, `buildingArea`, `clearHeight`, `zoning`, `isArmsLength` (default
`true`), `sourceReport`, `propertyType`, `subjectApn`, `photoUrl`, `docNumber`,
`effectiveDate`, plus the 12 `adj*` fields (zero for repository comps). Built by
`SnapshotToCompRecord()` in `Program.cs`; the two repository stores
(`permanent_comps`, `transfer_comps`) are **never cross-written**.

#### 2.3.11 `PhotoRef`

`{ source: "gis" | "upload" | "none", file?: string }`. Photos are references, never
base64 blobs. Resolution (JS `resolvePhotoUrl`): `gis` → `/api/parcel-image/{apn}`,
`upload` → `/api/parcel-photos/{apn}/{file}`, `none`/absent → no image.

#### 2.3.12 `TenantConfig`

`{ schemaVersion: "1.0", county, countyName, officeName, sealUrl }` — county branding,
single row `id = 'config'` in the `tenant` table.

### 2.4 Normalization semantics

`AppraisalData.Normalize(doc)` (C#) and `normalizeParcel(parcel)` (JS) are equivalent
and run on **every read** (GET `/api/appraisals/{id}`, workspace restore, WIP import):

1. Missing top-level section → replaced by the `CreateEmpty` default for that section.
2. `improvements` and `sales` merge field-by-field (their sub-objects/arrays are
   individually defaulted).
3. `cover.valueCategories` merges **row-by-row by index**: each provided row is spread
   over its default row, so a row missing `code` keeps the default code. Extra provided
   rows beyond the 6 defaults are appended (C# `Concat(provided.Skip(defaults.Count))`).
4. Normalization is idempotent: `Normalize(Normalize(x)) == Normalize(x)`.

### 2.5 Default lockstep rule

`createEmptyParcel` (JS, `core.js:315`) and `AppraisalData.CreateEmpty` (C#) must define
identical defaults. When a default changes, change both in the same commit and re-run
the round-trip check (§6.3).

---

## 3. UI/UX Blueprint — California BOE Appraiser Workbench

### 3.1 Design doctrine

The workbench is a **data-entry instrument for certified local government appraisers**,
not a marketing site. Every pixel decision follows from three constraints:

1. **Rapid visual parsing.** An appraiser cross-checks the left form against the live
   report preview on the right. The two panes must read as *the same document*: the
   form's field labels, group titles, and section headers use the same typographic
   treatment (uppercase, letter-spaced, 10–12px) as the report sheet's labels.
2. **Zero wasteful whitespace.** Dense, multi-column grids pack related metadata into
   compact card segments. No field may stretch to full width when its sibling fields
   can share the row. Vertical rhythm is compressed: section bodies use
   `padding: 0.5rem 0.75rem` (8px 12px) and field grids use `gap: 10px 14px`.
3. **One geometric language.** The PDF report sheets use strict 90° square corners.
   **Every** interactive element matches: `border-radius: 0` globally (2px is the
   absolute maximum allowed anywhere). No pills, no soft-rounded corners, no glow
   halos. This is enforced by the "Corner Sync" block at the end of `app.css`
   (a single `border-radius: 0 !important` rule listing every interactive selector).

### 3.2 Theme: "SaaS Premium" enterprise

| Element | Treatment |
|---|---|
| Primary surface | Charcoal/navy `#1e293b` (top bar, section header bars, primary buttons) |
| Accent — financial metrics | Emerald scale `--em-50…800`; final value, reconciled totals, top-bar total |
| Accent — secondary actions | Indigo scale `--ind-50…700` (hover tints, segmented-control hover) |
| Accent — institutional | Gold `#b8860b` (seal, section-header underline, group-title tick) |
| Input fill | `--input-bg: #f8fafc` (soft slate) with `--input-border: #e4e4e7` (zinc-200) — mirrors the report sheet's static text rows |
| Backgrounds | `--bg: #f1f5f9` app canvas, `--bg-soft: #f8fafc` panes, `#fff` cards |
| Type | Inter / Segoe UI system stack; tabular numerals (`font-variant-numeric: tabular-nums`) on **every** monetary/numeric value |

**Financial hierarchy (normative):** the final appraised value is the single most
prominent number on screen. It appears at three levels of prominence:
1. Top bar total — 16px/700, `--accent-bright` on navy.
2. Reconcile-tab `.final-field` — 18px/700 emerald on a soft emerald card.
3. Report sheet `.final-value` — 28px/800 emerald, centered in a soft feature card.

All other aggregates (schedule values, weight values, sales totals, correlated value)
are 14–22px with `font-weight: 700–800`. Labels are never bold-heavy: 10px/600
uppercase with `letter-spacing: 0.05–0.06em` in `--muted`.

### 3.3 Layout system

- **Split pane:** left form pane (`flex: 0 0 calc(50% - 4px)`, `zoom: 1.2` for
  readability) | 8px drag handle | right preview pane (gray `#e2e8f0` canvas with
  scaled letter sheets). The preview is the source of visual truth.
- **Form grids:** uniform CSS Grids, never ad-hoc floats.
  - `.field-grid` — `gap: 10px 14px`; `.c2/.c3/.c4` fixed columns; auto-fit variant
    `repeat(auto-fit, minmax(220px, 1fr))` for dense metadata clusters.
  - `.ps-group-grid` (Property Summary) — `repeat(auto-fit, minmax(160px, 1fr))`.
  - Related metadata is grouped into titled segments (`.ps-group` with
    `.ps-group-title`): e.g. Transfer Details places Document Number, Ratio Code, and
    Property Type side-by-side in one compact grid row.
- **Section boxes:** white card, `border-top: 3px solid var(--navy)`, navy gradient
  header bar with gold inset underline, `break-inside: avoid`.
- **Tabs:** navy strip container (`.tabs-box`) with uppercase 12px/500 tab labels;
  active tab = `--navy-dark` fill + 700 weight; completion glyph (✓) in `--em-400`.

### 3.4 Micro-interaction states (normative)

| State | Effect |
|---|---|
| Rest | `--input-border` (#e4e4e7) border, `--input-bg` fill |
| Hover | border → `--hover-border` (#d4d4d8, zinc-300); buttons → `--surface-3` fill |
| Focus | border → `--accent` (emerald 500) **only**. `--focus-ring: none` — no glow halos. Transition `border-color 0.18s cubic-bezier(0.4,0,0.2,1)` |
| Focus-visible (keyboard) | 2px emerald outline, offset 1–2px (accessibility, no blur) |
| Disabled | `opacity: 0.5`, `cursor: default` |
| Row hover (tables) | `--em-50` tint (list rows), `--ind-50` tint (segmented controls) |

All transitions use `--dur: 0.18s` and `--ease: cubic-bezier(0.4, 0, 0.2, 1)`.
No transition may exceed 200ms; no element may animate layout properties
(`width`, `height`, `top`, `left`) — only `background`, `border-color`, `color`,
`box-shadow`, `transform`.

### 3.5 Information architecture

- **Landing:** workflow cards (New Appraisal / Archive / Work Queues) + parcel search
  + recent-work list. Top-bar actions hidden (`#topbar.tb-landing .tb-right`).
- **Workspace:** top bar (seal, county/office, dates, APN search, headline, total,
  actions) → control bar (WIP, Save, Finalize, Print) → tab strip (Cover / Subject /
  Sales / Income / Reconcile) → form pane + live preview pane.
- **Deep links:** `?view=list`, `?pin={apn}`, `?tab={cover|subject|sales|income|reconciliation}`
  (opens the most recent appraisal with that tab active).
- **Report sheets (right pane):** cover → subject → sales → income → cost →
  reconciliation → certification, each exactly 8.5×11in, scaled to fit the pane.

---

## 4. Design Tokens, Typography & Print Safety

### 4.1 Token inventory (`:root`, `app.css:7–94`)

| Group | Tokens | Values |
|---|---|---|
| Brand | `--navy`, `--navy-dark`, `--navy-light` | `#1e293b`, `#0f172a`, `#334155` |
| Institutional | `--gold`, `--gold-light`, `--gold-soft` | `#b8860b`, `#d4a843`, `#fff8e6` |
| Surfaces | `--bg`, `--bg-soft`, `--panel`, `--surface`, `--surface-2`, `--surface-3` | `#f1f5f9`, `#f8fafc`, `#fff`, `#fff`, `#f8fafc`, `#f1f5f9` |
| Ink | `--text`, `--ink`, `--ink-2`, `--ink-3`, `--muted`, `--muted-2` | `#1e293b`, `#1e293b`, `#334155`, `#475569`, `#64748b`, `#94a3b8` |
| Lines | `--line`, `--line-strong`, `--border`, `--border-soft`, `--border-input` | `#e2e8f0`, `#cbd5e1`, `#1e293b`, `#cbd5e1`, `#94a3b8` |
| Inputs | `--input-bg`, `--input-border`, `--hover-border` | `#f8fafc`, `#e4e4e7`, `#d4d4d8` |
| Emerald | `--em-50…800`, `--accent` (500), `--accent-dark` (600), `--accent-deep` (700), `--accent-bright` (400), `--accent-soft-green` | `#ecfdf5…#065f46` |
| Indigo | `--ind-50…700`, `--indigo` (600), `--indigo-soft` | `#eef2ff…#4338ca` |
| Focus | `--focus-ring`, `--focus-ring-indigo` | `none` (sharp focus: border-color only) |
| Radius | `--r-sm`, `--r-md`, `--r-lg` | `0px` (Corner Sync; 2px max allowed) |
| Elevation | `--shadow-sm/md/lg` | `0 1px 2px/3px`, `0 4px 12px`, `0 12px 32px` (all ≤ 0.16 alpha) |
| Spacing | `--sp-1…6` | 4 / 8 / 12 / 16 / 20 / 24 px |
| Type | `--fs-xs…3xl` | 10 / 11 / 13 / 15 / 18 / 22 / 28 px |
| Motion | `--ease`, `--dur` | `cubic-bezier(0.4,0,0.2,1)`, `0.18s` |

**Token governance:** new colors must enter as named tokens, never as raw hex in a
component rule (report-sheet print colors excepted — they are intentionally
hard-coded for print fidelity). Legacy aliases `--teal`/`--teal-dark` map to charcoal
and must not be re-pointed to green.

### 4.2 Typography scale

| Role | Size / weight | Usage |
|---|---|---|
| Field labels | 10px / 600 / uppercase / 0.05–0.06em | `.field > label`, `.dg-cell-label`, `.repo-filter label` |
| Group titles | 12px / 700 / uppercase / 0.08em + gold tick | `.ps-group-title`, `.field-group-label` |
| Body / inputs | 13px / 400–500 | `.inp`, `.sched-row .s-label` |
| Values (tabular) | 14px / 700 | `.chip .chip-value`, `.sched-row .s-value`, `.w-value` |
| Aggregates | 17–22px / 600–800 | `.sales-correlated .sc-right` (22px/800) |
| Headline metric | 28px / 800 / emerald | `.final-value-num`, `.value-callout .vc-value` |
| Report sheet | 8.5–15px (print-optimized, independent of UI scale) | `.sheet` descendants |

### 4.3 Print safety parameters (`@media print`, `app.css:1702–1784`)

| Parameter | Value | Purpose |
|---|---|---|
| `@page` | `size: letter; margin: 0` | Exact 8.5×11in, no browser margins |
| `print-color-adjust` | `exact` (both vendor forms) | Navy headers / gold accents survive printing |
| Sheet geometry | `width: 8.5in !important; height: 11in !important` | `!important` defeats the inline width set by `fitSheets()` |
| Page break per sheet | `page-break-after: always` (auto on last sheet) | One sheet per physical page, no trailing blank |
| `page-break-inside: avoid` | `.sheet tr`, `.section`, `.tr-box`, `.cov-box`, `.value-callout`, `.final-value`, `.value-cards`, `.st-sigs`, `.cert .sig-grid`, `.sched`, `.approach-block`, `.img-cell`, `.kv`, `.st-facts`, `.st-table`, `.cov-photos`, `.subj-summary`, `.sales-correlated` | No halfway-split sections, comp grids, or signature blocks |
| `page-break-after: avoid` | `.sheet-h`, all section/box `> header` | Headings never orphaned at page bottom |
| `thead` | `display: table-header-group` | Table headers repeat on every page a table spans |
| `orphans` / `widows` | `3` / `3` on all narrative text | No stranded single lines |
| Interactive UI | `display: none !important` on `#topbar`, `.pane-left`, `.tab-bar`, `.control-bar`, `.cover-setup`, `.repo-*`, `.btn`, `.staging-toolbar`, `.wip-menu`, `.overlay-backdrop`, etc. | Print view contains report sheets only |
| Inputs in print | `border: 0; border-bottom: 1px solid #e4e4e7; background: transparent` | Static text underlined by a thin solid rule |
| Shadows | `--shadow-*: none` | No print artifacts |

### 4.4 Responsive breakpoints

`1399px` (top-bar headline shrinks) · `1100px` (field grids collapse) · `1099px`
(top-bar dates hidden) · `900px` (split pane stacks) · `860px` / `799px` (top-bar
compression) · `640px` (landing cards stack) · `560px` (field grids single-column).

---

## 5. Edge-Case Safety Requirements

### 5.1 IndexedDB in headless / constrained browsers

- **`indexedDB.open` never resolves in headless Edge/Chrome** (no real browser
  profile). Every IndexedDB call site must be wrapped so a *pending* open (not just a
  rejected one) degrades gracefully: `boot()` must not await IndexedDB on the critical
  path; `restoreWorkspaceLocal()` returns `null` on any error or timeout.
- **Consequence for visual verification:** the landing view renders blank in
  headless screenshots. This is a *test-harness artifact, not a defect*. Verification
  must use deep links (`?tab=…`, `?view=list`) which bypass the IndexedDB restore
  path, or inject a workspace via the API.
- **Quota/eviction:** IndexedDB is best-effort crash recovery. A failed put (quota,
  private mode) must never block the user — autosave swallows the error and shows the
  save-status pill in a degraded state. The server row (WIP/Final) is the only
  durable copy.
- **Version upgrades:** `onupgradeneeded` must be idempotent and must not delete
  stores that hold open workspaces; schema changes add, they do not drop.

### 5.2 Serialization edge cases

- **`double` precision:** canonical content hashing uses `R` format; JS `Number`
  round-trips IEEE-754 exactly for all values the app produces. Never compare
  monetary values with `==` in JS — use the integer-cent helpers.
- **Missing/legacy fields:** normalization (§2.4) is the *only* repair path. No
  endpoint may assume a blob is complete; every read goes through `Normalize()`.
- **Dedup on finalize:** `contentHash` hashes the **raw request node**, not the
  normalized document, so rows archived before model refactors keep deduplicating.
  Do not "fix" this by hashing the normalized form.
- **Unknown JSON fields:** preserved verbatim in the stored blob (System.Text.Json
  ignores unknown members on read; the raw node is what is persisted). Forward
  compatibility depends on this — do not round-trip blobs through a lossy
  intermediate.
- **Dates:** ISO-8601 date strings (`YYYY-MM-DD`), never epoch numbers, never
  `DateTime` (which would inject a `T00:00:00` suffix and break JS `Date` parsing
  consistency).

### 5.3 Filesystem / process edge cases

- **Locked output DLL:** the running dev server holds `AppraisalWeb.exe`; `dotnet
  build` reports MSB3026 copy failures (not compile errors). Stop the server
  (`Stop-Process`) before a clean build, or treat MSB3026 as benign.
- **Parcel-index re-read:** `input/master_parcel_list.json` is re-read on mtime
  change (a fresh weekly build is picked up without restarting the app); a bad
  read (mid-write, malformed JSON) is caught and the previous in-memory copy is
  retained.
- **Parcel imagery:** ArcGIS fetches are cached to `storage/parcel_maps/`; a failed
  fetch returns the last cached PNG or a 404 — the UI shows the dashed
  "no image" placeholder, never a broken-image icon.
- **Loopback-only binding:** no CORS, no auth. Any change to bind address or add
  multi-tenancy requires a security review of the whole API surface.

### 5.4 Print edge cases

- **Inline width override:** `fitSheets()` writes an inline `width` on `.sheet`;
  the print rule must keep `!important` or the browser scales the sheet and clips
  content.
- **Background stripping:** some printers/OS settings strip backgrounds even with
  `print-color-adjust: exact`. Navy header bars must remain legible when flattened
  to black (they are — text is white on the darkest token).
- **Sheet overflow:** a sheet that overflows 11in is clipped (`overflow: hidden`),
  never pushed to a second page. Content that must not clip belongs in the next
  sheet (report.js sheet boundaries are the control point).

---

## 6. Verification & Change Protocol

### 6.1 Build gate

`dotnet build AppraisalWeb.csproj` must report **0 errors** (MSB3026 file-lock
warnings from the running server are benign; stop the server for a clean gate).

### 6.2 Visual gate (headless)

For any CSS change: capture all 5 tabs + the report preview via headless Edge
deep links (`?tab=cover|subject|sales|income|reconciliation`, `?view=list`) at
1600×900 with `--virtual-time-budget=15000`, and verify: (a) no element shows a
non-zero border-radius, (b) no field stretches wider than its grid track,
(c) the final value is the most prominent number on the Reconcile tab and the
reconciliation sheet, (d) print preview shows sheets only (no form chrome).

### 6.3 Round-trip gate (data contract)

For any model change: POST a minimal `{ "property": { "apn": "TEST" } }` document,
GET it back, and assert the response deep-equals `createEmptyParcel()` with the APN
overridden (i.e. `Normalize` filled every section). Then finalize a test row and
assert the `CompRecord` snapshot fields (`price`, `age`, `buildingArea`,
`docNumber`, all 12 `adj*` = 0). Delete the test rows afterward.

### 6.4 Change protocol

1. Update this file in the same commit as any contract change (§2), token change
   (§4.1), or print-parameter change (§4.3).
2. Run the gates in §6.1–§6.3 in order.
3. Commit with a message naming the affected contract sections.

