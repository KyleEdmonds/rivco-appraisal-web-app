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
  const totalWeight = safe((includeCost ? costWeight : 0) + incomeWeight + salesWeight);
  const weightedValue = totalWeight > 0
    ? safe(
        ((includeCost ? cost.valueByCost * costWeight : 0) +
          income.valueByIncome * incomeWeight +
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
  if (p.incomeWeight > 0)
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
  getComps: () => req('/api/comps'),
  saveComps: (data) => req('/api/comps', json(data)),
  getTenant: () => req('/api/tenant'),
  saveTenant: (data) => req('/api/tenant', json(data)),
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

