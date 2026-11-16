using System.Globalization;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// T3 that takes its time: proves an SSE stream staying open, lease renewal by heartbeat and progress rendering
// the duration is config so a human can watch at sixty seconds and a test suite run at zero
public sealed class MockBankSlowAdapter : MockBankAdapter
{
    public const string ProviderId = "mock-bank-slow";

    /// <summary>Config key: how long a run should take, in seconds.</summary>
    public const string RunSecondsKey = "run_seconds";

    public const int DefaultRunSeconds = 60;

    private const int MaxRunSeconds = 600;
    private const int TtlSeconds = 3_600;

    private static readonly JobStep[] LoginSteps =
    [
        JobStep.OpeningProvider, JobStep.Authenticating, JobStep.SelectingAccounts, JobStep.Finalizing,
    ];

    private static readonly JobStep[] FetchSteps =
    [
        JobStep.OpeningProvider, JobStep.SelectingAccounts, JobStep.Downloading, JobStep.Parsing, JobStep.Normalizing,
    ];

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (slow)",
        Kind = ProviderKind.Bank,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = MockBankManifests.ResidentialPooled,
        UnattendedFetch = false,
        SecretCustody = SecretCustody.Client,
        // the one provider opting out of web: a login this heavy on every visit is what the opt-out is for,
        // and one user keeps the path honest
        WebSupport = WebSupport.None,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.notes",
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Config =
            [
                new FieldSpec
                {
                    Key = RunSecondsKey,
                    Type = FieldType.Number,
                    Required = false,
                    LabelKey = "connect.mock_bank.config.run_seconds",
                    Pattern = "^[0-9]{1,3}$",
                },
            ],
            Steps = [MockBankManifests.Credentials],
            Challenges = [ChallengeType.MfaCode],
            Session = new SessionSpec { TtlSeconds = TtlSeconds, Refreshable = false, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources = MockBankManifests.Resources(typicalDurationSeconds: DefaultRunSeconds),
        Limits = MockBankManifests.Limits(),
    };

    public MockBankSlowAdapter(TimeProvider? time = null) : base(time)
    {
    }

    public override ProviderManifest Describe() => Instance;

    public override async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        _ = RequireInput(ctx, "username");
        var password = RequireInput(ctx, "password");

        var run = RunDuration(ctx);
        await PaceAsync(ctx, LoginSteps, run, ct).ConfigureAwait(false);

        ctx.CredentialSubmitted();

        if (string.Equals(password, MockBankCredentials.RejectedPassword, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidCredentials($"{ProviderId}: fixture rejects this password");
        }

        return Connected(ctx, new SessionMaterial { StorageState = MockBankCredentials.StorageState }, TtlSeconds);
    }

    public override async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        await PaceAsync(ctx, FetchSteps, RunDuration(ctx), ct).ConfigureAwait(false);
        return Serve(ctx, request);
    }

    // progress is reported before each wait, so a consumer sees the step it is waiting on
    private async Task PaceAsync(IJobContext ctx, JobStep[] steps, TimeSpan total, CancellationToken ct)
    {
        var slice = total / steps.Length;

        foreach (var step in steps)
        {
            ctx.Progress(step);
            if (slice > TimeSpan.Zero)
            {
                // delaying through the injected TimeProvider lets a test finish a sixty-second run instantly
                await Task.Delay(slice, Time, ct).ConfigureAwait(false);
            }
        }
    }

    private static TimeSpan RunDuration(IJobContext ctx)
    {
        if (!ctx.Config.TryGetValue(RunSecondsKey, out var raw) || string.IsNullOrWhiteSpace(raw))
        {
            return TimeSpan.FromSeconds(DefaultRunSeconds);
        }

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds) ||
            seconds < 0 || seconds > MaxRunSeconds)
        {
            throw ConnectorException.InvalidRequest(
                $"config '{RunSecondsKey}' must be a whole number of seconds between 0 and {MaxRunSeconds}");
        }

        return TimeSpan.FromSeconds(seconds);
    }
}
