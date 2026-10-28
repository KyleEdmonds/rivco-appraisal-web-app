// ---------------------------------------------------------------------------
// main.js — bootstrap: top bar, list view, split-pane appraisal view
// Left pane: control bar (dates + APN search) + tabbed form
// Right pane: report staging. Draggable split handle between them.
// ---------------------------------------------------------------------------
import { api, state, saveCurrent, loadAppraisal, newAppraisal, fmtCurrency, fmtNumber, fmtAcresNum, titleCase, fmtDate, computeAppraisal, scheduleAutosave, exportWip, importWip, workspace, activeTab, addTab, closeTab } from './core.js';
import { renderForm, setTab, loadRepo } from './form.js';
import { renderReport, fitSheets, zoomBy, zoomFit } from './report.js';

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

// The cover setup bar's APN/Address search box is injected here (not in
// form.js) because it needs the navigation callbacks that live in this module.
// form.js dispatches `form:rendered` after every render; the slot only exists
// on the Cover tab, so we fill it whenever it's present.
function injectCoverSearch() {
  const slot = document.getElementById('cover-search-slot');
  if (!slot) return;
  slot.replaceChildren(apnSearchBox());
}
document.addEventListener('form:rendered', injectCoverSearch);

// --- top bar -----------------------------------------------------------------

// Rule 2 batch is a goal, not yet rebuilt on the new bucketing model — the
// top-bar button is hidden for now. Flip to true to restore it.
const RULE2_ENABLED = false;

function renderTopBar() {
  const bar = document.getElementById('topbar');
  bar.replaceChildren(
    el('div', { class: 'tb-left' },
      el('img', { class: 'tb-seal', src: state.tenant.sealUrl || '/img/seal.png', alt: '' }),
      el('div', { class: 'tb-title' },
        el('div', { class: 'tb-county' }, state.tenant.countyName || 'County of Riverside'),
        el('div', { class: 'tb-office' }, state.tenant.officeName || 'Appraisal Workbench'),
      ),
    ),
    el('div', { class: 'tb-right' },
      el('div', { class: 'tb-headline' },
        el('div', { class: 'addr', id: 'tb-addr' }, '—'),
        el('div', { class: 'sub', id: 'tb-sub' }, ''),
      ),
      el('div', { class: 'tb-value' },
        el('div', { class: 'label' }, 'Total Assessed'),
        el('div', { class: 'num', id: 'tb-value' }, '—'),
      ),
      el('span', { class: 'tb-sep' }),
      el('div', { class: 'tb-group' },
        el('button', { class: 'btn', id: 'btn-main', title: 'Back to the main landing page', onclick: goMain }, '← Main'),
      ),
      ...(RULE2_ENABLED ? [
        el('div', { class: 'tb-group' },
          el('button', { class: 'btn', id: 'btn-rule2', title: 'Rule 2 batch evaluation and transfer work queues' }, 'Rule 2'),
        ),
      ] : []),
      el('div', { class: 'tb-group' },
        el('button', { class: 'btn', id: 'btn-new' }, '+ New'),
        el('span', { class: 'save-status', id: 'save-status' }, ''),
        el('button', { class: 'btn', id: 'btn-print' }, 'Print'),
      ),
      el('div', { class: 'tb-group wip-wrap' },
        el('button', { class: 'btn', id: 'btn-wip', title: 'More' }, '⋯'),
        el('div', { class: 'wip-menu', id: 'wip-menu' },
          el('button', { class: 'wip-item', id: 'btn-wip-export', title: 'Export work-in-progress as a JSON file' }, 'Export WIP…'),
          el('button', { class: 'wip-item', id: 'btn-wip-import', title: 'Import work-in-progress from a JSON file' }, 'Import WIP…'),
        ),
      ),
    ),
  );
  if (RULE2_ENABLED) document.getElementById('btn-rule2').onclick = showRule2;
  document.getElementById('btn-new').onclick = openNew;
  document.getElementById('btn-print').onclick = () => window.print();
  // WIP dropdown: toggle the menu. It closes on outside click via the
  // module-level document handler (bound once, not here, to avoid stacking).
  const wipBtn = document.getElementById('btn-wip');
  const wipMenu = document.getElementById('wip-menu');
  wipBtn.onclick = (e) => { e.stopPropagation(); wipMenu.classList.toggle('open'); };
  document.getElementById('btn-wip-export').onclick = () => {
    try { exportWip(); toast('WIP exported'); } catch (e) { toast(`Export failed: ${e.message}`, true); }
  };
  document.getElementById('btn-wip-import').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const data = await importWip(file);
        if (!confirm('Import this WIP file? It will open in a new tab.')) return;
        state.id = null;
        state.data = data;
        state.dirty = true;
        addTab({ id: null, apn: data.property?.apn || '', address: data.property?.address || '', dirty: true });
        showAppraisal();
        renderTabs();
        scheduleAutosave();
        toast('WIP imported');
      } catch (e) {
        toast(`Import failed: ${e.message}`, true);
      }
    };
    input.click();
  };
}

// Hide the top-bar action buttons (and the appraisal headline/total) on the
// landing page, where they don't apply. Toggled by the view functions.
function setTopBarLanding(on) {
  document.getElementById('topbar')?.classList.toggle('tb-landing', on);
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
    const t = activeTab();
    if (t) { t.id = state.id; t.dirty = false; }
    renderTopBar();
    renderTabs();
    toast('Saved');
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

// --- multi-parcel workspace (open tabs) --------------------------------------

function renderTabs() {
  const root = document.getElementById('tab-strip');
  if (!root) return;
  root.replaceChildren(
    ...workspace.tabs.map((t) => {
      const label = t.apn || t.address || 'New';
      return el('div', {
        class: `ws-tab ${t.key === workspace.activeKey ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`,
        'data-key': String(t.key),
        title: `${label}${t.id === null ? ' (unsaved)' : ''}`,
        onclick: () => switchToTab(t.key),
      },
        el('span', { class: 'ws-tab-label' }, label + (t.dirty ? ' ●' : '')),
        el('button', {
          class: 'ws-tab-close', title: 'Close tab',
          onclick: (e) => { e.stopPropagation(); closeTabFn(t.key); },
        }, '×'),
      );
    }),
    el('button', { class: 'ws-tab-add', title: 'New appraisal', onclick: openNew }, '+'),
  );
}

// Lightweight in-place update of the active tab's label + dirty marker.
function updateTabStrip() {
  const t = activeTab();
  if (!t) return;
  t.apn = state.data?.property?.apn || t.apn;
  t.address = state.data?.property?.address || t.address;
  t.dirty = state.dirty;
  const root = document.getElementById('tab-strip');
  if (!root) return;
  const node = root.querySelector(`.ws-tab[data-key="${t.key}"]`);
  if (!node) { renderTabs(); return; }
  node.classList.toggle('active', t.key === workspace.activeKey);
  node.classList.toggle('dirty', t.dirty);
  const label = node.querySelector('.ws-tab-label');
  if (label) label.textContent = (t.apn || t.address || 'New') + (t.dirty ? ' ●' : '');
}

// Switch to another open tab: persist the current working appraisal (if dirty),
// then load the target. The previously-unsaved tab becomes saved on switch.
async function switchToTab(key) {
  if (key === workspace.activeKey) return;
  const target = workspace.tabs.find((t) => t.key === key);
  if (!target) return;
  const current = activeTab();
  if (state.dirty) {
    try {
      const id = await saveCurrent();
      if (current) { current.id = id; current.dirty = false; }
    } catch (e) { toast(`Save failed: ${e.message}`, true); return; }
  }
  if (target.id !== null) {
    try { await loadAppraisal(target.id); }
    catch (e) { toast(`Open failed: ${e.message}`, true); return; }
  }
  workspace.activeKey = key;
  renderTabs();
  renderForm(); renderReport(); refreshTopBar();
}

// Close a tab. Closing the active tab saves it first (if dirty) and loads the
// next open tab. At least one tab is always kept open.
async function closeTabFn(key) {
  const tab = workspace.tabs.find((t) => t.key === key);
  if (!tab) return;
  if (key !== workspace.activeKey) { closeTab(key); renderTabs(); return; }
  if (workspace.tabs.length <= 1) { toast('Cannot close the only open tab.'); return; }
  if (state.dirty) {
    if (!confirm('Close this tab? Unsaved changes will be saved first.')) return;
    try { await saveCurrent(); } catch (e) { toast(`Save failed: ${e.message}`, true); return; }
  }
  closeTab(key);
  const next = activeTab();
  if (next && next.id !== null) {
    try { await loadAppraisal(next.id); } catch (e) { toast(`Open failed: ${e.message}`, true); return; }
  } else {
    newAppraisal();
  }
  renderTabs(); renderForm(); renderReport(); refreshTopBar();
}

// Open a fresh, empty appraisal in a new tab.
function openNew() {
  newAppraisal();
  addTab({ id: state.id, apn: '', address: '', dirty: state.dirty });
  showAppraisal();
  renderTabs();
}

// Return to the main landing page (workflow selection) from any view —
// workspace, list, PIN page, or Rule 2. Instant (no reload): the open
// workspace tabs and working data are preserved, so nothing is lost.
function goMain() {
  showLanding();
}

// --- landing page (workflow selection) ---------------------------------------
// The workflow-selection page: pick a workflow (new appraisal, the transfer or
// appeal work queue, or continue a saved one). The APN/Address search and the
// Effective/Report dates now live on the appraisal's Cover tab.

async function showLanding() {
  const main = document.getElementById('main');
  let recent = [];
  try { recent = await api.listAppraisals(); } catch { /* offline data */ }

  setTopBarLanding(true);
  main.replaceChildren(
    el('div', { class: 'landing' },
      el('div', { class: 'landing-cards' },
        el('button', { class: 'landing-card primary', onclick: openNew },
          el('div', { class: 'lc-icon' }, '📝'),
          el('div', { class: 'lc-title' }, 'New Appraisal'),
        ),
        el('button', { class: 'landing-card', onclick: () => showWorkQueue('transfers') },
          el('div', { class: 'lc-icon' }, '🏢'),
          el('div', { class: 'lc-title' }, 'Transfer Queue'),
        ),
        el('button', { class: 'landing-card', onclick: () => showWorkQueue('appeals') },
          el('div', { class: 'lc-icon' }, '⚖️'),
          el('div', { class: 'lc-title' }, 'Appeal Queue'),
        ),
      ),
      el('div', { class: 'landing-recent' },
        el('button', { class: 'linklike', onclick: showList },
          `Recent Appraisals${recent.length ? ` (${recent.length} saved)` : ''} →`),
      ),
    ),
  );
}

// --- list view ----------------------------------------------------------------

async function showList() {
  const main = document.getElementById('main');
  setTopBarLanding(false);
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
  ['auto_enrolled', 'Auto-Enrolled', 'same-class peer within 5% in same/adjacent book — enroll at sale price'],
  ['borderline', 'Borderline', 'nearby-book (2-5) peer within 5%, or same/adjacent-book peer within 15% — review'],
  ['below_market', 'Below Market', 'presumption rebutted — below similarity-weighted peer average'],
  ['above_market', 'Above Market', 'presumption rebutted — above similarity-weighted peer average'],
  ['land_review', 'Land Review', 'land gate failed (2% / 2 peers, same/adjacent book) — mass appraisal queue'],
  ['no_value', 'No-Value', 'zero consideration — classified by transfer type (LocalRatioCd)'],
];

async function showRule2() {
  const main = document.getElementById('main');
  setTopBarLanding(false);
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
        el('button', { class: 'btn', onclick: showTransfers }, '→ Transfers'),
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
        `Transfer comp repository: ${status.transferCompCount} commercial transfers (${(last?.summary?.buckets ?? last?.summary?.Buckets ?? {}).auto_enrolled ?? 0} auto-enrolled) — permanent, server-side, read-only`),
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

// --- Transfers work queues ----------------------------------------------------
// All Rule 2 buckets as tabs, including auto-enrolled. A transfer is
// "completed" when a finalized appraisal is archived for its document
// number + record (effective) date; auto-enrolled transfers are completed
// by default.

const TRANSFER_TABS = R2_BUCKETS;
let transfersTab = TRANSFER_TABS[0][0];

async function showTransfers() {
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let status;
  try { status = await api.rule2Status(); }
  catch (e) {
    main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`));
    return;
  }
  const last = status.lastRun;
  if (!last) {
    main.replaceChildren(
      el('div', { class: 'list-view' },
        el('div', { class: 'list-head' }, el('h2', {}, 'Transfers to be Completed')),
        el('div', { class: 'list-empty' }, 'No Rule 2 batch run yet — run it from the Rule 2 tab first.')),
    );
    return;
  }
  const s = last.summary;
  const buckets = s.buckets ?? s.Buckets ?? {};
  const cnt = (k) => { const n = Number(buckets[k]); return Number.isFinite(n) ? n : 0; };
  const view = el('div', { class: 'list-view transfers-view' },
    el('div', { class: 'list-head' },
      el('h2', {}, 'Transfers to be Completed'),
      el('span', { class: 'r2-sub' }, `${cnt('auto_enrolled').toLocaleString()} auto-enrolled — completed by default, enrolled as comps`),
      el('button', { class: 'btn', onclick: showRule2 }, '← Batch'),
    ),
    el('div', { class: 'tabs' }, TRANSFER_TABS.map(([k, label]) =>
      el('button', {
        class: `tab ${k === transfersTab ? 'active' : ''}`,
        onclick: () => { transfersTab = k; showTransfers(); },
      }, `${label} (${cnt(k).toLocaleString()})`))),
    el('div', { id: 'tq-body' }, el('div', { class: 'list-empty' }, 'Loading…')),
  );
  main.replaceChildren(view);
  renderTransferQueue(transfersTab);
}

async function renderTransferQueue(bucket) {
  const body = document.getElementById('tq-body');
  if (!body) return;
  body.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let rows;
  try { rows = await api.getBucketRows(bucket); }
  catch (e) {
    body.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`));
    return;
  }
  const done = rows.filter((r) => r.completed).length;
  body.replaceChildren(
    el('div', { class: 'tq-meta' },
      `${rows.length.toLocaleString()} transfers · ${done.toLocaleString()} completed · ${(rows.length - done).toLocaleString()} to complete`),
    el('table', { class: 'list-table' },
      el('thead', {}, el('tr', {}, ['Doc #', 'APN', 'Book', 'Record Date', 'Class', 'Price', 'Closest Dev %', 'Peer Avg', 'Peers', 'County', 'Status'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', { class: `clickable ${r.completed ? 'tq-done' : ''}`, onclick: () => openTransfer(r) },
        el('td', {}, r.docNumber || '—'),
        el('td', {}, r.apn || '—'),
        el('td', { class: 'num' }, r.book ? String(r.book) : '—'),
        el('td', {}, r.recordDate || '—'),
        el('td', {}, r.classDescr || '—'),
        el('td', { class: 'num' }, r.consid ? fmtCurrency(r.consid) : '—'),
        el('td', { class: 'num' }, r.closestDevPct != null ? Number(r.closestDevPct).toFixed(2) : '—'),
        el('td', { class: 'num' }, r.peerAvg ? fmtCurrency(r.peerAvg) : '—'),
        el('td', { class: 'num' }, String(r.peerCount ?? 0)),
        el('td', {}, r.reappraisability || '—'),
        el('td', {}, r.completed
          ? el('span', { class: 'tq-status done' }, '✓ Completed')
          : el('span', { class: 'tq-status' }, 'To complete')))))),
  );
}

// --- Work queues (transfers_to_be_worked / appeals_to_be_done) -----------------
// A filterable, sortable table of a "to be worked" file in input/.
// Clicking a row opens a new appraisal pre-filled from that row.

const WORK_QUEUE_META = {
  transfers: { title: 'Transfer Work Queue', file: 'transfers_to_be_worked', caseType: 'transfer' },
  appeals: { title: 'Appeal Work Queue', file: 'appeals_to_be_done', caseType: 'appeal' },
};

// Columns rendered as currency / right-aligned in the work-queue table.
const WQ_MONEY_COLS = new Set(['StatedSalePrice', 'Price', 'SalePrice', 'Consideration', 'Consid']);
// Numeric columns: right-aligned with tabular figures, sorted numerically.
const WQ_NUM_COLS = new Set([...WQ_MONEY_COLS, 'BuildingSf', 'Acreage', 'SquareFeet', 'YrBuilt', 'PINsInMult', 'Quality']);
// Hidden by default (toggle via the Columns menu).
const WQ_HIDDEN_BY_DEFAULT = new Set(['ClassCat', 'MultTransfer', 'PINsInMult', 'SquareFeet']);
// Dropdown filters: [column, label] — rendered only when the file has the column.
const WQ_FILTER_COLS = [['ClassCdDescr', 'Class'], ['QueueUser', 'Queue user'], ['Neighborhood', 'Neighborhood']];
// Human-readable labels for the raw county column headers (used for the table
// headers, the Columns menu, and the filter dropdowns).
const WQ_COL_LABELS = {
  PIN: 'APN', DocNumber: 'Doc #', RecordDate: 'Record Date', DocDate: 'Doc Date',
  LocalRatioCd: 'Ratio', Consid: 'Price', StatedSalePrice: 'Price', SalePrice: 'Price',
  ClassCdDescr: 'Class', ClassCat: 'Category', QueueUser: 'Queue User',
  Neighborhood: 'Neighborhood', MultTransfer: 'Multi', PINsInMult: 'Parcels',
  Address: 'Address', City: 'City', YrBuilt: 'Year Built', Quality: 'Quality',
  Condition: 'Condition', BuildingSf: 'Building SF', Acreage: 'Acres', SquareFeet: 'Site SF',
};
const wqLabel = (c) => WQ_COL_LABELS[c] || c;

function wqCell(col, val) {
  if (val == null || val === '') return '—';
  if (WQ_MONEY_COLS.has(col)) return fmtCurrency(Number(val) || 0);
  if (col === 'YrBuilt') return String(val); // a year, not a quantity
  if (col === 'Quality') return String(val); // a rating, not a quantity
  if (col === 'Acreage') return fmtAcresNum(val);
  if (WQ_NUM_COLS.has(col)) {
    const n = Number(String(val).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? fmtNumber(n) : String(val);
  }
  return titleCase(String(val));
}

function wqUnique(rows, col) {
  const s = new Set();
  for (const r of rows) {
    const v = r[col];
    if (v != null && v !== '') s.add(String(v));
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

// Sort comparator for a column: numeric when the column is numeric, else
// string; blank values always sort last.
function wqCompare(a, b, col) {
  const av = a[col], bv = b[col];
  const ae = av == null || av === '', be = bv == null || bv === '';
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  if (WQ_NUM_COLS.has(col)) {
    const n = (v) => Number(String(v).replace(/[$,]/g, '')) || 0;
    return n(av) - n(bv);
  }
  return String(av).localeCompare(String(bv));
}

async function showWorkQueue(type) {
  const main = document.getElementById('main');
  setTopBarLanding(false);
  const meta = WORK_QUEUE_META[type] || WORK_QUEUE_META.transfers;
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let data;
  try { data = await api.getWorkQueue(type); }
  catch (e) {
    main.replaceChildren(el('div', { class: 'list-view' },
      el('div', { class: 'list-head' }, el('h2', {}, meta.title)),
      el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`)));
    return;
  }
  const allRows = data.rows || [];
  const allCols = data.columns || [];
  const visible = new Set(allCols.filter((c) => !WQ_HIDDEN_BY_DEFAULT.has(c)));
  const sort = { col: null, dir: 1 };
  const filters = { q: '' };
  for (const [c] of WQ_FILTER_COLS) filters[c] = '';

  // Dropdown filters for the columns this file actually carries.
  const selects = [];
  for (const [col, label] of WQ_FILTER_COLS) {
    if (!allCols.includes(col)) continue;
    const opts = wqUnique(allRows, col);
    if (opts.length <= 1) continue;
    selects.push(el('select', { class: 'wq-select', 'data-col': col },
      [el('option', { value: '' }, `${label}: all`),
       ...opts.map((o) => el('option', { value: o }, o))]));
  }

  const view = el('div', { class: 'list-view workqueue-view' },
    el('div', { class: 'list-head' },
      el('div', { class: 'wq-head-left' },
        el('h2', {}, meta.title),
        el('span', { class: 'r2-sub' }, data.file
          ? `${data.file} · ${allRows.length.toLocaleString()} rows`
          : 'no file yet'),
      ),
      el('div', { class: 'wq-head-right' },
        el('div', { class: 'wq-cols-wrap' },
          el('button', { class: 'btn', id: 'wq-cols-btn', title: 'Show / hide columns' }, 'Columns ▾'),
          el('div', { class: 'wq-cols', id: 'wq-cols' },
            allCols.map((c) => {
              const cb = el('input', { type: 'checkbox', 'data-col': c });
              cb.checked = visible.has(c);
              return el('label', {}, cb, el('span', {}, wqLabel(c)));
            })),
        ),
        el('button', { class: 'btn', onclick: showLanding }, '← Main'),
      ),
    ),
    el('div', { class: 'wq-filter' },
      el('input', { class: 'wq-search', type: 'search', id: 'wq-search',
        placeholder: 'Search APN, address, city, doc #…' }),
      ...selects,
      el('button', { class: 'btn tiny', id: 'wq-clear', hidden: true }, '✕ Clear'),
      el('span', { class: 'wq-count', id: 'wq-count' }, ''),
    ),
    el('div', { class: 'wq-table-wrap', id: 'wq-body' }, el('div', { class: 'list-empty' }, 'Loading…')),
  );
  main.replaceChildren(view);
  const search = view.querySelector('#wq-search');
  const clearBtn = view.querySelector('#wq-clear');
  const countEl = view.querySelector('#wq-count');
  const colsBtn = view.querySelector('#wq-cols-btn');
  const colsMenu = view.querySelector('#wq-cols');
  // Columns menu: toggle on click; closes on outside click via the
  // module-level document handler (same pattern as the WIP menu).
  colsBtn.onclick = (e) => { e.stopPropagation(); colsMenu.classList.toggle('open'); };
  colsMenu.onclick = (e) => e.stopPropagation();
  colsMenu.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) visible.add(cb.dataset.col); else visible.delete(cb.dataset.col);
      render();
    };
  });
  search.addEventListener('input', () => { filters.q = search.value; render(); });
  selects.forEach((s) => { s.onchange = () => { filters[s.dataset.col] = s.value; render(); }; });
  clearBtn.onclick = () => {
    filters.q = ''; search.value = '';
    selects.forEach((s) => { filters[s.dataset.col] = ''; s.value = ''; });
    render();
  };

  const render = () => {
    const body = document.getElementById('wq-body');
    if (!body) return;
    if (!data.file) {
      body.replaceChildren(el('div', { class: 'wq-empty' },
        el('div', { class: 'wq-empty-icon' }, '📋'),
        el('div', {}, `No ${meta.file} file in input/ yet — drop the .csv/.xlsx there and reload.`)));
      return;
    }
    const q = filters.q.trim().toLowerCase();
    let shown = allRows;
    if (q) shown = shown.filter((r) => allCols.some((c) => String(r[c] ?? '').toLowerCase().includes(q)));
    for (const [c] of WQ_FILTER_COLS)
      if (filters[c]) shown = shown.filter((r) => String(r[c] ?? '') === filters[c]);
    if (sort.col) {
      const col = sort.col, dir = sort.dir;
      shown = [...shown].sort((a, b) => wqCompare(a, b, col) * dir);
    }
    const active = q !== '' || selects.some((s) => s.value !== '');
    clearBtn.hidden = !active;
    countEl.textContent = active
      ? `Showing ${shown.length.toLocaleString()} of ${allRows.length.toLocaleString()}`
      : `${allRows.length.toLocaleString()} rows`;
    const cols = allCols.filter((c) => visible.has(c));
    if (shown.length === 0 || cols.length === 0) {
      body.replaceChildren(el('div', { class: 'list-empty' },
        shown.length === 0 ? 'No rows match your filters.' : 'No columns visible — enable some via Columns ▾.'));
      return;
    }
    body.replaceChildren(el('table', { class: 'list-table' },
      el('thead', {}, el('tr', {}, cols.map((c) => {
        const th = el('th', { class: (WQ_NUM_COLS.has(c) ? 'num ' : '') + 'sortable' }, wqLabel(c));
        if (sort.col === c) th.classList.add(sort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
        th.onclick = () => {
          if (sort.col === c) sort.dir *= -1;
          else { sort.col = c; sort.dir = 1; }
          render();
        };
        return th;
      }))),
      el('tbody', {}, shown.map((r) => el('tr', { class: 'clickable', onclick: () => openFromWorkQueue(type, r) },
        cols.map((c) => el('td', { class: WQ_NUM_COLS.has(c) ? 'num' : '' }, wqCell(c, r[c])))))),
    ));
  };
  render();
}

// Open a new appraisal pre-filled from a work-queue row. Maps the common
// "to be worked" columns (PIN, DocNumber, DocDate, price, ratio, class,
// address, characteristics) onto the appraisal; the case type follows the
// queue (transfer vs appeal).
function openFromWorkQueue(type, r) {
  const meta = WORK_QUEUE_META[type] || WORK_QUEUE_META.transfers;
  newAppraisal();
  const d = state.data;
  const p = d.property;
  p.caseType = meta.caseType;
  if (r.PIN) p.apn = r.PIN;
  if (r.DocNumber) p.transferDocumentNumber = r.DocNumber;
  if (r.DocDate) p.effectiveDate = r.DocDate;
  const price = Number(r.Consid ?? r.StatedSalePrice);
  if (!Number.isNaN(price)) p.salePrice = price;
  if (r.LocalRatioCd) p.ratioCode = r.LocalRatioCd;
  if (r.ClassCdDescr) d.improvements.primary.type = r.ClassCdDescr;
  if (r.Address) p.address = titleCase(r.Address);
  if (r.City) p.city = titleCase(r.City);
  // Property characteristics (when the queue file carries the columns) into
  // the Property Summary's Building / Land groups.
  const b = d.improvements.primary;
  if (r.YrBuilt) b.yearBuilt = Number(r.YrBuilt) || 0;
  if (r.Quality) b.quality = r.Quality;
  if (r.Condition) b.condition = r.Condition;
  if (r.BuildingSf) {
    b.grossFloorArea = Number(r.BuildingSf) || 0;
    // Transfers carry no leasable area; default it to the building area.
    if (!b.nla) b.nla = b.grossFloorArea;
  }
  if (r.Acreage) d.land.acres = Number(r.Acreage) || 0;
  if (r.SquareFeet) d.land.siteAreaSqFt = Number(r.SquareFeet) || 0;
  state.dirty = true;
  addTab({ id: state.id, apn: p.apn, address: d.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  scheduleAutosave();
}

// Populate the Property Summary + transfer fields from a transfer comp
// record (address, city, doc #, ratio code, price, year built, quality,
// condition, building type/area, land area, site area). Only overwrites
// with values the transfer actually carries.
function applyTransferCompFields(d, r) {
  const p = d.property;
  if (r.address) p.address = r.address;
  if (r.city) p.city = r.city;
  if (r.docNumber) p.transferDocumentNumber = r.docNumber;
  if (r.ratioCd) p.ratioCode = r.ratioCd;
  if (r.price) p.salePrice = r.price;
  const b = d.improvements.primary;
  if (r.yearBuilt) b.yearBuilt = r.yearBuilt;
  if (r.quality) b.quality = r.quality;
  if (r.condition) b.condition = r.condition;
  if (r.propertyType) b.type = r.propertyType;
  if (r.buildingArea) {
    b.grossFloorArea = r.buildingArea;
    // Transfers carry no leasable area; default it to the building area.
    if (!b.nla) b.nla = r.buildingArea;
  }
  if (r.landArea) d.land.acres = r.landArea;
  if (r.siteSqFt) d.land.siteAreaSqFt = r.siteSqFt;
}

// Open a new appraisal pre-filled from a work-queue transfer row: APN,
// document number, effective date = record date, sale price, ratio code,
// building type. Bucket rows carry no address/characteristics columns, so
// the Property Summary is enriched from the transfer comp store by APN.
async function openTransfer(r) {
  newAppraisal();
  const d = state.data;
  const p = d.property;
  p.apn = r.apn || '';
  p.transferDocumentNumber = r.docNumber || '';
  if (r.recordDate) p.effectiveDate = r.recordDate;
  p.salePrice = r.consid || 0;
  p.ratioCode = r.ratioCd || '';
  d.improvements.primary.type = r.classDescr || '';
  const apn = String(r.apn || '').trim();
  if (apn) {
    try {
      const matches = await api.searchTransferComps(apn);
      const list = Array.isArray(matches) ? matches : [];
      // An APN can carry several transfers; prefer the one with this row's
      // document number so its price/ratio are not overwritten by a sibling.
      const comp = list.find((c) => String(c.apn || '').trim() === apn
          && r.docNumber && c.docNumber === r.docNumber)
        || list.find((c) => String(c.apn || '').trim() === apn);
      if (comp) applyTransferCompFields(d, comp);
    } catch { /* best-effort enrichment */ }
  }
  state.dirty = true;
  addTab({ id: state.id, apn: p.apn, address: d.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  scheduleAutosave();
}

async function openById(id) {
  try {
    await loadAppraisal(id);
    addTab({ id, apn: state.data?.property?.apn || '', address: state.data?.property?.address || '', dirty: false });
    showAppraisal();
    renderTabs();
  } catch (e) {
    toast(`Open failed: ${e.message}`, true);
  }
}

// --- appraisal view: split pane with drag slider -------------------------------

let apnInput = '';
let apnSugg = [];
let apnTimer = null;
let apnAppraisals = [];  // cached appraisals so a transfer suggestion can open an existing one

// Human-readable descriptor for a transfer-comp suggestion.
function transferDesc(r) {
  return [r.address, r.city, r.quality, r.condition, r.yearBuilt ? `Built ${r.yearBuilt}` : '']
    .filter(Boolean).join(' · ');
}

// Open a transfer comp as a working appraisal: reuse an existing appraisal for
// the same APN if one exists, otherwise start a new one pre-filled with the
// transfer's property characteristics.
async function openTransferComp(r) {
  const apn = String(r.apn || '').trim();
  const existing = apn.length > 0
    ? apnAppraisals.find((a) => String(a.apn || '').trim() === apn)
    : null;
  if (existing) { openById(existing.id); return; }
  newAppraisal();
  const d = state.data;
  d.property.apn = r.apn || '';
  if (r.saleDate) d.property.effectiveDate = r.saleDate;
  applyTransferCompFields(d, r);
  state.dirty = true;
  addTab({ id: state.id, apn: d.property.apn, address: d.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  scheduleAutosave();
  toast(`Opened ${r.apn || 'transfer'} from transfers — hit Save to keep it`);
}

function apnSearchBox() {
  const box = el('div', { class: 'apn-box' });
  const input = el('input', { placeholder: 'Search APN, address, city, quality…' });
  input.value = apnInput;
  const count = el('span', { class: 'apn-count' }, '');
  const sugg = el('div', { class: 'sugg', style: 'display:none' });

  const renderSugg = () => {
    if (apnSugg.length === 0) { sugg.style.display = 'none'; sugg.replaceChildren(); return; }
    sugg.style.display = 'block';
    sugg.replaceChildren(...apnSugg.map((r) => el('button', {
      onclick: () => {
        apnInput = r.apn || '';
        input.value = apnInput;
        apnSugg = [];
        sugg.style.display = 'none';
        if (r.kind === 'transfer') openTransferComp(r);
        else if (r.kind === 'parcel') showPinPage(r.apn);
        else openById(r.id);
      },
    },
      el('span', { class: 's-apn' }, r.apn || '—'),
      el('span', { class: 's-addr' },
        r.kind === 'transfer' ? transferDesc(r)
          : r.kind === 'parcel' ? [r.address, r.city, r.class].filter(Boolean).join(' · ')
          : (r.address || '')),
      r.kind === 'transfer' ? el('span', { class: 's-src' }, 'Transfer')
        : r.kind === 'parcel' ? el('span', { class: 's-src' }, 'Parcel')
          : null,
    )));
  };

  input.addEventListener('input', () => {
    apnInput = input.value;
    clearTimeout(apnTimer);
    const q = apnInput.trim();
    if (q.length < 1) { apnSugg = []; renderSugg(); return; }
    apnTimer = setTimeout(async () => {
      const lq = q.toLowerCase();
      let appRows = [];
      try { appRows = await api.listAppraisals(); } catch { appRows = []; }
      apnAppraisals = appRows;
      let transRows = [];
      try { transRows = await api.searchTransferComps(q); } catch { transRows = []; }
      let parcelRows = [];
      try { parcelRows = await api.parcelSearch(q); } catch { parcelRows = []; }
      // Book number = first 3 digits of the APN. Match on the APN prefix so
      // typing '1' surfaces every book that starts with 1, then order by book
      // number (APN). Address/city remain a secondary, case-insensitive match.
      const byBook = (a, b) => {
        const aP = String(a.apn || '').startsWith(q) ? 0 : 1;
        const bP = String(b.apn || '').startsWith(q) ? 0 : 1;
        if (aP !== bP) return aP - bP;
        return String(a.apn || '').localeCompare(String(b.apn || ''), undefined, { numeric: true });
      };
      const appSugg = appRows
        .filter((r) => String(r.apn || '').startsWith(q) || String(r.address || '').toLowerCase().includes(lq) || String(r.city || '').toLowerCase().includes(lq))
        .sort(byBook)
        .slice(0, 10)
        .map((r) => ({ kind: 'appraisal', id: r.id, apn: r.apn, address: r.address, city: r.city }));
      const transSugg = (Array.isArray(transRows) ? transRows : [])
        .sort(byBook)
        .slice(0, 10)
        .map((r) => ({ kind: 'transfer', ...r }));
      // County parcel records — surfaces PINs that have no appraisal or
      // transfer comp yet. Deduped against the APNs above.
      const takenApns = new Set([...appSugg, ...transSugg].map((r) => String(r.apn || '').trim()));
      const parcelSugg = (Array.isArray(parcelRows) ? parcelRows : [])
        .filter((r) => !takenApns.has(String(r.apn || '').trim()))
        .slice(0, 10)
        .map((r) => ({ kind: 'parcel', ...r }));
      apnSugg = [...appSugg, ...transSugg, ...parcelSugg].sort(byBook).slice(0, 20);
      renderSugg();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { apnSugg = []; renderSugg(); }
  });
  document.addEventListener('click', (e) => {
    if (!box.isConnected) return; // stale instance (a newer box replaced it)
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
      el('button', { class: 'st-btn', title: 'Download this appraisal as a JSON file', onclick: exportWip }, '⬇ Save to PC'),
      el('button', { class: 'st-btn finalize', title: 'Save this appraisal and archive it as a permanent sales comp', onclick: onFinalize }, '✓ Finalize & Save to Archive'),
      el('button', { class: 'st-btn', title: 'Browse archived (finalized) appraisals', onclick: showArchive }, 'View Archive'),
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
    const t = activeTab();
    if (t) { t.id = id; t.dirty = false; }
    const res = await api.finalize(id, state.data);
    if (res.deduplicated) {
      toast('Already archived — identical content (duplicate).');
    } else {
      toast(`Finalized — permanent comp archived (${String(res.contentHash).slice(0, 8)}… · ${res.compCount} total).`);
    }
    loadRepo();
    renderTabs();
  } catch (e) {
    toast(`Finalize failed: ${e.message}`, true);
  }
}

// --- Archive view -------------------------------------------------------------
// Browse the archived (finalized) appraisals — the permanent comp store.
async function showArchive() {
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let rows;
  try { rows = await api.getPermanentComps(); }
  catch (e) {
    main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`));
    return;
  }
  rows = Array.isArray(rows) ? rows : [];
  main.replaceChildren(
    el('div', { class: 'list-view' },
      el('div', { class: 'list-head' },
        el('h2', {}, 'Archive'),
        el('span', { class: 'r2-sub' }, `${rows.length} finalized appraisal${rows.length === 1 ? '' : 's'} · permanent comps`),
      ),
      el('table', { class: 'list-table' },
        el('thead', {}, el('tr', {}, ['APN', 'Address', 'City', 'Sale Date', 'Price', 'Bldg SF', ''].map((h) => el('th', {}, h)))),
        el('tbody', {},
          rows.length === 0
            ? el('tr', {}, el('td', { colspan: 7 }, 'No appraisals archived yet. Finalize an appraisal to add it here.'))
            : rows.map((r) => el('tr', { class: 'clickable', onclick: () => openArchiveDetail(r) },
                el('td', {}, r.apn || '—'),
                el('td', {}, r.address || '—'),
                el('td', {}, r.city || '—'),
                el('td', {}, r.saleDate || '—'),
                el('td', { class: 'num' }, r.price > 0 ? fmtCurrency(r.price) : '—'),
                el('td', { class: 'num' }, r.buildingArea > 0 ? Number(r.buildingArea).toLocaleString() : '—'),
                el('td', {}, el('button', { class: 'btn tiny', onclick: (e) => { e.stopPropagation(); openArchiveDetail(r); } }, 'View')),
              )),
        ),
      ),
    ),
  );
}

// Read-only detail panel for a single archived comp.
function openArchiveDetail(r) {
  const main = document.getElementById('main');
  const field = (label, value) => el('div', { class: 'arch-field' },
    el('div', { class: 'arch-label' }, label),
    el('div', { class: 'arch-value' }, (value === undefined || value === null || value === '') ? '—' : String(value)));
  main.replaceChildren(
    el('div', { class: 'list-view archive-detail' },
      el('div', { class: 'list-head' },
        el('button', { class: 'btn', onclick: showArchive }, '← Archive'),
        el('h2', {}, r.apn || 'Archived Comp'),
      ),
      el('div', { class: 'arch-grid' },
        field('Address', r.address),
        field('City', r.city),
        field('Property Type', r.propertyType),
        field('Quality', r.quality),
        field('Condition', r.condition),
        field('Sale Date', r.saleDate),
        field('Price', r.price > 0 ? fmtCurrency(r.price) : '—'),
        field('Building SF', r.buildingArea > 0 ? Number(r.buildingArea).toLocaleString() : '—'),
        field('Land (acres)', r.landArea > 0 ? Number(r.landArea).toLocaleString() : '—'),
        field('Zoning', r.zoning),
      ),
    ),
  );
}

// --- PIN page ---------------------------------------------------------------
// One page per PIN: property characteristics from the county parcel record
// (input/master_parcel_list.csv), past valuations (appraisals saved for this APN),
// and a one-click "New Appraisal" pre-filled from the parcel data.
// Reachable from the top-bar search (parcel suggestions) or ?pin=APN.

let pinTab = 'characteristics';

const pinDetail = (label, value) => el('div', { class: 'arch-field' },
  el('div', { class: 'arch-label' }, label),
  el('div', { class: 'arch-value' }, (value === undefined || value === null || value === '') ? '—' : String(value)));

// Flatten the RivCo imprv[] building records into display rows.
function pinBuildings(parcel) {
  const out = [];
  for (const b of parcel.imprv || []) {
    const det = {};
    for (const d of b.details || []) det[d.label] = d.value;
    out.push({
      name: b.BuildingName || b.BuildingId || 'Building',
      active: b.active || '',
      type: det['Building Type'] || '',
      yearBuilt: det['Year Built'] || '',
      quality: det['Quality'] || '',
      condition: det['Cond'] || '',
      area: det['Actual Area sqft'] || '',
    });
  }
  return out;
}

async function showPinPage(apn) {
  const main = document.getElementById('main');
  setTopBarLanding(false);
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let parcel = null;
  try { parcel = await api.getParcelData(apn); } catch { /* no county record */ }
  let appRows = [];
  try { appRows = await api.listAppraisals(); } catch { /* offline data */ }
  const mine = appRows
    .filter((r) => String(r.apn || '').trim() === String(apn).trim())
    .sort((a, b) => String(b.reportDate || '').localeCompare(String(a.reportDate || '')));

  const view = el('div', { class: 'list-view pin-view' },
    el('div', { class: 'list-head' },
      el('div', { class: 'pin-head-left' },
        el('button', { class: 'btn', title: 'Back', onclick: () => history.back() }, '←'),
        el('h2', {}, apn),
        el('span', { class: 'pin-sub' }, [parcel?.address, parcel?.city, parcel?.class].filter(Boolean).join(' · ')),
      ),
      el('button', { class: 'btn primary', onclick: () => openAppraisalFromParcel(apn) }, '+ New Appraisal'),
    ),
    el('div', { class: 'tabs' },
      el('button', { class: `tab ${pinTab === 'characteristics' ? 'active' : ''}`, onclick: () => { pinTab = 'characteristics'; showPinPage(apn); } }, 'Characteristics'),
      el('button', { class: `tab ${pinTab === 'valuations' ? 'active' : ''}`, onclick: () => { pinTab = 'valuations'; showPinPage(apn); } }, `Past Valuations (${mine.length})`)),
    el('div', { id: 'pin-body' }),
  );
  main.replaceChildren(view);
  renderPinBody(apn, parcel, mine);
}

function renderPinBody(apn, parcel, mine) {
  const body = document.getElementById('pin-body');
  if (!body) return;
  if (pinTab === 'characteristics') {
    if (!parcel) {
      body.replaceChildren(el('div', { class: 'r2-none' }, 'No county parcel record for this PIN — start an appraisal manually.'));
      return;
    }
    const city = String(parcel.District || '').split(' ').slice(1).join(' ');
    const buildings = pinBuildings(parcel);
    body.replaceChildren(
      el('div', { class: 'pin-body-inner' },
        el('div', { class: 'arch-grid pin-grid' },
          pinDetail('Address', titleCase(parcel.address)),
          pinDetail('City', titleCase(city)),
          pinDetail('Class', titleCase(parcel.class_code)),
          pinDetail('Acreage', fmtAcresNum(parcel.acreage)),
          pinDetail('Site SqFt', fmtNumber(Number(String(parcel.SquareFeet).replace(/[^0-9.]/g, '')) || 0)),
          pinDetail('District', titleCase(parcel.District)),
          pinDetail('Legal Description', titleCase(parcel.LegalDescription)),
          pinDetail('Coordinates', parcel.lat && parcel.lng ? `${parcel.lat}, ${parcel.lng}` : ''),
        ),
        buildings.length > 0 ? el('div', { class: 'pin-section' },
          el('div', { class: 'pin-section-title' }, `Buildings (${buildings.length})`),
          el('table', { class: 'list-table' },
            el('thead', {}, el('tr', {}, ['Building', 'Type', 'Year Built', 'Quality', 'Condition', 'Area SF', 'Status'].map((h) => el('th', {}, h)))),
            el('tbody', {}, buildings.map((b) => el('tr', {},
              el('td', {}, b.name),
              el('td', {}, b.type || '—'),
              el('td', { class: 'num' }, b.yearBuilt || '—'),
              el('td', { class: 'num' }, b.quality || '—'),
              el('td', {}, b.condition || '—'),
              el('td', { class: 'num' }, b.area || '—'),
              el('td', {}, b.active || '—'),
            ))),
          ))
          : null,
        (parcel.sales || []).length > 0 ? el('div', { class: 'pin-section' },
          el('div', { class: 'pin-section-title' }, 'County Sales History'),
          el('table', { class: 'list-table' },
            el('thead', {}, el('tr', {}, ['Sale Date', 'Price', 'Ratio', 'Doc #'].map((h) => el('th', {}, h)))),
            el('tbody', {}, (parcel.sales || []).map((s) => el('tr', {},
              el('td', {}, s.saledate || '—'),
              el('td', { class: 'num' }, s.SalePrice || '—'),
              el('td', {}, s.LocalRatioCd || '—'),
              el('td', {}, s.DocNumber || '—'),
            ))),
          ))
          : null,
        parcel.strview ? el('div', { class: 'pin-section' },
          el('div', { class: 'pin-section-title' }, 'Street View'),
          el('img', { class: 'pin-strview', src: parcel.strview, alt: 'Street view', loading: 'lazy' }))
          : null,
      ),
    );
    return;
  }
  // Past valuations: appraisals saved for this APN, newest report date first.
  body.replaceChildren(
    el('div', { class: 'pin-body-inner' },
      mine.length === 0
        ? el('div', { class: 'r2-none' }, 'No appraisals for this PIN yet — start one with + New Appraisal.')
        : el('table', { class: 'list-table' },
            el('thead', {}, el('tr', {}, ['Report Date', 'Final Value', 'Updated', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, mine.map((r) => el('tr', { class: 'clickable', onclick: () => openById(r.id) },
              el('td', {}, r.reportDate ? fmtDate(r.reportDate) : '—'),
              el('td', { class: 'num' }, r.finalValue != null ? fmtCurrency(r.finalValue) : '—'),
              el('td', {}, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'),
              el('td', {}, el('button', { class: 'btn tiny', onclick: (e) => { e.stopPropagation(); openById(r.id); } }, 'Open')),
            ))),
          ),
    ),
  );
}

// Start a new appraisal pre-filled from the county parcel record: address,
// city, legal description, class, primary building characteristics, and land
// sizes. Only overwrites fields the parcel actually carries.
function applyParcelFields(d, p) {
  if (!p || typeof p !== 'object') return;
  const prop = d.property;
  if (p.address) prop.address = titleCase(p.address);
  const district = String(p.District || '').trim();
  if (district) prop.city = titleCase(district.split(' ').slice(1).join(' '));
  if (p.LegalDescription) prop.legalDescription = titleCase(p.LegalDescription);
  const b = d.improvements.primary;
  if (p.class_code) b.type = p.class_code;
  const buildings = Array.isArray(p.imprv) ? p.imprv : [];
  let totalSf = 0;
  for (const bld of buildings) {
    for (const det of bld.details || []) {
      if (det.label === 'Actual Area sqft') totalSf += parseFloat(String(det.value).replace(/[^0-9.]/g, '')) || 0;
    }
  }
  const det0 = (buildings[0] && buildings[0].details) || [];
  const get0 = (label) => { const x = det0.find((x) => x.label === label); return x ? x.value : ''; };
  const yb = parseInt(get0('Year Built'), 10);
  if (Number.isFinite(yb) && yb > 0) b.yearBuilt = yb;
  if (get0('Quality')) b.quality = get0('Quality');
  if (get0('Cond')) b.condition = get0('Cond');
  if (totalSf > 0) { b.grossFloorArea = totalSf; if (!b.nla) b.nla = totalSf; }
  const acres = parseFloat(String(p.acreage || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(acres) && acres > 0) d.land.acres = acres;
  const sqft = parseFloat(String(p.SquareFeet || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(sqft) && sqft > 0) d.land.siteAreaSqFt = sqft;
}

async function openAppraisalFromParcel(apn) {
  newAppraisal();
  const d = state.data;
  d.property.apn = apn;
  try {
    const parcel = await api.getParcelData(apn);
    applyParcelFields(d, parcel);
  } catch { /* no county record — start blank */ }
  state.dirty = true;
  addTab({ id: state.id, apn, address: d.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  scheduleAutosave();
  toast(`Opened ${apn} — property data pre-filled from the county record`);
}

function showAppraisal() {
  const main = document.getElementById('main');
  setTopBarLanding(false);
  const left = el('div', { class: 'pane pane-left' },
    el('div', { id: 'tab-strip', class: 'tab-strip' }),
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
  renderTabs();
}

// --- boot ----------------------------------------------------------------------

async function boot() {
  try {
    state.tenant = await api.getTenant();
  } catch { /* neutral tenant */ }
  renderTopBar();
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'list') { showList(); return; }
  const pin = params.get('pin');
  if (pin) { showPinPage(pin); return; }
  const tab = params.get('tab');
  if (tab) {
    // Deep link: open the most recent appraisal with a specific form tab active.
    setTab(tab);
    let rows = [];
    try { rows = await api.listAppraisals(); } catch { /* offline data */ }
    if (rows.length > 0) { openById(rows[0].id); return; }
    openNew();
    return;
  }
  // Default: the landing page (workflow selection).
  showLanding();
}

// Form edits update the top-bar headline + total assessed.
window.addEventListener('appraisal:changed', refreshTopBar);
// Keep the active workspace tab's label + dirty marker in sync.
window.addEventListener('appraisal:changed', updateTabStrip);
// Debounced autosave of the working appraisal (WIP) on every form edit.
window.addEventListener('appraisal:changed', scheduleAutosave);

// Close the WIP dropdown and the work-queue Columns menu when clicking
// anywhere outside them (bound once).
document.addEventListener('click', () => {
  const m = document.getElementById('wip-menu');
  if (m) m.classList.remove('open');
  const c = document.getElementById('wq-cols');
  if (c) c.classList.remove('open');
});

// Warn on unload with unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Re-fit report sheets when the window resizes.
window.addEventListener('resize', () => {
  if (document.getElementById('report-root')) fitSheets();
});

// Surface runtime errors as a toast instead of failing silently (e.g. a blank
// form pane). Resource-load errors (404s) have no e.error and are ignored.
window.addEventListener('error', (e) => {
  if (e.error && e.error.message) toast(`Error: ${e.error.message}`, true);
});
window.addEventListener('unhandledrejection', (e) => {
  toast(`Error: ${e.reason?.message || e.reason}`, true);
});

boot();