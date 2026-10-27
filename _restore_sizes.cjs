// Dev-only: restore the size columns of output/commercial_transfers.csv from a
// snapshot (recovery from a bad --missing run that wiped them).
// Usage: node _restore_sizes.cjs [snapshot.json]
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
const snap = JSON.parse(fs.readFileSync(process.argv[2] || '_sizes_before.json', 'utf8'));
const rows = parseCsv(fs.readFileSync('output/commercial_transfers.csv', 'utf8'));
const h = rows[0];
const out = [h.join(',')];
let withData = 0;
for (const r of rows.slice(1)) {
  const apn = (r[0] || '').trim();
  const vals = snap[apn] || SIZE_COLS.map(() => '');
  if (vals[0] === 'yes') withData++;
  const base = r.filter((v, idx) => !SIZE_COLS.includes(h[idx]));
  out.push([...base, ...vals].map(csvField).join(','));
}
fs.writeFileSync('output/commercial_transfers.csv', out.join('\r\n') + '\r\n', 'utf8');
console.log('restored', rows.length - 1, 'rows |', withData, 'rows with Found=yes');
