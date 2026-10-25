@AGENTS.md

<!-- Add Claude Code-specific guidance here only when it has no AGENTS.md counterpart. -->

---

# THIS IS THE INDIA PIPELINE

No visa logic, no SOC codes, no sponsorship. This candidate is an Indian
citizen with full right to work — nothing in this project should ever
mention sponsorship, visa status, or occupation codes.

**The UK pipeline lives at `%USERPROFILE%\jobsearch\career-ops` and must
never be run from here.** If a request sounds UK-specific (sponsorship,
Skilled Worker route, relocation), stop and check — it belongs in the other
directory, not this one.

## WORKFLOW COMMANDS

Plain-English phrases the user may type, mapped to the npm script that
should actually run. When one of these phrases (or something close to it)
appears, run the mapped command directly rather than asking which mode they
mean.

| User says | Runs |
|---|---|
| "run india" / "india today" | `npm run india` |
| "india wide" / "scan the boards" | `npm run india-wide` |
| "india boards" | `npm run india-boards` |
| "india consulting" / "the big 4" | `npm run india-consulting` |
| "india strategy" | `npm run india-strategy` |
| "india infra" | `npm run india-infra` |
| "india tech" | `npm run india-tech` |
| "india finance" | `npm run india-finance` |
| "gcc" | `npm run india-gcc` |
| "india startups" | `npm run india-startups` |
| "india top" / "tier 0" | `npm run india-top` |
| "here are naukri results" (+ pasted text/link) | `npm run paste` |
| "where am i up to" / "coverage" | `npm run coverage` |

**Note on "india finance" vs "gcc":** these are two different sectors in
`india_targets.csv` — `india-finance` scans **"Financial Services / GCC"**
(banks, asset managers, trading firms), `india-gcc` scans **"Global
Capability Centre"** (the captive GCC arms of non-financial multinationals —
Shell, Novartis, Maersk, etc.). Don't conflate them; if the user says
"finance," they mean the finance-sector scan, not the GCC-sector scan.

### What each command does

- `india` / `india-*` (sector/tier-scoped) all run `run-daily.mjs` — scans
  the priority-list batch (oldest-scanned-first), updates
  `output/coverage_india.csv`, exports `output/pipeline_india.xlsx`, prepares
  the next 10 tailor bundles, and prints/writes
  `output/daily_log_india.txt`. None of these score new postings by
  default — scoring (`--eval`) is a separate, explicit, cost-incurring step;
  ask before adding it to one of these runs.
- `paste` runs `paste-jobs.mjs` — pass it whatever Naukri (or other manual)
  listing text/links the user just gave you.
- `coverage` prints the coverage report only — no scanning, no cost.

### Full script reference

| npm script | Command | Scope |
|---|---|---|
| `india` | `run-daily.mjs --max=412` | All employers, oldest-scanned-first |
| `india-consulting` | `run-daily.mjs --sector="Consulting / Advisory"` | Big 4 + advisory firms |
| `india-strategy` | `run-daily.mjs --sector="Strategy Consulting"` | McKinsey/BCG/Bain-tier |
| `india-infra` | `run-daily.mjs --sector="Infrastructure / Capital Projects"` | Capital-projects/infra majors |
| `india-tech` | `run-daily.mjs --sector="Global Tech"` | Global tech companies' India sites |
| `india-finance` | `run-daily.mjs --sector="Financial Services / GCC"` | Banks, asset managers, trading firms |
| `india-gcc` | `run-daily.mjs --sector="Global Capability Centre"` | Captive GCCs of non-financial multinationals |
| `india-startups` | `run-daily.mjs --sector="Startups / Unicorns"` | Indian startups/unicorns |
| `india-top` | `run-daily.mjs --tier=0` | Tier-0 employers only, any sector |
| `paste` | `paste-jobs.mjs` | Manual intake (Naukri, LinkedIn, etc.) |
| `coverage` | `coverage.mjs --report` | Status report only, no scanning |
| `daily` | `run-daily.mjs` | Same as `india` but respects `--max` default (50), not the full list |
| `export` | `export-excel.mjs` | Rebuild `pipeline_india.xlsx` from current reports |
| `tailor` | `auto-tailor.mjs` | CV/cover-letter tailoring (select/render — see the script's own header) |

**Sector labels are copied verbatim from `india_targets.csv`'s own `Sector`
column** (verified against the live file when these aliases were created —
2026-08-14). If a sector-scoped command returns 0 rows unexpectedly, check
whether the label has drifted from what's actually in the CSV before
assuming the alias is broken.
## Application file standard (set by the candidate, 15 Oct 2026)
- Every CV and cover letter / supporting statement must exist as BOTH Word (.docx, editable) and PDF (to attach).
- File names start with her name: `FirstName_LastName_<Company>_<Role>_CV` / `_Cover-Letter` / `_Supporting-Statement` (underscores between parts, hyphens inside words, no spaces, no "final/draft/v2").
- After generating any CV or letter, run `python3 export-applications.py UK|India` (writes to `Applications/<Region>/CVs` and `Cover Letters`).
- CV layout: Times New Roman; title and date on one line with the date flush at the extreme right margin; courses show title only (no "Core skills" lines).
