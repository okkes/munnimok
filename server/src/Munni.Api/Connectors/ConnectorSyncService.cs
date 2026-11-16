using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

// Until makes it a backfill pass (#460): only the history resources, up to that day
public sealed record ConnectorSyncRequest(string ConnectionId, string Bundle, string? Since = null, string? Until = null);

public sealed record ConnectorCollectRequest(string Bundle, string? Since = null, string? Until = null);

public sealed record ConnectorCollectCall(ConnectorCollectRequest Request, string Trigger = "user", string DeviceClass = "native");

public sealed record ConnectorOutcome(int Status, JsonObject Body);

internal sealed record WireResume(string Subject, string Bundle);

internal sealed record WireAck(string Cursor);

// a crash between fetch and ack costs one sync, never a connection: the connector re-serves what was not acknowledged
// and the ingest is idempotent
public sealed class ConnectorSyncService(
    ConnectorRelay relay,
    ConnectorCatalogue catalogue,
    ConnectorIngest ingest,
    SpaceEventBroadcaster events,
    ILogger<ConnectorSyncService> logger,
    Munni.Api.Push.PushNotifier? notifier = null)
{
    // raw is never one; ledger (#566): DUO states its instalment and booked movements only there,
    // and a debt without them read as €0
    private static readonly string[] WantedIncludes = ["items", "invoice", "ledger"];

    private const string SessionField = "session";
    private const string ResourceField = "resource";
    private const string CompleteField = "complete";
    private const string OldestField = "oldest";
    private const string DayFormat = "yyyy-MM-dd";
    private const string NoTicket = "resume answered without a ticket";

    private static readonly HashSet<string> SettledJobStates = new(StringComparer.Ordinal) { "succeeded", "failed", "expired" };

    // the connector holds schedule and backfill to the provider's interval, each on its own clock
    public async Task<ConnectorOutcome> SyncAsync(
        Guid userId, string subject, string provider, ConnectorSyncRequest request, string deviceClass, CancellationToken ct, string trigger = "user")
    {
        var manifest = await catalogue.ProviderAsync(relay.Client, provider, ct);
        if (manifest is null) return UnknownProvider();

        var resumed = await ResumeAsync(subject, provider, request.Bundle, ct);
        var run = new SyncRun(userId, subject, provider, request, deviceClass, manifest)
        {
            SessionId = resumed.Text(ConnectorRelayEndpoints.SessionIdField) ?? throw new InvalidOperationException("resume answered without a session id"),
            Ticket = resumed.Text("ticket") ?? throw new InvalidOperationException(NoTicket),
            Trigger = trigger,
        };
        var row = await ConnectorRelayEndpoints.BindAsync(relay.Db, userId, provider, request.ConnectionId, resumed, relay.Time, ct);

        foreach (var resource in PassResources(manifest, request.Until))
        {
            var pending = await FetchResourceAsync(run, resource, ct);
            if (pending is not null) return pending;
        }

        row.State = "active";
        row.LastSeenAt = relay.Time.GetUtcNow();
        // a kept (household-agent) bundle follows the rotation, so the next
        // scheduled sync resumes from the material the provider issued last
        if (row.KeptBundle is not null) row.KeptBundle = run.Bundle;
        await relay.Db.SaveChangesAsync(ct);
        Wake(run.Touched);
        await NotifyAsync(run.Trigger, run.NewBySpace, ct);

        var body = new JsonObject
        {
            ["sessionId"] = run.SessionId,
            ["state"] = "active",
            ["ingested"] = Counts(run.Landed),
            // false when a party holds more history than one pass fetches: the
            // app says so instead of presenting the newest rows as the lot
            [CompleteField] = !run.Partial,
        };
        StampOldest(body, run);
        if (run.Rotated) body[SessionField] = Session(run.Bundle);
        return new ConnectorOutcome(StatusCodes.Status200OK, body);
    }

    private static void StampOldest(JsonObject body, SyncRun run)
    {
        if (run.Partial && run.Oldest is { } oldest) body[OldestField] = oldest.ToString(DayFormat, CultureInfo.InvariantCulture);
    }

    // every fetch is a job of its own and the adapters walk newest first and cap themselves: asking again after a partial
    // pass would refetch the same newest rows, so a partial pass is said on the outcome instead
    private async Task<ConnectorOutcome?> FetchResourceAsync(SyncRun run, JsonObject resource, CancellationToken ct)
    {
        var resourceId = resource.Text("id");
        var shape = resource.Text("returns");
        if (resourceId is null || shape is null) return null;
        // a backfill pass past the party's history (or before its own since) has nothing left to ask for
        if (run.Request.Until is { } until && !Reaches(resource, run.Manifest, run.Request.Since, until, relay.Time.GetUtcNow())) return null;

        var query = QueryFor(resource, run.Manifest, run.Request.Since, run.Request.Until);
        var fetch = await relay.Client.GetAsync($"v1/{run.Provider}/{resourceId}{query}", new ConnectorCall
        {
            Subject = run.Subject,
            Ticket = run.Ticket,
            Trigger = run.Trigger,
            DeviceClass = run.DeviceClass,
        }, ct);

        if (fetch.Status == HttpStatusCode.Accepted) return Accepted(run, fetch.Object);
        if (!fetch.IsSuccess) throw new ConnectorReplyException(fetch);

        var page = fetch.Object;
        await LandPageAsync(run, resourceId, shape, page, ct);
        if (page[CompleteField]?.GetValue<bool>() == false)
        {
            run.Partial = true;
            run.NoteOldest(OldestOf(page["data"] as JsonArray, Day(run.Request.Until)));
            return null;
        }

        // a complete pass over the transactions settles the pending mirror (§15): what the
        // party stopped reporting is tombstoned; an incomplete pass settles nothing — and
        // neither does a backfill pass, whose window ends long before today's pending rows
        if (shape == "transaction" && run.Request.Until is null)
        {
            var carried = ConnectorIngest.AccountIdsOf(page["data"] as JsonArray);
            await ingest.SettlePendingAsync(run.UserId, run.Provider, run.Request.ConnectionId, carried, run.Pending, ct);
        }
        return null;
    }

    private async Task LandPageAsync(SyncRun run, string resourceId, string shape, JsonObject page, CancellationToken ct)
    {
        var landed = await ingest.IngestAsync(
            run.UserId, run.Provider, run.ProviderName, run.Request.ConnectionId, shape, page["data"] as JsonArray ?? [], ct);
        run.Landed = run.Landed.Plus(landed.Counts);
        run.Touched.UnionWith(landed.TouchedSpaces);
        run.Pending.AddRange(landed.PendingRows);
        run.NoteNew(landed.NewBySpace);

        if (page[SessionField] is JsonObject session && session.Text("bundle") is { Length: > 0 } fresh)
        {
            // the provider rotated underneath: everything after this runs on
            // the new material, and the app persists it
            run.Bundle = fresh;
            run.Rotated = true;
            run.Ticket = (await ResumeAsync(run.Subject, run.Provider, fresh, ct)).Text("ticket") ?? run.Ticket;
        }

        if (page.Text("cursor") is { } cursor)
        {
            await AckAsync(run.Subject, run.Provider, resourceId, run.Ticket, cursor, ct);
        }
    }

    private ConnectorOutcome Accepted(SyncRun run, JsonObject accepted)
    {
        var jobId = accepted.Text("job_id") ?? throw new InvalidOperationException("a 202 without a job id");
        relay.Bridge.WatchJob(run.UserId, run.Subject, run.Provider, run.SessionId, jobId);
        Wake(run.Touched);

        var pending = (JsonObject)ConnectorJson.ToCamel(accepted)!;
        pending["sessionId"] = run.SessionId;
        pending["ingested"] = Counts(run.Landed);
        if (run.Rotated) pending[SessionField] = Session(run.Bundle);
        return new ConnectorOutcome(StatusCodes.Status202Accepted, pending);
    }

    // without its page: records land through sync
    public async Task<ConnectorOutcome> JobAsync(Guid userId, string subject, string provider, string jobId, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync($"v1/{provider}/jobs/{jobId}", new ConnectorCall { Subject = subject }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        Follow(userId, subject, provider, reply.Object, jobId);
        return new ConnectorOutcome(StatusCodes.Status200OK, ViewOf(reply.Object));
    }

    public async Task<ConnectorOutcome> AnswerJobAsync(
        Guid userId, string subject, string provider, string jobId, ConnectorAnswerRequest request, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/jobs/{jobId}/answer", new ConnectorCall
        {
            Subject = subject,
            Body = new WireAnswer(request.ChallengeId, request.Value ?? string.Empty),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        Follow(userId, subject, provider, reply.Object, jobId);
        return new ConnectorOutcome((int)reply.Status, ViewOf(reply.Object));
    }

    // a pass further down the walk that became a job answers 202 with THAT job's view, to follow and collect in turn
    public async Task<ConnectorOutcome> CollectAsync(
        Guid userId, string subject, string provider, string jobId, ConnectorCollectCall call, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync($"v1/{provider}/jobs/{jobId}", new ConnectorCall { Subject = subject }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        var job = reply.Object;
        var state = job.Text(ConnectorRelayEndpoints.StateField);
        var view = ViewOf(job);

        if (state != "succeeded")
        {
            Follow(userId, subject, provider, job, jobId);
            return new ConnectorOutcome(
                state is not null && SettledJobStates.Contains(state) ? StatusCodes.Status200OK : StatusCodes.Status202Accepted,
                view);
        }

        var sessionId = job.Text(ConnectorRelayEndpoints.SessionIdField) ?? throw new InvalidOperationException("a job without a session");
        var row = await relay.Db.ConnectorSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId, ct);
        var manifest = await catalogue.ProviderAsync(relay.Client, provider, ct);
        var landed = await LandJobAsync(new JobPage(userId, provider, manifest, row, job, sessionId), call.Request.Until is not null, ct);

        // the bundle the job itself rotated wins over the one the app sent
        var rotated = job[SessionField] is JsonObject;
        var bundle = (job[SessionField] as JsonObject)?.Text("bundle") ?? call.Request.Bundle;
        var ticket = await AckJobAsync(subject, provider, job, bundle, ct);

        // the job was ONE resource's pass, so the walk goes on after it (prod 2026-10-04: a bank's accounts pass became a job and
        // the transactions were never asked for: the balance moved, the list did not)
        var run = new SyncRun(
            userId, subject, provider,
            new ConnectorSyncRequest(row?.ConnectionId ?? sessionId, bundle, call.Request.Since, call.Request.Until),
            call.DeviceClass, manifest ?? new JsonObject())
        {
            SessionId = sessionId,
            Ticket = ticket,
            Trigger = call.Trigger,
            Landed = landed?.Counts ?? ConnectorIngestCounts.None,
            Partial = job[CompleteField]?.GetValue<bool>() == false,
            Rotated = rotated,
        };
        if (run.Partial) run.NoteOldest(OldestOf(job["data"] as JsonArray, Day(call.Request.Until)));
        if (landed is not null) run.NoteNew(landed.NewBySpace);

        var pending = await WalkOnAsync(run, row, job.Text(ResourceField), ct);
        return pending ?? await FinishAsync(run, row, view, ct);
    }

    // a page that still carries its accounts is the party's word, also with no reserved row;
    // a gone page (collected, swept, taken over) is not
    private async Task<ConnectorIngestResult?> LandJobAsync(JobPage page, bool backfill, CancellationToken ct)
    {
        var landed = await LandJobPageAsync(page, ct);
        // a backfill pass (#460) reads older history only: today's pending rows are outside its window
        if (!backfill && ShapeOf(page.Manifest, page.Job) == "transaction" && page.Job[CompleteField]?.GetValue<bool>() != false)
        {
            var carried = ConnectorIngest.AccountIdsOf(page.Job["data"] as JsonArray);
            await ingest.SettlePendingAsync(page.UserId, page.Provider, page.ConnectionId, carried, landed?.PendingRows ?? [], ct);
        }
        return landed;
    }

    private async Task<string> AckJobAsync(string subject, string provider, JsonObject job, string bundle, CancellationToken ct)
    {
        var resumed = await ResumeAsync(subject, provider, bundle, ct);
        var ticket = resumed.Text("ticket") ?? throw new InvalidOperationException(NoTicket);
        if (job.Text(ResourceField) is { } resourceId && job.Text("cursor") is { } cursor)
        {
            await AckAsync(subject, provider, resourceId, ticket, cursor, ct);
        }
        return ticket;
    }

    private async Task<ConnectorOutcome?> WalkOnAsync(SyncRun run, ConnectorSession? row, string? resourceId, CancellationToken ct)
    {
        if (resourceId is null) return null;
        foreach (var resource in PassResources(run.Manifest, run.Request.Until).SkipWhile(r => r.Text("id") != resourceId).Skip(1))
        {
            var pending = await FetchResourceAsync(run, resource, ct);
            if (pending is null) continue;
            // a kept bundle follows a rotation even while the walk is still out
            if (row?.KeptBundle is not null && run.Rotated)
            {
                row.KeptBundle = run.Bundle;
                await relay.Db.SaveChangesAsync(ct);
            }
            return pending;
        }
        return null;
    }

    private async Task<ConnectorOutcome> FinishAsync(SyncRun run, ConnectorSession? row, JsonObject view, CancellationToken ct)
    {
        if (row is not null)
        {
            row.State = "active";
            row.LastSeenAt = relay.Time.GetUtcNow();
            if (row.KeptBundle is not null) row.KeptBundle = run.Bundle;
            await relay.Db.SaveChangesAsync(ct);
        }
        Wake(run.Touched);
        await NotifyAsync(run.Trigger, run.NewBySpace, ct);

        view["ingested"] = Counts(run.Landed);
        view[CompleteField] = !run.Partial;
        StampOldest(view, run);
        if (run.Rotated) view[SessionField] = Session(run.Bundle);
        return new ConnectorOutcome(StatusCodes.Status200OK, view);
    }

    private async Task<ConnectorIngestResult?> LandJobPageAsync(JobPage page, CancellationToken ct)
    {
        var shape = ShapeOf(page.Manifest, page.Job);
        if (shape is null || page.Job["data"] is not JsonArray data || data.Count == 0) return null;

        var landed = await ingest.IngestAsync(
            page.UserId, page.Provider, page.Manifest?.Text("name") ?? page.Provider, page.ConnectionId, shape, data, ct);
        Wake(landed.TouchedSpaces);
        return landed;
    }

    private static string? ShapeOf(JsonObject? manifest, JsonObject job)
    {
        var resourceId = job.Text(ResourceField);
        return resourceId is null ? null : Resources(manifest).FirstOrDefault(r => r.Text("id") == resourceId)?.Text("returns");
    }

    // a space it brought nothing says nothing; a person's own sync needs no push
    private async Task NotifyAsync(string trigger, IReadOnlyDictionary<string, int> newBySpace, CancellationToken ct)
    {
        if (notifier is null || trigger != "schedule") return;
        foreach (var (spaceId, count) in newBySpace) await notifier.NotifyNewTransactionsAsync(spaceId, count, ct);
    }

    private async Task<JsonObject> ResumeAsync(string subject, string provider, string bundle, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/sessions/resume", new ConnectorCall
        {
            Subject = subject,
            Body = new WireResume(subject, bundle),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return reply.Object;
    }

    private async Task AckAsync(string subject, string provider, string resourceId, string ticket, string cursor, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/{resourceId}/ack", new ConnectorCall
        {
            Subject = subject,
            Ticket = ticket,
            Body = new WireAck(cursor),
        }, ct);
        if (!reply.IsSuccess && logger.IsEnabled(LogLevel.Warning))
        {
            // what was ingested stays ingested; the rows come again next
            // time and the ingest ignores them
            logger.LogWarning("connector ack for {Provider}/{Resource} answered {Status}: the rows are re-served next sync",
                provider, resourceId, (int)reply.Status);
        }
    }

    private void Follow(Guid userId, string subject, string provider, JsonObject job, string jobId)
    {
        var state = job.Text(ConnectorRelayEndpoints.StateField);
        if (state is null || SettledJobStates.Contains(state)) return;
        var sessionId = job.Text(ConnectorRelayEndpoints.SessionIdField) ?? string.Empty;
        relay.Bridge.WatchJob(userId, subject, provider, sessionId, jobId);
    }

    private void Wake(IEnumerable<string> touched)
    {
        foreach (var spaceId in touched) events.Publish(spaceId);
    }

    private static JsonObject ViewOf(JsonObject job)
    {
        var view = (JsonObject)ConnectorJson.ToCamel(job)!;
        view.Remove("data");
        return view;
    }

    private static IEnumerable<JsonObject> Resources(JsonObject? manifest) =>
        manifest?["resources"] is JsonArray resources ? resources.OfType<JsonObject>() : [];

    /// <summary>The resources one pass walks: all of them, or for a backfill pass (#460) only those that take an <c>until</c> — accounts are all of them already.</summary>
    internal static IEnumerable<JsonObject> PassResources(JsonObject? manifest, string? until) =>
        until is null ? Resources(manifest) : Resources(manifest).Where(r => Param(r["params"] as JsonArray ?? [], "until") is not null);

    internal static string QueryFor(JsonObject resource, JsonObject manifest, string? since, string? until = null)
    {
        var parameters = resource["params"] as JsonArray ?? [];
        var parts = new List<string>();

        if (Param(parameters, "since") is not null)
        {
            var from = since ?? Floor(resource, manifest, DateTimeOffset.UtcNow).ToString(DayFormat, CultureInfo.InvariantCulture);
            parts.Add($"since={Uri.EscapeDataString(from)}");
        }

        if (until is not null && Param(parameters, "until") is not null) parts.Add($"until={Uri.EscapeDataString(until)}");

        if (Param(parameters, "include") is { } include && include["values"] is JsonArray offered)
        {
            var wanted = offered.Select(v => v?.GetValue<string>()).Where(v => v is not null && WantedIncludes.Contains(v)).ToList();
            if (wanted.Count > 0) parts.Add($"include={Uri.EscapeDataString(string.Join(",", wanted))}");
        }

        return parts.Count == 0 ? string.Empty : "?" + string.Join("&", parts);
    }

    private static JsonObject? Param(JsonArray parameters, string key) =>
        parameters.OfType<JsonObject>().FirstOrDefault(p => string.Equals(p.Text("key"), key, StringComparison.Ordinal));

    /// <summary>The oldest day a resource reaches: its own history limit, else the party's, else a year.</summary>
    private static DateOnly Floor(JsonObject resource, JsonObject manifest, DateTimeOffset now)
    {
        var maxDays = resource["max_history_days"]?.GetValue<int>()
                      ?? (manifest["limits"] as JsonObject)?["max_history_days"]?.GetValue<int>()
                      ?? 365;
        return DateOnly.FromDateTime(now.UtcDateTime).AddDays(-maxDays);
    }

    /// <summary>Whether a backfill window still holds a day the party keeps: an <c>until</c> before the floor (or before the pass's own <c>since</c>) asks for nothing.</summary>
    internal static bool Reaches(JsonObject resource, JsonObject manifest, string? since, string until, DateTimeOffset now)
    {
        if (!DateOnly.TryParseExact(until, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var to)) return false;
        if (to < Floor(resource, manifest, now)) return false;
        return since is null
               || !DateOnly.TryParseExact(since, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var from)
               || from <= to;
    }

    // a party caps each account by itself, so accounts stop on different days: the frontier is the NEWEST of their oldest days
    internal static DateOnly? OldestOf(JsonArray? records, DateOnly? until = null)
    {
        var perAccount = new Dictionary<string, DateOnly>(StringComparer.Ordinal);
        foreach (var record in records?.OfType<JsonObject>() ?? [])
        {
            // a reservation is kept whatever its day: it says nothing about where the walk stopped
            if (record.Text("external_id")?.StartsWith(ConnectorIngest.PendingPrefix, StringComparison.Ordinal) == true) continue;
            if (DayOf(record) is not { } day) continue;
            var account = record.Text("account_id") ?? string.Empty;
            if (!perAccount.TryGetValue(account, out var known) || day < known) perAccount[account] = day;
        }

        DateOnly? frontier = null;
        foreach (var day in perAccount.Values)
        {
            // an account that brought nothing below the day asked has nothing older left to hold the frontier up
            if (until is { } asked && day >= asked) continue;
            if (frontier is null || day > frontier) frontier = day;
        }
        return frontier;
    }

    private static DateOnly? Day(string? text) =>
        DateOnly.TryParseExact(text, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;

    private static DateOnly? DayOf(JsonObject record)
    {
        if (record.Text("booked_at") is { } booked
            && DateOnly.TryParseExact(booked, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
        {
            return day;
        }
        return record.Text("purchased_at") is { } purchased
               && DateTimeOffset.TryParse(purchased, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at)
            ? DateOnly.FromDateTime(at.Date)
            : null;
    }

    private static JsonObject Counts(ConnectorIngestCounts counts) => new()
    {
        ["records"] = counts.Records,
        ["receipts"] = counts.Receipts,
        ["accounts"] = counts.Accounts,
        ["transactions"] = counts.Transactions,
        ["positions"] = counts.Positions,
        ["dropped"] = counts.Dropped,
    };

    private static JsonObject Session(string bundle) => new() { ["bundle"] = bundle, ["rotated"] = true };

    private static ConnectorOutcome UnknownProvider() => new(StatusCodes.Status404NotFound, new JsonObject
    {
        ["error"] = new JsonObject
        {
            ["code"] = "unsupported_resource",
            ["retriable"] = false,
            ["userAction"] = "none",
            ["messageKey"] = "connect.error.unsupported_resource",
        },
    });

    private sealed record JobPage(Guid UserId, string Provider, JsonObject? Manifest, ConnectorSession? Row, JsonObject Job, string SessionId)
    {
        public string ConnectionId => Row?.ConnectionId ?? SessionId;
    }

    private sealed class SyncRun(Guid userId, string subject, string provider, ConnectorSyncRequest request, string deviceClass, JsonObject manifest)
    {
        public Guid UserId { get; } = userId;

        public string Subject { get; } = subject;

        public string Provider { get; } = provider;

        public ConnectorSyncRequest Request { get; } = request;

        public string DeviceClass { get; } = deviceClass;

        public JsonObject Manifest { get; } = manifest;

        public string ProviderName { get; } = manifest.Text("name") ?? provider;

        /// <summary>The pending rows the pages mirrored (§15), settled once the transactions resource is complete.</summary>
        public List<ConnectorPendingTx> Pending { get; } = [];

        /// <summary>The booked rows each space shows for the first time, over every page: what a scheduled fetch tells that space.</summary>
        public Dictionary<string, int> NewBySpace { get; } = new(StringComparer.Ordinal);

        public void NoteNew(IReadOnlyDictionary<string, int> landed)
        {
            foreach (var (spaceId, count) in landed) NewBySpace[spaceId] = NewBySpace.GetValueOrDefault(spaceId) + count;
        }

        public required string SessionId { get; init; }

        public required string Ticket { get; set; }

        public bool Partial { get; set; }

        /// <summary>The day down to which an incomplete pass is whole: the next older pass asks up to it.</summary>
        public DateOnly? Oldest { get; private set; }

        // several incomplete resources are all whole only above the newest of their frontiers
        public void NoteOldest(DateOnly? day)
        {
            if (day is { } d && (Oldest is null || d > Oldest)) Oldest = d;
        }

        public string Trigger { get; init; } = "user";

        public string Bundle { get; set; } = request.Bundle;

        public bool Rotated { get; set; }

        public ConnectorIngestCounts Landed { get; set; } = ConnectorIngestCounts.None;

        public HashSet<string> Touched { get; } = new(StringComparer.Ordinal);
    }
}
