using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests;

internal sealed class TestRig : IDisposable
{
    public const string ProviderId = "test-provider";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "connector-agent-tests", Guid.NewGuid().ToString("N"));

    // manifest: what the registry serves the runner; it decides things the adapter never sees (e.g. sign-out after a failed job)
    // time: the clock of every part of the rig, client timeouts included; a TestClock for the lease-renewal cases
    public TestRig(
        IProviderAdapter adapter,
        bool headless = true,
        ProviderManifest? manifest = null,
        TimeProvider? time = null)
    {
        Adapter = adapter;
        Time = time ?? TimeProvider.System;
        Control = new FakeControlPlane { Time = Time };

        Options = new ConnectorAgentOptions
        {
            ControlPlaneBaseUrl = new Uri("https://control-plane.test/"),
            WorkRootDirectory = Path.Combine(_root, "work"),
            ProfileRootDirectory = Path.Combine(_root, "profiles"),
            StateFilePath = Path.Combine(_root, "agent-state.json"),
            Headless = headless,
            // short poll gap: the 2s production default would make every test that parks slower than the thing it tests
            AnswerPollInterval = TimeSpan.FromMilliseconds(20),
        };

        var identity = Identity;
        identity.Set(new AgentEnrollment
        {
            AgentId = "agt_test",
            Token = "tok_test",
            ControlPlane = "https://control-plane.test/",
            EnrolledAt = DateTimeOffset.UtcNow,
        });

        Profiles = new ProfileStore(Options.ProfileRootDirectory, NullLogger<ProfileStore>.Instance);

        Runner = new JobRunner(
            new SingleAdapterRegistry(adapter, manifest ?? Manifest),
            new ControlPlaneClient(Control, NullLogger<ControlPlaneClient>.Instance),
            new PolitenessGate(Time),
            Profiles,
            identity,
            Options,
            NullLoggerFactory.Instance,
            Time);
    }

    public IProviderAdapter Adapter { get; }

    public TimeProvider Time { get; }

    // exposed so a test can be two agents: a BYO agent's profile id derives from it, and when it did not, two households
    // on one provider collided on the control plane's primary key and the losing heartbeat took the agent's liveness with it
    public AgentIdentity Identity { get; } = new();

    public FakeControlPlane Control { get; }

    public ConnectorAgentOptions Options { get; }

    public JobRunner Runner { get; }

    public ProfileStore Profiles { get; }

    // leaseSeconds drives renewal: the runner renews at half the remaining lease, floored at five seconds
    public static LeasedJob Login(int budgetSeconds, int leaseSeconds = 120) => new()
    {
        JobId = "job_" + Guid.NewGuid().ToString("N")[..16],
        SessionId = "ses_" + Guid.NewGuid().ToString("N"),
        Provider = ProviderId,
        Kind = JobKind.Login,
        LeaseExpiresAt = DateTimeOffset.UtcNow.AddSeconds(leaseSeconds),
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { ["password"] = "hunter2" },
        Limits = new JobLimits { TimeoutSeconds = budgetSeconds, PolitenessMs = 0 },
    };

    // browser: a test of what the context reads off the browser passes JobRunner.BrowserOptionsForTest, not a hand-built one,
    // or it asserts the decision beside the decision and passes with the decision deleted
    public AgentJobContext Context(
        LeasedJob job, ProviderManifest? manifest = null, BrowserLeaseOptions? browser = null) => new(
        new JobContextOptions
        {
            Job = job,
            Manifest = manifest ?? Manifest,
            WorkRootDirectory = Options.WorkRootDirectory,
            Browser = browser ?? new BrowserLeaseOptions { Headless = Options.Headless },
            AnswerPollInterval = Options.AnswerPollInterval,
            HttpTimeout = Options.ProviderHttpTimeout,
        },
        new ControlPlaneClient(Control, NullLogger<ControlPlaneClient>.Instance),
        new PolitenessGate(Time),
        NullLoggerFactory.Instance,
        Time);

    public Task RunAsync(LeasedJob job, int leaseTtlSeconds = 120, CancellationToken ct = default) =>
        Runner.RunAsync(job, TimeSpan.FromSeconds(leaseTtlSeconds), ct);

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory the OS is still holding is not a test failure.
        }
    }

    // browser-interactive so the runner takes the login path; one secret field so the redactor and scrubber have work
    public static ProviderManifest Manifest { get; } = new()
    {
        Id = ProviderId,
        Name = "Test Provider",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
        UnattendedFetch = false,
        SecretCustody = SecretCustody.Client,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            LabelKey = "connect.field.password",
                        },
                    ],
                },
            ],
            Session = new SessionSpec { TtlSeconds = 3600, Refreshable = false },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
    };

    internal sealed class SingleAdapterRegistry(IProviderAdapter adapter, ProviderManifest served)
        : IProviderRegistry
    {
        public IReadOnlyList<ProviderManifest> Manifests { get; } = [served];

        public string CatalogDigest => "sha256:test";

        public string AgentCatalogDigest => CatalogDigest;

        public bool TryGetManifest(string providerId, out ProviderManifest manifest)
        {
            manifest = served;
            return string.Equals(providerId, served.Id, StringComparison.Ordinal);
        }

        public ProviderManifest RequireManifest(string providerId) =>
            TryGetManifest(providerId, out var m) ? m : throw ConnectorException.Unsupported(providerId);

        public bool TryGetAdapter(string providerId, out IProviderAdapter found)
        {
            found = adapter;
            return string.Equals(providerId, served.Id, StringComparison.Ordinal);
        }
    }
}

internal sealed class ScriptedAdapter(Func<IJobContext, CancellationToken, Task> login) : IProviderAdapter
{
    public static ScriptedAdapter AsksAHuman(TimeSpan window) => new(async (ctx, ct) =>
    {
        await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = "connect.challenge.sms",
            ExpiresAt = DateTimeOffset.UtcNow + window,
        }, ct);
    });

    public static ScriptedAdapter Wedges() => new((_, ct) => Task.Delay(Timeout.Infinite, ct));

    public ProviderManifest Describe() => TestRig.Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        await login(ctx, ct);
        return new LoginResult { Material = new SessionMaterial { StorageState = "{\"cookies\":[],\"origins\":[]}" } };
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        Task.FromResult(FetchResult.Empty);
}
