@echo off
setlocal

rem ============================================================
rem  India pipeline — follow-up cadence review.
rem  Runs Wednesday and Saturday at 07:00. Built 2026-09-04.
rem
rem  NO scanning, NO scoring, NO JD fetches, NO new evaluations.
rem  Tracker reading only, so it is cheap enough to run every few
rem  days without touching scan-night budget. Deterministic node,
rem  never claude -p — it cannot consume usage.
rem
rem  Uses followup-review.mjs, which reads output/pipeline_india.xlsx
rem  directly — its "Status" and "Applied On" columns, where the
rem  application data actually lives.
rem
rem  DEFECT FIXED 2026-09-04: this originally called
rem  followup-cadence.mjs, which reads data/applications.md +
rem  data/follow-ups.md. Neither file exists in this repo, and neither
rem  is where status is recorded — so the Wed/Sat run would have kept
rem  reporting "no applications" no matter how carefully applications
rem  were logged in the spreadsheet. followup-review.mjs was written
rem  to read the real source.
rem
rem  TO LOG AN APPLICATION so this can see it: open
rem  output/pipeline_india.xlsx, set Status to "Applied", and put the
rem  date in "Applied On" (YYYY-MM-DD). There is no separate tracker
rem  file to maintain.
rem
rem  Output: output/followups_india.md (overwritten each run).
rem ============================================================

cd /d "%USERPROFILE%\jobsearch-india\career-ops"
if not exist output mkdir output

set "LOGFILE=output\followup-india.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting India follow-up review (no scan, no scoring) >> "%LOGFILE%"

node followup-review.mjs >> "%LOGFILE%" 2>&1

echo %DATE% %TIME%  India follow-up review finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
