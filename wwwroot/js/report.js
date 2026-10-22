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
        el('img', { class: 'seal', src: t.sealUrl || '/img/seal.png', alt: '' }),
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
  const l = d.land;
  const { primary, outbuildings } = d.improvements;
  const totalGfa = (primary.grossFloorArea || 0) + outbuildings.reduce((s, o) => s + (o.grossFloorArea || 0), 0);
  const landAcres = l.acres > 0 ? l.acres : (l.siteAreaSqFt / 43560);

  // Property Characteristics
  const chars = el('div', { class: 'cs-section' },
    el('div', { class: 'cs-heading' }, 'Property Characteristics'),
    el('div', { class: 'cs-addr' }, [p.address, p.city, p.zip].filter(Boolean).join(', ') || '—'),
    p.apn ? el('div', { class: 'cs-apn' }, `APN: ${p.apn}`) : null,
    el('div', { class: 'cs-meta' },
      el('span', {}, `Site: ${l.siteAreaSqFt > 0 ? `${fmtNumber(l.siteAreaSqFt)} sq ft (${landAcres.toFixed(2)} ac)` : '—'}`),
      l.zoning ? el('span', {}, `Zoning: ${l.zoning}`) : null,
      el('span', {}, `Building: ${totalGfa > 0 ? `${fmtNumber(totalGfa)} sq ft` : '—'}`),
      el('span', {}, `Year Built: ${primary.yearBuilt || '—'}`),
    ),
  );

  // 2x2 image grid
  const imgCell = (src, label) => src
    ? el('img', { src, alt: label })
    : el('div', { class: 'no-img' }, `No ${label.toLowerCase()} available.`);
  const images = el('div', { class: 'cover-images' },
    imgCell(p.mapImageUrl, 'map'),
    imgCell(p.subjectPhotoUrl, 'image'),
    imgCell(p.subjectPhotoUrl2, 'image'),
    imgCell(p.subjectPhotoUrl3, 'image'),
  );

  // Summary of Value
  const valBox = (label, val) => el('div', { class: 'cs-val-box' },
    el('div', { class: 'cs-val-label' }, label),
    el('div', { class: 'cs-val-num' }, fmtCurrencyRounded(val)),
  );
  const costBox = d.cost.includeInReport ? valBox('Cost', comp.cost.valueByCost) : null;
  const summary = el('div', { class: 'cs-section' },
    el('div', { class: 'cs-heading' }, 'Summary of Value'),
    el('div', { class: `cs-val-grid${costBox ? ' c3' : ' c2'}` },
      valBox('Sales', comp.sales.valueBySales),
      valBox('Income', comp.income.valueByIncome),
      costBox,
    ),
    el('div', { class: 'cs-callout' },
      el('div', { class: 'cs-callout-left' },
        el('div', { class: 'cs-callout-label' }, 'Final Reconciled Market Value'),
        el('div', { class: 'cs-callout-sub' }, `As of ${fmtDate(p.effectiveDate)}`),
      ),
      el('div', { class: 'cs-callout-val' }, fmtCurrencyRounded(d.reconciliation.finalValue || comp.reconciliation.weightedValue)),
    ),
  );

  // Certification
  const cert = el('div', { class: 'cs-section cs-cert' },
    el('div', { class: 'cs-heading' }, 'Certification'),
    d.reconciliation.rationale ? el('p', { class: 'cs-rationale' }, d.reconciliation.rationale) : null,
    el('div', { class: 'cs-sig' },
      el('div', {},
        el('div', { class: 'cs-sig-line' }),
        el('div', { class: 'cs-sig-label' }, `${p.appraiser || '—'} · ${p.appraiserLicense || ''}`),
      ),
      el('div', {},
        el('div', { class: 'cs-sig-line' }),
        el('div', { class: 'cs-sig-label' }, 'Date'),
      ),
    ),
  );

  return el('div', { class: 'cover' }, chars, images, summary, cert);
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

function subjectPropertySheet(d) {
  const p = d.property;
  const l = d.land;
  const b = d.improvements.primary;
  const gfa = b.grossFloorArea || 0;
  const psf = gfa > 0 && p.salePrice > 0 ? p.salePrice / gfa : 0;
  return [
    heading('Subject Property'),
    table(
      ['Parcel', 'Eff. Date', 'Sale Price', 'Sq Ft', '$/Sq Ft', 'Location'],
      [[
        p.apn || '—',
        fmtDate(p.effectiveDate),
        fmtCurrency(p.salePrice),
        gfa > 0 ? fmtNumber(gfa) : '—',
        psf > 0 ? fmtCurrency(psf) : '—',
        [p.address, p.city].filter(Boolean).join(', ') || '—',
      ]],
    ),
    heading('Property Description'),
    kv([
      ['Address', [p.address, p.city, p.zip].filter(Boolean).join(', ')],
      ['APN', p.apn],
      ['Site Area', l.siteAreaSqFt > 0 ? `${fmtNumber(l.siteAreaSqFt)} SF` : ''],
      ['Acres', l.acres > 0 ? String(l.acres) : ''],
      ['Zoning', l.zoning],
      ['Building Area', gfa > 0 ? `${fmtNumber(gfa)} SF` : ''],
      ['Year Built', b.yearBuilt],
      ['Quality', b.quality],
      ['Condition', b.condition],
    ]),
  ];
}

function compDetailSheets(d) {
  const comps = (d.sales.comparables || []).filter((c) => c.selected !== false);
  if (comps.length === 0) return [];
  return comps.map((c, i) => {
    const unadjSF = c.buildingArea > 0 ? c.price / c.buildingArea : 0;
    const net = ADJ_KEYS.reduce((s, f) => s + (Number(c[f]) || 0), 0);
    const adjSF = unadjSF * (1 + net / 100);
    const adjRows = ADJ_KEYS
      .map((f) => [f.replace('adj', '').replace(/([A-Z])/g, ' $1').trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()), Number(c[f]) || 0])
      .filter(([, v]) => v !== 0);
    return [
      heading(`Comparable #${i + 1}`),
      kv([
        ['Parcel', c.parcel],
        ['Address', [c.address, c.city].filter(Boolean).join(', ')],
        ['Sale Date', fmtDate(c.saleDate)],
        ['Sale Price', fmtCurrency(c.price)],
        ['Age', c.age],
        ['Quality', c.quality],
        ['Condition', c.condition],
        ['Land Area (Acres)', c.landArea > 0 ? String(c.landArea) : ''],
        ['Building Area (SF)', c.buildingArea > 0 ? fmtNumber(c.buildingArea) : ''],
        ['Land to Bldg. Ratio', c.landArea > 0 && c.buildingArea > 0 ? (c.buildingArea / c.landArea).toFixed(2) : ''],
      ]),
      heading('Adjustments'),
      adjRows.length > 0
        ? table(['Adjustment', 'Amount'], [...adjRows, ['Net Adjustment', net]])
        : kv([['No adjustments', '—']]),
      heading('Result'),
      kv([
        ['Unadjusted $/SF', unadjSF > 0 ? fmtCurrency(unadjSF) : '—'],
        ['Net Adjustment', `${net > 0 ? '+' : ''}${net}%`],
        ['Adjusted $/SF', adjSF > 0 ? fmtCurrency(adjSF) : '—'],
      ]),
    ];
  });
}

function mapSheet(d) {
  const p = d.property;
  const comps = (d.sales.comparables || []).filter((c) => c.selected !== false);
  const img = p.mapImageUrl
    ? el('div', { class: 'img-cell' }, el('img', { src: p.mapImageUrl, alt: 'Map' }))
    : el('div', { class: 'img-cell empty' }, el('div', { class: 'img-cap' }, 'No map'));
  return [
    heading('Map of Comparable Sales'),
    img,
    heading('Locations'),
    table(
      ['#', 'Parcel', 'Address'],
      [
        ['S', p.apn || '—', [p.address, p.city].filter(Boolean).join(', ') || '—'],
        ...comps.map((c, i) => [String(i + 1), c.parcel || '—', [c.address, c.city].filter(Boolean).join(', ') || '—']),
      ],
    ),
  ];
}

export function renderReport() {
  const root = document.getElementById('report-root');
  if (!root) return;
  const d = state.data;
  const comp = computeAppraisal(d);
  const contents = [
    coverSheet(d, comp),
    subjectPropertySheet(d, comp),
    salesSheet(d, comp),
    ...compDetailSheets(d, comp),
    mapSheet(d, comp),
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

