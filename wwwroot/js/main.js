// ---------------------------------------------------------------------------
// main.js — bootstrap: top bar, list view, split-pane appraisal view
// Left pane: control bar (dates + APN search) + tabbed form
// Right pane: report staging. Draggable split handle between them.
// ---------------------------------------------------------------------------
import { api, state, saveCurrent, loadAppraisal, newAppraisal, fmtCurrency, fmtDate, computeAppraisal } from './core.js';
import { renderForm, setTab, loadRepo } from './form.js';
import { renderReport, exportPDF, fitSheets, zoomBy, zoomFit } from './report.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg, isError = false) {
  const t = el('div', { class: `toast ${isError ? 'error' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

// --- top bar -----------------------------------------------------------------

function renderTopBar() {
  const bar = document.getElementById('topbar');
  const d = state.data;
  const tbDateGroup = (label, path) => {
    const [parent, key] = path.split('.');
    const input = el('input', { class: 'tb-d-input', type: 'date' });
    input.value = d[parent][key] || '';
    input.addEventListener('change', () => {
      d[parent][key] = input.value;
      state.dirty = true;
      renderReport();
      refreshTopBar();
    });
    return el('div', { class: 'tb-d-group' },
      el('div', { class: 'tb-d-label' }, label),
      input,
    );
  };
  bar.replaceChildren(
    el('div', { class: 'tb-left' },
      el('img', { class: 'tb-seal', src: state.tenant.sealUrl || '/img/seal.png', alt: '' }),
      el('div', { class: 'tb-title' },
        el('div', { class: 'tb-county' }, state.tenant.countyName || 'County of Riverside'),
        el('div', { class: 'tb-office' }, state.tenant.officeName || 'Appraisal Workbench'),
      ),
    ),
    el('div', { class: 'tb-dates' },
      tbDateGroup('Effective Date', 'property.effectiveDate'),
      tbDateGroup('Report Date', 'property.reportDate'),
    ),
    el('div', { class: 'tb-apn' },
      el('div', { class: 'tb-d-label' }, 'APN / Address'),
      apnSearchBox(),
    ),
    el('div', { class: 'tb-center' },
      el('div', { class: 'tb-headline' },
        el('div', { class: 'addr', id: 'tb-addr' }, '—'),
        el('div', { class: 'sub', id: 'tb-sub' }, ''),
      ),
      el('div', { class: 'tb-divider' }),
      el('div', { class: 'tb-value' },
        el('div', { class: 'label' }, 'Total Assessed'),
        el('div', { class: 'num', id: 'tb-value' }, '—'),
      ),
    ),
    el('div', { class: 'tb-actions' },
      el('button', { class: 'btn', id: 'btn-list' }, 'List'),
      el('button', { class: 'btn', id: 'btn-new' }, '+ New'),
      el('button', { class: 'btn primary', id: 'btn-save' }, state.dirty ? 'Save ●' : 'Save'),
      el('button', { class: 'btn', id: 'btn-pdf' }, 'PDF'),
      el('button', { class: 'btn', id: 'btn-rule2', title: 'Rule 2 batch evaluation over the county transfer file' }, 'Rule 2'),
    ),
  );
  document.getElementById('btn-list').onclick = showList;
  document.getElementById('btn-rule2').onclick = showRule2;
  document.getElementById('btn-new').onclick = () => { newAppraisal(); showAppraisal(); };
  document.getElementById('btn-save').onclick = onSave;
  document.getElementById('btn-pdf').onclick = async () => {
    try { await exportPDF(); } catch (e) { toast(`PDF failed: ${e.message}`, true); }
  };
}

// Keep the top-bar headline + total assessed in sync with the form.
export function refreshTopBar() {
  const d = state.data;
  const addr = document.getElementById('tb-addr');
  const sub = document.getElementById('tb-sub');
  const val = document.getElementById('tb-value');
  if (addr) addr.textContent = d.property.address || d.property.apn || '—';
  if (sub) sub.textContent = [d.property.city, d.property.apn].filter(Boolean).join(' · ');
  if (val) val.textContent = fmtCurrency(computeAppraisal(d).totalAssessed);
}

async function onSave() {
  try {
    await saveCurrent();
    renderTopBar();
    toast('Saved');
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

// --- list view ----------------------------------------------------------------

async function showList() {
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let rows;
  try {
    rows = await api.listAppraisals();
  } catch (e) {
    main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`));
    return;
  }
  main.replaceChildren(
    el('div', { class: 'list-view' },
      el('div', { class: 'list-head' },
        el('h2', {}, 'Appraisals'),
        el('button', { class: 'btn primary', onclick: () => { newAppraisal(); showAppraisal(); } }, '+ New Appraisal'),
      ),
      el('table', { class: 'list-table' },
        el('thead', {}, el('tr', {}, ['APN', 'Address', 'City', 'Report Date', 'Final Value', 'Updated', ''].map((h) => el('th', {}, h)))),
        el('tbody', {},
          rows.length === 0
            ? el('tr', {}, el('td', { colspan: 7 }, 'No appraisals yet.'))
            : rows.map((r) => el('tr', { class: 'clickable', onclick: () => openById(r.id) },
                el('td', {}, r.apn || '—'),
                el('td', {}, r.address || '—'),
                el('td', {}, r.city || '—'),
                el('td', {}, r.reportDate ? fmtDate(r.reportDate) : '—'),
                el('td', { class: 'num' }, r.finalValue != null ? fmtCurrency(r.finalValue) : '—'),
                el('td', {}, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'),
                el('td', {}, el('button', {
                  class: 'btn tiny danger',
                  onclick: (e) => {
                    e.stopPropagation();
                    if (!confirm('Delete this appraisal?')) return;
                    api.deleteAppraisal(r.id).then(() => showList()).catch((err) => toast(err.message, true));
                  },
                }, 'Delete')),
              )),
        ),
      ),
    ),
  );
}


// --- Rule 2 batch view ---------------------------------------------------------
// Screens the county transfer file (input/) for commercial classes and
// archives auto-enrolled sales to the transfer comp repository.

const R2_BUCKETS = [
  ['auto_enrolled', 'Auto-Enrolled', 'price corroborated by same-class peers — enroll at sale price'],
  ['borderline', 'Borderline', 'closest peer within 15% — review'],
  ['below_market', 'Below Market', 'presumption rebutted — sold below peer average'],
  ['above_market', 'Above Market', 'presumption rebutted — sold above peer average'],
  ['land_review', 'Land Review', 'land gate failed (2% / 2 peers) — mass appraisal queue'],
  ['no_value', 'No-Value', 'zero consideration — classified by transfer type (LocalRatioCd)'],
];

async function showRule2() {
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let status;
  try { status = await api.rule2Status(); }
  catch (e) {
    main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`));
    return;
  }
  const file = (status.files || [])[0];
  const last = status.lastRun;
  main.replaceChildren(
    el('div', { class: 'rule2-view' },
      el('div', { class: 'list-head' },
        el('h2', {}, 'Rule 2 Batch Evaluation'),
        el('span', { class: 'r2-sub' }, 'Commercial classes · Rule 2(b) full cash value screen'),
        el('button', { class: 'btn primary', id: 'r2-run' }, '▶ Run Batch'),
      ),
      el('div', { class: 'r2-input' },
        file
          ? el('div', {},
              el('b', {}, file.name),
              el('span', {}, ` · ${(file.size / 1048576).toFixed(1)} MB · modified ${new Date(file.lastWrite).toLocaleString()}`),
            )
          : el('div', { class: 'r2-none' }, 'No transfer file in input/ — drop the county .xlsx or .csv there and reload.'),
      ),
      last ? renderR2Summary(last.summary) : el('div', { class: 'r2-none' }, 'No batch run yet.'),
      el('div', { class: 'r2-comps' },
        `Transfer comp repository: ${status.transferCompCount} auto-enrolled sales (permanent, server-side, read-only)`),
    ),
  );
  document.getElementById('r2-run').onclick = onRule2Run;
}

function renderR2Summary(s) {
  // The stored run summary is serialized by the server with PascalCase keys
  // (SourceFile, TotalRows, …) while the run endpoint emits camelCase. Read
  // both so any stored run renders, and coerce numbers NaN-safely.
  const pick = (camel, pascal) => (s[camel] ?? s[pascal]);
  const buckets = s.buckets ?? s.Buckets ?? {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const rows = R2_BUCKETS.map(([key, label, desc]) =>
    el('tr', {},
      el('td', {}, el('span', { class: `r2-badge ${key}` }, label)),
      el('td', { class: 'num' }, String(buckets[key] ?? 0)),
      el('td', { class: 'r2-desc' }, desc),
      el('td', {}, el('a', { class: 'btn tiny', href: `/api/rule2/buckets/${key}` }, '⬇ CSV')),
    ));
  return el('div', { class: 'r2-summary' },
    el('div', { class: 'r2-meta' },
      `Source: ${pick('sourceFile', 'SourceFile') || '—'} · ${num(pick('totalRows', 'TotalRows')).toLocaleString()} rows · ${num(pick('commercialRows', 'CommercialRows')).toLocaleString()} commercial · ${num(pick('marketSales', 'MarketSales')).toLocaleString()} market sales · ${num(pick('noValue', 'NoValue')).toLocaleString()} no-value`),
    el('table', { class: 'list-table' },
      el('thead', {}, el('tr', {}, ['Bucket', 'Count', 'Meaning', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows),
    ),
  );
}

async function onRule2Run() {
  if (!confirm('Run the Rule 2 batch over the county transfer file?\n\nAuto-enrolled commercial sales will be archived to the transfer comp repository (duplicates are skipped).')) return;
  const btn = document.getElementById('r2-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const res = await api.rule2Run();
    toast(`Rule 2 complete in ${(res.durationMs / 1000).toFixed(1)}s — ${res.summary.buckets.auto_enrolled} auto-enrolled · ${res.inserted} new comps · ${res.deduplicated} duplicates skipped.`);
    showRule2();
  } catch (e) {
    toast(`Rule 2 run failed: ${e.message}`, true);
    btn.disabled = false;
    btn.textContent = '▶ Run Batch';
  }
}

async function openById(id) {
  try {
    await loadAppraisal(id);
    showAppraisal();
  } catch (e) {
    toast(`Open failed: ${e.message}`, true);
  }
}

// --- appraisal view: split pane with drag slider -------------------------------

let apnInput = '';
let apnSugg = [];
let apnTimer = null;

function apnSearchBox() {
  const box = el('div', { class: 'apn-box' });
  const input = el('input', { placeholder: 'Search APN or address…' });
  input.value = apnInput;
  const count = el('span', { class: 'apn-count' }, '');
  const sugg = el('div', { class: 'sugg', style: 'display:none' });

  const renderSugg = () => {
    if (apnSugg.length === 0) { sugg.style.display = 'none'; sugg.replaceChildren(); return; }
    sugg.style.display = 'block';
    sugg.replaceChildren(apnSugg.map((r) => el('button', {
      onclick: () => {
        apnInput = r.apn || '';
        input.value = apnInput;
        apnSugg = [];
        sugg.style.display = 'none';
        openById(r.id);
      },
    },
      el('span', { class: 's-apn' }, r.apn || '—'),
      el('span', { class: 's-addr' }, r.address || ''),
    )));
  };

  input.addEventListener('input', () => {
    apnInput = input.value;
    clearTimeout(apnTimer);
    const q = apnInput.trim();
    if (q.length < 1) { apnSugg = []; renderSugg(); return; }
    apnTimer = setTimeout(async () => {
      try {
        const rows = await api.listAppraisals();
        const lq = q.toLowerCase();
        apnSugg = rows
          .filter((r) => String(r.apn || '').toLowerCase().includes(lq) || String(r.address || '').toLowerCase().includes(lq))
          .slice(0, 20);
      } catch { apnSugg = []; }
      renderSugg();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { apnSugg = []; renderSugg(); }
  });
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target)) { apnSugg = []; renderSugg(); }
  });
  box.append(input, count, sugg);
  return box;
}

// Right-pane staging toolbar (matches the original Report Preview bar).
function stagingToolbar() {
  const pct = el('span', { class: 'zoom-pct' }, '100%');
  const btn = (label, title, fn) => {
    const b = el('button', { class: 'st-btn', title });
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  return el('div', { class: 'staging-toolbar' },
    el('div', { class: 'st-left' },
      el('span', { class: 'st-title' }, 'Report Preview'),
      el('span', { class: 'st-meta' }, '— sheets · 8.5×11'),
    ),
    el('div', { class: 'st-right' },
      el('button', { class: 'st-btn finalize', title: 'Save this appraisal and archive it as a permanent sales comp', onclick: onFinalize }, '✓ Finalize & Save to Archive'),
      btn('−', 'Zoom out', () => zoomBy(-0.1)),
      pct,
      btn('+', 'Zoom in', () => zoomBy(0.1)),
      btn('Fit', 'Fit to width', zoomFit),
    ),
  );
}

// Finalize: save the appraisal, then archive it as a permanent sales comp
// (server-side). Every finalized appraisal becomes exactly one permanent comp;
// re-finalizing identical content is deduplicated.
async function onFinalize() {
  if (!confirm('Finalize this appraisal?\n\nIt will be saved and archived as a permanent sales comp, available to all future appraisals.')) return;
  try {
    const id = await saveCurrent();
    const res = await api.finalize(id, state.data);
    if (res.deduplicated) {
      toast('Already archived — identical content (duplicate).');
    } else {
      toast(`Finalized — permanent comp archived (${String(res.contentHash).slice(0, 8)}… · ${res.compCount} total).`);
    }
    loadRepo();
  } catch (e) {
    toast(`Finalize failed: ${e.message}`, true);
  }
}

function showAppraisal() {
  const main = document.getElementById('main');
  const left = el('div', { class: 'pane pane-left' },
    el('div', { id: 'form-root', class: 'form-root', style: 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column' }),
  );
  const handle = el('div', { class: 'split-handle' });
  const right = el('div', { class: 'pane pane-right' },
    stagingToolbar(),
    el('div', { id: 'report-root', class: 'report-root', style: 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column' }),
  );
  const split = el('div', { class: 'split' }, left, handle, right);
  main.replaceChildren(split);

  // Drag slider
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), 320), window.innerWidth - 480);
      left.style.width = `${w}px`;
      left.style.flex = '0 0 auto';
      fitSheets();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  renderForm();
  renderReport();
  refreshTopBar();
}

// --- boot ----------------------------------------------------------------------

async function boot() {
  try {
    state.tenant = await api.getTenant();
  } catch { /* neutral tenant */ }
  renderTopBar();
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'list') { showList(); return; }
  const tab = params.get('tab');
  if (tab) setTab(tab);
  // Landing page is the appraisal workspace: open the most recent appraisal,
  // or a blank new one if none exist.
  let rows = [];
  try { rows = await api.listAppraisals(); } catch { /* offline data */ }
  if (rows.length > 0) { openById(rows[0].id); return; }
  newAppraisal();
  showAppraisal();
}

// Form edits update the top-bar headline + total assessed.
window.addEventListener('appraisal:changed', refreshTopBar);

// Warn on unload with unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Re-fit report sheets when the window resizes.
window.addEventListener('resize', () => {
  if (document.getElementById('report-root')) fitSheets();
});

boot();