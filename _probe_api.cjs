// Dev-only: replicate the exact browser XHR for one APN (full headers).
// Usage: node _probe_api.cjs [APN]
const fs = require('fs');
const APIS = 'https://rivcoview.rivcoacr.org/data/ajaxcalls/db/getData.php';
const apn = process.argv[2] || '107350009';
const body = 'qtype=assessment_info&field=mv_Location%3APIN&value=' + apn;
(async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(APIS, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://rivcoview.rivcoacr.org',
        'Referer': 'https://rivcoview.rivcoacr.org/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    console.log('OK', r.status, Date.now() - t0 + 'ms', t.length + 'chars');
    fs.writeFileSync('_api_' + apn + '.json', t, 'utf8');
  } catch (e) {
    console.log('FAIL', Date.now() - t0 + 'ms', e.message, e.cause ? ('| ' + (e.cause.message || e.cause.code)) : '');
  }
})();



