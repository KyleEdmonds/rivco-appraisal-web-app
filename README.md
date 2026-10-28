# Appraisal Workbench

A self-hosted web app for preparing and managing commercial real estate appraisals, built to functional parity with the `appraisal_workflows` reference app. A county runs it on their own server; the assessor loads county data, reviews and completes appraisals across multiple parcels, and exports print-ready reports.

**Work in progress** — current build, shared for review. Not a production release.

## Stack

| Layer | Technology |
|---|---|
| Backend / API | **C# — .NET 10** (ASP.NET Core minimal API) |
| Persistence | **SQLite** (`Microsoft.Data.Sqlite`) — embedded, single-file |
| Frontend | **Vanilla JavaScript** (ES modules) + CSS — no framework, no build step |
| Report export | jsPDF + html2canvas (client-side PDF) |

The C# backend is the core of the app: HTTP routing, county-data parsing/validation, the Rule 2 transfer-screening logic, and all server-side persistence. The JavaScript/CSS layer is the presentation (the assessor's UI and client-side report rendering).

## Run

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

1. Clone the repo.
2. Run `start.bat` (Windows) or `dotnet run`.
3. Open http://localhost:5000.

First run creates `data/appraisal.db` (SQLite). No data ships with the repo.

## Features

- **Multi-parcel workspace (open tabs)** — work on several parcels side by side; each tab is a saved appraisal (or the current unsaved one). Switching/closing a dirty tab saves it first, so no data is lost.
- 5-tab appraisal form — Subject, Sales Comparison, Income, Cost, Reconciliation
- Live report preview (print-ready 8.5×11" sheets) with zoom + fit
- PDF report export (client-side)
- Appraisal list (APN, address, city, report date, final value)
- APN/address search with suggestions (appraisals + transfer comps)
- Comp repository (permanent comps from finalized appraisals + read-only transfer comps)
- Rule 2 batch: screen a county transfer file into buckets and auto-enroll qualifying transfers as read-only transfer comps
- Transfers work queues (per-bucket "to complete" lists; open a transfer as a pre-filled appraisal)
- Landing work queues — **Transfer Work Queue** (filterable `transfers_to_be_done` file) and **Appeal Work Queue** (filterable `appeals_to_be_done` file); click a row to open a pre-filled appraisal
- WIP autosave (debounced) + WIP export/import (lossless JSON)
- Finalize & archive (immutable snapshot, SHA-256 dedup, permanent comp)
- Tenant config (county branding)

## Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 project |
| `Program.cs` | Backend (API + SQLite) |
| `Rule2.cs` | Rule 2 transfer-screening batch |
| `start.bat` | Launcher |
| `wwwroot/` | Frontend (HTML, CSS, JS, PDF libs, images) |
| `wwwroot/js/core.js` | Calculations, data model, API client, state, multi-parcel workspace |
| `wwwroot/js/main.js` | Top bar, list view, multi-parcel tabs, split-pane appraisal view |
| `wwwroot/js/form.js` | 5-tab appraisal form |
| `wwwroot/js/report.js` | Report sheets + PDF export |

## Notes

- Data is local only (`data/appraisal.db`), not in the repo.
- No external network calls.
- `main` = active, `STARTING_POINT_ROUGH` = reference snapshot.

## Remaining gaps vs. `appraisal_workflows` (roadmap)

- Comp similarity scoring (rank the comp repository by similarity to the subject)
- Validation layer (a JS pass over the appraisal/comp model, mirroring the Zod schemas)
- Theme system (primary/secondary themes + dark mode via CSS variables)
- Image clipboard (paste/drag-drop) + image compression/hashing

## Future goals

- **Appeal Work Queue** — the landing page already ships an "Appeal Work Queue" card
  that reads `input/appeals_to_be_done*.xlsx/.csv` and renders the same filterable table as
  the Transfer Work Queue (click a row to open a pre-filled appeal appraisal). It
  currently shows an empty state because no appeals file exists yet. Once an
  `appeals_to_be_done` file is dropped into `input/`, it populates automatically —
  no code change needed.
