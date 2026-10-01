using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Auth;

/// <summary>
/// Who may talk to the control plane at all.
///
/// Nobody but the consuming server, and the design says why: clients never
/// hold a connector hostname, never a connector credential, never a CORS
/// grant. In production the control plane publishes no port - it is reachable
/// only on the networks the platform renders it into - and every call on top
/// of that carries an audience-checked machine token from the environment's
/// identity provider, minted for the consuming API by client credentials. The
/// network is what keeps strangers out; the token is what tells the consumer
/// apart from anything else that shares a network with it, and its scopes are
/// what separate a consumer from an operator.
///
/// Development mode collapses that to one shared header so a local run needs
/// no identity provider. It is unreachable in a deployed configuration: the
/// platform refuses to start in production without an authority and an
/// audience.
/// </summary>
public sealed class ConnectorAuth(IOptions<ConnectorOptions> options, ILogger<ConnectorAuth> logger)
{
    public const string DevelopmentHeader = "X-Connector-Key";

    /// <summary>The claim OAuth hands granted scopes in: one string, space separated.</summary>
    public const string ScopeClaim = "scope";

    private readonly ConnectorOptions _options = options.Value;

    /// <summary>
    /// Every rejection is the same <see cref="ErrorCode.InvalidRequest"/> with
    /// no detail on the wire: an unauthenticated caller learns whether the
    /// service exists and nothing else.
    /// </summary>
    public async ValueTask<bool> AuthenticateAsync(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        return _options.IsProduction
            ? await ProductionAsync(http)
            : Development(http);
    }

    /// <summary>
    /// Whether an authenticated caller may use the operator routes: in
    /// production its token must carry <see cref="ConnectorAuthOptions.AdminScope"/>;
    /// in development there are no tokens and the shared secret already
    /// admitted it.
    /// </summary>
    public bool IsOperator(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        return !_options.IsProduction || HasScope(http.User, _options.Auth.AdminScope);
    }

    /// <summary>
    /// Whether a principal was granted a scope. Scopes arrive as one
    /// space-separated <c>scope</c> claim, or as several claims of that name
    /// when a token handler split them; both are read.
    /// </summary>
    public static bool HasScope(ClaimsPrincipal? principal, string scope)
    {
        if (principal is null || string.IsNullOrWhiteSpace(scope)) return false;

        return principal.FindAll(ScopeClaim)
            .SelectMany(claim => claim.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .Any(granted => string.Equals(granted, scope, StringComparison.Ordinal));
    }

    private bool Development(HttpContext http)
    {
        var expected = _options.Auth.SharedSecret;
        if (string.IsNullOrEmpty(expected)) return true;   // no secret configured: a bare local run

        var presented = http.Request.Headers[DevelopmentHeader].ToString();
        return FixedTimeEquals(presented, expected);
    }

    private async ValueTask<bool> ProductionAsync(HttpContext http)
    {
        var result = await http.AuthenticateAsync(JwtBearerDefaults.AuthenticationScheme);
        if (!result.Succeeded || result.Principal is null)
        {
            logger.LogWarning("rejected a call with no valid bearer token");
            return false;
        }

        if (_options.Auth.RequiredScope is { Length: > 0 } scope && !HasScope(result.Principal, scope))
        {
            logger.LogWarning("rejected a call whose token was not granted the {Scope} scope", scope);
            return false;
        }

        http.User = result.Principal;
        return true;
    }

    /// <summary>Constant time, because a shared secret compared with <c>==</c> leaks itself one byte at a time.</summary>
    internal static bool FixedTimeEquals(string? presented, string expected)
    {
        if (string.IsNullOrEmpty(presented)) return false;
        return CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(presented)),
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    }
}

/// <summary>Applied to the whole <c>/v1</c> group, so no route can be added unprotected by omission.</summary>
public sealed class ConnectorAuthFilter(ConnectorAuth auth) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        if (!await auth.AuthenticateAsync(context.HttpContext))
        {
            return ConnectorResults.Error(new ConnectorHttpException(
                StatusCodes.Status401Unauthorized,
                ConnectorException.InvalidRequest("unauthorized")));
        }

        return await next(context);
    }
}

/// <summary>
/// Applied to the <c>/v1/admin</c> group, inside the filter above: a caller
/// that authenticated but was not granted the admin scope is answered 403.
/// The status differs from the 401 on purpose - this caller is known, and
/// what it lacks is a grant, which is the operator's to give.
/// </summary>
public sealed class AdminScopeFilter(ConnectorAuth auth) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        if (!auth.IsOperator(context.HttpContext))
        {
            return ConnectorResults.Error(new ConnectorHttpException(
                StatusCodes.Status403Forbidden,
                ConnectorException.InvalidRequest("this route needs the admin scope")));
        }

        return await next(context);
    }
}
