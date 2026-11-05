// ---------------------------------------------------------------------------
// Approaches.cs — the three valuation approaches + reconciliation.
// Mirrors the JS data model (wwwroot/js/core.js createEmptyParcel) 1:1.
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>Cost approach inputs (depreciation schedule).</summary>
public class CostApproach
{
    [JsonPropertyName("physicalDepreciationPct")]
    public double PhysicalDepreciationPct { get; set; }

    [JsonPropertyName("functionalDepreciation")]
    public double FunctionalDepreciation { get; set; }

    [JsonPropertyName("economicDepreciation")]
    public double EconomicDepreciation { get; set; }

    [JsonPropertyName("costNotes")]
    public string CostNotes { get; set; } = "";

    [JsonPropertyName("includeInReport")]
    public bool IncludeInReport { get; set; }
}

/// <summary>Income approach inputs (rent, losses, cap rate).</summary>
public class IncomeApproach
{
    /// <summary>"NNN" | "gross" | "modified".</summary>
    [JsonPropertyName("rentType")]
    public string RentType { get; set; } = "NNN";

    [JsonPropertyName("pgiPerSf")]
    public double PgiPerSf { get; set; }

    [JsonPropertyName("vacancyPct")]
    public double VacancyPct { get; set; } = 5;

    [JsonPropertyName("collectionLossPct")]
    public double CollectionLossPct { get; set; } = 5;

    [JsonPropertyName("operatingExpensePct")]
    public double OperatingExpensePct { get; set; } = 5;

    [JsonPropertyName("capRate")]
    public double CapRate { get; set; } = 6;

    [JsonPropertyName("incomeNotes")]
    public string IncomeNotes { get; set; } = "";
}

/// <summary>Sales comparison approach: method, remarks, and the comp set.</summary>
public class SalesApproach
{
    /// <summary>"average" | "weighted" | "range".</summary>
    [JsonPropertyName("method")]
    public string Method { get; set; } = "average";

    [JsonPropertyName("remarks")]
    public string Remarks { get; set; } = "";

    [JsonPropertyName("comparables")]
    public List<ComparableSale> Comparables { get; set; } = new();
}

/// <summary>Reconciliation of the three approaches into the final value.</summary>
public class Reconciliation
{
    [JsonPropertyName("costWeight")]
    public int CostWeight { get; set; }

    [JsonPropertyName("incomeWeight")]
    public int IncomeWeight { get; set; } = 25;

    [JsonPropertyName("salesWeight")]
    public int SalesWeight { get; set; } = 75;

    [JsonPropertyName("finalValue")]
    public double FinalValue { get; set; }

    [JsonPropertyName("rationale")]
    public string Rationale { get; set; } = "";
}
