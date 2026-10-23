# RivCo Appraisal Web App

A self-hosted web app for preparing and managing commercial real estate appraisals. A county runs it on their own server; the assessor loads county data, reviews and completes appraisals, and exports print-ready reports.

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

- Appraisal entry (property, building, land)
- Appraisal list (APN, address, city, report date, final value)
- Permanent comps from finalized appraisals
- Rule 2 batch: screen a county transfer file into buckets and auto-enroll qualifying transfers as read-only transfer comps
- PDF report export

## Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 10 project |
| `Program.cs` | Backend (API + SQLite) |
| `Rule2.cs` | Rule 2 transfer-screening batch |
| `start.bat` | Launcher |
| `wwwroot/` | Frontend (HTML, CSS, JS, PDF libs, images) |

## Notes

- Data is local only (`data/appraisal.db`), not in the repo.
- No external network calls.
- `main` = active, `STARTING_POINT_ROUGH` = reference snapshot.
