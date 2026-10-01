using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// GoCardless as a bank party. The consent is a requisition: created with an
/// end-user agreement for up to two years of history when the institution
/// offers it, confirmed after the bank's return by reading it back as
/// <c>LN</c>. The operator's account holds every requisition ever made from
/// any environment, so this adapter is also the inventory the admin portal
/// revokes foreign and legacy consents from.
/// </summary>
public sealed class GoCardlessAdapter : OpenBankingAdapter, IRemoteInventory
{
    public const string ProviderId = "gocardless";
    public const int MaxHistoryDays = 730;

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "GoCardless",
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
        LogoRef = "gocardless",
        NotesKey = "connect.gocardless.notes",
        Auth = OpenBankingManifests.Auth(),
        Resources = OpenBankingManifests.Resources(MaxHistoryDays, "fetch.gocardless.notes"),
        Limits = OpenBankingManifests.Limits(MaxHistoryDays),
    };

    private readonly GoCardlessClient _client;

    public GoCardlessAdapter(GoCardlessOptions options, TimeProvider? time = null) : base(time)
    {
        ArgumentNullException.ThrowIfNull(options);
        _client = new GoCardlessClient(options, Time);
    }

    public override ProviderManifest Describe() => Instance;

    protected override string ReferenceKey => "ref";

    protected override string ReferencePrefix => "gcr";

    protected override async Task<IReadOnlyList<Institution>> InstitutionsAsync(HttpClient http, string country, CancellationToken ct) =>
        [.. (await _client.InstitutionsAsync(http, country, ct).ConfigureAwait(false))
            .Select(i => new Institution(i.Id, i.Name, i.Logo, int.TryParse(i.TransactionTotalDays, out var days) ? days : null))];

    protected override async Task<(string Url, string PendingId)> StartConsentAsync(
        HttpClient http, Institution institution, string returnUrl, string reference, CancellationToken ct)
    {
        // deep history is an agreement the institution may refuse; the
        // default 90 days is still a consent worth having
        var wanted = Math.Min(institution.HistoryDays ?? 90, MaxHistoryDays);
        var agreement = wanted > 90 ? await _client.AgreementAsync(http, institution.Id, wanted, ct).ConfigureAwait(false) : null;
        var created = await _client.CreateRequisitionAsync(http, institution.Id, returnUrl, reference, agreement, ct).ConfigureAwait(false);
        return (created.Link, created.Id);
    }

    protected override async Task<(string ConsentId, IReadOnlyList<string> AccountIds)> CompleteConsentAsync(
        HttpClient http, string pendingId, IReadOnlyDictionary<string, string> landing, CancellationToken ct)
    {
        var requisition = await _client.RequisitionAsync(http, pendingId, ct).ConfigureAwait(false);
        return requisition.Status switch
        {
            "LN" => (requisition.Id, requisition.Accounts ?? []),
            "EX" or "RJ" or "SU" => throw new ConnectorException(ErrorCode.ConsentExpired,
                $"{ProviderId}: the bank did not grant the consent ({requisition.Status})"),
            _ => throw new ConnectorException(ErrorCode.ChallengeExpired,
                $"{ProviderId}: the consent was not completed at the bank ({requisition.Status})"),
        };
    }

    protected override async Task<(string? Iban, string? Name, string? Currency)> DetailsAsync(HttpClient http, string accountId, CancellationToken ct)
    {
        var details = await _client.DetailsAsync(http, accountId, ct).ConfigureAwait(false);
        return (details.Iban, details.Name ?? details.OwnerName, details.Currency);
    }

    protected override async Task<IReadOnlyList<(string Type, string Amount, string Currency, string? Date)>> BalancesAsync(
        HttpClient http, string accountId, CancellationToken ct) =>
        [.. (await _client.BalancesAsync(http, accountId, ct).ConfigureAwait(false))
            .Select(b => (b.BalanceType, b.BalanceAmount.Amount, b.BalanceAmount.Currency, b.ReferenceDate))];

    protected override async Task<(IReadOnlyList<AggregatorTransaction> Rows, ProviderQuota? Quota)> TransactionsAsync(
        HttpClient http, string accountId, DateOnly from, CancellationToken ct)
    {
        var (booked, pending, quota) = await _client.TransactionsAsync(http, accountId, from, ct).ConfigureAwait(false);
        var rows = new List<AggregatorTransaction>(booked.Count + pending.Count);
        rows.AddRange(booked.Select(t => Row(t, pending: false)));
        rows.AddRange(pending.Select(t => Row(t, pending: true)));
        return (rows, quota);
    }

    protected override Task RevokeAsync(HttpClient http, string consentId, CancellationToken ct) =>
        _client.DeleteRequisitionAsync(http, consentId, ct);

    // ── the operator's inventory ───────────────────────────────────────

    public async Task<IReadOnlyList<RemoteConsent>> ListRemoteAsync(HttpClient http, CancellationToken ct) =>
        [.. (await _client.ListRequisitionsAsync(http, ct).ConfigureAwait(false)).Select(r => new RemoteConsent
        {
            Id = r.Id,
            Status = r.Status,
            CreatedAt = r.Created,
            Reference = r.Reference,
            InstitutionId = r.InstitutionId,
            Origin = Origin(r.Redirect),
            AccountCount = r.Accounts?.Count ?? 0,
        })];

    public Task RevokeRemoteAsync(HttpClient http, string consentId, CancellationToken ct) =>
        _client.DeleteRequisitionAsync(http, consentId, ct);

    private static string? Origin(string? redirect) =>
        redirect is not null && Uri.TryCreate(redirect, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Authority) : null;

    private static AggregatorTransaction Row(GoCardlessClient.GcTransaction t, bool pending) => new()
    {
        Reference = t.TransactionId,
        InternalReference = t.InternalTransactionId,
        BookingDate = t.BookingDate,
        ValueDate = t.ValueDate,
        Amount = t.TransactionAmount.Amount,
        Currency = t.TransactionAmount.Currency,
        CreditorName = t.CreditorName,
        DebtorName = t.DebtorName,
        CreditorIban = t.CreditorAccount?.Iban,
        DebtorIban = t.DebtorAccount?.Iban,
        Remittance = t.RemittanceInformationUnstructured,
        Pending = pending,
    };
}
