// ---------------------------------------------------------------------------
// form.js — left workspace: tabbed appraisal form
// 1:1 port of the original PropertyForm (Subject / Sales / Income / Reconcile / Cost)
// ---------------------------------------------------------------------------
import {
  state, markDirty, computeAppraisal, hasCostData,
  fmtCurrency, fmtCurrencyRounded, fmtNumber, fmtPct, api,
  getLocalComps, clearLocalComps, importLocalComps,
} from './core.js';
import { renderReport } from './report.js';

const TABS = [
  { id: 'subject', label: 'Subject' },
  { id: 'sales', label: 'Sales' },
  { id: 'income', label: 'Income' },
  { id: 'reconciliation', label: 'Reconcile' },
  { id: 'cost', label: 'Cost' },
];
let activeTab = 'subject';
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
  input.value = Number.isFinite(parent[key]) ? parent[key] : 0;
  input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v === '' ? 0 : Number(v); });
  box.append(input);
  if (opts.suffix) box.append(el('span', { class: 'chip-post' }, opts.suffix));
  wrap.append(box);
  return wrap;
}

// 9px uppercase label + h-7 select (fields.tsx SelectField)
function selectField(label, path, options) {
  const [parent, key] = resolvePath(path);
  const wrap = el('div', { class: 'field' }, el('label', {}, label));
  const sel = el('select', { class: 'inp' });
  sel.append(el('option', { value: '' }, 'Select…'));
  for (const o of options) {
    const opt = el('option', { value: o }, o);
    if (parent[key] === o) opt.selected = true;
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
  input.value = Number.isFinite(parent[key]) ? parent[key] : 0;
  input.addEventListener('focus', () => input.select());
  bindInput(input, (v) => { parent[key] = v === '' ? 0 : Number(v); });
  return input;
}
function denseSelect(path, options) {
  const [parent, key] = resolvePath(path);
  const sel = el('select', { class: 'inp' });
  sel.append(el('option', { value: '' }, ''));
  for (const o of options) {
    const opt = el('option', { value: o }, o);
    if (parent[key] === o) opt.selected = true;
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

function subjectTab() {
  const d = state.data;
  const imp = d.improvements.primary;
  const { outbuildings } = d.improvements;

  const dg = (label, node) => [el('span', { class: 'dg-label' }, label), node];

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

  const summary = section('Property Summary', null,
    el('button', { class: 'btn sm', onclick: addOutbuilding }, '+ Add Outbuilding'),
    el('div', { class: 'dense-grid c2' },
      ...dg('Address', denseInput('property.address')),
      ...dg('Parcel Number', denseInput('property.apn')),
      ...dg('City', denseInput('property.city')),
      ...dg('Property Type', denseSelect('improvements.primary.type', TYPE_OPTIONS)),
      ...dg('Building Area (SF)', denseNum('improvements.primary.grossFloorArea')),
      ...dg('Leasable Area (SF)', denseNum('improvements.primary.nla')),
      ...dg('Year Built', denseNum('improvements.primary.yearBuilt')),
      ...dg('Effective Age', el('input', { class: 'inp', readonly: true, 'data-calc': 'effAge', 'data-fmt': 'num' })),
      ...dg('Quality', denseInput('improvements.primary.quality')),
      ...dg('Condition', denseSelect('improvements.primary.condition', CONDITION_OPTIONS)),
      ...dg('Site Area (Acres)', denseNum('land.acres')),
      ...dg('Site Area (SF)', denseNum('land.siteAreaSqFt')),
      ...dg('Zoning', denseInput('land.zoning')),
      ...dg('Frontage (ft)', denseNum('land.frontageFt')),
      ...dg('Land Value ($)', denseNum('land.landValue')),
      ...dg('Land Value Method', denseInput('land.landValueMethod')),
    ),
    areaField('Land Value Notes', 'land.landValueNotes', 2),
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

  // Images: map + 3 photos
  const images = el('div', { class: 'img-row' },
    imgBox('Parcel Map', 'property.mapImageUrl'),
    imgBox('Property Image', 'property.subjectPhotoUrl'),
  );
  const images2 = el('div', { class: 'img-row' },
    imgBox('Property Image 2', 'property.subjectPhotoUrl2'),
    imgBox('Property Image 3', 'property.subjectPhotoUrl3'),
  );

  return [summary, obSection, images, images2];
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
// Two sources, merged:
//   - permanent: finalized appraisals, server-side (shared across machines)
//   - local:     CSV-imported comps, machine-local (browser localStorage)
let repoRecords = [];
let repoQuery = '';

function repoToast(msg, isError = false) {
  const t = el('div', { class: `toast ${isError ? 'error' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function loadRepo() {
  let perm = [];
  try { perm = await api.getPermanentComps(); } catch { perm = []; }
  const local = getLocalComps();
  repoRecords = [
    ...(Array.isArray(perm) ? perm : []).map((r) => ({ ...r, origin: 'permanent' })),
    ...local.map((r) => ({ ...r, origin: 'local' })),
  ];
  renderRepoResults();
}

function renderRepoResults() {
  const box = document.getElementById('repo-results');
  if (!box) return;
  const q = repoQuery.trim().toLowerCase();
  const rows = repoRecords
    .filter((r) => !q || String(r.apn || '').toLowerCase().includes(q) || String(r.address || '').toLowerCase().includes(q))
    .slice(0, 50);
  if (rows.length === 0) {
    box.replaceChildren(el('div', { class: 'repo-empty' },
      repoRecords.length === 0
        ? 'No comps in the repository. Finalize an appraisal to archive a permanent comp, or import a CSV.'
        : 'No matches.'));
    return;
  }
  box.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ['APN', 'Src', 'Address', 'Sale Date', 'Price', 'Bldg SF', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {},
      el('td', {}, r.apn || '—'),
      el('td', {}, el('span', { class: `repo-src ${r.origin === 'permanent' ? 'perm' : 'local'}` },
        r.origin === 'permanent' ? 'Perm' : 'Local')),
      el('td', {}, r.address || '—'),
      el('td', {}, r.saleDate || '—'),
      el('td', { class: 'num' }, r.price > 0 ? fmtCurrency(r.price) : '—'),
      el('td', { class: 'num' }, r.buildingArea > 0 ? fmtNumber(r.buildingArea) : '—'),
      el('td', {}, el('button', {
        class: 'btn tiny',
        onclick: () => {
          const comp = toComparableSale(r);
          // Only auto-select if the comp's property type matches the subject's
          const subjectType = state.data.improvements.primary.type;
          if (subjectType && r.propertyType && r.propertyType !== subjectType) comp.selected = false;
          state.data.sales.comparables = [...state.data.sales.comparables, comp];
          activeCompIdx = state.data.sales.comparables.length - 1;
          markDirty();
          renderForm();
          refreshComputed();
        },
      }, '+ Add')),
    ))),
  ));
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

// sales comparison grid (SalesGrid.tsx)
function salesGrid() {
  const d = state.data;
  const s = d.sales;
  const p = d.property;
  const imp = d.improvements.primary;
  const land = d.land;
  const comps = s.comparables;

  const subjectSF = imp.grossFloorArea || 0;
  const subjectAcres = (land.siteAreaSqFt || 0) / 43560;
  const subjectRatio = subjectSF > 0 ? (land.siteAreaSqFt || 0) / subjectSF : 0;
  const compValues = comps.map((c) => {
    const unadjSF = c.buildingArea > 0 ? c.price / c.buildingArea : 0;
    const net = ADJ_FIELDS.reduce((sum, [f]) => sum + (Number(c[f]) || 0), 0);
    const adjSF = unadjSF * (1 + net / 100);
    const ratio = c.buildingArea > 0 ? (c.landArea || 0) * 43560 / c.buildingArea : 0;
    return { unadjSF, net, adjSF, ratio };
  });
  const pct = (v) => (v !== 0 ? `${v > 0 ? '' : '-'}${Math.abs(v)}%` : '');
  const compAge = imp.yearBuilt ? String(new Date().getFullYear() - imp.yearBuilt) : '—';

  let rowNum = 0;
  const row = (label, subject, cells, opts = {}) => {
    if (opts.section) {
      return el('tr', { class: 'section-row' }, el('td', { colspan: 2 + comps.length }, label));
    }
    const cls = [rowNum++ % 2 === 1 ? 'stripe' : '', opts.bold ? 'bold-row' : ''].filter(Boolean).join(' ');
    return el('tr', { class: cls },
      el('td', { class: 'row-label' }, label),
      el('td', { class: 'subject' }, subject ?? '—'),
      cells.map((c) => el('td', {}, c ?? '—')),
    );
  };

  const table = el('table', { class: 'sales-grid' },
    el('thead', {}, el('tr', {},
      el('th', { style: 'width:130px' }, 'Description'),
      el('th', {}, 'Subject'),
      comps.map((c, i) => el('th', {},
        el('span', { class: 'comp-link', onclick: () => { activeCompIdx = i; renderForm(); } }, `Comp ${i + 1}`),
        el('span', { class: 'comp-del', title: 'Delete comp', onclick: () => removeComp(c.id) }, '✕'),
      )),
    )),
    el('tbody', {},
      row('Parcel #', p.apn, comps.map((c) => c.parcel || '—')),
      row('Property Type', imp.type, comps.map((c) => c.propertyType || '—')),
      row('Location', p.address, comps.map((c) => c.address || '—')),
      row('City', p.city, comps.map((c) => c.city || '—')),
      row('Age', compAge, comps.map((c) => (c.age > 0 ? String(c.age) : '—'))),
      row('Quality', imp.quality, comps.map((c) => c.quality || '—')),
      row('Condition', imp.condition, comps.map((c) => c.condition || '—')),
      row('Land Area (Acres)', subjectAcres > 0 ? subjectAcres.toFixed(2) : '—', comps.map((c) => (c.landArea > 0 ? c.landArea.toFixed(2) : '—'))),
      row('Building Area (SF)', subjectSF > 0 ? fmtNumber(subjectSF) : '—', comps.map((c) => (c.buildingArea > 0 ? fmtNumber(c.buildingArea) : '—'))),
      row('Land to Bldg. Ratio', subjectRatio > 0 ? subjectRatio.toFixed(2) : '—', compValues.map((v) => (v.ratio > 0 ? v.ratio.toFixed(2) : '—'))),
      row('Transfer Date', '', comps.map((c) => c.saleDate || '—')),
      row('Cash Eq. Sale Price', '', comps.map((c) => (c.price > 0 ? fmtCurrency(c.price) : '—'))),
      row('UNADJUSTED VALUE INDICATORS', null, [], { section: true }),
      row('Unadjusted Price / SF', '', compValues.map((v) => (v.unadjSF > 0 ? v.unadjSF.toFixed(2) : '—'))),
      row('Market Conditions', '', comps.map((c) => pct(c.adjMarketConditions))),
      row('Condition of Sale', '', comps.map((c) => pct(c.adjConditionOfSale))),
      row('Adjusted Price / SF', '', compValues.map((v) => (v.unadjSF > 0 ? v.unadjSF.toFixed(2) : '—'))),
      row('COMPARABILITY ADJUSTMENTS (%)', null, [], { section: true }),
      ...ADJ_FIELDS.slice(0, 10).map(([f, label]) => row(label, '', comps.map((c) => pct(c[f])))),
      row('NET ADJUSTMENTS', '', compValues.map((v) => (v.net !== 0 ? pct(v.net) : '0%')), { bold: true }),
      row('FINAL', null, [], { section: true }),
      row('Adj. Price / SF', '', compValues.map((v) => (v.adjSF > 0 ? v.adjSF.toFixed(2) : '—')), { bold: true }),
    ),
  );

  const comp = computeAppraisal(d);
  return el('div', {},
    el('div', { class: 'sales-meta' },
      el('span', {}, `Eff. Date: ${p.effectiveDate || '—'}`),
      el('span', {}, `Appraiser ID: ${p.appraiserLicense || '—'}`),
    ),
    el('div', { class: 'sales-grid-wrap' }, table),
    el('div', { class: 'sales-correlated' },
      el('span', { class: 'sc-left' },
        `SUBJECT CORRELATED VALUE: $${comp.sales.correlatedSF.toFixed(2)}/SF × ${fmtNumber(comp.sales.subjectSF)} SF`),
      el('span', { class: 'sc-right', 'data-calc': 'sales.valueBySales', 'data-fmt': 'cur' }, fmtCurrency(comp.sales.valueBySales)),
    ),
  );
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
  const repo = section('Sales Comparison', null,
    el('span', { class: 'desc', style: 'color:#94a3b8' },
      `${s.comparables.length} of ${repoRecords.length} comps · ${permCount} permanent`),
    el('button', { class: 'btn sm dark-ghost', onclick: () => { loadRepo(); } }, '⟳ Reload'),
    el('div', { class: 'repo-panel', style: 'border:0' },
      el('div', { class: 'repo-search' },
        el('input', {
          placeholder: 'Search APN or address…',
          value: repoQuery,
          oninput: (e) => { repoQuery = e.target.value; renderRepoResults(); },
        }),
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
        el('input', { type: 'file', accept: '.csv,text/csv', id: 'repo-csv-input', style: 'display:none', onchange: onRepoCsvFile }),
      ),
      el('div', { class: 'repo-results', id: 'repo-results' }),
    ),
  );

  const grid = salesGrid();

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

  return [repo, grid, subtabs];
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
        weightRow('Income Approach', 'income.valueByIncome', 'reconciliation.incomeWeight'),
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

const TAB_BUILDERS = {
  subject: subjectTab,
  sales: salesTab,
  income: incomeTab,
  reconciliation: reconcileTab,
  cost: costTab,
};

export function renderForm() {
  const root = document.getElementById('form-root');
  if (!root) return;
  root.replaceChildren();

  const tabs = el('div', { class: 'tab-bar' },
    el('div', { class: 'tabs-box' },
      TABS.map((t) => el('button', {
        class: `tab ${t.id === activeTab ? 'active' : ''}`,
        onclick: () => { activeTab = t.id; renderForm(); },
      }, t.label)),
    ),
  );
  root.append(tabs);

  const body = el('div', { class: 'tab-content' });
  for (const node of TAB_BUILDERS[activeTab]()) {
    if (node) body.append(node);
  }
  root.append(body);

  // Load the comp repository when the Sales tab is active.
  if (activeTab === 'sales') loadRepo();
}

export function setTab(t) { activeTab = t; }
export { loadRepo };