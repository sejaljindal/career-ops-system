# Job-search system — UK + India (career-ops, extended)

A complete, working job-search operation you can copy and run on your own machine:

- **`uk/`** — the UK pipeline (visa-sponsorship aware: sponsor register, SOC codes, eligibility gate).
- **`india/`** — the India pipeline (no visa logic; Naukri/LinkedIn paste, sector scans, GCC/consulting lists).
- **`tracker/`** — an empty Excel tracker (UK / India / Other sheets, fit score 1-5, "★ Best" per company, Sent/Closed ticks).
- **`templates/`** — master CV and cover-letter .docx (placeholders), in the house format.
- **`tools/`** — `make_variant.py` (tailor a CV/letter from the master by string-swap → Word + PDF) and `tracker_add_row.py`.
- **`CLAUDE.md`** — the standing rules that make Claude (or any coding agent) work the way the original author's did.
- **`PERSONALISE.md`** — every file that still holds the original author's story/figures, so you can replace them with yours.

Built on the open-source [career-ops](https://github.com/santifer/career-ops) (MIT). Keep its licence files.

## What you need
Node 18+ (20 recommended), Python 3.10+ with `openpyxl` and `python-docx`, LibreOffice (`soffice`) for PDFs, Git,
and an AI coding agent (Claude Code recommended; the repos also support Codex/Gemini/OpenCode via their `*.md` files).
Free API keys optional: Gemini / OpenRouter (see `.env.example` in each pipeline).

## Setup (≈30 min)
1. Clone/unzip. In **each** of `uk/` and `india/`: `npm install`, then `cp .env.example .env` and add keys (never commit `.env`).
2. Read `PERSONALISE.md`, then create **your own** `cv.md` (see `cv-example.md`), `config/profile.yml`
   (from `config/profile.example.yml`) and `portals.yml` (from `templates/portals.example.yml`).
3. Replace the placeholder text/figures listed in `PERSONALISE.md`. **Every claim on your CV must be true.**
4. `node doctor.mjs` in each pipeline until it is green.
5. Copy `tracker/Saved_Roles_TEMPLATE.xlsx` somewhere safe and rename it; make the folders
   `Applications/UK/CVs`, `Applications/UK/Cover Letters`, `Applications/India/CVs`, `Applications/India/Cover Letters`.
6. Edit `templates/MASTER_*.docx` with your details (keep Times New Roman, title and date on one line, date flush right).
7. Open the repo in Claude Code. `CLAUDE.md` loads automatically.

## Daily routine
- **UK:** `cd uk` → scan/daily runs (see `uk/CLAUDE.md`, `uk/package.json`) → shortlist → tailor → export.
- **India:** `cd india` → say "run india" / "india wide" / "india consulting" … (full table in `india/CLAUDE.md`).
- Rate each role fit 1-5; mark the best one per company `★ Best`; read the JD before tailoring.
- Tailor: `python3 tools/make_variant.py MASTER.docx Name_Company_Role_CV "old=>new"` (Word + PDF, checks page count).
- Log it: `python3 tools/tracker_add_row.py ...`; tick ☑ only after you actually submit; mark `☒ Closed` when the posting disappears.

## Rules that matter
- Never auto-submit. Passwords, account creation, captchas, equal-opportunities/diversity forms, consent boxes,
  criminal-conviction declarations, referees and the final Submit/Apply are **yours**.
- Be truthful about work authorisation. UK: if you need sponsorship, say so; skip roles that don't sponsor.
- Don't commit personal data (`.gitignore` covers it) and don't paste your keys into chats.
