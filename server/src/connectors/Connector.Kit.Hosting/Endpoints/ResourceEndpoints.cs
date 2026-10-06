#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Hosting.Tickets;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// The user's requested shape, served by exactly one handler:
/// <c>GET /v1/jumbo/receipts?since=…&amp;include=items</c>.
///
/// A fetch is a job, so it can take a minute and it can stop to ask a
/// question - a T3 provider re-authenticates on every run. The response is
/// therefore one of three: the data, a job handle, or a challenge. All three
/// are the same code path; only how far it got before the window closed
/// differs.
/// </summary>
internal static class ResourceEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/{provider}/{resource}", async (
            HttpContext http,
            string provider,
            string resource,
            ITicketStore tickets,
            FetchRunner runner,
            CancellationToken ct) =>
        {
            // A ticket is a bearer secret minted for one subject; presented
            // by anybody else it is as good as unknown, and said to be so.
            var subject = RequestContext.RequireSubject(http);
            var ticket = RequestContext.RequireTicket(http);
            if (!tickets.TryRedeem(ticket, provider, out var grant)
                || !string.Equals(grant.Subject, subject, StringComparison.Ordinal))
            {
                throw ConnectorException.SessionExpired("ticket is unknown or expired");
            }

            return await runner.RunAsync(http, provider, resource, RequestContext.Query(http), grant, ct);
        })
        .Produces<DataResponse>(StatusCodes.Status200OK)
        .Produces<JobAcceptedResponse>(StatusCodes.Status202Accepted);

        // The one-shot form, for a caller that wants a single round trip and
        // does not need a ticket. Everything after the bundle is opened is the
        // identical path.
        api.MapPost("/{provider}/{resource}:fetch", async (
            HttpContext http,
            string provider,
            string resource,
            OneShotFetchRequest request,
            IProviderRegistry registry,
            SessionService sessions,
            FetchRunner runner,
            IOptions<ConnectorOptions> options,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            RequestContext.RequireSubjectAgreement(http, request.Subject);
            var opened = await sessions.OpenAsync(manifest.Id, request.Subject, request.Bundle, ct);

            var grant = new TicketGrant
            {
                Subject = request.Subject,
                SessionId = opened.Session.Id,
                ProviderId = manifest.Id,
                Material = opened.Payload.Material,
                Config = opened.Payload.Config,
                ExpiresAt = time.GetUtcNow().AddSeconds(options.Value.Timeouts.TicketSeconds),
            };

            return await runner.RunAsync(http, provider, resource, Flatten(request.Params), grant, ct);
        })
        // The two outcomes a fetch has, and the reason FetchRunner.RunAsync
        // stays Task<IResult>: which one you get depends on how far the job got
        // before the window closed, so no single static claim can be true.
        .Produces<DataResponse>(StatusCodes.Status200OK)
        .Produces<JobAcceptedResponse>(StatusCodes.Status202Accepted);

        api.MapPost("/{provider}/{resource}/ack", async (
            HttpContext http,
            string provider,
            string resource,
            AckRequest request,
            IProviderRegistry registry,
            ITicketStore tickets,
            ResultService results,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

            // A ticket is a bearer secret minted for one subject; presented
            // by anybody else it is as good as unknown, and said to be so.
            var subject = RequestContext.RequireSubject(http);
            var ticket = RequestContext.RequireTicket(http);
            if (!tickets.TryRedeem(ticket, provider, out var grant)
                || !string.Equals(grant.Subject, subject, StringComparison.Ordinal))
            {
                throw ConnectorException.SessionExpired("ticket is unknown or expired");
            }

            if (manifest.Resource(resource) is null)
            {
                throw ConnectorException.Unsupported($"provider '{manifest.Id}' has no resource '{resource}'");
            }

            var purged = await results.AckAsync(grant.SessionId, resource, request.Cursor, ct);
            return ConnectorResults.Json(new AckResponse { Purged = purged });
        });
    }

    /// <summary>
    /// The one-shot body carries params as JSON, where a list is a real array
    /// rather than a comma-joined string. Flattening to the query-string shape
    /// means one validator sees both forms and they cannot diverge.
    /// </summary>
    private static Dictionary<string, IReadOnlyList<string>> Flatten(IReadOnlyDictionary<string, JsonNode?> body)
    {
        var result = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

        foreach (var (key, node) in body)
        {
            switch (node)
            {
                case null:
                    continue;
                case JsonArray array:
                    result[key] = [.. array.Where(v => v is not null).Select(v => v!.ToString())];
                    break;
                default:
                    result[key] = [node.ToString()];
                    break;
            }
        }

        return result;
    }
}

public sealed record AckResponse
{
    public required int Purged { get; init; }
}

/// <summary>
/// The shared body of every fetch: validate, enqueue, wait a little, and
/// answer with whatever is true by then.
/// </summary>
public sealed class FetchRunner(
    IProviderRegistry registry,
    ProviderStatusService statuses,
    ILeasedJobQueue queue,
    IInlineJobRunner inline,
    ConnectorDbContext db,
    ViewBuilder views,
    ResultService results,
    ConnectorSignals signals,
    SyncInterval interval,
    IOptions<ConnectorOptions> options,
    TimeProvider time)
{
    public async Task<IResult> RunAsync(
        HttpContext http,
        string providerId,
        string resourceId,
        IReadOnlyDictionary<string, IReadOnlyList<string>> query,
        TicketGrant grant,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(grant);

        var manifest = registry.RequireManifest(providerId);
        RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

        var status = await statuses.GetAsync(manifest.Id, ct);
        if (!status.AcceptsWork)
        {
            throw new ConnectorException(ErrorCode.ProviderUnavailable, $"provider '{manifest.Id}' is {status.State}");
        }

        var resource = manifest.Resource(resourceId)
                       ?? throw ConnectorException.Unsupported($"provider '{manifest.Id}' has no resource '{resourceId}'");

        var request = ParamBinder.Bind(manifest, resource, query, time.GetUtcNow());

        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == grant.SessionId, ct)
                      ?? throw ConnectorException.SessionExpired("session no longer exists");

        await interval.RequireElapsedAsync(
            RequestContext.TriggerOf(http), manifest, session.Subject, JobKind.Fetch, resource.Id, ct);
        await RequireProfileHolderOnlineAsync(session, ct);

        // A fetch of this resource already in flight for this connection IS
        // the fetch the caller gets (prod 2026-10-06: a phone that kept
        // reopening the app queued four Amazon fetches in twelve minutes;
        // one ran for half an hour while the other three waited behind the
        // per-session lease and died as agent_unavailable). The handle is
        // the same contract as a fresh 202, and whichever device collects
        // it first collects it.
        if (await InFlightAsync(session.Id, resource.Id, ct) is { } inFlight)
        {
            return ConnectorResults.Json(await views.AcceptedAsync(inFlight, ct), StatusCodes.Status202Accepted);
        }

        var job = await queue.EnqueueAsync(new NewJob
        {
            SessionId = session.Id,
            ProviderId = manifest.Id,
            Kind = JobKind.Fetch,
            ResourceId = resource.Id,
            Request = request,
            Config = MergeConfig(session, grant),
            Material = grant.Material,
            ProfileId = session.ProfileId,
            // Both routing answers come off the session, because both were
            // given about the CONNECTION rather than about one job: a pin says
            // which machine holds this browser, and FleetOnly says the caller
            // asked for the operator's fleet and not for a machine of theirs.
            // A fetch that forgot the second would land back on the NAS the
            // login was deliberately kept off.
            FleetOnly = session.FleetOnly,
            Trigger = RequestContext.TriggerNameOf(http),
        }, ct);

        if (inline.CanRun(manifest)) inline.Dispatch();

        var window = TimeSpan.FromSeconds(Math.Min(
            options.Value.Timeouts.FetchWaitSeconds,
            Math.Max(5, resource.TypicalDurationSeconds)));

        await WaitAsync(job.Id, window, ct);

        db.ChangeTracker.Clear();
        var settled = await db.Jobs.FirstAsync(j => j.Id == job.Id, ct);

        switch (settled.State)
        {
            case JobState.Succeeded:
            {
                var page = await results.ReadAsync(settled.Id, ct);
                var rotated = await CollectBundleAsync(settled.SessionId, ct);

                return ConnectorResults.Json(new DataResponse
                {
                    Resource = resource.Id,
                    Data = page.Data,
                    Cursor = page.Cursor,
                    Complete = settled.Complete,
                    Notes = Infrastructure.ConnectorJson.DeserializeOr<IReadOnlyList<string>>(settled.NotesJson, []),
                    Session = rotated is null ? null : new SessionBundle { Bundle = rotated, Rotated = true },
                });
            }

            case JobState.Failed or JobState.Expired:
                throw new ConnectorException(settled.ErrorCode ?? ErrorCode.Internal, settled.ErrorDetail);

            default:
                return ConnectorResults.Json(await views.AcceptedAsync(settled, ct), StatusCodes.Status202Accepted);
        }
    }

    /// <summary>
    /// The newest fetch of a resource that is still queued, leased, running
    /// or waiting for an answer, for this session; null when none is.
    /// </summary>
    private Task<JobRow?> InFlightAsync(string sessionId, string resourceId, CancellationToken ct) =>
        db.Jobs.AsNoTracking()
            .Where(j => j.SessionId == sessionId
                        && j.Kind == JobKind.Fetch
                        && j.ResourceId == resourceId
                        && (j.State == JobState.Queued
                            || j.State == JobState.Leased
                            || j.State == JobState.Running
                            || j.State == JobState.AwaitingInput))
            .OrderByDescending(j => j.CreatedAt)
            .ThenByDescending(j => j.Id)
            .FirstOrDefaultAsync(ct);

    /// <summary>
    /// Refuses, now, a fetch that nobody could ever take.
    /// </summary>
    /// <remarks>
    /// ONLY FOR WORK PINNED TO A PROFILE, and the distinction is the whole
    /// design. An ordinary job whose owner's machine is off is not stranded:
    /// the queue lets the fleet stand back for a head start and then hands
    /// the work to whoever asks, which is self-healing and needs nobody told.
    /// A job pinned to a persistent profile has no such fallback - the
    /// profile is a browser directory on one machine, and the lease clause
    /// will only ever offer it to the agent holding that directory. Queued
    /// while that agent is off, it waits the full abandonment window and
    /// then fails with <c>agent_unavailable</c>, having told the caller 202
    /// and shown them a spinner for half an hour first.
    /// <para>
    /// Judged by the agent that HOLDS the profile rather than by the session's
    /// own <c>AgentId</c>, because the profile is what the queue routes on;
    /// the two are minted together and agree today, and this reads the one
    /// that decides. The window is the platform's single definition of
    /// online, the same one the agent listing shows.
    /// </para>
    /// </remarks>
    private async Task RequireProfileHolderOnlineAsync(SessionRow session, CancellationToken ct)
    {
        if (session.ProfileId is not { } profileId) return;

        var holder = await db.Profiles
            .Where(p => p.Id == profileId)
            .Join(db.Agents, p => p.AgentId, a => a.Id, (_, a) => a)
            .AsNoTracking()
            .FirstOrDefaultAsync(ct);

        if (holder is not null && AgentLiveness.IsOnline(holder, time.GetUtcNow())) return;

        throw HolderRefusal(profileId, holder);
    }

    /// <summary>
    /// Says which of the three ways to be unusable this holder is, because
    /// they do not all have the same answer.
    /// </summary>
    /// <remarks>
    /// <see cref="AgentLiveness.IsOnline"/> collapses REVOKED and SILENT into
    /// one false, and that is right for a predicate and wrong for a sentence.
    /// The refusal used to know only the silent wording, so a holder revoked
    /// thirty seconds ago - heartbeat still warm - was told its last check-in
    /// was more than ninety seconds ago, and told to start the agent. Both
    /// halves were false, and the second one worse than false: revocation
    /// replaces the agent's token hash, so the machine that obediently starts
    /// is answered 401, self-revokes and wipes its profiles. The instruction
    /// destroys the thing it claims to be recovering, and the user can follow
    /// it for ever without the answer changing.
    /// <para>
    /// Revoked is therefore checked FIRST, and carries its own code rather
    /// than a different string under the same one: <c>user_action</c> is a
    /// function of the code in the error catalogue and nowhere else, so
    /// "reconnect" instead of "start your agent" IS the second code. A
    /// consumer that renders <c>agent_unavailable</c> as a friendly notice -
    /// the demo does, on the reasoning that a switched-off machine is not a
    /// failure - gets a real failure styled as one, which is what a connection
    /// that cannot be repaired is.
    /// </para>
    /// <para>
    /// Internal so it can be asserted on directly. The detail never reaches
    /// the wire - it is logged beside a <c>detail_id</c> - so a test driving
    /// the endpoint can see the code and the action but not one word of this.
    /// </para>
    /// </remarks>
    internal static ConnectorException HolderRefusal(string profileId, AgentRow? holder)
    {
        if (holder is null)
        {
            return new ConnectorException(
                ErrorCode.AgentUnavailable,
                $"profile '{profileId}' or the agent holding it no longer exists; nothing can serve this session");
        }

        if (holder.Revoked)
        {
            return new ConnectorException(
                ErrorCode.AgentRevoked,
                $"agent '{holder.Id}' holding profile '{profileId}' was revoked; nothing can serve this session, "
                + "and starting that machine cannot help - its token no longer matches, so it would be answered "
                + "401 and wipe the profile on the way out; the connection has to be set up again");
        }

        return new ConnectorException(
            ErrorCode.AgentUnavailable,
            $"agent '{holder.Id}' holding profile '{profileId}' last checked in at {holder.LastHeartbeatAt:O}, "
            + $"more than {AgentLiveness.OfflineAfterSeconds}s ago; only that machine can serve this "
            + "session, so start the agent and fetch again");
    }

    /// <summary>
    /// The bundle's config wins where the two disagree: it is what the user
    /// actually connected with, and the session row is a convenience copy.
    /// </summary>
    private static Dictionary<string, string> MergeConfig(SessionRow session, TicketGrant grant)
    {
        var merged = new Dictionary<string, string>(
            ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(
                session.ConfigJson, new Dictionary<string, string>(StringComparer.Ordinal)),
            StringComparer.Ordinal);

        foreach (var (key, value) in grant.Config) merged[key] = value;
        return merged;
    }

    private async Task<string?> CollectBundleAsync(string sessionId, CancellationToken ct)
    {
        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session?.PendingBundle is not { } bundle) return null;

        session.PendingBundle = null;
        session.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return bundle;
    }

    private async Task WaitAsync(string jobId, TimeSpan window, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + window;

        while (time.GetUtcNow() < deadline && !ct.IsCancellationRequested)
        {
            db.ChangeTracker.Clear();
            var state = await db.Jobs.Where(j => j.Id == jobId).Select(j => j.State).FirstOrDefaultAsync(ct);

            if (state is JobState.Succeeded or JobState.Failed or JobState.Expired or JobState.AwaitingInput) return;

            var remaining = deadline - time.GetUtcNow();
            if (remaining <= TimeSpan.Zero) return;

            await signals.WaitAsync(ConnectorSignals.Job(jobId),
                remaining < TimeSpan.FromMilliseconds(250) ? remaining : TimeSpan.FromMilliseconds(250), ct);
        }
    }
}
