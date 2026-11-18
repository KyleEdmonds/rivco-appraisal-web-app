// ---------------------------------------------------------------------------
// core.test.js — unit tests for the pure logic in wwwroot/js/core.js
//
// Run with:  npm test   (→  node --test test/)
//
// core.js imports cleanly in Node with no DOM shim (its browser globals are
// only touched inside function bodies), so we import it directly.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAppraisal, computeSales, computeCost, computeIncome, computeReconciliation,
  rankCompsBySimilarity, scoreComp,
  fmtCurrency, fmtNumber, fmtPct, fmtAcres, fmtAcresNum, fmtCurrencyRounded,
  roundTo1000, roundTo5000, titleCase, normalizeCity, fmtDate, fmtDateMDY, todayISO,
  hasCostData, hasIncomeData,
} from '../wwwroot/js/core.js';

// --- fixtures --------------------------------------------------------------

// A complete, minimal appraisal data object. Every branch the calculators read
// is present so the pure functions never hit an undefined property.
function makeData(overrides = {}) {
  return {
    property: { apn: '123-456', city: 'Corona', address: '123 Main St' },
    improvements: {
      primary: { grossFloorArea: 1000, unitCost: 100, yearBuilt: 2000 },
      outbuildings: [],
    },
    land: { acres: 1, landValue: 50000, siteAreaSqFt: 43560 },
    cost: { physicalDepreciationPct: 0, functionalDepreciation: 0, economicDepreciation: 0, includeInReport: false },
    income: { pgiPerSf: 0, vacancyPct: 0, collectionLossPct: 0, operatingExpensePct: 0, capRate: 0 },
    sales: { comparables: [] },
    reconciliation: { costWeight: 0, incomeWeight: 0, salesWeight: 100, finalValue: 0 },
    cover: { totalPosted: 0 },
    ...overrides,
  };
}

// A comp with the given building area / price and (optionally) adjustments.
function makeComp({ buildingArea = 1000, price = 100000, adj = {}, city = 'Corona', age = 25, saleDate = '2024-01-01' } = {}) {
  return {
    buildingArea, price, city, age, saleDate,
    adjBuildingSize: 0, adjLocation: 0, adjCornerSite: 0, adjAge: 0, adjQuality: 0,
    adjCondition: 0, adjTenantsUse: 0, adjOccupancy: 0, adjLandBldgRatio: 0,
    adjFreeway: 0, adjMarketConditions: 0, adjConditionOfSale: 0,
    ...adj,
  };
}

// --- formatters -------------------------------------------------------------

test('fmtCurrency formats USD with no cents', () => {
  assert.equal(fmtCurrency(1234567), '$1,234,567');
  assert.equal(fmtCurrency(0), '$0');
  assert.equal(fmtCurrency('1000'), '$1,000'); // coerces numeric strings
});

test('fmtNumber adds thousands separators', () => {
  assert.equal(fmtNumber(1234567), '1,234,567');
  assert.equal(fmtNumber(0), '0');
});

test('fmtPct appends % with configurable precision', () => {
  assert.equal(fmtPct(12.345), '12.3%');
  assert.equal(fmtPct(12.345, 2), '12.35%');
  assert.equal(fmtPct(0), '0.0%');
});

test('fmtAcres / fmtAcresNum render acreage', () => {
  assert.equal(fmtAcres(1.5), '1.5000 ac');
  assert.equal(fmtAcresNum(1.5), '1.5');
  assert.equal(fmtAcresNum(1234.5678), '1,234.568');
});

test('roundTo1000 / roundTo5000 / fmtCurrencyRounded', () => {
  assert.equal(roundTo1000(12345), 12000);
  assert.equal(roundTo5000(12345), 10000);
  assert.equal(fmtCurrencyRounded(12345), '$12,000');
});

test('titleCase converts ALL-CAPS to Title Case, leaves mixed case alone', () => {
  assert.equal(titleCase('363 AMERICAN CIR'), '363 American Cir');
  assert.equal(titleCase('Light Industrial'), 'Light Industrial');
  assert.equal(titleCase(''), '');
  assert.equal(titleCase(null), '');
});

test('normalizeCity strips district/year suffixes and title-cases', () => {
  assert.equal(normalizeCity('CORONA NORCO USD'), 'Corona');
  assert.equal(normalizeCity('MORENO VALLEY USD'), 'Moreno Valley');
  assert.equal(normalizeCity('PERRIS 2017'), 'Perris');
  assert.equal(normalizeCity(''), '');
});

test('fmtDate / fmtDateMDY parse ISO dates', () => {
  assert.equal(fmtDate('2024-01-15'), 'Jan 15, 2024');
  assert.equal(fmtDate(''), '—');
  assert.equal(fmtDateMDY('2024-1-5'), '01/05/2024');
  assert.equal(fmtDateMDY(''), '');
});

test('todayISO returns a valid local YYYY-MM-DD', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(new Date(todayISO()).getTime()));
});

// --- calculators -------------------------------------------------------------

test('computeCost sums improvements, applies depreciation, adds land', () => {
  const data = makeData({
    improvements: {
      primary: { grossFloorArea: 1000, unitCost: 100 },
      outbuildings: [{ grossFloorArea: 500, unitCost: 50 }],
    },
    cost: { physicalDepreciationPct: 10, functionalDepreciation: 5000, economicDepreciation: 2500 },
  });
  const r = computeCost(data);
  assert.equal(r.costNewImprovements, 125000); // 1000*100 + 500*50
  assert.equal(r.physicalDepreciation, 12500);  // 10% of 125000
  assert.equal(r.totalDepreciation, 20000);     // 12500 + 5000 + 2500
  assert.equal(r.depreciatedCost, 105000);
  assert.equal(r.valueByCost, 155000);          // 50000 land + 105000
});

test('computeIncome walks the income schedule to value', () => {
  const data = makeData({
    income: { pgiPerSf: 1, vacancyPct: 5, collectionLossPct: 2, operatingExpensePct: 30, capRate: 5 },
  });
  const r = computeIncome(data);
  assert.equal(r.totalPgi, 12000);              // 1 * 1000 * 12
  assert.equal(r.vacancyLoss, 600);             // 5% of 12000
  assert.equal(r.collectionLoss, 228);          // 2% of 11400
  assert.equal(r.effectiveGrossIncome, 11172);
  assert.equal(r.operatingExpenses, 3351.6);    // 30% of 11172
  assert.equal(r.netOperatingIncome, 7820.4);
  assert.equal(r.valueByIncome, 156408);        // 7820.4 / 0.05
});

test('computeSales correlates adjusted $/SF to the subject (and counts comps)', () => {
  const data = makeData({ sales: { comparables: [makeComp({ buildingArea: 1000, price: 100000 })] } });
  const r = computeSales(data);
  assert.equal(r.count, 1);                      // guards the old `pool.length` bug
  assert.equal(r.correlatedSF, 100);
  assert.equal(r.valueBySales, 100000);          // 100 $/SF * 1000 SF
  assert.equal(r.subjectSF, 1000);
});

test('computeSales applies net comparability adjustments', () => {
  const data = makeData({
    sales: { comparables: [makeComp({ buildingArea: 1000, price: 100000, adj: { adjMarketConditions: 10, adjConditionOfSale: -5 } })] },
  });
  const r = computeSales(data);
  assert.equal(r.correlatedSF, 105);             // 100 * (1 + 5/100)
  assert.equal(r.valueBySales, 105000);
});

test('computeReconciliation weights the approaches by their weights', () => {
  const data = makeData({ sales: { comparables: [makeComp()] } });
  const cost = computeCost(data);
  const income = computeIncome(data);
  const sales = computeSales(data);
  const r = computeReconciliation(data, cost, income, sales);
  assert.equal(r.totalWeight, 100);              // only salesWeight is set
  assert.equal(r.weightedValue, 100000);         // sales value, rounded to 1000
});

test('computeAppraisal returns a non-zero total for a valid appraisal', () => {
  const data = makeData({ sales: { comparables: [makeComp({ buildingArea: 1000, price: 100000 })] } });
  const r = computeAppraisal(data);
  assert.equal(r.sales.count, 1);
  assert.equal(r.sales.valueBySales, 100000);
  assert.equal(r.reconciliation.weightedValue, 100000);
  assert.equal(r.totalAssessed, 100000);         // roundTo5000(weightedValue)
  assert.equal(r.landAcres, 1);
});

test('computeAppraisal prefers the posted total when cover.totalPosted is set', () => {
  const data = makeData({
    sales: { comparables: [makeComp()] },
    cover: { totalPosted: 250000 },
  });
  assert.equal(computeAppraisal(data).totalAssessed, 250000);
});

test('computeAppraisal degrades to zeros on malformed input (no throw)', () => {
  const r = computeAppraisal({});
  assert.equal(r.totalAssessed, 0);
  assert.equal(r.sales.count, 0);
});


// --- comp similarity ---------------------------------------------------------

test('scoreComp ranks an identical comp far above a dissimilar one', () => {
  const subject = makeData();
  const identical = makeComp({ buildingArea: 1000, price: 100000, city: 'Corona', age: 25 });
  const dissimilar = makeComp({ buildingArea: 5000, price: 500000, city: 'Perris', age: 50 });
  const sIdentical = scoreComp(subject, identical);
  const sDissimilar = scoreComp(subject, dissimilar);
  assert.ok(sIdentical > sDissimilar, `expected ${sIdentical} > ${sDissimilar}`);
  assert.ok(sIdentical >= 0 && sIdentical <= 100);
  assert.ok(sDissimilar >= 0 && sDissimilar <= 100);
});

test('rankCompsBySimilarity sorts best-first and keeps scores in [0,100]', () => {
  const subject = makeData();
  const pool = [
    makeComp({ buildingArea: 5000, price: 500000, city: 'Perris', age: 50, saleDate: '2023-01-01' }),
    makeComp({ buildingArea: 1000, price: 100000, city: 'Corona', age: 25, saleDate: '2024-01-01' }),
  ];
  const ranked = rankCompsBySimilarity(subject, pool);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].record.buildingArea, 1000); // the matching comp ranks first
  for (const { score } of ranked) assert.ok(score >= 0 && score <= 100);
  assert.ok(ranked[0].score >= ranked[1].score);     // non-increasing
});

test('rankCompsBySimilarity breaks ties by most recent saleDate', () => {
  const subject = makeData();
  const a = makeComp({ buildingArea: 1000, price: 100000, city: 'Corona', age: 25, saleDate: '2023-01-01' });
  const b = makeComp({ buildingArea: 1000, price: 100000, city: 'Corona', age: 25, saleDate: '2024-01-01' });
  const ranked = rankCompsBySimilarity(subject, [a, b]);
  assert.equal(ranked[0].record.saleDate, '2024-01-01'); // newer first
});

// --- approach "used" predicates ---------------------------------------------

test('hasCostData is true only when cost data is actually present', () => {
  assert.equal(hasCostData(makeData()), false);
  assert.equal(hasCostData(makeData({ cost: { includeInReport: true } })), true);
  assert.equal(hasCostData(makeData({ cost: { physicalDepreciationPct: 10 } })), true);
  assert.equal(hasCostData(makeData({ reconciliation: { costWeight: 50 } })), true);
});

test('hasIncomeData requires both a PGI rate and building area', () => {
  assert.equal(hasIncomeData(makeData()), false);
  assert.equal(hasIncomeData(makeData({ income: { pgiPerSf: 1 } })), true);
  assert.equal(hasIncomeData(makeData({
    income: { pgiPerSf: 1 },
    improvements: { primary: { grossFloorArea: 0 } },
  })), false);
});

