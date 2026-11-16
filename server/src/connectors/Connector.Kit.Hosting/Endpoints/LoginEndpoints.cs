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
using Connector.Kit.Logging;
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

/// One generic handler for every provider: a new provider is a manifest plus an adapter, never a controller,
/// so a consumer can render a login form it has never seen.
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
        // same body under two statuses is the contract: 200 = the bundle is in hand, 202 = poll or subscribe;
        // a consumer reading only the 200 shape never learns of the second
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
            // explicit: minimal APIs never infer a body on DELETE and refuse it, so the host would not start
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

        RequestContext.RequireOperatorsDoor(http, manifest);
        var record = RequestContext.RecordOf(http, request.Record);

        await RequireWorkAcceptedAsync(statuses, manifest, ct);
        var deviceClass = RequestContext.DeviceClassOf(http);
        RequireConsent(platform, request.Consent);
        RequestContext.RequireSubjectAgreement(http, request.Subject);
        await interval.RequireElapsedAsync(
            RequestContext.TriggerOf(http), manifest, request.Subject, JobKind.Login, resourceId: null, ct);

        var inputs = ValidatedInputs(sessions, manifest, request);

        // a retried caller gets the run it started: a second login would resubmit the credential and
        // spend one of the provider's attempts
        var idempotencyScope = $"login:{manifest.Id}:{request.Subject}";
        var idempotencyKey = RequestContext.IdempotencyKey(http);
        if (idempotencyKey is not null && idempotency.TryGet(idempotencyScope, idempotencyKey, out var replayed))
        {
            return await ReplayAsync(sessions, views, manifest, replayed, request.Subject, ct);
        }

        // read the three-way `prefer_agent` once, here: a second reading is how two paths disagree
        var fleetRequested = RunOn.IsFleet(request.PreferAgent);
        var namedAgent = RunOn.IsAgentId(request.PreferAgent) ? request.PreferAgent : null;

        // before the profile is resolved: pinning writes a ProfileRow, and a refused login must leave none behind
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
            sessions, queue, inline, session, manifest, inputs, request.Config, profileId, fleetRequested,
            RequestContext.TriggerNameOf(http), record, ct);

        // short wait: an HTTP-tier provider usually finishes inside it; slower ones have SSE and a poll URL
        await WaitForSettleAsync(db, session.Id, signals,
            TimeSpan.FromSeconds(options.Value.Timeouts.LoginWaitSeconds), time, ct);

        return await SettledResponseAsync(db, views, session.Id, ct);
    }

    private static IReadOnlyDictionary<string, string> ValidatedInputs(
        SessionService sessions, ProviderManifest manifest, LoginRequest request)
    {
        // redeemed before validation so the manifest's rules apply to a stored bundle like a posted form:
        // it cannot smuggle an undeclared field
        var inputs = request.Inputs.Count == 0 && request.CredentialBundle is { Length: > 0 } stored
            ? sessions.OpenCredentials(manifest.Id, request.Subject, stored)
            : request.Inputs;

        AuthInputValidator.ValidateConfig(manifest, request.Config);
        AuthInputValidator.ValidateInputs(manifest, inputs);
        return inputs;
    }

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
        string trigger,
        bool record,
        CancellationToken ct)
    {
        // running BEFORE the job exists: enqueue-first let a fast job raise its challenge (awaiting_input), then this
        // write put the session back to running, so pollers never learned a human was needed
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
            Trigger = trigger,
            Record = record,
        }, ct);

        if (inline.CanRun(manifest)) inline.Dispatch();
    }

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
                // the stream never delivers the bundle: a stream cannot be acknowledged, so a delivered bundle could be lost silently
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
                // not retriable: a cancel that came back as a retry would be the opposite of the request
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

        // best-effort logout, then purge regardless: a disconnect always succeeds locally; the manifest skips no-op logouts
        // bundle opens BEFORE the purge (it disables the session); the job is enqueued AFTER it (the purge blanks job material)
        // state is read before the purge sets it to Disabled
        var state = session.State;

        var material = state == SessionState.Active && manifest.Logout != LogoutSupport.None
            ? await LogoutMaterialAsync(sessions, manifest, session, request?.Bundle, ct)
            : null;

        var config = ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(
            session.ConfigJson, new Dictionary<string, string>(StringComparer.Ordinal));
        var profileId = session.ProfileId;

        // read before the purge, like the profile: the logout job is built after it
        var fleetOnly = session.FleetOnly;

        await sessions.PurgeAsync(session, ct);

        // said either way: five branches can skip the logout and all looked identical (204)
        var logout = loggers.CreateLogger($"Connector.Kit.Hosting.Disconnect.{manifest.Id}");

        // the reason is computed once so the log and the caller cannot drift apart
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
                // like the profile: the session said where its work runs, and the last job is still that work
                FleetOnly = fleetOnly,
            }, ct);

            if (inline.CanRun(manifest)) inline.Dispatch();

            logout.LogInformation(
                "session {SessionId}: an upstream logout was queued for {Provider}", LogSafe.Line(sessionId), manifest.Id);

            logoutJobId = queued.Id;
        }
        else
        {
            logout.LogInformation(
                "session {SessionId}: {Provider} was NOT told about this disconnect ({Reason}); its session "
                + "will expire on its own",
                LogSafe.Line(sessionId),
                manifest.Id,
                reason);
        }

        db.ChangeTracker.Clear();

        // report the outcome, not the manifest's promise: a caller cannot report what it is not told
        return Results.Json(
            new DisconnectResponse
            {
                LoggedOut = material is not null,
                JobId = logoutJobId,
                Reason = material is not null ? null : reason,
            },
            ConnectorJson.Options);
    }

    private static string SkippedLogoutReason(ProviderManifest manifest, SessionState state, string? bundle)
    {
        if (manifest.Logout == LogoutSupport.None) return "the manifest declares no logout";
        if (state != SessionState.Active) return $"the session was {state}, not active";
        if (string.IsNullOrWhiteSpace(bundle)) return "the caller sent no bundle to log out with";
        return "the bundle the caller sent would not open";
    }

    /// The credential to log out with comes from the caller: custody is the user's device, the control plane has no copy.
    /// Opening it also proves the caller holds this connection. Null for any reason a logout cannot happen;
    /// none of them may fail the disconnect.
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

    /// Consent is checked here or nowhere: an adapter cannot know what terms the consumer showed.
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

    /// Pins a login to a profile before any job exists: one account per provider per agent, shared by a person's sessions.
    /// A second account per provider needs a second agent (deploy/byo); the key has the subject as fleet agents pass for all.
    /// A named agent that is not online is refused at once, not queued to fail after half an hour.
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

        // every other provider runs wherever the queue sends it: no profile
        if (!persistent && !manifest.Agent.NeedsOwnMachine) return null;

        if (string.IsNullOrWhiteSpace(preferAgent))
        {
            // a persistent login must be told the machine: its material points to one directory, and guessing
            // would mean guessing the browser a bank was taught to trust
            if (persistent)
            {
                throw ConnectorException.InvalidRequest(
                    $"provider '{manifest.Id}' needs a persistent profile; name the agent with prefer_agent");
            }

            return await OwnMachineProfileAsync(db, manifest, subject, time, ct);
        }

        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == preferAgent && !a.Revoked, ct)
                    ?? throw new ConnectorException(ErrorCode.AgentUnavailable, $"unknown agent '{preferAgent}'");

        // somebody else's machine is never pinned; same message as an unknown agent so the caller cannot learn who owns an id
        if (agent.OwnerSubject is { } owner
            && !string.Equals(owner, subject, StringComparison.Ordinal)
            && !options.IsFleet(owner))
        {
            throw new ConnectorException(ErrorCode.AgentUnavailable, $"unknown agent '{preferAgent}'");
        }

        // after the ownership check, deliberately: whether another's machine is on is not the caller's to learn;
        // same code the queue would fail with later, so "start your agent" shows now
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

    /// A fleet-requested login needs a fleet that can serve it, or is refused: invalid_request when the provider needs
    /// the caller's own machine (the fleet never can), else agent_unavailable. The in-process runner counts as fleet.
    /// Candidates: online agents of FleetSubjects owners; capabilities are a json blob, read in memory.
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

        // the control plane runs this one itself, and it is nobody's own machine
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

    /// A provider asking for an egress address no online agent claims is refused, not queued to fail agent_unavailable later;
    /// same code and user action as the own-machine rule. Skipped without Egress. Capabilities (json blob) are read in memory
    /// over a small set: the caller's machines plus the fleet.
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

        // same liveness window as the picker and the queue: another definition would refuse a machine listed as ready
        var candidates = db.Agents.Where(a => !a.Revoked
                                              && a.LastHeartbeatAt > live
                                              && a.OwnerSubject != null
                                              && (a.OwnerSubject == subject || fleet.Contains(a.OwnerSubject)));

        // own-machine providers use the queue's narrower set: counting the fleet would pass a login the queue hands to nobody
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

    /// A login naming no agent runs on one of the caller's own machines or is refused at once (start_your_agent).
    /// Their own agents only, never the fleet: a fleet byo-class agent would pin their browser onto a shared machine.
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

        // the machine already holding this connection wins: a second connect returns to the browser still signed in (DUO: 15 min)
        // ordered: with two homes an unordered FirstOrDefault routes arbitrarily
        var held = await db.Profiles
            .Where(p => p.ProviderId == manifest.Id && p.Subject == subject && theirs.Contains(p.AgentId))
            .OrderBy(p => p.Id)
            .Select(p => p.Id)
            .FirstOrDefaultAsync(ct);

        if (held is not null) return held;

        // several machines, none has run this provider: nothing says which one the person is at, and a guess would not self-correct;
        // unpinned, the queue offers it to any of THEIR agents and the next connect finds the reported profile
        if (theirs.Count > 1) return null;

        return await PinAsync(db, theirs[0], manifest, subject, ct);
    }

    /// The key is the pin: the queue offers a job carrying it to no other agent.
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
            // not healthy until the agent says so on a heartbeat: a job routed to a profile that does not exist yet fails there
            Healthy = false,
            LastOkAt = null,
        };

        db.Profiles.Add(profile);
        await db.SaveChangesAsync(ct);
        return profile.Id;
    }

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
