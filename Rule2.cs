// ---------------------------------------------------------------------------
// Rule2.cs — Rule 2 batch evaluation (California Property Tax Rule 2,
// "Full Cash Value").
//
// Input: the county transfer file (xlsx or csv) dropped into input/.
// Scope: commercial classes only (ClassCat = Commercial / CommercialDE).
//
// Market sales (Consid > 0) are screened against same-class peers:
//   improved: >= 1 peer within 5%  -> auto_enrolled (presumption confirmed)
//             closest peer <= 15%  -> borderline
//             otherwise            -> below_market / above_market (vs peer avg)
//   land:     >= 2 peers within 2% -> auto_enrolled
//             otherwise            -> land_review
// No-value transfers (Consid = 0) -> no_value, classified by LocalRatioCd.
//
// The full raw commercial extract (all commercial rows) is persisted to transfer_comps — a separate
// server-side comp store from permanent_comps (finalized appraisals).
// No cross-writes between the two stores; transfer_comps has no delete
// endpoint. Both stores are served to the UI comp repository together.
// ---------------------------------------------------------------------------
using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RivCo;

public static class Rule2
{
    public static readonly string[] CommercialCats = { "Commercial", "CommercialDE" };
    public static readonly string[] BucketNames =
        { "auto_enrolled", "borderline", "below_market", "above_market", "land_review", "no_value" };

    const double ImprovedThreshold = 0.05;  // Rule 2(b): significant deviation > 5%
    const double ImprovedBorderline = 0.15;
    const double LandThreshold = 0.02;
    const int LandMinPeers = 2;

    // Stored run summaries are read back as raw JSON by the UI, which expects
    // camelCase keys (matching the rest of the API). Serialize with camelCase
    // so the persisted summary matches what the frontend reads.
    private static readonly JsonSerializerOptions SummaryJsonOpts =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public record TransferRow(
        string Apn, string RecordDate, string DocDate,
        string ClassCd, string ClassCat, string ClassDesc,
        string RatioCd, string RatioDescr,
        double? Price,
        string Reappraisability, string ReappraisalCategory);

    public record ScreenedRow(TransferRow Row, string Bucket, double? ClosestDev, double? PeerAvg, int PeerCount);

    public class Rule2Summary
    {
        public string SourceFile { get; set; } = "";
        public string RanAt { get; set; } = "";
        public int TotalRows { get; set; }
        public int CommercialRows { get; set; }
        public int MarketSales { get; set; }
        public int NoValue { get; set; }
        public Dictionary<string, int> Buckets { get; set; } = new();
        public List<Dictionary<string, object?>> ByClass { get; set; } = new();
    }

    public class Rule2Run
    {
        public Rule2Summary Summary = new();
        public List<ScreenedRow> Rows = new();
        public Dictionary<string, string> BucketCsv = new();
    }

    // ------------------------------------------------------------------
    // File parsing (streaming xlsx + csv). Values are preserved verbatim
    // (data fidelity) — no rounding or transformation at ingestion.
    // ------------------------------------------------------------------

    public static List<Dictionary<string, string>> ReadFile(string path) =>
        path.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? ReadCsv(path) : ReadXlsx(path);

    public static List<Dictionary<string, string>> ReadXlsx(string path)
    {
        using var zip = ZipFile.OpenRead(path);

        // Shared strings table.
        var strings = new List<string>();
        var ssEntry = zip.GetEntry("xl/sharedStrings.xml");
        if (ssEntry is not null)
        {
            using var sr = new StreamReader(ssEntry.Open());
            using var reader = XmlReader.Create(sr);
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "si") continue;
                var sb = new StringBuilder();
                while (reader.Read())
                {
                    if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "t")
                    {
                        sb.Append(reader.ReadElementContentAsString());
                        // ReadElementContentAsString leaves the reader at </t>'s
                        // parent. For a plain <si><t>..</t></si> that is </si> —
                        // break now, or the loop's next Read() skips past it.
                        if (reader.NodeType == XmlNodeType.EndElement && reader.LocalName == "si")
                            break;
                    }
                    else if (reader.NodeType == XmlNodeType.EndElement && reader.LocalName == "si")
                        break;
                }
                strings.Add(sb.ToString());
            }
        }

        // First worksheet, streamed row by row.
        var sheetEntry = zip.GetEntry("xl/worksheets/sheet1.xml")
            ?? zip.Entries.First(e => e.FullName.StartsWith("xl/worksheets/sheet", StringComparison.OrdinalIgnoreCase));
        var rows = new List<Dictionary<string, string>>();
        Dictionary<int, string>? header = null;
        using (var sr = new StreamReader(sheetEntry.Open()))
        using (var reader = XmlReader.Create(sr))
        {
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "row") continue;
                var cells = new Dictionary<string, string>();
                var headerRow = header is null;
                if (headerRow) header = new Dictionary<int, string>();
                while (reader.Read())
                {
                    if (reader.NodeType == XmlNodeType.EndElement && reader.LocalName == "row") break;
                    if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "c") continue;
                    var refAttr = reader.GetAttribute("r") ?? "";
                    var type = reader.GetAttribute("t");
                    string? val = null;
                    while (reader.Read())
                    {
                        if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "v")
                        { val = reader.ReadElementContentAsString(); break; }
                        if (reader.NodeType == XmlNodeType.EndElement && reader.LocalName == "c") break;
                    }
                    if (type == "s" && val is not null) val = strings[int.Parse(val)];
                    if (val is null || refAttr.Length == 0) continue;
                    var col = ColIndex(refAttr);
                    if (headerRow) header[col] = val;
                    else if (header!.TryGetValue(col, out var name)) cells[name] = val;
                }
                if (headerRow) continue;
                rows.Add(cells);
            }
        }
        return rows;
    }

    public static List<Dictionary<string, string>> ReadCsv(string path)
    {
        var lines = File.ReadLines(path).ToList();
        if (lines.Count == 0) return new List<Dictionary<string, string>>();
        var header = SplitCsvLine(lines[0]);
        var rows = new List<Dictionary<string, string>>();
        for (var i = 1; i < lines.Count; i++)
        {
            if (string.IsNullOrWhiteSpace(lines[i])) continue;
            var vals = SplitCsvLine(lines[i]);
            var cells = new Dictionary<string, string>();
            for (var c = 0; c < header.Count && c < vals.Count; c++)
                if (!string.IsNullOrEmpty(header[c])) cells[header[c]] = vals[c];
            rows.Add(cells);
        }
        return rows;
    }

    static List<string> SplitCsvLine(string line)
    {
        var result = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;
        foreach (var ch in line)
        {
            if (ch == '"') { inQuotes = !inQuotes; continue; }
            if (ch == ',' && !inQuotes) { result.Add(sb.ToString()); sb.Clear(); continue; }
            sb.Append(ch);
        }
        result.Add(sb.ToString());
        return result;
    }

    static int ColIndex(string cellRef)
    {
        var idx = 0;
        foreach (var ch in cellRef)
        {
            if (ch < 'A' || ch > 'Z') break;
            idx = idx * 26 + (ch - 'A' + 1);
        }
        return idx - 1;
    }

    // Excel serial date -> ISO. Non-numeric values pass through untouched.
    public static string ToIsoDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        if (double.TryParse(raw, NumberStyles.Any, CultureInfo.InvariantCulture, out var d) && d > 20000 && d < 80000)
            return new DateTime(1899, 12, 30).AddDays(d).ToString("yyyy-MM-dd");
        return raw.Trim();
    }

    // ------------------------------------------------------------------
    // Screening
    // ------------------------------------------------------------------

    public static Rule2Run Run(List<Dictionary<string, string>> records, string sourceFile)
    {
        var run = new Rule2Run();
        var s = run.Summary;
        s.SourceFile = sourceFile;
        s.RanAt = DateTime.UtcNow.ToString("o");
        s.TotalRows = records.Count;

        // Commercial classes only (the county's own ClassCat grouping).
        var commercial = new List<TransferRow>();
        foreach (var r in records)
        {
            var cat = Get(r, "ClassCat");
            if (!CommercialCats.Contains(cat)) continue;
            commercial.Add(new TransferRow(
                Apn: Get(r, "PIN"),
                RecordDate: ToIsoDate(Get(r, "RecordDate")),
                DocDate: ToIsoDate(Get(r, "DocDate")),
                ClassCd: Get(r, "ClassCd"),
                ClassCat: cat,
                ClassDesc: Get(r, "ClassCdDescr"),
                RatioCd: Get(r, "LocalRatioCd"),
                RatioDescr: Get(r, "LocalRatioCdDescr"),
                Price: ParsePrice(Get(r, "Consid")),
                Reappraisability: Get(r, "Reappraisability"),
                ReappraisalCategory: Get(r, "ReappraisalCategory")));
        }
        s.CommercialRows = commercial.Count;

        var market = commercial.Where(r => r.Price is > 0).ToList();
        var noValue = commercial.Where(r => r.Price is not > 0).ToList();
        s.MarketSales = market.Count;
        s.NoValue = noValue.Count;

        // Peer groups by class code (no size column in the county file yet —
        // the master parcel list will enable size-ratio filtering later).
        var groups = market.GroupBy(r => r.ClassCd).ToDictionary(g => g.Key, g => g.ToList());
        foreach (var row in market)
        {
            double? minDev = null;
            int within = 0, peerCount = 0;
            double peerSum = 0;
            var threshold = IsLand(row) ? LandThreshold : ImprovedThreshold;
            foreach (var p in groups[row.ClassCd])
            {
                if (ReferenceEquals(p, row)) continue;
                peerCount++;
                var dev = Math.Abs(row.Price.Value - p.Price.Value) / row.Price.Value;
                if (minDev is null || dev < minDev) minDev = dev;
                if (dev <= threshold) within++;
                peerSum += p.Price.Value;
            }
            double? peerAvg = peerCount > 0 ? peerSum / peerCount : null;
            string bucket;
            if (IsLand(row))
                bucket = within >= LandMinPeers ? "auto_enrolled" : "land_review";
            else if (within >= 1)
                bucket = "auto_enrolled";
            else if (minDev is not null && minDev <= ImprovedBorderline)
                bucket = "borderline";
            else
                bucket = peerAvg is not null && row.Price > peerAvg ? "above_market" : "below_market";
            run.Rows.Add(new ScreenedRow(row, bucket, minDev, peerAvg, peerCount));
        }
        foreach (var row in noValue)
            run.Rows.Add(new ScreenedRow(row, "no_value", null, null, 0));

        foreach (var b in BucketNames) s.Buckets[b] = 0;
        foreach (var r in run.Rows) s.Buckets[r.Bucket]++;

        foreach (var g in run.Rows.GroupBy(r => r.Row.ClassDesc).OrderByDescending(g => g.Count()))
        {
            var entry = new Dictionary<string, object?>
            {
                ["class"] = g.Key,
                ["classCd"] = g.First().Row.ClassCd,
                ["total"] = g.Count(),
            };
            foreach (var b in BucketNames) entry[b] = g.Count(r => r.Bucket == b);
            s.ByClass.Add(entry);
        }

        foreach (var b in BucketNames)
            run.BucketCsv[b] = ToCsv(run.Rows.Where(r => r.Bucket == b).ToList());
        return run;
    }

    static bool IsLand(TransferRow r) =>
        r.ClassDesc.Contains("Land", StringComparison.OrdinalIgnoreCase) ||
        r.ClassDesc.Contains("Vacant", StringComparison.OrdinalIgnoreCase);

    static double? ParsePrice(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return double.TryParse(raw.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : null;
    }

    static string Get(Dictionary<string, string> r, string key) => r.TryGetValue(key, out var v) ? v : "";

    // ------------------------------------------------------------------
    // Bucket CSV output. price_per_unit is $/SF for improved properties and
    // $/acre for land — empty until the master parcel list provides sizes.
    // ------------------------------------------------------------------

    static string ToCsv(List<ScreenedRow> rows)
    {
        var sb = new StringBuilder();
        sb.AppendLine("apn,record_date,doc_date,class_cd,class_cat,class_descr,ratio_cd,ratio_descr,consid,price_per_unit,closest_dev_pct,peer_avg,peer_count,county_reappraisability,county_reappraisal_category");
        foreach (var r in rows)
        {
            var t = r.Row;
            sb.Append(string.Join(",", new[]
            {
                Csv(t.Apn), Csv(t.RecordDate), Csv(t.DocDate), Csv(t.ClassCd), Csv(t.ClassCat), Csv(t.ClassDesc),
                Csv(t.RatioCd), Csv(t.RatioDescr),
                t.Price.HasValue ? t.Price.Value.ToString("R", CultureInfo.InvariantCulture) : "",
                "",
                r.ClosestDev is not null ? (r.ClosestDev.Value * 100).ToString("0.00", CultureInfo.InvariantCulture) : "",
                r.PeerAvg is not null ? r.PeerAvg.Value.ToString("R", CultureInfo.InvariantCulture) : "",
                r.PeerCount.ToString(CultureInfo.InvariantCulture),
                Csv(t.Reappraisability), Csv(t.ReappraisalCategory),
            }));
            sb.AppendLine();
        }
        return sb.ToString();
    }

    static string Csv(string? v)
    {
        v ??= "";
        return v.Contains(',') || v.Contains('"') ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
    }


    // ------------------------------------------------------------------
    // Persistence — transfer_comps (raw commercial transfer extract).
    // Separate store from permanent_comps: written only here, never by
    // /api/finalize, and never deleted. SHA-256 canonical-content dedup.
    // ------------------------------------------------------------------

    public static (int inserted, int deduplicated) PersistComps(SqliteConnection conn, List<ScreenedRow> rows, string sourceFile)
    {
        int inserted = 0, dedup = 0;
        using var tx = conn.BeginTransaction();
        foreach (var s in rows)
        {
            var comp = CompRecord(s.Row, sourceFile);
            var hash = Sha256Hex(CanonicalJson(comp));
            using (var chk = conn.CreateCommand())
            {
                chk.CommandText = "SELECT id FROM transfer_comps WHERE apn = $apn AND content_hash = $hash";
                chk.Parameters.AddWithValue("$apn", s.Row.Apn);
                chk.Parameters.AddWithValue("$hash", hash);
                if (chk.ExecuteScalar() is not null) { dedup++; continue; }
            }
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO transfer_comps (id, apn, price, sale_date, class_cd, class_cat, class_descr, ratio_cd, price_per_unit, content_hash, source_file, data, created_at)
                VALUES ($id, $apn, $price, $saleDate, $cc, $cat, $cd, $rc, $ppu, $hash, $sf, $data, $now)
                """;
            cmd.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
            cmd.Parameters.AddWithValue("$apn", s.Row.Apn);
            cmd.Parameters.AddWithValue("$price", s.Row.Price ?? 0);
            cmd.Parameters.AddWithValue("$saleDate", s.Row.RecordDate);
            cmd.Parameters.AddWithValue("$cc", s.Row.ClassCd);
            cmd.Parameters.AddWithValue("$cat", s.Row.ClassCat);
            cmd.Parameters.AddWithValue("$cd", s.Row.ClassDesc);
            cmd.Parameters.AddWithValue("$rc", s.Row.RatioCd);
            cmd.Parameters.AddWithValue("$ppu", DBNull.Value); // $/SF or $/acre once the master parcel list provides sizes
            cmd.Parameters.AddWithValue("$hash", hash);
            cmd.Parameters.AddWithValue("$sf", sourceFile);
            cmd.Parameters.AddWithValue("$data", comp.ToJsonString());
            cmd.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("o"));
            cmd.ExecuteNonQuery();
            inserted++;
        }
        tx.Commit();
        return (inserted, dedup);
    }

    // CompRecord shape matches the UI's toComparableSale() field mapping.
    static JsonObject CompRecord(TransferRow r, string sourceFile)
    {
        return new JsonObject
        {
            ["apn"] = r.Apn,
            ["address"] = "",
            ["city"] = "",
            ["saleDate"] = r.RecordDate,
            ["docDate"] = r.DocDate,
            ["price"] = r.Price ?? 0,
            ["age"] = 0,
            ["quality"] = "",
            ["condition"] = "",
            ["landArea"] = 0,
            ["buildingArea"] = 0,
            ["clearHeight"] = 0,
            ["zoning"] = "",
            ["isArmsLength"] = true,
            ["sourceReport"] = "",
            ["propertyType"] = r.ClassDesc,
            ["subjectApn"] = "",
            ["photoUrl"] = "",
            ["pricePerUnit"] = null,
            ["classCd"] = r.ClassCd,
            ["classCat"] = r.ClassCat,
            ["ratioCd"] = r.RatioCd,
            ["sourceFile"] = sourceFile,
        };
    }


    // Store a completed run (summary + bucket CSVs) for later retrieval.
    public static void SaveRun(SqliteConnection conn, Rule2Run run)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO rule2_runs (id, source_file, ran_at, summary, buckets, created_at)
            VALUES ($id, $sf, $ran, $summary, $buckets, $now)
            """;
        cmd.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        cmd.Parameters.AddWithValue("$sf", run.Summary.SourceFile);
        cmd.Parameters.AddWithValue("$ran", run.Summary.RanAt);
        cmd.Parameters.AddWithValue("$summary", JsonSerializer.Serialize(run.Summary, SummaryJsonOpts));
        cmd.Parameters.AddWithValue("$buckets", JsonSerializer.Serialize(run.BucketCsv));
        cmd.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("o"));
        cmd.ExecuteNonQuery();
    }

    // Canonical JSON — deterministic serialization for content hashing
    // (keys sorted, null entries dropped, invariant number formatting).
    static string CanonicalJson(JsonNode? value)
    {
        if (value is null) return "null";
        if (value is JsonValue v)
        {
            if (v.TryGetValue<string>(out var s)) return JsonSerializer.Serialize(s);
            if (v.TryGetValue<bool>(out var b)) return b ? "true" : "false";
            if (v.TryGetValue<double>(out var d)) return d.ToString("R", CultureInfo.InvariantCulture);
            return v.ToJsonString();
        }
        if (value is JsonArray arr)
            return "[" + string.Join(",", arr.Select(CanonicalJson)) + "]";
        if (value is JsonObject obj)
        {
            var entries = obj
                .Where(kv => kv.Value is not null)
                .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => JsonSerializer.Serialize(kv.Key) + ":" + CanonicalJson(kv.Value))
                .ToList();
            return "{" + string.Join(",", entries) + "}";
        }
        return value.ToJsonString();
    }

    static string Sha256Hex(string s) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(s)));


    // ------------------------------------------------------------------
    // API endpoints
    // ------------------------------------------------------------------

    public static void Map(WebApplication app, Func<SqliteConnection> open, string contentRoot)
    {
        var inputDir = Path.Combine(contentRoot, "input");

        app.MapGet("/api/rule2/status", () =>
        {
            var files = new List<object>();
            if (Directory.Exists(inputDir))
            {
                foreach (var f in Directory.EnumerateFiles(inputDir)
                    .Where(f => f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(File.GetLastWriteTime))
                {
                    files.Add(new { name = Path.GetFileName(f), size = new FileInfo(f).Length, lastWrite = File.GetLastWriteTime(f).ToString("o") });
                }
            }
            object? lastRun = null;
            using (var conn = open())
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "SELECT source_file, ran_at, summary FROM rule2_runs ORDER BY ran_at DESC LIMIT 1";
                using var r = cmd.ExecuteReader();
                if (r.Read())
                    lastRun = new { sourceFile = r.GetString(0), ranAt = r.GetString(1), summary = JsonNode.Parse(r.GetString(2)) };
            }
            long compCount;
            using (var conn = open())
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "SELECT COUNT(*) FROM transfer_comps";
                compCount = Convert.ToInt64(cmd.ExecuteScalar());
            }
            return Results.Ok(new { inputDir = "input", files, lastRun, transferCompCount = compCount });
        });

        app.MapPost("/api/rule2/run", () =>
        {
            if (!Directory.Exists(inputDir))
                return Results.BadRequest(new { error = "input/ folder not found" });
            var file = Directory.EnumerateFiles(inputDir)
                .Where(f => f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTime)
                .FirstOrDefault();
            if (file is null)
                return Results.BadRequest(new { error = "no transfer file in input/ (drop an .xlsx or .csv)" });

            var sw = System.Diagnostics.Stopwatch.StartNew();
            List<Dictionary<string, string>> records;
            try { records = ReadFile(file); }
            catch (Exception e) { return Results.BadRequest(new { error = $"parse failed: {e.Message}" }); }

            var run = Run(records, Path.GetFileName(file));
            using var conn = open();
            var (inserted, dedup) = PersistComps(conn, run.Rows, run.Summary.SourceFile);
            SaveRun(conn, run);
            sw.Stop();
            return Results.Ok(new { success = true, summary = run.Summary, inserted, deduplicated = dedup, durationMs = sw.ElapsedMilliseconds });
        });

        app.MapGet("/api/rule2/summary", () =>
        {
            using var conn = open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT source_file, ran_at, summary, buckets FROM rule2_runs ORDER BY ran_at DESC LIMIT 1";
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return Results.Ok(new { lastRun = false });
            return Results.Ok(new
            {
                lastRun = true,
                sourceFile = r.GetString(0),
                ranAt = r.GetString(1),
                summary = JsonNode.Parse(r.GetString(2)),
                buckets = JsonNode.Parse(r.GetString(3)),
            });
        });

        app.MapGet("/api/rule2/buckets/{bucket}", (string bucket, HttpContext ctx) =>
        {
            if (!BucketNames.Contains(bucket)) return Results.NotFound();
            using var conn = open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT buckets FROM rule2_runs ORDER BY ran_at DESC LIMIT 1";
            var raw = cmd.ExecuteScalar() as string;
            if (raw is null) return Results.NotFound();
            var buckets = JsonSerializer.Deserialize<Dictionary<string, string>>(raw);
            if (buckets is null || !buckets.TryGetValue(bucket, out var csv)) return Results.NotFound();
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{bucket}.csv\"";
            return Results.Text(csv, "text/csv");
        });

        // Commercial transfer comps — read-only (no delete endpoint).
        app.MapGet("/api/transfer-comps", () =>
        {
            using var conn = open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT data FROM transfer_comps ORDER BY created_at DESC";
            using var reader = cmd.ExecuteReader();
            var list = new List<object>();
            while (reader.Read()) list.Add(JsonNode.Parse(reader.GetString(0)));
            return Results.Ok(list);
        });
    }
}

