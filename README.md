# RivCo Appraisal Web App

Web app for preparing and managing commercial real estate appraisals.

**Work in progress** — current build, shared for review. Not a production release.

## Run

Requires the [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0).

1. Clone the repo.
2. Run `start.bat` (Windows) or `dotnet run`.
3. Open http://localhost:5000.

First run creates `data/appraisal.db` (SQLite). No data ships with the repo.

## Features

- Appraisal entry (property, building, land)
- Appraisal list (APN, address, city, report date, final value)
- Permanent comps from finalized appraisals
- PDF report export

## Structure

| Path | Purpose |
|------|---------|
| `AppraisalWeb.csproj` | .NET 9 project |
| `Program.cs` | Backend (API + SQLite) |
| `start.bat` | Launcher |
| `wwwroot/` | Frontend (HTML, CSS, JS, PDF libs, images) |

## Notes

- Data is local only (`data/appraisal.db`), not in the repo.
- No external network calls.
- `main` = active, `STARTING_POINT_ROUGH` = reference snapshot.
