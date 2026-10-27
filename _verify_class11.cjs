// Dev-only: verify ClassCdDescr -> ClassCd is 1:1 across the transfer file,
// so peer-grouping by ClassDesc is equivalent to grouping by ClassCd.
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
const dataRows = rows.slice(1).map(r => parse(r[0]));
const descToCodes = {};
for (const r of dataRows) {
  const desc = r['T'] || '(empty)';
  const code = r['S'] || '(empty)';
  (descToCodes[desc] = descToCodes[desc] || new Set()).add(code);
}
let bad = 0;
for (const [desc, codes] of Object.entries(descToCodes)) {
  if (codes.size > 1) { bad++; console.log('  NON-1:1  ' + desc + '  ->  ' + [...codes].join(', ')); }
}
console.log('distinct ClassDescr (T): ' + Object.keys(descToCodes).length);
console.log('distinct ClassCd    (S): ' + new Set(dataRows.map(r => r['S'] || '(empty)')).size);
console.log('desc->code mappings that are NOT 1:1: ' + bad);
console.log(bad === 0 ? 'OK: grouping by ClassDescr is equivalent to grouping by ClassCd' : 'WARNING: grouping by ClassDescr would MERGE distinct class codes');
