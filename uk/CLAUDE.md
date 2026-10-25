@AGENTS.md

<!-- Add Claude Code-specific guidance here only when it has no AGENTS.md counterpart. -->

## Application file standard (set by the candidate, 15 Oct 2026)
- Every CV and cover letter / supporting statement must exist as BOTH Word (.docx, editable) and PDF (to attach).
- File names start with her name: `FirstName_LastName_<Company>_<Role>_CV` / `_Cover-Letter` / `_Supporting-Statement` (underscores between parts, hyphens inside words, no spaces, no "final/draft/v2").
- After generating any CV or letter, run `python3 export-applications.py UK|India` (writes to `Applications/<Region>/CVs` and `Cover Letters`).
- CV layout: Times New Roman; title and date on one line with the date flush at the extreme right margin; courses show title only (no "Core skills" lines).
