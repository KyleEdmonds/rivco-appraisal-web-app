# RivCo Appraisal Web App

A local web application for preparing and managing commercial real estate appraisals.

> **Work in progress.** This repository holds the current build of the appraisal tool as it is being developed. It is shared for review — it is not a production release, and the code will change as development continues.

## What it is

A self-contained, local-first **Appraisal Workbench**. It runs entirely on your machine — no cloud, no external services — and stores appraisal data in a local SQLite database.

- **Appraisal entry** — structured forms for property, building, and land details.
- **Appraisal list** — all appraisals with summary fields (APN, address, city, report date, final value).
- **Permanent comps** — finalized appraisals are captured as permanent comparable records for reuse in future appraisals.
- **PDF reports** — appraisal reports can be generated and exported as PDF.

## Running the app

**Prerequisite:** the [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) must be installed.

1. Clone this repository.
2. Run `start.bat` (Windows). This starts the server and opens your browser automatically.
   - Alternatively, run `dotnet run` from the project root.
3. Use the app at **http://localhost:5000**.

On first run the app creates a local database at `data/appraisal.db`. No data ships with the repository — the database starts empty and fills in as you work.

## Project structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 9 web project definition |
| `Program.cs` | Backend — REST API and SQLite data store |
| `start.bat` | Windows launcher (starts server, opens browser) |
| `wwwroot/index.html` | Frontend entry point |
| `wwwroot/css/app.css` | Styling |
| `wwwroot/js/` | UI logic (main, form, report, core) |
| `wwwroot/lib/` | Bundled PDF libraries (jsPDF, html2canvas) |
| `wwwroot/img/` | County seal assets |

## Data & privacy

- All data is stored locally in `data/appraisal.db` (SQLite).
- The database is **not** part of this repository — it is created at runtime and stays on the machine running the app.
- The app makes no external network calls; everything is local.

## Branches

- `main` — active development.
- `STARTING_POINT_ROUGH` — an earlier snapshot of the tool, kept as a reference point.
