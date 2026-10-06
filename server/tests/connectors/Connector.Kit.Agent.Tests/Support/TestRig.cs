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

/// <summary>
/// Everything a <see cref="JobRunner"/> needs, wired to fakes, plus the
/// scratch directories it insists on owning.
/// </summary>
internal sealed class TestRig : IDisposable
{
    public const string ProviderId = "test-provider";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "connector-agent-tests", Guid.NewGuid().ToString("N"));

    /// <param name="manifest">
    /// What the REGISTRY serves the runner, which is not the same as what a
    /// context is built with. The runner reads a manifest to decide things the
    /// adapter never sees - whether a failed job should sign its session out,
    /// for one - so a test about that has to be able to state one.
    /// </param>
    /// <param name="time">
    /// The clock every part of this rig reads, the control plane's client
    /// timeouts included. The machine's unless a test hands over a
    /// <see cref="TestClock"/>, which is what the cases about lease renewal
    /// need: their numbers are measured in minutes and their assertions in
    /// seconds.
    /// </param>
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
            // The poll gap is what the parked wait actually spends its time in;
            // the production default of two seconds would make every test that
            // parks slower than the thing it is testing.
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

    /// <summary>The clock this rig runs on.</summary>
    public TimeProvider Time { get; }

    /// <summary>
    /// Who this agent says it is.
    /// </summary>
    /// <remarks>
    /// Exposed so a test can be TWO agents. A BYO agent derives its profile id
    /// from this, and the last time that id did not carry the agent, two
    /// households on the same provider collided on the control plane's primary
    /// key - and the losing heartbeat took the agent's liveness with it. A rig
    /// that can only ever be one machine cannot state that.
    /// </remarks>
    public AgentIdentity Identity { get; } = new();

    public FakeControlPlane Control { get; }

    public ConnectorAgentOptions Options { get; }

    public JobRunner Runner { get; }

    public ProfileStore Profiles { get; }

    /// <summary>
    /// A login job with a budget expressed in whole seconds, as the wire has
    /// it. <paramref name="leaseSeconds"/> drives how often the runner renews:
    /// it renews at half the remaining lease, floored at five seconds.
    /// </summary>
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

    /// <summary>
    /// A context built the way the runner builds one, minus the runner.
    /// </summary>
    /// <param name="manifest">
    /// Overrides the default for the handful of tests that are about the
    /// manifest reaching something - the live view's origin allowlist is read
    /// from it, so a test of that wiring has to be able to state one.
    /// </param>
    /// <param name="browser">
    /// The lease options this context is built over. Defaulted to the headless
    /// minimum, because most tests here are about something else entirely.
    /// <para>
    /// A test about what the context READS OFF the browser has to pass the
    /// runner's own answer - <see cref="JobRunner.BrowserOptionsForTest"/> -
    /// rather than a hand-built one, or it would be asserting the decision
    /// beside the decision and would pass with the decision deleted.
    /// </para>
    /// </param>
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

    /// <summary>
    /// The simplest manifest an agent will accept: browser-interactive so the
    /// runner takes the login path, with one secret field so the redactor and
    /// the scrubber both have something to do.
    /// </summary>
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

/// <summary>
/// An adapter whose login does exactly one scripted thing, so a test can say
/// "park on a human" or "never come back" without a fixture.
/// </summary>
internal sealed class ScriptedAdapter(Func<IJobContext, CancellationToken, Task> login) : IProviderAdapter
{
    /// <summary>Raises one challenge and returns as soon as it is answered.</summary>
    public static ScriptedAdapter AsksAHuman(TimeSpan window) => new(async (ctx, ct) =>
    {
        await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = "connect.challenge.sms",
            ExpiresAt = DateTimeOffset.UtcNow + window,
        }, ct);
    });

    /// <summary>Raises nothing and never finishes. A wedged adapter, exactly.</summary>
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
