using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Cors;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

// ConnectionId is the client's stable id, the same on a re-login; Inputs are sealed by the connector, never stored here
public sealed record ConnectorLoginRequest(
    string ConnectionId,
    Dictionary<string, string>? Inputs = null,
    string? CredentialBundle = null,
    Dictionary<string, string>? Config = null,
    string? Label = null,
    string? PreferAgent = null,
    string? IdempotencyKey = null)
{
    /// <summary>A sealed browser profile can be large; a bundle beyond this is not one.</summary>
    public const int BundleMaximumLength = 262_144;
}

public sealed record ConnectorAnswerRequest(string ChallengeId, string? Value = null);

public sealed record ConnectorDisconnectRequest(string? Bundle = null);

public sealed record ConnectorEnrollmentRequest(string Name);

// ids and state, nothing a bundle rides in; Scheduled: the relay keeps a household-agent bundle and syncs it itself (§5.5)
public sealed record ConnectorSessionDto(
    string SessionId,
    string Provider,
    string ConnectionId,
    string State,
    string? Label,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt,
    bool Scheduled,
    DateTimeOffset? LastScheduledSyncAt,
    string? LastScheduleError,
    // the party asked for a pause: the scheduler holds off until then
    DateTimeOffset? ScheduleNotBefore = null,
    // a scheduled run failed and left a picture waiting on the person's answer (#441 L1)
    string? ArtifactsJobId = null);

public sealed record ConnectorEnrollmentDto(string Code, DateTimeOffset ExpiresAt, string? ControlPlaneUrl, string? ComposeCommand);

// #524: per person; an IBAN feed two people connected carries one row, whose connection stamp names whoever fetched it last
public sealed record ConnectorAccountLinkDto(string ConnectionId, string Provider, string FeedSpaceId, string AccountId);

// the wire encoding renames these to snake_case; dictionary keys stay as the user typed them
internal sealed record WireLogin(
    string Subject,
    Dictionary<string, string> Inputs,
    Dictionary<string, string> Config,
    string? Label,
    string? CredentialBundle,
    string? PreferAgent,
    bool Record = false);

internal sealed record WireAnswer(string ChallengeId, string Value);

internal sealed record WireDisconnect(string? Bundle);

internal sealed record WireEnrollment(string Subject, string Name);

// #420 A2: the subject is the relay's, never the client's
internal sealed record WirePrivateAgentRequest(string Subject);

// #367: the subject is minted here, never sent by the client, and a session route answers only its owner.
// bundles pass through memory only, the binding table holds ids and state alone
public static partial class ConnectorRelayEndpoints
{
    public const string Prefix = "/connectors";

    internal const string SessionIdField = "session_id";
    internal const string StateField = "state";
    internal const string LabelField = "label";

    /// <summary>Session states in which nothing is running any more; every other state has a stream worth following.</summary>
    private static readonly HashSet<string> SettledSessionStates = new(StringComparer.Ordinal)
    {
        "active", "needs_reauth", "blocked", "disabled", "failed", "expired",
    };

    /// <summary>Session states after which the connector keeps nothing usable, so neither does the relay.</summary>
    private static readonly HashSet<string> GoneSessionStates = new(StringComparer.Ordinal) { "expired", "disabled" };

    public static void MapConnectors(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(Prefix)
            .RequireAuthorization()
            .WithSafeRouteParams()
            .AddEndpointFilter<ConnectorReplyFilter>();

        group.MapGet("", Overview);
        group.MapGet("/providers", Catalogue);
        group.MapGet("/sessions", MySessions);
        group.MapGet("/accounts", MyAccounts);
        group.MapGet("/{provider}/options/{field}", Options);
        // a public brand image an <img> tag fetches: no session to bind, nothing of anyone's in it.
        // It names its own CORS answer (OptionLogo), so the origin policy stays off it
        group.MapGet("/{provider}/options/{field}/{token}/logo", OptionLogo).AllowAnonymous().WithMetadata(new DisableCorsAttribute());

        group.MapPost("/{provider}/login", Login).WithValidation<ConnectorLoginRequest>();
        group.MapGet("/{provider}/login/{sessionId}", GetSession);
        group.MapPost("/{provider}/login/{sessionId}/answer", Answer).WithValidation<ConnectorAnswerRequest>();
        group.MapPost("/{provider}/login/{sessionId}/cancel", Cancel);
        group.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/image", ChallengeImage);
        group.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame", LiveFrame);
        group.MapGet("/{provider}/login/{sessionId}/challenges/{challengeId}/live/stream", LiveStream);
        group.MapPost("/{provider}/login/{sessionId}/challenges/{challengeId}/live/input", LiveInput);
        group.MapDelete("/{provider}/sessions/{sessionId}", Disconnect);

        MapSync(group);
        MapAgents(group);
    }

    private static async Task<IResult> Overview(ConnectorRelay relay, ConnectorCatalogue catalogue, ConnectorOptions options, CancellationToken ct)
    {
        var (_, document) = await catalogue.GetAsync(relay.Client, ct);
        var providers = document["providers"] as JsonArray;
        return Results.Ok(new
        {
            service = ConnectorJson.ToCamel(document["service"]),
            providers = providers?.Count ?? 0,
            householdAgents = !string.IsNullOrWhiteSpace(options.AgentPublicUrl),
        });
    }

    // revalidated with the connector's own ETag; stand-in parties only where this environment offers them
    private static async Task<IResult> Catalogue(HttpContext http, ConnectorRelay relay, ConnectorCatalogue catalogue, ConnectorOptions options, CancellationToken ct)
    {
        var (upstream, document) = await catalogue.GetAsync(relay.Client, ct);
        var etag = CatalogueTag(upstream, options.OfferFixtures);
        if (etag is not null)
        {
            if (string.Equals(http.Request.Headers.IfNoneMatch.ToString(), etag, StringComparison.Ordinal))
            {
                return Results.StatusCode(StatusCodes.Status304NotModified);
            }
            http.Response.Headers.ETag = etag;
        }
        var view = ConnectorJson.ToCamel(document);
        if (!options.OfferFixtures && view?["providers"] is JsonArray providers)
        {
            foreach (var fixture in providers.Where(IsFixture).ToList()) providers.Remove(fixture);
        }
        return Results.Json(view);
    }

    // the connector's ETag names its own document; what is served also depends on whether stand-ins are left out
    internal static string? CatalogueTag(string? upstream, bool offerFixtures) =>
        upstream is null || offerFixtures ? upstream : upstream.TrimEnd('"') + ";people\"";

    /// <summary>A stand-in party (#526): the manifest says so itself.</summary>
    internal static bool IsFixture(JsonNode? manifest) =>
        manifest is JsonObject node && node["fixture"] is JsonValue flag && flag.TryGetValue<bool>(out var fixture) && fixture;

    // #524: the references the ingest keeps per person, so the app files an account under the connection that fetches it
    private static async Task<IResult> MyAccounts(HttpContext http, ConnectorRelay relay)
    {
        var userId = http.GetUserId();
        var rows = await relay.Db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.ConnectionId != null && !a.Excluded)
            .Select(a => new ConnectorAccountLinkDto(a.ConnectionId!, a.Provider, a.FeedSpaceId, a.AccountEntityId))
            .Distinct()
            .ToListAsync();
        return Results.Ok(rows.OrderBy(r => r.ConnectionId, StringComparer.Ordinal).ThenBy(r => r.AccountId, StringComparer.Ordinal));
    }

    private static async Task<IResult> MySessions(HttpContext http, ConnectorRelay relay)
    {
        var userId = http.GetUserId();
        var rows = await relay.Db.ConnectorSessions
            .Where(s => s.UserId == userId)
            .OrderBy(s => s.CreatedAt)
            .Select(s => new ConnectorSessionDto(
                s.Id, s.Provider, s.ConnectionId, s.State, s.Label, s.CreatedAt, s.LastSeenAt,
                s.KeptBundle != null, s.LastScheduledSyncAt, s.LastScheduleError, s.ScheduleNotBefore, s.PendingArtifactsJobId))
            .ToListAsync();
        return Results.Ok(rows);
    }

    private static async Task<IResult> Login(
        string provider, ConnectorLoginRequest request, HttpContext http, ConnectorRelay relay, ConnectorOptions options, CancellationToken ct)
    {
        var userId = http.GetUserId();
        // a stand-in party this environment does not offer is no party a person may sign in to (#526)
        if (!options.OfferFixtures && IsFixture(await relay.Catalogue.ProviderAsync(relay.Client, provider, ct))) return UnknownSession(http);
        if (!relay.Budget.TrySpend(userId, ConnectorBudget.Login, out var retryAfter)) return BudgetExceeded(http, retryAfter);

        var subject = relay.Minter.For(userId);
        var reply = await relay.Client.PostAsync($"v1/{provider}/login", new ConnectorCall
        {
            Subject = subject,
            Body = new WireLogin(
                subject,
                request.Inputs ?? new Dictionary<string, string>(StringComparer.Ordinal),
                request.Config ?? new Dictionary<string, string>(StringComparer.Ordinal),
                request.Label,
                request.CredentialBundle,
                request.PreferAgent),
            DeviceClass = DeviceClassOf(http),
            IdempotencyKey = request.IdempotencyKey,
            Trigger = "user",
        }, ct);
        if (!reply.IsSuccess)
        {
            // agent_unavailable comes whether the party wanted the person's machine or munni's fleet; the app must not say
            // "start a household agent" when the fleet is missing (Albert Heijn without a pooled agent)
            var manifest = await relay.Catalogue.ProviderAsync(relay.Client, provider, ct);
            return Relay(http, reply.Error is { } err ? reply with { Error = ForParty(err, manifest) } : reply);
        }

        var view = reply.Object;
        var sessionId = view.Text(SessionIdField) ?? throw new InvalidOperationException("the connector answered a login without a session id");
        var row = await BindAsync(relay.Db, userId, provider, request.ConnectionId, view, relay.Time, ct);
        await KeepAsync(relay, provider, row, view, ct);
        FollowWhileRunning(relay.Bridge, userId, subject, provider, sessionId, view);
        return Results.Json(ConnectorJson.ToCamel(view), statusCode: (int)reply.Status);
    }

    private static async Task<IResult> GetSession(string provider, string sessionId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        var row = await OwnedAsync(relay.Db, userId, provider, sessionId);
        if (row is null) return UnknownSession(http);

        var subject = relay.Minter.For(userId);
        var reply = await relay.Client.GetAsync($"v1/{provider}/login/{sessionId}", new ConnectorCall { Subject = subject }, ct);
        if (!reply.IsSuccess) return await RelayOrForgetAsync(http, relay.Db, row, reply, ct);

        await TouchAsync(relay.Db, row, reply.Object, relay.Time, ct);
        await KeepAsync(relay, provider, row, reply.Object, ct);
        FollowWhileRunning(relay.Bridge, userId, subject, provider, sessionId, reply.Object);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> Answer(
        string provider, string sessionId, ConnectorAnswerRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        var row = await OwnedAsync(relay.Db, userId, provider, sessionId);
        if (row is null) return UnknownSession(http);

        var subject = relay.Minter.For(userId);
        var reply = await relay.Client.PostAsync($"v1/{provider}/login/{sessionId}/answer", new ConnectorCall
        {
            Subject = subject,
            Body = new WireAnswer(request.ChallengeId, request.Value ?? string.Empty),
        }, ct);
        if (!reply.IsSuccess) return await RelayOrForgetAsync(http, relay.Db, row, reply, ct);

        await TouchAsync(relay.Db, row, reply.Object, relay.Time, ct);
        FollowWhileRunning(relay.Bridge, userId, subject, provider, sessionId, reply.Object);
        return Results.Json(ConnectorJson.ToCamel(reply.Object), statusCode: (int)reply.Status);
    }

    private static async Task<IResult> Cancel(string provider, string sessionId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        var row = await OwnedAsync(relay.Db, userId, provider, sessionId);
        if (row is null) return UnknownSession(http);

        var reply = await relay.Client.PostAsync($"v1/{provider}/login/{sessionId}/cancel", new ConnectorCall { Subject = relay.Minter.For(userId) }, ct);
        if (!reply.IsSuccess) return await RelayOrForgetAsync(http, relay.Db, row, reply, ct);

        await TouchAsync(relay.Db, row, reply.Object, relay.Time, ct);
        return Results.Json(ConnectorJson.ToCamel(reply.Object), statusCode: (int)reply.Status);
    }

    private static async Task<IResult> ChallengeImage(
        string provider, string sessionId, string challengeId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        if (await OwnedAsync(relay.Db, userId, provider, sessionId) is null) return UnknownSession(http);

        var reply = await relay.Client.GetAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/image",
            new ConnectorCall { Subject = relay.Minter.For(userId) }, ct);
        if (!reply.IsSuccess || reply.Bytes is null) return Relay(http, reply);

        http.Response.Headers.CacheControl = "no-store";
        return Results.File(reply.Bytes, reply.ContentType ?? "image/png");
    }

    // the query passes through; the party answers from its own list (§15)
    private static async Task<IResult> Options(string provider, string field, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync(
            $"v1/{provider}/options/{field}{http.Request.QueryString}",
            new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : Relay(http, reply);
    }

    // the token is the value, base64url; anonymous because an image tag fetches it; the browser keeps it a month
    private static async Task<IResult> OptionLogo(
        string provider, string field, string token, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        // the same CORS answer to every asker (#655): the app shows the image with a plain tag AND reads its pixels
        // through CORS, and the browser serves the second from what it kept of the first
        http.Response.Headers.AccessControlAllowOrigin = "*";
        var reply = await relay.Client.GetAsync($"v1/{provider}/options/{field}/{token}/logo", new ConnectorCall(), ct);
        if (!reply.IsSuccess || reply.Bytes is null) return Relay(http, reply);

        http.Response.Headers.CacheControl = "public, max-age=2592000, immutable";
        return Results.File(reply.Bytes, reply.ContentType ?? "image/png");
    }

    private static async Task<IResult> LiveFrame(
        string provider, string sessionId, string challengeId, [FromQuery] long after, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        if (await OwnedAsync(relay.Db, userId, provider, sessionId) is null) return UnknownSession(http);

        var reply = await relay.Client.GetAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame?after={Math.Max(0, after).ToString(CultureInfo.InvariantCulture)}",
            new ConnectorCall { Subject = relay.Minter.For(userId) }, ct);
        if (reply.Status == HttpStatusCode.NoContent) return Results.NoContent();
        if (!reply.IsSuccess || reply.Bytes is null) return Relay(http, reply);

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
        var userId = http.GetUserId();
        if (await OwnedAsync(relay.Db, userId, provider, sessionId) is null) return UnknownSession(http);

        var reply = await relay.Client.PostAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/input",
            new ConnectorCall { Subject = relay.Minter.For(userId), Body = ConnectorJson.ToSnake(batch) }, ct);
        return reply.IsSuccess ? Results.Accepted() : Relay(http, reply);
    }

    // reaches the connector with or without a binding row: a caller that lost its row must still be able to disconnect
    private static async Task<IResult> Disconnect(
        string provider,
        string sessionId,
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] ConnectorDisconnectRequest? request,
        HttpContext http,
        ConnectorRelay relay,
        CancellationToken ct)
    {
        if (request?.Bundle is { Length: > ConnectorLoginRequest.BundleMaximumLength })
        {
            return Results.BadRequest(new { error = "bundle too large" });
        }

        var userId = http.GetUserId();
        var reply = await relay.Client.DeleteAsync($"v1/{provider}/sessions/{sessionId}", new ConnectorCall
        {
            Subject = relay.Minter.For(userId),
            Body = new WireDisconnect(request?.Bundle),
        }, ct);

        var row = await OwnedAsync(relay.Db, userId, provider, sessionId);
        if (row is not null && (reply.IsSuccess || reply.Error?.Code is "unsupported_resource" or "session_expired"))
        {
            relay.Db.ConnectorSessions.Remove(row);
            await relay.Db.SaveChangesAsync(ct);
        }

        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : Relay(http, reply);
    }

    private static void MapAgents(RouteGroupBuilder group)
    {
        group.MapGet("/agents", ListAgents);
        group.MapPost("/agents/enrollment", Enroll).WithValidation<ConnectorEnrollmentRequest>();
        group.MapDelete("/agents/{agentId}", RevokeAgent);
        group.MapGet("/agents/{agentId}/profiles", AgentProfiles);

        // #420 A2: the operator decides in the lab (ConnectorLabEndpoints)
        group.MapGet("/private-agents/mine", PrivateAgentMine);
        group.MapPost("/private-agents/requests", PrivateAgentRequest);
        group.MapDelete("/private-agents/requests/{requestId}", PrivateAgentWithdraw);
        group.MapDelete("/private-agents/mine", PrivateAgentGiveBack);
    }

    private static async Task<IResult> PrivateAgentMine(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync("v1/private-agents/mine", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : Relay(http, reply);
    }

    private static async Task<IResult> PrivateAgentRequest(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var subject = relay.SubjectOf(http);
        var reply = await relay.Client.PostAsync("v1/private-agents/requests", new ConnectorCall
        {
            Subject = subject,
            Body = new WirePrivateAgentRequest(subject),
        }, ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : Relay(http, reply);
    }

    private static async Task<IResult> PrivateAgentWithdraw(string requestId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.DeleteAsync($"v1/private-agents/requests/{requestId}", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.NoContent() : Relay(http, reply);
    }

    private static async Task<IResult> PrivateAgentGiveBack(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.DeleteAsync("v1/private-agents/mine", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.NoContent() : Relay(http, reply);
    }

    private static async Task<IResult> ListAgents(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync("v1/agents", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Object)) : Relay(http, reply);
    }

    // without a public agent address the code is still minted; the app says so instead of showing a command
    private static async Task<IResult> Enroll(
        ConnectorEnrollmentRequest request, HttpContext http, ConnectorRelay relay, ConnectorOptions options, CancellationToken ct)
    {
        var subject = relay.SubjectOf(http);
        var reply = await relay.Client.PostAsync("v1/agents/enrollment", new ConnectorCall
        {
            Subject = subject,
            Body = new WireEnrollment(subject, request.Name),
        }, ct);
        if (!reply.IsSuccess) return Relay(http, reply);

        var code = reply.Text("code") ?? string.Empty;
        var expiresAt = reply.Object["expires_at"]?.GetValue<DateTimeOffset>() ?? DateTimeOffset.UtcNow;
        var url = string.IsNullOrWhiteSpace(options.AgentPublicUrl) ? null : options.AgentPublicUrl;
        return Results.Ok(new ConnectorEnrollmentDto(code, expiresAt, url, url is null ? null : ComposeCommand(url, code, request.Name)));
    }

    // beside deploy/connectors/household-agent.yml; the name is quoted for the shell
    internal static string ComposeCommand(string url, string code, string name) =>
        $"CONNECTOR_URL={url} ENROLLMENT_CODE={code} AGENT_NAME='{name.Replace("'", "'\\''", StringComparison.Ordinal)}' docker compose -f household-agent.yml up -d";

    private static async Task<IResult> RevokeAgent(string agentId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.DeleteAsync($"v1/agents/{agentId}", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.NoContent() : Relay(http, reply);
    }

    private static async Task<IResult> AgentProfiles(string agentId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync($"v1/agents/{agentId}/profiles", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        return reply.IsSuccess ? Results.Json(ConnectorJson.ToCamel(reply.Json)) : Relay(http, reply);
    }

    private static Task<ConnectorSession?> OwnedAsync(AppDbContext db, Guid userId, string provider, string sessionId) =>
        db.ConnectorSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId && s.Provider == provider);

    /// <summary>One row per connection: the session that answered the login replaces whatever the connection had.</summary>
    internal static async Task<ConnectorSession> BindAsync(
        AppDbContext db, Guid userId, string provider, string connectionId, JsonObject view, TimeProvider time, CancellationToken ct)
    {
        var sessionId = view.Text(SessionIdField) ?? throw new InvalidOperationException("a session view without a session id");
        var now = time.GetUtcNow();

        var stale = await db.ConnectorSessions
            .Where(s => s.UserId == userId && s.Provider == provider && s.ConnectionId == connectionId && s.Id != sessionId)
            .ToListAsync(ct);
        db.ConnectorSessions.RemoveRange(stale);

        var row = await db.ConnectorSessions.FindAsync([sessionId], ct);
        if (row is null)
        {
            row = new ConnectorSession
            {
                Id = sessionId,
                UserId = userId,
                Provider = provider,
                ConnectionId = connectionId,
                State = view.Text(StateField) ?? "unknown",
                Label = view.Text(LabelField),
                CreatedAt = now,
                LastSeenAt = now,
            };
            db.ConnectorSessions.Add(row);
        }
        else
        {
            row.State = view.Text(StateField) ?? row.State;
            row.Label = view.Text(LabelField) ?? row.Label;
            row.LastSeenAt = now;
        }

        await db.SaveChangesAsync(ct);
        return row;
    }

    // household-agent and server-custody bundles hold no secret (§5.5, §15), so the relay keeps them for the scheduler.
    // a client-custody bundle carries the person's own secret and passes through memory only
    internal static bool KeepsBundle(JsonObject? manifest) =>
        manifest?.Text("secret_custody") is "agent" or "server";

    /// <summary>The single delivery of a bundle, kept when — and only when — the provider's custody says the agent holds the secret.</summary>
    private static async Task KeepAsync(ConnectorRelay relay, string provider, ConnectorSession row, JsonObject view, CancellationToken ct)
    {
        if (view.Text("bundle") is not { Length: > 0 } bundle) return;
        if (!KeepsBundle(await relay.Catalogue.ProviderAsync(relay.Client, provider, ct))) return;
        row.KeptBundle = bundle;
        row.LastScheduleError = null;
        await relay.Db.SaveChangesAsync(ct);
    }

    /// <summary>Records the state the connector reported; a session the connector no longer keeps is forgotten here too.</summary>
    internal static async Task TouchAsync(AppDbContext db, ConnectorSession row, JsonObject view, TimeProvider time, CancellationToken ct)
    {
        var state = view.Text(StateField);
        if (state is not null && GoneSessionStates.Contains(state))
        {
            db.ConnectorSessions.Remove(row);
        }
        else
        {
            row.State = state ?? row.State;
            row.Label = view.Text(LabelField) ?? row.Label;
            row.LastSeenAt = time.GetUtcNow();
        }
        await db.SaveChangesAsync(ct);
    }

    private static async Task<IResult> RelayOrForgetAsync(HttpContext http, AppDbContext db, ConnectorSession row, ConnectorReply reply, CancellationToken ct)
    {
        if (reply.Error?.Code is "unsupported_resource" or "session_expired")
        {
            db.ConnectorSessions.Remove(row);
            await db.SaveChangesAsync(ct);
        }
        return Relay(http, reply);
    }

    private static void FollowWhileRunning(ConnectorEventBridge bridge, Guid userId, string subject, string provider, string sessionId, JsonObject view)
    {
        var state = view.Text(StateField);
        if (state is null || SettledSessionStates.Contains(state)) return;
        bridge.WatchSession(userId, subject, provider, sessionId);
    }

    /// <summary><c>X-Device-Class</c> when the client says; else the platform it already declares on every request.</summary>
    internal static string DeviceClassOf(HttpContext http)
    {
        var declared = http.Request.Headers[ConnectorClient.DeviceClassHeader].ToString().Trim().ToLowerInvariant();
        if (declared is "native" or "web") return declared;
        var platform = http.Request.Headers["X-Munni-Platform"].ToString().Trim().ToLowerInvariant();
        return platform == "web" ? "web" : "native";
    }

    // a pooled-class party's agent_unavailable carries the fleet's key (nothing the person can start); a party that needs
    // the person's own machine keeps the connector's key ("start your agent")
    internal static ConnectorError ForParty(ConnectorError error, JsonObject? manifest)
    {
        if (!string.Equals(error.Code, "agent_unavailable", StringComparison.Ordinal)) return error;
        var cls = manifest?["agent"]?["class"]?.GetValue<string>();
        return string.Equals(cls, "byo", StringComparison.Ordinal)
            ? error
            : error with { MessageKey = "connect.error.fleet_unavailable" };
    }

    internal static IResult Relay(HttpContext http, ConnectorReply reply)
    {
        var error = reply.Error ?? new ConnectorError("internal", true, "retry", "connect.error.internal", null, null);
        return Envelope(http, (int)reply.Status, error);
    }

    internal static IResult Envelope(HttpContext http, int status, ConnectorError error)
    {
        if (error.RetryAfterSeconds is { } retry)
        {
            http.Response.Headers.RetryAfter = retry.ToString(CultureInfo.InvariantCulture);
        }
        return Results.Json(new
        {
            error = new
            {
                code = error.Code,
                retriable = error.Retriable,
                userAction = error.UserAction,
                messageKey = error.MessageKey,
                detailId = error.DetailId,
                retryAfterSeconds = error.RetryAfterSeconds,
            },
        }, statusCode: status);
    }

    /// <summary>Somebody else's session, or none: one answer for both, so an id learned elsewhere tells its holder nothing.</summary>
    private static IResult UnknownSession(HttpContext http) => Envelope(
        http, StatusCodes.Status404NotFound,
        new ConnectorError("unsupported_resource", false, "none", "connect.error.unsupported_resource", null, null));

    private static IResult BudgetExceeded(HttpContext http, int retryAfter) => Envelope(
        http, StatusCodes.Status429TooManyRequests,
        new ConnectorError("rate_limited", true, "wait", "connect.error.rate_limited", null, retryAfter));
}

// an unreachable control plane becomes the envelope the app reads everywhere on this group, never a bare 500
internal sealed class ConnectorReplyFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        try
        {
            return await next(context);
        }
        catch (ConnectorReplyException ex)
        {
            return ConnectorRelayEndpoints.Relay(http, ex.Reply);
        }
        catch (HttpRequestException ex)
        {
            Log(http, ex);
            return Unavailable(http);
        }
        catch (TaskCanceledException ex) when (!http.RequestAborted.IsCancellationRequested)
        {
            Log(http, ex);
            return Unavailable(http);
        }
    }

    private static void Log(HttpContext http, Exception ex)
    {
        var logger = http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Munni.Api.Connectors.Relay");
        if (!logger.IsEnabled(LogLevel.Warning)) return;
        logger.LogWarning(ex, "the connector control plane did not answer {Method} {Path}", LogSafe.Line(http.Request.Method), LogSafe.Line(http.Request.Path.Value));
    }

    private static IResult Unavailable(HttpContext http) => ConnectorRelayEndpoints.Envelope(
        http, StatusCodes.Status503ServiceUnavailable,
        new ConnectorError("provider_unavailable", true, "retry", "connect.error.provider_unavailable", null, null));
}
