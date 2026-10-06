using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Jobs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Primitives;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// The operator's view of what happened (#441 L1): every job with what it
/// did and how it ended, per-provider health over the last day, week and
/// month, the pictures failed runs left behind where people allowed it, and
/// a canary run on demand.
///
/// Under <c>/admin</c> beside the kill switch. The job list is the one
/// place a consumer's runs are visible to somebody who is not that
/// consumer, so what a row carries is decided here once: the columns that
/// say what happened, and none of the ones that say what was typed - inputs
/// and material are not on the view and have no field to arrive through.
/// </summary>
internal static class OperatorEndpoints
{
    private const int DefaultLimit = 100;
    private const int MaxLimit = 500;

    /// <summary>The windows health is reported over; the last one bounds what is read at all.</summary>
    private static readonly (string Key, TimeSpan Span)[] Windows =
    [
        ("24h", TimeSpan.FromHours(24)),
        ("7d", TimeSpan.FromDays(7)),
        ("30d", TimeSpan.FromDays(30)),
    ];

    private static readonly IReadOnlyDictionary<string, string> EmptyConfig =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public static void Map(IEndpointRouteBuilder admin)
    {
        admin.MapGet("/jobs", ListAsync);
        admin.MapGet("/jobs/{jobId}", OneAsync);
        admin.MapGet("/jobs/{jobId}/artifacts/screenshot", ScreenshotAsync)
            .Produces<byte[]>(StatusCodes.Status200OK, "image/png");
        admin.MapGet("/health", HealthAsync);
        admin.MapPost("/canaries/{id}/run", RunCanaryAsync);
    }

    /// <summary>
    /// Newest first, narrowed by <c>provider</c>, <c>subject</c>, <c>session</c>,
    /// <c>state</c>, <c>kind</c>, <c>trigger</c> (<c>none</c> for the rows
    /// without one), <c>code</c>, <c>since</c> and <c>before</c>; at most
    /// <c>limit</c> rows (100, up to 500), and the body says when the limit
    /// cut the list.
    /// </summary>
    private static async Task<ConnectorJsonResult<JobListResponse>> ListAsync(
        HttpContext http,
        ConnectorDbContext db,
        CancellationToken ct)
    {
        var q = http.Request.Query;

        var query = db.Jobs.AsNoTracking()
            .Join(db.Sessions.AsNoTracking(), j => j.SessionId, s => s.Id, (j, s) => new { Job = j, s.Subject });

        if (Value(q, "provider") is { } provider) query = query.Where(x => x.Job.ProviderId == provider);
        if (Value(q, "subject") is { } subject) query = query.Where(x => x.Subject == subject);
        if (Value(q, "session") is { } session) query = query.Where(x => x.Job.SessionId == session);

        if (Value(q, "state") is { } rawState)
        {
            var state = ParseEnum<JobState>(rawState, "state");
            query = query.Where(x => x.Job.State == state);
        }

        if (Value(q, "kind") is { } rawKind)
        {
            var kind = ParseEnum<JobKind>(rawKind, "kind");
            query = query.Where(x => x.Job.Kind == kind);
        }

        if (Value(q, "trigger") is { } trigger)
        {
            query = trigger == "none"
                ? query.Where(x => x.Job.Trigger == null)
                : query.Where(x => x.Job.Trigger == trigger);
        }

        if (Value(q, "code") is { } rawCode)
        {
            var code = ParseCode(rawCode);
            query = query.Where(x => x.Job.ErrorCode == code);
        }

        if (Value(q, "since") is { } rawSince)
        {
            var since = ParseMoment(rawSince, "since");
            query = query.Where(x => x.Job.CreatedAt >= since);
        }

        if (Value(q, "before") is { } rawBefore)
        {
            var before = ParseMoment(rawBefore, "before");
            query = query.Where(x => x.Job.CreatedAt < before);
        }

        var limit = Limit(q);

        // One past the limit, so "there is more" is a fact read off the
        // database rather than a guess made from a full page.
        var rows = await query
            .OrderByDescending(x => x.Job.CreatedAt)
            .ThenByDescending(x => x.Job.Id)
            .Take(limit + 1)
            .ToListAsync(ct);

        var truncated = rows.Count > limit;
        if (truncated) rows = rows.Take(limit).ToList();

        var ids = rows.Select(r => r.Job.Id).ToList();
        var kept = await db.JobArtifacts.AsNoTracking()
            .Where(a => ids.Contains(a.JobId))
            .ToDictionaryAsync(a => a.JobId, StringComparer.Ordinal, ct);

        return ConnectorResults.Json(new JobListResponse
        {
            Jobs = [.. rows.Select(r => View(r.Job, r.Subject, kept.GetValueOrDefault(r.Job.Id)))],
            Truncated = truncated,
        });
    }

    private static async Task<ConnectorJsonResult<OperatorJobView>> OneAsync(
        string jobId,
        ConnectorDbContext db,
        CancellationToken ct)
    {
        var row = await db.Jobs.AsNoTracking()
            .Where(j => j.Id == jobId)
            .Join(db.Sessions.AsNoTracking(), j => j.SessionId, s => s.Id, (j, s) => new { Job = j, s.Subject })
            .FirstOrDefaultAsync(ct)
            ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");

        var kept = await db.JobArtifacts.AsNoTracking().FirstOrDefaultAsync(a => a.JobId == jobId, ct);

        return ConnectorResults.Json(View(row.Job, row.Subject, kept));
    }

    /// <summary>
    /// The picture, only once the person said the operator may see it - or
    /// when the run was the operator's own. A pending picture answers exactly
    /// as a job that never had one, so the route tells nobody that a person
    /// is being asked.
    /// </summary>
    private static async Task<IResult> ScreenshotAsync(
        HttpContext http,
        string jobId,
        JobArtifactService artifacts,
        CancellationToken ct)
    {
        var kept = await artifacts.RetainedAsync(jobId, ct);

        if (kept?.Screenshot is not { Length: > 0 } png)
        {
            throw ConnectorException.Unsupported($"job '{jobId}' has no picture the operator may see");
        }

        http.Response.Headers.CacheControl = "no-store";
        return Results.File(png, "image/png");
    }

    /// <summary>
    /// What happened to every provider's runs over the last day, week and
    /// month, read off the month's jobs in one pass: outcomes, failures by
    /// code and by who asked, the people whose run failed, the sessions that
    /// say something about them, the canary's last word, and the reports
    /// waiting to be read.
    /// </summary>
    private static async Task<ConnectorJsonResult<HealthReportResponse>> HealthAsync(
        IProviderRegistry registry,
        ProviderStatusService statuses,
        CanaryService canaries,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var horizon = now - Windows[^1].Span;

        var health = await statuses.AllAsync(ct);
        var canaryRows = (await canaries.AllAsync(ct)).ToDictionary(c => c.ProviderId, StringComparer.Ordinal);

        var facts = await db.Jobs.AsNoTracking()
            .Where(j => j.CreatedAt >= horizon)
            .Select(j => new JobFact(j.Id, j.ProviderId, j.SessionId, j.State, j.ErrorCode, j.Trigger, j.CreatedAt, j.UpdatedAt))
            .ToListAsync(ct);

        var sessions = await db.Sessions.AsNoTracking()
            .GroupBy(s => new { s.ProviderId, s.State })
            .Select(g => new { g.Key.ProviderId, g.Key.State, Count = g.Count() })
            .ToListAsync(ct);

        var reports = await db.JobArtifacts.AsNoTracking()
            .GroupBy(a => new { a.ProviderId, a.Status })
            .Select(g => new { g.Key.ProviderId, g.Key.Status, Count = g.Count() })
            .ToListAsync(ct);

        var providers = new List<ProviderHealthView>();

        foreach (var providerId in registry.Manifests.Select(m => m.Id).OrderBy(id => id, StringComparer.Ordinal))
        {
            var mine = facts.Where(f => f.ProviderId == providerId).ToList();
            var lastFailure = mine
                .Where(f => f.State is JobState.Failed or JobState.Expired)
                .OrderByDescending(f => f.UpdatedAt)
                .FirstOrDefault();

            providers.Add(new ProviderHealthView
            {
                ProviderId = providerId,
                Status = health[providerId],
                Windows = Windows.ToDictionary(
                    w => w.Key,
                    w => WindowOf(mine.Where(f => f.CreatedAt >= now - w.Span)),
                    StringComparer.Ordinal),
                LastSuccessAt = mine
                    .Where(f => f.State == JobState.Succeeded)
                    .Select(f => (DateTimeOffset?)f.UpdatedAt)
                    .Max(),
                LastFailure = lastFailure is null
                    ? null
                    : new HealthFailure
                    {
                        JobId = lastFailure.Id,
                        Code = ErrorCatalog.Wire(lastFailure.Code ?? ErrorCode.Internal),
                        Trigger = lastFailure.Trigger,
                        At = lastFailure.UpdatedAt,
                    },
                Sessions = sessions
                    .Where(s => s.ProviderId == providerId)
                    .ToDictionary(s => Wire(s.State), s => s.Count, StringComparer.Ordinal),
                Canary = canaryRows.TryGetValue(providerId, out var canary) ? CanaryView.From(canary) : null,
                Reports = reports
                    .Where(r => r.ProviderId == providerId && r.Status == ArtifactStatus.Retained)
                    .Sum(r => r.Count),
                PendingReports = reports
                    .Where(r => r.ProviderId == providerId && r.Status == ArtifactStatus.Pending)
                    .Sum(r => r.Count),
            });
        }

        return ConnectorResults.Json(new HealthReportResponse { GeneratedAt = now, Providers = providers });
    }

    /// <summary>
    /// The canary now, not on its next due minute. The run is a real job that
    /// takes as long as the provider does; the view names it, so the caller
    /// follows it rather than waiting here.
    /// </summary>
    private static async Task<ConnectorJsonResult<CanaryView>> RunCanaryAsync(string id, CanaryScheduler scheduler, CancellationToken ct) =>
        ConnectorResults.Json(await scheduler.RunNowAsync(id, ct));

    // ---- the view ----------------------------------------------------------

    /// <summary>One job as the operator reads it. Inputs and material have no field here; see the type's summary.</summary>
    internal static OperatorJobView View(JobRow job, string subject, JobArtifactRow? kept) => new()
    {
        JobId = job.Id,
        SessionId = job.SessionId,
        Subject = subject,
        ProviderId = job.ProviderId,
        Kind = job.Kind,
        State = job.State,
        Resource = job.ResourceId,
        Trigger = job.Trigger,
        Progress = ProgressView.From(job),
        Attempts = job.Attempts,
        CredentialSubmitted = job.CredentialSubmitted,
        Complete = job.Complete,
        AgentId = job.LeaseOwner,
        ProfileId = job.ProfileId,
        FleetOnly = job.FleetOnly,
        CreatedAt = job.CreatedAt,
        UpdatedAt = job.UpdatedAt,
        Error = job.ErrorCode is { } code ? new ConnectorException(code, job.ErrorDetail).ToError() : null,
        ErrorDetail = job.ErrorDetail,
        Notes = ConnectorJson.DeserializeOr<IReadOnlyList<string>>(job.NotesJson, []),
        Params = ConnectorJson.DeserializeOr<JsonNode?>(job.ParamsJson, null),
        Config = ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(job.ConfigJson, EmptyConfig),
        Artifacts = ArtifactsWord(kept),
        DomDigest = kept is { Status: ArtifactStatus.Retained } ? kept.DomDigest : null,
        HasScreenshot = kept is { Status: ArtifactStatus.Retained, Screenshot: not null },
        ArtifactsExpireAt = kept?.ExpiresAt,
    };

    private static string ArtifactsWord(JobArtifactRow? kept) => kept?.Status switch
    {
        null => "none",
        ArtifactStatus.Pending => "pending",
        _ => "retained",
    };

    // ---- health arithmetic ------------------------------------------------

    private sealed record JobFact(
        string Id,
        string ProviderId,
        string SessionId,
        JobState State,
        ErrorCode? Code,
        string? Trigger,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    private static HealthWindow WindowOf(IEnumerable<JobFact> facts)
    {
        var byCode = new Dictionary<string, int>(StringComparer.Ordinal);
        var byTrigger = new Dictionary<string, int>(StringComparer.Ordinal);
        var people = new HashSet<string>(StringComparer.Ordinal);
        int total = 0, succeeded = 0, failed = 0, expired = 0, open = 0;

        foreach (var fact in facts)
        {
            total++;
            Bump(byTrigger, TriggerWord(fact.Trigger));

            switch (fact.State)
            {
                case JobState.Succeeded:
                    succeeded++;
                    break;
                case JobState.Failed or JobState.Expired:
                    if (fact.State == JobState.Failed) failed++;
                    else expired++;
                    if (fact.Code is { } code) Bump(byCode, ErrorCatalog.Wire(code));
                    // Lab and canary runs are the operator's: a failure there is
                    // a finding, not a person who could not sync.
                    if (!IsOperatorRun(fact.Trigger)) people.Add(fact.SessionId);
                    break;
                default:
                    open++;
                    break;
            }
        }

        return new HealthWindow
        {
            Total = total,
            Succeeded = succeeded,
            Failed = failed,
            Expired = expired,
            Open = open,
            ByCode = byCode,
            ByTrigger = byTrigger,
            PeopleAffected = people.Count,
        };
    }

    private static void Bump(Dictionary<string, int> counts, string key) =>
        counts[key] = counts.GetValueOrDefault(key) + 1;

    private static string TriggerWord(string? trigger) =>
        trigger is JobRow.UserTrigger or JobRow.ScheduleTrigger or JobRow.LabTrigger or JobRow.CanaryTrigger
            ? trigger
            : "other";

    private static bool IsOperatorRun(string? trigger) => trigger is JobRow.LabTrigger or JobRow.CanaryTrigger;

    // ---- the query string ---------------------------------------------------

    private static string? Value(IQueryCollection query, string key) =>
        query.TryGetValue(key, out StringValues values) && values.ToString().Trim() is { Length: > 0 } value
            ? value
            : null;

    private static int Limit(IQueryCollection query)
    {
        var raw = Value(query, "limit");
        if (raw is null) return DefaultLimit;

        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var limit) && limit > 0
            ? Math.Min(limit, MaxLimit)
            : throw ConnectorException.InvalidRequest("limit must be a positive number");
    }

    /// <summary>The wire form of an enum member, as the JSON would spell it.</summary>
    private static string Wire<T>(T value) where T : struct, Enum =>
        JsonNamingPolicy.SnakeCaseLower.ConvertName(value.ToString());

    /// <summary>An enum from its wire form (<c>awaiting_input</c>) or its name; a typo is a refusal rather than an empty list.</summary>
    private static T ParseEnum<T>(string raw, string what) where T : struct, Enum =>
        Enum.GetValues<T>()
            .Where(candidate => string.Equals(Wire(candidate), raw, StringComparison.OrdinalIgnoreCase)
                                || string.Equals(candidate.ToString(), raw, StringComparison.OrdinalIgnoreCase))
            .Select(candidate => (T?)candidate)
            .FirstOrDefault()
        ?? throw ConnectorException.InvalidRequest($"unknown {what} '{raw}'");

    private static ErrorCode ParseCode(string raw) =>
        Enum.GetValues<ErrorCode>()
            .Where(candidate => string.Equals(ErrorCatalog.Wire(candidate), raw, StringComparison.OrdinalIgnoreCase))
            .Select(candidate => (ErrorCode?)candidate)
            .FirstOrDefault()
        ?? throw ConnectorException.InvalidRequest($"unknown code '{raw}'");

    private static DateTimeOffset ParseMoment(string raw, string what) =>
        DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var moment)
            ? moment
            : throw ConnectorException.InvalidRequest($"{what} must be an ISO-8601 moment");
}
