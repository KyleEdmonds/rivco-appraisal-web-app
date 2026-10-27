// fetchParcelData.cjs
// Fetch the FULL RivCo assessment record for every APN in the converted
// transfers CSV that is not yet in output/parcel_data.json, and merge the
// results into that file. Does NOT rewrite the CSV — convert_input.py
// regenerates the CSV from input/ + parcel_data.json, so this script only
// grows the parcel cache.
//
// API:  POST https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php
//       body: qtype=assessment_info&field=mv_Location:PIN&value=<APN>
//
// Usage:
//   node fetchParcelData.cjs                 # fetch APNs missing from the cache
//   node fetchParcelData.cjs --limit 20      # fetch first 20 (testing)
//   node fetchParcelData.cjs other.csv       # use a different CSV (needs a PIN column)
//
// Idempotent: APNs already in parcel_data.json are skipped, so re-runs only
// fill the gaps. APNs the API has no record for are retried on the next run.

const fs = require('fs');
const path = require('path');

const API_URL = 'https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php';
const cliArgs = process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith('--') && !(arr[i - 1] === '--limit'));
const CSV_PATH = path.resolve(__dirname, cliArgs[0] || path.join('output', 'completed_transfers_2025_2026.csv'));
const PARCEL_DATA = path.join(__dirname, 'output', 'parcel_data.json');
const CONCURRENCY = 10;
const TIMEOUT_MS = 25000;
const MAX_RETRIES = 3;

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// ---- CSV helpers (same as fetchParcelSizes.cjs) ----
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

// ---- main (async) ----
(async () => {
// ---- read APN list ----
const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
const header = rows[0];
const pinIdx = header.indexOf('PIN');
if (pinIdx < 0) { console.error('Missing PIN column. Header:', header.join(',')); process.exit(1); }
const seen = new Set();
const allApns = [];
for (const r of rows.slice(1)) {
  const apn = (r[pinIdx] || '').trim();
  if (!apn || seen.has(apn)) continue;
  seen.add(apn);
  allApns.push(apn);
}

// ---- load existing cache, keep only what's missing ----
let parcelData = {};
try { parcelData = JSON.parse(fs.readFileSync(PARCEL_DATA, 'utf8')); } catch { /* first run */ }
const apnList = allApns.filter(a => !parcelData[a]).slice(0, LIMIT);
console.log('CSV:', path.basename(CSV_PATH), '| unique APNs:', allApns.length,
  '| cached:', allApns.length - allApns.filter(a => !parcelData[a]).length,
  '| fetching:', apnList.length);
if (apnList.length === 0) { console.log('Nothing to fetch.'); process.exit(0); }

// ---- fetch one APN (full record, same API as fetchParcelSizes.cjs) ----
async function fetchApn(apn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: 'qtype=assessment_info&field=mv_Location:PIN&value=' + encodeURIComponent(apn),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = JSON.parse(await res.text());
      if (!Array.isArray(j) || !j[0]) return { apn, found: false };
      return { apn, found: true, raw: j[0] };
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

// ---- merge into the cache (never drop existing APNs) ----
let saved = 0, notFound = 0, errors = 0;
for (const r of results) {
  if (r && r.found && r.raw) { parcelData[r.apn] = r.raw; saved++; }
  else if (r && r.error) errors++;
  else notFound++;
}
fs.writeFileSync(PARCEL_DATA, JSON.stringify(parcelData), 'utf8');
console.log('\nfetched:', results.length, '| found:', saved, '| no record:', notFound, '| errors:', errors);
console.log('parcel_data.json now has', Object.keys(parcelData).length, 'parcels');
console.log('elapsed:', Math.round((Date.now() - t0) / 1000) + 's');
console.log('next: python convert_input.py  (regenerates the CSV from the fuller cache)');
})();
