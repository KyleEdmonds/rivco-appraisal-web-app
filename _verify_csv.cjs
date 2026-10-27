// Dev-only: structural + regression verify of output/commercial_transfers.csv.
// Usage: node _verify_csv.cjs [snapshot.json]
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
const rows = parseCsv(fs.readFileSync('output/commercial_transfers.csv', 'utf8'));
const h = rows[0];
const i = n => h.indexOf(n);
const data = rows.slice(1);
let badCols = 0, found = 0, pricedMissing = 0, bldg = 0, emptyPin = 0;
for (const r of data) {
  if (r.length !== h.length) badCols++;
  if (!r[i('PIN')]) emptyPin++;
  if (r[i('Found')] === 'yes') found++;
  if (parseFloat(r[i('Consid')]) > 0 && r[i('Found')] !== 'yes') pricedMissing++;
  if (parseFloat(r[i('BuildingSf')]) > 0) bldg++;
}
console.log('rows:', data.length, '| cols:', h.length);
console.log('header:', h.join(','));
console.log('rows with wrong col count:', badCols, '| empty PIN:', emptyPin);
console.log('Found=yes:', found, '| BuildingSf>0:', bldg, '| priced rows w/o Found:', pricedMissing);
if (process.argv[2]) {
  const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const cur = {};
  for (const r of data) {
    const apn = (r[i('PIN')] || '').trim();
    if (!apn || cur[apn]) continue;
    cur[apn] = ['Found', 'SquareFeet', 'BuildingSf', 'Acreage', 'ClassCode', 'Address'].map(c => r[i(c)] ?? '');
  }
  let lost = 0, changed = 0;
  for (const [apn, vals] of Object.entries(before)) {
    const c = cur[apn];
    if (!c) { lost++; console.log('  LOST', apn); continue; }
    if (JSON.stringify(c) !== JSON.stringify(vals)) {
      changed++;
      if (changed <= 5) console.log('  CHANGED', apn, JSON.stringify(vals), '->', JSON.stringify(c));
    }
  }
  console.log('regression vs snapshot: lost APNs:', lost, '| changed values:', changed);
}
