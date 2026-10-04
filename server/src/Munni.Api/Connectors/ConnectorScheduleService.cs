using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

/// <summary>
/// The relay's own scheduler (docs/connector-integration-plan.md §5.5, §15):
/// syncs every session whose bundle the relay keeps — a household agent's
/// pointer, an open-banking consent — on the provider's own interval, the
/// way <c>GcFetchService</c> drove open banking. Hourly; each session is
/// due when <c>unattended_fetch</c> is on, its <c>min_interval_seconds</c>
/// have passed, any <c>retry_after</c> a rate-limited refusal set has
/// passed, and — when the party names a <c>preferred_fetch_hour_local</c>
/// — it is that hour in the bank's zone (from the IBAN's country). A fetch
/// that became a job is followed for ten minutes and collected; a question
/// is left to the person; a refusal that needs a sign-in drops the kept
/// bundle, every other one is remembered and retried next time.
/// </summary>
public sealed class ConnectorScheduleService(IServiceScopeFactory scopeFactory, TimeProvider time, ILogger<ConnectorScheduleService> logger) : BackgroundService
{
    internal TimeSpan JobPatience { get; set; } = TimeSpan.FromMinutes(10);

    internal TimeSpan JobPoll { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>A rate-limited refusal without a retry-after: the party's day, as the api's fetch service stood down.</summary>
    internal static readonly TimeSpan RateLimitStandDown = TimeSpan.FromHours(12);

    private static readonly HashSet<string> SignInCodes = new(StringComparer.Ordinal)
    {
        "session_expired", "invalid_credentials", "mfa_failed", "consent_expired", "unsupported_resource", "agent_revoked",
    };

    private const string InternalCode = "internal";
    private const string RateLimitedCode = "rate_limited";
    private const string ScheduleTrigger = "schedule";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        await Task.Delay(TimeSpan.FromMinutes(2), stoppingToken);
        do
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "connector schedule cycle failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>One cycle: every kept, active session that is due; returns how many ran.</summary>
    internal async Task<int> RunOnceAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var relay = scope.ServiceProvider.GetRequiredService<ConnectorRelay>();
        var sync = scope.ServiceProvider.GetRequiredService<ConnectorSyncService>();
        var due = await relay.Db.ConnectorSessions
            .Where(s => s.KeptBundle != null && s.State == "active")
            .OrderBy(s => s.LastScheduledSyncAt)
            .ToListAsync(ct);
        var ran = 0;
        foreach (var row in due)
        {
            var manifest = await relay.Catalogue.ProviderAsync(relay.Client, row.Provider, ct);
            if (manifest is null || !IsDue(row, manifest, await ZoneOfAsync(relay.Db, row, manifest, ct))) continue;
            ran++;
            await RunAsync(relay, sync, row, ct);
        }
        return ran;
    }

    /// <summary>
    /// Due when the party fetches unattended, no retry-after stands, the
    /// party's interval has passed, and — when the party prefers an hour —
    /// it is that hour in <paramref name="zone"/>. A session that never ran
    /// is due at once: the connect's own fetch was the person's, not the
    /// schedule's.
    /// </summary>
    internal bool IsDue(ConnectorSession row, JsonObject manifest, TimeZoneInfo? zone = null)
    {
        if (manifest["unattended_fetch"]?.GetValue<bool>() != true) return false;
        var now = time.GetUtcNow();
        if (row.ScheduleNotBefore is { } notBefore && now < notBefore) return false;
        if (row.LastScheduledSyncAt is null) return true;
        var limits = manifest["limits"] as JsonObject;
        var interval = limits?["min_interval_seconds"]?.GetValue<int>() ?? 0;
        if (now - row.LastScheduledSyncAt.Value < TimeSpan.FromSeconds(interval)) return false;
        var hour = limits?["preferred_fetch_hour_local"]?.GetValue<int>();
        return hour is null || TimeZoneInfo.ConvertTime(now, zone ?? TimeZoneInfo.Utc).Hour == hour;
    }

    /// <summary>The bank's zone: the first IBAN the connection reaches, else the party's home country.</summary>
    internal static async Task<TimeZoneInfo> ZoneOfAsync(AppDbContext db, ConnectorSession row, JsonObject manifest, CancellationToken ct)
    {
        var iban = await db.ConnectorAccountRefs
            .Where(a => a.UserId == row.UserId && a.Provider == row.Provider && a.ConnectionId == row.ConnectionId && !a.AccountRef.StartsWith("CONN:"))
            .OrderBy(a => a.AccountRef)
            .Select(a => a.AccountRef)
            .FirstOrDefaultAsync(ct);
        return BankZones.ZoneFor(iban ?? manifest.Text("country"));
    }

    private async Task RunAsync(ConnectorRelay relay, ConnectorSyncService sync, ConnectorSession row, CancellationToken ct)
    {
        var subject = relay.Minter.For(row.UserId);
        var since = row.LastScheduledSyncAt is { } last
            ? DateOnly.FromDateTime(last.UtcDateTime).AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;
        row.LastScheduledSyncAt = time.GetUtcNow();
        row.ScheduleNotBefore = null;
        try
        {
            var outcome = await sync.SyncAsync(row.UserId, subject, row.Provider, new ConnectorSyncRequest(row.ConnectionId, row.KeptBundle!, since), "native", ct, trigger: ScheduleTrigger);
            if (outcome.Status == StatusCodes.Status202Accepted)
            {
                await FollowJobAsync(sync, row, subject, outcome.Body, since, ct);
            }
            else if (outcome.Status >= 400)
            {
                Refused(row, CodeOf(outcome.Body) ?? InternalCode, RetryAfterOf(outcome.Body));
            }
            else
            {
                row.LastScheduleError = null;
            }
        }
        catch (ConnectorReplyException ex)
        {
            Refused(row, ex.Reply.Error?.Code ?? InternalCode, ex.Reply.Error?.RetryAfterSeconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "scheduled connector sync of {Provider} failed", row.Provider);
            row.LastScheduleError = InternalCode;
        }
        await relay.Db.SaveChangesAsync(ct);
    }

    private async Task FollowJobAsync(ConnectorSyncService sync, ConnectorSession row, string subject, JsonObject accepted, string? since, CancellationToken ct)
    {
        var jobId = accepted["jobId"]?.GetValue<string>();
        if (jobId is null) return;
        var deadline = time.GetUtcNow() + JobPatience;
        while (time.GetUtcNow() < deadline)
        {
            var job = await sync.JobAsync(row.UserId, subject, row.Provider, jobId, ct);
            var state = job.Body["state"]?.GetValue<string>();
            switch (state)
            {
                case "succeeded":
                {
                    var collected = await sync.CollectAsync(row.UserId, subject, row.Provider, jobId, new ConnectorCollectRequest(row.KeptBundle!, since), ct, trigger: ScheduleTrigger);
                    if (collected.Status == StatusCodes.Status202Accepted && collected.Body["jobId"]?.GetValue<string>() is { } next)
                    {
                        // the walk went on and the next pass became a job of its own: follow that one
                        jobId = next;
                        break;
                    }
                    if (collected.Status >= 400) Refused(row, CodeOf(collected.Body) ?? InternalCode, RetryAfterOf(collected.Body));
                    else row.LastScheduleError = null;
                    return;
                }
                case "awaiting_input":
                    // the person will find the question in the hub
                    row.State = "awaiting_input";
                    row.LastScheduleError = null;
                    return;
                case "failed" or "expired":
                    Refused(row, CodeOf(job.Body) ?? (state == "expired" ? "challenge_expired" : InternalCode), RetryAfterOf(job.Body));
                    return;
                default:
                    await Task.Delay(JobPoll, ct);
                    break;
            }
        }
        // the person will find it in the hub; the connector expires it by itself
        row.LastScheduleError = "mfa_timeout";
    }

    private static string? CodeOf(JsonObject body) => body["error"]?["code"]?.GetValue<string>();

    private static int? RetryAfterOf(JsonObject body) =>
        body["error"]?["retryAfterSeconds"] is JsonValue value && value.TryGetValue<int>(out var seconds) ? seconds : null;

    /// <summary>
    /// A refusal that needs the person (a sign-in, an expired consent) drops
    /// the kept bundle and asks for one; a block stops the session; the
    /// party's budget (<c>rate_limited</c>) sets when to try again; every
    /// other code is remembered and retried on the next cycle.
    /// </summary>
    internal void Refused(ConnectorSession row, string code, int? retryAfterSeconds)
    {
        row.LastScheduleError = code;
        if (SignInCodes.Contains(code))
        {
            row.State = "needs_reauth";
            row.KeptBundle = null;
        }
        else if (code == "blocked_by_provider")
        {
            row.State = "blocked";
        }
        else if (code == RateLimitedCode)
        {
            row.ScheduleNotBefore = time.GetUtcNow() + (retryAfterSeconds is { } seconds ? TimeSpan.FromSeconds(seconds) : RateLimitStandDown);
        }
    }
}
