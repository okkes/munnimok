using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Providers;

/// min_interval_seconds, enforced for schedules only: a person pressing a button is paced by the agent's request gaps
/// the clock is the last succeeded job of that kind for the same subject and provider, across sessions and devices
public sealed class SyncInterval(ConnectorDbContext db, TimeProvider time)
{
    public async Task RequireElapsedAsync(
        FetchTrigger trigger,
        ProviderManifest manifest,
        string subject,
        JobKind kind,
        string? resourceId,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        if (trigger is not (FetchTrigger.Schedule or FetchTrigger.Backfill)) return;

        var interval = manifest.Limits.MinIntervalSeconds;
        if (interval <= 0) return;

        var now = time.GetUtcNow();
        var since = now.AddSeconds(-interval);

        // between SCHEDULED jobs only: attended syncs are not the party's unattended quota (four a day under PSD2); counting them
        // made the nightly schedule rate_limited, which the hub read as "the party asked for a pause" (prod)
        // a backfill (#460) has its own clock, so the schedule's pass and one older-history pass fit each interval
        var counted = trigger == FetchTrigger.Backfill ? JobRow.BackfillTrigger : JobRow.ScheduleTrigger;
        var last = await db.Jobs
            .Where(j => j.ProviderId == manifest.Id && j.Kind == kind && j.State == JobState.Succeeded && j.UpdatedAt > since)
            .Where(j => j.Trigger == counted)
            .Where(j => resourceId == null || j.ResourceId == resourceId)
            .Join(db.Sessions.Where(s => s.Subject == subject), j => j.SessionId, s => s.Id, (j, _) => (DateTimeOffset?)j.UpdatedAt)
            .MaxAsync(ct);

        if (last is null) return;

        var retryAfter = (int)Math.Ceiling((last.Value.AddSeconds(interval) - now).TotalSeconds);

        throw new ConnectorException(
            ErrorCode.RateLimited,
            $"a {counted} {kind} for provider '{manifest.Id}' ran {(int)(now - last.Value).TotalSeconds}s ago; " +
            $"the provider asks for {interval}s between syncs")
        {
            RetryAfterSeconds = Math.Max(1, retryAfter),
        };
    }
}
