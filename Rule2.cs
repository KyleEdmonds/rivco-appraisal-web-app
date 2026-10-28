// ---------------------------------------------------------------------------
// Rule2.cs — Rule 2 batch evaluation (California Property Tax Rule 2,
// "Full Cash Value").
//
// Input: the enriched transfer CSV (output/commercial_transfers.csv) produced
// by the dev pipeline (extractCommercial + fetchParcelSizes). input/ holds
// only the county master file.
// Scope: commercial classes only (ClassCat = Commercial / CommercialDE).
//
// Market sales (Consid > 0) are screened against same-class peers, gated by
// location similarity. APNs are book-page-parcel, so the book (first 3
// digits) encodes location: book 119 is similar to a subject in book 118,
// book 771 is not.
//   location tiers (book distance): 0 = same book, 1 = adjacent, 2 = 2-5,
//   3 = distant (or unparseable book)
//   improved: >= 1 Tier 0/1 peer within 5%            -> auto_enrolled
//             Tier 2 peer within 5%, or closest
//             Tier 0/1 peer within 15%                -> borderline
//             otherwise                               -> below_market /
//             above_market (vs similarity-weighted peer avg; Tier 0 peers
//             weigh most, Tier 3 least)
//   land:     >= 2 Tier 0/1 peers within 2%          -> auto_enrolled
//             otherwise                               -> land_review
// No-value transfers (Consid = 0) -> no_value, classified by LocalRatioCd.
// A size-similarity factor (e.g. GFA within 25%) will plug into the tier
// score once the county provides a parcel list with sizes.
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
    const int NearbyBookDistance = 5;       // Tier 2: books 2-5 away
    static readonly double[] TierWeights = { 4, 2, 1, 0.25 };  // T0..T3

    // Stored run summaries are read back as raw JSON by the UI, which expects
    // camelCase keys (matching the rest of the API). Serialize with camelCase
    // so the persisted summary matches what the frontend reads.
    private static readonly JsonSerializerOptions SummaryJsonOpts =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public record TransferRow(
        string Apn, string DocNumber, string RecordDate, string DocDate,
        string ClassCd, string ClassCat, string ClassDesc,
        string RatioCd, string RatioDescr,
        double? Price,
        string Reappraisability, string ReappraisalCategory,
        int Book,
        // Property characteristics (from the enriched CSV):
        string Address, string City, int YearBuilt, string Quality, string Condition,
        double BuildingSf, double Acreage, double SiteSqFt);

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

    // Date -> ISO (yyyy-MM-dd). Handles Excel serials and US M/d/yy or
    // M/d/yyyy strings; anything unrecognizable passes through trimmed.
    public static string ToIsoDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        var s = raw.Trim();
        if (double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var d) && d > 20000 && d < 80000)
            return new DateTime(1899, 12, 30).AddDays(d).ToString("yyyy-MM-dd");
        if (DateTime.TryParseExact(s, new[] { "M/d/yyyy", "M/d/yy", "MM/dd/yyyy", "MM/dd/yy" },
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt))
            return dt.ToString("yyyy-MM-dd");
        return s;
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
            // The derived commercial CSV has no ClassCat column (it is already
            // filtered upstream); only apply the category filter when present.
            if (r.ContainsKey("ClassCat") && !CommercialCats.Contains(cat)) continue;
            commercial.Add(new TransferRow(
                Apn: Get(r, "PIN"),
                DocNumber: Get(r, "DocNumber"),
                RecordDate: ToIsoDate(Get(r, "RecordDate")),
                DocDate: ToIsoDate(Get(r, "DocDate")),
                ClassCd: GetAny(r, "ClassCd", "ClassCode"),
                ClassCat: GetAny(r, "ClassCat", "ClassSubCat"),
                ClassDesc: Get(r, "ClassCdDescr"),
                RatioCd: Get(r, "LocalRatioCd"),
                RatioDescr: Get(r, "LocalRatioCdDescr"),
                Price: ParsePrice(Get(r, "Consid")),
                Reappraisability: GetAny(r, "Reappraisability", "ReappraisabilityPercent"),
                ReappraisalCategory: Get(r, "ReappraisalCategory"),
                Book: ParseBook(Get(r, "PIN")),
                Address: Get(r, "Address"),
                City: Get(r, "City"),
                YearBuilt: ParseInt(Get(r, "YrBuilt")),
                Quality: Get(r, "Quality"),
                Condition: Get(r, "Condition"),
                BuildingSf: ParseNum(Get(r, "BuildingSf")),
                Acreage: ParseNum(Get(r, "Acreage")),
                SiteSqFt: ParseNum(Get(r, "SquareFeet"))));
        }
        s.CommercialRows = commercial.Count;

        var market = commercial.Where(r => r.Price is > 0).ToList();
        var noValue = commercial.Where(r => r.Price is not > 0).ToList();
        s.MarketSales = market.Count;
        s.NoValue = noValue.Count;

        // Peer groups by class description: the derived commercial CSV drops the
        // ClassCd column, and ClassCdDescr is a 1:1 proxy for the class code.
        var groups = market.GroupBy(r => r.ClassDesc).ToDictionary(g => g.Key, g => g.ToList());
        foreach (var row in market)
        {
            double? minDev = null, closestT01Dev = null;
            int withinT01 = 0, withinT2 = 0, peerCount = 0;
            double wSum = 0, wpSum = 0;
            var threshold = IsLand(row) ? LandThreshold : ImprovedThreshold;
            foreach (var p in groups[row.ClassDesc])
            {
                if (ReferenceEquals(p, row)) continue;
                peerCount++;
                var dev = Math.Abs(row.Price.Value - p.Price.Value) / row.Price.Value;
                if (minDev is null || dev < minDev) minDev = dev;
                var tier = BookTier(row.Book, p.Book);
                var w = TierWeights[tier];
                wSum += w;
                wpSum += p.Price.Value * w;
                if (dev <= threshold)
                {
                    if (tier <= 1) withinT01++;
                    else if (tier == 2) withinT2++;
                }
                if (tier <= 1 && (closestT01Dev is null || dev < closestT01Dev))
                    closestT01Dev = dev;
            }
            // Similarity-weighted peer average: nearby books dominate.
            double? peerAvg = wSum > 0 ? wpSum / wSum : null;
            string bucket;
            if (IsLand(row))
                bucket = withinT01 >= LandMinPeers ? "auto_enrolled" : "land_review";
            else if (withinT01 >= 1)
                bucket = "auto_enrolled";
            else if (withinT2 >= 1 || (closestT01Dev is not null && closestT01Dev <= ImprovedBorderline))
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

    // APN is book-page-parcel; the book (first 3 digits) encodes location.
    // Unparseable books return 0 and are treated as Tier 3 (distant).
    static int ParseBook(string apn) =>
        apn.Length >= 3 && int.TryParse(apn[..3], out var b) ? b : 0;

    static int BookTier(int a, int b)
    {
        if (a <= 0 || b <= 0) return 3;
        var d = Math.Abs(a - b);
        return d == 0 ? 0 : d == 1 ? 1 : d <= NearbyBookDistance ? 2 : 3;
    }

    static double? ParsePrice(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return double.TryParse(raw.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : null;
    }

    static string Get(Dictionary<string, string> r, string key) => r.TryGetValue(key, out var v) ? v : "";

    // First non-empty value among the candidate column names (the derived CSV
    // and the county xlsx use different header names for the same field).
    static string GetAny(Dictionary<string, string> r, params string[] keys)
    {
        foreach (var k in keys)
            if (r.TryGetValue(k, out var v) && v.Length > 0) return v;
        return "";
    }

    static int ParseInt(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return 0;
        return int.TryParse(raw.Trim().Replace(",", ""), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : 0;
    }

    static double ParseNum(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return 0;
        return double.TryParse(raw.Trim().Replace(",", ""), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : 0;
    }

    // ------------------------------------------------------------------
    // Bucket CSV output. price_per_unit is $/SF for improved properties and
    // $/acre for land — empty until the master parcel list provides sizes.
    // ------------------------------------------------------------------

    static string ToCsv(List<ScreenedRow> rows)
    {
        var sb = new StringBuilder();
        sb.AppendLine("apn,doc_number,book,record_date,doc_date,class_cd,class_cat,class_descr,ratio_cd,ratio_descr,consid,price_per_unit,closest_dev_pct,peer_avg,peer_count,county_reappraisability,county_reappraisal_category");
        foreach (var r in rows)
        {
            var t = r.Row;
            sb.Append(string.Join(",", new[]
            {
                Csv(t.Apn), Csv(t.DocNumber), t.Book > 0 ? t.Book.ToString(CultureInfo.InvariantCulture) : "", Csv(t.RecordDate), Csv(t.DocDate), Csv(t.ClassCd), Csv(t.ClassCat), Csv(t.ClassDesc),
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
    // /api/finalize. Each run REPLACES the store (clear + re-insert) so it
    // always mirrors the latest input; SHA-256 dedup guards intra-run dupes.
    // ------------------------------------------------------------------

    public static (int inserted, int deduplicated) PersistComps(SqliteConnection conn, List<ScreenedRow> rows, string sourceFile)
    {
        int inserted = 0, dedup = 0;
        using var tx = conn.BeginTransaction();
        // Replace semantics: clear the previous extract so the store always
        // mirrors the latest input (avoids stale rows when the source file
        // changes, e.g. xlsx -> derived commercial CSV).
        using (var del = conn.CreateCommand())
        {
            del.Transaction = tx;
            del.CommandText = "DELETE FROM transfer_comps";
            del.ExecuteNonQuery();
        }
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
                INSERT INTO transfer_comps (id, apn, price, sale_date, class_cd, class_cat, class_descr, ratio_cd, price_per_unit, content_hash, source_file, data, created_at, address, city, quality, condition, year_built, building_sf, acreage, site_sqft)
                VALUES ($id, $apn, $price, $saleDate, $cc, $cat, $cd, $rc, $ppu, $hash, $sf, $data, $now, $addr, $city, $qual, $cond, $yb, $bsf, $ac, $ssqft)
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
            cmd.Parameters.AddWithValue("$addr", s.Row.Address);
            cmd.Parameters.AddWithValue("$city", s.Row.City);
            cmd.Parameters.AddWithValue("$qual", s.Row.Quality);
            cmd.Parameters.AddWithValue("$cond", s.Row.Condition);
            cmd.Parameters.AddWithValue("$yb", s.Row.YearBuilt);
            cmd.Parameters.AddWithValue("$bsf", s.Row.BuildingSf);
            cmd.Parameters.AddWithValue("$ac", s.Row.Acreage);
            cmd.Parameters.AddWithValue("$ssqft", s.Row.SiteSqFt);
            cmd.ExecuteNonQuery();
            inserted++;
        }
        tx.Commit();
        return (inserted, dedup);
    }

    // CompRecord shape matches the UI's toComparableSale() field mapping.
    static JsonObject CompRecord(TransferRow r, string sourceFile)
    {
        var yearBuilt = r.YearBuilt;
        return new JsonObject
        {
            ["apn"] = r.Apn,
            ["address"] = r.Address,
            ["city"] = r.City,
            ["saleDate"] = r.RecordDate,
            ["docDate"] = r.DocDate,
            ["docNumber"] = r.DocNumber,
            ["price"] = r.Price ?? 0,
            ["age"] = yearBuilt > 0 ? Math.Max(0, DateTime.UtcNow.Year - yearBuilt) : 0,
            ["yearBuilt"] = yearBuilt,
            ["quality"] = r.Quality,
            ["condition"] = r.Condition,
            ["landArea"] = r.Acreage,
            ["buildingArea"] = r.BuildingSf,
            ["siteSqFt"] = r.SiteSqFt,
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
        // Derived transfer files live in output/ (input/ holds only the county
        // master file). The Rule 2 batch runs against the enriched
        // output/commercial_transfers.csv produced by the dev pipeline.
        var outputDir = Path.Combine(contentRoot, "output");

        app.MapGet("/api/rule2/status", () =>
        {
            var files = new List<object>();
            if (Directory.Exists(outputDir))
            {
                foreach (var f in Directory.EnumerateFiles(outputDir)
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
            return Results.Ok(new { outputDir = "output", files, lastRun, transferCompCount = compCount });
        });

        app.MapPost("/api/rule2/run", () =>
        {
            if (!Directory.Exists(outputDir))
                return Results.BadRequest(new { error = "output/ folder not found" });
            var file = Directory.EnumerateFiles(outputDir)
                .Where(f => f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTime)
                .FirstOrDefault();
            if (file is null)
                return Results.BadRequest(new { error = "no transfer file in output/ (run extractCommercial + fetchParcelSizes)" });

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

        // Structured rows for one bucket of the latest run — the transfer
        // work queues. A transfer is "completed" when a finalized appraisal
        // (permanent comp) is archived for the same document number +
        // effective (record) date; auto-enrolled transfers are completed
        // by default (enrolled as comps at sale price).
        app.MapGet("/api/rule2/bucket-rows/{bucket}", (string bucket) =>
        {
            if (!BucketNames.Contains(bucket)) return Results.NotFound();
            using var conn = open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT buckets FROM rule2_runs ORDER BY ran_at DESC LIMIT 1";
            var raw = cmd.ExecuteScalar() as string;
            if (raw is null) return Results.NotFound();
            var buckets = JsonSerializer.Deserialize<Dictionary<string, string>>(raw);
            if (buckets is null || !buckets.TryGetValue(bucket, out var csv)) return Results.NotFound();

            var completedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var pc = conn.CreateCommand())
            {
                pc.CommandText = "SELECT data FROM permanent_comps";
                using var r = pc.ExecuteReader();
                while (r.Read())
                {
                    var node = JsonNode.Parse(r.GetString(0)) as JsonObject;
                    var doc = node?["docNumber"]?.GetValue<string>() ?? "";
                    var eff = node?["effectiveDate"]?.GetValue<string>() ?? "";
                    if (doc.Length > 0) completedKeys.Add($"{doc}|{eff}");
                }
            }

            var lines = csv.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToList();
            if (lines.Count < 2) return Results.Ok(Array.Empty<object>());
            var header = SplitCsvLine(lines[0]);
            var idx = new Dictionary<string, int>();
            for (var i = 0; i < header.Count; i++) idx[header[i]] = i;
            string Get(List<string> vals, string col) =>
                idx.TryGetValue(col, out var i) && i < vals.Count ? vals[i] : "";
            double? Num(string col, List<string> vals) =>
                double.TryParse(Get(vals, col), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : null;

            var list = new List<object>();
            foreach (var line in lines.Skip(1))
            {
                var vals = SplitCsvLine(line);
                var doc = Get(vals, "doc_number");
                var rec = Get(vals, "record_date");
                list.Add(new JsonObject
                {
                    ["apn"] = Get(vals, "apn"),
                    ["docNumber"] = doc,
                    ["book"] = int.TryParse(Get(vals, "book"), out var bk) ? bk : 0,
                    ["recordDate"] = rec,
                    ["docDate"] = Get(vals, "doc_date"),
                    ["classCd"] = Get(vals, "class_cd"),
                    ["classCat"] = Get(vals, "class_cat"),
                    ["classDescr"] = Get(vals, "class_descr"),
                    ["ratioCd"] = Get(vals, "ratio_cd"),
                    ["ratioDescr"] = Get(vals, "ratio_descr"),
                    ["consid"] = Num("consid", vals) ?? 0,
                    ["closestDevPct"] = Num("closest_dev_pct", vals),
                    ["peerAvg"] = Num("peer_avg", vals),
                    ["peerCount"] = int.TryParse(Get(vals, "peer_count"), out var pc2) ? pc2 : 0,
                    ["reappraisability"] = Get(vals, "county_reappraisability"),
                    ["reappraisalCategory"] = Get(vals, "county_reappraisal_category"),
                    ["completed"] = bucket == "auto_enrolled"
                        || (doc.Length > 0 && completedKeys.Contains($"{doc}|{rec}")),
                });
            }
            return Results.Ok(list);
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

        // Search transfer comps by APN / address / city / quality / condition.
        // Backs the top-bar APN search box: as the user types, matching
        // transfers (with their property characteristics) are returned.
        app.MapGet("/api/transfer-comps/search", (string? q) =>
        {
            q = (q ?? "").Trim();
            if (q.Length == 0) return Results.Ok(Array.Empty<object>());
            var clean = q.Replace("%", "").Replace("_", "");
            var like = "%" + clean + "%";
            var likePrefix = clean + "%";
            using var conn = open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                SELECT apn, address, city, quality, condition, year_built, price, building_sf, acreage, site_sqft, class_descr, ratio_cd, sale_date, data
                FROM transfer_comps
                WHERE apn LIKE $qPrefix OR address LIKE $q OR city LIKE $q OR quality LIKE $q OR condition LIKE $q
                   OR class_descr LIKE $q OR CAST(year_built AS TEXT) LIKE $q
                ORDER BY (apn LIKE $qPrefix) DESC, apn
                LIMIT 20
                """;
            cmd.Parameters.AddWithValue("$q", like);
            cmd.Parameters.AddWithValue("$qPrefix", likePrefix);
            var list = new List<object>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var data = JsonNode.Parse(reader.GetString(13)) as JsonObject;
                list.Add(new JsonObject
                {
                    ["apn"] = reader.IsDBNull(0) ? "" : reader.GetString(0),
                    ["address"] = reader.IsDBNull(1) ? "" : reader.GetString(1),
                    ["city"] = reader.IsDBNull(2) ? "" : reader.GetString(2),
                    ["quality"] = reader.IsDBNull(3) ? "" : reader.GetString(3),
                    ["condition"] = reader.IsDBNull(4) ? "" : reader.GetString(4),
                    ["yearBuilt"] = reader.IsDBNull(5) ? 0 : reader.GetInt32(5),
                    ["price"] = reader.IsDBNull(6) ? 0 : reader.GetDouble(6),
                    ["buildingArea"] = reader.IsDBNull(7) ? 0 : reader.GetDouble(7),
                    ["landArea"] = reader.IsDBNull(8) ? 0 : reader.GetDouble(8),
                    ["siteSqFt"] = reader.IsDBNull(9) ? 0 : reader.GetDouble(9),
                    ["propertyType"] = reader.IsDBNull(10) ? "" : reader.GetString(10),
                    ["ratioCd"] = reader.IsDBNull(11) ? "" : reader.GetString(11),
                    ["saleDate"] = reader.IsDBNull(12) ? "" : reader.GetString(12),
                    ["docNumber"] = data?["docNumber"]?.GetValue<string>() ?? "",
                });
            }
            return Results.Ok(list);
        });

        // Work queues: read a "to be worked" file from input/ and return its
        // rows as JSON. `type` selects the file prefix:
        //   transfers -> transfers_to_be_worked*.xlsx/.csv
        //   appeals   -> appeals_to_be_done*.xlsx/.csv
        // The latest matching file (by last-write time) is used. Columns whose
        // name contains "Date" are normalized to ISO (Excel serials and
        // M/d/yy). The RivCoViewJSON column (raw county API blob) is excluded
        // — parcel detail is served by /api/parcel-data/{apn} instead.
        var inputDir = Path.Combine(contentRoot, "input");
        app.MapGet("/api/workqueue/{type}", (string type) =>
        {
            var prefix = type switch
            {
                "transfers" => "transfers_to_be_worked",
                "appeals" => "appeals_to_be_done",
                _ => null
            };
            if (prefix is null)
                return Results.BadRequest(new { error = "unknown work queue type" });
            var empty = new { file = (string?)null, count = 0, columns = Array.Empty<string>(), rows = Array.Empty<object>() };
            if (!Directory.Exists(inputDir))
                return Results.Ok(empty);
            var file = Directory.EnumerateFiles(inputDir)
                .Where(f => Path.GetFileNameWithoutExtension(f).StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                    && (f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)))
                .OrderByDescending(File.GetLastWriteTime)
                .FirstOrDefault();
            if (file is null)
                return Results.Ok(empty);
            List<Dictionary<string, string>> records;
            try { records = ReadFile(file); }
            catch (Exception e) { return Results.BadRequest(new { error = $"parse failed: {e.Message}" }); }
            var columns = records.Count > 0
                ? records[0].Keys.Where(c => !c.Equals("RivCoViewJSON", StringComparison.OrdinalIgnoreCase)).ToList()
                : new List<string>();
            var rows = records.Select(r => (object)new Dictionary<string, string>(
                columns.ToDictionary(c => c, c =>
                {
                    var v = r.TryGetValue(c, out var val) ? val : "";
                    return c.Contains("Date", StringComparison.OrdinalIgnoreCase) ? ToIsoDate(v) : v;
                }))).ToList();
            return Results.Ok(new { file = Path.GetFileName(file), count = records.Count, columns, rows });
        });
    }
}

