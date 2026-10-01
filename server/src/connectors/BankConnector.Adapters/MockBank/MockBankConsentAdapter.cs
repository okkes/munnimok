using BankConnector.Adapters.OpenBanking;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

/// <summary>
/// The aggregator shape with nothing behind it (#414): an institution the
/// person picks from a list the party serves, a consent as a redirect the
/// return page answers, server custody, a nightly fetch, a budget the party
/// reports, and an inventory the operator revokes from. Every piece the
/// consumer builds for GoCardless and Enable Banking can be walked against
/// this one with zero network — the local stack runs it.
/// </summary>
public sealed class MockBankConsentAdapter : MockBankAdapter, ILookupProvider, IRemoteInventory
{
    public const string ProviderId = "mock-bank-consent";
    public const string Institution = "mock-institution";
    public const string InstitutionName = "Mock Institution";
    public const string ConsentPage = "https://mock-bank.invalid/consent/";

    private static readonly byte[] Logo = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (consent)",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
        Logout = LogoutSupport.Account,
        SecretCustody = SecretCustody.Server,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.notes",
        Auth = OpenBankingManifests.Auth(),
        Resources = MockBankManifests.Resources(typicalDurationSeconds: 2),
        Limits = OpenBankingManifests.Limits(MockBankLedger.HistoryDays),
    };

    private readonly List<RemoteConsent> _inventory =
    [
        new() { Id = "mock-consent-here", Status = "LN", Reference = "gcr_here", InstitutionId = Institution, Origin = "https://app.mock.invalid", AccountCount = 2, CreatedAt = MockBankLedger.Anchor.ToDateTime(TimeOnly.MinValue) },
        new() { Id = "mock-consent-elsewhere", Status = "EX", Reference = "legacy", InstitutionId = Institution, Origin = "https://other.mock.invalid", AccountCount = 0, CreatedAt = MockBankLedger.Anchor.AddDays(-100).ToDateTime(TimeOnly.MinValue) },
    ];

    public MockBankConsentAdapter(TimeProvider? time = null) : base(time)
    {
    }

    public override ProviderManifest Describe() => Instance;

    public override async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();
        ctx.Progress(JobStep.OpeningProvider);
        var institution = RequireInput(ctx, OpenBankingManifests.InstitutionField);
        if (!string.Equals(institution, Institution, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest($"{ProviderId}: '{institution}' is not an institution this party lists");
        }
        var returnUrl = OpenBankingReturn.RequireReturnUrl(ctx, ProviderId);
        var reference = Ids.New("mcr");

        ctx.Progress(JobStep.AwaitingHuman);
        var answer = await ctx.AskAsync(
            OpenBankingReturn.Redirect(ConsentPage + reference, returnUrl, reference, Time.GetUtcNow().AddMinutes(OpenBankingManifests.RedirectMinutes)),
            ct).ConfigureAwait(false);
        OpenBankingReturn.RequireReturn(ProviderId, answer, reference, "ref");

        ctx.Progress(JobStep.Finalizing);
        var consent = new ConsentMaterial
        {
            ConsentId = $"mock-consent-{reference}",
            InstitutionId = Institution,
            InstitutionName = InstitutionName,
            Accounts = [.. Ledger.Reachable.Select(a => new ConsentAccount { Id = a.ExternalId, Iban = a.ExternalId, Name = a.DisplayName, Currency = "EUR", Detailed = true })],
        };
        return new LoginResult
        {
            Material = consent.ToMaterial(),
            Account = new ProviderAccount { DisplayName = InstitutionName, ExternalId = consent.ConsentId },
            Reachable = Ledger.Reachable,
            ExpiresAt = Time.GetUtcNow().AddDays(OpenBankingManifests.ConsentDays),
        };
    }

    public override Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        _ = ConsentMaterial.From(ctx.Material, ProviderId);   // a session without a consent is no session
        var result = Serve(ctx, request);
        // what an aggregator says in its headers: four a day, one spent by this fetch
        ctx.ReportQuota(new ProviderQuota { Limit = 4, Remaining = 3, ResetAt = Time.GetUtcNow().AddHours(1), SeenAt = Time.GetUtcNow() });
        return Task.FromResult(result);
    }

    public Task<IReadOnlyList<LookupOption>> LookupAsync(HttpClient http, string field, LookupQuery query, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!string.Equals(field, OpenBankingManifests.InstitutionField, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId} lists no options for '{field}'");
        }
        IReadOnlyList<LookupOption> all =
        [
            new() { Value = Institution, Label = InstitutionName, HasLogo = true },
            new() { Value = "mock-institution-plain", Label = "Mock Institution (no logo)", HasLogo = false },
        ];
        var text = query.Text.Trim();
        return Task.FromResult<IReadOnlyList<LookupOption>>(text.Length == 0
            ? all
            : [.. all.Where(o => o.Label.Contains(text, StringComparison.OrdinalIgnoreCase) || o.Value.Contains(text, StringComparison.OrdinalIgnoreCase))]);
    }

    public Task<LookupLogo?> LookupLogoAsync(HttpClient http, string field, string value, CancellationToken ct) =>
        Task.FromResult(string.Equals(value, Institution, StringComparison.Ordinal) ? new LookupLogo(Logo, "image/png") : null);

    public Task<IReadOnlyList<RemoteConsent>> ListRemoteAsync(HttpClient http, CancellationToken ct)
    {
        lock (_inventory) return Task.FromResult<IReadOnlyList<RemoteConsent>>([.. _inventory]);
    }

    public Task RevokeRemoteAsync(HttpClient http, string consentId, CancellationToken ct)
    {
        lock (_inventory) _inventory.RemoveAll(c => c.Id == consentId);   // already gone is the goal state
        return Task.CompletedTask;
    }
}
