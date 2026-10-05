using Microsoft.AspNetCore.Authentication.JwtBearer;

namespace Munni.Api.Auth;

/// <summary>
/// A bearer the api could not VALIDATE because the identity provider was
/// out of reach (its discovery document or signing keys did not load) is
/// not a bad token. Answering 401 made every app log its user out during
/// the 2026-10-05 router swap — the refresh token was fine, the api just
/// could not ask Logto. A 503 with a name tells the app to wait instead.
/// </summary>
public static class AuthOutage
{
    public const string ErrorCode = "identity-provider-unreachable";

    /// <summary>IdentityModel's code for "unable to obtain configuration from the metadata address".</summary>
    private const string MetadataUnavailable = "IDX20803";

    /// <summary>The exception the bearer handler raised says the provider could not be reached, not that the token was wrong.</summary>
    public static bool IsProviderUnreachable(Exception? exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            if (ex is HttpRequestException or System.Net.Sockets.SocketException or TaskCanceledException or TimeoutException) return true;
            if (ex.Message.Contains(MetadataUnavailable, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    /// <summary>The bearer events: a challenge caused by an unreachable provider answers 503, every other challenge stays the handler's 401.</summary>
    public static JwtBearerEvents Events() => new()
    {
        OnChallenge = async context =>
        {
            if (!IsProviderUnreachable(context.AuthenticateFailure)) return;
            context.HandleResponse();
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.RetryAfter = "30";
            await context.Response.WriteAsJsonAsync(new { error = ErrorCode });
        },
    };
}
