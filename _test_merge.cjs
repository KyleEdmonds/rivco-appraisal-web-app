// Dev-only: offline test of the --missing merge logic (no network).
// Simulates a run where one missing APN is found and one is not, writes to a
// temp file, and diffs against the current CSV.
const fs = require('fs');
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvField(v) {
  v = v === undefined || v === null ? '' : String(v);
  return (v.includes(',') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
const SIZE_COLS = ['Found', 'SquareFeet', 'BuildingSf', 'Acreage', 'ClassCode', 'Address'];
const text = fs.readFileSync('output/commercial_transfers.csv', 'utf8');
const rows = parseCsv(text);
const rawHeader = rows[0];
const rawData = rows.slice(1);
// capture (mirrors fetchParcelSizes.cjs --missing)
const existingSizes = {};
{
  const colIdx = {};
  SIZE_COLS.forEach(c => { colIdx[c] = rawHeader.indexOf(c); });
  const pinCol = rawHeader.indexOf('PIN');
  for (const r of rawData) {
    const apn = (r[pinCol] || '').trim();
    if (!apn || existingSizes[apn] || (r[colIdx['Found']] || '').trim() === '') continue;
    existingSizes[apn] = SIZE_COLS.map(c => r[colIdx[c]] ?? '');
  }
}
console.log('existingSizes (non-empty Found APNs):', Object.keys(existingSizes).length);
// simulated fetch results: 910490001 found, 508193027 not found
const results = [
  { apn: '910490001', found: true, squareFeet: '1,000', buildingSf: 900, acreage: '0.050', classCode: 'Test Class', address: '1 TEST ST' },
  { apn: '508193027', found: false },
];
const sizeLookup = {};
for (const r of results) sizeLookup[r.apn] = r;
const MISSING = true;
const sizeVal = (r, col, apn) => {
  if (r && r.found) {
    switch (col) {
      case 'Found': return 'yes';
      case 'SquareFeet': return r.squareFeet ?? '';
      case 'BuildingSf': return r.buildingSf ?? '';
      case 'Acreage': return r.acreage ?? '';
      case 'ClassCode': return r.classCode ?? '';
      case 'Address': return r.address ?? '';
      default: return '';
    }
  }
  if (col === 'Found' && r) return 'no';
  if (MISSING && existingSizes[apn]) return existingSizes[apn][SIZE_COLS.indexOf(col)];
  return '';
};
const keepIdx = [];
rawHeader.forEach((h, i) => { if (!SIZE_COLS.includes(h)) keepIdx.push(i); });
const header = keepIdx.map(i => rawHeader[i]);
const dataRows = rawData.map(r => keepIdx.map(i => r[i]));
const pinIdx = header.indexOf('PIN');
const outLines = [[...header, ...SIZE_COLS].join(',')];
for (const r of dataRows) {
  const apn = (r[pinIdx] || '').trim();
  const size = sizeLookup[apn];
  const row = [...r];
  for (const col of SIZE_COLS) row.push(sizeVal(size, col, apn));
  outLines.push(row.map(csvField).join(','));
}
fs.writeFileSync('_merge_test_out.csv', outLines.join('\r\n') + '\r\n', 'utf8');
// diff against current
const cur = parseCsv(text);
const out = parseCsv(outLines.join('\r\n'));
let diffs = 0;
for (let i = 0; i < Math.max(cur.length, out.length); i++) {
  const a = (cur[i] || []).join('|'), b = (out[i] || []).join('|');
  if (a !== b) { diffs++; if (diffs <= 6) console.log('DIFF row', i, '\n  cur:', a, '\n  out:', b); }
}
const expectRows = rawData.filter(r => (r[0] || '').trim() === '910490001').length;
console.log('differing rows:', diffs, '| expected:', expectRows, '(rows of the simulated-found APN only; the not-found APN stays no -> no)');
console.log(diffs === expectRows ? 'PASS: merge preserves all other rows' : 'FAIL: unexpected diffs');
