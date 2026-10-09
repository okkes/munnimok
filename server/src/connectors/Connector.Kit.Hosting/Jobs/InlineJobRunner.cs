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

/// <summary>
/// The in-process agent. It leases through the same queue, renews the same
/// lease and reports through the same outcome path as a remote one - the only
/// difference is that it never has a browser and never leaves the process.
/// </summary>
public sealed class InlineJobRunner(
    IServiceScopeFactory scopes,
    IProviderRegistry registry,
    IHttpClientFactory httpClients,
    Providers.ProviderQuotaService quotas,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    ILogger<InlineJobRunner> logger) : IInlineJobRunner
{
    /// <summary>The lease owner an in-process run claims jobs under.</summary>
    public const string AgentId = "agt_inline";

    /// <summary>The politeness-limited client every adapter is handed.</summary>
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

    /// <summary>What the pump advertises when it asks the queue for work.</summary>
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

        // An inline run holds its own lease exactly as a remote agent does, so
        // the expiry sweeper treats a wedged in-process job identically to a
        // dead machine - including the rule that it never comes back twice.
        // Disposed before the budget is (declaration order), so the loop is
        // stopped and awaited while every token it holds is still alive.
        await using var renewal = LeaseRenewal.Start(
            scopes, job.JobId, AgentId, TimeSpan.FromSeconds(_options.Timeouts.LeaseSeconds), logger, budget.Token);

        // A recorded run (#441 L3): the book is open for this asynchronous flow,
        // the named client's handler writes every call into it, and it is kept
        // before the outcome is reported - on a failure too.
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

            // Every step the adapter reported reaches the row BEFORE the
            // outcome does. Progress is drained by a pump of its own, and the
            // queue discards a report that arrives after the job has gone
            // terminal, so an outcome recorded first erased the tail of any
            // run that finished faster than its own reports - which a mock
            // does on every call and a real T1 adapter does on a good day.
            await context.FlushProgressAsync();

            // Attached here rather than in each branch of ExecuteAsync, so a
            // job kind added later carries them without anybody remembering to.
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

    /// <summary>
    /// The failure path flushes for the same reason the success path does: the
    /// steps a run got through before it broke are the first thing anyone
    /// reads about it.
    /// </summary>
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

    /// <summary>
    /// Both reports go through here because of what a refusal means. The
    /// outcome service answers "not leased to agt_inline" (or "unknown job")
    /// when the queue has moved on without this run: the lease ran out - a
    /// restart, a database that did not answer the renewal - and the sweeper
    /// has re-queued or ended the job on its own. Nothing a developer fixes
    /// in code, so a warning and never an event (GlitchTip #26, 2026-10-06,
    /// at an agent restart: the refusal escaped as an unhandled exception).
    /// </summary>
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
                "job {JobId}: its outcome was refused ({Detail}) - the lease had moved on while the run was still going; the queue re-runs or ends the job itself",
                job.JobId, LogSafe.Line(ex.Detail ?? "-"));
        }
    }
}

/// <summary>
/// Pulls inline-eligible work off the same queue a remote agent uses.
///
/// Modelled as a pump rather than "run this job now" on purpose: a login
/// endpoint that ran the adapter on the request thread would tie the run's
/// lifetime to a socket, and the first challenge - which can take a human
/// minutes - would kill it.
/// </summary>
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
        // Deliberately not disposed: a job still finishing at shutdown releases
        // its slot, and releasing a disposed semaphore would turn an orderly
        // stop into an exception storm.
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
                // No owner scope: this is the control plane running the job in
                // its own process, not a machine somebody enrolled. It already
                // holds every session's material by definition.
                job = await queue.TryLeaseAsync(
                    InlineJobRunner.AgentId, null, capabilities, AllKinds, ttl, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
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
