using Microsoft.AspNetCore.Authentication.JwtBearer;

namespace Munni.Api.Auth;

// a bearer the api could not validate because the identity provider was unreachable is not a bad token:
// a 401 logged every app out during a router swap, so answer 503
public static class AuthOutage
{
    public const string ErrorCode = "identity-provider-unreachable";

    /// <summary>IdentityModel's code for "unable to obtain configuration from the metadata address".</summary>
    private const string MetadataUnavailable = "IDX20803";

    public static bool IsProviderUnreachable(Exception? exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            if (ex is HttpRequestException or System.Net.Sockets.SocketException or TaskCanceledException or TimeoutException) return true;
            if (ex.Message.Contains(MetadataUnavailable, StringComparison.Ordinal)) return true;
        }
        return false;
    }

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
