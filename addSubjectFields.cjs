// addSubjectFields.cjs
// Appends the four SUBJECT INFO fields that the RivCo API provides but the
// current output/commercial_transfers.csv is missing:
//
//   City       = top-level "District" with the leading code stripped
//                ("004-000 CORONA" -> "CORONA")
//   YrBuilt    = primary building detail "Year Built"
//   Quality    = primary building detail "Quality"
//   Condition  = primary building detail "Cond"
//
// It is TARGETED and SAFE:
//   * It reads the existing CSV and preserves every existing column verbatim
//     (Rule 2 keeps working — no re-derivation of the size columns).
//   * It only APPENDS the four new columns.
//   * It is IDEMPOTENT: if any of the four columns already exist it exits
//     without touching the file.
//
// API:  POST https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php
//       body: qtype=assessment_info&field=mv_Location:PIN&value=<APN>
//
// Usage:
//   node addSubjectFields.cjs              # add the 4 fields to every row
//   node addSubjectFields.cjs --limit 20   # fetch first 20 APNs (testing)
//   node addSubjectFields.cjs --dry-run    # fetch + report, do NOT write
//
// Requires network access to the RivCo API (the app itself makes no external
// calls; this is a dev-only enrichment step, like fetchParcelSizes.cjs).

const fs = require('fs');
const path = require('path');

const API_URL = 'https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php';
const CSV_PATH = path.join(__dirname, 'output', 'commercial_transfers.csv');
const CONCURRENCY = 10;
const TIMEOUT_MS = 25000;
const MAX_RETRIES = 3;
// The four columns this script appends (join key: PIN = APN).
const NEW_COLS = ['City', 'YrBuilt', 'Quality', 'Condition'];

// ---- CLI args ----
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const DRY_RUN = args.includes('--dry-run');

// ---- CSV helpers (same semantics as fetchParcelSizes.cjs) ----
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

// ---- main (async) ----
(async () => {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  const header = rows[0];
  const dataRows = rows.slice(1);

  // Idempotency: if any of the new columns already exist, do nothing.
  const present = NEW_COLS.filter(c => header.includes(c));
  if (present.length) {
    console.log('Already present: ' + present.join(', ') + ' — nothing to do.');
    process.exit(0);
  }

  const pinIdx = header.indexOf('PIN');
  if (pinIdx < 0) { console.error('Missing PIN column. Header:', header.join(',')); process.exit(1); }

  // Collect unique APNs in row order (dedupe so we fetch each APN once).
  const seen = new Set();
  const apns = [];
  for (const r of dataRows) {
    const apn = (r[pinIdx] || '').trim();
    if (!apn || seen.has(apn)) continue;
    seen.add(apn);
    apns.push(apn);
  }
  const apnList = apns.slice(0, LIMIT);
  console.log('Rows:', dataRows.length, '| unique APNs:', apns.length, '| fetching:', apnList.length, DRY_RUN ? '(dry-run)' : '');
  if (apnList.length === 0) { console.log('Nothing to fetch.'); process.exit(0); }

  // ---- fetch one APN, extract the four fields ----
  async function fetchApn(apn) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'qtype=assessment_info&field=mv_Location:PIN&value=' + encodeURIComponent(apn),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const j = await res.json();
        if (!Array.isArray(j) || !j[0]) return { apn, found: false };
        const p = j[0];
        let yrBuilt = '', quality = '', condition = '';
        if (Array.isArray(p.imprv) && p.imprv[0]) {
          const det = p.imprv[0].details || [];
          const yb = det.find(d => d.label === 'Year Built');
          if (yb) yrBuilt = yb.value;
          const q = det.find(d => d.label === 'Quality');
          if (q) quality = q.value;
          const c = det.find(d => d.label === 'Cond');
          if (c) condition = c.value;
        }
        // City: strip the leading district code ("004-000 CORONA" -> "CORONA").
        const city = p.District ? String(p.District).split(' ').slice(1).join(' ') : '';
        return { apn, found: true, city, yrBuilt, quality, condition };
      } catch (e) {
        clearTimeout(timer);
        if (attempt === MAX_RETRIES - 1) return { apn, found: false, error: e.message };
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }


  // ---- concurrency pool ----
  const results = new Array(apnList.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < apnList.length) {
      const i = next++;
      results[i] = await fetchApn(apnList[i]);
      if (++done % 100 === 0) console.log('  progress:', done, '/', apnList.length, '(' + Math.round((Date.now() - t0) / 1000) + 's)');
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, apnList.length) }, worker));

  // ---- build the lookup and append the four columns ----
  const lookup = {};
  for (const r of results) lookup[r.apn] = r;
  const val = (apn, key) => {
    const r = lookup[apn];
    if (r && r.found) return r[key] ?? '';
    return '';
  };

  const outHeader = [...header, ...NEW_COLS];
  const outLines = [outHeader.join(',')];
  for (const r of dataRows) {
    const apn = (r[pinIdx] || '').trim();
    const row = [...r, val(apn, 'city'), val(apn, 'yrBuilt'), val(apn, 'quality'), val(apn, 'condition')];
    outLines.push(row.map(csvField).join(','));
  }

  const found = results.filter(r => r.found).length;
  console.log('\nFetched:', results.length, '| found:', found, '| not found:', results.length - found, '| elapsed:', Math.round((Date.now() - t0) / 1000) + 's');
  console.log('New header:', outHeader.join(','));

  if (DRY_RUN) {
    console.log('\n(dry-run) not writing. Sample rows:');
    for (let i = 1; i <= 5 && i < outLines.length; i++) console.log('  ' + outLines[i]);
    return;
  }

  fs.writeFileSync(CSV_PATH, outLines.join('\r\n') + '\r\n', 'utf8');
  console.log('\nWrote', CSV_PATH, '(' + dataRows.length + ' rows, ' + outHeader.length + ' cols)');
  console.log('First 5 data rows:');
  for (let i = 1; i <= 5 && i < outLines.length; i++) console.log('  ' + outLines[i]);
})();

