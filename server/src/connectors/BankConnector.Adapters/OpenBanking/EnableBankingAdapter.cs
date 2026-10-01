using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// Enable Banking as a bank party. Institutions are named by
/// <c>name|country</c> (the aggregator has no ids), the consent is born only
/// when the bank returns with a single-use code, and the session id that
/// exchange mints is the consent. The redirect address must be registered
/// with the aggregator beforehand — the wizard's registration step — which
/// is why the return page keeps its path across the years.
/// </summary>
public sealed class EnableBankingAdapter : OpenBankingAdapter
{
    public const string ProviderId = "enablebanking";
    public const int MaxHistoryDays = 730;

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Enable Banking",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
        LoginNeedsHeadedAgent = false,
        Logout = LogoutSupport.Account,
        OffersCredentialStore = false,
        SecretCustody = SecretCustody.Server,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "enablebanking",
        NotesKey = "connect.enablebanking.notes",
        Auth = OpenBankingManifests.Auth(),
        Resources = OpenBankingManifests.Resources(MaxHistoryDays, "fetch.enablebanking.notes"),
        Limits = OpenBankingManifests.Limits(MaxHistoryDays),
    };

    private readonly EnableBankingClient _client;

    public EnableBankingAdapter(EnableBankingOptions options, TimeProvider? time = null) : base(time)
    {
        ArgumentNullException.ThrowIfNull(options);
        _client = new EnableBankingClient(options, Time);
    }

    public override ProviderManifest Describe() => Instance;

    protected override string ReferenceKey => "state";

    protected override string ReferencePrefix => "ebr";

    protected override async Task<IReadOnlyList<Institution>> InstitutionsAsync(HttpClient http, string country, CancellationToken ct) =>
        [.. (await _client.AspspsAsync(http, country, ct).ConfigureAwait(false))
            .Select(a => new Institution($"{a.Name}|{a.Country}", a.Name, a.Logo, a.TransactionTotalDays))];

    protected override async Task<(string Url, string PendingId)> StartConsentAsync(
        HttpClient http, Institution institution, string returnUrl, string reference, CancellationToken ct)
    {
        var separator = institution.Id.LastIndexOf('|');
        if (separator < 0) throw ConnectorException.InvalidRequest($"{ProviderId}: '{institution.Id}' is not a name|country institution id");
        var url = await _client.AuthUrlAsync(http, institution.Id[..separator], institution.Id[(separator + 1)..], reference, returnUrl, ct).ConfigureAwait(false);
        // no id at the aggregator yet: the consent is born when the bank comes back
        return (url, reference);
    }

    protected override async Task<(string ConsentId, IReadOnlyList<string> AccountIds)> CompleteConsentAsync(
        HttpClient http, string pendingId, IReadOnlyDictionary<string, string> landing, CancellationToken ct)
    {
        if (!landing.TryGetValue("code", out var code) || string.IsNullOrWhiteSpace(code))
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, $"{ProviderId}: the bank returned without a code");
        }
        return await _client.SessionAsync(http, code, ct).ConfigureAwait(false);
    }

    protected override Task<(string? Iban, string? Name, string? Currency)> DetailsAsync(HttpClient http, string accountId, CancellationToken ct) =>
        _client.DetailsAsync(http, accountId, ct);

    protected override Task<IReadOnlyList<(string Type, string Amount, string Currency, string? Date)>> BalancesAsync(
        HttpClient http, string accountId, CancellationToken ct) =>
        _client.BalancesAsync(http, accountId, ct);

    protected override async Task<(IReadOnlyList<AggregatorTransaction> Rows, ProviderQuota? Quota)> TransactionsAsync(
        HttpClient http, string accountId, DateOnly from, CancellationToken ct) =>
        (await _client.TransactionsAsync(http, accountId, from, ct).ConfigureAwait(false), null);   // no budget headers at this aggregator

    protected override Task RevokeAsync(HttpClient http, string consentId, CancellationToken ct) =>
        _client.DeleteSessionAsync(http, consentId, ct);
}
