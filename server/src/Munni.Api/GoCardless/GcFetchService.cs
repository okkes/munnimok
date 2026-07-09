using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.GoCardless;

/// <summary>
/// Scheduled transaction fetch: once a night per account, in the 03:00
/// hour at the bank's local time (GcSchedule) — one call per endpoint
/// per day, far inside GoCardless's ~4/day budget. Freshly linked
/// accounts fetch on the next hourly tick instead of waiting for night.
/// There is no on-demand refresh; 429s defer the account.
/// </summary>
public sealed class GcFetchService(IServiceScopeFactory scopeFactory, ILogger<GcFetchService> logger) : BackgroundService
{
    // 429'd accounts wait out the rest of the day instead of burning the
    // remaining daily quota on retries (per-process is enough: a restart
    // retries once, then defers again)
    private readonly Dictionary<string, DateTimeOffset> _rateLimitedUntil = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // hourly ticks; GcSchedule decides which accounts are due (the
        // 03:00 bank-local window, or a brand-new link)
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        do
        {
            try
            {
                await FetchAllAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "gocardless fetch cycle failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>seconds between account fetches (staggering); tests shrink it</summary>
    internal TimeSpan AccountDelay { get; set; } = TimeSpan.FromSeconds(5);

    internal async Task FetchAllAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var gc = scope.ServiceProvider.GetRequiredService<IGoCardlessApi>();

        var linkedAccounts = await db.GcLinkedAccounts.ToListAsync(ct);
        foreach (var linked in linkedAccounts)
        {
            if (!GcSchedule.IsDue(linked.Iban, linked.LastFetchAt, DateTimeOffset.UtcNow)) continue;
            if (_rateLimitedUntil.TryGetValue(linked.GcAccountId, out var until) && DateTimeOffset.UtcNow < until) continue;
            try
            {
                await FetchAccountAsync(scope.ServiceProvider, db, gc, linked, ct);
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                // the ~4-calls-per-endpoint daily budget is spent — stand
                // down for 12h instead of hammering the remaining calls
                _rateLimitedUntil[linked.GcAccountId] = DateTimeOffset.UtcNow.AddHours(12);
                if (logger.IsEnabled(LogLevel.Information))
                    logger.LogInformation(ex, "gc rate limit for {Iban} — deferring 12h", linked.Iban);
            }
            catch (HttpRequestException ex)
            {
                // expired consent or other 4xx/5xx — wait for the next cycle
                logger.LogWarning(ex, "gc fetch failed for {Iban}", linked.Iban);
            }
        }
    }

    private async Task FetchAccountAsync(IServiceProvider services, AppDbContext db, IGoCardlessApi gc, GcLinkedAccount linked, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([linked.SpaceId], ct);
        if (space is null) return;

        // banks budget ~4 calls per endpoint per day — the account details
        // never change after linking, so only the very first fetch spends a
        // call on them
        var details = linked.LastFetchAt is null
            ? await gc.GetAccountDetailsAsync(linked.GcAccountId, ct)
            : new GcAccountDetails(linked.Iban, null, linked.Currency);
        var balances = await gc.GetBalancesAsync(linked.GcAccountId, ct);
        var from = DateOnly.FromDateTime((linked.LastFetchAt?.UtcDateTime ?? DateTime.UtcNow.AddDays(-90)).AddDays(-3));
        var transactions = await gc.GetTransactionsAsync(linked.GcAccountId, from, ct);

        var accepted = await new GcIngest(db).IngestAccountAsync(space, linked, details, balances, transactions);
        linked.LastFetchAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
            logger.LogInformation("gc fetch {Iban}: {Accepted} new ops", linked.Iban, accepted);

        // wake the members' devices: SSE for open apps, push notification +
        // preload for closed ones. Raw rows land in the FEED space; the
        // overlay lands in the target space — publish both so attached
        // members react immediately.
        if (accepted > 0)
        {
            var events = services.GetRequiredService<Sync.SpaceEventBroadcaster>();
            events.Publish(ImportIds.FeedSpaceId(linked.Iban));
            events.Publish(linked.SpaceId);
            var notifier = services.GetRequiredService<Push.PushNotifier>();
            await notifier.NotifyNewTransactionsAsync(linked.SpaceId, accepted, ct);
        }
        await Task.Delay(AccountDelay, ct);
    }
}
