// ---------------------------------------------------------------------------
// report.js — right staging: live report preview (print via window.print())
// ---------------------------------------------------------------------------
import {
  el, refreshTopBar, state, computeAppraisal, hasCostData, hasIncomeData,
  fmtCurrency, fmtCurrencyRounded, fmtNumber, fmtPct, fmtAcresNum, titleCase, normalizeCity, fmtDate, todayISO,
  generateReconciliationNarrative, resolveSubjectImageUrl,
  resolveSubjectPhotoUrls, resolveCoverPhotoUrl, resolveCompPhotoUrls, photoImg,
  computePortfolioAggregate, reportMode,
} from './core.js';
import { compositeParcelMap } from './mapimg.js';

// Letter page wrapper: navy masthead + body + footer (matches original ReportSheet).
function reportTitle(d) {
  const caseType = d.property.caseType || 'transfer';
  if (caseType === 'appeal') return 'Property Appeal Valuation Report';
  if (caseType === 'stipulation') return 'Proposed Stipulation Valuation Report';
  if (caseType === 'general') return 'Property Valuation Report';
  return 'Transfer Valuation Report';
}
function sheet(page, total, content) {
  const p = state.data.property;
  const t = state.tenant;
  const brand = `${t.countyName || 'County of Riverside'} - ${t.officeName || 'Office of the Assessor'}`;
  return el('div', { class: 'sheet' },
    el('div', { class: 'sheet-masthead' },
      el('div', { class: 'brand' },
        el('img', { class: 'seal', src: t.sealUrl || '/img/seal.png', alt: '' }),
        el('div', {},
          el('div', { class: 'report-title' }, reportTitle(state.data)),
          el('div', { class: 'brand-line' }, brand),
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
        el('span', {}, p.appraiserId ? `Prepared by Appraiser #${p.appraiserId}` : 'Prepared by Appraiser'),
        el('span', {}, `Page ${page} of ${total}`),
      ),
      el('div', { class: 'f-conf' }, p.client || ''),
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
// Key + display label for each adjustment (mirrors form.js ADJ_FIELDS) — used by
// the full sales comparison grid below.
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
// Building-related adjustments — dropped from the grid (and the net total) when
// the subject is vacant land, since there is no building to compare.
const BUILDING_ADJ = new Set(['adjBuildingSize', 'adjAge', 'adjQuality', 'adjCondition', 'adjLandBldgRatio']);

// --- sheets ------------------------------------------------------------------

// --- unified section boxes (shared by the cover and the body sheets) ---------
// A navy-header box over a label/value grid. The cover and the subject sheet
// both build from these so they read as one consistent design language.
function covField(label, value, big = false) {
  return el('div', { class: 'cov-field' },
    el('div', { class: 'cov-k' }, label),
    el('div', { class: big ? 'cov-v cov-v-lg' : 'cov-v' }, value || '—'),
  );
}
function covBox(title, body) {
  return el('div', { class: 'cov-box' },
    el('header', {}, title),
    el('div', { class: 'cov-body' }, body),
  );
}
function covGrid(fields) {
  return el('div', { class: 'cov-grid' }, ...fields);
}

// Vacant land has no building, so building-related fields (building area,
// year built, quality, condition) are omitted from the report.
function isVacantLand(type) {
  return /vacant/i.test(String(type || ''));
}

// --- cover sheets (case-specific, mirror the county PDF covers) --------------

function coverSheet(d, total) {
  const caseType = d.property.caseType || 'transfer';
  if (caseType === 'appeal') return appealCover(d);
  if (caseType === 'stipulation') return stipulationCover(d, total);
  if (caseType === 'general') return generalCover(d, total);
  return transferCover(d, total);
}

// Transfer cover: unified section boxes (Transfer Details, Appraiser Notes,
// Property Identification, Valuation) + a full-width parcel photo.
// The navy masthead (kept via sheet()) stays on top.
function transferCover(d, total) {
  const p = d.property;
  const imp = d.improvements.primary;
  const land = d.land;

  // Shared building blocks (see covField/covBox/covGrid above).
  const field = covField;
  const box = covBox;
  const grid = covGrid;

  // Transfer Details.
  const transferDetails = box('Transfer Details', grid([
    field('Date of Transfer', fmtDate(p.effectiveDate)),
    field('Document Number', p.transferDocumentNumber),
    field('Ratio Code', p.ratioCode),
  ]));

  // Property Identification — no quality / condition / zoning on the cover.
  // Building-related fields are omitted for vacant land.
  const vacant = isVacantLand(imp.type);
  const propertyId = box('Property Identification', grid([
    field('APN', p.apn),
    field('Address', titleCase(p.address)),
    field('City', normalizeCity(p.city)),
    field('Property Type', imp.type),
    !vacant ? field('Year Built', imp.yearBuilt ? String(imp.yearBuilt) : '') : null,
    !vacant && imp.yearBuilt ? field('Effective Age', p.effectiveDate ? String(parseInt(String(p.effectiveDate).slice(0, 4), 10) - imp.yearBuilt) : '') : null,
    !vacant ? field('Building Area', imp.grossFloorArea > 0 ? `${fmtNumber(imp.grossFloorArea)} SF` : '') : null,
    field('Site Area', land.acres > 0 ? `${land.acres.toFixed(2)} ac` : (land.siteAreaSqFt > 0 ? `${fmtNumber(land.siteAreaSqFt)} SF` : '')),
  ].filter(Boolean)));

  // Per-unit value: $/SF when there's building area, $/Acre for vacant land.
  // Only populated when the amount is present. `unit` is the label suffix
  // (e.g. "/ SF" or "$/SF"); the acre variant swaps the trailing unit word.
  const gfa = imp.grossFloorArea || 0;
  const acres = land.acres || 0;
  const perUnit = (baseLabel, amount, unit = '/ SF') => {
    const acreUnit = unit.replace(/SF$/, 'Acre');
    if (!(amount > 0)) return null;
    if (gfa > 0) {
      return { label: `${baseLabel} ${unit}`, value: `$${(amount / gfa).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
    }
    if (acres > 0) {
      return { label: `${baseLabel} ${acreUnit}`, value: `$${Math.round(amount / acres).toLocaleString('en-US')}` };
    }
    return null;
  };
  const salePerUnit = perUnit('Sale Price', p.salePrice);
  const postedPerUnit = perUnit('Enrolled Value', d.cover.totalPosted);

  // Valuation — headline money figures (emphasized) on the first row, with
  // Appraiser ID / Section / Notes on a second row. Both rows share a fixed
  // 4-column grid so the columns line up vertically: Appraiser ID under Sale
  // Price, Section under Sale Price/SF, and Notes spanning the Enrolled Value +
  // Enrolled Value/SF columns. Per-unit cells are reserved (empty when there's
  // no building area) so alignment always holds.
  const notesField = field('Notes', p.appraiserNotes);
  notesField.classList.add('cov-field-span2');
  const valuation = box('Valuation',
    el('div', { class: 'cov-val' },
      el('div', { class: 'cov-grid cov-grid-4' },
        field('Sale Price', fmtCurrency(p.salePrice), true),
        salePerUnit ? field(salePerUnit.label, salePerUnit.value, true) : field('', ''),
        field('Enrolled Value', fmtCurrency(d.cover.totalPosted), true),
        postedPerUnit ? field(postedPerUnit.label, postedPerUnit.value, true) : field('', ''),
      ),
      el('div', { class: 'cov-grid cov-grid-4' },
        field('Appraiser ID', p.appraiserId),
        field('Section', p.section),
        notesField,
      ),
    ),
  );

  // Parcel satellite image — the GIS parcel map is the default when no
  // image has been explicitly selected (an explicit "none" removes it).
  const subjUrl = resolveCoverPhotoUrl(d);
  const photo = el('div', { class: `cov-photo${subjUrl ? '' : ' cov-photo-empty'}` },
    el('div', { class: 'cov-photo-cap' }, 'Parcel Satellite Image'),
    subjUrl
      ? photoImg(subjUrl, 'Parcel satellite image')
      : el('div', { class: 'cov-photo-ph' }, 'No image'),
  );

  return sheet(1, total,
    el('div', { class: 'cover-inner cov-inner' },
      transferDetails,
      propertyId,
      valuation,
      photo,
    ),
  );
}

// General cover: a plain valuation as of a date — property identification,
// purpose, valuation, appraiser info/notes, and subject photo. No transfer,
// appeal, or stipulation specifics. Uses the same unified section boxes as
// the transfer cover.
function generalCover(d, total) {
  const p = d.property;
  const comp = computeAppraisal(d);
  const field = covField;
  const box = covBox;
  const grid = covGrid;

  const propertyId = box('Property Identification', grid([
    field('APN', p.apn),
    field('Situs', titleCase(p.address)),
    field('City', normalizeCity(p.city)),
    field('Property Type', d.improvements.primary.type),
  ]));

  const purpose = box('Purpose', grid([
    field('Reason', p.purpose),
    field('Report Type', p.reportType),
    field('Client', p.client),
  ]));

  const finalValue = d.reconciliation.finalValue || comp.reconciliation.weightedValue;
  const valuation = box('Valuation Details', grid([
    field('Effective Date', fmtDate(p.effectiveDate)),
    field('Final Value', finalValue > 0 ? fmtCurrency(finalValue) : '', true),
  ]));

  const appraiserInfo = box('Appraiser Info', grid([
    field('Prepared By', p.appraiser),
    field('Appraiser ID', p.appraiserId),
  ]));

  const appraiserNotes = box('Appraiser Notes',
    el('div', { class: 'cov-notes' }, p.appraiserNotes || '—'),
  );

  // The GIS parcel map is the default when no image has been selected.
  const subjUrl = resolveCoverPhotoUrl(d);
  const subjectPhoto = el('div', { class: `cov-photo${subjUrl ? '' : ' cov-photo-empty'}` },
    el('div', { class: 'cov-photo-cap' }, 'Parcel Satellite Image'),
    subjUrl
      ? photoImg(subjUrl, 'Parcel satellite image')
      : el('div', { class: 'cov-photo-ph' }, 'No image'),
  );

  return sheet(1, total,
    el('div', { class: 'cover-inner cov-inner' },
      propertyId,
      purpose,
      valuation,
      appraiserInfo,
      appraiserNotes,
      subjectPhoto,
    ),
  );
}

// Appeal: Assessment Appeal cover — seal + county header, case number, values.
function appealCover(d) {
  const p = d.property;
  const c = d.cover;
  const t = state.tenant || {};
  const county = (t.countyName || 'Riverside County').toUpperCase();
  const gfa = d.improvements.primary.grossFloorArea || 0;
  const perSqft = (v) => (gfa > 0 && v > 0 ? `$${Math.round(v / gfa)}/sqft` : '');
  const valueRow = (label, value) => el('div', { class: 'ap-kv' },
    el('span', {}, label),
    el('span', { class: 'ap-fill' }, fmtCurrency(value)),
    el('span', { class: 'ap-psf' }, perSqft(value)),
  );
  return el('div', { class: 'sheet cover' },
    el('div', { class: 'cover-inner ap-inner' },
      el('div', { class: 'ap-head' },
        t.sealUrl ? el('img', { class: 'ap-seal', src: t.sealUrl, alt: 'Seal' }) : null,
        el('div', { class: 'ap-county' },
          el('div', {}, county),
          el('div', {}, 'ASSESSOR-COUNTY CLERK-RECORDER'),
          el('div', {}, 'ASSESSMENT APPEAL BOARD #1'),
        ),
      ),
      el('div', { class: 'ap-center' },
        el('div', { class: 'ap-line' }, `HEARING DATE: ${fmtDate(c.hearingDate)}`),
        el('div', { class: 'ap-line ap-case-label' }, 'ASSESSMENT APPEAL CASE NUMBER(S):'),
        el('div', { class: 'ap-case-num' }, c.caseNumber || ''),
      ),
      el('div', { class: 'ap-rows' },
        el('div', { class: 'ap-kv' },
          el('span', {}, 'APPLICANT:'),
          el('span', { class: 'ap-fill' }, c.applicant || ''),
        ),
        el('div', { class: 'ap-kv' },
          el('span', {}, 'AGENT:'),
          el('span', { class: 'ap-fill' }, c.agent || ''),
        ),
      ),
      el('div', { class: 'ap-values' },
        valueRow('CURRENT ROLL VALUE:', c.currentRollValue),
        valueRow("APPLICANT'S OPINION OF VALUE:", c.applicantOpinionValue),
        valueRow("ASSESSOR'S OPINION OF VALUE:", c.assessorOpinionValue),
      ),
      el('div', { class: 'ap-presented' },
        el('div', {}, `PRESENTED BY: ${c.presentedBy || p.appraiser || ''}`),
        el('div', {}, (p.section || t.officeName || '').toUpperCase()),
        el('div', {}, `${county} ASSESSOR-CLERK-RECORDER`),
        el('div', {}, `${county}, CALIFORNIA`),
      ),
    ),
  );
}

// Stipulation: "STIPULATION BEFORE THE ASSESSMENT APPEALS" formal form.
function stipulationCover(d, total) {
  const p = d.property;
  const c = d.cover;
  const t = state.tenant || {};
  const county = (t.countyName || 'County of Riverside').toUpperCase();
  const cats = Array.isArray(c.valueCategories) ? c.valueCategories : [];
  const rollTotal = cats.reduce((s, r) => s + (r.rollValue || 0), 0);
  const stipTotal = cats.reduce((s, r) => s + (r.stipulatedValue || 0), 0);
  const line = (label, value, label2, value2) => el('div', { class: 'st-line' },
    el('span', { class: 'st-lbl' }, label),
    el('span', { class: 'st-fill' }, value || ''),
    label2 ? el('span', { class: 'st-lbl' }, label2) : null,
    label2 ? el('span', { class: 'st-fill' }, value2 || '') : null,
  );
  return el('div', { class: 'sheet cover' },
    el('div', { class: 'cover-inner st-inner' },
      el('div', { class: 'st-head' },
        el('div', { class: 'st-title' },
          el('div', {}, 'STIPULATION BEFORE THE ASSESSMENT APPEALS'),
          el('div', {}, county),
          el('div', {}, '(SECTION 1607 REVENUE AND TAXATION CODE)'),
        ),
        el('div', { class: 'st-head-right' },
          el('div', { class: 'st-hearing' }, `HEARING DATE: ${fmtDate(c.hearingDate)}`),
          el('div', { class: 'st-appbox' },
            el('div', { class: 'st-appbox-label' }, 'Application Number'),
            el('div', { class: 'st-appbox-num' }, c.applicationNumber || ''),
          ),
        ),
      ),
      line('Name of Applicant:', c.applicantName),
      line('Address:', c.applicantAddress),
      el('div', { class: 'st-sub' }, "If applicant is represented by agent, state agent's name and address:"),
      line('Name:', c.agentName, 'Address:', c.agentAddress),
      el('div', { class: 'st-sub' }, 'Description of property for which stipulation is'),
      el('div', { class: 'st-desc' },
        el('span', {}, `TRA: ${c.tra || ''}`),
        el('span', {}, `Assessment No.: ${c.assessmentNo || ''}`),
        el('span', {}, `ARB No.: ${c.arbNo || ''}`),
        el('span', {}, `Year ARB Created: ${c.yearArbCreated || ''}`),
      ),
      el('div', { class: 'st-desc' },
        el('span', {}, `Location: ${c.location || ''}`),
        el('span', {}, `Supplemental No.: ${c.supplementalNo || ''}`),
        el('span', {}, `Acreage: ${c.acreage || ''}`),
        el('span', {}, `Use: ${c.use || ''}`),
      ),
      el('table', { class: 'st-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, `Fiscal Year Beginning July 1, ${p.taxYear || ''}`),
          el('th', {}, 'Value Type Code'),
          el('th', {}, "Assessor's Roll Value"),
          el('th', {}, 'Stipulated Value'),
          el('th', { class: 'clerk' },
            el('div', {}, 'Clerk of the Board Use Only'),
            el('div', {}, "BOARD'S VALUE DATE (Complete after Discuss.)"),
            el('div', {}, 'Full Taxable Value'),
          ),
        )),
        el('tbody', {},
          ...cats.map((r) => el('tr', {},
            el('td', {}, r.category),
            el('td', {}, r.code || ''),
            el('td', { class: 'num' }, r.rollValue ? fmtCurrency(r.rollValue) : '0'),
            el('td', { class: 'num' }, r.stipulatedValue ? fmtCurrency(r.stipulatedValue) : ''),
            el('td', { class: 'clerk' }, ''),
          )),
          el('tr', { class: 'total' },
            el('td', {}, 'TOTAL'),
            el('td', {}, ''),
            el('td', { class: 'num' }, fmtCurrency(rollTotal)),
            el('td', { class: 'num' }, fmtCurrency(stipTotal)),
            el('td', { class: 'clerk' }, ''),
          ),
          el('tr', {},
            el('td', {}, 'Exemption'),
            el('td', {}, ''),
            el('td', { class: 'num' }, ''),
            el('td', { class: 'num' }, ''),
            el('td', { class: 'clerk' }, ''),
          ),
        ),
      ),
      ...stipFooter(d, total, t),
    ),
  );
}

// Stipulation cover bottom: facts/attest boxes, Section 1607 legal text,
// signature blocks, facsimile/extension footer, page number.
function stipFooter(d, total, t) {
  const p = d.property;
  const c = d.cover;
  const sigRow = (label) => el('div', { class: 'st-sig-row' },
    el('div', { class: 'st-sig' },
      el('div', { class: 'st-sig-line' }, ''),
      el('div', { class: 'st-sig-lbl' }, label),
    ),
    el('div', { class: 'st-sig-date' }, 'Date'),
  );
  return [
    el('div', { class: 'st-facts' },
      el('div', { class: 'st-facts-left' },
        el('div', { class: 'st-facts-title' }, 'FACTS JUSTIFYING REDUCED ASSESSMENT:'),
        el('div', { class: 'st-facts-text' }, c.factsJustifying || ''),
      ),
      el('div', { class: 'st-facts-right' },
        el('div', {}, 'Attest:'),
        el('div', {}, 'Clerk of the Board'),
        el('div', { class: 'st-attest-line' }, 'By ____________________  Deputy ____________________'),
      ),
    ),
    el('div', { class: 'st-legal' },
      'PURSUANT TO THE PROVISIONS OF SECTION 1607 OF THE REVENUE AND TAXATION CODE, THE ASSESSOR, THE COUNTY COUNSEL AND THE OWNER OR HIS AGENT, STIPULATE THAT THE FULL VALUE OR THE VALUE OF THE NEW CONSTRUCTION IS AS SET FORTH HEREIN.'),
    el('div', { class: 'st-legal' },
      "Pursuant to Section 1604(c) of the California Revenue and Taxation Code, if the County Assessment Appeals Board fails to hear evidence and fails to make a final determination on the application for reduction in assessment of property within two (2) years of the timely filing of the application, the taxpayer's opinion of market value as reflected on the application for reduction in assessment shall be the value upon which taxes are to be levied for the tax year covered by the application, unless the taxpayer and the County Assessment Appeals Board mutually agree in writing or on the record to an extension of time for the hearing."),
    el('div', { class: 'st-sigs' },
      el('div', { class: 'st-sig-col' },
        sigRow('Chief Appraiser'),
        sigRow('Owner/Applicant/Authorized Agent'),
      ),
      el('div', { class: 'st-sig-col' },
        sigRow('Deputy Assessor'),
        sigRow('County Counsel (By Deputy County Counsel)'),
        el('div', { class: 'st-sig-row' },
          el('div', { class: 'st-sig' }, el('div', { class: 'st-sig-lbl' }, 'Telephone Number')),
          el('div', { class: 'st-sig' }, el('div', { class: 'st-sig-lbl' }, 'FAX number')),
        ),
      ),
    ),
    el('div', { class: 'st-footer' },
      `The Assessment Appeals Board will consider the signature of the owner/applicant/authorized agent appearing on a facsimile transmitted copy of this stipulation to be an original signature. This stipulation will be effective as to the owner/applicant/authorized agent only if signed and returned to the ${t.countyName || 'Riverside County'} Assessor within 21 days from ${fmtDate(p.reportDate)}.`),
    el('div', { class: 'st-footer' },
      `The ${t.countyName || 'County of Riverside'} Assessment Appeals Board and Taxpayer/Applicant for above-referenced Assessment Appeal Application(s) ("Application(s)"), hereby mutually agree to an indefinite extension of time for the hearing on the Applications. The Parties agree that the hearing on the Applications may take place on a date after the two (2) year statute of limitations as provided in Section 1604(c).`),
    el('div', { class: 'st-pagenum' }, `Page 1 of ${total}`),
  ];
}

// Full sales comparison grid — subject vs. each comp across characteristics and
// adjustments. This is the single home for the grid (the form pane no longer
// renders it). Read-only here: no comp links / delete buttons.
function salesSheet(d, comp) {
  const p = d.property;
  const imp = d.improvements.primary;
  const land = d.land;
  const s = d.sales;
  const comps = s.comparables;

  // Portfolio: the subject is the combined property — use the summary totals
  // (summed building/site area) and the APN range for the subject column.
  const isPf = reportMode() === 'portfolio';
  const agg = isPf ? computePortfolioAggregate(state.portfolio.parcels) : null;
  const pfApns = isPf
    ? state.portfolio.parcels.map((x) => x.property?.apn).filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  const apnLabel = isPf
    ? (pfApns.length > 1 ? `${pfApns[0]} – ${pfApns[pfApns.length - 1]}` : (pfApns[0] || p.apn))
    : p.apn;

  const subjectSF = isPf ? agg.totalSqft : (imp.grossFloorArea || 0);
  const subjectSiteSqFt = isPf ? agg.totalSiteSqFt : (land.siteAreaSqFt || 0);
  const subjectAcres = subjectSiteSqFt / 43560;
  const subjectRatio = subjectSF > 0 ? subjectSiteSqFt / subjectSF : 0;
  // Vacant land: the subject has no building, so the grid drops building
  // characteristics and prices on land area ($/land SF and $/land acre).
  const isVacant = /vacant/i.test(imp.type || '');
  const compValues = comps.map((c) => {
    const unadjSF = c.buildingArea > 0 ? c.price / c.buildingArea : 0;
    // Net adjustment: for vacant land, exclude building-related adjustments so
    // the total matches the rows actually shown in the grid.
    const net = ADJ_FIELDS
      .filter(([f]) => !isVacant || !BUILDING_ADJ.has(f))
      .reduce((sum, [f]) => sum + (Number(c[f]) || 0), 0);
    const adjSF = unadjSF * (1 + net / 100);
    const ratio = c.buildingArea > 0 ? (c.landArea || 0) * 43560 / c.buildingArea : 0;
    // Land-based metrics (used when the subject is vacant land).
    const landSF = (c.landArea || 0) * 43560;
    const unadjLandSF = landSF > 0 ? c.price / landSF : 0;
    const unadjLandAcre = (c.landArea || 0) > 0 ? c.price / c.landArea : 0;
    const adjLandSF = unadjLandSF * (1 + net / 100);
    const adjLandAcre = unadjLandAcre * (1 + net / 100);
    return { unadjSF, net, adjSF, ratio, unadjLandSF, unadjLandAcre, adjLandSF, adjLandAcre };
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

  // Build the body rows. Vacant land drops the building characteristics
  // (Year Built, Age, Quality, Condition, Building Area, Land to Bldg. Ratio)
  // and prices on land area instead of building area.
  const bodyRows = [
    row('Parcel #', apnLabel, comps.map((c) => c.parcel || '—')),
    row('Property Type', imp.type, comps.map((c) => c.propertyType || '—')),
    row('Location', p.address, comps.map((c) => c.address || '—')),
    row('City', normalizeCity(p.city), comps.map((c) => normalizeCity(c.city) || '—')),
  ];
  if (!isVacant) {
    // Year built: prefer the comp's stored value (transfer comps carry it);
    // otherwise derive it from the comp's age.
    bodyRows.push(
      row('Year Built', (imp.yearBuilt || 0) > 0 ? String(imp.yearBuilt) : '—', comps.map((c) => {
        const yb = (c.yearBuilt || 0) > 0 ? c.yearBuilt : (c.age > 0 ? new Date().getFullYear() - c.age : 0);
        return yb > 0 ? String(yb) : '—';
      })),
      row('Age', compAge, comps.map((c) => (c.age > 0 ? String(c.age) : '—'))),
      row('Quality', imp.quality, comps.map((c) => c.quality || '—')),
      row('Condition', imp.condition, comps.map((c) => c.condition || '—')),
    );
  }
  bodyRows.push(
    row('Land Area (Acres)', subjectAcres > 0 ? subjectAcres.toFixed(2) : '—', comps.map((c) => (c.landArea > 0 ? c.landArea.toFixed(2) : '—'))),
  );
  if (!isVacant) {
    bodyRows.push(
      row('Building Area (SF)', subjectSF > 0 ? fmtNumber(subjectSF) : '—', comps.map((c) => (c.buildingArea > 0 ? fmtNumber(c.buildingArea) : '—'))),
      row('Land to Bldg. Ratio', subjectRatio > 0 ? subjectRatio.toFixed(2) : '—', compValues.map((v) => (v.ratio > 0 ? v.ratio.toFixed(2) : '—'))),
    );
  }
  // Transfers: the subject's own transfer date (effective date, matching
  // the cover's "Date of Transfer") and cash-equivalent sale price.
  bodyRows.push(
    row('Transfer Date', (p.caseType || 'transfer') === 'transfer' && p.effectiveDate ? fmtDate(p.effectiveDate) : '', comps.map((c) => (c.saleDate ? fmtDate(c.saleDate) : '—'))),
    row('Cash Eq. Sale Price', (p.caseType || 'transfer') === 'transfer' && (p.salePrice || 0) > 0 ? fmtCurrency(p.salePrice) : '', comps.map((c) => (c.price > 0 ? fmtCurrency(c.price) : '—'))),
    row('UNADJUSTED VALUE INDICATORS', null, [], { section: true }),
  );
  if (isVacant) {
    bodyRows.push(
      row('Unadjusted $/Land SF', '', compValues.map((v) => (v.unadjLandSF > 0 ? v.unadjLandSF.toFixed(2) : '—'))),
      row('Unadjusted $/Land Acre', '', compValues.map((v) => (v.unadjLandAcre > 0 ? v.unadjLandAcre.toFixed(2) : '—'))),
    );
  } else {
    bodyRows.push(
      row('Unadjusted Price / SF', '', compValues.map((v) => (v.unadjSF > 0 ? v.unadjSF.toFixed(2) : '—'))),
    );
  }
  bodyRows.push(
    row('Market Conditions', '', comps.map((c) => pct(c.adjMarketConditions))),
    row('Condition of Sale', '', comps.map((c) => pct(c.adjConditionOfSale))),
  );
  if (isVacant) {
    bodyRows.push(
      row('Adjusted $/Land SF', '', compValues.map((v) => (v.adjLandSF > 0 ? v.adjLandSF.toFixed(2) : '—'))),
      row('Adjusted $/Land Acre', '', compValues.map((v) => (v.adjLandAcre > 0 ? v.adjLandAcre.toFixed(2) : '—'))),
    );
  } else {
    bodyRows.push(
      row('Adjusted Price / SF', '', compValues.map((v) => (v.adjSF > 0 ? v.adjSF.toFixed(2) : '—'))),
    );
  }
  // Building-related adjustments are dropped for vacant land (no building to
  // compare). Market Conditions / Condition of Sale are shown above, so the
  // grid lists the first ten adjustment fields.
  const adjRows = ADJ_FIELDS.slice(0, 10)
    .filter(([f]) => !isVacant || !BUILDING_ADJ.has(f))
    .map(([f, label]) => row(label, '', comps.map((c) => pct(c[f]))));
  bodyRows.push(
    row('COMPARABILITY ADJUSTMENTS (%)', null, [], { section: true }),
    ...adjRows,
    row('NET ADJUSTMENTS', '', compValues.map((v) => (v.net !== 0 ? pct(v.net) : '0%')), { bold: true }),
    row('FINAL', null, [], { section: true }),
  );
  if (isVacant) {
    bodyRows.push(
      row('Adj. $/Land SF', '', compValues.map((v) => (v.adjLandSF > 0 ? v.adjLandSF.toFixed(2) : '—')), { bold: true }),
      row('Adj. $/Land Acre', '', compValues.map((v) => (v.adjLandAcre > 0 ? v.adjLandAcre.toFixed(2) : '—')), { bold: true }),
    );
  } else {
    bodyRows.push(
      row('Adj. Price / SF', '', compValues.map((v) => (v.adjSF > 0 ? v.adjSF.toFixed(2) : '—')), { bold: true }),
    );
  }

  const table = el('table', { class: 'sales-grid' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Description'),
      el('th', {}, 'Subject'),
      comps.map((c, i) => el('th', {}, `Comp ${i + 1}`)),
    )),
    el('tbody', {}, ...bodyRows),
  );

  // Correlated value. Vacant land: average the adjusted $/land SF across comps
  // and apply it to the subject's land area. Otherwise use the (portfolio-summed
  // or per-parcel) sales value expressed over the building area.
  let totalSales, corrLabel;
  if (isVacant) {
    const validLand = compValues.filter((v) => v.adjLandSF > 0);
    const corrLandSF = validLand.length > 0
      ? validLand.reduce((s, v) => s + v.adjLandSF, 0) / validLand.length
      : 0;
    totalSales = corrLandSF * subjectSiteSqFt;
    corrLabel = `SUBJECT CORRELATED VALUE: $${corrLandSF.toFixed(2)}/land SF × ${fmtNumber(subjectSiteSqFt)} SF`;
  } else {
    totalSales = isPf ? agg.totalSalesValue : comp.sales.valueBySales;
    const corrSF = subjectSF > 0 ? totalSales / subjectSF : comp.sales.correlatedSF;
    corrLabel = `SUBJECT CORRELATED VALUE: $${corrSF.toFixed(2)}/SF × ${fmtNumber(subjectSF)} SF`;
  }
  return el('div', {},
    heading('Sales Comparison Approach'),
    el('div', { class: 'sales-grid-wrap' }, table),
    el('div', { class: 'sales-correlated' },
      el('span', { class: 'sc-left' }, corrLabel),
      el('span', { class: 'sc-right' }, fmtCurrency(totalSales)),
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
  const includeIncome = hasIncomeData(d);
  const r = d.reconciliation;
  const narrative = generateReconciliationNarrative({
    costValue: comp.cost.valueByCost, costWeight: r.costWeight, includeCost,
    incomeValue: comp.income.valueByIncome, incomeWeight: r.incomeWeight, includeIncome,
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
        ...(includeIncome ? [['Income', fmtCurrency(comp.income.valueByIncome), fmtPct(r.incomeWeight, 0)]] : []),
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

// Subject property sheet — restyled to the unified section boxes used on the
// cover (navy header bar over a label/value grid). Property identification and
// description are merged into one box; the subject photos box grows to fill the
// leftover vertical space so the sheet always fits one page.
function subjectPropertySheet(d) {
  const p = d.property;
  const l = d.land;
  const b = d.improvements.primary;
  const gfa = b.grossFloorArea || 0;
  const address = [titleCase(p.address), p.zip].filter(Boolean).join(', ');

  // Subject Property — identification + description in one box.
  // Fixed 4-column grid so the 12 fields lay out as 3 rows of 4.
  // Building-related fields are omitted for vacant land.
  const vacant = isVacantLand(b.type);
  const subject = covBox('Subject Property', el('div', { class: 'cov-grid cov-grid-4' }, [
    covField('APN', p.apn),
    covField('Address', address),
    covField('City', normalizeCity(p.city)),
    covField('Property Type', b.type),
    !vacant ? covField('Building Area', gfa > 0 ? `${fmtNumber(gfa)} SF` : '') : null,
    covField('Site Area', l.siteAreaSqFt > 0 ? `${fmtNumber(l.siteAreaSqFt)} SF` : ''),
    covField('Acres', l.acres > 0 ? fmtAcresNum(l.acres) : ''),
    !vacant ? covField('Quality', b.quality) : null,
    !vacant ? covField('Year Built', b.yearBuilt) : null,
    !vacant && b.yearBuilt ? covField('Effective Age', p.effectiveDate ? String(parseInt(String(p.effectiveDate).slice(0, 4), 10) - b.yearBuilt) : '') : null,
    !vacant ? covField('Condition', b.condition) : null,
    covField('Zoning', l.zoning),
  ].filter(Boolean)));

  // Subject Photos — the subject's uploaded photos only (never the GIS
  // satellite, which belongs to the cover); grows to fill the page.
  const photos = resolveSubjectPhotoUrls(d);
  const photosBox = covBox('Subject Photos',
    photos.length > 0
      ? el('div', { class: `cov-photos${photos.length === 1 ? ' single' : ''}` },
          ...photos.map((url, i) => el('div', { class: 'cov-photo-cell' }, photoImg(url, `Subject photo ${i + 1}`))))
      : el('div', { class: 'cov-photos-empty' }, 'No photos'),
  );

  return [
    el('div', { class: 'cov-stack' },
      subject,
      photosBox,
    ),
  ];
}

// One page per comp, in the same unified navy-box style as the cover
// and subject sheet. The photos box grows to fill the leftover vertical space.
function compDetailSheets(d) {
  const comps = d.sales.comparables || [];
  if (comps.length === 0) return [];
  return comps.map((c, i) => {
    const unadjSF = c.buildingArea > 0 ? c.price / c.buildingArea : 0;
    const net = ADJ_KEYS.reduce((s, f) => s + (Number(c[f]) || 0), 0);
    const adjSF = unadjSF * (1 + net / 100);
    const adjRows = ADJ_KEYS
      .map((f) => [f.replace('adj', '').replace(/([A-Z])/g, ' $1').trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()), Number(c[f]) || 0])
      .filter(([, v]) => v !== 0);

    const idBox = covBox(`Comparable #${i + 1}`, covGrid([
      covField('Parcel', c.parcel),
      covField('Address', [titleCase(c.address), normalizeCity(c.city)].filter(Boolean).join(', ')),
      covField('Sale Date', fmtDate(c.saleDate)),
      covField('Sale Price', c.price > 0 ? fmtCurrency(c.price) : '', true),
      covField('Age', c.age),
      covField('Quality', c.quality),
      covField('Condition', c.condition),
      covField('Land Area', c.landArea > 0 ? fmtAcresNum(c.landArea) : ''),
      covField('Building Area', c.buildingArea > 0 ? `${fmtNumber(c.buildingArea)} SF` : ''),
      covField('Land to Bldg. Ratio', c.landArea > 0 && c.buildingArea > 0 ? (c.buildingArea / c.landArea).toFixed(2) : ''),
    ]));

    const adjBox = covBox('Adjustments',
      adjRows.length > 0
        ? table(['Adjustment', 'Amount'], [...adjRows, ['Net Adjustment', net]])
        : el('div', { class: 'cov-notes' }, 'No adjustments'),
    );

    const resultBox = covBox('Result', covGrid([
      covField('Unadjusted $/SF', unadjSF > 0 ? fmtCurrency(unadjSF) : ''),
      covField('Net Adjustment', `${net > 0 ? '+' : ''}${net}%`),
      covField('Adjusted $/SF', adjSF > 0 ? fmtCurrency(adjSF) : '', true),
    ]));

    const photos = resolveCompPhotoUrls(c);
    const photosBox = covBox('Photos',
      photos.length > 0
        ? el('div', { class: `cov-photos${photos.length === 1 ? ' single' : ''}` },
            ...photos.map((url, j) => el('div', { class: 'cov-photo-cell' }, photoImg(url, `Comp ${i + 1} photo ${j + 1}`))))
        : el('div', { class: 'cov-photos-empty' }, 'No photos'),
    );

    return [
      el('div', { class: 'cov-stack' },
        idBox,
        adjBox,
        resultBox,
        photosBox,
      ),
    ];
  });
}

function mapSheet(d) {
  const p = d.property;
  const comps = d.sales.comparables || [];
  const subjUrl = resolveSubjectImageUrl(d);
  const img = subjUrl
    ? el('div', { class: 'img-cell' }, photoImg(subjUrl, 'Map'))
    : el('div', { class: 'img-cell empty' }, el('div', { class: 'img-cap' }, 'No map'));
  return [
    heading('Map of Comparable Sales'),
    img,
    heading('Locations'),
    table(
      ['#', 'Parcel', 'Address'],
      [
        ['S', p.apn || '—', [titleCase(p.address), normalizeCity(p.city)].filter(Boolean).join(', ') || '—'],
        ...comps.map((c, i) => [String(i + 1), c.parcel || '—', [titleCase(c.address), normalizeCity(c.city)].filter(Boolean).join(', ') || '—']),
      ],
    ),
  ];
}

// --- portfolio (multi-parcel) report views -----------------------------------
// Rendered when reportMode() === 'portfolio'. Each mirrors the reference app's
// PortfolioViews.tsx, built from the shared el/heading/kv/table primitives.

function portfolioBanner(agg) {
  return el('div', { class: 'pf-banner' },
    el('span', { class: 'pf-banner-title' }, 'Combined Portfolio Summary'),
    el('span', { class: 'pf-banner-count' }, `${agg.parcelCount} parcel(s)`),
  );
}

function valueCallout(label, value, sub) {
  return el('div', { class: 'pf-callout' },
    el('div', { class: 'pf-callout-label' }, label),
    el('div', { class: 'pf-callout-value' }, value),
    sub ? el('div', { class: 'pf-callout-sub' }, sub) : null,
  );
}

// Extract a location description for a parcel: street address, stored
// intersection (from reverse-geocode), legal description intersection, or
// coordinates as a last resort.
function parcelIntersection(p) {
  const addr = p.property?.address;
  if (addr && addr !== '- No Situs -') return addr;
  // Stored intersection from reverse-geocode (fetched by fetchParcelCoordinates).
  if (p.property?.intersection) return `Near ${p.property.intersection}`;
  const ld = p.property?.legalDescription || '';
  const m = ld.match(/AT\s+INTERSECTION\s+OF\s+(.{2,80}?)(?:\s+AND\s+(.{2,80}?))?/i);
  if (m) return (m[1] + (m[2] ? ' and ' + m[2] : '')).trim();
  // No address, no geocoded street, no legal intersection → "No Situs".
  // (Coordinates are intentionally NOT shown in the report.)
  return ld || 'No Situs';
}

// Subject page for a multi-parcel portfolio: a combined summary of each
// parcel's characteristics (one row per APN, listed first → last) plus a final
// combined row (APN range + summed numeric characteristics).
function portfolioSubjectSheet(agg) {
  const parcels = state.portfolio.parcels;
  // List APNs first → last (numeric-aware ascending).
  const sorted = [...parcels].sort((a, b) =>
    String(a.property?.apn || '').localeCompare(String(b.property?.apn || ''), undefined, { numeric: true }));
  const gfaOf = (p) => (p.improvements?.primary?.grossFloorArea ?? 0) +
    (p.improvements?.outbuildings ?? []).reduce((s, o) => s + (o?.grossFloorArea ?? 0), 0);
  const effAge = (p) => {
    const yb = p.improvements?.primary?.yearBuilt;
    const ed = p.property?.effectiveDate;
    return yb && ed ? String(parseInt(String(ed).slice(0, 4), 10) - yb) : '';
  };
  const apns = sorted.map((p) => p.property?.apn).filter(Boolean);
  const apnRange = apns.length > 1 ? `${apns[0]} – ${apns[apns.length - 1]}` : (apns[0] || '—');
  const rows = sorted.map((p, i) => {
    const pr = p.property || {};
    const b = p.improvements?.primary || {};
    const l = p.land || {};
    return [
      i + 1,
      pr.apn || '—',
      [titleCase(pr.address), pr.zip].filter(Boolean).join(', ') || '—',
      normalizeCity(pr.city) || '—',
      b.type || '—',
      gfaOf(p) > 0 ? fmtNumber(gfaOf(p)) : '—',
      l.siteAreaSqFt > 0 ? fmtNumber(l.siteAreaSqFt) : '—',
      l.acres > 0 ? fmtAcresNum(l.acres) : '—',
      b.quality || '—',
      b.yearBuilt || '—',
      effAge(p) || '—',
      b.condition || '—',
      l.zoning || '—',
    ];
  });
  // Final combined row: APN range + summed numeric characteristics.
  const totalGfa = sorted.reduce((s, p) => s + gfaOf(p), 0);
  const totalSite = sorted.reduce((s, p) => s + (p.land?.siteAreaSqFt ?? 0), 0);
  const totalAcres = totalSite / 43560;
  rows.push([
    el('strong', {}, 'Total'),
    el('strong', {}, apnRange),
    '', '', '',
    el('strong', {}, totalGfa > 0 ? fmtNumber(totalGfa) : '—'),
    el('strong', {}, totalSite > 0 ? fmtNumber(totalSite) : '—'),
    el('strong', {}, totalAcres > 0 ? fmtAcresNum(totalAcres) : '—'),
    '', '', '', '', '',
  ]);
  return el('div', {},
    portfolioBanner(agg),
    heading('Subject Property — Combined Characteristics'),
    table(
      ['#', 'APN', 'Address', 'City', 'Property Type', 'Building (SF)', 'Site (SF)', 'Acres', 'Quality', 'Year Built', 'Eff. Age', 'Condition', 'Zoning'],
      rows,
    ),
  );
}

function portfolioCoverView(agg) {
  const parcels = state.portfolio.parcels;
  const anyCostIncluded = parcels.some((p) => !!p.cost?.includeInReport);
  const cards = [
    ['Sales', fmtCurrencyRounded(agg.totalSalesValue)],
    ['Income', fmtCurrencyRounded(agg.totalIncomeValue)],
  ];
  if (anyCostIncluded) cards.push(['Cost', fmtCurrencyRounded(agg.totalCostValue)]);
  // Combined parcel map (all parcels in one satellite image).
  const apns = parcels.map((p) => p.property?.apn).filter(Boolean);
  const mapBlock = apns.length > 1
    ? el('div', { class: 'pf-cover-block pf-map-block' },
        heading('Portfolio Map'),
        el('div', { class: 'pf-map', 'data-apns': apns.join(',') },
          el('div', { class: 'pin-map-canvas pin-map-loading' }, 'Loading combined parcel map…'),
        ),
      )
    : null;
  // Transfer details from the primary parcel (first in portfolio).
  const primary = parcels[0];
  const p = primary?.property || {};
  const transferDetails = el('div', { class: 'pf-cover-block' },
    heading('Transfer Details'),
    kv([
      ['Date of Transfer', fmtDate(p.effectiveDate)],
      ['Document Number', p.transferDocumentNumber],
      ['Ratio Code', p.ratioCode],
    ]),
  );
  return el('div', { class: 'pf-cover' },
    el('div', { class: 'pf-cover-head' },
      el('div', { class: 'pf-cover-kicker' }, 'Multi-Parcel Portfolio'),
      el('div', { class: 'pf-cover-title' }, 'Portfolio Appraisal'),
      el('div', { class: 'pf-cover-rule' }),
    ),
    transferDetails,
    el('div', { class: 'pf-cover-block' },
      heading('Portfolio Composition'),
      kv(parcels.map((p, i) => [
        `Parcel ${i + 1} · APN ${p.property?.apn || '—'}`,
        el('span', { 'data-parcel-idx': i },
          [p.property?.address && p.property.address !== '- No Situs -' ? p.property.address : parcelIntersection(p),
           p.improvements?.primary?.type || p.land?.zoning || ''].filter(Boolean).join(' · ')),
      ])),
    ),
    mapBlock,
    el('div', { class: 'pf-cover-block' },
      heading('Summary of Value'),
      el('div', { class: `pf-cards ${anyCostIncluded ? 'cols-3' : 'cols-2'}` },
        ...cards.map(([label, value]) => el('div', { class: 'pf-card' },
          el('div', { class: 'pf-card-label' }, label),
          el('div', { class: 'pf-card-value' }, value),
        )),
      ),
      el('div', { class: 'pf-callout-wrap' },
        valueCallout('Total Portfolio Value', fmtCurrencyRounded(agg.totalFinalValue), `${agg.parcelCount} parcels · ${fmtAcresNum(agg.totalAcres)} ac`),
      ),
    ),
  );
}

export function renderReport() {
  const root = document.getElementById('report-root');
  if (!root) return;
  const d = state.data;
  const comp = computeAppraisal(d);
  // Portfolio mode: portfolio cover + standard body sheets (same as single parcel).
  if (reportMode() === 'portfolio') {
    const agg = computePortfolioAggregate(state.portfolio.parcels);
    const pfCover = portfolioCoverView(agg);
    const bodySheets = [
      { section: 'subject', content: portfolioSubjectSheet(agg) },
      { section: 'sales', content: salesSheet(d, comp) },
      ...compDetailSheets(d, comp).map((c) => ({ section: 'sales', content: c })),
      { section: 'subject', content: mapSheet(d, comp) },
      ...(hasIncomeData(d) ? [{ section: 'income', content: incomeSheet(d, comp) }] : []),
      ...(hasCostData(d) ? [{ section: 'cost', content: costSheet(d, comp) }] : []),
      { section: 'reconciliation', content: reconciliationSheet(d, comp) },
    ];
    const total = bodySheets.length + 1;
    root.replaceChildren(
      el('div', { class: 'sheet-scale', 'data-section': 'cover' }, sheet(1, total, pfCover)),
      ...bodySheets.map((b, i) => el('div', { class: 'sheet-scale', 'data-section': b.section }, sheet(i + 2, total, b.content))),
    );
    const meta = document.querySelector('.staging-toolbar .st-meta');
    if (meta) meta.textContent = `${total} sheets · 8.5×11`;
    fitSheets();
    refreshTopBar();
    // Load the combined parcel map image (composited in the browser).
    root.querySelectorAll('.pf-map[data-apns]').forEach((box) => {
      const apns = box.dataset.apns;
      box.innerHTML = `<div class="pin-map-canvas pin-map-loading">Loading combined parcel map…</div>`;
      compositeParcelMap(apns)
        .then((dataUrl) => {
          if (!dataUrl) { box.innerHTML = `<div class="pin-map-canvas pin-map-loading">Combined map unavailable.</div>`; return; }
          box.innerHTML = `<div class="pin-map-canvas"><img class="pin-map-img" src="${dataUrl}" alt="Combined parcel map"></div><div class="pin-map-cap"><span>Portfolio Map · ${apns.split(',').length} parcels · satellite</span><span class="pin-map-cap-right"><span class="pin-map-attr">Imagery © Esri/World Imagery</span></span></div>`;
        })
        .catch(() => { box.innerHTML = `<div class="pin-map-canvas pin-map-loading">Combined map unavailable.</div>`; });
    });
    return;
  }
  // Each sheet is tagged with the form-tab section it belongs to, so the left
  // pane can scroll the preview to the matching page when a tab is selected.
  const bodySheets = [
    { section: 'subject', content: subjectPropertySheet(d, comp) },
    { section: 'sales', content: salesSheet(d, comp) },
    ...compDetailSheets(d, comp).map((c) => ({ section: 'sales', content: c })),
    { section: 'subject', content: mapSheet(d, comp) },
    ...(hasIncomeData(d) ? [{ section: 'income', content: incomeSheet(d, comp) }] : []),
    ...(hasCostData(d) ? [{ section: 'cost', content: costSheet(d, comp) }] : []),
    { section: 'reconciliation', content: reconciliationSheet(d, comp) },
  ];
  const total = bodySheets.length + 1;
  const cover = coverSheet(d, total);
  root.replaceChildren(
    el('div', { class: 'sheet-scale', 'data-section': 'cover' }, cover),
    ...bodySheets.map((b, i) => el('div', { class: 'sheet-scale', 'data-section': b.section }, sheet(i + 2, total, b.content))),
  );
  const meta = document.querySelector('.staging-toolbar .st-meta');
  if (meta) meta.textContent = `${total} sheets · 8.5×11`;
  fitSheets();
  refreshTopBar();
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
// Uses the sheet's actual rendered height (not a fixed 1056) so tall sheets
// (big sales grids, portfolio cover) aren't clipped in the preview.
export function fitSheets() {
  const s = getZoom();
  document.querySelectorAll('#report-root .sheet-scale').forEach((w) => {
    const sh = w.firstElementChild;
    if (!sh) return;
    // Measure the sheet's natural (unscaled) height.
    const naturalH = sh.scrollHeight || SHEET_H;
    w.style.width = `${SHEET_W * s}px`;
    w.style.height = `${naturalH * s}px`;
    sh.style.width = `${SHEET_W}px`;
    sh.style.transform = `scale(${s})`;
    sh.style.transformOrigin = 'top left';
  });
  const pct = document.querySelector('.staging-toolbar .zoom-pct');
  if (pct) pct.textContent = `${Math.round(s * 100)}%`;
}

// Scroll the preview pane to the first sheet tagged with the given form-tab
// section (cover / subject / sales / income / cost / reconciliation). Used so
// selecting a tab in the left pane jumps the preview to the matching page.
export function scrollToSection(sectionId) {
  const root = document.getElementById('report-root');
  if (!root) return;
  const target = root.querySelector(`.sheet-scale[data-section="${sectionId}"]`);
  if (!target) return;
  const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  root.scrollTo({ top, behavior: 'smooth' });
}

// --- PDF ---------------------------------------------------------------------
// PDF export is handled by the browser: the top-bar "Print" button calls
// window.print(), and the @media print rules in app.css lay the sheets out at
// exact 8.5×11 with one sheet per page. This gives vector text, small files,
// and zero client-side dependencies (jsPDF/html2canvas were removed).

