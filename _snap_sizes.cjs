// Dev-only: snapshot the size columns per APN from output/commercial_transfers.csv
// so a re-fetch can be regression-checked (lost APNs / changed values).
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
const out = process.argv[2] || '_sizes_snapshot.json';
const rows = parseCsv(fs.readFileSync('output/commercial_transfers.csv', 'utf8'));
const h = rows[0];
const i = n => h.indexOf(n);
const snap = {};
for (const r of rows.slice(1)) {
  const apn = (r[i('PIN')] || '').trim();
  if (!apn || snap[apn]) continue;
  snap[apn] = ['Found', 'SquareFeet', 'BuildingSf', 'Acreage', 'ClassCode', 'Address'].map(c => r[i(c)] ?? '');
}
fs.writeFileSync(out, JSON.stringify(snap));
console.log('snapshotted', Object.keys(snap).length, 'APNs ->', out);
