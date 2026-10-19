// ---------------------------------------------------------------------------
// report.js — right staging: live report preview + PDF export
// ---------------------------------------------------------------------------
import {
  state, computeAppraisal, hasCostData,
  fmtCurrency, fmtCurrencyRounded, fmtNumber, fmtPct, fmtDate, todayISO,
  generateReconciliationNarrative,
} from './core.js';

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

// Letter page wrapper: navy masthead + body + footer (matches original ReportSheet).
function sheet(page, total, content) {
  const p = state.data.property;
  const t = state.tenant;
  const brand = [t.countyName, t.officeName].filter(Boolean).join(' · ');
  return el('div', { class: 'sheet' },
    el('div', { class: 'sheet-masthead' },
      el('div', { class: 'brand' },
        el('img', { class: 'seal', src: t.sealUrl || '/img/seal.svg', alt: '' }),
        el('div', {},
          el('div', { class: 'report-title' }, 'Appraisal Report'),
          brand ? el('div', { class: 'brand-line' }, brand) : null,
        ),
      ),
      el('div', { class: 'dates' },
        el('div', { class: 'd-group' },
          el('div', { class: 'd-label' }, 'Report Date'),
          el('div', { class: 'd-value' }, fmtDate(p.reportDate || todayISO())),
        ),
        el('div', { class: 'd-group' },
          el('div', { class: 'd-label' }, 'Effective Date'),
          el('div', { class: 'd-value' }, fmtDate(p.effectiveDate)),
        ),
      ),
    ),
    el('div', { class: 'sheet-body' }, content),
    el('div', { class: 'sheet-footer' },
      el('div', { class: 'f-row' },
        el('span', {}, `Prepared by ${p.appraiser || '—'}${p.appraiserLicense ? ' · ' + p.appraiserLicense : ''}`),
        el('span', {}, `Page ${page} of ${total}`),
      ),
      el('div', { class: 'f-conf' }, `${p.client || 'Confidential'} — Confidential · For official use only`),
    ),
  );
}

function heading(text) {
  return el('h2', { class: 'sheet-h' }, text);
}

function kv(pairs) {
  return el('div', { class: 'kv' },
    pairs.filter(([, v]) => v !== '' && v != null).map(([k, v]) =>
      el('div', { class: 'kv-row' }, el('span', { class: 'kv-k' }, k), el('span', { class: 'kv-v' }, v))),
  );
}

function table(headers, rows) {
  return el('table', { class: 'report-table' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c ?? '—'))))),
  );
}

const ADJ_KEYS = ['adjBuildingSize','adjLocation','adjCornerSite','adjAge','adjQuality','adjCondition','adjTenantsUse','adjOccupancy','adjLandBldgRatio','adjFreeway','adjMarketConditions','adjConditionOfSale'];

function compRow(c) {
  const unadjSF = c.buildingArea > 0 ? c.price / c.buildingArea : 0;
  const net = ADJ_KEYS.reduce((s, f) => s + (Number(c[f]) || 0), 0);
  const adjSF = unadjSF * (1 + net / 100);
  return [
    c.address || c.parcel, fmtDate(c.saleDate), fmtCurrency(c.price),
    fmtNumber(c.buildingArea), fmtNumber(unadjSF), fmtPct(net), fmtNumber(adjSF),
    c.isArmsLength ? 'Adj.' : 'Ind.',
  ];
}

// --- sheets ------------------------------------------------------------------

function coverSheet(d, comp) {
  const t = state.tenant;
  const p = d.property;
  return el('div', { class: 'cover' },
    el('div', { class: 'cover-county' }, t.countyName || t.county || '—'),
    el('div', { class: 'cover-office' }, t.officeName || 'Office of the Assessor'),
    el('div', { class: 'cover-value' }, fmtCurrencyRounded(comp.totalAssessed)),
    el('div', { class: 'cover-value-label' }, 'Total Assessed Value'),
    kv([
      ['Property', p.address],
      ['APN', p.apn],
      ['City', p.city],
      ['Legal Description', p.legalDescription],
      ['Effective Date', fmtDate(p.effectiveDate)],
      ['Report Date', fmtDate(p.reportDate)],
      ['Appraiser', p.appraiser],
      ['License', p.appraiserLicense],
      ['Purpose', p.purpose],
      ['Client', p.client],
    ]),
  );
}

function salesSheet(d, comp) {
  const rows = d.sales.comparables.map(compRow);
  return el('div', {},
    heading('Sales Comparison Approach'),
    table(['Comp', 'Sale Date', 'Price', 'Bldg SF', 'Unadj $/SF', 'Net Adj', 'Adj $/SF', 'Type'], rows),
    el('div', { class: 'calc-strip' },
      el('span', {}, `Correlated $/SF: ${fmtNumber(comp.sales.correlatedSF)}`),
      el('span', {}, `Subject SF: ${fmtNumber(comp.sales.subjectSF)}`),
      el('span', { class: 'strong' }, `Value by Sales: ${fmtCurrency(comp.sales.valueBySales)}`),
    ),
    d.sales.remarks ? el('p', { class: 'notes' }, d.sales.remarks) : null,
  );
}

function incomeSheet(d, comp) {
  const i = comp.income;
  return el('div', {},
    heading('Income Approach'),
    kv([
      ['Rent Type', d.income.rentType],
      ['PGI ($/SF/mo)', fmtNumber(d.income.pgiPerSf)],
      ['Gross Floor Area', `${fmtNumber(d.improvements.primary.grossFloorArea)} SF`],
      ['Total Potential Gross Income', fmtCurrency(i.totalPgi)],
      [`Less: Vacancy (${fmtPct(d.income.vacancyPct)})`, `(${fmtCurrency(i.vacancyLoss)})`],
      [`Less: Collection Loss (${fmtPct(d.income.collectionLossPct)})`, `(${fmtCurrency(i.collectionLoss)})`],
      ['Effective Gross Income', fmtCurrency(i.effectiveGrossIncome)],
      [`Less: Operating Expenses (${fmtPct(d.income.operatingExpensePct)})`, `(${fmtCurrency(i.operatingExpenses)})`],
      ['Net Operating Income', fmtCurrency(i.netOperatingIncome)],
      [`Capitalization Rate (${fmtPct(d.income.capRate)})`, ''],
    ]),
    el('div', { class: 'value-line' }, `Value by Income: ${fmtCurrency(i.valueByIncome)}`),
    d.income.incomeNotes ? el('p', { class: 'notes' }, d.income.incomeNotes) : null,
  );
}

function costSheet(d, comp) {
  const c = comp.cost;
  const imp = d.improvements.primary;
  return el('div', {},
    heading('Cost Approach'),
    kv([
      ['Building', imp.name],
      ['Gross Floor Area', `${fmtNumber(imp.grossFloorArea)} SF`],
      ['Unit Cost ($/SF)', fmtNumber(imp.unitCost)],
      ['Cost of New Improvements', fmtCurrency(c.costNewImprovements)],
      [`Less: Physical Depreciation (${fmtPct(d.cost.physicalDepreciationPct)})`, `(${fmtCurrency(c.physicalDepreciation)})`],
      ['Less: Functional Depreciation', `(${fmtCurrency(d.cost.functionalDepreciation)})`],
      ['Less: Economic Depreciation', `(${fmtCurrency(d.cost.economicDepreciation)})`],
      ['Depreciated Cost of Improvements', fmtCurrency(c.depreciatedCost)],
      ['Plus: Land Value', fmtCurrency(d.land.landValue)],
    ]),
    el('div', { class: 'value-line' }, `Value by Cost: ${fmtCurrency(c.valueByCost)}`),
    d.cost.costNotes ? el('p', { class: 'notes' }, d.cost.costNotes) : null,
  );
}

function reconciliationSheet(d, comp) {
  const includeCost = hasCostData(d);
  const r = d.reconciliation;
  const narrative = generateReconciliationNarrative({
    costValue: comp.cost.valueByCost, costWeight: r.costWeight, includeCost,
    incomeValue: comp.income.valueByIncome, incomeWeight: r.incomeWeight,
    salesValue: comp.sales.valueBySales, salesWeight: r.salesWeight,
    weightedValue: comp.reconciliation.weightedValue,
    finalValue: r.finalValue || comp.reconciliation.weightedValue,
  });
  return el('div', {},
    heading('Reconciliation of Value'),
    table(
      ['Approach', 'Indicated Value', 'Weight'],
      [
        ...(includeCost ? [['Cost', fmtCurrency(comp.cost.valueByCost), fmtPct(r.costWeight, 0)]] : []),
        ['Income', fmtCurrency(comp.income.valueByIncome), fmtPct(r.incomeWeight, 0)],
        ['Sales Comparison', fmtCurrency(comp.sales.valueBySales), fmtPct(r.salesWeight, 0)],
      ],
    ),
    el('div', { class: 'calc-strip' },
      el('span', {}, `Total Weight: ${fmtPct(comp.reconciliation.totalWeight, 0)}`),
      el('span', {}, `Weighted Average: ${fmtCurrency(comp.reconciliation.weightedValue)}`),
    ),
    el('div', { class: 'final-value' },
      el('div', { class: 'final-value-label' }, 'Final Reconciled Market Value'),
      el('div', { class: 'final-value-num' }, fmtCurrency(r.finalValue || comp.reconciliation.weightedValue)),
    ),
    narrative ? el('p', { class: 'narrative' }, narrative) : null,
    r.rationale ? el('p', { class: 'notes' }, r.rationale) : null,
  );
}

// --- render ------------------------------------------------------------------

export function renderReport() {
  const root = document.getElementById('report-root');
  if (!root) return;
  const d = state.data;
  const comp = computeAppraisal(d);
  const contents = [
    coverSheet(d, comp),
    salesSheet(d, comp),
    incomeSheet(d, comp),
    ...(hasCostData(d) ? [costSheet(d, comp)] : []),
    reconciliationSheet(d, comp),
  ];
  const total = contents.length;
  root.replaceChildren(...contents.map((c, i) =>
    el('div', { class: 'sheet-scale' }, sheet(i + 1, total, c)),
  ));
  const meta = document.querySelector('.staging-toolbar .st-meta');
  if (meta) meta.textContent = `${total} sheets · 8.5×11`;
  fitSheets();
  updateTopBar();
}

// --- zoom (mirrors the original RightStaging auto-fit / manual zoom) ---
const SHEET_W = 816;
const SHEET_H = 1056;
let manualZoom = null;

export function getZoom() {
  if (manualZoom != null) return manualZoom;
  const pane = document.querySelector('.pane-right');
  if (!pane) return 1;
  return Math.min(1.4, Math.max(0.2, (pane.clientWidth - 32) / SHEET_W));
}
export function zoomBy(delta) {
  manualZoom = Math.min(1.4, Math.max(0.3, Math.round((getZoom() + delta) * 100) / 100));
  fitSheets();
}
export function zoomFit() {
  manualZoom = null;
  fitSheets();
}

// Scale each sheet to fit the pane width (like the original zoom wrapper):
// wrapper is exactly the scaled size, inner sheet scales from top-left.
export function fitSheets() {
  const s = getZoom();
  document.querySelectorAll('#report-root .sheet-scale').forEach((w) => {
    const sh = w.firstElementChild;
    if (!sh) return;
    w.style.width = `${SHEET_W * s}px`;
    w.style.height = `${SHEET_H * s}px`;
    sh.style.width = `${SHEET_W}px`;
    sh.style.transform = `scale(${s})`;
    sh.style.transformOrigin = 'top left';
  });
  const pct = document.querySelector('.staging-toolbar .zoom-pct');
  if (pct) pct.textContent = `${Math.round(s * 100)}%`;
}

// Live top bar: property headline + total assessed (matches original TopBar).
function updateTopBar() {
  const p = state.data.property;
  const comp = computeAppraisal(state.data);
  const addr = document.getElementById('tb-addr');
  const sub = document.getElementById('tb-sub');
  const val = document.getElementById('tb-value');
  if (addr) addr.textContent = [p.address, p.city].map((v) => (v ?? '').trim()).filter(Boolean).join(', ') || '—';
  if (sub) sub.textContent = `APN ${p.apn || '—'} · Effective ${fmtDate(p.effectiveDate)}`;
  if (val) val.textContent = fmtCurrency(comp.totalAssessed);
}

// --- PDF ---------------------------------------------------------------------

export async function exportPDF() {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const sheets = document.querySelectorAll('#report-root .sheet');
  // Capture at full size: temporarily drop the preview scale.
  const saved = [];
  sheets.forEach((s) => saved.push([s, s.style.transform]));
  sheets.forEach((s) => { s.style.transform = 'none'; });
  try {
    let first = true;
    for (const s of sheets) {
      const canvas = await html2canvas(s, { scale: 2, backgroundColor: '#ffffff' });
      const imgW = 612;
      const imgH = (canvas.height * imgW) / canvas.width;
      const imgData = canvas.toDataURL('image/png');
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(imgData, 'PNG', 0, 0, imgW, imgH);
    }
  } finally {
    saved.forEach(([s, t]) => { s.style.transform = t; });
    fitSheets();
  }
  const p = state.data.property;
  const name = `${p.apn || 'appraisal'}_${p.reportDate || ''}`.replace(/[^\w\-]/g, '_');
  pdf.save(`${name}.pdf`);
}

