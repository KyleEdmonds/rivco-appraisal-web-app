// ---------------------------------------------------------------------------
// AppraisalJson.cs — canonical JSON options for the appraisal model.
//
// The SQLite `data` column and the API both speak camelCase JSON (matching
// the JS data model). Use these options for every (de)serialization of the
// typed models so both sides round-trip losslessly.
// ---------------------------------------------------------------------------
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>Shared <see cref="JsonSerializerOptions"/> for the appraisal model.</summary>
public static class AppraisalJson
{
    /// <summary>
    /// camelCase property naming (matches the JS model and the persisted
    /// JSON blobs), no indentation, unknown properties preserved on
    /// re-serialization via <see cref="JsonSerializerOptions"/> defaults.
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Serializes an appraisal document to the JSON blob format.</summary>
    public static string Serialize(AppraisalData data) =>
        JsonSerializer.Serialize(data, Options);

    /// <summary>Deserializes a JSON blob into an appraisal document (null-safe).</summary>
    public static AppraisalData? Deserialize(string? json) =>
        string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<AppraisalData>(json, Options);

    /// <summary>Deserializes a JSON node into an appraisal document (null-safe).</summary>
    public static AppraisalData? DeserializeNode(JsonNode? node) =>
        node is null ? null : JsonSerializer.Deserialize<AppraisalData>(node, Options);

    /// <summary>Deserializes and normalizes a JSON blob (fills missing sections with defaults).</summary>
    public static AppraisalData DeserializeNormalized(string? json) =>
        AppraisalData.Normalize(Deserialize(json));

    /// <summary>Serializes a comp repository record.</summary>
    public static string SerializeComp(CompRecord comp) =>
        JsonSerializer.Serialize(comp, Options);

    /// <summary>Deserializes a comp repository record (null-safe).</summary>
    public static CompRecord? DeserializeComp(string? json) =>
        string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<CompRecord>(json, Options);

    /// <summary>Serializes tenant (county branding) config.</summary>
    public static string SerializeTenant(TenantConfig tenant) =>
        JsonSerializer.Serialize(tenant, Options);

    /// <summary>Deserializes tenant config (null-safe).</summary>
    public static TenantConfig? DeserializeTenant(string? json) =>
        string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<TenantConfig>(json, Options);
}
