#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Hosting.Tickets;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Sessions;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// Connecting, driving an interactive login, and disconnecting.
///
/// One generic handler for every provider. Adding a provider is a manifest
/// plus an adapter, never a controller - which is the only way a consumer can
/// render a login form it has never seen and have it work.
/// </summary>
internal static class LoginEndpoints
{
    public static void Map(IEndpointRouteBuilder api, ConnectorPlatformOptions platform)
    {
        api.MapPost("/{provider}/login", (
            HttpContext http,
            string provider,
            LoginRequest request,
            IProviderRegistry registry,
            ProviderStatusService statuses,
            SessionService sessions,
            ILeasedJobQueue queue,
            IInlineJobRunner inline,
            ConnectorDbContext db,
            ViewBuilder views,
            ConnectorSignals signals,
            IIdempotencyStore idempotency,
            SyncInterval interval,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) => LoginAsync(
                http, provider, request, platform, registry, statuses, sessions, queue, inline, db, views,
                signals, idempotency, interval, options, time, ct))
        // The same body under two statuses, which is the contract: 200 means
        // the bundle is in your hands, 202 means poll or subscribe. A consumer
        // that only reads the 200 shape never learns the second exists.
        .Produces<SessionResponse>(StatusCodes.Status200OK)
        .Produces<SessionResponse>(StatusCodes.Status202Accepted);

        api.MapGet("/{provider}/login/{sessionId}", (
            HttpContext http,
            string provider,
            string sessionId,
            IProviderRegistry registry,
            SessionService sessions,
            ViewBuilder views,
            CancellationToken ct) => GetSessionAsync(http, provider, sessionId, registry, sessions, views, ct));

        api.MapGet("/{provider}/login/{sessionId}/events", (
            HttpContext http,
            string provider,
            string sessionId,
            IProviderRegistry registry,
            SessionService sessions,
            ViewBuilder views,
            ConnectorSignals signals,
            ConnectorDbContext db,
            CancellationToken ct) => StreamSessionAsync(
                http, provider, sessionId, registry, sessions, views, signals, db, ct))
        // A stream of the same view the poll returns, one per event. Naming the
        // frame type is the only thing that makes the stream readable: the
        // status alone would say a session subscription returns nothing.
        .Produces<SessionResponse>(StatusCodes.Status200OK, "text/event-stream");

        api.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/image", (
            HttpContext http,
            string provider,
            string sessionId,
            string challengeId,
            IProviderRegistry registry,
            SessionService sessions,
            ChallengeService challenges,
            ViewBuilder views,
            CancellationToken ct) => ChallengeImageAsync(
                http, provider, sessionId, challengeId, registry, sessions, challenges, views, ct))
        .Produces<byte[]>(StatusCodes.Status200OK, "image/png");

        api.MapPost("/{provider}/login/{sessionId}/answer", (
            HttpContext http,
            string provider,
            string sessionId,
            AnswerRequest request,
            IProviderRegistry registry,
            SessionService sessions,
            ChallengeService challenges,
            ViewBuilder views,
            CancellationToken ct) => AnswerAsync(
                http, provider, sessionId, request, registry, sessions, challenges, views, ct));

        api.MapPost("/{provider}/login/{sessionId}/cancel", (
            HttpContext http,
            string provider,
            string sessionId,
            IProviderRegistry registry,
            SessionService sessions,
            JobOutcomeService outcomes,
            ViewBuilder views,
            CancellationToken ct) => CancelAsync(http, provider, sessionId, registry, sessions, outcomes, views, ct));

        api.MapPost("/{provider}/sessions/resume", (
            HttpContext http,
            string provider,
            ResumeRequest request,
            IProviderRegistry registry,
            ProviderStatusService statuses,
            SessionService sessions,
            ITicketStore tickets,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) => ResumeAsync(
                http, provider, request, registry, statuses, sessions, tickets, options, time, ct));

        api.MapDelete("/{provider}/sessions/{sessionId}", (
            HttpContext http,
            string provider,
            string sessionId,
            // Explicit, because a body is never INFERRED on DELETE - minimal
            // APIs refuse it outright, and the host will not start.
            [FromBody] DisconnectRequest? request,
            IProviderRegistry registry,
            SessionService sessions,
            ILeasedJobQueue queue,
            IInlineJobRunner inline,
            ConnectorDbContext db,
            ILoggerFactory loggers,
            CancellationToken ct) => DisconnectAsync(
                http, provider, sessionId, request, registry, sessions, queue, inline, db, loggers, ct))
        .Produces<DisconnectResponse>(StatusCodes.Status200OK);
    }

    private static async Task<IResult> LoginAsync(
        HttpContext http,
        string provider,
        LoginRequest request,
        ConnectorPlatformOptions platform,
        IProviderRegistry registry,
        ProviderStatusService statuses,
        SessionService sessions,
        ILeasedJobQueue queue,
        IInlineJobRunner inline,
        ConnectorDbContext db,
        ViewBuilder views,
        ConnectorSignals signals,
        IIdempotencyStore idempotency,
        SyncInterval interval,
        IOptions<ConnectorOptions> options,
        TimeProvider time,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

        await RequireWorkAcceptedAsync(statuses, manifest, ct);
        var deviceClass = RequestContext.DeviceClassOf(http);
        RequireConsent(platform, request.Consent);
        RequestContext.RequireSubjectAgreement(http, request.Subject);
        await interval.RequireElapsedAsync(
            RequestContext.TriggerOf(http), manifest, request.Subject, JobKind.Login, resourceId: null, ct);

        var inputs = ValidatedInputs(sessions, manifest, request);

        // A caller that timed out and retried gets the run it already
        // started, not a second one. Starting a second login would submit
        // the same credential again and spend one of the provider's
        // attempts on a request the user only made once.
        var idempotencyScope = $"login:{manifest.Id}:{request.Subject}";
        var idempotencyKey = RequestContext.IdempotencyKey(http);
        if (idempotencyKey is not null && idempotency.TryGet(idempotencyScope, idempotencyKey, out var replayed))
        {
            return await ReplayAsync(sessions, views, manifest, replayed, request.Subject, ct);
        }

        // WHICH OF THE THREE ANSWERS ARRIVED, read once and in one place.
        // `prefer_agent` carries an agent id, the reserved word for the
        // operator's fleet, or nothing; everything below turns on which,
        // and a second reading of the same string is how two paths come to
        // disagree about it.
        var fleetRequested = RunOn.IsFleet(request.PreferAgent);
        var namedAgent = RunOn.IsAgentId(request.PreferAgent) ? request.PreferAgent : null;

        // BEFORE THE PROFILE IS RESOLVED, so a refused login leaves
        // nothing behind: pinning one writes a ProfileRow, and a pin for a
        // connection that was then turned away is a row naming a browser
        // directory nobody ever opened.
        await RequireFleetCanServeAsync(db, manifest, fleetRequested, inline, options.Value, time, ct);
        await RequireReachableEgressAsync(db, manifest, request.Subject, options.Value, time, ct);

        var profileId = await ResolveProfileAsync(
            db, manifest, namedAgent, request.Subject, options.Value, time, ct);

        var session = await sessions.CreateAsync(new NewSession
        {
            ProviderId = manifest.Id,
            Subject = request.Subject,
            DeviceClass = deviceClass,
            Config = request.Config,
            Label = request.Label,
            ConsentAcceptedAt = request.Consent?.AcceptedAt,
            ConsentTermsVersion = request.Consent?.TermsVersion,
            PreferAgent = namedAgent,
            FleetOnly = fleetRequested,
            ProfileId = profileId,
        }, ct);

        if (idempotencyKey is not null) idempotency.Remember(idempotencyScope, idempotencyKey, session.Id);

        await StartLoginJobAsync(
            sessions, queue, inline, session, manifest, inputs, request.Config, profileId, fleetRequested, ct);

        // A short wait, not a long one. An HTTP-tier provider usually
        // finishes inside it and the caller gets its bundle in one round
        // trip; anything slower has SSE and a poll URL, and holding a
        // socket open for a two-minute bank login helps nobody.
        await WaitForSettleAsync(db, session.Id, signals,
            TimeSpan.FromSeconds(options.Value.Timeouts.LoginWaitSeconds), time, ct);

        return await SettledResponseAsync(db, views, session.Id, ct);
    }

    /// <summary>
    /// The login's inputs, resolved and held to the manifest.
    /// </summary>
    private static IReadOnlyDictionary<string, string> ValidatedInputs(
        SessionService sessions, ProviderManifest manifest, LoginRequest request)
    {
        // What the human typed, or what their device kept from the last
        // time they typed it. Redeemed before validation, never after: the
        // manifest's own rules then apply to a stored bundle exactly as
        // they apply to a posted form, so one cannot smuggle a field the
        // provider never declared.
        var inputs = request.Inputs.Count == 0 && request.CredentialBundle is { Length: > 0 } stored
            ? sessions.OpenCredentials(manifest.Id, request.Subject, stored)
            : request.Inputs;

        AuthInputValidator.ValidateConfig(manifest, request.Config);
        AuthInputValidator.ValidateInputs(manifest, inputs);
        return inputs;
    }

    /// <summary>
    /// The run a retried caller already started, under the status its state
    /// has earned: 200 once the bundle is in their hands, 202 until then.
    /// </summary>
    private static async Task<IResult> ReplayAsync(
        SessionService sessions,
        ViewBuilder views,
        ProviderManifest manifest,
        string sessionId,
        string subject,
        CancellationToken ct)
    {
        var already = await sessions.RequireAsync(manifest.Id, sessionId, subject, ct);
        var replay = await views.SessionAsync(already, deliverBundle: true, ct);
        return ConnectorResults.Json(replay, already.State == SessionState.Active
            ? StatusCodes.Status200OK
            : StatusCodes.Status202Accepted);
    }

    /// <summary>
    /// Marks the session running, then queues the login job that will run it.
    /// </summary>
    private static async Task StartLoginJobAsync(
        SessionService sessions,
        ILeasedJobQueue queue,
        IInlineJobRunner inline,
        SessionRow session,
        ProviderManifest manifest,
        IReadOnlyDictionary<string, string> inputs,
        IReadOnlyDictionary<string, string> config,
        string? profileId,
        bool fleetRequested,
        CancellationToken ct)
    {
        // RUNNING BEFORE THE JOB EXISTS, and the order is the whole point.
        //
        // This used to enqueue first and mark the session running after, so
        // a job that started immediately could raise its challenge - moving
        // the session to awaiting_input - before that write landed. Since
        // awaiting_input to running is a legal edge, the write then went
        // through and put the session BACK, leaving it reporting `running`
        // while holding an unanswered challenge and a progress step reading
        // `awaiting_human`. Nobody polling for state ever learns they have
        // to ask the human anything, and the login sits there until it
        // expires.
        //
        // Caught by an intermittent test failure that only reproduces under
        // load, which is the only way a race like this surfaces at all.
        await sessions.StartAsync(session, ct);

        await queue.EnqueueAsync(new NewJob
        {
            SessionId = session.Id,
            ProviderId = manifest.Id,
            Kind = JobKind.Login,
            Inputs = inputs,
            Config = config,
            ProfileId = profileId,
            FleetOnly = fleetRequested,
        }, ct);

        if (inline.CanRun(manifest)) inline.Dispatch();
    }

    /// <summary>
    /// Whatever is true once the wait is over: the bundle, the failure that
    /// ended the run, or a handle to keep following it.
    /// </summary>
    private static async Task<IResult> SettledResponseAsync(
        ConnectorDbContext db, ViewBuilder views, string sessionId, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        var settled = await db.Sessions.FirstAsync(s => s.Id == sessionId, ct);
        var view = await views.SessionAsync(settled, deliverBundle: true, ct);

        if (settled.State == SessionState.Active) return ConnectorResults.Json(view);

        if (SessionStateMachine.IsTerminal(settled.State) || settled.State == SessionState.Blocked)
        {
            var failed = await views.LatestJobAsync(settled.Id, ct);
            return ConnectorResults.Error(new ConnectorException(
                failed?.ErrorCode ?? ErrorCode.Internal, failed?.ErrorDetail));
        }

        return ConnectorResults.Json(view, StatusCodes.Status202Accepted);
    }

    private static async Task<ConnectorJsonResult<SessionResponse>> GetSessionAsync(
        HttpContext http,
        string provider,
        string sessionId,
        IProviderRegistry registry,
        SessionService sessions,
        ViewBuilder views,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

        var session = await sessions.RequireAsync(manifest.Id, sessionId, RequestContext.RequireSubject(http), ct);
        return ConnectorResults.Json(await views.SessionAsync(session, deliverBundle: true, ct));
    }

    private static async Task<IResult> StreamSessionAsync(
        HttpContext http,
        string provider,
        string sessionId,
        IProviderRegistry registry,
        SessionService sessions,
        ViewBuilder views,
        ConnectorSignals signals,
        ConnectorDbContext db,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        var session = await sessions.RequireAsync(manifest.Id, sessionId, RequestContext.RequireSubject(http), ct);

        await EventStream.WriteAsync(
            http,
            async token =>
            {
                db.ChangeTracker.Clear();
                var row = await db.Sessions.FirstOrDefaultAsync(s => s.Id == session.Id, token);
                // The stream never hands over the bundle: a stream cannot
                // be acknowledged, and a bundle delivered into one that
                // nobody read would be lost silently.
                return row is null ? null : await views.SessionAsync(row, deliverBundle: false, token);
            },
            view => SessionStateMachine.IsTerminal(view.State) || view.State == SessionState.Active,
            signals,
            ConnectorSignals.Session(session.Id),
            TimeSpan.FromMinutes(10),
            ct);

        return Results.Empty;
    }

    private static async Task<IResult> ChallengeImageAsync(
        HttpContext http,
        string provider,
        string sessionId,
        string challengeId,
        IProviderRegistry registry,
        SessionService sessions,
        ChallengeService challenges,
        ViewBuilder views,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        var session = await sessions.RequireAsync(manifest.Id, sessionId, RequestContext.RequireSubject(http), ct);

        var job = await views.LatestJobAsync(session.Id, ct)
                  ?? throw ConnectorException.Unsupported("this session has no run in flight");

        var bytes = await challenges.ImageAsync(challengeId, job.Id, ct);
        return bytes is null
            ? ConnectorResults.Error(new ConnectorException(ErrorCode.ChallengeExpired, "no image for this challenge"))
            : Results.File(bytes, "image/png");
    }

    private static async Task<ConnectorJsonResult<SessionResponse>> AnswerAsync(
        HttpContext http,
        string provider,
        string sessionId,
        AnswerRequest request,
        IProviderRegistry registry,
        SessionService sessions,
        ChallengeService challenges,
        ViewBuilder views,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        var session = await sessions.RequireAsync(manifest.Id, sessionId, RequestContext.RequireSubject(http), ct);

        var job = await views.LatestJobAsync(session.Id, ct)
                  ?? throw ConnectorException.Unsupported("this session has no run in flight");

        await challenges.AnswerAsync(request.ChallengeId, job.Id, request.Value, ct);
        return ConnectorResults.Json(await views.SessionAsync(session, deliverBundle: false, ct));
    }

    private static async Task<ConnectorJsonResult<SessionResponse>> CancelAsync(
        HttpContext http,
        string provider,
        string sessionId,
        IProviderRegistry registry,
        SessionService sessions,
        JobOutcomeService outcomes,
        ViewBuilder views,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        var subject = RequestContext.RequireSubject(http);
        var session = await sessions.RequireAsync(manifest.Id, sessionId, subject, ct);

        if (await views.LatestJobAsync(session.Id, ct) is { } job && !JobStateMachine.IsTerminal(job.State))
        {
            await outcomes.FailAsync(job.Id, leaseOwner: null, new JobFailRequest
            {
                // Not retriable by construction: a cancel that came back
                // as a retry would be the opposite of what was asked.
                Code = ErrorCatalog.Wire(ErrorCode.InvalidRequest),
                Detail = "cancelled by the caller",
            }, ct);
        }

        var cancelled = await sessions.RequireAsync(manifest.Id, sessionId, subject, ct);
        return ConnectorResults.Json(await views.SessionAsync(cancelled, deliverBundle: false, ct));
    }

    private static async Task<ConnectorJsonResult<ResumeResponse>> ResumeAsync(
        HttpContext http,
        string provider,
        ResumeRequest request,
        IProviderRegistry registry,
        ProviderStatusService statuses,
        SessionService sessions,
        ITicketStore tickets,
        IOptions<ConnectorOptions> options,
        TimeProvider time,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        RequestContext.StampManifestVersion(http, manifest.ManifestVersion);
        await RequireWorkAcceptedAsync(statuses, manifest, ct);

        RequestContext.RequireSubjectAgreement(http, request.Subject);
        var opened = await sessions.OpenAsync(manifest.Id, request.Subject, request.Bundle, ct);
        var ttl = options.Value.Timeouts.TicketSeconds;

        var ticket = tickets.Mint(new TicketGrant
        {
            Subject = request.Subject,
            SessionId = opened.Session.Id,
            ProviderId = manifest.Id,
            Material = opened.Payload.Material,
            Config = opened.Payload.Config,
            ExpiresAt = time.GetUtcNow().AddSeconds(ttl),
        });

        return ConnectorResults.Json(new ResumeResponse
        {
            Ticket = ticket,
            SessionId = opened.Session.Id,
            ExpiresIn = ttl,
            State = opened.Session.State,
        });
    }

    private static async Task<IResult> DisconnectAsync(
        HttpContext http,
        string provider,
        string sessionId,
        DisconnectRequest? request,
        IProviderRegistry registry,
        SessionService sessions,
        ILeasedJobQueue queue,
        IInlineJobRunner inline,
        ConnectorDbContext db,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        var manifest = registry.RequireManifest(provider);
        RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

        var session = await sessions.RequireAsync(manifest.Id, sessionId, RequestContext.RequireSubject(http), ct);

        // Best-effort upstream logout, then purge regardless. A user
        // disconnecting must always succeed locally, whatever the provider
        // does or does not do about it.
        //
        // Gated on the manifest: most adapters inherit the interface's
        // do-nothing default, and each of those Disconnects was minting a
        // job row, taking a lease and spending a whole agent round trip to
        // reach a method that returns a completed task.
        //
        // Opened BEFORE the purge, because the purge disables the session
        // and a disabled session's bundle no longer opens. Enqueued AFTER
        // it, because the purge blanks the material on every job this
        // session has - including, until this was reordered, the logout job
        // that had just been created to use it.
        // Read before the purge, which sets it to Disabled - so that the
        // diagnostic below can say what the session actually was.
        var state = session.State;

        var material = state == SessionState.Active && manifest.Logout != LogoutSupport.None
            ? await LogoutMaterialAsync(sessions, manifest, session, request?.Bundle, ct)
            : null;

        var config = ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(
            session.ConfigJson, new Dictionary<string, string>(StringComparer.Ordinal));
        var profileId = session.ProfileId;

        // Read before the purge for the same reason the profile is: the
        // logout job below is built after it, and this row is about to be
        // rewritten.
        var fleetOnly = session.FleetOnly;

        await sessions.PurgeAsync(session, ct);

        // SAID EITHER WAY. Every branch above can decide not to log out -
        // the manifest declines it, the session was not active, the caller
        // sent no bundle, or the bundle would not open - and until this
        // line the disconnect returned 204 and looked identical in all
        // five cases. A provider that promises LogoutSupport.Session and
        // then quietly sends nothing is the exact failure this whole path
        // exists to prevent, and it hid here for as long as it hid in the
        // adapter.
        var logout = loggers.CreateLogger($"Connector.Kit.Hosting.Disconnect.{manifest.Id}");

        // WHICH OF THE FIVE, once, so the log and the caller cannot drift
        // apart. This sentence was computed for the log alone and the
        // caller got a bare false - true, and useless to anybody deciding
        // whether to try again with the bundle they forgot to send.
        var reason = SkippedLogoutReason(manifest, state, request?.Bundle);

        string? logoutJobId = null;

        if (material is not null)
        {
            var queued = await queue.EnqueueAsync(new NewJob
            {
                SessionId = sessionId,
                ProviderId = manifest.Id,
                Kind = JobKind.Logout,
                Config = config,
                Material = material,
                ProfileId = profileId,
                // Carried for the reason the profile is: the session said
                // where its work runs, and the last job of a connection is
                // still that connection's work.
                FleetOnly = fleetOnly,
            }, ct);

            if (inline.CanRun(manifest)) inline.Dispatch();

            logout.LogInformation(
                "session {SessionId}: an upstream logout was queued for {Provider}", sessionId, manifest.Id);

            logoutJobId = queued.Id;
        }
        else
        {
            logout.LogInformation(
                "session {SessionId}: {Provider} was NOT told about this disconnect ({Reason}); its session "
                + "will expire on its own",
                sessionId,
                manifest.Id,
                reason);
        }

        db.ChangeTracker.Clear();

        // THE OUTCOME, NOT THE PROMISE. This returned 204 whichever of the
        // five branches above ran, so a consumer had nothing to tell the
        // user but the manifest's own claim - and the demo client duly said
        // "the connector logged out upstream" over a disconnect that had
        // sent nothing at all. A caller cannot report what it is not told.
        return Results.Json(
            new DisconnectResponse
            {
                LoggedOut = material is not null,
                JobId = logoutJobId,
                Reason = material is not null ? null : reason,
            },
            ConnectorJson.Options);
    }

    /// <summary>
    /// Why no upstream logout went out - the first of the reasons that
    /// applies, in the order the disconnect decides them.
    /// </summary>
    private static string SkippedLogoutReason(ProviderManifest manifest, SessionState state, string? bundle)
    {
        if (manifest.Logout == LogoutSupport.None) return "the manifest declares no logout";
        if (state != SessionState.Active) return $"the session was {state}, not active";
        if (string.IsNullOrWhiteSpace(bundle)) return "the caller sent no bundle to log out with";
        return "the bundle the caller sent would not open";
    }

    /// <summary>
    /// The credential to log out with, handed back by whoever holds it.
    ///
    /// Custody is the user's device, so the control plane has no copy: a logout
    /// job built from what is stored here would carry nothing, which is exactly
    /// why the two adapters that implement a logout had never once performed
    /// one. The bundle is bound to this session's own subject and manifest
    /// version, so opening it is also the check that the caller really holds
    /// this connection.
    ///
    /// Null for every reason a logout cannot happen - no bundle offered, a
    /// bundle that no longer opens, one minted for something else. None of
    /// those may fail the disconnect: the user asked to remove a connection,
    /// not to prove they can still authenticate.
    /// </summary>
    private static async Task<SessionMaterial?> LogoutMaterialAsync(
        SessionService sessions,
        ProviderManifest manifest,
        SessionRow session,
        string? bundle,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(bundle)) return null;

        try
        {
            var opened = await sessions.OpenAsync(manifest.Id, session.Subject, bundle, ct);
            return opened.Payload.Material;
        }
        catch (ConnectorException)
        {
            return null;
        }
    }

    private static async Task RequireWorkAcceptedAsync(ProviderStatusService statuses, ProviderManifest manifest, CancellationToken ct)
    {
        var status = await statuses.GetAsync(manifest.Id, ct);
        if (status.AcceptsWork) return;

        throw new ConnectorException(ErrorCode.ProviderUnavailable,
            $"provider '{manifest.Id}' is {status.State}");
    }

    /// <summary>
    /// Consent is checked here or nowhere: an adapter cannot know what terms
    /// the consumer showed, and a stale acceptance is a legal problem long
    /// before it is a technical one.
    /// </summary>
    private static void RequireConsent(ConnectorPlatformOptions platform, ConsentRecord? consent)
    {
        if (!platform.RequireConsent) return;

        if (consent?.AcceptedAt is null)
        {
            throw new ConnectorException(ErrorCode.ConsentExpired, "no recorded consent");
        }

        if (platform.ConsentTermsVersion is { } required &&
            !string.Equals(consent.TermsVersion, required, StringComparison.Ordinal))
        {
            throw new ConnectorException(ErrorCode.ConsentExpired, "consent predates the current terms");
        }
    }

    /// <summary>
    /// WHICH MACHINE this connection lives on. A login that has to run on
    /// hardware the account holder owns is pinned to a profile there before any
    /// job exists - otherwise the first job is offered to whichever agent asks
    /// first, and the browser holding the cookies is on a different one.
    /// </summary>
    /// <remarks>
    /// ONE ACCOUNT PER PROVIDER PER AGENT, and every session of the same
    /// person shares it.
    /// <para>
    /// A persistent profile is a browser directory on somebody's machine, and
    /// what makes it worth having is what the browser keeps: ASN registers a
    /// browser once and then asks five digits instead of a QR scan and a
    /// phone. Connecting from a phone and then from a laptop is two sessions
    /// of one connection, so both must land on the SAME directory - mint a
    /// profile per session and the second device registers all over again,
    /// which is the cost the agent exists to remove.
    /// </para>
    /// <para>
    /// The price is stated rather than hidden: a SECOND account at the same
    /// provider gets the first account's browser, which is already signed in,
    /// so the adapter finds a live session and never asks for the second
    /// account at all. There is nothing here to detect that with - a second
    /// device and a second account arrive as the same request from the same
    /// subject - so a second account needs a second agent. <c>deploy/byo</c>
    /// says so where somebody standing one up will read it.
    /// </para>
    /// <para>
    /// The subject is part of the key even though an agent has one owner,
    /// because the operator's own fleet is the exception: agents whose owner
    /// is listed in <c>FleetSubjects</c> pass the check below for EVERY
    /// caller. Keyed on the agent alone, the second person to name one would
    /// be handed the first person's signed-in bank.
    /// </para>
    /// <para>
    /// AND THE AGENT HAS TO BE THERE. A session pinned to a profile can be
    /// served by exactly one machine, so naming one that is not running is
    /// not a job for the queue to hold - nobody else can ever take it. Until
    /// this check existed such a login was accepted, queued, and failed by
    /// <c>ExpireAbandonedAsync</c> half an hour later with the same
    /// <c>agent_unavailable</c> it could have answered at once; on a stack
    /// where an old enrollment shares its name with the live one, that is
    /// the ordinary outcome of picking the wrong "my nas" from a list. The
    /// BYO README promises the opposite - "start your agent" rather than
    /// pretending - and this is where the promise is kept.
    /// </para>
    /// <para>
    /// AND NOT ONLY THE PERSISTENT ONES ANY MORE. Everything above was written
    /// for T4, where the profile is the product; it applies word for word to
    /// any provider whose manifest says it needs the caller's own machine, and
    /// DUO is the first that is not T4. Its sign-in is a browser login like any
    /// other, and the reason to come back to the SAME browser is the same
    /// reason: the cookies DUO left there are still good for fifteen minutes,
    /// so a second connect inside them asks the human for nothing. Run it on a
    /// different machine of theirs and it is a whole DigiD sign-in again, for
    /// no reason the person can see. A BYO agent already keeps a browser
    /// directory per provider - <c>JobRunner.ResolveProfile</c> does that for
    /// every non-HTTP provider, not only the T4 ones - so the browser is there
    /// either way; what was missing was anything saying WHICH machine's.
    /// </para>
    /// <para>
    /// A ProfileRow is the pin, rather than a new kind of pointer beside it.
    /// The queue already refuses to offer a profile-pinned job to any agent but
    /// the one holding it, the fetch path already refuses a pinned session
    /// whose machine is off, and the key - one row per agent, provider and
    /// account holder - already means exactly what a kept browser means. A
    /// second mechanism would have to re-earn all three, and the first thing it
    /// would do is disagree with one of them.
    /// </para>
    /// <para>
    /// WITH NO <c>prefer_agent</c> AT ALL, which is the case a persistent login
    /// refuses outright and this one must not. A consumer that offers an agent
    /// picker for T4 and nothing for T3 would otherwise make DUO unconnectable,
    /// and a person with one agent has already answered the question by owning
    /// exactly one machine. So: the machine that already holds this connection
    /// if one of theirs does, else their only one, else no pin at all - several
    /// machines and none of them started yet is genuinely ambiguous, and the
    /// queue still keeps that job among their own agents. What cannot happen is
    /// silence: with none of their machines online, this refuses.
    /// </para>
    /// <para>
    /// AND "THE FLEET" NEVER REACHES HERE. <c>prefer_agent</c> has carried a
    /// third answer since 2026-09-21 - the reserved word
    /// <see cref="RunOn.Fleet"/> - and this method is about pinning a
    /// connection to a machine, which is the opposite request. The login turns
    /// that word into <c>FleetOnly</c> and hands this an agent id or nothing,
    /// so the lookup below cannot be reached with a value that was never an id
    /// and answer "unknown agent 'fleet'". For a provider that needs the
    /// caller's own machine the two are a contradiction and
    /// <see cref="RequireFleetCanServeAsync"/> has already refused it; for
    /// every other provider this method returns null on its first line anyway.
    /// </para>
    /// </remarks>
    private static async Task<string?> ResolveProfileAsync(
        ConnectorDbContext db,
        ProviderManifest manifest,
        string? preferAgent,
        string subject,
        ConnectorOptions options,
        TimeProvider time,
        CancellationToken ct)
    {
        var persistent = manifest.Runtime == ProviderRuntime.BrowserPersistent;

        // Every other provider runs wherever the queue sends it, and a session
        // with no profile is how that is said.
        if (!persistent && !manifest.Agent.NeedsOwnMachine) return null;

        if (string.IsNullOrWhiteSpace(preferAgent))
        {
            // A persistent login still insists on being told, because its whole
            // material is a pointer to one directory: guessing the machine
            // would mean guessing the browser a bank was taught to trust.
            if (persistent)
            {
                throw ConnectorException.InvalidRequest(
                    $"provider '{manifest.Id}' needs a persistent profile; name the agent with prefer_agent");
            }

            return await OwnMachineProfileAsync(db, manifest, subject, time, ct);
        }

        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == preferAgent && !a.Revoked, ct)
                    ?? throw new ConnectorException(ErrorCode.AgentUnavailable, $"unknown agent '{preferAgent}'");

        // Naming somebody else's machine must not pin a session to it. The
        // same message as an agent that does not exist, deliberately: whether
        // a given agent id belongs to another user is not this caller's to
        // learn.
        if (agent.OwnerSubject is { } owner
            && !string.Equals(owner, subject, StringComparison.Ordinal)
            && !options.IsFleet(owner))
        {
            throw new ConnectorException(ErrorCode.AgentUnavailable, $"unknown agent '{preferAgent}'");
        }

        // AFTER ownership, deliberately: whether somebody else's machine is
        // switched on is no more this caller's to learn than whether it
        // exists. The refusal is the same code the queue would eventually
        // fail the job with, so a consumer that already renders
        // agent_unavailable as "start your agent" shows the right thing now
        // rather than in thirty minutes.
        var now = time.GetUtcNow();
        if (!AgentLiveness.IsOnline(agent, now))
        {
            throw new ConnectorException(
                ErrorCode.AgentUnavailable,
                $"agent '{preferAgent}' last checked in at {agent.LastHeartbeatAt:O}, more than "
                + $"{AgentLiveness.OfflineAfterSeconds}s ago; this login can only run on that machine, so "
                + "start the agent and connect again");
        }

        return await PinAsync(db, agent.Id, manifest, subject, ct);
    }

    /// <summary>
    /// A login that asked for the operator's fleet gets a fleet that can
    /// actually take it, or a refusal saying which way it cannot.
    /// </summary>
    /// <remarks>
    /// THE THIRD REFUSAL OF THE SAME KIND, and it exists for the reason the
    /// other two do - the queue's own head-start comment: "an exclusion
    /// strands work... with the user watching a queue that never moves". A
    /// fleet-requested job IS an exclusion, of the caller's own machines, so
    /// the moment nobody on the other side can serve it there is nobody left
    /// at all. Accepted anyway, it would sit queued until
    /// <c>ExpireAbandonedAsync</c> failed it half an hour later - and this one
    /// would strand with the caller's own NAS switched on and idle two metres
    /// away, which is a worse thing to show somebody than either neighbour.
    /// <para>
    /// TWO WAYS TO BE UNSERVEABLE AND THEY ARE NOT THE SAME ANSWER. A provider
    /// whose manifest needs the account holder's own machine can never be
    /// served by the fleet - <c>TryLeaseAsync</c> builds its serveable set as
    /// <c>ownMachine || !NeedsOwnMachine</c>, so no fleet machine may lease it
    /// however long it waits - and asking for the fleet there is a
    /// contradiction rather than a shortage. Nothing anybody starts changes
    /// it, so it is <c>invalid_request</c>: the request has to change, which
    /// is what that code and its empty user action say. The other way is an
    /// ordinary shortage - the fleet is down, or carries other providers - and
    /// that is <c>agent_unavailable</c> with <c>start_your_agent</c>, the same
    /// pair <see cref="OwnMachineProfileAsync"/> and
    /// <see cref="RequireReachableEgressAsync"/> use, so a consumer that
    /// renders those needs nothing new.
    /// </para>
    /// <para>
    /// THE IN-PROCESS RUNNER COUNTS AS THE FLEET, and this is the one place
    /// that has to be said out loud. An <c>inline</c> provider is run by the
    /// control plane itself, which leases with no owner scope exactly as a
    /// fleet agent does - so "the fleet" is already serving it, and a headcount
    /// of enrolled machines would refuse a login that would have run
    /// instantly. No picker offers the fleet for such a provider today, because
    /// no picker is drawn at all; a caller that sends the word anyway is
    /// answered by what the platform would really do.
    /// </para>
    /// <para>
    /// The candidate set is the agents online whose owner is named in
    /// <c>FleetSubjects</c> - which is what "no owner scope" means at the lease
    /// route - and their capabilities are read in memory for the reason
    /// <see cref="RequireReachableEgressAsync"/> gives: they live in a json
    /// blob the queue's own SQL cannot see into, and an operator's fleet is a
    /// handful of machines.
    /// </para>
    /// </remarks>
    private static async Task RequireFleetCanServeAsync(
        ConnectorDbContext db,
        ProviderManifest manifest,
        bool fleetRequested,
        IInlineJobRunner inline,
        ConnectorOptions options,
        TimeProvider time,
        CancellationToken ct)
    {
        if (!fleetRequested) return;

        if (manifest.Runtime == ProviderRuntime.BrowserPersistent || manifest.Agent.NeedsOwnMachine)
        {
            throw ConnectorException.InvalidRequest(
                $"provider '{manifest.Id}' runs only on a machine of your own, so the operator's fleet can "
                + $"never take it - the queue offers it to no pooled machine at all. Name one of your own "
                + $"agents with prefer_agent instead of '{RunOn.Fleet}'");
        }

        // The control plane runs this one itself, and it is nobody's own
        // machine, which is the whole of what was asked for.
        if (inline.CanRun(manifest)) return;

        var live = AgentLiveness.OnlineSince(time.GetUtcNow());
        var fleet = options.EffectiveFleetSubjects;

        var blobs = await db.Agents
            .Where(a => !a.Revoked
                        && a.LastHeartbeatAt > live
                        && a.OwnerSubject != null
                        && fleet.Contains(a.OwnerSubject))
            .Select(a => a.CapabilitiesJson)
            .ToListAsync(ct);

        if (blobs.Exists(blob => ConnectorJson.DeserializeOr(blob, new AgentCapabilities()).CanServe(manifest))) return;

        throw new ConnectorException(
            ErrorCode.AgentUnavailable,
            $"this login asked for the operator's fleet, and none of the {blobs.Count} fleet agent(s) online "
            + $"can serve '{manifest.Id}'. It was refused rather than queued, because a job asked of the "
            + "fleet is offered to no machine of yours - so it would have waited for nobody. Choose one of "
            + "your own machines under prefer_agent, or connect again when the fleet is back");
    }

    /// <summary>
    /// A provider that asks to be reached from a particular address gets an
    /// agent claiming one, or a refusal saying so.
    /// </summary>
    /// <remarks>
    /// THE OTHER HALF OF THE EGRESS RULE, and it exists for the reason the
    /// queue's own head-start comment gives: "an exclusion strands work... with
    /// the user watching a queue that never moves". <c>CanServe</c> now
    /// compares the address a manifest asks for against the one an agent
    /// claims, which is an exclusion, so a login for a provider nobody's
    /// address satisfies would be accepted, queued, and failed
    /// <c>agent_unavailable</c> by <c>ExpireAbandonedAsync</c> half an hour
    /// later - the same code, after a 202 and a spinner, to somebody who has
    /// long since put the phone down. Said here it is something they can act
    /// on, exactly as <see cref="OwnMachineProfileAsync"/> says it for the
    /// machine-of-your-own rule, and deliberately with that rule's code and
    /// user action so a consumer that already renders
    /// <c>agent_unavailable</c> / <c>start_your_agent</c> needs nothing new.
    /// <para>
    /// ONLY THE PROVIDERS THAT ASK. A manifest with no
    /// <see cref="AgentRequirement.Egress"/> is skipped entirely, which is most
    /// of them, and the other two axes <c>CanServe</c> tests are not restated
    /// here: they are asked of the candidates found, not of the provider, so
    /// this refuses the case where nothing online can EVER take the work rather
    /// than the case where nothing has asked for it yet.
    /// </para>
    /// <para>
    /// IN MEMORY, AND BOUNDED, because it has to be. Capabilities live in a
    /// json blob the queue's own SQL cannot read - its head start says so in as
    /// many words - so the rows have to be deserialised here. What keeps that
    /// cheap is the candidate set: the agents online FOR THIS CALLER, which is
    /// their own machines plus the operator's fleet, and for a provider that
    /// needs their own machine it is only theirs. A household has one or two
    /// and an operator's fleet is a handful; there is no version of this that
    /// walks every agent ever enrolled.
    /// </para>
    /// </remarks>
    private static async Task RequireReachableEgressAsync(
        ConnectorDbContext db,
        ProviderManifest manifest,
        string subject,
        ConnectorOptions options,
        TimeProvider time,
        CancellationToken ct)
    {
        if (manifest.Agent.Egress is not { } needed) return;

        var live = AgentLiveness.OnlineSince(time.GetUtcNow());
        var fleet = options.EffectiveFleetSubjects;

        // The same liveness window the picker offers machines by and the queue
        // stands back for, because a refusal on a definition of its own would
        // turn away a machine the consumer had just listed as ready.
        var candidates = db.Agents.Where(a => !a.Revoked
                                              && a.LastHeartbeatAt > live
                                              && a.OwnerSubject != null
                                              && (a.OwnerSubject == subject || fleet.Contains(a.OwnerSubject)));

        // A provider that runs only on the account holder's own machine has a
        // narrower candidate set, and it has to be the same one the queue
        // applies: a refusal that counted the fleet would pass a login the
        // queue then refuses to hand anybody.
        if (manifest.Agent.NeedsOwnMachine)
        {
            candidates = candidates.Where(a => a.Class == AgentClass.Byo && a.OwnerSubject == subject);
        }

        var blobs = await candidates.Select(a => a.CapabilitiesJson).ToListAsync(ct);

        if (blobs.Exists(blob => ConnectorJson.DeserializeOr(blob, new AgentCapabilities()).CanServe(manifest))) return;

        throw new ConnectorException(
            ErrorCode.AgentUnavailable,
            $"provider '{manifest.Id}' asks to be reached from a '{needed.Kind}' address in {needed.Country}, "
            + $"and none of the {blobs.Count} agent(s) online for this caller claims one - an agent that "
            + "claims nothing has an address nobody can vouch for and counts as no. This was refused rather "
            + "than queued for a machine that could never take it; start an agent whose "
            + "ConnectorAgent__Egress says where it really is");
    }

    /// <summary>
    /// The machine a login that named none has to run on: one of the caller's
    /// own, or a refusal saying so.
    /// </summary>
    /// <remarks>
    /// THE STRANDING THIS PREVENTS IS THE ONE THE QUEUE ALREADY WARNS ABOUT
    /// two screens up, where the fleet's head start is deliberately a head
    /// start and not an exclusion: "an exclusion strands work... with the user
    /// watching a queue that never moves". The queue now DOES exclude the
    /// fleet from a provider that says it needs the caller's own machine -
    /// there is no safe fallback for that one, which is the point - so the
    /// stranding it feared becomes real the moment nobody's machine is on.
    /// This is the other half of that change, and it belongs here rather than
    /// in the queue: at login the caller is still on the phone, and
    /// <c>agent_unavailable</c> with <c>user_action: start_your_agent</c> is an
    /// instruction they can act on. Thirty minutes later it is a spinner that
    /// turned into an error.
    /// <para>
    /// The same window the picker offers machines by, and the same one the
    /// queue's head start stands back for, because a consumer lists what
    /// <c>AgentLiveness</c> calls online and a refusal on any other definition
    /// would turn away a machine the list had just shown as ready.
    /// </para>
    /// <para>
    /// AN AGENT OF THEIR OWN AND NOT THE OPERATOR'S, which is the one place
    /// this is stricter than the named path. Naming a fleet machine is a choice
    /// somebody made and the standing <c>FleetSubjects</c> exception lets them
    /// make it; being handed one they never asked for is not the same thing,
    /// and what it would pin is this person's signed-in browser onto a machine
    /// shared with everybody - which is the arrangement the manifest exists to
    /// forbid. It also has to be true of a stack whose fleet happens to run a
    /// byo-class agent: counting it, every caller alive "has a machine of their
    /// own", the refusal below never fires for anybody, and the pin lands on a
    /// computer that is not theirs. Found by a suite where one test's fleet
    /// agent silently satisfied another test's caller.
    /// </para>
    /// </remarks>
    private static async Task<string?> OwnMachineProfileAsync(
        ConnectorDbContext db,
        ProviderManifest manifest,
        string subject,
        TimeProvider time,
        CancellationToken ct)
    {
        var live = AgentLiveness.OnlineSince(time.GetUtcNow());

        var theirs = await db.Agents
            .Where(a => a.Class == AgentClass.Byo
                        && !a.Revoked
                        && a.LastHeartbeatAt > live
                        && a.OwnerSubject == subject)
            .Select(a => a.Id)
            .ToListAsync(ct);

        if (theirs.Count == 0)
        {
            throw new ConnectorException(
                ErrorCode.AgentUnavailable,
                $"provider '{manifest.Id}' runs only on a machine of your own, and none of yours has "
                + $"checked in within {AgentLiveness.OfflineAfterSeconds}s; start your agent and connect "
                + "again, or bring one if you have none");
        }

        // The machine that already holds this connection wins, so a second
        // connect comes home to the browser the first one signed in on - which
        // for DUO is the whole errand: inside its fifteen minutes that browser
        // is still signed in and the human is asked nothing.
        //
        // Ordered, because somebody who has signed in on two of their machines
        // has two homes and an unordered FirstOrDefault would pick whichever
        // the database felt like - which is the same arbitrary routing this
        // whole method exists to remove, one layer down.
        var held = await db.Profiles
            .Where(p => p.ProviderId == manifest.Id && p.Subject == subject && theirs.Contains(p.AgentId))
            .OrderBy(p => p.Id)
            .Select(p => p.Id)
            .FirstOrDefaultAsync(ct);

        if (held is not null) return held;

        // Several machines and none of them has run this provider yet: nothing
        // here can tell which one the person is sitting at, and picking would
        // be a guess that then binds every later fetch to it. Unpinned, the
        // queue offers it to whichever of THEIR agents asks - the class rule
        // sees to that - and the next connect finds the profile that one
        // reported and comes back to it. A guess would not self-correct.
        if (theirs.Count > 1) return null;

        return await PinAsync(db, theirs[0], manifest, subject, ct);
    }

    /// <summary>
    /// The profile row for this machine, provider and account holder - the one
    /// that exists, or a new one. The key is the pin: the queue offers a job
    /// carrying it to no other agent.
    /// </summary>
    private static async Task<string> PinAsync(
        ConnectorDbContext db,
        string agentId,
        ProviderManifest manifest,
        string subject,
        CancellationToken ct)
    {
        var existing = await db.Profiles.FirstOrDefaultAsync(
            p => p.AgentId == agentId && p.ProviderId == manifest.Id && p.Subject == subject, ct);

        if (existing is not null) return existing.Id;

        var profile = new ProfileRow
        {
            Id = Ids.New(Ids.Profile),
            AgentId = agentId,
            ProviderId = manifest.Id,
            Subject = subject,
            // Not healthy until the agent says so on a heartbeat: claiming a
            // profile works before it exists produces a job that routes
            // somewhere real and then fails there.
            Healthy = false,
            LastOkAt = null,
        };

        db.Profiles.Add(profile);
        await db.SaveChangesAsync(ct);
        return profile.Id;
    }

    /// <summary>
    /// Waits for the session to reach a state worth reporting. Signal-driven
    /// with a bounded fallback, so a run that finishes in 40ms answers in
    /// 40ms and one that stalls still answers on time.
    /// </summary>
    private static async Task WaitForSettleAsync(
        ConnectorDbContext db, string sessionId, ConnectorSignals signals, TimeSpan window, TimeProvider time, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + window;

        while (time.GetUtcNow() < deadline && !ct.IsCancellationRequested)
        {
            db.ChangeTracker.Clear();
            var state = await db.Sessions.Where(s => s.Id == sessionId).Select(s => s.State).FirstOrDefaultAsync(ct);

            if (state is SessionState.Active or SessionState.AwaitingInput or SessionState.Failed
                or SessionState.Blocked or SessionState.Expired)
            {
                return;
            }

            var remaining = deadline - time.GetUtcNow();
            if (remaining <= TimeSpan.Zero) return;

            await signals.WaitAsync(ConnectorSignals.Session(sessionId),
                remaining < TimeSpan.FromMilliseconds(250) ? remaining : TimeSpan.FromMilliseconds(250), ct);
        }
    }
}
