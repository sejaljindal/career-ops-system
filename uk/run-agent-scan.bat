@echo off
rem ===========================================================================
rem run-agent-scan.bat - weekly web-wide UK role discovery, unattended.
rem
rem WHY THIS EXISTS
rem   The nightly runs only search job boards and the ~148 employers that have
rem   a resolved ATS endpoint in coverage.csv. That is why the send list came
rem   back 25-for-25 Reed on 12/09, on which Reed greys out Apply based on her
rem   profile. The 100+ usable roles found that day all came from research
rem   agents searching the live web, which scan.mjs cannot do.
rem
rem   Claude Code runs headless, so a scheduled task CAN do it. This is that.
rem
rem WHAT IT DOES
rem   1. Runs Claude Code with local\agent-scan-uk.prompt.md.
rem   2. VALIDATES the report it produced before letting it near the pipeline.
rem   3. Prunes reports older than 30 days.
rem
rem   Step 2 matters. A failed or truncated agent run would otherwise leave a
rem   near-empty report that ready-to-send.mjs reads as gospel, quietly
rem   shrinking the send list with no error anywhere. If the new report has
rem   fewer than 20 rows carrying a URL, it is moved aside as .rejected and
rem   last week's report stays in place.
rem
rem TEST IT BY HAND FIRST:  run-agent-scan.bat
rem Only schedule it once you have seen it produce a good report.
rem ===========================================================================

setlocal
cd /d "%~dp0"
set "LOGFILE=local\agent-scan.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  UK agent scan starting >> "%LOGFILE%"

rem --- date as YYYY-MM-DD, locale-independent -----------------------------
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%d"
set "REPORT=output\AGENT-SCAN-UK-%TODAY%.md"

rem --- run the agent ------------------------------------------------------
rem --allowedTools keeps it to research and writing. It cannot run shell
rem commands, so a bad run can waste time but cannot damage the repo.
call claude -p --allowedTools "Read,Write,Glob,Grep,WebSearch,WebFetch,Task" < "local\agent-scan-uk.prompt.md" >> "%LOGFILE%" 2>&1

if errorlevel 1 (
  echo %DATE% %TIME%  claude exited with an error - keeping last week's report >> "%LOGFILE%"
  goto :prune
)

rem --- validate -----------------------------------------------------------
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

rem --- tailor CVs for whatever is new, through the eligibility gate --------
call node tailor-cv.mjs --from-agents=AGENT-SCAN-UK-%TODAY%.md --need=120 --max-checks=130 --no-liveness --skip-existing >> "%LOGFILE%" 2>&1

rem --- rebuild the send list ---------------------------------------------
call node ready-to-send.mjs --need=25 --max-checks=70 > "output\READY-TO-SEND.txt" 2>&1

:prune
rem Reports older than 30 days are deleted. ready-to-send.mjs reads EVERY
rem AGENT-SCAN-*.md in output/, so without this the list slowly fills with
rem postings that closed weeks ago. The liveness check catches them, but it
rem costs an HTTP request each, every run.
powershell -NoProfile -Command "Get-ChildItem 'output\AGENT-SCAN-UK-*.md' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force" >> "%LOGFILE%" 2>&1

echo %DATE% %TIME%  UK agent scan finished >> "%LOGFILE%"
endlocal
