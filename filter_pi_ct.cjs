// One-off: remove rows whose ClassCode or ClassCdDescr starts with PI or CT
// from output/commercial_transfers.csv, preserving the original line format.
const fs = require('fs');
const path = 'c:/rivco_appraisal_web_app/output/commercial_transfers.csv';
const raw = fs.readFileSync(path, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

const header = parseCsvLine(lines[0]);
const classCodeIdx = header.indexOf('ClassCode');
const classDescrIdx = header.indexOf('ClassCdDescr');
if (classCodeIdx < 0 || classDescrIdx < 0) {
  console.error('Missing ClassCode/ClassCdDescr column. Aborting.');
  process.exit(1);
}

const kept = [lines[0]];
let removed = 0;
for (let i = 1; i < lines.length; i++) {
  const f = parseCsvLine(lines[i]);
  const code = (f[classCodeIdx] || '').trim();
  const descr = (f[classDescrIdx] || '').trim();
  if (/^(PI|CT)/.test(code) || /^(PI|CT)/.test(descr)) removed++;
  else kept.push(lines[i]);
}
fs.writeFileSync(path, kept.join(eol), 'utf8');
console.log(`Removed: ${removed}, Kept: ${kept.length - 1}, EOL: ${JSON.stringify(eol)}`);
