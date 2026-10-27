# Convert the new county export (input/2025_2026_completed_transfers.xlsx) into
# the column layout the app's Rule 2 batch expects (see Rule2.cs TransferRow):
#   StatedSalePrice -> Consid   (price)
#   ClassCdCat      -> ClassCat (commercial filter; DE variant -> CommercialDE)
#   DeedProcDate    -> RecordDate
# and enrich with property characteristics from output/parcel_data.json
# (address, acreage, site sqft, year built, building sf, quality, condition).
# Output: output/completed_transfers_2025_2026.csv — the app's Rule 2 run picks
# the newest .csv/.xlsx in output/, so this becomes the batch source.
import csv, json, os, openpyxl

ROOT = r'c:\appraisal_workbench'
SRC = os.path.join(ROOT, 'input', '2025_2026_completed_transfers.xlsx')
PARCEL = os.path.join(ROOT, 'output', 'parcel_data.json')
OUT = os.path.join(ROOT, 'output', 'completed_transfers_2025_2026.csv')

CAT_MAP = {
    'Commercial': 'Commercial',
    'Commercial (Available for Direct Enrollment)': 'CommercialDE',
    'Residential (Available for Direct Enrollment)': 'ResidentialDE',
}

HDRS = ['PIN', 'DocNumber', 'RecordDate', 'DocDate', 'LocalRatioCd', 'Consid',
        'ClassCdDescr', 'ClassCat', 'QueueUser', 'Neighborhood', 'MultTransfer',
        'PINsInMult', 'Address', 'City', 'YrBuilt', 'Quality', 'Condition',
        'BuildingSf', 'Acreage', 'SquareFeet']

def iso(v):
    return v.strftime('%Y-%m-%d') if hasattr(v, 'strftime') else (str(v).strip() if v is not None else '')

def num(v):
    if v is None:
        return ''
    s = str(v).replace(',', '').strip()
    try:
        f = float(s)
    except ValueError:
        return ''
    return str(int(f)) if f == int(f) else s

def building_details(parcel):
    """First active building's detail map from parcel_data.json 'imprv'."""
    for b in parcel.get('imprv') or []:
        if str(b.get('active', 'active')).lower() == 'active':
            return {d['label']: d.get('value', '') for d in b.get('details', [])}
    return {}

def total_building_sf(parcel):
    """Sum of 'Actual Area sqft' across all buildings (matches fetchParcelSizes)."""
    total = 0.0
    for b in parcel.get('imprv') or []:
        for d in b.get('details', []):
            if d.get('label') == 'Actual Area sqft':
                try:
                    total += float(str(d.get('value', '')).replace(',', ''))
                except ValueError:
                    pass
    return total

def city_of(parcel):
    """District '004-000 CORONA' -> 'CORONA' (matches fetchParcelSizes)."""
    dist = str(parcel.get('District') or '').strip()
    return ' '.join(dist.split(' ')[1:]) if dist else ''

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb.worksheets[0]
rows = list(ws.iter_rows(values_only=True))
hdr = [str(h).strip() if h is not None else '' for h in rows[0]]

parcels = json.load(open(PARCEL, encoding='utf-8')) if os.path.exists(PARCEL) else {}

out_rows, enriched = [], 0
for r in rows[1:]:
    if all(v is None for v in r):
        continue
    d = {hdr[i]: v for i, v in enumerate(r) if i < len(hdr) and hdr[i]}
    pin = str(d.get('PIN') or '').strip()
    p = parcels.get(pin, {})
    bd = building_details(p)
    if p:
        enriched += 1
    out_rows.append({
        'PIN': pin,
        'DocNumber': str(d.get('DocNumber') or '').strip(),
        'RecordDate': iso(d.get('DeedProcDate')),
        'DocDate': iso(d.get('DocDate')),
        'LocalRatioCd': str(d.get('LocalRatioCd') or '').strip(),
        'Consid': num(d.get('StatedSalePrice')),
        'ClassCdDescr': str(d.get('ClassCdDescr') or '').strip(),
        'ClassCat': CAT_MAP.get(str(d.get('ClassCdCat') or '').strip(), str(d.get('ClassCdCat') or '').strip()),
        'QueueUser': str(d.get('QueueUser') or '').strip(),
        'Neighborhood': str(d.get('Neighborhood') or '').strip(),
        'MultTransfer': str(d.get('MultTransfer') or '').strip(),
        'PINsInMult': num(d.get('PINsInMult')),
        'Address': str(p.get('address') or '').strip(),
        'City': city_of(p),
        'YrBuilt': num(bd.get('Year Built')),
        'Quality': str(bd.get('Quality') or '').strip(),
        'Condition': str(bd.get('Cond') or '').strip(),
        'BuildingSf': num(total_building_sf(p)),
        'Acreage': num(p.get('acreage')),
        'SquareFeet': num(p.get('SquareFeet')),
    })

with open(OUT, 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=HDRS)
    w.writeheader()
    w.writerows(out_rows)

com = sum(1 for r in out_rows if r['ClassCat'] in ('Commercial', 'CommercialDE'))
print(f'rows: {len(out_rows)}  commercial: {com}  enriched from parcel_data: {enriched}')
print('wrote:', OUT)
