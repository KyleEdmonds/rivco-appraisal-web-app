// ---------------------------------------------------------------------------
// Property.cs — subject property, land, and improvement structures.
// Mirrors the JS data model (wwwroot/js/core.js createEmptyParcel) 1:1 so
// both sides round-trip the SQLite JSON document losslessly.
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>Subject property identification and case metadata.</summary>
public class PropertyInfo
{
    [JsonPropertyName("apn")]
    public string Apn { get; set; } = "";

    [JsonPropertyName("parcelId")]
    public string ParcelId { get; set; } = "";

    [JsonPropertyName("address")]
    public string Address { get; set; } = "";

    [JsonPropertyName("city")]
    public string City { get; set; } = "";

    [JsonPropertyName("zip")]
    public string Zip { get; set; } = "";

    [JsonPropertyName("county")]
    public string County { get; set; } = "";

    [JsonPropertyName("intersection")]
    public string Intersection { get; set; } = "";

    [JsonPropertyName("legalDescription")]
    public string LegalDescription { get; set; } = "";

    [JsonPropertyName("effectiveDate")]
    public string EffectiveDate { get; set; } = "2025-01-01";

    [JsonPropertyName("reportDate")]
    public string ReportDate { get; set; } = "";

    [JsonPropertyName("appraiser")]
    public string Appraiser { get; set; } = "";

    [JsonPropertyName("appraiserLicense")]
    public string AppraiserLicense { get; set; } = "";

    [JsonPropertyName("reportType")]
    public string ReportType { get; set; } = "";

    [JsonPropertyName("purpose")]
    public string Purpose { get; set; } = "";

    [JsonPropertyName("client")]
    public string Client { get; set; } = "";

    [JsonPropertyName("transferDocumentNumber")]
    public string TransferDocumentNumber { get; set; } = "";

    [JsonPropertyName("ratioCode")]
    public string RatioCode { get; set; } = "";

    [JsonPropertyName("salePrice")]
    public double SalePrice { get; set; }

    [JsonPropertyName("appraiserId")]
    public string AppraiserId { get; set; } = "";

    [JsonPropertyName("section")]
    public string Section { get; set; } = "";

    [JsonPropertyName("appraiserNotes")]
    public string AppraiserNotes { get; set; } = "";

    /// <summary>"transfer" | "appeal" | "stipulation".</summary>
    [JsonPropertyName("caseType")]
    public string CaseType { get; set; } = "transfer";

    /// <summary>Legacy single photo ref (kept for migration); superseded by <see cref="SubjectPhotos"/>.</summary>
    [JsonPropertyName("subjectImage")]
    public PhotoRef? SubjectImage { get; set; }

    /// <summary>Subject photo list: { source: "gis" } or { source: "upload", file }.</summary>
    [JsonPropertyName("subjectPhotos")]
    public List<PhotoRef> SubjectPhotos { get; set; } = new();
}

/// <summary>Land / site characteristics and land value.</summary>
public class LandInfo
{
    [JsonPropertyName("siteAreaSqFt")]
    public double SiteAreaSqFt { get; set; }

    [JsonPropertyName("acres")]
    public double Acres { get; set; }

    [JsonPropertyName("zoning")]
    public string Zoning { get; set; } = "";

    [JsonPropertyName("topography")]
    public string Topography { get; set; } = "";

    [JsonPropertyName("shape")]
    public string Shape { get; set; } = "";

    [JsonPropertyName("frontageFt")]
    public double FrontageFt { get; set; }

    [JsonPropertyName("depthFt")]
    public double DepthFt { get; set; }

    [JsonPropertyName("lotCount")]
    public int LotCount { get; set; }

    [JsonPropertyName("utilities")]
    public List<string> Utilities { get; set; } = new();

    [JsonPropertyName("landValue")]
    public double LandValue { get; set; }

    [JsonPropertyName("landValueMethod")]
    public string LandValueMethod { get; set; } = "";

    [JsonPropertyName("landValueNotes")]
    public string LandValueNotes { get; set; } = "";
}

/// <summary>A single building (primary improvement or outbuilding).</summary>
public class Improvement
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("yearBuilt")]
    public int YearBuilt { get; set; }

    [JsonPropertyName("grossFloorArea")]
    public double GrossFloorArea { get; set; }

    [JsonPropertyName("nla")]
    public double Nla { get; set; }

    [JsonPropertyName("quality")]
    public string Quality { get; set; } = "";

    [JsonPropertyName("constructionType")]
    public string ConstructionType { get; set; } = "";

    [JsonPropertyName("stories")]
    public int Stories { get; set; }

    [JsonPropertyName("condition")]
    public string Condition { get; set; } = "";

    [JsonPropertyName("unitCost")]
    public double UnitCost { get; set; }
}

/// <summary>Improvements: the primary building plus any outbuildings.</summary>
public class ImprovementsInfo
{
    [JsonPropertyName("primary")]
    public Improvement Primary { get; set; } = new();

    [JsonPropertyName("outbuildings")]
    public List<Improvement> Outbuildings { get; set; } = new();
}
