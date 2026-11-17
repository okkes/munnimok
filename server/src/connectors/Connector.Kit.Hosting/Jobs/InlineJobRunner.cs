using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Connector.Kit.Logging;
using Connector.Kit.Manifests;
using Connector.Kit.Tracing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Jobs;

// the in-process agent: same queue, lease and outcome path as a remote one, but never a browser
public sealed class InlineJobRunner(
    IServiceScopeFactory scopes,
    IProviderRegistry registry,
    IHttpClientFactory httpClients,
    Providers.ProviderQuotaService quotas,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    ILogger<InlineJobRunner> logger) : IInlineJobRunner
{
    public const string AgentId = "agt_inline";

    public const string HttpClientName = "connector.provider";

    private readonly ConnectorOptions _options = options.Value;

    public IReadOnlyList<string> Providers { get; } =
    [
        .. registry.Manifests
            .Where(m => m.Agent.Class == AgentClass.Inline && !m.Agent.Required && registry.TryGetAdapter(m.Id, out _))
            .Select(m => m.Id),
    ];

    public bool CanRun(ProviderManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        return Providers.Contains(manifest.Id, StringComparer.Ordinal);
    }

    public void Dispatch() => signals.Signal(ConnectorSignals.Queue);

    public AgentCapabilities Capabilities => new()
    {
        Providers = Providers,
        Runtimes = [ProviderRuntime.Http],
        Class = AgentClass.Inline,
        MaxConcurrency = Math.Max(1, Environment.ProcessorCount / 2),
    };

    public async Task RunAsync(LeasedJob job, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);

        if (!registry.TryGetAdapter(job.Provider, out var adapter))
        {
            await ReportFailureAsync(job, ErrorCode.Internal, $"no adapter registered for '{job.Provider}'", ct);
            return;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(job.Limits.TimeoutSeconds));

        await using var context = new InlineJobContext(
            job, scopes, httpClients.CreateClient(HttpClientName), quotas, logger, budget.Token);

        // holds its own lease like a remote agent, so the sweeper treats a wedged inline job as a dead machine
        // disposed before the budget (declaration order): the loop is stopped while every token it holds is alive
        await using var renewal = LeaseRenewal.Start(
            scopes, job.JobId, AgentId, TimeSpan.FromSeconds(_options.Timeouts.LeaseSeconds), logger, budget.Token);

        // recorded run (#441 L3): kept before the outcome is reported, on a failure too
        var book = job.Record ? new TraceBook(job.JobId, job.Provider, SecretsOf(job), TimeProvider.System) : null;
        using var recording = book is null ? null : TraceScope.Open(book);

        try
        {
            JobResultRequest run;
            try
            {
                run = await ExecuteAsync(adapter, context, job, budget.Token);
            }
            finally
            {
                if (book is not null) await KeepTraceAsync(job, book, ct);
            }

            // flush progress BEFORE the outcome: the queue discards a report arriving after terminal state,
            // which erased the tail of fast runs
            await context.FlushProgressAsync();

            // attached here, not per branch of ExecuteAsync, so a new job kind carries them
            await ReportSuccessAsync(job, run with { Notes = context.Notes }, ct);
        }
        catch (ConnectorException ex)
        {
            await FailAsync(context, job, ex.Code, ex.Detail, ct);
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            await FailAsync(context, job, ErrorCode.ProviderUnavailable, "inline job exceeded its time budget", ct);
        }
        catch (Exception ex)
        {
            // Anything escaping an adapter is ours, not theirs: the caller
            // gets `internal` and a correlation id, never a stack trace.
            logger.LogError(ex, "adapter for {Provider} threw an unhandled exception on job {JobId}",
                job.Provider, job.JobId);
            await FailAsync(context, job, ErrorCode.Internal, ex.GetType().Name, ct);
        }
    }

    // flushed like success: the steps before a break are the first thing read about a run
    private async Task FailAsync(InlineJobContext context, LeasedJob job, ErrorCode code, string? detail, CancellationToken ct)
    {
        await context.FlushProgressAsync();
        await ReportFailureAsync(job, code, detail, context.Notes, ct);
    }

    private static async Task<JobResultRequest> ExecuteAsync(
        IProviderAdapter adapter, InlineJobContext context, LeasedJob job, CancellationToken ct)
    {
        switch (job.Kind)
        {
            case JobKind.Login:
            {
                var login = await adapter.LoginAsync(context, ct);
                return new JobResultRequest
                {
                    SessionMaterial = login.Material,
                    ProviderAccount = login.Account,
                    Reachable = login.Reachable,
                    ExpiresAt = login.ExpiresAt,
                };
            }

            case JobKind.Fetch or JobKind.Refresh:
            {
                var request = job.Request
                              ?? throw ConnectorException.InvalidRequest($"{job.Kind} job carries no resource request");
                var fetch = await adapter.FetchAsync(context, request, ct);
                return new JobResultRequest
                {
                    Accounts = fetch.Accounts,
                    Transactions = fetch.Transactions,
                    Receipts = fetch.Receipts,
                    Registrations = fetch.Registrations,
                    Debts = fetch.Debts,
                    SessionMaterial = fetch.RefreshedMaterial,
                    Complete = fetch.Complete,
                    Via = fetch.Via,
                    Raw = fetch.Raw,
                };
            }

            case JobKind.Logout:
                await adapter.LogoutAsync(context, ct);
                return new JobResultRequest();

            default:
                throw ConnectorException.InvalidRequest($"unknown job kind '{job.Kind}'");
        }
    }

    private IReadOnlyCollection<string> SecretsOf(LeasedJob job)
    {
        if (!registry.TryGetManifest(job.Provider, out var manifest)) return [];

        return
        [
            .. manifest.Auth.AllFields()
                .Where(f => f.Secret)
                .Select(f => job.Inputs.TryGetValue(f.Key, out var v) ? v : null)
                .Where(v => !string.IsNullOrEmpty(v))
                .Select(v => v!),
            .. new[] { job.Material?.AccessToken, job.Material?.RefreshToken }.Where(v => !string.IsNullOrEmpty(v)).Select(v => v!),
        ];
    }

    private async Task KeepTraceAsync(LeasedJob job, TraceBook book, CancellationToken ct)
    {
        try
        {
            book.Note("the run ended");
            using var scope = scopes.CreateScope();
            await scope.ServiceProvider.GetRequiredService<JobTraceService>().KeepAsync(job.JobId, book.Build(), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "job {JobId}: the recording could not be kept", job.JobId);
        }
    }

    private Task ReportSuccessAsync(LeasedJob job, JobResultRequest result, CancellationToken ct) =>
        ReportAsync(job, outcomes => outcomes.SucceedAsync(job.JobId, AgentId, result, ct));

    private async Task ReportFailureAsync(
        LeasedJob job, ErrorCode code, string? detail, CancellationToken ct) =>
        await ReportFailureAsync(job, code, detail, [], ct);

    private Task ReportFailureAsync(
        LeasedJob job, ErrorCode code, string? detail, IReadOnlyList<string> notes, CancellationToken ct) =>
        ReportAsync(job, outcomes => outcomes.FailAsync(job.JobId, AgentId, new JobFailRequest
        {
            Code = ErrorCatalog.Wire(code),
            Detail = detail,
            Notes = notes,
        }, ct));

    // a refused outcome (not leased to agt_inline, unknown job) means the lease moved on and the sweeper
    // re-queued or ended the job: not fixable in code, so a warning, never an event (GlitchTip #26)
    private async Task ReportAsync(LeasedJob job, Func<JobOutcomeService, Task> report)
    {
        using var scope = scopes.CreateScope();
        var outcomes = scope.ServiceProvider.GetRequiredService<JobOutcomeService>();
        try
        {
            await report(outcomes);
        }
        catch (ConnectorException ex) when (ex.Code == ErrorCode.UnsupportedResource)
        {
            logger.LogWarning(
                ex,
                "job {JobId}: its outcome was refused ({Detail}) - the lease had moved on while the run was still going; the queue re-runs or ends the job itself",
                job.JobId, LogSafe.Line(ex.Detail ?? "-"));
        }
    }
}

// a pump, not "run now": running the adapter on the request thread ties the run to a socket,
// and a challenge that takes minutes would kill it
public sealed class InlineJobPump(
    IInlineJobRunner runner,
    IServiceScopeFactory scopes,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    ILogger<InlineJobPump> logger) : BackgroundService
{
    private static readonly IReadOnlyList<JobKind> AllKinds =
        [JobKind.Login, JobKind.Fetch, JobKind.Refresh, JobKind.Logout];

    private readonly ConnectorOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (runner.Providers.Count == 0) return;

        logger.LogInformation("inline runner serving {Providers}", string.Join(", ", runner.Providers));

        var capabilities = runner.Capabilities;
        // not disposed: a job finishing at shutdown releases its slot, and a disposed semaphore would throw
        var slots = new SemaphoreSlim(Math.Max(1, capabilities.MaxConcurrency));
        var ttl = TimeSpan.FromSeconds(_options.Timeouts.LeaseSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            await slots.WaitAsync(stoppingToken);

            LeasedJob? job = null;
            try
            {
                using var scope = scopes.CreateScope();
                var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
                // no owner scope: this is the control plane's own process, not an enrolled machine, and it already holds every material
                job = await queue.TryLeaseAsync(
                    InlineJobRunner.AgentId, null, capabilities, AllKinds, ttl, stoppingToken);
            }
            // A call that timed out is an OperationCanceledException too, and
            // one that leaves this loop stops the whole control plane.
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "inline lease attempt failed");
            }

            if (job is null)
            {
                slots.Release();
                await signals.WaitAsync(ConnectorSignals.Queue, TimeSpan.FromSeconds(2), stoppingToken);
                continue;
            }

            var leased = job;
            _ = Task.Run(async () =>
            {
                try
                {
                    await runner.RunAsync(leased, stoppingToken);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "inline job {JobId} escaped its own error handling", leased.JobId);
                }
                finally
                {
                    slots.Release();
                    signals.Signal(ConnectorSignals.Queue);
                }
            }, CancellationToken.None);
        }
    }
}
