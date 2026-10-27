import zipfile, re, sys

path = r'c:\appraisal_workbench\output\transfers_to_be_done_10.27.2026.xlsx'
z = zipfile.ZipFile(path)
ss = z.read('xl/sharedStrings.xml').decode('utf-8', 'replace')
strings = re.findall(r'<t[^>]*>(.*?)</t>', ss, re.S)
sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8', 'replace')
rows = re.findall(r'<row[^>]*>(.*?)</row>', sheet, re.S)
print('TOTAL ROWS (incl header):', len(rows))

def cells(r):
    out = []
    for c in re.findall(r'<c[^>]*>.*?</c>|<c[^>]*/>', r, re.S):
        tm = re.search(r't="(\w+)"', c)
        vm = re.search(r'<v>(.*?)</v>', c)
        out.append((tm.group(1) if tm else '', vm.group(1) if vm else ''))
    return out

hdr = [(strings[int(v)] if t == 's' else v) for t, v in cells(rows[0])]
print('HEADERS (%d):' % len(hdr))
print(hdr)
print('--- SAMPLE ROW 1 ---')
r1 = [(strings[int(v)] if t == 's' else v) for t, v in cells(rows[1])]
for i in range(min(len(hdr), len(r1))):
    if r1[i]:
        print(f'{hdr[i]} = {r1[i]}')
print('--- SAMPLE ROW 2 ---')
if len(rows) > 2:
    r2 = [(strings[int(v)] if t == 's' else v) for t, v in cells(rows[2])]
    for i in range(min(len(hdr), len(r2))):
        if r2[i]:
            print(f'{hdr[i]} = {r2[i]}')
