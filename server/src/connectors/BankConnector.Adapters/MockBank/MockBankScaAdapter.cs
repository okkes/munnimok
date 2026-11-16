using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// T3: strong authentication on every login, in two challenges: CodeDisplay (the code travels outward to the human),
// then a passive AppApproval
public sealed class MockBankScaAdapter : MockBankAdapter
{
    public const string ProviderId = "mock-bank-sca";

    private const int TtlSeconds = 604_800;   // 7 days of session reuse

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (SCA)",
        Kind = ProviderKind.Bank,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = MockBankManifests.ResidentialPooled,
        // a human is needed every login, so custody is client and no vault: storing a secret unusable without a human is
        // risk for nothing
        UnattendedFetch = false,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.notes",
        Auth = new AuthSpec
        {
            Flow = AuthFlow.ChallengeResponse,
            Steps = [MockBankManifests.Credentials],
            Challenges = [ChallengeType.CodeDisplay, ChallengeType.AppApproval],
            Session = new SessionSpec { TtlSeconds = TtlSeconds, Refreshable = false, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources = MockBankManifests.Resources(typicalDurationSeconds: 45),
        Limits = MockBankManifests.Limits(),
    };

    public MockBankScaAdapter(TimeProvider? time = null) : base(time)
    {
    }

    public override ProviderManifest Describe() => Instance;

    public override async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);
        _ = RequireInput(ctx, "username");
        var password = RequireInput(ctx, "password");

        ctx.Progress(JobStep.Authenticating);
        ctx.CredentialSubmitted();

        if (string.Equals(password, MockBankCredentials.RejectedPassword, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidCredentials($"{ProviderId}: fixture rejects this password");
        }

        await AuthenticateStronglyAsync(ctx, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        return Connected(ctx, new SessionMaterial { StorageState = MockBankCredentials.StorageState }, TtlSeconds);
    }

    // asks only when the material has no browser session: reusing the stored storage state makes T3 behave like T2
    // for most of a session
    public override async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);

        if (string.IsNullOrEmpty(ctx.Material?.StorageState))
        {
            ctx.Progress(JobStep.Authenticating);
            await AuthenticateStronglyAsync(ctx, ct).ConfigureAwait(false);
        }

        ctx.Progress(JobStep.Downloading);
        return Serve(ctx, request);
    }

    private async Task AuthenticateStronglyAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var response = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.CodeDisplay,
            PromptKey = "connect.mock_bank.challenge.code_display",
            Code = MockBankCredentials.DisplayedCode,
            // short and mandatory: a challenge holds a live browser, so a stale one must fail cleanly and release the agent
            ExpiresAt = Time.GetUtcNow().AddMinutes(3),
        }, ct).ConfigureAwait(false);

        if (!IsResponseCode(response.Value))
        {
            throw new ConnectorException(ErrorCode.MfaFailed, $"{ProviderId}: expected a six-digit device response");
        }

        ctx.Progress(JobStep.AwaitingHuman);

        // passive: nothing to type, so the answer's value is empty by design
        _ = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.AppApproval,
            PromptKey = "connect.mock_bank.challenge.app_approval",
            ExpiresAt = Time.GetUtcNow().AddMinutes(3),
        }, ct).ConfigureAwait(false);
    }

    private static bool IsResponseCode(string? value) =>
        value is { Length: 6 } && value.All(char.IsAsciiDigit);
}
