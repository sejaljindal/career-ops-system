@echo off
setlocal

rem ============================================================
rem  India pipeline — 07:00 completion pass.
rem  Runs on Monday and Thursday mornings, after the 02:00 scan.
rem  Built 2026-09-04.
rem
rem  Its job is to FINISH what the 02:00 run started, not to start
rem  anything new. If the scan night completed everything, this
rem  exits having changed nothing. That is the normal case and is
rem  not a failure.
rem
rem  DETERMINISTIC node, NOT claude -p — on purpose. Nothing here
rem  makes a judgement call, so nothing here needs an LLM, so
rem  nothing here can hit a usage limit or cost anything. This is
rem  the whole point of a completion pass: the 02:00 run is the
rem  one that can run out of budget, and this one never can.
rem
rem  WHY THIS RESUMES RATHER THAN RESTARTS (mechanism, not a promise):
rem   - Scanning: run-daily.mjs walks employers oldest-scanned-first.
rem     An employer scanned at 02:00 has a fresh timestamp and sinks
rem     to the back of the queue; one the 02:00 run never reached
rem     keeps its old timestamp and stays at the front. There is no
rem     cursor to reset — resuming is just re-running.
rem   - Tailoring: auto-tailor.mjs --select only picks rows scoring
rem     >= SCORE_FLOOR that do not already have a bundle, so rows
rem     already handled are skipped rather than redone.
rem ============================================================

cd /d "%USERPROFILE%\jobsearch-india\career-ops"
if not exist output mkdir output

set "SECTORWORD=%~1"
if "%SECTORWORD%"=="" (set "NPMSCRIPT=india") else (set "NPMSCRIPT=india-%SECTORWORD%")

set "LOGFILE=output\overnight-run-india.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo %DATE% %TIME%  starting India 07:00 catch-up pass (npm run %NPMSCRIPT%) >> "%LOGFILE%"

rem 1) Finish the scan. Oldest-scanned-first ordering makes this resume.
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

call npm run %NPMSCRIPT% >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  catch-up scan step exit code %ERRORLEVEL% >> "%LOGFILE%"

rem 2) Prepare tailor bundles for anything newly scoring 4.0+.
rem    Already-bundled rows are skipped, so this is safe to repeat.
node auto-tailor.mjs --select >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  catch-up tailor-select step exit code %ERRORLEVEL% >> "%LOGFILE%"

rem 3) Coverage report so the log shows where the cycle actually got to.
node coverage.mjs --report >> "%LOGFILE%" 2>&1

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

rem Second pass over the SCORED workbook, not the Pending queue.
rem India keeps two lists: data/pipeline.md holds everything discovered, while
rem output/pipeline_india.xlsx holds the scored rows that ready-to-send.mjs
rem actually offers each morning. The first pass above only covers the queue,
rem so on 12/09 the send list was still handing over auto-tailor PDFs from
rem 14/08 - no per-JD rewording on any of them. This pass closes that gap
rem every run instead of needing a manual command.
call node tailor-cv.mjs --from=xlsx --need=20 --max-checks=40 >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  tailoring finished, exit code %ERRORLEVEL% >> "%LOGFILE%"

echo %DATE% %TIME%  writing the morning send list >> "%LOGFILE%"
rem The file to open first thing: live roles only, with the exact filenames of
rem the CV and cover letter already on disk for each.
call node ready-to-send.mjs --need=20 --max-checks=60 > "output\READY-TO-SEND.txt" 2>&1
echo %DATE% %TIME%  send list written to output\READY-TO-SEND.txt >> "%LOGFILE%"

echo %DATE% %TIME%  India catch-up finished >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
