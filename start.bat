@echo off
rem RivCo Appraisal Web App - start server + open browser
cd /d "%~dp0"

rem Open the browser a few seconds after the server starts
start "" /b cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:5000"

dotnet run --project AppraisalWeb.csproj
pause