// ---------------------------------------------------------------------------
// form.js — left workspace: tabbed appraisal form
// 1:1 port of the original PropertyForm (Subject / Sales / Income / Reconcile / Cost)
// ---------------------------------------------------------------------------
import {
  state, markDirty, computeAppraisal, hasCostData, hasIncomeData,
  fmtCurrency, fmtCurrencyRounded, fmtNumber, fmtPct, fmtAcresNum, fmtDate, fmtDateMDY, normalizeCity, titleCase, api,
  getLocalComps, clearLocalComps, importLocalComps, scheduleAutosave,
  resolveSubjectImageUrl, resolveCoverPhotoUrl, resolvePhotoUrl, resolveCompPhotoUrl, photoImg, rankCompsBySimilarity,
  isPortfolio, activeParcelIndex, reportMode, selectParcel, setViewMode, addParcel, removeParcel, resetActiveParcel, computePortfolioAggregate,
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
  'Industrial / Warehouse', 'Single-Family', 'Accessory', 'Vacant Land',
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

function toast(msg, isError = false) {
  const t = el('div', { class: `toast ${isError ? 'error' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

// --- state path binding ------------------------------------------------------

// Fields normally bind to the active parcel (state.data). When rendering a
// per-parcel section (e.g. the portfolio Subject tab), `bindRoot` is
// temporarily set to that parcel so the same field helpers target it.
let bindRoot = null;
function resolvePath(path) {
  const parts = path.split('.');
  const key = parts.pop();
  let parent = bindRoot || state.data;
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
    const v = fmtVal(calcValue(n.dataset.calc), n.dataset.fmt || 'cur');
    // <input> fields (e.g. Effective Age) display .value, not textContent.
    if (n.tagName === 'INPUT') n.value = v;
    else n.textContent = v;
  });
  document.querySelectorAll('[data-data]').forEach((n) => {
    n.textContent = fmtVal(dataValue(n.dataset.data), n.dataset.fmt || 'raw');
  });
  // Per-parcel effective age (portfolio Subject tab): each input carries the
  // parcel index so it tracks that parcel's year built / effective date.
  document.querySelectorAll('[data-parcel-effage]').forEach((n) => {
    const parcel = state.portfolio.parcels[Number(n.dataset.parcelEffage)];
    if (parcel) n.value = fmtNumber(parcelEffAge(parcel));
  });
  updateCoverComplete();
  updateTabStatus();
  renderReport();
  window.dispatchEvent(new CustomEvent('appraisal:changed'));
}

// --- field builders ----------------------------------------------------------

function bindInput(input, apply) {
  input.addEventListener('input', () => { apply(input.value); markDirty(); refreshComputed(); });
}

// --- thousands-separator (comma) formatting for numeric inputs ---------------
// <input type="number"> can't display commas, so numeric fields use a text
// input (inputmode=decimal) that live-formats the integer part with commas
// while still storing a plain number in state.

// Format a numeric string (digits, optional leading '-', at most one '.') with
// thousands separators.
function formatCommas(str) {
  const neg = str.startsWith('-');
  let s = neg ? str.slice(1) : str;
  const dot = s.indexOf('.');
  let intPart = dot === -1 ? s : s.slice(0, dot);
  const decPart = dot === -1 ? null : s.slice(dot + 1);
  intPart = intPart.replace(/^0+(?=\d)/, ''); // strip leading zeros, keep one
  const grouped = intPart === '' ? '' : intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let out = (neg ? '-' : '') + grouped;
  if (decPart !== null) out += '.' + decPart;
  return out;
}

// Parse a (possibly comma-formatted) numeric string back to a number.
function parseComma(str) {
  const c = String(str).replace(/[^0-9.-]/g, '');
  if (c === '' || c === '-' || c === '.') return 0;
  const n = Number(c);
  return Number.isFinite(n) ? n : 0;
}

// Live comma formatting for a numeric text input. On every change it strips the
// value to a valid number, re-inserts thousands separators, restores the caret,
// then calls `commit(parsedNumber)`. `group=false` keeps the value plain (no
// commas) — used for fields like Year Built where a comma would be wrong.
function bindCommaInput(input, commit, group = true) {
  input.addEventListener('input', () => {
    const raw = input.value;
    const caret = input.selectionStart ?? raw.length;
    const digitsBefore = raw.slice(0, caret).replace(/,/g, '').length;

    // Reduce to a valid numeric string: digits, one '.', optional leading '-'.
    let s = raw.replace(/,/g, '').replace(/[^0-9.-]/g, '');
    const dot = s.indexOf('.');
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
    if (s.indexOf('-') !== 0) s = s.replace(/-/g, '');

    const formatted = group ? formatCommas(s) : s;
    input.value = formatted;

    // Restore the caret after the same count of real (non-comma) characters.
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBefore) {
      if (formatted[pos] !== ',') seen++;
      pos++;
    }
    try { input.setSelectionRange(pos, pos); } catch { /* not focusable */ }

    commit(parseComma(s));
  });
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
  const group = opts.group !== false;
  const input = el('input', { type: 'text', inputmode: 'decimal' });
  // Show blank (not 0) for empty/default numeric fields; a real 0 the user
  // types still reads back as 0 while editing.
  input.value = (Number.isFinite(parent[key]) && parent[key] !== 0)
    ? (group ? formatCommas(String(parent[key])) : String(parent[key]))
    : '';
  input.addEventListener('focus', () => input.select());
  bindCommaInput(input, (n) => { parent[key] = n; markDirty(); refreshComputed(); }, group);
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
function denseNum(path, opts = {}) {
  const [parent, key] = resolvePath(path);
  const group = opts.group !== false;
  const input = el('input', { class: 'inp', type: 'text', inputmode: 'decimal' });
  input.value = (Number.isFinite(parent[key]) && parent[key] !== 0)
    ? (group ? formatCommas(String(parent[key])) : String(parent[key]))
    : '';
  input.addEventListener('focus', () => input.select());
  bindCommaInput(input, (n) => { parent[key] = n; markDirty(); refreshComputed(); }, group);
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

// Google Static Maps API key (for the Subject Photos "Map" button).
const GOOGLE_MAPS_KEY = 'AIzaSyDVg3H1uUcUbkitQl7_3AQwRpzAft5k358';

// Read an image file into a base64 data URL and hand back a "pending" photo
// reference. Pending photos live in the appraisal data (NOT the parcel page)
// while the report is being worked on — they're uploaded to the parcel page
// only when the report is finalized (see flushPendingPhotos in main.js).
// `source` is 'upload' by default; Google map images use 'map' so they stay
// with the report on the user's PC and are never uploaded to the parcel page
// (flushPendingPhotos only uploads source 'upload' photos).
function readPendingPhoto(f, onDone, source = 'upload') {
  const reader = new FileReader();
  reader.onload = () => {
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    onDone({ source, file: `photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`, dataUrl: reader.result });
  };
  reader.onerror = () => toast('Upload failed', true);
  reader.readAsDataURL(f);
}

// Add a pasted image to the current parcel's Subject Photos list.
// Shared by the Subject tab's Paste button and the global Ctrl+V handler.
function pasteImageToSubjectPhotos(f) {
  const p = state.data.property;
  const apn = String(p.apn || '').trim();
  if (!apn) { toast('Set an APN first', true); return; }
  if (!Array.isArray(p.subjectPhotos)) p.subjectPhotos = [];
  readPendingPhoto(f, (photo) => {
    p.subjectPhotos.push(photo);
    markDirty();
    renderForm();
    refreshComputed();
  });
}

// Single-photo panel for the cover page. Manages property.subjectImage — the
// one image shown on the cover. Auto-populates with the GIS satellite map; the
// user can replace it with an uploaded/pasted photo or remove it (back to GIS).
function coverPhotoPanel() {
  const d = state.data;
  const p = d.property;
  const apn = String(p.apn || '').trim();

  const wrap = el('div', { class: 'img-panel' });
  const preview = el('div', { class: 'cover-photo-preview' });
  const modeBtns = el('div', { class: 'img-panel-modes' });

  // The cover page shows the explicit subjectImage, falling back to the GIS
  // parcel map when none is set — so the GIS map is the default ("auto-populated").
  // An explicit { source: "none" } means the user removed the photo (no GIS fallback).
  const currentUrl = () => resolveCoverPhotoUrl(d);
  const isCustom = () => !!(p.subjectImage && p.subjectImage.source === 'upload');
  const isNone = () => !!(p.subjectImage && p.subjectImage.source === 'none');

  const reRender = () => {
    preview.replaceChildren();
    const url = currentUrl();
    const custom = isCustom();
    const none = isNone();
    preview.append(
      url
        ? photoImg(url, 'Cover photo')
        : el('div', { class: 'cover-photo-ph' }, 'No image'),
    );
    preview.append(el('div', { class: 'cover-photo-label' },
      none ? 'No image'
        : custom ? 'Custom photo'
        : (apn ? 'GIS Map' : 'Set an APN to load the GIS map')));
    // Toggle button: "Remove" when a photo is showing, "GIS Map" to restore it.
    removeBtn.textContent = none ? 'GIS Map' : 'Remove';
    removeBtn.classList.toggle('danger', !none);
    removeBtn.style.display = (url || none) ? '' : 'none';
  };

  const setPhoto = (photo) => {
    p.subjectImage = photo;
    markDirty(); refreshComputed(); reRender();
  };

  const uploadFile = (f) => {
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (!apn) { toast('Set an APN first', true); return; }
    readPendingPhoto(f, (photo) => setPhoto(photo));
  };

  // Google Images button — opens a Google image search for the address + city.
  const searchBtn = el('button', { class: 'btn tiny img-mode-btn', title: 'Search Google Images for this address' }, '🔍 Google Images');
  searchBtn.onclick = () => {
    const q = [titleCase(p.address), normalizeCity(p.city)].map((v) => (v ?? '').trim()).filter(Boolean).join(' ');
    if (!q) { toast('Enter an address first', true); return; }
    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  };

  // Upload / Paste button + hidden file input.
  const fileInput = el('input', { type: 'file', accept: 'image/*' });
  fileInput.style.display = 'none';
  const uploadBtn = el('button', { class: 'btn tiny img-mode-btn' }, '📷 Upload / Paste');
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
    fileInput.value = '';
  };

  // Remove / restore button — toggles between "no photo" and the GIS map.
  // Shows "Remove" when a photo is present; "GIS Map" when none is set.
  const removeBtn = el('button', { class: 'btn tiny danger img-mode-btn' }, 'Remove');
  removeBtn.onclick = () => setPhoto(isNone() ? { source: 'gis' } : { source: 'none' });

  // Drag & drop onto the panel.
  wrap.ondragover = (e) => { e.preventDefault(); wrap.classList.add('drag'); };
  wrap.ondragleave = () => wrap.classList.remove('drag');
  wrap.ondrop = (e) => {
    e.preventDefault(); wrap.classList.remove('drag');
    for (const f of e.dataTransfer.files) uploadFile(f);
  };

  // Paste handler (module-level, bound once). Reads the current APN at paste
  // time so it stays correct across re-renders. Routes to the Subject Photos
  // panel when the Subject tab is active, otherwise to the Cover photo.
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
          const curApn = String(state.data.property.apn || '').trim();
          if (f && curApn) {
            if (activeTab === 'subject') {
              pasteImageToSubjectPhotos(f);
            } else {
              readPendingPhoto(f, (photo) => {
                state.data.property.subjectImage = photo;
                markDirty();
                renderForm();
                refreshComputed();
              });
            }
            e.preventDefault();
            break;
          }
        }
      }
    });
  }

  modeBtns.append(searchBtn, uploadBtn, removeBtn);
  wrap.append(
    el('div', { class: 'img-panel-head' }, el('span', { class: 'img-panel-title' }, 'Cover Photo'), modeBtns),
    preview,
    fileInput,
  );
  reRender();
  return wrap;
}

// Multi-photo panel for the subject (Subject tab). Manages
// property.subjectPhotos — the uploaded photos shown in the report's
// "Subject Photos" box. Uploads only (no GIS satellite — that belongs to the
// cover). Supports multi-select upload and drag & drop; each photo can be
// removed individually.
function subjectPhotosPanel() {
  const d = state.data;
  const p = d.property;
  const apn = String(p.apn || '').trim();
  if (!Array.isArray(p.subjectPhotos)) p.subjectPhotos = [];

  const wrap = el('div', { class: 'img-panel' });
  const grid = el('div', { class: 'img-panel-grid' });
  const modeBtns = el('div', { class: 'img-panel-modes' });

  const reRender = () => {
    grid.replaceChildren();
    p.subjectPhotos.forEach((ph, i) => {
      const url = resolvePhotoUrl(d, ph);
      const cell = el('div', { class: 'img-thumb' });
      cell.append(url
        ? photoImg(url, `Subject photo ${i + 1}`)
        : el('div', { class: 'img-thumb-ph' }, 'Photo'));
      const rm = el('button', { class: 'btn tiny danger img-thumb-rm' }, 'Remove');
      rm.onclick = () => { p.subjectPhotos.splice(i, 1); markDirty(); refreshComputed(); reRender(); };
      cell.append(rm);
      grid.append(cell);
    });
    const add = el('div', { class: 'img-thumb img-thumb-add' },
      el('div', { class: 'img-thumb-add-inner' },
        el('div', { class: 'img-thumb-add-plus' }, '+'),
        el('div', { class: 'img-thumb-add-label' }, 'Add photo'),
      ),
    );
    add.onclick = () => fileInput.click();
    grid.append(add);
  };

  const addPhoto = (photo) => {
    p.subjectPhotos.push(photo);
    markDirty(); refreshComputed(); reRender();
  };

  const uploadFile = (f) => {
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (!apn) { toast('Set an APN first', true); return; }
    readPendingPhoto(f, (photo) => addPhoto(photo));
  };

  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true });
  fileInput.style.display = 'none';
  const uploadBtn = el('button', { class: 'btn tiny img-mode-btn' }, '📷 Upload');
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    for (const f of fileInput.files) uploadFile(f);
    fileInput.value = '';
  };

  // Paste an image from the clipboard (e.g. a screenshot) and upload it.
  // On 127.0.0.1 the browser grants clipboard access silently, so this is
  // a true one-click paste. Fallback with no permission: click the button,
  // then press Ctrl+V (the button is a paste target).
  const pasteBtn = el('button', { class: 'btn tiny img-mode-btn', title: 'Paste an image from the clipboard' }, '📋 Clipboard');
  const doClipboardPaste = async () => {
    const items = await navigator.clipboard.read();
    let found = false;
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      uploadFile(new File([blob], `pasted-${Date.now()}.${ext}`, { type }));
      found = true;
    }
    if (!found) toast('No image found on the clipboard', true);
  };
  pasteBtn.onclick = async () => {
    // Clipboard APIs only exist in secure contexts (https or 127.0.0.1/localhost).
    if (!window.isSecureContext || !navigator.clipboard) {
      toast('Clipboard unavailable — open the app via http://127.0.0.1:5000 (not a network IP), or use Upload / drag-drop', true);
      return;
    }
    try {
      // One-time permission grant (only prompts if not yet decided).
      if (navigator.permissions?.query && navigator.clipboard.requestPermission) {
        try {
          const st = await navigator.permissions.query({ name: 'clipboard-read' });
          if (st.state === 'prompt') {
            const granted = await navigator.clipboard.requestPermission();
            if (granted !== 'granted') {
              toast('Clipboard blocked — click the button and press Ctrl+V instead', true);
              pasteBtn.focus();
              return;
            }
          } else if (st.state === 'denied') {
            toast('Clipboard blocked in browser settings — click the button and press Ctrl+V instead', true);
            pasteBtn.focus();
            return;
          }
        } catch { /* query unsupported — fall through and try the read */ }
      }
      await doClipboardPaste();
    } catch (e) {
      console.warn('clipboard paste failed', e);
      toast(`Paste failed (${e && e.name ? e.name : 'error'}) — click the button and press Ctrl+V instead`, true);
      pasteBtn.focus();
    }
  };
  // No-permission fallback: click the button, then Ctrl+V.
  pasteBtn.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { uploadFile(f); e.preventDefault(); break; }
      }
    }
  });

  // Add a Google Static Map image of the property's address + city as a
  // subject photo. Tagged source 'map' so it stays with the report on the
  // user's PC (form, report preview, PDF) and is never uploaded to the
  // server's parcel page.
  const mapBtn = el('button', { class: 'btn tiny img-mode-btn', title: 'Add a Google map image of the address + city' }, '🗺 Map');
  mapBtn.onclick = async () => {
    const addr = String(p.address || '').trim();
    const city = String(p.city || '').trim();
    if (!addr && !city) { toast('Set an address first', true); return; }
    const center = [addr, city].filter(Boolean).join(', ');
    // A red pin at the geocoded address (same location as the center). The
    // '|' option separators are URL-encoded by encodeURIComponent.
    const marker = `size:mid|color:0xFF0000|${center}`;
    const url = 'https://maps.googleapis.com/maps/api/staticmap'
      + `?center=${encodeURIComponent(center)}`
      + '&zoom=14&size=560x400&scale=2&maptype=hybrid'
      + `&markers=${encodeURIComponent(marker)}`
      + `&key=${GOOGLE_MAPS_KEY}`;
    mapBtn.disabled = true;
    try {
      // no-referrer: the API key has HTTP referrer restrictions that don't
      // include 127.0.0.1, so a Referer header makes Google return 403.
      // (Excel's URLDownloadToFile works because it sends no referrer.)
      const r = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error(`Google Maps error ${r.status}`);
      const blob = await r.blob();
      if (!blob.type.startsWith('image/')) throw new Error('response was not an image');
      readPendingPhoto(new File([blob], `map-${Date.now()}.png`, { type: blob.type }), (photo) => addPhoto(photo), 'map');
    } catch (e) {
      toast(`Map image failed: ${e.message}`, true);
    } finally {
      mapBtn.disabled = false;
    }
  };

  wrap.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('drag'); };
  wrap.ondragenter = (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('drag'); };
  wrap.ondragleave = (e) => { e.preventDefault(); wrap.classList.remove('drag'); };
  wrap.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation(); wrap.classList.remove('drag');
    // Files dragged from the OS file manager arrive in dataTransfer.files;
    // images dragged from a browser tab / another app arrive only in
    // dataTransfer.items (as File objects via getAsFile).
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      for (const f of files) uploadFile(f);
      return;
    }
    for (const it of e.dataTransfer.items || []) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f && f.type.startsWith('image/')) uploadFile(f);
    }
  };

  modeBtns.append(uploadBtn, pasteBtn, mapBtn);
  wrap.append(
    el('div', { class: 'img-panel-head' }, el('span', { class: 'img-panel-title' }, 'Subject Photos'), modeBtns),
    grid,
    fileInput,
  );
  reRender();
  return wrap;
}

// --- shared dense-grid building blocks (Property Summary) --------------------
// Hoisted to module scope so both the single-parcel Subject tab and the
// per-parcel portfolio Subject sections can reuse them.
function dgCell(label, node) {
  return el('div', { class: 'dg-cell' }, el('span', { class: 'dg-cell-label' }, label), node);
}
function psGroup(title, fields, extra) {
  return el('div', { class: 'ps-group' },
    el('div', { class: 'ps-group-title' }, title),
    el('div', { class: 'ps-group-grid' }, ...fields),
    extra || null,
  );
}

// Effective age for a given parcel (year built vs. effective date).
function parcelEffAge(parcel) {
  const yb = parcel?.improvements?.primary?.yearBuilt;
  const ed = parcel?.property?.effectiveDate;
  return yb && ed ? parseInt(String(ed).slice(0, 4), 10) - yb : 0;
}

// Property Summary for one parcel (Property / Building / Land groups). Used by
// both the single-parcel Subject tab and each per-APN section in the portfolio.
function propertySummaryGroups() {
  return [
    psGroup('Property', [
      dgCell('Parcel Number', denseInput('property.apn')),
      dgCell('Address', denseInput('property.address')),
      dgCell('City', denseInput('property.city')),
      dgCell('Property Type', denseSelect('improvements.primary.type', TYPE_OPTIONS)),
    ]),
    psGroup('Building', [
      dgCell('Building Area (SF)', denseNum('improvements.primary.grossFloorArea')),
      dgCell('Leasable Area (SF)', denseNum('improvements.primary.nla')),
      dgCell('Year Built', denseNum('improvements.primary.yearBuilt', { group: false })),
      dgCell('Effective Age', el('input', { class: 'inp', readonly: true, 'data-calc': 'effAge', 'data-fmt': 'num', value: fmtVal(calcValue('effAge'), 'num') })),
      dgCell('Quality', denseInput('improvements.primary.quality')),
      dgCell('Condition', denseSelect('improvements.primary.condition', CONDITION_OPTIONS)),
    ]),
    psGroup('Land', [
      dgCell('Site Area (Acres)', denseNum('land.acres')),
      dgCell('Site Area (SF)', denseNum('land.siteAreaSqFt')),
      dgCell('Zoning', denseInput('land.zoning')),
    ]),
  ];
}

// Portfolio Subject tab: one section per APN, each editing that parcel's
// characteristics. Fields bind to the parcel via `bindRoot`.
function portfolioSubjectTab() {
  const parcels = state.portfolio.parcels;
  return parcels.map((parcel, i) => {
    const apn = parcel.property?.apn || '—';
    const addr = parcel.property?.address || '—';
    const title = `${i === 0 ? 'Main Subject' : 'Associated'} · APN ${apn}`;
    bindRoot = parcel;
    const groups = propertySummaryGroups();
    bindRoot = null;
    // The shared Effective Age input uses the global data-calc (active parcel);
    // swap it for a per-parcel one so it tracks this parcel.
    const effCell = groups[1].querySelector('[data-calc="effAge"]');
    if (effCell) {
      effCell.removeAttribute('data-calc');
      effCell.setAttribute('data-parcel-effage', String(i));
      effCell.value = fmtNumber(parcelEffAge(parcel));
    }
    return section(title, addr, null, ...groups);
  });
}

function subjectTab() {
  const d = state.data;
  const imp = d.improvements.primary;
  const { outbuildings } = d.improvements;

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

  const summary = section('Property Summary', null, null, ...propertySummaryGroups());

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

  // Subject Photos — uploaded photos shown in the report's Subject Photos box.
  const photosSection = section('Subject Photos', null, null, subjectPhotosPanel());

  return [summary, photosSection, obSection];
}

// --- Sales tab (SalesTab + SalesGrid + CompForm) -------------------------------

function newComp() {
  return {
    id: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    parcel: '', address: '', city: '', saleDate: '', price: 0,
    age: 0, yearBuilt: 0, quality: '', condition: '', landArea: 0, buildingArea: 0,
    clearHeight: 0, zoning: '', propertyType: '',
    adjBuildingSize: 0, adjLocation: 0, adjCornerSite: 0, adjAge: 0,
    adjQuality: 0, adjCondition: 0, adjTenantsUse: 0, adjOccupancy: 0,
    adjLandBldgRatio: 0, adjFreeway: 0, adjMarketConditions: 0, adjConditionOfSale: 0,
    photos: [],
  };
}

// CompRecord → ComparableSale (ported from src/data/compDataSource.ts)
function toComparableSale(record) {
  const c = newComp();
  Object.assign(c, {
    parcel: record.apn || '', address: record.address || '', city: record.city || '',
    saleDate: record.saleDate || '', price: record.price || 0,
    age: record.age || 0, yearBuilt: record.yearBuilt || 0,
    quality: record.quality || '', condition: record.condition || '',
    landArea: record.landArea || 0, buildingArea: record.buildingArea || 0,
    clearHeight: record.clearHeight || 0, zoning: record.zoning || '',
    propertyType: record.propertyType || '',
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
// Year built: prefer the stored value (transfer comps carry it); otherwise
// derive it from the comp's age. 0 = unknown.
const repoYearBuilt = (r) => (r.yearBuilt > 0 ? r.yearBuilt : (r.age > 0 ? new Date().getFullYear() - r.age : 0));

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
    case 'yearBuilt': return Number(r.yearBuilt) || 0;
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
  // Type filter defaults to the subject's property type so comp results match
  // the subject; an explicit dropdown selection overrides it.
  const subjectType = (state.data.improvements?.primary?.type || '').trim();
  const type = (repoType || subjectType).trim().toLowerCase();
  const loPSF = repoMinPSF === '' ? null : Number(repoMinPSF);
  const hiPSF = repoMaxPSF === '' ? null : Number(repoMaxPSF);
  const loDate = parseRepoDate(repoMinDate);
  const hiDate = parseRepoDate(repoMaxDate);
  const selectedApns = new Set(state.data.sales.comparables.map((c) => c.parcel).filter(Boolean));

  // Filter
  let rows = repoRecords.filter((r) => {
    if (q && !(String(r.apn || '').toLowerCase().includes(q) || String(r.address || '').toLowerCase().includes(q))) return false;
    if (city && String(r.city || '').toLowerCase() !== city) return false;
    // Keep comps with no recorded type; drop only those with a different type.
    if (type && r.propertyType && String(r.propertyType).trim().toLowerCase() !== type) return false;
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

  // Nine columns (city is folded under the address; land/age live in the
  // comp form). Fixed widths + a flexible address column keep the table within
  // the pane width so it never scrolls horizontally.
  const COLS = [
    ['similarity', 'Sim', 58],
    ['apn', 'APN', 92],
    ['address', 'Address', null],
    ['propertyType', 'Type', 110],
    ['saleDate', 'Date', 84],
    ['price', 'Price', 84],
    ['psf', '$/SF', 58],
    ['buildingArea', 'Bldg SF', 80],
    ['yearBuilt', 'Yr Bld', 64],
  ];

  const header = el('tr', {},
    ...COLS.map(([key, label, width]) => {
      const th = el('th', { class: `sortable ${repoSortKey === key ? 'sorted' : ''}`, onclick: () => toggleRepoSort(key) },
        label,
        el('span', { class: 'sort-ind' }, repoSortKey === key ? (repoSortDir === 'asc' ? '▲' : '▼') : '↕'),
      );
      if (width) th.style.width = `${width}px`;
      if (key === 'price' || key === 'psf' || key === 'buildingArea' || key === 'yearBuilt' || key === 'similarity') th.style.textAlign = 'right';
      return th;
    }),
    el('th', { style: 'width:64px' }, ''),
  );

  // Fixed subject row — quick-glance reference for the subject's characteristics
  // while selecting comps. Always pinned above the comp rows (not filtered/sorted).
  const p = state.data.property;
  const imp = state.data.improvements.primary;
  const hasSubjectData = !!(p.apn || p.address || (imp.grossFloorArea || 0) > 0 || (p.salePrice || 0) > 0);
  const subjectPSF = (imp.grossFloorArea || 0) > 0 && (p.salePrice || 0) > 0 ? p.salePrice / imp.grossFloorArea : 0;
  const subjectRow = hasSubjectData ? el('tr', { class: 'subject-row' },
    el('td', { class: 'sim' }, '—'),
    el('td', {}, p.apn || '—'),
    el('td', { class: 'addr' },
      el('div', { class: 'addr-main', title: titleCase(p.address) || '' }, titleCase(p.address) || '—'),
      el('div', { class: 'addr-sub' }, normalizeCity(p.city) || ''),
    ),
    el('td', {}, imp.type || '—'),
    // Transfers: the subject's transfer date (effective date, matching the
    // report's "Date of Transfer") + transfer price in the Date/Price cells.
    el('td', {}, (p.caseType || 'transfer') === 'transfer' && p.effectiveDate ? fmtDateMDY(p.effectiveDate) : '—'),
    el('td', { class: 'num' }, (p.salePrice || 0) > 0 ? fmtCurrency(p.salePrice) : '—'),
    el('td', { class: 'num' }, subjectPSF > 0 ? subjectPSF.toFixed(2) : '—'),
    el('td', { class: 'num' }, (imp.grossFloorArea || 0) > 0 ? fmtNumber(imp.grossFloorArea) : '—'),
    el('td', { class: 'num' }, (imp.yearBuilt || 0) > 0 ? String(imp.yearBuilt) : '—'),
    el('td', {}, el('span', { class: 'subject-badge' }, 'SUBJECT')),
  ) : null;

  const body = el('tbody', {}, subjectRow, rows.map((r) => {
    const isSelected = selectedApns.has(r.apn);
    const tr = el('tr', { class: isSelected ? 'selected' : '' },
      el('td', { class: 'sim' }, r.__sim > 0 ? `${Math.round(r.__sim)}%` : '—'),
      el('td', {}, r.apn || '—'),
      el('td', { class: 'addr' },
        el('div', { class: 'addr-main', title: titleCase(r.address) || '' }, titleCase(r.address) || '—'),
        el('div', { class: 'addr-sub' }, normalizeCity(r.city) || ''),
      ),
      el('td', {}, r.propertyType || '—'),
      el('td', {}, r.saleDate ? fmtDateMDY(r.saleDate) : '—'),
      el('td', { class: 'num' }, r.price > 0 ? fmtCurrency(r.price) : '—'),
      el('td', { class: 'num' }, repoPSF(r) > 0 ? repoPSF(r).toFixed(2) : '—'),
      el('td', { class: 'num' }, r.buildingArea > 0 ? fmtNumber(r.buildingArea) : '—'),
      el('td', { class: 'num' }, repoYearBuilt(r) > 0 ? String(repoYearBuilt(r)) : '—'),
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
  const group = opts.group !== false;
  const input = el('input', { type: 'text', inputmode: 'decimal' });
  input.value = Number.isFinite(comp[key])
    ? (group ? formatCommas(String(comp[key])) : String(comp[key]))
    : 0;
  input.addEventListener('focus', () => input.select());
  bindCommaInput(input, (n) => compSet(comp, { [key]: n }), group);
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

// Multi-photo panel for a comparable. Manages comp.photos (a list of
// { source: "gis" } | { source: "upload", file }) keyed by the comp's own APN.
// Supports the GIS satellite, uploading (multi-select), and drag & drop; each
// photo can be removed individually. (Paste is handled globally for the subject.)
function compPhotosPanel(comp) {
  const apn = String(comp.parcel || '').trim();
  if (!Array.isArray(comp.photos)) comp.photos = [];

  const wrap = el('div', { class: 'img-panel' });
  const grid = el('div', { class: 'img-panel-grid' });
  const modeBtns = el('div', { class: 'img-panel-modes' });

  const reRender = () => {
    grid.replaceChildren();
    comp.photos.forEach((ph, i) => {
      const url = resolveCompPhotoUrl(comp, ph);
      const cell = el('div', { class: 'img-thumb' });
      cell.append(url
        ? photoImg(url, `Comp photo ${i + 1}`)
        : el('div', { class: 'img-thumb-ph' }, ph.source === 'gis' ? 'GIS Map' : 'Photo'));
      const rm = el('button', { class: 'btn tiny danger img-thumb-rm' }, 'Remove');
      rm.onclick = () => { comp.photos.splice(i, 1); markDirty(); refreshComputed(); reRender(); };
      cell.append(rm);
      grid.append(cell);
    });
    const add = el('div', { class: 'img-thumb img-thumb-add' },
      el('div', { class: 'img-thumb-add-inner' },
        el('div', { class: 'img-thumb-add-plus' }, '+'),
        el('div', { class: 'img-thumb-add-label' }, 'Add photo'),
      ),
    );
    add.onclick = () => fileInput.click();
    grid.append(add);
  };

  const addPhoto = (photo) => {
    comp.photos.push(photo);
    markDirty(); refreshComputed(); reRender();
  };

  const uploadFile = (f) => {
    if (!f || !f.type || !f.type.startsWith('image/')) return;
    if (!apn) { toast('Set a parcel # first', true); return; }
    readPendingPhoto(f, (photo) => addPhoto(photo));
  };

  const gisBtn = el('button', { class: 'btn tiny img-mode-btn' }, '🛰 GIS Map');
  gisBtn.onclick = () => {
    if (!apn) { toast('Set a parcel # first', true); return; }
    if (comp.photos.some((ph) => ph.source === 'gis')) { toast('GIS map already added', true); return; }
    addPhoto({ source: 'gis' });
  };

  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true });
  fileInput.style.display = 'none';
  const uploadBtn = el('button', { class: 'btn tiny img-mode-btn' }, '📷 Upload / Paste');
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    for (const f of fileInput.files) uploadFile(f);
    fileInput.value = '';
  };

  wrap.ondragover = (e) => { e.preventDefault(); wrap.classList.add('drag'); };
  wrap.ondragleave = () => wrap.classList.remove('drag');
  wrap.ondrop = (e) => {
    e.preventDefault(); wrap.classList.remove('drag');
    for (const f of e.dataTransfer.files) uploadFile(f);
  };

  modeBtns.append(gisBtn, uploadBtn);
  wrap.append(
    el('div', { class: 'img-panel-head' }, el('span', { class: 'img-panel-title' }, 'Comparable Photos'), modeBtns),
    grid,
    fileInput,
  );
  reRender();
  return wrap;
}

function compForm(comp, compIndex) {
  const set = (patch) => compSet(comp, patch);
  return el('div', { class: 'comp-form' },
    el('div', { class: 'comp-form-head' },
      el('h3', {}, `Comparable #${compIndex + 1}`),
      el('button', { class: 'btn tiny danger', onclick: () => removeComp(comp.id) }, 'Remove'),
    ),
    compPhotosPanel(comp),
    section('Identification', null, null,
      el('div', { class: 'field-grid c2' },
        compTextField('Parcel #', comp, 'parcel'),
        compTextField('City', comp, 'city'),
        el('div', { style: 'grid-column: span 2' }, compTextField('Address', comp, 'address')),
        el('div', { class: 'field' }, el('label', {}, 'Sale Date'),
          (() => {
            const input = el('input', { class: 'inp', type: 'text', placeholder: 'MM/DD/YYYY' });
            input.value = comp.saleDate ? fmtDateMDY(comp.saleDate) : '';
            input.addEventListener('input', () => {
              const iso = parseRepoDate(input.value);
              compSet(comp, { saleDate: iso });
            });
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
  );
}

// Sales tab (SalesTab.tsx)
function salesTab() {
  const d = state.data;
  const s = d.sales;

  // Section heading + toolbar + repository panel
  const repo = section('Sales Comparison', null, null,
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
          (() => {
            const sel = el('select', { class: 'inp' });
            sel.append(el('option', { value: '' }, 'Any'));
            const cities = [...new Set(repoRecords.map((r) => String(r.city || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            if (repoCity && !cities.includes(repoCity)) cities.unshift(repoCity);
            for (const c of cities) {
              const opt = el('option', { value: c }, c);
              if (c === repoCity) opt.selected = true;
              sel.append(opt);
            }
            sel.addEventListener('change', () => { repoCity = sel.value; renderRepoResults(); });
            return sel;
          })(),
        ),
        el('div', { class: 'repo-filter' },
          el('label', {}, 'Type'),
          (() => {
            const sel = el('select', { class: 'inp' });
            sel.append(el('option', { value: '' }, 'Any'));
            const types = [...new Set(repoRecords.map((r) => String(r.propertyType || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            const eff = (repoType || (state.data.improvements?.primary?.type || '')).trim();
            if (eff && !types.includes(eff)) types.unshift(eff);
            for (const t of types) {
              const opt = el('option', { value: t }, t);
              if (t === eff) opt.selected = true;
              sel.append(opt);
            }
            sel.addEventListener('change', () => { repoType = sel.value; renderRepoResults(); });
            return sel;
          })(),
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

  // "Include Cost Approach" toggle — the on/off switch for the cost approach.
  // Checking it makes hasCostData() true, which reveals the Cost tab, the cost
  // weight row below, and the cost sheet in the report. Unchecking hides them.
  const costToggle = el('label', { class: 'cost-toggle' },
    el('input', { type: 'checkbox' }),
    el('span', {}, 'Include Cost Approach'),
  );
  const costToggleInput = costToggle.querySelector('input');
  costToggleInput.checked = !!d.cost.includeInReport;
  costToggleInput.addEventListener('change', (e) => {
    d.cost.includeInReport = e.target.checked;
    markDirty();
    renderForm();
    refreshComputed();
    scheduleAutosave();
  });

  return [
    section('Approach Weights', 'Relative weight assigned to each approach', null,
      costToggle,
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

// Which "key" fields count toward a complete cover, per case type. The badge
// shows how many are filled so the appraiser knows when they can move on.
function coverCompletion() {
  const d = state.data;
  const p = d.property;
  const c = d.cover;
  const key = (v) => (v == null ? '' : String(v)).trim();
  const sets = {
    transfer: [
      key(p.transferDocumentNumber), key(p.ratioCode),
      (p.salePrice ?? 0) > 0 ? '1' : '',
      key(p.appraiserId), key(p.section),
    ],
    appeal: [
      key(p.taxYear), key(c.hearingDate), key(c.caseNumber),
      key(c.applicant), key(c.agent), key(c.presentedBy),
    ],
    stipulation: [
      key(p.stipulationDate), key(c.hearingDate), key(c.applicationNumber),
      key(c.applicantName), key(c.agentName),
    ],
    general: [
      key(p.purpose), key(p.reportType), key(p.client),
      key(p.appraiser), key(p.appraiserId), key(p.section),
    ],
  };
  const fields = sets[p.caseType || 'transfer'] || sets.transfer;
  const filled = fields.filter(Boolean).length;
  return { filled, total: fields.length, done: filled === fields.length };
}

// Live-update the cover completion badge (called from refreshComputed so it
// tracks field edits without a full re-render).
function updateCoverComplete() {
  const badge = document.getElementById('cover-complete');
  if (!badge) return;
  const { filled, total, done } = coverCompletion();
  badge.textContent = done ? '✓ Cover complete' : `${filled}/${total} filled`;
  badge.classList.toggle('done', done);
}

// Per-tab completion state for the tab-bar status glyphs.
function tabStatus(tabId) {
  const d = state.data;
  const p = d.property;
  const key = (v) => (v == null ? '' : String(v)).trim();
  let done = false;
  switch (tabId) {
    // In a multi-parcel portfolio the Cover tab is the Combined Portfolio
    // Summary (always populated), so it reads as complete.
    case 'cover': done = isPortfolio() ? true : coverCompletion().done; break;
    case 'subject':
      done = !!(key(p.address) || key(p.apn) || key(p.legalDescription) || key(d.improvements?.primary?.type));
      break;
    case 'sales': done = (d.sales?.comparables || []).length > 0; break;
    case 'income': done = hasIncomeData(d); break;
    case 'reconciliation': done = !!(d.reconciliation?.finalValue || d.reconciliation?.weightedValue); break;
    case 'cost': done = hasCostData(d); break;
  }
  return done ? 'done' : 'empty';
}

// Live-update the tab-bar status glyphs (called from refreshComputed).
function updateTabStatus() {
  document.querySelectorAll('.tab-status').forEach((n) => {
    const st = tabStatus(n.dataset.tab);
    n.textContent = st === 'done' ? '✓' : '•';
    n.classList.toggle('done', st === 'done');
  });
}

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
      el('div', { class: 'cs-complete', id: 'cover-complete' }, '0/0 filled'),
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
    coverPhotoPanel(),
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
      section('Transfer Details', 'Transfer-specific fields shown on the report', null,
        el('div', { class: 'field-group' },
          el('div', { class: 'field-group-label' }, 'Transfer'),
          el('div', { class: 'field-grid c3' },
            textField('Transfer Document #', 'property.transferDocumentNumber', { placeholder: 'e.g. 2026-SR00015' }),
            textField('Ratio Code', 'property.ratioCode', { placeholder: 'e.g. STT' }),
            selectField('Property Type', 'improvements.primary.type', TYPE_OPTIONS),
          ),
        ),
        el('div', { class: 'field-group' },
          el('div', { class: 'field-group-label' }, 'Valuation'),
          el('div', { class: 'field-grid c4' },
            numField('Sale Price', 'property.salePrice', { prefix: '$' }),
            numField('Enrolled Value', 'cover.totalPosted', { prefix: '$' }),
            textField('Appraiser ID', 'property.appraiserId', { placeholder: 'e.g. 677' }),
            textField('Section', 'property.section', { placeholder: 'e.g. Riverside Commercial' }),
          ),
        ),
        areaField('Appraiser Notes', 'property.appraiserNotes', 3),
      ),
    );
  } else if (caseType === 'appeal') {
    sections.push(
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

// --- portfolio summary panel (input-side view for the "Combined Portfolio
// Summary" tab) ---------------------------------------------------------------
// Surfaces the live aggregate and lets the appraiser manage associated parcels.
function staticChip(label, value, emphasis = false) {
  return el('div', { class: `chip ${emphasis ? 'emphasis' : ''}` },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value' }, value),
  );
}

// Re-render the form + report and ask main.js to refresh the parcel strip +
// top bar (those live in main.js, so we signal via an event).
function afterPortfolioChange() {
  renderForm();
  renderReport();
  document.dispatchEvent(new CustomEvent('portfolio:changed'));
}

function portfolioSummaryPanel() {
  const parcels = state.portfolio.parcels;
  const agg = computePortfolioAggregate(parcels);
  const chips = el('div', { class: 'chip-grid' },
    staticChip('Total Gross Floor Area', `${fmtNumber(agg.totalSqft)} sq ft`),
    staticChip('Total Net Leasable Area', `${fmtNumber(agg.totalNla)} sq ft`),
    staticChip('Total Site Area', `${fmtNumber(agg.totalSiteSqFt)} sq ft`),
    staticChip('Total Acreage', fmtAcresNum(agg.totalAcres)),
    staticChip('Total Land Value', fmtCurrency(agg.totalLandValue)),
    staticChip('Total Final Value', fmtCurrency(agg.totalFinalValue), true),
  );
  const list = el('div', { class: 'parcel-list' },
    parcels.map((p, i) => el('div', { class: 'parcel-row' },
      el('button', {
        class: 'parcel-row-main',
        onclick: () => { selectParcel(i); afterPortfolioChange(); },
      },
        el('div', { class: 'parcel-row-title' }, `${i === 0 ? 'Main Subject' : 'Associated'} · APN ${p.property?.apn || '—'}`),
        el('div', { class: 'parcel-row-sub' }, p.property?.address || '—'),
      ),
      parcels.length > 1 ? el('button', {
        class: 'parcel-row-remove', title: 'Remove parcel',
        onclick: () => { removeParcel(i); afterPortfolioChange(); },
      }, '×') : null,
    )),
  );
  return [
    section('Combined Portfolio Summary', 'Aggregate across all associated parcels', null, chips),
    section('Associated Parcels', 'Select a parcel to edit its characteristics',
      el('button', { class: 'btn tiny', onclick: () => { addParcel(''); afterPortfolioChange(); } }, '+ Add Parcel'),
      list),
  ];
}

export function renderForm() {
  const root = document.getElementById('form-root');
  if (!root) return;
  // Multi-parcel portfolios use the same tab set as a single parcel (Cover,
  // Subject, Sales, Income, Reconcile, Cost). The Cover tab is the Combined
  // Portfolio Summary; the other tabs edit the active parcel.
  const isPf = isPortfolio();
  // The Cost tab is only reachable while the cost approach is enabled; if it
  // gets disabled elsewhere, fall back so we never sit on a hidden tab.
  if (activeTab === 'cost' && !hasCostData(state.data)) activeTab = 'reconciliation';

  const tabs = el('div', { class: 'tab-bar' },
    el('div', { class: 'tabs-box' },
      TABS.filter((t) => t.id !== 'cost' || hasCostData(state.data)).map((t) => {
        const st = tabStatus(t.id);
        return el('button', {
          class: `tab ${t.id === activeTab ? 'active' : ''}`,
          onclick: () => { activeTab = t.id; renderForm(); scrollToSection(t.id); },
        }, t.label, el('span', { class: `tab-status ${st === 'done' ? 'done' : ''}`, 'data-tab': t.id }, st === 'done' ? '✓' : '•'));
      }),
    ),
  );

  const body = el('div', { class: 'tab-content' });
  // Portfolio: Cover = Combined Portfolio Summary, Subject = one section per APN.
  const builders = isPf
    ? { ...TAB_BUILDERS, cover: portfolioSummaryPanel, subject: portfolioSubjectTab }
    : TAB_BUILDERS;
  for (const node of builders[activeTab]()) {
    if (node) body.append(node);
  }

  // Swap in only after the content built successfully, so a render error
  // leaves the previous UI in place instead of an empty, unusable pane.
  root.replaceChildren(tabs, body);

  // Let main.js inject the APN/Address search box into the cover setup bar
  // (it owns the navigation callbacks, so it can't live in this module).
  document.dispatchEvent(new CustomEvent('form:rendered'));

  // Refresh the cover completion badge + tab status glyphs now that the DOM is
  // in place (they also track live edits via refreshComputed).
  updateCoverComplete();
  updateTabStatus();

  // Load the comp repository when the Sales tab is active.
  if (activeTab === 'sales') loadRepo();
}

export function setTab(t) { activeTab = t; }
export { loadRepo };