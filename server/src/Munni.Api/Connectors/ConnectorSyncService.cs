using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

/// <summary>One sync of a connection (docs/connector-integration-plan.md §5.2): the bundle the client holds, and how far back to look.</summary>
public sealed record ConnectorSyncRequest(string ConnectionId, string Bundle, string? Since = null);

/// <summary>Following a fetch that did not finish inside the connector's window: the newest bundle the client holds.</summary>
public sealed record ConnectorCollectRequest(string Bundle);

/// <summary>What a relay operation answers: a status and the body the app reads.</summary>
public sealed record ConnectorOutcome(int Status, JsonObject Body);

internal sealed record WireResume(string Subject, string Bundle);

internal sealed record WireAck(string Cursor);

/// <summary>
/// The sync the app cannot see the inside of: resume the session from the
/// bundle, fetch every resource the manifest declares, ingest what came
/// back, acknowledge it, and hand the rotated bundle back in the same
/// answer. A crash between fetch and ack costs one sync and never a
/// connection: the connector re-serves what was not acknowledged and the
/// ingest is idempotent. A fetch that stops — for a question, or for a
/// window the provider outran — comes back as a job the app follows, and
/// <see cref="CollectAsync"/> finishes the same sequence for it.
/// </summary>
public sealed class ConnectorSyncService(
    ConnectorRelay relay,
    ConnectorCatalogue catalogue,
    ConnectorIngest ingest,
    SpaceEventBroadcaster events,
    ILogger<ConnectorSyncService> logger)
{
    /// <summary>The includes a sync asks for when a resource offers them; <c>raw</c> is never one of them.</summary>
    private static readonly string[] WantedIncludes = ["items", "invoice"];

    /// <summary>How many passes one sync makes over a resource the provider paginates.</summary>
    private const int MaximumPasses = 20;

    private const string SessionField = "session";
    private const string ResourceField = "resource";

    private static readonly HashSet<string> SettledJobStates = new(StringComparer.Ordinal) { "succeeded", "failed", "expired" };

    /// <param name="trigger"><c>user</c> for a person's call, <c>schedule</c> for the relay's own scheduler — the connector holds the latter to the provider's interval.</param>
    public async Task<ConnectorOutcome> SyncAsync(
        Guid userId, string subject, string provider, ConnectorSyncRequest request, string deviceClass, CancellationToken ct, string trigger = "user")
    {
        var manifest = await catalogue.ProviderAsync(relay.Client, provider, ct);
        if (manifest is null) return UnknownProvider();

        var resumed = await ResumeAsync(subject, provider, request.Bundle, ct);
        var run = new SyncRun(userId, subject, provider, request, deviceClass, manifest)
        {
            SessionId = resumed.Text(ConnectorRelayEndpoints.SessionIdField) ?? throw new InvalidOperationException("resume answered without a session id"),
            Ticket = resumed.Text("ticket") ?? throw new InvalidOperationException("resume answered without a ticket"),
            Trigger = trigger,
        };
        var row = await ConnectorRelayEndpoints.BindAsync(relay.Db, userId, provider, request.ConnectionId, resumed, relay.Time, ct);

        foreach (var resource in Resources(manifest))
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

        var body = new JsonObject
        {
            ["sessionId"] = run.SessionId,
            ["state"] = "active",
            ["ingested"] = Counts(run.Landed),
        };
        if (run.Rotated) body[SessionField] = Session(run.Bundle);
        return new ConnectorOutcome(StatusCodes.Status200OK, body);
    }

    /// <summary>
    /// One resource, as many passes as the provider paginates it into. Null
    /// when every page landed; the 202 outcome when a pass became a job.
    /// </summary>
    private async Task<ConnectorOutcome?> FetchResourceAsync(SyncRun run, JsonObject resource, CancellationToken ct)
    {
        var resourceId = resource.Text("id");
        var shape = resource.Text("returns");
        if (resourceId is null || shape is null) return null;

        var query = QueryFor(resource, run.Manifest, run.Request.Since);
        for (var pass = 1; pass <= MaximumPasses; pass++)
        {
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
            if (page["complete"]?.GetValue<bool>() != false) break;
        }

        return null;
    }

    /// <summary>A page: ingest it, take the bundle it rotated, acknowledge it.</summary>
    private async Task LandPageAsync(SyncRun run, string resourceId, string shape, JsonObject page, CancellationToken ct)
    {
        var landed = await ingest.IngestAsync(
            run.UserId, run.Provider, run.ProviderName, run.Request.ConnectionId, shape, page["data"] as JsonArray ?? [], ct);
        run.Landed = run.Landed.Plus(landed.Counts);
        run.Touched.UnionWith(landed.TouchedSpaces);

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

    /// <summary>A run still in flight, or parked on a question: the app follows the job and collects it with the bundle it holds.</summary>
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

    /// <summary>The job as the connector shows it, in this API's casing and without its page of records: those land through sync.</summary>
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

    /// <summary>
    /// Finishes a job the app followed to its end: ingests its page, resumes
    /// with the bundle the app holds to acknowledge it, and hands back the
    /// bundle the connector rotated, if it did. A job that is not finished
    /// yet answers 202 with its view; a job that failed answers with its error.
    /// </summary>
    public async Task<ConnectorOutcome> CollectAsync(
        Guid userId, string subject, string provider, string jobId, ConnectorCollectRequest request, CancellationToken ct)
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
        var counts = await LandJobPageAsync(userId, provider, manifest, row, job, sessionId, ct);

        // the bundle the job itself rotated wins over the one the app sent
        var rotated = job[SessionField] is JsonObject;
        var bundle = (job[SessionField] as JsonObject)?.Text("bundle") ?? request.Bundle;
        if (job.Text(ResourceField) is { } resourceId && job.Text("cursor") is { } cursor)
        {
            var resumed = await ResumeAsync(subject, provider, bundle, ct);
            var ticket = resumed.Text("ticket") ?? throw new InvalidOperationException("resume answered without a ticket");
            await AckAsync(subject, provider, resourceId, ticket, cursor, ct);
        }

        if (row is not null)
        {
            row.State = "active";
            row.LastSeenAt = relay.Time.GetUtcNow();
            if (row.KeptBundle is not null) row.KeptBundle = bundle;
            await relay.Db.SaveChangesAsync(ct);
        }

        view["ingested"] = Counts(counts);
        if (rotated) view[SessionField] = Session(bundle);
        return new ConnectorOutcome(StatusCodes.Status200OK, view);
    }

    private async Task<ConnectorIngestCounts> LandJobPageAsync(
        Guid userId, string provider, JsonObject? manifest, ConnectorSession? row, JsonObject job, string sessionId, CancellationToken ct)
    {
        var resourceId = job.Text(ResourceField);
        var shape = resourceId is null
            ? null
            : Resources(manifest).FirstOrDefault(r => r.Text("id") == resourceId)?.Text("returns");
        if (shape is null || job["data"] is not JsonArray data || data.Count == 0) return ConnectorIngestCounts.None;

        var landed = await ingest.IngestAsync(
            userId, provider, manifest?.Text("name") ?? provider, row?.ConnectionId ?? sessionId, shape, data, ct);
        Wake(landed.TouchedSpaces);
        return landed.Counts;
    }

    // ── the connector's calls ────────────────────────────────────────────

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

    /// <summary>The job in the app's casing, without its page: records reach the app through the feeds.</summary>
    private static JsonObject ViewOf(JsonObject job)
    {
        var view = (JsonObject)ConnectorJson.ToCamel(job)!;
        view.Remove("data");
        return view;
    }

    // ── the manifest, read ───────────────────────────────────────────────

    private static IEnumerable<JsonObject> Resources(JsonObject? manifest) =>
        manifest?["resources"] is JsonArray resources ? resources.OfType<JsonObject>() : [];

    /// <summary>
    /// The query a resource takes: <c>since</c> when it declares one (the
    /// caller's date, else as far back as the provider allows), the includes
    /// it offers among the ones munni wants. Nothing else — accounts are all
    /// of them, and <c>until</c> is today.
    /// </summary>
    internal static string QueryFor(JsonObject resource, JsonObject manifest, string? since)
    {
        var parameters = resource["params"] as JsonArray ?? [];
        var parts = new List<string>();

        if (Param(parameters, "since") is not null)
        {
            var maxDays = resource["max_history_days"]?.GetValue<int>()
                          ?? (manifest["limits"] as JsonObject)?["max_history_days"]?.GetValue<int>()
                          ?? 365;
            var from = since ?? DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-maxDays).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            parts.Add($"since={Uri.EscapeDataString(from)}");
        }

        if (Param(parameters, "include") is { } include && include["values"] is JsonArray offered)
        {
            var wanted = offered.Select(v => v?.GetValue<string>()).Where(v => v is not null && WantedIncludes.Contains(v)).ToList();
            if (wanted.Count > 0) parts.Add($"include={Uri.EscapeDataString(string.Join(",", wanted))}");
        }

        return parts.Count == 0 ? string.Empty : "?" + string.Join("&", parts);
    }

    private static JsonObject? Param(JsonArray parameters, string key) =>
        parameters.OfType<JsonObject>().FirstOrDefault(p => string.Equals(p.Text("key"), key, StringComparison.Ordinal));

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

    /// <summary>One sync's state as it walks the manifest: the ticket in hand, the bundle to persist, what landed.</summary>
    private sealed class SyncRun(Guid userId, string subject, string provider, ConnectorSyncRequest request, string deviceClass, JsonObject manifest)
    {
        public Guid UserId { get; } = userId;

        public string Subject { get; } = subject;

        public string Provider { get; } = provider;

        public ConnectorSyncRequest Request { get; } = request;

        public string DeviceClass { get; } = deviceClass;

        public JsonObject Manifest { get; } = manifest;

        public string ProviderName { get; } = manifest.Text("name") ?? provider;

        public required string SessionId { get; init; }

        public required string Ticket { get; set; }

        /// <summary>What the fetches declare themselves as: a person's call, or the scheduler's.</summary>
        public string Trigger { get; init; } = "user";

        public string Bundle { get; set; } = request.Bundle;

        public bool Rotated { get; set; }

        /// <summary>What has landed so far, over every resource and pass.</summary>
        public ConnectorIngestCounts Landed { get; set; } = ConnectorIngestCounts.None;

        public HashSet<string> Touched { get; } = new(StringComparer.Ordinal);
    }
}
