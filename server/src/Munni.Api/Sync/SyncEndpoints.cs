using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Sync;

public sealed record PushRequest(string ClientId, List<SyncOpDto> Ops);
public sealed record PushResponse(long LastSeq, int Accepted, int Duplicates);
// NextSince (#305): the last RETURNED op's seq, the honest page cursor; advancing to LatestSeq (the space head)
// after a capped 1000-op page skipped everything in between for good
public sealed record PullResponse(List<SyncOpDto> Ops, long LatestSeq, long NextSince);
public sealed record BootstrapRow(string Entity, string EntityId, bool Deleted, JsonElement Data, Dictionary<string, string> FieldVersions);
/// one page of a space's rows as they stand (#606): what a device without the space takes instead of replaying history
/// LatestSeq is read before the page's rows: whatever is written meanwhile lies after the FIRST page's value,
/// and the device pulls from there
public sealed record BootstrapResponse(List<BootstrapRow> Rows, long LatestSeq, string? Next = null);
/// where one space stands: its head as the caller may pull it (capped for an archived feed) and the caller's role
/// (#505: a device refuses its own writes where it may only read); a feed reached only through an attachment reads "reader"
public sealed record SpaceHead(string SpaceId, long LatestSeq, string Role);

public static class SyncEndpoints
{
    public static void MapSync(this IEndpointRouteBuilder app)
    {
        // feeds reachable through attachments/ownership are part of the answer,
        // so real-time sync of shared accounts needs no extra wiring
        app.MapGet("/me/spaces", async (AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            var spaceIds = await db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId).ToListAsync();
            var feeds = await Accounts.FeedAccess.ReachableFeedsAsync(db, userId);
            return Results.Ok(spaceIds.Union(feeds).ToList());
        }).RequireAuthorization();

        // #569: every reached space with its head in one call: a round over ~25 spaces was ~25 requests,
        // and a burst of writes ran the rate limiter dry
        app.MapGet("/sync/heads", Heads).RequireAuthorization();

        app.MapGet("/sync/events", StreamEvents).RequireAuthorization();

        var group = app.MapGroup("/sync/{spaceId}").RequireAuthorization().WithSafeRouteParams();
        group.MapPost("/push", Push).WithValidation<PushRequest>();
        group.MapGet("/pull", Pull);
        group.MapGet("/bootstrap", Bootstrap);
    }

    /// the head each pull would report: the space's last seq, capped where only an archived attachment reaches a feed
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
        // #281: concurrent pushes (or a push racing the bank ingest) miss the row read and collide on a PK at save; a retry
        // re-reads what the winner committed and the LWW merge converges; without it the client saw 500s and hit the rate limiter
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
        var owner = true;
        if (space is null)
        {
            // feed ids are deterministic (uuidv5), so guessable from an IBAN: feeds are born only via POST /feeds (security review S1)
            if (Accounts.FeedAccess.IsFeedShaped(spaceId))
                return Results.Forbid();
            // #615: a space that was erased is never born again from a device that still held it
            if (await SpaceErasure.IsErasedAsync(db, spaceId)) return SpaceErasure.Gone();
            // first push creates the space with the pusher as owner (a lost create race lands in the member check on the retry)
            space = new Space { Id = spaceId };
            db.Spaces.Add(space);
            db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = userId, Role = Social.SpaceRoles.Owner });
        }
        else
        {
            var membership = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId);
            if (membership is null) return Results.Forbid();
            if (!Social.SpaceRoles.CanWrite(membership.Role)) return Social.SpaceRoles.ReadOnly();
            owner = Social.SpaceRoles.IsOwner(membership.Role);
        }

        var ops = SpaceErasure.Admitted(request.Ops, spaceId, owner);
        var writer = new SyncWriter(db);
        var (lastSeq, accepted) = await writer.ApplyAsync(space, userId, ops);
        // #615: out of reach in the same save as the delete itself; the rows go right after it
        var erase = await SpaceErasure.DeletedByAsync(db, spaceId, ops);
        if (erase) await SpaceErasure.SealAsync(db, spaceId);
        await db.SaveChangesAsync();
        if (erase) await SpaceErasure.EraseRowsAsync(db, spaceId);
        if (accepted > 0) events.Publish(spaceId);
        return Results.Ok(new PushResponse(lastSeq, accepted, request.Ops.Count - accepted));
    }

    private static async Task<IResult> Pull(string spaceId, long since, AppDbContext db, HttpContext http)
    {
        var cap = long.MaxValue;
        var member = await RequireMember(spaceId, db, http);
        if (member is not null)
        {
            // not a member: attachments may still give (possibly archive-capped) read access to a feed space
            var feedCap = await Accounts.FeedAccess.ReadCapAsync(db, http.GetUserId(), spaceId);
            if (feedCap is null) return await DeniedAsync(spaceId, db, member);
            cap = feedCap.Value;
        }

        var space = await db.Spaces.FindAsync(spaceId);
        // the sizes first (#630): a photo or an invoice is one op, and a page of a thousand of them is no download —
        // so the database hands over no more than the page that is sent
        var sizes = await PullSizes(db, spaceId, since, cap).ToListAsync();
        var fitting = Fitting(sizes.Select(s => s.Bytes), PullPageChars);
        var ops = fitting == 0
            ? []
            : await db.SyncOps
                .Where(o => o.SpaceId == spaceId && o.Seq > since && o.Seq <= sizes[fitting - 1].Seq)
                .OrderBy(o => o.Seq)
                .ToListAsync();
        var dtos = ops.Select(o => new SyncOpDto(
            o.OpId, o.SpaceId, o.Entity, o.EntityId,
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(o.PayloadJson) ?? new(),
            o.Hlc, o.Deleted)).ToList();
        // archived readers must not chase a cursor beyond their cap
        var nextSince = ops.Count > 0 ? ops[^1].Seq : since;
        return Results.Ok(new PullResponse(dtos, Math.Min(space?.LastSeq ?? 0, cap), Math.Min(nextSince, cap)));
    }

    internal const int PullPageOps = 1000;

    /// <summary>A pull's page ends where a snapshot's does.</summary>
    internal const int PullPageChars = SnapshotPageChars;

    internal sealed record OpSize(long Seq, int Bytes);

    internal static IQueryable<OpSize> PullSizes(AppDbContext db, string spaceId, long since, long cap) =>
        db.SyncOps.AsNoTracking()
            .Where(o => o.SpaceId == spaceId && o.Seq > since && o.Seq <= cap)
            .OrderBy(o => o.Seq)
            .Take(PullPageOps)
            .Select(o => new OpSize(o.Seq, DbText.OctetLength(o.PayloadJson)));

    /// <summary>How many of the first sizes fit a page: at least the first, however large it is.</summary>
    internal static int Fitting(IEnumerable<int> sizes, int limit)
    {
        var count = 0;
        long total = 0;
        foreach (var size in sizes)
        {
            if (count > 0 && total + size > limit) break;
            total += size;
            count++;
        }
        return count;
    }

    internal const int SnapshotPageRows = 2000;

    /// a page also ends once its rows' data passes this size (a picture is tens of thousands of characters),
    /// so one request stays a download a phone finishes within the app's per-request limit
    internal const int SnapshotPageChars = 2_000_000;

    internal static IQueryable<int> SnapshotSizes(IQueryable<EntityRow> rows) => rows.Select(r => DbText.OctetLength(r.DataJson));

    /// <summary>The longest <c>after</c> a page can have named: an entity's name, the colon, an entity id.</summary>
    private const int SnapshotCursorMaximum = 64 + 1 + 128;

    /// ordered by primary key, so the database walks one index from where the page before ended
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
            if (feedCap is null) return await DeniedAsync(spaceId, db, member);
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
        // the sizes first (#630): a feed of invoices was read whole for every page of it that was sent
        var sizes = await SnapshotSizes(SnapshotRowsAfter(db, spaceId, last).Take(SnapshotPageRows + 1)).ToListAsync();
        var fitting = Fitting(sizes.Take(SnapshotPageRows), SnapshotPageChars);
        var rows = fitting == 0 ? [] : await SnapshotRowsAfter(db, spaceId, last).Take(fitting).ToListAsync();

        var page = rows.Select(row => new BootstrapRow(
            row.Entity, row.EntityId, row.Deleted,
            JsonSerializer.Deserialize<JsonElement>(row.DataJson),
            JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new())).ToList();
        var next = page.Count > 0 && fitting < sizes.Count ? $"{page[^1].Entity}:{page[^1].EntityId}" : null;
        return Results.Ok(new BootstrapResponse(page, head, next));
    }

    /// #615: an erased space answers 403 space-deleted; a device then drops its copy without a word of "removed"
    private static async Task<IResult> DeniedAsync(string spaceId, AppDbContext db, IResult denied) =>
        await SpaceErasure.IsErasedAsync(db, spaceId) ? SpaceErasure.Gone() : denied;

    private static async Task<IResult?> RequireMember(string spaceId, AppDbContext db, HttpContext http)
    {
        var userId = http.GetUserId();
        var isMember = await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == userId);
        return isMember ? null : Results.Forbid();
    }

    private static async Task StreamEvents(AppDbContext db, SpaceEventBroadcaster events, HttpContext http)
    {
        var userId = http.GetUserId();
        // membership snapshot at connect; new invites are picked up on reconnect (the 10s poll covers the gap)
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
                    // no events for a while: the keepalive comment holds proxies open
                }

                var frame = FrameFor(evt, userId, mySpaces);
                if (frame is null) continue;
                await http.Response.WriteAsync(frame, http.RequestAborted);
                await http.Response.Body.FlushAsync(http.RequestAborted);
            }
        }
        catch (OperationCanceledException)
        {
            // client went away: normal for a long-lived stream
        }
        finally
        {
            events.Unsubscribe(id);
        }
    }

    internal static string? FrameFor(SyncEvent? evt, Guid userId, HashSet<string> mySpaces)
    {
        if (evt is null) return ": keepalive\n\n";
        if (evt.UserId is { } target) return target == userId && evt.Json is not null ? $"data: {evt.Json}\n\n" : null;
        if (evt.SpaceId is null || !mySpaces.Contains(evt.SpaceId)) return null;
        return $"data: {JsonSerializer.Serialize(new { spaceId = evt.SpaceId })}\n\n";
    }
}
