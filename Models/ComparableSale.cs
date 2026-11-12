// ---------------------------------------------------------------------------
// ComparableSale.cs — a comparable sale within an appraisal's sales
// approach (lives inside sales.comparables). Mirrors wwwroot/js/form.js
// newComp() 1:1.
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>A comparable sale within an appraisal's sales approach.</summary>
public class ComparableSale
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("parcel")]
    public string Parcel { get; set; } = "";

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

    [JsonPropertyName("propertyType")]
    public string PropertyType { get; set; } = "";

    // --- the 12 grid adjustments (dollar amounts) ---
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

    /// <summary>Comp photos, keyed by the comp's own APN (independent of the subject's).</summary>
    [JsonPropertyName("photos")]
    public List<PhotoRef> Photos { get; set; } = new();

    /// <summary>Sum of the 12 grid adjustments.</summary>
    public double TotalAdjustments =>
        AdjBuildingSize + AdjLocation + AdjCornerSite + AdjAge + AdjQuality +
        AdjCondition + AdjTenantsUse + AdjOccupancy + AdjLandBldgRatio +
        AdjFreeway + AdjMarketConditions + AdjConditionOfSale;

    /// <summary>Indicated value: price + total adjustments.</summary>
    public double IndicatedValue => Price + TotalAdjustments;
}
