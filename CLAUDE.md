# Standing instructions (applies to the whole repo)

Work in the pipeline folder the request belongs to (`uk/` or `india/`). Never run UK-only logic (sponsorship, SOC, visa)
in `india/`. Read each pipeline's own `CLAUDE.md` / `AGENTS.md` first.

## Output standard
- Every CV, cover letter and supporting statement is delivered as BOTH Word (.docx) and PDF.
- File names: `FirstName_LastName_<Company>_<Role>_CV` / `_Cover-Letter` / `_Supporting-Statement`; underscores between parts,
  hyphens inside words, no spaces, never "final", "draft" or "v2".
- CV layout: Times New Roman; job title and dates on one line with the date flush to the right margin; courses/certificates
  show the title only (no skills lines). Target 2 pages for a CV, 1 for a letter. Use the full word allowance on statement boxes.
- Save into `Applications/<UK|India>/CVs` and `.../Cover Letters`. `python3 export-applications.py UK|India` does the copy+rename+PDF.

## Working method
1. Read the job description before tailoring. Rate fit 1-5. Mark one `★ Best` role per company in the tracker.
2. Skip roles that can't sponsor (UK) or fail the eligibility gate. Answer sponsorship questions truthfully.
3. Fill applications as far as you can, log what needs the human, and keep going — then give ONE summary and ask for a
   batch "submit these" yes. Never submit without it.
4. Leave to the human: passwords, account creation, captchas, diversity/equal-opportunities, consent items,
   criminal-conviction declarations, referees, and the final Apply/Submit.
5. Never overwrite a value the human typed into a form or a tracker cell.
6. Keep the tracker current: ☑ = sent, ☒ Closed = posting gone; note what is blocked or unread instead of guessing.
7. Never invent experience or figures; every claim must trace to `cv.md`.

## Browser notes
Prefer batched browser actions; sleeping tabs often fail the first read — reload and retry; never click every button on a
page (only the specific accordion/field you need); some sites block automation — log them as "not read" and ask for the JD text.
