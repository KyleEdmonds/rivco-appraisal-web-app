// Quick test: confirm the RivCo API is reachable from Node and inspect the response shape.
// Usage: node _test_api.cjs [APN]
(async () => {
  const apn = process.argv[2] || '119301026';
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'qtype=assessment_info&field=mv_Location:PIN&value=' + encodeURIComponent(apn),
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log('Status:', res.status, '| Time:', (Date.now() - t0) + 'ms', '| Len:', text.length);
    const j = JSON.parse(text);
    console.log('Array length:', j.length);
    if (!j[0]) { console.log('(no data for this APN)'); return; }
    const p = j[0];
    console.log('Account:', p.Account);
    console.log('SquareFeet:', p.SquareFeet);
    console.log('acreage:', p.acreage);
    console.log('class_code:', p.class_code);
    console.log('address:', p.address);
    console.log('imprv count:', p.imprv ? p.imprv.length : 0);
    let sum = 0;
    if (p.imprv) for (const b of p.imprv) {
      const a = (b.details || []).find(d => d.label === 'Actual Area sqft');
      const v = a ? parseInt(String(a.value).replace(/[^0-9]/g, ''), 10) : 0;
      sum += v;
      console.log('  ' + b.BuildingName + ' -> Actual Area sqft:', a ? a.value : '(none)');
    }
    console.log('SUM Actual Area sqft:', sum);
  } catch (e) {
    console.log('ERR:', e.message);
  }
})();
