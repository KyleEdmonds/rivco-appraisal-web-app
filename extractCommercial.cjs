// Dev-only: extract the commercial transfer subset from the main transfer
// file into a pared-down CSV that the Rule 2 batch runs against.
//
// Filters (applied in order):
//   1. ClassCat in {Commercial, CommercialDE}
//   2. drop ClassSubCat in {Timeshare, Hotel}
//   3. keep LocalRatioCd in {DTT, STT, FIT, FCT, LST, P19, TXT}
//
// Output columns (11): PIN, DocNumber, RecordDate, DocDate, LocalRatioCd,
//   LocalRatioCdDescr, Consid, ReappraisabilityPercent, ClassCdDescr,
//   ClassSubCat, ParcelsOnDocument
//
// Values are written verbatim (data fidelity) — no rounding or transforms.
const fs = require('fs'), zlib = require('zlib');
const zip = fs.readFileSync(process.argv[2] || 'input/Transfers_ByRecordDate_CalendarYear_10142026.xlsx');
let off = 0, entries = [];
while (off + 30 <= zip.length) {
  if (zip.readUInt32LE(off) !== 0x04034b50) break;
  const nl = zip.readUInt16LE(off + 26), el = zip.readUInt16LE(off + 28), cs = zip.readUInt32LE(off + 18);
  const name = zip.toString('utf8', off + 30, off + 30 + nl);
  entries.push([name, off + 30 + nl + el, cs, off]);
  off += 30 + nl + el + cs;
}
const inf = (e) => {
  let b = zip.slice(e[1], e[1] + e[2]);
  if (zip.readUInt16LE(e[3] + 8) === 8) b = zlib.inflateRawSync(b);
  return b.toString('utf8');
};
const ss = [...inf(entries.find(n => n[0] === 'xl/sharedStrings.xml')).matchAll(/<si>(?:[\s\S]*?)<\/si>/g)]
  .map(m => [...m[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
const sheet = inf(entries.find(n => n[0].includes('sheet1.xml')));
const rows = [...sheet.matchAll(/<row[^>]*>[\s\S]*?<\/row>/g)];
const parse = (r) => {
  const c = {};
  for (const m of r.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const col = m[1].match(/r="([A-Z]+)\d+"/);
    if (!col) continue;
    const t = m[1].match(/t="(\w+)"/);
    const v = (m[2] || '').match(/<v>([\s\S]*?)<\/v>/);
    let val = v ? v[1] : '';
    if (t && t[1] === 's' && val !== '') val = ss[parseInt(val)] ?? '';
    c[col[1]] = val;
  }
  return c;
};
const hdr = parse(rows[0][0]);
const dataRows = rows.slice(1).map(r => parse(r[0]));

// ---- filter sets ----
const COMMERCIAL_CATS = new Set(['Commercial', 'CommercialDE']);
const DROP_SUBCATS = new Set(['Timeshare', 'Hotel']);
const KEEP_RATIO_CDS = new Set(['DTT', 'STT', 'FIT', 'FCT', 'LST', 'P19', 'TXT']);

// ---- output columns (source letter -> header name) ----
const OUT_COLS = ['A', 'F', 'G', 'I', 'L', 'M', 'N', 'P', 'T', 'V', 'W'];

// ---- filter cascade ----
const stage1 = dataRows.filter(r => COMMERCIAL_CATS.has(r['U']));
const stage2 = stage1.filter(r => !DROP_SUBCATS.has(r['V']));
const stage3 = stage2.filter(r => KEEP_RATIO_CDS.has((r['L'] || '').toUpperCase()));

console.log('Filter cascade:');
console.log('  total rows:             ' + String(dataRows.length).padStart(7));
console.log('  + commercial cat:       ' + String(stage1.length).padStart(7) + '   (ClassCat in Commercial/CommercialDE)');
console.log('  - timeshare/hotel:      ' + String(stage2.length).padStart(7) + '   (drop ClassSubCat Timeshare/Hotel)');
console.log('  + ratio cd whitelist:   ' + String(stage3.length).padStart(7) + '   (LocalRatioCd in DTT/STT/FIT/FCT/LST/P19/TXT)');

// ---- what the ratio whitelist keeps/drops within commercial-minus-timeshare/hotel ----
const ratioTally = {};
for (const r of stage2) {
  const k = (r['L'] || '(empty)').toUpperCase();
  ratioTally[k] = (ratioTally[k] || 0) + 1;
}
console.log('\nLocalRatioCd breakdown of the ' + stage2.length + ' commercial rows (post timeshare/hotel drop):');
Object.entries(ratioTally).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
  const kept = KEEP_RATIO_CDS.has(k) ? 'keep' : 'drop';
  console.log('  ' + String(n).padStart(6) + '  ' + k.padEnd(8) + '  [' + kept + ']');
});

// ---- CSV output ----
function csvField(v) {
  v = v === undefined ? '' : String(v);
  return (v.includes(',') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
const headerLine = OUT_COLS.map(c => hdr[c]).join(',');
const lines = [headerLine];
for (const r of stage3) lines.push(OUT_COLS.map(c => csvField(r[c])).join(','));

// Derived files live in output/ (input/ holds only the county master file).
const outPath = 'output/commercial_transfers.csv';
fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(outPath, lines.join('\r\n') + '\r\n', 'utf8');
console.log('\nWrote ' + outPath + '  (' + stage3.length + ' rows, ' + OUT_COLS.length + ' cols)');
console.log('Header: ' + headerLine);
console.log('\nFirst 5 data rows:');
for (let i = 1; i <= 5 && i < lines.length; i++) console.log('  ' + lines[i]);
