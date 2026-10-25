@echo off
setlocal

rem ============================================================
rem  India pipeline — morning coverage report.
rem  Adapted 2026-09-04 from the UK repo's run-catchup.bat.
rem
rem  Deterministic node, NOT claude -p: this makes no judgement
rem  calls, it just reads current state and prints a report.
rem  Nothing here needs an LLM, so nothing here can hit a usage
rem  limit or cost anything. Safe to schedule daily.
rem
rem  NOTE: the UK repo's equivalent runs catchup.mjs, which does
rem  not exist in this repo. `npm run coverage` = coverage.mjs
rem  --report is the closest real India equivalent: read-only,
rem  writes nothing, scans nothing.
rem ============================================================

cd /d "%USERPROFILE%\jobsearch-india\career-ops"
if not exist output mkdir output

set "LOGFILE=output\overnight-run-india.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting India coverage report (read-only, no scan) >> "%LOGFILE%"

node coverage.mjs --report >> "%LOGFILE%" 2>&1

echo %DATE% %TIME%  India coverage report finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
