// Dev-only: dump the full RivCo API response structure for an APN so we can
// locate quality / condition / legal description / year built fields.
// Usage: node _dump_api.cjs [APN]
async function getJson(apn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch('https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'qtype=assessment_info&field=mv_Location:PIN&value=' + encodeURIComponent(apn),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return JSON.parse(await res.text());
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
(async () => {
  const apn = process.argv[2] || '119301026';
  const j = await getJson(apn);
  if (!j[0]) { console.log('no data for', apn); return; }
  const p = j[0];
  console.log('=== TOP-LEVEL KEYS (' + apn + ') ===');
  for (const k of Object.keys(p)) {
    const v = p[k];
    const isObj = v !== null && typeof v === 'object';
    console.log('  ' + k + ': ' + (isObj ? ('[' + (Array.isArray(v) ? 'array len ' + v.length : 'object') + ']') : JSON.stringify(v)));
  }
  console.log('=== IMPRV DETAILS (label = value) ===');
  if (Array.isArray(p.imprv)) {
    for (const b of p.imprv) {
      console.log('  Building: ' + b.BuildingName);
      for (const d of (b.details || [])) console.log('    ' + d.label + ' = ' + d.value);
    }
  }
})();
