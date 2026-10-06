using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using FluentValidation;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Connectors;
using Munni.Api.Validation;

namespace Munni.Api.Lab;

/// <summary>The sign-in the bench starts: the manifest's inputs, the party's config, a label, where to run it.</summary>
public sealed record LabLoginRequest(
    Dictionary<string, string>? Inputs = null,
    Dictionary<string, string>? Config = null,
    string? Label = null,
    string? CredentialBundle = null,
    /// <summary><c>fleet</c>, an agent id, or nothing — the control plane's own vocabulary.</summary>
    string? PreferAgent = null,
    /// <summary>Record the run (#441 L3): the browser's and the HTTP client's calls, redacted, kept on the control plane for the operator.</summary>
    bool Record = false);

/// <summary>A fetch from the bench: the resource and its params as the manifest spells them (a date, a list of includes, the accounts).</summary>
public sealed record LabFetchRequest(string Resource, Dictionary<string, JsonNode?>? Params = null, bool Record = false);

/// <summary>An explore run (#441 L3): a browser on a fleet agent opened at this address, driven from the lab's live view, recorded throughout.</summary>
public sealed record LabExploreRequest(string Url, string? Label = null, string? PreferAgent = null);

/// <summary>A lab session flipped into the party's canary.</summary>
public sealed record LabCanaryRequest(string Resource, int IntervalMinutes);

/// <summary>A lab session as the bench lists it. Never the bundle.</summary>
public sealed record LabSessionDto(
    string SessionId,
    string Provider,
    string? Label,
    string State,
    bool HasBundle,
    string? PreferAgent,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastUsedAt,
    string? LastError);

public sealed class LabLoginRequestValidator : AbstractValidator<LabLoginRequest>
{
    public LabLoginRequestValidator()
    {
        RuleFor(r => r.Label).MaximumLength(128);
        RuleFor(r => r.CredentialBundle).MaximumLength(ConnectorLoginRequest.BundleMaximumLength);
        RuleFor(r => r.PreferAgent).MaximumLength(64).Matches("^[A-Za-z0-9._:-]+$").When(r => !string.IsNullOrEmpty(r.PreferAgent));
        RuleFor(r => r.Inputs).Must(i => i is null || i.Count <= 32).WithMessage("too many inputs");
        RuleFor(r => r.Config).Must(c => c is null || c.Count <= 32).WithMessage("too many config values");
    }
}

public sealed class LabExploreRequestValidator : AbstractValidator<LabExploreRequest>
{
    public LabExploreRequestValidator()
    {
        RuleFor(r => r.Url).NotEmpty().MaximumLength(2048).Must(u => Uri.TryCreate(u, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            .WithMessage("the address must be absolute http(s)");
        RuleFor(r => r.Label).MaximumLength(128);
        RuleFor(r => r.PreferAgent).MaximumLength(64).Matches("^[A-Za-z0-9._:-]+$").When(r => !string.IsNullOrEmpty(r.PreferAgent));
    }
}

public sealed class LabFetchRequestValidator : AbstractValidator<LabFetchRequest>
{
    public LabFetchRequestValidator()
    {
        RuleFor(r => r.Resource).NotEmpty().MaximumLength(64).Matches("^[a-z0-9_-]+$");
        RuleFor(r => r.Params).Must(p => p is null || p.Count <= 32).WithMessage("too many params");
    }
}

public sealed class LabCanaryRequestValidator : AbstractValidator<LabCanaryRequest>
{
    public LabCanaryRequestValidator()
    {
        RuleFor(r => r.Resource).NotEmpty().MaximumLength(64).Matches("^[a-z0-9_-]+$");
        RuleFor(r => r.IntervalMinutes).InclusiveBetween(15, 10_080);
    }
}

/// <summary>
/// The test bench (#441 L2): the operator connects to a party under the LAB
/// subject, answers what it asks — a code, a picture, the live browser —
/// says where the run happens, fetches a resource and reads the records
/// back, keeps the session for tomorrow, and flips it into the party's
/// canary. Everything goes to the control plane with <c>X-Connector-Trigger:
/// lab</c>, so a failure's picture is the operator's at once; nothing is
/// ingested, bound to a person, or pushed onto anyone's event stream.
/// </summary>
public static class LabBenchEndpoints
{
    private const string Trigger = "lab";
    private const string BundleField = "bundle";
    private const string Native = "native";
    private const string ExploreProviderId = "explore";

    public static void Map(RouteGroupBuilder lab)
    {
        var bench = lab.MapGroup("/bench");

        bench.MapGet("/sessions", Sessions);
        bench.MapPost("/{provider}/login", Login).WithValidation<LabLoginRequest>();
        bench.MapPost("/explore", Explore).WithValidation<LabExploreRequest>();
        bench.MapGet("/{provider}/login/{sessionId}", GetSession);
        bench.MapPost("/{provider}/login/{sessionId}/answer", Answer).WithValidation<ConnectorAnswerRequest>();
        bench.MapPost("/{provider}/login/{sessionId}/cancel", Cancel);
        bench.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/image", ChallengeImage);
        bench.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame", LiveFrame);
        bench.MapPost("/{provider}/login/{sessionId}/challenges/{challengeId}/live/input", LiveInput);
        bench.MapPost("/sessions/{sessionId}/fetch", Fetch).WithValidation<LabFetchRequest>();
        bench.MapGet("/{provider}/jobs/{jobId}", Job);
        bench.MapPost("/{provider}/jobs/{jobId}/answer", AnswerJob).WithValidation<ConnectorAnswerRequest>();
        bench.MapPost("/sessions/{sessionId}/canary", MakeCanary).WithValidation<LabCanaryRequest>();
        bench.MapDelete("/sessions/{sessionId}", Disconnect);

        LabRetentionEndpoints.Map(bench);
    }

    private static async Task<IResult> Sessions(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        var rows = await relay.Db.LabSessions.AsNoTracking()
            .Where(s => s.UserId == userId)
            .OrderByDescending(s => s.CreatedAt)
            .Select(s => new LabSessionDto(s.Id, s.Provider, s.Label, s.State, s.Bundle != null, s.PreferAgent, s.CreatedAt, s.LastUsedAt, s.LastError))
            .ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> Login(string provider, LabLoginRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var subject = relay.LabSubjectOf(http);
        var reply = await relay.Client.PostAsync($"v1/{provider}/login", new ConnectorCall
        {
            Subject = subject,
            Body = new WireLogin(
                subject,
                request.Inputs ?? new Dictionary<string, string>(StringComparer.Ordinal),
                request.Config ?? new Dictionary<string, string>(StringComparer.Ordinal),
                request.Label,
                request.CredentialBundle,
                request.PreferAgent,
                request.Record),
            DeviceClass = Native,
            Trigger = Trigger,
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        var view = reply.Object;
        var sessionId = view.Text("session_id") ?? throw new InvalidOperationException("the connector answered a login without a session id");
        var now = relay.Time.GetUtcNow();
        var row = new LabSession
        {
            Id = sessionId,
            UserId = http.GetUserId(),
            Provider = provider,
            Label = request.Label,
            State = view.Text("state") ?? "queued",
            PreferAgent = request.PreferAgent,
            CreatedAt = now,
            LastUsedAt = now,
        };
        relay.Db.LabSessions.Add(row);
        Keep(row, view, now);
        await relay.Db.SaveChangesAsync(ct);
        return Results.Json(Strip(view), statusCode: (int)reply.Status);
    }

    /// <summary>
    /// An explore run (#441 L3) is a sign-in to the control plane's own
    /// <c>explore</c> provider with the address as its one input, recorded
    /// from the first byte: the session it makes is a lab session like any
    /// other, and the recording lands in the job history.
    /// </summary>
    private static Task<IResult> Explore(LabExploreRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct) =>
        Login(
            ExploreProviderId,
            new LabLoginRequest(
                new Dictionary<string, string>(StringComparer.Ordinal) { ["url"] = request.Url.Trim() },
                null,
                request.Label,
                null,
                request.PreferAgent,
                Record: true),
            http,
            relay,
            ct);

    private static async Task<IResult> GetSession(string provider, string sessionId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, provider, sessionId, ct);
        if (row is null) return Unknown(http);

        var reply = await relay.Client.GetAsync($"v1/{provider}/login/{sessionId}", new ConnectorCall { Subject = relay.LabSubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        Keep(row, reply.Object, relay.Time.GetUtcNow());
        await relay.Db.SaveChangesAsync(ct);
        return Results.Json(Strip(reply.Object));
    }

    private static async Task<IResult> Answer(
        string provider, string sessionId, ConnectorAnswerRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, provider, sessionId, ct);
        if (row is null) return Unknown(http);

        var reply = await relay.Client.PostAsync($"v1/{provider}/login/{sessionId}/answer", new ConnectorCall
        {
            Subject = relay.LabSubjectOf(http),
            Body = new WireAnswer(request.ChallengeId, request.Value ?? string.Empty),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        Keep(row, reply.Object, relay.Time.GetUtcNow());
        await relay.Db.SaveChangesAsync(ct);
        return Results.Json(Strip(reply.Object), statusCode: (int)reply.Status);
    }

    private static async Task<IResult> Cancel(string provider, string sessionId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, provider, sessionId, ct);
        if (row is null) return Unknown(http);

        var reply = await relay.Client.PostAsync($"v1/{provider}/login/{sessionId}/cancel", new ConnectorCall { Subject = relay.LabSubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        Keep(row, reply.Object, relay.Time.GetUtcNow());
        await relay.Db.SaveChangesAsync(ct);
        return Results.Json(Strip(reply.Object), statusCode: (int)reply.Status);
    }

    private static async Task<IResult> ChallengeImage(
        string provider, string sessionId, string challengeId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        if (await OwnAsync(relay, http, provider, sessionId, ct) is null) return Unknown(http);

        var reply = await relay.Client.GetAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/image",
            new ConnectorCall { Subject = relay.LabSubjectOf(http) }, ct);
        if (!reply.IsSuccess || reply.Bytes is null) return ConnectorRelayEndpoints.Relay(http, reply);

        http.Response.Headers.CacheControl = "no-store";
        return Results.File(reply.Bytes, reply.ContentType ?? "image/png");
    }

    /// <summary>The live view's newest frame past <c>after</c>, as the consumer relay serves it: the bytes and every <c>X-Live-*</c> header.</summary>
    private static async Task<IResult> LiveFrame(
        string provider, string sessionId, string challengeId, [FromQuery] long after, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        if (await OwnAsync(relay, http, provider, sessionId, ct) is null) return Unknown(http);

        var reply = await relay.Client.GetAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame?after={Math.Max(0, after).ToString(CultureInfo.InvariantCulture)}",
            new ConnectorCall { Subject = relay.LabSubjectOf(http) }, ct);
        if (reply.Status == HttpStatusCode.NoContent) return Results.NoContent();
        if (!reply.IsSuccess || reply.Bytes is null) return ConnectorRelayEndpoints.Relay(http, reply);

        foreach (var (name, value) in reply.Headers)
        {
            if (name.StartsWith("X-Live-", StringComparison.OrdinalIgnoreCase)) http.Response.Headers[name] = value;
        }
        http.Response.Headers.CacheControl = "no-store";
        return Results.File(reply.Bytes, reply.ContentType ?? "image/jpeg");
    }

    private static async Task<IResult> LiveInput(
        string provider, string sessionId, string challengeId, [FromBody] JsonObject batch, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        if (await OwnAsync(relay, http, provider, sessionId, ct) is null) return Unknown(http);

        var reply = await relay.Client.PostAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/input",
            new ConnectorCall { Subject = relay.LabSubjectOf(http), Body = ConnectorJson.ToSnake(batch) }, ct);
        return reply.IsSuccess ? Results.Accepted() : ConnectorRelayEndpoints.Relay(http, reply);
    }

    /// <summary>
    /// One round trip with the kept bundle: the records come back to the
    /// operator (camelCased, the bundle stripped and kept here when the party
    /// rotated it) and nothing is ingested; a run that outruns the window
    /// answers 202 with the job to follow through <c>…/jobs/{jobId}</c>.
    /// </summary>
    private static async Task<IResult> Fetch(string sessionId, LabFetchRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await relay.Db.LabSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == http.GetUserId(), ct);
        if (row is null) return Unknown(http);
        if (row.Bundle is null) return NoBundle(http);

        var subject = relay.LabSubjectOf(http);
        var reply = await relay.Client.PostAsync($"v1/{row.Provider}/{request.Resource}:fetch", new ConnectorCall
        {
            Subject = subject,
            Body = new WireOneShotFetch(subject, row.Bundle, request.Params ?? new Dictionary<string, JsonNode?>(StringComparer.Ordinal), request.Record),
            DeviceClass = Native,
            Trigger = Trigger,
        }, ct);

        row.LastUsedAt = relay.Time.GetUtcNow();
        if (!reply.IsSuccess)
        {
            row.LastError = reply.Error?.Code ?? ((int)reply.Status).ToString(CultureInfo.InvariantCulture);
            if (reply.Error?.Code is "session_expired" or "invalid_credentials" or "mfa_failed" or "consent_expired")
            {
                row.Bundle = null;
                row.State = "needs_reauth";
            }
            await relay.Db.SaveChangesAsync(ct);
            throw new ConnectorReplyException(reply);
        }

        row.LastError = null;
        KeepRotated(row, reply.Object);
        await relay.Db.SaveChangesAsync(ct);

        var view = Strip(reply.Object);
        view["accepted"] = reply.Status == HttpStatusCode.Accepted;
        return Results.Json(view, statusCode: (int)reply.Status);
    }

    /// <summary>A fetch that became a job, read back: the page once it succeeded, a rotated bundle kept here.</summary>
    private static async Task<IResult> Job(string provider, string jobId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync($"v1/{provider}/jobs/{jobId}", new ConnectorCall { Subject = relay.LabSubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        await KeepForJobAsync(relay, http, reply.Object, ct);
        return Results.Json(Strip(reply.Object));
    }

    private static async Task<IResult> AnswerJob(
        string provider, string jobId, ConnectorAnswerRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/jobs/{jobId}/answer", new ConnectorCall
        {
            Subject = relay.LabSubjectOf(http),
            Body = new WireAnswer(request.ChallengeId, request.Value ?? string.Empty),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        await KeepForJobAsync(relay, http, reply.Object, ct);
        return Results.Json(Strip(reply.Object), statusCode: (int)reply.Status);
    }

    /// <summary>
    /// The session becomes the party's canary: the control plane takes the
    /// bundle (sealed for the lab subject, which carries the canary marker)
    /// and rotates it on every run from now on, so the row here — whose copy
    /// would be stale after the first run — goes with it.
    /// </summary>
    private static async Task<IResult> MakeCanary(string sessionId, LabCanaryRequest request, HttpContext http, ConnectorRelay relay, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var row = await relay.Db.LabSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == http.GetUserId(), ct);
        if (row is null) return Unknown(http);
        if (row.Bundle is null) return NoBundle(http);

        var subject = relay.LabSubjectOf(http);
        var reply = await relay.Client.SendAsync(HttpMethod.Put, $"v1/admin/providers/{row.Provider}/canary", new ConnectorCall
        {
            Body = new WireCanary(subject, row.Bundle, request.Resource, request.IntervalMinutes),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        relay.Db.LabSessions.Remove(row);
        await relay.Db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} made lab session {Session} the canary of connector provider {Provider} ({Resource}, every {Minutes} min)",
                http.User.FindFirst("sub")?.Value ?? "-", sessionId, row.Provider, request.Resource, request.IntervalMinutes);
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>Signs out at the party where the bundle allows it, and forgets the session here either way.</summary>
    private static async Task<IResult> Disconnect(string sessionId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await relay.Db.LabSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == http.GetUserId(), ct);
        if (row is null) return Unknown(http);

        var reply = await relay.Client.DeleteAsync($"v1/{row.Provider}/sessions/{sessionId}", new ConnectorCall
        {
            Subject = relay.LabSubjectOf(http),
            Body = new WireDisconnect(row.Bundle),
        }, ct);

        relay.Db.LabSessions.Remove(row);
        await relay.Db.SaveChangesAsync(ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : ConnectorRelayEndpoints.Relay(http, reply);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static Task<LabSession?> OwnAsync(ConnectorRelay relay, HttpContext http, string provider, string sessionId, CancellationToken ct) =>
        relay.Db.LabSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == http.GetUserId() && s.Provider == provider, ct);

    /// <summary>What a session view said: its state, and the bundle on its single delivery.</summary>
    private static void Keep(LabSession row, JsonObject view, DateTimeOffset now)
    {
        if (view.Text("state") is { Length: > 0 } state) row.State = state;
        if (view.Text(BundleField) is { Length: > 0 } bundle) row.Bundle = bundle;
        row.LastUsedAt = now;
    }

    /// <summary>A fetch or a job that rotated the bundle: the newest one is the one that opens tomorrow.</summary>
    private static void KeepRotated(LabSession row, JsonObject view)
    {
        if (view["session"] is JsonObject session && session.Text(BundleField) is { Length: > 0 } rotated) row.Bundle = rotated;
    }

    private static async Task KeepForJobAsync(ConnectorRelay relay, HttpContext http, JsonObject view, CancellationToken ct)
    {
        if (view.Text("session_id") is not { Length: > 0 } sessionId) return;
        var row = await relay.Db.LabSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == http.GetUserId(), ct);
        if (row is null) return;
        KeepRotated(row, view);
        row.LastUsedAt = relay.Time.GetUtcNow();
        await relay.Db.SaveChangesAsync(ct);
    }

    /// <summary>The view for the browser: camelCased, without the bundles — those rest here, never in a tab.</summary>
    private static JsonObject Strip(JsonObject view)
    {
        var camel = (JsonObject)ConnectorJson.ToCamel(view)!;
        camel.Remove(BundleField);
        camel.Remove("credentialBundle");
        if (camel["session"] is JsonObject session) session.Remove(BundleField);
        return camel;
    }

    private static IResult Unknown(HttpContext http) => ConnectorRelayEndpoints.Envelope(
        http, StatusCodes.Status404NotFound,
        new ConnectorError("unsupported_resource", false, "none", "connect.error.unsupported_resource", null, null));

    private static IResult NoBundle(HttpContext http) => ConnectorRelayEndpoints.Envelope(
        http, StatusCodes.Status409Conflict,
        new ConnectorError("session_expired", false, "reauth", "connect.error.session_expired", null, null));
}

/// <summary>The one-shot fetch body as the control plane reads it (snake_case on the wire).</summary>
internal sealed record WireOneShotFetch(string Subject, string Bundle, Dictionary<string, JsonNode?> Params, bool Record = false);

/// <summary>The canary enrolment body: the lab subject (it carries the marker), the bundle, the resource, the interval.</summary>
internal sealed record WireCanary(string Subject, string Bundle, string Resource, int IntervalMinutes);
