using System.Globalization;
using System.Net;
using System.Text.Json;
using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>POST /admin/invitations: the person's address travels in the BODY — the admin group's route guard admits id-shaped segments only, never an '@'</summary>
public sealed record CreateInvitationRequest(string Email);

public sealed record AdminInvitationDto(string Id, string Email, string Status, DateTimeOffset? CreatedAt, DateTimeOffset? ExpiresAt, string Link);

// an invitation is a Logto one-time token (Management API, Logto 1.43) bound to an e-mail;
// no mailer, the operator copies the link; nothing is stored here, Logto is the one register
public static class AdminInvitationEndpoints
{
    /// <summary>Auth:InviteOnly — the web app closes its own sign-up door when the handshake says so (/health capabilities)</summary>
    public const string InviteOnlyKey = "Auth:InviteOnly";

    /// <summary>no machine app (Logto:M2mAppId/Secret unset: this environment has not run its Bootstrap), or Logto out of reach</summary>
    public const string ErrorUnavailable = "logto-unavailable";

    /// <summary>Logto refused the machine app: a wrong credential, or the app lacks the Management API role the infra grants on Bootstrap</summary>
    public const string ErrorRefused = "logto-refused";

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

    /// <summary>The e-mail is lower-cased: the link's e-mail has to match what the person types.</summary>
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

    /// <summary>No machine app or Logto out of reach: 503 logto-unavailable; a mint Logto refuses: 503 logto-refused.</summary>
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
            LoggerOf(http).LogWarning(ex, "invitations: Logto did not answer {Method} {Path}", LogSafe.Line(http.Request.Method), LogSafe.Line(http.Request.Path.Value));
            return Unavailable(ErrorUnavailable);
        }
    }

    // 401/403: the machine app lacks the Management API role the infra grants on Bootstrap
    // (a 401 also forgets the cached token); any other failure: 502 with Logto's status
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

    public static string Link(string webUrl, string token, string email) =>
        $"{webUrl}/invite?token={Uri.EscapeDataString(token)}&email={Uri.EscapeDataString(email)}";

    // Web:Url, else the first CORS origin (the infra renders it as the web app), else the audience's origin,
    // which is the api's own host and right only where the two share one
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
