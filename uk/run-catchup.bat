@echo off
setlocal

cd /d "%USERPROFILE%\jobsearch\career-ops"
if not exist output mkdir output

set "LOGFILE=output\overnight-run.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting 07:00 catch-up pass >> "%LOGFILE%"

rem Deterministic node, not claude -p: the catch-up makes no judgement calls,
rem it reads state and re-runs the same scripts the 02:00 run uses. Nothing
rem here needs an LLM, so nothing here can hit a usage limit.
echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting board scan (node scan.mjs - job_boards incl. Adzuna) >> "%LOGFILE%"
rem Added 2026-09-09. Deterministic and FREE: scan.mjs makes no LLM call.
rem It reads portals.yml's job_boards section - Adzuna, Remotive, Himalayas
rem and the rest - which run-daily.mjs does NOT touch. Until now that entire
rem half of discovery only ran when the command was typed by hand, so every
rem scheduled night missed it. Placed BEFORE the pipeline run so anything
rem found is scored the same night instead of waiting for the next one.
call node scan.mjs >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  board scan finished, exit code %ERRORLEVEL% >> "%LOGFILE%"

node catchup.mjs >> "%LOGFILE%" 2>&1

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting tailoring (tailor-cv.mjs) >> "%LOGFILE%"
rem Added 2026-09-10. Deterministic and FREE — no LLM call.
rem
rem This is the step whose absence made every morning a manual scramble: the
rem overnight run scored roles but produced no documents, so nothing could be
rem sent until a tailoring pass was kicked off by hand and waited on.
rem
rem tailor-cv.mjs fetches each posting's real job description, matches it
rem against the curated evidence table in jd-keywords.mjs, and writes a CV
rem whose headline, summary, bullet labels, bullet order and skills section are
rem all specific to that role. It checks liveness first, so a closed posting
rem never consumes a slot. Every figure is audited back to cv.md on each run.
call node tailor-cv.mjs --need=25 --max-checks=45 >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  tailoring finished, exit code %ERRORLEVEL% >> "%LOGFILE%"

echo %DATE% %TIME%  writing the morning send list >> "%LOGFILE%"
rem The file to open first thing: live roles only, with the exact filenames of
rem the CV and cover letter already on disk for each.
call node ready-to-send.mjs --need=20 --max-checks=60 > "output\READY-TO-SEND.txt" 2>&1
echo %DATE% %TIME%  send list written to output\READY-TO-SEND.txt >> "%LOGFILE%"

echo %DATE% %TIME%  catch-up finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
