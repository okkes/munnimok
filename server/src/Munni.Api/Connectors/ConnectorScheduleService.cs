using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

// hourly; syncs every session whose bundle the relay keeps (a household agent's pointer, an open-banking consent)
// on the provider's own interval (docs/connectors/relay.md)
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
    private const string BackfillTrigger = "backfill";
    private const string DayFormat = "yyyy-MM-dd";

    private sealed record Pass(string? Since, string? Until, string Trigger);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        await Task.Delay(TimeSpan.FromMinutes(2), stoppingToken);
        do
        {
            await CycleAsync(stoppingToken);
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    internal async Task CycleAsync(CancellationToken stoppingToken)
    {
        try
        {
            await RunOnceAsync(stoppingToken);
            _unreachableCycles = 0;
        }
        // a call that timed out is an OperationCanceledException too, and one that leaves this loop stops the whole api:
        // only the host's own stop may
        catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
        {
            NoteCycleFailure(ex);
        }
    }

    // one or two unreachable cycles are normal on a deploy or router swap (GlitchTip 17-19, 2026-10-05): a warning.
    // only UnreachableCyclesBeforeError in a row raises the error that pages
    private int _unreachableCycles;

    internal const int UnreachableCyclesBeforeError = 3;

    internal static bool IsTransport(Exception ex) =>
        ex is HttpRequestException or System.Net.Sockets.SocketException or TaskCanceledException or TimeoutException
        || (ex is ConnectorReplyException reply && (int)reply.Reply.Status is 502 or 503 or 504);

    internal void NoteCycleFailure(Exception ex)
    {
        if (!IsTransport(ex))
        {
            logger.LogError(ex, "connector schedule cycle failed");
            return;
        }
        _unreachableCycles++;
        if (_unreachableCycles == UnreachableCyclesBeforeError)
        {
            logger.LogError(ex, "the connector control plane has been unreachable for {Cycles} schedule cycles", _unreachableCycles);
        }
        else
        {
            logger.LogWarning("connector schedule cycle skipped: the control plane could not be reached ({Reason}) — cycle {Cycle} of {Limit} before this is an incident", ex.Message, _unreachableCycles, UnreachableCyclesBeforeError);
        }
    }

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

    // a session that never ran is due at once; catch-up: a restart in the preferred hour used to cost a whole night
    // (prod 2026-10-08), so a later hour of a day not yet run also counts, and the interval keeps it to one run
    internal bool IsDue(ConnectorSession row, JsonObject manifest, TimeZoneInfo? zone = null)
    {
        if (manifest["unattended_fetch"]?.GetValue<bool>() != true) return false;
        var now = time.GetUtcNow();
        if (row.ScheduleNotBefore is { } notBefore && now < notBefore) return false;
        if (row.LastScheduledSyncAt is not { } last) return true;
        var limits = manifest["limits"] as JsonObject;
        var interval = limits?["min_interval_seconds"]?.GetValue<int>() ?? 0;
        if (now - last < TimeSpan.FromSeconds(interval)) return false;
        var hour = limits?["preferred_fetch_hour_local"]?.GetValue<int>();
        if (hour is null) return true;
        var local = TimeZoneInfo.ConvertTime(now, zone ?? TimeZoneInfo.Utc);
        if (local.Hour == hour) return true;
        return local.Hour > hour && TimeZoneInfo.ConvertTime(last, zone ?? TimeZoneInfo.Utc).Date != local.Date;
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
            var pass = new Pass(since, null, ScheduleTrigger);
            var end = await PassAsync(sync, row, subject, pass, ct);
            if (end.Finished is { } finished)
            {
                row.LastScheduleError = null;
                row.PendingArtifactsJobId = null;
                NoteBackfill(row, pass.Since, pass.Until, finished);
            }
            else if (end.Asked)
            {
                row.State = "awaiting_input";
                row.LastScheduleError = null;
                row.PendingArtifactsJobId = null;
            }
            else if (end.TimedOut)
            {
                // the person will find it in the hub; the connector expires it by itself
                row.LastScheduleError = "mfa_timeout";
            }
            else if (end.Code is { } code)
            {
                // the picture a failed run left behind waits on the person: the hub asks (#441 L1)
                if (end.JobFailed) row.PendingArtifactsJobId = end.ArtifactsJobId;
                Refused(row, code, end.RetryAfter);
            }
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogError(ex, "scheduled connector sync of {Provider} failed", row.Provider);
            row.LastScheduleError = InternalCode;
        }

        // one pass over older history per run, after a run that went through (#460)
        if (row is { BackfillUntil: not null, State: "active", KeptBundle: not null, LastScheduleError: null })
        {
            await BackfillAsync(sync, row, subject, ct);
        }
        await relay.Db.SaveChangesAsync(ct);
    }

    private sealed record PassEnd(
        JsonObject? Finished = null,
        bool Asked = false,
        bool TimedOut = false,
        string? Code = null,
        int? RetryAfter = null,
        bool JobFailed = false,
        string? ArtifactsJobId = null);

    private async Task<PassEnd> PassAsync(ConnectorSyncService sync, ConnectorSession row, string subject, Pass pass, CancellationToken ct)
    {
        try
        {
            var request = new ConnectorSyncRequest(row.ConnectionId, row.KeptBundle!, pass.Since, pass.Until);
            var outcome = await sync.SyncAsync(row.UserId, subject, row.Provider, request, "native", ct, trigger: pass.Trigger);
            if (outcome.Status == StatusCodes.Status202Accepted) return await FollowJobAsync(sync, row, subject, outcome.Body, pass, ct);
            return outcome.Status >= 400
                ? new PassEnd(Code: CodeOf(outcome.Body) ?? InternalCode, RetryAfter: RetryAfterOf(outcome.Body))
                : new PassEnd(outcome.Body);
        }
        catch (ConnectorReplyException ex)
        {
            return new PassEnd(Code: ex.Reply.Error?.Code ?? InternalCode, RetryAfter: ex.Reply.Error?.RetryAfterSeconds);
        }
    }

    private async Task<PassEnd> FollowJobAsync(ConnectorSyncService sync, ConnectorSession row, string subject, JsonObject accepted, Pass pass, CancellationToken ct)
    {
        var jobId = accepted["jobId"]?.GetValue<string>();
        if (jobId is null) return new PassEnd();
        var deadline = time.GetUtcNow() + JobPatience;
        while (time.GetUtcNow() < deadline)
        {
            var job = await sync.JobAsync(row.UserId, subject, row.Provider, jobId, ct);
            var state = job.Body["state"]?.GetValue<string>();
            switch (state)
            {
                case "succeeded":
                {
                    var call = new ConnectorCollectCall(new ConnectorCollectRequest(row.KeptBundle!, pass.Since, pass.Until), pass.Trigger);
                    var collected = await sync.CollectAsync(row.UserId, subject, row.Provider, jobId, call, ct);
                    if (collected.Status == StatusCodes.Status202Accepted && collected.Body["jobId"]?.GetValue<string>() is { } next)
                    {
                        jobId = next;
                        break;
                    }
                    return collected.Status >= 400
                        ? new PassEnd(Code: CodeOf(collected.Body) ?? InternalCode, RetryAfter: RetryAfterOf(collected.Body))
                        : new PassEnd(collected.Body);
                }
                case "awaiting_input":
                    return new PassEnd(Asked: true);
                case "failed" or "expired":
                    return new PassEnd(
                        Code: CodeOf(job.Body) ?? (state == "expired" ? "challenge_expired" : InternalCode),
                        RetryAfter: RetryAfterOf(job.Body),
                        JobFailed: true,
                        ArtifactsJobId: job.Body["artifactsJobId"]?.GetValue<string>());
                default:
                    await Task.Delay(JobPoll, ct);
                    break;
            }
        }
        return new PassEnd(TimedOut: true);
    }

    // declared to the connector as backfill: it holds it to the party's interval on its own clock; a refusal leaves it
    // for the next run, only one the person must act on touches the session
    private async Task BackfillAsync(ConnectorSyncService sync, ConnectorSession row, string subject, CancellationToken ct)
    {
        var pass = new Pass(
            row.BackfillSince?.ToString(DayFormat, CultureInfo.InvariantCulture),
            row.BackfillUntil!.Value.ToString(DayFormat, CultureInfo.InvariantCulture),
            BackfillTrigger);
        PassEnd end;
        try
        {
            end = await PassAsync(sync, row, subject, pass, ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "backfill pass of {Provider} failed; it is asked again on the next scheduled run", row.Provider);
            return;
        }

        if (end.Finished is { } finished)
        {
            NoteBackfill(row, pass.Since, pass.Until, finished);
            return;
        }
        if (end.Asked)
        {
            row.State = "awaiting_input";
            return;
        }
        if (end.JobFailed) row.PendingArtifactsJobId = end.ArtifactsJobId;
        if (end.Code is { } code && (SignInCodes.Contains(code) || code == "blocked_by_provider"))
        {
            Refused(row, code, end.RetryAfter);
        }
        else if (end.Code is { } other && other != RateLimitedCode && logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning("backfill pass of {Provider} ended on {Code}; it is asked again on the next scheduled run", row.Provider, other);
        }
    }

    // the same rule as the app's connectorSync.nextBackfill (#460); the frontier day is asked again: a pass's cap can
    // cut a day in half and the ingest absorbs the overlap
    internal static void NoteBackfill(ConnectorSession row, string? since, string? until, JsonObject finished)
    {
        var partial = finished["complete"]?.GetValue<bool>() == false;
        if (!partial || Day(finished["oldest"]?.GetValue<string>()) is not { } oldest)
        {
            if (until is not null) Clear(row);
            return;
        }

        // the party widens a since by its settlement lag, so a pass can bring days below it: never ask from above them
        var from = Day(since) is { } stated && stated > oldest ? oldest : Day(since);
        if (until is not null)
        {
            if (oldest < Day(until))
            {
                row.BackfillSince = from;
                row.BackfillUntil = oldest;
            }
            else
            {
                Clear(row);
            }
            return;
        }

        row.BackfillSince = row.BackfillUntil is null ? from : Earliest(from, row.BackfillSince);
        row.BackfillUntil = row.BackfillUntil is { } pending && pending > oldest ? pending : oldest;
    }

    private static void Clear(ConnectorSession row)
    {
        row.BackfillUntil = null;
        row.BackfillSince = null;
    }

    private static DateOnly? Day(string? text) =>
        DateOnly.TryParseExact(text, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;

    /// <summary>The earlier of two lower bounds, where null is the party's floor and so the earliest of all.</summary>
    private static DateOnly? Earliest(DateOnly? a, DateOnly? b)
    {
        if (a is not { } first || b is not { } second) return null;
        return first < second ? first : second;
    }

    private static string? CodeOf(JsonObject body) => body["error"]?["code"]?.GetValue<string>();

    private static int? RetryAfterOf(JsonObject body) =>
        body["error"]?["retryAfterSeconds"] is JsonValue value && value.TryGetValue<int>(out var seconds) ? seconds : null;

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
