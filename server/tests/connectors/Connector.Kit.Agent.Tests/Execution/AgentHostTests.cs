using System.Collections.Concurrent;
using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Errors;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// The host's life around the job loop: how it gets (or keeps) its
/// enrollment, what it does when the control plane will not have it, and
/// how it lets go of a job that outlives the drain window at shutdown.
/// </summary>
public sealed class AgentHostTests
{
    private const string ControlPlane = "https://control-plane.test/";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task An_enrollment_on_disk_is_resumed_without_asking_for_a_code()
    {
        using var box = new Box();
        new AgentStateStore(box.StatePath, NullLogger<AgentStateStore>.Instance).Save(new AgentEnrollment
        {
            AgentId = "agt_kept",
            Token = "tok_kept",
            ControlPlane = ControlPlane,
            EnrolledAt = DateTimeOffset.UtcNow,
            HeartbeatSeconds = 5,
        });
        var host = box.Build(code: null);

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.BeatsAt.Count > 0);
        await host.StopAsync(CancellationToken.None);

        Assert.Empty(box.Control.Enrollments);
        Assert.Contains(box.Log.Lines, line => line.Contains("resumed enrollment as agt_kept", StringComparison.Ordinal));
        Assert.False(box.Lifetime.Stopped);
    }

    [Theory]
    [InlineData(false, "ConnectorAgent:EnrollmentCode")]
    [InlineData(true, "ConnectorAgent:Connections:0:EnrollmentCode")]
    public async Task No_enrollment_and_no_code_retires_the_connector_and_names_the_setting_to_fill(bool named, string key)
    {
        using var box = new Box(named);
        var host = box.Build(code: null);

        await host.StartAsync(CancellationToken.None);
        await host.ExecuteTask!.WaitAsync(Patience);

        Assert.True(box.Lifetime.Stopped);
        Assert.Empty(box.Control.Enrollments);
        Assert.Contains(box.Log.Lines, line => line.Contains("mint one and set " + key, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_rejected_code_is_a_verdict_the_connector_retires_on()
    {
        using var box = new Box();
        box.Intercept = request => Ends(request, "/enroll") ? new HttpResponseMessage(HttpStatusCode.Forbidden) : null;
        var host = box.Build(code: "AGNT-USED-0001");

        await host.StartAsync(CancellationToken.None);
        await host.ExecuteTask!.WaitAsync(Patience);

        Assert.True(box.Lifetime.Stopped);
        Assert.Contains(box.Log.Lines, line => line.Contains("enrollment was rejected", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_control_plane_that_is_down_at_start_up_is_retried_until_it_answers()
    {
        using var box = new Box();
        var attempts = 0;
        box.Intercept = request =>
        {
            if (!Ends(request, "/enroll")) return null;
            if (Interlocked.Increment(ref attempts) == 1) throw new HttpRequestException("connection refused");
            return null;
        };
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.Enrollments.Count == 1);
        // The "enrolled as" line is written a beat after the control plane
        // records the enrolment; stopping on the count alone raced it on a
        // slow runner (CI, 2026-10-02). Wait for the line itself.
        await Box.WaitUntil(() => box.Log.Lines.Any(line => line.Contains("enrolled as agt_new", StringComparison.Ordinal)));
        await host.StopAsync(CancellationToken.None);

        Assert.Equal(2, attempts);
        Assert.Contains(box.Log.Lines, line => line.Contains("enrollment could not reach", StringComparison.Ordinal));
        Assert.Contains(box.Log.Lines, line => line.Contains("enrolled as agt_new", StringComparison.Ordinal));
        Assert.False(box.Lifetime.Stopped);
    }

    [Fact]
    public async Task A_lease_poll_that_fails_is_retried_and_a_rejected_token_ends_the_connector()
    {
        using var box = new Box();
        var polls = 0;
        box.Intercept = request =>
        {
            if (!Ends(request, "/jobs/lease")) return null;
            return Interlocked.Increment(ref polls) switch
            {
                1 => new HttpResponseMessage(HttpStatusCode.BadGateway),
                2 => null,
                _ => new HttpResponseMessage(HttpStatusCode.Unauthorized),
            };
        };
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await host.ExecuteTask!.WaitAsync(Patience);

        Assert.True(polls >= 3, $"{polls} lease poll(s)");
        Assert.Contains(box.Log.Lines, line => line.Contains("lease poll failed", StringComparison.Ordinal));
        Assert.Contains(box.Log.Lines, line => line.Contains("giving this connector up: the control plane rejected our token", StringComparison.Ordinal));
        Assert.True(box.Lifetime.Stopped);
        Assert.False(File.Exists(box.StatePath), "a rejected token was left on disk");
    }

    [Fact]
    public async Task A_heartbeat_the_control_plane_rejects_ends_the_connector_too()
    {
        using var box = new Box();
        box.Intercept = request => Ends(request, "/heartbeat") ? new HttpResponseMessage(HttpStatusCode.Unauthorized) : null;
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await host.ExecuteTask!.WaitAsync(Patience);

        Assert.True(box.Lifetime.Stopped);
        Assert.Contains(box.Log.Lines, line => line.Contains("giving this connector up", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_job_that_outlives_the_drain_window_is_aborted_and_reports_its_own_failure()
    {
        using var box = new Box();
        var adapter = new DecidedAdapter { Parks = true };
        var host = box.Build(code: "AGNT-NEW-0001", adapter, agent =>
        {
            agent.ShutdownDrainTimeout = TimeSpan.FromMilliseconds(200);
            agent.ShutdownAbortGrace = TimeSpan.FromSeconds(20);
        });
        box.Control.Enqueue(TestRig.Login(budgetSeconds: 60));

        await host.StartAsync(CancellationToken.None);
        await adapter.Parked.Task.WaitAsync(Patience);
        await host.StopAsync(CancellationToken.None);

        Assert.Contains(box.Log.Lines, line => line.Contains("the drain window elapsed", StringComparison.Ordinal));
        Assert.True(box.Control.FailedWith(ErrorCode.AgentUnavailable), box.Control.FailureCode);
    }

    [Fact]
    public async Task The_enrollment_claims_the_adapter_catalogue_this_agent_runs()
    {
        using var box = new Box();
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.Enrollments.Count == 1);
        await host.StopAsync(CancellationToken.None);

        var claimed = box.Control.Enrollments[0].Capabilities.CatalogDigest;
        Assert.Equal(new ProviderRegistry([new DecidedAdapter()]).AgentCatalogDigest, claimed);
        Assert.StartsWith("sha256:", claimed, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_control_plane_on_another_catalogue_is_said_so_once_not_on_every_beat()
    {
        using var box = new Box();
        box.Control.CatalogDigest = "sha256:somebody-elses-adapters";
        box.Control.HeartbeatSeconds = 5;
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.BeatsAt.Count >= 2);
        await host.StopAsync(CancellationToken.None);

        var mismatch = box.Log.Lines.Where(line => line.Contains("runs adapter catalogue", StringComparison.Ordinal)).ToList();
        Assert.Single(mismatch);
        Assert.Contains("sha256:somebody-elses-adapters", mismatch[0], StringComparison.Ordinal);
        Assert.Contains("same image and configuration", mismatch[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_control_plane_on_the_same_catalogue_is_noted_as_a_match()
    {
        using var box = new Box();
        box.Control.CatalogDigest = new ProviderRegistry([new DecidedAdapter()]).AgentCatalogDigest;
        var host = box.Build(code: "AGNT-NEW-0001");

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.BeatsAt.Count >= 1);
        await host.StopAsync(CancellationToken.None);

        Assert.Contains(box.Log.Lines, line => line.Contains("matches the control plane", StringComparison.Ordinal));
        Assert.DoesNotContain(box.Log.Lines, line => line.Contains("runs adapter catalogue", StringComparison.Ordinal));
    }

    /// <summary>
    /// A released hosted slot (#420 A2): the control plane asks for a wipe
    /// on the beat; the host wipes the previous person's profile, stays
    /// enrolled and serving, says so on the next beat - and only once.
    /// </summary>
    [Fact]
    public async Task A_released_hosted_slot_wipes_its_profiles_on_request_and_keeps_serving()
    {
        using var box = new Box();
        var profile = Path.Combine(box.ProfileRoot, "prf_previous_person");
        Directory.CreateDirectory(profile);
        await File.WriteAllTextAsync(Path.Combine(profile, "Cookies"), "a bank, signed in");
        box.Control.ResetsProfiles = true;
        box.Control.HeartbeatSeconds = 5;
        var host = box.Build(code: "AGNT-SLOT-0001");

        await host.StartAsync(CancellationToken.None);
        await Box.WaitUntil(() => box.Control.ResetDoneBeats >= 1);
        // one more ordinary beat after the control plane stopped asking
        var heard = box.Control.BeatsAt.Count;
        await Box.WaitUntil(() => box.Control.BeatsAt.Count > heard);
        await host.StopAsync(CancellationToken.None);

        Assert.False(Directory.Exists(profile), "the previous person's profile survived the wipe");
        Assert.False(box.Lifetime.Stopped, "a wipe is not a retirement");
        Assert.True(File.Exists(box.StatePath), "the enrollment stays");
        Assert.Contains(box.Log.Lines, line => line.Contains("wiping every browser profile", StringComparison.Ordinal));
        Assert.Equal(1, box.Control.ResetDoneBeats);
    }

    private static bool Ends(HttpRequestMessage request, string suffix) =>
        request.RequestUri!.AbsolutePath.EndsWith(suffix, StringComparison.Ordinal);

    /// <summary>One machine with one connector, built the way the real composition builds it.</summary>
    private sealed class Box : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "agent-host-tests", Guid.NewGuid().ToString("N"));
        private readonly bool _named;
        private ServiceProvider? _provider;

        public Box(bool named = false) => _named = named;

        public FakeControlPlane Control { get; } = new() { BaseAddress = new Uri(ControlPlane), AgentId = "agt_new" };

        public RecordingLog Log { get; } = new();

        public StubLifetime Lifetime { get; } = new();

        public string StatePath => Path.Combine(_root, "agent-state.json");

        public string ProfileRoot => Path.Combine(_root, "profiles");

        public Func<HttpRequestMessage, HttpResponseMessage?>? Intercept { get; set; }

        public AgentHost Build(string? code, IProviderAdapter? adapter = null, Action<ConnectorAgentOptions>? configure = null)
        {
            var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["ConnectorAgent:StateFilePath"] = StatePath,
                ["ConnectorAgent:WorkRootDirectory"] = Path.Combine(_root, "work"),
                ["ConnectorAgent:ProfileRootDirectory"] = Path.Combine(_root, "profiles"),
            };
            var prefix = _named ? "ConnectorAgent:Connections:0:" : "ConnectorAgent:";
            if (_named) settings[prefix + "Name"] = "munni";
            settings[prefix + "ControlPlaneBaseUrl"] = ControlPlane;
            if (code is not null) settings[prefix + "EnrollmentCode"] = code;

            var services = new ServiceCollection();
            services.AddSingleton<IHostApplicationLifetime>(Lifetime);
            services.AddLogging(builder => builder.AddProvider(new LogProvider(Log)));
            services.AddConnectorAgent(
                new ConfigurationBuilder().AddInMemoryCollection(settings).Build(),
                agent =>
                {
                    agent.AddAdapter(adapter ?? new DecidedAdapter());
                    configure?.Invoke(agent);
                });
            services.AddSingleton<IHttpClientFactory>(new Factory(this));

            _provider = services.BuildServiceProvider();
            return _provider.GetServices<IHostedService>().Cast<AgentHost>().Single();
        }

        public static async Task WaitUntil(Func<bool> condition)
        {
            var deadline = DateTime.UtcNow + Patience;
            while (!condition())
            {
                if (DateTime.UtcNow > deadline) throw new TimeoutException("the condition never held");
                await Task.Delay(25);
            }
        }

        public void Dispose()
        {
            _provider?.Dispose();
            try
            {
                if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
            }
            catch (IOException)
            {
                // a temp directory the OS is still holding is not a test failure
            }
        }

        private sealed class Factory(Box box) : IHttpClientFactory
        {
            public HttpClient CreateClient(string name) =>
                new(new Interceptor(box) { InnerHandler = box.Control }, disposeHandler: false)
                {
                    BaseAddress = box.Control.BaseAddress,
                    Timeout = Timeout.InfiniteTimeSpan,
                };
        }

        private sealed class Interceptor(Box box) : DelegatingHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var scripted = box.Intercept?.Invoke(request);
                return scripted is null ? base.SendAsync(request, cancellationToken) : Task.FromResult(scripted);
            }
        }
    }

    private sealed class StubLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public bool Stopped => _stopping.IsCancellationRequested;

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }

    private sealed class RecordingLog : ILogger
    {
        private readonly ConcurrentQueue<string> _lines = new();

        public IReadOnlyList<string> Lines => [.. _lines];

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel level) => true;

        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            _lines.Enqueue(formatter(state, exception));
        }

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }

    private sealed class LogProvider(RecordingLog log) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => log;

        public void Dispose()
        {
        }
    }
}
