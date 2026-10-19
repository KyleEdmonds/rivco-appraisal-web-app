using Microsoft.Data.Sqlite;
using System.Text.Json;
using System.Text.Json.Nodes;

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
        -- The old server-side CSV comp repository is retired: only permanent
        -- comps (finalized appraisals) may exist server-side. CSV-imported
        -- comps are machine-local (browser localStorage).
        DROP TABLE IF EXISTS comps;
        """;
    cmd.ExecuteNonQuery();
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
    cmd.CommandText = "SELECT id, apn, address, city, report_date, final_value, updated_at FROM appraisals ORDER BY updated_at DESC";
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
            ["updatedAt"] = reader.IsDBNull(6) ? null : reader.GetString(6),
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
    var data = cmd.ExecuteScalar() as string;
    return data is null ? Results.NotFound() : Results.Ok(new { id, data = JsonNode.Parse(data) });
});

app.MapPost("/api/appraisals", async (HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var data = body?["data"] ?? body;
    if (data is null) return Results.BadRequest(new { error = "missing 'data'" });

    var id = Guid.NewGuid().ToString("N");
    var now = DateTime.UtcNow.ToString("o");
    var (apn, address, city, reportDate, finalValue) = ExtractSummary(data);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO appraisals (id, apn, address, city, report_date, final_value, data, created_at, updated_at)
        VALUES ($id, $apn, $address, $city, $rd, $fv, $data, $now, $now)
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$fv", (object?)finalValue ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$data", data.ToJsonString());
    cmd.Parameters.AddWithValue("$now", now);
    cmd.ExecuteNonQuery();
    return Results.Ok(new { id });
});

app.MapPut("/api/appraisals/{id}", async (string id, HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var data = body?["data"] ?? body;
    if (data is null) return Results.BadRequest(new { error = "missing 'data'" });

    var now = DateTime.UtcNow.ToString("o");
    var (apn, address, city, reportDate, finalValue) = ExtractSummary(data);

    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        UPDATE appraisals SET apn=$apn, address=$address, city=$city, report_date=$rd,
        final_value=$fv, data=$data, updated_at=$now WHERE id=$id
        """;
    cmd.Parameters.AddWithValue("$id", id);
    cmd.Parameters.AddWithValue("$apn", (object?)apn ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$address", (object?)address ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$city", (object?)city ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$rd", (object?)reportDate ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$fv", (object?)finalValue ?? DBNull.Value);
    cmd.Parameters.AddWithValue("$data", data.ToJsonString());
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
// Comp repository (single document)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Permanent comps — finalized appraisals archived as permanent sales comps.
// This is the ONLY comp data that lives server-side. CSV-imported comps are
// machine-local (browser localStorage) and never reach the server.
// ---------------------------------------------------------------------------
app.MapGet("/api/permanent-comps", () =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT data FROM permanent_comps ORDER BY created_at DESC";
    using var reader = cmd.ExecuteReader();
    var list = new List<object>();
    while (reader.Read())
    {
        list.Add(JsonNode.Parse(reader.GetString(0)));
    }
    return Results.Ok(list);
});

app.MapPost("/api/finalize", async (HttpContext ctx) =>
{
    var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
    var data = body?["data"] as JsonObject;
    if (data is null) return Results.BadRequest(new { error = "missing 'data'" });
    var (apn, address, city, reportDate, finalValue) = ExtractSummary(data);
    if (string.IsNullOrWhiteSpace(apn)) return Results.BadRequest(new { error = "appraisal has no APN" });

    // Canonical SHA-256 of the appraisal content (dedup key, with APN).
    var contentHash = Convert.ToHexStringLower(
        System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Canonicalize(data))));
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

    var comp = SnapshotToCompRecord(data, apn, address, now, finalValue ?? 0);
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
        cmd.Parameters.AddWithValue("$data", comp.ToJsonString());
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
    return data is null
        ? Results.Ok(new { schemaVersion = "1.0", county = "", countyName = "", officeName = "", sealUrl = "" })
        : Results.Ok(JsonNode.Parse(data));
});

app.MapPut("/api/tenant", async (HttpContext ctx) =>
{
    var data = await JsonNode.ParseAsync(ctx.Request.Body);
    if (data is null) return Results.BadRequest(new { error = "invalid json" });
    var now = DateTime.UtcNow.ToString("o");
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO tenant (id, data, updated_at) VALUES ('config', $data, $now)
        ON CONFLICT(id) DO UPDATE SET data=$data, updated_at=$now
        """;
    cmd.Parameters.AddWithValue("$data", data.ToJsonString());
    cmd.Parameters.AddWithValue("$now", now);
    cmd.ExecuteNonQuery();
    return Results.Ok(new { saved = true });
});

// ---------------------------------------------------------------------------
// Static files (the vanilla JS frontend)
// ---------------------------------------------------------------------------
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run("http://127.0.0.1:5000");

// Pull denormalized summary fields out of the appraisal JSON document.
static (string? apn, string? address, string? city, string? reportDate, double? finalValue) ExtractSummary(JsonNode? data)
{
    string? apn = null, address = null, city = null, reportDate = null;
    double? finalValue = null;
    if (data is JsonObject o)
    {
        if (o["property"] is JsonObject p)
        {
            apn = Str(p["apn"]);
            address = Str(p["address"]);
            city = Str(p["city"]);
            reportDate = Str(p["reportDate"]);
        }
        if (o["reconciliation"] is JsonObject r && r["finalValue"] is JsonValue v && v.TryGetValue<double>(out var fv))
            finalValue = fv;
    }
    return (apn, address, city, reportDate, finalValue);
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
// Ported from RepositoryContext.tsx `snapshotToCompRecord`.
static JsonObject SnapshotToCompRecord(JsonObject data, string apn, string? address, string completedDate, double finalValue)
{
    var p = data["property"] as JsonObject;
    var imp = data["improvements"]?["primary"] as JsonObject;
    var land = data["land"] as JsonObject;
    var yearBuilt = Num(imp?["yearBuilt"]);
    var comp = new JsonObject
    {
        ["apn"] = apn,
        ["address"] = address ?? Str(p?["address"]) ?? "",
        ["city"] = Str(p?["city"]) ?? "",
        ["saleDate"] = completedDate.Length >= 10 ? completedDate[..10] : completedDate,
        ["price"] = finalValue,
        ["age"] = yearBuilt > 0 ? Math.Max(0, DateTime.UtcNow.Year - (int)yearBuilt) : 0,
        ["quality"] = Str(imp?["quality"]) ?? "",
        ["condition"] = Str(imp?["condition"]) ?? "",
        ["landArea"] = Num(land?["acres"]),
        ["buildingArea"] = Num(imp?["grossFloorArea"]),
        ["clearHeight"] = 0,
        ["zoning"] = Str(land?["zoning"]) ?? "",
        ["isArmsLength"] = true,
        ["sourceReport"] = apn,
        ["propertyType"] = Str(imp?["type"]) ?? "",
        ["subjectApn"] = "",
        ["photoUrl"] = "",
    };
    foreach (var f in new[]
    {
        "adjBuildingSize", "adjLocation", "adjCornerSite", "adjAge", "adjQuality",
        "adjCondition", "adjTenantsUse", "adjOccupancy", "adjLandBldgRatio",
        "adjFreeway", "adjMarketConditions", "adjConditionOfSale",
    })
    {
        comp[f] = 0;
    }
    return comp;
}

static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
static double Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;

