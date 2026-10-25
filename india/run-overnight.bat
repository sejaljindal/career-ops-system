@echo off
setlocal enabledelayedexpansion

cd /d "%USERPROFILE%\jobsearch\career-ops"
if not exist output mkdir output

rem cmd.exe splits unquoted args on '=' as well as spaces, so a Task Scheduler
rem argument of "--mode=curated" arrives here as %1=--mode, %2=curated, with
rem the mode value silently dropped. Take the bare word instead and build the
rem --mode= flag ourselves, so there is no '=' in the argument to split on.
set "MODEWORD=%~1"
if "%MODEWORD%"=="" (
  for /f "tokens=1" %%D in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set "DOW=%%D"
  rem 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  if "!DOW!"=="1" set "MODEWORD=curated"
  if "!DOW!"=="3" set "MODEWORD=curated"
  if "!DOW!"=="5" set "MODEWORD=curated"
  if "!DOW!"=="2" set "MODEWORD=register-only"
  if "!DOW!"=="4" set "MODEWORD=register-only"
  if "!DOW!"=="6" set "MODEWORD=register-only"
  if "!DOW!"=="0" set "MODEWORD=register-only"
  if "!MODEWORD!"=="" set "MODEWORD=curated"
)
set "MODEARG=--mode=!MODEWORD!"

rem Optional SECOND bare word: the strategy (title ^| employer ^| both).
rem Bare words again, never --strategy=both as one argument — cmd.exe splits on
rem '=' as well as spaces, which is the bug that made --mode= arrive truncated.
set "STRATWORD=%~2"
if not "%STRATWORD%"=="" set "MODEARG=%MODEARG% --strategy=%STRATWORD%"

rem JD-fetch depth, stated EXPLICITLY rather than relying on run-daily.mjs's
rem default. The --mode bug proved these two can diverge silently: what the
rem scheduler runs is this line, not the default in the script. Capping this
rem at any fixed number (40, then 400) meant every posting outside the cap
rem stayed scored on title alone, capped below the 4.0 apply threshold no
rem matter how good the role actually was. --jd-top=all fetches every
rem posting's real JD every run — slower, but nothing is silently excluded
rem from ever reaching 4.0 on an accident of sort order.
set "MODEARG=%MODEARG% --jd-top=all"

set "LOGFILE=output\overnight-run.log"

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
echo %DATE% %TIME%  RUN FAILED: claude.exe still unusable after repair - aborting >> "%LOGFILE%"
exit /b 1
:claude_restored
echo %DATE% %TIME%  claude.exe restored successfully >> "%LOGFILE%"
:claude_ok

set "ALLOWED=Bash(npm run daily -- %MODEARG%) Bash(node run-daily.mjs %MODEARG%)"

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

echo %DATE% %TIME%  starting overnight run  %MODEARG% >> "%LOGFILE%"

rem claude.exe has failed here before with "not compatible with the version of
rem Windows you are running" (Insider build 10.0.29648). The self-heal above
rem reinstalls the SAME binary, so it cannot fix that class of failure.
rem run-daily.mjs makes no LLM call of its own - the claude wrapper only
rem supervises it - so running it directly loses the supervision and nothing
rem else, and keeps the night's run alive instead of dying silently.
call claude --version >nul 2>&1
if errorlevel 1 goto :uk_direct
call claude -p "Run the UK job pipeline for tonight's scheduled scan, unattended. Do exactly this and nothing else. 1) Run this command once: npm run daily -- %MODEARG%  2) Confirm output/daily_log.txt, output/morning_brief.md and output/pipeline.xlsx were all just written by checking they exist and their timestamps are from this run. 3) Do not modify any code, config, or profile file. Do not run any git command. Do not read, write or fetch anything outside this repository folder. Do not submit, send, or click Apply on anything, anywhere -- this pipeline only scans, scores and drafts. 4) If the command in step 1 fails, do not retry it more than once; write a line starting 'OVERNIGHT RUN FAILED:' with the error to output/daily_log.txt and stop. 5) Reply with nothing else -- no summary, no commentary, no questions. Exit when done." --allowedTools "%ALLOWED%" >> "%LOGFILE%" 2>&1
goto :uk_done
:uk_direct
echo %DATE% %TIME%  claude.exe unusable - running the pipeline directly (no LLM needed) >> "%LOGFILE%"
call npm run daily -- %MODEARG% >> "%LOGFILE%" 2>&1
:uk_done

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

echo %DATE% %TIME%  overnight run finished, exit code %ERRORLEVEL% >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"

endlocal
