@echo off
rem ===========================================================================
rem run-agent-scan-india.bat - weekly web-wide INDIA role discovery, unattended.
rem
rem See the UK repo's run-agent-scan.bat for the reasoning. Short version: the
rem nightly runs only search job boards and employers already resolved in the
rem coverage file, so the good roles - EY Delhi Transformation Delivery, PwC
rem Capital Projects, Deutsche Bank Business Management Analyst - only ever
rem appeared when research agents searched the live web. Claude Code runs
rem headless, so that can be scheduled.
rem
rem THIS IS THE INDIA PIPELINE. The prompt it runs contains no visa,
rem sponsorship or work-authorisation logic and none is to be added.
rem
rem A new report is VALIDATED before the pipeline sees it: under 20 rows with a
rem URL and it is set aside as .rejected, leaving last week's report in place.
rem Without that, one failed agent run would silently empty the send list.
rem
rem TEST IT BY HAND FIRST:  run-agent-scan-india.bat
rem ===========================================================================

setlocal
cd /d "%~dp0"
set "LOGFILE=local\agent-scan.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  India agent scan starting >> "%LOGFILE%"

for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%d"
set "REPORT=output\AGENT-SCAN-INDIA-%TODAY%.md"

call claude -p --allowedTools "Read,Write,Glob,Grep,WebSearch,WebFetch,Task" < "local\agent-scan-india.prompt.md" >> "%LOGFILE%" 2>&1

if errorlevel 1 (
  echo %DATE% %TIME%  claude exited with an error - keeping last week's report >> "%LOGFILE%"
  goto :prune
)

if not exist "%REPORT%" (
  echo %DATE% %TIME%  NO REPORT WRITTEN at %REPORT% - keeping last week's >> "%LOGFILE%"
  goto :prune
)

for /f %%c in ('powershell -NoProfile -Command "@(Get-Content '%REPORT%' ^| Select-String -Pattern '^\|.*https?://').Count"') do set "ROWS=%%c"
echo %DATE% %TIME%  report has %ROWS% row(s) with a link >> "%LOGFILE%"

if %ROWS% LSS 20 (
  move /y "%REPORT%" "%REPORT%.rejected" >nul 2>&1
  echo %DATE% %TIME%  REJECTED: fewer than 20 rows. Last week's report stands. >> "%LOGFILE%"
  goto :prune
)

echo %DATE% %TIME%  accepted %REPORT% >> "%LOGFILE%"

call node tailor-cv.mjs --from-agents=AGENT-SCAN-INDIA-%TODAY%.md --need=100 --max-checks=110 --no-liveness --skip-existing >> "%LOGFILE%" 2>&1
call node ready-to-send.mjs --need=25 --max-checks=70 > "output\READY-TO-SEND.txt" 2>&1

:prune
powershell -NoProfile -Command "Get-ChildItem 'output\AGENT-SCAN-INDIA-*.md' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force" >> "%LOGFILE%" 2>&1

echo %DATE% %TIME%  India agent scan finished >> "%LOGFILE%"
endlocal
