@echo off
setlocal

cd /d "%USERPROFILE%\jobsearch\career-ops"
if not exist output mkdir output

set "LOGFILE=output\overnight-run.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting follow-up review (no scan, no scoring) >> "%LOGFILE%"

node followup-review.mjs >> "%LOGFILE%" 2>&1

echo %DATE% %TIME%  follow-up review finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
