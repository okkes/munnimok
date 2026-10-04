using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Providers;

/// <summary>
/// The provider's <c>min_interval_seconds</c>, enforced - for schedules.
///
/// A manifest says how often a consumer should sync, and for years nothing
/// read it back. Enforcing it blindly would have refused the operator who
/// ran six fetches in three hours diagnosing a defect, so the caller now says
/// who it is: a person who pressed a button is paced by the agent's request
/// gaps and nothing else, while a schedule that comes back inside the
/// interval is answered <c>rate_limited</c> with the seconds left, which is
/// exactly what a scheduler wants to hear.
///
/// The clock is the last job of that kind that succeeded for the same
/// subject at the same provider, across sessions - a reconnect does not reset
/// the interval, and neither does a second device.
/// </summary>
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

        if (trigger != FetchTrigger.Schedule) return;

        var interval = manifest.Limits.MinIntervalSeconds;
        if (interval <= 0) return;

        var now = time.GetUtcNow();
        var since = now.AddSeconds(-interval);

        // Between SCHEDULED jobs only. A person pressing Sync now, or the app
        // syncing on open, is attended traffic the party's unattended quota
        // (four a day under PSD2) does not count - and counting it here made the
        // app's own syncs refuse the nightly scheduled one as rate_limited,
        // which the hub then read as "the party asked for a pause" (prod,
        // 2026-10-04).
        var last = await db.Jobs
            .Where(j => j.ProviderId == manifest.Id && j.Kind == kind && j.State == JobState.Succeeded && j.UpdatedAt > since)
            .Where(j => j.Trigger == JobRow.ScheduleTrigger)
            .Where(j => resourceId == null || j.ResourceId == resourceId)
            .Join(db.Sessions.Where(s => s.Subject == subject), j => j.SessionId, s => s.Id, (j, _) => (DateTimeOffset?)j.UpdatedAt)
            .MaxAsync(ct);

        if (last is null) return;

        var retryAfter = (int)Math.Ceiling((last.Value.AddSeconds(interval) - now).TotalSeconds);

        throw new ConnectorException(
            ErrorCode.RateLimited,
            $"a scheduled {kind} for provider '{manifest.Id}' ran {(int)(now - last.Value).TotalSeconds}s ago; " +
            $"the provider asks for {interval}s between syncs")
        {
            RetryAfterSeconds = Math.Max(1, retryAfter),
        };
    }
}
