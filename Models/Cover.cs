// ---------------------------------------------------------------------------
// Cover.cs — case-specific cover-page fields (transfer / appeal /
// stipulation) and the stipulation value-category table.
// Mirrors the JS data model (wwwroot/js/core.js createEmptyParcel.cover).
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>One row of the stipulation value-category table.</summary>
public class ValueCategory
{
    [JsonPropertyName("category")]
    public string Category { get; set; } = "";

    [JsonPropertyName("code")]
    public string Code { get; set; } = "";

    [JsonPropertyName("rollValue")]
    public double RollValue { get; set; }

    [JsonPropertyName("stipulatedValue")]
    public double StipulatedValue { get; set; }
}

/// <summary>Cover-page fields, grouped by case type.</summary>
public class CoverInfo
{
    // --- transfer ---
    [JsonPropertyName("totalPosted")]
    public double TotalPosted { get; set; }

    // --- appeal ---
    [JsonPropertyName("hearingDate")]
    public string HearingDate { get; set; } = "";

    [JsonPropertyName("caseNumber")]
    public string CaseNumber { get; set; } = "";

    [JsonPropertyName("applicant")]
    public string Applicant { get; set; } = "";

    [JsonPropertyName("agent")]
    public string Agent { get; set; } = "";

    [JsonPropertyName("currentRollValue")]
    public double CurrentRollValue { get; set; }

    [JsonPropertyName("applicantOpinionValue")]
    public double ApplicantOpinionValue { get; set; }

    [JsonPropertyName("assessorOpinionValue")]
    public double AssessorOpinionValue { get; set; }

    [JsonPropertyName("presentedBy")]
    public string PresentedBy { get; set; } = "";

    // --- stipulation ---
    [JsonPropertyName("applicationNumber")]
    public string ApplicationNumber { get; set; } = "";

    [JsonPropertyName("applicantName")]
    public string ApplicantName { get; set; } = "";

    [JsonPropertyName("applicantAddress")]
    public string ApplicantAddress { get; set; } = "";

    [JsonPropertyName("agentName")]
    public string AgentName { get; set; } = "";

    [JsonPropertyName("agentAddress")]
    public string AgentAddress { get; set; } = "";

    [JsonPropertyName("tra")]
    public string Tra { get; set; } = "";

    [JsonPropertyName("assessmentNo")]
    public string AssessmentNo { get; set; } = "";

    [JsonPropertyName("arbNo")]
    public string ArbNo { get; set; } = "";

    [JsonPropertyName("yearArbCreated")]
    public string YearArbCreated { get; set; } = "";

    [JsonPropertyName("location")]
    public string Location { get; set; } = "";

    [JsonPropertyName("supplementalNo")]
    public string SupplementalNo { get; set; } = "";

    [JsonPropertyName("acreage")]
    public string Acreage { get; set; } = "";

    [JsonPropertyName("use")]
    public string Use { get; set; } = "";

    [JsonPropertyName("factsJustifying")]
    public string FactsJustifying { get; set; } = "";

    /// <summary>Stipulation value-category rows (Land, Structures, Fixtures, …).</summary>
    [JsonPropertyName("valueCategories")]
    public List<ValueCategory> ValueCategories { get; set; } = new();

    /// <summary>Default stipulation value-category rows (mirrors createEmptyParcel).</summary>
    public static List<ValueCategory> DefaultCategories() => new()
    {
        new() { Category = "Land", Code = "01" },
        new() { Category = "Structures", Code = "02" },
        new() { Category = "Fixtures", Code = "03" },
        new() { Category = "Trees & Vines", Code = "05" },
        new() { Category = "Business Pers. Prop.", Code = "08" },
        new() { Category = "Other", Code = "" },
    };
}
