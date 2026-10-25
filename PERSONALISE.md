# PERSONALISE.md — everything that still contains the original author's career story

The code is generic, but the CV/letter *wording* generators were written around one person's history.
Placeholders you must replace with your own facts (search the repo for each token):

| Token | Meaning |
|---|---|
| `EMPLOYER_ONE` / `EMPLOYER_TWO` | your most recent / previous employer |
| `PROJECT_ONE` | a named project you delivered |
| `YOUR_UNIVERSITY`, `YOUR_MSc` | your university / degree |
| `YOUR_CITY` | where you are based |
| `FirstName_LastName`, `FirstName-LastName` | your name in file names |

**Also replace the figures** (e.g. £83.6M, £100K, 97%, 20%, 30%) in the same files — they are the original author's real achievements and must never be reused as yours. Every number on your CV must be true and provable (the pipeline has `verify-cv-facts.mjs` to enforce this against your own cv.md).

## Files to edit (both pipelines)

- india/06_Role_Taxonomy.md
- india/AUDIT-row19-quality-review.md
- india/CLAUDE.md
- india/auto-tailor.mjs
- india/base-cv.mjs
- india/bullet-variants.data.mjs
- india/cover-letters.data.mjs
- india/eligibility.mjs
- india/experience-gate.mjs
- india/export-applications.py
- india/export-excel.mjs
- india/jd-keywords.mjs
- india/queue-docs.mjs
- india/tailor-cv-forced.mjs
- india/tailor-cv.mjs
- india/tailor-gs.mjs
- india/tailor-queue.mjs
- tools/make_variant.py
- uk/06_Role_Taxonomy.md
- uk/08_SOC_Codes_and_Visa_Routes.md
- uk/CLAUDE.md
- uk/aggregator-scan.mjs
- uk/audit-cvs.mjs
- uk/auto-tailor.mjs
- uk/base-cv.mjs
- uk/bullet-variants.data.mjs
- uk/eligibility.mjs
- uk/experience-gate.mjs
- uk/export-applications.py
- uk/export-excel.mjs
- uk/jd-keywords.mjs
- uk/jd-veto.mjs
- uk/outreach.mjs
- uk/package-applications.py
- uk/run-daily.mjs
- uk/tailor-cv-forced.mjs
- uk/tailor-cv.mjs
- uk/tailor-gs.mjs

## Then
1. Copy `config/profile.example.yml` → `config/profile.yml` and fill it in (UK and India separately).
2. Write your own `cv.md` (see `cv-example.md`).
3. Edit `bullet-variants.data.mjs` and `cover-letters.data.mjs` with your bullets.
4. Run `node doctor.mjs` in each pipeline folder.
- `PROJECT_TWO`, `PROJECT_THREE`, `CLIENT_ONE` — more project / client names
