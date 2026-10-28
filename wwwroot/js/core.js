// ---------------------------------------------------------------------------
// core.js — calculations, model, API, state (ported from src/lib + src/data)
// ---------------------------------------------------------------------------

const SQFT_PER_ACRE = 43560;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const safe = (n) => (Number.isFinite(n) ? n : 0);

// --- calculations -----------------------------------------------------------

export function computeCost(data) {
  const { primary, outbuildings } = data.improvements;
  const costNewImprovements = safe(
    primary.grossFloorArea * primary.unitCost +
      (outbuildings || []).reduce((sum, o) => sum + safe(o.grossFloorArea * o.unitCost), 0),
  );
  const physicalDepreciation = safe((costNewImprovements * data.cost.physicalDepreciationPct) / 100);
  const totalDepreciation = safe(
    physicalDepreciation + data.cost.functionalDepreciation + data.cost.economicDepreciation,
  );
  const depreciatedCost = safe(costNewImprovements - totalDepreciation);
  const valueByCost = safe(data.land.landValue + depreciatedCost);
  return {
    costNewImprovements: round2(costNewImprovements),
    physicalDepreciation: round2(physicalDepreciation),
    totalDepreciation: round2(totalDepreciation),
    depreciatedCost: round2(depreciatedCost),
    valueByCost: round2(valueByCost),
  };
}

export function hasCostData(data) {
  return !!(
    (data.improvements?.primary?.grossFloorArea ?? 0) > 0 ||
    (data.cost?.physicalDepreciationPct ?? 0) > 0 ||
    (data.cost?.functionalDepreciation ?? 0) > 0 ||
    (data.cost?.economicDepreciation ?? 0) > 0
  );
}

// The income approach is only "used" when a PGI rate was entered for a
// property with building area — never for land, and often skipped otherwise.
export function hasIncomeData(data) {
  return !!(
    (data.income?.pgiPerSf ?? 0) > 0 &&
    (data.improvements?.primary?.grossFloorArea ?? 0) > 0
  );
}

export function computeIncome(data) {
  const { pgiPerSf, vacancyPct, collectionLossPct, operatingExpensePct, capRate } = data.income;
  const gfa = data.improvements.primary.grossFloorArea ?? 0;
  const totalPgi = safe(pgiPerSf * gfa * 12);
  const vacancyLoss = safe(totalPgi * (vacancyPct / 100));
  const collectionLoss = safe((totalPgi - vacancyLoss) * (collectionLossPct / 100));
  const effectiveGrossIncome = safe(totalPgi - vacancyLoss - collectionLoss);
  const operatingExpenses = safe(effectiveGrossIncome * (operatingExpensePct / 100));
  const netOperatingIncome = safe(effectiveGrossIncome - operatingExpenses);
  const valueByIncome = capRate > 0 ? safe(netOperatingIncome / (capRate / 100)) : 0;
  return {
    totalPgi: round2(totalPgi),
    vacancyLoss: round2(vacancyLoss),
    collectionLoss: round2(collectionLoss),
    effectiveGrossIncome: round2(effectiveGrossIncome),
    operatingExpenses: round2(operatingExpenses),
    netOperatingIncome: round2(netOperatingIncome),
    valueByIncome: round2(valueByIncome),
  };
}

const ADJ_FIELDS = [
  'adjBuildingSize', 'adjLocation', 'adjCornerSite', 'adjAge', 'adjQuality',
  'adjCondition', 'adjTenantsUse', 'adjOccupancy', 'adjLandBldgRatio',
  'adjFreeway', 'adjMarketConditions', 'adjConditionOfSale',
];

export function computeSales(data) {
  const comps = data.sales.comparables || [];
  const selected = comps.filter((c) => c.selected);
  const pool = data.sales.method === 'selected' && selected.length > 0 ? selected : comps;
  const subjectSF = safe(data.improvements.primary.grossFloorArea);
  const compValues = pool.map((c) => {
    const unadjSF = c.buildingArea > 0 ? safe(c.price / c.buildingArea) : 0;
    const netAdjPct = safe(ADJ_FIELDS.reduce((s, f) => s + safe(c[f]), 0));
    const adjSF = safe(unadjSF * (1 + netAdjPct / 100));
    return { unadjSF, netAdjPct, adjSF };
  });
  const validAdjSF = compValues.filter((v) => v.adjSF > 0);
  const correlatedSF = validAdjSF.length > 0
    ? safe(validAdjSF.reduce((s, v) => s + v.adjSF, 0) / validAdjSF.length)
    : 0;
  const valueBySales = safe(correlatedSF * subjectSF);
  return {
    valueBySales: round2(valueBySales),
    count: pool.length,
    correlatedSF: round2(correlatedSF),
    subjectSF: round2(subjectSF),
  };
}

export function computeSalesGridComp(c) {
  const unadjSF = c.buildingArea > 0 ? safe(c.price / c.buildingArea) : 0;
  const netAdjPct = safe(ADJ_FIELDS.reduce((s, f) => s + safe(c[f]), 0));
  const adjSF = safe(unadjSF * (1 + netAdjPct / 100));
  const landBldgRatio = c.buildingArea > 0 ? safe((c.landArea * SQFT_PER_ACRE) / c.buildingArea) : 0;
  return {
    unadjSF: round2(unadjSF), netAdjPct: round2(netAdjPct),
    adjSF: round2(adjSF), landBldgRatio: round2(landBldgRatio),
  };
}

export function computeReconciliation(data, cost, income, sales) {
  const { costWeight, incomeWeight, salesWeight } = data.reconciliation;
  const includeCost = hasCostData(data);
  const includeIncome = hasIncomeData(data);
  const totalWeight = safe(
    (includeCost ? costWeight : 0) + (includeIncome ? incomeWeight : 0) + salesWeight,
  );
  const weightedValue = totalWeight > 0
    ? safe(
        ((includeCost ? cost.valueByCost * costWeight : 0) +
          (includeIncome ? income.valueByIncome * incomeWeight : 0) +
          sales.valueBySales * salesWeight) / totalWeight,
      )
    : 0;
  return { totalWeight: round2(totalWeight), weightedValue: roundTo1000(weightedValue) };
}

const ZERO_COMPUTED = {
  landAcres: 0,
  cost: { costNewImprovements: 0, physicalDepreciation: 0, totalDepreciation: 0, depreciatedCost: 0, valueByCost: 0 },
  income: { totalPgi: 0, vacancyLoss: 0, collectionLoss: 0, effectiveGrossIncome: 0, operatingExpenses: 0, netOperatingIncome: 0, valueByIncome: 0 },
  sales: { valueBySales: 0, count: 0, correlatedSF: 0, subjectSF: 0 },
  reconciliation: { totalWeight: 0, weightedValue: 0 },
  totalAssessed: 0,
};

export function computeAppraisal(data) {
  try {
    const cost = computeCost(data);
    const income = computeIncome(data);
    const sales = computeSales(data);
    const reconciliation = computeReconciliation(data, cost, income, sales);
    const landAcres = data.land.acres > 0 ? data.land.acres : safe(data.land.siteAreaSqFt / SQFT_PER_ACRE);
    return {
      landAcres: round2(landAcres),
      cost, income, sales, reconciliation,
      totalAssessed: roundTo5000(data.reconciliation.finalValue || reconciliation.weightedValue),
    };
  } catch {
    return ZERO_COMPUTED;
  }
}


// --- formatting --------------------------------------------------------------

const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const numberFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export function fmtCurrency(n) { return currencyFmt.format(safe(n)); }
export function fmtNumber(n) { return numberFmt.format(safe(n)); }
export function fmtPct(n, digits = 1) { return `${safe(n).toFixed(digits)}%`; }
export function fmtAcres(n, digits = 4) { return `${safe(n).toFixed(digits)} ac`; }
export function roundTo1000(n) { return Math.round(safe(n) / 1000) * 1000; }
export function roundTo5000(n) { return Math.round(safe(n) / 5000) * 5000; }
export function fmtCurrencyRounded(n) { return currencyFmt.format(roundTo1000(n)); }

// Acres as a plain number with thousands separators (no unit suffix).
export function fmtAcresNum(n, digits = 3) {
  return safe(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// Smart Title Case: converts an ALL-CAPS (or mostly-caps) string to Title
// Case so raw county data ("363 AMERICAN CIR", "CORONA") reads naturally.
// Already-mixed-case values ("Light Industrial", "2410 Wardlow RD") are left
// untouched. Idempotent, so it's safe to apply at both ingestion and display.
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'by', 'vs', 'per']);
export function titleCase(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (!str) return str;
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (!letters) return str;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (upper / letters.length < 0.5) return str; // already mixed / lower case
  return str.split(/\s+/).map((w, i, arr) => {
    if (!/[A-Za-z]/.test(w)) return w; // pure number / punctuation token
    const isSmall = SMALL_WORDS.has(w.toLowerCase()) && i !== 0 && i !== arr.length - 1;
    return isSmall ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// Normalize a raw county "City" value — which is really a school-district name
// like "CORONA NORCO USD", "MORENO VALLEY USD", or "PERRIS 2017" — into a clean
// city name ("Corona", "Moreno Valley", "Perris"). Strips district/year
// suffixes, collapses "Corona-Norco" to "Corona", then title-cases. Idempotent,
// so it's safe to apply at both ingestion and display.
export function normalizeCity(s) {
  if (s == null) return '';
  let c = String(s).trim();
  if (!c) return c;
  c = c.replace(/CORONA[\s-]*NORCO/gi, 'CORONA');
  c = c.replace(/\s+(USD|UNIFIED|ELEM|UNION\s+ELEM|UNION)\b/gi, '');
  c = c.replace(/\s*[-–]?\s*\d{4}\s*$/, '');
  c = c.replace(/\s{2,}/g, ' ').trim();
  return titleCase(c);
}

export function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().split('T')[0];
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(
      'en-US', { year: 'numeric', month: 'short', day: 'numeric' },
    );
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function generateReconciliationNarrative(p) {
  const parts = [];
  if (p.includeCost && p.costWeight > 0)
    parts.push(`The Cost Approach indicates a value of ${fmtCurrency(p.costValue)}, assigned a weight of ${p.costWeight}%.`);
  if (p.includeIncome && p.incomeWeight > 0)
    parts.push(`The Income Approach indicates a value of ${fmtCurrency(p.incomeValue)}, assigned a weight of ${p.incomeWeight}%.`);
  if (p.salesWeight > 0)
    parts.push(`The Sales Comparison Approach indicates a value of ${fmtCurrency(p.salesValue)}, assigned a weight of ${p.salesWeight}%.`);
  if (parts.length === 0) return '';
  parts.push(`The weighted average of the indicated values yields ${fmtCurrency(p.weightedValue)}.`);
  parts.push(`After consideration of the relative reliability and precision of each approach, the final reconciled market value is determined to be ${fmtCurrency(p.finalValue)}.`);
  return parts.join(' ');
}


// --- model -------------------------------------------------------------------

export function createEmptyParcel(apn) {
  return {
    property: {
      apn: apn || '', parcelId: '', address: '', city: '', zip: '', county: '',
      intersection: '', legalDescription: '', effectiveDate: '2025-01-01',
      reportDate: todayISO(), appraiser: '', appraiserLicense: '', reportType: '',
      purpose: '', client: '',
      transferDocumentNumber: '', ratioCode: '', salePrice: 0,
      appraiserId: '', section: '', appraiserNotes: '',
      caseType: 'transfer',
    },
    land: {
      siteAreaSqFt: 0, acres: 0, zoning: '', topography: '', shape: '',
      frontageFt: 0, depthFt: 0, lotCount: 0, utilities: [], landValue: 0,
      landValueMethod: '', landValueNotes: '',
    },
    improvements: {
      primary: {
        id: `imp-${Date.now()}`, name: 'Building 1', type: '', yearBuilt: 0,
        grossFloorArea: 0, nla: 0, quality: '', constructionType: '', stories: 0,
        condition: '', unitCost: 0,
      },
      outbuildings: [],
    },
    cost: {
      physicalDepreciationPct: 0, functionalDepreciation: 0,
      economicDepreciation: 0, costNotes: '', includeInReport: false,
    },
    income: {
      rentType: 'NNN', pgiPerSf: 0, vacancyPct: 5, collectionLossPct: 5,
      operatingExpensePct: 5, capRate: 6, incomeNotes: '',
    },
    sales: { method: 'average', remarks: '', comparables: [] },
    reconciliation: {
      costWeight: 0, incomeWeight: 25, salesWeight: 75, finalValue: 0, rationale: '',
    },
    cover: {
      // transfer
      totalPosted: 0,
      // appeal
      hearingDate: '', caseNumber: '', applicant: '', agent: '',
      currentRollValue: 0, applicantOpinionValue: 0, assessorOpinionValue: 0,
      presentedBy: '',
      // stipulation
      applicationNumber: '', applicantName: '', applicantAddress: '',
      agentName: '', agentAddress: '',
      tra: '', assessmentNo: '', arbNo: '', yearArbCreated: '',
      location: '', supplementalNo: '', acreage: '', use: '',
      factsJustifying: '',
      valueCategories: [
        { category: 'Land', code: '01', rollValue: 0, stipulatedValue: 0 },
        { category: 'Structures', code: '02', rollValue: 0, stipulatedValue: 0 },
        { category: 'Fixtures', code: '03', rollValue: 0, stipulatedValue: 0 },
        { category: 'Trees & Vines', code: '05', rollValue: 0, stipulatedValue: 0 },
        { category: 'Business Pers. Prop.', code: '08', rollValue: 0, stipulatedValue: 0 },
        { category: 'Other', code: '', rollValue: 0, stipulatedValue: 0 },
      ],
    },
  };
}

export function normalizeParcel(parcel) {
  const base = createEmptyParcel('');
  if (!parcel || typeof parcel !== 'object') return base;
  const p = parcel;
  return {
    property: { ...base.property, ...(p.property ?? {}) },
    land: { ...base.land, ...(p.land ?? {}) },
    improvements: {
      primary: { ...base.improvements.primary, ...(p.improvements?.primary ?? {}) },
      outbuildings: Array.isArray(p.improvements?.outbuildings) ? p.improvements.outbuildings : base.improvements.outbuildings,
    },
    cost: { ...base.cost, ...(p.cost ?? {}) },
    income: { ...base.income, ...(p.income ?? {}) },
    sales: {
      ...base.sales, ...(p.sales ?? {}),
      comparables: Array.isArray(p.sales?.comparables) ? p.sales.comparables : base.sales.comparables,
    },
    reconciliation: { ...base.reconciliation, ...(p.reconciliation ?? {}) },
    cover: {
      ...base.cover, ...(p.cover ?? {}),
      valueCategories: Array.isArray(p.cover?.valueCategories)
        ? base.cover.valueCategories.map((row, i) => ({ ...row, ...(p.cover.valueCategories[i] ?? {}) }))
        : base.cover.valueCategories,
    },
  };
}

// --- API ---------------------------------------------------------------------

async function req(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

const json = (body) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  listAppraisals: () => req('/api/appraisals'),
  getAppraisal: (id) => req(`/api/appraisals/${id}`),
  createAppraisal: (data) => req('/api/appraisals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }),
  updateAppraisal: (id, data) => req(`/api/appraisals/${id}`, json({ data })),
  deleteAppraisal: (id) => req(`/api/appraisals/${id}`, { method: 'DELETE' }),
  finalize: (appraisalId, data) => req('/api/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appraisalId, data }) }),
  getPermanentComps: () => req('/api/permanent-comps'),
  getTransferComps: () => req('/api/transfer-comps'),
  searchTransferComps: (q) => req('/api/transfer-comps/search?q=' + encodeURIComponent(q)),
  rule2Status: () => req('/api/rule2/status'),
  rule2Run: () => req('/api/rule2/run', { method: 'POST' }),
  getBucketRows: (bucket) => req(`/api/rule2/bucket-rows/${bucket}`),
  getWorkQueue: (type) => req(`/api/workqueue/${type}`),
  getTenant: () => req('/api/tenant'),
  saveTenant: (data) => req('/api/tenant', json(data)),
  parcelSearch: (q) => req('/api/parcel-search?q=' + encodeURIComponent(q)),
  getParcelData: (apn) => req('/api/parcel-data/' + encodeURIComponent(apn)),
};

// --- state -------------------------------------------------------------------

export const state = {
  id: null,        // null = unsaved (new)
  data: createEmptyParcel(''),
  tenant: { county: '', countyName: '', officeName: '', sealUrl: '' },
  dirty: false,
};

export function markDirty() { state.dirty = true; }

export async function saveCurrent() {
  if (state.id === null) {
    const { id } = await api.createAppraisal(state.data);
    state.id = id;
  } else {
    await api.updateAppraisal(state.id, state.data);
  }
  state.dirty = false;
  return state.id;
}

export async function loadAppraisal(id) {
  const { data } = await api.getAppraisal(id);
  state.id = id;
  state.data = normalizeParcel(data);
  state.dirty = false;
}

export function newAppraisal() {
  state.id = null;
  state.data = createEmptyParcel('');
  state.dirty = false;
}

// --- multi-parcel workspace (open tabs) --------------------------------------
// A lightweight "open tabs" model mirroring the reference app's multi-parcel
// workspace. Each tab references a saved appraisal (by server id) or the
// current unsaved working appraisal. Switching/closing a dirty tab persists it
// first (assigning a server id), so at most one unsaved tab exists at a time.
let tabSeq = 0;
export const workspace = {
  tabs: [],        // [{ key, id, apn, address, dirty }]
  activeKey: null,
};

export function activeTab() {
  return workspace.tabs.find((t) => t.key === workspace.activeKey) || null;
}

// Register a tab (or focus an existing one for the same saved id). Returns the tab.
export function addTab({ id = null, apn = '', address = '', dirty = false } = {}) {
  if (id !== null) {
    const existing = workspace.tabs.find((t) => t.id === id);
    if (existing) { workspace.activeKey = existing.key; return existing; }
  }
  const tab = { key: ++tabSeq, id, apn, address, dirty };
  workspace.tabs.push(tab);
  workspace.activeKey = tab.key;
  return tab;
}

export function closeTab(key) {
  const idx = workspace.tabs.findIndex((t) => t.key === key);
  if (idx < 0) return;
  workspace.tabs.splice(idx, 1);
  if (workspace.activeKey === key) {
    const next = workspace.tabs[idx] || workspace.tabs[idx - 1] || workspace.tabs[0];
    workspace.activeKey = next ? next.key : null;
  }
}

// --- autosave (WIP) ----------------------------------------------------------
// Debounced autosave of the working appraisal to the server (SQLite). Mirrors
// the reference app's 1s-debounced WIP autosave. A new (unsaved) appraisal is
// created on first autosave; subsequent autosaves update the same row. The
// manual Save button still works for an immediate save.
let autosaveTimer = null;

function setSaveStatus(next, error = null) {
  const el = document.getElementById('save-status');
  if (!el) return;
  if (next === 'error') el.textContent = `Save failed: ${error || ''}`;
  else el.textContent = '';
}

export function scheduleAutosave() {
  if (!state.dirty) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(runAutosave, 1000);
}

async function runAutosave() {
  autosaveTimer = null;
  if (!state.dirty) return;
  setSaveStatus('saving');
  try {
    await saveCurrent();
    if (state.dirty) runAutosave();   // new edits landed during the save
    else setSaveStatus('saved');
  } catch (e) {
    setSaveStatus('error', e.message);
  }
}

// --- WIP export / import -----------------------------------------------------
// Lossless JSON round-trip of the working appraisal (mirrors the reference
// app's .wip.json). The envelope carries provenance; `data` is the appraisal.
export function exportWip() {
  const payload = {
    app: 'rivco-appraisal',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state.data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.data.property.apn || 'appraisal').replace(/[^\w-]/g, '_')}_wip_${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importWip(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Not valid JSON'); }
  const data = parsed && typeof parsed === 'object' ? (parsed.data ?? parsed) : null;
  if (!data || typeof data !== 'object' || !data.property) {
    throw new Error('Not a valid WIP file (missing appraisal data)');
  }
  return normalizeParcel(data);
}

// --- local (machine-only) comp store -----------------------------------------
// CSV-imported comps live in localStorage: they exist only on this machine,
// in this browser. Permanent comps (finalized appraisals) live server-side.
// ---------------------------------------------------------------------------

const LOCAL_COMPS_KEY = 'rivco.localComps';

export function getLocalComps() {
  try {
    const raw = localStorage.getItem(LOCAL_COMPS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function setLocalComps(list) {
  localStorage.setItem(LOCAL_COMPS_KEY, JSON.stringify(list));
}

export function clearLocalComps() {
  localStorage.removeItem(LOCAL_COMPS_KEY);
}

// Minimal CSV parse: quoted fields, escaped quotes (""), CRLF/LF, BOM.
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Header aliases (lowercase) → CompRecord field.
const CSV_FIELD_MAP = {
  apn: ['apn', 'parcel', 'parcel#', 'parcel number', 'apn#'],
  address: ['address', 'street', 'street address', 'location'],
  city: ['city'],
  saleDate: ['saledate', 'sale date', 'transfer date', 'date', 'recorded date'],
  price: ['price', 'sale price', 'saleprice', 'cash eq sale price', 'cash equivalent sale price', 'amount'],
  age: ['age'],
  quality: ['quality'],
  condition: ['condition'],
  landArea: ['landarea', 'land area', 'acres', 'land (acres)'],
  buildingArea: ['buildingarea', 'building area', 'building sf', 'gross floor area', 'gfa', 'sf', 'area'],
  clearHeight: ['clearheight', 'clear height'],
  zoning: ['zoning'],
  propertyType: ['propertytype', 'property type', 'type'],
  isArmsLength: ['isarmslength', 'arms length', 'arms-length'],
};
const CSV_NUM_FIELDS = ['price', 'age', 'landArea', 'buildingArea', 'clearHeight', ...ADJ_FIELDS];

function csvRowToComp(header, row) {
  const get = (names) => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx >= 0 && row[idx] !== undefined && String(row[idx]).trim() !== '') return String(row[idx]).trim();
    }
    return '';
  };
  const apn = get(CSV_FIELD_MAP.apn);
  if (!apn) return null;
  const rec = {
    apn,
    address: get(CSV_FIELD_MAP.address),
    city: get(CSV_FIELD_MAP.city),
    saleDate: get(CSV_FIELD_MAP.saleDate),
    quality: get(CSV_FIELD_MAP.quality),
    condition: get(CSV_FIELD_MAP.condition),
    zoning: get(CSV_FIELD_MAP.zoning),
    propertyType: get(CSV_FIELD_MAP.propertyType),
    isArmsLength: true,
    sourceReport: '',
    subjectApn: '',
    photoUrl: '',
  };
  for (const f of CSV_NUM_FIELDS) {
    const n = parseFloat(get(CSV_FIELD_MAP[f] ?? [f.toLowerCase()]));
    rec[f] = Number.isFinite(n) ? n : 0;
  }
  const arms = get(CSV_FIELD_MAP.isArmsLength).toLowerCase();
  rec.isArmsLength = !(arms === 'false' || arms === '0' || arms === 'ind' || arms === 'ind.');
  return rec;
}

// Parse CSV text and merge into the machine-local comp store.
// Dedup key: APN + saleDate (against existing local comps and within the file).
export function importLocalComps(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { added: 0, skipped: 0 };
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const existing = getLocalComps();
  const seen = new Set(existing.map((r) => `${r.apn}|${r.saleDate}`));
  let added = 0, skipped = 0;
  for (const row of rows.slice(1)) {
    const rec = csvRowToComp(header, row);
    if (!rec) { skipped++; continue; }
    const key = `${rec.apn}|${rec.saleDate}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    existing.push(rec);
    added++;
  }
  setLocalComps(existing);
  return { added, skipped };
}

