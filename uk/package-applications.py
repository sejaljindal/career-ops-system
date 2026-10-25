#!/usr/bin/env python3
"""Package every generated CV and cover letter as Word + PDF with ATS-safe names.
Name pattern:  FirstName_LastName_<Company>_<Role>_CV.(docx|pdf)
               FirstName_LastName_<Company>_<Role>_Cover-Letter.(docx|pdf)
               FirstName_LastName_<Company>_<Role>_Supporting-Statement.(docx|pdf)
Output: <jobsearch>/Applications/<UK|India|Other>/<CVs|Cover Letters>/
Run after ANY new CV / cover letter is generated:  python3 package-applications.py
Re-runnable; only converts what is new or changed. Originals are never renamed.
"""
import os,glob,shutil,subprocess,sys,time,re
ROOT=os.path.expanduser('~/mnt/jobsearch')
SRC=[('UK',ROOT+'/career-ops/output','CVs'),('India',os.path.expanduser('~/mnt/jobsearch-india/career-ops/output'),'CVs')]
OUT=ROOT+'/Applications'
CL=ROOT+'/Cover Letters'
EXP=ROOT+'/Cover Letters/_expired-not-needed'
def newname(base,kind): return f'FirstName_LastName_{base}_{kind}'
jobs=[]
def add(src,region,sub,kind,suffix):
    base=os.path.basename(src)[:-len(suffix)-5]   # strip _X.docx
    d=f'{OUT}/{region}/{sub}'; os.makedirs(d,exist_ok=True)
    dst=f'{d}/{newname(base,kind)}.docx'
    if not os.path.exists(dst) or os.path.getmtime(src)>os.path.getmtime(dst)+1:
        shutil.copyfile(src,dst)
    jobs.append(dst)
for region,d,sub in SRC:
    for f in sorted(glob.glob(d+'/*_CV.docx')):
        if '~$' in f: continue
        add(f,region,sub,'CV','_CV')
for region in ['UK','India','Other']:
    for f in sorted(glob.glob(f'{CL}/{region}/*.docx')):
        if '~$' in f: continue
        if f.endswith('_Supporting-Statement.docx'): add(f,region,'Cover Letters','Supporting-Statement','_Supporting-Statement')
        elif f.endswith('_Cover.docx'): add(f,region,'Cover Letters','Cover-Letter','_Cover')
print('word files:',len(jobs))
# PDFs (resumable, time boxed)
t0=time.time(); done=0
by={}
for w in jobs:
    p=w[:-5]+'.pdf'
    if not os.path.exists(p) or os.path.getmtime(p)<os.path.getmtime(w): by.setdefault(os.path.dirname(w),[]).append(w)
for d,fs in by.items():
    for i in range(0,len(fs),60):
        if time.time()-t0>130: break
        chunk=fs[i:i+60]
        subprocess.run(['soffice','--headless','--convert-to','pdf','--outdir',d]+chunk,capture_output=True)
        done+=len(chunk)
left=sum(1 for w in jobs if not os.path.exists(w[:-5]+'.pdf') or os.path.getmtime(w[:-5]+'.pdf')<os.path.getmtime(w))
print('pdf converted this run:',done,'| still to convert:',left,'(re-run until 0)')
