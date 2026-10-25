#!/usr/bin/env python3
"""Append a role to the tracker, copying the style of the row above.

  python3 tools/tracker_add_row.py tracker.xlsx "UK Roles" Company "Role title" Location FIT URL [deadline]

Columns A-U: Sent/Complete(☐ ☑ ☒ Closed) | Company | Role | Location | Posted | Deadline | Fit 1-5 | Best for company
| Status | CV generated | Documents required / notes | JD read? | CV file | CV folder | Letter (Word) | Letter (PDF)
| Supporting statement | Other docs | Letter folder | Link | Sent/closed note.
Mark one '★ Best' per company (highest fit). Tick ☑ when SENT, '☒ Closed' when the posting is gone.
"""
import sys, copy, openpyxl
path, sheet, company, role, loc, fit, url, *rest = sys.argv[1:]
wb = openpyxl.load_workbook(path); ws = wb[sheet]; r = ws.max_row + 1
for c in range(1, 22): ws.cell(r, c)._style = copy.copy(ws.cell(r - 1, c)._style)
vals = {1: '☐', 2: company, 3: role, 4: loc, 6: rest[0] if rest else None, 7: str(fit), 9: 'Open', 20: url}
for c, v in vals.items(): ws.cell(r, c).value = v
wb.save(path); print('added row', r)
