using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Providers;

/// <summary>
/// Runs the operator's own connections, so a provider that changes is found by
/// a schedule rather than by a person.
///
/// <para>
/// Two phases, and they are separate on purpose. A canary fetch is a real job:
/// it queues, an agent leases it, a browser drives a bank, and the whole thing
/// takes a minute or two. Waiting for that inside a timer tick would mean a
/// stuck provider stalls every other canary behind it. So one phase starts what
/// is due and the other reads what has finished, and a run that never finishes
/// at all is settled by the same expiry sweep that settles a user's.
/// </para>
///
/// <para>
/// Nothing here decides a provider's health directly. The fetch it enqueues
/// goes through the ordinary pipeline, so <see cref="JobOutcomeService"/>
/// degrades on <c>provider_changed</c> and recovers on success exactly as it
/// does for a real user - which is the point. A second opinion about health
/// would be a second thing to keep consistent.
/// </para>
/// </summary>
public sealed class CanaryScheduler(
    IServiceScopeFactory scopes,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<CanaryScheduler> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var seconds = Math.Max(30, options.Value.Timeouts.CanarySweepSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(seconds), time);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                // Never takes the host down. The next tick finds the same rows.
                logger.LogError(ex, "canary sweep failed");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken)) return;
        }
    }

    public async Task SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();

        await HarvestAsync(scope.ServiceProvider, ct);
        await StartDueAsync(scope.ServiceProvider, ct);
    }

    /// <summary>
    /// Reads the verdict off every canary whose run has finished.
    /// </summary>
    /// <remarks>
    /// Harvest before start, so a canary that finished a moment ago is recorded
    /// - and its bundle rotated - before anything decides whether it is due
    /// again. The other order would start the next run from last run's bundle,
    /// which most providers have already invalidated.
    /// </remarks>
    private async Task HarvestAsync(IServiceProvider provider, CancellationToken ct)
    {
        var db = provider.GetRequiredService<ConnectorDbContext>();
        var canaries = provider.GetRequiredService<CanaryService>();

        var running = await db.Canaries
            .Where(c => c.LastJobId != null && c.LastIntact == null)
            .ToListAsync(ct);

        foreach (var canary in running)
        {
            await HarvestOneAsync(db, canaries, canary, ct);
        }
    }

    /// <summary>
    /// One canary's verdict, once its run has finished: recorded, logged, and
    /// the bundle the run handed back taken with it.
    /// </summary>
    private async Task HarvestOneAsync(ConnectorDbContext db, CanaryService canaries, CanaryRow canary, CancellationToken ct)
    {
        var job = await db.Jobs.AsNoTracking().FirstOrDefaultAsync(j => j.Id == canary.LastJobId, ct);

        if (job is null)
        {
            // Purged before it was read. Not a provider fault, and not a
            // verdict either - the canary simply runs again.
            await canaries.RecordAsync(
                canary.ProviderId, canary.LastJobId, intact: false,
                "the run disappeared before its outcome could be read", rotatedBundle: null, ct);

            return;
        }

        if (job.State is JobState.Queued or JobState.Leased or JobState.Running or JobState.AwaitingInput)
        {
            return;
        }

        var intact = job.State == JobState.Succeeded;

        // The bundle the run handed back. A session issues it once, so
        // reading it here also takes it - which is right: this is the
        // device it was issued to.
        var rotated = intact ? await TakeRotatedBundleAsync(db, job.SessionId, ct) : null;

        var verdict = intact
            ? Describe(job)
            : $"{ErrorCatalog.Wire(job.ErrorCode ?? ErrorCode.Internal)}: {job.ErrorDetail ?? "no detail"}";

        await canaries.RecordAsync(canary.ProviderId, job.Id, intact, verdict, rotated, ct);

        if (intact)
        {
            logger.LogInformation("canary for {Provider} is intact: {Verdict}", canary.ProviderId, verdict);
        }
        else
        {
            // Warning, not error: the provider's own health has already
            // been set by the job outcome, and this line is the operator's
            // pointer at which run to read.
            logger.LogWarning(
                "canary for {Provider} did NOT come back: {Verdict} (job {JobId})",
                canary.ProviderId, verdict, job.Id);
        }
    }

    private async Task<string?> TakeRotatedBundleAsync(ConnectorDbContext db, string sessionId, CancellationToken ct)
    {
        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);

        if (session?.PendingBundle is { Length: > 0 } issued)
        {
            session.PendingBundle = null;
            session.UpdatedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
            return issued;
        }

        return null;
    }

    /// <summary>
    /// What a successful run proves, in the terms an operator cares about.
    /// </summary>
    /// <remarks>
    /// A count and nothing else. The records themselves are the account
    /// holder's - even when the account holder is the operator - and a verdict
    /// line that quoted one would put a transaction in a table that exists to
    /// hold no data at all.
    /// </remarks>
    private static string Describe(JobRow job) =>
        $"read {job.ResourceId ?? "records"} and parsed what came back";

    private async Task StartDueAsync(IServiceProvider provider, CancellationToken ct)
    {
        var canaries = provider.GetRequiredService<CanaryService>();
        var due = await canaries.DueAsync(ct);

        if (due.Count == 0) return;

        var registry = provider.GetRequiredService<IProviderRegistry>();
        var sessions = provider.GetRequiredService<SessionService>();
        var queue = provider.GetRequiredService<ILeasedJobQueue>();
        var inline = provider.GetRequiredService<IInlineJobRunner>();

        foreach (var canary in due)
        {
            if (await HoldAsync(provider, canary, ct) is { } hold)
            {
                // A run still in flight is the ordinary case between two ticks
                // and not worth a line a minute; the other holds are.
                if (!hold.Quiet)
                {
                    logger.LogInformation("canary for {Provider} skipped: {Reason}", canary.ProviderId, hold.Reason);
                }

                continue;
            }

            await StartAsync(canary, registry.RequireManifest(canary.ProviderId), sessions, queue, inline, canaries, ct);
        }
    }

    /// <summary>
    /// The operator's "run it now" (#441 L1): the start the schedule would
    /// make, without waiting for the interval. The same holds apply - a run
    /// still in flight, a provider this build lacks, a provider somebody
    /// paused - and come back as refusals rather than silence, because a
    /// person is waiting for the answer.
    /// </summary>
    public async Task<CanaryView> RunNowAsync(string providerId, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var provider = scope.ServiceProvider;
        var db = provider.GetRequiredService<ConnectorDbContext>();

        var canary = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == providerId, ct)
                     ?? throw ConnectorException.Unsupported($"no canary for '{providerId}'");

        if (await HoldAsync(provider, canary, ct) is { } hold)
        {
            throw ConnectorException.InvalidRequest($"the canary for '{providerId}' cannot run now: {hold.Reason}");
        }

        await StartAsync(
            canary,
            provider.GetRequiredService<IProviderRegistry>().RequireManifest(canary.ProviderId),
            provider.GetRequiredService<SessionService>(),
            provider.GetRequiredService<ILeasedJobQueue>(),
            provider.GetRequiredService<IInlineJobRunner>(),
            provider.GetRequiredService<CanaryService>(),
            ct);

        return CanaryView.From(canary);
    }

    private sealed record Hold(string Reason, bool Quiet);

    /// <summary>
    /// Why a canary must not start right now, or null. Still in flight from an
    /// earlier tick - DueAsync goes by the clock alone, and a provider slower
    /// than its own interval would otherwise be given a second run every tick
    /// for ever; a provider this build does not have; a paused provider - an
    /// operator saying "stop", and a canary is work, so running one anyway
    /// would keep hitting a provider somebody has deliberately backed away
    /// from, which is the situation the kill switch exists for.
    /// </summary>
    private static async Task<Hold?> HoldAsync(IServiceProvider provider, CanaryRow canary, CancellationToken ct)
    {
        if (canary.LastJobId is { } previous && canary.LastIntact is null)
        {
            var db = provider.GetRequiredService<ConnectorDbContext>();
            var open = await db.Jobs.AsNoTracking().AnyAsync(
                j => j.Id == previous
                     && (j.State == JobState.Queued
                         || j.State == JobState.Leased
                         || j.State == JobState.Running
                         || j.State == JobState.AwaitingInput),
                ct);

            if (open) return new Hold("its last run is still in flight", Quiet: true);
        }

        if (!provider.GetRequiredService<IProviderRegistry>().TryGetManifest(canary.ProviderId, out _))
        {
            return new Hold("it names a provider this build does not have", Quiet: false);
        }

        var status = await provider.GetRequiredService<ProviderStatusService>().GetAsync(canary.ProviderId, ct);
        return status.AcceptsWork ? null : new Hold($"the provider is {status.State}", Quiet: false);
    }

    private async Task StartAsync(
        CanaryRow canary,
        ProviderManifest manifest,
        SessionService sessions,
        ILeasedJobQueue queue,
        IInlineJobRunner inline,
        CanaryService canaries,
        CancellationToken ct)
    {
        try
        {
            var opened = await sessions.OpenAsync(manifest.Id, canary.Subject, canary.Bundle, ct);

            var resource = manifest.Resource(canary.ResourceId)
                           ?? throw ConnectorException.Unsupported(
                               $"provider '{manifest.Id}' has no resource '{canary.ResourceId}'");

            var job = await queue.EnqueueAsync(new NewJob
            {
                SessionId = opened.Session.Id,
                ProviderId = manifest.Id,
                Kind = JobKind.Fetch,
                ResourceId = resource.Id,

                // The narrowest window the resource allows, because a canary is
                // asking "does this still work" and not "what happened this
                // year". A full history every fifteen minutes is a way to get
                // the operator's own account blocked.
                Request = Probe(resource),
                Config = opened.Payload.Config,
                Material = opened.Payload.Material,
                ProfileId = opened.Session.ProfileId,
                // Whatever the connection this canary borrows was told to run
                // on, both ways round. A probe that routed differently from
                // the fetches it is a canary FOR would be measuring a machine
                // nobody's real work goes to.
                FleetOnly = opened.Session.FleetOnly,
                // The operator's own run: its failure pictures are retained
                // without asking, and health counts it apart from people's.
                Trigger = JobRow.CanaryTrigger,
            }, ct);

            canary.LastJobId = job.Id;
            canary.LastIntact = null;
            canary.LastRunAt = time.GetUtcNow();
            canary.LastVerdict = null;

            await canaries.RecordStartedAsync(canary, ct);

            if (inline.CanRun(manifest)) inline.Dispatch();

            logger.LogInformation(
                "canary for {Provider} started against {Resource} (job {JobId})",
                manifest.Id, resource.Id, job.Id);
        }
        catch (ConnectorException ex)
        {
            // A BUNDLE THAT WILL NOT OPEN IS A VERDICT, not a crash. It is also
            // the most likely way a canary dies - an operator's account gets
            // signed out, or the provider expires the session - and it must be
            // told apart from the provider having changed, which is why it is
            // recorded here rather than raised.
            await canaries.RecordAsync(
                canary.ProviderId, jobId: null, intact: false,
                $"could not start: {ErrorCatalog.Wire(ex.Code)}: {ex.Message}", rotatedBundle: null, ct);

            logger.LogWarning(
                ex,
                "canary for {Provider} could not start ({Code}); re-enrol it with a fresh bundle",
                canary.ProviderId, ErrorCatalog.Wire(ex.Code));
        }
    }

    /// <summary>
    /// The smallest ask that still proves the parser works.
    /// </summary>
    /// <remarks>
    /// Yesterday onwards, and no raw payload. A canary is a liveness check on
    /// the whole path - session opens, provider answers, reader parses - and
    /// none of that needs volume. Asking for a year would make each run
    /// expensive, slow, and far more conspicuous to the provider than a person
    /// checking their account.
    /// </remarks>
    private ResourceRequest Probe(ResourceSpec resource) => new()
    {
        ResourceId = resource.Id,
        Since = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime).AddDays(-1),
    };
}
