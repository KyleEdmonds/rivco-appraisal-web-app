using Microsoft.Data.Sqlite;
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
            effective_date TEXT,
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

    // Migration: add the effective_date column to appraisals for databases
    // created before it existed. Denormalized from the main subject so the
    // "Save as WIP" flow can detect an existing WIP for the same APN +
    // effective date without parsing every stored document. Idempotent.
    using (var chk = conn.CreateCommand())
    {
        chk.CommandText = "SELECT COUNT(*) FROM pragma_table_info('appraisals') WHERE name = 'effective_date'";
        if (Convert.ToInt32(chk.ExecuteScalar()) == 0)
        {
            using var alt = conn.CreateCommand();
            alt.CommandText = "ALTER TABLE appraisals ADD COLUMN effective_date TEXT";
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
    cmd.CommandText = "SELECT id, apn, address, city, report_date, effective_date, final_value, case_type, updated_at FROM appraisals ORDER BY updated_at DESC";
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
            ["effectiveDate"] = reader.IsDBNull(5) ? null : reader.GetString(5),
            ["finalValue"] = reader.IsDBNull(6) ? null : reader.GetDouble(6),
            ["caseType"] = reader.IsDBNull(7) ? null : reader.GetString(7),
            ["updatedAt"] = reader.IsDBNull(8) ? null : reader.GetString(8),
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
    var (apn, address, city, reportDate, effectiveDate, finalValue, caseType) = ExtractSummary(pf);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO appraisals (id, apn, address, city, report_date, effective_date, final_value, case_type, data, created_at, updated_at)
        VALUES ($id, $apn, $address, $city, $rd, $ed, $fv, $ct, $data, $now, $now)
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$ed", (object?)effectiveDate ?? DBNull.Value);
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
    var (apn, address, city, reportDate, effectiveDate, finalValue, caseType) = ExtractSummary(pf);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        UPDATE appraisals SET apn=$apn, address=$address, city=$city, report_date=$rd,
        effective_date=$ed, final_value=$fv, case_type=$ct, data=$data, updated_at=$now WHERE id=$id
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$ed", (object?)effectiveDate ?? DBNull.Value);
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
    var (apn, address, city, reportDate, _, finalValue, caseType) = ExtractSummary(pf);
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
// Parcel data — the full county assessment record per APN from
// input/master_parcel_list.json (the search universe): a single JSON object of
// APN -> parcel record, built weekly by storage/build_master_json.py from the
// county SpatialEst CSVs + GIS parcel geometry. Served as-is so the UI can use
// any field (transfer history, assessment history, shape, building details,
// ...). The file is re-read when its mtime changes, so a fresh build is picked
// up without restarting the app. (Replaces the old master_parcel_list.csv /
// RivCoViewJSON pipeline.)
// ---------------------------------------------------------------------------
Dictionary<string, JsonObject>? _parcelIndex = null;
DateTime _parcelStamp = DateTime.MinValue;
var _parcelLock = new object();

// Load (and mtime-refresh) the parcel index from the master list JSON. Shared
// by the parcel-data and parcel-search endpoints.
Dictionary<string, JsonObject> LoadParcelIndex()
{
    lock (_parcelLock)
    {
        var file = Path.Combine(app.Environment.ContentRootPath, "input", "master_parcel_list.json");
        var stamp = File.Exists(file) ? new FileInfo(file).LastWriteTimeUtc : DateTime.MinValue;
        if (_parcelIndex is null || stamp != _parcelStamp)
        {
            var idx = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            if (File.Exists(file))
            {
                try
                {
                    var root = JsonNode.Parse(File.ReadAllText(file, Encoding.UTF8)) as JsonObject;
                    if (root is not null)
                        foreach (var (apn, node) in root)
                            if (node is JsonObject obj) idx[apn] = obj;
                }
                catch { /* keep the previous in-memory copy on a bad read */ }
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
static (string? apn, string? address, string? city, string? reportDate, string? effectiveDate, double? finalValue, string? caseType) ExtractSummary(Portfolio pf)
{
    var data = pf.MainSubject;
    var p = data.Property;
    return (
        string.IsNullOrWhiteSpace(p.Apn) ? null : p.Apn,
        string.IsNullOrWhiteSpace(p.Address) ? null : p.Address,
        string.IsNullOrWhiteSpace(p.City) ? null : p.City,
        string.IsNullOrWhiteSpace(p.ReportDate) ? null : p.ReportDate,
        string.IsNullOrWhiteSpace(p.EffectiveDate) ? null : p.EffectiveDate,
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

