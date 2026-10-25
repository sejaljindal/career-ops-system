# Quality review — row 19 (Barclays), the one "already checked" pair
**Reviewed 2026-09-04 against `modes/_profile.md`'s CV and cover-letter framework.**

The earlier audit of this pair concluded: *"No fabrication found; every claim
traces to `cv.md`; UK experience is prominently surfaced."* That conclusion is
correct **and almost irrelevant** — it checked only for fabrication and
UK-presence. It never checked the document against the mandatory structure.
Against that structure, this pair fails nine ways, two of them by reproducing
the exact phrasings the framework bans by name.

Source reviewed: `output/tailor-bundles/19.decision.json`.

---

## CV failures

**1. Two mandatory sections missing entirely.**
Required order is Name · Headline · Contact · PROFESSIONAL SUMMARY · SKILLS ·
KEY ACHIEVEMENTS *(conditional)* · EXPERIENCE · EDUCATION AND QUALIFICATIONS ·
PROFESSIONAL DEVELOPMENT · EXTRA-CURRICULAR ACTIVITIES AND INTERESTS.
Produced: headline, summary, experience, education, skills. **PROFESSIONAL
DEVELOPMENT and EXTRA-CURRICULAR are absent**, though both are marked "always
present". Every certification — TechUp Women, Google PM, Power BI — is gone.

**2. Section order wrong.** SKILLS appears last, after EDUCATION. It belongs
directly after PROFESSIONAL SUMMARY.

**3. A whole role dropped.** Only EMPLOYER_ONE and EMPLOYER_TWO BA appear. The
**Business Development Intern role is missing**. The framework is explicit:
*"all three roles always, including the Business Development Intern stint…
dropping it would be an omission, not a positioning choice."*

**4. A whole degree dropped.** Only the YOUR_MSc appears. **The BBA is
missing.**

**5. Skills categories collapsed.** The framework requires all three labelled
categories (Business analysis / Programme & delivery / Technical), never
dropping one. Produced: a flat list of six items with no categories —
"Power BI, Advanced Excel, SQL, SharePoint, PMO governance, Stakeholder
management". Both non-technical categories are effectively gone.

**6. Three of the four never-drop bullets are missing.** Present: the SharePoint
throughput bullet. Missing: the RAID/milestone/CDM governance bullet, the
critical-path escalation bullet, and the hypothesis-led A/B testing bullet.
EMPLOYER_ONE carries **2 bullets against 7 in the master profile**.

**7. Drastically under length.** Two roles, three bullets total, one degree, six
skills. This is well under one page against a 1.5–2 page target. (Note: the
generating instruction at the time said "keep it to one page, 400-500 words" —
corrected to 700-900 words / two pages on 2026-09-04, so a re-render will not
repeat this specific failure.)

**8. Headline doesn't follow the required format.** Required:
`{role positioning} | {skill 1} | {skill 2}`, the two skills read from that JD's
own emphasis. Produced: *"Business & Process Transformation Analyst — UK
Infrastructure Delivery, India Market"*. The positioning half is fine and
correctly avoids "PMO"/"Team Organiser"; the format is not followed, and
"India Market" is addressed to the pipeline rather than to a reader.

---

## Cover letter failures

**9a. The opening is the exact banned pattern.**
Framework: *"Open with something specific and real from the JD — never 'I am
applying for {role} at {company}.'"*
Produced: *"I'm applying for the Senior Analyst - Customer Journey Mapping role
at Barclays because…"*

**9b. The closing is the exact banned phrase.**
Framework: *"Never close with 'I would welcome the chance to discuss the role.'"*
Produced: *"I'd welcome the opportunity to discuss how this UK infrastructure
delivery background applies to this role."*

**Also:** the body is two stacked achievements, not the required single
narrative thread; and there is no specific, real detail about Barclays anywhere,
because **no JD text was ever available** (see below).

---

## The root cause behind most of this

**No JD text has ever reached any of these bundles.** All five current bundles
report `page returned too little content (likely JS-rendered or login-gated)`.
Every one of the top-scoring roles is on Workday, and `fetchJdText()` is a plain
HTTP fetch that cannot execute JavaScript.

So this pair — the only one ever quality-checked — was generated with **zero JD
input**. That explains the generic opening, the absent company specifics, and
why the bullets are near-verbatim from `cv.md`: there was nothing to tailor
*against*. "Tailored" was doing no work at all, which is a stronger version of
what the original audit gently noted.

It also means the earlier finding that seniority/scope was mis-scored for this
role (a 4.5 score on a posting whose real text describes AVP-level team
leadership) has never been re-tested, because the scoring never saw the text
either.

---

## What this means for the other four pairs

Rows 5, 10, 20 and 26 have bundles prepared but **cannot be honestly rendered
yet**. Rendering them now would produce four more documents with:
- no company-specific opening (no JD to draw from),
- no defensible fit judgment (the honesty gate requires reading the JD),
- no basis for selecting bullets against "that JD's own emphasis".

That is not a quality review; it is four more generic documents. The blocker is
JD access, not generation capability.

**Attempted and failed on 2026-09-04:** `fetchJdText()` (JS-rendered), the
browser pane (navigation to the Workday domains denied/failed), and `web_fetch`
(returns meta tags only; the Workday JSON endpoint returned empty).

**Working options, in order of preference:**
1. Open each posting in your own browser, copy the JD text, and paste it in —
   or use `npm run paste` (`paste-jobs.mjs`), which exists for exactly this.
2. Run the render step in `agy`, which may have unrestricted network access.
3. Add a Playwright-based JD fetcher to `auto-tailor.mjs` — `playwright` is
   already a dependency and `liveness-browser.mjs` already drives it, so the
   machinery exists. This is new code and should be agreed before building.

---

## Recommended re-render order once JD text is available

1. Re-render **row 19** first and diff against this review — it is the
   controlled case, and every failure above should disappear.
2. Then rows 5, 20 (both 4.4), then 10, 26 (both 4.0).
3. Before generating anything for row 19 or row 10, re-check the seniority gate:
   both are titled at a level ("Senior Manager" for Novartis row 10) that may
   fail `modes/_profile.md`'s Step 1 scope/depth override.
