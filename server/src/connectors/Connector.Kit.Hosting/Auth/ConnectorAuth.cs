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

/// only the consuming server may call: production has no published port plus an audience-checked machine token
/// dev uses one shared header; unreachable when deployed, as production refuses to start without authority and audience
public sealed class ConnectorAuth(IOptions<ConnectorOptions> options, ILogger<ConnectorAuth> logger)
{
    public const string DevelopmentHeader = "X-Connector-Key";

    /// <summary>The claim OAuth hands granted scopes in: one string, space separated.</summary>
    public const string ScopeClaim = "scope";

    private readonly ConnectorOptions _options = options.Value;

    /// every rejection is the same InvalidRequest with no detail: a caller learns whether the service exists, nothing else
    public async ValueTask<bool> AuthenticateAsync(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        return _options.IsProduction
            ? await ProductionAsync(http)
            : Development(http);
    }

    /// dev has no tokens, so the shared secret already admitted the caller as operator
    public bool IsOperator(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        return !_options.IsProduction || HasScope(http.User, _options.Auth.AdminScope);
    }

    /// scopes arrive as one space-separated claim, or as several claims when a handler split them; both are read
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

/// 403 not 401: the caller is known and lacks a grant, which is the operator's to give
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
