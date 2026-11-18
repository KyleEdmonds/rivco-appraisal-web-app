// ---------------------------------------------------------------------------
// main.js — bootstrap: top bar, list view, split-pane appraisal view
// Left pane: control bar (dates + APN search) + tabbed form
// Right pane: report staging. Draggable split handle between them.
// ---------------------------------------------------------------------------
import { el, toast, refreshTopBar, api, state, saveCurrent, loadAppraisal, newAppraisal, fmtCurrency, fmtNumber, fmtAcresNum, titleCase, normalizeCity, fmtDate, scheduleAutosave, exportWip, workspace, activeTab, addTab, closeTab, snapshotActiveTab, restoreWorkspaceLocal, clearLocalWorkspace, applyPortfolio, normalizePortfolio, portfolioPayload, isPortfolio, activeParcelIndex, selectParcel, setViewMode, addParcel, removeParcel, createEmptyParcel } from './core.js';
import { renderForm, setTab, loadRepo, commitCoverApn } from './form.js';
import { renderReport, fitSheets, zoomBy, zoomFit } from './report.js';
import { interactiveParcelMap, reverseGeocode, parseWktRings } from './mapimg.js';

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
    el('div', { class: 'tb-center' },
      el('div', { class: 'tb-headline' },
        el('div', { class: 'addr', id: 'tb-addr' }, '—'),
        el('div', { class: 'sub', id: 'tb-sub' }, ''),
      ),
      el('div', { class: 'tb-value' },
        el('div', { class: 'label' }, 'Total Assessed'),
        el('div', { class: 'num', id: 'tb-value' }, '—'),
      ),
    ),
    el('div', { class: 'tb-right' },
      el('span', { class: 'tb-sep' }),
      el('div', { class: 'tb-group' },
        el('button', { class: 'btn', id: 'btn-report', title: 'Return to the report builder (your active appraisal)', onclick: goReport }, '📄 Report'),
        el('button', { class: 'btn', id: 'btn-home', title: 'Return to the landing page', onclick: goMain }, '🏠 Home'),
      ),
      ...(RULE2_ENABLED ? [
        el('div', { class: 'tb-group' },
          el('button', { class: 'btn', id: 'btn-rule2', title: 'Rule 2 batch evaluation and transfer work queues' }, 'Rule 2'),
        ),
      ] : []),
      el('div', { class: 'tb-group' },
        el('span', { class: 'save-status', id: 'save-status' }, ''),
        el('button', { class: 'btn', id: 'btn-save-wip', title: 'Save this appraisal to the server as a work-in-progress so you can resume it later' }, '💾 Save as WIP'),
        el('button', { class: 'btn finalize', id: 'btn-finalize', title: 'Save this appraisal and archive it as a permanent sales comp' }, '✓ Finalize'),
      ),
      el('div', { class: 'tb-group' },
        el('button', { class: 'btn', id: 'btn-archive', title: 'Browse the archive (work-in-progress and finalized appraisals)' }, '📁 Archive'),
      ),
    ),
  );
  if (RULE2_ENABLED) document.getElementById('btn-rule2').onclick = showRule2;
  document.getElementById('btn-save-wip').onclick = onSaveWip;
  document.getElementById('btn-finalize').onclick = onFinalize;
  document.getElementById('btn-archive').onclick = () => showArchive();
}

// Hide the top-bar action buttons (and the appraisal headline/total) on the
// landing page, where they don't apply. Toggled by the view functions.
function setTopBarLanding(on) {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  bar.classList.toggle('tb-landing', on);
  bar.classList.remove('tb-appraisal');
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

// Switch to another open tab: snapshot the current tab's data into its record
// (no server write), then load the target from memory (if it has data) or from
// the server by id. Nothing is written to the server on a tab switch.
async function switchToTab(key) {
  if (key === workspace.activeKey) return;
  const target = workspace.tabs.find((t) => t.key === key);
  if (!target) return;
  snapshotActiveTab();
  if (target.portfolio) {
    state.id = target.id ?? null;
    applyPortfolio(normalizePortfolio(target.portfolio));
    state.dirty = !!target.dirty;
  } else if (target.data && target.data.property) {
    state.id = target.id ?? null;
    applyPortfolio(normalizePortfolio(target.data));
    state.dirty = !!target.dirty;
  } else if (target.id !== null) {
    try { await loadAppraisal(target.id); }
    catch (e) { toast(`Open failed: ${e.message}`, true); return; }
  }
  target.data = state.data;
  target.portfolio = portfolioPayload();
  workspace.activeKey = key;
  renderTabs();
  renderForm(); renderReport(); refreshTopBar(); renderParcelStrip();
  scheduleAutosave();
}

// Find an open tab for the given APN (saved or unsaved), normalizing both sides
// to a trimmed string so number/string mismatches don't slip past. Returns the
// tab or null. Used by the open paths to focus an existing tab instead of
// spawning a duplicate for the same parcel.
function findTabByApn(apn) {
  const a = String(apn ?? '').trim();
  if (!a) return null;
  return workspace.tabs.find((t) => String(t.apn ?? '').trim() === a) || null;
}

// Close a tab. No server write on close: unsaved changes are simply discarded
// (a saved tab's data is already on the server). Loads the next open tab from
// memory or the server. Closing the last open tab returns to the home page (the
// local workspace is cleared so a refresh doesn't restore it).
async function closeTabFn(key) {
  const tab = workspace.tabs.find((t) => t.key === key);
  if (!tab) return;
  if (key !== workspace.activeKey) { closeTab(key); renderTabs(); scheduleAutosave(true); return; }
  snapshotActiveTab();
  closeTab(key);
  // Update the strip immediately: the tab is gone from the workspace, so it must
  // disappear from the strip even if loading the next tab fails below (a stale
  // strip entry would be uncloseable — its record no longer exists).
  renderTabs();
  const next = activeTab();
  if (!next) {
    // Last open tab closed: clear the local workspace and return to the home page.
    clearLocalWorkspace();
    showLanding();
    return;
  }
  try {
    if (next.portfolio) {
      state.id = next.id ?? null;
      applyPortfolio(normalizePortfolio(next.portfolio));
      state.dirty = !!next.dirty;
    } else if (next.data && next.data.property) {
      state.id = next.id ?? null;
      applyPortfolio(normalizePortfolio(next.data));
      state.dirty = !!next.dirty;
    } else if (next.id !== null) {
      await loadAppraisal(next.id);
    } else {
      newAppraisal();
    }
  } catch (e) {
    toast(`Open failed: ${e.message}`, true);
    return;
  }
  renderForm(); renderReport(); refreshTopBar(); renderParcelStrip();
  scheduleAutosave(true);   // force: persist the new tab list even if next tab is clean
}

// Open a fresh, empty appraisal in a new tab.
function openNew() {
  snapshotActiveTab();   // preserve the active tab's edits before resetting state
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

// Return to the report builder showing the active appraisal tab. If no report
// is open, fall back to the landing page. This is the "get back to my report"
// button in the top bar (replaces the old ambiguous "← Back").
function goReport() {
  if (activeTab()) showAppraisal();
  else showLanding();
}

// --- navigation history (Back button) ----------------------------------------
// A stack of previously-visited views so a "← Back" button returns to the page
// the user was on before the current one (e.g. appraisal → WIP Archive → Back
// → the same appraisal). Each top-level view calls enterView() at its start to
// record itself; goBack() pops the stack and restores the prior view. The open
// workspace tabs + working data are preserved across all of this (no reload).
let currentView = { name: 'landing', args: [] };
const navHistory = [];
let restoringView = false;

// Record a view transition: push the current view onto the history stack (so
// Back can return to it) and mark the new view as current. Skips the push while
// restoring (so goBack doesn't re-push the view it is returning to).
function enterView(name, args = []) {
  // Leaving the PIN page: tear down its Leaflet map (it keeps window listeners
  // alive until map.remove() is called, even after its DOM is replaced).
  if (currentView?.name === 'pin') destroyPinMap();
  if (!restoringView) navHistory.push(currentView);
  currentView = { name, args };
}

// Return to the previously-visited view. With an empty history (e.g. the app
// booted straight into an appraisal) fall back to the landing page.
function goBack() {
  if (navHistory.length === 0) { showLanding(); return; }
  const prev = navHistory.pop();
  currentView = prev;
  restoringView = true;
  try { restoreView(prev); } finally { restoringView = false; }
}

// Re-enter a view from the history stack.
function restoreView(v) {
  switch (v.name) {
    case 'list': showList(); break;
    case 'appraisal': {
      // The appraisal view is stateful (renders whichever tab is active). Build
      // the view, then switch to the tab that was active when the user left, so
      // Back returns to the exact tab — even if a different tab was opened in
      // the meantime (appraisal A → archive → appraisal B → Back → Back → A).
      showAppraisal();
      const key = v.args[0];
      if (key && key !== workspace.activeKey) {
        switchToTab(key);
        currentView = { name: 'appraisal', args: [key] };
      }
      break;
    }
    case 'workqueue': showWorkQueue(v.args[0]); break;
    case 'pin': showPinPage(v.args[0]); break;
    case 'archive': showArchive(v.args[0]); break;
    case 'archiveDetail': openArchiveDetail(v.args[0]); break;
    default: showLanding(); break;
  }
}

// --- landing page (workflow selection) ---------------------------------------
// The workflow-selection page: pick a workflow (new appraisal, the transfer or
// appeal work queue, or continue a saved one). The APN/Address search and the
// Effective/Report dates now live on the appraisal's Cover tab.

async function showLanding() {
  enterView('landing');
  const main = document.getElementById('main');
  let recent = [];
  try { recent = await api.listAppraisals(); } catch { /* offline data */ }

  setTopBarLanding(true);
  // On the home page, only offer "Report" when there's an active appraisal to
  // return to; otherwise it would just bounce back to this same page.
  const reportBtn = document.getElementById('btn-report');
  if (reportBtn) reportBtn.style.display = activeTab() ? '' : 'none';

  // Parcel-only search results table, populated as the user types. County
  // parcels only — appraisals and transfer comps are no longer mixed in here
  // (work-queue items for a PIN surface on its parcel page instead).
  const results = el('div', { class: 'landing-results' });
  let lastRows = [];
  const openRow = (r) => showPinPage(r.apn);
  const renderResults = (rows) => {
    lastRows = rows;
    if (!rows.length) {
      results.replaceChildren(el('div', { class: 'landing-results-empty' }, 'No matches.'));
      return;
    }
    results.replaceChildren(
      el('table', { class: 'list-table landing-results-table' },
        el('thead', {}, el('tr', {}, ['APN', 'Address', 'City', 'Class'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows.map((r) => el('tr', { class: 'clickable', onclick: () => openRow(r) },
          el('td', {}, r.apn || '—'),
          el('td', {}, titleCase(r.address) || '—'),
          el('td', {}, normalizeCity(r.city) || '—'),
          el('td', {}, titleCase(r.class) || '—'),
        ))),
      ),
    );
  };

  const input = el('input', {
    class: 'landing-search-input',
    placeholder: 'Search APN or address…',
    'aria-label': 'Search APN or address',
  });
  let searchTimer = null;
  const runSearch = async (q) => {
    results.replaceChildren(el('div', { class: 'landing-results-empty' }, 'Searching…'));
    // Book number = first 3 digits of the APN. Match on the APN prefix so typing
    // '1' surfaces every book that starts with 1, then order by book number.
    const byBook = (a, b) => {
      const aP = String(a.apn || '').startsWith(q) ? 0 : 1;
      const bP = String(b.apn || '').startsWith(q) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return String(a.apn || '').localeCompare(String(b.apn || ''), undefined, { numeric: true });
    };
    let parcelRows = [];
    try { parcelRows = await api.parcelSearch(q); } catch { parcelRows = []; }
    renderResults((Array.isArray(parcelRows) ? parcelRows : []).sort(byBook).slice(0, 20));
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (!q) { lastRows = []; results.replaceChildren(); return; }
    searchTimer = setTimeout(() => runSearch(q), 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastRows.length) openRow(lastRows[0]);
  });

  // Recent appraisals panel (last 5, most recently updated first).
  const recentPanel = el('div', { class: 'landing-recent' },
    el('div', { class: 'landing-recent-head' },
      el('h2', { class: 'landing-recent-title' }, 'Recent Appraisals'),
      el('button', { class: 'linklike', onclick: showList }, 'View all →'),
    ),
  );
  if (!recent.length) {
    recentPanel.append(el('div', { class: 'landing-recent-empty' }, 'No appraisals yet — start one below.'));
  } else {
    recentPanel.append(el('div', { class: 'landing-recent-list' },
      recent.slice(0, 5).map((r) => el('div', {
        class: 'landing-recent-row clickable',
        onclick: () => openById(r.id),
      },
        el('div', { class: 'rr-apn' }, r.apn || '—'),
        el('div', { class: 'rr-addr' }, titleCase(r.address) || '—'),
        el('div', { class: 'rr-value num' }, r.finalValue != null ? fmtCurrency(r.finalValue) : '—'),
        el('div', { class: 'rr-date' }, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'),
      )),
    ));
  }

  main.replaceChildren(
    el('div', { class: 'landing' },
      el('div', { class: 'landing-head' },
        el('h1', {}, 'Parcel Search'),
        el('p', {}, 'Search by APN or address to view a parcel and start a report.'),
      ),
      el('div', { class: 'landing-search' }, input),
      results,
      el('div', { class: 'landing-cards' },
        el('button', { class: 'landing-card primary', 'aria-label': 'Start a new appraisal', onclick: openNew },
          el('div', { class: 'lc-icon' }, '📝'),
          el('div', { class: 'lc-title' }, 'New Appraisal'),
          el('div', { class: 'lc-desc' }, 'Start a blank report'),
        ),
        el('button', { class: 'landing-card', 'aria-label': 'Open the transfer work queue', onclick: () => showWorkQueue('transfers') },
          el('div', { class: 'lc-icon' }, '🏢'),
          el('div', { class: 'lc-title' }, 'Transfer Queue'),
          el('div', { class: 'lc-desc' }, 'Screen the county transfer file'),
        ),
        el('button', { class: 'landing-card', 'aria-label': 'Open the appeal work queue', onclick: () => showWorkQueue('appeals') },
          el('div', { class: 'lc-icon' }, '⚖️'),
          el('div', { class: 'lc-title' }, 'Appeal Queue'),
          el('div', { class: 'lc-desc' }, 'Open appeals to be worked'),
        ),
        el('button', { class: 'landing-card', 'aria-label': 'Open the archive', onclick: () => showArchive() },
          el('div', { class: 'lc-icon' }, '📁'),
          el('div', { class: 'lc-title' }, 'Archive'),
          el('div', { class: 'lc-desc' }, 'WIP and finalized appraisals'),
        ),
      ),
      recentPanel,
    ),
  );
}

// --- list view ----------------------------------------------------------------

async function showList() {
  enterView('list');
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
                el('td', {}, normalizeCity(r.city) || '—'),
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
const WQ_FILTER_COLS = [['ClassCdDescr', 'Class'], ['QueueUser', 'Queue user']];
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
  if (col === 'City') return normalizeCity(String(val));
  return titleCase(String(val));
}

// First non-empty price column on a work-queue row, as currency. Queue files
// differ in their price header (transfers carry Consid/StatedSalePrice,
// appeals may carry SalePrice/Price).
function wqPrice(row) {
  for (const c of ['Consid', 'StatedSalePrice', 'SalePrice', 'Price', 'Consideration']) {
    const v = row[c];
    if (v != null && v !== '') return fmtCurrency(Number(String(v).replace(/[$,]/g, '')) || 0);
  }
  return '';
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
  enterView('workqueue', [type]);
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
  let allCols = data.columns || [];
  // The county file lists Neighborhood before Address/City; move it to right
  // after them (anchor to City, or Address if City is absent) so the location
  // columns read together.
  if (allCols.includes('Neighborhood')) {
    const anchor = allCols.includes('City') ? 'City' : allCols.includes('Address') ? 'Address' : null;
    if (anchor) {
      allCols = allCols.filter((c) => c !== 'Neighborhood');
      allCols.splice(allCols.indexOf(anchor) + 1, 0, 'Neighborhood');
    }
  }
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
        el('button', { class: 'btn', onclick: goBack }, '← Back'),
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
      el('tbody', {}, shown.map((r) => el('tr', { class: 'clickable', onclick: () => openFromWorkQueue(type, r, allRows) },
        cols.map((c) => el('td', { class: WQ_NUM_COLS.has(c) ? 'num' : '' }, wqCell(c, r[c])))))),
    ));
  };
  render();
}

// Map a work-queue row's fields onto a parcel's appraisal data.
// `main` = true for the main subject (gets the document-level price);
// associated parcels get their own characteristics but no price (the
// Consid is the total for the whole document).
function mapWorkQueueRow(d, r, { main = true } = {}) {
  const p = d.property;
  if (r.PIN) p.apn = r.PIN;
  if (r.DocNumber) p.transferDocumentNumber = r.DocNumber;
  if (r.DocDate) p.effectiveDate = r.DocDate;
  if (main) {
    const price = Number(r.Consid ?? r.StatedSalePrice);
    if (!Number.isNaN(price)) p.salePrice = price;
  }
  if (r.LocalRatioCd) p.ratioCode = r.LocalRatioCd;
  if (r.ClassCdDescr) d.improvements.primary.type = r.ClassCdDescr;
  if (r.Address) p.address = titleCase(r.Address);
  if (r.City) p.city = normalizeCity(r.City);
  const b = d.improvements.primary;
  if (r.YrBuilt) b.yearBuilt = Number(r.YrBuilt) || 0;
  if (r.Quality) b.quality = r.Quality;
  if (r.Condition) b.condition = r.Condition;
  if (r.BuildingSf) {
    b.grossFloorArea = Number(r.BuildingSf) || 0;
    if (!b.nla) b.nla = b.grossFloorArea;
  }
  if (r.Acreage) d.land.acres = Number(r.Acreage) || 0;
  if (r.SquareFeet) d.land.siteAreaSqFt = Number(r.SquareFeet) || 0;
}

// Open a new appraisal pre-filled from a work-queue row. Maps the common
// "to be worked" columns (PIN, DocNumber, DocDate, price, ratio, class,
// address, characteristics) onto the appraisal; the case type follows the
// queue (transfer vs appeal).
//
// Multi-parcel: when the row's PINsInMult > 1 and a DocNumber is present,
// all sibling rows sharing the same DocNumber are auto-loaded as associated
// parcels in the portfolio. The clicked row becomes the main subject.
function openFromWorkQueue(type, r, allRows) {
  const meta = WORK_QUEUE_META[type] || WORK_QUEUE_META.transfers;
  // Preserve the current tab's in-progress data before resetting state (matches
  // openNew) so re-opening a row never silently discards an open appraisal.
  snapshotActiveTab();
  // If this APN is already open in a tab, focus it instead of creating a
  // duplicate. Unsaved tabs aren't deduped by id (addTab), so we dedupe by APN
  // here — clicking the same work-queue row twice must not spawn two tabs.
  const existing = findTabByApn(r.PIN);
  if (existing) { switchToTab(existing.key); return; }
  newAppraisal();
  const d = state.data;
  d.property.caseType = meta.caseType;
  mapWorkQueueRow(d, r, { main: true });

  // Multi-parcel detection: PINsInMult > 1 + DocNumber → load all siblings.
  const pinCount = Number(r.PINsInMult) || 0;
  const docNum = r.DocNumber || '';
  if (pinCount > 1 && docNum && Array.isArray(allRows)) {
    const siblings = allRows.filter(
      (row) => row.DocNumber === docNum && row.PIN !== r.PIN
    );
    for (const sib of siblings) {
      const parcel = createEmptyParcel(sib.PIN || '');
      mapWorkQueueRow(parcel, sib, { main: false });
      state.portfolio.parcels.push(parcel);
    }
    // Switch to portfolio view so the combined summary is immediately visible.
    if (state.portfolio.parcels.length > 1) {
      setViewMode('portfolio');
    }
  }

  state.dirty = true;
  addTab({ id: state.id, apn: d.property.apn, address: d.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  renderParcelStrip();
  scheduleAutosave();
  // Fetch coordinates for all parcels (async, non-blocking) so the portfolio
  // report can show intersections for parcels without a street address.
  fetchParcelCoordinates();
}

// Fetch lat/lng for each parcel in the portfolio from the parcel-data API and
// store them on the property. For parcels without a street address, also
// reverse-geocode (in the browser, via mapimg.js) to get the nearest
// intersection. Non-blocking: the report re-renders when done.
async function fetchParcelCoordinates() {
  const parcels = state.portfolio.parcels;
  const missing = parcels.filter((p) => p.property?.apn && !p.property?.lat);
  if (missing.length === 0) return;
  await Promise.allSettled(missing.map(async (p) => {
    try {
      const pd = await api.getParcelData(p.property.apn);
      if (pd?.lat && pd?.lng) {
        p.property.lat = Number(pd.lat);
        p.property.lng = Number(pd.lng);
        if (!p.property.address && pd.address) p.property.address = titleCase(pd.address);
      }
    } catch { /* parcel not in index — skip */ }
  }));
  // For parcels that still have no address, fetch the nearest intersection.
  const noAddr = parcels.filter((p) => {
    const a = p.property?.address;
    return (!a || a === '- No Situs -') && p.property?.lat && p.property?.lng;
  });
  if (noAddr.length > 0) {
    await Promise.allSettled(noAddr.map(async (p) => {
      try {
        const street = await reverseGeocode(p.property.lat, p.property.lng, p.property.city);
        if (street) p.property.intersection = street;
      } catch { /* geocode failed — keep coordinate fallback */ }
    }));
  }
  // Re-render the report so the updated coordinates/addresses/intersections are visible.
  renderReport();
}

// Populate the Property Summary + transfer fields from a transfer comp
// record (address, city, doc #, ratio code, price, year built, quality,
// condition, building type/area, land area, site area). Only overwrites
// with values the transfer actually carries.
function applyTransferCompFields(d, r) {
  const p = d.property;
  if (r.address) p.address = r.address;
  if (r.city) p.city = normalizeCity(r.city);
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

// Shared tail for the "open a new pre-filled appraisal" flows (openTransfer,
// openTransferComp, openAppraisalFromParcel): mark dirty, register the tab,
// show the appraisal view, and schedule a local autosave.
function commitNewAppraisal(message) {
  state.dirty = true;
  addTab({ id: state.id, apn: state.data.property.apn, address: state.data.property.address, dirty: true });
  showAppraisal();
  renderTabs();
  scheduleAutosave();
  if (message) toast(message);
}

// Open a new appraisal pre-filled from a work-queue transfer row: APN,
// document number, effective date = record date, sale price, ratio code,
// building type. Bucket rows carry no address/characteristics columns, so
// the Property Summary is enriched from the transfer comp store by APN.
async function openTransfer(r) {
  const apn = String(r.apn || '').trim();
  if (apn) {
    const openTab = findTabByApn(apn);
    if (openTab) {
      if (!document.getElementById('report-root')) showAppraisal();
      switchToTab(openTab.key);
      return;
    }
  }
  newAppraisal();
  const d = state.data;
  const p = d.property;
  p.apn = r.apn || '';
  p.transferDocumentNumber = r.docNumber || '';
  if (r.recordDate) p.effectiveDate = r.recordDate;
  p.salePrice = r.consid || 0;
  p.ratioCode = r.ratioCd || '';
  d.improvements.primary.type = r.classDescr || '';
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
  commitNewAppraisal();
}

async function openById(id) {
  try {
    snapshotActiveTab();   // preserve the active tab's edits before loading
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
  // Focus an already-open tab for this APN instead of spawning a duplicate.
  const openTab = findTabByApn(apn);
  if (openTab) { switchToTab(openTab.key); return; }
  const existing = apn.length > 0
    ? apnAppraisals.find((a) => String(a.apn || '').trim() === apn)
    : null;
  if (existing) { openById(existing.id); return; }
  snapshotActiveTab();   // preserve the active tab's edits before resetting state
  newAppraisal();
  const d = state.data;
  d.property.apn = r.apn || '';
  if (r.saleDate) d.property.effectiveDate = r.saleDate;
  applyTransferCompFields(d, r);
  commitNewAppraisal(`Opened ${r.apn || 'transfer'} from transfers — hit Save to keep it`);
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
        commitCoverApn(); // exit the cover APN chip's editing mode before re-render
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
          : el('span', { class: 's-src' }, 'Appraisal'),
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
      // County parcel records — shown alongside appraisals/transfer comps so a
      // PIN that already has an appraisal still surfaces its raw parcel record.
      const parcelSugg = (Array.isArray(parcelRows) ? parcelRows : [])
        .slice(0, 10)
        .map((r) => ({ kind: 'parcel', ...r }));
      apnSugg = [...appSugg, ...transSugg, ...parcelSugg].sort(byBook).slice(0, 20);
      renderSugg();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      apnSugg = []; renderSugg();
      // If this is the cover's APN search, Escape exits editing mode (back to the chip).
      if (box.closest('#cover-search-slot')) { commitCoverApn(); renderForm(); }
    }
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
      el('button', { class: 'st-btn', title: 'Print the report', onclick: printReport }, 'Print'),
      el('span', { class: 'st-sep' }),
      btn('−', 'Zoom out', () => zoomBy(-0.1)),
      pct,
      btn('+', 'Zoom in', () => zoomBy(0.1)),
      btn('Fit', 'Fit to width', zoomFit),
    ),
  );
}

// Print the report in place. The @media print rules in app.css hide all the
// workspace chrome (top bar, left form pane, split handle, staging toolbar)
// and lay the sheets out at exact letter size, so window.print() prints just
// the report from the current page.
function printReport() {
  const root = document.getElementById('report-root');
  if (!root || root.children.length === 0) { toast('Nothing to print yet — open the report first.', true); return; }
  window.print();
}

// Find an existing server-side WIP appraisal for the same APN + effective date,
// excluding the appraisal we're currently editing (if any). Returns the row or
// null. Used by onSaveWip to adopt an existing WIP so repeated saves update it
// in place instead of creating a duplicate.
async function findExistingWip(apn, effectiveDate, excludeId) {
  if (!apn) return null;
  let rows;
  try { rows = await api.listAppraisals(); } catch { return null; }
  const eff = effectiveDate || '';
  // Rows come back ordered by updated_at DESC. Match on APN first, then on the
  // effective date so there's one WIP per APN + effective date.
  const sameApn = rows.filter((r) => r.id !== excludeId && (r.apn || '') === apn);
  if (sameApn.length === 0) return null;
  // Exact effective-date match (both known and equal, or both empty).
  const exact = sameApn.find((r) => (r.effectiveDate || '') === eff);
  if (exact) return exact;
  // No exact match: only adopt a legacy WIP whose effective date is unknown
  // (null — created before the column existed) so repeated saves still update
  // it in place. Never clobber a WIP that has a different, known effective
  // date — that's a distinct appraisal and should get its own WIP.
  return sameApn.find((r) => !r.effectiveDate) || null;
}

// Save as WIP: persist the appraisal to the server (no finalize/archive) so it
// shows up in the WIP Archive and can be resumed later.
//
// One WIP per APN + effective date: if this appraisal isn't saved yet and a WIP
// already exists for the same APN + effective date, we adopt (overwrite) that
// WIP instead of creating a second one, so repeated saves never produce
// duplicates.
async function onSaveWip() {
  const p = state.data.property;
  const apn = (p.apn || '').trim();
  const eff = p.effectiveDate || '';

  let adopted = false;
  if (apn && state.id === null) {
    const existing = await findExistingWip(apn, eff, null);
    if (existing) {
      state.id = existing.id;
      adopted = true;
    }
  }

  try {
    const id = await saveCurrent();
    const t = activeTab();
    if (t) { t.id = id; t.dirty = false; }
    renderTabs();
    refreshTopBar();
    toast(adopted
      ? 'Updated the existing WIP for this APN + effective date.'
      : 'Saved as WIP — resume it any time from the WIP Archive.');
  } catch (e) {
    toast(`Save as WIP failed: ${e.message}`, true);
  }
}

// Upload pending (base64) photos to the parcel page and convert them to
// server file references. Photos are kept in the appraisal data while the
// report is being worked on and only land on the parcel page when the report
// is finalized. Covers the cover photo, the subject photos, and every
// comparable's photos (keyed by the comp's own APN).
async function flushPendingPhotos(data) {
  const p = data.property;
  const pending = [];
  const consider = (apn, photo) => {
    if (photo && photo.source === 'upload' && photo.dataUrl && String(apn || '').trim())
      pending.push({ apn: String(apn).trim(), photo });
  };
  consider(p.apn, p.subjectImage);
  for (const ph of Array.isArray(p.subjectPhotos) ? p.subjectPhotos : []) consider(p.apn, ph);
  for (const comp of Array.isArray(data.sales?.comparables) ? data.sales.comparables : [])
    for (const ph of Array.isArray(comp.photos) ? comp.photos : []) consider(comp.parcel, ph);
  for (const { apn, photo } of pending) {
    try {
      const blob = await (await fetch(photo.dataUrl)).blob();
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const fd = new FormData();
      fd.append('file', new File([blob], `photo-${Date.now()}.${ext}`, { type: blob.type }));
      const r = await fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`, { method: 'POST', body: fd });
      const res = await r.json();
      if (res.saved && res.saved[0]) {
        photo.file = res.saved[0];
        delete photo.dataUrl;
      } else throw new Error();
    } catch {
      toast(`Could not save a photo to the parcel page for ${apn}`, true);
    }
  }
}

// Finalize: save the appraisal, then archive it as a permanent sales comp
// (server-side). Every finalized appraisal becomes exactly one permanent comp;
// re-finalizing identical content is deduplicated.
async function onFinalize() {
  // No confirm() dialog: it is unreliable in this browser (auto-cancelled),
  // which made the button appear to do nothing. Re-finalizing identical
  // content is deduplicated server-side, so a stray click is harmless.
  try {
    await flushPendingPhotos(state.data);
    const id = await saveCurrent();
    const t = activeTab();
    if (t) { t.id = id; t.dirty = false; }
    const res = await api.finalize(id, portfolioPayload());
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
// Two archives: WIP (manually saved work-in-progress appraisals, from the
// appraisals table) and Final (finalized appraisals, the permanent comp store).
let archiveMode = 'wip';   // 'wip' | 'final'

// Normalize a row's case type to one of the section keys (missing/unknown →
// 'transfer', matching the model default).
function archiveCaseOf(r) {
  const ct = String(r.caseType || '').toLowerCase();
  return ['transfer', 'appeal', 'stipulation', 'general'].includes(ct) ? ct : 'transfer';
}

// Human-readable report-type label for the archive table column.
function archiveCaseLabel(r) {
  return { transfer: 'Transfer', appeal: 'Appeal', stipulation: 'Stipulation', general: 'General' }[archiveCaseOf(r)] || '—';
}

// Delete a WIP appraisal from the server, then refresh the archive list.
// No confirm() dialog: it is unreliable in this browser (auto-cancelled), which
// made the button appear to do nothing. The button is an explicit, clearly
// labeled destructive action, so it deletes on a single click.
async function deleteWip(r) {
  try {
    await api.deleteAppraisal(r.id);
    toast('WIP appraisal deleted.');
    renderArchive();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, true);
  }
}

async function showArchive(mode) {
  enterView('archive', [mode || archiveMode]);
  if (mode) archiveMode = mode;
  setTopBarLanding(false);
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  await renderArchive();
}

async function renderArchive() {
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));

  // Toggle between the WIP and Final archives.
  const toggle = el('div', { class: 'archive-toggle' },
    el('button', { class: `btn ${archiveMode === 'wip' ? 'primary' : ''}`, onclick: () => { archiveMode = 'wip'; renderArchive(); } }, 'WIP'),
    el('button', { class: `btn ${archiveMode === 'final' ? 'primary' : ''}`, onclick: () => { archiveMode = 'final'; renderArchive(); } }, 'Final'),
  );

  if (archiveMode === 'wip') {
    let rows;
    try { rows = await api.listAppraisals(); }
    catch (e) { main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`)); return; }
    rows = (Array.isArray(rows) ? rows : [])
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const shown = rows;
    main.replaceChildren(
      el('div', { class: 'list-view' },
        el('div', { class: 'list-head' },
          el('h2', {}, 'Archive'),
          toggle,
          el('span', { class: 'r2-sub' }, `${shown.length} work-in-progress appraisal${shown.length === 1 ? '' : 's'}`),
        ),
        el('table', { class: 'list-table' },
          el('thead', {}, el('tr', {}, ['APN', 'Address', 'City', 'Report Type', 'Report Date', 'Final Value', 'Updated', ''].map((h) => el('th', {}, h)))),
          el('tbody', {},
            shown.length === 0
              ? el('tr', {}, el('td', { colspan: 8 }, 'No WIP appraisals yet. Use “Save as WIP” to keep a working copy on the server.'))
              : shown.map((r) => el('tr', { class: 'clickable', onclick: () => openById(r.id) },
                  el('td', {}, r.apn || '—'),
                  el('td', {}, r.address || '—'),
                  el('td', {}, normalizeCity(r.city) || '—'),
                  el('td', {}, archiveCaseLabel(r)),
                  el('td', {}, r.reportDate ? fmtDate(r.reportDate) : '—'),
                  el('td', { class: 'num' }, r.finalValue != null ? fmtCurrency(r.finalValue) : '—'),
                  el('td', {}, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'),
                  el('td', {},
                    el('button', { class: 'btn tiny', onclick: (e) => { e.stopPropagation(); openById(r.id); } }, 'Open'),
                    ' ',
                    el('button', { class: 'btn tiny danger', title: 'Delete this WIP appraisal', onclick: (e) => { e.stopPropagation(); deleteWip(r); } }, 'Delete'),
                  ),
                )),
          ),
        ),
      ),
    );
    return;
  }

  // Final archive — the permanent comp store.
  let rows;
  try { rows = await api.getPermanentComps(); }
  catch (e) { main.replaceChildren(el('div', { class: 'list-empty' }, `Failed to load: ${e.message}`)); return; }
  rows = Array.isArray(rows) ? rows : [];
  const shown = rows;
  main.replaceChildren(
    el('div', { class: 'list-view' },
      el('div', { class: 'list-head' },
        el('h2', {}, 'Archive'),
        toggle,
        el('span', { class: 'r2-sub' }, `${shown.length} finalized appraisal${shown.length === 1 ? '' : 's'} · permanent comps`),
      ),
      el('table', { class: 'list-table' },
        el('thead', {}, el('tr', {}, ['APN', 'Address', 'City', 'Report Type', 'Sale Date', 'Price', 'Bldg SF', ''].map((h) => el('th', {}, h)))),
        el('tbody', {},
          shown.length === 0
            ? el('tr', {}, el('td', { colspan: 8 }, 'No appraisals archived yet. Finalize an appraisal to add it here.'))
            : shown.map((r) => el('tr', { class: 'clickable', onclick: () => openArchiveDetail(r) },
                el('td', {}, r.apn || '—'),
                el('td', {}, r.address || '—'),
                el('td', {}, normalizeCity(r.city) || '—'),
                el('td', {}, archiveCaseLabel(r)),
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
  enterView('archiveDetail', [r]);
  const main = document.getElementById('main');
  main.replaceChildren(
    el('div', { class: 'list-view archive-detail' },
      el('div', { class: 'list-head' },
        el('button', { class: 'btn', onclick: goBack }, '← Back'),
        el('h2', {}, r.apn || 'Archived Comp'),
      ),
      el('div', { class: 'arch-grid' },
        pinDetail('Address', r.address),
        pinDetail('City', normalizeCity(r.city)),
        pinDetail('Property Type', r.propertyType),
        pinDetail('Quality', r.quality),
        pinDetail('Condition', r.condition),
        pinDetail('Sale Date', r.saleDate),
        pinDetail('Price', r.price > 0 ? fmtCurrency(r.price) : '—'),
        pinDetail('Building SF', r.buildingArea > 0 ? Number(r.buildingArea).toLocaleString() : '—'),
        pinDetail('Land (acres)', r.landArea > 0 ? Number(r.landArea).toLocaleString() : '—'),
        pinDetail('Zoning', r.zoning),
      ),
    ),
  );
}

// --- PIN page ---------------------------------------------------------------
// One page per PIN: property characteristics from the county parcel record
// (input/master_parcel_list.csv), past valuations (appraisals saved for this APN),
// and a one-click "New Appraisal" pre-filled from the parcel data.
// Reachable from the top-bar search (parcel suggestions) or ?pin=APN.

const pinDetail = (label, value) => el('div', { class: 'arch-field' },
  el('div', { class: 'arch-label' }, label),
  el('div', { class: 'arch-value' }, (value === undefined || value === null || value === '') ? '—' : String(value)));

// Clean label/value pair for the PIN characteristics definition grid.
const pinDef = (label, value) => el('div', { class: 'pin-def' },
  el('div', { class: 'pin-def-k' }, label),
  el('div', { class: 'pin-def-v' }, (value === undefined || value === null || value === '') ? '—' : String(value)));

// --- parcel map ---------------------------------------------------------------
// Interactive parcel map (Leaflet, mapimg.js): live satellite imagery with
// zoom/pan, the parcel polygon overlaid, and an APN label. Returns a wrapper
// element; the Leaflet instance is torn down when the PIN page leaves the DOM
// (Leaflet keeps window listeners alive until map.remove() is called).
let _pinMapCleanup = null;
export function destroyPinMap() {
  if (_pinMapCleanup) { _pinMapCleanup(); _pinMapCleanup = null; }
}
function drawParcelMap(parcel) {
  const apn = String(parcel.Account || parcel.apn || '');
  const rings = parseWktRings(parcel.shape);
  if (rings.length === 0) {
    return el('div', { class: 'pin-map' },
      el('div', { class: 'pin-map-canvas pin-map-loading' }, 'No parcel geometry available.'));
  }
  const { el: wrap, destroy } = interactiveParcelMap(parcel.shape, apn);
  _pinMapCleanup = destroy;
  const cap = el('div', { class: 'pin-map-cap' },
    el('span', {}, 'Parcel Map · satellite'),
    el('span', { class: 'pin-map-cap-right' },
      el('button', {
        class: 'btn tiny pin-map-refreshbtn',
        title: 'Re-center the map on this parcel',
        onclick: () => { destroyPinMap(); const fresh = drawParcelMap(parcel); wrap.replaceWith(fresh); },
      }, '↻ Refresh'),
      el('button', { class: 'btn tiny pin-map-imgbtn', title: 'Open Google image search for this parcel', onclick: () => googleImageSearch(parcel) }, '🔍 Images'),
      el('span', { class: 'pin-map-attr' }, 'Imagery © Esri/World Imagery'),
    ));
  wrap.appendChild(cap);
  return wrap;
}

// User-attached photos for a PIN: thumbnail grid + add button + lightbox.
// The PIN page is the single place every PIN reference funnels through
// (landing search, top-bar search, ?pin=, appraisal page), so photos attached
// here are available wherever the PIN is opened in the app.
function drawPinPhotos(apn) {
  const grid = el('div', { class: 'pin-photos' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', style: 'display:none' });
  const addBtn = el('button', { class: 'btn tiny', title: 'Attach photos to this PIN' }, '＋ Add');
  addBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length === 0) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const r = await fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error();
      toast(`${files.length} photo${files.length > 1 ? 's' : ''} attached to ${apn}`);
      loadPhotos();
    } catch { toast('Photo upload failed', true); }
  };
  const section = el('div', { class: 'pin-section' },
    el('div', { class: 'pin-section-title pin-photos-head' }, 'Photos', addBtn),
    grid,
    fileInput,
  );

  async function loadPhotos() {
    let list = [];
    try {
      const r = await fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`);
      if (r.ok) list = await r.json();
    } catch { /* offline */ }
    grid.replaceChildren(...list.map((p, i) => {
      const t = el('div', { class: 'pin-photo-thumb', title: p.name });
      t.append(el('img', { src: p.url, alt: p.name, loading: 'lazy' }));
      const rm = el('button', { class: 'pin-photo-rm', title: `Delete ${p.name}` }, '×');
      rm.onclick = async (e) => {
        e.stopPropagation();
        try {
          const r = await fetch(p.url, { method: 'DELETE' });
          if (!r.ok) throw new Error();
          toast(`Deleted ${p.name}`);
          loadPhotos();
        } catch { toast('Delete failed', true); }
      };
      t.append(rm);
      t.onclick = () => openPhotoLightbox(list, i, loadPhotos);
      return t;
    }));
    if (list.length === 0) grid.append(el('div', { class: 'r2-none pin-photos-empty' }, 'No photos yet — attach site or condition photos.'));
  }
  loadPhotos();
  return section;
}

// Full-size photo viewer: prev/next arrows, delete, Esc / backdrop click closes.
function openPhotoLightbox(photos, index, onChanged) {
  const box = el('div', { class: 'photo-lightbox' });
  const img = el('img', { alt: '' });
  const cap = el('div', { class: 'photo-lightbox-cap' });
  const prev = el('button', { class: 'photo-lightbox-nav photo-lightbox-prev', title: 'Previous (←)' }, '‹');
  const next = el('button', { class: 'photo-lightbox-nav photo-lightbox-next', title: 'Next (→)' }, '›');
  const del = el('button', { class: 'btn tiny photo-lightbox-del', title: 'Delete this photo' }, '🗑 Delete');
  const close = el('button', { class: 'photo-lightbox-x', title: 'Close (Esc)' }, '×');
  box.append(img, cap, prev, next, del, close);
  let i = index;
  const show = (n) => {
    i = (n + photos.length) % photos.length;
    const p = photos[i];
    img.src = p.url;
    img.alt = p.name;
    cap.textContent = `${p.name} · ${p.added}`;
  };
  const shut = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') shut();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
  };
  prev.onclick = (e) => { e.stopPropagation(); show(i - 1); };
  next.onclick = (e) => { e.stopPropagation(); show(i + 1); };
  close.onclick = (e) => { e.stopPropagation(); shut(); };
  box.onclick = shut;
  img.onclick = (e) => e.stopPropagation();
  del.onclick = async (e) => {
    e.stopPropagation();
    const p = photos[i];
    try {
      const r = await fetch(p.url, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      photos.splice(i, 1);
      if (photos.length === 0) { shut(); } else { show(i); }
      if (onChanged) onChanged();
    } catch { toast('Delete failed', true); }
  };
  document.addEventListener('keydown', onKey);
  show(i);
  document.body.append(box);
}

// Build a Google image-search query for a parcel: the address when present,
// otherwise (vacant land) an intersection parsed from the legal description,
// falling back to the legal description or APN + city.
function parcelImageQuery(parcel) {
  if (!parcel) return '';
  const addr = String(parcel.address || '').trim();
  if (addr) return addr;
  const ld = String(parcel.LegalDescription || '');
  const m = ld.match(/AT\s+INTERSECTION\s+OF\s+(.{2,80}?)(?:\s+AND\s+(.{2,80}?))?/i);
  if (m) return (m[1] + (m[2] ? ' and ' + m[2] : '')).trim();
  if (ld) return ld;
  const city = normalizeCity(String(parcel.District || '').split(' ').slice(1).join(' '));
  return `${parcel.Account || ''} ${city}`.trim();
}

function googleImageSearch(parcel) {
  const q = parcelImageQuery(parcel);
  if (!q) { toast('No address or intersection to search for', true); return; }
  window.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q), '_blank', 'noopener');
}

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

// Where the PIN page's back button returns to. Set to 'appraisal' when the
// Open the county parcel page for the current report's APN. The working
// appraisal is preserved, so the PIN page's Back button (navigation history)
// returns here.
function viewParcelFromReport() {
  const apn = String(state.data?.property?.apn || '').trim();
  if (!apn) { toast('No APN on this appraisal yet', true); return; }
  showPinPage(apn);
}

async function showPinPage(apn) {
  enterView('pin', [apn]);
  const main = document.getElementById('main');
  setTopBarLanding(false);
  main.replaceChildren(el('div', { class: 'list-empty' }, 'Loading…'));
  let parcel = null;
  try { parcel = await api.getParcelData(apn); } catch { /* no county record */ }
  let appRows = [];
  try { appRows = await api.listAppraisals(); } catch { /* offline data */ }
  const mine = appRows
    .filter((r) => String(r.apn || '').trim() === String(apn).trim())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(b.reportDate || '').localeCompare(String(a.reportDate || '')));
  // Work-queue items (transfers / appeals) that reference this PIN, so the
  // parcel page doubles as a hub for anything queued against it. `allRows`
  // is kept per item so openFromWorkQueue can still detect multi-parcel
  // siblings by DocNumber.
  const wqItems = [];
  for (const type of ['transfers', 'appeals']) {
    let data = null;
    try { data = await api.getWorkQueue(type); } catch { /* no file / offline */ }
    const allRows = (data && Array.isArray(data.rows)) ? data.rows : [];
    for (const r of allRows) {
      if (String(r.PIN || '').trim() === String(apn).trim()) wqItems.push({ type, row: r, allRows });
    }
  }

  const view = el('div', { class: 'list-view pin-view' },
    el('div', { class: 'list-head' },
      el('div', { class: 'pin-head-left' },
        el('button', { class: 'btn', title: 'Back to the previous page', onclick: goBack }, '←'),
        el('h2', {}, apn),
        el('span', { class: 'pin-sub' }, [parcel?.address, normalizeCity(parcel?.city), parcel?.class].filter(Boolean).join(' · ')),
      ),
      el('div', { class: 'pin-actions' },
        el('span', { class: 'pin-actions-label' }, 'Start a report'),
        el('button', { class: 'btn primary', title: 'Transfer valuation report', onclick: () => openAppraisalFromParcel(apn, 'transfer') }, 'Transfer'),
        el('button', { class: 'btn', title: 'Appeal valuation report', onclick: () => openAppraisalFromParcel(apn, 'appeal') }, 'Appeal'),
        el('button', { class: 'btn', title: 'Stipulation report', onclick: () => openAppraisalFromParcel(apn, 'stipulation') }, 'Stipulation'),
        el('button', { class: 'btn', title: 'General appraisal — a valuation as of a date', onclick: () => openAppraisalFromParcel(apn, 'general') }, 'General'),
      ),
    ),
    el('div', { id: 'pin-body' }),
  );
  main.replaceChildren(view);
  renderPinBody(apn, parcel, mine, wqItems);
}

function renderPinBody(apn, parcel, mine, wqItems = []) {
  const body = document.getElementById('pin-body');
  if (!body) return;

  // Build a header row from [label, isNumeric] pairs so numeric headers
  // right-align to match their (right-aligned) cells.
  const pinHead = (cols) => el('thead', {}, el('tr', {}, cols.map(([h, num]) => el('th', { class: num ? 'num' : '' }, h))));

  // Work-queue section: any transfer / appeal rows queued against this PIN.
  // Shown even when the county record is missing (a queued PIN is still
  // actionable), and with an empty state otherwise.
  const wqSection = el('div', { class: 'pin-section' },
    el('div', { class: 'pin-section-title' }, `Work Queue (${wqItems.length})`),
    wqItems.length === 0
      ? el('div', { class: 'r2-none' }, 'Not in the transfer or appeal work queue.')
      : el('table', { class: 'list-table' },
          pinHead([['Queue'], ['Doc #'], ['Record Date'], ['Price', true], ['Class'], ['']]),
          el('tbody', {}, wqItems.map(({ type, row, allRows }) => el('tr', {},
            el('td', {}, type === 'transfers' ? 'Transfer' : 'Appeal'),
            el('td', {}, row.DocNumber || '—'),
            el('td', {}, row.RecordDate || row.DocDate || '—'),
            el('td', { class: 'num' }, wqPrice(row) || '—'),
            el('td', {}, row.ClassCdDescr || '—'),
            el('td', {}, el('button', { class: 'btn tiny', title: 'Open this work-queue row as a new appraisal', onclick: () => openFromWorkQueue(type, row, allRows) }, 'Open')),
          ))),
        ),
  );

  if (!parcel) {
    body.replaceChildren(wqSection, el('div', { class: 'r2-none' }, 'No county parcel record for this PIN — start an appraisal manually.'));
    return;
  }
  const city = String(parcel.District || '').split(' ').slice(1).join(' ');
  const buildings = pinBuildings(parcel);
  // Sort key for MM-DD-YYYY sale dates (county format) so cross-year ordering is correct.
  const saleKey = (s) => { const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : String(s || ''); };
  // Recent-first ordering for the history tables.
  const sales = [...(parcel.sales || [])].sort((a, b) => saleKey(b.saledate).localeCompare(saleKey(a.saledate)));
  const taxHistory = [...(parcel.history || [])].sort((a, b) => Number(b.TaxYear || 0) - Number(a.TaxYear || 0));

  // Left (main) column: characteristics, buildings, sales + tax history, past
  // in-app valuations, then the work queue at the bottom. Right column: the
  // parcel map on its own.
  const left = el('div', { class: 'pin-col pin-col-main' },
    el('div', { class: 'pin-section' },
      el('div', { class: 'pin-section-title' }, 'Characteristics'),
      el('div', { class: 'pin-defs' },
        pinDef('Class', titleCase(parcel.class_code)),
        pinDef('Address', titleCase(parcel.address)),
        pinDef('City', normalizeCity(city)),
        pinDef('Zip', parcel.PostalCd || ''),
        pinDef('District', titleCase(parcel.District)),
        pinDef('Zoning', parcel.Zoning || ''),
        pinDef('Acreage', fmtAcresNum(parcel.acreage)),
        pinDef('Site SqFt', fmtNumber(Number(String(parcel.SquareFeet).replace(/[^0-9.]/g, '')) || 0)),
        pinDef('Legal Description', titleCase(parcel.LegalDescription)),
        pinDef('Coordinates', parcel.lat && parcel.lng ? `${parcel.lat}, ${parcel.lng}` : ''),
      ),
    ),
    buildings.length > 0 ? el('div', { class: 'pin-section' },
      el('div', { class: 'pin-section-title' }, `Buildings (${buildings.length})`),
      el('table', { class: 'list-table' },
        pinHead([['Building'], ['Type'], ['Year Built', true], ['Quality', true], ['Condition'], ['Area SF', true]]),
        el('tbody', {}, buildings.map((b) => el('tr', {},
          el('td', {}, b.name),
          el('td', {}, b.type || '—'),
          el('td', { class: 'num' }, b.yearBuilt || '—'),
          el('td', { class: 'num' }, b.quality || '—'),
          el('td', {}, b.condition || '—'),
          el('td', { class: 'num' }, b.area || '—'),
        ))),
      ))
      : null,
    (parcel.sales || []).length > 0 ? el('div', { class: 'pin-section' },
      el('div', { class: 'pin-section-title' }, 'Transfer History'),
      el('table', { class: 'list-table' },
        pinHead([['Transfer Date'], ['Price', true], ['Ratio'], ['Doc #']]),
        el('tbody', {}, sales.map((s) => el('tr', {},
          el('td', {}, s.saledate || '—'),
          el('td', { class: 'num' }, s.SalePrice ? fmtCurrency(Number(String(s.SalePrice).replace(/[^0-9.]/g, '')) || 0) : '—'),
          el('td', {}, s.LocalRatioCd || '—'),
          el('td', {}, s.DocNumber || '—'),
        ))),
      ))
      : null,
    (parcel.history || []).length > 0 ? el('div', { class: 'pin-section' },
      el('div', { class: 'pin-section-title' }, 'Tax History'),
      el('table', { class: 'list-table' },
        pinHead([['Year'], ['Type'], ['Total Assessed', true], ['Land', true], ['Structure', true]]),
        el('tbody', {}, taxHistory.map((h) => el('tr', {},
          el('td', {}, h.TaxYear || '—'),
          el('td', {}, h.EventType || '—'),
          el('td', { class: 'num' }, fmtCurrency(Number(String(h.AssessedTot || '').replace(/[^0-9.]/g, '')) || 0)),
          el('td', { class: 'num' }, fmtCurrency(Number(String(h.AssessedLand || '').replace(/[^0-9.]/g, '')) || 0)),
          el('td', { class: 'num' }, fmtCurrency(Number(String(h.AssessedStructure || '').replace(/[^0-9.]/g, '')) || 0)),
        ))),
      ))
      : null,
    el('div', { class: 'pin-section' },
      el('div', { class: 'pin-section-title' }, `Past In-App Valuations (${mine.length})`),
      mine.length === 0
        ? el('div', { class: 'r2-none' }, 'No appraisals for this PIN yet — start one above.')
        : el('div', { class: 'pin-scroll' },
            el('table', { class: 'list-table' },
              pinHead([['Report Date'], ['Final Value', true], ['Updated'], ['']]),
              el('tbody', {}, mine.map((r) => el('tr', { class: 'clickable', onclick: () => openById(r.id) },
                el('td', {}, r.reportDate ? fmtDate(r.reportDate) : '—'),
                el('td', { class: 'num' }, r.finalValue != null ? fmtCurrency(r.finalValue) : '—'),
                el('td', {}, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'),
                el('td', {}, el('button', { class: 'btn tiny', onclick: (e) => { e.stopPropagation(); openById(r.id); } }, 'Open')),
              ))),
            ),
          ),
    ),
    wqSection,
  );

  // Right column: the parcel map on its own (with the image-search button in
  // its caption). Falls back to a placeholder when there is no shape.
  const right = el('div', { class: 'pin-col pin-col-side' },
    drawParcelMap(parcel)
      || el('div', { class: 'r2-none' }, 'No parcel shape available for this PIN.'),
    drawPinPhotos(apn),
  );

  body.replaceChildren(el('div', { class: 'pin-cols' }, left, right));
}

// Start a new appraisal pre-filled from the county parcel record: address,
// city, legal description, class, primary building characteristics, and land
// sizes. Only overwrites fields the parcel actually carries.
function applyParcelFields(d, p) {
  if (!p || typeof p !== 'object') return;
  const prop = d.property;
  if (p.address) prop.address = titleCase(p.address);
  const district = String(p.District || '').trim();
  if (district) prop.city = normalizeCity(district.split(' ').slice(1).join(' '));
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

async function openAppraisalFromParcel(apn, caseType = 'transfer') {
  // Focus an already-open tab for this APN instead of spawning a duplicate.
  const openTab = findTabByApn(apn);
  if (openTab) { switchToTab(openTab.key); return; }
  snapshotActiveTab();   // preserve the active tab's edits before resetting state
  newAppraisal();
  const d = state.data;
  d.property.apn = apn;
  d.property.caseType = caseType;
  try {
    const parcel = await api.getParcelData(apn);
    applyParcelFields(d, parcel);
  } catch { /* no county record — start blank */ }
  commitNewAppraisal(`Opened ${apn} — property data pre-filled from the county record`);
}

function showAppraisal() {
  // Capture the active tab key so Back can return to the same tab (the
  // appraisal view is stateful — it renders whichever tab is active).
  enterView('appraisal', [workspace.activeKey]);
  const main = document.getElementById('main');
  setTopBarLanding(false);
  document.getElementById('topbar').classList.add('tb-appraisal');
  const left = el('div', { class: 'pane pane-left' },
    el('div', { id: 'tab-strip', class: 'tab-strip' }),
    el('div', { id: 'parcel-strip', class: 'parcel-strip' }),
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
  renderParcelStrip();
  // For multi-parcel portfolios, fetch coordinates + intersections (async).
  if (state.portfolio.parcels.length > 1) fetchParcelCoordinates();
}

// --- multi-parcel strip (which parcel within the active appraisal) ------------
// Sits below the workspace tab strip. "Combined Portfolio Summary" appears only
// when there are multiple parcels; each parcel gets a tab (with a remove ×).
// The active tab is the portfolio summary (viewMode==='portfolio') or the
// active parcel index.
function renderParcelStrip() {
  const root = document.getElementById('parcel-strip');
  if (!root) return;
  const parcels = state.portfolio.parcels;
  const activeIdx = activeParcelIndex();
  // Multi-parcel portfolios manage parcels from the Cover tab's Combined
  // Portfolio Summary — no per-parcel "Main Subject / Associated" tabs here.
  if (isPortfolio()) { root.replaceChildren(); return; }
  const nodes = [];
  parcels.forEach((p, i) => {
    const label = i === 0 ? 'Main Subject' : 'Associated';
    const apn = p.property?.apn || '—';
    nodes.push(el('div', {
      class: `parcel-tab ${state.viewMode === 'parcel' && i === activeIdx ? 'active' : ''}`,
      title: `${label} · APN ${apn}`,
    },
      el('button', {
        class: 'parcel-tab-label',
        onclick: () => { selectParcel(i); renderParcelStrip(); renderForm(); renderReport(); refreshTopBar(); },
      }, `${i + 1} · ${label}${apn !== '—' ? ` · ${apn}` : ''}`),
      parcels.length > 1 ? el('button', {
        class: 'parcel-tab-close', title: 'Remove parcel',
        onclick: (e) => { e.stopPropagation(); removeParcel(i); renderParcelStrip(); renderForm(); renderReport(); refreshTopBar(); },
      }, '×') : null,
    ));
  });
  nodes.push(el('button', {
    class: 'parcel-tab-add', title: 'Add an associated parcel to this appraisal',
    onclick: () => { addParcel(''); renderParcelStrip(); renderForm(); renderReport(); refreshTopBar(); },
  }, '+ Add Parcel'));
  root.replaceChildren(...nodes);
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
  // Default: restore the open workspace from IndexedDB (F5 recovery) if there
  // is one; otherwise show the landing page (workflow selection).
  const restored = await restoreWorkspaceLocal();
  if (restored && workspace.tabs.length > 0) {
    showAppraisal();
    renderTabs();
    refreshTopBar();
    return;
  }
  showLanding();
}

// "View Parcel" button in the cover APN chip (form.js) opens the county PIN page.
window.addEventListener('appraisal:view-parcel', viewParcelFromReport);
// Form edits update the top-bar headline + total assessed.
window.addEventListener('appraisal:changed', refreshTopBar);
// Portfolio ops (add/remove/select parcel, switch view) from the form's summary
// panel refresh the parcel strip + top bar (form.js re-renders form + report).
window.addEventListener('portfolio:changed', () => { renderParcelStrip(); refreshTopBar(); });
// Keep the active workspace tab's label + dirty marker in sync.
window.addEventListener('appraisal:changed', updateTabStrip);
// Debounced autosave of the working appraisal (WIP) on every form edit.
window.addEventListener('appraisal:changed', scheduleAutosave);

// Close the work-queue Columns menu when clicking anywhere outside it (bound once).
document.addEventListener('click', () => {
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