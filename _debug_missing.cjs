// Dev-only: trace --missing capture/selection logic of fetchParcelSizes.cjs.
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
const SIZE_COLS = ['Found', 'SquareFeet', 'BuildingSf', 'Acreage', 'ClassCode', 'Address'];
const rows = parseCsv(fs.readFileSync('output/commercial_transfers.csv', 'utf8'));
const rawHeader = rows[0];
const rawData = rows.slice(1);
const colIdx = {};
SIZE_COLS.forEach(c => { colIdx[c] = rawHeader.indexOf(c); });
console.log('colIdx:', JSON.stringify(colIdx));
const pinCol = rawHeader.indexOf('PIN');
const existingSizes = {};
for (const r of rawData) {
  const apn = (r[pinCol] || '').trim();
  if (!apn || existingSizes[apn] || (r[colIdx['Found']] || '').trim() === '') continue;
  existingSizes[apn] = SIZE_COLS.map(c => r[colIdx[c]] ?? '');
}
console.log('existingSizes count:', Object.keys(existingSizes).length);
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, '')); return isNaN(n) ? 0 : n; };
const keepIdx = [];
rawHeader.forEach((h, i) => { if (!SIZE_COLS.includes(h)) keepIdx.push(i); });
const header = keepIdx.map(i => rawHeader[i]);
const dataRows = rawData.map(r => keepIdx.map(i => r[i]));
const pinIdx = header.indexOf('PIN');
const considIdx = header.indexOf('Consid');
const seen = new Set();
const apns = [];
let pricedRows = 0;
for (const r of dataRows) {
  if (num(r[considIdx]) <= 0) continue;
  pricedRows++;
  const apn = (r[pinIdx] || '').trim();
  if (!apn || seen.has(apn)) continue;
  if (existingSizes[apn]) continue;
  seen.add(apn);
  apns.push(apn);
}
console.log('priced rows:', pricedRows, '| apns to fetch:', apns.length);
// check the 37 known-missing APNs
const probe = ['910490001', '508193027', '405230016'];
for (const p of probe) {
  console.log(p, '| in existingSizes:', !!existingSizes[p], '| existingSizes value:', JSON.stringify(existingSizes[p]));
  const row = dataRows.find(r => (r[pinIdx] || '').trim() === p);
  if (row) console.log('  first row:', JSON.stringify(row));
}

