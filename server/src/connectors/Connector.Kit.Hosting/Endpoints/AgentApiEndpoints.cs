#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Microsoft.Extensions.Logging;
using Connector.Kit.Jobs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Endpoints;

/// every call is outbound from the agent, the control plane never connects to one: that lets an agent sit behind NAT
internal static class AgentApiEndpoints
{
    public static void Map(IEndpointRouteBuilder root)
    {
        // Enrollment authenticates with the one-time code itself, so it sits
        // outside the token filter. Everything else is behind it.
        root.MapPost("/agent/v1/enroll", (
            EnrollRequest request,
            AgentAuth auth,
            ConnectorDbContext db,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) => EnrollAsync(request, auth, db, options, time, ct))
        .AddEndpointFilter<ConnectorExceptionFilter>();

        var agents = root.MapGroup("/agent/v1")
            .AddEndpointFilter<ConnectorExceptionFilter>()
            .AddEndpointFilter<AgentAuthFilter>();

        agents.MapPost("/heartbeat", (
            HttpContext http,
            HeartbeatRequest request,
            ConnectorDbContext db,
            IProviderRegistry registry,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            ILoggerFactory loggers,
            CancellationToken ct) => HeartbeatAsync(http, request, db, registry, options, time, loggers, ct));

        agents.MapPost("/jobs/lease", (
            HttpContext http,
            LeaseRequest request,
            ILeasedJobQueue queue,
            ConnectorSignals signals,
            IProviderRegistry registry,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            ConnectorDbContext db,
            CancellationToken ct) => LeaseAsync(http, request, queue, signals, registry, options, time, db, ct))
        // 204 is the long poll expiring with no work, which is most of them.
        .Produces<LeasedJob>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status204NoContent);

        agents.MapPost("/jobs/{jobId}/renew", (
            HttpContext http,
            string jobId,
            ILeasedJobQueue queue,
            IOptions<ConnectorOptions> options,
            CancellationToken ct) => RenewAsync(http, jobId, queue, options, ct));

        agents.MapPost("/jobs/{jobId}/progress", (
            HttpContext http,
            string jobId,
            ProgressReport report,
            ILeasedJobQueue queue,
            CancellationToken ct) => ProgressAsync(http, jobId, report, queue, ct))
        .Produces(StatusCodes.Status204NoContent);

        agents.MapPost("/jobs/{jobId}/challenge", (
            HttpContext http,
            string jobId,
            AgentChallengeRequest request,
            ChallengeService challenges,
            ConnectorDbContext db,
            CancellationToken ct) => RaiseChallengeAsync(http, jobId, request, challenges, db, ct));

        agents.MapGet("/jobs/{jobId}/answer", (
            HttpContext http,
            string jobId,
            ChallengeService challenges,
            ConnectorDbContext db,
            IOptions<ConnectorOptions> options,
            CancellationToken ct) => AwaitAnswerAsync(http, jobId, challenges, db, options, ct))
        // 204 means "still open, poll again" and is the difference between a
        // human who is mid-login and one who never came back.
        .Produces<ChallengeAnswer>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status204NoContent);

        // inside the agent group's auth: a streamed login's frames must not be reachable by anything that could not lease the job
        LiveEndpoints.MapAgent(agents);

        agents.MapPost("/jobs/{jobId}/trace", (
            HttpContext http,
            string jobId,
            ConnectorDbContext db,
            JobTraceService traces,
            IOptions<ConnectorOptions> options,
            CancellationToken ct) => TraceAsync(http, jobId, db, traces, options, ct))
        .WithHttpLogging(HttpLoggingFields.None);

        agents.MapPost("/jobs/{jobId}/result", (
            HttpContext http,
            string jobId,
            JobResultRequest result,
            JobOutcomeService outcomes,
            CancellationToken ct) => ResultAsync(http, jobId, result, outcomes, ct));

        agents.MapPost("/jobs/{jobId}/fail", (
            HttpContext http,
            string jobId,
            JobFailRequest failure,
            JobOutcomeService outcomes,
            CancellationToken ct) => FailAsync(http, jobId, failure, outcomes, ct));
    }

    private static async Task<ConnectorJsonResult<EnrollResponse>> EnrollAsync(
        EnrollRequest request,
        AgentAuth auth,
        ConnectorDbContext db,
        IOptions<ConnectorOptions> options,
        TimeProvider time,
        CancellationToken ct)
    {
        var enrollment = await auth.RedeemEnrollmentAsync(request.Code, ct);
        var token = AgentAuth.NewToken();
        var now = time.GetUtcNow();

        var agent = new AgentRow
        {
            Id = Ids.New(Ids.Agent),
            Name = string.IsNullOrWhiteSpace(request.Name) ? enrollment.Name : request.Name,
            Class = request.Capabilities.Class,
            // the subject rides on the code, never the request: an agent naming its own owner would undo the one-subject rule
            OwnerSubject = enrollment.Subject,
            // a private slot (#420 A2) is told by the code it enrolled with, never by what the agent claims
            Hosted = string.Equals(enrollment.Subject, ConnectorOptions.PrivateSlotSubject, StringComparison.Ordinal),
            CapabilitiesJson = ConnectorJson.Serialize(request.Capabilities),
            TokenHash = AgentAuth.Hash(token),
            LastHeartbeatAt = now,
            CreatedAt = now,
        };

        db.Agents.Add(agent);
        await db.SaveChangesAsync(ct);

        return ConnectorResults.Json(new EnrollResponse
        {
            AgentId = agent.Id,
            Token = token,
            HeartbeatSeconds = options.Value.Timeouts.HeartbeatSeconds,
        });
    }

    private static async Task<ConnectorJsonResult<HeartbeatResponse>> HeartbeatAsync(
        HttpContext http,
        HeartbeatRequest request,
        ConnectorDbContext db,
        IProviderRegistry registry,
        IOptions<ConnectorOptions> options,
        TimeProvider time,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        var now = time.GetUtcNow();

        agent.LastHeartbeatAt = now;
        agent.CapabilitiesJson = ConnectorJson.Serialize(request.Capabilities);
        agent.Class = request.Capabilities.Class;

        // a released slot's wipe is confirmed (#420 A2): the slot is free
        // before the profile bookkeeping, which must not re-record deleted profiles
        var wiped = request.ResetDone && agent.ResetRequestedAt is not null;
        if (wiped) agent.ResetRequestedAt = null;

        // liveness is saved first, on its own: sharing a transaction with profile bookkeeping rolled a heartbeat back on a
        // duplicate profile key, and a live agent showed offline for weeks
        await db.SaveChangesAsync(ct);

        if (wiped)
        {
            await db.Profiles.Where(p => p.AgentId == agent.Id).ExecuteDeleteAsync(ct);
        }

        try
        {
            await ReconcileProfilesAsync(db, agent.Id, request.Profiles, ct);
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex)
        {
            // loud, not fatal: the committed heartbeat is what this endpoint owes; only which profiles the agent holds is stale
            loggers.CreateLogger("Connector.Kit.Hosting.Agents").LogError(
                ex,
                "agent {AgentId}: its profiles could not be recorded. The agent is alive and this "
                + "heartbeat stands; what is stale is which profiles it is holding",
                agent.Id);

            // nothing to clear: the scoped DbContext dies with the request, so the failed insert is not retried by the next heartbeat
        }

        return ConnectorResults.Json(new HeartbeatResponse
        {
            LeaseTtlSeconds = options.Value.Timeouts.LeaseSeconds,
            Revoked = agent.Revoked,
            CatalogDigest = registry.AgentCatalogDigest,
            ResetProfiles = agent.ResetRequestedAt is not null,
        });
    }

    private static async Task<IResult> LeaseAsync(
        HttpContext http,
        LeaseRequest request,
        ILeasedJobQueue queue,
        ConnectorSignals signals,
        IProviderRegistry registry,
        IOptions<ConnectorOptions> options,
        TimeProvider time,
        ConnectorDbContext db,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        var capabilities = ConnectorJson.DeserializeOr(agent.CapabilitiesJson, new AgentCapabilities());

        // an agent on another adapter catalogue is offered no work (its forms and selectors differ)
        // it keeps polling; the heartbeat told it why
        var stale = AgentCatalogue.IsStale(capabilities, registry);

        // null scope only for the operator's fleet (configuration), never from agent-sent data: Class arrives on its own heartbeat
        var ownerScope = agent.OwnerSubject is { } owner && !options.Value.IsFleet(owner)
            ? owner
            : null;

        var ttl = TimeSpan.FromSeconds(options.Value.Timeouts.LeaseSeconds);
        var deadline = time.GetUtcNow().AddSeconds(options.Value.Timeouts.AgentPollSeconds);

        // long poll, not an interval pull: faster to start a job and quieter
        while (!ct.IsCancellationRequested)
        {
            var job = stale
                ? null
                : await queue.TryLeaseAsync(agent.Id, ownerScope, capabilities, request.Accept, ttl, ct);
            if (job is not null) return ConnectorResults.Json(job);

            var remaining = deadline - time.GetUtcNow();
            if (remaining <= TimeSpan.Zero) break;

            db.ChangeTracker.Clear();
            await signals.WaitAsync(ConnectorSignals.Queue,
                remaining < TimeSpan.FromSeconds(2) ? remaining : TimeSpan.FromSeconds(2), ct);
        }

        return Results.NoContent();
    }

    private static async Task<ConnectorJsonResult<RenewResponse>> RenewAsync(
        HttpContext http,
        string jobId,
        ILeasedJobQueue queue,
        IOptions<ConnectorOptions> options,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        var ttl = TimeSpan.FromSeconds(options.Value.Timeouts.LeaseSeconds);

        var renewed = await queue.RenewLeaseAsync(jobId, agent.Id, ttl, ct);
        return renewed is null
            ? throw ConnectorException.Unsupported($"job '{jobId}' is no longer leased to this agent")
            : ConnectorResults.Json(new RenewResponse { LeaseExpiresAt = renewed.Value });
    }

    private static async Task<IResult> ProgressAsync(
        HttpContext http,
        string jobId,
        ProgressReport report,
        ILeasedJobQueue queue,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        await queue.ProgressAsync(jobId, agent.Id, report, ct);
        return Results.NoContent();
    }

    private static async Task<ConnectorJsonResult<RaiseChallengeResponse>> RaiseChallengeAsync(
        HttpContext http,
        string jobId,
        AgentChallengeRequest request,
        ChallengeService challenges,
        ConnectorDbContext db,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        await RequireLeasedAsync(db, jobId, agent.Id, ct);

        var row = await challenges.RaiseAsync(jobId, new PendingChallenge
        {
            Type = request.Type,
            ExpiresAt = request.ExpiresAt,
            Payload = new ChallengePayload
            {
                AnswerKind = request.AnswerKind,
                PromptKey = request.PromptKey,
                Code = request.Code,
                Delivery = request.Delivery,
                Length = request.Length,
                Options = request.Options,
                Url = request.Url,
                ReturnPattern = request.ReturnPattern,
            },
            Image = DecodeImage(request.ImageBase64),
        }, ct);

        return ConnectorResults.Json(new RaiseChallengeResponse { ChallengeId = row.Id });
    }

    private static async Task<IResult> AwaitAnswerAsync(
        HttpContext http,
        string jobId,
        ChallengeService challenges,
        ConnectorDbContext db,
        IOptions<ConnectorOptions> options,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        await RequireLeasedAsync(db, jobId, agent.Id, ct);

        // optional so an older agent works, but without it a job with two open questions returns the answer to the wrong one
        var waitingFor = http.Request.Query["challenge_id"].ToString();

        var window = TimeSpan.FromSeconds(options.Value.Timeouts.AgentPollSeconds);
        var answer = await challenges.AwaitAnswerAsync(
            jobId, window, ct, string.IsNullOrWhiteSpace(waitingFor) ? null : waitingFor);

        if (answer is not null) return ConnectorResults.Json(answer);

        // only an expired challenge is a 408; an open one means poll again, as failing the job would discard a login in progress
        var pending = await challenges.PendingAsync(jobId, ct);
        return pending is null
            ? ConnectorResults.Error(new ConnectorException(ErrorCode.MfaTimeout, "challenge expired unanswered"))
            : Results.NoContent();
    }

    /// the run's recording (#441 L3): gzipped JSON posted while leased; unpacked only to validate it before it is kept
    private static async Task<ConnectorJsonResult<TraceAckResponse>> TraceAsync(
        HttpContext http,
        string jobId,
        ConnectorDbContext db,
        JobTraceService traces,
        IOptions<ConnectorOptions> options,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        await RequireLeasedAsync(db, jobId, agent.Id, ct);

        var max = options.Value.MaxTraceBytes;
        var raw = await ReadBoundedAsync(http.Request, max, ct);
        var packed = http.Request.Headers.ContentEncoding.ToString().Contains("gzip", StringComparison.OrdinalIgnoreCase);

        byte[] plain;
        try
        {
            plain = packed ? JobTraceService.Gunzip(raw, max * 8) : raw;
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            throw ConnectorException.InvalidRequest("the recording is not readable gzip");
        }

        Connector.Kit.Tracing.JobTrace? trace;
        try
        {
            trace = System.Text.Json.JsonSerializer.Deserialize<Connector.Kit.Tracing.JobTrace>(plain, ConnectorWireJson.Options);
        }
        catch (System.Text.Json.JsonException)
        {
            throw ConnectorException.InvalidRequest("the recording is not a trace");
        }

        if (trace is null) throw ConnectorException.InvalidRequest("the recording is empty");

        var kept = await traces.KeepAsync(jobId, trace, ct);
        return ConnectorResults.Json(new TraceAckResponse { Entries = kept?.Entries ?? 0, Bytes = kept?.ByteCount ?? 0 });
    }

    private static async Task<byte[]> ReadBoundedAsync(HttpRequest request, int max, CancellationToken ct)
    {
        if (request.ContentLength > max) throw ConnectorException.InvalidRequest("the recording outweighs the cap");

        using var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        while (true)
        {
            var read = await request.Body.ReadAsync(chunk, ct);
            if (read == 0) break;
            if (buffer.Length + read > max) throw ConnectorException.InvalidRequest("the recording outweighs the cap");
            await buffer.WriteAsync(chunk.AsMemory(0, read), ct);
        }

        return buffer.ToArray();
    }

    private static async Task<ConnectorJsonResult<AgentAckResponse>> ResultAsync(
        HttpContext http,
        string jobId,
        JobResultRequest result,
        JobOutcomeService outcomes,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        var outcome = await outcomes.SucceedAsync(jobId, agent.Id, result, ct);
        return ConnectorResults.Json(new AgentAckResponse { Cursor = outcome.Cursor });
    }

    private static async Task<ConnectorJsonResult<AgentFailResponse>> FailAsync(
        HttpContext http,
        string jobId,
        JobFailRequest failure,
        JobOutcomeService outcomes,
        CancellationToken ct)
    {
        var agent = http.RequireAgent();
        var job = await outcomes.FailAsync(jobId, agent.Id, failure, ct);
        return ConnectorResults.Json(new AgentFailResponse { State = job.State });
    }

    /// profiles the agent no longer reports become unhealthy, not deleted: a vanished profile is what a user must be told
    private static async Task ReconcileProfilesAsync(
        ConnectorDbContext db, string agentId, IReadOnlyList<ProfileHealth> reported, CancellationToken ct)
    {
        var existing = await db.Profiles.Where(p => p.AgentId == agentId).ToListAsync(ct);
        var byId = existing.ToDictionary(p => p.Id, StringComparer.Ordinal);

        foreach (var profile in reported)
        {
            if (byId.TryGetValue(profile.Id, out var row))
            {
                row.Healthy = profile.Healthy;
                row.LastOkAt = profile.LastOk ?? row.LastOkAt;
                row.ProviderId = profile.Provider;
                continue;
            }

            db.Profiles.Add(new ProfileRow
            {
                Id = profile.Id,
                AgentId = agentId,
                ProviderId = profile.Provider,
                Healthy = profile.Healthy,
                LastOkAt = profile.LastOk,
            });
        }

        var reportedIds = reported.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var row in existing.Where(r => r.Healthy && !reportedIds.Contains(r.Id)))
        {
            row.Healthy = false;
        }
    }

    /// internal so the live routes use this same check: a second copy of "is this job yours" is one more thing to get wrong
    internal static async Task RequireLeasedAsync(ConnectorDbContext db, string jobId, string agentId, CancellationToken ct)
    {
        var leased = await db.Jobs.AsNoTracking()
            .AnyAsync(j => j.Id == jobId && j.LeaseOwner == agentId, ct);

        if (!leased) throw ConnectorException.Unsupported($"job '{jobId}' is not leased to this agent");
    }

    private static byte[]? DecodeImage(string? base64)
    {
        if (string.IsNullOrWhiteSpace(base64)) return null;

        try
        {
            return Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            throw ConnectorException.InvalidRequest("image_base64 is not valid base64");
        }
    }
}

public sealed record AgentAckResponse
{
    public required string Cursor { get; init; }
}

