// ---------------------------------------------------------------------------
// form.js — left workspace: tabbed appraisal form
// 1:1 port of the original PropertyForm (Subject / Sales / Income / Reconcile / Cost)
// ---------------------------------------------------------------------------
import {
  state, markDirty, computeAppraisal, hasCostData, hasIncomeData,
  fmtCurrency, fmtCurrencyRounded, fmtNumber, fmtPct, fmtDate, normalizeCity, titleCase, api,
  getLocalComps, clearLocalComps, importLocalComps, scheduleAutosave,
  resolveSubjectImageUrl, rankCompsBySimilarity,
} from './core.js';
import { renderReport, scrollToSection } from './report.js';

const TABS = [
  { id: 'cover', label: 'Cover' },
  { id: 'subject', label: 'Subject' },
  { id: 'sales', label: 'Sales' },
  { id: 'income', label: 'Income' },
  { id: 'reconciliation', label: 'Reconcile' },
  { id: 'cost', label: 'Cost' },
];
let activeTab = 'cover';
let activeCompIdx = 0;

const TYPE_OPTIONS = [
  'Commercial / Office-Retail', 'Office', 'Retail', 'Multi-Family',
  'Industrial / Warehouse', 'Single-Family', 'Accessory',
];
const CONDITION_OPTIONS = ['New', 'Excellent', 'Good', 'Average', 'Fair', 'Poor'];
const COMP_QUALITY = ['C1.0', 'C2.0', 'C2.5', 'C3.0', 'C4.0'];
const COMP_CONDITION = ['Above Average', 'Average', 'Below Average'];
const ADJ_FIELDS = [
  ['adjBuildingSize', 'Building Size'],
  ['adjLocation', 'Location'],
  ['adjCornerSite', 'Corner Site / Access'],
  ['adjAge', 'Age'],
  ['adjQuality', 'Quality'],
  ['adjCondition', 'Condition'],
  ['adjTenantsUse', 'Tenants / Use'],
  ['adjOccupancy', 'Occupancy'],
  ['adjLandBldgRatio', 'Land to Bldg. Ratio'],
  ['adjFreeway', 'Freeway Exposure'],
  ['adjMarketConditions', 'Market Conditions'],
  ['adjConditionOfSale', 'Condition of Sale'],
];

// --- dom helper --------------------------------------------------------------

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

// --- state path binding ------------------------------------------------------

function resolvePath(path) {
  const parts = path.split('.');
  const key = parts.pop();
  let parent = state.data;
  for (const p of parts) parent = parent[p];
  return [parent, key];
}

// --- computed value formatting (live [data-calc] / [data-data] updates) ------

function fmtVal(v, fmt) {
  const n = Number(v) || 0;
  switch (fmt) {
    case 'curR': return fmtCurrencyRounded(n);
    case 'neg': return `(${fmtCurrency(n)})`;
    case 'pct1': return fmtPct(n, 1);
    case 'pct0': return fmtPct(n, 0);
    case 'sf2': return n > 0 ? n.toFixed(2) : '—';
    case 'num': return fmtNumber(n);
    case 'raw': return v == null || v === '' ? '—' : String(v);
    default: return fmtCurrency(n);
  }
}

function calcValue(path) {
  if (path === 'effAge') {
    const d = state.data;
    const yb = d.improvements.primary.yearBuilt;
    const ed = d.property.effectiveDate;
    return yb && ed ? parseInt(String(ed).slice(0, 4), 10) - yb : 0;
  }
  if (path === 'finalValue') {
    const c = computeAppraisal(state.data);
    return state.data.reconciliation.finalValue || c.reconciliation.weightedValue;
  }
  if (path === 'landValue') return state.data.land.landValue || 0;
  if (path === 'functionalDep') return state.data.cost.functionalDepreciation || 0;
  if (path === 'economicDep') return state.data.cost.economicDepreciation || 0;
  if (path === 'cover.rollTotal') return (state.data.cover.valueCategories || []).reduce((s, r) => s + (r.rollValue || 0), 0);
  if (path === 'cover.stipTotal') return (state.data.cover.valueCategories || []).reduce((s, r) => s + (r.stipulatedValue || 0), 0);
  const c = computeAppraisal(state.data);
  let v = c;
  for (const p of path.split('.')) v = v?.[p];
  return v;
}

function dataValue(path) {
  let v = state.data;
  for (const p of path.split('.')) v = v?.[p];
  return v;
}

// Re-render all live computed values in the form, then the report.
function refreshComputed() {
  document.querySelectorAll('[data-calc]').forEach((n) => {
    n.textContent = fmtVal(calcValue(n.dataset.calc), n.dataset.fmt || 'cur');
  });
  document.querySelectorAll('[data-data]').forEach((n) => {
    n.textContent = fmtVal(dataValue(n.dataset.data), n.dataset.fmt || 'raw');
  });
  renderReport();
  window.dispatchEvent(new CustomEvent('appraisal:changed'));
}

// --- field builders ----------------------------------------------------------

function bindInput(input, apply) {
  input.addEventListener('input', () => { apply(input.value); markDirty(); refreshComputed(); });
}

// 9px uppercase label + h-5 text input (fields.tsx TextField)
function textField(label, path, opts = {}) {
  const [parent, key] = resolvePath(path);
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const input = el('input', { class: 'inp', type: opts.type || 'text' });
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.value = parent[key] ?? '';
  if (opts.selectOnFocus) input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v; });
  wrap.append(input);
  return wrap;
}

// 9px uppercase label + h-7 number wrapper with $ / % chips (fields.tsx NumberField)
function numField(label, path, opts = {}) {
  const [parent, key] = resolvePath(path);
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const box = el('div', { class: 'numwrap' });
  if (opts.prefix) box.append(el('span', { class: 'chip-pre' }, opts.prefix));
  const input = el('input', { type: 'number', step: opts.step ?? 'any' });
  // Show blank (not 0) for empty/default numeric fields; a real 0 the user
  // types still reads back as 0 while editing.
  input.value = (Number.isFinite(parent[key]) && parent[key] !== 0) ? parent[key] : '';
  input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v === '' ? 0 : Number(v); });
  box.append(input);
  if (opts.suffix) box.append(el('span', { class: 'chip-post' }, opts.suffix));
  wrap.append(box);
  return wrap;
}

// 9px uppercase label + h-7 select (fields.tsx SelectField)
// A current value outside the option list (e.g. a county class description
// like "Office - General") is added so it displays instead of blank.
function selectField(label, path, options) {
  const [parent, key] = resolvePath(path);
  const cur = parent[key];
  const opts = cur && !options.includes(cur) ? [cur, ...options] : options;
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const sel = el('select', { class: 'inp' });
  sel.append(el('option', { value: '' }, 'Select…'));
  for (const o of opts) {
    const opt = el('option', { value: o }, o);
    if (cur === o) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => { parent[key] = sel.value; markDirty(); refreshComputed(); });
  wrap.append(sel);
  return wrap;
}

// textarea (ui/textarea)
function areaField(label, path, rows = 3) {
  const [parent, key] = resolvePath(path);
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const ta = el('textarea', { class: 'inp', rows });
  ta.value = parent[key] ?? '';
  bindInput(ta, (v) => { parent[key] = v; });
  wrap.append(ta);
  return wrap;
}

// section box with navy header bar (fields.tsx Section)
function section(title, desc, right, ...body) {
  return el('section', { class: 'section' },
    el('header', {},
      el('div', {}, el('h3', {}, title), desc ? el('div', { class: 'desc' }, desc) : null),
      right ? el('div', {}, right) : null,
    ),
    el('div', { class: 'section-body' }, body),
  );
}

// read-only computed chip (fields.tsx ComputedChip)
function chip(label, calcPath, opts = {}) {
  return el('div', { class: `chip ${opts.emphasis ? 'emphasis' : ''}` },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value', 'data-calc': calcPath, 'data-fmt': opts.fmt || 'cur' },
      fmtVal(calcValue(calcPath), opts.fmt || 'cur')),
  );
}

// schedule row (IncomeTab/CostTab Row)
function schedRow(label, calcPath, opts = {}) {
  return el('div', { class: `sched-row ${opts.strong ? 'strong' : ''}` },
    el('span', { class: 's-label' }, label),
    el('span', { class: `s-value ${opts.neg ? 'neg' : ''}`, 'data-calc': calcPath, 'data-fmt': opts.fmt || 'cur' },
      fmtVal(calcValue(calcPath), opts.fmt || 'cur')),
  );
}

// dense label + bare input pair (PropertyTab dense grid)
function denseInput(path, type = 'text') {
  const [parent, key] = resolvePath(path);
  const input = el('input', { class: 'inp', type });
  input.value = parent[key] ?? '';
  input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v; });
  return input;
}
function denseNum(path) {
  const [parent, key] = resolvePath(path);
  const input = el('input', { class: 'inp', type: 'number', step: 'any' });
  input.value = (Number.isFinite(parent[key]) && parent[key] !== 0) ? parent[key] : '';
  input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v === '' ? 0 : Number(v); });
  return input;
}
// Like selectField: a current value outside the option list is added so it
// displays instead of blank.
function denseSelect(path, options) {
  const [parent, key] = resolvePath(path);
  const cur = parent[key];
  const opts = cur && !options.includes(cur) ? [cur, ...options] : options;
  const sel = el('select', { class: 'inp' });
  sel.append(el('option', { value: '' }, ''));
  for (const o of opts) {
    const opt = el('option', { value: o }, o);
    if (cur === o) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => { parent[key] = sel.value; markDirty(); refreshComputed(); });
  return sel;
}

// --- Subject tab (PropertyTab) ------------------------------------------------

function imgBox(title, path) {
  const [parent, key] = resolvePath(path);
  const body = el('div', { class: 'img-body' });
  const render = () => {
    body.replaceChildren();
    if (parent[key]) {
      body.append(el('img', { class: 'img-preview', src: parent[key] }));
      const del = el('button', { class: 'btn tiny danger' }, 'Remove');
      del.onclick = () => { parent[key] = undefined; markDirty(); refreshComputed(); render(); };
      body.append(el('div', { class: 'img-actions' }, del));
    } else {
      body.append(el('div', { class: 'img-empty' }, 'No image'));
    }
    const file = el('input', { type: 'file', accept: 'image/*' });
    file.onchange = () => {
      const f = file.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { parent[key] = r.result; markDirty(); refreshComputed(); render(); };
      r.readAsDataURL(f);
    };
    body.append(file);
  };
  render();
  return el('div', { class: 'img-box' }, el('header', {}, el('span', {}, title)), body);
}

// --- subject photo upload (browse / drag-drop / paste) ------------------------
// --- subject image panel (GIS map / upload) -----------------------------------
// Two-mode image selector: "GIS Map" fetches the cached satellite snapshot,
// "Upload / Paste" accepts browse, drag-drop, or Ctrl+V. Stores a reference
// (not base64) in state.data.property.subjectImage.
let activeImageDrop = null;
let imagePasteBound = false;

function subjectImagePanel() {
  const d = state.data;
  const p = d.property;
  const apn = String(p.apn || '').trim();
  const wrap = el('div', { class: 'img-panel' });
  const preview = el('div', { class: 'img-panel-preview' });
  const modeBtns = el('div', { class: 'img-panel-modes' });

  const currentUrl = () => resolveSubjectImageUrl(d);

  const renderPreview = () => {
    preview.replaceChildren();
    const url = currentUrl();
    if (url) {
      preview.append(el('img', { src: url, alt: 'Subject property' }));
      const actions = el('div', { class: 'img-panel-actions' });
      const removeBtn = el('button', { class: 'btn tiny danger' }, 'Remove');
      removeBtn.onclick = () => { p.subjectImage = null; markDirty(); refreshComputed(); renderPreview(); };
      actions.append(removeBtn);
      preview.append(actions);
    } else {
      preview.append(el('div', { class: 'img-panel-empty' }, 'No image set'));
    }
  };

  // GIS Map button
  const gisBtn = el('button', { class: 'btn tiny img-mode-btn' }, '🛰 GIS Map');
  gisBtn.onclick = () => {
    if (!apn) { toast('Set an APN first', true); return; }
    p.subjectImage = { source: 'gis' };
    markDirty(); refreshComputed(); renderPreview();
  };

  // Upload / Paste button + drop zone
  const fileInput = el('input', { type: 'file', accept: 'image/*' });
  fileInput.style.display = 'none';
  const uploadBtn = el('button', { class: 'btn tiny img-mode-btn' }, '📷 Upload / Paste');
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (!apn) { toast('Set an APN first', true); return; }
    const fd = new FormData();
    fd.append('file', f);
    fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`, { method: 'POST', body: fd })
      .then(r => r.json())
      .then(res => {
        if (res.saved && res.saved[0]) {
          p.subjectImage = { source: 'upload', file: res.saved[0] };
          markDirty(); refreshComputed(); renderPreview();
        }
      }).catch(() => toast('Upload failed', true));
    fileInput.value = '';
  };

  // Drag & drop onto the preview area
  preview.ondragover = (e) => { e.preventDefault(); preview.classList.add('drag'); };
  preview.ondragleave = () => preview.classList.remove('drag');
  preview.ondrop = (e) => {
    e.preventDefault(); preview.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (!apn) { toast('Set an APN first', true); return; }
    const fd = new FormData();
    fd.append('file', f);
    fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`, { method: 'POST', body: fd })
      .then(r => r.json())
      .then(res => {
        if (res.saved && res.saved[0]) {
          p.subjectImage = { source: 'upload', file: res.saved[0] };
          markDirty(); refreshComputed(); renderPreview();
        }
      }).catch(() => toast('Upload failed', true));
  };

  // Paste handler
  if (!imagePasteBound) {
    imagePasteBound = true;
    document.addEventListener('paste', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f && apn) {
            const fd = new FormData();
            fd.append('file', f);
            fetch(`/api/parcel-photos/${encodeURIComponent(apn)}`, { method: 'POST', body: fd })
              .then(r => r.json())
              .then(res => {
                if (res.saved && res.saved[0]) {
                  p.subjectImage = { source: 'upload', file: res.saved[0] };
                  markDirty(); refreshComputed(); renderPreview();
                }
              }).catch(() => toast('Upload failed', true));
            e.preventDefault();
            break;
          }
        }
      }
    });
  }

  modeBtns.append(gisBtn, uploadBtn);
  wrap.append(
    el('div', { class: 'img-panel-head' }, el('span', { class: 'img-panel-title' }, 'Subject Property Image'), modeBtns),
    preview,
    fileInput,
  );
  renderPreview();
  return wrap;
}

function subjectTab() {
  const d = state.data;
  const imp = d.improvements.primary;
  const { outbuildings } = d.improvements;

  const dgCell = (label, node) => el('div', { class: 'dg-cell' }, el('span', { class: 'dg-cell-label' }, label), node);
  const psGroup = (title, fields, extra) => el('div', { class: 'ps-group' },
    el('div', { class: 'ps-group-title' }, title),
    el('div', { class: 'ps-group-grid' }, ...fields),
    extra || null,
  );

  // Property Summary — combined site + building characteristics (dense grid)
  const addOutbuilding = () => {
    const id = `imp-${Date.now()}`;
    d.improvements.outbuildings = [
      ...outbuildings,
      {
        id, name: `Building ${outbuildings.length + 2}`, type: 'Accessory',
        yearBuilt: 2000, grossFloorArea: 500, nla: 500, quality: '',
        constructionType: 'Wood frame, metal siding', stories: 1,
        condition: 'Average', unitCost: 120,
      },
    ];
    markDirty();
    renderForm();
    refreshComputed();
  };

  const summary = section('Property Summary', null, null,
    psGroup('Property', [
      dgCell('Address', denseInput('property.address')),
      dgCell('Parcel Number', denseInput('property.apn')),
      dgCell('City', denseInput('property.city')),
      dgCell('Property Type', denseSelect('improvements.primary.type', TYPE_OPTIONS)),
    ]),
    psGroup('Building', [
      dgCell('Building Area (SF)', denseNum('improvements.primary.grossFloorArea')),
      dgCell('Leasable Area (SF)', denseNum('improvements.primary.nla')),
      dgCell('Year Built', denseNum('improvements.primary.yearBuilt')),
      dgCell('Effective Age', el('input', { class: 'inp', readonly: true, 'data-calc': 'effAge', 'data-fmt': 'num' })),
      dgCell('Quality', denseInput('improvements.primary.quality')),
      dgCell('Condition', denseSelect('improvements.primary.condition', CONDITION_OPTIONS)),
    ]),
    psGroup('Land', [
      dgCell('Site Area (Acres)', denseNum('land.acres')),
      dgCell('Site Area (SF)', denseNum('land.siteAreaSqFt')),
      dgCell('Zoning', denseInput('land.zoning')),
    ]),
  );

  // Outbuildings
  const obSection = outbuildings.length > 0
    ? section('Outbuildings', null, null,
        outbuildings.map((o) => {
          const set = (patch) => {
            d.improvements.outbuildings = d.improvements.outbuildings.map((x) => (x.id === o.id ? { ...x, ...patch } : x));
            markDirty();
            refreshComputed();
          };
          const remove = () => {
            d.improvements.outbuildings = d.improvements.outbuildings.filter((x) => x.id !== o.id);
            markDirty();
            renderForm();
            refreshComputed();
          };
          return el('div', { class: 'ob-row' },
            el('div', { class: 'ob-head' },
              el('span', {}, o.name || 'Outbuilding'),
              el('button', { class: 'btn tiny danger', onclick: remove }, 'Remove'),
            ),
            el('div', { class: 'field-grid c3' },
              numField('Gross Floor Area (sq ft)', `improvements.outbuildings.${d.improvements.outbuildings.indexOf(o)}.grossFloorArea`),
              selectField('Condition', `improvements.outbuildings.${d.improvements.outbuildings.indexOf(o)}.condition`, CONDITION_OPTIONS),
              numField('Unit Cost ($/sq ft)', `improvements.outbuildings.${d.improvements.outbuildings.indexOf(o)}.unitCost`, { prefix: '$' }),
            ),
          );
        }),
      )
    : null;

  return [summary, obSection];
}

// --- Sales tab (SalesTab + SalesGrid + CompForm) -------------------------------

function newComp() {
  return {
    id: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    parcel: '', address: '', city: '', saleDate: '', price: 0,
    age: 0, quality: '', condition: '', landArea: 0, buildingArea: 0,
    clearHeight: 0, zoning: '', propertyType: '',
    adjBuildingSize: 0, adjLocation: 0, adjCornerSite: 0, adjAge: 0,
    adjQuality: 0, adjCondition: 0, adjTenantsUse: 0, adjOccupancy: 0,
    adjLandBldgRatio: 0, adjFreeway: 0, adjMarketConditions: 0, adjConditionOfSale: 0,
    selected: true, isArmsLength: true,
  };
}

// CompRecord → ComparableSale (ported from src/data/compDataSource.ts)
function toComparableSale(record) {
  const c = newComp();
  Object.assign(c, {
    parcel: record.apn || '', address: record.address || '', city: record.city || '',
    saleDate: record.saleDate || '', price: record.price || 0,
    age: record.age || 0, quality: record.quality || '', condition: record.condition || '',
    landArea: record.landArea || 0, buildingArea: record.buildingArea || 0,
    clearHeight: record.clearHeight || 0, zoning: record.zoning || '',
    propertyType: record.propertyType || '',
    isArmsLength: record.isArmsLength !== false,
  });
  for (const [key] of ADJ_FIELDS) c[key] = record[key] || 0;
  return c;
}

function compSet(comp, patch) {
  const s = state.data.sales;
  s.comparables = s.comparables.map((c) => (c.id === comp.id ? { ...c, ...patch } : c));
  markDirty();
  refreshComputed();
}

function removeComp(id) {
  const s = state.data.sales;
  const idx = s.comparables.findIndex((c) => c.id === id);
  s.comparables = s.comparables.filter((c) => c.id !== id);
  if (idx === activeCompIdx) activeCompIdx = Math.max(0, activeCompIdx - 1);
  else if (idx < activeCompIdx) activeCompIdx -= 1;
  markDirty();
  renderForm();
  refreshComputed();
}

// repository state (module-level so it survives re-renders)
// Three sources, merged:
//   - permanent: finalized appraisals, server-side (shared across machines)
//   - transfer:  Rule 2 auto-enrolled transfers, server-side (read-only)
//   - local:     CSV-imported comps, machine-local (browser localStorage)
let repoRecords = [];
let repoQuery = '';
let repoCity = '';
let repoType = '';
let repoMinPSF = '';
let repoMaxPSF = '';
let repoMinDate = '';
let repoMaxDate = '';
let repoSortKey = 'similarity';
let repoSortDir = 'desc';

function repoToast(msg, isError = false) {
  const t = el('div', { class: `toast ${isError ? 'error' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function loadRepo() {
  let perm = [], trans = [];
  try { perm = await api.getPermanentComps(); } catch { perm = []; }
  try { trans = await api.getTransferComps(); } catch { trans = []; }
  const local = getLocalComps();
  repoRecords = [
    ...(Array.isArray(perm) ? perm : []).map((r) => ({ ...r, origin: 'permanent' })),
    ...(Array.isArray(trans) ? trans : []).map((r) => ({ ...r, origin: 'transfer' })),
    ...local.map((r) => ({ ...r, origin: 'local' })),
  ];
  renderRepoResults();
}

const repoPSF = (r) => (r.buildingArea > 0 ? (r.price || 0) / r.buildingArea : 0);

function repoSortVal(r, key) {
  switch (key) {
    case 'apn': return String(r.apn || '');
    case 'address': return String(r.address || '');
    case 'city': return String(r.city || '');
    case 'saleDate': return String(r.saleDate || '');
    case 'price': return Number(r.price) || 0;
    case 'psf': return repoPSF(r);
    case 'buildingArea': return Number(r.buildingArea) || 0;
    case 'landArea': return Number(r.landArea) || 0;
    case 'age': return Number(r.age) || 0;
    case 'quality': return String(r.quality || '');
    case 'propertyType': return String(r.propertyType || '');
    case 'similarity': return r.__sim ?? 0;
    default: return 0;
  }
}

function toggleRepoSort(key) {
  if (repoSortKey === key) {
    repoSortDir = repoSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    repoSortKey = key;
    repoSortDir = (key === 'similarity' || key === 'price' || key === 'psf') ? 'desc' : 'asc';
  }
  renderRepoResults();
}

// Parse a free-text date (YYYY-MM-DD or M/D/YYYY, 2- or 4-digit year) into
// YYYY-MM-DD so it compares correctly against the ISO sale dates. Returns ''
// when the value is empty or unparseable.
function parseRepoDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return '';
}

function renderRepoResults() {
  const box = document.getElementById('repo-results');
  if (!box) return;
  const q = repoQuery.trim().toLowerCase();
  const city = repoCity.trim().toLowerCase();
  const type = repoType.trim().toLowerCase();
  const loPSF = repoMinPSF === '' ? null : Number(repoMinPSF);
  const hiPSF = repoMaxPSF === '' ? null : Number(repoMaxPSF);
  const loDate = parseRepoDate(repoMinDate);
  const hiDate = parseRepoDate(repoMaxDate);
  const selectedApns = new Set(state.data.sales.comparables.map((c) => c.parcel).filter(Boolean));

  // Filter
  let rows = repoRecords.filter((r) => {
    if (q && !(String(r.apn || '').toLowerCase().includes(q) || String(r.address || '').toLowerCase().includes(q))) return false;
    if (city && String(r.city || '').toLowerCase() !== city) return false;
    if (type && String(r.propertyType || '').toLowerCase() !== type) return false;
    const psf = repoPSF(r);
    if (loPSF != null && psf < loPSF) return false;
    if (hiPSF != null && psf > hiPSF) return false;
    if (loDate && String(r.saleDate || '') < loDate) return false;
    if (hiDate && String(r.saleDate || '') > hiDate) return false;
    return true;
  });

  // Score similarity against the subject (only when the subject has data).
  const subject = state.data;
  const hasSubject = (subject.improvements?.primary?.grossFloorArea || 0) > 0 || subject.property?.city;
  if (hasSubject) {
    const ranked = new Map(rankCompsBySimilarity(subject, rows).map((x) => [x.record, x.score]));
    rows = rows.map((r) => ({ ...r, __sim: ranked.get(r) ?? 0 }));
  } else {
    rows = rows.map((r) => ({ ...r, __sim: 0 }));
  }

  // Sort
  const dir = repoSortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = repoSortVal(a, repoSortKey);
    const bv = repoSortVal(b, repoSortKey);
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
  rows = rows.slice(0, 100);

  if (rows.length === 0) {
    box.replaceChildren(el('div', { class: 'repo-empty' },
      repoRecords.length === 0
        ? 'No comps in the repository. Finalize an appraisal to archive a permanent comp, or import a CSV.'
        : 'No matches.'));
    return;
  }

  const COLS = [
    ['similarity', 'Sim'],
    ['apn', 'APN'],
    ['address', 'Address'],
    ['city', 'City'],
    ['saleDate', 'Sale Date'],
    ['price', 'Price'],
    ['psf', '$/SF'],
    ['buildingArea', 'Bldg SF'],
    ['landArea', 'Land (Ac)'],
    ['age', 'Age'],
    ['propertyType', 'Type'],
  ];

  const header = el('tr', {},
    ...COLS.map(([key, label]) => {
      const th = el('th', { class: `sortable ${repoSortKey === key ? 'sorted' : ''}`, onclick: () => toggleRepoSort(key) },
        label,
        el('span', { class: 'sort-ind' }, repoSortKey === key ? (repoSortDir === 'asc' ? '▲' : '▼') : '↕'),
      );
      if (key === 'price' || key === 'psf' || key === 'buildingArea' || key === 'landArea' || key === 'similarity') th.style.textAlign = 'right';
      return th;
    }),
    el('th', {}, ''),
  );

  // Fixed subject row — quick-glance reference for the subject's characteristics
  // while selecting comps. Always pinned above the comp rows (not filtered/sorted).
  const p = state.data.property;
  const imp = state.data.improvements.primary;
  const land = state.data.land;
  const hasSubjectData = !!(p.apn || p.address || (imp.grossFloorArea || 0) > 0 || (p.salePrice || 0) > 0);
  const subjectAge = imp.yearBuilt ? String(new Date().getFullYear() - imp.yearBuilt) : '';
  const subjectPSF = (imp.grossFloorArea || 0) > 0 && (p.salePrice || 0) > 0 ? p.salePrice / imp.grossFloorArea : 0;
  const subjectAcres = (land.siteAreaSqFt || 0) / 43560;
  const subjectRow = hasSubjectData ? el('tr', { class: 'subject-row' },
    el('td', { class: 'sim' }, '—'),
    el('td', {}, p.apn || '—'),
    el('td', { class: 'addr', title: titleCase(p.address) || '' }, titleCase(p.address) || '—'),
    el('td', { class: 'city', title: normalizeCity(p.city) || '' }, normalizeCity(p.city) || '—'),
    el('td', {}, '—'),
    el('td', { class: 'num' }, (p.salePrice || 0) > 0 ? fmtCurrency(p.salePrice) : '—'),
    el('td', { class: 'num' }, subjectPSF > 0 ? subjectPSF.toFixed(2) : '—'),
    el('td', { class: 'num' }, (imp.grossFloorArea || 0) > 0 ? fmtNumber(imp.grossFloorArea) : '—'),
    el('td', { class: 'num' }, subjectAcres > 0 ? subjectAcres.toFixed(2) : '—'),
    el('td', { class: 'num' }, subjectAge || '—'),
    el('td', { class: 'type', title: imp.type || '' }, imp.type || '—'),
    el('td', {}, el('span', { class: 'subject-badge' }, 'SUBJECT')),
  ) : null;

  const body = el('tbody', {}, subjectRow, rows.map((r) => {
    const isSelected = selectedApns.has(r.apn);
    const tr = el('tr', { class: isSelected ? 'selected' : '' },
      el('td', { class: 'sim' }, r.__sim > 0 ? `${Math.round(r.__sim)}%` : '—'),
      el('td', {}, r.apn || '—'),
      el('td', { class: 'addr', title: titleCase(r.address) || '' }, titleCase(r.address) || '—'),
      el('td', { class: 'city', title: normalizeCity(r.city) || '' }, normalizeCity(r.city) || '—'),
      el('td', {}, r.saleDate ? fmtDate(r.saleDate) : '—'),
      el('td', { class: 'num' }, r.price > 0 ? fmtCurrency(r.price) : '—'),
      el('td', { class: 'num' }, repoPSF(r) > 0 ? repoPSF(r).toFixed(2) : '—'),
      el('td', { class: 'num' }, r.buildingArea > 0 ? fmtNumber(r.buildingArea) : '—'),
      el('td', { class: 'num' }, r.landArea > 0 ? r.landArea.toFixed(2) : '—'),
      el('td', { class: 'num' }, r.age > 0 ? String(r.age) : '—'),
      el('td', { class: 'type', title: r.propertyType || '' }, r.propertyType || '—'),
      el('td', {}, isSelected
        ? el('button', { class: 'btn tiny danger', onclick: () => removeRepoComp(r.apn) }, 'Remove')
        : el('button', { class: 'btn tiny', onclick: () => addRepoComp(r) }, '+ Add')),
    );
    return tr;
  }));

  box.replaceChildren(el('table', {}, el('thead', {}, header), body));
}

function addRepoComp(r) {
  const comp = toComparableSale(r);
  const subjectType = state.data.improvements.primary.type;
  if (subjectType && r.propertyType && r.propertyType !== subjectType) comp.selected = false;
  state.data.sales.comparables = [...state.data.sales.comparables, comp];
  activeCompIdx = state.data.sales.comparables.length - 1;
  markDirty();
  renderForm();
  refreshComputed();
}

function removeRepoComp(apn) {
  const s = state.data.sales;
  const idx = s.comparables.findIndex((c) => c.parcel === apn);
  s.comparables = s.comparables.filter((c) => c.parcel !== apn);
  if (idx === activeCompIdx) activeCompIdx = Math.max(0, activeCompIdx - 1);
  else if (idx < activeCompIdx) activeCompIdx -= 1;
  markDirty();
  renderForm();
  refreshComputed();
}

// CSV import (machine-local only) + clear local comps.
async function onRepoCsvFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { added, skipped } = importLocalComps(await file.text());
    repoToast(`Imported ${added} local comp${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''} (this machine only).`);
    loadRepo();
  } catch (err) {
    repoToast(`CSV import failed: ${err.message}`, true);
  }
}

function onClearLocalComps() {
  const n = getLocalComps().length;
  if (n === 0) { repoToast('No local comps to clear.'); return; }
  if (!confirm(`Remove ${n} CSV-imported local comp${n === 1 ? '' : 's'} from this machine? Permanent comps are not affected.`)) return;
  clearLocalComps();
  repoToast('Local comps cleared.');
  loadRepo();
}

// comp editor (CompForm.tsx) — fields bind directly to the comp object
function compTextField(label, comp, key) {
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const input = el('input', { class: 'inp' });
  input.value = comp[key] ?? '';
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => compSet(comp, { [key]: input.value }));
  wrap.append(input);
  return wrap;
}
function compNumField(label, comp, key, opts = {}) {
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const box = el('div', { class: 'numwrap' });
  if (opts.prefix) box.append(el('span', { class: 'chip-pre' }, opts.prefix));
  const input = el('input', { type: 'number', step: 'any' });
  input.value = Number.isFinite(comp[key]) ? comp[key] : 0;
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => compSet(comp, { [key]: input.value === '' ? 0 : Number(input.value) }));
  box.append(input);
  if (opts.suffix) box.append(el('span', { class: 'chip-post' }, opts.suffix));
  wrap.append(box);
  return wrap;
}
function compSelectField(label, comp, key, options) {
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const sel = el('select', { class: 'inp' });
  sel.append(el('option', { value: '' }, 'Select…'));
  for (const o of options) {
    const opt = el('option', { value: o }, o);
    if (comp[key] === o) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => compSet(comp, { [key]: sel.value }));
  wrap.append(sel);
  return wrap;
}

function compForm(comp, compIndex) {
  const set = (patch) => compSet(comp, patch);
  return el('div', { class: 'comp-form' },
    el('div', { class: 'comp-form-head' },
      el('h3', {}, `Comparable #${compIndex + 1}`),
      el('button', { class: 'btn tiny danger', onclick: () => removeComp(comp.id) }, 'Remove'),
    ),
    section('Identification', null, null,
      el('div', { class: 'field-grid c2' },
        compTextField('Parcel #', comp, 'parcel'),
        compTextField('City', comp, 'city'),
        el('div', { style: 'grid-column: span 2' }, compTextField('Address', comp, 'address')),
        el('div', { class: 'field' }, el('label', {}, 'Sale Date'),
          (() => {
            const input = el('input', { class: 'inp', type: 'date' });
            input.value = comp.saleDate || '';
            input.addEventListener('input', () => compSet(comp, { saleDate: input.value }));
            return input;
          })()),
        compNumField('Price ($)', comp, 'price', { prefix: '$' }),
      ),
    ),
    section('Characteristics', null, null,
      el('div', { class: 'field-grid c3' },
        compNumField('Age (yrs)', comp, 'age'),
        compSelectField('Quality', comp, 'quality', COMP_QUALITY),
        compSelectField('Condition', comp, 'condition', COMP_CONDITION),
        compNumField('Land (Acres)', comp, 'landArea'),
        compNumField('Bldg Area (SF)', comp, 'buildingArea'),
        compNumField('Clear Height (ft)', comp, 'clearHeight'),
        compTextField('Zoning', comp, 'zoning'),
        compTextField('Property Type', comp, 'propertyType'),
      ),
    ),
    section('Adjustments (%)', 'Positive = comp superior to subject', null,
      el('div', { class: 'field-grid c3' },
        ADJ_FIELDS.map(([key, label]) => compNumField(label, comp, key, { suffix: '%' })),
      ),
    ),
    section('Flags', null, null,
      el('div', { class: 'flag-row' },
        el('label', {},
          el('input', { type: 'checkbox', onchange: (e) => set({ selected: e.target.checked }) }),
          'Selected'),
        el('label', {},
          el('input', { type: 'checkbox', onchange: (e) => set({ isArmsLength: e.target.checked }) }),
          "Arm's Length (Adj.)"),
      ),
    ),
  );
}

// Sales tab (SalesTab.tsx)
function salesTab() {
  const d = state.data;
  const s = d.sales;

  // Section heading + toolbar + repository panel
  const permCount = repoRecords.filter((r) => r.origin === 'permanent').length;
  const transCount = repoRecords.filter((r) => r.origin === 'transfer').length;
  const repo = section('Sales Comparison', null,
    el('span', { class: 'desc', style: 'color:#94a3b8' },
      `${s.comparables.length} of ${repoRecords.length} comps · ${permCount} permanent · ${transCount} transfer`),
    el('div', { class: 'repo-panel', style: 'border:0' },
      el('div', { class: 'repo-filters' },
        el('div', { class: 'repo-filter repo-filter-search' },
          el('label', {}, 'Search'),
          el('input', {
            placeholder: 'APN or address…',
            value: repoQuery,
            oninput: (e) => { repoQuery = e.target.value; renderRepoResults(); },
          }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'City'),
          el('input', { value: repoCity, placeholder: 'Any', oninput: (e) => { repoCity = e.target.value; renderRepoResults(); } }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'Type'),
          el('input', { value: repoType, placeholder: 'Any', oninput: (e) => { repoType = e.target.value; renderRepoResults(); } }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'Min $/SF'),
          el('input', { type: 'number', value: repoMinPSF, placeholder: '0', oninput: (e) => { repoMinPSF = e.target.value; renderRepoResults(); } }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'Max $/SF'),
          el('input', { type: 'number', value: repoMaxPSF, placeholder: '∞', oninput: (e) => { repoMaxPSF = e.target.value; renderRepoResults(); } }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'From'),
          el('input', { type: 'text', placeholder: 'Date', value: repoMinDate, oninput: (e) => { repoMinDate = e.target.value; renderRepoResults(); } }),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'To'),
          el('input', { type: 'text', placeholder: 'Date', value: repoMaxDate, oninput: (e) => { repoMaxDate = e.target.value; renderRepoResults(); } }),
        ),
      ),
      el('div', { class: 'repo-actions' },
        el('button', { class: 'btn sm', onclick: () => {
          const comp = newComp();
          s.comparables = [...s.comparables, comp];
          activeCompIdx = s.comparables.length - 1;
          markDirty();
          renderForm();
          refreshComputed();
        } }, '+ Manual Comp'),
        el('button', { class: 'btn sm', title: 'Import comps from a CSV file (stored on this machine only)', onclick: () => document.getElementById('repo-csv-input')?.click() }, '⬆ Import CSV'),
        el('button', { class: 'btn sm dark-ghost', title: 'Remove CSV-imported comps from this machine', onclick: onClearLocalComps }, 'Clear Local'),
        el('button', { class: 'btn sm dark-ghost', title: 'Reload comps from the repository', onclick: () => { loadRepo(); } }, '⟳ Reload'),
        el('input', { type: 'file', accept: '.csv,text/csv', id: 'repo-csv-input', style: 'display:none', onchange: onRepoCsvFile }),
      ),
      el('div', { class: 'repo-results', id: 'repo-results' }),
    ),
  );

  // The full sales comparison grid now lives in the report preview pane
  // (report.js salesSheet) — the form pane is data-entry only.

  // Comp sub-tabs + active comp form
  let subtabs = null;
  if (s.comparables.length > 0) {
    const activeComp = s.comparables[activeCompIdx] || s.comparables[0];
    subtabs = el('div', {},
      el('div', { class: 'comp-subtabs' },
        s.comparables.map((comp, i) => el('button', {
          class: i === activeCompIdx ? 'active' : '',
          onclick: () => { activeCompIdx = i; renderForm(); },
        }, `Comp ${i + 1}${comp.parcel ? ` · ${comp.parcel}` : ''}`)),
      ),
      el('div', {}, compForm(activeComp, activeCompIdx)),
    );
  } else {
    subtabs = el('p', { style: 'font-size:11px;color:#94a3b8' },
      'No comparables. Search an APN to auto-populate, or add manually.');
  }

  const remarks = section('Sales Remarks', null, null, areaField('', 'sales.remarks', 3));

  return [repo, subtabs, remarks];
}

// --- Income tab (IncomeTab.tsx) ------------------------------------------------

function incomeTab() {
  const d = state.data;
  const i = d.income;
  const RENT_TYPES = ['NNN', 'MG', 'FSG'];
  const seg = el('div', { class: 'rent-seg' },
    RENT_TYPES.map((rt) => el('button', {
      class: i.rentType === rt ? 'active' : '',
      onclick: () => { i.rentType = rt; markDirty(); refreshComputed(); renderForm(); },
    }, rt)),
  );
  const rentField = el('div', { class: 'field' }, el('label', {}, 'Rent Type'), seg);

  return [
    section('Income & Expenses', 'Annual figures', null,
      el('div', { class: 'field-grid c2' },
        rentField,
        numField('PGI ($/SF/mo)', 'income.pgiPerSf', { prefix: '$', step: 0.05 }),
        numField('Vacancy', 'income.vacancyPct', { suffix: '%', step: 0.5 }),
        numField('Collection Loss', 'income.collectionLossPct', { suffix: '%', step: 0.5 }),
        numField('Operating Expense Rate', 'income.operatingExpensePct', { suffix: '%', step: 0.5 }),
        numField('Capitalization Rate', 'income.capRate', { suffix: '%', step: 0.1 }),
      ),
    ),
    section('Income Approach Schedule', 'Live computation', null,
      el('div', { class: 'sched' },
        schedRow('Potential Gross Income', 'income.totalPgi'),
        schedRow('Less: Vacancy', 'income.vacancyLoss', { neg: true, fmt: 'neg' }),
        schedRow('Less: Collection Loss', 'income.collectionLoss', { neg: true, fmt: 'neg' }),
        schedRow('Effective Gross Income', 'income.effectiveGrossIncome'),
        schedRow('Less: Operating Expenses', 'income.operatingExpenses', { neg: true, fmt: 'neg' }),
        schedRow('Net Operating Income', 'income.netOperatingIncome'),
        schedRow('Capitalization Rate', 'income.capRate', { fmt: 'pct1' }),
        schedRow('Value by Income Approach', 'income.valueByIncome', { strong: true }),
      ),
    ),
    section('Income Notes', null, null, areaField('', 'income.incomeNotes', 3)),
    chip('Value by Income Approach', 'income.valueByIncome', { emphasis: true }),
  ];
}

// --- Reconcile tab (ReconciliationTab.tsx) -------------------------------------

function weightRow(label, calcPath, weightPath) {
  const [parent, key] = resolvePath(weightPath);
  const input = el('input', { class: 'w-input', type: 'number', step: 'any' });
  input.value = Number.isFinite(parent[key]) ? parent[key] : 0;
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    parent[key] = input.value === '' ? 0 : Number(input.value);
    markDirty();
    refreshComputed();
  });
  return el('div', { class: 'weight-row' },
    el('div', { class: 'w-left' },
      el('span', { class: 'w-label' }, label),
      el('span', { class: 'w-value', 'data-calc': calcPath, 'data-fmt': 'cur' }, fmtVal(calcValue(calcPath), 'cur')),
    ),
    el('div', { class: 'w-right' }, input, el('span', { class: 'w-pct' }, '%')),
  );
}

function reconcileTab() {
  const d = state.data;
  const r = d.reconciliation;
  const showCost = hasCostData(d);
  const showIncome = hasIncomeData(d);

  // Final value field (editable currency, like the original FinalValueField)
  const finalField = (() => {
    const box = el('div', { class: 'final-field' }, el('span', { class: 'ff-label' }, 'Final Reconciled Value'));
    const input = el('input', { type: 'text' });
    const display = () => {
      const w = calcValue('reconciliation.weightedValue');
      input.value = r.finalValue > 0 ? String(r.finalValue) : String(Math.round(w / 5000) * 5000);
    };
    display();
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => {
      const raw = input.value.replace(/[^0-9.]/g, '');
      r.finalValue = raw === '' ? 0 : Number(raw);
      markDirty();
      refreshComputed();
    });
    box.append(input);
    return box;
  })();

  return [
    section('Approach Weights', 'Relative weight assigned to each approach', null,
      el('div', { class: 'sched' },
        showCost ? weightRow('Cost Approach', 'cost.valueByCost', 'reconciliation.costWeight') : null,
        showIncome ? weightRow('Income Approach', 'income.valueByIncome', 'reconciliation.incomeWeight') : null,
        weightRow('Sales Comparison', 'sales.valueBySales', 'reconciliation.salesWeight'),
      ),
      el('div', { class: 'total-weight' },
        el('span', {}, 'Total weight'),
        el('b', { 'data-calc': 'reconciliation.totalWeight', 'data-fmt': 'pct0' }, fmtVal(calcValue('reconciliation.totalWeight'), 'pct0') + '%'),
      ),
    ),
    section('Reconciliation', "Weighted value and appraiser's final value", null,
      el('div', { class: 'field-grid c2' },
        chip('Weighted Value (auto)', 'reconciliation.weightedValue'),
        finalField,
      ),
      areaField('', 'reconciliation.rationale', 4),
    ),
  ];
}

// --- Cost tab (CostTab.tsx) ------------------------------------------------------

function costTab() {
  return [
    section('Depreciation', 'Deductions from cost new', null,
      el('div', { class: 'field-grid c3' },
        numField('Physical Depreciation', 'cost.physicalDepreciationPct', { suffix: '%', step: 0.5 }),
        numField('Functional Obsolescence', 'cost.functionalDepreciation', { prefix: '$' }),
        numField('Economic / External', 'cost.economicDepreciation', { prefix: '$' }),
      ),
    ),
    section('Cost Approach Schedule', 'Live computation', null,
      el('div', { class: 'sched' },
        schedRow('Land Value', 'landValue'),
        schedRow('Cost New — Improvements', 'cost.costNewImprovements'),
        schedRow('Less: Physical Depreciation', 'cost.physicalDepreciation', { neg: true, fmt: 'neg' }),
        schedRow('Less: Functional Obsolescence', 'functionalDep', { neg: true, fmt: 'neg' }),
        schedRow('Less: Economic / External', 'economicDep', { neg: true, fmt: 'neg' }),
        schedRow('Depreciated Cost of Improvements', 'cost.depreciatedCost'),
        schedRow('Value by Cost Approach', 'cost.valueByCost', { strong: true }),
      ),
    ),
    section('Cost Notes', null, null, areaField('', 'cost.costNotes', 3)),
    chip('Value by Cost Approach', 'cost.valueByCost', { emphasis: true }),
  ];
}

// --- render ----------------------------------------------------------------------

// Top-of-cover setup bar: APN/Address search + Effective/Report dates on the
// left, the case-type selector on the right. The search box itself is injected
// by main.js (it owns the navigation callbacks) into #cover-search-slot after
// each render.
// APN chip state: when the APN is set we show a read-only badge; the user can
// click "Change" to reveal the search box. `coverApnLast` auto-exits editing
// mode whenever the APN value changes (opening another appraisal, importing
// WIP, etc.). main.js calls commitCoverApn() after a search selection.
let coverApnEditing = false;
let coverApnLast = null;
export function commitCoverApn() { coverApnEditing = false; }

function coverSetupBar(caseSeg) {
  const p = state.data.property;
  const apn = String(p.apn || '').trim();
  if (apn !== coverApnLast) { coverApnEditing = false; coverApnLast = apn; }

  const dateField = (label, path) => {
    const [parent, key] = resolvePath(path);
    const input = el('input', { class: 'cs-date', type: 'date' });
    input.value = parent[key] || '';
    input.addEventListener('change', () => {
      parent[key] = input.value;
      markDirty();
      refreshComputed();
    });
    return el('div', { class: 'cs-field' },
      el('div', { class: 'cs-label' }, label),
      input,
    );
  };

  // APN chip: read-only badge when set, search input when empty (or editing).
  let apnField;
  if (apn && !coverApnEditing) {
    const addr = [titleCase(p.address), normalizeCity(p.city)]
      .map((v) => (v ?? '').trim()).filter(Boolean).join(', ');
    apnField = el('div', { class: 'cs-apn-chip' },
      el('span', { class: 'cs-apn-chip-apn' }, apn),
      addr ? el('span', { class: 'cs-apn-chip-addr' }, addr) : null,
      el('button', { class: 'cs-apn-chip-view', type: 'button', title: 'View the county parcel page for this APN',
        onclick: () => window.dispatchEvent(new CustomEvent('appraisal:view-parcel')) }, '📍 View Parcel'),
      el('button', { class: 'cs-apn-chip-change', type: 'button', title: 'Change APN',
        onclick: () => { coverApnEditing = true; renderForm(); } }, 'Change'),
    );
  } else {
    apnField = el('div', { class: 'cs-search-slot', id: 'cover-search-slot' });
  }

  return el('div', { class: 'cover-setup' },
    el('div', { class: 'cs-field cs-search' },
      el('div', { class: 'cs-label' }, 'APN / Address'),
      apnField,
    ),
    el('div', { class: 'cs-row' },
      dateField('Effective Date', 'property.effectiveDate'),
      dateField('Report Date', 'property.reportDate'),
      el('div', { class: 'cs-case' }, caseSeg),
    ),
  );
}

function coverTab() {
  const d = state.data;
  const caseType = d.property.caseType || 'transfer';

  // Case-type selector (moved here from the top bar).
  const caseSeg = el('div', { class: 'case-seg', title: 'Case type' },
    ['transfer', 'appeal', 'stipulation', 'general'].map((value) => el('button', {
      class: `case-btn ${value === caseType ? 'active' : ''}`,
      type: 'button',
      onclick: () => {
        d.property.caseType = value;
        markDirty();
        // Render defensively: a render error must never skip the autosave or
        // leave the case-type change un-persisted (that is what made the
        // selector "unrevertable" — the state flipped but the UI got stuck).
        try {
          renderForm();
          renderReport();
        } catch (e) {
          repoToast(`Switching to ${value} failed: ${e.message}`, true);
        }
        scheduleAutosave();
      },
    }, value[0].toUpperCase() + value.slice(1))),
  );

  const sections = [
    coverSetupBar(caseSeg),
  ];

  // Transfer/appeal details — live on the case-specific cover page below.
  const detailsFields = [
    el('div', { class: 'field-grid c3' },
      textField('Transfer Document #', 'property.transferDocumentNumber', { placeholder: 'e.g. 2026-SR00015' }),
      textField('Ratio Code', 'property.ratioCode', { placeholder: 'e.g. STT' }),
      numField('Sale Price', 'property.salePrice', { prefix: '$' }),
    ),
    el('div', { class: 'field-grid c3' },
      textField('Appraiser ID', 'property.appraiserId', { placeholder: 'e.g. 677' }),
      textField('Section', 'property.section', { placeholder: 'e.g. Riverside Commercial' }),
    ),
    areaField('Appraiser Notes', 'property.appraiserNotes', 3),
  ];

  if (caseType === 'transfer') {
    sections.push(
      subjectImagePanel(),
      section('Transfer Details', 'Transfer-specific fields shown on the report', null,
        el('div', { class: 'field-grid c4' },
          textField('Transfer Document #', 'property.transferDocumentNumber', { placeholder: 'e.g. 2026-SR00015' }),
          textField('Ratio Code', 'property.ratioCode', { placeholder: 'e.g. STT' }),
          selectField('Property Type', 'improvements.primary.type', TYPE_OPTIONS),
        ),
        el('div', { class: 'field-grid c3' },
          numField('Sale Price', 'property.salePrice', { prefix: '$' }),
          numField('Enrolled Value', 'cover.totalPosted', { prefix: '$' }),
          textField('Appraiser ID', 'property.appraiserId', { placeholder: 'e.g. 677' }),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Section', 'property.section', { placeholder: 'e.g. Riverside Commercial' }),
        ),
        areaField('Appraiser Notes', 'property.appraiserNotes', 3),
      ),
    );
  } else if (caseType === 'appeal') {
    sections.push(
      subjectImagePanel(),
      section('Appeal Details', 'Appeal-specific fields shown on the report', null,
        el('div', { class: 'field-grid c3' },
          textField('Tax Year', 'property.taxYear'),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Hearing Date', 'cover.hearingDate', { type: 'date' }),
          textField('Case Number', 'cover.caseNumber', { placeholder: 'e.g. 25-03890' }),
          textField('Applicant', 'cover.applicant'),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Agent', 'cover.agent'),
          numField('Current Roll Value', 'cover.currentRollValue', { prefix: '$' }),
          textField('Presented By', 'cover.presentedBy', { placeholder: 'e.g. Kyle Edmonds - Appraiser' }),
        ),
        el('div', { class: 'field-grid c3' },
          numField("Applicant's Opinion of Value", 'cover.applicantOpinionValue', { prefix: '$' }),
          numField("Assessor's Opinion of Value", 'cover.assessorOpinionValue', { prefix: '$' }),
        ),
        ...detailsFields,
      ),
    );
  } else if (caseType === 'stipulation') {
    sections.push(
      subjectImagePanel(),
      section('Stipulation Details', 'Stipulation-specific fields shown on the report', null,
        el('div', { class: 'field-grid c3' },
          textField('Stipulation Date', 'property.stipulationDate', { type: 'date' }),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Hearing Date', 'cover.hearingDate', { type: 'date' }),
          textField('Application Number', 'cover.applicationNumber', { placeholder: 'e.g. 24-03096' }),
          textField('Applicant Name', 'cover.applicantName'),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Applicant Address', 'cover.applicantAddress'),
          textField('Agent Name', 'cover.agentName'),
          textField('Agent Address', 'cover.agentAddress'),
        ),
        el('div', { class: 'field-grid c4' },
          textField('TRA', 'cover.tra', { placeholder: 'e.g. 004-018' }),
          textField('Assessment No.', 'cover.assessmentNo'),
          textField('ARB No.', 'cover.arbNo'),
          textField('Year ARB Created', 'cover.yearArbCreated'),
        ),
        el('div', { class: 'field-grid c4' },
          textField('Location', 'cover.location'),
          textField('Supplemental No.', 'cover.supplementalNo'),
          textField('Acreage', 'cover.acreage'),
          textField('Use', 'cover.use'),
        ),
        valueCategoriesTable(),
        areaField('Facts Justifying Reduced Assessment', 'cover.factsJustifying', 3),
        ...detailsFields,
      ),
    );
  } else if (caseType === 'general') {
    sections.push(
      subjectImagePanel(),
      section('General Appraisal', 'A valuation as of a specific date — no transfer, appeal, or stipulation', null,
        el('div', { class: 'field-grid c3' },
          textField('Purpose', 'property.purpose', { placeholder: 'e.g. Refinance, estate, insurance, purchase' }),
          textField('Report Type', 'property.reportType', { placeholder: 'e.g. Appraisal, Broker Price Opinion' }),
          textField('Client', 'property.client'),
        ),
        el('div', { class: 'field-grid c3' },
          textField('Prepared By', 'property.appraiser'),
          textField('Appraiser ID', 'property.appraiserId', { placeholder: 'e.g. 677' }),
          textField('Section', 'property.section', { placeholder: 'e.g. Riverside Commercial' }),
        ),
        areaField('Appraiser Notes', 'property.appraiserNotes', 3),
      ),
    );
  }
  return sections;
}

// Stipulation value-category rows (Land / Structures / …) with a live TOTAL.
function valueCategoriesTable() {
  const rows = state.data.cover.valueCategories || [];
  return el('div', { class: 'vc-wrap' },
    el('table', { class: 'vc-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Value Category'),
        el('th', {}, 'Code'),
        el('th', { class: 'num' }, "Assessor's Roll Value"),
        el('th', { class: 'num' }, 'Stipulated Value'),
      )),
      el('tbody', {},
        ...rows.map((row, i) => el('tr', {},
          el('td', {}, row.category),
          el('td', {}, row.code || '—'),
          el('td', { class: 'num' }, denseNum(`cover.valueCategories.${i}.rollValue`)),
          el('td', { class: 'num' }, denseNum(`cover.valueCategories.${i}.stipulatedValue`)),
        )),
        el('tr', { class: 'total' },
          el('td', {}, 'TOTAL'),
          el('td', {}, ''),
          el('td', { class: 'num', 'data-calc': 'cover.rollTotal', 'data-fmt': 'cur' }, fmtVal(calcValue('cover.rollTotal'), 'cur')),
          el('td', { class: 'num', 'data-calc': 'cover.stipTotal', 'data-fmt': 'cur' }, fmtVal(calcValue('cover.stipTotal'), 'cur')),
        ),
      ),
    ),
  );
}

const TAB_BUILDERS = {
  cover: coverTab,
  subject: subjectTab,
  sales: salesTab,
  income: incomeTab,
  reconciliation: reconcileTab,
  cost: costTab,
};

export function renderForm() {
  const root = document.getElementById('form-root');
  if (!root) return;

  const tabs = el('div', { class: 'tab-bar' },
    el('div', { class: 'tabs-box' },
      TABS.map((t) => el('button', {
        class: `tab ${t.id === activeTab ? 'active' : ''}`,
        onclick: () => { activeTab = t.id; renderForm(); scrollToSection(t.id); },
      }, t.label)),
    ),
  );

  const body = el('div', { class: 'tab-content' });
  for (const node of TAB_BUILDERS[activeTab]()) {
    if (node) body.append(node);
  }

  // Swap in only after the content built successfully, so a render error
  // leaves the previous UI in place instead of an empty, unusable pane.
  root.replaceChildren(tabs, body);

  // Let main.js inject the APN/Address search box into the cover setup bar
  // (it owns the navigation callbacks, so it can't live in this module).
  document.dispatchEvent(new CustomEvent('form:rendered'));

  // Load the comp repository when the Sales tab is active.
  if (activeTab === 'sales') loadRepo();
}

export function setTab(t) { activeTab = t; }
export { loadRepo };