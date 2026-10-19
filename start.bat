@echo off
rem RivCo Appraisal Web App - start server + open browser
cd /d "%~dp0"

rem Open the browser a few seconds after the server starts.
rem Uses 127.0.0.1 (not localhost) so corporate proxy settings don't intercept it.
start "" /b cmd /c "timeout /t 6 /nobreak >nul && start http://127.0.0.1:5000"

dotnet run --project AppraisalWeb.csproj
pause