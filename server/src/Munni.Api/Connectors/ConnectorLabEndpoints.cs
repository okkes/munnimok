using System.Text.Json.Nodes;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

/// <summary>The kill switch: <c>healthy</c>, <c>degraded</c>, <c>paused</c> or <c>retired</c>, with a copy key the app shows.</summary>
public sealed record ConnectorProviderStatusRequest(string State, string? ReasonKey = null);

/// <summary>A user's connector session as the operator's diagnosis lists it.</summary>
public sealed record AdminConnectorSessionDto(string SessionId, string Provider, string ConnectionId, string State, DateTimeOffset LastSeenAt);

/// <summary>Who the lab is to the control plane: the operator's own lab subject, with the operator's name beside it.</summary>
public sealed record LabMeDto(string Subject, string? Name, string? Email);

/// <summary>
/// The connector lab's side of the relay (#441, docs/connectors/lab.md):
/// the control plane as the operator works it — the status line, the
/// catalogue with every manifest, the kill switch per party, the fleet,
/// the hosted private slots, the canaries, an aggregator's inventory — all
/// under the <c>admin</c> scope, relayed to the control plane's own routes
/// with the api's machine token. The lab's own runs belong to a LAB
/// SUBJECT per operator (<see cref="SubjectMinter.ForLab"/>): never the
/// person's app subject, so nothing the lab does shows in the app or lands
/// in a space. The cockpit reads the same status under <c>/control</c>,
/// read-only, exactly as it reads consents.
/// </summary>
public static partial class ConnectorLabEndpoints
{
    /// <summary>The control plane's own vocabulary (<c>ProviderState</c>): healthy is the working state, not "active".</summary>
    private static readonly string[] States = ["healthy", "degraded", "paused", "retired"];

    public static void MapConnectorLab(this IEndpointRouteBuilder app)
    {
        var lab = app.MapGroup("/lab")
            .RequireAuthorization(AdminScope.Policy)
            .WithSafeRouteParams()
            .AddEndpointFilter<ConnectorReplyFilter>();

        lab.MapGet("/me", Me);
        lab.MapGet("/status", Status);
        lab.MapGet("/providers", Catalogue);
        lab.MapGet("/providers/{providerId}", Provider);
        lab.MapPost("/providers/{providerId}/status", SetProviderStatus).WithValidation<ConnectorProviderStatusRequest>();
        lab.MapGet("/providers/{providerId}/remote-consents", RemoteConsents);
        lab.MapDelete("/providers/{providerId}/remote-consents/{consentId}", RevokeRemote);
        lab.MapGet("/agents", Fleet);
        lab.MapDelete("/agents/{agentId}", RevokeAny);
        // a browser enrolled for the lab's own subject: the machine the test bench and the recorder run on when picked
        lab.MapPost("/agents/enrollment", EnrolForLab).WithValidation<ConnectorEnrollmentRequest>();
        // hosted private agents (#420 A2): the slots and the requests, the decisions, taking a slot back
        lab.MapGet("/private-agents", PrivateAgents);
        lab.MapPost("/private-agents/requests/{requestId}/approve", ApprovePrivateAgent);
        lab.MapPost("/private-agents/requests/{requestId}/deny", DenyPrivateAgent);
        lab.MapPost("/private-agents/{agentId}/release", ReleasePrivateAgent);
        lab.MapGet("/canaries", Canaries);
        // L1: the job history with who ran what, one job, a shared picture, the health report, a canary run now
        lab.MapGet("/jobs", Jobs);
        lab.MapGet("/jobs/{jobId}", Job);
        lab.MapGet("/jobs/{jobId}/artifacts/screenshot", JobScreenshot);
        lab.MapGet("/jobs/{jobId}/trace", JobTrace);
        lab.MapGet("/jobs/{jobId}/trace/digest.md", JobTraceDigest);
        lab.MapDelete("/jobs/{jobId}/trace", DeleteJobTrace);
        lab.MapGet("/jobs/{jobId}/scaffold", JobScaffold);
        lab.MapGet("/health", Health);
        lab.MapPost("/canaries/{providerId}/run", RunCanary);
        lab.MapGet("/users/{sub}/sessions", UserSessions);
        // L2: the test bench — the operator's own sessions, sign-ins with their challenges and the live view, fetches, canaries
        Munni.Api.Lab.LabBenchEndpoints.Map(lab);

        // the cockpit's read-only view of the designated environment (§15.6): the
        // parties with their quota, and an aggregator's inventory of consents —
        // never a revocation, which stays in the environment's own lab
        var control = app.MapGroup("/control/connectors")
            .RequireAuthorization(AdminScope.Policy)
            .WithSafeRouteParams()
            .AddEndpointFilter<ConnectorReplyFilter>();

        control.MapGet("/status", Status);
        control.MapGet("/providers/{providerId}/remote-consents", RemoteConsents);
    }

    /// <summary>The operator's lab subject and name — what the control plane knows the lab as, and who sits behind it.</summary>
    private static async Task<IResult> Me(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var user = await relay.Db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == http.GetUserId(), ct);
        return Results.Ok(new LabMeDto(relay.LabSubjectOf(http), user?.DisplayName, user?.Email));
    }

    /// <summary>Providers with their health, agents online, the queue — the control plane's own status line.</summary>
    private static async Task<IResult> Status(ConnectorClient client, ConnectorEventBridge bridge, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/status", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var status = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;
        status["relay"] = new JsonObject { ["openStreams"] = bridge.Open };
        return Results.Json(status);
    }

    /// <summary>Every manifest with its status beside it — what the lab's Providers screen and the test bench read.</summary>
    private static async Task<IResult> Catalogue(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/providers", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> Provider(string providerId, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/providers/{providerId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>
    /// The kill switch. Retiring a party expires every session of it at the
    /// control plane; pausing stops new work and the catalogue says so;
    /// healthy is the way back (degraded keeps work flowing with a warning). The
    /// operator and the reason go to the server log: munni's activity log
    /// is the members' own per space, and an operator's act belongs where
    /// the operator reads.
    /// </summary>
    private static async Task<IResult> SetProviderStatus(
        string providerId,
        ConnectorProviderStatusRequest request,
        HttpContext http,
        ConnectorClient client,
        ILogger<ConnectorClient> logger,
        CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/providers/{providerId}/status", new ConnectorCall
        {
            Body = new WireProviderStatus(request.State, request.ReasonKey),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} set connector provider {Provider} to {State} ({Reason})",
                OperatorOf(http), providerId, request.State, request.ReasonKey ?? "-");
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static string OperatorOf(HttpContext http) => http.User.FindFirst("sub")?.Value ?? "-";

    private static async Task<IResult> Fleet(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/admin/agents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> RevokeAny(string agentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.DeleteAsync($"v1/admin/agents/{agentId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} revoked connector agent {Agent}", OperatorOf(http), agentId);
        }
        return Results.NoContent();
    }

    /// <summary>
    /// A one-time enrollment code under the LAB subject, with the line that
    /// starts a household agent against this environment — the same door the
    /// app offers a person, for the operator's own test machine. The agent
    /// then serves the lab's runs and nobody else's.
    /// </summary>
    private static async Task<IResult> EnrolForLab(
        ConnectorEnrollmentRequest request, HttpContext http, ConnectorRelay relay, ConnectorOptions options, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var subject = relay.LabSubjectOf(http);
        var reply = await relay.Client.PostAsync("v1/agents/enrollment", new ConnectorCall
        {
            Subject = subject,
            Body = new WireEnrollment(subject, request.Name),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        var code = reply.Text("code") ?? string.Empty;
        var expiresAt = reply.Object["expires_at"]?.GetValue<DateTimeOffset>() ?? DateTimeOffset.UtcNow;
        var url = string.IsNullOrWhiteSpace(options.AgentPublicUrl) ? null : options.AgentPublicUrl;
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} minted a lab agent enrollment named {Name}", OperatorOf(http), request.Name);
        }
        return Results.Ok(new ConnectorEnrollmentDto(code, expiresAt, url, url is null ? null : ConnectorRelayEndpoints.ComposeCommand(url, code, request.Name)));
    }

    /// <summary>
    /// The hosted private slots and the requests for them (#420 A2), with WHO
    /// each pseudonymous subject is. The control plane knows subjects and
    /// nothing else; an operator deciding a request needs a name. The relay
    /// mints every user's subject the way it mints the caller's, so the map
    /// is computed here per call and stored nowhere.
    /// </summary>
    private static async Task<IResult> PrivateAgents(ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync("v1/admin/private-agents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var view = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;
        await NameSubjectsAsync(relay, (view["requests"] as JsonArray ?? []).Concat(view["slots"] as JsonArray ?? []), ct);
        return Results.Json(view);
    }

    /// <summary>
    /// `who` on every row that carries a `subject`: the pseudonym mapped
    /// back to the person's name or e-mail, computed per call and stored
    /// nowhere. The lab's own subject maps to nobody, which is right.
    /// </summary>
    private static async Task NameSubjectsAsync(ConnectorRelay relay, IEnumerable<JsonNode?> rows, CancellationToken ct)
    {
        var users = await relay.Db.Users.Select(u => new { u.Id, u.Email, u.DisplayName }).ToListAsync(ct);
        var who = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var user in users) who[relay.Minter.For(user.Id)] = user.DisplayName ?? user.Email ?? user.Id.ToString();

        foreach (var node in rows)
        {
            if (node is not JsonObject row) continue;
            row["who"] = row["subject"]?.GetValue<string>() is { } subject && who.TryGetValue(subject, out var name) ? name : null;
        }
    }

    /// <summary>
    /// The control plane's job history (#441 L1) with the query passed
    /// through — provider, session, state, kind, trigger, code, since,
    /// before, limit — plus `user=&lt;sub&gt;`, which the relay turns into that
    /// person's subject, and `who` on every row. Never inputs, never
    /// material: the control plane's view has no field for them.
    /// </summary>
    private static async Task<IResult> Jobs(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var query = QueryHelpers.ParseQuery(http.Request.QueryString.Value);
        var forward = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (key, values) in query)
        {
            if (key != "user") forward[key] = values.ToString();
        }

        if (query.TryGetValue("user", out var wanted) && wanted.ToString() is { Length: > 0 } sub)
        {
            var user = await relay.Db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Sub == sub, ct);
            if (user is null) return Results.NotFound();
            forward["subject"] = relay.Minter.For(user.Id);
        }

        var reply = await relay.Client.GetAsync(QueryHelpers.AddQueryString("v1/admin/jobs", forward), new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var view = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;
        await NameSubjectsAsync(relay, view["jobs"] as JsonArray ?? [], ct);
        return Results.Json(view);
    }

    private static async Task<IResult> Job(string jobId, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync($"v1/admin/jobs/{jobId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var view = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;
        await NameSubjectsAsync(relay, [view], ct);
        return Results.Json(view);
    }

    /// <summary>A picture the operator may see, as the control plane serves it: bytes, never cached. The envelope while nothing may be seen.</summary>
    private static async Task<IResult> JobScreenshot(string jobId, HttpContext http, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/admin/jobs/{jobId}/artifacts/screenshot", new ConnectorCall(), ct);
        if (!reply.IsSuccess || reply.Bytes is null) return ConnectorRelayEndpoints.Relay(http, reply);
        http.Response.Headers.CacheControl = "no-store";
        return Results.File(reply.Bytes, reply.ContentType ?? "image/png");
    }

    /// <summary>Per-provider health: the month's runs by outcome, code and trigger, the people affected, the sessions, the canary, the reports.</summary>
    /// <summary>A run's recording (#441 L3): the trace as the agent posted it, camelCased for the browser.</summary>
    private static async Task<IResult> JobTrace(string jobId, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/admin/jobs/{jobId}/trace", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>The recording's digest.md, served as the markdown it is.</summary>
    private static async Task<IResult> JobTraceDigest(string jobId, HttpContext http, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/admin/jobs/{jobId}/trace/digest", new ConnectorCall(), ct);
        if (!reply.IsSuccess || reply.Bytes is null) return ConnectorRelayEndpoints.Relay(http, reply);
        http.Response.Headers.CacheControl = "no-store";
        return Results.File(reply.Bytes, "text/markdown; charset=utf-8");
    }

    /// <summary>
    /// The new-service scaffold (#441 L5): the recording and its digest read from
    /// the control plane, turned into the files an adapter author starts from and
    /// zipped at their repo paths. The names come from the query: the provider id
    /// (kebab), the type name (Pascal), the product (shop, bank, registry) and
    /// the country.
    /// </summary>
    private static async Task<IResult> JobScaffold(string jobId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var q = http.Request.Query;
        var provider = q["provider"].ToString().Trim();
        var name = q["name"].ToString().Trim();
        var product = q["product"].ToString().Trim().ToLowerInvariant();
        var country = q["country"].ToString().Trim().ToUpperInvariant();
        if (country.Length == 0) country = "NL";
        if (!ScaffoldProvider().IsMatch(provider) || !ScaffoldName().IsMatch(name) || !Munni.Api.Lab.LabScaffold.Products.Contains(product) || !ScaffoldCountry().IsMatch(country))
        {
            return Results.BadRequest(new { error = "provider (kebab-case), name (PascalCase), product (shop, bank or registry) and country (ISO-3166 alpha-2) are needed" });
        }

        var trace = await client.GetAsync($"v1/admin/jobs/{jobId}/trace", new ConnectorCall(), ct);
        if (!trace.IsSuccess) throw new ConnectorReplyException(trace);
        var digest = await client.GetAsync($"v1/admin/jobs/{jobId}/trace/digest", new ConnectorCall(), ct);
        var digestText = digest.IsSuccess && digest.Bytes is not null ? System.Text.Encoding.UTF8.GetString(digest.Bytes) : "(no digest)";

        var files = Munni.Api.Lab.LabScaffold.Files(new Munni.Api.Lab.LabScaffoldRequest(provider, name, product, country), trace.Object, digestText);
        var packed = Munni.Api.Lab.LabScaffold.Zip(files);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} scaffolded {Name} ({Provider}, {Product}) from connector job {Job}: {Files} files", OperatorOf(http), name, provider, product, jobId, files.Count);
        }
        http.Response.Headers.CacheControl = "no-store";
        return Results.File(packed, "application/zip", $"{provider}-scaffold.zip");
    }

    [System.Text.RegularExpressions.GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial System.Text.RegularExpressions.Regex ScaffoldProvider();

    [System.Text.RegularExpressions.GeneratedRegex("^[A-Z][A-Za-z0-9]{1,63}$")]
    private static partial System.Text.RegularExpressions.Regex ScaffoldName();

    [System.Text.RegularExpressions.GeneratedRegex("^[A-Z]{2}$")]
    private static partial System.Text.RegularExpressions.Regex ScaffoldCountry();

    private static async Task<IResult> DeleteJobTrace(string jobId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.DeleteAsync($"v1/admin/jobs/{jobId}/trace", new ConnectorCall(), ct);
        if (!reply.IsSuccess) return ConnectorRelayEndpoints.Relay(http, reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} deleted the recording of connector job {Job}", OperatorOf(http), jobId);
        }
        return Results.NoContent();
    }

    private static async Task<IResult> Health(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/admin/health", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> RunCanary(string providerId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/canaries/{providerId}/run", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} ran the canary for connector provider {Provider}", OperatorOf(http), providerId);
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static Task<IResult> ApprovePrivateAgent(string requestId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct) =>
        DecidePrivateAgent(requestId, "approve", http, client, logger, ct);

    private static Task<IResult> DenyPrivateAgent(string requestId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct) =>
        DecidePrivateAgent(requestId, "deny", http, client, logger, ct);

    private static async Task<IResult> DecidePrivateAgent(
        string requestId, string decision, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/private-agents/requests/{requestId}/{decision}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} decided private-agent request {Request}: {Decision}", OperatorOf(http), requestId, decision);
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> ReleasePrivateAgent(string agentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/private-agents/{agentId}/release", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} took hosted agent {Agent} back", OperatorOf(http), agentId);
        }
        return Results.NoContent();
    }

    private static async Task<IResult> Canaries(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/admin/canaries", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>What the operator's account at the party holds (§15): every consent, foreign and legacy ones included, with the environment that made it.</summary>
    private static async Task<IResult> RemoteConsents(string providerId, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/admin/providers/{providerId}/remote-consents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> RevokeRemote(
        string providerId, string consentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.DeleteAsync($"v1/admin/providers/{providerId}/remote-consents/{consentId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} revoked consent {Consent} at connector provider {Provider}", OperatorOf(http), consentId, providerId);
        }
        return Results.NoContent();
    }

    /// <summary>One user's bindings — ids and state, the same rows the diagnosis carries.</summary>
    private static async Task<IResult> UserSessions(string sub, AppDbContext db)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (user is null) return Results.NotFound();
        return Results.Ok(await SessionsOfAsync(db, user.Id));
    }

    internal static Task<List<AdminConnectorSessionDto>> SessionsOfAsync(AppDbContext db, Guid userId) =>
        db.ConnectorSessions
            .Where(s => s.UserId == userId)
            .OrderBy(s => s.CreatedAt)
            .Select(s => new AdminConnectorSessionDto(s.Id, s.Provider, s.ConnectionId, s.State, s.LastSeenAt))
            .ToListAsync();

    internal static bool IsState(string? state) => state is not null && States.Contains(state);
}

internal sealed record WireProviderStatus(string State, string? ReasonKey);
