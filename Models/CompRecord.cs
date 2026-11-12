// ---------------------------------------------------------------------------
// CompRecord.cs — permanent sale comp served by the comp repository.
// Written by /api/finalize (permanent_comps) or the Rule 2 batch
// (transfer_comps); the two stores are never cross-written. Mirrors the
// SnapshotToCompRecord shape in Program.cs.
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>Permanent sale comp in the comp repository.</summary>
public class CompRecord
{
    [JsonPropertyName("apn")]
    public string Apn { get; set; } = "";

    [JsonPropertyName("address")]
    public string Address { get; set; } = "";

    [JsonPropertyName("city")]
    public string City { get; set; } = "";

    [JsonPropertyName("saleDate")]
    public string SaleDate { get; set; } = "";

    [JsonPropertyName("price")]
    public double Price { get; set; }

    [JsonPropertyName("age")]
    public int Age { get; set; }

    [JsonPropertyName("quality")]
    public string Quality { get; set; } = "";

    [JsonPropertyName("condition")]
    public string Condition { get; set; } = "";

    [JsonPropertyName("landArea")]
    public double LandArea { get; set; }

    [JsonPropertyName("buildingArea")]
    public double BuildingArea { get; set; }

    [JsonPropertyName("clearHeight")]
    public double ClearHeight { get; set; }

    [JsonPropertyName("zoning")]
    public string Zoning { get; set; } = "";

    [JsonPropertyName("sourceReport")]
    public string SourceReport { get; set; } = "";

    [JsonPropertyName("propertyType")]
    public string PropertyType { get; set; } = "";

    [JsonPropertyName("subjectApn")]
    public string SubjectApn { get; set; } = "";

    [JsonPropertyName("photoUrl")]
    public string PhotoUrl { get; set; } = "";

    // Transfer-completion matching: a Rule 2 transfer is "completed" when a
    // finalized appraisal is archived for the same document number + date.
    [JsonPropertyName("docNumber")]
    public string DocNumber { get; set; } = "";

    [JsonPropertyName("effectiveDate")]
    public string EffectiveDate { get; set; } = "";

    // Case type of the source appraisal ("transfer" | "appeal" | "stipulation"
    // | "general"); used to section the final archive. Defaults to "transfer"
    // for rows archived before this field existed.
    [JsonPropertyName("caseType")]
    public string CaseType { get; set; } = "transfer";

    // --- the 12 grid adjustments (zero for repository comps) ---
    [JsonPropertyName("adjBuildingSize")]
    public double AdjBuildingSize { get; set; }

    [JsonPropertyName("adjLocation")]
    public double AdjLocation { get; set; }

    [JsonPropertyName("adjCornerSite")]
    public double AdjCornerSite { get; set; }

    [JsonPropertyName("adjAge")]
    public double AdjAge { get; set; }

    [JsonPropertyName("adjQuality")]
    public double AdjQuality { get; set; }

    [JsonPropertyName("adjCondition")]
    public double AdjCondition { get; set; }

    [JsonPropertyName("adjTenantsUse")]
    public double AdjTenantsUse { get; set; }

    [JsonPropertyName("adjOccupancy")]
    public double AdjOccupancy { get; set; }

    [JsonPropertyName("adjLandBldgRatio")]
    public double AdjLandBldgRatio { get; set; }

    [JsonPropertyName("adjFreeway")]
    public double AdjFreeway { get; set; }

    [JsonPropertyName("adjMarketConditions")]
    public double AdjMarketConditions { get; set; }

    [JsonPropertyName("adjConditionOfSale")]
    public double AdjConditionOfSale { get; set; }
}
