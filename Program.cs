using Microsoft.Data.Sqlite;
using System.Drawing;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RivCo;
using RivCo.Models;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// ---------------------------------------------------------------------------
// SQLite store — JSON document rows. The nested appraisal model is stored as
// a JSON blob; summary columns are denormalized for the list view.
// ---------------------------------------------------------------------------
var dbPath = Path.Combine(app.Environment.ContentRootPath, "data", "appraisal.db");
Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
var connStr = new SqliteConnectionStringBuilder { DataSource = dbPath }.ToString();

using (var conn = new SqliteConnection(connStr))
{
    conn.Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        CREATE TABLE IF NOT EXISTS appraisals (
            id TEXT PRIMARY KEY,
            apn TEXT,
            address TEXT,
            city TEXT,
            report_date TEXT,
            final_value REAL,
            case_type TEXT,
            data TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS permanent_comps (
            id TEXT PRIMARY KEY,
            apn TEXT,
            address TEXT,
            city TEXT,
            sale_date TEXT,
            price REAL,
            content_hash TEXT,
            source_appraisal_id TEXT,
            data TEXT NOT NULL,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS tenant (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT
        );
        -- Two separate server-side comp stores, never cross-written:
        --   permanent_comps  — finalized appraisals (written by /api/finalize)
        --   transfer_comps   — Rule 2 auto-enrolled transfers (written by the
        --                      Rule 2 batch only; read-only, no delete endpoint)
        -- Both are permanent sale comps, served together to the UI repository.
        -- CSV-imported comps remain machine-local (browser localStorage).
        CREATE TABLE IF NOT EXISTS transfer_comps (
            id TEXT PRIMARY KEY,
            apn TEXT,
            price REAL,
            sale_date TEXT,
            class_cd TEXT,
            class_cat TEXT,
            class_descr TEXT,
            ratio_cd TEXT,
            price_per_unit REAL,
            content_hash TEXT,
            source_file TEXT,
            data TEXT NOT NULL,
            created_at TEXT,
            address TEXT,
            city TEXT,
            quality TEXT,
            condition TEXT,
            year_built INTEGER,
            building_sf REAL,
            acreage REAL,
            site_sqft REAL
        );
        CREATE TABLE IF NOT EXISTS rule2_runs (
            id TEXT PRIMARY KEY,
            source_file TEXT,
            ran_at TEXT,
            summary TEXT NOT NULL,
            buckets TEXT NOT NULL,
            created_at TEXT
        );
        DROP TABLE IF EXISTS comps;
        """;
    cmd.ExecuteNonQuery();

    // Migration: add the property-characteristic columns to transfer_comps for
    // databases created before they existed (CREATE TABLE IF NOT EXISTS does not
    // add columns to an existing table). Idempotent — skips columns that exist.
    var transferCols = new (string name, string type)[]
    {
        ("address", "TEXT"), ("city", "TEXT"), ("quality", "TEXT"),
        ("condition", "TEXT"), ("year_built", "INTEGER"),
        ("building_sf", "REAL"), ("acreage", "REAL"), ("site_sqft", "REAL"),
    };
    foreach (var (name, type) in transferCols)
    {
        using var chk = conn.CreateCommand();
        chk.CommandText = "SELECT COUNT(*) FROM pragma_table_info('transfer_comps') WHERE name = $n";
        chk.Parameters.AddWithValue("$n", name);
        if (Convert.ToInt32(chk.ExecuteScalar()) == 0)
        {
            using var alt = conn.CreateCommand();
            alt.CommandText = $"ALTER TABLE transfer_comps ADD COLUMN {name} {type}";
            alt.ExecuteNonQuery();
        }
    }
    using (var idx = conn.CreateCommand())
    {
        idx.CommandText = "CREATE INDEX IF NOT EXISTS idx_transfer_comps_apn ON transfer_comps(apn)";
        idx.ExecuteNonQuery();
    }

    // Migration: add the case_type column to appraisals for databases created
    // before it existed (CREATE TABLE IF NOT EXISTS does not add columns to an
    // existing table). Idempotent — skips the column if it already exists.
    using (var chk = conn.CreateCommand())
    {
        chk.CommandText = "SELECT COUNT(*) FROM pragma_table_info('appraisals') WHERE name = 'case_type'";
        if (Convert.ToInt32(chk.ExecuteScalar()) == 0)
        {
            using var alt = conn.CreateCommand();
            alt.CommandText = "ALTER TABLE appraisals ADD COLUMN case_type TEXT";
            alt.ExecuteNonQuery();
        }
    }
}

SqliteConnection Open()
{
    var c = new SqliteConnection(connStr);
    c.Open();
    return c;
}

// ---------------------------------------------------------------------------
// Appraisals
// ---------------------------------------------------------------------------
app.MapGet("/api/appraisals", () =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT id, apn, address, city, report_date, final_value, case_type, updated_at FROM appraisals ORDER BY updated_at DESC";
    using var reader = cmd.ExecuteReader();
    var list = new List<Dictionary<string, object?>>();
    while (reader.Read())
    {
        list.Add(new Dictionary<string, object?>
        {
            ["id"] = reader.GetString(0),
            ["apn"] = reader.IsDBNull(1) ? null : reader.GetString(1),
            ["address"] = reader.IsDBNull(2) ? null : reader.GetString(2),
            ["city"] = reader.IsDBNull(3) ? null : reader.GetString(3),
            ["reportDate"] = reader.IsDBNull(4) ? null : reader.GetString(4),
            ["finalValue"] = reader.IsDBNull(5) ? null : reader.GetDouble(5),
            ["caseType"] = reader.IsDBNull(6) ? null : reader.GetString(6),
            ["updatedAt"] = reader.IsDBNull(7) ? null : reader.GetString(7),
        });
    }
    return Results.Ok(list);
});

app.MapGet("/api/appraisals/{id}", (string id) =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT data FROM appraisals WHERE id = $id";
    cmd.Parameters.AddWithValue("$id", id);
    var raw = cmd.ExecuteScalar() as string;
    if (raw is null) return Results.NotFound();
    // Normalize before returning: any section missing from an older document
    // is filled with model defaults, so the client always gets a complete doc.
    // Accepts a portfolio ({ parcels }) or a legacy single-parcel doc.
    var pf = AppraisalJson.ParsePortfolio(JsonNode.Parse(raw));
    return Results.Ok(new { id, data = pf });
});

app.MapPost("/api/appraisals", async (HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var dataNode = body?["data"] ?? body;
    if (dataNode is null) return Results.BadRequest(new { error = "missing 'data'" });

    // Parse into the typed model and normalize: missing sections are filled
    // with model defaults before the document is committed to the database.
    // One row = the whole portfolio (main subject = parcels[0]).
    var pf = AppraisalJson.ParsePortfolio(dataNode);
    var id = Guid.NewGuid().ToString("N");
    var now = DateTime.UtcNow.ToString("o");
    var (apn, address, city, reportDate, finalValue, caseType) = ExtractSummary(pf);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO appraisals (id, apn, address, city, report_date, final_value, case_type, data, created_at, updated_at)
        VALUES ($id, $apn, $address, $city, $rd, $fv, $ct, $data, $now, $now)
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$fv", (object?)finalValue ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$ct", (object?)caseType ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$data", AppraisalJson.SerializePortfolio(pf));
    cmd.Parameters.AddWithValue("$now", now);
    cmd.ExecuteNonQuery();
    return Results.Ok(new { id });
});

app.MapPut("/api/appraisals/{id}", async (string id, HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var dataNode = body?["data"] ?? body;
    if (dataNode is null) return Results.BadRequest(new { error = "missing 'data'" });

    // Parse into the typed model and normalize before committing, so the
    // stored document and the denormalized summary columns always agree.
    // One row = the whole portfolio (main subject = parcels[0]).
    var pf = AppraisalJson.ParsePortfolio(dataNode);
    var now = DateTime.UtcNow.ToString("o");
    var (apn, address, city, reportDate, finalValue, caseType) = ExtractSummary(pf);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        UPDATE appraisals SET apn=$apn, address=$address, city=$city, report_date=$rd,
        final_value=$fv, case_type=$ct, data=$data, updated_at=$now WHERE id=$id
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$fv", (object?)finalValue ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$ct", (object?)caseType ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$data", AppraisalJson.SerializePortfolio(pf));
    cmd.Parameters.AddWithValue("$now", now);
    var n = cmd.ExecuteNonQuery();
    return n == 0 ? Results.NotFound() : Results.Ok(new { id });
});

app.MapDelete("/api/appraisals/{id}", (string id) =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "DELETE FROM appraisals WHERE id = $id";
    cmd.Parameters.AddWithValue("$id", id);
    var n = cmd.ExecuteNonQuery();
    return n == 0 ? Results.NotFound() : Results.Ok(new { deleted = id });
});


// ---------------------------------------------------------------------------
// Permanent comps — finalized appraisals archived as permanent sales comps.
// One of two server-side comp stores (the other is transfer_comps, written
// by the Rule 2 batch — see Rule2.cs). CSV-imported comps are machine-local
// (browser localStorage) and never reach the server.
// ---------------------------------------------------------------------------
app.MapGet("/api/permanent-comps", () =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT data FROM permanent_comps ORDER BY created_at DESC";
    using var reader = cmd.ExecuteReader();
    var list = new List<CompRecord>();
    while (reader.Read())
    {
        var rec = AppraisalJson.DeserializeComp(reader.GetString(0));
        if (rec is not null) list.Add(rec);
    }
    return Results.Ok(list);
});

app.MapPost("/api/finalize", async (HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var dataNode = body?["data"];
    if (dataNode is null) return Results.BadRequest(new { error = "missing 'data'" });
    // One row = the whole portfolio; the permanent comp is built from the main
    // subject (parcels[0]), matching the reference app's single-comp behavior.
    var pf = AppraisalJson.ParsePortfolio(dataNode);
    var (apn, address, city, reportDate, finalValue, caseType) = ExtractSummary(pf);
    if (string.IsNullOrWhiteSpace(apn)) return Results.BadRequest(new { error = "appraisal has no APN" });

    // Canonical SHA-256 of the appraisal content (dedup key, with APN).
    // Hash the raw request node — not the normalized model — so rows
    // archived before the typed-model refactor keep deduplicating correctly.
    var contentHash = Convert.ToHexStringLower(
        System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Canonicalize(dataNode))));
    var now = DateTime.UtcNow.ToString("o");

    using var conn = Open();
    using (var cmd = conn.CreateCommand())
    {
        cmd.CommandText = "SELECT id FROM permanent_comps WHERE apn = $apn AND content_hash = $hash";
        cmd.Parameters.AddWithValue("$apn", apn);
        cmd.Parameters.AddWithValue("$hash", contentHash);
        var existing = cmd.ExecuteScalar() as string;
        if (existing is not null)
            return Results.Ok(new { success = true, deduplicated = true, existingId = existing, contentHash });
    }

    var comp = SnapshotToCompRecord(pf.MainSubject, apn, address, now, finalValue ?? 0);
    var id = Guid.NewGuid().ToString("N");
    using (var cmd = conn.CreateCommand())
    {
        cmd.CommandText = """
            INSERT INTO permanent_comps (id, apn, address, city, sale_date, price, content_hash, source_appraisal_id, data, created_at)
            VALUES ($id, $apn, $address, $city, $saleDate, $price, $hash, $src, $data, $now)
            """;
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$apn", apn);
        cmd.Parameters.AddWithValue("$address", address ?? "");
        cmd.Parameters.AddWithValue("$city", city ?? "");
        cmd.Parameters.AddWithValue("$saleDate", now.Length >= 10 ? now[..10] : now);
        cmd.Parameters.AddWithValue("$price", finalValue ?? 0);
        cmd.Parameters.AddWithValue("$hash", contentHash);
        cmd.Parameters.AddWithValue("$src", Str(body?["appraisalId"]) ?? "");
        cmd.Parameters.AddWithValue("$data", AppraisalJson.SerializeComp(comp));
        cmd.Parameters.AddWithValue("$now", now);
        cmd.ExecuteNonQuery();
    }
    using (var cmd = conn.CreateCommand())
    {
        cmd.CommandText = "SELECT COUNT(*) FROM permanent_comps";
        var count = Convert.ToInt64(cmd.ExecuteScalar());
        return Results.Ok(new { success = true, deduplicated = false, reportId = id, contentHash, compCount = count });
    }
});

// ---------------------------------------------------------------------------
// Tenant config (county branding)
// ---------------------------------------------------------------------------
app.MapGet("/api/tenant", () =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT data FROM tenant WHERE id = 'config'";
    var data = cmd.ExecuteScalar() as string;
    return Results.Ok(AppraisalJson.DeserializeTenant(data) ?? new TenantConfig());
});

app.MapPut("/api/tenant", async (HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body);
    if (body is null) return Results.BadRequest(new { error = "invalid json" });
    var tenant = AppraisalJson.DeserializeTenant(body.ToJsonString()) ?? new TenantConfig();
    var now = DateTime.UtcNow.ToString("o");
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO tenant (id, data, updated_at) VALUES ('config', $data, $now)
        ON CONFLICT(id) DO UPDATE SET data=$data, updated_at=$now
        """;
    cmd.Parameters.AddWithValue("$data", AppraisalJson.SerializeTenant(tenant));
    cmd.Parameters.AddWithValue("$now", now);
    cmd.ExecuteNonQuery();
    return Results.Ok(new { saved = true });
});

// ---------------------------------------------------------------------------
// Parcel data — the FULL RivCo (rivcoview) assessment response per APN, carried
// in the RivCoViewJSON column of input/master_parcel_list.csv (the search
// universe). Served as-is so the UI can use any field (sales history,
// assessment history, shape, street view, building details, ...). The CSV is
// re-read when its mtime changes, so a fresh county file is picked up without
// restarting the app. (Replaces the old output/parcel_data.json cache.)
// ---------------------------------------------------------------------------
Dictionary<string, JsonObject>? _parcelIndex = null;
DateTime _parcelStamp = DateTime.MinValue;
var _parcelLock = new object();

// Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas, and
// doubled quotes ("" -> "). Needed because the RivCoViewJSON column is a large
// quoted JSON blob — a naive comma-split would corrupt it.
static List<List<string>> ParseCsv(string text)
{
    var records = new List<List<string>>();
    var record = new List<string>();
    var field = new StringBuilder();
    bool inQuotes = false;
    int i = 0, n = text.Length;
    while (i < n)
    {
        char c = text[i];
        if (inQuotes)
        {
            if (c == '"')
            {
                if (i + 1 < n && text[i + 1] == '"') { field.Append('"'); i += 2; }
                else { inQuotes = false; i++; }
            }
            else { field.Append(c); i++; }
        }
        else
        {
            if (c == '"') { inQuotes = true; i++; }
            else if (c == ',') { record.Add(field.ToString()); field.Clear(); i++; }
            else if (c == '\r') { i++; if (i < n && text[i] == '\n') i++; record.Add(field.ToString()); field.Clear(); records.Add(record); record = new List<string>(); }
            else if (c == '\n') { i++; record.Add(field.ToString()); field.Clear(); records.Add(record); record = new List<string>(); }
            else { field.Append(c); i++; }
        }
    }
    if (field.Length > 0 || record.Count > 0) { record.Add(field.ToString()); records.Add(record); }
    return records;
}

// Load (and mtime-refresh) the parcel index from the master list CSV. Shared
// by the parcel-data and parcel-search endpoints.
Dictionary<string, JsonObject> LoadParcelIndex()
{
    lock (_parcelLock)
    {
        var file = Path.Combine(app.Environment.ContentRootPath, "input", "master_parcel_list.csv");
        var stamp = File.Exists(file) ? new FileInfo(file).LastWriteTimeUtc : DateTime.MinValue;
        if (_parcelIndex is null || stamp != _parcelStamp)
        {
            var idx = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            if (File.Exists(file))
            {
                var records = ParseCsv(File.ReadAllText(file, Encoding.UTF8));
                if (records.Count > 0)
                {
                    var header = records[0];
                    int pinIdx = header.IndexOf("PIN");
                    int jsonIdx = header.IndexOf("RivCoViewJSON");
                    for (int r = 1; r < records.Count && pinIdx >= 0 && jsonIdx >= 0; r++)
                    {
                        var row = records[r];
                        if (row.Count <= jsonIdx) continue;
                        var apn = row[pinIdx].Trim();
                        var json = row[jsonIdx];
                        if (apn.Length == 0 || json.Length == 0) continue;
                        try { idx[apn] = JsonNode.Parse(json) as JsonObject ?? new JsonObject(); }
                        catch { /* skip a malformed RivCoViewJSON row */ }
                    }
                }
            }
            _parcelIndex = idx;
            _parcelStamp = stamp;
        }
    }
    return _parcelIndex;
}

app.MapGet("/api/parcel-data/{apn}", (string apn) =>
{
    var node = LoadParcelIndex().TryGetValue(apn, out var p) ? p : null;
    return node is null
        ? Results.NotFound(new { error = "no parcel data for " + apn })
        : Results.Ok(node);
});

// Reverse geocode: given lat/lng, return the nearest road intersection
// (e.g. "Glider Cir & 5th St") using the Google Geocoding API.
// The API key is pulled from the parcel data (embedded per-parcel).
app.MapGet("/api/reverse-geocode", async (HttpContext ctx) =>
{
    var lat = ctx.Request.Query["lat"];
    var lng = ctx.Request.Query["lng"];
    var city = ctx.Request.Query["city"];
    if (!double.TryParse(lat, out var latV) || !double.TryParse(lng, out var lngV))
        return Results.BadRequest(new { error = "lat and lng required" });

    // Reverse-geocode via Nominatim (OpenStreetMap) to get the nearest street.
    // Fast and reliable; returns a single street name (not a full intersection).
    // The report shows this as "Near <street>" for parcels without an address.
    var url = $"https://nominatim.openstreetmap.org/reverse?lat={latV.ToString(System.Globalization.CultureInfo.InvariantCulture)}&lon={lngV.ToString(System.Globalization.CultureInfo.InvariantCulture)}&format=jsonv2&zoom=18";
    try
    {
        using var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("AppraisalWorkbench/1.0 (contact: local)");
        var resp = await http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return Results.Ok(new { intersection = (string?)null, address = (string?)null });
        var body = await resp.Content.ReadAsStringAsync();
        var json = JsonNode.Parse(body);
        var addr = json?["address"] as JsonObject;
        if (addr is null)
            return Results.Ok(new { intersection = (string?)null, address = (string?)null });

        // Prefer the most specific street-like field. Nominatim puts the road in
        // "road"; residential streets may land in "residential"/"pedestrian".
        string? street = null;
        foreach (var key in new[] { "road", "residential", "pedestrian", "footway", "path" })
        {
            var v = addr[key]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(v) && IsStreetName(v, city)) { street = v; break; }
        }
        return Results.Ok(new { intersection = street, address = (string?)null });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { intersection = (string?)null, address = (string?)null, error = ex.Message });
    }
});

// True street name? Rejects route numbers (I-15, US-60, SR-74, Rte 60),
// all-digit labels (2016, 2064), and the city name itself (Corona).
static bool IsStreetName(string name, string? city)
{
    var n = name.Trim();
    if (n.Length < 3) return false;
    // All digits (or digits with a couple of separators) → not a street.
    if (n.All(c => char.IsDigit(c) || c is '-' or '.' or ' ')) return false;
    // Route-number patterns: "I-15", "US 60", "US-60", "SR 74", "CA-73", "Rte 60".
    if (System.Text.RegularExpressions.Regex.IsMatch(n,
        @"^(I|II|III|IV|US|SR|CA|S-|Rte|Route|Hwy|Highway)\s*[-.]?\s*\d+",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return false;
    // The city name (or a name that is just the city) is not a street.
    if (!string.IsNullOrWhiteSpace(city))
    {
        var c = city.Trim();
        if (n.Equals(c, StringComparison.OrdinalIgnoreCase)) return false;
        if (n.Length <= c.Length + 4 && n.Contains(c, StringComparison.OrdinalIgnoreCase)) return false;
    }
    return true;
}

// Parcel search for the top-bar search box: APN prefix (any all-digit query)
// or case-insensitive address substring. Returns up to 20 lightweight matches
// so the UI can suggest PINs that have no appraisal yet.
app.MapGet("/api/parcel-search", (string? q) =>
{
    var data = LoadParcelIndex();
    var query = (q ?? "").Trim();
    if (query.Length == 0) return Results.Ok(new List<Dictionary<string, object?>>());
    var lq = query.ToLowerInvariant();
    // Any all-digit query is an APN prefix (e.g. typing "2" surfaces every PIN
    // that starts with 2). Only non-digit queries fall back to address search.
    var isApn = query.All(char.IsDigit);
    var results = new List<Dictionary<string, object?>>();
    foreach (var (apn, node) in data)
    {
        if (results.Count >= 20) break;
        var address = Str(node["address"]) ?? "";
        var hit = isApn
            ? apn.StartsWith(query, StringComparison.OrdinalIgnoreCase)
            : address.ToLowerInvariant().Contains(lq);
        if (!hit) continue;
        var district = Str(node["District"]) ?? "";
        results.Add(new Dictionary<string, object?>
        {
            ["apn"] = apn,
            ["address"] = address,
            ["city"] = district.Contains(' ') ? district.Split(' ', 2)[1] : "",
            ["class"] = Str(node["class_code"]) ?? "",
            ["acreage"] = Str(node["acreage"]) ?? "",
        });
    }
    // APNs are fixed-length digit strings, so ordinal order is numeric order.
    results.Sort((a, b) => String.CompareOrdinal((string)a["apn"]!, (string)b["apn"]!));
    return Results.Ok(results);
});

// ---------------------------------------------------------------------------
// Parcel satellite map — a cached World Imagery snapshot of the parcel's
// bounding box (the same approach as the old Excel macro, minus the Excel
// flatten hack). The parcel geometry is already local (WKT shape in the
// master list), so only the imagery is fetched: the first request downloads
// a 1200x675 PNG from ArcGIS World Imagery and caches it under
// storage/parcel_maps/; later requests serve the file from disk.
// ---------------------------------------------------------------------------
HttpClient MapHttp = new() { Timeout = TimeSpan.FromSeconds(30) };
MapHttp.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
SemaphoreSlim MapLock = new(1, 1);
// Bump this whenever the map rendering changes (extent, resolution, label
// sizing, overlay) so cached PNGs are automatically re-rendered instead of
// serving stale images. Old files are left on disk but no longer matched.
const string MapCacheVersion = "v3";
// The street-label overlay (ArcGIS World Transportation) renders its text at
// roughly a fixed pixel size, so a higher-res base image just downscales the
// labels more. To make street names larger we fetch the overlay at a LOWER
// resolution (StreetLabelScale < 1) and composite it scaled UP onto the base.
// The satellite imagery stays sharp; only the label layer is enlarged. Lower
// value = bigger labels (but softer). 0.5 ≈ 2× larger street text.
const double StreetLabelScale = 0.5;
const double MercK = 20037508.342789244; // Web Mercator (EPSG:102100) half-world

static double MercX(double lng) => lng * MercK / 180.0;
static double MercY(double lat)
{
    var rad = lat * Math.PI / 180.0;
    var y = Math.Log(Math.Tan(Math.PI / 4 + rad / 2)) * MercK / Math.PI;
    return Math.Clamp(y, -MercK, MercK);
}

// Parse a WKT POLYGON/MULTIPOLYGON into rings of (lng, lat) points.
static List<List<(double Lng, double Lat)>> ParseWktRings(string wkt)
{
    var rings = new List<List<(double, double)>>();
    int depth = 0, ringStart = -1;
    for (int i = 0; i < wkt.Length; i++)
    {
        if (wkt[i] == '(')
        {
            depth++;
            // Always track the start: for MULTIPOLYGON(((...))) the ring's
            // coordinates begin after the innermost '(', not the second one.
            ringStart = i + 1;
        }
        else if (wkt[i] == ')')
        {
            if (depth == 2 && ringStart >= 0)
            {
                var ring = new List<(double, double)>();
                foreach (var part in wkt[ringStart..i].Split(','))
                {
                    var nums = part.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (nums.Length >= 2
                        && double.TryParse(nums[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var x)
                        && double.TryParse(nums[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var y))
                        ring.Add((x, y));
                }
                if (ring.Count > 0) rings.Add(ring);
                ringStart = -1;
            }
            depth--;
        }
    }
    return rings;
}

// The image extent (Web Mercator) + target pixel size for a satellite snapshot.
// The parcel bbox is padded `padding` per side, then expanded to a fixed 16:9
// frame (matching the CSS display box) so the image is never stretched or
// cropped. Single parcels use the default 0.4 padding (a modest zoom-in that
// keeps context while making street labels larger on screen); a clustered
// portfolio passes a tighter padding so the parcels fill more of the frame.
// A tall/narrow cluster is limited by height in 16:9 and is centered with
// empty sides — that's the correct, undistorted result. baseWidth sets the
// render resolution (higher = sharper imagery and crisper street labels).
static (double Xmin, double Ymin, double Xmax, double Ymax, int W, int H) MapExtent(
    List<List<(double Lng, double Lat)>> rings, double padding = 0.4, int baseWidth = 1200)
{
    double xmin = double.MaxValue, ymin = double.MaxValue, xmax = double.MinValue, ymax = double.MinValue;
    foreach (var ring in rings)
        foreach (var (lng, lat) in ring)
        {
            double x = MercX(lng), y = MercY(lat);
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
    // Degenerate (point) geometry: give it a small default footprint.
    if (xmax - xmin < 1e-3 && ymax - ymin < 1e-3)
    {
        double cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
        xmin = cx - 50; xmax = cx + 50; ymin = cy - 50; ymax = cy + 50;
    }
    double dx = (xmax - xmin) * padding, dy = (ymax - ymin) * padding;
    xmin -= dx; xmax += dx; ymin -= dy; ymax += dy;
    // Expand the shorter axis to a fixed 16:9 frame (no distortion).
    const double aspect = 16.0 / 9.0;
    double w = xmax - xmin, h = ymax - ymin;
    if (w / h < aspect) { double dw = h * aspect - w; xmin -= dw / 2; xmax += dw / 2; }
    else { double dh = w / aspect - h; ymin -= dh / 2; ymax += dh / 2; }
    int W = baseWidth;
    int H = (int)Math.Round(baseWidth / aspect);
    return (xmin, ymin, xmax, ymax, W, H);
}

// Average of all ring points — a good-enough anchor for a parcel's APN label.
static (double Lng, double Lat)? Centroid(List<List<(double Lng, double Lat)>> rings)
{
    double sx = 0, sy = 0; int n = 0;
    foreach (var ring in rings)
        foreach (var (lng, lat) in ring) { sx += lng; sy += lat; n++; }
    if (n == 0) return null;
    return (sx / n, sy / n);
}

// Draw a readable APN label with a semi-transparent background box, clamped
// so it stays inside the image. Font size scales with the image width so the
// label stays proportional whether the frame is a wide or a tall crop.
static void DrawApnLabel(System.Drawing.Graphics g, string apn, System.Drawing.PointF at, int imgW, int imgH, float fontSize = 15f)
{
    using var font = new System.Drawing.Font("Arial", fontSize, System.Drawing.FontStyle.Bold);
    var size = g.MeasureString(apn, font);
    const float pad = 4f;
    var box = new System.Drawing.RectangleF(
        at.X - size.Width / 2 - pad,
        at.Y - size.Height / 2 - pad,
        size.Width + pad * 2,
        size.Height + pad * 2);
    if (box.X < 2) box.X = 2;
    if (box.Y < 2) box.Y = 2;
    if (box.Right > imgW - 2) box.X = imgW - 2 - box.Width;
    if (box.Bottom > imgH - 2) box.Y = imgH - 2 - box.Height;
    using (var bg = new System.Drawing.SolidBrush(Color.FromArgb(200, 15, 23, 42)))
        g.FillRectangle(bg, box);
    using (var border = new System.Drawing.Pen(Color.FromArgb(255, 220, 38, 38), 1.5f))
        g.DrawRectangle(border, box);
    using (var brush = new System.Drawing.SolidBrush(Color.White))
        g.DrawString(apn, font, brush, box.X + pad, box.Y + pad);
}

// Composite a transparent road-label overlay (ArcGIS World Transportation
// reference layer) over the imagery so street names are visible. Best-effort:
// any failure is swallowed so the map still renders without labels.
// The overlay is fetched at StreetLabelScale × the base size (a lower
// resolution) and drawn at the full base size, which scales the street text
// UP so it reads larger on screen while the satellite base stays sharp.
async Task DrawStreetLabelsAsync(System.Drawing.Graphics g, double xmin, double ymin, double xmax, double ymax, int w, int h)
{
    try
    {
        int ow = Math.Max(1, (int)Math.Round(w * StreetLabelScale));
        int oh = Math.Max(1, (int)Math.Round(h * StreetLabelScale));
        var url = $"https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/export"
            + $"?bbox={xmin:R},{ymin:R},{xmax:R},{ymax:R}&bboxSR=102100&imageSR=102100"
            + $"&size={ow},{oh}&format=png32&transparent=true&f=image";
        using var resp = await MapHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        if (!resp.IsSuccessStatusCode) return;
        var body = await resp.Content.ReadAsByteArrayAsync();
        using var ms = new MemoryStream(body);
        using var overlay = new System.Drawing.Bitmap(ms);
        // Draw the (smaller) overlay stretched to the full base size → labels
        // are enlarged by 1/StreetLabelScale. High-quality interpolation keeps
        // the enlarged text as crisp as the upscaling allows.
        var state = g.InterpolationMode;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        try { g.DrawImage(overlay, 0, 0, w, h); }
        finally { g.InterpolationMode = state; }
    }
    catch { /* street labels are best-effort; never block the map */ }
}

// The image extent for a parcel (no network needed — geometry is local).
// Returns null when the APN is invalid or has no geometry.
JsonObject? ParcelMapExtentJson(string apn)
{
    if (!apn.All(char.IsDigit)) return null;
    var node = LoadParcelIndex().TryGetValue(apn, out var p) ? p : null;
    var shape = Str(node?["shape"]) ?? "";
    var rings = ParseWktRings(shape);
    if (rings.Count == 0) return null;
    var (xmin, ymin, xmax, ymax, _, _) = MapExtent(rings);
    return new JsonObject {
        ["apn"] = apn,
        ["bbox"] = new JsonArray(xmin, ymin, xmax, ymax),
    };
}

app.MapGet("/api/parcel-map/{apn}", (string apn) =>
{
    var json = ParcelMapExtentJson(apn);
    return json is null
        ? Results.NotFound(new { error = "no parcel geometry for " + apn })
        : Results.Ok(json);
});

// Download the ArcGIS satellite PNG for the parcel's 16:9 extent, composite
// the red parcel outline onto it, and cache the result as a single {apn}.png.
// The file is kept forever after the first download; use /refresh to re-pull.
async Task<string?> FetchParcelImageAsync(string apn)
{
    var dir = Path.Combine(app.Environment.ContentRootPath, "storage", "parcel_maps");
    Directory.CreateDirectory(dir);
    var file = Path.Combine(dir, $"{apn}.{MapCacheVersion}.png");
    if (File.Exists(file)) return file;

    var node = LoadParcelIndex().TryGetValue(apn, out var p) ? p : null;
    var rings = ParseWktRings(Str(node?["shape"]) ?? "");
    if (rings.Count == 0) return null;
    var (xmin, ymin, xmax, ymax, imgW, imgH) = MapExtent(rings);

    await MapLock.WaitAsync();
    try
    {
        if (!File.Exists(file)) // another request may have filled it meanwhile
        {
            var url = $"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
                + $"?bbox={xmin:R},{ymin:R},{xmax:R},{ymax:R}&bboxSR=102100&imageSR=102100"
                + $"&size={imgW},{imgH}&format=png32&f=image";
            using var resp = await MapHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            if (!resp.IsSuccessStatusCode)
            {
                File.WriteAllText(Path.Combine(dir, "last_error.txt"),
                    $"HTTP {(int)resp.StatusCode}\nURL: {url}\n{(await resp.Content.ReadAsStringAsync()).Substring(0, 500)}");
                return null;
            }
            var body = await resp.Content.ReadAsByteArrayAsync();
            using var ms = new MemoryStream(body);
            using var img = new System.Drawing.Bitmap(ms);
            using var g = System.Drawing.Graphics.FromImage(img);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            // Street names first (under the outline/label).
            await DrawStreetLabelsAsync(g, xmin, ymin, xmax, ymax, img.Width, img.Height);
            PointF Pt(ValueTuple<double, double> l)
            {
                double mx = MercX(l.Item1);
                double my = MercY(l.Item2);
                return new PointF(
                    (float)((mx - xmin) / (xmax - xmin) * img.Width),
                    (float)((ymax - my) / (ymax - ymin) * img.Height));
            }
            foreach (var ring in rings)
            {
                var pts = ring.Select(Pt).ToArray();
                if (pts.Length < 3) continue;
                using (var fill = new System.Drawing.SolidBrush(Color.FromArgb(46, 220, 38, 38)))
                    g.FillPolygon(fill, pts);
                using (var pen = new System.Drawing.Pen(Color.FromArgb(255, 220, 38, 38), 4f)
                {
                    DashStyle = System.Drawing.Drawing2D.DashStyle.Custom,
                    DashPattern = new float[] { 8f, 5f },
                    StartCap = System.Drawing.Drawing2D.LineCap.Round,
                    EndCap = System.Drawing.Drawing2D.LineCap.Round,
                })
                    g.DrawPolygon(pen, pts);
            }
            var c = Centroid(rings);
            if (c is not null) DrawApnLabel(g, apn, Pt(c.Value), img.Width, img.Height);
            await using var fs = File.Create(file + ".tmp");
            img.Save(fs, System.Drawing.Imaging.ImageFormat.Png);
            await fs.DisposeAsync();
            File.Move(file + ".tmp", file);
        }
    }
    catch (Exception ex)
    {
        try { File.WriteAllText(Path.Combine(dir, "last_error.txt"), ex.ToString()); } catch { /* ignore */ }
    }
    finally { MapLock.Release(); }
    return File.Exists(file) ? file : null;
}



// Serves the cached satellite+outline PNG (downloads & composites on first use).
app.MapGet("/api/parcel-image/{apn}", async (HttpContext ctx, string apn) =>
{
    if (!apn.All(char.IsDigit)) return Results.BadRequest(new { error = "invalid apn" });
    var file = await FetchParcelImageAsync(apn);
    if (file is null) return Results.NotFound(new { error = "imagery unavailable" });
    ctx.Response.Headers["Cache-Control"] = "public, max-age=3600";
    return Results.File(file, "image/png");
});

// Force re-download (the ↻ Refresh button). Deletes the cache and re-pulls.
app.MapPost("/api/parcel-image/{apn}/refresh", async (string apn) =>
{
    if (!apn.All(char.IsDigit)) return Results.BadRequest(new { error = "invalid apn" });
    var dir = Path.Combine(app.Environment.ContentRootPath, "storage", "parcel_maps");
    var f = Path.Combine(dir, $"{apn}.{MapCacheVersion}.png");
    if (File.Exists(f)) File.Delete(f);
    var fresh = await FetchParcelImageAsync(apn);
    return fresh is null ? Results.NotFound(new { error = "imagery unavailable" }) : Results.Ok(new { ok = true });
});

// ---------------------------------------------------------------------------
// Multi-parcel (portfolio) map: combine all parcel polygons into one image.
// ---------------------------------------------------------------------------
app.MapGet("/api/parcel-map/multi", (string? apns) =>
{
    if (string.IsNullOrWhiteSpace(apns)) return Results.BadRequest(new { error = "missing apns" });
    var list = apns.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(s => s.All(char.IsDigit)).ToList();
    if (list.Count == 0) return Results.BadRequest(new { error = "no valid apns" });
    var idx = LoadParcelIndex();
    var allRings = new List<List<(double Lng, double Lat)>>();
    foreach (var apn in list)
    {
        var node = idx.TryGetValue(apn, out var p) ? p : null;
        allRings.AddRange(ParseWktRings(Str(node?["shape"]) ?? ""));
    }
    if (allRings.Count == 0) return Results.NotFound(new { error = "no geometry for any apn" });
    var (xmin, ymin, xmax, ymax, _, _) = MapExtent(allRings);
    return Results.Ok(new JsonObject {
        ["apns"] = new JsonArray(list.Select(a => (JsonNode)a).ToArray()),
        ["bbox"] = new JsonArray(xmin, ymin, xmax, ymax),
    });
});

// Combined satellite image with all parcel outlines, APN labels, and street
// names drawn. Per-parcel rings are kept so each APN is labeled at its own
// centroid.
async Task<string?> FetchMultiParcelImageAsync(List<string> apns)
{
    var dir = Path.Combine(app.Environment.ContentRootPath, "storage", "parcel_maps");
    Directory.CreateDirectory(dir);
    var key = string.Join("_", apns.OrderBy(a => a));
    var file = Path.Combine(dir, $"multi_{key}.{MapCacheVersion}.png");
    if (File.Exists(file)) return file;
    var idx = LoadParcelIndex();
    var perParcel = new List<(string Apn, List<List<(double Lng, double Lat)>> Rings)>();
    var allRings = new List<List<(double Lng, double Lat)>>();
    foreach (var apn in apns)
    {
        var node = idx.TryGetValue(apn, out var p) ? p : null;
        var rings = ParseWktRings(Str(node?["shape"]) ?? "");
        if (rings.Count > 0)
        {
            perParcel.Add((apn, rings));
            allRings.AddRange(rings);
        }
    }
    if (allRings.Count == 0) return null;
    // Tighter padding so a clustered portfolio fills the frame (the adaptive
    // aspect ratio in MapExtent then picks a frame that fits the cluster shape).
    var (xmin, ymin, xmax, ymax, imgW, imgH) = MapExtent(allRings, padding: 0.15);
    await MapLock.WaitAsync();
    try
    {
        if (!File.Exists(file))
        {
            var url = $"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
                + $"?bbox={xmin:R},{ymin:R},{xmax:R},{ymax:R}&bboxSR=102100&imageSR=102100"
                + $"&size={imgW},{imgH}&format=png32&f=image";
            using var resp = await MapHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            if (!resp.IsSuccessStatusCode) return null;
            var body = await resp.Content.ReadAsByteArrayAsync();
            using var ms = new MemoryStream(body);
            using var img = new System.Drawing.Bitmap(ms);
            using var g = System.Drawing.Graphics.FromImage(img);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            // Street names first (under the outlines/labels).
            await DrawStreetLabelsAsync(g, xmin, ymin, xmax, ymax, img.Width, img.Height);
            PointF Pt(ValueTuple<double, double> l)
            {
                double mx = MercX(l.Item1), my = MercY(l.Item2);
                return new PointF(
                    (float)((mx - xmin) / (xmax - xmin) * img.Width),
                    (float)((ymax - my) / (ymax - ymin) * img.Height));
            }
            foreach (var (_, rings) in perParcel)
                foreach (var ring in rings)
                {
                    var pts = ring.Select(Pt).ToArray();
                    if (pts.Length < 3) continue;
                    using (var fill = new System.Drawing.SolidBrush(Color.FromArgb(46, 220, 38, 38)))
                        g.FillPolygon(fill, pts);
                    using (var pen = new System.Drawing.Pen(Color.FromArgb(255, 220, 38, 38), 4f)
                    {
                        DashStyle = System.Drawing.Drawing2D.DashStyle.Custom,
                        DashPattern = new float[] { 8f, 5f },
                        StartCap = System.Drawing.Drawing2D.LineCap.Round,
                        EndCap = System.Drawing.Drawing2D.LineCap.Round,
                    })
                        g.DrawPolygon(pen, pts);
                }
            // APN labels at each parcel centroid. Font scales with the frame so
            // it stays proportional to the (now larger) parcels.
            float labelFont = img.Width * 0.011f;
            foreach (var (apn, rings) in perParcel)
            {
                var c = Centroid(rings);
                if (c is null) continue;
                DrawApnLabel(g, apn, Pt(c.Value), img.Width, img.Height, labelFont);
            }
            await using var fs = File.Create(file + ".tmp");
            img.Save(fs, System.Drawing.Imaging.ImageFormat.Png);
            await fs.DisposeAsync();
            File.Move(file + ".tmp", file);
        }
    }
    catch { /* ignore */ }
    finally { MapLock.Release(); }
    return File.Exists(file) ? file : null;
}

app.MapGet("/api/parcel-image/multi", async (HttpContext ctx, string? apns) =>
{
    if (string.IsNullOrWhiteSpace(apns)) return Results.BadRequest(new { error = "missing apns" });
    var list = apns.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(s => s.All(char.IsDigit)).ToList();
    if (list.Count == 0) return Results.BadRequest(new { error = "no valid apns" });
    var file = await FetchMultiParcelImageAsync(list);
    if (file is null) return Results.NotFound(new { error = "imagery unavailable" });
    ctx.Response.Headers["Cache-Control"] = "public, max-age=3600";
    return Results.File(file, "image/png");
});

// ---------------------------------------------------------------------------
// Parcel photos: user-attached images per APN under storage/parcel_photos/.
// Shown on the PIN page wherever the PIN is referenced in the app.
// ---------------------------------------------------------------------------
string? ParcelPhotosDir(string apn) =>
    apn.All(char.IsDigit) ? Path.Combine(app.Environment.ContentRootPath, "storage", "parcel_photos", apn) : null;

app.MapGet("/api/parcel-photos/{apn}", (string apn) =>
{
    var dir = ParcelPhotosDir(apn);
    if (dir is null) return Results.BadRequest(new { error = "invalid apn" });
    var files = Directory.Exists(dir)
        ? Directory.GetFiles(dir).Where(f => !f.EndsWith(".tmp")).ToList()
        : new List<string>();
    var photos = files
        .Select(f => new
        {
            name = Path.GetFileName(f),
            url = $"/api/parcel-photos/{apn}/{Uri.EscapeDataString(Path.GetFileName(f))}",
            size = new FileInfo(f).Length,
            added = File.GetLastWriteTime(f).ToString("yyyy-MM-dd HH:mm"),
        })
        .OrderBy(p => p.added)
        .ToList();
    return Results.Ok(photos);
});

app.MapPost("/api/parcel-photos/{apn}", async (string apn, HttpContext ctx) =>
{
    var dir = ParcelPhotosDir(apn);
    if (dir is null) return Results.BadRequest(new { error = "invalid apn" });
    if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "expected multipart form" });
    var form = await ctx.Request.ReadFormAsync();
    if (form.Files.Count == 0) return Results.BadRequest(new { error = "no files" });
    Directory.CreateDirectory(dir);
    var saved = new List<string>();
    foreach (var f in form.Files)
    {
        var ext = Path.GetExtension(f.FileName).ToLowerInvariant();
        if (ext is not (".jpg" or ".jpeg" or ".png" or ".gif" or ".webp")) ext = ".jpg";
        var name = $"{DateTime.Now:yyyyMMdd_HHmmss}_{Guid.NewGuid():N}{ext}";
        await using var fs = File.Create(Path.Combine(dir, name));
        await f.CopyToAsync(fs);
        saved.Add(name);
    }
    return Results.Ok(new { saved });
});

app.MapGet("/api/parcel-photos/{apn}/{name}", (string apn, string name) =>
{
    var dir = ParcelPhotosDir(apn);
    if (dir is null || name.Contains('/') || name.Contains('\\') || name.Contains(".."))
        return Results.BadRequest(new { error = "invalid" });
    var file = Path.Combine(dir, name);
    if (!File.Exists(file)) return Results.NotFound(new { error = "not found" });
    var ct = Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".png" => "image/png", ".gif" => "image/gif", ".webp" => "image/webp", _ => "image/jpeg",
    };
    return Results.File(file, ct);
});

app.MapDelete("/api/parcel-photos/{apn}/{name}", (string apn, string name) =>
{
    var dir = ParcelPhotosDir(apn);
    if (dir is null || name.Contains('/') || name.Contains('\\') || name.Contains(".."))
        return Results.BadRequest(new { error = "invalid" });
    var file = Path.Combine(dir, name);
    if (File.Exists(file)) File.Delete(file);
    return Results.Ok(new { ok = true });
});

// ---------------------------------------------------------------------------
// Rule 2 batch evaluation (county transfer file -> screened buckets +
// auto-enrolled transfer comps). See Rule2.cs.
// ---------------------------------------------------------------------------
Rule2.Map(app, Open, app.Environment.ContentRootPath);

// ---------------------------------------------------------------------------
// Static files (the vanilla JS frontend)
// ---------------------------------------------------------------------------
// no-store: this is a local dev tool — never let the browser cache the
// frontend. Heuristic caching was serving stale JS after edits, which masked
// fixes (e.g. a render hardening change never reached the user's browser).
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = (ctx) =>
    {
        ctx.Context.Response.Headers["Cache-Control"] = "no-store";
    },
});
app.MapFallbackToFile("index.html");

app.Run("http://127.0.0.1:5000");

// Pull denormalized summary fields out of a portfolio's main subject parcel
// (parcels[0]). The denormalized columns (apn/address/city/final_value) always
// reflect the main subject so the list view and finalize flow keep working.
static (string? apn, string? address, string? city, string? reportDate, double? finalValue, string? caseType) ExtractSummary(Portfolio pf)
{
    var data = pf.MainSubject;
    var p = data.Property;
    return (
        string.IsNullOrWhiteSpace(p.Apn) ? null : p.Apn,
        string.IsNullOrWhiteSpace(p.Address) ? null : p.Address,
        string.IsNullOrWhiteSpace(p.City) ? null : p.City,
        string.IsNullOrWhiteSpace(p.ReportDate) ? null : p.ReportDate,
        data.Reconciliation.FinalValue,
        string.IsNullOrWhiteSpace(p.CaseType) ? null : p.CaseType);
}

// ---------------------------------------------------------------------------
// Canonical JSON — deterministic serialization for content hashing.
// Ported from src/lib/snapshot.ts `canonicalize`: keys sorted, undefined
// (absent) entries dropped, numbers in shortest round-trip form.
// ---------------------------------------------------------------------------
static string Canonicalize(JsonNode? value)
{
    if (value is null) return "null";
    if (value is JsonValue v)
    {
        if (v.TryGetValue<string>(out var s)) return JsonSerializer.Serialize(s);
        if (v.TryGetValue<bool>(out var b)) return b ? "true" : "false";
        if (v.TryGetValue<double>(out var d)) return d.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        return v.ToJsonString();
    }
    if (value is JsonArray arr)
        return "[" + string.Join(",", arr.Select(Canonicalize)) + "]";
    if (value is JsonObject obj)
    {
        var entries = obj
            .Where(kv => kv.Value is not null)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => JsonSerializer.Serialize(kv.Key) + ":" + Canonicalize(kv.Value))
            .ToList();
        return "{" + string.Join(",", entries) + "}";
    }
    return value.ToJsonString();
}

// Convert a finalized appraisal into a permanent CompRecord.
// Ported from RepositoryContext.tsx `snapshotToCompRecord`; now typed end
// to end (AppraisalData in, CompRecord out, AppraisalJson on the wire).
static CompRecord SnapshotToCompRecord(AppraisalData data, string apn, string? address, string completedDate, double finalValue)
{
    var p = data.Property;
    var imp = data.Improvements.Primary;
    var land = data.Land;
    var yearBuilt = imp.YearBuilt;
    return new CompRecord
    {
        Apn = apn,
        Address = address ?? p.Address,
        City = p.City,
        SaleDate = completedDate.Length >= 10 ? completedDate[..10] : completedDate,
        Price = finalValue,
        Age = yearBuilt > 0 ? Math.Max(0, DateTime.UtcNow.Year - yearBuilt) : 0,
        Quality = imp.Quality,
        Condition = imp.Condition,
        LandArea = land.Acres,
        BuildingArea = imp.GrossFloorArea,
        ClearHeight = 0,
        Zoning = land.Zoning,
        SourceReport = apn,
        PropertyType = imp.Type,
        SubjectApn = "",
        PhotoUrl = "",
        // Transfer-completion matching: a Rule 2 transfer is "completed" when
        // a finalized appraisal is archived for the same document number +
        // effective date.
        DocNumber = p.TransferDocumentNumber,
        EffectiveDate = p.EffectiveDate,
        // Case type (transfer | appeal | stipulation | general) so the final
        // archive can be sectioned by case type.
        CaseType = string.IsNullOrWhiteSpace(p.CaseType) ? "transfer" : p.CaseType,
        // The 12 grid adjustments default to 0 for repository comps.
    };
}

static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
// __refresh_marker__

