import openpyxl, sqlite3, collections, os, json

OUT = r'c:\appraisal_workbench\output'

def rows_of(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    data = list(ws.iter_rows(values_only=True))
    hdr = [str(h).strip() if h is not None else '' for h in data[0]]
    out = []
    for r in data[1:]:
        if all(v is None for v in r):
            continue
        d = {}
        for i, v in enumerate(r):
            if i < len(hdr) and hdr[i]:
                d[hdr[i]] = v
        out.append(d)
    return hdr, out

hdr, comp = rows_of(os.path.join(OUT, 'riv_com_2025_2026_completed_transfers_10.27.26.xlsx'))
c2026 = [r for r in comp if str(r.get('DocNumber') or '').startswith('2026')]
keys2026 = set((str(r.get('PIN')).strip(), str(r.get('DocNumber')).strip()) for r in c2026)

hdr2, todo = rows_of(os.path.join(OUT, 'transfers_to_be_done_10.27.2026.xlsx'))

db = r'c:\appraisal_workbench\data\appraisal.db'
c = sqlite3.connect(db, timeout=5)
cols = [r[1] for r in c.execute("PRAGMA table_info(transfer_comps)").fetchall()]
print("transfer_comps cols:", cols)
existing_keys = set()
for (data,) in c.execute("select data from transfer_comps").fetchall():
    try:
        j = json.loads(data)
        existing_keys.add((str(j.get('apn')).strip(), str(j.get('docNumber')).strip()))
    except Exception:
        pass
print("existing transfer_comp APN+doc keys:", len(existing_keys))
overlap = keys2026 & existing_keys
print("overlap (2026 completed already in transfer_comps):", len(overlap))
print("2026 to add (not already present):", len(keys2026 - existing_keys))
c.close()

BOOKS = {
 'Kyle Edmonds': [101,102,103,107,108,109,110,111,112,113,114,116,117,118,119,120,275,277,279,281,282,283],
 'Jackie Strej': [115,121,122,123,125,126,127,129,130,131,133,135,140,141,142,168,172,278,285,286,287,289],
 'Ryan Christianson': [132,136,138,143,145,146,147,149,150,151,153,154,155,157,162,163,185,186,269,270,271,273,274],
 'Anthony Figuiera': [144,152,156,159,160,161,164,165,166,167,169,170,171,173,174,175,177,178,179,181,182,183],
 'Desiree Quesada': [246,247,249,255,256,257,258,259,260,264,266,284,291,292,294,295,296,297,300,302,303,305,307,320],
 'Sean Smith': [187,189,190,206,207,209,210,211,213,214,215,217,218,219,221,222,223,225,226,227,229,250,251],
 'Jamie Javier': [191,193,230,231,233,234,235,237,238,239,241,242,243,245,252,253,254,263,267,268,272,276,280],
 'Karina Heers': [304,308,312,316,322,422,423,425,426,427,429,471,473,474,475,478,479,481,482,484,485,486,487,488],
}
book2appr = {}
for name, books in BOOKS.items():
    for b in books:
        book2appr[b] = name
allb = [b for v in BOOKS.values() for b in v]
dups = [b for b,cnt in collections.Counter(allb).items() if cnt>1]
print("duplicate books in mapping:", dups)

todo_books = set(int(str(r.get('PIN'))[:3]) for r in todo)
covered = todo_books & set(book2appr)
uncovered = todo_books - set(book2appr)
print("to-be-done distinct books:", len(todo_books), "covered:", len(covered), "uncovered:", sorted(uncovered))
per = collections.Counter()
for r in todo:
    b = int(str(r.get('PIN'))[:3])
    per[book2appr.get(b, 'UNMAPPED:'+str(r.get('QueueUser')))] += 1
print("per-appraiser (by book):", dict(per))

