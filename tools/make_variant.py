#!/usr/bin/env python3
"""Make a tailored CV / cover letter from a master .docx by swapping strings, then export Word + PDF.

  python3 tools/make_variant.py MASTER.docx OUT_BASENAME "old=>new" ["old2=>new2" ...]

Example (title + summary clause for one role):
  python3 tools/make_variant.py my_master_cv.docx FirstName_LastName_Acme_Analyst_CV \
     "Programme 2027 London=>Programme 2027 Leeds" \
     "where governance is central=>where customer service and process improvement are central"

Rules baked in (see CLAUDE.md): file names FirstName_LastName_<Company>_<Role>_CV|_Cover-Letter, underscores
between parts, hyphens inside words, no spaces, no final/draft/v2. Word + PDF always. A CV should be 2 pages
max and a letter 1 page — the script prints page counts so you can check. Needs LibreOffice (soffice) + pdfinfo.
"""
import sys, zipfile, subprocess, os, re
src, out, *pairs = sys.argv[1:]
subs = [p.split('=>', 1) for p in pairs]
docx = out + '.docx'
zin = zipfile.ZipFile(src); zout = zipfile.ZipFile(docx, 'w', zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == 'word/document.xml':
        x = data.decode('utf-8')
        for a, b in subs:
            n = x.count(a); print(f'{a[:50]!r}: {n} match(es)')
            if n == 0: print('  !! not found — text may be split across XML runs; retype the phrase in Word as one run')
            x = x.replace(a, b)
        data = x.encode('utf-8')
    zout.writestr(item, data)
zout.close()
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', docx], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pdf = out + '.pdf'
try: print(subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout.split('Pages:')[1].split()[0], 'page(s)')
except Exception: print('check page count manually')
