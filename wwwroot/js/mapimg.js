// mapimg.js — browser-side satellite map compositing + reverse geocode.
//
// Replaces the server-side /api/parcel-image/* and /api/reverse-geocode
// endpoints. The browser fetches the ArcGIS World Imagery (satellite) and
// World Transportation (street labels) PNGs directly — both services send
// `Access-Control-Allow-Origin: *` — draws the parcel outlines + APN labels
// onto a <canvas>, and returns a PNG data URL. No server image processing and
// no server-side external HTTP calls remain.
//
// The projection, extent math, and drawing parameters mirror the former C#
// implementation (MercX/MercY, MapExtent, Centroid, DrawApnLabel,
// DrawStreetLabelsAsync) so the composited image is pixel-for-pixel the same.

const MERC_K = 20037508.342789244; // Web Mercator (EPSG:102100) half-world
const STREET_LABEL_SCALE = 0.5;   // overlay fetched at 0.5× then scaled UP
const ASPECT = 16 / 9;

// --- projection -------------------------------------------------------------
export function mercX(lng) { return (lng / 180) * MERC_K; }
export function mercY(lat) {
  const rad = (lat * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + rad / 2)) * MERC_K / Math.PI;
  return Math.max(-MERC_K, Math.min(MERC_K, y));
}

// Parse a WKT POLYGON / MULTIPOLYGON into rings of [lng, lat] points. The
// innermost parenthesized groups are the rings (outer rings + holes).
export function parseWktRings(wkt) {
  const out = [];
  if (!wkt) return out;
  const s = String(wkt).trim();
  const groupRe = /\(([^()]+)\)/g;
  let m;
  while ((m = groupRe.exec(s)) !== null) {
    const coords = m[1].split(',').map((pair) => {
      const p = pair.trim().split(/\s+/);
      return [parseFloat(p[0]), parseFloat(p[1])];
    }).filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    if (coords.length >= 3) out.push(coords);
  }
  return out;
}

// The 16:9 image extent (Web Mercator) + target pixel size for a set of rings.
// Mirrors the backend MapExtent: pad the bbox, then expand the shorter axis to
// a fixed 16:9 frame so the image is never stretched or cropped.
export function mapExtent(rings, { padding = 0.4, baseWidth = 1200 } = {}) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const ring of rings)
    for (const [lng, lat] of ring) {
      const x = mercX(lng), y = mercY(lat);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
  // Degenerate (point) geometry: give it a small default footprint.
  if (xmax - xmin < 1e-3 && ymax - ymin < 1e-3) {
    const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    xmin = cx - 50; xmax = cx + 50; ymin = cy - 50; ymax = cy + 50;
  }
  const dx = (xmax - xmin) * padding, dy = (ymax - ymin) * padding;
  xmin -= dx; xmax += dx; ymin -= dy; ymax += dy;
  let w = xmax - xmin, h = ymax - ymin;
  if (w / h < ASPECT) { const dw = h * ASPECT - w; xmin -= dw / 2; xmax += dw / 2; }
  else { const dh = w / ASPECT - h; ymin -= dh / 2; ymax += dh / 2; }
  const W = baseWidth;
  const H = Math.round(baseWidth / ASPECT);
  return { xmin, ymin, xmax, ymax, W, H };
}

// Average of all ring points — a fallback anchor for a parcel's APN label.
export function centroid(rings) {
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings)
    for (const [lng, lat] of ring) { sx += lng; sy += lat; n++; }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

// Pole of inaccessibility: the point inside the polygon that is farthest from
// the boundary — the true visual center. Better than a vertex average for
// irregular shapes (e.g. a triangle), where the average can sit near an edge
// and let a wide label overflow the boundary. Uses the largest ring as the
// outer boundary and the remaining rings as holes.
export function poleOfInaccessibility(rings) {
  if (!rings || rings.length === 0) return null;
  const area = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  };
  const outer = rings.reduce((best, r) => (area(r) > area(best) ? r : best), rings[0]);
  const holes = rings.filter((r) => r !== outer);
  if (outer.length < 3) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (w <= 0 || h <= 0) return outer[0];

  // Point-in-ring via ray casting.
  const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inside = (x, y) => inRing(x, y, outer) && holes.every((hr) => !inRing(x, y, hr));

  // Minimum distance from a point to every edge of the given rings.
  const distToSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const minEdgeDist = (x, y) => {
    let d = Infinity;
    for (const ring of [outer, ...holes]) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        const dd = distToSeg(x, y, ax, ay, bx, by);
        if (dd < d) d = dd;
      }
    }
    return d;
  };

  // Coarse grid search, then progressive refinement (halving the step).
  const N = 16;
  let best = null, bestD = -1;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = minX + (w * i) / N, y = minY + (h * j) / N;
      if (!inside(x, y)) continue;
      const d = minEdgeDist(x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  if (!best) return null;
  let step = Math.max(w, h) / N;
  for (let iter = 0; iter < 5; iter++) {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const x = best[0] + i * step, y = best[1] + j * step;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        if (!inside(x, y)) continue;
        const d = minEdgeDist(x, y);
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
    }
    step /= 2;
  }
  return best;
}

// Format a 9-digit APN with standard dashes (400010006 -> 400-010-006) for
// easier scanning. Non-9-digit values are returned unchanged.
export function formatApn(apn) {
  const s = String(apn ?? '').trim();
  if (/^\d{9}$/.test(s)) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  return s;
}

// --- image loading ----------------------------------------------------------
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required so the canvas is not tainted
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

// Composite a transparent road-label overlay (ArcGIS World Transportation)
// over the imagery so street names are visible. Best-effort: any failure is
// swallowed so the map still renders without labels. Fetched at
// STREET_LABEL_SCALE × the base size and drawn at full size, which scales the
// street text UP so it reads larger on screen while the base stays sharp.
async function drawStreetLabels(ctx, xmin, ymin, xmax, ymax, W, H) {
  try {
    const ow = Math.max(1, Math.round(W * STREET_LABEL_SCALE));
    const oh = Math.max(1, Math.round(H * STREET_LABEL_SCALE));
    const url =
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/export' +
      `?bbox=${xmin},${ymin},${xmax},${ymax}&bboxSR=102100&imageSR=102100` +
      `&size=${ow},${oh}&format=png32&transparent=true&f=image`;
    const overlay = await loadImage(url);
    ctx.drawImage(overlay, 0, 0, W, H);
  } catch { /* street labels are best-effort; never block the map */ }
}

// Draw a readable APN label with a semi-transparent background box, clamped so
// it stays inside the image.
function drawApnLabel(ctx, apn, px, py, W, H, fontSize) {
  ctx.save();
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.textBaseline = 'top';
  const tw = ctx.measureText(apn).width;
  const th = fontSize; // approximate cap height
  const pad = 4;
  const boxW = tw + pad * 2, boxH = th + pad * 2;
  let boxX = px - tw / 2 - pad, boxY = py - th / 2 - pad;
  if (boxX < 2) boxX = 2;
  if (boxY < 2) boxY = 2;
  if (boxX + boxW > W - 2) boxX = W - 2 - boxW;
  if (boxY + boxH > H - 2) boxY = H - 2 - boxH;
  ctx.fillStyle = 'rgba(15,23,42,0.78)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = 'rgba(220,38,38,1)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = '#fff';
  ctx.fillText(apn, boxX + pad, boxY + pad);
  ctx.restore();
}

// --- compositing ------------------------------------------------------------
// Composite one or more parcels into a single satellite image and return a PNG
// data URL. `ringsByApn` is an array of { apn, rings } (rings = [lng,lat][]).
// A single parcel uses the default 0.4 padding and a 15px label; a clustered
// portfolio passes a tighter padding (0.15) and labels scale with the frame.
export async function compositeRings(ringsByApn, { padding = 0.4, baseWidth = 1200 } = {}) {
  const allRings = [];
  for (const { rings } of ringsByApn) allRings.push(...rings);
  if (allRings.length === 0) return null;
  const { xmin, ymin, xmax, ymax, W, H } = mapExtent(allRings, { padding, baseWidth });

  const base = await loadImage(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export' +
    `?bbox=${xmin},${ymin},${xmax},${ymax}&bboxSR=102100&imageSR=102100` +
    `&size=${W},${H}&format=png32&f=image`
  );
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, W, H);
  await drawStreetLabels(ctx, xmin, ymin, xmax, ymax, W, H);

  const Pt = ([lng, lat]) => {
    const mx = mercX(lng), my = mercY(lat);
    return [(mx - xmin) / (xmax - xmin) * W, (ymax - my) / (ymax - ymin) * H];
  };
  // Outlines for every parcel first (under the labels).
  for (const { rings } of ringsByApn)
    for (const ring of rings) {
      const pts = ring.map(Pt);
      if (pts.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(220,38,38,0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,38,38,1)';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 5]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  // APN labels at each parcel centroid. Font scales with the frame for a
  // clustered portfolio so it stays proportional to the (now larger) parcels.
  const labelFont = ringsByApn.length > 1 ? W * 0.011 : 15;
  for (const { apn, rings } of ringsByApn) {
    const c = centroid(rings);
    if (!c) continue;
    const [px, py] = Pt(c);
    drawApnLabel(ctx, apn, px, py, W, H, labelFont);
  }
  return canvas.toDataURL('image/png');
}

// Session cache of composited data URLs, keyed by sorted APNs + options. The
// report re-renders on every edit, so caching avoids re-fetching ArcGIS and
// re-compositing a multi-MB image on each keystroke. Bounded to the most
// recent entries (Map preserves insertion order).
const imgCache = new Map();
const IMG_CACHE_MAX = 24;
function cacheKey(apns, opts) {
  return [...apns].sort().join('_') + '|' + (opts.padding ?? 0.4) + '|' + (opts.baseWidth ?? 1200);
}
function cacheGet(key) {
  const v = imgCache.get(key);
  if (v !== undefined) { imgCache.delete(key); imgCache.set(key, v); } // touch (LRU)
  return v;
}
function cacheSet(key, val) {
  if (imgCache.has(key)) imgCache.delete(key);
  imgCache.set(key, val);
  while (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
}

// Fetch each APN's WKT shape from the local parcel-data endpoint and composite
// them into one image. `apns` may be an array or a comma-separated string.
// Returns a PNG data URL, or null when no APN has geometry / imagery fails.
export async function compositeParcelMap(apns, opts = {}) {
  const list = (Array.isArray(apns) ? apns : String(apns).split(','))
    .map((a) => String(a).trim()).filter((a) => /^\d+$/.test(a));
  if (list.length === 0) return null;
  const key = cacheKey(list, opts);
  if (!opts.noCache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const ringsByApn = [];
  await Promise.all(list.map(async (apn) => {
    let shape = '';
    try {
      const r = await fetch('/api/parcel-data/' + encodeURIComponent(apn));
      if (r.ok) { const j = await r.json(); shape = j.shape || ''; }
    } catch { /* offline */ }
    const rings = parseWktRings(shape);
    if (rings.length > 0) ringsByApn.push({ apn, rings });
  }));
  if (ringsByApn.length === 0) return null;
  const url = await compositeRings(ringsByApn, opts);
  if (url && !opts.noCache) cacheSet(key, url);
  return url;
}

// --- interactive parcel map (Leaflet) ---------------------------------------
// Live zoom/pan map for the PIN page: ArcGIS World Imagery + World
// Transportation (street labels) tiles fetched by the browser, the parcel
// polygon overlaid, and a permanent APN label at the centroid. Leaflet is
// vendored locally (wwwroot/lib/leaflet). Returns a wrapper element; call
// the returned `destroy()` when the element leaves the DOM (Leaflet tracks
// window listeners that must be released).
export function interactiveParcelMap(wkt, apn) {
  const wrap = document.createElement('div');
  wrap.className = 'pin-map';
  const canvas = document.createElement('div');
  canvas.className = 'pin-map-canvas';
  wrap.appendChild(canvas);
  const rings = parseWktRings(wkt);
  if (rings.length === 0 || typeof L === 'undefined') {
    canvas.classList.add('pin-map-loading');
    canvas.textContent = 'No parcel geometry available.';
    return { el: wrap, destroy: () => {} };
  }
  const compass = document.createElement('div');
  compass.className = 'pin-map-compass';
  compass.textContent = 'N ▲';
  canvas.appendChild(compass);

  // Leaflet needs a sized container: fitBounds() derives the zoom from the
  // container size, and this element is not in the DOM (size 0) until the PIN
  // page is rendered. Defer map creation until the canvas first reports a
  // non-zero size (ResizeObserver fires on attach; rAF covers the case where
  // it is already attached, e.g. the Refresh button).
  let map = null;
  let ro = null;
  const init = () => {
    if (map) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    if (ro) { ro.disconnect(); ro = null; }
    map = L.map(canvas, { zoomControl: true });
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagery © Esri/World Imagery' }).addTo(map);
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 }).addTo(map);
    const layers = [];
    for (const ring of rings) {
      // WKT rings are [lng, lat]; Leaflet wants [lat, lng].
      const pts = ring.map(([lng, lat]) => [lat, lng]);
      const poly = L.polygon(pts, {
        color: '#2563eb', weight: 3, opacity: 0.95,
        fillColor: '#2563eb', fillOpacity: 0.28,
      }).addTo(map);
      layers.push(poly);
    }
    // APN label: a plain divIcon (no marker dot) anchored at the pole of
    // inaccessibility (the polygon's visual center) so it sits cleanly inside
    // the shape rather than near an edge. iconSize [0,0] keeps Leaflet from
    // imposing a size; the label centers itself on the point via CSS transform.
    const c = poleOfInaccessibility(rings) || centroid(rings);
    if (c) {
      const icon = L.divIcon({
        className: 'apn-label',
        html: `<div class="apn-label-box">${formatApn(apn)}</div>`,
        iconSize: [0, 0],
      });
      L.marker([c[1], c[0]], { icon, interactive: false, keyboard: false }).addTo(map);
    }
    map.fitBounds(L.featureGroup(layers).getBounds().pad(0.35), { maxZoom: 19 });
  };
  ro = new ResizeObserver(() => { if (!map) init(); });
  ro.observe(canvas);
  requestAnimationFrame(init);

  return {
    el: wrap,
    destroy: () => {
      if (ro) { ro.disconnect(); ro = null; }
      if (map) { try { map.remove(); } catch { /* already removed */ } map = null; }
    },
  };
}

// --- reverse geocode --------------------------------------------------------
// True street name? Rejects route numbers (I-15, US-60, SR-74, Rte 60),
// all-digit labels (2016, 2064), and the city name itself (Corona).
function isStreetName(name, city) {
  const n = String(name).trim();
  if (n.length < 3) return false;
  if (/^[\d\-. ]+$/.test(n)) return false;
  if (/^(I|II|III|IV|US|SR|CA|S-|Rte|Route|Hwy|Highway)\s*[-.]?\s*\d+/i.test(n)) return false;
  if (city) {
    const c = String(city).trim();
    if (n.toLowerCase() === c.toLowerCase()) return false;
    if (n.length <= c.length + 4 && n.toLowerCase().includes(c.toLowerCase())) return false;
  }
  return true;
}

// Reverse-geocode lat/lng to the nearest street via Nominatim (OpenStreetMap).
// Best-effort: returns null on any failure so callers can degrade gracefully.
export async function reverseGeocode(lat, lng, city) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=18`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'AppraisalWorkbench/1.0 (contact: local)' } });
    if (!r.ok) return null;
    const json = await r.json();
    const addr = json?.address;
    if (!addr) return null;
    for (const k of ['road', 'residential', 'pedestrian', 'footway', 'path']) {
      const v = addr[k];
      if (v && isStreetName(v, city)) return v;
    }
    return null;
  } catch { return null; }
}