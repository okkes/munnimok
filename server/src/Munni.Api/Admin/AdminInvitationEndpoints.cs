using System.Globalization;
using System.Net;
using System.Text.Json;
using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>POST /admin/invitations: the person's address travels in the BODY — the admin group's route guard admits id-shaped segments only, never an '@'</summary>
public sealed record CreateInvitationRequest(string Email);

/// <summary>one invitation as the portal lists it: Logto's token row plus the magic link the operator copies</summary>
public sealed record AdminInvitationDto(string Id, string Email, string Status, DateTimeOffset? CreatedAt, DateTimeOffset? ExpiresAt, string Link);

/// <summary>
/// user 2026-10-07: invitation-only sign-up. An invitation is a Logto
/// one-time token (Management API /api/one-time-tokens, Logto 1.43) bound
/// to an e-mail: the operator mints it here, copies the magic link the api
/// builds (there is no mailer — the operator sends it), and the web app's
/// /invite screen hands token + e-mail to Logto's one-time-token sign-in.
/// Nothing rests on this side: Logto is the one register and the listing
/// reads it live. What the portal can only show is a 503 that names itself.
/// </summary>
public static class AdminInvitationEndpoints
{
    /// <summary>Auth:InviteOnly — the web app closes its own sign-up door when the handshake says so (/health capabilities)</summary>
    public const string InviteOnlyKey = "Auth:InviteOnly";

    /// <summary>no machine app (Logto:M2mAppId/Secret unset: this environment has not run its Bootstrap), or Logto out of reach</summary>
    public const string ErrorUnavailable = "logto-unavailable";

    /// <summary>Logto refused the machine app: a wrong credential, or the app lacks the Management API role the infra grants on Bootstrap</summary>
    public const string ErrorRefused = "logto-refused";

    /// <summary>Logto answered, but nothing the portal can act on; the body carries Logto's status</summary>
    public const string ErrorFailed = "logto-error";

    /// <summary>two days: long enough for an e-mail opened tomorrow, short enough that a leaked link is not a standing door</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(2);

    private const string TokensPath = "/api/one-time-tokens";
    private const string StatusActive = "active";
    private const string StatusExpired = "expired";
    private const string StatusRevoked = "revoked";

    public static void Map(RouteGroupBuilder admin)
    {
        admin.MapGet("/invitations", List);
        admin.MapPost("/invitations", Create).WithValidation<CreateInvitationRequest>();
        admin.MapDelete("/invitations/{id}", Revoke);
    }

    /// <summary>the open invitations as Logto holds them, each with its link, plus whether sign-up is invitation-only here</summary>
    private static Task<IResult> List(HttpContext http, ILogtoManagement logto, IConfiguration config, TimeProvider time) =>
        WithLogtoAsync(http, logto, async (session, ct) =>
        {
            // Logto pages its listings (20 by default); a hundred open invitations is more than any wave of ours
            using var request = session.Request(HttpMethod.Get, $"{TokensPath}?status={StatusActive}&page_size=100");
            using var response = await session.Http.SendAsync(request, ct);
            if (Refusal(http, logto, response) is { } refused) return refused;

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var webUrl = WebUrl(config);
            var now = time.GetUtcNow();
            var invitations = json.RootElement.ValueKind == JsonValueKind.Array
                ? json.RootElement.EnumerateArray().Select(token => Read(token, webUrl, now)).ToList()
                : [];
            return Results.Ok(new { inviteOnly = InviteOnly(config), invitations });
        });

    /// <summary>mints the token for the address (lower-cased: the link's e-mail has to match what the person types) and hands back the link</summary>
    private static Task<IResult> Create(CreateInvitationRequest body, HttpContext http, ILogtoManagement logto, IConfiguration config, TimeProvider time) =>
        WithLogtoAsync(http, logto, async (session, ct) =>
        {
            var email = body.Email.Trim().ToLowerInvariant();
            using var request = session.Request(HttpMethod.Post, TokensPath, new { email, expiresIn = (int)Lifetime.TotalSeconds });
            using var response = await session.Http.SendAsync(request, ct);
            if (Refusal(http, logto, response) is { } refused) return refused;

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var invitation = Read(json.RootElement, WebUrl(config), time.GetUtcNow());
            return Results.Created($"/admin/invitations/{invitation.Id}", new { invitation.Id, invitation.Email, invitation.ExpiresAt, invitation.Link });
        });

    /// <summary>revokes rather than deletes: Logto keeps the row, so a link that stops working is explainable later</summary>
    private static Task<IResult> Revoke(string id, HttpContext http, ILogtoManagement logto) =>
        WithLogtoAsync(http, logto, async (session, ct) =>
        {
            using var request = session.Request(HttpMethod.Put, $"{TokensPath}/{Uri.EscapeDataString(id)}/status", new { status = StatusRevoked });
            using var response = await session.Http.SendAsync(request, ct);
            if (response.StatusCode == HttpStatusCode.NotFound) return Results.NotFound();
            if (Refusal(http, logto, response) is { } refused) return refused;
            return Results.Ok(new { revoked = id });
        });

    /// <summary>
    /// One Management API call behind the shared session. No machine app →
    /// 503 logto-unavailable; a mint Logto refuses → 503 logto-refused; Logto
    /// out of reach → 503 logto-unavailable. The portal shows the name and
    /// the operator knows where to look (the environment's Bootstrap).
    /// </summary>
    private static async Task<IResult> WithLogtoAsync(HttpContext http, ILogtoManagement logto, Func<LogtoSession, CancellationToken, Task<IResult>> call)
    {
        var ct = http.RequestAborted;
        try
        {
            var session = await logto.ConnectAsync(ct);
            return session is null ? Unavailable(ErrorUnavailable) : await call(session, ct);
        }
        catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return Unavailable(ErrorRefused);
        }
        catch (Exception ex) when (ex is (HttpRequestException or TaskCanceledException) && !ct.IsCancellationRequested)
        {
            LoggerOf(http).LogWarning(ex, "invitations: Logto did not answer {Method} {Path}", http.Request.Method, http.Request.Path);
            return Unavailable(ErrorUnavailable);
        }
    }

    /// <summary>
    /// The Management API answers nobody can act on from the portal, named:
    /// 401/403 = the machine app opened the token endpoint but not the API —
    /// it lacks the Management API role the infra grants on Bootstrap (a
    /// 401's token is forgotten first, so a merely stale one is minted afresh
    /// on the next call); any other failure = 502 carrying Logto's status.
    /// Null means the answer is usable.
    /// </summary>
    private static IResult? Refusal(HttpContext http, ILogtoManagement logto, HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return null;
        if (response.StatusCode == HttpStatusCode.Unauthorized) logto.Forget();
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) return Unavailable(ErrorRefused);

        var logger = LoggerOf(http);
        if (logger.IsEnabled(LogLevel.Warning))
            logger.LogWarning("invitations: Logto answered {Status} to {Method} {Path}", (int)response.StatusCode, response.RequestMessage?.Method, response.RequestMessage?.RequestUri?.AbsolutePath);
        return Results.Json(new { error = ErrorFailed, status = (int)response.StatusCode }, statusCode: StatusCodes.Status502BadGateway);
    }

    private static AdminInvitationDto Read(JsonElement token, string webUrl, DateTimeOffset now)
    {
        var email = Text(token, "email") ?? "";
        var expiresAt = Instant(token, "expiresAt");
        var status = Text(token, "status") ?? StatusActive;
        // Logto flips an active token to `expired` only when someone tries it: past its end it is dead already,
        // and the portal must say so rather than offer a link that fails
        if (status == StatusActive && expiresAt is { } end && end <= now) status = StatusExpired;
        return new AdminInvitationDto(Text(token, "id") ?? "", email, status, Instant(token, "createdAt"), expiresAt, Link(webUrl, Text(token, "token") ?? "", email));
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>Logto stamps epoch milliseconds; a string is read as ISO 8601 in case a release changes that</summary>
    private static DateTimeOffset? Instant(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var milliseconds)) return DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
        if (value.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)) return parsed;
        return null;
    }

    /// <summary>the magic link the person follows: the web app's /invite screen hands token + e-mail to Logto's one-time-token sign-in</summary>
    public static string Link(string webUrl, string token, string email) =>
        $"{webUrl}/invite?token={Uri.EscapeDataString(token)}&email={Uri.EscapeDataString(email)}";

    /// <summary>
    /// Where the web app lives — the api never had to know until the link.
    /// Web:Url when the environment says so; otherwise the first CORS origin,
    /// which the infra renders as the web app (render.mjs corsOrigins: web,
    /// admin, lab, …); as the last resort the audience's origin, which is the
    /// api's own host and only right where the two share one.
    /// </summary>
    public static string WebUrl(IConfiguration config)
    {
        var explicitUrl = config["Web:Url"];
        if (!string.IsNullOrWhiteSpace(explicitUrl)) return explicitUrl.TrimEnd('/');
        var firstOrigin = config["Cors:Origins:0"];
        if (!string.IsNullOrWhiteSpace(firstOrigin)) return firstOrigin.TrimEnd('/');
        return Uri.TryCreate(config["Auth:Audience"], UriKind.Absolute, out var audience) ? audience.GetLeftPart(UriPartial.Authority) : "";
    }

    public static bool InviteOnly(IConfiguration config) => config.GetValue<bool>(InviteOnlyKey);

    private static IResult Unavailable(string error) =>
        Results.Json(new { error }, statusCode: StatusCodes.Status503ServiceUnavailable);

    private static ILogger LoggerOf(HttpContext http) =>
        http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AdminInvitationEndpoints));
}
