using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

/// <summary>
/// Unattended syncs for the sessions whose bundle the relay may keep — the
/// household-agent custody of docs/connector-integration-plan.md §5.5: the
/// bundle names an agent and a profile and holds no secret, the agent on
/// the person's own machine does the fetching, and the relay drives it the
/// way <see cref="GoCardless.GcFetchService"/> drives open banking — an
/// hourly tick, the provider's own interval respected, a run that stops for
/// a question left for the person (the hub shows it). Everything else
/// (client custody) syncs only when the person's device holds the bundle.
/// </summary>
public sealed class ConnectorScheduleService(IServiceScopeFactory scopeFactory, TimeProvider time, ILogger<ConnectorScheduleService> logger) : BackgroundService
{
    /// <summary>How long a scheduled run follows a fetch that became a job before leaving it to the person.</summary>
    internal TimeSpan JobPatience { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>The wait between two looks at a job in flight.</summary>
    internal TimeSpan JobPoll { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>A refusal that says the session is gone: the person signs in again.</summary>
    private static readonly HashSet<string> SignInCodes = new(StringComparer.Ordinal)
    {
        "session_expired", "invalid_credentials", "mfa_failed", "consent_expired", "unsupported_resource", "agent_revoked",
    };

    /// <summary>The connector's code for a failure it did not name — ours too, for a run that threw.</summary>
    private const string InternalCode = "internal";

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

    /// <summary>One cycle over every kept session; answers how many syncs it ran (tests drive this directly).</summary>
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
            if (manifest is null || !IsDue(row, manifest)) continue;
            ran++;
            await RunAsync(relay, sync, row, ct);
        }
        return ran;
    }

    /// <summary>The provider fetches unattended, and its own interval has passed since the last scheduled run.</summary>
    internal bool IsDue(ConnectorSession row, JsonObject manifest)
    {
        if (manifest["unattended_fetch"]?.GetValue<bool>() != true) return false;
        var interval = (manifest["limits"] as JsonObject)?["min_interval_seconds"]?.GetValue<int>() ?? 0;
        return row.LastScheduledSyncAt is null || time.GetUtcNow() - row.LastScheduledSyncAt.Value >= TimeSpan.FromSeconds(interval);
    }

    private async Task RunAsync(ConnectorRelay relay, ConnectorSyncService sync, ConnectorSession row, CancellationToken ct)
    {
        var subject = relay.Minter.For(row.UserId);
        var since = row.LastScheduledSyncAt is { } last
            ? DateOnly.FromDateTime(last.UtcDateTime).AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;
        row.LastScheduledSyncAt = time.GetUtcNow();
        try
        {
            var outcome = await sync.SyncAsync(row.UserId, subject, row.Provider, new ConnectorSyncRequest(row.ConnectionId, row.KeptBundle!, since), "native", ct, trigger: "schedule");
            if (outcome.Status == StatusCodes.Status202Accepted)
            {
                await FollowJobAsync(sync, row, subject, outcome.Body, ct);
            }
            else if (outcome.Status >= 400)
            {
                Refused(row, outcome.Body["error"]?["code"]?.GetValue<string>() ?? InternalCode);
            }
            else
            {
                row.LastScheduleError = null;
            }
        }
        catch (ConnectorReplyException ex)
        {
            Refused(row, ex.Reply.Error?.Code ?? InternalCode);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "scheduled connector sync of {Provider} failed", row.Provider);
            row.LastScheduleError = InternalCode;
        }
        await relay.Db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// A fetch that became a job: wait for it within patience, collect it
    /// when it succeeded, leave it to the person when it asks — the session
    /// reads <c>awaiting_input</c> in the hub until they answer.
    /// </summary>
    private async Task FollowJobAsync(ConnectorSyncService sync, ConnectorSession row, string subject, JsonObject accepted, CancellationToken ct)
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
                    var collected = await sync.CollectAsync(row.UserId, subject, row.Provider, jobId, new ConnectorCollectRequest(row.KeptBundle!), ct);
                    if (collected.Status >= 400) Refused(row, collected.Body["error"]?["code"]?.GetValue<string>() ?? InternalCode);
                    else row.LastScheduleError = null;
                    return;
                }
                case "awaiting_input":
                    row.State = "awaiting_input";
                    row.LastScheduleError = null;
                    return;
                case "failed" or "expired":
                    Refused(row, job.Body["error"]?["code"]?.GetValue<string>() ?? (state == "expired" ? "challenge_expired" : InternalCode));
                    return;
                default:
                    await Task.Delay(JobPoll, ct);
                    break;
            }
        }
        // the person will find it in the hub; the connector expires it by itself
        row.LastScheduleError = "mfa_timeout";
    }

    /// <summary>A refusal the person has to act on drops the kept bundle; every other one is remembered and retried next tick.</summary>
    private static void Refused(ConnectorSession row, string code)
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
    }
}
