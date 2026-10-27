// fetchParcelSizes.cjs
// Pulls building/site area data from the RivCo (Riverside County) API
// for the transfer APNs in output/commercial_transfers.csv, and enriches that
// same file in place with the size columns (Rule 2 joins on it directly).
//
// API:  POST https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php
//       body: qtype=assessment_info&field=mv_Location:PIN&value=<APN>
//
// BuildingSf = sum of "Actual Area sqft" across all imprv[] entries (primary).
// SquareFeet = top-level field (cross-check; can differ slightly from the sum).
// Acreage    = top-level "acreage" (site area, acres).
// City       = top-level "District" with the leading code stripped ("004-000 CORONA" -> "CORONA").
// YrBuilt    = primary building detail "Year Built".
// Quality    = primary building detail "Quality".
// Condition  = primary building detail "Cond".
// Found      = 'yes' (record returned) / 'no' (queried, no record) / '' (not queried).
//
// Usage:
//   node fetchParcelSizes.cjs             # fetch ALL APNs (default — every
//                                         # parcel gets property data, priced
//                                         # or not)
//   node fetchParcelSizes.cjs --priced    # only PRICED APNs (Consid > 0)
//   node fetchParcelSizes.cjs --limit 20  # fetch first 20 (testing)
//   node fetchParcelSizes.cjs --missing   # recovery: re-fetch only APNs whose
//                                         # rows currently lack size data

const fs = require('fs');
const path = require('path');

const API_URL = 'https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php';
// The base transfers and the enriched output are the SAME file: this script
// reads the base, fetches sizes, and rewrites it with the size columns added.
// input/ holds only the county master; all derived files live in output/.
const INPUT_CSV = path.join(__dirname, 'output', 'commercial_transfers.csv');
const OUTPUT_CSV = path.join(__dirname, 'output', 'commercial_transfers.csv');
const CONCURRENCY = 10;
const TIMEOUT_MS = 25000;
const MAX_RETRIES = 3;
// Size columns appended to the base transfers (join key: PIN = APN).
const SIZE_COLS = ['Found', 'SquareFeet', 'BuildingSf', 'Acreage', 'ClassCode', 'Address', 'City', 'YrBuilt', 'Quality', 'Condition'];

// ---- CLI args ----
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const PRICED = args.includes('--priced');
const MISSING = args.includes('--missing');

// ---- CSV helpers ----
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
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, '')); return isNaN(n) ? 0 : n; };

// ---- main (async) ----
(async () => {
// ---- read + filter ----
const text = fs.readFileSync(INPUT_CSV, 'utf8');
const rows = parseCsv(text);
const rawHeader = rows[0];
const rawData = rows.slice(1);
// --missing: capture the size data already in the file (keyed by APN) so the
// rewrite can keep it for APNs we are not re-fetching.
const existingSizes = {};
if (MISSING) {
  const colIdx = {};
  SIZE_COLS.forEach(c => { colIdx[c] = rawHeader.indexOf(c); });
  const pinCol = rawHeader.indexOf('PIN');
  for (const r of rawData) {
    const apn = (r[pinCol] || '').trim();
    // Capture any APN with a non-empty Found marker ('yes' or 'no') so the
    // rewrite can preserve it for APNs we are not re-fetching.
    if (!apn || existingSizes[apn] || (r[colIdx['Found']] || '').trim() === '') continue;
    existingSizes[apn] = SIZE_COLS.map(c => r[colIdx[c]] ?? '');
  }
}
// Idempotency: drop any size columns from a previously-enriched file so a
// re-run re-derives them from the API instead of duplicating the columns.
const keepIdx = [];
rawHeader.forEach((h, i) => { if (!SIZE_COLS.includes(h)) keepIdx.push(i); });
const header = keepIdx.map(i => rawHeader[i]);
const dataRows = rawData.map(r => keepIdx.map(i => r[i]));
const pinIdx = header.indexOf('PIN');
const considIdx = header.indexOf('Consid');
if (pinIdx < 0 || considIdx < 0) { console.error('Missing PIN/Consid columns. Header:', header.join(',')); process.exit(1); }

const seen = new Set();
const apns = [];
for (const r of dataRows) {
  if (PRICED && num(r[considIdx]) <= 0) continue; // --priced: skip no-value rows
  const apn = (r[pinIdx] || '').trim();
  if (!apn || seen.has(apn)) continue;
  if (MISSING && existingSizes[apn] && existingSizes[apn][SIZE_COLS.indexOf('Found')] === 'yes') continue; // already enriched
  seen.add(apn);
  apns.push(apn);
}
const apnList = apns.slice(0, LIMIT);
console.log('Input rows:', dataRows.length, '| scope:', (PRICED ? 'priced only' : 'ALL') + (MISSING ? ' (missing only)' : ''), '| unique APNs:', apns.length, '| fetching:', apnList.length);
if (apnList.length === 0) { console.log('Nothing to fetch.'); process.exit(0); }

// ---- fetch one APN ----
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
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = JSON.parse(await res.text());
      if (!Array.isArray(j) || !j[0]) return { apn, found: false };
      const p = j[0];
      let buildingSf = 0;
      let yrBuilt = '', quality = '', condition = '';
      if (Array.isArray(p.imprv)) {
        for (const b of p.imprv) {
          const a = (b.details || []).find(d => d.label === 'Actual Area sqft');
          if (a) buildingSf += num(a.value);
        }
        // Primary building (first entry) carries year built / quality / condition.
        const det = (p.imprv[0] && p.imprv[0].details) || [];
        const yb = det.find(d => d.label === 'Year Built');
        if (yb) yrBuilt = yb.value;
        const q = det.find(d => d.label === 'Quality');
        if (q) quality = q.value;
        const c = det.find(d => d.label === 'Cond');
        if (c) condition = c.value;
      }
      // City: strip the leading district code ("004-000 CORONA" -> "CORONA").
      const city = p.District ? String(p.District).split(' ').slice(1).join(' ') : '';
      return {
        apn, found: true,
        squareFeet: p.SquareFeet ?? '',
        buildingSf,
        acreage: p.acreage ?? '',
        classCode: p.class_code ?? '',
        address: p.address ?? '',
        city,
        yrBuilt,
        quality,
        condition,
        raw: p, // full RivCo response (sales history, assessment history, shape, ...)
      };
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

// ---- save the FULL RivCo response per APN (output/parcel_data.json) ----
// Merged with any existing file so --missing runs don't drop APNs that were
// not re-fetched this run.
const PARCEL_DATA = path.join(__dirname, 'output', 'parcel_data.json');
let parcelData = {};
try { parcelData = JSON.parse(fs.readFileSync(PARCEL_DATA, 'utf8')); } catch { /* first run */ }
let savedRaw = 0;
for (const r of results) if (r && r.found && r.raw) { parcelData[r.apn] = r.raw; savedRaw++; }
fs.writeFileSync(PARCEL_DATA, JSON.stringify(parcelData), 'utf8');

// ---- write combined output (base columns + size columns) ----
// Build a size lookup keyed by APN.
const sizeLookup = {};
for (const r of results) sizeLookup[r.apn] = r;
const sizeVal = (r, col, apn) => {
  if (r && r.found) {
    switch (col) {
      case 'Found': return 'yes';
      case 'SquareFeet': return r.squareFeet ?? '';
      case 'BuildingSf': return r.buildingSf ?? '';
      case 'Acreage': return r.acreage ?? '';
      case 'ClassCode': return r.classCode ?? '';
      case 'Address': return r.address ?? '';
      case 'City': return r.city ?? '';
      case 'YrBuilt': return r.yrBuilt ?? '';
      case 'Quality': return r.quality ?? '';
      case 'Condition': return r.condition ?? '';
      default: return '';
    }
  }
  if (col === 'Found' && r) return 'no'; // queried this run, no record
  // --missing: keep the file's existing size data for APNs not re-fetched.
  // (keyed by the row's APN — r is undefined for APNs not fetched this run)
  if (MISSING && existingSizes[apn]) return existingSizes[apn][SIZE_COLS.indexOf(col)];
  return '';
};
const outHeader = [...header, ...SIZE_COLS];
const outLines = [outHeader.join(',')];
for (const r of dataRows) {
  const apn = (r[pinIdx] || '').trim();
  const size = sizeLookup[apn];
  const row = [...r];
  for (const col of SIZE_COLS) row.push(sizeVal(size, col, apn));
  outLines.push(row.map(csvField).join(','));
}
fs.writeFileSync(OUTPUT_CSV, outLines.join('\r\n') + '\r\n', 'utf8');

// ---- summary ----
const found = results.filter(r => r.found).length;
const withBldg = results.filter(r => r.found && r.buildingSf > 0).length;
console.log('\nWrote', OUTPUT_CSV, '(' + dataRows.length + ' rows, ' + outHeader.length + ' cols)');
console.log('  fetched:', results.length, '| found:', found, '| with building SF:', withBldg, '| not found:', results.length - found);
console.log('  parcel data:', savedRaw, 'saved ->', PARCEL_DATA, '(' + Object.keys(parcelData).length + ' total)');
console.log('  elapsed:', Math.round((Date.now() - t0) / 1000) + 's');
})();
