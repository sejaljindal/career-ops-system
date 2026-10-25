@echo off
setlocal

rem ============================================================
rem  India pipeline — unattended overnight run.
rem  Adapted 2026-09-04 from the UK repo's run-overnight.bat.
rem  This repo had NO automation of any kind before that date;
rem  every India run was manual.
rem
rem  Register in Windows Task Scheduler pointing at THIS file.
rem  Optional first argument = sector, as a BARE WORD (see below).
rem ============================================================

cd /d "%USERPROFILE%\jobsearch-india\career-ops"
if not exist output mkdir output

rem cmd.exe splits unquoted arguments on '=' as well as on spaces, so a Task
rem Scheduler argument of "--sector=consulting" arrives as %1=--sector and
rem %2=consulting, silently dropping the value. This bit the UK pipeline for
rem real. Take a bare word instead and build the npm script name ourselves.
rem
rem   (no argument)  -> npm run india              (all 412 employers)
rem   consulting     -> npm run india-consulting
rem   strategy       -> npm run india-strategy
rem   infra          -> npm run india-infra
rem   tech           -> npm run india-tech
rem   finance        -> npm run india-finance
rem   gcc            -> npm run india-gcc
rem   startups       -> npm run india-startups
rem   top            -> npm run india-top
set "SECTORWORD=%~1"
if "%SECTORWORD%"=="" (set "NPMSCRIPT=india-full") else (set "NPMSCRIPT=india-%SECTORWORD%")

set "LOGFILE=output\overnight-run-india.log"

rem CALL IS MANDATORY on every `claude` line below. `claude` resolves to
rem claude.cmd, a batch shim, and a .bat that invokes another .bat WITHOUT
rem `call` transfers control and never comes back - the rest of this script
rem simply never runs, silently, with exit code 0. That is exactly what
rem happened on 2026-09-06: the guard killed the script at its first line
rem and nothing reached the log. The pre-existing `claude -p` line had the
rem same defect, which is why older runs logged "starting" but never
rem "finished, exit code".
rem -- claude.exe preflight / self-heal --------------------------------------
rem The global npm install's background auto-updater has repeatedly left
rem bin\claude.exe as a ~500-byte stub while recording the update as a success.
rem Every later invocation then dies with "not a valid application for this OS
rem platform". Observed four times across 2026-09-05/06.
rem
rem ROOT CAUSE: npm was BLOCKING the package's postinstall - the step that
rem downloads the native binary - so npm exited 0 with no binary fetched. The
rem durable machine-level fix is:
rem   npm config set allow-scripts=@anthropic-ai/claude-code --location=user
rem The --allow-scripts flag below makes the repair work even without it.
rem
rem SYNTAX WARNING, learned the hard way on 2026-09-06: cmd.exe parses rem
rem lines INSIDE a parenthesised if-block and still honours parentheses in
rem them. An earlier version of this guard had explanatory comments containing
rem round brackets inside the block; they closed the block early, the whole
rem script failed to parse, and it exited silently without writing one line to
rem the log. Keep every comment ABOVE the block, and keep the block body free
rem of round brackets entirely.
set "CLAUDE_PKG=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code"
set "CLAUDE_PKGARG=@anthropic-ai/claude-code"
call claude --version >nul 2>&1
if not errorlevel 1 goto :claude_ok
echo %DATE% %TIME%  claude.exe unusable - attempting repair >> "%LOGFILE%"
if exist "%CLAUDE_PKG%\install.cjs" node "%CLAUDE_PKG%\install.cjs" >> "%LOGFILE%" 2>&1
call claude --version >nul 2>&1
if not errorlevel 1 goto :claude_restored
echo %DATE% %TIME%  install.cjs did not help - trying npm global reinstall >> "%LOGFILE%"
call npm install -g --allow-scripts=%CLAUDE_PKGARG% %CLAUDE_PKGARG%@latest >> "%LOGFILE%" 2>&1
call claude --version >nul 2>&1
if not errorlevel 1 goto :claude_restored
echo %DATE% %TIME%  claude.exe still unusable after repair - continuing without it >> "%LOGFILE%"
rem Was `exit /b 1`. Aborting here killed the whole night including the
rem board scan above, which needs no LLM at all. Now it falls through.
:claude_restored
echo %DATE% %TIME%  claude.exe restored successfully >> "%LOGFILE%"
:claude_ok

set "ALLOWED=Bash(npm run %NPMSCRIPT%)"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
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

echo %DATE% %TIME%  starting India overnight run  npm run %NPMSCRIPT% >> "%LOGFILE%"

rem claude.exe has failed here before with "not compatible with the version of
rem Windows you are running" (Insider build 10.0.29648). The self-heal above
rem reinstalls the SAME binary, so it cannot fix that class of failure.
rem run-daily.mjs makes no LLM call of its own - the claude wrapper only
rem supervises it - so running it directly loses the supervision and nothing
rem else, and keeps the night's run alive instead of dying silently.
call claude --version >nul 2>&1
if errorlevel 1 goto :in_direct
call claude -p "Run the India job pipeline for tonight's scheduled scan, unattended. Do exactly this and nothing else. 1) Run this command once: npm run %NPMSCRIPT%  2) Confirm output/daily_log_india.txt, output/coverage_india.csv and output/pipeline_india.xlsx were all just written by checking they exist and their timestamps are from this run. 3) Do not modify any code, config, or profile file. Do not run any git command. Do not read, write or fetch anything outside this repository folder. Do not submit, send, or click Apply on anything, anywhere -- this pipeline only scans, scores and drafts. 4) This is the INDIA pipeline: never apply UK visa, sponsorship, SOC-code or Skilled Worker logic, and never write those words into any output. The candidate has full right to work in India. 5) If the command in step 1 fails, do not retry it more than once; write a line starting 'OVERNIGHT RUN FAILED:' with the error to output/daily_log_india.txt and stop. 6) Reply with nothing else -- no summary, no commentary, no questions. Exit when done." --allowedTools "%ALLOWED%" >> "%LOGFILE%" 2>&1
goto :in_done
:in_direct
echo %DATE% %TIME%  claude.exe unusable - running the pipeline directly (no LLM needed) >> "%LOGFILE%"
call npm run %NPMSCRIPT% >> "%LOGFILE%" 2>&1
:in_done

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

echo %DATE% %TIME%  writing the full live-roles list (output\all-live-roles-full-list.md) >> "%LOGFILE%"
rem Added 2026-09-25 (Task B). Unlike READY-TO-SEND.txt above (top 20, walked
rem until enough live ones are found), this is every eligible live row,
rem grouped by priority tier, whether or not a CV/cover exists yet — the
rem complete morning snapshot rather than a shortlist.
call node ready-to-send.mjs --full-list >> "%LOGFILE%" 2>&1
echo %DATE% %TIME%  full live-roles list written, exit code %ERRORLEVEL% >> "%LOGFILE%"

echo %DATE% %TIME%  India overnight run finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
