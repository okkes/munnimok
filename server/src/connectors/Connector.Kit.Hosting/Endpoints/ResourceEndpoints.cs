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

/// A fetch is a job, so the response is the data, a job handle or a challenge: one code path, differing in how far it got
/// before the window closed.
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
            // a ticket is a bearer secret for one subject; presented by anybody else it is treated as unknown
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

        // one-shot form: no ticket; the same path once the bundle is open
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

            return await runner.RunAsync(http, provider, resource, Flatten(request.Params), grant, ct, RequestContext.RecordOf(http, request.Record));
        })
        // 200 or 202 depending on how far the job got: why FetchRunner.RunAsync stays Task<IResult>
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

            // a ticket is a bearer secret for one subject; presented by anybody else it is treated as unknown
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

    /// Flattened to the query-string shape so one validator sees both forms and they cannot diverge.
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
        CancellationToken ct,
        bool record = false)
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

        // an in-flight fetch of this resource for this connection IS the caller's fetch, if it asks the same (prod 2026-10-06:
        // a reopening phone queued four Amazon fetches in 12 min; three died as agent_unavailable behind the session lease)
        if (await InFlightAsync(session.Id, request, ct) is { } inFlight)
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
            // routing comes off the session: the pin says which machine holds the browser, FleetOnly that the caller asked
            // for the fleet; forgetting it would land the fetch on the NAS the login was kept off
            FleetOnly = session.FleetOnly,
            Trigger = RequestContext.TriggerNameOf(http),
            Record = record,
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

    private async Task<JobRow?> InFlightAsync(string sessionId, ResourceRequest request, CancellationToken ct)
    {
        var running = await db.Jobs.AsNoTracking()
            .Where(j => j.SessionId == sessionId
                        && j.Kind == JobKind.Fetch
                        && j.ResourceId == request.ResourceId
                        && (j.State == JobState.Queued
                            || j.State == JobState.Leased
                            || j.State == JobState.Running
                            || j.State == JobState.AwaitingInput))
            .OrderByDescending(j => j.CreatedAt)
            .ThenByDescending(j => j.Id)
            .ToListAsync(ct);
        return running.Find(j => SameAsk(j.ParamsJson, request));
    }

    internal static bool SameAsk(string paramsJson, ResourceRequest request)
    {
        var asked = Infrastructure.ConnectorJson.DeserializeOr<ResourceRequest?>(paramsJson, null);
        return asked is not null
               && asked.Since == request.Since
               && asked.Until == request.Until
               && asked.Selections.Count == request.Selections.Count
               && asked.Selections.All(s => request.Selections.TryGetValue(s.Key, out var values) && values.ToHashSet(StringComparer.Ordinal).SetEquals(s.Value));
    }

    /// Only for work pinned to a profile: an ordinary job whose owner is off self-heals (the fleet takes it after the head
    /// start), a pinned one fails after half an hour. Judged by the agent holding the profile, as the queue routes on the
    /// profile; the online window is the platform's single definition.
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

    /// Revoked is checked first with its own code: IsOnline collapses revoked and silent, but starting a revoked agent gets 401,
    /// self-revokes and wipes its profiles. user_action derives from the code alone, so "reconnect" needs its own code.
    /// Internal for tests: the detail is only logged, never on the wire.
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

    /// The bundle's config wins: it is what the user connected with; the session row is a convenience copy.
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
