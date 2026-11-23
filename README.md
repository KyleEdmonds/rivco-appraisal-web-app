# Appraisal Workbench

A self-hosted web app for preparing and managing commercial real estate appraisals (Riverside County). A county runs it on their own server; the assessor loads county data, works the transfer/appeal queues, completes appraisals across multiple parcels, and exports print-ready reports.

**Work in progress** — current build, shared for review. Not a production release.

## Stack

| Layer | Technology |
|---|---|
| Backend / API | **C# — .NET 10** (ASP.NET Core minimal API, Kestrel, loopback-only) |
| Persistence | **SQLite** (`Microsoft.Data.Sqlite`) — embedded, single file |
| Frontend | **Vanilla JavaScript** (ES modules) + one custom stylesheet — no framework, no build step |
| Parcel map | **Leaflet** (vendored) + Esri World Imagery tiles, composited client-side |
| Report export | Browser print (`window.print()`) — no PDF library |
| Tooling | ESLint (`npm run lint`) + `node:test` unit tests (`npm test`) |

The C# backend is the core of the app: HTTP routing, county-data parsing/validation, the Rule 2 transfer-screening batch, and all server-side persistence. The JavaScript/CSS layer is the presentation (the assessor's UI and client-side report rendering).

## Run

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

1. Clone the repo.
2. Run `start.bat` (Windows) or `dotnet run`.
3. Open http://127.0.0.1:5000.

First run creates `data/appraisal.db` (SQLite). Appraisal data is local only — not in the repo.

Client-side tooling (optional):

```
npm install
npm test        # unit tests for the pure logic in wwwroot/js/core.js
npm run lint    # ESLint
```

## Features

- **Multi-parcel workspace (open tabs)** — work on several parcels side by side; each tab is a saved appraisal (or the current unsaved one). Switching/closing a dirty tab saves it first, so no data is lost.
- 6-tab appraisal form — Cover, Subject, Sales Comparison, Income, Reconciliation, Cost (the Cost tab appears only when "Include Cost Approach" is checked)
- Live report preview (print-ready 8.5×11" sheets) with zoom + fit
- Print-ready report export (browser print, no PDF library)
- Appraisal list (APN, address, city, report date, final value)
- APN/address search with suggestions (appraisals, the full county parcel index, and Rule 2 transfer comps)
- PIN page — per-parcel characteristics, an interactive Leaflet satellite map with the parcel outline, transfer/tax history, and past in-app valuations
- Comp repository (permanent comps from finalized appraisals + read-only Rule 2 transfer comps)
- Rule 2 batch — screen the enriched commercial transfer CSV into buckets and auto-enroll qualifying transfers as read-only transfer comps
- Transfers work queues (per-bucket "to complete" lists; open a transfer as a pre-filled appraisal)
- Landing work queues — **Transfer Work Queue** (filterable `transfers_to_be_worked*` file) and **Appeal Work Queue** (filterable `appeals_to_be_done*` file); click a row to open a pre-filled appraisal. Drop a matching file into `input/` and it populates automatically — no code change needed.
- WIP autosave (debounced) + WIP export/import (lossless JSON)
- Finalize & archive (immutable snapshot, SHA-256 dedup, permanent comp)
- Tenant config (county branding)

## Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 project (excludes `storage/` and `output/` from the build) |
| `Program.cs` | Backend (API + SQLite + parcel index) |
| `Rule2.cs` | Rule 2 transfer-screening batch + its API routes |
| `Models/` | Typed C# data structures (`RivCo.Models`) — mirror the JS data model 1:1 |
| `start.bat` | Launcher (`dotnet run` + open browser) |
| `wwwroot/` | Frontend (HTML, CSS, JS, vendored Leaflet, images) |
| `wwwroot/js/core.js` | Calculations, data model, API client, state, multi-parcel workspace |
| `wwwroot/js/main.js` | Top bar, list view, multi-parcel tabs, split-pane workspace, PIN page, work queues |
| `wwwroot/js/form.js` | 6-tab appraisal form + comp repository |
| `wwwroot/js/report.js` | Report sheets + browser-print export |
| `wwwroot/js/mapimg.js` | Interactive Leaflet parcel map (PIN page) + static report map (client-side satellite compositing) |
| `test/core.test.js` | Unit tests for `core.js` (`node --test`) |
| `storage/` | Data-prep pipeline (scripts + caches) — excluded from the build |
| `input/` | County source files (parcel index, transfer lists, work-queue files) |
| `output/` | Derived transfer files for the Rule 2 batch |
| `data/appraisal.db` | SQLite database (created at first run; not in repo) |

## Data files

- `input/master_parcel_list.json` — county parcel index (APN → record + geometry); the search universe. Built weekly by `storage/build_master_json.py` (county SpatialEst CSVs + ArcGIS geometry). The app re-reads it on mtime change — no restart needed.
- `input/transfers_to_be_worked_list.csv` / `input/appeals_to_be_done*.csv` — work-queue files (latest by mtime wins).
- `output/commercial_transfers.csv` — enriched commercial transfer CSV (dev pipeline: `extractCommercial.cjs` + `fetchParcelSizes.cjs`); the Rule 2 batch input.
- `storage/parcel_photos/{apn}/` — uploaded photos; `storage/parcel_maps/` — cached satellite imagery.

## Goals / roadmap

- Validation layer over the appraisal/comp model (a JS pass mirroring the reference app's Zod schemas)
- Theme system (dark mode via `:root` variable overrides + theme picker)
- Image compression/hashing for uploaded photos (resize + SHA-256 dedup)

## Branches

- `APPRAISAL_WORKBENCH` — active development
- `STARTING_TO_USE_RIVCO_TRANSFERS` — reference snapshot
