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

/// two asymmetric legs: the agent's is outbound (POSTs frames, long-polls input) so nothing dials into a home machine
/// all in LiveChannel memory: no frame or keystroke reaches a table, the custody argument for streaming a login
/// both groups have HTTP logging off, so any body logger and any new live route skip the frame bytes
internal static class LiveEndpoints
{
    /// the consumer's half, resolved like the still relay's image route: session, its run in flight, then the challenge
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

            // a long poll woken by the agent's POST: a timer would lag a frame or mostly be told nothing changed
            while (!ct.IsCancellationRequested)
            {
                if (channel.Frame(job.Id) is { } frame && frame.Sequence > after)
                {
                    http.Response.Headers[LiveHeaders.Sequence] = LiveHeaders.FormatSequence(frame.Sequence);
                    http.Response.Headers[LiveHeaders.Size] = LiveHeaders.FormatSize(frame.Width, frame.Height);

                    // omitted, not blank, when unknown, so the consumer says so
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

            // not the current frame again: resending what the consumer already shows costs bandwidth for nothing
            return Results.NoContent();
        })
        // 204 is the normal outcome: a long poll that timed out with no newer frame
        .Produces<byte[]>(StatusCodes.Status200OK, "image/jpeg")
        .Produces(StatusCodes.Status204NoContent);

        // the same pictures pushed (#429); refused before the first byte like the poll, so statuses keep
        // a consumer that cannot stream still has the poll
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

            // accepted, not applied: whether the page did anything shows in the next frame
            return Results.Accepted();
        })
        .Produces(StatusCodes.Status202Accepted);
    }

    /// the agent's half, inside the authenticated agent group and behind the same lease check as the other job routes
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
                // re-normalised, not taken as sent: the agent is a separate process out of our control
                // and this string is shown as grounds for typing a password
                Origin = LiveHeaders.ReadOrigin(http.Request),
            });

            // only a frame that is now wakes waiting consumers; a POST that overtook a newer picture has nothing to tell them
            if (kept) signals.Signal(ConnectorSignals.LiveFrame(jobId));

            // 200 either way: a stale frame is the network's fault, and an error would make the agent retry an outdated photograph
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
        // 204 is the quiet case: nobody touched the page during the window
        .Produces<LiveInputBatch>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status204NoContent);
    }

    /// resolved through the session so another's challenge is not found; once answered or expired, no pixels leave
    /// RequireAnswerable: checked once at the edge; the navigation vocabulary (#441 L3) is the operator's explore run only
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

    private sealed record LiveLookup(string Provider, string SessionId, string ChallengeId, string Subject);

    private sealed record LiveRows(
        IProviderRegistry Registry, SessionService Sessions, ChallengeService Challenges, ViewBuilder Views, TimeProvider Time);

    private sealed record LivePipe(LiveChannel Channel, ConnectorDbContext Db, ConnectorTimeouts Timeouts);

    /// every refusal happens before the first byte so it keeps its status and envelope
    /// after it nothing throws (see EventStream)
    private static async Task<IResult> StreamAsync(
        HttpContext http, LiveLookup lookup, LiveRows rows, LivePipe pipe, CancellationToken ct)
    {
        var (job, expiresAt) = await RequireLiveRunAsync(lookup, rows, ct);
        var after = LiveStream.After(http.Request);
        var time = rows.Time;
        var keepAlive = TimeSpan.FromSeconds(Math.Max(1, pipe.Timeouts.LiveStreamKeepAliveSeconds));

        http.Response.Headers.ContentType = LiveStream.ContentType;
        http.Response.Headers.CacheControl = LiveHeaders.NoStore;
        // nginx, the NAS's reverse proxy included, holds a proxied response until its buffer fills unless told not to
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

    private static async Task<bool> TickAsync(
        HttpResponse response, StreamState stream, LiveLookup lookup, LiveRows rows, LivePipe pipe, CancellationToken ct)
    {
        var time = rows.Time;
        var now = time.GetUtcNow();

        // the challenge's own clock ends the view; the response's limit only closes it
        // the consumer reconnects past the frame it drew
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
            // a terminal state drops the run's entry, so the rows are read now rather than at the next tick
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
        // one context for the whole response: otherwise re-read rows are the tracked copies
        // and an answered challenge never reads as answered
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

        // a session no longer signing in has no live view, checked before the job lookup: the post-login fetch becomes
        // the latest run, the challenge read "unknown" (unsupported_resource) and a working sign-in looked like a broken provider
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

    /// capped well under the poll window so a missed signal costs a fraction of a second
    /// at a dozen frames a second that is a live view versus a slideshow
    private static TimeSpan Slice(TimeSpan remaining) =>
        remaining < Fallback ? remaining : Fallback;

    private static readonly TimeSpan Fallback = TimeSpan.FromMilliseconds(500);
}
