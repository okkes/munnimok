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

// two phases, so a stuck provider cannot stall other canaries: one starts what is due, the other reads what finished
// health is not decided here: the ordinary pipeline (JobOutcomeService) degrades and recovers as for a user
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
            // a timed-out call is an OperationCanceledException too: only the host's own stop ends the sweeps
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
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

    // harvest before start: a canary that just finished is recorded and its bundle rotated before it is due again,
    // else it would start from an invalidated bundle
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

    private async Task HarvestOneAsync(ConnectorDbContext db, CanaryService canaries, CanaryRow canary, CancellationToken ct)
    {
        var job = await db.Jobs.AsNoTracking().FirstOrDefaultAsync(j => j.Id == canary.LastJobId, ct);

        if (job is null)
        {
            // purged before it was read: not a provider fault nor a verdict; the canary simply runs again
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

        // a session issues its bundle once, so reading it here takes it: this is the device it was issued to
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
            // warning, not error: the job outcome already set the provider's health; this line points at which run to read
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

    // a count only: the records are the account holder's, and the verdict table must hold no data
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
                // a run in flight is the ordinary case between ticks, not worth a line a minute
                if (!hold.Quiet)
                {
                    logger.LogInformation("canary for {Provider} skipped: {Reason}", canary.ProviderId, hold.Reason);
                }

                continue;
            }

            await StartAsync(canary, registry.RequireManifest(canary.ProviderId), sessions, queue, inline, canaries, ct);
        }
    }

    // the operator's "run it now" (#441 L1): same holds as the schedule, but refusals rather than silence
    // because a person is waiting
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

    // holds: DueAsync goes by the clock alone, so a slow provider needs the in-flight hold.
    // a paused provider is the kill switch, and a canary is work
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

                // narrowest window: a canary asks "does this still work"; a full history every fifteen minutes
                // would get the operator's account blocked
                Request = Probe(resource),
                Config = opened.Payload.Config,
                Material = opened.Payload.Material,
                ProfileId = opened.Session.ProfileId,
                // same fleet/own routing as the borrowed connection: a probe routed differently would measure a machine nobody uses
                FleetOnly = opened.Session.FleetOnly,
                // the operator's run: failure pictures retained without asking, and health counts it apart from people's
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
            // a bundle that will not open is a verdict, not a crash: the likeliest way a canary dies,
            // to be told apart from provider_changed
            await canaries.RecordAsync(
                canary.ProviderId, jobId: null, intact: false,
                $"could not start: {ErrorCatalog.Wire(ex.Code)}: {ex.Message}", rotatedBundle: null, ct);

            logger.LogWarning(
                ex,
                "canary for {Provider} could not start ({Code}); re-enrol it with a fresh bundle",
                canary.ProviderId, ErrorCatalog.Wire(ex.Code));
        }
    }

    // yesterday onwards, no raw payload: a canary is a liveness check; a year would be slow and conspicuous to the provider
    private ResourceRequest Probe(ResourceSpec resource) => new()
    {
        ResourceId = resource.Id,
        Since = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime).AddDays(-1),
    };
}
