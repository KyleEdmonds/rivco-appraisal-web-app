# Updated Goals — Storage, Export, and Form UX Overhaul

## Part 1: Storage Minimization

**Problem:** `syncSubjectParcelMap()` stores a ~2.5MB base64 data URL in `state.data.property.subjectPhotoUrl`. Every appraisal that references the same APN carries its own copy.

**Changes:**
- Replace base64 image fields with references: `subjectImage: { source: "gis" }` or `{ source: "upload", file: "..." }`
- `source: "gis"` → resolved at render time as `/api/parcel-image/{apn}`
- `source: "upload"` → resolved as `/api/parcel-photos/{apn}/{file}`
- Remove `property.mapImageUrl` entirely (redundant with GIS map)
- Remove `syncSubjectParcelMap()` auto-fill — replace with explicit user action
- Migrate existing saved appraisals: on load, if `subjectPhotoUrl` is a data URL, discard and set `subjectImage: { source: "gis" }`
- Net savings: ~2.5MB per appraisal → ~30 bytes

## Part 2: PDF Export — Drop jsPDF, Use Browser Print

**Problem:** jsPDF + html2canvas rasterizes each sheet to PNG, producing large files with non-selectable text.

**Changes:**
- Remove jsPDF/html2canvas from the bundle (~500KB saved)
- Add `@media print` CSS: hide app chrome, show sheets at 8.5×11 with page breaks
- Replace "Export PDF" button with "Print / Save as PDF" → `window.print()`
- Optional: "Download HTML" button for standalone archival
- Gains: vector text, 5-10x smaller PDFs, crisp zoom, zero deps, WYSIWYG

## Part 3: Cover Tab Redesign

**Current problems:**
- APN search bar redundant when arriving from PIN page
- Image field buried at bottom of long form
- Satellite map auto-fills silently — no user choice
- "Parcel Number" field in Transfer Details duplicates the APN search
- Dead code: `detailsFields` array (lines 1067-1078)

**New layout (top to bottom):**
1. Compact setup bar: APN chip + dates + case type (one row)
2. Image panel: two-mode (GIS Map / Upload+Paste) with preview
3. Case-specific fields in tight grids

**Specific changes:**
- APN chip: read-only badge when set, search input when empty. Remove "Parcel Number" from Transfer Details.
- Image panel: `[🛰 GIS Map] [📷 Upload/Paste]` buttons + preview area + Replace/Remove
- Remove redundant fields: Parcel #, City (in Transfer Details), dead `detailsFields` array
- Tighten setup bar: smaller date inputs, inline labels

## Part 4: Left-Side Fields in General

**Changes:**
- Subject tab: Remove the image row (managed on Cover tab only)
- Subject tab: Make parcel-derived fields (APN, Address, City, Legal) read-only by default with edit-to-unlock
- Remove `property.mapImageUrl` from data model
- Enforce consistent field grouping pattern across all tabs

## Part 5: PDF Cover Layout (Report Quality)

**New transfer/general cover layout:**
- Image on the RIGHT, spanning two rows (~40% page width)
- Text fields on the LEFT in clean key-value layout
- "No image" state: subtle dashed border, small centered text
- Larger value text (13pt), tighter labels (9pt uppercase muted)

## Implementation Order

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | Image reference model (replace base64 with `{source, file?}`) | core.js, form.js, report.js | ✅ |
| 2 | New image panel component (GIS / Upload modes) | form.js, app.css | ✅ |
| 3 | APN chip in setup bar | form.js, app.css, main.js | ✅ |
| 4 | Remove redundant fields (Parcel #, City, Subject tab images, `mapImageUrl`) | form.js, core.js | ✅ |
| 5 | Print CSS + replace Export PDF with `window.print()` | report.js, app.css, index.html | ✅ |
| 6 | Remove jsPDF/html2canvas dependency | index.html, report.js, wwwroot/lib/ | ✅ |
| 7 | PDF cover layout restructure (image right, text left) | report.js, app.css | ✅ |
| 8 | Migrate existing saved appraisals (strip base64 on load) | core.js | ✅ |
