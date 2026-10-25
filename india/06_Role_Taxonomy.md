# Role Taxonomy — India

**Rewritten 2026-08-31.** The previous version of this file was the UK-market taxonomy,
copied wholesale into this repo and never adapted — it instructed searching "visa
sponsored jobs uk," referenced the £41,700 sponsorship floor, and had a whole section on
UK Skilled Worker occupation coding. None of that belongs here: this candidate has full
right to work in India, and this project's own `CLAUDE.md` is explicit that nothing in
this repo should ever mention sponsorship, visa status, or occupation codes. Nothing in
this file is read programmatically by any script (`grep`-confirmed 2026-08-31), so nothing
downstream depended on the old structure — this rewrite keeps the genuinely useful,
already India-specific material (the employer list) and drops everything else that was
purely UK.

---

## Part 1 — Title tiers, India market

Built from the four target archetypes in `modes/_profile.md` and the real skill/experience
facts in `cv.md` / `03_Master_Profile.md` — not invented, just organised into search tiers
the way the UK version did for its own market.

### TIER 1 — Core. Highest match, search daily.

Business Analyst · Management Consultant · Senior Analyst · Strategy & Operations Analyst ·
Business Excellence Analyst · Transformation Analyst · Consulting Analyst · Associate
Consultant · Business Consultant

### TIER 2 — Programme and infrastructure. Plays the EMPLOYER_ONE experience directly.

Programme Analyst · PMO Analyst · Project Controls Analyst · Portfolio Analyst · Governance
Analyst · Capital Projects Analyst · Infrastructure Consultant · Programme Management
Officer

### TIER 3 — Adjacent, worth searching two or three times a week

**Commercial and cost** — Commercial Analyst · Cost Analyst · Contract Analyst · Bid
Analyst. The CV already leads with a named £100K commercial catch — "Commercial Analyst"
is at least as strong a keyword match as "PMO Analyst."

**Reporting and data** — Reporting Analyst · MI Analyst · Business Intelligence Analyst ·
Insight Analyst · Business Performance Analyst. Power BI, SQL, and 19 months of executive
reporting make this whole family a legitimate fit.

**Strategy and planning** — Strategy Analyst · Strategy Associate · Corporate Strategy
Analyst · Business Planning Analyst · Operational Excellence Analyst · Process Improvement
Analyst

### AVOID — actively exclude (matches `modes/_profile.md` → Exclusions)

Graduate · Trainee · Management Trainee · Intern · Apprentice · Support Officer · Team
Administrator · Project Coordinator · Junior · Entry Level · Rotational Programme

---

## Part 2 — India target employers

This list already existed correctly scoped to India before this rewrite — carried over
unchanged from the previous version's Part 3, since it was accurate and India-specific to
begin with.

**Consulting** — Accenture Strategy & Consulting · Deloitte India · KPMG India · EY India ·
PwC India · Capgemini Invent · LTIMindtree · Infosys Consulting · TCS Consulting · Wipro
Consulting · Grant Thornton Bharat · BDO India · Protiviti India · Alvarez & Marsal India

**Infrastructure and capital projects** — L&T (and L&T Infrastructure Engineering) · Tata
Projects · Turner & Townsend India · Arcadis India · WSP India · AECOM India · Jacobs India
· Mott MacDonald India · Systra India · RITES · IRCON · Egis India

**GCCs with programme functions** — the captive centres of global consulting/infrastructure
firms, concentrated in Gurugram, Hyderabad, Pune and Bengaluru. These specifically value UK
delivery experience, which is a scarce, legible differentiator in this market — see
`modes/_profile.md` → "Your Cross-cutting Advantage."

**Note on the Tier 4 "practice name" idea from the UK version:** the UK taxonomy names
specific internal practices (e.g. "KPMG Major Projects Advisory") because those exact
names were verified at the time. No India-market division names have been verified the
same way yet — rather than invent plausible-sounding ones, this section is left as: search
the companies above directly, and verify any specific India practice/division name before
treating it as a real search term.

**Agencies:** the UK version's agency list (Hiperpool, Movemeon, etc.) is UK-only —
none of those are India recruiters. No India-specific agency shortlist has been researched
yet; this is open work, not a gap in this rewrite specifically.

---

## Part 3 — Paste-ready boolean strings, India

```
("Business Analyst" OR "Consultant" OR "Senior Analyst" OR "Strategy & Operations" OR
"Business Excellence" OR "Program Manager" OR "PMO") AND ("Gurugram" OR "Gurgaon" OR
"YOUR_CITY" OR "Hyderabad" OR "Pune" OR "Bengaluru")
```

```
("Business Analyst" OR "Management Consultant" OR "Commercial Analyst" OR "Strategy
Analyst") site:*.in NOT (Graduate OR Trainee OR Intern OR Junior OR Fresher)
```

```
("Reporting Analyst" OR "MI Analyst" OR "Business Intelligence Analyst" OR "Insight
Analyst") AND ("Power BI" OR SQL) AND (India OR Gurugram OR Hyderabad OR Pune OR Bengaluru)
```

---

## Part 4 — What replaced the old Part 5 ("UK visa coding")

Nothing. There is no India equivalent — no occupation-code eligibility gate, no going-rate
floor, no sponsorship-timing constraint. The old Part 5 doesn't get a rewritten India
counterpart because there's genuinely nothing there to replace; the seniority/scope gate
that does the equivalent screening job for India already lives in `modes/_profile.md`'s
Step 1 hard gate.
