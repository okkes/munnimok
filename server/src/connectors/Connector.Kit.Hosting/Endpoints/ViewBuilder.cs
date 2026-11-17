using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Endpoints;

/// One type because the login response, poll and SSE stream render the same session: three renderings drift into three APIs.
public sealed class ViewBuilder(
    ConnectorDbContext db,
    ChallengeService challenges,
    ResultService results,
    JobArtifactService artifacts,
    TimeProvider time)
{
    /// Newest job, because a re-auth creates a second.
    public Task<JobRow?> LatestJobAsync(string sessionId, CancellationToken ct) =>
        db.Jobs.Where(j => j.SessionId == sessionId)
            .OrderByDescending(j => j.CreatedAt)
            .ThenByDescending(j => j.Id)
            .FirstOrDefaultAsync(ct);

    /// <paramref name="deliverBundle"/> hands over the sealed bundle and clears it: one left here would be a credential at rest.
    public async Task<SessionResponse> SessionAsync(SessionRow session, bool deliverBundle, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);

        var job = await LatestJobAsync(session.Id, ct);
        var pending = job is null ? null : await challenges.PendingAsync(job.Id, ct);

        string? bundle = null;
        string? credentials = null;

        if (deliverBundle && (session.PendingBundle ?? session.PendingCredentialBundle) is not null)
        {
            // the credential bundle follows the session bundle's rule: handed over once, then forgotten
            bundle = session.PendingBundle;
            credentials = session.PendingCredentialBundle;

            session.PendingBundle = null;
            session.PendingCredentialBundle = null;
            session.UpdatedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
        }

        return new SessionResponse
        {
            SessionId = session.Id,
            State = session.State,
            Bundle = bundle,
            CredentialBundle = credentials,
            ExpiresAt = session.ExpiresAt,
            ProviderAccount = ConnectorJson.DeserializeOr<ProviderAccount?>(session.ProviderAccountJson, null),
            Challenge = pending is null ? null : ChallengeView.From(pending, session.ProviderId, session.Id),
            Progress = job is null ? null : await ProgressAsync(job, ct),
            Custody = session.DeviceClass == DeviceClass.Web ? "ephemeral" : null,
            Label = session.Label,
            Config = ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(session.ConfigJson, Empty),

            Notes = job is null
                ? []
                : ConnectorJson.DeserializeOr<IReadOnlyList<string>>(job.NotesJson, []),
            ArtifactsJobId = await PendingArtifactsAsync(job, ct),
        };
    }

    public async Task<JobResponse> JobAsync(JobRow job, bool deliverBundle, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);

        var pending = await challenges.PendingAsync(job.Id, ct);
        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct);

        StagedPage? page = null;
        if (job.State == JobState.Succeeded) page = await results.ReadAsync(job.Id, ct);

        string? bundle = null;
        if (deliverBundle && job.State == JobState.Succeeded && session?.PendingBundle is { } issued)
        {
            bundle = issued;
            session.PendingBundle = null;
            session.UpdatedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
        }

        return new JobResponse
        {
            JobId = job.Id,
            SessionId = job.SessionId,
            State = job.State,
            Resource = job.ResourceId,
            Progress = await ProgressAsync(job, ct),
            Challenge = pending is null
                ? null
                : ChallengeView.From(pending, job.ProviderId, job.SessionId),
            Data = page?.Data,
            Cursor = page?.Cursor,
            Complete = job.Complete,
            Notes = Infrastructure.ConnectorJson.DeserializeOr<IReadOnlyList<string>>(job.NotesJson, []),
            Session = bundle is null ? null : new SessionBundle { Bundle = bundle, Rotated = true },
            Error = job.ErrorCode is { } code
                ? new ConnectorException(code, job.ErrorDetail).ToError()
                : null,
            ArtifactsJobId = await PendingArtifactsAsync(job, ct),
        };
    }

    public async Task<JobAcceptedResponse> AcceptedAsync(JobRow job, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);
        var pending = await challenges.PendingAsync(job.Id, ct);

        return new JobAcceptedResponse
        {
            JobId = job.Id,
            State = job.State,
            Poll = $"/v1/{job.ProviderId}/jobs/{job.Id}",
            Events = $"/v1/{job.ProviderId}/jobs/{job.Id}/events",
            Challenge = pending is null ? null : ChallengeView.From(pending, job.ProviderId, job.SessionId),
            Progress = await ProgressAsync(job, ct),
        };
    }

    /// Place in line while queued: the queued jobs older than it, whatever their party (the fleet takes the oldest first).
    private async Task<ProgressView> ProgressAsync(JobRow job, CancellationToken ct)
    {
        var view = ProgressView.From(job);
        if (job.State != JobState.Queued) return view;

        var ahead = await db.Jobs.CountAsync(j => j.State == JobState.Queued && j.CreatedAt < job.CreatedAt, ct);
        return view with { Ahead = ahead };
    }

    /// Only for a run that ended badly and only while the question is open, so the consumer never asks about a run that
    /// went fine since (#441 L1).
    private async Task<string?> PendingArtifactsAsync(JobRow? job, CancellationToken ct) =>
        job is { State: JobState.Failed or JobState.Expired } && await artifacts.IsPendingAsync(job.Id, ct)
            ? job.Id
            : null;

    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
