using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Sync;

public sealed record PushRequest(string ClientId, List<SyncOpDto> Ops);
public sealed record PushResponse(long LastSeq, int Accepted, int Duplicates);
// NextSince (#305 bug 4): the last RETURNED op's seq — the honest page
// cursor. LatestSeq is the space head; advancing the client cursor to it
// after a capped 1000-op page skipped everything in between forever.
public sealed record PullResponse(List<SyncOpDto> Ops, long LatestSeq, long NextSince);
public sealed record BootstrapRow(string Entity, string EntityId, bool Deleted, JsonElement Data, Dictionary<string, string> FieldVersions);
/// <summary>
/// One page of a space's rows as they stand (#606): what a device without the space takes instead of
/// replaying its history.
/// </summary>
/// <param name="LatestSeq">The space's head, read before the page's rows. Whatever is written while the pages
/// are read lies after the FIRST page's value: the device pulls from there once it holds every page.</param>
/// <param name="Next">What the next page is asked with (<c>after</c>); null on the last one.</param>
public sealed record BootstrapResponse(List<BootstrapRow> Rows, long LatestSeq, string? Next = null);
/// <summary>
/// Where one space the caller reaches stands: its head as the caller may pull
/// it (capped for an archived feed), and the caller's role there (#505: a
/// device refuses its own writes where it may only read) — a feed reached
/// only through an attachment reads as "reader".
/// </summary>
public sealed record SpaceHead(string SpaceId, long LatestSeq, string Role);

public static class SyncEndpoints
{
    public static void MapSync(this IEndpointRouteBuilder app)
    {
        // fresh devices discover their spaces here before pulling — feeds
        // reachable through attachments/ownership are part of the answer,
        // so real-time sync of shared accounts needs no extra wiring
        app.MapGet("/me/spaces", async (AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            var spaceIds = await db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId).ToListAsync();
            var feeds = await Accounts.FeedAccess.ReachableFeedsAsync(db, userId);
            return Results.Ok(spaceIds.Union(feeds).ToList());
        }).RequireAuthorization();

        // #569: every space the caller reaches with its head, in one call — a
        // sync round pulls only the spaces that moved instead of asking each
        // in turn (a round over ~25 spaces was ~25 requests, and a burst of
        // writes ran the rate limiter dry: "too many requests" on attach)
        app.MapGet("/sync/heads", Heads).RequireAuthorization();

        // near-real-time change stream: emits {"spaceId":…} whenever one of
        // the caller's spaces accepted new ops (push or bank ingest)
        app.MapGet("/sync/events", StreamEvents).RequireAuthorization();

        var group = app.MapGroup("/sync/{spaceId}").RequireAuthorization().WithSafeRouteParams();
        group.MapPost("/push", Push).WithValidation<PushRequest>();
        group.MapGet("/pull", Pull);
        group.MapGet("/bootstrap", Bootstrap);
    }

    /// <summary>
    /// The caller's spaces (memberships and the feeds reachable through
    /// attachments or ownership, as <c>/me/spaces</c> lists them) with the
    /// head each pull would report: the space's last seq, capped where only
    /// an archived attachment reaches a feed — the same rule <see cref="Pull"/>
    /// applies.
    /// </summary>
    private static async Task<IResult> Heads(AppDbContext db, HttpContext http)
    {
        var userId = http.GetUserId();
        var roles = await db.SpaceMembers.Where(m => m.UserId == userId).ToDictionaryAsync(m => m.SpaceId, m => m.Role, StringComparer.Ordinal);
        var feedCaps = await Accounts.FeedAccess.ReadCapsAsync(db, userId);
        var ids = roles.Keys.Union(feedCaps.Keys).ToList();
        var lastSeqs = await db.Spaces.Where(s => ids.Contains(s.Id)).Select(s => new { s.Id, s.LastSeq }).ToDictionaryAsync(s => s.Id, s => s.LastSeq);
        var heads = ids.Select(id =>
        {
            var member = roles.TryGetValue(id, out var role);
            var cap = member ? long.MaxValue : feedCaps[id];
            return new SpaceHead(id, Math.Min(lastSeqs.GetValueOrDefault(id), cap), member ? role! : Social.SpaceRoles.Reader);
        }).ToList();
        return Results.Ok(heads);
    }

    private static async Task<IResult> Push(string spaceId, PushRequest request, AppDbContext db, SpaceEventBroadcaster events, HttpContext http)
    {
        var userId = http.GetUserId();
        // #281 (GlitchTip API-STAGING-N, 2026-08-20 storm): concurrent
        // pushes — or a push racing the bank ingest — both miss the row
        // read and collide on a PK at save. A clean retry re-reads what
        // the winner committed and the LWW merge converges; without it
        // the client saw 500s, retried, and ran into the rate limiter.
        var attempt = 0;
        while (true)
        {
            attempt++;
            try
            {
                return await PushOnce(spaceId, request, db, events, userId);
            }
            catch (DbUpdateException ex) when (attempt < 3 && SyncWriter.IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
            }
        }
    }

    private static async Task<IResult> PushOnce(string spaceId, PushRequest request, AppDbContext db, SpaceEventBroadcaster events, Guid userId)
    {
        var space = await db.Spaces.FindAsync(spaceId);
        if (space is null)
        {
            // deterministic (uuidv5) feed ids are guessable from an IBAN —
            // feeds are born only via POST /feeds (security review S1)
            if (Accounts.FeedAccess.IsFeedShaped(spaceId))
                return Results.Forbid();
            // first push creates the space with the pusher as owner (a
            // lost create race lands in the member check on the retry)
            space = new Space { Id = spaceId };
            db.Spaces.Add(space);
            db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = userId, Role = Social.SpaceRoles.Owner });
        }
        else
        {
            var membership = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId);
            if (membership is null) return Results.Forbid();
            // readers may pull but never push
            if (!Social.SpaceRoles.CanWrite(membership.Role)) return Social.SpaceRoles.ReadOnly();
        }

        var writer = new SyncWriter(db);
        var (lastSeq, accepted) = await writer.ApplyAsync(space, userId, request.Ops);
        await db.SaveChangesAsync();
        if (accepted > 0) events.Publish(spaceId); // wake the other devices/members
        return Results.Ok(new PushResponse(lastSeq, accepted, request.Ops.Count - accepted));
    }

    private static async Task<IResult> Pull(string spaceId, long since, AppDbContext db, HttpContext http)
    {
        var cap = long.MaxValue;
        var member = await RequireMember(spaceId, db, http);
        if (member is not null)
        {
            // not a member — attachments may still derive (possibly
            // archive-capped) read access to a feed space
            var feedCap = await Accounts.FeedAccess.ReadCapAsync(db, http.GetUserId(), spaceId);
            if (feedCap is null) return member;
            cap = feedCap.Value;
        }

        var space = await db.Spaces.FindAsync(spaceId);
        var ops = await db.SyncOps
            .Where(o => o.SpaceId == spaceId && o.Seq > since && o.Seq <= cap)
            .OrderBy(o => o.Seq)
            .Take(1000)
            .ToListAsync();
        var dtos = ops.Select(o => new SyncOpDto(
            o.OpId, o.SpaceId, o.Entity, o.EntityId,
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(o.PayloadJson) ?? new(),
            o.Hlc, o.Deleted)).ToList();
        // archived readers must not chase a cursor beyond their cap
        var nextSince = ops.Count > 0 ? ops[^1].Seq : since;
        return Results.Ok(new PullResponse(dtos, Math.Min(space?.LastSeq ?? 0, cap), Math.Min(nextSince, cap)));
    }

    /// <summary>How many rows one page of a snapshot holds at most.</summary>
    internal const int SnapshotPageRows = 2000;

    /// <summary>
    /// A page also ends once its rows' data passes this many characters (a picture is tens of thousands): one
    /// request stays a download a phone finishes inside the app's limit per request.
    /// </summary>
    internal const int SnapshotPageChars = 2_000_000;

    /// <summary>The longest <c>after</c> a page can have named: an entity's name, the colon, an entity id.</summary>
    private const int SnapshotCursorMaximum = 64 + 1 + 128;

    /// <summary>
    /// A space's rows after the last one of the page before, in the order of the primary key: the database
    /// walks one index from where the page before ended, however many rows the space holds.
    /// </summary>
    internal static IQueryable<EntityRow> SnapshotRowsAfter(AppDbContext db, string spaceId, (string Entity, string EntityId)? last)
    {
        var rows = db.EntityRows.AsNoTracking().Where(r => r.SpaceId == spaceId);
        if (last is var (entity, entityId))
        {
            rows = rows.Where(r => string.Compare(r.Entity, entity) > 0 || (r.Entity == entity && string.Compare(r.EntityId, entityId) > 0));
        }
        return rows.OrderBy(r => r.Entity).ThenBy(r => r.EntityId);
    }

    private static async Task<IResult> Bootstrap(string spaceId, string? after, AppDbContext db, HttpContext http)
    {
        var member = await RequireMember(spaceId, db, http);
        if (member is not null)
        {
            var feedCap = await Accounts.FeedAccess.ReadCapAsync(db, http.GetUserId(), spaceId);
            if (feedCap is null) return member;
            // rows as they stand cannot be cut off at the point an archived attachment reads up to: that
            // reader is told there is no snapshot for them, and pulls the capped history from its start
            if (feedCap != long.MaxValue) return Results.NoContent();
        }

        (string Entity, string EntityId)? last = null;
        if (!string.IsNullOrEmpty(after))
        {
            var colon = after.IndexOf(':');
            if (colon <= 0 || colon == after.Length - 1 || after.Length > SnapshotCursorMaximum) return Results.BadRequest(new { error = "after is not a page this endpoint named" });
            last = (after[..colon], after[(colon + 1)..]);
        }

        // the head BEFORE the rows: every change up to it is in the rows read after it
        var head = await db.Spaces.Where(s => s.Id == spaceId).Select(s => s.LastSeq).FirstOrDefaultAsync();
        var rows = await SnapshotRowsAfter(db, spaceId, last).Take(SnapshotPageRows + 1).ToListAsync();

        var page = new List<BootstrapRow>(Math.Min(rows.Count, SnapshotPageRows));
        var chars = 0;
        foreach (var row in rows.Take(SnapshotPageRows))
        {
            if (page.Count > 0 && chars + row.DataJson.Length > SnapshotPageChars) break;
            chars += row.DataJson.Length;
            page.Add(new BootstrapRow(
                row.Entity, row.EntityId, row.Deleted,
                JsonSerializer.Deserialize<JsonElement>(row.DataJson),
                JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new()));
        }
        var next = page.Count < rows.Count ? $"{page[^1].Entity}:{page[^1].EntityId}" : null;
        return Results.Ok(new BootstrapResponse(page, head, next));
    }

    private static async Task<IResult?> RequireMember(string spaceId, AppDbContext db, HttpContext http)
    {
        var userId = http.GetUserId();
        var isMember = await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == userId);
        return isMember ? null : Results.Forbid();
    }

    private static async Task StreamEvents(AppDbContext db, SpaceEventBroadcaster events, HttpContext http)
    {
        var userId = http.GetUserId();
        // membership snapshot at connect (incl. feeds reachable through
        // attachments); new invites are picked up when the client
        // reconnects (and the 10s poll covers the gap meanwhile)
        var mySpaces = (await db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId).ToListAsync())
            .Union(await Accounts.FeedAccess.ReachableFeedsAsync(db, userId))
            .ToHashSet();

        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no"; // reverse proxies must not buffer the stream

        var (id, reader) = events.Subscribe();
        try
        {
            await http.Response.WriteAsync(": connected\n\n", http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);
            while (!http.RequestAborted.IsCancellationRequested)
            {
                using var keepalive = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
                keepalive.CancelAfter(TimeSpan.FromSeconds(25));
                SyncEvent? evt = null;
                try
                {
                    evt = await reader.ReadAsync(keepalive.Token);
                }
                catch (OperationCanceledException) when (!http.RequestAborted.IsCancellationRequested)
                {
                    // no events for a while — keepalive comment holds proxies open
                }

                var frame = FrameFor(evt, userId, mySpaces);
                if (frame is null) continue;
                await http.Response.WriteAsync(frame, http.RequestAborted);
                await http.Response.Body.FlushAsync(http.RequestAborted);
            }
        }
        catch (OperationCanceledException)
        {
            // client went away — normal for a long-lived stream
        }
        finally
        {
            events.Unsubscribe(id);
        }
    }

    /// <summary>
    /// What one connection writes for an event: a keepalive when there was
    /// none, the space id when it is one of the caller's spaces, the frame
    /// itself when it is addressed to the caller — and nothing when the
    /// event is somebody else's.
    /// </summary>
    internal static string? FrameFor(SyncEvent? evt, Guid userId, HashSet<string> mySpaces)
    {
        if (evt is null) return ": keepalive\n\n";
        if (evt.UserId is { } target) return target == userId && evt.Json is not null ? $"data: {evt.Json}\n\n" : null;
        if (evt.SpaceId is null || !mySpaces.Contains(evt.SpaceId)) return null;
        return $"data: {JsonSerializer.Serialize(new { spaceId = evt.SpaceId })}\n\n";
    }
}
