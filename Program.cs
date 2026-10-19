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
        CREATE TABLE IF NOT EXISTS comps (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS tenant (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT
        );
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
app.MapGet("/api/comps", () =>
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT data FROM comps WHERE id = 'repo'";
    var data = cmd.ExecuteScalar() as string;
    return data is null
        ? Results.Ok(new { schemaVersion = "1.0", county = "", comparables = Array.Empty<object>() })
        : Results.Ok(JsonNode.Parse(data));
});

app.MapPut("/api/comps", async (HttpContext ctx) =>
{
    var data = await JsonNode.ParseAsync(ctx.Request.Body);
    if (data is null) return Results.BadRequest(new { error = "invalid json" });
    var now = DateTime.UtcNow.ToString("o");
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO comps (id, data, updated_at) VALUES ('repo', $data, $now)
        ON CONFLICT(id) DO UPDATE SET data=$data, updated_at=$now
        """;
    cmd.Parameters.AddWithValue("$data", data.ToJsonString());
    cmd.Parameters.AddWithValue("$now", now);
    cmd.ExecuteNonQuery();
    return Results.Ok(new { saved = true });
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
            apn = p["apn"]?.GetValue<string>();
            address = p["address"]?.GetValue<string>();
            city = p["city"]?.GetValue<string>();
            reportDate = p["reportDate"]?.GetValue<string>();
        }
        if (o["reconciliation"] is JsonObject r && r["finalValue"] is JsonValue v && v.TryGetValue<double>(out var fv))
            finalValue = fv;
    }
    return (apn, address, city, reportDate, finalValue);
}

