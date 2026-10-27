# Gap Analysis — Appraisal Workflows → RivCo Appraisal Web App

*Scoping document · prepared before any code changes*

Goal: bring the RivCo app (C# / .NET 10 + vanilla JS, SQLite) to functional parity
with the `appraisal_workflows` reference app (React/TS), for implementation at
Riverside County. **License gate is explicitly out of scope** (not ported; the
RivCo app has no license code to remove).

---

## Progress

- **P1 — Data safety: ✅ DONE** (WIP autosave, WIP export/import, error boundary +
  global error capture). Verified: JS syntax OK, served live, API healthy.
  - `core.js`: `scheduleAutosave()` (1s-debounced → `saveCurrent()`), `exportWip()`,
    `importWip()`.
  - `main.js`: `⬇ WIP` / `⬆ WIP` top-bar buttons, `#save-status` indicator,
    `appraisal:changed → scheduleAutosave` hook, autosave on transfer-open.
  - `index.html`: `#boot-error` banner + inline `error`/`unhandledrejection` capture.
  - `app.css`: `.save-status` + `#boot-error` styles.
- P2–P6: pending.

---

## 0. Status of "fake Meridian → real Riverside" conversion

**Already complete.** The RivCo app contains **zero** `Meridian` references. It
already ships with:
- `County of Riverside` default tenant (`main.js`), `Riverside Commercial` section placeholder (`form.js`)
- Riverside County seal images (`wwwroot/img/seal/`)
- Real parcel data via the rivcoview API (`/api/parcel-data/{apn}` → `output/parcel_data.json`)
- A real Riverside transfer file (`input/Transfers_ByRecordDate_CalendarYear_10142026.xlsx`)

No branding/data conversion work is required.

---

## 1. Architecture delta (affects how features port)

| Concern | Appraisal Workflows | RivCo | Implication |
|---|---|---|---|
| Persistence | IndexedDB (7 stores, client-side) | SQLite (server-side, C#) | WIP autosave + archive must target the C# backend / SQLite, not IndexedDB |
| Parcel source | Master parcel list CSV auto-load | rivcoview API (`parcel_data.json`) | "Auto-load county data" (feature 39) is N/A — different data source |
| State model | `Portfolio { parcels[], activeParcelIndex }` | single `state.data` (one parcel) | Multi-parcel workspace requires a state-model change |
| Validation | Zod schemas | none | Add a JS validation layer (or C#-side) |
| Data model | `AppraisalData` / `CompRecord` | identical shape | **Already aligned** — no model migration |

The appraisal data model (`types/index.ts`) and comp model (`schema.ts`) match the
RivCo `createEmptyParcel` / comp shape 1:1, so no data migration is needed.

---

## 2. Feature-by-feature matrix

Legend: ✅ aligned · ⚠️ partial · ❌ missing (gap) · ⛔ excluded · ➖ N/A

| # | Feature | Appraisal | RivCo | Status |
|---|---------|:---:|:---:|:---:|
| 1 | License Gate (Ed25519) | ✅ | — | ⛔ **EXCLUDED** |
| 2 | Tenant Config (county.json) | ✅ | ✅ server `tenant` table | ✅ |
| 3 | Theme System (picker + dark mode) | ✅ | ❌ | ❌ GAP |
| 4 | CSV Data Ingestion | ✅ | ⚠️ comp-CSV import only | ⚠️ |
| 5 | JSON Data Ingestion | ✅ | ✅ `parcel_data.json` | ✅ |
| 6 | Zod Validation | ✅ | ❌ | ❌ GAP |
| 7 | Persistence (IndexedDB / SQLite) | ✅ | ✅ SQLite | ✅ (diff tech) |
| 8 | **Multi-Parcel Workspace (tabs)** | ✅ | ❌ single parcel | ❌ **GAP (major)** |
| 9 | APN Search w/ Suggestions | ✅ | ✅ | ✅ |
| 10 | 5-Tab Appraisal Form | ✅ | ✅ | ✅ |
| 11 | Subject Tab | ✅ | ✅ | ✅ |
| 12 | Sales Comparison Tab | ✅ | ✅ | ✅ |
| 13 | Income Approach Tab | ✅ | ✅ | ✅ |
| 14 | Reconciliation Tab | ✅ | ✅ | ✅ |
| 15 | Cost Approach Tab | ✅ | ✅ | ✅ |
| 16 | Comp Repository (filter/sort/add/remove) | ✅ | ⚠️ query filter, no sort | ⚠️ |
| 17 | **Comp Similarity Scoring** | ✅ | ❌ | ❌ GAP |
| 18 | Sales Grid (12 adjustments) | ✅ | ✅ | ✅ |
| 19 | Comp Form (editable) | ✅ | ✅ | ✅ |
| 20 | Live Report Preview (sheets) | ✅ | ✅ (more sheets) | ✅ |
| 21 | Report Zoom | ✅ | ✅ | ✅ |
| 22 | Print CSS (one sheet/page) | ✅ | ⚠️ verify `@media print` | ⚠️ verify |
| 23 | PDF Export (html2canvas+jsPDF) | ✅ | ✅ | ✅ |
| 24 | Finalize & Snapshot | ✅ | ✅ | ✅ |
| 25 | SHA-256 Deduplication | ✅ | ✅ `Canonicalize`+hash | ✅ |
| 26 | Archive Panel (browse/verify/open/delete) | ✅ | ⚠️ list view, no verify | ⚠️ |
| 27 | **WIP Autosave** | ✅ | ❌ manual save only | ❌ GAP |
| 28 | **WIP Export/Import (JSON)** | ✅ | ❌ | ❌ GAP |
| 29 | Image Clipboard (paste/drop/browse) | ✅ | ⚠️ browse only | ⚠️ |
| 30 | Image Compression + Hashing | ✅ | ❌ raw base64 | ❌ GAP |
| 31 | Batch Rule 2 (WTI) | ✅ | ✅ `Rule2.cs` | ✅ |
| 32 | Batch CSV Export (6 buckets) | ✅ | ✅ | ✅ |
| 33 | Batch Results Persistence | ✅ | ✅ `rule2_runs` | ✅ |
| 34 | **Portfolio Summary View** | ✅ | ❌ | ❌ GAP |
| 35 | Error Boundary | ✅ | ❌ | ❌ GAP |
| 36 | Global Error Capture | ✅ | ❌ | ❌ GAP |
| 37 | Resizable Split Pane | ✅ | ✅ | ✅ |
| 38 | Mobile Toggle (Form/Report) | ✅ | ❌ | ❌ GAP |
| 39 | Auto-Load County Data (CSV) | ✅ | ➖ rivcoview API | ➖ N/A |
| 40 | Master List Integrity (SHA-256) | ✅ | ❌ | ❌ GAP |

**Already aligned (no work):** 2, 5, 7, 9, 10–15, 18, 19, 20, 21, 23, 24, 25, 31, 32, 33, 37.

---

## 3. Gaps to port (prioritized)

### Tier 1 — Data safety & robustness (quick wins, low risk, high value)
- **27 WIP Autosave** — debounced autosave of the working appraisal. Port to the
  C# backend (SQLite) or `localStorage`. Prevents data loss — critical for production.
- **28 WIP Export/Import** — lossless JSON round-trip (`.wip.json`). Client-side only.
- **35/36 Error Boundary + Global Error Capture** — `window.onerror` /
  `unhandledrejection` banner + a recovery wrapper.

### Tier 2 — Core workflow: multi-parcel (the biggest gap)
- **8 Multi-Parcel Workspace** — change `state` from a single parcel to a
  `portfolio { parcels[], activeIndex }`; add a tab strip; route form/report/save/
  finalize through the active parcel. This is the largest single change.
- **34 Portfolio Summary View** — aggregate totals across open parcels (count,
  total assessed, avg). Shown when no single parcel is active.

### Tier 3 — Comp intelligence
- **17 Comp Similarity Scoring** — port `compSelection.ts` (SF 35% / cost-SF 25% /
  age 20% / location 20%, 0–100 score) + `compIndex.ts` (top-3 cache). Rank the
  comp repository by similarity to the subject.
- **16 Comp Repository sort** — add sort (date / price / SF / similarity) +
  property-type & date-range filters to the existing query filter.

### Tier 4 — Media
- **29 Image Clipboard** — add paste (Ctrl+V) + drag-and-drop to the existing
  browse-only `imgBox`.
- **30 Image Compression + Hashing** — port `photoStore.ts` (resize ≤1920px,
  JPEG 85%, SHA-256 dedup) instead of storing raw base64.

### Tier 5 — Data integrity
- **6 Validation layer** — a JS validation pass over the appraisal/comp model
  (mirrors the Zod schemas); surface a validation summary, never silently alter.
- **40 Master List Integrity** — SHA-256 of the county transfer/parcel file.

### Tier 6 — Polish
- **3 Theme System** — primary/secondary themes + dark mode via CSS variables,
  picker in the top bar, persisted to `localStorage`.
- **38 Mobile Toggle** — below the `lg` breakpoint, toggle Form/Report.

### N/A
- **39 Auto-Load County Data** — RivCo uses the rivcoview API, not a master
  parcel-list CSV. Skip unless Riverside wants CSV auto-load added.

---

## 4. Recommended port order (phases)

| Phase | Features | Why first |
|---|---|---|
| **P1** | 27, 28, 35, 36 | Data safety + robustness; small, low-risk, immediately valuable |
| **P2** | 8, 34 | Core multi-parcel workflow (largest change, do after safety net exists) |
| **P3** | 17, 16 | Comp similarity scoring + repository sort |
| **P4** | 29, 30 | Image clipboard + compression |
| **P5** | 6, 40 | Validation + integrity |
| **P6** | 3, 38 | Theme + mobile polish |

Each phase is independently shippable and verifiable (build + run + manual check).

---

## 5. Decisions needed before starting

1. **Autosave target** — SQLite (server) vs `localStorage` (client)? (Recommend
   SQLite for durability + multi-workstation, matching the existing backend.)
2. **Multi-parcel scope** — full portfolio (all parcels in memory, autosaved) or a
   lighter "recently-open tabs" model? (Recommend full portfolio for parity.)
3. **Validation** — JS-side (mirrors Zod, no backend change) or C#-side? (Recommend
   JS-side for parity + no API change.)
4. **Which phase to start with?** (Recommend P1.)


