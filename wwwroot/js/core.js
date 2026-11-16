// ---------------------------------------------------------------------------
// core.js — calculations, model, API, state (ported from src/lib + src/data)
// ---------------------------------------------------------------------------

import { compositeParcelMap } from './mapimg.js';

const SQFT_PER_ACRE = 43560;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Coerce to a finite number (county data arrives as strings like "1.760").
const safe = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };

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

// The cost approach is "used" only when the appraiser actually opts in or
// enters cost data — NOT merely because the property has building area (that
// made the cost sheet + weight row appear on nearly every report). Mirrors the
// hasIncomeData pattern of requiring a real input.
export function hasCostData(data) {
  return !!(
    (data.cost?.includeInReport ?? false) ||
    (data.cost?.physicalDepreciationPct ?? 0) > 0 ||
    (data.cost?.functionalDepreciation ?? 0) > 0 ||
    (data.cost?.economicDepreciation ?? 0) > 0 ||
    (data.reconciliation?.costWeight ?? 0) > 0
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
  const subjectSF = safe(data.improvements.primary.grossFloorArea);
  const compValues = comps.map((c) => {
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

// --- comp similarity scoring (ported from src/lib/compSelection.ts) -----------
// Weighted distance across building SF, cost/SF, age, and location. Each
// sub-score is in [0,1] where 1 = identical; the weighted average is the
// overall similarity. Pure and deterministic — no I/O.

const SIM_WEIGHTS = { sf: 0.35, costPerSf: 0.25, age: 0.20, location: 0.20 };
const SIM_AGE_WINDOW_YEARS = 50;

function simRatioScore(a, b) {
  if (a <= 0 || b <= 0) return 0;
  return 1 - Math.abs(a - b) / Math.max(a, b);
}
function simAgeScore(subjectAge, compAge) {
  if (subjectAge < 0 || compAge < 0) return 0;
  return 1 - Math.min(Math.abs(subjectAge - compAge) / SIM_AGE_WINDOW_YEARS, 1);
}
function simLocationScore(subjectCity, compCity) {
  const s = (subjectCity || '').toLowerCase().trim();
  const c = (compCity || '').toLowerCase().trim();
  if (s && c && s === c) return 1.0;
  return 0.0;
}

/**
 * Score a single comp against the subject. Returns a similarity in [0, 1].
 * `subject` is the live appraisal data; `comp` is a CompRecord (or comparable).
 */
export function scoreComp(subject, comp) {
  const imp = subject.improvements?.primary || {};
  const p = subject.property || {};
  const subjectSF = safe(imp.grossFloorArea);
  const compSF = safe(comp.buildingArea);
  const subjectCostSf = subjectSF > 0 ? safe((subject.reconciliation?.finalValue || 0) / subjectSF) : 0;
  const compCostSf = compSF > 0 ? safe(safe(comp.price) / compSF) : 0;
  const currentYear = new Date().getFullYear();
  const subjectAge = imp.yearBuilt ? currentYear - imp.yearBuilt : -1;

  const sf = simRatioScore(subjectSF, compSF);
  const cost = simRatioScore(subjectCostSf, compCostSf);
  const age = simAgeScore(subjectAge, safe(comp.age));
  const loc = simLocationScore(p.city, comp.city);

  let totalWeight = 0;
  let weightedSum = 0;
  if (subjectSF > 0) { weightedSum += sf * SIM_WEIGHTS.sf; totalWeight += SIM_WEIGHTS.sf; }
  if (subjectCostSf > 0 && compCostSf > 0) { weightedSum += cost * SIM_WEIGHTS.costPerSf; totalWeight += SIM_WEIGHTS.costPerSf; }
  if (subjectAge >= 0 && safe(comp.age) >= 0) { weightedSum += age * SIM_WEIGHTS.age; totalWeight += SIM_WEIGHTS.age; }
  if (p.city) { weightedSum += loc * SIM_WEIGHTS.location; totalWeight += SIM_WEIGHTS.location; }

  if (totalWeight === 0) return 0;
  return round2((weightedSum / totalWeight) * 100); // percent 0–100
}

/**
 * Rank a pool of comps by similarity to the subject (descending).
 * Returns [{ record, score }] sorted best-first.
 */
export function rankCompsBySimilarity(subject, pool) {
  return pool
    .map((record) => ({ record, score: scoreComp(subject, record) }))
    .sort((a, b) => (b.score - a.score) || (String(b.record.saleDate || '').localeCompare(String(a.record.saleDate || ''))));
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
      // Total Assessed matches the Enrolled Value (cover.totalPosted) when it's
      // set; otherwise it falls back to the computed final/weighted value.
      totalAssessed: safe(data.cover?.totalPosted) > 0
        ? data.cover.totalPosted
        : roundTo5000(data.reconciliation.finalValue || reconciliation.weightedValue),
    };
  } catch {
    return ZERO_COMPUTED;
  }
}

// --- portfolio aggregation (pure, defensive — isolates per-parcel failures) ---
// Sums site/GFA/land/cost/income/sales/weighted/final across the parcels of a
// multi-parcel appraisal. Per-parcel compute is isolated in try/catch so a
// corrupt parcel cannot throw and crash the whole portfolio rollup.
export function computePortfolioAggregate(parcels) {
  const list = Array.isArray(parcels) ? parcels : [];
  let totalSiteSqFt = 0, totalGfa = 0, totalLandValue = 0;
  let totalCost = 0, totalIncome = 0, totalSales = 0, totalWeighted = 0, totalFinal = 0;
  for (const parcel of list) {
    if (!parcel) continue;
    totalSiteSqFt += safe(parcel.land?.siteAreaSqFt);
    totalLandValue += safe(parcel.land?.landValue);
    const primaryGfa = safe(parcel.improvements?.primary?.grossFloorArea);
    const outGfa = (parcel.improvements?.outbuildings ?? []).reduce((sum, o) => sum + safe(o?.grossFloorArea), 0);
    totalGfa += safe(primaryGfa + outGfa);
    let c;
    try { c = computeAppraisal(parcel); } catch { c = ZERO_COMPUTED; }
    totalCost += safe(c.cost.valueByCost);
    totalIncome += safe(c.income.valueByIncome);
    totalSales += safe(c.sales.valueBySales);
    totalWeighted += safe(c.reconciliation.weightedValue);
    totalFinal += safe(c.totalAssessed);
  }
  return {
    parcelCount: list.length,
    totalSiteSqFt: round2(totalSiteSqFt),
    totalAcres: round2(totalSiteSqFt / SQFT_PER_ACRE),
    totalSqft: round2(totalGfa),
    totalNla: round2(totalGfa),
    totalLandValue: round2(totalLandValue),
    totalCostValue: round2(totalCost),
    totalIncomeValue: round2(totalIncome),
    totalSalesValue: round2(totalSales),
    totalWeightedValue: round2(totalWeighted),
    totalFinalValue: round2(totalFinal),
  };
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

// Zero-padded MM/DD/YYYY (used for sale dates on the Sales tab).
export function fmtDateMDY(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso));
  if (m) return `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
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
      subjectImage: null, // legacy single ref (kept for migration); superseded by subjectPhotos
      subjectPhotos: [], // list of { source: "gis" } or { source: "upload", file: "..." }
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
    sales: { remarks: '', comparables: [] },
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

// --- GIS (satellite) photo resolution ---------------------------------------
// GIS photos are composited in the browser (see mapimg.js) instead of being
// rendered server-side. The resolve*() functions return a lightweight marker
// for a GIS photo so the report/panels render instantly; photoImg()/
// loadGisImage() then swap in the composited data URL once it's ready (cached
// per APN in mapimg.js).
export const GIS_MARKER = 'gis:';
const gisUrl = (apn) => GIS_MARKER + encodeURIComponent(String(apn).trim());

// Swap a GIS marker into a real composited satellite data URL on an <img>.
// No-op for non-GIS urls. Best-effort: on failure (no geometry / imagery) the
// image element is removed.
export async function loadGisImage(imgEl, url) {
  if (!imgEl || typeof url !== 'string' || !url.startsWith(GIS_MARKER)) return;
  const apn = decodeURIComponent(url.slice(GIS_MARKER.length));
  try {
    const dataUrl = await compositeParcelMap(apn);
    if (dataUrl) imgEl.src = dataUrl;
    else imgEl.remove();
  } catch { imgEl.remove(); }
}

// Create an <img> for a resolved photo url. GIS markers get a placeholder and
// are filled in asynchronously by loadGisImage; other urls are set directly.
export function photoImg(url, alt = '') {
  const img = document.createElement('img');
  img.alt = alt;
  if (typeof url === 'string' && url.startsWith(GIS_MARKER)) {
    img.src = ''; // placeholder; loadGisImage fills it (avoids a broken image)
    loadGisImage(img, url);
  } else {
    img.src = url;
  }
  return img;
}

// --- subject image resolution -------------------------------------------------
// Resolves a single photo reference to a displayable URL.
//   { source: "gis" }              → a GIS marker (composited in the browser)
//   { source: "upload", file }     → /api/parcel-photos/{apn}/{file}
//   { source: "map", dataUrl }     → the data URL (Google map, stays local)
//   null / undefined               → null (no image)
export function resolvePhotoUrl(data, photo) {
  const p = data?.property;
  if (!p || !photo) return null;
  // Pending photo (not yet finalized): the image is a base64 data URL kept in
  // the appraisal data. 'upload' photos are uploaded to the parcel page on
  // finalize; 'map' photos (Google Static Map) stay with the report on the
  // user's PC and are never uploaded.
  if (photo.dataUrl) return photo.dataUrl;
  if (photo.source === 'gis' && p.apn) return gisUrl(p.apn);
  if (photo.source === 'upload' && p.apn && photo.file)
    return `/api/parcel-photos/${encodeURIComponent(p.apn)}/${encodeURIComponent(photo.file)}`;
  return null;
}

// Resolves the subject photo list (property.subjectPhotos) to displayable URLs.
// Returns [] when there are no photos.
export function resolveSubjectImageUrls(data) {
  const p = data?.property;
  if (!p) return [];
  const photos = Array.isArray(p.subjectPhotos) ? p.subjectPhotos : [];
  return photos.map((ph) => resolvePhotoUrl(data, ph)).filter(Boolean);
}

// Resolves the subject's explicit photos (uploads and Google maps — never the
// GIS satellite, which belongs to the cover) to displayable URLs. Combines the
// legacy single subjectImage with the subjectPhotos list, deduped.
// Returns [] when there are no explicit photos.
export function resolveSubjectPhotoUrls(data) {
  const p = data?.property;
  if (!p) return [];
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  if (p.subjectImage && p.subjectImage.source !== 'gis') push(resolvePhotoUrl(data, p.subjectImage));
  for (const ph of Array.isArray(p.subjectPhotos) ? p.subjectPhotos : []) {
    if (ph && ph.source !== 'gis') push(resolvePhotoUrl(data, ph));
  }
  return urls;
}

// Resolves the legacy single subjectImage reference to a displayable URL.
// Kept for the cover's satellite fallback and the map sheet.
//   { source: "gis" }              → a GIS marker (composited in the browser)
//   { source: "upload", file }     → /api/parcel-photos/{apn}/{file}
//   legacy base64 data URL         → returned as-is (migration path)
//   null / undefined               → null (no image)
export function resolveSubjectImageUrl(data) {
  const p = data?.property;
  if (!p) return null;
  if (p.subjectImage) return resolvePhotoUrl(data, p.subjectImage);
  if (p.subjectPhotoUrl) return p.subjectPhotoUrl;
  return null;
}

// Resolves the effective cover/subject photo URL, honoring an explicit
// "none" choice. When subjectImage is { source: "none" } the user has
// deliberately removed the photo, so we return null (no GIS fallback).
// Otherwise the GIS parcel map is the default when no image is set.
export function resolveCoverPhotoUrl(data) {
  const p = data?.property;
  if (!p) return null;
  if (p.subjectImage && p.subjectImage.source === 'none') return null;
  return resolveSubjectImageUrl(data) || (p.apn ? gisUrl(p.apn) : null);
}

// --- comp image resolution ----------------------------------------------------
// Comps carry their own photos (comp.photos), keyed by the comp's own APN so a
// comp's satellite/uploaded photos are independent of the subject's.
export function resolveCompPhotoUrl(comp, photo) {
  const apn = String(comp?.parcel || '').trim();
  if (!apn || !photo) return null;
  // Pending photo (not yet finalized): base64 data URL in the appraisal data.
  if (photo.dataUrl) return photo.dataUrl;
  if (photo.source === 'gis') return gisUrl(apn);
  if (photo.source === 'upload' && photo.file)
    return `/api/parcel-photos/${encodeURIComponent(apn)}/${encodeURIComponent(photo.file)}`;
  return null;
}

// Resolves a comp's photo list (comp.photos) to displayable URLs.
export function resolveCompPhotoUrls(comp) {
  const photos = Array.isArray(comp?.photos) ? comp.photos : [];
  return photos.map((ph) => resolveCompPhotoUrl(comp, ph)).filter(Boolean);
}

// Migrate legacy data: strip base64 subjectPhotoUrl, seed the multi-photo list.
// Called on load so old saved appraisals work with the new model. The GIS
// satellite is always available (shown on the cover), so only explicit uploads
// are carried into subjectPhotos.
export function migrateSubjectImage(data) {
  const p = data?.property;
  if (!p) return;
  if (!Array.isArray(p.subjectPhotos)) p.subjectPhotos = [];
  // Carry over a legacy single uploaded photo into the list (deduped).
  if (p.subjectImage && p.subjectImage.source === 'upload' && p.subjectImage.file) {
    const f = p.subjectImage.file;
    if (!p.subjectPhotos.some((ph) => ph && ph.source === 'upload' && ph.file === f)) {
      p.subjectPhotos.push({ source: 'upload', file: f });
    }
  }
  delete p.subjectPhotoUrl;
  delete p.mapImageUrl;
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
  // Multi-parcel portfolio: one appraisal spans multiple parcels. `data` is a
  // live reference to the active parcel (portfolio.parcels[activeParcelIndex])
  // so all existing form/report code keeps working unchanged.
  portfolio: { parcels: [], activeParcelIndex: 0 },
  viewMode: 'parcel', // 'parcel' | 'portfolio'
};
state.portfolio.parcels = [state.data];

export function markDirty() { state.dirty = true; }

export async function saveCurrent() {
  if (state.id === null) {
    const { id } = await api.createAppraisal(portfolioPayload());
    state.id = id;
  } else {
    try {
      await api.updateAppraisal(state.id, portfolioPayload());
    } catch (e) {
      // Stale id: the server row no longer exists (e.g. this WIP was deleted on
      // the server / another machine after we loaded it). The PUT 404s, so fall
      // back to creating a fresh appraisal so the save still succeeds.
      if (e && e.message && e.message.startsWith('404')) {
        const { id } = await api.createAppraisal(portfolioPayload());
        state.id = id;
      } else {
        throw e;
      }
    }
  }
  state.dirty = false;
  return state.id;
}

export async function loadAppraisal(id) {
  const { data } = await api.getAppraisal(id);
  state.id = id;
  applyPortfolio(normalizePortfolio(data));
  state.dirty = false;
}

export function newAppraisal() {
  state.id = null;
  const parcel = createEmptyParcel('');
  state.portfolio.parcels = [parcel];
  state.portfolio.activeParcelIndex = 0;
  state.viewMode = 'parcel';
  state.data = parcel;
  state.dirty = false;
}

// --- multi-parcel portfolio (one appraisal spans multiple parcels) -----------
// `state.data` is a live reference to the active parcel, so in-place form edits
// (form.js resolvePath) always land on the right parcel. The existing "open
// tabs" workspace (which appraisal) is orthogonal to this (which parcel within
// the active appraisal).

function clampIndex(i, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

// Re-point state.data at the active parcel (live reference, not a copy).
function syncActiveData() {
  state.data = state.portfolio.parcels[clampIndex(state.portfolio.activeParcelIndex, state.portfolio.parcels.length)];
}

export function isPortfolio() {
  return state.portfolio.parcels.length > 1;
}

export function activeParcelIndex() {
  return clampIndex(state.portfolio.activeParcelIndex, state.portfolio.parcels.length);
}

// The report mode: a multi-parcel appraisal always presents as a portfolio
// (portfolio cover + standard body sections). `viewMode` is kept for
// serialization/back-compat but no longer drives the UI.
export function reportMode() {
  return isPortfolio() ? 'portfolio' : 'parcel';
}

export function selectParcel(index) {
  state.portfolio.activeParcelIndex = clampIndex(index, state.portfolio.parcels.length);
  state.viewMode = 'parcel';
  syncActiveData();
  markDirty();
}

export function setViewMode(mode) {
  state.viewMode = mode;
  markDirty();
}

export function addParcel(apn) {
  state.portfolio.parcels.push(createEmptyParcel(apn ?? ''));
  state.portfolio.activeParcelIndex = state.portfolio.parcels.length - 1;
  state.viewMode = 'parcel';
  syncActiveData();
  markDirty();
}

export function removeParcel(index) {
  if (state.portfolio.parcels.length <= 1) return; // always keep at least one
  state.portfolio.parcels.splice(index, 1);
  let active = state.portfolio.activeParcelIndex;
  if (index === active) active = 0;
  else if (index < active) active = active - 1;
  state.portfolio.activeParcelIndex = clampIndex(active, state.portfolio.parcels.length);
  syncActiveData();
  markDirty();
}

export function resetActiveParcel() {
  state.portfolio.parcels[activeParcelIndex()] = createEmptyParcel('');
  syncActiveData();
  markDirty();
}

// Serialize the whole portfolio for persistence (server / WIP / IndexedDB).
export function portfolioPayload() {
  return {
    parcels: state.portfolio.parcels,
    activeParcelIndex: state.portfolio.activeParcelIndex,
    viewMode: state.viewMode,
  };
}

// Normalize a stored doc into a portfolio. Accepts either a portfolio
// ({ parcels }) or a legacy single-parcel doc ({ property }).
export function normalizePortfolio(raw) {
  if (raw && Array.isArray(raw.parcels)) {
    const parcels = raw.parcels.map((p) => normalizeParcel(p));
    if (parcels.length === 0) parcels.push(createEmptyParcel(''));
    return {
      parcels,
      activeParcelIndex: clampIndex(raw.activeParcelIndex ?? 0, parcels.length),
      viewMode: raw.viewMode === 'portfolio' ? 'portfolio' : 'parcel',
    };
  }
  return { parcels: [normalizeParcel(raw)], activeParcelIndex: 0, viewMode: 'parcel' };
}

// Apply a normalized portfolio to state (used by load + tab switching).
export function applyPortfolio(pf) {
  state.portfolio.parcels = pf.parcels;
  state.portfolio.activeParcelIndex = pf.activeParcelIndex;
  state.viewMode = pf.viewMode;
  syncActiveData();
  migrateSubjectImage(state.data);
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

// --- local workspace persistence (IndexedDB) ---------------------------------
// The open workspace (all tabs + their data) is persisted to IndexedDB — this
// browser only — on every change so an accidental refresh (F5) restores it.
// This is local crash/refresh recovery, NOT a server copy: no server row is
// created on edit. Only a manual "Save as WIP" or "Finalize" writes to the
// server. The debounced hook is still named scheduleAutosave (it IS an
// autosave — just a local one) so existing call sites keep working.
const IDB_NAME = 'rivco-appraisal';
const IDB_VERSION = 1;
const IDB_STORE = 'workspace';
const IDB_KEY = 'current';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function idbGet(key) {
  const db = await openIdb();
  const out = await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const rq = tx.objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result ?? null);
    rq.onerror = () => reject(rq.error);
  });
  db.close();
  return out;
}
async function idbDel(key) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Snapshot the active tab's current data into its tab record so it survives a
// tab switch without a server write. Keeps the tab's label + dirty flag in sync.
export function snapshotActiveTab() {
  const t = activeTab();
  if (!t) return;
  t.data = state.data;
  t.portfolio = portfolioPayload();
  t.dirty = state.dirty;
  t.apn = state.data?.property?.apn || t.apn;
  t.address = state.data?.property?.address || t.address;
}

// Serialize the open workspace (all tabs + their data) for local persistence.
function workspaceSnapshot() {
  const active = activeTab();
  return {
    tabs: workspace.tabs.map((t) => ({
      key: t.key, id: t.id, apn: t.apn, address: t.address, dirty: t.dirty,
      data: (t.key === active?.key ? state.data : t.data) || null,
      portfolio: (t.key === active?.key ? portfolioPayload() : t.portfolio) || null,
    })),
    activeKey: workspace.activeKey,
    savedAt: new Date().toISOString(),
  };
}

let localSaveTimer = null;

// `force` bypasses the dirty check — workspace structure changes (opening /
// closing tabs) must be persisted even when the active appraisal is clean,
// otherwise a reload restores a stale tab list.
export function scheduleAutosave(force = false) {
  if (!state.dirty && !force) return;
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(runLocalSave, 800);
}

async function runLocalSave() {
  localSaveTimer = null;
  try { await idbPut(IDB_KEY, workspaceSnapshot()); } catch { /* IndexedDB unavailable */ }
}

// Restore the open workspace from IndexedDB (F5 recovery). Returns true if a
// workspace was restored, false if there was nothing to restore.
export async function restoreWorkspaceLocal() {
  try {
    const rec = await idbGet(IDB_KEY);
    if (!rec || !Array.isArray(rec.tabs) || rec.tabs.length === 0) return false;
    workspace.tabs = rec.tabs.map((t) => ({
      key: t.key, id: t.id ?? null, apn: t.apn || '', address: t.address || '',
      dirty: !!t.dirty,
      data: (t.data && t.data.property) ? t.data : null,
      portfolio: t.portfolio || null,
    }));
    // Collapse duplicate APN tabs left by the old tab-dedup bug (several tabs
    // for the same parcel). For each APN keep the tab that was active, else the
    // first; drop the rest. Blank ("New") tabs are left untouched.
    {
      const byApn = new Map();
      for (const t of workspace.tabs) {
        const a = String(t.apn || '').trim();
        if (!a) continue;
        if (!byApn.has(a)) byApn.set(a, []);
        byApn.get(a).push(t);
      }
      const drop = new Set();
      for (const tabs of byApn.values()) {
        if (tabs.length <= 1) continue;
        const keep = tabs.find((t) => t.key === rec.activeKey) || tabs[0];
        for (const t of tabs) if (t !== keep) drop.add(t.key);
      }
      if (drop.size) workspace.tabs = workspace.tabs.filter((t) => !drop.has(t.key));
    }
    const active = workspace.tabs.find((t) => t.key === rec.activeKey) || workspace.tabs[0];
    workspace.activeKey = active.key;
    state.id = active.id ?? null;
    // Prefer the stored portfolio; fall back to the legacy single-parcel data.
    applyPortfolio(normalizePortfolio(active.portfolio || active.data));
    state.dirty = !!active.dirty;
    return true;
  } catch { return false; }
}

// Drop the locally-persisted workspace (e.g. after a clean save/close).
export async function clearLocalWorkspace() {
  try { await idbDel(IDB_KEY); } catch { /* ignore */ }
}

// --- WIP export / import -----------------------------------------------------
// Lossless JSON round-trip of the working appraisal (mirrors the reference
// app's .wip.json). The envelope carries provenance; `data` is the appraisal.
export function exportWip() {
  const payload = {
    app: 'rivco-appraisal',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: portfolioPayload(),
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
  if (!data || typeof data !== 'object') {
    throw new Error('Not a valid WIP file (missing appraisal data)');
  }
  // Accept either a portfolio ({ parcels }) or a legacy single-parcel ({ property }).
  if (!Array.isArray(data.parcels) && !data.property) {
    throw new Error('Not a valid WIP file (missing appraisal data)');
  }
  return normalizePortfolio(data);
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
    sourceReport: '',
    subjectApn: '',
    photoUrl: '',
  };
  for (const f of CSV_NUM_FIELDS) {
    const n = parseFloat(get(CSV_FIELD_MAP[f] ?? [f.toLowerCase()]));
    rec[f] = Number.isFinite(n) ? n : 0;
  }
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

