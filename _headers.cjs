// Dev-only: dump the transfer file's header row (all columns).
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
const row1 = sheet.match(/<row[^>]*>[\s\S]*?<\/row>/)[0];
const cells = [...row1.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)];
for (const c of cells) {
  const col = c[1].match(/r="([A-Z]+)\d+"/)[1];
  const t = c[1].match(/t="(\w+)"/);
  const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/);
  console.log(col + ': ' + (t && t[1] === 's' && v ? ss[parseInt(v[1])] : v ? v[1] : ''));
}
