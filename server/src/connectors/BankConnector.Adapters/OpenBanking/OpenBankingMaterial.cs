using System.Text.Json;
using System.Text.Json.Serialization;
using Connector.Kit.Errors;
using Connector.Kit.Security;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// What an aggregator session is made of: the consent's id at the party, the
/// institution it was given for, and the accounts it reaches — with the
/// details learned about them, so the daily budget is not spent on details
/// twice. No credential: the operator's key stays in configuration, and a
/// consent id opens nothing without it.
/// </summary>
internal sealed record ConsentMaterial
{
    public required string ConsentId { get; init; }

    public required string InstitutionId { get; init; }

    public required string InstitutionName { get; init; }

    public string Country { get; init; } = "NL";

    public IReadOnlyList<ConsentAccount> Accounts { get; init; } = [];

    private const string ConsentKey = "consent_id";
    private const string InstitutionIdKey = "institution_id";
    private const string InstitutionNameKey = "institution_name";
    private const string CountryKey = "country";
    private const string AccountsKey = "accounts";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public SessionMaterial ToMaterial() => new()
    {
        Extra = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [ConsentKey] = ConsentId,
            [InstitutionIdKey] = InstitutionId,
            [InstitutionNameKey] = InstitutionName,
            [CountryKey] = Country,
            [AccountsKey] = JsonSerializer.Serialize(Accounts, Json),
        },
    };

    public static ConsentMaterial From(SessionMaterial? material, string providerId)
    {
        if (material is null || !material.Extra.TryGetValue(ConsentKey, out var consent) || string.IsNullOrWhiteSpace(consent))
        {
            throw ConnectorException.SessionExpired($"{providerId}: the session carries no consent");
        }
        var accounts = material.Extra.TryGetValue(AccountsKey, out var json) && !string.IsNullOrWhiteSpace(json)
            ? JsonSerializer.Deserialize<List<ConsentAccount>>(json, Json) ?? []
            : [];
        return new ConsentMaterial
        {
            ConsentId = consent,
            InstitutionId = material.Extra.GetValueOrDefault(InstitutionIdKey, string.Empty),
            InstitutionName = material.Extra.GetValueOrDefault(InstitutionNameKey, string.Empty),
            Country = material.Extra.GetValueOrDefault(CountryKey, "NL"),
            Accounts = accounts,
        };
    }
}

/// <summary>One account a consent reaches, as the party identifies it, plus what its details said.</summary>
internal sealed record ConsentAccount
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("iban")]
    public string? Iban { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("currency")]
    public string? Currency { get; init; }

    /// <summary>Details were read once already; a fetch need not spend budget on them again.</summary>
    [JsonPropertyName("detailed")]
    public bool Detailed { get; init; }
}
