#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Live;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// The streamed login's five routes: pictures out, pointer and keys back.
///
/// Two legs, and they are not symmetric. The agent's leg is outbound like
/// every other agent call - it POSTs the picture it just took and long-polls
/// for what the human has done since - so nothing has to dial in to a machine
/// on somebody's home line. The consumer's leg is one pushed stream of frames
/// (or, where a stream cannot be held, a long-poll for the newest one) and a
/// POST of what its owner did to it. The consumer is munni's API, never a
/// device: the app reaches these routes only through the relay (#429).
///
/// Everything both legs touch lives in <see cref="LiveChannel"/> and therefore
/// in memory. No frame and no keystroke reaches a table, which is the whole
/// custody argument for streaming a login rather than collecting a password in
/// a form.
///
/// Both groups are declared with HTTP logging off. That is the structural half
/// of "the frame bytes are never logged": any body logger added to this
/// service later - the framework's own, or anything that honours its metadata -
/// is already told to skip these endpoints, and a new live route added to
/// either group inherits the refusal rather than needing somebody to remember
/// it.
/// </summary>
internal static class LiveEndpoints
{
    /// <summary>
    /// The consumer's half, beside the still relay's image route and resolved
    /// exactly the way it is: the session, then its run in flight, then the
    /// challenge scoped to that run.
    /// </summary>
    public static void MapConsumer(IEndpointRouteBuilder api)
    {
        var live = api.MapGroup("/{provider}/login/{sessionId}/challenges/{challengeId}/live")
            .WithHttpLogging(HttpLoggingFields.None);

        live.MapGet("/frame", async (
            HttpContext http,
            string provider,
            string sessionId,
            string challengeId,
            IProviderRegistry registry,
            SessionService sessions,
            ChallengeService challenges,
            ViewBuilder views,
            LiveChannel channel,
            ConnectorSignals signals,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var job = await RequireLiveJobAsync(
                provider, sessionId, challengeId, RequestContext.RequireSubject(http),
                registry, sessions, challenges, views, time, ct);

            var after = LiveHeaders.After(http.Request);
            var deadline = time.GetUtcNow().AddSeconds(options.Value.Timeouts.LiveFramePollSeconds);

            // A long poll rather than a fixed-interval refetch, woken by the
            // agent's POST. A consumer polling on a timer would either be
            // permanently a frame behind or spend most of its requests being
            // told nothing changed, and neither is a login somebody can type
            // into.
            while (!ct.IsCancellationRequested)
            {
                if (channel.Frame(job.Id) is { } frame && frame.Sequence > after)
                {
                    http.Response.Headers[LiveHeaders.Sequence] = LiveHeaders.FormatSequence(frame.Sequence);
                    http.Response.Headers[LiveHeaders.Size] = LiveHeaders.FormatSize(frame.Width, frame.Height);

                    // Omitted rather than blank when unknown, so the consumer
                    // says so instead of showing an empty reassurance.
                    if (frame.Origin is { Length: > 0 } origin)
                    {
                        http.Response.Headers[LiveHeaders.Origin] = origin;
                    }

                    http.Response.Headers.CacheControl = LiveHeaders.NoStore;
                    return Results.File(frame.Bytes, LiveHeaders.Jpeg);
                }

                var remaining = deadline - time.GetUtcNow();
                if (remaining <= TimeSpan.Zero) break;

                await signals.WaitAsync(ConnectorSignals.LiveFrame(job.Id), Slice(remaining), ct);
            }

            // Nothing newer than what the caller already has. Deliberately not
            // the current frame again: re-sending a picture the consumer is
            // already showing costs its bandwidth to change nothing.
            return Results.NoContent();
        })
        // Both outcomes, because 204 is the normal one: a long poll that timed
        // out with no newer frame is this route working, not failing.
        .Produces<byte[]>(StatusCodes.Status200OK, "image/jpeg")
        .Produces(StatusCodes.Status204NoContent);

        // The same pictures pushed (#429): one response per live view rather
        // than one request per frame. Refused before the first byte exactly as
        // the poll is, so "over", "not yours" and "no such" keep their statuses
        // and a consumer that cannot stream still has the poll beside it.
        live.MapGet("/stream", (
            HttpContext http,
            string provider,
            string sessionId,
            string challengeId,
            IProviderRegistry registry,
            SessionService sessions,
            ChallengeService challenges,
            ViewBuilder views,
            LiveChannel channel,
            ConnectorDbContext db,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) => StreamAsync(
                http,
                new LiveLookup(provider, sessionId, challengeId, RequestContext.RequireSubject(http)),
                new LiveRows(registry, sessions, challenges, views, time),
                new LivePipe(channel, db, options.Value.Timeouts),
                ct))
        .Produces<LiveStreamFrame>(StatusCodes.Status200OK, LiveStream.ContentType);

        live.MapPost("/input", async (
            HttpContext http,
            string provider,
            string sessionId,
            string challengeId,
            LiveInputBatch batch,
            IProviderRegistry registry,
            SessionService sessions,
            ChallengeService challenges,
            ViewBuilder views,
            LiveChannel channel,
            ConnectorSignals signals,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var job = await RequireLiveJobAsync(
                provider, sessionId, challengeId, RequestContext.RequireSubject(http),
                registry, sessions, challenges, views, time, ct);

            RequireAnswerable(batch, job);

            channel.Enqueue(job.Id, batch);
            signals.Signal(ConnectorSignals.LiveInput(job.Id));

            // Accepted, not applied. Whether the page did anything with it is
            // the next frame's business, and claiming otherwise would be a
            // promise this side of the wire cannot keep.
            return Results.Accepted();
        })
        // 202 and nothing else, which is the promise: accepted, not applied.
        .Produces(StatusCodes.Status202Accepted);
    }

    /// <summary>
    /// The agent's half, inside the authenticated agent group and behind the
    /// same lease check as every other job-scoped agent route.
    /// </summary>
    public static void MapAgent(IEndpointRouteBuilder agents)
    {
        var live = agents.MapGroup("/jobs/{jobId}/live")
            .WithHttpLogging(HttpLoggingFields.None);

        live.MapPost("/frame", async (
            HttpContext http,
            string jobId,
            LiveChannel channel,
            ConnectorSignals signals,
            ConnectorDbContext db,
            CancellationToken ct) =>
        {
            var agent = http.RequireAgent();
            await AgentApiEndpoints.RequireLeasedAsync(db, jobId, agent.Id, ct);

            var sequence = LiveHeaders.RequireSequence(http.Request);
            var (width, height) = LiveHeaders.RequireSize(http.Request);
            var bytes = await LiveHeaders.ReadFrameAsync(http.Request, ct);

            var kept = channel.Publish(jobId, new LiveFrame
            {
                Sequence = sequence,
                Width = width,
                Height = height,
                Bytes = bytes,
                // Re-normalised on the way in, not taken as sent. The agent is
                // a separate process on a machine this side does not control,
                // and this string is about to be shown to somebody as grounds
                // for typing a password.
                Origin = LiveHeaders.ReadOrigin(http.Request),
            });

            // Only a frame that is actually now wakes the consumers waiting
            // for one; a POST that overtook a newer picture has nothing to
            // tell them.
            if (kept) signals.Signal(ConnectorSignals.LiveFrame(jobId));

            // 200 either way. A stale frame is the network's fault, not the
            // agent's, and an error here would make an agent retry a
            // photograph that is already out of date.
            return Results.Ok();
        })
        .Produces(StatusCodes.Status200OK);

        live.MapGet("/input", async (
            HttpContext http,
            string jobId,
            LiveChannel channel,
            ConnectorSignals signals,
            ConnectorDbContext db,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var agent = http.RequireAgent();
            await AgentApiEndpoints.RequireLeasedAsync(db, jobId, agent.Id, ct);

            var after = LiveHeaders.After(http.Request);
            var deadline = time.GetUtcNow().AddSeconds(options.Value.Timeouts.AgentPollSeconds);

            while (!ct.IsCancellationRequested)
            {
                var pending = channel.Collect(jobId, after);
                if (pending.Events.Count > 0) return ConnectorResults.Json(pending);

                var remaining = deadline - time.GetUtcNow();
                if (remaining <= TimeSpan.Zero) break;

                await signals.WaitAsync(ConnectorSignals.LiveInput(jobId), Slice(remaining), ct);
            }

            return Results.NoContent();
        })
        // As with the consumer's frame poll, 204 is the quiet case rather than
        // the broken one: nobody touched the page during the window.
        .Produces<LiveInputBatch>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status204NoContent);
    }

    /// <summary>
    /// The run behind a live challenge, or a refusal.
    ///
    /// Resolved through the session rather than from the job id, exactly as
    /// the still relay's image route is: a challenge is looked up scoped to
    /// the session's own run, so one belonging to somebody else's login is
    /// simply not found rather than found and then judged.
    ///
    /// Three separate refusals, because they mean different things to the
    /// consumer. A challenge that is not a live view is a caller asking a
    /// still picture to be a stream. One that has been answered or has expired
    /// is gone: the live view's terminal marker is what the adapter's success
    /// signal writes, so refusing here is where the agent's latch stops being
    /// a property of one loop on one machine and becomes a fact the control
    /// plane enforces - after it, no further pixels leave and no further
    /// keystroke is accepted, whatever the frame loop is still doing.
    /// </summary>
    /// <summary>
    /// Once, here, at the edge. Everything downstream - the queue, the poll,
    /// the agent's dispatcher - is entitled to assume a batch it holds is
    /// answerable, and a second opinion further in would be a second
    /// definition of what a legal gesture is. The navigation vocabulary
    /// (#441 L3) exists for the operator's explore run and nowhere else: a
    /// person's streamed login goes where the provider sends it, never where
    /// a relayed event says.
    /// </summary>
    private static void RequireAnswerable(LiveInputBatch batch, JobRow job)
    {
        if (!batch.IsWellFormed())
        {
            throw ConnectorException.InvalidRequest("this live input batch is not answerable");
        }

        if (batch.Navigates() && !string.Equals(job.ProviderId, Connector.Kit.Exploring.ExploreProvider.Id, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest("navigation is the explore run's alone");
        }
    }

    private static async Task<JobRow> RequireLiveJobAsync(
        string provider,
        string sessionId,
        string challengeId,
        string subject,
        IProviderRegistry registry,
        SessionService sessions,
        ChallengeService challenges,
        ViewBuilder views,
        TimeProvider time,
        CancellationToken ct) =>
        (await RequireLiveRunAsync(
            new LiveLookup(provider, sessionId, challengeId, subject),
            new LiveRows(registry, sessions, challenges, views, time),
            ct)).Job;

    /// <summary>What a live route is asked about: the run's coordinates and whose they are.</summary>
    private sealed record LiveLookup(string Provider, string SessionId, string ChallengeId, string Subject);

    /// <summary>What a live route reads them with.</summary>
    private sealed record LiveRows(
        IProviderRegistry Registry, SessionService Sessions, ChallengeService Challenges, ViewBuilder Views, TimeProvider Time);

    /// <summary>What the pushed stream reads its pictures from, re-reads its rows with, and is timed by.</summary>
    private sealed record LivePipe(LiveChannel Channel, ConnectorDbContext Db, ConnectorTimeouts Timeouts);

    /// <summary>
    /// The pushed live view: frames as they are published, a keep-alive in
    /// the quiet, <c>end</c> when the run says the view is over.
    ///
    /// Everything that can refuse happens before the first byte, so a refusal
    /// keeps its status and envelope. After it nothing throws back at the
    /// framework: a consumer that goes away is the ordinary end of a stream,
    /// and a write onto a response whose headers are long gone would bury the
    /// cause (see <see cref="EventStream"/>).
    /// </summary>
    private static async Task<IResult> StreamAsync(
        HttpContext http, LiveLookup lookup, LiveRows rows, LivePipe pipe, CancellationToken ct)
    {
        var (job, expiresAt) = await RequireLiveRunAsync(lookup, rows, ct);
        var after = LiveStream.After(http.Request);
        var time = rows.Time;
        var keepAlive = TimeSpan.FromSeconds(Math.Max(1, pipe.Timeouts.LiveStreamKeepAliveSeconds));

        http.Response.Headers.ContentType = LiveStream.ContentType;
        http.Response.Headers.CacheControl = LiveHeaders.NoStore;
        // nginx - the NAS's reverse proxy among them - holds a proxied response
        // until its buffer fills unless the upstream says not to
        http.Response.Headers["X-Accel-Buffering"] = "no";
        http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        var now = time.GetUtcNow();
        var stream = new StreamState
        {
            JobId = job.Id,
            After = after,
            ExpiresAt = expiresAt,
            CloseAt = Earliest(now.AddSeconds(Math.Max(1, pipe.Timeouts.LiveStreamSeconds)), expiresAt),
            KeepAlive = keepAlive,
            LastWrite = now,
            RecheckAt = now + LiveStream.RecheckEvery,
        };

        try
        {
            await LiveStream.WriteAsync(http.Response, LiveStream.Retry, ct);
            while (!ct.IsCancellationRequested && await TickAsync(http.Response, stream, lookup, rows, pipe, ct))
            {
                // one frame, one keep-alive or one look at the rows per tick
            }
        }
        catch (OperationCanceledException)
        {
            // The consumer went, or the host is stopping.
        }
        catch (IOException)
        {
            // The socket went while a frame was half written.
        }

        return Results.Empty;
    }

    /// <summary>Where one pushed stream stands between ticks.</summary>
    private sealed class StreamState
    {
        public required string JobId { get; init; }

        public required DateTimeOffset ExpiresAt { get; init; }

        public required DateTimeOffset CloseAt { get; init; }

        public required TimeSpan KeepAlive { get; init; }

        public long After { get; set; }

        public DateTimeOffset LastWrite { get; set; }

        public DateTimeOffset RecheckAt { get; set; }
    }

    /// <summary>One step of a pushed stream; false once the stream is over.</summary>
    private static async Task<bool> TickAsync(
        HttpResponse response, StreamState stream, LiveLookup lookup, LiveRows rows, LivePipe pipe, CancellationToken ct)
    {
        var time = rows.Time;
        var now = time.GetUtcNow();

        // The challenge's own clock ends the view; the response's own limit
        // only closes it, and the consumer reconnects past the frame it drew.
        if (now >= stream.ExpiresAt) return await EndAsync(response, ErrorCode.ChallengeExpired, ct);
        if (now >= stream.CloseAt) return false;

        if (now >= stream.RecheckAt)
        {
            if (await RefusalAsync(lookup, rows, pipe.Db, ct) is { } over) return await EndAsync(response, over, ct);
            stream.RecheckAt = time.GetUtcNow() + LiveStream.RecheckEvery;
        }

        var keepAliveAt = stream.LastWrite + stream.KeepAlive;
        if (now >= keepAliveAt)
        {
            await LiveStream.WriteAsync(response, LiveStream.KeepAlive, ct);
            stream.LastWrite = time.GetUtcNow();
            return true;
        }

        var window = Earliest(Earliest(keepAliveAt, stream.RecheckAt), stream.CloseAt) - now;
        var wait = await pipe.Channel.NextFrameAsync(stream.JobId, stream.After, window > MinWait ? window : MinWait, ct);

        if (wait.Frame is { } frame)
        {
            await LiveStream.WriteAsync(response, LiveStream.Frame(frame), ct);
            stream.After = frame.Sequence;
            stream.LastWrite = time.GetUtcNow();
        }
        else if (wait.Ended)
        {
            // The run's entry went - a terminal state drops it - so the rows
            // are read now rather than at the next tick.
            stream.RecheckAt = time.GetUtcNow();
        }

        return true;
    }

    private static async Task<bool> EndAsync(HttpResponse response, ErrorCode code, CancellationToken ct)
    {
        await LiveStream.WriteAsync(response, LiveStream.End(code), ct);
        return false;
    }

    /// <summary>The code the frame route would refuse with now, or null while the view is still live.</summary>
    private static async Task<ErrorCode?> RefusalAsync(LiveLookup lookup, LiveRows rows, ConnectorDbContext db, CancellationToken ct)
    {
        // One context for the length of the response: without this the rows
        // read a second time are the tracked copies of the first, and a
        // challenge answered since would never read as answered.
        db.ChangeTracker.Clear();

        try
        {
            await RequireLiveRunAsync(lookup, rows, ct);
            return null;
        }
        catch (ConnectorException ex)
        {
            return ex.Code;
        }
    }

    private static DateTimeOffset Earliest(DateTimeOffset a, DateTimeOffset b) => a <= b ? a : b;

    private static readonly TimeSpan MinWait = TimeSpan.FromMilliseconds(10);

    private static async Task<(JobRow Job, DateTimeOffset ExpiresAt)> RequireLiveRunAsync(
        LiveLookup lookup, LiveRows rows, CancellationToken ct)
    {
        var (provider, sessionId, challengeId, subject) = lookup;
        var (registry, sessions, challenges, views, time) = rows;

        var manifest = registry.RequireManifest(provider);
        var session = await sessions.RequireAsync(manifest.Id, sessionId, subject, ct);

        // A session that is no longer signing in has no live view, whatever
        // rows outlive it. Checked before the job lookup rather than after,
        // because a successful login is normally followed by a fetch - and
        // that fetch becomes the session's latest run, so the challenge is
        // simply not on it and the caller was told "unknown challenge", which
        // travels as `unsupported_resource`. A consumer renders that as "this
        // provider does not offer that", so a sign-in that had just worked
        // perfectly presented itself as a broken provider.
        if (session.State is not (SessionState.Queued or SessionState.Running or SessionState.AwaitingInput))
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, "this live view is over");
        }

        var job = await views.LatestJobAsync(session.Id, ct)
                  ?? throw ConnectorException.Unsupported("this session has no run in flight");

        var challenge = await challenges.FindAsync(challengeId, job.Id, ct)
                        ?? throw ConnectorException.Unsupported($"unknown challenge '{challengeId}'");

        if (challenge.Type != ChallengeType.LiveView)
        {
            throw ConnectorException.Unsupported($"challenge '{challengeId}' is not a live view");
        }

        if (challenge.AnsweredAt is not null || challenge.ExpiresAt <= time.GetUtcNow())
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, $"live view '{challengeId}' is over");
        }

        return (job, challenge.ExpiresAt);
    }

    /// <summary>
    /// How long to sleep between checks when no signal arrives.
    ///
    /// Capped well under the poll window so a signal missed on a busy instance
    /// costs a fraction of a second rather than the whole wait - which at a
    /// dozen frames a second is the difference between a live view and a
    /// slideshow.
    /// </summary>
    private static TimeSpan Slice(TimeSpan remaining) =>
        remaining < Fallback ? remaining : Fallback;

    private static readonly TimeSpan Fallback = TimeSpan.FromMilliseconds(500);
}
