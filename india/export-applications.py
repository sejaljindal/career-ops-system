#!/usr/bin/env python3
"""Export finished CVs / cover letters as Word + PDF named for recruiters.

  FirstName_LastName_<Company>_<Role>_CV.docx|pdf
  FirstName_LastName_<Company>_<Role>_Cover-Letter.docx|pdf
  FirstName_LastName_<Company>_<Role>_Supporting-Statement.docx|pdf

Usage: python3 export-applications.py UK|India [applications_dir]
Reads  <repo>/output/*_CV.docx and *_Cover.docx (+ *_Supporting-Statement.docx)
Writes <applications_dir>/<Region>/CVs and /Cover Letters (default: ../Applications).
Run it after every CV / cover-letter generation. Needs LibreOffice (soffice) for PDFs.
"""
import glob, os, shutil, subprocess, sys
region = sys.argv[1] if len(sys.argv) > 1 else 'UK'
root = os.path.dirname(os.path.abspath(__file__))
app = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, '..', 'Applications')
if region == 'India' and len(sys.argv) <= 2:
    app = os.path.join(root, '..', '..', 'jobsearch', 'Applications')
out = os.path.join(root, 'output')
KINDS = [('_CV.docx', 'CV', 'CVs'), ('_Cover.docx', 'Cover-Letter', 'Cover Letters'),
         ('_Supporting-Statement.docx', 'Supporting-Statement', 'Cover Letters')]
todo = {}
for suffix, kind, sub in KINDS:
    for f in glob.glob(os.path.join(out, '*' + suffix)):
        b = os.path.basename(f)
        if b.startswith('~$'): continue
        base = b[:-len(suffix)].lstrip('_')
        d = os.path.join(app, region, sub); os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, f'FirstName_LastName_{base}_{kind}.docx')
        if not os.path.exists(dst) or os.path.getmtime(f) > os.path.getmtime(dst):
            shutil.copy2(f, dst); todo.setdefault(d, []).append(os.path.basename(dst))
for d, files in todo.items():
    for i in range(0, len(files), 60):
        subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', d] + [os.path.join(d, x) for x in files[i:i+60]],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# remove LibreOffice lock/temp leftovers
for d in todo:
    for f in glob.glob(os.path.join(d, '.~lock.*')) + glob.glob(os.path.join(d, 'lu*.tmp')):
        try: os.remove(f)
        except OSError: pass
print('exported', sum(len(v) for v in todo.values()), 'files (Word + PDF) to', os.path.abspath(app))
