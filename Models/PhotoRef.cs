// ---------------------------------------------------------------------------
// PhotoRef.cs — photo reference + tenant (county branding) config.
//
// Photos are stored as references, never base64 blobs:
//   { source: "gis" }              → /api/parcel-image/{apn}
//   { source: "upload", file }     → /api/parcel-photos/{apn}/{file}
//   { source: "none" }             → explicit no-image (no GIS fallback)
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>A single photo reference. Resolved to a displayable URL at render time.</summary>
public class PhotoRef
{
    /// <summary>"gis" | "upload" | "none".</summary>
    [JsonPropertyName("source")]
    public string Source { get; set; } = "";

    /// <summary>Uploaded file name (only when <see cref="Source"/> is "upload").</summary>
    [JsonPropertyName("file")]
    public string? File { get; set; }

    public static PhotoRef Gis() => new() { Source = "gis" };
    public static PhotoRef Upload(string file) => new() { Source = "upload", File = file };
    public static PhotoRef None() => new() { Source = "none" };
}

/// <summary>County branding, persisted in the server-side <c>tenant</c> table.</summary>
public class TenantConfig
{
    [JsonPropertyName("schemaVersion")]
    public string SchemaVersion { get; set; } = "1.0";

    [JsonPropertyName("county")]
    public string County { get; set; } = "";

    [JsonPropertyName("countyName")]
    public string CountyName { get; set; } = "";

    [JsonPropertyName("officeName")]
    public string OfficeName { get; set; } = "";

    [JsonPropertyName("sealUrl")]
    public string SealUrl { get; set; } = "";
}
