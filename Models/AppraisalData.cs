// ---------------------------------------------------------------------------
// AppraisalData.cs — root appraisal document. One row in the SQLite
// `appraisals` table (JSON blob in the `data` column). Mirrors the JS
// createEmptyParcel / normalizeParcel in wwwroot/js/core.js 1:1.
// ---------------------------------------------------------------------------
using System.Text.Json.Serialization;

namespace RivCo.Models;

/// <summary>Root appraisal document for a single parcel.</summary>
public class AppraisalData
{
    [JsonPropertyName("property")]
    public PropertyInfo Property { get; set; } = new();

    [JsonPropertyName("land")]
    public LandInfo Land { get; set; } = new();

    [JsonPropertyName("improvements")]
    public ImprovementsInfo Improvements { get; set; } = new();

    [JsonPropertyName("cost")]
    public CostApproach Cost { get; set; } = new();

    [JsonPropertyName("income")]
    public IncomeApproach Income { get; set; } = new();

    [JsonPropertyName("sales")]
    public SalesApproach Sales { get; set; } = new();

    [JsonPropertyName("reconciliation")]
    public Reconciliation Reconciliation { get; set; } = new();

    [JsonPropertyName("cover")]
    public CoverInfo Cover { get; set; } = new();

    /// <summary>
    /// Creates a new empty appraisal with the same defaults as the JS
    /// createEmptyParcel factory (report date = today, income defaults,
    /// 25/75 income/sales weights, default stipulation categories).
    /// </summary>
    public static AppraisalData CreateEmpty(string apn)
    {
        var data = new AppraisalData
        {
            Property = new PropertyInfo { Apn = apn ?? "", ReportDate = DateTime.Now.ToString("yyyy-MM-dd") },
            Improvements = new ImprovementsInfo
            {
                Primary = new Improvement
                {
                    Id = $"imp-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                    Name = "Building 1",
                },
            },
            Cover = new CoverInfo { ValueCategories = CoverInfo.DefaultCategories() },
        };
        return data;
    }

    /// <summary>
    /// Normalizes a deserialized document: fills any missing sections with
    /// defaults (mirrors the JS normalizeParcel spread-merge semantics).
    /// </summary>
    public static AppraisalData Normalize(AppraisalData? parcel)
    {
        var baseDoc = CreateEmpty("");
        if (parcel is null) return baseDoc;
        return new AppraisalData
        {
            Property = parcel.Property ?? baseDoc.Property,
            Land = parcel.Land ?? baseDoc.Land,
            Improvements = new ImprovementsInfo
            {
                Primary = parcel.Improvements?.Primary ?? baseDoc.Improvements.Primary,
                Outbuildings = parcel.Improvements?.Outbuildings ?? baseDoc.Improvements.Outbuildings,
            },
            Cost = parcel.Cost ?? baseDoc.Cost,
            Income = parcel.Income ?? baseDoc.Income,
            Sales = new SalesApproach
            {
                Method = parcel.Sales?.Method ?? baseDoc.Sales.Method,
                Remarks = parcel.Sales?.Remarks ?? baseDoc.Sales.Remarks,
                Comparables = parcel.Sales?.Comparables ?? baseDoc.Sales.Comparables,
            },
            Reconciliation = parcel.Reconciliation ?? baseDoc.Reconciliation,
            Cover = new CoverInfo
            {
                TotalPosted = parcel.Cover?.TotalPosted ?? 0,
                HearingDate = parcel.Cover?.HearingDate ?? "",
                CaseNumber = parcel.Cover?.CaseNumber ?? "",
                Applicant = parcel.Cover?.Applicant ?? "",
                Agent = parcel.Cover?.Agent ?? "",
                CurrentRollValue = parcel.Cover?.CurrentRollValue ?? 0,
                ApplicantOpinionValue = parcel.Cover?.ApplicantOpinionValue ?? 0,
                AssessorOpinionValue = parcel.Cover?.AssessorOpinionValue ?? 0,
                PresentedBy = parcel.Cover?.PresentedBy ?? "",
                ApplicationNumber = parcel.Cover?.ApplicationNumber ?? "",
                ApplicantName = parcel.Cover?.ApplicantName ?? "",
                ApplicantAddress = parcel.Cover?.ApplicantAddress ?? "",
                AgentName = parcel.Cover?.AgentName ?? "",
                AgentAddress = parcel.Cover?.AgentAddress ?? "",
                Tra = parcel.Cover?.Tra ?? "",
                AssessmentNo = parcel.Cover?.AssessmentNo ?? "",
                ArbNo = parcel.Cover?.ArbNo ?? "",
                YearArbCreated = parcel.Cover?.YearArbCreated ?? "",
                Location = parcel.Cover?.Location ?? "",
                SupplementalNo = parcel.Cover?.SupplementalNo ?? "",
                Acreage = parcel.Cover?.Acreage ?? "",
                Use = parcel.Cover?.Use ?? "",
                FactsJustifying = parcel.Cover?.FactsJustifying ?? "",
                // Row-by-row merge with the default categories (mirrors the JS
                // normalizeParcel valueCategories map: each provided row is
                // spread over its default, so missing fields keep defaults).
                ValueCategories = MergeValueCategories(parcel.Cover?.ValueCategories),
            },
        };
    }

    /// <summary>
    /// Merges provided value-category rows over the default rows, one-to-one
    /// by index (mirrors the JS normalizeParcel spread-merge semantics).
    /// </summary>
    private static List<ValueCategory> MergeValueCategories(List<ValueCategory>? provided)
    {
        var defaults = CoverInfo.DefaultCategories();
        if (provided is null) return defaults;
        return defaults
            .Select((d, i) => i < provided.Count
                ? new ValueCategory
                {
                    Category = provided[i].Category ?? d.Category,
                    Code = provided[i].Code ?? d.Code,
                    RollValue = provided[i].RollValue,
                    StipulatedValue = provided[i].StipulatedValue,
                }
                : d)
            .Concat(provided.Skip(defaults.Count))
            .ToList();
    }
}
