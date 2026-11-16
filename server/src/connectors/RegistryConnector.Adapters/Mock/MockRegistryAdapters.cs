using System.Globalization;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace RegistryConnector.Adapters.Mock;

// offline: the only way to exercise a stored password plus a fresh authenticator code on EVERY sync end to end
public static class MockRegistryAdapters
{
    public const string Simple = "mock-registry-simple";
    public const string TwoFactor = "mock-registry-2fa";

    public const string AcceptedCode = "314159";

    public static IReadOnlyList<IProviderAdapter> All(TimeProvider? time = null) =>
    [
        new MockRegistryAdapter(Simple, "Mock registry", twoFactor: false, time),
        new MockRegistryAdapter(TwoFactor, "Mock registry (2FA every sync)", twoFactor: true, time),
    ];
}

public sealed class MockRegistryAdapter : IProviderAdapter
{
    public const string CreditsResource = "credits";

    private readonly string _id;
    private readonly bool _twoFactor;
    private readonly ProviderManifest _manifest;
    private readonly TimeProvider _time;

    public MockRegistryAdapter(string id, string name, bool twoFactor, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);

        _id = id;
        _twoFactor = twoFactor;
        _time = time ?? TimeProvider.System;
        _manifest = MockRegistryManifest.Build(id, name, twoFactor);
    }

    public ProviderManifest Describe() => _manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.Authenticating);

        var username = Required(ctx, "username");
        _ = Required(ctx, "password");

        ctx.CredentialSubmitted();

        if (_twoFactor) await AnswerCodeAsync(ctx, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        return new LoginResult
        {
            Material = new SessionMaterial { AccessToken = $"mock-registry-token-{username}" },
            Account = new ProviderAccount { DisplayName = _manifest.Name, ExternalId = "81426000" },
            ExpiresAt = _time.GetUtcNow().AddSeconds(MockRegistryManifest.SessionTtlSeconds),
        };
    }

    // the consumer must render a challenge during a FETCH, and a scheduled sync must be refused outright rather than fail at 3am
    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (_twoFactor) await AnswerCodeAsync(ctx, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Downloading);
        ctx.Progress(JobStep.Normalizing);

        return new FetchResult { Registrations = [.. Credits(ctx.SessionId)], Via = "fixture" };
    }

    private async Task AnswerCodeAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(
            new Challenge
            {
                Type = ChallengeType.MfaCode,
                PromptKey = "connect.challenge.authenticator_code",
                Length = 6,
                ExpiresAt = _time.GetUtcNow().AddMinutes(5),
            },
            ct).ConfigureAwait(false);

        if (!string.Equals(answer.Value?.Trim(), MockRegistryAdapters.AcceptedCode, StringComparison.Ordinal))
        {
            // a wrong code is not a wrong password: the credential is fine, and a reset would send them somewhere that cannot help
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{_id}: the fixture accepts only {MockRegistryAdapters.AcceptedCode}");
        }
    }

    // deterministic per session so a test asserts on ids and content hashes
    private static IEnumerable<CreditRegistration> Credits(string sessionId)
    {
        yield return Credit(sessionId, new MockCredit(
            "MOCK-0001", "Mock Bank N.V.", CreditKind.Revolving, 200_000, CreditStatus.Running, "Doorlopend krediet"));

        yield return Credit(sessionId, new MockCredit(
            "MOCK-0002", "Mock Telecom B.V.", CreditKind.DeferredPayment, 99_600, CreditStatus.Running,
            "Verzendhuiskrediet")
        {
            From = new DateOnly(2026, 1, 15),
            To = new DateOnly(2028, 1, 15),
        });

        // carried verbatim, never interpreted: what an A2 means for a mortgage is not a connector's judgement
        yield return Credit(sessionId, new MockCredit(
            "MOCK-0003", "Mock Finance B.V.", CreditKind.Instalment, 530_400, CreditStatus.Ended, "Aflopend krediet")
        {
            From = new DateOnly(2023, 3, 1),
            To = new DateOnly(2025, 9, 1),
            Arrears = "A2",
        });
    }

    private sealed record MockCredit(
        string ExternalId, string Creditor, CreditKind Kind, long Minor, CreditStatus Status, string Label)
    {
        public DateOnly? From { get; init; }

        public DateOnly? To { get; init; }

        public string? Arrears { get; init; }
    }

    private static CreditRegistration Credit(string sessionId, MockCredit credit) =>
        new()
        {
            Id = Ids.ForRecord(Ids.CreditRegistration, sessionId, credit.ExternalId),
            ExternalId = credit.ExternalId,
            Creditor = credit.Creditor,
            Kind = credit.Kind,
            KindLabel = credit.Label,
            Amount = new Money(credit.Minor, "EUR"),
            Status = credit.Status,
            StartedOn = credit.From,
            EndsOn = credit.To,
            ArrearsCode = credit.Arrears,
        };

    private static string Required(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest(
                string.Create(CultureInfo.InvariantCulture, $"mock-registry: '{key}' is required"));
}
